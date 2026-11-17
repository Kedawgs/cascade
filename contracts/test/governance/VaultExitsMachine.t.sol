// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {Actor, Delay, DoorState, Item, Kind} from "../../src/CascadeTypes.sol";
import {VaultLayout} from "../../src/lens/generated/VaultLayout.sol";
import {
    AlreadyActive,
    ExitsNotOpen,
    FrontDoorInactive,
    InvalidParameter,
    NoProposal,
    NotCanceller,
    NotGuardian,
    NotPending,
    NotReady,
    PeerNotActive,
    UnknownPeer,
    ZeroAddress
} from "../../src/CascadeErrors.sol";
import {
    Cancelled,
    Executed,
    ExitsClosed,
    ExitsReopened,
    FrontDoorActivated,
    FrontDoorRemoved,
    GuardianSet,
    Redeemed,
    Scheduled
} from "../../src/CascadeEvents.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {Schedule} from "./Schedule.sol";

/// Test only: the vault with its `_onGuardianSet` hook callable directly, so the hook's own rule (it clears
/// only a guardian's door hold) is tested apart from the GuardianSwap gate that already keeps setGuardian
/// from running over an owner's hold.
contract VaultHookHarness is CascadeVault {
    constructor(Params memory p) CascadeVault(p) {}

    function runOnGuardianSet() external {
        _onGuardianSet();
    }
}

/// The vault's exits machine (spec §3.6, Task 10): its three recorded holds (CascadeBase's primary disable,
/// the vault's pause and the launch chain's last door's removal), each by the owner or the guardian, the
/// clocks its instruments stamp, the three door states, the door activations' kinds, and the launch-door
/// cancel stamp; read through the vault lens. The fixture's launch chain is BASE, its launch door
/// (BASE, frontDoor), active from the deploy.
contract VaultExitsMachineTest is VaultTestBase {
    uint64 constant OTHER = 10;
    address dave = makeAddr("dave");

    // ---- helpers ----

    function now_() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
    }

    function warpBy(uint256 s) internal {
        Schedule.warpTo(vm.getBlockTimestamp() + s);
    }

    function door(uint64 chain, address addr) internal view returns (bytes memory) {
        return abi.encodeCall(vault.activateFrontDoor, (chain, addr));
    }

    function swap(address g) internal view returns (bytes memory) {
        return abi.encodeCall(vault.setGuardian, (g));
    }

    function stateOf(uint64 chain, address addr) internal view returns (DoorState) {
        return vaultLens.doorState(vaultLens.peerId(chain, addr));
    }

    function assertState(uint64 chain, address addr, DoorState want) internal view {
        assertEq(uint8(stateOf(chain, addr)), uint8(want), "doorState");
    }

    function sched(bytes memory data) internal returns (bytes32 id) {
        vm.prank(owner);
        id = vault.schedule(data);
    }

    function exec(bytes memory data) internal {
        vm.prank(owner);
        vault.execute(data);
    }

    function pending(bytes memory data) internal view returns (uint64) {
        return vaultLens.scheduled(keccak256(data)).readyAt;
    }

    function actorAddress(Actor a) internal view returns (address) {
        return a == Actor.Owner ? owner : guardian;
    }

    /// The three records, the holds and exitsOpen they give (the vault lens's, through CascadeFormulas), both
    /// clocks, and the pause exactly while pausedBy is recorded.
    function assertMachine(Actor primary, Actor pausedBy_, Actor door_, uint64 ownerClock, uint64 guardianClock)
        internal
        view
    {
        assertEq(uint8(vaultLens.primaryDisabledBy()), uint8(primary), "primaryDisabledBy");
        assertEq(uint8(vaultLens.pausedBy()), uint8(pausedBy_), "pausedBy");
        assertEq(uint8(vaultLens.launchDoorRemovedBy()), uint8(door_), "launchDoorRemovedBy");
        bool o = primary == Actor.Owner || pausedBy_ == Actor.Owner || door_ == Actor.Owner;
        bool g = primary == Actor.Guardian || pausedBy_ == Actor.Guardian || door_ == Actor.Guardian;
        assertEq(vaultLens.ownerHold(), o, "ownerHold");
        assertEq(vaultLens.guardianHold(), g, "guardianHold");
        assertEq(vaultLens.exitsOpen(), !o && !g, "exitsOpen");
        assertEq(vaultLens.lastOwnerClose(), ownerClock, "lastOwnerClose");
        assertEq(vaultLens.lastGuardianClose(), guardianClock, "lastGuardianClose");
        assertEq(vault.paused(), pausedBy_ != Actor.None, "paused exactly while pausedBy is recorded");
    }

    /// How many logs of `logs` carry `topic0`.
    function count(Vm.Log[] memory logs, bytes32 topic0) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == topic0) ++n;
        }
    }

    /// A deposit of 10 TAO for alice through door (chain, addr), her shares aged past the door hold (R4 B-H1), then
    /// her redeem of 1e24 shares through it: the queued payout batch's key and its list, from its Redeemed events.
    function queueRedeem(uint64 chain, address addr)
        internal
        returns (bytes32 key, CascadeMessages.Payout[] memory list)
    {
        deliver(chain, addr, ++nextBatchId, entries1(alice, 10e18), noEntries());
        matureShares(alice);
        vm.recordLogs();
        key = deliver(chain, addr, ++nextBatchId, noEntries(), entries1(alice, 1e24));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        list = new CascadeMessages.Payout[](count(logs, Redeemed.selector));
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != Redeemed.selector) continue;
            (uint256 shares, uint256 assets) = abi.decode(logs[i].data, (uint256, uint256));
            list[n++] = CascadeMessages.Payout(address(uint160(uint256(logs[i].topics[2]))), shares, assets);
        }
        assertEq(list.length, 1, "one payout queued");
        assertEq(vaultLens.getPayoutBatch(key).sourceChain, chain);
    }

    // ---- the door states and the launch door's hold ----

    /// Spec §3.6 row 2, SG: the guardian removes the launch chain's last door: it records the guardian
    /// (launchDoorRemovedBy), stamps the guardian's clock and emits ExitsClosed; the door becomes unknown, so
    /// its activation is Ordinary and refused under the guardian's door hold. The owner's setGuardian of the
    /// same guardian (a GuardianSwap, schedulable under a guardian's hold) clears it on day 8, stamping
    /// nothing; the vault then reads OPEN with no door on the launch chain, and the door's Ordinary
    /// activation schedules and runs on day 15.
    function test_guardianRemovesTheLaunchDoor() public {
        uint64 t0 = now_();
        assertState(BASE, frontDoor, DoorState.Active);
        assertEq(vaultLens.activeDoors(BASE), 1);

        vm.expectEmit(address(vault));
        emit FrontDoorRemoved(BASE, frontDoor);
        vm.expectEmit(address(vault));
        emit ExitsClosed(guardian, vault.removeFrontDoor.selector);
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, frontDoor);
        assertState(BASE, frontDoor, DoorState.Unknown);
        assertEq(vaultLens.activeDoors(BASE), 0);
        assertMachine(Actor.None, Actor.None, Actor.Guardian, 0, t0);

        // a second later (so only the gate refuses): the door's activation is Ordinary, refused under the hold
        warpBy(1);
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        vault.schedule(door(BASE, frontDoor));
        assertEq(pending(door(BASE, frontDoor)), 0);

        // the same guardian kept: a GuardianSwap, scheduled under the guardian's hold (I-27)
        bytes memory keep = swap(guardian);
        sched(keep);
        uint64 day0 = now_();
        Schedule.warpTo(day0 + 8 days - 1);
        vm.prank(owner);
        vm.expectRevert(NotReady.selector);
        vault.execute(keep);
        Schedule.warpTo(day0 + 8 days);
        vm.expectEmit(address(vault));
        emit GuardianSet(guardian);
        vm.expectEmit(address(vault));
        emit ExitsReopened(vault.setGuardian.selector);
        vm.expectEmit(address(vault));
        emit Executed(keccak256(keep));
        exec(keep);
        assertEq(vaultLens.guardian(), guardian);
        assertMachine(Actor.None, Actor.None, Actor.None, 0, t0);
        assertState(BASE, frontDoor, DoorState.Unknown);
        assertEq(vaultLens.activeDoors(BASE), 0);

        // OPEN with no door on the launch chain: the door's Ordinary activation (Registry, 7 days)
        bytes memory data = door(BASE, frontDoor);
        bytes32 id = keccak256(data);
        vm.expectEmit(address(vault));
        emit Scheduled(id, Kind.Ordinary, vault.activateFrontDoor.selector, now_() + 7 days, data);
        sched(data);
        assertEq(uint8(vaultLens.scheduled(id).class), uint8(Delay.Registry));
        Schedule.warpTo(day0 + 15 days - 1);
        vm.prank(owner);
        vm.expectRevert(NotReady.selector);
        vault.execute(data);
        Schedule.warpTo(day0 + 15 days);
        vm.recordLogs();
        exec(data);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2, "FrontDoorActivated and Executed: no hold left to clear");
        assertEq(logs[0].topics[0], FrontDoorActivated.selector);
        assertEq(logs[1].topics[0], Executed.selector);
        assertState(BASE, frontDoor, DoorState.Active);
        assertEq(vaultLens.activeDoors(BASE), 1);
        assertMachine(Actor.None, Actor.None, Actor.None, 0, t0);

        // and it delivers again
        depositVia(alice, 1e18);
        assertEq(vault.balanceOf(alice), 1e24);
    }

    /// Spec §3.6 row 2, HO: the owner's removal of the launch chain's last door records the owner and stamps
    /// the owner's clock; the door stays known (Removed), so its re-activation is a Reopen: schedulable under
    /// the owner's own hold (no gate), which refuses an Ordinary item and a swap; cancellable by the owner
    /// only (I-24); a guardian's instrument does not kill it (it reads the owner's clock). It clears the hold
    /// when it runs, stamping nothing.
    function test_ownerRemovalIsReopenable() public {
        uint64 t0 = now_();
        vm.expectEmit(address(vault));
        emit FrontDoorRemoved(BASE, frontDoor);
        vm.expectEmit(address(vault));
        emit ExitsClosed(owner, vault.removeFrontDoor.selector);
        vm.prank(owner);
        vault.removeFrontDoor(BASE, frontDoor);
        assertState(BASE, frontDoor, DoorState.Removed);
        assertEq(vaultLens.activeDoors(BASE), 0);
        assertMachine(Actor.None, Actor.None, Actor.Owner, t0, 0);

        warpBy(1);
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        vault.schedule(door(BASE, bob));
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        vault.schedule(swap(carol));

        bytes memory data = door(BASE, frontDoor);
        bytes32 id = keccak256(data);
        uint64 t1 = now_();
        vm.expectEmit(address(vault));
        emit Scheduled(id, Kind.Reopen, vault.activateFrontDoor.selector, t1 + 7 days, data);
        sched(data);
        Item memory it = vaultLens.scheduled(id);
        assertEq(uint8(it.kind), uint8(Kind.Reopen));
        assertEq(uint8(it.class), uint8(Delay.Registry));
        vm.prank(guardian);
        vm.expectRevert(NotCanceller.selector);
        vault.cancel(id);
        vm.prank(alice);
        vm.expectRevert(NotCanceller.selector);
        vault.cancel(id);

        // the guardian's pause: its hold and its clock, which a Reopen does not read
        warpBy(1 hours);
        uint64 tg = now_();
        vm.prank(guardian);
        vault.pause();
        assertMachine(Actor.None, Actor.Guardian, Actor.Owner, t0, tg);

        Schedule.warpTo(t1 + 7 days);
        vm.expectEmit(address(vault));
        emit FrontDoorActivated(BASE, frontDoor);
        vm.expectEmit(address(vault));
        emit ExitsReopened(vault.activateFrontDoor.selector);
        vm.expectEmit(address(vault));
        emit Executed(id);
        exec(data);
        assertState(BASE, frontDoor, DoorState.Active);
        assertEq(vaultLens.activeDoors(BASE), 1);
        assertMachine(Actor.None, Actor.Guardian, Actor.None, t0, tg);
        vm.prank(owner);
        vault.unpause();
        assertMachine(Actor.None, Actor.None, Actor.None, t0, tg);
    }

    /// The owner's Reopen of a door it removed dies to a later owner instrument (the owner's pause stamps the
    /// owner's clock), as every owner-clock item does; re-scheduled after it, it runs.
    function test_aDoorsReopenDiesToAnOwnerInstrument() public {
        vm.prank(owner);
        vault.removeFrontDoor(BASE, frontDoor);
        warpBy(1);
        bytes memory data = door(BASE, frontDoor);
        sched(data);
        uint64 t1 = now_();
        warpBy(1 hours);
        vm.prank(owner);
        vault.pause();
        vm.prank(owner);
        vault.unpause();
        Schedule.warpTo(t1 + 7 days);
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        vault.execute(data);
        assertState(BASE, frontDoor, DoorState.Removed);

        Schedule.run(vault, owner, data);
        assertState(BASE, frontDoor, DoorState.Active);
        assertEq(uint8(vaultLens.launchDoorRemovedBy()), uint8(Actor.None));
    }

    /// The extra security test: a guardian's removal, then the owner's of the same door. Spec §3.6: "removeFrontDoor
    /// of the launch chain's last active door | owner or guardian | launchDoorRemovedBy (activeDoors[launchChain]
    /// reaches 0); a guardian's removal of any door also makes it unknown | the remover's clock". The door is no
    /// longer active, so the owner's removal reverts PeerNotActive: the door stays Unknown, the guardian stays
    /// recorded and only its clock is stamped; the owner can neither turn the guardian's hold into its own nor
    /// the door's Ordinary way back into a Reopen. The reverse is not symmetric (Task 10b): after the owner's
    /// removal the guardian's makes the removal its own: the door unknown, the launch door's hold and a fresh
    /// stamp the guardian's (test_theGuardianMakesTheOwnersLaunchDoorHoldItsOwn), and the owner still cannot
    /// take it back.
    function test_aGuardiansRemovalThenTheOwners() public {
        uint64 t0 = now_();
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, frontDoor);
        warpBy(1 hours);
        vm.prank(owner);
        vm.expectRevert(PeerNotActive.selector);
        vault.removeFrontDoor(BASE, frontDoor);
        assertState(BASE, frontDoor, DoorState.Unknown);
        assertEq(vaultLens.activeDoors(BASE), 0);
        assertMachine(Actor.None, Actor.None, Actor.Guardian, 0, t0);

        // cleared by the same guardian's swap, the door back by its Ordinary activation, then the reverse
        Schedule.run(vault, owner, swap(guardian));
        Schedule.run(vault, owner, door(BASE, frontDoor));
        uint64 t1 = now_();
        vm.prank(owner);
        vault.removeFrontDoor(BASE, frontDoor);
        assertMachine(Actor.None, Actor.None, Actor.Owner, t1, t0);
        warpBy(1 hours);
        uint64 t2 = now_();
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, frontDoor);
        assertState(BASE, frontDoor, DoorState.Unknown);
        assertEq(vaultLens.activeDoors(BASE), 0);
        assertMachine(Actor.None, Actor.None, Actor.Guardian, t1, t2);
        vm.prank(owner);
        vm.expectRevert(PeerNotActive.selector);
        vault.removeFrontDoor(BASE, frontDoor);
        assertState(BASE, frontDoor, DoorState.Unknown);
        assertMachine(Actor.None, Actor.None, Actor.Guardian, t1, t2);
    }

    /// A door other than the launch chain's last: its removal records and stamps nothing, by either actor
    /// (the guardian's still makes it unknown, the owner's Removed), and an Ordinary item pending through both
    /// removals executes. The launch chain's last door then records and stamps.
    function test_nonLastDoorRemovalStampsNothing() public {
        registerFrontDoor(BASE, bob);
        registerFrontDoor(BASE, carol);
        assertEq(vaultLens.activeDoors(BASE), 3);
        warpBy(1);
        bytes memory item = door(OTHER, alice);
        sched(item);
        uint64 ts = now_();

        warpBy(1 hours);
        vm.recordLogs();
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, bob);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "FrontDoorRemoved alone");
        assertEq(logs[0].topics[0], FrontDoorRemoved.selector);
        assertState(BASE, bob, DoorState.Unknown);
        assertEq(vaultLens.activeDoors(BASE), 2);
        assertMachine(Actor.None, Actor.None, Actor.None, 0, 0);

        vm.recordLogs();
        vm.prank(owner);
        vault.removeFrontDoor(BASE, carol);
        logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "FrontDoorRemoved alone");
        assertState(BASE, carol, DoorState.Removed);
        assertEq(vaultLens.activeDoors(BASE), 1);
        assertMachine(Actor.None, Actor.None, Actor.None, 0, 0);

        Schedule.warpTo(ts + 7 days);
        exec(item);
        assertState(OTHER, alice, DoorState.Active);

        uint64 t = now_();
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, frontDoor);
        assertEq(vaultLens.activeDoors(BASE), 0);
        assertMachine(Actor.None, Actor.None, Actor.Guardian, 0, t);
    }

    /// Spec §3.6: "Removing a second chain's last door records and stamps nothing (only the launch chain is in
    /// the machine)": by the guardian (the door becomes unknown) and, once it is back, by the owner (Removed),
    /// with an Ordinary item pending through both.
    function test_secondChainsLastDoorStampsNothing() public {
        registerFrontDoor(OTHER, bob);
        assertEq(vaultLens.activeDoors(OTHER), 1);
        warpBy(1);
        bytes memory item = door(BASE, carol);
        sched(item);
        uint64 ts = now_();

        warpBy(1 hours);
        vm.recordLogs();
        vm.prank(guardian);
        vault.removeFrontDoor(OTHER, bob);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "FrontDoorRemoved alone");
        assertEq(logs[0].topics[0], FrontDoorRemoved.selector);
        assertEq(vaultLens.activeDoors(OTHER), 0);
        assertState(OTHER, bob, DoorState.Unknown);
        assertMachine(Actor.None, Actor.None, Actor.None, 0, 0);

        // back by an Ordinary activation (exits open), then removed by the owner
        registerFrontDoor(OTHER, bob);
        vm.recordLogs();
        vm.prank(owner);
        vault.removeFrontDoor(OTHER, bob);
        logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "FrontDoorRemoved alone");
        assertEq(vaultLens.activeDoors(OTHER), 0);
        assertState(OTHER, bob, DoorState.Removed);
        assertMachine(Actor.None, Actor.None, Actor.None, 0, 0);

        exec(item);
        assertEq(vaultLens.activeDoors(BASE), 2);
        assertGe(now_(), ts + 7 days);
    }

    /// An active door's activation is refused at schedule (the launch door's from the deploy included) and,
    /// ruling B3, at execute: unreachable through the API (one door, one calldata, one id), so the door is
    /// written active at the generated slot; the revert leaves the item and the count is never taken twice.
    function test_doubleActivationAlreadyActive() public {
        vm.prank(owner);
        vm.expectRevert(AlreadyActive.selector);
        vault.schedule(door(BASE, frontDoor));
        registerFrontDoor(BASE, bob);
        assertEq(vaultLens.activeDoors(BASE), 2);
        vm.prank(owner);
        vm.expectRevert(AlreadyActive.selector);
        vault.schedule(door(BASE, bob));

        bytes memory data = door(BASE, carol);
        uint64 t0 = now_();
        bytes32 id = sched(data);
        bytes32 slot = keccak256(abi.encode(vaultLens.peerId(BASE, carol), VaultLayout.SLOT_DOOR_STATE));
        vm.store(address(vault), slot, bytes32(uint256(uint8(DoorState.Active))));
        assertState(BASE, carol, DoorState.Active);
        Schedule.warpTo(t0 + 7 days);
        vm.prank(owner);
        vm.expectRevert(AlreadyActive.selector);
        vault.execute(data);
        assertEq(vaultLens.scheduled(id).readyAt, t0 + 7 days, "the item stays");
        assertEq(vaultLens.activeDoors(BASE), 2, "never counted twice");
    }

    /// activeDoors never underflows and never double counts: removing a door that is not active (never
    /// active, removed by the guardian, or on a chain with no door) reverts PeerNotActive by either actor,
    /// and a door the owner removed by the owner, changing nothing; the guardian's removal of an
    /// owner-removed door (Task 10b) makes it unknown without counting it out again; each activation counts
    /// once, each door is counted out once.
    function test_activeDoorsNeverUnderflowsOrDoubleCounts() public {
        address[2] memory actors = [owner, guardian];
        for (uint256 i; i < 2; ++i) {
            vm.prank(actors[i]);
            vm.expectRevert(PeerNotActive.selector);
            vault.removeFrontDoor(BASE, bob);
            vm.prank(actors[i]);
            vm.expectRevert(PeerNotActive.selector);
            vault.removeFrontDoor(OTHER, bob);
        }
        assertEq(vaultLens.activeDoors(BASE), 1);
        assertEq(vaultLens.activeDoors(OTHER), 0);

        registerFrontDoor(BASE, bob);
        registerFrontDoor(BASE, carol);
        registerFrontDoor(BASE, dave);
        assertEq(vaultLens.activeDoors(BASE), 4);
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, bob);
        vm.startPrank(owner);
        vault.removeFrontDoor(BASE, carol);
        vault.removeFrontDoor(BASE, dave);
        vm.stopPrank();
        assertEq(vaultLens.activeDoors(BASE), 1);
        for (uint256 i; i < 2; ++i) {
            vm.prank(actors[i]);
            vm.expectRevert(PeerNotActive.selector);
            vault.removeFrontDoor(BASE, bob);
        }
        vm.prank(owner);
        vm.expectRevert(PeerNotActive.selector);
        vault.removeFrontDoor(BASE, carol);

        // the guardian makes the owner's removal of dave its own: unknown, not counted out again
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, dave);
        assertEq(vaultLens.activeDoors(BASE), 1);
        for (uint256 i; i < 2; ++i) {
            vm.prank(actors[i]);
            vm.expectRevert(PeerNotActive.selector);
            vault.removeFrontDoor(BASE, dave);
        }
        assertEq(vaultLens.activeDoors(BASE), 1);
        assertState(BASE, bob, DoorState.Unknown);
        assertState(BASE, carol, DoorState.Removed);
        assertState(BASE, dave, DoorState.Unknown);
        assertMachine(Actor.None, Actor.None, Actor.None, 0, 0);

        // bob and dave back by Ordinary items, carol by a Reopen: each counts once
        warpBy(1);
        assertEq(uint8(vaultLens.scheduled(sched(door(BASE, bob))).kind), uint8(Kind.Ordinary));
        assertEq(uint8(vaultLens.scheduled(sched(door(BASE, carol))).kind), uint8(Kind.Reopen));
        assertEq(uint8(vaultLens.scheduled(sched(door(BASE, dave))).kind), uint8(Kind.Ordinary));
        warpBy(7 days);
        exec(door(BASE, bob));
        exec(door(BASE, carol));
        exec(door(BASE, dave));
        assertEq(vaultLens.activeDoors(BASE), 4);
        assertEq(vaultLens.activeDoors(OTHER), 0);
    }

    /// The 7b review's carry: an activation on chain 0 is refused (InvalidParameter), as the constructor refuses a
    /// zero launch chain: at schedule, storing nothing, and again at execute, where an item for it can only be
    /// written directly (schedule never stores one); the revert leaves the item.
    function test_activationRefusesChainZero() public {
        bytes memory data = door(0, bob);
        vm.prank(owner);
        vm.expectRevert(InvalidParameter.selector);
        vault.schedule(data);
        assertEq(pending(data), 0);
        // the zero door is still the zero door's refusal on any other chain
        vm.prank(owner);
        vm.expectRevert(ZeroAddress.selector);
        vault.schedule(door(BASE, address(0)));

        bytes32 id = keccak256(data);
        uint64 t = now_();
        uint256 word = uint256(t) << (VaultLayout.ITEM_SCHEDULED_AT_OFFSET * 8) | uint256(t + 7 days)
            << (VaultLayout.ITEM_READY_AT_OFFSET * 8) | uint256(uint8(Delay.Registry))
            << (VaultLayout.ITEM_CLASS_OFFSET * 8) | uint256(uint8(Kind.Ordinary)) << (VaultLayout.ITEM_KIND_OFFSET * 8)
            | uint256(uint32(vault.activateFrontDoor.selector)) << (VaultLayout.ITEM_SELECTOR_OFFSET * 8);
        vm.store(address(vault), keccak256(abi.encode(id, VaultLayout.SLOT_SCHEDULED)), bytes32(word));
        assertEq(pending(data), t + 7 days);
        Schedule.warpTo(t + 7 days);
        vm.prank(owner);
        vm.expectRevert(InvalidParameter.selector);
        vault.execute(data);
        assertEq(pending(data), t + 7 days, "the item stays");
        assertState(0, bob, DoorState.Unknown);
        assertEq(vaultLens.activeDoors(0), 0);
    }

    /// No pending activation ever names an active door (spec §3.6): an active door's activation cannot be
    /// scheduled, a pending one is deleted before it activates its door, and after the guardian's removals
    /// (a second door, then the launch door) nothing scheduled earlier names either: the way back is a fresh
    /// Ordinary item, refused under the guardian's door hold.
    function test_noPendingActivationNamesAnActiveDoor() public {
        bytes memory launch = door(BASE, frontDoor);
        bytes memory second = door(BASE, bob);
        vm.prank(owner);
        vm.expectRevert(AlreadyActive.selector);
        vault.schedule(launch);
        assertEq(pending(launch), 0);

        sched(second);
        assertState(BASE, bob, DoorState.Unknown);
        warpBy(7 days);
        exec(second);
        assertState(BASE, bob, DoorState.Active);
        assertEq(pending(second), 0, "deleted before it activated the door");

        vm.prank(guardian);
        vault.removeFrontDoor(BASE, bob);
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, frontDoor);
        assertEq(pending(launch), 0);
        assertEq(pending(second), 0);
        warpBy(1);
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        vault.schedule(launch);
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        vault.schedule(second);
    }

    /// Only an activation on the launch chain clears the launch door's hold: another chain's (here the Reopen of
    /// a door the owner removed there, which schedules and runs under any hold) leaves the guardian's hold and
    /// then the owner's as they were, emitting no ExitsReopened.
    function test_anotherChainsActivationLeavesTheLaunchDoorHold() public {
        registerFrontDoor(OTHER, bob);
        vm.prank(owner);
        vault.removeFrontDoor(OTHER, bob);
        uint64 t0 = now_();
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, frontDoor);
        assertMachine(Actor.None, Actor.None, Actor.Guardian, 0, t0);

        warpBy(1);
        bytes memory reopen = door(OTHER, bob);
        assertEq(uint8(vaultLens.scheduled(sched(reopen)).kind), uint8(Kind.Reopen));
        warpBy(7 days);
        vm.recordLogs();
        exec(reopen);
        assertEq(count(vm.getRecordedLogs(), ExitsReopened.selector), 0);
        assertState(OTHER, bob, DoorState.Active);
        assertMachine(Actor.None, Actor.None, Actor.Guardian, 0, t0);

        // the owner's hold likewise: the guardian's cleared by the swap, the door back, then the owner's removal
        Schedule.run(vault, owner, swap(guardian));
        Schedule.run(vault, owner, door(BASE, frontDoor));
        vm.prank(owner);
        vault.removeFrontDoor(OTHER, bob);
        uint64 t1 = now_();
        vm.prank(owner);
        vault.removeFrontDoor(BASE, frontDoor);
        warpBy(1);
        sched(reopen);
        warpBy(7 days);
        exec(reopen);
        assertState(OTHER, bob, DoorState.Active);
        assertMachine(Actor.None, Actor.None, Actor.Owner, t1, t0);
    }

    /// A removed door, whoever removed it (Unknown or Removed), neither delivers (UnknownPeer) nor is paid
    /// (FrontDoorInactive): only Active counts. Its queued batch can still be cancelled.
    function test_aRemovedDoorNeitherDeliversNorIsPaid() public {
        (bytes32 key, CascadeMessages.Payout[] memory list) = queueRedeem(BASE, frontDoor);
        registerFrontDoor(BASE, bob);
        uint256 snap = vm.snapshotState();
        address[2] memory removers = [guardian, owner];
        DoorState[2] memory states = [DoorState.Unknown, DoorState.Removed];
        for (uint256 i; i < 2; ++i) {
            vm.revertToState(snap);
            vm.prank(removers[i]);
            vault.removeFrontDoor(BASE, frontDoor);
            assertState(BASE, frontDoor, states[i]);
            vm.expectRevert(UnknownPeer.selector);
            deliver(BASE, frontDoor, ++nextBatchId, entries1(alice, 1e18), noEntries());
            vm.expectRevert(FrontDoorInactive.selector);
            vault.processPayouts(key, list, 10);
            vm.prank(owner);
            vault.cancelPayoutBatch(key, list);
            assertEq(vaultLens.getPayoutBatch(key).count, 0);
        }
    }

    /// The guardian may cancel a guardian-removed door's activation (Ordinary, I-24), not an owner-removed
    /// door's (a Reopen).
    function test_doorActivationCancelRightsFollowItsKind() public {
        registerFrontDoor(BASE, bob);
        registerFrontDoor(BASE, carol);
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, bob);
        vm.prank(owner);
        vault.removeFrontDoor(BASE, carol);
        warpBy(1);
        bytes32 ordinary = sched(door(BASE, bob));
        bytes32 reopen = sched(door(BASE, carol));
        vm.prank(guardian);
        vault.cancel(ordinary);
        assertEq(vaultLens.scheduled(ordinary).readyAt, 0);
        vm.prank(guardian);
        vm.expectRevert(NotCanceller.selector);
        vault.cancel(reopen);
        vm.prank(owner);
        vault.cancel(reopen);
        assertEq(vaultLens.scheduled(reopen).readyAt, 0);
    }

    // ---- the guardian makes an owner's door removal its own (Task 10b) ----

    /// The topics of `log`, checked: its event and its two indexed arguments.
    function assertLog(Vm.Log memory log, bytes32 topic0, bytes32 topic1, bytes32 topic2) internal pure {
        assertEq(log.topics[0], topic0, "event");
        assertEq(log.topics[1], topic1, "first indexed argument");
        assertEq(log.topics[2], topic2, "second indexed argument");
    }

    function topicOf(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    /// The review's P1, closed (spec §3.6: "a stolen owner key cannot bring it back past an honest
    /// guardian"). The owner (a stolen key) removes an active rogue door before the guardian can: the door is
    /// Removed and its Reopen (no gate, owner-only cancel) is pending; a second removal by the owner is
    /// refused (PeerNotActive), leaving the Reopen. The guardian's removal of the Removed door makes it
    /// unknown and deletes that Reopen (Cancelled, by the guardian), so its execute finds nothing; the door is
    /// not counted out again and, being a second launch-chain door, nothing is recorded or stamped. Its way
    /// back is then Ordinary: refused under a hold, schedulable from OPEN, and the guardian's to cancel.
    function test_theGuardianMakesAnOwnersRemovalItsOwn() public {
        registerFrontDoor(BASE, bob);
        vm.prank(owner);
        vault.removeFrontDoor(BASE, bob);
        assertState(BASE, bob, DoorState.Removed);
        assertEq(vaultLens.activeDoors(BASE), 1);
        warpBy(1);
        bytes memory data = door(BASE, bob);
        bytes32 id = sched(data);
        uint64 t1 = now_();
        assertEq(uint8(vaultLens.scheduled(id).kind), uint8(Kind.Reopen));
        vm.prank(guardian);
        vm.expectRevert(NotCanceller.selector);
        vault.cancel(id);
        // the owner's removal of its own Removed door is refused: the second removal is the guardian's alone
        vm.prank(owner);
        vm.expectRevert(PeerNotActive.selector);
        vault.removeFrontDoor(BASE, bob);
        assertEq(pending(data), t1 + 7 days, "the Reopen stays");

        warpBy(1 hours);
        vm.recordLogs();
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, bob);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2, "Cancelled and FrontDoorRemoved, nothing recorded");
        assertLog(logs[0], Cancelled.selector, id, topicOf(guardian));
        assertLog(logs[1], FrontDoorRemoved.selector, bytes32(uint256(BASE)), topicOf(bob));
        assertState(BASE, bob, DoorState.Unknown);
        assertEq(vaultLens.activeDoors(BASE), 1, "counted out once, by the owner's removal");
        assertMachine(Actor.None, Actor.None, Actor.None, 0, 0);
        assertEq(pending(data), 0, "the Reopen is deleted");
        Schedule.warpTo(t1 + 7 days);
        vm.prank(owner);
        vm.expectRevert(NoProposal.selector);
        vault.execute(data);
        assertState(BASE, bob, DoorState.Unknown);
        assertEq(vaultLens.activeDoors(BASE), 1);

        // the way back is Ordinary: refused under a hold (the guardian's pause), then from OPEN schedulable
        // and cancelled by the guardian; nothing is left to convert
        uint64 tp = now_();
        vm.prank(guardian);
        vault.pause();
        warpBy(1);
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        vault.schedule(data);
        vm.prank(owner);
        vault.unpause();
        warpBy(1);
        vm.expectEmit(address(vault));
        emit Scheduled(id, Kind.Ordinary, vault.activateFrontDoor.selector, now_() + 7 days, data);
        sched(data);
        vm.prank(guardian);
        vault.cancel(id);
        assertEq(pending(data), 0);
        vm.prank(guardian);
        vm.expectRevert(PeerNotActive.selector);
        vault.removeFrontDoor(BASE, bob);
        assertMachine(Actor.None, Actor.None, Actor.None, 0, tp);
    }

    /// The owner's hold on the launch door, made the guardian's. The owner removes the launch chain's last
    /// door (its record, its clock) and schedules the door's Reopen; the guardian's removal of the Removed
    /// door makes it unknown, deletes the Reopen and makes the launch door's hold its own: the record and its
    /// clock, with ExitsClosed, as had it removed the door itself (spec §3.6 instruments table, "the remover's
    /// clock"; row 2 SG). Were the owner's record left, nothing could clear it: no Removed launch-chain door is
    /// left for a Reopen, and the owner's hold refuses the Ordinary activation and the swap (I-26). From here
    /// the way back is row 2 SG's: the swap on day 8 (schedulable under the guardian's hold, I-27), then the
    /// door's Ordinary activation, the guardian's to cancel, on day 15.
    function test_theGuardianMakesTheOwnersLaunchDoorHoldItsOwn() public {
        uint64 t0 = now_();
        vm.prank(owner);
        vault.removeFrontDoor(BASE, frontDoor);
        assertMachine(Actor.None, Actor.None, Actor.Owner, t0, 0);
        warpBy(1);
        bytes memory data = door(BASE, frontDoor);
        bytes32 id = sched(data);
        uint64 t1 = now_();
        assertEq(uint8(vaultLens.scheduled(id).kind), uint8(Kind.Reopen));

        warpBy(1 hours);
        uint64 tg = now_();
        vm.recordLogs();
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, frontDoor);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 3, "Cancelled, FrontDoorRemoved and ExitsClosed");
        assertLog(logs[0], Cancelled.selector, id, topicOf(guardian));
        assertLog(logs[1], FrontDoorRemoved.selector, bytes32(uint256(BASE)), topicOf(frontDoor));
        assertLog(logs[2], ExitsClosed.selector, topicOf(guardian), bytes32(vault.removeFrontDoor.selector));
        assertState(BASE, frontDoor, DoorState.Unknown);
        assertEq(vaultLens.activeDoors(BASE), 0);
        assertMachine(Actor.None, Actor.None, Actor.Guardian, t0, tg);
        assertEq(pending(data), 0, "the Reopen is deleted");
        Schedule.warpTo(t1 + 7 days);
        vm.prank(owner);
        vm.expectRevert(NoProposal.selector);
        vault.execute(data);

        // under the guardian's hold the Ordinary activation is refused and the swap schedules
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        vault.schedule(data);
        Schedule.run(vault, owner, swap(guardian));
        assertMachine(Actor.None, Actor.None, Actor.None, t0, tg);
        assertState(BASE, frontDoor, DoorState.Unknown);

        // OPEN: the Ordinary activation, the guardian's to cancel; scheduled again, it runs
        bytes32 again = sched(data);
        assertEq(uint8(vaultLens.scheduled(again).kind), uint8(Kind.Ordinary));
        vm.prank(guardian);
        vault.cancel(again);
        Schedule.run(vault, owner, data);
        assertState(BASE, frontDoor, DoorState.Active);
        assertEq(vaultLens.activeDoors(BASE), 1);
        assertMachine(Actor.None, Actor.None, Actor.None, t0, tg);
    }

    /// The launch door's hold moves only on the launch chain. Under the owner's launch-door hold, the
    /// guardian's removal of another chain's owner-removed door makes it unknown and leaves the hold the
    /// owner's (FrontDoorRemoved alone: no item pending, nothing recorded or stamped). Its removal of a second
    /// owner-removed launch-chain door makes the hold its own (which door's removal made the record is not
    /// kept); the launch door's own Reopen, which reads only the owner's clock and still finds its door
    /// Removed, survives and clears the hold when it runs.
    function test_theLaunchDoorHoldMovesOnlyOnTheLaunchChain() public {
        registerFrontDoor(OTHER, carol);
        registerFrontDoor(BASE, bob);
        uint64 t0 = now_();
        vm.startPrank(owner);
        vault.removeFrontDoor(OTHER, carol);
        vault.removeFrontDoor(BASE, bob);
        vault.removeFrontDoor(BASE, frontDoor);
        vm.stopPrank();
        assertMachine(Actor.None, Actor.None, Actor.Owner, t0, 0);
        warpBy(1);
        bytes memory reopen = door(BASE, frontDoor);
        sched(reopen);
        uint64 t1 = now_();

        warpBy(1 hours);
        vm.recordLogs();
        vm.prank(guardian);
        vault.removeFrontDoor(OTHER, carol);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "FrontDoorRemoved alone");
        assertLog(logs[0], FrontDoorRemoved.selector, bytes32(uint256(OTHER)), topicOf(carol));
        assertState(OTHER, carol, DoorState.Unknown);
        assertMachine(Actor.None, Actor.None, Actor.Owner, t0, 0);

        warpBy(1 hours);
        uint64 tg = now_();
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, bob);
        assertState(BASE, bob, DoorState.Unknown);
        assertState(BASE, frontDoor, DoorState.Removed);
        assertMachine(Actor.None, Actor.None, Actor.Guardian, t0, tg);
        assertEq(pending(reopen), t1 + 7 days, "the launch door's Reopen is another door's");

        Schedule.warpTo(t1 + 7 days);
        vm.expectEmit(address(vault));
        emit ExitsReopened(vault.activateFrontDoor.selector);
        exec(reopen);
        assertState(BASE, frontDoor, DoorState.Active);
        assertMachine(Actor.None, Actor.None, Actor.None, t0, tg);
    }

    /// The ruling's item 3: the owner's removal of an unknown door stays refused (PeerNotActive), so the owner
    /// can never turn the guardian's Unknown back into its own Removed (and the door's Ordinary way back into
    /// a Reopen): a door never active, one the guardian removed, and one whose owner removal the guardian
    /// made its own. The guardian's removal of an unknown door is refused too, and a stranger's of a Removed
    /// door is NotGuardian. Nothing changes, and every one of these doors comes back only by an Ordinary item.
    function test_theOwnerCannotMakeAnUnknownDoorRemoved() public {
        registerFrontDoor(BASE, bob);
        registerFrontDoor(BASE, carol);
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, bob);
        vm.prank(owner);
        vault.removeFrontDoor(BASE, carol);
        vm.prank(alice);
        vm.expectRevert(NotGuardian.selector);
        vault.removeFrontDoor(BASE, carol);
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, carol);

        address[3] memory doors = [bob, carol, dave];
        address[2] memory actors = [owner, guardian];
        for (uint256 i; i < 3; ++i) {
            for (uint256 j; j < 2; ++j) {
                vm.prank(actors[j]);
                vm.expectRevert(PeerNotActive.selector);
                vault.removeFrontDoor(BASE, doors[i]);
            }
            assertState(BASE, doors[i], DoorState.Unknown);
        }
        assertEq(vaultLens.activeDoors(BASE), 1);
        assertMachine(Actor.None, Actor.None, Actor.None, 0, 0);
        warpBy(1);
        for (uint256 i; i < 3; ++i) {
            assertEq(uint8(vaultLens.scheduled(sched(door(BASE, doors[i]))).kind), uint8(Kind.Ordinary));
        }
    }

    /// The review's P2, pinned (spec §3.6's instruments table: any activation on the launch chain clears the
    /// launch door's hold). Under the guardian's hold on the launch door, the Reopen of a different
    /// owner-removed launch-chain door (no gate: schedulable under the hold) clears the guardian's hold when it
    /// runs, with the launch door still unknown. The guardian's answer: removing the reopened door, the launch
    /// chain's last again, which records its hold and stamps its clock once more. Or, before the Reopen runs,
    /// making that door's removal its own: the Reopen is deleted, and its hold, already the guardian's, stays
    /// as it was (no ExitsClosed, no stamp).
    function test_aReopenOfAnotherLaunchDoorClearsTheGuardiansHold() public {
        registerFrontDoor(BASE, bob);
        vm.prank(owner);
        vault.removeFrontDoor(BASE, bob);
        warpBy(1);
        uint64 tg = now_();
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, frontDoor);
        assertMachine(Actor.None, Actor.None, Actor.Guardian, 0, tg);
        warpBy(1);
        bytes memory reopen = door(BASE, bob);
        bytes32 id = sched(reopen);
        uint64 t1 = now_();
        assertEq(uint8(vaultLens.scheduled(id).kind), uint8(Kind.Reopen));
        uint256 snap = vm.snapshotState();

        Schedule.warpTo(t1 + 7 days);
        vm.expectEmit(address(vault));
        emit FrontDoorActivated(BASE, bob);
        vm.expectEmit(address(vault));
        emit ExitsReopened(vault.activateFrontDoor.selector);
        vm.expectEmit(address(vault));
        emit Executed(id);
        exec(reopen);
        assertState(BASE, bob, DoorState.Active);
        assertState(BASE, frontDoor, DoorState.Unknown);
        assertMachine(Actor.None, Actor.None, Actor.None, 0, tg);

        warpBy(1 hours);
        uint64 tg2 = now_();
        vm.expectEmit(address(vault));
        emit ExitsClosed(guardian, vault.removeFrontDoor.selector);
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, bob);
        assertState(BASE, bob, DoorState.Unknown);
        assertEq(vaultLens.activeDoors(BASE), 0);
        assertMachine(Actor.None, Actor.None, Actor.Guardian, 0, tg2);
        warpBy(1);
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        vault.schedule(reopen);

        // or, before the Reopen runs: the guardian makes bob's removal its own
        vm.revertToState(snap);
        Schedule.warpTo(t1 + 1 hours);
        vm.recordLogs();
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, bob);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2, "Cancelled and FrontDoorRemoved: the hold is already the guardian's");
        assertLog(logs[0], Cancelled.selector, id, topicOf(guardian));
        assertState(BASE, bob, DoorState.Unknown);
        assertMachine(Actor.None, Actor.None, Actor.Guardian, 0, tg);
        Schedule.warpTo(t1 + 7 days);
        vm.prank(owner);
        vm.expectRevert(NoProposal.selector);
        vault.execute(reopen);
        assertMachine(Actor.None, Actor.None, Actor.Guardian, 0, tg);
    }

    // ---- setGuardian clears only a guardian's door hold (ruling B16d) ----

    /// Through the API a swap never runs over an owner's door hold: the owner's removal stamps the owner's
    /// clock, killing a swap pending from before, and under the hold no swap schedules. Under the guardian's
    /// door hold and the guardian's pause together, the swap clears the door hold alone: the pause stays
    /// recorded until the owner unpauses.
    function test_setGuardianClearsOnlyAGuardiansDoorHold() public {
        bytes memory keep = swap(guardian);
        sched(keep);
        uint64 ts = now_();
        warpBy(1 hours);
        vm.prank(owner);
        vault.removeFrontDoor(BASE, frontDoor);
        Schedule.warpTo(ts + 8 days);
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        vault.execute(keep);
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        vault.schedule(keep);
        assertEq(uint8(vaultLens.launchDoorRemovedBy()), uint8(Actor.Owner));

        // the owner's Reopen back; then the guardian's pause and removal
        Schedule.run(vault, owner, door(BASE, frontDoor));
        uint64 tg = now_();
        vm.startPrank(guardian);
        vault.pause();
        vault.removeFrontDoor(BASE, frontDoor);
        vm.stopPrank();
        uint64 tOwner = vaultLens.lastOwnerClose();
        assertMachine(Actor.None, Actor.Guardian, Actor.Guardian, tOwner, tg);
        Schedule.run(vault, owner, keep);
        assertMachine(Actor.None, Actor.Guardian, Actor.None, tOwner, tg);
        vm.prank(owner);
        vault.unpause();
        assertMachine(Actor.None, Actor.None, Actor.None, tOwner, tg);
    }

    // ---- a stolen guardian's bound (R1-B M-1) ----

    /// A stolen guardian key closes the launch chain's door exits at most 15 days (spec §3.6, rows 2 and 3:
    /// "15 is the SG bound overall"), even when it removes the launch door at once and disables the primary
    /// one block before the owner's swap can run, when the primary's Reopen could not have been scheduled
    /// earlier (AlreadyActive). The swap ends both of the guardian's holds: the door's (`_onGuardianSet`) and
    /// the primary's (ExitsReopened(setGuardian.selector)), the primary staying disabled until its Reopen, so
    /// the door's Ordinary activation schedules at the swap and runs 7 days later, beside the Reopen. Without
    /// the primary's half the door waited for the Reopen first: about 22 days (R1-B's PoC).
    function test_aStolenGuardianClosesTheLaunchDoorAtMost15Days() public {
        bytes memory doorData = door(BASE, frontDoor);
        bytes memory swapData = swap(dave);
        bytes memory reopenData = abi.encodeCall(vault.activateBridge, (address(bridge)));

        // day 0: the stolen guardian removes the launch chain's last door (door hold G; the door Unknown)
        uint64 t0 = now_();
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, frontDoor);
        assertState(BASE, frontDoor, DoorState.Unknown);

        // the owner answers in the next block: the swap (8 days); the door's activation is refused under the
        // guardian's hold, and the primary's Reopen while the primary is enabled
        Schedule.warpTo(t0 + 12);
        uint64 t1 = now_();
        sched(swapData);
        uint64 swapReady = t1 + 8 days;
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        vault.schedule(doorData);
        vm.prank(owner);
        vm.expectRevert(AlreadyActive.selector);
        vault.schedule(reopenData);

        // one block before the swap is ready, the thief disables the primary, the only bridge; the owner
        // schedules its Reopen at once
        Schedule.warpTo(swapReady - 12);
        vm.prank(guardian);
        vault.disableBridge(address(bridge));
        uint64 tg = now_();
        sched(reopenData);
        uint64 reopenReady = now_() + 7 days;
        assertMachine(Actor.Guardian, Actor.None, Actor.Guardian, 0, tg);

        // day 8: the swap ends both of the old guardian's holds; the primary stays disabled until its Reopen
        Schedule.warpTo(swapReady);
        vm.expectEmit(address(vault));
        emit GuardianSet(dave);
        vm.expectEmit(address(vault));
        emit ExitsReopened(vault.setGuardian.selector);
        vm.expectEmit(address(vault));
        emit ExitsReopened(vault.setGuardian.selector);
        exec(swapData);
        assertMachine(Actor.None, Actor.None, Actor.None, 0, tg);
        assertFalse(vaultLens.bridgeEnabled(address(bridge)), "the primary stays disabled until its Reopen");

        // so the door's activation schedules at once, and runs beside the Reopen
        sched(doorData);
        uint64 doorReady = now_() + 7 days;
        Schedule.warpTo(reopenReady);
        exec(reopenData);
        assertTrue(vaultLens.bridgeEnabled(address(bridge)));
        Schedule.warpTo(doorReady);
        exec(doorData);
        assertState(BASE, frontDoor, DoorState.Active);
        assertTrue(vaultLens.exitsOpen());

        // the launch chain had no door from t0 to doorReady: within 15 days of the owner's first answer
        assertLe(doorReady - t1, 15 days, "the SG bound (spec 3.6: 15 days overall)");
    }

    // ---- the vault's pause ----

    /// The vault's pause is an instrument: the owner or the guardian; it records the pauser, stamps its clock
    /// and emits ExitsClosed after OpenZeppelin's Paused. A second pause, by either, reverts EnforcedPause, so
    /// the first pauser stays recorded and no other clock is stamped through it. Only the owner unpauses: it
    /// clears the record, stamps nothing and emits ExitsReopened after Unpaused.
    function test_pauseRecordsAndStampsUnpauseClearsOnly() public {
        vm.prank(alice);
        vm.expectRevert(NotGuardian.selector);
        vault.pause();

        uint64 t0 = now_();
        vm.expectEmit(address(vault));
        emit Pausable.Paused(guardian);
        vm.expectEmit(address(vault));
        emit ExitsClosed(guardian, vault.pause.selector);
        vm.prank(guardian);
        vault.pause();
        assertMachine(Actor.None, Actor.Guardian, Actor.None, 0, t0);

        warpBy(1 hours);
        address[2] memory actors = [owner, guardian];
        for (uint256 i; i < 2; ++i) {
            vm.prank(actors[i]);
            vm.expectRevert(Pausable.EnforcedPause.selector);
            vault.pause();
        }
        assertMachine(Actor.None, Actor.Guardian, Actor.None, 0, t0);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        vault.unpause();

        vm.expectEmit(address(vault));
        emit Pausable.Unpaused(owner);
        vm.expectEmit(address(vault));
        emit ExitsReopened(vault.unpause.selector);
        vm.prank(owner);
        vault.unpause();
        assertMachine(Actor.None, Actor.None, Actor.None, 0, t0);
        vm.prank(owner);
        vm.expectRevert(Pausable.ExpectedPause.selector);
        vault.unpause();

        warpBy(1 hours);
        uint64 t1 = now_();
        vm.expectEmit(address(vault));
        emit Pausable.Paused(owner);
        vm.expectEmit(address(vault));
        emit ExitsClosed(owner, vault.pause.selector);
        vm.prank(owner);
        vault.pause();
        assertMachine(Actor.None, Actor.Owner, Actor.None, t1, t0);
        vm.prank(guardian);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.pause();
        vm.prank(owner);
        vault.unpause();
        assertMachine(Actor.None, Actor.None, Actor.None, t1, t0);
    }

    /// The extra security test: the guardian pauses and the owner unpauses in the same second. The owner's
    /// clock is not stamped and pausedBy clears. An Ordinary item cannot be scheduled while paused (the gate),
    /// nor in the pause's own second after the unpause (the guardian's clock reads now), only a second later;
    /// an Ordinary item scheduled before the pause is dead, while a swap scheduled before it runs (it reads the
    /// owner's clock alone, I-27).
    function test_ownerUnpausesAGuardiansPause() public {
        bytes memory before = door(BASE, bob);
        bytes memory keep = swap(guardian);
        sched(before);
        sched(keep);
        uint64 ts = now_();

        warpBy(1 hours);
        uint64 tp = now_();
        vm.prank(guardian);
        vault.pause();
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        vault.schedule(door(BASE, carol));
        vm.prank(owner);
        vault.unpause();
        assertMachine(Actor.None, Actor.None, Actor.None, 0, tp);
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        vault.schedule(door(BASE, carol));

        warpBy(1);
        bytes memory fresh = door(BASE, carol);
        sched(fresh);
        uint64 tf = now_();

        Schedule.warpTo(ts + 7 days);
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        vault.execute(before);
        Schedule.warpTo(ts + 8 days);
        exec(keep);
        Schedule.warpTo(tf + 7 days);
        exec(fresh);
        assertState(BASE, carol, DoorState.Active);
        assertState(BASE, bob, DoorState.Unknown);
    }

    // ---- the launch-door cancel stamp ----

    /// Spec §3.6 row 5: the owner's cancel of a launch-chain door's batch stamps the owner's clock (a point
    /// closure: nothing recorded), emitting ExitsClosed(owner, cancelPayoutBatch.selector) exactly once, and
    /// kills every pending item of every kind; an item scheduled in its second is refused, a second later
    /// accepted. A cancel that reverts (no such batch) stamps nothing.
    function test_launchDoorCancelStampsOwnerClock() public {
        (bytes32 key, CascadeMessages.Payout[] memory list) = queueRedeem(BASE, frontDoor);
        // a Reopen to kill too: a door on another chain, active then removed by the owner (which stamps nothing)
        registerFrontDoor(OTHER, bob);
        vm.prank(owner);
        vault.removeFrontDoor(OTHER, bob);
        warpBy(1);
        bytes[3] memory items = [door(BASE, carol), swap(guardian), door(OTHER, bob)];
        for (uint256 i; i < 3; ++i) {
            sched(items[i]);
        }
        assertEq(uint8(vaultLens.scheduled(keccak256(items[2])).kind), uint8(Kind.Reopen));
        uint64 ts = now_();

        warpBy(1 hours);
        CascadeMessages.Payout[] memory none;
        vm.prank(owner);
        vm.expectRevert(NotPending.selector);
        vault.cancelPayoutBatch(keccak256("no such batch"), none);
        assertMachine(Actor.None, Actor.None, Actor.None, 0, 0);

        uint64 tc = now_();
        vm.recordLogs();
        vm.prank(owner);
        vault.cancelPayoutBatch(key, list);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(count(logs, ExitsClosed.selector), 1, "ExitsClosed exactly once");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != ExitsClosed.selector) continue;
            assertEq(logs[i].topics[1], bytes32(uint256(uint160(owner))));
            assertEq(logs[i].topics[2], bytes32(vault.cancelPayoutBatch.selector));
            assertEq(logs[i].emitter, address(vault));
        }
        assertEq(count(logs, ExitsReopened.selector), 0);
        assertMachine(Actor.None, Actor.None, Actor.None, tc, 0);

        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        vault.schedule(door(BASE, alice));
        Schedule.warpTo(ts + 8 days);
        for (uint256 i; i < 3; ++i) {
            vm.prank(owner);
            vm.expectRevert(ExitsNotOpen.selector);
            vault.execute(items[i]);
        }
        sched(door(BASE, alice));
    }

    /// A cancel of another chain's door's batch stamps nothing and emits no ExitsClosed; an Ordinary item
    /// pending through it executes.
    function test_otherChainCancelDoesNot() public {
        registerFrontDoor(OTHER, bob);
        (bytes32 key, CascadeMessages.Payout[] memory list) = queueRedeem(OTHER, bob);
        warpBy(1);
        bytes memory item = door(BASE, carol);
        sched(item);
        uint64 ts = now_();
        warpBy(1 hours);
        vm.recordLogs();
        vm.prank(owner);
        vault.cancelPayoutBatch(key, list);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(count(logs, ExitsClosed.selector), 0, "no ExitsClosed");
        assertMachine(Actor.None, Actor.None, Actor.None, 0, 0);
        Schedule.warpTo(ts + 7 days);
        exec(item);
        assertState(BASE, carol, DoorState.Active);
    }

    // ---- the holds ----

    /// Every combination of the three records, each by nobody, the owner or the guardian (27 states), played
    /// with the real instruments: the lens reads each record, ownerHold, guardianHold and exitsOpen by spec
    /// §3.6's formulas, the clocks each instrument stamped, and the vault's own gates agree a second later
    /// (only the gate can refuse then): an Ordinary item schedules exactly while exits are open, a swap exactly
    /// while the owner holds nothing.
    function test_holdTruthTable() public {
        uint256 snap = vm.snapshotState();
        for (uint8 p; p < 3; ++p) {
            for (uint8 q; q < 3; ++q) {
                for (uint8 r; r < 3; ++r) {
                    vm.revertToState(snap);
                    (Actor a, Actor b, Actor c) = (Actor(p), Actor(q), Actor(r));
                    uint64 t = now_();
                    if (a != Actor.None) {
                        vm.prank(actorAddress(a));
                        vault.disableBridge(address(bridge));
                    }
                    if (b != Actor.None) {
                        vm.prank(actorAddress(b));
                        vault.pause();
                    }
                    if (c != Actor.None) {
                        vm.prank(actorAddress(c));
                        vault.removeFrontDoor(BASE, frontDoor);
                    }
                    bool o = a == Actor.Owner || b == Actor.Owner || c == Actor.Owner;
                    bool g = a == Actor.Guardian || b == Actor.Guardian || c == Actor.Guardian;
                    assertMachine(a, b, c, o ? t : 0, g ? t : 0);

                    warpBy(1);
                    vm.prank(owner);
                    (bool ordinary,) = address(vault).call(abi.encodeCall(vault.schedule, (door(BASE, bob))));
                    assertEq(ordinary, !o && !g, "an Ordinary item schedules exactly while exits are open");
                    vm.prank(owner);
                    (bool swapped,) = address(vault).call(abi.encodeCall(vault.schedule, (swap(guardian))));
                    assertEq(swapped, !o, "a swap schedules exactly while the owner holds nothing");
                }
            }
        }
    }

    // ---- I-29: each instrument writes only the fields the spec names ----

    /// The `size` bytes at byte `offset` of a slot, as a mask.
    function maskOf(uint256 offset, uint256 size) internal pure returns (uint256) {
        return size == 32 ? type(uint256).max : ((uint256(1) << (size * 8)) - 1) << (offset * 8);
    }

    function mappingSlot(bytes32 key, uint256 slot) internal pure returns (bytes32) {
        return keccak256(abi.encode(key, slot));
    }

    function isIn(bytes32 s, bytes32[] memory list) internal pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == s) return true;
        }
        return false;
    }

    /// The vault's words at `slots`, now.
    function load(bytes32[] memory slots) internal view returns (bytes32[] memory words) {
        words = new bytes32[](slots.length);
        for (uint256 i; i < slots.length; ++i) {
            words[i] = vm.load(address(vault), slots[i]);
        }
    }

    /// After a call recorded since vm.record(): the vault wrote exactly `slots` (each at least once, nothing
    /// else), and in each only the bytes of its mask changed from `before`.
    function assertWroteOnly(bytes32[] memory slots, uint256[] memory masks, bytes32[] memory before) internal view {
        (, bytes32[] memory writes) = vm.accesses(address(vault));
        for (uint256 i; i < writes.length; ++i) {
            assertTrue(isIn(writes[i], slots), string.concat("a slot no named field holds: ", vm.toString(writes[i])));
        }
        for (uint256 i; i < slots.length; ++i) {
            assertTrue(isIn(slots[i], writes), string.concat("a named field not written: ", vm.toString(slots[i])));
            uint256 afterWord = uint256(vm.load(address(vault), slots[i]));
            assertEq(afterWord & ~masks[i], uint256(before[i]) & ~masks[i], "only the named bytes change");
        }
    }

    function holdSlot() internal pure returns (bytes32) {
        return bytes32(VaultLayout.SLOT_PAUSED_BY);
    }

    function pausedByMask() internal pure returns (uint256) {
        return maskOf(VaultLayout.OFFSET_PAUSED_BY, VaultLayout.SIZE_PAUSED_BY);
    }

    function doorHoldMask() internal pure returns (uint256) {
        return maskOf(VaultLayout.OFFSET_LAUNCH_DOOR_REMOVED_BY, VaultLayout.SIZE_LAUNCH_DOOR_REMOVED_BY);
    }

    /// (slot, mask) of `a`'s clock.
    function clockOf(Actor a) internal pure returns (bytes32, uint256) {
        return a == Actor.Owner
            ? (
                bytes32(VaultLayout.SLOT_LAST_OWNER_CLOSE),
                maskOf(VaultLayout.OFFSET_LAST_OWNER_CLOSE, VaultLayout.SIZE_LAST_OWNER_CLOSE)
            )
            : (
                bytes32(VaultLayout.SLOT_LAST_GUARDIAN_CLOSE),
                maskOf(VaultLayout.OFFSET_LAST_GUARDIAN_CLOSE, VaultLayout.SIZE_LAST_GUARDIAN_CLOSE)
            );
    }

    /// I-29 for the pause and the unpause, by each actor: the pause writes OpenZeppelin's _paused, pausedBy
    /// and the pauser's clock, each only in its own bytes; the unpause _paused and pausedBy only, no clock.
    function test_pauseAndUnpauseWriteOnlyTheirFields() public {
        Actor[2] memory actors = [Actor.Guardian, Actor.Owner];
        for (uint256 i; i < 2; ++i) {
            warpBy(1 hours);
            (bytes32 clock, uint256 clockMask) = clockOf(actors[i]);
            bytes32[] memory slots = new bytes32[](3);
            uint256[] memory masks = new uint256[](3);
            (slots[0], masks[0]) =
            (bytes32(VaultLayout.SLOT_PAUSED), maskOf(VaultLayout.OFFSET_PAUSED, VaultLayout.SIZE_PAUSED));
            (slots[1], masks[1]) = (holdSlot(), pausedByMask());
            (slots[2], masks[2]) = (clock, clockMask);
            bytes32[] memory before = load(slots);
            vm.record();
            vm.prank(actorAddress(actors[i]));
            vault.pause();
            assertWroteOnly(slots, masks, before);
            assertEq(uint8(vaultLens.pausedBy()), uint8(actors[i]));

            warpBy(1 hours);
            bytes32[] memory two = new bytes32[](2);
            uint256[] memory twoMasks = new uint256[](2);
            (two[0], twoMasks[0]) = (slots[0], masks[0]);
            (two[1], twoMasks[1]) = (slots[1], masks[1]);
            before = load(two);
            vm.record();
            vm.prank(owner);
            vault.unpause();
            assertWroteOnly(two, twoMasks, before);
            assertEq(uint8(vaultLens.pausedBy()), uint8(Actor.None));
        }
    }

    /// I-29 for removeFrontDoor: the launch chain's last door, by each actor, writes its doorState entry,
    /// the chain's activeDoors entry, launchDoorRemovedBy and the remover's clock; any other door (a second
    /// launch-chain door, another chain's last) only its doorState and activeDoors entries.
    function test_doorRemovalWritesOnlyItsFields() public {
        registerFrontDoor(BASE, bob);
        registerFrontDoor(OTHER, carol);
        // not the last on the launch chain, then another chain's last: two words each
        uint64[2] memory chains = [BASE, OTHER];
        address[2] memory doors = [bob, carol];
        for (uint256 i; i < 2; ++i) {
            bytes32[] memory slots = new bytes32[](2);
            uint256[] memory masks = new uint256[](2);
            (slots[0], masks[0]) =
            (mappingSlot(vaultLens.peerId(chains[i], doors[i]), VaultLayout.SLOT_DOOR_STATE), maskOf(0, 1));
            (slots[1], masks[1]) =
            (mappingSlot(bytes32(uint256(chains[i])), VaultLayout.SLOT_ACTIVE_DOORS), maskOf(0, 32));
            bytes32[] memory before = load(slots);
            vm.record();
            vm.prank(i == 0 ? guardian : owner);
            vault.removeFrontDoor(chains[i], doors[i]);
            assertWroteOnly(slots, masks, before);
        }

        // the launch chain's last door, by each actor (the owner's after its Reopen)
        Actor[2] memory actors = [Actor.Guardian, Actor.Owner];
        for (uint256 i; i < 2; ++i) {
            if (i == 1) {
                Schedule.run(vault, owner, swap(guardian));
                Schedule.run(vault, owner, door(BASE, frontDoor));
            }
            warpBy(1 hours);
            (bytes32 clock, uint256 clockMask) = clockOf(actors[i]);
            bytes32[] memory slots = new bytes32[](4);
            uint256[] memory masks = new uint256[](4);
            (slots[0], masks[0]) =
            (mappingSlot(vaultLens.peerId(BASE, frontDoor), VaultLayout.SLOT_DOOR_STATE), maskOf(0, 1));
            (slots[1], masks[1]) = (mappingSlot(bytes32(uint256(BASE)), VaultLayout.SLOT_ACTIVE_DOORS), maskOf(0, 32));
            (slots[2], masks[2]) = (holdSlot(), doorHoldMask());
            (slots[3], masks[3]) = (clock, clockMask);
            bytes32[] memory before = load(slots);
            vm.record();
            vm.prank(actorAddress(actors[i]));
            vault.removeFrontDoor(BASE, frontDoor);
            assertWroteOnly(slots, masks, before);
            assertEq(uint8(vaultLens.launchDoorRemovedBy()), uint8(actors[i]));
        }
    }

    /// I-29 for the guardian's removal of an owner-removed door (Task 10b): another chain's door with nothing
    /// pending writes its doorState entry alone (no count, no hold, no clock, no item); the launch chain's
    /// last door under the owner's hold writes its doorState entry, launchDoorRemovedBy's byte and the
    /// guardian's clock bytes (the hold made the guardian's); a second launch-chain door with its Reopen
    /// pending, the hold now the guardian's, writes its doorState entry and the item's one word (deleted).
    function test_theConversionWritesOnlyItsFields() public {
        registerFrontDoor(OTHER, carol);
        registerFrontDoor(BASE, bob);
        vm.startPrank(owner);
        vault.removeFrontDoor(OTHER, carol);
        vault.removeFrontDoor(BASE, bob);
        vault.removeFrontDoor(BASE, frontDoor);
        vm.stopPrank();
        warpBy(1);
        bytes32 id = sched(door(BASE, bob));
        warpBy(1 hours);

        bytes32[] memory slots = new bytes32[](1);
        uint256[] memory masks = new uint256[](1);
        (slots[0], masks[0]) = (mappingSlot(vaultLens.peerId(OTHER, carol), VaultLayout.SLOT_DOOR_STATE), maskOf(0, 1));
        bytes32[] memory before = load(slots);
        vm.record();
        vm.prank(guardian);
        vault.removeFrontDoor(OTHER, carol);
        assertWroteOnly(slots, masks, before);
        assertState(OTHER, carol, DoorState.Unknown);

        (bytes32 clock, uint256 clockMask) = clockOf(Actor.Guardian);
        slots = new bytes32[](3);
        masks = new uint256[](3);
        (slots[0], masks[0]) =
        (mappingSlot(vaultLens.peerId(BASE, frontDoor), VaultLayout.SLOT_DOOR_STATE), maskOf(0, 1));
        (slots[1], masks[1]) = (holdSlot(), doorHoldMask());
        (slots[2], masks[2]) = (clock, clockMask);
        before = load(slots);
        vm.record();
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, frontDoor);
        assertWroteOnly(slots, masks, before);
        assertEq(uint8(vaultLens.launchDoorRemovedBy()), uint8(Actor.Guardian));

        slots = new bytes32[](2);
        masks = new uint256[](2);
        (slots[0], masks[0]) = (mappingSlot(vaultLens.peerId(BASE, bob), VaultLayout.SLOT_DOOR_STATE), maskOf(0, 1));
        (slots[1], masks[1]) = (mappingSlot(id, VaultLayout.SLOT_SCHEDULED), type(uint256).max);
        before = load(slots);
        vm.record();
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, bob);
        assertWroteOnly(slots, masks, before);
        assertEq(vaultLens.scheduled(id).readyAt, 0);
        assertEq(uint256(vm.load(address(vault), slots[1])), 0, "the item's word cleared");
    }

    /// I-29 for the cancel: L3's own writes (the batch's four words, the ledger's pending, the supply, the
    /// re-minted balance) and the lock, plus, for a launch-chain door's batch only, lastOwnerClose's bytes: no
    /// hold, no door, no other clock.
    function test_cancelWritesOnlyTheOwnerClock() public {
        registerFrontDoor(OTHER, bob);
        (bytes32 launchKey, CascadeMessages.Payout[] memory launchList) = queueRedeem(BASE, frontDoor);
        // alice's origin is Base's since her first deposit; she names OTHER, so its door mints and burns for her
        // too (origin by chain, Task 18), and neither cancel below writes her origin
        vm.prank(alice);
        vault.setRedeemOrigin(OTHER);
        (bytes32 otherKey, CascadeMessages.Payout[] memory otherList) = queueRedeem(OTHER, bob);
        warpBy(1 hours);
        bytes32[2] memory keys = [otherKey, launchKey];
        for (uint256 i; i < 2; ++i) {
            CascadeMessages.Payout[] memory list = i == 0 ? otherList : launchList;
            bool stamps = i == 1;
            uint256 n = stamps ? 9 : 8;
            bytes32[] memory slots = new bytes32[](n);
            uint256[] memory masks = new uint256[](n);
            bytes32 batch = mappingSlot(keys[i], VaultLayout.SLOT_PAYOUT_BATCHES);
            for (uint256 w; w < 4; ++w) {
                (slots[w], masks[w]) = (bytes32(uint256(batch) + w), type(uint256).max);
            }
            (slots[4], masks[4]) =
            (bytes32(VaultLayout.SLOT_LEDGER + VaultLayout.LEDGER_PENDING_SLOT), type(uint256).max);
            (slots[5], masks[5]) =
            (bytes32(VaultLayout.SLOT_SHARES + VaultLayout.SHARES_DATA_TOTAL_SUPPLY_SLOT), type(uint256).max);
            (slots[6], masks[6]) =
            (
                mappingSlot(
                    bytes32(uint256(uint160(alice))), VaultLayout.SLOT_SHARES + VaultLayout.SHARES_DATA_BALANCE_OF_SLOT
                ),
                type(uint256).max
            );
            (slots[7], masks[7]) = (bytes32(VaultLayout.SLOT_STATUS), type(uint256).max);
            if (stamps) (slots[8], masks[8]) = clockOf(Actor.Owner);
            bytes32[] memory before = load(slots);
            vm.record();
            vm.prank(owner);
            vault.cancelPayoutBatch(keys[i], list);
            assertWroteOnly(slots, masks, before);
            assertEq(vaultLens.lastOwnerClose(), stamps ? now_() : 0);
            assertMachine(Actor.None, Actor.None, Actor.None, stamps ? now_() : 0, 0);
            warpBy(1 hours);
        }
    }
}

/// `_onGuardianSet` on its own (ruling B16d): it clears launchDoorRemovedBy only when it reads Guardian
/// (ExitsReopened(setGuardian.selector) then), and leaves an owner's record (and no record) as it was, with
/// no event. The owner's record is written at the generated slot: through the API a swap never runs over
/// it (VaultExitsMachineTest.test_setGuardianClearsOnlyAGuardiansDoorHold).
contract VaultGuardianHookTest is VaultTestBase {
    function deployVault(CascadeVault.Params memory p) internal override returns (CascadeVault) {
        return new VaultHookHarness(p);
    }

    /// Writes `a` into launchDoorRemovedBy's byte of its slot, leaving the slot's other bytes.
    function writeDoorHold(Actor a) internal {
        bytes32 slot = bytes32(VaultLayout.SLOT_LAUNCH_DOOR_REMOVED_BY);
        uint256 shift = VaultLayout.OFFSET_LAUNCH_DOOR_REMOVED_BY * 8;
        uint256 word = uint256(vm.load(address(vault), slot)) & ~(uint256(0xff) << shift);
        vm.store(address(vault), slot, bytes32(word | uint256(uint8(a)) << shift));
        assertEq(uint8(vaultLens.launchDoorRemovedBy()), uint8(a));
    }

    function test_theHookClearsOnlyAGuardiansDoorHold() public {
        Actor[3] memory records = [Actor.None, Actor.Owner, Actor.Guardian];
        for (uint256 i; i < 3; ++i) {
            writeDoorHold(records[i]);
            vm.recordLogs();
            VaultHookHarness(payable(address(vault))).runOnGuardianSet();
            Vm.Log[] memory logs = vm.getRecordedLogs();
            if (records[i] == Actor.Guardian) {
                assertEq(logs.length, 1);
                assertEq(logs[0].topics[0], ExitsReopened.selector);
                assertEq(logs[0].topics[1], bytes32(vault.setGuardian.selector));
                assertEq(uint8(vaultLens.launchDoorRemovedBy()), uint8(Actor.None));
            } else {
                assertEq(logs.length, 0);
                assertEq(uint8(vaultLens.launchDoorRemovedBy()), uint8(records[i]), "left as it was");
            }
        }
        // the pause's record is never the hook's: a guardian's pause stays
        vm.prank(guardian);
        vault.pause();
        VaultHookHarness(payable(address(vault))).runOnGuardianSet();
        assertEq(uint8(vaultLens.pausedBy()), uint8(Actor.Guardian));
    }
}
