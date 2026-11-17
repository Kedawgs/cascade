// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm, VmSafe} from "forge-std/Vm.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {CascadeBatchLib} from "../../src/libraries/CascadeBatchLib.sol";
import {BatchIn} from "../../src/CascadeTypes.sol";
import {AmountMismatch, DuplicateBatch} from "../../src/CascadeErrors.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {
    BatchDelivered,
    DepositBounced,
    DepositSkipped,
    Deposited,
    PayoutBatchQueued,
    RedeemDeferred,
    RedeemSkipped,
    Redeemed,
    Transfer
} from "../../src/CascadeEvents.sol";

/// A stand-in for the vault: runs `data` on `lib` by DELEGATECALL, in its own storage.
contract DelegateCaller {
    function run(address lib, bytes calldata data) external returns (bool ok) {
        (ok,) = lib.delegatecall(data);
    }
}

/// @notice The batch path's boundary (spec §8.1, Task 5e): L1 `CascadeBatchLib` runs only by the vault's
/// DELEGATECALL, and a delivery logs v3.1's events, in v3.1's order, from the vault's address.
contract BatchLibBoundaryTest is VaultTestBase {
    // ---- helpers ----

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

    /// Asserts `logs` are exactly `topics` (their first topics, in order), each logged by the vault.
    function assertVaultLogs(Vm.Log[] memory logs, bytes32[] memory topics) internal view {
        assertEq(logs.length, topics.length, "the number of logs");
        for (uint256 i; i < logs.length; ++i) {
            assertEq(logs[i].topics[0], topics[i], string.concat("log ", vm.toString(i)));
            assertEq(logs[i].emitter, address(vault), string.concat("log ", vm.toString(i), " is the vault's"));
        }
    }

    // ---- the event order ----

    /// The delivery logs v3.1's sequence exactly (ruling DA2): BatchDelivered first, then each deposit in
    /// order (a zero user skipped; a mint's Transfer before its Deposited), then each redeem in order (a
    /// holder with nothing skipped, a redeem under MIN_REDEEM_VALUE deferred, a burn's Transfer before its
    /// Redeemed), then PayoutBatchQueued. The keeper rebuilds a batch's payouts from this order, and the
    /// indexer reads it. Characterizes the code before Task 5e and holds after it.
    function test_deliveryEventOrderIsV31s() public {
        depositVia(alice, 10e18);
        // A = 10e18, S = 1e25: bob's 1e18 mints 1e24; carol holds nothing; alice's 1e21 shares are worth
        // 1e21 * (10e18 + 1) / (1e25 + 1e6) = about 1e15 < 0.01e18, deferred; her 5e24 burn for 5e18
        CascadeMessages.Entry[] memory d = entries2(address(0), 1e18, bob, 1e18);
        CascadeMessages.Entry[] memory r = entries3(carol, 1e24, alice, 1e21, alice, 5e24);

        vm.recordLogs();
        deliver(BASE, frontDoor, 2, d, r);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32[] memory want = new bytes32[](9);
        want[0] = BatchDelivered.selector;
        want[1] = DepositSkipped.selector;
        want[2] = Transfer.selector;
        want[3] = Deposited.selector;
        want[4] = RedeemSkipped.selector;
        want[5] = RedeemDeferred.selector;
        want[6] = Transfer.selector;
        want[7] = Redeemed.selector;
        want[8] = PayoutBatchQueued.selector;
        assertVaultLogs(logs, want);
        // the mint is bob's, the burn alice's
        assertEq(logs[2].topics[2], bytes32(uint256(uint160(bob))));
        assertEq(logs[6].topics[1], bytes32(uint256(uint160(alice))));
        assertEq(vault.balanceOf(bob), 1e24);
        assertEq(vault.balanceOf(alice), 5e24);
    }

    /// In an insolvent vault a deposit bounces (no mint, no Transfer) and a redeem still burns, in the same
    /// order: BatchDelivered, DepositBounced, Transfer, Redeemed, PayoutBatchQueued.
    function test_insolventDeliveryEventOrderIsV31s() public {
        depositVia(alice, 10e18);
        // 60% of the assets lost: A = 4e18 against S = 1e25, below half the launch price
        vm.deal(address(vault), ED + 4e18);

        vm.recordLogs();
        deliver(BASE, frontDoor, 2, entries1(bob, 1e18), entries1(alice, 5e24));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32[] memory want = new bytes32[](5);
        want[0] = BatchDelivered.selector;
        want[1] = DepositBounced.selector;
        want[2] = Transfer.selector;
        want[3] = Redeemed.selector;
        want[4] = PayoutBatchQueued.selector;
        assertVaultLogs(logs, want);
        assertEq(vault.balanceOf(bob), 0);
    }

    // ---- the checks the vault keeps ----

    /// The replay check runs in the vault, before L1 sums the deposits (ruling DA2): a replayed message
    /// with a wrong amount reverts DuplicateBatch, where v3.1 reverted AmountMismatch. A new message with a
    /// wrong amount still reverts AmountMismatch, from L1, through the vault.
    function test_replayWithAWrongAmountRevertsDuplicateBatch() public {
        bytes memory m = CascadeMessages.encodeBatch(1, entries1(alice, 1e18), noEntries());
        vm.deal(address(bridge), 3e18);
        vm.prank(address(bridge));
        vault.onBridgeMessage{value: 1e18}(BASE, frontDoor, m, 1e18);

        vm.prank(address(bridge));
        vm.expectRevert(DuplicateBatch.selector);
        vault.onBridgeMessage{value: 2e18}(BASE, frontDoor, m, 2e18);

        bytes memory fresh = CascadeMessages.encodeBatch(2, entries1(alice, 1e18), noEntries());
        vm.prank(address(bridge));
        vm.expectRevert(AmountMismatch.selector);
        vault.onBridgeMessage{value: 2e18}(BASE, frontDoor, fresh, 2e18);
        assertEq(vault.balanceOf(alice), 1e24);
    }

    // ---- the library boundary ----

    /// The compiler's call guard: a non-view library function reverts, with no data, unless it runs by
    /// DELEGATECALL. Called directly at its linked address, with or without value, `deliver` reverts and
    /// keeps no value; the same calldata run by DELEGATECALL writes only its caller's storage.
    function test_directCallToDeliverReverts() public {
        address lib = address(CascadeBatchLib);
        assertGt(lib.code.length, 0, "L1 is deployed at its linked address");
        BatchIn memory input = BatchIn({
            key: keccak256("key"),
            peer: vaultLens.peerId(BASE, frontDoor),
            sender: frontDoor,
            sourceChain: BASE,
            amount: 1e18,
            A: 0,
            S: 0,
            insolvent: false,
            base: 0,
            maxEntryValue: 2_000e18,
            maxDailyOutflowBps: 2_000,
            minDailyOutflow: 100e18,
            globalOutflowBps: 2_000,
            payoutsOpen: true
        });
        bytes memory message = CascadeMessages.encodeBatch(1, entries1(alice, 1e18), noEntries());
        // the storage pointers travel as slot numbers: the vault's own (0 for the shares, then any)
        bytes memory data = abi.encodeWithSelector(
            CascadeBatchLib.deliver.selector, uint256(0), uint256(1), uint256(2), input, message
        );

        (bool ok, bytes memory ret) = lib.call(data);
        assertFalse(ok, "a direct call reverts");
        assertEq(ret.length, 0, "the call guard reverts with no data");

        vm.deal(address(this), 1e18);
        (ok, ret) = lib.call{value: 1e18}(data);
        assertFalse(ok, "a direct call with value reverts");
        assertEq(ret.length, 0);
        assertEq(lib.balance, 0);
        assertEq(vault.totalSupply(), 0);

        // the same calldata runs by DELEGATECALL, so what stopped it above is the guard: the caller's own
        // storage takes the mint (slot 0, the shares' supply: 1e18 at A = 0, S = 0 is 1e24 shares)
        DelegateCaller caller = new DelegateCaller();
        assertTrue(caller.run(lib, data), "the same call by DELEGATECALL runs");
        assertEq(uint256(vm.load(address(caller), bytes32(0))), 1e24);
    }

    /// Deposited, Redeemed and DepositBounced (and every other event of a delivery) come from the vault's
    /// address, never L1's: the vault runs L1 by DELEGATECALL, in its own context.
    function test_deliveryEventsComeFromTheVault() public {
        address lib = address(CascadeBatchLib);
        depositVia(alice, 10e18);

        // solvent: a deposit and a redeem, run through L1
        vm.recordLogs();
        vm.startStateDiffRecording();
        deliver(BASE, frontDoor, 2, entries1(bob, 1e18), entries1(alice, 5e24));
        Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(delegatedToL1(accesses, lib), "the vault ran L1 by DELEGATECALL, in its own storage");
        assertTrue(loggedByVault(logs, Deposited.selector), "Deposited");
        assertTrue(loggedByVault(logs, Redeemed.selector), "Redeemed");
        assertNoneFrom(logs, lib);

        // insolvent: the deposit bounces
        vm.deal(address(vault), ED + 1e18);
        vm.recordLogs();
        deliver(BASE, frontDoor, 3, entries1(carol, 1e18), noEntries());
        logs = vm.getRecordedLogs();
        assertTrue(loggedByVault(logs, DepositBounced.selector), "DepositBounced");
        assertNoneFrom(logs, lib);
    }

    /// Whether `accesses` hold a DELEGATECALL into `lib` that wrote the vault's storage and touched no
    /// other account's (the frame's `accessor` is the vault's caller, kept by DELEGATECALL).
    function delegatedToL1(Vm.AccountAccess[] memory accesses, address lib) internal view returns (bool) {
        for (uint256 i; i < accesses.length; ++i) {
            if (accesses[i].kind != VmSafe.AccountAccessKind.DelegateCall || accesses[i].account != lib) continue;
            bool wroteVault;
            for (uint256 j; j < accesses[i].storageAccesses.length; ++j) {
                VmSafe.StorageAccess memory a = accesses[i].storageAccesses[j];
                assertEq(a.account, address(vault), "L1 touches only the vault's storage");
                if (a.isWrite) wroteVault = true;
            }
            if (wroteVault) return true;
        }
        return false;
    }

    function loggedByVault(Vm.Log[] memory logs, bytes32 topic) internal view returns (bool) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == topic && logs[i].emitter == address(vault)) return true;
        }
        return false;
    }

    function assertNoneFrom(Vm.Log[] memory logs, address lib) internal pure {
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].emitter != lib, "no event comes from L1's address");
        }
    }
}
