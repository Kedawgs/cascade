// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {Item} from "../../src/CascadeTypes.sol";
import {InvalidParameter} from "../../src/CascadeErrors.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {FrontDoorTestBase} from "../FrontDoorTestBase.sol";
import {SchedulerHarness} from "./SchedulerHarness.sol";
import {Schedule} from "./Schedule.sol";

/// The guardian and the owner are never one account (the controller's ruling after Task 8's review): if
/// they were, `_actor()` would read every instrument as the owner's, so a guardian's pause or disable
/// would stamp the owner's clock and delay `setGuardian`, breaking I-27. Every way the two could meet is
/// refused with InvalidParameter: the constructor; `setGuardian` to the owner or the pending owner, at
/// schedule and again at execute; `transferOwnership` to the guardian, at schedule and again at execute
/// (the state may change between). `acceptOwnership` needs no check of its own: the pending owner is
/// never the guardian. On SchedulerHarness (CascadeBase); the constructor on both targets too.
contract SeparateAccountsTest is Test {
    SchedulerHarness h;
    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address bridge = makeAddr("bridge");
    address x = makeAddr("x");

    function setUp() public {
        Schedule.warpTo(1_000_000);
        h = new SchedulerHarness(owner, guardian, bridge);
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

    /// The owner's schedule of `data` reverts InvalidParameter and leaves its id's item as it was (none,
    /// unless a refused execute left one).
    function assertScheduleRefused(bytes memory data) internal {
        bytes32 id = keccak256(data);
        Item memory before = h.item(id);
        vm.prank(h.owner());
        vm.expectRevert(InvalidParameter.selector);
        h.schedule(data);
        Item memory got = h.item(id);
        assertEq(got.scheduledAt, before.scheduledAt, "nothing scheduled");
        assertEq(got.readyAt, before.readyAt, "nothing scheduled");
    }

    /// The owner's execute of the ready item `data` reverts InvalidParameter and leaves the item as it was.
    function assertExecuteRefused(bytes memory data) internal {
        bytes32 id = keccak256(data);
        Item memory before = h.item(id);
        assertGt(before.readyAt, 0, "an item is scheduled");
        vm.prank(h.owner());
        vm.expectRevert(InvalidParameter.selector);
        h.execute(data);
        Item memory got = h.item(id);
        assertEq(got.scheduledAt, before.scheduledAt, "the item stays");
        assertEq(got.readyAt, before.readyAt, "the item stays");
    }

    function assertSeparate() internal view {
        address g = h.exposed_guardian();
        assertTrue(g != h.owner(), "the guardian is not the owner");
        assertTrue(g != h.pendingOwner(), "the guardian is not the pending owner");
    }

    function test_constructorRefusesTheOwnerAsGuardian() public {
        vm.expectRevert(InvalidParameter.selector);
        new SchedulerHarness(owner, owner, bridge);
        // distinct accounts deploy
        new SchedulerHarness(owner, x, bridge);
    }

    /// setGuardian to the owner is refused at schedule; scheduled to an account that becomes the owner
    /// (it accepts a transfer meanwhile), it is refused at execute and stays.
    function test_setGuardianRefusesTheOwner() public {
        assertScheduleRefused(swap(owner));
        assertEq(h.item(keccak256(swap(owner))).readyAt, 0);

        sched(swap(x));
        Schedule.run(h, owner, transfer(x));
        vm.prank(x);
        h.acceptOwnership();
        assertEq(h.owner(), x);
        // the swap, ready since the transfer's execute, would make the new owner the guardian
        assertExecuteRefused(swap(x));
        assertEq(h.exposed_guardian(), guardian);
        assertSeparate();
        // and the new owner cannot schedule it again
        assertScheduleRefused(swap(x));
    }

    /// Ordering: transferOwnership(X) executed (X is the pending owner), then setGuardian(X) scheduled:
    /// refused. With both pending, the transfer executed first: the swap is refused at execute.
    function test_transferThenSwapToOneAccount() public {
        Schedule.run(h, owner, transfer(x));
        assertEq(h.pendingOwner(), x);
        assertScheduleRefused(swap(x));

        // both pending at once: neither account is a role yet, so both schedule
        SchedulerHarness fresh = new SchedulerHarness(owner, guardian, bridge);
        h = fresh;
        sched(transfer(x));
        sched(swap(x));
        Schedule.warpTo(vm.getBlockTimestamp() + 8 days);
        vm.prank(owner);
        h.execute(transfer(x));
        assertEq(h.pendingOwner(), x);
        assertExecuteRefused(swap(x));
        assertEq(h.exposed_guardian(), guardian);
        assertSeparate();

        // acceptOwnership: the pending owner was never the guardian, so the accepted owner is not
        vm.prank(x);
        h.acceptOwnership();
        assertEq(h.owner(), x);
        assertSeparate();
    }

    /// The reverse: setGuardian(X) executed, then transferOwnership(X) scheduled: refused. With both
    /// pending, the swap executed first: the transfer is refused at execute.
    function test_swapThenTransferToOneAccount() public {
        Schedule.run(h, owner, swap(x));
        assertEq(h.exposed_guardian(), x);
        assertScheduleRefused(transfer(x));

        SchedulerHarness fresh = new SchedulerHarness(owner, guardian, bridge);
        h = fresh;
        sched(swap(x));
        sched(transfer(x));
        Schedule.warpTo(vm.getBlockTimestamp() + 8 days);
        vm.prank(owner);
        h.execute(swap(x));
        assertEq(h.exposed_guardian(), x);
        assertExecuteRefused(transfer(x));
        assertEq(h.pendingOwner(), address(0));
        assertSeparate();
    }

    /// transferOwnership to the sitting guardian is refused at schedule.
    function test_transferRefusesTheGuardian() public {
        assertScheduleRefused(transfer(guardian));
        assertEq(h.item(keccak256(transfer(guardian))).readyAt, 0);
        assertEq(h.pendingOwner(), address(0));
    }

    /// The checks read the roles as they are: a pending owner replaced by a later transfer is free again,
    /// and so is a guardian that has been replaced.
    function test_rolesAreReadNotRemembered() public {
        address y = makeAddr("y");
        Schedule.run(h, owner, transfer(x));
        Schedule.run(h, owner, transfer(y));
        assertEq(h.pendingOwner(), y);
        // x is no longer pending: it may become the guardian; y may not
        assertScheduleRefused(swap(y));
        Schedule.run(h, owner, swap(x));
        assertEq(h.exposed_guardian(), x);
        // the old guardian may now be the owner
        Schedule.run(h, owner, transfer(guardian));
        assertEq(h.pendingOwner(), guardian);
        assertSeparate();
    }
}

/// The vault's constructor refuses its owner as its guardian (CascadeBase's check).
contract VaultSeparateAccountsTest is VaultTestBase {
    function test_vaultConstructorRefusesTheOwnerAsGuardian() public {
        CascadeVault.Params memory p = vaultParams();
        p.guardian = owner;
        vm.expectRevert(InvalidParameter.selector);
        new CascadeVault(p);
    }
}

/// The front door's constructor refuses its owner as its guardian (CascadeBase's check).
contract DoorSeparateAccountsTest is FrontDoorTestBase {
    function test_doorConstructorRefusesTheOwnerAsGuardian() public {
        CascadeFrontDoor.Params memory p = frontDoorParams();
        p.guardian = owner;
        vm.expectRevert(InvalidParameter.selector);
        new CascadeFrontDoor(p);
    }
}
