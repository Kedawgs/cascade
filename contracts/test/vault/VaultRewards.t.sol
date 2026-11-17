// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeVaultLens} from "../../src/lens/CascadeVaultLens.sol";
import {ISTAKING_ADDRESS, IStaking} from "../../src/interfaces/IStaking.sol";
import {CascadeMath} from "../../src/libraries/CascadeMath.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {Schedule} from "../governance/Schedule.sol";
import {Delay, Item, Kind} from "../../src/CascadeTypes.sol";
import {
    FeeTooHigh,
    InsufficientGas,
    InvalidParameter,
    NotKeeper,
    NotScheduled,
    UnknownHotkey,
    ZeroAddress
} from "../../src/CascadeErrors.sol";
import {ClaimGasSet, LimitSet, RewardCutMinted, RewardCutSet, RewardsClaimed} from "../../src/CascadeEvents.sol";

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
    /// The treasury named with the maximum cut: a loosening (Task 11), scheduled in setUp, which then lets its
    /// 48 hours pass before alice's deposit; setCut executes it and lowers the cut at once.
    bytes maxCut;

    /// alice's 10e18 is staked on HK1 with exact stake reads: HK1 holds 10_000_000_000 rao, the vault
    /// holds only ED, and alice holds 10e18 * (0 + 1e6) / (0 + 1) = 1e25 shares.
    function setUp() public override {
        super.setUp();
        staking.setOneRaoShort(false);
        maxCut = abi.encodeCall(CascadeVault.setRewardCut, (treasury, 2_000));
        vm.prank(owner);
        vault.schedule(maxCut);
        Schedule.warpTo(vm.getBlockTimestamp() + 48 hours);
        depositDirect(alice, 10e18);
        vm.prank(keeper);
        vault.stakeIdle();
    }

    function stakeOf(bytes32 h) internal view returns (uint256) {
        return staking.getStake(h, vaultLens.coldkey(), 0);
    }

    function unclaimedOf(bytes32 h) internal view returns (uint256) {
        return staking.getUnclaimedRootTaoByHotkey(vaultLens.coldkey(), h);
    }

    function claimAs(address caller, bytes32 h) internal {
        vm.prank(caller);
        vault.claimRewards{gas: 60_000_000}(h);
    }

    /// The keeper claims 1 TAO (1_000_000_000 rao) of HK1 rewards.
    function claimOneTao() internal {
        staking.setUnclaimed(vaultLens.coldkey(), HK1, 1_000_000_000);
        claimAs(keeper, HK1);
    }

    /// The cut to the treasury becomes `bps`: setUp's scheduled maximum executed, then lowered at once (a
    /// tightening).
    function setCut(uint16 bps) internal {
        vm.startPrank(owner);
        vault.execute(maxCut);
        vault.setRewardCut(treasury, bps);
        vm.stopPrank();
    }

    /// alice tops up to 100e18, all staked on HK1 (100_000_000_000 rao).
    function stakeHundred() internal {
        depositDirect(alice, 90e18);
        vm.prank(keeper);
        vault.stakeIdle();
    }

    /// What `who`'s shares redeem for now.
    function assetsOf(address who) internal view returns (uint256) {
        return CascadeMath.assetsForRedeem(vault.balanceOf(who), vaultLens.totalAssets(), vault.totalSupply());
    }

    // ---- claims ----

    /// A delivery prices its deposits at totalAssets() before it (CascadeFormulas.totalAssets): the
    /// gross less the queued payouts and the rewards still vesting, both non-zero here.
    function test_deliveryPricesAgainstTotalAssetsLessPendingAndUnvested() public {
        // carol enters through the front door, then asks for half her shares back: a payout queued
        depositVia(carol, 20e18);
        deliver(BASE, frontDoor, ++nextBatchId, noEntries(), entries1(carol, vault.balanceOf(carol) / 2));
        assertGt(vaultLens.pendingPayouts(), 0);
        // 1 TAO of rewards claimed, a quarter of it vested
        claimOneTao();
        Schedule.warpTo(vm.getBlockTimestamp() + 1.75 days);
        assertEq(vaultLens.unvestedRewards(), 0.75e18);

        uint256 assets = vaultLens.totalAssets();
        uint256 supply = vault.totalSupply();
        assertEq(assets, vaultLens.grossAssets() - vaultLens.pendingPayouts() - 0.75e18);
        depositVia(bob, 5e18);
        assertEq(vault.balanceOf(bob), CascadeMath.sharesForDeposit(5e18, assets, supply));
    }

    function test_claimByKeeperAddsStakeAndVests() public {
        staking.setUnclaimed(vaultLens.coldkey(), HK1, 1_000_000_000);
        uint256 t0 = vm.getBlockTimestamp();

        vm.expectEmit(address(vault));
        emit RewardsClaimed(HK1, 1e9);
        claimAs(keeper, HK1);

        // 10_000_000_000 + 1_000_000_000
        assertEq(stakeOf(HK1), 11_000_000_000);
        assertEq(unclaimedOf(HK1), 0);
        assertEq(vaultLens.lastClaimAt(HK1), t0);
        assertEq(vaultLens.vestingAmount(), 1e18);
        assertEq(vaultLens.vestingStart(), t0);
        // 11_000_000_000 * 1e9 + 1e12 - 1e12
        assertEq(vaultLens.grossAssets(), 11e18);
        // 11e18 - 0 pending - 1e18 unvested
        assertEq(vaultLens.totalAssets(), 10e18);

        // half vested: 11e18 - 1e18 * 3.5 days / 7 days
        Schedule.warpTo(t0 + 3.5 days);
        assertEq(vaultLens.totalAssets(), 10.5e18);

        Schedule.warpTo(t0 + 7 days);
        assertEq(vaultLens.totalAssets(), 11e18);
    }

    function test_claimMeasuresWholePosition() public {
        // the chain pays this claim out as liquid balance instead of stake on HK1: it is still measured
        // and vested, so the price does not jump
        staking.setClaimToBalance(true);
        staking.setUnclaimed(vaultLens.coldkey(), HK1, 1_000_000_000);
        uint256 t0 = vm.getBlockTimestamp();

        vm.expectEmit(address(vault));
        emit RewardsClaimed(HK1, 1e9);
        claimAs(keeper, HK1);

        assertEq(stakeOf(HK1), 10_000_000_000);
        assertEq(address(vault).balance, ED + 1e18);
        assertEq(vaultLens.vestingAmount(), 1e18);
        assertEq(vaultLens.vestingStart(), t0);
        // (10_000_000_000 * 1e9 + ED + 1e18) - ED
        assertEq(vaultLens.grossAssets(), 11e18);
        // 11e18 - 1e18 unvested
        assertEq(vaultLens.totalAssets(), 10e18);

        Schedule.warpTo(t0 + 7 days);
        assertEq(vaultLens.totalAssets(), 11e18);
    }

    function test_claimStrangerBeforeFallbackReverts() public {
        // setUp's registry delay already put vm.getBlockTimestamp() 7 days past the deploy seed, so the keeper
        // claims first to start HK1's window.
        claimAs(keeper, HK1);
        uint256 t0 = vm.getBlockTimestamp();
        staking.setUnclaimed(vaultLens.coldkey(), HK1, 1_000_000_000);

        vm.prank(stranger);
        vm.expectRevert(NotKeeper.selector);
        vault.claimRewards{gas: 60_000_000}(HK1);

        Schedule.warpTo(t0 + 7 days - 1);
        vm.prank(stranger);
        vm.expectRevert(NotKeeper.selector);
        vault.claimRewards{gas: 60_000_000}(HK1);

        Schedule.warpTo(t0 + 7 days);
        vm.expectEmit(address(vault));
        emit RewardsClaimed(HK1, 1e9);
        claimAs(stranger, HK1);
        assertEq(stakeOf(HK1), 11_000_000_000);
        assertEq(vaultLens.lastClaimAt(HK1), t0 + 7 days);
    }

    function test_claimFallbackIsPerHotkey() public {
        // HK2 is added (and seeded) at 8 days; HK1 is claimed by the keeper 7 days later
        Schedule.warpTo(8 days);
        vm.prank(owner);
        vault.addHotkey(HK2);
        staking.setUnclaimed(vaultLens.coldkey(), HK2, 500_000_000);
        Schedule.warpTo(15 days);
        claimAs(keeper, HK1);
        assertEq(vaultLens.lastClaimAt(HK1), 15 days);

        vm.prank(stranger);
        vm.expectRevert(NotKeeper.selector);
        vault.claimRewards{gas: 60_000_000}(HK1);

        // HK2's own window, from its seed, has passed
        vm.expectEmit(address(vault));
        emit RewardsClaimed(HK2, 500_000_000);
        claimAs(stranger, HK2);
        assertEq(stakeOf(HK2), 500_000_000);
        assertEq(vaultLens.lastClaimAt(HK2), 15 days);
    }

    // ---- R6b U1: only the keeper restarts a claim schedule that still holds rewards ----

    /// The claim schedule as (amount, start, period).
    function schedule3() internal view returns (uint256, uint64, uint64) {
        return (vaultLens.vestingAmount(), vaultLens.vestingStart(), vaultLens.vestingPeriod());
    }

    /// While the claim schedule still vests, a stranger's fallback claim is refused (NotKeeper), leaving the hotkey's
    /// claim record and the schedule as they were; the keeper's claim goes through at any time; once the schedule has
    /// vested the stranger's claim goes through again, on a fresh schedule of its own amount. rewardVesting is raised to
    /// 14 days (an increase applies at once), so the fallback's 7 days come inside the schedule.
    function test_aStrangersClaimWaitsWhileTheScheduleVests() public {
        vm.prank(owner);
        vault.setRewardVesting(14 days);
        claimOneTao();
        uint256 t0 = vm.getBlockTimestamp();
        (uint256 amount, uint64 start, uint64 period) = schedule3();
        assertEq(amount, 1e18);
        assertEq(period, 14 days);

        // past the fallback, inside the schedule: refused, nothing moved
        staking.setUnclaimed(vaultLens.coldkey(), HK1, 100_000_000);
        Schedule.warpTo(t0 + 7 days);
        vm.prank(stranger);
        vm.expectRevert(NotKeeper.selector);
        vault.claimRewards{gas: 60_000_000}(HK1);
        Schedule.warpTo(t0 + 14 days - 1);
        vm.prank(stranger);
        vm.expectRevert(NotKeeper.selector);
        vault.claimRewards{gas: 60_000_000}(HK1);
        assertEq(vaultLens.lastClaimAt(HK1), t0, "the claim record unchanged");
        (uint256 a2, uint64 s2, uint64 p2) = schedule3();
        assertEq(a2, amount);
        assertEq(s2, start);
        assertEq(p2, period, "and the schedule");
        assertEq(unclaimedOf(HK1), 0.1e18, "the rewards still owed on chain");

        // the keeper is never held: a snapshot of its claim inside the schedule
        uint256 snap = vm.snapshotState();
        claimAs(keeper, HK1);
        assertEq(vaultLens.lastClaimAt(HK1), t0 + 14 days - 1);
        vm.revertToState(snap);

        // once the schedule has vested, the stranger's claim goes through, on its own amount alone
        Schedule.warpTo(t0 + 14 days);
        assertEq(vaultLens.unvestedRewards(), 0);
        vm.expectEmit(address(vault));
        emit RewardsClaimed(HK1, 100_000_000);
        claimAs(stranger, HK1);
        assertEq(vaultLens.lastClaimAt(HK1), t0 + 14 days);
        assertEq(vaultLens.vestingAmount(), 0.1e18, "a fresh schedule of its claim alone (no cut in this fixture)");
        assertEq(vaultLens.vestingStart(), t0 + 14 days);
    }

    /// The finding's scenario (ChatGPT round's multi-agent review, U1): two hotkeys, HK1 with 90% of the stake and HK2
    /// with 10%, both claimed by the keeper on day 0 at rewardVesting 30 days. On day 15 HK2's fallback is open (7 days
    /// since its claim) and its 15 days of rewards are small: before R6b a stranger's claim of HK2 alone restarted the
    /// whole schedule over 30 days from then, pushing about a quarter of the month's rewards past their end. Now it is
    /// refused NotKeeper while the schedule vests; the keeper's claim of HK2 goes through.
    function test_aStrangersSmallHotkeyClaimMidScheduleIsRefused() public {
        vm.prank(owner);
        vault.setRewardVesting(30 days);
        vm.prank(owner);
        vault.addHotkey(HK2);
        vm.prank(address(vault));
        staking.moveStake(HK1, HK2, 0, 0, 1_000_000_000);
        assertEq(stakeOf(HK1), 9_000_000_000);
        assertEq(stakeOf(HK2), 1_000_000_000);

        // day 0: the keeper claims both
        staking.setUnclaimed(vaultLens.coldkey(), HK1, 900_000_000);
        staking.setUnclaimed(vaultLens.coldkey(), HK2, 100_000_000);
        claimAs(keeper, HK1);
        claimAs(keeper, HK2);
        uint256 t0 = vm.getBlockTimestamp();
        (uint256 amount, uint64 start, uint64 period) = schedule3();
        assertEq(period, 30 days);

        // day 15: HK2's fallback is open, its rewards small
        Schedule.warpTo(t0 + 15 days);
        staking.setUnclaimed(vaultLens.coldkey(), HK2, 50_000_000);
        vm.prank(stranger);
        vm.expectRevert(NotKeeper.selector);
        vault.claimRewards{gas: 60_000_000}(HK2);
        (uint256 a2, uint64 s2, uint64 p2) = schedule3();
        assertEq(a2, amount, "the schedule not re-spread");
        assertEq(s2, start);
        assertEq(p2, period);
        assertEq(vaultLens.lastClaimAt(HK2), t0);

        // the keeper's claim of HK2 goes through
        vm.expectEmit(address(vault));
        emit RewardsClaimed(HK2, 50_000_000);
        claimAs(keeper, HK2);
        assertEq(vaultLens.lastClaimAt(HK2), t0 + 15 days);
    }

    function test_claimFallbackSeededAtDeploy() public {
        uint256 t0 = vm.getBlockTimestamp();
        CascadeVault v = freshVault();
        CascadeVaultLens vLens = new CascadeVaultLens(address(v));

        // the constructor hotkey's window starts at deploy
        vm.prank(stranger);
        vm.expectRevert(NotKeeper.selector);
        v.claimRewards{gas: 60_000_000}(HK1);
        Schedule.warpTo(t0 + 7 days - 1);
        vm.prank(stranger);
        vm.expectRevert(NotKeeper.selector);
        v.claimRewards{gas: 60_000_000}(HK1);
        assertEq(vLens.lastClaimAt(HK1), t0);

        Schedule.warpTo(t0 + 7 days);
        vm.expectEmit(address(v));
        emit RewardsClaimed(HK1, 0);
        vm.prank(stranger);
        v.claimRewards{gas: 60_000_000}(HK1);
        assertEq(vLens.lastClaimAt(HK1), t0 + 7 days);
    }

    function test_claimFallbackSeededWhenHotkeyAdded() public {
        uint256 t0 = vm.getBlockTimestamp();
        // setStakeHotkey(HK3) is a scheduled item (Task 11): scheduled now, run on day 2 below
        bytes memory toHk3 = abi.encodeCall(CascadeVault.setStakeHotkey, (HK3));
        vm.prank(owner);
        vault.schedule(toHk3);
        vm.prank(keeper);
        vault.addHotkey(HK2);
        staking.setUnclaimed(vaultLens.coldkey(), HK2, 500_000_000);

        // added 1 day ago: still the keeper's
        Schedule.warpTo(t0 + 1 days);
        vm.prank(stranger);
        vm.expectRevert(NotKeeper.selector);
        vault.claimRewards{gas: 60_000_000}(HK2);
        assertEq(vaultLens.lastClaimAt(HK2), t0);

        // the owner's listing seeds HK3 the same way; its scheduled setStakeHotkey then runs, listing nothing
        // (Task 14a) and leaving the record as it was
        Schedule.warpTo(t0 + 2 days);
        vm.startPrank(owner);
        vault.addHotkey(HK3);
        vault.execute(toHk3);
        vm.stopPrank();
        assertEq(vaultLens.lastClaimAt(HK3), t0 + 2 days);
        vm.prank(stranger);
        vm.expectRevert(NotKeeper.selector);
        vault.claimRewards{gas: 60_000_000}(HK3);

        Schedule.warpTo(t0 + 7 days);
        vm.expectEmit(address(vault));
        emit RewardsClaimed(HK2, 500_000_000);
        claimAs(stranger, HK2);
        assertEq(vaultLens.lastClaimAt(HK2), t0 + 7 days);

        // only an unset timestamp is seeded: a removed and re-added hotkey keeps its last claim
        vm.prank(owner);
        vault.removeHotkey(HK2, false);
        Schedule.warpTo(t0 + 20 days);
        vm.prank(owner);
        vault.addHotkey(HK2);
        assertEq(vaultLens.lastClaimAt(HK2), t0 + 7 days);
    }

    function test_claimInsufficientGasRevertsBeforeCall() public {
        staking.setUnclaimed(vaultLens.coldkey(), HK1, 1_000_000_000);

        vm.prank(keeper);
        vm.expectRevert(InsufficientGas.selector);
        vault.claimRewards{gas: 50_000_000}(HK1);

        assertEq(unclaimedOf(HK1), 1e18);
        assertEq(stakeOf(HK1), 10_000_000_000);
        assertEq(vaultLens.lastClaimAt(HK1), deployedAt);
    }

    function test_claimGasBurningFailureLeavesStateUntouched() public {
        staking.setUnclaimed(vaultLens.coldkey(), HK1, 1_000_000_000);
        staking.setClaimTooHeavy(true);

        vm.prank(keeper);
        (bool ok,) = address(vault).call{gas: 60_000_000}(abi.encodeCall(vault.claimRewards, (HK1)));

        assertFalse(ok);
        assertEq(unclaimedOf(HK1), 1e18);
        assertEq(stakeOf(HK1), 10_000_000_000);
        assertEq(vaultLens.lastClaimAt(HK1), deployedAt);
        assertEq(vaultLens.vestingAmount(), 0);
        assertEq(vaultLens.vestingStart(), 0);
    }

    function test_claimZeroDeltaSucceeds() public {
        // a 1 TAO claim at t0 starts a schedule that a later empty claim must not restart
        claimOneTao();
        uint256 t0 = vm.getBlockTimestamp();
        Schedule.warpTo(t0 + 3.5 days);
        // 11e18 - 1e18 * 3.5 days / 7 days
        assertEq(vaultLens.totalAssets(), 10.5e18);

        vm.expectEmit(address(vault));
        emit RewardsClaimed(HK1, 0);
        claimAs(keeper, HK1);

        assertEq(vaultLens.lastClaimAt(HK1), t0 + 3.5 days);
        assertEq(vaultLens.vestingAmount(), 1e18);
        assertEq(vaultLens.vestingStart(), t0);
        assertEq(stakeOf(HK1), 11_000_000_000);
        // still half vested; restarting would have re-spread 0.5e18 over 7 days (11e18 - 0.5e18)
        assertEq(vaultLens.totalAssets(), 10.5e18);
    }

    function test_claimUnknownHotkeyReverts() public {
        vm.prank(keeper);
        vm.expectRevert(UnknownHotkey.selector);
        vault.claimRewards{gas: 60_000_000}(HK2);
    }

    function test_claimWorksWhilePaused() public {
        vm.prank(guardian);
        vault.pause();

        claimOneTao();

        assertEq(stakeOf(HK1), 11_000_000_000);
        assertEq(vaultLens.vestingAmount(), 1e18);
        assertEq(vaultLens.lastClaimAt(HK1), vm.getBlockTimestamp());
    }

    function test_setClaimGasRequiredEmits() public {
        vm.expectEmit(address(vault));
        emit ClaimGasSet(60_000_000);
        vm.prank(owner);
        vault.setClaimGasRequired(60_000_000);
        assertEq(vaultLens.claimGasRequired(), 60_000_000);

        vm.prank(keeper);
        vm.expectRevert(InsufficientGas.selector);
        vault.claimRewards{gas: 59_000_000}(HK1);
    }

    // ---- vesting ----

    function test_vestingCurveIsLinear() public {
        claimOneTao();
        uint256 t0 = vm.getBlockTimestamp();
        assertEq(vaultLens.unvestedRewards(), 1e18);

        // 1e18 * 6 days / 7 days
        Schedule.warpTo(t0 + 1 days);
        assertEq(vaultLens.unvestedRewards(), 857142857142857142);

        Schedule.warpTo(t0 + 7 days);
        assertEq(vaultLens.unvestedRewards(), 0);
    }

    function test_secondClaimRestartsWithRemainder() public {
        claimOneTao();
        uint256 t1 = vm.getBlockTimestamp() + 3.5 days;

        // 1e18 * 3.5 days / 7 days
        Schedule.warpTo(t1);
        assertEq(vaultLens.unvestedRewards(), 5e17);

        claimOneTao();
        // 5e17 still unvested + 1e18 claimed
        assertEq(vaultLens.vestingAmount(), 1.5e18);
        assertEq(vaultLens.vestingStart(), t1);
        assertEq(vaultLens.unvestedRewards(), 1.5e18);
        // 10_000_000_000 + 2 * 1_000_000_000
        assertEq(stakeOf(HK1), 12_000_000_000);

        Schedule.warpTo(t1 + 7 days);
        assertEq(vaultLens.unvestedRewards(), 0);
    }

    // ---- the vesting period: rewardVesting, owner-set, snapshotted per restart (Task 15) ----

    /// The period is 1 to 30 days (spec §3.6, Appendix B): longer than 30 days is refused at once (InvalidParameter;
    /// an increase is immediate), shorter than a day by the setter at execute (a decrease is a loosening, so
    /// NotScheduled directly), the item kept. Each bound itself is taken.
    function test_vestingBounds() public {
        assertEq(vaultLens.rewardVesting(), 7 days, "the fixture's: Appendix B's 7 days");
        vm.prank(owner);
        vm.expectRevert(InvalidParameter.selector);
        vault.setRewardVesting(30 days + 1);

        bytes memory tooShort = abi.encodeCall(CascadeVault.setRewardVesting, (1 days - 1));
        vm.prank(owner);
        vm.expectRevert(NotScheduled.selector);
        vault.setRewardVesting(1 days - 1);
        vm.prank(owner);
        bytes32 id = vault.schedule(tooShort);
        Schedule.wait(48 hours);
        vm.prank(owner);
        vm.expectRevert(InvalidParameter.selector);
        vault.execute(tooShort);
        assertGt(vaultLens.scheduled(id).readyAt, 0, "the item is kept");
        assertEq(vaultLens.rewardVesting(), 7 days);

        vm.prank(owner);
        vault.setRewardVesting(30 days);
        assertEq(vaultLens.rewardVesting(), 30 days, "the upper bound");
        Schedule.run(vault, owner, abi.encodeCall(CascadeVault.setRewardVesting, (1 days)));
        assertEq(vaultLens.rewardVesting(), 1 days, "the lower bound");
    }

    /// An increase (rewards reach the price more slowly) applies at once, as does an equal value, each logging
    /// LimitSet under the setter's selector. A decrease is a loosening: NotScheduled directly, a Param item (48
    /// hours, Ordinary) that executes no sooner and that the guardian may cancel. Only the owner sets it.
    function test_increaseImmediateDecreaseScheduled() public {
        vm.expectEmit(address(vault));
        emit LimitSet(CascadeVault.setRewardVesting.selector, 14 days, 0);
        vm.prank(owner);
        vault.setRewardVesting(14 days);
        assertEq(vaultLens.rewardVesting(), 14 days, "up: at once");
        vm.prank(owner);
        vault.setRewardVesting(14 days);
        assertEq(vaultLens.rewardVesting(), 14 days, "an equal value: at once");

        vm.prank(owner);
        vm.expectRevert(NotScheduled.selector);
        vault.setRewardVesting(14 days - 1);
        address[3] memory others = [guardian, keeper, stranger];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, others[i]));
            vault.setRewardVesting(30 days);
        }
        assertEq(vaultLens.rewardVesting(), 14 days);

        // down: a Param item, Ordinary, the guardian's to cancel
        bytes memory down = abi.encodeCall(CascadeVault.setRewardVesting, (3 days));
        vm.prank(owner);
        bytes32 id = vault.schedule(down);
        Item memory it = vaultLens.scheduled(id);
        assertEq(uint8(it.class), uint8(Delay.Param), "the Param class");
        assertEq(uint8(it.kind), uint8(Kind.Ordinary), "Ordinary");
        assertEq(it.readyAt, vm.getBlockTimestamp() + 48 hours);
        vm.prank(guardian);
        vault.cancel(id);
        assertEq(vaultLens.scheduled(id).readyAt, 0, "cancelled");

        // scheduled again, it runs at 48 hours (Schedule.run checks it is not ready a second before)
        vm.recordLogs();
        Schedule.run(vault, owner, down);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // Scheduled, then the setter's LimitSet and Executed
        assertEq(logs.length, 3);
        assertEq(logs[1].topics[0], LimitSet.selector);
        assertEq(logs[1].topics[1], bytes32(CascadeVault.setRewardVesting.selector));
        assertEq(logs[1].data, abi.encode(uint256(3 days), uint256(0)));
        assertEq(vaultLens.rewardVesting(), 3 days, "down: at execute");
    }

    /// A change of the period moves neither the price nor the schedule in flight, up (at once) or down (at its
    /// execute): the running schedule keeps the period it was snapshotted with (vestingPeriod), so the unvested
    /// rewards and the price read the same before and after the change, and the schedule ends where it would have.
    /// (Ruling A5: the price is the lens's price(), totalAssets() over totalSupply().) The vault's own reading too: a
    /// direct deposit right after each change mints exactly what the assets before the change price it at.
    function test_changeMovesNeitherPriceNorTheScheduleInFlight() public {
        claimOneTao();
        uint256 t0 = vm.getBlockTimestamp();
        assertEq(vaultLens.vestingPeriod(), 7 days, "the claim snapshots the period in force");
        Schedule.warpTo(t0 + 2 days);
        uint256 price = vaultLens.price();
        uint256 unvested = vaultLens.unvestedRewards();
        // 1e18 * 5 days / 7 days
        assertEq(unvested, 714_285_714_285_714_285);
        assertEq(price, CascadeMath.price(vaultLens.totalAssets(), vault.totalSupply()));

        // up, at once
        uint256 assets = vaultLens.totalAssets();
        uint256 supply = vault.totalSupply();
        vm.prank(owner);
        vault.setRewardVesting(30 days);
        assertEq(vaultLens.unvestedRewards(), unvested, "up: the schedule in flight is unchanged");
        assertEq(vaultLens.price(), price, "up: the price is unchanged");
        depositDirect(bob, 1e18);
        assertEq(vault.balanceOf(bob), CascadeMath.sharesForDeposit(1e18, assets, supply), "up: the vault's price");
        price = vaultLens.price();
        assertEq(vaultLens.vestingPeriod(), 7 days);
        assertEq(vaultLens.vestingAmount(), 1e18);
        assertEq(vaultLens.vestingStart(), t0);

        // down, scheduled now and executed 48 hours later
        bytes memory down = abi.encodeCall(CascadeVault.setRewardVesting, (1 days));
        vm.prank(owner);
        vault.schedule(down);
        Schedule.warpTo(t0 + 4 days);
        price = vaultLens.price();
        unvested = vaultLens.unvestedRewards();
        // 1e18 * 3 days / 7 days
        assertEq(unvested, 428_571_428_571_428_571);
        assets = vaultLens.totalAssets();
        supply = vault.totalSupply();
        vm.prank(owner);
        vault.execute(down);
        assertEq(vaultLens.rewardVesting(), 1 days);
        assertEq(vaultLens.unvestedRewards(), unvested, "down: the schedule in flight is unchanged");
        assertEq(vaultLens.price(), price, "down: the price is unchanged");
        depositDirect(carol, 1e18);
        assertEq(vault.balanceOf(carol), CascadeMath.sharesForDeposit(1e18, assets, supply), "down: the vault's price");
        assertEq(vaultLens.vestingPeriod(), 7 days);

        // and it runs to its own end, 7 days from the claim
        Schedule.warpTo(t0 + 6 days);
        assertEq(vaultLens.unvestedRewards(), 142_857_142_857_142_857);
        Schedule.warpTo(t0 + 7 days - 1);
        assertGt(vaultLens.unvestedRewards(), 0);
        Schedule.warpTo(t0 + 7 days);
        assertEq(vaultLens.unvestedRewards(), 0);
    }

    /// The next claim that restarts the schedule snapshots the period in force: what is still unvested, under the
    /// old period, plus the claim, re-spread over the new one from the claim (here the longer: 14 days against the
    /// 3.5 left). An empty claim restarts nothing and snapshots nothing. A decrease, once executed, applies the same
    /// way to a schedule with nothing left (with something left, the restart keeps at least its end:
    /// test_aDecreaseNeverSpeedsACarriedRemainder).
    function test_nextClaimUsesTheNewPeriod() public {
        claimOneTao();
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(owner);
        vault.setRewardVesting(14 days);
        assertEq(vaultLens.vestingPeriod(), 7 days);

        // an empty claim leaves the schedule and its period
        Schedule.warpTo(t0 + 1 days);
        claimAs(keeper, HK1);
        assertEq(vaultLens.vestingPeriod(), 7 days, "an empty claim snapshots nothing");
        assertEq(vaultLens.vestingStart(), t0);

        // 3.5 days in, half of the first claim is left (under its 7 days); the second claim adds 1 TAO
        uint256 t1 = t0 + 3.5 days;
        Schedule.warpTo(t1);
        assertEq(vaultLens.unvestedRewards(), 0.5e18);
        claimOneTao();
        assertEq(vaultLens.vestingPeriod(), 14 days, "the claim snapshots the new period");
        assertEq(vaultLens.vestingAmount(), 1.5e18);
        assertEq(vaultLens.vestingStart(), t1);
        assertEq(vaultLens.unvestedRewards(), 1.5e18);
        // 1.5e18 * 7 days / 14 days
        Schedule.warpTo(t1 + 7 days);
        assertEq(vaultLens.unvestedRewards(), 0.75e18);
        Schedule.warpTo(t1 + 14 days - 1);
        assertGt(vaultLens.unvestedRewards(), 0);
        Schedule.warpTo(t1 + 14 days);
        assertEq(vaultLens.unvestedRewards(), 0);

        // a decrease to 1 day, executed, and the next claim vests over it
        Schedule.run(vault, owner, abi.encodeCall(CascadeVault.setRewardVesting, (1 days)));
        assertEq(vaultLens.vestingPeriod(), 14 days, "the executed decrease snapshots nothing");
        claimOneTao();
        uint256 t2 = vm.getBlockTimestamp();
        assertEq(vaultLens.vestingPeriod(), 1 days);
        Schedule.warpTo(t2 + 12 hours);
        assertEq(vaultLens.unvestedRewards(), 0.5e18);
        Schedule.warpTo(t2 + 1 days);
        assertEq(vaultLens.unvestedRewards(), 0);
    }

    /// The keeper claims `rao` of HK1's rewards.
    function claimRao(uint256 rao) internal {
        staking.setUnclaimed(vaultLens.coldkey(), HK1, rao);
        claimAs(keeper, HK1);
    }

    /// The review's probe (Task 15 follow-up, I1): 3 TAO vests over 30 days; 2 days in, the period is cut to 1 day
    /// (its 48 hours elapsed), bob deposits 10 TAO and a 0.01 TAO claim restarts the schedule. Before the fix the
    /// restart re-spread the whole carried 2.8 TAO over 1 day, and bob, in for a day, took about 30 times what he
    /// would have without the decrease. Now the restart keeps what was left of the old schedule (28 days, to the
    /// same end), so bob's one-day gain stays within a few percent of the no-decrease case.
    function test_aDecreaseNeverSpeedsACarriedRemainder() public {
        vm.prank(owner);
        vault.setRewardVesting(30 days);
        claimRao(3_000_000_000);
        uint256 t0 = vm.getBlockTimestamp();
        uint256 snap = vm.snapshotState();

        // with the decrease, executed at t0 + 2 days
        Schedule.run(vault, owner, abi.encodeCall(CascadeVault.setRewardVesting, (1 days)));
        uint256 t1 = vm.getBlockTimestamp();
        assertEq(t1, t0 + 2 days);
        (uint256 gainCut, uint256 unvestedCut) = bobsDay();
        // the restart carried 3e18 * 28 / 30 plus the 1e16 claimed, to the old end
        assertEq(vaultLens.vestingPeriod(), 28 days, "the old schedule's 28 days left, not the new 1 day");
        assertEq(vaultLens.vestingStart(), t1);
        assertEq(vaultLens.vestingAmount(), 2.8e18 + 1e16);
        assertEq(unvestedCut, uint256(2.81e18) * 27 / 28, "a day of 28 has vested");

        // without it
        vm.revertToState(snap);
        Schedule.wait(2 days);
        (uint256 gainKept,) = bobsDay();
        assertEq(vaultLens.vestingPeriod(), 30 days);

        assertGe(gainCut, gainKept);
        // (2.81e18 / 28 days) against (2.81e18 / 30 days): 30/28 of it, about 7% more; before the fix about 30x
        assertLe(gainCut, gainKept * 108 / 100, "the remainder was released faster than its own schedule");
    }

    /// bob deposits 10 TAO now, a 0.01 TAO claim restarts the schedule, and a day passes: what bob's shares gained
    /// over the day, and what is still unvested at its end.
    function bobsDay() internal returns (uint256 gain, uint256 unvested) {
        depositDirect(bob, 10e18);
        claimRao(10_000_000);
        uint256 t = vm.getBlockTimestamp();
        uint256 before = assetsOf(bob);
        Schedule.warpTo(t + 1 days);
        gain = assetsOf(bob) - before;
        unvested = vaultLens.unvestedRewards();
        Schedule.warpTo(t);
    }

    /// An increase still applies the new, longer period at the next restart: a 7-day schedule a day in (6 days
    /// left) restarts over 20 days, the remainder with it.
    function test_anIncreaseAppliesTheLongerPeriodAtTheNextRestart() public {
        claimOneTao();
        uint256 t0 = vm.getBlockTimestamp();
        Schedule.warpTo(t0 + 1 days);
        vm.prank(owner);
        vault.setRewardVesting(20 days);
        claimOneTao();
        assertEq(vaultLens.vestingPeriod(), 20 days);
        assertEq(vaultLens.vestingStart(), t0 + 1 days);
        // 1e18 * 6 / 7 carried, plus 1e18
        assertEq(vaultLens.vestingAmount(), 857_142_857_142_857_142 + 1e18);
        Schedule.warpTo(t0 + 1 days + 10 days);
        assertEq(vaultLens.unvestedRewards(), (857_142_857_142_857_142 + 1e18) / 2);
        Schedule.warpTo(t0 + 21 days);
        assertEq(vaultLens.unvestedRewards(), 0);
    }

    /// A fresh schedule, with nothing left of the old one, takes the period in force: the first claim ever (no
    /// schedule before it) takes rewardVesting. After a decrease to 2 days, executed with 1.5 days of a 30-day
    /// schedule left, the period in force is the longer and applies; once that has run out, a claim takes it too.
    function test_aFreshScheduleTakesThePeriodInForce() public {
        assertEq(vaultLens.vestingPeriod(), 0, "no schedule yet");
        vm.prank(owner);
        vault.setRewardVesting(30 days);
        claimOneTao();
        uint256 t0 = vm.getBlockTimestamp();
        assertEq(vaultLens.vestingPeriod(), 30 days, "the first claim takes rewardVesting");

        // a decrease, executed with 1.5 days of the old schedule left: the next restart takes the 2 days
        bytes memory down = abi.encodeCall(CascadeVault.setRewardVesting, (2 days));
        Schedule.warpTo(t0 + 26.5 days);
        Schedule.run(vault, owner, down);
        assertEq(vm.getBlockTimestamp(), t0 + 28.5 days);
        claimOneTao();
        assertEq(vaultLens.vestingPeriod(), 2 days, "the period in force, longer than the 1.5 days left");

        // run out, then a claim: nothing left, the period in force
        Schedule.warpTo(t0 + 40 days);
        assertEq(vaultLens.unvestedRewards(), 0);
        claimOneTao();
        assertEq(vaultLens.vestingPeriod(), 2 days);
        assertEq(vaultLens.vestingStart(), t0 + 40 days);
    }

    function test_sandwichAroundClaimYieldsNothing() public {
        staking.setUnclaimed(vaultLens.coldkey(), HK1, 1_000_000_000);

        // assetsBefore 10e18, supply 1e25: 1e19 * (1e25 + 1e6) / (1e19 + 1) = 1e25
        depositDirect(bob, 10e18);
        assertEq(vault.balanceOf(bob), 1e25);

        claimAs(keeper, HK1);
        // gross 11e18 staked + 10e18 idle = 21e18, minus 1e18 unvested
        assertEq(vaultLens.totalAssets(), 20e18);

        // 1e25 * (2e19 + 1) / (2e25 + 1e6) = 1e19
        vm.prank(bob);
        vault.redeemDirect(1e25, false);
        assertEq(bob.balance, 10e18);
        assertEq(vault.balanceOf(bob), 0);
    }

    // ---- reward cut ----

    function test_cutMintsTreasuryAtPreClaimPrice() public {
        stakeHundred();
        setCut(1_000);
        staking.setUnclaimed(vaultLens.coldkey(), HK1, 10_000_000_000);
        uint256 assetsBefore = vaultLens.totalAssets();
        uint256 supplyBefore = vault.totalSupply();
        assertEq(assetsBefore, 100e18);
        // 10% of the 10e18 claimed, priced before the claim
        uint256 shares = CascadeMath.sharesForDeposit(1e18, assetsBefore, supplyBefore);
        uint256 t0 = vm.getBlockTimestamp();

        vm.expectEmit(address(vault));
        emit RewardCutMinted(treasury, 1e18, shares);
        vm.expectEmit(address(vault));
        emit RewardsClaimed(HK1, 10e9);
        claimAs(keeper, HK1);

        assertEq(vault.balanceOf(treasury), shares);
        assertEq(vault.totalSupply(), supplyBefore + shares);
        // the cut does not vest: 10e18 - 1e18
        assertEq(vaultLens.vestingAmount(), 9e18);
        assertEq(vaultLens.vestingStart(), t0);
        // 110e18 gross - 9e18 unvested: the cut counts at once, against the treasury's new shares
        assertEq(vaultLens.totalAssets(), 101e18);
        Schedule.warpTo(t0 + 7 days);
        assertEq(vaultLens.totalAssets(), 110e18);
    }

    function test_cutLeavesPriceUnchanged() public {
        stakeHundred();
        setCut(1_000);

        // a claim with no schedule running
        staking.setUnclaimed(vaultLens.coldkey(), HK1, 10_000_000_000);
        uint256 before = vaultLens.price();
        uint256 aliceBefore = assetsOf(alice);
        claimAs(keeper, HK1);
        assertGe(vaultLens.price(), before);
        assertLe(vaultLens.price(), before + 1);
        assertGe(assetsOf(alice), aliceBefore);

        // a claim 3 days into that schedule, paid out as liquid balance
        Schedule.warpTo(vm.getBlockTimestamp() + 3 days);
        staking.setClaimToBalance(true);
        staking.setUnclaimed(vaultLens.coldkey(), HK1, 3_000_000_000);
        before = vaultLens.price();
        aliceBefore = assetsOf(alice);
        claimAs(keeper, HK1);
        assertGe(vaultLens.price(), before);
        assertLe(vaultLens.price(), before + 1);
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
        staking.setUnclaimed(vaultLens.coldkey(), HK1, rewardRao);
        uint256 before = vaultLens.price();
        uint256 aliceBefore = assetsOf(alice);

        claimAs(keeper, HK1);

        assertGe(vaultLens.price(), before);
        assertLe(vaultLens.price(), before + 1);
        assertGe(assetsOf(alice), aliceBefore);
        assertLe(assetsOf(treasury), rewardRao * 1e9 * bps / 10_000);
    }

    /// Naming the treasury or raising the cut is a loosening (Task 11): refused directly; scheduled, the setter
    /// refuses a cut past the maximum, or a cut with no treasury, at execute (the item kept).
    function test_cutAboveMaximumReverts() public {
        bytes memory tooHigh = abi.encodeCall(CascadeVault.setRewardCut, (treasury, 2_001));
        bytes memory noTreasury = abi.encodeCall(CascadeVault.setRewardCut, (address(0), 1));
        vm.startPrank(owner);
        vm.expectRevert(NotScheduled.selector);
        vault.setRewardCut(treasury, 2_001);
        vm.expectRevert(NotScheduled.selector);
        vault.setRewardCut(address(0), 1);
        vault.schedule(tooHigh);
        vault.schedule(noTreasury);
        Schedule.warpTo(vm.getBlockTimestamp() + 48 hours);
        vm.expectRevert(FeeTooHigh.selector);
        vault.execute(tooHigh);
        vm.expectRevert(ZeroAddress.selector);
        vault.execute(noTreasury);
        vm.stopPrank();

        address[3] memory others = [guardian, keeper, stranger];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, others[i]));
            vault.setRewardCut(treasury, 1_000);
        }
        assertEq(vaultLens.treasury(), address(0));
        assertEq(vaultLens.rewardCutBps(), 0);

        // the maximum itself is allowed
        assertEq(vaultLens.MAX_REWARD_CUT_BPS(), 2_000);
        vm.expectEmit(address(vault));
        emit RewardCutSet(treasury, 2_000);
        setCut(2_000);
        assertEq(vaultLens.treasury(), treasury);
        assertEq(vaultLens.rewardCutBps(), 2_000);

        // a zero treasury with a zero cut turns it off: a change of treasury, so scheduled too
        vm.recordLogs();
        Schedule.run(vault, owner, abi.encodeCall(CascadeVault.setRewardCut, (address(0), 0)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // Scheduled, then the setter's RewardCutSet and Executed
        assertEq(logs.length, 3);
        assertEq(logs[1].topics[0], RewardCutSet.selector);
        assertEq(logs[1].data, abi.encode(address(0), uint16(0)));
        assertEq(vaultLens.treasury(), address(0));
        assertEq(vaultLens.rewardCutBps(), 0);
    }

    function test_zeroCutChangesNothing() public {
        // a treasury set with a zero cut behaves as v2: the whole increase vests, nothing is minted
        setCut(0);
        staking.setUnclaimed(vaultLens.coldkey(), HK1, 1_000_000_000);
        uint256 t0 = vm.getBlockTimestamp();

        vm.recordLogs();
        claimAs(keeper, HK1);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // v2's one event
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(vault));
        assertEq(logs[0].topics[0], RewardsClaimed.selector);
        assertEq(logs[0].topics[1], HK1);
        assertEq(abi.decode(logs[0].data, (uint256)), 1e9);
        assertEq(vault.balanceOf(treasury), 0);
        assertEq(vault.totalSupply(), 1e25);
        assertEq(vaultLens.vestingAmount(), 1e18);
        assertEq(vaultLens.vestingStart(), t0);
        // 11e18 - 1e18 unvested, then all of it
        assertEq(vaultLens.totalAssets(), 10e18);
        Schedule.warpTo(t0 + 7 days);
        assertEq(vaultLens.totalAssets(), 11e18);
    }

    /// Review Focus 2: a claim with no shares outstanding neither divides by zero nor mints the
    /// treasury more than its cut.
    function test_claimWithNoSharesMintsOnlyTheCut() public {
        CascadeVault v = freshVault();
        CascadeVaultLens vLens = new CascadeVaultLens(address(v));
        vm.deal(address(v), ED);
        // naming the treasury and raising the cut: a scheduled item (Task 11), before anything else
        Schedule.run(v, owner, abi.encodeCall(CascadeVault.setRewardCut, (treasury, 1_000)));
        assertEq(v.totalSupply(), 0);
        assertEq(vLens.totalAssets(), 0);
        staking.setUnclaimed(vLens.coldkey(), HK1, 1_000_000_000);

        // A = 0, S = 0: 1e17 * (0 + 1e6) / (0 + 1) = 1e23, the launch price
        vm.expectEmit(address(v));
        emit RewardCutMinted(treasury, 1e17, 1e23);
        vm.prank(keeper);
        v.claimRewards{gas: 60_000_000}(HK1);

        assertEq(v.balanceOf(treasury), 1e23);
        assertEq(v.totalSupply(), 1e23);
        assertEq(vLens.vestingAmount(), 9e17);
        // 1e18 gross - 9e17 unvested
        assertEq(vLens.totalAssets(), 1e17);

        // 1e23 * (1e17 + 1) / (1e23 + 1e6) = 1e17, unstaked from HK1 and paid out
        vm.prank(treasury);
        v.redeemDirect(1e23, false);
        assertEq(treasury.balance, 0.1e18);
        assertEq(v.totalSupply(), 0);
    }

    function test_tinyClaimRoundsCutToZero() public {
        setCut(1_000);
        DustClaim dust = new DustClaim();
        vm.mockFunction(ISTAKING_ADDRESS, address(dust), abi.encodeCall(IStaking.claimRootWithHotkey, (HK1)));
        uint256 t0 = vm.getBlockTimestamp();

        vm.recordLogs();
        claimAs(keeper, HK1);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // 9 * 1_000 / 10_000 = 0: nothing minted and all 9 wei vest (RewardsClaimed floors to 0 rao)
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], RewardsClaimed.selector);
        assertEq(abi.decode(logs[0].data, (uint256)), 0);
        assertEq(address(vault).balance, ED + 9);
        assertEq(vault.balanceOf(treasury), 0);
        assertEq(vault.totalSupply(), 1e25);
        assertEq(vaultLens.vestingAmount(), 9);
        assertEq(vaultLens.vestingStart(), t0);
    }

    /// A validator's hotkey swap moves the vault's stake to a hotkey outside the set, so the price
    /// reads a loss until the new hotkey is added. A cut minted at that price would hand the treasury
    /// most of the vault once the stake counts again, so while stake is missing (Task 13, I-1; here the
    /// price is also below half the launch price, test_cutSkippedBelowHalfLaunchPrice's line) the cut is
    /// skipped and the whole increase vests. The claim never reverts.
    function test_cutSkippedWhileASwapHidesTheStake() public {
        // 1e18 vesting from a claim before the cut is set
        claimOneTao();
        setCut(1_000);
        // the swap: all 11_000_000_000 rao move from HK1 to HK5
        vm.prank(address(vault));
        staking.moveStake(HK1, HK5, 0, 0, 11_000_000_000);
        // gross 0 against 1e18 unvested
        assertEq(vaultLens.totalAssets(), 0);

        // totalAssets() during the claim is max(5e17 - 1e18, 0) = 0, below the 5e17 claimed
        staking.setUnclaimed(vaultLens.coldkey(), HK1, 500_000_000);
        vm.recordLogs();
        claimAs(keeper, HK1);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], RewardsClaimed.selector);
        assertEq(vault.balanceOf(treasury), 0);
        assertEq(vault.totalSupply(), 1e25);
        // 1e18 + 5e17, nothing kept back for the cut
        assertEq(vaultLens.vestingAmount(), 1.5e18);

        // the new hotkey is added: alice's value is whole, and all of both claims vests to her
        vm.prank(keeper);
        vault.addHotkey(HK5);
        // 11.5e18 gross - 1.5e18 unvested
        assertEq(vaultLens.totalAssets(), 10e18);
        Schedule.warpTo(vm.getBlockTimestamp() + 7 days);
        // 1e25 * (11.5e18 + 1) / (1e25 + 1e6), floored
        assertEq(assetsOf(alice), 11.5e18 - 1);
    }

    /// Below half the launch price (the deposit guard's line) with no stake missing and nothing underwater, the cut
    /// is skipped too: a loss the ledger has taken (here 8 of alice's 10 TAO, lost and written off by the owner's
    /// scheduled writeOffMissingStake) leaves 2e18 against 1e25 shares, and a cut minted there could take most of the
    /// vault were the loss ever repaid. The whole increase vests.
    function test_cutSkippedBelowHalfLaunchPrice() public {
        setCut(1_000);
        staking.loseStake(HK1, vaultLens.coldkey(), 8_000_000_000);
        Schedule.run(vault, owner, abi.encodeCall(vault.writeOffMissingStake, (8_000_000_000)));
        assertFalse(vaultLens.stakeMissing(), "written off");
        // below half the launch price (5e18 for 1e25 shares); nothing vests or is queued, so not underwater
        assertEq(vaultLens.totalAssets(), 2e18);

        staking.setUnclaimed(vaultLens.coldkey(), HK1, 500_000_000);
        vm.recordLogs();
        claimAs(keeper, HK1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertFalse(vaultLens.stakeMissing(), "the claim's 0.5 TAO is booked and visible: nothing missing");
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], RewardsClaimed.selector);
        assertEq(vault.balanceOf(treasury), 0);
        assertEq(vaultLens.vestingAmount(), 0.5e18, "nothing kept back for the cut");
    }
}
