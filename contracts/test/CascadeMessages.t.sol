// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {CascadeMessages} from "../src/libraries/CascadeMessages.sol";

contract MessagesHarness {
    function encodeRequest(uint64 epochId, uint256 redeemShares, uint256 totalSupply) external pure returns (bytes memory) {
        return CascadeMessages.encodeRequest(epochId, redeemShares, totalSupply);
    }

    function decodeRequest(bytes memory message) external pure returns (uint64, uint256, uint256) {
        return CascadeMessages.decodeRequest(message);
    }

    function encodeResult(uint64 epochId, uint256 assetsBefore) external pure returns (bytes memory) {
        return CascadeMessages.encodeResult(epochId, assetsBefore);
    }

    function decodeResult(bytes memory message) external pure returns (uint64, uint256) {
        return CascadeMessages.decodeResult(message);
    }

    function kind(bytes memory message) external pure returns (uint8) {
        return CascadeMessages.kind(message);
    }
}

contract CascadeMessagesTest is Test {
    MessagesHarness internal harness = new MessagesHarness();

    function test_requestRoundTrip() public view {
        (uint64 epochId, uint256 redeemShares, uint256 totalSupply) =
            harness.decodeRequest(harness.encodeRequest(7, 40e24, 100e24));
        assertEq(epochId, 7);
        assertEq(redeemShares, 40e24);
        assertEq(totalSupply, 100e24);
    }

    function test_resultRoundTrip() public view {
        (uint64 epochId, uint256 assetsBefore) = harness.decodeResult(harness.encodeResult(7, 123e18));
        assertEq(epochId, 7);
        assertEq(assetsBefore, 123e18);
    }

    function test_kindOfRequestIsOne() public view {
        assertEq(harness.kind(harness.encodeRequest(1, 0, 0)), 1);
    }

    function test_kindOfResultIsTwo() public view {
        assertEq(harness.kind(harness.encodeResult(1, 0)), 2);
    }

    function test_decodeRequestRejectsResult() public {
        bytes memory result = harness.encodeResult(1, 0);
        vm.expectRevert(abi.encodeWithSelector(CascadeMessages.WrongMessageKind.selector, 1, 2));
        harness.decodeRequest(result);
    }

    function test_decodeResultRejectsRequest() public {
        bytes memory request = harness.encodeRequest(1, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(CascadeMessages.WrongMessageKind.selector, 2, 1));
        harness.decodeResult(request);
    }

    function test_requestEncodingIsAbiEncode() public view {
        assertEq(
            harness.encodeRequest(7, 40e24, 100e24),
            abi.encode(uint8(1), uint64(7), uint256(40e24), uint256(100e24))
        );
    }
}
