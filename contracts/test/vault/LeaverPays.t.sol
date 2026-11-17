// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ISTAKING_ADDRESS, IStaking} from "../../src/interfaces/IStaking.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {FeeTooHigh, UnstakeShort, ZeroAmount} from "../../src/CascadeErrors.sol";
import {
    DepositBounced,
    PayoutChunkSent,
    Redeemed,
    RedeemedDirect,
    ShortfallAbsorbed,
    Unstaked
} from "../../src/CascadeEvents.sol";
import {PayoutBatch} from "../../src/CascadeTypes.sol";
import {VaultTestBase} from "../VaultTestBase.sol";

/// The leaver pays (Task 36b; spec §3.3, Revision 23; the founder's ruling of 2026-11-06: "Holders never pay for
/// someone else's exit"): every cost an exit causes falls on the party exiting, rounded in the vault's favour, and an
/// exit that cannot cover its own cost is refused, never subsidised. The walk counts the stake it takes at face value,
/// so a removal fee never sends it to a further position; what the chain keeps of that stake is the exit's cost. A
/// direct exit is paid floorToRao(out - unmet - cost) (ShortfallAbsorbed: unmet + cost), refused ZeroAmount at 0; a
/// payout chunk's entries bear charged + cost pro rata (PayoutChunkSent's unstakeCost), refused FeeTooHigh when that
/// would leave an entry nothing, and UnstakeShort unless the liquidity read before the walk and its receipts fund the
/// send. The design note's scripted pins, at fees the mock charges per removal (mainnet charges 0 today).
contract LeaverPaysTest is VaultTestBase {
    uint256 constant RAO = 1e9;
    /// The vault's SHORTFALL_TOLERANCE_RAO, restated in wei.
    uint256 constant T = 1_000 * RAO;
    /// A second door's chain, the redeem origin that makes a BASE door's deposit bounce (spec §3.4).
    uint64 constant OPTIMISM = 10;

    /// Exact stake reads: the removal fee is each test's only cost.
    function setUp() public override {
        super.setUp();
        staking.setOneRaoShort(false);
    }

    // ---- helpers ----

    function stakeOf(bytes32 h) internal view returns (uint256) {
        return staking.getStake(h, vaultLens.coldkey(), 0);
    }

    function stake() internal {
        vm.prank(keeper);
        vault.stakeIdle();
    }

    /// `user`'s direct redeem of `shares`; what it paid.
    function redeem(address user, uint256 shares) internal returns (uint256 got) {
        uint256 before = user.balance;
        vm.prank(user);
        vault.redeemDirect(shares, false);
        got = user.balance - before;
    }

    /// The owner lists `h` and `rao` of HK1's stake moves onto it within the set.
    function listAndMove(bytes32 h, uint256 rao) internal {
        vm.prank(owner);
        vault.addHotkey(h);
        vm.prank(address(vault));
        staking.moveStake(HK1, h, 0, 0, rao);
    }

    /// The hotkeys of the vault's Unstaked logs in `logs`, in order.
    function unstakedFrom(Vm.Log[] memory logs) internal view returns (bytes32[] memory hs) {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == Unstaked.selector) ++n;
        }
        hs = new bytes32[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == Unstaked.selector) {
                hs[n++] = logs[i].topics[1];
            }
        }
    }

    /// `user`'s redeem origin set to OPTIMISM, whose door is activated first if it is not: its BASE door deposits
    /// bounce (ForeignOrigin), queued as 0-share entries.
    function foreign(address user) internal {
        if (vaultLens.activeDoors(OPTIMISM) == 0) registerFrontDoor(OPTIMISM, makeAddr("door10"));
        vm.prank(user);
        vault.setRedeemOrigin(OPTIMISM);
    }

    /// One BASE door batch of `deposits` and `redeems`, its ordered payout list rebuilt from the delivery's
    /// DepositBounced and Redeemed events in log order (the keeper's rebuild, spec §3.10.15).
    function queue(CascadeMessages.Entry[] memory deposits, CascadeMessages.Entry[] memory redeems)
        internal
        returns (bytes32 key, CascadeMessages.Payout[] memory list)
    {
        vm.recordLogs();
        key = deliver(BASE, frontDoor, ++nextBatchId, deposits, redeems);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        list = new CascadeMessages.Payout[](logs.length);
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(vault) || l.topics.length < 3 || l.topics[1] != key) continue;
            // casting to 'uint160' is safe because the topic is an indexed address
            // forge-lint: disable-next-line(unsafe-typecast)
            address user = address(uint160(uint256(l.topics[2])));
            if (l.topics[0] == DepositBounced.selector) {
                (uint256 assets,) = abi.decode(l.data, (uint256, uint8));
                list[n++] = CascadeMessages.Payout(user, 0, assets);
            } else if (l.topics[0] == Redeemed.selector) {
                (uint256 shares, uint256 assets) = abi.decode(l.data, (uint256, uint256));
                list[n++] = CascadeMessages.Payout(user, shares, assets);
            }
        }
        CascadeMessages.Payout[] memory cut = new CascadeMessages.Payout[](n);
        for (uint256 i; i < n; ++i) {
            cut[i] = list[i];
        }
        list = cut;
    }

    function two(address a, uint256 x, address b, uint256 y) internal pure returns (CascadeMessages.Entry[] memory e) {
        e = new CascadeMessages.Entry[](2);
        e[0] = CascadeMessages.Entry(a, x);
        e[1] = CascadeMessages.Entry(b, y);
    }

    /// An entry of `assets` after its share of `charge` over a chunk of `sum`: the share rounded up, the rest floored
    /// to rao (spec §3.3's split, restated here, not the library's).
    function netOf(uint256 assets, uint256 charge, uint256 sum) internal pure returns (uint256 net) {
        uint256 share = Math.mulDiv(assets, charge, sum, Math.Rounding.Ceil);
        net = assets > share ? assets - share : 0;
        net -= net % RAO;
    }

    // ---- direct exits ----

    /// The design note's example: Alice holds 100 TAO on HK1 and redeems 10 TAO with nothing liquid, at a removal fee
    /// of 50,000 rao. Before Task 36b her exit reverted UnstakeShort (HK1 the only position, the receipt 50,000 rao
    /// short, more than T). Now: one removal of 10,000,000,000 rao, Alice paid 9.99995 TAO (ShortfallAbsorbed of the
    /// 50,000 rao), and the stayers' price unchanged.
    function test_theNotesExampleAtFiftyThousandRao() public {
        depositDirect(alice, 100e18);
        stake();
        uint256 price = vaultLens.price();
        staking.setRemoveFeeRao(50_000);

        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 10_000_000_000, 0)));
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 10_000_000_000, 10e18 - 50_000 * RAO);
        vm.expectEmit(address(vault));
        emit ShortfallAbsorbed(50_000 * RAO);
        vm.expectEmit(address(vault));
        emit RedeemedDirect(alice, 1e25, 9.99995e18, false);
        vm.recordLogs();
        assertEq(redeem(alice, 1e25), 9.99995e18, "Alice paid 9.99995 TAO");
        assertEq(unstakedFrom(vm.getRecordedLogs()).length, 1, "one removal");
        assertEq(stakeOf(HK1), 90_000_000_000);
        assertEq(address(vault).balance, ED, "ED_RESERVE untouched, nothing idle");
        assertEq(vaultLens.price(), price, "the stayers' price unchanged");
    }

    /// A multi-position walk at a fee above T (1,001 and 50,000 rao): HK1, the stake hotkey, 30 TAO, HK2 40 and HK3 30.
    /// A 10 TAO exit takes 10 TAO of HK1, which covers it at face value, and the walk ends there: one partial removal,
    /// HK2 and HK3 untouched, the leaver paid 10 TAO less the fee, the price unchanged.
    function test_aFeeAboveTEndsTheWalkAtOnePartialRemoval() public {
        depositDirect(alice, 100e18);
        stake();
        listAndMove(HK2, 40_000_000_000);
        listAndMove(HK3, 30_000_000_000);
        uint256[2] memory fees = [uint256(1_001), 50_000];
        for (uint256 i; i < 2; ++i) {
            uint256 snap = vm.snapshotState();
            staking.setRemoveFeeRao(fees[i]);
            uint256 price = vaultLens.price();
            vm.recordLogs();
            assertEq(redeem(alice, 1e25), 10e18 - fees[i] * RAO, "paid 10 TAO less the fee");
            bytes32[] memory walked = unstakedFrom(vm.getRecordedLogs());
            assertEq(walked.length, 1, "one removal");
            assertEq(walked[0], HK1);
            assertEq(stakeOf(HK1), 20_000_000_000, "HK1 partial");
            assertEq(stakeOf(HK2), 40_000_000_000, "HK2 untouched");
            assertEq(stakeOf(HK3), 30_000_000_000, "HK3 untouched");
            assertEq(vaultLens.price(), price, "the price unchanged");
            vm.revertToState(snap);
        }
    }

    /// A walk across a whole first position and a partial second pays every removal's fee: HK1 5 TAO, HK2 95; a 10 TAO
    /// exit takes HK1 whole and 5 TAO of HK2, the leaver paid 10 TAO less two fees (before Task 36b, the holders bore
    /// HK1's). And a whole position larger than the ask: HK1 10.01 TAO, its remainder after a 10 TAO ask under the
    /// chain's minimum remainder, so the walk takes it whole; the leaver pays the one fee and the 0.01 TAO excess sits
    /// idle at full value. Either way the stayers' price does not move.
    function test_everyRemovalsFeeIsTheExits() public {
        depositDirect(alice, 100e18);
        stake();
        uint256 snap = vm.snapshotState();
        uint256 fee = 50_000;

        listAndMove(HK2, 95_000_000_000);
        staking.setRemoveFeeRao(fee);
        uint256 price = vaultLens.price();
        vm.recordLogs();
        assertEq(redeem(alice, 1e25), 10e18 - 2 * fee * RAO, "paid 10 TAO less two fees");
        bytes32[] memory walked = unstakedFrom(vm.getRecordedLogs());
        assertEq(walked.length, 2);
        assertEq(stakeOf(HK1), 0, "HK1 whole");
        assertEq(stakeOf(HK2), 90_000_000_000, "HK2 asked the 5 TAO left, at face value");
        assertEq(address(vault).balance, ED);
        assertEq(vaultLens.price(), price, "the price unchanged");

        vm.revertToState(snap);
        listAndMove(HK2, 89_990_000_000);
        assertEq(stakeOf(HK1), 10_010_000_000);
        staking.setRemoveFeeRao(fee);
        price = vaultLens.price();
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStakeFull, (HK1, 0)));
        assertEq(redeem(alice, 1e25), 10e18 - fee * RAO, "paid 10 TAO less the one fee");
        assertEq(stakeOf(HK1), 0);
        assertEq(stakeOf(HK2), 89_990_000_000, "HK2 untouched");
        assertEq(address(vault).balance, ED + 0.01e18, "the excess idle at full value");
        assertEq(vaultLens.price(), price, "the price unchanged");
    }

    /// The walk's cost rounds up to rao, in the vault's favour: on a chain that kept a fraction of a rao of a removal
    /// (the mock's wei fee; Bittensor floors transfers to rao, so the rounding is defensive), the leaver bears a whole
    /// rao. Alice's 10 TAO exit with nothing liquid receives half a rao less than the 10e9 rao its walk takes, and is
    /// paid 10 TAO less a whole rao (ShortfallAbsorbed of a rao): the half rao it did not cost stays the holders'.
    function test_aSubRaoCostRoundsUpToTheLeaver() public {
        depositDirect(alice, 100e18);
        stake();
        uint256 price = vaultLens.price();
        staking.setRemoveFeeWei(RAO / 2);
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 10_000_000_000, 10e18 - RAO / 2);
        vm.expectEmit(address(vault));
        emit ShortfallAbsorbed(RAO);
        vm.expectEmit(address(vault));
        emit RedeemedDirect(alice, 1e25, 10e18 - RAO, false);
        assertEq(redeem(alice, 1e25), 10e18 - RAO, "paid a whole rao less");
        assertEq(address(vault).balance, ED + RAO / 2, "the half rao the vault's");
        assertGt(vaultLens.price(), price, "the holders gain the rounding");
    }

    /// A dust exit that would be paid 0 is refused and keeps its shares (VaultExits' test_dustExitBelowTheShortfall-
    /// IsRefused is the within-T case); here the walk's cost eats it: at a 4,000,000-rao fee, above the chain's
    /// minimum stake, a 0.001 TAO exit with nothing liquid walks the minimum stake (2,000,000 rao) and receives
    /// nothing for it, so its cost leaves it nothing: ZeroAmount, nothing burned, the stake where it was.
    function test_anExitItsWalksCostLeavesNothingIsRefused() public {
        depositDirect(alice, 100e18);
        stake();
        staking.setRemoveFeeRao(4_000_000);
        uint256 price = vaultLens.price();
        // 1e21 shares: 1e21 * (100e18 + 1) / (1e26 + 1e6) = 0.001 TAO
        vm.prank(alice);
        vm.expectRevert(ZeroAmount.selector);
        vault.redeemDirect(1e21, false);
        assertEq(vault.balanceOf(alice), 1e26, "the shares kept");
        assertEq(stakeOf(HK1), 100_000_000_000, "the stake where it was");
        assertEq(address(vault).balance, ED);
        assertEq(vaultLens.price(), price);
        // a larger exit pays its own fee
        assertEq(redeem(alice, 1e24), 1e18 - 4_000_000 * RAO, "0.996 TAO");
        assertEq(vaultLens.price(), price, "the stayers' price unchanged");
    }

    // ---- payout chunks ----

    /// A chunk whose walk's cost is shared pro rata, a bounce included: carol 100 TAO directly, alice 5 TAO and bob 3
    /// TAO through the door, all staked; one batch holds gina's 0.05 TAO bounce (liquid) ahead of alice's and bob's
    /// whole redeems. At a 50,000-rao removal fee the chunk walks what the bounce's liquid TAO does not cover, and its
    /// three entries bear the bridge's 0.001 TAO and the 50,000 rao together, each its share rounded up and its net
    /// floored to rao: the bridge receives net + fee, the front door's message credits them in order, PayoutChunkSent
    /// logs the cost, the cushion stays idle whole, and the holders' price does not move.
    function test_aChunksWalkCostIsSharedProRataABounceIncluded() public {
        depositDirect(carol, 100e18);
        depositVia(alice, 5e18);
        depositVia(bob, 3e18);
        stake();
        address gina = makeAddr("gina");
        foreign(gina);
        (bytes32 key, CascadeMessages.Payout[] memory list) =
            queue(entries1(gina, 0.05e18), two(alice, vault.balanceOf(alice), bob, vault.balanceOf(bob)));
        assertEq(list.length, 3);
        assertEq(list[0].user, gina, "the bounce first");
        assertEq(list[0].shares, 0);
        assertEq(list[1].assets, 5e18);
        assertEq(list[2].assets, 3e18);
        uint256 sum = 8.05e18;
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        staking.setRemoveFeeRao(50_000);
        uint256 price = vaultLens.price();

        // free = the bounce's 0.05 TAO; the walk asks the rest of net + charged, and T more: one partial removal
        uint256 cost = 50_000 * RAO;
        uint256 charge = 1e15 + cost;
        CascadeMessages.Entry[] memory credits = new CascadeMessages.Entry[](3);
        uint256 net;
        uint256 need = 1e15;
        for (uint256 i; i < 3; ++i) {
            credits[i] = CascadeMessages.Entry(list[i].user, netOf(list[i].assets, charge, sum));
            net += credits[i].amount;
            need += netOf(list[i].assets, 1e15, sum);
        }
        // the walk's ask, need - free + T, in rao, and what it receives at the fee
        uint256 received = ((need - 0.05e18 + T) / RAO - 50_000) * RAO;
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(key, 0, 3, sum, net, 1e15, 1e15, cost);
        vault.processPayouts(key, list, 10);
        assertEq(bridge.lastValue(), net + 1e15, "the bridge receives net + fee");
        assertEq(bridge.lastAmount(), net);
        assertEq(bridge.lastMessage(), CascadeMessages.encodePayouts(key, 0, credits), "the credits, in order");
        assertLt(credits[0].amount, netOf(0.05e18, 1e15, sum), "the bounce bore its share of the cost");
        assertEq(vaultLens.pendingPayouts(), 0);
        assertEq(vaultLens.getPayoutBatch(key).count, 0);
        assertEq(address(vault).balance, ED + 0.05e18 + received - net - 1e15, "what the receipts and free leave, idle");
        assertGe(address(vault).balance, ED, "ED_RESERVE untouched");
        assertGe(vaultLens.price(), price, "the holders' price unmoved");
    }

    /// The FeeTooHigh threshold (spec §3.3, I-14): the smallest entry with shares, 0.03 TAO (MIN_REDEEM_VALUE), alone in
    /// its chunk, at a bridge fee at the ceiling (0.015 TAO, charged in full), so its net is 0.015 TAO before the walk.
    /// The walk's cost k x F leaves it 1 or 2 rao when k x F is just below 0.015 TAO (one removal of 14,999,999 rao;
    /// two of 7,499,999), and nothing at 0.015 TAO (one of 15,000,000; two of 7,500,000): FeeTooHigh, nothing moved.
    /// The refused chunk is then paid without a walk once a delivery's deposit is liquid: less the bridge fee's share
    /// alone.
    function test_theFeeTooHighThresholdOfAWalksCost() public {
        depositDirect(alice, 100e18);
        stake();
        // 3e22 shares: 3e22 * (100e18 + 1) / (1e26 + 1e6) = 0.03 TAO
        vm.prank(alice);
        vault.setRedeemOrigin(BASE);
        (bytes32 key, CascadeMessages.Payout[] memory list) = queue(noEntries(), entries1(alice, 3e22));
        assertEq(list[0].assets, 0.03e18, "the smallest entry");
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        bridge.setFee(0.015e18);

        uint256[4] memory fees = [uint256(14_999_999), 15_000_000, 7_499_999, 7_500_000];
        for (uint256 i; i < 4; ++i) {
            uint256 snap = vm.snapshotState();
            // two removals: HK1 (the stake hotkey) holds 0.02 TAO, taken whole, and HK2 the rest
            if (i >= 2) listAndMove(HK2, stakeOf(HK1) - 20_000_000);
            staking.setRemoveFeeRao(fees[i]);
            uint256 k = i >= 2 ? 2 : 1;
            if (k * fees[i] < 15_000_000) {
                vault.processPayouts(key, list, 10);
                uint256 left = 15_000_000 - k * fees[i];
                assertEq(bridge.lastAmount(), left * RAO, "the entry keeps what the cost leaves it");
                assertEq(bridge.lastValue(), left * RAO + 0.015e18);
            } else {
                vm.expectRevert(FeeTooHigh.selector);
                vault.processPayouts(key, list, 10);
                assertEq(vaultLens.pendingPayouts(), 0.03e18, "nothing moved");
            }
            vm.revertToState(snap);
        }

        // refused at 0.015 TAO, then a delivery's deposit lands liquid: the chunk needs no walk and costs nothing
        staking.setRemoveFeeRao(15_000_000);
        vm.expectRevert(FeeTooHigh.selector);
        vault.processPayouts(key, list, 10);
        depositVia(bob, 1e18);
        vm.recordLogs();
        vault.processPayouts(key, list, 10);
        assertEq(unstakedFrom(vm.getRecordedLogs()).length, 0, "no walk");
        assertEq(bridge.lastAmount(), 0.015e18, "less the bridge fee's share alone");
    }

    /// The same threshold for a bounce at the door's floor (0.03 TAO, its 0-share entry alone in its chunk): a walk's
    /// cost that would leave it nothing makes it dust that the first split did not, which the dust count refuses
    /// FeeTooHigh (I-14: no PayoutDust from a walk's cost); just below, it is sent with a rao. A bounce's TAO arrives
    /// liquid, so its chunk walks only while other batches' staked reservations hold the free balance down: here a
    /// queued 50 TAO payout whose reservation is still staked.
    function test_aBounceAWalksCostWouldZeroIsRefused() public {
        depositVia(bob, 100e18);
        stake();
        // bob's 50 TAO queued first, staked; then gina's 0.03 TAO bounce in a batch of its own
        queue(noEntries(), entries1(bob, 5e25));
        address gina = makeAddr("gina");
        foreign(gina);
        (bytes32 key, CascadeMessages.Payout[] memory list) = queue(entries1(gina, 0.03e18), noEntries());
        assertEq(list[0].shares, 0, "a bounce");
        assertEq(list[0].assets, 0.03e18);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        bridge.setFee(0.015e18);
        uint256 snap = vm.snapshotState();

        staking.setRemoveFeeRao(14_999_999);
        vault.processPayouts(key, list, 10);
        assertEq(bridge.lastAmount(), RAO, "sent with a rao");

        vm.revertToState(snap);
        staking.setRemoveFeeRao(15_000_000);
        vm.expectRevert(FeeTooHigh.selector);
        vault.processPayouts(key, list, 10);
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        assertEq(b.remaining, 0.03e18, "the bounce still reserved");
    }

    /// The coverage check (spec §3.3: UnstakeShort unless the liquidity read before the walk and the walk's receipts fund
    /// net + charged; I-12 as code), in the walk's whole-removal corner: the walk takes HK1 (here the only listed
    /// position) whole and leaves exactly T untaken, and the second split's rounding (each entry's share rounded up, its
    /// net floored to rao) leaves the entries a rao more than the receipts bring. Alice's and Bob's 1 TAO redeems in
    /// one chunk, the bridge fee 1,000,001 rao (so each entry's first share is half a rao off whole and floors to it), a
    /// 1-rao removal fee (so the second split is whole), and HK1 holding exactly need - free (a rao moved off the set):
    /// the vault refuses UnstakeShort rather than pay a rao from ED_RESERVE, and nothing moves. The next pin shows the
    /// same corner with another listed position holding plenty.
    function test_theCoverageCheckRefusesTheCorner() public {
        depositVia(alice, 1e18);
        depositVia(bob, 1e18);
        stake();
        (bytes32 key, CascadeMessages.Payout[] memory list) =
            queue(noEntries(), two(alice, vault.balanceOf(alice), bob, vault.balanceOf(bob)));
        assertEq(list[0].assets, 1e18);
        assertEq(list[1].assets, 1e18);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        bridge.setFee(1_000_001 * RAO);
        // need = net + charged: each net 1e18 - 500,000.5 rao floored, so 2e18 - 1 rao in all; HK1 holds a rao less
        // than the 2 TAO staked, so the walk takes it whole and leaves exactly T untaken
        vm.prank(address(vault));
        staking.moveStake(HK1, HK5, 0, 0, 1);
        assertEq(stakeOf(HK1), 1_999_999_999);
        staking.setRemoveFeeRao(1);

        vm.expectRevert(UnstakeShort.selector);
        vault.processPayouts(key, list, 10);
        assertEq(bridge.sendCount(), 0, "nothing sent");
        assertEq(stakeOf(HK1), 1_999_999_999, "the walk undone");
        assertEq(address(vault).balance, ED, "ED_RESERVE untouched");
        assertEq(vaultLens.pendingPayouts(), 2e18);

        // with the rao back in the set the receipts fund the chunk exactly: sent, ED_RESERVE whole
        vm.prank(address(vault));
        staking.moveStake(HK5, HK1, 0, 0, 1);
        vault.processPayouts(key, list, 10);
        assertEq(bridge.sendCount(), 1);
        assertEq(address(vault).balance, ED, "ED_RESERVE whole");
    }

    /// The same corner with plenty of stake on a second listed position (Task 36b's review, Important 1; spec §3.3,
    /// I-13's carve-out): the walk stops once at most T is unmet whether or not positions remain, so it takes HK1 (the
    /// stake hotkey, holding exactly need - free) whole, leaves exactly T untaken and never tries HK2 (10 TAO and a
    /// rao), and the second split leaves the entries a rao more than the receipts: UnstakeShort, nothing moved. The
    /// keeper cannot pick a smaller chunk (minChunk 10 folds the tail back in). It needs a removal fee, puts no money at
    /// risk, and clears once the balance or the positions move: after a direct deposit the walk takes part of HK1, the
    /// chunk is sent at the second split's nets, the cushion less the walk's cost stays idle, HK2 is still untouched and
    /// the price does not move.
    function test_theCornerWaitsWithAnotherPositionHoldingPlenty() public {
        depositVia(alice, 1e18);
        depositVia(bob, 1e18);
        depositDirect(carol, 10e18);
        stake();
        (bytes32 key, CascadeMessages.Payout[] memory list) =
            queue(noEntries(), two(alice, vault.balanceOf(alice), bob, vault.balanceOf(bob)));
        assertEq(list.length, 2);
        assertEq(list[0].assets, 1e18);
        assertEq(list[1].assets, 1e18);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        bridge.setFee(1_000_001 * RAO);
        // need - free = 2 x (1e18 - 500,000.5 rao, floored) + 1,000,001 rao = 2e18 - 1 rao: HK1, the stake hotkey, holds
        // exactly that, and HK2, listed, the other 10 TAO and a rao
        listAndMove(HK2, 10_000_000_001);
        assertEq(stakeOf(HK1), 1_999_999_999);
        assertEq(stakeOf(HK2), 10_000_000_001);
        assertFalse(vaultLens.stakeMissing());
        staking.setRemoveFeeRao(1);

        vm.expectRevert(UnstakeShort.selector);
        vault.processPayouts(key, list, 10);
        vm.expectRevert(UnstakeShort.selector);
        vm.prank(keeper);
        vault.processPayouts(key, list, 1);
        assertEq(bridge.sendCount(), 0, "nothing sent");
        assertEq(stakeOf(HK1), 1_999_999_999, "the walk undone");
        assertEq(stakeOf(HK2), 10_000_000_001, "HK2 never tried");
        assertEq(address(vault).balance, ED, "ED_RESERVE untouched");
        assertEq(vaultLens.pendingPayouts(), 2e18);

        // a direct deposit moves the balance: free is 1 TAO, the walk asks HK1 for 1,000,000,999 rao (partial), receives
        // a rao less, and the second split on 1,000,002 rao nets each entry 999,499,999 rao
        depositDirect(makeAddr("dave"), 1e18);
        uint256 price = vaultLens.price();
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(key, 0, 2, 2e18, 2 * 999_499_999 * RAO, 1_000_001 * RAO, 1_000_001 * RAO, RAO);
        vault.processPayouts(key, list, 10);
        assertEq(bridge.sendCount(), 1, "sent once the state moves");
        assertEq(stakeOf(HK1), 999_999_000, "HK1 partial");
        assertEq(stakeOf(HK2), 10_000_000_001, "HK2 still untouched");
        assertEq(address(vault).balance, ED + 999 * RAO, "the cushion idle, less the walk's cost");
        assertEq(vaultLens.price(), price, "the price unmoved");
    }
}
