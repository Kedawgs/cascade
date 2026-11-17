// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CascadeVault} from "../../../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../../../src/CascadeFrontDoor.sol";
import {CascadeMath} from "../../../src/libraries/CascadeMath.sol";
import {CascadeMessages} from "../../../src/libraries/CascadeMessages.sol";
import {MockBridge} from "../../mocks/MockBridge.sol";
import {MockTAO} from "../../mocks/MockTAO.sol";
import {GLOBAL_WINDOW, MAX_HOTKEYS} from "../../../src/CascadeConstants.sol";
import {
    AdoptTooSoon,
    BelowMinAdoption,
    CapExceeded,
    ExitsNotOpen,
    FeeTooHigh,
    HotkeyHasRewards,
    HotkeyInUse,
    HotkeyKnown,
    NotAuthorized,
    NotEligible,
    NotListed,
    NotReady,
    NotScheduled,
    SlotReserved,
    StakeMissing,
    TooManyHotkeys,
    UnknownHotkey,
    UnstakeShort,
    VaultInsolvent,
    WriteOffTooLarge,
    ZeroAmount,
    ZeroHotkey
} from "../../../src/CascadeErrors.sol";
import {
    BatchDelivered,
    DepositBounced,
    Deposited,
    DepositedDirect,
    PayoutBatchQueued,
    PayoutChunkSent,
    Redeemed,
    RedeemDeferred,
    RedeemSkipped,
    RedeemedDirect,
    RewardCutMinted,
    ShortfallAbsorbed,
    StakeWrittenOff
} from "../../../src/CascadeEvents.sol";
import {PayoutBatch} from "../../../src/CascadeTypes.sol";
import {VaultModel} from "./VaultModel.sol";

/// @notice The ledger campaign's handler (Task 35, spec §3.1): the booked and visible stake across a hotkey set of up
/// to four, the slots, gifts and adoption, the missing-stake guard and the owner's write-off, under the actions of
/// validators (swaps, retained swaps with credits), strangers (their adds, removals, gifts and seeds), the keeper and
/// the owner (listings, removals, the stake hotkey, scheduled moves and write-offs), the chain (losses, claim falls,
/// credits landing inside a stake, the removal fee, the fresh read) and three holders (direct deposits and exits,
/// front-door deposits and redeems, delivered by MockBridge and paid out by the keeper).
///
/// The ghost ledger (I-2): `ghostBooked` replays every stake-side measurement the handler makes itself on the mock's
/// positions, each floored at 0 as the spec states it, never the vault's own events: a stake adds what the stake
/// hotkey's position rose by, at most what the vault's balance paid for it; a claim adds the rise of the listed
/// stake, floored (a fall books nothing); every removal (the walk of a direct exit or a payout, the owner's direct
/// removal of a leftover below the minimum) takes off what each position fell by, floored; an adoption books the
/// visible stake; a write-off takes off min(rao, missing). Moves within the set book nothing. `ghostRamping` and
/// `ghostLastStakeAt` replay the ramp the same way (I-5): a stake adds its gain over STAKE_RAMP from now, each
/// removal takes off what the mock paid for it.
///
/// I-1 (`_onLogs`): every Deposited, DepositedDirect, Redeemed and RewardCutMinted the vault logs is folded with the
/// state armed right before the call that made it (`_arm`): none while stake is missing, no mint while the vault is
/// underwater (a deposit's form at a supply of 0, the schedule written down; the cut's with the schedule as it is),
/// and every RedeemedDirect carries acceptedMissing exactly when stake was missing and pays its shares' value at
/// min(visible, booked), floored to the rao, less what its leaver bore (its ShortfallAbsorbed: what its walk left
/// untaken and the walk's cost, Task 36b, which _checkUnmet measures on the mock). The armed state is the handler's own:
/// the missing state is the spec's tolerance, restated (`_missingAt`), on the mock's listed positions and the ghost
/// ledger (`_ghostMissing`), the underwater flags the spec's rule as written (PriceFloorTracker's `_underwaterAs`), and
/// the assets are priced on the mock's positions and the ghost ledger; none is the vault's own view or formula.
///
/// I-6 (`probes`, after every action): while stake is missing, three ways back are tried inside a snapshot and
/// reverted: a stranger's (strangers list the swaps' never-listed hotkeys holding at least the chain's minimum,
/// removing old hotkeys that hold no stake and no credits when the set is full), which must clear the state exactly
/// when its plan says it can (the preconditions: the slots, the chain's minimum, empty old hotkeys); the owner's
/// immediate one (remove every other hotkey, moving or unstaking what it holds, and list what holds the vault's stake),
/// which must clear it whenever its plan says it can, and is the expected path outside the stranger's preconditions;
/// and a gift of the missing stake onto the stake hotkey, which always clears it and leaves the price at what the
/// booked stake prices. Every step a plan makes is one the spec allows its maker in that state, so a refused step
/// counts (`planRefusals`) whether or not the plan applies. Whether a plan applies is the handler's own reading: the
/// restated tolerance on the mock's positions and the ghost ledger.
///
/// The walk's removals (spec §3.10.11, Task 36's fix round 2; `walkMismatches`, VaultModel's _checkWalk): every call
/// that runs the vault's walk and succeeds (a direct exit, flagged or not, and the keeper's payout chunk) logs exactly
/// the Unstaked events VaultModel predicts before the call from the mock's positions (_exitPlan, _chunkOutcome on what
/// the chunk pays): the same hotkeys in order and each removal's wantRao. The owner's removal of a leftover below the
/// minimum (removeHotkey, and the owner's plan in the probes) is a direct removal, not the walk, so it is not one.
///
/// The leaver pays (Task 36b): a walk's removal fee, across however many positions it takes, is the exit's own cost,
/// never an I-4 exception; the owner's removal's cut stays the holders' (housekeeping, I-4's exception). I-35
/// (`exitPriceFalls`) around every direct exit and every payout chunk sent: the price never falls and the hole never
/// widens.
///
/// Expected refusals, by action, each predicted from the state in the vault's order (any other refusal, or a
/// predicted one that does not happen, counts in unexpectedReverts):
/// - depositDirect (and depositWhileMissing's): StakeMissing while stake is missing, VaultInsolvent below half the
///   launch price or underwater, CapExceeded above the cap;
/// - redeemDirect: StakeMissing while stake is missing, else VaultModel's _exitPlan: ZeroAmount under a rao or when the
///   walk's cost leaves the leaver nothing, UnstakeShort when the restated walk leaves more than T of what the liquid
///   balance does not cover untaken; redeemDirectWhileMissing: its unflagged probe StakeMissing, its flagged exit as
///   for redeemDirect;
/// - a delivery (closeBatch, doorRedeem's close, depositWhileMissing's, retryDelivery), as the bridge files it:
///   StakeMissing while stake is missing, VaultInsolvent at a supply of 0 underwater; processPayouts (and closeBatch's
///   payout): VaultModel's _chunkOutcome, UnstakeShort when the restated walk leaves more than T untaken or its
///   receipts do not fund the send, FeeTooHigh when its cost would leave an entry nothing;
/// - adopt: AdoptTooSoon within a day of the last adoption, BelowMinAdoption under the chain's minimum;
/// - strangerAddHotkey: NotEligible unless stake is missing and the hotkey, never listed, holds the chain's minimum;
///   then ZeroHotkey, HotkeyKnown, TooManyHotkeys; seedRemovedHotkey's listing: NotEligible always;
/// - reAddHotkey: HotkeyKnown, TooManyHotkeys, SlotReserved for the last slot unless stake is missing and the hotkey
///   holds the minimum;
/// - removeHotkey: UnknownHotkey, HotkeyInUse, NotAuthorized (anyone but the owner while it holds stake; the keeper or
///   guardian above the dust; a stranger unless nothing is unclaimed, the set full and stake missing),
///   HotkeyHasRewards (the owner, no forfeit, above the dust);
/// - followStake: NotListed for an unlisted hotkey, NotScheduled unless it follows moved stake;
/// - writeOff: NotScheduled for the direct call, ExitsNotOpen while the exits are closed (never here), NotReady
///   before its 7 days, WriteOffTooLarge when the unlisted stake exceeds the missing less min(rao, missing).
/// The other actions refuse nothing (stakeIdle and claims are made only where they run; moveStake's item always runs).
contract LedgerHandler is VaultModel {
    /// What the test passes the handler beyond the base's system.
    struct Parts {
        MockTAO tao;
        MockBridge bridge;
        bytes32 hotkey;
        uint64 doorChain;
        address treasury;
    }

    /// The state an I-1 fold reads: armed right before each call that may mint or burn (`_arm`).
    struct Arm {
        bool missing;
        bool underwater;
        bool underwaterRaw;
        uint256 assets;
        uint256 supply;
    }

    /// A recovery plan's outcome (the probes).
    struct Plan {
        bytes32[] adds;
        bytes32[] removes;
        bool applies;
    }

    uint256 internal constant MAX_DEPOSIT = 100e18;
    uint256 internal constant FEE_MONEY = 10 ether;
    uint256 internal constant BRIDGE_FEE = 1e15;
    /// The removal fees setRemoveFee draws up to the tolerance (and past it, 1,001, 50,000, 4,000,000 or 16,000,000
    /// rao: every one the exit's own cost, Task 36b).
    uint256 internal constant MAX_REMOVE_FEE_RAO = 1_000;
    /// Fresh hotkeys a run's swaps may create, and the chain's losses a run may take.
    uint256 internal constant MAX_SWAPS = 6;
    uint256 internal constant MAX_LOSSES = 2;
    uint32 internal constant PAYOUT_ENTRIES = 50;
    /// The vault's own hotkeys beside the first (the keeper's to list) and one no one ever used.
    bytes32 public constant HK2 = bytes32(uint256(2));
    bytes32 public constant HK3 = bytes32(uint256(3));
    bytes32 public constant NEVER = bytes32(uint256(999));
    /// The swaps' new hotkeys: SWAP_BASE + 1, + 2, ...
    uint256 internal constant SWAP_BASE = 100;

    MockTAO public immutable tao;
    MockBridge public immutable bridge;
    bytes32 public immutable firstHotkey;
    bytes32 public immutable peer;
    uint64 public immutable doorChain;
    address public immutable treasury;
    address public immutable stranger;

    address[3] public actors;
    /// Every hotkey the handler knows (the vault's three, NEVER and each swap's new one), and the swaps' alone.
    bytes32[] internal _pool;
    bytes32[] internal _swapTargets;

    // ---- the ghost ledger (I-2) and ramp (I-5): VaultModel's ghostBooked, ghostRamping and ghostLastStakeAt ----

    /// Root stake moved onto the vault's coldkey from outside (gifts and seeds) and credited inside a stake beyond
    /// what was staked, in rao (I-3: the surplus is never above them); stake the chain lost for good (loseStake), in
    /// rao.
    uint256 public ghostGiftsRao;
    uint256 public ghostCreditsRao;
    uint256 public ghostLostRao;
    /// Claims after which the booked stake was lower (I-2: none), exits that reverted with a panic (I-2: no exit
    /// reverts for a ledger reason; any other unpredicted refusal counts in unexpectedReverts), and write-offs whose
    /// booked stake did not fall by exactly min(rao, missing) or whose StakeWrittenOff said otherwise.
    uint256 public claimsLoweringLedger;
    uint256 public exitPanics;
    uint256 public writeOffMisbooked;

    // ---- I-1 ----

    Arm internal _armed;
    /// The vault's mint and burn events, folded, and those while stake was missing or the vault underwater (I-1: none);
    /// RedeemedDirect events, those flagged acceptedMissing, those whose flag was not the missing state they ran in,
    /// and those not paid their shares' value at min(visible, booked) less what was unmet.
    uint256 public depositedEvents;
    uint256 public depositedDirectEvents;
    uint256 public redeemedEvents;
    uint256 public cutEvents;
    uint256 public mintsOrBurnsWhileMissing;
    uint256 public mintsWhileUnderwater;
    uint256 public directRedeemEvents;
    uint256 public flaggedDirectRedeems;
    uint256 public directFlagMismatches;
    uint256 public directMispaid;
    /// Flagged exits whose assets fell by other than paid plus what the chain kept, and stayers whose value fell by
    /// more than their share of what the holders absorbed or rose past the leaver's rounding.
    uint256 public missingMispaid;
    uint256 public missingOthersMoved;

    // ---- I-3 ----

    uint256 public giftsBooked;
    uint256 public giftPriceMoves;
    uint256 public adoptPriceMoves;
    uint256 public unexpectedAdoptions;

    // ---- I-4's write-off and I-5 ----

    uint256 public writeOffPriceMoves;
    uint256 public writeOffsBelowVisible;
    uint256 public doorWindowOverruns;
    uint256 public globalWindowOverruns;

    // ---- I-6 ----

    uint256 public strangerFailures;
    uint256 public ownerFailures;
    uint256 public giftFailures;
    uint256 public strangerListedOnceListed;
    /// Probes in which a plan's step was refused (or the plan ran out of the removals the full set needed), whether or
    /// not the plan applies: every planned step is one the spec allows, so each is a model error or a vault bug.
    uint256 public planRefusals;

    // ---- the door's batches ----

    bytes32[] public queuedKeys;
    mapping(bytes32 => CascadeMessages.Payout[]) internal _lists;

    // ---- reachability counters ----

    uint256 public directDeposits;
    uint256 public directRedeems;
    uint256 public depositsRefusedWhileMissing;
    uint256 public depositsRefusedInsolvent;
    uint256 public redeemsRefusedWhileMissing;
    uint256 public exitsUncoverable;
    /// Direct exits (flagged or not) refused ZeroAmount after their walk: its cost left the leaver nothing (Task 36b).
    uint256 public exitsRefusedByCost;
    uint256 public multiPositionWalks;
    uint256 public stakes;
    uint256 public stakesWithCredit;
    uint256 public stakesWhileMissing;
    uint256 public claims;
    uint256 public claimsToBalance;
    uint256 public claimsWithFall;
    uint256 public claimsWhileMissing;
    uint256 public claimsOfCredits;
    uint256 public cutsSkippedWhileMissing;
    uint256 public swapsMissing;
    uint256 public swapsWithinTolerance;
    uint256 public swapsOfTheStakeHotkey;
    uint256 public retainedSwaps;
    uint256 public strangerAdds;
    uint256 public strangerAddsRefused;
    uint256 public strangerAddsFillingTheLastSlot;
    uint256 public seedsRefused;
    uint256 public seedsRefusedWhileMissing;
    uint256 public reAdds;
    uint256 public reAddsOfOnceListed;
    uint256 public reAddsRefused;
    uint256 public slotsReservedRefused;
    uint256 public removalsByOwner;
    uint256 public removalsMovingStake;
    uint256 public removalsIntoBalance;
    uint256 public removalsByKeeper;
    uint256 public removalsByStranger;
    uint256 public removalsRefused;
    uint256 public gifts;
    uint256 public giftsWhileMissing;
    uint256 public giftsUnlisted;
    uint256 public giftsAlpha;
    uint256 public adoptions;
    uint256 public adoptionsRefused;
    uint256 public writeOffs;
    uint256 public writeOffsOfSomething;
    uint256 public writeOffsReopening;
    uint256 public writeOffsTooLarge;
    uint256 public writeOffsUnscheduled;
    uint256 public writeOffsEarly;
    uint256 public losses;
    uint256 public missingExits;
    uint256 public probesOfDepositsWhileMissing;
    uint256 public doorDeposits;
    uint256 public doorRedeems;
    uint256 public closes;
    uint256 public deliveries;
    uint256 public burningDeliveries;
    /// Door redeems a delivery deferred (below the smallest burn, or past the windows) or skipped (another origin).
    uint256 public redeemsHeldBack;
    uint256 public deliveriesRefusedWhileMissing;
    uint256 public deliveriesRefusedUnderwater;
    uint256 public retriesDelivered;
    uint256 public payoutChunks;
    uint256 public payoutsUncoverable;
    /// Payout chunks refused FeeTooHigh because their walk's cost would leave an entry nothing (Task 36b).
    uint256 public chunksRefusedWalkCost;
    uint256 public stakeHotkeySwitches;
    uint256 public stakeHotkeySwitchesScheduled;
    uint256 public stakeHotkeySwitchesRefused;
    uint256 public moves;
    uint256 public feeSwitches;
    uint256 public readSwitches;
    uint256 public i4Swaps;
    uint256 public i4Losses;
    uint256 public i4ClaimFalls;
    uint256 public i4MoveShorts;
    /// moveIntoEmpty's targeted draws made (Task 42).
    uint256 public moveIntoEmptyDraws;
    /// The probes (I-6): every one, the stranger's plan applying (and so clearing), the reason it did not (the first
    /// precondition that fails: the state was not a swap's, only a once-listed hotkey holds enough of the stake (a
    /// seed, or a gift on a swap's hotkey the vault listed and removed), a swapped position under the chain's minimum,
    /// an old hotkey holding stake or credits, too few slots), the owner's plan applying, and neither (the gift's way
    /// alone).
    uint256 public recoveryProbes;
    uint256 public probesStranger;
    uint256 public probesNotASwap;
    uint256 public probesSeededOnly;
    uint256 public probesSubMinimum;
    uint256 public probesOldNotEmpty;
    uint256 public probesSlotsShort;
    uint256 public probesOwner;
    uint256 public probesGiftOnly;

    constructor(System memory s, Parts memory l) VaultModel(s) {
        tao = l.tao;
        bridge = l.bridge;
        firstHotkey = l.hotkey;
        doorChain = l.doorChain;
        peer = s.vaultLens.peerId(l.doorChain, address(s.fd));
        treasury = l.treasury;
        stranger = makeAddr("stranger");

        actors = [makeAddr("alice"), makeAddr("bob"), makeAddr("carol")];
        for (uint256 i; i < actors.length; ++i) {
            l.tao.mint(actors[i], 10_000e18);
            vm.prank(actors[i]);
            l.tao.approve(address(s.fd), type(uint256).max);
            vm.deal(actors[i], 10_000e18 + FEE_MONEY);
            _trackAccount(actors[i]);
        }
        _trackAccount(stranger);
        _trackAccount(address(l.bridge));
        _trackAccount(l.treasury);
        // the mock stakes only onto hotkeys it knows; a swap makes its new hotkey known
        staking.addHotkey(HK2);
        staking.addHotkey(HK3);
        staking.addHotkey(NEVER);
        bytes32[4] memory own = [l.hotkey, HK2, HK3, NEVER];
        for (uint256 i; i < own.length; ++i) {
            _pool.push(own[i]);
            _trackWord(own[i], WordKind.Hotkey);
        }
        // the zero hotkey a stranger may name (also the global window's key, tracked by the base)
        _trackWord(bytes32(0), WordKind.Hotkey);
        _trackPeer(l.doorChain, address(s.fd));
        _trackPeer(s.fd.vaultChain(), address(s.fd));
        _trackMessage(l.doorChain, address(s.fd), "");
    }

    /// @dev Takes the unused part of each close's budget back.
    receive() external payable {}

    /// @dev After the action: the probes of I-6's ways back (see the contract's notes).
    modifier probes() {
        _;
        _probeRecovery();
    }

    // ---- direct users ----

    /// @dev A direct deposit of 0.001 to 100 TAO, then the actor's opt-in to the door's chain (so its shares can be
    /// redeemed at the door). Refusals, in the vault's order: StakeMissing while stake is missing, VaultInsolvent
    /// below half the launch price or underwater, CapExceeded above the cap.
    function depositDirect(uint256 actorSeed, uint256 amount) external step mints probes {
        address actor = actors[actorSeed % actors.length];
        uint256 maxRao = Math.min(MAX_DEPOSIT, _sub0(actor.balance, FEE_MONEY)) / RAO;
        if (maxRao < 1e15 / RAO) return;
        amount = bound(amount, 1e15 / RAO, maxRao) * RAO;
        _directDeposit(actor, amount);
    }

    function _directDeposit(address actor, uint256 amount) internal returns (bool minted) {
        bool missing = vaultLens.stakeMissing();
        uint256 assets = vaultLens.totalAssets();
        bytes4 expect;
        if (missing) expect = StakeMissing.selector;
        else if (assets * 2_000_000 < vault.totalSupply() || _underwater()) expect = VaultInsolvent.selector;
        else if (assets + amount > vaultLens.maxTotalAssets()) expect = CapExceeded.selector;
        _arm();
        vm.prank(actor);
        try vault.depositDirect{value: amount}() {
            _succeeded(expect);
            ++directDeposits;
            minted = true;
            vm.prank(actor);
            vault.setRedeemOrigin(doorChain);
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, expect)) {
                if (missing) ++depositsRefusedWhileMissing;
                else ++depositsRefusedInsolvent;
            }
        }
    }

    /// @dev An unflagged direct exit of 1 to all of an actor's shares. Refusals: StakeMissing while stake is missing,
    /// else VaultModel's _exitPlan (ZeroAmount under a rao or when the walk's cost leaves nothing, UnstakeShort when the
    /// walk leaves more than T untaken). Its removals are booked in the ghost ledger, and its walk's cost is the
    /// leaver's (Task 36b): I-35 around it.
    function redeemDirect(uint256 actorSeed, uint256 shares) external step probes {
        (address actor, uint256 balance) = _actorWith(actorSeed);
        if (balance == 0) return;
        shares = bound(shares, 1, balance);
        bool missing = vaultLens.stakeMissing();
        bytes4 expect;
        if (missing) expect = StakeMissing.selector;
        _exit(actor, shares, false, expect);
    }

    /// @dev While stake is missing: a direct deposit of 1 TAO and a front-door deposit closed at once must be refused
    /// StakeMissing (the delivery filed by the bridge, MockBridge's form of the adapter's park); I-1 counts any mint.
    function depositWhileMissing(uint256 actorSeed, uint256 amount) external step mints probes {
        if (!vaultLens.stakeMissing()) return;
        address actor = actors[actorSeed % actors.length];
        ++probesOfDepositsWhileMissing;
        if (_sub0(actor.balance, FEE_MONEY) >= 1e18) _directDeposit(actor, 1e18);
        amount = bound(amount, 1e18 / RAO, 10e18 / RAO) * RAO;
        if (tao.balanceOf(actor) < amount || !_doorDeposit(actor, amount)) return;
        _warp(12 hours, doorBlockTime);
        if (vaultLens.stakeMissing()) _close();
    }

    /// @dev While stake is missing: an unflagged exit and a deposit must be refused StakeMissing, then the holder's
    /// flagged exit of 1 to all of its shares is paid exactly their value at min(visible, booked), floored to the
    /// rao, less what its receipts left unmet; the gross assets fall by exactly what it paid and what the chain kept,
    /// and every other holder's value neither falls by more than its share of what the holders absorbed nor rises past
    /// the leaver's rounding.
    function redeemDirectWhileMissing(uint256 actorSeed, uint256 shares) external step probes {
        if (!vaultLens.stakeMissing()) return;
        (address actor, uint256 balance) = _actorWith(actorSeed);
        if (balance == 0) return;
        shares = bound(shares, 1, balance);
        _exit(actor, shares, false, StakeMissing.selector);
        _consentedExit(actor, shares);
    }

    /// One direct exit as `actor`: `expect` (StakeMissing for an unflagged exit while stake is missing) or the state's
    /// own refusals (VaultModel's _exitPlan: ZeroAmount, UnstakeShort).
    function _exit(address actor, uint256 shares, bool acceptMissing, bytes4 expect) internal returns (bool paid) {
        uint256 out = CascadeMath.assetsForRedeem(shares, vaultLens.totalAssets(), vault.totalSupply());
        out -= out % RAO;
        uint256 available = _availableAt(vaultLens.pendingPayouts());
        // the walk's removals, its cost and the pay, predicted (fix round 2; Task 36b)
        ExitOut memory e = _exitPlan(available, out);
        if (expect == 0) expect = e.refusal;
        (bytes32[] memory hs, uint256[] memory ss) = _positions();
        uint256 stakeBefore = _coldkeyStake();
        uint256 vaultBefore = address(vault).balance;
        uint256 actorBefore = actor.balance;
        uint256 pendingBefore = vaultLens.pendingPayouts();
        uint256 unvestedBefore = vaultLens.unvestedRewards();
        uint256[3] memory mark = _markPrice();
        _arm();
        vm.prank(actor);
        try vault.redeemDirect(shares, acceptMissing) {
            _succeeded(expect);
            Vm.Log[] memory logs = _readLogs();
            uint256 taken = _taken(hs, ss);
            if (_bookRemovals(hs, ss) > 1) ++multiPositionWalks;
            _exitRemovals(logs, stakeBefore);
            _checkWalk(logs, e.walk);
            _checkExitPrice(mark);
            _checkUnmet(logs, out, available, vaultBefore, actor.balance - actorBefore, taken);
            if (actor.balance - actorBefore != e.paid) ++directMispaid;
            // the leaver is paid exactly its RedeemedDirect's assets, and a direct exit leaves the queued payouts and
            // the schedule as they were
            if (_eventPaid(logs) != actor.balance - actorBefore) ++directMispaid;
            if (vaultLens.pendingPayouts() != pendingBefore || vaultLens.unvestedRewards() != unvestedBefore) {
                ++directMispaid;
            }
            ++directRedeems;
            paid = true;
        } catch (bytes memory reason) {
            _dropLogs();
            _exitRefused(reason, expect, out);
            if (expect == StakeMissing.selector && _selector(reason) == StakeMissing.selector) {
                ++redeemsRefusedWhileMissing;
            }
        }
    }

    /// A direct exit's ShortfallAbsorbed (0 when none) must be what the handler measures its leaver bore (spec section
    /// 3.3; the leaver pays, Task 36b): what the stake its walk took (`taken`, the mock's positions before less after,
    /// at face value) left uncovered of the exit's value `out` beyond the liquid balance read before it, at most T, and
    /// the walk's cost, that stake less its receipts (the vault's balance after, plus what it `paid`, less before),
    /// rounded up to rao; else directMispaid (the fold checks the pay against it).
    function _checkUnmet(
        Vm.Log[] memory logs,
        uint256 out,
        uint256 available,
        uint256 vaultBefore,
        uint256 paid,
        uint256 taken
    ) internal {
        uint256 received = _sub0(address(vault).balance + paid, vaultBefore);
        uint256 unmet = _sub0(_sub0(out, available), taken);
        uint256 cost = Math.ceilDiv(_sub0(taken, received), RAO) * RAO;
        if (unmet > SHORTFALL_TOLERANCE || _absorbed(logs) != unmet + cost) ++directMispaid;
    }

    /// The stake a call's removals took off the listed positions `hs` (each `ss` before it), at face value, in wei.
    function _taken(bytes32[] memory hs, uint256[] memory ss) internal view returns (uint256 taken) {
        for (uint256 i; i < hs.length; ++i) {
            taken += _sub0(ss[i], _stakeOf(hs[i])) * RAO;
        }
    }

    /// The `assets` of the step's RedeemedDirect, which the fold prices against the ghosts: a direct exit must pay
    /// exactly that to the leaver, so the caller compares it with the leaver's balance change (type(uint256).max when
    /// no RedeemedDirect was logged, which no balance change equals).
    function _eventPaid(Vm.Log[] memory logs) internal view returns (uint256) {
        for (uint256 i; i < logs.length; ++i) {
            if (_isVaultLog(logs[i], RedeemedDirect.selector)) {
                (, uint256 assets,) = abi.decode(logs[i].data, (uint256, uint256, bool));
                return assets;
            }
        }
        return type(uint256).max;
    }

    function _exitRefused(bytes memory reason, bytes4 expect, uint256 out) internal {
        if (_selector(reason) == bytes4(0x4e487b71)) ++exitPanics;
        if (!_refused(reason, expect)) return;
        if (expect == UnstakeShort.selector) ++exitsUncoverable;
        else if (expect == ZeroAmount.selector && out != 0) ++exitsRefusedByCost;
    }

    /// The flagged exit while stake is missing, checked against the floor price and the other holders' values. What it
    /// takes is checked on the gross assets (the priced stake and the balance, less the reserve), which the exit moves
    /// by exactly what it paid and what the chain kept: the total assets are the gross less the queued payouts and the
    /// unvested rewards, floored at 0, and an exit of nearly every share whose receipt comes back short can take them
    /// below that floor (since Task 36b the leaver pays the chain's fee, so no exit holes the schedule; the check stays
    /// on the gross, which needs no floor), where a check on the floored total would read a mismatch that is not one.
    /// The gross identity has no term for the queued payouts or the schedule, so the exit must also leave both exactly
    /// as they were (a direct exit touches neither), and pay the leaver exactly its RedeemedDirect's `assets`.
    function _consentedExit(address actor, uint256 shares) internal {
        uint256 assets = vaultLens.totalAssets();
        uint256 grossBefore = vaultLens.grossAssets();
        uint256 pendingBefore = vaultLens.pendingPayouts();
        uint256 unvestedBefore = vaultLens.unvestedRewards();
        uint256 exact = CascadeMath.assetsForRedeem(shares, assets, vault.totalSupply());
        address[3] memory others;
        uint256[3] memory before;
        uint256 n;
        for (uint256 i; i < actors.length; ++i) {
            if (actors[i] != actor) others[n++] = actors[i];
        }
        others[2] = treasury;
        for (uint256 i; i < 3; ++i) {
            before[i] = _valueOf(others[i], 0);
        }
        uint256 balanceBefore = actor.balance;
        uint256 stakeBefore = _coldkeyStake();
        uint256 vaultBefore = address(vault).balance;
        uint256 available = _availableAt(vaultLens.pendingPayouts());
        uint256 out = exact - exact % RAO;
        ExitOut memory e = _exitPlan(available, out);
        bytes4 expect = e.refusal;
        (bytes32[] memory hs, uint256[] memory ss) = _positions();
        uint256[3] memory mark = _markPrice();
        _arm();
        vm.prank(actor);
        try vault.redeemDirect(shares, true) {
            _succeeded(expect);
            uint256 paid = actor.balance - balanceBefore;
            ++missingExits;
            Vm.Log[] memory logs = _readLogs();
            uint256 taken = _taken(hs, ss);
            if (_bookRemovals(hs, ss) > 1) ++multiPositionWalks;
            // what the chain kept of the stake the walk took: the leaver's own cost (Task 36b)
            uint256 short = _exitRemovals(logs, stakeBefore);
            _checkWalk(logs, e.walk);
            _checkExitPrice(mark);
            _checkUnmet(logs, out, available, vaultBefore, paid, taken);
            if (paid != e.paid) ++missingMispaid;
            if (vaultLens.grossAssets() + paid + short != grossBefore) ++missingMispaid;
            if (vaultLens.pendingPayouts() != pendingBefore || vaultLens.unvestedRewards() != unvestedBefore) {
                ++missingMispaid;
            }
            if (_eventPaid(logs) != paid) ++missingMispaid;
            // each stayer's value no lower (the leaver bore its exit's whole cost), and its gain at most what the
            // stayers keep, the shares' value less what was paid and what the chain kept, and its own floor's 1 wei
            uint256 kept = _sub0(_sub0(exact, paid), short);
            for (uint256 i; i < 3; ++i) {
                uint256 v = _valueOf(others[i], 0);
                if (v < before[i] || v > before[i] + kept + 1) ++missingOthersMoved;
            }
        } catch (bytes memory reason) {
            _dropLogs();
            _exitRefused(reason, expect, out);
        }
    }

    // ---- the keeper ----

    /// @dev The keeper stakes the idle balance onto the stake hotkey, one draw in four with a chain-side credit of 1
    /// to 1e6 rao landing inside the stake (MockStaking.setAddStakeCreditRao: R2 F3, it stays a surplus). The ghost
    /// books what the position rose by, at most what the balance paid; a fresh position read one rao short is I-4's
    /// last exception (recorded from the vault's Staked event, the stake hotkey empty before).
    function stakeIdle(uint256 creditSeed) external step probes {
        uint256 rao = _availableAt(vaultLens.pendingPayouts()) / RAO;
        if (rao < vaultLens.minStakeRao()) return;
        bytes32 h = vaultLens.stakeHotkey();
        uint256 heldBefore = _stakeOf(h);
        uint256 balanceBefore = address(vault).balance;
        bool missing = vaultLens.stakeMissing();
        uint256 credit = creditSeed % 4 == 0 ? bound(creditSeed >> 2, 1, 1e6) : 0;
        staking.setAddStakeCreditRao(credit);
        _readLogs();
        try vault.stakeIdle() {
            _bookStake(h, heldBefore, balanceBefore);
            ghostCreditsRao += credit;
            ++stakes;
            if (credit != 0) ++stakesWithCredit;
            if (missing) ++stakesWhileMissing;
            _freshRead(_readLogs(), heldBefore);
        } catch {
            _dropLogs();
            ++unexpectedReverts;
        }
        staking.setAddStakeCreditRao(0);
    }

    /// @dev Accrues 0.001 to 1 TAO on a listed hotkey (beside any credits a retained swap left there) and claims it as
    /// the keeper: paid as stake, or (one draw in four) as balance, and (one draw in eight) with the position falling
    /// during the claim. The ghost books the listed stake's rise, floored; a fall the claim does not make up is I-4's
    /// first exception (visible below booked); a cut minted while stake is missing, before or after, is an I-1 miss.
    function accrueAndClaim(uint256 hotkeySeed, uint256 rao, uint256 modeSeed) external step mints probes {
        uint256 n = vaultLens.hotkeyCount();
        bytes32 h = vaultLens.hotkeys(hotkeySeed % n);
        rao = bound(rao, 1e6, 1e9);
        uint256 credits = staking.getUnclaimedRootTaoByHotkey(coldkey, h) / RAO;
        staking.setUnclaimed(coldkey, h, credits + rao);
        bool toBalance = modeSeed % 4 == 0;
        uint256 fall = (modeSeed >> 2) % 8 == 0 ? bound(modeSeed >> 5, 1, 2 * rao) : 0;
        staking.setClaimToBalance(toBalance);
        staking.setClaimFallRao(fall);
        bool missing = vaultLens.stakeMissing();
        uint256 visibleBefore = _visible();
        uint256 pricedBefore = _priced();
        uint256 bookedBefore = vaultLens.bookedStake();
        uint256 cutsBefore = cutEvents;
        _arm();
        try vault.claimRewards{gas: 60_000_000}(h) {
            _readLogs();
            ghostBooked += _sub0(_visible(), visibleBefore);
            if (vaultLens.bookedStake() < bookedBefore) ++claimsLoweringLedger;
            if (cutEvents > cutsBefore && _ghostMissing()) ++mintsOrBurnsWhileMissing;
            if (cutEvents == cutsBefore && missing) ++cutsSkippedWhileMissing;
            ++claims;
            if (toBalance) ++claimsToBalance;
            if (fall != 0) ++claimsWithFall;
            if (missing) ++claimsWhileMissing;
            if (credits != 0) ++claimsOfCredits;
            uint256 left = _sub0(pricedBefore, _priced()) * RAO;
            if (left != 0) {
                ++i4ClaimFalls;
                _exception(left);
            }
        } catch {
            _dropLogs();
            ++unexpectedReverts;
        }
        staking.setClaimToBalance(false);
        staking.setClaimFallRao(0);
    }

    /// @dev The keeper adopts the surplus (Task 16): once it is at least the chain's minimum and a day has passed since
    /// the last adoption, adoptStake books it (the ghost: the visible stake) and vests it, so the price does not move
    /// at the adoption (I-3) and no surplus is left; before that, AdoptTooSoon (checked first) or BelowMinAdoption.
    function adopt() external step probes {
        uint256 surplus = vaultLens.surplusStakeRao();
        bytes4 expect;
        // test-controlled time
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < uint256(vaultLens.lastAdoptAt()) + 1 days) expect = AdoptTooSoon.selector;
        else if (surplus < vaultLens.minStakeRao()) expect = BelowMinAdoption.selector;
        uint256 priceBefore = vaultLens.price();
        _readLogs();
        try vault.adoptStake() {
            _succeeded(expect);
            ghostBooked = _visible();
            if (vaultLens.price() != priceBefore) ++adoptPriceMoves;
            if (vaultLens.surplusStakeRao() != 0) ++unexpectedAdoptions;
            ++adoptions;
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, expect)) ++adoptionsRefused;
        }
    }

    // ---- validators and the chain ----

    /// @dev A validator's swap moves `bps` (1 to 10_000) of the vault's position on a listed hotkey to a fresh hotkey
    /// the vault never listed (at most MAX_SWAPS a run): the price reads min(visible, booked), so it falls by the
    /// priced stake that left the set (I-4's first exception, its bound that stake); past the tolerance the guard
    /// holds.
    function swapAway(uint256 hotkeySeed, uint256 bps) external step probes {
        bytes32 from = _listedWithStake(hotkeySeed);
        if (from == bytes32(0) || _swapTargets.length >= MAX_SWAPS) return;
        bytes32 to = _newSwapTarget();
        uint256 pricedBefore = _priced();
        staking.swapHotkey(from, to, coldkey, bound(bps, 1, 10_000));
        _afterSwap(from, pricedBefore);
    }

    /// @dev A swap that retains part of the position on the old hotkey (0 to 9_999 bps moved) and root rewards there
    /// as credits (1 to 1e8 rao: MockStaking.swapHotkeyWithCredits), which a claim of the old hotkey pays as stake or
    /// as balance: the old hotkey is not empty, so only the owner's removeHotkey frees it (I-6's third precondition).
    function retainedSwapWithCredits(uint256 hotkeySeed, uint256 bps, uint256 creditRao) external step probes {
        bytes32 from = _listedWithStake(hotkeySeed);
        if (from == bytes32(0) || _swapTargets.length >= MAX_SWAPS) return;
        bytes32 to = _newSwapTarget();
        uint256 pricedBefore = _priced();
        staking.swapHotkeyWithCredits(from, to, coldkey, bound(bps, 0, 9_999), bound(creditRao, 1, 1e8));
        ++retainedSwaps;
        _afterSwap(from, pricedBefore);
    }

    function _afterSwap(bytes32 from, uint256 pricedBefore) internal {
        if (vaultLens.stakeMissing()) ++swapsMissing;
        else ++swapsWithinTolerance;
        if (from == vaultLens.stakeHotkey()) ++swapsOfTheStakeHotkey;
        uint256 left = _sub0(pricedBefore, _priced()) * RAO;
        if (left != 0) {
            ++i4Swaps;
            _exception(left);
        }
    }

    /// @dev Rarely (one draw in four, at most MAX_LOSSES a run) the chain loses part of a listed position for good
    /// (MockStaking.loseStake): stake missing that no hotkey holds, which only the owner's write-off can close. The
    /// price falls by the priced stake lost (I-4's first exception).
    function loseStake(uint256 hotkeySeed, uint256 rao) external step probes {
        if (hotkeySeed % 4 != 0 || losses >= MAX_LOSSES) return;
        bytes32 h = _listedWithStake(hotkeySeed >> 2);
        if (h == bytes32(0)) return;
        rao = bound(rao, 1, _stakeOf(h));
        uint256 pricedBefore = _priced();
        staking.loseStake(h, coldkey, rao);
        ghostLostRao += rao;
        ++losses;
        uint256 left = _sub0(pricedBefore, _priced()) * RAO;
        if (left != 0) {
            ++i4Losses;
            _exception(left);
        }
    }

    // ---- strangers ----

    /// @dev A stranger lists a hotkey (spec §3.1, I-6): a swap's new hotkey, one of the vault's own, one no one used,
    /// the zero hotkey, or one the vault once listed. Refusals, in the vault's order: NotEligible unless stake is
    /// missing, the hotkey holds at least the chain's minimum of the vault's root stake and the vault never listed it;
    /// then TooManyHotkeys for a full set (the last slot takes such an add). A stranger's listing of a hotkey the vault
    /// once listed counts in strangerListedOnceListed (I-6: none).
    function strangerAddHotkey(uint256 seed) external step probes {
        bytes32 h = _candidate(seed);
        bool swapped = vaultLens.stakeMissing() && _stakeOf(h) >= vaultLens.minStakeRao();
        bool onceListed = vaultLens.lastClaimAt(h) != 0;
        uint256 n = vaultLens.hotkeyCount();
        bytes4 expect;
        if (!swapped || onceListed) expect = NotEligible.selector;
        else if (h == bytes32(0)) expect = ZeroHotkey.selector;
        else if (vaultLens.isHotkey(h)) expect = HotkeyKnown.selector;
        else if (n >= MAX_HOTKEYS) expect = TooManyHotkeys.selector;
        _readLogs();
        vm.prank(stranger);
        try vault.addHotkey(h) {
            _succeeded(expect);
            if (onceListed) ++strangerListedOnceListed;
            ++strangerAdds;
            if (n == MAX_HOTKEYS - 1) ++strangerAddsFillingTheLastSlot;
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, expect)) ++strangerAddsRefused;
        }
    }

    /// @dev A stranger seeds a hotkey the vault listed and removed (still in the coldkey's staking set, so the reject
    /// flag lets the transfer through) with 0.002 to 100 TAO, then lists it: refused NotEligible even while stake is
    /// missing and it holds the minimum (I-6: a stranger can list no hotkey the vault ever listed). The seed is
    /// unlisted stake: it moves no price (I-3) and blocks as much write-off.
    function seedRemovedHotkey(uint256 seed, uint256 rao) external step probes {
        bytes32 h = _onceListedUnlisted(seed);
        if (h == bytes32(0)) return;
        rao = bound(rao, vaultLens.minStakeRao(), 100e9);
        _gift(h, 0, rao);
        _readLogs();
        vm.prank(stranger);
        try vault.addHotkey(h) {
            ++strangerListedOnceListed;
            ++unexpectedReverts;
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, NotEligible.selector)) {
                ++seedsRefused;
                if (vaultLens.stakeMissing()) ++seedsRefusedWhileMissing;
            }
        }
    }

    /// @dev Moves 1 rao to 100 TAO of root stake onto the vault's coldkey from outside: onto a listed hotkey (most
    /// draws), as alpha on subnet 7 onto one (one in eight), or onto a swap's unlisted hotkey (one in eight). It is
    /// never booked (only an adoption books a gift, I-3); while nothing is missing it moves no price, and while stake
    /// is missing a root gift on a listed hotkey makes up part of the gap, so the price may rise, by at most what it
    /// makes up, and never fall.
    function giftListed(uint256 targetSeed, uint256 rao) external step probes {
        rao = bound(rao, 1, 100e9);
        uint256 kind = targetSeed % 8;
        bytes32 h = vaultLens.hotkeys((targetSeed >> 3) % vaultLens.hotkeyCount());
        uint256 netuid;
        if (kind == 6) {
            netuid = 7;
            ++giftsAlpha;
        } else if (kind == 7 && _swapTargets.length != 0) {
            h = _swapTargets[(targetSeed >> 3) % _swapTargets.length];
            if (vaultLens.isHotkey(h)) return;
            ++giftsUnlisted;
        }
        _gift(h, netuid, rao);
    }

    /// One gift of `rao` onto (h, the vault's coldkey) on `netuid`, checked against I-3: the price may rise by at most
    /// the missing stake it makes up, the ghost ledger less the mock's listed positions (floored), never the lens's.
    function _gift(bytes32 h, uint256 netuid, uint256 rao) internal {
        uint256 bookedBefore = vaultLens.bookedStake();
        uint256 priceBefore = vaultLens.price();
        uint256 assetsBefore = vaultLens.totalAssets();
        bool missing = vaultLens.stakeMissing();
        uint256 missingRao = _sub0(ghostBooked, _visible());
        uint256 covered = netuid == 0 && vaultLens.isHotkey(h) ? Math.min(rao, missingRao) * RAO : 0;
        staking.donateStakeOnSubnet(h, coldkey, netuid, rao);
        if (vaultLens.bookedStake() != bookedBefore) ++giftsBooked;
        uint256 p = vaultLens.price();
        if (p < priceBefore || p > CascadeMath.price(assetsBefore + covered, vault.totalSupply())) ++giftPriceMoves;
        if (netuid == 0) ghostGiftsRao += rao;
        ++gifts;
        if (missing) ++giftsWhileMissing;
        if (_gap() == 0) holeWei = 0;
    }

    // ---- the keeper's and the owner's hotkeys ----

    /// @dev The keeper (or, by the draw, the owner or the guardian) lists a hotkey: one the vault once listed (its
    /// record kept), one of its own never listed, a swap's new hotkey or one no one used. Refusals, in the vault's
    /// order: HotkeyKnown, TooManyHotkeys, and SlotReserved for the add that would fill the last slot unless stake
    /// is missing and the hotkey holds the chain's minimum (round 8 L-2).
    function reAddHotkey(uint256 seed) external step probes {
        bytes32 h = _candidate(seed);
        if (h == bytes32(0)) h = HK2;
        address who = seed % 5 == 0 ? owner : (seed % 5 == 1 ? guardian : address(this));
        uint256 n = vaultLens.hotkeyCount();
        bool swapped = vaultLens.stakeMissing() && _stakeOf(h) >= vaultLens.minStakeRao();
        bool onceListed = vaultLens.lastClaimAt(h) != 0;
        bytes4 expect;
        if (vaultLens.isHotkey(h)) expect = HotkeyKnown.selector;
        else if (n >= MAX_HOTKEYS) expect = TooManyHotkeys.selector;
        else if (n == MAX_HOTKEYS - 1 && !swapped) expect = SlotReserved.selector;
        _readLogs();
        vm.prank(who);
        try vault.addHotkey(h) {
            _succeeded(expect);
            ++reAdds;
            if (onceListed) ++reAddsOfOnceListed;
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, expect)) {
                ++reAddsRefused;
                if (expect == SlotReserved.selector) ++slotsReservedRefused;
            }
        }
    }

    /// @dev One of the three removal paths (spec §3.1), by the draw: the owner's (forfeit or not), the keeper's or
    /// the guardian's, a stranger's, of a listed hotkey (the stake hotkey included) or an unlisted one. Refusals, in
    /// L4's order: UnknownHotkey, HotkeyInUse; NotAuthorized for anyone but the owner while it holds stake; then the
    /// owner's HotkeyHasRewards (unclaimed above the dust, no forfeit), the keeper's or guardian's NotAuthorized above
    /// the dust, a stranger's NotAuthorized unless nothing is unclaimed, the set is full and stake is missing. The
    /// owner's removal moves a leftover of at least the minimum onto the stake hotkey (no booking; a move into an empty
    /// stake hotkey read one rao short is I-4's first exception, any other fall an overrun: _moveShort) or removes one
    /// below it into balance (booked as a removal; the chain's cut of it the holders absorb, I-4's exception at most the
    /// removal fee: no exit, the owner's housekeeping, the founder's answer 4).
    function removeHotkey(uint256 seed) external step probes {
        uint256 n = vaultLens.hotkeyCount();
        bytes32 h = seed % 7 == 0 ? _candidate(seed >> 3) : vaultLens.hotkeys((seed >> 3) % n);
        uint256 who = (seed >> 1) % 4;
        bool forfeit = (seed >> 2) % 2 == 1;
        address remover = who == 0 ? owner : (who == 1 ? address(this) : (who == 2 ? guardian : stranger));
        bytes4 expect = _removalRefusal(h, who, forfeit, n);
        uint256 leftover = _stakeOf(h);
        bool intoBalance = leftover != 0 && leftover < vaultLens.minStakeRao();
        uint256 pricedBefore = _priced();
        uint256 heldBefore = _stakeOf(vaultLens.stakeHotkey());
        bool exact = staking.exactStakeReads();
        uint256 stakeBefore = _coldkeyStake();
        (bytes32[] memory hs, uint256[] memory ss) = _positions();
        _readLogs();
        vm.prank(remover);
        try vault.removeHotkey(h, forfeit) {
            _succeeded(expect);
            Vm.Log[] memory logs = _readLogs();
            if (who == 0) {
                ++removalsByOwner;
                if (intoBalance) {
                    ++removalsIntoBalance;
                    _bookRemovals(hs, ss);
                    _ownerRemovalCut(logs, stakeBefore, staking.removeFeeRao() * RAO);
                } else if (leftover != 0) {
                    ++removalsMovingStake;
                    _moveShort(pricedBefore, heldBefore, exact);
                }
            } else if (who == 3) {
                ++removalsByStranger;
            } else {
                ++removalsByKeeper;
            }
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, expect)) ++removalsRefused;
        }
    }

    /// The refusal L4 makes of a removal of `h` by `who` (0 the owner, 1 the keeper, 2 the guardian, 3 a stranger), or
    /// none.
    function _removalRefusal(bytes32 h, uint256 who, bool forfeit, uint256 n) internal view returns (bytes4) {
        if (!vaultLens.isHotkey(h)) return UnknownHotkey.selector;
        if (h == vaultLens.stakeHotkey()) return HotkeyInUse.selector;
        if (_stakeOf(h) != 0 && who != 0) return NotAuthorized.selector;
        uint256 unclaimed = staking.getUnclaimedRootTaoByHotkey(coldkey, h);
        bool aboveDust = unclaimed > vaultLens.hotkeyDustRao() * RAO;
        if (who == 0) return !forfeit && aboveDust ? HotkeyHasRewards.selector : bytes4(0);
        if (who != 3) return aboveDust ? NotAuthorized.selector : bytes4(0);
        bool refused = unclaimed != 0 || n != MAX_HOTKEYS || !vaultLens.stakeMissing();
        return refused ? NotAuthorized.selector : bytes4(0);
    }

    /// @dev The owner points new stake at a listed hotkey X (setStakeHotkey): at once when it follows stake that
    /// moved (X holds more than the stake hotkey and at least half the booked stake), else refused NotScheduled, and
    /// then, on one draw in two, run as its scheduled item (48 hours); an unlisted X is refused NotListed.
    function followStake(uint256 seed) external step probes {
        bytes32 x = seed % 8 == 0 ? _candidate(seed >> 3) : vaultLens.hotkeys((seed >> 3) % vaultLens.hotkeyCount());
        bytes32 current = vaultLens.stakeHotkey();
        if (x == current) return;
        bool listed = vaultLens.isHotkey(x);
        bool atOnce = _stakeOf(x) > _stakeOf(current) && _stakeOf(x) >= vaultLens.bookedStake() / 2;
        bytes4 expect = !listed ? NotListed.selector : (atOnce ? bytes4(0) : NotScheduled.selector);
        _readLogs();
        vm.prank(owner);
        try vault.setStakeHotkey(x) {
            _succeeded(expect);
            ++stakeHotkeySwitches;
        } catch (bytes memory reason) {
            _dropLogs();
            if (!_refused(reason, expect)) return;
            ++stakeHotkeySwitchesRefused;
            if (expect != NotScheduled.selector || (seed >> 1) % 2 == 0) return;
            bytes memory data = abi.encodeCall(CascadeVault.setStakeHotkey, (x));
            if (_tryRunScheduled(vault, data)) {
                if (vaultLens.stakeHotkey() != x) ++unexpectedReverts;
                ++stakeHotkeySwitchesScheduled;
            }
        }
    }

    /// @dev The owner's scheduled moveStake (48 hours) of up to twice what a listed non-stake hotkey holds onto the
    /// stake hotkey, clamped at execute to the position: within the set, so the ghost books nothing and the priced
    /// stake stays where it was, but for a move into an empty stake hotkey read one rao short, I-4's first exception
    /// (_moveShort: any other fall is an overrun).
    function moveStake(uint256 seed, uint256 rao) external step probes {
        _moveStake(seed, rao);
    }

    /// @dev A targeted draw (Task 42, ruling B9: i4MoveShorts, unreached by the campaign before): a listed hotkey that
    /// holds nothing becomes the stake hotkey (its scheduled setStakeHotkey, 48 hours), the mock's one-rao-short read of
    /// a fresh position is switched on, and the owner's scheduled moveStake moves stake onto it from a listed hotkey
    /// that holds some: the credit into the empty position reads one rao short, I-4's first exception (_moveShort).
    function moveIntoEmpty(uint256 seed, uint256 rao) external step probes {
        bytes32 current = vaultLens.stakeHotkey();
        uint256 n = vaultLens.hotkeyCount();
        bytes32 empty;
        for (uint256 i; i < n; ++i) {
            bytes32 h = vaultLens.hotkeys((seed % n + i) % n);
            if (h != current && _stakeOf(h) == 0) {
                empty = h;
                break;
            }
        }
        if (empty == bytes32(0) || _listedWithStake(seed) == bytes32(0)) return;
        if (!_tryRunScheduled(vault, abi.encodeCall(CascadeVault.setStakeHotkey, (empty)))) return;
        if (vaultLens.stakeHotkey() != empty) ++unexpectedReverts;
        if (staking.exactStakeReads()) ++readSwitches;
        staking.setOneRaoShort(true);
        _moveStake(seed, rao);
        ++moveIntoEmptyDraws;
    }

    /// moveStake's body (see it).
    function _moveStake(uint256 seed, uint256 rao) internal {
        bytes32 to = vaultLens.stakeHotkey();
        bytes32 from = _listedWithStake(seed);
        if (from == bytes32(0) || from == to) return;
        rao = bound(rao, 1, 2 * _stakeOf(from));
        bytes memory data = abi.encodeCall(CascadeVault.moveStake, (from, to, rao));
        _scheduleAndWait(vault, data);
        uint256 pricedBefore = _priced();
        uint256 heldBefore = _stakeOf(to);
        bool exact = staking.exactStakeReads();
        _readLogs();
        vm.prank(owner);
        try vault.execute(data) {
            ++moves;
            _moveShort(pricedBefore, heldBefore, exact);
        } catch (bytes memory reason) {
            _dropLogs();
            _refused(reason, 0);
        }
    }

    /// The vault's own move of stake onto the stake hotkey (moveStake, or the owner's removal moving a leftover), from
    /// the priced stake before it, what the destination held before it (`heldBefore`) and whether the mock's reads were
    /// exact (`exact`). A move is within the set (spec §3.1), so it books nothing and leaves the priced stake where it
    /// was, with one exception: a credit into an empty position may read one rao short (the mock's fresh read applies
    /// to moveStake too), which leaves visible below booked, I-4's first exception. It is recorded only when all three
    /// hold: the destination held nothing, the short reads were on, and the priced stake fell by at most a rao. Any
    /// other fall (stake moved off the list, say) is an overrun, as for _freshRead.
    function _moveShort(uint256 pricedBefore, uint256 heldBefore, bool exact) internal {
        uint256 left = _sub0(pricedBefore, _priced()) * RAO;
        if (left == 0) return;
        if (heldBefore == 0 && !exact && left <= RAO) ++i4MoveShorts;
        else ++exceptionOverruns;
        _exception(left);
    }

    // ---- the owner's write-off ----

    /// @dev The owner's write-off (spec §3.1, §3.6): always while stake is missing, one draw in eight otherwise. On one
    /// draw in four the owner first calls writeOffMissingStake directly (refused NotScheduled). The amount is drawn
    /// from the state at scheduling: the bound itself (missing less unlisted), one rao past it, or anywhere up to
    /// twice the missing stake. It is scheduled (an Ordinary item: ExitsNotOpen while the exits are closed, never in
    /// this campaign), executed early (refused NotReady), its 7 days and blocks waited out (Schedule.run's steps),
    /// then executed: WriteOffTooLarge when what is unlisted exceeds the missing stake less min(rao, missing) at
    /// execute (the item kept); else the booked stake falls by exactly that, never below the visible, and the price
    /// does not move (I-4).
    function writeOff(uint256 raoSeed, uint256 modeSeed) external step probes {
        if (!vaultLens.stakeMissing() && modeSeed % 8 != 0) return;
        if ((modeSeed >> 3) % 4 == 0) {
            _readLogs();
            vm.prank(owner);
            try vault.writeOffMissingStake(raoSeed) {
                ++unexpectedReverts;
            } catch (bytes memory reason) {
                _dropLogs();
                if (_refused(reason, NotScheduled.selector)) ++writeOffsUnscheduled;
            }
        }
        uint256 rao = _writeOffDraw(raoSeed, modeSeed >> 5);
        bytes memory data = abi.encodeCall(CascadeVault.writeOffMissingStake, (rao));
        if (!vaultLens.exitsOpen()) {
            _readLogs();
            vm.prank(owner);
            try vault.schedule(data) {
                ++unexpectedReverts;
            } catch (bytes memory reason) {
                _dropLogs();
                _refused(reason, ExitsNotOpen.selector);
            }
            return;
        }
        _ownerSchedules(vault, data);
        _readLogs();
        vm.prank(owner);
        try vault.execute(data) {
            ++unexpectedReverts;
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, NotReady.selector)) ++writeOffsEarly;
        }
        _waitTheDelay(vault, data);
        _executeWriteOff(data, rao);
    }

    /// The write-off's amount, from the state now (see writeOff).
    function _writeOffDraw(uint256 raoSeed, uint256 kind) internal view returns (uint256) {
        uint256 missing = _sub0(ghostBooked, _visible());
        uint256 bound_ = _sub0(missing, _unlisted());
        if (kind % 3 == 0) return bound_;
        if (kind % 3 == 1) return bound_ + 1;
        return bound(raoSeed, 0, 2 * missing + 1);
    }

    function _executeWriteOff(bytes memory data, uint256 rao) internal {
        uint256 missing = _sub0(ghostBooked, _visible());
        uint256 w = Math.min(rao, missing);
        bool wasMissing = vaultLens.stakeMissing();
        bytes4 expect = _unlisted() > missing - w ? WriteOffTooLarge.selector : bytes4(0);
        uint256 priceBefore = vaultLens.price();
        uint256 bookedBefore = vaultLens.bookedStake();
        _readLogs();
        vm.prank(owner);
        try vault.execute(data) {
            _succeeded(expect);
            Vm.Log[] memory logs = _readLogs();
            ghostBooked -= w;
            if (vaultLens.price() != priceBefore) ++writeOffPriceMoves;
            if (vaultLens.bookedStake() != bookedBefore - w || !_loggedWriteOff(logs, w)) ++writeOffMisbooked;
            // a write-off of something lowers the booked stake to the visible at most (w <= missing); one of nothing
            // leaves it where it was, below the visible when a gift waits as a surplus
            if (w != 0 && vaultLens.bookedStake() < _visible()) ++writeOffsBelowVisible;
            ++writeOffs;
            if (w != 0) ++writeOffsOfSomething;
            if (wasMissing && !vaultLens.stakeMissing()) ++writeOffsReopening;
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, expect)) ++writeOffsTooLarge;
        }
    }

    function _loggedWriteOff(Vm.Log[] memory logs, uint256 w) internal view returns (bool) {
        for (uint256 i; i < logs.length; ++i) {
            if (_isVaultLog(logs[i], StakeWrittenOff.selector)) return abi.decode(logs[i].data, (uint256)) == w;
        }
        return false;
    }

    // ---- the front door ----

    /// @dev An actor deposits 1 to 100 TAO at the front door (the open batch; its limits never refuse here).
    function doorDeposit(uint256 actorSeed, uint256 amount) external step probes {
        address actor = actors[actorSeed % actors.length];
        uint256 maxRao = Math.min(MAX_DEPOSIT, tao.balanceOf(actor)) / RAO;
        if (maxRao < 1e18 / RAO) return;
        _doorDeposit(actor, bound(amount, 1e18 / RAO, maxRao) * RAO);
    }

    function _doorDeposit(address actor, uint256 amount) internal returns (bool ok) {
        _readLogs();
        vm.prank(actor);
        try fd.deposit(amount) {
            ++doorDeposits;
            ok = true;
        } catch {
            _dropLogs();
            ++unexpectedReverts;
        }
    }

    /// @dev An actor without a request in the open batch asks the door to redeem its shares worth 0.05 TAO (above the
    /// smallest redeem the vault burns, MIN_REDEEM_VALUE, so few are deferred) up to all of them, paying the request
    /// fee; on one draw in two the keeper then closes the batch at once (12 hours on, as closeBatch does), so
    /// burning deliveries and their payouts are reached within a run.
    function doorRedeem(uint256 actorSeed, uint256 shares) external step mints probes {
        address actor = actors[actorSeed % actors.length];
        uint256 balance = vault.balanceOf(actor);
        if (balance == 0 || fd.redeemOf(actor) != 0) return;
        uint256 fee = fd.redeemRequestFee();
        uint256 least = CascadeMath.sharesForDeposit(0.05e18, vaultLens.totalAssets(), vault.totalSupply());
        shares = bound(shares, Math.min(least, balance), balance);
        _readLogs();
        vm.prank(actor);
        try fd.requestRedeem{value: fee}(shares) {
            ++doorRedeems;
        } catch {
            _dropLogs();
            ++unexpectedReverts;
            return;
        }
        if ((actorSeed >> 8) % 2 == 0) {
            _warp(12 hours, doorBlockTime);
            _close();
        }
    }

    /// @dev Warps 12 hours (the door's timer) and closes the open batch, the handler paying what its pot lacks of the
    /// bridge's fee; MockBridge delivers at once. The delivery's refusals, as the bridge files them, in the vault's
    /// order: StakeMissing while stake is missing, VaultInsolvent at a supply of 0 underwater. A burning delivery's
    /// windows are checked against the allowance on the ghost base (I-5).
    /// Then, as the keeper's round does, it sends the next chunk of a queued batch whose payout delay has passed, if
    /// any (_payout).
    function closeBatch() external step mints probes {
        _warp(12 hours, doorBlockTime);
        _close();
        uint256 delay = vaultLens.payoutDelay();
        for (uint256 i; i < queuedKeys.length; ++i) {
            // test-controlled time
            // forge-lint: disable-next-line(block-timestamp)
            if (vm.getBlockTimestamp() >= uint256(vaultLens.getPayoutBatch(queuedKeys[i]).queuedAt) + delay) {
                _payout(queuedKeys[i]);
                break;
            }
        }
    }

    function _close() internal {
        (uint64 id,,, uint256 pot, uint256 nDeposits, uint256 nRedeems) = fd.openBatch();
        if (nDeposits + nRedeems == 0 || !fd.canClose()) return;
        uint256 value = _sub0(BRIDGE_FEE, pot);
        (uint256 doorBefore, uint256 globalBefore) = _windows();
        _arm();
        try fd.closeBatch{value: value}(id, 0) {
            ++closes;
            _recordDelivery(_readLogs(), doorBefore, globalBefore);
        } catch {
            _dropLogs();
            ++unexpectedReverts;
        }
    }

    /// @dev Re-runs the oldest delivery the bridge filed as refused: it delivers once the state allows, else the
    /// bridge files it again, as expected while that state lasts.
    function retryDelivery() external step mints probes {
        if (bridge.failedCount() == 0) return;
        uint256 delivered = deliveries;
        (uint256 doorBefore, uint256 globalBefore) = _windows();
        _arm();
        bridge.retryNext();
        _recordDelivery(_readLogs(), doorBefore, globalBefore);
        if (deliveries > delivered) ++retriesDelivered;
    }

    /// @dev Warps 24 hours (the vault's payout delay) and sends the next chunk of a queued batch as the keeper
    /// (_payout).
    function processPayouts(uint256 keySeed) external step probes {
        uint256 nKeys = queuedKeys.length;
        if (nKeys == 0) return;
        _warp(24 hours, vaultBlockTime);
        _payout(queuedKeys[keySeed % nKeys]);
    }

    /// The next chunk of batch `key` (its payout delay passed), as the keeper, at the bridge's fee (within the ceiling,
    /// so no top-up). Its refusal is VaultModel's _chunkOutcome on the chunk's need at that fee (UnstakeShort when the
    /// walk leaves more than T untaken or its receipts do not fund the send, FeeTooHigh when its cost would leave an
    /// entry nothing), and a success where one was predicted is unexpected; the walk's removals are booked in the ghost
    /// ledger, and its cost is the chunk's entries' (Task 36b): I-35 around it.
    function _payout(bytes32 key) internal {
        CascadeMessages.Payout[] memory list = _lists[key];
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        // the walk, its cost and finish's checks, predicted on what the chunk pays at the bridge's fee (fix round 2;
        // Task 36b)
        ChunkOut memory o = _chunkOutcome(list, b, PAYOUT_ENTRIES, bridge.fee(), 0);
        (bytes32[] memory hs, uint256[] memory ss) = _positions();
        uint256 stakeBefore = _coldkeyStake();
        uint256[3] memory mark = _markPrice();
        _readLogs();
        try vault.processPayouts(key, list, PAYOUT_ENTRIES) {
            _succeeded(o.refusal);
            Vm.Log[] memory logs = _readLogs();
            if (_bookRemovals(hs, ss) > 1) ++multiPositionWalks;
            _exitRemovals(logs, stakeBefore);
            _checkExitPrice(mark);
            _checkWalk(logs, o.walk);
            for (uint256 i; i < logs.length; ++i) {
                if (logs[i].emitter == address(bridge) && logs[i].topics[0] == MockBridge.DeliveryFailed.selector) {
                    ++unexpectedReverts;
                }
                if (_isVaultLog(logs[i], PayoutChunkSent.selector)) ++payoutChunks;
            }
            if (vaultLens.getPayoutBatch(key).count == 0) _dropKey(key);
        } catch (bytes memory reason) {
            _dropLogs();
            if (_selector(reason) == bytes4(0x4e487b71)) ++exitPanics;
            if (!_refused(reason, o.refusal)) return;
            if (o.refusal == FeeTooHigh.selector) ++chunksRefusedWalkCost;
            else ++payoutsUncoverable;
        }
    }

    // ---- time and the chain's settings ----

    /// @dev Time on both chains, rolled at the front door's calibrated 120 ms blocks (which meet the vault's floors too).
    function warp(uint256 secs) external step probes {
        _warp(bound(secs, 1 hours, 3 days), doorBlockTime);
    }

    /// @dev The chain's fee on each stake removal: 0 one draw in three, else 1 to MAX_REMOVE_FEE_RAO rao one in three,
    /// else 1,001, 50,000, 4,000,000 or 16,000,000 rao (Task 36b: each the walking exit's own cost).
    function setRemoveFee(uint256 seed) external step probes {
        uint256 fee;
        if (seed % 3 == 1) fee = bound(seed / 3, 1, MAX_REMOVE_FEE_RAO);
        else if (seed % 3 == 2) fee = [uint256(1_001), 50_000, 4_000_000, 16_000_000][(seed / 3) % 4];
        if (fee != staking.removeFeeRao()) ++feeSwitches;
        staking.setRemoveFeeRao(fee);
    }

    /// @dev Whether a credit into an empty position reads one rao short.
    function setFreshRead(uint256 seed) external step probes {
        bool short = seed % 2 == 1;
        // exactStakeReads is the mock's inverse of the one-rao-short read
        if (short == staking.exactStakeReads()) ++readSwitches;
        staking.setOneRaoShort(short);
    }

    // ---- I-6: the probes ----

    /// While stake is missing, the three ways back, each in a snapshot reverted after it (see the contract's notes).
    function _probeRecovery() internal {
        if (!vaultLens.stakeMissing()) return;
        ++recoveryProbes;
        _readLogs();
        Plan memory s = _strangerPlan();
        uint256 snap = vm.snapshotState();
        (bool cleared, bool refused) = _runPlan(s, stranger, false);
        vm.revertToStateAndDelete(snap);
        _dropLogs();
        if (refused) ++planRefusals;
        if (cleared != s.applies) ++strangerFailures;
        if (s.applies) {
            ++probesStranger;
        } else {
            _countWhyNot();
            Plan memory o = _ownerPlan();
            snap = vm.snapshotState();
            (cleared, refused) = _runPlan(o, owner, true);
            vm.revertToStateAndDelete(snap);
            _dropLogs();
            if (refused) ++planRefusals;
            if (o.applies) {
                ++probesOwner;
                if (!cleared) ++ownerFailures;
            } else {
                ++probesGiftOnly;
            }
        }
        snap = vm.snapshotState();
        bool giftClears = _giftClears();
        vm.revertToStateAndDelete(snap);
        _dropLogs();
        if (!giftClears) ++giftFailures;
    }

    /// The stranger's plan: the swaps' new hotkeys the vault never listed that hold at least the chain's minimum, the
    /// largest first, as many as the free slots and the removable old hotkeys (listed, not the stake hotkey, no stake,
    /// nothing unclaimed) allow, a removal before each add once the set is full. It applies when listing them clears
    /// the missing state.
    function _strangerPlan() internal view returns (Plan memory p) {
        uint256 min = vaultLens.minStakeRao();
        bytes32[] memory u = _byStake(_swapsNeverListed(min));
        p.removes = _emptyOldHotkeys(false);
        uint256 room = MAX_HOTKEYS - vaultLens.hotkeyCount() + p.removes.length;
        p.adds = _take(u, room);
        p.applies = _clears(p.adds);
    }

    /// The owner's plan: remove every listed hotkey but the stake hotkey (forfeiting what it owes; its stake moves to
    /// the stake hotkey or, below the minimum, into balance), then list every unlisted hotkey holding the coldkey's
    /// stake, the largest first, two into the free slots and the last slot's only one of at least the minimum. It
    /// applies when its adds clear the missing state (a removal moves no gap but the fresh read's rao, counted).
    function _ownerPlan() internal view returns (Plan memory p) {
        p.removes = _emptyOldHotkeys(true);
        bytes32[] memory u = _byStake(_unlistedWithStake());
        uint256 free = MAX_HOTKEYS - 1;
        uint256 min = vaultLens.minStakeRao();
        uint256 k = Math.min(u.length, free);
        if (k == free && _stakeOf(u[free - 1]) < min) --k;
        p.adds = _take(u, k);
        uint256 shortRead = _stakeOf(vaultLens.stakeHotkey()) == 0 && !staking.exactStakeReads() ? 1 : 0;
        uint256 belowMin;
        uint256 movedAny;
        for (uint256 i; i < p.removes.length; ++i) {
            uint256 s = _stakeOf(p.removes[i]);
            if (s != 0 && s < min) belowMin += s;
            else if (s != 0) movedAny = 1;
        }
        uint256 added;
        for (uint256 i; i < p.adds.length; ++i) {
            added += _stakeOf(p.adds[i]);
        }
        uint256 booked = ghostBooked - Math.min(ghostBooked, belowMin);
        uint256 visible = _visible() - belowMin - shortRead * movedAny + added;
        p.applies = !_missingAt(visible, booked);
    }

    /// Runs plan `p` as `who`: its removals (all first when `allFirst`, else one before each add the full set needs),
    /// then its adds, stopping once nothing is missing. Returns whether it ended with nothing missing (the vault's own
    /// reading, the outcome under test), and whether a planned step was refused, or the plan ran out of the removals
    /// the full set needed, either of which ends it: every step a plan makes is one the spec allows its maker in that
    /// state, so either is a model error or a vault bug, whether or not the plan applies (planRefusals).
    function _runPlan(Plan memory p, address who, bool allFirst) internal returns (bool cleared, bool refused) {
        uint256 r;
        if (allFirst) {
            for (; r < p.removes.length; ++r) {
                vm.prank(who);
                try vault.removeHotkey(p.removes[r], true) {}
                catch {
                    return (false, true);
                }
            }
        }
        for (uint256 i; i < p.adds.length && vaultLens.stakeMissing(); ++i) {
            if (vaultLens.hotkeyCount() == MAX_HOTKEYS) {
                if (r == p.removes.length) return (false, true);
                vm.prank(who);
                try vault.removeHotkey(p.removes[r++], false) {}
                catch {
                    return (false, true);
                }
            }
            vm.prank(who);
            try vault.addHotkey(p.adds[i]) {}
            catch {
                return (false, true);
            }
        }
        return (!vaultLens.stakeMissing(), false);
    }

    /// A gift of the missing stake (the ghost ledger less the mock's listed positions) onto the stake hotkey clears the
    /// state, and the price is then what the booked stake prices (the ghost's, read on the mock's positions): never
    /// above it (I-6: harmless).
    function _giftClears() internal returns (bool) {
        uint256 missing = _sub0(ghostBooked, _visible());
        staking.donateStake(vaultLens.stakeHotkey(), coldkey, missing);
        return !vaultLens.stakeMissing() && vaultLens.totalAssets() == _assetsAt(ghostBooked);
    }

    /// Why the stranger's plan does not apply: the first of I-6's preconditions that fails. No unlisted stake would
    /// clear it (a loss or a claim's fall: not a swap's state); only with a once-listed hotkey's stake would it (a
    /// seed, or a gift on a swap's hotkey the vault listed and removed: no stranger may list it, the owner, guardian
    /// or keeper may); the swaps' never-listed hotkeys would, but not those holding the chain's minimum; then an old
    /// hotkey not empty, or too few slots.
    function _countWhyNot() internal {
        uint256 min = vaultLens.minStakeRao();
        if (!_clears(_unlistedWithStake())) {
            ++probesNotASwap;
        } else if (!_clears(_swapsNeverListed(1))) {
            ++probesSeededOnly;
        } else if (!_clears(_swapsNeverListed(min))) {
            ++probesSubMinimum;
        } else if (_clears(
                _take(
                    _byStake(_swapsNeverListed(min)),
                    MAX_HOTKEYS - vaultLens.hotkeyCount() + _emptyOldHotkeys(true).length
                )
            )) {
            ++probesOldNotEmpty;
        } else {
            ++probesSlotsShort;
        }
    }

    /// Whether listing `hs` (unlisted) would leave nothing missing, on the mock's positions and the ghost ledger.
    function _clears(bytes32[] memory hs) internal view returns (bool) {
        uint256 visible = _visible();
        for (uint256 i; i < hs.length; ++i) {
            visible += _stakeOf(hs[i]);
        }
        return !_missingAt(visible, ghostBooked);
    }

    /// The swaps' new hotkeys the vault never listed holding at least `min` of the coldkey's stake.
    function _swapsNeverListed(uint256 min) internal view returns (bytes32[] memory out) {
        out = new bytes32[](_swapTargets.length);
        uint256 n;
        for (uint256 i; i < _swapTargets.length; ++i) {
            bytes32 h = _swapTargets[i];
            if (!vaultLens.isHotkey(h) && vaultLens.lastClaimAt(h) == 0 && _stakeOf(h) >= min) out[n++] = h;
        }
        assembly ("memory-safe") {
            mstore(out, n)
        }
    }

    /// Every unlisted hotkey of the pool holding any of the coldkey's root stake.
    function _unlistedWithStake() internal view returns (bytes32[] memory out) {
        out = new bytes32[](_pool.length);
        uint256 n;
        for (uint256 i; i < _pool.length; ++i) {
            bytes32 h = _pool[i];
            if (!vaultLens.isHotkey(h) && _stakeOf(h) != 0) out[n++] = h;
        }
        assembly ("memory-safe") {
            mstore(out, n)
        }
    }

    /// The listed hotkeys but the stake hotkey: every one (`any`), or those a stranger may remove (no stake, nothing
    /// unclaimed).
    function _emptyOldHotkeys(bool any) internal view returns (bytes32[] memory out) {
        uint256 n = vaultLens.hotkeyCount();
        bytes32 first = vaultLens.stakeHotkey();
        out = new bytes32[](n);
        uint256 m;
        for (uint256 i; i < n; ++i) {
            bytes32 h = vaultLens.hotkeys(i);
            if (h == first) continue;
            if (any || (_stakeOf(h) == 0 && staking.getUnclaimedRootTaoByHotkey(coldkey, h) == 0)) out[m++] = h;
        }
        assembly ("memory-safe") {
            mstore(out, m)
        }
    }

    /// `hs` sorted by the coldkey's stake, the largest first.
    function _byStake(bytes32[] memory hs) internal view returns (bytes32[] memory) {
        for (uint256 i; i < hs.length; ++i) {
            for (uint256 j = i + 1; j < hs.length; ++j) {
                if (_stakeOf(hs[j]) > _stakeOf(hs[i])) (hs[i], hs[j]) = (hs[j], hs[i]);
            }
        }
        return hs;
    }

    /// The first `k` of `hs` (all of them when fewer).
    function _take(bytes32[] memory hs, uint256 k) internal pure returns (bytes32[] memory out) {
        k = Math.min(k, hs.length);
        out = new bytes32[](k);
        for (uint256 i; i < k; ++i) {
            out[i] = hs[i];
        }
    }

    // ---- I-1: the fold ----

    /// Reads the logs so far (so the next read is exactly the coming call's) and arms the state the coming call's mints
    /// and burns are folded with: whether stake is missing (the restated tolerance on the mock's positions and the
    /// ghost ledger), whether the vault is underwater as a deposit reads it (at a supply of 0, the schedule written
    /// down) and as the cut reads it (the schedule as it is), both by the spec's rule as written, and the assets and
    /// supply a direct exit is priced at, the assets from the mock's positions and the ghost ledger.
    function _arm() internal {
        _readLogs();
        _armed = Arm({
            missing: _ghostMissing(),
            underwater: _underwater(),
            underwaterRaw: _underwaterAs(false),
            assets: _assetsAt(ghostBooked),
            supply: vault.totalSupply()
        });
    }

    /// The base's fold (I-33's sets, I-34's sums), then I-1's: each mint and burn against the armed state.
    function _onLogs(Vm.Log[] memory logs) internal override {
        super._onLogs(logs);
        Arm memory a = _armed;
        uint256 unmet;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory log = logs[i];
            if (log.emitter != address(vault) || log.topics.length == 0) continue;
            bytes32 sig = log.topics[0];
            if (sig == Deposited.selector || sig == DepositedDirect.selector || sig == RewardCutMinted.selector) {
                if (sig == Deposited.selector) ++depositedEvents;
                else if (sig == DepositedDirect.selector) ++depositedDirectEvents;
                else ++cutEvents;
                if (a.missing) ++mintsOrBurnsWhileMissing;
                if (sig == RewardCutMinted.selector ? a.underwaterRaw : a.underwater) ++mintsWhileUnderwater;
            } else if (sig == Redeemed.selector) {
                ++redeemedEvents;
                if (a.missing) ++mintsOrBurnsWhileMissing;
            } else if (sig == ShortfallAbsorbed.selector) {
                // everything the leaver bore: what its walk left untaken and the walk's cost (Task 36b)
                unmet = abi.decode(log.data, (uint256));
            } else if (sig == RedeemedDirect.selector) {
                (uint256 shares, uint256 assets, bool accepted) = abi.decode(log.data, (uint256, uint256, bool));
                ++directRedeemEvents;
                if (accepted) ++flaggedDirectRedeems;
                if (accepted != a.missing) ++directFlagMismatches;
                uint256 out = CascadeMath.assetsForRedeem(shares, a.assets, a.supply);
                out -= out % RAO;
                uint256 owed = _sub0(out, unmet);
                if (assets != owed - owed % RAO) ++directMispaid;
                unmet = 0;
            }
        }
    }

    // ---- deliveries ----

    /// Reads one delivery attempt: a refusal the bridge filed must be the state's (StakeMissing while stake is missing,
    /// VaultInsolvent at a supply of 0 underwater, both armed before the call); a delivery queues its payout list and,
    /// when it burned, its windows must have grown by no more than the allowance on the ghost base leaves (I-5).
    function _recordDelivery(Vm.Log[] memory logs, uint256 doorBefore, uint256 globalBefore) internal {
        bool burned;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory log = logs[i];
            if (log.emitter == address(bridge) && log.topics[0] == MockBridge.DeliveryFailed.selector) {
                (, bytes memory reason) = abi.decode(log.data, (uint256, bytes));
                bytes4 r = _selector(reason);
                if (r == StakeMissing.selector && _armed.missing) {
                    ++deliveriesRefusedWhileMissing;
                } else if (r == VaultInsolvent.selector && vault.totalSupply() == 0 && _armed.underwater) {
                    ++deliveriesRefusedUnderwater;
                } else {
                    ++unexpectedReverts;
                }
                continue;
            }
            if (log.emitter != address(vault)) continue;
            bytes32 sig = log.topics[0];
            if (sig == BatchDelivered.selector) {
                ++deliveries;
            } else if (sig == DepositBounced.selector) {
                (uint256 assets,) = abi.decode(log.data, (uint256, uint8));
                _lists[log.topics[1]].push(CascadeMessages.Payout(_topicAddress(log.topics[2]), 0, assets));
            } else if (sig == Redeemed.selector) {
                (uint256 shares, uint256 assets) = abi.decode(log.data, (uint256, uint256));
                _lists[log.topics[1]].push(CascadeMessages.Payout(_topicAddress(log.topics[2]), shares, assets));
                burned = true;
            } else if (sig == PayoutBatchQueued.selector) {
                queuedKeys.push(log.topics[1]);
            } else if (sig == RedeemDeferred.selector || sig == RedeemSkipped.selector) {
                ++redeemsHeldBack;
            }
        }
        if (!burned) return;
        ++burningDeliveries;
        (uint256 doorAfter, uint256 globalAfter) = _windows();
        uint256 base_ = ghostBase();
        uint256 floor = vaultLens.minDailyOutflow();
        uint256 doorCap = Math.max(base_ * vaultLens.maxDailyOutflowBps() / 10_000, floor);
        uint256 globalCap = Math.max(base_ * vaultLens.globalOutflowBps() / 10_000, floor);
        if (doorAfter - doorBefore > _sub0(doorCap, doorBefore)) ++doorWindowOverruns;
        if (globalAfter - globalBefore > _sub0(globalCap, globalBefore)) ++globalWindowOverruns;
    }

    /// What the door's window and the global one have burned in their current day (the lens serves a window past its
    /// day as L1 would start it).
    function _windows() internal view returns (uint256 door, uint256 global) {
        (, door) = vaultLens.burnWindows(peer);
        (, global) = vaultLens.burnWindows(GLOBAL_WINDOW);
    }

    function _dropKey(bytes32 key) internal {
        uint256 n = queuedKeys.length;
        for (uint256 i; i < n; ++i) {
            if (queuedKeys[i] == key) {
                queuedKeys[i] = queuedKeys[n - 1];
                queuedKeys.pop();
                break;
            }
        }
        delete _lists[key];
    }

    // ---- reads (the positions, the listed stake, the assets, the ghost's removals and base are VaultModel's) ----

    /// The coldkey's root stake off the list.
    function _unlisted() internal view returns (uint256) {
        return _sub0(_coldkeyStake(), _visible());
    }

    /// min(visible, booked) on the mock's positions and the ghost ledger.
    function _priced() internal view returns (uint256) {
        return Math.min(_visible(), ghostBooked);
    }

    /// Whether stake is missing on the ghosts: the mock's listed positions against the ghost ledger (VaultModel's
    /// _missingAt).
    function _ghostMissing() internal view returns (bool) {
        return _missingAt(_visible(), ghostBooked);
    }

    function _valueOf(address a, uint256 givenBack) internal view returns (uint256) {
        uint256 assets = vaultLens.totalAssets() + givenBack;
        return CascadeMath.assetsForRedeem(vault.balanceOf(a), assets, vault.totalSupply());
    }

    /// The first actor from `seed` on holding shares, or (actors[seed], 0).
    function _actorWith(uint256 seed) internal view returns (address actor, uint256 shares) {
        for (uint256 i; i < actors.length; ++i) {
            actor = actors[(seed % actors.length + i) % actors.length];
            shares = vault.balanceOf(actor);
            if (shares != 0) return (actor, shares);
        }
        return (actors[seed % actors.length], 0);
    }

    /// The first listed hotkey from `seed` on holding stake, or 0.
    function _listedWithStake(uint256 seed) internal view returns (bytes32) {
        uint256 n = vaultLens.hotkeyCount();
        for (uint256 i; i < n; ++i) {
            bytes32 h = vaultLens.hotkeys((seed % n + i) % n);
            if (_stakeOf(h) != 0) return h;
        }
        return bytes32(0);
    }

    /// The first hotkey of the pool from `seed` on that the vault listed and removed, or 0.
    function _onceListedUnlisted(uint256 seed) internal view returns (bytes32) {
        uint256 n = _pool.length;
        for (uint256 i; i < n; ++i) {
            bytes32 h = _pool[(seed % n + i) % n];
            if (!vaultLens.isHotkey(h) && vaultLens.lastClaimAt(h) != 0) return h;
        }
        return bytes32(0);
    }

    /// A hotkey a listing (or a removal, or a switch) names, by `seed` mod 8: the swap's new hotkey holding the most of
    /// the vault's stake off the list (0 to 3: the way back a stranger or the keeper takes; else any swap's new hotkey,
    /// else one of the vault's own), one of the vault's own (4), the one no one used (5), the zero hotkey (6), or one
    /// the vault once listed and removed (7; the vault's own when there is none).
    function _candidate(uint256 seed) internal view returns (bytes32) {
        uint256 kind = seed % 8;
        uint256 pick = seed / 8;
        if (kind < 4) {
            bytes32 best;
            for (uint256 i; i < _swapTargets.length; ++i) {
                bytes32 t = _swapTargets[i];
                if (!vaultLens.isHotkey(t) && _stakeOf(t) > _stakeOf(best)) best = t;
            }
            if (best != bytes32(0)) return best;
            if (_swapTargets.length != 0) return _swapTargets[pick % _swapTargets.length];
        }
        if (kind == 5) return NEVER;
        if (kind == 6) return bytes32(0);
        if (kind == 7) {
            bytes32 h = _onceListedUnlisted(pick);
            if (h != bytes32(0)) return h;
        }
        bytes32[3] memory own = [firstHotkey, HK2, HK3];
        return own[pick % 3];
    }

    function _newSwapTarget() internal returns (bytes32 h) {
        h = bytes32(uint256(SWAP_BASE + _swapTargets.length + 1));
        _swapTargets.push(h);
        _pool.push(h);
        _trackWord(h, WordKind.Hotkey);
    }

    // ---- views for the tests (the walk's, walkCovers, is VaultModel's) ----

    function swapTargets() external view returns (bytes32[] memory) {
        return _swapTargets;
    }

    function queuedCount() external view returns (uint256) {
        return queuedKeys.length;
    }

    /// The vault's coldkey's root stake off the list, and the listed stake, as the handler reads them on the mock.
    function unlistedRao() external view returns (uint256) {
        return _unlisted();
    }

    function visibleRao() external view returns (uint256) {
        return _visible();
    }

    /// The vault's assets on the ghosts (`_assetsAt(ghostBooked)`): min(visible, booked) priced on the mock's
    /// positions and the ghost ledger, plus the balance, less the reserve, the queued payouts and the unvested rewards
    /// (I-3, after every step: a gift is priced only once adopted, booked, or unstaked into balance).
    function ghostAssets() external view returns (uint256) {
        return _assetsAt(ghostBooked);
    }
}
