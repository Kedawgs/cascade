// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockAlphaVault} from "./mocks/MockAlphaVault.sol";
import {MockTAO} from "./mocks/MockTAO.sol";

contract MockAlphaVaultTest is Test {
    MockTAO tao;
    MockAlphaVault vault;

    function setUp() public {
        tao = new MockTAO(18);
        vault = new MockAlphaVault(tao);
        vm.deal(address(vault), 100 ether);
        vm.deal(address(this), 100 ether);
    }

    function test_withdrawLiquid_belowFloorReverts() public {
        tao.mint(address(this), 10e18);
        vm.expectRevert(MockAlphaVault.AmountTooLow.selector);
        vault.withdrawLiquid(address(tao), 1e15, 0);
        uint256 before = address(this).balance;
        vault.withdrawLiquid(address(tao), 2e15, 0);
        assertEq(address(this).balance - before, 2e15);
    }

    function test_withdrawLiquid_burnsAndPays() public {
        tao.mint(address(this), 10e18);
        uint256 before = address(this).balance;
        uint256 out = vault.withdrawLiquid(address(tao), 4e18, 4e18);
        assertEq(out, 4e18);
        assertEq(tao.balanceOf(address(this)), 6e18);
        assertEq(address(this).balance - before, 4e18);
    }

    function test_withdrawLiquid_shortByPaysLess() public {
        tao.mint(address(this), 10e18);
        vault.setShortBy(1);
        uint256 before = address(this).balance;
        uint256 out = vault.withdrawLiquid(address(tao), 4e18, 4e18);
        assertEq(out, 4e18 - 1);
        assertEq(address(this).balance - before, 4e18 - 1);
    }

    function test_depositLiquid_mintsOneToOne() public {
        uint256 minted = vault.depositLiquid{value: 3e18}(address(tao), 3e9);
        assertEq(minted, 3e18);
        assertEq(tao.balanceOf(address(this)), 3e18);
    }

    function test_depositLiquid_pausedReverts() public {
        vault.setPaused(true);
        vm.expectRevert(MockAlphaVault.Halted.selector);
        vault.depositLiquid{value: 3e18}(address(tao), 0);
    }

    receive() external payable {}
}
