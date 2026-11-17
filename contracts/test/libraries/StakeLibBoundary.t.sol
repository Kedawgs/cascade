// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm, VmSafe} from "forge-std/Vm.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeStakeLib} from "../../src/libraries/CascadeStakeLib.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {ISTAKING_ADDRESS} from "../../src/interfaces/IStaking.sol";
import {VaultLayout} from "../../src/lens/generated/VaultLayout.sol";
import {WalkParams} from "../../src/CascadeTypes.sol";
import {DirectTransferNotAllowed} from "../../src/CascadeErrors.sol";
import {Unstaked} from "../../src/CascadeEvents.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {mirror} from "../mocks/Mirror.sol";
import {VaultInternals} from "../utils/VaultInternals.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {Schedule} from "../governance/Schedule.sol";

/// A stand-in for the vault: runs `data` on `lib` by DELEGATECALL, in its own context.
contract StakeLibCaller {
    function run(address lib, bytes calldata data) external returns (bool ok, bytes memory ret) {
        (ok, ret) = lib.delegatecall(data);
    }

    /// The precompile's removals pay by a call with value (MockStaking's default since Task 35), as into the vault's
    /// receive() under its unstake flag.
    receive() external payable {}
}

/// @notice The unstake walk's boundary (spec §8.1, Task 5f): L2 `CascadeStakeLib` runs only by the vault's
/// DELEGATECALL, writes nothing, calls only the staking precompile, and leaves the ledger to its caller;
/// removeHotkey keeps its direct removal, and receive() takes the precompile's TAO only while the vault's
/// transient unstake flag is set.
contract StakeLibBoundaryTest is VaultTestBase {
    /// Exact stake reads. alice deposits 100 TAO directly and bob 50 TAO through the front door; the keeper
    /// stakes all 150 on HK1, then the owner lists HK2 and moves 100 TAO onto it: HK1 holds 50, HK2 100. The
    /// owner's three changes are scheduled items (Task 11): scheduled first, and executed, 48 hours on, right
    /// after the stake, so the stake's timing is as before. HK2 is listed first (setStakeHotkey names a listed
    /// hotkey, Task 14a).
    function setUp() public override {
        super.setUp();
        staking.setOneRaoShort(false);
        vm.prank(owner);
        vault.addHotkey(HK2);
        bytes[3] memory moves = [
            abi.encodeCall(vault.setStakeHotkey, (HK2)),
            abi.encodeCall(vault.moveStake, (HK1, HK2, 100e9)),
            abi.encodeCall(vault.setStakeHotkey, (HK1))
        ];
        vm.startPrank(owner);
        for (uint256 i; i < moves.length; ++i) {
            vault.schedule(moves[i]);
        }
        vm.stopPrank();
        Schedule.warpTo(vm.getBlockTimestamp() + 48 hours);
        depositDirect(alice, 100e18);
        depositVia(bob, 50e18);
        vm.prank(keeper);
        vault.stakeIdle();
        vm.startPrank(owner);
        for (uint256 i; i < moves.length; ++i) {
            vault.execute(moves[i]);
        }
        vm.stopPrank();
    }

    /// The vault is VaultInternals, which exposes the ledger no lens serves.
    function deployVault(CascadeVault.Params memory p) internal override returns (CascadeVault) {
        return new VaultInternals(p);
    }

    function internals() internal view returns (VaultInternals) {
        return VaultInternals(payable(address(vault)));
    }

    function stakeOf(bytes32 h) internal view returns (uint256) {
        return staking.getStake(h, vaultLens.coldkey(), 0);
    }

    /// A plain transfer of 1 wei to the vault: its revert data, empty when it went through.
    function plainTransfer() internal returns (bytes memory) {
        vm.deal(carol, 1);
        vm.prank(carol);
        (bool ok, bytes memory ret) = address(vault).call{value: 1}("");
        if (ok) assertEq(ret.length, 0);
        else assertGt(ret.length, 0);
        return ret;
    }

    /// Lists `h` holding `rao` of the vault's stake, under the minimum stake when `rao` < 2_000_000.
    function listWithStake(bytes32 h, uint256 rao) internal {
        vm.prank(owner);
        vault.addHotkey(h);
        staking.donateStake(h, vaultLens.coldkey(), rao);
    }

    /// The DELEGATECALL frames into L2 in `a` (one per walk): each touched no storage (L2 has no storage
    /// pointer and declares none), and every call it made went to the staking precompile, from the vault's
    /// address: `removals` CALLs in all (the removals) and STATICCALLs (the floor and stake reads).
    function assertWalksCallOnlyThePrecompile(Vm.AccountAccess[] memory a, uint256 walks, uint256 removals)
        internal
        view
    {
        address lib = address(CascadeStakeLib);
        uint256 frames;
        uint256 calls;
        uint256 reads;
        for (uint256 i; i < a.length; ++i) {
            if (a[i].kind != VmSafe.AccountAccessKind.DelegateCall || a[i].account != lib) continue;
            ++frames;
            uint64 depth = a[i].depth;
            // the frame's own accesses and those of each time it resumed after a call; then its calls,
            // one level down, until the vault resumes
            for (uint256 j = i; j < a.length; ++j) {
                if (
                    j > i && a[j].depth <= depth
                        && !(a[j].kind == VmSafe.AccountAccessKind.Resume && a[j].depth == depth)
                ) {
                    break;
                }
                if (a[j].depth == depth) {
                    assertEq(a[j].storageAccesses.length, 0, "L2 touches no storage");
                } else if (a[j].depth == depth + 1) {
                    assertEq(a[j].account, ISTAKING_ADDRESS, "L2 calls only the staking precompile");
                    // R1-C F-2: and sends it no value
                    assertEq(a[j].value, 0, "L2 calls the staking precompile with no value");
                    if (a[j].kind == VmSafe.AccountAccessKind.Call) {
                        assertEq(a[j].accessor, address(vault), "from the vault's address");
                        ++calls;
                    } else if (a[j].kind == VmSafe.AccountAccessKind.StaticCall) {
                        ++reads;
                    }
                }
            }
        }
        assertEq(frames, walks, "one DELEGATECALL into L2 per walk");
        assertEq(calls, removals, "the removals");
        assertGt(reads, 0, "the floor and stake reads");
    }

    // ---- the library boundary ----

    /// The compiler's call guard: called directly at its linked address, with or without value, `unstake`
    /// reverts with no data and keeps no value; the same calldata run by DELEGATECALL walks its caller's
    /// own position and pays its caller.
    function test_directCallToUnstakeReverts() public {
        address lib = address(CascadeStakeLib);
        assertGt(lib.code.length, 0, "L2 is deployed at its linked address");
        StakeLibCaller caller = new StakeLibCaller();
        bytes32 own = mirror(address(caller));
        // the stand-in's own position: 10 TAO on HK3
        staking.donateStake(HK3, own, 10e9);
        bytes32[] memory set = new bytes32[](1);
        set[0] = HK3;
        WalkParams memory p = WalkParams({
            hotkeys: set, first: HK3, coldkey: own, margin: 0, shortfallToleranceWei: 1_000e9, unstakeGas: 400_000
        });
        bytes memory data = abi.encodeWithSelector(CascadeStakeLib.unstake.selector, p, 1e18);

        (bool ok, bytes memory ret) = lib.call(data);
        assertFalse(ok, "a direct call reverts");
        assertEq(ret.length, 0, "the call guard reverts with no data");
        vm.deal(address(this), 1e18);
        (ok, ret) = lib.call{value: 1e18}(data);
        assertFalse(ok, "a direct call with value reverts");
        assertEq(ret.length, 0);
        assertEq(lib.balance, 0);
        assertEq(staking.getStake(HK3, own, 0), 10e9, "nothing was removed");

        // the same calldata runs by DELEGATECALL, so what stopped it above is the guard: 1 TAO comes off
        // the caller's own position (its coldkey, as the precompile sees its address) and into its balance
        (ok, ret) = caller.run(lib, data);
        assertTrue(ok, "the same call by DELEGATECALL runs");
        (uint256 unmet, uint256 received, uint256 debit) = abi.decode(ret, (uint256, uint256, uint256));
        assertEq(unmet, 0);
        assertEq(received, 1e18);
        assertEq(debit, 1e9, "the stake that left the position, in rao");
        assertEq(address(caller).balance, 1e18);
        assertEq(staking.getStake(HK3, own, 0), 9e9);
    }

    /// redeemDirect's walk and processPayouts' (the vault's own, between the payout engine's two halves since
    /// Task 5g) run L2 by DELEGATECALL; L2 touches no storage and calls nothing but the staking precompile; its
    /// Unstaked events come from the vault; the vault books the walk (Task 12): the stake its removals took off
    /// the booked stake (rao), its receipts off the ramping stake (wei, as v3.1 did); here the two agree.
    function test_walkCallsOnlyThePrecompile() public {
        uint256 booked = internals().exposed_bookedStake();
        uint256 ramping = internals().exposed_rampingStake();

        // alice redeems 70 TAO with nothing liquid: HK1's 50 whole, then 20 of HK2's 100
        vm.recordLogs();
        vm.startStateDiffRecording();
        vm.prank(alice);
        vault.redeemDirect(70e24, false);
        Vm.AccountAccess[] memory a = vm.stopAndReturnStateDiff();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertWalksCallOnlyThePrecompile(a, 1, 2);
        assertEq(alice.balance, 70e18);
        assertEq(stakeOf(HK1), 0);
        assertEq(stakeOf(HK2), 80e9);
        assertUnstakedByTheVault(logs, 2);
        assertEq(internals().exposed_bookedStake(), booked - 70e9);
        assertEq(internals().exposed_rampingStake(), ramping - 70e18);
        assertFalse(internals().exposed_unstaking());

        // bob's front-door redeem of 20 TAO, paid a day later: its walk takes 20 TAO and the fee off HK2
        bytes32 key = deliver(BASE, frontDoor, ++nextBatchId, noEntries(), entries1(bob, 20e24));
        Schedule.warpTo(vm.getBlockTimestamp() + 24 hours);
        CascadeMessages.Payout[] memory list = new CascadeMessages.Payout[](1);
        list[0] = CascadeMessages.Payout(bob, 20e24, 20e18);
        vm.recordLogs();
        vm.startStateDiffRecording();
        vault.processPayouts(key, list, 0);
        a = vm.stopAndReturnStateDiff();
        logs = vm.getRecordedLogs();
        assertWalksCallOnlyThePrecompile(a, 1, 1);
        assertUnstakedByTheVault(logs, 1);
        // and the 1_000-rao shortfall tolerance on top (Task 19), which stays idle
        assertEq(stakeOf(HK2), 60e9 - 1_000, "the payout's 20 TAO, its fee included");
    }

    /// `count` Unstaked events, each logged by the vault, none by L2.
    function assertUnstakedByTheVault(Vm.Log[] memory logs, uint256 count) internal view {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].emitter != address(CascadeStakeLib), "no event comes from L2's address");
            if (logs[i].topics[0] == Unstaked.selector) {
                assertEq(logs[i].emitter, address(vault));
                ++n;
            }
        }
        assertEq(n, count, "Unstaked events");
    }

    // ---- what stays in the vault ----

    /// removeHotkey keeps v3.1's direct removal (spec §8.1): the chain's refusal reverts the whole call, and
    /// the hotkey stays listed with its stake. Allowed, the removal runs in the vault, not through L2, and
    /// debits the ledger as a walk does.
    function test_removeHotkeysRefusedRemovalStillReverts() public {
        // HK3 holds 1_000_000 rao, under the minimum stake: removeHotkey removes it directly
        listWithStake(HK3, 1_000_000);
        uint256 booked = internals().exposed_bookedStake();
        uint256 ramping = internals().exposed_rampingStake();

        staking.setUnstakeBlocked(true);
        vm.prank(owner);
        vm.expectRevert(MockStaking.TooEarly.selector);
        vault.removeHotkey(HK3, true);
        assertTrue(vaultLens.isHotkey(HK3), "still listed");
        assertEq(stakeOf(HK3), 1_000_000, "its stake untouched");
        assertFalse(internals().exposed_unstaking());

        staking.setUnstakeBlocked(false);
        uint256 balance = address(vault).balance;
        vm.recordLogs();
        vm.startStateDiffRecording();
        vm.prank(owner);
        vault.removeHotkey(HK3, true);
        Vm.AccountAccess[] memory a = vm.stopAndReturnStateDiff();
        assertUnstakedByTheVault(vm.getRecordedLogs(), 1);
        for (uint256 i; i < a.length; ++i) {
            assertFalse(
                a[i].kind == VmSafe.AccountAccessKind.DelegateCall && a[i].account == address(CascadeStakeLib),
                "removeHotkey does not run L2"
            );
        }
        assertFalse(vaultLens.isHotkey(HK3));
        assertEq(address(vault).balance, balance + 1e15);
        assertEq(internals().exposed_bookedStake(), booked - 1_000_000);
        assertEq(internals().exposed_rampingStake(), ramping - 1e15);
        assertFalse(internals().exposed_unstaking());
    }

    /// receive() takes value only while the vault's transient unstake flag is set: the walk's callers and
    /// removeHotkey set it around their removals, so receipts paid by a call go in; outside them, a plain
    /// transfer and a claim paid by a call are refused. The flag is set in the vault's frame and read by
    /// receive() in another frame of the vault's, called by the precompile from inside L2's DELEGATECALL:
    /// transient storage is per address, so L2 running in the vault's context shares it.
    function test_receiveOnlyWhileUnstaking() public {
        bytes memory refused = abi.encodeWithSelector(DirectTransferNotAllowed.selector);
        assertEq(plainTransfer(), refused);
        staking.setPayByCall(true);

        // redeemDirect's walk: the receipts enter receive() mid-walk, while the vault has the flag set
        // around L2's call
        vm.prank(alice);
        vault.redeemDirect(70e24, false);
        assertEq(alice.balance, 70e18);
        assertFalse(internals().exposed_unstaking(), "cleared after the walk");
        assertEq(plainTransfer(), refused);

        // processPayouts' walk, which the vault runs between L3's halves: bob's front-door redeem of 20 TAO, paid
        // a day later
        bytes32 key = deliver(BASE, frontDoor, ++nextBatchId, noEntries(), entries1(bob, 20e24));
        Schedule.warpTo(vm.getBlockTimestamp() + 24 hours);
        CascadeMessages.Payout[] memory list = new CascadeMessages.Payout[](1);
        list[0] = CascadeMessages.Payout(bob, 20e24, 20e18);
        vault.processPayouts(key, list, 0);
        // 20 TAO and the 1_000-rao shortfall tolerance (Task 19)
        assertEq(stakeOf(HK2), 60e9 - 1_000, "the walk's receipts went in");
        assertFalse(internals().exposed_unstaking());
        assertEq(plainTransfer(), refused);

        // and so do the receipts of removeHotkey's direct removal
        listWithStake(HK3, 1_000_000);
        uint256 balance = address(vault).balance;
        vm.prank(owner);
        vault.removeHotkey(HK3, true);
        assertEq(address(vault).balance, balance + 1e15);
        assertFalse(internals().exposed_unstaking());
        assertEq(plainTransfer(), refused);

        // a payment outside an unstake is refused: a claim the chain pays as balance, by a call
        staking.setClaimToBalance(true);
        staking.setUnclaimed(vaultLens.coldkey(), HK2, 1e9);
        vm.prank(keeper);
        vm.expectRevert(DirectTransferNotAllowed.selector);
        vault.claimRewards{gas: 60_000_000}(HK2);
    }

    /// The unstake flag is transient (the coordinator's ruling on 5f's concern 1): an exit that unstakes writes
    /// exactly the storage it changes (the reentrancy lock, the supply, the leaver's balance, the booked and
    /// the ramping stake) and no slot for the flag, and neither it nor removeHotkey's direct removal writes a
    /// vault slot from zero. A storage flag would be one more slot written, from zero in its own slot (about
    /// 20,000 gas up front, refunded only at the end of the transaction) or beside other state.
    function test_unstakeFlagTakesNoStorageSlot() public {
        // redeemDirect's walk, run through L2
        vm.startStateDiffRecording();
        vm.prank(alice);
        vault.redeemDirect(70e24, false);
        Vm.AccountAccess[] memory a = vm.stopAndReturnStateDiff();
        assertWalksCallOnlyThePrecompile(a, 1, 2);
        assertNoFreshVaultSlot(a);
        bytes32[] memory want = new bytes32[](5);
        want[0] = bytes32(VaultLayout.SLOT_STATUS);
        want[1] = bytes32(VaultLayout.SLOT_SHARES + VaultLayout.SHARES_DATA_TOTAL_SUPPLY_SLOT);
        want[2] = keccak256(abi.encode(alice, VaultLayout.SLOT_SHARES + VaultLayout.SHARES_DATA_BALANCE_OF_SLOT));
        want[3] = bytes32(VaultLayout.SLOT_LEDGER + VaultLayout.LEDGER_BOOKED_SLOT);
        want[4] = bytes32(VaultLayout.SLOT_LEDGER + VaultLayout.LEDGER_RAMPING_SLOT);
        assertVaultWritesExactly(a, want);

        // removeHotkey's direct removal
        listWithStake(HK3, 1_000_000);
        vm.startStateDiffRecording();
        vm.prank(owner);
        vault.removeHotkey(HK3, true);
        a = vm.stopAndReturnStateDiff();
        assertFalse(vaultLens.isHotkey(HK3));
        assertNoFreshVaultSlot(a);
    }

    /// The vault storage slots `a` writes (not reverted) are exactly `want`'s, in any order.
    function assertVaultWritesExactly(Vm.AccountAccess[] memory a, bytes32[] memory want) internal view {
        bool[] memory seen = new bool[](want.length);
        for (uint256 i; i < a.length; ++i) {
            for (uint256 j; j < a[i].storageAccesses.length; ++j) {
                VmSafe.StorageAccess memory s = a[i].storageAccesses[j];
                if (s.account != address(vault) || !s.isWrite || s.reverted) continue;
                bool listed;
                for (uint256 k; k < want.length; ++k) {
                    if (want[k] == s.slot) (listed, seen[k]) = (true, true);
                }
                assertTrue(listed, string.concat("an unexpected vault slot written: ", vm.toString(s.slot)));
            }
        }
        for (uint256 k; k < want.length; ++k) {
            assertTrue(seen[k], string.concat("a vault slot not written: ", vm.toString(want[k])));
        }
    }

    /// No write in `a` sets a slot of the vault's storage from zero.
    function assertNoFreshVaultSlot(Vm.AccountAccess[] memory a) internal view {
        uint256 writes;
        for (uint256 i; i < a.length; ++i) {
            for (uint256 j; j < a[i].storageAccesses.length; ++j) {
                VmSafe.StorageAccess memory s = a[i].storageAccesses[j];
                if (s.account != address(vault) || !s.isWrite || s.reverted) continue;
                ++writes;
                assertFalse(
                    s.previousValue == bytes32(0) && s.newValue != bytes32(0),
                    string.concat("a vault slot written from zero: ", vm.toString(s.slot))
                );
            }
        }
        assertGt(writes, 0, "the vault wrote its storage");
    }
}
