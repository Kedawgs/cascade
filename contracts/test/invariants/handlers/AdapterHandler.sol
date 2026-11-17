// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CascadeFrontDoor} from "../../../src/CascadeFrontDoor.sol";
import {CcipAdapterBase} from "../../../src/adapters/CcipAdapterBase.sol";
import {CcipBaseAdapter} from "../../../src/adapters/CcipBaseAdapter.sol";
import {CcipBittensorAdapter} from "../../../src/adapters/CcipBittensorAdapter.sol";
import {CascadeMessages} from "../../../src/libraries/CascadeMessages.sol";
import {Client} from "../../../src/vendor/ccip/Client.sol";
import {
    NotBridge,
    NothingToStake,
    StakeMissing,
    UnknownPeer,
    UnstakeShort,
    VaultInsolvent
} from "../../../src/CascadeErrors.sol";
import {BatchDelivered, DepositBounced, Deposited, PayoutBatchQueued, Redeemed} from "../../../src/CascadeEvents.sol";
import {DoorState, PayoutBatch} from "../../../src/CascadeTypes.sol";
import {MockAlphaVault} from "../../mocks/MockAlphaVault.sol";
import {MockRouter} from "../../mocks/MockRouter.sol";
import {MockStaking} from "../../mocks/MockStaking.sol";
import {MockTAO} from "../../mocks/MockTAO.sol";
import {ReentrantRecipient} from "../../mocks/ReentrantRecipient.sol";
import {relayMessage} from "../../adapters/AdaptersFixture.sol";
import {FrontDoorTracker} from "./FrontDoorTracker.sol";
import {VaultModel} from "./VaultModel.sol";

/// @notice The adapter campaign's handler (Task 38, spec §3.2; I-7 to I-11): the two CCIP adapters over two mock
/// routers (AdaptersFixture's world, the vault and the front door their test-only subclasses), every message relayed by
/// the handler as the lanes would carry it. Base to Bittensor: the front door's batches (deposits and redeem requests
/// by three holders, closed by the keeper, redeem-only ones included) and a stranger's, the re-entrant recipient actor
/// (Task 26's ReentrantRecipient), sending its own batches through the Base adapter to itself, or to the vault (an
/// unknown peer there), sometimes the same message twice. Bittensor to Base: the vault's payout chunks and the parks'
/// refunds. Around them every state the spec names: the vault paused, its stake swapped away (missing), ForeverMoney
/// paying short or in the adapter's favour, halted, migrating (notice, cancel, the position gone, finished), the
/// staking floor raised, the native reserve and the token cushion drained or funded, and time, past PARK_TIMEOUT; and
/// every park function, called by anyone: deliverParked, refundParked (with the quoted fee, more, or less), dropParked,
/// and both adapters' sweepSurplus.
///
/// The ghost map is the handler's own (the controller's ruling). Each message is recorded when its send is (the door's
/// batch from the handler's own record of the open batch's entries, never the door's views, and its key and the vault's
/// batch key by their formulas), and its state, one of in flight, failed (CCIP FAILURE, re-executable), delivered,
/// parked as tokens, parked as native TAO (converted), refunded, dropped, moves only on the handler's own calls and the
/// events they log: BatchParked, the vault's BatchDelivered, the recipient's acceptance, ParkedDelivered,
/// ParkedConverted, ParkedRefunded, ParkedDropped. Each park's record (amount, parkedAt, converted) is the ghost's, and
/// the totals the ghost's sums. After every step (`checked`), and between the calls of a composite step, the ghost is
/// compared with the adapter's views and the vault's: the record under every key the handler has seen (a key with no
/// live ghost park, a delivered batch's among them, must hold none), both totals, the balances (I-7), each batch's
/// state against its record, each door batch's `processed` flag (minted exactly when delivered: I-8), and the Base
/// adapter holding no tokens.
///
/// I-7 (`invariant_neverBelowWhatIsOwed`): each balance at least the total it owes, each total the sum of its records,
/// both from the ghost's records, and the sum of the adapter's own records over every key seen. I-8
/// (`invariant_mintXorRefund`): every batch in exactly one state, its transitions only the spec's (a delivered,
/// refunded or dropped batch never moves again and keeps no record; a delivery that left no state, a deposit of a
/// delivered batch neither minted nor bounced, or twice, a batch both minted and refunded, each counted). I-9
/// (`invariant_refundCreditsEachDepositor`): a refund's message is PAYOUTS(key, REFUND_CHUNK, the parked batch's
/// deposits) from the vault to the door, carrying the batch's amount, and on Base it credits each depositor exactly its
/// deposit, netForwarded falling by it. I-10 (`invariant_refundLiveness`, by snapshot in `warp` and `probeLiveness`):
/// for every park past PARK_TIMEOUT, inside a snapshot, a stranger's refundParked with the quoted fee succeeds, or, for
/// a converted park only, refuses with the rail's error its state names (ForeverMoney halted, migrating, the floor
/// above the park, a conversion short past the cushion); an empty one's dropParked succeeds; and a converted park to
/// the vault is delivered by deliverParked whenever the vault accepts. I-11 (`invariant_noReentrantDrain`): around
/// every call that reaches the re-entrant recipient (its batch's delivery, its park's deliverParked), no record or
/// total but its own batch's moves, no park event names another key, nothing is swept, the recipient receives exactly
/// its own batch or nothing, and every re-entry into the lock is refused with ReentrancyGuardReentrantCall, one through
/// the router (another pending batch executed from inside the delivery) as a FAILURE of that batch that writes nothing.
///
/// The ruling's "ForeverMoney's lock" state is not created here: its lock is held only inside a stranger's own
/// transaction, around withdrawLiquid's payment, so no campaign step runs under it and no refusal under it is recorded
/// (test_aStrangerUnderForeverMoneysLockCannotParkAnHonestBatch pins the adapter's side).
///
/// Expected refusals, each tied to its state (any other, or a predicted one that does not happen, is unexpected):
/// - a delivery to Bittensor parks tokens with BelowConversionFloor (the floor above the batch), IsHalted, Insolvent
///   (the position migrated away), Slippage (ForeverMoney more than 1 rao short), ConversionShort (1 rao short with the
///   native reserve below it); parks native with EnforcedPause (the vault paused), UnknownPeer (a stranger's batch to
///   the vault), StakeMissing (the stake swapped away), VaultInsolvent (a supply of 0 underwater; never reached),
///   Refused (the recipient actor refusing); fails (FAILURE) with AlreadyParked (a duplicate of a parked batch) or
///   ReentrancyGuardReentrantCall (the recipient actor bubbling the adapter's lock refusal);
/// - deliverParked: NotParked (no record: one draw in eight any batch's key, delivered, refunded, dropped, in flight
///   or failed), the conversion's refusals above for a token park (the call reverts, the record stays),
///   ReentrancyGuardReentrantCall (bubbled by the recipient actor); a recipient's refusal re-parks it converted;
/// - refundParked: NotParked, NothingToRefund (an empty park), ParkedTooYoung, InsufficientFee (less than the quote);
///   for a converted park IsHalted, MigrationInProgress, BelowMinStake (the precompile's, the floor above the park),
///   Slippage, ConversionShort (the cushion below the rao); dropParked: NotParked (none, or one with an amount),
///   ParkedTooYoung;
/// - processPayouts: EnforcedPause; BelowConversionFloor (the chunk or its net below the floor); VaultModel's
///   _chunkOutcome (UnstakeShort, FeeTooHigh); the send's IsHalted, MigrationInProgress, Slippage, ConversionShort;
/// - stakeIdle: EnforcedPause, NothingToStake; fmPause: ForeverMoney's PauseCooldown (its guardian inside the
///   cooldown);
/// - a payout or a refund to Base: Refused (the recipient actor refusing there: FAILURE, re-executable).
/// Task 34's carried errors: ForeverMoney's Slippage, IsHalted and MigrationInProgress are reached here (each above);
/// AboveBridgeCap, NoOracle and BelowOracleFloor are not (no limit setter runs, nothing stakes USDC).
contract AdapterHandler is VaultModel, FrontDoorTracker {
    using stdStorage for StdStorage;

    /// What the campaign's fixture adds: both chains' tokens, routers and adapters, ForeverMoney's alpha vault, the
    /// re-entrant recipient actor (created by the test, so the handler lands at the keeper's planned address), the
    /// adapters' treasury, and the chains' ids and CCIP selectors.
    struct Parts {
        MockTAO taoBase;
        MockTAO taoBit;
        MockRouter routerBase;
        MockRouter routerBit;
        CcipBaseAdapter adapterBase;
        CcipBittensorAdapter adapterBit;
        MockAlphaVault av;
        ReentrantRecipient recipient;
        address adapterTreasury;
        uint64 baseChain;
        uint64 bitChain;
        uint64 baseSelector;
        uint64 bitSelector;
    }

    /// A message's kind: a front door's batch, the stranger's (the recipient actor's), a payout chunk, a refund.
    enum Kind {
        DoorBatch,
        StrangerBatch,
        Payout,
        Refund
    }

    /// A message's state in the ghost map. A batch: InFlight, Failed, then Delivered, ParkedTokens or ParkedNative,
    /// a park then Delivered, ParkedNative (converted by a refused deliverParked), Refunded or Dropped. A payout or a
    /// refund to Base: InFlight, Failed, Delivered.
    enum State {
        InFlight,
        Failed,
        Delivered,
        ParkedTokens,
        ParkedNative,
        Refunded,
        Dropped
    }

    /// A message the handler recorded at its send: its kind and state, its send on its router, the payload's
    /// recipient and sender, the tokens it carries, the park key (a batch's, by the adapter's formula), the vault's
    /// batch key (a door batch's) or the PAYOUTS' key (a payout's or a refund's), and a refund's batch message.
    struct Msg {
        Kind kind;
        State state;
        uint256 sendIndex;
        address recipient;
        address sender;
        uint256 amount;
        bytes32 parkKey;
        bytes32 batchKey;
        uint256 origin;
    }

    /// A park as the ghost records it.
    struct Park {
        uint128 amount;
        uint64 parkedAt;
        bool converted;
        bool live;
        uint256 msgIndex;
    }

    /// What a delivery is predicted to do: deliver, park tokens or native with `reason`, or fail (CCIP FAILURE) with
    /// the adapter's `reason`.
    enum Outcome {
        Deliver,
        ParkTokens,
        ParkNative,
        Fail
    }

    /// The recipient actor's re-entry, as drawn for the call that reaches it: a park function on its own batch's key
    /// or on another park's, the sweep, or another pending batch executed through the router.
    enum Reentry {
        OwnKey,
        OtherKey,
        Sweep,
        Router
    }

    uint256 internal constant ACTORS = 3;
    uint256 internal constant MAX_DEPOSIT = 50e18;
    uint32 internal constant CHUNK_ENTRIES = 10;
    /// The hotkey the stake is swapped to (unlisted), and back from.
    bytes32 public constant AWAY = keccak256("adapter campaign: the swap's new hotkey");
    /// Anyone: the stranger that calls the permissionless park functions and the sweeps.
    address public immutable anyone;

    MockTAO public immutable taoBase;
    MockTAO public immutable taoBit;
    MockRouter public immutable routerBase;
    MockRouter public immutable routerBit;
    CcipBaseAdapter public immutable adapterBase;
    CcipBittensorAdapter public immutable adapterBit;
    MockAlphaVault public immutable av;
    ReentrantRecipient public immutable recipient;
    address public immutable adapterTreasury;
    uint64 public immutable baseChain;
    uint64 public immutable bitChain;
    uint64 public immutable baseSelector;
    uint64 public immutable bitSelector;

    address[ACTORS] public actors;

    // ---- the ghost map ----

    Msg[] internal _msgs;
    mapping(uint256 => bytes) internal _body;
    /// A batch's deposit entries, from the handler's own record of the open batch (a door's) or of its send (the
    /// stranger's).
    mapping(uint256 => CascadeMessages.Entry[]) internal _depositsOf;
    uint256[] internal _toBittensor;
    uint256[] internal _toBase;
    mapping(bytes32 => Park) internal _parks;
    bytes32[] internal _parkKeys;
    mapping(bytes32 => bool) internal _isParkKey;
    /// Every park key the handler has seen, one per batch toward Bittensor (a duplicate shares its original's): I-7's
    /// and I-8's record checks run over all of them, a key with no live ghost park holding no record.
    bytes32[] internal _batchKeys;
    mapping(bytes32 => bool) internal _isBatchKey;
    /// The recipient actor's re-entry for the call now reaching it, and (through the router) the batch it executes.
    Reentry internal _reentry;
    uint256 internal _reentryInner;
    /// I-7: the ghost's totals, kept with every park's change and checked against the sums of its records.
    uint256 public ghostParkedNative;
    uint256 public ghostParkedTokens;

    /// The door's open batch, as the handler's own record: its entries in the door's order (a user's later deposit or
    /// request adds to its entry).
    CascadeMessages.Entry[] internal _openDeposits;
    CascadeMessages.Entry[] internal _openRedeems;
    mapping(address => uint256) internal _openDepositSlot;
    mapping(address => uint256) internal _openRedeemSlot;

    /// The vault's queued payout lists, from the Redeemed and DepositBounced events, in order.
    mapping(bytes32 => CascadeMessages.Payout[]) internal _lists;
    bytes32[] public queuedKeys;

    /// The stranger's batch ids, and its last message (to send it again).
    uint64 internal _strangerId;
    uint256 internal _lastStranger = type(uint256).max;
    bool public swapped;

    // ---- the invariants' counters (each asserted 0) ----

    /// I-7: a balance below the ghost's total of its kind (or the adapter's own), a total not the sum of the ghost's
    /// records (or the ghost's running total, or the sum of the adapter's records over every key seen), a record not
    /// the ghost's (under any key seen: one with no live ghost park holds none).
    uint256 public owedShortfalls;
    uint256 public totalMismatches;
    uint256 public recordMismatches;
    /// I-8: a delivery or park call that left no state or two; a deposit of a delivered batch not minted or bounced
    /// exactly once (or one not in the batch); a door batch's processed flag not its ghost's Delivered; a batch's state
    /// not its record's (a parked one without its record, or one whose key holds no live ghost park with a record at
    /// the adapter: delivered and still parked); a batch both minted and refunded.
    uint256 public lostOutcomes;
    uint256 public depositOutcomeMisses;
    uint256 public processedMismatches;
    uint256 public stateMismatches;
    uint256 public mintedAndRefunded;
    /// I-9: a refund's message not PAYOUTS of the parked batch's deposits from its recipient to its sender, or not its
    /// amount; a refund on Base that did not credit each depositor exactly, or did not lower netForwarded by it.
    uint256 public refundMessageMismatches;
    uint256 public refundMiscredits;
    /// I-10: a refund, a drop or a converted park's delivery refused outside the states that allow it.
    uint256 public refundLivenessFailures;
    uint256 public dropLivenessFailures;
    uint256 public deliveryLivenessFailures;
    bytes4 public lastLivenessRefusal;
    /// I-11: a call reaching the recipient actor that moved another key's record or a total beyond its own batch,
    /// logged a park event of another key or a sweep, or paid it other than its own batch; a re-entry that got through.
    uint256 public reentrantDrains;
    uint256 public reentriesThrough;
    /// Beside them: the door's batch message not the handler's own record; the Base adapter holding tokens; a sweep
    /// other than the ghost's surplus.
    uint256 public batchContentMismatches;
    uint256 public baseAdapterHeld;
    uint256 public sweepMismatches;
    /// The last unexpected outcome's tag, for a failing run's reading.
    bytes32 public lastUnexpected;

    // ---- hit counters ----

    uint256 public deposits;
    uint256 public redeemRequests;
    uint256 public closes;
    uint256 public redeemOnlyCloses;
    uint256 public rolls;
    uint256 public strangerSends;
    uint256 public strangerDuplicates;
    uint256 public strangerToVault;
    uint256 public relaysToBittensor;
    uint256 public deliveredToVault;
    uint256 public deliveredToRecipient;
    uint256 public mintsChecked;
    uint256 public failuresAlreadyParked;
    uint256 public failuresLocked;
    uint256 public reExecutions;
    /// Parks by reason (BatchParked's), and the empty (redeem-only) ones.
    uint256 public parkedPaused;
    uint256 public parkedStakeMissing;
    uint256 public parkedUnknownPeer;
    uint256 public parkedRefused;
    uint256 public parkedBelowFloor;
    uint256 public parkedHalted;
    uint256 public parkedInsolvent;
    uint256 public parkedSlippage;
    uint256 public parkedConversionShort;
    uint256 public parkedEmpty;
    uint256 public parksDelivered;
    uint256 public parksDeliveredFromTokens;
    uint256 public parksConverted;
    uint256 public deliverParkedRefused;
    uint256 public deliverParkedLocked;
    uint256 public refundsConverted;
    uint256 public refundsUnconverted;
    uint256 public refundsWithExcess;
    uint256 public refundsRefusedYoung;
    uint256 public refundsRefusedRail;
    uint256 public refundsRefusedFee;
    uint256 public refundsRefusedEmpty;
    uint256 public refundsCredited;
    uint256 public refundsToRecipient;
    uint256 public drops;
    uint256 public dropsRefused;
    uint256 public notParkedRefusals;
    uint256 public relaysToBase;
    uint256 public failuresOnBase;
    uint256 public payoutChunks;
    uint256 public payoutsRefusedRail;
    uint256 public payoutsRefusedVault;
    uint256 public claims;
    uint256 public stakes;
    uint256 public sweepsBittensor;
    uint256 public sweepsBase;
    uint256 public sweepsNonZero;
    uint256 public vaultPauses;
    uint256 public vaultUnpauses;
    uint256 public swapsAway;
    uint256 public swapsBack;
    uint256 public fmShortSwitches;
    uint256 public fmHalts;
    uint256 public fmHaltsRefused;
    uint256 public fmUnpauses;
    uint256 public fmMigrationsStarted;
    uint256 public fmMigrationsCancelled;
    uint256 public fmMigrationsExecuted;
    uint256 public fmMigrationsFinished;
    uint256 public floorRaises;
    uint256 public reserveDrains;
    uint256 public cushionDrains;
    uint256 public reserveFunds;
    uint256 public cushionFunds;
    uint256 public warpsPastTimeout;
    /// I-11's reach: calls that reached the recipient actor, re-entries made and refused (seen), by their target: a
    /// park function on its own key, on another park's key, the sweep, another pending batch through the router.
    uint256 public recipientCalls;
    uint256 public reentriesRefused;
    uint256 public reentriesOwnKey;
    uint256 public reentriesOtherKey;
    uint256 public reentriesSweep;
    uint256 public reentriesRouter;
    /// reenterThroughTheRouter's draws that relayed the actor's batch.
    uint256 public routerReentryDraws;
    /// Test-only (no action sets it): _forgedToBase leaves the recipient actor's mode as an earlier relay set it, so a
    /// pin can show MockRouter's exactly-once mode guards the forged copy alone (the fix round 3's M-2).
    bool public keepActorModeOnBase;
    /// I-10's reach: aged parks probed, refunds that went, refusals the rail's state allows (by error), drops,
    /// deliveries of converted parks.
    uint256 public refundsProbed;
    uint256 public refundsLive;
    uint256 public probeRefusedHalted;
    uint256 public probeRefusedMigrating;
    uint256 public probeRefusedFloor;
    uint256 public probeRefusedSlippage;
    uint256 public probeRefusedCushion;
    uint256 public dropsProbed;
    uint256 public deliveriesProbed;

    constructor(System memory s, Parts memory p) VaultModel(s) {
        anyone = makeAddr("adapter campaign: anyone");
        taoBase = p.taoBase;
        taoBit = p.taoBit;
        routerBase = p.routerBase;
        routerBit = p.routerBit;
        adapterBase = p.adapterBase;
        adapterBit = p.adapterBit;
        av = p.av;
        recipient = p.recipient;
        adapterTreasury = p.adapterTreasury;
        baseChain = p.baseChain;
        bitChain = p.bitChain;
        baseSelector = p.baseSelector;
        bitSelector = p.bitSelector;
        actors = [
            makeAddr("adapter campaign: alice"), makeAddr("adapter campaign: bob"), makeAddr("adapter campaign: carol")
        ];
        for (uint256 i; i < ACTORS; ++i) {
            p.taoBase.mint(actors[i], 10_000e18);
            vm.prank(actors[i]);
            p.taoBase.approve(address(s.fd), type(uint256).max);
            vm.deal(actors[i], 100 ether);
            _trackAccount(actors[i]);
        }
        // the recipient actor sends through the Base adapter as itself (its forward)
        p.taoBase.mint(address(p.recipient), 10_000e18);
        p.recipient
            .forward(address(p.taoBase), abi.encodeCall(IERC20.approve, (address(p.adapterBase), type(uint256).max)));
        vm.deal(address(p.recipient), 100 ether);
        vm.deal(anyone, 100 ether);
        _trackAccount(address(p.recipient));
        _trackAccount(anyone);
        _trackAccount(address(p.adapterBase));
        _trackAccount(p.adapterTreasury);
        _trackAccount(s.fd.treasury());
        _trackWord(s.vaultLens.stakeHotkey(), WordKind.Hotkey);
        _trackWord(AWAY, WordKind.Hotkey);
        _trackPeer(p.baseChain, address(s.fd));
        _trackPeer(p.baseChain, address(p.recipient));
        _trackDoor(s.fd);
    }

    /// @dev Takes the unused part of each close's budget back.
    receive() external payable {}

    /// @dev After every action: the ghost against the adapters' and the vault's views (I-7, I-8). A composite step also
    /// checks between its calls, after each one that reaches an adapter (a close's send, a relay, a payout's or a
    /// refund's send); the door's own deposits, requests and claims and the vault's stake touch neither adapter.
    modifier checked() {
        _;
        _checkGhosts();
    }

    // ==== the front door ====

    /// @dev A holder's deposit at the front door (_deposit); one draw in two the keeper then closes the batch and its
    /// message is relayed at once (_closeAndRelay), so deliveries reach the vault early in a run.
    function deposit(uint256 actorSeed, uint256 amount) external step checked {
        if (_deposit(actorSeed, amount) && (actorSeed >> 8) % 2 == 1) _closeAndRelay(amount);
    }

    /// @dev A holder's redeem request at the front door (_request); one draw in two then closed and relayed.
    function requestRedeem(uint256 actorSeed, uint256 shares) external step checked {
        if (_request(actorSeed, shares) && (actorSeed >> 8) % 2 == 1) _closeAndRelay(shares);
    }

    /// @dev The keeper closes the door's batch (_close).
    function closeBatch(uint256 valueSeed) external step checked {
        _close(valueSeed);
    }

    /// @dev A holder claims its credits on Base (_claim).
    function claim(uint256 actorSeed) external step checked {
        _claim(actorSeed);
    }

    /// @dev A round through the door and back, each call as its own action does it, whatever the state: each holder
    /// deposits (one draw in two) and each holder with shares asks to redeem some (one draw in two); the keeper closes
    /// and the batch is relayed (its outcome predicted as relayToBittensor's), the idle balance staked (one draw in
    /// two), each queued payout batch's next chunk sent and relayed to Base, and every holder claims. The ghost is
    /// checked after the close, the relay, and each payout's send and relay.
    function doorRound(uint256 seed) external step checked {
        for (uint256 k; k < ACTORS; ++k) {
            uint256 h = uint256(keccak256(abi.encode(seed, k)));
            if (h % 2 == 0) _deposit(k + ACTORS * ((h >> 1) % 3), h >> 8);
            if ((h >> 4) % 2 == 0) _request(k + ACTORS * ((h >> 5) % 4), h >> 16);
        }
        if (_closeAndRelay(seed)) _checkGhosts();
        if ((seed >> 4) % 2 == 0) _stakeIdle();
        uint256 n = queuedKeys.length;
        for (uint256 k; k < n && queuedKeys.length != 0; ++k) {
            (bool sent, uint256 i) = _processPayouts((seed >> 8) + k);
            _checkGhosts();
            if (sent) {
                _relayToBase(i, seed >> 12);
                _checkGhosts();
            }
        }
        for (uint256 k; k < ACTORS; ++k) {
            _claim(k);
        }
    }

    /// The keeper's close, and its batch relayed at once (the recipient actor's mode from `seed`, unused here), the
    /// ghost checked between the two. Returns whether a batch was sent (and relayed).
    function _closeAndRelay(uint256 seed) internal returns (bool sent) {
        uint256 i;
        (sent, i) = _close(seed);
        if (sent) {
            _checkGhosts();
            _relayToBittensor(i, seed >> 16);
        }
    }

    /// A holder's deposit at the front door: 0.03 to 1 TAO one draw in three (below a raised floor), else 1 to 50
    /// TAO, whole rao. The door's limits are far above it: no refusal. Returns whether it went through.
    function _deposit(uint256 actorSeed, uint256 amount) internal returns (bool ok) {
        address user = actors[actorSeed % ACTORS];
        uint256 minRao = fd.minDeposit() / RAO;
        amount = (actorSeed / ACTORS) % 3 == 0
            ? bound(amount, minRao, 1e18 / RAO) * RAO
            : bound(amount, 1e18 / RAO, MAX_DEPOSIT / RAO) * RAO;
        if (taoBase.balanceOf(user) < amount) return false;
        _readLogs();
        vm.prank(user);
        try fd.deposit(amount) {
            ok = true;
            ++deposits;
            _noteDeposit(fd, user);
            uint256 slot = _openDepositSlot[user];
            if (slot == 0) {
                _openDeposits.push(CascadeMessages.Entry(user, amount));
                _openDepositSlot[user] = _openDeposits.length;
            } else {
                _openDeposits[slot - 1].amount += amount;
            }
        } catch (bytes memory reason) {
            _dropLogs();
            _refused(reason, 0);
            _tag("deposit");
        }
    }

    /// A holder's redeem request at the front door, of 1 to all its shares (all one draw in four); its first in the
    /// open batch pays the request fee into the pot. A batch with only requests is a redeem-only batch. Returns
    /// whether it went through.
    function _request(uint256 actorSeed, uint256 shares) internal returns (bool ok) {
        address user = actors[actorSeed % ACTORS];
        uint256 balance = vault.balanceOf(user);
        if (balance == 0) return false;
        shares = (actorSeed / ACTORS) % 4 == 0 ? balance : bound(shares, 1, balance);
        bool first = _openRedeemSlot[user] == 0;
        uint256 fee = first ? fd.redeemRequestFee() : 0;
        _readLogs();
        vm.prank(user);
        try fd.requestRedeem{value: fee}(shares) {
            ok = true;
            ++redeemRequests;
            if (first) {
                _recordPotIn(fd, fee);
                _openRedeems.push(CascadeMessages.Entry(user, shares));
                _openRedeemSlot[user] = _openRedeems.length;
            } else {
                _openRedeems[_openRedeemSlot[user] - 1].amount += shares;
            }
        } catch (bytes memory reason) {
            _dropLogs();
            _refused(reason, 0);
            _tag("requestRedeem");
        }
    }

    /// The keeper closes the door's batch once its interval has passed (12 hours at the door's block rate), paying
    /// what the pot lacks of the fee and 0 to the fee more (I-21: it gets back no more than it sent). An empty batch
    /// rolls. A close sends the batch through the Base adapter: the handler records the message from its own record
    /// of the open batch and checks the router's payload is exactly it. Returns whether a batch was sent, and its
    /// message.
    function _close(uint256 valueSeed) internal returns (bool sent, uint256 i) {
        _warp(12 hours, doorBlockTime);
        (uint64 id,, uint256 total, uint256 pot, uint256 nDeposits, uint256 nRedeems) = fd.openBatch();
        uint256 fee = routerBase.fee();
        uint256 value = (pot < fee ? fee - pot : 0) + bound(valueSeed, 0, fee);
        uint256 held = address(this).balance;
        uint256 sends = routerBase.sendCount();
        _readLogs();
        try fd.closeBatch{value: value}(id, 0) {
            if (address(this).balance > held) ++closerGains;
            Vm.Log[] memory logs = _readLogs();
            if (nDeposits + nRedeems == 0) {
                ++rolls;
                if (address(this).balance != held || routerBase.sendCount() != sends) _tag("roll");
                return (false, 0);
            }
            _recordClose(fd, logs);
            ++closes;
            if (nDeposits == 0) ++redeemOnlyCloses;
            i = _recordDoorBatch(id, sends, total);
            sent = true;
        } catch (bytes memory reason) {
            _dropLogs();
            _refused(reason, 0);
            _tag("closeBatch");
        }
    }

    /// The door's batch `id`, sent as the router's send `sends` with `total` deposited: recorded from the handler's own
    /// record of the open batch, which then starts empty.
    function _recordDoorBatch(uint64 id, uint256 sends, uint256 total) internal returns (uint256 i) {
        bytes memory message = CascadeMessages.encodeBatch(id, _openDeposits, _openRedeems);
        i = _recordBatch(Kind.DoorBatch, sends, address(vault), address(fd), total, message);
        for (uint256 k; k < _openDeposits.length; ++k) {
            _depositsOf[i].push(_openDeposits[k]);
            delete _openDepositSlot[_openDeposits[k].user];
        }
        for (uint256 k; k < _openRedeems.length; ++k) {
            delete _openRedeemSlot[_openRedeems[k].user];
        }
        delete _openDeposits;
        delete _openRedeems;
        _trackMessage(baseChain, address(fd), message);
    }

    /// A holder with credits on Base (from `actorSeed` on) claims them all.
    function _claim(uint256 actorSeed) internal {
        for (uint256 k; k < ACTORS; ++k) {
            address user = actors[(actorSeed % ACTORS + k) % ACTORS];
            uint256 owed = fd.claimable(user);
            if (owed == 0) continue;
            uint256 before = taoBase.balanceOf(user);
            _readLogs();
            vm.prank(user);
            try fd.claim() {
                ++claims;
                if (taoBase.balanceOf(user) != before + owed) _tag("claim amount");
            } catch (bytes memory reason) {
                _dropLogs();
                _refused(reason, 0);
                _tag("claim");
            }
            return;
        }
    }

    // ==== the stranger: the re-entrant recipient actor's own batches ====

    /// Test-only: see keepActorModeOnBase.
    function setKeepActorModeOnBase(bool on) external {
        keepActorModeOnBase = on;
    }

    /// @dev I-11's router re-entry, aimed at (a targeted draw, Task 42's fix round 3, I-1): the actor's own batch (a
    /// deposit to itself: _strangerSend's seed 41) and, unless another batch toward Bittensor is pending already, a
    /// second put in flight behind it (a stranger batch to the vault or to the actor); then the actor's batch relayed
    /// with the actor accepting after re-entering (mode 3) or re-entering at two levels (6), the re-entry the router's
    /// delivery of that other batch (kind 5, a manual execution from inside this one): the adapter's lock refuses it
    /// (`reentriesRouter`), and the other batch is left in FAILURE, re-executable. The first relay's prediction and the
    /// actor's checks are _relayToBittensor's.
    function reenterThroughTheRouter(uint256 seed, uint256 amount) external step checked {
        (bool sent, uint256 i) = _strangerSend(41, amount);
        if (!sent) return;
        (bool other,) = _pendingOther(i);
        if (!other) {
            (bool sent2,) = _strangerSend(seed % 2 == 0 ? 33 : 41, amount >> 64);
            if (!sent2) return;
        }
        _checkGhosts();
        _relayToBittensor(i, ((seed >> 1) % 2 == 0 ? 3 : 6) + 8 * 5);
        ++routerReentryDraws;
    }

    /// @dev The recipient actor's own batch (_strangerSend); one draw in two relayed at once, its mode from `seed`, the
    /// ghost checked between the two.
    function strangerSend(uint256 seed, uint256 amount) external step checked {
        (bool sent, uint256 i) = _strangerSend(seed, amount);
        if (sent && (seed >> 12) % 2 == 1) {
            _checkGhosts();
            _relayToBittensor(i, seed >> 16);
        }
    }

    /// The recipient actor sends a well-formed batch through the Base adapter (anyone may): to itself three draws in
    /// four, else to the vault (an unknown peer there); one deposit of 0.01 to 5 TAO for itself, or (one draw in six) a
    /// redeem-only batch; or (one draw in eight) the same message as its last, again. It pays the lane's fee and 0 to
    /// the fee more (the excess stays in the Base adapter, its sweep's). Returns whether it was sent, and its message.
    function _strangerSend(uint256 seed, uint256 amount) internal returns (bool sent, uint256 i) {
        uint256 fee = routerBase.fee();
        uint256 value = fee + bound(seed >> 8, 0, fee);
        address to;
        bytes memory message;
        uint256 i0 = _lastStranger;
        if (seed % 8 == 0 && i0 != type(uint256).max) {
            to = _msgs[i0].recipient;
            message = _body[i0];
            amount = _msgs[i0].amount;
            ++strangerDuplicates;
        } else {
            to = (seed >> 3) % 4 == 0 ? address(vault) : address(recipient);
            (message, amount) = _strangerBatch((seed >> 5) % 6 == 0, amount);
        }
        uint256 sends = routerBase.sendCount();
        _readLogs();
        try recipient.forward{value: value}(
            address(adapterBase), abi.encodeCall(CcipAdapterBase.send, (bitChain, to, message, amount))
        ) {
            _readLogs();
            ++strangerSends;
            if (to == address(vault)) ++strangerToVault;
            i = _recordStranger(sends, to, amount, message);
            sent = true;
        } catch (bytes memory reason) {
            _dropLogs();
            _refused(reason, 0);
            _tag("strangerSend");
        }
    }

    /// A new stranger batch: redeem-only (one request of a share, no tokens), or one deposit for the actor of 0.01 to 5
    /// TAO, whole rao.
    function _strangerBatch(bool redeemOnly, uint256 amount) internal returns (bytes memory message, uint256) {
        ++_strangerId;
        CascadeMessages.Entry[] memory d;
        CascadeMessages.Entry[] memory r;
        if (redeemOnly) {
            amount = 0;
            r = new CascadeMessages.Entry[](1);
            r[0] = CascadeMessages.Entry(address(recipient), 1);
        } else {
            amount = bound(amount, adapterBase.minSendAmount() / RAO, 5e18 / RAO) * RAO;
            d = new CascadeMessages.Entry[](1);
            d[0] = CascadeMessages.Entry(address(recipient), amount);
        }
        message = CascadeMessages.encodeBatch(_strangerId, d, r);
        return (message, amount);
    }

    /// The stranger's batch `message` to `to`, sent as the router's send `sends`: recorded, its deposits from the
    /// message the handler built.
    function _recordStranger(uint256 sends, address to, uint256 amount, bytes memory message)
        internal
        returns (uint256 i)
    {
        i = _recordBatch(Kind.StrangerBatch, sends, to, address(recipient), amount, message);
        (, CascadeMessages.Entry[] memory d,) = CascadeMessages.decodeBatch(message);
        for (uint256 k; k < d.length; ++k) {
            _depositsOf[i].push(d[k]);
        }
        _lastStranger = i;
    }

    // ==== the lanes ====

    /// @dev Relays the next batch toward Bittensor that is in flight or failed (from `seed`; _relayToBittensor).
    function relayToBittensor(uint256 seed, uint256 modeSeed) external step checked {
        (bool found, uint256 i) = _pending(_toBittensor, seed);
        if (found) _relayToBittensor(i, modeSeed);
    }

    /// @dev Relays the next payout chunk or refund toward Base in flight or failed (from `seed`; _relayToBase).
    function relayToBase(uint256 seed, uint256 modeSeed) external step checked {
        (bool found, uint256 i) = _pending(_toBase, seed);
        if (found) _relayToBase(i, modeSeed);
    }

    /// Relays batch `i` toward Bittensor as CCIP executes it (a FAILURE re-executed), the recipient actor's behaviour
    /// drawn from `modeSeed` when it is the recipient. The outcome is predicted from the state (_predictDelivery) and
    /// read from the logs; the ghost moves by what happened.
    function _relayToBittensor(uint256 i, uint256 modeSeed) internal {
        Msg memory m = _msgs[i];
        bool toActor = m.recipient == address(recipient);
        if (toActor) _setActorMode(modeSeed, i);
        (Outcome want, bytes4 why) = _predictDelivery(i);
        bytes32[] memory others = _othersBefore(m.parkKey);
        uint256 actorBefore = address(recipient).balance;
        uint256 deliveredBefore = recipient.delivered();
        if (m.state == State.Failed) ++reExecutions;
        ++relaysToBittensor;
        _readLogs();
        (bool ok, bytes memory reason) =
            relayMessage(routerBase, routerBit, address(adapterBit), address(adapterBase), baseSelector, m.sendIndex);
        if (!ok) {
            _dropLogs();
            _msgs[i].state = State.Failed;
            if (want != Outcome.Fail || _innerSelector(reason) != why) _tag("relay: an unpredicted failure");
            else if (why == CcipBittensorAdapter.AlreadyParked.selector) ++failuresAlreadyParked;
            else ++failuresLocked;
            if (toActor) _checkActorCall(i, others, actorBefore, false, _noLogs());
            return;
        }
        Vm.Log[] memory logs = _readLogs();
        if (want == Outcome.Fail) _tag("relay: predicted fail delivered");
        (bool parked, bool converted, bytes4 reasonLogged) = _parkLogged(logs, i);
        if (parked) {
            if (
                (want != Outcome.ParkTokens && want != Outcome.ParkNative) || converted != (want == Outcome.ParkNative)
                    || reasonLogged != why
            ) _tag("relay: an unpredicted park");
            _park(i, converted);
            _countPark(m.amount, reasonLogged);
            if (_vaultDelivered(logs, m)) ++lostOutcomes;
        } else {
            if (want != Outcome.Deliver) _tag("relay: an unpredicted delivery");
            _delivered(i, logs, deliveredBefore);
        }
        if (toActor) _checkActorCall(i, others, actorBefore, !parked, logs);
    }

    /// Relays payout chunk or refund `i` toward Base. The recipient actor (a refund of its own batch) accepts, or
    /// refuses one draw in four (a FAILURE, re-executable); it re-enters nothing there (one EVM holds both chains, and
    /// a Base delivery cannot reach the Bittensor adapter). A refund to the door must credit each depositor exactly its
    /// deposit and lower netForwarded by it (I-9).
    function _relayToBase(uint256 i, uint256 modeSeed) internal {
        Msg memory m = _msgs[i];
        bool refusing;
        if (m.recipient == address(recipient)) {
            refusing = modeSeed % 4 == 0;
            recipient.setMode(ReentrantRecipient.Mode.Off, address(0), "", false);
            recipient.setRefusing(refusing);
        }
        uint256 forwarded = fd.netForwarded();
        uint256 actorTokens = taoBase.balanceOf(address(recipient));
        uint256[ACTORS] memory owed;
        for (uint256 k; k < ACTORS; ++k) {
            owed[k] = fd.claimable(actors[k]);
        }
        ++relaysToBase;
        _readLogs();
        (bool ok, bytes memory reason) =
            relayMessage(routerBit, routerBase, address(adapterBase), address(adapterBit), bitSelector, m.sendIndex);
        recipient.setRefusing(false);
        if (!ok) {
            _dropLogs();
            _msgs[i].state = State.Failed;
            ++failuresOnBase;
            if (!refusing || _innerSelector(reason) != ReentrantRecipient.Refused.selector) _tag("relayToBase failed");
            return;
        }
        Vm.Log[] memory logs = _readLogs();
        if (refusing) _tag("relayToBase: refuser took it");
        _msgs[i].state = State.Delivered;
        if (m.recipient == address(recipient)) {
            ++refundsToRecipient;
            if (taoBase.balanceOf(address(recipient)) != actorTokens + m.amount) ++refundMiscredits;
            return;
        }
        if (!_landed(m, logs)) ++lostOutcomes;
        if (fd.netForwarded() != _sub0(forwarded, m.amount)) {
            if (m.kind == Kind.Refund) ++refundMiscredits;
            else _tag("netForwarded after a payout");
        }
        if (m.kind == Kind.Refund) {
            ++refundsCredited;
            _checkRefundCredits(m.origin, logs, owed, m.parkKey);
        }
    }

    /// Whether the door logged `m`'s PayoutsDelivered among `logs`: its key (a refund's chunk REFUND_CHUNK), its
    /// amount, through the Base adapter.
    function _landed(Msg memory m, Vm.Log[] memory logs) internal view returns (bool) {
        for (uint256 k; k < logs.length; ++k) {
            Vm.Log memory log = logs[k];
            if (log.emitter != address(fd) || log.topics[0] != CascadeFrontDoor.PayoutsDelivered.selector) continue;
            (uint32 chunk, uint256 amount, address bridge) = abi.decode(log.data, (uint32, uint256, address));
            if (
                log.topics[1] == m.batchKey && amount == m.amount && bridge == address(adapterBase)
                    && (m.kind != Kind.Refund || chunk == adapterBit.REFUND_CHUNK())
            ) return true;
        }
        return false;
    }

    // ==== the vault ====

    /// @dev The keeper stakes the vault's idle balance (_stakeIdle).
    function stakeIdle() external step checked {
        _stakeIdle();
    }

    /// The keeper stakes the vault's idle balance (at least the chain's minimum): EnforcedPause while the vault is
    /// paused, NothingToStake below the minimum.
    function _stakeIdle() internal {
        uint256 idle = _availableAt(vaultLens.pendingPayouts());
        bytes4 expect;
        if (vault.paused()) expect = Pausable.EnforcedPause.selector;
        else if (idle / RAO < vaultLens.minStakeRao()) expect = NothingToStake.selector;
        _readLogs();
        try vault.stakeIdle() {
            _went(expect, "stakeIdle: refusal went");
            ++stakes;
        } catch (bytes memory reason) {
            _dropLogs();
            if (!_refused(reason, expect)) _tag("stakeIdle");
        }
    }

    /// @dev The next payout chunk (_processPayouts); one draw in two relayed to Base at once, the ghost checked between
    /// the two.
    function processPayouts(uint256 seed) external step checked {
        (bool sent, uint256 i) = _processPayouts(seed);
        if (sent && (seed >> 16) % 2 == 1) {
            _checkGhosts();
            _relayToBase(i, seed >> 20);
        }
    }

    /// The keeper sends the next chunk of a queued payout batch (from `seed`) once the payout delay has passed, at the
    /// lane's fee with no top-up (the fee is within the ceiling). Its refusal predicted: the vault paused, the chunk or
    /// its net below the conversion floor, VaultModel's _chunkOutcome (the walk), then the send's conversion
    /// (_collectRefusal). A chunk sent records its message toward Base; returns whether one was, and its message.
    function _processPayouts(uint256 seed) internal returns (bool sent, uint256 i) {
        uint256 n = queuedKeys.length;
        if (n == 0) return (false, 0);
        bytes32 key = queuedKeys[seed % n];
        _warp(vaultLens.payoutDelay(), vaultBlockTime);
        CascadeMessages.Payout[] memory list = _lists[key];
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        bytes4 expect = _payoutRefusal(list, b);
        uint256 sends = routerBit.sendCount();
        _readLogs();
        try vault.processPayouts(key, list, CHUNK_ENTRIES) {
            _went(expect, "processPayouts: refusal went");
            _readLogs();
            ++payoutChunks;
            if (routerBit.sendCount() > sends) {
                i = _recordPayoutSend(sends);
                sent = true;
            }
            if (vaultLens.getPayoutBatch(key).count == 0) _dropKey(key);
        } catch (bytes memory reason) {
            _dropLogs();
            if (!_refused(reason, expect)) {
                _tag("processPayouts");
            } else if (expect == Pausable.EnforcedPause.selector || expect == UnstakeShort.selector) {
                ++payoutsRefusedVault;
            } else {
                ++payoutsRefusedRail;
            }
        }
    }

    /// A payout chunk the vault sent as router `routerBit`'s send `sends`: recorded in flight toward Base, its key the
    /// PAYOUTS' batch key.
    function _recordPayoutSend(uint256 sends) internal returns (uint256 i) {
        MockRouter.Sent memory s = routerBit.sendAt(sends);
        (address to, address from, bytes memory message) = adapterBit.decodePayload(s.data);
        Msg memory m = _newMsg(Kind.Payout, sends, to, from, s.tokenAmounts.length == 0 ? 0 : s.tokenAmounts[0].amount);
        (m.batchKey,,) = CascadeMessages.decodePayouts(message);
        _msgs.push(m);
        i = _msgs.length - 1;
        // the chunk's own message, which a forged copy replays (the R4 review, Important 1c)
        _body[i] = message;
        _toBase.push(i);
    }

    /// @dev The vault paused (by the guardian or the owner) or, when paused, unpaused by the owner.
    function pauseVault(uint256 seed) external step checked {
        bool paused = vault.paused();
        address who = paused || seed % 2 == 0 ? owner : guardian;
        _readLogs();
        vm.prank(who);
        try (paused ? vault.unpause : vault.pause)() {
            if (paused) ++vaultUnpauses;
            else ++vaultPauses;
        } catch (bytes memory reason) {
            _dropLogs();
            _refused(reason, 0);
            _tag("pauseVault");
        }
    }

    /// @dev The stake hotkey's whole position swapped to an unlisted hotkey (a validator's swap: the vault's stake goes
    /// missing, so it refuses every delivery StakeMissing), or, when swapped, swapped back.
    function swapAway() external step checked {
        bytes32 h = vaultLens.stakeHotkey();
        if (!swapped) {
            if (_stakeOf(h) == 0) return;
            staking.swapHotkey(h, AWAY, coldkey, 10_000);
            swapped = true;
            ++swapsAway;
        } else {
            staking.swapHotkey(AWAY, h, coldkey, 10_000);
            swapped = false;
            ++swapsBack;
        }
    }

    // ==== ForeverMoney and the chain ====

    /// @dev ForeverMoney's rounding (its test knobs, whole rao): short by 0, 1 rao (within the tolerance: two draws in
    /// four) or 2 rao (past it), and one draw in four 1 rao in the adapter's favour both ways.
    function fmRoundShort(uint256 seed) external step checked {
        av.setShortBy([uint256(0), 1e9, 1e9, 2e9][seed % 4]);
        uint256 favour = (seed >> 2) % 4 == 0 ? 1e9 : 0;
        av.setOverpay(favour);
        av.setOvermint(favour);
        ++fmShortSwitches;
    }

    /// @dev ForeverMoney's halt: its guardian's pause of 1 hour to 2 days (PauseCooldown inside its cooldown), its
    /// operator's hold of 1 hour to a day, or the operator's unpause.
    function fmPause(uint256 seed) external step checked {
        // a finished migration halts for good: no clock moves it
        if (av.migrationFinished()) return;
        uint256 kind = seed % 3;
        if (kind == 0) {
            uint256 dur = bound(seed >> 2, 1 hours, av.MAX_PAUSE());
            bytes4 expect =
                vm.getBlockTimestamp() < av.pauseableAfter() ? MockAlphaVault.PauseCooldown.selector : bytes4(0);
            try av.guardianPause(dur) {
                _went(expect, "guardianPause: refusal went");
                ++fmHalts;
            } catch (bytes memory reason) {
                if (_refused(reason, expect)) ++fmHaltsRefused;
                else _tag("guardianPause");
            }
        } else if (kind == 1) {
            av.adminHold(vm.getBlockTimestamp() + bound(seed >> 2, 1 hours, 1 days));
            ++fmHalts;
        } else {
            av.unpause();
            ++fmUnpauses;
        }
    }

    /// @dev ForeverMoney's migration, by `seed` mod 4: its notice started (0, with none pending); a pending notice
    /// cancelled (1, 2); once ready, executed (3: the position leaves, conversions are Insolvent from then on), and
    /// once executed, finished (3: halted for good).
    function fmMigrate(uint256 seed) external step checked {
        if (av.migrationFinished()) return;
        uint256 kind = seed % 4;
        bool pending = av.migrationReadyAt() != 0;
        bool executed = av.migrationExecuted();
        if (kind == 0 && !pending && !executed) {
            av.initiateMigration();
            ++fmMigrationsStarted;
        } else if ((kind == 1 || kind == 2) && pending && !executed) {
            av.cancelMigration();
            ++fmMigrationsCancelled;
        } else if (kind == 3 && pending && !executed && vm.getBlockTimestamp() >= av.migrationReadyAt()) {
            av.executeMigration();
            ++fmMigrationsExecuted;
        } else if (kind == 3 && executed) {
            av.finishMigration();
            ++fmMigrationsFinished;
        }
    }

    /// @dev The chain's minimum stake (the root key's): its default 0.002 TAO (three draws in six), 0.02 TAO, 1 TAO or
    /// 5 TAO, the adapter's conversion floor with it.
    function raiseFloor(uint256 seed) external step checked {
        staking.setMinStake([uint256(0), 0, 0, 20_000_000, 1e9, 5e9][seed % 6]);
        ++floorRaises;
    }

    /// @dev The Bittensor adapter's reserves: the native reserve drained (the balance left at the ghost's native parks)
    /// or funded to RESERVE_TARGET, the token cushion drained (the tokens left at the ghost's token parks and the booked
    /// cushion written to 0: a cushion spent on covered roundings, R4 F-1) or funded to TOKEN_RESERVE_TARGET through
    /// fundCushion (booked). A drain never takes what is owed: it stops at the ghost's parks, and only when the balance is
    /// above them. One drain in two also sets ForeverMoney 1 rao short both ways, the rounding
    /// a drained reserve no longer covers.
    function drainCushion(uint256 seed) external step checked {
        uint256 kind = seed % 4;
        if (kind < 2 && (seed >> 2) % 2 == 0) {
            av.setShortBy(1e9);
            av.setOverpay(0);
            av.setOvermint(0);
        }
        if (kind == 0) {
            if (address(adapterBit).balance > ghostParkedNative) {
                vm.deal(address(adapterBit), ghostParkedNative);
                ++reserveDrains;
            }
        } else if (kind == 1) {
            uint256 tokens = taoBit.balanceOf(address(adapterBit));
            if (tokens > ghostParkedTokens) {
                taoBit.burn(address(adapterBit), tokens - ghostParkedTokens);
                vm.store(address(adapterBit), bytes32(_cushionSlot()), bytes32(0));
                ++cushionDrains;
            }
        } else if (kind == 2) {
            uint256 target = adapterBit.RESERVE_TARGET();
            vm.deal(address(this), address(this).balance + target);
            adapterBit.fundReserve{value: target}();
            ++reserveFunds;
        } else {
            uint256 target = adapterBit.TOKEN_RESERVE_TARGET();
            taoBit.mint(address(this), target);
            taoBit.approve(address(adapterBit), target);
            adapterBit.fundCushion(target);
            ++cushionFunds;
        }
    }

    /// @dev Time on both chains, at the door's block rate: 1 hour to 3 days, or (one draw in four) past PARK_TIMEOUT;
    /// then I-10's probe of every aged park.
    function warp(uint256 seed) external step checked {
        if (seed % 4 == 0) {
            _warp(adapterBit.PARK_TIMEOUT() + bound(seed >> 2, 1 hours, 1 days), doorBlockTime);
            ++warpsPastTimeout;
        } else {
            _warp(bound(seed >> 2, 1 hours, 3 days), doorBlockTime);
        }
        _probeLiveness();
    }

    /// @dev I-10's probe on its own (no time passes).
    function probeLiveness() external step checked {
        _probeLiveness();
    }

    // ==== the park functions, by anyone ====

    /// @dev Anyone delivers a park (from `seed`; one draw in eight any batch's key, a delivered, refunded, dropped, in
    /// flight or failed one's among them, with no record: NotParked), the recipient actor's behaviour drawn from
    /// `modeSeed` when it is the recipient. A token park converts first, no try: its conversion's refusal reverts the
    /// call and the record stays; the recipient's refusal re-parks it converted, its parkedAt kept.
    function deliverParked(uint256 seed, uint256 modeSeed) external step checked {
        // one draw in four the recipient actor's own park, when it has one (I-11's reach)
        bool found;
        bytes32 key;
        uint256 i;
        if (seed % 4 == 1) (found, key, i) = _parkWhere(true, false);
        if (!found) (found, key, i) = _parkFrom(seed);
        if (!found) return;
        Park memory p = _parks[key];
        Msg memory m = _msgs[i];
        bool toActor = m.recipient == address(recipient);
        if (toActor) _setActorMode(modeSeed, i);
        (Outcome want, bytes4 why) = _predictDeliverParked(key);
        bytes32[] memory others = _othersBefore(key);
        uint256 actorBefore = address(recipient).balance;
        uint256 deliveredBefore = recipient.delivered();
        _readLogs();
        vm.prank(anyone);
        try adapterBit.deliverParked(m.recipient, m.sender, _body[i]) {
            Vm.Log[] memory logs = _readLogs();
            if (want == Outcome.Fail) _tag("deliverParked: refusal went");
            if (!p.live) {
                _deadKeyWent(i);
            } else if (_adapterLogged(logs, CcipBittensorAdapter.ParkedConverted.selector, key)) {
                if (want != Outcome.ParkNative) _tag("deliverParked: re-park");
                if (!p.converted) {
                    ghostParkedTokens -= p.amount;
                    ghostParkedNative += p.amount;
                    _parks[key].converted = true;
                    ++parksConverted;
                }
                _msgs[i].state = State.ParkedNative;
                ++deliverParkedRefused;
                if (toActor) _checkActorCall(i, others, actorBefore, false, logs);
            } else if (_adapterLogged(logs, CcipBittensorAdapter.ParkedDelivered.selector, key)) {
                if (want != Outcome.Deliver) _tag("deliverParked: delivery");
                _unpark(key);
                ++parksDelivered;
                if (!p.converted) ++parksDeliveredFromTokens;
                _delivered(i, logs, deliveredBefore);
                if (toActor) _checkActorCall(i, others, actorBefore, true, logs);
            } else {
                ++lostOutcomes;
            }
        } catch (bytes memory reason) {
            _dropLogs();
            if (want != Outcome.Fail || _selector(reason) != why) _tag("deliverParked: refusal");
            else if (why == ReentrancyGuard.ReentrancyGuardReentrantCall.selector) ++deliverParkedLocked;
            else if (why == CcipBittensorAdapter.NotParked.selector) ++notParkedRefusals;
            if (toActor) _checkActorCall(i, others, actorBefore, false, _noLogs());
        }
    }

    /// @dev Anyone refunds a park (from `seed`; one draw in eight any batch's key, which may hold no record) with the
    /// quoted fee and 0 to the fee more, or (one draw in eight) a wei less, one draw in two once its PARK_TIMEOUT has
    /// been waited out. Its refusal predicted (_predictRefund); a refund sends the parked batch's deposits back to its
    /// door (I-9: the message checked here, the credit on Base), one draw in two relayed at once, the ghost checked
    /// between the two.
    function refundParked(uint256 seed, uint256 valueSeed) external step checked {
        (bool found, bytes32 key, uint256 i) = _parkFrom(seed);
        if (!found) return;
        Park memory p = _parks[key];
        uint256 due = uint256(p.parkedAt) + adapterBit.PARK_TIMEOUT();
        if (p.live && (valueSeed >> 1) % 2 == 0 && vm.getBlockTimestamp() < due) {
            _warp(due - vm.getBlockTimestamp(), doorBlockTime);
        }
        Msg memory m = _msgs[i];
        uint256 quote;
        if (p.live && p.amount != 0) {
            bool quoted;
            (quoted, quote,) = _quoteRefund(m, _body[i]);
            if (!quoted) {
                _tag("quoteRefund refused");
                return;
            }
        }
        bool short = valueSeed % 8 == 0 && quote != 0;
        uint256 value = short ? quote - 1 : quote + bound(valueSeed >> 3, 0, quote);
        bytes4 expect = _predictRefund(key, value, quote);
        uint256 sends = routerBit.sendCount();
        _readLogs();
        vm.prank(anyone);
        try adapterBit.refundParked{value: value}(m.recipient, m.sender, _body[i]) {
            _went(expect, "refundParked: refusal went");
            Vm.Log[] memory logs = _readLogs();
            if (!p.live) {
                _deadKeyWent(i);
                return;
            }
            if (!_adapterLogged(logs, CcipBittensorAdapter.ParkedRefunded.selector, key)) ++lostOutcomes;
            (bool sent, uint256 r) = _refunded(key, sends);
            if (value > quote) ++refundsWithExcess;
            // one draw in two the refund is relayed to Base at once (I-9's credit)
            if (sent && (valueSeed >> 2) % 2 == 0) {
                _checkGhosts();
                _relayToBase(r, valueSeed >> 8);
            }
        } catch (bytes memory reason) {
            _dropLogs();
            if (!_refused(reason, expect)) {
                _tag("refundParked");
            } else if (expect == CcipBittensorAdapter.ParkedTooYoung.selector) {
                ++refundsRefusedYoung;
            } else if (expect == CcipBittensorAdapter.NotParked.selector) {
                ++notParkedRefusals;
            } else if (expect == CcipBittensorAdapter.NothingToRefund.selector) {
                ++refundsRefusedEmpty;
            } else if (expect == CcipAdapterBase.InsufficientFee.selector) {
                ++refundsRefusedFee;
            } else {
                ++refundsRefusedRail;
            }
        }
    }

    /// @dev Anyone drops a park (from `seed`; one draw in eight any batch's key, which may hold no record): only an
    /// empty one, after the timeout (NotParked for none, or one with an amount, ParkedTooYoung before).
    function dropParked(uint256 seed) external step checked {
        // one draw in two an empty park, when there is one, and one draw in two once its timeout has been waited out
        bool found;
        bytes32 key;
        uint256 i;
        if (seed % 2 == 0) (found, key, i) = _parkWhere(false, true);
        if (!found) (found, key, i) = _parkFrom(seed >> 1);
        if (!found) return;
        Park memory p = _parks[key];
        uint256 due = uint256(p.parkedAt) + adapterBit.PARK_TIMEOUT();
        if (p.live && (seed >> 1) % 2 == 0 && vm.getBlockTimestamp() < due) {
            _warp(due - vm.getBlockTimestamp(), doorBlockTime);
        }
        Msg memory m = _msgs[i];
        bytes4 expect;
        if (!p.live || p.amount != 0) {
            expect = CcipBittensorAdapter.NotParked.selector;
        } else if (vm.getBlockTimestamp() < uint256(p.parkedAt) + adapterBit.PARK_TIMEOUT()) {
            expect = CcipBittensorAdapter.ParkedTooYoung.selector;
        }
        _readLogs();
        vm.prank(anyone);
        try adapterBit.dropParked(m.recipient, m.sender, _body[i]) {
            _went(expect, "dropParked: refusal went");
            Vm.Log[] memory logs = _readLogs();
            if (!p.live) {
                _deadKeyWent(i);
                return;
            }
            if (!_adapterLogged(logs, CcipBittensorAdapter.ParkedDropped.selector, key)) ++lostOutcomes;
            _unpark(key);
            _msgs[i].state = State.Dropped;
            ++drops;
        } catch (bytes memory reason) {
            _dropLogs();
            if (!_refused(reason, expect)) _tag("dropParked");
            else if (expect == CcipBittensorAdapter.NotParked.selector) ++notParkedRefusals;
            else ++dropsRefused;
        }
    }

    /// @dev Anyone sweeps an adapter's surplus to the treasury: the Base adapter's (three draws in four the Bittensor
    /// adapter's). The amounts are checked against the ghost: the Base adapter's whole balance; the Bittensor adapter's
    /// balance above RESERVE_TARGET and the ghost's native parks, and tokens above the booked cushion (R4 F-1) and its
    /// token parks, each floored at 0 (I-7: a sweep never takes what is owed).
    function sweepSurplus(uint256 seed) external step checked {
        bool onBase = seed % 4 == 0;
        uint256 native;
        uint256 tokens;
        if (onBase) {
            native = address(adapterBase).balance;
            tokens = taoBase.balanceOf(address(adapterBase));
        } else {
            native = _sub0(address(adapterBit).balance, adapterBit.RESERVE_TARGET() + ghostParkedNative);
            uint256 held = taoBit.balanceOf(address(adapterBit));
            tokens = _sub0(held, adapterBit.tokenCushion() + ghostParkedTokens);
        }
        uint256 treasuryNative = adapterTreasury.balance;
        uint256 treasuryTokens = (onBase ? taoBase : taoBit).balanceOf(adapterTreasury);
        _readLogs();
        vm.prank(anyone);
        try (onBase ? adapterBase.sweepSurplus : adapterBit.sweepSurplus)() {
            if (
                adapterTreasury.balance != treasuryNative + native
                    || (onBase ? taoBase : taoBit).balanceOf(adapterTreasury) != treasuryTokens + tokens
            ) ++sweepMismatches;
            if (onBase) ++sweepsBase;
            else ++sweepsBittensor;
            if (native + tokens != 0) ++sweepsNonZero;
        } catch (bytes memory reason) {
            _dropLogs();
            _refused(reason, 0);
            _tag("sweepSurplus");
        }
    }

    /// The booked cushion's slot in the Bittensor adapter (R4 F-1), for drainCushion's cheat.
    StdStorage internal _cushionStore;

    function _cushionSlot() internal returns (uint256) {
        return _cushionStore.target(address(adapterBit)).sig("tokenCushion()").find();
    }

    // ==== the compromised lane (R4, the forged-message review) ====

    /// The old rail: a second adapter pair whose Base half the front door knows (activated, then disabled) and whose
    /// Bittensor half the vault has disabled. The test builds it in its setUp and names it here; zero until then.
    CcipBaseAdapter public oldBase;
    CcipBittensorAdapter public oldBit;

    /// The compromised lane's calls (forgedToBittensor, forgedToBase, forgedFromOldRail), and those that moved another
    /// party's value beyond what the call itself carried (asserted 0), with the last one's tag; and their reach: refused,
    /// landed (delivered, parked or credited), and forged redeems that burned a holder's shares (F-2, the stated
    /// residual: a forged redeem-only batch carries nothing and still burns, which no check on Bittensor can refuse;
    /// the monitor and the owner's cancel answer it, so it is counted, never a leak).
    uint256 public forgedCalls;
    uint256 public forgedLeaks;
    bytes32 public lastForgedLeak;
    uint256 public forgedRefused;
    uint256 public forgedLanded;
    uint256 public forgedRedeemBurns;
    /// Forged actions whose own path reverted in the handler (asserted 0 with the leaks, and counted unexpected): each
    /// runs through an external self-call (runForged), so no handler revert is dropped by the campaign's
    /// fail_on_revert = false (the R4 review: copies toward Base once reverted unseen). And the forged calls that were an
    /// exact copy of an honest message (a delivered or parked batch toward Bittensor, a payout chunk or a refund toward
    /// Base).
    uint256 public forgedNotRun;
    uint256 public forgedCopies;
    /// Forged calls during which surplus moved to the treasury (the sweep a reached recipient set off; no leak).
    uint256 public forgedSweeps;

    /// The shape a dedicated draw asks of the next forged call (Task 42, the R4-K re-review's Minor 1: the random draws
    /// reached F-2 and the sweep about once a campaign): `Drawn`, the random draws; `RedeemOnly`, F-2's shape (from the
    /// door to the vault through the live lane, a redeem-only batch naming every holder, carrying nothing); `ActorSweep`,
    /// a call through the old rail that reaches the recipient actor, which re-enters the live adapter's sweep and
    /// accepts, while surplus sits on the live adapter.
    enum Shape {
        Drawn,
        RedeemOnly,
        ActorSweep
    }

    Shape internal _shape;
    /// The dedicated draws made (each one forged call, counted in forgedCalls too).
    uint256 public forgedRedeemOnlyDraws;
    uint256 public forgedSweepDraws;

    /// What the other parties hold, read before a forged call and again after it.
    struct Seen {
        uint256 parkedNative;
        uint256 parkedTokens;
        uint256 cushion;
        uint256 native;
        uint256 tokens;
        uint256 pending;
        uint256 price;
        bytes32[] parks;
        bytes32[] queued;
        uint256[] shares;
        uint256[] claimable;
        uint256 openDeposits;
        uint256 feePot;
        uint256 feeCredit;
        uint256 doorTokens;
        uint256 claimableTotal;
        uint256 treasuryNative;
        uint256 treasuryTokens;
    }

    /// What a forged call says: its message, the amount and the tokens it names and carries, its payload's recipient
    /// and sender, and the holders it names (credited on Base, or asked to redeem on Bittensor).
    struct Forged {
        bytes message;
        uint256 amount;
        uint256 carried;
        address token;
        address to;
        address from;
        address[] named;
        bool copy;
    }

    function setOldRail(CcipBaseAdapter base_, CcipBittensorAdapter bit_) external {
        oldBase = base_;
        oldBit = bit_;
    }

    /// @dev The router of a compromised lane delivers to the Bittensor adapter whatever it likes (_forgedToBittensor).
    function forgedToBittensor(uint256 seed, uint256 amountSeed, uint256 tokenSeed) external step checked {
        _runForged(0, seed, amountSeed, tokenSeed);
    }

    /// @dev The router of a compromised lane delivers to the Base adapter whatever it likes (_forgedToBase).
    function forgedToBase(uint256 seed, uint256 amountSeed, uint256 tokenSeed) external step checked {
        _runForged(1, seed, amountSeed, tokenSeed);
    }

    /// @dev Either of the above through the old rail's pair, which the vault has disabled and the door still knows.
    function forgedFromOldRail(uint256 seed, uint256 amountSeed, uint256 tokenSeed) external step checked {
        _runForged(2, seed, amountSeed, tokenSeed);
    }

    /// @dev F-2's dedicated draw (Task 42): a compromised live lane's redeem-only batch from the door to the vault,
    /// naming every holder and carrying nothing, so it burns whatever matured shares the window lets it (the stated
    /// residual, counted in forgedRedeemBurns, never a leak) and moves nothing else. One draw in two a day passes first,
    /// so the holders' fresh shares have matured and the door hold lets the burn through.
    function forgedRedeemOnly(uint256 seed) external step checked {
        if (seed % 2 == 0) _warp(STAKE_RAMP, vaultBlockTime);
        _shape = Shape.RedeemOnly;
        _runForged(0, seed >> 1, 0, 0);
        _shape = Shape.Drawn;
        ++forgedRedeemOnlyDraws;
    }

    /// @dev The sweep's dedicated draw (Task 42): first surplus on the live Bittensor adapter that nobody owns (a plain
    /// transfer of 0.001 to 1 TAO in FM-TAO, or one draw in two in native TAO, which the honest sweepSurplus would also
    /// take), then a compromised old rail's call that reaches the recipient actor, which re-enters the live adapter's
    /// permissionless sweep and accepts: the surplus moves to the immutable treasury, and nothing else moves. The
    /// surplus is minted (or dealt) into the run itself, not into a snapshot, and is meant to stay: when the forged
    /// call does not sweep it (the old rail's refusal, a park), it is the adapter's unowned surplus for the rest of the
    /// run, as a stray transfer would be, which the honest sweepSurplus and later forged calls may take (the Task 42
    /// review's Minor 9: harmless, and intended).
    function forgedSweep(uint256 seed, uint256 amount) external step checked {
        amount = bound(amount, 1e15 / RAO, 1e18 / RAO) * RAO;
        if (seed % 2 == 0) taoBit.mint(address(adapterBit), amount);
        else vm.deal(address(adapterBit), address(adapterBit).balance + amount);
        _shape = Shape.ActorSweep;
        // an even seed: toward Bittensor through the old rail (runForged)
        _runForged(2, (seed >> 1) << 1, 0, 0);
        _shape = Shape.Drawn;
        ++forgedSweepDraws;
    }

    /// One forged action (`route` 0 toward Bittensor, 1 toward Base, 2 through the old rail) through the external
    /// self-call runForged: a revert anywhere in the handler's own path (the forged delivery's own refusal is caught
    /// inside it) counts in forgedNotRun and unexpectedReverts instead of vanishing.
    function _runForged(uint256 route, uint256 seed, uint256 amountSeed, uint256 tokenSeed) internal {
        try this.runForged(route, seed, amountSeed, tokenSeed) {}
        catch {
            ++forgedNotRun;
            ++unexpectedReverts;
        }
    }

    /// The handler's own self-call for _runForged; no campaign targets it.
    function runForged(uint256 route, uint256 seed, uint256 amountSeed, uint256 tokenSeed) external {
        require(msg.sender == address(this), "the handler's own call");
        if (route == 0) {
            _forgedToBittensor(adapterBit, seed, amountSeed, tokenSeed);
        } else if (route == 1) {
            _forgedToBase(adapterBase, seed, amountSeed, tokenSeed);
        } else {
            require(address(oldBit) != address(0), "the old rail is built in setUp");
            if (seed % 2 == 0) _forgedToBittensor(oldBit, seed >> 1, amountSeed, tokenSeed);
            else _forgedToBase(oldBase, seed >> 1, amountSeed, tokenSeed);
        }
    }

    /// A compromised lane's delivery to `target`, inside a snapshot reverted after it (so the honest ghost map is never
    /// touched, and each forged call is judged from a state the honest actions reached): its amount drawn from 0, 1 rao,
    /// a sub-floor 0.001 TAO, the booked cushion, the cushion and a rao, a park's amount, all the token parks, and more
    /// than the whole balance; the tokens it really brings none, half, all or more than the amount, or (one draw in
    /// eight) named as another token; its payload's recipient the vault, the recipient actor or an address with no code,
    /// its sender the door, a stranger or the actor; its message a fresh batch for a stranger, a redeem-only batch
    /// naming every holder, an exact copy of a delivered batch, of a parked one, or a PAYOUTS. Then _checkForged.
    function _forgedToBittensor(CcipBittensorAdapter target, uint256 seed, uint256 amountSeed, uint256 tokenSeed)
        internal
    {
        Seen memory before = _see();
        uint256 snap = vm.snapshotState();
        _readLogs();
        // a forged call through the old rail reaches the recipient actor while the live adapter's lock is not held: its
        // re-entry, an honest party's own call, is set to the permissionless sweep for this one call (reverted with the
        // snapshot), so what is judged is the forged call's effect and the one honest move it can set off, surplus to
        // the treasury (the R4 review, Important 1a); the actor's other re-entries are the honest campaign's
        // (the sweep's dedicated draw sets a mode that re-enters and accepts, so the sweep runs)
        bool sweepDraw = _shape == Shape.ActorSweep;
        if (sweepDraw) recipient.setRefusing(false);
        recipient.setMode(
            sweepDraw ? ReentrantRecipient.Mode.RevertThenReenter : recipient.mode(),
            address(adapterBit),
            abi.encodeCall(CcipBittensorAdapter.sweepSurplus, ()),
            !sweepDraw && recipient.bubble()
        );
        Forged memory f = _forgedBatch(target, seed, amountSeed, tokenSeed);
        if (f.carried != 0) taoBit.mint(address(target), f.carried);
        Client.Any2EVMMessage memory m = _forgedMessage(target, f, baseSelector, seed);
        vm.prank(address(routerBit));
        bool landed;
        try target.ccipReceive(m) {
            landed = true;
        } catch {}
        _dropLogs();
        (bool leak, uint256 burns, bool swept) = _checkForged(before, f, true);
        // the snapshot reverts the handler's own storage too: the counters are written after it
        vm.revertToState(snap);
        _countForged(landed, leak, burns, f.copy, swept, "forgedToBittensor");
    }

    /// A compromised lane's delivery to the Base adapter `target`, as _forgedToBittensor's: a PAYOUTS crediting a
    /// stranger or the holders, an exact copy of a payout chunk or of a refund, a REFUND_CHUNK under a made-up key, or a
    /// BATCH; to the door or to a stranger, from the vault or a stranger; amounts and tokens drawn the same way. The
    /// recipient actor re-enters nothing on this side, as _relayToBase sets it: a delivery on Base cannot reach the
    /// Bittensor adapter (one EVM holds both chains here, two chains in production), and its re-entry left from an
    /// earlier relay toward Bittensor (the router's delivery of a batch then in flight) would re-execute a message CCIP
    /// has since executed, which it never does (the long run's counterexample, test_aForgedCopyToBaseCannotReachTheBit-
    /// tensorSide: the mock router minted that batch's tokens a second time and the adapter parked them). Either guard
    /// alone suffices: this mode, or the routers' exactly-once mode (the campaigns turn both on; the pin's variants
    /// show each alone, and the copy's leak with neither).
    function _forgedToBase(CcipBaseAdapter target, uint256 seed, uint256 amountSeed, uint256 tokenSeed) internal {
        Seen memory before = _see();
        uint256 snap = vm.snapshotState();
        _readLogs();
        Forged memory f = _forgedPayouts(seed, amountSeed, tokenSeed);
        if (f.carried != 0) taoBase.mint(address(target), f.carried);
        Client.Any2EVMMessage memory m = _forgedMessage(target, f, bitSelector, seed);
        if (!keepActorModeOnBase) recipient.setMode(ReentrantRecipient.Mode.Off, address(0), "", false);
        vm.prank(address(routerBase));
        bool landed;
        try target.ccipReceive(m) {
            landed = true;
        } catch {}
        _dropLogs();
        (bool leak, uint256 burns, bool swept) = _checkForged(before, f, false);
        vm.revertToState(snap);
        _countForged(landed, leak, burns, f.copy, swept, "forgedToBase");
    }

    function _countForged(bool landed, bool leak, uint256 burns, bool copy, bool swept, bytes32 tag) internal {
        ++forgedCalls;
        if (copy) ++forgedCopies;
        if (swept) ++forgedSweeps;
        if (landed) ++forgedLanded;
        else ++forgedRefused;
        forgedRedeemBurns += burns;
        if (leak) {
            ++forgedLeaks;
            lastForgedLeak = tag;
        }
    }

    /// The forged call's amount: 0, 1 rao, 0.001 TAO, the booked cushion, the cushion and a rao, a park's amount, all the
    /// token parks, or the whole balance and a TAO; and the tokens it carries: none, half, the amount, or more.
    function _forgedAmounts(uint256 amountSeed, uint256 tokenSeed, uint256 balance)
        internal
        view
        returns (uint256 amount, uint256 carried)
    {
        uint256 cushion = adapterBit.tokenCushion();
        uint256 k = amountSeed % 8;
        if (k == 0) {
            amount = 0;
        } else if (k == 1) {
            amount = RAO;
        } else if (k == 2) {
            amount = 1e15;
        } else if (k == 3) {
            amount = cushion;
        } else if (k == 4) {
            amount = cushion + RAO;
        } else if (k == 5) {
            amount = _parkKeys.length == 0 ? RAO : _parks[_parkKeys[(amountSeed >> 3) % _parkKeys.length]].amount;
        } else if (k == 6) {
            amount = adapterBit.parkedTokens();
        } else {
            amount = balance + 1e18;
        }
        amount -= amount % RAO;
        uint256 t = tokenSeed % 4;
        carried = t == 0 ? 0 : t == 1 ? (amount / 2) - (amount / 2) % RAO : t == 2 ? amount : amount + 1e15;
    }

    /// A forged BATCH toward Bittensor (see _forgedToBittensor).
    function _forgedBatch(CcipBittensorAdapter target, uint256 seed, uint256 amountSeed, uint256 tokenSeed)
        internal
        view
        returns (Forged memory f)
    {
        (f.amount, f.carried) = _forgedAmounts(amountSeed, tokenSeed, taoBit.balanceOf(address(target)));
        f.token = (tokenSeed >> 4) % 8 == 0 ? address(taoBase) : address(taoBit);
        uint256 r = (seed >> 3) % 3;
        f.to = r == 0
            ? address(vault)
            : r == 1 ? address(recipient) : address(uint160(uint256(keccak256("adapter campaign: no code"))));
        uint256 s = (seed >> 5) % 3;
        f.from = s == 0 ? address(fd) : s == 1 ? anyone : address(recipient);
        uint256 kind = (seed >> 7) % 5;
        // the dedicated draws' shapes (Task 42): F-2's, carrying nothing from the door to the vault, a redeem-only batch
        // naming every holder; the sweep's, carrying nothing to the recipient actor, a fresh batch for a stranger
        if (_shape != Shape.Drawn) {
            (f.amount, f.carried, f.token) = (0, 0, address(taoBit));
            bool f2 = _shape == Shape.RedeemOnly;
            (f.to, f.from, kind) = f2 ? (address(vault), address(fd), 1) : (address(recipient), anyone, 0);
        }
        CascadeMessages.Entry[] memory none = new CascadeMessages.Entry[](0);
        if (kind == 0) {
            CascadeMessages.Entry[] memory d = new CascadeMessages.Entry[](1);
            d[0] = CascadeMessages.Entry(anyone, f.amount);
            f.message = CascadeMessages.encodeBatch(uint64(uint256(keccak256(abi.encode(seed)))), d, none);
            f.named = new address[](0);
        } else if (kind == 1) {
            CascadeMessages.Entry[] memory q = new CascadeMessages.Entry[](ACTORS);
            f.named = new address[](ACTORS);
            for (uint256 i; i < ACTORS; ++i) {
                q[i] = CascadeMessages.Entry(actors[i], type(uint128).max);
                f.named[i] = actors[i];
            }
            f.message = CascadeMessages.encodeBatch(uint64(uint256(keccak256(abi.encode(seed, 1)))), none, q);
        } else if (kind == 2 || kind == 3) {
            // a copy of an honest batch toward Bittensor: a delivered one (2) or one still parked (3), with its own amount
            // one draw in two, else the drawn one
            (bool found, uint256 i) = _honestBatch(kind == 2 ? State.Delivered : State.ParkedTokens, seed >> 10);
            if (!found) (found, i) = _honestBatch(State.ParkedNative, seed >> 10);
            if (found) {
                f.copy = true;
                f.message = _body[i];
                f.to = _msgs[i].recipient;
                f.from = _msgs[i].sender;
                if ((seed >> 11) % 2 == 0) {
                    f.amount = _msgs[i].amount;
                    f.carried = (tokenSeed % 4) == 0 ? 0 : f.amount;
                }
                (,, CascadeMessages.Entry[] memory redeems) = CascadeMessages.decodeBatch(f.message);
                f.named = new address[](redeems.length);
                for (uint256 j; j < redeems.length; ++j) {
                    f.named[j] = redeems[j].user;
                }
            } else {
                f.message = CascadeMessages.encodeBatch(1, none, none);
                f.named = new address[](0);
            }
        } else {
            CascadeMessages.Entry[] memory p = new CascadeMessages.Entry[](1);
            p[0] = CascadeMessages.Entry(anyone, f.amount);
            f.message = CascadeMessages.encodePayouts(keccak256(abi.encode(seed)), 0, p);
            f.named = new address[](0);
        }
    }

    /// A forged PAYOUTS toward Base (see _forgedToBase).
    function _forgedPayouts(uint256 seed, uint256 amountSeed, uint256 tokenSeed)
        internal
        view
        returns (Forged memory f)
    {
        (f.amount, f.carried) = _forgedAmounts(amountSeed, tokenSeed, taoBase.balanceOf(address(fd)));
        f.token = (tokenSeed >> 4) % 8 == 0 ? address(taoBit) : address(taoBase);
        f.to = (seed >> 3) % 4 == 0 ? anyone : address(fd);
        f.from = (seed >> 5) % 4 == 0 ? anyone : address(vault);
        uint256 kind = (seed >> 7) % 5;
        if (kind == 1 || kind == 2) {
            (bool found, uint256 i) = _honestToBase(kind == 1 ? Kind.Payout : Kind.Refund, seed >> 10);
            if (found) {
                f.copy = true;
                f.message = _body[i];
                f.to = _msgs[i].recipient;
                f.from = _msgs[i].sender;
                if ((seed >> 11) % 2 == 0) {
                    f.amount = _msgs[i].amount;
                    f.carried = (tokenSeed % 4) == 0 ? 0 : f.amount;
                }
                (,, CascadeMessages.Entry[] memory payouts) = CascadeMessages.decodePayouts(f.message);
                f.named = new address[](payouts.length);
                for (uint256 j; j < payouts.length; ++j) {
                    f.named[j] = payouts[j].user;
                }
                return f;
            }
        }
        if (kind == 4) {
            CascadeMessages.Entry[] memory d = new CascadeMessages.Entry[](1);
            d[0] = CascadeMessages.Entry(anyone, f.amount);
            f.message = CascadeMessages.encodeBatch(1, d, new CascadeMessages.Entry[](0));
            f.named = new address[](0);
            return f;
        }
        // a PAYOUTS of the drawn amount, to a stranger (one draw in two) or split over the holders, under a made-up key, a
        // REFUND_CHUNK one under kind 3
        bool toStranger = (seed >> 12) % 2 == 0;
        uint256 n = toStranger ? 1 : ACTORS;
        CascadeMessages.Entry[] memory p = new CascadeMessages.Entry[](n);
        f.named = new address[](n);
        uint256 each = (f.amount / n) - (f.amount / n) % RAO;
        for (uint256 j; j < n; ++j) {
            address user = toStranger ? anyone : actors[j];
            p[j] = CascadeMessages.Entry(user, j == n - 1 ? f.amount - each * (n - 1) : each);
            f.named[j] = user;
        }
        uint32 chunk = kind == 3 ? type(uint32).max : 0;
        f.message = CascadeMessages.encodePayouts(keccak256(abi.encode(seed, 2)), chunk, p);
    }

    /// The CCIP message a compromised router hands `target`: from its own paired adapter on `selector` (every check
    /// ccipReceive makes passes), with the forged payload and token amount.
    function _forgedMessage(CcipAdapterBase target, Forged memory f, uint64 selector, uint256 seed)
        internal
        view
        returns (Client.Any2EVMMessage memory m)
    {
        Client.EVMTokenAmount[] memory t = new Client.EVMTokenAmount[](f.amount == 0 ? 0 : 1);
        if (f.amount != 0) t[0] = Client.EVMTokenAmount(f.token, f.amount);
        m = Client.Any2EVMMessage({
            messageId: keccak256(abi.encode("forged", seed)),
            sourceChainSelector: selector,
            sender: abi.encode(target.remoteAdapter()),
            data: target.encodePayload(f.to, f.from, f.message),
            destTokenAmounts: t
        });
    }

    /// The `n`-th (mod their count) message toward Bittensor in state `st`, if any.
    function _honestBatch(State st, uint256 n) internal view returns (bool found, uint256 i) {
        uint256 count;
        for (uint256 k; k < _toBittensor.length; ++k) {
            if (_msgs[_toBittensor[k]].state == st) ++count;
        }
        if (count == 0) return (false, 0);
        uint256 want = n % count;
        for (uint256 k; k < _toBittensor.length; ++k) {
            if (_msgs[_toBittensor[k]].state != st) continue;
            if (want == 0) return (true, _toBittensor[k]);
            --want;
        }
    }

    /// The `n`-th (mod their count) message toward Base of `kind`, if any.
    function _honestToBase(Kind kind, uint256 n) internal view returns (bool found, uint256 i) {
        uint256 count;
        for (uint256 k; k < _toBase.length; ++k) {
            if (_msgs[_toBase[k]].kind == kind) ++count;
        }
        if (count == 0) return (false, 0);
        uint256 want = n % count;
        for (uint256 k; k < _toBase.length; ++k) {
            if (_msgs[_toBase[k]].kind != kind) continue;
            if (want == 0) return (true, _toBase[k]);
            --want;
        }
    }

    /// The accounts whose shares and credits a forged call must not move: the holders, the recipient actor, anyone.
    function _forgedAccounts() internal view returns (address[] memory a) {
        a = new address[](ACTORS + 2);
        for (uint256 i; i < ACTORS; ++i) {
            a[i] = actors[i];
        }
        a[ACTORS] = address(recipient);
        a[ACTORS + 1] = anyone;
    }

    function _see() internal view returns (Seen memory s) {
        s.parkedNative = adapterBit.parkedNative();
        s.parkedTokens = adapterBit.parkedTokens();
        s.cushion = adapterBit.tokenCushion();
        s.native = address(adapterBit).balance;
        s.tokens = taoBit.balanceOf(address(adapterBit));
        s.pending = vaultLens.pendingPayouts();
        s.price = vaultLens.price();
        s.parks = new bytes32[](_batchKeys.length);
        for (uint256 k; k < _batchKeys.length; ++k) {
            (uint128 amt, uint64 at0, bool c) = adapterBit.parked(_batchKeys[k]);
            s.parks[k] = keccak256(abi.encode(amt, at0, c));
        }
        s.queued = new bytes32[](queuedKeys.length);
        for (uint256 k; k < queuedKeys.length; ++k) {
            s.queued[k] = keccak256(abi.encode(vaultLens.getPayoutBatch(queuedKeys[k])));
        }
        address[] memory a = _forgedAccounts();
        s.shares = new uint256[](a.length);
        s.claimable = new uint256[](a.length);
        for (uint256 i; i < a.length; ++i) {
            s.shares[i] = vault.balanceOf(a[i]);
            s.claimable[i] = fd.claimable(a[i]);
        }
        (,, s.openDeposits, s.feePot,,) = fd.openBatch();
        s.feeCredit = fd.totalFeeCredit();
        s.doorTokens = taoBase.balanceOf(address(fd));
        s.claimableTotal = fd.totalClaimable();
        s.treasuryNative = adapterTreasury.balance;
        s.treasuryTokens = taoBit.balanceOf(adapterTreasury);
    }

    /// After a forged call, against `b`, what it read before (the review's assertions): every park the honest runs left
    /// is as it was, but the forged message's own key, new, may hold its own amount, at most what it carried and the
    /// surplus above the parks and the cushion; the booked cushion is as it was, and the token balance still covers the
    /// parks and the cushion (I-7 with the cushion: no forged amount takes either); the native reserve fell by at most
    /// the 1 rao a short conversion may take from it and what the sweep moved to the treasury, which may take each
    /// kind's surplus and nothing more (the R4 review); every queued payout batch is as it was and the reservation grew
    /// by at most what the call itself delivered and the named holders' burned value; the share price did not fall; no
    /// holder lost shares unless the message asked to redeem them (F-2, counted apart, never a leak); and on Base no
    /// credit moved but the named users', by at most the tokens carried, the open batch, the fee pot and the credits are
    /// as they were, and the door holds its books.
    function _checkForged(Seen memory b, Forged memory f, bool toBittensor)
        internal
        view
        returns (bool leak, uint256 burns, bool swept)
    {
        Seen memory a = _see();
        uint256 surplusBefore = _sub0(b.tokens, b.parkedTokens + b.cushion);
        // surplus may move to the immutable treasury (the permissionless sweep the recipient actor can set off), and
        // nothing else (the R4 review, Important 1a): the treasury's gain of each kind is at most that kind's surplus
        // before, and the native books may fall by that gain
        uint256 nativeSwept = a.treasuryNative - Math.min(a.treasuryNative, b.treasuryNative);
        if (nativeSwept > _sub0(b.native, b.parkedNative + adapterBit.RESERVE_TARGET())) leak = true;
        uint256 tokensSwept = a.treasuryTokens - Math.min(a.treasuryTokens, b.treasuryTokens);
        if (tokensSwept > surplusBefore) leak = true;
        swept = nativeSwept != 0 || tokensSwept != 0;
        for (uint256 k; k < b.parks.length; ++k) {
            if (a.parks[k] == b.parks[k]) continue;
            // only a record that was empty may change, and only to the forged call's own park
            if (b.parks[k] != keccak256(abi.encode(uint128(0), uint64(0), false))) leak = true;
            (uint128 amt,,) = adapterBit.parked(_batchKeys[k]);
            if (amt > f.carried + surplusBefore) leak = true;
        }
        if (a.cushion != b.cushion) leak = true;
        if (a.tokens < a.parkedTokens + a.cushion) leak = true;
        if (a.parkedTokens > b.parkedTokens + f.carried + surplusBefore) leak = true;
        if (
            a.native < a.parkedNative
                || a.native - a.parkedNative + adapterBit.SHORTFALL_TOLERANCE_WEI() + nativeSwept
                    < b.native - b.parkedNative
        ) {
            leak = true;
        }
        for (uint256 k; k < b.queued.length; ++k) {
            if (a.queued[k] != b.queued[k]) leak = true;
        }
        if (a.price < b.price) leak = true;
        address[] memory acc = _forgedAccounts();
        // F-2, the stated residual, excluded as its text says (the R4 review, Important 1b): a forged redeem's burn of
        // the holders it names queues their value, at most the burned shares at the price before (rounded up)
        uint256 burnedValue;
        for (uint256 i; i < acc.length; ++i) {
            bool named = _named(f, acc[i]);
            if (a.shares[i] < b.shares[i]) {
                if (toBittensor && named) {
                    ++burns;
                    burnedValue += Math.mulDiv(b.shares[i] - a.shares[i], b.price + 1, 1e18, Math.Rounding.Ceil);
                } else {
                    leak = true;
                }
            }
            if (a.claimable[i] != b.claimable[i] && !(named && !toBittensor)) leak = true;
        }
        if (a.pending > b.pending + f.carried + surplusBefore + burnedValue) leak = true;
        if (!toBittensor) {
            uint256 credited;
            for (uint256 i; i < acc.length; ++i) {
                credited += a.claimable[i] - Math.min(a.claimable[i], b.claimable[i]);
            }
            if (credited > f.carried + _sub0(b.doorTokens, b.openDeposits + b.claimableTotal)) leak = true;
        }
        if (a.openDeposits != b.openDeposits || a.feePot != b.feePot || a.feeCredit != b.feeCredit) leak = true;
        if (a.doorTokens < a.openDeposits + a.claimableTotal) leak = true;
    }

    function _named(Forged memory f, address who) internal pure returns (bool) {
        for (uint256 i; i < f.named.length; ++i) {
            if (f.named[i] == who) return true;
        }
        return false;
    }

    // ==== the predictions ====

    /// What delivering batch `i` does now (spec §3.2's four steps): a duplicate of a live park fails AlreadyParked; a
    /// batch with tokens converts first (_conversionRefusal: its refusal parks the tokens); then the recipient: the
    /// vault refuses while paused (EnforcedPause), for a sender that is not its active door (UnknownPeer), while stake
    /// is missing (StakeMissing) and at a supply of 0 underwater (VaultInsolvent), each parking native; the recipient
    /// actor as its mode says (_actorOutcome).
    function _predictDelivery(uint256 i) internal view returns (Outcome, bytes4) {
        Msg storage m = _msgs[i];
        if (_parks[m.parkKey].live) return (Outcome.Fail, CcipBittensorAdapter.AlreadyParked.selector);
        if (m.amount != 0) {
            bytes4 conv = _conversionRefusal(m.amount);
            if (conv != 0) return (Outcome.ParkTokens, conv);
        }
        return _recipientOutcome(m.recipient, m.sender);
    }

    /// What deliverParked of `key` does now: NotParked without a record; a token park converts first, its refusal the
    /// call's; then the recipient, whose refusal re-parks it converted (ParkNative) and whose held-lock refusal
    /// reverts the call (Fail).
    function _predictDeliverParked(bytes32 key) internal view returns (Outcome, bytes4) {
        Park storage p = _parks[key];
        if (!p.live) return (Outcome.Fail, CcipBittensorAdapter.NotParked.selector);
        if (!p.converted && p.amount != 0) {
            bytes4 conv = _conversionRefusal(p.amount);
            if (conv != 0) return (Outcome.Fail, conv);
        }
        Msg storage m = _msgs[p.msgIndex];
        return _recipientOutcome(m.recipient, m.sender);
    }

    function _recipientOutcome(address to, address from) internal view returns (Outcome, bytes4) {
        if (to == address(recipient)) return _actorOutcome();
        // the live adapter disabled on the vault (the exits campaign's scenario; this campaign never disables it): the
        // vault takes deliveries from enabled bridges only
        if (!vaultLens.bridgeEnabled(address(adapterBit))) return (Outcome.ParkNative, NotBridge.selector);
        if (vault.paused()) return (Outcome.ParkNative, Pausable.EnforcedPause.selector);
        if (from != address(fd)) return (Outcome.ParkNative, UnknownPeer.selector);
        // a door the vault no longer has active (the exits campaign's removals; this campaign never removes one)
        if (vaultLens.doorState(vaultLens.peerId(baseChain, address(fd))) != DoorState.Active) {
            return (Outcome.ParkNative, UnknownPeer.selector);
        }
        if (_missingAt(_visible(), vaultLens.bookedStake())) return (Outcome.ParkNative, StakeMissing.selector);
        if (vault.totalSupply() == 0 && _underwater()) return (Outcome.ParkNative, VaultInsolvent.selector);
        return (Outcome.Deliver, bytes4(0));
    }

    /// The recipient actor's answer, by its mode: refusing parks native (Refused); re-entering then reverting parks
    /// native (Refused) or, bubbling the adapter's lock refusal, fails the whole call with it (a re-entry through the
    /// router returns, its FAILURE in its return data, so there is nothing to bubble: Refused); any other mode
    /// accepts.
    function _actorOutcome() internal view returns (Outcome, bytes4) {
        if (recipient.refusing()) return (Outcome.ParkNative, ReentrantRecipient.Refused.selector);
        if (recipient.mode() == ReentrantRecipient.Mode.ReenterThenRevert) {
            if (recipient.bubble() && _reentry != Reentry.Router) {
                return (Outcome.Fail, ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
            }
            return (Outcome.ParkNative, ReentrantRecipient.Refused.selector);
        }
        return (Outcome.Deliver, bytes4(0));
    }

    /// convertExact's refusal for `amount` now, restated from ForeverMoney's and the adapter's rules (never the
    /// adapter's own verdict): the floor (`BelowConversionFloor`, the adapter's first check), ForeverMoney's halt
    /// (`IsHalted`), the position gone after a migration (`Insolvent`), its measured TAO more than 1 rao short
    /// (`Slippage`), then the adapter's: a shortfall the native reserve above the ghost's native parks cannot cover
    /// (`ConversionShort`).
    function _conversionRefusal(uint256 amount) internal view returns (bytes4) {
        if (amount < staking.getDefaultMinStake() * RAO) return CcipAdapterBase.BelowConversionFloor.selector;
        if (av.isPaused()) return MockAlphaVault.IsHalted.selector;
        if (amount / RAO > av.stakedValueRao(address(taoBit))) return MockAlphaVault.Insolvent.selector;
        uint256 short = av.shortBy();
        uint256 over = av.overpay();
        if (short > over + adapterBit.SHORTFALL_TOLERANCE_WEI()) return MockAlphaVault.Slippage.selector;
        if (short > over && _sub0(address(adapterBit).balance, ghostParkedNative) < short - over) {
            return CcipAdapterBase.ConversionShort.selector;
        }
        return 0;
    }

    /// _collect's refusal for `amount` now (a payout's send or a converted refund), restated: ForeverMoney's halt and
    /// migration gates (`IsHalted`, `MigrationInProgress`), the precompile's minimum stake (`BelowMinStake`: a refund
    /// skips the adapter's floor), its measured stake more than 1 rao short (`Slippage`), then the adapter's: a
    /// shortfall the booked token cushion cannot cover (`ConversionShort`; R4 F-1: never the surplus or a park).
    function _collectRefusal(uint256 amount) internal view returns (bytes4) {
        if (av.isPaused()) return MockAlphaVault.IsHalted.selector;
        if (av.migrationReadyAt() != 0 || av.migrationFinished()) return MockAlphaVault.MigrationInProgress.selector;
        if (amount / RAO < staking.getDefaultMinStake()) return MockStaking.BelowMinStake.selector;
        uint256 short = av.shortBy();
        uint256 over = av.overmint();
        if (short > over + adapterBit.SHORTFALL_TOLERANCE_WEI()) return MockAlphaVault.Slippage.selector;
        if (short > over && adapterBit.tokenCushion() < short - over) {
            return CcipAdapterBase.ConversionShort.selector;
        }
        return 0;
    }

    /// refundParked's refusal for `key` at `value` (`quote` the fee): NotParked, NothingToRefund, ParkedTooYoung, then
    /// a converted park's conversion back (_collectRefusal), then InsufficientFee below the quote.
    function _predictRefund(bytes32 key, uint256 value, uint256 quote) internal view returns (bytes4) {
        Park storage p = _parks[key];
        if (!p.live) return CcipBittensorAdapter.NotParked.selector;
        if (p.amount == 0) return CcipBittensorAdapter.NothingToRefund.selector;
        if (vm.getBlockTimestamp() < uint256(p.parkedAt) + adapterBit.PARK_TIMEOUT()) {
            return CcipBittensorAdapter.ParkedTooYoung.selector;
        }
        if (p.converted) {
            bytes4 rail = _collectRefusal(p.amount);
            if (rail != 0) return rail;
        }
        if (value < quote) return CcipAdapterBase.InsufficientFee.selector;
        return 0;
    }

    /// processPayouts' refusal for the batch `b` (list `list`) now: EnforcedPause; the chunk's gross below the
    /// conversion floor (the quote's check); VaultModel's _chunkOutcome; nothing more when nothing is sent; the net
    /// below the floor (the send's check); then the send's conversion (_collectRefusal).
    function _payoutRefusal(CascadeMessages.Payout[] memory list, PayoutBatch memory b) internal view returns (bytes4) {
        if (vault.paused()) return Pausable.EnforcedPause.selector;
        uint256 floor_ = staking.getDefaultMinStake() * RAO;
        uint256 limit = Math.min(Math.max(CHUNK_ENTRIES, vaultLens.minChunk()), CascadeMessages.MAX_ENTRIES);
        (, uint256 sum) = _takeChunk(list, b.cursor, limit, vaultLens.maxMessageValue(), vaultLens.minChunk());
        if (sum < floor_) return CcipAdapterBase.BelowConversionFloor.selector;
        ChunkOut memory o = _chunkOutcome(list, b, CHUNK_ENTRIES, routerBit.fee(), 0);
        if (o.refusal != 0) return o.refusal;
        if (o.net == 0) return 0;
        if (o.net < floor_) return CcipAdapterBase.BelowConversionFloor.selector;
        return _collectRefusal(o.net);
    }

    // ==== I-10: the liveness probe ====

    /// For every live park past PARK_TIMEOUT, each attempt inside a snapshot (its logs dropped, the state reverted):
    /// a stranger's refundParked with the quoted fee (an amount), or dropParked (an empty one), must succeed; a
    /// converted park's refund may refuse only with the error _collectRefusal names for the rail's state now. A
    /// converted park to the vault, aged or not, must be delivered by deliverParked whenever the vault accepts
    /// (_recipientOutcome).
    function _probeLiveness() internal {
        uint256 n = _parkKeys.length;
        for (uint256 k; k < n; ++k) {
            bytes32 key = _parkKeys[k];
            Park memory p = _parks[key];
            if (!p.live) continue;
            Msg memory m = _msgs[p.msgIndex];
            bytes memory body = _body[p.msgIndex];
            if (vm.getBlockTimestamp() >= uint256(p.parkedAt) + adapterBit.PARK_TIMEOUT()) {
                if (p.amount == 0) _probeDrop(key, m, body);
                else _probeRefund(key, p, m, body);
            }
            if (p.converted && m.recipient == address(vault)) {
                (Outcome o,) = _recipientOutcome(m.recipient, m.sender);
                if (o == Outcome.Deliver) _probeDelivery(key, m, body);
            }
        }
    }

    function _probeRefund(bytes32 key, Park memory p, Msg memory m, bytes memory body) internal {
        bytes4 allowed = p.converted ? _collectRefusal(p.amount) : bytes4(0);
        (bool quoted, uint256 quote, bytes4 why) = _quoteRefund(m, body);
        if (!quoted) {
            // a live park with an amount that cannot even be quoted cannot be refunded at the quoted fee
            ++refundsProbed;
            ++refundLivenessFailures;
            lastLivenessRefusal = why;
            return;
        }
        _readLogs();
        uint256 snap = vm.snapshotState();
        vm.deal(anyone, anyone.balance + quote);
        vm.prank(anyone);
        (bool ok, bytes memory reason) = address(adapterBit).call{value: quote}(
            abi.encodeCall(CcipBittensorAdapter.refundParked, (m.recipient, m.sender, body))
        );
        bool gone = _parked(key).parkedAt == 0;
        vm.revertToStateAndDelete(snap);
        _dropLogs();
        ++refundsProbed;
        if (ok && gone && allowed == 0) {
            ++refundsLive;
        } else if (!ok && allowed != 0 && _selector(reason) == allowed) {
            if (allowed == MockAlphaVault.IsHalted.selector) ++probeRefusedHalted;
            else if (allowed == MockAlphaVault.MigrationInProgress.selector) ++probeRefusedMigrating;
            else if (allowed == MockStaking.BelowMinStake.selector) ++probeRefusedFloor;
            else if (allowed == MockAlphaVault.Slippage.selector) ++probeRefusedSlippage;
            else ++probeRefusedCushion;
        } else {
            ++refundLivenessFailures;
            lastLivenessRefusal = ok ? bytes4(0xffffffff) : _selector(reason);
        }
    }

    function _probeDrop(bytes32 key, Msg memory m, bytes memory body) internal {
        _readLogs();
        uint256 snap = vm.snapshotState();
        vm.prank(anyone);
        (bool ok, bytes memory reason) =
            address(adapterBit).call(abi.encodeCall(CcipBittensorAdapter.dropParked, (m.recipient, m.sender, body)));
        bool gone = _parked(key).parkedAt == 0;
        vm.revertToStateAndDelete(snap);
        _dropLogs();
        ++dropsProbed;
        if (!ok || !gone) {
            ++dropLivenessFailures;
            lastLivenessRefusal = _selector(reason);
        }
    }

    function _probeDelivery(bytes32 key, Msg memory m, bytes memory body) internal {
        _readLogs();
        uint256 snap = vm.snapshotState();
        vm.prank(anyone);
        (bool ok, bytes memory reason) =
            address(adapterBit).call(abi.encodeCall(CcipBittensorAdapter.deliverParked, (m.recipient, m.sender, body)));
        bool gone = _parked(key).parkedAt == 0;
        vm.revertToStateAndDelete(snap);
        _dropLogs();
        ++deliveriesProbed;
        if (!ok || !gone) {
            ++deliveryLivenessFailures;
            lastLivenessRefusal = ok ? bytes4(0xfffffffe) : _selector(reason);
        }
    }

    // ==== I-11: the re-entrant recipient actor ====

    /// Draws the recipient actor's behaviour for a call that reaches it with its batch `i`, from `modeSeed` mod 8: it
    /// accepts (0, 1); refuses (2); accepts after re-entering (3, RevertThenReenter not refusing); re-enters then
    /// refuses (4) or bubbles the lock's refusal (5, ReenterThenRevert); re-enters at two levels and accepts (6); or
    /// refuses in RevertThenReenter (7: it re-enters once a later delivery pays it). The re-entry (`modeSeed` >> 3 mod
    /// 6, _reentryCall) is a park function, the sweep, or another pending batch executed through the router: each one
    /// the lock refuses.
    function _setActorMode(uint256 modeSeed, uint256 i) internal {
        uint256 kind = modeSeed % 8;
        ReentrantRecipient.Mode mode = ReentrantRecipient.Mode.Off;
        bool bubble;
        bool refusing = kind == 2 || kind == 7;
        if (kind == 3 || kind == 7) mode = ReentrantRecipient.Mode.RevertThenReenter;
        else if (kind == 4 || kind == 5) mode = ReentrantRecipient.Mode.ReenterThenRevert;
        else if (kind == 6) mode = ReentrantRecipient.Mode.TwoLevel;
        if (kind == 5) bubble = true;
        (address target, bytes memory reentry) = _reentryCall((modeSeed >> 3) % 6, i);
        recipient.setMode(mode, target, reentry, bubble);
        recipient.setSecondLevel(address(adapterBit), abi.encodeCall(CcipBittensorAdapter.sweepSurplus, ()));
        recipient.setRefusing(refusing);
    }

    /// The re-entry's target and calldata, by `kind`, its class recorded (`_reentry`, by the key it names, so a
    /// fallback to the actor's own batch counts as its own): deliverParked of the actor's own batch `i` (0), or of
    /// another live park (1), refundParked (2) or dropParked (3) of another live park (its own when none),
    /// sweepSurplus (4), or (5) the router's delivery of another batch toward Bittensor in flight or failed (a manual
    /// execution from inside this one, README note 22), which reaches the adapter's ccipReceive and its lock: a
    /// FAILURE of that batch that writes nothing (the sweep when no other batch is pending).
    function _reentryCall(uint256 kind, uint256 i) internal returns (address, bytes memory) {
        if (kind == 5) {
            (bool found, uint256 pending) = _pendingOther(i);
            if (found) {
                _reentry = Reentry.Router;
                _reentryInner = pending;
                return (address(routerBit), _routerDelivery(pending));
            }
            kind = 4;
        }
        if (kind == 4) {
            _reentry = Reentry.Sweep;
            return (address(adapterBit), abi.encodeCall(CcipBittensorAdapter.sweepSurplus, ()));
        }
        uint256 j = kind == 0 ? i : _anotherPark(i);
        _reentry = _msgs[j].parkKey == _msgs[i].parkKey ? Reentry.OwnKey : Reentry.OtherKey;
        bytes4 sel = kind == 2
            ? CcipBittensorAdapter.refundParked.selector
            : kind == 3 ? CcipBittensorAdapter.dropParked.selector : CcipBittensorAdapter.deliverParked.selector;
        return (address(adapterBit), abi.encodeWithSelector(sel, _msgs[j].recipient, _msgs[j].sender, _body[j]));
    }

    /// The first batch toward Bittensor in flight or failed other than `i`.
    function _pendingOther(uint256 i) internal view returns (bool, uint256) {
        for (uint256 k; k < _toBittensor.length; ++k) {
            uint256 j = _toBittensor[k];
            State s = _msgs[j].state;
            if (j != i && (s == State.InFlight || s == State.Failed)) return (true, j);
        }
        return (false, 0);
    }

    /// Bittensor's router delivering batch `j` to the adapter as relayMessage does (its send's message id, the Base
    /// adapter as its sender, its tokens on this side, its gas limit), as calldata for the actor's re-entry.
    function _routerDelivery(uint256 j) internal view returns (bytes memory) {
        MockRouter.Sent memory s = routerBase.sendAt(_msgs[j].sendIndex);
        Client.EVMTokenAmount[] memory t = new Client.EVMTokenAmount[](s.tokenAmounts.length);
        for (uint256 k; k < t.length; ++k) {
            t[k] = Client.EVMTokenAmount(address(routerBit.token()), s.tokenAmounts[k].amount);
        }
        Client.Any2EVMMessage memory m =
            Client.Any2EVMMessage(s.messageId, baseSelector, abi.encode(address(adapterBase)), s.data, t);
        return abi.encodeCall(MockRouter.deliver, (address(adapterBit), m, routerBit.gasLimitOf(s.extraArgs)));
    }

    /// The message of a live park other than message `i`'s, or `i` when there is none.
    function _anotherPark(uint256 i) internal view returns (uint256) {
        for (uint256 k; k < _parkKeys.length; ++k) {
            Park storage q = _parks[_parkKeys[k]];
            if (q.live && q.msgIndex != i) return q.msgIndex;
        }
        return i;
    }

    /// Whether `logs` hold a park event of the Bittensor adapter for another key than `own`, or a sweep (I-11).
    function _foreignParkEvent(Vm.Log[] memory logs, bytes32 own) internal view returns (bool) {
        for (uint256 k; k < logs.length; ++k) {
            Vm.Log memory log = logs[k];
            if (log.emitter != address(adapterBit)) continue;
            bytes32 sig = log.topics[0];
            if (sig == CcipAdapterBase.SurplusSwept.selector) return true;
            if (
                (sig == CcipBittensorAdapter.BatchParked.selector
                        || sig == CcipBittensorAdapter.ParkedDelivered.selector
                        || sig == CcipBittensorAdapter.ParkedConverted.selector
                        || sig == CcipBittensorAdapter.ParkedRefunded.selector
                        || sig == CcipBittensorAdapter.ParkedDropped.selector) && log.topics[1] != own
            ) return true;
        }
        return false;
    }

    function _noLogs() internal pure returns (Vm.Log[] memory) {
        return new Vm.Log[](0);
    }

    /// The live parks other than `own`, before a call that reaches the recipient actor (I-11).
    function _othersBefore(bytes32 own) internal view returns (bytes32[] memory keys) {
        keys = new bytes32[](_parkKeys.length);
        uint256 n;
        for (uint256 k; k < _parkKeys.length; ++k) {
            bytes32 key = _parkKeys[k];
            if (key != own && _parks[key].live) keys[n++] = key;
        }
        assembly ("memory-safe") {
            mstore(keys, n)
        }
    }

    /// I-11 after a call that reached the recipient actor with its batch `i` (`paid`: the call delivered it to the
    /// actor; `logs`: the call's, none when it reverted): every other live park's record is still the ghost's (no
    /// re-entry moved it), the adapter's totals less the actor's own record are the ghost's less its own (compared as
    /// sums, so a broken adapter's totals cannot make the check itself revert), no park event names another key and
    /// nothing was swept, the actor's balance grew by exactly its batch when paid and not at all otherwise; and a
    /// re-entry it made and recorded (an accepted call keeps the record) was refused with ReentrancyGuardReentrantCall,
    /// a two-level one never reaching its second level, and one through the router returned that batch's FAILURE with
    /// the lock's refusal, the batch then failed (re-executable) in the ghost and its key holding no record.
    function _checkActorCall(uint256 i, bytes32[] memory others, uint256 balanceBefore, bool paid, Vm.Log[] memory logs)
        internal
    {
        ++recipientCalls;
        Msg storage m = _msgs[i];
        if (_foreignParkEvent(logs, m.parkKey)) ++reentrantDrains;
        for (uint256 k; k < others.length; ++k) {
            CcipBittensorAdapter.Parked memory a = _parked(others[k]);
            Park storage g = _parks[others[k]];
            if (a.amount != g.amount || a.parkedAt != g.parkedAt || a.converted != g.converted) ++reentrantDrains;
        }
        CcipBittensorAdapter.Parked memory own = _parked(m.parkKey);
        Park storage go = _parks[m.parkKey];
        uint256 ownNative = go.live && go.converted ? go.amount : 0;
        uint256 ownTokens = go.live && !go.converted ? go.amount : 0;
        uint256 adapterOwnNative = own.parkedAt != 0 && own.converted ? own.amount : 0;
        uint256 adapterOwnTokens = own.parkedAt != 0 && !own.converted ? own.amount : 0;
        if (
            adapterBit.parkedNative() + ownNative != ghostParkedNative + adapterOwnNative
                || adapterBit.parkedTokens() + ownTokens != ghostParkedTokens + adapterOwnTokens
        ) ++reentrantDrains;
        if (address(recipient).balance != balanceBefore + (paid ? m.amount : 0)) ++reentrantDrains;
        if (recipient.secondLevelReached()) ++reentriesThrough;
        ReentrantRecipient.Mode mode = recipient.mode();
        bool reentered =
            paid && (mode == ReentrantRecipient.Mode.RevertThenReenter || mode == ReentrantRecipient.Mode.TwoLevel);
        if (!reentered) return;
        // the lock's refusal, as the adapter returns it to a park function or the sweep, or inside the router's
        // DeliveryFailed in a returned deliver's (called, ok, reason)
        bytes memory locked = abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        bool router = _reentry == Reentry.Router;
        if (router) {
            locked = abi.encode(true, false, abi.encodeWithSelector(MockRouter.DeliveryFailed.selector, locked));
        }
        if (recipient.reentryOk() != router || keccak256(recipient.reentryReturn()) != keccak256(locked)) {
            ++reentriesThrough;
            return;
        }
        ++reentriesRefused;
        if (_reentry == Reentry.OwnKey) {
            ++reentriesOwnKey;
        } else if (_reentry == Reentry.OtherKey) {
            ++reentriesOtherKey;
        } else if (_reentry == Reentry.Sweep) {
            ++reentriesSweep;
        } else {
            ++reentriesRouter;
            Msg storage inner = _msgs[_reentryInner];
            inner.state = State.Failed;
            if (_hasRecord(inner.parkKey) && !_parks[inner.parkKey].live) ++reentrantDrains;
        }
    }

    // ==== the ghost map's moves ====

    /// A batch sent toward Bittensor as router `routerBase`'s send `sendIndex`: recorded in flight, its park key and
    /// (a door's) the vault's batch key by their formulas, and checked against the payload the router took.
    function _recordBatch(Kind kind, uint256 sendIndex, address to, address from, uint256 amount, bytes memory message)
        internal
        returns (uint256 i)
    {
        return _record(_newMsg(kind, sendIndex, to, from, amount), message);
    }

    function _newMsg(Kind kind, uint256 sendIndex, address to, address from, uint256 amount)
        internal
        pure
        returns (Msg memory m)
    {
        m.kind = kind;
        m.sendIndex = sendIndex;
        m.recipient = to;
        m.sender = from;
        m.amount = amount;
    }

    function _record(Msg memory m, bytes memory message) internal returns (uint256 i) {
        m.parkKey = keccak256(abi.encode(baseChain, m.sender, m.recipient, message));
        m.batchKey = keccak256(abi.encode(baseChain, m.sender, keccak256(message)));
        _checkSent(m, message);
        _msgs.push(m);
        i = _msgs.length - 1;
        _body[i] = message;
        _toBittensor.push(i);
        if (!_isBatchKey[m.parkKey]) {
            _isBatchKey[m.parkKey] = true;
            _batchKeys.push(m.parkKey);
        }
    }

    /// The router's send is exactly `m`'s payload (its recipient, its sender, `message`) carrying its amount.
    function _checkSent(Msg memory m, bytes memory message) internal {
        MockRouter.Sent memory s = routerBase.sendAt(m.sendIndex);
        bool tokensOk = m.amount == 0 ? s.tokenAmounts.length == 0 : s.tokenAmounts[0].amount == m.amount;
        bytes32 payload = keccak256(abi.encode(m.recipient, m.sender, message));
        if (keccak256(s.data) != payload || !tokensOk) ++batchContentMismatches;
    }

    /// Batch `i` parked (`converted` as native TAO, else as tokens), now: the ghost's record and total.
    function _park(uint256 i, bool converted) internal {
        Msg storage m = _msgs[i];
        // casting to 'uint128' and 'uint64' is safe because amounts are far below 2^128 and the clock below 2^64
        // forge-lint: disable-next-line(unsafe-typecast)
        _parks[m.parkKey] = Park(uint128(m.amount), uint64(vm.getBlockTimestamp()), converted, true, i);
        if (!_isParkKey[m.parkKey]) {
            _isParkKey[m.parkKey] = true;
            _parkKeys.push(m.parkKey);
        }
        if (converted) ghostParkedNative += m.amount;
        else ghostParkedTokens += m.amount;
        m.state = converted ? State.ParkedNative : State.ParkedTokens;
    }

    /// The park under `key` gone (delivered, refunded or dropped): its record and its total.
    function _unpark(bytes32 key) internal {
        Park storage p = _parks[key];
        if (p.converted) ghostParkedNative -= p.amount;
        else ghostParkedTokens -= p.amount;
        p.live = false;
    }

    /// Batch `i` delivered (by its relay or a deliverParked), its logs `logs`: to the vault, its BatchDelivered and
    /// each deposit minted or bounced exactly once (I-8), the payout list grown; to the recipient actor, one more
    /// delivery it accepted. A batch refunded before can never be delivered (I-8).
    function _delivered(uint256 i, Vm.Log[] memory logs, uint256 actorDeliveredBefore) internal {
        Msg storage m = _msgs[i];
        if (m.state == State.Refunded || m.state == State.Dropped || m.state == State.Delivered) {
            ++mintedAndRefunded;
        }
        m.state = State.Delivered;
        if (m.recipient == address(recipient)) {
            ++deliveredToRecipient;
            if (recipient.delivered() != actorDeliveredBefore + 1) ++lostOutcomes;
            return;
        }
        ++deliveredToVault;
        if (!_vaultDelivered(logs, m)) ++lostOutcomes;
        _recordVaultDelivery(i, logs);
    }

    /// Whether the vault logged batch `m`'s BatchDelivered among `logs`.
    function _vaultDelivered(Vm.Log[] memory logs, Msg memory m) internal view returns (bool) {
        for (uint256 k; k < logs.length; ++k) {
            if (_isVaultLog(logs[k], BatchDelivered.selector) && logs[k].topics[1] == m.batchKey) return true;
        }
        return false;
    }

    /// The vault's delivery of batch `i`: each of its deposits minted (Deposited) or bounced (DepositBounced) exactly
    /// once, with its amount, and no other; the payout list from the bounces and the burns, in order.
    function _recordVaultDelivery(uint256 i, Vm.Log[] memory logs) internal {
        Msg storage m = _msgs[i];
        CascadeMessages.Entry[] storage d = _depositsOf[i];
        uint256[] memory seen = new uint256[](d.length);
        for (uint256 k; k < logs.length; ++k) {
            Vm.Log memory log = logs[k];
            if (log.emitter != address(vault) || log.topics.length < 2 || log.topics[1] != m.batchKey) continue;
            bytes32 sig = log.topics[0];
            if (sig == Deposited.selector || sig == DepositBounced.selector) {
                address user = _topicAddress(log.topics[2]);
                uint256 assets = abi.decode(_firstWord(log.data), (uint256));
                bool matched;
                for (uint256 e; e < d.length; ++e) {
                    if (d[e].user == user && d[e].amount == assets && seen[e] == 0) {
                        seen[e] = 1;
                        matched = true;
                        break;
                    }
                }
                if (!matched) ++depositOutcomeMisses;
                ++mintsChecked;
                if (sig == DepositBounced.selector) _lists[m.batchKey].push(CascadeMessages.Payout(user, 0, assets));
            } else if (sig == Redeemed.selector) {
                (uint256 shares, uint256 assets) = abi.decode(log.data, (uint256, uint256));
                _lists[m.batchKey].push(CascadeMessages.Payout(_topicAddress(log.topics[2]), shares, assets));
            } else if (sig == PayoutBatchQueued.selector) {
                queuedKeys.push(m.batchKey);
            }
        }
        for (uint256 e; e < d.length; ++e) {
            if (seen[e] == 0) ++depositOutcomeMisses;
        }
        _afterVaultDelivery(i, logs);
    }

    /// A hook after each delivery of batch `i` to the vault (its logs `logs`), for a campaign built on this handler (the
    /// exits campaign, Task 42); nothing here.
    function _afterVaultDelivery(uint256 i, Vm.Log[] memory logs) internal virtual {}

    /// Park `key` refunded (the call went, its send router `routerBit`'s `sendIndex`): the ghost's record and total
    /// gone, the batch Refunded, and the refund's message checked (I-9): PAYOUTS(key, REFUND_CHUNK, the batch's
    /// deposits as the handler recorded them), from the park's recipient to its sender, carrying the park's amount. A
    /// batch the vault delivered can never be refunded (I-8). Returns whether the refund was sent (a refund that sent
    /// nothing counts as a wrong message) and its message toward Base.
    function _refunded(bytes32 key, uint256 sendIndex) internal returns (bool sent, uint256 i) {
        Park memory p = _parks[key];
        Msg storage m = _msgs[p.msgIndex];
        if (m.state == State.Delivered) ++mintedAndRefunded;
        if (p.converted) ++refundsConverted;
        else ++refundsUnconverted;
        _unpark(key);
        m.state = State.Refunded;
        if (routerBit.sendCount() <= sendIndex) {
            ++refundMessageMismatches;
            return (false, 0);
        }
        sent = true;
        MockRouter.Sent memory s = routerBit.sendAt(sendIndex);
        bytes memory refund = CascadeMessages.encodePayouts(key, adapterBit.REFUND_CHUNK(), _depositsOf[p.msgIndex]);
        bytes memory want = abi.encode(m.sender, m.recipient, refund);
        if (keccak256(s.data) != keccak256(want) || s.tokenAmounts.length != 1 || s.tokenAmounts[0].amount != p.amount)
        {
            ++refundMessageMismatches;
        }
        Msg memory r = _newMsg(Kind.Refund, sendIndex, m.sender, m.recipient, p.amount);
        r.parkKey = key;
        r.batchKey = key;
        r.origin = p.msgIndex;
        _msgs.push(r);
        i = _msgs.length - 1;
        // the refund's own message, which a forged copy replays (the R4 review, Important 1c)
        _body[i] = refund;
        _toBase.push(i);
    }

    /// A refund of batch `origin` delivered to the door (I-9): PayoutReceived(key, REFUND_CHUNK, user, amount) for each
    /// of the batch's deposits in order, exactly, and each depositor's credit up by exactly its deposits (`owed`
    /// before).
    function _checkRefundCredits(uint256 origin, Vm.Log[] memory logs, uint256[ACTORS] memory owed, bytes32 key)
        internal
    {
        CascadeMessages.Entry[] storage d = _depositsOf[origin];
        uint256 e;
        for (uint256 k; k < logs.length; ++k) {
            Vm.Log memory log = logs[k];
            if (log.emitter != address(fd) || log.topics[0] != CascadeFrontDoor.PayoutReceived.selector) continue;
            (uint32 chunk, uint256 amount) = abi.decode(log.data, (uint32, uint256));
            if (
                e >= d.length || log.topics[1] != key || chunk != adapterBit.REFUND_CHUNK()
                    || _topicAddress(log.topics[2]) != d[e].user || amount != d[e].amount
            ) ++refundMiscredits;
            ++e;
        }
        if (e != d.length) ++refundMiscredits;
        for (uint256 a; a < ACTORS; ++a) {
            uint256 sum;
            for (uint256 k; k < d.length; ++k) {
                if (d[k].user == actors[a]) sum += d[k].amount;
            }
            if (fd.claimable(actors[a]) != owed[a] + sum) ++refundMiscredits;
        }
    }

    /// Counts a park by its logged reason, and an empty one.
    function _countPark(uint256 amount, bytes4 reason) internal {
        if (amount == 0) ++parkedEmpty;
        if (reason == Pausable.EnforcedPause.selector) ++parkedPaused;
        else if (reason == StakeMissing.selector) ++parkedStakeMissing;
        else if (reason == UnknownPeer.selector) ++parkedUnknownPeer;
        else if (reason == ReentrantRecipient.Refused.selector) ++parkedRefused;
        else if (reason == CcipAdapterBase.BelowConversionFloor.selector) ++parkedBelowFloor;
        else if (reason == MockAlphaVault.IsHalted.selector) ++parkedHalted;
        else if (reason == MockAlphaVault.Insolvent.selector) ++parkedInsolvent;
        else if (reason == MockAlphaVault.Slippage.selector) ++parkedSlippage;
        else if (reason == CcipAdapterBase.ConversionShort.selector) ++parkedConversionShort;
    }

    // ==== I-7 and I-8 after every step ====

    /// The ghost against the views, after every step (and between a composite step's calls): the record under every
    /// key the handler has seen, one per batch toward Bittensor, delivered, refunded, dropped, in flight and failed
    /// ones included (a live ghost park's: its amount, parkedAt and converted; any other key's: none, so a delivered
    /// batch that also left a record fails here); each total against the sum of the ghost's records, its running total
    /// and the sum of the adapter's own records over every key seen; each balance at least what is owed (by the ghost
    /// and by the adapter); each batch's state against its record (a parked batch the record's message; a batch whose
    /// key holds no live ghost park, whatever its state, no record at the adapter: I-8, delivered and still parked is
    /// two states); each door batch's processed flag against Delivered; and the Base adapter holding no tokens.
    function _checkGhosts() internal {
        uint256 native;
        uint256 tokens;
        uint256 recordsNative;
        uint256 recordsTokens;
        for (uint256 k; k < _batchKeys.length; ++k) {
            bytes32 key = _batchKeys[k];
            Park storage g = _parks[key];
            CcipBittensorAdapter.Parked memory a = _parked(key);
            if (a.converted) recordsNative += a.amount;
            else recordsTokens += a.amount;
            if (g.live) {
                if (a.amount != g.amount || a.parkedAt != g.parkedAt || a.converted != g.converted || a.parkedAt == 0) {
                    ++recordMismatches;
                }
                if (g.converted) native += g.amount;
                else tokens += g.amount;
            } else if (a.parkedAt != 0 || a.amount != 0 || a.converted) {
                ++recordMismatches;
            }
        }
        if (
            native != ghostParkedNative || tokens != ghostParkedTokens || adapterBit.parkedNative() != native
                || adapterBit.parkedTokens() != tokens || adapterBit.parkedNative() != recordsNative
                || adapterBit.parkedTokens() != recordsTokens
        ) ++totalMismatches;
        if (
            address(adapterBit).balance < native || taoBit.balanceOf(address(adapterBit)) < tokens
                || address(adapterBit).balance < adapterBit.parkedNative()
                || taoBit.balanceOf(address(adapterBit)) < adapterBit.parkedTokens()
        ) ++owedShortfalls;
        for (uint256 k; k < _toBittensor.length; ++k) {
            uint256 i = _toBittensor[k];
            Msg storage m = _msgs[i];
            Park storage g = _parks[m.parkKey];
            bool parkedState = m.state == State.ParkedTokens || m.state == State.ParkedNative;
            bool mine = g.live && g.msgIndex == i;
            if (parkedState != mine || (mine && (m.state == State.ParkedNative) != g.converted)) ++stateMismatches;
            // per key: a duplicate shares its original's, so only a key with no live ghost park must hold no record
            if (!g.live && _hasRecord(m.parkKey)) ++stateMismatches;
            if (m.kind == Kind.DoorBatch && vaultLens.processed(m.batchKey) != (m.state == State.Delivered)) {
                ++processedMismatches;
            }
        }
        if (taoBase.balanceOf(address(adapterBase)) != 0) ++baseAdapterHeld;
    }

    // ==== reads ====

    function _parked(bytes32 key) internal view returns (CcipBittensorAdapter.Parked memory p) {
        (p.amount, p.parkedAt, p.converted) = adapterBit.parked(key);
    }

    /// Whether the adapter holds anything under `key` (any non-zero field).
    function _hasRecord(bytes32 key) internal view returns (bool) {
        CcipBittensorAdapter.Parked memory a = _parked(key);
        return a.parkedAt != 0 || a.amount != 0 || a.converted;
    }

    /// The adapter's quote for refunding message `m` (`body`), or its refusal's selector (a live park with an amount
    /// is always quoted; only a broken adapter refuses, which the caller counts rather than reverting itself).
    function _quoteRefund(Msg memory m, bytes memory body) internal view returns (bool, uint256, bytes4) {
        try adapterBit.quoteRefund(m.recipient, m.sender, body) returns (uint256 quote) {
            return (true, quote, bytes4(0));
        } catch (bytes memory reason) {
            return (false, 0, _selector(reason));
        }
    }

    /// BatchParked of batch `i` among `logs`: whether there is one (exactly one, else lostOutcomes counts it), as
    /// native TAO or tokens, and its reason; its key, message id, recipient, sender and amount must be the batch's.
    function _parkLogged(Vm.Log[] memory logs, uint256 i)
        internal
        returns (bool parked, bool converted, bytes4 reason)
    {
        Msg storage m = _msgs[i];
        MockRouter.Sent memory s = routerBase.sendAt(m.sendIndex);
        uint256 n;
        for (uint256 k; k < logs.length; ++k) {
            Vm.Log memory log = logs[k];
            if (log.emitter != address(adapterBit) || log.topics[0] != CcipBittensorAdapter.BatchParked.selector) {
                continue;
            }
            ++n;
            address to;
            address from;
            uint256 amount;
            (to, from, amount, converted, reason) = abi.decode(log.data, (address, address, uint256, bool, bytes4));
            if (
                log.topics[1] != m.parkKey || log.topics[2] != s.messageId || to != m.recipient || from != m.sender
                    || amount != m.amount
            ) ++lostOutcomes;
        }
        if (n > 1) ++lostOutcomes;
        parked = n != 0;
    }

    /// Whether the Bittensor adapter logged event `sig` for `key` among `logs`.
    function _adapterLogged(Vm.Log[] memory logs, bytes32 sig, bytes32 key) internal view returns (bool) {
        for (uint256 k; k < logs.length; ++k) {
            if (logs[k].emitter == address(adapterBit) && logs[k].topics[0] == sig && logs[k].topics[1] == key) {
                return true;
            }
        }
        return false;
    }

    /// The first message of `list` from `seed` on that is in flight or failed.
    function _pending(uint256[] storage list, uint256 seed) internal view returns (bool, uint256) {
        uint256 n = list.length;
        for (uint256 k; k < n; ++k) {
            uint256 i = list[(seed % n + k) % n];
            State s = _msgs[i].state;
            if (s == State.InFlight || s == State.Failed) return (true, i);
        }
        return (false, 0);
    }

    /// The first live park that is the recipient actor's (`actor`) or empty (`empty`), and its message.
    function _parkWhere(bool actor, bool empty) internal view returns (bool, bytes32, uint256) {
        for (uint256 k; k < _parkKeys.length; ++k) {
            bytes32 key = _parkKeys[k];
            Park storage q = _parks[key];
            if (!q.live) continue;
            if (actor && _msgs[q.msgIndex].recipient != address(recipient)) continue;
            if (empty && q.amount != 0) continue;
            return (true, key, q.msgIndex);
        }
        return (false, bytes32(0), 0);
    }

    /// A park key from `seed` and the message to call it with: the next live park and its message, or (one draw in
    /// eight, or with none live) any batch toward Bittensor's key, a delivered, refunded, dropped, in flight or failed
    /// one's among them, whose record may be gone or never was (its message that batch, or the park's when the key is
    /// parked under a duplicate).
    function _parkFrom(uint256 seed) internal view returns (bool, bytes32, uint256) {
        uint256 n = _toBittensor.length;
        if (n == 0) return (false, bytes32(0), 0);
        uint256 parks = _parkKeys.length;
        if (seed % 8 != 0 && parks != 0) {
            for (uint256 k; k < parks; ++k) {
                bytes32 live = _parkKeys[(seed / 8 % parks + k) % parks];
                if (_parks[live].live) return (true, live, _parks[live].msgIndex);
            }
        }
        uint256 i = _toBittensor[(seed / 8) % n];
        bytes32 key = _msgs[i].parkKey;
        Park storage q = _parks[key];
        return (true, key, q.live ? q.msgIndex : i);
    }

    /// The adapter's revert data inside the router's DeliveryFailed(bytes): its selector.
    function _innerSelector(bytes memory reason) internal pure returns (bytes4) {
        if (reason.length < 4 + 64) return bytes4(0);
        bytes memory body = new bytes(reason.length - 4);
        for (uint256 k; k < body.length; ++k) {
            body[k] = reason[k + 4];
        }
        return _selector(abi.decode(body, (bytes)));
    }

    /// The first 32 bytes of `data` (the first field of an event's data).
    function _firstWord(bytes memory data) internal pure returns (bytes memory w) {
        w = new bytes(32);
        for (uint256 k; k < 32; ++k) {
            w[k] = data[k];
        }
    }

    /// Removes `key` from the queued keys.
    function _dropKey(bytes32 key) internal {
        uint256 n = queuedKeys.length;
        for (uint256 k; k < n; ++k) {
            if (queuedKeys[k] == key) {
                queuedKeys[k] = queuedKeys[n - 1];
                queuedKeys.pop();
                return;
            }
        }
    }

    /// An unexpected outcome: counted with the base's, and tagged.
    function _tag(bytes32 what) internal {
        ++unexpectedReverts;
        lastUnexpected = what;
    }

    /// A call that went: TrackedHandler's count when a refusal `expect` was predicted, tagged `what`, so a failing run
    /// names the predicted refusal that did not happen.
    function _went(bytes4 expect, bytes32 what) internal {
        _succeeded(expect);
        if (expect != 0) lastUnexpected = what;
    }

    /// A park function that went on batch `i`'s key, which holds no live park in the ghost: only a broken adapter does
    /// that (the call's predicted NotParked already counts it unexpected). I-8: a batch delivered, refunded or dropped
    /// already that a park call moves again is both (mintedAndRefunded), and one never parked a call that made a state
    /// from nothing (lostOutcomes). The ghost does not move, so the record and total checks then compare it with what
    /// the adapter did.
    function _deadKeyWent(uint256 i) internal {
        State s = _msgs[i].state;
        if (s == State.Delivered || s == State.Refunded || s == State.Dropped) ++mintedAndRefunded;
        else ++lostOutcomes;
    }

    // ---- views for the campaign's tests ----

    function messageCount() external view returns (uint256) {
        return _msgs.length;
    }

    function messageAt(uint256 i) external view returns (Msg memory) {
        return _msgs[i];
    }

    function parkKeyCount() external view returns (uint256) {
        return _parkKeys.length;
    }

    function ghostParkOf(bytes32 key) external view returns (Park memory) {
        return _parks[key];
    }

    function parkKeyAt(uint256 k) external view returns (bytes32) {
        return _parkKeys[k];
    }
}
