// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeBase} from "../../src/CascadeBase.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {ICascadeBridge} from "../../src/interfaces/ICascadeBridge.sol";
import {ISTAKING_ADDRESS, IStaking} from "../../src/interfaces/IStaking.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {VaultTestBase} from "../VaultTestBase.sol";

/// A rogue adapter with flash capital: delivers a forged batch whose deposit is its own borrowed TAO,
/// then redeems its fresh shares directly in the same transaction.
contract FlashAdapter is ICascadeBridge {
    CascadeVault immutable vault;

    constructor(CascadeVault v) {
        vault = v;
    }

    function send(uint64, address, bytes calldata, uint256) external payable {}

    function quoteFee(uint64, address, bytes calldata, uint256) external pure returns (uint256) {
        return 0;
    }

    function attack(uint64 chain, address door, bytes calldata message, uint256 amount) external {
        vault.onBridgeMessage{value: amount}(chain, door, message, amount);
        vault.redeemDirect(vault.balanceOf(address(this)));
    }

    /// Two deliveries in one transaction: a deposit-only batch of borrowed TAO first, so the gross
    /// before the second (redeem-only) delivery's deposits already holds it, then the redeems, then the
    /// capital back out with redeemDirect.
    function attackSplit(uint64 chain, address door, bytes calldata deposits, uint256 amount, bytes calldata redeems)
        external
    {
        vault.onBridgeMessage{value: amount}(chain, door, deposits, amount);
        vault.onBridgeMessage(chain, door, redeems, 0);
        vault.redeemDirect(vault.balanceOf(address(this)));
    }

    function deliver(uint64 chain, address door, bytes calldata message, uint256 amount) external {
        vault.onBridgeMessage{value: amount}(chain, door, message, amount);
    }

    function exit() external {
        vault.redeemDirect(vault.balanceOf(address(this)));
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
        emit CascadeVault.BatchDelivered(key, BASE, frontDoor, 1, 20e18);
        // A = 0, S = 0 for both entries: 10e18 * (0 + 1e6) / (0 + 1) = 1e25
        vm.expectEmit(address(vault));
        emit CascadeVault.Deposited(key, alice, 10e18, 1e25);
        vm.expectEmit(address(vault));
        emit CascadeVault.Deposited(key, bob, 10e18, 1e25);
        assertEq(deliver(BASE, frontDoor, 1, d, noEntries()), key);

        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(vault.balanceOf(bob), 1e25);
        assertEq(vault.totalSupply(), 2e25);
        assertEq(vault.grossAssets(), 20e18);
    }

    function test_delivery_secondBatchPricesAgainstExistingAssets() public {
        deliver(BASE, frontDoor, 1, entries2(alice, 10e18, bob, 10e18), noEntries());

        // A = 25e18 - 5e18 = 20e18, S = 2e25: 5e18 * (2e25 + 1e6) / (20e18 + 1) = 5e24 exactly
        bytes32 key = keyOf(BASE, frontDoor, 2, entries1(bob, 5e18), noEntries());
        vm.expectEmit(address(vault));
        emit CascadeVault.Deposited(key, bob, 5e18, 5e24);
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
        emit CascadeVault.Deposited(key, alice, 10e18, 1e25);
        vm.expectEmit(address(vault));
        emit CascadeVault.Deposited(key, bob, 4_999_999_999_000_000_000, 4_999_999_999_000_000_000_000_000);
        deliver(BASE, frontDoor, 1, d, noEntries());

        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(vault.balanceOf(bob), 4_999_999_999_000_000_000_000_000);
        // the floored 1e9 stays in the vault
        assertEq(vault.grossAssets(), 15e18);
    }

    function test_delivery_zeroAddressDepositSkipped() public {
        bytes32 key = keyOf(BASE, frontDoor, 1, entries1(address(0), 1e18), noEntries());

        vm.expectEmit(address(vault));
        emit CascadeVault.DepositSkipped(key, address(0), 1e18);
        deliver(BASE, frontDoor, 1, entries1(address(0), 1e18), noEntries());

        assertEq(vault.totalSupply(), 0);
        assertEq(vault.grossAssets(), 1e18);
        assertTrue(vault.processed(key));
    }

    // ---- guards ----

    function test_delivery_notBridgeReverts() public {
        bytes memory m = CascadeMessages.encodeBatch(1, entries1(alice, 1e18), noEntries());

        vm.deal(stranger, 1e18);
        vm.prank(stranger);
        vm.expectRevert(CascadeBase.NotBridge.selector);
        vault.onBridgeMessage{value: 1e18}(BASE, frontDoor, m, 1e18);

        // a disabled bridge is no longer a bridge
        vm.prank(guardian);
        vault.disableBridge(address(bridge));
        vm.expectRevert(CascadeBase.NotBridge.selector);
        rawDeliver(BASE, frontDoor, m, 1e18, 1e18);
    }

    function test_delivery_unknownPeerReverts() public {
        bytes memory m = CascadeMessages.encodeBatch(1, entries1(alice, 1e18), noEntries());

        vm.expectRevert(CascadeVault.UnknownPeer.selector);
        rawDeliver(BASE, bob, m, 1e18, 1e18);
        // the registered address on another chain is another peer
        vm.expectRevert(CascadeVault.UnknownPeer.selector);
        rawDeliver(BITTENSOR, frontDoor, m, 1e18, 1e18);

        vm.prank(guardian);
        vault.removeFrontDoor(BASE, frontDoor);
        vm.expectRevert(CascadeVault.UnknownPeer.selector);
        rawDeliver(BASE, frontDoor, m, 1e18, 1e18);
    }

    function test_delivery_valueMismatchReverts() public {
        bytes memory m = CascadeMessages.encodeBatch(1, entries1(alice, 1e18), noEntries());

        vm.expectRevert(CascadeVault.ValueMismatch.selector);
        rawDeliver(BASE, frontDoor, m, 1e18, 1e18 - 1);
        vm.expectRevert(CascadeVault.ValueMismatch.selector);
        rawDeliver(BASE, frontDoor, m, 1e18, 1e18 + 1);
    }

    function test_delivery_amountMismatchReverts() public {
        bytes memory m = CascadeMessages.encodeBatch(1, entries1(alice, 1e18), noEntries());
        vm.expectRevert(CascadeVault.AmountMismatch.selector);
        rawDeliver(BASE, frontDoor, m, 2e18, 2e18);

        // value on a redeem-only batch is a mismatch too
        bytes memory r = CascadeMessages.encodeBatch(2, noEntries(), entries1(alice, 1e24));
        vm.expectRevert(CascadeVault.AmountMismatch.selector);
        rawDeliver(BASE, frontDoor, r, 1e9, 1e9);
    }

    function test_delivery_exactReplayRejected() public {
        deliver(BASE, frontDoor, 1, entries1(alice, 10e18), noEntries());

        vm.expectRevert(CascadeVault.DuplicateBatch.selector);
        deliver(BASE, frontDoor, 1, entries1(alice, 10e18), noEntries());

        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(vault.grossAssets(), 10e18);
    }

    function test_delivery_forgedBatchIdDoesNotBlockRealOne() public {
        // A forged batch carries the honest front door's next batchId with other entries.
        bytes32 forged = deliver(BASE, frontDoor, 5, entries1(bob, 1e18), noEntries());
        bytes32 real = deliver(BASE, frontDoor, 5, entries1(alice, 10e18), noEntries());

        assertTrue(forged != real);
        assertTrue(vault.processed(forged));
        assertTrue(vault.processed(real));
        // bob: 1e18 * 1e6 = 1e24; alice at A = 1e18, S = 1e24: 10e18 * (1e24 + 1e6) / (1e18 + 1) = 1e25
        assertEq(vault.balanceOf(bob), 1e24);
        assertEq(vault.balanceOf(alice), 1e25);
    }

    function test_delivery_depositOnlyBatchRecordedWithoutPayout() public {
        bytes32 key = depositVia(alice, 10e18);

        assertTrue(vault.processed(key));
        CascadeVault.PayoutBatch memory b = vault.getPayoutBatch(key);
        assertEq(b.count, 0);
        assertEq(b.remaining, 0);
        assertEq(b.queuedAt, 0);
        assertEq(vault.pendingPayouts(), 0);
    }

    // ---- redeems ----

    function test_delivery_redeemOnlyBatchWithZeroValue() public {
        depositVia(alice, 10e18);

        bytes32 key = keyOf(BASE, frontDoor, 2, noEntries(), entries1(alice, 5e24));
        vm.expectEmit(address(vault));
        emit CascadeVault.BatchDelivered(key, BASE, frontDoor, 2, 0);
        // A = 10e18, S = 1e25: 5e24 * (10e18 + 1) / (1e25 + 1e6) = 5e18 exactly
        vm.expectEmit(address(vault));
        emit CascadeVault.Redeemed(key, alice, 5e24, 5e18);
        // price = (10e18 + 1) * 1e18 / (1e25 + 1e6) = 1e12 exactly
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutBatchQueued(key, BASE, 2, 1, 5e18, 1e12);
        deliver(BASE, frontDoor, 2, noEntries(), entries1(alice, 5e24));

        assertEq(vault.balanceOf(alice), 5e24);
        assertEq(vault.pendingPayouts(), 5e18);
        CascadeVault.PayoutBatch memory b = vault.getPayoutBatch(key);
        assertEq(b.sourceChain, BASE);
        assertEq(b.frontDoor, frontDoor);
        assertEq(b.batchId, 2);
        assertEq(b.queuedAt, block.timestamp);
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
        emit CascadeVault.Redeemed(key, alice, 1e25, 10e18);
        redeemVia(alice, 2e25);

        assertEq(vault.balanceOf(alice), 0);
        assertEq(vault.pendingPayouts(), 10e18);
    }

    function test_delivery_redeemClippedToMaxEntryValue() public {
        vm.prank(owner);
        vault.setMessageLimits(2e18, 4_000e18, 10);
        depositVia(alice, 10e18);

        // sMax = 2e18 * (1e25 + 1e6) / (10e18 + 1) = 2e24; 2e24 * (10e18 + 1) / (1e25 + 1e6) = 2e18
        bytes32 key = nextRedeemKey(alice, 1e25);
        vm.expectEmit(address(vault));
        emit CascadeVault.Redeemed(key, alice, 2e24, 2e18);
        redeemVia(alice, 1e25);

        assertEq(vault.balanceOf(alice), 8e24);
        assertEq(vault.pendingPayouts(), 2e18);
    }

    /// Stakes the vault's idle TAO as the keeper (exact reads) and lets a day pass, so all of it has
    /// ramped into the allowance base.
    function stakeAndRamp() internal {
        staking.setOneRaoShort(false);
        vm.prank(keeper);
        vault.stakeIdle();
        vm.warp(block.timestamp + 1 days);
    }

    function test_delivery_redeemClippedToPeerAllowanceThenDeferred() public {
        depositVia(alice, 1_000e18);
        stakeAndRamp();
        bytes32 peer = vault.peerId(BASE, frontDoor);
        uint256 t0 = block.timestamp;

        // allowance = max(1_000e18 staked * 2000 / 10000, 100e18) = 200e18;
        // sMax = 200e18 * (1e27 + 1e6) / (1_000e18 + 1) = 2e26; 2e26 * (1_000e18 + 1) / (1e27 + 1e6) = 200e18
        bytes32 key = nextRedeemKey(alice, 1e27);
        vm.expectEmit(address(vault));
        emit CascadeVault.Redeemed(key, alice, 2e26, 200e18);
        redeemVia(alice, 1e27);
        (uint64 start, uint256 burned) = vault.burnWindows(peer);
        assertEq(start, t0);
        assertEq(burned, 200e18);

        // the window's allowance is spent: nothing burned, the request is deferred
        key = nextRedeemKey(alice, 1e27);
        vm.expectEmit(address(vault));
        emit CascadeVault.RedeemDeferred(key, alice, 1e27);
        redeemVia(alice, 1e27);
        assertTrue(vault.processed(key));
        assertEq(vault.getPayoutBatch(key).count, 0);

        vm.warp(t0 + 24 hours - 1);
        key = nextRedeemKey(alice, 1e27);
        vm.expectEmit(address(vault));
        emit CascadeVault.RedeemDeferred(key, alice, 1e27);
        redeemVia(alice, 1e27);
        assertEq(vault.balanceOf(alice), 8e26);
        assertEq(vault.pendingPayouts(), 200e18);

        // New window; the stake still holds the reserved 200e18 (not paid out yet), so the allowance is
        // 200e18 again.
        // A = 1_000e18 - 200e18 = 800e18, S = 8e26: sMax = 200e18 * (8e26 + 1e6) / (800e18 + 1) = 2e26;
        // 2e26 * (800e18 + 1) / (8e26 + 1e6) = 200e18
        vm.warp(t0 + 24 hours);
        key = nextRedeemKey(alice, 1e27);
        vm.expectEmit(address(vault));
        emit CascadeVault.Redeemed(key, alice, 2e26, 200e18);
        redeemVia(alice, 1e27);
        (start, burned) = vault.burnWindows(peer);
        assertEq(start, t0 + 24 hours);
        assertEq(burned, 200e18);
        assertEq(vault.balanceOf(alice), 6e26);
        assertEq(vault.pendingPayouts(), 400e18);
    }

    function test_delivery_allowanceOnPreDeliveryGrossDefeatsFlashDeposit() public {
        staking.setOneRaoShort(false);
        // alice holds 1e27 shares worth 1_000e18, all staked on HK1
        depositVia(alice, 1_000e18);
        vm.prank(keeper);
        vault.stakeIdle();

        FlashAdapter adapter = new FlashAdapter(vault);
        vm.startPrank(owner);
        vault.proposeBridge(address(adapter));
        vm.warp(block.timestamp + 7 days);
        vault.activateBridge(address(adapter));
        vm.stopPrank();

        // A forged batch deposits 4_000e18 of flash capital to the adapter and redeems alice in full.
        // The allowance is on the gross before the deposit: max(1_000e18 * 20%, 100e18) = 200e18 (on the
        // post-delivery gross of 5_000e18 it would be 1_000e18, the whole of alice).
        // A = 1_000e18, S = 1e27: the adapter gets 4_000e18 * (1e27 + 1e6) / (1_000e18 + 1) = 4e27 shares;
        // alice's sMax = 200e18 * (1e27 + 1e6) / (1_000e18 + 1) = 2e26 → 200e18
        uint256 flash = 4_000e18;
        vm.deal(address(adapter), flash);
        bytes memory message =
            CascadeMessages.encodeBatch(77, entries1(address(adapter), flash), entries1(alice, type(uint256).max));
        bytes32 key = vault.batchKey(BASE, frontDoor, message);
        vm.expectEmit(address(vault));
        emit CascadeVault.Deposited(key, address(adapter), flash, 4e27);
        vm.expectEmit(address(vault));
        emit CascadeVault.Redeemed(key, alice, 2e26, 200e18);
        // the adapter's same-transaction redeemDirect: assets 5_000e18 - 200e18 pending, S = 4.8e27:
        // 4e27 * (4_800e18 + 1) / (4.8e27 + 1e6) = 4_000e18, no more than it deposited
        vm.expectEmit(address(vault));
        emit CascadeVault.RedeemedDirect(address(adapter), 4e27, flash);
        adapter.attack(BASE, frontDoor, message, flash);

        assertEq(vault.balanceOf(alice), 8e26);
        assertEq(vault.pendingPayouts(), 200e18);
        (, uint256 burned) = vault.burnWindows(vault.peerId(BASE, frontDoor));
        assertLe(burned, 200e18);
        assertEq(vault.balanceOf(address(adapter)), 0);
        assertLe(address(adapter).balance, flash);
        // alice's remaining 8e26 shares are still worth 800e18
        assertEq(vault.totalAssets(), 800e18);
    }

    /// alice holds 1e27 shares worth 1_000e18, staked on HK1 more than a day ago, and a FlashAdapter is an
    /// enabled bridge.
    function flashSetup() internal returns (FlashAdapter adapter) {
        staking.setOneRaoShort(false);
        depositVia(alice, 1_000e18);
        vm.prank(keeper);
        vault.stakeIdle();
        adapter = new FlashAdapter(vault);
        vm.startPrank(owner);
        vault.proposeBridge(address(adapter));
        vm.warp(block.timestamp + 7 days);
        vault.activateBridge(address(adapter));
        vm.stopPrank();
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
        bytes32 key = vault.batchKey(BASE, frontDoor, redeems);

        // the deposit mints 4e27 at A = 1_000e18, S = 1e27; the redeems price at A = 5_000e18, S = 5e27:
        // sMax = 200e18 * (5e27 + 1e6) / (5_000e18 + 1) = 2e26 → 200e18
        vm.expectEmit(address(vault));
        emit CascadeVault.Redeemed(key, alice, 2e26, 200e18);
        // assets 5_000e18 - 200e18 pending, S = 4.8e27: 4e27 * (4_800e18 + 1) / (4.8e27 + 1e6) = 4_000e18
        vm.expectEmit(address(vault));
        emit CascadeVault.RedeemedDirect(address(adapter), 4e27, flash);
        adapter.attackSplit(BASE, frontDoor, deposits, flash, redeems);

        assertEq(vault.balanceOf(alice), 8e26);
        assertEq(vault.pendingPayouts(), 200e18);
        (, uint256 burned) = vault.burnWindows(vault.peerId(BASE, frontDoor));
        assertEq(burned, 200e18);
        assertEq(vault.balanceOf(address(adapter)), 0);
        assertEq(address(adapter).balance, flash);
        assertEq(vault.totalAssets(), 800e18);
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
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == CascadeVault.Redeemed.selector) {
                (, out) = abi.decode(logs[i].data, (uint256, uint256));
            }
        }
    }

    /// The same capital a block earlier: still liquid, which the base never counts. Priced at
    /// A = 5_000e18, S = 5e27: sMax = 200e18 * (5e27 + 1e6) / (5_000e18 + 1) = 2e26 → 200e18.
    function test_delivery_capitalFromEarlierBlockDoesNotRaiseAllowance() public {
        FlashAdapter adapter = flashSetup();
        flashDeposit(adapter, 4_000e18);
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 12);

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
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 12);
        vm.prank(keeper);
        vault.stakeIdle();
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 12);

        uint256 out = redeemAliceVia(adapter);
        assertEq(out, 200_111_111_111_000_000_000);
        (, uint256 burned) = vault.burnWindows(vault.peerId(BASE, frontDoor));
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
        vm.warp(block.timestamp + 12 hours);
        assertEq(redeemAliceVia(adapter), 600e18);
        // a new window a day after the stake: base 5_000e18 less nothing, and alice's other 400e18 burn
        vm.warp(block.timestamp + 24 hours);
        assertEq(redeemAliceVia(adapter), 400e18);
        assertEq(vault.balanceOf(alice), 0);
    }

    function test_delivery_minDailyOutflowFloor() public {
        depositVia(alice, 10e18);

        // 10e18 * 2000 / 10000 = 2e18 < 100e18 floor, so all 10e18 may leave
        bytes32 key = nextRedeemKey(alice, 1e25);
        vm.expectEmit(address(vault));
        emit CascadeVault.Redeemed(key, alice, 1e25, 10e18);
        redeemVia(alice, 1e25);

        (, uint256 burned) = vault.burnWindows(vault.peerId(BASE, frontDoor));
        assertEq(burned, 10e18);
        assertEq(vault.pendingPayouts(), 10e18);
    }

    /// Liquid TAO is not in the allowance base: deposits the keeper has not staked yet (a new vault) and
    /// a direct deposit leave the front door the minDailyOutflow floor, here 100e18 of alice's 1_000e18.
    function test_delivery_liquidTaoNotInAllowanceBase() public {
        depositVia(alice, 1_000e18);
        vm.prank(owner);
        vault.setMaxTotalAssets(10_000e18);
        // A = 1_000e18, S = 1e27: 4_000e18 * (1e27 + 1e6) / (1_000e18 + 1) = 4e27
        depositDirect(carol, 4_000e18);

        // A = 5_000e18, S = 5e27, allowance max(0, 100e18): sMax = 100e18 * (5e27 + 1e6) / (5_000e18 + 1) =
        // 1e26 → 100e18
        bytes32 key = nextRedeemKey(alice, 1e27);
        vm.expectEmit(address(vault));
        emit CascadeVault.Redeemed(key, alice, 1e26, 100e18);
        redeemVia(alice, 1e27);
    }

    /// A redeem worth less than 0.01 TAO is deferred, not burned: once it paid its share of the payout fee
    /// it could fall below the bridge's conversion floor (0.002 TAO), and then processPayouts would revert
    /// for its chunk every time. That holds however it got small: asked small, clipped to a small balance,
    /// or clipped to the last sliver of the window's allowance. The price stays exactly 1e-6 TAO per share
    /// throughout (A * 1e6 == S), so s shares are worth s / 1e6.
    function test_delivery_redeemBelowMinimumDeferred() public {
        depositVia(alice, 1_000e18);
        // A = 1_000e18, S = 1e27: 0.005e18 * (1e27 + 1e6) / (1_000e18 + 1) = 5e21
        depositVia(bob, 0.005e18);
        assertEq(vault.balanceOf(bob), 5e21);

        // asked small (9.999e21 shares, 0.009999 TAO), and clipped to bob's 5e21 (0.005 TAO)
        bytes32 key = keyOf(BASE, frontDoor, 3, noEntries(), entries2(alice, 9.999e21, bob, 1e25));
        vm.expectEmit(address(vault));
        emit CascadeVault.RedeemDeferred(key, alice, 9.999e21);
        vm.expectEmit(address(vault));
        emit CascadeVault.RedeemDeferred(key, bob, 1e25);
        deliver(BASE, frontDoor, 3, noEntries(), entries2(alice, 9.999e21, bob, 1e25));
        assertEq(vault.getPayoutBatch(key).count, 0);
        assertEq(vault.balanceOf(alice), 1e27);
        assertEq(vault.balanceOf(bob), 5e21);
        (uint64 start,) = vault.burnWindows(vault.peerId(BASE, frontDoor));
        assertEq(start, 0);

        // exactly 0.01 TAO burns
        key = keyOf(BASE, frontDoor, 4, noEntries(), entries1(alice, 1e22));
        vm.expectEmit(address(vault));
        emit CascadeVault.Redeemed(key, alice, 1e22, 0.01e18);
        deliver(BASE, frontDoor, 4, noEntries(), entries1(alice, 1e22));

        // the allowance is the 100e18 floor (nothing staked): 99.985e18 more leaves 0.005e18 of it, and a
        // 1-TAO request clipped to that sliver is deferred
        deliver(BASE, frontDoor, 5, noEntries(), entries1(alice, 99.985e24));
        key = keyOf(BASE, frontDoor, 6, noEntries(), entries1(alice, 1e24));
        vm.expectEmit(address(vault));
        emit CascadeVault.RedeemDeferred(key, alice, 1e24);
        deliver(BASE, frontDoor, 6, noEntries(), entries1(alice, 1e24));

        (, uint256 burned) = vault.burnWindows(vault.peerId(BASE, frontDoor));
        assertEq(burned, 99.995e18);
        assertEq(vault.pendingPayouts(), 99.995e18);
        assertEq(vault.balanceOf(alice), 1e27 - 99.995e24);
    }

    function test_delivery_directOnlySkippedUntilOptIn() public {
        depositVia(alice, 10e18);
        // A = 10e18, S = 1e25: 10e18 * (1e25 + 1e6) / (10e18 + 1) = 1e25
        depositDirect(alice, 10e18);
        assertTrue(vault.directOnly(alice));
        assertEq(vault.balanceOf(alice), 2e25);

        bytes32 key = nextRedeemKey(alice, 5e24);
        vm.expectEmit(address(vault));
        emit CascadeVault.RedeemSkipped(key, alice, 5e24);
        redeemVia(alice, 5e24);
        assertEq(vault.balanceOf(alice), 2e25);
        assertEq(vault.pendingPayouts(), 0);
        assertTrue(vault.processed(key));

        vm.prank(alice);
        vault.allowFrontDoorRedeems();

        // A = 20e18, S = 2e25: 5e24 * (20e18 + 1) / (2e25 + 1e6) = 5e18
        key = nextRedeemKey(alice, 5e24);
        vm.expectEmit(address(vault));
        emit CascadeVault.Redeemed(key, alice, 5e24, 5e18);
        redeemVia(alice, 5e24);
        assertEq(vault.balanceOf(alice), 15e24);
        assertEq(vault.pendingPayouts(), 5e18);
    }

    function test_delivery_sameUserDepositAndRedeemInOneBatch() public {
        CascadeMessages.Entry[] memory d = entries1(alice, 10e18);
        CascadeMessages.Entry[] memory r = entries1(alice, 5e24);
        bytes32 key = keyOf(BASE, frontDoor, 1, d, r);

        // A = 0, S = 0 for both: mint 10e18 * 1e6 = 1e25; redeem 5e24 * 1 / 1e6 = 5e18;
        // price = (0 + 1) * 1e18 / (0 + 1e6) = 1e12
        vm.expectEmit(address(vault));
        emit CascadeVault.Deposited(key, alice, 10e18, 1e25);
        vm.expectEmit(address(vault));
        emit CascadeVault.Redeemed(key, alice, 5e24, 5e18);
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutBatchQueued(key, BASE, 1, 1, 5e18, 1e12);
        deliver(BASE, frontDoor, 1, d, r);

        assertEq(vault.balanceOf(alice), 5e24);
        assertEq(vault.totalSupply(), 5e24);
        assertEq(vault.pendingPayouts(), 5e18);
    }

    function test_delivery_runningHashOverPayoutTriples() public {
        deliver(BASE, frontDoor, 1, entries2(alice, 10e18, bob, 10e18), noEntries());

        // A = 20e18, S = 2e25: alice 5e24 → 5e18; bob 2e24 * (20e18 + 1) / (2e25 + 1e6) = 2e18
        bytes32 key = deliver(BASE, frontDoor, 2, noEntries(), entries2(alice, 5e24, bob, 2e24));

        CascadeVault.PayoutBatch memory b = vault.getPayoutBatch(key);
        bytes32 h1 = keccak256(abi.encode(bytes32(0), alice, uint256(5e24), uint256(5e18)));
        assertEq(b.payoutsHash, keccak256(abi.encode(h1, bob, uint256(2e24), uint256(2e18))));
        assertEq(b.count, 2);
        assertEq(b.remaining, 7e18);
        assertEq(vault.pendingPayouts(), 7e18);
    }

    // ---- accounting ----

    function test_delivery_pendingPayoutsExcludedFromTotalAssets() public {
        depositVia(alice, 10e18);
        redeemVia(alice, 5e24);

        assertEq(vault.pendingPayouts(), 5e18);
        assertEq(vault.grossAssets(), 10e18);
        assertEq(vault.totalAssets(), 10e18 - 5e18);
        // (5e18 + 1) * 1e18 / (5e24 + 1e6) = 1e12: the queued payout does not move the price
        assertEq(vault.price(), 1e12);
    }

    function test_delivery_doesNotStake() public {
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeWithSelector(IStaking.addStake.selector), 0);
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeWithSelector(IStaking.claimRootWithHotkey.selector), 0);
        deliver(BASE, frontDoor, 1, entries2(alice, 10e18, bob, 5e18), noEntries());

        assertEq(vault.rootStakeRao(), 0);
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
        vm.expectRevert(CascadeBase.NotBridge.selector);
        vault.onBridgeMessage{value: 10e18}(BASE, frontDoor, m, 10e18);

        vm.expectRevert(Pausable.EnforcedPause.selector);
        deliver(BASE, frontDoor, 1, entries1(alice, 10e18), noEntries());

        vm.prank(owner);
        vault.unpause();
        bytes32 key = deliver(BASE, frontDoor, 1, entries1(alice, 10e18), noEntries());
        assertTrue(vault.processed(key));
        assertEq(vault.balanceOf(alice), 1e25);
    }

    function test_delivery_acceptsMaxEntries() public {
        // 100 holders deposit 10e18 each at A = 0, S = 0: 1e25 each; gross 1_000e18
        CascadeMessages.Entry[] memory holders = new CascadeMessages.Entry[](100);
        for (uint256 i; i < 100; ++i) {
            holders[i] = CascadeMessages.Entry(addr(0x2000 + i), 10e18);
        }
        deliver(BASE, frontDoor, 1, holders, noEntries());

        CascadeMessages.Entry[] memory d = new CascadeMessages.Entry[](100);
        CascadeMessages.Entry[] memory r = new CascadeMessages.Entry[](100);
        for (uint256 i; i < 100; ++i) {
            d[i] = CascadeMessages.Entry(addr(0x1000 + i), 1e18);
            r[i] = CascadeMessages.Entry(addr(0x2000 + i), 1e24);
        }
        // A = 1_100e18 - 100e18 = 1_000e18, S = 1e27: deposit 1e18 * (1e27 + 1e6) / (1_000e18 + 1) = 1e24;
        // redeem 1e24 * (1_000e18 + 1) / (1e27 + 1e6) = 1e18; the allowance, 20% of the 1_000e18 gross
        // before this delivery's deposits = 200e18, covers 100e18
        bytes32 key = deliver(BASE, frontDoor, 2, d, r);

        assertTrue(vault.processed(key));
        CascadeVault.PayoutBatch memory b = vault.getPayoutBatch(key);
        assertEq(b.count, 100);
        assertEq(b.remaining, 100e18);
        assertEq(vault.pendingPayouts(), 100e18);
        assertEq(vault.balanceOf(addr(0x1000)), 1e24);
        assertEq(vault.balanceOf(addr(0x1063)), 1e24);
        assertEq(vault.balanceOf(addr(0x2000)), 9e24);
        assertEq(vault.balanceOf(addr(0x2063)), 9e24);
    }

    function test_delivery_secondFrontDoorHasOwnAllowance() public {
        address fd2 = makeAddr("frontDoor2");
        registerFrontDoor(4663, fd2);
        deliver(BASE, frontDoor, 1, entries2(alice, 500e18, bob, 500e18), noEntries());
        stakeAndRamp();

        // fd1: A = 1_000e18, S = 1e27, allowance 200e18 of the 1_000e18 staked: sMax = 2e26 → 200e18
        bytes32 k1 = keyOf(BASE, frontDoor, 2, noEntries(), entries1(alice, 5e26));
        vm.expectEmit(address(vault));
        emit CascadeVault.Redeemed(k1, alice, 2e26, 200e18);
        deliver(BASE, frontDoor, 2, noEntries(), entries1(alice, 5e26));

        // fd2: A = 800e18, S = 8e26, its own allowance 200e18 on the 1_000e18 staked:
        // sMax = 200e18 * (8e26 + 1e6) / (800e18 + 1) = 2e26 → 200e18
        bytes32 k2 = keyOf(4663, fd2, 1, noEntries(), entries1(bob, 5e26));
        vm.expectEmit(address(vault));
        emit CascadeVault.Redeemed(k2, bob, 2e26, 200e18);
        deliver(4663, fd2, 1, noEntries(), entries1(bob, 5e26));

        assertEq(vault.pendingPayouts(), 400e18);
        (, uint256 burned1) = vault.burnWindows(vault.peerId(BASE, frontDoor));
        (, uint256 burned2) = vault.burnWindows(vault.peerId(4663, fd2));
        assertEq(burned1, 200e18);
        assertEq(burned2, 200e18);

        // fd1's window stays spent
        bytes32 k3 = keyOf(BASE, frontDoor, 3, noEntries(), entries1(alice, 1e26));
        vm.expectEmit(address(vault));
        emit CascadeVault.RedeemDeferred(k3, alice, 1e26);
        deliver(BASE, frontDoor, 3, noEntries(), entries1(alice, 1e26));
    }

    function test_stakeIdle_excludesPendingPayouts() public {
        depositVia(alice, 10e18);
        redeemVia(alice, 5e24);

        // idle = (1e12 + 10e18) - 1e12 - 5e18 = 5e18 = 5_000_000_000 rao; a fresh position reads one rao short
        vm.expectEmit(address(vault));
        emit CascadeVault.Staked(HK1, 5_000_000_000, 4_999_999_999);
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
        emit CascadeVault.DepositBounced(key, bob, 1e18);
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutBatchQueued(key, BASE, 2, 1, 1e18, 0);
        deliver(BASE, frontDoor, 2, entries1(bob, 1e18), noEntries());

        assertTrue(vault.processed(key));
        assertEq(vault.balanceOf(bob), 0);
        assertEq(vault.totalSupply(), 1e25);
        assertEq(vault.pendingPayouts(), 1e18);
        CascadeVault.PayoutBatch memory b = vault.getPayoutBatch(key);
        assertEq(b.count, 1);
        assertEq(b.remaining, 1e18);
        assertEq(b.payoutsHash, keccak256(abi.encode(bytes32(0), bob, uint256(0), uint256(1e18))));
        // a bounce is not a burn: the front door's window is untouched
        (uint64 start, uint256 burned) = vault.burnWindows(vault.peerId(BASE, frontDoor));
        assertEq(start, 0);
        assertEq(burned, 0);

        // once the state is repaired (alice's 10e18 back, bob's 1e18 still reserved) deposits mint again:
        // A = (12e18 - 1e18 pending) - 1e18 = 10e18, S = 1e25: 1e18 * (1e25 + 1e6) / (10e18 + 1) = 1e24
        vm.deal(address(vault), ED + 11e18);
        deliver(BASE, frontDoor, 3, entries1(bob, 1e18), noEntries());
        assertEq(vault.balanceOf(bob), 1e24);
        assertEq(vault.pendingPayouts(), 1e18);
    }

    function test_depositDirect_insolventVaultReverts() public {
        depositVia(alice, 10e18);
        vm.deal(address(vault), 0);

        vm.expectRevert(CascadeVault.VaultInsolvent.selector);
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
        emit CascadeVault.DepositBounced(key, bob, 1e18);
        deliver(BASE, frontDoor, 2, entries1(bob, 1e18), noEntries());
        assertEq(vault.balanceOf(bob), 0);
        assertEq(vault.pendingPayouts(), 1e18);
        vm.expectRevert(CascadeVault.VaultInsolvent.selector);
        depositDirect(bob, 1e18);
        assertEq(vault.totalSupply(), 1e25);
        // the bounced 1e18 is reserved, so the price is where the loss left it
        assertEq(vault.totalAssets(), 4e18);
    }

    function test_delivery_redeemOnlyBatchDeliversInInsolventVault() public {
        depositVia(alice, 10e18);
        // 60% of the assets lost: 4e18 left against a supply of 1e25, below half the launch price
        vm.deal(address(vault), ED + 4e18);

        // a redeem-only batch still delivers, at the lowered price: A = 4e18, S = 1e25,
        // 5e24 * (4e18 + 1) / (1e25 + 1e6) = 2e18; allowance max(4e18 * 20%, 100e18) = 100e18
        bytes32 key = nextRedeemKey(alice, 5e24);
        vm.expectEmit(address(vault));
        emit CascadeVault.Redeemed(key, alice, 5e24, 2e18);
        redeemVia(alice, 5e24);
        assertEq(vault.balanceOf(alice), 5e24);
        assertEq(vault.pendingPayouts(), 2e18);
    }

    /// A griefer's minimum deposit sits in the same batch as alice's exit: the deposit bounces and the
    /// exit still burns. The queue lists deposits first, then redeems, and pays out like any batch.
    function test_delivery_insolventVaultBouncesDepositsAndStillRedeems() public {
        depositVia(alice, 10e18);
        // 60% of the assets lost: 4e18 left against a supply of 1e25
        vm.deal(address(vault), ED + 4e18);
        uint256 t0 = block.timestamp;

        // A = 4e18, S = 1e25 (insolvent): bob bounces; alice 5e24 * (4e18 + 1) / (1e25 + 1e6) = 2e18;
        // price = (4e18 + 1) * 1e18 / (1e25 + 1e6) = 4e11
        CascadeMessages.Entry[] memory d = entries1(bob, 1e18);
        CascadeMessages.Entry[] memory r = entries1(alice, 5e24);
        bytes32 key = keyOf(BASE, frontDoor, 2, d, r);
        vm.expectEmit(address(vault));
        emit CascadeVault.DepositBounced(key, bob, 1e18);
        vm.expectEmit(address(vault));
        emit CascadeVault.Redeemed(key, alice, 5e24, 2e18);
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutBatchQueued(key, BASE, 2, 2, 3e18, 4e11);
        deliver(BASE, frontDoor, 2, d, r);

        assertEq(vault.balanceOf(bob), 0);
        assertEq(vault.balanceOf(alice), 5e24);
        assertEq(vault.totalSupply(), 5e24);
        CascadeVault.PayoutBatch memory b = vault.getPayoutBatch(key);
        assertEq(b.count, 2);
        assertEq(b.remaining, 3e18);
        bytes32 h1 = keccak256(abi.encode(bytes32(0), bob, uint256(0), uint256(1e18)));
        assertEq(b.payoutsHash, keccak256(abi.encode(h1, alice, uint256(5e24), uint256(2e18))));
        assertEq(vault.pendingPayouts(), 1e18 + 2e18);
        // only alice's burn counts against the window
        (, uint256 burned) = vault.burnWindows(vault.peerId(BASE, frontDoor));
        assertEq(burned, 2e18);

        // the list in delivery order: deposits first, then redeems
        CascadeMessages.Payout[] memory list = new CascadeMessages.Payout[](2);
        list[0] = CascadeMessages.Payout(bob, 0, 1e18);
        list[1] = CascadeMessages.Payout(alice, 5e24, 2e18);
        CascadeMessages.Payout[] memory swapped = new CascadeMessages.Payout[](2);
        swapped[0] = list[1];
        swapped[1] = list[0];
        vm.warp(t0 + 24 hours);
        vm.expectRevert(CascadeVault.PayoutsMismatch.selector);
        vault.processPayouts(key, swapped, 10);

        // sum 3e18, fee 1e15 pro rata: bob ceil(1e18 * 1e15 / 3e18) = 333_333_333_333_334 →
        // 999_666_666_666_666_666 floors to 999_666_666_000_000_000; alice ceil(2e18 * 1e15 / 3e18) =
        // 666_666_666_666_667 → 1_999_333_333_333_333_333 floors to 1_999_333_333_000_000_000.
        // The liquid 5e18 covers net + fee, so nothing is unstaked.
        vm.expectEmit(address(vault));
        emit CascadeVault.PayoutChunkSent(key, 0, 2, 3e18, 2_998_999_999_000_000_000, 1e15);
        vault.processPayouts(key, list, 10);

        CascadeMessages.Entry[] memory sent = entries2(bob, 999_666_666_000_000_000, alice, 1_999_333_333_000_000_000);
        assertEq(bridge.lastMessage(), CascadeMessages.encodePayouts(key, 0, sent));
        assertEq(bridge.lastAmount(), 2_998_999_999_000_000_000);
        assertEq(bridge.lastValue(), 2_998_999_999_000_000_000 + 1e15);
        assertEq(bridge.lastRecipient(), frontDoor);
        assertEq(vault.pendingPayouts(), 0);
        assertEq(vault.getPayoutBatch(key).count, 0);
        assertEq(address(vault).balance, ED + 5e18 - 2_999_999_999_000_000_000);
    }

    /// A cancel re-mints each unsent entry's shares; a bounced deposit has none, so its TAO is released
    /// into the vault's assets instead of going back. The owner must process such a batch, not cancel it.
    function test_cancelPayoutBatch_bouncedDepositStaysInVault() public {
        depositVia(alice, 10e18);
        vm.deal(address(vault), ED + 4e18);
        bytes32 key = deliver(BASE, frontDoor, 2, entries1(bob, 1e18), entries1(alice, 5e24));
        CascadeMessages.Payout[] memory list = new CascadeMessages.Payout[](2);
        list[0] = CascadeMessages.Payout(bob, 0, 1e18);
        list[1] = CascadeMessages.Payout(alice, 5e24, 2e18);

        vm.expectEmit(address(vault));
        emit CascadeVault.RedeemReversed(key, bob, 0, 1e18);
        vm.expectEmit(address(vault));
        emit CascadeVault.RedeemReversed(key, alice, 5e24, 2e18);
        vm.prank(owner);
        vault.cancelPayoutBatch(key, list);

        assertEq(vault.balanceOf(bob), 0);
        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(vault.pendingPayouts(), 0);
        // gross 5e18, nothing reserved: bob's 1e18 now backs alice's shares
        assertEq(vault.totalAssets(), 5e18);
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
