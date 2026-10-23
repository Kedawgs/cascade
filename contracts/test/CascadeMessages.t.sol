// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {CascadeMessages} from "../src/libraries/CascadeMessages.sol";

contract MessagesHarness {
    function encodeBatch(
        uint64 batchId,
        CascadeMessages.Entry[] memory deposits,
        CascadeMessages.Entry[] memory redeems
    ) external pure returns (bytes memory) {
        return CascadeMessages.encodeBatch(batchId, deposits, redeems);
    }

    function decodeBatch(bytes memory message)
        external
        pure
        returns (uint64 batchId, CascadeMessages.Entry[] memory deposits, CascadeMessages.Entry[] memory redeems)
    {
        return CascadeMessages.decodeBatch(message);
    }

    function encodePayouts(bytes32 batchKey, uint32 chunk, CascadeMessages.Entry[] memory payouts)
        external
        pure
        returns (bytes memory)
    {
        return CascadeMessages.encodePayouts(batchKey, chunk, payouts);
    }

    function decodePayouts(bytes memory message)
        external
        pure
        returns (bytes32 batchKey, uint32 chunk, CascadeMessages.Entry[] memory payouts)
    {
        return CascadeMessages.decodePayouts(message);
    }

    function kind(bytes memory message) external pure returns (uint8) {
        return CascadeMessages.kind(message);
    }
}

contract CascadeMessagesTest is Test {
    MessagesHarness internal h;
    address internal a = address(0xA11CE);
    address internal b = address(0xB0B);

    function setUp() public {
        h = new MessagesHarness();
    }

    function _list(address user, uint256 amount, uint256 n) internal pure returns (CascadeMessages.Entry[] memory l) {
        l = new CascadeMessages.Entry[](n);
        for (uint256 i; i < n; ++i) {
            l[i] = CascadeMessages.Entry(user, amount);
        }
    }

    function test_batchRoundTrip() public view {
        CascadeMessages.Entry[] memory d = _list(a, 10e18, 1);
        CascadeMessages.Entry[] memory r = _list(b, 5e24, 1);
        (uint64 id, CascadeMessages.Entry[] memory d2, CascadeMessages.Entry[] memory r2) =
            h.decodeBatch(h.encodeBatch(7, d, r));
        assertEq(id, 7);
        assertEq(d2.length, 1);
        assertEq(d2[0].user, a);
        assertEq(d2[0].amount, 10e18);
        assertEq(r2.length, 1);
        assertEq(r2[0].user, b);
        assertEq(r2[0].amount, 5e24);
    }

    function test_payoutsRoundTrip() public view {
        CascadeMessages.Entry[] memory p = _list(a, 1e18, 1);
        (bytes32 key, uint32 chunk, CascadeMessages.Entry[] memory p2) =
            h.decodePayouts(h.encodePayouts(keccak256("k"), 3, p));
        assertEq(key, keccak256("k"));
        assertEq(chunk, 3);
        assertEq(p2.length, 1);
        assertEq(p2[0].user, a);
        assertEq(p2[0].amount, 1e18);
    }

    function test_kinds() public view {
        assertEq(h.kind(h.encodeBatch(1, _list(a, 1, 1), _list(b, 1, 1))), 1);
        assertEq(h.kind(h.encodePayouts(keccak256("k"), 0, _list(a, 1, 1))), 2);
    }

    function test_decodeBatchRejectsPayouts() public {
        bytes memory m = h.encodePayouts(keccak256("k"), 0, _list(a, 1, 1));
        vm.expectRevert(abi.encodeWithSelector(CascadeMessages.WrongMessageKind.selector, 1, 2));
        h.decodeBatch(m);
    }

    function test_decodePayoutsRejectsBatch() public {
        bytes memory m = h.encodeBatch(1, _list(a, 1, 1), _list(b, 1, 1));
        vm.expectRevert(abi.encodeWithSelector(CascadeMessages.WrongMessageKind.selector, 2, 1));
        h.decodePayouts(m);
    }

    function test_batchEncodingIsAbiEncode() public view {
        CascadeMessages.Entry[] memory d = _list(a, 10e18, 2);
        CascadeMessages.Entry[] memory r = _list(b, 3, 1);
        assertEq(h.encodeBatch(7, d, r), abi.encode(uint8(1), uint64(7), d, r));
    }

    function test_decodeBatchRejects101Deposits() public {
        bytes memory m = h.encodeBatch(1, _list(a, 1, 101), _list(b, 1, 0));
        vm.expectRevert(CascadeMessages.TooManyEntries.selector);
        h.decodeBatch(m);
    }

    function test_decodeBatchAccepts100Each() public view {
        bytes memory m = h.encodeBatch(1, _list(a, 1, 100), _list(b, 2, 100));
        (, CascadeMessages.Entry[] memory d, CascadeMessages.Entry[] memory r) = h.decodeBatch(m);
        assertEq(d.length, 100);
        assertEq(r.length, 100);
    }

    function test_decodePayoutsRejects101() public {
        bytes memory m = h.encodePayouts(keccak256("k"), 0, _list(a, 1, 101));
        vm.expectRevert(CascadeMessages.TooManyEntries.selector);
        h.decodePayouts(m);
    }
}
