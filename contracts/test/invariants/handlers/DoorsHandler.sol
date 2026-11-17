// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeBase} from "../../../src/CascadeBase.sol";
import {CascadeVault} from "../../../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../../../src/CascadeFrontDoor.sol";
import {CascadeMath} from "../../../src/libraries/CascadeMath.sol";
import {CascadeMessages} from "../../../src/libraries/CascadeMessages.sol";
import {DIRECT_ORIGIN, GLOBAL_WINDOW, MIN_REDEEM_VALUE} from "../../../src/CascadeConstants.sol";
import {
    CapExceeded,
    FeeTooHigh,
    InvalidParameter,
    NotScheduled,
    NothingToCancel,
    StakeMissing,
    UnknownOrigin,
    VaultInsolvent,
    ZeroAmount
} from "../../../src/CascadeErrors.sol";
import {
    BatchDelivered,
    DepositBounced,
    Deposited,
    PayoutBatchQueued,
    RedeemDeferred,
    RedeemSkipped,
    Redeemed
} from "../../../src/CascadeEvents.sol";
import {BounceReason, PayoutBatch} from "../../../src/CascadeTypes.sol";
import {MockBridge} from "../../mocks/MockBridge.sol";
import {MockTAO} from "../../mocks/MockTAO.sol";
import {Schedule} from "../../governance/Schedule.sol";
import {FrontDoorTracker} from "./FrontDoorTracker.sol";
import {VaultModel} from "./VaultModel.sol";

/// @notice The two-door campaign's handler (Task 37, spec §3.4 and §3.5; I-15 to I-18, I-20, I-21): the launch door
/// on BASE and a second door on chain 10, activated through the real schedule (the owner's 7-day Registry item,
/// Schedule.run, in `addSecondDoor`), never written into storage. Five holders deposit and ask to redeem at either
/// door, deposit and redeem directly and set their redeem origin; the keeper (the handler) closes either door's batch
/// by its id, a stale id or a random minimum, stakes and sends payout chunks to either door; the owner sweeps each
/// door's carried pot, cancels queued payouts, pauses and unpauses either door (the guardian pauses too, and its unpause
/// is refused) and moves the outflow limits within their hard bounds (and past each of them, refused); the chain's
/// removal fee is switched as in the core campaign (setRemoveFee), so every exit runs at every fee.
///
/// I-15 (`_recordBurn`): the handler keeps its own record of each door's burn window and the global one, from the
/// vault's Redeemed events at each delivery (a window opens at the first burn 24 hours or more after the last one
/// opened, as spec §3.4 states it), and after every burning delivery checks the window's burns against the allowance
/// it computes itself: max(bps × the ghost base, the floor), the ghost base being VaultModel's (the booked root stake
/// that has ramped in, replayed from the handler's stakes and removals: _bookStake, _bookRemovals), and the bps and
/// the floor its own record of the outflow limits (from its own setOutflowLimits calls): never the vault's allowance
/// view. Per door against its bps, all doors against the global bps. The record, the ghost ledger and the limits are
/// also compared with the vault's after every step (the model's checks: windowRecordMismatches, ghostLedgerMismatches,
/// limitMismatches).
///
/// I-16 and I-17 (`_recordDelivery`, `_checkGhosts`): the handler keeps each holder's redeem origin from its own calls
/// (setRedeemOrigin, depositDirect) and the vault's Deposited events (a door's first mint for an address of origin 0
/// sets the door's chain), and checks every delivery against it: a door on chain C burns only for origin C (a Redeemed
/// for any other origin, and a RedeemSkipped of a holder of origin C with shares, are violations), mints only for an
/// origin of 0, C or DIRECT_ORIGIN (a Deposited for another chain's, and a ForeignOrigin bounce for one of those, are
/// violations); after every step the vault's origins must be the ghost's (a non-zero origin never changed by a door, a
/// direct deposit leaving DIRECT_ORIGIN, a first mint setting C). I-17: each holder's direct deposits and origin
/// changes are numbered in order; a door on C may burn for a holder that ever deposited directly only when the holder's
/// last origin change after its last direct deposit named C.
///
/// I-20: every exit call on a door (requestRedeem, requestRedeemWithDelivery, cancelRedeem, cancelDeposit, closeBatch,
/// claim, and an incoming payout chunk) that reverts EnforcedPause is recorded (`exitsRefusedWhilePaused`), whichever
/// door is paused; deposit, depositFor and deliver on a paused door must refuse EnforcedPause.
///
/// I-18 and I-21: FrontDoorTracker's ghosts per door (the pot paid in, used, swept) and the closers' gains, for both
/// doors, with the pot carried forward, self-closes and sweepPot in play.
///
/// I-35 and I-4 (the leaver pays, Task 36b): around every close and self-close (a door's burns), every payout chunk
/// sent, every direct exit and every owner's cancel, the handler's own reads just before and after the call
/// (PriceFloorTracker's _markPrice, _checkExitPrice): the price, exactly, never lower and the hole never wider, at every
/// removal fee, with no allowance; and nothing here is an I-4 exception (no loss, swap or fresh read), so the price
/// never falls below the floor at all.
///
/// Expected refusals, each tied to its state (any other, or a predicted one that does not happen, is unexpected):
/// - deposit, depositFor: EnforcedPause on a paused door; else BelowMinDeposit, CapExceeded, BatchValueFull,
///   BatchFull at their limits (never reached); deliver (the keeper's, on a paused door only): EnforcedPause;
/// - requestRedeem(WithDelivery), selfClose's request: InsufficientFee for a first request that closes a full list on a
///   pot short of the lane's fee;
/// - cancelDeposit: CancelTooSoon(its last deposit's time + 5 minutes) within five minutes of the actor's last deposit
///   or depositFor for it at that door, only while the door is unpaused (R11, FrontDoorTracker's model, the exact revert
///   data; R12: a paused door waives the cooldown, and the cancel goes at once, counted as `cancelsWaived`);
/// - closeBatch: WrongBatch(openId) for a stale id, BatchTooSmall for a minimum above a non-empty batch's deposits (an
///   empty batch rolls whatever the minimum), BatchNotReady (never: the action waits out the timer);
/// - sweepPot: InvalidParameter above the carried pot;
/// - togglePause: the guardian's unpause, OwnableUnauthorizedAccount;
/// - processPayouts: VaultModel's _chunkOutcome (UnstakeShort when the walk cannot cover the chunk or its receipts do
///   not fund the send, FeeTooHigh when its cost would leave an entry nothing);
/// - depositDirect: StakeMissing, VaultInsolvent, CapExceeded (none reached: nothing goes missing or is lost);
/// - redeemDirect: VaultModel's _exitPlan (ZeroAmount, UnstakeShort);
/// - setRedeemOrigin: UnknownOrigin for a chain with no active door (chain 42) and for chain 0;
/// - setOutflowLimits: NotScheduled for a loosening called directly; InvalidParameter for each value past its hard
///   bound (a percentage below 2,000 or above 5,000 bps, the floor below 10 or above 100 TAO), at once for one below
///   (a tightening), at the scheduled item's execute for one above (a loosening);
/// - cancelQueued: NothingToCancel when every unsent entry is a bounce;
/// - a delivery the bridge files as refused: none (both doors stay active, nothing goes missing, never underwater).
/// Not reachable here, so on no list: AboveBridgeCap (no limit setter for the batch or message value runs and every
/// batch is far below the bridge's cap), NoOracle and BelowOracleFloor (the staker's buy side; nothing stakes USDC),
/// ForeverMoney's Slippage, IsHalted and MigrationInProgress (no adapter: the bridge is MockBridge).
contract DoorsHandler is VaultModel, FrontDoorTracker {
    /// What the campaign's fixture adds: the bridged TAO, the bridge, the two doors' chains, and the outflow limits it
    /// deployed with (the handler's record starts from them).
    struct Parts {
        MockTAO tao;
        MockBridge bridge;
        uint64 baseChain;
        uint64 secondChain;
        uint256 bps;
        uint256 floor;
        uint256 globalBps;
    }

    /// A deposit a door sent the vault, as the handler snapshots it right before the close (_snapshot): the depositor,
    /// its ghost origin then, its amount (whole rao, as the door holds it), and what the delivery did with it
    /// (`outcome`: 0 nothing yet, 1 minted, 2 bounced ForeignOrigin, 3 bounced Insolvent, 4 more than one of those).
    struct Sent {
        address user;
        uint64 origin;
        uint256 amount;
        uint8 outcome;
    }

    /// A burn window as the handler records it: when it opened and what it burned.
    struct Record {
        uint64 start;
        uint256 burned;
    }

    uint256 internal constant ACTORS = 5;
    uint256 internal constant MAX_DEPOSIT = 500e18;
    /// Native balance an actor keeps back from direct deposits, for redeem-request fees.
    uint256 internal constant FEE_MONEY = 10 ether;
    uint32 internal constant CHUNK_ENTRIES = 3;
    /// A chain no door is on: setRedeemOrigin to it is refused UnknownOrigin.
    uint64 public constant NO_DOOR_CHAIN = 42;
    /// The vault's hard bounds on the outflow limits (spec §3.4), restated: both percentages 2,000 to 5,000 bps, the
    /// floor 10 to 100 TAO.
    uint256 internal constant MIN_BPS = 2_000;
    uint256 internal constant MAX_BPS = 5_000;
    uint256 internal constant MIN_FLOOR = 10e18;
    uint256 internal constant MAX_FLOOR = 100e18;
    /// A burn window's length (spec §3.4).
    uint256 internal constant WINDOW = 24 hours;

    MockTAO public immutable tao;
    MockBridge public immutable bridge;
    uint64 public immutable baseChain;
    uint64 public immutable secondChain;
    /// The second door, on secondChain (set once, by addSecondDoor), and both doors' peer ids at the vault.
    CascadeFrontDoor public fd2;
    bytes32[2] public peers;

    address[5] public actors;

    // ---- the payout queue (from the deliveries' events) ----

    bytes32[] public queuedKeys;
    mapping(bytes32 => CascadeMessages.Payout[]) internal _lists;
    /// Which door (0 the launch door, 1 the second) a queued batch pays.
    mapping(bytes32 => uint256) public doorOfKey;

    // ---- I-15: the handler's windows and limits ----

    Record[2] internal _doorWindows;
    Record internal _globalWindow;
    /// Which doors burned in the global window's current day (bit 0 the launch door, bit 1 the second).
    uint256 internal _globalDoors;
    uint256 public ghostBps;
    uint256 public ghostFloor;
    uint256 public ghostGlobalBps;
    /// Burning deliveries after which a door's window, or the global one, held more than its allowance on the ghost
    /// base (I-15; asserted 0), and the model's checks: steps after which the handler's window record, its ghost
    /// ledger and ramp, or its record of the limits was not the vault's.
    uint256 public doorWindowViolations;
    uint256 public globalWindowViolations;
    uint256 public windowRecordMismatches;
    uint256 public ghostLedgerMismatches;
    uint256 public limitMismatches;

    // ---- I-16 and I-17: the handler's origins ----

    mapping(address => uint64) public ghostOrigin;
    /// The deposits of the batch being closed (_snapshot), and its door's chain: each must come out of the delivery
    /// minted or bounced, exactly one of the two (_markSent, _resolveSent).
    Sent[] internal _sent;
    uint64 internal _sentChain;
    /// The order of each holder's direct deposits and origin changes: a counter, the number of its last direct deposit
    /// and of its last origin change, and the chain that change named.
    uint256 internal _originSeq;
    mapping(address => uint256) public lastDirectSeq;
    mapping(address => uint256) public lastSetSeq;
    mapping(address => uint64) public lastSetChain;
    /// I-16: a burn for another origin than the door's chain; a skip of a holder of the door's chain with shares; a
    /// mint for another chain's origin, or a ForeignOrigin bounce of a holder of 0, the door's chain or DIRECT_ORIGIN;
    /// steps after which a holder's origin at the vault was not the ghost's; direct deposits that did not leave
    /// DIRECT_ORIGIN; first mints that did not set the door's chain (all asserted 0).
    uint256 public originBurnViolations;
    uint256 public originSkipViolations;
    uint256 public originMintViolations;
    uint256 public originMismatches;
    /// I-16 (b)'s other half: deposits a door sent that the delivery neither minted nor bounced, or did both (or by
    /// another amount), and deposits for another chain's origin that did not bounce ForeignOrigin (asserted 0); and the
    /// deposits so resolved.
    uint256 public depositOutcomeMisses;
    uint256 public foreignDepositsNotBounced;
    uint256 public depositOutcomesChecked;
    uint256 public directOriginMisses;
    uint256 public firstMintMisses;
    /// I-17: burns by a door for a holder whose last origin change after its last direct deposit did not name that
    /// door's chain (asserted 0).
    uint256 public directSharesBurnedByADoor;

    // ---- I-20 ----

    /// Exit calls (and incoming payouts) that reverted EnforcedPause (asserted 0).
    uint256 public exitsRefusedWhilePaused;

    // ---- I-13's direct half (the leaver pays) ----

    /// Direct exits not paid exactly VaultModel's _exitPlan, or whose ShortfallAbsorbed was not its unmet + cost.
    uint256 public directMispaid;

    // ---- reachability counters ----

    uint256[2] public deposits;
    uint256[2] public depositsFor;
    uint256[2] public redeemRequests;
    uint256[2] public closes;
    uint256[2] public rolls;
    uint256[2] public deliveries;
    uint256[2] public burningDeliveries;
    uint256[2] public payoutChunks;
    uint256[2] public claims;
    uint256 public requestsWithDelivery;
    uint256 public depositCancels;
    uint256 public redeemCancels;
    uint256 public selfCloses;
    uint256 public closesWithExtra;
    uint256 public rollsWithMinValue;
    uint256 public wrongBatches;
    uint256 public tooSmallCloses;
    uint256 public sweeps;
    uint256 public sweepsRefused;
    uint256 public partialChunks;
    uint256 public payoutsUncoverable;
    uint256 public chunksRefusedWalkCost;
    uint256 public cancels;
    uint256 public cancelsRefusedNothing;
    uint256 public bouncesCarried;
    uint256 public directDeposits;
    uint256 public directDepositsOverADoorOrigin;
    uint256 public directRedeems;
    uint256 public exitsRefusedByCost;
    /// Refusals as predicted: deposits at a door's limit, first requests on a full list with a pot short of the fee
    /// (InsufficientFee), direct deposits, and direct exits other than by their walk's cost (ZeroAmount under a rao,
    /// UnstakeShort, StakeMissing).
    uint256 public depositsRefusedAtALimit;
    /// depositAtALimit's targeted draws made (Task 42).
    uint256 public limitDraws;
    uint256 public requestsRefusedFee;
    uint256 public directDepositsRefused;
    uint256 public directExitsRefused;
    uint256 public directExitsShort;
    uint256 public stakes;
    uint256 public feeSwitches;
    uint256 public bankRuns;
    /// The origin rule's states: mints at a door for an origin of 0 (first mints), of the door's chain and of
    /// DIRECT_ORIGIN; ForeignOrigin bounces; burns, and burns for a holder that once deposited directly; skips of a
    /// holder of another chain, of DIRECT_ORIGIN and with no shares; deferred redeems.
    uint256 public firstMints;
    uint256 public homeMints;
    uint256 public directOriginMints;
    uint256 public foreignBounces;
    uint256 public burns;
    uint256 public burnsAfterADirectDeposit;
    uint256 public skipsForeign;
    uint256 public skipsDirect;
    uint256 public skipsNoShares;
    uint256 public redeemsDeferred;
    uint256 public originsSet;
    uint256 public originsSetToDirect;
    /// setRedeemOrigin refused UnknownOrigin: for chain 42 (no door), and for chain 0.
    uint256 public originsRefusedChain42;
    uint256 public originsRefusedChain0;
    /// The windows' states: burning deliveries where the global window's rest was smaller than the door's (the global
    /// window binding), where the door's was smaller, after which the binding rest fell below a redeem's minimum (the day
    /// spent), global days in which both doors burned, deliveries that deferred a redeem because the other door had spent
    /// the global window (_countDeferral); burns while the floor was the allowance.
    uint256 public globalTighter;
    uint256 public doorTighter;
    uint256 public windowsSpent;
    uint256 public globalDaysWithBothDoors;
    uint256 public deferredByTheOtherDoor;
    uint256 public burnsAtTheFloor;
    /// The limits: changes at once and scheduled, a loosening called directly (NotScheduled), and each value past its
    /// bound refused (bps low, bps high, floor low, floor high, global low, global high).
    uint256 public limitsTightened;
    uint256 public limitsLoosened;
    uint256 public limitsRefusedUnscheduled;
    uint256[6] public limitsRefusedOutOfBounds;
    /// The pause: pauses by the owner and by the guardian, unpauses, the guardian's refused unpause; deposits,
    /// depositFors and deliveries refused EnforcedPause; exit calls that went through on a paused door, by kind.
    uint256 public pausesByOwner;
    uint256 public pausesByGuardian;
    uint256 public unpauses;
    uint256 public unpausesRefused;
    uint256 public depositsRefusedPaused;
    uint256 public depositForsRefusedPaused;
    uint256 public deliversRefusedPaused;
    uint256 public pausedRequests;
    uint256 public pausedRequestsWithDelivery;
    uint256 public pausedRedeemCancels;
    uint256 public pausedDepositCancels;
    uint256 public pausedCloses;
    uint256 public pausedSelfCloses;
    uint256 public pausedClaims;
    uint256 public pausedPayouts;

    constructor(System memory s, Parts memory p) VaultModel(s) {
        tao = p.tao;
        bridge = p.bridge;
        baseChain = p.baseChain;
        secondChain = p.secondChain;
        ghostBps = p.bps;
        ghostFloor = p.floor;
        ghostGlobalBps = p.globalBps;
        require(
            s.vaultLens.maxDailyOutflowBps() == p.bps && s.vaultLens.minDailyOutflow() == p.floor
                && s.vaultLens.globalOutflowBps() == p.globalBps,
            "the deployed limits"
        );
        peers[0] = s.vaultLens.peerId(p.baseChain, address(s.fd));
        actors = [makeAddr("alice"), makeAddr("bob"), makeAddr("carol"), makeAddr("dave"), makeAddr("erin")];
        for (uint256 i; i < ACTORS; ++i) {
            p.tao.mint(actors[i], 10_000e18);
            vm.prank(actors[i]);
            p.tao.approve(address(s.fd), type(uint256).max);
            vm.deal(actors[i], 10_000e18 + FEE_MONEY);
            _trackAccount(actors[i]);
        }
        _trackAccount(address(p.bridge));
        _trackAccount(s.fd.treasury());
        _trackWord(s.vaultLens.stakeHotkey(), WordKind.Hotkey);
        _trackPeer(p.baseChain, address(s.fd));
        _trackPeer(p.secondChain, address(0));
        _trackMessage(p.baseChain, address(s.fd), "");
        _trackDoor(s.fd);
    }

    /// The second door, once (the campaign's setUp; no action): its holders' approvals, its activation through the
    /// owner's real schedule (activateFrontDoor's 7-day Registry item, Schedule.run: schedule, wait, execute), and the
    /// lenses' argument sets.
    function addSecondDoor(CascadeFrontDoor d) external {
        require(address(fd2) == address(0) && d.vaultChain() == fd.vaultChain(), "the second door");
        fd2 = d;
        for (uint256 i; i < ACTORS; ++i) {
            vm.prank(actors[i]);
            tao.approve(address(d), type(uint256).max);
        }
        bytes memory data = abi.encodeCall(CascadeVault.activateFrontDoor, (secondChain, address(d)));
        Schedule.run(vault, owner, data);
        peers[1] = vaultLens.peerId(secondChain, address(d));
        _trackDoor(d);
        _trackAccount(d.treasury());
        _trackPeer(secondChain, address(d));
        _trackMessage(secondChain, address(d), "");
        _trackWord(keccak256(data), WordKind.Scheduled);
        _raiseFloor();
    }

    /// @dev Takes the unused part of each close's budget back.
    receive() external payable {}

    /// @dev After every action: the vault's origins, ledger and limits against the handler's (the model's checks).
    modifier checked() {
        _;
        _checkGhosts();
    }

    // ---- the doors: deposits ----

    /// @dev A deposit of 1 to 500 TAO, by the actor itself or (one draw in four) as another actor's depositFor, at the
    /// actor's home door (_homeDoor) three draws in four, else at either door (`doorSeed` bit 0), so a deposit at the
    /// other chain's door bounces; one draw in two the keeper then closes that batch. On a paused door it must refuse
    /// EnforcedPause (and one draw in three the keeper's deliver is tried instead, which must refuse EnforcedPause too).
    function deposit(uint256 actorSeed, uint256 doorSeed, uint256 amount) external step checked mints {
        address user = actors[actorSeed % ACTORS];
        uint256 i = (doorSeed >> 5) % 4 == 0 ? doorSeed % 2 : _homeDoor(user, doorSeed);
        CascadeFrontDoor d = _door(i);
        bool paused = d.paused();
        if (paused && (doorSeed >> 3) % 3 == 0) {
            _deliverWhilePaused(d, user);
            return;
        }
        bool viaFor = (doorSeed >> 1) % 4 == 0;
        address payer = viaFor ? actors[(actorSeed % ACTORS + 1 + (actorSeed / ACTORS) % (ACTORS - 1)) % ACTORS] : user;
        uint256 maxRao = Math.min(MAX_DEPOSIT, tao.balanceOf(payer)) / RAO;
        if (maxRao < 1e18 / RAO) return;
        amount = bound(amount, 1e18 / RAO, maxRao) * RAO;
        // one draw in two the keeper closes the batch right after, so deposits mint early in a run
        if (_deposit(i, user, payer, amount, viaFor) && (doorSeed >> 7) % 2 == 1) _close(i, 0, 0, 0);
    }

    /// `payer`'s deposit of `amount` for `user` at door `i` (depositFor when `viaFor`, else deposit, `payer` being
    /// `user`), its refusal predicted: EnforcedPause on a paused door, else the door's limits. Returns whether it went
    /// through.
    function _deposit(uint256 i, address user, address payer, uint256 amount, bool viaFor) internal returns (bool ok) {
        CascadeFrontDoor d = _door(i);
        bool paused = d.paused();
        bytes4 expect = paused ? Pausable.EnforcedPause.selector : _depositLimit(d, user, amount);
        bytes memory data = viaFor
            ? abi.encodeCall(CascadeFrontDoor.depositFor, (user, amount))
            : abi.encodeCall(CascadeFrontDoor.deposit, (amount));
        _readLogs();
        vm.prank(payer);
        bytes memory reason;
        (ok, reason) = address(d).call(data);
        if (ok) {
            _succeeded(expect);
            ++deposits[i];
            if (viaFor) ++depositsFor[i];
            // the entry's owner's cancel clock restarts, whoever paid (R11)
            _noteDeposit(d, user);
            _raiseFloor();
        } else {
            _dropLogs();
            if (_refused(reason, expect)) {
                if (!paused) ++depositsRefusedAtALimit;
                else if (viaFor) ++depositForsRefusedPaused;
                else ++depositsRefusedPaused;
            }
        }
    }

    /// The front door's limits on a deposit of `amount` for `user`, in its order (BelowMinDeposit, CapExceeded,
    /// BatchValueFull, BatchFull), or none.
    function _depositLimit(CascadeFrontDoor d, address user, uint256 amount) internal view returns (bytes4) {
        (,, uint256 open,, uint256 nDeposits,) = d.openBatch();
        uint256 total = open + amount;
        if (amount < d.minDeposit()) return CascadeFrontDoor.BelowMinDeposit.selector;
        if (d.netForwarded() + total > d.depositCap()) return CascadeFrontDoor.CapExceeded.selector;
        if (total > d.maxBatchValue()) return CascadeFrontDoor.BatchValueFull.selector;
        if (d.depositOf(user) == 0 && nDeposits >= d.maxDeposits()) return CascadeFrontDoor.BatchFull.selector;
        return 0;
    }

    /// The keeper's deliver on a paused door: EnforcedPause, before anything else (the pause stops a sale).
    function _deliverWhilePaused(CascadeFrontDoor d, address user) internal {
        _readLogs();
        try d.deliver(user, 0) {
            _succeeded(Pausable.EnforcedPause.selector);
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, Pausable.EnforcedPause.selector)) ++deliversRefusedPaused;
        }
    }

    // ---- the doors: redeem requests, cancels, claims ----

    /// @dev A request by an actor with shares, whatever its origin (the door cannot see Bittensor; the delivery burns or
    /// skips it): at its home door three draws in four, else at either door (`doorSeed` bit 0); all its shares one draw
    /// in four, else 1 to all; one draw in four as requestRedeemWithDelivery. The fee by value on its first request in
    /// the open batch. One draw in two the keeper then closes that batch.
    function requestRedeem(uint256 actorSeed, uint256 doorSeed, uint256 shares) external step checked mints {
        (address actor, uint256 balance) = _actorWith(actorSeed, _shares);
        if (balance == 0) return;
        shares = (shares >> 2) % 4 == 0 ? balance : bound(shares, 1, balance);
        uint256 i = (doorSeed >> 5) % 4 == 0 ? doorSeed % 2 : _homeDoor(actor, doorSeed);
        _request(i, actor, shares, (doorSeed >> 1) % 4 == 0);
        // one draw in two the keeper closes the batch right after
        if ((doorSeed >> 7) % 2 == 1) _close(i, 0, 0, 0);
    }

    /// @dev A targeted draw (Task 42, ruling B9: the deposit-limit refusals, unreached before): an actor's deposit at a
    /// door one rao past one of its limits, by `seed` mod 3: one rao under the minimum deposit (BelowMinDeposit), or one
    /// rao past the open batch's value cap (BatchValueFull), or past the door's deposit cap (CapExceeded) when that binds
    /// first; each refusal predicted by _depositLimit, as deposit's are.
    function depositAtALimit(uint256 actorSeed, uint256 doorSeed, uint256 seed) external step checked mints {
        address a = actors[actorSeed % ACTORS];
        uint256 i = doorSeed % 2;
        CascadeFrontDoor d = _door(i);
        (,, uint256 open,,,) = d.openBatch();
        uint256 amount = seed % 3 == 0 ? d.minDeposit() - RAO : _sub0(d.maxBatchValue(), open) + RAO;
        if (amount == 0 || tao.balanceOf(a) < amount) return;
        _deposit(i, a, a, amount, false);
        ++limitDraws;
    }

    /// One request by `actor` at door `i`. A first request that meets a full redeem list closes the batch first, on the
    /// pot alone: refused InsufficientFee when the pot is short of the lane's fee; its delivery is read as a close's
    /// (I-35 around it), and the requester gets nothing back (I-21). Works on a paused door (I-20).
    function _request(uint256 i, address actor, uint256 shares, bool withDelivery) internal {
        CascadeFrontDoor d = _door(i);
        bool hasEntry = d.redeemOf(actor) != 0;
        uint256 fee = hasEntry ? 0 : d.redeemRequestFee();
        if (actor.balance < fee) return;
        (,,, uint256 pot,, uint256 nRedeems) = d.openBatch();
        bool closesFirst = !hasEntry && nRedeems >= d.maxRedeems();
        bytes4 expect = closesFirst && pot < bridge.fee() ? CascadeFrontDoor.InsufficientFee.selector : bytes4(0);
        bool paused = d.paused();
        uint256 paid = actor.balance;
        uint256[3] memory mark = _markPrice();
        // a request that closes the batch sends its deposits: each must come out minted or bounced (I-16)
        if (closesFirst) _snapshot(i);
        // casting to 'uint64' is safe because the test's clock is far below 2^64 seconds
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 deadline = uint64(vm.getBlockTimestamp() + 1 days);
        bytes memory data = withDelivery
            ? abi.encodeCall(
                CascadeFrontDoor.requestRedeemWithDelivery, (shares, 250e6, deadline, d.DESTINATION_BASE())
            )
            : abi.encodeCall(CascadeFrontDoor.requestRedeem, (shares));
        _readLogs();
        vm.prank(actor);
        (bool ok, bytes memory reason) = address(d).call{value: fee}(data);
        if (!ok) {
            _dropLogs();
            // nothing was sent
            delete _sent;
            if (_exitRefused(reason, expect)) ++requestsRefusedFee;
            return;
        }
        _succeeded(expect);
        ++redeemRequests[i];
        if (withDelivery) ++requestsWithDelivery;
        _recordPotIn(d, fee);
        if (paused) {
            if (withDelivery) ++pausedRequestsWithDelivery;
            else ++pausedRequests;
        }
        Vm.Log[] memory logs = _readLogs();
        if (closesFirst) {
            ++selfCloses;
            if (paused) ++pausedSelfCloses;
            if (actor.balance > paid - fee) ++closerGains;
            _recordClose(d, logs);
            _recordDelivery(logs);
            _checkExitPrice(mark);
        }
        _raiseFloor();
    }

    /// @dev A request's self-close (the core campaign's selfClose, at either door): an empty redeem list first takes
    /// one actor's first request; then the owner lowers `maxRedeems` to the open batch's redeem count, so another
    /// actor's first request meets a full list and closes the batch on the pot alone, the lane's fee drawn as for a
    /// close (_laneFee); then the limit and the fee are put back.
    function selfClose(uint256 actorSeed, uint256 doorSeed, uint256 feeSeed, uint256 shares)
        external
        step
        checked
        mints
    {
        uint256 i = doorSeed % 2;
        CascadeFrontDoor d = _door(i);
        (,,, uint256 pot,, uint256 nRedeems) = d.openBatch();
        if (nRedeems == 0) {
            (address first, uint256 held) = _actorWithout(d, actorSeed);
            if (held == 0) return;
            _request(i, first, bound(shares, 1, held), false);
            (,,, pot,, nRedeems) = d.openBatch();
            if (nRedeems == 0) return;
        }
        (address actor, uint256 balance) = _actorWithout(d, actorSeed >> 1);
        if (balance == 0) return;
        uint256 worldFee = bridge.fee();
        uint32 maxDeposits = d.maxDeposits();
        uint32 maxRedeems = d.maxRedeems();
        bridge.setFee(_laneFee(feeSeed, pot, worldFee));
        vm.prank(owner);
        // casting to 'uint32' is safe because the open batch holds at most one request per actor
        // forge-lint: disable-next-line(unsafe-typecast)
        d.setBatchLimits(maxDeposits, uint32(nRedeems));
        _request(i, actor, bound(shares, 1, balance), (feeSeed >> 64) % 4 == 0);
        vm.prank(owner);
        d.setBatchLimits(maxDeposits, maxRedeems);
        bridge.setFee(worldFee);
    }

    function cancelDeposit(uint256 actorSeed, uint256 doorSeed, uint256 amount) external step checked {
        CascadeFrontDoor d = _door(doorSeed % 2);
        (address actor, uint256 open) = _actorWithEntry(d, actorSeed, true);
        if (open == 0) return;
        amount = bound(amount, 1, open / RAO) * RAO;
        uint256 left = open - amount;
        // a partial cancel must leave at least minDeposit, so a smaller remainder cancels in full
        if (left != 0 && left < d.minDeposit()) amount = open;
        bool paused = d.paused();
        // within five minutes of the actor's last deposit at this door, CancelTooSoon while unpaused (R11); paused, at
        // once (R12: the pause waives the cooldown)
        bytes memory tooSoon = _cancelTooSoon(d, actor);
        bool waived = _waivedNow(d, actor);
        _readLogs();
        vm.prank(actor);
        try d.cancelDeposit(amount) {
            // a predicted refusal lost
            if (tooSoon.length != 0) ++unexpectedReverts;
            ++depositCancels;
            if (paused) ++pausedDepositCancels;
            if (waived) _countWaived(d);
        } catch (bytes memory reason) {
            _dropLogs();
            if (!_refusedTooSoon(reason, tooSoon)) _exitRefused(reason, 0);
        }
    }

    function cancelRedeem(uint256 actorSeed, uint256 doorSeed, uint256 shares) external step checked {
        CascadeFrontDoor d = _door(doorSeed % 2);
        (address actor, uint256 open) = _actorWithEntry(d, actorSeed, false);
        if (open == 0) return;
        shares = bound(shares, 1, open);
        bool paused = d.paused();
        _readLogs();
        vm.prank(actor);
        try d.cancelRedeem(shares) {
            ++redeemCancels;
            if (paused) ++pausedRedeemCancels;
        } catch (bytes memory reason) {
            _dropLogs();
            _exitRefused(reason, 0);
        }
    }

    /// @dev An actor claims its credit at door `doorSeed % 2`; when no actor has one there, the keeper first sends a
    /// queued batch's next chunk (processPayouts' body), so the claims follow the payouts.
    function claim(uint256 actorSeed, uint256 doorSeed) external step checked {
        uint256 i = doorSeed % 2;
        CascadeFrontDoor d = _door(i);
        if (_claimant(d, actorSeed) == address(0)) _processPayouts(actorSeed);
        address actor = _claimant(d, actorSeed);
        if (actor == address(0)) return;
        uint256 owed = d.claimable(actor);
        bool paused = d.paused();
        uint256 before = tao.balanceOf(actor);
        _readLogs();
        vm.prank(actor);
        try d.claim() {
            if (tao.balanceOf(actor) != before + owed) ++unexpectedReverts;
            ++claims[i];
            if (paused) ++pausedClaims;
        } catch (bytes memory reason) {
            _dropLogs();
            _exitRefused(reason, 0);
        }
    }

    // ---- the doors: the keeper's close, the owner's sweep and pause ----

    /// @dev Warps 12 hours (the door's timer, at its block rate), then the keeper closes door `doorSeed % 2`'s batch:
    /// by `closeSeed` mod 8 a stale id (1: the batch before or after; WrongBatch(openId)), a minimum of 0 to twice the
    /// deposits plus 1 TAO (2: BatchTooSmall when above a non-empty batch's deposits), else the open id with no
    /// minimum; an empty batch is closed too, with a minimum one draw in two, and must roll (BatchRolled, the id kept,
    /// the value back). The lane's fee is drawn for this send (_laneFee) and put back; the handler sends what the pot
    /// lacks plus 0 to the world's fee and must get back no more than it sent (I-21). The delivery inside the close
    /// is read (_recordDelivery) and I-35 checked around the close.
    function closeBatch(uint256 doorSeed, uint256 feeSeed, uint256 valueSeed, uint256 closeSeed)
        external
        step
        checked
        mints
    {
        _close(doorSeed % 2, feeSeed, valueSeed, closeSeed);
    }

    /// @dev A run on both doors (one draw in two, by a hash of the seed): the keeper stakes what is idle and a day passes
    /// (the stake ramps into the base), every holder whose origin (the handler's ghost) is a door's chain asks for all
    /// its shares at that door and deposits 1 TAO at the other one (which must bounce ForeignOrigin, I-16), every other
    /// actor deposits 1 TAO at both, then the keeper closes the launch door's batch and, 12 hours later, the second
    /// door's: both doors burn in one global window, so the global allowance binds across them (I-15), and each batch
    /// mixes foreign deposits with deposits that mint and redeems that burn.
    function bankRun(uint256 seed) external step checked mints {
        if (uint256(keccak256(abi.encode(seed, "run"))) % 2 != 0) return;
        _stakeIdle();
        _warp(1 days, doorBlockTime);
        for (uint256 k; k < ACTORS; ++k) {
            address a = actors[k];
            uint64 o = ghostOrigin[a];
            uint256 held = vault.balanceOf(a);
            bool chainHolder = o == baseChain || o == secondChain;
            uint256 i = o == baseChain ? 0 : 1;
            if (chainHolder && held != 0 && _door(i).redeemOf(a) == 0) _request(i, a, held, false);
            if (tao.balanceOf(a) < 2e18) continue;
            if (chainHolder) {
                _deposit(1 - i, a, a, 1e18, false);
            } else {
                _deposit(0, a, a, 1e18, false);
                _deposit(1, a, a, 1e18, false);
            }
        }
        ++bankRuns;
        _close(0, 0, 0, 0);
        _close(1, 0, 0, 0);
    }

    /// closeBatch's body for door `i` (see it).
    function _close(uint256 i, uint256 feeSeed, uint256 valueSeed, uint256 closeSeed) internal {
        CascadeFrontDoor d = _door(i);
        _warp(12 hours, doorBlockTime);
        (uint64 id,, uint256 open, uint256 pot, uint256 nDeposits, uint256 nRedeems) = d.openBatch();
        bool empty = nDeposits + nRedeems == 0;
        _ageShares();
        uint64 named = id;
        uint256 minValue;
        if (closeSeed % 8 == 1) {
            named = (closeSeed >> 3) % 2 == 0 ? id - 1 : id + 1;
        } else if (closeSeed % 8 == 2 || (empty && (closeSeed >> 3) % 2 == 0)) {
            minValue = bound(closeSeed >> 4, 0, 2 * open + 1e18);
        }
        bytes4 expect;
        if (named != id) expect = CascadeFrontDoor.WrongBatch.selector;
        else if (!d.canClose()) expect = CascadeFrontDoor.BatchNotReady.selector;
        else if (!empty && open < minValue) expect = CascadeFrontDoor.BatchTooSmall.selector;
        uint256 worldFee = bridge.fee();
        uint256 fee = _laneFee(feeSeed, pot, worldFee);
        uint256 lacks = empty || fee <= pot ? 0 : fee - pot;
        uint256 value = lacks + bound(valueSeed, 0, worldFee);
        bridge.setFee(fee);
        uint256 held = address(this).balance;
        bool paused = d.paused();
        uint256[3] memory mark = _markPrice();
        // the deposits this close sends: each must come out of its delivery minted or bounced (I-16)
        _snapshot(i);
        _readLogs();
        try d.closeBatch{value: value}(named, minValue) {
            _succeeded(expect);
            if (address(this).balance > held) ++closerGains;
            Vm.Log[] memory logs = _readLogs();
            if (paused) ++pausedCloses;
            if (empty) {
                _checkRoll(d, logs, id, address(this).balance == held);
                if (minValue != 0) ++rollsWithMinValue;
                ++rolls[i];
            } else {
                ++closes[i];
                if (value > lacks) ++closesWithExtra;
                _recordClose(d, logs);
                _recordDelivery(logs);
                _checkExitPrice(mark);
            }
            _raiseFloor();
        } catch (bytes memory reason) {
            _dropLogs();
            // a refused close sent nothing
            delete _sent;
            if (_exitRefused(reason, expect)) {
                if (expect == CascadeFrontDoor.WrongBatch.selector) {
                    // the refusal names the open batch
                    if (keccak256(reason) != keccak256(abi.encodeWithSelector(expect, id))) ++unexpectedReverts;
                    ++wrongBatches;
                } else if (expect == CascadeFrontDoor.BatchTooSmall.selector) {
                    ++tooSmallCloses;
                }
            }
        }
        bridge.setFee(worldFee);
    }

    /// An empty batch's close: it rolled (BatchRolled naming `id`, the id kept, nothing sent) and the closer kept all
    /// its value (`refunded`).
    function _checkRoll(CascadeFrontDoor d, Vm.Log[] memory logs, uint64 id, bool refunded) internal {
        bool rolled;
        for (uint256 k; k < logs.length; ++k) {
            if (logs[k].emitter != address(d)) continue;
            if (logs[k].topics[0] == CascadeFrontDoor.BatchRolled.selector && logs[k].topics[1] == bytes32(uint256(id)))
            {
                rolled = true;
            } else if (logs[k].topics[0] == CascadeFrontDoor.BatchClosed.selector) {
                rolled = false;
                break;
            }
        }
        (uint64 openId,,,,,) = d.openBatch();
        if (!rolled || openId != id || !refunded) ++unexpectedReverts;
    }

    /// @dev The owner sweeps 0 to all of door `doorSeed % 2`'s carried pot to its treasury, or (one draw in eight)
    /// more than it carries, which must refuse InvalidParameter.
    function sweepPot(uint256 doorSeed, uint256 amountSeed) external step checked {
        CascadeFrontDoor d = _door(doorSeed % 2);
        uint256 carried = d.potCarried();
        bool over = amountSeed % 8 == 0;
        uint256 amount = over ? carried + 1 + bound(amountSeed >> 3, 0, 1e15) : bound(amountSeed >> 3, 0, carried);
        bytes4 expect = over ? CascadeFrontDoor.InvalidParameter.selector : bytes4(0);
        _readLogs();
        vm.prank(owner);
        try d.sweepPot(amount) {
            _succeeded(expect);
            _recordSweep(d, amount);
            if (amount != 0) ++sweeps;
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, expect)) ++sweepsRefused;
        }
    }

    /// @dev Door `doorSeed % 2`'s pause, through the roles that hold it: unpaused, the owner or the guardian pauses it
    /// (one draw in two each); paused, the owner unpauses it, or (one draw in four) the guardian tries and is refused
    /// OwnableUnauthorizedAccount (only the owner unpauses).
    function togglePause(uint256 doorSeed, uint256 bySeed) external step checked {
        CascadeFrontDoor d = _door(doorSeed % 2);
        if (!d.paused()) {
            bool byGuardian = bySeed % 2 == 1;
            _readLogs();
            vm.prank(byGuardian ? guardian : owner);
            try d.pause() {
                if (byGuardian) ++pausesByGuardian;
                else ++pausesByOwner;
            } catch {
                _dropLogs();
                ++unexpectedReverts;
            }
            return;
        }
        if (bySeed % 4 == 0) {
            _readLogs();
            vm.prank(guardian);
            try d.unpause() {
                ++unexpectedReverts;
            } catch (bytes memory reason) {
                _dropLogs();
                if (
                    keccak256(reason)
                        == keccak256(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian))
                ) {
                    ++unpausesRefused;
                } else {
                    ++unexpectedReverts;
                }
            }
            return;
        }
        _readLogs();
        vm.prank(owner);
        try d.unpause() {
            ++unpauses;
        } catch {
            _dropLogs();
            ++unexpectedReverts;
        }
    }

    // ---- the vault: payouts and the owner's cancel ----

    /// @dev Warps 24 hours (the payout delay, at the vault's block rate) and the keeper sends the next chunk of 1 to
    /// CHUNK_ENTRIES entries of a queued batch, either door's, at the world's fee (within the ceiling: no top-up),
    /// predicted by VaultModel's _chunkOutcome; I-35 and the walk's removals checked around it; the ghost ledger books
    /// its removals. A chunk to a paused door must land (I-20: an incoming payout works while paused).
    function processPayouts(uint256 keySeed) external step checked {
        _processPayouts(keySeed);
    }

    /// processPayouts' body (see it).
    function _processPayouts(uint256 keySeed) internal {
        uint256 n = queuedKeys.length;
        if (n == 0) return;
        bytes32 key = queuedKeys[keySeed % n];
        // casting to 'uint32' is safe because the value is at most CHUNK_ENTRIES
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 maxEntries = uint32(1 + (keySeed / n) % CHUNK_ENTRIES);
        _warp(24 hours, vaultBlockTime);
        CascadeMessages.Payout[] memory list = _lists[key];
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        ChunkOut memory o = _chunkOutcome(list, b, maxEntries, bridge.fee(), 0);
        uint256 i = doorOfKey[key];
        bool paused = _door(i).paused();
        (bytes32[] memory hs, uint256[] memory ss) = _positions();
        uint256 stakeBefore = _coldkeyStake();
        uint256[3] memory mark = _markPrice();
        _readLogs();
        try vault.processPayouts(key, list, maxEntries) {
            _succeeded(o.refusal);
            Vm.Log[] memory logs = _readLogs();
            _recordPayout(i, key, logs, o.net != 0);
            _bookRemovals(hs, ss);
            _exitRemovals(logs, stakeBefore);
            _checkExitPrice(mark);
            _checkWalk(logs, o.walk);
            PayoutBatch memory a = vaultLens.getPayoutBatch(key);
            if (a.count == 0) _dropKey(key);
            else ++partialChunks;
            ++payoutChunks[i];
            if (paused) ++pausedPayouts;
            _raiseFloor();
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, o.refusal)) {
                if (o.refusal == FeeTooHigh.selector) ++chunksRefusedWalkCost;
                else ++payoutsUncoverable;
            }
        }
    }

    /// A sent chunk's logs: the bridge delivered it to door `i` (its PayoutsDelivered naming `key`, when anything was
    /// sent); a payout the bridge filed as refused is unexpected, and one refused EnforcedPause breaks I-20 too.
    function _recordPayout(uint256 i, bytes32 key, Vm.Log[] memory logs, bool sent) internal {
        bool landed;
        for (uint256 k; k < logs.length; ++k) {
            Vm.Log memory log = logs[k];
            if (log.emitter == address(bridge) && log.topics[0] == MockBridge.DeliveryFailed.selector) {
                (, bytes memory reason) = abi.decode(log.data, (uint256, bytes));
                if (_selector(reason) == Pausable.EnforcedPause.selector) ++exitsRefusedWhilePaused;
                ++unexpectedReverts;
            } else if (
                log.emitter == address(_door(i)) && log.topics[0] == CascadeFrontDoor.PayoutsDelivered.selector
                    && log.topics[1] == key
            ) {
                landed = true;
            }
        }
        if (sent && !landed) ++unexpectedReverts;
    }

    /// @dev The owner cancels a queued batch's unsent payouts: its redeems re-minted at the price before (never more
    /// shares than they burned), its unsent bounces carried forward in order as the batch's new list; with no redeem
    /// left it must refuse NothingToCancel. I-35 around it (nothing here leaves a hole). A re-mint writes no origin
    /// (the ghosts are compared after the step).
    function cancelQueued(uint256 keySeed) external step checked {
        uint256 n = queuedKeys.length;
        if (n == 0) return;
        bytes32 key = queuedKeys[keySeed % n];
        CascadeMessages.Payout[] memory list = _lists[key];
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        uint256 carried = _bounces(list, b.cursor, list.length);
        bytes4 expect = b.count - b.cursor - carried == 0 ? NothingToCancel.selector : bytes4(0);
        uint256[3] memory mark = _markPrice();
        _readLogs();
        vm.prank(owner);
        try vault.cancelPayoutBatch(key, list) {
            _succeeded(expect);
            _checkExitPrice(mark);
            bouncesCarried += carried;
            if (carried == 0) {
                _dropKey(key);
            } else {
                delete _lists[key];
                for (uint256 k = b.cursor; k < list.length; ++k) {
                    if (list[k].shares == 0) _lists[key].push(list[k]);
                }
            }
            ++cancels;
            _raiseFloor();
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, expect)) ++cancelsRefusedNothing;
        }
    }

    // ---- the vault: direct holders and origins ----

    /// @dev A direct deposit of 0.001 to 500 TAO, by the direct holder (erin) three draws in four, else by any actor (a
    /// door's holder flipping to DIRECT_ORIGIN): it leaves the actor's origin DIRECT_ORIGIN, whatever it was (I-16), and
    /// numbers it in the actor's order (I-17). Its refusals in the vault's order: StakeMissing, VaultInsolvent,
    /// CapExceeded (none reached here).
    function depositDirect(uint256 actorSeed, uint256 amount) external step checked mints {
        address actor = (actorSeed / ACTORS) % 4 == 0 ? actors[actorSeed % ACTORS] : actors[ACTORS - 1];
        uint256 maxRao = Math.min(MAX_DEPOSIT, _sub0(actor.balance, FEE_MONEY)) / RAO;
        if (maxRao < 1e15 / RAO) return;
        amount = bound(amount, 1e15 / RAO, maxRao) * RAO;
        uint256 assets = vaultLens.totalAssets();
        bytes4 expect;
        if (vaultLens.stakeMissing()) expect = StakeMissing.selector;
        else if (assets * 2_000_000 < vault.totalSupply() || _underwater()) expect = VaultInsolvent.selector;
        else if (assets + amount > vaultLens.maxTotalAssets()) expect = CapExceeded.selector;
        uint64 before = ghostOrigin[actor];
        _readLogs();
        vm.prank(actor);
        try vault.depositDirect{value: amount}() {
            _succeeded(expect);
            ghostOrigin[actor] = DIRECT_ORIGIN;
            lastDirectSeq[actor] = ++_originSeq;
            if (vaultLens.redeemOrigin(actor) != DIRECT_ORIGIN) ++directOriginMisses;
            if (before != 0 && before != DIRECT_ORIGIN) ++directDepositsOverADoorOrigin;
            ++directDeposits;
            _raiseFloor();
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, expect)) ++directDepositsRefused;
        }
    }

    /// @dev An unflagged direct exit of 1 to all of an actor's shares (the direct holder's three draws in four), predicted by VaultModel's _exitPlan (the leaver
    /// pays its walk's cost: paid exactly e.paid, ShortfallAbsorbed e.unmet + e.cost); I-35 and the walk's removals
    /// around it, and the ghost ledger books its removals. A direct exit has no window (spec §3.5).
    function redeemDirect(uint256 actorSeed, uint256 shares) external step checked {
        // the direct holder three draws in four (when it has shares), else any actor with shares
        address actor = actors[ACTORS - 1];
        uint256 balance = vault.balanceOf(actor);
        if ((actorSeed / ACTORS) % 4 == 0 || balance == 0) (actor, balance) = _actorWith(actorSeed, _shares);
        if (balance == 0) return;
        shares = (shares >> 2) % 4 == 0 ? balance : bound(shares, 1, balance);
        uint256 out = CascadeMath.assetsForRedeem(shares, vaultLens.totalAssets(), vault.totalSupply());
        out -= out % RAO;
        ExitOut memory e = _exitPlan(_availableAt(vaultLens.pendingPayouts()), out);
        bytes4 expect = vaultLens.stakeMissing() ? StakeMissing.selector : e.refusal;
        (bytes32[] memory hs, uint256[] memory ss) = _positions();
        uint256 stakeBefore = _coldkeyStake();
        uint256[3] memory mark = _markPrice();
        uint256 before = actor.balance;
        _readLogs();
        vm.prank(actor);
        try vault.redeemDirect(shares, false) {
            _succeeded(expect);
            uint256 paid = actor.balance - before;
            Vm.Log[] memory logs = _readLogs();
            _bookRemovals(hs, ss);
            _exitRemovals(logs, stakeBefore);
            _checkWalk(logs, e.walk);
            _checkExitPrice(mark);
            if (paid != e.paid || _absorbed(logs) != e.unmet + e.cost) ++directMispaid;
            if (e.unmet + e.cost != 0) ++directExitsShort;
            ++directRedeems;
            _raiseFloor();
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, expect)) {
                if (expect == ZeroAmount.selector && out >= RAO) ++exitsRefusedByCost;
                else ++directExitsRefused;
            }
        }
    }

    /// @dev An actor sets its redeem origin: its home door's chain (4 draws in 8; _homeDoor), the other door's (1),
    /// DIRECT_ORIGIN (1), or a chain with no door (42, or 0), refused UnknownOrigin. Numbered in the actor's order
    /// (I-17).
    function setRedeemOrigin(uint256 actorSeed, uint256 chainSeed) external step checked {
        address actor = actors[actorSeed % ACTORS];
        uint256 kind = chainSeed % 8;
        uint256 home = _homeDoor(actor, chainSeed >> 3);
        uint64 chain = kind < 4
            ? _chainOf(home)
            : kind == 4 ? _chainOf(1 - home) : kind == 5 ? DIRECT_ORIGIN : kind == 6 ? NO_DOOR_CHAIN : uint64(0);
        // the handler's own knowledge: a door on each of the two chains, always active here
        bytes4 expect =
            chain == baseChain || chain == secondChain || chain == DIRECT_ORIGIN ? bytes4(0) : UnknownOrigin.selector;
        _readLogs();
        vm.prank(actor);
        try vault.setRedeemOrigin(chain) {
            _succeeded(expect);
            ghostOrigin[actor] = chain;
            lastSetSeq[actor] = ++_originSeq;
            lastSetChain[actor] = chain;
            ++originsSet;
            if (chain == DIRECT_ORIGIN) ++originsSetToDirect;
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, expect)) {
                if (chain == NO_DOOR_CHAIN) ++originsRefusedChain42;
                else ++originsRefusedChain0;
            }
        }
    }

    // ---- the vault: the keeper's stake, the owner's limits, the chain ----

    /// @dev The keeper stakes the idle balance (at least the chain's minimum); the ghost ledger books it (_bookStake),
    /// so the allowance base the windows rest on is the handler's replay.
    function stakeIdle() external step checked {
        _stakeIdle();
    }

    /// stakeIdle's body (see it).
    function _stakeIdle() internal {
        uint256 idle = _availableAt(vaultLens.pendingPayouts());
        if (idle / RAO < vaultLens.minStakeRao()) return;
        bytes32 h = vaultLens.stakeHotkey();
        uint256 heldBefore = _stakeOf(h);
        uint256 balanceBefore = address(vault).balance;
        _readLogs();
        try vault.stakeIdle() {
            _bookStake(h, heldBefore, balanceBefore);
            ++stakes;
            _freshRead(_readLogs(), heldBefore);
        } catch {
            _dropLogs();
            ++unexpectedReverts;
        }
    }

    /// @dev The owner's outflow limits (spec §3.4). Five draws in eight: a move within the hard bounds (each percentage
    /// 2,000 to 5,000 bps, the floor 10 to 100 TAO), at once when nothing rises, else as a scheduled item (48 hours),
    /// or, one of those five, a loosening called directly, refused NotScheduled. Three in eight: one value past its
    /// bound (`seed` >> 3 mod 6: bps 1,999 or 5,001, the floor a wei under 10 TAO or over 100 TAO, the global bps 1,999
    /// or 5,001), the others kept, refused InvalidParameter: at once below (a tightening), at the scheduled item's
    /// execute above (a loosening). The handler's record of the limits moves only on a success.
    function setOutflowLimits(uint256 seed, uint256 bpsSeed, uint256 floorSeed, uint256 globalSeed)
        external
        step
        checked
    {
        uint256[3] memory v = [ghostBps, ghostFloor, ghostGlobalBps];
        bool outOfBounds = seed % 8 >= 5;
        uint256 field = (seed >> 3) % 6;
        if (!outOfBounds) {
            // the floor at its lowest three draws in four, so the percentages, not the floor, bound most windows
            uint256 floor_ = floorSeed % 4 == 0 ? bound(floorSeed >> 2, MIN_FLOOR, MAX_FLOOR) : MIN_FLOOR;
            v = [bound(bpsSeed, MIN_BPS, MAX_BPS), floor_, bound(globalSeed, MIN_BPS, MAX_BPS)];
        } else {
            uint256[6] memory past = [MIN_BPS - 1, MAX_BPS + 1, MIN_FLOOR - 1, MAX_FLOOR + 1, MIN_BPS - 1, MAX_BPS + 1];
            v[field / 2] = past[field];
        }
        bool loosens = v[0] > ghostBps || v[1] > ghostFloor || v[2] > ghostGlobalBps;
        bytes memory data = abi.encodeCall(CascadeVault.setOutflowLimits, (v[0], v[1], v[2]));
        bytes4 expect = outOfBounds ? InvalidParameter.selector : bytes4(0);
        if (loosens && !outOfBounds && seed % 8 == 4) {
            _readLogs();
            vm.prank(owner);
            try vault.setOutflowLimits(v[0], v[1], v[2]) {
                ++unexpectedReverts;
            } catch (bytes memory why) {
                _dropLogs();
                if (_refused(why, NotScheduled.selector)) ++limitsRefusedUnscheduled;
            }
            return;
        }
        if (loosens) _scheduleAndWait(vault, data);
        _readLogs();
        vm.prank(owner);
        (bool ok, bytes memory reason) =
            address(vault).call(loosens ? abi.encodeCall(CascadeBase.execute, (data)) : data);
        if (!ok) {
            _dropLogs();
            if (_refused(reason, expect)) ++limitsRefusedOutOfBounds[field];
            return;
        }
        _succeeded(expect);
        (ghostBps, ghostFloor, ghostGlobalBps) = (v[0], v[1], v[2]);
        if (loosens) ++limitsLoosened;
        else ++limitsTightened;
    }

    /// @dev The chain's fee on each stake removal (MockStaking.setRemoveFeeRao), the core campaign's draw, VaultModel's
    /// _removeFeeDraw (0, 1 to 1,000 rao, or 1,001, 50,000, 4,000,000 or 16,000,000 rao), each the walking exit's own cost
    /// (Task 36b).
    function setRemoveFee(uint256 seed) external step checked {
        uint256 fee = _removeFeeDraw(seed);
        if (fee != staking.removeFeeRao()) ++feeSwitches;
        staking.setRemoveFeeRao(fee);
    }

    /// @dev Time on both chains, rolled at the doors' calibrated 120 ms blocks (`_warp`).
    function warp(uint256 secs) external step checked {
        _warp(bound(secs, 1 hours, 3 days), doorBlockTime);
    }

    // ---- deliveries: I-15, I-16, I-17 ----

    /// Reads one delivery (a close's or a self-close's logs): which door delivered (BatchDelivered), each Deposited and
    /// DepositBounced against the ghost origins (I-16's mint clauses; a first mint sets the door's chain), each Redeemed
    /// and RedeemSkipped against them (I-16's burn clause, I-17), the payout list it queued, and its burns into the
    /// handler's windows (I-15, _recordBurn). A delivery the bridge filed as refused is unexpected here.
    function _recordDelivery(Vm.Log[] memory logs) internal {
        uint256 i;
        uint64 chain;
        uint256 burned;
        bool deferred;
        for (uint256 k; k < logs.length; ++k) {
            Vm.Log memory log = logs[k];
            if (log.emitter == address(bridge) && log.topics[0] == MockBridge.DeliveryFailed.selector) {
                ++unexpectedReverts;
                continue;
            }
            if (log.emitter != address(vault)) continue;
            bytes32 sig = log.topics[0];
            if (sig == BatchDelivered.selector) {
                // casting to 'uint64' is safe because the topic is an indexed uint64
                // forge-lint: disable-next-line(unsafe-typecast)
                chain = uint64(uint256(log.topics[2]));
                i = _doorIndexOf(_topicAddress(log.topics[3]));
                if (chain != _chainOf(i)) ++unexpectedReverts;
                ++deliveries[i];
            } else if (sig == Deposited.selector) {
                (uint256 assets,) = abi.decode(log.data, (uint256, uint256));
                _markSent(_topicAddress(log.topics[2]), assets, 1);
                if (assets != 0) _onMint(_topicAddress(log.topics[2]), chain);
            } else if (sig == DepositBounced.selector) {
                address user = _topicAddress(log.topics[2]);
                (uint256 assets, BounceReason reason) = abi.decode(log.data, (uint256, BounceReason));
                _markSent(user, assets, reason == BounceReason.ForeignOrigin ? 2 : 3);
                uint64 o = ghostOrigin[user];
                if (reason != BounceReason.ForeignOrigin) ++unexpectedReverts;
                else if (o == 0 || o == chain || o == DIRECT_ORIGIN) ++originMintViolations;
                ++foreignBounces;
                _lists[log.topics[1]].push(CascadeMessages.Payout(user, 0, assets));
            } else if (sig == Redeemed.selector) {
                address user = _topicAddress(log.topics[2]);
                (uint256 shares, uint256 assets) = abi.decode(log.data, (uint256, uint256));
                _onBurn(user, chain);
                burned += assets;
                _lists[log.topics[1]].push(CascadeMessages.Payout(user, shares, assets));
            } else if (sig == RedeemSkipped.selector) {
                _onSkip(_topicAddress(log.topics[2]), chain);
            } else if (sig == RedeemDeferred.selector) {
                ++redeemsDeferred;
                deferred = true;
            } else if (sig == PayoutBatchQueued.selector) {
                queuedKeys.push(log.topics[1]);
                doorOfKey[log.topics[1]] = i;
            }
        }
        if (burned != 0) _recordBurn(i, burned);
        if (deferred) _countDeferral(i);
        _resolveSent();
    }

    /// Before a close (or a request that closes the batch) of door `i`: what it sends, each open deposit's depositor,
    /// its ghost origin now and its amount (the door's own entry list, floored to rao), for the delivery to resolve. A
    /// record left unresolved is resolved first (as misses).
    function _snapshot(uint256 i) internal {
        _resolveSent();
        CascadeMessages.Entry[] memory e = _door(i).openDeposits();
        _sentChain = _chainOf(i);
        for (uint256 k; k < e.length; ++k) {
            _sent.push(Sent(e[k].user, ghostOrigin[e[k].user], e[k].amount - e[k].amount % RAO, 0));
        }
    }

    /// The delivery's `outcome` (1 a mint, 2 a ForeignOrigin bounce, 3 an Insolvent bounce) for `user`'s deposit of
    /// `assets`: it must be a deposit the close sent, of that amount, and its only outcome; else depositOutcomeMisses.
    function _markSent(address user, uint256 assets, uint8 outcome) internal {
        for (uint256 k; k < _sent.length; ++k) {
            if (_sent[k].user != user) continue;
            _sent[k].outcome = _sent[k].outcome == 0 ? outcome : 4;
            if (assets != _sent[k].amount) ++depositOutcomeMisses;
            return;
        }
        // a mint or a bounce for a deposit no close sent
        ++depositOutcomeMisses;
    }

    /// I-16 (b), after each delivery and after every step: every deposit the close sent came out minted or bounced,
    /// exactly one of the two (else depositOutcomeMisses), and one whose depositor's ghost origin was another chain's
    /// (neither 0, the door's chain nor DIRECT_ORIGIN) bounced ForeignOrigin (else foreignDepositsNotBounced); then the
    /// record is cleared.
    function _resolveSent() internal {
        uint64 chain = _sentChain;
        for (uint256 k; k < _sent.length; ++k) {
            Sent memory e = _sent[k];
            ++depositOutcomesChecked;
            if (e.outcome == 0 || e.outcome == 4) ++depositOutcomeMisses;
            bool foreign = e.origin != 0 && e.origin != chain && e.origin != DIRECT_ORIGIN;
            if (foreign && e.outcome != 2) ++foreignDepositsNotBounced;
        }
        delete _sent;
    }

    /// A delivery of door `i` that deferred a redeem while the global window, which the other door burned in today, had
    /// less than a redeem's minimum left: the global allowance holding one door back for the other's burns (counted).
    function _countDeferral(uint256 i) internal {
        Record storage g = _globalWindow;
        if (vm.getBlockTimestamp() >= uint256(g.start) + WINDOW || _globalDoors & (i == 0 ? 2 : 1) == 0) return;
        uint256 globalCap = Math.max(ghostBase() * ghostGlobalBps / 10_000, ghostFloor);
        if (_sub0(globalCap, g.burned) < MIN_REDEEM_VALUE) ++deferredByTheOtherDoor;
    }

    /// A door on `chain` minted for `user`: its ghost origin must be 0, `chain` or DIRECT_ORIGIN (I-16: never another
    /// chain's, which bounces); an origin of 0 becomes `chain`, and the vault's must read it.
    function _onMint(address user, uint64 chain) internal {
        uint64 o = ghostOrigin[user];
        if (o == 0) {
            ghostOrigin[user] = chain;
            ++firstMints;
            if (vaultLens.redeemOrigin(user) != chain) ++firstMintMisses;
        } else if (o == chain) {
            ++homeMints;
        } else if (o == DIRECT_ORIGIN) {
            ++directOriginMints;
        } else {
            ++originMintViolations;
        }
    }

    /// A door on `chain` burned for `user`: its ghost origin must be `chain` (I-16), and, if it ever deposited
    /// directly, its last origin change after its last direct deposit must name `chain` (I-17).
    function _onBurn(address user, uint64 chain) internal {
        if (ghostOrigin[user] != chain) ++originBurnViolations;
        uint256 direct = lastDirectSeq[user];
        if (direct != 0) {
            ++burnsAfterADirectDeposit;
            if (lastSetSeq[user] < direct || lastSetChain[user] != chain) ++directSharesBurnedByADoor;
        }
        ++burns;
    }

    /// A door on `chain` skipped `user`'s redeem: it must hold no shares or have another origin than `chain` (I-16:
    /// a door burns for its chain's holders). One redeem entry per user per batch, so its balance after the delivery is
    /// its balance at the skip.
    function _onSkip(address user, uint64 chain) internal {
        uint64 o = ghostOrigin[user];
        if (vault.balanceOf(user) == 0) ++skipsNoShares;
        else if (o == chain) ++originSkipViolations;
        else if (o == DIRECT_ORIGIN) ++skipsDirect;
        else ++skipsForeign;
    }

    /// I-15 at a burning delivery of door `i` that burned `x`: the handler's records of the door's window and the
    /// global one (each opens at the first burn WINDOW or more after it last opened) take `x`, and each must stay
    /// within its allowance on the ghost base, max(bps × base, floor) with the handler's record of the limits. Then
    /// the records against the vault's windows (the model's check), and the windows' states counted.
    function _recordBurn(uint256 i, uint256 x) internal {
        ++burningDeliveries[i];
        uint256 base_ = ghostBase();
        uint256 doorCap = Math.max(base_ * ghostBps / 10_000, ghostFloor);
        uint256 globalCap = Math.max(base_ * ghostGlobalBps / 10_000, ghostFloor);
        Record storage w = _doorWindows[i];
        Record storage g = _globalWindow;
        // casting to 'uint64' is safe because the test's clock is far below 2^64 seconds
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 now_ = uint64(vm.getBlockTimestamp());
        if (now_ >= uint256(w.start) + WINDOW) (w.start, w.burned) = (now_, 0);
        if (now_ >= uint256(g.start) + WINDOW) (g.start, g.burned, _globalDoors) = (now_, 0, 0);
        uint256 doorRest = _sub0(doorCap, w.burned);
        uint256 globalRest = _sub0(globalCap, g.burned);
        if (globalRest < doorRest) ++globalTighter;
        else if (doorRest < globalRest) ++doorTighter;
        if (base_ * ghostBps / 10_000 < ghostFloor) ++burnsAtTheFloor;
        w.burned += x;
        g.burned += x;
        if (w.burned > doorCap) ++doorWindowViolations;
        if (g.burned > globalCap) ++globalWindowViolations;
        if (Math.min(_sub0(doorCap, w.burned), _sub0(globalCap, g.burned)) < MIN_REDEEM_VALUE) ++windowsSpent;
        uint256 doors = _globalDoors | (i == 0 ? 1 : 2);
        if (doors == 3 && _globalDoors != 3) ++globalDaysWithBothDoors;
        _globalDoors = doors;
        (uint64 start, uint256 burnedThere) = vaultLens.burnWindows(peers[i]);
        if (start != w.start || burnedThere != w.burned) ++windowRecordMismatches;
        (start, burnedThere) = vaultLens.burnWindows(GLOBAL_WINDOW);
        if (start != g.start || burnedThere != g.burned) ++windowRecordMismatches;
    }

    // ---- the model's checks, after every step ----

    /// Every close's deposits resolved (I-16 (b), _resolveSent), the vault's origins against the ghost's (I-16), its
    /// booked stake, ramp and clock against the ghost ledger (the base I-15 rests on), and its outflow limits against the
    /// handler's record of them.
    function _checkGhosts() internal {
        // a close's deposits not resolved by a delivery the handler read
        _resolveSent();
        for (uint256 k; k < ACTORS; ++k) {
            if (vaultLens.redeemOrigin(actors[k]) != ghostOrigin[actors[k]]) ++originMismatches;
        }
        if (
            vaultLens.bookedStake() != ghostBooked || vaultLens.rampingStake() != ghostRamping
                || vaultLens.lastStakeAt() != ghostLastStakeAt
        ) ++ghostLedgerMismatches;
        if (
            vaultLens.maxDailyOutflowBps() != ghostBps || vaultLens.minDailyOutflow() != ghostFloor
                || vaultLens.globalOutflowBps() != ghostGlobalBps
        ) ++limitMismatches;
    }

    // ---- views ----

    function queuedCount() external view returns (uint256) {
        return queuedKeys.length;
    }

    /// Batch `key`'s payout list as the handler keeps it (not in the fuzzer's selectors).
    function listOf(bytes32 key) external view returns (CascadeMessages.Payout[] memory) {
        return _lists[key];
    }

    /// The handler's record of door `i`'s window and the global one (not in the fuzzer's selectors).
    function windowOf(uint256 i) external view returns (uint64 start, uint256 burned) {
        Record memory w = i == 2 ? _globalWindow : _doorWindows[i];
        return (w.start, w.burned);
    }

    // ---- internal ----

    /// Actor `a`'s home door: the launch door for alice and bob, the second door for carol and dave, by its ghost origin
    /// (or `seed`'s bit 0 when it has none) for erin, the direct holder.
    function _homeDoor(address a, uint256 seed) internal view returns (uint256) {
        if (a == actors[0] || a == actors[1]) return 0;
        if (a == actors[2] || a == actors[3]) return 1;
        uint64 o = ghostOrigin[a];
        return o == baseChain ? 0 : o == secondChain ? 1 : seed % 2;
    }

    /// The first actor from `seed` on with a credit at door `d`, or none.
    function _claimant(CascadeFrontDoor d, uint256 seed) internal view returns (address) {
        for (uint256 k; k < ACTORS; ++k) {
            address a = actors[(seed % ACTORS + k) % ACTORS];
            if (d.claimable(a) != 0) return a;
        }
        return address(0);
    }

    /// Door `i`: 0 the launch door, 1 the second.
    function _door(uint256 i) internal view returns (CascadeFrontDoor) {
        return i == 0 ? fd : fd2;
    }

    function _chainOf(uint256 i) internal view returns (uint64) {
        return i == 0 ? baseChain : secondChain;
    }

    function _doorIndexOf(address d) internal returns (uint256) {
        if (d == address(fd)) return 0;
        if (d != address(fd2)) ++unexpectedReverts;
        return 1;
    }

    /// An exit call's refusal: one that reverted EnforcedPause breaks I-20 (counted, and unexpected); otherwise
    /// whether it is the refusal `expect` predicted.
    function _exitRefused(bytes memory reason, bytes4 expect) internal returns (bool) {
        if (_selector(reason) == Pausable.EnforcedPause.selector) ++exitsRefusedWhilePaused;
        return _refused(reason, expect);
    }

    /// The first actor from `seed` on with a non-zero `amountOf`, or (actors[seed], 0).
    function _actorWith(uint256 seed, function(address) internal view returns (uint256) amountOf)
        internal
        view
        returns (address actor, uint256 amount)
    {
        for (uint256 k; k < ACTORS; ++k) {
            actor = actors[(seed % ACTORS + k) % ACTORS];
            amount = amountOf(actor);
            if (amount != 0) return (actor, amount);
        }
        return (actors[seed % ACTORS], 0);
    }

    /// The first actor from `seed` on with shares and no request in door `d`'s open batch, and its shares.
    function _actorWithout(CascadeFrontDoor d, uint256 seed) internal view returns (address actor, uint256 amount) {
        for (uint256 k; k < ACTORS; ++k) {
            actor = actors[(seed % ACTORS + k) % ACTORS];
            if (d.redeemOf(actor) != 0) continue;
            amount = vault.balanceOf(actor);
            if (amount != 0) return (actor, amount);
        }
        return (actors[seed % ACTORS], 0);
    }

    /// The first actor from `seed` on with an entry in door `d`'s open batch (a deposit, or a redeem), and its size.
    function _actorWithEntry(CascadeFrontDoor d, uint256 seed, bool isDeposit)
        internal
        view
        returns (address actor, uint256 amount)
    {
        for (uint256 k; k < ACTORS; ++k) {
            actor = actors[(seed % ACTORS + k) % ACTORS];
            amount = isDeposit ? d.depositOf(actor) : d.redeemOf(actor);
            if (amount != 0) return (actor, amount);
        }
        return (actors[seed % ACTORS], 0);
    }

    function _shares(address a) internal view returns (uint256) {
        return vault.balanceOf(a);
    }

    /// Swap-and-pop.
    function _dropKey(bytes32 key) internal {
        uint256 n = queuedKeys.length;
        for (uint256 k; k < n; ++k) {
            if (queuedKeys[k] == key) {
                queuedKeys[k] = queuedKeys[n - 1];
                queuedKeys.pop();
                break;
            }
        }
        delete _lists[key];
    }

    /// The bounced deposits (0 shares) among list[from:to].
    function _bounces(CascadeMessages.Payout[] memory list, uint256 from, uint256 to)
        internal
        pure
        returns (uint256 n)
    {
        for (uint256 k = from; k < to; ++k) {
            if (list[k].shares == 0) ++n;
        }
    }
}
