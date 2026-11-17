// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {CascadeMath} from "../../src/libraries/CascadeMath.sol";
import {CascadeFormulas} from "../../src/libraries/CascadeFormulas.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {VaultInsolvent} from "../../src/CascadeErrors.sol";
import {BounceReason} from "../../src/CascadeTypes.sol";
import {
    DepositBounced,
    Deposited,
    DepositedDirect,
    PayoutBatchQueued,
    RewardCutMinted,
    RewardsClaimed
} from "../../src/CascadeEvents.sol";
import {Schedule} from "../governance/Schedule.sol";

/// @notice No mint at an empty vault that is quietly underwater (Task 10c; spec §3.1, I-1, I-4).
/// totalAssets() floors gross - pending - unvested at 0, and only a deposit at a supply of 0 (below) writes the
/// schedule down when a loss eats the unvested remainder, so the vault can owe more than it holds while its assets
/// read 0. With shares outstanding the half-launch line sees that (0 < supply); at a supply of 0 it reads 0 < 0
/// and never trips, so a mint there was priced at the launch price and its money filled the hole: the treasury's
/// cut, the first depositor's money, or, where the loss reached the payout reservation, an earlier leaver's
/// queued payout, paid by the new depositor for good. Every mint (the cut, a direct deposit, a batch's deposits)
/// now also refuses while the vault is underwater on the gross before its own money (CascadeFormulas.underwater):
/// while any reward still vests, short of the queued payouts and the unvested rewards by any amount; with none
/// vesting, short of the queued payouts by more than 1,000 rao (a rounding of the chain's, which I-4 excepts: no exit
/// leaves one since Task 36b, every exit paying its own cost; here a simulated loss makes it). With shares
/// outstanding the line decides, as before.
/// At a supply of 0 the unvested rewards are no holder's (Task 15): a deposit there, direct or in a batch, first
/// writes the schedule down to what the gross before it holds beyond the queued payouts, restarting it on that
/// amount by _vest's rule (the period in force, or what was left of the old schedule if longer: a carried remainder
/// keeps its own end), so a hole in the schedule no longer refuses deposits until it vests away (the deposit mints
/// at the launch price and pays for none of it); a payout shortfall past the tolerance still refuses. Since Revision
/// 27 an adoption vests on its own drip beside the claim schedule, and the write-down covers both: the adoption drip
/// first, then the claim schedule when it alone exceeds what the gross holds, each restarting by its own rule.
/// There a delivery reverts VaultInsolvent whole (Task 25's carry from Task 10c), its write-down with it, so the
/// Bittensor adapter parks the batch rather than its deposits bouncing: a bounce's TAO, reserved, would fill the hole
/// for an older queued payout paid first. At a supply of 0 no redeem can burn, so the revert costs no leaver anything.
/// The cut's skip is unchanged, and nothing is written down while shares are outstanding, where a batch's deposits
/// still bounce and its redeems still burn.
contract Supply0UnderwaterTest is VaultTestBase {
    /// The vault's UNDERWATER_TOLERANCE, restated: 1,000 rao, in wei, of payout shortfall with nothing vesting.
    uint256 constant TOLERANCE = 1_000e9;
    /// The launch price: (0 + 1) * 1e18 / (0 + 1e6).
    uint256 constant LAUNCH_PRICE = 1e12;

    address treasury = makeAddr("treasury");
    /// The treasury named with the maximum cut: a loosening (Task 11), scheduled in setUp, which then lets its
    /// 48 hours pass before anything else; setCut executes it and lowers the cut at once.
    bytes maxCut;

    /// Exact stake reads, and claims paid out as liquid balance, so a loss can take rewards still vesting.
    function setUp() public override {
        super.setUp();
        staking.setOneRaoShort(false);
        staking.setClaimToBalance(true);
        maxCut = abi.encodeCall(CascadeVault.setRewardCut, (treasury, 2_000));
        vm.prank(owner);
        vault.schedule(maxCut);
        Schedule.warpTo(vm.getBlockTimestamp() + 48 hours);
    }

    /// The keeper claims `rao` of HK1's rewards.
    function claim(uint256 rao) internal {
        accrue(rao);
        claimAccrued();
    }

    /// `rao` of rewards accrue on HK1.
    function accrue(uint256 rao) internal {
        staking.setUnclaimed(vaultLens.coldkey(), HK1, rao);
    }

    /// The keeper claims HK1's accrued rewards: one call, so an expectEmit before it checks the claim.
    function claimAccrued() internal {
        vm.prank(keeper);
        vault.claimRewards{gas: 60_000_000}(HK1);
    }

    /// The cut to the treasury becomes `bps`: setUp's scheduled maximum executed, then lowered at once (a
    /// tightening).
    function setCut(uint16 bps) internal {
        vm.startPrank(owner);
        vault.execute(maxCut);
        vault.setRewardCut(treasury, bps);
        vm.stopPrank();
    }

    /// The vault's TAO less `loss` wei, as a lost or written-off position would leave it.
    function lose(uint256 loss) internal {
        vm.deal(address(vault), address(vault).balance - loss);
    }

    /// What `who`'s shares redeem for now.
    function assetsOf(address who) internal view returns (uint256) {
        return CascadeMath.assetsForRedeem(vault.balanceOf(who), vaultLens.totalAssets(), vault.totalSupply());
    }

    /// An empty vault (no shares) whose 1 TAO of rewards still vests as liquid balance, `loss` wei of it then
    /// lost: gross 1e18 - loss against 1e18 unvested, `loss` underwater, its assets reading 0.
    function emptyAndUnderwater(uint256 loss) internal {
        claim(1_000_000_000);
        lose(loss);
        assertEq(vault.totalSupply(), 0);
        assertEq(vaultLens.grossAssets(), 1e18 - loss);
        assertEq(vaultLens.pendingPayouts(), 0);
        assertEq(vaultLens.unvestedRewards(), 1e18);
        assertEq(vaultLens.totalAssets(), 0);
    }

    /// alice enters through the front door with 10 TAO and leaves through it: the vault is empty, 10 TAO is queued
    /// for her payout, liquid, and nothing vests.
    function emptyWithPayoutQueued() internal {
        depositVia(alice, 10e18);
        deliver(BASE, frontDoor, ++nextBatchId, noEntries(), entries1(alice, vault.balanceOf(alice)));
        assertEq(vault.totalSupply(), 0);
        assertEq(vaultLens.pendingPayouts(), 10e18);
        assertEq(vaultLens.unvestedRewards(), 0);
    }

    /// emptyWithPayoutQueued, then `shortfall` wei of what backs the payout is lost (a simulated loss, I-4's exception;
    /// before Task 36b a short unstake receipt left such a gap): gross 10e18 - shortfall against 10e18 pending, nothing
    /// vesting.
    function emptyWithPayoutShortfall(uint256 shortfall) internal {
        emptyWithPayoutQueued();
        lose(shortfall);
        assertEq(vaultLens.grossAssets(), 10e18 - shortfall);
        assertEq(vaultLens.totalAssets(), 0);
    }

    /// I-4's mint over a recorded hole, as a bound: the assets after a mint at the launch price fall short of what
    /// the mint paid in by at most the tolerance, so the price is at most 1,000 rao (in assets) below the launch
    /// price.
    function assertWithinTheUnderwaterTolerance() internal view {
        assertGe(CascadeMath.price(vaultLens.totalAssets() + TOLERANCE, vault.totalSupply()), LAUNCH_PRICE);
    }

    /// The key the next front-door batch of one deposit gets.
    function nextDepositKey(address user, uint256 amount) internal view returns (bytes32) {
        bytes memory message = CascadeMessages.encodeBatch(nextBatchId + 1, entries1(user, amount), noEntries());
        return vaultLens.batchKey(BASE, frontDoor, message);
    }

    // ---- supply 0, underwater: no mint ----

    /// The treasury's cut at an empty, underwater vault is skipped: the whole claim vests, the hole is the
    /// same, the price does not move. (It was minted at the launch price, 2e22 shares for a 0.02 TAO cut whose
    /// value went into the hole: they read 0.)
    function test_cutSkippedAtAnEmptyUnderwaterVault() public {
        emptyAndUnderwater(0.5e18);
        setCut(1_000);
        uint256 t = vm.getBlockTimestamp();

        vm.recordLogs();
        claim(200_000_000);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // RewardsClaimed alone, no RewardCutMinted
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], RewardsClaimed.selector);
        assertEq(vault.balanceOf(treasury), 0);
        assertEq(vault.totalSupply(), 0);
        // 1e18 still unvested + the 2e17 claimed, nothing kept back for the cut
        assertEq(vaultLens.vestingAmount(), 1.2e18);
        assertEq(vaultLens.vestingStart(), t);
        // the hole is unchanged: 0.7e18 gross against 1.2e18 unvested
        assertEq(vaultLens.grossAssets(), 0.7e18);
        assertEq(vaultLens.totalAssets(), 0);
        assertEq(vaultLens.price(), LAUNCH_PRICE);
    }

    /// A direct deposit at an empty vault underwater in its schedule alone (Task 15): the unvested rewards are no
    /// holder's, so the deposit first writes them down to what the gross before it holds beyond the queued payouts
    /// (the remainder restarting there over the period in force, as a claim restarts it), then mints at the launch
    /// price, whether it is smaller than the hole or larger. The write-down logs nothing. The depositor's money is
    /// whole, and the written-down remainder vests to the holders.
    function test_depositDirectAtAnEmptyUnderwaterVaultWritesTheScheduleDown() public {
        emptyAndUnderwater(0.5e18);
        // a day in: 1e18 * 6 days / 7 days still unvested, against a gross of 0.5e18; the period in force is raised
        Schedule.wait(1 days);
        uint256 t = vm.getBlockTimestamp();
        assertEq(vaultLens.unvestedRewards(), 857_142_857_142_857_142);
        vm.prank(owner);
        vault.setRewardVesting(10 days);

        vm.recordLogs();
        depositDirect(bob, 1e15);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // the shares' Transfer and DepositedDirect: nothing for the write-down
        assertEq(logs.length, 2);
        assertEq(logs[1].topics[0], DepositedDirect.selector);
        // the launch price: 1e15 * (0 + 1e6) / (0 + 1)
        assertEq(vault.balanceOf(bob), 1e21);
        // written down exactly to the 0.5e18 the gross holds (nothing queued), restarted now over the period in force
        assertEq(vaultLens.unvestedRewards(), 0.5e18);
        assertEq(vaultLens.vestingAmount(), 0.5e18);
        assertEq(vaultLens.vestingStart(), t);
        assertEq(vaultLens.vestingPeriod(), 10 days);
        assertEq(vaultLens.totalAssets(), 1e15);
        assertEq(assetsOf(bob), 1e15);

        // no longer underwater: a deposit larger than the old hole mints at bob's price, and writes nothing down
        depositDirect(carol, 1e18);
        assertEq(vault.balanceOf(carol), 1e24);
        assertEq(vaultLens.vestingAmount(), 0.5e18);
        assertEq(vaultLens.vestingStart(), t);

        // the written-down remainder vests to bob and carol
        Schedule.warpTo(t + 10 days);
        assertEq(vaultLens.unvestedRewards(), 0);
        assertEq(vaultLens.totalAssets(), 1.5e18 + 1e15);
    }

    /// A batch's deposits at an empty vault underwater in its schedule alone mint at the launch price, after the
    /// same write-down (Task 15): nothing bounces and nothing is queued.
    function test_batchDepositsAtAnEmptyUnderwaterVaultWriteTheScheduleDown() public {
        emptyAndUnderwater(0.5e18);
        uint256 t = vm.getBlockTimestamp();

        bytes32 key = nextDepositKey(bob, 1e18);
        vm.expectEmit(address(vault));
        emit Deposited(key, bob, 1e18, 1e24);
        depositVia(bob, 1e18);

        assertEq(vault.balanceOf(bob), 1e24);
        assertEq(vaultLens.pendingPayouts(), 0);
        assertEq(vaultLens.unvestedRewards(), 0.5e18);
        assertEq(vaultLens.vestingAmount(), 0.5e18);
        assertEq(vaultLens.vestingStart(), t);
        assertEq(vaultLens.vestingPeriod(), 7 days);
        // 1.5e18 gross against 0.5e18 unvested
        assertEq(vaultLens.totalAssets(), 1e18);
        assertEq(assetsOf(bob), 1e18);
    }

    /// The write-down is a restart too, so it never speeds what it keeps (Task 15's follow-up): 1 TAO vests over 30
    /// days into the empty vault, the period is cut to 1 day (executed 2 days in), and half the TAO is lost. A deposit
    /// writes the schedule down to the 0.5e18 the gross holds and keeps it on the old schedule's 28 days left, not
    /// the new 1 day.
    function test_theWriteDownKeepsTheRemaindersOwnSchedule() public {
        vm.prank(owner);
        vault.setRewardVesting(30 days);
        claim(1_000_000_000);
        uint256 t0 = vm.getBlockTimestamp();
        Schedule.run(vault, owner, abi.encodeCall(CascadeVault.setRewardVesting, (1 days)));
        lose(0.5e18);
        assertGt(vaultLens.unvestedRewards(), 0.5e18);

        depositDirect(bob, 1e18);
        assertEq(vault.balanceOf(bob), 1e24);
        assertEq(vaultLens.unvestedRewards(), 0.5e18);
        assertEq(vaultLens.vestingStart(), t0 + 2 days);
        assertEq(vaultLens.vestingPeriod(), 28 days, "the old schedule's 28 days left, not the new 1 day");
    }

    /// An empty vault whose gross exactly covers its schedule (a claim into it, nothing lost) is not underwater, and a
    /// deposit writes nothing down: the schedule keeps its start and its period (here 7 days, the period in force
    /// since raised to 10), and the deposit mints at the launch price.
    function test_nothingWrittenDownWhileTheGrossCoversTheSchedule() public {
        claim(1_000_000_000);
        uint256 t = vm.getBlockTimestamp();
        assertEq(vaultLens.grossAssets(), 1e18);
        assertEq(vaultLens.unvestedRewards(), 1e18);
        vm.prank(owner);
        vault.setRewardVesting(10 days);

        depositDirect(bob, 1e18);
        assertEq(vault.balanceOf(bob), 1e24);
        assertEq(vaultLens.vestingAmount(), 1e18);
        assertEq(vaultLens.vestingStart(), t);
        assertEq(vaultLens.vestingPeriod(), 7 days);
    }

    /// The loss reaches the payout reservation (gross below pending): alice left through the front door, her
    /// 10 TAO payout is queued, and 1 TAO of what backs it is lost. A deposit then would pay that part of her
    /// payout for good (bob's 3 TAO would read 2); it is refused, and a batch reverts VaultInsolvent whole (the
    /// adapter parks it, Task 25; a bounce, reserved, would leave its TAO to fill alice's hole), until the
    /// reservation is whole again.
    function test_lossIntoTheReservationRefusesMints() public {
        // 9e18 gross against 10e18 pending, no schedule
        emptyWithPayoutShortfall(1e18);

        vm.expectRevert(VaultInsolvent.selector);
        depositDirect(bob, 3e18);
        bytes32 key = nextDepositKey(carol, 3e18);
        vm.expectRevert(VaultInsolvent.selector);
        depositVia(carol, 3e18);
        assertFalse(vaultLens.processed(key), "the batch can be delivered later");
        assertEq(vault.totalSupply(), 0);
        assertEq(vaultLens.pendingPayouts(), 10e18);

        // the lost TAO comes back (a top-up, or the stake listed again): the reservation is whole
        vm.deal(address(vault), address(vault).balance + 1e18);
        depositDirect(bob, 3e18);
        assertEq(vault.balanceOf(bob), 3e24);
        assertEq(assetsOf(bob), 3e18);
    }

    /// A true payout shortfall still refuses at a supply of 0 while rewards vest: alice's 10 TAO payout is queued,
    /// 1 TAO of rewards vests, and 2 TAO is lost, 1 TAO of it out of the reservation. The write-down takes the
    /// schedule to 0 (the gross holds nothing beyond the payout), which leaves the payout 1 TAO short, past the
    /// tolerance: the direct deposit reverts VaultInsolvent, its write-down with it, and so does a batch (Task 25:
    /// the adapter parks it whole instead of its deposits bouncing; the park does not write the schedule down
    /// either). Once the reservation is whole, deposits mint at the launch price.
    function test_aPayoutShortfallStillRefusesWhileRewardsVest() public {
        emptyWithPayoutQueued();
        claim(1_000_000_000);
        lose(2e18);
        uint256 t = vm.getBlockTimestamp();
        assertEq(vaultLens.grossAssets(), 9e18);
        assertEq(vaultLens.unvestedRewards(), 1e18);

        vm.expectRevert(VaultInsolvent.selector);
        depositDirect(bob, 1e18);
        assertEq(vaultLens.vestingAmount(), 1e18, "the revert undoes the write-down");
        assertEq(vaultLens.vestingStart(), t);

        vm.expectRevert(VaultInsolvent.selector);
        depositVia(carol, 1e18);
        assertEq(vault.totalSupply(), 0);
        assertEq(vaultLens.pendingPayouts(), 10e18);
        assertEq(vaultLens.vestingAmount(), 1e18, "the batch's revert undoes its write-down too");
        assertEq(vaultLens.vestingStart(), t);

        // the lost TAO comes back: the reservation is whole
        vm.deal(address(vault), address(vault).balance + 1e18);
        depositDirect(bob, 3e18);
        assertEq(vault.balanceOf(bob), 3e24);
        assertEq(assetsOf(bob), 3e18);
    }

    // ---- while rewards vest: any shortfall refuses the cut, and a deposit writes it down ----

    /// While any reward still vests, a shortfall of a single wei still skips the cut (its path is unchanged: a claim
    /// adds as much to the gross as to the schedule, so the hole stays until it vests away). A deposit at the empty
    /// vault writes the wei off the schedule first and mints at the launch price, directly or in a batch.
    function test_aOneWeiHoleInTheScheduleSkipsTheCutAndIsWrittenDownByADeposit() public {
        uint256 snap = vm.snapshotState();
        emptyAndUnderwater(1);
        setCut(1_000);
        claim(200_000_000);
        assertEq(vault.balanceOf(treasury), 0);
        assertEq(vaultLens.vestingAmount(), 1.2e18);
        assertEq(vault.totalSupply(), 0);

        vm.revertToState(snap);
        emptyAndUnderwater(1);
        depositDirect(bob, 1e18);
        assertEq(vault.balanceOf(bob), 1e24);
        assertEq(vaultLens.unvestedRewards(), 1e18 - 1);
        assertEq(assetsOf(bob), 1e18);

        vm.revertToState(snap);
        emptyAndUnderwater(1);
        bytes32 key = nextDepositKey(bob, 1e18);
        vm.expectEmit(address(vault));
        emit Deposited(key, bob, 1e18, 1e24);
        depositVia(bob, 1e18);
        assertEq(vaultLens.unvestedRewards(), 1e18 - 1);
    }

    /// A shortfall across both: alice's 10 TAO payout is queued, 1 TAO of rewards then vests into the empty vault,
    /// and 1 TAO + 500 rao is lost: 500 rao short of the payout alone (inside the tolerance), 1 TAO + 500 rao short
    /// of payout and schedule. A deposit writes the whole schedule off (the gross holds nothing beyond the payout)
    /// and mints at once, at the launch price: what is left is the 500 rao of payout shortfall, within the
    /// underwater tolerance, which the depositor absorbs (I-4's mint over a loss's hole). (Before Task 15 it waited
    /// for the schedule to vest.)
    function test_aHoleAcrossBothLeavesOnlyThePayoutShortfallWithinTheTolerance() public {
        emptyWithPayoutQueued();
        claim(1_000_000_000);
        lose(1e18 + 500e9);
        assertEq(vaultLens.grossAssets(), 10e18 - 500e9);
        assertEq(vaultLens.unvestedRewards(), 1e18);

        depositDirect(bob, 1e18);
        assertEq(vault.balanceOf(bob), 1e24);
        assertEq(vaultLens.unvestedRewards(), 0);
        assertEq(vaultLens.vestingAmount(), 0);
        // bob absorbs the 500 rao
        assertEq(vaultLens.totalAssets(), 1e18 - 500e9);
        assertWithinTheUnderwaterTolerance();
    }

    /// The gross covers the queued payout but only half the schedule: a deposit writes the schedule down to the half
    /// the gross backs, never reaching into the payout's reservation, and mints at the launch price; the half vests
    /// to the depositor.
    function test_aHoleInTheScheduleBeyondThePayoutIsWrittenDown() public {
        emptyWithPayoutQueued();
        claim(1_000_000_000);
        lose(0.5e18);
        uint256 t = vm.getBlockTimestamp();
        // 10.5e18 gross: the 10e18 payout is covered, 0.5e18 of the 1e18 schedule is not
        assertEq(vaultLens.grossAssets(), 10.5e18);

        depositDirect(bob, 1e18);
        assertEq(vault.balanceOf(bob), 1e24);
        assertEq(vaultLens.unvestedRewards(), 0.5e18);
        assertEq(vaultLens.pendingPayouts(), 10e18);
        assertEq(vaultLens.totalAssets(), 1e18);
        Schedule.warpTo(t + 7 days);
        assertEq(vaultLens.totalAssets(), 1.5e18);
    }

    /// Any loss, at any point of the schedule, at an empty vault with a payout queued and a reward vesting: a direct
    /// deposit reverts VaultInsolvent, writing nothing, exactly when the payout itself is short past the tolerance;
    /// otherwise it writes the schedule down to what the gross holds beyond the payout, exactly, when the schedule
    /// exceeds that (minting at the launch price), and leaves it alone when it does not. The depositor's money is
    /// whole, within the underwater tolerance and a share's rounding.
    function testFuzz_writeDownAtAnEmptyVault(uint256 loss, uint256 elapsed) public {
        emptyWithPayoutQueued();
        claim(1_000_000_000);
        Schedule.wait(bound(elapsed, 0, 8 days));
        lose(bound(loss, 0, 1e18 + 2 * TOLERANCE));
        uint256 gross = vaultLens.grossAssets();
        uint256 pending = vaultLens.pendingPayouts();
        uint256 unvested = vaultLens.unvestedRewards();
        uint256 cover = gross > pending ? gross - pending : 0;
        uint256 amount = vaultLens.vestingAmount();
        uint64 start = vaultLens.vestingStart();

        if (pending > gross + TOLERANCE) {
            vm.expectRevert(VaultInsolvent.selector);
            depositDirect(bob, 1e18);
            assertEq(vaultLens.vestingAmount(), amount);
            assertEq(vaultLens.vestingStart(), start);
            return;
        }
        depositDirect(bob, 1e18);
        if (unvested > cover) {
            assertEq(vaultLens.unvestedRewards(), cover, "written down exactly");
            assertEq(vaultLens.vestingAmount(), cover);
            assertEq(vaultLens.vestingStart(), vm.getBlockTimestamp());
            assertEq(vault.balanceOf(bob), 1e24, "the launch price");
        } else {
            assertEq(vaultLens.vestingAmount(), amount, "nothing written down");
            assertEq(vaultLens.vestingStart(), start);
        }
        uint256 assets = vaultLens.totalAssets();
        uint256 supply = vault.totalSupply();
        assertGe(assetsOf(bob) + TOLERANCE + CascadeMath.assetsForRedeem(1, assets, supply), 1e18);
    }

    // ---- the write-down covers both drips (Revision 27) ----

    /// An empty vault with both drips running over the period in force: `giftRao` of stake given to HK1 and adopted
    /// (the adoption drip), then 1 TAO of rewards claimed as liquid balance (the claim schedule).
    function emptyWithBothDrips(uint256 giftRao) internal {
        staking.donateStake(HK1, vaultLens.coldkey(), giftRao);
        vm.prank(keeper);
        vault.adoptStake();
        claim(1_000_000_000);
        assertEq(vault.totalSupply(), 0);
        assertEq(vaultLens.adoptVestingAmount(), giftRao * 1e9);
        assertEq(vaultLens.vestingAmount(), 1e18);
        assertEq(vaultLens.grossAssets(), giftRao * 1e9 + 1e18);
        assertEq(vaultLens.unvestedRewards(), giftRao * 1e9 + 1e18);
    }

    /// What is still vesting of the claim schedule alone, and of the adoption drip alone.
    function claimUnvested() internal view returns (uint256) {
        return
            CascadeFormulas.unvestedRewards(
                vaultLens.vestingAmount(), vaultLens.vestingStart(), vaultLens.vestingPeriod()
            );
    }

    function adoptionUnvested() internal view returns (uint256) {
        return CascadeFormulas.unvestedRewards(
            vaultLens.adoptVestingAmount(), vaultLens.adoptVestingStart(), vaultLens.adoptVestingPeriod()
        );
    }

    /// The write-down at a supply of 0 covers both drips, the adoption drip first (Revision 27). 0.5 TAO adopted and
    /// 1 TAO claimed vest over 7 days; two days in (5/7 of each left, about 1.07 TAO in all), 0.6 TAO of the balance is
    /// lost, so the gross (0.9 TAO) covers the claim schedule's 5/7 TAO but not the drip's on top. A deposit writes the
    /// adoption drip down to what the gross holds beyond the claim schedule, restarting it there, leaves the claim
    /// schedule as it was, and mints at the launch price.
    function test_theWriteDownTakesTheAdoptionDripFirst() public {
        emptyWithBothDrips(500_000_000);
        uint256 t0 = vm.getBlockTimestamp();
        Schedule.wait(2 days);
        lose(0.6e18);
        uint256 cover = vaultLens.grossAssets();
        assertEq(cover, 0.9e18);
        uint256 own = claimUnvested();
        assertLe(own, cover, "the claim schedule alone fits");
        assertGt(vaultLens.unvestedRewards(), cover, "both do not");

        depositDirect(bob, 1e18);
        assertEq(vault.balanceOf(bob), 1e24, "the launch price");
        assertEq(vaultLens.unvestedRewards(), cover, "written down exactly");
        assertEq(vaultLens.vestingAmount(), 1e18, "the claim schedule untouched");
        assertEq(vaultLens.vestingStart(), t0);
        assertEq(vaultLens.vestingPeriod(), 7 days);
        assertEq(vaultLens.adoptVestingAmount(), cover - own, "the adoption drip, to what is beyond the claim schedule");
        assertEq(vaultLens.adoptVestingStart(), vm.getBlockTimestamp(), "restarted there");
        assertEq(vaultLens.adoptVestingPeriod(), 7 days);
        assertEq(vaultLens.totalAssets(), 1e18);
        assertEq(assetsOf(bob), 1e18);
    }

    /// Once the adoption drip is written off, the claim schedule follows, each keeping its own end (the restart's
    /// rule): both drips at 30 days, the period then cut to 1 day (executed 2 days in), and 0.9 TAO of the balance
    /// lost, so the gross (0.6 TAO) is below the claim schedule alone. A deposit writes the adoption drip down to 0 and
    /// the claim schedule to the 0.6 TAO, both on the old drips' 28 days left, not the new 1 day.
    function test_theWriteDownTakesTheClaimScheduleOnceTheDripIsGone() public {
        vm.prank(owner);
        vault.setRewardVesting(30 days);
        emptyWithBothDrips(500_000_000);
        uint256 t0 = vm.getBlockTimestamp();
        Schedule.run(vault, owner, abi.encodeCall(CascadeVault.setRewardVesting, (1 days)));
        lose(0.9e18);
        assertEq(vaultLens.grossAssets(), 0.6e18);
        assertGt(claimUnvested(), 0.6e18, "the claim schedule alone is above the gross");

        depositDirect(bob, 1e18);
        assertEq(vault.balanceOf(bob), 1e24, "the launch price");
        assertEq(vaultLens.unvestedRewards(), 0.6e18, "written down exactly");
        assertEq(vaultLens.adoptVestingAmount(), 0, "the adoption drip written off");
        assertEq(vaultLens.vestingAmount(), 0.6e18, "the claim schedule to the gross");
        assertEq(vaultLens.vestingStart(), t0 + 2 days);
        assertEq(vaultLens.vestingPeriod(), 28 days, "the claim schedule's own 28 days left, not the new 1 day");
        assertEq(vaultLens.adoptVestingStart(), t0 + 2 days);
        assertEq(vaultLens.adoptVestingPeriod(), 28 days, "and the drip's");
    }

    /// Any gift, any loss, at any point of the drips, at an empty vault: a deposit writes the two drips down to exactly
    /// what the gross holds (nothing is queued) when they exceed it, the adoption drip first and the claim schedule
    /// only when it alone exceeds it, each restarting now, and the deposit mints at the launch price; otherwise neither
    /// moves.
    function testFuzz_theWriteDownCoversBothDrips(uint256 giftRao, uint256 loss, uint256 elapsed) public {
        emptyWithBothDrips(bound(giftRao, 2_000_000, 2e9));
        Schedule.wait(bound(elapsed, 0, 8 days));
        lose(bound(loss, 0, 1e18));
        uint256 cover = vaultLens.grossAssets();
        uint256 own = claimUnvested();
        uint256 unvested = own + adoptionUnvested();
        assertEq(vaultLens.unvestedRewards(), unvested, "the sum");
        uint256 claimAmount = vaultLens.vestingAmount();
        uint64 claimStart = vaultLens.vestingStart();
        uint256 dripAmount = vaultLens.adoptVestingAmount();
        uint64 dripStart = vaultLens.adoptVestingStart();

        depositDirect(bob, 1e18);
        if (unvested <= cover) {
            assertEq(vaultLens.vestingAmount(), claimAmount, "nothing written down");
            assertEq(vaultLens.vestingStart(), claimStart);
            assertEq(vaultLens.adoptVestingAmount(), dripAmount);
            assertEq(vaultLens.adoptVestingStart(), dripStart);
            return;
        }
        assertEq(vault.balanceOf(bob), 1e24, "the launch price");
        assertEq(vaultLens.unvestedRewards(), cover, "written down exactly");
        assertEq(vaultLens.adoptVestingStart(), vm.getBlockTimestamp(), "the adoption drip restarted");
        if (own <= cover) {
            assertEq(vaultLens.adoptVestingAmount(), cover - own, "the adoption drip, to what is beyond the claims");
            assertEq(vaultLens.vestingAmount(), claimAmount, "the claim schedule untouched");
            assertEq(vaultLens.vestingStart(), claimStart);
        } else {
            assertEq(vaultLens.adoptVestingAmount(), 0, "the adoption drip written off");
            assertEq(vaultLens.vestingAmount(), cover, "the claim schedule, to the gross");
            assertEq(vaultLens.vestingStart(), vm.getBlockTimestamp());
        }
    }

    /// Both drips running at an empty vault whose 10 TAO payout is queued (alice left through the door): `giftRao` of
    /// stake given and adopted, then 1 TAO of rewards claimed as liquid balance, both over the 7 days in force.
    function emptyWithPayoutAndBothDrips(uint256 giftRao) internal {
        emptyWithPayoutQueued();
        staking.donateStake(HK1, vaultLens.coldkey(), giftRao);
        vm.prank(keeper);
        vault.adoptStake();
        claim(1_000_000_000);
        assertEq(vaultLens.pendingPayouts(), 10e18);
        assertEq(vaultLens.adoptVestingAmount(), giftRao * 1e9);
        assertEq(vaultLens.vestingAmount(), 1e18);
        assertEq(vaultLens.grossAssets(), 10e18 + giftRao * 1e9 + 1e18);
    }

    /// The two drips' six fields as one word.
    function drips() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                vaultLens.vestingAmount(),
                vaultLens.vestingStart(),
                vaultLens.vestingPeriod(),
                vaultLens.adoptVestingAmount(),
                vaultLens.adoptVestingStart(),
                vaultLens.adoptVestingPeriod()
            )
        );
    }

    /// The delivery path's write-down covers both drips too (Revision 27; the review's M-3): as in
    /// test_theWriteDownTakesTheAdoptionDripFirst, but bob's 1 TAO comes through the front door. The batch mints at the
    /// launch price after the adoption drip is written down to what the gross holds beyond the claim schedule; the
    /// claim schedule is untouched.
    function test_aDeliveryWritesBothDripsDown() public {
        emptyWithBothDrips(500_000_000);
        uint256 t0 = vm.getBlockTimestamp();
        Schedule.wait(2 days);
        lose(0.6e18);
        uint256 cover = vaultLens.grossAssets();
        assertEq(cover, 0.9e18);
        uint256 own = claimUnvested();
        assertLe(own, cover, "the claim schedule alone fits");
        assertGt(vaultLens.unvestedRewards(), cover, "both do not");

        bytes32 key = nextDepositKey(bob, 1e18);
        vm.expectEmit(address(vault));
        emit Deposited(key, bob, 1e18, 1e24);
        depositVia(bob, 1e18);
        assertEq(vaultLens.pendingPayouts(), 0, "nothing bounced");
        assertEq(vaultLens.unvestedRewards(), cover, "written down exactly");
        assertEq(vaultLens.vestingAmount(), 1e18, "the claim schedule untouched");
        assertEq(vaultLens.vestingStart(), t0);
        assertEq(vaultLens.vestingPeriod(), 7 days);
        assertEq(vaultLens.adoptVestingAmount(), cover - own, "the adoption drip, to what is beyond the claim schedule");
        assertEq(vaultLens.adoptVestingStart(), vm.getBlockTimestamp(), "restarted there");
        assertEq(vaultLens.totalAssets(), 1e18);
        assertEq(assetsOf(bob), 1e18);
    }

    /// A payout shortfall past the tolerance with both drips running (the review's M-3): alice's 10 TAO payout is
    /// queued, 0.5 TAO adopted and 1 TAO claimed vest, and 2 TAO is lost, so the gross (9.5 TAO) is 0.5 TAO short of
    /// the payout. The write-down would take both drips to 0, which still leaves the payout short: a batch reverts
    /// VaultInsolvent whole and so does a direct deposit, each undoing both drips' write-downs (their six fields as
    /// they were). Once the reservation is whole, nothing is written down (the gross covers the payout and both
    /// drips exactly) and the same batch mints at the launch price.
    function test_aVaultInsolventRevertUndoesBothWriteDowns() public {
        emptyWithPayoutAndBothDrips(500_000_000);
        lose(2e18);
        assertEq(vaultLens.grossAssets(), 9.5e18);
        assertEq(vaultLens.unvestedRewards(), 1.5e18);
        bytes32 before = drips();

        uint64 id = nextBatchId + 1;
        bytes32 key = nextDepositKey(carol, 1e18);
        vm.expectRevert(VaultInsolvent.selector);
        deliver(BASE, frontDoor, id, entries1(carol, 1e18), noEntries());
        assertEq(drips(), before, "the batch's revert undoes both write-downs");
        assertFalse(vaultLens.processed(key), "the batch can be delivered later");
        vm.expectRevert(VaultInsolvent.selector);
        depositDirect(bob, 1e18);
        assertEq(drips(), before, "the direct deposit's revert undoes both too");
        assertEq(vault.totalSupply(), 0);
        assertEq(vaultLens.pendingPayouts(), 10e18);

        // the lost TAO comes back: 11.5 TAO covers the payout and both drips exactly
        vm.deal(address(vault), address(vault).balance + 2e18);
        deliver(BASE, frontDoor, id, entries1(carol, 1e18), noEntries());
        assertTrue(vaultLens.processed(key), "the same batch delivers");
        assertEq(vault.balanceOf(carol), 1e24, "the launch price");
        assertEq(drips(), before, "nothing written down");
    }

    /// With payouts queued the write-down's cover is the gross less them (the review's M-3): alice's 10 TAO payout,
    /// 0.5 TAO adopted and 1 TAO claimed; two days in, 0.6 TAO of the balance is lost, so the gross (10.9 TAO) holds
    /// 0.9 TAO beyond the payout, above the claim schedule's 5/7 TAO but below both drips. A deposit writes the
    /// adoption drip down to what that holds beyond the claim schedule, leaves the claim schedule and the payout as they
    /// were, and mints at the launch price.
    function test_theWriteDownCoversBothDripsBeyondTheQueuedPayouts() public {
        emptyWithPayoutAndBothDrips(500_000_000);
        uint256 t0 = vm.getBlockTimestamp();
        Schedule.wait(2 days);
        lose(0.6e18);
        uint256 cover = vaultLens.grossAssets() - vaultLens.pendingPayouts();
        assertEq(cover, 0.9e18, "the gross beyond the queued payout");
        uint256 own = claimUnvested();
        assertLe(own, cover, "the claim schedule alone fits");
        assertGt(vaultLens.unvestedRewards(), cover, "both do not");

        depositDirect(bob, 1e18);
        assertEq(vault.balanceOf(bob), 1e24, "the launch price");
        assertEq(vaultLens.pendingPayouts(), 10e18, "the payout untouched");
        assertEq(vaultLens.unvestedRewards(), cover, "written down exactly");
        assertEq(vaultLens.vestingAmount(), 1e18, "the claim schedule untouched");
        assertEq(vaultLens.vestingStart(), t0);
        assertEq(vaultLens.adoptVestingAmount(), cover - own, "the adoption drip, to what is beyond the claim schedule");
        assertEq(vaultLens.adoptVestingStart(), vm.getBlockTimestamp());
        assertEq(vaultLens.totalAssets(), 1e18);
        assertEq(assetsOf(bob), 1e18);
    }

    /// CascadeFormulas.underwater is the ruling's rule as written, `pending + unvested > gross && (unvested != 0 ||
    /// pending > gross + tolerance)`, for any values the rule itself can add without overflow; and it never
    /// overflows, at any values.
    function testFuzz_underwaterIsTheRule(uint256 gross, uint256 pending, uint256 unvested) public pure {
        assertEq(CascadeFormulas.underwater(type(uint256).max, type(uint256).max, type(uint256).max), true);
        assertEq(CascadeFormulas.underwater(0, type(uint256).max, 0), true);
        assertEq(CascadeFormulas.underwater(type(uint256).max, 0, type(uint256).max), false);
        gross = bound(gross, 0, 1e30);
        pending = bound(pending, 0, 1e30);
        unvested = bound(unvested, 0, 1e30);
        bool rule = pending + unvested > gross && (unvested != 0 || pending > gross + TOLERANCE);
        assertEq(CascadeFormulas.underwater(gross, pending, unvested), rule);
    }

    // ---- with nothing vesting: the tolerance, 1,000 rao of payout shortfall ----

    /// With nothing vesting, a payout shortfall of exactly 1,000 rao (here a loss) still takes a deposit at the launch
    /// price; the depositor absorbs it, within the underwater tolerance (I-4's mint over a hole).
    function test_aPayoutShortfallOfTheToleranceStillTakesDeposits() public {
        emptyWithPayoutShortfall(TOLERANCE);
        depositDirect(bob, 1e18);
        assertEq(vault.balanceOf(bob), 1e24);
        assertEq(vaultLens.totalAssets(), 1e18 - TOLERANCE);
        assertLt(vaultLens.price(), LAUNCH_PRICE);
        assertWithinTheUnderwaterTolerance();
        assertGe(assetsOf(bob) + TOLERANCE, 1e18);
    }

    /// One rao more (1,001 rao of payout shortfall) and the deposit is refused.
    function test_aPayoutShortfallPastTheToleranceRefusesDeposits() public {
        emptyWithPayoutShortfall(TOLERANCE + 1e9);
        vm.expectRevert(VaultInsolvent.selector);
        depositDirect(bob, 1e18);
    }

    /// Any payout shortfall from 0 to twice the tolerance, to the wei, with nothing vesting: a direct deposit
    /// mints up to the tolerance, within it, and is refused past it.
    function testFuzz_payoutToleranceAtAnEmptyVault(uint256 shortfall) public {
        shortfall = bound(shortfall, 0, 2 * TOLERANCE);
        emptyWithPayoutShortfall(shortfall);
        if (shortfall > TOLERANCE) vm.expectRevert(VaultInsolvent.selector);
        depositDirect(bob, 1e18);
        if (shortfall > TOLERANCE) {
            assertEq(vault.balanceOf(bob), 0);
        } else {
            assertEq(vault.balanceOf(bob), 1e24);
            assertWithinTheUnderwaterTolerance();
        }
    }

    /// The cut follows the same line: with nothing vesting before the claim, minted at a payout shortfall of
    /// exactly the tolerance (the treasury absorbs it, within the exception), skipped one rao past it.
    function test_cutFollowsTheTolerance() public {
        uint256 snap = vm.snapshotState();
        emptyWithPayoutShortfall(TOLERANCE);
        setCut(1_000);
        // A = 0, S = 0: the 2e16 cut at the launch price
        accrue(200_000_000);
        vm.expectEmit(address(vault));
        emit RewardCutMinted(treasury, 2e16, 2e22);
        claimAccrued();
        assertEq(vault.balanceOf(treasury), 2e22);
        // the 2e16 cut, 1e12 short
        assertEq(vaultLens.totalAssets(), 2e16 - TOLERANCE);
        assertWithinTheUnderwaterTolerance();

        vm.revertToState(snap);
        emptyWithPayoutShortfall(TOLERANCE + 1e9);
        setCut(1_000);
        claim(200_000_000);
        assertEq(vault.balanceOf(treasury), 0);
        assertEq(vaultLens.vestingAmount(), 2e17);
    }

    /// A batch follows the same line: its deposits minted at a payout shortfall of exactly the tolerance, the
    /// whole batch refused one rao past it (VaultInsolvent at a supply of 0, Task 25: the adapter parks it).
    function test_batchDepositFollowsTheTolerance() public {
        uint256 snap = vm.snapshotState();
        emptyWithPayoutShortfall(TOLERANCE);
        bytes32 key = nextDepositKey(bob, 1e18);
        vm.expectEmit(address(vault));
        emit Deposited(key, bob, 1e18, 1e24);
        depositVia(bob, 1e18);
        assertWithinTheUnderwaterTolerance();

        vm.revertToState(snap);
        emptyWithPayoutShortfall(TOLERANCE + 1e9);
        vm.expectRevert(VaultInsolvent.selector);
        depositVia(bob, 1e18);
        assertEq(vault.balanceOf(bob), 0);
    }

    /// At a supply of 0, underwater (alice's queued 10 TAO payout 1 TAO short, past the tolerance), a delivery
    /// reverts VaultInsolvent whole (Task 25's carry from Task 10c), whatever it carries: deposits and a redeem
    /// (alice has no shares left to burn), or a redeem alone. Nothing is written: no replay record (so the adapter's
    /// park can deliver the same message later), no queued bounce, no write-down of the schedule (1 TAO vesting).
    /// Once the reservation is whole the same messages deliver: the deposits mint at the launch price, and the
    /// redeem of a holder with no shares is skipped, as before.
    function test_aSupply0UnderwaterDeliveryRevertsWhole() public {
        emptyWithPayoutQueued();
        claim(1_000_000_000);
        lose(2e18);
        uint256 t = vm.getBlockTimestamp();
        uint256 gross = vaultLens.grossAssets();
        uint64 depositsId = nextBatchId + 1;
        uint64 redeemOnlyId = nextBatchId + 2;
        CascadeMessages.Entry[] memory d = new CascadeMessages.Entry[](2);
        d[0] = CascadeMessages.Entry(bob, 1e18);
        d[1] = CascadeMessages.Entry(carol, 2e18);
        bytes32 depositsKey = keyOf(depositsId, d, entries1(alice, 1e24));
        bytes32 redeemOnlyKey = keyOf(redeemOnlyId, noEntries(), entries1(alice, 1e24));

        vm.expectRevert(VaultInsolvent.selector);
        deliver(BASE, frontDoor, depositsId, d, entries1(alice, 1e24));
        vm.expectRevert(VaultInsolvent.selector);
        deliver(BASE, frontDoor, redeemOnlyId, noEntries(), entries1(alice, 1e24));

        assertFalse(vaultLens.processed(depositsKey));
        assertFalse(vaultLens.processed(redeemOnlyKey));
        assertEq(vault.totalSupply(), 0);
        assertEq(vaultLens.pendingPayouts(), 10e18, "no bounce queued");
        assertEq(vaultLens.grossAssets(), gross, "the batch's TAO is not the vault's");
        assertEq(vaultLens.vestingAmount(), 1e18, "no write-down");
        assertEq(vaultLens.vestingStart(), t);

        // the lost TAO comes back: not underwater, the same messages deliver
        vm.deal(address(vault), address(vault).balance + 2e18);
        deliver(BASE, frontDoor, depositsId, d, entries1(alice, 1e24));
        deliver(BASE, frontDoor, redeemOnlyId, noEntries(), entries1(alice, 1e24));
        assertTrue(vaultLens.processed(depositsKey));
        assertTrue(vaultLens.processed(redeemOnlyKey));
        assertEq(vault.balanceOf(bob), 1e24);
        assertEq(vault.balanceOf(carol), 2e24);
        assertEq(vaultLens.pendingPayouts(), 10e18);
    }

    function keyOf(uint64 id, CascadeMessages.Entry[] memory d, CascadeMessages.Entry[] memory r)
        internal
        view
        returns (bytes32)
    {
        return vaultLens.batchKey(BASE, frontDoor, CascadeMessages.encodeBatch(id, d, r));
    }

    // ---- with shares outstanding: unchanged ----

    /// alice holds 1e25 shares (10 TAO, liquid). `assets` is what is left of the vault's assets after a loss.
    function aliceThenLoss(uint256 assets) internal {
        depositDirect(alice, 10e18);
        vm.deal(address(vault), ED + assets);
        assertEq(vaultLens.totalAssets(), assets);
    }

    /// alice holds 1e25 shares, 1 TAO of rewards vests, then all of her 10 TAO and 1 rao of the rewards are
    /// lost: 1 rao underwater, inside the tolerance, and the assets read 0.
    function aliceThenUnderwaterInsideTheTolerance() internal {
        depositDirect(alice, 10e18);
        claim(1_000_000_000);
        vm.deal(address(vault), ED + 1e18 - 1e9);
        assertEq(vaultLens.unvestedRewards(), 1e18);
        assertEq(vaultLens.totalAssets(), 0);
    }

    /// With shares outstanding the half-launch line decides a direct deposit, as before: exactly at the line
    /// (5e18 against 1e25 shares) it mints at the vault's price, one wei below it reverts, and underwater by
    /// less than the tolerance (assets 0) it reverts too: the tolerance loosens nothing here.
    function test_withSharesTheLineStillDecidesDirectDeposits() public {
        uint256 snap = vm.snapshotState();
        aliceThenLoss(5e18);
        depositDirect(bob, 1e18);
        assertEq(vault.balanceOf(bob), CascadeMath.sharesForDeposit(1e18, 5e18, 1e25));

        vm.revertToState(snap);
        aliceThenLoss(5e18 - 1);
        vm.expectRevert(VaultInsolvent.selector);
        depositDirect(bob, 1e18);

        vm.revertToState(snap);
        aliceThenUnderwaterInsideTheTolerance();
        vm.expectRevert(VaultInsolvent.selector);
        depositDirect(bob, 1e18);
    }

    /// With shares outstanding the line decides the cut, as before: minted at the pre-claim price exactly at
    /// the line, skipped one wei below it, and skipped underwater inside the tolerance.
    function test_withSharesTheLineStillDecidesTheCut() public {
        uint256 snap = vm.snapshotState();
        aliceThenLoss(5e18);
        setCut(1_000);
        uint256 shares = CascadeMath.sharesForDeposit(1e17, 5e18, 1e25);
        accrue(1_000_000_000);
        vm.expectEmit(address(vault));
        emit RewardCutMinted(treasury, 1e17, shares);
        claimAccrued();
        assertEq(vault.balanceOf(treasury), shares);

        vm.revertToState(snap);
        aliceThenLoss(5e18 - 1);
        setCut(1_000);
        claim(1_000_000_000);
        assertEq(vault.balanceOf(treasury), 0);
        assertEq(vaultLens.vestingAmount(), 1e18);

        vm.revertToState(snap);
        aliceThenUnderwaterInsideTheTolerance();
        setCut(1_000);
        claim(1_000_000_000);
        assertEq(vault.balanceOf(treasury), 0);
        assertEq(vault.totalSupply(), 1e25);
    }

    /// With shares outstanding the schedule is the holders': no mint writes it down, ever (Task 15). Underwater (alice
    /// holds 1e25 shares, her 10 TAO and 1 rao of the vesting rewards lost) the direct deposit reverts and a batch's
    /// deposits bounce, the schedule untouched; above the line, with a reward vesting, a deposit mints and writes
    /// nothing down either.
    function test_noWriteDownWithSharesOutstanding() public {
        uint256 snap = vm.snapshotState();
        aliceThenUnderwaterInsideTheTolerance();
        uint256 t = vm.getBlockTimestamp();
        vm.expectRevert(VaultInsolvent.selector);
        depositDirect(bob, 1e18);
        bytes32 key = nextDepositKey(bob, 1e18);
        vm.expectEmit(address(vault));
        emit DepositBounced(key, bob, 1e18, BounceReason.Insolvent);
        depositVia(bob, 1e18);
        assertEq(vaultLens.vestingAmount(), 1e18);
        assertEq(vaultLens.vestingStart(), t);
        assertEq(vaultLens.vestingPeriod(), 7 days);
        assertEq(vaultLens.unvestedRewards(), 1e18);

        vm.revertToState(snap);
        depositDirect(alice, 10e18);
        claim(1_000_000_000);
        t = vm.getBlockTimestamp();
        depositDirect(bob, 1e18);
        depositVia(carol, 1e18);
        assertEq(vaultLens.vestingAmount(), 1e18);
        assertEq(vaultLens.vestingStart(), t);
        assertEq(vaultLens.unvestedRewards(), 1e18);
        assertGt(vault.balanceOf(bob), 0);
        assertGt(vault.balanceOf(carol), 0);
    }

    /// With shares outstanding the line decides a batch's deposits, as before: minted at the line, bounced one
    /// wei below it, and bounced underwater inside the tolerance.
    function test_withSharesTheLineStillDecidesBatchDeposits() public {
        uint256 snap = vm.snapshotState();
        aliceThenLoss(5e18);
        bytes32 key = nextDepositKey(bob, 1e18);
        vm.expectEmit(address(vault));
        emit Deposited(key, bob, 1e18, CascadeMath.sharesForDeposit(1e18, 5e18, 1e25));
        depositVia(bob, 1e18);

        vm.revertToState(snap);
        aliceThenLoss(5e18 - 1);
        key = nextDepositKey(bob, 1e18);
        vm.expectEmit(address(vault));
        emit DepositBounced(key, bob, 1e18, BounceReason.Insolvent);
        depositVia(bob, 1e18);

        vm.revertToState(snap);
        aliceThenUnderwaterInsideTheTolerance();
        key = nextDepositKey(bob, 1e18);
        vm.expectEmit(address(vault));
        emit DepositBounced(key, bob, 1e18, BounceReason.Insolvent);
        depositVia(bob, 1e18);
        assertEq(vault.balanceOf(bob), 0);
    }
}
