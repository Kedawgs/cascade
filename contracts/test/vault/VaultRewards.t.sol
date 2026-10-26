// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CascadeBase} from "../../src/CascadeBase.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {ISTAKING_ADDRESS, IStaking} from "../../src/interfaces/IStaking.sol";
import {CascadeMath} from "../../src/libraries/CascadeMath.sol";
import {VaultTestBase} from "../VaultTestBase.sol";

/// @notice Stands in for the precompile's claim through vm.mockFunction (run in its place, so
/// msg.sender is the vault): credits the caller 9 wei, a delta finer than any rao reward.
contract DustClaim {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function claimRootWithHotkey(bytes32) external {
        vm.deal(msg.sender, msg.sender.balance + 9);
    }
}

contract VaultRewardsTest is VaultTestBase {
    address stranger = makeAddr("stranger");
    address treasury = makeAddr("treasury");

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

    function setCut(uint16 bps) internal {
        vm.prank(owner);
        vault.setRewardCut(treasury, bps);
    }

    /// alice tops up to 100e18, all staked on HK1 (100_000_000_000 rao).
    function stakeHundred() internal {
        depositDirect(alice, 90e18);
        vm.prank(keeper);
        vault.stakeIdle();
    }

    /// What `who`'s shares redeem for now.
    function assetsOf(address who) internal view returns (uint256) {
        return CascadeMath.assetsForRedeem(vault.balanceOf(who), vault.totalAssets(), vault.totalSupply());
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

    // ---- reward cut ----

    function test_cutMintsTreasuryAtPreClaimPrice() public {
        stakeHundred();
        setCut(1_000);
        staking.setUnclaimed(vault.coldkey(), HK1, 10_000_000_000);
        uint256 assetsBefore = vault.totalAssets();
        uint256 supplyBefore = vault.totalSupply();
        assertEq(assetsBefore, 100e18);
        // 10% of the 10e18 claimed, priced before the claim
        uint256 shares = CascadeMath.sharesForDeposit(1e18, assetsBefore, supplyBefore);
        uint256 t0 = block.timestamp;

        vm.expectEmit(address(vault));
        emit CascadeVault.RewardCutMinted(treasury, 1e18, shares);
        vm.expectEmit(address(vault));
        emit CascadeVault.RewardsClaimed(HK1, 10e9);
        claimAs(keeper, HK1);

        assertEq(vault.balanceOf(treasury), shares);
        assertEq(vault.totalSupply(), supplyBefore + shares);
        // the cut does not vest: 10e18 - 1e18
        assertEq(vault.vestingAmount(), 9e18);
        assertEq(vault.vestingStart(), t0);
        // 110e18 gross - 9e18 unvested: the cut counts at once, against the treasury's new shares
        assertEq(vault.totalAssets(), 101e18);
        vm.warp(t0 + 7 days);
        assertEq(vault.totalAssets(), 110e18);
    }

    function test_cutLeavesPriceUnchanged() public {
        stakeHundred();
        setCut(1_000);

        // a claim with no schedule running
        staking.setUnclaimed(vault.coldkey(), HK1, 10_000_000_000);
        uint256 before = vault.price();
        uint256 aliceBefore = assetsOf(alice);
        claimAs(keeper, HK1);
        assertGe(vault.price(), before);
        assertLe(vault.price(), before + 1);
        assertGe(assetsOf(alice), aliceBefore);

        // a claim 3 days into that schedule, paid out as liquid balance
        vm.warp(block.timestamp + 3 days);
        staking.setClaimToBalance(true);
        staking.setUnclaimed(vault.coldkey(), HK1, 3_000_000_000);
        before = vault.price();
        aliceBefore = assetsOf(alice);
        claimAs(keeper, HK1);
        assertGe(vault.price(), before);
        assertLe(vault.price(), before + 1);
        assertGe(assetsOf(alice), aliceBefore);
    }

    /// Any cut up to the maximum on any reward: the price never drops and at most rises by the
    /// rounding of the treasury's shares, alice's value never drops, and the treasury's shares are
    /// worth no more than its cut.
    function testFuzz_cutLeavesPriceUnchanged(uint256 bps, uint256 rewardRao) public {
        bps = bound(bps, 0, 2_000);
        rewardRao = bound(rewardRao, 0, 1_000_000_000_000);
        // casting to 'uint16' is safe because bps is bounded to 2_000
        // forge-lint: disable-next-line(unsafe-typecast)
        setCut(uint16(bps));
        staking.setUnclaimed(vault.coldkey(), HK1, rewardRao);
        uint256 before = vault.price();
        uint256 aliceBefore = assetsOf(alice);

        claimAs(keeper, HK1);

        assertGe(vault.price(), before);
        assertLe(vault.price(), before + 1);
        assertGe(assetsOf(alice), aliceBefore);
        assertLe(assetsOf(treasury), rewardRao * 1e9 * bps / 10_000);
    }

    function test_cutAboveMaximumReverts() public {
        vm.prank(owner);
        vm.expectRevert(CascadeVault.FeeTooHigh.selector);
        vault.setRewardCut(treasury, 2_001);

        vm.prank(owner);
        vm.expectRevert(CascadeBase.ZeroAddress.selector);
        vault.setRewardCut(address(0), 1);

        address[3] memory others = [guardian, keeper, stranger];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, others[i]));
            vault.setRewardCut(treasury, 1_000);
        }
        assertEq(vault.treasury(), address(0));
        assertEq(vault.rewardCutBps(), 0);

        // the maximum itself is allowed
        assertEq(vault.MAX_REWARD_CUT_BPS(), 2_000);
        vm.expectEmit(address(vault));
        emit CascadeVault.RewardCutSet(treasury, 2_000);
        setCut(2_000);
        assertEq(vault.treasury(), treasury);
        assertEq(vault.rewardCutBps(), 2_000);

        // a zero treasury with a zero cut turns it off
        vm.expectEmit(address(vault));
        emit CascadeVault.RewardCutSet(address(0), 0);
        vm.prank(owner);
        vault.setRewardCut(address(0), 0);
        assertEq(vault.treasury(), address(0));
        assertEq(vault.rewardCutBps(), 0);
    }

    function test_zeroCutChangesNothing() public {
        // a treasury set with a zero cut behaves as v2: the whole increase vests, nothing is minted
        setCut(0);
        staking.setUnclaimed(vault.coldkey(), HK1, 1_000_000_000);
        uint256 t0 = block.timestamp;

        vm.recordLogs();
        claimAs(keeper, HK1);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // v2's one event
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(vault));
        assertEq(logs[0].topics[0], CascadeVault.RewardsClaimed.selector);
        assertEq(logs[0].topics[1], HK1);
        assertEq(abi.decode(logs[0].data, (uint256)), 1e9);
        assertEq(vault.balanceOf(treasury), 0);
        assertEq(vault.totalSupply(), 1e25);
        assertEq(vault.vestingAmount(), 1e18);
        assertEq(vault.vestingStart(), t0);
        // 11e18 - 1e18 unvested, then all of it
        assertEq(vault.totalAssets(), 10e18);
        vm.warp(t0 + 7 days);
        assertEq(vault.totalAssets(), 11e18);
    }

    /// Review Focus 2: a claim with no shares outstanding neither divides by zero nor mints the
    /// treasury more than its cut.
    function test_claimWithNoSharesMintsOnlyTheCut() public {
        CascadeVault v = freshVault();
        vm.deal(address(v), ED);
        vm.prank(owner);
        v.setRewardCut(treasury, 1_000);
        assertEq(v.totalSupply(), 0);
        assertEq(v.totalAssets(), 0);
        staking.setUnclaimed(v.coldkey(), HK1, 1_000_000_000);

        // A = 0, S = 0: 1e17 * (0 + 1e6) / (0 + 1) = 1e23, the launch price
        vm.expectEmit(address(v));
        emit CascadeVault.RewardCutMinted(treasury, 1e17, 1e23);
        vm.prank(keeper);
        v.claimRewards{gas: 60_000_000}(HK1);

        assertEq(v.balanceOf(treasury), 1e23);
        assertEq(v.totalSupply(), 1e23);
        assertEq(v.vestingAmount(), 9e17);
        // 1e18 gross - 9e17 unvested
        assertEq(v.totalAssets(), 1e17);

        // 1e23 * (1e17 + 1) / (1e23 + 1e6) = 1e17, unstaked from HK1 and paid out
        vm.prank(treasury);
        v.redeemDirect(1e23);
        assertEq(treasury.balance, 0.1e18);
        assertEq(v.totalSupply(), 0);
    }

    function test_tinyClaimRoundsCutToZero() public {
        setCut(1_000);
        DustClaim dust = new DustClaim();
        vm.mockFunction(ISTAKING_ADDRESS, address(dust), abi.encodeCall(IStaking.claimRootWithHotkey, (HK1)));
        uint256 t0 = block.timestamp;

        vm.recordLogs();
        claimAs(keeper, HK1);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // 9 * 1_000 / 10_000 = 0: nothing minted and all 9 wei vest (RewardsClaimed floors to 0 rao)
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], CascadeVault.RewardsClaimed.selector);
        assertEq(abi.decode(logs[0].data, (uint256)), 0);
        assertEq(address(vault).balance, ED + 9);
        assertEq(vault.balanceOf(treasury), 0);
        assertEq(vault.totalSupply(), 1e25);
        assertEq(vault.vestingAmount(), 9);
        assertEq(vault.vestingStart(), t0);
    }

    /// A validator's hotkey swap moves the vault's stake to a hotkey outside the set, so the price
    /// reads a loss until the new hotkey is added. A cut minted at that price would hand the treasury
    /// most of the vault once the stake counts again, so below half the launch price (the deposit
    /// guard's line) the cut is skipped and the whole increase vests. The claim never reverts.
    function test_cutSkippedBelowHalfLaunchPrice() public {
        // 1e18 vesting from a claim before the cut is set
        claimOneTao();
        setCut(1_000);
        // the swap: all 11_000_000_000 rao move from HK1 to HK5
        vm.prank(address(vault));
        staking.moveStake(HK1, HK5, 0, 0, 11_000_000_000);
        // gross 0 against 1e18 unvested
        assertEq(vault.totalAssets(), 0);

        // totalAssets() during the claim is max(5e17 - 1e18, 0) = 0, below the 5e17 claimed
        staking.setUnclaimed(vault.coldkey(), HK1, 500_000_000);
        vm.recordLogs();
        claimAs(keeper, HK1);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], CascadeVault.RewardsClaimed.selector);
        assertEq(vault.balanceOf(treasury), 0);
        assertEq(vault.totalSupply(), 1e25);
        // 1e18 + 5e17, nothing kept back for the cut
        assertEq(vault.vestingAmount(), 1.5e18);

        // the new hotkey is added: alice's value is whole, and all of both claims vests to her
        vm.prank(keeper);
        vault.addHotkey(HK5);
        // 11.5e18 gross - 1.5e18 unvested
        assertEq(vault.totalAssets(), 10e18);
        vm.warp(block.timestamp + 7 days);
        // 1e25 * (11.5e18 + 1) / (1e25 + 1e6), floored
        assertEq(assetsOf(alice), 11.5e18 - 1);
    }
}
