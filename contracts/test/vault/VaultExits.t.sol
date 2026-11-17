// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {ISTAKING_ADDRESS, IStaking} from "../../src/interfaces/IStaking.sol";
import {CascadeMath} from "../../src/libraries/CascadeMath.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {PayoutBatch} from "../../src/CascadeTypes.sol";
import {InvalidParameter, NothingToStake, UnstakeShort, ZeroAmount} from "../../src/CascadeErrors.sol";
import {
    LimitSet,
    PayoutChunkSent,
    RedeemedDirect,
    ShortfallAbsorbed,
    StakeMoved,
    Staked,
    UnstakeSkipped,
    Unstaked
} from "../../src/CascadeEvents.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {Schedule} from "../governance/Schedule.sol";
import {VaultTestBase} from "../VaultTestBase.sol";

/// The shortfall rule, and the leaver pays (spec §3.3, §3.10.11, round 8 H-1; Task 19; Task 36b, the founder's ruling
/// of 2026-11-06): an exit is funded by the liquid TAO above ED_RESERVE and the queued payouts' reservations, read
/// once before the walk, plus its own unstake receipts. The walk counts the stake it takes, at face value, against
/// its request, and stops once what is unmet is within T = SHORTFALL_TOLERANCE_RAO (1,000 rao); what the chain kept
/// of that stake (its removal fee) is the exit's cost. A direct exit asks for what it needs: the leaver bears what is
/// unmet and the cost (ShortfallAbsorbed), and is refused ZeroAmount when that leaves it nothing. A payout chunk asks
/// T more than it needs, and its entries bear the cost pro rata (PayoutChunkSent's unstakeCost); the cushion stays
/// idle whole. More than T left untaken reverts UnstakeShort, either way; a removal fee alone never does.
/// The walk under a root hold (spec §3.8, §3.10.9; Task 20): each removal runs in a `try` with its share of the gas,
/// max(unstakeGas, (gasleft - EXIT_GAS_RESERVE) / positionsLeft), positionsLeft counting once the positions of at
/// least the minimum stake; a refused or gas-burning removal is skipped (UnstakeSkipped) and the walk goes on, so one
/// held pair no longer freezes an exit; the idle buffer (idleBufferBps) keeps TAO liquid for when every pair is held.
contract VaultExitsTest is VaultTestBase {
    uint256 constant RAO = 1e9;
    /// The vault's SHORTFALL_TOLERANCE_RAO, restated in wei: 1,000 rao.
    uint256 constant T = 1_000 * RAO;
    /// CascadeConstants.sol's EXIT_GAS_RESERVE, restated: the gas the walk leaves for the exit's work after it
    /// (2,000,000 since Task 65, about three times the work after the walk the fork measured, Task 61).
    uint256 constant RESERVE = 2_000_000;
    /// How far from EXIT_GAS_RESERVE the gas a payout's bridge send is given may be, once the walk left exactly the
    /// reserve (test_processPayoutsFinishesAfterTheWalk): the 1/64 the calls into L3 and the bridge hold back, L3's
    /// effects before the send, the walk's own tail, less the 1/64 of its gas the vault kept back at the walk's call.
    uint256 constant SEND_SLACK = 100_000;

    /// Exact stake reads: the mock's removal fee (setRemoveFeeRao) is each test's only short receipt.
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

    function redeemVia(address user, uint256 shares) internal returns (bytes32) {
        return deliver(BASE, frontDoor, ++nextBatchId, noEntries(), entries1(user, shares));
    }

    function pay1(address u, uint256 s, uint256 a) internal pure returns (CascadeMessages.Payout[] memory p) {
        p = new CascadeMessages.Payout[](1);
        p[0] = CascadeMessages.Payout(u, s, a);
    }

    /// The owner lists `h` and `rao` of HK1's stake moves onto it within the set (as a validator's own move would;
    /// the booked stake is unchanged, and so is the visible).
    function listAndMove(bytes32 h, uint256 rao) internal {
        vm.prank(owner);
        vault.addHotkey(h);
        vm.prank(address(vault));
        staking.moveStake(HK1, h, 0, 0, rao);
    }

    /// The removals from HK1 and HK3 (test_gasSplitCountsOnlyUnstakeablePositions) were each given `floor`, less the
    /// mock's entry: a few hundred gas, a little more for removeStakeFull's dispatch than for removeStake's.
    function assertFloored(uint256 floor) internal view {
        for (uint256 i; i < 2; ++i) {
            uint256 g = staking.removalGas(i == 0 ? HK1 : HK3);
            assertLt(g, floor, "the floor, less the mock's entry");
            assertGt(g, floor - 2_000, "the floor");
        }
    }

    /// Whether `logs` hold a ShortfallAbsorbed from the vault.
    function absorbedLogged(Vm.Log[] memory logs) internal view returns (bool) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == ShortfallAbsorbed.selector) return true;
        }
        return false;
    }

    /// The hotkeys of the vault's Unstaked logs in `logs`, in order: the positions the walk removed from.
    function unstakedFrom(Vm.Log[] memory logs) internal view returns (bytes32[] memory) {
        return hotkeysLogged(logs, Unstaked.selector);
    }

    /// The hotkeys of the vault's UnstakeSkipped logs in `logs`, in order: the positions the walk skipped (Task 20).
    function skippedFrom(Vm.Log[] memory logs) internal view returns (bytes32[] memory) {
        return hotkeysLogged(logs, UnstakeSkipped.selector);
    }

    /// The indexed hotkey of each of the vault's `topic0` logs in `logs`, in order.
    function hotkeysLogged(Vm.Log[] memory logs, bytes32 topic0) internal view returns (bytes32[] memory hs) {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == topic0) ++n;
        }
        hs = new bytes32[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == topic0) hs[n++] = logs[i].topics[1];
        }
    }

    /// The ledger's ramping stake (wei), through the lens (R2 F4): the walk's receipts come off it.
    function rampingStake() internal view returns (uint256) {
        return vaultLens.rampingStake();
    }

    /// bob deposits 100e18 through the launch door (1e26 shares, his origin BASE) and the keeper stakes it all: HK1
    /// holds 100_000_000_000 rao and the vault only ED. bob's redeem of 5e25 through the door, at A = 100e18,
    /// S = 1e26: 5e25 * (100e18 + 1) / (1e26 + 1e6) = 50e18, queued and reserved while still staked. Then 24 hours
    /// pass. The stub's fee is 1e15, so the chunk's net + fee is 50e18 and nothing liquid covers it.
    function queueStakedPayout() internal returns (bytes32 key, CascadeMessages.Payout[] memory list) {
        depositVia(bob, 100e18);
        stake();
        key = redeemVia(bob, 5e25);
        list = pay1(bob, 5e25, 50e18);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        assertEq(vaultLens.pendingPayouts(), 50e18);
        assertEq(address(vault).balance, ED);
    }

    // ---- redeemDirect ----

    /// A receipt one rao short (the chain keeping a rao of the removal) is the leaver's cost: the walk takes the 10e9
    /// rao the exit asks, the leaver is paid its value less the rao the chain kept, and the vault logs
    /// ShortfallAbsorbed(1 rao). ED_RESERVE is untouched and the stayers' price does not move. An exact receipt costs
    /// nothing and logs no ShortfallAbsorbed.
    function test_oneRaoShortReceiptStillExits() public {
        // 1e26 shares; HK1 100_000_000_000 rao, the balance ED
        depositDirect(alice, 100e18);
        stake();
        uint256 price = vaultLens.price();
        staking.setRemoveFeeRao(1);

        // out = 1e25 * (100e18 + 1) / (1e26 + 1e6) = 10e18; nothing is liquid, so the walk asks 10_000_000_000 rao
        // and receives one rao less
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 10_000_000_000, 0)));
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 10_000_000_000, 10e18 - RAO);
        vm.expectEmit(address(vault));
        emit ShortfallAbsorbed(1e9);
        vm.expectEmit(address(vault));
        emit RedeemedDirect(alice, 1e25, 10e18 - RAO, false);
        assertEq(redeem(alice, 1e25), 10e18 - RAO, "the leaver one rao short");
        assertEq(address(vault).balance, ED, "ED_RESERVE untouched");
        assertEq(stakeOf(HK1), 90_000_000_000);
        assertEq(vaultLens.bookedStake(), 90_000_000_000, "the stake that left");
        assertEq(vault.balanceOf(alice), 9e25);
        assertEq(vaultLens.price(), price, "the stayers' price unchanged");

        // an exact receipt: A = 90e18, S = 9e25, out = 1e25 * (90e18 + 1) / (9e25 + 1e6) = 10e18, paid whole
        staking.setRemoveFeeRao(0);
        vm.recordLogs();
        assertEq(redeem(alice, 1e25), 10e18, "paid whole");
        assertFalse(absorbedLogged(vm.getRecordedLogs()), "nothing absorbed, nothing logged");
        assertEq(address(vault).balance, ED);
    }

    /// An exit worth no more than T with nothing liquid would be paid nothing: what is unmet is within the tolerance
    /// before the walk starts, so no position is stripped of the minimum stake for it, and the exit is refused
    /// ZeroAmount, keeping its shares (an exit that cannot cover its own cost is refused, never subsidised; before Task
    /// 36b it burned them for nothing). The payment is floored to rao, so half a rao of liquid balance is refused too;
    /// a whole rao is paid, the leaver bearing the rest (ShortfallAbsorbed).
    function test_dustExitBelowTheShortfallIsRefused() public {
        depositDirect(alice, 100e18);
        stake();
        uint256 price = vaultLens.price();

        // out = 5e17 * (100e18 + 1) / (1e26 + 1e6) = 5e11, 500 rao
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeWithSelector(IStaking.removeStake.selector), 0);
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeWithSelector(IStaking.removeStakeFull.selector), 0);
        vm.prank(alice);
        vm.expectRevert(ZeroAmount.selector);
        vault.redeemDirect(5e17, false);
        assertEq(vault.balanceOf(alice), 1e26, "the shares kept");
        assertEq(stakeOf(HK1), 100_000_000_000, "no position stripped for it");
        assertEq(address(vault).balance, ED, "ED_RESERVE untouched");
        assertEq(vaultLens.price(), price, "the price unmoved");

        // half a rao liquid: the walk still has nothing to do, and the half rao is floored away: refused
        vm.deal(address(vault), ED + RAO / 2);
        uint256 out = CascadeMath.assetsForRedeem(5e17, vaultLens.totalAssets(), vault.totalSupply());
        out -= out % RAO;
        assertGt(out, RAO / 2);
        assertLe(out, T);
        vm.prank(alice);
        vm.expectRevert(ZeroAmount.selector);
        vault.redeemDirect(5e17, false);
        assertEq(vault.balanceOf(alice), 1e26, "the shares kept");
        assertEq(address(vault).balance, ED + RAO / 2);

        // a whole rao liquid: paid it, the leaver bearing the rest
        vm.deal(address(vault), ED + RAO);
        out = CascadeMath.assetsForRedeem(5e17, vaultLens.totalAssets(), vault.totalSupply());
        out -= out % RAO;
        vm.expectEmit(address(vault));
        emit ShortfallAbsorbed(out - RAO);
        vm.expectEmit(address(vault));
        emit RedeemedDirect(alice, 5e17, RAO, false);
        assertEq(redeem(alice, 5e17), RAO, "a rao paid");
        assertEq(vault.balanceOf(alice), 1e26 - 5e17, "the shares burned");
        assertEq(address(vault).balance, ED);
        assertEq(stakeOf(HK1), 100_000_000_000);
    }

    /// A removal fee one rao past the tolerance is the leaver's too: the walk counts the stake it takes, at face value,
    /// so the one partial removal of HK1 serves the exit, and the leaver is paid its value less the 1,001 rao the chain
    /// kept; exactly T likewise. The stayers' price does not move. UnstakeShort is for stake the walk cannot take:
    /// with HK1's pair held and no other position, the whole request is left untaken, and the exit reverts, burning
    /// nothing and taking nothing from ED_RESERVE.
    function test_aFeeAboveTIsTheLeavers() public {
        depositDirect(alice, 100e18);
        stake();
        uint256 price = vaultLens.price();
        staking.setRemoveFeeRao(1_001);

        // out = 10e18: the walk takes 10_000_000_000 rao of HK1, the only position, and receives 1_001 rao less
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 10_000_000_000, 10e18 - 1_001 * RAO);
        vm.expectEmit(address(vault));
        emit ShortfallAbsorbed(1_001 * RAO);
        vm.expectEmit(address(vault));
        emit RedeemedDirect(alice, 1e25, 10e18 - 1_001 * RAO, false);
        assertEq(redeem(alice, 1e25), 10e18 - 1_001 * RAO, "the leaver bears the fee");
        assertEq(stakeOf(HK1), 90_000_000_000);
        assertEq(address(vault).balance, ED, "ED_RESERVE untouched");
        assertEq(vaultLens.price(), price, "the stayers' price unchanged");

        // exactly the tolerance: out = 1e25 * (90e18 + 1) / (9e25 + 1e6) = 10e18, paid T short
        staking.setRemoveFeeRao(1_000);
        vm.expectEmit(address(vault));
        emit ShortfallAbsorbed(T);
        vm.expectEmit(address(vault));
        emit RedeemedDirect(alice, 1e25, 10e18 - T, false);
        assertEq(redeem(alice, 1e25), 10e18 - T, "T short");
        assertEq(address(vault).balance, ED, "ED_RESERVE untouched");
        assertEq(vaultLens.price(), price, "the stayers' price unchanged");

        // stake the walk cannot take: HK1 held, nothing else listed, so all of it is left untaken
        staking.setPairLocked(HK1, true);
        vm.prank(alice);
        vm.expectRevert(UnstakeShort.selector);
        vault.redeemDirect(1e25, false);
        assertEq(vault.balanceOf(alice), 8e25, "nothing burned");
        assertEq(stakeOf(HK1), 80_000_000_000);
        assertEq(address(vault).balance, ED, "no receipt kept");
    }

    /// Round 8 H-1: a direct exit beside a queued payout whose reservation is still staked (idleBufferBps 0, the
    /// normal case), every receipt one rao short. The liquidity is read once, before the walk, and the check is on
    /// the walk's receipt, so the staked reservation is neither counted as cover nor needed as cover: the exit pays
    /// its receipt, and the reservation and ED_RESERVE stay whole. A re-read balance (ED + the receipt, less the 50e18
    /// still staked for the payout) would refuse this exit. Then the payout is sent under the same fee, less the rao
    /// its walk cost (the entry's to bear): its walk asks T more than the chunk needs, and the cushion stays idle whole.
    function test_directExitBesideAStakedPayoutQueued() public {
        // alice deposits 100e18 directly at A = 100e18, S = 1e26: 1e26 shares; the keeper stakes it, so HK1 holds
        // 200_000_000_000 rao. Then bob's payout of 50e18 is queued, still staked (queueStakedPayout's numbers at
        // A = 200e18, S = 2e26: 5e25 * (200e18 + 1) / (2e26 + 1e6) = 50e18)
        depositVia(bob, 100e18);
        depositDirect(alice, 100e18);
        stake();
        bytes32 key = redeemVia(bob, 5e25);
        CascadeMessages.Payout[] memory list = pay1(bob, 5e25, 50e18);
        assertEq(vaultLens.pendingPayouts(), 50e18);
        assertEq(address(vault).balance, ED);
        assertEq(stakeOf(HK1), 200_000_000_000);
        staking.setRemoveFeeRao(1);

        // A = 200e18 - 50e18 pending, S = 1.5e26: alice's 5e25 is 5e25 * (150e18 + 1) / (1.5e26 + 1e6) = 50e18.
        // Nothing is liquid beyond ED and the reservation, so the walk asks 50_000_000_000 rao and receives one less
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 50_000_000_000, 0)));
        vm.expectEmit(address(vault));
        emit ShortfallAbsorbed(1e9);
        vm.expectEmit(address(vault));
        emit RedeemedDirect(alice, 5e25, 50e18 - RAO, false);
        assertEq(redeem(alice, 5e25), 50e18 - RAO, "the exit pays its receipt");
        assertEq(address(vault).balance, ED, "ED_RESERVE untouched");
        assertEq(vaultLens.pendingPayouts(), 50e18, "the reservation untouched");
        assertEq(stakeOf(HK1), 150_000_000_000);

        // bob's chunk: net + fee = 50e18, nothing liquid; the walk asks 50e18 + T and receives one rao less, which bob
        // bears: his net is 50e18 - 1e15 - 1 rao
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 50_000_001_000, 0)));
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(key, 0, 1, 50e18, 50e18 - 1e15 - RAO, 1e15, 1e15, RAO);
        vault.processPayouts(key, list, 0);
        assertEq(bridge.lastValue(), 50e18 - RAO, "the chunk sent less its walk's cost");
        assertEq(vaultLens.pendingPayouts(), 0);
        assertEq(address(vault).balance, ED + T, "the cushion idle whole");
        assertEq(stakeOf(HK1), 100_000_000_000 - 1_000);
    }

    /// §3.10.11: the walk counts the stake it takes, at face value, and stops once what is unmet is within T, so no
    /// second position is stripped of the minimum stake for a fee of 1 rao, nor of exactly T, nor of one rao past T
    /// (before Task 36b the walk went on to HK2 there, and the holders bore both fees): one removal serves each exit,
    /// and the leaver bears its fee.
    function test_walkStopsWithinTolerance() public {
        depositDirect(alice, 100e18);
        stake();
        // HK2 listed, and half of HK1's stake moved onto it within the set: HK1 (the stake hotkey, walked first)
        // and HK2 hold 50_000_000_000 rao each
        vm.prank(owner);
        vault.addHotkey(HK2);
        vm.prank(address(vault));
        staking.moveStake(HK1, HK2, 0, 0, 50_000_000_000);
        assertEq(stakeOf(HK2), 50_000_000_000);

        // a receipt 1 rao short: out = 10e18 at A = 100e18, S = 1e26; HK1 pays 10_000_000_000 rao less one, and the
        // walk stops there
        staking.setRemoveFeeRao(1);
        vm.recordLogs();
        assertEq(redeem(alice, 1e25), 10e18 - RAO);
        bytes32[] memory walked = unstakedFrom(vm.getRecordedLogs());
        assertEq(walked.length, 1, "one removal for 1 rao");
        assertEq(walked[0], HK1);
        assertEq(stakeOf(HK1), 40_000_000_000);
        assertEq(stakeOf(HK2), 50_000_000_000, "HK2 untouched for 1 rao");

        // exactly T short: out = 1e25 * (90e18 + 1) / (9e25 + 1e6) = 10e18
        staking.setRemoveFeeRao(1_000);
        vm.recordLogs();
        assertEq(redeem(alice, 1e25), 10e18 - T);
        walked = unstakedFrom(vm.getRecordedLogs());
        assertEq(walked.length, 1, "one removal for T");
        assertEq(walked[0], HK1);
        assertEq(stakeOf(HK1), 30_000_000_000);
        assertEq(stakeOf(HK2), 50_000_000_000, "HK2 untouched for T");
        assertEq(address(vault).balance, ED);

        // 1_001 rao short: out = 1e25 * (80e18 + 1) / (8e25 + 1e6) = 10e18. HK1's removal takes the 10e9 rao asked,
        // which covers the request at face value: the walk stops, and the leaver bears the 1_001 rao
        staking.setRemoveFeeRao(1_001);
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeWithSelector(IStaking.removeStake.selector, HK2), 0);
        vm.recordLogs();
        assertEq(redeem(alice, 1e25), 10e18 - 1_001 * RAO, "the leaver bears the fee");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        walked = unstakedFrom(logs);
        assertEq(walked.length, 1, "one removal past T too");
        assertEq(walked[0], HK1);
        assertTrue(absorbedLogged(logs));
        assertEq(stakeOf(HK1), 20_000_000_000);
        assertEq(stakeOf(HK2), 50_000_000_000, "HK2 untouched past T");
        assertEq(address(vault).balance, ED, "nothing idle");
    }

    // ---- processPayouts ----

    /// A payout chunk asks T more than it needs, and its entry bears what the chain kept of the stake its walk took
    /// (the walk's cost, PayoutChunkSent's unstakeCost): at a 1,000-rao fee the chunk is sent less 1,000 rao, from its
    /// receipt alone, the cushion stays idle whole, and ED_RESERVE is untouched.
    function test_payoutChunkUpToTShortIsSentLessItsWalkCost() public {
        (bytes32 key, CascadeMessages.Payout[] memory list) = queueStakedPayout();
        staking.setRemoveFeeRao(1_000);

        // need = net + fee = 50e18; the walk asks 50e18 + T = 50_000_001_000 rao and receives exactly 50e18
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 50_000_001_000, 0)));
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 50_000_001_000, 50e18);
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(key, 0, 1, 50e18, 50e18 - 1e15 - T, 1e15, 1e15, T);
        vault.processPayouts(key, list, 0);
        assertEq(bridge.lastValue(), 50e18 - T, "sent less its walk's cost");
        assertEq(bridge.sendCount(), 1);
        assertEq(vaultLens.pendingPayouts(), 0);
        assertEq(address(vault).balance, ED + T, "the cushion idle whole, ED_RESERVE untouched");
        assertEq(stakeOf(HK1), 50_000_000_000 - 1_000);
    }

    /// A fee one rao past T is the entry's too: the walk takes the 50_000_001_000 rao it asks, which covers the chunk
    /// at face value, and the chunk is sent less the 1,001 rao the chain kept (before Task 36b it reverted
    /// UnstakeShort, a freeze at any root fee above T). The cushion stays idle whole, and the batch is done.
    function test_aFeeAboveTIsTheChunksEntrys() public {
        (bytes32 key, CascadeMessages.Payout[] memory list) = queueStakedPayout();
        staking.setRemoveFeeRao(1_001);

        // the walk asks 50_000_001_000 rao and receives 1_001 rao less: 50e18 less a rao
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 50_000_001_000, 50e18 - RAO);
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(key, 0, 1, 50e18, 50e18 - 1e15 - 1_001 * RAO, 1e15, 1e15, 1_001 * RAO);
        vault.processPayouts(key, list, 0);
        assertEq(bridge.lastValue(), 50e18 - 1_001 * RAO, "sent less its walk's cost");
        assertEq(bridge.sendCount(), 1);
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        assertEq(b.count, 0, "the batch done");
        assertEq(vaultLens.pendingPayouts(), 0);
        assertEq(address(vault).balance, ED + T, "the cushion idle whole");
        assertEq(stakeOf(HK1), 50_000_000_000 - 1_000);
    }

    // ---- the walk under a root hold (Task 20) ----

    /// Spec §3.8: a held pair's refused removal is skipped (UnstakeSkipped) and the walk goes on to the next position,
    /// which serves the exit: a direct exit is paid whole and a payout chunk is sent whole. The held position is
    /// untouched, and the ledger books exactly the removals that went through.
    function test_aSecondFreePairServesTheExit() public {
        // bob 100e18 through the door and alice 100e18 directly (1e26 shares each), staked on HK1; HK2 listed and
        // half of it moved onto HK2 within the set: HK1 (the stake hotkey, walked first) and HK2 hold 100e9 each
        depositVia(bob, 100e18);
        depositDirect(alice, 100e18);
        stake();
        listAndMove(HK2, 100_000_000_000);
        staking.setPairLocked(HK1, true);

        // alice's 1e25 at A = 200e18, S = 2e26: 10e18, with nothing liquid; HK1 refuses, HK2 pays 10e9
        vm.expectEmit(address(vault));
        emit UnstakeSkipped(HK1);
        vm.expectEmit(address(vault));
        emit Unstaked(HK2, 10_000_000_000, 10e18);
        vm.expectEmit(address(vault));
        emit RedeemedDirect(alice, 1e25, 10e18, false);
        vm.recordLogs();
        assertEq(redeem(alice, 1e25), 10e18, "paid whole");
        bytes32[] memory walked = unstakedFrom(vm.getRecordedLogs());
        assertEq(walked.length, 1, "the skipped position logs no Unstaked");
        assertEq(walked[0], HK2);
        assertEq(stakeOf(HK1), 100_000_000_000, "the held position untouched");
        assertEq(stakeOf(HK2), 90_000_000_000);
        assertEq(vaultLens.bookedStake(), 190_000_000_000, "booked: only the removal that went through");
        assertEq(address(vault).balance, ED);

        // bob's 5e25 through the door at A = 190e18, S = 1.9e26: 50e18, queued while staked. A day on, the chunk's
        // walk asks 50e18 + T, skips HK1 again and takes it all from HK2
        bytes32 key = redeemVia(bob, 5e25);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.expectEmit(address(vault));
        emit UnstakeSkipped(HK1);
        vm.expectEmit(address(vault));
        emit Unstaked(HK2, 50_000_001_000, 50_000_001_000 * RAO);
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(key, 0, 1, 50e18, 50e18 - 1e15, 1e15, 1e15, 0);
        vault.processPayouts(key, pay1(bob, 5e25, 50e18), 0);
        assertEq(bridge.lastValue(), 50e18, "sent whole");
        assertEq(vaultLens.pendingPayouts(), 0);
        assertEq(stakeOf(HK1), 100_000_000_000);
        assertEq(stakeOf(HK2), 40_000_000_000 - 1_000);
        assertEq(vaultLens.bookedStake(), 140_000_000_000 - 1_000);
        assertEq(address(vault).balance, ED + T, "the cushion idle");
    }

    /// Every listed pair held and no idle buffer (idleBufferBps 0, the launch value): no position can pay, so both
    /// exits revert UnstakeShort and nothing moves (I-13's liveness needs the walk, or the buffer, spec §3.8). The gas
    /// is bounded either way. Refused at once, each pair is tried once and the exit costs little. Refused by burning
    /// the gas forwarded to it, as a failed precompile write does on the live runtime, each removal burns only its
    /// share, so the walk keeps EXIT_GAS_RESERVE and the exit still ends on its own UnstakeShort, never out of gas.
    function test_everyPairLockedNoBufferRevertsWithBoundedGas() public {
        // HK1 100e9, HK2 50e9 and HK3 50e9 of 200e9; bob's 5e25 queued at A = 200e18, S = 2e26: 50e18
        depositVia(bob, 100e18);
        depositDirect(alice, 100e18);
        stake();
        listAndMove(HK2, 50_000_000_000);
        listAndMove(HK3, 50_000_000_000);
        bytes32 key = redeemVia(bob, 5e25);
        CascadeMessages.Payout[] memory list = pay1(bob, 5e25, 50e18);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        staking.setPairLocked(HK1, true);
        staking.setPairLocked(HK2, true);
        staking.setPairLocked(HK3, true);
        assertEq(vaultLens.idleBufferBps(), 0);

        // alice's 1e25 at A = 150e18, S = 1.5e26: 10e18, nothing liquid beyond the reservation
        uint256 g = gasleft();
        vm.prank(alice);
        vm.expectRevert(UnstakeShort.selector);
        vault.redeemDirect{gas: 30_000_000}(1e25, false);
        assertLt(g - gasleft(), 250_000, "bounded: three refusals and the reads, of the 30M given");
        g = gasleft();
        vm.expectRevert(UnstakeShort.selector);
        vault.processPayouts{gas: 30_000_000}(key, list, 0);
        assertLt(g - gasleft(), 300_000, "bounded");

        // every refusal burns what it is given: each removal gets its share, the last the rest less the reserve
        staking.setBurnRemoveGas(true);
        uint256 given = 10_000_000;
        g = gasleft();
        vm.prank(alice);
        vm.expectRevert(UnstakeShort.selector);
        vault.redeemDirect{gas: given}(1e25, false);
        uint256 left = given - (g - gasleft());
        assertGt(left, RESERVE, "the reserve kept: the vault's own UnstakeShort, never out of gas");
        assertLt(left, RESERVE + given / 64 + 50_000, "and every other share burned");
        g = gasleft();
        vm.expectRevert(UnstakeShort.selector);
        vault.processPayouts{gas: given}(key, list, 0);
        left = given - (g - gasleft());
        assertGt(left, RESERVE);
        assertLt(left, RESERVE + given / 64 + 50_000);

        // nothing moved
        assertEq(vault.balanceOf(alice), 1e26);
        assertEq(stakeOf(HK1), 100_000_000_000);
        assertEq(stakeOf(HK2), 50_000_000_000);
        assertEq(stakeOf(HK3), 50_000_000_000);
        assertEq(vaultLens.pendingPayouts(), 50e18);
        assertEq(vaultLens.getPayoutBatch(key).remaining, 50e18);
        assertEq(bridge.sendCount(), 0);
        assertEq(address(vault).balance, ED);
    }

    /// The hold also gates move_stake (spec §3.8), and removeHotkey keeps its direct removal, which reverts when the
    /// chain refuses it (spec §8.1: never the walk's skip), so the owner's moves and removals of a held pair wait: a
    /// scheduled moveStake reverts at execute and is kept for its window, the owner's removeHotkey reverts whether its
    /// leftover would move or be removed, and each runs once the hold lifts. An exit meanwhile is paid from the free
    /// stake hotkey.
    function test_moveStakeAndRemoveHotkeyWaitUnderAHold() public {
        // HK1 60e9 and HK2 40e9 of alice's 100e9; HK3 holds a gift of 1_000_000 rao, under the minimum stake
        depositDirect(alice, 100e18);
        stake();
        listAndMove(HK2, 40_000_000_000);
        vm.prank(owner);
        vault.addHotkey(HK3);
        staking.donateStake(HK3, vaultLens.coldkey(), 1_000_000);
        bytes memory move = abi.encodeCall(vault.moveStake, (HK2, HK1, 40_000_000_000));
        vm.prank(owner);
        vault.schedule(move);
        Schedule.warpTo(vm.getBlockTimestamp() + 48 hours);
        staking.setPairLocked(HK2, true);
        staking.setPairLocked(HK3, true);

        vm.prank(owner);
        vm.expectRevert(MockStaking.RootStakeLocked.selector);
        vault.execute(move);
        assertGt(vaultLens.scheduled(keccak256(move)).readyAt, 0, "the item is kept");
        vm.prank(owner);
        vm.expectRevert(MockStaking.RootStakeLocked.selector);
        vault.removeHotkey(HK2, false);
        vm.prank(owner);
        vm.expectRevert(MockStaking.RootStakeLocked.selector);
        vault.removeHotkey(HK3, true);
        assertTrue(vaultLens.isHotkey(HK2));
        assertTrue(vaultLens.isHotkey(HK3));
        assertEq(stakeOf(HK2), 40_000_000_000);
        assertEq(stakeOf(HK3), 1_000_000);

        // out = 1e25 * (100e18 + 1) / (1e26 + 1e6) = 10e18, from HK1, which is free
        assertEq(redeem(alice, 1e25), 10e18);
        assertEq(stakeOf(HK1), 50_000_000_000);

        // the hold lifts: the move runs inside its window, then both removals
        staking.setPairLocked(HK2, false);
        staking.setPairLocked(HK3, false);
        vm.expectEmit(address(vault));
        emit StakeMoved(HK2, HK1, 40_000_000_000, 40_000_000_000);
        vm.prank(owner);
        vault.execute(move);
        assertEq(stakeOf(HK1), 90_000_000_000);
        vm.startPrank(owner);
        vault.removeHotkey(HK2, false);
        vault.removeHotkey(HK3, true);
        vm.stopPrank();
        assertFalse(vaultLens.isHotkey(HK2));
        assertFalse(vaultLens.isHotkey(HK3));
        assertEq(address(vault).balance, ED + 1_000_000 * RAO, "the gift's leftover, idle");
    }

    /// Spec §3.8, §3.10.9: each removal is forwarded max(unstakeGas, (gasleft - EXIT_GAS_RESERVE) / positionsLeft),
    /// positionsLeft counted once before the walk, of the positions of at least the minimum stake, and decremented as
    /// each is tried: a position under the minimum is never tried and takes no share. The mock records the gas each
    /// removal is given at its entry (a little under what the walk forwards). With plenty of gas the split decides:
    /// the first of two positions gets half of what is above the reserve, the last all of it. With little, unstakeGas
    /// is the floor of every share. (The per-removal step, logged, is the gas between two splits: the mock's removal
    /// and the walk's own work around it, the debit's getStake read included.)
    function test_gasSplitCountsOnlyUnstakeablePositions() public {
        // HK1 (the stake hotkey) 10e9 and HK3 90e9 of alice's 100e9; HK2 between them holds 1_000_000 rao, a gift
        // under the minimum stake
        depositDirect(alice, 100e18);
        stake();
        vm.prank(owner);
        vault.addHotkey(HK2);
        staking.donateStake(HK2, vaultLens.coldkey(), 1_000_000);
        listAndMove(HK3, 90_000_000_000);
        staking.setRecordRemovalGas(true);
        uint256 snap = vm.snapshotState();

        // 25e18 out: HK1 whole (removeStakeFull), HK2 never tried, then 15e9 of HK3 (removeStake)
        uint256 given = 10_000_000;
        vm.prank(alice);
        vault.redeemDirect{gas: given}(25e24, false);
        assertEq(alice.balance, 25e18);
        assertEq(stakeOf(HK2), 1_000_000, "the dust untouched");
        assertEq(staking.removalGas(HK2), 0, "and never tried");
        uint256 first = staking.removalGas(HK1);
        uint256 last = staking.removalGas(HK3);
        // the last gets the rest less the reserve: under all L2 was given (63/64 of the vault's), not much under
        assertLt(last, given * 63 / 64 - RESERVE, "the reserve held back");
        assertGt(last, given * 63 / 64 - RESERVE - 300_000, "the rest");
        // the first got half of the same rest, as read one removal step earlier: 2 * first - last is that step
        // (less the mock's entry), small; counting HK2 would make the first share a third, and a share never
        // decremented would leave the last a half: either way 2 * first - last would be off by millions
        assertGt(2 * first, last, "the first share is half the rest, and no less");
        assertLt(2 * first - last, 150_000, "two shares: HK2 not counted, positionsLeft decremented");
        emit log_named_uint("per-removal step (gas, the mock's removal included)", 2 * first - last);

        // little gas: (gasleft - reserve) / positionsLeft falls under unstakeGas, which floors every share
        vm.revertToState(snap);
        given = 1_600_000;
        vm.prank(alice);
        vault.redeemDirect{gas: given}(25e24, false);
        assertEq(alice.balance, 25e18);
        assertFloored(400_000);

        // the owner's floor (immediate both ways): every share is at least it
        vm.revertToState(snap);
        vm.prank(owner);
        vault.setUnstakeGas(1_000_000);
        vm.prank(alice);
        vault.redeemDirect{gas: given}(25e24, false);
        assertEq(alice.balance, 25e18);
        assertFloored(1_000_000);
    }

    /// processPayouts' work after the walk (the ledger, L3's effects, the bridge's send) runs on what the walk left: at
    /// least EXIT_GAS_RESERVE while each removal's share of what is above it exceeds unstakeGas (here about 830,000 of
    /// 3,800,000 against 400,000). The held stake hotkey burns its share, the walk goes on to HK2, whose removal goes
    /// through but uses all its share but 60,000 gas (an expensive removal: setRemovalKeepsGas), so what the payout has
    /// left after the walk is the reserve itself. The bridge's send is given that, less the 1/64 the calls into L3 and
    /// into the bridge each hold back and L3's effects before the send: within SEND_SLACK of EXIT_GAS_RESERVE, above
    /// and below. Without the reserve the payout would reach its send with almost nothing, and fail.
    function test_processPayoutsFinishesAfterTheWalk() public {
        // HK1 40e9 and HK2 60e9 of bob's 100e9; his 5e25 queued at A = 100e18, S = 1e26: 50e18
        depositVia(bob, 100e18);
        stake();
        listAndMove(HK2, 60_000_000_000);
        bytes32 key = redeemVia(bob, 5e25);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        staking.setPairLocked(HK1, true);
        staking.setBurnRemoveGas(true);
        staking.setRemovalKeepsGas(60_000);
        staking.setRecordRemovalGas(true);

        vm.expectEmit(address(vault));
        emit UnstakeSkipped(HK1);
        vm.expectEmit(address(vault));
        emit Unstaked(HK2, 50_000_001_000, 50_000_001_000 * RAO);
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(key, 0, 1, 50e18, 50e18 - 1e15, 1e15, 1e15, 0);
        vault.processPayouts{gas: 3_800_000}(key, pay1(bob, 5e25, 50e18), 0);
        assertEq(bridge.sendCount(), 1, "sent");
        assertEq(bridge.lastValue(), 50e18);
        assertEq(vaultLens.pendingPayouts(), 0);
        assertEq(stakeOf(HK1), 40_000_000_000, "the held position untouched");
        assertEq(stakeOf(HK2), 10_000_000_000 - 1_000);
        assertEq(address(vault).balance, ED + T);
        // HK2 was given its share, more than unstakeGas, and used all of it but 60,000: the reserve is what remained
        assertGt(staking.removalGas(HK2), 400_000, "a share above the floor");
        uint256 atSend = bridge.lastSendGasLeft();
        emit log_named_uint("gas the bridge's send was given", atSend);
        assertGt(atSend, RESERVE - SEND_SLACK, "the reserve reached the send");
        assertLt(atSend, RESERVE + SEND_SLACK, "and not much more: the walk left the reserve, no more");
    }

    /// ChatGPT R2's gas note on EXIT_GAS_RESERVE (R6, the documented caller's gas rule): a stranger running bob's payout
    /// under a burning hold, at any gas limit from 300,000 to 6,000,000, either reverts whole or pays the chunk exactly as
    /// at ample gas: its gas limit flips no decision. (MockStaking's unheld removals cost far less than the live chain's,
    /// so this covers the burning-hold logic; the equal-share argument in the R6 report covers the live need.)
    function test_aStrangersGasLimitFlipsNoPayoutDecision() public {
        depositVia(bob, 100e18);
        stake();
        listAndMove(HK2, 60_000_000_000);
        bytes32 key = redeemVia(bob, 5e25);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        staking.setPairLocked(HK1, true);
        staking.setBurnRemoveGas(true);
        address stranger = makeAddr("stranger");
        uint256 successes;
        for (uint256 g = 300_000; g <= 6_000_000; g += 25_000) {
            uint256 snap = vm.snapshotState();
            vm.prank(stranger);
            (bool ok,) = address(vault).call{gas: g}(
                abi.encodeCall(CascadeVault.processPayouts, (key, pay1(bob, 5e25, 50e18), 0))
            );
            if (ok) {
                ++successes;
                assertEq(bridge.sendCount(), 1, "sent once");
                assertEq(bridge.lastValue(), 50e18, "the whole chunk");
                assertEq(vaultLens.pendingPayouts(), 0);
                assertEq(stakeOf(HK1), 40_000_000_000, "the held position untouched");
                assertEq(stakeOf(HK2), 10_000_000_000 - 1_000, "HK2 paid, as at ample gas");
            }
            vm.revertToState(snap);
        }
        assertGt(successes, 0, "the sweep reaches a gas that pays");
    }

    /// A walk that succeeds, skips, then succeeds (spec §3.8): HK1, the stake hotkey, pays all it holds but falls
    /// short; HK2 is held and skipped; HK3 pays the rest. Each removal that went through is measured and booked on its own
    /// (the booked stake less what left each position, the ramping stake less what each paid); the held one adds
    /// nothing and logs only UnstakeSkipped.
    function test_aWalkSucceedsSkipsAndSucceeds() public {
        // HK1 20e9, HK2 40e9 and HK3 40e9 of alice's 100e9; the stake ramped 100e18 (spec §3.10.12)
        depositDirect(alice, 100e18);
        stake();
        listAndMove(HK2, 40_000_000_000);
        listAndMove(HK3, 40_000_000_000);
        staking.setPairLocked(HK2, true);
        assertEq(rampingStake(), 100e18);

        // out = 3e25 * (100e18 + 1) / (1e26 + 1e6) = 30e18, nothing liquid: HK1 is asked 30e9 and exits whole (20e9,
        // which its Unstaked logs: R2 F2), HK2 is asked the 10e9 left and refuses, HK3 pays it
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 20_000_000_000, 20e18);
        vm.expectEmit(address(vault));
        emit UnstakeSkipped(HK2);
        vm.expectEmit(address(vault));
        emit Unstaked(HK3, 10_000_000_000, 10e18);
        vm.expectEmit(address(vault));
        emit RedeemedDirect(alice, 3e25, 30e18, false);
        vm.recordLogs();
        assertEq(redeem(alice, 3e25), 30e18, "paid whole");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32[] memory removed = unstakedFrom(logs);
        assertEq(removed.length, 2, "Unstaked for HK1 and HK3 only");
        assertEq(removed[0], HK1);
        assertEq(removed[1], HK3);
        bytes32[] memory skipped = skippedFrom(logs);
        assertEq(skipped.length, 1);
        assertEq(skipped[0], HK2);
        assertFalse(absorbedLogged(logs), "nothing absorbed");

        // the ledger after: HK1's 20e9 and HK3's 10e9 off the booked stake, their 20e18 and 10e18 off the ramp
        assertEq(stakeOf(HK1), 0);
        assertEq(stakeOf(HK2), 40_000_000_000, "the held position untouched");
        assertEq(stakeOf(HK3), 30_000_000_000);
        assertEq(vaultLens.bookedStake(), 70_000_000_000, "booked: 100e9 - 20e9 - 10e9");
        assertEq(rampingStake(), 70e18, "ramping: 100e18 - 20e18 - 10e18");
        assertEq(address(vault).balance, ED);
    }

    /// Two held pairs, skipped in the walk's order (the stake hotkey first, then the list): UnstakeSkipped(HK1), then
    /// UnstakeSkipped(HK2), then HK3 pays the exit whole.
    function test_twoHeldPairsAreSkippedInWalkOrder() public {
        // HK1 20e9, HK2 40e9 and HK3 40e9 of alice's 100e9; HK1 and HK2 held
        depositDirect(alice, 100e18);
        stake();
        listAndMove(HK2, 40_000_000_000);
        listAndMove(HK3, 40_000_000_000);
        staking.setPairLocked(HK1, true);
        staking.setPairLocked(HK2, true);

        // out = 10e18: HK1 refuses, HK2 refuses, HK3 pays 10e9
        vm.expectEmit(address(vault));
        emit UnstakeSkipped(HK1);
        vm.expectEmit(address(vault));
        emit UnstakeSkipped(HK2);
        vm.expectEmit(address(vault));
        emit Unstaked(HK3, 10_000_000_000, 10e18);
        vm.recordLogs();
        assertEq(redeem(alice, 1e25), 10e18, "paid whole");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32[] memory skipped = skippedFrom(logs);
        assertEq(skipped.length, 2);
        assertEq(skipped[0], HK1, "the stake hotkey first");
        assertEq(skipped[1], HK2);
        bytes32[] memory removed = unstakedFrom(logs);
        assertEq(removed.length, 1);
        assertEq(removed[0], HK3);
        assertEq(stakeOf(HK1), 20_000_000_000);
        assertEq(stakeOf(HK2), 40_000_000_000);
        assertEq(stakeOf(HK3), 30_000_000_000);
        assertEq(vaultLens.bookedStake(), 90_000_000_000);
        assertEq(rampingStake(), 90e18);
    }

    /// A removal that burns all the gas forwarded to it (a refusal on the live runtime) is skipped like any refusal:
    /// UnstakeSkipped, and the walk goes on to the next position, which pays the exit whole. It burned only its share,
    /// half of what was above the reserve: the exit's whole gas use is about that share.
    function test_gasBurningRemovalIsSkipped() public {
        // HK1 (walked first) and HK2 hold 50e9 each of alice's 100e9
        depositDirect(alice, 100e18);
        stake();
        listAndMove(HK2, 50_000_000_000);
        staking.setPairLocked(HK1, true);
        staking.setBurnRemoveGas(true);
        staking.setRecordRemovalGas(true);

        vm.expectEmit(address(vault));
        emit UnstakeSkipped(HK1);
        vm.expectEmit(address(vault));
        emit Unstaked(HK2, 10_000_000_000, 10e18);
        vm.expectEmit(address(vault));
        emit RedeemedDirect(alice, 1e25, 10e18, false);
        uint256 g = gasleft();
        vm.prank(alice);
        vault.redeemDirect{gas: 10_000_000}(1e25, false);
        uint256 used = g - gasleft();
        assertEq(alice.balance, 10e18, "paid whole");
        assertEq(staking.removalGas(HK1), 0, "HK1's removal never went through");
        assertEq(stakeOf(HK1), 50_000_000_000);
        assertEq(stakeOf(HK2), 40_000_000_000);
        assertEq(vaultLens.bookedStake(), 90_000_000_000);
        assertEq(address(vault).balance, ED);
        uint256 share = staking.removalGas(HK2);
        assertGt(share, (10_000_000 - RESERVE) / 2 - 400_000, "HK2 got the rest less the reserve");
        assertGt(used, share, "HK1 burned a share as large");
        assertLt(used, share + 300_000, "and no more");
    }

    /// The idle buffer (spec §3.8): stakeIdle stakes only what the liquid balance holds above ED_RESERVE, the queued
    /// payouts and the buffer, which is 0 at 0 bps (the launch value) and otherwise idleBufferBps of the booked stake,
    /// at least minDailyOutflow. An increase applies at once; the decrease is scheduled.
    function test_stakeIdleKeepsTheBuffer() public {
        // the outflow floor down to 20 TAO (a tightening, at once)
        vm.prank(owner);
        vault.setOutflowLimits(2_000, 20e18, 2_000);
        // no buffer: everything is staked
        depositDirect(alice, 100e18);
        stake();
        assertEq(address(vault).balance, ED);
        assertEq(vaultLens.bookedStake(), 100_000_000_000);

        vm.expectEmit(address(vault));
        emit LimitSet(vault.setIdleBuffer.selector, 1_000, 0);
        vm.prank(owner);
        vault.setIdleBuffer(1_000);
        assertEq(vaultLens.idleBufferBps(), 1_000);

        // 10% of 100 TAO booked is 10 TAO, under the 20 TAO floor: 380 of carol's 400 TAO are staked
        depositDirect(carol, 400e18);
        vm.expectEmit(address(vault));
        emit Staked(HK1, 380_000_000_000, 380_000_000_000);
        stake();
        assertEq(address(vault).balance, ED + 20e18, "the floor kept liquid");

        // 10% of 480 TAO booked is 48 TAO, above the floor: 72 of bob's 100 TAO are staked
        depositVia(bob, 100e18);
        vm.expectEmit(address(vault));
        emit Staked(HK1, 72_000_000_000, 72_000_000_000);
        stake();
        assertEq(address(vault).balance, ED + 48e18, "10% of the booked stake kept liquid");

        // the buffer is now 55.2 TAO, more than is liquid: nothing to stake
        vm.prank(keeper);
        vm.expectRevert(NothingToStake.selector);
        vault.stakeIdle();

        // the decrease, scheduled (48 hours): at 0 the rest is staked
        Schedule.run(vault, owner, abi.encodeCall(vault.setIdleBuffer, (0)));
        assertEq(vaultLens.idleBufferBps(), 0);
        stake();
        assertEq(address(vault).balance, ED);
        assertEq(vaultLens.bookedStake(), 600_000_000_000);
    }

    /// The bounds (spec Appendix B, §3.6): unstakeGas in [150,000, 5,000,000], immediate both ways; idleBufferBps at
    /// most 1,000 (MAX_IDLE_BUFFER_BPS); InvalidParameter outside them, from the setters and the constructor alike.
    /// The launch values come from the constructor: 400,000 and 0. Owner only.
    function test_unstakeGasAndBufferBounds() public {
        assertEq(vaultLens.unstakeGas(), 400_000);
        assertEq(vaultLens.idleBufferBps(), 0);
        assertEq(vaultLens.EXIT_GAS_RESERVE(), RESERVE);

        vm.startPrank(owner);
        vm.expectRevert(InvalidParameter.selector);
        vault.setUnstakeGas(149_999);
        vm.expectRevert(InvalidParameter.selector);
        vault.setUnstakeGas(5_000_001);
        vm.expectEmit(address(vault));
        emit LimitSet(vault.setUnstakeGas.selector, 150_000, 0);
        vault.setUnstakeGas(150_000);
        assertEq(vaultLens.unstakeGas(), 150_000);
        vm.expectEmit(address(vault));
        emit LimitSet(vault.setUnstakeGas.selector, 5_000_000, 0);
        vault.setUnstakeGas(5_000_000);
        assertEq(vaultLens.unstakeGas(), 5_000_000);
        vm.expectRevert(InvalidParameter.selector);
        vault.setIdleBuffer(1_001);
        // a word past uint16 is refused, never truncated (2^16 would store 0)
        vm.expectRevert(InvalidParameter.selector);
        vault.setIdleBuffer(1 << 16);
        vault.setIdleBuffer(1_000);
        assertEq(vaultLens.idleBufferBps(), 1_000);
        vm.stopPrank();

        address[3] memory others = [guardian, keeper, carol];
        for (uint256 i; i < others.length; ++i) {
            vm.startPrank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, others[i]));
            vault.setUnstakeGas(400_000);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, others[i]));
            vault.setIdleBuffer(1_000);
            vm.stopPrank();
        }

        // the constructor's Params go through the same checks
        uint256[3] memory badGas = [uint256(0), 149_999, 5_000_001];
        for (uint256 i; i < badGas.length; ++i) {
            CascadeVault.Params memory p = vaultParams();
            p.unstakeGas = badGas[i];
            vm.expectRevert(InvalidParameter.selector);
            new CascadeVault(p);
        }
        CascadeVault.Params memory q = vaultParams();
        q.idleBufferBps = 1_001;
        vm.expectRevert(InvalidParameter.selector);
        new CascadeVault(q);
        q = vaultParams();
        q.idleBufferBps = 1_000;
        q.unstakeGas = 5_000_000;
        CascadeVault v = new CascadeVault(q);
        assertGt(address(v).code.length, 0, "the bounds themselves are allowed");
    }
}
