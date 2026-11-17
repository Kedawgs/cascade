// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeBase} from "../../../src/CascadeBase.sol";
import {CascadeVault} from "../../../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../../../src/CascadeFrontDoor.sol";
import {CascadeBaseLens} from "../../../src/lens/CascadeBaseLens.sol";
import {ICascadeBridge} from "../../../src/interfaces/ICascadeBridge.sol";
import {ICascadeTwap} from "../../../src/interfaces/ICascadeTwap.sol";
import {CascadeMessages} from "../../../src/libraries/CascadeMessages.sol";
import {Actor, Delay, DoorState, Item, Kind, PayoutBatch} from "../../../src/CascadeTypes.sol";
import {DIRECT_ORIGIN, MAX_FEE_ABS} from "../../../src/CascadeConstants.sol";
import {
    AboveBridgeCap,
    AlreadyActive,
    BadCalldata,
    BadStamp,
    BridgeNotEnabled,
    ExitsNotOpen,
    FeeTooHigh,
    FrontDoorInactive,
    HotkeyInUse,
    InvalidParameter,
    LapsedItem,
    NoProposal,
    NotCanceller,
    NotGuardian,
    NotListed,
    NotReady,
    NotScheduled,
    PayoutDelayed,
    PeerNotActive,
    PrimaryBridgeDisabled,
    PrimaryStillEnabled,
    StampOutOfWindow,
    UnknownHotkey,
    UnknownSelector,
    ZeroAddress
} from "../../../src/CascadeErrors.sol";
import {
    Cancelled,
    Executed,
    ExitsClosed,
    Lapsed,
    PayoutBatchQueued,
    Redeemed,
    Scheduled,
    StampedBySig
} from "../../../src/CascadeEvents.sol";
import {MockBridge} from "../../mocks/MockBridge.sol";
import {MockTAO} from "../../mocks/MockTAO.sol";
import {ProbeBridge} from "../../mocks/ProbeBridge.sol";
import {Schedule} from "../../governance/Schedule.sol";
import {
    Stamps,
    STAMP_VECTOR_AS_OF,
    STAMP_VECTOR_DOOR_SIG,
    STAMP_VECTOR_VAULT_SIG
} from "../../governance/StampVector.sol";
import {TrackedHandler} from "./TrackedHandler.sol";

/// @notice The governance campaign's handler (Task 39a; spec §3.6, I-22 to I-25 and I-29), on GovernanceFixture's world:
/// the vault and the launch front door, each with its scheduler, both lenses, three bridges (the launch rail, bridge2
/// with a smaller cap, and ProbeBridge, which re-enters its caller), three doors on the vault (the launch door, a second
/// launch-chain door, a door on chain 10) and one holder, alice, whose redeems queue launch-door payout batches.
///
/// **The actors.** The **owner** schedules random setters from the setter table on either target, executes ghost items
/// (after waiting to their readyAt, one second short of it, at the window's end, one second past it, or across a chain
/// halt that left the blocks behind), calls setters directly (tightenings, equal values, loosenings, values past a
/// bound), cancels, and plays every instrument (both pauses and unpauses, the door removals, every bridge's disable,
/// setPrimaryBridge, the launch-door payout cancel); the **guardian** (whoever the target names now: setGuardian swaps it
/// between `guardian` and `guardian2`) cancels and plays its instruments; the **stranger** relays the owner's signed
/// stamps (the founder's 12-hour stack, on-demand ones, ones aimed at an item's schedule time or the second before it,
/// replays, the window's edges, future ones, and stamps under a wrong key, a high s, a bad v, a bad length, the other
/// target's or another chain's domain, and StampVector's vector) and prunes; and every actor, the targets themselves
/// included, tries each scheduled-only path directly. The setter table spans tightening, equal and loosening values, the
/// bounds and one past them; the activations name new, known (Removed, or a known bridge) and guardian-removed doors and
/// bridges.
///
/// **The ghost log and the model** are the handler's own. Each item's life (scheduled, executed, cancelled, killed by a
/// clock, pruned, re-scheduled) is recorded at the handler's own successful call and checked against the call's events
/// (Scheduled with the handler's kind, readyAt and calldata; Executed; Cancelled with its canceller; Lapsed; StampedBySig
/// with its asOf and relayer; ExitsClosed exactly when an instrument stamps); its readyAt is the spec's class delay
/// (Schedule.delayOf) and its readyBlock half of it in its target's calibrated blocks, and it lapses once both its window
/// in time and its window in blocks (half EXECUTE_WINDOW in those blocks) have passed (Revision 28): the handler's own
/// arithmetic. The model holds every field
/// any setter, instrument or stamp writes on either target (`_m`, NF fields), moved only by the handler's successful
/// calls as their rules say: a direct setter only when it does not loosen, an item only through an execute the ghost log
/// says is pending, ready in time and in blocks, not lapsed, past its gate and not killed by its clock, an
/// instrument by its row of spec §3.6's table, a stamp to max(clock, asOf). After every step the invariants compare the
/// ghost log with both lenses' `scheduled` (`ghostMismatch`) and the model with the contracts (`modelMismatch`).
///
/// **Expected refusals.** Every call's outcome is predicted from the model and the ghost log, in the contract's check
/// order, as full revert data (`_judge`): a success where a refusal was predicted, a refusal where none was, and another
/// refusal than the one predicted each count in `unexpectedReverts`, and the violation counters (I-22's
/// `executeViolations` and `unscheduledLoosenings`, I-23's `tighteningsRefused`, I-24's `cancelViolations` and
/// `schedulesByOthers`, I-25's `selfCallsAdmitted` and `reentriesAdmitted`, I-29's `stampViolations` and `killMisses`)
/// name which invariant a wrong outcome breaks.
contract GovernanceHandler is TrackedHandler {
    // ---- the world ----

    uint8 internal constant V = 0;
    uint8 internal constant D = 1;
    uint64 internal constant BASE_CHAIN = 8453;
    uint64 internal constant SECOND_CHAIN = 10;
    /// Spec §3.6's EXECUTE_WINDOW and STAMP_MAX_TTL, the handler's own (the lenses serve the contracts').
    uint64 internal constant WINDOW = 7 days;
    uint64 internal constant TTL = 1 days;
    /// The founder's pre-signed stamps, 12 hours apart (Task 48's STAMP_SPACING_HOURS).
    uint64 internal constant SPACING = 12 hours;
    bytes32 internal constant HK1 = bytes32(uint256(1));
    bytes32 internal constant HK2 = bytes32(uint256(2));
    /// Never listed.
    bytes32 internal constant HK3 = bytes32(uint256(3));
    uint256 internal constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    uint256 internal constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant FEE = 1e15;

    // ---- the vault's bounds (internal constants no lens serves: CascadeVault.sol's, pinned by the campaign's
    // test_theVaultBoundsAreTheContracts; the rest are read from the contracts: the lens's MAX_REWARD_CUT_BPS,
    // MIN_CLAIM_GAS and MAX_CLAIM_GAS, CascadeConstants' MAX_FEE_ABS, CascadeMessages' MAX_ENTRIES, the front door's
    // public constants) ----

    uint256 public constant MIN_PAYOUT_DELAY = 1 hours;
    uint256 public constant MAX_PAYOUT_DELAY = 48 hours;
    uint256 public constant MIN_OUTFLOW_BPS = 2_000;
    uint256 public constant MAX_OUTFLOW_BPS = 5_000;
    uint256 public constant MIN_MIN_DAILY_OUTFLOW = 10e18;
    uint256 public constant MAX_MIN_DAILY_OUTFLOW = 100e18;
    uint256 public constant MIN_ENTRY_VALUE = 10e18;
    uint256 public constant MAX_MESSAGE_VALUE = 5_000e18;
    uint256 public constant MAX_FEE_BPS = 500;
    uint256 public constant MIN_FEE_ABS = 0.01e18;
    uint256 public constant MAX_UNSTAKE_MARGIN_RAO = 1e9;
    uint256 public constant MIN_UNSTAKE_GAS = 150_000;
    uint256 public constant MAX_UNSTAKE_GAS = 5_000_000;
    uint256 public constant MAX_IDLE_BUFFER_BPS = 1_000;
    uint256 public constant MAX_HOTKEY_DUST_RAO = type(uint256).max / 1e9;
    uint256 public constant MIN_REWARD_VESTING = 1 days;
    uint256 public constant MAX_REWARD_VESTING = 30 days;

    /// What the fixture adds (GovernanceFixture.deployGovernance) and the keys.
    struct Wiring {
        MockTAO tao;
        MockBridge bridge;
        MockBridge bridge2;
        ProbeBridge probe;
        address door2;
        address door3;
        address guardian2;
        address owner2;
        address stranger;
        address alice;
        address treasury;
        address twap;
        address swapper;
        uint256 ownerKey;
        uint256 guardianKey;
        uint256 owner2Key;
        uint256 strangerKey;
    }

    Wiring internal w;
    bool internal _wired;
    /// The bridges both targets know of, by index: the launch rail, bridge2 and the probe.
    address[3] public bridges;
    /// The vault's doors, by index: the launch door and a second door on BASE, and a door on SECOND_CHAIN.
    uint64[3] public doorChains;
    address[3] public doorAddrs;
    /// The guardian candidates: a swap moves a target between them.
    address[2] public guardians;
    /// The founder's stack starts here (the campaign's start), and the block then.
    uint64 public stackStart;
    uint256 public blockStart;

    // ---- the model: every field a setter, an instrument or a stamp writes, on both targets ----

    /// CascadeBase's fields of target t sit at t * NB + k.
    uint256 internal constant F_GUARDIAN = 0;
    uint256 internal constant F_OWNER = 1;
    uint256 internal constant F_PENDING_OWNER = 2;
    uint256 internal constant F_PENDING_SINCE = 3;
    uint256 internal constant F_PRIMARY = 4;
    uint256 internal constant F_DISABLED_BY = 5;
    uint256 internal constant F_OWNER_CLOCK = 6;
    uint256 internal constant F_GUARDIAN_CLOCK = 7;
    uint256 internal constant F_PAUSED = 8;
    /// bridgeEnabled and bridgeKnown of each of the three bridges.
    uint256 internal constant F_ENABLED = 9;
    uint256 internal constant F_KNOWN = 12;
    uint256 internal constant NB = 15;
    // the vault's own
    uint256 internal constant V_MAX_TOTAL = 30;
    uint256 internal constant V_BPS = 31;
    uint256 internal constant V_FLOOR = 32;
    uint256 internal constant V_GLOBAL = 33;
    uint256 internal constant V_ENTRY = 34;
    uint256 internal constant V_MSG = 35;
    uint256 internal constant V_MIN_CHUNK = 36;
    uint256 internal constant V_FEE_BPS = 37;
    uint256 internal constant V_FEE_ABS = 38;
    uint256 internal constant V_DELAY = 39;
    uint256 internal constant V_TREASURY = 40;
    uint256 internal constant V_CUT = 41;
    uint256 internal constant V_VESTING = 42;
    uint256 internal constant V_IDLE = 43;
    uint256 internal constant V_STAKE_HK = 44;
    uint256 internal constant V_KEEPER = 45;
    uint256 internal constant V_MIN_DIRECT = 46;
    uint256 internal constant V_CLAIM_GAS = 47;
    uint256 internal constant V_DUST = 48;
    uint256 internal constant V_MARGIN = 49;
    uint256 internal constant V_UNSTAKE_GAS = 50;
    uint256 internal constant V_BOOKED = 51;
    uint256 internal constant V_PAUSED_BY = 52;
    uint256 internal constant V_LAUNCH_BY = 53;
    /// activeDoors(BASE_CHAIN), then activeDoors(SECOND_CHAIN).
    uint256 internal constant V_ACTIVE = 54;
    /// doorState of each of the three doors.
    uint256 internal constant V_DOOR = 56;
    // the front door's own
    uint256 internal constant D_ORACLE = 59;
    uint256 internal constant D_SWAPPER = 60;
    uint256 internal constant D_SLIPPAGE = 61;
    uint256 internal constant D_INTERVAL = 62;
    uint256 internal constant D_MAX_BATCH = 63;
    /// minPoolLiquidity(0), then (1).
    uint256 internal constant D_POOL = 64;
    uint256 internal constant D_MIN_DEPOSIT = 66;
    uint256 internal constant D_CAP = 67;
    uint256 internal constant D_MAX_DEPOSITS = 68;
    uint256 internal constant D_MAX_REDEEMS = 69;
    uint256 internal constant D_REQUEST_FEE = 70;
    uint256 internal constant D_KEEPER = 71;
    uint256 public constant NF = 72;

    uint256[72] internal _m;

    // ---- the ghost log ----

    enum Life {
        None,
        Pending,
        Executed,
        Cancelled,
        Pruned,
        Replaced
    }

    /// One scheduled life of an item: its target, its calldata, when it was scheduled, when it is ready in time and in
    /// blocks (the handler's own arithmetic), its class and kind (the handler's own classification), and how its life
    /// ended. `killedBy` records which clock killed it while it was pending (1 the owner's instrument, 2 the guardian's,
    /// 3 a stamp; 0 none): a reporting record, since an item's death is read from the model's clocks.
    struct Ghost {
        uint8 t;
        Life life;
        Kind kind;
        Delay cls;
        uint8 killedBy;
        uint64 scheduledAt;
        uint64 readyAt;
        uint64 readyBlock;
        bytes data;
    }

    Ghost[] internal _ghosts;
    /// The pending ghost of (target, id), as index + 1; 0 when none.
    mapping(uint8 => mapping(bytes32 => uint256)) internal _live;
    /// Every id either target ever scheduled, once.
    bytes32[] internal _ids;
    mapping(bytes32 => bool) internal _isId;

    /// The valid stamps relayed so far (for replays): their target, asOf and signature.
    struct Relayed {
        uint8 t;
        uint64 asOf;
        bytes sig;
    }

    Relayed[] internal _relayed;

    // ---- the payout queue: launch-door batches, one redeem each ----

    struct Queued {
        bytes32 key;
        address user;
        uint256 shares;
        uint256 assets;
    }

    Queued[] internal _queued;

    // ---- violations: each names the invariant a wrong outcome breaks ----

    /// I-22: an execute that succeeded where the ghost log says the item was not pending, not ready in time or in
    /// blocks, past its window, refused by its gate or killed by its clock; a direct setter call that loosened; an
    /// acceptance that succeeded where its gate refuses it; an event of the handler's own call other than predicted.
    uint256 public executeViolations;
    uint256 public unscheduledLoosenings;
    uint256 public acceptanceViolations;
    uint256 public eventMismatches;
    /// I-23: a tightening (or an equal or bounded immediate value) the owner called directly that was refused.
    uint256 public tighteningsRefused;
    /// I-24: a cancel that succeeded where spec §3.6's table refuses it; a schedule by anyone but the owner.
    uint256 public cancelViolations;
    uint256 public schedulesByOthers;
    /// I-25: a scheduled-only path that a direct call reached; a re-entry ProbeBridge saw admitted.
    uint256 public selfCallsAdmitted;
    uint256 public reentriesAdmitted;
    /// I-29: a stamp refused or admitted other than predicted; a probe of a pending item after a stamp whose outcome
    /// (killed or alive) was not the ghost log's.
    uint256 public stampViolations;
    uint256 public killMisses;

    // ---- reachability ----

    uint256 public schedules;
    uint256 public schedulesRefused;
    uint256 public schedulesRefusedGate;
    uint256 public reschedules;
    uint256 public schedulesByKind0;
    uint256 public schedulesByKind1;
    uint256 public schedulesByKind2;
    uint256 public doorItemsScheduled;
    uint256 public executes;
    uint256 public executesOfLoosenings;
    uint256 public executesRefusedNotReady;
    uint256 public executesRefusedBlocks;
    uint256 public executesRefusedLapsed;
    uint256 public executesRefusedDead;
    uint256 public executesRefusedGate;
    uint256 public executesRefusedSetter;
    uint256 public executesRefusedNoProposal;
    uint256 public executesAtWindowEnd;
    /// Executes that ran past their window in time, kept by their window in blocks (after a halt: Revision 28).
    uint256 public executesInTheBlockWindow;
    uint256 public doorItemsExecuted;
    uint256 public activationsNew;
    uint256 public activationsKnown;
    uint256 public activationsGuardianRemoved;
    uint256 public bridgeActivationsNew;
    uint256 public bridgeActivationsKnown;
    uint256 public guardianSwaps;
    uint256 public transfersExecuted;
    uint256 public directTightenings;
    uint256 public directEquals;
    uint256 public directImmediates;
    uint256 public directLooseningsRefused;
    uint256 public directBoundsRefused;
    uint256 public cancelsByOwner;
    uint256 public cancelsByGuardian;
    uint256 public cancelsRefusedGuardian;
    uint256 public cancelsRefusedOthers;
    uint256 public cancelsOfDeadItems;
    uint256 public prunes;
    uint256 public prunesRefused;
    /// Prunes refused NotReady past the item's window in time, its window in blocks still open (Revision 28).
    uint256 public prunesRefusedInTheBlockWindow;
    uint256 public pausesByOwner;
    uint256 public pausesByGuardian;
    uint256 public doorPauses;
    uint256 public unpauses;
    uint256 public instrumentsRefused;
    uint256 public removalsByOwner;
    uint256 public removalsByGuardian;
    uint256 public guardianRemovalsOfRemoved;
    uint256 public reopensDeleted;
    uint256 public launchHoldsByRemoval;
    uint256 public holdsConverted;
    uint256 public removalsRefused;
    uint256 public primaryDisables;
    uint256 public doorPrimaryDisables;
    uint256 public otherDisables;
    uint256 public primarySwitches;
    uint256 public switchesRefusedCap;
    uint256 public stampsRelayed;
    uint256 public stampsMovingTheClock;
    /// Replays of a valid stamp relayed before (accepted in its window; past it, refused).
    uint256 public stampsReplayed;
    uint256 public replaysOutOfWindow;
    uint256 public stampsOutOfWindow;
    uint256 public stampsBadSignature;
    uint256 public stampsAimedAtAnItem;
    uint256 public killProbes;
    uint256 public itemsKilledByOwner;
    uint256 public itemsKilledByGuardian;
    uint256 public itemsKilledByStamp;
    uint256 public selfCallsRefused;
    uint256 public reentryProbes;
    uint256 public reentryProbesInExecute;
    uint256 public acceptanceProbes;
    uint256 public acceptancesAdmitted;
    uint256 public redeemsQueued;
    uint256 public payoutsSent;
    uint256 public payoutsRefusedPaused;
    uint256 public payoutsRefusedDelayed;
    uint256 public payoutsRefusedDoorDown;
    uint256 public payoutsRefusedBridgeDown;
    uint256 public payoutsRefusedBothDown;
    uint256 public payoutsThroughProbe;
    uint256 public batchCancels;
    uint256 public halts;
    /// haltPastTheWindow's steps (Revision 28, the review's M-2).
    uint256 public haltsPastTheWindow;
    uint256 public runsInOneStep;
    /// The lone loosenings of the multi-field setters' fields (see _loneLoosening), by field: the owner's direct calls
    /// (each must be refused NotScheduled) and the executed items (each must apply).
    uint256[10] public directLone;
    uint256[10] public executedLone;
    /// pastABound's probes: each direct call, and each one scheduled and executed.
    uint256 public boundsProbed;
    uint256 public boundsProbedAtExecute;
    // the views the core campaign only compared at zero, at a step's end (BoundaryInvariants compares them after it)
    uint256 public stepsWithDoorItems;
    uint256 public stepsWithVaultItems;
    uint256 public stepsWithDoorClocks;
    uint256 public stepsWithDoorHold;
    uint256 public stepsWithVaultPrimaryHold;
    uint256 public stepsWithPausedBy;
    uint256 public stepsWithPendingSinceVault;
    uint256 public stepsWithPendingSinceDoor;

    constructor(System memory s) TrackedHandler(s) {}

    receive() external payable {}

    /// Once, from the campaign's setUp after deployGovernance: the fixture's parts, the argument sets they add, and the
    /// model's first values, read from the contracts as deployed (from here on only the handler's own calls move it).
    function wire(Wiring memory w_) external {
        require(!_wired, "wired");
        _wired = true;
        w = w_;
        bridges = [address(w_.bridge), address(w_.bridge2), address(w_.probe)];
        doorChains = [BASE_CHAIN, BASE_CHAIN, SECOND_CHAIN];
        doorAddrs = [address(fd), w_.door3, w_.door2];
        guardians = [guardian, w_.guardian2];
        stackStart = uint64(vm.getBlockTimestamp());
        blockStart = vm.getBlockNumber();
        address[9] memory accounts = [
            w_.guardian2,
            w_.owner2,
            w_.stranger,
            w_.alice,
            address(w_.bridge2),
            address(w_.probe),
            w_.door2,
            w_.door3,
            w_.twap
        ];
        for (uint256 i; i < accounts.length; ++i) {
            _trackAccount(accounts[i]);
        }
        _trackAccount(w_.swapper);
        _trackAccount(_treasury2());
        for (uint256 i; i < 3; ++i) {
            _trackPeer(doorChains[i], doorAddrs[i]);
        }
        _trackWord(HK1, WordKind.Hotkey);
        _trackWord(HK2, WordKind.Hotkey);
        _trackWord(HK3, WordKind.Hotkey);
        for (uint256 f; f < NF; ++f) {
            _m[f] = _read(f);
        }
        require(_m[V_BOOKED] == 0 && vaultLens.visibleStakeRao() == 0, "no stake: every setStakeHotkey loosens");
    }

    /// Once, from the setUp: alice deposits 100 TAO at the launch door and the batch closes, so she holds shares whose
    /// redeems queue launch-door payout batches (queueRedeem), aged past the door hold. A step, so the mint's Transfer
    /// is folded (I-34).
    function seedHolder() external step {
        address alice = w.alice;
        w.tao.mint(alice, 100e18);
        vm.prank(alice);
        w.tao.approve(address(fd), type(uint256).max);
        vm.prank(alice);
        fd.deposit(100e18);
        _warp(fd.batchInterval(), doorBlockTime);
        (uint64 id,,,,,) = fd.openBatch();
        fd.closeBatch{value: FEE}(id, 0);
        require(vault.balanceOf(alice) != 0, "alice holds shares");
        // a holder of long standing: her shares aged past the door hold (R4 B-H1), so a redeem the campaign queues burns
        _age(alice);
    }

    /// While a pin's entry point runs: its choices are the pin's, so no follow-up is drawn (the instruments' payout tries,
    /// the owner's Reopen and the guardian's answer after a removal, the acceptance after a transfer).
    bool internal _pinned;

    modifier pinned() {
        _pinned = true;
        _;
        _pinned = false;
    }

    /// @dev At each step's end: whether the views the core campaign compared only at zero are non-zero now
    /// (BoundaryInvariants compares both lenses with the targets right after).
    modifier act() {
        _;
        bool doorItems;
        bool vaultItems;
        for (uint256 i; i < _ids.length; ++i) {
            if (_live[D][_ids[i]] != 0) doorItems = true;
            if (_live[V][_ids[i]] != 0) vaultItems = true;
        }
        if (doorItems) ++stepsWithDoorItems;
        if (vaultItems) ++stepsWithVaultItems;
        if (_m[_f(D, F_OWNER_CLOCK)] != 0 || _m[_f(D, F_GUARDIAN_CLOCK)] != 0) ++stepsWithDoorClocks;
        if (_m[_f(D, F_DISABLED_BY)] != 0) ++stepsWithDoorHold;
        if (_m[_f(V, F_DISABLED_BY)] != 0) ++stepsWithVaultPrimaryHold;
        if (_m[V_PAUSED_BY] != 0) ++stepsWithPausedBy;
        if (_m[_f(V, F_PENDING_SINCE)] != 0) ++stepsWithPendingSinceVault;
        if (_m[_f(D, F_PENDING_SINCE)] != 0) ++stepsWithPendingSinceDoor;
        _afterAct();
    }

    /// @dev At each action's end, after the counts above: a subclass's checks of the state the action left (Task 39b's
    /// snapshot probes, LivenessHandler). None here.
    function _afterAct() internal virtual {}

    // =====================================================================================================
    // the owner's scheduler
    // =====================================================================================================

    /// @dev The owner (or, one draw in sixteen, the guardian or the stranger, refused OwnableUnauthorizedAccount: I-24's
    /// "the guardian can schedule nothing") schedules a setter-table item on either target (`_generate`), or, one draw in
    /// sixteen, a malformed one (one byte too many: BadCalldata) or an immediate setter (UnknownSelector). Predicted in
    /// the scheduler's order: the caller, the classification (its canonical length, the activation's target), then the
    /// kind's gate and clock. A success must log Scheduled with the handler's id, kind, readyAt and calldata, and starts a
    /// ghost life (a re-schedule ends the pending one). While the probe is a target's primary, one draw in four schedules
    /// the setter whose cap check calls it. One success in two runs at once (Schedule.run's steps, so nothing kills it
    /// first), after, one draw in four each, an execute one second short of its readyAt or across a halt (NotReady).
    function schedule(uint256 entrySeed, uint256 argSeed, uint256 how) external step act {
        uint256 h = _r(how, "how") % 16;
        uint256 e = _scheduledEntry(entrySeed, h);
        // one draw in eight a multi-field setter (its lone loosenings executed: Task 39a's review, C1)
        if (h > 4 && _r(entrySeed, "multi") % 8 == 0) e = [uint256(1), 2, 3, 5][_r(entrySeed, "which") % 4];
        // while the probe is a target's primary, one draw in four the setter whose cap check it re-enters
        if (_r(how, "probe entry") % 4 == 0) {
            if (_m[_f(V, F_PRIMARY)] == uint160(bridges[2])) e = 2;
            else if (_m[_f(D, F_PRIMARY)] == uint160(bridges[2])) e = 25;
        }
        (uint8 t, bytes memory data) = _generate(e, argSeed);
        if (h == 1) data = abi.encodePacked(data, bytes1(0x01));
        bool scheduled = _schedule(t, data, h == 2 ? _guardianOf(t) : h == 3 ? w.stranger : owner);
        // one draw in two, Schedule.run's steps: the item waited for and executed in this step, before anything can
        // kill it (most steps elsewhere play an instrument or a stamp, which kills every pending Ordinary item)
        if (scheduled && _r(how, "run") % 2 == 0) {
            // first, one draw in four, one second short of its readyAt (NotReady), one in four across a halt to its
            // readyAt that left the blocks behind (NotReady in blocks)
            uint256 early = _r(how, "early") % 4;
            if (early < 2) {
                _waitFor(t, data, early == 0 ? 4 : 7);
                _execute(t, data, owner);
            }
            _waitFor(t, data, 1);
            _execute(t, data, owner);
            ++runsInOneStep;
        }
    }

    /// One schedule of `data` on `t` by `caller`, predicted and judged (see schedule); whether a ghost life started.
    function _schedule(uint8 t, bytes memory data, address caller) internal returns (bool scheduled) {
        bytes memory expect;
        Delay cls;
        Kind kind;
        if (caller != owner) {
            expect = _notOwner(caller);
        } else {
            (expect, cls, kind) = _classify(t, data);
            if (expect.length == 0) expect = _gateErr(t, kind, uint64(vm.getBlockTimestamp()));
        }
        bytes32 id = keccak256(data);
        CascadeBase c = _target(t);
        _readLogs();
        vm.prank(caller);
        try c.schedule(data) returns (bytes32 got) {
            Vm.Log[] memory logs = _readLogs();
            if (!_judge(true, "", expect)) {
                if (caller != owner) ++schedulesByOthers;
                return false;
            }
            if (got != id) ++eventMismatches;
            _recordSchedule(t, data, cls, kind, logs);
            scheduled = true;
        } catch (bytes memory reason) {
            _dropLogs();
            if (_judge(false, reason, expect)) {
                ++schedulesRefused;
                if (_selector(expect) == ExitsNotOpen.selector) ++schedulesRefusedGate;
            }
        }
    }

    /// The setter-table entry the schedule action draws: a schedulable one, except on `how` 4 (an immediate setter,
    /// refused UnknownSelector).
    function _scheduledEntry(uint256 seed, uint256 how) internal pure returns (uint256) {
        uint256 r = _r(seed, "entry");
        if (how == 4) {
            uint256[10] memory immediate = [uint256(15), 16, 17, 18, 19, 20, 30, 31, 32, 33];
            return immediate[r % 10];
        }
        // the schedulable entries; activations, the guardian swap and the ownership transfer two or three times as
        // likely, for the Registry and Guardian classes' reach (an 8-day Ordinary transfer dies to any closure)
        uint256[36] memory schedulable = [
            uint256(0),
            1,
            2,
            3,
            4,
            5,
            6,
            7,
            8,
            9,
            10,
            11,
            11,
            12,
            12,
            13,
            13,
            14,
            14,
            21,
            22,
            23,
            24,
            25,
            26,
            27,
            27,
            28,
            28,
            29,
            29,
            11,
            14,
            29,
            14,
            29
        ];
        return schedulable[r % 36];
    }

    /// A schedule's success: the Scheduled log is the handler's (id, kind, selector, readyAt, calldata), and a new ghost
    /// life starts, ending any pending one (a re-schedule restarts the delay).
    function _recordSchedule(uint8 t, bytes memory data, Delay cls, Kind kind, Vm.Log[] memory logs) internal {
        bytes32 id = keccak256(data);
        uint64 now_ = uint64(vm.getBlockTimestamp());
        uint64 delay = uint64(Schedule.delayOf(_sel(data)));
        if (_delayOf(cls) != delay) ++eventMismatches;
        uint64 readyAt = now_ + delay;
        uint64 readyBlock = uint64(vm.getBlockNumber() + _halfInBlocks(t, delay));
        uint256 seen;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(_target(t)) || l.topics.length == 0 || l.topics[0] != Scheduled.selector) {
                continue;
            }
            ++seen;
            (uint8 k, uint64 loggedReady, bytes memory logged) = abi.decode(l.data, (uint8, uint64, bytes));
            if (
                l.topics[1] != id || l.topics[2] != bytes32(_sel(data)) || k != uint8(kind) || loggedReady != readyAt
                    || keccak256(logged) != id
            ) ++eventMismatches;
        }
        if (seen != 1) ++eventMismatches;
        uint256 old = _live[t][id];
        if (old != 0) {
            _ghosts[old - 1].life = Life.Replaced;
            ++reschedules;
        }
        _ghosts.push(Ghost(t, Life.Pending, kind, cls, 0, now_, readyAt, readyBlock, data));
        _live[t][id] = _ghosts.length;
        if (!_isId[id]) {
            _isId[id] = true;
            _ids.push(id);
        }
        ++schedules;
        if (kind == Kind.Ordinary) ++schedulesByKind0;
        else if (kind == Kind.GuardianSwap) ++schedulesByKind1;
        else ++schedulesByKind2;
        if (t == D) ++doorItemsScheduled;
    }

    /// @dev The owner executes a ghost item's calldata (`_pickData`: a pending one alive, else any pending one, else a
    /// recorded life or a fresh table item; with no pending item, three draws in four the owner schedules a fresh one
    /// instead), after `timeSeed`'s wait, one of sixteen draws: none; to its readyAt (eleven); one second short of it; to
    /// the window's end; one second past it; or to its readyAt in time with the blocks held back (a chain halt). Every
    /// wait but the last two also waits for the blocks. Predicted from the ghost log in execute's order: the caller, NoProposal, NotReady (in time or in
    /// blocks), LapsedItem, the gate and the clock (ExitsNotOpen), then the setter's own refusal at execute, bubbled. A
    /// success where any is predicted breaks I-22; it must log Executed, ends the ghost life and moves the model by the
    /// setter's rule.
    function execute(uint256 itemSeed, uint256 timeSeed, uint256 how) external step act {
        (uint8 t, bytes memory data, bool fromLog) = _pickData(itemSeed, how);
        if (!fromLog && _r(how, "instead") % 4 != 0) {
            _schedule(t, data, owner);
            return;
        }
        uint256 mode = _r(timeSeed, "time") % 16;
        // most draws wait to the readyAt; one each one second short, the window's end, one past it, a halt; one none
        mode = mode == 0 ? 0 : mode == 10 ? 4 : mode == 11 ? 5 : mode == 12 ? 6 : mode == 13 ? 7 : 1;
        if (fromLog) _waitFor(t, data, mode);
        address caller = _r(how, "caller") % 16 == 0 ? _guardianOf(t) : owner;
        _execute(t, data, caller);
    }

    /// One execute of `data` on `t` by `caller`, predicted and judged (see execute).
    function _execute(uint8 t, bytes memory data, address caller) internal returns (bool ran) {
        bytes memory expect = _executeExpect(t, data, caller);
        bool probes = _probeCalled(t, data);
        CascadeBase c = _target(t);
        _readLogs();
        vm.prank(caller);
        try c.execute(data) {
            Vm.Log[] memory logs = _readLogs();
            if (!_judge(true, "", expect)) {
                ++executeViolations;
                return false;
            }
            ran = true;
            ++executes;
            bytes32 id = keccak256(data);
            if (_count(logs, address(c), Executed.selector, id) != 1) ++eventMismatches;
            Ghost storage g = _ghosts[_live[t][id] - 1];
            g.life = Life.Executed;
            _live[t][id] = 0;
            if (!_scheduledOnly(t, _sel(data)) && _loosens(t, data)) ++executesOfLoosenings;
            (bool lone, uint256 field) = _loneLoosening(t, data);
            if (lone) ++executedLone[field];
            if (vm.getBlockTimestamp() == uint256(g.readyAt) + WINDOW) ++executesAtWindowEnd;
            if (vm.getBlockTimestamp() > uint256(g.readyAt) + WINDOW) ++executesInTheBlockWindow;
            if (t == D) ++doorItemsExecuted;
            if (probes) ++reentryProbesInExecute;
            _countActivation(t, data);
            _apply(t, data);
            // a transfer to the second owner, one draw in two: its acceptance tried at once (I-22's tail)
            if (
                !_pinned && _sel(data) == CascadeBase.transferOwnership.selector
                    && uint256(keccak256(abi.encode(data, vm.getBlockTimestamp()))) % 2 == 0
            ) {
                _probeAcceptance(t, w.owner2);
            }
        } catch (bytes memory reason) {
            _dropLogs();
            if (_selector(reason) == ProbeBridge.ReentryAdmitted.selector) ++reentriesAdmitted;
            if (_judge(false, reason, expect)) _countExecuteRefusal(t, data, expect);
        }
    }

    /// The wait before an execute (see execute), from the item's pending ghost life (or its last one).
    function _waitFor(uint8 t, bytes memory data, uint256 mode) internal {
        uint256 ix = _live[t][keccak256(data)];
        if (ix == 0) return;
        Ghost storage g = _ghosts[ix - 1];
        uint256 now_ = vm.getBlockTimestamp();
        uint256 to = now_;
        if (mode >= 1 && mode <= 3) to = g.readyAt;
        else if (mode == 4) to = uint256(g.readyAt) - 1;
        else if (mode == 5) to = uint256(g.readyAt) + WINDOW;
        else if (mode == 6) to = uint256(g.readyAt) + WINDOW + 1;
        else if (mode == 7) to = g.readyAt;
        if (to > now_) {
            if (mode == 7) {
                // a halt: the time passes, the blocks do not
                vm.warp(to);
                ++halts;
            } else {
                _warp(to - now_, doorBlockTime);
            }
        }
        // a wait lasts until the blocks have come too (after a halt, the chain's catch-up)
        if (mode != 4 && mode != 7 && vm.getBlockNumber() < g.readyBlock) vm.roll(g.readyBlock);
        _raiseFloor();
    }

    /// A refused execute's count, by its predicted refusal.
    function _countExecuteRefusal(uint8 t, bytes memory data, bytes memory expect) internal {
        bytes4 e = _selector(expect);
        if (e == NotReady.selector) {
            Ghost storage g = _ghosts[_live[t][keccak256(data)] - 1];
            if (vm.getBlockTimestamp() >= g.readyAt) ++executesRefusedBlocks;
            else ++executesRefusedNotReady;
        } else if (e == LapsedItem.selector) {
            ++executesRefusedLapsed;
        } else if (e == ExitsNotOpen.selector) {
            Ghost storage g = _ghosts[_live[t][keccak256(data)] - 1];
            if (_dead(t, g)) ++executesRefusedDead;
            else ++executesRefusedGate;
        } else if (e == NoProposal.selector) {
            ++executesRefusedNoProposal;
        } else {
            ++executesRefusedSetter;
        }
    }

    /// An activation's count, by what its target was before it ran.
    function _countActivation(uint8 t, bytes memory data) internal {
        bytes4 s = _sel(data);
        if (s == CascadeVault.activateFrontDoor.selector && t == V) {
            (uint64 chain, address addr) = abi.decode(_args(data), (uint64, address));
            uint256 i = _doorIndex(chain, addr);
            DoorState st = DoorState(_m[V_DOOR + i]);
            if (st == DoorState.Removed) ++activationsKnown;
            else if (_everRemovedByGuardian[i]) ++activationsGuardianRemoved;
            else ++activationsNew;
        } else if (s == CascadeBase.activateBridge.selector) {
            uint256 j = _bridgeIndex(abi.decode(_args(data), (address)));
            if (_m[_f(t, F_KNOWN + j)] != 0) ++bridgeActivationsKnown;
            else ++bridgeActivationsNew;
        } else if (s == CascadeBase.setGuardian.selector) {
            ++guardianSwaps;
        } else if (s == CascadeBase.transferOwnership.selector) {
            ++transfersExecuted;
        }
    }

    /// Whether a door the guardian removed (Unknown since) is the one an activation names.
    mapping(uint256 => bool) internal _everRemovedByGuardian;

    /// @dev The owner (or, one draw in eight, the guardian or the stranger: OwnableUnauthorizedAccount, and NotScheduled
    /// for a scheduled-only function) calls a setter-table entry directly. Predicted (`_directErr`): a loosening is
    /// refused NotScheduled, a value past a bound by the setter's own check, anything else applies at once and is never
    /// refused (I-23). A loosening that succeeded breaks I-22.
    function directSet(uint256 entrySeed, uint256 argSeed, uint256 how) external step act {
        uint256 e = _r(entrySeed, "direct") % 34;
        // one draw in three a multi-field setter (its lone loosenings: Task 39a's review, C1)
        if (_r(entrySeed, "multi") % 3 == 0) e = [uint256(1), 2, 3, 5][_r(entrySeed, "which") % 4];
        (uint8 t, bytes memory data) = _generate(e, argSeed);
        uint256 h = _r(how, "who") % 8;
        _direct(t, data, h == 0 ? _guardianOf(t) : h == 1 ? w.stranger : owner);
    }

    /// One direct call of `data` on `t` by `caller`, predicted and judged (see directSet).
    function _direct(uint8 t, bytes memory data, address caller) internal {
        bytes memory expect = _directErr(t, data, caller);
        bool loosens = _loosens(t, data);
        (bool lone, uint256 field) = _loneLoosening(t, data);
        if (lone && caller == owner) ++directLone[field];
        bool equal = _isEqual(t, data);
        bool probes = _probeCalled(t, data);
        _readLogs();
        vm.prank(caller);
        (bool ok, bytes memory reason) = address(_target(t)).call(data);
        if (ok) {
            _readLogs();
            if (!_judge(true, "", expect)) {
                if (loosens && !_scheduledOnly(t, _sel(data))) ++unscheduledLoosenings;
                else if (_scheduledOnly(t, _sel(data))) ++selfCallsAdmitted;
                return;
            }
            if (_immediate(t, _sel(data))) ++directImmediates;
            else if (equal) ++directEquals;
            else ++directTightenings;
            if (probes) ++reentryProbes;
            _apply(t, data);
        } else {
            _dropLogs();
            if (_selector(reason) == ProbeBridge.ReentryAdmitted.selector) ++reentriesAdmitted;
            if (_judge(false, reason, expect)) {
                bytes4 e = _selector(expect);
                if (e == NotScheduled.selector) ++directLooseningsRefused;
                else if (caller == owner) ++directBoundsRefused;
            } else if (expect.length == 0 && caller == owner) {
                ++tighteningsRefused;
            }
        }
    }

    /// @dev A lone loosening (Task 39a's review, C1): the owner calls a multi-field setter of the vault with exactly one
    /// field loosened (a step past the model's value, or one past its bound when it is at the bound) and every other
    /// field kept: directly, where it must be refused NotScheduled (a direction check that misses the field lets it apply,
    /// which breaks I-22), then one draw in two scheduled and, once ready, executed in the same step. The fields are
    /// _loneLoosening's ten: setOutflowLimits' three, setMessageLimits' three, setFeeLimits' two, setRewardCut's
    /// treasury and cut.
    function loneLoosening(uint256 fieldSeed, uint256 argSeed) external step act {
        bytes memory data = _loneData(_r(fieldSeed, "lone") % 10, _r(argSeed, "lone args"));
        _direct(V, data, owner);
        if (_r(argSeed, "lone run") % 2 == 0) {
            _waitOutClocks(V);
            if (_schedule(V, data, owner)) {
                _waitFor(V, data, 1);
                _execute(V, data, owner);
            }
        }
    }

    /// @dev One past a bound (I-23; fix round 1's finding: a single-field value past a bound was too rare in the random
    /// draws for a bound one looser to fail the campaign, only its pin): the owner sets one bounded field of either
    /// target one past one of its 35 bounds, every other field kept, directly (a loosening direction is NotScheduled
    /// first, a tightening direction the setter's own refusal), then, for a loosening direction, one draw in two
    /// scheduled and, once ready, executed (the setter's refusal at execute, the item kept). A bound one looser in the
    /// contract lets the value apply: I-23's bounds and I-22's model then fail.
    function pastABound(uint256 seed) external step act {
        (uint8 t, bytes memory data) = _pastBoundData(_r(seed, "bound") % 35);
        ++boundsProbed;
        _direct(t, data, owner);
        if (_loosens(t, data) && _r(seed, "bound run") % 2 == 0) {
            _waitOutClocks(t);
            if (_schedule(t, data, owner)) {
                _waitFor(t, data, 1);
                _execute(t, data, owner);
                ++boundsProbedAtExecute;
            }
        }
    }

    /// Bound `k`'s probe (see pastABound): its target and the calldata setting its field one past it.
    function _pastBoundData(uint256 k) internal view returns (uint8, bytes memory) {
        if (k < 2) {
            return (
                V,
                abi.encodeCall(
                    CascadeVault.setPayoutDelay, (uint64(k == 0 ? MIN_PAYOUT_DELAY - 1 : MAX_PAYOUT_DELAY + 1))
                )
            );
        }
        if (k < 8) {
            uint256[3] memory v = [_m[V_BPS], _m[V_FLOOR], _m[V_GLOBAL]];
            uint256 f = (k - 2) / 2;
            bool high = (k - 2) % 2 == 1;
            if (f == 1) v[1] = high ? MAX_MIN_DAILY_OUTFLOW + 1 : MIN_MIN_DAILY_OUTFLOW - 1;
            else v[f] = high ? MAX_OUTFLOW_BPS + 1 : MIN_OUTFLOW_BPS - 1;
            return (V, abi.encodeCall(CascadeVault.setOutflowLimits, (v[0], v[1], v[2])));
        }
        if (k < 12) {
            uint256 entry = _m[V_ENTRY];
            uint256 msgv = _m[V_MSG];
            uint256 chunk = _m[V_MIN_CHUNK];
            if (k == 8) entry = MIN_ENTRY_VALUE - 1;
            else if (k == 9) msgv = MAX_MESSAGE_VALUE + 1;
            else chunk = k == 10 ? 0 : CascadeMessages.MAX_ENTRIES + 1;
            return (V, abi.encodeCall(CascadeVault.setMessageLimits, (entry, msgv, uint32(chunk))));
        }
        if (k < 15) {
            uint256 bps = k == 12 ? MAX_FEE_BPS + 1 : _m[V_FEE_BPS];
            uint256 abs_ = k == 13 ? MIN_FEE_ABS - 1 : k == 14 ? MAX_FEE_ABS + 1 : _m[V_FEE_ABS];
            return (V, abi.encodeCall(CascadeVault.setFeeLimits, (bps, abs_)));
        }
        if (k == 15) {
            uint16 cut = uint16(vaultLens.MAX_REWARD_CUT_BPS() + 1);
            return (V, abi.encodeCall(CascadeVault.setRewardCut, (address(uint160(_m[V_TREASURY])), cut)));
        }
        if (k < 18) {
            uint64 p = uint64(k == 16 ? MIN_REWARD_VESTING - 1 : MAX_REWARD_VESTING + 1);
            return (V, abi.encodeCall(CascadeVault.setRewardVesting, (p)));
        }
        if (k == 18) return (V, abi.encodeCall(CascadeVault.setIdleBuffer, (MAX_IDLE_BUFFER_BPS + 1)));
        if (k < 21) {
            uint256 g = k == 19 ? vaultLens.MIN_CLAIM_GAS() - 1 : vaultLens.MAX_CLAIM_GAS() + 1;
            return (V, abi.encodeCall(CascadeVault.setClaimGasRequired, (g)));
        }
        if (k == 21) return (V, abi.encodeCall(CascadeVault.setHotkeyDustRao, (MAX_HOTKEY_DUST_RAO + 1)));
        if (k == 22) return (V, abi.encodeCall(CascadeVault.setUnstakeMarginRao, (MAX_UNSTAKE_MARGIN_RAO + 1)));
        if (k < 25) {
            return
                (V, abi.encodeCall(CascadeVault.setUnstakeGas, (k == 23 ? MIN_UNSTAKE_GAS - 1 : MAX_UNSTAKE_GAS + 1)));
        }
        if (k == 25) {
            return
                (
                    D,
                    abi.encodeCall(
                        CascadeFrontDoor.setMaxDeliverySlippage, (uint16(fd.MAX_DELIVERY_SLIPPAGE_BPS() + 1))
                    )
                );
        }
        if (k == 26) {
            return (D, abi.encodeCall(CascadeFrontDoor.setBatchInterval, (uint64(fd.MAX_BATCH_INTERVAL() + 1))));
        }
        if (k == 27) return (D, abi.encodeCall(CascadeFrontDoor.setMaxBatchValue, (fd.MAX_BATCH_VALUE() + 1)));
        if (k == 28) return (D, abi.encodeCall(CascadeFrontDoor.setCaps, (fd.MIN_DEPOSIT_FLOOR() - 1, _m[D_CAP])));
        // the minimum deposit's ceiling (R7): the lane's 5,000 TAO
        if (k == 34) return (D, abi.encodeCall(CascadeFrontDoor.setCaps, (fd.MAX_BATCH_VALUE() + 1, _m[D_CAP])));
        if (k < 33) {
            uint32 md = uint32(_m[D_MAX_DEPOSITS]);
            uint32 mr = uint32(_m[D_MAX_REDEEMS]);
            uint32 bad = k % 2 == 1 ? 0 : uint32(CascadeMessages.MAX_ENTRIES + 1);
            if (k < 31) md = bad;
            else mr = bad;
            return (D, abi.encodeCall(CascadeFrontDoor.setBatchLimits, (md, mr)));
        }
        return (D, abi.encodeCall(CascadeFrontDoor.setRedeemRequestFee, (fd.MAX_REDEEM_REQUEST_FEE() + 1)));
    }

    /// The calldata of a lone loosening of field `f` (see loneLoosening), the other fields at the model's values.
    function _loneData(uint256 f, uint256 r) internal view returns (bytes memory) {
        if (f < 3) {
            uint256[3] memory v = [_m[V_BPS], _m[V_FLOOR], _m[V_GLOBAL]];
            v[f] = f == 1
                ? _looser(v[1], MIN_MIN_DAILY_OUTFLOW, MAX_MIN_DAILY_OUTFLOW, true, r)
                : _looser(v[f], MIN_OUTFLOW_BPS, MAX_OUTFLOW_BPS, true, r);
            return abi.encodeCall(CascadeVault.setOutflowLimits, (v[0], v[1], v[2]));
        }
        if (f < 6) {
            uint256 entry = _m[V_ENTRY];
            uint256 msgv = _m[V_MSG];
            uint256 chunk = _m[V_MIN_CHUNK];
            // the entry loosens up to the message limit while there is room (else one past it: InvalidParameter)
            if (f == 3) entry = entry < msgv ? _looser(entry, MIN_ENTRY_VALUE, msgv, true, r) : entry + 1;
            else if (f == 4) msgv = _looser(msgv, MIN_ENTRY_VALUE, MAX_MESSAGE_VALUE, true, r);
            else chunk = _looser(chunk, 1, CascadeMessages.MAX_ENTRIES, false, r);
            return abi.encodeCall(CascadeVault.setMessageLimits, (entry, msgv, uint32(chunk)));
        }
        if (f < 8) {
            uint256 bps = _m[V_FEE_BPS];
            uint256 abs_ = _m[V_FEE_ABS];
            if (f == 6) bps = _looser(bps, 0, MAX_FEE_BPS, true, r);
            else abs_ = _looser(abs_, MIN_FEE_ABS, MAX_FEE_ABS, true, r);
            return abi.encodeCall(CascadeVault.setFeeLimits, (bps, abs_));
        }
        address tr = address(uint160(_m[V_TREASURY]));
        uint256 cut = _m[V_CUT];
        if (f == 8) tr = _treasuryDraw(3, r);
        else cut = _looser(cut, 0, vaultLens.MAX_REWARD_CUT_BPS(), true, r);
        return abi.encodeCall(CascadeVault.setRewardCut, (tr, uint16(cut)));
    }

    /// A strictly looser value than `cur` (up when `up`): a step toward the bound, or one past it when `cur` is there.
    function _looser(uint256 cur, uint256 lo, uint256 hi, bool up, uint256 r) internal pure returns (uint256) {
        uint256 step = 1 + (r >> 8) % ((hi - lo) / 4 + 1);
        if (up) return cur < hi ? (hi - cur > step ? cur + step : hi) : hi + 1;
        return cur > lo ? (cur - lo > step ? cur - step : lo) : lo - 1;
    }

    /// @dev A cancel of a ghost item (`_pickData`'s draw) by the owner, the guardian, the stranger, the
    /// guardian the target no longer names, the pending owner's candidate, or the target itself. Spec §3.6's table: the
    /// owner cancels any item, the guardian an Ordinary one only (NotCanceller), anyone else nothing (NotCanceller); a
    /// missing item is NoProposal first. A success where the table refuses breaks I-24; it must log Cancelled by its
    /// caller and ends the ghost life.
    function cancel(uint256 itemSeed, uint256 actorSeed) external step act {
        (uint8 t, bytes memory data,) = _pickData(itemSeed, itemSeed);
        _cancel(t, data, _cancelActor(t, actorSeed));
    }

    /// One cancel of `data`'s item on `t` by `caller`, predicted and judged (see cancel).
    function _cancel(uint8 t, bytes memory data, address caller) internal {
        bytes32 id = keccak256(data);
        uint256 ix = _live[t][id];
        bytes memory expect;
        if (ix == 0) {
            expect = abi.encodeWithSelector(NoProposal.selector);
        } else if (caller != owner && (caller != _guardianOf(t) || _ghosts[ix - 1].kind != Kind.Ordinary)) {
            expect = abi.encodeWithSelector(NotCanceller.selector);
        }
        CascadeBase c = _target(t);
        _readLogs();
        vm.prank(caller);
        try c.cancel(id) {
            Vm.Log[] memory logs = _readLogs();
            if (!_judge(true, "", expect)) {
                ++cancelViolations;
                return;
            }
            if (_countBy(logs, address(c), Cancelled.selector, id, caller) != 1) ++eventMismatches;
            Ghost storage g = _ghosts[ix - 1];
            if (_dead(t, g)) ++cancelsOfDeadItems;
            g.life = Life.Cancelled;
            _live[t][id] = 0;
            if (caller == owner) ++cancelsByOwner;
            else ++cancelsByGuardian;
        } catch (bytes memory reason) {
            _dropLogs();
            if (_judge(false, reason, expect) && ix != 0) {
                if (caller == _guardianOf(t)) ++cancelsRefusedGuardian;
                else ++cancelsRefusedOthers;
            }
        }
    }

    /// The canceller `seed` draws on target `t`: the owner, the guardian (each three draws in eight), the stranger, the
    /// guardian the target does not name, the second owner, or the target itself.
    function _cancelActor(uint8 t, uint256 seed) internal view returns (address) {
        uint256 r = _r(seed, "canceller") % 8;
        if (r < 3) return owner;
        if (r < 6) return _guardianOf(t);
        if (r == 6) return _r(seed, "other") % 2 == 0 ? w.stranger : _staleGuardian(t);
        return _r(seed, "other") % 2 == 0 ? w.owner2 : address(_target(t));
    }

    /// @dev Anyone prunes a ghost item, after, one draw in eight each, a wait to its window's end (NotReady still) or one
    /// second past it. NoProposal when nothing is stored; NotReady until it lapses (`_lapsed`: its windows in time and in
    /// blocks both passed); else Lapsed and the ghost life ends.
    function prune(uint256 itemSeed, uint256 timeSeed, uint256 actorSeed) external step act {
        (uint8 t, bytes memory data,) = _pickData(itemSeed, itemSeed);
        bytes32 id = keccak256(data);
        uint256 ix = _live[t][id];
        if (ix != 0) {
            uint256 mode = _r(timeSeed, "prune") % 8;
            uint256 end = uint256(_ghosts[ix - 1].readyAt) + WINDOW;
            uint256 to = mode == 1 ? end : mode == 2 ? end + 1 : 0;
            if (to > vm.getBlockTimestamp()) _warp(to - vm.getBlockTimestamp(), doorBlockTime);
        }
        _prune(t, data, [w.stranger, owner, _guardianOf(t), w.alice][_r(actorSeed, "pruner") % 4]);
    }

    /// One prune of `data`'s item on `t` by `caller`, predicted from the ghost log and judged (see prune).
    function _prune(uint8 t, bytes memory data, address caller) internal {
        bytes32 id = keccak256(data);
        uint256 ix = _live[t][id];
        bytes memory expect;
        if (ix == 0) {
            expect = abi.encodeWithSelector(NoProposal.selector);
        } else if (!_lapsed(t, _ghosts[ix - 1].readyAt, _ghosts[ix - 1].readyBlock)) {
            expect = abi.encodeWithSelector(NotReady.selector);
        }
        CascadeBase c = _target(t);
        _readLogs();
        vm.prank(caller);
        try c.prune(id) {
            Vm.Log[] memory logs = _readLogs();
            if (!_judge(true, "", expect)) return;
            if (_count(logs, address(c), Lapsed.selector, id) != 1) ++eventMismatches;
            _ghosts[ix - 1].life = Life.Pruned;
            _live[t][id] = 0;
            ++prunes;
        } catch (bytes memory reason) {
            _dropLogs();
            if (_judge(false, reason, expect)) {
                ++prunesRefused;
                if (ix != 0 && vm.getBlockTimestamp() > uint256(_ghosts[ix - 1].readyAt) + WINDOW) {
                    ++prunesRefusedInTheBlockWindow;
                }
            }
        }
    }

    /// @dev Revision 28's window in blocks, directed (the review's M-2): a pending ghost item (`_pickData`; with none, the
    /// owner schedules the drawn one first), then a chain halt past its window in time (the clock to one second past
    /// readyAt + WINDOW, the blocks held), then, one draw in three each: anyone's prune (NotReady while its window in
    /// blocks is open); the owner's execute with the blocks still held (NotReady below readyBlock, else as the ghost log
    /// says); or the owner's execute once the blocks have caught up to readyBlock (a chain resuming), which runs inside
    /// the window in blocks unless its gate or its clock refuses it. Each predicted as execute and prune are, from the
    /// both-windows lapse (`_lapsed`): a lapse in time alone would refuse LapsedItem, or prune, where the model says the
    /// item is still alive.
    function haltPastTheWindow(uint256 itemSeed, uint256 how) external step act {
        (uint8 t, bytes memory data, bool fromLog) = _pickData(itemSeed, how);
        if (!fromLog || _live[t][keccak256(data)] == 0) {
            if (!_schedule(t, data, owner)) return;
        }
        Ghost storage g = _ghosts[_live[t][keccak256(data)] - 1];
        uint256 to = uint256(g.readyAt) + WINDOW + 1;
        if (to > vm.getBlockTimestamp()) {
            vm.warp(to);
            ++halts;
        }
        _raiseFloor();
        ++haltsPastTheWindow;
        uint256 r = _r(how, "past the window") % 3;
        if (r == 0) {
            _prune(t, data, w.stranger);
            return;
        }
        if (r == 2 && vm.getBlockNumber() < g.readyBlock) vm.roll(g.readyBlock);
        _execute(t, data, owner);
    }

    // =====================================================================================================
    // the instruments
    // =====================================================================================================

    /// @dev Either target's pause by the owner, the guardian or the stranger (NotGuardian), EnforcedPause when paused,
    /// played one draw in two. The vault's records its pauser and stamps the pauser's clock (ExitsClosed), then one draw
    /// in two a payout is tried (EnforcedPause); the front door's records and stamps nothing (spec §3.6, I-29).
    function pause(uint256 targetSeed, uint256 actorSeed) external step act {
        // played one draw in two: a closure kills every pending Ordinary item, so a denser one starves the executes
        if (_r(targetSeed, "pause plays") % 2 != 0) return;
        uint8 t = uint8(_r(targetSeed, "pause target") % 2);
        uint256 a = _r(actorSeed, "pauser") % 5;
        _pause(t, a < 2 ? owner : a < 4 ? _guardianOf(t) : w.stranger);
    }

    /// One pause of `t` by `caller`, predicted and judged (see pause).
    function _pause(uint8 t, address caller) internal {
        bytes memory expect;
        Actor actor = _actorOf(t, caller);
        if (actor == Actor.None) expect = abi.encodeWithSelector(NotGuardian.selector);
        else if (_m[_f(t, F_PAUSED)] != 0) expect = abi.encodeWithSelector(Pausable.EnforcedPause.selector);
        CascadeBase c = _target(t);
        _readLogs();
        vm.prank(caller);
        try c.pause() {
            Vm.Log[] memory logs = _readLogs();
            if (!_judge(true, "", expect)) return;
            _m[_f(t, F_PAUSED)] = 1;
            bool stamps = t == V;
            if (
                _countBy(logs, address(c), ExitsClosed.selector, bytes32(uint256(uint160(caller))), address(0))
                    != (stamps ? 1 : 0)
            ) {
                ++eventMismatches;
            }
            if (stamps) {
                _m[V_PAUSED_BY] = uint256(actor);
                _stamp(t, actor);
                if (actor == Actor.Owner) ++pausesByOwner;
                else ++pausesByGuardian;
                // the vault paused: a queued payout tried at once, one draw in two (EnforcedPause)
                if (!_pinned && uint256(keccak256(abi.encode(caller, vm.getBlockTimestamp(), "paused"))) % 2 == 0) {
                    _payout(uint256(uint160(caller)));
                }
            } else {
                ++doorPauses;
            }
        } catch (bytes memory reason) {
            _dropLogs();
            if (_judge(false, reason, expect)) ++instrumentsRefused;
        }
    }

    /// @dev Either target's unpause: the owner's (ExpectedPause when not paused); the guardian's is refused
    /// OwnableUnauthorizedAccount. The vault's clears pausedBy, whoever paused; nothing is stamped.
    function unpause(uint256 targetSeed, uint256 actorSeed) external step act {
        uint8 t = uint8(_r(targetSeed, "unpause target") % 2);
        _unpause(t, _r(actorSeed, "unpauser") % 4 == 0 ? _guardianOf(t) : owner);
    }

    /// One unpause of `t` by `caller`, predicted and judged (see unpause).
    function _unpause(uint8 t, address caller) internal {
        bytes memory expect;
        if (caller != owner) expect = _notOwner(caller);
        else if (_m[_f(t, F_PAUSED)] == 0) expect = abi.encodeWithSelector(Pausable.ExpectedPause.selector);
        CascadeBase c = _target(t);
        _readLogs();
        vm.prank(caller);
        try c.unpause() {
            _readLogs();
            if (!_judge(true, "", expect)) return;
            _m[_f(t, F_PAUSED)] = 0;
            if (t == V) _m[V_PAUSED_BY] = 0;
            ++unpauses;
        } catch (bytes memory reason) {
            _dropLogs();
            if (_judge(false, reason, expect)) ++instrumentsRefused;
        }
    }

    /// @dev A door's removal on the vault, by the owner, the guardian or the stranger (NotGuardian), of an active door three
    /// draws in four; two draws in three the guardian removes a door the owner removed, when there is one (the Task 10b
    /// conversion and its Reopen's delete: the carries' minimum hits). After the owner's removal, one draw in two each, its
    /// Reopen is scheduled at once and the guardian answers by removing the door too; after the launch door's, a payout
    /// is tried (FrontDoorInactive).
    /// spec §3.6: an Active door is counted out (the launch chain's last: the remover's hold and clock, ExitsClosed); the
    /// guardian's removal of a Removed door makes it Unknown, deletes its pending Reopen (Cancelled by the guardian) and,
    /// while the launch door's hold is the owner's, on the launch chain makes the hold the guardian's (its clock stamped,
    /// ExitsClosed); any other removal is PeerNotActive. The owner's leaves the door Removed, the guardian's Unknown.
    function removeDoor(uint256 doorSeed, uint256 actorSeed) external step act {
        uint256 a = _r(actorSeed, "remover") % 9;
        address caller = a < 4 ? owner : a < 8 ? guardianOfVault() : w.stranger;
        uint256 i = _r(doorSeed, "door") % 3;
        // an active door, three draws in four when there is one (a removal of another is refused PeerNotActive)
        if (_r(doorSeed, "active") % 4 != 0) {
            for (uint256 k; k < 3; ++k) {
                uint256 d = (i + k) % 3;
                if (DoorState(_m[V_DOOR + d]) == DoorState.Active) {
                    i = d;
                    break;
                }
            }
        }
        // a door the owner removed: the guardian removes it two draws in three (Task 10b's conversion, its Reopen's
        // delete: the carries' minimum hits)
        if (_r(doorSeed, "prefer") % 3 != 0) {
            for (uint256 k; k < 3; ++k) {
                if (DoorState(_m[V_DOOR + k]) == DoorState.Removed) {
                    i = k;
                    caller = guardianOfVault();
                }
            }
        }
        _removeDoor(i, caller);
    }

    /// One removal of door `i` by `caller`, predicted and judged (see removeDoor).
    function _removeDoor(uint256 i, address caller) internal {
        Actor actor = _actorOf(V, caller);
        DoorState s = DoorState(_m[V_DOOR + i]);
        uint64 chain = doorChains[i];
        bytes memory reopen = abi.encodeCall(CascadeVault.activateFrontDoor, (chain, doorAddrs[i]));
        bytes32 reopenId = keccak256(reopen);
        bool reopenPending = _live[V][reopenId] != 0;
        bytes memory expect;
        bool closes;
        if (actor == Actor.None) {
            expect = abi.encodeWithSelector(NotGuardian.selector);
        } else if (s == DoorState.Active) {
            closes = _m[V_ACTIVE + _chainIndex(chain)] == 1;
        } else if (s == DoorState.Removed && actor == Actor.Guardian) {
            closes = _m[V_LAUNCH_BY] == uint256(Actor.Owner);
        } else {
            expect = abi.encodeWithSelector(PeerNotActive.selector);
        }
        bool stamps = closes && chain == BASE_CHAIN;
        _readLogs();
        vm.prank(caller);
        try vault.removeFrontDoor(chain, doorAddrs[i]) {
            Vm.Log[] memory logs = _readLogs();
            if (!_judge(true, "", expect)) return;
            if (s == DoorState.Active) --_m[V_ACTIVE + _chainIndex(chain)];
            _m[V_DOOR + i] = uint256(actor == Actor.Guardian ? DoorState.Unknown : DoorState.Removed);
            if (actor == Actor.Guardian) _everRemovedByGuardian[i] = true;
            if (actor == Actor.Guardian) ++removalsByGuardian;
            else ++removalsByOwner;
            if (s == DoorState.Removed) {
                ++guardianRemovalsOfRemoved;
                uint256 deleted = _countBy(logs, address(vault), Cancelled.selector, reopenId, caller);
                if (deleted != (reopenPending ? 1 : 0)) ++eventMismatches;
                if (reopenPending) {
                    _ghosts[_live[V][reopenId] - 1].life = Life.Cancelled;
                    _live[V][reopenId] = 0;
                    ++reopensDeleted;
                }
            }
            if (
                _countBy(logs, address(vault), ExitsClosed.selector, bytes32(uint256(uint160(caller))), address(0))
                    != (stamps ? 1 : 0)
            ) {
                ++eventMismatches;
            }
            if (stamps) {
                if (s == DoorState.Removed) ++holdsConverted;
                else ++launchHoldsByRemoval;
                _m[V_LAUNCH_BY] = uint256(actor);
                _stamp(V, actor);
            }
            uint256 then = uint256(keccak256(abi.encode(i, caller, vm.getBlockTimestamp())));
            // the launch door down: a queued payout tried at once, one draw in two (FrontDoorInactive)
            if (_pinned) return;
            if (i == 0 && then % 2 == 0) _payout(then);
            // the owner's removal for a temporary hold: its Reopen scheduled at once, one draw in two (spec §3.6 row 2
            // HO), which a guardian's removal of the door then deletes
            if (actor == Actor.Owner && (then >> 8) % 2 == 0) {
                _waitOutClocks(V);
                _schedule(V, reopen, owner);
            }
            // the guardian's answer to the owner's removal, one draw in two: it removes the door too (Task 10b: the
            // door becomes unknown, its Reopen is deleted, the owner's launch hold becomes the guardian's)
            if (actor == Actor.Owner && (then >> 16) % 2 == 0) _removeDoor(i, guardianOfVault());
        } catch (bytes memory reason) {
            _dropLogs();
            if (_judge(false, reason, expect)) ++removalsRefused;
        }
    }

    /// @dev A bridge's disable on either target, by the owner, the guardian or the stranger (NotGuardian); BridgeNotEnabled
    /// when it is not enabled; played one draw in two. The primary's records its disabler and stamps its clock
    /// (ExitsClosed), and the vault's is followed one draw in two by a payout try (PrimaryBridgeDisabled); any other's
    /// records and stamps nothing. Two draws in three name the primary.
    function disableBridge(uint256 targetSeed, uint256 bridgeSeed, uint256 actorSeed) external step act {
        // played one draw in two (see pause)
        if (_r(targetSeed, "disable plays") % 2 != 0) return;
        uint8 t = uint8(_r(targetSeed, "disable target") % 2);
        uint256 a = _r(actorSeed, "disabler") % 9;
        address caller = a < 4 ? owner : a < 8 ? _guardianOf(t) : w.stranger;
        uint256 j = _r(bridgeSeed, "bridge") % 3;
        if (_r(bridgeSeed, "primary") % 3 != 0) j = _bridgeIndex(address(uint160(_m[_f(t, F_PRIMARY)])));
        _disable(t, j, caller);
    }

    /// One disable of bridge `j` on `t` by `caller`, predicted and judged (see disableBridge).
    function _disable(uint8 t, uint256 j, address caller) internal {
        Actor actor = _actorOf(t, caller);
        bool primary = bridges[j] == address(uint160(_m[_f(t, F_PRIMARY)]));
        bytes memory expect;
        if (actor == Actor.None) expect = abi.encodeWithSelector(NotGuardian.selector);
        else if (_m[_f(t, F_ENABLED + j)] == 0) expect = abi.encodeWithSelector(BridgeNotEnabled.selector);
        CascadeBase c = _target(t);
        _readLogs();
        vm.prank(caller);
        try c.disableBridge(bridges[j]) {
            Vm.Log[] memory logs = _readLogs();
            if (!_judge(true, "", expect)) return;
            _m[_f(t, F_ENABLED + j)] = 0;
            if (
                _countBy(logs, address(c), ExitsClosed.selector, bytes32(uint256(uint160(caller))), address(0))
                    != (primary ? 1 : 0)
            ) {
                ++eventMismatches;
            }
            if (primary) {
                _m[_f(t, F_DISABLED_BY)] = uint256(actor);
                _stamp(t, actor);
                if (t == V) ++primaryDisables;
                else ++doorPrimaryDisables;
                // the vault's primary down: a queued payout tried at once, one draw in two (PrimaryBridgeDisabled)
                if (t == V && !_pinned && uint256(keccak256(abi.encode(caller, vm.getBlockTimestamp()))) % 2 == 0) {
                    _payout(j);
                }
            } else {
                ++otherDisables;
            }
        } catch (bytes memory reason) {
            _dropLogs();
            if (_judge(false, reason, expect)) ++instrumentsRefused;
        }
    }

    /// @dev The owner switches either target's primary to an enabled bridge, only while the primary is disabled
    /// (PrimaryStillEnabled), the new one enabled (BridgeNotEnabled) and within its cap (the vault's maxMessageValue, the
    /// front door's maxBatchValue: AboveBridgeCap); the guardian's is refused (OwnableUnauthorizedAccount). It clears the
    /// primary's hold and stamps nothing. Two draws in three name the probe when it is enabled, whose cap check re-enters
    /// the target (ProbeBridge).
    function setPrimary(uint256 targetSeed, uint256 bridgeSeed, uint256 actorSeed) external step act {
        uint8 t = uint8(_r(targetSeed, "switch target") % 2);
        address caller = _r(actorSeed, "switcher") % 8 == 0 ? _guardianOf(t) : owner;
        uint256 j = _r(bridgeSeed, "to") % 3;
        if (_m[_f(t, F_ENABLED + 2)] != 0 && _r(bridgeSeed, "probe") % 3 != 0) j = 2;
        _setPrimary(t, j, caller);
    }

    /// One switch of `t`'s primary to bridge `j` by `caller`, predicted and judged (see setPrimary).
    function _setPrimary(uint8 t, uint256 j, address caller) internal {
        uint256 p = _bridgeIndex(address(uint160(_m[_f(t, F_PRIMARY)])));
        bytes memory expect;
        if (caller != owner) expect = _notOwner(caller);
        else if (_m[_f(t, F_ENABLED + p)] != 0) expect = abi.encodeWithSelector(PrimaryStillEnabled.selector);
        else if (_m[_f(t, F_ENABLED + j)] == 0) expect = abi.encodeWithSelector(BridgeNotEnabled.selector);
        else if (_m[t == V ? V_MSG : D_MAX_BATCH] > _capOf(j)) expect = abi.encodeWithSelector(AboveBridgeCap.selector);
        CascadeBase c = _target(t);
        _readLogs();
        vm.prank(caller);
        try c.setPrimaryBridge(bridges[j]) {
            _readLogs();
            if (!_judge(true, "", expect)) return;
            _m[_f(t, F_PRIMARY)] = uint160(bridges[j]);
            _m[_f(t, F_DISABLED_BY)] = 0;
            ++primarySwitches;
            if (j == 2) ++reentryProbes;
        } catch (bytes memory reason) {
            _dropLogs();
            if (_selector(reason) == ProbeBridge.ReentryAdmitted.selector) ++reentriesAdmitted;
            if (_judge(false, reason, expect)) {
                if (_selector(expect) == AboveBridgeCap.selector) ++switchesRefusedCap;
                else ++instrumentsRefused;
            }
        }
    }

    // =====================================================================================================
    // the stamps
    // =====================================================================================================

    /// @dev A relay of an owner stamp on either target, by the stranger (or the owner, the guardian or alice). `modeSeed`
    /// draws the stamp: 0 asOf now; 1 the founder's stack (asOf spaced SPACING from the campaign's start, the newest
    /// passed); 2 an item's schedule time (it dies); 3 the second before it (it lives); 4 a replay of a valid stamp
    /// relayed before on the target, three times as likely as the others and three draws in four the newest still in its
    /// window (accepted, changing nothing; past it, StampOutOfWindow); 5 a day old (the window's edge); 6 a day and a
    /// second old and 7 a second ahead (StampOutOfWindow); 8 an older stack stamp; and, each signed for now, 9 a wrong
    /// key, 10 the high-s twin, 11 a bad v, 12 a bad length, 13 the other target's domain, 14 another chain's, 15
    /// StampVector's vector (each BadStamp). A draw of 2, 3 or 4 that finds no item or no earlier stamp is the fresh
    /// stamp as of now it then is, and counts and is kept as one (Task 39a's review, I1). Predicted in stampBySig's order
    /// (length, v and s, the signer, the window). A valid one must log exactly one log, its StampedBySig(asOf, relayer)
    /// (spec §3.10.7: a stamp records, closes and emits nothing else), and moves the owner's clock to max(clock, asOf),
    /// killing every item scheduled at or before it (a replay's asOf is never above the clock: it moves nothing); then up
    /// to three pending items are executed in a snapshot to check exactly that (I-29); then, one draw in three, the same
    /// stamp is relayed again at once by another account, a real replay.
    function relayStamp(uint256 targetSeed, uint256 modeSeed, uint256 relayerSeed) external step act {
        uint8 t = uint8(_r(targetSeed, "stamp target") % 2);
        uint256 mode = _r(modeSeed, "stamp") % 20;
        // a replay (4) three times as likely: it needs a valid stamp relayed before on the same target
        if (mode >= 16) mode = 4;
        (uint64 asOf, bytes memory sig, bool valid, uint256 drawn) = _drawStamp(t, mode, modeSeed);
        address relayer = [w.stranger, w.stranger, owner, _guardianOf(t), w.alice][_r(relayerSeed, "relayer") % 5];
        _relay(t, asOf, sig, valid, relayer, drawn);
    }

    /// One relay of (asOf, sig) on `t` by `relayer`, `valid` whether sig is the owner's over t's domain on this chain,
    /// `mode` the draw it came from (for the counts); predicted and judged (see relayStamp).
    function _relay(uint8 t, uint64 asOf, bytes memory sig, bool valid, address relayer, uint256 mode) internal {
        uint64 now_ = uint64(vm.getBlockTimestamp());
        bytes memory expect;
        if (!valid) expect = abi.encodeWithSelector(BadStamp.selector);
        else if (asOf > now_ || now_ > uint256(asOf) + TTL) expect = abi.encodeWithSelector(StampOutOfWindow.selector);
        CascadeBase c = _target(t);
        _readLogs();
        vm.prank(relayer);
        try c.stampBySig(asOf, sig) {
            Vm.Log[] memory logs = _readLogs();
            if (!_judge(true, "", expect)) {
                ++stampViolations;
                return;
            }
            // exactly one log, its StampedBySig with its asOf and relayer: a stamp records, closes and emits nothing else
            // (spec §3.6, §3.10.7: a killed item has no event of its own; I-29's "changes nothing else")
            bool exact = logs.length == 1;
            if (exact) {
                Vm.Log memory l = logs[0];
                exact = l.emitter == address(c) && l.topics.length == 2 && l.topics[0] == StampedBySig.selector
                    && abi.decode(l.data, (uint64)) == asOf && l.topics[1] == bytes32(uint256(uint160(relayer)));
            }
            if (!exact) {
                ++eventMismatches;
                ++stampViolations;
            }
            ++stampsRelayed;
            if (mode == 4) {
                // a replay: its asOf is never above the clock (the first relay moved it there), so nothing moves
                ++stampsReplayed;
                if (asOf > _m[_f(t, F_OWNER_CLOCK)]) ++stampViolations;
            }
            if (mode == 2 || mode == 3) ++stampsAimedAtAnItem;
            if (mode != 4) _relayed.push(Relayed(t, asOf, sig));
            if (asOf > _m[_f(t, F_OWNER_CLOCK)]) {
                ++stampsMovingTheClock;
                _m[_f(t, F_OWNER_CLOCK)] = asOf;
                _killed(t, true, 3);
            }
            _probeKills(t);
            // one draw in three, the same stamp relayed again at once by another relayer: a real replay, in its window
            if (!_pinned && mode != 4 && uint256(keccak256(abi.encode(sig, vm.getBlockTimestamp()))) % 3 == 0) {
                _relay(t, asOf, sig, true, relayer == w.stranger ? w.alice : w.stranger, 4);
            }
        } catch (bytes memory reason) {
            _dropLogs();
            if (!_judge(false, reason, expect)) {
                ++stampViolations;
            } else if (_selector(expect) == BadStamp.selector) {
                ++stampsBadSignature;
            } else {
                ++stampsOutOfWindow;
                if (mode == 4) ++replaysOutOfWindow;
            }
        }
    }

    /// The stamp `mode` draws (see relayStamp): its asOf, its signature and whether that signature is the owner's over
    /// this target's domain on this chain (the one stampBySig accepts, in its window).
    function _drawStamp(uint8 t, uint256 mode, uint256 seed)
        internal
        view
        returns (uint64 asOf, bytes memory sig, bool valid, uint256 drawn)
    {
        drawn = mode;
        uint64 now_ = uint64(vm.getBlockTimestamp());
        uint64 newest = stackStart + (now_ - stackStart) / SPACING * SPACING;
        asOf = now_;
        valid = true;
        uint256 key = w.ownerKey;
        uint256 chainId = block.chainid;
        address domain = address(_target(t));
        if (mode == 1) {
            asOf = newest;
        } else if (mode == 2 || mode == 3) {
            (bool found, uint64 when) = _youngItem(t, seed);
            // no young item: the stamp is a fresh one as of now, and counts as one
            if (found) asOf = mode == 2 ? when : when - 1;
            else drawn = 0;
        } else if (mode == 4) {
            (bool found, uint256 k) = _relayedOn(t, seed);
            if (found) return (_relayed[k].asOf, _relayed[k].sig, true, 4);
            // nothing relayed on `t` yet: a fresh stamp as of now, counted and kept as one
            drawn = 0;
        } else if (mode == 5) {
            asOf = now_ - TTL;
        } else if (mode == 6) {
            asOf = now_ - TTL - 1;
        } else if (mode == 7) {
            asOf = now_ + 1;
        } else if (mode == 8) {
            uint64 back = SPACING * uint64(1 + _r(seed, "back") % 2);
            asOf = newest >= stackStart + back ? newest - back : stackStart;
        } else if (mode == 9) {
            uint256[3] memory wrong = [w.guardianKey, w.strangerKey, w.owner2Key];
            key = wrong[_r(seed, "key") % 3];
            valid = false;
        } else if (mode == 13) {
            domain = address(_target(1 - t));
            valid = false;
        } else if (mode == 14) {
            chainId = chainId == 964 ? 8453 : 964;
            valid = false;
        } else if (mode == 15) {
            return (STAMP_VECTOR_AS_OF, t == V ? STAMP_VECTOR_VAULT_SIG : STAMP_VECTOR_DOOR_SIG, false, 15);
        }
        sig = Stamps.sign(key, Stamps.digest(chainId, domain, asOf));
        if (mode == 10) {
            // the high-s twin: s' = N - s with v flipped recovers the same signer, but s' is above half the order
            (bytes32 r, bytes32 s, uint8 v) = _split(sig);
            sig = abi.encodePacked(r, bytes32(N - uint256(s)), uint8(55 - v));
            valid = false;
        } else if (mode == 11) {
            (bytes32 r, bytes32 s,) = _split(sig);
            uint8[3] memory bad = [uint8(0), 1, 29];
            sig = abi.encodePacked(r, s, bad[_r(seed, "v") % 3]);
            valid = false;
        } else if (mode == 12) {
            uint256 k = _r(seed, "length") % 3;
            if (k == 0) sig = abi.encodePacked(sig, bytes1(0));
            else if (k == 1) sig = "";
            else sig = _shorten(sig);
            valid = false;
        }
    }

    /// A pending item on `t` scheduled within the last TTL (so a stamp may be aimed at it), drawn by `seed`.
    function _youngItem(uint8 t, uint256 seed) internal view returns (bool found, uint64 when) {
        uint256 n = _ghosts.length;
        if (n == 0) return (false, 0);
        uint256 start = _r(seed, "young") % n;
        uint64 now_ = uint64(vm.getBlockTimestamp());
        for (uint256 k; k < n; ++k) {
            Ghost storage g = _ghosts[(start + k) % n];
            if (g.t == t && g.life == Life.Pending && uint256(g.scheduledAt) + TTL >= now_ && g.scheduledAt > 0) {
                return (true, g.scheduledAt);
            }
        }
    }

    /// A valid stamp relayed before on `t`, drawn by `seed`: three draws in four the newest still inside its window.
    function _relayedOn(uint8 t, uint256 seed) internal view returns (bool found, uint256 k) {
        uint256 n = _relayed.length;
        uint64 now_ = uint64(vm.getBlockTimestamp());
        // three draws in four the newest still inside its window (an accepted replay), else any (one past its window
        // is refused StampOutOfWindow)
        if (_r(seed, "replay window") % 4 != 0) {
            for (uint256 i = n; i > 0; --i) {
                Relayed storage x = _relayed[i - 1];
                if (x.t == t && uint256(x.asOf) + TTL >= now_) return (true, i - 1);
            }
        }
        if (n == 0) return (false, 0);
        uint256 start = _r(seed, "replay") % n;
        for (uint256 i; i < n; ++i) {
            k = (start + i) % n;
            if (_relayed[k].t == t) return (true, k);
        }
        return (false, 0);
    }

    /// After a stamp moved the owner's clock on `t`: up to three of its pending items, the newest killed and the oldest
    /// alive first, are each executed in a snapshot once ready (their readyAt and readyBlock), and the outcome must be
    /// the ghost log's: ExitsNotOpen for one scheduled at or before the clock, its gate's or its setter's own outcome for
    /// one after (I-29: a stamp kills exactly the items scheduled at or before its asOf). The snapshot is reverted and
    /// its logs dropped; the counters move after.
    function _probeKills(uint8 t) internal virtual {
        uint256[3] memory pick;
        uint256 n;
        (uint256 newestDead, uint256 oldestAlive, uint256 newest,) = _killPicks(t);
        if (newestDead != 0) pick[n++] = newestDead;
        if (oldestAlive != 0) pick[n++] = oldestAlive;
        if (newest != 0 && newest != newestDead && newest != oldestAlive) pick[n++] = newest;
        if (n == 0) return;
        _readLogs();
        uint256 misses;
        uint256 probed;
        for (uint256 k; k < n; ++k) {
            (bool ran, bool matched) = _killProbe(t, pick[k]);
            if (!ran) continue;
            ++probed;
            if (!matched) ++misses;
        }
        _dropLogs();
        _countKillProbes(probed, misses);
    }

    /// The kill probes' picks on `t` (ghost index + 1, 0 for none): the newest pending item scheduled at or before the
    /// model's owner clock, the oldest after it, and the newest overall; and that clock. Shared with the copied-key walk
    /// (Task 42, the Task 39b re-review's Minor 4), which leaves out a pick its stack relay already probed.
    function _killPicks(uint8 t)
        internal
        view
        returns (uint256 newestDead, uint256 oldestAlive, uint256 newest, uint64 clock)
    {
        clock = uint64(_m[_f(t, F_OWNER_CLOCK)]);
        for (uint256 i; i < _ghosts.length; ++i) {
            Ghost storage g = _ghosts[i];
            if (g.t != t || g.life != Life.Pending) continue;
            if (g.scheduledAt <= clock && (newestDead == 0 || g.scheduledAt >= _ghosts[newestDead - 1].scheduledAt)) {
                newestDead = i + 1;
            }
            if (g.scheduledAt > clock && (oldestAlive == 0 || g.scheduledAt < _ghosts[oldestAlive - 1].scheduledAt)) {
                oldestAlive = i + 1;
            }
            newest = i + 1;
        }
    }

    /// One kill probe of pick `pick` (ghost index + 1) on `t`: none once lapsed (`ran` false); else, in a
    /// snapshot reverted after it, at its readyAt and readyBlock, the owner's execute, and whether it did what the ghost
    /// log predicts (`matched`). The clock and the blocks are put back. The caller reads and drops the logs around it.
    function _killProbe(uint8 t, uint256 pick) internal returns (bool ran, bool matched) {
        Ghost memory g = _ghosts[pick - 1];
        uint256 t0 = vm.getBlockTimestamp();
        uint256 b0 = vm.getBlockNumber();
        if (_lapsed(t, g.readyAt, g.readyBlock)) return (false, false);
        uint256 snap = vm.snapshotState();
        if (t0 < g.readyAt) vm.warp(g.readyAt);
        if (vm.getBlockNumber() < g.readyBlock) vm.roll(g.readyBlock);
        bytes memory expect = _executeExpect(t, g.data, owner);
        vm.prank(owner);
        (bool ok, bytes memory reason) = address(_target(t)).call(abi.encodeCall(CascadeBase.execute, (g.data)));
        matched = ok ? expect.length == 0 : keccak256(reason) == keccak256(expect);
        vm.revertToStateAndDelete(snap);
        vm.warp(t0);
        vm.roll(b0);
        ran = true;
    }

    /// The kill probes' totals: each miss is an unexpected refusal too.
    function _countKillProbes(uint256 probed, uint256 misses) internal {
        killProbes += probed;
        killMisses += misses;
        unexpectedReverts += misses;
    }

    // =====================================================================================================
    // I-25: the scheduled-only paths, called directly
    // =====================================================================================================

    /// @dev Every scheduled-only path, called directly (outside execute) by the owner, the guardian, the stranger, the
    /// target itself or the other target: each `onlyScheduled` function (NotScheduled, whoever calls) and the scheduled
    /// path of each owner setter, a strict loosening (the owner's: NotScheduled; anyone else's:
    /// OwnableUnauthorizedAccount, the target's own included, since only execute's self-call passes the owner check). A
    /// success breaks I-25. (The re-entrant path is ProbeBridge's, on every cap check while it is a primary.)
    function selfCall(uint256 targetSeed, uint256 fnSeed, uint256 actorSeed) external step act {
        uint8 t = uint8(_r(targetSeed, "self target") % 2);
        bytes memory data = _scheduledOnlyCall(t, _r(fnSeed, "fn"));
        if (data.length == 0) return;
        uint256 a = _r(actorSeed, "self actor") % 5;
        address caller = a == 0
            ? owner
            : a == 1 ? _guardianOf(t) : a == 2 ? w.stranger : a == 3 ? address(_target(t)) : address(_target(1 - t));
        bytes memory expect = _scheduledOnly(t, _sel(data)) || caller == owner
            ? abi.encodeWithSelector(NotScheduled.selector)
            : _notOwner(caller);
        _readLogs();
        vm.prank(caller);
        (bool ok, bytes memory reason) = address(_target(t)).call(data);
        if (ok) {
            _readLogs();
            ++selfCallsAdmitted;
            ++unexpectedReverts;
            return;
        }
        _dropLogs();
        if (_judge(false, reason, expect)) ++selfCallsRefused;
    }

    /// One scheduled-only call on `t` drawn by `r`: an onlyScheduled function, or an owner setter with a strict
    /// loosening of the model's value (none when the value is at its loosening end and the type has no value past it).
    function _scheduledOnlyCall(uint8 t, uint256 r) internal view returns (bytes memory) {
        uint256 k = r % (t == V ? 15 : 9);
        if (t == V) {
            if (k == 0) return abi.encodeCall(CascadeBase.setGuardian, (_staleGuardian(V)));
            if (k == 1) return abi.encodeCall(CascadeBase.transferOwnership, (w.owner2));
            if (k == 2) return abi.encodeCall(CascadeBase.activateBridge, (bridges[2]));
            if (k == 3) return abi.encodeCall(CascadeVault.activateFrontDoor, (SECOND_CHAIN, w.door2));
            if (k == 4) return abi.encodeCall(CascadeVault.moveStake, (HK2, HK1, 1));
            if (k == 5) return abi.encodeCall(CascadeVault.writeOffMissingStake, (1));
            if (k == 6) {
                if (_m[V_MAX_TOTAL] == type(uint256).max) return "";
                return abi.encodeCall(CascadeVault.setMaxTotalAssets, (_m[V_MAX_TOTAL] + 1));
            }
            if (k == 7) {
                return abi.encodeCall(CascadeVault.setOutflowLimits, (_m[V_BPS] + 1, _m[V_FLOOR], _m[V_GLOBAL]));
            }
            if (k == 8) {
                return
                    abi.encodeCall(CascadeVault.setMessageLimits, (_m[V_ENTRY], _m[V_MSG] + 1, uint32(_m[V_MIN_CHUNK])));
            }
            if (k == 9) return abi.encodeCall(CascadeVault.setFeeLimits, (_m[V_FEE_BPS] + 1, _m[V_FEE_ABS]));
            if (k == 10) return abi.encodeCall(CascadeVault.setPayoutDelay, (uint64(_m[V_DELAY] - 1)));
            if (k == 11) {
                return
                    abi.encodeCall(CascadeVault.setRewardCut, (address(uint160(_m[V_TREASURY])), uint16(_m[V_CUT] + 1)));
            }
            if (k == 12) return abi.encodeCall(CascadeVault.setRewardVesting, (uint64(_m[V_VESTING] - 1)));
            if (k == 13) {
                return _m[V_IDLE] == 0 ? bytes("") : abi.encodeCall(CascadeVault.setIdleBuffer, (_m[V_IDLE] - 1));
            }
            return abi.encodeCall(CascadeVault.setStakeHotkey, (HK2));
        }
        if (k == 0) return abi.encodeCall(CascadeBase.setGuardian, (_staleGuardian(D)));
        if (k == 1) return abi.encodeCall(CascadeBase.transferOwnership, (w.owner2));
        if (k == 2) return abi.encodeCall(CascadeBase.activateBridge, (bridges[1]));
        if (k == 3) return abi.encodeCall(CascadeFrontDoor.setOracle, (ICascadeTwap(w.stranger)));
        if (k == 4) return abi.encodeCall(CascadeFrontDoor.setSwapper, (w.stranger));
        if (k == 5) return abi.encodeCall(CascadeFrontDoor.setMaxDeliverySlippage, (uint16(_m[D_SLIPPAGE] + 1)));
        if (k == 6) {
            return _m[D_INTERVAL] == 0
                ? bytes("")
                : abi.encodeCall(CascadeFrontDoor.setBatchInterval, (uint64(_m[D_INTERVAL] - 1)));
        }
        if (k == 7) return abi.encodeCall(CascadeFrontDoor.setMaxBatchValue, (_m[D_MAX_BATCH] + 1));
        uint8 idx = uint8(r >> 8) % 2;
        return _m[D_POOL + idx] == 0
            ? bytes("")
            : abi.encodeCall(CascadeFrontDoor.setMinPoolLiquidity, (idx, uint128(_m[D_POOL + idx] - 1)));
    }

    // =====================================================================================================
    // the ownership transfer's tail
    // =====================================================================================================

    /// @dev acceptOwnership, in a snapshot (the actor table stays fixed: an accepted transfer is undone at once), by the
    /// pending owner's candidate, the stranger or the owner. Predicted in its order: LapsedItem past pendingSince +
    /// EXECUTE_WINDOW (and while nothing is pending), ExitsNotOpen unless the exits are open and neither clock has reached
    /// pendingSince, then OpenZeppelin's caller check (OwnableUnauthorizedAccount); a success leaves the caller the owner
    /// with nothing pending (I-22's tail). An acceptance its gate refuses that succeeded breaks I-22.
    function acceptOwnership(uint256 targetSeed, uint256 actorSeed) external step act {
        uint8 t = uint8(_r(targetSeed, "accept target") % 2);
        uint256 a = _r(actorSeed, "acceptor") % 8;
        _probeAcceptance(t, a < 6 ? w.owner2 : a == 6 ? w.stranger : owner);
    }

    /// One acceptance by `caller` on `t`, in a snapshot, predicted and judged (see acceptOwnership).
    function _probeAcceptance(uint8 t, address caller) internal {
        uint64 since = uint64(_m[_f(t, F_PENDING_SINCE)]);
        bytes memory expect;
        if (vm.getBlockTimestamp() > uint256(since) + WINDOW) {
            expect = abi.encodeWithSelector(LapsedItem.selector);
        } else if (!_exitsOpen(t) || Math.max(_m[_f(t, F_OWNER_CLOCK)], _m[_f(t, F_GUARDIAN_CLOCK)]) >= since) {
            expect = abi.encodeWithSelector(ExitsNotOpen.selector);
        } else if (caller != address(uint160(_m[_f(t, F_PENDING_OWNER)]))) {
            expect = _notOwner(caller);
        }
        CascadeBase c = _target(t);
        _readLogs();
        uint256 snap = vm.snapshotState();
        vm.prank(caller);
        (bool ok, bytes memory reason) = address(c).call(abi.encodeCall(CascadeBase.acceptOwnership, ()));
        bool tookOver = ok && c.owner() == caller && c.pendingOwner() == address(0) && _lens(t).pendingSince() == 0;
        vm.revertToState(snap);
        _dropLogs();
        bool matched = ok ? expect.length == 0 && tookOver : keccak256(reason) == keccak256(expect);
        ++acceptanceProbes;
        if (ok && matched) ++acceptancesAdmitted;
        if (!matched) {
            if (ok) ++acceptanceViolations;
            ++unexpectedReverts;
        }
    }

    // =====================================================================================================
    // the launch door's payouts (the instrument cancelPayoutBatch, and payouts with the door or the bridge down)
    // =====================================================================================================

    /// @dev alice asks to redeem 0.1% to 5% of her shares at the launch door and the batch closes, delivered at once to
    /// the vault, which burns within the windows and queues a one-entry payout batch. Only while the delivery must land
    /// (the vault unpaused, the launch door Active, the front door's primary a MockBridge enabled on both sides), so no
    /// delivery is ever filed for retry.
    function queueRedeem(uint256 seed) external step act {
        address p = address(uint160(_m[_f(D, F_PRIMARY)]));
        uint256 j = _bridgeIndex(p);
        if (
            _m[_f(V, F_PAUSED)] != 0 || DoorState(_m[V_DOOR]) != DoorState.Active || j == 2
                || _m[_f(D, F_ENABLED + j)] == 0 || _m[_f(V, F_ENABLED + j)] == 0
        ) return;
        address alice = w.alice;
        uint256 shares = vault.balanceOf(alice) * (1 + _r(seed, "redeem") % 50) / 1_000;
        if (shares == 0) return;
        uint256 fee = fd.redeemRequestFee();
        vm.deal(alice, alice.balance + fee);
        // both calls must succeed here (the request works whatever the door's state; the close is due, funded and its
        // primary enabled): each is judged, so a refusal counts instead of dropping the step
        _readLogs();
        vm.prank(alice);
        try fd.requestRedeem{value: fee}(shares) {
            _readLogs();
        } catch (bytes memory reason) {
            _dropLogs();
            _judge(false, reason, "");
            return;
        }
        if (!fd.canClose()) _warp(fd.batchInterval(), doorBlockTime);
        (uint64 id,,,,,) = fd.openBatch();
        uint256 failedBefore = MockBridge(p).failedCount();
        _readLogs();
        try fd.closeBatch{value: FEE}(id, 0) {}
        catch (bytes memory reason) {
            _dropLogs();
            _judge(false, reason, "");
            return;
        }
        Vm.Log[] memory logs = _readLogs();
        if (MockBridge(p).failedCount() != failedBefore) ++unexpectedReverts;
        bytes32 key;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(vault) || l.topics.length == 0) continue;
            if (l.topics[0] == Redeemed.selector) {
                (uint256 s, uint256 assets) = abi.decode(l.data, (uint256, uint256));
                _queued.push(Queued(l.topics[1], _topicAddress(l.topics[2]), s, assets));
            } else if (l.topics[0] == PayoutBatchQueued.selector) {
                key = l.topics[1];
            }
        }
        if (key != bytes32(0)) ++redeemsQueued;
    }

    /// @dev A queued batch's payout, after (two draws in three) a wait past its payout delay. Predicted in the vault's
    /// and L3's order: the pause (EnforcedPause), the delay (PayoutDelayed), the batch's door (FrontDoorInactive), the
    /// primary bridge (PrimaryBridgeDisabled): with the door and the bridge both down the door's refusal comes first
    /// (M-4). Else the one entry goes out through the primary, the probe included.
    function processPayouts(uint256 seed) external step act {
        _payout(seed);
    }

    /// One payout of a queued batch drawn by `seed`, predicted and judged (see processPayouts).
    function _payout(uint256 seed) internal {
        if (_queued.length == 0) return;
        uint256 k = _r(seed, "payout") % _queued.length;
        Queued memory q = _queued[k];
        PayoutBatch memory b = vaultLens.getPayoutBatch(q.key);
        if (_r(seed, "wait") % 3 != 0) {
            uint256 due = uint256(b.queuedAt) + _m[V_DELAY];
            if (due > vm.getBlockTimestamp()) _warp(due - vm.getBlockTimestamp(), doorBlockTime);
        }
        bool doorDown = DoorState(_m[V_DOOR]) != DoorState.Active;
        uint256 p = _bridgeIndex(address(uint160(_m[_f(V, F_PRIMARY)])));
        bool bridgeDown = _m[_f(V, F_ENABLED + p)] == 0;
        bytes memory expect;
        if (_m[_f(V, F_PAUSED)] != 0) {
            expect = abi.encodeWithSelector(Pausable.EnforcedPause.selector);
        } else if (vm.getBlockTimestamp() < uint256(b.queuedAt) + _m[V_DELAY]) {
            expect = abi.encodeWithSelector(PayoutDelayed.selector);
        } else if (doorDown) {
            expect = abi.encodeWithSelector(FrontDoorInactive.selector);
        } else if (bridgeDown) {
            expect = abi.encodeWithSelector(PrimaryBridgeDisabled.selector);
        }
        CascadeMessages.Payout[] memory list = new CascadeMessages.Payout[](1);
        list[0] = CascadeMessages.Payout(q.user, q.shares, q.assets);
        _readLogs();
        try vault.processPayouts(q.key, list, 0) {
            _readLogs();
            if (!_judge(true, "", expect)) return;
            _dropQueued(k);
            ++payoutsSent;
            if (p == 2) ++payoutsThroughProbe;
        } catch (bytes memory reason) {
            _dropLogs();
            if (!_judge(false, reason, expect)) return;
            bytes4 e = _selector(expect);
            if (e == Pausable.EnforcedPause.selector) ++payoutsRefusedPaused;
            else if (e == PayoutDelayed.selector) ++payoutsRefusedDelayed;
            else if (e == FrontDoorInactive.selector && bridgeDown) ++payoutsRefusedBothDown;
            else if (e == FrontDoorInactive.selector) ++payoutsRefusedDoorDown;
            else ++payoutsRefusedBridgeDown;
        }
    }

    /// @dev The owner cancels a queued launch-door batch (re-minting alice's shares): an instrument, stamping the owner's
    /// clock (ExitsClosed; spec §3.6 row 5), paused or not. The guardian's is refused (OwnableUnauthorizedAccount: row 5
    /// SG, the guardian cannot cancel a batch).
    function cancelBatch(uint256 seed, uint256 actorSeed) external step act {
        if (_queued.length == 0) return;
        uint256 k = _r(seed, "cancel batch") % _queued.length;
        Queued memory q = _queued[k];
        address caller = _r(actorSeed, "batch canceller") % 4 == 0 ? guardianOfVault() : owner;
        bytes memory expect = caller == owner ? bytes("") : _notOwner(caller);
        CascadeMessages.Payout[] memory list = new CascadeMessages.Payout[](1);
        list[0] = CascadeMessages.Payout(q.user, q.shares, q.assets);
        _readLogs();
        vm.prank(caller);
        try vault.cancelPayoutBatch(q.key, list) {
            Vm.Log[] memory logs = _readLogs();
            if (!_judge(true, "", expect)) return;
            if (
                _countBy(logs, address(vault), ExitsClosed.selector, bytes32(uint256(uint160(caller))), address(0)) != 1
            ) {
                ++eventMismatches;
            }
            _dropQueued(k);
            _stamp(V, Actor.Owner);
            ++batchCancels;
        } catch (bytes memory reason) {
            _dropLogs();
            if (_judge(false, reason, expect)) ++instrumentsRefused;
        }
    }

    function _dropQueued(uint256 k) internal {
        _queued[k] = _queued[_queued.length - 1];
        _queued.pop();
    }

    // =====================================================================================================
    // time
    // =====================================================================================================

    /// @dev Time passes: a second, an hour, 12 hours, a day, two, three or eight days, the blocks rolled at the front
    /// door's rate (which meets the vault's too); one draw in eight a chain halt (the time passes, the blocks do not),
    /// and one in eight the blocks catch up with a halt (rolled to the time's pace since the campaign's start).
    function warp(uint256 seed) external step act {
        uint256 r = _r(seed, "warp");
        uint256 mode = r % 8;
        uint32[7] memory secs = [uint32(1), 1 hours, 12 hours, 1 days, 2 days, 3 days, 8 days];
        uint256 s = secs[(r >> 8) % 7];
        if (mode == 0) {
            vm.warp(vm.getBlockTimestamp() + s);
            ++halts;
        } else if (mode == 1) {
            uint256 pace = blockStart + (vm.getBlockTimestamp() - stackStart) * 1000 / doorBlockTime;
            if (vm.getBlockNumber() < pace) vm.roll(pace);
        } else {
            _warp(s, doorBlockTime);
        }
        _raiseFloor();
    }

    // =====================================================================================================
    // the honest owner's way back
    // =====================================================================================================

    /// @dev The honest owner answers a closure on either target (the vault three draws in four), with the instruments'
    /// own ways back (spec §3.6): an unpause; for a disabled primary, one draw in two a switch to another enabled bridge
    /// within its cap, else the primary's Reopen; for the launch door's hold, a Reopen of a Removed launch-chain door
    /// when the hold is the owner's, a guardian swap (to the sitting guardian) when it is the guardian's; with no hold, a
    /// door that is down comes back (its Reopen, or a guardian-removed door's Ordinary activation). An item is scheduled
    /// when none is pending alive (one draw in two run at once), else waited for and executed: every call goes through
    /// the actions' own predicted and judged bodies, so a refusal still counts. Without it, a run spends most of its
    /// steps closed and few items live to execute.
    function restore(uint256 seed) external step act {
        uint8 t = _r(seed, "restore") % 4 == 0 ? D : V;
        if (_m[_f(V, F_PAUSED)] != 0 && t == V) {
            _unpause(V, owner);
        } else if (_m[_f(t, F_DISABLED_BY)] != 0) {
            uint256 p = _bridgeIndex(address(uint160(_m[_f(t, F_PRIMARY)])));
            // one draw in two, a switch to another enabled bridge within its cap; else (or with none) the Reopen
            for (uint256 j; j < 3 && _r(seed, "switch") % 2 == 0; ++j) {
                if (j != p && _m[_f(t, F_ENABLED + j)] != 0 && _m[t == V ? V_MSG : D_MAX_BATCH] <= _capOf(j)) {
                    _setPrimary(t, j, owner);
                    return;
                }
            }
            _bringBack(t, abi.encodeCall(CascadeBase.activateBridge, (bridges[p])));
        } else if (t == V && _m[V_LAUNCH_BY] == uint256(Actor.Guardian)) {
            _bringBack(V, abi.encodeCall(CascadeBase.setGuardian, (_guardianOf(V))));
        } else if (t == V && _m[V_LAUNCH_BY] == uint256(Actor.Owner)) {
            for (uint256 i; i < 2; ++i) {
                if (DoorState(_m[V_DOOR + i]) == DoorState.Removed) {
                    _bringBack(V, _activation(i));
                    return;
                }
            }
        } else if (t == V) {
            // no hold: a door that is down comes back (an owner-removed one by its Reopen, a guardian-removed one by its
            // Ordinary activation), the one the seed draws first
            uint256 start = _r(seed, "door back") % 3;
            for (uint256 k; k < 3; ++k) {
                uint256 i = (start + k) % 3;
                if (DoorState(_m[V_DOOR + i]) != DoorState.Active) {
                    _bringBack(V, _activation(i));
                    return;
                }
            }
        }
    }

    /// `data`'s item on `t`: scheduled when none is pending or the pending one is dead or lapsed, else waited for (its
    /// readyAt and readyBlock) and executed.
    function _bringBack(uint8 t, bytes memory data) internal {
        uint256 ix = _live[t][keccak256(data)];
        if (ix != 0) {
            Ghost storage g = _ghosts[ix - 1];
            if (!_dead(t, g) && !_lapsed(t, g.readyAt, g.readyBlock)) {
                _waitFor(t, data, 1);
                _execute(t, data, owner);
                return;
            }
        }
        _waitOutClocks(t);
        // one draw in two, run at once (Schedule.run's steps), as the schedule action does
        if (_schedule(t, data, owner) && uint256(keccak256(abi.encode(data, vm.getBlockTimestamp()))) % 2 == 0) {
            _waitFor(t, data, 1);
            _execute(t, data, owner);
            ++runsInOneStep;
        }
    }

    /// A second's wait when either of `t`'s clocks reads this second (an item scheduled now would be born dead).
    function _waitOutClocks(uint8 t) internal {
        if (Math.max(_m[_f(t, F_OWNER_CLOCK)], _m[_f(t, F_GUARDIAN_CLOCK)]) >= vm.getBlockTimestamp()) {
            _warp(1, doorBlockTime);
        }
    }

    // =====================================================================================================
    // the pins' entry points: each action's body with its choices named (not fuzzed; Task 39b's walk may use them)
    // =====================================================================================================

    function pinSchedule(uint8 t, bytes memory data) external step act pinned {
        _schedule(t, data, owner);
    }

    /// Waits for `data`'s item as execute's `mode` does (1 to its readyAt, 4 one second short, 5 the window's end, 6 one
    /// second past it, 7 a halt to its readyAt), then the owner executes it.
    function pinExecute(uint8 t, bytes memory data, uint256 mode) external step act pinned {
        _waitFor(t, data, mode);
        _execute(t, data, owner);
    }

    function pinDirect(uint8 t, bytes memory data) external step act pinned {
        _direct(t, data, owner);
    }

    function pinCancel(uint8 t, bytes memory data, address caller) external step act pinned {
        _cancel(t, data, caller);
    }

    function pinRemove(uint256 i, address caller) external step act pinned {
        _removeDoor(i, caller);
    }

    function pinDisable(uint8 t, uint256 j, address caller) external step act pinned {
        _disable(t, j, caller);
    }

    function pinSetPrimary(uint8 t, uint256 j) external step act pinned {
        _setPrimary(t, j, owner);
    }

    function pinPause(uint8 t, address caller) external step act pinned {
        _pause(t, caller);
    }

    function pinUnpause(uint8 t) external step act pinned {
        _unpause(t, owner);
    }

    /// The owner's stamp as of `asOf` on `t` relayed again by `relayer`: a replay when it was relayed before.
    function pinReplay(uint8 t, uint64 asOf, address relayer) external step act pinned {
        bytes memory sig = Stamps.sign(w.ownerKey, Stamps.digest(block.chainid, address(_target(t)), asOf));
        _relay(t, asOf, sig, true, relayer, 4);
    }

    /// The owner's stamp as of `asOf` on `t`, relayed by the stranger.
    function pinStamp(uint8 t, uint64 asOf) external step act pinned {
        bytes memory sig = Stamps.sign(w.ownerKey, Stamps.digest(block.chainid, address(_target(t)), asOf));
        _relay(t, asOf, sig, true, w.stranger, 0);
    }

    function pinWarp(uint256 secs) external step act pinned {
        _warp(secs, doorBlockTime);
    }

    // =====================================================================================================
    // the setter table
    // =====================================================================================================

    /// The setter-table entry `e` (0 to 20 the vault's, 21 to 33 the front door's), its arguments drawn by `seed` around
    /// the model's values: an intent (tighten or keep, three in eight; loosen, two in eight; a bound; one past a bound;
    /// any in-bounds value). A multi-field setter (setOutflowLimits, setMessageLimits, setFeeLimits, setRewardCut's
    /// treasury and cut) draws its fields by `_field`: jointly, each alone, one loosening with the rest tightened or kept,
    /// or one past a bound with the rest tightened or kept (Task 39a's review, C1).
    function _generate(uint256 e, uint256 seed) internal view returns (uint8 t, bytes memory data) {
        uint256 r = _r(seed, "args");
        uint256 intent = r % 8;
        t = e < 21 ? V : D;
        if (e == 0) {
            data = abi.encodeCall(
                CascadeVault.setMaxTotalAssets, (_v(_m[V_MAX_TOTAL], 0, type(uint256).max, true, intent, _rn(r, 0)))
            );
        } else if (e == 1) {
            uint256 out = _rn(r, 9) % 3;
            data = abi.encodeCall(
                CascadeVault.setOutflowLimits,
                (
                    _v(_m[V_BPS], MIN_OUTFLOW_BPS, MAX_OUTFLOW_BPS, true, _field(r, out, 0), _rn(r, 1)),
                    _v(_m[V_FLOOR], MIN_MIN_DAILY_OUTFLOW, MAX_MIN_DAILY_OUTFLOW, true, _field(r, out, 1), _rn(r, 2)),
                    _v(_m[V_GLOBAL], MIN_OUTFLOW_BPS, MAX_OUTFLOW_BPS, true, _field(r, out, 2), _rn(r, 3))
                )
            );
        } else if (e == 2) {
            uint256 out = _rn(r, 9) % 3;
            uint256 msgIntent = _field(r, out, 1);
            uint256 entry = _v(_m[V_ENTRY], MIN_ENTRY_VALUE, MAX_MESSAGE_VALUE, true, _field(r, out, 0), _rn(r, 1));
            uint256 msgv = _v(_m[V_MSG], MIN_ENTRY_VALUE, MAX_MESSAGE_VALUE, true, msgIntent, _rn(r, 2));
            uint256 chunk = _v(_m[V_MIN_CHUNK], 1, CascadeMessages.MAX_ENTRIES, false, _field(r, out, 2), _rn(r, 3));
            // keep entry <= message: raise the message when it loosens, else lower the entry to it
            if (entry > msgv && (msgIntent == 3 || msgIntent == 4)) msgv = entry;
            else if (entry > msgv && msgIntent != 6) entry = msgv;
            data = abi.encodeCall(CascadeVault.setMessageLimits, (entry, msgv, uint32(chunk)));
        } else if (e == 3) {
            uint256 out = _rn(r, 9) % 2;
            data = abi.encodeCall(
                CascadeVault.setFeeLimits,
                (
                    _v(_m[V_FEE_BPS], 0, MAX_FEE_BPS, true, _field(r, out, 0), _rn(r, 1)),
                    _v(_m[V_FEE_ABS], MIN_FEE_ABS, MAX_FEE_ABS, true, _field(r, out, 1), _rn(r, 2))
                )
            );
        } else if (e == 4) {
            data = abi.encodeCall(
                CascadeVault.setPayoutDelay,
                (uint64(_v(_m[V_DELAY], MIN_PAYOUT_DELAY, MAX_PAYOUT_DELAY, false, intent, _rn(r, 0))))
            );
        } else if (e == 5) {
            // the treasury (field 0) and the cut (field 1) each drawn by its own intent
            uint256 out = _rn(r, 9) % 2;
            uint256 bps = _v(_m[V_CUT], 0, vaultLens.MAX_REWARD_CUT_BPS(), true, _field(r, out, 1), _rn(r, 0));
            data = abi.encodeCall(CascadeVault.setRewardCut, (_treasuryDraw(_field(r, out, 0), _rn(r, 1)), uint16(bps)));
        } else if (e == 6) {
            data = abi.encodeCall(
                CascadeVault.setRewardVesting,
                (uint64(_v(_m[V_VESTING], MIN_REWARD_VESTING, MAX_REWARD_VESTING, false, intent, _rn(r, 0))))
            );
        } else if (e == 7) {
            data = abi.encodeCall(
                CascadeVault.setIdleBuffer, (_v(_m[V_IDLE], 0, MAX_IDLE_BUFFER_BPS, false, intent, _rn(r, 0)))
            );
        } else if (e == 8) {
            bytes32[3] memory hks = [HK1, HK2, HK3];
            data = abi.encodeCall(CascadeVault.setStakeHotkey, (hks[_rn(r, 0) % 3]));
        } else if (e == 9) {
            bytes32[3] memory hks = [HK1, HK2, HK3];
            data = abi.encodeCall(CascadeVault.moveStake, (hks[_rn(r, 0) % 3], hks[_rn(r, 1) % 2], 1 + _rn(r, 2) % 1e9));
        } else if (e == 10) {
            data = abi.encodeCall(CascadeVault.writeOffMissingStake, (_rn(r, 0) % 2 == 0 ? 0 : 1e9));
        } else if (e == 11) {
            data = _doorActivation(r);
        } else if (e == 12 || e == 27) {
            data = _bridgeActivation(t, r);
        } else if (e == 13 || e == 28) {
            data = abi.encodeCall(CascadeBase.setGuardian, (_guardianCandidate(t, r)));
        } else if (e == 14 || e == 29) {
            address[4] memory to = [w.owner2, w.owner2, address(0), owner];
            address o = _rn(r, 0) % 8 == 0 ? _guardianOf(t) : to[_rn(r, 1) % 4];
            data = abi.encodeCall(CascadeBase.transferOwnership, (o));
        } else if (e == 15 || e == 33) {
            address[3] memory k = [address(this), w.stranger, address(0)];
            data = abi.encodeCall(CascadeVault.setKeeper, (k[_rn(r, 0) % 3]));
        } else if (e == 16) {
            uint256[3] memory a = [uint256(0), 1e15, 1e18];
            data = abi.encodeCall(CascadeVault.setMinDirectDeposit, (a[_rn(r, 0) % 3]));
        } else if (e == 17) {
            data = abi.encodeCall(
                CascadeVault.setClaimGasRequired,
                (_v(_m[V_CLAIM_GAS], vaultLens.MIN_CLAIM_GAS(), vaultLens.MAX_CLAIM_GAS(), true, intent, _rn(r, 0)))
            );
        } else if (e == 18) {
            data = abi.encodeCall(
                CascadeVault.setHotkeyDustRao, (_v(_m[V_DUST], 0, MAX_HOTKEY_DUST_RAO, true, intent, _rn(r, 0)))
            );
        } else if (e == 19) {
            data = abi.encodeCall(
                CascadeVault.setUnstakeMarginRao, (_v(_m[V_MARGIN], 0, MAX_UNSTAKE_MARGIN_RAO, true, intent, _rn(r, 0)))
            );
        } else if (e == 20) {
            data = abi.encodeCall(
                CascadeVault.setUnstakeGas,
                (_v(_m[V_UNSTAKE_GAS], MIN_UNSTAKE_GAS, MAX_UNSTAKE_GAS, true, intent, _rn(r, 0)))
            );
        } else if (e == 21) {
            address[3] memory o = [w.twap, w.stranger, address(0)];
            data = abi.encodeCall(CascadeFrontDoor.setOracle, (ICascadeTwap(o[_rn(r, 0) % 3])));
        } else if (e == 22) {
            address[3] memory s = [w.swapper, w.stranger, address(0)];
            data = abi.encodeCall(CascadeFrontDoor.setSwapper, (s[_rn(r, 0) % 3]));
        } else if (e == 23) {
            data = abi.encodeCall(
                CascadeFrontDoor.setMaxDeliverySlippage,
                (uint16(_v(_m[D_SLIPPAGE], 0, fd.MAX_DELIVERY_SLIPPAGE_BPS(), true, intent, _rn(r, 0))))
            );
        } else if (e == 24) {
            data = abi.encodeCall(
                CascadeFrontDoor.setBatchInterval,
                (uint64(_v(_m[D_INTERVAL], 0, fd.MAX_BATCH_INTERVAL(), false, intent, _rn(r, 0))))
            );
        } else if (e == 25) {
            data = abi.encodeCall(
                CascadeFrontDoor.setMaxBatchValue,
                (_v(_m[D_MAX_BATCH], 0, fd.MAX_BATCH_VALUE(), true, intent, _rn(r, 0)))
            );
        } else if (e == 26) {
            uint8 idx = uint8(_rn(r, 0) % 5 == 0 ? 2 : _rn(r, 1) % 2);
            uint256 cur = idx > 1 ? 0 : _m[D_POOL + idx];
            data = abi.encodeCall(
                CascadeFrontDoor.setMinPoolLiquidity,
                (idx, uint128(_v(cur, 0, type(uint128).max, false, intent, _rn(r, 2))))
            );
        } else if (e == 30) {
            data = abi.encodeCall(
                CascadeFrontDoor.setCaps,
                (
                    _v(_m[D_MIN_DEPOSIT], fd.MIN_DEPOSIT_FLOOR(), fd.MAX_BATCH_VALUE(), true, intent, _rn(r, 0)),
                    _m[D_CAP]
                )
            );
        } else if (e == 31) {
            uint256 out = _rn(r, 9) % 2;
            data = abi.encodeCall(
                CascadeFrontDoor.setBatchLimits,
                (
                    uint32(
                        _v(_m[D_MAX_DEPOSITS], 1, CascadeMessages.MAX_ENTRIES, true, _field(intent, out, 0), _rn(r, 1))
                    ),
                    uint32(
                        _v(_m[D_MAX_REDEEMS], 1, CascadeMessages.MAX_ENTRIES, true, _field(intent, out, 1), _rn(r, 2))
                    )
                )
            );
        } else {
            data = abi.encodeCall(
                CascadeFrontDoor.setRedeemRequestFee,
                (_v(_m[D_REQUEST_FEE], 0, fd.MAX_REDEEM_REQUEST_FEE(), true, intent, _rn(r, 0)))
            );
        }
    }

    /// The intent of field `field` of a multi-field setter, from the call's draw `r` (Task 39a's review, C1): every field
    /// the call's one intent (joint), each field its own draw, a lone loosening of field `out` with the rest tightened
    /// or kept, or field `out` one past a bound with the rest tightened or kept.
    function _field(uint256 r, uint256 out, uint256 field) internal pure returns (uint256) {
        uint256 shape = (r >> 32) % 8;
        // joint, three draws in eight: every field the call's own intent (a joint tightening is I-23's case)
        if (shape < 2 || shape == 7) return r % 8;
        // each field drawn alone, two in eight
        if (shape < 4) return _rn(r, 100 + field) % 8;
        // one field loosens and the rest tighten or keep, two in eight (the lone loosening a direction check must see)
        if (shape < 6) return field == out ? 3 : 0;
        // one field one past a bound and the rest tighten or keep
        return field == out ? 6 : 0;
    }

    /// The reward cut's treasury under `intent`: a loosening (3, 4) names another (the second treasury or the
    /// fixture's, whichever the model does not hold; one draw in four the zero one); one past a bound (6), zero; any
    /// value (7), one of the four; else the model's.
    function _treasuryDraw(uint256 intent, uint256 r) internal view returns (address) {
        address cur = address(uint160(_m[V_TREASURY]));
        address other = cur == _treasury2() ? w.treasury : _treasury2();
        if (intent == 3 || intent == 4) return r % 4 == 0 && cur != address(0) ? address(0) : other;
        if (intent == 6) return address(0);
        if (intent == 7) return [cur, other, w.treasury, address(0)][r % 4];
        return cur;
    }

    /// A value for a field now at `cur` in [lo, hi], loosening upward (`up`) or downward, by `intent` (see _generate):
    /// 0 to 2 a step tighter (or, one draw in four, the same), 3 and 4 a step looser, 5 a bound, 6 one past a bound (the
    /// value itself when the type ends there), 7 any value in the bounds.
    function _v(uint256 cur, uint256 lo, uint256 hi, bool up, uint256 intent, uint256 r)
        internal
        pure
        returns (uint256)
    {
        if (cur < lo) cur = lo;
        if (cur > hi) cur = hi;
        uint256 span = hi - lo;
        uint256 step = 1 + (r >> 8) % (span / 4 + 1);
        if (intent < 3) {
            if ((r >> 4) % 4 == 0) return cur;
            return up ? (cur > lo + step ? cur - step : lo) : (hi - cur > step ? cur + step : hi);
        }
        if (intent < 5) return up ? (hi - cur > step ? cur + step : hi) : (cur > lo + step ? cur - step : lo);
        if (intent == 5) return (r >> 4) % 2 == 0 ? lo : hi;
        if (intent == 6) {
            if ((r >> 4) % 2 == 0 && lo > 0) return lo - 1;
            return hi == type(uint256).max || hi == type(uint128).max ? (lo > 0 ? lo - 1 : cur) : hi + 1;
        }
        return span == type(uint256).max ? r >> 16 : lo + (r >> 16) % (span + 1);
    }

    /// A door activation: the doors not active (two draws in three a Removed one when there is, for a Reopen), or a bad
    /// one (chain 0 and DIRECT_ORIGIN: InvalidParameter; the zero door: ZeroAddress), or an active one (AlreadyActive).
    function _doorActivation(uint256 r) internal view returns (bytes memory) {
        uint256 k = _rn(r, 0) % 16;
        if (k == 0) return abi.encodeCall(CascadeVault.activateFrontDoor, (uint64(0), w.door2));
        if (k == 1) return abi.encodeCall(CascadeVault.activateFrontDoor, (DIRECT_ORIGIN, w.door2));
        if (k == 2) return abi.encodeCall(CascadeVault.activateFrontDoor, (SECOND_CHAIN, address(0)));
        uint256 i = _rn(r, 1) % 3;
        if (k < 12) {
            // prefer a door not active, a Removed one first
            for (uint256 m; m < 3; ++m) {
                uint256 c = (i + m) % 3;
                if (DoorState(_m[V_DOOR + c]) == DoorState.Removed) return _activation(c);
            }
            for (uint256 m; m < 3; ++m) {
                uint256 c = (i + m) % 3;
                if (DoorState(_m[V_DOOR + c]) != DoorState.Active) return _activation(c);
            }
        }
        return _activation(i);
    }

    function _activation(uint256 i) internal view returns (bytes memory) {
        return abi.encodeCall(CascadeVault.activateFrontDoor, (doorChains[i], doorAddrs[i]));
    }

    /// A bridge activation on `t`: a bridge not enabled (three draws in four, when there is one), an enabled one
    /// (AlreadyActive), or the zero bridge (ZeroAddress).
    function _bridgeActivation(uint8 t, uint256 r) internal view returns (bytes memory) {
        uint256 k = _rn(r, 0) % 16;
        if (k == 0) return abi.encodeCall(CascadeBase.activateBridge, (address(0)));
        uint256 j = _rn(r, 1) % 3;
        if (k < 12) {
            for (uint256 m; m < 3; ++m) {
                uint256 c = (j + m) % 3;
                if (_m[_f(t, F_ENABLED + c)] == 0) return abi.encodeCall(CascadeBase.activateBridge, (bridges[c]));
            }
        }
        return abi.encodeCall(CascadeBase.activateBridge, (bridges[j]));
    }

    /// A guardian swap's target on `t`: the sitting guardian or the other candidate, or (one draw in eight each) the
    /// owner (InvalidParameter), the pending owner's candidate (InvalidParameter only while it is pending) or zero
    /// (ZeroAddress).
    function _guardianCandidate(uint8 t, uint256 r) internal view returns (address) {
        uint256 k = _rn(r, 0) % 8;
        if (k == 0) return owner;
        if (k == 1 && _m[_f(t, F_PENDING_OWNER)] == uint160(w.owner2)) return w.owner2;
        if (k == 2) return address(0);
        return guardians[_rn(r, 1) % 2];
    }

    // =====================================================================================================
    // the predictions: each setter's rule (spec §3.6 and the contracts' setters, check by check)
    // =====================================================================================================

    /// The classification `schedule` makes of `data` on `t` (its delay class and kind), or its refusal: UnknownSelector
    /// for a selector `t` does not schedule; BadCalldata for any other length than the selector's canonical one; an
    /// activation's own checks (chain 0 or DIRECT_ORIGIN: InvalidParameter; zero: ZeroAddress; active: AlreadyActive);
    /// setGuardian's (zero: ZeroAddress; the owner or the pending owner: InvalidParameter) and transferOwnership's (the
    /// guardian: InvalidParameter).
    function _classify(uint8 t, bytes memory data) internal view returns (bytes memory err, Delay cls, Kind kind) {
        bytes4 s = _sel(data);
        uint256 words = _argWords(t, s);
        if (words == 0) return (abi.encodeWithSelector(UnknownSelector.selector), cls, kind);
        if (data.length != 4 + 32 * words) return (abi.encodeWithSelector(BadCalldata.selector), cls, kind);
        if (s == CascadeVault.activateFrontDoor.selector) {
            (uint64 chain, address addr) = abi.decode(_args(data), (uint64, address));
            if (chain == 0 || chain == DIRECT_ORIGIN) {
                return (abi.encodeWithSelector(InvalidParameter.selector), cls, kind);
            }
            if (addr == address(0)) return (abi.encodeWithSelector(ZeroAddress.selector), cls, kind);
            DoorState st = DoorState(_m[V_DOOR + _doorIndex(chain, addr)]);
            if (st == DoorState.Active) return (abi.encodeWithSelector(AlreadyActive.selector), cls, kind);
            return ("", Delay.Registry, st == DoorState.Removed ? Kind.Reopen : Kind.Ordinary);
        }
        if (s == CascadeBase.setGuardian.selector) {
            address g = abi.decode(_args(data), (address));
            if (g == address(0)) return (abi.encodeWithSelector(ZeroAddress.selector), cls, kind);
            if (g == owner || g == address(uint160(_m[_f(t, F_PENDING_OWNER)]))) {
                return (abi.encodeWithSelector(InvalidParameter.selector), cls, kind);
            }
            return ("", Delay.Guardian, Kind.GuardianSwap);
        }
        if (s == CascadeBase.transferOwnership.selector) {
            if (abi.decode(_args(data), (address)) == _guardianOf(t)) {
                return (abi.encodeWithSelector(InvalidParameter.selector), cls, kind);
            }
            return ("", Delay.Guardian, Kind.Ordinary);
        }
        if (s == CascadeBase.activateBridge.selector) {
            address b = abi.decode(_args(data), (address));
            if (b == address(0)) return (abi.encodeWithSelector(ZeroAddress.selector), cls, kind);
            uint256 j = _bridgeIndex(b);
            if (_m[_f(t, F_ENABLED + j)] != 0) return (abi.encodeWithSelector(AlreadyActive.selector), cls, kind);
            return ("", Delay.Registry, _m[_f(t, F_KNOWN + j)] != 0 ? Kind.Reopen : Kind.Ordinary);
        }
        if (s == CascadeVault.writeOffMissingStake.selector) return ("", Delay.Registry, Kind.Ordinary);
        return ("", Delay.Param, Kind.Ordinary);
    }

    /// The canonical length, in ABI words, of a selector `t` schedules; 0 for one it does not.
    function _argWords(uint8 t, bytes4 s) internal pure returns (uint256) {
        if (s == CascadeBase.setGuardian.selector || s == CascadeBase.transferOwnership.selector) return 1;
        if (s == CascadeBase.activateBridge.selector) return 1;
        if (t == V) {
            if (s == CascadeVault.activateFrontDoor.selector) return 2;
            if (
                s == CascadeVault.writeOffMissingStake.selector || s == CascadeVault.setStakeHotkey.selector
                    || s == CascadeVault.setMaxTotalAssets.selector || s == CascadeVault.setPayoutDelay.selector
                    || s == CascadeVault.setRewardVesting.selector || s == CascadeVault.setIdleBuffer.selector
            ) return 1;
            if (s == CascadeVault.setFeeLimits.selector || s == CascadeVault.setRewardCut.selector) return 2;
            if (
                s == CascadeVault.moveStake.selector || s == CascadeVault.setMessageLimits.selector
                    || s == CascadeVault.setOutflowLimits.selector
            ) return 3;
            return 0;
        }
        if (
            s == CascadeFrontDoor.setOracle.selector || s == CascadeFrontDoor.setSwapper.selector
                || s == CascadeFrontDoor.setMaxDeliverySlippage.selector
                || s == CascadeFrontDoor.setBatchInterval.selector || s == CascadeFrontDoor.setMaxBatchValue.selector
        ) return 1;
        if (s == CascadeFrontDoor.setMinPoolLiquidity.selector) return 2;
        return 0;
    }

    /// The kind's gate and clock on `t` (spec §3.6's table, CascadeBase._gate): an Ordinary item needs the exits open and
    /// both clocks older than `notBefore`; a GuardianSwap no owner hold and the owner's clock older; a Reopen only the
    /// owner's clock older. Else ExitsNotOpen.
    function _gateErr(uint8 t, Kind kind, uint64 notBefore) internal view returns (bytes memory) {
        uint256 clock = _m[_f(t, F_OWNER_CLOCK)];
        if (kind == Kind.Ordinary) {
            if (!_exitsOpen(t)) return abi.encodeWithSelector(ExitsNotOpen.selector);
            clock = Math.max(clock, _m[_f(t, F_GUARDIAN_CLOCK)]);
        } else if (kind == Kind.GuardianSwap) {
            if (_ownerHold(t)) return abi.encodeWithSelector(ExitsNotOpen.selector);
        }
        if (clock >= notBefore) return abi.encodeWithSelector(ExitsNotOpen.selector);
        return "";
    }

    /// An execute's outcome from the ghost log and the model (see execute).
    function _executeExpect(uint8 t, bytes memory data, address caller) internal view returns (bytes memory) {
        if (caller != owner) return _notOwner(caller);
        uint256 ix = _live[t][keccak256(data)];
        if (ix == 0) return abi.encodeWithSelector(NoProposal.selector);
        Ghost storage g = _ghosts[ix - 1];
        if (vm.getBlockTimestamp() < g.readyAt || vm.getBlockNumber() < g.readyBlock) {
            return abi.encodeWithSelector(NotReady.selector);
        }
        if (_lapsed(t, g.readyAt, g.readyBlock)) return abi.encodeWithSelector(LapsedItem.selector);
        bytes memory gate = _gateErr(t, g.kind, g.scheduledAt);
        if (gate.length != 0) return gate;
        return _setterErr(t, data);
    }

    /// Whether item `g` on `t` is dead: its kind's clock reached its schedule time.
    function _dead(uint8 t, Ghost storage g) internal view returns (bool) {
        uint256 clock = _m[_f(t, F_OWNER_CLOCK)];
        if (g.kind == Kind.Ordinary) clock = Math.max(clock, _m[_f(t, F_GUARDIAN_CLOCK)]);
        return clock >= g.scheduledAt;
    }

    /// Whether `s` on `t` is reachable only through execute's self-call (onlyScheduled).
    function _scheduledOnly(uint8 t, bytes4 s) internal pure returns (bool) {
        if (
            s == CascadeBase.setGuardian.selector || s == CascadeBase.transferOwnership.selector
                || s == CascadeBase.activateBridge.selector
        ) return true;
        if (t == V) {
            return s == CascadeVault.activateFrontDoor.selector || s == CascadeVault.moveStake.selector
                || s == CascadeVault.writeOffMissingStake.selector;
        }
        return s == CascadeFrontDoor.setOracle.selector || s == CascadeFrontDoor.setSwapper.selector;
    }

    /// Whether `s` on `t` is an immediate setter (never scheduled, never loosening).
    function _immediate(uint8 t, bytes4 s) internal pure returns (bool) {
        if (t == V) {
            return s == CascadeVault.setKeeper.selector || s == CascadeVault.setMinDirectDeposit.selector
                || s == CascadeVault.setClaimGasRequired.selector || s == CascadeVault.setHotkeyDustRao.selector
                || s == CascadeVault.setUnstakeMarginRao.selector || s == CascadeVault.setUnstakeGas.selector;
        }
        return s == CascadeFrontDoor.setCaps.selector || s == CascadeFrontDoor.setBatchLimits.selector
            || s == CascadeFrontDoor.setRedeemRequestFee.selector || s == CascadeFrontDoor.setKeeper.selector;
    }

    /// Whether `data` on `t` loosens (spec §3.6: a multi-field setter loosens if any field does), against the model.
    /// setStakeHotkey always does here (no stake: the hotkey never holds more than the stake hotkey and half the booked
    /// stake). A scheduled-only function's change is a loosening by construction; an immediate setter never is.
    function _loosens(uint8 t, bytes memory data) internal view returns (bool) {
        bytes4 s = _sel(data);
        if (_scheduledOnly(t, s)) return true;
        if (_immediate(t, s)) return false;
        bytes memory a = _args(data);
        if (t == V) {
            if (s == CascadeVault.setMaxTotalAssets.selector) return abi.decode(a, (uint256)) > _m[V_MAX_TOTAL];
            if (s == CascadeVault.setOutflowLimits.selector) {
                (uint256 bps, uint256 floor, uint256 g) = abi.decode(a, (uint256, uint256, uint256));
                return bps > _m[V_BPS] || floor > _m[V_FLOOR] || g > _m[V_GLOBAL];
            }
            if (s == CascadeVault.setMessageLimits.selector) {
                (uint256 e, uint256 mv, uint32 mc) = abi.decode(a, (uint256, uint256, uint32));
                return e > _m[V_ENTRY] || mv > _m[V_MSG] || mc < _m[V_MIN_CHUNK];
            }
            if (s == CascadeVault.setFeeLimits.selector) {
                (uint256 bps, uint256 abs_) = abi.decode(a, (uint256, uint256));
                return bps > _m[V_FEE_BPS] || abs_ > _m[V_FEE_ABS];
            }
            if (s == CascadeVault.setPayoutDelay.selector) return abi.decode(a, (uint64)) < _m[V_DELAY];
            if (s == CascadeVault.setRewardCut.selector) {
                (address tr, uint16 bps) = abi.decode(a, (address, uint16));
                return bps > _m[V_CUT] || uint160(tr) != _m[V_TREASURY];
            }
            if (s == CascadeVault.setRewardVesting.selector) return abi.decode(a, (uint64)) < _m[V_VESTING];
            if (s == CascadeVault.setIdleBuffer.selector) return abi.decode(a, (uint256)) < _m[V_IDLE];
            // setStakeHotkey
            return true;
        }
        if (s == CascadeFrontDoor.setMaxDeliverySlippage.selector) return abi.decode(a, (uint16)) > _m[D_SLIPPAGE];
        if (s == CascadeFrontDoor.setBatchInterval.selector) return abi.decode(a, (uint64)) < _m[D_INTERVAL];
        if (s == CascadeFrontDoor.setMaxBatchValue.selector) return abi.decode(a, (uint256)) > _m[D_MAX_BATCH];
        // setMinPoolLiquidity
        (uint8 idx, uint128 v) = abi.decode(a, (uint8, uint128));
        return idx <= 1 && v < _m[D_POOL + idx];
    }

    /// Whether `data` on `t`, a multi-field setter, loosens exactly one of its fields against the model, and which:
    /// setOutflowLimits' bps, floor and global bps (0 to 2), setMessageLimits' entry, message and minChunk (3 to 5),
    /// setFeeLimits' bps and abs (6, 7), setRewardCut's treasury and cut (8, 9).
    function _loneLoosening(uint8 t, bytes memory data) internal view returns (bool lone, uint256 field) {
        if (t != V) return (false, 0);
        bytes4 s = _sel(data);
        bytes memory a = _args(data);
        bool[3] memory up;
        uint256 base;
        uint256 n;
        if (s == CascadeVault.setOutflowLimits.selector) {
            (uint256 bps, uint256 floor, uint256 g) = abi.decode(a, (uint256, uint256, uint256));
            (up[0], up[1], up[2], n) = (bps > _m[V_BPS], floor > _m[V_FLOOR], g > _m[V_GLOBAL], 3);
        } else if (s == CascadeVault.setMessageLimits.selector) {
            (uint256 e, uint256 mv, uint32 mc) = abi.decode(a, (uint256, uint256, uint32));
            (up[0], up[1], up[2], n, base) = (e > _m[V_ENTRY], mv > _m[V_MSG], mc < _m[V_MIN_CHUNK], 3, 3);
        } else if (s == CascadeVault.setFeeLimits.selector) {
            (uint256 bps, uint256 abs_) = abi.decode(a, (uint256, uint256));
            (up[0], up[1], n, base) = (bps > _m[V_FEE_BPS], abs_ > _m[V_FEE_ABS], 2, 6);
        } else if (s == CascadeVault.setRewardCut.selector) {
            (address tr, uint16 bps) = abi.decode(a, (address, uint16));
            (up[0], up[1], n, base) = (uint160(tr) != _m[V_TREASURY], bps > _m[V_CUT], 2, 8);
        } else {
            return (false, 0);
        }
        uint256 count;
        for (uint256 i; i < n; ++i) {
            if (up[i]) {
                ++count;
                field = base + i;
            }
        }
        lone = count == 1;
    }

    /// Whether `data` on `t` sets every field to its current value.
    function _isEqual(uint8 t, bytes memory data) internal view returns (bool) {
        bytes4 s = _sel(data);
        bytes memory a = _args(data);
        if (t == V) {
            if (s == CascadeVault.setMaxTotalAssets.selector) return abi.decode(a, (uint256)) == _m[V_MAX_TOTAL];
            if (s == CascadeVault.setOutflowLimits.selector) {
                (uint256 bps, uint256 floor, uint256 g) = abi.decode(a, (uint256, uint256, uint256));
                return bps == _m[V_BPS] && floor == _m[V_FLOOR] && g == _m[V_GLOBAL];
            }
            if (s == CascadeVault.setMessageLimits.selector) {
                (uint256 e, uint256 mv, uint32 mc) = abi.decode(a, (uint256, uint256, uint32));
                return e == _m[V_ENTRY] && mv == _m[V_MSG] && mc == _m[V_MIN_CHUNK];
            }
            if (s == CascadeVault.setFeeLimits.selector) {
                (uint256 bps, uint256 abs_) = abi.decode(a, (uint256, uint256));
                return bps == _m[V_FEE_BPS] && abs_ == _m[V_FEE_ABS];
            }
            if (s == CascadeVault.setPayoutDelay.selector) return abi.decode(a, (uint64)) == _m[V_DELAY];
            if (s == CascadeVault.setRewardCut.selector) {
                (address tr, uint16 bps) = abi.decode(a, (address, uint16));
                return bps == _m[V_CUT] && uint160(tr) == _m[V_TREASURY];
            }
            if (s == CascadeVault.setRewardVesting.selector) return abi.decode(a, (uint64)) == _m[V_VESTING];
            if (s == CascadeVault.setIdleBuffer.selector) return abi.decode(a, (uint256)) == _m[V_IDLE];
            return false;
        }
        if (s == CascadeFrontDoor.setMaxDeliverySlippage.selector) return abi.decode(a, (uint16)) == _m[D_SLIPPAGE];
        if (s == CascadeFrontDoor.setBatchInterval.selector) return abi.decode(a, (uint64)) == _m[D_INTERVAL];
        if (s == CascadeFrontDoor.setMaxBatchValue.selector) return abi.decode(a, (uint256)) == _m[D_MAX_BATCH];
        if (s == CascadeFrontDoor.setMinPoolLiquidity.selector) {
            (uint8 idx, uint128 v) = abi.decode(a, (uint8, uint128));
            return idx <= 1 && v == _m[D_POOL + idx];
        }
        return false;
    }

    /// A direct call's outcome (outside execute): an onlyScheduled function is NotScheduled whoever calls; any other is
    /// the owner's (OwnableUnauthorizedAccount), then its own first checks (setStakeHotkey's NotListed,
    /// setMinPoolLiquidity's index), then NotScheduled for a loosening, then the setter's own checks.
    function _directErr(uint8 t, bytes memory data, address caller) internal view returns (bytes memory) {
        bytes4 s = _sel(data);
        if (_scheduledOnly(t, s)) return abi.encodeWithSelector(NotScheduled.selector);
        if (caller != owner) return _notOwner(caller);
        if (t == V && s == CascadeVault.setStakeHotkey.selector) {
            bytes32 h = abi.decode(_args(data), (bytes32));
            if (h != HK1 && h != HK2) return abi.encodeWithSelector(NotListed.selector);
        }
        if (t == D && s == CascadeFrontDoor.setMinPoolLiquidity.selector) {
            (uint8 idx,) = abi.decode(_args(data), (uint8, uint128));
            if (idx > 1) return abi.encodeWithSelector(InvalidParameter.selector);
        }
        if (_loosens(t, data)) return abi.encodeWithSelector(NotScheduled.selector);
        return _setterErr(t, data);
    }

    /// The setter's own checks on `data` on `t` against the model (the scheduled path, as at execute), in its order; empty
    /// when it applies.
    function _setterErr(uint8 t, bytes memory data) internal view returns (bytes memory) {
        bytes4 s = _sel(data);
        bytes memory a = _args(data);
        bytes memory bad = abi.encodeWithSelector(InvalidParameter.selector);
        if (s == CascadeBase.setGuardian.selector) {
            address g = abi.decode(a, (address));
            return g == owner || g == address(uint160(_m[_f(t, F_PENDING_OWNER)])) ? bad : bytes("");
        }
        if (s == CascadeBase.transferOwnership.selector) {
            return abi.decode(a, (address)) == _guardianOf(t) ? bad : bytes("");
        }
        if (s == CascadeBase.activateBridge.selector) {
            uint256 j = _bridgeIndex(abi.decode(a, (address)));
            return _m[_f(t, F_ENABLED + j)] != 0 ? abi.encodeWithSelector(AlreadyActive.selector) : bytes("");
        }
        if (s == CascadeVault.setKeeper.selector) return "";
        if (t == V) return _vaultSetterErr(s, a, bad);
        if (s == CascadeFrontDoor.setOracle.selector || s == CascadeFrontDoor.setSwapper.selector) return "";
        if (s == CascadeFrontDoor.setMaxDeliverySlippage.selector) {
            return abi.decode(a, (uint16)) > fd.MAX_DELIVERY_SLIPPAGE_BPS()
                ? abi.encodeWithSelector(FeeTooHigh.selector)
                : bytes("");
        }
        if (s == CascadeFrontDoor.setBatchInterval.selector) {
            return abi.decode(a, (uint64)) > fd.MAX_BATCH_INTERVAL() ? bad : bytes("");
        }
        if (s == CascadeFrontDoor.setMaxBatchValue.selector) {
            uint256 v = abi.decode(a, (uint256));
            if (v > fd.MAX_BATCH_VALUE()) return bad;
            return v > _capOf(_bridgeIndex(address(uint160(_m[_f(D, F_PRIMARY)]))))
                ? abi.encodeWithSelector(AboveBridgeCap.selector)
                : bytes("");
        }
        if (s == CascadeFrontDoor.setMinPoolLiquidity.selector) {
            (uint8 idx,) = abi.decode(a, (uint8, uint128));
            return idx > 1 ? bad : bytes("");
        }
        if (s == CascadeFrontDoor.setCaps.selector) {
            (uint256 minDep,) = abi.decode(a, (uint256, uint256));
            return minDep < fd.MIN_DEPOSIT_FLOOR() || minDep > fd.MAX_BATCH_VALUE() ? bad : bytes("");
        }
        if (s == CascadeFrontDoor.setBatchLimits.selector) {
            (uint32 md, uint32 mr) = abi.decode(a, (uint32, uint32));
            return md == 0 || md > CascadeMessages.MAX_ENTRIES || mr == 0 || mr > CascadeMessages.MAX_ENTRIES
                ? bad
                : bytes("");
        }
        // setRedeemRequestFee
        return abi.decode(a, (uint256)) > fd.MAX_REDEEM_REQUEST_FEE() ? bad : bytes("");
    }

    /// The vault's setters' own checks (see _setterErr).
    function _vaultSetterErr(bytes4 s, bytes memory a, bytes memory bad) internal view returns (bytes memory) {
        if (s == CascadeVault.setMaxTotalAssets.selector || s == CascadeVault.writeOffMissingStake.selector) return "";
        if (s == CascadeVault.setMinDirectDeposit.selector) return "";
        if (s == CascadeVault.setOutflowLimits.selector) {
            (uint256 bps, uint256 floor, uint256 g) = abi.decode(a, (uint256, uint256, uint256));
            bool out = bps < MIN_OUTFLOW_BPS || bps > MAX_OUTFLOW_BPS || g < MIN_OUTFLOW_BPS || g > MAX_OUTFLOW_BPS
                || floor < MIN_MIN_DAILY_OUTFLOW || floor > MAX_MIN_DAILY_OUTFLOW;
            return out ? bad : bytes("");
        }
        if (s == CascadeVault.setMessageLimits.selector) {
            (uint256 e, uint256 mv, uint32 mc) = abi.decode(a, (uint256, uint256, uint32));
            if (e < MIN_ENTRY_VALUE || e > mv || mv > MAX_MESSAGE_VALUE || mc == 0 || mc > CascadeMessages.MAX_ENTRIES)
            {
                return bad;
            }
            return mv > _capOf(_bridgeIndex(address(uint160(_m[_f(V, F_PRIMARY)]))))
                ? abi.encodeWithSelector(AboveBridgeCap.selector)
                : bytes("");
        }
        if (s == CascadeVault.setFeeLimits.selector) {
            (uint256 bps, uint256 abs_) = abi.decode(a, (uint256, uint256));
            return bps > MAX_FEE_BPS || abs_ < MIN_FEE_ABS || abs_ > MAX_FEE_ABS ? bad : bytes("");
        }
        if (s == CascadeVault.setPayoutDelay.selector) {
            uint64 d = abi.decode(a, (uint64));
            return d < MIN_PAYOUT_DELAY || d > MAX_PAYOUT_DELAY ? bad : bytes("");
        }
        if (s == CascadeVault.setRewardCut.selector) {
            (address tr, uint16 bps) = abi.decode(a, (address, uint16));
            if (bps > vaultLens.MAX_REWARD_CUT_BPS()) return abi.encodeWithSelector(FeeTooHigh.selector);
            return tr == address(0) && bps != 0 ? abi.encodeWithSelector(ZeroAddress.selector) : bytes("");
        }
        if (s == CascadeVault.setRewardVesting.selector) {
            uint64 p = abi.decode(a, (uint64));
            return p < MIN_REWARD_VESTING || p > MAX_REWARD_VESTING ? bad : bytes("");
        }
        if (s == CascadeVault.setIdleBuffer.selector) {
            return abi.decode(a, (uint256)) > MAX_IDLE_BUFFER_BPS ? bad : bytes("");
        }
        if (s == CascadeVault.setStakeHotkey.selector) {
            bytes32 h = abi.decode(a, (bytes32));
            return h != HK1 && h != HK2 ? abi.encodeWithSelector(NotListed.selector) : bytes("");
        }
        if (s == CascadeVault.moveStake.selector) {
            (bytes32 from, bytes32 to,) = abi.decode(a, (bytes32, bytes32, uint256));
            if (from != HK1 && from != HK2) return abi.encodeWithSelector(UnknownHotkey.selector);
            if (from == bytes32(_m[V_STAKE_HK])) return abi.encodeWithSelector(HotkeyInUse.selector);
            return to != bytes32(_m[V_STAKE_HK]) ? bad : bytes("");
        }
        if (s == CascadeVault.activateFrontDoor.selector) {
            (uint64 chain, address addr) = abi.decode(a, (uint64, address));
            if (chain == 0 || chain == DIRECT_ORIGIN) return bad;
            if (addr == address(0)) return abi.encodeWithSelector(ZeroAddress.selector);
            return DoorState(_m[V_DOOR + _doorIndex(chain, addr)]) == DoorState.Active
                ? abi.encodeWithSelector(AlreadyActive.selector)
                : bytes("");
        }
        if (s == CascadeVault.setClaimGasRequired.selector) {
            uint256 g = abi.decode(a, (uint256));
            return g < vaultLens.MIN_CLAIM_GAS() || g > vaultLens.MAX_CLAIM_GAS() ? bad : bytes("");
        }
        if (s == CascadeVault.setHotkeyDustRao.selector) {
            return abi.decode(a, (uint256)) > MAX_HOTKEY_DUST_RAO ? bad : bytes("");
        }
        if (s == CascadeVault.setUnstakeMarginRao.selector) {
            return abi.decode(a, (uint256)) > MAX_UNSTAKE_MARGIN_RAO ? bad : bytes("");
        }
        // setUnstakeGas
        uint256 gas = abi.decode(a, (uint256));
        return gas < MIN_UNSTAKE_GAS || gas > MAX_UNSTAKE_GAS ? bad : bytes("");
    }

    /// The model after `data` ran on `t` (directly or as an item): the fields its setter writes, and the holds it clears
    /// (an activation of the primary, a launch-chain door's activation, setGuardian over a guardian's holds).
    function _apply(uint8 t, bytes memory data) internal {
        bytes4 s = _sel(data);
        bytes memory a = _args(data);
        if (s == CascadeBase.setGuardian.selector) {
            _m[_f(t, F_GUARDIAN)] = uint160(address(abi.decode(a, (address))));
            if (_m[_f(t, F_DISABLED_BY)] == uint256(Actor.Guardian)) _m[_f(t, F_DISABLED_BY)] = 0;
            if (t == V && _m[V_LAUNCH_BY] == uint256(Actor.Guardian)) _m[V_LAUNCH_BY] = 0;
        } else if (s == CascadeBase.transferOwnership.selector) {
            address o = abi.decode(a, (address));
            _m[_f(t, F_PENDING_OWNER)] = uint160(o);
            _m[_f(t, F_PENDING_SINCE)] = o == address(0) ? 0 : vm.getBlockTimestamp();
        } else if (s == CascadeBase.activateBridge.selector) {
            address b = abi.decode(a, (address));
            uint256 j = _bridgeIndex(b);
            _m[_f(t, F_ENABLED + j)] = 1;
            _m[_f(t, F_KNOWN + j)] = 1;
            if (_m[_f(t, F_PRIMARY)] == uint160(b)) _m[_f(t, F_DISABLED_BY)] = 0;
        } else if (s == CascadeVault.setKeeper.selector) {
            _m[t == V ? V_KEEPER : D_KEEPER] = uint160(address(abi.decode(a, (address))));
        } else if (t == V) {
            _applyVault(s, a);
        } else if (s == CascadeFrontDoor.setOracle.selector) {
            _m[D_ORACLE] = uint160(address(abi.decode(a, (address))));
        } else if (s == CascadeFrontDoor.setSwapper.selector) {
            _m[D_SWAPPER] = uint160(address(abi.decode(a, (address))));
        } else if (s == CascadeFrontDoor.setMaxDeliverySlippage.selector) {
            _m[D_SLIPPAGE] = abi.decode(a, (uint16));
        } else if (s == CascadeFrontDoor.setBatchInterval.selector) {
            _m[D_INTERVAL] = abi.decode(a, (uint64));
        } else if (s == CascadeFrontDoor.setMaxBatchValue.selector) {
            _m[D_MAX_BATCH] = abi.decode(a, (uint256));
        } else if (s == CascadeFrontDoor.setMinPoolLiquidity.selector) {
            (uint8 idx, uint128 v) = abi.decode(a, (uint8, uint128));
            _m[D_POOL + idx] = v;
        } else if (s == CascadeFrontDoor.setCaps.selector) {
            (_m[D_MIN_DEPOSIT], _m[D_CAP]) = abi.decode(a, (uint256, uint256));
        } else if (s == CascadeFrontDoor.setBatchLimits.selector) {
            (uint32 md, uint32 mr) = abi.decode(a, (uint32, uint32));
            (_m[D_MAX_DEPOSITS], _m[D_MAX_REDEEMS]) = (md, mr);
        } else {
            _m[D_REQUEST_FEE] = abi.decode(a, (uint256));
        }
    }

    /// The vault's setters' writes (see _apply).
    function _applyVault(bytes4 s, bytes memory a) internal {
        if (s == CascadeVault.setMaxTotalAssets.selector) {
            _m[V_MAX_TOTAL] = abi.decode(a, (uint256));
        } else if (s == CascadeVault.setOutflowLimits.selector) {
            (_m[V_BPS], _m[V_FLOOR], _m[V_GLOBAL]) = abi.decode(a, (uint256, uint256, uint256));
        } else if (s == CascadeVault.setMessageLimits.selector) {
            (uint256 e, uint256 mv, uint32 mc) = abi.decode(a, (uint256, uint256, uint32));
            (_m[V_ENTRY], _m[V_MSG], _m[V_MIN_CHUNK]) = (e, mv, mc);
        } else if (s == CascadeVault.setFeeLimits.selector) {
            (_m[V_FEE_BPS], _m[V_FEE_ABS]) = abi.decode(a, (uint256, uint256));
        } else if (s == CascadeVault.setPayoutDelay.selector) {
            _m[V_DELAY] = abi.decode(a, (uint64));
        } else if (s == CascadeVault.setRewardCut.selector) {
            (address tr, uint16 bps) = abi.decode(a, (address, uint16));
            (_m[V_TREASURY], _m[V_CUT]) = (uint160(tr), bps);
        } else if (s == CascadeVault.setRewardVesting.selector) {
            _m[V_VESTING] = abi.decode(a, (uint64));
        } else if (s == CascadeVault.setIdleBuffer.selector) {
            _m[V_IDLE] = abi.decode(a, (uint256));
        } else if (s == CascadeVault.setStakeHotkey.selector) {
            _m[V_STAKE_HK] = uint256(abi.decode(a, (bytes32)));
        } else if (s == CascadeVault.activateFrontDoor.selector) {
            (uint64 chain, address addr) = abi.decode(a, (uint64, address));
            _m[V_DOOR + _doorIndex(chain, addr)] = uint256(DoorState.Active);
            ++_m[V_ACTIVE + _chainIndex(chain)];
            if (chain == BASE_CHAIN) _m[V_LAUNCH_BY] = 0;
        } else if (s == CascadeVault.setMinDirectDeposit.selector) {
            _m[V_MIN_DIRECT] = abi.decode(a, (uint256));
        } else if (s == CascadeVault.setClaimGasRequired.selector) {
            _m[V_CLAIM_GAS] = abi.decode(a, (uint256));
        } else if (s == CascadeVault.setHotkeyDustRao.selector) {
            _m[V_DUST] = abi.decode(a, (uint256));
        } else if (s == CascadeVault.setUnstakeMarginRao.selector) {
            _m[V_MARGIN] = abi.decode(a, (uint256));
        } else if (s == CascadeVault.setUnstakeGas.selector) {
            _m[V_UNSTAKE_GAS] = abi.decode(a, (uint256));
        }
        // moveStake moves nothing (no stake) and writeOffMissingStake writes off nothing (nothing missing)
    }

    /// Whether running `data` on `t` reads the primary's cap (the vault's setMessageLimits, the front door's
    /// setMaxBatchValue) while the probe is that primary: ProbeBridge then re-enters the target.
    function _probeCalled(uint8 t, bytes memory data) internal view returns (bool) {
        bytes4 s = _sel(data);
        bool reads =
            t == V ? s == CascadeVault.setMessageLimits.selector : s == CascadeFrontDoor.setMaxBatchValue.selector;
        return reads && _m[_f(t, F_PRIMARY)] == uint160(bridges[2]);
    }

    // =====================================================================================================
    // the clocks
    // =====================================================================================================

    /// `actor`'s clock on `t` reads now (an instrument), and the items it kills are recorded.
    function _stamp(uint8 t, Actor actor) internal {
        bool ownerClock = actor == Actor.Owner;
        _m[_f(t, ownerClock ? F_OWNER_CLOCK : F_GUARDIAN_CLOCK)] = vm.getBlockTimestamp();
        _killed(t, ownerClock, ownerClock ? 1 : 2);
    }

    /// The pending items on `t` the clock just reached (the owner's kills every kind, the guardian's an Ordinary item
    /// only), recorded as killed by `cause` once.
    function _killed(uint8 t, bool ownerClock, uint8 cause) internal {
        uint256 clock = _m[_f(t, ownerClock ? F_OWNER_CLOCK : F_GUARDIAN_CLOCK)];
        for (uint256 i; i < _ghosts.length; ++i) {
            Ghost storage g = _ghosts[i];
            if (g.t != t || g.life != Life.Pending || g.killedBy != 0 || g.scheduledAt > clock) continue;
            if (!ownerClock && g.kind != Kind.Ordinary) continue;
            g.killedBy = cause;
            if (cause == 1) ++itemsKilledByOwner;
            else if (cause == 2) ++itemsKilledByGuardian;
            else ++itemsKilledByStamp;
        }
    }

    // =====================================================================================================
    // the comparisons the invariants read
    // =====================================================================================================

    /// The ghost log against both lenses: for every id either target ever scheduled, each lens's `scheduled(id)` is the
    /// pending ghost life of (that target, id), field for field, or all zero when there is none. Empty when they agree.
    function ghostMismatch() external view returns (string memory) {
        for (uint256 i; i < _ids.length; ++i) {
            bytes32 id = _ids[i];
            for (uint8 t; t < 2; ++t) {
                Item memory it = _lens(t).scheduled(id);
                uint256 ix = _live[t][id];
                if (ix == 0) {
                    if (it.readyAt != 0 || it.scheduledAt != 0) {
                        return _named("a view holds an item the ghost log ended", t, id);
                    }
                    continue;
                }
                Ghost storage g = _ghosts[ix - 1];
                if (
                    it.scheduledAt != g.scheduledAt || it.readyAt != g.readyAt || it.class != g.cls || it.kind != g.kind
                        || it.selector != _sel(g.data) || it.readyBlock != g.readyBlock
                ) return _named("a view is not the ghost log's pending item", t, id);
            }
        }
        return "";
    }

    /// The model against the contracts: the first field whose value differs, with both values; empty when none does.
    function modelMismatch() external view returns (string memory) {
        for (uint256 f; f < NF; ++f) {
            uint256 got = _read(f);
            if (got != _m[f]) {
                return string.concat(
                    "field ",
                    vm.toString(f),
                    ": the contract holds ",
                    vm.toString(got),
                    ", the model ",
                    vm.toString(_m[f])
                );
            }
        }
        return "";
    }

    /// The clocks alone (I-29): the first of both targets' four whose contract value is not the model's.
    function clockMismatch() external view returns (string memory) {
        for (uint8 t; t < 2; ++t) {
            for (uint256 k = F_OWNER_CLOCK; k <= F_GUARDIAN_CLOCK; ++k) {
                uint256 f = _f(t, k);
                if (_read(f) != _m[f]) return string.concat("clock field ", vm.toString(f));
            }
        }
        return "";
    }

    function _named(string memory what, uint8 t, bytes32 id) internal pure returns (string memory) {
        return string.concat(what, t == V ? " (vault): " : " (front door): ", vm.toString(id));
    }

    /// Field `f`, read from the contracts (the lenses for CascadeBase's state and the vault's; the front door's own
    /// getters for its own).
    function _read(uint256 f) internal view returns (uint256) {
        if (f < 2 * NB) {
            uint8 t = uint8(f / NB);
            uint256 k = f % NB;
            CascadeBaseLens l = _lens(t);
            CascadeBase c = _target(t);
            if (k == F_GUARDIAN) return uint160(l.guardian());
            if (k == F_OWNER) return uint160(c.owner());
            if (k == F_PENDING_OWNER) return uint160(c.pendingOwner());
            if (k == F_PENDING_SINCE) return l.pendingSince();
            if (k == F_PRIMARY) return uint160(l.primaryBridge());
            if (k == F_DISABLED_BY) return uint256(l.primaryDisabledBy());
            if (k == F_OWNER_CLOCK) return l.lastOwnerClose();
            if (k == F_GUARDIAN_CLOCK) return l.lastGuardianClose();
            if (k == F_PAUSED) return c.paused() ? 1 : 0;
            if (k < F_KNOWN) return l.bridgeEnabled(bridges[k - F_ENABLED]) ? 1 : 0;
            return l.bridgeKnown(bridges[k - F_KNOWN]) ? 1 : 0;
        }
        if (f < D_ORACLE) return _readVault(f);
        if (f == D_ORACLE) return uint160(address(fd.oracle()));
        if (f == D_SWAPPER) return uint160(fd.swapper());
        if (f == D_SLIPPAGE) return fd.maxDeliverySlippageBps();
        if (f == D_INTERVAL) return fd.batchInterval();
        if (f == D_MAX_BATCH) return fd.maxBatchValue();
        if (f == D_POOL) return fd.minPoolLiquidity(0);
        if (f == D_POOL + 1) return fd.minPoolLiquidity(1);
        if (f == D_MIN_DEPOSIT) return fd.minDeposit();
        if (f == D_CAP) return fd.depositCap();
        if (f == D_MAX_DEPOSITS) return fd.maxDeposits();
        if (f == D_MAX_REDEEMS) return fd.maxRedeems();
        if (f == D_REQUEST_FEE) return fd.redeemRequestFee();
        return uint160(fd.keeper());
    }

    function _readVault(uint256 f) internal view returns (uint256) {
        if (f == V_MAX_TOTAL) return vaultLens.maxTotalAssets();
        if (f == V_BPS) return vaultLens.maxDailyOutflowBps();
        if (f == V_FLOOR) return vaultLens.minDailyOutflow();
        if (f == V_GLOBAL) return vaultLens.globalOutflowBps();
        if (f == V_ENTRY) return vaultLens.maxEntryValue();
        if (f == V_MSG) return vaultLens.maxMessageValue();
        if (f == V_MIN_CHUNK) return vaultLens.minChunk();
        if (f == V_FEE_BPS) return vaultLens.maxFeeBps();
        if (f == V_FEE_ABS) return vaultLens.maxFeeAbs();
        if (f == V_DELAY) return vaultLens.payoutDelay();
        if (f == V_TREASURY) return uint160(vaultLens.treasury());
        if (f == V_CUT) return vaultLens.rewardCutBps();
        if (f == V_VESTING) return vaultLens.rewardVesting();
        if (f == V_IDLE) return vaultLens.idleBufferBps();
        if (f == V_STAKE_HK) return uint256(vaultLens.stakeHotkey());
        if (f == V_KEEPER) return uint160(vaultLens.keeper());
        if (f == V_MIN_DIRECT) return vaultLens.minDirectDeposit();
        if (f == V_CLAIM_GAS) return vaultLens.claimGasRequired();
        if (f == V_DUST) return vaultLens.hotkeyDustRao();
        if (f == V_MARGIN) return vaultLens.unstakeMarginRao();
        if (f == V_UNSTAKE_GAS) return vaultLens.unstakeGas();
        if (f == V_BOOKED) return vaultLens.bookedStake();
        if (f == V_PAUSED_BY) return uint256(vaultLens.pausedBy());
        if (f == V_LAUNCH_BY) return uint256(vaultLens.launchDoorRemovedBy());
        if (f == V_ACTIVE) return vaultLens.activeDoors(BASE_CHAIN);
        if (f == V_ACTIVE + 1) return vaultLens.activeDoors(SECOND_CHAIN);
        uint256 i = f - V_DOOR;
        return uint256(vaultLens.doorState(vaultLens.peerId(doorChains[i], doorAddrs[i])));
    }

    // =====================================================================================================
    // views for the invariants and the pins
    // =====================================================================================================

    /// The model's value of field `f` (the pins read it).
    function modelOf(uint256 f) external view returns (uint256) {
        return _m[f];
    }

    function ghostCount() external view returns (uint256) {
        return _ghosts.length;
    }

    /// Ghost life `i`: its target, its life, its kind, how it was killed, when it was scheduled and its calldata.
    function ghost(uint256 i)
        external
        view
        returns (uint8 t, Life life, Kind kind, uint8 killedBy, uint64 scheduledAt, bytes memory data)
    {
        Ghost storage g = _ghosts[i];
        return (g.t, g.life, g.kind, g.killedBy, g.scheduledAt, g.data);
    }

    function queuedCount() external view returns (uint256) {
        return _queued.length;
    }

    /// The vault's guardian now, as the model holds it.
    function guardianOfVault() public view returns (address) {
        return _guardianOf(V);
    }

    // =====================================================================================================
    // small helpers
    // =====================================================================================================

    function _f(uint8 t, uint256 k) internal pure returns (uint256) {
        return uint256(t) * NB + k;
    }

    function _target(uint8 t) internal view returns (CascadeBase) {
        return t == V ? CascadeBase(payable(address(vault))) : CascadeBase(payable(address(fd)));
    }

    function _lens(uint8 t) internal view returns (CascadeBaseLens) {
        return t == V ? CascadeBaseLens(address(vaultLens)) : CascadeBaseLens(address(doorLens));
    }

    function _guardianOf(uint8 t) internal view returns (address) {
        return address(uint160(_m[_f(t, F_GUARDIAN)]));
    }

    /// The guardian candidate `t` does not name now.
    function _staleGuardian(uint8 t) internal view returns (address) {
        return _guardianOf(t) == guardians[0] ? guardians[1] : guardians[0];
    }

    /// The instrument actor `caller` is on `t` (CascadeBase._actor): the owner, the guardian, or none.
    function _actorOf(uint8 t, address caller) internal view returns (Actor) {
        if (caller == owner) return Actor.Owner;
        if (caller == _guardianOf(t)) return Actor.Guardian;
        return Actor.None;
    }

    function _ownerHold(uint8 t) internal view returns (bool) {
        uint256 o = uint256(Actor.Owner);
        if (_m[_f(t, F_DISABLED_BY)] == o) return true;
        return t == V && (_m[V_PAUSED_BY] == o || _m[V_LAUNCH_BY] == o);
    }

    function _guardianHold(uint8 t) internal view returns (bool) {
        uint256 g = uint256(Actor.Guardian);
        if (_m[_f(t, F_DISABLED_BY)] == g) return true;
        return t == V && (_m[V_PAUSED_BY] == g || _m[V_LAUNCH_BY] == g);
    }

    function _exitsOpen(uint8 t) internal view returns (bool) {
        return !_ownerHold(t) && !_guardianHold(t);
    }

    function _bridgeIndex(address b) internal view returns (uint256) {
        for (uint256 j; j < 3; ++j) {
            if (bridges[j] == b) return j;
        }
        revert("not a campaign bridge");
    }

    function _doorIndex(uint64 chain, address addr) internal view returns (uint256) {
        for (uint256 i; i < 3; ++i) {
            if (doorChains[i] == chain && doorAddrs[i] == addr) return i;
        }
        revert("not a campaign door");
    }

    function _chainIndex(uint64 chain) internal pure returns (uint256) {
        return chain == BASE_CHAIN ? 0 : 1;
    }

    /// Bridge `j`'s cap (its maxMessageValue, fixed for its lifetime; the probe's re-entry runs only for the targets).
    function _capOf(uint256 j) internal view returns (uint256) {
        return ICascadeBridge(bridges[j]).maxMessageValue();
    }

    function _delayOf(Delay cls) internal pure returns (uint64) {
        if (cls == Delay.Param) return 48 hours;
        if (cls == Delay.Registry) return 7 days;
        return 8 days;
    }

    /// The second treasury a reward-cut change may name.
    function _treasury2() internal pure returns (address) {
        return address(uint160(uint256(keccak256("governance campaign: a second treasury"))));
    }

    /// A ghost life's calldata, or a fresh one (fromLog false): `how` one in sixteen draws a never-scheduled table item;
    /// else a pending life still alive (inside its window, not killed), three draws in four when there is one; else any
    /// pending life (a dead or lapsed one), then any recorded life; with none of those, a fresh item.
    function _pickData(uint256 seed, uint256 how) internal view returns (uint8 t, bytes memory data, bool fromLog) {
        uint256 n = _ghosts.length;
        if (n != 0 && _r(how, "fresh") % 16 != 0) {
            uint256 start = _r(seed, "pick") % n;
            if (_r(seed, "alive") % 4 != 0) {
                for (uint256 k; k < n; ++k) {
                    Ghost storage g = _ghosts[(start + k) % n];
                    if (g.life == Life.Pending && _alive(g)) return (g.t, g.data, true);
                }
            }
            for (uint256 k; k < n; ++k) {
                Ghost storage g = _ghosts[(start + k) % n];
                if (g.life == Life.Pending) return (g.t, g.data, true);
            }
            if (_r(seed, "ended") % 4 == 0) return (_ghosts[start].t, _ghosts[start].data, true);
        }
        (t, data) = _generate(_scheduledEntry(seed, 0), seed);
    }

    /// Whether pending life `g` can still execute: not lapsed and not killed by its clock.
    function _alive(Ghost storage g) internal view returns (bool) {
        return !_dead(g.t, g) && !_lapsed(g.t, g.readyAt, g.readyBlock);
    }

    /// Whether an item on `t` ready at `readyAt` and `readyBlock` has lapsed (Revision 28): its window in time (readyAt
    /// + WINDOW) and its window in blocks (readyBlock plus half WINDOW in `t`'s calibrated blocks) have both passed.
    function _lapsed(uint8 t, uint256 readyAt, uint256 readyBlock) internal view returns (bool) {
        return vm.getBlockTimestamp() > readyAt + WINDOW && vm.getBlockNumber() > readyBlock + _halfInBlocks(t, WINDOW);
    }

    /// Half of `secs` in `t`'s calibrated blocks (its MS_PER_BLOCK), rounded up: the contracts' arithmetic for an item's
    /// readyBlock (half its delay) and its window in blocks (half WINDOW).
    function _halfInBlocks(uint8 t, uint256 secs) internal view returns (uint256) {
        uint256 ms = t == V ? vaultBlockTime : doorBlockTime;
        return (secs * 1000 + 2 * ms - 1) / (2 * ms);
    }

    /// OpenZeppelin's owner refusal of `caller`.
    function _notOwner(address caller) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller);
    }

    /// Judges an outcome against its prediction (`expect` empty: a success), full revert data compared: whether it is
    /// the predicted one. Any other counts in unexpectedReverts.
    function _judge(bool ok, bytes memory reason, bytes memory expect) internal returns (bool predicted) {
        predicted = ok ? expect.length == 0 : expect.length != 0 && keccak256(reason) == keccak256(expect);
        if (!predicted) ++unexpectedReverts;
    }

    /// The logs `emitter` emitted with event `sig` and first topic `topic`.
    function _count(Vm.Log[] memory logs, address emitter, bytes32 sig, bytes32 topic)
        internal
        pure
        returns (uint256 n)
    {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter == emitter && l.topics.length > 1 && l.topics[0] == sig && l.topics[1] == topic) ++n;
        }
    }

    /// As _count, with the second topic `by` when it is not zero.
    function _countBy(Vm.Log[] memory logs, address emitter, bytes32 sig, bytes32 topic, address by)
        internal
        pure
        returns (uint256 n)
    {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != emitter || l.topics.length < 2 || l.topics[0] != sig || l.topics[1] != topic) continue;
            if (by != address(0) && (l.topics.length < 3 || l.topics[2] != bytes32(uint256(uint160(by))))) continue;
            ++n;
        }
    }

    function _sel(bytes memory data) internal pure returns (bytes4) {
        // truncating to the selector is the point of the cast
        // forge-lint: disable-next-line(unsafe-typecast)
        return bytes4(data);
    }

    /// `data` without its selector (empty when shorter than one).
    function _args(bytes memory data) internal pure returns (bytes memory a) {
        if (data.length <= 4) return a;
        a = new bytes(data.length - 4);
        for (uint256 i; i < a.length; ++i) {
            a[i] = data[i + 4];
        }
    }

    function _split(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly ("memory-safe") {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
    }

    /// `sig` less its last byte (64 bytes).
    function _shorten(bytes memory sig) internal pure returns (bytes memory out) {
        out = new bytes(sig.length - 1);
        for (uint256 i; i < out.length; ++i) {
            out[i] = sig[i];
        }
    }

    /// A draw from `seed` under `salt`, by a hash (the fuzzer's dictionary favours small seeds, whose low bits a modulo
    /// would read).
    function _r(uint256 seed, bytes32 salt) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, salt)));
    }

    function _rn(uint256 seed, uint256 salt) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, salt)));
    }
}
