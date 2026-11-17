// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeVaultLens} from "../../src/lens/CascadeVaultLens.sol";
import {ISTAKING_ADDRESS} from "../../src/interfaces/IStaking.sol";
import {CascadeMath} from "../../src/libraries/CascadeMath.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {CascadePayoutMath} from "../../src/libraries/CascadePayoutMath.sol";
import {FeeTooHigh} from "../../src/CascadeErrors.sol";
import {ShortfallAbsorbed, UnstakeSkipped, Unstaked} from "../../src/CascadeEvents.sol";
import {PayoutBatch} from "../../src/CascadeTypes.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {CampaignFixture} from "../utils/CampaignFixture.sol";
import {VaultInternals} from "../utils/VaultInternals.sol";
import {BoundaryInvariants} from "./BoundaryInvariants.sol";
import {MinimumHits} from "./MinimumHits.sol";
import {PayoutHandler} from "./handlers/PayoutHandler.sol";
import {TrackedHandler} from "./handlers/TrackedHandler.sol";
import {VaultModel} from "./handlers/VaultModel.sol";

/// @dev The payout campaign (Task 36, spec §3.3 and §3.5; I-12 to I-14 and I-19): random sequences of the handler's
/// actions (PayoutHandler's notes) over several payout batches queued at once with nothing idle (`idleBufferBps` 0):
/// front-door deposits and redeems (a foreigner's deposits bouncing as 0-share entries, down to the door's minimum,
/// 0.03 TAO, the bound's floor), the keeper's closes, chunks sent by the keeper and by a stranger with and without a
/// top-up, the keeper's drain of every due batch, the owner's cancels carrying their bounces, direct deposits and
/// exits, stakes, claims, the stake hotkey moved between two listed hotkeys, and the world's switches: the payout
/// lane's fee in [0, 0.03 TAO], the chain's removal fee in {0, 1, 1,000, 1,001, 50,000, 4,000,000, 16,000,000} rao
/// (every one the exit's own cost, Task 36b), a root hold on every pair (burning the gas it is given or not) and the
/// fee ceiling's absolute part within its bounds. The payout delay is the
/// longest allowed (48 hours), so batches pile up. Inherits BoundaryInvariants (Task 34a): lens parity on both lenses
/// and token accounting after every step, the fixed libraries asserted in the setUp.
contract PayoutInvariantTest is CampaignFixture, BoundaryInvariants, MinimumHits {
    uint256 constant RAO = 1e9;
    /// A second chain, where a door is activated so a holder's redeem origin can be there (its deposits at the launch
    /// door bounce: ForeignOrigin, spec §3.4).
    uint64 constant FOREIGN_CHAIN = 10;

    MockStaking staking = MockStaking(ISTAKING_ADDRESS);
    address foreignDoor = makeAddr("foreign door");
    VaultInternals vault;
    CascadeVaultLens vaultLens;
    CascadeFrontDoor fd;
    PayoutHandler handler;

    /// The longest payout delay (48 hours), so several batches are queued at once.
    function campaignVaultParams(CascadeVault.Params memory p) internal pure override {
        p.payoutDelay = 48 hours;
    }

    /// The door's minimum deposit at the bound's floor, 2 × MAX_FEE_ABS = 0.03 TAO (I-14: a bounce is never dust).
    function campaignDoorParams(CascadeFrontDoor.Params memory p) internal pure override {
        p.minDeposit = 0.03e18;
    }

    function setUp() public {
        Campaign memory c = deployCampaign();
        vault = c.vault;
        vaultLens = c.vaultLens;
        fd = c.fd;
        handler = new PayoutHandler(
            TrackedHandler.System(c.vault, c.vaultLens, c.fd, c.doorLens, owner, guardian),
            PayoutHandler.Parts(c.tao, c.bridge, BASE, FOREIGN_CHAIN, foreignDoor)
        );
        landed(Slot.Handler, address(handler));
        // the boundary invariants' targets; I-32's run-time half asserted here, once
        setBoundary(handler, c.vault, c.fd, c.vaultLens, c.doorLens);
        // pays every close's bridge fee and every payout's top-up
        vm.deal(address(handler), 1_000 ether);
        assertEq(vaultLens.idleBufferBps(), 0, "nothing idle");
        assertEq(vaultLens.hotkeyCount(), 2, "two listed hotkeys");
        assertEq(vaultLens.redeemOrigin(handler.foreigner()), FOREIGN_CHAIN, "the foreigner's origin");

        bytes4[] memory selectors = new bytes4[](20);
        selectors[0] = PayoutHandler.doorDeposit.selector;
        selectors[1] = PayoutHandler.doorRedeem.selector;
        selectors[2] = PayoutHandler.closeBatch.selector;
        selectors[3] = PayoutHandler.processPayouts.selector;
        selectors[4] = PayoutHandler.drainDue.selector;
        selectors[5] = PayoutHandler.depositDirect.selector;
        selectors[6] = PayoutHandler.redeemDirect.selector;
        selectors[7] = PayoutHandler.stakeIdle.selector;
        selectors[8] = PayoutHandler.accrueAndClaim.selector;
        selectors[9] = PayoutHandler.switchStakeHotkey.selector;
        selectors[10] = PayoutHandler.cancelQueued.selector;
        selectors[11] = PayoutHandler.setPayoutFee.selector;
        selectors[12] = PayoutHandler.setRemoveFee.selector;
        selectors[13] = PayoutHandler.setRootHold.selector;
        selectors[14] = PayoutHandler.setFeeLimits.selector;
        selectors[15] = PayoutHandler.warp.selector;
        selectors[16] = PayoutHandler.bankRun.selector;
        selectors[17] = PayoutHandler.toTheCorner.selector;
        selectors[18] = PayoutHandler.toTheWalkCost.selector;
        selectors[19] = PayoutHandler.toTheCancelAfterPartial.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ---- I-12 to I-14, I-19 ----

    /// @dev I-12, reserves untouched, per exit (spec §3.3): from the handler's snapshot before each chunk and each
    /// direct exit (the vault's balance before it, its caller's value not in it, and the other reservations: for a
    /// chunk the other batches', from the handler's ghosts; for a direct exit all of them), the balance after it is at
    /// least the smaller of the balance before it and ED_RESERVE plus those reservations: the spec's `balance - ED >=
    /// min(before - ED, others)`, unfloored (`balance >= min(before, ED + others)`), so an exit with no other
    /// reservation still keeps ED_RESERVE.
    function invariant_reservesUntouchedPerExit() public view {
        assertEq(handler.reserveBreaches(), 0, "I-12: an exit was paid from ED or another batch's reservation");
    }

    /// @dev I-13 (spec §3.3, Revision 21; Revision 23, the leaver pays): a direct exit, priced by the handler at the
    /// call, is paid exactly floorToRao(out - unmet - cost), `unmet` (at most 1,000 rao) what its walk left untaken at
    /// face value and `cost` what the chain kept of the stake it took, rounded up to rao, both read from its Unstaked
    /// logs, its ShortfallAbsorbed unmet + cost, as RedeemedDirect says, all three as VaultModel predicts, or it reverts
    /// as its state predicts; a chunk is sent as queued less each entry's share of charged + cost or reverts: the
    /// bridge is paid net + fee, the front door credits the chunk's entries in their queued order at their queued
    /// amounts less their shares, under the chunk's number, and PayoutChunkSent says so, its unstakeCost the cost; its
    /// entries bear at least charged + cost and at most the ceiling plus the cost plus one rao an entry, no wider; and
    /// its caller's balance moves by exactly minus the top-up, the rest of its value refunded in the same call. A value
    /// not whole rao refuses BadValue, one short of the top-up FeeTooHigh, and a walk's cost that would leave an entry
    /// nothing FeeTooHigh (noUnexpectedReverts ties each to its state).
    function invariant_chunkSentAsQueuedOrReverted() public view {
        assertEq(handler.chunkMismatches(), 0, "I-13: a chunk not sent as queued less its costs");
        assertEq(
            handler.ceilingBreaches(), 0, "I-13: a chunk's entries bore more than the ceiling, the cost, a rao each"
        );
        assertEq(handler.callerMispaid(), 0, "I-13: a caller paid other than the fee above the ceiling");
        assertEq(handler.directMispaid(), 0, "I-13: a direct exit paid other than its value less unmet and its cost");
        assertEq(handler.directMispredicted(), 0, "I-13: a direct exit's unmet, cost or pay not the model's");
    }

    /// @dev I-13's liveness (Revision 10 L-1; Revision 23): after every step a due batch is attempted inside a snapshot
    /// with the exact top-up, and it processes whenever no listed pair is locked, the batch's door and the primary
    /// bridge are active, and the spec's sufficient condition holds (restated on the mock's positions and the ghosts:
    /// the free balance pays it, or the positions the walk may take hold need - free + T at face value and no entry is
    /// zeroed by its share of the predicted walk cost), except in the walk's whole-removal corner (the walk ended after
    /// a whole removal less than a rao an entry short of T, and the second split's rounding leaves the entries more than
    /// the receipts), where it refuses exactly UnstakeShort; everywhere it does as the model predicts (UnstakeShort
    /// under a hold, or when the walk cannot reach the stake; FeeTooHigh when the walk's cost would zero an entry).
    /// Stake missing is no precondition: processPayouts never reads it.
    function invariant_processPayoutsLiveWithTheHoldOff() public view {
        assertEq(handler.livenessFailures(), 0, "I-13: a due batch did not process with the hold off and cover");
        assertEq(handler.livenessMispredicted(), 0, "I-13: a due batch's attempt did not do what its state predicts");
        assertEq(
            handler.livenessCornerMismatches(), 0, "I-13: the walk's whole-removal corner did not refuse UnstakeShort"
        );
    }

    /// @dev I-14 (spec §3.3): no PayoutDust for an entry with shares, at any fee or maxFeeAbs the bounds allow (an
    /// entry with shares that would net 0 refuses the chunk FeeTooHigh instead, tied to that state), none for a
    /// bounce at any minDeposit the bound allows (here the door's minimum is the bound's floor and bounces are drawn
    /// down to it), and none from a walk's cost (a chunk whose cost would leave an entry nothing refuses FeeTooHigh,
    /// chunksRefusedWalkCost): no PayoutDust at all.
    function invariant_noDustWithShares() public view {
        assertEq(handler.dustWithShares(), 0, "I-14: an entry with shares was dust");
        assertEq(handler.payoutDusts(), 0, "I-14: a bounce at a minDeposit the bound allows was dust");
    }

    /// @dev I-19 (spec §3.5): bounces are never released to the holders. For every queued batch the vault's record is
    /// the handler's (its count, cursor, chunk number and remaining value, which is exactly what its unpaid entries
    /// reserve), so the sum of the unpaid 0-share entries is exactly the part of pendingPayouts they reserve, across
    /// every cancel (a cancel releases only its re-minted entries' value: bouncesReleased), until paid. A cancel's
    /// carried list (the unsent bounces, in order) is what the vault then stores and accepts (carriedListMismatches),
    /// and a batch the handler finished or deleted is gone from the vault (ghostMismatches).
    function invariant_bouncesNeverReleased() public view {
        uint256 n = handler.queuedCount();
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            bytes32 key = handler.queuedKeys(i);
            PayoutBatch memory b = vaultLens.getPayoutBatch(key);
            CascadeMessages.Payout[] memory list = handler.listOf(key);
            uint256 cursor = handler.ghostCursor(key);
            uint256 unpaid;
            uint256 bounces;
            for (uint256 j = cursor; j < list.length; ++j) {
                unpaid += list[j].assets;
                if (list[j].shares == 0) bounces += list[j].assets;
            }
            // a batch a cancel left holding its carried bounces reserves exactly their value
            if (handler.carried(key)) {
                assertEq(b.remaining, bounces, "I-19: a carried batch reserves other than its bounces");
            }
            assertEq(b.count, list.length, "I-19: a batch's count is not the handler's list");
            assertEq(b.cursor, cursor, "I-19: a batch's cursor is not the handler's");
            assertEq(b.chunk, handler.ghostChunk(key), "I-19: a batch's chunk number is not the handler's");
            assertEq(b.remaining, unpaid, "I-19: a batch reserves other than its unpaid entries");
            assertEq(handler.ghostRemaining(key), unpaid, "the ghost's remaining");
            sum += unpaid;
        }
        assertEq(vaultLens.pendingPayouts(), sum, "I-19: the queued payouts are not the unpaid entries");
        assertEq(handler.ghostPending(), sum, "the ghost's pending");
        assertEq(handler.bouncesReleased(), 0, "I-19: a cancel released more than its re-minted entries");
        assertEq(handler.carriedListMismatches(), 0, "a carried list is not the one the vault stores and accepts");
        assertEq(handler.ghostMismatches(), 0, "a queue the vault logged or deleted is not the handler's");
    }

    /// @dev I-4 (spec §3.1, Revision 23), as the core and ledger campaigns check it (PriceFloorTracker): the price never
    /// falls but by I-4's exceptions, none of them an exit, each recorded by the step that caused it and checked
    /// against its bound: the 1-rao-short read of a fresh position (this fixture's reads are exact), a cancel over a
    /// hole one of them left (to the floor less a rao per re-minted entry, and no fall at all while the assets read
    /// above 0), and, at a supply of 0, the next mint absorbing the payout gap those left, and the owner's cancel alone
    /// absorbing the vesting schedule's shortfall they left; and no mint at a supply of 0 underwater (the mints
    /// modifier's guard). A chunk's walk and a direct exit's are no exception: their removal fee is the exit's own cost
    /// (the short-receipt, above-T and cancel-dust exceptions are gone, Task 36b).
    function invariant_priceFallsOnlyByI4sExceptions() public view {
        assertGe(vaultLens.price(), handler.priceFloor(), "the price fell outside I-4's exceptions");
        assertEq(handler.exceptionOverruns(), 0, "an I-4 exception fell further than its bound");
        assertEq(handler.cancelDustViolations(), 0, "a cancel fell further than its bound");
        assertEq(handler.cancelFallsWithAssets(), 0, "a cancel lowered the price while assets read above 0");
        assertEq(handler.guardMisses(), 0, "a mint at a supply of 0 underwater");
    }

    /// @dev I-35 (spec §3.1, Revision 23, the founder's ruling of 2026-11-06): no exit lowers the holders' price.
    /// Around every sent chunk (the keeper's, a stranger's, drainDue's), every paid direct exit (redeemDirect,
    /// bankRun's) and every cancel, from the handler's own reads just before and after the call, (A' + 1)(S + 1e6) >=
    /// (A + 1)(S' + 1e6) exactly and the hole (the queued payouts and the unvested rewards above the gross) no larger,
    /// with no allowance at any removal fee; exempt only a cancel that starts with totalAssets() reading 0 over a hole
    /// a recorded exception left (none here: no exception is reachable in this fixture).
    function invariant_noExitLowersThePrice() public view {
        assertEq(handler.exitPriceFalls(), 0, "I-35: an exit lowered the holders' price or widened the hole");
    }

    /// @dev The walk's removals (spec §3.10.11, the fix round 2): every chunk sent, direct exit paid and liveness
    /// attempt processed logs exactly the Unstaked and UnstakeSkipped events the handler's restatement predicts before
    /// the call from the mock's positions (VaultModel's _checkWalk): the same hotkeys in order and each removal's
    /// wantRao, so no further position is stripped of the minimum stake for a remainder the tolerance covers, none is
    /// passed over, and none is asked other than the rule.
    function invariant_walkRemovesWhatTheModelPredicts() public view {
        assertEq(handler.walkMismatches(), 0, "a walk's Unstaked events were not the removals the model predicts");
    }

    /// @dev Every call refused only as its action and state predict (PayoutHandler's notes), and no predicted refusal
    /// lost.
    /// The campaign also fails on any handler call that reverts (Task 34's M6, carried to Task 42: a call a handler does
    /// not wrap in a try, whose revert the fuzzer would otherwise drop): fail-on-revert for this invariant's campaign.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_noUnexpectedReverts() public view {
        assertEq(handler.unexpectedReverts(), 0);
    }

    /// @dev Successful calls per action, the expected refusals, and the states they ran in; asserts nothing.
    function invariant_reachabilityLogged() public {
        emit log_named_uint("doorDeposits", handler.doorDeposits());
        emit log_named_uint("foreignDeposits", handler.foreignDeposits());
        emit log_named_uint("doorRedeems", handler.doorRedeems());
        emit log_named_uint("closes", handler.closes());
        emit log_named_uint("deliveries", handler.deliveries());
        emit log_named_uint("depositBounces", handler.depositBounces());
        emit log_named_uint("foreignBounces", handler.foreignBounces());
        emit log_named_uint("insolventBounces", handler.insolventBounces());
        emit log_named_uint("redeemedEntries", handler.redeemedEntries());
        emit log_named_uint("redeemDeferred", handler.redeemDeferred());
        emit log_named_uint("redeemSkipped", handler.redeemSkipped());
        emit log_named_uint("deliveriesRefusedUnderwater", handler.deliveriesRefusedUnderwater());
        emit log_named_uint("deliveriesRefusedWhileMissing", handler.deliveriesRefusedWhileMissing());
        emit log_named_uint("maxQueueDepth", handler.maxQueueDepth());
        emit log_named_uint("stepsWithThreeQueued", handler.stepsWithThreeQueued());
        emit log_named_uint("payoutChunks", handler.payoutChunks());
        emit log_named_uint("partialChunks", handler.partialChunks());
        emit log_named_uint("chunksByStranger", handler.chunksByStranger());
        emit log_named_uint("topUpChunks", handler.topUpChunks());
        emit log_named_uint("refundedChunks", handler.refundedChunks());
        emit log_named_uint("walkedChunks", handler.walkedChunks());
        emit log_named_uint("chunksChargedWalkCost", handler.chunksChargedWalkCost());
        emit log_named_uint("chunksSentAtAFeePastT", handler.chunksSentAtAFeePastT());
        emit log_named_uint("chunksRefusedWalkCost", handler.chunksRefusedWalkCost());
        emit log_named_uint("payoutsRefusedCoverage", handler.payoutsRefusedCoverage());
        emit log_named_uint("multiPositionWalks", handler.multiPositionWalks());
        emit log_named_uint("walkMismatches", handler.walkMismatches());
        emit log_named_uint("walksChecked", handler.walksChecked());
        emit log_named_uint("walksOfSeveralRemovals", handler.walksOfSeveralRemovals());
        emit log_named_uint("livenessWalksChecked", handler.livenessWalksChecked());
        emit log_named_uint("bouncesPaid", handler.bouncesPaid());
        emit log_named_uint("payoutsRefusedEarly", handler.payoutsRefusedEarly());
        emit log_named_uint("payoutsRefusedBadValue", handler.payoutsRefusedBadValue());
        emit log_named_uint("payoutsRefusedFeeShort", handler.payoutsRefusedFeeShort());
        emit log_named_uint("payoutsRefusedSharesAtZero", handler.payoutsRefusedSharesAtZero());
        emit log_named_uint("payoutsRefusedHeld", handler.payoutsRefusedHeld());
        emit log_named_uint("payoutsRefusedHeldBurning", handler.payoutsRefusedHeldBurning());
        emit log_named_uint("payoutsUncoverable", handler.payoutsUncoverable());
        emit log_named_uint("dustBlocked", handler.dustBlocked());
        emit log_named_uint("maxHeldBurnGas", handler.maxHeldBurnGas());
        emit log_named_uint("drains", handler.drains());
        emit log_named_uint("multiBatchDrains", handler.multiBatchDrains());
        emit log_named_uint("multiBatchDrainsAtFee1", handler.multiBatchDrainsAtFee1());
        emit log_named_uint("directDeposits", handler.directDeposits());
        emit log_named_uint("directDepositsRefusedInsolvent", handler.directDepositsRefusedInsolvent());
        emit log_named_uint("directExits", handler.directExits());
        emit log_named_uint("directExitsWalked", handler.directExitsWalked());
        emit log_named_uint("directExitsShort", handler.directExitsShort());
        emit log_named_uint("directExitsBesideStakedPayout", handler.directExitsBesideStakedPayout());
        emit log_named_uint("directExitsBesideStakedPayoutAtFee1", handler.directExitsBesideStakedPayoutAtFee1());
        emit log_named_uint("directExitsRefusedZero", handler.directExitsRefusedZero());
        emit log_named_uint("exitsRefusedByCost", handler.exitsRefusedByCost());
        emit log_named_uint("directExitsRefusedHeld", handler.directExitsRefusedHeld());
        emit log_named_uint("directExitsUncoverable", handler.directExitsUncoverable());
        emit log_named_uint("bankRuns", handler.bankRuns());
        emit log_named_uint("stakes", handler.stakes());
        emit log_named_uint("claims", handler.claims());
        emit log_named_uint("dustClaims", handler.dustClaims());
        emit log_named_uint("cancels", handler.cancels());
        emit log_named_uint("cancelsOverAHole", handler.cancelsOverAHole());
        emit log_named_uint("cancelsAfterPartial", handler.cancelsAfterPartial());
        emit log_named_uint("cancelsRefusedNothing", handler.cancelsRefusedNothing());
        emit log_named_uint("carriedBatches", handler.carriedBatches());
        emit log_named_uint("bouncesCarried", handler.bouncesCarried());
        emit log_named_uint("carriedBatchesPaid", handler.carriedBatchesPaid());
        emit log_named_uint("feeSwitches", handler.feeSwitches());
        emit log_named_uint("feeSwitchesNotWholeRao", handler.feeSwitchesNotWholeRao());
        emit log_named_uint("feeSwitchesAboveTheCeiling", handler.feeSwitchesAboveTheCeiling());
        emit log_named_uint("removeFeeSwitches", handler.removeFeeSwitches());
        emit log_named_uint("cornerDraws", handler.cornerDraws());
        emit log_named_uint("walkCostDraws", handler.walkCostDraws());
        emit log_named_uint("cancelAfterPartialDraws", handler.cancelAfterPartialDraws());
        emit log_named_uint("holdsOn", handler.holdsOn());
        emit log_named_uint("holdsBurning", handler.holdsBurning());
        emit log_named_uint("feeLimitsTightened", handler.feeLimitsTightened());
        emit log_named_uint("feeLimitsLoosened", handler.feeLimitsLoosened());
        emit log_named_uint("feeLimitsRefusedLow", handler.feeLimitsRefusedLow());
        emit log_named_uint("feeLimitsRefusedHigh", handler.feeLimitsRefusedHigh());
        emit log_named_uint("stakeHotkeySwitches", handler.stakeHotkeySwitches());
        emit log_named_uint("livenessProbes", handler.livenessProbes());
        emit log_named_uint("livenessAsserted", handler.livenessAsserted());
        emit log_named_uint("livenessProbesHeld", handler.livenessProbesHeld());
        emit log_named_uint("livenessProbesHeldButFree", handler.livenessProbesHeldButFree());
        emit log_named_uint("livenessProbesUncoverable", handler.livenessProbesUncoverable());
        emit log_named_uint("livenessAssertedWalks", handler.livenessAssertedWalks());
        emit log_named_uint("livenessCorners", handler.livenessCorners());
        emit log_named_uint("i4FreshReads", handler.i4FreshReads());
        emit log_named_uint("i4GapsAbsorbed", handler.i4GapsAbsorbed());
        emit log_named_uint("i4CancelFalls", handler.i4CancelFalls());
        emit log_named_uint("i4ShortfallHolesAbsorbed", handler.i4ShortfallHolesAbsorbed());
        emit log_named_uint("exitsCharged", handler.exitsCharged());
        emit log_named_uint("exitsPriceChecked", handler.exitsPriceChecked());
        emit log_named_uint("exitPriceFalls", handler.exitPriceFalls());
        _logHitTotals();
    }

    // ---- B9: the named states' minimum hits in a long run (MinimumHits) ----

    function _hitTag() internal pure override returns (string memory) {
        return "payouts";
    }

    /// The ledger's named states for this campaign (the Task 36 and 36b carries: the walk's whole-removal liveness
    /// corner, multi-batch drains, the thin cancels and chunks; the fix round 3's walk-cost refusal, through its draw
    /// toTheWalkCost, and the corner's draws; fix round 4's cancel after a partial chunk, through its draw
    /// toTheCancelAfterPartial, the review's I-2), each with its minimum over 3,000 runs at depth 64 (MinimumHits'
    /// rule: a quarter of the slowest seed's projection). A minimum of 0 is logged, not asserted: livenessCorners (6 in
    /// 3,000 runs in the first long run and a seed may project 0: too thin for a minimum, fix round 2's review, M-6;
    /// cornerDraws, asserted here, counts the corner's set-ups, not its reaches, and the corner itself is held by
    /// test_theCornerDrawReachesTheWalksWholeRemovalCorner and test_theLivenessProbeExpectsTheWalksWholeRemovalCorner:
    /// fix round 3's review, M-6); i4CancelFalls and i4GapsAbsorbed need a supply of 0 over a hole an exception
    /// recorded (this campaign has no swap or loss; pinned in the core file); and payoutsUncoverable varies too much by
    /// seed (asserted in the ledger campaign). The seeds are 7111, 7222 and 7333.
    function _hits() internal view override returns (Hit[] memory h) {
        h = new Hit[](14);
        h[0] = Hit("livenessCorners", handler.livenessCorners(), 0);
        h[1] = Hit("multiBatchDrains", handler.multiBatchDrains(), 142);
        h[2] = Hit("partialChunks", handler.partialChunks(), 280);
        h[3] = Hit("cancelsAfterPartial", handler.cancelsAfterPartial(), 269);
        h[4] = Hit("bouncesCarried", handler.bouncesCarried(), 188);
        h[5] = Hit("dustBlocked", handler.dustBlocked(), 7);
        h[6] = Hit("i4CancelFalls", handler.i4CancelFalls(), 0);
        h[7] = Hit("i4GapsAbsorbed", handler.i4GapsAbsorbed(), 0);
        h[8] = Hit("payoutsUncoverable", handler.payoutsUncoverable(), 0);
        h[9] = Hit("chunksRefusedWalkCost", handler.chunksRefusedWalkCost(), 102);
        h[10] = Hit("carriedBatchesPaid", handler.carriedBatchesPaid(), 92);
        h[11] = Hit("livenessAsserted", handler.livenessAsserted(), 7275);
        h[12] = Hit("cornerDraws", handler.cornerDraws(), 120);
        h[13] = Hit("cancelAfterPartialDraws", handler.cancelAfterPartialDraws(), 265);
    }

    // ---- the restatements, pinned ----

    /// @dev VaultModel's takeChunk and deductFee are the library's: over fuzzed lists of 1 to 8 entries (bounces and
    /// entries with shares, 1 rao to 100 TAO, some tiny), a start, a limit, a message cap and a minChunk, the chunk
    /// takes the same entries and sum; and over a charge up to the chunk's sum, the split keeps the same entries at the
    /// same nets in order, has the same dust and net, and refuses FeeTooHigh exactly when an entry with shares would
    /// net 0.
    function testFuzz_thePayoutSplitIsTheLibrarys(
        uint256 seed,
        uint256 startSeed,
        uint256 limitSeed,
        uint256 capSeed,
        uint256 minChunkSeed,
        uint256 chargedSeed
    ) public view {
        uint256 n = bound(seed, 1, 8);
        CascadeMessages.Payout[] memory list = new CascadeMessages.Payout[](n);
        for (uint256 i; i < n; ++i) {
            uint256 w = uint256(keccak256(abi.encode(seed, i)));
            uint256 assets = w % 4 == 0 ? bound(w >> 2, 1, 0.05e18) : bound(w >> 2, 0.03e18, 100e18);
            list[i] = CascadeMessages.Payout(address(uint160(i + 1)), (w >> 128) % 2, assets);
        }
        uint256 start = bound(startSeed, 0, n - 1);
        uint256 limit = bound(limitSeed, 1, CascadeMessages.MAX_ENTRIES);
        uint256 cap = bound(capSeed, 0.03e18, 400e18);
        uint256 minChunk = bound(minChunkSeed, 1, 10);
        (CascadeMessages.Entry[] memory entries, uint256 sum) =
            CascadePayoutMath.takeChunk(list, start, limit, cap, minChunk);
        (uint256 taken, uint256 sum_) = handler.takeChunkOf(list, start, limit, cap, minChunk);
        assertEq(taken, entries.length, "the chunk's entries");
        assertEq(sum_, sum, "the chunk's sum");

        // the fee split: the quote rounded up to rao, the entries charged at most the ceiling, floored to rao
        uint256 quote = bound(chargedSeed >> 128, 0, 2 * sum + 1e9);
        (uint256 fee, uint256 charged_) = CascadePayoutMath.feeSplit(quote, sum, 100, 0.015e18);
        (uint256 fee2, uint256 charged2) = handler.feeSplit(quote, sum, 100, 0.015e18);
        assertEq(fee2, fee, "the fee split's fee");
        assertEq(charged2, charged_, "the fee split's charge");

        uint256 charged = bound(chargedSeed, 0, sum);
        charged -= charged % RAO;
        (uint256[] memory nets, uint256 net, bool sharesAtZero, uint256 dust) =
            handler.deductFeeOf(list, start, taken, charged, sum);
        try this.deductFee(list, start, taken, charged, sum) returns (
            CascadeMessages.Entry[] memory kept, CascadeMessages.Entry[] memory dustOut, uint256 libNet
        ) {
            assertFalse(sharesAtZero, "the library sent a chunk with an entry with shares at 0");
            assertEq(net, libNet, "the split's net");
            assertEq(dust, dustOut.length, "the split's dust");
            uint256 k;
            uint256 d;
            for (uint256 i; i < taken; ++i) {
                if (nets[i] == 0) {
                    // a dust entry, at its gross value, in order
                    assertEq(dustOut[d].user, list[start + i].user, "a dust entry's user");
                    assertEq(dustOut[d].amount, list[start + i].assets, "a dust entry's amount");
                    ++d;
                    continue;
                }
                assertEq(kept[k].user, list[start + i].user, "a kept entry's user");
                assertEq(kept[k].amount, nets[i], "a kept entry's net");
                ++k;
            }
            assertEq(k, kept.length, "the kept entries");
            assertEq(d, dustOut.length, "the dust entries");
        } catch (bytes memory reason) {
            assertTrue(sharesAtZero, "the library refused a chunk the split sends");
            assertEq(bytes4(reason), FeeTooHigh.selector, "the refusal");
        }
    }

    /// The library's deductFee, as an external call the fuzz test can try.
    function deductFee(
        CascadeMessages.Payout[] calldata list,
        uint256 start,
        uint256 taken,
        uint256 charged,
        uint256 sum
    ) external pure returns (CascadeMessages.Entry[] memory, CascadeMessages.Entry[] memory, uint256) {
        return CascadePayoutMath.deductFee(list, start, taken, charged, sum);
    }

    /// @dev VaultModel's walk is the vault's under a root hold too: over two listed positions (HK1, the stake hotkey,
    /// and HK2), every pair locked or none, a removal fee in [0, 0.02 TAO] and an exit of a fuzzed value, the
    /// handler's verdict on the free balance, the walk and its cost (VaultModel's _exitPlan) is whether the vault's own
    /// redeemDirect pays or reverts, and with which error (UnstakeShort past T untaken, ZeroAmount when the cost leaves
    /// nothing); on a payment the leaver is paid exactly the predicted floorToRao(out - unmet - cost), its
    /// ShortfallAbsorbed is unmet + cost (Task 36b), and (the fix round 2) its predicted walk is the vault's: the
    /// Unstaked and UnstakeSkipped events, in order, are the predicted hotkeys, asks and skips (none when the balance
    /// covers it), each position left with what was not asked of it (nothing when taken whole).
    function testFuzz_theWalkUnderAHoldIsTheVaults(uint256 s2, uint256 fee, bool locked, uint256 shares) public {
        _directHolds(10e18);
        bytes32 hk2 = handler.HK2();
        vm.prank(address(vault));
        staking.moveStake(HK1, hk2, 0, 0, bound(s2, 0, 9e9));
        staking.setPairLocked(HK1, locked);
        staking.setPairLocked(hk2, locked);
        staking.setRemoveFeeRao(bound(fee, 0, 20_000_000));
        address erin = handler.directHolders(0);
        shares = bound(shares, 1, vault.balanceOf(erin));
        uint256 out = CascadeMath.assetsForRedeem(shares, vaultLens.totalAssets(), vault.totalSupply());
        out -= out % RAO;
        vm.assume(out != 0);
        VaultModel.ExitOut memory e = handler.exitPlanOf(_available(), out);
        VaultModel.Removal[] memory walk = e.walk;
        uint256[] memory before = new uint256[](walk.length);
        for (uint256 i; i < walk.length; ++i) {
            before[i] = staking.getStake(walk[i].hotkey, vaultLens.coldkey(), 0);
        }
        uint256 paidBefore = erin.balance;
        vm.recordLogs();
        vm.prank(erin);
        (bool ok, bytes memory ret) =
            address(vault).call{gas: 30_000_000}(abi.encodeCall(CascadeVault.redeemDirect, (shares, false)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(ok, e.refusal == 0, "the restatement and the vault disagree");
        if (!ok) {
            assertEq(bytes4(ret), e.refusal, "the refusal the restatement predicts");
            return;
        }
        assertEq(erin.balance - paidBefore, e.paid, "paid out less what was unmet and the walk's cost");
        uint256 borne;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == ShortfallAbsorbed.selector) {
                borne = abi.decode(logs[i].data, (uint256));
            }
        }
        assertEq(borne, e.unmet + e.cost, "the leaver bore what was unmet and the walk's cost");
        uint256 k;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault)) continue;
            bool skip = logs[i].topics[0] == UnstakeSkipped.selector;
            if (!skip && logs[i].topics[0] != Unstaked.selector) continue;
            assertLt(k, walk.length, "an attempt the model does not predict");
            assertEq(logs[i].topics[1], walk[k].hotkey, "the walk's order");
            assertEq(skip, walk[k].skipped, "a skip");
            uint256 left = staking.getStake(walk[k].hotkey, vaultLens.coldkey(), 0);
            if (skip) {
                assertEq(left, before[k], "a skipped position moved");
            } else {
                (uint256 wantRao,) = abi.decode(logs[i].data, (uint256, uint256));
                assertEq(wantRao, walk[k].wantRao, "the walk's ask");
                assertEq(left, walk[k].full ? 0 : before[k] - walk[k].wantRao, "what the removal left");
            }
            ++k;
        }
        assertEq(k, walk.length, "an attempt the model predicts, not made");
    }

    // ---- the spec's cases (§3.3's tests), scripted ----

    /// A 0.03 TAO bounce (the door's minimum, the bound's floor) under a 0.03 TAO payout fee, a lonely chunk: its
    /// entries' ceiling is MAX_FEE_ABS (0.015 TAO), so without a value it refuses FeeTooHigh; with the exact top-up it
    /// goes out, the bounce netting 0.015 TAO (never dust), the caller paying the top-up alone; a stranger's call with
    /// more than the top-up gets the rest back.
    function test_aBounceAtTheFloorUnderTheTopFeeIsNeverDust() public {
        // the payout lane's fee at 0.03 TAO
        handler.setPayoutFee(7);
        assertEq(handler.payoutFee(), 0.03e18);
        // the foreigner's deposit at the floor, closed at once: a 0.03 TAO bounce
        handler.doorDeposit(0, 0);
        assertEq(handler.queuedCount(), 1);
        assertEq(handler.foreignBounces(), 1);
        bytes32 key = handler.queuedKeys(0);
        assertEq(handler.listOf(key)[0].assets, 0.03e18);
        // no value: FeeTooHigh
        handler.processPayouts(0, 1, 0, 1);
        assertEq(handler.payoutsRefusedFeeShort(), 1);
        // a value that is not whole rao: BadValue
        handler.processPayouts(0, 1, 2, 1);
        assertEq(handler.payoutsRefusedBadValue(), 1);
        // the exact top-up, as the keeper
        handler.processPayouts(0, 1, 4, 1);
        assertEq(handler.payoutChunks(), 1);
        assertEq(handler.topUpChunks(), 1);
        assertEq(handler.bouncesPaid(), 1);
        assertEq(fd.claimable(handler.foreigner()), 0.015e18, "the bounce nets the fee's ceiling less");
        assertEq(handler.queuedCount(), 0);

        // a second bounce, a stranger's call with the top-up and more: the rest comes back
        handler.doorDeposit(0, 0);
        handler.processPayouts(0, 1, 3, 0);
        assertEq(handler.chunksByStranger(), 1);
        assertEq(handler.refundedChunks(), 1);
        assertEq(fd.claimable(handler.foreigner()), 0.03e18);
        _all();
    }

    /// A cancel carries the bounce: a batch of the foreigner's bounce and alice's redeem, cancelled by the owner,
    /// re-mints alice and leaves the batch holding only the bounce, which the vault stores as the handler's carried
    /// list (the handler's probes: a cancel with it refuses NothingToCancel, a payout with it no list mismatch); a
    /// second cancel refuses NothingToCancel; the bounces-only batch is later paid in full.
    function test_aCancelCarriesTheBounceAndTheBatchIsPaidLater() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        _aliceHolds(10e18);
        // seed 2: the foreigner's bounce (bit 0 clear), no holder deposit (bit 1 set), alice's request for all her
        // shares (bit 2 clear, her draw 0), bob and carol holding none
        handler.closeBatch(2);
        assertEq(handler.queuedCount(), 1);
        bytes32 key = handler.queuedKeys(0);
        assertEq(handler.listOf(key).length, 2);
        uint256 aliceBefore = vault.balanceOf(handler.doorHolders(0));
        handler.cancelQueued(0);
        assertEq(handler.cancels(), 1);
        assertEq(handler.carriedBatches(), 1);
        assertEq(handler.bouncesCarried(), 1);
        assertGt(vault.balanceOf(handler.doorHolders(0)), aliceBefore, "alice re-minted");
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        assertEq(b.count, 1);
        assertEq(b.remaining, 0.03e18);
        assertEq(vaultLens.pendingPayouts(), 0.03e18, "the bounce still reserved");
        handler.cancelQueued(0);
        assertEq(handler.cancelsRefusedNothing(), 1);
        handler.processPayouts(0, 1, 4, 1);
        assertEq(handler.carriedBatchesPaid(), 1);
        assertEq(vaultLens.pendingPayouts(), 0);
        _all();
    }

    /// The root hold (spec §3.8): every pair locked, a chunk that needs a walk refuses UnstakeShort, and with its
    /// removals burning the gas they are given it still refuses UnstakeShort within the call's gas; the liveness probe
    /// counts those states as held, never as failures. With the hold off the chunk goes out.
    function test_theHoldRefusesAWalkTheChunkNeeds() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        _aliceHolds(10e18);
        _aliceRequests(1e18);
        // seed 0: every pair locked, removals refused at once
        handler.setRootHold(0);
        handler.processPayouts(0, 1, 4, 1);
        assertEq(handler.payoutsRefusedHeld(), 1);
        assertGt(handler.livenessProbesHeld(), 0);
        // seed 12: every pair locked, removals burning their gas
        handler.setRootHold(12);
        handler.processPayouts(0, 1, 4, 1);
        assertEq(handler.payoutsRefusedHeldBurning(), 1);
        assertLt(handler.maxHeldBurnGas(), 30_000_000);
        // seed 1: the hold off
        handler.setRootHold(1);
        handler.processPayouts(0, 1, 4, 1);
        assertEq(handler.payoutChunks(), 1);
        assertEq(handler.walkedChunks(), 1);
        _all();
    }

    /// The leaver pays (spec §3.3, Task 36b): a chunk whose walk takes part of a 10 TAO position. At a 1,001-rao removal
    /// fee the walk takes the stake it asks, which covers the chunk at face value, and alice's entry bears the 1,001 rao
    /// with its share of the bridge fee (before Task 36b the chunk refused UnstakeShort); at 1,000 rao (the tolerance)
    /// likewise for her second request. Both walks' cushions stay idle whole, and no exit lowers the price (I-35).
    function test_aFeePastTIsTheChunksEntrysAsAtTheTolerance() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        _aliceHolds(10e18);
        address alice = handler.doorHolders(0);
        uint256[2] memory seeds = [uint256(3), 2];
        uint256[2] memory fees = [uint256(1_001), 1_000];
        for (uint256 i; i < 2; ++i) {
            _aliceRequests(1e18);
            bytes32 key = handler.queuedKeys(0);
            uint256 entry = handler.listOf(key)[0].assets;
            handler.setRemoveFee(seeds[i]);
            assertEq(staking.removeFeeRao(), fees[i]);
            uint256 claimable = fd.claimable(alice);
            uint256 price = vaultLens.price();
            handler.processPayouts(0, 1, 4, 1);
            assertEq(handler.payoutChunks(), i + 1);
            assertEq(handler.walkedChunks(), i + 1);
            assertEq(handler.chunksChargedWalkCost(), i + 1, "the entry bore the walk's cost");
            uint256 net = entry - 1e15 - fees[i] * RAO;
            assertEq(fd.claimable(alice) - claimable, net - net % RAO, "her entry less its share of fee and cost");
            assertEq(handler.availableAt(vaultLens.pendingPayouts()), 1_000 * RAO, "the cushion idle whole");
            assertGe(vaultLens.price(), price, "the holders' price unmoved");
            _all();
        }
        assertEq(handler.chunksSentAtAFeePastT(), 1);
    }

    /// Spec §3.3's case: two queued batches at zero idle balance, all processed, under a 1-rao removal fee.
    function test_twoBatchesAtZeroIdleAllProcessedAtAOneRaoFee() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        _aliceHolds(10e18);
        _aliceRequests(1e18);
        _aliceRequests(2e18);
        assertEq(handler.queuedCount(), 2);
        // seed 1: 1 rao
        handler.setRemoveFee(1);
        // seed 0: stake what is idle first
        handler.drainDue(0);
        assertEq(handler.queuedCount(), 0);
        assertEq(handler.multiBatchDrains(), 1);
        assertEq(handler.multiBatchDrainsAtFee1(), 1);
        _all();
    }

    /// Spec §3.3's case: a direct exit while a staked payout is queued, under a 1-rao removal fee: erin's exit walks
    /// the stake beside alice's queued payout, whose reservation is staked, and is paid its value less its walk's cost;
    /// the payout's reservation is still whole, and its chunk is then sent less its own walk's cost.
    function test_aDirectExitBesideAStakedPayoutAtAOneRaoFee() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        _directHolds(5e18);
        _aliceHolds(5e18);
        _aliceRequests(1e18);
        handler.setRemoveFee(1);
        address erin = handler.directHolders(0);
        // seed 3: erin, the first direct holder; half her shares (the draw's low bits 2: neither all nor any)
        handler.redeemDirect(3, ((vault.balanceOf(erin) / 2) << 3) | 2);
        assertEq(handler.directExits(), 1);
        assertEq(handler.directExitsWalked(), 1);
        assertEq(handler.directExitsBesideStakedPayoutAtFee1(), 1);
        handler.processPayouts(0, 1, 4, 1);
        assertEq(handler.payoutChunks(), 1);
        _all();
    }

    /// A position below the chain's minimum blocks the last exit (dustBlocked, the state the core and ledger sweeps
    /// did not reach): erin, the only holder, has 10 TAO staked on HK1 and a claim of 0.0015 TAO lands on the empty
    /// HK2, which the walk skips; once it has vested, her whole exit needs it, the walk takes HK1 whole and leaves
    /// 0.0015 TAO unmet, past the tolerance, so it refuses UnstakeShort as predicted, and nothing is burned.
    function test_aPositionUnderTheMinimumBlocksTheLastExit() public {
        _directHolds(10e18);
        // seed 0: the hotkey that is not the stake hotkey; an even amount: 3,000,000 >> 1 rao, under the minimum
        handler.accrueAndClaim(0, 3_000_000);
        assertEq(handler.dustClaims(), 1);
        assertEq(staking.getStake(handler.HK2(), vaultLens.coldkey(), 0), 1_500_000);
        handler.warp(3 days);
        handler.warp(3 days);
        handler.warp(3 days);
        address erin = handler.directHolders(0);
        uint256 shares = vault.balanceOf(erin);
        // seed 3: erin; a draw of 0 mod 4: all of her shares
        handler.redeemDirect(3, 0);
        assertEq(handler.directExitsUncoverable(), 1);
        assertEq(handler.dustBlocked(), 1);
        assertEq(vault.balanceOf(erin), shares, "nothing burned");
        _all();
    }

    /// The same position blocks the last chunk: alice, the only holder, asks for all her shares once a 0.0015 TAO claim
    /// on HK2 has vested; the chunk needs it, the walk cannot reach it, and the chunk refuses UnstakeShort
    /// (payoutsUncoverable, dustBlocked), which the liveness probe expects (the walk cannot cover: no failure).
    function test_aPositionUnderTheMinimumBlocksTheLastChunk() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        _aliceHolds(10e18);
        handler.accrueAndClaim(0, 3_000_000);
        handler.warp(3 days);
        handler.warp(3 days);
        handler.warp(3 days);
        // all of alice's shares (her draw 0 from bit 40), no bounce, no deposit
        handler.closeBatch(27);
        assertEq(vault.balanceOf(handler.doorHolders(0)), 0, "all burned");
        handler.processPayouts(0, 1, 4, 1);
        assertEq(handler.payoutsUncoverable(), 1);
        assertEq(handler.dustBlocked(), 1);
        assertGt(handler.livenessProbesUncoverable(), 0);
        _all();
    }

    /// The fee limits (spec §3.3): maxFeeAbs below MIN_FEE_ABS refuses InvalidParameter at once, above MAX_FEE_ABS its
    /// schedule runs and its execute refuses InvalidParameter, a tightening inside the bounds is at once, and a
    /// loosening is scheduled.
    function test_theFeeLimitsMoveOnlyWithinTheirBounds() public {
        handler.setFeeLimits(0);
        assertEq(handler.feeLimitsRefusedLow(), 1);
        handler.setFeeLimits(1);
        assertEq(handler.feeLimitsRefusedHigh(), 1);
        // seed 2, the bound's lowest: a tightening
        handler.setFeeLimits(2);
        assertEq(handler.feeLimitsTightened(), 1);
        assertEq(vaultLens.maxFeeAbs(), 0.01e18);
        // back to the top: a loosening
        handler.setFeeLimits(2 | (0.015e18 << 2));
        assertEq(handler.feeLimitsLoosened(), 1);
        assertEq(vaultLens.maxFeeAbs(), 0.015e18);
        _all();
    }

    /// A fee above T is the leaver's, in one removal (Task 36b; before, the walk went on to HK2 and the holders bore two
    /// fees): erin, the only holder, has 10 TAO staked, 5 on HK1 (the stake hotkey) and 5 on HK2; at a 1,001-rao
    /// removal fee her 1 TAO direct exit takes 1 TAO of HK1, which covers the request at face value, so the walk stops
    /// there, HK2 untouched. She is paid 1 TAO less the 1,001 rao the chain kept (ShortfallAbsorbed), the assets fall by
    /// exactly what the exit took, and the price does not move (I-35).
    function test_aFeeAboveTIsTheLeaversInOneRemoval() public {
        _directHolds(10e18);
        bytes32 hk2 = handler.HK2();
        vm.prank(address(vault));
        staking.moveStake(HK1, hk2, 0, 0, 5e9);
        // seed 3: 1,001 rao
        handler.setRemoveFee(3);
        assertEq(staking.removeFeeRao(), 1_001);
        address erin = handler.directHolders(0);
        uint256 shares = vault.balanceOf(erin) / 10;
        uint256 assetsBefore = vaultLens.totalAssets();
        uint256 price = vaultLens.price();
        uint256 paidBefore = erin.balance;
        // seed 3: erin; the draw (shares << 3) | 2: exactly those shares
        handler.redeemDirect(3, (shares << 3) | 2);
        assertEq(handler.directExits(), 1);
        assertEq(erin.balance - paidBefore, 1e18 - 1_001 * RAO, "paid 1 TAO less the fee");
        assertEq(handler.directExitsShort(), 1, "the leaver bore the fee");
        assertEq(handler.exitsCharged(), 1);
        assertEq(staking.getStake(HK1, vaultLens.coldkey(), 0), 4e9, "HK1 partial");
        assertEq(staking.getStake(hk2, vaultLens.coldkey(), 0), 5e9, "HK2 untouched");
        assertEq(assetsBefore - vaultLens.totalAssets(), 1e18, "the assets fall by what the exit took, no more");
        assertEq(vaultLens.price(), price, "the holders' price unchanged");
        assertEq(handler.exceptionOverruns(), 0);
        assertEq(handler.walksOfSeveralRemovals(), 0, "the one removal the model predicts");
        assertEq(handler.walkMismatches(), 0);
        _all();
    }

    /// The walk check's skip branch (Task 36's re-review, its Minor): no campaign walk that succeeds includes a skipped
    /// pair (the hold locks every pair or none), so this pins one. HK1's pair alone is held and HK2 serves the exit:
    /// VaultModel predicts HK1 skipped, then HK2 asked the exit's 1 TAO, and the vault's UnstakeSkipped and Unstaked
    /// logs are exactly those (_checkWalk counts the walk, no mismatch), at no removal fee and at fees past T, the
    /// leaver bearing HK2's fee and the held position untouched.
    function test_aWalkSkipsAHeldPairAndTheNextServesTheExit() public {
        _directHolds(10e18);
        bytes32 hk2 = handler.HK2();
        vm.prank(address(vault));
        staking.moveStake(HK1, hk2, 0, 0, 5e9);
        staking.setPairLocked(HK1, true);
        address erin = handler.directHolders(0);
        uint256 shares = vault.balanceOf(erin) / 10;
        uint256[3] memory fees = [uint256(0), 1_001, 50_000];
        for (uint256 i; i < fees.length; ++i) {
            uint256 snap = vm.snapshotState();
            staking.setRemoveFeeRao(fees[i]);
            uint256 out = CascadeMath.assetsForRedeem(shares, vaultLens.totalAssets(), vault.totalSupply());
            assertEq(out, 1e18);
            VaultModel.Removal[] memory walk = handler.walkRemovals(out - _available());
            assertEq(walk.length, 2, "two attempts predicted");
            assertEq(walk[0].hotkey, HK1);
            assertTrue(walk[0].skipped, "HK1 held: skipped");
            assertEq(walk[1].hotkey, hk2);
            assertFalse(walk[1].skipped);
            assertEq(walk[1].wantRao, 1e9, "HK2 asked the exit's 1 TAO");
            uint256 checked = handler.walksChecked();
            uint256 paidBefore = erin.balance;
            // seed 3: erin; the draw (shares << 3) | 2: exactly those shares
            handler.redeemDirect(3, (shares << 3) | 2);
            assertEq(handler.directExits(), 1);
            assertEq(handler.walksChecked(), checked + 1, "the walk checked against the logs");
            assertEq(handler.walkMismatches(), 0, "the skip and the removal as predicted");
            assertEq(erin.balance - paidBefore, 1e18 - fees[i] * RAO, "the leaver bears HK2's fee");
            assertEq(staking.getStake(HK1, vaultLens.coldkey(), 0), 5e9, "the held position untouched");
            assertEq(staking.getStake(hk2, vaultLens.coldkey(), 0), 4e9);
            _all();
            vm.revertToState(snap);
        }
    }

    /// The corner's targeted draw (Task 42; Task 36b's concern 2): from the pin below's batch (alice's and bob's 1 TAO
    /// requests, erin's 10 TAO direct, everything staked on HK1, the 1,000,001-rao payout fee, due), toTheCorner shapes
    /// the positions and the removal fee itself: the probe after it predicts the corner, inside the liveness
    /// precondition, and the chunk refuses exactly UnstakeShort.
    function test_theCornerDrawReachesTheWalksWholeRemovalCorner() public {
        handler.setAgeAtDeliveries(true);
        handler.doorDeposit(1, (1e9) << 1);
        handler.doorDeposit(4, (1e9) << 1);
        _directHolds(10e18);
        handler.closeBatch(19);
        handler.setPayoutFee(1_000_001 << 2);
        handler.warp(1 days);
        handler.warp(1 days);
        handler.toTheCorner();
        assertEq(handler.cornerDraws(), 1);
        assertEq(staking.removeFeeRao(), 1, "a 1-rao removal fee");
        assertEq(handler.livenessCorners(), 1, "the draw reached the corner");
        assertEq(handler.livenessCornerMismatches(), 0, "the corner refused exactly UnstakeShort");
        assertEq(handler.livenessFailures(), 0);
        _all();
    }

    /// The walk-cost draw (fix round 3, I-1): from the corner pin's batch (alice's and bob's 1 TAO requests, erin's 10
    /// TAO direct, everything staked, due), toTheWalkCost sets the least removal fee whose walk cost, split again over
    /// the two entries with the fee's share, zeroes one: the keeper's chunk refuses FeeTooHigh as predicted, nothing
    /// moves, and the fee goes back.
    function test_theWalkCostDrawRefusesAtTheLeastZeroingFee() public {
        handler.setAgeAtDeliveries(true);
        handler.doorDeposit(1, (1e9) << 1);
        handler.doorDeposit(4, (1e9) << 1);
        _directHolds(10e18);
        handler.closeBatch(19);
        handler.warp(1 days);
        handler.warp(1 days);
        uint256 fee0 = staking.removeFeeRao();
        uint256 remaining = vaultLens.pendingPayouts();
        handler.toTheWalkCost(0);
        assertEq(handler.walkCostDraws(), 1, "drawn");
        assertEq(handler.chunksRefusedWalkCost(), 1, "refused FeeTooHigh at the least zeroing fee");
        assertEq(vaultLens.pendingPayouts(), remaining, "nothing paid");
        assertEq(staking.removeFeeRao(), fee0, "the fee back");
        _all();
    }

    /// I-13's one carve-out, reached through the handler (Task 36b's fix round 1): the walk's whole-removal corner with
    /// another listed position holding plenty. Alice and bob (1 TAO each at the door) and erin (10 TAO direct), all
    /// staked on HK1; alice and bob ask for all their shares in one batch. Once it is due, HK1 (the stake hotkey) is
    /// left holding exactly need - free (1,999,999,999 rao: at a payout fee of 1,000,001 rao each entry nets 1 TAO less
    /// 500,000.5 rao, floored) and HK2 the other 10 TAO and a rao. At no removal fee the probe's chunk is sent (the
    /// receipts are the stake taken). At a 1-rao fee the liveness precondition holds (12 TAO on the walk's positions,
    /// no entry zeroed) and the model predicts the corner: the walk takes HK1 whole and stops with exactly T untaken,
    /// and the second split (1,000,002 rao, whole) leaves the entries a rao more than the receipts. The probe counts it
    /// (livenessCorners) and the vault refuses exactly UnstakeShort; so does the keeper's chunk (payoutsRefusedCoverage),
    /// HK2 untouched. A direct deposit moves the balance, and the chunk is sent with the price unmoved.
    function test_theLivenessProbeExpectsTheWalksWholeRemovalCorner() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        // seeds 1 and 4: alice and bob, 1 TAO each, each closed at once; erin's 10 TAO direct; all staked
        handler.doorDeposit(1, (1e9) << 1);
        handler.doorDeposit(4, (1e9) << 1);
        _directHolds(10e18);
        bytes32 hk2 = handler.HK2();
        assertEq(staking.getStake(HK1, vaultLens.coldkey(), 0), 12e9, "everything staked on HK1");
        // closeBatch's low bits 0b10011: no bounce, no deposit, alice's and bob's requests (draws 0: all their shares)
        handler.closeBatch(19);
        assertEq(handler.queuedCount(), 1);
        assertEq(vaultLens.pendingPayouts(), 2e18, "two 1 TAO entries");
        // kind 0: a payout fee of 1,000,001 rao
        handler.setPayoutFee(1_000_001 << 2);
        assertEq(handler.payoutFee(), 1_000_001 * RAO);
        handler.warp(1 days);
        handler.warp(1 days);
        vm.prank(address(vault));
        staking.moveStake(HK1, hk2, 0, 0, 10_000_000_001);
        assertEq(staking.getStake(HK1, vaultLens.coldkey(), 0), 1_999_999_999, "need - free");
        // at no removal fee the probe's chunk is sent: the corner needs a cost
        handler.warp(1 hours);
        assertEq(handler.livenessCorners(), 0);
        uint256 asserted = handler.livenessAsserted();
        // seed 1: a 1-rao removal fee
        handler.setRemoveFee(1);
        assertEq(staking.removeFeeRao(), 1);
        assertEq(handler.livenessCorners(), 1, "the probe predicts the corner");
        assertEq(handler.livenessCornerMismatches(), 0, "the corner refused exactly UnstakeShort");
        assertEq(handler.livenessAsserted(), asserted + 1, "inside the liveness precondition");
        assertEq(handler.livenessFailures(), 0);
        // the keeper's chunk of up to 3 entries (entriesSeed 17), the exact top-up (valueSeed 4): refused alike
        handler.processPayouts(0, 17, 4, 1);
        assertEq(handler.payoutsRefusedCoverage(), 1, "finish's coverage check");
        assertEq(handler.payoutChunks(), 0);
        assertEq(staking.getStake(hk2, vaultLens.coldkey(), 0), 10_000_000_001, "HK2 never tried");
        assertEq(handler.livenessCorners(), 2);
        _all();
        // erin's 1 TAO direct deposit moves the balance: the probe's chunk is sent, then the keeper's, the price unmoved
        handler.depositDirect(0, 1e9);
        assertEq(handler.livenessCorners(), 2, "out of the corner");
        uint256 price = vaultLens.price();
        handler.processPayouts(0, 17, 4, 1);
        assertEq(handler.payoutChunks(), 1, "sent once the balance moved");
        assertEq(handler.queuedCount(), 0);
        assertEq(staking.getStake(hk2, vaultLens.coldkey(), 0), 10_000_000_001, "HK2 still untouched");
        assertEq(vaultLens.price(), price, "the price unmoved");
        _all();
    }

    // ---- the tail of an emptied vault (the review's Important 2, Task 36b; the runbook cites this) ----

    /// The tail of a vault every share has left drains at any removal fee, with no wait, no hole and no gift: alice
    /// (10 TAO) and bob (5 TAO), and carol (3 TAO) in the 3-entry tail, the only holders, staked, ask the door for all
    /// their shares in one batch, and the keeper sends one chunk an entry, at removal fees of 1, 1,000, 1,001 and
    /// 50,000 rao. Each chunk's walk asks T more than it needs and its entry bears the walk's cost (the fee) with its
    /// share of the bridge fee, so each walking chunk leaves its cushion idle whole, which is the next chunk's free
    /// balance, and the last takes the rest of the stake whole and that cushion with it. Every chunk is sent, each
    /// entry credited its value less the bridge fee's share and the fee, the gross never falls below the queued
    /// payouts (holeWei 0, i4GapsAbsorbed 0), and the vault ends with ED_RESERVE alone. (Before Task 36b each walking
    /// chunk left the fee as a hole no holder absorbed, and the last waited for a deposit or a stake gift.)
    function test_anEmptiedVaultsTailDrainsAtAnyFee() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        uint256[4] memory seeds = [uint256(1), 2, 3, 4];
        uint256[4] memory fees = [uint256(1), 1_000, 1_001, 50_000];
        for (uint256 t; t < 2; ++t) {
            bool withCarol = t == 1;
            for (uint256 f; f < seeds.length; ++f) {
                uint256 snap = vm.snapshotState();
                _anEmptiedVault(withCarol, seeds[f]);
                assertEq(staking.removeFeeRao(), fees[f]);
                address[3] memory holders = [handler.doorHolders(0), handler.doorHolders(1), handler.doorHolders(2)];
                uint256[3] memory values = [uint256(10e18), 5e18, 3e18];
                uint256 n = withCarol ? 3 : 2;
                for (uint256 i; i < n; ++i) {
                    handler.processPayouts(0, 1, 4, 1);
                    assertEq(handler.payoutChunks(), i + 1, "every chunk sent, none waits");
                    assertEq(fd.claimable(holders[i]), values[i] - 1e15 - fees[f] * RAO, "the entry less its costs");
                    assertGe(vaultLens.grossAssets(), vaultLens.pendingPayouts(), "no hole");
                    _all();
                }
                assertEq(handler.queuedCount(), 0);
                assertEq(handler.chunksChargedWalkCost(), n, "each chunk's entry bore its walk's cost");
                assertEq(handler.payoutsUncoverable(), 0);
                assertEq(handler.holeWei(), 0, "no gap recorded");
                assertEq(handler.i4GapsAbsorbed(), 0);
                assertEq(vaultLens.pendingPayouts(), 0);
                assertEq(vaultLens.visibleStakeRao(), 0, "the stake taken whole by the last chunk");
                assertEq(address(vault).balance, 1e12, "ED_RESERVE alone: the last chunk took the cushion");
                vm.revertToState(snap);
            }
        }
    }

    // ---- a cancel after a partial chunk (the fix round 2) ----

    /// The cancel-after-partial draw (fix round 4, the review's I-2): alice's 1 TAO request and the foreigner's bounce
    /// at the floor in one batch (the bounce queued first); toTheCancelAfterPartial waits out the payout delay, sends
    /// the keeper's one-entry chunk (the bounce) and cancels: alice re-minted after a partial chunk, nothing carried.
    function test_theCancelAfterPartialDrawCancelsAfterAOneEntryChunk() public {
        handler.setAgeAtDeliveries(true);
        _aliceHolds(10e18);
        address alice = handler.doorHolders(0);
        // closeBatch's low bits 0b11010, alice's draw from bit 40: as test_aCancelAfterAPartialChunkCarriesTheUnsentBounce
        uint256 shares = CascadeMath.sharesForDeposit(1e18, vaultLens.totalAssets(), vault.totalSupply());
        handler.closeBatch((((shares << 2) | 1) << 40) | 26);
        assertEq(handler.queuedCount(), 1);
        bytes32 key = handler.queuedKeys(0);
        CascadeMessages.Payout[] memory list = handler.listOf(key);
        assertEq(list.length, 2, "the bounce and the redeem");
        assertEq(list[0].shares, 0, "the bounce first");
        assertEq(list[1].user, alice);
        uint256 aliceBefore = vault.balanceOf(alice);
        handler.toTheCancelAfterPartial(0);
        assertEq(handler.payoutChunks(), 1, "the one-entry chunk");
        assertEq(handler.partialChunks(), 1, "it left the redeem unsent");
        assertEq(handler.cancelAfterPartialDraws(), 1, "drawn");
        assertEq(handler.cancelsAfterPartial(), 1, "the cancel after it");
        assertGt(vault.balanceOf(alice), aliceBefore, "alice re-minted");
        assertEq(handler.queuedCount(), 0, "nothing carried: the batch is gone");
        _all();
    }

    /// The carried list from a non-zero cursor, which the sweep never reached (cancelsAfterPartial 0/128): a delivery
    /// queues its bounces ahead of its burns, so the foreigner's one bounce is always a batch's first entry and is paid
    /// by its first chunk, and a cancel after it would carry nothing. gina, given the second chain's redeem origin
    /// (addForeigner), brings a second bounce. The batch: gina's 0.05 TAO bounce, the foreigner's at the floor (0.03
    /// TAO) and alice's 1 TAO redeem. The keeper's one-entry chunk pays gina's (cursor 1); the owner's cancel re-mints
    /// alice and carries the foreigner's bounce, which the vault stores as the whole batch (count 1, cursor 0, the
    /// bounce's value remaining, the chunk number kept) and accepts as the list; the next chunk pays it in full, less
    /// its share of the world's fee.
    function test_aCancelAfterAPartialChunkCarriesTheUnsentBounce() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        _aliceHolds(10e18);
        address alice = handler.doorHolders(0);
        address foreigner = handler.foreigner();
        address gina = makeAddr("gina");
        handler.addForeigner(gina);
        handler.depositAs(gina, 0.05e18);
        _all();
        // closeBatch's low bits 0b11010: the foreigner's bounce at the floor, no door holder's deposit, alice's request
        // and not bob's or carol's, one round; her draw from bit 40: not all, the shares above its two low bits
        uint256 shares = CascadeMath.sharesForDeposit(1e18, vaultLens.totalAssets(), vault.totalSupply());
        handler.closeBatch((((shares << 2) | 1) << 40) | 26);
        assertEq(handler.queuedCount(), 1);
        bytes32 key = handler.queuedKeys(0);
        CascadeMessages.Payout[] memory list = handler.listOf(key);
        assertEq(list.length, 3, "two bounces and a redeem");
        assertEq(list[0].user, gina);
        assertEq(list[0].shares, 0);
        assertEq(list[0].assets, 0.05e18);
        assertEq(list[1].user, foreigner);
        assertEq(list[1].shares, 0);
        assertEq(list[1].assets, 0.03e18);
        assertEq(list[2].user, alice);
        assertEq(list[2].shares, shares);
        _all();

        // the keeper's one-entry chunk, once due: gina's bounce, the batch left at cursor 1
        handler.processPayouts(0, 1, 4, 1);
        assertEq(handler.payoutChunks(), 1);
        assertEq(handler.partialChunks(), 1);
        assertEq(fd.claimable(gina), 0.05e18 - 0.001e18, "gina's bounce less its share of the world's fee");
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        assertEq(b.cursor, 1);
        assertEq(b.chunk, 1);
        _all();

        // the owner's cancel: alice re-minted, only her value released, the foreigner's bounce carried
        uint256 aliceBefore = vault.balanceOf(alice);
        uint256 pendingBefore = vaultLens.pendingPayouts();
        handler.cancelQueued(0);
        assertEq(handler.cancels(), 1);
        assertEq(handler.cancelsAfterPartial(), 1);
        assertEq(handler.carriedBatches(), 1);
        assertEq(handler.bouncesCarried(), 1);
        assertTrue(handler.carried(key));
        assertGt(vault.balanceOf(alice), aliceBefore, "alice re-minted");
        assertEq(pendingBefore - vaultLens.pendingPayouts(), list[2].assets, "only alice's value released");
        CascadeMessages.Payout[] memory kept = handler.listOf(key);
        assertEq(kept.length, 1, "the carried list");
        assertEq(kept[0].user, foreigner);
        assertEq(kept[0].shares, 0);
        assertEq(kept[0].assets, 0.03e18);
        b = vaultLens.getPayoutBatch(key);
        assertEq(b.count, 1, "the stored batch's count");
        assertEq(b.cursor, 0, "the stored batch's cursor, reset");
        assertEq(b.remaining, 0.03e18, "the stored batch's remaining: the bounce");
        assertEq(b.chunk, 1, "the chunk number kept");
        assertEq(vaultLens.pendingPayouts(), 0.03e18);
        _all();

        // the carried batch's chunk pays the foreigner's bounce in full
        handler.processPayouts(0, 1, 4, 1);
        assertEq(handler.payoutChunks(), 2);
        assertEq(handler.carriedBatchesPaid(), 1);
        assertEq(handler.queuedCount(), 0);
        assertEq(vaultLens.pendingPayouts(), 0);
        assertEq(vaultLens.getPayoutBatch(key).count, 0, "the batch done");
        assertEq(fd.claimable(foreigner), 0.03e18 - 0.001e18, "the bounce less its share of the world's fee");
        _all();
    }

    // ---- the last exit at a supply of 0 with a reward vesting (the fix round 3, inverted by Task 36b; the runbook
    // cites these) ----

    /// The owner's cancel after the last holder's exit, at a 1,000-rao removal fee (the tolerance), is exact: the exit
    /// paid its own fee, so it left no schedule hole and nothing is recorded, and the cancel re-mints alice's entry at
    /// its value with no fall (_aCancelAfterTheLastExitIsExact).
    function test_aCancelAfterTheLastExitIsExactAtTheTolerance() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        _aCancelAfterTheLastExitIsExact(2, 1_000);
    }

    /// The same at a 1,001-rao removal fee (one past the tolerance).
    function test_aCancelAfterTheLastExitIsExactPastT() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        _aCancelAfterTheLastExitIsExact(3, 1_001);
    }

    /// The same at a 50,000-rao removal fee.
    function test_aCancelAfterTheLastExitIsExactAtFiftyThousandRao() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        _aCancelAfterTheLastExitIsExact(4, 50_000);
    }

    /// The same state, then a direct deposit instead of the cancel, at a 1,001-rao fee: the exit left no hole, so the
    /// deposit at a supply of 0 writes nothing down (the schedule is whole: Task 15's write-down is to what the gross
    /// holds beyond the payouts, which is all of it), the price does not fall, and the depositor's value is its deposit
    /// exactly. No record was made, so none is forgotten or absorbed.
    function test_aDepositAfterTheLastExitIsExact() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        uint256 reward = _lastExitWithARewardVesting(3);
        assertEq(handler.shortfallHoleWei(), 0, "no schedule hole, nothing recorded");
        _all();
        uint256 priceBefore = vaultLens.price();
        // frank's 1 TAO direct deposit at a supply of 0
        handler.depositDirect(1, 1e9);
        assertEq(handler.directDeposits(), 2);
        address frank = handler.directHolders(1);
        assertEq(vaultLens.unvestedRewards(), reward, "nothing written down: the schedule whole");
        assertEq(vaultLens.price(), priceBefore, "no fall");
        assertEq(
            CascadeMath.assetsForRedeem(vault.balanceOf(frank), vaultLens.totalAssets(), vault.totalSupply()),
            1e18,
            "the depositor's value is its deposit exactly"
        );
        assertEq(handler.i4ShortfallHolesAbsorbed(), 0);
        _all();
    }

    /// The same state at no removal fee: the exit's receipt is whole, so no schedule hole is left or recorded, and the
    /// cancel re-mints alice's entry at its value with no fall.
    function test_theLastExitAtNoRemovalFeeLeavesNoScheduleHole() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        _lastExitWithARewardVesting(0);
        assertEq(staking.removeFeeRao(), 0);
        assertEq(handler.directExitsShort(), 0, "erin paid in full");
        assertEq(handler.shortfallHoleWei(), 0, "no record");
        assertEq(
            vaultLens.grossAssets(), vaultLens.pendingPayouts() + vaultLens.unvestedRewards(), "the schedule whole"
        );
        _all();
        uint256 entry = vaultLens.pendingPayouts();
        uint256 priceBefore = vaultLens.price();
        handler.cancelQueued(0);
        assertEq(handler.cancels(), 1);
        assertEq(handler.i4ShortfallHolesAbsorbed(), 0);
        assertEq(vaultLens.totalAssets(), entry, "no fall: the entry's value exactly");
        assertEq(vaultLens.price(), priceBefore, "the price unmoved");
        _all();
    }

    /// The 512-run trace of the fix round 3 (run 163, shrunk to 7 calls; the fuzzer's draws kept but the fee's, now
    /// seed 2), inverted by Task 36b. At a 1,000-rao removal fee two batches are queued (carol's whole redeem of 29.8
    /// TAO and two of the foreigner's 0.03 TAO bounces) with every share burned: a supply of 0. Before Task 36b
    /// drainDue's first chunk left the fee as a 1,000-rao payout gap, the second batch's chunk refused UnstakeShort, a
    /// claim then moved the gap into the vesting schedule and the owner's cancel absorbed it. Now each chunk's entries
    /// bear their walk's fee, so drainDue sends both batches (the second paid from the first's idle cushion and the
    /// rest of the stake), no gap or schedule hole forms, nothing is recorded, and the vault is left with its own
    /// rounding (1 rao, the vault's favour) and no queue: the claim and the cancel of the old trace have nothing to act
    /// on.
    function test_theRun163TraceDrainsWithNoHole() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        // seed 2: 1,000 rao
        handler.setRemoveFee(2);
        assertEq(staking.removeFeeRao(), 1_000);
        handler.closeBatch(110588498957000000000);
        handler.doorRedeem(63529225573041863796650110452160997, 6383819697648);
        handler.closeBatch(1571549999129956150876126577466424869244696638278390);
        assertEq(vault.totalSupply(), 0, "every share burned");
        assertEq(handler.queuedCount(), 2);
        assertEq(handler.shortfallHoleWei(), 0);
        _all();

        handler.drainDue(40304916376000000000);
        assertEq(handler.payoutChunks(), 2, "both batches sent");
        assertEq(handler.queuedCount(), 0);
        assertEq(handler.multiBatchDrains(), 1);
        assertEq(handler.chunksChargedWalkCost(), 2, "each chunk's entries bore their walk's fee");
        assertEq(handler.payoutsUncoverable(), 0, "no chunk waited");
        assertEq(vault.totalSupply(), 0);
        assertEq(vaultLens.pendingPayouts(), 0);
        assertEq(vaultLens.grossAssets(), RAO, "the vault's own rounding, no hole");
        assertEq(handler.holeWei(), 0, "nothing recorded");
        assertEq(handler.shortfallHoleWei(), 0);
        assertEq(handler.i4GapsAbsorbed(), 0);
        _all();
    }

    /// The cancel pins' body, at the removal fee `feeSeed` draws (`feeRao` rao). After the last exit (which paid the
    /// fee) the schedule is whole, nothing is recorded (shortfallHoleWei and holeWei 0) and the assets read exactly 0.
    /// The owner's cancel re-mints alice's 10 TAO entry at the supply-0 price over no hole: the assets read the entry's
    /// value exactly, the price does not move (I-35, checked), and nothing is given back or absorbed. After the full
    /// vesting alice, the only holder, holds her entry's value plus the whole reward.
    function _aCancelAfterTheLastExitIsExact(uint256 feeSeed, uint256 feeRao) internal {
        uint256 reward = _lastExitWithARewardVesting(feeSeed);
        assertEq(staking.removeFeeRao(), feeRao);
        assertEq(
            vaultLens.grossAssets(), vaultLens.pendingPayouts() + vaultLens.unvestedRewards(), "the schedule whole"
        );
        assertEq(handler.shortfallHoleWei(), 0, "no schedule hole, nothing recorded");
        assertEq(handler.holeWei(), 0, "no payout gap");
        assertEq(vaultLens.totalAssets(), 0);
        _all();

        uint256 entry = vaultLens.pendingPayouts();
        assertEq(entry, 10e18, "alice's entry");
        uint256 priceBefore = vaultLens.price();
        uint256 checked = handler.exitsPriceChecked();
        handler.cancelQueued(0);
        assertEq(handler.cancels(), 1);
        assertEq(handler.cancelsOverAHole(), 0);
        assertEq(handler.exitsPriceChecked(), checked + 1, "I-35 checked around the cancel");
        assertEq(handler.cancelDustViolations(), 0);
        assertEq(handler.i4ShortfallHolesAbsorbed(), 0, "nothing to give back");
        address alice = handler.doorHolders(0);
        assertEq(vault.balanceOf(alice), vault.totalSupply(), "alice re-minted, the only holder");
        assertEq(vault.totalSupply(), CascadeMath.sharesForDeposit(entry, 0, 0), "at the supply-0 price");
        assertEq(vaultLens.totalAssets(), entry, "no fall: the entry's value exactly");
        assertEq(vaultLens.price(), priceBefore, "the price unmoved");
        _all();

        // the full vesting, a day at a time
        for (uint256 i; i < 8 && vaultLens.unvestedRewards() != 0; ++i) {
            handler.warp(1 days);
        }
        assertEq(vaultLens.unvestedRewards(), 0, "fully vested");
        assertEq(vaultLens.totalAssets(), entry + reward, "the entry and the whole reward");
        assertEq(vault.balanceOf(alice), vault.totalSupply());
        _all();
    }

    /// alice (10 TAO, at the door, staked on HK1) asks for all of her shares, so the supply is 0 and her 10 TAO stay
    /// staked for the payout; erin deposits 20 TAO directly (liquid), and a 500,000-rao reward is claimed onto HK1,
    /// vesting; the removal fee is set by `feeSeed` (setRemoveFee). erin then exits whole: her 20 TAO are the liquid
    /// balance beyond the payout and 10 TAO more, which the walk asks of HK1, and the remainder (the reward) is under
    /// the chain's minimum remainder, so the walk takes HK1 whole, the reward's stake with it, and its one receipt is
    /// short by the fee, which erin bears (Task 36b: before, the holders absorbed it and, with none left, the schedule
    /// was short by it). With her gone there are none: at a supply of 0 the gross is exactly the payout and the reward.
    /// Returns the reward, in wei.
    function _lastExitWithARewardVesting(uint256 feeSeed) internal returns (uint256 reward) {
        _aliceHolds(10e18);
        // all of alice's shares (her draw 0 from bit 40), no bounce, no deposit
        handler.closeBatch(27);
        assertEq(vault.totalSupply(), 0, "alice's shares burned");
        assertEq(vaultLens.pendingPayouts(), 10e18, "her payout queued");
        // seed 0: erin
        handler.depositDirect(0, 20e9);
        // seed 1: the stake hotkey (HK1); rao 1,000,001: up to 1 TAO, 1,000,001 >> 1 = 500,000 rao
        handler.accrueAndClaim(1, 1_000_001);
        reward = vaultLens.unvestedRewards();
        assertEq(reward, 500_000 * RAO, "the reward, vesting");
        handler.setRemoveFee(feeSeed);
        address erin = handler.directHolders(0);
        uint256 paidBefore = erin.balance;
        // seed 3: erin; the draw 0: all of her shares
        handler.redeemDirect(3, 0);
        assertEq(handler.directExits(), 1);
        assertEq(erin.balance - paidBefore, 20e18 - staking.removeFeeRao() * RAO, "erin bears the fee");
        assertEq(staking.getStake(HK1, vaultLens.coldkey(), 0), 0, "HK1 taken whole");
        assertEq(vault.totalSupply(), 0, "the last holder left");
    }

    // ---- the checks can fail ----

    /// The liveness probe is not vacuous: with the vault's processPayouts made to revert, a due batch whose
    /// preconditions all hold is counted a failure, and the invariant fails.
    function test_theLivenessProbeCanFail() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        _aliceHolds(10e18);
        _aliceRequests(1e18);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        vm.mockCallRevert(address(vault), abi.encodeWithSelector(CascadeVault.processPayouts.selector), "no");
        handler.warp(0);
        vm.clearMockedCalls();
        assertGt(handler.livenessFailures(), 0);
        vm.expectRevert();
        this.invariant_processPayoutsLiveWithTheHoldOff();
    }

    /// I-19's comparison is not vacuous: a batch whose stored remaining is a wei off the handler's unpaid entries
    /// fails it.
    function test_theBounceCheckCanFail() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        _aliceHolds(10e18);
        _aliceRequests(1e18);
        bytes32 key = handler.queuedKeys(0);
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        b.remaining += 1;
        vm.mockCall(address(vaultLens), abi.encodeCall(CascadeVaultLens.getPayoutBatch, (key)), abi.encode(b));
        vm.expectRevert();
        this.invariant_bouncesNeverReleased();
    }

    // ---- helpers ----

    /// Alice holds `amount` of shares' value: her deposit at the door, closed and delivered, then staked.
    function _aliceHolds(uint256 amount) internal {
        // seed 1: alice (1 mod 3 is not the foreigner's, 1 / 3 mod 3 is alice), closed at once
        handler.doorDeposit(1, (amount / RAO) << 1);
        assertGt(vault.balanceOf(handler.doorHolders(0)), 0, "alice's shares");
        handler.stakeIdle();
    }

    /// Erin holds `amount` of shares' value: her direct deposit, staked.
    function _directHolds(uint256 amount) internal {
        handler.depositDirect(0, amount / RAO);
        assertGt(vault.balanceOf(handler.directHolders(0)), 0, "erin's shares");
        handler.stakeIdle();
    }

    /// Alice's request for `value` of her shares, closed and queued (closeBatch's low bits 0b011011: no bounce, no
    /// deposit, alice's request and not bob's or carol's, one round; her draw from bit 40: not all, the shares above
    /// its two low bits).
    function _aliceRequests(uint256 value) internal {
        uint256 shares = CascadeMath.sharesForDeposit(value, vaultLens.totalAssets(), vault.totalSupply());
        handler.closeBatch((((shares << 2) | 1) << 40) | 27);
    }

    /// The vault's balance beyond ED and the queued payouts (VaultModel's availableAt).
    function _available() internal view returns (uint256) {
        return handler.availableAt(vaultLens.pendingPayouts());
    }

    /// alice (10 TAO) and bob (5 TAO), and carol (3 TAO) when `withCarol`, the only holders, their deposits delivered
    /// and staked; the removal fee set by `feeSeed` (setRemoveFee: 1 for 1 rao, 2 for 1,000); then every one of them
    /// asks the door for all of its shares in one batch, closed and delivered (closeBatch's low bits: no bounce, no
    /// deposit, alice's and bob's requests, carol's when `withCarol`, one round; each draw 0: all of its shares). The
    /// supply is then 0.
    function _anEmptiedVault(bool withCarol, uint256 feeSeed) internal {
        // seeds 1, 4, 7: alice, bob, carol (not the foreigner's, then index (seed / 3) mod 3), each closed at once
        handler.doorDeposit(1, (10e9) << 1);
        handler.doorDeposit(4, (5e9) << 1);
        if (withCarol) handler.doorDeposit(7, (3e9) << 1);
        handler.stakeIdle();
        assertEq(handler.availableAt(0), 0, "everything staked");
        handler.setRemoveFee(feeSeed);
        handler.closeBatch(withCarol ? 3 : 19);
        assertEq(vault.totalSupply(), 0, "every share has left");
        assertEq(handler.queuedCount(), 1);
    }

    /// Every invariant of the campaign, the boundary ones included.
    function _all() internal view {
        invariant_reservesUntouchedPerExit();
        invariant_priceFallsOnlyByI4sExceptions();
        invariant_chunkSentAsQueuedOrReverted();
        invariant_processPayoutsLiveWithTheHoldOff();
        invariant_noDustWithShares();
        invariant_bouncesNeverReleased();
        invariant_walkRemovesWhatTheModelPredicts();
        invariant_noExitLowersThePrice();
        invariant_noUnexpectedReverts();
        invariant_vaultLensParity();
        invariant_doorLensParity();
        invariant_tokenAccounting();
        invariant_aPendingReopenNamesARemovedDoor();
    }
}
