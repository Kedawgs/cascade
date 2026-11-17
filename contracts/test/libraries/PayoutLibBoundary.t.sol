// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm, VmSafe} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {CascadePayoutLib} from "../../src/libraries/CascadePayoutLib.sol";
import {CascadePayoutMath} from "../../src/libraries/CascadePayoutMath.sol";
import {CascadeStakeLib} from "../../src/libraries/CascadeStakeLib.sol";
import {ISTAKING_ADDRESS} from "../../src/interfaces/IStaking.sol";
import {VaultLayout} from "../../src/lens/generated/VaultLayout.sol";
import {
    DirectTransferNotAllowed,
    FeeTooHigh,
    FrontDoorInactive,
    NotPending,
    PayoutDelayed,
    PayoutsMismatch,
    PrimaryBridgeDisabled,
    UnstakeShort
} from "../../src/CascadeErrors.sol";
import {
    ExitsClosed,
    PayoutBatchCancelled,
    PayoutChunkSent,
    PayoutDust,
    RedeemReversed,
    Transfer,
    Unstaked
} from "../../src/CascadeEvents.sol";
import {Ledger, PayoutBatch, PayoutIn, PayoutPlan, SharesData} from "../../src/CascadeTypes.sol";
import {ReentrantBridge} from "../mocks/ReentrantBridge.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {Schedule} from "../governance/Schedule.sol";

/// A stand-in for the vault: the payout engine's storage in the vault's shapes, at its own slots (the shares at
/// 0 and 1, the queue at 2, the ledger at 3 to 5), which L3 runs on by DELEGATECALL, in the stand-in's context.
contract PayoutLibCaller {
    SharesData internal shares;
    mapping(bytes32 => PayoutBatch) internal batches;
    Ledger internal ledger;

    function seed(bytes32 key, PayoutBatch memory b, uint256 pending_) external {
        batches[key] = b;
        ledger.pending = pending_;
    }

    function run(address lib, bytes calldata data) external returns (bool ok, bytes memory ret) {
        (ok, ret) = lib.delegatecall(data);
    }

    function supply() external view returns (uint256) {
        return shares.totalSupply;
    }

    function pending() external view returns (uint256) {
        return ledger.pending;
    }

    function count(bytes32 key) external view returns (uint32) {
        return batches[key].count;
    }

    receive() external payable {}
}

/// @notice The payout engine's boundary (spec §8.1, Task 5g): processPayouts and cancelPayoutBatch keep v3.1's
/// order of checks, effects, external calls and events, whatever runs them. L3 `CascadePayoutLib` runs only by
/// the vault's DELEGATECALL, in two halves around the walk, which the vault runs itself under its transient
/// unstake flag (the controller's ruling): `prepare` (the checks, the chunk, the fee quote, the dust, what to
/// unstake; it writes nothing), the vault's walk through L2, then `finish` (the effects, then the send, then
/// PayoutChunkSent). L3 calls only the bridge the vault passes and, by DELEGATECALL, the linked payout math.
contract PayoutLibBoundaryTest is VaultTestBase {
    /// alice's redeem of 1e26 shares, queued in setUp.
    bytes32 K;

    /// VaultPayouts' fixture, exact stake reads: alice deposits 1_000e18 (1e27 shares); the keeper stakes it all
    /// (HK1 1_000_000_000_000 rao, balance ED); the stub fee is 1e15. Batch K: alice redeems 1e26 for 100e18.
    /// Then 24 hours pass.
    function setUp() public override {
        super.setUp();
        staking.setOneRaoShort(false);
        depositVia(alice, 1_000e18);
        vm.prank(keeper);
        vault.stakeIdle();
        bridge.setFee(1e15);
        K = deliver(BASE, frontDoor, ++nextBatchId, noEntries(), entries1(alice, 1e26));
        vm.warp(vm.getBlockTimestamp() + 24 hours);
    }

    // ---- helpers ----

    function listK() internal view returns (CascadeMessages.Payout[] memory) {
        return pay1(alice, 1e26, 100e18);
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

    function stakeOf(bytes32 h) internal view returns (uint256) {
        return staking.getStake(h, vaultLens.coldkey(), 0);
    }

    /// VaultPayouts' dust case: 600e18 of the stake is lost and written off (the owner's writeOffMissingStake, its
    /// 7 days waited: a loss, not missing stake, which would refuse the batch), so bob's 1-rao deposit bounces (A =
    /// 300e18 against S = 9e26), and alice redeems 5e24 for 1_666_666_666e9. Its one chunk drops bob's entry as dust
    /// and needs a walk (the vault holds ED and bob's 1e9). Then 24 hours pass.
    function queueDustAndWalk() internal returns (bytes32 key, CascadeMessages.Payout[] memory list) {
        staking.loseStake(HK1, vaultLens.coldkey(), 600_000_000_000);
        Schedule.run(vault, owner, abi.encodeCall(vault.writeOffMissingStake, (600_000_000_000)));
        assertFalse(vaultLens.stakeMissing(), "written off");
        key = deliver(BASE, frontDoor, ++nextBatchId, entries1(bob, 1e9), entries1(alice, 5e24));
        list = pay2(bob, 0, 1e9, alice, 5e24, 1_666_666_666e9);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
    }

    /// The vault storage slot of `key`'s batch, member slot `member`.
    function batchSlot(bytes32 key, uint256 member) internal pure returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode(key, VaultLayout.SLOT_PAYOUT_BATCHES))) + member);
    }

    /// Lists `next` as a bridge, its activation scheduled and executed after the registry's delay, and
    /// makes it the primary: the owner disables the current one, then switches (the switch is allowed
    /// only while the primary is disabled, and clears its hold).
    function makePrimary(address next) internal {
        Schedule.run(vault, owner, abi.encodeCall(vault.activateBridge, (next)));
        vm.startPrank(owner);
        vault.disableBridge(vaultLens.primaryBridge());
        vault.setPrimaryBridge(next);
        vm.stopPrank();
    }

    /// Asserts `logs` are exactly `topics` (their first topics, in order), each logged by the vault.
    function assertVaultLogs(Vm.Log[] memory logs, bytes32[] memory topics) internal view {
        assertEq(logs.length, topics.length, "the number of logs");
        for (uint256 i; i < logs.length; ++i) {
            assertEq(logs[i].topics[0], topics[i], string.concat("log ", vm.toString(i)));
            assertEq(logs[i].emitter, address(vault), string.concat("log ", vm.toString(i), " is the vault's"));
        }
    }

    // ---- v3.1's order, characterized: it holds before Task 5g and after ----

    /// One chunk with a dust entry, a walk and a send runs v3.1's sequence exactly: the fee quote (a STATICCALL to
    /// the bridge) before the walk's removal (a CALL to the staking precompile); PayoutDust before the walk's
    /// Unstaked; the effects (the reservation, the batch) after the walk and before the send (a CALL to the
    /// bridge, the one call that could re-enter); PayoutChunkSent last.
    function test_payoutOrderIsV31s() public {
        (bytes32 key, CascadeMessages.Payout[] memory list) = queueDustAndWalk();

        vm.recordLogs();
        vm.startStateDiffRecording();
        vault.processPayouts(key, list, 10);
        Vm.AccountAccess[] memory a = vm.stopAndReturnStateDiff();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32[] memory want = new bytes32[](3);
        want[0] = PayoutDust.selector;
        want[1] = Unstaked.selector;
        want[2] = PayoutChunkSent.selector;
        assertVaultLogs(logs, want);

        // the sequence: each access at (its index in `a`, its storage access's index + 1; 0 for the call itself)
        uint256 quote;
        uint256 removal;
        uint256 pending;
        uint256 batch;
        uint256 send;
        uint256 seq;
        bytes32 pendingSlot = bytes32(VaultLayout.SLOT_LEDGER + VaultLayout.LEDGER_PENDING_SLOT);
        for (uint256 i; i < a.length; ++i) {
            ++seq;
            if (a[i].account == address(bridge) && a[i].kind == VmSafe.AccountAccessKind.StaticCall) {
                if (quote == 0) quote = seq;
            } else if (a[i].account == ISTAKING_ADDRESS && a[i].kind == VmSafe.AccountAccessKind.Call) {
                if (removal == 0) removal = seq;
            } else if (a[i].account == address(bridge) && a[i].kind == VmSafe.AccountAccessKind.Call) {
                assertEq(send, 0, "one send");
                send = seq;
            }
            for (uint256 j; j < a[i].storageAccesses.length; ++j) {
                ++seq;
                VmSafe.StorageAccess memory s = a[i].storageAccesses[j];
                if (s.account != address(vault) || !s.isWrite || s.reverted) continue;
                if (s.slot == pendingSlot) pending = seq;
                if (s.slot == batchSlot(key, VaultLayout.PAYOUT_BATCH_CURSOR_SLOT)) batch = seq;
            }
        }
        assertGt(quote, 0, "the fee quote");
        assertGt(removal, quote, "the walk's removal after the quote");
        assertGt(pending, removal, "the reservation released after the walk");
        assertGt(batch, removal, "the batch advanced after the walk");
        assertGt(send, pending, "the send after the reservation");
        assertGt(send, batch, "the send after the batch");
        assertEq(bridge.sendCount(), 1);
    }

    /// When several checks fail at once, the first in v3.1's order reverts: the pause, then NotPending, the list
    /// (PayoutsMismatch), the delay, the front door, the primary bridge, the fee ceiling, then the walk.
    function test_checksKeepV31sOrder() public {
        // a fresh batch, inside its delay, queued while the bridge and the front door are still listed
        bytes32 fresh = deliver(BASE, frontDoor, ++nextBatchId, noEntries(), entries1(alice, 1e25));
        CascadeMessages.Payout[] memory freshList = pay1(alice, 1e25, 10e18);
        // then every later check would fail too
        vm.startPrank(guardian);
        vault.disableBridge(address(bridge));
        vault.removeFrontDoor(BASE, frontDoor);
        vm.stopPrank();
        bridge.setFee(2e18);
        staking.setUnstakeBlocked(true);
        CascadeMessages.Payout[] memory none;

        vm.prank(guardian);
        vault.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.processPayouts(keccak256("unknown"), none, 0);
        vm.prank(owner);
        vault.unpause();

        vm.expectRevert(NotPending.selector);
        vault.processPayouts(keccak256("unknown"), freshList, 0);
        vm.expectRevert(PayoutsMismatch.selector);
        vault.processPayouts(fresh, none, 0);
        vm.expectRevert(PayoutDelayed.selector);
        vault.processPayouts(fresh, freshList, 0);
        vm.expectRevert(FrontDoorInactive.selector);
        vault.processPayouts(K, listK(), 0);

        // the door back is an Ordinary item (the guardian's removal made it unknown), refused while the guardian
        // holds the primary (Task 8's gate) or the launch door (Task 10's): the bridge's Reopen and the same
        // guardian's swap (which clears its door hold) first, then the door, then the bridge disabled again, so
        // the door passes and the primary's check is the one that fails
        Schedule.run(vault, owner, abi.encodeCall(vault.activateBridge, (address(bridge))));
        Schedule.run(vault, owner, abi.encodeCall(vault.setGuardian, (guardian)));
        registerFrontDoor(BASE, frontDoor);
        vm.prank(guardian);
        vault.disableBridge(address(bridge));
        vm.expectRevert(PrimaryBridgeDisabled.selector);
        vault.processPayouts(K, listK(), 0);

        // the bridge back, a Reopen after the registry's delay: still the primary
        Schedule.run(vault, owner, abi.encodeCall(vault.activateBridge, (address(bridge))));
        vm.expectRevert(FeeTooHigh.selector);
        vault.processPayouts(K, listK(), 0);

        bridge.setFee(1e15);
        // the walk: its refused removal skipped (Task 20), no other position to pay from
        vm.expectRevert(UnstakeShort.selector);
        vault.processPayouts(K, listK(), 0);

        staking.setUnstakeBlocked(false);
        vault.processPayouts(K, listK(), 0);
        assertEq(bridge.sendCount(), 1);
        assertEq(vaultLens.getPayoutBatch(K).count, 0, "K paid whole");

        // a cancel: the owner, then NotPending before the list
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        vault.cancelPayoutBatch(keccak256("unknown"), none);
        vm.prank(owner);
        vm.expectRevert(NotPending.selector);
        vault.cancelPayoutBatch(keccak256("unknown"), freshList);
        vm.prank(owner);
        vm.expectRevert(PayoutsMismatch.selector);
        vault.cancelPayoutBatch(fresh, none);
    }

    /// The bridge's send, the payout engine's last external call, re-enters the vault: processPayouts and
    /// redeemDirect revert at the vault's lock, and receive() refuses the value it sends back, since the unstake
    /// flag is clear by then, although the same payout's walk paid its receipts into receive() under the flag
    /// (the precompile pays by a call here, so a revert undoes it). Caught, the outer call completes; bubbled,
    /// the outer call reverts whole.
    function test_reentrantBridgeHitsTheVaultsLock() public {
        staking.setPayByCall(true);
        ReentrantBridge evil = new ReentrantBridge(address(vault));
        evil.setFee(1e15);
        // a second batch to hold while the first one's payout re-enters, delivered through `bridge` before the
        // switch disables it (the primary is switched only while disabled, Task 8)
        bytes32 k2 = deliver(BASE, frontDoor, ++nextBatchId, noEntries(), entries1(alice, 1e25));
        makePrimary(address(evil));
        bytes memory locked = abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        bytes memory refused = abi.encodeWithSelector(DirectTransferNotAllowed.selector);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        uint256 stake = stakeOf(HK1);

        // caught: K is paid, its walk ran, and every re-entry was refused
        evil.setMode(ReentrantBridge.Mode.Catch, k2);
        vault.processPayouts(K, listK(), 0);
        assertEq(evil.sendCount(), 1);
        assertEq(evil.lastValue(), 100e18);
        // the walk asks the 1_000-rao shortfall tolerance on top (Task 19)
        assertEq(stakeOf(HK1), stake - 100e9 - 1_000, "the walk ran before the send");
        assertEq(vaultLens.getPayoutBatch(K).count, 0, "K paid whole");
        assertFalse(evil.processOk());
        assertEq(evil.processReturn(), locked, "processPayouts re-entered: the lock");
        assertFalse(evil.redeemOk());
        assertEq(evil.redeemReturn(), locked, "redeemDirect re-entered: the lock");
        assertFalse(evil.transferOk());
        assertEq(evil.transferReturn(), refused, "receive() during the send: the unstake flag is clear");

        // bubbled: each re-entry's revert reverts the whole payout, its walk included
        PayoutBatch memory before = vaultLens.getPayoutBatch(k2);
        uint256 pending = vaultLens.pendingPayouts();
        stake = stakeOf(HK1);
        uint256 balance = address(vault).balance;
        ReentrantBridge.Mode[3] memory modes = [
            ReentrantBridge.Mode.BubbleProcess, ReentrantBridge.Mode.BubbleRedeem, ReentrantBridge.Mode.BubbleTransfer
        ];
        bytes[3] memory reverts = [locked, locked, refused];
        for (uint256 i; i < 3; ++i) {
            evil.setMode(modes[i], k2);
            vm.expectRevert(reverts[i]);
            vault.processPayouts(k2, pay1(alice, 1e25, 10e18), 0);
            PayoutBatch memory b = vaultLens.getPayoutBatch(k2);
            assertEq(b.cursor, before.cursor, "the batch did not advance");
            assertEq(b.remaining, before.remaining);
            assertEq(vaultLens.pendingPayouts(), pending, "the reservation is whole");
            assertEq(stakeOf(HK1), stake, "the walk was undone");
            assertEq(address(vault).balance, balance);
            assertEq(evil.sendCount(), 1, "no send stands");
        }

        // a plain send still pays it
        evil.setMode(ReentrantBridge.Mode.Off, k2);
        vault.processPayouts(k2, pay1(alice, 1e25, 10e18), 0);
        assertEq(evil.sendCount(), 2);
        assertEq(vaultLens.getPayoutBatch(k2).count, 0);
    }

    // ---- the library boundary ----

    /// The compiler's call guard: called directly at L3's linked address, with or without value, each of
    /// `prepare`, `finish` and `cancel` reverts with no data and L3 keeps no value. The same calldata run by
    /// DELEGATECALL from a stand-in runs on the stand-in's own state: `prepare` plans a one-entry chunk (its fee
    /// quoted by the bridge, its shortfall the whole chunk, since the stand-in holds nothing), `finish` releases
    /// the stand-in's reservation, completes its batch and sends the chunk's TAO from its balance, and `cancel`
    /// re-mints into its own share supply, priced on the assets passed in and its own supply (0 and 0: the 1 TAO
    /// owed buys 1e24, the shares burned), and returns the batch's source chain.
    function test_directCallsToPrepareFinishAndCancelRevert() public {
        address lib = address(CascadePayoutLib);
        assertGt(lib.code.length, 0, "L3 is deployed at its linked address");
        PayoutLibCaller caller = new PayoutLibCaller();
        bytes32 key = keccak256("stand-in");
        CascadeMessages.Payout[] memory list = pay1(alice, 1e24, 1e18);
        PayoutBatch memory b = PayoutBatch({
            sourceChain: BASE,
            frontDoor: frontDoor,
            batchId: 1,
            queuedAt: 0,
            cursor: 0,
            count: 1,
            chunk: 0,
            remaining: 1e18,
            payoutsHash: CascadePayoutMath.hashStep(bytes32(0), alice, 1e24, 1e18)
        });
        PayoutIn memory input = PayoutIn({
            batch: b,
            pending: 1e18,
            bridge: bridge,
            bridgeEnabled: true,
            doorActive: true,
            isKeeper: false,
            value: 0,
            payoutDelay: 0,
            minChunk: 1,
            maxMessageValue: 5_000e18,
            maxFeeBps: 100,
            maxFeeAbs: 0.015e18
        });

        // prepare
        bytes memory data = abi.encodeWithSelector(CascadePayoutLib.prepare.selector, key, list, uint32(0), input);
        assertGuarded(lib, data);
        (bool ok, bytes memory ret) = caller.run(lib, data);
        assertTrue(ok, "prepare by DELEGATECALL runs");
        PayoutPlan memory plan = abi.decode(ret, (PayoutPlan));
        assertEq(plan.taken, 1);
        assertEq(plan.sum, 1e18);
        assertEq(plan.fee, 1e15, "the bridge's quote");
        assertEq(plan.net, 999e15);
        assertEq(plan.shortfall, 1e18, "the stand-in holds nothing: the whole chunk is short");
        assertEq(plan.message, CascadeMessages.encodePayouts(key, 0, entries1(alice, 999e15)));

        // finish: the stand-in holds the batch, its reservation and the chunk's TAO, as the vault's walk would have
        // received it (plan.received: finish checks that the liquidity before the walk and its receipts fund the send);
        // the pointers travel as slots
        caller.seed(key, b, 1e18);
        vm.deal(address(caller), 1e18);
        plan.received = 1e18;
        data = abi.encodeWithSelector(CascadePayoutLib.finish.selector, uint256(2), uint256(3), key, list, input, plan);
        assertGuarded(lib, data);
        uint256 sends = bridge.sendCount();
        (ok,) = caller.run(lib, data);
        assertTrue(ok, "finish by DELEGATECALL runs");
        assertEq(caller.pending(), 0, "the stand-in's reservation released");
        assertEq(caller.count(key), 0, "the stand-in's batch done");
        assertEq(bridge.sendCount(), sends + 1);
        assertEq(bridge.lastValue(), 1e18, "net + fee, from the stand-in's balance");
        assertEq(bridge.lastAmount(), 999e15);
        assertEq(address(caller).balance, 0);

        // cancel
        caller.seed(key, b, 1e18);
        data = abi.encodeWithSelector(
            CascadePayoutLib.cancel.selector, uint256(0), uint256(2), uint256(3), key, list, uint256(0)
        );
        assertGuarded(lib, data);
        (ok, ret) = caller.run(lib, data);
        assertTrue(ok, "cancel by DELEGATECALL runs");
        assertEq(abi.decode(ret, (uint64)), BASE, "the batch's source chain");
        assertEq(caller.supply(), 1e24, "the stand-in's own shares take the re-mint");
        assertEq(caller.pending(), 0);
        assertEq(caller.count(key), 0);
        assertEq(vault.totalSupply(), 9e26, "the vault's shares untouched");
    }

    /// `data` called directly at `lib`, with and without value: reverted with no data, no value kept.
    function assertGuarded(address lib, bytes memory data) internal {
        (bool ok, bytes memory ret) = lib.call(data);
        assertFalse(ok, "a direct call reverts");
        assertEq(ret.length, 0, "the call guard reverts with no data");
        vm.deal(address(this), 1e18);
        (ok, ret) = lib.call{value: 1e18}(data);
        assertFalse(ok, "a direct call with value reverts");
        assertEq(ret.length, 0);
        assertEq(lib.balance, 0);
    }

    /// Every payout event comes from the vault's address, never L3's or the payout math's: a chunk's PayoutDust,
    /// the walk's Unstaked and PayoutChunkSent, and a cancel's Transfer (the re-mint), RedeemReversed and
    /// PayoutBatchCancelled, each in v3.1's order, then (a launch-chain door's batch) the vault's ExitsClosed. The
    /// vault runs L3 by DELEGATECALL: twice for a payout, once for a cancel.
    function test_payoutEventsComeFromTheVault() public {
        (bytes32 key, CascadeMessages.Payout[] memory list) = queueDustAndWalk();
        vm.recordLogs();
        vm.startStateDiffRecording();
        vault.processPayouts(key, list, 10);
        Vm.AccountAccess[] memory a = vm.stopAndReturnStateDiff();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(framesInto(a, address(CascadePayoutLib)).length, 2, "prepare and finish, by DELEGATECALL");
        bytes32[] memory want = new bytes32[](3);
        want[0] = PayoutDust.selector;
        want[1] = Unstaked.selector;
        want[2] = PayoutChunkSent.selector;
        assertVaultLogs(logs, want);
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(bob))), "bob's entry is the dust");

        vm.recordLogs();
        vm.startStateDiffRecording();
        vm.prank(owner);
        vault.cancelPayoutBatch(K, listK());
        a = vm.stopAndReturnStateDiff();
        logs = vm.getRecordedLogs();
        assertEq(framesInto(a, address(CascadePayoutLib)).length, 1, "cancel, by DELEGATECALL");
        // then the vault's own ExitsClosed: K is a launch-chain door's batch, so its cancel stamps the owner's
        // clock (Task 10), after L3 returns
        want = new bytes32[](4);
        want[0] = Transfer.selector;
        want[1] = RedeemReversed.selector;
        want[2] = PayoutBatchCancelled.selector;
        want[3] = ExitsClosed.selector;
        assertVaultLogs(logs, want);
        assertEq(vault.balanceOf(alice), 1e27 - 5e24, "alice's K shares back, her second redeem paid");
    }

    /// Where L3 reaches, frame by frame. A payout runs L3 twice from the vault, `prepare` then `finish`, and the
    /// walk (L2) from the vault itself, between them, never from L3. `prepare` touches no storage and calls only
    /// the payout math by DELEGATECALL (verify, takeChunk, deductFee) and the vault-passed bridge's fee quote, by
    /// STATICCALL. `finish` writes only the vault's reservation and the batch, then makes one call, the send of
    /// net + fee to the bridge. A cancel's L3 frame calls only the payout math's verify and writes only the
    /// vault's storage.
    function test_l3CallsOnlyTheBridgeAndThePayoutMath() public {
        (bytes32 key, CascadeMessages.Payout[] memory list) = queueDustAndWalk();
        vm.startStateDiffRecording();
        vault.processPayouts(key, list, 10);
        Vm.AccountAccess[] memory a = vm.stopAndReturnStateDiff();

        uint256[] memory l3 = framesInto(a, address(CascadePayoutLib));
        uint256[] memory l2 = framesInto(a, address(CascadeStakeLib));
        assertEq(l3.length, 2, "prepare and finish");
        assertEq(l2.length, 1, "one walk");
        assertEq(a[l2[0]].depth, a[l3[0]].depth, "the vault runs the walk, not L3");
        assertEq(a[l3[1]].depth, a[l3[0]].depth);
        assertTrue(l3[0] < l2[0] && l2[0] < l3[1], "the walk between L3's halves");

        // prepare: no storage; the payout math three times, the fee quote once
        (uint256[] memory own, uint256[] memory calls) = frameParts(a, l3[0]);
        for (uint256 i; i < own.length; ++i) {
            assertEq(a[own[i]].storageAccesses.length, 0, "prepare touches no storage");
        }
        assertEq(calls.length, 4, "prepare's calls");
        uint256 maths;
        for (uint256 i; i < calls.length; ++i) {
            Vm.AccountAccess memory c = a[calls[i]];
            if (c.kind == VmSafe.AccountAccessKind.DelegateCall) {
                assertEq(c.account, address(CascadePayoutMath), "prepare delegates only to the payout math");
                assertEq(c.storageAccesses.length, 0, "the payout math touches no storage");
                ++maths;
            } else {
                assertEq(uint256(c.kind), uint256(VmSafe.AccountAccessKind.StaticCall), "the fee quote is read-only");
                assertEq(c.account, address(bridge), "the vault-passed bridge");
            }
        }
        assertEq(maths, 3, "verify, takeChunk, deductFee");

        // finish: the vault's reservation and the batch, then the send
        (own, calls) = frameParts(a, l3[1]);
        bytes32 pendingSlot = bytes32(VaultLayout.SLOT_LEDGER + VaultLayout.LEDGER_PENDING_SLOT);
        uint256 writes;
        for (uint256 i; i < own.length; ++i) {
            for (uint256 j; j < a[own[i]].storageAccesses.length; ++j) {
                VmSafe.StorageAccess memory s = a[own[i]].storageAccesses[j];
                assertEq(s.account, address(vault), "finish touches only the vault's storage");
                if (!s.isWrite) continue;
                ++writes;
                bool batch;
                for (uint256 m; m < 4; ++m) {
                    if (s.slot == batchSlot(key, m)) batch = true;
                }
                assertTrue(s.slot == pendingSlot || batch, "finish writes the reservation and the batch only");
            }
        }
        assertGt(writes, 0);
        assertEq(calls.length, 1, "finish's one call");
        assertEq(uint256(a[calls[0]].kind), uint256(VmSafe.AccountAccessKind.Call));
        assertEq(a[calls[0]].account, address(bridge), "the send");
        assertEq(a[calls[0]].value, 1_665_666_666e9 + 1e15, "net + fee");

        // a cancel: the payout math's verify, and the vault's storage only
        vm.startStateDiffRecording();
        vm.prank(owner);
        vault.cancelPayoutBatch(K, listK());
        a = vm.stopAndReturnStateDiff();
        l3 = framesInto(a, address(CascadePayoutLib));
        assertEq(l3.length, 1);
        (own, calls) = frameParts(a, l3[0]);
        assertEq(calls.length, 1, "cancel's one call");
        assertEq(uint256(a[calls[0]].kind), uint256(VmSafe.AccountAccessKind.DelegateCall));
        assertEq(a[calls[0]].account, address(CascadePayoutMath), "verify");
        for (uint256 i; i < own.length; ++i) {
            for (uint256 j; j < a[own[i]].storageAccesses.length; ++j) {
                assertEq(a[own[i]].storageAccesses[j].account, address(vault), "cancel touches only the vault's");
            }
        }
    }

    /// The indexes of `a`'s DELEGATECALL frames into `lib`.
    function framesInto(Vm.AccountAccess[] memory a, address lib) internal pure returns (uint256[] memory found) {
        uint256 n;
        for (uint256 i; i < a.length; ++i) {
            if (a[i].kind == VmSafe.AccountAccessKind.DelegateCall && a[i].account == lib) ++n;
        }
        found = new uint256[](n);
        n = 0;
        for (uint256 i; i < a.length; ++i) {
            if (a[i].kind == VmSafe.AccountAccessKind.DelegateCall && a[i].account == lib) found[n++] = i;
        }
    }

    /// Frame `i` of `a`: `own`, its entry and each entry where it resumed after a call (its storage accesses), and
    /// `calls`, the calls and creations it made, one level down (each a frame of its own; an account read such as
    /// a code-size check is neither).
    function frameParts(Vm.AccountAccess[] memory a, uint256 i)
        internal
        pure
        returns (uint256[] memory own, uint256[] memory calls)
    {
        uint64 depth = a[i].depth;
        uint256 end = i + 1;
        while (
            end < a.length
                && (a[end].depth > depth || (a[end].kind == VmSafe.AccountAccessKind.Resume && a[end].depth == depth))
        ) {
            ++end;
        }
        uint256 nOwn;
        uint256 nCalls;
        for (uint256 j = i; j < end; ++j) {
            if (a[j].depth == depth) ++nOwn;
            else if (a[j].depth == depth + 1 && isCall(a[j].kind)) ++nCalls;
        }
        own = new uint256[](nOwn);
        calls = new uint256[](nCalls);
        (nOwn, nCalls) = (0, 0);
        for (uint256 j = i; j < end; ++j) {
            if (a[j].depth == depth) own[nOwn++] = j;
            else if (a[j].depth == depth + 1 && isCall(a[j].kind)) calls[nCalls++] = j;
        }
    }

    function isCall(VmSafe.AccountAccessKind k) internal pure returns (bool) {
        return k == VmSafe.AccountAccessKind.Call || k == VmSafe.AccountAccessKind.DelegateCall
            || k == VmSafe.AccountAccessKind.CallCode || k == VmSafe.AccountAccessKind.StaticCall
            || k == VmSafe.AccountAccessKind.Create || k == VmSafe.AccountAccessKind.SelfDestruct;
    }
}
