// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {StubBridge} from "../mocks/StubBridge.sol";
import {BridgeNotEnabled, NotBridge, PrimaryBridgeDisabled} from "../../src/CascadeErrors.sol";
import {Schedule} from "../governance/Schedule.sol";
import {FrontDoorPayoutsBase} from "./FrontDoorPayoutsBase.sol";

contract FrontDoorPayoutsTest is FrontDoorPayoutsBase {
    // ---- payouts in ----

    function test_payoutCreditsClaimable() public {
        CascadeMessages.Entry[] memory p = entries2(alice, 3e18, bob, 2e18);
        tao.mint(address(fd), 5e18);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.PayoutsDelivered(KEY, 0, 5e18, address(bridge));
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.PayoutReceived(KEY, 0, alice, 3e18);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.PayoutReceived(KEY, 0, bob, 2e18);
        deliverPayouts(KEY, 0, p, false);

        assertEq(fd.claimable(alice), 3e18);
        assertEq(fd.claimable(bob), 2e18);
        assertEq(fd.claimable(carol), 0);
        assertEq(fd.totalClaimable(), 5e18);
        // recorded per delivering bridge and message hash
        assertTrue(fd.delivered(address(bridge), hashOf(KEY, 0, p)));
        assertFalse(fd.delivered(address(bridge), hashOf(KEY, 1, p)));
        assertFalse(fd.delivered(address(bridge), hashOf(KEY2, 0, p)));
        assertFalse(fd.delivered(makeAddr("bridge2"), hashOf(KEY, 0, p)));
        assertEq(tao.balanceOf(address(fd)), 5e18);
        // credits only; nothing is pushed to the users
        assertEq(tao.balanceOf(alice), 1_000e18);
        assertEq(tao.balanceOf(bob), 1_000e18);
    }

    /// Only a bridge once activated delivers (bridgeKnown, spec §3.5): not one merely scheduled, not a stranger. One
    /// since disabled still delivers: test_payoutFromAKnownDisabledBridgeCredited.
    function test_payoutFromAnyActivatedBridge() public {
        StubBridge bridge2 = new StubBridge(tao);
        bytes memory m = CascadeMessages.encodePayouts(KEY, 0, entries1(alice, 3e18));
        tao.mint(address(fd), 3e18);

        // scheduled but not yet active: not a bridge
        bytes memory activation = abi.encodeCall(fd.activateBridge, (address(bridge2)));
        vm.prank(owner);
        fd.schedule(activation);
        vm.prank(address(bridge2));
        vm.expectRevert(NotBridge.selector);
        fd.onBridgeMessage(BITTENSOR, vault, m, 3e18);

        Schedule.warpTo(vm.getBlockTimestamp() + 7 days);
        vm.prank(owner);
        fd.execute(activation);
        vm.prank(address(bridge2));
        fd.onBridgeMessage(BITTENSOR, vault, m, 3e18);
        assertEq(fd.claimable(alice), 3e18);
        assertEq(fd.totalClaimable(), 3e18);
        assertTrue(fd.delivered(address(bridge2), keccak256(m)));
        assertFalse(fd.delivered(address(bridge), keccak256(m)));
        // the primary bridge is unchanged
        assertEq(doorLens.primaryBridge(), address(bridge));

        // a stranger is not a bridge
        bytes memory m1 = CascadeMessages.encodePayouts(KEY, 1, entries1(alice, 1e18));
        tao.mint(address(fd), 1e18);
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(NotBridge.selector);
        fd.onBridgeMessage(BITTENSOR, vault, m1, 1e18);
        assertFalse(fd.delivered(stranger, keccak256(m1)));
        assertEq(fd.totalClaimable(), 3e18);
    }

    // ---- known bridges (spec §3.2, the front door's side; §3.5; H-2 i) ----

    /// A payout is accepted from any known bridge, ever activated (bridgeKnown), so one the guardian has since disabled
    /// still delivers a late payout or a refund, bounded exactly as an enabled one: only tokens that have arrived are
    /// credited (TokensNotReceived), each bridge delivers a message once (its own replay record), and the peer is
    /// checked as ever. The primary's disable stops its sends, never what it brings in.
    function test_payoutFromAKnownDisabledBridgeCredited() public {
        StubBridge bridge2 = enableBridge2();
        vm.prank(guardian);
        fd.disableBridge(address(bridge2));
        assertFalse(doorLens.bridgeEnabled(address(bridge2)));
        assertTrue(doorLens.bridgeKnown(address(bridge2)));

        CascadeMessages.Entry[] memory p = entries2(alice, 3e18, bob, 2e18);
        bytes memory m = CascadeMessages.encodePayouts(KEY, 0, p);
        // no tokens behind it: nothing credited
        vm.prank(address(bridge2));
        vm.expectRevert(CascadeFrontDoor.TokensNotReceived.selector);
        fd.onBridgeMessage(BITTENSOR, vault, m, 5e18);
        // a sender other than the vault
        tao.mint(address(fd), 5e18);
        address other = makeAddr("other");
        vm.prank(address(bridge2));
        vm.expectRevert(CascadeFrontDoor.UnknownPeer.selector);
        fd.onBridgeMessage(BITTENSOR, other, m, 5e18);

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.PayoutsDelivered(KEY, 0, 5e18, address(bridge2));
        vm.prank(address(bridge2));
        fd.onBridgeMessage(BITTENSOR, vault, m, 5e18);
        assertEq(fd.claimable(alice), 3e18);
        assertEq(fd.claimable(bob), 2e18);
        assertEq(fd.totalClaimable(), 5e18);
        assertTrue(fd.delivered(address(bridge2), keccak256(m)));
        assertFalse(fd.delivered(address(bridge), keccak256(m)));
        // once from that bridge, even with its tokens here again
        tao.mint(address(fd), 5e18);
        vm.prank(address(bridge2));
        vm.expectRevert(CascadeFrontDoor.DuplicatePayouts.selector);
        fd.onBridgeMessage(BITTENSOR, vault, m, 5e18);

        // the primary, disabled (the guardian's hold): its late payout is credited too, on those 5e18
        vm.prank(guardian);
        fd.disableBridge(address(bridge));
        assertTrue(doorLens.guardianHold());
        deliverPayouts(KEY2, 0, entries1(carol, 5e18), false);
        assertEq(fd.claimable(carol), 5e18);
        assertTrue(fd.delivered(address(bridge), hashOf(KEY2, 0, entries1(carol, 5e18))));
        assertEq(fd.totalClaimable(), 10e18);
        assertTokenIdentity();

        vm.prank(alice);
        fd.claim();
        vm.prank(carol);
        fd.claim();
        assertEq(tao.balanceOf(alice), 1_003e18);
        assertEq(tao.balanceOf(carol), 1_005e18);
        assertEq(tao.balanceOf(address(fd)), 2e18);
    }

    /// Known is not enabled for a send: the front door's disableBridge stops only the sends (closes) through that
    /// bridge (spec §3.2, the front door's side). With the primary disabled a close reverts PrimaryBridgeDisabled, as
    /// does a request meeting a full redeem list (its self-close), while that bridge's payout is still credited; a
    /// known bridge that is disabled cannot become the primary (BridgeNotEnabled). Once the owner switches to an
    /// enabled one, the batch leaves through it, and the old primary still delivers.
    function test_disabledBridgeCannotCarryAClose() public {
        StubBridge bridge2 = enableBridge2();
        bridge2.setFee(1e15);
        dep(alice, 10e18);
        requestWithFee(bob, 1e24);
        vm.prank(owner);
        fd.setBatchLimits(50, 1);
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        vm.prank(guardian);
        fd.disableBridge(address(bridge));

        vm.prank(carol);
        vm.expectRevert(PrimaryBridgeDisabled.selector);
        fd.closeBatch{value: 1e15}(1, 0);
        vm.prank(carol);
        vm.expectRevert(PrimaryBridgeDisabled.selector);
        fd.requestRedeem{value: 1e14}(1e24);
        // what it brings in is credited
        deliverPayouts(KEY, 0, entries1(carol, 2e18), true);
        assertEq(fd.claimable(carol), 2e18);

        // a known bridge that is disabled is no primary
        vm.prank(guardian);
        fd.disableBridge(address(bridge2));
        vm.prank(owner);
        vm.expectRevert(BridgeNotEnabled.selector);
        fd.setPrimaryBridge(address(bridge2));
        assertEq(bridge.sendCount() + bridge2.sendCount(), 0, "nothing sent");
        (uint64 id,, uint256 total,,,) = fd.openBatch();
        assertEq(id, 1);
        assertEq(total, 10e18);

        // re-enabled (its Reopen) and made the primary, it carries the batch; the old primary still delivers
        Schedule.run(fd, owner, abi.encodeCall(fd.activateBridge, (address(bridge2))));
        vm.prank(owner);
        fd.setPrimaryBridge(address(bridge2));
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, 10e18);
        assertEq(bridge2.sendCount(), 1);
        assertEq(bridge2.lastAmount(), 10e18);
        assertEq(bridge.sendCount(), 0);
        deliverPayouts(KEY, 1, entries1(carol, 1e18), true);
        assertEq(fd.claimable(carol), 3e18);
    }

    // ---- claims out ----

    function test_claimTransfersAndZeroes() public {
        deliverPayouts(KEY, 0, entries2(alice, 3e18, bob, 2e18), true);

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.Claimed(alice, 3e18);
        vm.prank(alice);
        fd.claim();
        assertEq(fd.claimable(alice), 0);
        assertEq(fd.totalClaimable(), 2e18);
        assertEq(tao.balanceOf(alice), 1_003e18);
        assertEq(tao.balanceOf(address(fd)), 2e18);

        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.NothingToClaim.selector);
        fd.claim();
        // never credited
        vm.prank(carol);
        vm.expectRevert(CascadeFrontDoor.NothingToClaim.selector);
        fd.claim();

        // works while paused
        pauseFd();
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.Claimed(bob, 2e18);
        vm.prank(bob);
        fd.claim();
        assertEq(fd.claimable(bob), 0);
        assertEq(fd.totalClaimable(), 0);
        assertEq(tao.balanceOf(bob), 1_002e18);
        assertEq(tao.balanceOf(address(fd)), 0);
    }

    function test_balanceIdentityWithOpenDepositsAndDonation() public {
        dep(alice, 10e18);
        deliverPayouts(KEY, 0, entries2(bob, 3e18, carol, 2e18), true);
        // 10e18 open + 5e18 claimable
        assertEq(tao.balanceOf(address(fd)), 15e18);
        assertEq(openTotal() + fd.totalClaimable(), 15e18);
        assertTokenIdentity();

        // a donation only adds surplus
        vm.prank(carol);
        assertTrue(tao.transfer(address(fd), 1e18));
        assertEq(tao.balanceOf(address(fd)), 16e18);
        assertEq(openTotal() + fd.totalClaimable(), 15e18);
        assertTokenIdentity();

        // claims and cancels keep it
        vm.prank(bob);
        fd.claim();
        assertTokenIdentity();
        waitCancel(alice);
        vm.prank(alice);
        fd.cancelDeposit(4e18);
        assertTokenIdentity();
        assertEq(tao.balanceOf(address(fd)), 9e18);

        // a close forwards only the open deposits
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, 6e18);
        assertEq(bridge.lastAmount(), 6e18);
        assertEq(tao.balanceOf(address(fd)), 3e18);
        assertEq(openTotal() + fd.totalClaimable(), 2e18);
        assertTokenIdentity();

        vm.prank(carol);
        fd.claim();
        // the donation stays behind
        assertEq(tao.balanceOf(address(fd)), 1e18);
        assertEq(fd.totalClaimable(), 0);
        assertTokenIdentity();
    }
}
