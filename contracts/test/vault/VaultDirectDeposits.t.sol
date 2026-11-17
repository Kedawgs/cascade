// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {VaultSetterChecks} from "./VaultSetterChecks.sol";
import {DIRECT_ORIGIN} from "../../src/CascadeConstants.sol";
import {BelowMinDeposit, CapExceeded, NotRaoAligned} from "../../src/CascadeErrors.sol";
import {DepositedDirect, LimitSet} from "../../src/CascadeEvents.sol";
import {Schedule} from "../governance/Schedule.sol";

/// The vault's direct deposits: the price they mint at, their alignment, minimum and cap, and the pause (moved
/// unchanged out of VaultCore.t.sol in Task 42a: VaultCoreTest sits at via-IR's jump-tag limit, and Task 42a's
/// library boundary tests, which sort ahead of test/vault/, pushed it over in a forced build again).
contract VaultDirectDepositsTest is VaultSetterChecks {
    // ---- direct deposits ----

    function test_depositDirectMintsAtOffsetPrice() public {
        vm.deal(alice, 10e18);
        // A = 10e18 - 10e18 = 0, S = 0: 10e18 * (0 + 1e6) / (0 + 1) = 1e25
        vm.expectEmit(address(vault));
        emit DepositedDirect(alice, 10e18, 1e25);
        vm.prank(alice);
        vault.depositDirect{value: 10e18}();

        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(vault.totalSupply(), 1e25);
        assertEq(vaultLens.redeemOrigin(alice), DIRECT_ORIGIN, "no front door burns for a direct depositor");
        assertEq(address(vault).balance, ED + 10e18);
        assertEq(alice.balance, 0);
    }

    function test_depositDirectSecondDepositExcludesOwnValue() public {
        depositDirect(alice, 10e18);
        // A = 15e18 - 5e18 = 10e18, S = 1e25:
        // 5e18 * (1e25 + 1e6) / (10e18 + 1) = 5e24 * (1e19 + 1) / (1e19 + 1) = 5e24
        vm.expectEmit(address(vault));
        emit DepositedDirect(bob, 5e18, 5e24);
        depositDirect(bob, 5e18);

        assertEq(vault.balanceOf(bob), 5e24);
        assertEq(vault.totalSupply(), 15e24);
        assertEq(vaultLens.redeemOrigin(bob), DIRECT_ORIGIN);
    }

    function test_depositDirectRejectsMisaligned() public {
        vm.deal(alice, 10e18 + 1);
        vm.prank(alice);
        vm.expectRevert(NotRaoAligned.selector);
        vault.depositDirect{value: 10e18 + 1}();
        assertEq(vault.totalSupply(), 0);
    }

    function test_depositDirectRejectsBelowMin() public {
        // 1e15 - 1e9 = 999_999 rao: aligned, one rao under the 1e15 minimum
        vm.deal(alice, 1e15 - 1e9);
        vm.prank(alice);
        vm.expectRevert(BelowMinDeposit.selector);
        vault.depositDirect{value: 1e15 - 1e9}();

        // exactly the minimum mints 1e15 * 1e6 = 1e21
        depositDirect(bob, 1e15);
        assertEq(vault.balanceOf(bob), 1e21);

        vm.expectEmit(address(vault));
        emit LimitSet(CascadeVault.setMinDirectDeposit.selector, 2e15, 0);
        vm.prank(owner);
        vault.setMinDirectDeposit(2e15);
        assertEq(vaultLens.minDirectDeposit(), 2e15);

        vm.deal(carol, 1e15);
        vm.prank(carol);
        vm.expectRevert(BelowMinDeposit.selector);
        vault.depositDirect{value: 1e15}();
    }

    function test_depositDirectRejectsAboveCap() public {
        vm.deal(alice, 1_001e18);
        vm.prank(alice);
        vm.expectRevert(CapExceeded.selector);
        vault.depositDirect{value: 1_001e18}();

        // A = 0: 1_000e18 * 1e6 = 1e27, exactly at the cap
        vm.prank(alice);
        vault.depositDirect{value: 1_000e18}();
        assertEq(vault.balanceOf(alice), 1e27);

        // existing assets count against the cap: 1_000e18 + 1e15 > 1_000e18
        vm.deal(bob, 1e15);
        vm.prank(bob);
        vm.expectRevert(CapExceeded.selector);
        vault.depositDirect{value: 1e15}();

        // the cap up is a loosening: a scheduled item (Task 11), 48 hours on
        bytes memory up = abi.encodeCall(CascadeVault.setMaxTotalAssets, (1_001e18));
        vm.prank(owner);
        vault.schedule(up);
        Schedule.warpTo(vm.getBlockTimestamp() + 48 hours);
        vm.expectEmit(address(vault));
        emit LimitSet(CascadeVault.setMaxTotalAssets.selector, 1_001e18, 0);
        vm.prank(owner);
        vault.execute(up);
        assertEq(vaultLens.maxTotalAssets(), 1_001e18);

        // A = 1_000e18, S = 1e27: 1e15 * (1e27 + 1e6) / (1_000e18 + 1) = 1e21 * (1e21 + 1) / (1e21 + 1) = 1e21
        vm.prank(bob);
        vault.depositDirect{value: 1e15}();
        assertEq(vault.balanceOf(bob), 1e21);
    }

    function test_depositDirectWhilePausedReverts() public {
        vm.prank(guardian);
        vault.pause();

        vm.deal(alice, 10e18);
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.depositDirect{value: 10e18}();
    }
}
