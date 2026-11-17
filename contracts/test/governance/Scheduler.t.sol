// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {Delay, DoorState, Item, Kind} from "../../src/CascadeTypes.sol";
import {
    AlreadyActive,
    BadCalldata,
    LapsedItem,
    NoProposal,
    NotCanceller,
    NotGuardian,
    NotReady,
    NotScheduled,
    UnknownSelector,
    ZeroAddress
} from "../../src/CascadeErrors.sol";
import {
    BridgeActivated,
    Cancelled,
    Executed,
    FrontDoorActivated,
    GuardianSet,
    Lapsed,
    LimitSet,
    Scheduled
} from "../../src/CascadeEvents.sol";
import {IExtsload} from "../../src/interfaces/IExtsload.sol";
import {VaultLayout} from "../../src/lens/generated/VaultLayout.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {FrontDoorTestBase} from "../FrontDoorTestBase.sol";
import {StubBridge} from "../mocks/StubBridge.sol";
import {SchedulerHarness} from "./SchedulerHarness.sol";
import {Schedule} from "./Schedule.sol";

/// The scheduler (spec §3.6, §3.10.6 and §3.10.8; I-24, I-25) on SchedulerHarness: schedule, the class
/// delays, the execute window, prune, cancel rights per kind, canonical calldata, the self-call that
/// only execute can make, and the bridge activation's kinds. Gates and clocks come in Task 8.
contract SchedulerTest is Test {
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
        h = new SchedulerHarness(owner, guardian, bridge);
    }

    // ---- helpers ----

    function knobData(uint256 v) internal view returns (bytes memory) {
        return abi.encodeCall(h.setKnob, (v));
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

    function assertItem(bytes32 id, uint64 scheduledAt, uint64 readyAt, Delay class_, Kind kind, bytes4 selector)
        internal
        view
    {
        Item memory it = h.item(id);
        assertEq(it.scheduledAt, scheduledAt, "scheduledAt");
        assertEq(it.readyAt, readyAt, "readyAt");
        assertEq(uint8(it.class), uint8(class_), "class");
        assertEq(uint8(it.kind), uint8(kind), "kind");
        assertEq(it.selector, selector, "selector");
    }

    function assertNoItem(bytes32 id) internal view {
        assertItem(id, 0, 0, Delay.Param, Kind.Ordinary, bytes4(0));
    }

    /// Whether the owner's schedule of `data` reverts with no data at all (the ABI decoder's refusal).
    function scheduleRevertsBare(bytes memory data) internal returns (bool) {
        vm.prank(owner);
        (bool ok, bytes memory ret) = address(h).call(abi.encodeCall(h.schedule, (data)));
        return !ok && ret.length == 0;
    }

    // ---- the constants ----

    function test_delaysAndWindow() public view {
        assertEq(h.exposed_PARAM_DELAY(), 48 hours);
        assertEq(h.exposed_REGISTRY_DELAY(), 7 days);
        assertEq(h.exposed_GUARDIAN_DELAY(), 8 days);
        assertEq(h.exposed_EXECUTE_WINDOW(), 7 days);
        // the constructor's bridge is known, as every activated one will be
        assertTrue(h.exposed_bridgeKnown(bridge));
        assertFalse(h.exposed_bridgeKnown(bridge2));
    }

    // ---- the block floor (R1-A L-3) ----

    /// R1A_ChainHalt, ported: a chain halt (or a long block gap) longer than an item's remaining delay used to
    /// make it ready at the first block after resume, so the guardian's veto and the founder's relayed stamps
    /// became a race inside that block. An item also waits half its delay in blocks, ceil(delay * 1000 / (2 *
    /// MS_PER_BLOCK)) (the harness's 7,200 ms, Bittensor's deploy calibration, twice as fast as its 12-second
    /// blocks; Revision 28): a 3-day block-less halt does not make a 48-hour item executable in the first block
    /// after resume, only in the 12,000th block from its scheduling, so the guardian has the resume block and the
    /// 11,999 after it, 40 hours of 12-second blocks (0.83 of the delay), to cancel in.
    function test_aHaltDoesNotConsumeTheVetoWindow() public {
        vm.roll(100);
        bytes memory loosen = knobData(1_000);
        bytes32 id = sched(loosen);
        uint256 scheduledBlock = vm.getBlockNumber();
        assertEq(h.exposed_MS_PER_BLOCK(), 7_200);
        assertEq(h.item(id).readyBlock, scheduledBlock + 12_000, "half of 48 hours in 7.2-second blocks");

        // resume: one block, 3 days later; the 48-hour delay has passed in time but not in blocks
        uint256 resumeBlock = scheduledBlock + 1;
        vm.roll(resumeBlock);
        vm.warp(vm.getBlockTimestamp() + 3 days);
        uint256 resumedAt = vm.getBlockTimestamp();
        vm.prank(owner);
        vm.expectRevert(NotReady.selector);
        h.execute(loosen);

        // the live chain from here, a block every 12 seconds: one block short of 12,000 is not ready, the
        // 12,000th is, and from the resume block to it, both counted, are 40 hours of blocks
        vm.roll(scheduledBlock + 12_000 - 1);
        vm.warp(resumedAt + (scheduledBlock + 12_000 - 1 - resumeBlock) * 12);
        vm.prank(owner);
        vm.expectRevert(NotReady.selector);
        h.execute(loosen);
        vm.roll(scheduledBlock + 12_000);
        vm.warp(resumedAt + (scheduledBlock + 12_000 - resumeBlock) * 12);
        assertEq((vm.getBlockNumber() - resumeBlock + 1) * 12, 40 hours, "the guardian's blocks after resume");
        exec(loosen);
        assertEq(h.knob(), 1_000);

        // each class waits half its delay in blocks: 7 days is 42,000 blocks, 8 days 48,000
        assertEq(h.item(sched(abi.encodeCall(h.activateBridge, (bridge2)))).readyBlock, vm.getBlockNumber() + 42_000);
        assertEq(h.item(sched(abi.encodeCall(h.setGuardian, (guardian2)))).readyBlock, vm.getBlockNumber() + 48_000);
    }

    // ---- schedule, execute, the window, prune ----

    function test_scheduleThenExecute() public {
        bytes memory data = knobData(5);
        bytes32 id = keccak256(data);
        uint64 t0 = now_();
        uint64 readyAt = t0 + 48 hours;

        vm.expectEmit(address(h));
        emit Scheduled(id, Kind.Ordinary, h.setKnob.selector, readyAt, data);
        assertEq(sched(data), id);
        assertItem(id, t0, readyAt, Delay.Param, Kind.Ordinary, h.setKnob.selector);

        Schedule.warpTo(readyAt - 1);
        vm.prank(owner);
        vm.expectRevert(NotReady.selector);
        h.execute(data);
        assertEq(h.knob(), 0);

        Schedule.warpTo(readyAt);
        // the setter's event carries its own selector under execute (the T7 carry)
        vm.expectEmit(address(h));
        emit LimitSet(h.setKnob.selector, 5, 0);
        vm.expectEmit(address(h));
        emit Executed(id);
        exec(data);
        assertEq(h.knob(), 5);
        assertEq(h.item(id).readyAt, 0);
        assertNoItem(id);

        // no replay: the item is gone
        vm.prank(owner);
        vm.expectRevert(NoProposal.selector);
        h.execute(data);
        // and nothing was ever scheduled under another calldata
        vm.prank(owner);
        vm.expectRevert(NoProposal.selector);
        h.execute(knobData(6));
    }

    function test_windowAndPrune() public {
        // the window's last second still executes
        bytes memory data = knobData(5);
        bytes32 id = sched(data);
        uint64 readyAt = h.item(id).readyAt;
        Schedule.warpTo(readyAt + 7 days);
        exec(data);
        assertEq(h.knob(), 5);

        // a second item lapses one second after its window
        data = knobData(9);
        id = sched(data);
        readyAt = h.item(id).readyAt;
        vm.prank(stranger);
        vm.expectRevert(NotReady.selector);
        h.prune(id); // before it is ready
        Schedule.warpTo(readyAt + 7 days);
        vm.prank(stranger);
        vm.expectRevert(NotReady.selector);
        h.prune(id); // inside the window
        Schedule.warpTo(readyAt + 7 days + 1);
        vm.prank(owner);
        vm.expectRevert(LapsedItem.selector);
        h.execute(data);
        assertEq(h.knob(), 5);

        // anyone prunes it after the window
        vm.expectEmit(address(h));
        emit Lapsed(id);
        vm.prank(stranger);
        h.prune(id);
        assertNoItem(id);
        vm.prank(stranger);
        vm.expectRevert(NoProposal.selector);
        h.prune(id);
        vm.prank(owner);
        vm.expectRevert(NoProposal.selector);
        h.execute(data);
    }

    function test_rescheduleRestartsTheDelay() public {
        bytes memory data = knobData(5);
        uint64 t0 = now_();
        bytes32 id = sched(data);

        Schedule.warpTo(t0 + 24 hours);
        vm.expectEmit(address(h));
        emit Scheduled(id, Kind.Ordinary, h.setKnob.selector, t0 + 72 hours, data);
        assertEq(sched(data), id);
        assertItem(id, t0 + 24 hours, t0 + 72 hours, Delay.Param, Kind.Ordinary, h.setKnob.selector);

        Schedule.warpTo(t0 + 48 hours);
        vm.prank(owner);
        vm.expectRevert(NotReady.selector);
        h.execute(data);
        Schedule.warpTo(t0 + 72 hours);
        exec(data);
        assertEq(h.knob(), 5);
    }

    // ---- what can be scheduled ----

    function test_unknownSelector() public {
        bytes[5] memory unknown = [
            abi.encodeWithSignature("notASetter(uint256)", 1),
            bytes(""),
            abi.encodePacked(bytes3(h.setKnob.selector)),
            abi.encodeCall(h.knob, ()),
            abi.encodeCall(h.arm, (knobData(1)))
        ];
        for (uint256 i; i < unknown.length; ++i) {
            vm.prank(owner);
            vm.expectRevert(UnknownSelector.selector);
            h.schedule(unknown[i]);
            assertNoItem(keccak256(unknown[i]));
        }
    }

    /// Data must be exactly the selector's canonical length (spec §3.6, L-6): one byte more or one word
    /// less is refused, for the harness's setters and the base's.
    function test_canonicalLength() public {
        bytes memory knob = knobData(5);
        bytes[8] memory bad = [
            abi.encodePacked(knob, bytes1(0)),
            abi.encodePacked(h.setKnob.selector),
            abi.encodePacked(abi.encodeCall(h.setBoom, ()), uint256(0)),
            abi.encodePacked(abi.encodeCall(h.setGuardian, (guardian2)), bytes1(0)),
            abi.encodePacked(h.setGuardian.selector),
            abi.encodePacked(abi.encodeCall(h.activateBridge, (bridge2)), uint256(0)),
            abi.encodePacked(h.activateBridge.selector),
            abi.encodePacked(h.transferOwnership.selector)
        ];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(owner);
            vm.expectRevert(BadCalldata.selector);
            h.schedule(bad[i]);
            assertNoItem(keccak256(bad[i]));
        }
    }

    /// An address argument is decoded with abi.decode, which refuses dirty upper bits, so one target
    /// has one canonical calldata and one id (spec §3.10.8); a zero guardian or bridge is refused.
    function test_addressArgumentsDecodeStrictly() public {
        bytes32 dirty = bytes32(uint256(uint160(bridge2)) | (uint256(1) << 200));
        assertTrue(scheduleRevertsBare(abi.encodePacked(h.activateBridge.selector, dirty)), "activateBridge");
        assertTrue(scheduleRevertsBare(abi.encodePacked(h.setGuardian.selector, dirty)), "setGuardian");
        assertTrue(scheduleRevertsBare(abi.encodePacked(h.transferOwnership.selector, dirty)), "transferOwnership");
        assertNoItem(keccak256(abi.encodePacked(h.activateBridge.selector, dirty)));

        vm.prank(owner);
        vm.expectRevert(ZeroAddress.selector);
        h.schedule(abi.encodeCall(h.setGuardian, (address(0))));
        vm.prank(owner);
        vm.expectRevert(ZeroAddress.selector);
        h.schedule(abi.encodeCall(h.activateBridge, (address(0))));
    }

    /// B18 (I-25's surface): the override of _checkOwner admits execute's self-call to every onlyOwner
    /// function, so none but the classified setters may ever be scheduled. The scheduler's own entry
    /// points, the instruments, ownership acceptance and the removed legacy registries (named by
    /// signature) each revert UnknownSelector.
    function test_metaSelectorsAreNotSchedulable() public {
        bytes[15] memory meta = [
            abi.encodeCall(h.schedule, (knobData(1))),
            abi.encodeCall(h.execute, (knobData(1))),
            abi.encodeCall(h.cancel, (bytes32(0))),
            abi.encodeCall(h.prune, (bytes32(0))),
            abi.encodeCall(h.pause, ()),
            abi.encodeCall(h.unpause, ()),
            abi.encodeCall(h.acceptOwnership, ()),
            abi.encodeCall(h.renounceOwnership, ()),
            abi.encodeCall(h.setPrimaryBridge, (bridge)),
            abi.encodeCall(h.disableBridge, (bridge)),
            abi.encodeCall(h.extsload, (bytes32(0))),
            abi.encodeWithSignature("proposeGuardian(address)", guardian2),
            abi.encodeWithSignature("acceptGuardian()"),
            abi.encodeWithSignature("proposeBridge(address)", bridge2),
            abi.encodeWithSignature("cancelBridgeProposal(address)", bridge2)
        ];
        for (uint256 i; i < meta.length; ++i) {
            vm.prank(owner);
            vm.expectRevert(UnknownSelector.selector);
            h.schedule(meta[i]);
            assertNoItem(keccak256(meta[i]));
        }
    }

    // ---- the self-call only execute makes (I-25) ----

    /// I-25 and ruling B2: a call from the harness's own address outside execute is refused. An
    /// onlyScheduled function reverts NotScheduled; an onlyOwner setter fails OpenZeppelin's check
    /// first, OwnableUnauthorizedAccount(harness), before its body's NotScheduled. Nothing changes.
    function test_selfCallOutsideExecuteRefused() public {
        // once before any execute, and once after one in the same transaction: the hash is cleared, so even
        // the exact calldata just executed (setKnob(3), as setKnob(knob)) is refused
        for (uint256 round; round < 2; ++round) {
            if (round == 1) Schedule.run(h, owner, knobData(3));
            uint256 knob = h.knob();

            vm.prank(address(h));
            vm.expectRevert(NotScheduled.selector);
            h.setGuardian(guardian2);
            vm.prank(address(h));
            vm.expectRevert(NotScheduled.selector);
            h.activateBridge(bridge2);
            vm.prank(address(h));
            vm.expectRevert(NotScheduled.selector);
            h.transferOwnership(safe);

            vm.prank(address(h));
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(h)));
            h.setKnob(knob + 7);
            vm.prank(address(h));
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(h)));
            h.setKnob(knob);
            vm.prank(address(h));
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(h)));
            h.setKnob(0);
            vm.prank(address(h));
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(h)));
            h.schedule(knobData(knob + 7));
            vm.prank(address(h));
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(h)));
            h.execute(knobData(3));

            assertEq(h.exposed_guardian(), guardian);
            assertFalse(h.exposed_bridgeEnabled(bridge2));
            assertFalse(h.exposed_bridgeKnown(bridge2));
            assertEq(h.pendingOwner(), address(0));
            assertEq(h.owner(), owner);
            assertEq(h.knob(), knob);
            assertEq(h.guardianHookCalls(), 0);
            assertEq(h.executingHash(), bytes32(0));
        }
    }

    /// The owner itself cannot call a scheduled function outside execute either, and no one else can: the
    /// owner's direct activateBridge included, which Task 7a's legacy branch still answered (Task 7b).
    function test_scheduledFunctionsRefuseDirectCalls() public {
        address[3] memory callers = [owner, guardian, stranger];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(NotScheduled.selector);
            h.setGuardian(guardian2);
            vm.prank(callers[i]);
            vm.expectRevert(NotScheduled.selector);
            h.transferOwnership(safe);
            vm.prank(callers[i]);
            vm.expectRevert(NotScheduled.selector);
            h.activateBridge(bridge2);
        }
        assertEq(h.exposed_guardian(), guardian);
        assertEq(h.pendingOwner(), address(0));
        assertFalse(h.exposed_bridgeEnabled(bridge2));
        assertFalse(h.exposed_bridgeKnown(bridge2));
    }

    // ---- the legacy registries, gone (Task 7b) ----

    /// The stale-ticket hole the 7a review found: a legacy proposal outlived the scheduled activation of its
    /// bridge, so once the guardian disabled the bridge the owner's direct activateBridge re-enabled it at
    /// once. With the registry gone the proposal cannot be made, a direct activateBridge is NotScheduled from
    /// anyone, now or after any wait, and a known bridge comes back only as a Reopen: the Registry class's
    /// 7 days, and the guardian cannot cancel it (I-24).
    function test_aDisabledBridgeComesBackOnlyThroughAReopen() public {
        vm.prank(owner);
        (bool ok,) = address(h).call(abi.encodeWithSignature("proposeBridge(address)", bridge2));
        assertFalse(ok, "the legacy proposal");

        // the honest path activates bridge2; much later the guardian disables it
        bytes memory data = abi.encodeCall(h.activateBridge, (bridge2));
        Schedule.run(h, owner, data);
        assertTrue(h.exposed_bridgeEnabled(bridge2));
        Schedule.warpTo(now_() + 30 days);
        vm.prank(guardian);
        h.disableBridge(bridge2);

        // no direct way back, for anyone
        address[3] memory callers = [owner, guardian, stranger];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(NotScheduled.selector);
            h.activateBridge(bridge2);
        }
        Schedule.warpTo(now_() + 7 days);
        vm.prank(owner);
        vm.expectRevert(NotScheduled.selector);
        h.activateBridge(bridge2);
        assertFalse(h.exposed_bridgeEnabled(bridge2));

        // the way back: a Reopen, 7 days, owner-only to cancel
        uint64 t0 = now_();
        bytes32 id = sched(data);
        assertItem(id, t0, t0 + 7 days, Delay.Registry, Kind.Reopen, h.activateBridge.selector);
        vm.prank(guardian);
        vm.expectRevert(NotCanceller.selector);
        h.cancel(id);
        Schedule.warpTo(t0 + 7 days - 1);
        vm.prank(owner);
        vm.expectRevert(NotReady.selector);
        h.execute(data);
        assertFalse(h.exposed_bridgeEnabled(bridge2));
        Schedule.warpTo(t0 + 7 days);
        exec(data);
        assertTrue(h.exposed_bridgeEnabled(bridge2));
    }

    /// The 7a review's second probe: a legacy proposal made beside a scheduled activation survived the
    /// guardian's cancel of the item and let the owner activate the bridge after 7 days. Now the guardian's
    /// cancel is final: no proposal can be made, no direct activation, and nothing left to execute.
    function test_aCancelledActivationLeavesNoWayIn() public {
        bytes memory data = abi.encodeCall(h.activateBridge, (bridge2));
        bytes32 id = sched(data);
        vm.prank(owner);
        (bool ok,) = address(h).call(abi.encodeWithSignature("proposeBridge(address)", bridge2));
        assertFalse(ok, "the legacy proposal");
        vm.prank(guardian);
        h.cancel(id);

        Schedule.warpTo(now_() + 7 days);
        vm.prank(owner);
        vm.expectRevert(NotScheduled.selector);
        h.activateBridge(bridge2);
        vm.prank(owner);
        vm.expectRevert(NoProposal.selector);
        h.execute(data);
        assertFalse(h.exposed_bridgeEnabled(bridge2));
        assertFalse(h.exposed_bridgeKnown(bridge2));
    }

    /// Every entry point of the legacy registries is gone: called by the owner with arguments they once
    /// took, before and after both registries' delays, each matches no function and reverts without data
    /// (CascadeBase has no fallback), and nothing changes; a guardian proposal accepted after 8 days (the
    /// 7a review's probe, which also skipped the setGuardian hook) is among them.
    function test_theLegacyRegistriesAreGone() public {
        bytes[5] memory gone = [
            abi.encodeWithSignature("proposeGuardian(address)", guardian2),
            abi.encodeWithSignature("acceptGuardian()"),
            abi.encodeWithSignature("cancelGuardianProposal()"),
            abi.encodeWithSignature("proposeBridge(address)", bridge2),
            abi.encodeWithSignature("cancelBridgeProposal(address)", bridge2)
        ];
        for (uint256 round; round < 2; ++round) {
            if (round == 1) Schedule.warpTo(now_() + 8 days);
            for (uint256 i; i < gone.length; ++i) {
                vm.prank(owner);
                (bool ok, bytes memory ret) = address(h).call(gone[i]);
                assertFalse(ok, "a legacy entry point answered");
                assertEq(ret.length, 0);
            }
        }
        assertEq(h.exposed_guardian(), guardian);
        assertEq(h.guardianHookCalls(), 0);
        assertFalse(h.exposed_bridgeEnabled(bridge2));
        assertFalse(h.exposed_bridgeKnown(bridge2));
    }

    function test_directTighteningImmediate() public {
        Schedule.run(h, owner, knobData(10));
        assertEq(h.knob(), 10);

        vm.expectEmit(address(h));
        emit LimitSet(h.setKnob.selector, 3, 0);
        vm.prank(owner);
        h.setKnob(3);
        assertEq(h.knob(), 3);
        // an equal value is no loosening
        vm.prank(owner);
        h.setKnob(3);
        assertEq(h.knob(), 3);
    }

    function test_directLooseningRefused() public {
        vm.prank(owner);
        vm.expectRevert(NotScheduled.selector);
        h.setKnob(1);
        assertEq(h.knob(), 0);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        h.setKnob(0);
    }

    /// Spec §3.10.6: schedule checks the selector, the length and (from Task 8) the gates, never the
    /// direction, so an equal value or a tightening waits its delay and executes harmlessly.
    function test_equalValueSchedulableAndHarmless() public {
        bytes32 id = sched(knobData(0));
        assertItem(id, now_(), now_() + 48 hours, Delay.Param, Kind.Ordinary, h.setKnob.selector);
        Schedule.warpTo(now_() + 48 hours);
        vm.expectEmit(address(h));
        emit Executed(id);
        exec(knobData(0));
        assertEq(h.knob(), 0);

        Schedule.run(h, owner, knobData(10));
        Schedule.run(h, owner, knobData(4));
        assertEq(h.knob(), 4);
    }

    // ---- execute's mechanics: delete first, the transient flag, the revert bubbled ----

    function test_revertingSetterLeavesTheItem() public {
        bytes memory data = abi.encodeCall(h.setBoom, ());
        uint64 t0 = now_();
        bytes32 id = sched(data);
        Schedule.warpTo(t0 + 48 hours);

        vm.prank(owner);
        vm.expectRevert(SchedulerHarness.Boom.selector);
        h.execute(data);
        assertItem(id, t0, t0 + 48 hours, Delay.Param, Kind.Ordinary, h.setBoom.selector);
        assertEq(h.executingHash(), bytes32(0));

        // it can be tried again inside its window, and pruned after it
        Schedule.warpTo(t0 + 48 hours + 7 days);
        vm.prank(owner);
        vm.expectRevert(SchedulerHarness.Boom.selector);
        h.execute(data);
        Schedule.warpTo(t0 + 48 hours + 7 days + 1);
        h.prune(id);
        assertNoItem(id);
    }

    /// Execute deletes the item before its self-call (the setter already reads it as gone, so nothing
    /// inside can replay it) and sets the transient hash, the item's id, only around that call: 0 before,
    /// the id inside, 0 after, in the same transaction; then even the exact calldata it ran is refused.
    function test_executeDeletesFirstAndFlagsOnlyTheSelfCall() public {
        bytes memory data = abi.encodeCall(h.probe, ());
        bytes32 id = sched(data);
        Schedule.warpTo(now_() + 48 hours);
        assertEq(h.executingHash(), bytes32(0));

        exec(data);
        assertTrue(h.probeRan());
        assertTrue(h.probeSawScheduledCall(), "a scheduled call inside execute");
        assertEq(h.probeSawReadyAt(), 0, "the item is deleted before the self-call");
        assertEq(h.probeSawHash(), id, "the hash inside is the item's id (transient slot 0)");
        assertEq(h.executingHash(), bytes32(0), "the hash is cleared after the self-call");
        assertNoItem(id);

        vm.prank(address(h));
        vm.expectRevert(NotScheduled.selector);
        h.probe();
    }

    /// A scheduled call that re-enters the scheduler gains nothing: a nested self-call carries other
    /// calldata than the item execute is running, so it is no scheduled call. execute and schedule
    /// (onlyOwner) refuse it with OwnableUnauthorizedAccount(harness), even for an item that is ready or
    /// for its own item, and cancel with NotCanceller. The revert restores the outer item.
    function test_reentryFromAScheduledCall() public {
        bytes memory reenter = abi.encodeCall(h.reenter, ());
        uint64 t0 = now_();
        bytes32 reenterId = sched(reenter);
        bytes32 knobId = sched(knobData(5)); // both ready at t0 + 48 h
        Schedule.warpTo(t0 + 48 hours);

        bytes memory unauthorized = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(h));
        bytes[5] memory nested = [
            abi.encodeCall(h.execute, (knobData(5))), // a ready item
            abi.encodeCall(h.execute, (reenter)), // its own item
            abi.encodeCall(h.execute, (knobData(8))), // nothing scheduled
            abi.encodeCall(h.schedule, (knobData(9))),
            abi.encodeCall(h.cancel, (knobId))
        ];
        for (uint256 i; i < nested.length; ++i) {
            h.arm(nested[i]);
            vm.prank(owner);
            vm.expectRevert(i == 4 ? abi.encodeWithSelector(NotCanceller.selector) : unauthorized);
            h.execute(reenter);

            assertEq(h.knob(), 0);
            assertItem(reenterId, t0, t0 + 48 hours, Delay.Param, Kind.Ordinary, h.reenter.selector);
            assertItem(knobId, t0, t0 + 48 hours, Delay.Param, Kind.Ordinary, h.setKnob.selector);
            assertNoItem(keccak256(knobData(9)));
            assertEq(h.executingHash(), bytes32(0));
        }
    }

    /// I-25 with the hash binding: inside execute, only the call execute made is scheduled. A scheduled
    /// call's nested self-call with other calldata, to a scheduled function or a loosening (or any)
    /// owner setter, is refused, and nothing changes; the outer item stays scheduled.
    function test_aNestedSelfCallIsNotTheScheduledCall() public {
        bytes memory reenter = abi.encodeCall(h.reenter, ());
        uint64 t0 = now_();
        bytes32 reenterId = sched(reenter);
        Schedule.warpTo(t0 + 48 hours);

        bytes memory unauthorized = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(h));
        bytes memory notScheduled = abi.encodeWithSelector(NotScheduled.selector);
        bytes[6] memory nested = [
            abi.encodeCall(h.setGuardian, (guardian2)),
            abi.encodeCall(h.activateBridge, (bridge2)),
            abi.encodeCall(h.transferOwnership, (safe)),
            abi.encodeCall(h.probe, ()),
            abi.encodeCall(h.setKnob, (7)), // a loosening
            abi.encodeCall(h.setKnob, (0)) // an equal value: still an owner call it is not
        ];
        for (uint256 i; i < nested.length; ++i) {
            h.arm(nested[i]);
            vm.prank(owner);
            vm.expectRevert(i < 4 ? notScheduled : unauthorized);
            h.execute(reenter);

            assertEq(h.exposed_guardian(), guardian);
            assertFalse(h.exposed_bridgeEnabled(bridge2));
            assertFalse(h.exposed_bridgeKnown(bridge2));
            assertEq(h.pendingOwner(), address(0));
            assertFalse(h.probeRan());
            assertEq(h.knob(), 0);
            assertEq(h.guardianHookCalls(), 0);
            assertItem(reenterId, t0, t0 + 48 hours, Delay.Param, Kind.Ordinary, h.reenter.selector);
            assertEq(h.executingHash(), bytes32(0));
        }
    }

    // ---- cancel rights (I-24) ----

    function test_cancelRights() public {
        // one item of each kind: an Ordinary loosening, a GuardianSwap, a Reopen of a known bridge the
        // guardian disabled, an Ordinary activation of a new bridge, an Ordinary ownership transfer. The
        // disabled bridge is not the primary, so exits stay open for the Ordinary items (Task 8's gate)
        Schedule.run(h, owner, abi.encodeCall(h.activateBridge, (bridge3)));
        vm.prank(guardian);
        h.disableBridge(bridge3);
        bytes32 ordinary = sched(knobData(5));
        bytes32 swap = sched(abi.encodeCall(h.setGuardian, (guardian2)));
        bytes32 reopen = sched(abi.encodeCall(h.activateBridge, (bridge3)));
        bytes32 newBridge = sched(abi.encodeCall(h.activateBridge, (bridge2)));
        bytes32 ownership = sched(abi.encodeCall(h.transferOwnership, (safe)));
        assertEq(uint8(h.item(swap).kind), uint8(Kind.GuardianSwap));
        assertEq(uint8(h.item(reopen).kind), uint8(Kind.Reopen));
        assertEq(uint8(h.item(newBridge).kind), uint8(Kind.Ordinary));
        assertEq(uint8(h.item(ownership).kind), uint8(Kind.Ordinary));

        // a stranger cancels nothing
        bytes32[5] memory all = [ordinary, swap, reopen, newBridge, ownership];
        for (uint256 i; i < all.length; ++i) {
            vm.prank(stranger);
            vm.expectRevert(NotCanceller.selector);
            h.cancel(all[i]);
        }
        // the guardian cannot cancel its own replacement, nor a Reopen (B16e)
        vm.prank(guardian);
        vm.expectRevert(NotCanceller.selector);
        h.cancel(swap);
        vm.prank(guardian);
        vm.expectRevert(NotCanceller.selector);
        h.cancel(reopen);
        // nor the harness's own address, which is not the owner
        vm.prank(address(h));
        vm.expectRevert(NotCanceller.selector);
        h.cancel(ordinary);

        // the guardian cancels each Ordinary item
        bytes32[3] memory ordinaries = [ordinary, newBridge, ownership];
        for (uint256 i; i < ordinaries.length; ++i) {
            vm.expectEmit(address(h));
            emit Cancelled(ordinaries[i], guardian);
            vm.prank(guardian);
            h.cancel(ordinaries[i]);
            assertNoItem(ordinaries[i]);
        }
        // the owner cancels anything
        vm.expectEmit(address(h));
        emit Cancelled(swap, owner);
        vm.prank(owner);
        h.cancel(swap);
        vm.expectEmit(address(h));
        emit Cancelled(reopen, owner);
        vm.prank(owner);
        h.cancel(reopen);
        assertNoItem(swap);
        assertNoItem(reopen);
        bytes32 again = sched(knobData(6));
        vm.prank(owner);
        h.cancel(again);

        // a cancelled item never executes, and cannot be cancelled twice
        Schedule.warpTo(now_() + 8 days);
        vm.prank(owner);
        vm.expectRevert(NoProposal.selector);
        h.execute(abi.encodeCall(h.setGuardian, (guardian2)));
        vm.prank(owner);
        vm.expectRevert(NoProposal.selector);
        h.cancel(swap);
        assertEq(h.exposed_guardian(), guardian);
        assertEq(h.knob(), 0);

        // the guardian and a stranger can schedule nothing, and execute nothing
        address[2] memory others = [guardian, stranger];
        sched(knobData(5));
        Schedule.warpTo(now_() + 48 hours);
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, others[i]));
            h.schedule(knobData(7));
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, others[i]));
            h.execute(knobData(5));
        }
    }

    // ---- the base's scheduled functions ----

    function test_bridgeActivationKinds() public {
        // a bridge never active before: Ordinary, the Registry class (7 days)
        bytes memory data = abi.encodeCall(h.activateBridge, (bridge2));
        uint64 t0 = now_();
        bytes32 id = sched(data);
        assertItem(id, t0, t0 + 7 days, Delay.Registry, Kind.Ordinary, h.activateBridge.selector);

        // an enabled bridge: AlreadyActive at schedule
        vm.prank(owner);
        vm.expectRevert(AlreadyActive.selector);
        h.schedule(abi.encodeCall(h.activateBridge, (bridge)));

        Schedule.warpTo(t0 + 7 days);
        vm.expectEmit(address(h));
        emit BridgeActivated(bridge2);
        exec(data);
        assertTrue(h.exposed_bridgeEnabled(bridge2));
        assertTrue(h.exposed_bridgeKnown(bridge2));
        vm.prank(owner);
        vm.expectRevert(AlreadyActive.selector);
        h.schedule(data);

        // known and disabled: a Reopen, under the same id (one target, one calldata)
        vm.prank(guardian);
        h.disableBridge(bridge2);
        uint64 t1 = now_();
        assertEq(sched(data), id);
        assertItem(id, t1, t1 + 7 days, Delay.Registry, Kind.Reopen, h.activateBridge.selector);

        // Activated meanwhile: AlreadyActive at execute (ruling B3). Unreachable through the API: one
        // canonical calldata is one id, so nothing but this very item can activate bridge2 while it is
        // pending (spec §3.6, round 6 L-2). The setter's own check is exercised by writing
        // bridgeEnabled[bridge2] directly: its slot is the one the exposure reads.
        vm.record();
        h.exposed_bridgeEnabled(bridge2);
        (bytes32[] memory reads,) = vm.accesses(address(h));
        assertEq(reads.length, 1);
        vm.store(address(h), reads[0], bytes32(uint256(1)));
        assertTrue(h.exposed_bridgeEnabled(bridge2));
        Schedule.warpTo(t1 + 7 days);
        vm.prank(owner);
        vm.expectRevert(AlreadyActive.selector);
        h.execute(data);
        assertItem(id, t1, t1 + 7 days, Delay.Registry, Kind.Reopen, h.activateBridge.selector);

        // dirty address bits: refused by the decoder, so no second id for one target (spec §3.10.8)
        bytes32 dirty = bytes32(uint256(uint160(makeAddr("bridge3"))) | (uint256(1) << 160));
        assertTrue(scheduleRevertsBare(abi.encodePacked(h.activateBridge.selector, dirty)));
    }

    function test_transferOwnershipScheduledAcceptInstant() public {
        bytes memory data = abi.encodeCall(h.transferOwnership, (safe));
        uint64 t0 = now_();
        bytes32 id = sched(data);
        assertItem(id, t0, t0 + 8 days, Delay.Guardian, Kind.Ordinary, h.transferOwnership.selector);

        Schedule.warpTo(t0 + 8 days - 1);
        vm.prank(owner);
        vm.expectRevert(NotReady.selector);
        h.execute(data);
        Schedule.warpTo(t0 + 8 days);
        exec(data);
        assertEq(h.pendingOwner(), safe);
        assertEq(h.owner(), owner);

        // acceptance is instant
        vm.prank(safe);
        h.acceptOwnership();
        assertEq(h.owner(), safe);
        assertEq(h.pendingOwner(), address(0));
        // the old owner schedules nothing now; the new one does
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        h.schedule(knobData(1));
        vm.prank(safe);
        h.schedule(knobData(1));
    }

    function test_setGuardianToTheSameGuardian() public {
        bytes memory data = abi.encodeCall(h.setGuardian, (guardian));
        uint64 t0 = now_();
        bytes32 id = sched(data);
        assertItem(id, t0, t0 + 8 days, Delay.Guardian, Kind.GuardianSwap, h.setGuardian.selector);

        Schedule.warpTo(t0 + 8 days);
        vm.expectEmit(address(h));
        emit GuardianSet(guardian);
        vm.expectEmit(address(h));
        emit Executed(id);
        exec(data);
        assertEq(h.exposed_guardian(), guardian);
        assertEq(h.guardianHookCalls(), 1);
    }

    /// The guardian is replaced only by its scheduled swap, 8 days on: through the delay the sitting
    /// guardian keeps its powers and the incoming one has none; then the old guardian is out and the new
    /// one in (the cover of CascadeBase.t.sol's registry test, which Task 7b removed with the registry).
    function test_setGuardianReplacesTheGuardian() public {
        bytes memory data = abi.encodeCall(h.setGuardian, (guardian2));
        uint64 t0 = now_();
        sched(data);
        Schedule.warpTo(t0 + 8 days - 1);
        vm.prank(owner);
        vm.expectRevert(NotReady.selector);
        h.execute(data);
        vm.prank(guardian2);
        vm.expectRevert(NotGuardian.selector);
        h.pause();
        vm.prank(guardian);
        h.pause();
        vm.prank(owner);
        h.unpause();

        Schedule.warpTo(t0 + 8 days);
        vm.expectEmit(address(h));
        emit GuardianSet(guardian2);
        exec(data);
        assertEq(h.exposed_guardian(), guardian2);
        assertEq(h.guardianHookCalls(), 1);
        vm.prank(guardian);
        vm.expectRevert(NotGuardian.selector);
        h.disableBridge(bridge);
        vm.prank(guardian2);
        h.disableBridge(bridge);
        assertFalse(h.exposed_bridgeEnabled(bridge));
        vm.prank(guardian);
        vm.expectRevert(NotGuardian.selector);
        h.pause();
        vm.prank(guardian2);
        h.pause();
        assertTrue(h.paused());
    }
}

/// The scheduler on the vault (CascadeBase's, inherited): the base items through the vault lens, and
/// B18 on the vault's own instruments.
contract VaultSchedulerTest is VaultTestBase {
    function test_theVaultSchedulesTheBaseItems() public {
        address guardian2 = makeAddr("guardian2");
        bytes memory data = abi.encodeCall(vault.setGuardian, (guardian2));
        uint64 t0 = uint64(vm.getBlockTimestamp());
        vm.prank(owner);
        bytes32 id = vault.schedule(data);
        Item memory it = vaultLens.scheduled(id);
        assertEq(it.scheduledAt, t0);
        assertEq(it.readyAt, t0 + 8 days);
        assertEq(uint8(it.class), uint8(Delay.Guardian));
        assertEq(uint8(it.kind), uint8(Kind.GuardianSwap));
        assertEq(it.selector, vault.setGuardian.selector);

        Schedule.warpTo(t0 + 8 days);
        vm.prank(owner);
        vault.execute(data);
        assertEq(vaultLens.guardian(), guardian2);
        assertEq(vaultLens.scheduled(id).readyAt, 0);

        StubBridge bridge2 = new StubBridge(bridge.token());
        assertFalse(vaultLens.bridgeKnown(address(bridge2)));
        assertTrue(vaultLens.bridgeKnown(address(bridge)));
        Schedule.run(vault, owner, abi.encodeCall(vault.activateBridge, (address(bridge2))));
        assertTrue(vaultLens.bridgeEnabled(address(bridge2)));
        assertTrue(vaultLens.bridgeKnown(address(bridge2)));
        assertEq(vaultLens.PARAM_DELAY(), 48 hours);
        assertEq(vaultLens.EXECUTE_WINDOW(), 7 days);
    }

    /// B18 on the vault, with its own _classify (Task 7b classifies activateFrontDoor and defers the rest to
    /// CascadeBase): its emergency instruments, the scheduler's entry points and the removed registry are
    /// never schedulable.
    function test_metaSelectorsAreNotSchedulableOnTheVault() public {
        CascadeMessages.Payout[] memory none;
        bytes[17] memory meta = [
            abi.encodeCall(vault.cancelPayoutBatch, (bytes32(0), none)),
            abi.encodeCall(vault.setPrimaryBridge, (address(bridge))),
            abi.encodeCall(vault.schedule, (abi.encodeCall(vault.setGuardian, (alice)))),
            abi.encodeCall(vault.execute, (abi.encodeCall(vault.setGuardian, (alice)))),
            abi.encodeCall(vault.cancel, (bytes32(0))),
            abi.encodeCall(vault.prune, (bytes32(0))),
            abi.encodeCall(vault.pause, ()),
            abi.encodeCall(vault.unpause, ()),
            abi.encodeCall(vault.acceptOwnership, ()),
            abi.encodeCall(vault.renounceOwnership, ()),
            abi.encodeCall(vault.disableBridge, (address(bridge))),
            abi.encodeCall(vault.removeFrontDoor, (BASE, frontDoor)),
            abi.encodeCall(vault.setKeeper, (alice)),
            abi.encodeWithSignature("proposeFrontDoor(uint64,address)", BASE, alice),
            abi.encodeWithSignature("cancelFrontDoorProposal(uint64,address)", BASE, alice),
            abi.encodeWithSignature("proposeGuardian(address)", alice),
            abi.encodeWithSignature("proposeBridge(address)", alice)
        ];
        for (uint256 i; i < meta.length; ++i) {
            vm.prank(owner);
            vm.expectRevert(UnknownSelector.selector);
            vault.schedule(meta[i]);
            assertEq(vaultLens.scheduled(keccak256(meta[i])).readyAt, 0);
        }
    }

    // ---- the front door's activation (Task 7b) ----

    function doorData(uint64 chain, address addr) internal view returns (bytes memory) {
        return abi.encodeCall(vault.activateFrontDoor, (chain, addr));
    }

    function now_() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
    }

    function doorActive(uint64 chain, address addr) internal view returns (bool) {
        return vaultLens.doorState(vaultLens.peerId(chain, addr)) == DoorState.Active;
    }

    /// Whether the owner's schedule of `data` reverts with no data at all (the ABI decoder's refusal).
    function scheduleRevertsBare(bytes memory data) internal returns (bool) {
        vm.prank(owner);
        (bool ok, bytes memory ret) = address(vault).call(abi.encodeCall(vault.schedule, (data)));
        return !ok && ret.length == 0;
    }

    /// A front door's activation is scheduled only: the Registry class (7 days), Ordinary for a door never
    /// active (an owner-removed door's is a Reopen: VaultExitsMachine.t.sol), run only by execute's self-call;
    /// an active door is refused at schedule (AlreadyActive).
    function test_frontDoorActivationIsScheduled() public {
        bytes memory data = doorData(BASE, bob);
        bytes32 id = keccak256(data);
        uint64 t0 = now_();
        vm.expectEmit(address(vault));
        emit Scheduled(id, Kind.Ordinary, vault.activateFrontDoor.selector, t0 + 7 days, data);
        vm.prank(owner);
        assertEq(vault.schedule(data), id);
        Item memory it = vaultLens.scheduled(id);
        assertEq(it.scheduledAt, t0);
        assertEq(it.readyAt, t0 + 7 days);
        assertEq(uint8(it.class), uint8(Delay.Registry));
        assertEq(uint8(it.kind), uint8(Kind.Ordinary));
        assertEq(it.selector, vault.activateFrontDoor.selector);

        // nobody activates a door directly: the owner, the guardian, a stranger, the vault itself
        address[4] memory callers = [owner, guardian, alice, address(vault)];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(NotScheduled.selector);
            vault.activateFrontDoor(BASE, bob);
        }

        Schedule.warpTo(t0 + 7 days - 1);
        vm.prank(owner);
        vm.expectRevert(NotReady.selector);
        vault.execute(data);
        assertFalse(doorActive(BASE, bob));

        Schedule.warpTo(t0 + 7 days);
        vm.expectEmit(address(vault));
        emit FrontDoorActivated(BASE, bob);
        vm.expectEmit(address(vault));
        emit Executed(id);
        vm.prank(owner);
        vault.execute(data);
        assertTrue(doorActive(BASE, bob));
        assertEq(vaultLens.scheduled(id).readyAt, 0);
        // the peer is (chain, address); the same address on another chain is another peer
        assertEq(vaultLens.peerId(BASE, bob), keccak256(abi.encode(uint64(8453), bob)));
        assertFalse(doorActive(BITTENSOR, bob));

        // an active door is refused at schedule: bob now, and the launch door from the deploy
        vm.prank(owner);
        vm.expectRevert(AlreadyActive.selector);
        vault.schedule(data);
        vm.prank(owner);
        vm.expectRevert(AlreadyActive.selector);
        vault.schedule(doorData(BASE, frontDoor));
    }

    /// I-24 for a door's activation (Ordinary): only the owner schedules it; the guardian or the owner
    /// cancels it, a stranger cannot; a cancelled activation never executes.
    function test_frontDoorActivationCancelRights() public {
        bytes memory data = doorData(BASE, carol);
        vm.prank(owner);
        bytes32 id = vault.schedule(data);

        address[2] memory others = [guardian, alice];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, others[i]));
            vault.schedule(doorData(BASE, bob));
        }
        vm.prank(alice);
        vm.expectRevert(NotCanceller.selector);
        vault.cancel(id);

        vm.expectEmit(address(vault));
        emit Cancelled(id, guardian);
        vm.prank(guardian);
        vault.cancel(id);
        assertEq(vaultLens.scheduled(id).readyAt, 0);

        Schedule.warpTo(now_() + 7 days);
        vm.prank(owner);
        vm.expectRevert(NoProposal.selector);
        vault.execute(data);
        assertFalse(doorActive(BASE, carol));

        // the owner cancels it too
        vm.prank(owner);
        id = vault.schedule(data);
        vm.expectEmit(address(vault));
        emit Cancelled(id, owner);
        vm.prank(owner);
        vault.cancel(id);
    }

    /// One door, one calldata, one id (spec §3.10.8): the arguments are exactly two words, decoded with
    /// abi.decode, so dirty upper bits in the chain or in the address revert; a zero door is refused.
    function test_frontDoorActivationDecodesStrictly() public {
        bytes4 sel = vault.activateFrontDoor.selector;
        bytes memory data = doorData(BASE, bob);
        bytes[3] memory bad = [
            abi.encodePacked(data, bytes1(0)), abi.encodePacked(sel, uint256(BASE)), abi.encodePacked(data, uint256(0))
        ];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(owner);
            vm.expectRevert(BadCalldata.selector);
            vault.schedule(bad[i]);
        }

        bytes32 cleanChain = bytes32(uint256(BASE));
        bytes32 cleanDoor = bytes32(uint256(uint160(bob)));
        bytes32 dirtyChain = bytes32(uint256(BASE) | (uint256(1) << 64));
        bytes32 dirtyDoor = bytes32(uint256(uint160(bob)) | (uint256(1) << 160));
        assertEq(abi.encodePacked(sel, cleanChain, cleanDoor), data);
        assertTrue(scheduleRevertsBare(abi.encodePacked(sel, dirtyChain, cleanDoor)), "a dirty chain");
        assertTrue(scheduleRevertsBare(abi.encodePacked(sel, cleanChain, dirtyDoor)), "a dirty door");
        assertEq(vaultLens.scheduled(keccak256(abi.encodePacked(sel, dirtyChain, cleanDoor))).readyAt, 0);
        assertEq(vaultLens.scheduled(keccak256(abi.encodePacked(sel, cleanChain, dirtyDoor))).readyAt, 0);

        vm.prank(owner);
        vm.expectRevert(ZeroAddress.selector);
        vault.schedule(doorData(BASE, address(0)));
    }

    /// Ruling B3 for doors: the activation re-checks AlreadyActive at execute, and the revert leaves the item.
    /// Unreachable through the API (one door has one id, and only its activation activates it), so the door
    /// is written active directly, at the slot the generated layout gives doorState.
    function test_frontDoorAlreadyActiveAtExecute() public {
        bytes memory data = doorData(BASE, bob);
        uint64 t0 = now_();
        vm.prank(owner);
        bytes32 id = vault.schedule(data);

        bytes32 slot = keccak256(abi.encode(vaultLens.peerId(BASE, bob), VaultLayout.SLOT_DOOR_STATE));
        vm.store(address(vault), slot, bytes32(uint256(uint8(DoorState.Active))));
        assertTrue(doorActive(BASE, bob));
        Schedule.warpTo(t0 + 7 days);
        vm.prank(owner);
        vm.expectRevert(AlreadyActive.selector);
        vault.execute(data);
        assertEq(vaultLens.scheduled(id).readyAt, t0 + 7 days);
    }

    /// The front door's analogue of the stale-ticket regression (the 7a review's carry 4): a removed door
    /// comes back only through the scheduler. The legacy proposal cannot be made, the owner's direct
    /// activateFrontDoor is NotScheduled now and after any wait, and a scheduled re-activation waits the
    /// Registry class's 7 days (Schedule.run asserts it is not ready one second earlier), after the same
    /// guardian's swap clears its door hold (Task 10). The guardian removes the door both times, the carry's
    /// sequence.
    function test_aRemovedDoorComesBackOnlyThroughTheScheduler() public {
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, frontDoor);
        vm.prank(owner);
        (bool ok,) = address(vault).call(abi.encodeWithSignature("proposeFrontDoor(uint64,address)", BASE, frontDoor));
        assertFalse(ok, "the legacy proposal");

        address[2] memory callers = [owner, guardian];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(NotScheduled.selector);
            vault.activateFrontDoor(BASE, frontDoor);
        }
        Schedule.warpTo(now_() + 7 days);
        vm.prank(owner);
        vm.expectRevert(NotScheduled.selector);
        vault.activateFrontDoor(BASE, frontDoor);
        assertFalse(doorActive(BASE, frontDoor));

        // the guardian's removal of the launch chain's last door holds the exits (Task 10): its activation, an
        // Ordinary item, schedules once the same guardian's swap has cleared that hold
        Schedule.run(vault, owner, abi.encodeCall(vault.setGuardian, (guardian)));
        Schedule.run(vault, owner, doorData(BASE, frontDoor));
        assertTrue(doorActive(BASE, frontDoor));

        // removed again by the guardian: still no direct way back, for the owner or the guardian
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, frontDoor);
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(NotScheduled.selector);
            vault.activateFrontDoor(BASE, frontDoor);
        }
        assertFalse(doorActive(BASE, frontDoor));
    }

    /// The vault's legacy registries are gone (Task 7b): each entry point, called by the owner, matches no
    /// function and reverts without data, and the lens no longer serves their state; the owner's direct
    /// activateBridge, which the registry's legacy branch once answered, is NotScheduled on the vault too.
    function test_theVaultsLegacyRegistriesAreGone() public {
        StubBridge bridge2 = new StubBridge(bridge.token());
        vm.prank(owner);
        vm.expectRevert(NotScheduled.selector);
        vault.activateBridge(address(bridge2));
        assertFalse(vaultLens.bridgeEnabled(address(bridge2)));
        assertFalse(vaultLens.bridgeKnown(address(bridge2)));

        bytes[7] memory gone = [
            abi.encodeWithSignature("proposeFrontDoor(uint64,address)", BASE, bob),
            abi.encodeWithSignature("cancelFrontDoorProposal(uint64,address)", BASE, bob),
            abi.encodeWithSignature("proposeGuardian(address)", bob),
            abi.encodeWithSignature("acceptGuardian()"),
            abi.encodeWithSignature("cancelGuardianProposal()"),
            abi.encodeWithSignature("proposeBridge(address)", bob),
            abi.encodeWithSignature("cancelBridgeProposal(address)", bob)
        ];
        for (uint256 i; i < gone.length; ++i) {
            vm.prank(owner);
            (bool ok, bytes memory ret) = address(vault).call(gone[i]);
            assertFalse(ok, "a legacy entry point answered");
            assertEq(ret.length, 0);
        }
        bytes[4] memory views = [
            abi.encodeWithSignature("frontDoorProposedAt(bytes32)", vaultLens.peerId(BASE, bob)),
            abi.encodeWithSignature("pendingGuardian()"),
            abi.encodeWithSignature("guardianProposedAt()"),
            abi.encodeWithSignature("bridgeProposedAt(address)", bob)
        ];
        for (uint256 i; i < views.length; ++i) {
            (bool ok,) = address(vaultLens).staticcall(views[i]);
            assertFalse(ok, "the lens serves a removed view");
        }
        assertFalse(doorActive(BASE, bob));
        assertEq(vaultLens.guardian(), guardian);
    }

    /// Carry 3 of the 7a review: the lens reads an item, one slot, with one extsload.
    function test_theLensReadsAnItemInOneExtsload() public {
        bytes memory data = doorData(BASE, bob);
        vm.prank(owner);
        bytes32 id = vault.schedule(data);
        vm.expectCall(address(vault), abi.encodeWithSelector(IExtsload.extsload.selector), 1);
        Item memory it = vaultLens.scheduled(id);
        assertEq(it.readyAt, now_() + 7 days);
        assertEq(it.selector, vault.activateFrontDoor.selector);
    }
}

/// The scheduler on the front door (CascadeBase's, inherited), through the door lens.
contract DoorSchedulerTest is FrontDoorTestBase {
    function test_theDoorSchedulesTheBaseItems() public {
        StubBridge bridge2 = new StubBridge(tao);
        bytes memory data = abi.encodeCall(fd.activateBridge, (address(bridge2)));
        vm.prank(owner);
        bytes32 id = fd.schedule(data);
        assertEq(uint8(doorLens.scheduled(id).class), uint8(Delay.Registry));
        assertEq(uint8(doorLens.scheduled(id).kind), uint8(Kind.Ordinary));
        Schedule.warpTo(vm.getBlockTimestamp() + 7 days);
        vm.prank(owner);
        fd.execute(data);
        assertTrue(doorLens.bridgeEnabled(address(bridge2)));
        assertTrue(doorLens.bridgeKnown(address(bridge2)));
        assertEq(doorLens.scheduled(id).readyAt, 0);

        Schedule.run(fd, owner, abi.encodeCall(fd.transferOwnership, (alice)));
        assertEq(fd.pendingOwner(), alice);
    }

    function test_metaSelectorsAreNotSchedulableOnTheDoor() public {
        bytes[6] memory meta = [
            abi.encodeCall(fd.setPrimaryBridge, (address(bridge))),
            abi.encodeCall(fd.schedule, (abi.encodeCall(fd.setGuardian, (alice)))),
            abi.encodeCall(fd.execute, (abi.encodeCall(fd.setGuardian, (alice)))),
            abi.encodeCall(fd.unpause, ()),
            abi.encodeCall(fd.acceptOwnership, ()),
            abi.encodeCall(fd.disableBridge, (address(bridge)))
        ];
        for (uint256 i; i < meta.length; ++i) {
            vm.prank(owner);
            vm.expectRevert(UnknownSelector.selector);
            fd.schedule(meta[i]);
        }
    }

    /// The front door's bridge registry is gone (Task 7b): the owner's direct activateBridge is NotScheduled,
    /// the legacy entry points match no function, and the door lens no longer serves their state.
    function test_theDoorsLegacyRegistriesAreGone() public {
        StubBridge bridge2 = new StubBridge(tao);
        vm.prank(owner);
        vm.expectRevert(NotScheduled.selector);
        fd.activateBridge(address(bridge2));

        bytes[5] memory gone = [
            abi.encodeWithSignature("proposeBridge(address)", address(bridge2)),
            abi.encodeWithSignature("cancelBridgeProposal(address)", address(bridge2)),
            abi.encodeWithSignature("proposeGuardian(address)", alice),
            abi.encodeWithSignature("acceptGuardian()"),
            abi.encodeWithSignature("cancelGuardianProposal()")
        ];
        for (uint256 round; round < 2; ++round) {
            if (round == 1) Schedule.warpTo(vm.getBlockTimestamp() + 8 days);
            for (uint256 i; i < gone.length; ++i) {
                vm.prank(owner);
                (bool ok, bytes memory ret) = address(fd).call(gone[i]);
                assertFalse(ok, "a legacy entry point answered");
                assertEq(ret.length, 0);
            }
            vm.prank(owner);
            vm.expectRevert(NotScheduled.selector);
            fd.activateBridge(address(bridge2));
        }
        bytes[3] memory views = [
            abi.encodeWithSignature("pendingGuardian()"),
            abi.encodeWithSignature("guardianProposedAt()"),
            abi.encodeWithSignature("bridgeProposedAt(address)", address(bridge2))
        ];
        for (uint256 i; i < views.length; ++i) {
            (bool ok,) = address(doorLens).staticcall(views[i]);
            assertFalse(ok, "the lens serves a removed view");
        }
        assertFalse(doorLens.bridgeEnabled(address(bridge2)));
        assertEq(doorLens.guardian(), guardian);
    }
}
