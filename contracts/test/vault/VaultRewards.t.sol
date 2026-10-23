// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CascadeVault} from "../../src/CascadeVault.sol";
import {VaultTestBase} from "../VaultTestBase.sol";

contract VaultRewardsTest is VaultTestBase {
    address stranger = makeAddr("stranger");

    /// alice's 10e18 is staked on HK1 with exact stake reads: HK1 holds 10_000_000_000 rao, the vault
    /// holds only ED, and alice holds 10e18 * (0 + 1e6) / (0 + 1) = 1e25 shares.
    function setUp() public override {
        super.setUp();
        staking.setOneRaoShort(false);
        depositDirect(alice, 10e18);
        vm.prank(keeper);
        vault.stakeIdle();
    }

    function stakeOf(bytes32 h) internal view returns (uint256) {
        return staking.getStake(h, vault.coldkey(), 0);
    }

    function unclaimedOf(bytes32 h) internal view returns (uint256) {
        return staking.getUnclaimedRootTaoByHotkey(vault.coldkey(), h);
    }

    function claimAs(address caller, bytes32 h) internal {
        vm.prank(caller);
        vault.claimRewards{gas: 60_000_000}(h);
    }

    /// The keeper claims 1 TAO (1_000_000_000 rao) of HK1 rewards.
    function claimOneTao() internal {
        staking.setUnclaimed(vault.coldkey(), HK1, 1_000_000_000);
        claimAs(keeper, HK1);
    }

    // ---- claims ----

    function test_claimByKeeperAddsStakeAndVests() public {
        staking.setUnclaimed(vault.coldkey(), HK1, 1_000_000_000);
        uint256 t0 = block.timestamp;

        vm.expectEmit(address(vault));
        emit CascadeVault.RewardsClaimed(HK1, 1e9);
        claimAs(keeper, HK1);

        // 10_000_000_000 + 1_000_000_000
        assertEq(stakeOf(HK1), 11_000_000_000);
        assertEq(unclaimedOf(HK1), 0);
        assertEq(vault.lastClaimAt(HK1), t0);
        assertEq(vault.vestingAmount(), 1e18);
        assertEq(vault.vestingStart(), t0);
        // 11_000_000_000 * 1e9 + 1e12 - 1e12
        assertEq(vault.grossAssets(), 11e18);
        // 11e18 - 0 pending - 1e18 unvested
        assertEq(vault.totalAssets(), 10e18);

        // half vested: 11e18 - 1e18 * 3.5 days / 7 days
        vm.warp(t0 + 3.5 days);
        assertEq(vault.totalAssets(), 10.5e18);

        vm.warp(t0 + 7 days);
        assertEq(vault.totalAssets(), 11e18);
    }

    function test_claimMeasuresWholePosition() public {
        // the chain pays this claim out as liquid balance instead of stake on HK1: it is still measured
        // and vested, so the price does not jump
        staking.setClaimToBalance(true);
        staking.setUnclaimed(vault.coldkey(), HK1, 1_000_000_000);
        uint256 t0 = block.timestamp;

        vm.expectEmit(address(vault));
        emit CascadeVault.RewardsClaimed(HK1, 1e9);
        claimAs(keeper, HK1);

        assertEq(stakeOf(HK1), 10_000_000_000);
        assertEq(address(vault).balance, ED + 1e18);
        assertEq(vault.vestingAmount(), 1e18);
        assertEq(vault.vestingStart(), t0);
        // (10_000_000_000 * 1e9 + ED + 1e18) - ED
        assertEq(vault.grossAssets(), 11e18);
        // 11e18 - 1e18 unvested
        assertEq(vault.totalAssets(), 10e18);

        vm.warp(t0 + 7 days);
        assertEq(vault.totalAssets(), 11e18);
    }

    function test_claimStrangerBeforeFallbackReverts() public {
        // setUp's registry delay already put block.timestamp 7 days past the deploy seed, so the keeper
        // claims first to start HK1's window.
        claimAs(keeper, HK1);
        uint256 t0 = block.timestamp;
        staking.setUnclaimed(vault.coldkey(), HK1, 1_000_000_000);

        vm.prank(stranger);
        vm.expectRevert(CascadeVault.NotKeeper.selector);
        vault.claimRewards{gas: 60_000_000}(HK1);

        vm.warp(t0 + 7 days - 1);
        vm.prank(stranger);
        vm.expectRevert(CascadeVault.NotKeeper.selector);
        vault.claimRewards{gas: 60_000_000}(HK1);

        vm.warp(t0 + 7 days);
        vm.expectEmit(address(vault));
        emit CascadeVault.RewardsClaimed(HK1, 1e9);
        claimAs(stranger, HK1);
        assertEq(stakeOf(HK1), 11_000_000_000);
        assertEq(vault.lastClaimAt(HK1), t0 + 7 days);
    }

    function test_claimFallbackIsPerHotkey() public {
        // HK2 is added (and seeded) at 8 days; HK1 is claimed by the keeper 7 days later
        vm.warp(8 days);
        vm.prank(owner);
        vault.addHotkey(HK2);
        staking.setUnclaimed(vault.coldkey(), HK2, 500_000_000);
        vm.warp(15 days);
        claimAs(keeper, HK1);
        assertEq(vault.lastClaimAt(HK1), 15 days);

        vm.prank(stranger);
        vm.expectRevert(CascadeVault.NotKeeper.selector);
        vault.claimRewards{gas: 60_000_000}(HK1);

        // HK2's own window, from its seed, has passed
        vm.expectEmit(address(vault));
        emit CascadeVault.RewardsClaimed(HK2, 500_000_000);
        claimAs(stranger, HK2);
        assertEq(stakeOf(HK2), 500_000_000);
        assertEq(vault.lastClaimAt(HK2), 15 days);
    }

    function test_claimFallbackSeededAtDeploy() public {
        uint256 t0 = block.timestamp;
        CascadeVault v = freshVault();

        // the constructor hotkey's window starts at deploy
        vm.prank(stranger);
        vm.expectRevert(CascadeVault.NotKeeper.selector);
        v.claimRewards{gas: 60_000_000}(HK1);
        vm.warp(t0 + 7 days - 1);
        vm.prank(stranger);
        vm.expectRevert(CascadeVault.NotKeeper.selector);
        v.claimRewards{gas: 60_000_000}(HK1);
        assertEq(v.lastClaimAt(HK1), t0);

        vm.warp(t0 + 7 days);
        vm.expectEmit(address(v));
        emit CascadeVault.RewardsClaimed(HK1, 0);
        vm.prank(stranger);
        v.claimRewards{gas: 60_000_000}(HK1);
        assertEq(v.lastClaimAt(HK1), t0 + 7 days);
    }

    function test_claimFallbackSeededWhenHotkeyAdded() public {
        uint256 t0 = block.timestamp;
        vm.prank(keeper);
        vault.addHotkey(HK2);
        staking.setUnclaimed(vault.coldkey(), HK2, 500_000_000);

        // added 1 day ago: still the keeper's
        vm.warp(t0 + 1 days);
        vm.prank(stranger);
        vm.expectRevert(CascadeVault.NotKeeper.selector);
        vault.claimRewards{gas: 60_000_000}(HK2);
        assertEq(vault.lastClaimAt(HK2), t0);

        // setStakeHotkey adds a new hotkey through the same path
        vm.prank(owner);
        vault.setStakeHotkey(HK3);
        assertEq(vault.lastClaimAt(HK3), t0 + 1 days);
        vm.prank(stranger);
        vm.expectRevert(CascadeVault.NotKeeper.selector);
        vault.claimRewards{gas: 60_000_000}(HK3);

        vm.warp(t0 + 7 days);
        vm.expectEmit(address(vault));
        emit CascadeVault.RewardsClaimed(HK2, 500_000_000);
        claimAs(stranger, HK2);
        assertEq(vault.lastClaimAt(HK2), t0 + 7 days);

        // only an unset timestamp is seeded: a removed and re-added hotkey keeps its last claim
        vm.prank(owner);
        vault.removeHotkey(HK2, false);
        vm.warp(t0 + 20 days);
        vm.prank(owner);
        vault.addHotkey(HK2);
        assertEq(vault.lastClaimAt(HK2), t0 + 7 days);
    }

    function test_claimInsufficientGasRevertsBeforeCall() public {
        staking.setUnclaimed(vault.coldkey(), HK1, 1_000_000_000);

        vm.prank(keeper);
        vm.expectRevert(CascadeVault.InsufficientGas.selector);
        vault.claimRewards{gas: 50_000_000}(HK1);

        assertEq(unclaimedOf(HK1), 1e18);
        assertEq(stakeOf(HK1), 10_000_000_000);
        assertEq(vault.lastClaimAt(HK1), deployedAt);
    }

    function test_claimGasBurningFailureLeavesStateUntouched() public {
        staking.setUnclaimed(vault.coldkey(), HK1, 1_000_000_000);
        staking.setClaimTooHeavy(true);

        vm.prank(keeper);
        (bool ok,) = address(vault).call{gas: 60_000_000}(abi.encodeCall(vault.claimRewards, (HK1)));

        assertFalse(ok);
        assertEq(unclaimedOf(HK1), 1e18);
        assertEq(stakeOf(HK1), 10_000_000_000);
        assertEq(vault.lastClaimAt(HK1), deployedAt);
        assertEq(vault.vestingAmount(), 0);
        assertEq(vault.vestingStart(), 0);
    }

    function test_claimZeroDeltaSucceeds() public {
        // a 1 TAO claim at t0 starts a schedule that a later empty claim must not restart
        claimOneTao();
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 3.5 days);
        // 11e18 - 1e18 * 3.5 days / 7 days
        assertEq(vault.totalAssets(), 10.5e18);

        vm.expectEmit(address(vault));
        emit CascadeVault.RewardsClaimed(HK1, 0);
        claimAs(keeper, HK1);

        assertEq(vault.lastClaimAt(HK1), t0 + 3.5 days);
        assertEq(vault.vestingAmount(), 1e18);
        assertEq(vault.vestingStart(), t0);
        assertEq(stakeOf(HK1), 11_000_000_000);
        // still half vested; restarting would have re-spread 0.5e18 over 7 days (11e18 - 0.5e18)
        assertEq(vault.totalAssets(), 10.5e18);
    }

    function test_claimUnknownHotkeyReverts() public {
        vm.prank(keeper);
        vm.expectRevert(CascadeVault.UnknownHotkey.selector);
        vault.claimRewards{gas: 60_000_000}(HK2);
    }

    function test_claimWorksWhilePaused() public {
        vm.prank(guardian);
        vault.pause();

        claimOneTao();

        assertEq(stakeOf(HK1), 11_000_000_000);
        assertEq(vault.vestingAmount(), 1e18);
        assertEq(vault.lastClaimAt(HK1), block.timestamp);
    }

    function test_setClaimGasRequiredEmits() public {
        vm.expectEmit(address(vault));
        emit CascadeVault.ClaimGasSet(70_000_000);
        vm.prank(owner);
        vault.setClaimGasRequired(70_000_000);
        assertEq(vault.claimGasRequired(), 70_000_000);

        vm.prank(keeper);
        vm.expectRevert(CascadeVault.InsufficientGas.selector);
        vault.claimRewards{gas: 60_000_000}(HK1);
    }

    // ---- vesting ----

    function test_vestingCurveIsLinear() public {
        claimOneTao();
        uint256 t0 = block.timestamp;
        assertEq(vault.unvestedRewards(), 1e18);

        // 1e18 * 6 days / 7 days
        vm.warp(t0 + 1 days);
        assertEq(vault.unvestedRewards(), 857142857142857142);

        vm.warp(t0 + 7 days);
        assertEq(vault.unvestedRewards(), 0);
    }

    function test_secondClaimRestartsWithRemainder() public {
        claimOneTao();
        uint256 t1 = block.timestamp + 3.5 days;

        // 1e18 * 3.5 days / 7 days
        vm.warp(t1);
        assertEq(vault.unvestedRewards(), 5e17);

        claimOneTao();
        // 5e17 still unvested + 1e18 claimed
        assertEq(vault.vestingAmount(), 1.5e18);
        assertEq(vault.vestingStart(), t1);
        assertEq(vault.unvestedRewards(), 1.5e18);
        // 10_000_000_000 + 2 * 1_000_000_000
        assertEq(stakeOf(HK1), 12_000_000_000);

        vm.warp(t1 + 7 days);
        assertEq(vault.unvestedRewards(), 0);
    }

    function test_sandwichAroundClaimYieldsNothing() public {
        staking.setUnclaimed(vault.coldkey(), HK1, 1_000_000_000);

        // assetsBefore 10e18, supply 1e25: 1e19 * (1e25 + 1e6) / (1e19 + 1) = 1e25
        depositDirect(bob, 10e18);
        assertEq(vault.balanceOf(bob), 1e25);

        claimAs(keeper, HK1);
        // gross 11e18 staked + 10e18 idle = 21e18, minus 1e18 unvested
        assertEq(vault.totalAssets(), 20e18);

        // 1e25 * (2e19 + 1) / (2e25 + 1e6) = 1e19
        vm.prank(bob);
        vault.redeemDirect(1e25);
        assertEq(bob.balance, 10e18);
        assertEq(vault.balanceOf(bob), 0);
    }
}
