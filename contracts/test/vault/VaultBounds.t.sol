// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {ISTAKING_ADDRESS, IStaking} from "../../src/interfaces/IStaking.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {StubBridge} from "../mocks/StubBridge.sol";
import {Schedule} from "../governance/Schedule.sol";
import {AboveBridgeCap, FeeTooHigh, InvalidParameter, NotScheduled, UnknownSelector} from "../../src/CascadeErrors.sol";
import {ClaimGasSet, HotkeyRemoved, LimitSet, Unstaked} from "../../src/CascadeEvents.sol";

/// Task 23: the hard bounds of every exit limit (I-23: a tightening by the owner is never refused, and no setter
/// can reach a value outside its bounds), the vault's message limits against the bridge's own cap (spec §3.9,
/// AboveBridgeCap), the bounded claim gas, the staking floors' fallbacks as constants, and the dust allowance's
/// bound (the Task 14a carry: no owner value can overflow the removal's dust check and block I-6's way back).
/// The setters bound-tested elsewhere (Tasks 15, 17, 20, 21) are here only in the I-23 sweep. In its own file:
/// VaultCore.t.sol sits at via-IR's jump-tag limit.
contract VaultBoundsTest is VaultTestBase {
    bytes32 constant HK6 = bytes32(uint256(6));
    uint256 constant MIN_ENTRY_VALUE = 10e18;
    uint64 constant MIN_PAYOUT_DELAY = 1 hours;
    uint64 constant MAX_PAYOUT_DELAY = 48 hours;
    /// R5 M-4: the 53.2M a claimRootWithHotkey needs, reached through a call that forwards 63/64 of the gas left.
    uint256 constant MIN_CLAIM_GAS = 54_100_000;
    /// Task 65 (Revision 30): the most whose claim fits Bittensor's per-transaction limit, about 65,000,000 (75% of the
    /// block less 10% for initialization), with the claim's overhead and a margin (VaultClaimGas.t.sol).
    uint256 constant MAX_CLAIM_GAS = 63_400_000;
    /// The largest dust allowance whose product with RAO (1e9) fits a word.
    uint256 constant MAX_HOTKEY_DUST_RAO = type(uint256).max / 1e9;
    /// The I-23 sweep's base: the fixture's values (DefaultParams.sol) with the outflow floor and the fee ceiling's
    /// absolute part moved strictly inside their bounds (the fixture has them at their tops), so every bound on the
    /// loosening side is a real loosening from the base, never an equal value.
    uint256 constant SWEEP_MIN_DAILY = 50e18;
    uint256 constant SWEEP_FEE_ABS = 0.012e18;

    address stranger = makeAddr("stranger");

    /// Exact stake reads (no one-rao-short fresh position), and a sixth hotkey the chain knows.
    function setUp() public override {
        super.setUp();
        staking.setOneRaoShort(false);
        staking.addHotkey(HK6);
    }

    // ---- helpers ----

    /// The owner's `call` as a loosening: refused NotScheduled outside execute (so a tightening misread as a loosening,
    /// or a loosening misread as a tightening, fails here), then scheduled and executed 48 hours on. Whether it applied
    /// at execute, and the setter's revert data if not.
    function scheduledRun(bytes memory call, string memory what) internal returns (bool ok, bytes memory ret) {
        assertRefusedAtOnce(call, NotScheduled.selector, string.concat(what, " (a loosening: NotScheduled at once)"));
        vm.prank(owner);
        vault.schedule(call);
        Schedule.wait(48 hours);
        vm.prank(owner);
        (ok, ret) = address(vault).call(abi.encodeCall(vault.execute, (call)));
    }

    /// The owner's loosening `call` applies only as its scheduled item.
    function assertLooseningApplies(bytes memory call, string memory what) internal {
        (bool ok,) = scheduledRun(call, what);
        assertTrue(ok, what);
    }

    /// The owner's loosening `call` is refused NotScheduled at once and, scheduled, with `err` at execute.
    function assertLooseningRefused(bytes memory call, bytes4 err, string memory what) internal {
        (bool ok, bytes memory ret) = scheduledRun(call, what);
        assertFalse(ok, what);
        assertEq(ret, abi.encodeWithSelector(err), what);
    }

    /// The owner's `call` applies at once: no schedule (an immediate setter, or a tightening).
    function assertAppliesAtOnce(bytes memory call, string memory what) internal {
        vm.prank(owner);
        (bool ok,) = address(vault).call(call);
        assertTrue(ok, what);
    }

    /// The owner's `call` is refused at once with `err` (a tightening, or an immediate setter, past its bound).
    function assertRefusedAtOnce(bytes memory call, bytes4 err, string memory what) internal {
        vm.prank(owner);
        (bool ok, bytes memory ret) = address(vault).call(call);
        assertFalse(ok, what);
        assertEq(ret, abi.encodeWithSelector(err), what);
    }

    /// A vault on `p` (its coldkey the next CREATE's, as vaultParams() gives it) reverts `err`.
    function assertNotConstructed(CascadeVault.Params memory p, bytes4 err) internal {
        vm.expectRevert(err);
        new CascadeVault(p);
    }

    function messageLimits(uint256 entry, uint256 message, uint32 chunk) internal pure returns (bytes memory) {
        return abi.encodeCall(CascadeVault.setMessageLimits, (entry, message, chunk));
    }

    // ---- the I-23 sweep ----

    /// One bound of one setter: `atBound` sets it exactly, `pastBound` one unit past it, refused with `err`.
    /// `tightens`: the move from the sweep's base to the bound, and on past it, is a tightening, an equal value or an
    /// immediate setter's, so it applies, or is refused, at once (I-23: never refused for its direction); otherwise
    /// both moves are loosenings, refused NotScheduled outside execute and run as their scheduled items.
    struct Bound {
        string name;
        bool tightens;
        bytes atBound;
        bytes pastBound;
        bytes4 err;
    }

    function outflow(uint256 bps, uint256 minDaily, uint256 globalBps) internal pure returns (bytes memory) {
        return abi.encodeCall(CascadeVault.setOutflowLimits, (bps, minDaily, globalBps));
    }

    function fees(uint256 bps, uint256 abs_) internal pure returns (bytes memory) {
        return abi.encodeCall(CascadeVault.setFeeLimits, (bps, abs_));
    }

    /// Every bound of every bounded setter, by name (a setter missing here is missing from the list), each with its
    /// direction from the sweep's base. Each row changes only the value it bounds. Unbounded by design, so not here:
    /// setMaxTotalAssets (direct deposits only), setMinDirectDeposit and setKeeper (Appendix B).
    function bounds() internal view returns (Bound[] memory b) {
        b = new Bound[](26);
        bytes4 invalid = InvalidParameter.selector;
        uint256 d = SWEEP_MIN_DAILY;
        uint256 f = SWEEP_FEE_ABS;
        // a percentage at its floor is the base's value (equal: at once); the floor's past is down, a tightening
        b[0] = Bound(
            "setOutflowLimits bps >= MIN_OUTFLOW_BPS", true, outflow(2_000, d, 2_000), outflow(1_999, d, 2_000), invalid
        );
        b[1] = Bound(
            "setOutflowLimits bps <= MAX_OUTFLOW_BPS",
            false,
            outflow(5_000, d, 2_000),
            outflow(5_001, d, 2_000),
            invalid
        );
        b[2] = Bound(
            "setOutflowLimits minDaily >= MIN_MIN_DAILY_OUTFLOW",
            true,
            outflow(2_000, 10e18, 2_000),
            outflow(2_000, 10e18 - 1, 2_000),
            invalid
        );
        b[3] = Bound(
            "setOutflowLimits minDaily <= MAX_MIN_DAILY_OUTFLOW",
            false,
            outflow(2_000, 100e18, 2_000),
            outflow(2_000, 100e18 + 1, 2_000),
            invalid
        );
        b[4] = Bound(
            "setOutflowLimits globalBps >= MIN_OUTFLOW_BPS",
            true,
            outflow(2_000, d, 2_000),
            outflow(2_000, d, 1_999),
            invalid
        );
        b[5] = Bound(
            "setOutflowLimits globalBps <= MAX_OUTFLOW_BPS",
            false,
            outflow(2_000, d, 5_000),
            outflow(2_000, d, 5_001),
            invalid
        );
        b[6] = Bound(
            "setMessageLimits maxEntryValue >= MIN_ENTRY_VALUE",
            true,
            messageLimits(10e18, 4_000e18, 10),
            messageLimits(10e18 - 1, 4_000e18, 10),
            invalid
        );
        b[7] = Bound(
            "setMessageLimits maxEntryValue <= maxMessageValue",
            false,
            messageLimits(4_000e18, 4_000e18, 10),
            messageLimits(4_000e18 + 1, 4_000e18, 10),
            invalid
        );
        b[8] = Bound(
            "setMessageLimits maxMessageValue <= MAX_MESSAGE_VALUE",
            false,
            messageLimits(2_000e18, 5_000e18, 10),
            messageLimits(2_000e18, 5_000e18 + 1, 10),
            invalid
        );
        b[9] = Bound(
            "setMessageLimits minChunk >= 1",
            false,
            messageLimits(2_000e18, 4_000e18, 1),
            messageLimits(2_000e18, 4_000e18, 0),
            invalid
        );
        b[10] = Bound(
            "setMessageLimits minChunk <= MAX_ENTRIES",
            true,
            messageLimits(2_000e18, 4_000e18, 50),
            messageLimits(2_000e18, 4_000e18, 51),
            invalid
        );
        b[11] = Bound("setFeeLimits bps <= MAX_FEE_BPS", false, fees(500, f), fees(501, f), invalid);
        b[12] = Bound("setFeeLimits abs >= MIN_FEE_ABS", true, fees(100, 0.01e18), fees(100, 0.01e18 - 1), invalid);
        b[13] = Bound("setFeeLimits abs <= MAX_FEE_ABS", false, fees(100, 0.015e18), fees(100, 0.015e18 + 1), invalid);
        b[14] = Bound(
            "setPayoutDelay >= MIN_PAYOUT_DELAY",
            false,
            abi.encodeCall(vault.setPayoutDelay, (MIN_PAYOUT_DELAY)),
            abi.encodeCall(vault.setPayoutDelay, (MIN_PAYOUT_DELAY - 1)),
            invalid
        );
        b[15] = Bound(
            "setPayoutDelay <= MAX_PAYOUT_DELAY",
            true,
            abi.encodeCall(vault.setPayoutDelay, (MAX_PAYOUT_DELAY)),
            abi.encodeCall(vault.setPayoutDelay, (MAX_PAYOUT_DELAY + 1)),
            invalid
        );
        b[16] = Bound(
            "setRewardVesting >= 1 day",
            false,
            abi.encodeCall(vault.setRewardVesting, (1 days)),
            abi.encodeCall(vault.setRewardVesting, (1 days - 1)),
            invalid
        );
        b[17] = Bound(
            "setRewardVesting <= 30 days",
            true,
            abi.encodeCall(vault.setRewardVesting, (30 days)),
            abi.encodeCall(vault.setRewardVesting, (30 days + 1)),
            invalid
        );
        // a cut needs a treasury, and naming one loosens
        b[18] = Bound(
            "setRewardCut bps <= MAX_REWARD_CUT_BPS",
            false,
            abi.encodeCall(vault.setRewardCut, (alice, 2_000)),
            abi.encodeCall(vault.setRewardCut, (alice, 2_001)),
            FeeTooHigh.selector
        );
        b[19] = Bound(
            "setIdleBuffer <= MAX_IDLE_BUFFER_BPS",
            true,
            abi.encodeCall(vault.setIdleBuffer, (1_000)),
            abi.encodeCall(vault.setIdleBuffer, (1_001)),
            invalid
        );
        // the immediate setters: at once, both ways
        b[20] = Bound(
            "setUnstakeGas >= MIN_UNSTAKE_GAS",
            true,
            abi.encodeCall(vault.setUnstakeGas, (150_000)),
            abi.encodeCall(vault.setUnstakeGas, (150_000 - 1)),
            invalid
        );
        b[21] = Bound(
            "setUnstakeGas <= MAX_UNSTAKE_GAS",
            true,
            abi.encodeCall(vault.setUnstakeGas, (5_000_000)),
            abi.encodeCall(vault.setUnstakeGas, (5_000_000 + 1)),
            invalid
        );
        b[22] = Bound(
            "setUnstakeMarginRao <= MAX_UNSTAKE_MARGIN_RAO",
            true,
            abi.encodeCall(vault.setUnstakeMarginRao, (1e9)),
            abi.encodeCall(vault.setUnstakeMarginRao, (1e9 + 1)),
            invalid
        );
        b[23] = Bound(
            "setClaimGasRequired >= MIN_CLAIM_GAS",
            true,
            abi.encodeCall(vault.setClaimGasRequired, (MIN_CLAIM_GAS)),
            abi.encodeCall(vault.setClaimGasRequired, (MIN_CLAIM_GAS - 1)),
            invalid
        );
        b[24] = Bound(
            "setClaimGasRequired <= MAX_CLAIM_GAS",
            true,
            abi.encodeCall(vault.setClaimGasRequired, (MAX_CLAIM_GAS)),
            abi.encodeCall(vault.setClaimGasRequired, (MAX_CLAIM_GAS + 1)),
            invalid
        );
        b[25] = Bound(
            "setHotkeyDustRao <= MAX_HOTKEY_DUST_RAO",
            true,
            abi.encodeCall(vault.setHotkeyDustRao, (MAX_HOTKEY_DUST_RAO)),
            abi.encodeCall(vault.setHotkeyDustRao, (MAX_HOTKEY_DUST_RAO + 1)),
            invalid
        );
    }

    /// I-23 across every bounded setter, both halves: no setter reaches a value outside its bounds, and a tightening
    /// is never refused. Each row runs from the sweep's base (a snapshot). A tightening row's bound applies at once and
    /// one unit past it is refused at once with the row's error; a loosening row's bound is refused NotScheduled at
    /// once, then applies as its scheduled item 48 hours on, and one unit past it is refused NotScheduled at once and,
    /// scheduled, with the row's error at execute. So a direction misread either way fails the row. The bridge's cap is
    /// lifted out of the way, so the message limits meet the vault's own bounds (the bridge's: test_aboveBridgeCap).
    function test_boundsSweep_I23() public {
        bridge.setMaxMessageValue(type(uint256).max);
        assertAppliesAtOnce(outflow(2_000, SWEEP_MIN_DAILY, 2_000), "the sweep's outflow floor, a tightening");
        assertAppliesAtOnce(fees(100, SWEEP_FEE_ABS), "the sweep's fee ceiling, a tightening");
        Bound[] memory b = bounds();
        uint256 base = vm.snapshotState();
        for (uint256 i; i < b.length; ++i) {
            string memory atBound = string.concat(b[i].name, ": the bound itself");
            string memory pastBound = string.concat(b[i].name, ": one past it");
            if (b[i].tightens) {
                assertAppliesAtOnce(b[i].atBound, atBound);
                assertTrue(vm.revertToState(base));
                assertRefusedAtOnce(b[i].pastBound, b[i].err, pastBound);
            } else {
                assertLooseningApplies(b[i].atBound, atBound);
                assertTrue(vm.revertToState(base));
                assertLooseningRefused(b[i].pastBound, b[i].err, pastBound);
            }
            assertTrue(vm.revertToState(base));
        }
    }

    // ---- the setters bound here first ----

    /// setMessageLimits (Appendix B): maxEntryValue at least MIN_ENTRY_VALUE (10 TAO, so no owner setting can freeze
    /// front-door exits with a tiny entry limit) and at most maxMessageValue, minChunk 1 to MAX_ENTRIES (50); the
    /// constructor refuses what the setter refuses, and builds on each bound.
    function test_messageLimitBounds() public {
        // down is a tightening: at once, to the floor and not past it
        assertRefusedAtOnce(messageLimits(MIN_ENTRY_VALUE - 1, 4_000e18, 10), InvalidParameter.selector, "below 10 TAO");
        assertRefusedAtOnce(messageLimits(0, 4_000e18, 10), InvalidParameter.selector, "a zero entry limit");
        vm.expectEmit(address(vault));
        emit LimitSet(vault.setMessageLimits.selector, MIN_ENTRY_VALUE, MIN_ENTRY_VALUE);
        vm.expectEmit(address(vault));
        emit LimitSet(vault.setMessageLimits.selector, 50, 0);
        assertAppliesAtOnce(messageLimits(MIN_ENTRY_VALUE, MIN_ENTRY_VALUE, 50), "10 TAO a message, chunks of 50");
        assertEq(vaultLens.maxEntryValue(), MIN_ENTRY_VALUE);
        assertEq(vaultLens.maxMessageValue(), MIN_ENTRY_VALUE);
        assertEq(vaultLens.minChunk(), 50);
        assertRefusedAtOnce(messageLimits(MIN_ENTRY_VALUE, MIN_ENTRY_VALUE, 51), InvalidParameter.selector, "51");
        // minChunk down loosens: scheduled, to 1 and not to 0
        assertLooseningRefused(
            messageLimits(MIN_ENTRY_VALUE, MIN_ENTRY_VALUE, 0), InvalidParameter.selector, "a chunk of 0"
        );
        assertLooseningApplies(messageLimits(MIN_ENTRY_VALUE, MIN_ENTRY_VALUE, 1), "a chunk of 1");
        assertEq(vaultLens.minChunk(), 1);

        CascadeVault.Params memory p = vaultParams();
        p.maxEntryValue = MIN_ENTRY_VALUE - 1;
        assertNotConstructed(p, InvalidParameter.selector);
        p = vaultParams();
        p.minChunk = 51;
        assertNotConstructed(p, InvalidParameter.selector);
        p = vaultParams();
        p.maxEntryValue = MIN_ENTRY_VALUE;
        p.maxMessageValue = MIN_ENTRY_VALUE;
        p.minChunk = 1;
        new CascadeVault(p);
        p = vaultParams();
        p.minChunk = 50;
        new CascadeVault(p);
    }

    /// setPayoutDelay (Appendix B): MIN_PAYOUT_DELAY (1 hour) to MAX_PAYOUT_DELAY (48 hours). Up tightens, at once, to
    /// 48 hours and not past it; down loosens, scheduled, to 1 hour and not past it. The constructor likewise.
    function test_payoutDelayBounds() public {
        assertRefusedAtOnce(
            abi.encodeCall(vault.setPayoutDelay, (MAX_PAYOUT_DELAY + 1)), InvalidParameter.selector, "past 48 hours"
        );
        assertRefusedAtOnce(abi.encodeCall(vault.setPayoutDelay, (7 days)), InvalidParameter.selector, "v3.1's 7 days");
        vm.expectEmit(address(vault));
        emit LimitSet(vault.setPayoutDelay.selector, MAX_PAYOUT_DELAY, 0);
        assertAppliesAtOnce(abi.encodeCall(vault.setPayoutDelay, (MAX_PAYOUT_DELAY)), "48 hours");
        assertEq(vaultLens.payoutDelay(), MAX_PAYOUT_DELAY);
        assertLooseningRefused(
            abi.encodeCall(vault.setPayoutDelay, (MIN_PAYOUT_DELAY - 1)), InvalidParameter.selector, "under an hour"
        );
        assertLooseningApplies(abi.encodeCall(vault.setPayoutDelay, (MIN_PAYOUT_DELAY)), "an hour");
        assertEq(vaultLens.payoutDelay(), MIN_PAYOUT_DELAY);

        CascadeVault.Params memory p = vaultParams();
        p.payoutDelay = MAX_PAYOUT_DELAY + 1;
        assertNotConstructed(p, InvalidParameter.selector);
        p = vaultParams();
        p.payoutDelay = MIN_PAYOUT_DELAY - 1;
        assertNotConstructed(p, InvalidParameter.selector);
        p = vaultParams();
        p.payoutDelay = MAX_PAYOUT_DELAY;
        new CascadeVault(p);
        p = vaultParams();
        p.payoutDelay = MIN_PAYOUT_DELAY;
        new CascadeVault(p);
    }

    /// setClaimGasRequired (spec §3.9, round 9 L-3, Task 65): MIN_CLAIM_GAS (54.1M left, so the 53.2M section 2
    /// measured reaches the precompile through a call that forwards 63/64; the mainnet canary checks a real claim) to
    /// MAX_CLAIM_GAS (63.4M, the most whose claim fits Bittensor's per-transaction limit, about 65,000,000, with its
    /// overhead and a 1,000,000 margin), immediate both ways within them (no scheduler class: scheduling it is
    /// UnknownSelector), so no setting lets a claim start with less gas than the chain needs, or ask more than one
    /// transaction can carry. The constructor likewise; the lens serves MIN_CLAIM_GAS and MAX_CLAIM_GAS.
    function test_claimGasBounds() public {
        assertEq(vaultLens.MIN_CLAIM_GAS(), MIN_CLAIM_GAS);
        assertEq(vaultLens.MAX_CLAIM_GAS(), MAX_CLAIM_GAS);
        assertRefusedAtOnce(
            abi.encodeCall(vault.setClaimGasRequired, (MIN_CLAIM_GAS - 1)), InvalidParameter.selector, "below"
        );
        assertRefusedAtOnce(abi.encodeCall(vault.setClaimGasRequired, (0)), InvalidParameter.selector, "zero");
        vm.expectEmit(address(vault));
        emit ClaimGasSet(MIN_CLAIM_GAS);
        assertAppliesAtOnce(abi.encodeCall(vault.setClaimGasRequired, (MIN_CLAIM_GAS)), "down to the floor, at once");
        assertEq(vaultLens.claimGasRequired(), MIN_CLAIM_GAS);
        assertRefusedAtOnce(
            abi.encodeCall(vault.setClaimGasRequired, (MAX_CLAIM_GAS + 1)), InvalidParameter.selector, "above"
        );
        vm.expectEmit(address(vault));
        emit ClaimGasSet(MAX_CLAIM_GAS);
        assertAppliesAtOnce(abi.encodeCall(vault.setClaimGasRequired, (MAX_CLAIM_GAS)), "up to the top, at once");
        assertEq(vaultLens.claimGasRequired(), MAX_CLAIM_GAS);
        vm.prank(owner);
        vm.expectRevert(UnknownSelector.selector);
        vault.schedule(abi.encodeCall(vault.setClaimGasRequired, (MIN_CLAIM_GAS)));

        CascadeVault.Params memory p = vaultParams();
        p.claimGasRequired = MIN_CLAIM_GAS - 1;
        assertNotConstructed(p, InvalidParameter.selector);
        p = vaultParams();
        p.claimGasRequired = MAX_CLAIM_GAS + 1;
        assertNotConstructed(p, InvalidParameter.selector);
        p = vaultParams();
        p.claimGasRequired = MIN_CLAIM_GAS;
        new CascadeVault(p);
        p = vaultParams();
        p.claimGasRequired = MAX_CLAIM_GAS;
        new CascadeVault(p);
    }

    // ---- the bridge's cap (spec §3.9) ----

    /// maxMessageValue at most the primary bridge's maxMessageValue() (AboveBridgeCap), checked by the constructor, by
    /// setMessageLimits in either direction, and by setPrimaryBridge against the new primary; the cap itself is
    /// accepted everywhere. A bridge with a smaller cap becomes primary once the owner has tightened to it.
    function test_aboveBridgeCap() public {
        // the constructor, against its initial bridge (deployed before vaultParams() reads the next CREATE)
        StubBridge capped = new StubBridge(IERC20(address(0)));
        capped.setMaxMessageValue(15e18);
        CascadeVault.Params memory p = vaultParams();
        p.bridge = capped;
        p.maxEntryValue = MIN_ENTRY_VALUE;
        p.maxMessageValue = 15e18 + 1;
        assertNotConstructed(p, AboveBridgeCap.selector);
        p = vaultParams();
        p.bridge = capped;
        p.maxEntryValue = MIN_ENTRY_VALUE;
        p.maxMessageValue = 15e18;
        new CascadeVault(p);

        // setMessageLimits, against the primary's cap: up (a loosening, refused at execute), then to the cap
        bridge.setMaxMessageValue(4_500e18);
        assertLooseningRefused(messageLimits(2_000e18, 4_500e18 + 1, 10), AboveBridgeCap.selector, "above the cap");
        assertLooseningApplies(messageLimits(2_000e18, 4_500e18, 10), "the cap itself");
        assertEq(vaultLens.maxMessageValue(), 4_500e18);
        // the bridge's cap falls: even a tightening must meet it, at once
        bridge.setMaxMessageValue(3_000e18);
        assertRefusedAtOnce(messageLimits(2_000e18, 3_000e18 + 1, 10), AboveBridgeCap.selector, "a tightening above");
        assertAppliesAtOnce(messageLimits(2_000e18, 3_000e18, 10), "a tightening to the cap");
        bridge.setMaxMessageValue(5_000e18);

        // setPrimaryBridge, against the new primary's cap
        StubBridge smaller = new StubBridge(IERC20(address(0)));
        smaller.setMaxMessageValue(3_000e18 - 1);
        Schedule.run(vault, owner, abi.encodeCall(vault.activateBridge, (address(smaller))));
        vm.prank(owner);
        vault.disableBridge(address(bridge));
        vm.prank(owner);
        vm.expectRevert(AboveBridgeCap.selector);
        vault.setPrimaryBridge(address(smaller));
        assertEq(vaultLens.primaryBridge(), address(bridge), "the primary unchanged");
        // the owner tightens to the smaller cap (checked against the disabled primary's, which it meets), then switches
        assertAppliesAtOnce(messageLimits(2_000e18, 3_000e18 - 1, 10), "a tightening to the new bridge's cap");
        vm.prank(owner);
        vault.setPrimaryBridge(address(smaller));
        assertEq(vaultLens.primaryBridge(), address(smaller), "switched at its cap");
        assertTrue(vaultLens.exitsOpen());
        // from now on the limits meet the new primary's cap (a loosening, scheduled once the disable's second is past)
        Schedule.wait(1 hours);
        assertLooseningRefused(
            messageLimits(2_000e18, 3_000e18, 10), AboveBridgeCap.selector, "above the new primary's cap"
        );
    }

    // ---- the staking floors' fallbacks ----

    /// The staking floors' fallbacks are constants (spec §3.9, Appendix B): 2,000,000 and 20,000,000 rao, served by the
    /// lens; the floors are the larger of the live read and them, or them alone when the read fails, in the vault's
    /// walk too (L2); and setFloorFallbacks is gone, from the vault and from the scheduler.
    function test_floorFallbacksAreConstants() public {
        assertEq(vaultLens.FALLBACK_MIN_STAKE_RAO(), 2_000_000);
        assertEq(vaultLens.FALLBACK_MIN_REMAIN_RAO(), 20_000_000);
        // live reads below the fallbacks
        staking.setMinStake(1);
        staking.setNominatorMin(1);
        assertEq(vaultLens.minStakeRao(), 2_000_000);
        assertEq(vaultLens.minRemainRao(), 20_000_000);

        // no setter: the selector is unknown to the vault and to its scheduler
        bytes memory gone = abi.encodeWithSignature("setFloorFallbacks(uint256,uint256)", 3_000_000, 30_000_000);
        vm.prank(owner);
        (bool ok, bytes memory ret) = address(vault).call(gone);
        assertFalse(ok, "setFloorFallbacks is gone");
        assertEq(ret.length, 0, "no such function");
        vm.prank(owner);
        vm.expectRevert(UnknownSelector.selector);
        vault.schedule(gone);

        // the reads unreadable: the walk rounds a 10,000-rao request up to FALLBACK_MIN_STAKE_RAO (L2)
        depositDirect(alice, 100e18);
        vm.prank(keeper);
        vault.stakeIdle();
        vm.mockCallRevert(ISTAKING_ADDRESS, abi.encodeWithSelector(IStaking.getDefaultMinStake.selector), "");
        vm.mockCallRevert(ISTAKING_ADDRESS, abi.encodeWithSelector(IStaking.getNominatorMinRequiredStake.selector), "");
        assertEq(vaultLens.minStakeRao(), 2_000_000);
        assertEq(vaultLens.minRemainRao(), 20_000_000);
        // out = 1e19 * (100e18 + 1) / (1e26 + 1e6) = 1e13 wei, 10,000 rao
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 2_000_000, 0)));
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 2_000_000, 2e15);
        vm.prank(alice);
        vault.redeemDirect(1e19, false);
        assertEq(alice.balance, 1e13);
    }

    // ---- the dust allowance (the Task 14a carry, I-6) ----

    /// hotkeyDustRao at most MAX_HOTKEY_DUST_RAO, the largest whose product with RAO fits a word: every removal path
    /// computes that product, so a larger owner value would panic the stranger's removal too and block I-6's way back.
    /// At the maximum, a stranger still frees a slot (the set full, stake missing, an empty hotkey with nothing
    /// unclaimed), and the keeper's and the owner's removals still run.
    function test_hotkeyDustBoundKeepsTheStrangersRemoval() public {
        CascadeVault.Params memory p = vaultParams();
        p.hotkeyDustRao = MAX_HOTKEY_DUST_RAO + 1;
        assertNotConstructed(p, InvalidParameter.selector);
        assertRefusedAtOnce(
            abi.encodeCall(vault.setHotkeyDustRao, (MAX_HOTKEY_DUST_RAO + 1)), InvalidParameter.selector, "past"
        );
        vm.expectEmit(address(vault));
        emit LimitSet(vault.setHotkeyDustRao.selector, MAX_HOTKEY_DUST_RAO, 0);
        assertAppliesAtOnce(abi.encodeCall(vault.setHotkeyDustRao, (MAX_HOTKEY_DUST_RAO)), "the maximum, at once");

        // HK2 and HK3 beside HK1, a swap onto HK5, which a stranger lists in the last slot, then a second swap: the
        // set full and stake missing
        depositDirect(alice, 10e18);
        vm.prank(keeper);
        vault.stakeIdle();
        vm.startPrank(owner);
        vault.addHotkey(HK2);
        vault.addHotkey(HK3);
        vm.stopPrank();
        bytes32 ck = vaultLens.coldkey();
        vm.prank(address(vault));
        staking.moveStake(HK1, HK5, 0, 0, 4_000_000_000);
        vm.prank(stranger);
        vault.addHotkey(HK5);
        vm.prank(address(vault));
        staking.moveStake(HK1, HK6, 0, 0, 4_000_000_000);
        assertEq(vaultLens.hotkeyCount(), 4);
        assertTrue(vaultLens.stakeMissing());

        vm.expectEmit(address(vault));
        emit HotkeyRemoved(HK2, 0, false);
        vm.prank(stranger);
        vault.removeHotkey(HK2, false);
        vm.prank(stranger);
        vault.addHotkey(HK6);
        assertFalse(vaultLens.stakeMissing(), "the way back went through");

        // the keeper's and the owner's too, each comparing against the whole allowance without a panic: 1 TAO unclaimed
        // on HK3 (the mock's read is in wei, 1e9 per rao set), and on HK5 the allowance itself, MAX_HOTKEY_DUST_RAO *
        // RAO, which is within it, so the owner needs no forfeit (HK5's stake moves to the stake hotkey)
        staking.setUnclaimed(ck, HK3, 1e9);
        vm.expectEmit(address(vault));
        emit HotkeyRemoved(HK3, 1e18, false);
        vm.prank(keeper);
        vault.removeHotkey(HK3, false);
        staking.setUnclaimed(ck, HK5, MAX_HOTKEY_DUST_RAO);
        vm.expectEmit(address(vault));
        emit HotkeyRemoved(HK5, MAX_HOTKEY_DUST_RAO * 1e9, false);
        vm.prank(owner);
        vault.removeHotkey(HK5, false);
        assertEq(vaultLens.hotkeyCount(), 2);
    }
}
