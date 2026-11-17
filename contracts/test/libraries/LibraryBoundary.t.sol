// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm, VmSafe} from "forge-std/Vm.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeBatchLib} from "../../src/libraries/CascadeBatchLib.sol";
import {CascadeHotkeyLib} from "../../src/libraries/CascadeHotkeyLib.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {CascadePayoutLib} from "../../src/libraries/CascadePayoutLib.sol";
import {CascadePayoutMath} from "../../src/libraries/CascadePayoutMath.sol";
import {CascadeStakeLib} from "../../src/libraries/CascadeStakeLib.sol";
import {ICascadeBridge, ICascadeReceiver} from "../../src/interfaces/ICascadeBridge.sol";
import {ISTAKING_ADDRESS, IStaking} from "../../src/interfaces/IStaking.sol";
import {VaultLayout} from "../../src/lens/generated/VaultLayout.sol";
import {BatchIn, PayoutBatch, PayoutIn, PayoutPlan, WalkParams} from "../../src/CascadeTypes.sol";
import {DIRECT_ORIGIN, GLOBAL_WINDOW} from "../../src/CascadeConstants.sol";
import {
    DirectTransferNotAllowed,
    NotEligible,
    NotPending,
    PayoutsMismatch,
    TransferFailed,
    UnstakeShort
} from "../../src/CascadeErrors.sol";
import {HotkeyAdded, HotkeyRemoved} from "../../src/CascadeEvents.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {mirror} from "../mocks/Mirror.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {VaultInternals} from "../utils/VaultInternals.sol";
import {LibraryLink, LibraryLinks} from "../utils/generated/LibraryLinks.sol";
import {LinkedLibraries} from "../utils/LinkedLibraries.sol";
import {Schedule} from "../governance/Schedule.sol";

/// A stand-in for the vault: runs `data` on `lib` by DELEGATECALL, in its own (empty) storage, and takes value.
contract BoundaryStandIn {
    function run(address lib, bytes calldata data) external returns (bool ok, bytes memory ret) {
        (ok, ret) = lib.delegatecall(data);
    }

    receive() external payable {}
}

/// Re-enters each of the vault's eight lock-guarded entry points (its `nonReentrant` functions: stakeIdle, adoptStake,
/// claimRewards, depositDirect, redeemDirect, onBridgeMessage, processPayouts, cancelPayoutBatch), from this contract's
/// address, whenever `probe` runs while armed, and records what each returned; cancelPayoutBatch's call is made as the
/// owner (a prank), so its owner check passes and the lock is what refuses it. With `bubble`, the first refused
/// re-entry's revert bubbles up; with `transfer`, it also sends the vault 1 wei, plainly (receive()). It plays each
/// party the boundary calls that could re-enter: the primary bridge (`send`, L3's finish), the caller L3 refunds
/// (`forward`, then `receive`, finish's last statement), and, through ReenteringStaking, the staking precompile in a
/// removal (L2's walk).
contract LockProbe is ICascadeBridge {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private immutable vault;
    address private immutable owner;
    address private immutable door;
    bytes32 public key;
    bool public armed;
    bool public bubble;
    bool public transfer;
    /// Fix round 1: also, whenever `probe` runs, a stranger's addHotkey (an entry point outside the lock), recorded on
    /// its own (`addOk`, `addRet`); and a write to the vault's storage of its own (setRedeemOrigin, outside the lock).
    bool public strangerAdd;
    bool public writeOrigin;
    bool public addOk;
    bytes public addRet;
    uint256 public fee;
    /// How many times `probe` re-entered.
    uint256 public probes;
    bool[] private _oks;
    bytes[] private _rets;

    constructor(address vault_, address owner_, address door_) {
        vault = vault_;
        owner = owner_;
        door = door_;
    }

    /// Re-enter from now on, naming batch `key_` where an entry point takes one.
    function arm(bytes32 key_, bool bubble_, bool transfer_) external {
        (key, armed, bubble, transfer) = (key_, true, bubble_, transfer_);
    }

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function setStrangerAdd(bool on) external {
        strangerAdd = on;
    }

    function setWriteOrigin(bool on) external {
        writeOrigin = on;
    }

    /// How many times tryAdd ran.
    uint256 public adds;

    /// addHotkey(HK5) from this contract, a stranger: recorded.
    function tryAdd() public {
        ++adds;
        (addOk, addRet) = vault.call(abi.encodeCall(CascadeVault.addHotkey, (bytes32(uint256(5)))));
    }

    /// The eight re-entries, in a fixed order.
    function reentries() public view returns (bytes[] memory c) {
        CascadeMessages.Payout[] memory none;
        c = new bytes[](8);
        c[0] = abi.encodeCall(CascadeVault.stakeIdle, ());
        c[1] = abi.encodeCall(CascadeVault.adoptStake, ());
        c[2] = abi.encodeCall(CascadeVault.claimRewards, (bytes32(uint256(1))));
        c[3] = abi.encodeCall(CascadeVault.depositDirect, ());
        c[4] = abi.encodeCall(CascadeVault.redeemDirect, (1, false));
        c[5] = abi.encodeCall(ICascadeReceiver.onBridgeMessage, (8453, door, "", 0));
        c[6] = abi.encodeCall(CascadeVault.processPayouts, (key, none, 0));
        c[7] = abi.encodeCall(CascadeVault.cancelPayoutBatch, (key, none));
    }

    function probe() public {
        if (strangerAdd) tryAdd();
        if (writeOrigin) {
            (bool ok,) = vault.call(abi.encodeCall(CascadeVault.setRedeemOrigin, (DIRECT_ORIGIN)));
            require(ok, "setRedeemOrigin");
        }
        if (!armed) return;
        ++probes;
        delete _oks;
        delete _rets;
        bytes[] memory c = reentries();
        for (uint256 i; i < c.length; ++i) {
            if (i == 7) vm.prank(owner);
            (bool ok, bytes memory ret) = vault.call(c[i]);
            _record(ok, ret);
        }
        if (transfer) {
            (bool ok, bytes memory ret) = vault.call{value: 1}("");
            _record(ok, ret);
        }
    }

    function results() external view returns (bool[] memory, bytes[] memory) {
        return (_oks, _rets);
    }

    // ---- as the primary bridge ----

    function send(uint64, address, bytes calldata, uint256) external payable {
        probe();
    }

    function quoteFee(uint64, address, bytes calldata, uint256) external view returns (uint256) {
        return fee;
    }

    function maxMessageValue() external pure returns (uint256) {
        return 5_000e18;
    }

    // ---- as the caller L3 refunds ----

    /// Calls `to` with `data` and this call's value, as this contract; bubbles a revert.
    function forward(address to, bytes calldata data) external payable {
        (bool ok, bytes memory ret) = to.call{value: msg.value}(data);
        if (!ok) _bubble(ret);
    }

    receive() external payable {
        probe();
    }

    function _record(bool ok, bytes memory ret) private {
        _oks.push(ok);
        _rets.push(ret);
        if (bubble && !ok) _bubble(ret);
    }

    function _bubble(bytes memory ret) private pure {
        assembly ("memory-safe") {
            revert(add(ret, 32), mload(ret))
        }
    }
}

/// The staking precompile, re-entering: etched at ISTAKING_ADDRESS over MockStaking, it runs MockStaking's code by
/// DELEGATECALL in its own storage (every position and setting stays where it was), and before each removal
/// (removeStake, removeStakeFull) runs its probe: a precompile that called back into the vault mid-walk, before paying
/// its TAO by a call into the vault's receive(). The real precompile is runtime code, not EVM code, and cannot.
contract ReenteringStaking {
    address private immutable impl;
    LockProbe private immutable lockProbe;

    constructor(address impl_, LockProbe probe_) {
        impl = impl_;
        lockProbe = probe_;
    }

    fallback() external payable {
        if (msg.sig == IStaking.removeStake.selector || msg.sig == IStaking.removeStakeFull.selector) {
            lockProbe.probe();
        }
        (bool ok, bytes memory ret) = impl.delegatecall(msg.data);
        assembly ("memory-safe") {
            if iszero(ok) { revert(add(ret, 32), mload(ret)) }
            return(add(ret, 32), mload(ret))
        }
    }
}

/// A linked library run through (test_eachLibraryWritesOnlyItsDeclaredFields only): etched at the library's linked
/// address, it runs the library's own code, copied to `code`, by DELEGATECALL (so in its caller's context, with its
/// caller's msg.sender and msg.value, as before), then makes an empty STATICCALL to `marker` and returns what the code
/// returned. The STATICCALL closes the library's records in Foundry's state diff, so every write its caller makes after
/// it returns is filed under the caller.
contract LibraryRunThrough {
    address private immutable code;
    address private immutable marker;

    constructor(address code_, address marker_) {
        code = code_;
        marker = marker_;
    }

    fallback() external payable {
        (bool ok, bytes memory ret) = code.delegatecall(msg.data);
        (bool closed,) = marker.staticcall("");
        require(closed);
        assembly ("memory-safe") {
            if iszero(ok) { revert(add(ret, 32), mload(ret)) }
            return(add(ret, 32), mload(ret))
        }
    }
}

/// The library boundary (spec §8.1, §9.1, I-32; Task 42a), consolidated. A linked library is also deployed on its own,
/// and anyone can call it:
///   - every non-view function of L1 to L4, called directly at its linked address, with or without value, stops at the
///     compiler's call guard: no data, no value kept, nothing read, written or logged, the vault untouched (L4's, run
///     by DELEGATECALL from a stand-in, then runs on the stand-in's own storage; L1's to L3's do so in their files);
///   - every view or pure function (the payout math's three) runs when called directly with value, on the library's
///     own empty storage, keeps the value (a library's balance is informational, never a verify failure or a keeper
///     stop: rev 12 L-4), emits nothing and leaves the vault unchanged;
///   - library code writes only the fields of the vault's storage spec §8.1 gives it, frame by frame (ruling DB8);
///   - re-entry across the boundary meets the vault's lock, from each party library code calls that could re-enter: the
///     primary bridge's send and the caller's refund (L3), and the staking precompile in a removal (L2), whose TAO
///     receive() takes only while the vault's unstake flag is set; L4 calls nothing but the precompile.
/// script/library-rules.mjs (BOUNDARY_TESTS) checks that every external function of each linked library in the build
/// (its methodIdentifiers) is named here by its selector, so a function added to a library fails the build checks
/// until it is covered.
/// And I-32's run-time half (Task 34a, ruling DB9), on a deployed CascadeVault and on VaultInternals, the subclass the
/// invariant campaigns deploy (which assert the same in their setUp, through BoundaryInvariants): the vault's code
/// names the deployed L1, L2, L3 and L4 at its generated link offsets, L3's names the deployed payout math, and the
/// code at each linked address is that library's deployed code. The check fails on a moved offset and on a library
/// whose code is not its own. Runs under [profile.parity] (VaultInternals may pass EIP-170).
contract LibraryBoundaryTest is VaultTestBase {
    /// The vault's lock refusing a re-entry.
    bytes constant LOCKED = abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);

    /// External, so a test can expect the check itself to fail.
    function check(address vault_, LibraryLink[] memory links) external view {
        LinkedLibraries.assertLinked(vault_, links);
    }

    function test_theVaultLinksTheDeployedLibraries() public view {
        LinkedLibraries.assertLinked(address(vault), LibraryLinks.cascadeVault());
        // each reference names the library this test was linked against, as forge deployed it
        LibraryLink[] memory links = LibraryLinks.cascadeVault();
        (string[] memory names, address[] memory addrs) = LinkedLibraries.assertLinks(address(vault), links);
        address[4] memory expected =
            [address(CascadeBatchLib), address(CascadeHotkeyLib), address(CascadePayoutLib), address(CascadeStakeLib)];
        assertEq(names.length, 4, "the vault links L1, L2, L3 and L4");
        for (uint256 i; i < 4; ++i) {
            assertEq(addrs[i], expected[i], names[i]);
        }
        (string[] memory names3, address[] memory addrs3) =
            LinkedLibraries.assertLinks(address(CascadePayoutLib), LibraryLinks.cascadePayoutLib());
        assertEq(names3.length, 1, "L3 links the payout math alone");
        assertEq(names3[0], "CascadePayoutMath");
        assertEq(addrs3[0], address(CascadePayoutMath));
    }

    function test_theSubclassTheCampaignsDeployLinksTheSameLibraries() public {
        VaultInternals internals = new VaultInternals(vaultParams());
        LinkedLibraries.assertLinked(address(internals), LibraryLinks.vaultInternals());
        (, address[] memory atSubclass) = LinkedLibraries.assertLinks(address(internals), LibraryLinks.vaultInternals());
        (, address[] memory atVault) = LinkedLibraries.assertLinks(address(vault), LibraryLinks.cascadeVault());
        assertEq(atSubclass, atVault, "one deployment of each library");
        // its own offsets: the vault's would read other bytes of the subclass's code
        vm.expectRevert();
        this.check(address(internals), LibraryLinks.cascadeVault());
    }

    /// The check is not vacuous: a link offset moved by a byte, an offset that names another library, and a library
    /// whose code at its linked address is not its deployed code each fail it.
    function test_theCheckFailsOnAMovedOffsetAndOnForeignCode() public {
        LibraryLink[] memory links = LibraryLinks.cascadeVault();
        ++links[0].offsets[0];
        vm.expectRevert();
        this.check(address(vault), links);

        links = LibraryLinks.cascadeVault();
        // L1's name on L2's offsets
        links[0].offsets = links[3].offsets;
        vm.expectRevert();
        this.check(address(vault), links);

        // L3's code replaced by L1's at L3's address
        vm.etch(address(CascadePayoutLib), address(CascadeBatchLib).code);
        vm.expectRevert();
        this.check(address(vault), LibraryLinks.cascadeVault());
    }

    // ---- direct calls: every external function of L1 to L4 and the payout math (BOUNDARY_TESTS) ----

    /// Every non-view function of L1 (deliver), L2 (unstake), L3 (prepare, finish, cancel) and L4 (add, remove, move),
    /// called directly at its linked address with well-formed calldata (storage pointers travel as slot numbers),
    /// stops at the compiler's call guard, with and without value: it reverts with no data, keeps no value, reads,
    /// writes and logs nothing, and never reaches the vault. That it is the guard: the same calldata run by
    /// DELEGATECALL from a stand-in, on its own storage, gets past it. deliver, unstake, prepare and L4's add, move and
    /// remove run; finish and cancel revert in their bodies, with data (the stand-in's reservation of 0 underflows,
    /// Panic 0x11; it holds no batch, NotPending). An empty revert alone could also be a decoding failure.
    function test_everyNonViewLibraryFunctionStopsAtTheCallGuard() public {
        BoundaryStandIn standIn = new BoundaryStandIn();
        // L1 to L3 run on a stand-in of their own (L1's mint would fill the slots L4's list uses below)
        BoundaryStandIn other = new BoundaryStandIn();
        bytes32 own = mirror(address(standIn));

        // L1, the batch path
        bytes memory deliver_ = abi.encodeWithSelector(
            CascadeBatchLib.deliver.selector,
            uint256(0),
            uint256(1),
            uint256(2),
            batchIn(),
            CascadeMessages.encodeBatch(1, entries1(alice, 1e18), noEntries())
        );
        assertStopsAtTheGuard(address(CascadeBatchLib), deliver_);
        assertPastTheGuard(other, address(CascadeBatchLib), deliver_, "");

        // L2, the walk
        bytes32[] memory set = new bytes32[](1);
        set[0] = HK3;
        WalkParams memory p = WalkParams({
            hotkeys: set, first: HK3, coldkey: own, margin: 0, shortfallToleranceWei: 1_000e9, unstakeGas: 400_000
        });
        bytes memory unstake_ = abi.encodeWithSelector(CascadeStakeLib.unstake.selector, p, 1e18);
        assertStopsAtTheGuard(address(CascadeStakeLib), unstake_);
        assertPastTheGuard(other, address(CascadeStakeLib), unstake_, "");

        // L3, the payout engine
        (bytes32 key, CascadeMessages.Payout[] memory list, PayoutIn memory input) = payoutCall();
        PayoutPlan memory plan;
        plan.taken = 1;
        plan.sum = 1e18;
        plan.received = 1e18;
        bytes memory prepare_ = abi.encodeWithSelector(CascadePayoutLib.prepare.selector, key, list, uint32(0), input);
        bytes memory finish_ =
            abi.encodeWithSelector(CascadePayoutLib.finish.selector, uint256(2), uint256(3), key, list, input, plan);
        bytes memory cancel_ = abi.encodeWithSelector(
            CascadePayoutLib.cancel.selector, uint256(0), uint256(2), uint256(3), key, list, uint256(0)
        );
        assertStopsAtTheGuard(address(CascadePayoutLib), prepare_);
        assertStopsAtTheGuard(address(CascadePayoutLib), finish_);
        assertStopsAtTheGuard(address(CascadePayoutLib), cancel_);
        assertPastTheGuard(other, address(CascadePayoutLib), prepare_, "");
        assertPastTheGuard(other, address(CascadePayoutLib), finish_, abi.encodeWithSignature("Panic(uint256)", 0x11));
        assertPastTheGuard(other, address(CascadePayoutLib), cancel_, abi.encodeWithSelector(NotPending.selector));

        // L4, hotkey management
        bytes memory add = abi.encodeWithSelector(
            CascadeHotkeyLib.add.selector, uint256(0), uint256(1), uint256(2), HK3, true, own, uint256(0), uint256(0)
        );
        bytes memory move = abi.encodeWithSelector(CascadeHotkeyLib.move.selector, true, HK3, HK1, uint256(0), own, HK1);
        bytes memory remove = abi.encodeWithSelector(
            CascadeHotkeyLib.remove.selector,
            uint256(0),
            uint256(1),
            HK3,
            true,
            true,
            false,
            own,
            HK1,
            uint256(0),
            uint256(0),
            uint256(0)
        );
        assertStopsAtTheGuard(address(CascadeHotkeyLib), add);
        assertStopsAtTheGuard(address(CascadeHotkeyLib), move);
        assertStopsAtTheGuard(address(CascadeHotkeyLib), remove);

        // the same calldata, by DELEGATECALL, runs in the stand-in's context: its list (slot 0), isHotkey (1) and
        // lastClaimAt (2), its HotkeyAdded and HotkeyRemoved
        vm.recordLogs();
        (bool ok,) = standIn.run(address(CascadeHotkeyLib), add);
        assertTrue(ok, "add by DELEGATECALL runs");
        assertEq(uint256(vm.load(address(standIn), bytes32(0))), 1, "listed on the stand-in's own list");
        assertEq(vm.load(address(standIn), keccak256(abi.encode(uint256(0)))), HK3);
        (ok,) = standIn.run(address(CascadeHotkeyLib), move);
        assertTrue(ok, "move by DELEGATECALL runs (nothing to move)");
        (ok,) = standIn.run(address(CascadeHotkeyLib), remove);
        assertTrue(ok, "remove by DELEGATECALL runs");
        assertEq(uint256(vm.load(address(standIn), bytes32(0))), 0, "removed from the stand-in's list");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2);
        assertEq(logs[0].topics[0], HotkeyAdded.selector);
        assertEq(logs[1].topics[0], HotkeyRemoved.selector);
        assertEq(logs[0].emitter, address(standIn), "from the caller's address");
        assertEq(logs[1].emitter, address(standIn));
    }

    /// Every pure function of the payout math (verify, takeChunk, deductFee) runs when called directly with value: on
    /// the library's own empty storage (it reads and writes none), its results as by DELEGATECALL, nothing logged, the
    /// vault never reached; and the library keeps the value, which nothing can take back out (rev 12 L-4: a library's
    /// balance is informational, never a verify failure or a keeper stop). A plain transfer or an unknown function
    /// reverts, and so does a pure function that fails, keeping nothing: a view or pure function called with value is
    /// the only way to leave value at a library.
    function test_everyPureLibraryFunctionKeepsTheValueAndTouchesNothing() public {
        address lib = address(CascadePayoutMath);
        uint256 start = lib.balance;
        // a bounce (0 shares) and a redeem
        CascadeMessages.Payout[] memory list = new CascadeMessages.Payout[](2);
        list[0] = CascadeMessages.Payout(alice, 0, 1e18);
        list[1] = CascadeMessages.Payout(bob, 1e24, 2e18);
        bytes32 h = CascadePayoutMath.hashStep(CascadePayoutMath.hashStep(bytes32(0), alice, 0, 1e18), bob, 1e24, 2e18);

        bytes memory ret = assertKeepsTheValue(
            lib, abi.encodeWithSelector(CascadePayoutMath.verify.selector, list, uint256(2), h), 1e18
        );
        assertEq(ret.length, 0, "verify returns nothing: the list checks");

        ret = assertKeepsTheValue(
            lib,
            abi.encodeWithSelector(
                CascadePayoutMath.takeChunk.selector, list, uint256(0), uint256(10), uint256(5_000e18), uint256(1)
            ),
            2e18
        );
        (CascadeMessages.Entry[] memory entries, uint256 sum) = abi.decode(ret, (CascadeMessages.Entry[], uint256));
        assertEq(entries.length, 2, "both entries");
        assertEq(sum, 3e18);

        ret = assertKeepsTheValue(
            lib,
            abi.encodeWithSelector(
                CascadePayoutMath.deductFee.selector, list, uint256(0), uint256(2), uint256(3e15), uint256(3e18)
            ),
            3e18
        );
        (CascadeMessages.Entry[] memory kept, CascadeMessages.Entry[] memory dust, uint256 net) =
            abi.decode(ret, (CascadeMessages.Entry[], CascadeMessages.Entry[], uint256));
        // each entry pays its share of 3e15: alice 1e15, bob 2e15
        assertEq(kept.length, 2);
        assertEq(dust.length, 0);
        assertEq(kept[0].amount, 999e15);
        assertEq(kept[1].amount, 1_998e15);
        assertEq(net, 2_997e15);

        assertEq(lib.balance, start + 6e18, "the library keeps what it was sent");
        // nothing else takes value: a plain transfer, an unknown function, a pure function that fails
        vm.deal(address(this), 3);
        (bool ok,) = lib.call{value: 1}("");
        assertFalse(ok, "a library has no receive()");
        (ok,) = lib.call{value: 1}(abi.encodeWithSignature("sweep()"));
        assertFalse(ok, "nor a fallback");
        (ok, ret) = lib.call{value: 1}(abi.encodeWithSelector(CascadePayoutMath.verify.selector, list, uint256(1), h));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(PayoutsMismatch.selector), "a failing pure function reverts");
        assertEq(lib.balance, start + 6e18, "and keeps nothing");
    }

    /// `data` called directly at `lib`, without and with value: reverted at the call guard (no data), no value kept,
    /// no storage read or written, no call made, nothing logged, the vault never reached and unchanged.
    function assertStopsAtTheGuard(address lib, bytes memory data) internal {
        assertGt(lib.code.length, 0, "deployed at its linked address");
        uint256 balance = lib.balance;
        bytes32 before = vaultPrint();
        vm.deal(address(this), address(this).balance + 1e18);
        vm.recordLogs();
        vm.startStateDiffRecording();
        (bool ok, bytes memory ret) = lib.call(data);
        (bool okValue, bytes memory retValue) = lib.call{value: 1e18}(data);
        Vm.AccountAccess[] memory a = vm.stopAndReturnStateDiff();
        assertEq(vm.getRecordedLogs().length, 0, "nothing logged");
        assertFalse(ok, "a direct call reverts");
        assertEq(ret.length, 0, "at the call guard: no data");
        assertFalse(okValue, "with value too");
        assertEq(retValue.length, 0, "at the call guard");
        assertEq(lib.balance, balance, "no value kept");
        assertTouchesNothing(a, lib);
        assertEq(vaultPrint(), before, "the vault unchanged");
    }

    /// `data` run on `lib` by DELEGATECALL from `standIn`, on the stand-in's own storage: it gets past the call guard, so
    /// it runs (`revertData` empty) or reverts in the library's body with `revertData`, never with the guard's empty
    /// revert.
    function assertPastTheGuard(BoundaryStandIn standIn, address lib, bytes memory data, bytes memory revertData)
        internal
    {
        (bool ok, bytes memory ret) = standIn.run(lib, data);
        if (revertData.length == 0) assertTrue(ok, "by DELEGATECALL, past the guard: it runs");
        else assertEq(ret, revertData, "by DELEGATECALL, past the guard: it reverts in its body, with data");
        assertTrue(ok || ret.length != 0, "by DELEGATECALL, past the guard: it runs, or reverts with data");
    }

    /// `data` called directly at `lib` with `value`: it runs, on no storage, keeps `value`, logs nothing and leaves the
    /// vault unchanged; returns what it returned.
    function assertKeepsTheValue(address lib, bytes memory data, uint256 value) internal returns (bytes memory ret) {
        uint256 balance = lib.balance;
        bytes32 before = vaultPrint();
        vm.deal(address(this), address(this).balance + value);
        vm.recordLogs();
        vm.startStateDiffRecording();
        bool ok;
        (ok, ret) = lib.call{value: value}(data);
        Vm.AccountAccess[] memory a = vm.stopAndReturnStateDiff();
        assertTrue(ok, "a view or pure function runs when called directly, with value");
        assertEq(vm.getRecordedLogs().length, 0, "it emits nothing");
        assertEq(lib.balance, balance + value, "and keeps the value");
        assertTouchesNothing(a, lib);
        for (uint256 s; s < 4; ++s) {
            assertEq(vm.load(lib, bytes32(s)), bytes32(0), "the library's own storage is empty");
        }
        assertEq(vaultPrint(), before, "the vault unchanged");
    }

    /// Every access in `a` is the call into `lib` itself: no storage read or written, no other account called, the
    /// vault never reached.
    function assertTouchesNothing(Vm.AccountAccess[] memory a, address lib) internal view {
        assertGt(a.length, 0);
        for (uint256 i; i < a.length; ++i) {
            assertEq(a[i].storageAccesses.length, 0, "no storage read or written");
            assertTrue(a[i].account != address(vault), "the vault is never reached");
            if (isCall(a[i].kind)) assertEq(a[i].account, lib, "no call out");
        }
    }

    /// A well-formed BatchIn for L1's direct call.
    function batchIn() internal view returns (BatchIn memory) {
        return BatchIn({
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
    }

    /// A well-formed key, one-entry list and PayoutIn for L3's direct calls.
    function payoutCall()
        internal
        view
        returns (bytes32 key, CascadeMessages.Payout[] memory list, PayoutIn memory input)
    {
        key = keccak256("stand-in");
        list = new CascadeMessages.Payout[](1);
        list[0] = CascadeMessages.Payout(alice, 1e24, 1e18);
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
        input = PayoutIn({
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
    }

    // ---- the storage each library writes (spec §8.1; ruling DB8) ----

    /// What a library's frames may write of the vault's storage: `fields` (each of which the run must see written), for
    /// the frames into `code` (where the library's code runs) whose calldata starts with `selector` (0: every frame).
    struct WriteRule {
        address code;
        bytes4 selector;
        string[] fields;
        bool[] seen;
        uint256 frames;
    }

    /// Each library's code writes only the fields of the vault's storage spec §8.1 gives it, read from the vault's own
    /// runs: every write in every DELEGATECALL frame of each library's code (its entry and each time it resumes after a
    /// call; the payout math's frames under L3 are their own), named by the generated layout (VaultLayout) over the
    /// keys the run uses:
    ///   - L1's deliver: the share supply and balances, the holders' records (the redeem origins and, since R4 B-H1, the
    ///     fresh shares, in one slot) and the burn windows (the door's and the global one);
    ///   - L2's unstake: nothing;
    ///   - L3: prepare nothing; finish the payout queue and the ledger's reservation; cancel those and the shares;
    ///   - L4: add the hotkey list, isHotkey and lastClaimAt; remove the list and isHotkey; move nothing;
    ///   - the payout math: nothing.
    /// Every field each may write is written in the run, so the table is not vacuous. The run: the owner lists HK2; a
    /// scheduled moveStake of nothing; deliveries mint and burn; a payout walks and sends; a cancel re-mints; the owner
    /// removes HK2. Foundry's state diff files a caller's storage accesses after a callee returns under the callee's
    /// last resume record when the callee accessed storage (a read is enough) after its own last call (L3's cancel
    /// does, so the vault's own stamp and lock reset would read as L3's). So, here only, each of L1 to L4 runs through LibraryRunThrough at its linked address: its
    /// own code, copied to a side address, by DELEGATECALL, then an empty STATICCALL that closes its records. The
    /// context, the caller, the value and the events are the vault's, as before.
    function test_eachLibraryWritesOnlyItsDeclaredFields() public {
        staking.setOneRaoShort(false);
        address[4] memory libs =
            [address(CascadeBatchLib), address(CascadeStakeLib), address(CascadePayoutLib), address(CascadeHotkeyLib)];
        address[4] memory code;
        address marker = makeAddr("the run-through's marker");
        for (uint256 i; i < 4; ++i) {
            code[i] = makeAddr(string.concat("library code ", vm.toString(i)));
            vm.etch(code[i], libs[i].code);
            vm.etch(libs[i], address(new LibraryRunThrough(code[i], marker)).code);
        }
        WriteRule[] memory rules = writeRules(code);
        bytes32[] memory keys = new bytes32[](2);

        vm.startStateDiffRecording();
        vm.prank(owner);
        vault.addHotkey(HK2);
        Schedule.run(vault, owner, abi.encodeCall(vault.moveStake, (HK2, HK1, 1e9)));
        depositVia(alice, 100e18);
        vm.prank(keeper);
        vault.stakeIdle();
        // alice's shares held a day, so a door burns them (the door hold, R4 B-H1)
        vm.warp(vm.getBlockTimestamp() + 1 days);
        // bob's 1 TAO stays liquid, so alice's 10 TAO payout walks
        keys[0] = deliver(BASE, frontDoor, ++nextBatchId, entries1(bob, 1e18), entries1(alice, 10e24));
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        CascadeMessages.Payout[] memory list = new CascadeMessages.Payout[](1);
        list[0] = CascadeMessages.Payout(alice, 10e24, 10e18);
        vault.processPayouts(keys[0], list, 0);
        keys[1] = deliver(BASE, frontDoor, ++nextBatchId, noEntries(), entries1(alice, 5e24));
        list[0] = CascadeMessages.Payout(alice, 5e24, vaultLens.getPayoutBatch(keys[1]).remaining);
        vm.prank(owner);
        vault.cancelPayoutBatch(keys[1], list);
        vm.prank(owner);
        vault.removeHotkey(HK2, true);
        checkWrites(vm.stopAndReturnStateDiff(), rules, keys);

        for (uint256 r; r < rules.length; ++r) {
            string memory name = ruleName(rules[r]);
            assertGt(rules[r].frames, 0, string.concat("no frame of ", name));
            for (uint256 f; f < rules[r].fields.length; ++f) {
                assertTrue(rules[r].seen[f], string.concat(name, " never wrote ", rules[r].fields[f], " in the run"));
            }
        }
    }

    /// The frame scan refuses a write it cannot attribute (fix round 1, M3): the precompile, re-entering, writes the
    /// vault's storage mid-walk (its own redeem origin, through setRedeemOrigin, which is outside the lock), in a record
    /// below L2's frame. The scan refuses it; the same run without that write passes.
    function test_aVaultWriteBelowALibraryFrameIsRefused() public {
        staking.setOneRaoShort(false);
        depositDirect(alice, 100e18);
        vm.prank(keeper);
        vault.stakeIdle();
        LockProbe probe = new LockProbe(address(vault), owner, frontDoor);
        vm.etch(ISTAKING_ADDRESS, address(new ReenteringStaking(address(new MockStaking()), probe)).code);
        WriteRule[] memory rules = new WriteRule[](1);
        rules[0] = writeRule(address(CascadeStakeLib), bytes4(0), new string[](0));
        uint256 id = vm.snapshotState();

        vm.startStateDiffRecording();
        vm.prank(alice);
        vault.redeemDirect(10e24, false);
        // passes: L2 writes nothing, and nothing below its frame writes the vault's storage
        this.checkWritesOf(vm.stopAndReturnStateDiff(), rules);
        vm.revertToState(id);

        probe.setWriteOrigin(true);
        vm.startStateDiffRecording();
        vm.prank(alice);
        vault.redeemDirect(10e24, false);
        Vm.AccountAccess[] memory a = vm.stopAndReturnStateDiff();
        assertEq(vaultLens.redeemOrigin(address(probe)), DIRECT_ORIGIN, "the vault's storage was written mid-walk");
        try this.checkWritesOf(a, rules) {
            assertTrue(false, "a vault write below L2's frame must be refused");
        } catch Error(string memory why) {
            bytes memory head = bytes("a write to the vault's storage below ");
            bytes memory got = bytes(why);
            assertGt(got.length, head.length);
            for (uint256 i; i < head.length; ++i) {
                assertEq(got[i], head[i], why);
            }
        }
    }

    /// §8.1's write sets, by library function, with L1 to L4's code at `code`.
    function writeRules(address[4] memory code) internal pure returns (WriteRule[] memory r) {
        r = new WriteRule[](9);
        r[0] = writeRule(code[0], bytes4(0), list4("totalSupply", "balanceOf", "holders", "burnWindows"));
        r[1] = writeRule(code[1], bytes4(0), new string[](0));
        r[2] = writeRule(code[2], CascadePayoutLib.prepare.selector, new string[](0));
        r[3] = writeRule(code[2], CascadePayoutLib.finish.selector, list2("payoutBatches", "ledger.pending"));
        r[4] = writeRule(
            code[2],
            CascadePayoutLib.cancel.selector,
            list4("payoutBatches", "ledger.pending", "totalSupply", "balanceOf")
        );
        r[5] = writeRule(code[3], CascadeHotkeyLib.add.selector, list3("hotkeys", "isHotkey", "lastClaimAt"));
        r[6] = writeRule(code[3], CascadeHotkeyLib.remove.selector, list2("hotkeys", "isHotkey"));
        r[7] = writeRule(code[3], CascadeHotkeyLib.move.selector, new string[](0));
        r[8] = writeRule(address(CascadePayoutMath), bytes4(0), new string[](0));
    }

    function writeRule(address code, bytes4 selector, string[] memory fields) internal pure returns (WriteRule memory) {
        return WriteRule({code: code, selector: selector, fields: fields, seen: new bool[](fields.length), frames: 0});
    }

    function list2(string memory a, string memory b) internal pure returns (string[] memory x) {
        x = new string[](2);
        (x[0], x[1]) = (a, b);
    }

    function list3(string memory a, string memory b, string memory c) internal pure returns (string[] memory x) {
        x = new string[](3);
        (x[0], x[1], x[2]) = (a, b, c);
    }

    function list4(string memory a, string memory b, string memory c, string memory d)
        internal
        pure
        returns (string[] memory x)
    {
        x = new string[](4);
        (x[0], x[1], x[2], x[3]) = (a, b, c, d);
    }

    /// "<code address> <selector>" for a rule.
    function ruleName(WriteRule memory r) internal pure returns (string memory) {
        return string.concat(vm.toString(r.code), " ", vm.toString(abi.encodePacked(r.selector)));
    }

    /// The rule for a DELEGATECALL frame into `code` with calldata `data`: the one of its selector, else the code's
    /// (selector 0), else none (type(uint256).max).
    function ruleOf(WriteRule[] memory rules, address code, bytes memory data) internal pure returns (uint256 any) {
        any = type(uint256).max;
        // casting to 'bytes4' is safe because it keeps the calldata's first four bytes, the selector, by design
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes4 selector = bytes4(data);
        for (uint256 r; r < rules.length; ++r) {
            if (rules[r].code != code) continue;
            if (rules[r].selector == selector) return r;
            if (rules[r].selector == bytes4(0)) any = r;
        }
    }

    /// Checks every write to the vault's storage, not reverted, in each DELEGATECALL frame `a` holds of a rule's code
    /// (its entry and each resume record at its depth, until the frame ends) against the rule, marking each field seen
    /// and counting the frames. Within the frame's span, a record deeper than the frame (a callee's, a nested library's,
    /// a re-entry into the vault) must hold no write to the vault's storage (fix round 1, M3): Foundry files a caller's
    /// accesses after a callee returns under the callee's last resume record when the callee accessed storage after its
    /// own last call, so a library's write could land in a deeper record, unread; a write there is refused instead.
    function checkWrites(Vm.AccountAccess[] memory a, WriteRule[] memory rules, bytes32[] memory keys) internal view {
        for (uint256 i; i < a.length; ++i) {
            if (a[i].kind != VmSafe.AccountAccessKind.DelegateCall) continue;
            uint256 r = ruleOf(rules, a[i].account, a[i].data);
            if (r == type(uint256).max) continue;
            ++rules[r].frames;
            uint64 depth = a[i].depth;
            for (uint256 j = i; j < a.length; ++j) {
                if (
                    j > i && a[j].depth <= depth
                        && !(a[j].kind == VmSafe.AccountAccessKind.Resume && a[j].depth == depth)
                ) break;
                for (uint256 k; k < a[j].storageAccesses.length; ++k) {
                    VmSafe.StorageAccess memory s = a[j].storageAccesses[k];
                    if (s.account != address(vault) || !s.isWrite || s.reverted) continue;
                    if (a[j].depth != depth) refuseDeeper(rules[r], a[j], s.slot);
                    markWrite(rules[r], fieldOf(s.slot, keys));
                }
            }
        }
    }

    /// Refuses a write to the vault's storage in a record below rule `r`'s frame.
    function refuseDeeper(WriteRule memory r, Vm.AccountAccess memory access, bytes32 slot) internal pure {
        revert(deeperWrite(r, access, slot));
    }

    /// What a write to the vault's storage in a record below rule `r`'s frame reads as.
    function deeperWrite(WriteRule memory r, Vm.AccountAccess memory access, bytes32 slot)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            "a write to the vault's storage below ",
            ruleName(r),
            "'s frame (at depth ",
            vm.toString(access.depth),
            ", slot ",
            vm.toString(slot),
            "): the frame scan cannot attribute it"
        );
    }

    /// checkWrites, from outside, so a test can catch its refusal.
    function checkWritesOf(Vm.AccountAccess[] memory a, WriteRule[] memory rules) external view {
        checkWrites(a, rules, new bytes32[](0));
    }

    /// Marks `field` written under rule `r`, which must list it.
    function markWrite(WriteRule memory r, string memory field) internal pure {
        bool listed;
        for (uint256 f; f < r.fields.length; ++f) {
            if (keccak256(bytes(r.fields[f])) == keccak256(bytes(field))) (listed, r.seen[f]) = (true, true);
        }
        assertTrue(listed, string.concat(ruleName(r), " wrote ", field, ", outside its fields"));
    }

    /// The vault field `slot` belongs to, by the generated layout, over the run's users, peers, batch keys and hotkeys;
    /// "slot <n>" when none.
    function fieldOf(bytes32 slot, bytes32[] memory keys) internal view returns (string memory) {
        uint256 s = uint256(slot);
        if (s == VaultLayout.SLOT_SHARES + VaultLayout.SHARES_DATA_TOTAL_SUPPLY_SLOT) return "totalSupply";
        if (s == VaultLayout.SLOT_LEDGER + VaultLayout.LEDGER_PENDING_SLOT) return "ledger.pending";
        if (s == VaultLayout.SLOT_LEDGER + VaultLayout.LEDGER_BOOKED_SLOT) return "ledger.booked";
        if (s == VaultLayout.SLOT_LEDGER + VaultLayout.LEDGER_RAMPING_SLOT) return "ledger.ramping";
        if (s == VaultLayout.SLOT_HOTKEYS) return "hotkeys";
        uint256 first = uint256(keccak256(abi.encode(VaultLayout.SLOT_HOTKEYS)));
        if (s >= first && s < first + 4) return "hotkeys";
        address[4] memory users = [alice, bob, carol, frontDoor];
        for (uint256 i; i < users.length; ++i) {
            if (
                slot
                    == keccak256(
                        abi.encode(users[i], VaultLayout.SLOT_SHARES + VaultLayout.SHARES_DATA_BALANCE_OF_SLOT)
                    )
            ) {
                return "balanceOf";
            }
            if (slot == keccak256(abi.encode(users[i], VaultLayout.SLOT_HOLDERS))) return "holders";
        }
        bytes32[2] memory peers = [vaultLens.peerId(BASE, frontDoor), GLOBAL_WINDOW];
        for (uint256 i; i < peers.length; ++i) {
            uint256 w = uint256(keccak256(abi.encode(peers[i], VaultLayout.SLOT_BURN_WINDOWS)));
            if (s == w + VaultLayout.WINDOW_START_SLOT || s == w + VaultLayout.WINDOW_BURNED_SLOT) {
                return "burnWindows";
            }
        }
        for (uint256 i; i < keys.length; ++i) {
            uint256 b = uint256(keccak256(abi.encode(keys[i], VaultLayout.SLOT_PAYOUT_BATCHES)));
            if (s >= b && s <= b + VaultLayout.PAYOUT_BATCH_PAYOUTS_HASH_SLOT) return "payoutBatches";
            if (slot == keccak256(abi.encode(keys[i], VaultLayout.SLOT_PROCESSED))) return "processed";
        }
        bytes32[5] memory hks = [HK1, HK2, HK3, HK4, HK5];
        for (uint256 i; i < hks.length; ++i) {
            if (slot == keccak256(abi.encode(hks[i], VaultLayout.SLOT_IS_HOTKEY))) return "isHotkey";
            if (slot == keccak256(abi.encode(hks[i], VaultLayout.SLOT_LAST_CLAIM_AT))) return "lastClaimAt";
        }
        return string.concat("slot ", vm.toString(slot));
    }

    // ---- re-entry across the boundary meets the vault's lock ----

    /// L3's send, the payout's one call to the bridge, re-entering: with the probe as the primary bridge, its send
    /// re-enters each of the vault's eight lock-guarded entry points and sends 1 wei back; each re-entry is refused by
    /// the lock and the 1 wei by receive() (the unstake flag is clear across a bridge call). Caught, the payout ends
    /// exactly as a plain one does (the same state, the same logs); bubbled, the lock's revert reverts it whole, and
    /// nothing moved. (Spec §9.1's re-entrant payout recipient is on Base, behind the bridge and the front door: the
    /// vault's call that could reach it is this send.)
    function test_aReentrantBridgeSendMeetsTheLock() public {
        (bytes32 k, CascadeMessages.Payout[] memory list) = queueAlicesRedeem();
        // a second batch for the re-entries to name, delivered while the stub bridge is still the primary
        bytes32 k2 = deliver(BASE, frontDoor, ++nextBatchId, noEntries(), entries1(alice, 1e25));
        LockProbe probe = new LockProbe(address(vault), owner, frontDoor);
        probe.setFee(1e15);
        vm.deal(address(probe), 1);
        makePrimary(address(probe));
        bytes32[] memory keys = new bytes32[](2);
        (keys[0], keys[1]) = (k, k2);
        bytes memory call = abi.encodeCall(CascadeVault.processPayouts, (k, list, 0));
        assertReentryMeetsTheLock(probe, address(this), call, 0, k2, keys, LOCKED, true);
    }

    /// L3's refund to the caller, finish's last statement, re-entering: the probe calls processPayouts with a value
    /// whose refund (the fee is within the ceiling, so all of it) enters its receive(), which re-enters each guarded
    /// entry point and sends 1 wei back. Each is refused (the lock; receive(): the flag is clear); caught, the payout
    /// ends as a plain one does; bubbled, the refund fails and the payout reverts TransferFailed, nothing moved.
    function test_aReentrantRefundTargetMeetsTheLock() public {
        (bytes32 k, CascadeMessages.Payout[] memory list) = queueAlicesRedeem();
        bytes32 k2 = deliver(BASE, frontDoor, ++nextBatchId, noEntries(), entries1(alice, 1e25));
        LockProbe probe = new LockProbe(address(vault), owner, frontDoor);
        bytes32[] memory keys = new bytes32[](2);
        (keys[0], keys[1]) = (k, k2);
        bytes memory call = abi.encodeCall(CascadeVault.processPayouts, (k, list, 0));
        assertReentryMeetsTheLock(
            probe, address(probe), call, 1e16, k2, keys, abi.encodeWithSelector(TransferFailed.selector), true
        );
    }

    /// L2's removals, the staking precompile's calls, re-entering: the precompile, re-entering (ReenteringStaking over
    /// MockStaking), runs the probe before each removal of redeemDirect's walk and of processPayouts' (the vault's own,
    /// between L3's halves), then pays its TAO by a call into receive(), which takes it: the vault's unstake flag is
    /// set around L2's call. Each re-entry is refused by the lock; caught, the exit ends exactly as a plain one does;
    /// bubbled, the walk skips the refused removal (spec §3.8) and the exit reverts UnstakeShort, nothing moved. After
    /// the walk the flag is clear and receive() refuses value.
    function test_thePrecompilesTaoInsideL2MeetsTheLock() public {
        staking.setOneRaoShort(false);
        depositDirect(alice, 100e18);
        depositVia(bob, 50e18);
        vm.prank(keeper);
        vault.stakeIdle();
        bytes32 k = deliver(BASE, frontDoor, ++nextBatchId, noEntries(), entries1(bob, 20e24));
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        LockProbe probe = new LockProbe(address(vault), owner, frontDoor);
        vm.etch(ISTAKING_ADDRESS, address(new ReenteringStaking(address(new MockStaking()), probe)).code);
        bytes32[] memory keys = new bytes32[](1);
        keys[0] = k;

        // redeemDirect's walk: alice's 70 TAO, with nothing liquid
        bytes memory redeem = abi.encodeCall(CascadeVault.redeemDirect, (70e24, false));
        assertReentryMeetsTheLock(
            probe, alice, redeem, 0, k, keys, abi.encodeWithSelector(UnstakeShort.selector), false
        );
        // processPayouts' walk: bob's 20 TAO
        CascadeMessages.Payout[] memory list = new CascadeMessages.Payout[](1);
        list[0] = CascadeMessages.Payout(bob, 20e24, 20e18);
        bytes memory pay = abi.encodeCall(CascadeVault.processPayouts, (k, list, 0));
        assertReentryMeetsTheLock(
            probe, address(this), pay, 0, k, keys, abi.encodeWithSelector(UnstakeShort.selector), false
        );

        // the walk paid its TAO into receive() under the flag; outside a walk receive() refuses it
        vm.prank(alice);
        vault.redeemDirect(70e24, false);
        assertEq(alice.balance, 70e18, "the precompile's TAO went in, mid-walk");
        vm.deal(carol, 1);
        vm.prank(carol);
        (bool ok, bytes memory ret) = address(vault).call{value: 1}("");
        assertFalse(ok, "after the walk, the flag is clear");
        assertEq(ret, abi.encodeWithSelector(DirectTransferNotAllowed.selector));
    }

    /// An entry point outside the lock (fix round 1, M5), reached from inside the bridge's send, behaves as it does
    /// outside a payout: a stranger's addHotkey is refused NotEligible both ways and lists nothing. The entry points
    /// outside the lock are safe mid-payout because L3's finish makes every effect before the send and the walk is
    /// booked before finish, so a re-entry sees the state a call after the payout would.
    function test_aStrangersAddHotkeyInsideTheSendIsRefusedAsOutside() public {
        (bytes32 k, CascadeMessages.Payout[] memory list) = queueAlicesRedeem();
        LockProbe probe = new LockProbe(address(vault), owner, frontDoor);
        probe.setFee(1e15);
        makePrimary(address(probe));
        probe.tryAdd();
        bytes memory outside = probe.addRet();
        assertFalse(probe.addOk());
        assertEq(outside, abi.encodeWithSelector(NotEligible.selector), "outside a payout: NotEligible");

        probe.setStrangerAdd(true);
        vault.processPayouts(k, list, 0);
        assertEq(probe.adds(), 2, "the add ran again, inside the send");
        assertFalse(probe.addOk(), "inside the send: refused");
        assertEq(probe.addRet(), outside, "as outside");
        assertFalse(vaultLens.isHotkey(HK5));
        assertEq(vaultLens.getPayoutBatch(k).count, 0, "and the payout completed");
    }

    /// L4, hotkey management, calls nothing but the staking precompile, on every path: the owner's add, a stranger's
    /// add while stake is missing (the permissionless way back), the scheduled moveStake, the owner's removal moving a
    /// leftover and removing one below the minimum (the direct removal), and the keeper's removal of an empty hotkey.
    /// Every call an L4 frame makes is to the precompile, with no value (a read by STATICCALL, a move or a removal by
    /// CALL); what comes back is only the precompile's TAO into receive(), on the owner's removal, under the flag the
    /// vault sets around it. So no L4 path calls code that could re-enter (the precompile is runtime code, not EVM
    /// code), and addHotkey, removeHotkey and moveStake stay outside the lock, as in v3.1 (spec §8.1).
    function test_hotkeyLibCallsOutOnlyToThePrecompile() public {
        staking.setOneRaoShort(false);
        depositDirect(alice, 100e18);
        vm.prank(keeper);
        vault.stakeIdle();
        bytes32 cold = vaultLens.coldkey();
        vm.startStateDiffRecording();
        vm.prank(owner);
        vault.addHotkey(HK2);
        vm.prank(owner);
        vault.addHotkey(HK3);
        staking.donateStake(HK2, cold, 5e9);
        staking.donateStake(HK3, cold, 1_000_000);
        Schedule.run(vault, owner, abi.encodeCall(vault.moveStake, (HK2, HK1, 1e9)));
        vm.prank(owner);
        vault.removeHotkey(HK2, true);
        vm.prank(owner);
        vault.removeHotkey(HK3, true);
        vm.prank(owner);
        vault.addHotkey(HK4);
        vm.prank(keeper);
        vault.removeHotkey(HK4, false);
        staking.swapHotkey(HK1, HK5, cold, 10_000);
        assertTrue(vaultLens.stakeMissing(), "a swap: stake is missing");
        vm.prank(carol);
        vault.addHotkey(HK5);
        Vm.AccountAccess[] memory a = vm.stopAndReturnStateDiff();
        assertTrue(vaultLens.isHotkey(HK5), "the stranger's add went through");

        uint256 frames;
        uint256 calls;
        uint256 payments;
        address cheats = address(vm);
        for (uint256 i; i < a.length; ++i) {
            if (a[i].kind != VmSafe.AccountAccessKind.DelegateCall || a[i].account != address(CascadeHotkeyLib)) {
                continue;
            }
            ++frames;
            uint64 depth = a[i].depth;
            for (uint256 j = i + 1; j < a.length; ++j) {
                if (a[j].depth <= depth && !(a[j].kind == VmSafe.AccountAccessKind.Resume && a[j].depth == depth)) {
                    break;
                }
                if (!isCall(a[j].kind) || a[j].account == cheats) continue;
                if (a[j].depth == depth + 1) {
                    assertEq(a[j].account, ISTAKING_ADDRESS, "L4 calls only the staking precompile");
                    assertEq(a[j].value, 0, "with no value");
                    assertTrue(
                        a[j].kind == VmSafe.AccountAccessKind.Call || a[j].kind == VmSafe.AccountAccessKind.StaticCall,
                        "by CALL or STATICCALL"
                    );
                    ++calls;
                } else {
                    // the precompile's own call: its TAO, into the vault's receive()
                    assertEq(a[j].account, address(vault), "only the vault is called back");
                    assertEq(a[j].data.length, 0, "into receive()");
                    assertGt(a[j].value, 0);
                    ++payments;
                }
            }
        }
        assertEq(frames, 8, "the owner's three adds, the stranger's, the move, three removals");
        assertGt(calls, frames, "the precompile's reads, the moves and the removal");
        assertEq(payments, 1, "the direct removal's TAO, into receive()");
    }

    // ---- helpers ----

    /// alice deposits 1,000 TAO through the front door, which the keeper stakes on HK1, then redeems 1e26 shares (100
    /// TAO): batch `k`, queued, its delay passed. The bridge's fee is 1e15.
    function queueAlicesRedeem() internal returns (bytes32 k, CascadeMessages.Payout[] memory list) {
        staking.setOneRaoShort(false);
        depositVia(alice, 1_000e18);
        vm.prank(keeper);
        vault.stakeIdle();
        bridge.setFee(1e15);
        k = deliver(BASE, frontDoor, ++nextBatchId, noEntries(), entries1(alice, 1e26));
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        list = new CascadeMessages.Payout[](1);
        list[0] = CascadeMessages.Payout(alice, 1e26, 100e18);
    }

    /// Lists `next` as a bridge (its activation scheduled and executed after the registry's delay) and makes it the
    /// primary: the owner disables the current one, then switches.
    function makePrimary(address next) internal {
        Schedule.run(vault, owner, abi.encodeCall(vault.activateBridge, (next)));
        vm.startPrank(owner);
        vault.disableBridge(vaultLens.primaryBridge());
        vault.setPrimaryBridge(next);
        vm.stopPrank();
    }

    /// `caller` calls the vault with `data` and `value` three times from one state: with `probe` disarmed (the plain
    /// run), armed to catch (each re-entry is refused by the lock, and, when `transfer`, its 1 wei by receive(); the
    /// world and the vault's logs end exactly as in the plain run), and armed to bubble (the call reverts `bubbled`,
    /// the world as it started). `probe` re-enters naming batch `key`; `keys` are the batches the world includes. The
    /// state returns to the start afterwards.
    function assertReentryMeetsTheLock(
        LockProbe probe,
        address caller,
        bytes memory data,
        uint256 value,
        bytes32 key,
        bytes32[] memory keys,
        bytes memory bubbled,
        bool transfer
    ) internal {
        uint256 id = vm.snapshotState();
        bytes32 start = world(keys, address(probe));

        // plain
        vm.recordLogs();
        callAs(probe, caller, data, value);
        bytes32 plain = world(keys, address(probe));
        bytes32 plainLogs = vaultLogs(vm.getRecordedLogs());
        assertTrue(plain != start, "the plain call moves the world");
        vm.revertToState(id);

        // caught: every re-entry refused at the lock, and the call ends as the plain one
        probe.arm(key, false, transfer);
        vm.recordLogs();
        callAs(probe, caller, data, value);
        assertEq(vaultLogs(vm.getRecordedLogs()), plainLogs, "the same logs as the plain call");
        assertEq(world(keys, address(probe)), plain, "nothing moved beyond the plain call");
        assertGt(probe.probes(), 0, "the probe re-entered");
        (bool[] memory oks, bytes[] memory rets) = probe.results();
        assertEq(oks.length, transfer ? 9 : 8);
        for (uint256 i; i < 8; ++i) {
            assertFalse(oks[i], string.concat("re-entry ", vm.toString(i), " refused"));
            assertEq(rets[i], LOCKED, string.concat("re-entry ", vm.toString(i), ": the vault's lock"));
        }
        if (transfer) {
            assertFalse(oks[8], "receive() refuses value outside an unstake");
            assertEq(rets[8], abi.encodeWithSelector(DirectTransferNotAllowed.selector));
        }
        vm.revertToState(id);

        // bubbled: the call reverts whole
        probe.arm(key, true, false);
        vm.expectRevert(bubbled);
        callAs(probe, caller, data, value);
        assertEq(world(keys, address(probe)), start, "nothing moved");
        vm.revertToState(id);
    }

    /// Calls the vault with `data` and `value` as `caller`: through the probe's forward when it is the probe, else by
    /// a prank; bubbles a revert.
    function callAs(LockProbe probe, address caller, bytes memory data, uint256 value) internal {
        bool ok;
        bytes memory ret;
        if (caller == address(probe)) {
            vm.deal(address(this), address(this).balance + value);
            (ok, ret) = address(probe).call{value: value}(abi.encodeCall(LockProbe.forward, (address(vault), data)));
        } else {
            vm.deal(caller, caller.balance + value);
            vm.prank(caller);
            (ok, ret) = address(vault).call{value: value}(data);
        }
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    /// A digest of the vault's fixed slots (0 to 44: the shares' supply, the lock, the roles, the bridges, the hotkey
    /// list's length, the ledger, every limit) and its balance.
    function vaultPrint() internal view returns (bytes32 h) {
        for (uint256 s; s <= VaultLayout.SLOT_IDLE_BUFFER_BPS; ++s) {
            h = keccak256(abi.encode(h, vm.load(address(vault), bytes32(s))));
        }
        h = keccak256(abi.encode(h, address(vault).balance));
    }

    /// A digest of what a payout or an exit can move: the vault's fixed slots and balance, each of `keys`' batches,
    /// the shares and balances of alice, bob, carol and `party`, the vault's stake on HK1 to HK3, and the stub bridge's
    /// balance and sends.
    function world(bytes32[] memory keys, address party) internal view returns (bytes32 h) {
        h = vaultPrint();
        for (uint256 i; i < keys.length; ++i) {
            uint256 b = uint256(keccak256(abi.encode(keys[i], VaultLayout.SLOT_PAYOUT_BATCHES)));
            for (uint256 m; m <= VaultLayout.PAYOUT_BATCH_PAYOUTS_HASH_SLOT; ++m) {
                h = keccak256(abi.encode(h, vm.load(address(vault), bytes32(b + m))));
            }
        }
        address[4] memory who = [alice, bob, carol, party];
        for (uint256 i; i < who.length; ++i) {
            h = keccak256(abi.encode(h, vault.balanceOf(who[i]), who[i].balance));
        }
        bytes32 cold = vaultLens.coldkey();
        bytes32[3] memory hks = [HK1, HK2, HK3];
        for (uint256 i; i < hks.length; ++i) {
            h = keccak256(abi.encode(h, staking.getStake(hks[i], cold, 0)));
        }
        h = keccak256(abi.encode(h, address(bridge).balance, bridge.sendCount()));
    }

    /// A digest of the vault's logs in `logs`: each one's topics and data, in order.
    function vaultLogs(Vm.Log[] memory logs) internal view returns (bytes32 h) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault)) h = keccak256(abi.encode(h, logs[i].topics, logs[i].data));
        }
    }

    function isCall(VmSafe.AccountAccessKind k) internal pure returns (bool) {
        return k == VmSafe.AccountAccessKind.Call || k == VmSafe.AccountAccessKind.DelegateCall
            || k == VmSafe.AccountAccessKind.CallCode || k == VmSafe.AccountAccessKind.StaticCall
            || k == VmSafe.AccountAccessKind.Create || k == VmSafe.AccountAccessKind.SelfDestruct;
    }
}
