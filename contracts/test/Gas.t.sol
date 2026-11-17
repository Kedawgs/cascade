// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CascadeVault} from "../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../src/CascadeFrontDoor.sol";
import {CascadeMessages} from "../src/libraries/CascadeMessages.sol";
import {MockTAO} from "./mocks/MockTAO.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {VaultTestBase} from "./VaultTestBase.sol";
import {defaultFrontDoorParams} from "./utils/DefaultParams.sol";
import {PayoutBatch} from "../src/CascadeTypes.sol";

/// @notice Delivery gas against the bridge's delivery budget, and deployed code size against EIP-170.
contract GasTest is VaultTestBase {
    /// 50 holders (0x1000 + i) deposit 20e18 each at A = 0, S = 0: 2e25 shares each; gross 1_000e18.
    function setUp() public override {
        super.setUp();
        CascadeMessages.Entry[] memory holders = new CascadeMessages.Entry[](50);
        for (uint256 i; i < 50; ++i) {
            holders[i] = CascadeMessages.Entry(addr(0x1000 + i), 20e18);
        }
        deliver(BASE, frontDoor, 1, holders, noEntries());
        // their shares held a day, so the measured redeems burn (the door hold, R4 B-H1)
        vm.warp(vm.getBlockTimestamp() + 1 days);
    }

    function addr(uint256 n) internal pure returns (address) {
        // casting to 'uint160' is safe because n is a small test index
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(n));
    }

    /// Delivers n fresh depositors (0x2000 + i, 1e18 each) and n holder redeems (0x1000 + i, 1e24 each)
    /// in one batch and returns the gas the delivery call used, measured cold as on chain (Task 18): the vault's
    /// storage and the staking precompile's are cooled first, so no read is warm from setUp.
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

        vm.cool(address(vault));
        vm.cool(address(staking));
        vm.prank(address(bridge));
        g = gasleft();
        vault.onBridgeMessage{value: value}(BASE, frontDoor, message, value);
        g -= gasleft();

        // A = 1_000e18 + value - value, S = 1e27: deposit 1e18 → 1e24 shares; redeem 1e24 → 1e18, all within
        // the allowance (nothing is staked, so the 100e18 floor, at least value)
        PayoutBatch memory b = vaultLens.getPayoutBatch(vaultLens.batchKey(BASE, frontDoor, message));
        assertEq(b.count, n);
        assertEq(b.remaining, value);
        assertEq(vault.balanceOf(addr(0x2000 + n - 1)), 1e24);
        assertEq(vault.balanceOf(addr(0x1000 + n - 1)), 19e24);
    }

    /// The largest legal batch, 50 + 50 (MAX_ENTRIES since Task 18), measured cold: 3,491,035 gas on 2026-11-03,
    /// so the bound leaves about 7%.
    function test_gas_delivery50Plus50Under3_75M() public {
        uint256 g = measureDelivery(50);
        emit log_named_uint("gas 50+50", g);
        assertLt(g, 3_750_000);
    }

    function test_size_vaultAndFrontDoorUnderLimit() public {
        CascadeFrontDoor fd = new CascadeFrontDoor(
            defaultFrontDoorParams(
                new MockTAO(18), bridge, BITTENSOR, address(vault), new MockUSDC(), owner, guardian, keeper
            )
        );
        emit log_named_uint("vault runtime bytes", address(vault).code.length);
        emit log_named_uint("front door runtime bytes", address(fd).code.length);
        assertLt(address(vault).code.length, 24_576);
        assertLt(address(fd).code.length, 24_576);
    }
}
