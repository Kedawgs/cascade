// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeVault} from "../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../src/CascadeFrontDoor.sol";
import {ISTAKING_ADDRESS} from "../src/interfaces/IStaking.sol";
import {ADDRESS_MAPPING_ADDRESS} from "../src/interfaces/IAddressMapping.sol";
import {CascadeMessages} from "../src/libraries/CascadeMessages.sol";
import {MockStaking} from "./mocks/MockStaking.sol";
import {MockAddressMapping} from "./mocks/MockAddressMapping.sol";
import {MockBridge} from "./mocks/MockBridge.sol";
import {MockTAO} from "./mocks/MockTAO.sol";
import {mirror} from "./mocks/Mirror.sol";

/// @notice Both chains in one EVM: the vault on BITTENSOR (native TAO) and a front door on BASE
/// (bridged TAO), connected by the chain-aware MockBridge, which delivers inside the sender's
/// transaction. Exact stake reads; bridge fee 1e15 both ways; redeem-request fee 1e14. alice and bob
/// each hold 1_000 TAO on Base (approved to fd) and 1 ether; the keeper closes batches and pays the fee.
contract EndToEndTest is Test {
    uint64 constant BASE = 8453;
    uint64 constant BITTENSOR = 964;
    uint64 constant CHAIN2 = 4663;
    bytes32 constant HK1 = bytes32(uint256(1));
    uint256 constant ED = 1e12;
    uint256 constant FEE = 1e15;
    uint256 constant REQUEST_FEE = 1e14;

    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    MockStaking staking = MockStaking(ISTAKING_ADDRESS);
    MockTAO tao;
    MockBridge bridge;
    CascadeVault vault;
    CascadeFrontDoor fd;

    function setUp() public {
        vm.etch(ISTAKING_ADDRESS, address(new MockStaking()).code);
        vm.etch(ADDRESS_MAPPING_ADDRESS, address(new MockAddressMapping()).code);
        staking.addHotkey(HK1);
        staking.setOneRaoShort(false);

        tao = new MockTAO(18);
        bridge = new MockBridge(tao);
        bridge.setFee(FEE);

        bytes32 expectedColdkey = mirror(vm.computeCreateAddress(address(this), vm.getNonce(address(this))));
        vault = new CascadeVault(expectedColdkey, HK1, bridge, owner, guardian, 1e15);
        // The operator funds the existential reserve before use.
        vm.deal(address(vault), ED);
        vm.prank(owner);
        vault.setKeeper(keeper);

        fd = newFrontDoor();
        bridge.connect(BITTENSOR, address(vault), true);
        bridge.connect(BASE, address(fd), false);
        registerFrontDoor(BASE, address(fd));

        address[2] memory users = [alice, bob];
        for (uint256 i; i < users.length; ++i) {
            tao.mint(users[i], 1_000e18);
            vm.prank(users[i]);
            tao.approve(address(fd), type(uint256).max);
            vm.deal(users[i], 1 ether);
        }
        vm.deal(keeper, 1 ether);
    }

    // ---- helpers ----

    function newFrontDoor() internal returns (CascadeFrontDoor) {
        return new CascadeFrontDoor(
            tao, bridge, BITTENSOR, address(vault), owner, guardian, 12 hours, 1e18, 10_000e18, REQUEST_FEE
        );
    }

    function registerFrontDoor(uint64 chain, address addr) internal {
        vm.prank(owner);
        vault.proposeFrontDoor(chain, addr);
        vm.warp(block.timestamp + 7 days);
        vm.prank(owner);
        vault.activateFrontDoor(chain, addr);
    }

    function depositVia(CascadeFrontDoor door, address user, uint256 amount) internal {
        vm.prank(user);
        door.deposit(amount);
    }

    /// A first request in the open batch, paying the redeem-request fee.
    function requestVia(CascadeFrontDoor door, address user, uint256 shares) internal {
        vm.prank(user);
        door.requestRedeem{value: REQUEST_FEE}(shares);
    }

    /// Closes `door`'s open batch, warping to its due time first if needed; the keeper tops the fee
    /// pot up with FEE and gets the rest back. The bridge delivers within the call.
    function close(CascadeFrontDoor door) internal {
        (, uint64 start,,,,) = door.openBatch();
        // test-controlled time
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < uint256(start) + 12 hours) vm.warp(uint256(start) + 12 hours);
        vm.prank(keeper);
        door.closeBatch{value: FEE}();
    }

    /// The batch key by its formula, independent of the vault.
    function keyOf(
        uint64 chain,
        address door,
        uint64 batchId,
        CascadeMessages.Entry[] memory deposits,
        CascadeMessages.Entry[] memory redeems
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(chain, door, keccak256(CascadeMessages.encodeBatch(batchId, deposits, redeems))));
    }

    function entries1(address user, uint256 amount) internal pure returns (CascadeMessages.Entry[] memory e) {
        e = new CascadeMessages.Entry[](1);
        e[0] = CascadeMessages.Entry(user, amount);
    }

    function noEntries() internal pure returns (CascadeMessages.Entry[] memory) {
        return new CascadeMessages.Entry[](0);
    }

    /// The vault's `sig` events for batch `key` (topic 1), in order.
    function vaultLogs(Vm.Log[] memory logs, bytes32 sig, bytes32 key) internal view returns (Vm.Log[] memory out) {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (isVaultLog(logs[i], sig, key)) ++n;
        }
        out = new Vm.Log[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (isVaultLog(logs[i], sig, key)) out[n++] = logs[i];
        }
    }

    function isVaultLog(Vm.Log memory log, bytes32 sig, bytes32 key) internal view returns (bool) {
        return log.emitter == address(vault) && log.topics.length > 1 && log.topics[0] == sig && log.topics[1] == key;
    }

    /// The keeper's view: batch `key`'s ordered payout list, rebuilt from the vault's Redeemed events.
    function redeemedList(Vm.Log[] memory logs, bytes32 key)
        internal
        view
        returns (CascadeMessages.Payout[] memory list)
    {
        Vm.Log[] memory r = vaultLogs(logs, CascadeVault.Redeemed.selector, key);
        list = new CascadeMessages.Payout[](r.length);
        for (uint256 i; i < r.length; ++i) {
            (uint256 shares, uint256 assets) = abi.decode(r[i].data, (uint256, uint256));
            // casting to 'uint160' is safe because the topic is an indexed address
            // forge-lint: disable-next-line(unsafe-typecast)
            list[i] = CascadeMessages.Payout(address(uint160(uint256(r[i].topics[2]))), shares, assets);
        }
    }

    /// The number of the bridge's DeliveryFailed events in `logs`, and the last one's fields.
    function failures(Vm.Log[] memory logs) internal view returns (uint256 n, uint256 index, bytes memory reason) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(bridge) && logs[i].topics[0] == MockBridge.DeliveryFailed.selector) {
                ++n;
                (index, reason) = abi.decode(logs[i].data, (uint256, bytes));
            }
        }
    }

    function assertPayout(CascadeMessages.Payout[] memory list, address user, uint256 shares, uint256 assets)
        internal
        pure
    {
        assertEq(list.length, 1, "entries");
        assertEq(list[0].user, user, "user");
        assertEq(list[0].shares, shares, "shares");
        assertEq(list[0].assets, assets, "assets");
    }

    // ---- flows ----

    function test_fullLifecycle() public {
        // Base → Bittensor: alice's 10 TAO arrives with the batch. A = 0, S = 0: 10e18 * (0 + 1e6) / (0 + 1) = 1e25
        depositVia(fd, alice, 10e18);
        close(fd);
        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(tao.balanceOf(address(fd)), 0);
        assertEq(fd.netForwarded(), 10e18);

        // the keeper stakes all but the reserve, then claims 1 TAO of rewards, which vests over 7 days
        vm.prank(keeper);
        vault.stakeIdle();
        assertEq(vault.rootStakeRao(), 10_000_000_000);
        staking.setUnclaimed(vault.coldkey(), HK1, 1_000_000_000);
        vm.prank(keeper);
        // claimRewards needs claimGasRequired (55M) left before the claim
        vault.claimRewards{gas: 60_000_000}(HK1);
        vm.warp(block.timestamp + 7 days);
        // 11_000_000_000 rao * 1e9 + ED - ED, nothing pending, nothing unvested
        assertEq(vault.totalAssets(), 11e18);

        // alice asks to redeem half; the keeper rebuilds the payout list from the delivery's events
        requestVia(fd, alice, 5e24);
        bytes32 key = keyOf(BASE, address(fd), 2, noEntries(), entries1(alice, 5e24));
        vm.recordLogs();
        close(fd);
        CascadeMessages.Payout[] memory list = redeemedList(vm.getRecordedLogs(), key);
        // A = 11e18, S = 1e25: 5e24 * (11e18 + 1) / (1e25 + 1e6) = 5_499_999_999_999_999_999, floored to rao
        assertPayout(list, alice, 5e24, 5_499_999_999_000_000_000);
        assertEq(vault.pendingPayouts(), 5_499_999_999_000_000_000);

        // Bittensor → Base after the payout delay: net = 5_499_999_999_000_000_000 - 1e15 fee
        vm.warp(block.timestamp + 24 hours);
        vm.prank(keeper);
        vault.processPayouts(key, list, 50);
        assertEq(fd.claimable(alice), 5_498_999_999_000_000_000);
        vm.prank(alice);
        fd.claim();

        // Base
        assertEq(tao.balanceOf(alice), 1_000e18 - 10e18 + 5_498_999_999_000_000_000);
        assertEq(fd.claimable(alice), 0);
        assertEq(fd.totalClaimable(), 0);
        assertEq(tao.balanceOf(address(fd)), 0);
        assertEq(fd.netForwarded(), 10e18 - 5_498_999_999_000_000_000);
        // Bittensor: net + fee = 5_499_999_999 rao unstaked from 11_000_000_000 and sent
        assertEq(vault.pendingPayouts(), 0);
        assertEq(vault.rootStakeRao(), 5_500_000_001);
        assertEq(address(vault).balance, ED);
        assertEq(vault.balanceOf(alice), 5e24);
        assertEq(vault.totalSupply(), 5e24);
        // the rao floor stayed in the vault: 11e18 - 5_499_999_999_000_000_000
        assertEq(vault.totalAssets(), 5_500_000_001_000_000_000);
        // the rail
        assertEq(bridge.pendingCount(), 0);
        assertEq(bridge.failedCount(), 0);
    }

    function test_secondFrontDoorOnAnotherChain() public {
        CascadeFrontDoor fd2 = newFrontDoor();
        bridge.connect(CHAIN2, address(fd2), false);
        registerFrontDoor(CHAIN2, address(fd2));
        vm.prank(bob);
        tao.approve(address(fd2), type(uint256).max);

        // alice at A = 0, S = 0: 1_000e18 * 1e6 = 1e27; bob at A = 1_000e18, S = 1e27:
        // 1_000e18 * (1e27 + 1e6) / (1_000e18 + 1) = 1e27
        depositVia(fd, alice, 1_000e18);
        close(fd);
        depositVia(fd2, bob, 1_000e18);
        close(fd2);
        assertEq(vault.balanceOf(alice), 1e27);
        assertEq(vault.balanceOf(bob), 1e27);

        // Each front door has its own window: 20% of gross 2_000e18 = 400e18.
        // fd: A = 2_000e18, S = 2e27: sMax = 400e18 * (2e27 + 1e6) / (2_000e18 + 1) = 4e26 → 400e18
        requestVia(fd, alice, 5e26);
        bytes32 k1 = keyOf(BASE, address(fd), 2, noEntries(), entries1(alice, 5e26));
        vm.recordLogs();
        close(fd);
        CascadeMessages.Payout[] memory list1 = redeemedList(vm.getRecordedLogs(), k1);
        assertPayout(list1, alice, 4e26, 400e18);

        // fd2: A = 1_600e18 (pending excluded), S = 1.6e27, gross still 2_000e18:
        // sMax = 400e18 * (1.6e27 + 1e6) / (1_600e18 + 1) = 4e26 → 400e18
        requestVia(fd2, bob, 5e26);
        bytes32 k2 = keyOf(CHAIN2, address(fd2), 2, noEntries(), entries1(bob, 5e26));
        vm.recordLogs();
        close(fd2);
        CascadeMessages.Payout[] memory list2 = redeemedList(vm.getRecordedLogs(), k2);
        assertPayout(list2, bob, 4e26, 400e18);

        // fd's window is spent: its third batch, 12 hours into the window, defers alice's request
        requestVia(fd, alice, 1e26);
        bytes32 k3 = keyOf(BASE, address(fd), 3, noEntries(), entries1(alice, 1e26));
        vm.recordLogs();
        close(fd);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log[] memory deferred = vaultLogs(logs, CascadeVault.RedeemDeferred.selector, k3);
        assertEq(deferred.length, 1);
        assertEq(deferred[0].topics[2], bytes32(uint256(uint160(alice))));
        assertEq(deferred[0].data, abi.encode(uint256(1e26)));
        assertEq(redeemedList(logs, k3).length, 0);
        assertTrue(vault.processed(k3));

        (, uint256 burned1) = vault.burnWindows(vault.peerId(BASE, address(fd)));
        (, uint256 burned2) = vault.burnWindows(vault.peerId(CHAIN2, address(fd2)));
        assertEq(burned1, 400e18);
        assertEq(burned2, 400e18);
        assertEq(vault.pendingPayouts(), 800e18);
        assertEq(vault.balanceOf(alice), 6e26);
        assertEq(vault.balanceOf(bob), 6e26);

        // each payout goes back to the chain its batch came from: 400e18 - 1e15 fee
        vm.warp(block.timestamp + 24 hours);
        vault.processPayouts(k1, list1, 50);
        vault.processPayouts(k2, list2, 50);

        // Base and CHAIN2
        assertEq(fd.claimable(alice), 399_999e15);
        assertEq(fd2.claimable(bob), 399_999e15);
        assertEq(fd.claimable(bob), 0);
        assertEq(fd2.claimable(alice), 0);
        assertEq(tao.balanceOf(address(fd)), 399_999e15);
        assertEq(tao.balanceOf(address(fd2)), 399_999e15);
        // 1_000e18 - 399_999e15
        assertEq(fd.netForwarded(), 600_001e15);
        assertEq(fd2.netForwarded(), 600_001e15);
        // Bittensor: 2_000e18 + ED in, 2 * 400e18 out, nothing staked
        assertEq(vault.pendingPayouts(), 0);
        assertEq(address(vault).balance, ED + 1_200e18);
        assertEq(bridge.failedCount(), 0);
    }

    function test_rogueFrontDoorIsBoundedAndReversed() public {
        // A = 0, S = 0: 1_000e18 * 1e6 = 1e27 shares, all of it staked
        depositVia(fd, alice, 1_000e18);
        close(fd);
        vm.prank(keeper);
        vault.stakeIdle();
        assertEq(vault.balanceOf(alice), 1e27);
        assertEq(vault.rootStakeRao(), 1_000_000_000_000);

        // the owner registers an EOA as a second BASE front door
        address rogue = makeAddr("rogue");
        registerFrontDoor(BASE, rogue);

        // a forged batch from it redeems all of alice's shares. A = 1_000e18, S = 1e27, allowance
        // 20% of 1_000e18 = 200e18: sMax = 200e18 * (1e27 + 1e6) / (1_000e18 + 1) = 2e26 → 200e18
        bytes memory forged = CascadeMessages.encodeBatch(1, noEntries(), entries1(alice, 1e27));
        bytes32 key = keyOf(BASE, rogue, 1, noEntries(), entries1(alice, 1e27));
        vm.expectEmit(address(vault));
        emit CascadeVault.Redeemed(key, alice, 2e26, 200e18);
        vm.prank(address(bridge));
        vault.onBridgeMessage(BASE, rogue, forged, 0);
        assertEq(vault.balanceOf(alice), 8e26);
        assertEq(vault.pendingPayouts(), 200e18);

        // the guardian removes the peer without pausing; the queued payout cannot leave
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, rogue);
        assertFalse(vault.paused());
        vm.warp(block.timestamp + 24 hours);
        CascadeMessages.Payout[] memory list = new CascadeMessages.Payout[](1);
        list[0] = CascadeMessages.Payout(alice, 2e26, 200e18);
        vm.expectRevert(CascadeVault.FrontDoorInactive.selector);
        vault.processPayouts(key, list, 50);
        assertEq(vault.pendingPayouts(), 200e18);

        // the owner cancels: alice's shares come back
        vm.expectEmit(address(vault));
        emit CascadeVault.RedeemReversed(key, alice, 2e26, 200e18);
        vm.prank(owner);
        vault.cancelPayoutBatch(key, list);
        assertEq(vault.balanceOf(alice), 1e27);
        assertEq(vault.pendingPayouts(), 0);

        // alice's honest redeem through fd: A = 1_000e18, S = 1e27, allowance 200e18:
        // 1e26 * (1_000e18 + 1) / (1e27 + 1e6) = 100e18
        requestVia(fd, alice, 1e26);
        bytes32 k2 = keyOf(BASE, address(fd), 2, noEntries(), entries1(alice, 1e26));
        vm.recordLogs();
        close(fd);
        CascadeMessages.Payout[] memory list2 = redeemedList(vm.getRecordedLogs(), k2);
        assertPayout(list2, alice, 1e26, 100e18);
        vm.warp(block.timestamp + 24 hours);
        vault.processPayouts(k2, list2, 50);
        // 100e18 - 1e15 fee
        assertEq(fd.claimable(alice), 99_999e15);
        vm.prank(alice);
        fd.claim();

        // Base: 1_000e18 - 1_000e18 + 99_999e15
        assertEq(tao.balanceOf(alice), 99_999e15);
        assertEq(tao.balanceOf(address(fd)), 0);
        // 1_000e18 - 99_999e15
        assertEq(fd.netForwarded(), 900_001e15);
        // Bittensor: 100_000_000_000 rao unstaked for net + fee
        assertEq(vault.balanceOf(alice), 9e26);
        assertEq(vault.rootStakeRao(), 900_000_000_000);
        assertEq(vault.pendingPayouts(), 0);
        assertEq(address(vault).balance, ED);
    }

    function test_failedDeliveryIsRetried() public {
        depositVia(fd, alice, 10e18);
        vm.prank(guardian);
        vault.pause();

        // the paused vault refuses the delivery; the close still succeeds and the rail files the batch
        vm.recordLogs();
        close(fd);
        (uint256 n, uint256 index, bytes memory reason) = failures(vm.getRecordedLogs());
        assertEq(n, 1);
        assertEq(index, 0);
        assertEq(reason, abi.encodeWithSelector(Pausable.EnforcedPause.selector));
        assertEq(bridge.failedCount(), 1);
        assertEq(bridge.pendingCount(), 0);
        assertEq(vault.balanceOf(alice), 0);
        assertEq(address(vault).balance, ED);
        // Base forwarded the deposit; the rail holds its TAO on the vault side, plus the fee
        assertEq(tao.balanceOf(address(fd)), 0);
        assertEq(fd.netForwarded(), 10e18);
        assertEq(address(bridge).balance, 10e18 + FEE);

        vm.prank(owner);
        vault.unpause();
        assertTrue(bridge.retryNext());

        // A = 0, S = 0: 10e18 * 1e6 = 1e25
        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(address(vault).balance, ED + 10e18);
        assertEq(bridge.failedCount(), 0);
        // funded once: the retry did not create the value again
        assertEq(address(bridge).balance, FEE);
    }

    function test_failedPayoutDeliveryIsRetried() public {
        // A = 0, S = 0: 10e18 * 1e6 = 1e25, left liquid
        depositVia(fd, alice, 10e18);
        close(fd);
        // A = 10e18, S = 1e25: 5e24 * (10e18 + 1) / (1e25 + 1e6) = 5e18
        requestVia(fd, alice, 5e24);
        bytes32 key = keyOf(BASE, address(fd), 2, noEntries(), entries1(alice, 5e24));
        vm.recordLogs();
        close(fd);
        CascadeMessages.Payout[] memory list = redeemedList(vm.getRecordedLogs(), key);
        assertPayout(list, alice, 5e24, 5e18);

        // the vault sends the chunk; the rail fails its delivery to Base (deliveries 0 and 1 were the batches)
        vm.warp(block.timestamp + 24 hours);
        bridge.failNext();
        vm.recordLogs();
        vault.processPayouts(key, list, 50);
        (uint256 n, uint256 index, bytes memory reason) = failures(vm.getRecordedLogs());
        assertEq(n, 1);
        assertEq(index, 2);
        assertEq(reason.length, 0);
        assertEq(bridge.failedCount(), 1);
        // Bittensor: the payout left (net + fee = 5e18)
        assertEq(vault.pendingPayouts(), 0);
        assertEq(address(vault).balance, ED + 5e18);
        // Base: nothing arrived
        assertEq(tao.balanceOf(address(fd)), 0);
        assertEq(fd.claimable(alice), 0);
        assertEq(fd.netForwarded(), 10e18);

        // the retry mints once and credits alice: 5e18 - 1e15 fee
        assertTrue(bridge.retryNext());
        assertEq(bridge.failedCount(), 0);
        assertEq(tao.balanceOf(address(fd)), 4_999e15);
        assertEq(fd.claimable(alice), 4_999e15);
        // 10e18 - 4_999e15
        assertEq(fd.netForwarded(), 5_001e15);
        vm.prank(alice);
        fd.claim();
        assertEq(tao.balanceOf(alice), 1_000e18 - 10e18 + 4_999e15);
        assertEq(tao.balanceOf(address(fd)), 0);
    }

    function test_deliveryGasCapCatchesRegression() public {
        bridge.setDeliveryGas(100_000);
        depositVia(fd, alice, 10e18);

        vm.recordLogs();
        close(fd);
        (uint256 n, uint256 index, bytes memory reason) = failures(vm.getRecordedLogs());
        // out of gas: no revert data
        assertEq(n, 1);
        assertEq(index, 0);
        assertEq(reason.length, 0);
        assertEq(bridge.failedCount(), 1);
        assertEq(vault.balanceOf(alice), 0);
        assertEq(address(vault).balance, ED);

        bridge.setDeliveryGas(7_000_000);
        assertTrue(bridge.retryNext());

        // A = 0, S = 0: 1e25
        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(address(vault).balance, ED + 10e18);
        assertEq(bridge.failedCount(), 0);
        // funded once, before the failed attempt
        assertEq(address(bridge).balance, FEE);
        assertEq(tao.balanceOf(address(fd)), 0);
        assertEq(fd.netForwarded(), 10e18);
    }

    function test_lostTokensDoNotBlockOtherBatches() public {
        bridge.failNext();
        depositVia(fd, alice, 10e18);
        vm.recordLogs();
        close(fd);

        // batch 1 is filed as failed without being funded or delivered
        (uint256 n, uint256 index, bytes memory reason) = failures(vm.getRecordedLogs());
        assertEq(n, 1);
        assertEq(index, 0);
        assertEq(reason.length, 0);
        assertEq(bridge.failedCount(), 1);
        assertEq(address(bridge).balance, FEE);
        bytes32 key1 = keyOf(BASE, address(fd), 1, entries1(alice, 10e18), noEntries());
        assertFalse(vault.processed(key1));

        // batch 2 closes and delivers behind it. A = 0, S = 0: 20e18 * 1e6 = 2e25
        depositVia(fd, bob, 20e18);
        close(fd);
        assertEq(vault.balanceOf(bob), 2e25);
        assertEq(bridge.failedCount(), 1);

        // batch 1 delivers on retry, priced on the vault as it is now.
        // A = 20e18, S = 2e25: 10e18 * (2e25 + 1e6) / (20e18 + 1) = 1e25
        assertTrue(bridge.retryNext());
        assertEq(vault.balanceOf(alice), 1e25);
        assertTrue(vault.processed(key1));
        assertEq(bridge.failedCount(), 0);
        assertEq(bridge.pendingCount(), 0);

        // Bittensor holds both batches; Base forwarded both; the rail kept both fees
        assertEq(address(vault).balance, ED + 30e18);
        assertEq(fd.netForwarded(), 30e18);
        assertEq(tao.balanceOf(address(fd)), 0);
        assertEq(address(bridge).balance, 2 * FEE);
    }
}
