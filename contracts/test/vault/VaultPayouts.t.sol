// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {ISTAKING_ADDRESS, IStaking} from "../../src/interfaces/IStaking.sol";
import {CascadeFormulas} from "../../src/libraries/CascadeFormulas.sol";
import {CascadeMath} from "../../src/libraries/CascadeMath.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {CascadePayoutMath} from "../../src/libraries/CascadePayoutMath.sol";
import {ReentrantRecipient} from "../mocks/ReentrantRecipient.sol";
import {StubBridge} from "../mocks/StubBridge.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {Schedule} from "../governance/Schedule.sol";
import {
    BadValue,
    FeeTooHigh,
    FrontDoorInactive,
    InvalidParameter,
    NotPending,
    NothingToCancel,
    NothingToStake,
    PayoutDelayed,
    PayoutsMismatch,
    PrimaryBridgeDisabled,
    TransferFailed,
    UnstakeShort
} from "../../src/CascadeErrors.sol";
import {
    DepositBounced,
    PayoutBatchCancelled,
    PayoutChunkSent,
    PayoutDust,
    RedeemDeferred,
    Redeemed,
    RedeemReversed,
    Unstaked
} from "../../src/CascadeEvents.sol";
import {BounceReason, PayoutBatch} from "../../src/CascadeTypes.sol";
import {VaultLayout} from "../../src/lens/generated/VaultLayout.sol";

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
        tK = vm.getBlockTimestamp();
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

    /// The message limits set as the owner, through the scheduler (Task 11): every use here takes minChunk
    /// below the fixture's 10, a loosening.
    function messageLimits(uint256 maxEntryValue, uint256 maxMessageValue, uint32 minChunk) internal {
        Schedule.run(
            vault, owner, abi.encodeCall(CascadeVault.setMessageLimits, (maxEntryValue, maxMessageValue, minChunk))
        );
    }

    function process(bytes32 key, CascadeMessages.Payout[] memory list, uint32 maxEntries) internal {
        vault.processPayouts(key, list, maxEntries);
    }

    function cancel(bytes32 key, CascadeMessages.Payout[] memory list) internal {
        vm.prank(owner);
        vault.cancelPayoutBatch(key, list);
    }

    function stakeOf(bytes32 h) internal view returns (uint256) {
        return staking.getStake(h, vaultLens.coldkey(), 0);
    }

    /// The keeper claims `rao` of HK1's rewards and the 7-day schedule runs out: the price rises by all of it.
    function vestRewards(uint256 rao) internal {
        staking.setUnclaimed(vaultLens.coldkey(), HK1, rao);
        vm.prank(keeper);
        vault.claimRewards{gas: 60_000_000}(HK1);
        vm.warp(vm.getBlockTimestamp() + 7 days);
    }

    /// The value of `shares` at the price now.
    function valueOf(uint256 shares) internal view returns (uint256) {
        return CascadeMath.assetsForRedeem(shares, vaultLens.totalAssets(), vault.totalSupply());
    }

    /// The re-mint a cancel owes an entry of `assets` that burned `burned` shares (Task 34c): the shares its value buys
    /// at the price before the cancel, `assetsBefore` over `supplyBefore`, never more than it burned.
    function reMintOf(uint256 burned, uint256 assets, uint256 assetsBefore, uint256 supplyBefore)
        internal
        pure
        returns (uint256)
    {
        uint256 owed = CascadeMath.sharesForDeposit(assets, assetsBefore, supplyBefore);
        return owed < burned ? owed : burned;
    }

    /// The (user, shares, assets) of every RedeemReversed batch `key` logged in `logs`, in log order.
    function reversals(Vm.Log[] memory logs, bytes32 key) internal view returns (CascadeMessages.Payout[] memory r) {
        CascadeMessages.Payout[] memory all = new CascadeMessages.Payout[](logs.length);
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(vault) || l.topics[0] != RedeemReversed.selector || l.topics[1] != key) continue;
            (uint256 shares, uint256 assets) = abi.decode(l.data, (uint256, uint256));
            // casting to 'uint160' is safe because the topic is an indexed address
            // forge-lint: disable-next-line(unsafe-typecast)
            all[n++] = CascadeMessages.Payout(address(uint160(uint256(l.topics[2]))), shares, assets);
        }
        r = new CascadeMessages.Payout[](n);
        for (uint256 i; i < n; ++i) {
            r[i] = all[i];
        }
    }

    function assertBatch(bytes32 key, uint256 cursor, uint256 chunk, uint256 remaining) internal view {
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        assertEq(b.cursor, cursor, "cursor");
        assertEq(b.chunk, chunk, "chunk");
        assertEq(b.remaining, remaining, "remaining");
    }

    function assertDeleted(bytes32 key) internal view {
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        assertEq(b.count, 0, "count");
        assertEq(b.cursor, 0, "cursor");
        assertEq(b.remaining, 0, "remaining");
        assertEq(b.payoutsHash, bytes32(0), "hash");
        assertEq(b.frontDoor, address(0), "frontDoor");
        assertTrue(vaultLens.processed(key), "processed");
    }

    /// K is paid (HK1 900_000_000_000 rao, balance ED, nothing pending; A = 900e18, S = 9e26). bob and carol
    /// deposit 100e18 each, left liquid: 100e18 * (9e26 + 1e6) / (900e18 + 1) = 1e26, then at A = 1_000e18,
    /// S = 1e27 another 1e26. The outflow limits, the door's and the global one (Task 17), go up to 50% (a
    /// loosening: a scheduled item, 48 hours, Task 11). One batch redeems 6e25 each for alice, bob and carol at
    /// A = 1_100e18, S = 1.1e27:
    /// 6e25 * (1_100e18 + 1) / (1.1e27 + 1e6) = 60e18 each. Then 24 hours pass.
    function queueThree() internal returns (bytes32 key, CascadeMessages.Payout[] memory list) {
        process(K, listK(), 10);
        depositVia(bob, 100e18);
        depositVia(carol, 100e18);
        Schedule.run(vault, owner, abi.encodeCall(CascadeVault.setOutflowLimits, (5_000, 100e18, 5_000)));
        key = redeemVia(entries3(alice, 6e25, bob, 6e25, carol, 6e25));
        list = new CascadeMessages.Payout[](3);
        list[0] = CascadeMessages.Payout(alice, 6e25, 60e18);
        list[1] = CascadeMessages.Payout(bob, 6e25, 60e18);
        list[2] = CascadeMessages.Payout(carol, 6e25, 60e18);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
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
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        assertEq(vaultLens.pendingPayouts(), 70e18);
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
        for (uint256 i; i < 11; ++i) {
            matureShares(d[i].user);
        }
        key = redeemVia(r);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
    }

    /// A second door's chain, the redeem origin that makes a BASE door's deposit bounce (bounceVia).
    uint64 constant OPTIMISM = 10;
    uint256 constant RAO = 1e9;

    /// A BASE door deposit of `amount` for `user` that bounces (ForeignOrigin, spec §3.4): the user's redeem origin is
    /// OPTIMISM, whose door is activated first if it is not (the Registry class's 7 days). Returns the batch key; the
    /// bounce is queued as (user, 0 shares, amount), its TAO left liquid.
    function bounceVia(address user, uint256 amount) internal returns (bytes32 key) {
        foreign(user);
        bytes memory message = CascadeMessages.encodeBatch(nextBatchId + 1, entries1(user, amount), noEntries());
        vm.expectEmit(address(vault));
        emit DepositBounced(vaultLens.batchKey(BASE, frontDoor, message), user, amount, BounceReason.ForeignOrigin);
        key = deliver(BASE, frontDoor, ++nextBatchId, entries1(user, amount), noEntries());
    }

    /// `user`'s redeem origin set to OPTIMISM, whose door is activated first if it is not (the Registry class's 7 days):
    /// its BASE door deposits bounce (ForeignOrigin).
    function foreign(address user) internal {
        if (vaultLens.activeDoors(OPTIMISM) == 0) registerFrontDoor(OPTIMISM, makeAddr("door10"));
        vm.prank(user);
        vault.setRedeemOrigin(OPTIMISM);
    }

    /// One BASE door batch at A = 900e18, S = 9e26 (K paid or still queued: assets = shares / 1e6): a deposit of each
    /// of `bounced` from a foreign() holder, each bouncing and queued first as (user, 0, amount), its TAO left liquid,
    /// then alice's redeem of `shares`, queued after them. Returns its key and full ordered list; the payout delay
    /// runs from now.
    function queueBouncesThenRedeem(CascadeMessages.Entry[] memory bounced, uint256 shares)
        internal
        returns (bytes32 key, CascadeMessages.Payout[] memory list)
    {
        list = new CascadeMessages.Payout[](bounced.length + 1);
        for (uint256 i; i < bounced.length; ++i) {
            foreign(bounced[i].user);
            list[i] = CascadeMessages.Payout(bounced[i].user, 0, bounced[i].amount);
        }
        list[bounced.length] = CascadeMessages.Payout(alice, shares, shares / 1e6);
        key = deliver(BASE, frontDoor, ++nextBatchId, bounced, entries1(alice, shares));
    }

    /// The keeper's rebuild (spec §3.10.15): batch `key`'s list from the vault's DepositBounced and Redeemed logs, in
    /// log order.
    function rebuild(Vm.Log[] memory logs, bytes32 key) internal view returns (CascadeMessages.Payout[] memory list) {
        CascadeMessages.Payout[] memory all = new CascadeMessages.Payout[](logs.length);
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(vault) || l.topics.length < 3 || l.topics[1] != key) continue;
            // casting to 'uint160' is safe because the topic is an indexed address
            // forge-lint: disable-next-line(unsafe-typecast)
            address user = address(uint160(uint256(l.topics[2])));
            if (l.topics[0] == DepositBounced.selector) {
                (uint256 assets,) = abi.decode(l.data, (uint256, BounceReason));
                all[n++] = CascadeMessages.Payout(user, 0, assets);
            } else if (l.topics[0] == Redeemed.selector) {
                (uint256 shares, uint256 assets) = abi.decode(l.data, (uint256, uint256));
                all[n++] = CascadeMessages.Payout(user, shares, assets);
            }
        }
        list = new CascadeMessages.Payout[](n);
        for (uint256 i; i < n; ++i) {
            list[i] = all[i];
        }
    }

    /// The last `n` bounce entries (0 shares) of `list`, in order: a cancel's carried list (spec §3.10.15).
    function lastBounces(CascadeMessages.Payout[] memory list, uint256 n)
        internal
        pure
        returns (CascadeMessages.Payout[] memory out)
    {
        uint256 skip;
        for (uint256 i; i < list.length; ++i) {
            if (list[i].shares == 0) ++skip;
        }
        skip -= n;
        out = new CascadeMessages.Payout[](n);
        uint256 k;
        for (uint256 i; i < list.length; ++i) {
            if (list[i].shares != 0) continue;
            if (skip != 0) --skip;
            else out[k++] = list[i];
        }
    }

    /// alice's smallest burned exit beside K, still staked: 3e22 shares at A = 900e18, S = 9e26 are exactly 0.03 TAO
    /// (MIN_REDEEM_VALUE), queued alone. Then 24 hours pass.
    function queueLonely() internal returns (bytes32 key, CascadeMessages.Payout[] memory list) {
        key = redeemVia(alice, 3e22);
        list = pay1(alice, 3e22, 3e16);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
    }

    // ---- processPayouts: guards ----

    function test_processPayouts_beforeDelayReverts() public {
        vm.warp(tK + 24 hours - 1);
        vm.expectRevert(PayoutDelayed.selector);
        process(K, listK(), 10);

        vm.warp(tK + 24 hours);
        process(K, listK(), 10);
        assertEq(vaultLens.pendingPayouts(), 0);
    }

    function test_processPayouts_wrongListReverts() public {
        // wrong user, wrong shares, wrong assets
        vm.expectRevert(PayoutsMismatch.selector);
        process(K, pay1(bob, 1e26, 100e18), 10);
        vm.expectRevert(PayoutsMismatch.selector);
        process(K, pay1(alice, 1e26 + 1, 100e18), 10);
        vm.expectRevert(PayoutsMismatch.selector);
        process(K, pay1(alice, 1e26, 100e18 + 1), 10);
        // wrong length: the right entry twice, or nothing
        vm.expectRevert(PayoutsMismatch.selector);
        process(K, pay2(alice, 1e26, 100e18, alice, 1e26, 100e18), 10);
        vm.expectRevert(PayoutsMismatch.selector);
        process(K, new CascadeMessages.Payout[](0), 10);

        assertBatch(K, 0, 0, 100e18);
        assertEq(vaultLens.pendingPayouts(), 100e18);
    }

    function test_processPayouts_unknownKeyReverts() public {
        vm.expectRevert(NotPending.selector);
        process(keccak256("unknown"), listK(), 10);
        // a deposit-only batch is processed but queued nothing
        bytes32 depositOnly = depositVia(bob, 1e18);
        vm.expectRevert(NotPending.selector);
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

        vm.expectRevert(NotPending.selector);
        process(K, listK(), 10);
        assertEq(bridge.sendCount(), 1);
    }

    // ---- processPayouts: amounts ----

    function test_processPayouts_singleChunkSendsNetPlusFee() public {
        // available = (ED - ED) - (100e18 - 100e18) = 0, so all of net + fee = 100e18 is unstaked, and the
        // shortfall tolerance on top (Task 19): want 100_000_001_000 rao leaves 899_999_999_000 >= 20_000_000, a
        // partial removeStake. fee: ceil(100e18 * 1e15 / 100e18) = 1e15; net = 100e18 - 1e15 = 99_999e15
        // (rao-aligned)
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 100_000_001_000, 0)));
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 100_000_001_000, 100e18 + 1_000e9);
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(K, 0, 1, 100e18, 99_999e15, 1e15, 1e15, 0);
        process(K, listK(), 10);

        assertEq(bridge.sendCount(), 1);
        assertEq(bridge.lastValue(), 100e18);
        assertEq(bridge.lastAmount(), 99_999e15);
        assertEq(bridge.lastMessage(), CascadeMessages.encodePayouts(K, 0, entries1(alice, 99_999e15)));
        assertEq(bridge.lastDestChain(), BASE);
        assertEq(bridge.lastRecipient(), frontDoor);
        assertEq(address(bridge).balance, 100e18);

        assertEq(vaultLens.pendingPayouts(), 0);
        assertDeleted(K);
        assertEq(stakeOf(HK1), 899_999_999_000);
        // the 1_000-rao cushion stays idle
        assertEq(address(vault).balance, ED + 1_000e9);
    }

    function test_processPayouts_feeRoundingRemainderStaysInVault() public {
        // A = 900e18, S = 9e26: 2e18 * (9e26 + 1e6) / (900e18 + 1) = 2e24, left liquid
        depositVia(bob, 2e18);
        // A = 902e18, S = 9.02e26: alice 1e24 → 1e18, bob 2e24 → 2e18
        bytes32 k2 = redeemVia(entries2(alice, 1e24, bob, 2e24));
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        uint256 grossBefore = vaultLens.grossAssets();
        assertEq(grossBefore, 1_002e18);

        // sum 3e18. alice: ceil(1e18 * 1e15 / 3e18) = 333_333_333_333_334, 1e18 - that = 999_666_666_666_666_666
        // floors to 999_666_666_000_000_000; bob: ceil(2e18 * 1e15 / 3e18) = 666_666_666_666_667,
        // 1_999_333_333_333_333_333 floors to 1_999_333_333_000_000_000. net = 2_998_999_999_000_000_000;
        // sent net + fee = 2_999_999_999_000_000_000; 3e18 - that = 1e9 stays.
        // available = (ED + 2e18 - ED) - (103e18 - 3e18) floors to 0: unstake 2_999_999_999 rao and the 1_000-rao
        // tolerance on top (Task 19), 3_000_000_999 rao
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 3_000_000_999, 3_000_000_999_000_000_000);
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(k2, 0, 2, 3e18, 2_998_999_999_000_000_000, 1e15, 1e15, 0);
        process(k2, pay2(alice, 1e24, 1e18, bob, 2e24, 2e18), 10);

        assertEq(
            bridge.lastMessage(),
            CascadeMessages.encodePayouts(
                k2, 0, entries2(alice, 999_666_666_000_000_000, bob, 1_999_333_333_000_000_000)
            )
        );
        assertEq(bridge.lastAmount(), 2_998_999_999_000_000_000);
        assertEq(bridge.lastValue(), 2_999_999_999_000_000_000);
        assertEq(vaultLens.grossAssets(), grossBefore - 2_999_999_999_000_000_000);
        assertEq(vaultLens.pendingPayouts(), 100e18);
        assertDeleted(k2);
    }

    function test_processPayouts_feeCeilingReverts() public {
        // ceiling = max(100e18 * 100 / 10_000, 0.015e18) = 1e18; the quote rounds up to 1e18 + 1e9, and with no value
        // from the caller to top up the rao above the ceiling, the chunk waits
        bridge.setFee(1e18 + 1);
        vm.expectRevert(FeeTooHigh.selector);
        process(K, listK(), 10);
        assertBatch(K, 0, 0, 100e18);
        assertEq(vaultLens.pendingPayouts(), 100e18);
        assertEq(bridge.sendCount(), 0);

        // at the ceiling: net = 100e18 - 1e18
        bridge.setFee(1e18);
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(K, 0, 1, 100e18, 99e18, 1e18, 1e18, 0);
        process(K, listK(), 10);
        assertEq(bridge.lastValue(), 100e18);
        assertEq(bridge.lastAmount(), 99e18);
        assertEq(vaultLens.pendingPayouts(), 0);
    }

    function test_processPayouts_subRaoFeeRoundsUpToWholeRao() public {
        // the quote 1e15 + 1 rounds up to 1e15 + 1e9 = 1_000_001_000_000_000; ceiling 1e18
        bridge.setFee(1e15 + 1);
        // net = 100e18 - ceil(100e18 * 1_000_001_000_000_000 / 100e18) = 99_998_999_999_000_000_000 (rao-aligned);
        // sent = net + fee = 100e18. Unrounded, the send would carry 99_999_999_999_000_000_001 wei.
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(
            K, 0, 1, 100e18, 99_998_999_999_000_000_000, 1_000_001_000_000_000, 1_000_001_000_000_000, 0
        );
        process(K, listK(), 10);

        assertEq(bridge.lastValue(), 100e18);
        assertEq(bridge.lastValue() % 1e9, 0);
        assertEq(bridge.lastAmount(), 99_998_999_999_000_000_000);
        assertEq(bridge.lastMessage(), CascadeMessages.encodePayouts(K, 0, entries1(alice, 99_998_999_999_000_000_000)));
        assertDeleted(K);
    }

    /// A chunk whose every entry is dust sends nothing and completes the batch. Only an entry with no shares can be
    /// dust (Task 21: one with shares reverts FeeTooHigh), so here it is a bounced deposit of 0.01 TAO, below any
    /// minDeposit the front door's bound allows (the dust branch is defensive, spec §3.3). A 0.02 TAO quote charges
    /// it the 0.015 TAO ceiling, which leaves it nothing. The rest of the quote must be topped up as for any chunk
    /// (FeeTooHigh without it), and since nothing is sent, the caller's whole value comes back.
    function test_processPayouts_dustTailCompletesBatch() public {
        process(K, listK(), 10);
        bytes32 k2 = bounceVia(bob, 1e16);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        // ceiling = max(1e16 * 100 / 10_000, 0.015e18) = 0.015e18, at least the bounce's 1e16
        bridge.setFee(2e16);
        vm.expectRevert(FeeTooHigh.selector);
        process(k2, pay1(bob, 0, 1e16), 10);
        uint256 grossBefore = vaultLens.grossAssets();
        uint256 sends = bridge.sendCount();
        vm.deal(carol, 5e15);

        vm.recordLogs();
        vm.expectEmit(address(vault));
        emit PayoutDust(k2, bob, 1e16);
        // nothing sent, so no fee paid
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(k2, 0, 1, 1e16, 0, 0, 0, 0);
        processPayoutsFrom(carol, 5e15, k2, pay1(bob, 0, 1e16), 10);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != Unstaked.selector);
        }

        assertEq(carol.balance, 5e15, "the caller's whole value back");
        assertEq(bridge.sendCount(), sends);
        assertDeleted(k2);
        assertEq(vaultLens.pendingPayouts(), 0);
        assertEq(vaultLens.grossAssets(), grossBefore);
    }

    /// An entry its share of the fee leaves with nothing is dust and stays in the vault, while the rest of
    /// its chunk goes out. Every burned redeem is worth at least 0.03 TAO (MIN_REDEEM_VALUE), and one with shares
    /// left with nothing would revert FeeTooHigh (Task 21), so such an entry is a bounced deposit: here bob's
    /// 1-rao deposit, bounced because 600e18 of the stake was lost and written off.
    function test_processPayouts_individualDustEntryDropped() public {
        staking.loseStake(HK1, vaultLens.coldkey(), 600_000_000_000);
        Schedule.run(vault, owner, abi.encodeCall(vault.writeOffMissingStake, (600_000_000_000)));
        assertFalse(vaultLens.stakeMissing(), "written off");
        // 600e18 of the stake lost and written off by the owner's scheduled item (a loss, not missing stake, which
        // would refuse the batch): A = 400e18 - 100e18 pending = 300e18 against S = 9e26, below half the launch price:
        // bob's 1e9 bounces; alice 5e24 * (300e18 + 1) / (9e26 + 1e6) = 1_666_666_666_666_666_666 → 1_666_666_666e9
        bytes32 k2 = deliver(BASE, frontDoor, ++nextBatchId, entries1(bob, 1e9), entries1(alice, 5e24));
        vm.warp(vm.getBlockTimestamp() + 24 hours);

        // sum = 1_666_666_667e9. bob: ceil(1e9 * 1e15 / sum) = 600_000, 999_400_000 floors to 0 → dust.
        // alice: ceil(1_666_666_666e9 * 1e15 / sum) = 999_999_999_400_001; 1_666_666_666e9 less that is
        // 1_665_666_666_000_599_999, which floors to 1_665_666_666e9.
        vm.expectEmit(address(vault));
        emit PayoutDust(k2, bob, 1e9);
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(k2, 0, 2, 1_666_666_667e9, 1_665_666_666e9, 1e15, 1e15, 0);
        process(k2, pay2(bob, 0, 1e9, alice, 5e24, 1_666_666_666e9), 10);

        assertEq(bridge.lastMessage(), CascadeMessages.encodePayouts(k2, 0, entries1(alice, 1_665_666_666e9)));
        assertEq(bridge.lastAmount(), 1_665_666_666e9);
        assertEq(bridge.lastValue(), 1_665_666_666e9 + 1e15);
        assertDeleted(k2);
        assertEq(vaultLens.pendingPayouts(), 100e18);
    }

    // ---- processPayouts: chunking ----

    function test_processPayouts_chunksByMessageValue() public {
        (bytes32 key, CascadeMessages.Payout[] memory list) = queueThree();
        // maxEntryValue must not exceed maxMessageValue, so both are 150e18 (minChunk down: scheduled)
        messageLimits(150e18, 150e18, 1);
        uint256 sends = bridge.sendCount();

        // 60e18 + 60e18 = 120e18 <= 150e18; another 60e18 would exceed it. Each pays
        // ceil(60e18 * 1e15 / 120e18) = 5e14: 59_999_500_000_000_000_000. Liquid 200e18 covers it, no unstake.
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(key, 0, 2, 120e18, 119_999e15, 1e15, 1e15, 0);
        process(key, list, 10);
        assertEq(
            bridge.lastMessage(),
            CascadeMessages.encodePayouts(
                key, 0, entries2(alice, 59_999_500_000_000_000_000, bob, 59_999_500_000_000_000_000)
            )
        );
        assertEq(bridge.lastValue(), 120e18);
        assertBatch(key, 2, 1, 60e18);
        assertEq(vaultLens.pendingPayouts(), 60e18);

        vm.expectEmit(address(vault));
        emit PayoutChunkSent(key, 1, 1, 60e18, 59_999e15, 1e15, 1e15, 0);
        process(key, list, 10);
        assertEq(bridge.lastMessage(), CascadeMessages.encodePayouts(key, 1, entries1(carol, 59_999e15)));
        assertEq(bridge.lastValue(), 60e18);
        assertEq(bridge.sendCount(), sends + 2);
        assertDeleted(key);
        assertEq(vaultLens.pendingPayouts(), 0);
        // K's walk took the 1_000-rao tolerance on top (Task 19)
        assertEq(stakeOf(HK1), 899_999_999_000);
    }

    function test_processPayouts_maxEntriesRaisedToMinChunk() public {
        (bytes32 key, CascadeMessages.Payout[] memory list) = queueThree();
        // a 120e18 message cap keeps the third 60e18 entry out of the first chunk (it is not folded in)
        messageLimits(120e18, 120e18, 2);

        // the keeper's maxEntries 1 is raised to minChunk 2
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(key, 0, 2, 120e18, 119_999e15, 1e15, 1e15, 0);
        vm.prank(keeper);
        process(key, list, 1);
        assertBatch(key, 2, 1, 60e18);

        // only one entry is left
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(key, 1, 1, 60e18, 59_999e15, 1e15, 1e15, 0);
        vm.prank(keeper);
        process(key, list, 1);
        assertDeleted(key);
    }

    function test_processPayouts_strangerSendsLargestChunk() public {
        (bytes32 key, CascadeMessages.Payout[] memory list) = queueThree();
        messageLimits(2_000e18, 4_000e18, 1);

        // a stranger's maxEntries 0 (minChunk 1 would have allowed a chunk of 1) is ignored: all three
        // entries fit within 4_000e18, so they go in one chunk. Each pays ceil(60e18 * 1e15 / 180e18) =
        // 333_333_333_333_334 and floors to 59_999_666_666_000_000_000; net = 3 of those
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(key, 0, 3, 180e18, 179_998_999_998_000_000_000, 1e15, 1e15, 0);
        vm.prank(makeAddr("stranger"));
        process(key, list, 0);
        assertDeleted(key);
        assertEq(bridge.sendCount(), 2);
    }

    function test_processPayouts_keeperChoosesChunkSize() public {
        (bytes32 key, CascadeMessages.Payout[] memory list) = queueThree();
        messageLimits(2_000e18, 4_000e18, 1);

        // the keeper asks for 1 entry (minChunk 1) and gets 1
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(key, 0, 1, 60e18, 59_999e15, 1e15, 1e15, 0);
        vm.prank(keeper);
        process(key, list, 1);
        assertBatch(key, 1, 1, 120e18);

        // a stranger asking for 1 gets the rest: ceil(60e18 * 1e15 / 120e18) = 5e14 each
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(key, 1, 2, 120e18, 119_999e15, 1e15, 1e15, 0);
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
        emit PayoutChunkSent(key, 0, 11, 11e18, 10_998_999_990_000_000_000, 1e15, 1e15, 0);
        vm.prank(keeper);
        process(key, list, 10);

        assertDeleted(key);
        assertEq(bridge.lastAmount(), 10_998_999_990_000_000_000);
        assertEq(bridge.lastValue(), 10_998_999_990_000_000_000 + 1e15);
        assertEq(vaultLens.pendingPayouts(), 100e18);
    }

    function test_processPayouts_tailOverMessageValueNotFolded() public {
        (bytes32 key, CascadeMessages.Payout[] memory list) = queueEleven();
        vm.prank(owner);
        vault.setMessageLimits(10e18, 10.5e18, 10);

        // ten entries make 10e18 <= 10.5e18; with the eleventh, 11e18 > 10.5e18, so the tail waits.
        // Each pays ceil(1e18 * 1e15 / 10e18) = 1e14
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(key, 0, 10, 10e18, 9_999e15, 1e15, 1e15, 0);
        vm.prank(keeper);
        process(key, list, 10);
        assertBatch(key, 10, 1, 1e18);

        vm.expectEmit(address(vault));
        emit PayoutChunkSent(key, 1, 1, 1e18, 999e15, 1e15, 1e15, 0);
        process(key, list, 10);
        assertDeleted(key);
    }

    function test_processPayouts_oversizedFirstEntryStillTaken() public {
        // A = 900e18, S = 9e26: 6e25 → 60e18
        bytes32 k60 = redeemVia(alice, 6e25);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.prank(owner);
        vault.setMessageLimits(50e18, 50e18, 10);

        vm.expectEmit(address(vault));
        emit PayoutChunkSent(k60, 0, 1, 60e18, 59_999e15, 1e15, 1e15, 0);
        process(k60, pay1(alice, 6e25, 60e18), 10);
        assertEq(bridge.lastValue(), 60e18);
        assertDeleted(k60);
        assertEq(vaultLens.pendingPayouts(), 100e18);
    }

    // ---- processPayouts: liquidity ----

    function test_processPayouts_unstakesAcrossHotkeys() public {
        // both scheduled (Task 11), the first to a listed hotkey (Task 14a)
        vm.prank(owner);
        vault.addHotkey(HK2);
        Schedule.run(vault, owner, abi.encodeCall(CascadeVault.setStakeHotkey, (HK2)));
        Schedule.run(vault, owner, abi.encodeCall(CascadeVault.moveStake, (HK1, HK2, 60_000_000_000)));
        assertEq(stakeOf(HK1), 940_000_000_000);
        assertEq(stakeOf(HK2), 60_000_000_000);

        // net + fee = 100e18 and the 1_000-rao tolerance on top (Task 19). HK2 (stake hotkey) first: want
        // 100_000_001_000 >= 60_000_000_000, a full exit of 60e18 (its Unstaked logs the position: R2 F2); then HK1:
        // want 40_000_001_000 leaves 899_999_999_000, a partial removeStake
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStakeFull, (HK2, 0)));
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 40_000_001_000, 0)));
        vm.expectEmit(address(vault));
        emit Unstaked(HK2, 60_000_000_000, 60e18);
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 40_000_001_000, 40_000_001_000e9);
        process(K, listK(), 10);

        assertEq(stakeOf(HK2), 0);
        assertEq(stakeOf(HK1), 899_999_999_000);
        assertEq(bridge.lastValue(), 100e18);
        assertEq(address(vault).balance, ED + 1_000e9, "the cushion idle");
    }

    function test_processPayouts_retriesAfterPrecompileRevert() public {
        staking.setUnstakeBlocked(true);
        // the walk skips the refused removal (Task 20) and no other position can pay: UnstakeShort, nothing sent
        vm.expectRevert(UnstakeShort.selector);
        process(K, listK(), 10);

        assertBatch(K, 0, 0, 100e18);
        assertEq(vaultLens.pendingPayouts(), 100e18);
        assertEq(stakeOf(HK1), 1_000_000_000_000);
        assertEq(bridge.sendCount(), 0);

        staking.setUnstakeBlocked(false);
        process(K, listK(), 10);
        assertEq(vaultLens.pendingPayouts(), 0);
        assertEq(bridge.sendCount(), 1);
        // 100e18 and the 1_000-rao tolerance (Task 19)
        assertEq(stakeOf(HK1), 899_999_999_000);
    }

    function test_processPayouts_unstakeShortReverts() public {
        // the partial removeStake returns without crediting anything
        vm.mockCall(ISTAKING_ADDRESS, abi.encodeWithSelector(IStaking.removeStake.selector), "");

        // want 100_000_001_000 rao (net + fee = 100e18 and the 1_000-rao tolerance, Task 19) arrives as 0: all
        // 100e18 + 1_000 rao is unmet
        vm.expectRevert(UnstakeShort.selector);
        process(K, listK(), 10);

        assertBatch(K, 0, 0, 100e18);
        assertEq(vaultLens.pendingPayouts(), 100e18);
        assertEq(stakeOf(HK1), 1_000_000_000_000);
        assertEq(address(vault).balance, ED);
        assertEq(bridge.sendCount(), 0);

        vm.clearMockedCalls();
        process(K, listK(), 10);
        assertEq(bridge.lastValue(), 100e18);
        assertDeleted(K);
    }

    /// A 50,000-rao removal fee is the chunk's entry's, the unstake margin or none (Task 36b): the walk counts the stake
    /// it takes, at face value, so the margin no longer moves the fee (before, without it the chunk refused
    /// UnstakeShort, and with it the holders bore the fee). Without the margin alice's entry bears the 50,000 rao and
    /// the cushion stays idle whole; with it she still bears them, and the margin's 50,000 rao of stake sit idle at
    /// full value beside the cushion. Either way the holders' price does not move.
    function test_processPayouts_unstakeMarginMovesNoRemoveFee() public {
        // the chain keeps 50_000 rao of every removal
        staking.setRemoveFeeRao(50_000);
        uint256 price = vaultLens.price();
        uint256 snap = vm.snapshotState();
        uint256 net = 99_999e15 - 50_000e9;

        // available 0: want 100_000_001_000 (net + fee = 100e18 and the 1_000-rao tolerance, Task 19) is taken and
        // arrives as 99_999_951_000 rao; alice bears the 50_000
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 100_000_001_000, 0)));
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 100_000_001_000, 99_999_951_000e9);
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(K, 0, 1, 100e18, net, 1e15, 1e15, 50_000e9);
        process(K, listK(), 10);
        assertEq(bridge.lastValue(), net + 1e15);
        assertEq(bridge.lastAmount(), net);
        assertEq(bridge.lastMessage(), CascadeMessages.encodePayouts(K, 0, entries1(alice, net)));
        assertDeleted(K);
        assertEq(stakeOf(HK1), 1_000_000_000_000 - 100_000_001_000);
        assertEq(address(vault).balance, ED + 1_000e9, "the cushion idle whole");
        assertEq(vaultLens.price(), price, "the holders' price unmoved");

        // the same chunk with the margin: want = 100_000_001_000 + 50_000, and alice still bears the 50_000
        vm.revertToState(snap);
        vm.prank(owner);
        vault.setUnstakeMarginRao(50_000);
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 100_000_051_000, 0)));
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 100_000_051_000, 100e18 + 1_000e9);
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(K, 0, 1, 100e18, net, 1e15, 1e15, 50_000e9);
        process(K, listK(), 10);
        assertEq(bridge.lastValue(), net + 1e15);
        assertEq(bridge.lastAmount(), net);
        assertDeleted(K);
        assertEq(vaultLens.pendingPayouts(), 0);
        // 1_000_000_000_000 - 100_000_051_000
        assertEq(stakeOf(HK1), 899_999_949_000);
        assertEq(address(vault).balance, ED + 51_000e9, "the cushion and the margin idle, at full value");
        assertEq(vaultLens.price(), price, "the holders' price unmoved");
    }

    function test_processPayouts_twoBatchesFullyStakedBThenA() public {
        (bytes32 a, bytes32 b) = queueTwoFullyStaked();
        uint256 sends = bridge.sendCount();

        // B: available = (ED - ED) - (70e18 - 40e18) floors to 0; unstake 40e18 and the 1_000-rao tolerance (Task 19)
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 40_000_001_000, 40_000_001_000e9);
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(b, 0, 1, 40e18, 39_999e15, 1e15, 1e15, 0);
        process(b, pay1(bob, 4e25, 40e18), 10);
        assertEq(vaultLens.pendingPayouts(), 30e18);

        // A: available = (ED + 1_000 rao - ED) - (30e18 - 30e18), B's idle cushion; unstake 30e18 - 1_000 rao and
        // the tolerance, 30e18
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 30_000_000_000, 30e18);
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(a, 0, 1, 30e18, 29_999e15, 1e15, 1e15, 0);
        process(a, pay1(alice, 3e25, 30e18), 10);

        assertEq(vaultLens.pendingPayouts(), 0);
        assertEq(bridge.sendCount(), sends + 2);
        assertDeleted(a);
        assertDeleted(b);
        assertEq(stakeOf(HK1), 929_999_999_000);
        assertEq(address(vault).balance, ED + 1_000e9, "one cushion idle");
    }

    function test_processPayouts_twoBatchesFullyStakedAThenB() public {
        (bytes32 a, bytes32 b) = queueTwoFullyStaked();
        uint256 sends = bridge.sendCount();

        // A: available = (ED - ED) - (70e18 - 30e18) floors to 0; unstake 30e18 and the 1_000-rao tolerance (Task 19)
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 30_000_001_000, 30_000_001_000e9);
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(a, 0, 1, 30e18, 29_999e15, 1e15, 1e15, 0);
        process(a, pay1(alice, 3e25, 30e18), 10);
        assertEq(vaultLens.pendingPayouts(), 40e18);

        // B: available = (ED + 1_000 rao - ED) - (40e18 - 40e18), A's idle cushion; unstake 40e18 - 1_000 rao and
        // the tolerance, 40e18
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 40_000_000_000, 40e18);
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(b, 0, 1, 40e18, 39_999e15, 1e15, 1e15, 0);
        process(b, pay1(bob, 4e25, 40e18), 10);

        assertEq(vaultLens.pendingPayouts(), 0);
        assertEq(bridge.sendCount(), sends + 2);
        assertDeleted(a);
        assertDeleted(b);
        assertEq(stakeOf(HK1), 929_999_999_000);
        assertEq(address(vault).balance, ED + 1_000e9, "one cushion idle");
    }

    // ---- processPayouts: stop powers ----

    function test_processPayouts_frontDoorInactiveHoldsThenCancel() public {
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, frontDoor);

        vm.expectRevert(FrontDoorInactive.selector);
        process(K, listK(), 10);
        assertBatch(K, 0, 0, 100e18);

        vm.expectEmit(address(vault));
        emit RedeemReversed(K, alice, 1e26, 100e18);
        vm.expectEmit(address(vault));
        emit PayoutBatchCancelled(K, 100e18, 0);
        cancel(K, listK());

        assertEq(vault.balanceOf(alice), 1e27);
        assertEq(vault.totalSupply(), 1e27);
        assertEq(vaultLens.pendingPayouts(), 0);
        assertDeleted(K);
        assertEq(bridge.sendCount(), 0);
        vm.expectRevert(NotPending.selector);
        process(K, listK(), 10);
    }

    /// A disabled primary holds the batch; the switch to a bridge activated from OPEN (spec §3.6 row 3: a new
    /// bridge's activation is Ordinary, refused while the primary is held, so it comes first) releases it.
    function test_processPayouts_primaryBridgeDisabledHoldsBatch() public {
        StubBridge bridge2 = new StubBridge(IERC20(address(0)));
        bridge2.setFee(1e15);
        Schedule.run(vault, owner, abi.encodeCall(vault.activateBridge, (address(bridge2))));
        vm.prank(guardian);
        vault.disableBridge(address(bridge));

        vm.expectRevert(PrimaryBridgeDisabled.selector);
        process(K, listK(), 10);
        assertBatch(K, 0, 0, 100e18);
        assertEq(vaultLens.pendingPayouts(), 100e18);
        assertEq(stakeOf(HK1), 1_000_000_000_000);
        assertEq(address(vault).balance, ED);

        vm.prank(owner);
        vault.setPrimaryBridge(address(bridge2));

        process(K, listK(), 10);
        assertEq(bridge2.sendCount(), 1);
        assertEq(bridge2.lastValue(), 100e18);
        assertEq(bridge2.lastAmount(), 99_999e15);
        assertEq(bridge.sendCount(), 0);
        assertDeleted(K);
    }

    // ---- the fee valve (Task 21, spec §3.3) ----

    /// setFeeLimits: maxFeeBps at most MAX_FEE_BPS (5%), maxFeeAbs in [MIN_FEE_ABS, MAX_FEE_ABS] = [0.01, 0.015] TAO,
    /// MAX_FEE_ABS being MIN_REDEEM_VALUE / 2. Below the floor (a tightening, applied at once) and above the top (a
    /// loosening, scheduled) the setter refuses, and the constructor with it; each bound itself is accepted.
    function test_feeLimitBounds() public {
        CascadeVault.Params memory p = vaultParams();
        p.maxFeeAbs = 0.01e18 - 1;
        vm.expectRevert(InvalidParameter.selector);
        new CascadeVault(p);
        p = vaultParams();
        p.maxFeeAbs = 0.015e18 + 1;
        vm.expectRevert(InvalidParameter.selector);
        new CascadeVault(p);

        vm.startPrank(owner);
        vm.expectRevert(InvalidParameter.selector);
        vault.setFeeLimits(100, 0.01e18 - 1);
        vm.expectRevert(InvalidParameter.selector);
        vault.setFeeLimits(0, 0);
        vault.setFeeLimits(0, 0.01e18);
        assertEq(vaultLens.maxFeeAbs(), 0.01e18, "the floor");
        vm.stopPrank();

        bytes[2] memory over = [
            abi.encodeCall(CascadeVault.setFeeLimits, (100, 0.015e18 + 1)),
            abi.encodeCall(CascadeVault.setFeeLimits, (501, 0.015e18))
        ];
        for (uint256 i; i < over.length; ++i) {
            vm.prank(owner);
            vault.schedule(over[i]);
        }
        Schedule.wait(48 hours);
        for (uint256 i; i < over.length; ++i) {
            vm.prank(owner);
            vm.expectRevert(InvalidParameter.selector);
            vault.execute(over[i]);
        }
        Schedule.run(vault, owner, abi.encodeCall(CascadeVault.setFeeLimits, (500, 0.015e18)));
        assertEq(vaultLens.maxFeeBps(), 500, "the top of the bps");
        assertEq(vaultLens.maxFeeAbs(), 0.015e18, "the top: MIN_REDEEM_VALUE / 2");
    }

    /// MIN_REDEEM_VALUE is 0.03 TAO: at A = 900e18, S = 9e26 a share is worth exactly 1e-6 TAO, so 2.9e22 shares
    /// (0.029 TAO) are deferred, nothing burned or queued, and 3e22 shares (0.03 TAO) are burned and queued.
    function test_redeemOf0029Defers0030Burns() public {
        uint256 shares = vault.balanceOf(alice);
        bytes memory message = CascadeMessages.encodeBatch(nextBatchId + 1, noEntries(), entries1(alice, 2.9e22));
        vm.expectEmit(address(vault));
        emit RedeemDeferred(vaultLens.batchKey(BASE, frontDoor, message), alice, 2.9e22);
        bytes32 deferred = redeemVia(alice, 2.9e22);
        assertEq(vault.balanceOf(alice), shares, "nothing burned");
        assertEq(vaultLens.getPayoutBatch(deferred).count, 0, "nothing queued");
        assertEq(vaultLens.pendingPayouts(), 100e18);

        message = CascadeMessages.encodeBatch(nextBatchId + 1, noEntries(), entries1(alice, 3e22));
        vm.expectEmit(address(vault));
        emit Redeemed(vaultLens.batchKey(BASE, frontDoor, message), alice, 3e22, 3e16);
        bytes32 burned = redeemVia(alice, 3e22);
        assertEq(vault.balanceOf(alice), shares - 3e22, "burned");
        assertEq(vaultLens.getPayoutBatch(burned).remaining, 3e16, "queued");
        assertEq(vaultLens.pendingPayouts(), 100e18 + 3e16);
    }

    /// I-14 for a bounce: a 0.03 TAO bounced deposit (the least minDeposit the front door's bound allows) is never
    /// dust, at any setting. The ceiling cannot be raised past 0.015 TAO, so its share of any quote is at most half of
    /// it: a quote of its whole value is charged only up to the ceiling, the rest is the caller's to top up
    /// (FeeTooHigh without it), and the bounce nets 0.015 TAO.
    function test_bounceAt003UnderA0015FeeIsNeverDust() public {
        process(K, listK(), 10);
        bytes32 k = bounceVia(bob, 3e16);
        bytes memory up = abi.encodeCall(CascadeVault.setFeeLimits, (100, 3e16));
        vm.prank(owner);
        vault.schedule(up);
        Schedule.wait(48 hours);
        vm.prank(owner);
        vm.expectRevert(InvalidParameter.selector);
        vault.execute(up);

        // ceiling = max(3e16 * 100 / 10_000, 0.015e18) = 0.015e18; the quote is the bounce's whole value
        bridge.setFee(3e16);
        vm.expectRevert(FeeTooHigh.selector);
        process(k, pay1(bob, 0, 3e16), 10);

        vm.deal(carol, 15e15);
        vm.recordLogs();
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(k, 0, 1, 3e16, 15e15, 3e16, 15e15, 0);
        processPayoutsFrom(carol, 15e15, k, pay1(bob, 0, 3e16), 10);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != PayoutDust.selector, "no dust");
        }
        assertEq(bridge.lastMessage(), CascadeMessages.encodePayouts(k, 0, entries1(bob, 15e15)));
        assertEq(bridge.lastValue(), 15e15 + 3e16);
        assertEq(carol.balance, 0, "the top-up spent");
        assertDeleted(k);
    }

    /// The fee valve on a lonely smallest chunk (alice's 0.03 TAO) under a 0.02 TAO quote: the ceiling is max(1% of
    /// 0.03, 0.015) = 0.015 TAO. With no value, or a value short of the 0.005 TAO above the ceiling, it reverts
    /// FeeTooHigh (a value that is not whole rao, BadValue, first). With the top-up it is sent: the entry is charged
    /// the ceiling, the bridge gets net + the whole quote, and the caller is refunded the rest of its value, last.
    function test_lonelyChunkWithA002Fee() public {
        (bytes32 k, CascadeMessages.Payout[] memory list) = queueLonely();
        bridge.setFee(2e16);
        vm.deal(carol, 1e16);

        vm.expectRevert(FeeTooHigh.selector);
        processPayoutsFrom(carol, 0, k, list, 0);
        vm.expectRevert(FeeTooHigh.selector);
        processPayoutsFrom(carol, 5e15 - 1e9, k, list, 0);
        vm.expectRevert(BadValue.selector);
        processPayoutsFrom(carol, 1, k, list, 0);
        assertBatch(k, 0, 0, 3e16);

        // free = (ED - ED) - (100.03e18 - 0.03e18) floors to 0: the walk asks net + charged = 3e16 and T,
        // 30_001_000 rao; the send is net 1.5e16 + the 2e16 quote; carol gets 1e16 - 5e15 back
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 30_001_000, 0)));
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(k, 0, 1, 3e16, 15e15, 2e16, 15e15, 0);
        processPayoutsFrom(carol, 1e16, k, list, 0);
        assertEq(bridge.lastAmount(), 15e15, "the entry charged the ceiling");
        assertEq(bridge.lastValue(), 15e15 + 2e16, "the quote paid in full");
        assertEq(bridge.lastMessage(), CascadeMessages.encodePayouts(k, 0, entries1(alice, 15e15)));
        assertEq(carol.balance, 5e15, "the caller refunded the rest");
        assertEq(address(vault).balance, ED + 1_000e9, "the cushion idle; nothing of the caller's kept");
        assertEq(vaultLens.pendingPayouts(), 100e18, "K still reserved");
        assertDeleted(k);
    }

    /// The caller's value must be whole rao (the chain floors value transfers to rao), even when no top-up is due:
    /// BadValue. A whole-rao overpayment comes back in full.
    function test_nonRaoValueReverts() public {
        vm.deal(carol, 1e18);
        vm.expectRevert(BadValue.selector);
        processPayoutsFrom(carol, 1, K, listK(), 10);
        vm.expectRevert(BadValue.selector);
        processPayoutsFrom(carol, 1e9 + 1, K, listK(), 10);
        assertBatch(K, 0, 0, 100e18);

        // her 1e18 covers the whole 1e15 fee: she pays it (the full top-up, R4), the entry is sent its gross, the rest
        // comes back
        processPayoutsFrom(carol, 1e18, K, listK(), 10);
        assertEq(carol.balance, 1e18 - 1e15, "the fee from her value, the rest refunded");
        assertEq(bridge.lastValue(), 100e18 + 1e15, "the entry's gross and the fee");
        assertDeleted(K);
    }

    /// The refund is the call's last step, under the vault's lock: a caller that re-enters processPayouts when it is
    /// refunded is refused (ReentrancyGuardReentrantCall). Bubbled, that fails the refund and the whole call reverts
    /// (TransferFailed: nothing sent, the batch as it was); kept, the chunk is sent once and the rest refunded.
    function test_reentrantCallerRefusedAtTheRefund() public {
        (bytes32 k, CascadeMessages.Payout[] memory list) = queueLonely();
        bridge.setFee(2e16);
        ReentrantRecipient r = new ReentrantRecipient();
        bytes memory call = abi.encodeCall(CascadeVault.processPayouts, (k, list, 0));

        r.setMode(ReentrantRecipient.Mode.ReenterOnReceive, address(vault), call, true);
        vm.expectRevert(TransferFailed.selector);
        r.forward{value: 1e16}(address(vault), call);
        assertEq(bridge.sendCount(), 0, "nothing sent");
        assertBatch(k, 0, 0, 3e16);
        assertEq(vaultLens.pendingPayouts(), 100e18 + 3e16);

        r.setMode(ReentrantRecipient.Mode.ReenterOnReceive, address(vault), call, false);
        r.forward{value: 1e16}(address(vault), call);
        assertFalse(r.reentryOk(), "the re-entry refused");
        assertEq(r.reentryReturn(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        assertEq(r.received(), 1, "one refund");
        assertEq(address(r).balance, 5e15, "the rest refunded");
        assertEq(bridge.sendCount(), 1, "sent once");
        assertDeleted(k);
    }

    /// I-12: the caller's value is never cover. K's 100e18 is staked and batch B's 50e18 reservation is liquid; carol
    /// sends 30e18 with K's chunk: it covers the whole fee, which she pays (the full top-up, R4), and the rest is an
    /// overpayment. The liquidity is read from the balance less her value
    /// (own = balance - msg.value): free = (ED + 50e18 - ED) - (150e18 - 100e18) = 0, so the walk asks all of
    /// net + fee and T. Counted as cover, her value would have cut the walk to 70e18 and paid her refund out of B's
    /// reservation. After it, balance - ED >= min(before - ED, the others' reservations) = 50e18, and B is paid from
    /// its own liquid TAO.
    function test_callersValueNeverCover() public {
        // bob's 50e18 left liquid: 5e25 shares at A = 900e18, S = 9e26; then his 5e25 at A = 950e18, S = 9.5e26 is
        // 50e18, queued in B
        depositVia(bob, 50e18);
        bytes32 b = redeemVia(bob, 5e25);
        assertEq(vaultLens.pendingPayouts(), 150e18);
        uint256 before = address(vault).balance;
        assertEq(before, ED + 50e18);

        vm.deal(carol, 30e18);
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 100_000_001_000, 0)));
        processPayoutsFrom(carol, 30e18, K, listK(), 10);
        assertEq(carol.balance, 30e18 - 1e15, "the fee from her value, the rest refunded");
        assertEq(bridge.lastValue(), 100e18 + 1e15, "K sent whole, with the fee");
        assertGe(address(vault).balance - ED, before - ED, "B's reservation untouched (I-12)");
        assertEq(address(vault).balance, ED + 50e18 + 1_000e9, "and the cushion idle");

        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.recordLogs();
        process(b, pay1(bob, 5e25, 50e18), 10);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != Unstaked.selector, "B paid from its own liquid TAO");
        }
        assertEq(bridge.lastValue(), 50e18);
        assertEq(vaultLens.pendingPayouts(), 0);
    }

    /// Round 8 H-1 (spec §3.3, I-13): two batches queued at zero idle balance, their reservations staked (idleBufferBps
    /// 0, the normal case), are both sent whole. Each chunk is funded by the liquidity read once before its walk (less
    /// the caller's value: the keeper sends B with a spare TAO, refunded) plus its own receipts, so the other batch's
    /// reservation, still staked, never blocks it; the cushion the first walk leaves idle is the second's liquidity.
    function test_twoQueuedBatchesAtZeroIdleBalance() public {
        twoQueuedAtZeroIdle(0);
    }

    /// The same under the mock's 1-rao removal fee: every receipt is a rao short of the stake its walk took, which is
    /// the chunk's entry's cost (Task 36b), so each chunk is sent less a rao, each walk's cushion stays idle whole (the
    /// first is the second's liquidity), and ED_RESERVE is untouched.
    function test_twoQueuedBatchesAtZeroIdleBalanceUnderOneRaoFee() public {
        twoQueuedAtZeroIdle(1);
    }

    function twoQueuedAtZeroIdle(uint256 feeRao) internal {
        (bytes32 a, bytes32 b) = queueTwoFullyStaked();
        staking.setRemoveFeeRao(feeRao);
        uint256 sends = bridge.sendCount();
        vm.deal(keeper, 1e18);

        // B: free = 0 (the keeper's 1e18 is not cover); the walk asks 40e18 + T and receives feeRao less, bob's cost.
        // The keeper's 1e18 covers the whole fee, which it pays (the full top-up, R4): bob is charged no fee
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 40_000_001_000, 0)));
        processPayoutsFrom(keeper, 1e18, b, pay1(bob, 4e25, 40e18), 10);
        assertEq(bridge.lastValue(), 40e18 - feeRao * RAO + 1e15, "B sent less its walk's cost, with the fee");
        assertEq(keeper.balance, 1e18 - 1e15, "the keeper's value back, less the fee");
        assertEq(address(vault).balance, ED + 1_000 * RAO, "B's cushion idle whole");

        // A: free = B's cushion, 1_000 rao; the walk asks 30e18 less it, plus T, and receives feeRao less, alice's cost
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 30_000_000_000, 0)));
        process(a, pay1(alice, 3e25, 30e18), 10);
        assertEq(bridge.lastValue(), 30e18 - feeRao * RAO, "A sent less its walk's cost");

        assertEq(bridge.sendCount(), sends + 2);
        assertDeleted(a);
        assertDeleted(b);
        assertEq(vaultLens.pendingPayouts(), 0);
        assertEq(address(vault).balance, ED + 1_000 * RAO, "ED_RESERVE untouched, one cushion idle whole");
    }

    /// A removal fee in [0, 0.02 TAO] is the chunk's entry's (Task 36b, the founder's ruling of 2026-11-06): the walk
    /// takes the stake it asks, 100e18 + T, whatever the fee, so it never refuses UnstakeShort while the stake is there;
    /// the entry bears the fee with its share of the bridge fee (net = 100e18 - 1e15 - the fee), the bridge receives
    /// net + fee, PayoutChunkSent logs the cost, the cushion stays idle whole and the holders' price does not move. The
    /// caller's value never covers the walk: below the bridge fee it is refunded in full; covering it, it pays the
    /// whole fee (the full top-up, R4: the entry is charged none, net = 100e18 - the removal fee) and the rest comes
    /// back. (A cost that would zero an entry is refused FeeTooHigh:
    /// LeaverPays.t.sol's threshold pins.)
    function testFuzz_aRemovalFeeIsTheEntrys(uint256 feeRao, uint256 valueRao) public {
        feeRao = bound(feeRao, 0, 20_000_000);
        valueRao = bound(valueRao, 0, 200e9);
        uint256 value = valueRao * RAO;
        staking.setRemoveFeeRao(feeRao);
        vm.deal(carol, value);
        uint256 price = vaultLens.price();

        // the walk asks 100e18 + T and receives feeRao less
        bool full = value >= 1e15;
        uint256 charged = full ? 0 : 1e15;
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 100_000_001_000, 0)));
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(K, 0, 1, 100e18, 100e18 - charged - feeRao * RAO, 1e15, charged, feeRao * RAO);
        processPayoutsFrom(carol, value, K, listK(), 10);
        assertEq(bridge.lastValue(), 100e18 - feeRao * RAO + (full ? 1e15 : 0), "sent less its walk's cost");
        assertEq(bridge.lastAmount(), 100e18 - charged - feeRao * RAO);
        assertEq(carol.balance, full ? value - 1e15 : value, "the fee from her value when it covers it, the rest back");
        assertEq(address(vault).balance, ED + 1_000 * RAO, "the cushion idle whole");
        assertGe(vaultLens.price(), price, "the holders' price unmoved");
        assertDeleted(K);
    }

    // ---- cancelPayoutBatch ----

    function test_cancelPayoutBatch_afterPartialChunk() public {
        (bytes32 key, CascadeMessages.Payout[] memory list) = queueThree();
        messageLimits(150e18, 150e18, 1);
        process(key, list, 10);
        assertBatch(key, 2, 1, 60e18);

        vm.recordLogs();
        vm.expectEmit(address(vault));
        emit RedeemReversed(key, carol, 6e25, 60e18);
        vm.expectEmit(address(vault));
        emit PayoutBatchCancelled(key, 60e18, 0);
        cancel(key, list);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 reversed;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == RedeemReversed.selector) {
                ++reversed;
            }
        }
        assertEq(reversed, 1);

        // carol: 1e26 - 6e25 + 6e25; alice 9e26 - 6e25 and bob 1e26 - 6e25 were paid
        assertEq(vault.balanceOf(carol), 1e26);
        assertEq(vault.balanceOf(alice), 84e25);
        assertEq(vault.balanceOf(bob), 4e25);
        assertEq(vaultLens.pendingPayouts(), 0);
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
        assertEq(vaultLens.pendingPayouts(), 0);
        assertDeleted(K);
    }

    function test_cancelPayoutBatch_wrongListReverts() public {
        vm.startPrank(owner);
        vm.expectRevert(PayoutsMismatch.selector);
        vault.cancelPayoutBatch(K, pay1(alice, 1e26 + 1, 100e18));
        vm.expectRevert(PayoutsMismatch.selector);
        vault.cancelPayoutBatch(K, pay2(alice, 1e26, 100e18, alice, 1e26, 100e18));
        vm.expectRevert(NotPending.selector);
        vault.cancelPayoutBatch(keccak256("unknown"), listK());
        vm.stopPrank();

        assertEq(vault.balanceOf(alice), 9e26);
        assertBatch(K, 0, 0, 100e18);
    }

    function test_cancelPayoutBatch_twiceRevertsNotPending() public {
        cancel(K, listK());
        assertEq(vault.balanceOf(alice), 1e27);

        vm.prank(owner);
        vm.expectRevert(NotPending.selector);
        vault.cancelPayoutBatch(K, listK());
        assertEq(vault.balanceOf(alice), 1e27);
        assertEq(vault.totalSupply(), 1e27);
        assertEq(vaultLens.pendingPayouts(), 0);
    }

    function test_cancelPayoutBatch_afterFullPayoutRevertsNotPending() public {
        process(K, listK(), 10);
        assertEq(vault.balanceOf(alice), 9e26);

        vm.prank(owner);
        vm.expectRevert(NotPending.selector);
        vault.cancelPayoutBatch(K, listK());
        assertEq(vault.balanceOf(alice), 9e26);
        assertEq(vault.totalSupply(), 9e26);
        assertEq(vaultLens.pendingPayouts(), 0);
    }

    /// The rise case (Task 34c): 1 TAO of rewards vests while K waits, so the price rises from K's batch price, and
    /// the cancel re-mints alice the value she was owed, 100 TAO at the price before the cancel, in fewer shares than
    /// she burned. The price does not fall: the delay's rewards stay with the holders who stayed.
    function test_cancelPayoutBatch_priceStaysAtOrAboveDeliveryPrice() public {
        // K's batch price: (1_000e18 + 1) * 1e18 / (1e27 + 1e6) = 1e12; queueing it left the price there
        uint256 p0 = 1e12;
        assertEq(vaultLens.price(), p0);

        // 1 TAO of rewards, fully vested after 7 days
        vestRewards(1_000_000_000);
        // A = 1_001e18 - 100e18 pending = 901e18, S = 9e26: (901e18 + 1) * 1e18 / (9e26 + 1e6)
        uint256 p1 = vaultLens.price();
        assertEq(p1, 1_001_111_111_111);

        // 100e18 * (9e26 + 1e6) / (901e18 + 1), below the 1e26 burned
        uint256 reMint = 99_889_012_208_657_047_724_750_400;
        assertEq(reMint, CascadeMath.sharesForDeposit(100e18, 901e18, 9e26));
        vm.expectEmit(address(vault));
        emit RedeemReversed(K, alice, reMint, 100e18);
        vm.expectEmit(address(vault));
        emit PayoutBatchCancelled(K, 100e18, 0);
        cancel(K, listK());
        assertEq(vault.balanceOf(alice), 9e26 + reMint);
        assertEq(vault.totalSupply(), 9e26 + reMint);
        assertEq(vaultLens.pendingPayouts(), 0, "the whole reservation released");
        // gross 1_001e18, nothing pending: the price is where it was, at or above K's
        assertEq(vaultLens.price(), p1);
        assertGe(vaultLens.price(), p0);
        // her re-mint is worth what she was owed, less the stayers' rounding: at most 100 TAO, at least 1 wei less
        uint256 value = CascadeMath.assetsForRedeem(reMint, vaultLens.totalAssets(), vault.totalSupply());
        assertLe(value, 100e18);
        assertGe(value, 100e18 - 1);
    }

    /// The cancel gives no allowance back: the stored window keeps its burn (the payout delay has run, so the lens
    /// serves the window as a fresh one, R2 F4, before the cancel and after alike).
    function test_cancelPayoutBatch_keepsBurnedWindow() public {
        bytes32 peer = vaultLens.peerId(BASE, frontDoor);
        (uint64 start, uint256 burned) = storedBurnWindow(peer);
        assertEq(start, tK);
        assertEq(burned, 100e18);
        (start, burned) = vaultLens.burnWindows(peer);
        assertEq(start, tK + 24 hours);
        assertEq(burned, 0);

        cancel(K, listK());

        (start, burned) = storedBurnWindow(peer);
        assertEq(start, tK);
        assertEq(burned, 100e18);
        (start, burned) = vaultLens.burnWindows(peer);
        assertEq(start, tK + 24 hours);
        assertEq(burned, 0);
    }

    // ---- cancelPayoutBatch: the bounces carried forward (Task 22, spec §3.5, §3.10.5, §3.10.15) ----

    /// bob's 2 TAO deposit bounces ahead of alice's 5 TAO redeem, and the owner cancels the batch: alice's shares are
    /// re-minted (one RedeemReversed, none for the bounce) and the batch is left holding bob's bounce alone, as a
    /// one-entry list of its own (count 1, its hash, 2 TAO reserved, cursor 0); the launch door's cancel stamps the
    /// owner's clock. processPayouts later pays the bounce, from bob's own liquid TAO.
    function test_cancelWithABounceRemintsAndCarries() public {
        process(K, listK(), 10);
        (bytes32 key, CascadeMessages.Payout[] memory list) = queueBouncesThenRedeem(entries1(bob, 2e18), 5e24);
        assertEq(vault.balanceOf(alice), 895e24);
        assertEq(vaultLens.pendingPayouts(), 7e18);
        vm.warp(vm.getBlockTimestamp() + 24 hours);

        vm.recordLogs();
        vm.expectEmit(address(vault));
        emit RedeemReversed(key, alice, 5e24, 5e18);
        vm.expectEmit(address(vault));
        emit PayoutBatchCancelled(key, 5e18, 1);
        cancel(key, list);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 reversed;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == RedeemReversed.selector) ++reversed;
        }
        assertEq(reversed, 1, "only alice's entry re-minted");
        assertEq(vaultLens.lastOwnerClose(), vm.getBlockTimestamp(), "the launch door's cancel stamps");

        assertEq(vault.balanceOf(alice), 9e26);
        assertEq(vault.totalSupply(), 9e26);
        assertEq(vault.balanceOf(bob), 0);
        assertEq(vaultLens.pendingPayouts(), 2e18, "bob's bounce still reserved");
        assertEq(vaultLens.getPayoutBatch(key).count, 1, "count");
        assertEq(
            vaultLens.getPayoutBatch(key).payoutsHash, CascadePayoutMath.hashStep(bytes32(0), bob, 0, 2e18), "hash"
        );
        assertBatch(key, 0, 0, 2e18);

        // the old list no longer matches; the carried one is paid: 2e18 less the 1e15 fee
        vm.expectRevert(PayoutsMismatch.selector);
        process(key, list, 10);
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(key, 0, 1, 2e18, 1_999e15, 1e15, 1e15, 0);
        process(key, pay1(bob, 0, 2e18), 10);
        assertEq(bridge.lastMessage(), CascadeMessages.encodePayouts(key, 0, entries1(bob, 1_999e15)));
        assertEq(bridge.lastValue(), 2e18);
        assertEq(address(vault).balance, ED + 1_000e9, "K's walk cushion only: the bounces went back whole");
        assertEq(vaultLens.pendingPayouts(), 0);
        assertDeleted(key);
    }

    /// A batch of bounces only has nothing to re-mint: its cancel reverts NothingToCancel before the launch door's
    /// stamp, so it stamps nothing and leaves the batch queued, to be paid. So does a carried batch's second cancel
    /// (final: the keeper does not retry it, Review Focus 3).
    function test_bouncesOnlyCancelRevertsNothingToCancel() public {
        process(K, listK(), 10);
        bytes32 k = bounceVia(bob, 2e18);
        uint64 clock = vaultLens.lastOwnerClose();
        vm.warp(vm.getBlockTimestamp() + 1 hours);

        vm.prank(owner);
        vm.expectRevert(NothingToCancel.selector);
        vault.cancelPayoutBatch(k, pay1(bob, 0, 2e18));
        assertEq(vaultLens.lastOwnerClose(), clock, "a refused cancel stamps nothing");
        assertTrue(vaultLens.exitsOpen());
        assertEq(vaultLens.getPayoutBatch(k).count, 1);
        assertBatch(k, 0, 0, 2e18);
        assertEq(vaultLens.pendingPayouts(), 2e18);

        // a carried batch: its first cancel stamps; the second reverts and stamps nothing
        (bytes32 key, CascadeMessages.Payout[] memory list) = queueBouncesThenRedeem(entries1(carol, 3e18), 5e24);
        cancel(key, list);
        uint64 t = uint64(vm.getBlockTimestamp());
        assertEq(vaultLens.lastOwnerClose(), t);
        vm.warp(t + 1 hours);
        vm.prank(owner);
        vm.expectRevert(NothingToCancel.selector);
        vault.cancelPayoutBatch(key, pay1(carol, 0, 3e18));
        assertEq(vaultLens.lastOwnerClose(), t, "still the first cancel's stamp");
        assertBatch(key, 0, 0, 3e18);
        assertEq(vaultLens.pendingPayouts(), 5e18);
    }

    /// NothingToCancel is decided by the entries' shares, never by their value (spec §3.10.5: a cancel that would
    /// re-mint nothing). A shares entry worth 0 is unreachable (every burn is at least MIN_REDEEM_VALUE), so it is
    /// written into storage here: a bounce-and-redeem batch's hash replaced by one over alice's entry at 0 assets. The
    /// cancel is not refused: it carries bob's bounce, and alice's entry, owed nothing, buys no share (Task 34c), so
    /// it mints nothing (no Transfer, not even of 0) and still logs its RedeemReversed.
    function test_nothingToCancelIsDecidedByShares() public {
        process(K, listK(), 10);
        (bytes32 key, CascadeMessages.Payout[] memory list) = queueBouncesThenRedeem(entries1(bob, 2e18), 5e24);
        list[1].assets = 0;
        bytes32 bounce = CascadePayoutMath.hashStep(bytes32(0), bob, 0, 2e18);
        bytes32 base = keccak256(abi.encode(key, VaultLayout.SLOT_PAYOUT_BATCHES));
        vm.store(
            address(vault),
            bytes32(uint256(base) + VaultLayout.PAYOUT_BATCH_PAYOUTS_HASH_SLOT),
            CascadePayoutMath.hashStep(bounce, alice, 5e24, 0)
        );

        vm.recordLogs();
        vm.expectEmit(address(vault));
        emit RedeemReversed(key, alice, 0, 0);
        vm.expectEmit(address(vault));
        emit PayoutBatchCancelled(key, 0, 1);
        cancel(key, list);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != IERC20.Transfer.selector, "no mint, not even of 0");
        }
        assertEq(vault.balanceOf(alice), 895e24, "nothing re-minted");
        assertEq(vault.totalSupply(), 895e24);
        assertEq(vaultLens.getPayoutBatch(key).count, 1);
        assertEq(vaultLens.getPayoutBatch(key).payoutsHash, bounce, "bob's bounce carried");
    }

    /// Review Focus 3: three bounces ahead of alice's redeem; a first chunk (under a 10.5 TAO message cap) sends only
    /// bob's, so the cursor sits inside the bounces when the owner cancels. The keeper rebuilds the carried list as
    /// spec §3.10.15 says: the batch's DepositBounced and Redeemed logs in log order, then the last `bouncesCarried`
    /// (from PayoutBatchCancelled) of its bounce entries, here carol's and dave's; and paying that list succeeds, as
    /// chunk 1.
    function test_cancelWithTheCursorInsideTheBounces() public {
        process(K, listK(), 10);
        address dave = makeAddr("dave");
        foreign(bob);
        foreign(carol);
        foreign(dave);
        vm.recordLogs();
        bytes32 key = deliver(
            BASE, frontDoor, ++nextBatchId, entries3(bob, 6e18, carol, 6e18, dave, 4e18), entries1(alice, 5e24)
        );
        CascadeMessages.Payout[] memory list = rebuild(vm.getRecordedLogs(), key);
        assertEq(list.length, 4);
        assertEq(abi.encode(list[3]), abi.encode(CascadeMessages.Payout(alice, 5e24, 5e18)), "the redeem, last");
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        // a tightening, at once: bob 6 + carol 6 > 10.5, and the 21 TAO tail is not folded in
        vm.prank(owner);
        vault.setMessageLimits(10e18, 10.5e18, 10);
        process(key, list, 10);
        assertBatch(key, 1, 1, 15e18);

        vm.recordLogs();
        cancel(key, list);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 found;
        uint256 reminted;
        uint32 carried;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(vault) && logs[i].topics[0] == PayoutBatchCancelled.selector
                    && logs[i].topics[1] == key
            ) {
                (reminted, carried) = abi.decode(logs[i].data, (uint256, uint32));
                ++found;
            }
        }
        assertEq(found, 1);
        assertEq(reminted, 5e18, "alice's entry");
        assertEq(carried, 2, "bouncesCarried");
        CascadeMessages.Payout[] memory tail = lastBounces(list, carried);
        assertEq(abi.encode(tail), abi.encode(pay2(carol, 0, 6e18, dave, 0, 4e18)), "the last two bounces, in order");
        assertEq(vaultLens.getPayoutBatch(key).count, 2);
        assertBatch(key, 0, 1, 10e18);

        // 6e14 and 4e14 of the fee: 5_999.4e15 and 3_999.6e15
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(key, 1, 2, 10e18, 9_999e15, 1e15, 1e15, 0);
        process(key, tail, 10);
        assertEq(
            bridge.lastMessage(), CascadeMessages.encodePayouts(key, 1, entries2(carol, 5_999.4e15, dave, 3_999.6e15))
        );
        assertEq(vault.balanceOf(alice), 9e26);
        assertEq(address(vault).balance, ED + 1_000e9, "K's walk cushion only: the bounces went back whole");
        assertEq(vaultLens.pendingPayouts(), 0);
        assertDeleted(key);
    }

    /// The carried batch keeps the batch's queuedAt and continues its chunk numbering (spec §3.10.5): part-paid (chunk
    /// 0, bob's bounce) and cancelled an hour later, carol's bounce is paid at once as chunk 1, its delay counted from
    /// the delivery, not the cancel; and a batch cancelled inside its delay waits out the rest of it, no longer.
    function test_carriedBatchKeepsQueuedAtAndChunkNumbering() public {
        process(K, listK(), 10);
        (bytes32 key, CascadeMessages.Payout[] memory list) =
            queueBouncesThenRedeem(entries2(bob, 6e18, carol, 6e18), 5e24);
        uint64 tq = uint64(vm.getBlockTimestamp());
        vm.warp(tq + 24 hours);
        vm.prank(owner);
        vault.setMessageLimits(10e18, 10.5e18, 10);
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(key, 0, 1, 6e18, 5_999e15, 1e15, 1e15, 0);
        process(key, list, 10);

        vm.warp(tq + 25 hours);
        cancel(key, list);
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        assertEq(b.queuedAt, tq, "queuedAt");
        assertEq(b.sourceChain, BASE);
        assertEq(b.frontDoor, frontDoor);
        assertEq(b.batchId, nextBatchId);
        assertEq(b.count, 1);
        assertBatch(key, 0, 1, 6e18);

        vm.expectEmit(address(vault));
        emit PayoutChunkSent(key, 1, 1, 6e18, 5_999e15, 1e15, 1e15, 0);
        process(key, pay1(carol, 0, 6e18), 10);
        assertEq(bridge.lastMessage(), CascadeMessages.encodePayouts(key, 1, entries1(carol, 5_999e15)));
        assertDeleted(key);

        // cancelled an hour into its delay: payable at its own queuedAt + 24 hours
        address dave = makeAddr("dave");
        (bytes32 k2, CascadeMessages.Payout[] memory l2) = queueBouncesThenRedeem(entries1(dave, 4e18), 5e24);
        uint64 t2 = uint64(vm.getBlockTimestamp());
        vm.warp(t2 + 1 hours);
        cancel(k2, l2);
        assertEq(vaultLens.getPayoutBatch(k2).queuedAt, t2);
        l2 = pay1(dave, 0, 4e18);
        vm.warp(t2 + 24 hours - 1);
        vm.expectRevert(PayoutDelayed.selector);
        process(k2, l2, 10);
        vm.warp(t2 + 24 hours);
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(k2, 0, 1, 4e18, 3_999e15, 1e15, 1e15, 0);
        process(k2, l2, 10);
        assertDeleted(k2);
    }

    /// I-19: a cancel releases only the re-minted entries' reservation. Beside K (100 TAO, queued), a batch of bob's
    /// 1 TAO and carol's 3 TAO bounces and alice's 5 TAO redeem reserves 9 TAO; its cancel lowers pendingPayouts by
    /// alice's 5 TAO only, so the holders' assets rise by exactly that and the bounces' 4 TAO is never theirs (the
    /// reservations still match the queue). Paid later, the bounces leave the holders' assets as they were.
    function test_pendingPayoutsFallsByRemintedOnly() public {
        (bytes32 key, CascadeMessages.Payout[] memory list) =
            queueBouncesThenRedeem(entries2(bob, 1e18, carol, 3e18), 5e24);
        assertEq(vaultLens.pendingPayouts(), 109e18);
        uint256 assets = vaultLens.totalAssets();
        uint256 supply = vault.totalSupply();

        cancel(key, list);
        assertEq(vaultLens.pendingPayouts(), 104e18, "falls by the re-minted 5 TAO only");
        assertEq(vaultLens.getPayoutBatch(key).remaining, 4e18, "the bounces' value");
        assertEq(vaultLens.getPayoutBatch(K).remaining, 100e18, "K untouched");
        assertEq(vaultLens.totalAssets(), assets + 5e18, "the bounces are not released to the holders");
        assertEq(vault.totalSupply(), supply + 5e24);

        // ceil(1e18 * 1e15 / 4e18) = 2.5e14 and 7.5e14 of the fee: the vault sends exactly the 4 TAO it releases
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(key, 0, 2, 4e18, 3_999e15, 1e15, 1e15, 0);
        process(key, pay2(bob, 0, 1e18, carol, 0, 3e18), 10);
        assertEq(vaultLens.pendingPayouts(), 100e18);
        assertEq(vaultLens.totalAssets(), assets + 5e18);
        assertDeleted(key);
    }

    // ---- cancelPayoutBatch: the re-mint (Task 34c, spec §3.5) ----
    // Each remaining entry with shares gets min(S_i, sharesForDeposit(A_i, assetsBefore, supplyBefore)): the shares
    // the value it was owed buys at the price before the cancel (one totalAssets() and one supply for the whole cancel,
    // read before anything is released), never more than it burned. The rise case is
    // test_cancelPayoutBatch_priceStaysAtOrAboveDeliveryPrice above.

    /// The fall case: bob's 100 TAO, left liquid, then 50 TAO of it lost, so the price falls below K's batch price.
    /// The value alice was owed buys more shares than she burned, and the min re-mints exactly her 1e26: the loss
    /// stays with her (her shares are worth less than the 100 TAO she was owed), and the price rises.
    function test_cancelAfterALossRemintsTheBurnedShares() public {
        // A = 900e18, S = 9e26: 100e18 → 1e26 shares, liquid
        depositVia(bob, 100e18);
        vm.deal(address(vault), address(vault).balance - 50e18);
        // A = 950e18, S = 1e27: (950e18 + 1) * 1e18 / (1e27 + 1e6)
        assertEq(vaultLens.totalAssets(), 950e18);
        uint256 before = vaultLens.price();
        assertEq(before, 950_000_000_000);
        assertGt(CascadeMath.sharesForDeposit(100e18, 950e18, 1e27), 1e26, "the value owed buys more than she burned");

        vm.expectEmit(address(vault));
        emit RedeemReversed(K, alice, 1e26, 100e18);
        vm.expectEmit(address(vault));
        emit PayoutBatchCancelled(K, 100e18, 0);
        cancel(K, listK());
        assertEq(vault.balanceOf(alice), 1e27, "exactly her burned shares");
        assertEq(vaultLens.pendingPayouts(), 0);
        // (1_050e18 + 1) * 1e18 / (1.1e27 + 1e6)
        assertEq(vaultLens.price(), 954_545_454_545);
        assertGt(vaultLens.price(), before, "the price rises");
        assertEq(valueOf(1e26), 95_454_545_454_545_454_545, "the fall's loss stays with her");
    }

    /// The unchanged-price case: after 1 TAO of rewards vests, alice burns 3e25 + 123,456,789 shares at A = 901e18,
    /// S = 9e26 for their value floored to whole rao, 30.033333333 TAO, and the owner cancels at once. The re-mint is
    /// what that value buys at the price before the cancel: below what she burned by the delivery's rounding (under one
    /// rao's worth of shares, which the stayers keep), and worth what she was owed less 1 wei.
    function test_cancelAtAnUnchangedPriceRemintsAtMostTheBurnedShares() public {
        vestRewards(1_000_000_000);
        uint256 burned = 3e25 + 123_456_789;
        bytes32 key = redeemVia(alice, burned);
        // burned * (901e18 + 1) / (9e26 + 1e6) = 30_033_333_333.333... rao, floored to whole rao
        CascadeMessages.Payout[] memory list = pay1(alice, burned, 30_033_333_333e9);
        uint256 assetsBefore = vaultLens.totalAssets();
        uint256 supplyBefore = vault.totalSupply();
        uint256 before = vaultLens.price();
        uint256 reMint = CascadeMath.sharesForDeposit(30_033_333_333e9, assetsBefore, supplyBefore);
        assertEq(reMint, 29_999_999_999_655_555_126_058_015);

        vm.expectEmit(address(vault));
        emit RedeemReversed(key, alice, reMint, 30_033_333_333e9);
        cancel(key, list);
        assertLe(reMint, burned, "at most what she burned");
        assertLt(burned - reMint, CascadeMath.sharesForDeposit(1e9, assetsBefore, supplyBefore), "under a rao's worth");
        assertEq(vault.balanceOf(alice), 9e26 - burned + reMint);
        assertEq(valueOf(reMint), 30_033_333_333e9 - 1, "within 1 wei of what she was owed");
        assertGe(vaultLens.price(), before);
    }

    /// Several entries and bounces mixed: dave's 2 TAO and erin's 3 TAO bounce ahead of alice's and bob's redeems,
    /// which burn different shares for the same value (the delivery floors each to whole rao); 1 TAO of rewards vests;
    /// the owner cancels. Both redeems get the same re-mint, what that value buys at the one price read before the
    /// cancel (bob's, minted after alice's, is not priced on the supply hers raised), below what either burned;
    /// pendingPayouts falls by the two values; the bounces are carried exactly as before (in order: their hash, count
    /// and value, the cursor at 0, queuedAt and the chunk kept), and are then paid.
    function test_cancelRemintsSeveralEntriesAtOnePriceAndCarriesTheBounces() public {
        process(K, listK(), 10);
        depositVia(bob, 100e18);
        address dave = makeAddr("dave");
        address erin = makeAddr("erin");
        foreign(dave);
        foreign(erin);
        vm.recordLogs();
        bytes32 key = deliver(
            BASE, frontDoor, ++nextBatchId, entries2(dave, 2e18, erin, 3e18), entries2(alice, 5e24, bob, 5e24 + 1e14)
        );
        uint64 tq = uint64(vm.getBlockTimestamp());
        CascadeMessages.Payout[] memory list = rebuild(vm.getRecordedLogs(), key);
        assertEq(list.length, 4);
        uint256 a = list[2].assets;
        assertEq(abi.encode(list[2].user, list[2].shares), abi.encode(alice, 5e24));
        assertEq(abi.encode(list[3].user, list[3].shares), abi.encode(bob, 5e24 + 1e14));
        assertEq(list[3].assets, a, "the same value for different shares");
        vestRewards(1_000_000_000);

        uint256 assetsBefore = vaultLens.totalAssets();
        uint256 supplyBefore = vault.totalSupply();
        uint256 pendingBefore = vaultLens.pendingPayouts();
        uint256 aliceBefore = vault.balanceOf(alice);
        uint256 bobBefore = vault.balanceOf(bob);
        uint256 before = vaultLens.price();
        uint256 reMint = CascadeMath.sharesForDeposit(a, assetsBefore, supplyBefore);
        assertLt(reMint, 5e24, "after the rise, fewer shares than either burned");

        vm.expectEmit(address(vault));
        emit RedeemReversed(key, alice, reMint, a);
        vm.expectEmit(address(vault));
        emit RedeemReversed(key, bob, reMint, a);
        vm.expectEmit(address(vault));
        emit PayoutBatchCancelled(key, 2 * a, 2);
        cancel(key, list);
        assertEq(vault.balanceOf(alice), aliceBefore + reMint);
        assertEq(vault.balanceOf(bob), bobBefore + reMint, "the same shares for the same value");
        assertEq(vaultLens.pendingPayouts(), pendingBefore - 2 * a, "falls by the sum of the values");
        assertEq(vaultLens.pendingPayouts(), 5e18, "the bounces still reserved");
        assertGe(vaultLens.price(), before);

        // the bounces, carried as before
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        assertEq(b.count, 2, "count");
        assertEq(b.queuedAt, tq, "queuedAt");
        assertEq(
            b.payoutsHash,
            CascadePayoutMath.hashStep(CascadePayoutMath.hashStep(bytes32(0), dave, 0, 2e18), erin, 0, 3e18),
            "hash"
        );
        assertBatch(key, 0, 0, 5e18);
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(key, 0, 2, 5e18, 4_999e15, 1e15, 1e15, 0);
        process(key, pay2(dave, 0, 2e18, erin, 0, 3e18), 10);
        assertDeleted(key);
    }

    /// The rule over the price at the delivery (P0) and the price at the cancel (P1): a reward vested or a loss of
    /// liquid TAO before the batch moves P0, another after it moves P1, over 1 to 4 holders' entries of fuzzed sizes
    /// (clipped by the window, or deferred, as a delivery decides). Per entry the re-mint is
    /// min(S_i, sharesForDeposit(A_i, assetsBefore, supplyBefore)), never above S_i, and worth at most A_i at the
    /// price before the cancel, the one it is priced at. After the cancel the entries together are worth at most what
    /// they were owed, and each at most what its burned shares were worth at the batch's own price, S_i * P0, before
    /// the delivery floored it to whole rao: so under a rao above A_i. One alone can be worth more than A_i when P1
    /// sits inside the batch's rounding: an entry that rounded more is re-minted at P1 while the others, above it, get
    /// their S_i back, and its shares share the value those forfeit (the counterexample below). And unless the vault
    /// is underwater the price does not fall.
    function testFuzz_cancelRemintsAtMostTheValueOwed(
        uint256 n,
        uint256[4] memory deposits,
        uint256[4] memory fractions,
        uint256 move0,
        uint256 move1
    ) public {
        cancelAfterMoves(n, deposits, fractions, move0, move1);
    }

    /// The fuzz test's body: the batch's list and the cancel's RedeemReversed entries, in order.
    function cancelAfterMoves(
        uint256 n,
        uint256[4] memory deposits,
        uint256[4] memory fractions,
        uint256 move0,
        uint256 move1
    ) internal returns (CascadeMessages.Payout[] memory list, CascadeMessages.Payout[] memory back) {
        n = bound(n, 1, 4);
        CascadeMessages.Entry[] memory d = new CascadeMessages.Entry[](n);
        for (uint256 i; i < n; ++i) {
            d[i] = CascadeMessages.Entry(
                makeAddr(string.concat("holder", vm.toString(i))), bound(deposits[i], 1e9, 50e9) * 1e9
            );
        }
        deliver(BASE, frontDoor, ++nextBatchId, d, noEntries());
        for (uint256 i; i < n; ++i) {
            matureShares(d[i].user);
        }
        movePrice(move0);
        CascadeMessages.Entry[] memory r = new CascadeMessages.Entry[](n);
        for (uint256 i; i < n; ++i) {
            r[i] = CascadeMessages.Entry(d[i].user, vault.balanceOf(d[i].user) * bound(fractions[i], 5, 100) / 100);
        }
        // the batch's price inputs: A without this delivery's (no) deposits, and S
        uint256 batchAssets = vaultLens.totalAssets();
        uint256 batchSupply = vault.totalSupply();
        vm.recordLogs();
        bytes32 key = deliver(BASE, frontDoor, ++nextBatchId, noEntries(), r);
        list = rebuild(vm.getRecordedLogs(), key);
        vm.assume(list.length != 0);
        movePrice(move1);

        uint256 assetsBefore = vaultLens.totalAssets();
        uint256 supplyBefore = vault.totalSupply();
        uint256 before = vaultLens.price();
        bool underwater = CascadeFormulas.underwater(
            vaultLens.grossAssets(), vaultLens.pendingPayouts(), vaultLens.unvestedRewards()
        );
        uint256[] memory held = new uint256[](list.length);
        for (uint256 i; i < list.length; ++i) {
            held[i] = vault.balanceOf(list[i].user);
        }
        vm.recordLogs();
        cancel(key, list);
        back = reversals(vm.getRecordedLogs(), key);
        assertEq(back.length, list.length, "one RedeemReversed per entry");
        uint256 owed;
        uint256 reMinted;
        for (uint256 i; i < list.length; ++i) {
            uint256 s = back[i].shares;
            assertEq(back[i].user, list[i].user);
            assertEq(back[i].assets, list[i].assets);
            assertEq(s, reMintOf(list[i].shares, list[i].assets, assetsBefore, supplyBefore), "min(S_i, formula)");
            assertLe(s, list[i].shares, "never more than burned");
            assertEq(vault.balanceOf(list[i].user), held[i] + s);
            assertLe(CascadeMath.assetsForRedeem(s, assetsBefore, supplyBefore), list[i].assets, "worth at most A_i");
            assertLe(
                valueOf(s),
                CascadeMath.assetsForRedeem(list[i].shares, batchAssets, batchSupply),
                "after it, at most S_i * P0"
            );
            owed += list[i].assets;
            reMinted += s;
        }
        assertLe(valueOf(reMinted), owed, "together, at most what they were owed");
        if (!underwater) assertGe(vaultLens.price(), before, "the price does not fall");
    }

    /// The fuzzer's counterexample to a per-entry bound of A_i after the cancel: four entries of one batch, the first
    /// floored 0.66 rao below its shares' value at the delivery price, the others exactly on it; a loss then puts P1
    /// between them. The first's value buys fewer shares than it burned, and it gets those; the others' buy more, and
    /// they get their S_i back, worth less than they were owed; so the price after the cancel is above P1 and the
    /// first's re-mint is worth 17,018,312 wei (0.017 rao) more than it was owed, while all four together are worth
    /// less than the four were owed.
    function test_cancelInsideTheBatchsRoundingSharesTheForfeit() public {
        uint256[4] memory deposits = [uint256(899_999_949_000), 34, 506_375_856, 51_499];
        uint256[4] memory fractions = [uint256(82_719), 6_376, 4, 100];
        (CascadeMessages.Payout[] memory list, CascadeMessages.Payout[] memory back) =
            cancelAfterMoves(11e18, deposits, fractions, 8_058, 40_000_000_001);
        assertEq(list.length, 4);
        assertEq(list[0].assets, 11_339_967_858e9);
        assertEq(list[0].shares, 11_339_967_858_660_000_000_000_000, "floored 0.66 rao below");
        assertLt(back[0].shares, list[0].shares, "the first re-minted at P1");
        uint256 owed = list[0].assets;
        uint256 reMinted = back[0].shares;
        for (uint256 i = 1; i < 4; ++i) {
            assertEq(list[i].assets * 1e6, list[i].shares, "exactly on the delivery price");
            assertEq(back[i].shares, list[i].shares, "the others get their S_i back");
            assertLt(valueOf(back[i].shares), list[i].assets);
            owed += list[i].assets;
            reMinted += back[i].shares;
        }
        assertEq(valueOf(back[0].shares), list[0].assets + 17_018_312, "the first, 0.017 rao above");
        assertLt(valueOf(reMinted), owed, "all four, below");
    }

    /// Moves the price by `seed`: a third of the time nothing, a third 0.001 to 100 TAO of rewards claimed and vested
    /// for 1 hour to the schedule's 7 days, a third a loss of up to all the liquid TAO above ED.
    function movePrice(uint256 seed) internal {
        uint256 kind = seed % 3;
        seed /= 3;
        if (kind == 1) {
            staking.setUnclaimed(vaultLens.coldkey(), HK1, bound(seed % 2 ** 64, 1e6, 100e9));
            vm.prank(keeper);
            vault.claimRewards{gas: 60_000_000}(HK1);
            vm.warp(vm.getBlockTimestamp() + bound(seed >> 64, 1 hours, 7 days));
        } else if (kind == 2) {
            uint256 balance = address(vault).balance;
            vm.deal(address(vault), balance - bound(seed, 0, balance - ED));
        }
    }

    /// Two batches beside an empty vault: 90 TAO of rewards vests (liquid), so alice's second redeem, batch B, burns
    /// 1e26 at 1.1e-6 TAO a share while K waits at 1e-6; a loss then takes the stayers back to the launch price, and
    /// alice redeems the rest directly. The vault then holds exactly its two reservations, at a supply of 0, its
    /// assets reading 0. Returns B's key, its list and the value it owes.
    function emptyBesideTwoBatches()
        internal
        returns (bytes32 keyB, CascadeMessages.Payout[] memory listB, uint256 aB)
    {
        staking.setClaimToBalance(true);
        vestRewards(90e9);
        // A = 1_000e18 staked + 90e18 liquid - K's 100e18 = 990e18, S = 9e26
        assertEq(vaultLens.totalAssets(), 990e18);
        vm.recordLogs();
        keyB = redeemVia(alice, 1e26);
        listB = rebuild(vm.getRecordedLogs(), keyB);
        // 1e26 * (990e18 + 1) / (9e26 + 1e6), floored to whole rao
        aB = 109_999_999_999e9;
        assertEq(abi.encode(listB), abi.encode(pay1(alice, 1e26, aB)));
        // a loss of what the stayers' 8e26 shares hold above the launch price, from the liquid rewards
        vm.deal(address(vault), address(vault).balance - (vaultLens.totalAssets() - 800e18));
        assertEq(vaultLens.price(), 1e12);
        vm.prank(alice);
        vault.redeemDirect(8e26, false);
        assertEq(alice.balance, 800e18);
        assertEq(vault.totalSupply(), 0);
        assertEq(vaultLens.totalAssets(), 0, "exactly the two reservations");
        assertEq(vaultLens.pendingPayouts(), 100e18 + aB);
    }

    /// At a supply of 0 the rule applies unchanged, with no special case, and this pins the pre-existing operator
    /// note's case, a cancel after a new deposit there: beside B and K at an empty vault (emptyBesideTwoBatches),
    /// bob's 50 TAO mints at the launch price. B's cancel is the note's fall half, which remains: B's price is above
    /// bob's, so alice gets her 1e26 shares back and part of B's value moves to bob. K's cancel after it is the rise
    /// half, which is gone: B's cancel raised the price above K's, so alice gets K's 100 TAO back in fewer shares than
    /// she burned, and no one's shares lose value.
    function test_cancelAtASupplyOfZeroAfterANewDeposit() public {
        (bytes32 keyB, CascadeMessages.Payout[] memory listB, uint256 aB) = emptyBesideTwoBatches();

        // bob's deposit mints at the launch price
        depositVia(bob, 50e18);
        assertEq(vault.balanceOf(bob), 5e25);
        assertEq(vaultLens.price(), 1e12);

        // B, the fall half: what B owed buys more than she burned, so she gets the 1e26 back, worth less
        assertGt(CascadeMath.sharesForDeposit(aB, 50e18, 5e25), 1e26);
        vm.expectEmit(address(vault));
        emit RedeemReversed(keyB, alice, 1e26, aB);
        cancel(keyB, listB);
        assertEq(vault.balanceOf(alice), 1e26);
        uint256 aliceValue = valueOf(1e26);
        uint256 bobValue = valueOf(5e25);
        assertLt(aliceValue, aB, "worth less than B owed her");
        assertGt(bobValue, 50e18, "the difference moved to bob");
        assertGe(aliceValue + bobValue, aB + 50e18 - 2, "and nowhere else");

        // K, the rise half: she gets K's value back in fewer shares; no one's shares lose value
        uint256 assetsBefore = vaultLens.totalAssets();
        uint256 supplyBefore = vault.totalSupply();
        uint256 before = vaultLens.price();
        assertGt(before, 1e12, "above K's batch price");
        uint256 reMint = CascadeMath.sharesForDeposit(100e18, assetsBefore, supplyBefore);
        assertLt(reMint, 1e26);
        vm.expectEmit(address(vault));
        emit RedeemReversed(K, alice, reMint, 100e18);
        cancel(K, listK());
        assertEq(vault.balanceOf(alice), 1e26 + reMint);
        assertLe(valueOf(reMint), 100e18);
        assertGe(valueOf(reMint), 100e18 - 1);
        assertGe(vaultLens.price(), before);
        assertGe(valueOf(5e25), bobValue, "bob's value does not fall");
        assertGe(valueOf(1e26), aliceValue, "nor her B shares'");
        assertEq(vaultLens.pendingPayouts(), 0);
    }

    /// A cancel at a supply of 0 with nothing beyond the reservations (assetsBefore 0): beside B and K at an empty
    /// vault (emptyBesideTwoBatches), B is cancelled before any deposit. Its value buys
    /// sharesForDeposit(aB, 0, 0) = aB * 1e6, more than the 1e26 alice burned, so the min re-mints exactly 1e26: she
    /// is the only holder, worth all of B's value less a wei, and the price rises from the launch price to B's. K's
    /// cancel after it is a rise: at B's price K's 100 TAO buys fewer shares than she burned, worth 100 TAO less 1 wei,
    /// and her B shares lose no value.
    function test_cancelAtASupplyOfZeroWithNothingBeyondTheReservations() public {
        (bytes32 keyB, CascadeMessages.Payout[] memory listB, uint256 aB) = emptyBesideTwoBatches();
        assertEq(vaultLens.price(), 1e12, "the launch price, read at a supply of 0");
        assertEq(CascadeMath.sharesForDeposit(aB, 0, 0), aB * 1e6);
        assertGt(aB * 1e6, 1e26, "B's value buys more than she burned");

        vm.expectEmit(address(vault));
        emit RedeemReversed(keyB, alice, 1e26, aB);
        cancel(keyB, listB);
        assertEq(vault.balanceOf(alice), 1e26);
        assertEq(vault.totalSupply(), 1e26);
        assertEq(vaultLens.totalAssets(), aB, "B's value released");
        // (aB + 1) * 1e18 / (1e26 + 1e6)
        assertEq(vaultLens.price(), 1_099_999_999_989);
        uint256 aliceB = valueOf(1e26);
        assertEq(aliceB, aB - 1, "all of B's value, less the virtual shares' wei");

        // K, a rise from 1e-6 to B's price: 100e18 * (1e26 + 1e6) / (aB + 1)
        uint256 reMint = 90_909_090_909_917_355_371_990_984;
        assertEq(reMint, CascadeMath.sharesForDeposit(100e18, aB, 1e26));
        vm.expectEmit(address(vault));
        emit RedeemReversed(K, alice, reMint, 100e18);
        cancel(K, listK());
        assertEq(vault.balanceOf(alice), 1e26 + reMint);
        assertEq(valueOf(reMint), 100e18 - 1);
        assertEq(vaultLens.price(), 1_099_999_999_989);
        assertGe(valueOf(1e26), aliceB, "her B shares lose no value");
        assertEq(vaultLens.pendingPayouts(), 0);
    }

    // ---- reservations seen by the other paths ----

    function test_redeemDirect_leavesPendingPayoutsReserved() public {
        // A = 900e18, S = 9e26: 150e18 → 1.5e26 shares for bob, left liquid (no stakeIdle here):
        // the vault holds ED + 150e18, of which 100e18 is K's reservation
        depositVia(bob, 150e18);

        // A = 1_050e18, S = 1.05e27: 5e25 → 50e18, the unreserved balance exactly; paid without unstaking
        vm.recordLogs();
        vm.prank(bob);
        vault.redeemDirect(5e25, false);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != Unstaked.selector);
        }
        assertEq(bob.balance, 50e18);
        assertEq(vaultLens.pendingPayouts(), 100e18);
        assertEq(address(vault).balance, ED + 100e18);
        assertEq(stakeOf(HK1), 1_000_000_000_000);

        // A = 1_000e18, S = 1e27: 5e25 → 50e18 more; nothing is unreserved, so it is unstaked
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 50_000_000_000, 50e18);
        vm.prank(bob);
        vault.redeemDirect(5e25, false);
        assertEq(bob.balance, 100e18);
        assertEq(vaultLens.pendingPayouts(), 100e18);
        assertEq(address(vault).balance, ED + 100e18);
    }

    function test_stakeIdle_flooredWhenPendingExceedsBalance() public {
        // balance ED, pending 100e18: (ED - ED) - 100e18 floors to 0
        vm.prank(keeper);
        vm.expectRevert(NothingToStake.selector);
        vault.stakeIdle();
        assertEq(stakeOf(HK1), 1_000_000_000_000);
    }
}
