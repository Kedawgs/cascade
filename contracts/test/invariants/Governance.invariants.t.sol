// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CascadeBase} from "../../src/CascadeBase.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {ICascadeBridge} from "../../src/interfaces/ICascadeBridge.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {MAX_FEE_ABS} from "../../src/CascadeConstants.sol";
import {Actor, Item, Kind} from "../../src/CascadeTypes.sol";
import {StampedBySig} from "../../src/CascadeEvents.sol";
import {Vm} from "forge-std/Vm.sol";
import {InvalidParameter, NotScheduled} from "../../src/CascadeErrors.sol";
import {GovernanceWorld} from "./GovernanceWorld.sol";
import {MinimumHits} from "./MinimumHits.sol";
import {GovernanceHandler} from "./handlers/GovernanceHandler.sol";
import {TrackedHandler} from "./handlers/TrackedHandler.sol";

/// @dev The governance campaign (Task 39a; spec §3.6, I-22 to I-25 and I-29): random sequences of GovernanceHandler's
/// actions on GovernanceFixture's world, the vault and the launch front door with their schedulers. The owner schedules
/// the setter table's items on either target (tightening, equal, loosening and out-of-bounds values; activations of new,
/// known and guardian-removed doors and bridges; guardian swaps and ownership transfers), executes them at and around
/// their readiness and across chain halts, calls the setters directly, cancels, and plays every instrument; the guardian
/// (whichever the swaps leave) cancels and plays its instruments; the stranger relays the owner's signed stamps, valid and
/// not, and prunes; every actor tries every scheduled-only path directly, and ProbeBridge, made a primary, tries them
/// from inside each cap check, execute's included; alice's redeems queue launch-door payouts, sent, refused with the
/// door or the bridge down, and cancelled by the owner (an instrument). Inherits BoundaryInvariants (lens parity on both
/// lenses, token accounting, the pending Reopens, after every step; the fixed libraries in the setUp): the door's items,
/// clocks and holds, both lenses' primaryDisabledBy and pendingSince and the vault's pausedBy are non-zero here.
contract GovernanceInvariantTest is GovernanceWorld, MinimumHits {
    GovernanceHandler handler;

    /// The world (GovernanceWorld.buildWorld: the boundary invariants' targets, the governance parts, the probe known and
    /// enabled on both targets through the fixture's own helpers (7 days) before the handler's model is read, so a
    /// disabled primary can be switched to it at once and its cap checks re-enter; the second launch-chain door the
    /// campaign's to activate, while it is active the launch door's removal closing nothing) and its 35 weighted
    /// actions (governanceSelectors: the scheduler's two halves and the honest owner's way back three times as likely,
    /// the direct setters, alice's redeems, the payouts and the door removals twice, a multi-field setter with one
    /// field loosened four times, one bounded field one past a bound twice, a directed halt past an item's window
    /// once). Task 42 folded this setUp onto the world
    /// the liveness and copied-key campaigns build (the Task 39b review's reading 5), replayed identical.
    function setUp() public {
        startGovernance();
        c = deployCampaign();
        handler = new GovernanceHandler(TrackedHandler.System(c.vault, c.vaultLens, c.fd, c.doorLens, owner, guardian));
        buildWorld(handler);
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: governanceSelectors(0)}));
    }

    // ---- the invariants ----

    /// @dev I-22 (spec §3.6), from the handler's own ghost log: no loosening's effect, no activation of a new, known or
    /// guardian-removed door or bridge, no guardian swap and no ownership transfer without an execute of an item the log
    /// says was scheduled, ready in time and in blocks, inside its window, past its gate (the exits open for an Ordinary
    /// item, no owner hold for a GuardianSwap) and not killed by its clock or a cancel; an ownership change only at
    /// acceptOwnership inside its window with the exits open and no clock since the transfer's execute. Checked four
    /// ways after every step: no execute succeeded that the log refuses; no direct call loosened; every field any setter,
    /// instrument or stamp writes on either target is the model's, which only those calls move; and both lenses' items
    /// are the log's pending ones. Every call's events were the handler's own (Scheduled with its kind, readyAt and
    /// calldata; Executed; Cancelled by its caller; Lapsed; StampedBySig; ExitsClosed exactly when it stamps).
    function invariant_noEffectWithoutScheduledOpenUnstamped() public view {
        assertEq(handler.executeViolations(), 0, "I-22: an execute ran an item the ghost log refuses");
        assertEq(handler.unscheduledLoosenings(), 0, "I-22: a loosening took effect without its item");
        assertEq(handler.acceptanceViolations(), 0, "I-22: an acceptance its gate refuses took effect");
        assertEq(handler.eventMismatches(), 0, "I-22: a call's events are not the ones the handler predicted");
        assertEq(handler.modelMismatch(), "", "I-22: an effect no call of the handler explains");
        assertEq(handler.ghostMismatch(), "", "I-22: the lenses' items are not the ghost log's");
    }

    /// @dev I-23: a tightening by the owner (or an equal value, or an immediate setter's value inside its bounds) is never
    /// refused, whatever is pending; and no setter, direct, scheduled or the guardian's, reaches a value outside its
    /// bounds: each bounded field on both targets, read from the contracts, inside the bounds read from the contracts (the
    /// front door's public constants; the vault lens's MAX_REWARD_CUT_BPS, MIN_CLAIM_GAS, MAX_CLAIM_GAS; CascadeConstants'
    /// MAX_FEE_ABS; CascadeMessages' MAX_ENTRIES; the vault's internal ones the handler's, pinned by
    /// test_theVaultBoundsAreTheContracts), the per-message limits within their primary's cap.
    function invariant_boundsAlwaysHoldTighteningNeverRefused() public view {
        assertEq(handler.tighteningsRefused(), 0, "I-23: a tightening was refused");
        _assertVaultBounds();
        _assertDoorBounds();
    }

    /// @dev I-24 (spec §3.6's cancel column): the owner cancels anything, the guardian an Ordinary item only (a door's
    /// Reopen it ends only by removing that owner-removed door), nobody else anything, and nobody but the owner schedules.
    /// Every attempted cancel was judged against the table (by the owner, the sitting guardian, the stranger, the guardian
    /// the target no longer names, the pending owner's candidate and the target itself), every schedule by its caller.
    function invariant_cancelRights() public view {
        assertEq(handler.cancelViolations(), 0, "I-24: a cancel the table refuses succeeded");
        assertEq(handler.schedulesByOthers(), 0, "I-24: someone other than the owner scheduled");
    }

    /// @dev I-25: onlyScheduled and the scheduled path of onlyOwnerOrScheduled are reachable only inside execute: every
    /// such function, called directly by the owner, the guardian, the stranger, either target, was refused (NotScheduled,
    /// or the owner check), and every re-entry ProbeBridge made from inside a cap check (execute's self-call included)
    /// was refused.
    function invariant_selfCallOnlyInsideExecute() public view {
        assertEq(handler.selfCallsAdmitted(), 0, "I-25: a scheduled-only path was reached outside execute");
        assertEq(handler.reentriesAdmitted(), 0, "I-25: a re-entry reached a scheduled-only path");
    }

    /// @dev I-29: a stamp signed by the owner's key over the target's EIP-712 digest, relayed by anyone, moves the owner's
    /// clock to max(clock, asOf) and changes nothing else (the model); every one outside [asOf, asOf + STAMP_MAX_TTL],
    /// under a wrong key, a high s, a bad v or length, the other target's or another chain's domain, or StampVector's
    /// vector, is refused; a replay in its window changes nothing. A stamp kills exactly the items scheduled at or before
    /// it: after each, pending items on both sides of its asOf are executed in a snapshot and must die or live as the
    /// ghost log says. Every instrument stamps exactly the clock spec §3.6's table names, at block.timestamp, the front
    /// door's pause none, and nothing else stamps: both targets' clocks are the model's after every step.
    function invariant_stampsExactly() public view {
        assertEq(handler.stampViolations(), 0, "I-29: a stamp refused or admitted other than predicted");
        assertEq(handler.killMisses(), 0, "I-29: a stamp killed other than the items at or before its asOf");
        assertEq(handler.clockMismatch(), "", "I-29: a clock is not the one the instruments and stamps set");
    }

    /// @dev Every call refused only as its action and the model predict, as full revert data, and no predicted refusal
    /// lost.
    /// The campaign also fails on any handler call that reverts (Task 34's M6, carried to Task 42: a call a handler does
    /// not wrap in a try, whose revert the fuzzer would otherwise drop): fail-on-revert for this invariant's campaign.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_noUnexpectedReverts() public view {
        assertEq(handler.unexpectedReverts(), 0);
    }

    /// @dev Successful calls per action, and the states they ran in, to show each one is reached; asserts nothing.
    function invariant_reachabilityLogged() public {
        string[42] memory names = [
            "schedules",
            "schedulesRefused",
            "schedulesRefusedGate",
            "reschedules",
            "schedulesOrdinary",
            "schedulesGuardianSwap",
            "schedulesReopen",
            "doorItemsScheduled",
            "executes",
            "executesOfLoosenings",
            "executesRefusedNotReady",
            "executesRefusedBlocks",
            "executesRefusedLapsed",
            "executesRefusedDead",
            "executesRefusedGate",
            "executesRefusedSetter",
            "executesRefusedNoProposal",
            "executesAtWindowEnd",
            "doorItemsExecuted",
            "activationsNew",
            "activationsKnown",
            "activationsGuardianRemoved",
            "bridgeActivationsNew",
            "bridgeActivationsKnown",
            "guardianSwaps",
            "transfersExecuted",
            "directTightenings",
            "directEquals",
            "directImmediates",
            "directLooseningsRefused",
            "directBoundsRefused",
            "cancelsByOwner",
            "cancelsByGuardian",
            "cancelsRefusedGuardian",
            "cancelsRefusedOthers",
            "cancelsOfDeadItems",
            "prunes",
            "prunesRefused",
            "pausesByOwner",
            "pausesByGuardian",
            "doorPauses",
            "unpauses"
        ];
        uint256[42] memory values = [
            handler.schedules(),
            handler.schedulesRefused(),
            handler.schedulesRefusedGate(),
            handler.reschedules(),
            handler.schedulesByKind0(),
            handler.schedulesByKind1(),
            handler.schedulesByKind2(),
            handler.doorItemsScheduled(),
            handler.executes(),
            handler.executesOfLoosenings(),
            handler.executesRefusedNotReady(),
            handler.executesRefusedBlocks(),
            handler.executesRefusedLapsed(),
            handler.executesRefusedDead(),
            handler.executesRefusedGate(),
            handler.executesRefusedSetter(),
            handler.executesRefusedNoProposal(),
            handler.executesAtWindowEnd(),
            handler.doorItemsExecuted(),
            handler.activationsNew(),
            handler.activationsKnown(),
            handler.activationsGuardianRemoved(),
            handler.bridgeActivationsNew(),
            handler.bridgeActivationsKnown(),
            handler.guardianSwaps(),
            handler.transfersExecuted(),
            handler.directTightenings(),
            handler.directEquals(),
            handler.directImmediates(),
            handler.directLooseningsRefused(),
            handler.directBoundsRefused(),
            handler.cancelsByOwner(),
            handler.cancelsByGuardian(),
            handler.cancelsRefusedGuardian(),
            handler.cancelsRefusedOthers(),
            handler.cancelsOfDeadItems(),
            handler.prunes(),
            handler.prunesRefused(),
            handler.pausesByOwner(),
            handler.pausesByGuardian(),
            handler.doorPauses(),
            handler.unpauses()
        ];
        for (uint256 i; i < names.length; ++i) {
            emit log_named_uint(names[i], values[i]);
        }
        _logMore();
        _logHitTotals();
    }

    // ---- B9: the named states' minimum hits in a long run (MinimumHits) ----

    function _hitTag() internal pure override returns (string memory) {
        return "governance";
    }

    /// The ledger's named states for this campaign (the Task 34a carry: the guardian's removals of an owner-removed
    /// door and the Reopens they delete; Revision 28's window in blocks, the review's M-2: an execute that ran past
    /// its item's window in time, and a prune refused there), each with its minimum over 3,000 runs at depth 64
    /// (MinimumHits' rule: a quarter of the slowest seed's projection), re-derived with the directed halt's draw from
    /// seeds 9101, 9202 and 9303 (2026-11-14; the first two were 474 and 272, from seeds 7111, 7222 and 7333).
    function _hits() internal view override returns (Hit[] memory h) {
        h = new Hit[](4);
        h[0] = Hit("guardianRemovalsOfRemoved", handler.guardianRemovalsOfRemoved(), 381);
        h[1] = Hit("reopensDeleted", handler.reopensDeleted(), 220);
        h[2] = Hit("executesInTheBlockWindow", handler.executesInTheBlockWindow(), 265);
        h[3] = Hit("prunesRefusedInTheBlockWindow", handler.prunesRefusedInTheBlockWindow(), 176);
    }

    function _logMore() internal {
        string[44] memory names = [
            "instrumentsRefused",
            "removalsByOwner",
            "removalsByGuardian",
            "guardianRemovalsOfRemoved",
            "reopensDeleted",
            "launchHoldsByRemoval",
            "holdsConverted",
            "removalsRefused",
            "primaryDisables",
            "doorPrimaryDisables",
            "otherDisables",
            "primarySwitches",
            "switchesRefusedCap",
            "stampsRelayed",
            "stampsMovingTheClock",
            "stampsReplayed",
            "stampsOutOfWindow",
            "stampsBadSignature",
            "stampsAimedAtAnItem",
            "killProbes",
            "itemsKilledByOwner",
            "itemsKilledByGuardian",
            "itemsKilledByStamp",
            "selfCallsRefused",
            "reentryProbes",
            "reentryProbesInExecute",
            "acceptanceProbes",
            "acceptancesAdmitted",
            "redeemsQueued",
            "payoutsSent",
            "payoutsRefusedPaused",
            "payoutsRefusedDelayed",
            "payoutsRefusedDoorDown",
            "payoutsRefusedBridgeDown",
            "payoutsRefusedBothDown",
            "payoutsThroughProbe",
            "batchCancels",
            "halts",
            "stepsWithDoorItems",
            "stepsWithVaultItems",
            "stepsWithDoorClocks",
            "stepsWithDoorHold",
            "stepsWithVaultPrimaryHold",
            "stepsWithPausedBy"
        ];
        uint256[44] memory values = [
            handler.instrumentsRefused(),
            handler.removalsByOwner(),
            handler.removalsByGuardian(),
            handler.guardianRemovalsOfRemoved(),
            handler.reopensDeleted(),
            handler.launchHoldsByRemoval(),
            handler.holdsConverted(),
            handler.removalsRefused(),
            handler.primaryDisables(),
            handler.doorPrimaryDisables(),
            handler.otherDisables(),
            handler.primarySwitches(),
            handler.switchesRefusedCap(),
            handler.stampsRelayed(),
            handler.stampsMovingTheClock(),
            handler.stampsReplayed(),
            handler.stampsOutOfWindow(),
            handler.stampsBadSignature(),
            handler.stampsAimedAtAnItem(),
            handler.killProbes(),
            handler.itemsKilledByOwner(),
            handler.itemsKilledByGuardian(),
            handler.itemsKilledByStamp(),
            handler.selfCallsRefused(),
            handler.reentryProbes(),
            handler.reentryProbesInExecute(),
            handler.acceptanceProbes(),
            handler.acceptancesAdmitted(),
            handler.redeemsQueued(),
            handler.payoutsSent(),
            handler.payoutsRefusedPaused(),
            handler.payoutsRefusedDelayed(),
            handler.payoutsRefusedDoorDown(),
            handler.payoutsRefusedBridgeDown(),
            handler.payoutsRefusedBothDown(),
            handler.payoutsThroughProbe(),
            handler.batchCancels(),
            handler.halts(),
            handler.stepsWithDoorItems(),
            handler.stepsWithVaultItems(),
            handler.stepsWithDoorClocks(),
            handler.stepsWithDoorHold(),
            handler.stepsWithVaultPrimaryHold(),
            handler.stepsWithPausedBy()
        ];
        for (uint256 i; i < names.length; ++i) {
            emit log_named_uint(names[i], values[i]);
        }
        emit log_named_uint("stepsWithPendingSinceVault", handler.stepsWithPendingSinceVault());
        emit log_named_uint("stepsWithPendingSinceDoor", handler.stepsWithPendingSinceDoor());
        emit log_named_uint("runsInOneStep", handler.runsInOneStep());
        emit log_named_uint("replaysOutOfWindow", handler.replaysOutOfWindow());
        emit log_named_uint("boundsProbed", handler.boundsProbed());
        emit log_named_uint("boundsProbedAtExecute", handler.boundsProbedAtExecute());
        // the window in blocks (Revision 28): executes and refused prunes past an item's window in time, and the directed
        // halts past the window that reach them (the review's M-2)
        emit log_named_uint("haltsPastTheWindow", handler.haltsPastTheWindow());
        emit log_named_uint("executesInTheBlockWindow", handler.executesInTheBlockWindow());
        emit log_named_uint("prunesRefusedInTheBlockWindow", handler.prunesRefusedInTheBlockWindow());
        // the multi-field setters' lone loosenings, by field (Task 39a's review, C1)
        string[10] memory fields = [
            "outflowBps",
            "outflowFloor",
            "outflowGlobalBps",
            "messageEntry",
            "messageMax",
            "messageMinChunk",
            "feeBps",
            "feeAbs",
            "rewardTreasury",
            "rewardCut"
        ];
        for (uint256 i; i < 10; ++i) {
            emit log_named_uint(string.concat("directLone.", fields[i]), handler.directLone(i));
            emit log_named_uint(string.concat("executedLone.", fields[i]), handler.executedLone(i));
        }
    }

    // ---- the bounds, read from the contracts ----

    function _assertVaultBounds() internal view {
        GovernanceHandler h = handler;
        assertGe(c.vaultLens.maxDailyOutflowBps(), h.MIN_OUTFLOW_BPS(), "I-23: maxDailyOutflowBps");
        assertLe(c.vaultLens.maxDailyOutflowBps(), h.MAX_OUTFLOW_BPS(), "I-23: maxDailyOutflowBps");
        assertGe(c.vaultLens.globalOutflowBps(), h.MIN_OUTFLOW_BPS(), "I-23: globalOutflowBps");
        assertLe(c.vaultLens.globalOutflowBps(), h.MAX_OUTFLOW_BPS(), "I-23: globalOutflowBps");
        assertGe(c.vaultLens.minDailyOutflow(), h.MIN_MIN_DAILY_OUTFLOW(), "I-23: minDailyOutflow");
        assertLe(c.vaultLens.minDailyOutflow(), h.MAX_MIN_DAILY_OUTFLOW(), "I-23: minDailyOutflow");
        assertGe(c.vaultLens.maxEntryValue(), h.MIN_ENTRY_VALUE(), "I-23: maxEntryValue");
        assertLe(
            c.vaultLens.maxEntryValue(), c.vaultLens.maxMessageValue(), "I-23: maxEntryValue above maxMessageValue"
        );
        assertLe(c.vaultLens.maxMessageValue(), h.MAX_MESSAGE_VALUE(), "I-23: maxMessageValue");
        assertLe(
            c.vaultLens.maxMessageValue(),
            ICascadeBridge(c.vaultLens.primaryBridge()).maxMessageValue(),
            "I-23: maxMessageValue above the vault's primary's cap"
        );
        assertGe(c.vaultLens.minChunk(), 1, "I-23: minChunk");
        assertLe(c.vaultLens.minChunk(), CascadeMessages.MAX_ENTRIES, "I-23: minChunk");
        assertLe(c.vaultLens.maxFeeBps(), h.MAX_FEE_BPS(), "I-23: maxFeeBps");
        assertGe(c.vaultLens.maxFeeAbs(), h.MIN_FEE_ABS(), "I-23: maxFeeAbs");
        assertLe(c.vaultLens.maxFeeAbs(), MAX_FEE_ABS, "I-23: maxFeeAbs");
        assertGe(c.vaultLens.payoutDelay(), h.MIN_PAYOUT_DELAY(), "I-23: payoutDelay");
        assertLe(c.vaultLens.payoutDelay(), h.MAX_PAYOUT_DELAY(), "I-23: payoutDelay");
        assertLe(c.vaultLens.rewardCutBps(), c.vaultLens.MAX_REWARD_CUT_BPS(), "I-23: rewardCutBps");
        if (c.vaultLens.treasury() == address(0)) {
            assertEq(c.vaultLens.rewardCutBps(), 0, "I-23: a cut with no treasury");
        }
        assertGe(c.vaultLens.rewardVesting(), h.MIN_REWARD_VESTING(), "I-23: rewardVesting");
        assertLe(c.vaultLens.rewardVesting(), h.MAX_REWARD_VESTING(), "I-23: rewardVesting");
        assertLe(c.vaultLens.idleBufferBps(), h.MAX_IDLE_BUFFER_BPS(), "I-23: idleBufferBps");
        assertGe(c.vaultLens.claimGasRequired(), c.vaultLens.MIN_CLAIM_GAS(), "I-23: claimGasRequired");
        assertLe(c.vaultLens.claimGasRequired(), c.vaultLens.MAX_CLAIM_GAS(), "I-23: claimGasRequired");
        assertLe(c.vaultLens.hotkeyDustRao(), h.MAX_HOTKEY_DUST_RAO(), "I-23: hotkeyDustRao");
        assertLe(c.vaultLens.unstakeMarginRao(), h.MAX_UNSTAKE_MARGIN_RAO(), "I-23: unstakeMarginRao");
        assertGe(c.vaultLens.unstakeGas(), h.MIN_UNSTAKE_GAS(), "I-23: unstakeGas");
        assertLe(c.vaultLens.unstakeGas(), h.MAX_UNSTAKE_GAS(), "I-23: unstakeGas");
    }

    function _assertDoorBounds() internal view {
        CascadeFrontDoor fd = c.fd;
        assertLe(fd.maxDeliverySlippageBps(), fd.MAX_DELIVERY_SLIPPAGE_BPS(), "I-23: maxDeliverySlippageBps");
        assertLe(fd.batchInterval(), fd.MAX_BATCH_INTERVAL(), "I-23: batchInterval");
        assertLe(fd.maxBatchValue(), fd.MAX_BATCH_VALUE(), "I-23: maxBatchValue");
        assertLe(
            fd.maxBatchValue(),
            ICascadeBridge(c.doorLens.primaryBridge()).maxMessageValue(),
            "I-23: maxBatchValue above the front door's primary's cap"
        );
        assertGe(fd.minDeposit(), fd.MIN_DEPOSIT_FLOOR(), "I-23: minDeposit");
        assertLe(fd.minDeposit(), fd.MAX_BATCH_VALUE(), "I-23: minDeposit's ceiling");
        assertGe(fd.maxDeposits(), 1, "I-23: maxDeposits");
        assertLe(fd.maxDeposits(), CascadeMessages.MAX_ENTRIES, "I-23: maxDeposits");
        assertGe(fd.maxRedeems(), 1, "I-23: maxRedeems");
        assertLe(fd.maxRedeems(), CascadeMessages.MAX_ENTRIES, "I-23: maxRedeems");
        assertLe(fd.redeemRequestFee(), fd.MAX_REDEEM_REQUEST_FEE(), "I-23: redeemRequestFee");
    }

    // ---- pins ----

    uint8 constant V = 0;
    uint8 constant D = 1;

    function _assertAll() internal view {
        invariant_noEffectWithoutScheduledOpenUnstamped();
        invariant_boundsAlwaysHoldTighteningNeverRefused();
        invariant_cancelRights();
        invariant_selfCallOnlyInsideExecute();
        invariant_stampsExactly();
        invariant_noUnexpectedReverts();
        invariant_tokenAccounting();
        invariant_aPendingReopenNamesARemovedDoor();
    }

    /// A stamp scheduled at t0 and an item a second later: a stamp as of t0 kills the first and spares the second, and
    /// the handler's snapshot probes (one each side of asOf) agree; once ready, the first refuses ExitsNotOpen and the
    /// second runs. The front door's items and clock are non-zero along the way (both lenses compared at each step).
    function test_aStampKillsExactlyTheItemsAtOrBeforeIt() public {
        bytes memory first = abi.encodeCall(CascadeFrontDoor.setBatchInterval, (6 hours));
        bytes memory second = abi.encodeCall(CascadeFrontDoor.setMaxDeliverySlippage, (200));
        uint64 t0 = uint64(vm.getBlockTimestamp());
        uint256 schedules0 = handler.schedules();
        uint256 executes0 = handler.executes();
        handler.pinSchedule(D, first);
        handler.pinWarp(1);
        handler.pinSchedule(D, second);
        assertEq(handler.schedules(), schedules0 + 2);
        handler.pinStamp(D, t0);
        assertEq(c.doorLens.lastOwnerClose(), t0, "the stamp moved the front door's clock");
        assertEq(handler.killProbes(), 2, "a probe each side of asOf");
        assertEq(handler.itemsKilledByStamp(), 1, "exactly the item at asOf");
        handler.pinExecute(D, first, 1);
        assertEq(handler.executesRefusedDead(), 1, "the item at asOf is dead");
        handler.pinExecute(D, second, 1);
        assertEq(handler.executes(), executes0 + 1, "the item after asOf runs");
        assertEq(c.fd.maxDeliverySlippageBps(), 200);
        assertEq(c.fd.batchInterval(), 12 hours, "the dead item changed nothing");
        _assertAll();
    }

    /// Spec §3.6, Task 10b, through the handler: with a second launch-chain door activated, the owner removes it
    /// (nothing closes: the launch door is still active) and then the launch door (the launch chain's last: its hold, its
    /// clock), schedules the launch door's Reopen, and the guardian's removal of the Removed launch door deletes the
    /// Reopen (Cancelled by the guardian), makes the door Unknown and the launch door's hold the guardian's, stamping the
    /// guardian's clock.
    function test_theGuardiansRemovalOfAnOwnerRemovedDoorDeletesItsReopen() public {
        bytes memory door3 = abi.encodeCall(CascadeVault.activateFrontDoor, (BASE, g.door3));
        handler.pinSchedule(V, door3);
        handler.pinExecute(V, door3, 1);
        assertEq(handler.activationsNew(), 1);
        assertEq(c.vaultLens.activeDoors(BASE), 2);
        uint64 ownerClock = c.vaultLens.lastOwnerClose();
        handler.pinRemove(1, owner);
        assertEq(uint8(c.vaultLens.launchDoorRemovedBy()), uint8(Actor.None), "the launch door is still active");
        assertEq(c.vaultLens.lastOwnerClose(), ownerClock, "nothing stamped");
        handler.pinWarp(1);
        handler.pinRemove(0, owner);
        assertEq(uint8(c.vaultLens.launchDoorRemovedBy()), uint8(Actor.Owner));
        assertEq(handler.launchHoldsByRemoval(), 1);
        handler.pinWarp(1);
        bytes memory reopen = abi.encodeCall(CascadeVault.activateFrontDoor, (BASE, address(c.fd)));
        handler.pinSchedule(V, reopen);
        assertEq(uint8(c.vaultLens.scheduled(keccak256(reopen)).kind), uint8(Kind.Reopen));
        handler.pinWarp(1);
        handler.pinRemove(0, guardian);
        assertEq(handler.guardianRemovalsOfRemoved(), 1);
        assertEq(handler.reopensDeleted(), 1);
        assertEq(handler.holdsConverted(), 1);
        assertEq(c.vaultLens.scheduled(keccak256(reopen)).readyAt, 0, "the Reopen is gone");
        assertEq(uint8(c.vaultLens.launchDoorRemovedBy()), uint8(Actor.Guardian));
        assertEq(c.vaultLens.lastGuardianClose(), vm.getBlockTimestamp());
        _assertAll();
    }

    /// M-4's order: a launch-door payout with the door removed and the vault's primary disabled refuses
    /// FrontDoorInactive, the door's refusal, before the bridge's; with only the bridge down, PrimaryBridgeDisabled.
    function test_aPayoutRefusesTheDoorBeforeTheBridge() public {
        handler.queueRedeem(_seed("redeem", 50, 9));
        assertEq(handler.redeemsQueued(), 1);
        handler.pinDisable(V, 0, guardian);
        uint256 waitSeed = _seed("wait", 3, 1);
        handler.processPayouts(waitSeed);
        assertEq(handler.payoutsRefusedBridgeDown(), 1, "the bridge alone: PrimaryBridgeDisabled");
        handler.pinWarp(1);
        handler.pinRemove(0, owner);
        handler.processPayouts(waitSeed);
        assertEq(handler.payoutsRefusedBothDown(), 1, "both down: FrontDoorInactive first");
        // paused: the vault's own refusal comes first (EnforcedPause); the owner's cancel of the batch is an instrument,
        // stamping the owner's clock, paused or not
        handler.pinPause(V, guardian);
        handler.processPayouts(waitSeed);
        assertEq(handler.payoutsRefusedPaused(), 1, "paused: EnforcedPause");
        handler.cancelBatch(0, _seed("batch canceller", 4, 1));
        assertEq(handler.batchCancels(), 1);
        assertEq(c.vaultLens.lastOwnerClose(), vm.getBlockTimestamp());
        _assertAll();
    }

    /// I-25's re-entrant path, inside execute: the probe (activated in the setUp) becomes the vault's primary (the
    /// primary disabled, then the switch, whose cap check the probe re-enters), then a scheduled setMessageLimits runs and
    /// its cap check calls the probe from execute's self-call; every re-entry is refused and the item runs.
    function test_aReentryFromInsideExecuteIsRefused() public {
        assertTrue(c.vaultLens.bridgeEnabled(address(g.probe)), "the setUp's activation");
        handler.queueRedeem(_seed("redeem", 50, 9));
        assertEq(handler.redeemsQueued(), 1);
        handler.pinDisable(V, 0, owner);
        handler.pinWarp(1);
        handler.pinSetPrimary(V, 2);
        assertEq(c.vaultLens.primaryBridge(), address(g.probe));
        assertEq(handler.reentryProbes(), 1, "the switch's cap check re-entered");
        bytes memory looser = abi.encodeCall(CascadeVault.setMessageLimits, (2_000e18, 4_500e18, 1));
        handler.pinSchedule(V, looser);
        // the probe calls the vault's scheduled-only functions from inside execute's self-call
        vm.expectCall(address(c.vault), abi.encodeCall(CascadeBase.setGuardian, (address(0xdead))));
        handler.pinExecute(V, looser, 1);
        assertEq(handler.reentryProbesInExecute(), 1);
        assertEq(c.vaultLens.maxMessageValue(), 4_500e18, "the item ran");
        // the payout goes out through the probe, a plain bridge to the vault
        handler.processPayouts(_seed("wait", 3, 1));
        assertEq(handler.payoutsThroughProbe(), 1);
        assertEq(g.probe.sends(), 1);
        _assertAll();
    }

    /// Spec §3.9 through the instruments: a new bridge with a smaller cap (bridge2, 1,000 TAO) cannot become the vault's
    /// primary while the vault's maxMessageValue (4,000 TAO) is above it (AboveBridgeCap); once the owner has tightened
    /// to it, at once, the switch goes through and clears the owner's hold. A loosening above the new primary's cap then
    /// refuses AboveBridgeCap at execute, and the item stays.
    function test_aSmallerCapBecomesPrimaryOnceTightened() public {
        bytes memory activation = abi.encodeCall(CascadeBase.activateBridge, (address(g.bridge2)));
        handler.pinSchedule(V, activation);
        handler.pinExecute(V, activation, 1);
        assertEq(handler.bridgeActivationsNew(), 1);
        handler.pinDisable(V, 0, owner);
        handler.pinWarp(1);
        handler.pinSetPrimary(V, 1);
        assertEq(handler.switchesRefusedCap(), 1, "above the new bridge's cap");
        handler.pinDirect(V, abi.encodeCall(CascadeVault.setMessageLimits, (1_000e18, 1_000e18, 1)));
        assertEq(handler.directTightenings(), 1, "the tightening, at once, with the exits closed");
        handler.pinSetPrimary(V, 1);
        assertEq(c.vaultLens.primaryBridge(), address(g.bridge2));
        assertEq(uint8(c.vaultLens.primaryDisabledBy()), uint8(Actor.None), "the switch cleared the hold");
        bytes memory looser = abi.encodeCall(CascadeVault.setMessageLimits, (1_000e18, 1_001e18, 1));
        handler.pinSchedule(V, looser);
        handler.pinExecute(V, looser, 1);
        assertEq(handler.executesRefusedSetter(), 1, "AboveBridgeCap at execute");
        assertEq(c.vaultLens.scheduled(keccak256(looser)).readyAt != 0, true, "the item stays");
        _assertAll();
    }

    /// I-29's replay (spec §3.6, §3.10.7: no nonce, a replay changes nothing and emits again): the owner's stamp relayed
    /// once moves the clock; an item scheduled after its asOf; the same stamp relayed again by another account is
    /// accepted, logs exactly one StampedBySig (its asOf and its relayer) and nothing else, moves none of the four clocks,
    /// leaves the item as it was, and the item still runs.
    function test_aReplayIsAcceptedAndChangesNothing() public {
        uint64 asOf = uint64(vm.getBlockTimestamp());
        handler.pinStamp(V, asOf);
        assertEq(c.vaultLens.lastOwnerClose(), asOf);
        handler.pinWarp(1);
        bytes memory item = abi.encodeCall(CascadeVault.setPayoutDelay, (12 hours));
        handler.pinSchedule(V, item);
        handler.pinWarp(1 hours);
        Item memory before = c.vaultLens.scheduled(keccak256(item));
        uint64[4] memory clocks = _clocks();
        handler.setKeepLogs(true);
        handler.pinReplay(V, asOf, guardian);
        Vm.Log[] memory logs = handler.stepLogs();
        handler.setKeepLogs(false);
        assertEq(handler.stampsRelayed(), 2, "both relays accepted");
        assertEq(handler.stampsReplayed(), 1);
        assertEq(logs.length, 1, "one log, and nothing else");
        assertEq(logs[0].emitter, address(c.vault));
        assertEq(logs[0].topics[0], StampedBySig.selector);
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(guardian))), "its relayer");
        assertEq(abi.decode(logs[0].data, (uint64)), asOf);
        uint64[4] memory after_ = _clocks();
        for (uint256 i; i < 4; ++i) {
            assertEq(after_[i], clocks[i], "no clock moved");
        }
        Item memory then = c.vaultLens.scheduled(keccak256(item));
        assertEq(abi.encode(then), abi.encode(before), "the item is as it was");
        uint256 executes0 = handler.executes();
        handler.pinExecute(V, item, 1);
        assertEq(handler.executes(), executes0 + 1, "the item after asOf still runs");
        _assertAll();
    }

    /// I-29's "nothing else stamps" for the disable instrument: a bridge that is enabled and not the primary (the probe),
    /// disabled by the owner on the vault and by the guardian on the front door, records no hold, logs no ExitsClosed and
    /// moves none of the four clocks; the exits stay open.
    function test_aDisableOfAnotherBridgeStampsNothing() public {
        uint64[4] memory clocks = _clocks();
        handler.pinDisable(V, 2, owner);
        handler.pinDisable(D, 2, guardian);
        assertEq(handler.otherDisables(), 2);
        assertFalse(c.vaultLens.bridgeEnabled(address(g.probe)));
        assertFalse(c.doorLens.bridgeEnabled(address(g.probe)));
        uint64[4] memory after_ = _clocks();
        for (uint256 i; i < 4; ++i) {
            assertEq(after_[i], clocks[i], "no clock moved");
        }
        assertEq(uint8(c.vaultLens.primaryDisabledBy()), uint8(Actor.None));
        assertEq(uint8(c.doorLens.primaryDisabledBy()), uint8(Actor.None));
        assertTrue(c.vaultLens.exitsOpen() && c.doorLens.exitsOpen(), "the exits stay open");
        _assertAll();
    }

    /// Both targets' clocks: the vault's owner and guardian clocks, then the front door's.
    function _clocks() internal view returns (uint64[4] memory k) {
        k = [
            c.vaultLens.lastOwnerClose(),
            c.vaultLens.lastGuardianClose(),
            c.doorLens.lastOwnerClose(),
            c.doorLens.lastGuardianClose()
        ];
    }

    /// Every stamp form, on both targets: the stack, a replay, the window's edges, a future one, and each bad signature
    /// (a wrong key, the high-s twin, a bad v, a bad length, the other target's domain, another chain's, the vector),
    /// each judged in stampBySig's order.
    function test_everyStampFormIsJudged() public {
        handler.warp(_seed("warp", 8, 3));
        for (uint256 m; m < 16; ++m) {
            uint256 s = _seed("stamp", 20, m);
            handler.relayStamp(m, s, m);
        }
        assertGe(handler.stampsBadSignature(), 7, "the seven bad signatures");
        assertGe(handler.stampsOutOfWindow(), 2, "a day and a second old, and a second ahead");
        assertGe(handler.stampsRelayed(), 4);
        _assertAll();
    }

    /// I-25, every path from every actor: each scheduled-only function and each owner setter's scheduled path (a strict
    /// loosening) on both targets, called directly by the owner, the guardian, the stranger, the target itself and the
    /// other target, is refused (the vault's setIdleBuffer has no strict loosening at its launch value 0, and is skipped).
    function test_everyScheduledOnlyPathIsRefusedDirectly() public {
        uint256 tried;
        for (uint8 t; t < 2; ++t) {
            uint256 targetSeed = _seed("self target", 2, t);
            uint256 n = t == V ? 15 : 9;
            for (uint256 k; k < n; ++k) {
                if (t == V && k == 13) continue;
                uint256 fnSeed = _seed("fn", n, k);
                for (uint256 a; a < 5; ++a) {
                    handler.selfCall(targetSeed, fnSeed, _seed("self actor", 5, a));
                    ++tried;
                }
            }
        }
        assertEq(tried, 5 * (14 + 9));
        assertEq(handler.selfCallsRefused(), tried, "every direct call refused as predicted");
        assertEq(handler.selfCallsAdmitted(), 0);
        _assertAll();
    }

    /// The checks bite: an owner's tightening outside the handler is an effect no handler call explains (I-22's model),
    /// an owner's cancel outside it leaves a lens without the ghost log's item, and a stamp relayed outside it moves a
    /// clock the model does not (I-29).
    function test_theChecksCanFail() public {
        bytes memory item = abi.encodeCall(CascadeFrontDoor.setBatchInterval, (6 hours));
        handler.pinSchedule(D, item);
        vm.prank(owner);
        c.fd.cancel(keccak256(item));
        assertTrue(bytes(handler.ghostMismatch()).length != 0, "the ghost log sees the foreign cancel");
        vm.expectRevert();
        this.invariant_noEffectWithoutScheduledOpenUnstamped();
        vm.prank(owner);
        c.fd.setBatchInterval(13 hours);
        assertTrue(bytes(handler.modelMismatch()).length != 0, "the model sees the foreign tightening");
        stampAt(c.vault, uint64(vm.getBlockTimestamp()));
        assertTrue(bytes(handler.clockMismatch()).length != 0, "the model sees the foreign stamp");
        vm.expectRevert();
        this.invariant_stampsExactly();
    }

    /// The vault's internal bounds the handler copies are the contract's: each is accepted at the bound (a loosening
    /// through its scheduled item) and refused one past it, directly or at execute.
    function test_theVaultBoundsAreTheContracts() public {
        GovernanceHandler h = handler;
        CascadeVault v = c.vault;
        uint256 bps = c.vaultLens.maxDailyOutflowBps();
        uint256 floor = c.vaultLens.minDailyOutflow();
        uint256 gbps = c.vaultLens.globalOutflowBps();
        _bound(v, abi.encodeCall(CascadeVault.setPayoutDelay, (uint64(h.MIN_PAYOUT_DELAY()))), bytes4(0));
        _bound(
            v,
            abi.encodeCall(CascadeVault.setPayoutDelay, (uint64(h.MIN_PAYOUT_DELAY() - 1))),
            InvalidParameter.selector
        );
        _bound(v, abi.encodeCall(CascadeVault.setPayoutDelay, (uint64(h.MAX_PAYOUT_DELAY()))), bytes4(0));
        _bound(
            v,
            abi.encodeCall(CascadeVault.setPayoutDelay, (uint64(h.MAX_PAYOUT_DELAY() + 1))),
            InvalidParameter.selector
        );
        _bound(v, abi.encodeCall(CascadeVault.setOutflowLimits, (h.MIN_OUTFLOW_BPS(), floor, gbps)), bytes4(0));
        _bound(
            v,
            abi.encodeCall(CascadeVault.setOutflowLimits, (h.MIN_OUTFLOW_BPS() - 1, floor, gbps)),
            InvalidParameter.selector
        );
        _bound(v, abi.encodeCall(CascadeVault.setOutflowLimits, (h.MAX_OUTFLOW_BPS(), floor, gbps)), bytes4(0));
        _bound(
            v,
            abi.encodeCall(CascadeVault.setOutflowLimits, (h.MAX_OUTFLOW_BPS() + 1, floor, gbps)),
            InvalidParameter.selector
        );
        _bound(v, abi.encodeCall(CascadeVault.setOutflowLimits, (bps, h.MIN_MIN_DAILY_OUTFLOW(), gbps)), bytes4(0));
        _bound(
            v,
            abi.encodeCall(CascadeVault.setOutflowLimits, (bps, h.MIN_MIN_DAILY_OUTFLOW() - 1, gbps)),
            InvalidParameter.selector
        );
        _bound(v, abi.encodeCall(CascadeVault.setOutflowLimits, (bps, h.MAX_MIN_DAILY_OUTFLOW(), gbps)), bytes4(0));
        _bound(
            v,
            abi.encodeCall(CascadeVault.setOutflowLimits, (bps, h.MAX_MIN_DAILY_OUTFLOW() + 1, gbps)),
            InvalidParameter.selector
        );
        _bound(
            v,
            abi.encodeCall(CascadeVault.setOutflowLimits, (bps, floor, h.MIN_OUTFLOW_BPS() - 1)),
            InvalidParameter.selector
        );
        _bound(
            v,
            abi.encodeCall(CascadeVault.setOutflowLimits, (bps, floor, h.MAX_OUTFLOW_BPS() + 1)),
            InvalidParameter.selector
        );
        uint256 msgv = c.vaultLens.maxMessageValue();
        _bound(v, abi.encodeCall(CascadeVault.setMessageLimits, (h.MIN_ENTRY_VALUE(), msgv, 1)), bytes4(0));
        _bound(
            v,
            abi.encodeCall(CascadeVault.setMessageLimits, (h.MIN_ENTRY_VALUE() - 1, msgv, 1)),
            InvalidParameter.selector
        );
        _bound(
            v, abi.encodeCall(CascadeVault.setMessageLimits, (h.MIN_ENTRY_VALUE(), h.MAX_MESSAGE_VALUE(), 1)), bytes4(0)
        );
        _bound(
            v,
            abi.encodeCall(CascadeVault.setMessageLimits, (h.MIN_ENTRY_VALUE(), h.MAX_MESSAGE_VALUE() + 1, 1)),
            InvalidParameter.selector
        );
        _bound(
            v, abi.encodeCall(CascadeVault.setMessageLimits, (h.MIN_ENTRY_VALUE(), msgv, 0)), InvalidParameter.selector
        );
        _bound(v, abi.encodeCall(CascadeVault.setMessageLimits, (h.MIN_ENTRY_VALUE(), msgv, 50)), bytes4(0));
        _bound(
            v, abi.encodeCall(CascadeVault.setMessageLimits, (h.MIN_ENTRY_VALUE(), msgv, 51)), InvalidParameter.selector
        );
        _bound(v, abi.encodeCall(CascadeVault.setFeeLimits, (h.MAX_FEE_BPS(), MAX_FEE_ABS)), bytes4(0));
        _bound(
            v, abi.encodeCall(CascadeVault.setFeeLimits, (h.MAX_FEE_BPS() + 1, MAX_FEE_ABS)), InvalidParameter.selector
        );
        _bound(v, abi.encodeCall(CascadeVault.setFeeLimits, (0, h.MIN_FEE_ABS())), bytes4(0));
        _bound(v, abi.encodeCall(CascadeVault.setFeeLimits, (0, h.MIN_FEE_ABS() - 1)), InvalidParameter.selector);
        _bound(v, abi.encodeCall(CascadeVault.setFeeLimits, (0, MAX_FEE_ABS + 1)), InvalidParameter.selector);
        _bound(v, abi.encodeCall(CascadeVault.setRewardVesting, (uint64(h.MIN_REWARD_VESTING()))), bytes4(0));
        _bound(
            v,
            abi.encodeCall(CascadeVault.setRewardVesting, (uint64(h.MIN_REWARD_VESTING() - 1))),
            InvalidParameter.selector
        );
        _bound(v, abi.encodeCall(CascadeVault.setRewardVesting, (uint64(h.MAX_REWARD_VESTING()))), bytes4(0));
        _bound(
            v,
            abi.encodeCall(CascadeVault.setRewardVesting, (uint64(h.MAX_REWARD_VESTING() + 1))),
            InvalidParameter.selector
        );
        _bound(v, abi.encodeCall(CascadeVault.setIdleBuffer, (h.MAX_IDLE_BUFFER_BPS())), bytes4(0));
        _bound(v, abi.encodeCall(CascadeVault.setIdleBuffer, (h.MAX_IDLE_BUFFER_BPS() + 1)), InvalidParameter.selector);
        _bound(v, abi.encodeCall(CascadeVault.setUnstakeMarginRao, (h.MAX_UNSTAKE_MARGIN_RAO())), bytes4(0));
        _bound(
            v,
            abi.encodeCall(CascadeVault.setUnstakeMarginRao, (h.MAX_UNSTAKE_MARGIN_RAO() + 1)),
            InvalidParameter.selector
        );
        _bound(v, abi.encodeCall(CascadeVault.setUnstakeGas, (h.MIN_UNSTAKE_GAS())), bytes4(0));
        _bound(v, abi.encodeCall(CascadeVault.setUnstakeGas, (h.MIN_UNSTAKE_GAS() - 1)), InvalidParameter.selector);
        _bound(v, abi.encodeCall(CascadeVault.setUnstakeGas, (h.MAX_UNSTAKE_GAS())), bytes4(0));
        _bound(v, abi.encodeCall(CascadeVault.setUnstakeGas, (h.MAX_UNSTAKE_GAS() + 1)), InvalidParameter.selector);
        _bound(v, abi.encodeCall(CascadeVault.setHotkeyDustRao, (h.MAX_HOTKEY_DUST_RAO())), bytes4(0));
        _bound(
            v, abi.encodeCall(CascadeVault.setHotkeyDustRao, (h.MAX_HOTKEY_DUST_RAO() + 1)), InvalidParameter.selector
        );
    }

    /// Asserts the owner's `data` on `t` takes effect (`refusal` 0) or is refused with exactly `refusal` (Task 39a's review,
    /// M3: the bound's own error, so a value refused for another reason, such as the launch rail's cap, does not pass for
    /// the bound): called directly, or, when it loosens (NotScheduled), scheduled and executed once ready. In a
    /// snapshot, reverted after.
    function _bound(CascadeBase t, bytes memory data, bytes4 refusal) internal {
        uint256 snap = vm.snapshotState();
        vm.prank(owner);
        (bool ok, bytes memory reason) = address(t).call(data);
        if (!ok && bytes4(reason) == NotScheduled.selector) {
            sched(t, data);
            (ok, reason) = _execAfterOrFail(t, data);
        }
        vm.revertToState(snap);
        string memory what = string.concat("the bound: ", vm.toString(data));
        if (refusal == 0) {
            assertTrue(ok, what);
        } else {
            assertFalse(ok, what);
            assertEq(reason, abi.encodeWithSelector(refusal), what);
        }
    }

    /// execAfter, returning the execute's outcome instead of reverting.
    function _execAfterOrFail(CascadeBase t, bytes memory data) internal returns (bool ok, bytes memory reason) {
        Item memory it = address(t) == address(c.vault)
            ? c.vaultLens.scheduled(keccak256(data))
            : c.doorLens.scheduled(keccak256(data));
        vm.warp(it.readyAt);
        vm.roll(it.readyBlock);
        vm.prank(owner);
        (ok, reason) = address(t).call(abi.encodeCall(CascadeBase.execute, (data)));
    }
}
