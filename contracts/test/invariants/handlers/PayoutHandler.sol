// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CascadeBase} from "../../../src/CascadeBase.sol";
import {CascadeVault} from "../../../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../../../src/CascadeFrontDoor.sol";
import {CascadeMath} from "../../../src/libraries/CascadeMath.sol";
import {CascadeMessages} from "../../../src/libraries/CascadeMessages.sol";
import {MAX_FEE_ABS} from "../../../src/CascadeConstants.sol";
import {
    BadValue,
    CapExceeded,
    FeeTooHigh,
    FrontDoorInactive,
    InvalidParameter,
    NotPending,
    NothingToCancel,
    PayoutDelayed,
    PayoutsMismatch,
    PrimaryBridgeDisabled,
    StakeMissing,
    UnstakeShort,
    VaultInsolvent,
    ZeroAmount
} from "../../../src/CascadeErrors.sol";
import {
    BatchDelivered,
    DepositBounced,
    PayoutBatchCancelled,
    PayoutBatchQueued,
    PayoutChunkSent,
    PayoutDust,
    RedeemDeferred,
    RedeemSkipped,
    Redeemed,
    RedeemedDirect,
    Unstaked
} from "../../../src/CascadeEvents.sol";
import {BounceReason, DoorState, PayoutBatch} from "../../../src/CascadeTypes.sol";
import {MockBridge} from "../../mocks/MockBridge.sol";
import {MockTAO} from "../../mocks/MockTAO.sol";
import {Schedule} from "../../governance/Schedule.sol";
import {VaultModel} from "./VaultModel.sol";

/// @notice The payout campaign's handler (Task 36, spec §3.3 and §3.5): several payout batches queued at once with
/// nothing idle (`idleBufferBps` 0, so every reservation not covered by the liquid balance is staked), paid out in
/// chunks by the keeper and by a stranger, with and without a top-up, cancelled by the owner (their bounces carried),
/// while the world switches under them: the payout lane's fee in [0, 0.03 TAO], whole rao and not (setPayoutFee); the
/// chain's removal fee in {0, 1, 1,000, 1,001, 50,000, 4,000,000, 16,000,000} rao (setRemoveFee: up to 0.016 TAO, so
/// a walk's cost can refuse a direct exit ZeroAmount and a chunk FeeTooHigh); a root hold on every pair, its removals
/// burning the
/// gas they are given or not (setRootHold); the fee ceiling's absolute part in [MIN_FEE_ABS, MAX_FEE_ABS], scheduled
/// where it loosens (setFeeLimits); the stake hotkey moved between the two listed hotkeys (switchStakeHotkey), so a
/// walk can span two positions; claims, some leaving a position below the chain's minimum; a run, every holder out at
/// once (bankRun); and time. The keeper's round stakes what a delivery left idle (on three closes in four) and, in
/// drainDue, sends every due batch's chunks.
///
/// The door's holders (alice, bob, carol) deposit and redeem at the front door; erin and frank deposit and exit
/// directly; the foreigner's redeem origin is a second chain's (a door activated there in the constructor, spec §3.4),
/// so every deposit it makes at the launch door bounces (ForeignOrigin) and rides the batch's payouts as a 0-share
/// entry, down to the door's minimum, the bound's floor 2 × MAX_FEE_ABS = 0.03 TAO (I-14).
///
/// The handler keeps its own record of every batch (the ghosts): its list from the delivery's DepositBounced and
/// Redeemed events, its cursor, chunk number, remaining value and queue time, advanced by its own restatement of each
/// chunk (VaultModel's takeChunk and deductFee) and rebuilt by its own reading of each cancel, and the sum of what
/// they reserve (`ghostPending`). Every check below reads those ghosts and the EVM's balances, never the vault's view
/// of the same thing:
/// - I-12 (`reserveBreaches`), per exit, from a snapshot taken before it: for a chunk, the vault's balance before the
///   call (its caller's value not yet in it) and the other batches' reservations; for a direct exit, the balance and
///   every reservation; after it, the balance is at least the smaller of the balance before and ED plus those
///   reservations (`balance >= min(before, ED + others)`, the spec's formula unfloored: an exit with no other
///   reservation still keeps ED_RESERVE).
/// - I-13 (Task 36b, the leaver pays): a direct exit, priced by the handler at the call, is paid exactly
///   floorToRao(out - unmet - cost), `unmet` (at most 1,000 rao) what its walk left untaken at face value and `cost`
///   what the chain kept of the stake it took, rounded up to rao, both from its Unstaked logs, with ShortfallAbsorbed
///   unmet + cost and RedeemedDirect the pay (`directMispaid`), and all three as VaultModel predicts them
///   (`directMispredicted`), or reverts as predicted; a chunk is sent as queued less each entry's share of charged +
///   cost (`chunkMismatches`: the bridge's balance rose by net + fee, the front door credited the entries in their
///   queued order at their queued amounts less their shares, under the chunk's number, and PayoutChunkSent says so,
///   its unstakeCost the logged cost and the predicted one), its entries' measured shares are at least charged + cost
///   and at most the ceiling plus the cost plus a rao an entry (`ceilingBreaches`), and its caller's balance moved by
///   exactly minus the top-up, the rest of its value refunded in the call (`callerMispaid`).
/// - I-13's liveness (`_probeLiveness`, after every step): a due batch is attempted inside a snapshot with the exact
///   top-up, and must process when no listed pair is locked, the batch's door and the primary bridge are active, and
///   the spec's sufficient condition holds on the mock's positions and the ghosts (the free balance pays it, or the
///   positions the walk may take hold need - free + T at face value with no entry zeroed by its share of the predicted
///   walk cost: `livenessFailures`), except in the walk's whole-removal corner the model predicts (the walk ended after
///   a whole removal less than a rao an entry short of T, and the second split leaves the entries more than the
///   receipts), where it must refuse exactly UnstakeShort (`livenessCorners`, `livenessCornerMismatches`); everywhere
///   else it must do as the model predicts (`livenessMispredicted`). Stake missing is no precondition: processPayouts
///   never reads it.
/// - I-14: no PayoutDust at all (`payoutDusts`; none can be an entry with shares, `dustWithShares`), and a chunk whose
///   entry with shares would net nothing must refuse FeeTooHigh (unreachable under the bounds), as must one whose
///   walk's cost would leave an entry nothing (`chunksRefusedWalkCost`).
/// - I-19 (the invariant reads the ghosts against the vault) and the carried list: every cancel's pending falls by
///   exactly its re-minted entries' value (`bouncesReleased`), the vault's stored batch is the handler's carried list
///   (its count, cursor, remaining and chunk), and the next cancel and processPayouts of that key with that list refuse
///   NothingToCancel and nothing for a list mismatch (`carriedListMismatches`).
/// - I-4, PriceFloorTracker's floor and exceptions fed as the core and ledger campaigns feed them: each stake's fresh
///   read (exact here: none), a cancel over a hole (_cancelBound), and at a supply of 0 the next mint absorbing the
///   payout gap (the `mints` modifier on every action that can mint) and a cancel absorbing the whole shortfall an
///   exception left (fix round 3: PriceFloorTracker's shortfallHoleWei, which no mint reads, fed here only by a fresh
///   read, which this fixture's exact reads never make). No exit is an exception (Task 36b): a walk's removal fee is
///   the exit's own cost, so the floor never restarts for a chunk or a direct exit.
/// - I-35 (`exitPriceFalls`): around every sent chunk, every paid direct exit and every cancel, the price exactly and
///   the hole never worse (PriceFloorTracker's _markPrice and _checkExitPrice), no allowance at any fee.
/// - The walk's removals (spec §3.10.11, fix round 2): every sent chunk's, paid direct exit's and processed liveness
///   attempt's Unstaked and UnstakeSkipped events are exactly the walk VaultModel predicts before the call from the
///   mock's positions (_chunkWalk, _exitWalk), the same hotkeys in order and each removal's wantRao (`walkMismatches`):
///   no further position tried once at most T is unmet, none passed over, none asked other than the rule.
///
/// Expected refusals, by action, each predicted from its state in the vault's order (any other refusal, or a predicted
/// one that does not happen, counts in unexpectedReverts):
/// - processPayouts and drainDue (and the probes' attempts): PayoutDelayed before the payout delay; FrontDoorInactive
///   and PrimaryBridgeDisabled (never here: no action takes the door or the bridge down); FeeTooHigh for an entry with
///   shares that would net 0; BadValue for a value that is not whole rao; FeeTooHigh for a value short of the top-up;
///   UnstakeShort when the restated walk leaves more than T of what the free balance does not cover untaken (a root
///   hold on every pair, a position below the chain's minimum); FeeTooHigh when the walk's cost would leave an entry
///   nothing; UnstakeShort when the free balance and the walk's receipts do not fund what is sent (finish's check);
/// - redeemDirect: StakeMissing while stake is missing (never here), ZeroAmount under a rao, UnstakeShort as above,
///   ZeroAmount when the walk's cost leaves the leaver nothing;
/// - depositDirect: StakeMissing, VaultInsolvent below half the launch price or underwater, CapExceeded (never);
/// - doorDeposit: CapExceeded, BatchValueFull, BatchFull at the door's limits (never at these values);
/// - a delivery, as the bridge files it: StakeMissing while stake is missing, VaultInsolvent at a supply of 0
///   underwater;
/// - cancelQueued: NothingToCancel when every unsent entry is a bounce;
/// - setFeeLimits: InvalidParameter below MIN_FEE_ABS (a tightening, at once) and above MAX_FEE_ABS (a loosening: its
///   schedule runs, its execute refuses).
/// The other actions refuse nothing.
contract PayoutHandler is VaultModel {
    /// What the test passes the handler beyond the base's system.
    struct Parts {
        MockTAO tao;
        MockBridge bridge;
        uint64 doorChain;
        uint64 foreignChain;
        address foreignDoor;
    }

    /// One payout chunk as the handler restates it right before its call (spec §3.3's fee valve, line by line).
    struct Chunk {
        bytes32 key;
        uint256 cursor;
        uint256 taken;
        uint256 sum;
        uint256 ceiling;
        /// The fee the bridge is paid, the entries' share of it and the caller's top-up (all 0 when nothing is sent),
        /// and the top-up the value is checked against (prepare checks it before it zeroes a send of nothing).
        uint256 fee;
        uint256 charged;
        uint256 topUp;
        uint256 topUpAsked;
        uint256 net;
        uint256[] nets;
        bool sharesAtZero;
        uint256 dust;
        /// What the vault pays (net + charged, before the walk), the other batches' reservations (the handler's
        /// ghosts), the free balance beyond ED and those, and whether the walk leaves at most T of what the free
        /// balance does not cover untaken (true with no walk).
        uint256 need;
        uint256 others;
        uint256 free;
        bool coverable;
        /// The walk the vault makes for it (VaultModel's _chunkAfterWalk, none when free covers it), which its Unstaked
        /// events must match (_checkWalk), what it receives and its cost (the entries'), and the refusal the walk and
        /// finish's checks make (none, UnstakeShort or FeeTooHigh). `nets` and `net` are then the split on charged +
        /// cost, what is sent. What the walk leaves untaken of its ask at face value, and whether the split on
        /// charged + cost leaves an entry nothing the first split did not (I-13's liveness reads both).
        Removal[] walk;
        uint256 received;
        uint256 cost;
        bytes4 walkRefusal;
        uint256 unmet;
        bool zeroed;
    }

    /// What a chunk's call was given, and the balances the handler read right before it.
    struct Call {
        address caller;
        uint256 value;
        uint256 vaultBefore;
        uint256 callerBefore;
        uint256 bridgeBefore;
        /// The coldkey's root stake before the call, for what the chain kept (_exitRemovals), and I-35's mark.
        uint256 stakeBefore;
        uint256[3] mark;
    }

    /// What a cancel reads before its call, for I-4's cancel bound (as the core campaign checks it) and I-35: the
    /// price, whether the assets read above 0, the payout gap a re-mint at a supply of 0 absorbs, the floor, the entries
    /// re-minted and their value, what a re-mint at a supply of 0 absorbs beyond that of the whole shortfall (the fix
    /// round 3: PriceFloorTracker's shortfallHoleWei, which only a cancel reads), and I-35's mark.
    struct CancelMark {
        uint256 priceBefore;
        bool withAssets;
        uint256 gapAllowance;
        uint256 floor;
        uint256 reMintedEntries;
        uint256 reMintedValue;
        uint256 shortfallBack;
        uint256[3] mark;
    }

    uint256 internal constant MAX_DEPOSIT = 50e18;
    uint256 internal constant FEE_MONEY = 10 ether;
    /// The Base lane's fee, the fixture's: MockBridge has one fee for both lanes, so the payout lane's (payoutFee) is
    /// set only around each payout call and this one put back after it.
    uint256 internal constant WORLD_FEE = 1e15;
    /// The payout lane's fee is drawn in [0, MAX_PAYOUT_FEE], twice MAX_FEE_ABS.
    uint256 internal constant MAX_PAYOUT_FEE = 0.03e18;
    /// CascadeVault's MIN_FEE_ABS (internal there), restated: the fee ceiling's absolute part is in
    /// [MIN_FEE_ABS, MAX_FEE_ABS] (spec §3.3).
    uint256 internal constant MIN_FEE_ABS = 0.01e18;
    /// The gas every exit call is given: the block's order, so a root hold that burns what each removal is given still
    /// leaves the walk's caller EXIT_GAS_RESERVE (spec §3.8) and the exit refuses UnstakeShort, not out of gas.
    uint256 internal constant CALL_GAS = 30_000_000;
    /// The keeper's processPayouts asks for 1 to CHUNK_ENTRIES entries (minChunk is 1 here).
    uint32 internal constant CHUNK_ENTRIES = 3;
    /// The batches one drainDue finishes at most.
    uint256 internal constant DRAIN_BATCHES = 2;
    /// The removal fees past the tolerance setRemoveFee draws: one rao past it, 50,000 rao (the design note's example),
    /// 0.004 TAO (above the chain's minimum stake: a minimum-stake removal pays nothing) and 0.016 TAO (above the fee
    /// ceiling's 0.015 TAO: it zeroes a lonely 0.03 TAO entry).
    uint256 internal constant PAST_T_REMOVE_FEE_RAO = 1_001;
    uint256 internal constant EXAMPLE_REMOVE_FEE_RAO = 50_000;
    uint256 internal constant ABOVE_MIN_STAKE_FEE_RAO = 4_000_000;
    uint256 internal constant ABOVE_CEILING_FEE_RAO = 16_000_000;
    /// The vault's second listed hotkey (the stake hotkey moves between it and the first).
    bytes32 public constant HK2 = bytes32(uint256(2));

    MockTAO public immutable tao;
    MockBridge public immutable bridge;
    bytes32 public immutable firstHotkey;
    bytes32 public immutable peer;
    uint64 public immutable doorChain;
    uint64 public immutable foreignChain;
    address public immutable stranger;
    address public immutable foreigner;

    address[3] public doorHolders;
    address[2] public directHolders;
    /// Holders a scripted test gave the second chain's redeem origin (addForeigner), whose door deposits bounce
    /// ForeignOrigin as the foreigner's do; none in the campaign.
    mapping(address => bool) public madeForeign;

    /// The payout lane's fee, in wei (setPayoutFee), and the world's switches the handler set.
    uint256 public payoutFee = WORLD_FEE;

    // ---- the ghosts: the handler's record of the queue ----

    bytes32[] public queuedKeys;
    mapping(bytes32 => CascadeMessages.Payout[]) internal _lists;
    mapping(bytes32 => uint256) public ghostCursor;
    mapping(bytes32 => uint256) public ghostRemaining;
    mapping(bytes32 => uint32) public ghostChunk;
    mapping(bytes32 => uint64) public ghostQueuedAt;
    /// Whether a cancel left the batch holding only its carried bounces.
    mapping(bytes32 => bool) public carried;
    /// What the queued batches reserve, by the handler's own count.
    uint256 public ghostPending;

    // ---- what the invariants assert is 0 ----

    /// I-12.
    uint256 public reserveBreaches;
    /// I-4 (the price floor and its exceptions are PriceFloorTracker's): cancels that fell further than their bound or
    /// lowered the price while the assets read above 0 (the core campaign's cancel bound).
    uint256 public cancelDustViolations;
    uint256 public cancelFallsWithAssets;
    /// I-13.
    uint256 public chunkMismatches;
    uint256 public ceilingBreaches;
    uint256 public callerMispaid;
    uint256 public directMispaid;
    uint256 public directMispredicted;
    /// I-13's liveness: due batches that did not process with every precondition met, attempts whose outcome was not
    /// the one the model predicts, and attempts in the walk's whole-removal corner (the spec's one carve-out) that did
    /// not refuse exactly UnstakeShort.
    uint256 public livenessFailures;
    uint256 public livenessMispredicted;
    uint256 public livenessCornerMismatches;
    bytes4 public lastLivenessFailure;
    /// I-14.
    uint256 public payoutDusts;
    uint256 public dustWithShares;
    /// I-19 and the carried list; and a queue the vault logged that was not the handler's list.
    uint256 public bouncesReleased;
    uint256 public carriedListMismatches;
    uint256 public ghostMismatches;

    // ---- reachability counters ----

    uint256 public doorDeposits;
    uint256 public foreignDeposits;
    uint256 public doorRedeems;
    uint256 public closes;
    uint256 public deliveries;
    uint256 public depositBounces;
    uint256 public foreignBounces;
    uint256 public insolventBounces;
    uint256 public redeemedEntries;
    uint256 public redeemDeferred;
    uint256 public redeemSkipped;
    uint256 public deliveriesRefusedUnderwater;
    uint256 public deliveriesRefusedWhileMissing;
    uint256 public maxQueueDepth;
    /// Steps that ended with at least three batches queued.
    uint256 public stepsWithThreeQueued;
    uint256 public payoutChunks;
    uint256 public partialChunks;
    uint256 public chunksByStranger;
    uint256 public topUpChunks;
    uint256 public refundedChunks;
    uint256 public walkedChunks;
    uint256 public multiPositionWalks;
    /// Chunks sent whose walk cost something (their entries bore it), and those at a removal fee past T.
    uint256 public chunksChargedWalkCost;
    uint256 public chunksSentAtAFeePastT;
    uint256 public bouncesPaid;
    uint256 public payoutsRefusedEarly;
    uint256 public payoutsRefusedBadValue;
    uint256 public payoutsRefusedFeeShort;
    uint256 public payoutsRefusedSharesAtZero;
    uint256 public payoutsRefusedHeld;
    uint256 public payoutsRefusedHeldBurning;
    uint256 public payoutsUncoverable;
    /// Chunks refused FeeTooHigh because their walk's cost would leave an entry nothing (I-14's new case), and refused
    /// UnstakeShort by finish's check that the free balance and the receipts fund the send (the walk having taken
    /// need - free at face value: the design note's corner).
    uint256 public chunksRefusedWalkCost;
    uint256 public payoutsRefusedCoverage;
    /// Exits (chunks and direct) refused UnstakeShort with the hold off while a listed position held stake below the
    /// chain's minimum, which the walk skips.
    uint256 public dustBlocked;
    /// The most gas a refused exit used under a hold whose removals burn their gas (bounded by CALL_GAS).
    uint256 public maxHeldBurnGas;
    uint256 public drains;
    /// drainDue: two or more batches finished from nothing idle, with a walk, and the same at a 1-rao removal fee.
    uint256 public multiBatchDrains;
    uint256 public multiBatchDrainsAtFee1;
    uint256 public directDeposits;
    uint256 public directDepositsRefusedInsolvent;
    uint256 public directExits;
    uint256 public directExitsWalked;
    uint256 public directExitsShort;
    /// Direct exits paid while a queued payout's reservation was staked, and the same at a 1-rao removal fee.
    uint256 public directExitsBesideStakedPayout;
    uint256 public directExitsBesideStakedPayoutAtFee1;
    uint256 public directExitsRefusedZero;
    /// Direct exits refused ZeroAmount after their walk: its cost left the leaver nothing (Task 36b).
    uint256 public exitsRefusedByCost;
    uint256 public directExitsRefusedHeld;
    uint256 public directExitsUncoverable;
    uint256 public bankRuns;
    uint256 public stakes;
    uint256 public claims;
    /// Claims onto an empty position of less than the chain's minimum (a position the walk skips).
    uint256 public dustClaims;
    uint256 public cancels;
    /// Cancels that started with the assets reading 0 over a hole a recorded exception left (I-35's exemption).
    uint256 public cancelsOverAHole;
    uint256 public cancelsAfterPartial;
    uint256 public cancelsRefusedNothing;
    uint256 public carriedBatches;
    uint256 public bouncesCarried;
    uint256 public carriedBatchesPaid;
    uint256 public feeSwitches;
    uint256 public feeSwitchesNotWholeRao;
    uint256 public feeSwitchesAboveTheCeiling;
    uint256 public removeFeeSwitches;
    /// The corner's targeted draws made (Task 42): set-ups, not reaches (the probe after the step judges each; the
    /// reach is livenessCorners, and the corner is held by test_theCornerDrawReachesTheWalksWholeRemovalCorner and
    /// test_theLivenessProbeExpectsTheWalksWholeRemovalCorner: fix round 3's review, M-6).
    uint256 public cornerDraws;
    /// The walk-cost draws that sent their chunk at the least fee that zeroes an entry (Task 42's fix round 3).
    uint256 public walkCostDraws;
    /// The cancel-after-partial draws whose cancel followed their partial chunk (Task 42's fix round 4).
    uint256 public cancelAfterPartialDraws;
    uint256 public holdsOn;
    uint256 public holdsBurning;
    uint256 public feeLimitsTightened;
    uint256 public feeLimitsLoosened;
    uint256 public feeLimitsRefusedLow;
    uint256 public feeLimitsRefusedHigh;
    uint256 public stakeHotkeySwitches;
    uint256 public livenessProbes;
    uint256 public livenessAsserted;
    uint256 public livenessProbesHeld;
    uint256 public livenessProbesHeldButFree;
    uint256 public livenessProbesUncoverable;
    /// Asserted liveness probes whose chunk needed a walk (the free balance short of what it pays).
    uint256 public livenessAssertedWalks;
    /// Probes that processed a chunk needing a walk, whose removals _checkWalk then checked.
    uint256 public livenessWalksChecked;
    /// Probes inside the liveness precondition whose chunk the model predicts in the walk's whole-removal corner (the
    /// walk ended after a whole removal less than a rao an entry short of T, and the split on charged + cost left the
    /// entries more than the receipts): each must refuse exactly UnstakeShort.
    uint256 public livenessCorners;
    /// I-4's exceptions recorded here: cancels that lowered the price (none can, but over a hole).
    uint256 public i4CancelFalls;

    constructor(System memory s, Parts memory p) VaultModel(s) {
        tao = p.tao;
        bridge = p.bridge;
        doorChain = p.doorChain;
        foreignChain = p.foreignChain;
        firstHotkey = s.vaultLens.stakeHotkey();
        peer = s.vaultLens.peerId(p.doorChain, address(s.fd));
        stranger = makeAddr("stranger");
        foreigner = makeAddr("foreigner");
        doorHolders = [makeAddr("alice"), makeAddr("bob"), makeAddr("carol")];
        directHolders = [makeAddr("erin"), makeAddr("frank")];
        address[3] memory onBase = [doorHolders[0], doorHolders[1], doorHolders[2]];
        for (uint256 i; i < onBase.length; ++i) {
            _fund(onBase[i], true);
        }
        _fund(foreigner, true);
        _fund(directHolders[0], false);
        _fund(directHolders[1], false);
        _fund(stranger, false);
        _trackAccount(address(p.bridge));
        _trackAccount(p.foreignDoor);
        _trackWord(firstHotkey, WordKind.Hotkey);
        _trackWord(HK2, WordKind.Hotkey);
        _trackPeer(p.doorChain, address(s.fd));
        _trackPeer(p.foreignChain, p.foreignDoor);
        _trackMessage(p.doorChain, address(s.fd), "");
        // the second listed hotkey (the owner's listing), and a door on a second chain (its 7-day activation), so the
        // foreigner's redeem origin can be that chain (spec §3.4): its deposits at the launch door bounce
        staking.addHotkey(HK2);
        vm.prank(s.owner);
        s.vault.addHotkey(HK2);
        Schedule.run(s.vault, s.owner, abi.encodeCall(CascadeVault.activateFrontDoor, (p.foreignChain, p.foreignDoor)));
        vm.prank(foreigner);
        s.vault.setRedeemOrigin(p.foreignChain);
        _raiseFloor();
    }

    /// @dev Takes the payouts' refunds back.
    receive() external payable {}

    /// @dev After every action: I-13's liveness probe (_probeLiveness), and the queue's depth counted.
    modifier live() {
        _;
        _probeLiveness();
        if (queuedKeys.length >= 3) ++stepsWithThreeQueued;
    }

    // ---- the front door ----

    /// @dev A deposit at the front door: by a door holder, 0.03 TAO (the door's minimum, the bound's floor) to 50 TAO,
    /// or, one draw in three, by the foreigner (its deposit bounces at delivery, ForeignOrigin), at the floor one draw
    /// in two and up to 0.1 TAO otherwise. On one draw in two the keeper then closes the batch (_close).
    function doorDeposit(uint256 actorSeed, uint256 amount) external step live mints {
        address actor = actorSeed % 3 == 0 ? foreigner : doorHolders[(actorSeed / 3) % 3];
        _doorDeposit(actor, _depositAmount(actor, amount));
        if ((actorSeed >> 8) % 2 == 0) _close();
    }

    /// @dev A door holder without a request in the open batch asks to redeem some of its shares (_requestBy); on one
    /// draw in two the keeper then closes the batch (_close).
    function doorRedeem(uint256 actorSeed, uint256 shares) external step live mints {
        for (uint256 i; i < doorHolders.length; ++i) {
            address a = doorHolders[(actorSeed % doorHolders.length + i) % doorHolders.length];
            if (vault.balanceOf(a) == 0 || fd.redeemOf(a) != 0) continue;
            if (_requestBy(a, shares) && (actorSeed >> 8) % 2 == 0) _close();
            return;
        }
    }

    /// @dev The keeper's rounds at the front door, 1 to 3 of them (bits 5 and 6), 12 hours apart: in each, the
    /// foreigner's bounce at the floor (bit 0), a door holder's deposit (bit 1) and each door holder's redeem request
    /// (bits 2 to 4, one each) put into the open batch, then its close 12 hours on (_close); so batches of several
    /// entries pile up faster than chunks drain them (the payout delay is 48 hours).
    function closeBatch(uint256 seed) external step live mints {
        uint256 rounds = 1 + ((seed >> 5) & 3) % 3;
        for (uint256 i; i < rounds; ++i) {
            _round(i == 0 ? seed : uint256(keccak256(abi.encode(seed, i))));
        }
    }

    function _round(uint256 seed) internal {
        if (seed % 2 == 0) _doorDeposit(foreigner, fd.minDeposit());
        if ((seed >> 1) % 2 == 0) {
            address a = doorHolders[(seed >> 8) % 3];
            _doorDeposit(a, _depositAmount(a, seed >> 16));
        }
        for (uint256 i; i < doorHolders.length; ++i) {
            if ((seed >> (2 + i)) % 2 == 0) _requestBy(doorHolders[i], seed >> (40 + 64 * i));
        }
        _close();
    }

    /// One deposit at the front door: refused only by the door's limits, in its order (CapExceeded, BatchValueFull,
    /// BatchFull), which these amounts never reach.
    function _doorDeposit(address actor, uint256 amount) internal {
        if (amount == 0) return;
        (,, uint256 open,, uint256 nDeposits,) = fd.openBatch();
        uint256 total = open + amount;
        bytes4 expect;
        if (fd.netForwarded() + total > fd.depositCap()) {
            expect = CascadeFrontDoor.CapExceeded.selector;
        } else if (total > fd.maxBatchValue()) {
            expect = CascadeFrontDoor.BatchValueFull.selector;
        } else if (fd.depositOf(actor) == 0 && nDeposits >= fd.maxDeposits()) {
            expect = CascadeFrontDoor.BatchFull.selector;
        }
        _readLogs();
        vm.prank(actor);
        try fd.deposit(amount) {
            _succeeded(expect);
            ++doorDeposits;
            if (actor == foreigner) ++foreignDeposits;
        } catch (bytes memory reason) {
            _dropLogs();
            _refused(reason, expect);
        }
    }

    /// A deposit's amount, whole rao: the foreigner's at the door's minimum on an even seed, else up to 0.1 TAO; a door
    /// holder's from the minimum to MAX_DEPOSIT. 0 when the actor has too little.
    function _depositAmount(address actor, uint256 seed) internal view returns (uint256) {
        uint256 least = fd.minDeposit() / RAO;
        uint256 most = Math.min(actor == foreigner ? 0.1e18 : MAX_DEPOSIT, tao.balanceOf(actor)) / RAO;
        if (most < least) return 0;
        if (actor == foreigner && seed % 2 == 0) return least * RAO;
        return bound(seed >> 1, least, most) * RAO;
    }

    /// `actor`'s request at the door when it holds shares and has none in the open batch: all of its shares on one
    /// draw in four (so whole exits, and vaults left with few holders, are reached), else at least 0.05 TAO's worth
    /// (above the smallest burn, so few are deferred), paying the request fee. Whether one was made.
    function _requestBy(address actor, uint256 seed) internal returns (bool ok) {
        uint256 balance = vault.balanceOf(actor);
        if (balance == 0 || fd.redeemOf(actor) != 0) return false;
        uint256 least = CascadeMath.sharesForDeposit(0.05e18, vaultLens.totalAssets(), vault.totalSupply());
        uint256 shares = seed % 4 == 0 ? balance : bound(seed >> 2, Math.min(least, balance), balance);
        uint256 fee = fd.redeemRequestFee();
        _readLogs();
        vm.prank(actor);
        try fd.requestRedeem{value: fee}(shares) {
            ++doorRedeems;
            ok = true;
        } catch {
            _dropLogs();
            ++unexpectedReverts;
        }
    }

    /// Warps 12 hours (the door's timer) and closes the open batch when it holds anything, by its id with no minimum,
    /// the handler paying what its pot lacks of the Base lane's fee: no refusal is expected. MockBridge delivers at
    /// once (_recordDelivery). Then, on three closes in four, the keeper stakes what the delivery left idle (its round:
    /// with idleBufferBps 0 nothing stays idle, so the reservations the liquid balance does not hold are staked).
    function _close() internal {
        _warp(12 hours, doorBlockTime);
        (uint64 id,,, uint256 pot, uint256 nDeposits, uint256 nRedeems) = fd.openBatch();
        if (nDeposits + nRedeems == 0) return;
        _ageShares();
        bool underwater0 = vault.totalSupply() == 0 && _underwater();
        uint256 value = _sub0(bridge.fee(), pot);
        _readLogs();
        try fd.closeBatch{value: value}(id, 0) {
            ++closes;
            _recordDelivery(_readLogs(), underwater0);
        } catch (bytes memory reason) {
            _dropLogs();
            _refused(reason, 0);
            return;
        }
        if (closes % 4 != 0) _stake();
    }

    /// One delivery attempt: a refusal the bridge filed must be the state's (StakeMissing while stake is missing,
    /// VaultInsolvent at a supply of 0 underwater); a delivery's DepositBounced and Redeemed events, in log order, are
    /// the batch's list (a ForeignOrigin bounce is the foreigner's alone), and its PayoutBatchQueued must name exactly
    /// that list's count and value, which the ghosts then reserve (_queue).
    function _recordDelivery(Vm.Log[] memory logs, bool underwater0) internal {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory log = logs[i];
            if (log.emitter == address(bridge) && log.topics[0] == MockBridge.DeliveryFailed.selector) {
                (, bytes memory reason) = abi.decode(log.data, (uint256, bytes));
                bytes4 r = _selector(reason);
                if (r == VaultInsolvent.selector && underwater0) ++deliveriesRefusedUnderwater;
                else if (r == StakeMissing.selector && vaultLens.stakeMissing()) ++deliveriesRefusedWhileMissing;
                else ++unexpectedReverts;
                continue;
            }
            if (log.emitter != address(vault)) continue;
            bytes32 sig = log.topics[0];
            if (sig == BatchDelivered.selector) {
                ++deliveries;
            } else if (sig == DepositBounced.selector) {
                (uint256 assets, BounceReason why) = abi.decode(log.data, (uint256, BounceReason));
                address user = _topicAddress(log.topics[2]);
                _lists[log.topics[1]].push(CascadeMessages.Payout(user, 0, assets));
                ++depositBounces;
                if (why == BounceReason.ForeignOrigin) {
                    ++foreignBounces;
                    if (user != foreigner && !madeForeign[user]) ++unexpectedReverts;
                } else {
                    ++insolventBounces;
                }
            } else if (sig == Redeemed.selector) {
                (uint256 shares, uint256 assets) = abi.decode(log.data, (uint256, uint256));
                _lists[log.topics[1]].push(CascadeMessages.Payout(_topicAddress(log.topics[2]), shares, assets));
                ++redeemedEntries;
            } else if (sig == PayoutBatchQueued.selector) {
                (, uint32 count, uint256 total,) = abi.decode(log.data, (uint64, uint32, uint256, uint256));
                _queue(log.topics[1], count, total);
            } else if (sig == RedeemDeferred.selector) {
                ++redeemDeferred;
            } else if (sig == RedeemSkipped.selector) {
                ++redeemSkipped;
            }
        }
    }

    /// A batch queued: the ghosts take its list (from the delivery's events), reserve its value and start its cursor,
    /// chunk number and queue time.
    function _queue(bytes32 key, uint32 count, uint256 total) internal {
        CascadeMessages.Payout[] storage list = _lists[key];
        uint256 sum;
        for (uint256 i; i < list.length; ++i) {
            sum += list[i].assets;
        }
        if (list.length != count || sum != total) ++ghostMismatches;
        ghostRemaining[key] = sum;
        ghostPending += sum;
        ghostCursor[key] = 0;
        ghostChunk[key] = 0;
        // test-controlled time
        // casting to 'uint64' is safe because the timestamp is the test's
        // forge-lint: disable-next-line(unsafe-typecast)
        ghostQueuedAt[key] = uint64(vm.getBlockTimestamp());
        queuedKeys.push(key);
        maxQueueDepth = Math.max(maxQueueDepth, queuedKeys.length);
    }

    // ---- payouts ----

    /// @dev The next chunk of a queued batch, as the keeper (1 to 3 entries, raised to minChunk) or, one draw in four,
    /// a stranger (the largest chunk that fits), at the payout lane's fee (setPayoutFee). The batch is a due one
    /// (keySeed picks it), or, when none is due, the oldest, its payout delay waited out first at the vault's block
    /// rate (so the clock moves only when nothing is due, and batches pile up); on one draw in eight it is any queued
    /// batch, due or not (PayoutDelayed while it is not due). The call's value, by valueSeed mod 8: none (0), the
    /// top-up less a rao (1), the top-up and part of a rao (2: BadValue), the top-up and up to 0.01 TAO more (3: the
    /// rest refunded), or the exact top-up (4 to 7).
    function processPayouts(uint256 keySeed, uint256 entriesSeed, uint256 valueSeed, uint256 callerSeed)
        external
        step
        live
    {
        uint256 n = queuedKeys.length;
        if (n == 0) return;
        bytes32 key = entriesSeed % 8 == 0 ? queuedKeys[keySeed % n] : _dueKey(keySeed);
        if (key == bytes32(0)) {
            key = _oldestKey();
            _waitUntilDue(key);
        }
        bool byStranger = callerSeed % 4 == 0;
        // casting to 'uint32' is safe because the value is at most CHUNK_ENTRIES
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 maxEntries = uint32(1 + (entriesSeed >> 3) % CHUNK_ENTRIES);
        Chunk memory c = _plan(key, maxEntries, !byStranger);
        uint256 value = _value(c.topUpAsked, valueSeed);
        // planned again with the value: one that covers the whole fee pays it all (the full top-up, R4)
        c = _planAt(key, maxEntries, !byStranger, value);
        _send(c, byStranger ? stranger : address(this), value, maxEntries);
    }

    /// @dev The keeper's round when several batches are due (spec §3.3's case: two or more queued batches at zero idle
    /// balance all processed): on an even seed it first stakes what is idle (so nothing is), then waits until two
    /// batches are due (when two are queued), then sends each due batch's chunks (the largest, at the exact top-up)
    /// until it is done or a chunk refuses as its state predicts, and stops after DRAIN_BATCHES batches are done (the
    /// fix round's Minor 2: the rest stay queued, so the queue stays deep). Counted when two or more batches finished
    /// from nothing idle with a walk, and when they did so at a 1-rao removal fee.
    function drainDue(uint256 seed) external step live mints {
        if (queuedKeys.length == 0) return;
        if (seed % 2 == 0) _stake();
        _waitForTwoDue();
        bool idle0 = _availableAt(ghostPending) == 0;
        uint256 walkedBefore = walkedChunks;
        uint256 done;
        bytes32[] memory keys = _dueKeys();
        for (uint256 i; i < keys.length && done < DRAIN_BATCHES; ++i) {
            for (uint256 j; j < CascadeMessages.MAX_ENTRIES && ghostQueuedAt[keys[i]] != 0; ++j) {
                Chunk memory c = _plan(keys[i], uint32(CascadeMessages.MAX_ENTRIES), true);
                if (!_send(c, address(this), c.topUpAsked, uint32(CascadeMessages.MAX_ENTRIES))) break;
                if (ghostQueuedAt[keys[i]] == 0) ++done;
            }
        }
        ++drains;
        if (done >= 2 && idle0 && walkedChunks > walkedBefore) {
            ++multiBatchDrains;
            if (staking.removeFeeRao() == 1) ++multiBatchDrainsAtFee1;
        }
    }

    /// The chunk of batch `key` the vault would take now, restated (spec §3.3's block, line by line): the chunk from
    /// the ghost cursor (the keeper's maxEntries raised to minChunk, else MAX_ENTRIES; VaultModel's takeChunk), its
    /// ceiling, the fee rounded up to rao, the entries' share of it floored to rao, the top-up, each entry's net
    /// (VaultModel's deductFee), what the vault pays, the other batches' reservations and the free balance from the
    /// ghosts and the vault's balance, and then its walk and what follows it (VaultModel's _chunkAfterWalk: the walk's
    /// cost split over the entries with the fee's share, and the refusal, if any).
    function _plan(bytes32 key, uint32 maxEntries, bool isKeeper) internal view returns (Chunk memory c) {
        return _planAt(key, maxEntries, isKeeper, 0);
    }

    /// _plan for a caller sending `value`: when it covers the whole fee (before any dust zeroes it), the caller pays all
    /// of it and the entries are charged nothing (the full top-up, R4: CascadePayoutLib.prepare), so the top-up asked is
    /// the whole fee and each entry's net its gross.
    function _planAt(bytes32 key, uint32 maxEntries, bool isKeeper, uint256 value)
        internal
        view
        returns (Chunk memory c)
    {
        CascadeMessages.Payout[] memory list = _lists[key];
        c.key = key;
        c.cursor = ghostCursor[key];
        uint256 minChunk = vaultLens.minChunk();
        uint256 limit = isKeeper
            ? Math.min(Math.max(maxEntries, minChunk), CascadeMessages.MAX_ENTRIES)
            : CascadeMessages.MAX_ENTRIES;
        (c.taken, c.sum) = _takeChunk(list, c.cursor, limit, vaultLens.maxMessageValue(), minChunk);
        c.ceiling = feeCeiling(c.sum, vaultLens.maxFeeBps(), vaultLens.maxFeeAbs());
        (c.fee, c.charged) = _feeSplit(payoutFee, c.sum);
        if (value >= c.fee) c.charged = 0;
        c.topUpAsked = c.fee - c.charged;
        c.topUp = c.topUpAsked;
        (c.nets, c.net, c.sharesAtZero, c.dust) = _deductFee(list, c.cursor, c.taken, c.charged, c.sum);
        if (c.net == 0) (c.fee, c.charged, c.topUp) = (0, 0, 0);
        c.need = c.net + c.charged;
        c.others = ghostPending - ghostRemaining[key];
        c.free = _availableAt(c.others);
        c.coverable = true;
        // the vault refuses an entry with shares at 0 before it walks
        if (c.sharesAtZero) return c;
        ChunkOut memory o = _chunkAfterWalk(list, c.cursor, c.taken, c.charged, c.sum, c.nets, c.net, c.dust, c.free);
        (c.walk, c.walkRefusal, c.received, c.cost) = (o.walk, o.refusal, o.received, o.cost);
        (c.nets, c.net, c.unmet, c.zeroed) = (o.nets, o.net, o.unmet, o.zeroed);
        (, c.coverable) = _chunkWalk(c.free, c.need);
    }

    /// The refusal chunk `c` must meet with `value`, in L3's order (CascadePayoutLib.prepare, then the vault's walk),
    /// or none.
    function _expected(Chunk memory c, uint256 value) internal view returns (bytes4) {
        // test-controlled time
        // forge-lint: disable-next-line(block-timestamp)
        if (vm.getBlockTimestamp() < uint256(ghostQueuedAt[c.key]) + vaultLens.payoutDelay()) {
            return PayoutDelayed.selector;
        }
        if (vaultLens.doorState(peer) != DoorState.Active) return FrontDoorInactive.selector;
        if (!vaultLens.bridgeEnabled(vaultLens.primaryBridge())) return PrimaryBridgeDisabled.selector;
        if (c.sharesAtZero) return FeeTooHigh.selector;
        if (value % RAO != 0) return BadValue.selector;
        if (value < c.topUpAsked) return FeeTooHigh.selector;
        return c.walkRefusal;
    }

    /// Sends chunk `c` as `caller` with `value`: refused as `_expected` predicts, else checked (_checkChunk). Whether
    /// it was sent.
    function _send(Chunk memory c, address caller, uint256 value, uint32 maxEntries) internal returns (bool sent) {
        bytes4 expect = _expected(c, value);
        Call memory k = Call(
            caller,
            value,
            address(vault).balance,
            caller.balance,
            address(bridge).balance,
            _coldkeyStake(),
            _markPrice()
        );
        CascadeMessages.Payout[] memory list = _lists[c.key];
        bool held = _anyPairLocked();
        bridge.setFee(payoutFee);
        uint256 gasBefore = gasleft();
        _readLogs();
        if (caller != address(this)) vm.prank(caller);
        try vault.processPayouts{value: value, gas: CALL_GAS}(c.key, list, maxEntries) {
            bridge.setFee(WORLD_FEE);
            _succeeded(expect);
            _checkChunk(c, k, _readLogs());
            sent = true;
        } catch (bytes memory reason) {
            uint256 used = gasBefore - gasleft();
            bridge.setFee(WORLD_FEE);
            _dropLogs();
            if (_refused(reason, expect)) _countRefusal(c, expect, value, held, used);
        }
    }

    /// After a chunk was sent: I-13 (sent as queued less each entry's share of charged + cost, the ceiling and the
    /// cost, the caller's top-up), I-14 (no dust), I-12 (the reservations), I-35 (the price and the hole), then the
    /// ghosts advanced.
    function _checkChunk(Chunk memory c, Call memory k, Vm.Log[] memory logs) internal {
        CascadeMessages.Payout[] memory list = _lists[c.key];
        uint32 chunkNo = ghostChunk[c.key];
        bool logged;
        bool delivered;
        uint256 next = c.cursor;
        uint256 shares;
        uint256 withheld;
        uint256 unstaked;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory log = logs[i];
            if (log.emitter == address(bridge) && log.topics[0] == MockBridge.DeliveryFailed.selector) {
                // the front door refused the chunk the bridge carried
                ++chunkMismatches;
            } else if (log.emitter == address(fd)) {
                if (log.topics[0] == CascadeFrontDoor.PayoutsDelivered.selector) {
                    (uint32 chunk, uint256 amount,) = abi.decode(log.data, (uint32, uint256, address));
                    delivered = true;
                    if (log.topics[1] != c.key || chunk != chunkNo || amount != c.net) ++chunkMismatches;
                } else if (log.topics[0] == CascadeFrontDoor.PayoutReceived.selector) {
                    (uint32 chunk, uint256 amount) = abi.decode(log.data, (uint32, uint256));
                    // the next entry the split kept, in the queued order
                    while (next < c.cursor + c.taken && c.nets[next - c.cursor] == 0) {
                        ++next;
                    }
                    if (next == c.cursor + c.taken) {
                        ++chunkMismatches;
                        continue;
                    }
                    CascadeMessages.Payout memory p = list[next];
                    if (
                        log.topics[1] != c.key || chunk != chunkNo || _topicAddress(log.topics[2]) != p.user
                            || amount != c.nets[next - c.cursor]
                    ) ++chunkMismatches;
                    shares += _sub0(p.assets, amount);
                    if (p.shares == 0) ++bouncesPaid;
                    ++next;
                }
            } else if (log.emitter == address(vault)) {
                if (log.topics[0] == PayoutChunkSent.selector && log.topics[1] == c.key) {
                    logged = true;
                    if (!_chunkLogged(log.data, c, chunkNo)) ++chunkMismatches;
                } else if (log.topics[0] == PayoutDust.selector) {
                    ++payoutDusts;
                    (bool withShares, uint256 assets) = _dustEntry(list, c, _topicAddress(log.topics[2]));
                    if (withShares) ++dustWithShares;
                    withheld += assets;
                } else if (log.topics[0] == Unstaked.selector) {
                    ++unstaked;
                }
            }
        }
        // every kept entry credited, the bridge paid net + fee, and the vault's record of it
        while (next < c.cursor + c.taken && c.nets[next - c.cursor] == 0) {
            ++next;
        }
        if (!logged || next != c.cursor + c.taken || delivered != (c.net != 0)) ++chunkMismatches;
        if (address(bridge).balance != k.bridgeBefore + c.net + c.fee) ++chunkMismatches;
        // the entries bear at least what they were charged and the walk's cost (a dust entry, I-14's, all it was owed)
        // and the ones sent at most the ceiling and the cost, up to a rao an entry
        if (shares + withheld < c.charged + c.cost || shares > c.ceiling + c.cost + c.taken * RAO) ++ceilingBreaches;
        // the walk's cost from its Unstaked logs is the model's (PayoutChunkSent's unstakeCost is checked against it)
        (uint256 cost,) = _loggedCost(logs);
        if (cost != c.cost) ++chunkMismatches;
        // the caller pays the top-up and no more: the rest of its value comes back in the same call
        if (k.caller.balance + c.topUp != k.callerBefore) ++callerMispaid;
        _reservesKept(k.vaultBefore, c.others);
        _exitRemovals(logs, k.stakeBefore);
        _checkExitPrice(k.mark);
        _checkWalk(logs, c.walk);
        _advance(c, list.length);
        ++payoutChunks;
        if (k.caller != address(this)) ++chunksByStranger;
        if (c.topUp != 0) ++topUpChunks;
        if (k.value > c.topUp) ++refundedChunks;
        if (c.free < c.need) {
            ++walkedChunks;
            if (staking.removeFeeRao() > SHORTFALL_TOLERANCE / RAO) ++chunksSentAtAFeePastT;
        }
        if (c.cost != 0) ++chunksChargedWalkCost;
        if (unstaked > 1) ++multiPositionWalks;
    }

    /// Whether PayoutChunkSent's data is chunk `c`'s, numbered `chunkNo`: its entries, gross, net, fee, charged and
    /// the walk's cost (unstakeCost).
    function _chunkLogged(bytes memory data, Chunk memory c, uint32 chunkNo) internal pure returns (bool) {
        (uint32 chunk, uint32 taken, uint256 gross, uint256 net, uint256 fee, uint256 charged, uint256 unstakeCost) =
            abi.decode(data, (uint32, uint32, uint256, uint256, uint256, uint256, uint256));
        return chunk == chunkNo && taken == c.taken && gross == c.sum && net == c.net && fee == c.fee
            && charged == c.charged && unstakeCost == c.cost;
    }

    /// The chunk's entry left with nothing for `user` (a PayoutDust): whether it has shares, and what it was owed.
    function _dustEntry(CascadeMessages.Payout[] memory list, Chunk memory c, address user)
        internal
        pure
        returns (bool withShares, uint256 assets)
    {
        for (uint256 i; i < c.taken; ++i) {
            CascadeMessages.Payout memory p = list[c.cursor + i];
            if (c.nets[i] == 0 && p.user == user) return (p.shares != 0, p.assets);
        }
    }

    /// I-12, from the snapshot taken before the exit: the vault's balance before it (its caller's value not in it) and
    /// the other reservations; after it, `balance - ED >= min(before - ED, others)`, asserted unfloored (the fix
    /// round's Minor 1): `balance >= min(before, ED + others)`, so an exit with no other reservation still keeps
    /// ED_RESERVE.
    function _reservesKept(uint256 before, uint256 others) internal {
        if (address(vault).balance < Math.min(before, ED + others)) ++reserveBreaches;
    }

    /// The ghosts after chunk `c` went out: the cursor past it, the reservation released, the chunk number on; a batch
    /// done leaves the queue (and the vault must have deleted it).
    function _advance(Chunk memory c, uint256 count) internal {
        bytes32 key = c.key;
        ghostCursor[key] = c.cursor + c.taken;
        ghostRemaining[key] -= c.sum;
        ghostPending -= c.sum;
        ++ghostChunk[key];
        if (ghostCursor[key] < count) {
            ++partialChunks;
            return;
        }
        if (carried[key]) ++carriedBatchesPaid;
        _dropKey(key);
    }

    /// A refused chunk, counted by the state its refusal is tied to (FeeTooHigh: an entry with shares at 0, else a
    /// value short of the top-up, else the walk's cost; UnstakeShort: the hold, else the walk's reach, else finish's
    /// check that the receipts fund the send).
    function _countRefusal(Chunk memory c, bytes4 expect, uint256 value, bool held, uint256 gasUsed) internal {
        if (expect == PayoutDelayed.selector) {
            ++payoutsRefusedEarly;
        } else if (expect == BadValue.selector) {
            ++payoutsRefusedBadValue;
        } else if (expect == FeeTooHigh.selector) {
            if (c.sharesAtZero) ++payoutsRefusedSharesAtZero;
            else if (value < c.topUpAsked) ++payoutsRefusedFeeShort;
            else ++chunksRefusedWalkCost;
        } else if (expect == UnstakeShort.selector) {
            if (!c.coverable && held) {
                ++payoutsRefusedHeld;
                if (staking.burnRemoveGas()) {
                    ++payoutsRefusedHeldBurning;
                    maxHeldBurnGas = Math.max(maxHeldBurnGas, gasUsed);
                }
            } else if (!c.coverable) {
                ++payoutsUncoverable;
                if (_dustPosition()) ++dustBlocked;
            } else {
                ++payoutsRefusedCoverage;
            }
        }
    }

    /// The call's value for a chunk whose top-up is `topUp` (see processPayouts).
    function _value(uint256 topUp, uint256 seed) internal pure returns (uint256) {
        uint256 kind = seed % 8;
        if (kind == 0) return 0;
        if (kind == 1) return _sub0(topUp, RAO);
        if (kind == 2) return topUp + 1 + (seed >> 3) % (RAO - 1);
        if (kind == 3) return topUp + bound(seed >> 3, 1, 1e7) * RAO;
        return topUp;
    }

    // ---- I-13's liveness ----

    /// After every step: the first due batch from a rolling start is attempted with the keeper's chunk and the exact
    /// top-up, inside a snapshot reverted after it (its logs dropped, its outcome counted after the revert). I-13's
    /// liveness, the spec's sufficient condition restated (Revision 10 L-1, with Task 36b's leaver pays): with no
    /// listed pair locked (read on the mock), the batch's door and the primary bridge active, and the chunk's own terms
    /// met (_livenessHolds: no entry with shares at 0, and either the free balance pays it or the positions the walk may
    /// take hold need - free + T at face value, on the mock's positions and the ghosts' reservations, with no entry
    /// zeroed by its share of the predicted walk cost), it must process (`livenessFailures`), and as the model
    /// predicts (`livenessMispredicted`), unless the model predicts the walk's whole-removal corner (_walksCorner), the
    /// spec's one carve-out, where it must refuse exactly UnstakeShort (`livenessCorners`; anything else there,
    /// `livenessCornerMismatches`). Otherwise it must refuse as the model predicts (UnstakeShort under the hold when the
    /// chunk needs a walk, or when the walk cannot reach the stake; FeeTooHigh when its cost would zero an entry), or
    /// process when the model predicts no refusal. Stake missing is no precondition: processPayouts never reads it.
    function _probeLiveness() internal {
        bytes32 key = _dueKey(steps);
        if (key == bytes32(0)) return;
        Chunk memory c = _plan(key, CHUNK_ENTRIES, true);
        bool holdOff = !_anyPairLocked();
        bool preconditions = holdOff && vaultLens.doorState(peer) == DoorState.Active
            && vaultLens.bridgeEnabled(vaultLens.primaryBridge()) && _livenessHolds(c);
        bool corner = preconditions && _walksCorner(c);
        bytes4 expect = _expected(c, c.topUpAsked);
        CascadeMessages.Payout[] memory list = _lists[key];
        _readLogs();
        uint256 snap = vm.snapshotState();
        bridge.setFee(payoutFee);
        bool ok;
        bytes4 why;
        Vm.Log[] memory logs;
        try vault.processPayouts{value: c.topUpAsked, gas: CALL_GAS}(key, list, CHUNK_ENTRIES) {
            ok = true;
            // the attempt's logs, read before the revert and never folded (TrackedHandler's _onLogs)
            logs = vm.getRecordedLogs();
        } catch (bytes memory reason) {
            why = _selector(reason);
        }
        vm.revertToStateAndDelete(snap);
        _dropLogs();
        ++livenessProbes;
        if (ok) {
            if (c.walk.length != 0) ++livenessWalksChecked;
            _checkWalk(logs, c.walk);
        }
        if (corner) {
            ++livenessAsserted;
            ++livenessAssertedWalks;
            ++livenessCorners;
            // the carve-out refuses exactly UnstakeShort, the model's verdict too (finish's coverage check)
            if (ok || why != UnstakeShort.selector || expect != UnstakeShort.selector) {
                ++livenessCornerMismatches;
                lastLivenessFailure = why;
            }
        } else if (preconditions) {
            ++livenessAsserted;
            if (c.free < c.need) ++livenessAssertedWalks;
            if (!ok) {
                ++livenessFailures;
                lastLivenessFailure = why;
            } else if (expect != 0) {
                ++livenessMispredicted;
            }
        } else if (ok ? expect != 0 : why != expect) {
            ++livenessMispredicted;
        }
        if (!holdOff) {
            ++livenessProbesHeld;
            if (ok) ++livenessProbesHeldButFree;
        } else if (c.walkRefusal != 0 && !corner) {
            ++livenessProbesUncoverable;
        }
    }

    /// I-13's liveness precondition on chunk `c`'s own terms, the spec's sufficient condition (§3.3), the hold, the
    /// door and the bridge being the caller's: no entry with shares at 0 in the first split, and then either the free
    /// balance pays what the vault sends (no walk), or the positions the walk may take (unheld, at least the chain's
    /// minimum) hold need - free + T at face value (VaultModel's _walkableStake, on the mock) and no entry is zeroed by
    /// its share of the predicted walk cost (VaultModel's split on charged + cost). It never reads the model's verdict on
    /// the walk's reach or on finish's coverage check, so a refusal the vault and the model share inside it still fails.
    function _livenessHolds(Chunk memory c) internal view returns (bool) {
        if (c.sharesAtZero) return false;
        if (c.free >= c.need) return true;
        return _walkableStake() * RAO >= c.need - c.free + SHORTFALL_TOLERANCE && !c.zeroed;
    }

    /// Whether the model predicts chunk `c` in the walk's whole-removal corner, I-13's one carve-out (spec §3.3): the
    /// walk ended after a whole removal with what it left untaken within `taken` rao of T (T - unmet < taken rao, the
    /// cushion short of a rao an entry), and the split on charged + cost leaves the entries more than the free balance
    /// and the receipts fund (free + received < net + charged), so finish refuses UnstakeShort though other positions
    /// may hold plenty. Only a removal fee makes it (with no cost the receipts are the stake taken, at least need -
    /// free); it waits until the balance or the positions move.
    function _walksCorner(Chunk memory c) internal pure returns (bool) {
        uint256 n = c.walk.length;
        if (n == 0 || !c.walk[n - 1].full) return false;
        return c.unmet + c.taken * RAO > SHORTFALL_TOLERANCE && c.free + c.received < c.net + c.charged;
    }

    // ---- direct users ----

    /// @dev A direct deposit by erin or frank, 0.001 to 50 TAO. Its refusals, in the vault's order: StakeMissing while
    /// stake is missing, VaultInsolvent below half the launch price or underwater, CapExceeded above the cap.
    function depositDirect(uint256 actorSeed, uint256 amount) external step live mints {
        address actor = directHolders[actorSeed % directHolders.length];
        uint256 most = Math.min(MAX_DEPOSIT, _sub0(actor.balance, FEE_MONEY)) / RAO;
        uint256 least = vaultLens.minDirectDeposit() / RAO;
        if (most < least) return;
        amount = bound(amount, least, most) * RAO;
        uint256 assets = vaultLens.totalAssets();
        bytes4 expect;
        if (vaultLens.stakeMissing()) expect = StakeMissing.selector;
        else if (assets * 2_000_000 < vault.totalSupply() || _underwater()) expect = VaultInsolvent.selector;
        else if (assets + amount > vaultLens.maxTotalAssets()) expect = CapExceeded.selector;
        _readLogs();
        vm.prank(actor);
        try vault.depositDirect{value: amount}() {
            _succeeded(expect);
            ++directDeposits;
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, expect) && expect == VaultInsolvent.selector) ++directDepositsRefusedInsolvent;
        }
    }

    /// @dev A direct exit by a holder (any, door's or direct): all of its shares on one draw in four, any number of
    /// them on one in eight, else at least a hundredth of them. Its value is the handler's own pricing at the call
    /// (VaultModel's assets on the mock's positions, the booked stake and the ghosts' reservations), floored to rao;
    /// ZeroAmount under a rao, UnstakeShort when the restated walk leaves more than T untaken, ZeroAmount when the walk's
    /// cost leaves the leaver nothing (StakeMissing while stake is missing; VaultModel's _exitPlan). I-13: paid exactly
    /// floorToRao(out - unmet - cost), as RedeemedDirect says (_checkDirectExit); I-12 against every reservation; I-35.
    function redeemDirect(uint256 actorSeed, uint256 shares) external step live {
        (address actor, uint256 balance) = _holderWith(actorSeed);
        if (balance == 0) return;
        if (shares % 4 == 0) shares = balance;
        else if (shares % 8 == 1) shares = bound(shares >> 3, 1, balance);
        else shares = bound(shares >> 3, Math.max(1, balance / 100), balance);
        _directExit(actor, shares);
    }

    /// @dev A run (spec §3.5's "everyone asking at once"), on one draw in four (by a hash of the seed): every door
    /// holder asks the door to redeem all of its shares and the keeper closes the batch, then every direct holder exits
    /// whole. What the vault keeps is the reservations and whatever the walk cannot reach, so the last chunks and the
    /// last exits meet a position below the chain's minimum (dustBlocked) or a supply of 0 whose receipts fell short.
    function bankRun(uint256 seed) external step live mints {
        if (uint256(keccak256(abi.encode(seed, "run"))) % 4 != 0) return;
        bool asked;
        for (uint256 i; i < doorHolders.length; ++i) {
            if (_requestBy(doorHolders[i], 0)) asked = true;
        }
        if (asked) _close();
        for (uint256 i; i < directHolders.length; ++i) {
            uint256 balance = vault.balanceOf(directHolders[i]);
            if (balance != 0) _directExit(directHolders[i], balance);
        }
        ++bankRuns;
    }

    /// One direct exit of `shares` by `actor` (see redeemDirect).
    function _directExit(address actor, uint256 shares) internal {
        uint256 out =
            CascadeMath.assetsForRedeem(shares, _assetsAt(vaultLens.bookedStake(), ghostPending), vault.totalSupply());
        out -= out % RAO;
        uint256 before = address(vault).balance;
        uint256 available = _availableAt(ghostPending);
        ExitOut memory e = _exitPlan(available, out);
        bytes4 expect = vaultLens.stakeMissing() ? StakeMissing.selector : e.refusal;
        bool besideStaked = ghostPending != 0 && ghostPending > _sub0(before, ED);
        bool held = _anyPairLocked();
        uint256 paidBefore = actor.balance;
        uint256 stakeBefore = _coldkeyStake();
        uint256[3] memory mark = _markPrice();
        uint256 gasBefore = gasleft();
        _readLogs();
        vm.prank(actor);
        try vault.redeemDirect{gas: CALL_GAS}(shares, false) {
            _succeeded(expect);
            uint256 paid = actor.balance - paidBefore;
            Vm.Log[] memory logs = _readLogs();
            _checkDirectExit(logs, actor, out, available, paid, e);
            _reservesKept(before, ghostPending);
            _exitRemovals(logs, stakeBefore);
            _checkExitPrice(mark);
            _checkWalk(logs, e.walk);
            ++directExits;
            if (available < out) ++directExitsWalked;
            if (besideStaked) {
                ++directExitsBesideStakedPayout;
                if (staking.removeFeeRao() == 1) ++directExitsBesideStakedPayoutAtFee1;
            }
        } catch (bytes memory reason) {
            uint256 used = gasBefore - gasleft();
            _dropLogs();
            if (!_refused(reason, expect)) return;
            if (expect == ZeroAmount.selector) {
                if (out == 0) ++directExitsRefusedZero;
                else ++exitsRefusedByCost;
            } else if (expect == UnstakeShort.selector) {
                if (held) {
                    ++directExitsRefusedHeld;
                    if (staking.burnRemoveGas()) maxHeldBurnGas = Math.max(maxHeldBurnGas, used);
                } else {
                    ++directExitsUncoverable;
                    if (_dustPosition()) ++dustBlocked;
                }
            }
        }
    }

    /// I-13's direct half (Task 36b): from the call's logs, the stake its walk took at face value (`taken`) and its
    /// cost (what the chain kept of it, rounded up to rao: VaultModel's _loggedCost); `unmet` the part of out -
    /// available the walk did not take, at most 1,000 rao; the leaver paid exactly floorToRao(out - unmet - cost), its
    /// ShortfallAbsorbed unmet + cost (none when that is 0), and RedeemedDirect naming the pay (`directMispaid`); and
    /// the unmet, the cost and the pay those VaultModel predicted before the call, `e` (`directMispredicted`).
    function _checkDirectExit(
        Vm.Log[] memory logs,
        address actor,
        uint256 out,
        uint256 available,
        uint256 paid,
        ExitOut memory e
    ) internal {
        (uint256 cost, uint256 taken) = _loggedCost(logs);
        uint256 unmet = available >= out ? 0 : _sub0(out - available, taken);
        if (unmet + cost != 0) ++directExitsShort;
        uint256 owed = _sub0(out, unmet + cost);
        if (paid != owed - owed % RAO || unmet > SHORTFALL_TOLERANCE || _absorbed(logs) != unmet + cost) {
            ++directMispaid;
        }
        if (unmet != e.unmet || cost != e.cost || paid != e.paid) ++directMispredicted;
        bool logged;
        for (uint256 i; i < logs.length; ++i) {
            if (!_isVaultLog(logs[i], RedeemedDirect.selector)) continue;
            (, uint256 assets,) = abi.decode(logs[i].data, (uint256, uint256, bool));
            logged = _topicAddress(logs[i].topics[1]) == actor && assets == paid;
        }
        if (!logged) ++directMispaid;
    }

    // ---- the keeper and the owner ----

    /// @dev The keeper stakes the idle balance (idleBufferBps 0: all of it), when there is at least the minimum.
    function stakeIdle() external step live {
        _stake();
    }

    function _stake() internal {
        uint256 idle = _availableAt(ghostPending);
        if (idle / RAO < vaultLens.minStakeRao()) return;
        uint256 heldBefore = _stakeOf(vaultLens.stakeHotkey());
        _readLogs();
        try vault.stakeIdle() {
            ++stakes;
            // a fresh position's read one rao short is I-4's last exception (exact reads here: none expected)
            _freshRead(_readLogs(), heldBefore);
        } catch {
            _dropLogs();
            ++unexpectedReverts;
        }
    }

    /// @dev The keeper claims root rewards on a listed hotkey, the one that is not the stake hotkey on an even seed
    /// (paid as stake on it, vesting over the period): 0.0001 TAO to just under the chain's minimum on an even amount,
    /// else up to 1 TAO. Onto an empty position, a claim below the minimum leaves a position the walk skips, which no
    /// stake joins until the stake hotkey moves there.
    function accrueAndClaim(uint256 hotkeySeed, uint256 rao) external step live {
        bytes32 current = vaultLens.stakeHotkey();
        bytes32 other = current == firstHotkey ? HK2 : firstHotkey;
        bytes32 h = hotkeySeed % 2 == 0 ? other : current;
        rao = bound(rao >> 1, 1e5, rao % 2 == 0 ? vaultLens.minStakeRao() - 1 : 1e9);
        bool dust = _stakeOf(h) == 0 && rao < vaultLens.minStakeRao();
        staking.setUnclaimed(coldkey, h, rao);
        _readLogs();
        try vault.claimRewards{gas: 60_000_000}(h) {
            ++claims;
            if (dust) ++dustClaims;
        } catch {
            _dropLogs();
            ++unexpectedReverts;
        }
    }

    /// @dev The owner moves the stake hotkey to the other listed one: at once when that is no loosening (the other
    /// holds more than the stake hotkey and at least half the booked stake), else through its schedule (48 hours
    /// waited).
    function switchStakeHotkey() external step live {
        bytes32 current = vaultLens.stakeHotkey();
        bytes32 other = current == firstHotkey ? HK2 : firstHotkey;
        bytes memory data = abi.encodeCall(CascadeVault.setStakeHotkey, (other));
        bool atOnce = _stakeOf(other) > _stakeOf(current) && _stakeOf(other) >= vaultLens.bookedStake() / 2;
        if (atOnce) {
            _readLogs();
            vm.prank(owner);
            try vault.setStakeHotkey(other) {}
            catch (bytes memory reason) {
                _dropLogs();
                _refused(reason, 0);
                return;
            }
        } else if (!_tryRunScheduled(vault, data)) {
            return;
        }
        if (vaultLens.stakeHotkey() != other) ++unexpectedReverts;
        ++stakeHotkeySwitches;
    }

    /// @dev The owner cancels a queued batch (keySeed picks it, preferring one that holds both entries with shares and
    /// bounces). Its unsent entries with shares are re-minted and its unsent bounces carried, in their order, as the
    /// batch's new list (spec §3.5, §3.10.15); with no entry with shares left it must refuse NothingToCancel. On a
    /// success: the queued payouts fall by exactly the re-minted entries' value (I-19: no bounce released), its
    /// PayoutBatchCancelled names that value and the carried count, the vault's stored batch is the handler's carried
    /// list (count, cursor 0, remaining, chunk number kept), and, inside a snapshot, a cancel of that key with that
    /// list refuses NothingToCancel and a processPayouts with it refuses nothing for a list mismatch (the carried-list
    /// comparison, Task 22's M2).
    function cancelQueued(uint256 keySeed) external step live {
        if (queuedKeys.length == 0) return;
        _cancel(_cancelKey(keySeed));
    }

    /// @dev The owner's cancel after a partial chunk, aimed at (a targeted draw, Task 42's fix round 4, the review's
    /// I-2; VaultPayouts' test_cancelPayoutBatch_afterPartialChunk in the campaign): a queued batch whose unsent list
    /// holds an entry with shares past its next entry (from the seed on; its payout delay waited out at the vault's
    /// block rate when it is not due yet) gets the keeper's one-entry chunk at the exact top-up, refused only as
    /// predicted (_send); when it went, the batch is still queued and an entry with shares is unsent, the owner cancels
    /// it with cancelQueued's checks (`cancelsAfterPartial`). A no-op with no such batch, or when the chunk refuses.
    function toTheCancelAfterPartial(uint256 seed) external step live {
        bytes32 key = _partialKey(seed);
        if (key == bytes32(0)) return;
        _waitUntilDue(key);
        Chunk memory c = _plan(key, 1, true);
        if (!_send(c, address(this), c.topUpAsked, 1)) return;
        if (ghostQueuedAt[key] == 0 || !_sharesUnsent(key, ghostCursor[key])) return;
        uint256 before = cancelsAfterPartial;
        _cancel(key);
        if (cancelsAfterPartial > before) ++cancelAfterPartialDraws;
    }

    /// The first queued key from `seed` on whose unsent list holds an entry with shares after its next one, or 0.
    function _partialKey(uint256 seed) internal view returns (bytes32) {
        uint256 n = queuedKeys.length;
        for (uint256 i; i < n; ++i) {
            bytes32 key = queuedKeys[(seed % n + i) % n];
            if (_sharesUnsent(key, ghostCursor[key] + 1)) return key;
        }
        return bytes32(0);
    }

    /// Whether batch `key`'s list holds an entry with shares from `from` on.
    function _sharesUnsent(bytes32 key, uint256 from) internal view returns (bool) {
        CascadeMessages.Payout[] storage list = _lists[key];
        for (uint256 i = from; i < list.length; ++i) {
            if (list[i].shares != 0) return true;
        }
        return false;
    }

    /// The owner's cancel of batch `key` (cancelQueued's): see cancelQueued.
    function _cancel(bytes32 key) internal {
        CascadeMessages.Payout[] memory list = _lists[key];
        uint256 cursor = ghostCursor[key];
        (CascadeMessages.Payout[] memory kept, uint256 reMinted) = _carriedList(list, cursor);
        bytes4 expect = reMinted == 0 && kept.length == list.length - cursor ? NothingToCancel.selector : bytes4(0);
        uint256 pendingBefore = vaultLens.pendingPayouts();
        CancelMark memory m = CancelMark(
            vaultLens.price(),
            vaultLens.totalAssets() != 0,
            _giveBackNow(false),
            cancelFloor(key),
            list.length - cursor - kept.length,
            reMinted,
            _shortfallGiveBackNow(),
            _markPrice()
        );
        _readLogs();
        vm.prank(owner);
        try vault.cancelPayoutBatch(key, list) {
            _succeeded(expect);
            _cancelBound(m);
            _checkCancel(key, _readLogs(), kept, reMinted, pendingBefore);
            ++cancels;
            if (cursor != 0) ++cancelsAfterPartial;
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, expect)) ++cancelsRefusedNothing;
        }
    }

    /// I-4's cancel exception, as the core campaign checks it (PriceFloorTracker's cancelFloor and cancelBoundMet):
    /// with a rao per re-minted entry given back over a hole only (none elsewhere: the re-mint rounds in the vault's
    /// favour, Task 36b) and, at a supply of 0, the payout gap or the whole shortfall the re-minted holders absorb (above
    /// it, the hole such a cancel starts over, _holeOver), at most their value (_cancelGiveBack), the price is at least
    /// the floor before the cancel; a cancel that lowered the
    /// price at all while the assets read above 0 counts too (none can, Task 34c). I-35 around it unless it starts over
    /// a hole a recorded exception left with the assets reading 0 (PriceFloorTracker's _cancelOverAHole). The floor
    /// restarts from the price after it.
    function _cancelBound(CancelMark memory m) internal {
        bool overHole = _cancelOverAHole(m.mark);
        uint256 back = _cancelGiveBack(m.gapAllowance, m.shortfallBack, _holeOver(m.mark), m.reMintedValue);
        uint256 dust = overHole ? m.reMintedEntries : 0;
        if (!cancelBoundMet(vaultLens.totalAssets() + back, vault.totalSupply(), dust, m.floor)) {
            ++cancelDustViolations;
        }
        if (vaultLens.price() < m.priceBefore) {
            ++i4CancelFalls;
            if (m.withAssets) ++cancelFallsWithAssets;
        }
        if (overHole) ++cancelsOverAHole;
        else _checkExitPrice(m.mark);
        priceFloor = vaultLens.price();
        if (m.gapAllowance != 0) holeWei = 0;
        _shortfallHoleAbsorbed(m.shortfallBack);
    }

    /// The unsent bounces of `list` from `cursor`, in their order (the carried list), and the unsent entries with
    /// shares' value (what a cancel re-mints).
    function _carriedList(CascadeMessages.Payout[] memory list, uint256 cursor)
        internal
        pure
        returns (CascadeMessages.Payout[] memory kept, uint256 reMinted)
    {
        uint256 n;
        for (uint256 i = cursor; i < list.length; ++i) {
            if (list[i].shares == 0) ++n;
            else reMinted += list[i].assets;
        }
        kept = new CascadeMessages.Payout[](n);
        n = 0;
        for (uint256 i = cursor; i < list.length; ++i) {
            if (list[i].shares == 0) kept[n++] = list[i];
        }
    }

    /// After a cancel of `key`: I-19 (only the re-minted value released), the vault's record and stored batch against
    /// the carried list, the carried-list probes, then the ghosts.
    function _checkCancel(
        bytes32 key,
        Vm.Log[] memory logs,
        CascadeMessages.Payout[] memory kept,
        uint256 reMinted,
        uint256 pendingBefore
    ) internal {
        if (vaultLens.pendingPayouts() + reMinted != pendingBefore) ++bouncesReleased;
        bool logged;
        for (uint256 i; i < logs.length; ++i) {
            if (!_isVaultLog(logs[i], PayoutBatchCancelled.selector) || logs[i].topics[1] != key) continue;
            (uint256 reminted, uint32 count) = abi.decode(logs[i].data, (uint256, uint32));
            logged = reminted == reMinted && count == kept.length;
        }
        if (!logged) ++carriedListMismatches;
        uint256 value;
        for (uint256 i; i < kept.length; ++i) {
            value += kept[i].assets;
        }
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        ghostPending -= reMinted;
        if (kept.length == 0) {
            if (b.count != 0) ++carriedListMismatches;
            _dropKey(key);
            return;
        }
        if (
            b.count != kept.length || b.cursor != 0 || b.remaining != value || b.chunk != ghostChunk[key]
                || b.queuedAt != ghostQueuedAt[key]
        ) ++carriedListMismatches;
        _probeCarriedList(key, kept);
        delete _lists[key];
        for (uint256 i; i < kept.length; ++i) {
            _lists[key].push(kept[i]);
        }
        ghostCursor[key] = 0;
        ghostRemaining[key] = value;
        carried[key] = true;
        ++carriedBatches;
        bouncesCarried += kept.length;
    }

    /// The carried list is what the vault now accepts for `key`: inside a snapshot, the owner's cancel with it refuses
    /// NothingToCancel (only bounces are left), and a processPayouts with it refuses nothing for a list mismatch
    /// (PayoutsMismatch or NotPending); its logs dropped, the state reverted.
    function _probeCarriedList(bytes32 key, CascadeMessages.Payout[] memory kept) internal {
        _readLogs();
        uint256 snap = vm.snapshotState();
        vm.prank(owner);
        (bool cancelled, bytes memory why) =
            address(vault).call(abi.encodeCall(CascadeVault.cancelPayoutBatch, (key, kept)));
        vm.revertToState(snap);
        (bool paid, bytes memory whyNot) =
            address(vault).call{gas: CALL_GAS}(abi.encodeCall(CascadeVault.processPayouts, (key, kept, uint32(1))));
        vm.revertToStateAndDelete(snap);
        _dropLogs();
        if (cancelled || _selector(why) != NothingToCancel.selector) ++carriedListMismatches;
        if (!paid && (_selector(whyNot) == PayoutsMismatch.selector || _selector(whyNot) == NotPending.selector)) {
            ++carriedListMismatches;
        }
    }

    /// The queued key from `seed` on that holds unsent entries with shares and unsent bounces, else queuedKeys[seed].
    function _cancelKey(uint256 seed) internal view returns (bytes32) {
        uint256 n = queuedKeys.length;
        for (uint256 i; i < n; ++i) {
            bytes32 key = queuedKeys[(seed % n + i) % n];
            CascadeMessages.Payout[] storage list = _lists[key];
            bool shares;
            bool bounces;
            for (uint256 j = ghostCursor[key]; j < list.length; ++j) {
                if (list[j].shares == 0) bounces = true;
                else shares = true;
            }
            if (shares && bounces) return key;
        }
        return queuedKeys[seed % n];
    }

    // ---- the world's switches ----

    /// @dev The payout lane's fee, by seed mod 4: whole rao in [0, 0.03 TAO] (0), any wei in it (1: rounded up to rao
    /// by the vault), around the fee ceiling's absolute part, a few wei or rao either side (2), or 0 or 0.03 TAO (3).
    /// Above the ceiling (0.015 TAO at most, for a chunk under 1.5 TAO) a chunk needs a top-up.
    function setPayoutFee(uint256 seed) external step live {
        uint256 kind = seed % 4;
        uint256 fee;
        if (kind == 0) {
            fee = bound(seed >> 2, 0, MAX_PAYOUT_FEE / RAO) * RAO;
        } else if (kind == 1) {
            fee = bound(seed >> 2, 0, MAX_PAYOUT_FEE);
        } else if (kind == 2) {
            uint256 step_ = (seed >> 2) % 2 == 0 ? 1 : RAO;
            uint256 d = ((seed >> 3) % 4) * step_;
            fee = (seed >> 5) % 2 == 0 ? vaultLens.maxFeeAbs() + d : vaultLens.maxFeeAbs() - d;
        } else {
            fee = (seed >> 2) % 2 == 0 ? 0 : MAX_PAYOUT_FEE;
        }
        if (fee != payoutFee) ++feeSwitches;
        if (fee % RAO != 0) ++feeSwitchesNotWholeRao;
        if (fee > vaultLens.maxFeeAbs()) ++feeSwitchesAboveTheCeiling;
        payoutFee = fee;
    }

    /// @dev The chain's fee on each stake removal, by seed mod 7: 0, 1, 1,000 (the tolerance), 1,001 (one past it),
    /// 50,000, 4,000,000 (above the chain's minimum stake) or 16,000,000 rao (above the fee ceiling's 0.015 TAO): every
    /// one the exit's own cost (Task 36b), the larger ones refusing an exit its cost would leave nothing.
    function setRemoveFee(uint256 seed) external step live {
        uint256[7] memory fees = [
            uint256(0),
            1,
            SHORTFALL_TOLERANCE / RAO,
            PAST_T_REMOVE_FEE_RAO,
            EXAMPLE_REMOVE_FEE_RAO,
            ABOVE_MIN_STAKE_FEE_RAO,
            ABOVE_CEILING_FEE_RAO
        ];
        uint256 fee = fees[seed % 7];
        if (fee != staking.removeFeeRao()) ++removeFeeSwitches;
        staking.setRemoveFeeRao(fee);
    }

    /// @dev A reachability draw aimed at the walk's whole-removal corner (Task 42; Task 36b's concern 2, ruling B9): the
    /// keeper stakes what is idle first (so a chunk needs its walk); then, for the batch the liveness probe takes this
    /// step, when its chunk needs a walk, the payout fee is the pin's 1,000,001 rao and the stake is moved within the set
    /// (as the
    /// owner's scheduled moveStake could leave it) so the stake hotkey holds exactly what the chunk needs beyond the free
    /// balance and the other listed hotkey the rest, and the chain charges a 1-rao removal fee: the walk takes the whole
    /// position and its receipts fall a rao short, so finish refuses UnstakeShort though the other position holds plenty
    /// (the pin test_theLivenessProbeExpectsTheWalksWholeRemovalCorner's state). The probe after the step judges it.
    function toTheCorner() external step live {
        // a held pair refuses the move (and the corner needs the hold off)
        if (_anyPairLocked()) return;
        _stake();
        // the pin's payout fee, whose split rounds each entry's share up a rao
        payoutFee = 1_000_001 * RAO;
        bytes32 key = _dueKey(steps);
        if (key == bytes32(0)) return;
        Chunk memory c = _plan(key, CHUNK_ENTRIES, true);
        if (c.free >= c.need) return;
        bytes32 here = vaultLens.stakeHotkey();
        bytes32 other = here == HK2 ? vaultLens.hotkeys(0) : HK2;
        uint256 want = (c.need - c.free) / RAO;
        uint256 held = _stakeOf(here);
        vm.startPrank(address(vault));
        if (held > want) staking.moveStake(here, other, 0, 0, held - want);
        else if (held < want && _stakeOf(other) >= want - held) staking.moveStake(other, here, 0, 0, want - held);
        vm.stopPrank();
        staking.setRemoveFeeRao(1);
        ++cornerDraws;
    }

    /// @dev The walk's cost zeroing an entry, aimed at (a targeted draw, Task 42's fix round 3, I-1; LeaverPays'
    /// test_aBounceAWalksCostWouldZeroIsRefused's case in the campaign): the keeper stakes what is idle first (so a
    /// due chunk needs its walk), and the chain's removal fee is set to the least that makes the walk's cost, split
    /// again over the chunk's entries with the fee's share, leave an entry nothing the first split did not
    /// (VaultModel's _chunkAfterWalk, its `zeroed`; searched over the fee, which sets only the walk's cost, never its
    /// asks): the
    /// keeper's chunk at the exact top-up must refuse FeeTooHigh as predicted, and moves nothing
    /// (`chunksRefusedWalkCost`); one rao of fee less, it would be sent. The fee then goes back to what it was. A
    /// no-op under a hold, with nothing due, when the chunk needs no walk or refuses before it, or when no fee zeroes
    /// an entry.
    function toTheWalkCost(uint256 seed) external step live {
        if (_anyPairLocked()) return;
        _stake();
        bytes32 key = _dueKey(seed);
        if (key == bytes32(0)) return;
        Chunk memory c = _plan(key, CHUNK_ENTRIES, true);
        if (c.sharesAtZero || c.net == 0 || c.free >= c.need || c.walkRefusal == UnstakeShort.selector) return;
        // at a fee of every ask or more the chain keeps all the walk takes: the most the walk can cost
        uint256 hi;
        for (uint256 i; i < c.walk.length; ++i) {
            if (!c.walk[i].skipped) hi = Math.max(hi, c.walk[i].wantRao);
        }
        uint256 fee0 = staking.removeFeeRao();
        staking.setRemoveFeeRao(hi);
        if (hi == 0 || !_plan(key, CHUNK_ENTRIES, true).zeroed) {
            staking.setRemoveFeeRao(fee0);
            return;
        }
        // the least zeroing fee (none at 0: the walk then costs nothing): more fee, more cost, fewer left to each entry
        uint256 lo;
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            staking.setRemoveFeeRao(mid);
            if (_plan(key, CHUNK_ENTRIES, true).zeroed) hi = mid;
            else lo = mid;
        }
        staking.setRemoveFeeRao(hi);
        c = _plan(key, CHUNK_ENTRIES, true);
        _send(c, address(this), c.topUpAsked, CHUNK_ENTRIES);
        ++walkCostDraws;
        staking.setRemoveFeeRao(fee0);
        seed;
    }

    /// @dev The root hold (spec §3.8): on one draw in three every listed pair is locked (MockStaking.setPairLocked),
    /// else every one unlocked; and whether a refused removal burns all the gas it is given (setBurnRemoveGas), drawn
    /// too.
    function setRootHold(uint256 seed) external step live {
        bool on = seed % 3 == 0;
        bool burn = (seed >> 2) % 2 == 1;
        uint256 n = vaultLens.hotkeyCount();
        for (uint256 i; i < n; ++i) {
            staking.setPairLocked(vaultLens.hotkeys(i), on);
        }
        staking.setBurnRemoveGas(burn);
        if (on) ++holdsOn;
        if (on && burn) ++holdsBurning;
    }

    /// @dev The fee ceiling's absolute part, by seed mod 4: below MIN_FEE_ABS (0: a tightening, refused at once
    /// InvalidParameter), above MAX_FEE_ABS (1: a loosening, its schedule runs and its execute refuses
    /// InvalidParameter), or within [MIN_FEE_ABS, MAX_FEE_ABS] (2, 3: a loosening scheduled and executed, else set at
    /// once). The bps part stays.
    function setFeeLimits(uint256 seed) external step live {
        uint256 kind = seed % 4;
        uint256 abs_;
        if (kind == 0) abs_ = bound(seed >> 2, 0, MIN_FEE_ABS - 1);
        else if (kind == 1) abs_ = bound(seed >> 2, MAX_FEE_ABS + 1, 2 * MAX_FEE_ABS);
        else abs_ = bound(seed >> 2, MIN_FEE_ABS, MAX_FEE_ABS);
        uint256 bps = vaultLens.maxFeeBps();
        bytes4 expect = abs_ < MIN_FEE_ABS || abs_ > MAX_FEE_ABS ? InvalidParameter.selector : bytes4(0);
        bytes memory data = abi.encodeCall(CascadeVault.setFeeLimits, (bps, abs_));
        bool loosens = abs_ > vaultLens.maxFeeAbs();
        if (loosens) _scheduleAndWait(vault, data);
        _readLogs();
        vm.prank(owner);
        (bool ok, bytes memory reason) =
            loosens ? address(vault).call(abi.encodeCall(CascadeBase.execute, (data))) : address(vault).call(data);
        if (ok) {
            _succeeded(expect);
            if (vaultLens.maxFeeAbs() != abs_) ++unexpectedReverts;
            if (loosens) ++feeLimitsLoosened;
            else ++feeLimitsTightened;
            return;
        }
        _dropLogs();
        if (_refused(reason, expect)) {
            if (kind == 0) ++feeLimitsRefusedLow;
            else ++feeLimitsRefusedHigh;
        }
    }

    /// @dev Time on both chains, 1 hour to a day, rolled at the front door's calibrated 120 ms blocks (which meet the
    /// vault's floors too).
    function warp(uint256 secs) external step live {
        _warp(bound(secs, 1 hours, 1 days), doorBlockTime);
    }

    // ---- scripted tests only (not in the fuzzer's selectors) ----

    /// @dev A second holder of the second chain's redeem origin, funded on Base (the foreigner's setup), so a batch
    /// can hold two bounces: a delivery queues its bounces ahead of its burns, so the foreigner's one bounce is always
    /// a batch's first entry, and a cancel after a partial chunk would carry nothing.
    function addForeigner(address who) external {
        _fund(who, true);
        vm.prank(who);
        vault.setRedeemOrigin(foreignChain);
        madeForeign[who] = true;
    }

    /// @dev `who`'s deposit of `amount` at the front door, refused only by the door's limits (_doorDeposit).
    function depositAs(address who, uint256 amount) external step live {
        _doorDeposit(who, amount);
    }

    // ---- reads ----

    function queuedCount() external view returns (uint256) {
        return queuedKeys.length;
    }

    /// Batch `key`'s list as the handler keeps it (its carried list after a cancel).
    function listOf(bytes32 key) external view returns (CascadeMessages.Payout[] memory) {
        return _lists[key];
    }

    /// VaultModel's chunk and split, for their pin against the library (not in the fuzzer's selectors).
    function takeChunkOf(
        CascadeMessages.Payout[] memory list,
        uint256 start,
        uint256 limit,
        uint256 cap,
        uint256 minChunk
    ) external pure returns (uint256 taken, uint256 sum) {
        return _takeChunk(list, start, limit, cap, minChunk);
    }

    function deductFeeOf(
        CascadeMessages.Payout[] memory list,
        uint256 start,
        uint256 taken,
        uint256 charged,
        uint256 sum
    ) external pure returns (uint256[] memory nets, uint256 net, bool sharesAtZero, uint256 dust) {
        return _deductFee(list, start, taken, charged, sum);
    }

    /// Whether any listed pair is under a root hold, read on the mock.
    function _anyPairLocked() internal view returns (bool) {
        uint256 n = vaultLens.hotkeyCount();
        for (uint256 i; i < n; ++i) {
            if (staking.pairLocked(vaultLens.hotkeys(i))) return true;
        }
        return false;
    }

    /// Whether a listed position holds stake below the chain's minimum (the walk skips it).
    function _dustPosition() internal view returns (bool) {
        uint256 n = vaultLens.hotkeyCount();
        uint256 minStake = vaultLens.minStakeRao();
        for (uint256 i; i < n; ++i) {
            uint256 s = _stakeOf(vaultLens.hotkeys(i));
            if (s != 0 && s < minStake) return true;
        }
        return false;
    }

    /// The first queued key from a rolling start (`seed`) whose payout delay has passed, or 0.
    function _dueKey(uint256 seed) internal view returns (bytes32) {
        uint256 n = queuedKeys.length;
        uint256 delay = vaultLens.payoutDelay();
        for (uint256 i; i < n; ++i) {
            bytes32 key = queuedKeys[(seed % n + i) % n];
            // test-controlled time
            // forge-lint: disable-next-line(block-timestamp)
            if (vm.getBlockTimestamp() >= uint256(ghostQueuedAt[key]) + delay) return key;
        }
        return bytes32(0);
    }

    /// Every queued key whose payout delay has passed, in queue order.
    function _dueKeys() internal view returns (bytes32[] memory keys) {
        uint256 n = queuedKeys.length;
        uint256 delay = vaultLens.payoutDelay();
        keys = new bytes32[](n);
        uint256 m;
        for (uint256 i; i < n; ++i) {
            // test-controlled time
            // forge-lint: disable-next-line(block-timestamp)
            if (vm.getBlockTimestamp() >= uint256(ghostQueuedAt[queuedKeys[i]]) + delay) keys[m++] = queuedKeys[i];
        }
        bytes32[] memory due = new bytes32[](m);
        for (uint256 i; i < m; ++i) {
            due[i] = keys[i];
        }
        return due;
    }

    /// The queued key queued first (the smallest ghost queue time; a carried batch keeps its own).
    function _oldestKey() internal view returns (bytes32 key) {
        uint256 first = type(uint256).max;
        for (uint256 i; i < queuedKeys.length; ++i) {
            uint256 t = ghostQueuedAt[queuedKeys[i]];
            if (t < first) (first, key) = (t, queuedKeys[i]);
        }
    }

    /// Warps, at the vault's block rate, until batch `key`'s payout delay has passed.
    function _waitUntilDue(bytes32 key) internal {
        uint256 due = uint256(ghostQueuedAt[key]) + vaultLens.payoutDelay();
        uint256 now_ = vm.getBlockTimestamp();
        if (due > now_) _warp(due - now_, vaultBlockTime);
    }

    /// Warps, at the vault's block rate, until two queued batches are due (one when only one is queued).
    function _waitForTwoDue() internal {
        uint256 n = queuedKeys.length;
        uint256 first = type(uint256).max;
        uint256 second = type(uint256).max;
        for (uint256 i; i < n; ++i) {
            uint256 t = ghostQueuedAt[queuedKeys[i]];
            if (t < first) (first, second) = (t, first);
            else if (t < second) second = t;
        }
        uint256 due = (n >= 2 ? second : first) + vaultLens.payoutDelay();
        uint256 now_ = vm.getBlockTimestamp();
        if (due > now_) _warp(due - now_, vaultBlockTime);
    }

    /// The first holder from `seed` on (the door's, then the direct ones) with shares, or (0, 0).
    function _holderWith(uint256 seed) internal view returns (address actor, uint256 balance) {
        address[5] memory all = [doorHolders[0], doorHolders[1], doorHolders[2], directHolders[0], directHolders[1]];
        for (uint256 i; i < all.length; ++i) {
            actor = all[(seed % all.length + i) % all.length];
            balance = vault.balanceOf(actor);
            if (balance != 0) return (actor, balance);
        }
        return (address(0), 0);
    }

    /// Swap-and-pop; the vault must have deleted the batch too.
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
        delete ghostCursor[key];
        delete ghostRemaining[key];
        delete ghostChunk[key];
        delete ghostQueuedAt[key];
        delete carried[key];
        if (vaultLens.getPayoutBatch(key).count != 0) ++ghostMismatches;
    }

    /// Funds an actor: 10,000 TAO and 10 ether of fee money as native balance, and (on Base) 10,000 bridged TAO,
    /// approved to the front door.
    function _fund(address a, bool onBase) internal {
        vm.deal(a, 10_000e18 + FEE_MONEY);
        if (onBase) {
            tao.mint(a, 10_000e18);
            vm.prank(a);
            tao.approve(address(fd), type(uint256).max);
        }
        _trackAccount(a);
    }
}
