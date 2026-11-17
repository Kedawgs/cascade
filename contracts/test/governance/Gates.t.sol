// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Actor, Item, Kind} from "../../src/CascadeTypes.sol";
import {
    BridgeNotEnabled,
    ExitsNotOpen,
    InvalidParameter,
    NotCanceller,
    NotGuardian,
    PrimaryStillEnabled
} from "../../src/CascadeErrors.sol";
import {CascadeFormulas} from "../../src/libraries/CascadeFormulas.sol";
import {
    BridgeActivated,
    BridgeDisabled,
    Executed,
    ExitsClosed,
    ExitsReopened,
    PrimaryBridgeSet
} from "../../src/CascadeEvents.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {FrontDoorTestBase} from "../FrontDoorTestBase.sol";
import {StubBridge} from "../mocks/StubBridge.sol";
import {SchedulerHarness} from "./SchedulerHarness.sol";
import {Schedule} from "./Schedule.sol";

/// Clocks, holds and gates (spec §3.6; I-26 to I-29 in part) on SchedulerHarness. The primary bridge's
/// disable is the base's one recording instrument: it records its actor and stamps that actor's clock.
/// The gates, at schedule and at execute: Ordinary needs exitsOpen(), GuardianSwap !ownerHold(), Reopen
/// nothing. The clocks: Ordinary max(lastOwnerClose, lastGuardianClose), the others lastOwnerClose;
/// schedule needs the clock older than block.timestamp, execute older than the item's scheduledAt. Every
/// refusal is ExitsNotOpen. The harness's guardianInstrument and ownerInstrument stamp a clock and record
/// nothing (ruling B4), so a clock is tested apart from a hold; its forceHold records a hold without its
/// stamp (unreachable through the API), so the gate at execute is tested apart from the clock.
contract GatesTest is Test {
    SchedulerHarness h;
    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address bridge = makeAddr("bridge");
    address bridge2 = makeAddr("bridge2");
    address bridge3 = makeAddr("bridge3");
    address stranger = makeAddr("stranger");
    address safe = makeAddr("safe");
    address guardian2 = makeAddr("guardian2");

    function setUp() public {
        Schedule.warpTo(1_000_000);
        h = new SchedulerHarness(owner, guardian, bridge);
    }

    // ---- helpers ----

    function knob(uint256 v) internal view returns (bytes memory) {
        return abi.encodeCall(h.setKnob, (v));
    }

    function activation(address b) internal view returns (bytes memory) {
        return abi.encodeCall(h.activateBridge, (b));
    }

    function swap(address g) internal view returns (bytes memory) {
        return abi.encodeCall(h.setGuardian, (g));
    }

    function transfer(address to) internal view returns (bytes memory) {
        return abi.encodeCall(h.transferOwnership, (to));
    }

    function sched(bytes memory data) internal returns (bytes32 id) {
        vm.prank(owner);
        id = h.schedule(data);
    }

    function exec(bytes memory data) internal {
        vm.prank(owner);
        h.execute(data);
    }

    function now_() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
    }

    function warpBy(uint256 s) internal {
        Schedule.warpTo(vm.getBlockTimestamp() + s);
    }

    function fresh() internal {
        h = new SchedulerHarness(owner, guardian, bridge);
    }

    /// The owner's schedule of `data` reverts ExitsNotOpen and leaves its id's item as it was.
    function assertScheduleRefused(bytes memory data) internal {
        bytes32 id = keccak256(data);
        Item memory before = h.item(id);
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        h.schedule(data);
        assertSameItem(id, before);
    }

    /// The owner's execute of `data`, scheduled and ready, reverts ExitsNotOpen and leaves the item.
    function assertExecuteRefused(bytes memory data) internal {
        bytes32 id = keccak256(data);
        Item memory before = h.item(id);
        assertGt(before.readyAt, 0, "an item is scheduled");
        assertLe(before.readyAt, now_(), "the item is ready");
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        h.execute(data);
        assertSameItem(id, before);
    }

    function assertSameItem(bytes32 id, Item memory want) internal view {
        Item memory got = h.item(id);
        assertEq(got.scheduledAt, want.scheduledAt, "scheduledAt");
        assertEq(got.readyAt, want.readyAt, "readyAt");
        assertEq(uint8(got.kind), uint8(want.kind), "kind");
        assertEq(got.selector, want.selector, "selector");
    }

    /// The recorded hold `by`, the holds and exitsOpen() it gives, and both clocks; and the hold is
    /// recorded exactly while the primary is disabled.
    function assertHolds(Actor by, uint64 ownerClock, uint64 guardianClock) internal view {
        assertEq(uint8(h.exposed_primaryDisabledBy()), uint8(by), "primaryDisabledBy");
        assertEq(h.exposed_ownerHold(), by == Actor.Owner, "ownerHold");
        assertEq(h.exposed_guardianHold(), by == Actor.Guardian, "guardianHold");
        assertEq(h.exposed_exitsOpen(), by == Actor.None, "exitsOpen");
        assertEq(h.exposed_lastOwnerClose(), ownerClock, "lastOwnerClose");
        assertEq(h.exposed_lastGuardianClose(), guardianClock, "lastGuardianClose");
        assertEq(h.exposed_bridgeEnabled(h.exposed_primaryBridge()), by == Actor.None, "the primary is disabled");
    }

    // ---- the instrument: the primary's disable ----

    /// The primary's disable records its actor, stamps that actor's clock at block.timestamp and only it,
    /// and emits ExitsClosed(actor, disableBridge.selector): exits are no longer open. Each actor on a fresh
    /// harness; a stranger plays nothing.
    function test_disablingThePrimaryRecordsAndStampsItsActor() public {
        assertHolds(Actor.None, 0, 0);
        warpBy(1 days);
        uint64 t = now_();
        vm.expectEmit(address(h));
        emit BridgeDisabled(bridge);
        vm.expectEmit(address(h));
        emit ExitsClosed(guardian, h.disableBridge.selector);
        vm.prank(guardian);
        h.disableBridge(bridge);
        assertHolds(Actor.Guardian, 0, t);
        assertFalse(h.exposed_exitsOpen());

        fresh();
        warpBy(1 hours);
        t = now_();
        vm.expectEmit(address(h));
        emit BridgeDisabled(bridge);
        vm.expectEmit(address(h));
        emit ExitsClosed(owner, h.disableBridge.selector);
        vm.prank(owner);
        h.disableBridge(bridge);
        assertHolds(Actor.Owner, t, 0);
        assertFalse(h.exposed_exitsOpen());

        fresh();
        vm.prank(stranger);
        vm.expectRevert(NotGuardian.selector);
        h.disableBridge(bridge);
        assertHolds(Actor.None, 0, 0);
    }

    /// Disabling a bridge that is not the primary is no instrument: BridgeDisabled alone, no record, no
    /// stamp; exits stay open and every pending item lives.
    function test_disablingAnotherBridgeStampsNothing() public {
        Schedule.run(h, owner, activation(bridge2));
        Schedule.run(h, owner, activation(bridge3));
        sched(knob(5));
        sched(swap(guardian2));
        warpBy(1 hours);

        address[2] memory actors = [guardian, owner];
        address[2] memory others = [bridge2, bridge3];
        for (uint256 i; i < 2; ++i) {
            vm.recordLogs();
            vm.prank(actors[i]);
            h.disableBridge(others[i]);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            assertEq(logs.length, 1, "one event");
            assertEq(logs[0].topics[0], BridgeDisabled.selector);
            assertFalse(h.exposed_bridgeEnabled(others[i]));
            assertHolds(Actor.None, 0, 0);
        }

        warpBy(48 hours);
        exec(knob(5));
        assertEq(h.knob(), 5);
        warpBy(6 days);
        exec(swap(guardian2));
        assertEq(h.exposed_guardian(), guardian2);
    }

    /// The base's pause and unpause record and stamp nothing (the front door's pause, spec §3.6; the vault
    /// overrides them in Task 10): exits stay open and a pending item lives.
    function test_basePauseAndUnpauseStampNothing() public {
        sched(knob(5));
        address[2] memory pausers = [guardian, owner];
        for (uint256 i; i < 2; ++i) {
            warpBy(1 hours);
            vm.prank(pausers[i]);
            h.pause();
            assertTrue(h.paused());
            assertHolds(Actor.None, 0, 0);
            warpBy(1 hours);
            vm.prank(owner);
            h.unpause();
            assertHolds(Actor.None, 0, 0);
        }
        warpBy(48 hours);
        exec(knob(5));
        assertEq(h.knob(), 5);
    }

    // ---- the gates ----

    /// Ordinary items need exitsOpen() at schedule and at execute. Under either actor's hold of the primary,
    /// even with its clock a day old, none can be scheduled (a loosening, a new bridge's activation, an
    /// ownership transfer); the primary's Reopen clears the hold and they schedule. At execute: items
    /// scheduled while open are refused under either hold (recorded without its stamp, so only the gate
    /// refuses them), and run once it is gone.
    function test_ordinaryNeedsOpenAtBothEnds() public {
        bytes[3] memory ordinaries = [knob(5), activation(bridge2), transfer(safe)];
        address[2] memory actors = [guardian, owner];
        for (uint256 i; i < 2; ++i) {
            fresh();
            vm.prank(actors[i]);
            h.disableBridge(bridge);
            warpBy(1 days);
            for (uint256 j; j < ordinaries.length; ++j) {
                assertScheduleRefused(ordinaries[j]);
                assertEq(h.item(keccak256(ordinaries[j])).readyAt, 0);
            }
            Schedule.run(h, owner, activation(bridge));
            assertTrue(h.exposed_exitsOpen());
            for (uint256 j; j < ordinaries.length; ++j) {
                sched(ordinaries[j]);
            }
        }

        fresh();
        for (uint256 j; j < ordinaries.length; ++j) {
            sched(ordinaries[j]);
        }
        warpBy(8 days);
        Actor[2] memory holds = [Actor.Guardian, Actor.Owner];
        for (uint256 i; i < 2; ++i) {
            h.forceHold(holds[i]);
            assertFalse(h.exposed_exitsOpen());
            for (uint256 j; j < ordinaries.length; ++j) {
                assertExecuteRefused(ordinaries[j]);
            }
        }
        h.forceHold(Actor.None);
        for (uint256 j; j < ordinaries.length; ++j) {
            exec(ordinaries[j]);
        }
        assertEq(h.knob(), 5);
        assertTrue(h.exposed_bridgeEnabled(bridge2));
        assertEq(h.pendingOwner(), safe);
    }

    /// An Ordinary item dies when either actor's clock reaches its scheduledAt, with no hold (the harness's
    /// instruments stamp and record nothing, so exitsOpen() stays true and only the clock refuses), whether
    /// before or after it is ready. An instrument before its scheduling leaves it alive; re-scheduling a
    /// dead item revives it, with its whole delay.
    function test_ordinaryKilledByEitherClock() public {
        vm.prank(guardian);
        h.guardianInstrument();
        warpBy(1);
        vm.prank(owner);
        h.ownerInstrument();
        warpBy(1);
        sched(knob(5));
        warpBy(48 hours);
        exec(knob(5));
        assertEq(h.knob(), 5);

        // the guardian's clock, then the owner's, after scheduling and before the item is ready
        sched(knob(6));
        warpBy(1 hours);
        vm.prank(guardian);
        h.guardianInstrument();
        warpBy(1);
        sched(knob(7));
        warpBy(1 hours);
        vm.prank(owner);
        h.ownerInstrument();
        warpBy(48 hours);
        assertTrue(h.exposed_exitsOpen());
        assertExecuteRefused(knob(6));
        assertExecuteRefused(knob(7));

        // after it is ready, inside its window
        sched(knob(9));
        warpBy(48 hours + 1 days);
        vm.prank(guardian);
        h.guardianInstrument();
        assertExecuteRefused(knob(9));

        // re-scheduled after the stamps, an item lives again, from its new scheduledAt
        warpBy(1);
        uint64 t = now_();
        sched(knob(7));
        assertEq(h.item(keccak256(knob(7))).scheduledAt, t);
        warpBy(48 hours);
        exec(knob(7));
        assertEq(h.knob(), 7);
    }

    /// I-27: a guardian's instruments never delay setGuardian. With the primary disabled by the guardian, in
    /// that very second, the swap schedules (its clock is the owner's alone) while an Ordinary item cannot;
    /// the guardian's later instruments, even one in the second of execute, do not kill it, the guardian
    /// cannot cancel it (I-24), and it executes on day 8. The swap ends the old guardian's hold (R1-B M-1: a
    /// guardian's bridge hold ends with the guardian, ExitsReopened(setGuardian.selector)), stamping nothing,
    /// while the primary stays disabled until its Reopen: exits read OPEN with the primary disabled.
    function test_guardianSwapIgnoresGuardianHolds() public {
        warpBy(1 hours);
        vm.prank(guardian);
        h.disableBridge(bridge);
        uint64 t0 = now_();
        assertScheduleRefused(knob(5));
        bytes32 id = sched(swap(guardian2));
        assertEq(h.item(id).scheduledAt, t0);
        assertEq(uint8(h.item(id).kind), uint8(Kind.GuardianSwap));

        warpBy(1 days);
        vm.prank(guardian);
        h.guardianInstrument();
        vm.prank(guardian);
        vm.expectRevert(NotCanceller.selector);
        h.cancel(id);
        warpBy(7 days);
        vm.prank(guardian);
        h.guardianInstrument();
        vm.expectEmit(address(h));
        emit ExitsReopened(h.setGuardian.selector);
        exec(swap(guardian2));
        assertEq(h.exposed_guardian(), guardian2);
        assertEq(uint8(h.exposed_primaryDisabledBy()), uint8(Actor.None), "the old guardian's hold ended");
        assertFalse(h.exposed_guardianHold());
        assertTrue(h.exposed_exitsOpen());
        assertEq(h.exposed_lastOwnerClose(), 0, "nothing stamped");
        assertEq(h.exposed_lastGuardianClose(), t0 + 8 days);
        assertFalse(h.exposed_bridgeEnabled(bridge), "the primary stays disabled until its Reopen");

        // the primary's Reopen brings it back
        Schedule.run(h, owner, activation(bridge));
        assertHolds(Actor.None, 0, t0 + 8 days);
    }

    /// A GuardianSwap runs on the owner's clock and needs no owner hold. The owner's disable of the primary
    /// after its scheduling (a hold and a stamp) kills it; under that hold none can be scheduled; the Reopen
    /// clears the hold and a swap scheduled after runs. An owner instrument without a hold kills a pending
    /// swap too. An owner hold alone (recorded without its stamp) refuses one at execute; a guardian hold
    /// does not.
    function test_guardianSwapKilledByAnOwnerInstrument() public {
        sched(swap(guardian2));
        warpBy(1 days);
        vm.prank(owner);
        h.disableBridge(bridge);
        warpBy(7 days);
        assertExecuteRefused(swap(guardian2));
        assertScheduleRefused(swap(guardian2));
        assertScheduleRefused(swap(safe));

        Schedule.run(h, owner, activation(bridge));
        assertTrue(h.exposed_exitsOpen());
        Schedule.run(h, owner, swap(guardian2));
        assertEq(h.exposed_guardian(), guardian2);

        sched(swap(guardian));
        warpBy(1 hours);
        vm.prank(owner);
        h.ownerInstrument();
        warpBy(8 days);
        assertExecuteRefused(swap(guardian));

        sched(swap(safe));
        warpBy(8 days);
        h.forceHold(Actor.Owner);
        assertExecuteRefused(swap(safe));
        h.forceHold(Actor.Guardian);
        exec(swap(safe));
        assertEq(h.exposed_guardian(), safe);
    }

    /// A Reopen needs no gate, only the owner's clock. The owner disables the primary; one second later its
    /// Reopen schedules under the owner's own hold (an Ordinary item cannot); a guardian instrument does
    /// not kill it, and it clears the hold at execute with ExitsReopened(activateBridge.selector), stamping
    /// nothing. The owner disables it again, schedules its Reopen, and an owner instrument kills that one.
    function test_reopenNeedsNoGateOnlyTheOwnerClock() public {
        vm.prank(owner);
        h.disableBridge(bridge);
        uint64 t0 = now_();
        warpBy(1);
        bytes32 id = sched(activation(bridge));
        assertEq(uint8(h.item(id).kind), uint8(Kind.Reopen));
        assertScheduleRefused(knob(5));

        warpBy(1 days);
        vm.prank(guardian);
        h.guardianInstrument();
        uint64 g = now_();
        warpBy(6 days);
        vm.expectEmit(address(h));
        emit BridgeActivated(bridge);
        vm.expectEmit(address(h));
        emit ExitsReopened(h.activateBridge.selector);
        vm.expectEmit(address(h));
        emit Executed(id);
        exec(activation(bridge));
        assertHolds(Actor.None, t0, g);

        vm.prank(owner);
        h.disableBridge(bridge);
        uint64 t1 = now_();
        warpBy(1);
        sched(activation(bridge));
        warpBy(1 hours);
        vm.prank(owner);
        h.ownerInstrument();
        uint64 t2 = now_();
        warpBy(7 days);
        assertExecuteRefused(activation(bridge));
        assertHolds(Actor.Owner, t2, g);
        assertGt(t2, t1);
    }

    /// schedule needs the item's clock strictly older than block.timestamp: an instrument earlier in the same
    /// second would kill the item at birth (spec §3.6, round 6 Info 6). Ordinary reads both clocks; a
    /// GuardianSwap and a Reopen the owner's alone. One second later each schedules.
    function test_scheduleRefusesAClockOfThisSecond() public {
        // a known bridge, disabled while not the primary: its Reopen needs no hold
        Schedule.run(h, owner, activation(bridge2));
        vm.prank(guardian);
        h.disableBridge(bridge2);
        warpBy(1);

        // the guardian's clock of this second: an Ordinary item is refused; a swap and a Reopen schedule
        vm.prank(guardian);
        h.guardianInstrument();
        assertScheduleRefused(knob(5));
        assertScheduleRefused(activation(bridge3));
        sched(swap(guardian2));
        sched(activation(bridge2));
        warpBy(1);
        sched(knob(5));

        // the owner's clock of this second: every kind is refused, a rescheduling included
        vm.prank(owner);
        h.ownerInstrument();
        assertScheduleRefused(knob(6));
        assertScheduleRefused(swap(safe));
        assertScheduleRefused(swap(guardian2));
        assertScheduleRefused(activation(bridge2));
        warpBy(1);
        sched(knob(6));
        sched(swap(safe));
        sched(activation(bridge2));
    }

    /// The boundary of execute's strict `<` (spec §3.6: an instrument kills every item scheduled at or before
    /// its time): a close in the very second an item was scheduled, after it, kills it, for each kind on its
    /// own clock; the guardian's close in that second leaves a swap and a Reopen alive.
    function test_aCloseInTheSecondOfSchedulingKillsTheItem() public {
        Schedule.run(h, owner, activation(bridge2));
        vm.prank(guardian);
        h.disableBridge(bridge2);
        warpBy(1);

        // the guardian's close of the primary, in the second an Ordinary item, a swap and a Reopen were
        // scheduled: the Ordinary item dies, the others live
        sched(knob(5));
        sched(swap(guardian2));
        sched(activation(bridge2));
        vm.prank(guardian);
        h.disableBridge(bridge);
        assertEq(h.exposed_lastGuardianClose(), h.item(keccak256(knob(5))).scheduledAt);
        warpBy(8 days);
        assertExecuteRefused(knob(5));
        exec(activation(bridge2));
        exec(swap(guardian2));
        assertEq(h.exposed_guardian(), guardian2);
        assertTrue(h.exposed_bridgeEnabled(bridge2));

        // the owner's close in the second of scheduling kills a swap and a Reopen
        Schedule.run(h, owner, activation(bridge));
        warpBy(1);
        vm.prank(guardian2);
        h.disableBridge(bridge2);
        sched(swap(safe));
        sched(activation(bridge2));
        vm.prank(owner);
        h.ownerInstrument();
        assertEq(h.exposed_lastOwnerClose(), h.item(keccak256(swap(safe))).scheduledAt);
        warpBy(8 days);
        assertExecuteRefused(swap(safe));
        assertExecuteRefused(activation(bridge2));
    }

    // ---- reopenings: the primary's Reopen and the switch ----

    /// setPrimaryBridge is allowed only while the current primary is disabled (H-2 ii), by the owner, to an
    /// enabled bridge (not one only scheduled, nor the disabled primary), after _checkBridgeCaps; it
    /// clears the hold with PrimaryBridgeSet then ExitsReopened(setPrimaryBridge.selector), and stamps
    /// nothing. The new primary enabled, a second switch is refused again.
    function test_setPrimaryBridgeOnlyWhileTheCurrentIsDisabled() public {
        Schedule.run(h, owner, activation(bridge2));
        sched(activation(bridge3));
        vm.prank(owner);
        vm.expectRevert(PrimaryStillEnabled.selector);
        h.setPrimaryBridge(bridge2);
        vm.prank(owner);
        vm.expectRevert(PrimaryStillEnabled.selector);
        h.setPrimaryBridge(bridge);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        h.setPrimaryBridge(bridge2);

        vm.prank(guardian);
        h.disableBridge(bridge);
        uint64 t0 = now_();
        address[4] memory notEnabled = [bridge3, bridge, stranger, address(0)];
        for (uint256 i; i < notEnabled.length; ++i) {
            vm.prank(owner);
            vm.expectRevert(BridgeNotEnabled.selector);
            h.setPrimaryBridge(notEnabled[i]);
        }
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        h.setPrimaryBridge(bridge2);
        h.refuseCaps(bridge2);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SchedulerHarness.CapsRefused.selector, bridge2));
        h.setPrimaryBridge(bridge2);
        assertEq(h.exposed_primaryBridge(), bridge);
        assertHolds(Actor.Guardian, 0, t0);
        h.refuseCaps(address(0));

        warpBy(1 hours);
        vm.recordLogs();
        vm.prank(owner);
        h.setPrimaryBridge(bridge2);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2);
        assertEq(logs[0].topics[0], PrimaryBridgeSet.selector);
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(bridge2))));
        assertEq(logs[1].topics[0], ExitsReopened.selector);
        assertEq(logs[1].topics[1], bytes32(h.setPrimaryBridge.selector));
        assertEq(h.exposed_primaryBridge(), bridge2);
        assertHolds(Actor.None, 0, t0);

        vm.prank(owner);
        vm.expectRevert(PrimaryStillEnabled.selector);
        h.setPrimaryBridge(bridge2);
    }

    /// The Reopen of the primary clears its hold with ExitsReopened(activateBridge.selector) and stamps
    /// nothing; the Reopen of another known bridge, while the primary is held, clears nothing and emits no
    /// ExitsReopened.
    function test_activatingThePrimaryClearsItsHold() public {
        Schedule.run(h, owner, activation(bridge2));
        vm.prank(guardian);
        h.disableBridge(bridge2);
        vm.prank(guardian);
        h.disableBridge(bridge);
        uint64 t0 = now_();
        warpBy(1);

        sched(activation(bridge2));
        warpBy(7 days);
        vm.recordLogs();
        exec(activation(bridge2));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2);
        assertEq(logs[0].topics[0], BridgeActivated.selector);
        assertEq(logs[1].topics[0], Executed.selector);
        assertHolds(Actor.Guardian, 0, t0);

        bytes32 id = sched(activation(bridge));
        warpBy(7 days);
        vm.recordLogs();
        exec(activation(bridge));
        logs = vm.getRecordedLogs();
        assertEq(logs.length, 3);
        assertEq(logs[0].topics[0], BridgeActivated.selector);
        assertEq(logs[1].topics[0], ExitsReopened.selector);
        assertEq(logs[1].topics[1], bytes32(h.activateBridge.selector));
        assertEq(logs[2].topics[0], Executed.selector);
        assertEq(logs[2].topics[1], id);
        assertHolds(Actor.None, 0, t0);
    }

    /// Disabling the primary twice: the second disable, by either actor, reverts BridgeNotEnabled, so the
    /// first actor stays recorded and only its clock is stamped (the guardian cannot turn the owner's hold
    /// into its own, nor stamp through it). After the Reopen the guardian's disable records the guardian
    /// and stamps its clock; the owner's keeps its first stamp.
    function test_disablingThePrimaryTwice() public {
        vm.prank(owner);
        h.disableBridge(bridge);
        uint64 t0 = now_();
        warpBy(1 hours);
        vm.prank(guardian);
        vm.expectRevert(BridgeNotEnabled.selector);
        h.disableBridge(bridge);
        vm.prank(owner);
        vm.expectRevert(BridgeNotEnabled.selector);
        h.disableBridge(bridge);
        assertHolds(Actor.Owner, t0, 0);

        Schedule.run(h, owner, activation(bridge));
        assertHolds(Actor.None, t0, 0);
        vm.prank(guardian);
        h.disableBridge(bridge);
        uint64 t1 = now_();
        warpBy(1 hours);
        vm.prank(owner);
        vm.expectRevert(BridgeNotEnabled.selector);
        h.disableBridge(bridge);
        assertHolds(Actor.Guardian, t0, t1);
    }

    /// None is no actor (the Task 8 review's carry): `_stamp(None)` reverts InvalidParameter and moves neither
    /// clock (it once fell into the guardian's branch); the owner and the guardian each stamp only their own.
    function test_stampOfNoneReverts() public {
        warpBy(1 hours);
        vm.expectRevert(InvalidParameter.selector);
        h.stampAs(Actor.None);
        assertEq(h.exposed_lastOwnerClose(), 0, "owner clock");
        assertEq(h.exposed_lastGuardianClose(), 0, "guardian clock");

        uint64 t = now_();
        h.stampAs(Actor.Guardian);
        assertEq(h.exposed_lastGuardianClose(), t);
        assertEq(h.exposed_lastOwnerClose(), 0);
        warpBy(1);
        h.stampAs(Actor.Owner);
        assertEq(h.exposed_lastOwnerClose(), t + 1);
        assertEq(h.exposed_lastGuardianClose(), t);
        warpBy(1);
        vm.expectRevert(InvalidParameter.selector);
        h.stampAs(Actor.None);
        assertEq(h.exposed_lastOwnerClose(), t + 1);
        assertEq(h.exposed_lastGuardianClose(), t);
    }

    /// `CascadeFormulas.holds(None, …)` is false whatever the three records read, None included (it once
    /// answered true when any record was None); for the owner and the guardian it is true exactly when a
    /// record names them. All 27 record combinations.
    function test_holdsOfNoneIsNoHold() public pure {
        for (uint8 p; p < 3; ++p) {
            for (uint8 q; q < 3; ++q) {
                for (uint8 r; r < 3; ++r) {
                    (Actor a, Actor b, Actor c) = (Actor(p), Actor(q), Actor(r));
                    assertFalse(CascadeFormulas.holds(Actor.None, a, b, c), "None holds nothing");
                    assertEq(
                        CascadeFormulas.holds(Actor.Owner, a, b, c),
                        a == Actor.Owner || b == Actor.Owner || c == Actor.Owner,
                        "the owner"
                    );
                    assertEq(
                        CascadeFormulas.holds(Actor.Guardian, a, b, c),
                        a == Actor.Guardian || b == Actor.Guardian || c == Actor.Guardian,
                        "the guardian"
                    );
                }
            }
        }
    }

    /// No hold blocks a cancel (I-24): under the guardian's hold the guardian cancels an Ordinary item killed
    /// by its own stamp, the owner a swap; a dead item is pruned after its window like any other.
    function test_cancelAndPruneAreNeverGated() public {
        bytes32 ordinary = sched(knob(5));
        bytes32 dead = sched(knob(6));
        bytes32 swapId = sched(swap(guardian2));
        warpBy(1);
        vm.prank(guardian);
        h.disableBridge(bridge);
        vm.prank(guardian);
        h.cancel(ordinary);
        vm.prank(owner);
        h.cancel(swapId);
        assertEq(h.item(ordinary).readyAt, 0);
        assertEq(h.item(swapId).readyAt, 0);
        warpBy(48 hours + 7 days + 1);
        vm.prank(stranger);
        h.prune(dead);
        assertEq(h.item(dead).readyAt, 0);
    }
}

/// The gates on the vault, CascadeBase's machine inherited (the vault's own holds, its pause and the launch
/// door's, are VaultExitsMachine.t.sol's), read through the vault lens.
contract VaultGatesTest is VaultTestBase {
    function test_theVaultsHoldAndGatesThroughItsLens() public {
        Schedule.warpTo(vm.getBlockTimestamp() + 1 days);
        bytes memory door = abi.encodeCall(vault.activateFrontDoor, (BASE, bob));
        vm.prank(owner);
        vault.schedule(door);
        uint64 t0 = uint64(vm.getBlockTimestamp());
        assertTrue(vaultLens.exitsOpen());

        Schedule.warpTo(t0 + 1 hours);
        vm.expectEmit(address(vault));
        emit ExitsClosed(guardian, vault.disableBridge.selector);
        vm.prank(guardian);
        vault.disableBridge(address(bridge));
        assertEq(uint8(vaultLens.primaryDisabledBy()), uint8(Actor.Guardian));
        assertEq(vaultLens.lastGuardianClose(), t0 + 1 hours);
        assertEq(vaultLens.lastOwnerClose(), 0);
        assertTrue(vaultLens.guardianHold());
        assertFalse(vaultLens.ownerHold());
        assertFalse(vaultLens.exitsOpen());

        // an Ordinary item cannot be scheduled, a swap can; the pending door activation is dead
        Schedule.warpTo(t0 + 2 hours);
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        vault.schedule(abi.encodeCall(vault.activateFrontDoor, (BASE, carol)));
        vm.prank(owner);
        vault.schedule(abi.encodeCall(vault.setGuardian, (carol)));
        Schedule.warpTo(t0 + 7 days);
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        vault.execute(door);

        // the owner's Reopen of the primary clears the hold
        Schedule.run(vault, owner, abi.encodeCall(vault.activateBridge, (address(bridge))));
        assertEq(uint8(vaultLens.primaryDisabledBy()), uint8(Actor.None));
        assertTrue(vaultLens.exitsOpen());
        assertEq(vaultLens.lastGuardianClose(), t0 + 1 hours);
    }

    /// Spec §3.6 row 3, HO: a new bridge activated from OPEN (7 days), then the old primary disabled and the
    /// primary switched in one step; the switch is refused while the old one is enabled.
    function test_theVaultsBridgeMigration() public {
        StubBridge bridge2 = new StubBridge(bridge.token());
        Schedule.run(vault, owner, abi.encodeCall(vault.activateBridge, (address(bridge2))));
        vm.prank(owner);
        vm.expectRevert(PrimaryStillEnabled.selector);
        vault.setPrimaryBridge(address(bridge2));

        vm.prank(owner);
        vault.disableBridge(address(bridge));
        assertTrue(vaultLens.ownerHold());
        vm.expectEmit(address(vault));
        emit PrimaryBridgeSet(address(bridge2));
        vm.expectEmit(address(vault));
        emit ExitsReopened(vault.setPrimaryBridge.selector);
        vm.prank(owner);
        vault.setPrimaryBridge(address(bridge2));
        assertEq(vaultLens.primaryBridge(), address(bridge2));
        assertTrue(vaultLens.exitsOpen());
        assertEq(vaultLens.lastOwnerClose(), uint64(vm.getBlockTimestamp()));
    }
}

/// The front door's machine is CascadeBase's alone (spec §3.6): the primary's disable is its one recorded
/// hold, and its pause records and stamps nothing.
contract DoorGatesTest is FrontDoorTestBase {
    /// I-29 in part: the front door's pause and unpause, by either actor, stamp nothing and record nothing
    /// (deposits and sales only); exits stay open, an Ordinary item schedules in the very second of a
    /// pause, and one pending through every pause executes.
    function test_frontDoorPauseAndUnpauseStampNothing() public {
        Schedule.warpTo(vm.getBlockTimestamp() + 1 days);
        StubBridge bridge2 = new StubBridge(tao);
        bytes memory data = abi.encodeCall(fd.activateBridge, (address(bridge2)));
        vm.prank(owner);
        fd.schedule(data);
        uint64 t0 = uint64(vm.getBlockTimestamp());

        address[2] memory pausers = [guardian, owner];
        for (uint256 i; i < 2; ++i) {
            Schedule.warpTo(vm.getBlockTimestamp() + 1 hours);
            vm.recordLogs();
            vm.prank(pausers[i]);
            fd.pause();
            Vm.Log[] memory logs = vm.getRecordedLogs();
            assertEq(logs.length, 1);
            assertEq(logs[0].topics[0], Pausable.Paused.selector);
            assertNothingRecorded();
            Schedule.warpTo(vm.getBlockTimestamp() + 1 hours);
            vm.recordLogs();
            vm.prank(owner);
            fd.unpause();
            logs = vm.getRecordedLogs();
            assertEq(logs.length, 1);
            assertEq(logs[0].topics[0], Pausable.Unpaused.selector);
            assertNothingRecorded();
        }

        vm.prank(guardian);
        fd.pause();
        vm.prank(owner);
        fd.schedule(abi.encodeCall(fd.transferOwnership, (alice)));
        Schedule.warpTo(t0 + 7 days);
        vm.prank(owner);
        fd.execute(data);
        assertTrue(doorLens.bridgeEnabled(address(bridge2)));
    }

    function assertNothingRecorded() internal view {
        assertEq(doorLens.lastOwnerClose(), 0);
        assertEq(doorLens.lastGuardianClose(), 0);
        assertEq(uint8(doorLens.primaryDisabledBy()), uint8(Actor.None));
        assertTrue(doorLens.exitsOpen());
    }

    /// The front door's primary, disabled by the owner: an owner hold through the door lens; a swap is
    /// refused at schedule, the primary's Reopen schedules a second later and clears it.
    function test_theDoorsOwnerHoldThroughItsLens() public {
        Schedule.warpTo(vm.getBlockTimestamp() + 1 days);
        vm.expectEmit(address(fd));
        emit ExitsClosed(owner, fd.disableBridge.selector);
        vm.prank(owner);
        fd.disableBridge(address(bridge));
        uint64 t0 = uint64(vm.getBlockTimestamp());
        assertEq(uint8(doorLens.primaryDisabledBy()), uint8(Actor.Owner));
        assertEq(doorLens.lastOwnerClose(), t0);
        assertTrue(doorLens.ownerHold());
        assertFalse(doorLens.guardianHold());
        assertFalse(doorLens.exitsOpen());

        Schedule.warpTo(t0 + 1);
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        fd.schedule(abi.encodeCall(fd.setGuardian, (alice)));
        Schedule.run(fd, owner, abi.encodeCall(fd.activateBridge, (address(bridge))));
        assertTrue(doorLens.exitsOpen());
        assertEq(uint8(doorLens.primaryDisabledBy()), uint8(Actor.None));
    }
}
