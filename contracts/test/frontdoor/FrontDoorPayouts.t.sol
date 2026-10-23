// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {CascadeBase} from "../../src/CascadeBase.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {StubBridge} from "../mocks/StubBridge.sol";
import {FrontDoorTestBase} from "../FrontDoorTestBase.sol";

contract FrontDoorPayoutsTest is FrontDoorTestBase {
    uint64 constant BASE = 8453;
    bytes32 constant KEY = keccak256("batch-1");
    bytes32 constant KEY2 = keccak256("batch-2");

    // ---- helpers ----

    /// Delivers a PAYOUTS chunk from (BITTENSOR, vault) through the stub bridge for Σ payouts,
    /// first minting Σ to the front door (the bridge's token transfer) when `mintFirst`.
    function deliverPayouts(bytes32 key, uint32 chunk, CascadeMessages.Entry[] memory payouts, bool mintFirst)
        internal
    {
        uint256 sum = sumOf(payouts);
        if (mintFirst) tao.mint(address(fd), sum);
        vm.prank(address(bridge));
        fd.onBridgeMessage(BITTENSOR, vault, CascadeMessages.encodePayouts(key, chunk, payouts), sum);
    }

    /// The replay-record key of a PAYOUTS message.
    function hashOf(bytes32 key, uint32 chunk, CascadeMessages.Entry[] memory payouts) internal pure returns (bytes32) {
        return keccak256(CascadeMessages.encodePayouts(key, chunk, payouts));
    }

    /// A second stub bridge, proposed and activated after the registry delay.
    function enableBridge2() internal returns (StubBridge bridge2) {
        bridge2 = new StubBridge(tao);
        vm.prank(owner);
        fd.proposeBridge(address(bridge2));
        vm.warp(block.timestamp + 7 days);
        vm.prank(owner);
        fd.activateBridge(address(bridge2));
    }

    function sumOf(CascadeMessages.Entry[] memory payouts) internal pure returns (uint256 sum) {
        for (uint256 i; i < payouts.length; ++i) {
            sum += payouts[i].amount;
        }
    }

    function entries1(address user, uint256 amount) internal pure returns (CascadeMessages.Entry[] memory e) {
        e = new CascadeMessages.Entry[](1);
        e[0] = CascadeMessages.Entry(user, amount);
    }

    function entries2(address u1, uint256 a1, address u2, uint256 a2)
        internal
        pure
        returns (CascadeMessages.Entry[] memory e)
    {
        e = new CascadeMessages.Entry[](2);
        e[0] = CascadeMessages.Entry(u1, a1);
        e[1] = CascadeMessages.Entry(u2, a2);
    }

    function noEntries() internal pure returns (CascadeMessages.Entry[] memory) {
        return new CascadeMessages.Entry[](0);
    }

    function dep(address user, uint256 amount) internal {
        vm.prank(user);
        fd.deposit(amount);
    }

    function pauseFd() internal {
        vm.prank(guardian);
        fd.pause();
    }

    function openTotal() internal view returns (uint256 total) {
        (,, total,,,) = fd.openBatch();
    }

    function assertTokenIdentity() internal view {
        assertGe(tao.balanceOf(address(fd)), openTotal() + fd.totalClaimable());
    }

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

    function test_payoutFromAnyEnabledBridge() public {
        StubBridge bridge2 = new StubBridge(tao);
        bytes memory m = CascadeMessages.encodePayouts(KEY, 0, entries1(alice, 3e18));
        tao.mint(address(fd), 3e18);

        // proposed but not yet active: not a bridge
        vm.prank(owner);
        fd.proposeBridge(address(bridge2));
        vm.prank(address(bridge2));
        vm.expectRevert(CascadeBase.NotBridge.selector);
        fd.onBridgeMessage(BITTENSOR, vault, m, 3e18);

        vm.warp(block.timestamp + 7 days);
        vm.prank(owner);
        fd.activateBridge(address(bridge2));
        vm.prank(address(bridge2));
        fd.onBridgeMessage(BITTENSOR, vault, m, 3e18);
        assertEq(fd.claimable(alice), 3e18);
        assertEq(fd.totalClaimable(), 3e18);
        assertTrue(fd.delivered(address(bridge2), keccak256(m)));
        assertFalse(fd.delivered(address(bridge), keccak256(m)));
        // the primary bridge is unchanged
        assertEq(fd.primaryBridge(), address(bridge));

        // a stranger is not a bridge
        bytes memory m1 = CascadeMessages.encodePayouts(KEY, 1, entries1(alice, 1e18));
        tao.mint(address(fd), 1e18);
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(CascadeBase.NotBridge.selector);
        fd.onBridgeMessage(BITTENSOR, vault, m1, 1e18);

        // a disabled bridge is no longer a bridge
        vm.prank(guardian);
        fd.disableBridge(address(bridge2));
        vm.prank(address(bridge2));
        vm.expectRevert(CascadeBase.NotBridge.selector);
        fd.onBridgeMessage(BITTENSOR, vault, m1, 1e18);
        assertFalse(fd.delivered(address(bridge2), keccak256(m1)));
        assertFalse(fd.delivered(stranger, keccak256(m1)));
    }

    function test_payoutWrongPeerReverts() public {
        bytes memory m = CascadeMessages.encodePayouts(KEY, 0, entries1(alice, 3e18));
        tao.mint(address(fd), 3e18);
        address other = makeAddr("other");

        vm.prank(address(bridge));
        vm.expectRevert(CascadeFrontDoor.UnknownPeer.selector);
        fd.onBridgeMessage(BITTENSOR, other, m, 3e18);

        // the vault's address on another chain is another peer
        vm.prank(address(bridge));
        vm.expectRevert(CascadeFrontDoor.UnknownPeer.selector);
        fd.onBridgeMessage(BASE, vault, m, 3e18);

        assertFalse(fd.delivered(address(bridge), keccak256(m)));
        assertEq(fd.totalClaimable(), 0);

        // the vault itself is accepted
        vm.prank(address(bridge));
        fd.onBridgeMessage(BITTENSOR, vault, m, 3e18);
        assertEq(fd.claimable(alice), 3e18);
    }

    function test_payoutValueMismatchReverts() public {
        bytes memory m = CascadeMessages.encodePayouts(KEY, 0, entries1(alice, 3e18));
        tao.mint(address(fd), 3e18);
        vm.deal(address(bridge), 1);

        vm.prank(address(bridge));
        vm.expectRevert(CascadeFrontDoor.ValueMismatch.selector);
        fd.onBridgeMessage{value: 1}(BITTENSOR, vault, m, 3e18);

        assertFalse(fd.delivered(address(bridge), keccak256(m)));
        assertEq(address(fd).balance, 0);
        assertEq(address(bridge).balance, 1);
    }

    function test_payoutAmountMismatchReverts() public {
        bytes memory m = CascadeMessages.encodePayouts(KEY, 0, entries2(alice, 3e18, bob, 2e18));
        tao.mint(address(fd), 6e18);

        // Σ 5e18 against 4e18 and 6e18
        vm.prank(address(bridge));
        vm.expectRevert(CascadeFrontDoor.AmountMismatch.selector);
        fd.onBridgeMessage(BITTENSOR, vault, m, 4e18);
        vm.prank(address(bridge));
        vm.expectRevert(CascadeFrontDoor.AmountMismatch.selector);
        fd.onBridgeMessage(BITTENSOR, vault, m, 6e18);

        // an empty list with tokens attached
        bytes memory empty = CascadeMessages.encodePayouts(KEY, 0, noEntries());
        vm.prank(address(bridge));
        vm.expectRevert(CascadeFrontDoor.AmountMismatch.selector);
        fd.onBridgeMessage(BITTENSOR, vault, empty, 1e18);

        assertFalse(fd.delivered(address(bridge), keccak256(m)));
        assertFalse(fd.delivered(address(bridge), keccak256(empty)));
        assertEq(fd.totalClaimable(), 0);
    }

    function test_payoutTokensNotReceivedThenRedelivered() public {
        CascadeMessages.Entry[] memory p = entries1(alice, 5e18);

        vm.expectRevert(CascadeFrontDoor.TokensNotReceived.selector);
        deliverPayouts(KEY, 0, p, false);

        // the open batch's deposits are not payout tokens: 10e18 held, 10e18 + 0 + 5e18 needed
        dep(bob, 10e18);
        vm.expectRevert(CascadeFrontDoor.TokensNotReceived.selector);
        deliverPayouts(KEY, 0, p, false);

        // one wei short: 15e18 - 1 held
        tao.mint(address(fd), 5e18 - 1);
        vm.expectRevert(CascadeFrontDoor.TokensNotReceived.selector);
        deliverPayouts(KEY, 0, p, false);
        assertFalse(fd.delivered(address(bridge), hashOf(KEY, 0, p)));

        // the rest arrives; the same message is re-delivered and goes through
        tao.mint(address(fd), 1);
        deliverPayouts(KEY, 0, p, false);
        assertEq(fd.claimable(alice), 5e18);
        assertEq(fd.totalClaimable(), 5e18);
        assertTrue(fd.delivered(address(bridge), hashOf(KEY, 0, p)));

        // existing claimable is not payout tokens either: 15e18 held, 10e18 + 5e18 + 2e18 needed
        vm.expectRevert(CascadeFrontDoor.TokensNotReceived.selector);
        deliverPayouts(KEY, 1, entries1(carol, 2e18), false);
        deliverPayouts(KEY, 1, entries1(carol, 2e18), true);
        assertEq(fd.claimable(carol), 2e18);
        assertEq(fd.totalClaimable(), 7e18);
        assertEq(tao.balanceOf(address(fd)), 17e18);
    }

    function test_payoutDuplicateChunkReverts() public {
        StubBridge bridge2 = enableBridge2();
        CascadeMessages.Entry[] memory p = entries1(alice, 3e18);
        bytes memory m = CascadeMessages.encodePayouts(KEY, 0, p);
        deliverPayouts(KEY, 0, p, true);
        assertTrue(fd.delivered(address(bridge), keccak256(m)));

        // a copy from a second enabled bridge with no tokens behind it: 3e18 held, 3e18 + 3e18 needed
        vm.prank(address(bridge2));
        vm.expectRevert(CascadeFrontDoor.TokensNotReceived.selector);
        fd.onBridgeMessage(BITTENSOR, vault, m, 3e18);

        // the same message from the same bridge, even with its tokens here again
        tao.mint(address(fd), 3e18);
        vm.expectRevert(CascadeFrontDoor.DuplicatePayouts.selector);
        deliverPayouts(KEY, 0, p, false);
        assertEq(fd.claimable(alice), 3e18);
        assertEq(fd.totalClaimable(), 3e18);

        // the same message from the second bridge is its own slot: accepted, as tokens now back it
        assertFalse(fd.delivered(address(bridge2), keccak256(m)));
        vm.prank(address(bridge2));
        fd.onBridgeMessage(BITTENSOR, vault, m, 3e18);
        assertTrue(fd.delivered(address(bridge2), keccak256(m)));
        assertEq(fd.claimable(alice), 6e18);
        // and only once from that bridge too
        tao.mint(address(fd), 3e18);
        vm.prank(address(bridge2));
        vm.expectRevert(CascadeFrontDoor.DuplicatePayouts.selector);
        fd.onBridgeMessage(BITTENSOR, vault, m, 3e18);

        // the next chunk of the same batch (those tokens now back it)
        deliverPayouts(KEY, 1, p, false);
        // chunk 0 of another batch
        deliverPayouts(KEY2, 0, p, true);

        assertEq(fd.claimable(alice), 12e18);
        assertEq(fd.totalClaimable(), 12e18);
        assertTrue(fd.delivered(address(bridge), hashOf(KEY, 1, p)));
        assertTrue(fd.delivered(address(bridge), hashOf(KEY2, 0, p)));
        assertEq(tao.balanceOf(address(fd)), 12e18);
    }

    function test_payoutReducesNetForwardedFloored() public {
        dep(alice, 10e18);
        vm.warp(block.timestamp + 12 hours);
        vm.prank(carol);
        fd.closeBatch{value: 1e15}();
        assertEq(fd.netForwarded(), 10e18);

        deliverPayouts(KEY, 0, entries1(alice, 4e18), true);
        assertEq(fd.netForwarded(), 6e18);

        // more paid out than forwarded (gains): floored at 0
        deliverPayouts(KEY, 1, entries1(bob, 20e18), true);
        assertEq(fd.netForwarded(), 0);
        assertEq(fd.totalClaimable(), 24e18);

        // and stays at 0
        deliverPayouts(KEY2, 0, entries1(carol, 1e18), true);
        assertEq(fd.netForwarded(), 0);
    }

    function test_payoutWorksWhilePaused() public {
        pauseFd();
        assertTrue(fd.paused());

        tao.mint(address(fd), 3e18);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.PayoutReceived(KEY, 0, alice, 3e18);
        deliverPayouts(KEY, 0, entries1(alice, 3e18), false);

        assertEq(fd.claimable(alice), 3e18);
        assertEq(fd.totalClaimable(), 3e18);
        assertTrue(fd.delivered(address(bridge), hashOf(KEY, 0, entries1(alice, 3e18))));
    }

    function test_payoutEmptyListAccepted() public {
        vm.recordLogs();
        deliverPayouts(KEY, 0, noEntries(), false);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // exactly one event: PayoutsDelivered(KEY, 0, 0, bridge)
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(fd));
        assertEq(logs[0].topics.length, 2);
        assertEq(logs[0].topics[0], CascadeFrontDoor.PayoutsDelivered.selector);
        assertEq(logs[0].topics[1], KEY);
        assertEq(logs[0].data, abi.encode(uint32(0), uint256(0), address(bridge)));

        assertTrue(fd.delivered(address(bridge), hashOf(KEY, 0, noEntries())));
        assertEq(fd.totalClaimable(), 0);
        assertEq(fd.netForwarded(), 0);
        assertEq(tao.balanceOf(address(fd)), 0);

        // and is not replayable
        vm.expectRevert(CascadeFrontDoor.DuplicatePayouts.selector);
        deliverPayouts(KEY, 0, noEntries(), false);

        // an empty (KEY, 0) does not occupy the real chunk 0 of that batch
        deliverPayouts(KEY, 0, entries1(alice, 3e18), true);
        assertEq(fd.claimable(alice), 3e18);
        assertTrue(fd.delivered(address(bridge), hashOf(KEY, 0, entries1(alice, 3e18))));
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
        vm.prank(alice);
        fd.cancelDeposit(4e18);
        assertTokenIdentity();
        assertEq(tao.balanceOf(address(fd)), 9e18);

        // a close forwards only the open deposits
        vm.warp(block.timestamp + 12 hours);
        vm.prank(carol);
        fd.closeBatch{value: 1e15}();
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
