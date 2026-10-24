// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {CcipAdapterBase} from "../../src/adapters/CcipAdapterBase.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {AdapterHarness} from "./AdapterHarness.sol";

contract CcipAdapterBaseTest is Test {
    AdapterHarness h;

    function setUp() public {
        h = new AdapterHarness(cfgWith(1_000_000, 25_000));
    }

    function cfgWith(uint256 base, uint256 perEntry) internal returns (CcipAdapterBase.Config memory) {
        return CcipAdapterBase.Config({
            router: makeAddr("router"),
            token: makeAddr("token"),
            localChainId: 8453,
            remoteChainId: 964,
            remoteSelector: 2135107236357186872,
            remoteAdapter: makeAddr("remoteAdapter"),
            gasBase: base,
            gasPerEntry: perEntry
        });
    }

    function cfgWithRouter(address router) internal returns (CcipAdapterBase.Config memory c) {
        c = cfgWith(1_000_000, 25_000);
        c.router = router;
    }

    function cfgWithChains(uint64 local, uint64 remote) internal returns (CcipAdapterBase.Config memory c) {
        c = cfgWith(1_000_000, 25_000);
        c.localChainId = local;
        c.remoteChainId = remote;
    }

    function entries(uint256 n) internal pure returns (CascadeMessages.Entry[] memory e) {
        e = new CascadeMessages.Entry[](n);
        for (uint256 i; i < n; i++) {
            e[i] = CascadeMessages.Entry(address(uint160(i + 1)), 1e9);
        }
    }

    function test_extraArgs_is19BytesV3() public view {
        // tag || uint32 1_500_000 || bytes4 finality 0 || 7 zero bytes
        assertEq(h.extraArgs(1_500_000), hex"a69dd4aa" hex"0016e360" hex"00000000" hex"00000000000000");
        assertEq(h.extraArgs(1_500_000).length, 19);
    }

    function test_gasFor_batchCountsDepositsAndRedeems() public view {
        assertEq(h.gasFor(CascadeMessages.encodeBatch(1, entries(1), entries(0))), 1_025_000);
        assertEq(h.gasFor(CascadeMessages.encodeBatch(1, entries(100), entries(100))), 6_000_000);
        assertEq(h.gasFor(CascadeMessages.encodeBatch(1, entries(0), entries(0))), 1_000_000);
    }

    function test_gasFor_payoutsCountsEntries() public view {
        assertEq(h.gasFor(CascadeMessages.encodePayouts(bytes32(0), 0, entries(50))), 2_250_000);
    }

    function test_gasFor_capsAtGasCap() public {
        AdapterHarness big = new AdapterHarness(cfgWith(6_000_000, 5_000)); // 6_000_000 + 200 * 5_000 == cap
        assertEq(big.gasFor(CascadeMessages.encodeBatch(1, entries(100), entries(100))), 7_000_000);
    }

    function test_gasFor_malformedMessageQuotesCap() public view {
        assertEq(h.gasFor(hex"01"), 7_000_000); // not a multiple of 32
        assertEq(h.gasFor(abi.encode(uint8(7), uint64(1))), 7_000_000); // unknown kind
    }

    function test_payload_roundTrip() public view {
        bytes memory m = CascadeMessages.encodeBatch(9, entries(2), entries(1));
        (address r, address s, bytes memory out) = h.decodePayload(h.encodePayload(address(0xA), address(0xB), m));
        assertEq(r, address(0xA));
        assertEq(s, address(0xB));
        assertEq(out, m);
    }

    function test_supportsInterface() public view {
        assertTrue(h.supportsInterface(0x85572ffb));
        assertTrue(h.supportsInterface(0x01ffc9a7));
        assertFalse(h.supportsInterface(0xffffffff));
        assertFalse(
            h.supportsInterface(bytes4(0x85572ffb) ^ bytes4(keccak256("getCCVsAndFinalityConfig(uint64,bytes)")))
        );
    }

    function test_constructor_rejections() public {
        CcipAdapterBase.Config memory c = cfgWithRouter(address(0));
        vm.expectRevert(CcipAdapterBase.ZeroAddress.selector);
        new AdapterHarness(c);
        c = cfgWithChains(964, 964);
        vm.expectRevert(CcipAdapterBase.SameChain.selector);
        new AdapterHarness(c);
        c = cfgWith(6_000_001, 5_000);
        vm.expectRevert(CcipAdapterBase.GasModelTooLarge.selector);
        new AdapterHarness(c);
    }
}
