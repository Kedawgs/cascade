// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {Schedule} from "../governance/Schedule.sol";
import {InvalidParameter, NotScheduled} from "../../src/CascadeErrors.sol";
import {OutflowLimitsSet, Redeemed} from "../../src/CascadeEvents.sol";

/// The front-door allowance base (min(visible stake, booked stake) less what is still ramping in, I-5) against
/// attempts to deflate or inflate it: a stake gift taken back out, capital cycled through the keeper's stake
/// loop, a claim paid as balance, a gift left in place. Ported from the pre-audit review's proofs of concept;
/// since Task 12 the ledger books only stake-side measurements and the price reads min(visible, booked), so a
/// gift is neither priced nor booked (I-3). And the outflow limits' hard bounds and directions (Task 17); the
/// windows themselves, each door's and the global one, are tested with two doors in VaultOrigin.t.sol.
contract VaultAllowanceBaseTest is VaultTestBase {
    address mallory = makeAddr("mallory");

    /// Direct deposits allowed up to 2M TAO and a 5_000 TAO per-entry cap (the message too), from the
    /// constructor: raising either is a scheduled loosening (Task 11), whose 48 hours would move these
    /// tests' ramps.
    function vaultParams() internal view override returns (CascadeVault.Params memory p) {
        p = super.vaultParams();
        p.maxTotalAssets = 2_000_000e18;
        p.maxEntryValue = 5_000e18;
        p.maxMessageValue = 5_000e18;
    }

    function stake() internal {
        vm.prank(keeper);
        vault.stakeIdle();
    }

    /// What one front-door redeem of all of `user`'s shares would burn now, without changing state; in a
    /// fresh window (a day later) when `fresh`, else in the current one.
    function burnNow(address user, bool fresh) internal returns (uint256 out) {
        uint256 snap = vm.snapshotState();
        if (fresh) vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        vm.recordLogs();
        deliver(BASE, frontDoor, 9_999, noEntries(), entries1(user, vault.balanceOf(user)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == Redeemed.selector) {
                (, out) = abi.decode(logs[i].data, (uint256, uint256));
            }
        }
        vm.revertToState(snap);
    }

    /// alice holds 10_000 TAO, staked more than a day ago (exact stake reads); direct deposits allowed up
    /// to 2M TAO; a 5_000 TAO per-entry cap, so it never hides the allowance (both from the constructor,
    /// vaultParams). Her allowance is 2_000 TAO.
    function bigVault() internal {
        staking.setOneRaoShort(false);
        depositVia(alice, 10_000e18);
        stake();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertEq(vaultLens.maxTotalAssets(), 2_000_000e18);
        assertEq(vaultLens.maxEntryValue(), 5_000e18);
        assertApproxEqAbs(burnNow(alice, true), 2_000e18, 1e10, "20% of the 10_000 staked");
    }

    /// A gift cannot be taken back out to drain the base: mallory deposits 990_000 TAO directly (99% of the
    /// shares), moves 10_000 TAO of stake onto the vault's hotkey, and redeems everything. (On v3.1 the gift
    /// was priced at once, 9_900 of it came back to her by an unstake that the ledger booked off the base, and
    /// the base fell to the floor until the next stake.) Priced at min(visible, booked), the gift is not hers to
    /// take: she gets her 990_000 back, out of the liquid balance, nothing is unstaked, and the base stays at
    /// the 10_000 booked, through a later stake too, which books only what it adds (I-3, I-5).
    function test_base_aGiftTakenBackIsNotPricedSoTheBaseHolds() public {
        bigVault();
        depositDirect(mallory, 990_000e18);
        staking.donateStake(HK1, vaultLens.coldkey(), 10_000e9);
        uint256 shares = vault.balanceOf(mallory);
        vm.prank(mallory);
        vault.redeemDirect(shares, false);
        // she put in 990_000 + 10_000 and got her 990_000 back, the gift none of it
        assertLe(mallory.balance, 990_000e18);
        assertGt(mallory.balance, 989_999e18);
        assertEq(vaultLens.visibleStakeRao(), 20_000e9, "nothing unstaked");
        assertEq(vaultLens.bookedStake(), 10_000e9);
        assertApproxEqAbs(burnNow(alice, true), 2_000e18, 1e10, "the base holds");

        depositDirect(bob, 1e18);
        stake();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        // base 10_001e18: 20% is 2_000.2e18; the gift never ramps in
        assertApproxEqAbs(burnNow(alice, true), 2_000.2e18, 1e10, "a stake books only what it adds");
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
            vault.redeemDirect(shares, false);
            vm.warp(vm.getBlockTimestamp() + 60);
            vm.roll(vm.getBlockNumber() + 5);
        }
        assertGe(mallory.balance, x - 1e12, "rounding only");
        assertEq(vaultLens.visibleStakeRao(), 10_000e9);
        // measured in the window the cycling ran in, and in a fresh one
        assertApproxEqAbs(burnNow(alice, false), 2_000e18, 1e10);
        assertApproxEqAbs(burnNow(alice, true), 2_000e18, 1e10);
    }

    /// A claim paid as balance is booked once: the claim books nothing stake-side (its 1_000 TAO is liquid),
    /// and the stake that puts that balance on a hotkey books what it measured. So a later 1_000 TAO gift does
    /// not raise the base. (On an early version it was booked twice, and a gift of that size then counted at
    /// once.)
    function test_base_claimPaidAsBalanceIsBookedOnce() public {
        bigVault();
        staking.setClaimToBalance(true);
        staking.setUnclaimed(vaultLens.coldkey(), HK1, 1_000e9);
        vm.prank(keeper);
        vault.claimRewards(HK1);
        stake();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        // base 11_000e18
        assertApproxEqAbs(burnNow(alice, true), 2_200e18, 1e10);
        staking.donateStake(HK1, vaultLens.coldkey(), 1_000e9);
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
            vm.warp(vm.getBlockTimestamp() + 60);
            depositDirect(mallory, 0.01e18);
            stake();
        }
        uint256 out = burnNow(alice, false);
        emit log_named_decimal_uint("allowance a day after alice's stake (TAO)", out, 18);
        // 20% of (1_000 * (1 - (1 - 1/1440)^1440) + mallory's part) is just above 126.4
        assertGt(out, 126e18);
        assertLt(out, 130e18);
    }

    /// A gift left in place never enters the base through a stake (spec §3.10.12: v3.1 ramped it in once the
    /// keeper next staked; v3.2's stake books only what it measured adding): only adoptStake books it (Task
    /// 16), into the base at once, without a ramp.
    function test_base_giftLeftInPlaceNeverRampsIn() public {
        bigVault();
        staking.donateStake(HK1, vaultLens.coldkey(), 5_000e9);
        assertApproxEqAbs(burnNow(alice, true), 2_000e18, 1e10, "not booked");
        depositDirect(bob, 1e18);
        stake();
        vm.warp(vm.getBlockTimestamp() + 12 hours);
        // base 10_001 - 1 / 2 = 10_000.5e18
        assertApproxEqAbs(burnNow(alice, false), 2_000.1e18, 1e10, "bob's half ramped, the gift none");
        vm.warp(vm.getBlockTimestamp() + 12 hours);
        assertApproxEqAbs(burnNow(alice, true), 2_000.2e18, 1e10, "bob's, never the gift");
        assertEq(vaultLens.surplusStakeRao(), 5_000e9);
    }

    // ---- the outflow limits (Task 17, spec §3.4 and §3.6) ----

    function assertOutflowLimits(uint256 bps, uint256 minDaily, uint256 globalBps) internal view {
        assertEq(vaultLens.maxDailyOutflowBps(), bps, "maxDailyOutflowBps");
        assertEq(vaultLens.minDailyOutflow(), minDaily, "minDailyOutflow");
        assertEq(vaultLens.globalOutflowBps(), globalBps, "globalOutflowBps");
    }

    /// The owner's direct setOutflowLimits(bps, minDaily, globalBps) applies at once, logging OutflowLimitsSet.
    function setNow(uint256 bps, uint256 minDaily, uint256 globalBps) internal {
        vm.expectEmit(address(vault));
        emit OutflowLimitsSet(bps, minDaily, globalBps);
        vm.prank(owner);
        vault.setOutflowLimits(bps, minDaily, globalBps);
        assertOutflowLimits(bps, minDaily, globalBps);
    }

    /// Both percentages, each door's (maxDailyOutflowBps) and all doors' (globalOutflowBps), are bounded to 2,000
    /// to 5,000 bps, and the floor they share (minDailyOutflow) to 10 to 100 TAO (spec §3.4: the 20% launch value
    /// is the lower bound, so no outflow setting can freeze an exit). A value below a bound is a tightening,
    /// refused at once; one above it a loosening, refused directly as unscheduled and, scheduled, by the setter's
    /// own check at execute, the item kept. Each bound itself is accepted.
    function test_outflowBounds() public {
        bytes memory invalid = abi.encodeWithSelector(InvalidParameter.selector);
        // from the fixture's (2,000 bps, 100 TAO, 2,000 bps)
        assertOutflowLimits(2_000, 100e18, 2_000);
        bytes[3] memory below = [
            abi.encodeCall(CascadeVault.setOutflowLimits, (1_999, 100e18, 2_000)),
            abi.encodeCall(CascadeVault.setOutflowLimits, (2_000, 9.99e18, 2_000)),
            abi.encodeCall(CascadeVault.setOutflowLimits, (2_000, 100e18, 1_999))
        ];
        for (uint256 i; i < below.length; ++i) {
            vm.prank(owner);
            (bool ok, bytes memory ret) = address(vault).call(below[i]);
            assertFalse(ok, "below a bound");
            assertEq(ret, invalid, "InvalidParameter at once");
        }

        bytes[3] memory above = [
            abi.encodeCall(CascadeVault.setOutflowLimits, (5_001, 100e18, 5_000)),
            abi.encodeCall(CascadeVault.setOutflowLimits, (5_000, 100.01e18, 5_000)),
            abi.encodeCall(CascadeVault.setOutflowLimits, (5_000, 100e18, 5_001))
        ];
        for (uint256 i; i < above.length; ++i) {
            vm.prank(owner);
            (bool ok, bytes memory ret) = address(vault).call(above[i]);
            assertFalse(ok, "above a bound, directly");
            assertEq(ret, abi.encodeWithSelector(NotScheduled.selector), "a loosening: NotScheduled");
            vm.prank(owner);
            vault.schedule(above[i]);
        }
        Schedule.wait(48 hours);
        for (uint256 i; i < above.length; ++i) {
            vm.prank(owner);
            (bool ok, bytes memory ret) = address(vault).call(abi.encodeCall(vault.execute, (above[i])));
            assertFalse(ok, "above a bound, at execute");
            assertEq(ret, invalid, "InvalidParameter at execute");
            assertGt(vaultLens.scheduled(keccak256(above[i])).readyAt, 0, "the item kept");
        }
        assertOutflowLimits(2_000, 100e18, 2_000);

        // the bounds themselves: the upper ones scheduled, the lower ones at once
        Schedule.run(vault, owner, abi.encodeCall(CascadeVault.setOutflowLimits, (5_000, 100e18, 5_000)));
        assertOutflowLimits(5_000, 100e18, 5_000);
        setNow(2_000, 10e18, 2_000);
    }

    /// Raising any of the three outflow values loosens the exit limits (spec §3.6): alone or beside others lowered,
    /// it is refused directly (NotScheduled) and runs only as a scheduled item, 48 hours on (the Param class). A
    /// call that raises none applies at once, whatever it lowers, an equal value included. Both log
    /// OutflowLimitsSet with the three values.
    function test_outflowIncreaseScheduledDecreaseImmediate() public {
        // the floor down, at once, from the fixture's (2,000 bps, 100 TAO, 2,000 bps)
        setNow(2_000, 50e18, 2_000);
        bytes[4] memory up = [
            abi.encodeCall(CascadeVault.setOutflowLimits, (2_001, 50e18, 2_000)),
            abi.encodeCall(CascadeVault.setOutflowLimits, (2_000, 50e18 + 1, 2_000)),
            abi.encodeCall(CascadeVault.setOutflowLimits, (2_000, 50e18, 2_001)),
            abi.encodeCall(CascadeVault.setOutflowLimits, (2_000, 10e18, 2_001))
        ];
        for (uint256 i; i < up.length; ++i) {
            vm.prank(owner);
            (bool ok, bytes memory ret) = address(vault).call(up[i]);
            assertFalse(ok, "a raise applied at once");
            assertEq(ret, abi.encodeWithSelector(NotScheduled.selector), "NotScheduled");
        }
        assertOutflowLimits(2_000, 50e18, 2_000);

        // each raised alone, then all three together, as scheduled items
        uint256[3][4] memory raised = [
            [uint256(2_500), 50e18, 2_000],
            [uint256(2_500), 60e18, 2_000],
            [uint256(2_500), 60e18, 2_200],
            [uint256(4_000), 80e18, 3_000]
        ];
        for (uint256 i; i < raised.length; ++i) {
            bytes memory data =
                abi.encodeCall(CascadeVault.setOutflowLimits, (raised[i][0], raised[i][1], raised[i][2]));
            vm.prank(owner);
            vault.schedule(data);
            Schedule.wait(48 hours);
            vm.expectEmit(address(vault));
            emit OutflowLimitsSet(raised[i][0], raised[i][1], raised[i][2]);
            vm.prank(owner);
            vault.execute(data);
            assertOutflowLimits(raised[i][0], raised[i][1], raised[i][2]);
        }

        // each lowered alone at once, then all three, then an equal value
        setNow(3_000, 80e18, 3_000);
        setNow(3_000, 60e18, 3_000);
        setNow(3_000, 60e18, 2_500);
        setNow(2_000, 10e18, 2_000);
        setNow(2_000, 10e18, 2_000);
    }
}
