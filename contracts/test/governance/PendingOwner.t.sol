// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ExitsNotOpen, LapsedItem, NotScheduled} from "../../src/CascadeErrors.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {Schedule} from "./Schedule.sol";
import {Stamps} from "./StampVector.sol";

/// An accepted ownership is the scheduled transfer's tail (R1-A L-1; spec §3.6, I-22): the pending owner
/// accepts only within EXECUTE_WINDOW of the transfer's execute (`pendingSince`), while the exits are open,
/// and only if neither clock has moved since (no closure by either actor, no owner stamp at or after it);
/// else acceptOwnership reverts LapsedItem (too late) or ExitsNotOpen. So a pending owner expires, and the
/// owner's own instrument or stamp (or the guardian's closure) kills it at once, which no guardian can veto.
/// transferOwnership(0) clears it. Ported from R1 reviewer A's R1A_PendingOwner, whose three tests failed at
/// 261bdb3.
contract PendingOwnerTest is VaultTestBase {
    address stranger = makeAddr("stranger");
    address pending = makeAddr("pending owner (later compromised)");

    function now_() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
    }

    /// The scheduled transfer to `pending`, executed now: its pendingSince.
    function transferToPending() internal returns (uint64 since) {
        Schedule.run(vault, owner, abi.encodeCall(vault.transferOwnership, (pending)));
        assertEq(vault.pendingOwner(), pending);
        since = now_();
        assertEq(vaultLens.pendingSince(), since, "the transfer's execute starts the acceptance");
    }

    function stampAsOf(uint64 asOf) internal {
        bytes memory sig = Stamps.signed(ownerKey, address(vault), asOf);
        vm.prank(stranger);
        vault.stampBySig(asOf, sig);
    }

    function assertAcceptRefused(bytes4 why) internal {
        vm.prank(pending);
        vm.expectRevert(why);
        vault.acceptOwnership();
        assertEq(vault.owner(), owner);
        assertEq(vault.pendingOwner(), pending, "a refused acceptance leaves the pending owner");
    }

    function accept() internal {
        vm.prank(pending);
        vault.acceptOwnership();
        assertEq(vault.owner(), pending);
        assertEq(vault.pendingOwner(), address(0));
        assertEq(vaultLens.pendingSince(), 0, "acceptance clears it");
    }

    // ---- R1A_PendingOwner, ported ----

    /// The owner moves ownership (8 days, OPEN, nothing stamped), then decides against it: it signs a stamp
    /// as of now, the guardian pauses, and a year passes. The pending owner can no longer accept: the stamp,
    /// the closure and the time each refuse it.
    function test_aPendingOwnerDiesToAStampAClosureAndTime() public {
        transferToPending();
        Schedule.warpTo(vm.getBlockTimestamp() + 1);
        stampAsOf(now_());
        vm.prank(guardian);
        vault.pause();
        Schedule.warpTo(vm.getBlockTimestamp() + 365 days);

        vm.prank(pending);
        (bool accepted,) = address(vault).call(abi.encodeCall(vault.acceptOwnership, ()));
        assertFalse(accepted, "an ownership change after a stamp, during a closure and a year on is refused (I-22)");
        assertEq(vault.owner(), owner);
    }

    /// During the owner's own closure the revocation is still a scheduled item (NotScheduled directly,
    /// ExitsNotOpen as an Ordinary item while closed), but it is no longer needed: the owner's pause refuses
    /// the pending owner at once (ExitsNotOpen), and, having stamped the owner's clock, for good, the
    /// unpause included.
    function test_theOwnersClosureRevokesAPendingOwnerAtOnce() public {
        transferToPending();
        Schedule.warpTo(vm.getBlockTimestamp() + 1);
        vm.prank(owner);
        vault.pause();

        vm.prank(owner);
        vm.expectRevert(NotScheduled.selector);
        vault.transferOwnership(address(0));
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        vault.schedule(abi.encodeCall(vault.transferOwnership, (address(0))));

        assertAcceptRefused(ExitsNotOpen.selector);
        vm.prank(owner);
        vault.unpause();
        assertAcceptRefused(ExitsNotOpen.selector);
    }

    /// The guardian can still cancel a scheduled transferOwnership(0) (an Ordinary item), but cannot keep the
    /// pending owner alive by it: the owner's signed stamp, relayed by anyone, refuses the pending owner at
    /// once, and nothing the guardian does undoes a stamp.
    function test_theGuardiansVetoOfTheRevocationKeepsNoPendingOwnerAlive() public {
        transferToPending();
        Schedule.warpTo(vm.getBlockTimestamp() + 1);
        vm.prank(owner);
        bytes32 id = vault.schedule(abi.encodeCall(vault.transferOwnership, (address(0))));
        vm.prank(guardian);
        vault.cancel(id);
        assertEq(vault.pendingOwner(), pending);

        stampAsOf(now_());
        assertAcceptRefused(ExitsNotOpen.selector);
        Schedule.warpTo(vm.getBlockTimestamp() + 1 days);
        assertAcceptRefused(ExitsNotOpen.selector);
    }

    // ---- the acceptance window and each refusal on its own ----

    /// The pending owner accepts until EXECUTE_WINDOW after the transfer's execute, the last second included;
    /// one second later it reverts LapsedItem.
    function test_aPendingOwnerExpiresAfterTheWindow() public {
        uint64 since = transferToPending();
        uint256 snap = vm.snapshotState();
        Schedule.warpTo(since + 7 days);
        accept();

        vm.revertToState(snap);
        Schedule.warpTo(since + 7 days + 1);
        assertAcceptRefused(LapsedItem.selector);
    }

    /// A stamp as of the transfer's execute second, or later, refuses the pending owner; one as of the second
    /// before (a pre-signed daily stamp relayed late, say) does not.
    function test_aStampAtOrAfterTheExecuteRefusesAnEarlierOneDoesNot() public {
        uint64 since = transferToPending();
        uint256 snap = vm.snapshotState();
        stampAsOf(since - 1);
        Schedule.warpTo(since + 1 hours);
        accept();

        vm.revertToState(snap);
        stampAsOf(since);
        Schedule.warpTo(since + 1 hours);
        assertAcceptRefused(ExitsNotOpen.selector);
    }

    /// The guardian's closure refuses the pending owner while it lasts (exits not open) and, having stamped
    /// the guardian's clock, after it too; an instrument in the transfer's own execute second counts.
    function test_aGuardiansClosureRefusesThePendingOwner() public {
        transferToPending();
        vm.prank(guardian);
        vault.pause();
        assertAcceptRefused(ExitsNotOpen.selector);
        vm.prank(owner);
        vault.unpause();
        Schedule.warpTo(vm.getBlockTimestamp() + 1 hours);
        assertAcceptRefused(ExitsNotOpen.selector);
    }

    /// A closure from before the transfer (its item ran after it, so the clocks are older than the execute)
    /// refuses nothing once the exits are open again.
    function test_anOlderClosureRefusesNothing() public {
        vm.prank(guardian);
        vault.pause();
        vm.prank(owner);
        vault.unpause();
        Schedule.warpTo(vm.getBlockTimestamp() + 1);
        transferToPending();
        Schedule.warpTo(vm.getBlockTimestamp() + 1 days);
        accept();
    }

    /// transferOwnership(0), a scheduled item, clears the pending owner and its pendingSince; a later transfer
    /// starts its own acceptance from its own execute.
    function test_transferOwnershipToZeroClearsIt() public {
        transferToPending();
        Schedule.warpTo(vm.getBlockTimestamp() + 1);
        Schedule.run(vault, owner, abi.encodeCall(vault.transferOwnership, (address(0))));
        assertEq(vault.pendingOwner(), address(0));
        assertEq(vaultLens.pendingSince(), 0);
        vm.prank(pending);
        vm.expectRevert(LapsedItem.selector);
        vault.acceptOwnership();

        Schedule.warpTo(vm.getBlockTimestamp() + 1);
        transferToPending();
        accept();
    }

    /// A stranger, or the owner, never accepts: OpenZeppelin's own check, inside the window.
    function test_onlyThePendingOwnerAccepts() public {
        transferToPending();
        address[2] memory others = [stranger, owner];
        for (uint256 i; i < 2; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, others[i]));
            vault.acceptOwnership();
        }
        accept();
    }
}
