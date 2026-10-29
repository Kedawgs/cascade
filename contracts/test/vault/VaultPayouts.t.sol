// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeBase} from "../../src/CascadeBase.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {ISTAKING_ADDRESS, IStaking} from "../../src/interfaces/IStaking.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {StubBridge} from "../mocks/StubBridge.sol";
import {VaultTestBase} from "../VaultTestBase.sol";

contract VaultPayoutsTest is VaultTestBase {
    /// alice's redeem of 1e26 shares, queued in setUp.
    bytes32 K;
    uint256 tK;

    /// Exact stake reads. alice deposits 1_000e18 at A = 0, S = 0: 1_000e18 * 1e6 = 1e27 shares; the keeper
    /// stakes it all (HK1 1_000_000_000_000 rao, balance ED); the stub fee is 1e15. Batch K: alice redeems
    /// 1e26 at A = 1_000e18, S = 1e27: 1e26 * (1_000e18 + 1) / (1e27 + 1e6) = 100e18. Then 24 hours pass.
    /// Afterwards A = 900e18 and S = 9e26 (A excludes the 100e18 pending), so assets = shares / 1e6 exactly.
    function setUp() public override {
        super.setUp();
        staking.setOneRaoShort(false);
        depositVia(alice, 1_000e18);
        vm.prank(keeper);
        vault.stakeIdle();
        bridge.setFee(1e15);
        tK = block.timestamp;
        K = redeemVia(alice, 1e26);
        vm.warp(tK + 24 hours);
    }

    // ---- helpers ----

    function redeemVia(address user, uint256 shares) internal returns (bytes32) {
        return deliver(BASE, frontDoor, ++nextBatchId, noEntries(), entries1(user, shares));
    }

    function redeemVia(CascadeMessages.Entry[] memory redeems) internal returns (bytes32) {
        return deliver(BASE, frontDoor, ++nextBatchId, noEntries(), redeems);
    }

    function entries2(address u1, uint256 a1, address u2, uint256 a2)
        internal
        pure
        returns (CascadeMessages.Entry[] memory e)
    {
        e = new CascadeMessages.Entry[](2);
        e[0] = CascadeMessages.Entry(u1, a1);
        e[1] = CascadeMessages.Entry(u2, a2);
    }

    function entries3(address u1, uint256 a1, address u2, uint256 a2, address u3, uint256 a3)
        internal
        pure
        returns (CascadeMessages.Entry[] memory e)
    {
        e = new CascadeMessages.Entry[](3);
        e[0] = CascadeMessages.Entry(u1, a1);
        e[1] = CascadeMessages.Entry(u2, a2);
        e[2] = CascadeMessages.Entry(u3, a3);
    }

    function pay1(address u, uint256 s, uint256 a) internal pure returns (CascadeMessages.Payout[] memory p) {
        p = new CascadeMessages.Payout[](1);
        p[0] = CascadeMessages.Payout(u, s, a);
    }

    function pay2(address u1, uint256 s1, uint256 a1, address u2, uint256 s2, uint256 a2)
        internal
        pure
        returns (CascadeMessages.Payout[] memory p)
    {
        p = new CascadeMessages.Payout[](2);
        p[0] = CascadeMessages.Payout(u1, s1, a1);
        p[1] = CascadeMessages.Payout(u2, s2, a2);
    }

    function listK() internal view returns (CascadeMessages.Payout[] memory) {
        return pay1(alice, 1e26, 100e18);
    }

    function process(bytes32 key, CascadeMessages.Payout[] memory list, uint32 maxEntries) internal {
        vault.processPayouts(key, list, maxEntries);
    }

    function cancel(bytes32 key, CascadeMessages.Payout[] memory list) internal {
        vm.prank(owner);
        vault.cancelPayoutBatch(key, list);
    }

    function stakeOf(bytes32 h) internal view returns (uint256) {
        return staking.getStake(h, vault.coldkey(), 0);
    }

    function assertBatch(bytes32 key, uint256 cursor, uint256 chunk, uint256 remaining) internal view {
        CascadeVault.PayoutBatch memory b = vault.getPayoutBatch(key);
        assertEq(b.cursor, cursor, "cursor");
        assertEq(b.chunk, chunk, "chunk");
        assertEq(b.remaining, remaining, "remaining");
    }

    function assertDeleted(bytes32 key) internal view {
        CascadeVault.PayoutBatch memory b = vault.getPayoutBatch(key);
        assertEq(b.count, 0, "count");
        assertEq(b.cursor, 0, "cursor");
        assertEq(b.remaining, 0, "remaining");
        assertEq(b.payoutsHash, bytes32(0), "hash");
        assertEq(b.frontDoor, address(0), "frontDoor");
        assertTrue(vault.processed(key), "processed");
    }

    /// K is paid (HK1 900_000_000_000 rao, balance ED, nothing pending; A = 900e18, S = 9e26). bob and carol
    /// deposit 100e18 each, left liquid: 100e18 * (9e26 + 1e6) / (900e18 + 1) = 1e26, then at A = 1_000e18,
    /// S = 1e27 another 1e26. One batch redeems 6e25 each for alice, bob and carol at A = 1_100e18,
    /// S = 1.1e27: 6e25 * (1_100e18 + 1) / (1.1e27 + 1e6) = 60e18 each. Then 24 hours pass.
    function queueThree() internal returns (bytes32 key, CascadeMessages.Payout[] memory list) {
        process(K, listK(), 10);
        depositVia(bob, 100e18);
        depositVia(carol, 100e18);
        vm.prank(owner);
        vault.setOutflowLimits(5_000, 100e18);
        key = redeemVia(entries3(alice, 6e25, bob, 6e25, carol, 6e25));
        list = new CascadeMessages.Payout[](3);
        list[0] = CascadeMessages.Payout(alice, 6e25, 60e18);
        list[1] = CascadeMessages.Payout(bob, 6e25, 60e18);
        list[2] = CascadeMessages.Payout(carol, 6e25, 60e18);
        vm.warp(block.timestamp + 24 hours);
    }

    /// K is paid; bob deposits 100e18 (1e26 shares at A = 900e18, S = 9e26) and the keeper stakes it, so
    /// HK1 holds 1_000_000_000_000 rao and the vault only ED. Batch A: alice redeems 3e25 at A = 1_000e18,
    /// S = 1e27 → 30e18. Batch B: bob redeems 4e25 at A = 970e18, S = 9.7e26 → 40e18. Then 24 hours pass.
    function queueTwoFullyStaked() internal returns (bytes32 a, bytes32 b) {
        process(K, listK(), 10);
        depositVia(bob, 100e18);
        vm.prank(keeper);
        vault.stakeIdle();
        assertEq(stakeOf(HK1), 1_000_000_000_000);
        a = redeemVia(alice, 3e25);
        b = redeemVia(bob, 4e25);
        vm.warp(block.timestamp + 24 hours);
        assertEq(vault.pendingPayouts(), 70e18);
        assertEq(address(vault).balance, ED);
    }

    /// Eleven holders deposit 1e18 each in one batch at A = 900e18, S = 9e26:
    /// 1e18 * (9e26 + 1e6) / (900e18 + 1) = 1e24 shares each, left liquid. One batch redeems all of them at
    /// A = 911e18, S = 9.11e26: 1e24 → 1e18 each. Then 24 hours pass.
    function queueEleven() internal returns (bytes32 key, CascadeMessages.Payout[] memory list) {
        CascadeMessages.Entry[] memory d = new CascadeMessages.Entry[](11);
        CascadeMessages.Entry[] memory r = new CascadeMessages.Entry[](11);
        list = new CascadeMessages.Payout[](11);
        for (uint256 i; i < 11; ++i) {
            address u = makeAddr(string.concat("holder", vm.toString(i)));
            d[i] = CascadeMessages.Entry(u, 1e18);
            r[i] = CascadeMessages.Entry(u, 1e24);
            list[i] = CascadeMessages.Payout(u, 1e24, 1e18);
        }
        deliver(BASE, frontDoor, ++nextBatchId, d, noEntries());
        key = redeemVia(r);
        vm.warp(block.timestamp + 24 hours);
    }

    // ---- processPayouts: guards ----

    function test_processPayouts_beforeDelayReverts() public {
        vm.warp(tK + 24 hours - 1);
        vm.expectRevert(CascadeVault.PayoutDelayed.selector);
        process(K, listK(), 10);

        vm.warp(tK + 24 hours);
        process(K, listK(), 10);
        assertEq(vault.pendingPayouts(), 0);
    }

    function test_processPayouts_wrongListReverts() public {
        // wrong user, wrong shares, wrong assets
        vm.expectRevert(CascadeVault.PayoutsMismatch.selector);
        process(K, pay1(bob, 1e26, 100e18), 10);
        vm.expectRevert(CascadeVault.PayoutsMismatch.selector);
        process(K, pay1(alice, 1e26 + 1, 100e18), 10);
        vm.expectRevert(CascadeVault.PayoutsMismatch.selector);
        process(K, pay1(alice, 1e26, 100e18 + 1), 10);
        // wrong length: the right entry twice, or nothing
        vm.expectRevert(CascadeVault.PayoutsMismatch.selector);
        process(K, pay2(alice, 1e26, 100e18, alice, 1e26, 100e18), 10);
        vm.expectRevert(CascadeVault.PayoutsMismatch.selector);
        process(K, new CascadeMessages.Payout[](0), 10);

        assertBatch(K, 0, 0, 100e18);
        assertEq(vault.pendingPayouts(), 100e18);
    }

    function test_processPayouts_unknownKeyReverts() public {
        vm.expectRevert(CascadeVault.NotPending.selector);
        process(keccak256("unknown"), listK(), 10);
        // a deposit-only batch is processed but queued nothing
        bytes32 depositOnly = depositVia(bob, 1e18);
        vm.expectRevert(CascadeVault.NotPending.selector);
        process(depositOnly, new CascadeMessages.Payout[](0), 10);
    }

    function test_processPayouts_whilePausedReverts() public {
        vm.prank(guardian);
        vault.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        process(K, listK(), 10);
        assertBatch(K, 0, 0, 100e18);
    }

    function test_processPayouts_doneBatchRevertsNotPending() public {
        process(K, listK(), 10);

        vm.expectRevert(CascadeVault.NotPending.selector);
        process(K, listK(), 10);
        assertEq(bridge.sendCount(), 1);
    }

    // ---- processPayouts: amounts ----

    function test_processPayouts_singleChunkSendsNetPlusFee() public {
        // available = (ED - ED) - (100e18 - 100e18) = 0, so all of net + fee = 100e18 is unstaked:
        // want 100_000_000_000 rao leaves 900_000_000_000 >= 20_000_000, a partial removeStake.
        // fee: ceil(100e18 * 1e15 / 100e18) = 1e15; net = 100e18 - 1e15 = 99_999e15 (rao-aligned)
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 100_000_000_000, 0)));
        vm.expectEmit(address(vault));
        emit CascadeVault.Unstaked(HK1, 100_000_000_000, 100e18);
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutChunkSent(K, 0, 1, 100e18, 99_999e15, 1e15);
        process(K, listK(), 10);

        assertEq(bridge.sendCount(), 1);
        assertEq(bridge.lastValue(), 100e18);
        assertEq(bridge.lastAmount(), 99_999e15);
        assertEq(bridge.lastMessage(), CascadeMessages.encodePayouts(K, 0, entries1(alice, 99_999e15)));
        assertEq(bridge.lastDestChain(), BASE);
        assertEq(bridge.lastRecipient(), frontDoor);
        assertEq(address(bridge).balance, 100e18);

        assertEq(vault.pendingPayouts(), 0);
        assertDeleted(K);
        assertEq(stakeOf(HK1), 900_000_000_000);
        assertEq(address(vault).balance, ED);
    }

    function test_processPayouts_feeRoundingRemainderStaysInVault() public {
        // A = 900e18, S = 9e26: 2e18 * (9e26 + 1e6) / (900e18 + 1) = 2e24, left liquid
        depositVia(bob, 2e18);
        // A = 902e18, S = 9.02e26: alice 1e24 → 1e18, bob 2e24 → 2e18
        bytes32 k2 = redeemVia(entries2(alice, 1e24, bob, 2e24));
        vm.warp(block.timestamp + 24 hours);
        uint256 grossBefore = vault.grossAssets();
        assertEq(grossBefore, 1_002e18);

        // sum 3e18. alice: ceil(1e18 * 1e15 / 3e18) = 333_333_333_333_334, 1e18 - that = 999_666_666_666_666_666
        // floors to 999_666_666_000_000_000; bob: ceil(2e18 * 1e15 / 3e18) = 666_666_666_666_667,
        // 1_999_333_333_333_333_333 floors to 1_999_333_333_000_000_000. net = 2_998_999_999_000_000_000;
        // sent net + fee = 2_999_999_999_000_000_000; 3e18 - that = 1e9 stays.
        // available = (ED + 2e18 - ED) - (103e18 - 3e18) floors to 0: unstake 2_999_999_999 rao
        vm.expectEmit(address(vault));
        emit CascadeVault.Unstaked(HK1, 2_999_999_999, 2_999_999_999_000_000_000);
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutChunkSent(k2, 0, 2, 3e18, 2_998_999_999_000_000_000, 1e15);
        process(k2, pay2(alice, 1e24, 1e18, bob, 2e24, 2e18), 10);

        assertEq(
            bridge.lastMessage(),
            CascadeMessages.encodePayouts(
                k2, 0, entries2(alice, 999_666_666_000_000_000, bob, 1_999_333_333_000_000_000)
            )
        );
        assertEq(bridge.lastAmount(), 2_998_999_999_000_000_000);
        assertEq(bridge.lastValue(), 2_999_999_999_000_000_000);
        assertEq(vault.grossAssets(), grossBefore - 2_999_999_999_000_000_000);
        assertEq(vault.pendingPayouts(), 100e18);
        assertDeleted(k2);
    }

    function test_processPayouts_feeCeilingReverts() public {
        // ceiling = max(100e18 * 100 / 10_000, 0.02e18) = 1e18
        bridge.setFee(1e18 + 1);
        vm.expectRevert(CascadeVault.FeeTooHigh.selector);
        process(K, listK(), 10);
        assertBatch(K, 0, 0, 100e18);
        assertEq(vault.pendingPayouts(), 100e18);
        assertEq(bridge.sendCount(), 0);

        // at the ceiling: net = 100e18 - 1e18
        bridge.setFee(1e18);
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutChunkSent(K, 0, 1, 100e18, 99e18, 1e18);
        process(K, listK(), 10);
        assertEq(bridge.lastValue(), 100e18);
        assertEq(bridge.lastAmount(), 99e18);
        assertEq(vault.pendingPayouts(), 0);
    }

    function test_processPayouts_subRaoFeeRoundsUpToWholeRao() public {
        // the quote 1e15 + 1 rounds up to 1e15 + 1e9 = 1_000_001_000_000_000; ceiling 1e18
        bridge.setFee(1e15 + 1);
        // net = 100e18 - ceil(100e18 * 1_000_001_000_000_000 / 100e18) = 99_998_999_999_000_000_000 (rao-aligned);
        // sent = net + fee = 100e18. Unrounded, the send would carry 99_999_999_999_000_000_001 wei.
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutChunkSent(K, 0, 1, 100e18, 99_998_999_999_000_000_000, 1_000_001_000_000_000);
        process(K, listK(), 10);

        assertEq(bridge.lastValue(), 100e18);
        assertEq(bridge.lastValue() % 1e9, 0);
        assertEq(bridge.lastAmount(), 99_998_999_999_000_000_000);
        assertEq(bridge.lastMessage(), CascadeMessages.encodePayouts(K, 0, entries1(alice, 99_998_999_999_000_000_000)));
        assertDeleted(K);
    }

    function test_processPayouts_dustTailCompletesBatch() public {
        process(K, listK(), 10);
        // A = 900e18, S = 9e26: 1e16 * (9e26 + 1e6) / (900e18 + 1) = 1e22, left liquid
        depositVia(bob, 1e16);
        // A = 900.01e18, S = 9.0001e26: 1e22 → 1e16
        bytes32 k2 = redeemVia(bob, 1e22);
        vm.warp(block.timestamp + 24 hours);
        // ceiling = max(1e16 * 100 / 10_000, 0.02e18) = 2e16, so a 2e16 fee passes; sum 1e16 <= 2e16
        bridge.setFee(2e16);
        uint256 grossBefore = vault.grossAssets();
        uint256 sends = bridge.sendCount();

        vm.recordLogs();
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutDust(k2, bob, 1e16);
        // nothing sent, so no fee paid
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutChunkSent(k2, 0, 1, 1e16, 0, 0);
        process(k2, pay1(bob, 1e22, 1e16), 10);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != CascadeVault.Unstaked.selector);
        }

        assertEq(bridge.sendCount(), sends);
        assertDeleted(k2);
        assertEq(vault.pendingPayouts(), 0);
        assertEq(vault.grossAssets(), grossBefore);
    }

    /// An entry its share of the fee leaves with nothing is dust and stays in the vault, while the rest of
    /// its chunk goes out. Every burned redeem is worth at least 0.01 TAO, so such an entry is a bounced
    /// deposit: here bob's 1-rao deposit, bounced because a hotkey swap moved 600e18 of the stake outside
    /// the set.
    function test_processPayouts_individualDustEntryDropped() public {
        vm.prank(address(vault));
        staking.moveStake(HK1, HK5, 0, 0, 600_000_000_000);
        // A = 400e18 - 100e18 pending = 300e18 against S = 9e26, below half the launch price: bob's 1e9
        // bounces; alice 5e24 * (300e18 + 1) / (9e26 + 1e6) = 1_666_666_666_666_666_666 → 1_666_666_666e9
        bytes32 k2 = deliver(BASE, frontDoor, ++nextBatchId, entries1(bob, 1e9), entries1(alice, 5e24));
        vm.warp(block.timestamp + 24 hours);

        // sum = 1_666_666_667e9. bob: ceil(1e9 * 1e15 / sum) = 600_000, 999_400_000 floors to 0 → dust.
        // alice: ceil(1_666_666_666e9 * 1e15 / sum) = 999_999_999_400_001; 1_666_666_666e9 less that is
        // 1_665_666_666_000_599_999, which floors to 1_665_666_666e9.
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutDust(k2, bob, 1e9);
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutChunkSent(k2, 0, 2, 1_666_666_667e9, 1_665_666_666e9, 1e15);
        process(k2, pay2(bob, 0, 1e9, alice, 5e24, 1_666_666_666e9), 10);

        assertEq(bridge.lastMessage(), CascadeMessages.encodePayouts(k2, 0, entries1(alice, 1_665_666_666e9)));
        assertEq(bridge.lastAmount(), 1_665_666_666e9);
        assertEq(bridge.lastValue(), 1_665_666_666e9 + 1e15);
        assertDeleted(k2);
        assertEq(vault.pendingPayouts(), 100e18);
    }

    // ---- processPayouts: chunking ----

    function test_processPayouts_chunksByMessageValue() public {
        (bytes32 key, CascadeMessages.Payout[] memory list) = queueThree();
        // maxEntryValue must not exceed maxMessageValue, so both are 150e18
        vm.prank(owner);
        vault.setMessageLimits(150e18, 150e18, 1);
        uint256 sends = bridge.sendCount();

        // 60e18 + 60e18 = 120e18 <= 150e18; another 60e18 would exceed it. Each pays
        // ceil(60e18 * 1e15 / 120e18) = 5e14: 59_999_500_000_000_000_000. Liquid 200e18 covers it, no unstake.
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutChunkSent(key, 0, 2, 120e18, 119_999e15, 1e15);
        process(key, list, 10);
        assertEq(
            bridge.lastMessage(),
            CascadeMessages.encodePayouts(
                key, 0, entries2(alice, 59_999_500_000_000_000_000, bob, 59_999_500_000_000_000_000)
            )
        );
        assertEq(bridge.lastValue(), 120e18);
        assertBatch(key, 2, 1, 60e18);
        assertEq(vault.pendingPayouts(), 60e18);

        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutChunkSent(key, 1, 1, 60e18, 59_999e15, 1e15);
        process(key, list, 10);
        assertEq(bridge.lastMessage(), CascadeMessages.encodePayouts(key, 1, entries1(carol, 59_999e15)));
        assertEq(bridge.lastValue(), 60e18);
        assertEq(bridge.sendCount(), sends + 2);
        assertDeleted(key);
        assertEq(vault.pendingPayouts(), 0);
        assertEq(stakeOf(HK1), 900_000_000_000);
    }

    function test_processPayouts_maxEntriesRaisedToMinChunk() public {
        (bytes32 key, CascadeMessages.Payout[] memory list) = queueThree();
        // a 120e18 message cap keeps the third 60e18 entry out of the first chunk (it is not folded in)
        vm.prank(owner);
        vault.setMessageLimits(120e18, 120e18, 2);

        // the keeper's maxEntries 1 is raised to minChunk 2
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutChunkSent(key, 0, 2, 120e18, 119_999e15, 1e15);
        vm.prank(keeper);
        process(key, list, 1);
        assertBatch(key, 2, 1, 60e18);

        // only one entry is left
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutChunkSent(key, 1, 1, 60e18, 59_999e15, 1e15);
        vm.prank(keeper);
        process(key, list, 1);
        assertDeleted(key);
    }

    function test_processPayouts_strangerSendsLargestChunk() public {
        (bytes32 key, CascadeMessages.Payout[] memory list) = queueThree();
        vm.prank(owner);
        vault.setMessageLimits(2_000e18, 4_000e18, 1);

        // a stranger's maxEntries 0 (minChunk 1 would have allowed a chunk of 1) is ignored: all three
        // entries fit within 4_000e18, so they go in one chunk. Each pays ceil(60e18 * 1e15 / 180e18) =
        // 333_333_333_333_334 and floors to 59_999_666_666_000_000_000; net = 3 of those
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutChunkSent(key, 0, 3, 180e18, 179_998_999_998_000_000_000, 1e15);
        vm.prank(makeAddr("stranger"));
        process(key, list, 0);
        assertDeleted(key);
        assertEq(bridge.sendCount(), 2);
    }

    function test_processPayouts_keeperChoosesChunkSize() public {
        (bytes32 key, CascadeMessages.Payout[] memory list) = queueThree();
        vm.prank(owner);
        vault.setMessageLimits(2_000e18, 4_000e18, 1);

        // the keeper asks for 1 entry (minChunk 1) and gets 1
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutChunkSent(key, 0, 1, 60e18, 59_999e15, 1e15);
        vm.prank(keeper);
        process(key, list, 1);
        assertBatch(key, 1, 1, 120e18);

        // a stranger asking for 1 gets the rest: ceil(60e18 * 1e15 / 120e18) = 5e14 each
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutChunkSent(key, 1, 2, 120e18, 119_999e15, 1e15);
        vm.prank(makeAddr("stranger"));
        process(key, list, 1);
        assertDeleted(key);
    }

    function test_processPayouts_shortTailFoldedIntoChunk() public {
        (bytes32 key, CascadeMessages.Payout[] memory list) = queueEleven();

        // the keeper's maxEntries 10 (= minChunk) would leave one entry, fewer than minChunk; it fits
        // within 4_000e18 and MAX_ENTRIES, so all 11 go in one chunk. Each pays
        // ceil(1e18 * 1e15 / 11e18) = 90_909_090_909_091 and floors to 999_909_090_000_000_000; net = 11 of those
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutChunkSent(key, 0, 11, 11e18, 10_998_999_990_000_000_000, 1e15);
        vm.prank(keeper);
        process(key, list, 10);

        assertDeleted(key);
        assertEq(bridge.lastAmount(), 10_998_999_990_000_000_000);
        assertEq(bridge.lastValue(), 10_998_999_990_000_000_000 + 1e15);
        assertEq(vault.pendingPayouts(), 100e18);
    }

    function test_processPayouts_tailOverMessageValueNotFolded() public {
        (bytes32 key, CascadeMessages.Payout[] memory list) = queueEleven();
        vm.prank(owner);
        vault.setMessageLimits(10e18, 10.5e18, 10);

        // ten entries make 10e18 <= 10.5e18; with the eleventh, 11e18 > 10.5e18, so the tail waits.
        // Each pays ceil(1e18 * 1e15 / 10e18) = 1e14
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutChunkSent(key, 0, 10, 10e18, 9_999e15, 1e15);
        vm.prank(keeper);
        process(key, list, 10);
        assertBatch(key, 10, 1, 1e18);

        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutChunkSent(key, 1, 1, 1e18, 999e15, 1e15);
        process(key, list, 10);
        assertDeleted(key);
    }

    function test_processPayouts_oversizedFirstEntryStillTaken() public {
        // A = 900e18, S = 9e26: 6e25 → 60e18
        bytes32 k60 = redeemVia(alice, 6e25);
        vm.warp(block.timestamp + 24 hours);
        vm.prank(owner);
        vault.setMessageLimits(50e18, 50e18, 10);

        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutChunkSent(k60, 0, 1, 60e18, 59_999e15, 1e15);
        process(k60, pay1(alice, 6e25, 60e18), 10);
        assertEq(bridge.lastValue(), 60e18);
        assertDeleted(k60);
        assertEq(vault.pendingPayouts(), 100e18);
    }

    // ---- processPayouts: liquidity ----

    function test_processPayouts_unstakesAcrossHotkeys() public {
        vm.startPrank(owner);
        vault.setStakeHotkey(HK2);
        vault.moveStake(HK1, 60_000_000_000);
        vm.stopPrank();
        assertEq(stakeOf(HK1), 940_000_000_000);
        assertEq(stakeOf(HK2), 60_000_000_000);

        // HK2 (stake hotkey) first: want 100_000_000_000 >= 60_000_000_000, a full exit of 60e18; then HK1:
        // want 40_000_000_000 leaves 900_000_000_000, a partial removeStake
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStakeFull, (HK2, 0)));
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 40_000_000_000, 0)));
        vm.expectEmit(address(vault));
        emit CascadeVault.Unstaked(HK2, 100_000_000_000, 60e18);
        vm.expectEmit(address(vault));
        emit CascadeVault.Unstaked(HK1, 40_000_000_000, 40e18);
        process(K, listK(), 10);

        assertEq(stakeOf(HK2), 0);
        assertEq(stakeOf(HK1), 900_000_000_000);
        assertEq(bridge.lastValue(), 100e18);
        assertEq(address(vault).balance, ED);
    }

    function test_processPayouts_retriesAfterPrecompileRevert() public {
        staking.setUnstakeBlocked(true);
        vm.expectRevert(MockStaking.TooEarly.selector);
        process(K, listK(), 10);

        assertBatch(K, 0, 0, 100e18);
        assertEq(vault.pendingPayouts(), 100e18);
        assertEq(stakeOf(HK1), 1_000_000_000_000);
        assertEq(bridge.sendCount(), 0);

        staking.setUnstakeBlocked(false);
        process(K, listK(), 10);
        assertEq(vault.pendingPayouts(), 0);
        assertEq(bridge.sendCount(), 1);
        assertEq(stakeOf(HK1), 900_000_000_000);
    }

    function test_processPayouts_unstakeShortReverts() public {
        // the partial removeStake returns without crediting anything
        vm.mockCall(ISTAKING_ADDRESS, abi.encodeWithSelector(IStaking.removeStake.selector), "");

        // want 100_000_000_000 rao arrives as 0: all 100e18 is unmet
        vm.expectRevert(CascadeVault.UnstakeShort.selector);
        process(K, listK(), 10);

        assertBatch(K, 0, 0, 100e18);
        assertEq(vault.pendingPayouts(), 100e18);
        assertEq(stakeOf(HK1), 1_000_000_000_000);
        assertEq(address(vault).balance, ED);
        assertEq(bridge.sendCount(), 0);

        vm.clearMockedCalls();
        process(K, listK(), 10);
        assertEq(bridge.lastValue(), 100e18);
        assertDeleted(K);
    }

    function test_processPayouts_unstakeMarginCoversRemoveFee() public {
        // the chain keeps 50_000 rao of every removal
        staking.setRemoveFeeRao(50_000);

        // available 0: want 100_000_000_000 arrives as 99_999_950_000 rao, short of net + fee = 100e18
        vm.expectRevert(CascadeVault.UnstakeShort.selector);
        process(K, listK(), 10);
        assertBatch(K, 0, 0, 100e18);
        assertEq(stakeOf(HK1), 1_000_000_000_000);
        // the mock credits with vm.deal, which the revert does not undo
        vm.deal(address(vault), ED);

        vm.prank(owner);
        vault.setUnstakeMarginRao(50_000);

        // want = 100_000_000_000 + 50_000; the fee leaves exactly 100e18, and alice's entry is sent in full
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 100_000_050_000, 0)));
        vm.expectEmit(address(vault));
        emit CascadeVault.Unstaked(HK1, 100_000_050_000, 100e18);
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutChunkSent(K, 0, 1, 100e18, 99_999e15, 1e15);
        process(K, listK(), 10);

        assertEq(bridge.lastValue(), 100e18);
        assertEq(bridge.lastAmount(), 99_999e15);
        assertEq(bridge.lastMessage(), CascadeMessages.encodePayouts(K, 0, entries1(alice, 99_999e15)));
        assertDeleted(K);
        assertEq(vault.pendingPayouts(), 0);
        // 1_000_000_000_000 - 100_000_050_000
        assertEq(stakeOf(HK1), 899_999_950_000);
        assertEq(address(vault).balance, ED);
    }

    function test_processPayouts_twoBatchesFullyStakedBThenA() public {
        (bytes32 a, bytes32 b) = queueTwoFullyStaked();
        uint256 sends = bridge.sendCount();

        // B: available = (ED - ED) - (70e18 - 40e18) floors to 0; unstake 40e18
        vm.expectEmit(address(vault));
        emit CascadeVault.Unstaked(HK1, 40_000_000_000, 40e18);
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutChunkSent(b, 0, 1, 40e18, 39_999e15, 1e15);
        process(b, pay1(bob, 4e25, 40e18), 10);
        assertEq(vault.pendingPayouts(), 30e18);

        // A: available = 0 - (30e18 - 30e18) = 0; unstake 30e18
        vm.expectEmit(address(vault));
        emit CascadeVault.Unstaked(HK1, 30_000_000_000, 30e18);
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutChunkSent(a, 0, 1, 30e18, 29_999e15, 1e15);
        process(a, pay1(alice, 3e25, 30e18), 10);

        assertEq(vault.pendingPayouts(), 0);
        assertEq(bridge.sendCount(), sends + 2);
        assertDeleted(a);
        assertDeleted(b);
        assertEq(stakeOf(HK1), 930_000_000_000);
        assertEq(address(vault).balance, ED);
    }

    function test_processPayouts_twoBatchesFullyStakedAThenB() public {
        (bytes32 a, bytes32 b) = queueTwoFullyStaked();
        uint256 sends = bridge.sendCount();

        // A: available = (ED - ED) - (70e18 - 30e18) floors to 0; unstake 30e18
        vm.expectEmit(address(vault));
        emit CascadeVault.Unstaked(HK1, 30_000_000_000, 30e18);
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutChunkSent(a, 0, 1, 30e18, 29_999e15, 1e15);
        process(a, pay1(alice, 3e25, 30e18), 10);
        assertEq(vault.pendingPayouts(), 40e18);

        // B: available = 0 - (40e18 - 40e18) = 0; unstake 40e18
        vm.expectEmit(address(vault));
        emit CascadeVault.Unstaked(HK1, 40_000_000_000, 40e18);
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutChunkSent(b, 0, 1, 40e18, 39_999e15, 1e15);
        process(b, pay1(bob, 4e25, 40e18), 10);

        assertEq(vault.pendingPayouts(), 0);
        assertEq(bridge.sendCount(), sends + 2);
        assertDeleted(a);
        assertDeleted(b);
        assertEq(stakeOf(HK1), 930_000_000_000);
        assertEq(address(vault).balance, ED);
    }

    // ---- processPayouts: stop powers ----

    function test_processPayouts_frontDoorInactiveHoldsThenCancel() public {
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, frontDoor);

        vm.expectRevert(CascadeVault.FrontDoorInactive.selector);
        process(K, listK(), 10);
        assertBatch(K, 0, 0, 100e18);

        vm.expectEmit(address(vault));
        emit CascadeVault.RedeemReversed(K, alice, 1e26, 100e18);
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutBatchCancelled(K, 100e18);
        cancel(K, listK());

        assertEq(vault.balanceOf(alice), 1e27);
        assertEq(vault.totalSupply(), 1e27);
        assertEq(vault.pendingPayouts(), 0);
        assertDeleted(K);
        assertEq(bridge.sendCount(), 0);
        vm.expectRevert(CascadeVault.NotPending.selector);
        process(K, listK(), 10);
    }

    function test_processPayouts_primaryBridgeDisabledHoldsBatch() public {
        vm.prank(guardian);
        vault.disableBridge(address(bridge));

        vm.expectRevert(CascadeBase.PrimaryBridgeDisabled.selector);
        process(K, listK(), 10);
        assertBatch(K, 0, 0, 100e18);
        assertEq(vault.pendingPayouts(), 100e18);
        assertEq(stakeOf(HK1), 1_000_000_000_000);
        assertEq(address(vault).balance, ED);

        StubBridge bridge2 = new StubBridge(IERC20(address(0)));
        bridge2.setFee(1e15);
        vm.startPrank(owner);
        vault.proposeBridge(address(bridge2));
        vm.warp(block.timestamp + 7 days);
        vault.activateBridge(address(bridge2));
        vault.setPrimaryBridge(address(bridge2));
        vm.stopPrank();

        process(K, listK(), 10);
        assertEq(bridge2.sendCount(), 1);
        assertEq(bridge2.lastValue(), 100e18);
        assertEq(bridge2.lastAmount(), 99_999e15);
        assertEq(bridge.sendCount(), 0);
        assertDeleted(K);
    }

    // ---- cancelPayoutBatch ----

    function test_cancelPayoutBatch_afterPartialChunk() public {
        (bytes32 key, CascadeMessages.Payout[] memory list) = queueThree();
        vm.prank(owner);
        vault.setMessageLimits(150e18, 150e18, 1);
        process(key, list, 10);
        assertBatch(key, 2, 1, 60e18);

        vm.recordLogs();
        vm.expectEmit(address(vault));
        emit CascadeVault.RedeemReversed(key, carol, 6e25, 60e18);
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutBatchCancelled(key, 60e18);
        cancel(key, list);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 reversed;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == CascadeVault.RedeemReversed.selector) {
                ++reversed;
            }
        }
        assertEq(reversed, 1);

        // carol: 1e26 - 6e25 + 6e25; alice 9e26 - 6e25 and bob 1e26 - 6e25 were paid
        assertEq(vault.balanceOf(carol), 1e26);
        assertEq(vault.balanceOf(alice), 84e25);
        assertEq(vault.balanceOf(bob), 4e25);
        assertEq(vault.pendingPayouts(), 0);
        assertDeleted(key);
    }

    function test_cancelPayoutBatch_ownerOnly() public {
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        vault.cancelPayoutBatch(K, listK());
        assertBatch(K, 0, 0, 100e18);
    }

    function test_cancelPayoutBatch_worksWhilePaused() public {
        vm.prank(guardian);
        vault.pause();

        cancel(K, listK());
        assertEq(vault.balanceOf(alice), 1e27);
        assertEq(vault.pendingPayouts(), 0);
        assertDeleted(K);
    }

    function test_cancelPayoutBatch_wrongListReverts() public {
        vm.startPrank(owner);
        vm.expectRevert(CascadeVault.PayoutsMismatch.selector);
        vault.cancelPayoutBatch(K, pay1(alice, 1e26 + 1, 100e18));
        vm.expectRevert(CascadeVault.PayoutsMismatch.selector);
        vault.cancelPayoutBatch(K, pay2(alice, 1e26, 100e18, alice, 1e26, 100e18));
        vm.expectRevert(CascadeVault.NotPending.selector);
        vault.cancelPayoutBatch(keccak256("unknown"), listK());
        vm.stopPrank();

        assertEq(vault.balanceOf(alice), 9e26);
        assertBatch(K, 0, 0, 100e18);
    }

    function test_cancelPayoutBatch_twiceRevertsNotPending() public {
        cancel(K, listK());
        assertEq(vault.balanceOf(alice), 1e27);

        vm.prank(owner);
        vm.expectRevert(CascadeVault.NotPending.selector);
        vault.cancelPayoutBatch(K, listK());
        assertEq(vault.balanceOf(alice), 1e27);
        assertEq(vault.totalSupply(), 1e27);
        assertEq(vault.pendingPayouts(), 0);
    }

    function test_cancelPayoutBatch_afterFullPayoutRevertsNotPending() public {
        process(K, listK(), 10);
        assertEq(vault.balanceOf(alice), 9e26);

        vm.prank(owner);
        vm.expectRevert(CascadeVault.NotPending.selector);
        vault.cancelPayoutBatch(K, listK());
        assertEq(vault.balanceOf(alice), 9e26);
        assertEq(vault.totalSupply(), 9e26);
        assertEq(vault.pendingPayouts(), 0);
    }

    function test_cancelPayoutBatch_priceStaysAtOrAboveDeliveryPrice() public {
        // K's batch price: (1_000e18 + 1) * 1e18 / (1e27 + 1e6) = 1e12; queueing it left the price there
        uint256 p0 = 1e12;
        assertEq(vault.price(), p0);

        // 1 TAO of rewards, fully vested after 7 days
        staking.setUnclaimed(vault.coldkey(), HK1, 1_000_000_000);
        vm.prank(keeper);
        vault.claimRewards{gas: 60_000_000}(HK1);
        vm.warp(block.timestamp + 7 days);

        cancel(K, listK());
        // gross 1_001e18, nothing pending, S = 1e27: (1_001e18 + 1) * 1e18 / (1e27 + 1e6) = 1_000_999_999_999
        assertEq(vault.price(), 1_000_999_999_999);
        assertGe(vault.price(), p0);
    }

    function test_cancelPayoutBatch_keepsBurnedWindow() public {
        bytes32 peer = vault.peerId(BASE, frontDoor);
        (uint64 start, uint256 burned) = vault.burnWindows(peer);
        assertEq(start, tK);
        assertEq(burned, 100e18);

        cancel(K, listK());

        (start, burned) = vault.burnWindows(peer);
        assertEq(start, tK);
        assertEq(burned, 100e18);
    }

    // ---- reservations seen by the other paths ----

    function test_redeemDirect_leavesPendingPayoutsReserved() public {
        // A = 900e18, S = 9e26: 150e18 → 1.5e26 shares for bob, left liquid (no stakeIdle here):
        // the vault holds ED + 150e18, of which 100e18 is K's reservation
        depositVia(bob, 150e18);

        // A = 1_050e18, S = 1.05e27: 5e25 → 50e18, the unreserved balance exactly; paid without unstaking
        vm.recordLogs();
        vm.prank(bob);
        vault.redeemDirect(5e25);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != CascadeVault.Unstaked.selector);
        }
        assertEq(bob.balance, 50e18);
        assertEq(vault.pendingPayouts(), 100e18);
        assertEq(address(vault).balance, ED + 100e18);
        assertEq(stakeOf(HK1), 1_000_000_000_000);

        // A = 1_000e18, S = 1e27: 5e25 → 50e18 more; nothing is unreserved, so it is unstaked
        vm.expectEmit(address(vault));
        emit CascadeVault.Unstaked(HK1, 50_000_000_000, 50e18);
        vm.prank(bob);
        vault.redeemDirect(5e25);
        assertEq(bob.balance, 100e18);
        assertEq(vault.pendingPayouts(), 100e18);
        assertEq(address(vault).balance, ED + 100e18);
    }

    function test_stakeIdle_flooredWhenPendingExceedsBalance() public {
        // balance ED, pending 100e18: (ED - ED) - 100e18 floors to 0
        vm.prank(keeper);
        vm.expectRevert(CascadeVault.NothingToStake.selector);
        vault.stakeIdle();
        assertEq(stakeOf(HK1), 1_000_000_000_000);
    }
}
