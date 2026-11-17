// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CascadeBase} from "../../../src/CascadeBase.sol";
import {CascadeVault} from "../../../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../../../src/CascadeFrontDoor.sol";
import {CascadeStaker} from "../../../src/CascadeStaker.sol";
import {CascadeMath} from "../../../src/libraries/CascadeMath.sol";
import {CascadeMessages} from "../../../src/libraries/CascadeMessages.sol";
import {MockBridge} from "../../mocks/MockBridge.sol";
import {MockSwapRouter} from "../../mocks/MockSwapRouter.sol";
import {MockSwapper} from "../../mocks/MockSwapper.sol";
import {MockTAO} from "../../mocks/MockTAO.sol";
import {MockTwap} from "../../mocks/MockTwap.sol";
import {MockUSDC} from "../../mocks/MockUSDC.sol";
import {ICascadeTwap} from "../../../src/interfaces/ICascadeTwap.sol";
import {Schedule} from "../../governance/Schedule.sol";
import {
    AdoptTooSoon,
    BelowMinAdoption,
    CapExceeded,
    ExitsNotOpen,
    FeeTooHigh,
    FrontDoorInactive,
    NothingToCancel,
    PeerNotActive,
    PrimaryBridgeDisabled,
    StakeMissing,
    UnknownOrigin,
    UnknownPeer,
    UnstakeShort,
    VaultInsolvent,
    ZeroAmount
} from "../../../src/CascadeErrors.sol";
import {GLOBAL_WINDOW, STAKE_RAMP} from "../../../src/CascadeConstants.sol";
import {
    BatchDelivered,
    DepositBounced,
    Deposited,
    PayoutBatchQueued,
    PayoutChunkSent,
    RedeemDeferred,
    RedeemSkipped,
    Redeemed,
    RedeemedDirect,
    RewardCutMinted,
    RewardsClaimed
} from "../../../src/CascadeEvents.sol";
import {Actor, BounceReason, DoorState, Item, Kind, PayoutBatch} from "../../../src/CascadeTypes.sol";
import {FrontDoorTracker} from "./FrontDoorTracker.sol";
import {VaultModel} from "./VaultModel.sol";

/// @notice Bounded user, keeper and owner actions for the Cascade invariant suite (Phase 8's core handler, moved from
/// test/invariants/Handler.sol in Task 34), over three actors. Each actor holds 10_000 bridged TAO on Base, and
/// 10_000 native TAO plus 10 ether of fee money as one native balance (both chains share one EVM here). Every action
/// wraps its call in try/catch and updates the ghosts only when it succeeds. The handler is the vault's keeper and
/// the front door's, closes batches with what their pot lacks of the bridge fee and a fuzzed extra (the Base lane's
/// fee drawn per front-door send, and the Bittensor lane's per payout chunk, each restored after its send), by the
/// open batch's id or a stale one and with a fuzzed minimum, forces a request's self-close (selfClose), and acts as
/// the owner (by prank) to sweep the front door's carried pot, cancel queued payouts, set the reward cut and the
/// vesting period and swap the front door's swapper. Raising the cut, naming its treasury, shortening the vesting
/// period and any swapper change are scheduled items (Task 11): the handler runs each through the scheduler fixture
/// (`Schedule`), so their 48 hours pass inside the action; it calls the setter itself wherever the owner could at
/// once (a cut kept or lowered, a period kept or lengthened). No donations to the front door; rarely, a simulated
/// loss takes TAO out of the vault (see simulateLoss), which can make it insolvent.
///
/// Stake goes missing across calls (Task 34, the T13 carry): `swapAway` moves part of the vault's stake to the
/// unlisted hotkey SWAPPED, as a validator's swap would, and it stays there until `restoreStake` swaps it back, so
/// every other action runs while it is missing: a delivery then reverts StakeMissing and the bridge files it, which
/// `retryDelivery` re-runs (the parking of spec §3.2, as MockBridge models it). The mock's removal fee
/// (`setRemoveFee`, 0 to 1,000 rao, or 1,001, 50,000, 4,000,000 or 16,000,000 rao: every one the exit's own cost,
/// Task 36b) and its one-rao-short read of a fresh position (`setFreshRead`) are switched at random, so every
/// exception I-4 names is reachable, and none of them is an exit.
///
/// The launch door comes and goes (Task 34a, the Task 10b carry): `removeDoor` has the owner or the guardian remove
/// it (spec §3.6: the owner's removal leaves it known, Removed, its way back a Reopen; the guardian's makes it unknown
/// and deletes its pending Reopen; either closes the exits as the launch chain's last door, the hold its remover's), and
/// `reopenDoor` brings it back: the owner's Reopen (scheduled, and executed then or by a later call, its 7 days and
/// blocks waited out, so a Reopen stays pending across calls), or, after the guardian's removal, a guardian swap that
/// ends the guardian's hold and then the door's Ordinary activation (8 and 7 days). Every other action runs while it is
/// down: a delivery is refused UnknownPeer and filed, a payout chunk refused FrontDoorInactive, a direct depositor's
/// opt-back-in refused UnknownOrigin, and an Ordinary loosening refused ExitsNotOpen while the hold closes the exits.
///
/// I-4 (spec §3.1; the bookkeeping is TrackedHandler's base, PriceFloorTracker, since Task 34a): `priceFloor` is the
/// highest price seen since the last exception: every action raises it at its start and its end, and right after each
/// warp inside it (`step`). An action that falls under one of I-4's exceptions records it itself, checks the fall
/// against that exception's bound and restarts the floor from the price after it; the invariant reads only the floor
/// and the counters, never the price alone. The steps:
/// `swapAway` (visible stake below booked), `simulateLoss` (a simulated loss), `cancelQueued` over a hole one of these
/// left (down to cancelFloor, the floor alone, less 1 rao per re-minted entry; no fall at all elsewhere), `stakeIdle`
/// (the 1-rao-short read of a fresh position), and, at a supply of 0, the next mint, which absorbs the payout gap an
/// earlier exception left (`holeWei`, recorded by that exception's step), within the 1,000-rao tolerance (the cut only
/// with nothing vesting). No exit is one (Task 36b, the leaver pays): a walk's removal fee is the exit's own cost.
///
/// I-35 (`exitPriceFalls`, PriceFloorTracker's _markPrice and _checkExitPrice): around every payout chunk sent (the
/// keeper's, and through deliver), every direct exit paid (flagged or not, a cycle's), and every cancel but one over a
/// hole a recorded exception left with the assets reading 0, the price never falls, exactly, and the hole never
/// widens.
///
/// I-1 across the actions (`guardMisses`): no direct deposit, unflagged direct redeem, delivered batch or reward cut
/// while stake is missing, and no mint at a supply of 0 underwater (a step that starts there and ends with shares).
///
/// The walk's removals (spec §3.10.11, Task 36's fix round 2; `walkMismatches`, VaultModel's _checkWalk): every
/// processPayouts chunk sent, direct exit paid (flagged or not) and cycle's exit logs exactly the Unstaked events
/// VaultModel predicts before the call from the mock's position (_chunkOutcome on what the chunk pays at its fee,
/// _exitPlan): with the one listed hotkey, none when the free balance covers it, else one removal of the stake
/// hotkey at the walk's ask, or the whole position.
///
/// Expected reverts, by action (any other revert, or a predicted refusal that does not happen, is unexpected):
/// - deposit: BelowMinDeposit, CapExceeded, BatchValueFull, BatchFull, each when its own limit refuses, in the front
///   door's order;
/// - requestRedeem, selfClose: InsufficientFee for a first request that closes the batch on a pot short of the fee;
/// - cancelDeposit: CancelTooSoon(its last deposit's time + 5 minutes) within five minutes of the actor's last deposit
///   or stake (R11, FrontDoorTracker's model, the exact revert data; the model waives it while the door is paused or its
///   primary disabled, R12, neither of which this campaign does);
/// - closeBatch: WrongBatch for a stale id, BatchTooSmall for a minimum above the deposits, BatchNotReady;
/// - a delivery (inside a close or a self-close, and retryDelivery), as the bridge files it, in the vault's order:
///   UnknownPeer while the door is not active, StakeMissing while stake is missing, VaultInsolvent at a supply of 0
///   underwater;
/// - deliver: DeliveryExpired after the deadline, ThinPool on a thinned pool, BelowMinimum from the short payer, and
///   BelowMinimum, InsufficientOutput or the router's Error("Too little received") from the staker below the floor;
/// - processPayouts: FrontDoorInactive while the door is not active; else FeeTooHigh when the call's value is short of
///   the fee above the ceiling; then VaultModel's _chunkOutcome: UnstakeShort when the stake the walk can reach (the
///   stake hotkey's, at least the minimum, at face value) leaves more than T untaken or its receipts do not fund the
///   send, FeeTooHigh when its cost would leave an entry nothing;
/// - depositDirect: StakeMissing while stake is missing, VaultInsolvent below half the launch price or underwater,
///   CapExceeded above the cap; its opt-back-in to the door's chain (and a cycle's), UnknownOrigin while no door is
///   active there;
/// - claimWithCut, setVesting: a loosening's schedule, ExitsNotOpen while a hold closes the vault's exits;
/// - redeemDirect: StakeMissing while stake is missing (unflagged), else VaultModel's _exitPlan: ZeroAmount under a rao
///   or when the walk's cost leaves the leaver nothing, UnstakeShort when the walk leaves more than T untaken (the only
///   stake below the minimum: dustBlocked);
/// - redeemDirectWhileMissing: StakeMissing for its unflagged probes, _exitPlan's refusals for the flagged exit;
/// - cycle: its redeem's, _exitPlan's;
/// - adopt: AdoptTooSoon within a day of the last adoption, BelowMinAdoption under the chain's minimum;
/// - cancelQueued: NothingToCancel with nothing to re-mint;
/// - removeDoor: PeerNotActive for the owner's removal of a door not active, and for the guardian's of one that is
///   neither active nor owner-removed (unknown).
/// - stake (Task 42, I-31's stake half): the oracle's own revert ("OLD") while it cannot answer, NoOracle while the
///   door has none, the router's "Too little received" below the stake's own minimum, BelowOracleFloor below 95% of the
///   oracle's value, then the door's BelowMinDeposit, CapExceeded, BatchValueFull and BatchFull, in that order.
/// Not reachable by any action here, so on no list: AboveBridgeCap (no limit setter runs), ForeverMoney's Slippage,
/// IsHalted and MigrationInProgress (no adapter: the bridge is MockBridge; the adapter campaign reaches them).
///
/// I-18's ghost form and I-21 (the fee pot's ghosts, the closes' record and the closers' gains) are FrontDoorTracker's,
/// shared with the doors campaign (Task 37), over the one door here.
contract CoreHandler is VaultModel, FrontDoorTracker {
    /// The v3 fixture: the front door's USDC, its swapper (the staker, selling through `router`), the
    /// TWAP it floors deliveries on, a swapper that pays short, and the vault's treasury.
    struct V3 {
        MockUSDC usdc;
        CascadeStaker staker;
        MockSwapRouter router;
        MockTwap twap;
        MockSwapper shortPayer;
        address treasury;
    }

    /// A delivery preference the handler left for an actor: USDC units per 1e18 TAO, and its deadline.
    struct Preference {
        uint128 floor;
        uint64 deadline;
    }

    uint256 internal constant MAX_DEPOSIT = 100e18;
    /// Native balance an actor keeps back from direct deposits, for redeem-request fees.
    uint256 internal constant FEE_MONEY = 10 ether;
    uint256 internal constant MIN_STAKE_RAO = 2_000_000;
    /// The most entries one processPayouts call asks for (it asks for 1 to CHUNK_ENTRIES); with the
    /// vault's minChunk at 1, a 2- or 3-entry batch can go out in several chunks.
    uint32 internal constant CHUNK_ENTRIES = 3;
    /// simulateLoss acts on at most this many calls per run.
    uint256 internal constant MAX_LOSSES = 2;
    /// removeDoor removes the door at most this many times per run (and acts on one call in eight, doorDraw).
    uint256 internal constant MAX_REMOVALS = 2;
    /// The front door's default discount to the TWAP's value, which the fixture keeps.
    uint256 internal constant SLIPPAGE_BPS = 150;
    uint32 internal constant DESTINATION_BASE = 6;
    /// Where swapAway moves the vault's stake: a hotkey the vault does not list.
    bytes32 public constant SWAPPED = bytes32(uint256(5));

    MockTAO public immutable tao;
    MockBridge public immutable bridge;
    bytes32 public immutable hotkey;
    /// The front door's peer id at the vault, and its chain: the redeem origin an actor sets after a direct deposit.
    bytes32 public immutable peer;
    uint64 public immutable doorChain;
    MockUSDC public immutable usdc;
    CascadeStaker public immutable staker;
    MockSwapRouter public immutable router;
    MockTwap public immutable twap;
    MockSwapper public immutable shortPayer;
    address public immutable treasury;

    address[3] public actors;
    mapping(address => Preference) public preferences;

    // ---- ghosts ----

    /// Native TAO delivered into the vault: every delivered batch's amount and every direct deposit.
    uint256 public ghostIn;
    /// Native TAO sent out of the vault: net + charged of every payout chunk (the caller's top-up pays the rest of
    /// its fee) and every direct redeem paid.
    uint256 public ghostOut;
    /// Claimed root rewards, in wei.
    uint256 public ghostRewards;
    /// Net of every payout chunk the vault sent to the front door.
    uint256 public ghostPayoutsReceived;
    /// Bridged TAO actors received from `claim`.
    uint256 public ghostClaimed;
    /// Bridged TAO credits the front door sold for USDC in successful deliveries.
    uint256 public ghostDelivered;
    /// Native TAO taken out of the vault by simulateLoss.
    uint256 public ghostLoss;
    /// Root stake moved onto the vault's hotkey from outside by gift, in wei.
    uint256 public ghostGifts;
    /// Deliveries that left the front door's burn window above its daily allowance, and those that left all
    /// doors' (the global window) above theirs (I-15).
    uint256 public doorWindowViolations;
    uint256 public globalWindowViolations;
    /// Gifts after which the allowance base (base()) fell, or rose by more than the missing stake they made up, gifts
    /// that changed the booked stake (I-3: a gift is booked only by an adoption), and gifts that lowered the price, or
    /// raised it by more than the missing stake they made up (I-3: it moves neither way while nothing is missing).
    uint256 public giftBaseRises;
    uint256 public giftsBooked;
    uint256 public giftPriceMoves;
    /// Cycles that raised the allowance base, or, when the booked stake ended no lower than it began, left it other
    /// than it was less what their unstake receipts came back short.
    uint256 public cycleBaseMoves;
    /// Cycles whose redeem also unstaked older booked stake (to fund queued payouts the liquid balance did not
    /// cover, or a full removal below the minimum remainder): they may lower the base, never raise it.
    uint256 public cyclesIntoOlderStake;
    /// Cancels that left the price below the floor before them by a rao or more per re-minted entry (and the gap the
    /// cancel absorbed at a supply of 0).
    uint256 public cancelDustViolations;
    /// Cancels that lowered the price at all while totalAssets() read above 0 before them. None can (Task 34c): each
    /// entry gets at most the shares its value buys at that price, so the dust allowance is for assets reading 0.
    uint256 public cancelFallsWithAssets;
    /// Keys of the batches with payouts left, and per key the delivery price and the full payout list.
    bytes32[] public queuedKeys;
    mapping(bytes32 => uint256) public deliveryPrice;
    mapping(bytes32 => CascadeMessages.Payout[]) internal lists;
    /// The share price right before and right after each successful reward claim, cut or not, and
    /// right after it as if one more share had been minted.
    uint256[] public claimPriceBefore;
    uint256[] public claimPriceAfter;
    uint256[] public claimPriceOneMoreShare;
    /// Each successful USDC delivery's floor, as the handler computed it (the user's floor rounded up,
    /// the keeper's, the TWAP's value less SLIPPAGE_BPS), and what the actor's USDC balance rose by.
    uint256[] public deliveryFloor;
    uint256[] public deliveryReceived;
    /// I-30 (Task 42): each successful delivery's three floors apart, as the handler computed them (the user's, rounded
    /// up; the keeper's; the oracle's value of the credit less SLIPPAGE_BPS, read from the oracle's own usdcValue).
    uint256[] public deliveryUserFloor;
    uint256[] public deliveryKeeperFloor;
    uint256[] public deliveryTwapFloor;
    /// I-31 (Task 42): deliveries that settled while either pool's mean liquidity sat below the door's floor (asserted 0;
    /// the thinned deliveries are refused ThinPool), and stakes that settled with the route's TAO below 95% of the
    /// oracle's value of the USDC swapped (asserted 0).
    uint256 public thinDeliveries;
    uint256 public stakesBelowFloor;
    /// The stake action's reach: stakes settled (and within 1% above the floor), refused below the floor, below the
    /// stake's own minimum, by the oracle (reverting, or none), and by the door's limits; and the deliveries whose binding
    /// floor was the user's, the keeper's or the TWAP's.
    uint256 public stakesSettled;
    uint256 public stakesNearFloor;
    uint256 public stakesRefusedFloor;
    uint256 public stakesRefusedMinimum;
    uint256 public stakesRefusedOracle;
    uint256 public stakesRefusedNoOracle;
    uint256 public stakesRefusedDoor;
    uint256 public deliveriesBoundByUser;
    uint256 public deliveriesBoundByKeeper;
    uint256 public deliveriesBoundByTwap;
    /// Successful deliveries after their preference's deadline.
    uint256 public lateDeliveries;

    // ---- reachability counters (successful calls, and the states they ran in) ----

    uint256 public deposits;
    uint256 public redeemRequests;
    uint256 public depositCancels;
    uint256 public redeemCancels;
    uint256 public closes;
    /// Closes whose closer sent more than the pot lacked, successful self-closes, and owner sweeps (Task 29's
    /// follow-up: what I-18 and I-21 run across, with FrontDoorTracker's potsCarried).
    uint256 public closesWithExtra;
    uint256 public selfCloses;
    uint256 public sweeps;
    /// Closes refused WrongBatch (a stale id) and BatchTooSmall (a minimum above the deposits), as predicted.
    uint256 public wrongBatches;
    uint256 public tooSmallCloses;
    uint256 public deliveries;
    uint256 public payoutChunks;
    /// Chunks that left entries in their batch.
    uint256 public partialChunks;
    /// Chunks sent with a top-up (the fee above the ceiling paid by the caller), and payouts refused FeeTooHigh
    /// (the value short of it) and UnstakeShort (the walk could not cover the chunk), as predicted.
    uint256 public topUpChunks;
    /// Chunks the caller's whole fee paid, the entries charged nothing (the full top-up, R4).
    uint256 public fullTopUps;
    uint256 public payoutsFeeRefused;
    uint256 public payoutsUncoverable;
    uint256 public claims;
    uint256 public directDeposits;
    uint256 public directRedeems;
    uint256 public stakes;
    uint256 public rewardClaims;
    uint256 public cancels;
    /// Cancels of a batch that had already sent a chunk.
    uint256 public cancelsAfterPartial;
    /// RedeemDeferred and RedeemSkipped events seen in deliveries.
    uint256 public redeemDeferred;
    uint256 public redeemSkipped;
    /// I-36 (spec §3.5, R4 B-H1, the door hold), on the handler's own model of each holder's fresh shares: what the
    /// door's deposits (their Deposited events with shares) and the direct deposits (the balance they raised) minted for
    /// it in its run of mints, each made while the run was still held, and the run's clock, the share-weighted mean of its
    /// mints' times rounded up (S-L3; held until STAKE_RAMP after it), lowered to the balance after each direct exit (R6
    /// A, `_capFresh`). `freshBurns` counts
    /// the door burns that left a holder with fewer shares than the model's fresh ones (I-36: none may); `freshHolds`,
    /// the redeems deferred while the holder had fresh shares (the hold reached).
    mapping(address => uint256) internal ghostFresh;
    mapping(address => uint256) internal ghostFreshAt;
    uint256 public freshBurns;
    uint256 public freshHolds;
    /// I-36's independent floor (the R4 review, Minor 4), on no restated formula: a delivery never burns the shares it
    /// minted itself. Counts the redeems after which the holder held fewer shares than that delivery's own Deposited
    /// events minted for it (asserted 0).
    uint256 public mintBurns;
    /// DepositBounced events seen in deliveries (reached only after a simulated loss).
    uint256 public depositBounces;
    /// Bounced entries sent in payout chunks, and unsent bounced entries a cancel carried forward (Task 22).
    uint256 public bouncesPaid;
    uint256 public bouncesCarried;
    /// simulateLoss calls that took TAO out of the vault.
    uint256 public losses;
    /// Stake gifts, and deposit-stake-redeem cycles that went all the way round.
    uint256 public gifts;
    uint256 public cycles;
    /// adopt (Task 16): the keeper's adoptions of the gifts, those that moved the price at the adoption (none may:
    /// the gift vests), and those that ran although not due, left a surplus behind or moved the claim schedule (none
    /// may; Revision 27: the gift vests on its own drip).
    uint256 public adoptions;
    uint256 public adoptPriceMoves;
    uint256 public unexpectedAdoptions;
    /// High-water mark of queuedKeys.length.
    uint256 public maxQueueDepth;
    /// Exits refused UnstakeShort because the only stake sat below the minimum stake, which the
    /// vault's unstake walk skips.
    uint256 public dustBlocked;
    /// Claims that minted a cut: in all, while an earlier claim was still vesting, and while payouts
    /// were pending; claims whose cut was skipped (below half the launch price, underwater or stake missing).
    uint256 public cutsMinted;
    uint256 public cutsWhileVesting;
    uint256 public cutsWithPending;
    uint256 public cutsSkipped;
    /// The scheduled loosenings the handler ran through the scheduler: the cut's and the vesting period's.
    uint256 public cutLoosenings;
    uint256 public vestingLoosenings;
    /// setVesting (Task 15's follow-up): changes of the owner's vesting period, those that moved the price (none
    /// may), and restarts of either drip that ended a carried remainder sooner than its own schedule (none may:
    /// _restartPeriod keeps at least what is left of the old drip).
    uint256 public vestingChanges;
    uint256 public vestingPriceMoves;
    uint256 public remaindersSpedUp;
    /// The swap actions: swaps that left stake missing (past the tolerance) and those within it, and restores.
    uint256 public swapsMissing;
    uint256 public swapsWithinTolerance;
    uint256 public restores;
    /// I-1 (Task 13), while stake is missing: flagged exits; a direct deposit or an unflagged direct redeem that did
    /// not revert StakeMissing (guardMisses); a flagged exit not paid exactly its shares' value at min(visible, booked)
    /// floored to the rao, less what its receipts left unmet (its ShortfallAbsorbed, at most 1,000 rao and equal to
    /// what the handler measures its liquidity and receipts left uncovered; Task 19), floored again, whose assets fell
    /// by other than what it paid and what the holders absorbed of its receipts, or whose RedeemedDirect did not say
    /// acceptedMissing = true with that pay (missingMispaid); another holder whose redeemable value fell by more than
    /// its share of what the holders absorbed, or rose by more than the leaver's rounding (missingOthersMoved). The
    /// guard misses are counted in the base's guardMisses.
    uint256 public missingExits;
    uint256 public missingMispaid;
    uint256 public missingOthersMoved;
    /// The other actions while stake is missing (the T13 carry): direct deposits and unflagged direct redeems refused
    /// StakeMissing, deliveries the bridge filed as refused StakeMissing (a close's, a self-close's or a retry's),
    /// payout chunks sent, reward claims, stakes and payout cancels.
    uint256 public depositsRefusedWhileMissing;
    uint256 public redeemsRefusedWhileMissing;
    uint256 public deliveriesRefusedWhileMissing;
    uint256 public payoutsWhileMissing;
    uint256 public claimsWhileMissing;
    uint256 public stakesWhileMissing;
    uint256 public cancelsWhileMissing;
    /// Deliveries the bridge filed as refused VaultInsolvent (a supply of 0 underwater), and retries that delivered.
    uint256 public deliveriesRefusedUnderwater;
    uint256 public retriesDelivered;
    /// I-4's exceptions, each counted by the step that caused it: swaps that took priced stake out (visible below
    /// booked) and cancels after which the price was lower than before. (Losses: `losses`; the fresh reads and the gaps
    /// absorbed at a supply of 0: the base's i4FreshReads and i4GapsAbsorbed.)
    uint256 public i4Swaps;
    uint256 public i4CancelFalls;
    /// Task 36b's states: chunks refused FeeTooHigh because their walk's cost would leave an entry nothing, direct exits
    /// (flagged or not, a cycle's) refused ZeroAmount after their walk because its cost left the leaver nothing, and
    /// cancels that started with the assets reading 0 over a hole a recorded exception left (I-35's exemption).
    uint256 public chunksRefusedWalkCost;
    uint256 public exitsRefusedByCost;
    /// I-13's direct half (Task 36b): unflagged direct exits not paid exactly floorToRao(out - unmet - cost), measured
    /// on both sides (unmet and cost from the coldkey's stake drop and the vault's balance, ShortfallAbsorbed their sum:
    /// _shortfallMispaid, as the flagged exit's; fix round 1), or not VaultModel's _exitPlan pay and unmet + cost.
    uint256 public directMispaid;
    uint256 public cancelsOverAHole;
    /// The give-back the last cancel's bound read (_cancelGiveBack: at most its re-minted entries' value).
    uint256 public lastCancelGiveBack;
    /// The switches of the mock's fee and read, and of the vault's unstake margin.
    uint256 public feeSwitches;
    uint256 public marginSwitches;
    uint256 public readSwitches;
    /// Successful USDC deliveries: in all, while other actors held credits and while the open batch held
    /// deposits (TAO the front door holds but must not sell), and paying exactly the floor; then the
    /// deliveries refused as the handler expected (expired, a thin pool, the market below the floor, or a swapper
    /// paying short), and those refused ThinPool among them.
    uint256 public usdcDeliveries;
    uint256 public deliveriesBesideOtherCredits;
    uint256 public deliveriesBesideOpenDeposits;
    uint256 public deliveriesAtFloor;
    uint256 public deliveriesRefused;
    uint256 public thinPoolRefusals;
    /// The door actions (Task 34a): removals by the owner and by the guardian, the guardian's removals of a door the
    /// owner removed and the pending Reopens they deleted, removals refused PeerNotActive as predicted; Reopens
    /// scheduled, executed, and scheduled again after a lapse or an owner stamp killed the pending one; ways back
    /// after the guardian's removal (the swap, then the Ordinary activation).
    uint256 public removalsByOwner;
    uint256 public removalsByGuardian;
    uint256 public guardianRemovalsOfRemoved;
    uint256 public reopensDeleted;
    uint256 public removalsRefused;
    uint256 public reopensScheduled;
    uint256 public reopensExecuted;
    uint256 public reopensRescheduled;
    /// The targeted draws made (Task 42).
    uint256 public removeTwiceDraws;
    uint256 public thinDraws;
    /// deliverThin's switch for the delivery it makes.
    bool internal _forceThin;
    uint256 public partialThenCancelDraws;
    uint256 public swapRestores;
    /// While the door is down: deliveries the bridge filed as refused UnknownPeer, payouts refused FrontDoorInactive,
    /// opt-back-ins refused UnknownOrigin, and Ordinary loosenings refused ExitsNotOpen.
    uint256 public deliveriesRefusedDoorDown;
    uint256 public payoutsRefusedDoorDown;
    uint256 public originsRefusedDoorDown;
    uint256 public looseningsRefused;

    /// `s` is the fixture's system (CampaignFixture: the vault and the front door, both lenses, the owner and the
    /// guardian); the handler reads every value through the lenses it is given.
    constructor(System memory s, MockTAO tao_, MockBridge bridge_, bytes32 hotkey_, uint64 chain, V3 memory v3)
        VaultModel(s)
    {
        tao = tao_;
        bridge = bridge_;
        hotkey = hotkey_;
        peer = vaultLens.peerId(chain, address(s.fd));
        doorChain = chain;
        usdc = v3.usdc;
        staker = v3.staker;
        router = v3.router;
        twap = v3.twap;
        shortPayer = v3.shortPayer;
        treasury = v3.treasury;

        actors = [makeAddr("alice"), makeAddr("bob"), makeAddr("carol")];
        for (uint256 i; i < actors.length; ++i) {
            tao_.mint(actors[i], 10_000e18);
            vm.prank(actors[i]);
            tao_.approve(address(s.fd), type(uint256).max);
            vm.deal(actors[i], 10_000e18 + FEE_MONEY);
            _trackAccount(actors[i]);
        }
        // I-33's argument sets: the bridge, the market's parties and the treasury; the stake hotkey and the swap's;
        // the door (and its address on the vault's chain, which no door is), and a batch key of the door's
        address[5] memory parties =
            [address(bridge_), address(v3.staker), address(v3.router), address(v3.shortPayer), v3.treasury];
        for (uint256 i; i < parties.length; ++i) {
            _trackAccount(parties[i]);
        }
        _trackWord(hotkey_, WordKind.Hotkey);
        _trackWord(SWAPPED, WordKind.Hotkey);
        _trackPeer(chain, address(s.fd));
        _trackPeer(s.fd.vaultChain(), address(s.fd));
        _trackMessage(chain, address(s.fd), "");
        _trackDoor(s.fd);
    }

    /// @dev Takes the unused part of each close's budget, and each payout's refund, back.
    receive() external payable {}

    // ---- front door: users ----

    function deposit(uint256 actorSeed, uint256 amount) external step {
        address actor = actors[actorSeed % actors.length];
        uint256 maxRao = Math.min(MAX_DEPOSIT, tao.balanceOf(actor)) / RAO;
        if (maxRao < 1e18 / RAO) return;
        amount = bound(amount, 1e18 / RAO, maxRao) * RAO;
        // rao-aligned, within the actor's balance and allowance: only a limit may refuse it, each with its own error,
        // in the front door's order
        (,, uint256 open,, uint256 nDeposits,) = fd.openBatch();
        uint256 total = open + amount;
        bytes4 expect;
        if (amount < fd.minDeposit()) {
            expect = CascadeFrontDoor.BelowMinDeposit.selector;
        } else if (fd.netForwarded() + total > fd.depositCap()) {
            expect = CascadeFrontDoor.CapExceeded.selector;
        } else if (total > fd.maxBatchValue()) {
            expect = CascadeFrontDoor.BatchValueFull.selector;
        } else if (fd.depositOf(actor) == 0 && nDeposits >= fd.maxDeposits()) {
            expect = CascadeFrontDoor.BatchFull.selector;
        }
        _readLogs();
        vm.prank(actor);
        try fd.deposit(amount) {
            // a predicted refusal lost
            _succeeded(expect);
            ++deposits;
            _noteDeposit(fd, actor);
            _raiseFloor();
        } catch (bytes memory reason) {
            _dropLogs();
            _refused(reason, expect);
        }
    }

    /// @dev Prefers a holder without a request in the open batch, so batches carry several entries (and
    /// pay out in several chunks); adds to an existing request once every holder has one. Pays the
    /// redeem-request fee by value on the actor's first request in the open batch.
    function requestRedeem(uint256 actorSeed, uint256 shares) external step mints {
        (address actor, uint256 balance) = _actorWith(actorSeed, _sharesNotRequested);
        if (balance == 0) (actor, balance) = _actorWith(actorSeed, _shares);
        if (balance == 0) return;
        _request(actor, bound(shares, 1, balance));
    }

    /// @dev A request's self-close (Task 29). An empty redeem list first takes one actor's first request. Then the
    /// owner lowers `maxRedeems` to the open batch's redeem count, so another actor without a request meets a full
    /// list and its first request closes the batch on the pot alone, the lane's fee drawn as for a close (_laneFee:
    /// half the draws at or below the pot); then the limit and the fee are put back. A pot short of the fee
    /// reverts the request InsufficientFee, as expected.
    function selfClose(uint256 actorSeed, uint256 feeSeed, uint256 shares) external step mints {
        (,,, uint256 pot,, uint256 nRedeems) = fd.openBatch();
        if (nRedeems == 0) {
            (address first, uint256 held) = _actorWith(actorSeed, _sharesNotRequested);
            if (held == 0) return;
            _request(first, bound(shares, 1, held));
            (,,, pot,, nRedeems) = fd.openBatch();
            if (nRedeems == 0) return;
        }
        (address actor, uint256 balance) = _actorWith(actorSeed >> 1, _sharesNotRequested);
        if (balance == 0) return;
        uint256 worldFee = bridge.fee();
        uint32 maxDeposits = fd.maxDeposits();
        uint32 maxRedeems = fd.maxRedeems();
        bridge.setFee(_laneFee(feeSeed, pot, worldFee));
        vm.prank(owner);
        // casting to 'uint32' is safe because the open batch holds at most one request per actor
        // forge-lint: disable-next-line(unsafe-typecast)
        fd.setBatchLimits(maxDeposits, uint32(nRedeems));
        _request(actor, bound(shares, 1, balance));
        vm.prank(owner);
        fd.setBatchLimits(maxDeposits, maxRedeems);
        bridge.setFee(worldFee);
    }

    /// @dev One request by `actor`. A first request that meets a full redeem list closes the batch first, on the
    /// pot alone: refused InsufficientFee when the pot is short of the lane's fee (and a success there counts as
    /// unexpected); its delivery is read as a close's, and the requester gets nothing back (I-21: its value is its
    /// own request's fee).
    function _request(address actor, uint256 shares) internal {
        bool hasEntry = fd.redeemOf(actor) != 0;
        uint256 fee = hasEntry ? 0 : fd.redeemRequestFee();
        // never: each actor keeps FEE_MONEY back; counted, so a later change to the funding cannot hide a skip (Task 34's
        // re-review, carried to Task 42)
        if (actor.balance < fee) {
            ++unexpectedReverts;
            return;
        }
        (,,, uint256 pot,, uint256 nRedeems) = fd.openBatch();
        bool closesFirst = !hasEntry && nRedeems >= fd.maxRedeems();
        bytes4 expect = closesFirst && pot < bridge.fee() ? CascadeFrontDoor.InsufficientFee.selector : bytes4(0);
        bool underwater0 = vault.totalSupply() == 0 && _underwater();
        bool missing0 = vaultLens.stakeMissing();
        uint256 paid = actor.balance;
        _readLogs();
        vm.prank(actor);
        try fd.requestRedeem{value: fee}(shares) {
            // a predicted refusal lost
            _succeeded(expect);
            ++redeemRequests;
            _recordPotIn(fd, fee);
            Vm.Log[] memory logs = _readLogs();
            if (closesFirst) {
                ++selfCloses;
                if (actor.balance > paid - fee) ++closerGains;
                _recordClose(fd, logs);
                _recordDelivery(logs, missing0, underwater0);
            }
            _raiseFloor();
        } catch (bytes memory reason) {
            _dropLogs();
            _refused(reason, expect);
        }
    }

    function cancelDeposit(uint256 actorSeed, uint256 amount) external step {
        (address actor, uint256 open) = _actorWith(actorSeed, _openDeposit);
        if (open == 0) return;
        // rao-aligned and at most the entry
        amount = bound(amount, 1, open / RAO) * RAO;
        // a partial cancel must leave at least minDeposit, so a smaller remainder cancels in full
        uint256 left = open - amount;
        if (left != 0 && left < fd.minDeposit()) amount = open;
        // within five minutes of the actor's last deposit, CancelTooSoon (R11: FrontDoorTracker's model)
        bytes memory tooSoon = _cancelTooSoon(fd, actor);
        _readLogs();
        vm.prank(actor);
        try fd.cancelDeposit(amount) {
            // a predicted refusal lost
            if (tooSoon.length != 0) ++unexpectedReverts;
            ++depositCancels;
            _raiseFloor();
        } catch (bytes memory reason) {
            _dropLogs();
            if (!_refusedTooSoon(reason, tooSoon)) ++unexpectedReverts;
        }
    }

    function cancelRedeem(uint256 actorSeed, uint256 shares) external step {
        (address actor, uint256 open) = _actorWith(actorSeed, _openRedeem);
        if (open == 0) return;
        // at most the entry
        shares = bound(shares, 1, open);
        _readLogs();
        vm.prank(actor);
        try fd.cancelRedeem(shares) {
            ++redeemCancels;
            _raiseFloor();
        } catch {
            _dropLogs();
            ++unexpectedReverts;
        }
    }

    /// @dev A claim also clears the actor's delivery preference.
    function claim(uint256 actorSeed) external step {
        (address actor, uint256 owed) = _actorWith(actorSeed, _claimable);
        if (owed == 0) return;
        uint256 before = tao.balanceOf(actor);
        _readLogs();
        vm.prank(actor);
        try fd.claim() {
            ghostClaimed += tao.balanceOf(actor) - before;
            delete preferences[actor];
            ++claims;
            _raiseFloor();
        } catch {
            _dropLogs();
            ++unexpectedReverts;
        }
    }

    // ---- front door: keeper ----

    /// @dev Warps 12 hours, so the open batch is due, and closes it. By `closeSeed` mod 8 it names a stale id (1:
    /// the batch before, or after, the open one; WrongBatch expected), asks a minimum of 0 to twice the deposits
    /// plus 1 TAO (2: BatchTooSmall expected when above them), or names the open id with no minimum. The lane's fee
    /// is drawn for this send (_laneFee: the world's fee, at or below the pot so a remainder is carried, or anywhere
    /// up to the world's fee) and put back after it. The handler sends what the pot lacks of the fee plus an extra of
    /// 0 to the world's fee, and must get back no more than it sent (I-21); seeds (0, 0, 0) close at the world's fee
    /// with exactly what the pot lacks. The bridge delivers inside the close: the delivery's events give its amount,
    /// its payout list (from the DepositBounced and Redeemed events) and its delivery price; a delivery the vault
    /// refuses is filed by the bridge for retryDelivery.
    function closeBatch(uint256 feeSeed, uint256 valueSeed, uint256 closeSeed) external step mints {
        // the batch timer is the front door's
        _warp(12 hours, doorBlockTime);
        (uint64 id,, uint256 open, uint256 pot, uint256 nDeposits, uint256 nRedeems) = fd.openBatch();
        if (nDeposits + nRedeems == 0) return;
        _ageShares();
        uint64 named = id;
        uint256 minValue;
        if (closeSeed % 8 == 1) named = (closeSeed >> 3) % 2 == 0 ? id - 1 : id + 1;
        else if (closeSeed % 8 == 2) minValue = bound(closeSeed >> 3, 0, 2 * open + 1e18);
        // the close's checks in their order: the id, the timer, the minimum
        bytes4 expect;
        if (named != id) expect = CascadeFrontDoor.WrongBatch.selector;
        else if (!fd.canClose()) expect = CascadeFrontDoor.BatchNotReady.selector;
        else if (open < minValue) expect = CascadeFrontDoor.BatchTooSmall.selector;
        uint256 worldFee = bridge.fee();
        uint256 fee = _laneFee(feeSeed, pot, worldFee);
        bridge.setFee(fee);
        uint256 lacks = fee > pot ? fee - pot : 0;
        uint256 value = lacks + bound(valueSeed, 0, worldFee);
        uint256 held = address(this).balance;
        bool underwater0 = vault.totalSupply() == 0 && _underwater();
        bool missing0 = vaultLens.stakeMissing();
        _readLogs();
        try fd.closeBatch{value: value}(named, minValue) {
            // a predicted refusal lost
            _succeeded(expect);
            ++closes;
            if (value > lacks) ++closesWithExtra;
            if (address(this).balance > held) ++closerGains;
            Vm.Log[] memory logs = _readLogs();
            _recordClose(fd, logs);
            _recordDelivery(logs, missing0, underwater0);
            _raiseFloor();
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, expect)) {
                if (expect == CascadeFrontDoor.WrongBatch.selector) ++wrongBatches;
                else if (expect == CascadeFrontDoor.BatchTooSmall.selector) ++tooSmallCloses;
            }
        }
        bridge.setFee(worldFee);
    }

    /// @dev The owner sweeps 0 to all of the pot's carried remainder to the front door's treasury (code-less, so a
    /// sweep never reverts); I-18's ghost form counts it, and the treasury must hold exactly what was swept.
    /// `sweeps` counts those that moved wei.
    function sweepPot(uint256 amountSeed) external step {
        uint256 amount = bound(amountSeed, 0, fd.potCarried());
        _readLogs();
        vm.prank(owner);
        try fd.sweepPot(amount) {
            _recordSweep(fd, amount);
            if (amount != 0) ++sweeps;
        } catch {
            _dropLogs();
            ++unexpectedReverts;
        }
    }

    /// @dev Sells an actor's whole credit for USDC as the front door's keeper. As the keeper does, when no actor
    /// holds a credit it first sends a queued batch's next payout chunk (as processPayouts does, at the world's fee),
    /// then delivers what that credited. The market is drawn first: by `marketSeed` mod 4, the staker selling through
    /// an honest router (0, 1) or a lying one that pays its rate whatever the minimum (2), both at 225 to 275 USDC
    /// per TAO, or (3) the front door's swapper swapped for one that pays the front door's minimum less 0 to 100
    /// bps; that swap is a scheduled item (Task 11), so its 48 hours pass here, and the staker is put back the same
    /// way after the delivery. Then the actor leaves a preference (200 to 260 USDC per TAO, for 1 hour to 7 days) if
    /// it has none, or replaces an expired one on an even `floorSeed`; on an odd one the expired preference stays,
    /// and the delivery must be refused DeliveryExpired. The TWAP is set at 240 to 260 USDC per TAO and, one draw in
    /// eight (a hash of `keeperSeed`), one pool thinned below its floor for this delivery (ThinPool expected). The
    /// keeper's floor is 0, the staker's expected output, or one unit more. It runs from whatever state the run
    /// reached: other actors' credits and open deposits in the front door (TAO it must not sell), a credit grown over
    /// several chunks, more payouts still queued at the vault.
    function deliver(uint256 actorSeed, uint256 floorSeed, uint256 marketSeed, uint256 keeperSeed) external step {
        _deliverDrawn(actorSeed, floorSeed, marketSeed, keeperSeed);
    }

    /// @dev A targeted draw (Task 42, ruling B9: I-31's delivery half, thin since a delivery needs a deposit, a close,
    /// a request, a close and a payout first): deliver with one pool always thinned below its floor, so the delivery
    /// must be refused ThinPool (a mutation that drops the pools' check survived the one-in-eight draw alone).
    function deliverThin(uint256 actorSeed, uint256 floorSeed, uint256 marketSeed, uint256 keeperSeed) external step {
        _forceThin = true;
        _deliverDrawn(actorSeed, floorSeed, marketSeed, keeperSeed);
        _forceThin = false;
        ++thinDraws;
    }

    /// deliver's body (see it), its pool thinned one draw in eight, or always for deliverThin.
    function _deliverDrawn(uint256 actorSeed, uint256 floorSeed, uint256 marketSeed, uint256 keeperSeed) internal {
        (address actor, uint256 owed) = _actorWith(actorSeed, _claimable);
        if (owed == 0) {
            _processPayouts(actorSeed, 0);
            (actor, owed) = _actorWith(actorSeed, _claimable);
            if (owed == 0) return;
        }
        (bool viaShortPayer, uint256 expected, bool paysInFull) = _drawMarket(owed, marketSeed);
        Preference memory p = _prefer(actor, floorSeed);
        if (p.floor != 0) {
            twap.setPrice(bound(keeperSeed >> 8, 240e6, 260e6));
            uint256 keeperMinOut = keeperSeed % 3 == 0 ? 0 : expected + keeperSeed % 3 - 1;
            uint256 floor = _deliveryFloor(owed, p.floor, keeperMinOut);
            _floorParts = [Math.ceilDiv(owed * p.floor, 1e18), keeperMinOut, _twapFloor(owed)];
            uint256 thinDraw = uint256(keccak256(abi.encode(keeperSeed, "thin")));
            bool thin = _forceThin || thinDraw % 8 == 0;
            if (thin) _thinPool(thinDraw >> 3);
            // test-controlled time
            // forge-lint: disable-next-line(block-timestamp)
            bool live = vm.getBlockTimestamp() <= p.deadline;
            // the delivery's checks in their order: the deadline, the pools, then the market
            bytes4 expect;
            if (!live) expect = CascadeFrontDoor.DeliveryExpired.selector;
            else if (thin) expect = CascadeFrontDoor.ThinPool.selector;
            else if (viaShortPayer && !paysInFull) expect = CascadeFrontDoor.BelowMinimum.selector;
            bool ready = expect == 0 && (viaShortPayer || expected >= floor);
            _deliver(actor, owed, keeperMinOut, floor, live, ready, expect);
            if (thin) twap.setMeanLiquidity(type(uint128).max, type(uint128).max);
        }
        if (viaShortPayer) _setSwapper(address(staker));
    }

    /// @dev I-31's stake half (Task 42): an actor stakes 500 to 25,000 USDC through the staker (route 0, no deposit fee,
    /// the staker's 15 bps swap fee) for itself. The oracle's price is drawn at 240 to 260 USDC per TAO; the route pays
    /// 90% to 105% of the oracle's value of the USDC swapped, or one draw in four exactly the buy floor (95%, rounded as
    /// the staker rounds) or one wei of TAO below it; the stake's own minimum is 0, the floor, or the route's pay and a
    /// wei more. One draw in sixteen the oracle cannot answer ("OLD"), and one in sixteen the door has no oracle (its
    /// setOracle is a scheduled item: 48 hours each way pass here; NoOracle). Every refusal is predicted (the header's
    /// list); a stake that settles must have taken at least 95% of the oracle's value, measured from what the route paid
    /// (the deposit and the sub-rao dust the staker keeps).
    function stake(uint256 actorSeed, uint256 usdcSeed, uint256 rateSeed, uint256 minSeed) external step {
        address actor = actors[actorSeed % actors.length];
        uint256 usdcIn = bound(usdcSeed, 500e6, 25_000e6);
        uint256 mode = (rateSeed >> 128) % 16;
        twap.setPrice(bound(rateSeed >> 8, 240e6, 260e6));
        uint256 swapped = usdcIn - usdcIn * staker.swapFeeBps() / 10_000;
        uint256 floor = twap.taoValue(swapped) * (10_000 - staker.MAX_BUY_SLIPPAGE_BPS()) / 10_000;
        // the route's rate, USDC in for TAO out (MockSwapRouter mints swapped * rate / 1e18), rounded up so it pays its
        // target at least (a wei more at most); an honest router (it refuses under the stake's minimum)
        router.setRate(address(usdc), Math.ceilDiv(_stakeTarget(floor, swapped, rateSeed) * 1e18, swapped));
        router.setLies(false);
        uint256 out = swapped * router.rate(address(usdc)) / 1e18;
        uint256 minOut = minSeed % 3 == 0 ? 0 : minSeed % 3 == 1 ? floor : out + 1;
        if (mode == 1) twap.setReverts(true);
        if (mode == 2) _setOracle(address(0));
        bytes4 expect = _stakeRefusal(actor, mode, out, minOut, floor);
        usdc.mint(actor, usdcIn);
        vm.prank(actor);
        usdc.approve(address(staker), usdcIn);
        uint256 dustBefore = tao.balanceOf(address(staker));
        _readLogs();
        vm.prank(actor);
        try staker.stake(actor, usdcIn, minOut, 0, vm.getBlockTimestamp()) returns (uint256 deposited) {
            _succeeded(expect);
            ++stakesSettled;
            // the staker's depositFor for the actor restarts the actor's cancel clock (R11)
            _noteDeposit(fd, actor);
            uint256 paid = deposited + (tao.balanceOf(address(staker)) - dustBefore);
            if (paid < floor) ++stakesBelowFloor;
            if (paid < floor + floor / 100) ++stakesNearFloor;
        } catch (bytes memory reason) {
            _dropLogs();
            _countStakeRefusal(reason, expect, mode);
        }
        if (mode == 1) twap.setReverts(false);
        if (mode == 2) _setOracle(address(twap));
        _raiseFloor();
    }

    /// A refused stake: as predicted (an Error(string): the oracle's "OLD" or the router's "Too little received"), each
    /// counted by its cause, else unexpected.
    function _countStakeRefusal(bytes memory reason, bytes4 expect, uint256 mode) internal {
        bytes4 err = bytes4(keccak256("Error(string)"));
        bool predicted = expect == err
            ? keccak256(reason)
                == keccak256(abi.encodeWithSignature("Error(string)", mode == 1 ? "OLD" : "Too little received"))
            : expect != 0 && _selector(reason) == expect;
        if (!predicted) ++unexpectedReverts;
        else if (expect == CascadeStaker.BelowOracleFloor.selector) ++stakesRefusedFloor;
        else if (expect == CascadeStaker.NoOracle.selector) ++stakesRefusedNoOracle;
        else if (mode == 1) ++stakesRefusedOracle;
        else if (expect == err) ++stakesRefusedMinimum;
        else ++stakesRefusedDoor;
    }

    /// The TAO the route pays for `swapped` USDC (see stake): 90% to 105% of the oracle's value, or one draw in four
    /// exactly the floor, or a wei below it.
    function _stakeTarget(uint256 floor, uint256 swapped, uint256 seed) internal view returns (uint256) {
        if (seed % 4 == 0) return (seed >> 2) % 2 == 0 ? floor : floor - 1;
        return twap.taoValue(swapped) * bound(seed >> 3, 9_000, 10_500) / 10_000;
    }

    /// The stake's refusal, in the staker's order (see the header): the oracle's (its revert, or none), the router's
    /// minimum, the buy floor, then the door's limits on the deposit (the route's pay floored to rao).
    function _stakeRefusal(address actor, uint256 mode, uint256 out, uint256 minOut, uint256 floor)
        internal
        view
        returns (bytes4)
    {
        if (mode == 1) return bytes4(keccak256("Error(string)"));
        if (mode == 2) return CascadeStaker.NoOracle.selector;
        if (out < minOut) return bytes4(keccak256("Error(string)"));
        if (out < floor) return CascadeStaker.BelowOracleFloor.selector;
        uint256 amount = out - out % RAO;
        (,, uint256 open,, uint256 nDeposits,) = fd.openBatch();
        if (amount < fd.minDeposit()) return CascadeFrontDoor.BelowMinDeposit.selector;
        if (fd.netForwarded() + open + amount > fd.depositCap()) return CascadeFrontDoor.CapExceeded.selector;
        if (open + amount > fd.maxBatchValue()) return CascadeFrontDoor.BatchValueFull.selector;
        if (fd.depositOf(actor) == 0 && nDeposits >= fd.maxDeposits()) return CascadeFrontDoor.BatchFull.selector;
        return 0;
    }

    /// The front door's oracle becomes `o`, as its scheduled setOracle makes it (48 hours pass).
    function _setOracle(address o) internal {
        _runScheduled(fd, abi.encodeCall(CascadeFrontDoor.setOracle, (ICascadeTwap(o))));
        require(address(fd.oracle()) == o, "the oracle");
    }

    // ---- vault: keeper and permissionless ----

    /// @dev Warps 24 hours past the payout delay of a queued batch (preferring one with 2 or more entries
    /// left, which can go out in several chunks) and sends its next chunk of 1 to CHUNK_ENTRIES entries
    /// (from the seed) from the stored list, at the Bittensor lane's fee and top-up `feeSeed` draws (_payoutFee).
    function processPayouts(uint256 keySeed, uint256 feeSeed) external step {
        _processPayouts(keySeed, feeSeed);
    }

    /// The payout chunk. The chunk and the ceiling its entries pay of the fee (the larger of 1% of the chunk and
    /// MAX_FEE_ABS) are VaultModel's restatements (CascadePayoutMath.takeChunk and feeSplit). The Bittensor lane's fee
    /// for this send, by `feeSeed` mod 4: the world's (0, 1), up to the ceiling (2), or above it up to twice it (3),
    /// whole rao, put back after; the call's value, none or the whole fee (bit 2), so a fee above the ceiling needs
    /// that top-up, else FeeTooHigh, and the whole fee pays all of it, the entries charged nothing (the full top-up,
    /// R4). Past those, the refusal is VaultModel's _chunkOutcome, on the chunk's need at this
    /// fee: UnstakeShort when the walk leaves more than T untaken or its receipts do not fund the send, FeeTooHigh when
    /// its cost would leave an entry nothing; none otherwise, and a success where one was predicted is unexpected. The
    /// walk's cost is the chunk's entries' (Task 36b), never the holders': I-35 around the call.
    function _processPayouts(uint256 keySeed, uint256 feeSeed) internal {
        uint256 n = queuedKeys.length;
        if (n == 0) return;
        bytes32 key = _keyWith(keySeed, _entriesLeft, 2);
        // casting to 'uint32' is safe because the value is at most CHUNK_ENTRIES
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 maxEntries = uint32(1 + (keySeed / n) % CHUNK_ENTRIES);
        // the payout delay is the vault's
        _warp(24 hours, vaultBlockTime);
        CascadeMessages.Payout[] memory list = lists[key];
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        // test-controlled time
        // forge-lint: disable-next-line(block-timestamp)
        bool due = vm.getBlockTimestamp() >= uint256(b.queuedAt) + vaultLens.payoutDelay();
        // L3's prepare, in its order (CascadePayoutLib: the delay, the batch's door, the primary bridge), before the
        // fee and the walk
        bool doorDown = vaultLens.doorState(peer) != DoorState.Active;
        bool bridgeDown = !vaultLens.bridgeEnabled(vaultLens.primaryBridge());
        uint256 worldFee = bridge.fee();
        (uint256 sum, uint256 ceiling) = _chunkCeiling(list, b, maxEntries);
        uint256 fee = _payoutFee(feeSeed, worldFee, ceiling);
        uint256 value = (feeSeed >> 2) % 2 == 0 ? 0 : fee;
        // the entries are charged the fee up to the ceiling, floored to rao (VaultModel's feeSplit; the fee is whole
        // rao already); the call's value tops up the rest; a value of the whole fee pays it all (the full top-up, R4)
        (, uint256 charged) = _feeSplit(fee, sum);
        bool feeShort = value < fee - charged;
        // the walk, its cost and finish's checks, predicted on what the chunk pays at this fee (Task 36b; its removals,
        // Task 36's fix round 2)
        ChunkOut memory o = _chunkOutcome(list, b, maxEntries, fee, value);
        bool missing = vaultLens.stakeMissing();
        uint256 stakeBefore = _coldkeyStake();
        uint256[3] memory mark = _markPrice();
        bridge.setFee(fee);
        _readLogs();
        try vault.processPayouts{value: value}(key, list, maxEntries) {
            // a predicted refusal lost (and a batch not yet due is never here)
            if (!due || doorDown || bridgeDown || feeShort || o.refusal != 0) ++unexpectedReverts;
            Vm.Log[] memory logs = _readLogs();
            _recordPayout(key, logs);
            // the walk's cost is the chunk's entries' (PayoutChunkSent's unstakeCost): never the holders' (I-35)
            _exitRemovals(logs, stakeBefore);
            _checkExitPrice(mark);
            _checkWalk(logs, o.walk);
            PayoutBatch memory a = vaultLens.getPayoutBatch(key);
            bouncesPaid += _bounces(list, b.cursor, a.count == 0 ? list.length : a.cursor);
            if (a.count == 0) _dropKey(key);
            else ++partialChunks;
            if (missing) ++payoutsWhileMissing;
            if (value != 0 && fee > charged) ++topUpChunks;
            if (value != 0 && value >= fee) ++fullTopUps;
            _raiseFloor();
        } catch (bytes memory reason) {
            _dropLogs();
            bytes4 r = _selector(reason);
            if (!due) {
                // a batch not yet due: never here (the action waits out the delay), so any outcome is unexpected
                ++unexpectedReverts;
            } else if (doorDown) {
                if (r == FrontDoorInactive.selector) ++payoutsRefusedDoorDown;
                else ++unexpectedReverts;
            } else if (bridgeDown) {
                // no action here disables a bridge; a campaign whose actions do meets this refusal
                _refused(reason, PrimaryBridgeDisabled.selector);
            } else if (feeShort) {
                if (r == FeeTooHigh.selector) ++payoutsFeeRefused;
                else ++unexpectedReverts;
            } else if (o.refusal != 0 && r == o.refusal) {
                if (r == FeeTooHigh.selector) {
                    ++chunksRefusedWalkCost;
                } else {
                    ++payoutsUncoverable;
                    _dustBlocked(reason);
                }
            } else {
                ++unexpectedReverts;
            }
        }
        bridge.setFee(worldFee);
    }

    /// The Bittensor lane's fee for one payout chunk whose entries pay at most `ceiling` (see _processPayouts), whole
    /// rao.
    function _payoutFee(uint256 seed, uint256 worldFee, uint256 ceiling) internal pure returns (uint256) {
        uint256 kind = seed % 4;
        if (kind < 2) return worldFee;
        uint256 top = ceiling / RAO;
        uint256 rao = kind == 2 ? bound(seed >> 3, 0, top) : bound(seed >> 3, top + 1, 2 * top + 1);
        return rao * RAO;
    }

    /// @dev The keeper stakes the idle balance. A fresh position's read can come back one rao short of what was
    /// staked (the mock's setFreshRead): that rao is gone and the holders absorb it, I-4's last exception, recorded
    /// here from the vault's own Staked event (what it staked against what it measured).
    function stakeIdle() external step {
        uint256 idle = _availableAt(vaultLens.pendingPayouts());
        if (idle / RAO < MIN_STAKE_RAO) return;
        bool missing = vaultLens.stakeMissing();
        uint256 heldBefore = staking.getStake(hotkey, vaultLens.coldkey(), 0);
        _readLogs();
        try vault.stakeIdle() {
            ++stakes;
            if (missing) ++stakesWhileMissing;
            _freshRead(_readLogs(), heldBefore);
            _raiseFloor();
        } catch {
            _dropLogs();
            ++unexpectedReverts;
        }
    }

    /// @dev Accrues `rao` of root rewards on the hotkey and claims them as the keeper, under whatever
    /// reward cut is set (none until claimWithCut sets one).
    function accrueAndClaim(uint256 rao) external step mints {
        _claim(rao);
    }

    /// @dev As the owner, sets the reward cut to `bps` (0 to MAX_REWARD_CUT_BPS; 0 turns it off), which
    /// stays set for later claims, then accrues and claims `rao` as accrueAndClaim does. A cut kept or lowered is
    /// set at once; a raise, or the first naming of the treasury, is a loosening, scheduled and executed through
    /// the scheduler fixture (its 48 hours pass here, before the claim). It runs from whatever state the run
    /// reached: a schedule still vesting, payouts pending, a vault below half the launch price or underwater (where
    /// the cut is skipped), stake missing (skipped too).
    function claimWithCut(uint256 bps, uint256 rao) external step mints {
        // casting to 'uint16' is safe because bps is bounded to MAX_REWARD_CUT_BPS
        // forge-lint: disable-next-line(unsafe-typecast)
        uint16 cut = uint16(bound(bps, 0, vaultLens.MAX_REWARD_CUT_BPS()));
        bytes memory data = abi.encodeCall(CascadeVault.setRewardCut, (treasury, cut));
        if (vaultLens.treasury() == treasury && cut <= vaultLens.rewardCutBps()) {
            vm.prank(owner);
            vault.setRewardCut(treasury, cut);
        } else if (_looseningRefused(data)) {
            // the claim runs under the cut in force
            _claim(rao);
            return;
        } else {
            _runScheduled(vault, data);
            ++cutLoosenings;
        }
        require(vaultLens.treasury() == treasury && vaultLens.rewardCutBps() == cut, "the cut");
        _claim(rao);
    }

    /// @dev Sets the owner's reward vesting period anywhere in [1 day, 30 days]: an increase, or the same, directly
    /// (immediate); a decrease, a loosening, as a scheduled item through the scheduler fixture, its 48 hours waited
    /// here before it executes. A change applies from the next restart only, so it moves no price, read right before
    /// and right after the change; the price floor and the cut invariants then run across period changes, and
    /// _claim checks that no restart speeds a remainder up.
    function setVesting(uint256 period) external step {
        // casting to 'uint64' is safe because period is bounded to 30 days
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 p = uint64(bound(period, 1 days, 30 days));
        bytes memory data = abi.encodeCall(CascadeVault.setRewardVesting, (p));
        bool loosens = p < vaultLens.rewardVesting();
        if (loosens && _looseningRefused(data)) return;
        if (loosens) _scheduleAndWait(vault, data);
        uint256 priceBefore = vaultLens.price();
        vm.prank(owner);
        if (loosens) {
            vault.execute(data);
            ++vestingLoosenings;
        } else {
            vault.setRewardVesting(p);
        }
        require(vaultLens.rewardVesting() == p, "the period");
        if (vaultLens.price() != priceBefore) ++vestingPriceMoves;
        ++vestingChanges;
        _raiseFloor();
    }

    // ---- vault: direct users ----

    /// @dev A direct deposit sets the actor's redeem origin to DIRECT_ORIGIN (Task 18), which the front door never
    /// burns for; the handler sets it back to the door's chain unless the amount in rao is 3 mod 4, so both paths
    /// stay in use and the vault's origin skip is reached too. Its refusals, in the vault's order: StakeMissing
    /// while stake is missing (I-1: a success there is a guard miss), VaultInsolvent below half the launch price or
    /// underwater (both reachable after a loss; the second at a supply of 0, where the half line reads 0 < 0), and
    /// CapExceeded above the cap.
    function depositDirect(uint256 actorSeed, uint256 amount) external step mints {
        address actor = actors[actorSeed % actors.length];
        uint256 maxRao = Math.min(MAX_DEPOSIT, _sub0(actor.balance, FEE_MONEY)) / RAO;
        if (maxRao < 1e15 / RAO) return;
        amount = bound(amount, 1e15 / RAO, maxRao) * RAO;
        bool missing = vaultLens.stakeMissing();
        uint256 assets = vaultLens.totalAssets();
        bytes4 expect;
        if (missing) expect = StakeMissing.selector;
        else if (assets * 2_000_000 < vault.totalSupply() || _underwater()) expect = VaultInsolvent.selector;
        else if (assets + amount > vaultLens.maxTotalAssets()) expect = CapExceeded.selector;
        uint256 sharesBefore = vault.balanceOf(actor);
        _readLogs();
        vm.prank(actor);
        try vault.depositDirect{value: amount}() {
            ghostIn += amount;
            _noteFresh(actor, vault.balanceOf(actor) - sharesBefore);
            if (missing) ++guardMisses;
            else _succeeded(expect);
            ++directDeposits;
            if ((amount / RAO) % 4 != 3) _optIn(actor);
            _raiseFloor();
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, expect) && missing) ++depositsRefusedWhileMissing;
        }
    }

    /// @dev An unflagged direct redeem of 1 to all of an actor's shares: StakeMissing while stake is missing (I-1: a
    /// success there is a guard miss), else VaultModel's _exitPlan: ZeroAmount under a rao or when the walk's cost
    /// leaves the leaver nothing, UnstakeShort when the walk leaves more than T untaken (dust-blocked here). The walk's
    /// cost is the leaver's (Task 36b): I-13's direct half measured on both sides, as the flagged exit's
    /// (_shortfallMispaid: what the walk left unmet from the coldkey's stake drop, its cost from the vault's balance
    /// against that drop, ShortfallAbsorbed their sum and the pay the rest, floored), the pay and ShortfallAbsorbed
    /// also the plan's, and I-35 around the call.
    function redeemDirect(uint256 actorSeed, uint256 shares) external step {
        (address actor, uint256 balance) = _actorWith(actorSeed, _shares);
        if (balance == 0) return;
        shares = bound(shares, 1, balance);
        bool missing = vaultLens.stakeMissing();
        uint256 out = CascadeMath.assetsForRedeem(shares, vaultLens.totalAssets(), vault.totalSupply());
        out -= out % RAO;
        // the liquidity redeemDirect reads once, before its walk; the walk's removals, its cost and the pay, predicted
        // (Task 36's fix round 2; Task 36b)
        uint256 liquid = _availableAt(vaultLens.pendingPayouts());
        ExitOut memory e = _exitPlan(liquid, out);
        bytes4 expect = missing ? StakeMissing.selector : e.refusal;
        uint256 before = actor.balance;
        uint256 vaultBefore = address(vault).balance;
        uint256 stakeBefore = _coldkeyStake();
        uint256[3] memory mark = _markPrice();
        _readLogs();
        vm.prank(actor);
        try vault.redeemDirect(shares, false) {
            _capFresh(actor);
            uint256 paid = actor.balance - before;
            ghostOut += paid;
            if (missing) ++guardMisses;
            else _succeeded(expect);
            Vm.Log[] memory logs = _readLogs();
            _exitRemovals(logs, stakeBefore);
            _checkWalk(logs, e.walk);
            _checkExitPrice(mark);
            if (!missing && _directExitMispaid(e, out, liquid, vaultBefore, stakeBefore, paid, logs)) ++directMispaid;
            ++directRedeems;
            _raiseFloor();
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, expect)) _countExitRefusal(reason, expect, out, missing);
        }
    }

    /// Whether an unflagged direct exit worth `out` (floored to rao), with `liquid` read before its walk, broke I-13's
    /// direct half (Task 36b's fix round 1, the review's Minor 1), measured as the flagged exit's is: the walk's receipts
    /// from the vault's balance (`vaultBefore`, moved by the receipts less the pay), the stake it took from the
    /// coldkey's stake drop (`stakeBefore`), ShortfallAbsorbed from its logs, then _shortfallMispaid; and the pay and
    /// ShortfallAbsorbed against the plan `e`.
    function _directExitMispaid(
        ExitOut memory e,
        uint256 out,
        uint256 liquid,
        uint256 vaultBefore,
        uint256 stakeBefore,
        uint256 paid,
        Vm.Log[] memory logs
    ) internal view returns (bool) {
        uint256 borne = _absorbed(logs);
        uint256 received = _sub0(address(vault).balance + paid, vaultBefore);
        uint256 taken = _sub0(stakeBefore, _coldkeyStake()) * RAO;
        return
            _shortfallMispaid(out, liquid, taken, received, paid, borne) || paid != e.paid || borne != e.unmet + e.cost;
    }

    /// A direct exit refused as predicted, counted by its state: while stake is missing, else the walk's reach (an
    /// UnstakeShort, dustBlocked when the only stake sits below the minimum), else its cost (a ZeroAmount of an exit
    /// worth a rao or more).
    function _countExitRefusal(bytes memory reason, bytes4 expect, uint256 out, bool missing) internal {
        if (missing && expect == StakeMissing.selector) ++redeemsRefusedWhileMissing;
        else if (expect == UnstakeShort.selector) _dustBlocked(reason);
        else if (expect == ZeroAmount.selector && out >= RAO) ++exitsRefusedByCost;
    }

    /// @dev While stake is missing (swapAway left it so): a direct deposit and an unflagged direct redeem must revert
    /// StakeMissing (I-1); a holder's redeem of 1 to all of its shares with acceptMissing must pay exactly their value
    /// at min(visible, booked), floored to the rao, less what its receipts left unmet, the vault's assets must fall by
    /// exactly what it paid and what the holders absorbed of its receipts, and every other holder's redeemable value
    /// (the other actors' and the treasury's) must not fall by more than its share of that, nor rise by more than the
    /// leaver's rounding. Nothing when no stake is missing.
    function redeemDirectWhileMissing(uint256 actorSeed, uint256 shares) external step {
        if (!vaultLens.stakeMissing()) return;
        (address actor, uint256 balance) = _actorWith(actorSeed, _shares);
        if (balance == 0) return;
        shares = bound(shares, 1, balance);
        _refusedWhileMissing(actor, shares);
        _consentedExit(actor, shares);
        _raiseFloor();
    }

    // ---- validators: the hotkey swap ----

    /// @dev A validator's swap moves `bps` (1 to 10_000) of the vault's stake on its hotkey to the unlisted SWAPPED,
    /// where it stays until restoreStake: the price reads min(visible, booked), so it falls by the priced stake that
    /// left the set (I-4's first exception, recorded here, its bound that stake); past the tolerance the guard holds
    /// (stakeMissing). Counted within the tolerance or past it.
    function swapAway(uint256 bps) external step {
        bytes32 cold = vaultLens.coldkey();
        uint256 heldBefore = staking.getStake(hotkey, cold, 0);
        if (heldBefore == 0) return;
        uint256 booked_ = booked();
        staking.swapHotkey(hotkey, SWAPPED, cold, bound(bps, 1, 10_000));
        // the priced stake that left the set, from the mock's own positions (the one listed hotkey), not the lens
        uint256 heldAfter = staking.getStake(hotkey, cold, 0);
        uint256 left = (Math.min(heldBefore, booked_) - Math.min(heldAfter, booked_)) * RAO;
        if (vaultLens.stakeMissing()) ++swapsMissing;
        else ++swapsWithinTolerance;
        if (left != 0) {
            ++i4Swaps;
            _exception(left);
        }
    }

    /// @dev The swap undone, as a listing of SWAPPED (or the validator's swap back) would undo it: the stake comes
    /// back into the set, so the price can only rise; what a flagged leaver gave up stays with the stayers.
    function restoreStake() external step {
        bytes32 cold = vaultLens.coldkey();
        if (staking.getStake(SWAPPED, cold, 0) == 0) return;
        staking.swapHotkey(SWAPPED, hotkey, cold, 10_000);
        ++restores;
        if (_gap() == 0) holeWei = 0;
        _raiseFloor();
    }

    /// @dev Re-runs the oldest delivery the bridge filed as refused (a batch the vault refused while stake was missing
    /// or at a supply of 0 underwater, MockBridge's form of the adapter's park): it delivers once the state allows,
    /// else the bridge files it again, as expected while that state lasts.
    function retryDelivery() external step mints {
        if (bridge.failedCount() == 0) return;
        _ageShares();
        uint256 delivered = deliveries;
        bool underwater0 = vault.totalSupply() == 0 && _underwater();
        bool missing0 = vaultLens.stakeMissing();
        _readLogs();
        bridge.retryNext();
        _recordDelivery(_readLogs(), missing0, underwater0);
        if (deliveries > delivered) ++retriesDelivered;
        _raiseFloor();
    }

    /// @dev The chain's fee on each stake removal (MockStaking.setRemoveFeeRao), VaultModel's draw (_removeFeeDraw: 0
    /// one draw in three, else 1 to 1,000 rao one in three, else 1,001, 50,000, 4,000,000 or 16,000,000 rao), each the
    /// walking exit's own cost (Task 36b).
    function setRemoveFee(uint256 seed) external step {
        uint256 fee = _removeFeeDraw(seed);
        if (fee != staking.removeFeeRao()) ++feeSwitches;
        staking.setRemoveFeeRao(fee);
        // the unstake margin too (Task 42, Task 36b's Minor 4: I-35 holds at any margin): the owner's, immediate both ways,
        // 0 three draws in six, else 1, 1,000, 1,000,000 or 1e9 rao (the 1 TAO bound); VaultModel's walk reads it
        uint256 margin = [uint256(0), 0, 0, 1, 1_000, 1_000_000, 1e9, 1e9][(seed >> 64) % 8];
        if (margin != vaultLens.unstakeMarginRao()) {
            vm.prank(owner);
            vault.setUnstakeMarginRao(margin);
            ++marginSwitches;
        }
    }

    /// @dev Whether a credit into an empty position reads one rao short (MockStaking.setOneRaoShort), as a fresh
    /// position's read can on the chain.
    function setFreshRead(uint256 seed) external step {
        bool short = seed % 2 == 1;
        // exactStakeReads is the mock's inverse of the one-rao-short read
        if (short == staking.exactStakeReads()) ++readSwitches;
        staking.setOneRaoShort(short);
    }

    // ---- the door: removals and the ways back (Task 34a) ----

    /// @dev The owner or the guardian (doorDraw) removes the launch door, on one call in eight and at most MAX_REMOVALS
    /// times a run. An active door's removal counts it out (the launch chain's last: the remover's hold, its clock
    /// stamped); the owner's leaves it Removed, the guardian's makes it unknown. The guardian may also remove a door the
    /// owner removed (Task 10b): it becomes unknown, its pending Reopen is deleted, and the owner's hold becomes the
    /// guardian's. Any other removal (the owner's of a door not active, the guardian's of an unknown one) must revert
    /// PeerNotActive. A draw that removes nothing, while the door is down, brings it back as reopenDoor does (the honest
    /// owner answering the removal), so a removal lasts a few calls, not the rest of the run, and the paths that need
    /// the door stay reached.
    function removeDoor(uint256 seed) external step {
        (bool acts, bool byGuardian,) = doorDraw(seed);
        if (!acts) {
            if (vaultLens.doorState(peer) != DoorState.Active) _bringBack(seed);
            return;
        }
        if (removalsByOwner + removalsByGuardian >= MAX_REMOVALS) return;
        _removeDoor(byGuardian);
    }

    /// @dev A targeted draw (Task 42, ruling B9: the thin guardianRemovalsOfRemoved and reopensDeleted): with the door
    /// active and both of the run's removals left, the owner removes it, schedules its Reopen and leaves it pending,
    /// and the guardian removes the owner-removed door, deleting that Reopen and taking the hold.
    function removeTwice() external step {
        if (removalsByOwner + removalsByGuardian + 2 > MAX_REMOVALS) return;
        if (vaultLens.doorState(peer) != DoorState.Active) return;
        _removeDoor(false);
        if (vaultLens.doorState(peer) != DoorState.Removed) return;
        bytes32 id = keccak256(_activation());
        if (vaultLens.scheduled(id).readyAt == 0) {
            _ownerSchedules(vault, _activation());
            ++reopensScheduled;
        }
        _removeDoor(true);
        ++removeTwiceDraws;
    }

    /// removeDoor's removal by the owner or the guardian (see removeDoor).
    function _removeDoor(bool byGuardian) internal {
        DoorState s = vaultLens.doorState(peer);
        bytes32 reopen = keccak256(_activation());
        bool reopenPending = vaultLens.scheduled(reopen).readyAt != 0;
        bytes4 expect =
            s == DoorState.Active || (byGuardian && s == DoorState.Removed) ? bytes4(0) : PeerNotActive.selector;
        // spec §3.6: the launch chain's last active door, or the guardian's removal of an owner-removed launch-chain
        // door while the launch door's hold is the owner's, closes the exits, records its remover and stamps its clock
        bool closesExits = (s == DoorState.Active && vaultLens.activeDoors(doorChain) == 1)
            || (s == DoorState.Removed && byGuardian && vaultLens.launchDoorRemovedBy() == Actor.Owner);
        _readLogs();
        vm.prank(byGuardian ? guardian : owner);
        try vault.removeFrontDoor(doorChain, address(fd)) {
            _succeeded(expect);
            if (byGuardian) ++removalsByGuardian;
            else ++removalsByOwner;
            if (s == DoorState.Removed) {
                ++guardianRemovalsOfRemoved;
                // its Reopen deleted, and the launch door's hold made the guardian's
                if (reopenPending) {
                    if (vaultLens.scheduled(reopen).readyAt == 0) ++reopensDeleted;
                    else ++unexpectedReverts;
                }
            }
            if (vaultLens.doorState(peer) != (byGuardian ? DoorState.Unknown : DoorState.Removed)) ++unexpectedReverts;
            if (closesExits) {
                uint256 clock = byGuardian ? vaultLens.lastGuardianClose() : vaultLens.lastOwnerClose();
                if (vaultLens.launchDoorRemovedBy() != (byGuardian ? Actor.Guardian : Actor.Owner)) {
                    ++unexpectedReverts;
                }
                if (vaultLens.exitsOpen() || clock != vm.getBlockTimestamp()) ++unexpectedReverts;
            }
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, expect)) ++removalsRefused;
        }
    }

    /// @dev Brings the launch door back. Removed (the owner's removal): the owner's Reopen (no gate but the owner's
    /// clock), scheduled when none is pending or the pending one is dead (lapsed past its window, or killed by an owner
    /// stamp since, such as a launch-door cancel's), then on one draw in three (doorDraw) left pending for a later call, else its 7
    /// days and blocks waited out and executed (Schedule.run's steps). Unknown (the guardian's removal): the guardian
    /// swap (setGuardian, to the same guardian, 8 days) ends the guardian's hold, then the door's Ordinary activation
    /// (7 days) runs from open exits. Either way the door is active again and the hold cleared.
    function reopenDoor(uint256 seed) external step {
        if (vaultLens.doorState(peer) != DoorState.Active) _bringBack(seed);
    }

    /// reopenDoor's way back for a door that is down (see it).
    function _bringBack(uint256 seed) internal {
        DoorState s = vaultLens.doorState(peer);
        bytes memory data = _activation();
        if (s == DoorState.Unknown) {
            // a refusal of either item counts as unexpected (_tryRunScheduled), and the door stays down
            if (!_tryRunScheduled(vault, abi.encodeCall(CascadeBase.setGuardian, (guardian)))) return;
            if (!_tryRunScheduled(vault, data)) return;
            ++swapRestores;
        } else {
            bytes32 id = keccak256(data);
            Item memory it = vaultLens.scheduled(id);
            // lapsed: its windows in time and in blocks (half EXECUTE_WINDOW in the vault's calibrated blocks) both
            // passed (Revision 28); test-controlled time
            uint256 window = vaultLens.EXECUTE_WINDOW();
            // forge-lint: disable-next-line(block-timestamp)
            bool lapsed = vm.getBlockTimestamp() > uint256(it.readyAt) + window
                && vm.getBlockNumber()
                    > uint256(it.readyBlock) + (window * 1000 + 2 * vaultBlockTime - 1) / (2 * vaultBlockTime);
            if (it.readyAt == 0 || lapsed || vaultLens.lastOwnerClose() >= it.scheduledAt) {
                if (it.readyAt != 0) ++reopensRescheduled;
                _ownerSchedules(vault, data);
                ++reopensScheduled;
                it = vaultLens.scheduled(id);
                if (it.kind != Kind.Reopen) ++unexpectedReverts;
                (,, bool leavePending) = doorDraw(seed);
                if (leavePending) return;
            }
            // its delay waited out (the blocks roll with every warp, so its readyBlock is met with its readyAt), then
            // the execute
            Schedule.warpTo(Math.max(vm.getBlockTimestamp(), it.readyAt));
            _raiseFloor();
            _readLogs();
            vm.prank(owner);
            try vault.execute(data) {
                ++reopensExecuted;
            } catch (bytes memory reason) {
                _dropLogs();
                _refused(reason, 0);
                return;
            }
        }
        if (vaultLens.doorState(peer) != DoorState.Active || vaultLens.launchDoorRemovedBy() != Actor.None) {
            ++unexpectedReverts;
        }
        _raiseFloor();
    }

    /// The door actions' draws from `seed`, by a hash, as deliver's thin pool is (the fuzzer's dictionary favours small
    /// seeds, whose low bits a modulo would read): whether removeDoor acts (one in eight, so the door stays up most of
    /// a run and the paths that need it stay reached), whether the guardian removes (one in two), and whether reopenDoor
    /// leaves a fresh Reopen pending for a later call (one in three). Public for the unit tests; no action.
    function doorDraw(uint256 seed) public pure returns (bool acts, bool byGuardian, bool leavePending) {
        uint256 draw = uint256(keccak256(abi.encode(seed, "door")));
        return (draw % 8 == 0, (draw >> 8) % 2 == 1, (draw >> 16) % 3 == 0);
    }

    /// The launch door's activation, its one canonical calldata (one id: spec §3.10.8).
    function _activation() internal view returns (bytes memory) {
        return abi.encodeCall(CascadeVault.activateFrontDoor, (doorChain, address(fd)));
    }

    /// A direct depositor opts back in to the door's chain (setRedeemOrigin): refused UnknownOrigin while no door is
    /// active there (the actor stays DIRECT_ORIGIN, which no door burns for).
    function _optIn(address actor) internal {
        bytes4 expect = vaultLens.activeDoors(doorChain) == 0 ? UnknownOrigin.selector : bytes4(0);
        _readLogs();
        vm.prank(actor);
        try vault.setRedeemOrigin(doorChain) {
            _succeeded(expect);
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, expect)) ++originsRefusedDoorDown;
        }
    }

    /// Whether the vault's Ordinary loosening `data` is refused: while a hold closes the exits, its schedule must
    /// revert ExitsNotOpen (the action then makes no change); otherwise it may be scheduled.
    function _looseningRefused(bytes memory data) internal returns (bool) {
        if (vaultLens.exitsOpen()) return false;
        _readLogs();
        vm.prank(owner);
        try vault.schedule(data) {
            _succeeded(ExitsNotOpen.selector);
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, ExitsNotOpen.selector)) ++looseningsRefused;
        }
        return true;
    }

    // ---- owner ----

    /// @dev Cancels a queued batch's unsent payouts: its redeems are re-minted and its unsent bounces carried
    /// forward, in order, as the batch's new list, still queued (Task 22, spec §3.10.15); with no redeem left it
    /// must revert NothingToCancel. Each re-minted entry gets the shares its value buys at the price before the cancel,
    /// never more than it burned (Task 34c), so the price cannot fall unless the cancel starts with totalAssets()
    /// reading 0 over a hole: I-35 around every other cancel (Task 36b). I-4's cancel bound: the post-cancel price is
    /// at least cancelFloor(key), the floor alone, with one rao per re-minted entry given back over such a hole only
    /// (and, at a supply of 0, the payout gap or the whole shortfall the re-minted holders absorb, Task 36's fix round
    /// 3, or above it the hole such a cancel starts over, _holeOver; at most their value: _cancelGiveBack), and the
    /// floor restarts from the post-cancel price; a cancel that
    /// lowered the price at all counts in i4CancelFalls, and one that did so while totalAssets() read above 0 before it
    /// in cancelFallsWithAssets, which must stay 0.
    function cancelQueued(uint256 keySeed) external step {
        _cancelQueued(keySeed);
    }

    /// @dev A targeted draw (Task 42, ruling B9: the thin partialChunks, cancelsAfterPartial and bouncesCarried): a batch
    /// with two or more entries left sends a chunk of one (the keeper's processPayouts, its fee and top-up drawn), then
    /// the owner cancels it (cancelQueued prefers a batch that sent a chunk), carrying its bounces forward.
    function partialThenCancel(uint256 keySeed, uint256 feeSeed) external step {
        uint256 n = queuedKeys.length;
        if (n == 0) return;
        // a key seed whose chunk is one entry (_processPayouts: 1 + (keySeed / n) % CHUNK_ENTRIES)
        keySeed -= ((keySeed / n) % CHUNK_ENTRIES) * n;
        _processPayouts(keySeed, feeSeed);
        _cancelQueued(keySeed);
        ++partialThenCancelDraws;
    }

    /// cancelQueued's body (see it).
    function _cancelQueued(uint256 keySeed) internal {
        uint256 n = queuedKeys.length;
        if (n == 0) return;
        // prefers a batch that already sent a chunk
        bytes32 key = _keyWith(keySeed, _chunksSent, 1);
        CascadeMessages.Payout[] memory list = lists[key];
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        uint256 carried = _bounces(list, b.cursor, list.length);
        uint256 reMinted = b.count - b.cursor - carried;
        uint256 reMintedValue;
        for (uint256 i = b.cursor; i < list.length; ++i) {
            if (list[i].shares != 0) reMintedValue += list[i].assets;
        }
        bool missing = vaultLens.stakeMissing();
        uint256 priceBefore = vaultLens.price();
        bool withAssets = vaultLens.totalAssets() != 0;
        uint256 gapAllowance = _giveBackNow(false);
        // at a supply of 0, what the re-minted holders absorb beyond that of the whole shortfall (Task 36's fix
        // round 3; a cancel's alone)
        uint256 shortfallBack = _shortfallGiveBackNow();
        uint256 floor_ = cancelFloor(key);
        uint256[3] memory mark = _markPrice();
        bool overHole = _cancelOverAHole(mark);
        // nothing to re-mint must be refused
        bytes4 expect = reMinted == 0 ? NothingToCancel.selector : bytes4(0);
        _readLogs();
        vm.prank(owner);
        try vault.cancelPayoutBatch(key, list) {
            _succeeded(expect);
            uint256 back = _cancelGiveBack(gapAllowance, shortfallBack, _holeOver(mark), reMintedValue);
            lastCancelGiveBack = back;
            if (!cancelBoundMet(vaultLens.totalAssets() + back, vault.totalSupply(), overHole ? reMinted : 0, floor_)) {
                ++cancelDustViolations;
            }
            if (vaultLens.price() < priceBefore) {
                ++i4CancelFalls;
                if (withAssets) ++cancelFallsWithAssets;
            }
            if (overHole) ++cancelsOverAHole;
            else _checkExitPrice(mark);
            priceFloor = vaultLens.price();
            if (gapAllowance != 0) holeWei = 0;
            _shortfallHoleAbsorbed(shortfallBack);
            bouncesCarried += carried;
            if (carried == 0) {
                _dropKey(key);
            } else {
                // the carried list: the unsent bounce entries, in their order
                delete lists[key];
                for (uint256 i = b.cursor; i < list.length; ++i) {
                    if (list[i].shares == 0) lists[key].push(list[i]);
                }
            }
            ++cancels;
            if (missing) ++cancelsWhileMissing;
            if (b.cursor != 0) ++cancelsAfterPartial;
        } catch (bytes memory reason) {
            _dropLogs();
            _refused(reason, expect);
        }
    }

    // ---- outsiders: gifts and cycles ----

    /// @dev Moves 0.001 to 100 TAO of root stake onto the vault's stake hotkey from outside, as a
    /// transferStake from another coldkey would. It is not booked (I-3: only an adoption books a gift, Task 16), and
    /// while nothing is missing it moves neither the price nor the allowance base: the vault prices min(visible,
    /// booked). While stake is missing it makes up part of the gap (I-6: a gift can clear it, harmlessly), so the
    /// price and the base may rise, by at most the missing stake it makes up, and never fall.
    function gift(uint256 rao) external step {
        rao = bound(rao, 1e6, 100e9);
        uint256 baseBefore = base();
        uint256 bookedBefore = booked();
        uint256 priceBefore = vaultLens.price();
        uint256 assetsBefore = vaultLens.totalAssets();
        uint256 covered = Math.min(rao, vaultLens.missingStakeRao()) * RAO;
        staking.donateStake(hotkey, vaultLens.coldkey(), rao);
        if (booked() != bookedBefore) ++giftsBooked;
        if (base() < baseBefore || base() > baseBefore + covered) ++giftBaseRises;
        uint256 p = vaultLens.price();
        if (p < priceBefore || p > CascadeMath.price(assetsBefore + covered, vault.totalSupply())) ++giftPriceMoves;
        ghostGifts += rao * RAO;
        ++gifts;
        if (_gap() == 0) holeWei = 0;
        _raiseFloor();
    }

    /// @dev The keeper adopts the gifts (Task 16): once the surplus on the listed hotkeys (visible above booked) is
    /// at least the chain's minimum and a day has passed since the last adoption, adoptStake must book it and vest it
    /// (no cut), so the price does not move at the adoption (I-4: it rises only as the gift vests) and the surplus
    /// leaves surplusStakeRao() for the gross (the conservation identity holds); before that it must revert
    /// AdoptTooSoon (within the day, checked first) or BelowMinAdoption. It vests on its own drip (Revision 27): the
    /// claim schedule (its amount, start and period) must not move, or the adoption is unexpected, and the drip's
    /// restart, like a claim's of the claim schedule, never ends a carried remainder sooner than its own schedule.
    function adopt() external step {
        uint256 surplus = vaultLens.surplusStakeRao();
        bytes4 expect;
        // test-controlled time
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < uint256(vaultLens.lastAdoptAt()) + 1 days) expect = AdoptTooSoon.selector;
        else if (surplus < MIN_STAKE_RAO) expect = BelowMinAdoption.selector;
        uint256 priceBefore = vaultLens.price();
        uint256 oldEnd = uint256(vaultLens.adoptVestingStart()) + vaultLens.adoptVestingPeriod();
        bytes32 claimSchedule = _claimSchedule();
        _readLogs();
        try vault.adoptStake() {
            if (expect != 0) ++unexpectedAdoptions;
            if (vaultLens.price() != priceBefore) ++adoptPriceMoves;
            if (vaultLens.surplusStakeRao() != 0 || vaultLens.bookedStake() != vaultLens.visibleStakeRao()) {
                ++unexpectedAdoptions;
            }
            if (_claimSchedule() != claimSchedule) ++unexpectedAdoptions;
            if (uint256(vaultLens.adoptVestingStart()) + vaultLens.adoptVestingPeriod() < oldEnd) ++remaindersSpedUp;
            ++adoptions;
            _raiseFloor();
        } catch (bytes memory reason) {
            _dropLogs();
            _refused(reason, expect);
        }
    }

    /// The claim schedule's three fields as one word: an adoption must leave it as it was (Revision 27).
    function _claimSchedule() internal view returns (bytes32) {
        return keccak256(abi.encode(vaultLens.vestingAmount(), vaultLens.vestingStart(), vaultLens.vestingPeriod()));
    }

    /// @dev Cycles capital through the keeper's stake loop, as a griefer would: a direct deposit, the
    /// keeper's stake, then a direct redeem of the shares that deposit minted, all in one block. It must
    /// never raise the allowance base, and when the redeem comes back only off the stake the cycle added (the
    /// booked stake, the ledger, ends no lower than it began) it must leave the base exactly where it was, less
    /// what its unstake receipts came back short (cycleBaseMoves); the window check alone would catch a grown base
    /// only when a delivery burns in that window. A redeem that also unstakes older stake can lower the base:
    /// unstakes come off what is still ramping first, and the stake that left no longer counts. Not while stake is
    /// missing (its deposit is refused StakeMissing, which depositDirect checks).
    function cycle(uint256 actorSeed, uint256 amount) external step mints {
        address actor = actors[actorSeed % actors.length];
        uint256 maxRao = Math.min(MAX_DEPOSIT, _sub0(actor.balance, FEE_MONEY)) / RAO;
        if (maxRao < 1e15 / RAO) return;
        amount = bound(amount, 1e15 / RAO, maxRao) * RAO;
        // within the cap, not below half the launch price, not underwater, nothing missing
        uint256 assets = vaultLens.totalAssets();
        if (assets + amount > vaultLens.maxTotalAssets() || assets * 2_000_000 < vault.totalSupply()) return;
        if (_underwater() || vaultLens.stakeMissing()) return;
        uint256 baseBefore = base();
        uint256 bookedBefore = booked();
        uint256 before = vault.balanceOf(actor);
        _readLogs();
        vm.prank(actor);
        try vault.depositDirect{value: amount}() {
            ghostIn += amount;
            _noteFresh(actor, vault.balanceOf(actor) - before);
        } catch {
            _dropLogs();
            ++unexpectedReverts;
            return;
        }
        _optIn(actor);
        if (_availableAt(vaultLens.pendingPayouts()) / RAO >= MIN_STAKE_RAO) {
            uint256 heldBefore = staking.getStake(hotkey, vaultLens.coldkey(), 0);
            _readLogs();
            try vault.stakeIdle() {
                ++stakes;
                _freshRead(_readLogs(), heldBefore);
            } catch {
                _dropLogs();
                ++unexpectedReverts;
            }
        }
        uint256 shares = vault.balanceOf(actor) - before;
        uint256 out = CascadeMath.assetsForRedeem(shares, vaultLens.totalAssets(), vault.totalSupply());
        uint256 paid = actor.balance;
        uint256 stakeBefore = _coldkeyStake();
        uint256 short;
        ExitOut memory e = _exitPlan(_availableAt(vaultLens.pendingPayouts()), out - out % RAO);
        uint256[3] memory mark = _markPrice();
        _readLogs();
        vm.prank(actor);
        try vault.redeemDirect(shares, false) {
            _capFresh(actor);
            ghostOut += actor.balance - paid;
            Vm.Log[] memory logs = _readLogs();
            short = _exitRemovals(logs, stakeBefore);
            _checkWalk(logs, e.walk);
            _checkExitPrice(mark);
            // a predicted refusal lost
            _succeeded(e.refusal);
            ++cycles;
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, e.refusal)) _countExitRefusal(reason, e.refusal, out, false);
        }
        uint256 baseAfter = base();
        if (booked() < bookedBefore) {
            ++cyclesIntoOlderStake;
            if (baseAfter > baseBefore) ++cycleBaseMoves;
        } else if (baseAfter != _sub0(baseBefore, short)) {
            ++cycleBaseMoves;
        }
        _raiseFloor();
    }

    // ---- losses ----

    /// @dev Rarely (seed % 7 == 0, on at most MAX_LOSSES calls a run) takes TAO out of the vault, as a
    /// lost or misread position would: between half and all of the liquid balance that is neither the
    /// existential reserve nor reserved for queued payouts (so every queued payout stays fundable and
    /// a payout's UnstakeShort stays unexpected), floored to rao. A large one makes the vault insolvent,
    /// so later deliveries bounce their deposits. A loss lowers the price, by at most what it took (I-4's
    /// exception, recorded here), and the floor restarts from the post-loss price.
    function simulateLoss(uint256 seed) external step {
        if (seed % 7 != 0 || losses >= MAX_LOSSES) return;
        uint256 balance = address(vault).balance;
        uint256 free = _availableAt(vaultLens.pendingPayouts());
        uint256 x = bound(seed / 7, free / 2, free);
        x -= x % RAO;
        if (x == 0) return;
        vm.deal(address(vault), balance - x);
        ghostLoss += x;
        ++losses;
        _exception(x);
    }

    // ---- time ----

    /// @dev Time on both chains: rolled at the front door's calibrated 120 ms blocks, which meet the vault's 7,200 ms
    /// scheduler's block floor too (`_warp`).
    function warp(uint256 secs) external step {
        _warp(bound(secs, 1 hours, 3 days), doorBlockTime);
    }

    // ---- I-36's model of the fresh shares ----

    /// Adds `minted` shares to `user`'s fresh shares in the model: while the run is still held they join it and the clock
    /// moves to the share-weighted mean of the run's and now, rounded up (S-L3); after that the run restarts at now with
    /// them alone. A mint of nothing changes nothing.
    function _noteFresh(address user, uint256 minted) internal {
        if (minted == 0) return;
        uint256 still = _freshNow(user);
        uint256 t = vm.getBlockTimestamp();
        ghostFreshAt[user] = still == 0
            ? t
            : ghostFreshAt[user] + Math.mulDiv(t - ghostFreshAt[user], minted, still + minted, Math.Rounding.Ceil);
        ghostFresh[user] = still + minted;
    }

    /// After `user`'s direct exit: the model's bucket lowered to the balance the exit left, as the vault's is (R6 A,
    /// redeemDirect), so a later mint's clock weighs only shares the holder still holds.
    function _capFresh(address user) internal {
        uint256 left = vault.balanceOf(user);
        if (ghostFresh[user] > left) ghostFresh[user] = left;
    }

    /// The shares the Deposited events of batch `key` before log `end` minted for `user`: what that delivery minted for
    /// it before its redeems (its deposits are credited first).
    function _mintedHere(Vm.Log[] memory logs, uint256 end, bytes32 key, address user)
        internal
        view
        returns (uint256 minted)
    {
        for (uint256 j; j < end; ++j) {
            Vm.Log memory l = logs[j];
            if (!_isVaultLog(l, Deposited.selector) || l.topics[1] != key) continue;
            // casting to 'uint160' is safe because the topic is an indexed address
            // forge-lint: disable-next-line(unsafe-typecast)
            if (address(uint160(uint256(l.topics[2]))) != user) continue;
            (, uint256 shares) = abi.decode(l.data, (uint256, uint256));
            minted += shares;
        }
    }

    /// `user`'s fresh shares aged at the vault (TrackedHandler._age) and in the model alike.
    function _age(address user) internal override {
        super._age(user);
        ghostFresh[user] = 0;
    }

    /// `user`'s fresh shares in the model now: the run's shares while its last mint is younger than STAKE_RAMP, else 0.
    function _freshNow(address user) internal view returns (uint256) {
        return vm.getBlockTimestamp() < ghostFreshAt[user] + STAKE_RAMP ? ghostFresh[user] : 0;
    }

    // ---- views ----

    function queuedCount() external view returns (uint256) {
        return queuedKeys.length;
    }

    /// Batch `key`'s full payout list as the handler keeps it (not in the fuzzer's selectors).
    function listOf(bytes32 key) external view returns (CascadeMessages.Payout[] memory) {
        return lists[key];
    }

    function claimCount() external view returns (uint256) {
        return claimPriceBefore.length;
    }

    function deliveryCount() external view returns (uint256) {
        return deliveryFloor.length;
    }

    /// The vault's booked stake, in rao, through the lens (bookedStake(), rulings A19 and DA10), and its
    /// ramping stake, in wei, through the lens too (rampingStake(), R2 F4); both checked by
    /// test_handlerReadsTheLedgerAndTheBase.
    function booked() public view returns (uint256) {
        return vaultLens.bookedStake();
    }

    function ramping() public view returns (uint256) {
        return vaultLens.rampingStake();
    }

    /// The vault's allowance base, as it computes it (I-5): min(visible stake, booked stake), in wei, less what
    /// is still ramping in, linearly over a day from the last stake.
    function base() public view returns (uint256) {
        // test-controlled time
        // forge-lint: disable-next-line(block-timestamp)
        uint256 elapsed = vm.getBlockTimestamp() - vaultLens.lastStakeAt();
        uint256 unspent = elapsed >= 1 days ? 0 : ramping() * (1 days - elapsed) / 1 days;
        return _sub0(Math.min(vaultLens.visibleStakeRao(), booked()) * RAO, unspent);
    }

    // ---- internal ----

    /// The front door's swapper becomes `s`, as its scheduled setSwapper makes it (setSwapper is scheduled only,
    /// Task 11): through the scheduler fixture, its 48 hours waited, read back through the getter.
    function _setSwapper(address s) internal {
        _runScheduled(fd, abi.encodeCall(CascadeFrontDoor.setSwapper, (s)));
        require(fd.swapper() == s, "the swapper");
    }

    /// One pool's mean liquidity set one below its floor for a delivery: the TAO/WETH pool on an even `seed`, else the
    /// WETH/USDC pool.
    function _thinPool(uint256 seed) internal {
        if (seed % 2 == 0) twap.setMeanLiquidity(fd.minPoolLiquidity(0) - 1, type(uint128).max);
        else twap.setMeanLiquidity(type(uint128).max, fd.minPoolLiquidity(1) - 1);
    }

    /// Claims `rao` of accrued root rewards as the keeper, recording the share price right before and
    /// right after (and after with one more share), the reward (from RewardsClaimed) and whether a cut
    /// was minted, skipped, or minted while a schedule was vesting or payouts were pending. A cut minted at a
    /// supply of 0 with nothing vesting absorbs the payout gap recorded exceptions left (spec §3.1, I-4: "the cut
    /// only with nothing vesting", within the 1,000-rao tolerance; the mints modifier checks the floor), so the price
    /// after is recorded with that gap given back; while anything vests, nothing is given back. A cut minted while
    /// stake is missing, before or after the claim, is a guard miss (I-1: a cut is a mint).
    function _claim(uint256 rao) internal {
        rao = bound(rao, 1e6, 1e9);
        staking.setUnclaimed(vaultLens.coldkey(), hotkey, rao);
        bool vesting = vaultLens.unvestedRewards() != 0;
        bool pending = vaultLens.pendingPayouts() != 0;
        bool missing = vaultLens.stakeMissing();
        uint256 gapAllowance = vesting ? 0 : _giveBackNow(true);
        uint256 priceBefore = vaultLens.price();
        uint256 oldEnd = uint256(vaultLens.vestingStart()) + vaultLens.vestingPeriod();
        // claimRewards needs claimGasRequired (55M) left before the claim
        _readLogs();
        try vault.claimRewards{gas: 60_000_000}(hotkey) {
            // a restart (this second's start) keeps at least what was left of the old schedule
            if (
                vaultLens.vestingStart() == vm.getBlockTimestamp()
                    && uint256(vaultLens.vestingStart()) + vaultLens.vestingPeriod() < oldEnd
            ) ++remaindersSpedUp;
            claimPriceBefore.push(priceBefore);
            claimPriceAfter.push(CascadeMath.price(vaultLens.totalAssets() + gapAllowance, vault.totalSupply()));
            claimPriceOneMoreShare.push(CascadeMath.price(vaultLens.totalAssets(), vault.totalSupply() + 1));
            Vm.Log[] memory logs = _readLogs();
            uint256 delta;
            bool minted;
            for (uint256 i; i < logs.length; ++i) {
                if (_isVaultLog(logs[i], RewardsClaimed.selector)) {
                    delta = abi.decode(logs[i].data, (uint256)) * RAO;
                } else if (_isVaultLog(logs[i], RewardCutMinted.selector)) {
                    minted = true;
                }
            }
            ghostRewards += delta;
            if (minted && (missing || vaultLens.stakeMissing())) ++guardMisses;
            if (minted) {
                ++cutsMinted;
                if (vesting) ++cutsWhileVesting;
                if (pending) ++cutsWithPending;
            } else if (delta * vaultLens.rewardCutBps() / 10_000 != 0) {
                ++cutsSkipped;
            }
            if (missing) ++claimsWhileMissing;
            ++rewardClaims;
            _raiseFloor();
        } catch {
            _dropLogs();
            ++unexpectedReverts;
        }
    }

    /// The actor's live preference, or a fresh one (see deliver); a zero floor if setDelivery failed.
    function _prefer(address actor, uint256 seed) internal returns (Preference memory p) {
        p = preferences[actor];
        // test-controlled time
        // forge-lint: disable-next-line(block-timestamp)
        if (p.floor != 0 && (vm.getBlockTimestamp() <= p.deadline || seed % 2 == 1)) return p;
        uint256 perTao = bound(seed, 200e6, 260e6);
        uint256 until = vm.getBlockTimestamp() + bound(seed >> 128, 1 hours, 7 days);
        // casting to 'uint128' and 'uint64' is safe because both values are bounded far below their maxima
        // forge-lint: disable-next-line(unsafe-typecast)
        p = Preference(uint128(perTao), uint64(until));
        _readLogs();
        vm.prank(actor);
        try fd.setDelivery(p.floor, p.deadline, DESTINATION_BASE) {
            preferences[actor] = p;
        } catch {
            _dropLogs();
            ++unexpectedReverts;
            p.floor = 0;
        }
    }

    /// Sets this call's market (see deliver). Returns whether the short-paying swapper sells, what the
    /// staker would pay the front door (its router's rate less the swap fee), and whether the short
    /// payer pays the front door's whole minimum.
    function _drawMarket(uint256 owed, uint256 seed)
        internal
        returns (bool viaShortPayer, uint256 expected, bool paysInFull)
    {
        uint256 rate = bound(seed >> 8, 225e6, 275e6);
        router.setRate(address(tao), rate);
        router.setLies(seed % 4 == 2);
        uint256 gross = owed * rate / 1e18;
        expected = gross - gross * staker.swapFeeBps() / 10_000;
        if (seed % 4 == 3) {
            viaShortPayer = true;
            uint256 shortBps = (seed >> 128) % 2 == 0 ? 0 : 1 + (seed >> 129) % 100;
            paysInFull = shortBps == 0;
            shortPayer.setMode(MockSwapper.Mode.PaysLess, shortBps);
            _setSwapper(address(shortPayer));
        }
    }

    /// The current delivery's three floors (I-30), for _deliver's record.
    uint256[3] internal _floorParts;

    /// The TWAP's floor of a credit of `owed`: the oracle's own value of it (usdcValue) less SLIPPAGE_BPS.
    function _twapFloor(uint256 owed) internal view returns (uint256) {
        return twap.usdcValue(owed) * (10_000 - SLIPPAGE_BPS) / 10_000;
    }

    /// The delivery's floor, computed here: the largest of the user's floor (USDC units per 1e18 TAO)
    /// rounded up, the keeper's, and the TWAP's value less SLIPPAGE_BPS.
    function _deliveryFloor(uint256 owed, uint256 perTao, uint256 keeperMinOut) internal view returns (uint256) {
        uint256 market = owed * twap.usdcPerTao() / 1e18 * (10_000 - SLIPPAGE_BPS) / 10_000;
        return Math.max(Math.ceilDiv(owed * perTao, 1e18), Math.max(keeperMinOut, market));
    }

    /// Calls deliver. A success records its floor and what the actor's USDC rose by, and a success where `expect`
    /// predicted a refusal counts as unexpected; a refusal must be `expect` when one is predicted, else may only be the
    /// market's (BelowMinimum, the staker's InsufficientOutput, the router's "Too little received") when the handler
    /// did not find the market `ready`.
    function _deliver(
        address actor,
        uint256 owed,
        uint256 keeperMinOut,
        uint256 floor,
        bool live,
        bool ready,
        bytes4 expect
    ) internal {
        uint256 before = usdc.balanceOf(actor);
        bool otherCredits = fd.totalClaimable() > owed;
        (,, uint256 openDeposits,,,) = fd.openBatch();
        _readLogs();
        try fd.deliver(actor, keeperMinOut) {
            _succeeded(expect);
            uint256 received = usdc.balanceOf(actor) - before;
            deliveryFloor.push(floor);
            deliveryReceived.push(received);
            deliveryUserFloor.push(_floorParts[0]);
            deliveryKeeperFloor.push(_floorParts[1]);
            deliveryTwapFloor.push(_floorParts[2]);
            if (floor == _floorParts[0]) ++deliveriesBoundByUser;
            else if (floor == _floorParts[1]) ++deliveriesBoundByKeeper;
            else ++deliveriesBoundByTwap;
            // I-31: the pools' depth as the oracle reads it now, the block of the delivery
            (uint128 l0, uint128 l1) = twap.meanLiquidity();
            if (l0 < fd.minPoolLiquidity(0) || l1 < fd.minPoolLiquidity(1)) ++thinDeliveries;
            ghostDelivered += owed;
            ++usdcDeliveries;
            if (!live) ++lateDeliveries;
            if (otherCredits) ++deliveriesBesideOtherCredits;
            if (openDeposits != 0) ++deliveriesBesideOpenDeposits;
            if (received == floor) ++deliveriesAtFloor;
            _raiseFloor();
        } catch (bytes memory reason) {
            _dropLogs();
            bytes4 r = _selector(reason);
            bool expected = expect != 0
                ? r == expect
                : !ready
                    && (r == CascadeFrontDoor.BelowMinimum.selector
                        || r == CascadeStaker.InsufficientOutput.selector
                        || keccak256(reason)
                            == keccak256(abi.encodeWithSignature("Error(string)", "Too little received")));
            if (!expected) {
                ++unexpectedReverts;
                return;
            }
            if (r == CascadeFrontDoor.ThinPool.selector) ++thinPoolRefusals;
            ++deliveriesRefused;
        }
    }

    /// Reads one delivery attempt: its amount, its payout list and delivery price if it queued payouts, and the burn
    /// window it wrote. An attempt the bridge filed as failed is expected only for the vault's refusals the state
    /// predicts: StakeMissing while stake is missing, VaultInsolvent at a supply of 0 underwater (the bridge keeps it
    /// for retryDelivery, as the adapter parks it); any other counts as an unexpected revert (the vault is never
    /// paused and its peer is always active here). Both states are judged as read before the attempt (`missingBefore`,
    /// `underwaterBefore`): since R6's E-fix the tolerance's base is the booked stake less the queued payouts, so a
    /// delivery that queues payouts can tighten it, and a read after the delivery is not the read it made.
    function _recordDelivery(Vm.Log[] memory logs, bool missingBefore, bool underwaterBefore) internal {
        bool burned;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory log = logs[i];
            if (log.emitter == address(bridge) && log.topics[0] == MockBridge.DeliveryFailed.selector) {
                (, bytes memory reason) = abi.decode(log.data, (uint256, bytes));
                bytes4 r = _selector(reason);
                // the vault's checks in their order: the door, the stake, a supply of 0 underwater
                bool doorUp = vaultLens.doorState(peer) == DoorState.Active;
                if (r == UnknownPeer.selector && !doorUp) {
                    ++deliveriesRefusedDoorDown;
                } else if (r == StakeMissing.selector && doorUp && missingBefore) {
                    ++deliveriesRefusedWhileMissing;
                } else if (r == VaultInsolvent.selector && doorUp && underwaterBefore) {
                    ++deliveriesRefusedUnderwater;
                } else {
                    ++unexpectedReverts;
                }
            }
            if (_isVaultLog(log, BatchDelivered.selector)) {
                (, uint256 amount) = abi.decode(log.data, (uint64, uint256));
                ghostIn += amount;
                ++deliveries;
                // I-1: no batch is delivered (it would mint and burn at a price lowered by stake that is still the
                // holders') while stake is missing, nor at a supply of 0 underwater, each judged from the state before
                // it (a delivery's queued payouts tighten the tolerance after it, R6 E-fix)
                if (missingBefore || underwaterBefore) ++guardMisses;
                // a door that is not active never delivers (UnknownPeer)
                if (vaultLens.doorState(peer) != DoorState.Active) ++unexpectedReverts;
            } else if (_isVaultLog(log, Deposited.selector)) {
                // I-36's model: a door's mint adds to its holder's fresh shares
                (, uint256 minted) = abi.decode(log.data, (uint256, uint256));
                // casting to 'uint160' is safe because the topic is an indexed address
                // forge-lint: disable-next-line(unsafe-typecast)
                _noteFresh(address(uint160(uint256(log.topics[2]))), minted);
            } else if (_isVaultLog(log, DepositBounced.selector)) {
                // a bounced deposit is queued ahead of the redeems, with 0 shares
                // casting to 'uint160' is safe because the topic is an indexed address
                // forge-lint: disable-next-line(unsafe-typecast)
                address user = address(uint160(uint256(log.topics[2])));
                (uint256 assets,) = abi.decode(log.data, (uint256, BounceReason));
                lists[log.topics[1]].push(CascadeMessages.Payout(user, 0, assets));
                ++depositBounces;
            } else if (_isVaultLog(log, Redeemed.selector)) {
                (uint256 shares, uint256 assets) = abi.decode(log.data, (uint256, uint256));
                // casting to 'uint160' is safe because the topic is an indexed address
                // forge-lint: disable-next-line(unsafe-typecast)
                address user = address(uint160(uint256(log.topics[2])));
                lists[log.topics[1]].push(CascadeMessages.Payout(user, shares, assets));
                burned = true;
                // I-36: a holder appears once in a batch's redeems, after its deposits, so its balance now is after
                // this burn; it must still hold every fresh share the model counts
                if (vault.balanceOf(user) < _freshNow(user)) ++freshBurns;
                // and, on no formula, every share this delivery minted for it
                if (vault.balanceOf(user) < _mintedHere(logs, i, log.topics[1], user)) ++mintBurns;
            } else if (_isVaultLog(log, PayoutBatchQueued.selector)) {
                (,,, uint256 price) = abi.decode(log.data, (uint64, uint32, uint256, uint256));
                deliveryPrice[log.topics[1]] = price;
                queuedKeys.push(log.topics[1]);
                maxQueueDepth = Math.max(maxQueueDepth, queuedKeys.length);
            } else if (_isVaultLog(log, RedeemDeferred.selector)) {
                ++redeemDeferred;
                // casting to 'uint160' is safe because the topic is an indexed address
                // forge-lint: disable-next-line(unsafe-typecast)
                if (_freshNow(address(uint160(uint256(log.topics[2])))) != 0) ++freshHolds;
            } else if (_isVaultLog(log, RedeemSkipped.selector)) {
                ++redeemSkipped;
            }
        }
        // The window is written only by a delivery that burns (a Redeemed event; bounced deposits alone
        // queue payouts without burning); checked then, against the base the vault computed, rebuilt
        // here from its storage (a delivery changes none of it, nor the stake or the time, so it is the
        // same now as inside the close). Both windows a burn counts in (I-15), each on its own counter: the door's,
        // within its percentage of the base, and all doors' (the global window, Task 17), within the global
        // percentage, each at least the floor they share.
        if (burned) {
            uint256 b = base();
            uint256 floor = vaultLens.minDailyOutflow();
            (, uint256 windowBurned) = vaultLens.burnWindows(peer);
            if (windowBurned > Math.max(b * vaultLens.maxDailyOutflowBps() / 10_000, floor)) ++doorWindowViolations;
            (, uint256 globalBurned) = vaultLens.burnWindows(GLOBAL_WINDOW);
            if (globalBurned > Math.max(b * vaultLens.globalOutflowBps() / 10_000, floor)) ++globalWindowViolations;
        }
    }

    /// Adds batch `key`'s sent chunk to the outflow (net and the part of the fee the entries were charged; the
    /// caller's top-up paid the rest) and to what the front door was paid. A payout delivery the bridge filed as
    /// failed counts as an unexpected revert.
    function _recordPayout(bytes32 key, Vm.Log[] memory logs) internal {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory log = logs[i];
            if (log.emitter == address(bridge) && log.topics[0] == MockBridge.DeliveryFailed.selector) {
                ++unexpectedReverts;
            }
            if (_isVaultLog(log, PayoutChunkSent.selector) && log.topics[1] == key) {
                (,,, uint256 net,, uint256 charged) =
                    abi.decode(log.data, (uint32, uint32, uint256, uint256, uint256, uint256));
                ghostOut += net + charged;
                ghostPayoutsReceived += net;
                ++payoutChunks;
            }
        }
    }

    /// An UnstakeShort while the vault's stake is non-zero but below the minimum stake: the unstake walk
    /// skips such a position, so an exit that needs it waits for stakeIdle (or the owner) to clear it.
    /// Counted in dustBlocked.
    function _dustBlocked(bytes memory reason) internal returns (bool) {
        uint256 s = staking.getStake(hotkey, vaultLens.coldkey(), 0);
        if (s == 0 || s >= MIN_STAKE_RAO || _selector(reason) != UnstakeShort.selector) return false;
        ++dustBlocked;
        return true;
    }

    /// Swap-and-pop.
    function _dropKey(bytes32 key) internal {
        uint256 n = queuedKeys.length;
        for (uint256 i; i < n; ++i) {
            if (queuedKeys[i] == key) {
                queuedKeys[i] = queuedKeys[n - 1];
                queuedKeys.pop();
                break;
            }
        }
        delete lists[key];
    }

    /// While stake is missing, a direct deposit of 1 TAO (when the actor has it) and an unflagged direct redeem of
    /// `shares` must each revert StakeMissing; anything else is a guard miss (and a success keeps the ghosts true).
    function _refusedWhileMissing(address actor, uint256 shares) internal {
        if (_sub0(actor.balance, FEE_MONEY) >= 1e18) {
            _readLogs();
            vm.prank(actor);
            try vault.depositDirect{value: 1e18}() {
                ghostIn += 1e18;
                ++guardMisses;
            } catch (bytes memory reason) {
                _dropLogs();
                if (!_isStakeMissing(reason)) ++guardMisses;
            }
        }
        uint256 before = actor.balance;
        _readLogs();
        vm.prank(actor);
        try vault.redeemDirect(shares, false) {
            _capFresh(actor);
            ghostOut += actor.balance - before;
            ++guardMisses;
        } catch (bytes memory reason) {
            _dropLogs();
            if (!_isStakeMissing(reason)) ++guardMisses;
        }
    }

    /// The flagged exit while stake is missing, checked against the floor price and the other holders' values.
    function _consentedExit(address actor, uint256 shares) internal {
        uint256 assets = vaultLens.totalAssets();
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
        uint256 vaultBefore = address(vault).balance;
        uint256 stakeBefore = _coldkeyStake();
        // the liquidity redeemDirect reads once, before its walk: the balance above ED and the queued payouts
        uint256 liquid = _availableAt(vaultLens.pendingPayouts());
        ExitOut memory e = _exitPlan(liquid, exact - exact % RAO);
        uint256[3] memory mark = _markPrice();
        _readLogs();
        vm.prank(actor);
        try vault.redeemDirect(shares, true) {
            _capFresh(actor);
            // a predicted refusal lost
            _succeeded(e.refusal);
            uint256 paid = actor.balance - balanceBefore;
            ghostOut += paid;
            ++missingExits;
            Vm.Log[] memory logs = _readLogs();
            uint256 borne = _absorbed(logs);
            // what the chain kept of the stake the walk took: the leaver's own cost (Task 36b)
            uint256 short = _exitRemovals(logs, stakeBefore);
            _checkWalk(logs, e.walk);
            _checkExitPrice(mark);
            // the walk's receipts and the stake it took, measured here: the vault's balance moved by the receipts less
            // the payment, and the coldkey's stake fell by the stake taken
            uint256 received = _sub0(address(vault).balance + paid, vaultBefore);
            uint256 taken = _sub0(stakeBefore, _coldkeyStake()) * RAO;
            // the assets fall by exactly what was paid and what the chain kept, and the pay is the plan's
            if (
                _shortfallMispaid(exact - exact % RAO, liquid, taken, received, paid, borne)
                    || vaultLens.totalAssets() + paid + short != assets || paid != e.paid || borne != e.unmet + e.cost
            ) ++missingMispaid;
            if (!_flaggedExitLogged(logs, actor, shares, paid)) ++missingMispaid;
            // each stayer's value is no lower than before (the leaver bore its exit's whole cost), and its gain at most
            // what the stayers keep, the shares' value less what was paid and what the chain kept (the leaver's
            // rounding, and what it bore that no walk took: a shortfall within the tolerance that no walk ran for), and
            // its own floor's 1 wei; floored so that an overpaid leaver (already counted above) cannot revert the call
            // and undo the count
            uint256 kept = _sub0(_sub0(exact, paid), short);
            for (uint256 i; i < 3; ++i) {
                uint256 v = _valueOf(others[i], 0);
                if (v < before[i] || v > before[i] + kept + 1) ++missingOthersMoved;
            }
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, e.refusal)) _countExitRefusal(reason, e.refusal, exact, false);
        }
    }

    /// Whether the logs hold the vault's RedeemedDirect(actor, shares, paid, acceptedMissing = true): the exit was
    /// priced while stake was missing, and says so.
    function _flaggedExitLogged(Vm.Log[] memory logs, address actor, uint256 shares, uint256 paid)
        internal
        view
        returns (bool)
    {
        for (uint256 i; i < logs.length; ++i) {
            if (!_isVaultLog(logs[i], RedeemedDirect.selector)) continue;
            (uint256 s, uint256 a, bool accepted) = abi.decode(logs[i].data, (uint256, uint256, bool));
            return logs[i].topics[1] == bytes32(uint256(uint160(actor))) && s == shares && a == paid && accepted;
        }
        return false;
    }

    /// Whether a direct exit worth `out` (floored to rao) broke the shortfall rule (Task 19, I-13; the leaver pays, Task
    /// 36b), from the handler's own measurements: `liquid`, what the vault could pay from before the walk, `taken`, the
    /// stake the walk took at face value, and `received`, its receipts. What the liquidity and the stake taken leave
    /// unmet must be at most SHORTFALL_TOLERANCE, the logged `absorbed` exactly that and the walk's cost (what the chain
    /// kept of the stake taken, rounded up to rao), and the leaver paid `out` less both, floored to rao. Uses no
    /// arithmetic that can revert: a handler call that reverts is dropped (fail_on_revert = false), and with it the
    /// count of a violation.
    function _shortfallMispaid(
        uint256 out,
        uint256 liquid,
        uint256 taken,
        uint256 received,
        uint256 paid,
        uint256 absorbed
    ) internal pure returns (bool) {
        if (absorbed > out) return true;
        uint256 unmet = _sub0(_sub0(out, liquid), taken);
        if (unmet > SHORTFALL_TOLERANCE) return true;
        uint256 cost = Math.ceilDiv(_sub0(taken, received), RAO) * RAO;
        if (absorbed != unmet + cost) return true;
        uint256 owed = out - absorbed;
        return paid != owed - owed % RAO;
    }

    /// What `a`'s shares redeem for, with `givenBack` wei added to the vault's assets.
    function _valueOf(address a, uint256 givenBack) internal view returns (uint256) {
        uint256 assets = vaultLens.totalAssets() + givenBack;
        return CascadeMath.assetsForRedeem(vault.balanceOf(a), assets, vault.totalSupply());
    }

    function _isStakeMissing(bytes memory reason) internal pure returns (bool) {
        return reason.length == 4 && _selector(reason) == StakeMissing.selector;
    }

    /// The first actor from `seed` on with a non-zero `amountOf`, or (actors[seed], 0).
    function _actorWith(uint256 seed, function(address) internal view returns (uint256) amountOf)
        internal
        view
        returns (address actor, uint256 amount)
    {
        uint256 n = actors.length;
        for (uint256 i; i < n; ++i) {
            actor = actors[(seed % n + i) % n];
            amount = amountOf(actor);
            if (amount != 0) return (actor, amount);
        }
        return (actors[seed % n], 0);
    }

    /// The first queued key from `seed` on whose `measure` is at least `min`, or queuedKeys[seed].
    /// Requires a non-empty queue.
    function _keyWith(uint256 seed, function(bytes32) internal view returns (uint256) measure, uint256 min)
        internal
        view
        returns (bytes32)
    {
        uint256 n = queuedKeys.length;
        for (uint256 i; i < n; ++i) {
            bytes32 key = queuedKeys[(seed % n + i) % n];
            if (measure(key) >= min) return key;
        }
        return queuedKeys[seed % n];
    }

    function _entriesLeft(bytes32 key) internal view returns (uint256) {
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        return b.count - b.cursor;
    }

    function _chunksSent(bytes32 key) internal view returns (uint256) {
        return vaultLens.getPayoutBatch(key).cursor;
    }

    function _shares(address a) internal view returns (uint256) {
        return vault.balanceOf(a);
    }

    function _sharesNotRequested(address a) internal view returns (uint256) {
        return fd.redeemOf(a) == 0 ? vault.balanceOf(a) : 0;
    }

    function _openDeposit(address a) internal view returns (uint256) {
        return fd.depositOf(a);
    }

    function _openRedeem(address a) internal view returns (uint256) {
        return fd.redeemOf(a);
    }

    function _claimable(address a) internal view returns (uint256) {
        return fd.claimable(a);
    }

    /// The bounced deposits (0 shares) among list[from:to].
    function _bounces(CascadeMessages.Payout[] memory list, uint256 from, uint256 to)
        internal
        pure
        returns (uint256 n)
    {
        for (uint256 i = from; i < to; ++i) {
            if (list[i].shares == 0) ++n;
        }
    }
}
