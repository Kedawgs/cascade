// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeVaultLens} from "../../src/lens/CascadeVaultLens.sol";
import {ICascadeBridge} from "../../src/interfaces/ICascadeBridge.sol";
import {ISTAKING_ADDRESS, IStaking} from "../../src/interfaces/IStaking.sol";
import {CascadeMath} from "../../src/libraries/CascadeMath.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {CascadePayoutMath} from "../../src/libraries/CascadePayoutMath.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {Schedule} from "../governance/Schedule.sol";
import {
    AmountMismatch,
    DuplicateBatch,
    NotBridge,
    PayoutsMismatch,
    UnknownPeer,
    ValueMismatch,
    VaultInsolvent
} from "../../src/CascadeErrors.sol";
import {
    BatchDelivered,
    DepositBounced,
    DepositSkipped,
    Deposited,
    PayoutBatchCancelled,
    PayoutBatchQueued,
    PayoutChunkSent,
    RedeemDeferred,
    RedeemReversed,
    RedeemSkipped,
    Redeemed,
    RedeemedDirect,
    Staked
} from "../../src/CascadeEvents.sol";
import {BounceReason, PayoutBatch} from "../../src/CascadeTypes.sol";
import {DIRECT_ORIGIN} from "../../src/CascadeConstants.sol";

/// A rogue adapter with flash capital: delivers a forged batch whose deposit is its own borrowed TAO,
/// then redeems its fresh shares directly in the same transaction.
contract FlashAdapter is ICascadeBridge {
    CascadeVault immutable vault;
    /// What the attacker reads of the vault (its stake hotkey and coldkey), through the vault's lens.
    CascadeVaultLens immutable vaultLens;

    constructor(CascadeVault v) {
        vault = v;
        vaultLens = new CascadeVaultLens(address(v));
    }

    function send(uint64, address, bytes calldata, uint256) external payable {}

    function quoteFee(uint64, address, bytes calldata, uint256) external pure returns (uint256) {
        return 0;
    }

    function maxMessageValue() external pure returns (uint256) {
        return 5_000e18;
    }

    function attack(uint64 chain, address door, bytes calldata message, uint256 amount) external {
        vault.onBridgeMessage{value: amount}(chain, door, message, amount);
        vault.redeemDirect(vault.balanceOf(address(this)), false);
    }

    /// Two deliveries in one transaction: a deposit-only batch of borrowed TAO first, so the gross
    /// before the second (redeem-only) delivery's deposits already holds it, then the redeems, then the
    /// capital back out with redeemDirect.
    function attackSplit(uint64 chain, address door, bytes calldata deposits, uint256 amount, bytes calldata redeems)
        external
    {
        vault.onBridgeMessage{value: amount}(chain, door, deposits, amount);
        vault.onBridgeMessage(chain, door, redeems, 0);
        vault.redeemDirect(vault.balanceOf(address(this)), false);
    }

    /// attackSplit with a stake gift between the deliveries: `giftRao` of root stake moved onto the vault's
    /// stake hotkey from another coldkey (transferStake on the chain; the mock's donateStake here). The
    /// gift raises every share's value, so a holder of most of the shares gets most of it back.
    function attackWithGift(
        uint64 chain,
        address door,
        bytes calldata deposits,
        uint256 amount,
        bytes calldata redeems,
        uint256 giftRao
    ) external {
        vault.onBridgeMessage{value: amount}(chain, door, deposits, amount);
        MockStaking(ISTAKING_ADDRESS).donateStake(vaultLens.stakeHotkey(), vaultLens.coldkey(), giftRao);
        vault.onBridgeMessage(chain, door, redeems, 0);
        vault.redeemDirect(vault.balanceOf(address(this)), false);
    }

    function deliver(uint64 chain, address door, bytes calldata message, uint256 amount) external {
        vault.onBridgeMessage{value: amount}(chain, door, message, amount);
    }

    function exit() external {
        vault.redeemDirect(vault.balanceOf(address(this)), false);
    }

    receive() external payable {}
}

contract VaultDeliveryTest is VaultTestBase {
    address stranger = makeAddr("stranger");

    /// The batch key by its formula, independent of the vault.
    function keyOf(
        uint64 chain,
        address sender,
        uint64 batchId,
        CascadeMessages.Entry[] memory deposits,
        CascadeMessages.Entry[] memory redeems
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(chain, sender, keccak256(CascadeMessages.encodeBatch(batchId, deposits, redeems))));
    }

    function redeemVia(address user, uint256 shares) internal returns (bytes32) {
        return deliver(BASE, frontDoor, ++nextBatchId, noEntries(), entries1(user, shares));
    }

    /// The key the next redeemVia(user, shares) will produce.
    function nextRedeemKey(address user, uint256 shares) internal view returns (bytes32) {
        return keyOf(BASE, frontDoor, nextBatchId + 1, noEntries(), entries1(user, shares));
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

    function addr(uint256 n) internal pure returns (address) {
        // casting to 'uint160' is safe because n is a small test index
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(n));
    }

    /// Calls onBridgeMessage as the bridge with an explicit amount and value.
    function rawDeliver(uint64 chain, address sender, bytes memory message, uint256 amount, uint256 value) internal {
        vm.deal(address(bridge), address(bridge).balance + value);
        vm.prank(address(bridge));
        vault.onBridgeMessage{value: value}(chain, sender, message, amount);
    }

    // ---- pricing and deposits ----

    function test_delivery_oneBatchPriceForAllEntries() public {
        CascadeMessages.Entry[] memory d = entries2(alice, 10e18, bob, 10e18);
        bytes32 key = keyOf(BASE, frontDoor, 1, d, noEntries());

        vm.expectEmit(address(vault));
        emit BatchDelivered(key, BASE, frontDoor, 1, 20e18);
        // A = 0, S = 0 for both entries: 10e18 * (0 + 1e6) / (0 + 1) = 1e25
        vm.expectEmit(address(vault));
        emit Deposited(key, alice, 10e18, 1e25);
        vm.expectEmit(address(vault));
        emit Deposited(key, bob, 10e18, 1e25);
        assertEq(deliver(BASE, frontDoor, 1, d, noEntries()), key);

        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(vault.balanceOf(bob), 1e25);
        assertEq(vault.totalSupply(), 2e25);
        assertEq(vaultLens.grossAssets(), 20e18);
    }

    function test_delivery_secondBatchPricesAgainstExistingAssets() public {
        deliver(BASE, frontDoor, 1, entries2(alice, 10e18, bob, 10e18), noEntries());

        // A = 25e18 - 5e18 = 20e18, S = 2e25: 5e18 * (2e25 + 1e6) / (20e18 + 1) = 5e24 exactly
        bytes32 key = keyOf(BASE, frontDoor, 2, entries1(bob, 5e18), noEntries());
        vm.expectEmit(address(vault));
        emit Deposited(key, bob, 5e18, 5e24);
        deliver(BASE, frontDoor, 2, entries1(bob, 5e18), noEntries());

        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(vault.balanceOf(bob), 15e24);
    }

    function test_delivery_misalignedEntriesRoundDownAndNeverRevert() public {
        // 10e18 + 5e8 and 5e18 - 5e8 sum to an aligned 15e18; each entry floors to rao on its own.
        CascadeMessages.Entry[] memory d = entries2(alice, 10e18 + 5e8, bob, 5e18 - 5e8);
        bytes32 key = keyOf(BASE, frontDoor, 1, d, noEntries());

        // alice: 10e18 * 1e6 = 1e25; bob: 4_999_999_999_000_000_000 * 1e6
        vm.expectEmit(address(vault));
        emit Deposited(key, alice, 10e18, 1e25);
        vm.expectEmit(address(vault));
        emit Deposited(key, bob, 4_999_999_999_000_000_000, 4_999_999_999_000_000_000_000_000);
        deliver(BASE, frontDoor, 1, d, noEntries());

        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(vault.balanceOf(bob), 4_999_999_999_000_000_000_000_000);
        // the floored 1e9 stays in the vault
        assertEq(vaultLens.grossAssets(), 15e18);
    }

    function test_delivery_zeroAddressDepositSkipped() public {
        bytes32 key = keyOf(BASE, frontDoor, 1, entries1(address(0), 1e18), noEntries());

        vm.expectEmit(address(vault));
        emit DepositSkipped(key, address(0), 1e18);
        deliver(BASE, frontDoor, 1, entries1(address(0), 1e18), noEntries());

        assertEq(vault.totalSupply(), 0);
        assertEq(vaultLens.grossAssets(), 1e18);
        assertTrue(vaultLens.processed(key));
    }

    // ---- guards ----

    function test_delivery_notBridgeReverts() public {
        bytes memory m = CascadeMessages.encodeBatch(1, entries1(alice, 1e18), noEntries());

        vm.deal(stranger, 1e18);
        vm.prank(stranger);
        vm.expectRevert(NotBridge.selector);
        vault.onBridgeMessage{value: 1e18}(BASE, frontDoor, m, 1e18);

        // a disabled bridge is no longer a bridge
        vm.prank(guardian);
        vault.disableBridge(address(bridge));
        vm.expectRevert(NotBridge.selector);
        rawDeliver(BASE, frontDoor, m, 1e18, 1e18);
    }

    function test_delivery_unknownPeerReverts() public {
        bytes memory m = CascadeMessages.encodeBatch(1, entries1(alice, 1e18), noEntries());

        vm.expectRevert(UnknownPeer.selector);
        rawDeliver(BASE, bob, m, 1e18, 1e18);
        // the registered address on another chain is another peer
        vm.expectRevert(UnknownPeer.selector);
        rawDeliver(BITTENSOR, frontDoor, m, 1e18, 1e18);

        vm.prank(guardian);
        vault.removeFrontDoor(BASE, frontDoor);
        vm.expectRevert(UnknownPeer.selector);
        rawDeliver(BASE, frontDoor, m, 1e18, 1e18);
    }

    function test_delivery_valueMismatchReverts() public {
        bytes memory m = CascadeMessages.encodeBatch(1, entries1(alice, 1e18), noEntries());

        vm.expectRevert(ValueMismatch.selector);
        rawDeliver(BASE, frontDoor, m, 1e18, 1e18 - 1);
        vm.expectRevert(ValueMismatch.selector);
        rawDeliver(BASE, frontDoor, m, 1e18, 1e18 + 1);
    }

    function test_delivery_amountMismatchReverts() public {
        bytes memory m = CascadeMessages.encodeBatch(1, entries1(alice, 1e18), noEntries());
        vm.expectRevert(AmountMismatch.selector);
        rawDeliver(BASE, frontDoor, m, 2e18, 2e18);

        // value on a redeem-only batch is a mismatch too
        bytes memory r = CascadeMessages.encodeBatch(2, noEntries(), entries1(alice, 1e24));
        vm.expectRevert(AmountMismatch.selector);
        rawDeliver(BASE, frontDoor, r, 1e9, 1e9);
    }

    function test_delivery_exactReplayRejected() public {
        deliver(BASE, frontDoor, 1, entries1(alice, 10e18), noEntries());

        vm.expectRevert(DuplicateBatch.selector);
        deliver(BASE, frontDoor, 1, entries1(alice, 10e18), noEntries());

        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(vaultLens.grossAssets(), 10e18);
    }

    function test_delivery_forgedBatchIdDoesNotBlockRealOne() public {
        // A forged batch carries the honest front door's next batchId with other entries.
        bytes32 forged = deliver(BASE, frontDoor, 5, entries1(bob, 1e18), noEntries());
        bytes32 real = deliver(BASE, frontDoor, 5, entries1(alice, 10e18), noEntries());

        assertTrue(forged != real);
        assertTrue(vaultLens.processed(forged));
        assertTrue(vaultLens.processed(real));
        // bob: 1e18 * 1e6 = 1e24; alice at A = 1e18, S = 1e24: 10e18 * (1e24 + 1e6) / (1e18 + 1) = 1e25
        assertEq(vault.balanceOf(bob), 1e24);
        assertEq(vault.balanceOf(alice), 1e25);
    }

    function test_delivery_depositOnlyBatchRecordedWithoutPayout() public {
        bytes32 key = depositVia(alice, 10e18);

        assertTrue(vaultLens.processed(key));
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        assertEq(b.count, 0);
        assertEq(b.remaining, 0);
        assertEq(b.queuedAt, 0);
        assertEq(vaultLens.pendingPayouts(), 0);
    }

    // ---- redeems ----

    function test_delivery_redeemOnlyBatchWithZeroValue() public {
        depositVia(alice, 10e18);

        bytes32 key = keyOf(BASE, frontDoor, 2, noEntries(), entries1(alice, 5e24));
        vm.expectEmit(address(vault));
        emit BatchDelivered(key, BASE, frontDoor, 2, 0);
        // A = 10e18, S = 1e25: 5e24 * (10e18 + 1) / (1e25 + 1e6) = 5e18 exactly
        vm.expectEmit(address(vault));
        emit Redeemed(key, alice, 5e24, 5e18);
        // price = (10e18 + 1) * 1e18 / (1e25 + 1e6) = 1e12 exactly
        vm.expectEmit(address(vault));
        emit PayoutBatchQueued(key, BASE, 2, 1, 5e18, 1e12);
        deliver(BASE, frontDoor, 2, noEntries(), entries1(alice, 5e24));

        assertEq(vault.balanceOf(alice), 5e24);
        assertEq(vaultLens.pendingPayouts(), 5e18);
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        assertEq(b.sourceChain, BASE);
        assertEq(b.frontDoor, frontDoor);
        assertEq(b.batchId, 2);
        assertEq(b.queuedAt, vm.getBlockTimestamp());
        assertEq(b.cursor, 0);
        assertEq(b.count, 1);
        assertEq(b.chunk, 0);
        assertEq(b.remaining, 5e18);
        assertEq(b.payoutsHash, keccak256(abi.encode(bytes32(0), alice, uint256(5e24), uint256(5e18))));
    }

    function test_delivery_redeemClippedToBalance() public {
        depositVia(alice, 10e18);

        // s = min(2e25, 1e25); 1e25 * (10e18 + 1) / (1e25 + 1e6) = 10e18
        bytes32 key = nextRedeemKey(alice, 2e25);
        vm.expectEmit(address(vault));
        emit Redeemed(key, alice, 1e25, 10e18);
        redeemVia(alice, 2e25);

        assertEq(vault.balanceOf(alice), 0);
        assertEq(vaultLens.pendingPayouts(), 10e18);
    }

    function test_delivery_redeemClippedToMaxEntryValue() public {
        vm.prank(owner);
        // the entry limit's floor, 10 TAO (Task 23)
        vault.setMessageLimits(10e18, 4_000e18, 10);
        depositVia(alice, 50e18);

        // sMax = 10e18 * (5e25 + 1e6) / (50e18 + 1) = 1e25; 1e25 * (50e18 + 1) / (5e25 + 1e6) = 10e18
        bytes32 key = nextRedeemKey(alice, 5e25);
        vm.expectEmit(address(vault));
        emit Redeemed(key, alice, 1e25, 10e18);
        redeemVia(alice, 5e25);

        assertEq(vault.balanceOf(alice), 4e25);
        assertEq(vaultLens.pendingPayouts(), 10e18);
    }

    /// Stakes the vault's idle TAO as the keeper (exact reads) and lets a day pass, so all of it has
    /// ramped into the allowance base.
    function stakeAndRamp() internal {
        staking.setOneRaoShort(false);
        vm.prank(keeper);
        vault.stakeIdle();
        vm.warp(vm.getBlockTimestamp() + 1 days);
    }

    function test_delivery_redeemClippedToPeerAllowanceThenDeferred() public {
        depositVia(alice, 1_000e18);
        stakeAndRamp();
        bytes32 peer = vaultLens.peerId(BASE, frontDoor);
        uint256 t0 = vm.getBlockTimestamp();

        // allowance = max(1_000e18 staked * 2000 / 10000, 100e18) = 200e18;
        // sMax = 200e18 * (1e27 + 1e6) / (1_000e18 + 1) = 2e26; 2e26 * (1_000e18 + 1) / (1e27 + 1e6) = 200e18
        bytes32 key = nextRedeemKey(alice, 1e27);
        vm.expectEmit(address(vault));
        emit Redeemed(key, alice, 2e26, 200e18);
        redeemVia(alice, 1e27);
        (uint64 start, uint256 burned) = vaultLens.burnWindows(peer);
        assertEq(start, t0);
        assertEq(burned, 200e18);

        // the window's allowance is spent: nothing burned, the request is deferred
        key = nextRedeemKey(alice, 1e27);
        vm.expectEmit(address(vault));
        emit RedeemDeferred(key, alice, 1e27);
        redeemVia(alice, 1e27);
        assertTrue(vaultLens.processed(key));
        assertEq(vaultLens.getPayoutBatch(key).count, 0);

        vm.warp(t0 + 24 hours - 1);
        key = nextRedeemKey(alice, 1e27);
        vm.expectEmit(address(vault));
        emit RedeemDeferred(key, alice, 1e27);
        redeemVia(alice, 1e27);
        assertEq(vault.balanceOf(alice), 8e26);
        assertEq(vaultLens.pendingPayouts(), 200e18);

        // New window; the stake still holds the reserved 200e18 (not paid out yet), so the allowance is
        // 200e18 again.
        // A = 1_000e18 - 200e18 = 800e18, S = 8e26: sMax = 200e18 * (8e26 + 1e6) / (800e18 + 1) = 2e26;
        // 2e26 * (800e18 + 1) / (8e26 + 1e6) = 200e18
        vm.warp(t0 + 24 hours);
        key = nextRedeemKey(alice, 1e27);
        vm.expectEmit(address(vault));
        emit Redeemed(key, alice, 2e26, 200e18);
        redeemVia(alice, 1e27);
        (start, burned) = vaultLens.burnWindows(peer);
        assertEq(start, t0 + 24 hours);
        assertEq(burned, 200e18);
        assertEq(vault.balanceOf(alice), 6e26);
        assertEq(vaultLens.pendingPayouts(), 400e18);
    }

    /// ChatGPT R2 claim F (R6; contracts/README.md "Windows are fixed, not rolling"): a window opened by a 1-TAO burn at
    /// t0 still holds 199 TAO of its 200 at t0 + 24 h - 1, and a fresh window opens at t0 + 24 h on the same base (the
    /// unpaid burns are still staked), so 399 TAO, two allowances less the opener, burn one second apart, and both
    /// batches fall due one second apart a payout delay later. A rolling 24-hour limit would have burned nothing at
    /// t0 + 24 h. Kept as designed for the self-funded launch; the leaky bucket is queued before other people's money.
    function test_claimF_twoAllowancesBurnOneSecondApartAcrossAReset() public {
        depositVia(alice, 1_000e18);
        stakeAndRamp();
        bytes32 peer = vaultLens.peerId(BASE, frontDoor);
        uint256 t0 = vm.getBlockTimestamp();
        // the allowance: max(1_000e18 * 2_000 / 10_000, 100e18) = 200e18, the door's and the global alike

        // t0: a 1-TAO burn opens both windows
        redeemVia(alice, 1e24);
        (uint64 start, uint256 burned) = vaultLens.burnWindows(peer);
        assertEq(start, t0, "the window opens at the first burn");
        assertEq(burned, 1e18);
        uint256 pending0 = vaultLens.pendingPayouts();
        assertEq(pending0, 1e18);

        // t0 + 24 h - 1: the same window; its other 199e18 burn
        vm.warp(t0 + 24 hours - 1);
        bytes32 k1 = redeemVia(alice, 1e27);
        (start, burned) = vaultLens.burnWindows(peer);
        assertEq(start, t0, "still the window opened at t0");
        assertEq(burned, 200e18, "its whole allowance");

        // t0 + 24 h, one second later: a fresh window on the same 1_000e18 base, all 200e18 of it burned
        vm.warp(t0 + 24 hours);
        bytes32 k2 = redeemVia(alice, 1e27);
        (start, burned) = vaultLens.burnWindows(peer);
        assertEq(start, t0 + 24 hours, "a fresh window");
        assertEq(burned, 200e18, "a second whole allowance");
        (start, burned) = vaultLens.burnWindows(bytes32(0));
        assertEq(start, t0 + 24 hours, "the global window reset with it");
        assertEq(burned, 200e18, "and took the same");

        // within one second: 399e18, two allowances less the opener (a rolling 24-hour limit: 199e18 and then 0)
        assertEq(vaultLens.pendingPayouts() - pending0, 399e18, "about two allowances in one second");
        assertEq(vault.balanceOf(alice), 1e27 - 400e24);
        // both payable a second apart, a payout delay later: a guardian answering the first lost payout cannot stop the
        // second
        assertEq(vaultLens.getPayoutBatch(k2).queuedAt - vaultLens.getPayoutBatch(k1).queuedAt, 1, "queued 1 s apart");
    }

    function test_delivery_allowanceOnPreDeliveryGrossDefeatsFlashDeposit() public {
        staking.setOneRaoShort(false);
        // alice holds 1e27 shares worth 1_000e18, all staked on HK1
        depositVia(alice, 1_000e18);
        vm.prank(keeper);
        vault.stakeIdle();

        FlashAdapter adapter = new FlashAdapter(vault);
        Schedule.run(vault, owner, abi.encodeCall(vault.activateBridge, (address(adapter))));

        // A forged batch deposits 4_000e18 of flash capital to the adapter and redeems alice in full.
        // The allowance is on the gross before the deposit: max(1_000e18 * 20%, 100e18) = 200e18 (on the
        // post-delivery gross of 5_000e18 it would be 1_000e18, the whole of alice).
        // A = 1_000e18, S = 1e27: the adapter gets 4_000e18 * (1e27 + 1e6) / (1_000e18 + 1) = 4e27 shares;
        // alice's sMax = 200e18 * (1e27 + 1e6) / (1_000e18 + 1) = 2e26 → 200e18
        uint256 flash = 4_000e18;
        vm.deal(address(adapter), flash);
        bytes memory message =
            CascadeMessages.encodeBatch(77, entries1(address(adapter), flash), entries1(alice, type(uint256).max));
        bytes32 key = vaultLens.batchKey(BASE, frontDoor, message);
        vm.expectEmit(address(vault));
        emit Deposited(key, address(adapter), flash, 4e27);
        vm.expectEmit(address(vault));
        emit Redeemed(key, alice, 2e26, 200e18);
        // the adapter's same-transaction redeemDirect: assets 5_000e18 - 200e18 pending, S = 4.8e27:
        // 4e27 * (4_800e18 + 1) / (4.8e27 + 1e6) = 4_000e18, no more than it deposited
        vm.expectEmit(address(vault));
        emit RedeemedDirect(address(adapter), 4e27, flash, false);
        adapter.attack(BASE, frontDoor, message, flash);

        assertEq(vault.balanceOf(alice), 8e26);
        assertEq(vaultLens.pendingPayouts(), 200e18);
        (, uint256 burned) = vaultLens.burnWindows(vaultLens.peerId(BASE, frontDoor));
        assertLe(burned, 200e18);
        assertEq(vault.balanceOf(address(adapter)), 0);
        assertLe(address(adapter).balance, flash);
        // alice's remaining 8e26 shares are still worth 800e18
        assertEq(vaultLens.totalAssets(), 800e18);
    }

    /// alice holds 1e27 shares worth 1_000e18, staked on HK1 more than a day ago, and a FlashAdapter is an
    /// enabled bridge.
    function flashSetup() internal returns (FlashAdapter adapter) {
        staking.setOneRaoShort(false);
        depositVia(alice, 1_000e18);
        vm.prank(keeper);
        vault.stakeIdle();
        adapter = new FlashAdapter(vault);
        Schedule.run(vault, owner, abi.encodeCall(vault.activateBridge, (address(adapter))));
    }

    /// The README soft spot in one transaction: a rogue adapter delivers a deposit-only batch of 4_000e18
    /// borrowed TAO, then a redeem-only batch naming alice, then takes its capital back with redeemDirect.
    /// The second delivery's gross before its own deposits holds the borrowed 4_000e18 (5_000e18), so on
    /// that gross the allowance would be 1_000e18 and alice would be burned in full. The base is the stake
    /// the vault has held for a day, 1_000e18: the allowance is 200e18.
    function test_delivery_flashCapitalInEarlierDeliveryDoesNotRaiseAllowance() public {
        FlashAdapter adapter = flashSetup();
        uint256 flash = 4_000e18;
        vm.deal(address(adapter), flash);
        bytes memory deposits = CascadeMessages.encodeBatch(77, entries1(address(adapter), flash), noEntries());
        bytes memory redeems = CascadeMessages.encodeBatch(78, noEntries(), entries1(alice, type(uint256).max));
        bytes32 key = vaultLens.batchKey(BASE, frontDoor, redeems);

        // the deposit mints 4e27 at A = 1_000e18, S = 1e27; the redeems price at A = 5_000e18, S = 5e27:
        // sMax = 200e18 * (5e27 + 1e6) / (5_000e18 + 1) = 2e26 → 200e18
        vm.expectEmit(address(vault));
        emit Redeemed(key, alice, 2e26, 200e18);
        // assets 5_000e18 - 200e18 pending, S = 4.8e27: 4e27 * (4_800e18 + 1) / (4.8e27 + 1e6) = 4_000e18
        vm.expectEmit(address(vault));
        emit RedeemedDirect(address(adapter), 4e27, flash, false);
        adapter.attackSplit(BASE, frontDoor, deposits, flash, redeems);

        assertEq(vault.balanceOf(alice), 8e26);
        assertEq(vaultLens.pendingPayouts(), 200e18);
        (, uint256 burned) = vaultLens.burnWindows(vaultLens.peerId(BASE, frontDoor));
        assertEq(burned, 200e18);
        assertEq(vault.balanceOf(address(adapter)), 0);
        assertEq(address(adapter).balance, flash);
        assertEq(vaultLens.totalAssets(), 800e18);
    }

    /// Stake can rise without stakeIdle: another coldkey can move stake onto the vault's hotkey. On v3.1 the
    /// gift was spread over every share at once, so an adapter that first delivers 100_000e18 of its own as a
    /// deposit held 99% of the shares and got about 3_960e18 of a 4_000e18 gift back with redeemDirect: about
    /// 40e18 to lift the stake from 1_000e18 to 5_000e18, and with it the allowance on the stake read from
    /// 200e18 to 1_000e18. The base counts only the stake the vault booked (stakeIdle's and reward claims'
    /// measurements, less what it unstaked), so it stays 1_000e18 and the allowance 200e18; and since Task 12
    /// the price reads min(visible, booked) too (I-3), so the gift is not the shares' at all: the adapter gets
    /// back its deposit and none of the gift, which stays on the hotkey, unpriced.
    function test_delivery_giftedStakeDoesNotRaiseAllowance() public {
        FlashAdapter adapter = flashSetup();
        uint256 flash = 100_000e18;
        vm.deal(address(adapter), flash);
        bytes memory deposits = CascadeMessages.encodeBatch(77, entries1(address(adapter), flash), noEntries());
        bytes memory redeems = CascadeMessages.encodeBatch(78, noEntries(), entries1(alice, 1e27));
        bytes32 key = vaultLens.batchKey(BASE, frontDoor, redeems);

        vm.recordLogs();
        adapter.attackWithGift(BASE, frontDoor, deposits, flash, redeems, 4_000e9);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 out;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == Redeemed.selector) {
                assertEq(logs[i].topics[1], key);
                (, out) = abi.decode(logs[i].data, (uint256, uint256));
            }
        }
        // alice's shares are worth her 1_000e18 (none of the gift); 200e18 of it burns, floored
        assertLe(out, 200e18);
        assertGe(out, 200e18 - 1e9);
        (, uint256 burned) = vaultLens.burnWindows(vaultLens.peerId(BASE, frontDoor));
        assertEq(burned, out);
        // the adapter got its deposit back and none of the gift, which stays staked, unbooked
        assertLe(address(adapter).balance, flash);
        assertGt(address(adapter).balance, flash - 1e9);
        assertEq(vaultLens.surplusStakeRao(), 4_000e9);
    }

    /// The booked-stake cap does not hold back the vault's own stake: a validator's hotkey swap moves it
    /// outside the set (the base, like the price, drops to what the set holds), and once the new hotkey
    /// is added back it counts in full again, because the vault booked it when it staked.
    function test_delivery_swappedHotkeyReAddedCountsAgain() public {
        depositVia(alice, 1_000e18);
        stakeAndRamp();
        vm.prank(address(vault));
        staking.moveStake(HK1, HK5, 0, 0, 1_000e9);
        // the set holds nothing: A = 0 against S = 1e27, and the base is 0, so the floor applies
        assertEq(vaultLens.visibleStakeRao(), 0);
        vm.prank(guardian);
        vault.addHotkey(HK5);

        // A = 1_000e18, S = 1e27, base 1_000e18 again: allowance 200e18
        bytes32 key = nextRedeemKey(alice, 1e27);
        vm.expectEmit(address(vault));
        emit Redeemed(key, alice, 2e26, 200e18);
        redeemVia(alice, 1e27);
    }

    /// Delivers `flash` of the adapter's own TAO as a deposit-only batch: it mints 4e27 shares at
    /// A = 1_000e18, S = 1e27.
    function flashDeposit(FlashAdapter adapter, uint256 flash) internal {
        vm.deal(address(adapter), flash);
        adapter.deliver(
            BASE, frontDoor, CascadeMessages.encodeBatch(77, entries1(address(adapter), flash), noEntries()), flash
        );
        assertEq(vault.balanceOf(address(adapter)), 4e27);
    }

    /// Delivers a redeem-only batch for all of alice's shares through the adapter and returns what she
    /// was burned for (her Redeemed event's assets, 0 if none).
    function redeemAliceVia(FlashAdapter adapter) internal returns (uint256 out) {
        bytes memory redeems = CascadeMessages.encodeBatch(++nextBatchId + 100, noEntries(), entries1(alice, 1e27));
        vm.recordLogs();
        adapter.deliver(BASE, frontDoor, redeems, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == Redeemed.selector) {
                (, out) = abi.decode(logs[i].data, (uint256, uint256));
            }
        }
    }

    /// The same capital a block earlier: still liquid, which the base never counts. Priced at
    /// A = 5_000e18, S = 5e27: sMax = 200e18 * (5e27 + 1e6) / (5_000e18 + 1) = 2e26 → 200e18.
    function test_delivery_capitalFromEarlierBlockDoesNotRaiseAllowance() public {
        FlashAdapter adapter = flashSetup();
        flashDeposit(adapter, 4_000e18);
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 12);

        assertEq(redeemAliceVia(adapter), 200e18);
        assertEq(vault.balanceOf(alice), 8e26);
        adapter.exit();
        assertEq(address(adapter).balance, 4_000e18);
    }

    /// The same capital staked by the keeper in between (the ops keeper stakes idle TAO as soon as it can):
    /// stake added in the last day counts only as it ages, linearly over the day. 12 seconds after the
    /// stake, base = 5_000e18 - 4_000e18 * (86_400 - 12) / 86_400 = 1_000_555_555_555_555_555_556, so the
    /// allowance is 200_111_111_111_111_111_111 and alice is burned for that, floored to rao.
    function test_delivery_capitalStakedJustBeforeDoesNotRaiseAllowance() public {
        FlashAdapter adapter = flashSetup();
        flashDeposit(adapter, 4_000e18);
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 12);
        vm.prank(keeper);
        vault.stakeIdle();
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 12);

        uint256 out = redeemAliceVia(adapter);
        assertEq(out, 200_111_111_111_000_000_000);
        (, uint256 burned) = vaultLens.burnWindows(vaultLens.peerId(BASE, frontDoor));
        assertEq(burned, out);
        // the adapter unstakes its capital and leaves with it
        adapter.exit();
        assertEq(address(adapter).balance, 4_000e18);
    }

    /// The residual: capital that stays staked for a day is, to the vault, a holder like any other, and
    /// counts in full. Half a day in, half of it counts.
    function test_delivery_stakeCountsInAllowanceAsItAges() public {
        FlashAdapter adapter = flashSetup();
        flashDeposit(adapter, 4_000e18);
        vm.prank(keeper);
        vault.stakeIdle();

        // half a day: base 1_000e18 + 2_000e18 = 3_000e18, allowance 600e18
        vm.warp(vm.getBlockTimestamp() + 12 hours);
        assertEq(redeemAliceVia(adapter), 600e18);
        // a new window a day after the stake: base 5_000e18 less nothing, and alice's other 400e18 burn
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        assertEq(redeemAliceVia(adapter), 400e18);
        assertEq(vault.balanceOf(alice), 0);
    }

    function test_delivery_minDailyOutflowFloor() public {
        depositVia(alice, 10e18);

        // 10e18 * 2000 / 10000 = 2e18 < 100e18 floor, so all 10e18 may leave
        bytes32 key = nextRedeemKey(alice, 1e25);
        vm.expectEmit(address(vault));
        emit Redeemed(key, alice, 1e25, 10e18);
        redeemVia(alice, 1e25);

        (, uint256 burned) = vaultLens.burnWindows(vaultLens.peerId(BASE, frontDoor));
        assertEq(burned, 10e18);
        assertEq(vaultLens.pendingPayouts(), 10e18);
    }

    /// Liquid TAO is not in the allowance base: deposits the keeper has not staked yet (a new vault) and
    /// a direct deposit leave the front door the minDailyOutflow floor, here 100e18 of alice's 1_000e18.
    function test_delivery_liquidTaoNotInAllowanceBase() public {
        // the cap up is a loosening: a scheduled item (Task 11), run before the deposits
        Schedule.run(vault, owner, abi.encodeCall(CascadeVault.setMaxTotalAssets, (10_000e18)));
        depositVia(alice, 1_000e18);
        // A = 1_000e18, S = 1e27: 4_000e18 * (1e27 + 1e6) / (1_000e18 + 1) = 4e27
        depositDirect(carol, 4_000e18);

        // A = 5_000e18, S = 5e27, allowance max(0, 100e18): sMax = 100e18 * (5e27 + 1e6) / (5_000e18 + 1) =
        // 1e26 → 100e18
        bytes32 key = nextRedeemKey(alice, 1e27);
        vm.expectEmit(address(vault));
        emit Redeemed(key, alice, 1e26, 100e18);
        redeemVia(alice, 1e27);
    }

    /// A redeem worth less than MIN_REDEEM_VALUE, 0.03 TAO (Task 21), is deferred, not burned: twice MAX_FEE_ABS, so
    /// an entry with shares keeps at least half its value under any fee ceiling (spec §3.3, I-14) and stays above the
    /// bridge's conversion floor (0.002 TAO). That holds however it got small: asked small, clipped to a small
    /// balance, or clipped to the last sliver of the window's allowance. The price stays exactly 1e-6 TAO per share
    /// throughout (A * 1e6 == S), so s shares are worth s / 1e6.
    function test_delivery_redeemBelowMinimumDeferred() public {
        depositVia(alice, 1_000e18);
        // A = 1_000e18, S = 1e27: 0.015e18 * (1e27 + 1e6) / (1_000e18 + 1) = 1.5e22
        depositVia(bob, 0.015e18);
        assertEq(vault.balanceOf(bob), 1.5e22);

        // asked small (2.9999e22 shares, 0.029999 TAO), and clipped to bob's 1.5e22 (0.015 TAO)
        bytes32 key = keyOf(BASE, frontDoor, 3, noEntries(), entries2(alice, 2.9999e22, bob, 1e25));
        vm.expectEmit(address(vault));
        emit RedeemDeferred(key, alice, 2.9999e22);
        vm.expectEmit(address(vault));
        emit RedeemDeferred(key, bob, 1e25);
        deliver(BASE, frontDoor, 3, noEntries(), entries2(alice, 2.9999e22, bob, 1e25));
        assertEq(vaultLens.getPayoutBatch(key).count, 0);
        assertEq(vault.balanceOf(alice), 1e27);
        assertEq(vault.balanceOf(bob), 1.5e22);
        // nothing burned, so the window is not written; the lens reads it fresh (R2 F4)
        (uint64 start,) = storedBurnWindow(vaultLens.peerId(BASE, frontDoor));
        assertEq(start, 0);
        (start,) = vaultLens.burnWindows(vaultLens.peerId(BASE, frontDoor));
        assertEq(start, vm.getBlockTimestamp());

        // exactly 0.03 TAO burns
        key = keyOf(BASE, frontDoor, 4, noEntries(), entries1(alice, 3e22));
        vm.expectEmit(address(vault));
        emit Redeemed(key, alice, 3e22, 0.03e18);
        deliver(BASE, frontDoor, 4, noEntries(), entries1(alice, 3e22));

        // the allowance is the 100e18 floor (nothing staked): 99.955e18 more leaves 0.015e18 of it, and a
        // 1-TAO request clipped to that sliver is deferred
        deliver(BASE, frontDoor, 5, noEntries(), entries1(alice, 99.955e24));
        key = keyOf(BASE, frontDoor, 6, noEntries(), entries1(alice, 1e24));
        vm.expectEmit(address(vault));
        emit RedeemDeferred(key, alice, 1e24);
        deliver(BASE, frontDoor, 6, noEntries(), entries1(alice, 1e24));

        (, uint256 burned) = vaultLens.burnWindows(vaultLens.peerId(BASE, frontDoor));
        assertEq(burned, 99.985e18);
        assertEq(vaultLens.pendingPayouts(), 99.985e18);
        assertEq(vault.balanceOf(alice), 1e27 - 99.985e24);
    }

    /// A direct deposit sets DIRECT_ORIGIN (Task 18): the front door skips the holder until it sets Base again.
    function test_delivery_directOriginSkippedUntilSetToBase() public {
        depositVia(alice, 10e18);
        // A = 10e18, S = 1e25: 10e18 * (1e25 + 1e6) / (10e18 + 1) = 1e25
        depositDirect(alice, 10e18);
        assertEq(vaultLens.redeemOrigin(alice), DIRECT_ORIGIN);
        assertEq(vault.balanceOf(alice), 2e25);

        bytes32 key = nextRedeemKey(alice, 5e24);
        vm.expectEmit(address(vault));
        emit RedeemSkipped(key, alice, 5e24);
        redeemVia(alice, 5e24);
        assertEq(vault.balanceOf(alice), 2e25);
        assertEq(vaultLens.pendingPayouts(), 0);
        assertTrue(vaultLens.processed(key));

        vm.prank(alice);
        vault.setRedeemOrigin(BASE);

        // A = 20e18, S = 2e25: 5e24 * (20e18 + 1) / (2e25 + 1e6) = 5e18
        key = nextRedeemKey(alice, 5e24);
        vm.expectEmit(address(vault));
        emit Redeemed(key, alice, 5e24, 5e18);
        redeemVia(alice, 5e24);
        assertEq(vault.balanceOf(alice), 15e24);
        assertEq(vaultLens.pendingPayouts(), 5e18);
    }

    /// A deposit and a redeem by one holder in one batch (R4 B-H1, the door hold): the deposit mints first, and the
    /// shares it minted are fresh, so the redeem burns nothing (RedeemDeferred) and nothing is queued.
    function test_delivery_sameUserDepositAndRedeemInOneBatch() public {
        CascadeMessages.Entry[] memory d = entries1(alice, 10e18);
        CascadeMessages.Entry[] memory r = entries1(alice, 5e24);
        bytes32 key = keyOf(BASE, frontDoor, 1, d, r);

        // A = 0, S = 0: mint 10e18 * 1e6 = 1e25, all of it fresh
        vm.expectEmit(address(vault));
        emit Deposited(key, alice, 10e18, 1e25);
        vm.expectEmit(address(vault));
        emit RedeemDeferred(key, alice, 5e24);
        deliver(BASE, frontDoor, 1, d, r);

        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(vault.totalSupply(), 1e25);
        assertEq(vaultLens.pendingPayouts(), 0);
    }

    function test_delivery_runningHashOverPayoutTriples() public {
        deliver(BASE, frontDoor, 1, entries2(alice, 10e18, bob, 10e18), noEntries());
        matureShares(alice);
        matureShares(bob);

        // A = 20e18, S = 2e25: alice 5e24 → 5e18; bob 2e24 * (20e18 + 1) / (2e25 + 1e6) = 2e18
        bytes32 key = deliver(BASE, frontDoor, 2, noEntries(), entries2(alice, 5e24, bob, 2e24));

        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        bytes32 h1 = keccak256(abi.encode(bytes32(0), alice, uint256(5e24), uint256(5e18)));
        assertEq(b.payoutsHash, keccak256(abi.encode(h1, bob, uint256(2e24), uint256(2e18))));
        assertEq(b.count, 2);
        assertEq(b.remaining, 7e18);
        assertEq(vaultLens.pendingPayouts(), 7e18);
    }

    // ---- accounting ----

    function test_delivery_pendingPayoutsExcludedFromTotalAssets() public {
        depositVia(alice, 10e18);
        redeemVia(alice, 5e24);

        assertEq(vaultLens.pendingPayouts(), 5e18);
        assertEq(vaultLens.grossAssets(), 10e18);
        assertEq(vaultLens.totalAssets(), 10e18 - 5e18);
        // (5e18 + 1) * 1e18 / (5e24 + 1e6) = 1e12: the queued payout does not move the price
        assertEq(vaultLens.price(), 1e12);
    }

    function test_delivery_doesNotStake() public {
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeWithSelector(IStaking.addStake.selector), 0);
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeWithSelector(IStaking.claimRootWithHotkey.selector), 0);
        deliver(BASE, frontDoor, 1, entries2(alice, 10e18, bob, 5e18), noEntries());

        assertEq(vaultLens.visibleStakeRao(), 0);
        assertEq(address(vault).balance, 15e18 + ED);
    }

    function test_delivery_readsStakeOncePerHotkey() public {
        depositVia(alice, 10e18);
        vm.startPrank(owner);
        vault.addHotkey(HK2);
        vault.addHotkey(HK3);
        vm.stopPrank();

        // the price (A) and the allowance base (grossBefore) come from one read of the 3-hotkey set
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeWithSelector(IStaking.getStake.selector), 3);
        deliver(BASE, frontDoor, 2, entries1(bob, 1e18), entries1(alice, 5e24));
    }

    function test_delivery_revertsWhilePausedAndDeliversAfterUnpause() public {
        vm.prank(guardian);
        vault.pause();

        // the bridge check comes first
        bytes memory m = CascadeMessages.encodeBatch(1, entries1(alice, 10e18), noEntries());
        vm.deal(stranger, 10e18);
        vm.prank(stranger);
        vm.expectRevert(NotBridge.selector);
        vault.onBridgeMessage{value: 10e18}(BASE, frontDoor, m, 10e18);

        vm.expectRevert(Pausable.EnforcedPause.selector);
        deliver(BASE, frontDoor, 1, entries1(alice, 10e18), noEntries());

        vm.prank(owner);
        vault.unpause();
        bytes32 key = deliver(BASE, frontDoor, 1, entries1(alice, 10e18), noEntries());
        assertTrue(vaultLens.processed(key));
        assertEq(vault.balanceOf(alice), 1e25);
    }

    /// The largest legal batch, 50 + 50 (MAX_ENTRIES, 50 a side since Task 18), delivers whole.
    function test_delivery_acceptsMaxEntries() public {
        // 50 holders deposit 20e18 each at A = 0, S = 0: 2e25 each; gross 1_000e18
        CascadeMessages.Entry[] memory holders = new CascadeMessages.Entry[](50);
        for (uint256 i; i < 50; ++i) {
            holders[i] = CascadeMessages.Entry(addr(0x2000 + i), 20e18);
        }
        deliver(BASE, frontDoor, 1, holders, noEntries());
        for (uint256 i; i < 50; ++i) {
            matureShares(addr(0x2000 + i));
        }

        CascadeMessages.Entry[] memory d = new CascadeMessages.Entry[](50);
        CascadeMessages.Entry[] memory r = new CascadeMessages.Entry[](50);
        for (uint256 i; i < 50; ++i) {
            d[i] = CascadeMessages.Entry(addr(0x1000 + i), 1e18);
            r[i] = CascadeMessages.Entry(addr(0x2000 + i), 1e24);
        }
        // A = 1_050e18 - 50e18 = 1_000e18, S = 1e27: deposit 1e18 * (1e27 + 1e6) / (1_000e18 + 1) = 1e24;
        // redeem 1e24 * (1_000e18 + 1) / (1e27 + 1e6) = 1e18; nothing is staked, so the allowance is the
        // 100e18 floor, which covers 50e18
        bytes32 key = deliver(BASE, frontDoor, 2, d, r);

        assertTrue(vaultLens.processed(key));
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        assertEq(b.count, 50);
        assertEq(b.remaining, 50e18);
        assertEq(vaultLens.pendingPayouts(), 50e18);
        assertEq(vault.balanceOf(addr(0x1000)), 1e24);
        assertEq(vault.balanceOf(addr(0x1031)), 1e24);
        assertEq(vault.balanceOf(addr(0x2000)), 19e24);
        assertEq(vault.balanceOf(addr(0x2031)), 19e24);
    }

    function test_delivery_secondFrontDoorHasOwnAllowance() public {
        address fd2 = makeAddr("frontDoor2");
        registerFrontDoor(4663, fd2);
        // all doors together may burn 50% a day (Task 17's global window, raised through the scheduler from the
        // fixture's 20% to its bound), so here each door's own 20% binds and the global window keeps room; the
        // global window binding is VaultOrigin.t.sol's
        Schedule.run(vault, owner, abi.encodeCall(CascadeVault.setOutflowLimits, (2_000, 100e18, 5_000)));
        deliver(BASE, frontDoor, 1, entries2(alice, 500e18, bob, 500e18), noEntries());
        stakeAndRamp();
        // bob names fd2's chain, whose door then burns for him (origin by chain, Task 18: a door burns only for
        // its own chain's holders)
        vm.prank(bob);
        vault.setRedeemOrigin(4663);

        // fd1: A = 1_000e18, S = 1e27, allowance 200e18 of the 1_000e18 staked: sMax = 2e26 → 200e18
        bytes32 k1 = keyOf(BASE, frontDoor, 2, noEntries(), entries1(alice, 5e26));
        vm.expectEmit(address(vault));
        emit Redeemed(k1, alice, 2e26, 200e18);
        deliver(BASE, frontDoor, 2, noEntries(), entries1(alice, 5e26));

        // fd2: A = 800e18, S = 8e26, its own allowance 200e18 on the 1_000e18 staked:
        // sMax = 200e18 * (8e26 + 1e6) / (800e18 + 1) = 2e26 → 200e18
        bytes32 k2 = keyOf(4663, fd2, 1, noEntries(), entries1(bob, 5e26));
        vm.expectEmit(address(vault));
        emit Redeemed(k2, bob, 2e26, 200e18);
        deliver(4663, fd2, 1, noEntries(), entries1(bob, 5e26));

        assertEq(vaultLens.pendingPayouts(), 400e18);
        (, uint256 burned1) = vaultLens.burnWindows(vaultLens.peerId(BASE, frontDoor));
        (, uint256 burned2) = vaultLens.burnWindows(vaultLens.peerId(4663, fd2));
        assertEq(burned1, 200e18);
        assertEq(burned2, 200e18);
        (, uint256 burnedByAll) = vaultLens.burnWindows(bytes32(0));
        assertEq(burnedByAll, 400e18, "the global window: both doors' burns");
        // The global window (50% of the 1_000e18 staked = 500e18) keeps room for alice's next request (1e26 at
        // A = 600e18, S = 6e26: 100e18), so only fd1's own window can defer it.
        assertGe(
            1_000e18 * vaultLens.globalOutflowBps() / 10_000 - burnedByAll,
            100e18,
            "the global window has room for alice's request"
        );

        // fd1's window stays spent
        bytes32 k3 = keyOf(BASE, frontDoor, 3, noEntries(), entries1(alice, 1e26));
        vm.expectEmit(address(vault));
        emit RedeemDeferred(k3, alice, 1e26);
        deliver(BASE, frontDoor, 3, noEntries(), entries1(alice, 1e26));
    }

    function test_stakeIdle_excludesPendingPayouts() public {
        depositVia(alice, 10e18);
        redeemVia(alice, 5e24);

        // idle = (1e12 + 10e18) - 1e12 - 5e18 = 5e18 = 5_000_000_000 rao; a fresh position reads one rao short
        vm.expectEmit(address(vault));
        emit Staked(HK1, 5_000_000_000, 4_999_999_999);
        vm.prank(keeper);
        vault.stakeIdle();

        assertEq(address(vault).balance, ED + 5e18);
    }

    // ---- insolvency guard ----

    function test_delivery_insolventVaultBouncesDeposit() public {
        depositVia(alice, 10e18);
        // lost assets: gross 0 against a supply of 1e25
        vm.deal(address(vault), 0);

        // totalAssets = 1e18 - 1e12 during the call; A = max(1e18 - 1e12 - 1e18, 0) = 0, S = 1e25: bob's
        // deposit is not minted but queued back; price = (0 + 1) * 1e18 / (1e25 + 1e6) = 0
        bytes32 key = keyOf(BASE, frontDoor, 2, entries1(bob, 1e18), noEntries());
        vm.expectEmit(address(vault));
        emit DepositBounced(key, bob, 1e18, BounceReason.Insolvent);
        vm.expectEmit(address(vault));
        emit PayoutBatchQueued(key, BASE, 2, 1, 1e18, 0);
        deliver(BASE, frontDoor, 2, entries1(bob, 1e18), noEntries());

        assertTrue(vaultLens.processed(key));
        assertEq(vault.balanceOf(bob), 0);
        assertEq(vault.totalSupply(), 1e25);
        assertEq(vaultLens.pendingPayouts(), 1e18);
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        assertEq(b.count, 1);
        assertEq(b.remaining, 1e18);
        assertEq(b.payoutsHash, keccak256(abi.encode(bytes32(0), bob, uint256(0), uint256(1e18))));
        // a bounce is not a burn: the front door's window is untouched, and the lens reads it fresh (R2 F4)
        (uint64 start, uint256 burned) = storedBurnWindow(vaultLens.peerId(BASE, frontDoor));
        assertEq(start, 0);
        assertEq(burned, 0);
        (start, burned) = vaultLens.burnWindows(vaultLens.peerId(BASE, frontDoor));
        assertEq(start, vm.getBlockTimestamp());
        assertEq(burned, 0);

        // once the state is repaired (alice's 10e18 back, bob's 1e18 still reserved) deposits mint again:
        // A = (12e18 - 1e18 pending) - 1e18 = 10e18, S = 1e25: 1e18 * (1e25 + 1e6) / (10e18 + 1) = 1e24
        vm.deal(address(vault), ED + 11e18);
        deliver(BASE, frontDoor, 3, entries1(bob, 1e18), noEntries());
        assertEq(vault.balanceOf(bob), 1e24);
        assertEq(vaultLens.pendingPayouts(), 1e18);
    }

    function test_depositDirect_insolventVaultReverts() public {
        depositVia(alice, 10e18);
        vm.deal(address(vault), 0);

        vm.expectRevert(VaultInsolvent.selector);
        depositDirect(bob, 1e18);
    }

    function test_delivery_belowHalfLaunchPriceBouncesDeposits() public {
        depositVia(alice, 10e18);
        // 60% of the assets lost: 4e18 left against a supply of 1e25
        vm.deal(address(vault), ED + 4e18);

        // A = (4e18 + 1e18) - 1e18 = 4e18; 4e18 * 2_000_000 = 8e24 < 1e25: the batch delivers, bob's
        // deposit bounces; a direct deposit is still refused
        bytes32 key = keyOf(BASE, frontDoor, 2, entries1(bob, 1e18), noEntries());
        vm.expectEmit(address(vault));
        emit DepositBounced(key, bob, 1e18, BounceReason.Insolvent);
        deliver(BASE, frontDoor, 2, entries1(bob, 1e18), noEntries());
        assertEq(vault.balanceOf(bob), 0);
        assertEq(vaultLens.pendingPayouts(), 1e18);
        vm.expectRevert(VaultInsolvent.selector);
        depositDirect(bob, 1e18);
        assertEq(vault.totalSupply(), 1e25);
        // the bounced 1e18 is reserved, so the price is where the loss left it
        assertEq(vaultLens.totalAssets(), 4e18);
    }

    function test_delivery_redeemOnlyBatchDeliversInInsolventVault() public {
        depositVia(alice, 10e18);
        // 60% of the assets lost: 4e18 left against a supply of 1e25, below half the launch price
        vm.deal(address(vault), ED + 4e18);

        // a redeem-only batch still delivers, at the lowered price: A = 4e18, S = 1e25,
        // 5e24 * (4e18 + 1) / (1e25 + 1e6) = 2e18; allowance max(4e18 * 20%, 100e18) = 100e18
        bytes32 key = nextRedeemKey(alice, 5e24);
        vm.expectEmit(address(vault));
        emit Redeemed(key, alice, 5e24, 2e18);
        redeemVia(alice, 5e24);
        assertEq(vault.balanceOf(alice), 5e24);
        assertEq(vaultLens.pendingPayouts(), 2e18);
    }

    /// A griefer's minimum deposit sits in the same batch as alice's exit: the deposit bounces and the
    /// exit still burns. The queue lists deposits first, then redeems, and pays out like any batch.
    function test_delivery_insolventVaultBouncesDepositsAndStillRedeems() public {
        depositVia(alice, 10e18);
        // 60% of the assets lost: 4e18 left against a supply of 1e25
        vm.deal(address(vault), ED + 4e18);
        uint256 t0 = vm.getBlockTimestamp();

        // A = 4e18, S = 1e25 (insolvent): bob bounces; alice 5e24 * (4e18 + 1) / (1e25 + 1e6) = 2e18;
        // price = (4e18 + 1) * 1e18 / (1e25 + 1e6) = 4e11
        CascadeMessages.Entry[] memory d = entries1(bob, 1e18);
        CascadeMessages.Entry[] memory r = entries1(alice, 5e24);
        bytes32 key = keyOf(BASE, frontDoor, 2, d, r);
        vm.expectEmit(address(vault));
        emit DepositBounced(key, bob, 1e18, BounceReason.Insolvent);
        vm.expectEmit(address(vault));
        emit Redeemed(key, alice, 5e24, 2e18);
        vm.expectEmit(address(vault));
        emit PayoutBatchQueued(key, BASE, 2, 2, 3e18, 4e11);
        deliver(BASE, frontDoor, 2, d, r);

        assertEq(vault.balanceOf(bob), 0);
        assertEq(vault.balanceOf(alice), 5e24);
        assertEq(vault.totalSupply(), 5e24);
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        assertEq(b.count, 2);
        assertEq(b.remaining, 3e18);
        bytes32 h1 = keccak256(abi.encode(bytes32(0), bob, uint256(0), uint256(1e18)));
        assertEq(b.payoutsHash, keccak256(abi.encode(h1, alice, uint256(5e24), uint256(2e18))));
        assertEq(vaultLens.pendingPayouts(), 1e18 + 2e18);
        // only alice's burn counts against the window
        (, uint256 burned) = vaultLens.burnWindows(vaultLens.peerId(BASE, frontDoor));
        assertEq(burned, 2e18);

        // the list in delivery order: deposits first, then redeems
        CascadeMessages.Payout[] memory list = new CascadeMessages.Payout[](2);
        list[0] = CascadeMessages.Payout(bob, 0, 1e18);
        list[1] = CascadeMessages.Payout(alice, 5e24, 2e18);
        CascadeMessages.Payout[] memory swapped = new CascadeMessages.Payout[](2);
        swapped[0] = list[1];
        swapped[1] = list[0];
        vm.warp(t0 + 24 hours);
        vm.expectRevert(PayoutsMismatch.selector);
        vault.processPayouts(key, swapped, 10);

        // sum 3e18, fee 1e15 pro rata: bob ceil(1e18 * 1e15 / 3e18) = 333_333_333_333_334 →
        // 999_666_666_666_666_666 floors to 999_666_666_000_000_000; alice ceil(2e18 * 1e15 / 3e18) =
        // 666_666_666_666_667 → 1_999_333_333_333_333_333 floors to 1_999_333_333_000_000_000.
        // The liquid 5e18 covers net + fee, so nothing is unstaked.
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(key, 0, 2, 3e18, 2_998_999_999_000_000_000, 1e15, 1e15, 0);
        vault.processPayouts(key, list, 10);

        CascadeMessages.Entry[] memory sent = entries2(bob, 999_666_666_000_000_000, alice, 1_999_333_333_000_000_000);
        assertEq(bridge.lastMessage(), CascadeMessages.encodePayouts(key, 0, sent));
        assertEq(bridge.lastAmount(), 2_998_999_999_000_000_000);
        assertEq(bridge.lastValue(), 2_998_999_999_000_000_000 + 1e15);
        assertEq(bridge.lastRecipient(), frontDoor);
        assertEq(vaultLens.pendingPayouts(), 0);
        assertEq(vaultLens.getPayoutBatch(key).count, 0);
        assertEq(address(vault).balance, ED + 5e18 - 2_999_999_999_000_000_000);
    }

    /// A cancel re-mints each unsent redeem the value it was owed (Task 34c: here 1.5e6 shares short of the 5e24 alice
    /// burned, under a wei's worth, which the stayers keep); a bounced deposit has none and is owed its TAO (I-19), so
    /// it is carried forward as the batch's new list, still reserved, never released into the vault's assets
    /// (Task 22; v3.1 released it to the holders).
    function test_cancelPayoutBatch_carriesTheBouncedDeposit() public {
        depositVia(alice, 10e18);
        vm.deal(address(vault), ED + 4e18);
        bytes32 key = deliver(BASE, frontDoor, 2, entries1(bob, 1e18), entries1(alice, 5e24));
        CascadeMessages.Payout[] memory list = new CascadeMessages.Payout[](2);
        list[0] = CascadeMessages.Payout(bob, 0, 1e18);
        list[1] = CascadeMessages.Payout(alice, 5e24, 2e18);

        // A = 5e18 - 3e18 reserved = 2e18, S = 5e24: 2e18 * (5e24 + 1e6) / (2e18 + 1)
        uint256 reMint = 4_999_999_999_999_999_998_500_000;
        assertEq(reMint, CascadeMath.sharesForDeposit(2e18, vaultLens.totalAssets(), vault.totalSupply()));
        vm.recordLogs();
        vm.expectEmit(address(vault));
        emit RedeemReversed(key, alice, reMint, 2e18);
        vm.expectEmit(address(vault));
        emit PayoutBatchCancelled(key, 2e18, 1);
        vm.prank(owner);
        vault.cancelPayoutBatch(key, list);
        // alice's RedeemReversed only: none for bob's bounce
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 reversed;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault) || logs[i].topics[0] != RedeemReversed.selector) continue;
            ++reversed;
            assertTrue(logs[i].topics[2] != bytes32(uint256(uint160(bob))), "no RedeemReversed for the bounce");
        }
        assertEq(reversed, 1, "only alice's entry re-minted");

        assertEq(vault.balanceOf(bob), 0);
        assertEq(vault.balanceOf(alice), 5e24 + reMint);
        assertEq(vaultLens.pendingPayouts(), 1e18);
        assertEq(vaultLens.getPayoutBatch(key).count, 1);
        // gross 5e18, bob's 1e18 still reserved: alice's shares are backed by the other 4e18
        assertEq(vaultLens.totalAssets(), 4e18);
    }

    function test_delivery_sixtyPercentAssetsStillDeposits() public {
        depositVia(alice, 10e18);
        // 40% of the assets lost: 6e18 left against a supply of 1e25
        vm.deal(address(vault), ED + 6e18);

        // A = 6e18; 6e18 * 2_000_000 = 1.2e25 >= 1e25, so the guard holds:
        // 1e18 * (1e25 + 1e6) / (6e18 + 1) = 1_666_666_666_666_666_666_555_555 (floor)
        deliver(BASE, frontDoor, 2, entries1(bob, 1e18), noEntries());
        assertEq(vault.balanceOf(bob), 1_666_666_666_666_666_666_555_555);

        // A = 7e18, S = 1e25 + 1_666_666_666_666_666_666_555_555:
        // 1e18 * (11_666_666_666_666_666_666_555_555 + 1e6) / (7e18 + 1) = 1_666_666_666_666_666_666_555_555 (floor)
        depositDirect(carol, 1e18);
        assertEq(vault.balanceOf(carol), 1_666_666_666_666_666_666_555_555);
    }
}
