// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeMessages} from "../../../src/libraries/CascadeMessages.sol";
import {CascadeMath} from "../../../src/libraries/CascadeMath.sol";
import {CcipAdapterBase} from "../../../src/adapters/CcipAdapterBase.sol";
import {CcipBittensorAdapter} from "../../../src/adapters/CcipBittensorAdapter.sol";
import {
    CapExceeded,
    NotEligible,
    PrimaryBridgeDisabled,
    StakeMissing,
    VaultInsolvent
} from "../../../src/CascadeErrors.sol";
import {Client} from "../../../src/vendor/ccip/Client.sol";
import {GLOBAL_WINDOW, MIN_REDEEM_VALUE} from "../../../src/CascadeConstants.sol";
import {Deposited, RedeemDeferred, Redeemed} from "../../../src/CascadeEvents.sol";
import {DoorState, PayoutBatch} from "../../../src/CascadeTypes.sol";
import {MockRouter} from "../../mocks/MockRouter.sol";
import {AdapterHandler} from "./AdapterHandler.sol";

/// @notice The exits campaign's handler (Task 42, from the stuck-money review's invariant; the founder's priority:
/// "stuck money"): AdapterHandler's whole world and actions (both CCIP adapters over two mock routers, ForeverMoney's
/// AlphaVault, the vault and the front door, every park function by anyone), with the users typed as the review types
/// them: alice and carol are Base EOAs (BE: they may also sign on Bittensor, so they exit directly too), bob is a Base
/// smart wallet (SW: Base calls only, so the door is his only way out), and dave a Bittensor EOA (TE: direct deposits
/// and exits only, `taoDeposit`, `taoExit`). The BEs' direct exits are `directExit`; `relayShortGas` delivers a message
/// in flight with too little gas, a CCIP FAILURE that anyone re-executes.
///
/// Every delivery to the vault is read (the hook `_afterVaultDelivery`) for the door's burn rules:
/// - no burn behind a closed rail (S-H1): no Redeemed while the vault's primary cannot send payouts (ForeverMoney paused,
///   a migration announced or finished: `canSendPayouts()` false), `burnsBehindAClosedRail`;
/// - no unredeemable remainder (S-L1): after a door burn of a holder that asked for at least its whole balance and held
///   no fresh shares, what it keeps is worth 0 or at least MIN_REDEEM_VALUE, `unredeemableRemainders`;
/// - every clip has its cause: such a burn that leaves the holder shares burned the entry limit's worth (maxEntryValue,
///   less MIN_REDEEM_VALUE where S-L1 keeps that much) or spent the day's allowance (what the windows can still burn
///   after it, at its own point in the delivery, is at most MIN_REDEEM_VALUE), each to within 2 rao and one share's
///   value (a clip floors to whole shares, so its burn can fall short of the limit or the allowance by that much),
///   `unexplainedClips`; `crowdTheAllowance` aims two holders' requests at the allowance.
/// The probe's routine makes such deliveries too: what its deliveries count is carried out of its snapshot.
///
/// The probe (`probeExits`, in a snapshot reverted after it, so it changes nothing in the run): one blocker drawn from
/// the scenarios below and applied on top of whatever the run reached (`Scenario`); then the non-owner routine
/// (`_routine`): only the users, anyone and the keeper's routine work act, over about 19 days: CCIP relays everything in
/// flight (a failure re-executed), anyone lists the hotkey a validator's swap moved the stake to (I-6's way back), the
/// users cancel their open deposits, exit directly (the BEs and the TE; with acceptMissing while stake is missing, their
/// consent) and ask the door to redeem everything (the BEs and the SW), the keeper closes, anyone delivers parks and,
/// past PARK_TIMEOUT, refunds them, anyone sends every due payout chunk (with the whole fee), and the users claim on
/// Base; four rounds of requests a day or more apart, so the door hold passes; then, after the last delivery, the
/// direct exits once more (the BEs and the TE, while one goes: a delivery after a holder's last exit can lift shares
/// it could not redeem to a whole rao). Then every user's money is judged against the table (`_judge`), from the state
/// at the end:
/// - each holding left: each kind of holding, for each user type, has its paths out, and each path its closers. A
///   holding left with a path open (a new owner-only exit, or one that needs anyone's act the routine does not make) is
///   an exit failure. The amount-dependent closers are the routine's own observations where they can be: the day's
///   allowance and the entry limit by the hold the last round's request met (`_heldRound`), not by a model; a chunk's
///   or a direct exit's refusal by VaultModel's model, which a clean probe (no blocker drawn, no closer at the end, the
///   chain's minimum at its default and the rail converting) must never need (`cleanModelExcuses`); shares worth less
///   than MIN_REDEEM_VALUE are the holder's own choice only if the routine did not burn them down to that from a
///   full request (`remainderFailures`, beside S-L1's check at the burn; a partial request's remainder, and one fresh
///   shares cut, are the holder's own);
/// - each holding a closer the table says holds the whole kind (the vault's pause, the door's state, the vault's
///   primary, stake lost, the rail closed) that fell anyway is a table over-claim;
/// - the users received it: what left a user's holdings reached its wallet, its bridged TAO on Base and its native
///   TAO with what it paid in request fees, less RECEIPT_SLACK (1 rao for each burn, payout and exit the routine
///   makes, 64 in all), the walk's SHORTFALL_TOLERANCE for each of its direct exits (what a direct exit's walk may
///   leave unmet: one a round and one in the last direct exits, LAST_ROUND + 1), and what each mint of its money in
///   the routine rounded away: a mint floors to whole shares, so a deposit a minted at the delivery's price p
///   (minted = floor(a / p), so p > a / (minted + 1)) loses
///   a - minted x p < a / (minted + 1), at most one share's value ((totalAssets() + 1) / (totalSupply + 1e6), rounded
///   up, read after the delivery): under a rao a mint normally, but about assets / 1e6 at a supply of 0 that holds
///   assets, as the stake a consenting last holder forfeited at the floor price, once relisted (the long run's
///   counterexamples); the chain's removal fee is 0 in this world, and every payout is sent with the whole fee, so its
///   entries are charged nothing (`receiptShortfalls`); and the bridged TAO of `anyone` and of the door's treasury, who
///   never own a user's money and never pay one in bridged TAO, did not move (`outsideReceipts`: neither a user's
///   money reaching them nor theirs reaching a user and masking its shortfall).
/// All asserted 0, so the table is exactly what the contracts do and every exit pays its own user.
///
/// The table (spec §3.5 and the stuck-money review's state table; the README's "Exit liveness" carries it). The
/// whole-kind closers and the door's are one encoding (`_wholeMask`, `_doorMask`), which the table's rows and the
/// over-claim check both read:
/// | holding (state) | user type | paths out | closers (who clears them) |
/// |---|---|---|---|
/// | a deposit in the open batch (1) | BE, SW | cancelDeposit, the depositor, from five minutes after its last deposit, at once while the door is paused or its primary disabled (R11, R12; a cancel refused within them is made again at the routine's next round, unless the batch took the deposit first) | none |
/// | a batch in flight (3), a payout or refund in flight (9), a CCIP FAILURE of either | all | CCIP executes it, or anyone re-executes the FAILURE | none modelled (the lane is Chainlink's); a payout through a vault primary the door never activated stays FAILURE until the owner's activateBridge on the door (7 days: I-28's residual, GovernanceLiveness's invariant_twoChainLiveness, which counts that class, and its pin test_I28_aOneSidedRailMigration; no scenario here switches a primary) |
/// | a parked delivery, tokens (6b) | BE, SW | refundParked by anyone past PARK_TIMEOUT, the tokens back | none |
/// | a parked delivery, native TAO (6a) | BE, SW | deliverParked by anyone; refundParked by anyone past PARK_TIMEOUT | delivery: the vault paused, the door not active on the vault, the vault's primary disabled (owner), stake missing that listing cannot bring back (owner: a write-off), the vault at a supply of 0 underwater; and the refund: ForeverMoney halted, migrating or finished, the chain's minimum above the park, the token cushion short (ForeverMoney, the chain's sudo, the founder) |
/// | shares (7) | BE | redeemDirect; the door | the direct exit: the vault paused (owner), the walk refused (the chain's minimum: UnstakeShort); and the door as for SW |
/// | shares (7) | SW | a door request, closed, delivered, burned | the vault paused, the door not active on the vault, the vault's or the door's primary disabled (owner), stake missing that listing cannot bring back (owner), the rail closed (ForeverMoney halted, migrating or finished: redeems deferred, not burned), the last request clipped to the entry limit or deferred by the day's spent allowance (bounded: the next batch, the next window), shares worth less than MIN_REDEEM_VALUE the holder kept (its own choice of what to ask) |
/// | shares (7) | TE | redeemDirect | the vault paused (owner), the walk refused |
/// | a queued payout, or a bounce (8, 5) | all | processPayouts by anyone after the delay | the vault paused, the door not active on the vault, the vault's primary disabled (owner; for shares the owner's cancelPayoutBatch, for a bounce nothing), the chunk below the chain's minimum, its walk refused, the send's rail closed or short (ForeverMoney, sudo, the founder) |
/// | a credit on Base (10) | all | claim, at once | none |
///
/// The owner-only exits of the stuck-money review's table are the rows whose closers only the owner clears: the vault
/// paused; the launch door removed (a Reopen, 7 days; after the guardian's removal 15); a primary disabled (a Reopen, 7
/// days, or a switch); stake truly lost (a write-off, 7 days); a queued payout behind a closed rail (the owner's
/// cancel; a bounce has none); and I-28's payout sent through a vault primary the door never activated (the door's
/// activateBridge, 7 days). ForeverMoney's halt is bounded (its guardian's MAX_PAUSE, its operator's hold) and clears
/// inside the routine; a door pause closes no exit; a validator's swap is anyone's to undo.
///
/// Not reached here, and where it is held instead: a bounce (this world has one door and no booked loss, so no deposit
/// is ever foreign or meets a vault below half the launch price: the doors campaign's foreign bounces and its
/// bouncesCarried, EndToEnd's test_insolventVaultBouncesDepositBackToBase and VaultDelivery's insolvency pins pay them
/// out); I-28's FAILURE (the GovernanceLiveness campaign's test_I28_aOneSidedRailMigration).
///
/// The scenarios (`Scenario`): none, the vault paused (the guardian), the door paused (the guardian), the launch door
/// removed (the owner, or the guardian), the vault's primary disabled, the door's primary disabled (the guardian),
/// ForeverMoney held two days (its operator), its migration announced, or announced, executed and finished, the stake
/// swapped to an unlisted hotkey, stake lost (just past the tolerance), the chain's minimum raised to 5 TAO, the token
/// cushion drained with ForeverMoney 1 rao short.
///
/// Expected refusals of the actions added here (any other is unexpected): directExit and taoExit EnforcedPause while
/// paused, ZeroAmount and UnstakeShort (the walk's, VaultModel's _exitPlan); taoDeposit EnforcedPause, StakeMissing,
/// VaultInsolvent (below half the launch price, or underwater) and CapExceeded (above maxTotalAssets), in that order,
/// as the vault's state says; relayShortGas's delivery fails (DeliveryFailed, out of gas) and changes nothing.
contract ExitHandler is AdapterHandler {
    enum Scenario {
        None,
        VaultPaused,
        DoorPaused,
        DoorRemovedByOwner,
        DoorRemovedByGuardian,
        VaultRailOff,
        DoorRailOff,
        FmHeld,
        FmNotice,
        FmFinished,
        StakeSwapped,
        StakeLost,
        FloorRaised,
        CushionShort
    }

    uint256 internal constant SCENARIOS = 14;
    /// The users, by type: 0 and 2 Base EOAs, 1 the smart wallet (AdapterHandler's actors), 3 the Bittensor EOA.
    uint256 internal constant USERS = 4;
    uint256 internal constant SW = 1;
    uint256 internal constant TE = 3;
    /// The kinds of holding the probe judges.
    uint256 internal constant K_DEPOSIT = 0;
    uint256 internal constant K_PARK_TOKENS = 1;
    uint256 internal constant K_PARK_NATIVE = 2;
    uint256 internal constant K_SHARES = 3;
    uint256 internal constant K_QUEUED = 4;
    uint256 internal constant K_CLAIMABLE = 5;
    uint256 internal constant K_IN_FLIGHT = 6;
    uint256 internal constant KINDS = 7;
    /// The routine's rounds of requests (its last one's holds explain a remainder left at the end). A user exits
    /// directly at most once a round and once in the last direct exits: LAST_ROUND + 1 direct exits in all.
    uint256 internal constant LAST_ROUND = 4;
    /// The judge's slack on what reached a user's wallet (see the contract's notes): 64 rao of rounding.
    uint256 internal constant RECEIPT_SLACK = 64 * RAO;
    /// The gas relayShortGas delivers with: too little for any adapter's ccipReceive.
    uint256 internal constant SHORT_GAS = 3_000;

    /// The Bittensor EOA.
    address public immutable taoEoa;
    bytes32 public immutable doorPeer;

    // ---- what the invariants read ----

    /// S-H1: Redeemed logged while the vault's primary could not send payouts.
    uint256 public burnsBehindAClosedRail;
    /// S-L1: a door burn of a holder that asked for all of its shares, with none fresh, leaving it more than 0 and less
    /// than MIN_REDEEM_VALUE.
    uint256 public unredeemableRemainders;
    /// The probe: holdings left with a path open (exit failures), and users the table called stuck who got out anyway
    /// (over-claims); the last of each: (kind, user, scenario, closers).
    uint256 public exitFailures;
    uint256 public tableOverclaims;
    bytes32 public lastExitFailure;
    bytes32 public lastOverclaim;
    /// A door burn of a holder that asked for all of its shares (none fresh) that left it shares with no cause: neither
    /// the entry limit's worth burned nor the day's allowance spent.
    uint256 public unexplainedClips;
    /// The probe: users whose shares the routine burned down to less than MIN_REDEEM_VALUE (worth at least that at the
    /// start, none fresh at the burn), which the table would otherwise call their own choice.
    uint256 public remainderFailures;
    /// The probe: users whose wallet did not receive what left their holdings, less RECEIPT_SLACK (the last one packed:
    /// user, scenario, what left, what arrived).
    uint256 public receiptShortfalls;
    bytes32 public lastReceiptShortfall;
    /// The probe, clean (no blocker drawn, no closer at the end, the chain's minimum at its default, the rail
    /// converting): holdings worth at least MIN_REDEEM_VALUE that VaultModel's refusal models (a chunk's, a direct
    /// exit's walk) explained anyway.
    uint256 public cleanModelExcuses;

    // ---- reach ----

    uint256 public directExits;
    uint256 public directExitsRefused;
    uint256 public taoDeposits;
    uint256 public taoExits;
    uint256 public burnsChecked;
    /// The routine's state, inside the probe's snapshot: whether it runs, its round, each user's last held request
    /// (the round, and why: 10 the day's allowance, 12 the entry limit), whether a burn of its was cut by fresh shares,
    /// and the request fees each paid.
    bool internal _inRoutine;
    uint256 internal _round;
    uint256[USERS] internal _heldRound;
    uint256[USERS] internal _heldWhy;
    bool[USERS] internal _freshCut;
    uint256[USERS] internal _feesPaid;
    /// Inside the snapshot too: each user whose own partial request (asking for less than its balance) a routine
    /// delivery burned leaving it shares (the re-review's N-1: what it keeps is its own choice of what to ask), and
    /// the receipt check's allowance for each user's mints in the routine, one share's value each (see `_judge`).
    bool[USERS] internal _ownPartial;
    uint256[USERS] internal _mintSlack;
    /// The chain's minimum stake at the start (the clean probe's default).
    uint256 internal immutable _defaultMinStake;
    /// Each user's queued entries after the routine's first relay (the closes in flight delivered, no chunk sent yet):
    /// the over-claim check holds the queued kind to the larger of this and the start (written inside the snapshot).
    uint256[USERS] internal _queuedAfterRelay;
    /// The over-claim's record (`_noteHeld`): per user, for its shares (0) and its queued payouts (1), whether a
    /// whole-kind closer of them is on, the most held since it came on and the closers last read on; and whether the
    /// kind fell below that most during an on-phase that ended before the routine did, with that phase's closers.
    bool[2][USERS] internal _heldOn;
    uint256[2][USERS] internal _heldMost;
    uint256[2][USERS] internal _heldMask;
    bool[2][USERS] internal _fellWhileOn;
    uint256[2][USERS] internal _fellMask;
    /// Users the over-claim check held a queued holding for under a whole-kind closer (that check's reach).
    uint256 public queuedHeldChecks;
    uint256 public fullRequestBurns;
    /// S-L1's keep reached: a full request's clip that left the holder about MIN_REDEEM_VALUE (at least it, within 2
    /// rao more), and the targeted draws aimed at it.
    uint256 public keepsHeld;
    uint256 public keepDraws;
    /// Mints at a share price above 1 rao (a supply of 0 holding assets, or near it: each such mint rounds away up to
    /// one share's value), and the probes where taoBase reached an outsider (anyone, the door's treasury) during the
    /// routine (the receipt check's other side).
    uint256 public coarseMints;
    uint256 public outsideReceipts;
    uint256 public deferralsWhileClosed;
    uint256 public probes;
    mapping(uint256 => uint256) public probesOf;
    /// Holdings the probe judged, by kind: left and explained by a closer (stuck), or gone (out).
    mapping(uint256 => uint256) public stuckOf;
    mapping(uint256 => uint256) public outOf;
    /// Holdings left, by what explained them.
    uint256 public stuckByPause;
    uint256 public stuckByDoorGone;
    uint256 public stuckByVaultRail;
    uint256 public stuckByDoorRail;
    uint256 public stuckByStakeLost;
    uint256 public stuckByRailClosed;
    uint256 public stuckByRail;
    uint256 public stuckByWalk;
    uint256 public stuckByAllowance;
    uint256 public stuckByOwnChoice;
    uint256 public smartWalletOuts;
    uint256 public stuckByClip;
    /// Probes with money held at the start and no blocker (see cleanModelExcuses); messages relayShortGas left in CCIP
    /// FAILURE; probes that judged a user's message in FAILURE at the start; full-request burns the entry limit clipped
    /// and the allowance clipped or deferred.
    uint256 public cleanProbes;
    uint256 public shortGasFailures;
    uint256 public failuresJudged;
    uint256 public entryClips;
    uint256 public allowanceHolds;
    /// crowdTheAllowance's draws that sent both requests.
    uint256 public allowanceDraws;

    /// The probe's scenario, for the judge's record.
    Scenario internal _scenario;
    /// Test-only (no action sets it): the routine leaves the users' credits on Base unclaimed, so the judge must find
    /// each one an exit failure (the pin that shows the judge can fail).
    bool public skipClaims;

    function setSkipClaims(bool on) external {
        skipClaims = on;
    }

    /// Test-only (no action sets it): each claim the routine makes is moved on to a stranger, so the money leaves the
    /// user's holdings without reaching its wallet (the pin that shows the receipt check can fail).
    bool public divertClaims;

    function setDivertClaims(bool on) external {
        divertClaims = on;
    }

    constructor(System memory s, Parts memory p) AdapterHandler(s, p) {
        taoEoa = makeAddr("exits campaign: dave, a Bittensor EOA");
        vm.deal(taoEoa, 1_000 ether);
        _trackAccount(taoEoa);
        doorPeer = s.vaultLens.peerId(p.baseChain, address(s.fd));
        _defaultMinStake = staking.getDefaultMinStake();
    }

    // ==== the users' own actions ====

    /// @dev A Base EOA (alice or carol) exits directly with 1 to all of its shares (all one draw in four), consenting
    /// to the floor price while stake is missing.
    function directExit(uint256 seed, uint256 shares) external step checked {
        address u = actors[seed % 2 == 0 ? 0 : 2];
        _directExit(u, seed >> 1, shares, false);
    }

    /// @dev The Bittensor EOA deposits 1 to 50 TAO directly (its origin DIRECT_ORIGIN: no door burns its shares).
    function taoDeposit(uint256 amount) external step checked {
        amount = bound(amount, 1e18 / RAO, MAX_DEPOSIT / RAO) * RAO;
        bytes4 expect = _depositRefusal(amount);
        _readLogs();
        vm.prank(taoEoa);
        try vault.depositDirect{value: amount}() {
            _went(expect, "taoDeposit: refusal went");
            ++taoDeposits;
        } catch (bytes memory reason) {
            _dropLogs();
            if (_selector(reason) != expect) _tag("taoDeposit");
        }
    }

    /// depositDirect's refusal of `amount` now, in its order: EnforcedPause; StakeMissing; VaultInsolvent below half
    /// the launch price or underwater (at a supply of 0 after the schedule's write-down, _underwater's); CapExceeded
    /// above maxTotalAssets.
    function _depositRefusal(uint256 amount) internal view returns (bytes4) {
        if (vault.paused()) return Pausable.EnforcedPause.selector;
        if (vaultLens.stakeMissing()) return StakeMissing.selector;
        uint256 assets = vaultLens.totalAssets();
        if (assets * 2_000_000 < vault.totalSupply() || _underwater()) return VaultInsolvent.selector;
        if (assets + amount > vaultLens.maxTotalAssets()) return CapExceeded.selector;
        return 0;
    }

    /// @dev The Bittensor EOA exits directly with 1 to all of its shares.
    function taoExit(uint256 seed, uint256 shares) external step checked {
        _directExit(taoEoa, seed, shares, true);
    }

    /// A direct exit of `u`'s shares (all when `seed` is 0 mod 4), its refusal predicted by the vault's pause and
    /// VaultModel's _exitPlan; with acceptMissing while stake is missing (the holder's consent).
    function _directExit(address u, uint256 seed, uint256 shares, bool tao) internal {
        uint256 held = vault.balanceOf(u);
        if (held == 0) return;
        shares = seed % 4 == 0 ? held : bound(shares, 1, held);
        bytes4 expect = _directRefusal(shares);
        // read before the prank, which the next call (a view's too) would take
        bool missing = vaultLens.stakeMissing();
        _readLogs();
        vm.prank(u);
        try vault.redeemDirect(shares, missing) {
            _went(expect, "directExit: refusal went");
            if (tao) ++taoExits;
            else ++directExits;
        } catch (bytes memory reason) {
            _dropLogs();
            if (!_refused(reason, expect)) _tag("directExit");
            else ++directExitsRefused;
        }
    }

    /// redeemDirect's refusal for `shares` now: EnforcedPause; then the walk's (_exitPlan: ZeroAmount, UnstakeShort).
    function _directRefusal(uint256 shares) internal view returns (bytes4) {
        if (vault.paused()) return Pausable.EnforcedPause.selector;
        uint256 out = CascadeMath.assetsForRedeem(shares, vaultLens.totalAssets(), vault.totalSupply());
        out -= out % RAO;
        return _exitPlan(_availableAt(vaultLens.pendingPayouts()), out).refusal;
    }

    /// @dev A message in flight either way (a user's batch, payout or refund) delivered with SHORT_GAS: the adapter
    /// runs out of gas, the router records a FAILURE and nothing moves (the mint reverts with the call), so anyone
    /// re-executes it later with the gas the message asked for (the probe's routine does).
    function relayShortGas(uint256 seed) external step checked {
        bool toBase = seed % 2 == 1;
        (bool found, uint256 i) = _pending(toBase ? _toBase : _toBittensor, seed >> 1);
        if (!found || _msgs[i].state != State.InFlight) return;
        MockRouter from = toBase ? routerBit : routerBase;
        MockRouter to = toBase ? routerBase : routerBit;
        MockRouter.Sent memory sent = from.sendAt(_msgs[i].sendIndex);
        Client.EVMTokenAmount[] memory t = new Client.EVMTokenAmount[](sent.tokenAmounts.length);
        for (uint256 k; k < t.length; ++k) {
            t[k] = Client.EVMTokenAmount(address(to.token()), sent.tokenAmounts[k].amount);
        }
        Client.Any2EVMMessage memory m = Client.Any2EVMMessage(
            sent.messageId,
            toBase ? bitSelector : baseSelector,
            abi.encode(toBase ? address(adapterBit) : address(adapterBase)),
            sent.data,
            t
        );
        _readLogs();
        (bool called, bool ok,) = to.deliver(toBase ? address(adapterBase) : address(adapterBit), m, SHORT_GAS);
        if (!called || ok) {
            _tag("relayShortGas: delivered");
            return;
        }
        _dropLogs();
        _msgs[i].state = State.Failed;
        ++shortGasFailures;
    }

    /// @dev S-L1's keep, aimed at (a targeted draw, the Task 42 review's I-3): the smart wallet's holding is topped up
    /// at the door to the entry limit and half of MIN_REDEEM_VALUE (the deposit closed and delivered), a day passes
    /// (the door hold, a fresh window), and it asks the door for everything: the clip to the entry limit would leave it
    /// under MIN_REDEEM_VALUE, so the burn must keep it that much (S-L1, the burn rules' check). A no-op where the
    /// entry limit is above what one deposit may be (the fixture's 2,000 TAO), or the top-up below the door's minimum.
    function nearTheEntryLimit(uint256 seed) external step checked {
        uint256 limit = vaultLens.maxEntryValue();
        if (limit > MAX_DEPOSIT) return;
        address u = actors[SW];
        uint256 v = _value(vault.balanceOf(u));
        uint256 target = limit + MIN_REDEEM_VALUE / 2;
        if (v >= target) return;
        uint256 need = (target - v) / RAO;
        if (need * RAO < fd.minDeposit() || need * RAO > taoBase.balanceOf(u)) return;
        // AdapterHandler's deposit seeds: SW is actor 1; 1 picks the small branch (to 1 TAO), 4 the large
        bool small = need * RAO < 1e18;
        if (!_deposit(small ? 1 : 4, need)) return;
        _closeRelay();
        _warp(STAKE_RAMP + 1 hours, doorBlockTime);
        // all of its shares (seed 1: AdapterHandler's whole-balance draw)
        if (!_request(1, 0)) return;
        _closeRelay();
        ++keepDraws;
        seed;
    }

    /// @dev The day's allowance, aimed at (a targeted draw, Task 42's fix round 3, I-1): two matured door holders (the
    /// Base EOAs, in the seed's order) ask the door in one batch, the first for t (three quarters of what the windows
    /// allow once they start afresh, at most the entry limit less MIN_REDEEM_VALUE: all of its shares when topped up to
    /// it, else t's worth) and the second for all of its shares, topped up to the whole allowance and so worth more
    /// than any rest the first leaves: the first burns whole, and the second is clipped by the allowance, which its
    /// burn then spends (`allowanceHolds`, the burn rules' cause of the clip). A day passes first, and again after any
    /// top-up (the door hold; the windows start afresh). A no-op while the vault's primary cannot send payouts, where
    /// the second's clip would be the entry limit's (the rest t leaves within MIN_REDEEM_VALUE of the limit), or a
    /// top-up or a request is out of reach.
    function crowdTheAllowance(uint256 seed) external step checked {
        if (!adapterBit.canSendPayouts()) return;
        uint256 one = seed % 2 == 0 ? 0 : 2;
        uint256 two = 2 - one;
        uint256 limit = vaultLens.maxEntryValue();
        _closeRelay();
        _warp(STAKE_RAMP + 1 hours, doorBlockTime);
        uint256 r = _doorRest();
        uint256 t = Math.min(r * 3 / 4, limit - MIN_REDEEM_VALUE);
        if (r < 8 * MIN_REDEEM_VALUE || r - t + 2 * MIN_REDEEM_VALUE >= limit) return;
        // each top-up its own batch (one message's value stays under the launch's 15 TAO cap)
        bool topped = _topUpTo(one, t);
        if (topped) _closeRelay();
        // the second holds the whole allowance: clipped to whatever the first leaves, and spending it
        if (_topUpTo(two, r + 3 * MIN_REDEEM_VALUE)) {
            topped = true;
            _closeRelay();
        }
        if (topped) {
            _warp(STAKE_RAMP + 1 hours, doorBlockTime);
            r = _doorRest();
            t = Math.min(r * 3 / 4, limit - MIN_REDEEM_VALUE);
        }
        uint256 vOne = _value(vault.balanceOf(actors[one]));
        bool whole = vOne <= t;
        uint256 first = whole ? vOne : t;
        uint256 rest = _sub0(r, first);
        if (
            first < MIN_REDEEM_VALUE || rest < 2 * MIN_REDEEM_VALUE || rest + 2 * MIN_REDEEM_VALUE >= limit
                || _value(vault.balanceOf(actors[two])) < rest + 2 * MIN_REDEEM_VALUE
        ) return;
        uint256 shares = whole ? 0 : CascadeMath.sharesForDeposit(t, vaultLens.totalAssets(), vault.totalSupply());
        // AdapterHandler's request seeds: actor k asks for all of its shares, k + ACTORS for `shares`
        if (!_request(whole ? one : one + ACTORS, shares)) return;
        if (!_request(two, 0)) return;
        _closeRelay();
        ++allowanceDraws;
    }

    /// Tops door holder `k`'s holding up to `target` at the door (the caller closes and delivers it): whether it
    /// deposited (not when it holds that much already, or the top-up is above one deposit or its balance).
    function _topUpTo(uint256 k, uint256 target) internal returns (bool) {
        uint256 v = _value(vault.balanceOf(actors[k]));
        if (v >= target) return false;
        uint256 need = Math.max((target - v) / RAO + 1, fd.minDeposit() / RAO);
        if (need * RAO > MAX_DEPOSIT || need * RAO > taoBase.balanceOf(actors[k])) return false;
        // AdapterHandler's deposit seeds: k picks the small branch (to 1 TAO), k + ACTORS the large
        return _deposit(need * RAO < 1e18 ? k : k + ACTORS, need);
    }

    // ==== the burn rules (S-H1, S-L1), at every delivery ====

    /// After each delivery of batch `i` to the vault: every Redeemed, while the rail was closed, is a burn behind it;
    /// and a holder that asked for at least its whole balance, with no fresh shares, keeps 0 or at least
    /// MIN_REDEEM_VALUE (at the price after the burn, which a burn only raises), and keeps any shares only for a cause:
    /// the entry limit's worth burned, or the day's allowance spent. Inside the probe's routine each user's last held
    /// request is recorded (a clip, or a deferral with the allowance spent), and a burn that fresh shares cut.
    function _afterVaultDelivery(uint256 i, Vm.Log[] memory logs) internal override {
        // the rail is closed while the vault's primary is disabled too (R6 D), whatever the adapter's own view says
        bool open_ = vaultLens.bridgeEnabled(vaultLens.primaryBridge()) && adapterBit.canSendPayouts();
        (,, CascadeMessages.Entry[] memory redeems) = CascadeMessages.decodeBatch(_body[i]);
        // what the windows could still burn before this delivery: what they can after it and its burns (every burn
        // came off both), so each clip and deferral is judged at its own point in the delivery's order (the
        // re-review's M-6), not by what the whole delivery left
        uint256 rest = _doorRest();
        for (uint256 k; k < logs.length; ++k) {
            Vm.Log memory log = logs[k];
            if (log.topics.length < 3 || log.topics[1] != _msgs[i].batchKey || !_isVaultLog(log, Redeemed.selector)) {
                continue;
            }
            (, uint256 o) = abi.decode(log.data, (uint256, uint256));
            rest += o;
        }
        // one share's value after the delivery: at least the price p the delivery's mints and burns used (mints and
        // floors only raise the price), so at least what any of them rounded away by flooring to whole shares
        uint256 share = Math.mulDiv(vaultLens.totalAssets() + 1, 1, vault.totalSupply() + 1e6, Math.Rounding.Ceil);
        for (uint256 k; k < logs.length; ++k) {
            Vm.Log memory log = logs[k];
            if (log.topics.length < 3 || log.topics[1] != _msgs[i].batchKey) continue;
            address user = _topicAddress(log.topics[2]);
            uint256 u = _userIndex(user);
            if (_isVaultLog(log, Deposited.selector)) {
                // what this mint rounded away (the review's M-8): a deposit a (`paidIn`) mints floor(a / p) shares at
                // the delivery's price p, so p > a / (minted + 1) and a - minted x p < a / (minted + 1); and p is at
                // most `share`. 0 for a 0-amount entry; for an exact mint the bound is p, not 0 (p is not read here)
                (uint256 paidIn, uint256 minted) = abi.decode(log.data, (uint256, uint256));
                if (share > RAO) ++coarseMints;
                if (_inRoutine && u < USERS) _mintSlack[u] += Math.min(share, Math.ceilDiv(paidIn, minted + 1));
                continue;
            }
            if (_isVaultLog(log, RedeemDeferred.selector)) {
                // deferred at its point: the rest there was under MIN_REDEEM_VALUE (the allowance spent), to within
                // the floor to whole shares (a rest whose cap is worth under MIN_REDEEM_VALUE is under it and a share)
                if (_inRoutine && u < USERS && open_ && rest < MIN_REDEEM_VALUE + 2 * RAO + share) {
                    (_heldRound[u], _heldWhy[u]) = (_round, 10);
                }
                continue;
            }
            if (!_isVaultLog(log, Redeemed.selector)) continue;
            ++burnsChecked;
            if (!open_) ++burnsBehindAClosedRail;
            (uint256 burned, uint256 out) = abi.decode(log.data, (uint256, uint256));
            // what the windows can burn after this burn, and whether that spent the day's allowance: a clip to the rest
            // a burns floor(min(limit, a) / p) shares, worth more than min(limit, a) - p, and S-L1's keep at most
            // MIN_REDEEM_VALUE + p of it, so its burn falls short of min(limit, a) by under MIN_REDEEM_VALUE + p plus
            // the rao floor: one share's value more than the 2 rao (the review's M-5; ~42,000 rao at an orphan's price)
            rest = _sub0(rest, out);
            bool spent = rest <= MIN_REDEEM_VALUE + 2 * RAO + share;
            uint256 left = vault.balanceOf(user);
            // the shares still held by the door hold now (the lens reads the record as stored; it holds a day from its
            // clock, CascadeShares.freshOf): the record alone, read before Task 42's fix round, held every holder's
            // shares for good, so S-L1's check almost never ran
            (uint64 since, uint128 stored) = vaultLens.freshShares(user);
            uint256 fresh = vm.getBlockTimestamp() < uint256(since) + STAKE_RAMP ? stored : 0;
            if (fresh != 0) {
                if (_inRoutine && u < USERS && left != 0) _freshCut[u] = true;
                continue;
            }
            if (_asked(redeems, user) < left + burned) {
                if (_inRoutine && u < USERS && left != 0) _ownPartial[u] = true;
                continue;
            }
            ++fullRequestBurns;
            if (left == 0) {
                if (_inRoutine && u < USERS) _heldRound[u] = 0;
                continue;
            }
            uint256 value = CascadeMath.assetsForRedeem(left, vaultLens.totalAssets(), vault.totalSupply());
            value -= value % RAO;
            if (value < MIN_REDEEM_VALUE) ++unredeemableRemainders;
            else if (value < MIN_REDEEM_VALUE + 2 * RAO) ++keepsHeld;
            uint256 why;
            if (out + MIN_REDEEM_VALUE + 2 * RAO + share >= vaultLens.maxEntryValue()) {
                why = 12;
                ++entryClips;
            } else if (spent) {
                why = 10;
                ++allowanceHolds;
            } else {
                ++unexplainedClips;
            }
            if (_inRoutine && u < USERS) (_heldRound[u], _heldWhy[u]) = (why == 0 ? 0 : _round, why);
        }
        if (!open_ && redeems.length != 0) ++deferralsWhileClosed;
    }

    function _asked(CascadeMessages.Entry[] memory redeems, address user) internal pure returns (uint256) {
        for (uint256 k; k < redeems.length; ++k) {
            if (redeems[k].user == user) return redeems[k].amount;
        }
        return 0;
    }

    // ==== the probe ====

    /// @dev Every user's money gets out with no owner's act, or the table names what holds it (see the contract's
    /// notes); all inside a snapshot, so the run goes on as it was.
    function probeExits(uint256 seed) external step checked {
        _readLogs();
        // what the routine's deliveries and calls count, carried out of the snapshot (Minor 2 and I-3 of the review)
        uint256[15] memory carried0 = _carried();
        bytes32 lastTag = lastUnexpected;
        uint256 snap = vm.snapshotState();
        Scenario sc = Scenario(seed % SCENARIOS);
        _scenario = sc;
        _apply(sc);
        Start memory st;
        st.h = _holdings();
        for (uint256 u; u < USERS; ++u) {
            st.shares[u] = vault.balanceOf(_user(u));
            st.wallet[u] = _wallet(u);
            if (_failedHeld(_user(u))) st.failedHeld = true;
        }
        st.outsiders = _outsiders();
        _routine();
        uint256[KINDS][USERS] memory end_ = _holdings();
        Verdict memory v = _judge(st, end_);
        v.queuedHeld = _queuedHeld(st.h);
        uint256[15] memory carried = _carried();
        for (uint256 k; k < 15; ++k) {
            carried[k] -= carried0[k];
        }
        bytes32 routineTag = lastUnexpected;
        _dropLogs();
        vm.revertToState(snap);
        // the counters, written after the snapshot is reverted
        _carryOut(carried);
        if (carried[6] != 0) lastUnexpected = routineTag;
        else lastUnexpected = lastTag;
        ++probes;
        ++probesOf[uint256(sc)];
        exitFailures += v.failures;
        tableOverclaims += v.overclaims;
        remainderFailures += v.remainders;
        receiptShortfalls += v.shortfalls;
        cleanModelExcuses += v.cleanExcuses;
        queuedHeldChecks += v.queuedHeld;
        if (v.clean) ++cleanProbes;
        if (st.failedHeld) ++failuresJudged;
        if (v.failures + v.remainders != 0) lastExitFailure = v.failure;
        if (v.overclaims != 0) lastOverclaim = v.overclaim;
        if (v.shortfalls != 0) lastReceiptShortfall = v.shortfall;
        if (v.outside) ++outsideReceipts;
        _countReach(v.reach, st.h, end_);
    }

    /// What the probe records at its start, before the routine.
    struct Start {
        uint256[KINDS][USERS] h;
        uint256[USERS] shares;
        uint256[USERS] wallet;
        bool failedHeld;
        uint256 outsiders;
    }

    /// The judge's verdict (see `_judge`).
    struct Verdict {
        uint256 failures;
        uint256 overclaims;
        uint256 remainders;
        uint256 shortfalls;
        uint256 cleanExcuses;
        uint256 queuedHeld;
        bool clean;
        bool outside;
        bytes32 failure;
        bytes32 overclaim;
        bytes32 shortfall;
        uint256[13] reach;
    }

    /// The counters the routine's deliveries and calls write: the burns checked, burned behind a closed rail, left
    /// unredeemable, from a full request, the deferrals while closed, the clips with no cause, the unexpected, the
    /// entry limit's and the allowance's clips, S-L1's keeps, the coarse mints, and the deposit cancels refused
    /// CancelTooSoon and gone under the cooldown's waiver (R12: before it the routine's cancel counts stayed in the
    /// snapshot).
    function _carried() internal view returns (uint256[15] memory c) {
        c = [
            burnsChecked,
            burnsBehindAClosedRail,
            unredeemableRemainders,
            fullRequestBurns,
            deferralsWhileClosed,
            unexplainedClips,
            unexpectedReverts,
            entryClips,
            allowanceHolds,
            keepsHeld,
            coarseMints,
            // the routine's deposit cancels: refused CancelTooSoon as predicted, and gone inside the cooldown under its
            // waiver (R11, R12; FrontDoorTracker's counters)
            cancelsTooSoon,
            cancelsWaived,
            cancelsWaivedPaused,
            cancelsWaivedPrimary
        ];
    }

    function _carryOut(uint256[15] memory d) internal {
        burnsChecked += d[0];
        burnsBehindAClosedRail += d[1];
        unredeemableRemainders += d[2];
        fullRequestBurns += d[3];
        deferralsWhileClosed += d[4];
        unexplainedClips += d[5];
        unexpectedReverts += d[6];
        entryClips += d[7];
        allowanceHolds += d[8];
        keepsHeld += d[9];
        coarseMints += d[10];
        cancelsTooSoon += d[11];
        cancelsWaived += d[12];
        cancelsWaivedPaused += d[13];
        cancelsWaivedPrimary += d[14];
    }

    /// The bridged TAO on Base of the parties outside the four users who never own a user's money: `anyone` (the
    /// routine's caller of park and payout functions, paid its fees in native TAO) and the door's treasury (paid only
    /// by the owner's sweepPot, which the routine never calls). Neither pays a user in bridged TAO either, so the
    /// judge reads any move (the review's M-3): a user's money reaching them, or theirs reaching a user and masking its
    /// shortfall. The recipient actor is left out: the routine refunds its own parks to it.
    function _outsiders() internal view returns (uint256) {
        return taoBase.balanceOf(anyone) + taoBase.balanceOf(fd.treasury());
    }

    /// User `u`'s wallet: its bridged TAO on Base and its native TAO (one EVM holds both chains' balances).
    function _wallet(uint256 u) internal view returns (uint256) {
        address a = _user(u);
        return a.balance + (u == TE ? 0 : taoBase.balanceOf(a));
    }

    /// Whether a message of `a`'s money is in CCIP FAILURE now (a batch it deposits in, or a payout to it).
    function _failedHeld(address a) internal view returns (bool) {
        for (uint256 k; k < _toBittensor.length; ++k) {
            uint256 i = _toBittensor[k];
            if (_msgs[i].state == State.Failed && _holds(i, a)) return true;
        }
        for (uint256 k; k < _toBase.length; ++k) {
            uint256 i = _toBase[k];
            if (_msgs[i].state != State.Failed) continue;
            (,, CascadeMessages.Entry[] memory p) = CascadeMessages.decodePayouts(_body[i]);
            for (uint256 e; e < p.length; ++e) {
                if (p[e].user == a) return true;
            }
        }
        return false;
    }

    /// The scenario `sc` applied now, over the run's state (each a no-op where the state already holds it).
    function _apply(Scenario sc) internal {
        if (sc == Scenario.VaultPaused && !vault.paused()) {
            vm.prank(guardian);
            vault.pause();
        } else if (sc == Scenario.DoorPaused && !fd.paused()) {
            vm.prank(guardian);
            fd.pause();
        } else if (
            (sc == Scenario.DoorRemovedByOwner || sc == Scenario.DoorRemovedByGuardian)
                && vaultLens.doorState(doorPeer) == DoorState.Active
        ) {
            vm.prank(sc == Scenario.DoorRemovedByOwner ? owner : guardian);
            vault.removeFrontDoor(baseChain, address(fd));
        } else if (sc == Scenario.VaultRailOff && vaultLens.bridgeEnabled(address(adapterBit))) {
            vm.prank(guardian);
            vault.disableBridge(address(adapterBit));
        } else if (sc == Scenario.DoorRailOff && doorLens.bridgeEnabled(address(adapterBase))) {
            vm.prank(guardian);
            fd.disableBridge(address(adapterBase));
        } else if (sc == Scenario.FmHeld && !av.migrationFinished()) {
            av.adminHold(vm.getBlockTimestamp() + 2 days);
        } else if (sc == Scenario.FmNotice && av.migrationReadyAt() == 0 && !av.migrationExecuted()) {
            if (!av.migrationFinished()) av.initiateMigration();
        } else if (sc == Scenario.FmFinished && !av.migrationFinished()) {
            if (av.migrationReadyAt() == 0 && !av.migrationExecuted()) av.initiateMigration();
            if (!av.migrationExecuted()) {
                if (vm.getBlockTimestamp() < av.migrationReadyAt()) {
                    _warp(av.migrationReadyAt() - vm.getBlockTimestamp(), doorBlockTime);
                }
                av.executeMigration();
            }
            av.finishMigration();
        } else if (sc == Scenario.StakeSwapped && !swapped) {
            bytes32 h = vaultLens.stakeHotkey();
            if (_stakeOf(h) != 0) {
                staking.swapHotkey(h, AWAY, coldkey, 10_000);
                swapped = true;
            }
        } else if (sc == Scenario.StakeLost) {
            bytes32 h = vaultLens.stakeHotkey();
            uint256 lose = vaultLens.bookedStake() / 100 + MIN_MISSING_TOLERANCE_RAO;
            staking.loseStake(h, coldkey, Math.min(lose, _stakeOf(h)));
        } else if (sc == Scenario.FloorRaised) {
            staking.setMinStake(5e9);
        } else if (sc == Scenario.CushionShort) {
            uint256 tokens = taoBit.balanceOf(address(adapterBit));
            if (tokens > ghostParkedTokens) taoBit.burn(address(adapterBit), tokens - ghostParkedTokens);
            vm.store(address(adapterBit), bytes32(_cushionSlot()), bytes32(0));
            av.setShortBy(1e9);
            av.setOverpay(0);
            av.setOvermint(0);
        }
    }

    /// The non-owner routine (see the contract's notes): four rounds of exits a day or more apart, the payouts after
    /// each delay, and the parks' refunds past PARK_TIMEOUT; then the last direct exits (`_lastDirectExits`), after the
    /// last delivery, which the judge's end state follows. At every step's boundary anyone lists the hotkey a swap
    /// moved the stake to, while stake is missing (`_repairSwap`: stake can go missing in the routine itself, as the
    /// stayers' exits shrink the booked stake and with it the tolerance a swap's small shortfall stood under; the
    /// rerun's counterexample), and the whole-kind closers' holds are read (`_noteHeld`, the over-claim's record).
    function _routine() internal {
        _inRoutine = true;
        _round = 0;
        for (uint256 u; u < USERS; ++u) {
            (_heldOn[u][0], _heldOn[u][1], _heldMost[u][0], _heldMost[u][1]) = (false, false, 0, 0);
            (_fellWhileOn[u][0], _fellWhileOn[u][1]) = (false, false);
        }
        _boundary();
        _relayAll();
        _boundary();
        uint256[KINDS][USERS] memory h = _holdings();
        for (uint256 u; u < USERS; ++u) {
            _queuedAfterRelay[u] = h[u][K_QUEUED];
        }
        _usersExit();
        _boundary();
        _closeRelay();
        _boundary();
        _warp(STAKE_RAMP + 1 hours, doorBlockTime);
        _boundary();
        _deliverParks();
        _boundary();
        _usersExit();
        _boundary();
        _closeRelay();
        _boundary();
        _warp(vaultLens.payoutDelay(), vaultBlockTime);
        _payAll();
        _boundary();
        _claimAll();
        _warp(adapterBit.PARK_TIMEOUT() + 1 hours, doorBlockTime);
        _boundary();
        _deliverParks();
        _boundary();
        _refundParks();
        _claimAll();
        _boundary();
        _usersExit();
        _boundary();
        _closeRelay();
        _boundary();
        _warp(vaultLens.payoutDelay(), vaultBlockTime);
        _payAll();
        _boundary();
        _claimAll();
        _warp(STAKE_RAMP + 1 hours, doorBlockTime);
        _boundary();
        _deliverParks();
        _boundary();
        _refundParks();
        _boundary();
        _usersExit();
        _boundary();
        _closeRelay();
        _boundary();
        _warp(vaultLens.payoutDelay(), vaultBlockTime);
        _payAll();
        _boundary();
        _relayAll();
        _boundary();
        _claimAll();
        _lastDirectExits();
        _noteHeld();
        _inRoutine = false;
    }

    /// The routine's last direct exits (the 32-seed sweep's seed 112): each direct-capable holder (the BEs and the TE)
    /// still holding shares exits directly with them all, in passes until one makes no exit (at most 3: one holder's
    /// exit can tip another's rounding), then a boundary. A delivery after a holder's last round of exits (the last
    /// round's, which runs after `_usersExit`) can lift shares worth less than a rao, refused ZeroAmount in every round,
    /// to a whole rao by another holder's burn rounding; the judge reads the end state, where that direct path is open,
    /// so the holder takes it, as it would. Each holder's exit takes all its shares, so it goes at most once here.
    function _lastDirectExits() internal {
        for (uint256 pass; pass < 3; ++pass) {
            bool went;
            for (uint256 k; k < ACTORS; ++k) {
                address u = actors[k];
                if (k != SW && vault.balanceOf(u) != 0 && _tryDirect(u)) went = true;
            }
            if (vault.balanceOf(taoEoa) != 0 && _tryDirect(taoEoa)) went = true;
            if (!went) break;
        }
        _boundary();
    }

    /// A step's boundary in the routine: anyone's relist while stake is missing, then the holds read.
    function _boundary() internal {
        _repairSwap();
        _noteHeld();
    }

    /// The over-claim's record (the rerun's counterexample; the controller's ruling (a)): for each user, while a closer
    /// the table says holds its whole shares (or its whole queued payouts) is on, the most it held of them since that
    /// closer came on; a closer that turns off ends the phase, and a kind that fell below that most during it is an
    /// over-claim the judge counts (`_fellWhileOn`, fix round 4, the review's M-1: a phase that ends before the routine
    /// does is judged at its end). The closers change only at the routine's warps and relists, each followed by a read
    /// before any money moves: the step boundaries, and inside `_closeRelay` between its close's 12 hours and the
    /// delivery. The judge also holds a whole-kind closer still on at the end to what it held from when it came on, not
    /// to what the user held before it existed (money a closer never held may have left before it).
    function _noteHeld() internal {
        uint256 c = _closers();
        for (uint256 u; u < USERS; ++u) {
            address a = _user(u);
            _noteKind(u, 0, c & _wholeMask(K_SHARES, u), vault.balanceOf(a));
            _noteKind(u, 1, c & _wholeMask(K_QUEUED, u), _queuedOf(a));
        }
    }

    /// User `u`'s kind `k` (`amount` of it now) under the whole-kind closers `on` (0: none).
    function _noteKind(uint256 u, uint256 k, uint256 on, uint256 amount) internal {
        if (on == 0) {
            if (_heldOn[u][k] && amount < _heldMost[u][k]) {
                (_fellWhileOn[u][k], _fellMask[u][k]) = (true, _heldMask[u][k]);
            }
            (_heldOn[u][k], _heldMost[u][k]) = (false, 0);
        } else if (!_heldOn[u][k]) {
            (_heldOn[u][k], _heldMost[u][k], _heldMask[u][k]) = (true, amount, on);
        } else {
            if (amount > _heldMost[u][k]) _heldMost[u][k] = amount;
            _heldMask[u][k] = on;
        }
    }

    /// Anyone lists the unlisted hotkey a validator's swap moved the stake to, while stake is missing (the vault's
    /// permissionless way back, I-6). Its refusal is expected only as NotEligible with the hotkey below the chain's
    /// minimum or listed before (CascadeHotkeyLib.add's rules for anyone: once listed, lastClaimAt stays); any other is
    /// unexpected (fix round 4, the review's M-2: a regression refusing a legitimate relist would otherwise leave closer
    /// 16 holding the shares it should free).
    function _repairSwap() internal {
        if (!vaultLens.stakeMissing() || vaultLens.isHotkey(AWAY) || _stakeOf(AWAY) == 0) return;
        bool eligible = _stakeOf(AWAY) >= vaultLens.minStakeRao() && vaultLens.lastClaimAt(AWAY) == 0;
        vm.prank(anyone);
        try vault.addHotkey(AWAY) {
            if (!eligible) _tag("repairSwap went");
        } catch (bytes memory reason) {
            if (eligible || _selector(reason) != NotEligible.selector) _tag("repairSwap refused");
        }
    }

    /// CCIP executes every message in flight or failed, both ways (a failure re-executed).
    function _relayAll() internal {
        for (uint256 k; k < _toBittensor.length; ++k) {
            uint256 i = _toBittensor[k];
            if (_msgs[i].state == State.InFlight || _msgs[i].state == State.Failed) _relayToBittensor(i, 0);
        }
        for (uint256 k; k < _toBase.length; ++k) {
            uint256 i = _toBase[k];
            if (_msgs[i].state == State.InFlight || _msgs[i].state == State.Failed) _relayToBase(i, 1);
        }
    }

    /// Each user acts for itself: cancels its open deposit (BE, SW), on the first round, and again on a later one while
    /// it is still open (R11: a first cancel within five minutes of the deposit is refused CancelTooSoon, unless the
    /// door is paused or its primary disabled, which waive the cooldown (R12), and the routine's warps pass the cooldown
    /// before the next round; nothing in the routine deposits, so no other deposit is open after the first round); exits
    /// directly with everything (BE, TE), on the first round, and again whenever it still holds shares; and (BE, SW)
    /// asks the door to redeem whatever it still holds.
    function _usersExit() internal {
        ++_round;
        for (uint256 k; k < ACTORS; ++k) {
            address u = actors[k];
            if (fd.depositOf(u) != 0) _cancelOpen(k);
            if (k != SW && vault.balanceOf(u) != 0) _tryDirect(u);
            if (vault.balanceOf(u) > fd.redeemOf(u)) {
                uint256 paid = u.balance;
                _request(k, 0);
                _feesPaid[k] += paid - u.balance;
            }
        }
        if (vault.balanceOf(taoEoa) != 0) _tryDirect(taoEoa);
    }

    /// `u`'s direct exit with all its shares (with acceptMissing while stake is missing, its consent): whether it went.
    function _tryDirect(address u) internal returns (bool went) {
        uint256 held = vault.balanceOf(u);
        bool missing = vaultLens.stakeMissing();
        _readLogs();
        vm.prank(u);
        try vault.redeemDirect(held, missing) {
            went = true;
        } catch {
            _dropLogs();
        }
    }

    /// Actor `k` cancels its whole open deposit, and the handler's record of the open batch drops its entry. Within five
    /// minutes of its last deposit the cancel is refused CancelTooSoon (R11, FrontDoorTracker's model, the exact revert
    /// data), and the deposit leaves with the batch (the routine's close) or is cancelled at the next round; while the
    /// door is paused or its primary disabled the cooldown is waived and the cancel goes at once (R12, counted as
    /// `cancelsWaived`); any other refusal, or a predicted one that does not happen, is unexpected.
    function _cancelOpen(uint256 k) internal {
        address u = actors[k];
        uint256 amount = fd.depositOf(u);
        bytes memory tooSoon = _cancelTooSoon(fd, u);
        bool waived = _waivedNow(fd, u);
        _readLogs();
        vm.prank(u);
        try fd.cancelDeposit(amount) {
            if (tooSoon.length != 0) _tag("cancelOpen went");
            if (waived) _countWaived(fd);
            uint256 slot = _openDepositSlot[u];
            uint256 last = _openDeposits.length - 1;
            if (slot - 1 != last) {
                _openDeposits[slot - 1] = _openDeposits[last];
                _openDepositSlot[_openDeposits[slot - 1].user] = slot;
            }
            _openDeposits.pop();
            delete _openDepositSlot[u];
        } catch (bytes memory reason) {
            _dropLogs();
            if (!_refusedTooSoon(reason, tooSoon)) _tag("cancelOpen");
        }
    }

    /// The keeper's close (AdapterHandler's, time to the batch's interval first) and its batch relayed at once; while
    /// the door's primary is disabled (the table's closer 8) the close is refused PrimaryBridgeDisabled, as predicted.
    function _closeRelay() internal {
        (,,,, uint256 nDeposits, uint256 nRedeems) = fd.openBatch();
        if (nDeposits + nRedeems == 0) return;
        if (!doorLens.bridgeEnabled(doorLens.primaryBridge())) {
            _warp(12 hours, doorBlockTime);
            (uint64 id,,,,,) = fd.openBatch();
            uint256 fee = routerBase.fee();
            _readLogs();
            try fd.closeBatch{value: fee}(id, 0) {
                _tag("closeBatch: disabled primary");
            } catch (bytes memory reason) {
                _dropLogs();
                if (_selector(reason) != PrimaryBridgeDisabled.selector) _tag("closeBatch: refused");
            }
            return;
        }
        (bool sent, uint256 i) = _close(0);
        // the close's own 12 hours can end a hold (ForeverMoney's) before its delivery burns: the over-claim's record
        // reads the closers between the two, so the burn is judged under the closers it met (_noteHeld)
        if (_inRoutine) _noteHeld();
        if (sent) _relayToBittensor(i, 0);
    }

    /// Anyone delivers every park (a token park converts first; a refusal leaves it parked).
    function _deliverParks() internal {
        for (uint256 k; k < _parkKeys.length; ++k) {
            bytes32 key = _parkKeys[k];
            Park memory p = _parks[key];
            if (!p.live) continue;
            Msg memory m = _msgs[p.msgIndex];
            uint256 before = recipient.delivered();
            _readLogs();
            vm.prank(anyone);
            try adapterBit.deliverParked(m.recipient, m.sender, _body[p.msgIndex]) {
                Vm.Log[] memory logs = _readLogs();
                if (_adapterLogged(logs, CcipBittensorAdapter.ParkedDelivered.selector, key)) {
                    _unpark(key);
                    _delivered(p.msgIndex, logs, before);
                } else if (_adapterLogged(logs, CcipBittensorAdapter.ParkedConverted.selector, key) && !p.converted) {
                    ghostParkedTokens -= p.amount;
                    ghostParkedNative += p.amount;
                    _parks[key].converted = true;
                    _msgs[p.msgIndex].state = State.ParkedNative;
                }
            } catch {
                _dropLogs();
            }
        }
    }

    /// Anyone refunds every park past PARK_TIMEOUT, at the quoted fee, the refund relayed to Base at once.
    function _refundParks() internal {
        for (uint256 k; k < _parkKeys.length; ++k) {
            bytes32 key = _parkKeys[k];
            Park memory p = _parks[key];
            if (!p.live || p.amount == 0) continue;
            Msg memory m = _msgs[p.msgIndex];
            (bool quoted, uint256 quote,) = _quoteRefund(m, _body[p.msgIndex]);
            if (!quoted) continue;
            vm.deal(anyone, anyone.balance + quote);
            uint256 sends = routerBit.sendCount();
            _readLogs();
            vm.prank(anyone);
            try adapterBit.refundParked{value: quote}(m.recipient, m.sender, _body[p.msgIndex]) {
                _readLogs();
                (bool sent, uint256 r) = _refunded(key, sends);
                if (sent) _relayToBase(r, 1);
            } catch {
                _dropLogs();
            }
        }
    }

    /// Anyone sends every due payout chunk of every queued batch, with the whole fee as value, each relayed to Base.
    function _payAll() internal {
        bytes32[] memory keys = queuedKeys;
        for (uint256 k; k < keys.length; ++k) {
            for (uint256 c; c < 32; ++c) {
                if (vaultLens.getPayoutBatch(keys[k]).count == 0) break;
                if (!_payOne(keys[k])) break;
            }
        }
    }

    function _payOne(bytes32 key) internal returns (bool sent) {
        uint256 fee = routerBit.fee();
        vm.deal(anyone, anyone.balance + fee);
        uint256 sends = routerBit.sendCount();
        _readLogs();
        vm.prank(anyone);
        try vault.processPayouts{value: fee}(key, _lists[key], CHUNK_ENTRIES) {
            _readLogs();
            if (routerBit.sendCount() > sends) {
                uint256 i = _recordPayoutSend(sends);
                _relayToBase(i, 1);
                sent = true;
            }
            if (vaultLens.getPayoutBatch(key).count == 0) _dropKey(key);
        } catch {
            _dropLogs();
        }
    }

    /// Every user claims its credits on Base.
    function _claimAll() internal {
        if (skipClaims) return;
        for (uint256 k; k < ACTORS; ++k) {
            address u = actors[k];
            uint256 owed = fd.claimable(u);
            if (owed == 0) continue;
            vm.prank(u);
            try fd.claim() {
                if (divertClaims) {
                    vm.prank(u);
                    taoBase.transfer(anyone, owed);
                }
            } catch {}
        }
    }

    // ==== the judge ====

    /// Each user's money, by kind (wei): its open deposit, its deposits in live token and native parks, its shares'
    /// value (floored to rao), its queued payout entries, its credit on Base, and what it has in flight either way.
    function _holdings() internal view returns (uint256[KINDS][USERS] memory h) {
        for (uint256 u; u < USERS; ++u) {
            address a = _user(u);
            h[u][K_DEPOSIT] = fd.depositOf(a);
            h[u][K_SHARES] = _value(vault.balanceOf(a));
            h[u][K_CLAIMABLE] = fd.claimable(a);
            h[u][K_QUEUED] = _queuedOf(a);
        }
        for (uint256 k; k < _parkKeys.length; ++k) {
            CcipBittensorAdapter.Parked memory p = _parked(_parkKeys[k]);
            if (p.parkedAt == 0) continue;
            uint256 kind = p.converted ? K_PARK_NATIVE : K_PARK_TOKENS;
            CascadeMessages.Entry[] storage d = _depositsOf[_parks[_parkKeys[k]].msgIndex];
            for (uint256 e; e < d.length; ++e) {
                uint256 u = _userIndex(d[e].user);
                if (u < USERS) h[u][kind] += d[e].amount;
            }
        }
        for (uint256 k; k < _toBittensor.length; ++k) {
            uint256 i = _toBittensor[k];
            if (_msgs[i].state != State.InFlight && _msgs[i].state != State.Failed) continue;
            CascadeMessages.Entry[] storage d = _depositsOf[i];
            for (uint256 e; e < d.length; ++e) {
                uint256 u = _userIndex(d[e].user);
                if (u < USERS) h[u][K_IN_FLIGHT] += d[e].amount;
            }
        }
        for (uint256 k; k < _toBase.length; ++k) {
            uint256 i = _toBase[k];
            if (_msgs[i].state != State.InFlight && _msgs[i].state != State.Failed) continue;
            (,, CascadeMessages.Entry[] memory p) = CascadeMessages.decodePayouts(_body[i]);
            for (uint256 e; e < p.length; ++e) {
                uint256 u = _userIndex(p[e].user);
                if (u < USERS) h[u][K_IN_FLIGHT] += p[e].amount;
            }
        }
    }

    /// The judge (see the contract's notes), from the state at the end: every holding left must have every path out
    /// closed by the table's closers (an exit failure else); a holding of a kind a closer in force holds whole must not
    /// have fallen (shares counted in shares, a queued entry in its assets, from the larger of the start and the
    /// routine's first relay, which queues the closes in flight: an over-claim else); shares the routine burned down to
    /// less than MIN_REDEEM_VALUE (worth at least that at the start, no fresh shares cutting the burn) are no own
    /// choice (a remainder failure); what left a user's holdings must have reached its wallet, with its request fees,
    /// less RECEIPT_SLACK and SHORTFALL_TOLERANCE for each direct exit it may make (LAST_ROUND + 1: a shortfall); and in
    /// a clean probe VaultModel's refusal models explain nothing worth MIN_REDEEM_VALUE. The last of each packed: (kind,
    /// user, scenario, closers), the shortfall's (user, scenario, left, arrived); the reach indexed by the closer that
    /// explained a holding left.
    function _judge(Start memory st, uint256[KINDS][USERS] memory end_) internal view returns (Verdict memory v) {
        uint256 c = _closers();
        v.clean = _scenario == Scenario.None && c == 0 && staking.getDefaultMinStake() == _defaultMinStake
            && _collectRefusal(1e18) == 0;
        uint256 held;
        for (uint256 u; u < USERS; ++u) {
            uint256 total0;
            uint256 total1;
            for (uint256 k; k < KINDS; ++k) {
                total0 += st.h[u][k];
                total1 += end_[u][k];
                if (end_[u][k] == 0) continue;
                (bool closed, uint256 why) = _closed(k, u, c);
                if (!closed) {
                    (v.failures, v.failure) = (v.failures + 1, _pack(k, u, c));
                    continue;
                }
                if (
                    why == 11 && st.h[u][K_SHARES] >= MIN_REDEEM_VALUE && vault.balanceOf(_user(u)) < st.shares[u]
                        && !_freshCut[u] && !_ownPartial[u]
                ) {
                    (v.remainders, v.failure) = (v.remainders + 1, _pack(k, u, c));
                    continue;
                }
                if (v.clean && (why == 8 || why == 9) && end_[u][k] >= MIN_REDEEM_VALUE) ++v.cleanExcuses;
                ++v.reach[why];
            }
            held += total0;
            // closers that hold only some of a kind's objects (the floor, a walk, the allowance) can leave others free:
            // only the whole-kind ones are held to it, from when they came on in the routine (_noteHeld: the most the
            // user held of the kind since; the rerun's counterexample, a closer that came on after the money left)
            if (c & _wholeMask(K_SHARES, u) != 0 && _heldOn[u][0] && vault.balanceOf(_user(u)) < _heldMost[u][0]) {
                (v.overclaims, v.overclaim) = (v.overclaims + 1, _pack(K_SHARES, u, c));
            }
            if (c & _wholeMask(K_QUEUED, u) != 0 && _heldOn[u][1] && end_[u][K_QUEUED] < _heldMost[u][1]) {
                (v.overclaims, v.overclaim) = (v.overclaims + 1, _pack(K_QUEUED, u, c));
            }
            // and through an on-phase that ended before the routine did (_noteHeld)
            if (_fellWhileOn[u][0]) {
                (v.overclaims, v.overclaim) = (v.overclaims + 1, _pack(K_SHARES, u, _fellMask[u][0]));
            }
            if (_fellWhileOn[u][1]) {
                (v.overclaims, v.overclaim) = (v.overclaims + 1, _pack(K_QUEUED, u, _fellMask[u][1]));
            }
            // the user received it
            uint256 left = _sub0(total0, total1);
            uint256 arrived = _sub0(_wallet(u) + _feesPaid[u], st.wallet[u]);
            if (arrived + RECEIPT_SLACK + (LAST_ROUND + 1) * SHORTFALL_TOLERANCE + _mintSlack[u] < left) {
                v.shortfall = bytes32((u << 192) | (uint256(_scenario) << 128) | (left / RAO << 64) | arrived / RAO);
                ++v.shortfalls;
            }
        }
        if (held == 0) v.clean = false;
        v.outside = _outsiders() != st.outsiders;
    }

    /// The users whose queued entries the over-claim check held under a whole-kind closer this probe (its reach).
    function _queuedHeld(uint256[KINDS][USERS] memory start) internal view returns (uint256 n) {
        uint256 c = _closers();
        for (uint256 u; u < USERS; ++u) {
            if (c & _wholeMask(K_QUEUED, u) != 0 && Math.max(start[u][K_QUEUED], _queuedAfterRelay[u]) != 0) ++n;
        }
    }

    /// The closers in force now, a bit each: 1 the vault paused, 2 the door not active on the vault, 4 the vault's
    /// primary disabled, 8 the door's primary disabled, 16 stake missing (after anyone's listing), 32 the rail closed
    /// (canSendPayouts false), 64 the vault at a supply of 0 underwater.
    function _closers() internal view returns (uint256 c) {
        if (vault.paused()) c |= 1;
        if (vaultLens.doorState(doorPeer) != DoorState.Active) c |= 2;
        if (!vaultLens.bridgeEnabled(address(adapterBit))) c |= 4;
        if (!doorLens.bridgeEnabled(address(adapterBase))) c |= 8;
        if (vaultLens.stakeMissing()) c |= 16;
        if (!adapterBit.canSendPayouts()) c |= 32;
        if (vault.totalSupply() == 0 && _underwater()) c |= 64;
    }

    /// Whether holding kind `k` of user `u` has every path out closed now (closers `c`), and which closer explains it
    /// (reach index): see the table in the contract's notes.
    function _closed(uint256 k, uint256 u, uint256 c) internal view returns (bool closed, uint256 why) {
        if (k == K_DEPOSIT || k == K_CLAIMABLE || k == K_IN_FLIGHT || k == K_PARK_TOKENS) return (false, 0);
        if (k == K_PARK_NATIVE) return _parkClosed(u, c);
        if (k == K_QUEUED) return _queuedClosed(u, c);
        return _sharesClosed(u, c);
    }

    /// A native park holds `u`'s deposit only while its delivery (the vault's refusals) and its refund (the rail) are
    /// both closed: every native park holding `u`'s money must be.
    function _parkClosed(uint256 u, uint256 c) internal view returns (bool, uint256) {
        bool deliveryClosed = c & (1 | 2 | 4 | 16 | 64) != 0;
        if (!deliveryClosed) return (false, 0);
        for (uint256 k; k < _parkKeys.length; ++k) {
            CcipBittensorAdapter.Parked memory p = _parked(_parkKeys[k]);
            if (p.parkedAt == 0 || !p.converted || !_holds(_parks[_parkKeys[k]].msgIndex, _user(u))) continue;
            if (_collectRefusal(p.amount) == 0) return (false, 0);
        }
        return (true, _closerIndex(c, 0));
    }

    /// `u`'s queued entries are held while their batch's next chunk is: a whole-kind closer (the vault paused, the door
    /// not active, the vault's primary disabled), or the chunk's own refusal with the whole fee as value (its floor,
    /// its walk, the rail).
    function _queuedClosed(uint256 u, uint256 c) internal view returns (bool, uint256) {
        if (c & _wholeMask(K_QUEUED, u) != 0) return (true, _closerIndex(c, 0));
        for (uint256 k; k < queuedKeys.length; ++k) {
            bytes32 key = queuedKeys[k];
            if (!_owedIn(key, _user(u))) continue;
            if (_chunkRefusal(key) == 0) return (false, 0);
        }
        return (true, 8);
    }

    /// Shares are held while every path of the user's type is closed: the direct exit (the vault paused, or the walk
    /// refusing it), the door (`_doorMask`'s closers; the last round's request clipped to the entry limit or deferred
    /// by the day's spent allowance, as the routine saw it; or the shares worth less than MIN_REDEEM_VALUE, the
    /// holder's own choice, which the judge refuses when the routine burned them down to that).
    function _sharesClosed(uint256 u, uint256 c) internal view returns (bool, uint256) {
        uint256 shares = vault.balanceOf(_user(u));
        bool directClosed = u == SW || c & _wholeMask(K_SHARES, TE) != 0 || _directRefusal(shares) != 0;
        if (u == TE) return (directClosed, c & _wholeMask(K_SHARES, TE) != 0 ? 0 : 9);
        if (!directClosed) return (false, 0);
        if (c & _doorMask() != 0) return (true, _closerIndex(c, 0));
        if (_value(shares) < MIN_REDEEM_VALUE) return (true, 11);
        if (_heldRound[u] == LAST_ROUND) return (true, _heldWhy[u]);
        return (false, 0);
    }

    /// The closers that hold every object of kind `k` for user `u` (a fall in that holding contradicts the table; the
    /// one encoding the table's rows and the over-claim check read): for shares, what stops every delivery and burn
    /// for a smart wallet (the vault's pause 1, the door not active on the vault 2, the vault's primary disabled 4,
    /// stake missing 16, the rail closed 32: a redeem is then deferred), and for a BE or TE the pause alone (its direct
    /// exit is open otherwise); for queued entries, the pause, the door's state and the vault's primary. Not the floor,
    /// a walk, the rail's amount-dependent refusals or the allowance: they hold only some.
    function _wholeMask(uint256 k, uint256 u) internal pure returns (uint256) {
        if (k == K_SHARES) return u == SW ? 1 | 2 | 4 | 16 | 32 : 1;
        if (k == K_QUEUED) return 1 | 2 | 4;
        return 0;
    }

    /// The closers that hold a door request at the end: the whole-kind ones and the door's primary disabled (8), which
    /// stops new closes but not a request already sent or parked, so it holds what is left without holding it all.
    function _doorMask() internal pure returns (uint256) {
        return _wholeMask(K_SHARES, SW) | 8;
    }

    /// The first closer bit set in `c` from `from` on, as a reach index (0 pause ... 6 underwater); 7 when none.
    function _closerIndex(uint256 c, uint256 from) internal pure returns (uint256) {
        for (uint256 b = from; b < 7; ++b) {
            if (c & (1 << b) != 0) return b;
        }
        return 7;
    }

    /// processPayouts' refusal for `key`'s next chunk now, with the whole fee as value (AdapterHandler's
    /// _payoutRefusal, the caller's top-up given).
    function _chunkRefusal(bytes32 key) internal view returns (bytes4) {
        CascadeMessages.Payout[] memory list = _lists[key];
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        if (vault.paused()) return Pausable.EnforcedPause.selector;
        uint256 floor_ = staking.getDefaultMinStake() * RAO;
        uint256 limit = Math.min(Math.max(CHUNK_ENTRIES, vaultLens.minChunk()), CascadeMessages.MAX_ENTRIES);
        (, uint256 sum) = _takeChunk(list, b.cursor, limit, vaultLens.maxMessageValue(), vaultLens.minChunk());
        if (sum < floor_) return CcipAdapterBase.BelowConversionFloor.selector;
        uint256 fee = routerBit.fee();
        ChunkOut memory o = _chunkOutcome(list, b, CHUNK_ENTRIES, fee, fee);
        if (o.refusal != 0) return o.refusal;
        if (o.net == 0) return 0;
        if (o.net < floor_) return CcipAdapterBase.BelowConversionFloor.selector;
        return _collectRefusal(o.net);
    }

    /// What the door's window and all doors' window let burn now: the smaller rest (the base, the root stake that has
    /// ramped in; each window's percentage of it, at least the floor; less what the window burned, if it is current).
    function _doorRest() internal view returns (uint256) {
        uint256 elapsed = vm.getBlockTimestamp() - vaultLens.lastStakeAt();
        uint256 unspent = elapsed >= STAKE_RAMP ? 0 : vaultLens.rampingStake() * (STAKE_RAMP - elapsed) / STAKE_RAMP;
        uint256 base_ = _sub0(Math.min(vaultLens.visibleStakeRao(), vaultLens.bookedStake()) * RAO, unspent);
        uint256 floor_ = vaultLens.minDailyOutflow();
        uint256 door = _windowRest(doorPeer, Math.max(base_ * vaultLens.maxDailyOutflowBps() / 10_000, floor_));
        uint256 all = _windowRest(GLOBAL_WINDOW, Math.max(base_ * vaultLens.globalOutflowBps() / 10_000, floor_));
        return Math.min(door, all);
    }

    function _windowRest(bytes32 key, uint256 allowance) internal view returns (uint256) {
        (uint64 start_, uint256 burned) = vaultLens.burnWindows(key);
        if (vm.getBlockTimestamp() >= uint256(start_) + 1 days) return allowance;
        return _sub0(allowance, burned);
    }

    function _countReach(
        uint256[13] memory reach,
        uint256[KINDS][USERS] memory start,
        uint256[KINDS][USERS] memory end_
    ) internal {
        stuckByPause += reach[0];
        stuckByDoorGone += reach[1];
        stuckByVaultRail += reach[2];
        stuckByDoorRail += reach[3];
        stuckByStakeLost += reach[4];
        stuckByRailClosed += reach[5];
        stuckByRail += reach[8];
        stuckByWalk += reach[9];
        stuckByAllowance += reach[10];
        stuckByOwnChoice += reach[11];
        stuckByClip += reach[12];
        for (uint256 u; u < USERS; ++u) {
            uint256 total;
            for (uint256 k; k < KINDS; ++k) {
                total += end_[u][k];
                if (end_[u][k] != 0) ++stuckOf[k];
                else if (start[u][k] != 0) ++outOf[k];
            }
            if (u == SW && total == 0 && start[u][K_SHARES] != 0) ++smartWalletOuts;
        }
    }

    // ==== reads ====

    function _user(uint256 u) internal view returns (address) {
        return u == TE ? taoEoa : actors[u];
    }

    function _userIndex(address a) internal view returns (uint256) {
        for (uint256 u; u < USERS; ++u) {
            if (_user(u) == a) return u;
        }
        return USERS;
    }

    /// `shares`' value now, floored to rao.
    function _value(uint256 shares) internal view returns (uint256 v) {
        if (shares == 0) return 0;
        v = CascadeMath.assetsForRedeem(shares, vaultLens.totalAssets(), vault.totalSupply());
        v -= v % RAO;
    }

    /// `a`'s queued payout entries from each batch's cursor on (bounces included).
    function _queuedOf(address a) internal view returns (uint256 owed) {
        for (uint256 k; k < queuedKeys.length; ++k) {
            bytes32 key = queuedKeys[k];
            CascadeMessages.Payout[] storage list = _lists[key];
            uint256 cursor = vaultLens.getPayoutBatch(key).cursor;
            for (uint256 i = cursor; i < list.length; ++i) {
                if (list[i].user == a) owed += list[i].assets;
            }
        }
    }

    function _owedIn(bytes32 key, address a) internal view returns (bool) {
        CascadeMessages.Payout[] storage list = _lists[key];
        uint256 cursor = vaultLens.getPayoutBatch(key).cursor;
        for (uint256 i = cursor; i < list.length; ++i) {
            if (list[i].user == a) return true;
        }
        return false;
    }

    /// Whether batch message `i`'s deposits include one of `a`'s.
    function _holds(uint256 i, address a) internal view returns (bool) {
        CascadeMessages.Entry[] storage d = _depositsOf[i];
        for (uint256 e; e < d.length; ++e) {
            if (d[e].user == a) return true;
        }
        return false;
    }

    /// (kind, user, scenario, closers), packed for a failing run's reading.
    function _pack(uint256 k, uint256 u, uint256 c) internal view returns (bytes32) {
        return bytes32((k << 192) | (u << 128) | (uint256(_scenario) << 64) | c);
    }
}
