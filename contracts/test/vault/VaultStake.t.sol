// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {ISTAKING_ADDRESS, IStaking} from "../../src/interfaces/IStaking.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {VaultTestBase} from "../VaultTestBase.sol";

contract VaultStakeTest is VaultTestBase {
    address stranger = makeAddr("stranger");

    function stakeOf(bytes32 h) internal view returns (uint256) {
        return staking.getStake(h, vault.coldkey(), 0);
    }

    function keeperStakes() internal {
        vm.prank(keeper);
        vault.stakeIdle();
    }

    function redeem(address user, uint256 shares) internal {
        vm.prank(user);
        vault.redeemDirect(shares);
    }

    /// alice's 10e18 staked on HK1 (fresh position, one rao short: 9_999_999_999), then HK2 becomes the
    /// stake hotkey and 5_000_000_000 rao moves onto it (fresh again: HK2 4_999_999_999, HK1 4_999_999_999).
    function splitAcrossHk1AndHk2() internal {
        depositDirect(alice, 10e18);
        keeperStakes();
        vm.startPrank(owner);
        vault.setStakeHotkey(HK2);
        vault.moveStake(HK1, 5_000_000_000);
        vm.stopPrank();
    }

    // ---- stakeIdle ----

    function test_stakeIdleByKeeperStakesEverythingAboveReserve() public {
        depositDirect(alice, 10e18);

        // idle = (1e12 + 10e18) - 1e12 - 0 = 10e18 wei = 10_000_000_000 rao; a fresh position reads one rao short
        vm.expectEmit(address(vault));
        emit CascadeVault.Staked(HK1, 10_000_000_000, 9_999_999_999);
        keeperStakes();

        assertEq(stakeOf(HK1), 9_999_999_999);
        assertEq(address(vault).balance, ED);
        // 9_999_999_999 * 1e9 + 1e12 - 1e12
        assertEq(vault.grossAssets(), 10e18 - 1e9);
        assertEq(vault.lastStakeAt(), block.timestamp);
    }

    function test_stakeIdleStrangerBeforeFallbackReverts() public {
        // setUp's registry delay already put block.timestamp past 0 + 7 days, so the keeper stakes
        // first to start the window.
        depositDirect(alice, 10e18);
        keeperStakes();
        uint256 t0 = block.timestamp;
        depositDirect(bob, 1e18);

        vm.prank(stranger);
        vm.expectRevert(CascadeVault.NotKeeper.selector);
        vault.stakeIdle();

        vm.warp(t0 + 7 days - 1);
        vm.prank(stranger);
        vm.expectRevert(CascadeVault.NotKeeper.selector);
        vault.stakeIdle();

        // bob's 1e18 = 1_000_000_000 rao onto the existing HK1 position (no short)
        vm.warp(t0 + 7 days);
        vm.expectEmit(address(vault));
        emit CascadeVault.Staked(HK1, 1_000_000_000, 1_000_000_000);
        vm.prank(stranger);
        vault.stakeIdle();
        // 9_999_999_999 + 1_000_000_000
        assertEq(stakeOf(HK1), 10_999_999_999);
        assertEq(vault.lastStakeAt(), t0 + 7 days);
    }

    function test_stakeIdleBelowMinReverts() public {
        // 1e15 wei = 1_000_000 rao < 2_000_000
        depositDirect(alice, 1e15);
        vm.prank(keeper);
        vm.expectRevert(CascadeVault.NothingToStake.selector);
        vault.stakeIdle();
        assertEq(address(vault).balance, ED + 1e15);
    }

    function test_stakeIdleWhilePausedReverts() public {
        depositDirect(alice, 10e18);
        vm.prank(guardian);
        vault.pause();

        vm.prank(keeper);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.stakeIdle();
        assertEq(stakeOf(HK1), 0);
    }

    function test_priceToleratesOneRaoShort() public {
        depositDirect(alice, 10e18);
        keeperStakes();

        assertEq(vault.totalAssets(), 10e18 - 1e9);
        // (10e18 - 1e9 + 1) * 1e18 / (1e25 + 1e6) = (1e19 - 1e9 + 1) * 1e12 / (1e19 + 1)
        // = (1e31 - 1e21 + 1e12) / (1e19 + 1); (1e12 - 100) * (1e19 + 1) = 1e31 - 1e21 + 1e12 - 100,
        // so the floor is 1e12 - 100 with remainder 100
        assertEq(vault.price(), 999_999_999_900);
    }

    // ---- floors ----

    function test_floorsReadLive() public {
        assertEq(vault.minStakeRao(), 2_000_000);
        assertEq(vault.minRemainRao(), 20_000_000);

        staking.setMinStake(2_500_000);
        assertEq(vault.minStakeRao(), 2_500_000);
        staking.setNominatorMin(25_000_000);
        assertEq(vault.minRemainRao(), 25_000_000);
    }

    function test_floorsAreTheLargerOfLiveAndFallback() public {
        // live 2_000_000 / 20_000_000; fallbacks raised above them
        vm.prank(owner);
        vault.setFloorFallbacks(3_000_000, 30_000_000);
        assertEq(vault.minStakeRao(), 3_000_000);
        assertEq(vault.minRemainRao(), 30_000_000);

        // live raised above the fallbacks
        staking.setMinStake(4_000_000);
        staking.setNominatorMin(40_000_000);
        assertEq(vault.minStakeRao(), 4_000_000);
        assertEq(vault.minRemainRao(), 40_000_000);
    }

    function test_floorsFallBackWhenReadReverts() public {
        // live reads differ from the fallbacks, so the fallback is visible
        staking.setMinStake(2_500_000);
        staking.setNominatorMin(25_000_000);

        vm.mockCallRevert(ISTAKING_ADDRESS, abi.encodeWithSelector(IStaking.getDefaultMinStake.selector), "");
        assertEq(vault.minStakeRao(), 2_000_000);
        assertEq(vault.minRemainRao(), 25_000_000);

        vm.mockCallRevert(ISTAKING_ADDRESS, abi.encodeWithSelector(IStaking.getNominatorMinRequiredStake.selector), "");
        assertEq(vault.minRemainRao(), 20_000_000);

        vm.prank(owner);
        vault.setFloorFallbacks(3_000_000, 30_000_000);
        assertEq(vault.minStakeRao(), 3_000_000);
        assertEq(vault.minRemainRao(), 30_000_000);
    }

    // ---- hotkey set ----

    function test_addHotkeyRules() public {
        vm.prank(stranger);
        vm.expectRevert(CascadeVault.NotAuthorized.selector);
        vault.addHotkey(HK2);

        vm.startPrank(owner);
        vm.expectEmit(address(vault));
        emit CascadeVault.HotkeyAdded(HK2);
        vault.addHotkey(HK2);
        vault.addHotkey(HK3);
        vault.addHotkey(HK4);
        assertEq(vault.hotkeyCount(), 4);
        assertEq(vault.hotkeys(3), HK4);
        assertTrue(vault.isHotkey(HK4));

        vm.expectRevert(CascadeVault.TooManyHotkeys.selector);
        vault.addHotkey(HK5);
        vm.expectRevert(CascadeVault.HotkeyKnown.selector);
        vault.addHotkey(HK2);
        vm.expectRevert(CascadeVault.ZeroHotkey.selector);
        vault.addHotkey(bytes32(0));
        vm.stopPrank();

        assertEq(vault.hotkeyCount(), 4);
        assertFalse(vault.isHotkey(HK5));
        assertEq(vault.stakeHotkey(), HK1);
    }

    function test_addHotkeyByKeeperOrGuardian() public {
        // a validator's hotkey swap is fixed by re-adding the new hotkey fast: the keeper or guardian may
        vm.expectEmit(address(vault));
        emit CascadeVault.HotkeyAdded(HK2);
        vm.prank(keeper);
        vault.addHotkey(HK2);
        vm.expectEmit(address(vault));
        emit CascadeVault.HotkeyAdded(HK3);
        vm.prank(guardian);
        vault.addHotkey(HK3);
        vm.prank(keeper);
        vault.addHotkey(HK4);
        assertEq(vault.hotkeyCount(), 4);
        assertTrue(vault.isHotkey(HK2));
        assertTrue(vault.isHotkey(HK3));
        // adding never routes new stake
        assertEq(vault.stakeHotkey(), HK1);

        // the set cap still applies
        vm.prank(guardian);
        vm.expectRevert(CascadeVault.TooManyHotkeys.selector);
        vault.addHotkey(HK5);
        vm.prank(keeper);
        vm.expectRevert(CascadeVault.HotkeyKnown.selector);
        vault.addHotkey(HK2);

        // the other hotkey calls stay owner-only
        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        vault.setStakeHotkey(HK2);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        vault.removeHotkey(HK2, false);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        vault.moveStake(HK2, 1);
        vm.stopPrank();
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        vault.removeHotkey(HK2, false);
    }

    function test_setStakeHotkeyAddsAndSwitches() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vault.setStakeHotkey(HK2);

        vm.expectEmit(address(vault));
        emit CascadeVault.HotkeyAdded(HK2);
        vm.expectEmit(address(vault));
        emit CascadeVault.StakeHotkeySet(HK2);
        vm.prank(owner);
        vault.setStakeHotkey(HK2);

        assertTrue(vault.isHotkey(HK2));
        assertEq(vault.stakeHotkey(), HK2);
        assertEq(vault.hotkeyCount(), 2);

        // switching back to a known hotkey does not add it again
        vm.prank(owner);
        vault.setStakeHotkey(HK1);
        assertEq(vault.stakeHotkey(), HK1);
        assertEq(vault.hotkeyCount(), 2);

        vm.prank(owner);
        vm.expectRevert(CascadeVault.ZeroHotkey.selector);
        vault.setStakeHotkey(bytes32(0));
    }

    function test_moveStakeMeasuresBothSides() public {
        depositDirect(alice, 10e18);
        keeperStakes();
        assertEq(stakeOf(HK1), 9_999_999_999);
        vm.prank(owner);
        vault.setStakeHotkey(HK2);

        // HK2 is an empty position, so the credit lands one rao short: 5_000_000_000 - 1
        vm.expectEmit(address(vault));
        emit CascadeVault.StakeMoved(HK1, HK2, 5_000_000_000, 4_999_999_999);
        vm.prank(owner);
        vault.moveStake(HK1, 5_000_000_000);

        // 9_999_999_999 - 5_000_000_000
        assertEq(stakeOf(HK1), 4_999_999_999);
        assertEq(stakeOf(HK2), 4_999_999_999);
        // 4_999_999_999 + 4_999_999_999
        assertEq(vault.rootStakeRao(), 9_999_999_998);
    }

    function test_moveStakeFromStakeHotkeyReverts() public {
        depositDirect(alice, 10e18);
        keeperStakes();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vault.moveStake(HK1, 5_000_000_000);

        vm.startPrank(owner);
        vm.expectRevert(CascadeVault.HotkeyInUse.selector);
        vault.moveStake(HK1, 5_000_000_000);
        vm.expectRevert(CascadeVault.UnknownHotkey.selector);
        vault.moveStake(HK3, 5_000_000_000);
        vm.stopPrank();

        assertEq(stakeOf(HK1), 9_999_999_999);
    }

    function test_removeHotkeyMovesLeftoverAboveMin() public {
        splitAcrossHk1AndHk2();

        // leftover 4_999_999_999 >= 2_000_000 moves onto the non-empty HK2 position (no short)
        vm.expectEmit(address(vault));
        emit CascadeVault.StakeMoved(HK1, HK2, 4_999_999_999, 4_999_999_999);
        vm.expectEmit(address(vault));
        emit CascadeVault.HotkeyRemoved(HK1, 0, false);
        vm.prank(owner);
        vault.removeHotkey(HK1, false);

        assertEq(stakeOf(HK1), 0);
        // 4_999_999_999 + 4_999_999_999
        assertEq(stakeOf(HK2), 9_999_999_998);
        assertEq(vault.hotkeyCount(), 1);
        assertEq(vault.hotkeys(0), HK2);
        assertFalse(vault.isHotkey(HK1));
        assertEq(vault.rootStakeRao(), 9_999_999_998);
    }

    function test_removeHotkeyFullExitsLeftoverBelowMin() public {
        vm.prank(owner);
        vault.setStakeHotkey(HK2);
        staking.donateStake(HK1, vault.coldkey(), 1_500_000);

        // 1_500_000 < 2_000_000: a full exit, 1_500_000 * 1e9 = 1.5e15 wei becomes idle balance
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStakeFull, (HK1, 0)));
        vm.expectEmit(address(vault));
        emit CascadeVault.Unstaked(HK1, 1_500_000, 1.5e15);
        vm.expectEmit(address(vault));
        emit CascadeVault.HotkeyRemoved(HK1, 0, false);
        vm.prank(owner);
        vault.removeHotkey(HK1, false);

        assertEq(address(vault).balance, ED + 1.5e15);
        assertEq(stakeOf(HK1), 0);
        assertEq(vault.hotkeyCount(), 1);
        assertEq(vault.hotkeys(0), HK2);
        assertFalse(vault.isHotkey(HK1));
    }

    function test_removeHotkeyRejectsStakeHotkey() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vault.removeHotkey(HK1, false);

        vm.startPrank(owner);
        vm.expectRevert(CascadeVault.HotkeyInUse.selector);
        vault.removeHotkey(HK1, false);
        vm.expectRevert(CascadeVault.HotkeyInUse.selector);
        vault.removeHotkey(HK1, true);
        vm.expectRevert(CascadeVault.UnknownHotkey.selector);
        vault.removeHotkey(HK3, false);
        vm.stopPrank();

        assertEq(vault.hotkeyCount(), 1);
        assertTrue(vault.isHotkey(HK1));
    }

    function test_removeHotkeyRejectsRewardsAboveDust() public {
        vm.prank(owner);
        vault.setStakeHotkey(HK2);

        // the read is 18-decimal: 1_000_001 rao * 1e9 > hotkeyDustRao (1_000_000) * 1e9
        staking.setUnclaimed(vault.coldkey(), HK1, 1_000_001);
        vm.prank(owner);
        vm.expectRevert(CascadeVault.HotkeyHasRewards.selector);
        vault.removeHotkey(HK1, false);
        assertTrue(vault.isHotkey(HK1));

        // 1_000_000 rao * 1e9 = 1e15 wei, exactly the dust allowance
        staking.setUnclaimed(vault.coldkey(), HK1, 1_000_000);
        vm.expectEmit(address(vault));
        emit CascadeVault.HotkeyRemoved(HK1, 1e15, false);
        vm.prank(owner);
        vault.removeHotkey(HK1, false);
        assertFalse(vault.isHotkey(HK1));
        assertEq(vault.hotkeyCount(), 1);
    }

    function test_removeHotkeyForfeitThenReAdd() public {
        vm.prank(owner);
        vault.setStakeHotkey(HK2);
        staking.setUnclaimed(vault.coldkey(), HK1, 5_000_000);

        // 5_000_000 rao * 1e9 = 5e15 wei, forfeited (stays owed on chain)
        vm.expectEmit(address(vault));
        emit CascadeVault.HotkeyRemoved(HK1, 5e15, true);
        vm.prank(owner);
        vault.removeHotkey(HK1, true);
        assertEq(vault.hotkeyCount(), 1);
        assertFalse(vault.isHotkey(HK1));

        vm.expectEmit(address(vault));
        emit CascadeVault.HotkeyAdded(HK1);
        vm.prank(owner);
        vault.addHotkey(HK1);
        assertEq(vault.hotkeyCount(), 2);
        assertTrue(vault.isHotkey(HK1));
        assertEq(vault.stakeHotkey(), HK2);
    }

    // ---- redeemDirect ----

    function test_redeemDirectFromLiquidBalance() public {
        depositDirect(alice, 10e18);

        // 5e24 * (10e18 + 1) / (1e25 + 1e6) = 5e24 / 1e6 = 5e18 (the denominator is 1e6 * (1e19 + 1))
        vm.expectEmit(address(vault));
        emit CascadeVault.RedeemedDirect(alice, 5e24, 5e18);
        redeem(alice, 5e24);

        assertEq(alice.balance, 5e18);
        assertEq(vault.totalSupply(), 5e24);
        assertEq(vault.balanceOf(alice), 5e24);
        assertEq(address(vault).balance, ED + 5e18);
    }

    function test_redeemDirectUnstakesFullPositionForShortfall() public {
        staking.setOneRaoShort(false);
        depositDirect(alice, 10e18);
        keeperStakes();
        assertEq(stakeOf(HK1), 10_000_000_000);

        // out = 1e25 * (10e18 + 1) / (1e25 + 1e6) = 10e18; available 0; want = ceil(10e18 / 1e9) = 10_000_000_000 >= s
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStakeFull, (HK1, 0)));
        vm.expectEmit(address(vault));
        emit CascadeVault.Unstaked(HK1, 10_000_000_000, 10e18);
        vm.expectEmit(address(vault));
        emit CascadeVault.RedeemedDirect(alice, 1e25, 10e18);
        redeem(alice, 1e25);

        assertEq(alice.balance, 10e18);
        assertEq(stakeOf(HK1), 0);
        assertEq(address(vault).balance, ED);
        assertEq(vault.totalSupply(), 0);

        // the unstake guard is cleared once the walk ends
        vm.deal(bob, 1e18);
        vm.prank(bob);
        (bool ok,) = address(vault).call{value: 1e18}("");
        assertFalse(ok);
    }

    function test_redeemDirectPartialUnstakeKeepsRemainder() public {
        staking.setOneRaoShort(false);
        // 100e18 * (0 + 1e6) / (0 + 1) = 1e26 shares
        depositDirect(alice, 100e18);
        keeperStakes();
        assertEq(stakeOf(HK1), 100_000_000_000);

        // out = 1e25 * (100e18 + 1) / (1e26 + 1e6) = 1e25 / 1e6 = 10e18; want 10_000_000_000 leaves
        // 90_000_000_000 >= 20_000_000, so a partial removeStake
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 10_000_000_000, 0)));
        vm.expectEmit(address(vault));
        emit CascadeVault.Unstaked(HK1, 10_000_000_000, 10e18);
        redeem(alice, 1e25);

        assertEq(stakeOf(HK1), 90_000_000_000);
        assertEq(alice.balance, 10e18);
        assertEq(address(vault).balance, ED);
        assertEq(vault.balanceOf(alice), 9e25);
    }

    function test_redeemDirectFullExitsWhenRemainderBelowNominatorMin() public {
        staking.setOneRaoShort(false);
        depositDirect(alice, 10e18);
        keeperStakes();

        // out = 9.99e24 / 1e6 = 9.99e18; want 9_990_000_000 leaves 10_000_000 < 20_000_000, so the
        // whole 10_000_000_000 rao position exits and 10e18 arrives (a full exit, never a partial request)
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStakeFull, (HK1, 0)));
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeWithSelector(IStaking.removeStake.selector), 0);
        vm.expectEmit(address(vault));
        emit CascadeVault.Unstaked(HK1, 9_990_000_000, 10e18);
        vm.expectEmit(address(vault));
        emit CascadeVault.RedeemedDirect(alice, 9_990_000_000_000_000_000_000_000, 9.99e18);
        redeem(alice, 9_990_000_000_000_000_000_000_000);

        assertEq(stakeOf(HK1), 0);
        assertEq(alice.balance, 9.99e18);
        // 1e12 + 10e18 - 9.99e18; the swept surplus stays idle, it is not restaked
        assertEq(address(vault).balance, ED + 1e16);
    }

    function test_redeemDirectWalksHotkeysStakeHotkeyFirst() public {
        staking.setOneRaoShort(false);
        depositDirect(alice, 10e18);
        keeperStakes();
        vm.startPrank(owner);
        vault.addHotkey(HK2);
        vault.setStakeHotkey(HK2);
        vault.moveStake(HK1, 5_000_000_000);
        vm.stopPrank();
        assertEq(stakeOf(HK1), 5_000_000_000);
        assertEq(stakeOf(HK2), 5_000_000_000);

        // out = 8e24 / 1e6 = 8e18. HK2 (stake hotkey) first: want 8_000_000_000 >= 5_000_000_000, a full
        // exit of 5e18; remaining 3e18. Then HK1: want 3_000_000_000 leaves 2_000_000_000 >= 20_000_000.
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStakeFull, (HK2, 0)));
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 3_000_000_000, 0)));
        vm.expectEmit(address(vault));
        emit CascadeVault.Unstaked(HK2, 8_000_000_000, 5e18);
        vm.expectEmit(address(vault));
        emit CascadeVault.Unstaked(HK1, 3_000_000_000, 3e18);
        redeem(alice, 8e24);

        assertEq(stakeOf(HK2), 0);
        assertEq(stakeOf(HK1), 2_000_000_000);
        assertEq(alice.balance, 8e18);
        assertEq(address(vault).balance, ED);
    }

    function test_redeemDirectRetriesAfterPrecompileRevert() public {
        // a partial unstake (removeStake); test_redeemDirectRetriesAfterFullExitRevert covers removeStakeFull
        staking.setOneRaoShort(false);
        depositDirect(alice, 100e18);
        keeperStakes();
        staking.setUnstakeBlocked(true);

        vm.prank(alice);
        vm.expectRevert(MockStaking.TooEarly.selector);
        vault.redeemDirect(1e25);

        assertEq(vault.balanceOf(alice), 1e26);
        assertEq(vault.totalSupply(), 1e26);
        assertEq(stakeOf(HK1), 100_000_000_000);
        assertEq(alice.balance, 0);

        staking.setUnstakeBlocked(false);
        // 1e25 * (100e18 + 1) / (1e26 + 1e6) = 10e18
        redeem(alice, 1e25);
        assertEq(alice.balance, 10e18);
        assertEq(vault.balanceOf(alice), 9e25);
        assertEq(stakeOf(HK1), 90_000_000_000);
    }

    function test_redeemDirectRetriesAfterFullExitRevert() public {
        staking.setOneRaoShort(false);
        depositDirect(alice, 10e18);
        keeperStakes();
        staking.setUnstakeBlocked(true);

        // out = 10e18 needs the whole 10_000_000_000 rao position: removeStakeFull, blocked
        vm.prank(alice);
        vm.expectRevert(MockStaking.TooEarly.selector);
        vault.redeemDirect(1e25);

        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(vault.totalSupply(), 1e25);
        assertEq(stakeOf(HK1), 10_000_000_000);
        assertEq(alice.balance, 0);

        staking.setUnstakeBlocked(false);
        redeem(alice, 1e25);
        assertEq(alice.balance, 10e18);
        assertEq(vault.balanceOf(alice), 0);
        assertEq(stakeOf(HK1), 0);
    }

    function test_redeemDirectRevertsWhenUnstakeDeliversShort() public {
        staking.setOneRaoShort(false);
        // 1e26 shares, 100_000_000_000 rao staked
        depositDirect(alice, 100e18);
        keeperStakes();
        // the partial removeStake returns without crediting anything
        vm.mockCall(ISTAKING_ADDRESS, abi.encodeWithSelector(IStaking.removeStake.selector), "");

        // out = 1e18 * (100e18 + 1) / (1e26 + 1e6) = 1e18 / 1e6 = 1e12; available 0; want = max(1_000,
        // 2_000_000) = 2_000_000 (partial) arrives as 0, so all 1e12 is unmet. Without the check the send
        // would come out of ED_RESERVE.
        vm.prank(alice);
        vm.expectRevert(CascadeVault.UnstakeShort.selector);
        vault.redeemDirect(1e18);

        assertEq(vault.balanceOf(alice), 1e26);
        assertEq(vault.totalSupply(), 1e26);
        assertEq(stakeOf(HK1), 100_000_000_000);
        assertEq(alice.balance, 0);
        assertEq(address(vault).balance, ED);

        // a delivering unstake goes through: 1e12 + 2_000_000 * 1e9 - 1e12 stays liquid
        vm.clearMockedCalls();
        redeem(alice, 1e18);
        assertEq(alice.balance, 1e12);
        assertEq(stakeOf(HK1), 99_998_000_000);
        assertEq(address(vault).balance, 2e15);
    }

    function test_redeemDirectSkipsEmptyStakeHotkey() public {
        staking.setOneRaoShort(false);
        depositDirect(alice, 10e18);
        keeperStakes();
        vm.startPrank(owner);
        vault.addHotkey(HK2);
        vault.setStakeHotkey(HK2);
        vm.stopPrank();
        assertEq(stakeOf(HK2), 0);

        // out = 5e24 / 1e6 = 5e18. HK2 (stake hotkey) holds nothing and is skipped; HK1: want
        // 5_000_000_000 leaves 5_000_000_000 >= 20_000_000, a partial removeStake
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStakeFull, (HK2, 0)), 0);
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeWithSelector(IStaking.removeStake.selector, HK2), 0);
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 5_000_000_000, 0)));
        vm.expectEmit(address(vault));
        emit CascadeVault.Unstaked(HK1, 5_000_000_000, 5e18);
        redeem(alice, 5e24);

        assertEq(stakeOf(HK1), 5_000_000_000);
        assertEq(stakeOf(HK2), 0);
        assertEq(alice.balance, 5e18);
        assertEq(address(vault).balance, ED);
    }

    function test_redeemDirectSkipsSubMinimumHotkey() public {
        staking.setOneRaoShort(false);
        depositDirect(alice, 10e18);
        keeperStakes();
        // HK2 becomes the stake hotkey holding 1_500_000 rao, below the 2_000_000 minimum (the mock does
        // not enforce the minimum on moves; on chain dust arrives by rewards or a transfer)
        vm.startPrank(owner);
        vault.setStakeHotkey(HK2);
        vault.moveStake(HK1, 1_500_000);
        vm.stopPrank();
        assertEq(stakeOf(HK2), 1_500_000);
        assertEq(stakeOf(HK1), 9_998_500_000);

        // out = 5e24 * (10e18 + 1) / (1e25 + 1e6) = 5e18. HK2 is below the minimum and is not touched;
        // HK1: want 5_000_000_000 leaves 4_998_500_000 >= 20_000_000, a partial removeStake
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStakeFull, (HK2, 0)), 0);
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeWithSelector(IStaking.removeStake.selector, HK2), 0);
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 5_000_000_000, 0)));
        vm.expectEmit(address(vault));
        emit CascadeVault.Unstaked(HK1, 5_000_000_000, 5e18);
        redeem(alice, 5e24);

        assertEq(stakeOf(HK2), 1_500_000);
        assertEq(stakeOf(HK1), 4_998_500_000);
        assertEq(alice.balance, 5e18);
        assertEq(address(vault).balance, ED);
    }

    function test_redeemDirectRequestsRaisedFallbackMinStake() public {
        staking.setOneRaoShort(false);
        // 1e26 shares, 100_000_000_000 rao staked
        depositDirect(alice, 100e18);
        keeperStakes();
        // the owner raises the floors above the live 2_000_000 / 20_000_000
        vm.prank(owner);
        vault.setFloorFallbacks(5_000_000, 50_000_000);

        // out = 1e18 * (100e18 + 1) / (1e26 + 1e6) = 1e12; want = max(1_000, 5_000_000) = 5_000_000 leaves
        // 99_995_000_000 >= 50_000_000, a partial removeStake
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 5_000_000, 0)));
        vm.expectEmit(address(vault));
        emit CascadeVault.Unstaked(HK1, 5_000_000, 5e15);
        redeem(alice, 1e18);

        assertEq(alice.balance, 1e12);
        assertEq(stakeOf(HK1), 99_995_000_000);
        // 1e12 + 5e15 - 1e12 stays liquid
        assertEq(address(vault).balance, 5e15);
    }

    function test_redeemDirectUnstakeMarginCoversRemoveFee() public {
        staking.setOneRaoShort(false);
        // 1e26 shares, 100_000_000_000 rao staked
        depositDirect(alice, 100e18);
        keeperStakes();
        // the chain keeps 50_000 rao of every removal
        staking.setRemoveFeeRao(50_000);

        // out = 1e25 * (100e18 + 1) / (1e26 + 1e6) = 10e18; want 10_000_000_000 arrives as 9_999_950_000 rao
        vm.prank(alice);
        vm.expectRevert(CascadeVault.UnstakeShort.selector);
        vault.redeemDirect(1e25);
        assertEq(vault.balanceOf(alice), 1e26);
        assertEq(stakeOf(HK1), 100_000_000_000);
        // the mock credits with vm.deal, which the revert does not undo
        vm.deal(address(vault), ED);

        vm.expectEmit(address(vault));
        emit CascadeVault.LimitSet("unstakeMarginRao", 50_000, 0);
        vm.prank(owner);
        vault.setUnstakeMarginRao(50_000);
        assertEq(vault.unstakeMarginRao(), 50_000);

        // want = 10_000_000_000 + 50_000 = 10_000_050_000; the fee leaves exactly 10e18
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 10_000_050_000, 0)));
        vm.expectEmit(address(vault));
        emit CascadeVault.Unstaked(HK1, 10_000_050_000, 10e18);
        vm.expectEmit(address(vault));
        emit CascadeVault.RedeemedDirect(alice, 1e25, 10e18);
        redeem(alice, 1e25);
        assertEq(alice.balance, 10e18);
        // 100_000_000_000 - 10_000_050_000
        assertEq(stakeOf(HK1), 89_999_950_000);
        assertEq(address(vault).balance, ED);

        // with no fee the margin's excess stays idle for stakeIdle. A = 89_999_950_000 * 1e9, S = 9e25:
        // out = 1e24 * (89_999_950_000e9 + 1) / (9e25 + 1e6) = 999_999_444_444_444_444 → 999_999_444_000_000_000;
        // want = ceil(out / 1e9) + 50_000 = 1_000_049_444
        staking.setRemoveFeeRao(0);
        redeem(alice, 1e24);
        assertEq(alice.balance, 10e18 + 999_999_444_000_000_000);
        // 1_000_049_444 * 1e9 - 999_999_444_000_000_000 = 50_000 rao idle
        assertEq(address(vault).balance, ED + 50_000e9);
    }

    function test_setUnstakeMarginRaoOwnerOnly() public {
        assertEq(vault.unstakeMarginRao(), 0);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        vault.setUnstakeMarginRao(1);
        assertEq(vault.unstakeMarginRao(), 0);
    }

    function test_redeemDirectBelowOneRaoReverts() public {
        depositDirect(alice, 10e18);

        // 1 * (10e18 + 1) / (1e25 + 1e6) = 0
        vm.prank(alice);
        vm.expectRevert(CascadeVault.ZeroAmount.selector);
        vault.redeemDirect(1);
        // (1e15 - 1) / 1e6 = 999_999_999 wei, floored to whole rao = 0
        vm.prank(alice);
        vm.expectRevert(CascadeVault.ZeroAmount.selector);
        vault.redeemDirect(1e15 - 1);

        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(vault.totalSupply(), 1e25);
        assertEq(address(vault).balance, ED + 10e18);

        // 1e15 / 1e6 = 1e9 wei, exactly one rao
        redeem(alice, 1e15);
        assertEq(alice.balance, 1e9);
        assertEq(vault.balanceOf(alice), 1e25 - 1e15);
    }

    function test_redeemDirectZeroReverts() public {
        depositDirect(alice, 10e18);
        vm.prank(alice);
        vm.expectRevert(CascadeVault.ZeroAmount.selector);
        vault.redeemDirect(0);
    }

    function test_redeemDirectWhilePausedReverts() public {
        depositDirect(alice, 10e18);
        vm.prank(guardian);
        vault.pause();

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.redeemDirect(1e25);
        assertEq(vault.balanceOf(alice), 1e25);
    }

    function test_redeemDirectDoesNotRestake() public {
        staking.setOneRaoShort(false);
        depositDirect(alice, 10e18);
        keeperStakes();
        // totalAssets 10e18 before bob: 1e18 * (1e25 + 1e6) / (10e18 + 1) = 1e18 * 1e6 = 1e24 shares
        depositDirect(bob, 1e18);
        assertEq(vault.balanceOf(bob), 1e24);

        // out = 1e24 * (11e18 + 1) / (1.1e25 + 1e6) = 1e24 / 1e6 = 1e18; available = 1e18, paid from balance
        vm.recordLogs();
        redeem(bob, 1e24);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != CascadeVault.Unstaked.selector);
            assertTrue(logs[i].topics[0] != CascadeVault.Staked.selector);
        }

        assertEq(bob.balance, 1e18);
        assertEq(stakeOf(HK1), 10_000_000_000);
        assertEq(address(vault).balance, ED);
    }
}
