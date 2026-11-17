// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeMath} from "../../src/libraries/CascadeMath.sol";
import {CascadeFormulas} from "../../src/libraries/CascadeFormulas.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {MISSING_TOLERANCE_BPS, MIN_MISSING_TOLERANCE_RAO} from "../../src/CascadeConstants.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {VaultInternals} from "../utils/VaultInternals.sol";
import {Schedule} from "../governance/Schedule.sol";
import {Delay, Item, Kind} from "../../src/CascadeTypes.sol";
import {
    AdoptTooSoon,
    BelowMinAdoption,
    ExitsNotOpen,
    InsufficientGas,
    NoProposal,
    NotBridge,
    NotEligible,
    NotKeeper,
    NotReady,
    NotScheduled,
    StakeMissing,
    UnknownPeer,
    WriteOffTooLarge
} from "../../src/CascadeErrors.sol";
import {
    Cancelled,
    Redeemed,
    RedeemedDirect,
    RewardCutMinted,
    RewardsClaimed,
    Scheduled,
    StakeAdopted,
    StakeWrittenOff
} from "../../src/CascadeEvents.sol";

/// The stake ledger (spec §3.1, §3.10.12, §3.10.14; Task 12): the vault books, in rao, only what it measures on
/// the stake side (stakeIdle's added stake, a claim's rise of the visible stake, a removal's fall of the
/// position), floored at 0, and prices its stake at min(visible, booked). So a swap that moves stake off the set
/// lowers the price at once and shows as missing stake, while a gift on a listed hotkey moves nothing (I-3) until
/// it is unstaked into balance; the ramp is fed only by stakeIdle; the outflow base never exceeds min(visible,
/// booked) less what is still ramping (I-5). The views are the vault lens's (bookedStake() in rao, ruling A19);
/// the vault's own stakeMissing(), which Task 13's guards read, through VaultInternals.
/// The guard (spec §3.1, I-1; Task 13): while stakeMissing(), every mint and every burn the holder did not consent
/// to closes. depositDirect and onBridgeMessage revert StakeMissing (the adapter holds the batch), redeemDirect
/// needs its acceptMissing flag and then pays the floor price, and claimRewards skips the cut; stakeIdle and
/// processPayouts price no share, and cancelPayoutBatch never re-mints more shares than were burned, so they run as
/// before.
/// Where the ledger meets reality (spec §3.1, §3.10.2; Task 16): adoptStake books a surplus (a gift on a listed
/// hotkey, or stake that came back after a write-off) and vests it on its own drip (Revision 27), no cut, at most once
/// a day, by the keeper or, after KEEPER_FALLBACK, anyone; writeOffMissingStake, the owner's 7-day Registry item the
/// guardian may cancel, lowers the booked stake by what is missing less what sits unlisted on the vault's coldkey
/// (M-1), never moving the price (I-4), and reopens minting.
contract VaultLedgerTest is VaultTestBase {
    uint256 constant RAO = 1e9;
    address treasury = makeAddr("treasury");
    address stranger = makeAddr("stranger");

    /// The fixture's vault is a VaultInternals, so a test can read the ramp and the vault's own stakeMissing().
    function deployVault(CascadeVault.Params memory p) internal override returns (CascadeVault) {
        return new VaultInternals(p);
    }

    /// The fixture's values with a 10% reward cut to the treasury, and room for a 10_000 TAO vault: up to 2M
    /// TAO of assets and 5_000 TAO an entry (raising either is a scheduled loosening, Task 11).
    function vaultParams() internal view override returns (CascadeVault.Params memory p) {
        p = super.vaultParams();
        p.treasury = treasury;
        p.rewardCutBps = 1_000;
        p.maxTotalAssets = 2_000_000e18;
        p.maxEntryValue = 5_000e18;
        p.maxMessageValue = 5_000e18;
    }

    /// Exact stake reads, but where a test turns the one-rao-short read of a fresh position back on.
    function setUp() public override {
        super.setUp();
        staking.setOneRaoShort(false);
    }

    // ---- helpers ----

    function internals() internal view returns (VaultInternals) {
        return VaultInternals(payable(address(vault)));
    }

    function coldkey() internal view returns (bytes32) {
        return vaultLens.coldkey();
    }

    function booked() internal view returns (uint256) {
        return vaultLens.bookedStake();
    }

    function visible() internal view returns (uint256) {
        return vaultLens.visibleStakeRao();
    }

    function ramping() internal view returns (uint256) {
        return internals().exposed_rampingStake();
    }

    function stakeOf(bytes32 h) internal view returns (uint256) {
        return staking.getStake(h, coldkey(), 0);
    }

    function stake() internal {
        vm.prank(keeper);
        vault.stakeIdle();
    }

    function claim(bytes32 h) internal {
        vm.prank(keeper);
        vault.claimRewards{gas: 60_000_000}(h);
    }

    function redeemAll(address user) internal returns (uint256 got) {
        uint256 before = user.balance;
        uint256 shares = vault.balanceOf(user);
        vm.prank(user);
        vault.redeemDirect(shares, false);
        got = user.balance - before;
    }

    /// `user`'s direct redeem of `shares`, with or without the consent to a missing-stake price; what it paid.
    function redeem(address user, uint256 shares, bool acceptMissing) internal returns (uint256 got) {
        uint256 before = user.balance;
        vm.prank(user);
        vault.redeemDirect(shares, acceptMissing);
        got = user.balance - before;
    }

    /// What a direct redeem of `shares` pays now: their value at the vault's price, floored to the rao.
    function floorValue(uint256 shares) internal view returns (uint256 v) {
        v = CascadeMath.assetsForRedeem(shares, vaultLens.totalAssets(), vault.totalSupply());
        v -= v % RAO;
    }

    function redeemableBy(address user) internal view returns (uint256) {
        return CascadeMath.assetsForRedeem(vault.balanceOf(user), vaultLens.totalAssets(), vault.totalSupply());
    }

    /// A launch-door batch and the sum of its deposits, which its delivery carries as its value.
    function batch(uint64 id, CascadeMessages.Entry[] memory deposits, CascadeMessages.Entry[] memory redeems)
        internal
        pure
        returns (bytes memory message, uint256 sum)
    {
        message = CascadeMessages.encodeBatch(id, deposits, redeems);
        for (uint256 i; i < deposits.length; ++i) {
            sum += deposits[i].amount;
        }
    }

    /// `message` from `sender`, delivered by `caller` (the bridge, or not), expected to revert `err`.
    function refuse(address caller, address sender, bytes memory message, uint256 sum, bytes4 err) internal {
        vm.deal(caller, caller.balance + sum);
        vm.prank(caller);
        vm.expectRevert(err);
        vault.onBridgeMessage{value: sum}(BASE, sender, message, sum);
    }

    function deliverMessage(bytes memory message, uint256 sum) internal {
        vm.deal(address(bridge), address(bridge).balance + sum);
        vm.prank(address(bridge));
        vault.onBridgeMessage{value: sum}(BASE, frontDoor, message, sum);
    }

    /// `user`'s front-door redeem of `shares` in its own batch, burned whole: its key and its one-entry payout list,
    /// as the keeper rebuilds it from the Redeemed event.
    function redeemVia(address user, uint256 shares)
        internal
        returns (bytes32 key, CascadeMessages.Payout[] memory list)
    {
        vm.recordLogs();
        key = deliver(BASE, frontDoor, ++nextBatchId, noEntries(), entries1(user, shares));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        list = new CascadeMessages.Payout[](1);
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == Redeemed.selector) {
                (uint256 burned, uint256 assets) = abi.decode(logs[i].data, (uint256, uint256));
                list[0] = CascadeMessages.Payout(user, burned, assets);
            }
        }
        assertEq(list[0].shares, shares, "burned whole");
    }

    /// `rao` of the vault's root stake moved from `from` to the unlisted HK5, exactly (the vault's own move, as a
    /// swap of part of a position would leave it).
    function moveAway(bytes32 from, uint256 rao) internal {
        vm.prank(address(vault));
        staking.moveStake(from, HK5, 0, 0, rao);
    }

    /// Both readings of stakeMissing: the lens's view and the vault's own (Task 13's guards), which must agree.
    function missing() internal view returns (bool m) {
        m = vaultLens.stakeMissing();
        assertEq(internals().exposed_stakeMissing(), m, "the vault and its lens disagree");
    }

    /// The allowance base the vault must compute in a delivery (I-5): min(visible, booked) in wei, less what is
    /// still ramping in, linearly over STAKE_RAMP (1 day) from the last stake.
    function expectedBase() internal view returns (uint256) {
        uint256 elapsed = vm.getBlockTimestamp() - vaultLens.lastStakeAt();
        uint256 unspent = elapsed >= 1 days ? 0 : ramping() * (1 days - elapsed) / 1 days;
        return CascadeFormulas.sub0(Math.min(visible(), booked()) * RAO, unspent);
    }

    /// What one front-door redeem of all of `user`'s shares burns now, the state left unchanged: the burn window
    /// is empty, so it is the day's whole allowance (or less, when the user holds less).
    function burnNow(address user) internal returns (uint256 out) {
        uint256 snap = vm.snapshotState();
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

    /// alice's 100 TAO, deposited directly and staked: 100 TAO booked, visible and ramping.
    function hundredStaked() internal {
        depositDirect(alice, 100e18);
        stake();
        assertEq(booked(), 100e9);
        assertEq(visible(), 100e9);
        assertEq(vaultLens.totalAssets(), 100e18);
    }

    // ---- the price reads min(visible, booked) ----

    /// A validator's swap moves 30% of the position to a hotkey the vault does not list: the visible stake falls,
    /// the ledger keeps what the vault staked, and totalAssets falls by the 30 TAO at once (min(visible, booked)).
    function test_swapLowersThePriceAtOnce() public {
        hundredStaked();
        uint256 supply = vault.totalSupply();
        staking.swapHotkey(HK1, HK5, coldkey(), 3_000);

        assertEq(visible(), 70e9);
        assertEq(booked(), 100e9, "the ledger holds what the vault staked");
        assertEq(vaultLens.missingStakeRao(), 30e9);
        assertEq(vaultLens.surplusStakeRao(), 0);
        assertEq(vaultLens.grossAssets(), 70e18);
        assertEq(vaultLens.totalAssets(), 70e18, "lower at once, by the swapped 30 TAO");
        assertEq(internals().exposed_totalAssets(), 70e18, "the vault prices it so too");
        assertEq(vaultLens.price(), CascadeMath.price(70e18, supply));
        assertTrue(missing(), "30 TAO is past the 0.1 TAO tolerance");
    }

    /// I-3: a gift on a listed hotkey, the stake hotkey or another, moves neither the price nor the ledger: the
    /// visible stake rises above the booked, and the surplus waits (for adoptStake, Task 16). A later stake
    /// books what it adds, never the gift.
    function test_giftOnAListedHotkeyMovesNothing() public {
        hundredStaked();
        vm.prank(keeper);
        vault.addHotkey(HK2);
        uint256 price = vaultLens.price();

        staking.donateStake(HK1, coldkey(), 50e9);
        staking.donateStake(HK2, coldkey(), 25e9);
        assertEq(visible(), 175e9);
        assertEq(booked(), 100e9, "a gift is not booked");
        assertEq(vaultLens.surplusStakeRao(), 75e9);
        assertEq(vaultLens.missingStakeRao(), 0);
        assertFalse(missing());
        assertEq(vaultLens.grossAssets(), 100e18);
        assertEq(vaultLens.totalAssets(), 100e18);
        assertEq(vaultLens.price(), price, "the price does not move");
        assertEq(internals().exposed_totalAssets(), 100e18, "nor does the vault's own reading");

        depositDirect(bob, 10e18);
        stake();
        assertEq(booked(), 110e9, "a stake books what it adds, never the gift");
        assertEq(vaultLens.surplusStakeRao(), 75e9);
        assertEq(vaultLens.totalAssets(), 110e18);
        assertEq(vaultLens.price(), price);
    }

    /// An alpha gift (stake on another subnet, here 7, to the vault's coldkey on a listed hotkey and on an
    /// unlisted one) changes nothing: the vault prices, books and counts as unlisted only root stake (spec §3.1
    /// Tests; ruling B16c).
    function test_anAlphaGiftChangesNothing() public {
        hundredStaked();
        // bob's 10 TAO, left liquid: the stake below books it while stake is missing (stakeIdle is unaffected)
        depositDirect(bob, 10e18);
        staking.swapHotkey(HK1, HK5, coldkey(), 1_000);
        uint256 price = vaultLens.price();
        uint256 gross = vaultLens.grossAssets();
        uint256 missingRao = vaultLens.missingStakeRao();
        bool isMissing = missing();

        staking.donateStakeOnSubnet(HK1, coldkey(), 7, 1_000e9);
        staking.donateStakeOnSubnet(HK5, coldkey(), 7, 1_000e9);
        assertEq(staking.getStake(HK1, coldkey(), 7), 1_000e9, "the alpha is the vault's");
        assertEq(visible(), 90e9);
        assertEq(booked(), 100e9);
        assertEq(vaultLens.unlistedStakeRao(), 10e9);
        assertEq(vaultLens.surplusStakeRao(), 0);
        assertEq(vaultLens.missingStakeRao(), missingRao);
        assertEq(missing(), isMissing);
        assertEq(vaultLens.grossAssets(), gross);
        assertEq(vaultLens.price(), price);
        // a stake books only the root stake it adds
        stake();
        assertEq(booked(), 110e9);
    }

    // ---- claims book the visible stake's rise ----

    /// A claim paid as liquid balance books nothing stake-side; the balance delta vests, less the 10% cut, which is
    /// computed on the whole position's delta as before.
    function test_claimToBalanceBooksNothingStakeSide() public {
        hundredStaked();
        staking.setClaimToBalance(true);
        staking.setUnclaimed(coldkey(), HK1, 2e9);
        uint256 supply = vault.totalSupply();
        uint256 cutShares = CascadeMath.sharesForDeposit(0.2e18, 100e18, supply);

        vm.expectEmit(address(vault));
        emit RewardCutMinted(treasury, 0.2e18, cutShares);
        vm.expectEmit(address(vault));
        emit RewardsClaimed(HK1, 2e9);
        claim(HK1);

        assertEq(booked(), 100e9, "nothing stake-side");
        assertEq(visible(), 100e9);
        assertEq(address(vault).balance, ED + 2e18);
        assertEq(vaultLens.grossAssets(), 102e18);
        assertEq(vaultLens.vestingAmount(), 1.8e18, "the balance delta vests, less the cut");
        assertEq(vault.balanceOf(treasury), cutShares);
    }

    /// A claim paid as stake books exactly the visible stake's rise, not a gift already sitting on the hotkey; the
    /// cut is the whole delta's.
    function test_claimOnStakeBooksTheStakeDelta() public {
        hundredStaked();
        staking.donateStake(HK1, coldkey(), 5e9);
        staking.setUnclaimed(coldkey(), HK1, 2e9);
        uint256 cutShares = CascadeMath.sharesForDeposit(0.2e18, 100e18, vault.totalSupply());

        vm.expectEmit(address(vault));
        emit RewardCutMinted(treasury, 0.2e18, cutShares);
        vm.expectEmit(address(vault));
        emit RewardsClaimed(HK1, 2e9);
        claim(HK1);

        assertEq(visible(), 107e9);
        assertEq(booked(), 102e9, "the claim's 2 TAO, not the 5 TAO gift");
        assertEq(vaultLens.surplusStakeRao(), 5e9);
        assertEq(address(vault).balance, ED);
        assertEq(vaultLens.grossAssets(), 102e18);
        assertEq(vaultLens.vestingAmount(), 1.8e18);
    }

    /// The visible stake falls during a claim (spec §3.10.14): the claim books 0 rather than reverting, and the fall
    /// shows as missing stake. Paid as balance, more than the fall, the whole position's rise still vests while the
    /// stake side books 0. (The cut is set to 0 here: Task 13 skips it while stake is missing.)
    function test_claimWithAFallBooksZeroAndNeverReverts() public {
        hundredStaked();
        vm.prank(owner);
        vault.setRewardCut(treasury, 0);

        staking.setUnclaimed(coldkey(), HK1, 1e9);
        staking.setClaimFallRao(3e9);
        vm.expectEmit(address(vault));
        emit RewardsClaimed(HK1, 0);
        claim(HK1);
        assertEq(visible(), 98e9);
        assertEq(booked(), 100e9, "a fall books nothing");
        assertEq(vaultLens.vestingAmount(), 0, "nothing rose, nothing vests");
        assertEq(vaultLens.missingStakeRao(), 2e9);
        assertTrue(missing(), "the fall shows as missing stake");
        assertEq(vaultLens.totalAssets(), 98e18);

        // paid as 5 TAO of balance while the stake falls 3 TAO more: the position rose 2 TAO
        staking.setClaimToBalance(true);
        staking.setUnclaimed(coldkey(), HK1, 5e9);
        claim(HK1);
        assertEq(visible(), 95e9);
        assertEq(booked(), 100e9, "still nothing stake-side");
        assertEq(vaultLens.vestingAmount(), 2e18, "the whole position's rise vests");
        assertEq(vaultLens.missingStakeRao(), 5e9);
    }

    // ---- removals debit the stake that left, floored ----

    /// M-2: a gift on the stake hotkey makes alice's full exit take more than the ledger holds (the remainder,
    /// 0.01 TAO, is under the chain's minimum, so the walk takes the whole position). The ledger floors at 0, no
    /// underflow, and the excess arrives as liquid balance, which is priced. alice is paid her 10 TAO, the gift
    /// never having been priced.
    function test_fullRemovalAfterAGiftFloorsTheLedger() public {
        depositDirect(alice, 10e18);
        stake();
        staking.donateStake(HK1, coldkey(), 10_000_000);
        assertEq(vaultLens.totalAssets(), 10e18, "the gift is not priced");

        uint256 got = redeemAll(alice);
        assertEq(got, 10e18);
        assertEq(stakeOf(HK1), 0, "the whole position");
        assertEq(booked(), 0, "floored at 0");
        assertEq(visible(), 0);
        assertEq(address(vault).balance, ED + 0.01e18);
        assertEq(vaultLens.grossAssets(), 0.01e18, "the excess, priced as balance");
    }

    /// A gift on the stake hotkey, then every holder's full exit: no exit reverts or underflows, the ledger ends at
    /// 0, no holder is paid any of the gift, and what is left is the gift, priced as liquid where a removal took it
    /// and otherwise still surplus stake. A small gift (under the chain's minimum remainder) and a large one.
    function test_giftThenEveryHolderExits() public {
        uint256 snap = vm.snapshotState();
        giftThenEveryHolderExits(10_000_000);
        assertEq(vaultLens.grossAssets(), 0.01e18, "taken by the last full removal, priced as liquid");
        assertEq(vaultLens.surplusStakeRao(), 0);
        vm.revertToState(snap);
        giftThenEveryHolderExits(5e9);
        assertEq(vaultLens.grossAssets(), 0);
        assertEq(vaultLens.surplusStakeRao(), 5e9, "left staked, still unpriced");
    }

    /// Random gifts against full exits (spec §3.1 Fuzz).
    function testFuzz_giftsAgainstFullExits(uint256 giftRao) public {
        giftThenEveryHolderExits(bound(giftRao, 1, 100e9));
    }

    function giftThenEveryHolderExits(uint256 giftRao) internal {
        depositDirect(alice, 10e18);
        depositDirect(bob, 10e18);
        stake();
        staking.donateStake(HK1, coldkey(), giftRao);
        uint256 price = vaultLens.price();

        uint256 a = redeemAll(alice);
        assertLe(a, 10e18, "alice is paid none of the gift");
        assertGe(a, 10e18 - RAO);
        assertGe(vaultLens.price(), price, "bob is not diluted");
        uint256 b = redeemAll(bob);
        assertLe(b, 10e18, "bob is paid none of the gift");
        assertGe(b, 10e18 - RAO);

        assertEq(vault.totalSupply(), 0);
        assertEq(booked(), 0);
        // conservation: what is left is everything put in, less what was paid
        assertEq(vaultLens.grossAssets() + vaultLens.surplusStakeRao() * RAO, 20e18 + giftRao * RAO - a - b);
    }

    /// alice's 70 TAO staked on HK1, then (the stake hotkey moved to HK2, a scheduled item) bob's 30 on HK2: two
    /// listed positions, the walk's first (the stake hotkey, HK2) too small for alice's whole exit.
    function twoPositions(bool viaFrontDoor) internal {
        if (viaFrontDoor) depositVia(alice, 70e18);
        else depositDirect(alice, 70e18);
        stake();
        vm.prank(owner);
        vault.addHotkey(HK2);
        Schedule.run(vault, owner, abi.encodeCall(vault.setStakeHotkey, (HK2)));
        if (viaFrontDoor) depositVia(bob, 30e18);
        else depositDirect(bob, 30e18);
        stake();
        assertEq(stakeOf(HK1), 70e9);
        assertEq(stakeOf(HK2), 30e9);
        assertEq(booked(), 100e9);
    }

    /// A walk across two positions books every removal's debit, not only the last: alice's direct exit takes HK2's
    /// 30 TAO whole, then 40 of HK1's 70, and the ledger falls by both, to exactly the 30 TAO still visible; bob's
    /// price does not move.
    function test_aRedeemWalkAcrossTwoPositionsBooksEveryRemoval() public {
        twoPositions(false);
        uint256 price = vaultLens.price();
        assertEq(redeemAll(alice), 70e18);
        assertEq(stakeOf(HK2), 0, "the first position, whole");
        assertEq(stakeOf(HK1), 30e9, "then 40 of the second");
        assertEq(visible(), 30e9);
        assertEq(booked(), visible(), "both removals booked");
        assertFalse(missing());
        assertEq(vaultLens.price(), price, "bob's price unchanged");
        assertEq(internals().exposed_totalAssets(), 30e18);
    }

    /// The same across the payout walk (processPayouts, the vault's own walk between the payout engine's halves):
    /// alice's 70 TAO front-door redeem, paid a day later, takes HK2 whole and 40 TAO of HK1, and the ledger falls
    /// by both removals.
    function test_aPayoutWalkAcrossTwoPositionsBooksEveryRemoval() public {
        twoPositions(true);
        uint256 price = vaultLens.price();
        vm.recordLogs();
        bytes32 key = deliver(BASE, frontDoor, ++nextBatchId, noEntries(), entries1(alice, vault.balanceOf(alice)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        CascadeMessages.Payout[] memory list = new CascadeMessages.Payout[](1);
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == Redeemed.selector) {
                (uint256 shares, uint256 assets) = abi.decode(logs[i].data, (uint256, uint256));
                list[0] = CascadeMessages.Payout(alice, shares, assets);
            }
        }
        assertEq(list[0].assets, 70e18, "her whole holding burned");
        Schedule.warpTo(vm.getBlockTimestamp() + 24 hours);
        vault.processPayouts(key, list, 0);
        assertEq(vaultLens.pendingPayouts(), 0, "paid");
        assertEq(stakeOf(HK2), 0, "the first position, whole");
        // the payout walk asks the 1_000-rao shortfall tolerance on top (Task 19), which stays idle
        assertEq(stakeOf(HK1), 30e9 - 1_000, "then 40 of the second, and the tolerance");
        assertEq(booked(), visible(), "both removals booked");
        assertFalse(missing());
        assertEq(vaultLens.price(), price, "bob's price unchanged");
    }

    /// Each removal debits the ledger by the stake that left the position (before less after), and the ramp by
    /// what the balance received, as in v3.1: with a chain fee on every removal the receipt is short of the
    /// stake, and the ledger still matches the visible stake. Both removal paths: the walk (alice's exit, the
    /// margin covering the fee) and removeHotkey's direct removal of a position under the chain's minimum.
    function test_removalsDebitTheStakeThatLeft() public {
        depositDirect(alice, 10e18);
        depositDirect(bob, 10e18);
        stake();
        assertEq(ramping(), 20e18);
        vm.startPrank(owner);
        vault.setUnstakeMarginRao(1_000);
        vault.addHotkey(HK2);
        vm.stopPrank();
        staking.setRemoveFeeRao(1_000);

        // the walk: 10 TAO and the 1_000 rao margin leave HK1; the balance receives 10 TAO
        redeemAll(alice);
        assertEq(stakeOf(HK1), 10e9 - 1_000);
        assertEq(booked(), 10e9 - 1_000, "the stake that left");
        assertEq(visible(), booked());
        assertEq(ramping(), 10e18, "what the balance received");

        // the direct removal: 1_500_000 rao moved within the set onto HK2, then HK2 removed by the owner
        vm.prank(address(vault));
        staking.moveStake(HK1, HK2, 0, 0, 1_500_000);
        vm.prank(owner);
        vault.removeHotkey(HK2, false);
        assertEq(booked(), 10e9 - 1_000 - 1_500_000, "the whole position left");
        assertEq(visible(), booked());
        assertEq(ramping(), 10e18 - 1_499_000 * RAO, "its receipt, less the fee");
        assertFalse(missing());
    }

    // ---- the guard's tolerance ----

    /// The one-rao-short read of a fresh position (the runtime's, setOneRaoShort): stakeIdle books what it measured,
    /// so the ledger never sits above the visible stake, and the guard never trips. The gross falls by that rao
    /// (I-4's exception). Also on a second fresh position, after the stake hotkey moves to an empty HK2.
    function test_oneRaoShortFreshReadNeverTripsTheGuard() public {
        staking.setOneRaoShort(true);
        depositDirect(alice, 10e18);
        stake();
        assertEq(visible(), 10e9 - 1);
        assertEq(booked(), 10e9 - 1, "what it measured");
        assertEq(ramping(), (10e9 - 1) * RAO, "it ramps in what it measured too");
        assertEq(vaultLens.missingStakeRao(), 0);
        assertFalse(missing());
        assertEq(vaultLens.grossAssets(), 10e18 - RAO, "one rao short");

        vm.prank(owner);
        vault.addHotkey(HK2);
        Schedule.run(vault, owner, abi.encodeCall(vault.setStakeHotkey, (HK2)));
        depositDirect(bob, 10e18);
        stake();
        assertEq(stakeOf(HK2), 10e9 - 1);
        assertEq(booked(), 20e9 - 2);
        assertEq(visible(), booked());
        assertFalse(missing());
    }

    /// stakeMissing() is missing > max(booked * 0.1%, 0.001 TAO): at 100 TAO booked the tolerance is 0.1 TAO, at
    /// 0.5 TAO it is the 0.001 TAO minimum. Missing exactly the tolerance is not missing; one rao more is.
    function test_toleranceEdge() public {
        hundredStaked();
        moveAway(HK1, 100e9 / 1_000);
        assertEq(vaultLens.missingStakeRao(), 1e8);
        assertFalse(missing(), "exactly booked / 1_000");
        moveAway(HK1, 1);
        assertTrue(missing(), "one rao more");
    }

    function test_toleranceEdgeAtTheMinimum() public {
        depositDirect(alice, 0.5e18);
        stake();
        assertEq(booked(), 5e8);
        moveAway(HK1, 1_000_000);
        assertEq(vaultLens.missingStakeRao(), 1_000_000);
        assertFalse(missing(), "exactly 1_000_000 rao, above booked / 1_000");
        moveAway(HK1, 1);
        assertTrue(missing(), "one rao more");
    }

    /// The tolerance's formula, the one the vault, L4 and the lens share, against its definition: the larger of 0.1% of
    /// the booked stake less the queued payouts (in rao, floored at 0; R6 E-fix) and 0.001 TAO.
    function testFuzz_toleranceIsTheLargerOfTheTwo(uint256 visibleRao, uint256 bookedRao, uint256 pendingWei)
        public
        pure
    {
        visibleRao = bound(visibleRao, 0, 1e18);
        bookedRao = bound(bookedRao, 0, 1e18);
        pendingWei = bound(pendingWei, 0, 2e27);
        uint256 gap = bookedRao > visibleRao ? bookedRao - visibleRao : 0;
        uint256 backing = bookedRao > pendingWei / RAO ? bookedRao - pendingWei / RAO : 0;
        uint256 tolerance = Math.max(backing * MISSING_TOLERANCE_BPS / 10_000, MIN_MISSING_TOLERANCE_RAO);
        assertEq(CascadeFormulas.stakeMissing(visibleRao, bookedRao, pendingWei), gap > tolerance);
        // with no queue, the rule before R6
        assertEq(
            CascadeFormulas.stakeMissing(visibleRao, bookedRao, 0),
            gap > Math.max(bookedRao * MISSING_TOLERANCE_BPS / 10_000, MIN_MISSING_TOLERANCE_RAO)
        );
        assertEq(MISSING_TOLERANCE_BPS, 10);
        assertEq(MIN_MISSING_TOLERANCE_RAO, 1_000_000);
    }

    // ---- unlisted stake ----

    /// unlistedStakeRao() is the coldkey's whole root stake less the visible: the swapped position, until its new
    /// hotkey is listed. Alpha on a subnet and another coldkey's stake are not the vault's root stake. An
    /// unreadable total makes the view revert rather than read 0.
    function test_unlistedStakeReadsTheSwappedPosition() public {
        hundredStaked();
        assertEq(vaultLens.unlistedStakeRao(), 0);
        staking.swapHotkey(HK1, HK5, coldkey(), 3_000);
        assertEq(stakeOf(HK5), 30e9);
        assertEq(vaultLens.unlistedStakeRao(), 30e9);
        assertEq(internals().exposed_unlistedStakeRao(), 30e9);

        staking.donateStakeOnSubnet(HK5, coldkey(), 7, 50e9);
        staking.donateStake(HK5, keccak256("another coldkey"), 50e9);
        assertEq(vaultLens.unlistedStakeRao(), 30e9);

        vm.prank(keeper);
        vault.addHotkey(HK5);
        assertEq(vaultLens.unlistedStakeRao(), 0);
        assertEq(visible(), 100e9);
        assertEq(vaultLens.missingStakeRao(), 0);
        assertEq(vaultLens.totalAssets(), 100e18, "listed again, priced again");

        staking.setTotalReadReverts(true);
        vm.expectRevert(abi.encodeWithSignature("TotalReadReverted()"));
        vaultLens.unlistedStakeRao();
    }

    // ---- the ramp and the outflow base ----

    /// Only stakeIdle feeds the ramp, with what it measured (spec §3.10.12): re-based from the last stake, so a
    /// second stake mid-ramp adds to what is left; gifts and claims (stake-side or as balance) feed nothing, and
    /// v3.1's `root - booked` term is gone, so a gift never ramps in through a stake.
    function test_rampFedOnlyByStakeIdle() public {
        hundredStaked();
        assertEq(ramping(), 100e18, "what the stake measured");
        vm.warp(vm.getBlockTimestamp() + 12 hours);
        depositDirect(bob, 10e18);
        stake();
        assertEq(ramping(), 50e18 + 10e18, "half of the first, all of the second");
        vm.warp(vm.getBlockTimestamp() + 1 days);

        staking.donateStake(HK1, coldkey(), 50e9);
        staking.setUnclaimed(coldkey(), HK1, 2e9);
        claim(HK1);
        staking.setClaimToBalance(true);
        staking.setUnclaimed(coldkey(), HK1, 3e9);
        claim(HK1);
        assertEq(ramping(), 60e18, "no gift or claim feeds it");
        assertEq(booked(), 112e9);

        // the next stake puts the claim's 3 TAO of balance and carol's 10 on the hotkey: only those ramp in
        depositDirect(carol, 10e18);
        stake();
        assertEq(ramping(), 13e18, "the stake's own measurement, never the 50 TAO gift");
        assertEq(booked(), 125e9);
        assertEq(vaultLens.surplusStakeRao(), 50e9);
    }

    /// I-5: the outflow base a delivery computes (seen as the day's allowance, 20% of the base, a front-door redeem
    /// of alice's whole holding burns) is min(visible, booked) less what is still ramping, through a gift (the base
    /// stays at booked, and a later stake ramps in only what it adds), mid-ramp, and a swap within the tolerance
    /// (the base follows the visible stake down); past it, no delivery runs at all.
    function test_outflowBaseNeverAboveMinLessRamping() public {
        depositVia(alice, 10_000e18);
        stake();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertBase(10_000e18, "staked, ramped in");

        staking.donateStake(HK1, coldkey(), 5_000e9);
        assertBase(10_000e18, "a gift: booked, not visible");

        depositDirect(bob, 1e18);
        stake();
        vm.warp(vm.getBlockTimestamp() + 12 hours);
        assertBase(10_000.5e18, "mid-ramp: the new stake half in, the gift never");
        vm.warp(vm.getBlockTimestamp() + 12 hours);
        assertBase(10_001e18, "ramped in");

        // a swap within the tolerance (0.1% of the 10_001 TAO booked): 5_010 of HK1's 15_001 TAO swapped away,
        // visible 9_991 TAO, 10 below the booked
        moveAway(HK1, 5_010e9);
        assertEq(visible(), 9_991e9);
        assertFalse(missing());
        assertBase(9_991e18, "a swap: visible, not booked");
        // past the tolerance no delivery runs (Task 13), so none burns against a base the swap lowered
        moveAway(HK1, 1e9);
        assertTrue(missing());
        (bytes memory message,) = batch(9_999, noEntries(), entries1(alice, vault.balanceOf(alice)));
        refuse(address(bridge), frontDoor, message, 0, StakeMissing.selector);
    }

    /// The allowance alice's redeem burns is 20% of `base`, the base the formula expects is `base`, and neither
    /// is above min(visible, booked) less what is still ramping.
    function assertBase(uint256 base, string memory why) internal {
        assertEq(expectedBase(), base, why);
        assertApproxEqAbs(burnNow(alice), base * 2_000 / 10_000, 1e10, why);
    }

    // ---- the guard: stakeMissing closes every mint and every unconsented burn (Task 13) ----

    /// Without the flag, a direct redeem reverts StakeMissing while stake is missing (a part or the whole holding);
    /// with it, it burns and pays (RedeemedDirect carries the flag). While nothing is missing the flag is not
    /// needed and changes nothing.
    function test_redeemDirectNeedsTheFlagWhileMissing() public {
        hundredStaked();
        uint256 snap = vm.snapshotState();
        uint256 plain = redeem(alice, 10e24, false);
        assertEq(plain, 10e18);
        vm.revertToState(snap);
        assertEq(redeem(alice, 10e24, true), plain, "the flag changes nothing while nothing is missing");
        vm.revertToState(snap);

        staking.swapHotkey(HK1, HK5, coldkey(), 3_000);
        assertTrue(missing());
        uint256 supply = vault.totalSupply();
        vm.startPrank(alice);
        vm.expectRevert(StakeMissing.selector);
        vault.redeemDirect(10e24, false);
        vm.expectRevert(StakeMissing.selector);
        vault.redeemDirect(100e24, false);
        vm.stopPrank();
        assertEq(vault.totalSupply(), supply, "nothing burned");

        uint256 out = floorValue(10e24);
        vm.expectEmit(address(vault));
        emit RedeemedDirect(alice, 10e24, out, true);
        assertEq(redeem(alice, 10e24, true), out);
        assertEq(vault.totalSupply(), supply - 10e24);

        // listed again, the flag is not needed
        vm.prank(keeper);
        vault.addHotkey(HK5);
        assertFalse(missing());
        out = floorValue(10e24);
        assertEq(redeem(alice, 10e24, false), out);
    }

    /// acceptedMissing says how the exit was priced, not what the caller passed: a flagged redeem while nothing is
    /// missing is an ordinary one at the full price, and its event says false.
    function test_aFlaggedRedeemAtFullPriceSaysNothingWasMissing() public {
        hundredStaked();
        assertFalse(missing());
        vm.expectEmit(address(vault));
        emit RedeemedDirect(alice, 10e24, 10e18, false);
        assertEq(redeem(alice, 10e24, true), 10e18, "the full price");
        // within the tolerance (0.1% of the 90 TAO left booked), too: nothing counts as missing
        moveAway(HK1, 9e7);
        assertFalse(missing());
        uint256 out = floorValue(10e24);
        vm.expectEmit(address(vault));
        emit RedeemedDirect(alice, 10e24, out, false);
        redeem(alice, 10e24, true);
    }

    /// The consented exit pays exactly the floor price, its shares' value at min(visible, booked), floored to the
    /// rao, and takes nothing from the stayers: the vault's assets fall by exactly what was paid, and bob's
    /// redeemable value is unchanged to the wei. Listing the swapped hotkey later gives the stayers what the leaver
    /// gave up (I-4's exception: the price fell only while visible stake was below booked).
    function test_flaggedRedeemPaysTheFloorPriceOthersUnchanged() public {
        depositDirect(alice, 60e18);
        depositDirect(bob, 40e18);
        stake();
        assertEq(vault.balanceOf(alice), 60e24);
        assertEq(vault.balanceOf(bob), 40e24);
        staking.swapHotkey(HK1, HK5, coldkey(), 3_000);
        assertTrue(missing());
        uint256 assets = vaultLens.totalAssets();
        assertEq(assets, 70e18, "min(visible, booked)");
        uint256 bobBefore = redeemableBy(bob);
        assertEq(bobBefore, 28e18);
        uint256 out = floorValue(30e24);
        assertEq(out, 21e18, "30e24 of 100e24 shares, of 70 TAO");

        vm.expectEmit(address(vault));
        emit RedeemedDirect(alice, 30e24, out, true);
        assertEq(redeem(alice, 30e24, true), out, "the floor price, exactly");
        assertEq(vaultLens.totalAssets(), assets - out, "the assets fall by exactly what was paid");
        assertEq(redeemableBy(bob), bobBefore, "bob unchanged to the wei");
        assertEq(redeemableBy(alice), 21e18, "nor the rest of alice's holding");
        // the walk unstaked the 21 TAO off the visible stake and booked it
        assertEq(visible(), 49e9);
        assertEq(booked(), 79e9);

        vm.prank(keeper);
        vault.addHotkey(HK5);
        assertEq(visible(), booked());
        assertEq(vaultLens.totalAssets(), 79e18);
        assertGt(redeemableBy(bob), 40e18, "the stayer keeps what the leaver consented to give up");
    }

    /// Missing exactly the tolerance (0.1 TAO of 100 booked) is not missing: a direct deposit and a batch's
    /// deposit still mint, at the price min(visible, booked) reads, and a direct redeem needs no flag. One rao more
    /// and both mints revert StakeMissing.
    function test_aSwapUnderTheToleranceStillMints() public {
        hundredStaked();
        assertEq(vaultLens.pendingPayouts(), 0, "no queue: the tolerance is 0.1% of the booked stake, as before R6");
        moveAway(HK1, 1e8);
        assertFalse(missing());
        uint256 assets = vaultLens.totalAssets();
        assertEq(assets, 100e18 - 1e17);

        uint256 expected = CascadeMath.sharesForDeposit(10e18, assets, vault.totalSupply());
        depositDirect(bob, 10e18);
        assertEq(vault.balanceOf(bob), expected, "direct, at min(visible, booked)");
        expected = CascadeMath.sharesForDeposit(10e18, vaultLens.totalAssets(), vault.totalSupply());
        depositVia(carol, 10e18);
        assertEq(vault.balanceOf(carol), expected, "by batch, at the same reading");
        uint256 out = floorValue(1e24);
        assertEq(redeem(bob, 1e24, false), out, "no flag needed");

        moveAway(HK1, 1);
        assertTrue(missing());
        vm.deal(bob, 1e18);
        vm.prank(bob);
        vm.expectRevert(StakeMissing.selector);
        vault.depositDirect{value: 1e18}();
        (bytes memory message, uint256 sum) = batch(++nextBatchId, entries1(carol, 1e18), noEntries());
        refuse(address(bridge), frontDoor, message, sum, StakeMissing.selector);
    }

    /// R6 E-fix (ChatGPT R2 claim E; Fable's check): the tolerance's bps part is of the stake that still backs shares,
    /// the booked stake less the queued payouts (a door redeem's payout stays staked until it is sent). Fable's example:
    /// 99.8 of 100 TAO queued through the door, bob's 0.2 TAO the only stake backing shares, and a swap moves 0.1 TAO
    /// off the set. Until R6 the tolerance was 0.1% of the 100 TAO booked, 0.1 TAO, so nothing read as missing and mints
    /// ran at half the price (exactly the half-launch line, which does not refuse). Now it is the larger of 0.1% of 0.2
    /// TAO and 0.001 TAO: stake is missing, a direct deposit and a batch's deposit are refused (the adapter parks the
    /// batch), and once the swapped hotkey is listed mints reopen at the true price, bob's 0.2 TAO intact.
    function test_aGapInsideTheOldToleranceWithALargeQueueReadsMissing() public {
        depositVia(alice, 99.8e18);
        depositVia(bob, 0.2e18);
        stake();
        assertEq(booked(), 100e9);
        redeemVia(alice, vault.balanceOf(alice));
        assertEq(vaultLens.pendingPayouts(), 99.8e18, "alice's 99.8 TAO queued");
        assertEq(visible(), 100e9, "and still staked");
        assertEq(vaultLens.totalAssets(), 0.2e18, "bob's 0.2 TAO is what backs the shares");

        moveAway(HK1, 1e8);
        assertEq(vaultLens.totalAssets(), 0.1e18, "the price halved");
        assertTrue(missing(), "0.1 TAO is past the tolerance of the 0.2 TAO still backing shares (0.001 TAO)");
        vm.deal(carol, 100e18);
        vm.prank(carol);
        vm.expectRevert(StakeMissing.selector);
        vault.depositDirect{value: 100e18}();
        (bytes memory message, uint256 sum) = batch(++nextBatchId, entries1(carol, 100e18), noEntries());
        refuse(address(bridge), frontDoor, message, sum, StakeMissing.selector);

        // the permissionless way back (I-6): a stranger lists the swap's new hotkey, nothing is missing
        vm.prank(stranger);
        vault.addHotkey(HK5);
        assertFalse(missing());
        depositDirect(carol, 100e18);
        assertApproxEqAbs(redeemableBy(bob), 0.2e18, 1e10, "bob's 0.2 TAO intact");
        assertApproxEqAbs(redeemableBy(carol), 100e18, 1e10, "carol minted at the true price");
    }

    /// The boundary with a partial queue: 10 of alice's 100 TAO queued, so the tolerance is 0.1% of the 90 TAO still
    /// backing shares, 0.09 TAO (until R6, 0.1 TAO): a gap of exactly 0.09 TAO is not missing, a rao more is.
    function test_theToleranceIsOfTheBookedStakeLessTheQueue() public {
        depositVia(alice, 100e18);
        stake();
        redeemVia(alice, 1e25);
        assertEq(vaultLens.pendingPayouts(), 10e18);
        assertEq(booked(), 100e9, "the queued 10 TAO still staked and booked");
        moveAway(HK1, 9e7);
        assertFalse(missing(), "0.09 TAO: within 0.1% of the 90 TAO backing shares");
        moveAway(HK1, 1);
        assertTrue(missing(), "a rao more is missing (the R5 rule allowed up to 0.1 TAO)");
    }

    /// The bound, fuzzed: whatever the queue (1 to 90 of alice's 90 TAO beside bob's 10), a gap anywhere inside the
    /// tolerance and a minter's direct deposit, once the swapped stake is listed again the minter has gained, and the
    /// stayers lost, at most max(0.1% of the stake backing shares, 0.001 TAO), in TAO.
    function testFuzz_aMinterInsideTheToleranceGainsAtMostIt(uint256 q, uint256 gapSeed, uint256 amount) public {
        q = bound(q, 1, 90);
        depositVia(alice, 90e18);
        depositVia(bob, 10e18);
        stake();
        redeemVia(alice, q * 1e24);
        uint256 backingRao = 100e9 - q * 1e9;
        uint256 tolerance = Math.max(backingRao * MISSING_TOLERANCE_BPS / 10_000, MIN_MISSING_TOLERANCE_RAO);
        uint256 gap = bound(gapSeed, 1, tolerance);
        moveAway(HK1, gap);
        assertFalse(missing(), "a gap inside the tolerance");
        amount = bound(amount, 1e16, 800e18);
        amount -= amount % 1e9;
        uint256 stayerShares = vault.totalSupply();
        depositDirect(carol, amount);
        vm.prank(keeper);
        vault.addHotkey(HK5);
        assertFalse(missing());
        uint256 stayers = CascadeMath.assetsForRedeem(stayerShares, vaultLens.totalAssets(), vault.totalSupply());
        assertLe(CascadeFormulas.sub0(redeemableBy(carol), amount), tolerance * 1e9, "the minter gains at most it");
        assertLe(CascadeFormulas.sub0((100 - q) * 1e18, stayers), tolerance * 1e9 + 10, "the stayers lose at most it");
    }

    /// I-1: no RewardCutMinted while stake is missing. The claim still books its stake-side rise and the whole
    /// delta vests: the cut is a mint, priced at a reading the swap lowered. Once the stake is listed again, the
    /// next claim cuts as before.
    function test_noRewardCutWhileMissing() public {
        hundredStaked();
        staking.swapHotkey(HK1, HK5, coldkey(), 3_000);
        assertTrue(missing());
        staking.setUnclaimed(coldkey(), HK1, 2e9);
        uint256 supply = vault.totalSupply();

        vm.recordLogs();
        claim(HK1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool claimed;
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != RewardCutMinted.selector, "no cut while missing");
            if (logs[i].topics[0] == RewardsClaimed.selector) {
                assertEq(abi.decode(logs[i].data, (uint256)), 2e9);
                claimed = true;
            }
        }
        assertTrue(claimed);
        assertEq(vault.balanceOf(treasury), 0);
        assertEq(vault.totalSupply(), supply);
        assertEq(vaultLens.vestingAmount(), 2e18, "the whole delta vests");
        assertEq(booked(), 102e9, "the claim's stake-side rise, booked");
        assertEq(visible(), 72e9);

        vm.prank(keeper);
        vault.addHotkey(HK5);
        assertFalse(missing());
        vm.warp(vm.getBlockTimestamp() + 7 days);
        staking.setUnclaimed(coldkey(), HK1, 1e9);
        uint256 cutShares = CascadeMath.sharesForDeposit(0.1e18, vaultLens.totalAssets(), vault.totalSupply());
        vm.expectEmit(address(vault));
        emit RewardCutMinted(treasury, 0.1e18, cutShares);
        claim(HK1);
        assertEq(vault.balanceOf(treasury), cutShares);
    }

    /// The guard reads the stake as the claim leaves it: a claim paid as 5 TAO of balance while the stake falls 3 TAO
    /// (spec §3.10.14) rises 2 TAO in all, but leaves 3 TAO missing, so its cut is skipped and the 2 TAO vest whole.
    function test_noCutWhenTheClaimItselfLeavesStakeMissing() public {
        hundredStaked();
        assertFalse(missing());
        staking.setClaimToBalance(true);
        staking.setClaimFallRao(3e9);
        staking.setUnclaimed(coldkey(), HK1, 5e9);
        vm.recordLogs();
        claim(HK1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != RewardCutMinted.selector, "no cut once the claim leaves stake missing");
        }
        assertTrue(missing());
        assertEq(vault.balanceOf(treasury), 0);
        assertEq(vaultLens.vestingAmount(), 2e18, "the whole rise vests");
    }

    /// A claim can cross the tolerance: 0.1 TAO and 1 rao missing of 100 TAO booked is past it, and a 2 TAO claim
    /// paid as stake books 2 TAO, so the tolerance (0.1% of booked) grows to 0.102 TAO and the same gap no longer
    /// reads as missing after the claim. The cut's pre-claim price read the gap, so it is skipped all the same
    /// (missing before the claim, on the pair the claim read) and the whole 2 TAO vests (the reviewer's probe).
    function test_noCutWhenTheClaimLiftsTheToleranceOverTheGap() public {
        hundredStaked();
        moveAway(HK1, 1e8 + 1);
        assertTrue(missing(), "one rao past the tolerance");
        staking.setUnclaimed(coldkey(), HK1, 2e9);
        vm.recordLogs();
        claim(HK1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != RewardCutMinted.selector, "no cut on a price that read the gap");
        }
        assertFalse(missing(), "the claim lifted the tolerance over the gap");
        assertEq(booked(), 102e9);
        assertEq(vault.balanceOf(treasury), 0);
        assertEq(vaultLens.vestingAmount(), 2e18, "the whole rise vests");
    }

    /// stakeIdle and processPayouts price no share, and cancelPayoutBatch never re-mints more shares than were
    /// burned, so they run while stake is missing: alice's queued payout is paid (its walk unstaking off the visible
    /// stake and booking it), bob's queued batch is cancelled (at the price the missing stake lowers, his 10 TAO buys
    /// more shares than he burned, so he gets his burned shares back, Task 34c), and a claim's liquid reward is staked
    /// and booked.
    function test_payoutsAndCancelUnaffected() public {
        depositVia(alice, 50e18);
        depositVia(bob, 50e18);
        stake();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        (bytes32 keyA, CascadeMessages.Payout[] memory listA) = redeemVia(alice, 10e24);
        (bytes32 keyB, CascadeMessages.Payout[] memory listB) = redeemVia(bob, 10e24);
        assertEq(vaultLens.pendingPayouts(), 20e18);

        staking.swapHotkey(HK1, HK5, coldkey(), 3_000);
        assertTrue(missing());
        assertEq(visible(), 70e9);

        Schedule.warpTo(vm.getBlockTimestamp() + 24 hours);
        uint256 sends = bridge.sendCount();
        vault.processPayouts(keyA, listA, 0);
        assertEq(bridge.sendCount(), sends + 1, "alice's payout sent");
        assertEq(vaultLens.getPayoutBatch(keyA).count, 0, "paid");
        // 10 TAO and the 1_000-rao shortfall tolerance on top (Task 19), which stays idle until stakeIdle below
        assertEq(visible(), 60e9 - 1_000, "unstaked off the visible stake");
        assertEq(booked(), 90e9 - 1_000, "and booked");

        vm.prank(owner);
        vault.cancelPayoutBatch(keyB, listB);
        assertEq(vault.balanceOf(bob), 50e24, "his burned shares back");
        assertEq(vaultLens.pendingPayouts(), 0);

        staking.setClaimToBalance(true);
        staking.setUnclaimed(coldkey(), HK1, 2e9);
        claim(HK1);
        stake();
        assertEq(visible(), 62e9);
        assertEq(booked(), 92e9, "the stake books what it measured");
        assertTrue(missing(), "the gap is the swap's, unchanged");
    }

    /// onBridgeMessage reverts StakeMissing after its bridge, pause and peer checks, for a batch of deposits, of
    /// redeems or of both, and writes nothing (no mint, no burn, no window, no replay record): the adapter holds the
    /// message, and once the stake is listed again the same messages deliver.
    function test_batchDeliveryRevertsStakeMissing() public {
        depositVia(alice, 100e18);
        stake();
        staking.swapHotkey(HK1, HK5, coldkey(), 3_000);
        assertTrue(missing());
        uint256 supply = vault.totalSupply();
        bytes32 peer = vaultLens.peerId(BASE, frontDoor);

        (bytes memory deposits, uint256 sum) = batch(++nextBatchId, entries1(bob, 10e18), noEntries());
        (bytes memory redeems,) = batch(++nextBatchId, noEntries(), entries1(alice, 10e24));
        (bytes memory both, uint256 bothSum) = batch(++nextBatchId, entries1(carol, 5e18), entries1(alice, 5e24));

        // the bridge, the pause and the peer are checked first
        refuse(alice, frontDoor, deposits, sum, NotBridge.selector);
        refuse(address(bridge), makeAddr("stranger"), deposits, sum, UnknownPeer.selector);
        vm.prank(guardian);
        vault.pause();
        refuse(address(bridge), frontDoor, deposits, sum, Pausable.EnforcedPause.selector);
        vm.prank(owner);
        vault.unpause();

        refuse(address(bridge), frontDoor, deposits, sum, StakeMissing.selector);
        refuse(address(bridge), frontDoor, redeems, 0, StakeMissing.selector);
        refuse(address(bridge), frontDoor, both, bothSum, StakeMissing.selector);
        assertEq(vault.totalSupply(), supply, "no mint, no burn");
        assertEq(vault.balanceOf(bob) + vault.balanceOf(carol), 0);
        assertEq(vaultLens.pendingPayouts(), 0);
        (, uint256 burned) = vaultLens.burnWindows(peer);
        assertEq(burned, 0);
        assertEq(address(vault).balance, ED, "the money stayed with the rail");

        vm.prank(keeper);
        vault.addHotkey(HK5);
        deliverMessage(deposits, sum);
        deliverMessage(redeems, 0);
        deliverMessage(both, bothSum);
        assertEq(vault.balanceOf(bob), 10e24);
        assertEq(vault.balanceOf(carol), 5e24);
        assertEq(vault.balanceOf(alice), 85e24);
    }

    // ---- adoption and the write-off: helpers (Task 16) ----

    function adopt(address caller) internal {
        vm.prank(caller);
        vault.adoptStake();
    }

    function adoptRefused(address caller, bytes4 err) internal {
        vm.prank(caller);
        vm.expectRevert(err);
        vault.adoptStake();
    }

    function writeOffData(uint256 rao) internal view returns (bytes memory) {
        return abi.encodeCall(vault.writeOffMissingStake, (rao));
    }

    /// The owner's write-off of `rao` scheduled now, and its 7 days (the Registry class) waited; its calldata.
    function scheduleWriteOff(uint256 rao) internal returns (bytes memory data) {
        data = writeOffData(rao);
        vm.prank(owner);
        vault.schedule(data);
        Schedule.wait(7 days);
    }

    /// Executes the scheduled write-off `data`, which must write off exactly `w` rao (StakeWrittenOff(w), the booked
    /// stake `w` lower) and move neither the price, the assets nor the priced stake, min(visible, booked) (I-4).
    function executeWriteOff(bytes memory data, uint256 w) internal {
        uint256 price = vaultLens.price();
        uint256 assets = vaultLens.totalAssets();
        uint256 bookedBefore = booked();
        uint256 priced = Math.min(visible(), bookedBefore);
        vm.expectEmit(address(vault));
        emit StakeWrittenOff(w);
        vm.prank(owner);
        vault.execute(data);
        assertEq(booked(), bookedBefore - w, "booked less what was written off");
        assertEq(Math.min(visible(), booked()), priced, "the priced stake does not move");
        assertEq(vaultLens.totalAssets(), assets, "nor the assets");
        assertEq(vaultLens.price(), price, "nor the price");
    }

    /// A write-off of `rao` scheduled, waited and executed, writing off exactly `w`.
    function writeOff(uint256 rao, uint256 w) internal {
        executeWriteOff(scheduleWriteOff(rao), w);
    }

    /// The scheduled write-off `data` refused `err` at execute, and kept: the revert restores the item.
    function writeOffRefused(bytes memory data, bytes4 err) internal {
        uint256 bookedBefore = booked();
        vm.prank(owner);
        vm.expectRevert(err);
        vault.execute(data);
        assertGt(vaultLens.scheduled(keccak256(data)).readyAt, 0, "the item is kept");
        assertEq(booked(), bookedBefore);
    }

    // ---- adoptStake (Task 16) ----

    /// A gift on a listed hotkey, adopted: booked at once and so in the outflow base at once (spec §3.10.2: a gift
    /// cannot be withdrawn, so it is no borrowed capital to ramp), but vested into the price over the period in
    /// force on its own drip (Revision 27), with no cut: the price does not step, and rises over the 7 days; the claim
    /// schedule is not touched. lastStakeAt and the ramp are untouched; lastAdoptAt moves to now.
    function test_adoptBooksAndVestsTheGift() public {
        depositVia(alice, 1_000e18);
        stake();
        uint64 stakedAt = vaultLens.lastStakeAt();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertBase(1_000e18, "staked, ramped in");
        staking.donateStake(HK1, coldkey(), 100e9);
        assertEq(vaultLens.surplusStakeRao(), 100e9);
        assertBase(1_000e18, "a gift: not in the base until adopted");
        uint256 price = vaultLens.price();
        uint256 rampBefore = ramping();

        vm.recordLogs();
        adopt(keeper);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "StakeAdopted alone: no cut minted");
        assertEq(logs[0].emitter, address(vault));
        assertEq(logs[0].topics[0], StakeAdopted.selector);
        assertEq(abi.decode(logs[0].data, (uint256)), 100e9, "the surplus, in rao");

        uint256 t = vm.getBlockTimestamp();
        assertEq(booked(), 1_100e9);
        assertEq(vaultLens.surplusStakeRao(), 0);
        assertEq(vaultLens.grossAssets(), 1_100e18);
        assertEq(vaultLens.adoptVestingAmount(), 100e18, "the whole gift vests, no cut");
        assertEq(vaultLens.adoptVestingStart(), t);
        assertEq(vaultLens.adoptVestingPeriod(), 7 days, "the period in force");
        assertEq(vaultLens.vestingAmount(), 0, "the claim schedule untouched");
        assertEq(vaultLens.vestingStart(), 0);
        assertEq(vaultLens.vestingPeriod(), 0);
        assertEq(vault.balanceOf(treasury), 0);
        assertEq(vaultLens.totalAssets(), 1_000e18, "the price does not step");
        assertEq(vaultLens.price(), price);
        assertEq(internals().exposed_totalAssets(), 1_000e18);
        assertEq(vaultLens.lastStakeAt(), stakedAt, "lastStakeAt untouched");
        assertEq(ramping(), rampBefore, "nothing ramps");
        assertEq(vaultLens.lastAdoptAt(), t);
        assertBase(1_100e18, "in the base at once");

        vm.warp(t + 3.5 days);
        assertEq(vaultLens.totalAssets(), 1_050e18, "half vested");
        assertGt(vaultLens.price(), price);
        vm.warp(t + 7 days);
        assertEq(vaultLens.totalAssets(), 1_100e18, "all vested");
    }

    /// Revision 27 (was ruling B7b's restart through _vest): an adoption leaves the claim schedule alone, so what is
    /// still vesting of a claim keeps its own amount, start and period, and the gift vests on its own drip, over the
    /// period in force (nothing is left of a first drip to carry); the price does not step. VaultAdoptionDrip has the
    /// second adoption's restart of the drip by the same rule, and the claim's.
    function test_adoptLeavesTheClaimScheduleAndStartsItsOwnDrip() public {
        hundredStaked();
        vm.prank(owner);
        vault.setRewardVesting(30 days);
        staking.setUnclaimed(coldkey(), HK1, 10e9);
        claim(HK1);
        uint256 claimedAt = vm.getBlockTimestamp();
        assertEq(vaultLens.vestingAmount(), 9e18, "the claim less its 10% cut");
        assertEq(vaultLens.vestingPeriod(), 30 days);
        // the period lowered to 7 days (a scheduled decrease, 48 hours)
        Schedule.run(vault, owner, abi.encodeCall(vault.setRewardVesting, (7 days)));
        staking.donateStake(HK1, coldkey(), 5e9);
        uint256 unvested = vaultLens.unvestedRewards();
        uint256 assets = vaultLens.totalAssets();

        adopt(keeper);
        assertEq(vaultLens.vestingAmount(), 9e18, "the claim schedule's amount untouched");
        assertEq(vaultLens.vestingStart(), claimedAt, "its start");
        assertEq(vaultLens.vestingPeriod(), 30 days, "its period: the claimed rewards keep their own end");
        assertEq(vaultLens.adoptVestingAmount(), 5e18, "the gift alone on its drip");
        assertEq(vaultLens.adoptVestingStart(), vm.getBlockTimestamp());
        assertEq(vaultLens.adoptVestingPeriod(), 7 days, "the period in force");
        assertEq(vaultLens.unvestedRewards(), unvested + 5e18, "both drips");
        assertEq(vaultLens.totalAssets(), assets, "no step");
    }

    /// Spec §3.1: adoptStake refuses unless a STAKE_RAMP (a day) has passed since the last adoption, or since the
    /// deploy (AdoptTooSoon), and the surplus is at least the chain's minimum stake, minStakeRao()
    /// (BelowMinAdoption): nothing, one rao under, then exactly the minimum; a raised live minimum counts.
    function test_adoptMinimumAndDailyBound() public {
        hundredStaked();
        assertEq(vaultLens.lastAdoptAt(), deployedAt, "set at deploy");
        staking.donateStake(HK1, coldkey(), 5e9);
        vm.warp(deployedAt + 1 days - 1);
        adoptRefused(keeper, AdoptTooSoon.selector);
        vm.warp(deployedAt + 1 days);
        adopt(keeper);
        assertEq(booked(), 105e9);
        assertEq(vaultLens.lastAdoptAt(), deployedAt + 1 days);

        uint256 t = deployedAt + 2 days;
        vm.warp(t);
        adoptRefused(keeper, BelowMinAdoption.selector);
        staking.donateStake(HK1, coldkey(), 1_999_999);
        assertEq(vaultLens.minStakeRao(), 2_000_000);
        adoptRefused(keeper, BelowMinAdoption.selector);
        staking.donateStake(HK1, coldkey(), 1);
        vm.expectEmit(address(vault));
        emit StakeAdopted(2_000_000);
        adopt(keeper);
        assertEq(booked(), 105e9 + 2_000_000);

        // the next a day later, whatever the surplus
        staking.donateStake(HK1, coldkey(), 50e9);
        vm.warp(t + 1 days - 1);
        adoptRefused(keeper, AdoptTooSoon.selector);
        vm.warp(t + 1 days);
        // the chain's live minimum, when above the owner's fallback
        staking.setMinStake(50e9 + 1);
        adoptRefused(keeper, BelowMinAdoption.selector);
        staking.setMinStake(50e9);
        adopt(keeper);
        assertEq(booked(), visible());
    }

    /// Only the keeper adopts until KEEPER_FALLBACK (7 days) after the last adoption (or the deploy): then anyone,
    /// the owner and the guardian being no keeper either (NotKeeper). A stranger's adoption restarts the count; with
    /// no keeper set, the fallback alone remains.
    function test_adoptFallbackForStrangers() public {
        hundredStaked();
        staking.donateStake(HK1, coldkey(), 5e9);
        vm.warp(deployedAt + 7 days - 1);
        address[3] memory others = [stranger, owner, guardian];
        for (uint256 i; i < others.length; ++i) {
            adoptRefused(others[i], NotKeeper.selector);
        }
        vm.warp(deployedAt + 7 days);
        adopt(stranger);
        assertEq(booked(), 105e9);
        uint256 t = vm.getBlockTimestamp();
        assertEq(vaultLens.lastAdoptAt(), t, "a stranger's adoption counts");

        staking.donateStake(HK1, coldkey(), 5e9);
        vm.warp(t + 7 days - 1);
        adoptRefused(stranger, NotKeeper.selector);
        vm.warp(t + 7 days);
        vm.prank(owner);
        vault.setKeeper(address(0));
        adopt(stranger);
        assertEq(booked(), 110e9);
    }

    /// Spec §3.10.13: a pause freezes the bookings that add capital, so adoptStake refuses while paused, by the
    /// guardian or the owner, for the keeper and past the fallback for anyone; unpaused, it runs.
    function test_adoptRefusedWhilePaused() public {
        hundredStaked();
        staking.donateStake(HK1, coldkey(), 5e9);
        vm.warp(deployedAt + 7 days);
        vm.prank(guardian);
        vault.pause();
        adoptRefused(keeper, Pausable.EnforcedPause.selector);
        adoptRefused(stranger, Pausable.EnforcedPause.selector);
        vm.prank(owner);
        vault.unpause();
        vm.prank(owner);
        vault.pause();
        adoptRefused(keeper, Pausable.EnforcedPause.selector);
        vm.prank(owner);
        vault.unpause();
        adopt(keeper);
        assertEq(booked(), 105e9);
    }

    /// Security check (a): while stake is missing nothing can be adopted. The surplus is visible less booked, so a
    /// gift on a listed hotkey only fills the gap a swap left (30 TAO off the set, 20 given back as a gift: 10 still
    /// missing, no surplus), for the keeper and anyone. Once the swapped hotkey is listed, the gift is a surplus.
    function test_noAdoptionWhileStakeMissing() public {
        hundredStaked();
        vm.warp(deployedAt + 7 days);
        staking.swapHotkey(HK1, HK5, coldkey(), 3_000);
        vm.prank(keeper);
        vault.addHotkey(HK2);
        staking.donateStake(HK2, coldkey(), 20e9);
        assertEq(visible(), 90e9);
        assertTrue(missing());
        assertEq(vaultLens.surplusStakeRao(), 0, "no surplus while stake is missing");
        adoptRefused(keeper, BelowMinAdoption.selector);
        adoptRefused(stranger, BelowMinAdoption.selector);
        assertEq(booked(), 100e9);

        vm.prank(keeper);
        vault.addHotkey(HK5);
        assertEq(vaultLens.surplusStakeRao(), 20e9);
        adopt(keeper);
        assertEq(booked(), 120e9);
        assertFalse(missing());
    }

    /// Security check (a), fuzzed: whatever moved off the set and whatever was given onto it, while stake is missing
    /// the surplus is 0 and adoptStake refuses; otherwise it adopts exactly the surplus at or above the minimum.
    function testFuzz_noAdoptionWhileStakeMissing(uint256 movedRao, uint256 giftRao) public {
        hundredStaked();
        vm.warp(deployedAt + 1 days);
        movedRao = bound(movedRao, 0, 100e9);
        giftRao = bound(giftRao, 0, 200e9);
        if (movedRao != 0) moveAway(HK1, movedRao);
        if (giftRao != 0) staking.donateStake(HK1, coldkey(), giftRao);
        uint256 surplus = vaultLens.surplusStakeRao();
        if (missing()) assertEq(surplus, 0, "no surplus while missing");
        if (surplus < vaultLens.minStakeRao()) {
            adoptRefused(keeper, BelowMinAdoption.selector);
            assertEq(booked(), 100e9);
        } else {
            adopt(keeper);
            assertEq(booked(), visible());
            assertFalse(missing());
        }
    }

    /// Security check (b): a deposit made right before an adoption gains only what vests while it is held. bob's
    /// 100 TAO beside alice's, just before a 10 TAO gift is adopted: at once his shares are worth exactly his deposit;
    /// a day later, half of a day's vesting (10 TAO / 7 / 2), where an unvested adoption would have given him 5 TAO.
    function test_aDepositBeforeAnAdoptionGainsOnlyWhatVests() public {
        hundredStaked();
        vm.warp(deployedAt + 1 days);
        staking.donateStake(HK1, coldkey(), 10e9);
        depositDirect(bob, 100e18);
        assertEq(vault.balanceOf(bob), vault.balanceOf(alice), "bob mints at alice's price: the gift is unpriced");
        adopt(keeper);
        assertEq(redeemableBy(bob), 100e18, "worth his deposit, none of the gift");
        uint256 snap = vm.snapshotState();
        assertEq(redeemAll(bob), 100e18, "out at once with exactly what he put in");
        vm.revertToState(snap);

        vm.warp(vm.getBlockTimestamp() + 1 days);
        uint256 got = redeemAll(bob);
        uint256 gift = 10e18;
        uint256 vested = gift - gift * 6 / 7;
        assertLe(got, 100e18 + vested / 2, "at most his half of a day's vesting");
        assertGe(got, 100e18 + vested / 2 - RAO);
        assertGt(redeemableBy(alice), 100e18 + vested / 2, "alice keeps the rest, vesting on");
    }

    // ---- writeOffMissingStake (Task 16) ----

    /// M-1: w = min(rao, missing) is written off only if w + unlisted <= missing, so only what is not sitting under an
    /// unlisted hotkey of the vault's coldkey can go: 30 TAO swapped to the unlisted HK5 (still the vault's) and 10
    /// TAO lost for good leave 40 missing, of which exactly 10 can be written off (10 + 1 rao, all 40, or any amount
    /// more is refused, the item kept); then not one rao more, and listing HK5 brings the rest back (I-6).
    function test_writeOffBoundedByMissingLessUnlisted() public {
        hundredStaked();
        staking.swapHotkey(HK1, HK5, coldkey(), 3_000);
        staking.loseStake(HK1, coldkey(), 10e9);
        assertEq(visible(), 60e9);
        assertEq(vaultLens.missingStakeRao(), 40e9);
        assertEq(vaultLens.unlistedStakeRao(), 30e9);

        bytes[4] memory items =
            [writeOffData(10e9 + 1), writeOffData(40e9), writeOffData(type(uint256).max), writeOffData(10e9)];
        vm.startPrank(owner);
        for (uint256 i; i < items.length; ++i) {
            vault.schedule(items[i]);
        }
        vm.stopPrank();
        Schedule.wait(7 days);
        for (uint256 i; i < 3; ++i) {
            writeOffRefused(items[i], WriteOffTooLarge.selector);
        }
        executeWriteOff(items[3], 10e9);
        assertEq(booked(), 90e9);
        assertEq(vaultLens.missingStakeRao(), 30e9, "what HK5 holds");
        assertTrue(missing(), "the rest waits for HK5's listing");

        writeOffRefused(scheduleWriteOff(1), WriteOffTooLarge.selector);
        vm.prank(stranger);
        vault.addHotkey(HK5);
        assertEq(visible(), 90e9);
        assertEq(vaultLens.missingStakeRao(), 0);
        assertFalse(missing());
    }

    /// I-4 and security check (c): a write-off never moves the price (the price already reads min(visible, booked),
    /// and the booked stake never goes below the visible), and once nothing is missing it reopens minting, at the
    /// depressed price. 30 TAO lost: a partial write-off (10) leaves booked above visible and minting closed; one of
    /// more than is missing writes off what is missing (20), and deposits mint again, direct and by batch.
    function test_writeOffNeverMovesThePriceAndReopensMinting() public {
        hundredStaked();
        staking.loseStake(HK1, coldkey(), 30e9);
        assertTrue(missing());
        assertEq(vaultLens.unlistedStakeRao(), 0, "gone, not unlisted");
        assertEq(vaultLens.totalAssets(), 70e18, "the price already reads the loss");
        uint256 price = vaultLens.price();
        vm.deal(bob, 7e18);
        vm.prank(bob);
        vm.expectRevert(StakeMissing.selector);
        vault.depositDirect{value: 7e18}();

        writeOff(10e9, 10e9);
        assertEq(booked(), 90e9);
        assertGt(booked(), visible(), "booked stays above visible");
        assertTrue(missing(), "minting stays closed");
        writeOff(1_000e9, 20e9);
        assertEq(booked(), 70e9);
        assertEq(booked(), visible());
        assertEq(vaultLens.price(), price, "never moved");
        assertFalse(missing(), "minting reopens");

        uint256 expected = CascadeMath.sharesForDeposit(7e18, 70e18, vault.totalSupply());
        depositDirect(bob, 7e18);
        assertEq(vault.balanceOf(bob), expected, "at the depressed price");
        expected = CascadeMath.sharesForDeposit(7e18, vaultLens.totalAssets(), vault.totalSupply());
        depositVia(carol, 7e18);
        assertEq(vault.balanceOf(carol), expected);
    }

    /// Spec §3.1: the write-off reads the coldkey's total inside a `try` and counts a failed read as 0. Read, the 30
    /// TAO a swap put under the unlisted HK5 cannot be written off; unreadable (setTotalReadReverts), the bound is
    /// lost and the same item writes it off, which the 7-day notice and the guardian's veto make acceptable. The
    /// stake was not gone: listed, it is a surplus, and adoption books it back, vesting (stake recovered after a
    /// write-off).
    function test_writeOffWithAFailingUnlistedRead() public {
        hundredStaked();
        staking.swapHotkey(HK1, HK5, coldkey(), 3_000);
        bytes memory data = scheduleWriteOff(30e9);
        writeOffRefused(data, WriteOffTooLarge.selector);

        staking.setTotalReadReverts(true);
        executeWriteOff(data, 30e9);
        assertEq(booked(), 70e9);
        assertFalse(missing());
        staking.setTotalReadReverts(false);

        vm.prank(keeper);
        vault.addHotkey(HK5);
        assertEq(vaultLens.surplusStakeRao(), 30e9);
        uint256 assets = vaultLens.totalAssets();
        adopt(keeper);
        assertEq(booked(), 100e9);
        assertEq(vaultLens.totalAssets(), assets, "it vests rather than stepping the price");
        vm.warp(vm.getBlockTimestamp() + 7 days);
        assertEq(vaultLens.totalAssets(), 100e18);
    }

    /// The write-off's read has its own cap, WRITE_OFF_READ_GAS (R6 C): a read that burns all it is given
    /// (setTotalReadBurnsGas) costs the execute that cap and little more, and counts as 0, like a failed one.
    function test_writeOffsReadIsCappedAtItsOwnCap() public {
        hundredStaked();
        staking.loseStake(HK1, coldkey(), 30e9);
        bytes memory data = scheduleWriteOff(30e9);
        staking.setTotalReadBurnsGas(true);
        vm.prank(owner);
        uint256 g = gasleft();
        vault.execute(data);
        uint256 used = g - gasleft();
        emit log_named_uint("execute of a write-off whose read burns its whole cap: gas used", used);
        assertLt(used, CascadeFormulas.WRITE_OFF_READ_GAS + 300_000, "the read's cap bounds what it burns");
        assertGt(used, CascadeFormulas.WRITE_OFF_READ_GAS, "the read burned its cap");
        assertEq(booked(), 70e9);
    }

    /// Revision 28's gas audit: a capped read whose failure counts is given its whole cap (CascadeFormulas.requireGasFor).
    /// Here the read refuses at once when given less than 10,000 gas under its cap, returning the rest (setReadGasFloor:
    /// a precompile that checks its cost up front), so without the check an execute with the right gas limit would
    /// starve it into the failure's 0 and write off the 30 TAO the unlisted HK5 still holds. Over every gas limit from
    /// 46,000,000 to 47,000,000, 2,000 apart (across the least that gives the read its cap), none writes it off: one that
    /// would leave the read less than its cap reverts InsufficientGas (the item kept), and one that gives it its cap
    /// reads it and is refused WriteOffTooLarge.
    function test_noGasLimitStarvesTheWriteOffsReadIntoAWriteOff() public {
        hundredStaked();
        staking.swapHotkey(HK1, HK5, coldkey(), 3_000);
        bytes memory data = scheduleWriteOff(30e9);
        writeOffRefused(data, WriteOffTooLarge.selector);
        staking.setReadGasFloor(CascadeFormulas.WRITE_OFF_READ_GAS - 10_000);
        (uint256 starved, uint256 refused) =
            _scanGas(owner, abi.encodeCall(vault.execute, (data)), WriteOffTooLarge.selector, 46_000_000, 47_000_000);
        assertGt(starved, 0, "short of the read's cap: InsufficientGas");
        assertGt(refused, 0, "the read given its cap: WriteOffTooLarge");
        assertEq(booked(), 100e9, "nothing written off");
        assertGt(vaultLens.scheduled(keccak256(data)).readyAt, 0, "the item kept");
    }

    // ---- R6 C (ChatGPT R2 claim C): the write-off's read is priced by the coldkey's positions ----

    /// Bittensor meters getTotalColdkeyStakeOnSubnet by the coldkey's positions, and anyone can add positions under a
    /// hotkey already in the vault's set (a same-subnet transfer_stake of 0.0001 TAO): about 67 of them price the read
    /// above READ_GAS's 100,000, where it failed at every gas limit and the bound read 0. Modelled as a read that refuses
    /// short of 110,000 gas: with its own cap it is answered, and the write-off of the 30 TAO a swap put under the
    /// unlisted HK5 is refused WriteOffTooLarge, the item kept. Before R6 the write-off ran.
    function test_aWriteOffsReadPricedAbove100kStillBoundsIt() public {
        hundredStaked();
        staking.swapHotkey(HK1, HK5, coldkey(), 3_000);
        bytes memory data = scheduleWriteOff(30e9);
        staking.setReadGasFloor(110_000);
        assertEq(vaultLens.unlistedStakeRao(), 30e9, "the lens, uncapped, sees HK5's 30 TAO");
        writeOffRefused(data, WriteOffTooLarge.selector);
        assertEq(booked(), 100e9);
    }

    /// The same at the chain's ceiling: the dearest read any coldkey can have today (256 hotkeys, each on 128 subnets
    /// and root: 44,801,875 gas) is still answered within WRITE_OFF_READ_GAS, and the bound holds.
    function test_aWriteOffsReadAtTheChainsCeilingStillBoundsIt() public {
        hundredStaked();
        staking.swapHotkey(HK1, HK5, coldkey(), 3_000);
        bytes memory data = scheduleWriteOff(30e9);
        staking.setReadGasFloor(44_801_875);
        writeOffRefused(data, WriteOffTooLarge.selector);
        assertEq(booked(), 100e9);
    }

    /// The cap is the chain's ceiling for this read (runtime 490: 1,875 + 1,250 per hotkey + 1,250 per position + 12,500
    /// per root position; at most 256 hotkeys in a coldkey's staking set, each on 128 subnets and root), rounded up, and
    /// given whole it still fits one Bittensor transaction (64,998,400) with room: its need at the read, cap x 64/63 plus
    /// requireGasFor's 5,000, is asked again of execute's self-call (another 64/63).
    function test_theWriteOffsReadCapIsTheChainsCeiling() public pure {
        uint256 ceiling = 1_875 + 256 * (1_250 + 129 * 1_250 + 12_500);
        assertEq(ceiling, 44_801_875);
        assertEq(CascadeFormulas.WRITE_OFF_READ_GAS, 45_000_000);
        assertGe(CascadeFormulas.WRITE_OFF_READ_GAS, ceiling, "at least the dearest read the chain can price");
        uint256 atTheRead = CascadeFormulas.WRITE_OFF_READ_GAS * 64 / 63 + 5_000;
        assertLt(atTheRead * 64 / 63 + 500_000, 64_900_000, "fits a transaction under the ceiling");
        assertEq(CascadeFormulas.READ_GAS, 100_000, "the floors' reads keep theirs");
    }

    /// Too little gas for the read's whole cap: InsufficientGas, nothing written off, the item kept (Revision 28's rule,
    /// at the new cap). 45,000,000 is ample for any other path of the execute, and short of the 45.72M the read needs.
    function test_aWriteOffShortOfItsReadsCapRevertsInsufficientGas() public {
        hundredStaked();
        staking.swapHotkey(HK1, HK5, coldkey(), 3_000);
        bytes memory data = scheduleWriteOff(30e9);
        vm.prank(owner);
        (bool ok, bytes memory why) = address(vault).call{gas: 45_000_000}(abi.encodeCall(vault.execute, (data)));
        assertFalse(ok);
        assertEq(why, abi.encodeWithSelector(InsufficientGas.selector), "InsufficientGas");
        assertEq(booked(), 100e9, "nothing written off");
        assertGt(vaultLens.scheduled(keccak256(data)).readyAt, 0, "the item kept");
    }

    /// The execute of a write-off runs within a 64,900,000-gas transaction (Bittensor's per-transaction limit is
    /// 64,998,400), even when its read costs its whole cap (here it burns it: setTotalReadBurnsGas, counted 0, with the
    /// 30 TAO truly lost so the outcome is the same). The least gas limit that runs it is bisected and logged: what ops
    /// must send (not the wallet's estimate).
    function test_aWriteOffsExecuteFitsATransaction() public {
        hundredStaked();
        staking.loseStake(HK1, coldkey(), 30e9);
        bytes memory data = scheduleWriteOff(30e9);
        staking.setTotalReadBurnsGas(true);
        bytes memory call_ = abi.encodeCall(vault.execute, (data));
        uint256 snap = vm.snapshotState();
        // a 64,900,000 transaction less its intrinsic 21,000 and its calldata (at most 16 gas a byte)
        uint256 frame = 64_900_000 - 21_000 - 16 * call_.length;
        vm.prank(owner);
        (bool ok,) = address(vault).call{gas: frame}(call_);
        assertTrue(ok, "runs within a 64,900,000 transaction");
        assertEq(booked(), 70e9);
        // the least limit is requireGasFor's (the read is given its whole cap or nothing runs), so it is bisected over
        // a read that answers at once, not one that burns 45M a step
        vm.revertToState(snap);
        staking.setTotalReadBurnsGas(false);
        snap = vm.snapshotState();
        uint256 lo = 45_000_000;
        uint256 hi = frame;
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            vm.revertToState(snap);
            vm.prank(owner);
            (ok,) = address(vault).call{gas: mid}(call_);
            if (ok) hi = mid;
            else lo = mid;
        }
        vm.revertToState(snap);
        emit log_named_uint("least gas the execute's frame needs", hi);
        emit log_named_uint("as a transaction (+ 21,000 + calldata)", hi + 21_000 + 16 * call_.length);
        assertLt(hi + 21_000 + 16 * call_.length, 47_000_000, "about 46.5M");
    }

    /// The same for the floors' reads (CascadeFormulas.minStakeRao): with the chain's minimum raised to 5 TAO, a stranger
    /// cannot list HK5, which a swap gave 1 TAO of the vault's root stake, while stake is missing (NotEligible: below
    /// the chain's minimum); starved, the read would answer the 0.002 TAO fallback and the listing would go. Over every
    /// gas limit from 60,000 to 600,000, 2,000 apart, none lists it.
    function test_noGasLimitStarvesTheFloorsReadIntoAListing() public {
        hundredStaked();
        staking.swapHotkey(HK1, HK5, coldkey(), 100);
        assertTrue(missing());
        staking.setMinStake(5e9);
        vm.prank(stranger);
        vm.expectRevert(NotEligible.selector);
        vault.addHotkey(HK5);
        staking.setReadGasFloor(90_000);
        (uint256 starved, uint256 refused) =
            _scanGas(stranger, abi.encodeCall(vault.addHotkey, (HK5)), NotEligible.selector);
        assertGt(starved, 0, "short of the read's cap: InsufficientGas");
        assertGt(refused, 0, "the read given its cap: NotEligible");
        assertFalse(vaultLens.isHotkey(HK5), "never listed");
    }

    /// `caller`'s call of the vault with `data` at every gas limit from 60,000 to 600,000, 2,000 apart, each in a
    /// snapshot: none may succeed; how many reverted InsufficientGas and how many `refusal`.
    function _scanGas(address caller, bytes memory data, bytes4 refusal)
        internal
        returns (uint256 starved, uint256 refused)
    {
        return _scanGas(caller, data, refusal, 60_000, 600_000);
    }

    /// The same from `from` to `to`, 2,000 apart.
    function _scanGas(address caller, bytes memory data, bytes4 refusal, uint256 from, uint256 to)
        internal
        returns (uint256 starved, uint256 refused)
    {
        for (uint256 g = from; g <= to; g += 2_000) {
            uint256 snap = vm.snapshotState();
            vm.prank(caller);
            (bool ok, bytes memory why) = address(vault).call{gas: g}(data);
            vm.revertToState(snap);
            assertFalse(ok, string.concat("went at a gas limit of ", vm.toString(g)));
            if (keccak256(why) == keccak256(abi.encodeWithSelector(InsufficientGas.selector))) ++starved;
            else if (keccak256(why) == keccak256(abi.encodeWithSelector(refusal))) ++refused;
        }
    }

    /// Security check (d): writeOffMissingStake runs only as execute's self-call (NotScheduled for the owner, the
    /// guardian, the keeper, a stranger and the vault itself), scheduled in the Registry class (7 days) and the
    /// Ordinary kind, so the guardian may cancel it; executed a second early it is NotReady.
    function test_writeOffScheduledSevenDaysGuardianCancels() public {
        hundredStaked();
        staking.loseStake(HK1, coldkey(), 30e9);
        address[5] memory callers = [owner, guardian, keeper, stranger, address(vault)];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(NotScheduled.selector);
            vault.writeOffMissingStake(30e9);
        }

        bytes memory data = writeOffData(30e9);
        bytes32 id = keccak256(data);
        uint64 readyAt = uint64(vm.getBlockTimestamp() + 7 days);
        vm.expectEmit(address(vault));
        emit Scheduled(id, Kind.Ordinary, vault.writeOffMissingStake.selector, readyAt, data);
        vm.prank(owner);
        vault.schedule(data);
        Item memory it = vaultLens.scheduled(id);
        assertEq(uint8(it.class), uint8(Delay.Registry), "the Registry class");
        assertEq(uint8(it.kind), uint8(Kind.Ordinary), "Ordinary: the guardian may cancel it");
        assertEq(it.readyAt, readyAt);

        vm.expectEmit(address(vault));
        emit Cancelled(id, guardian);
        vm.prank(guardian);
        vault.cancel(id);
        Schedule.wait(7 days);
        vm.prank(owner);
        vm.expectRevert(NoProposal.selector);
        vault.execute(data);
        assertEq(booked(), 100e9, "vetoed");

        vm.prank(owner);
        vault.schedule(data);
        readyAt = uint64(vm.getBlockTimestamp() + 7 days);
        Schedule.warpTo(readyAt - 1);
        vm.prank(owner);
        vm.expectRevert(NotReady.selector);
        vault.execute(data);
        Schedule.warpTo(readyAt);
        executeWriteOff(data, 30e9);
        assertEq(booked(), 70e9);
    }

    /// Security check (e): the write-off is Ordinary, so it cannot be scheduled while the exits are closed (the
    /// guardian's or the owner's pause, the primary bridge disabled, the launch door removed: ExitsNotOpen), and a
    /// closure during its notice kills it even once the exits reopen.
    function test_writeOffNotSchedulableWhileClosed() public {
        hundredStaked();
        staking.loseStake(HK1, coldkey(), 30e9);
        bytes memory data = writeOffData(30e9);
        uint256 snap = vm.snapshotState();
        address[2] memory pausers = [guardian, owner];
        for (uint256 i; i < pausers.length; ++i) {
            vm.prank(pausers[i]);
            vault.pause();
            Schedule.wait(1);
            vm.prank(owner);
            vm.expectRevert(ExitsNotOpen.selector);
            vault.schedule(data);
            vm.revertToState(snap);
        }
        vm.prank(guardian);
        vault.disableBridge(address(bridge));
        Schedule.wait(1);
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        vault.schedule(data);
        vm.revertToState(snap);
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, frontDoor);
        Schedule.wait(1);
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        vault.schedule(data);
        vm.revertToState(snap);

        // scheduled while open, then a pause and an unpause during its notice: killed
        vm.prank(owner);
        vault.schedule(data);
        Schedule.wait(1 hours);
        vm.prank(guardian);
        vault.pause();
        vm.prank(owner);
        vault.unpause();
        Schedule.wait(7 days);
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        vault.execute(data);
        assertEq(booked(), 100e9);
    }

    /// The T12 review's carry: a gift onto an unlisted hotkey of the vault's coldkey counts as unlisted and can block
    /// a write-off (w + unlisted > missing). The answer is listing that hotkey: by a stranger while stake is missing
    /// and the gift is at least the chain's minimum, else by the owner; the write-off then goes through, or becomes
    /// unnecessary. 10 TAO lost; a gift of 5 TAO, of all 10, then of 0.001 TAO (below the minimum) onto HK5.
    function test_anUnlistedGiftBlocksAWriteOffUntilItsHotkeyIsListed() public {
        hundredStaked();
        staking.loseStake(HK1, coldkey(), 10e9);
        bytes memory data = scheduleWriteOff(10e9);
        uint256 snap = vm.snapshotState();

        staking.donateStake(HK5, coldkey(), 5e9);
        assertEq(vaultLens.unlistedStakeRao(), 5e9);
        writeOffRefused(data, WriteOffTooLarge.selector);
        vm.prank(stranger);
        vault.addHotkey(HK5);
        assertEq(vaultLens.missingStakeRao(), 5e9);
        assertEq(vaultLens.unlistedStakeRao(), 0);
        executeWriteOff(data, 5e9);
        assertEq(booked(), 95e9);
        assertFalse(missing());

        vm.revertToState(snap);
        staking.donateStake(HK5, coldkey(), 10e9);
        writeOffRefused(data, WriteOffTooLarge.selector);
        vm.prank(stranger);
        vault.addHotkey(HK5);
        assertEq(vaultLens.missingStakeRao(), 0, "the gift filled the gap");
        assertFalse(missing());
        executeWriteOff(data, 0);
        assertEq(booked(), 100e9, "nothing written off");

        vm.revertToState(snap);
        staking.donateStake(HK5, coldkey(), 1_000_000);
        writeOffRefused(data, WriteOffTooLarge.selector);
        vm.prank(stranger);
        vm.expectRevert(NotEligible.selector);
        vault.addHotkey(HK5);
        vm.prank(owner);
        vault.addHotkey(HK5);
        executeWriteOff(data, 10e9 - 1_000_000);
        assertEq(booked(), visible());
        assertFalse(missing());
    }
}
