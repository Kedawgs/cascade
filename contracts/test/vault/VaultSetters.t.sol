// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {InvalidParameter} from "../../src/CascadeErrors.sol";
import {ClaimGasSet, KeeperSet, LimitSet, OutflowLimitsSet} from "../../src/CascadeEvents.sol";
import {Schedule} from "../governance/Schedule.sol";
import {VaultSetterChecks} from "./VaultSetterChecks.sol";

/// The vault's parameter setters: their hard bounds, their events and who may call them (moved unchanged out of
/// VaultCore.t.sol in Task 37: VaultCoreTest sits at via-IR's jump-tag limit).
contract VaultSettersTest is VaultSetterChecks {
    function test_settersRejectInvalid() public {
        // the fixture's Params (DefaultParams.sol)
        assertEq(vaultLens.maxDailyOutflowBps(), 2000);
        assertEq(vaultLens.minDailyOutflow(), 100e18);
        assertEq(vaultLens.globalOutflowBps(), 2000);
        assertEq(vaultLens.maxEntryValue(), 2_000e18);
        assertEq(vaultLens.maxMessageValue(), 4_000e18);
        assertEq(vaultLens.minChunk(), 10);
        assertEq(vaultLens.payoutDelay(), 24 hours);
        assertEq(vaultLens.maxFeeBps(), 100);
        assertEq(vaultLens.maxFeeAbs(), 0.015e18);
        assertEq(vaultLens.maxTotalAssets(), 1_000e18);
        assertEq(vaultLens.minDirectDeposit(), 1e15);
        assertEq(vaultLens.hotkeyDustRao(), 1_000_000);
        assertEq(vaultLens.claimGasRequired(), 55_000_000);

        // The exit protections have hard bounds. A value past one in the loosening direction is refused directly
        // as a loosening and, scheduled, by the setter at execute (Task 11); past one in the tightening
        // direction, by the setter at once.
        // at most 50% of the base a day, a door's or all doors', a floor of at most 100 TAO
        assertLooseningRefused(abi.encodeCall(CascadeVault.setOutflowLimits, (5_001, 100e18, 2000)));
        assertLooseningRefused(abi.encodeCall(CascadeVault.setOutflowLimits, (2000, 100e18 + 1, 2000)));
        assertLooseningRefused(abi.encodeCall(CascadeVault.setOutflowLimits, (2000, 100e18, 5_001)));
        assertLooseningRefused(abi.encodeCall(CascadeVault.setMessageLimits, (4_000e18 + 1, 4_000e18, 10)));
        assertLooseningRefused(abi.encodeCall(CascadeVault.setMessageLimits, (2_000e18, 4_000e18, 0)));
        // a payout message above the lane's 5,000 TAO could never be sent
        assertLooseningRefused(abi.encodeCall(CascadeVault.setMessageLimits, (2_000e18, 5_000e18 + 1, 10)));
        // the fee ceiling: at most 5% of a chunk, and 0.01 to 0.015 TAO (Task 21)
        assertLooseningRefused(abi.encodeCall(CascadeVault.setFeeLimits, (501, 0.015e18)));
        assertLooseningRefused(abi.encodeCall(CascadeVault.setFeeLimits, (100, 0.015e18 + 1)));
        // the payout delay: at least 1 hour
        assertLooseningRefused(abi.encodeCall(CascadeVault.setPayoutDelay, (1 hours - 1)));
        assertLooseningRefused(abi.encodeCall(CascadeVault.setPayoutDelay, (0)));

        vm.startPrank(owner);
        // at least 20% of the base a day, a door's or all doors', a floor of at least 10 TAO (Task 17), a chunk of at
        // most 50 entries (MAX_ENTRIES, Task 18), a payout delay of at most 48 hours: tightenings past a bound (the fee
        // ceiling's floor: test_feeLimitBounds, Task 21)
        vm.expectRevert(InvalidParameter.selector);
        vault.setOutflowLimits(1_999, 100e18, 2000);
        vm.expectRevert(InvalidParameter.selector);
        vault.setOutflowLimits(2000, 10e18 - 1, 2000);
        vm.expectRevert(InvalidParameter.selector);
        vault.setOutflowLimits(2000, 100e18, 1_999);
        vm.expectRevert(InvalidParameter.selector);
        vault.setMessageLimits(2_000e18, 4_000e18, 51);
        vm.expectRevert(InvalidParameter.selector);
        vault.setPayoutDelay(48 hours + 1);
        // the unstake margin: at most 1 TAO per removal
        vm.expectRevert(InvalidParameter.selector);
        vault.setUnstakeMarginRao(1e9 + 1);

        // the boundaries themselves are accepted, each with its event; those reached by loosening as scheduled
        // items, executed 48 hours on
        bytes[5] memory loosenings = [
            abi.encodeCall(CascadeVault.setOutflowLimits, (5_000, 100e18, 5_000)),
            abi.encodeCall(CascadeVault.setMessageLimits, (5_000e18, 5_000e18, 50)),
            abi.encodeCall(CascadeVault.setMessageLimits, (10e18, 10e18, 1)),
            abi.encodeCall(CascadeVault.setFeeLimits, (500, 0.015e18)),
            abi.encodeCall(CascadeVault.setPayoutDelay, (1 hours))
        ];
        for (uint256 i; i < loosenings.length; ++i) {
            vault.schedule(loosenings[i]);
        }
        Schedule.warpTo(vm.getBlockTimestamp() + 48 hours);
        vm.expectEmit(address(vault));
        emit OutflowLimitsSet(5_000, 100e18, 5_000);
        vault.execute(loosenings[0]);
        vm.expectEmit(address(vault));
        emit OutflowLimitsSet(2000, 10e18, 2000);
        vault.setOutflowLimits(2000, 10e18, 2000);
        vm.expectEmit(address(vault));
        emit LimitSet(CascadeVault.setMessageLimits.selector, 5_000e18, 5_000e18);
        vm.expectEmit(address(vault));
        emit LimitSet(CascadeVault.setMessageLimits.selector, 50, 0);
        vault.execute(loosenings[1]);
        vault.execute(loosenings[2]);
        vm.expectEmit(address(vault));
        emit LimitSet(CascadeVault.setFeeLimits.selector, 500, 0.015e18);
        vault.execute(loosenings[3]);
        vm.expectEmit(address(vault));
        emit LimitSet(CascadeVault.setPayoutDelay.selector, 1 hours, 0);
        vault.execute(loosenings[4]);
        vm.expectEmit(address(vault));
        emit LimitSet(CascadeVault.setPayoutDelay.selector, 48 hours, 0);
        vault.setPayoutDelay(48 hours);
        vm.expectEmit(address(vault));
        emit LimitSet(CascadeVault.setUnstakeMarginRao.selector, 1e9, 0);
        vault.setUnstakeMarginRao(1e9);
        vm.expectEmit(address(vault));
        emit LimitSet(CascadeVault.setHotkeyDustRao.selector, 5, 0);
        vault.setHotkeyDustRao(5);
        vm.expectEmit(address(vault));
        emit ClaimGasSet(60_000_000);
        vault.setClaimGasRequired(60_000_000);
        vm.stopPrank();

        assertEq(vaultLens.maxDailyOutflowBps(), 2000);
        assertEq(vaultLens.minDailyOutflow(), 10e18);
        assertEq(vaultLens.globalOutflowBps(), 2000);
        assertEq(vaultLens.maxEntryValue(), 10e18);
        assertEq(vaultLens.maxMessageValue(), 10e18);
        assertEq(vaultLens.minChunk(), 1);
        assertEq(vaultLens.maxFeeBps(), 500);
        assertEq(vaultLens.maxFeeAbs(), 0.015e18);
        assertEq(vaultLens.payoutDelay(), 48 hours);
        assertEq(vaultLens.unstakeMarginRao(), 1e9);
        assertEq(vaultLens.hotkeyDustRao(), 5);
        assertEq(vaultLens.claimGasRequired(), 60_000_000);
    }

    /// Calls `call` on the vault as the owner and asserts its LimitSet events: exactly `values.length`
    /// of them, in order, each keyed by the called setter's own selector (the first four bytes of
    /// `call`), with its two values.
    function assertLimitSets(bytes memory call, uint256[2][] memory values) internal {
        vm.recordLogs();
        vm.prank(owner);
        (bool ok,) = address(vault).call(call);
        assertTrue(ok, "the setter reverted");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // casting to 'bytes4' keeps exactly the call's selector, its first four bytes; an indexed bytes4
        // is that selector left-aligned in its 32-byte topic
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes32 topic = bytes32(bytes4(call));
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != LimitSet.selector) continue;
            assertLt(n, values.length, "one LimitSet too many");
            assertEq(logs[i].emitter, address(vault));
            assertEq(logs[i].topics[1], topic, "keyed by the setter's selector");
            (uint256 a, uint256 b) = abi.decode(logs[i].data, (uint256, uint256));
            assertEq(a, values[n][0], "the first value");
            assertEq(b, values[n][1], "the second value");
            ++n;
        }
        assertEq(n, values.length, "LimitSet events");
    }

    function one(uint256 a, uint256 b) internal pure returns (uint256[2][] memory values) {
        values = new uint256[2][](1);
        values[0] = [a, b];
    }

    /// Spec §8's trim (ruling DA7): LimitSet is keyed by the setter's selector, one event with its two
    /// values; setMessageLimits, with three, emits two under its selector in a fixed order: (first,
    /// second), then (third, 0). Each value a tightening, so each call applies at once (the same events
    /// under execute: SetterDirections.t.sol, the T7 carry).
    function test_limitSetKeyedBySelector() public {
        assertLimitSets(abi.encodeCall(CascadeVault.setMinDirectDeposit, (2e15)), one(2e15, 0));
        assertLimitSets(abi.encodeCall(CascadeVault.setMaxTotalAssets, (999e18)), one(999e18, 0));
        // setOutflowLimits, with three values, logs OutflowLimitsSet instead (Task 17): no LimitSet
        assertLimitSets(abi.encodeCall(CascadeVault.setOutflowLimits, (2000, 50e18, 2000)), new uint256[2][](0));
        assertLimitSets(abi.encodeCall(CascadeVault.setFeeLimits, (50, 0.01e18)), one(50, 0.01e18));
        assertLimitSets(abi.encodeCall(CascadeVault.setPayoutDelay, (30 hours)), one(30 hours, 0));
        assertLimitSets(abi.encodeCall(CascadeVault.setHotkeyDustRao, (7)), one(7, 0));
        assertLimitSets(abi.encodeCall(CascadeVault.setUnstakeMarginRao, (5)), one(5, 0));
        uint256[2][] memory two = new uint256[2][](2);
        two[0] = [uint256(1_500e18), 3_000e18];
        two[1] = [uint256(17), 0];
        assertLimitSets(abi.encodeCall(CascadeVault.setMessageLimits, (1_500e18, 3_000e18, 17)), two);
    }

    function test_settersOwnerOnly() public {
        bytes memory unauthorized = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian);
        vm.startPrank(guardian);
        vm.expectRevert(unauthorized);
        vault.setOutflowLimits(2000, 100e18, 2000);
        vm.expectRevert(unauthorized);
        vault.setKeeper(guardian);
        vm.expectRevert(unauthorized);
        vault.setMinDirectDeposit(0);
        vm.expectRevert(unauthorized);
        vault.setMaxTotalAssets(0);
        vm.expectRevert(unauthorized);
        vault.setMessageLimits(1, 1, 1);
        vm.expectRevert(unauthorized);
        vault.setFeeLimits(0, 0);
        vm.expectRevert(unauthorized);
        vault.setPayoutDelay(0);
        vm.expectRevert(unauthorized);
        vault.setClaimGasRequired(0);
        vm.expectRevert(unauthorized);
        vault.setHotkeyDustRao(0);
        vm.stopPrank();

        // the owner may clear the keeper (fallback-only mode)
        assertEq(vaultLens.keeper(), keeper);
        vm.expectEmit(address(vault));
        emit KeeperSet(address(0));
        vm.prank(owner);
        vault.setKeeper(address(0));
        assertEq(vaultLens.keeper(), address(0));
    }
}
