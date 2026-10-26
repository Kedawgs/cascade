// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CascadeVault} from "../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../src/CascadeFrontDoor.sol";
import {CascadeMessages} from "../src/libraries/CascadeMessages.sol";
import {MockTAO} from "./mocks/MockTAO.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {VaultTestBase} from "./VaultTestBase.sol";

/// @notice Delivery gas against the bridge's delivery budget, and deployed code size against EIP-170.
contract GasTest is VaultTestBase {
    /// 100 holders (0x1000 + i) deposit 10e18 each at A = 0, S = 0: 1e25 shares each; gross 1_000e18.
    function setUp() public override {
        super.setUp();
        CascadeMessages.Entry[] memory holders = new CascadeMessages.Entry[](100);
        for (uint256 i; i < 100; ++i) {
            holders[i] = CascadeMessages.Entry(addr(0x1000 + i), 10e18);
        }
        deliver(BASE, frontDoor, 1, holders, noEntries());
    }

    function addr(uint256 n) internal pure returns (address) {
        // casting to 'uint160' is safe because n is a small test index
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(n));
    }

    /// Delivers n fresh depositors (0x2000 + i, 1e18 each) and n holder redeems (0x1000 + i, 1e24 each)
    /// in one batch and returns the gas the delivery call used.
    function measureDelivery(uint256 n) internal returns (uint256 g) {
        CascadeMessages.Entry[] memory d = new CascadeMessages.Entry[](n);
        CascadeMessages.Entry[] memory r = new CascadeMessages.Entry[](n);
        for (uint256 i; i < n; ++i) {
            d[i] = CascadeMessages.Entry(addr(0x2000 + i), 1e18);
            r[i] = CascadeMessages.Entry(addr(0x1000 + i), 1e24);
        }
        bytes memory message = CascadeMessages.encodeBatch(2, d, r);
        uint256 value = n * 1e18;
        vm.deal(address(bridge), value);

        vm.prank(address(bridge));
        g = gasleft();
        vault.onBridgeMessage{value: value}(BASE, frontDoor, message, value);
        g -= gasleft();

        // A = 1_000e18 + value - value, S = 1e27: deposit 1e18 → 1e24 shares; redeem 1e24 → 1e18,
        // all within the allowance, 20% of the gross before the deposits (1_000e18) = 200e18 >= value
        CascadeVault.PayoutBatch memory b = vault.getPayoutBatch(vault.batchKey(BASE, frontDoor, message));
        assertEq(b.count, n);
        assertEq(b.remaining, value);
        assertEq(vault.balanceOf(addr(0x2000 + n - 1)), 1e24);
        assertEq(vault.balanceOf(addr(0x1000 + n - 1)), 9e24);
    }

    function test_gas_delivery100Plus100Under6_5M() public {
        uint256 g = measureDelivery(100);
        emit log_named_uint("gas 100+100", g);
        assertLt(g, 6_500_000);
    }

    function test_gas_delivery50Plus50Under3_5M() public {
        uint256 g = measureDelivery(50);
        emit log_named_uint("gas 50+50", g);
        assertLt(g, 3_500_000);
    }

    function test_size_vaultAndFrontDoorUnderLimit() public {
        CascadeFrontDoor fd = new CascadeFrontDoor(
            new MockTAO(18),
            bridge,
            BITTENSOR,
            address(vault),
            owner,
            guardian,
            12 hours,
            1e18,
            10_000e18,
            1e14,
            new MockUSDC()
        );
        emit log_named_uint("vault runtime bytes", address(vault).code.length);
        emit log_named_uint("front door runtime bytes", address(fd).code.length);
        assertLt(address(vault).code.length, 24_576);
        assertLt(address(fd).code.length, 24_576);
    }
}
