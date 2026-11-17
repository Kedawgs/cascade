// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeFormulas} from "../../src/libraries/CascadeFormulas.sol";
import {CascadeMath} from "../../src/libraries/CascadeMath.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {VaultInternals} from "../utils/VaultInternals.sol";
import {Schedule} from "../governance/Schedule.sol";

/// @notice The adoption drip (spec Revision 27; the founder's decision of 2026-11-13, "it should be its own drip"). An
/// adoption vests the surplus it books on a drip of its own, beside the claim schedule, and never restarts the claim
/// schedule: the claimed rewards keep their own pace, so no adoption pushes rewards that holders already earned into
/// a later window, where whoever holds then, a timed entrant included, would take a share of them (spec §3.5's former
/// fifth residual). A second adoption restarts only the adoption drip, on its remainder and the new surplus, by the
/// claim schedule's rule (the period in force, or what is left of the drip when that is longer: ruling B7b), which
/// moves only gift value; a claim restarts only the claim schedule, carrying its own remainder alone.
/// unvestedRewards() is both drips' sum on the vault and on the lens, so the price steps at neither restart. The
/// write-down at a supply of 0, which covers both drips, is Supply0Underwater's.
contract VaultAdoptionDripTest is VaultTestBase {
    uint256 constant RAO = 1e9;
    address treasury = makeAddr("treasury");

    /// One drip's three fields as the lens serves them.
    struct Drip {
        uint256 amount;
        uint64 start;
        uint64 period;
    }

    /// The fixture's vault is a VaultInternals, so a test can compare the vault's own unvestedRewards().
    function deployVault(CascadeVault.Params memory p) internal override returns (CascadeVault) {
        return new VaultInternals(p);
    }

    /// The fixture's values with the launch's reward settings (Appendix B): a 10% cut to the treasury, 30 days of
    /// vesting.
    function vaultParams() internal view override returns (CascadeVault.Params memory p) {
        p = super.vaultParams();
        p.treasury = treasury;
        p.rewardCutBps = 1_000;
        p.rewardVesting = 30 days;
    }

    /// Exact stake reads, and alice's 100 TAO deposited directly and staked.
    function setUp() public override {
        super.setUp();
        staking.setOneRaoShort(false);
        depositDirect(alice, 100e18);
        vm.prank(keeper);
        vault.stakeIdle();
        assertEq(vaultLens.totalAssets(), 100e18);
    }

    // ---- helpers ----

    function internals() internal view returns (VaultInternals) {
        return VaultInternals(payable(address(vault)));
    }

    /// The keeper claims `rao` of HK1's rewards (paid as stake on HK1).
    function claimRao(uint256 rao) internal {
        staking.setUnclaimed(vaultLens.coldkey(), HK1, rao);
        vm.prank(keeper);
        vault.claimRewards{gas: 60_000_000}(HK1);
    }

    /// A stranger gives `rao` of stake to HK1, and the keeper adopts it.
    function giftAndAdopt(uint256 rao) internal {
        staking.donateStake(HK1, vaultLens.coldkey(), rao);
        vm.prank(keeper);
        vault.adoptStake();
    }

    function claimSchedule() internal view returns (Drip memory) {
        return Drip(vaultLens.vestingAmount(), vaultLens.vestingStart(), vaultLens.vestingPeriod());
    }

    function adoptionDrip() internal view returns (Drip memory) {
        return Drip(vaultLens.adoptVestingAmount(), vaultLens.adoptVestingStart(), vaultLens.adoptVestingPeriod());
    }

    /// What is still vesting of `d`, by the vault's one-drip formula.
    function unvestedOf(Drip memory d) internal view returns (uint256) {
        return CascadeFormulas.unvestedRewards(d.amount, d.start, d.period);
    }

    function assertDrip(Drip memory d, uint256 amount, uint256 start, uint256 period, string memory what)
        internal
        pure
    {
        assertEq(d.amount, amount, string.concat(what, ": amount"));
        assertEq(d.start, start, string.concat(what, ": start"));
        assertEq(d.period, period, string.concat(what, ": period"));
    }

    function assertSameDrip(Drip memory a, Drip memory b, string memory what) internal pure {
        assertDrip(a, b.amount, b.start, b.period, what);
    }

    /// unvestedRewards() on the vault and on the lens, each the two drips' sum, and totalAssets() leaving it out.
    function assertTheSum(string memory when) internal view {
        uint256 sum = unvestedOf(claimSchedule()) + unvestedOf(adoptionDrip());
        assertEq(vaultLens.unvestedRewards(), sum, string.concat(when, ": the lens's sum"));
        assertEq(internals().exposed_unvestedRewards(), sum, string.concat(when, ": the vault's sum"));
        assertEq(
            vaultLens.totalAssets(),
            vaultLens.grossAssets() - vaultLens.pendingPayouts() - sum,
            string.concat(when, ": totalAssets leaves both out")
        );
        assertEq(internals().exposed_totalAssets(), vaultLens.totalAssets(), string.concat(when, ": the vault's"));
    }

    // ---- an adoption ----

    /// The founder's case (the fifth residual, now gone): a claim's 9 TAO vests over 30 days; 25 days in (1.5 TAO of
    /// it left), the keeper adopts a 5 TAO gift. The claim schedule is untouched (its amount, start and period), the
    /// gift starts its own drip over the 30 days in force, and the price does not step; at the claim's 30th day the
    /// claimed rewards are fully vested, as if no adoption had come (before, the restart spread the 1.5 TAO over 30 more
    /// days), while the gift keeps vesting on its own.
    function test_anAdoptionLeavesTheClaimScheduleAndStartsItsOwnDrip() public {
        claimRao(10e9);
        uint256 t0 = vm.getBlockTimestamp();
        assertDrip(claimSchedule(), 9e18, t0, 30 days, "the claim, less its 10% cut");
        Schedule.warpTo(t0 + 25 days);
        Drip memory claimed = claimSchedule();
        uint256 assets = vaultLens.totalAssets();
        uint256 price = vaultLens.price();
        assertEq(unvestedOf(claimed), 1.5e18);

        giftAndAdopt(5e9);
        uint256 t1 = vm.getBlockTimestamp();
        assertSameDrip(claimSchedule(), claimed, "the claim schedule, untouched");
        assertDrip(adoptionDrip(), 5e18, t1, 30 days, "the gift's own drip, over the period in force");
        assertEq(vaultLens.totalAssets(), assets, "no step");
        assertEq(vaultLens.price(), price);
        assertTheSum("at the adoption");

        Schedule.warpTo(t0 + 30 days);
        assertEq(unvestedOf(claimSchedule()), 0, "the claimed rewards fully vested at their own end");
        assertEq(vaultLens.unvestedRewards(), unvestedOf(adoptionDrip()), "only the gift still vests");
        assertEq(vaultLens.unvestedRewards(), uint256(5e18) * 25 / 30, "25 of its 30 days left");
        assertTheSum("at the claim's end");
        Schedule.warpTo(t1 + 30 days);
        assertEq(vaultLens.unvestedRewards(), 0);
        // the cut's 1 TAO is the treasury's shares, priced like the rest
        assertEq(vaultLens.totalAssets(), 115e18, "all of it in the price");
    }

    /// A second adoption while the first's drip runs restarts only the adoption drip, on its remainder and the new
    /// surplus, over the longer of the period in force and what is left of the drip (ruling B7b): 2 days after a
    /// 4 TAO adoption at 30 days, a 2 TAO one keeps 30 days (the period in force, longer than the 28 left); the period
    /// then lowered to 7 days (a scheduled decrease), a third keeps what is left of the drip (28 days), never the 7;
    /// after the drip has ended a fourth takes the 7. The claim schedule never moves, and no adoption steps the price.
    function test_aSecondAdoptionRestartsOnlyTheAdoptionDripByTheMaxRule() public {
        Schedule.warpTo(deployedAt + 1 days);
        claimRao(10e9);
        Drip memory claimed = claimSchedule();
        giftAndAdopt(4e9);
        uint256 t1 = vm.getBlockTimestamp();
        assertDrip(adoptionDrip(), 4e18, t1, 30 days, "the first adoption");

        Schedule.warpTo(t1 + 2 days);
        uint256 left = unvestedOf(adoptionDrip());
        assertEq(left, uint256(4e18) * 28 / 30);
        uint256 assets = vaultLens.totalAssets();
        giftAndAdopt(2e9);
        uint256 t2 = vm.getBlockTimestamp();
        assertDrip(adoptionDrip(), left + 2e18, t2, 30 days, "the second: the period in force, above the 28 days left");
        assertSameDrip(claimSchedule(), claimed, "the claim schedule, untouched by the second");
        assertEq(vaultLens.totalAssets(), assets, "no step at the second");

        Schedule.run(vault, owner, abi.encodeCall(CascadeVault.setRewardVesting, (7 days)));
        uint256 t3 = vm.getBlockTimestamp();
        assertEq(t3, t2 + 2 days);
        left = unvestedOf(adoptionDrip());
        assets = vaultLens.totalAssets();
        giftAndAdopt(1e9);
        assertDrip(adoptionDrip(), left + 1e18, t3, t2 + 30 days - t3, "the third: the drip's own 28 days, not the 7");
        assertSameDrip(claimSchedule(), claimed, "the claim schedule, untouched by the third");
        assertEq(vaultLens.totalAssets(), assets, "no step at the third");
        assertTheSum("after the third");

        Schedule.warpTo(t2 + 30 days);
        assertEq(unvestedOf(adoptionDrip()), 0, "the drip ended");
        giftAndAdopt(3e9);
        assertDrip(adoptionDrip(), 3e18, vm.getBlockTimestamp(), 7 days, "a fresh drip takes the period in force");
        assertSameDrip(claimSchedule(), claimed, "the claim schedule, untouched by the fourth");
    }

    // ---- a claim ----

    /// A claim while an adoption drip runs restarts the claim schedule on its own remainder and the claim less the cut,
    /// never the drip's: a 6 TAO gift and a 10 TAO claim, both at 30 days, then 10 days later a 5 TAO claim. The claim
    /// schedule carries its own 20/30 of 9 TAO and the new 4.5 TAO over 30 days; the adoption drip keeps its amount,
    /// start and period; the price does not step (it rises by under a share: the cut is minted at the price before).
    function test_aClaimDuringARunningAdoptionDripCarriesOnlyItsOwnRemainder() public {
        Schedule.warpTo(deployedAt + 1 days);
        claimRao(10e9);
        giftAndAdopt(6e9);
        uint256 t1 = vm.getBlockTimestamp();
        Drip memory drip = adoptionDrip();
        assertDrip(drip, 6e18, t1, 30 days, "the gift's drip");

        Schedule.warpTo(t1 + 10 days);
        uint256 own = unvestedOf(claimSchedule());
        assertEq(own, 6e18, "20 of the claim's 30 days left");
        uint256 price = vaultLens.price();
        claimRao(5e9);
        uint256 t2 = vm.getBlockTimestamp();
        assertDrip(claimSchedule(), own + 4.5e18, t2, 30 days, "its own remainder and the claim less its cut");
        assertSameDrip(adoptionDrip(), drip, "the adoption drip, untouched by the claim");
        assertGe(vaultLens.price(), price, "the claim does not lower the price");
        assertLe(CascadeMath.price(vaultLens.totalAssets(), vault.totalSupply() + 1), price, "nor raise it a share");
        assertTheSum("after the claim");
    }

    // ---- the sum ----

    /// unvestedRewards() is both drips' sum, on the vault and on the lens, whichever runs: none, the claim schedule
    /// alone, both, the adoption drip alone (the claim's ended first), and none again.
    function test_unvestedRewardsIsTheSumOfBothDrips() public {
        assertEq(vaultLens.unvestedRewards(), 0);
        assertTheSum("before any");
        Schedule.warpTo(deployedAt + 1 days);
        claimRao(10e9);
        assertTheSum("the claim schedule alone");
        Schedule.warpTo(vm.getBlockTimestamp() + 10 days);
        giftAndAdopt(5e9);
        assertGt(unvestedOf(claimSchedule()), 0);
        assertGt(unvestedOf(adoptionDrip()), 0);
        assertTheSum("both");
        Schedule.warpTo(vm.getBlockTimestamp() + 7 days);
        assertTheSum("both, a week on");
        Schedule.warpTo(vm.getBlockTimestamp() + 13 days);
        assertEq(unvestedOf(claimSchedule()), 0);
        assertGt(unvestedOf(adoptionDrip()), 0);
        assertTheSum("the adoption drip alone");
        Schedule.warpTo(vm.getBlockTimestamp() + 10 days);
        assertEq(vaultLens.unvestedRewards(), 0);
        assertTheSum("none again");
    }

    // ---- the price ----

    /// The price never steps at an adoption or a claim, in any order, at any gaps, both drips running: an adoption
    /// leaves totalAssets() exactly as it was (it books the surplus and vests all of it, no cut); a claim leaves the
    /// price within a share of where it was, never lower (the cut minted at the price before, rounded down). And the
    /// sum holds after each.
    function testFuzz_thePriceNeverStepsAtAnAdoptionOrAClaim(uint256 seed) public {
        Schedule.warpTo(deployedAt + 1 days);
        for (uint256 i; i < 8; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            Schedule.warpTo(vm.getBlockTimestamp() + 1 days + r % 20 days);
            uint256 price = vaultLens.price();
            if ((r >> 64) % 2 == 0) {
                uint256 assets = vaultLens.totalAssets();
                giftAndAdopt(2_000_000 + (r >> 72) % 5e9);
                assertEq(vaultLens.totalAssets(), assets, "an adoption stepped the assets");
                assertEq(vaultLens.price(), price, "an adoption stepped the price");
            } else {
                claimRao(1e6 + (r >> 72) % 5e9);
                assertGe(vaultLens.price(), price, "a claim lowered the price");
                assertLe(CascadeMath.price(vaultLens.totalAssets(), vault.totalSupply() + 1), price, "a share or more");
            }
            assertTheSum("after a step");
        }
    }
}
