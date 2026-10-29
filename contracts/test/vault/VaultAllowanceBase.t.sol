// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {VaultTestBase} from "../VaultTestBase.sol";

/// The front-door allowance base (min(root stake, booked stake) less what is still ramping in) against
/// attempts to deflate it: a stake gift taken back out, capital cycled through the keeper's stake loop, a
/// claim paid as balance. Ported from the pre-audit review's proofs of concept.
contract VaultAllowanceBaseTest is VaultTestBase {
    address mallory = makeAddr("mallory");

    function stake() internal {
        vm.prank(keeper);
        vault.stakeIdle();
    }

    /// What one front-door redeem of all of `user`'s shares would burn now, without changing state; in a
    /// fresh window (a day later) when `fresh`, else in the current one.
    function burnNow(address user, bool fresh) internal returns (uint256 out) {
        uint256 snap = vm.snapshotState();
        if (fresh) vm.warp(block.timestamp + 1 days + 1);
        vm.recordLogs();
        deliver(BASE, frontDoor, 9_999, noEntries(), entries1(user, vault.balanceOf(user)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == CascadeVault.Redeemed.selector) {
                (, out) = abi.decode(logs[i].data, (uint256, uint256));
            }
        }
        vm.revertToState(snap);
    }

    /// alice holds 10_000 TAO, staked more than a day ago (exact stake reads); direct deposits allowed up
    /// to 2M TAO; a 5_000 TAO per-entry cap, so it never hides the allowance. Her allowance is 2_000 TAO.
    function bigVault() internal {
        staking.setOneRaoShort(false);
        depositVia(alice, 10_000e18);
        stake();
        vm.warp(block.timestamp + 1 days);
        vm.startPrank(owner);
        vault.setMaxTotalAssets(2_000_000e18);
        vault.setMessageLimits(5_000e18, 5_000e18, 10);
        vm.stopPrank();
        assertApproxEqAbs(burnNow(alice, true), 2_000e18, 1e10, "20% of the 10_000 staked");
    }

    /// A gift taken back out drains the booked stake: mallory deposits 990_000 TAO directly (99% of the
    /// shares), moves 10_000 TAO of stake onto the vault's hotkey, and redeems everything. The 9_900 of the
    /// gift that comes back to her is unstaked, and an unstake takes what it pays off the booked stake
    /// (and off what is ramping), so the base falls to the floor; she pays about 100 TAO. Until the next
    /// stake: that stake books the vault's real stake again and ramps the unbooked part in over a day, so
    /// the allowance is back a day later. (Without the reconciliation the base stayed at the floor for good.)
    function test_base_giftTakenBackRecoversAfterNextStake() public {
        bigVault();
        depositDirect(mallory, 990_000e18);
        staking.donateStake(HK1, vault.coldkey(), 10_000e9);
        uint256 shares = vault.balanceOf(mallory);
        vm.prank(mallory);
        vault.redeemDirect(shares);
        // she put in 990_000 + 10_000 and got about 999_900 back
        assertGt(mallory.balance, 999_899e18);
        assertApproxEqAbs(vault.rootStakeRao(), 10_100e9, 1);
        assertApproxEqAbs(burnNow(alice, true), 100e18, 1e10, "drained until the next stake");

        depositDirect(bob, 1e18);
        stake();
        // the unbooked 10_000 ramps in like a deposit: nothing of it yet, all of it a day later
        assertApproxEqAbs(burnNow(alice, false), 100e18, 1e10, "ramping");
        vm.warp(block.timestamp + 1 days);
        // base 10_101e18: 20% is 2_020.2e18
        assertApproxEqAbs(burnNow(alice, true), 2_020.2e18, 1e10, "recovered");
    }

    /// Capital cycled through the keeper's stake loop: 20 TAO deposited directly, staked by the keeper and
    /// redeemed directly, every minute for 12 hours. Each stake adds to what is ramping, and each unstake
    /// takes what it pays off it again, so the cycles net to nothing and the base stays the 10_000 staked.
    /// (Without that, each round added 20 TAO of phantom ramping stake and held the vault at the floor.)
    function test_base_cyclingThroughTheKeeperNetsToZero() public {
        bigVault();
        uint256 x = 20e18;
        vm.deal(mallory, x);
        for (uint256 i; i < 720; ++i) {
            vm.prank(mallory);
            vault.depositDirect{value: x}();
            stake();
            uint256 shares = vault.balanceOf(mallory);
            vm.prank(mallory);
            vault.redeemDirect(shares);
            vm.warp(block.timestamp + 60);
            vm.roll(block.number + 5);
        }
        assertGe(mallory.balance, x - 1e12, "rounding only");
        assertEq(vault.rootStakeRao(), 10_000e9);
        // measured in the window the cycling ran in, and in a fresh one
        assertApproxEqAbs(burnNow(alice, false), 2_000e18, 1e10);
        assertApproxEqAbs(burnNow(alice, true), 2_000e18, 1e10);
    }

    /// A claim paid as balance is booked once: the claim books what it measured (1_000 TAO), and the stake
    /// that puts that balance on a hotkey books the vault's real stake plus what it adds, not both on top
    /// of each other. So a later 1_000 TAO gift does not raise the base. (It was booked twice, and a gift
    /// of that size then counted at once.)
    function test_base_claimPaidAsBalanceIsBookedOnce() public {
        bigVault();
        staking.setClaimToBalance(true);
        staking.setUnclaimed(vault.coldkey(), HK1, 1_000e9);
        vm.prank(keeper);
        vault.claimRewards(HK1);
        stake();
        vm.warp(block.timestamp + 1 days);
        // base 11_000e18
        assertApproxEqAbs(burnNow(alice, true), 2_200e18, 1e10);
        staking.donateStake(HK1, vault.coldkey(), 1_000e9);
        assertApproxEqAbs(burnNow(alice, true), 2_200e18, 1e10, "the gift is not booked");
    }

    /// The ramp's known slowdown: every stake re-spreads what is still ramping over a fresh day, so when
    /// the keeper stakes often (here a 0.01 TAO direct deposit every minute, which anyone can send) earlier
    /// stake ramps in exponentially, with a one-day time constant, instead of linearly. That is the slowest
    /// it gets: a day after alice's stake about 1 - 1/e (63%) of it counts, so her allowance is about 126
    /// TAO, not 200. It only delays honest growth; it never lets stake count sooner.
    function test_base_frequentStakesSlowTheRampToAnExponential() public {
        staking.setOneRaoShort(false);
        depositVia(alice, 1_000e18);
        stake();
        vm.prank(owner);
        vault.setMaxTotalAssets(2_000e18);
        for (uint256 i; i < 1_440; ++i) {
            vm.warp(block.timestamp + 60);
            depositDirect(mallory, 0.01e18);
            stake();
        }
        uint256 out = burnNow(alice, false);
        emit log_named_decimal_uint("allowance a day after alice's stake (TAO)", out, 18);
        // 20% of (1_000 * (1 - (1 - 1/1440)^1440) + mallory's part) is just above 126.4
        assertGt(out, 126e18);
        assertLt(out, 130e18);
    }

    /// A gift left in place ramps in like a deposit once the keeper next stakes, and then counts: it is
    /// the vault's to keep, and its giver's shares are worth it.
    function test_base_giftLeftInPlaceRampsIn() public {
        bigVault();
        staking.donateStake(HK1, vault.coldkey(), 5_000e9);
        assertApproxEqAbs(burnNow(alice, true), 2_000e18, 1e10, "not booked yet");
        depositDirect(bob, 1e18);
        stake();
        vm.warp(block.timestamp + 12 hours);
        // base 15_001 - (5_001 / 2) = 12_500.5e18
        assertApproxEqAbs(burnNow(alice, false), 2_500.1e18, 1e10, "half ramped");
        vm.warp(block.timestamp + 12 hours);
        assertApproxEqAbs(burnNow(alice, true), 3_000.2e18, 1e10, "all of it");
    }
}
