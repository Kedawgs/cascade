// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {StubBridge} from "../mocks/StubBridge.sol";
import {FrontDoorTestBase} from "../FrontDoorTestBase.sol";
import {Schedule} from "../governance/Schedule.sol";

abstract contract FrontDoorPayoutsBase is FrontDoorTestBase {
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

    /// A second stub bridge, its activation scheduled and executed after the registry delay.
    function enableBridge2() internal returns (StubBridge bridge2) {
        bridge2 = new StubBridge(tao);
        Schedule.run(fd, owner, abi.encodeCall(fd.activateBridge, (address(bridge2))));
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
}
