// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {CascadeBase} from "../../src/CascadeBase.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeDoorLens} from "../../src/lens/CascadeDoorLens.sol";
import {ICascadeTwap} from "../../src/interfaces/ICascadeTwap.sol";
import {Delay, Item, Kind} from "../../src/CascadeTypes.sol";
import {VaultLayout} from "../../src/lens/generated/VaultLayout.sol";
import {DoorLayout} from "../../src/lens/generated/DoorLayout.sol";
import {
    BadCalldata,
    ExitsNotOpen,
    InvalidParameter,
    NoProposal,
    NotReady,
    NotScheduled,
    UnknownSelector
} from "../../src/CascadeErrors.sol";
import {
    Cancelled,
    Executed,
    HotkeyAdded,
    LimitSet,
    OutflowLimitsSet,
    RewardCutSet,
    Scheduled,
    StakeHotkeySet,
    StakeMoved,
    StakeWrittenOff
} from "../../src/CascadeEvents.sol";
import {MockTAO} from "../mocks/MockTAO.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {StubBridge} from "../mocks/StubBridge.sol";
import {DOOR_TAO_WETH_FLOOR, DOOR_WETH_USDC_FLOOR, defaultFrontDoorParams} from "../utils/DefaultParams.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {Schedule} from "./Schedule.sol";

/// The owner's setters and the scheduler (spec §3.6, Task 11). A setter that loosens a protective limit runs only
/// as execute's self-call, a scheduled item of the Param class (48 hours) and the Ordinary kind, so the guardian may
/// cancel it and a close kills it; a tightening, or an equal value, applies at once and is never refused. A
/// multi-field setter loosens if any field does, and a change of the reward cut's treasury is a loosening. The
/// vault's moveStake, and the front door's setOracle and setSwapper, are scheduled whatever their value; the vault's
/// setStakeHotkey unless it follows stake that already moved (Task 14a); the vault's writeOffMissingStake always, in
/// the Registry class (7 days, Task 16). The immediate setters (and every
/// tightening) stamp no clock and record no hold: each writes only its own fields (I-29). The fixture: the vault on
/// VaultTestBase's values with a 10% reward cut to `treasury`, and a front door on the fixtures' values with an
/// oracle and a swapper, beside it.
contract SetterDirectionsTest is VaultTestBase {
    address treasury = makeAddr("treasury");
    address stranger = makeAddr("stranger");
    address oracle1 = makeAddr("oracle1");
    address swapper1 = makeAddr("swapper1");

    MockTAO tao;
    MockUSDC usdc;
    StubBridge doorBridge;
    CascadeFrontDoor fd;
    CascadeDoorLens doorLens;

    function vaultParams() internal view override returns (CascadeVault.Params memory p) {
        p = super.vaultParams();
        p.treasury = treasury;
        p.rewardCutBps = 1_000;
    }

    function setUp() public override {
        super.setUp();
        tao = new MockTAO(18);
        usdc = new MockUSDC();
        doorBridge = new StubBridge(tao);
        CascadeFrontDoor.Params memory p =
            defaultFrontDoorParams(tao, doorBridge, BITTENSOR, address(vault), usdc, owner, guardian, keeper);
        p.oracle = ICascadeTwap(oracle1);
        p.swapper = swapper1;
        fd = new CascadeFrontDoor(p);
        doorLens = new CascadeDoorLens(address(fd));
    }

    // ---- helpers ----

    function now_() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
    }

    function warpBy(uint256 s) internal {
        Schedule.warpTo(vm.getBlockTimestamp() + s);
    }

    function sel(bytes memory data) internal pure returns (bytes4) {
        // casting to 'bytes4' keeps the selector, the first 4 bytes of data
        // forge-lint: disable-next-line(unsafe-typecast)
        return bytes4(data);
    }

    function itemOf(CascadeBase c, bytes32 id) internal view returns (Item memory) {
        return address(c) == address(vault) ? vaultLens.scheduled(id) : doorLens.scheduled(id);
    }

    function clocks(CascadeBase c) internal view returns (uint64, uint64) {
        if (address(c) == address(vault)) return (vaultLens.lastOwnerClose(), vaultLens.lastGuardianClose());
        return (doorLens.lastOwnerClose(), doorLens.lastGuardianClose());
    }

    /// The owner's direct call of `data` on `c` applies at once.
    function direct(CascadeBase c, bytes memory data) internal {
        vm.prank(owner);
        (bool ok, bytes memory ret) = address(c).call(data);
        assertTrue(ok, string.concat("the direct call was refused: ", vm.toString(ret)));
    }

    /// The owner's direct call of `data` on `c` is refused NotScheduled (a loosening outside execute's self-call),
    /// and the guardian's and a stranger's are refused too.
    function refusedDirect(CascadeBase c, bytes memory data) internal {
        vm.prank(owner);
        (bool ok, bytes memory ret) = address(c).call(data);
        assertFalse(ok, "a loosening applied outside execute");
        assertEq(ret, abi.encodeWithSelector(NotScheduled.selector), "NotScheduled");
        address[2] memory others = [guardian, stranger];
        for (uint256 i; i < 2; ++i) {
            vm.prank(others[i]);
            (ok,) = address(c).call(data);
            assertFalse(ok, "a non-owner set it");
        }
    }

    /// Schedules `data` on `c`: Scheduled carries the whole calldata (the Ordinary kind, the selector, readyAt
    /// 48 hours on), and the item is the Param class's, Ordinary; execute refuses it a second early. The clock is
    /// left at readyAt.
    function scheduleParam(CascadeBase c, bytes memory data) internal returns (bytes32 id) {
        id = keccak256(data);
        uint64 readyAt = now_() + 48 hours;
        vm.expectEmit(address(c));
        emit Scheduled(id, Kind.Ordinary, sel(data), readyAt, data);
        vm.prank(owner);
        assertEq(c.schedule(data), id);
        Item memory it = itemOf(c, id);
        assertEq(it.scheduledAt, now_(), "scheduledAt");
        assertEq(it.readyAt, readyAt, "readyAt: the Param class's 48 hours");
        assertEq(uint8(it.class), uint8(Delay.Param), "the Param class");
        assertEq(uint8(it.kind), uint8(Kind.Ordinary), "the Ordinary kind");
        assertEq(it.selector, sel(data), "selector");
        Schedule.warpTo(readyAt - 1);
        vm.prank(owner);
        vm.expectRevert(NotReady.selector);
        c.execute(data);
        Schedule.warpTo(readyAt);
    }

    /// Executes `data` on `c`, scheduled and ready, and returns the setter's own logs: Executed(id), the last
    /// log, is checked and dropped. The item is gone, and no clock moved.
    function executeParam(CascadeBase c, bytes memory data) internal returns (Vm.Log[] memory logs) {
        (uint64 o, uint64 g) = clocks(c);
        vm.recordLogs();
        vm.prank(owner);
        c.execute(data);
        Vm.Log[] memory all = vm.getRecordedLogs();
        assertGt(all.length, 0);
        Vm.Log memory last = all[all.length - 1];
        assertEq(last.emitter, address(c), "Executed's emitter");
        assertEq(last.topics[0], Executed.selector, "Executed last");
        assertEq(last.topics[1], keccak256(data), "Executed(id)");
        logs = new Vm.Log[](all.length - 1);
        for (uint256 i; i < logs.length; ++i) {
            logs[i] = all[i];
        }
        assertEq(itemOf(c, keccak256(data)).readyAt, 0, "the item is deleted");
        (uint64 o2, uint64 g2) = clocks(c);
        assertEq(o2, o, "no owner stamp");
        assertEq(g2, g, "no guardian stamp");
    }

    /// `data` scheduled on `c` and executed at 48 hours; returns the setter's logs.
    function runParam(CascadeBase c, bytes memory data) internal returns (Vm.Log[] memory) {
        scheduleParam(c, data);
        return executeParam(c, data);
    }

    /// The guardian cancels `data`'s item on `c` (Ordinary): Cancelled(id, guardian), the item gone, and 48 hours
    /// later execute finds nothing.
    function guardianCancelKills(CascadeBase c, bytes memory data) internal {
        vm.prank(owner);
        bytes32 id = c.schedule(data);
        vm.expectEmit(address(c));
        emit Cancelled(id, guardian);
        vm.prank(guardian);
        c.cancel(id);
        assertEq(itemOf(c, id).readyAt, 0, "cancelled");
        warpBy(48 hours);
        vm.prank(owner);
        vm.expectRevert(NoProposal.selector);
        c.execute(data);
    }

    function assertLimitSet(Vm.Log memory log, bytes4 selector, uint256 a, uint256 b) internal view {
        assertEq(log.emitter, address(vault), "LimitSet's emitter");
        assertEq(log.topics[0], LimitSet.selector, "LimitSet");
        assertEq(log.topics[1], bytes32(selector), "LimitSet's explicit setter selector (the T7 carry)");
        assertEq(log.data, abi.encode(a, b), "LimitSet's values");
    }

    function assertDoorLimitSet(Vm.Log memory log, bytes32 name, uint256 a, uint256 b) internal view {
        assertEq(log.emitter, address(fd), "LimitSet's emitter");
        assertEq(log.topics[0], CascadeFrontDoor.LimitSet.selector, "the front door's LimitSet");
        assertEq(log.topics[1], name, "LimitSet's name");
        assertEq(log.data, abi.encode(a, b), "LimitSet's values");
    }

    // ---- the vault's setters, one block each ----

    /// setMaxTotalAssets: up loosens.
    function test_setMaxTotalAssets() public {
        vm.expectEmit(address(vault));
        emit LimitSet(vault.setMaxTotalAssets.selector, 500e18, 0);
        direct(vault, abi.encodeCall(vault.setMaxTotalAssets, (500e18)));
        assertEq(vaultLens.maxTotalAssets(), 500e18, "a tightening at once");
        direct(vault, abi.encodeCall(vault.setMaxTotalAssets, (500e18)));
        assertEq(vaultLens.maxTotalAssets(), 500e18, "an equal value at once");

        bytes memory up = abi.encodeCall(vault.setMaxTotalAssets, (500e18 + 1));
        refusedDirect(vault, up);
        assertEq(vaultLens.maxTotalAssets(), 500e18);
        Vm.Log[] memory logs = runParam(vault, up);
        assertEq(logs.length, 1);
        assertLimitSet(logs[0], vault.setMaxTotalAssets.selector, 500e18 + 1, 0);
        assertEq(vaultLens.maxTotalAssets(), 500e18 + 1, "the scheduled loosening");

        guardianCancelKills(vault, abi.encodeCall(vault.setMaxTotalAssets, (2_000e18)));
        assertEq(vaultLens.maxTotalAssets(), 500e18 + 1);
    }

    /// setOutflowLimits: any of its three values up loosens. It logs OutflowLimitsSet, its three values in one event
    /// (Task 17), not LimitSet.
    function test_setOutflowLimits() public {
        // from the fixture's (2,000 bps, 100 TAO, 2,000 bps): the percentages sit at their lower bound, so the floor
        // goes down
        vm.expectEmit(address(vault));
        emit OutflowLimitsSet(2_000, 50e18, 2_000);
        direct(vault, abi.encodeCall(vault.setOutflowLimits, (2_000, 50e18, 2_000)));
        assertOutflowLimits(2_000, 50e18, 2_000);
        direct(vault, abi.encodeCall(vault.setOutflowLimits, (2_000, 50e18, 2_000)));

        bytes memory up = abi.encodeCall(vault.setOutflowLimits, (3_000, 80e18, 3_500));
        refusedDirect(vault, up);
        assertOutflowLimits(2_000, 50e18, 2_000);
        Vm.Log[] memory logs = runParam(vault, up);
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(vault), "OutflowLimitsSet's emitter");
        assertEq(logs[0].topics.length, 1, "nothing indexed");
        assertEq(logs[0].topics[0], OutflowLimitsSet.selector, "OutflowLimitsSet");
        assertEq(logs[0].data, abi.encode(3_000, 80e18, 3_500), "OutflowLimitsSet's values");
        assertOutflowLimits(3_000, 80e18, 3_500);

        // and down again, every value at once
        direct(vault, abi.encodeCall(vault.setOutflowLimits, (2_500, 60e18, 3_000)));
        assertOutflowLimits(2_500, 60e18, 3_000);

        guardianCancelKills(vault, abi.encodeCall(vault.setOutflowLimits, (4_000, 90e18, 4_000)));
        assertOutflowLimits(2_500, 60e18, 3_000);
    }

    function assertOutflowLimits(uint256 bps, uint256 minDaily, uint256 globalBps) internal view {
        assertEq(vaultLens.maxDailyOutflowBps(), bps, "maxDailyOutflowBps");
        assertEq(vaultLens.minDailyOutflow(), minDaily, "minDailyOutflow");
        assertEq(vaultLens.globalOutflowBps(), globalBps, "globalOutflowBps");
    }

    /// setMessageLimits: an entry or message value up, or minChunk down, loosens.
    function test_setMessageLimits() public {
        vm.expectEmit(address(vault));
        emit LimitSet(vault.setMessageLimits.selector, 1_500e18, 3_000e18);
        vm.expectEmit(address(vault));
        emit LimitSet(vault.setMessageLimits.selector, 20, 0);
        direct(vault, abi.encodeCall(vault.setMessageLimits, (1_500e18, 3_000e18, 20)));
        assertEq(vaultLens.maxEntryValue(), 1_500e18);
        assertEq(vaultLens.maxMessageValue(), 3_000e18);
        assertEq(vaultLens.minChunk(), 20);
        direct(vault, abi.encodeCall(vault.setMessageLimits, (1_500e18, 3_000e18, 20)));

        bytes memory up = abi.encodeCall(vault.setMessageLimits, (2_000e18, 4_000e18, 5));
        refusedDirect(vault, up);
        assertEq(vaultLens.maxEntryValue(), 1_500e18);
        assertEq(vaultLens.minChunk(), 20);
        Vm.Log[] memory logs = runParam(vault, up);
        assertEq(logs.length, 2);
        assertLimitSet(logs[0], vault.setMessageLimits.selector, 2_000e18, 4_000e18);
        assertLimitSet(logs[1], vault.setMessageLimits.selector, 5, 0);
        assertEq(vaultLens.maxEntryValue(), 2_000e18);
        assertEq(vaultLens.maxMessageValue(), 4_000e18);
        assertEq(vaultLens.minChunk(), 5);

        guardianCancelKills(vault, abi.encodeCall(vault.setMessageLimits, (2_500e18, 4_500e18, 1)));
        assertEq(vaultLens.maxMessageValue(), 4_000e18);
        assertEq(vaultLens.minChunk(), 5);
    }

    /// setFeeLimits: either ceiling up loosens.
    function test_setFeeLimits() public {
        vm.expectEmit(address(vault));
        emit LimitSet(vault.setFeeLimits.selector, 50, 0.01e18);
        direct(vault, abi.encodeCall(vault.setFeeLimits, (50, 0.01e18)));
        assertEq(vaultLens.maxFeeBps(), 50);
        assertEq(vaultLens.maxFeeAbs(), 0.01e18);
        direct(vault, abi.encodeCall(vault.setFeeLimits, (50, 0.01e18)));

        bytes memory up = abi.encodeCall(vault.setFeeLimits, (200, 0.015e18));
        refusedDirect(vault, up);
        assertEq(vaultLens.maxFeeBps(), 50);
        Vm.Log[] memory logs = runParam(vault, up);
        assertEq(logs.length, 1);
        assertLimitSet(logs[0], vault.setFeeLimits.selector, 200, 0.015e18);
        assertEq(vaultLens.maxFeeBps(), 200);
        assertEq(vaultLens.maxFeeAbs(), 0.015e18);

        guardianCancelKills(vault, abi.encodeCall(vault.setFeeLimits, (300, 0.015e18)));
        assertEq(vaultLens.maxFeeBps(), 200);
    }

    /// setPayoutDelay: down loosens (a shorter window for the guardian to hold a rogue batch).
    function test_setPayoutDelay() public {
        vm.expectEmit(address(vault));
        emit LimitSet(vault.setPayoutDelay.selector, 36 hours, 0);
        direct(vault, abi.encodeCall(vault.setPayoutDelay, (36 hours)));
        assertEq(vaultLens.payoutDelay(), 36 hours);
        direct(vault, abi.encodeCall(vault.setPayoutDelay, (36 hours)));

        bytes memory down = abi.encodeCall(vault.setPayoutDelay, (36 hours - 1));
        refusedDirect(vault, down);
        assertEq(vaultLens.payoutDelay(), 36 hours);
        Vm.Log[] memory logs = runParam(vault, down);
        assertEq(logs.length, 1);
        assertLimitSet(logs[0], vault.setPayoutDelay.selector, 36 hours - 1, 0);
        assertEq(vaultLens.payoutDelay(), 36 hours - 1);

        guardianCancelKills(vault, abi.encodeCall(vault.setPayoutDelay, (2 hours)));
        assertEq(vaultLens.payoutDelay(), 36 hours - 1);
    }

    /// setRewardVesting: down loosens (claimed rewards reach the price sooner; Task 15).
    function test_setRewardVesting() public {
        vm.expectEmit(address(vault));
        emit LimitSet(vault.setRewardVesting.selector, 10 days, 0);
        direct(vault, abi.encodeCall(vault.setRewardVesting, (10 days)));
        assertEq(vaultLens.rewardVesting(), 10 days);
        direct(vault, abi.encodeCall(vault.setRewardVesting, (10 days)));

        bytes memory down = abi.encodeCall(vault.setRewardVesting, (10 days - 1));
        refusedDirect(vault, down);
        assertEq(vaultLens.rewardVesting(), 10 days);
        Vm.Log[] memory logs = runParam(vault, down);
        assertEq(logs.length, 1);
        assertLimitSet(logs[0], vault.setRewardVesting.selector, 10 days - 1, 0);
        assertEq(vaultLens.rewardVesting(), 10 days - 1);

        guardianCancelKills(vault, abi.encodeCall(vault.setRewardVesting, (1 days)));
        assertEq(vaultLens.rewardVesting(), 10 days - 1);
    }

    /// setIdleBuffer: down loosens (less TAO kept liquid for exits under a root hold, spec §3.8; Task 20); up, or an
    /// equal value, at once.
    function test_setIdleBuffer() public {
        vm.expectEmit(address(vault));
        emit LimitSet(vault.setIdleBuffer.selector, 500, 0);
        direct(vault, abi.encodeCall(vault.setIdleBuffer, (500)));
        assertEq(vaultLens.idleBufferBps(), 500, "an increase at once");
        direct(vault, abi.encodeCall(vault.setIdleBuffer, (500)));
        assertEq(vaultLens.idleBufferBps(), 500, "an equal value at once");

        bytes memory down = abi.encodeCall(vault.setIdleBuffer, (499));
        refusedDirect(vault, down);
        assertEq(vaultLens.idleBufferBps(), 500);
        Vm.Log[] memory logs = runParam(vault, down);
        assertEq(logs.length, 1);
        assertLimitSet(logs[0], vault.setIdleBuffer.selector, 499, 0);
        assertEq(vaultLens.idleBufferBps(), 499, "the scheduled loosening");

        guardianCancelKills(vault, abi.encodeCall(vault.setIdleBuffer, (0)));
        assertEq(vaultLens.idleBufferBps(), 499);
    }

    /// setRewardCut: the cut up loosens (a treasury change too: test_treasuryChangeIsLoosening).
    function test_setRewardCut() public {
        vm.expectEmit(address(vault));
        emit RewardCutSet(treasury, 500);
        direct(vault, abi.encodeCall(vault.setRewardCut, (treasury, 500)));
        assertEq(vaultLens.rewardCutBps(), 500);
        direct(vault, abi.encodeCall(vault.setRewardCut, (treasury, 500)));

        bytes memory up = abi.encodeCall(vault.setRewardCut, (treasury, 501));
        refusedDirect(vault, up);
        assertEq(vaultLens.rewardCutBps(), 500);
        Vm.Log[] memory logs = runParam(vault, up);
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], RewardCutSet.selector);
        assertEq(logs[0].data, abi.encode(treasury, uint16(501)));
        assertEq(vaultLens.rewardCutBps(), 501);
        assertEq(vaultLens.treasury(), treasury);

        guardianCancelKills(vault, abi.encodeCall(vault.setRewardCut, (treasury, 2_000)));
        assertEq(vaultLens.rewardCutBps(), 501);
    }

    // ---- the front door's setters, one block each ----

    /// setMaxDeliverySlippage: up loosens (a lower market floor on a delivery).
    function test_setMaxDeliverySlippage() public {
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.MaxDeliverySlippageSet(100);
        direct(fd, abi.encodeCall(fd.setMaxDeliverySlippage, (100)));
        assertEq(fd.maxDeliverySlippageBps(), 100);
        direct(fd, abi.encodeCall(fd.setMaxDeliverySlippage, (100)));

        bytes memory up = abi.encodeCall(fd.setMaxDeliverySlippage, (101));
        refusedDirect(fd, up);
        assertEq(fd.maxDeliverySlippageBps(), 100);
        Vm.Log[] memory logs = runParam(fd, up);
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], CascadeFrontDoor.MaxDeliverySlippageSet.selector);
        assertEq(logs[0].data, abi.encode(uint16(101)));
        assertEq(fd.maxDeliverySlippageBps(), 101);

        guardianCancelKills(fd, abi.encodeCall(fd.setMaxDeliverySlippage, (300)));
        assertEq(fd.maxDeliverySlippageBps(), 101);
    }

    /// setBatchInterval: down loosens (batches, and their redeems, leave sooner).
    function test_setBatchInterval() public {
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.LimitSet("batchInterval", 18 hours, 0);
        direct(fd, abi.encodeCall(fd.setBatchInterval, (18 hours)));
        assertEq(fd.batchInterval(), 18 hours);
        direct(fd, abi.encodeCall(fd.setBatchInterval, (18 hours)));

        bytes memory down = abi.encodeCall(fd.setBatchInterval, (6 hours));
        refusedDirect(fd, down);
        assertEq(fd.batchInterval(), 18 hours);
        Vm.Log[] memory logs = runParam(fd, down);
        assertEq(logs.length, 1);
        assertDoorLimitSet(logs[0], "batchInterval", 6 hours, 0);
        assertEq(fd.batchInterval(), 6 hours);

        guardianCancelKills(fd, abi.encodeCall(fd.setBatchInterval, (1 hours)));
        assertEq(fd.batchInterval(), 6 hours);
    }

    /// setMaxBatchValue: up loosens.
    function test_setMaxBatchValue() public {
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.LimitSet("maxBatchValue", 3_000e18, 0);
        direct(fd, abi.encodeCall(fd.setMaxBatchValue, (3_000e18)));
        assertEq(fd.maxBatchValue(), 3_000e18);
        direct(fd, abi.encodeCall(fd.setMaxBatchValue, (3_000e18)));

        bytes memory up = abi.encodeCall(fd.setMaxBatchValue, (4_500e18));
        refusedDirect(fd, up);
        assertEq(fd.maxBatchValue(), 3_000e18);
        Vm.Log[] memory logs = runParam(fd, up);
        assertEq(logs.length, 1);
        assertDoorLimitSet(logs[0], "maxBatchValue", 4_500e18, 0);
        assertEq(fd.maxBatchValue(), 4_500e18);

        guardianCancelKills(fd, abi.encodeCall(fd.setMaxBatchValue, (5_000e18)));
        assertEq(fd.maxBatchValue(), 4_500e18);
    }

    /// setMinPoolLiquidity(index, value), a pool's depth floor on deliveries (Task 32; 0 TAO/WETH, 1 WETH/USDC): down
    /// loosens (a delivery through a thinner pool); up, or an equal value, at once. Each change logs
    /// LimitSet("minPoolLiquidity", index, value) and leaves the other pool's floor as it was. A cut to 0 (no check,
    /// the emergency path) is a loosening like any other, and from 0 every value is a raise.
    function test_setMinPoolLiquidity() public {
        uint128[2] memory floors = [DOOR_TAO_WETH_FLOOR, DOOR_WETH_USDC_FLOOR];
        for (uint8 i; i < 2; ++i) {
            uint128 up = 2 * floors[i];
            uint128 other = fd.minPoolLiquidity(1 - i);
            vm.expectEmit(address(fd));
            emit CascadeFrontDoor.LimitSet("minPoolLiquidity", i, up);
            direct(fd, abi.encodeCall(fd.setMinPoolLiquidity, (i, up)));
            assertEq(fd.minPoolLiquidity(i), up, "a raise at once");
            direct(fd, abi.encodeCall(fd.setMinPoolLiquidity, (i, up)));
            assertEq(fd.minPoolLiquidity(i), up, "an equal value at once");

            bytes memory down = abi.encodeCall(fd.setMinPoolLiquidity, (i, up - 1));
            refusedDirect(fd, down);
            assertEq(fd.minPoolLiquidity(i), up);
            Vm.Log[] memory logs = runParam(fd, down);
            assertEq(logs.length, 1);
            assertDoorLimitSet(logs[0], "minPoolLiquidity", i, up - 1);
            assertEq(fd.minPoolLiquidity(i), up - 1, "the scheduled loosening");
            assertEq(fd.minPoolLiquidity(1 - i), other, "the other pool's floor untouched");

            guardianCancelKills(fd, abi.encodeCall(fd.setMinPoolLiquidity, (i, 0)));
            assertEq(fd.minPoolLiquidity(i), up - 1);
        }

        bytes memory toZero = abi.encodeCall(fd.setMinPoolLiquidity, (0, 0));
        refusedDirect(fd, toZero);
        runParam(fd, toZero);
        assertEq(fd.minPoolLiquidity(0), 0, "a floor of 0, scheduled");
        direct(fd, abi.encodeCall(fd.setMinPoolLiquidity, (0, 1)));
        assertEq(fd.minPoolLiquidity(0), 1, "from 0, a raise at once");
    }

    /// setMinPoolLiquidity's index names a pool, 0 or 1. Any other index has no floor to cut, so nothing loosens:
    /// directly it reverts InvalidParameter whatever the value; scheduled (scheduling checks no value, spec §3.10.6) it
    /// fails at execute with InvalidParameter, the item kept. Neither floor moves.
    function test_setMinPoolLiquidityIndexAboveOneRefused() public {
        uint8[3] memory bad = [2, 3, type(uint8).max];
        uint128[3] memory values = [uint128(0), 1, type(uint128).max];
        for (uint256 i; i < bad.length; ++i) {
            for (uint256 j; j < values.length; ++j) {
                vm.prank(owner);
                vm.expectRevert(InvalidParameter.selector);
                fd.setMinPoolLiquidity(bad[i], values[j]);
            }
        }
        bytes memory noPool = abi.encodeCall(fd.setMinPoolLiquidity, (2, 0));
        bytes32 id = scheduleParam(fd, noPool);
        vm.prank(owner);
        vm.expectRevert(InvalidParameter.selector);
        fd.execute(noPool);
        assertGt(itemOf(fd, id).readyAt, 0, "the item stays");
        assertEq(fd.minPoolLiquidity(0), DOOR_TAO_WETH_FLOOR);
        assertEq(fd.minPoolLiquidity(1), DOOR_WETH_USDC_FLOOR);
    }

    // ---- the shared rules ----

    /// A multi-field setter loosens if any one field does, whatever the others do; each such mix is refused
    /// directly, and runs, every field at once, as a scheduled item.
    function test_multiFieldLoosensIfAnyFieldDoes() public {
        // outflow: from (3,000 bps, 50 TAO, 3,000 bps), set through the scheduler (the percentages' lower bound is
        // the fixture's 2,000), one field loosening at a time, the others tightening
        runParam(vault, abi.encodeCall(vault.setOutflowLimits, (3_000, 50e18, 3_000)));
        refusedDirect(vault, abi.encodeCall(vault.setOutflowLimits, (3_001, 40e18, 2_500)));
        refusedDirect(vault, abi.encodeCall(vault.setOutflowLimits, (2_500, 50e18 + 1, 2_500)));
        refusedDirect(vault, abi.encodeCall(vault.setOutflowLimits, (2_500, 40e18, 3_001)));
        direct(vault, abi.encodeCall(vault.setOutflowLimits, (2_500, 40e18, 2_500)));
        assertOutflowLimits(2_500, 40e18, 2_500);

        // message limits: from (2,000, 4,000, 10), one field loosening at a time, the others tightening
        refusedDirect(vault, abi.encodeCall(vault.setMessageLimits, (2_000e18 + 1, 3_000e18, 20)));
        refusedDirect(vault, abi.encodeCall(vault.setMessageLimits, (1_000e18, 4_000e18 + 1, 20)));
        refusedDirect(vault, abi.encodeCall(vault.setMessageLimits, (1_000e18, 3_000e18, 9)));
        direct(vault, abi.encodeCall(vault.setMessageLimits, (1_000e18, 3_000e18, 20)));
        assertEq(vaultLens.maxEntryValue(), 1_000e18);
        assertEq(vaultLens.maxMessageValue(), 3_000e18);
        assertEq(vaultLens.minChunk(), 20);

        // fee ceilings: from (100 bps, 0.015 TAO), each up a loosening (the absolute one refused at its bound too)
        refusedDirect(vault, abi.encodeCall(vault.setFeeLimits, (101, 0.01e18)));
        refusedDirect(vault, abi.encodeCall(vault.setFeeLimits, (50, 0.015e18 + 1)));
        direct(vault, abi.encodeCall(vault.setFeeLimits, (50, 0.01e18)));

        // the reward cut: from (treasury, 1,000): the cut down with a new treasury, or the cut up alone
        refusedDirect(vault, abi.encodeCall(vault.setRewardCut, (carol, 500)));
        refusedDirect(vault, abi.encodeCall(vault.setRewardCut, (treasury, 1_001)));
        assertEq(vaultLens.treasury(), treasury);
        assertEq(vaultLens.rewardCutBps(), 1_000);

        // a mix, scheduled, sets every field, the tightening ones included
        runParam(vault, abi.encodeCall(vault.setOutflowLimits, (2_000, 60e18, 2_200)));
        assertOutflowLimits(2_000, 60e18, 2_200);
        runParam(vault, abi.encodeCall(vault.setMessageLimits, (500e18, 3_500e18, 30)));
        assertEq(vaultLens.maxEntryValue(), 500e18);
        assertEq(vaultLens.maxMessageValue(), 3_500e18);
        assertEq(vaultLens.minChunk(), 30);
        runParam(vault, abi.encodeCall(vault.setFeeLimits, (10, 0.015e18)));
        assertEq(vaultLens.maxFeeBps(), 10);
        assertEq(vaultLens.maxFeeAbs(), 0.015e18);
    }

    /// A change of the reward cut's treasury is a loosening, whatever the cut: to another treasury, to none with
    /// no cut, with the cut kept or lowered. The same treasury with a lower or an equal cut applies at once.
    function test_treasuryChangeIsLoosening() public {
        refusedDirect(vault, abi.encodeCall(vault.setRewardCut, (carol, 1_000)));
        refusedDirect(vault, abi.encodeCall(vault.setRewardCut, (carol, 0)));
        refusedDirect(vault, abi.encodeCall(vault.setRewardCut, (address(0), 0)));
        assertEq(vaultLens.treasury(), treasury);
        assertEq(vaultLens.rewardCutBps(), 1_000);

        direct(vault, abi.encodeCall(vault.setRewardCut, (treasury, 0)));
        direct(vault, abi.encodeCall(vault.setRewardCut, (treasury, 0)));
        assertEq(vaultLens.rewardCutBps(), 0);
        refusedDirect(vault, abi.encodeCall(vault.setRewardCut, (address(0), 0)));

        Vm.Log[] memory logs = runParam(vault, abi.encodeCall(vault.setRewardCut, (carol, 0)));
        assertEq(logs.length, 1);
        assertEq(logs[0].data, abi.encode(carol, uint16(0)));
        assertEq(vaultLens.treasury(), carol);
        assertEq(vaultLens.rewardCutBps(), 0);

        guardianCancelKills(vault, abi.encodeCall(vault.setRewardCut, (alice, 0)));
        assertEq(vaultLens.treasury(), carol);
    }

    /// moveStake on the vault, setOracle and setSwapper on the front door, are scheduled whatever their value: the
    /// current oracle or swapper again, a zero oracle or swapper (which stops deliveries), a move of nothing. So is
    /// the vault's setStakeHotkey unless it follows stake that already moved (Task 14a, VaultHotkeys.t.sol): the
    /// current hotkey again, or a listed hotkey holding less. Each runs at 48 hours, and the guardian may cancel
    /// each.
    function test_moveStakeAndOracleAlwaysScheduled() public {
        depositDirect(alice, 10e18);
        vm.prank(keeper);
        vault.stakeIdle();
        assertEq(staking.getStake(HK1, vaultLens.coldkey(), 0), 9_999_999_999);
        vm.prank(owner);
        vault.addHotkey(HK2);

        refusedDirect(vault, abi.encodeCall(vault.setStakeHotkey, (HK1)));
        refusedDirect(vault, abi.encodeCall(vault.setStakeHotkey, (HK2)));
        refusedDirect(vault, abi.encodeCall(vault.moveStake, (HK1, HK1, 1)));
        refusedDirect(vault, abi.encodeCall(vault.moveStake, (HK2, HK1, 0)));
        assertEq(vaultLens.stakeHotkey(), HK1);
        assertEq(vaultLens.hotkeyCount(), 2);

        Vm.Log[] memory logs = runParam(vault, abi.encodeCall(vault.setStakeHotkey, (HK2)));
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], StakeHotkeySet.selector);
        assertEq(logs[0].topics[1], HK2);
        assertEq(vaultLens.stakeHotkey(), HK2);
        logs = runParam(vault, abi.encodeCall(vault.moveStake, (HK1, HK2, 5_000_000_000)));
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], StakeMoved.selector);
        assertEq(logs[0].data, abi.encode(uint256(5_000_000_000), uint256(4_999_999_999)));
        assertEq(staking.getStake(HK1, vaultLens.coldkey(), 0), 4_999_999_999);
        assertEq(staking.getStake(HK2, vaultLens.coldkey(), 0), 4_999_999_999);
        guardianCancelKills(vault, abi.encodeCall(vault.setStakeHotkey, (HK3)));
        guardianCancelKills(vault, abi.encodeCall(vault.moveStake, (HK1, HK2, 1)));
        assertEq(vaultLens.stakeHotkey(), HK2);
        assertEq(staking.getStake(HK1, vaultLens.coldkey(), 0), 4_999_999_999);

        address oracle2 = makeAddr("oracle2");
        address swapper2 = makeAddr("swapper2");
        refusedDirect(fd, abi.encodeCall(fd.setOracle, (ICascadeTwap(oracle1))));
        refusedDirect(fd, abi.encodeCall(fd.setOracle, (ICascadeTwap(address(0)))));
        refusedDirect(fd, abi.encodeCall(fd.setSwapper, (swapper1)));
        refusedDirect(fd, abi.encodeCall(fd.setSwapper, (address(0))));
        assertEq(address(fd.oracle()), oracle1);
        assertEq(fd.swapper(), swapper1);

        logs = runParam(fd, abi.encodeCall(fd.setOracle, (ICascadeTwap(oracle2))));
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], CascadeFrontDoor.OracleSet.selector);
        assertEq(address(fd.oracle()), oracle2);
        logs = runParam(fd, abi.encodeCall(fd.setSwapper, (address(0))));
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], CascadeFrontDoor.SwapperSet.selector);
        assertEq(fd.swapper(), address(0));
        guardianCancelKills(fd, abi.encodeCall(fd.setOracle, (ICascadeTwap(oracle1))));
        guardianCancelKills(fd, abi.encodeCall(fd.setSwapper, (swapper2)));
        assertEq(address(fd.oracle()), oracle2);
        assertEq(fd.swapper(), address(0));
    }

    /// The vault's writeOffMissingStake (Task 16) is scheduled whatever its amount, in the Registry class (7 days)
    /// and the Ordinary kind (spec §3.6): refused directly to the owner (NotScheduled), the guardian and a stranger;
    /// a second early it is NotReady, at 7 days it runs, stamping no clock, and the guardian may cancel it. The
    /// keeper's adoptStake is no item at all (UnknownSelector).
    function test_writeOffMissingStakeAlwaysScheduled() public {
        bytes memory nothing = abi.encodeCall(vault.writeOffMissingStake, (0));
        bytes memory some = abi.encodeCall(vault.writeOffMissingStake, (1e9));
        refusedDirect(vault, nothing);
        refusedDirect(vault, some);

        bytes32 id = keccak256(nothing);
        uint64 readyAt = now_() + 7 days;
        vm.expectEmit(address(vault));
        emit Scheduled(id, Kind.Ordinary, sel(nothing), readyAt, nothing);
        vm.prank(owner);
        vault.schedule(nothing);
        Item memory it = itemOf(vault, id);
        assertEq(it.readyAt, readyAt, "readyAt: the Registry class's 7 days");
        assertEq(uint8(it.class), uint8(Delay.Registry), "the Registry class");
        assertEq(uint8(it.kind), uint8(Kind.Ordinary), "the Ordinary kind");
        Schedule.warpTo(readyAt - 1);
        vm.prank(owner);
        vm.expectRevert(NotReady.selector);
        vault.execute(nothing);
        Schedule.warpTo(readyAt);
        Vm.Log[] memory logs = executeParam(vault, nothing);
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], StakeWrittenOff.selector);
        assertEq(logs[0].data, abi.encode(uint256(0)), "nothing was missing");
        guardianCancelKills(vault, some);

        vm.prank(owner);
        vm.expectRevert(UnknownSelector.selector);
        vault.schedule(abi.encodeCall(vault.adoptStake, ()));
    }

    /// Spec §3.10.6: scheduling checks the selector, the length and the gates, not the direction, so a tightening
    /// or an equal value is schedulable and executes harmlessly at 48 hours; a direct equal value is no loosening
    /// and applies at once (each per-setter block shows that half).
    function test_equalValuesAndTighteningsScheduleHarmlessly() public {
        bytes[8] memory vaultEqual = [
            abi.encodeCall(vault.setMaxTotalAssets, (1_000e18)),
            abi.encodeCall(vault.setOutflowLimits, (2_000, 100e18, 2_000)),
            abi.encodeCall(vault.setMessageLimits, (2_000e18, 4_000e18, 10)),
            abi.encodeCall(vault.setFeeLimits, (100, 0.015e18)),
            abi.encodeCall(vault.setPayoutDelay, (24 hours)),
            abi.encodeCall(vault.setRewardCut, (treasury, 1_000)),
            abi.encodeCall(vault.setRewardVesting, (7 days)),
            abi.encodeCall(vault.setIdleBuffer, (0))
        ];
        for (uint256 i; i < vaultEqual.length; ++i) {
            direct(vault, vaultEqual[i]);
            runParam(vault, vaultEqual[i]);
        }
        assertEq(vaultLens.maxTotalAssets(), 1_000e18);
        assertOutflowLimits(2_000, 100e18, 2_000);
        assertEq(vaultLens.maxEntryValue(), 2_000e18);
        assertEq(vaultLens.maxMessageValue(), 4_000e18);
        assertEq(vaultLens.minChunk(), 10);
        assertEq(vaultLens.maxFeeBps(), 100);
        assertEq(vaultLens.maxFeeAbs(), 0.015e18);
        assertEq(vaultLens.payoutDelay(), 24 hours);
        assertEq(vaultLens.treasury(), treasury);
        assertEq(vaultLens.rewardCutBps(), 1_000);
        assertEq(vaultLens.rewardVesting(), 7 days);
        assertEq(vaultLens.idleBufferBps(), 0);

        bytes[5] memory doorEqual = [
            abi.encodeCall(fd.setMaxDeliverySlippage, (150)),
            abi.encodeCall(fd.setBatchInterval, (12 hours)),
            abi.encodeCall(fd.setMaxBatchValue, (4_000e18)),
            abi.encodeCall(fd.setMinPoolLiquidity, (0, DOOR_TAO_WETH_FLOOR)),
            abi.encodeCall(fd.setMinPoolLiquidity, (1, DOOR_WETH_USDC_FLOOR))
        ];
        for (uint256 i; i < doorEqual.length; ++i) {
            direct(fd, doorEqual[i]);
            runParam(fd, doorEqual[i]);
        }
        assertEq(fd.maxDeliverySlippageBps(), 150);
        assertEq(fd.batchInterval(), 12 hours);
        assertEq(fd.maxBatchValue(), 4_000e18);
        assertEq(fd.minPoolLiquidity(0), DOOR_TAO_WETH_FLOOR);
        assertEq(fd.minPoolLiquidity(1), DOOR_WETH_USDC_FLOOR);

        // a tightening through the scheduler, on each
        runParam(vault, abi.encodeCall(vault.setPayoutDelay, (48 hours)));
        assertEq(vaultLens.payoutDelay(), 48 hours);
        runParam(vault, abi.encodeCall(vault.setRewardVesting, (30 days)));
        assertEq(vaultLens.rewardVesting(), 30 days);
        runParam(vault, abi.encodeCall(vault.setIdleBuffer, (1_000)));
        assertEq(vaultLens.idleBufferBps(), 1_000);
        runParam(fd, abi.encodeCall(fd.setBatchInterval, (24 hours)));
        assertEq(fd.batchInterval(), 24 hours);
        runParam(fd, abi.encodeCall(fd.setMinPoolLiquidity, (1, 2 * DOOR_WETH_USDC_FLOOR)));
        assertEq(fd.minPoolLiquidity(1), 2 * DOOR_WETH_USDC_FLOOR);
    }

    /// A scheduled loosening is Ordinary: a close by either actor after its scheduling kills it (the pause on the
    /// vault, the primary's disable on the front door), even once the exits have reopened.
    function test_aCloseKillsAPendingLoosening() public {
        bytes memory up = abi.encodeCall(vault.setMaxTotalAssets, (2_000e18));
        vm.prank(owner);
        vault.schedule(up);
        warpBy(1 hours);
        vm.prank(guardian);
        vault.pause();
        vm.prank(owner);
        vault.unpause();
        warpBy(47 hours);
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        vault.execute(up);
        assertEq(vaultLens.maxTotalAssets(), 1_000e18);

        bytes memory sooner = abi.encodeCall(fd.setBatchInterval, (1 hours));
        vm.prank(owner);
        fd.schedule(sooner);
        warpBy(1 hours);
        vm.prank(guardian);
        fd.disableBridge(address(doorBridge));
        warpBy(47 hours);
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        fd.execute(sooner);
        assertEq(fd.batchInterval(), 12 hours);
    }

    /// A loosening past its bound is schedulable (scheduling checks no value, spec §3.10.6) and refused by the
    /// setter's own check at execute, the item kept; directly, it is refused as a loosening first.
    function test_anOutOfBoundsLooseningFailsOnlyAtExecute() public {
        bytes memory past = abi.encodeCall(vault.setOutflowLimits, (5_001, 100e18, 2_000));
        refusedDirect(vault, past);
        bytes32 id = scheduleParam(vault, past);
        vm.prank(owner);
        vm.expectRevert(InvalidParameter.selector);
        vault.execute(past);
        assertGt(vaultLens.scheduled(id).readyAt, 0, "the item stays");
        assertEq(vaultLens.maxDailyOutflowBps(), 2_000);
    }

    /// Every scheduled setter takes exactly its canonical length (one word per argument): a byte more, a word
    /// less or a word more is BadCalldata, nothing stored. Its sub-word arguments are checked by the setter's own
    /// decoder at execute: an item with dirty upper bits is schedulable but never runs (no data, the item kept).
    function test_scheduledSettersTakeOneCanonicalLength() public {
        bytes[11] memory onVault = [
            abi.encodeCall(vault.moveStake, (HK1, HK2, 1)),
            abi.encodeCall(vault.setStakeHotkey, (HK2)),
            abi.encodeCall(vault.setOutflowLimits, (3_000, 80e18, 3_000)),
            abi.encodeCall(vault.setMessageLimits, (2_000e18, 4_000e18, 5)),
            abi.encodeCall(vault.setFeeLimits, (200, 0.015e18)),
            abi.encodeCall(vault.setPayoutDelay, (2 hours)),
            abi.encodeCall(vault.setRewardCut, (carol, 1_000)),
            abi.encodeCall(vault.setMaxTotalAssets, (2_000e18)),
            abi.encodeCall(vault.setRewardVesting, (3 days)),
            abi.encodeCall(vault.setIdleBuffer, (0)),
            abi.encodeCall(vault.writeOffMissingStake, (1e9))
        ];
        for (uint256 i; i < onVault.length; ++i) {
            assertOneLength(vault, onVault[i]);
        }
        bytes[6] memory onDoor = [
            abi.encodeCall(fd.setOracle, (ICascadeTwap(oracle1))),
            abi.encodeCall(fd.setSwapper, (swapper1)),
            abi.encodeCall(fd.setMaxDeliverySlippage, (200)),
            abi.encodeCall(fd.setBatchInterval, (6 hours)),
            abi.encodeCall(fd.setMaxBatchValue, (4_500e18)),
            abi.encodeCall(fd.setMinPoolLiquidity, (1, 0))
        ];
        for (uint256 i; i < onDoor.length; ++i) {
            assertOneLength(fd, onDoor[i]);
        }

        // a uint64 delay with bit 64 set: schedulable, and refused by setPayoutDelay's decoder at execute
        bytes memory dirty = abi.encodeWithSelector(vault.setPayoutDelay.selector, uint256(1) << 64 | 2 hours);
        bytes32 id = scheduleParam(vault, dirty);
        vm.prank(owner);
        (bool ok, bytes memory ret) = address(vault).call(abi.encodeCall(vault.execute, (dirty)));
        assertFalse(ok);
        assertEq(ret.length, 0, "the decoder's bare revert");
        assertGt(vaultLens.scheduled(id).readyAt, 0);
        assertEq(vaultLens.payoutDelay(), 24 hours);

        // the same for setRewardVesting's uint64 period (Task 15)
        dirty = abi.encodeWithSelector(vault.setRewardVesting.selector, uint256(1) << 64 | 3 days);
        id = scheduleParam(vault, dirty);
        vm.prank(owner);
        (ok, ret) = address(vault).call(abi.encodeCall(vault.execute, (dirty)));
        assertFalse(ok);
        assertEq(ret.length, 0, "the decoder's bare revert");
        assertGt(vaultLens.scheduled(id).readyAt, 0);
        assertEq(vaultLens.rewardVesting(), 7 days);

        // the front door's two-word setMinPoolLiquidity (Task 32): a uint8 index with bit 8 set, and a uint128 floor
        // with bit 128 set, each schedulable and refused by the decoder at execute
        bytes[2] memory dirtyDoor = [
            abi.encodeWithSelector(fd.setMinPoolLiquidity.selector, uint256(1) << 8, uint256(0)),
            abi.encodeWithSelector(fd.setMinPoolLiquidity.selector, uint256(0), uint256(1) << 128)
        ];
        for (uint256 i; i < dirtyDoor.length; ++i) {
            id = scheduleParam(fd, dirtyDoor[i]);
            vm.prank(owner);
            (ok, ret) = address(fd).call(abi.encodeCall(fd.execute, (dirtyDoor[i])));
            assertFalse(ok);
            assertEq(ret.length, 0, "the decoder's bare revert");
            assertGt(doorLens.scheduled(id).readyAt, 0);
        }
        assertEq(fd.minPoolLiquidity(0), DOOR_TAO_WETH_FLOOR);
        assertEq(fd.minPoolLiquidity(1), DOOR_WETH_USDC_FLOOR);
    }

    function assertOneLength(CascadeBase c, bytes memory data) internal {
        bytes[3] memory wrong =
            [bytes.concat(data, hex"00"), slice(data, data.length - 32), bytes.concat(data, bytes32(0))];
        for (uint256 i; i < 3; ++i) {
            vm.prank(owner);
            vm.expectRevert(BadCalldata.selector);
            c.schedule(wrong[i]);
            assertEq(itemOf(c, keccak256(wrong[i])).readyAt, 0);
        }
        vm.prank(owner);
        c.schedule(data);
        assertGt(itemOf(c, keccak256(data)).readyAt, 0, "the canonical calldata schedules");
    }

    function slice(bytes memory data, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[i] = data[i];
        }
    }

    // ---- the immediate setters (I-29) ----

    function maskOf(uint256 offset, uint256 size) internal pure returns (uint256) {
        return size == 32 ? type(uint256).max : ((uint256(1) << (size * 8)) - 1) << (offset * 8);
    }

    function isIn(bytes32 s, bytes32[] memory list) internal pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == s) return true;
        }
        return false;
    }

    /// The fields a setter writes: each slot, and in it the mask of the setter's own bytes.
    struct Fields {
        bytes32[] slots;
        uint256[] masks;
    }

    function f1(uint256 slot, uint256 mask) internal pure returns (Fields memory f) {
        f.slots = new bytes32[](1);
        f.masks = new uint256[](1);
        (f.slots[0], f.masks[0]) = (bytes32(slot), mask);
    }

    function f2(uint256 slot0, uint256 mask0, uint256 slot1, uint256 mask1) internal pure returns (Fields memory f) {
        f.slots = new bytes32[](2);
        f.masks = new uint256[](2);
        (f.slots[0], f.masks[0]) = (bytes32(slot0), mask0);
        (f.slots[1], f.masks[1]) = (bytes32(slot1), mask1);
    }

    function f3(uint256 slot0, uint256 mask0, uint256 slot1, uint256 mask1, uint256 slot2, uint256 mask2)
        internal
        pure
        returns (Fields memory f)
    {
        f.slots = new bytes32[](3);
        f.masks = new uint256[](3);
        (f.slots[0], f.masks[0]) = (bytes32(slot0), mask0);
        (f.slots[1], f.masks[1]) = (bytes32(slot1), mask1);
        (f.slots[2], f.masks[2]) = (bytes32(slot2), mask2);
    }

    /// The owner's direct `data` on `target` applies at once and writes exactly `f`'s slots (each at least once,
    /// nothing else: no clock, no hold, no scheduled item), and in each only the setter's own bytes change.
    function assertWritesOnly(address target, bytes memory data, Fields memory f) internal {
        bytes32[] memory before = new bytes32[](f.slots.length);
        for (uint256 i; i < f.slots.length; ++i) {
            before[i] = vm.load(target, f.slots[i]);
        }
        vm.record();
        vm.prank(owner);
        (bool ok, bytes memory ret) = target.call(data);
        assertTrue(ok, string.concat("refused: ", vm.toString(ret)));
        (, bytes32[] memory writes) = vm.accesses(target);
        for (uint256 i; i < writes.length; ++i) {
            assertTrue(isIn(writes[i], f.slots), string.concat("a slot outside the setter's: ", vm.toString(writes[i])));
        }
        for (uint256 i; i < f.slots.length; ++i) {
            assertTrue(isIn(f.slots[i], writes), string.concat("a field not written: ", vm.toString(f.slots[i])));
            uint256 afterWord = uint256(vm.load(target, f.slots[i]));
            assertEq(afterWord & ~f.masks[i], uint256(before[i]) & ~f.masks[i], "only the setter's bytes change");
        }
    }

    /// The immediate setters, both ways, and every tightening, on the vault and the front door: each applies at
    /// once, writes only its own fields (no clock stamped, no hold recorded, nothing scheduled: I-29), and kills
    /// no pending item. The immediate setters are not schedulable at all (UnknownSelector).
    function test_immediateSettersStampNothing() public {
        bytes memory pendingOnVault = abi.encodeCall(vault.setMaxTotalAssets, (2_000e18));
        bytes memory pendingOnDoor = abi.encodeCall(fd.setMaxBatchValue, (4_500e18));
        vm.startPrank(owner);
        vault.schedule(pendingOnVault);
        fd.schedule(pendingOnDoor);
        vm.stopPrank();
        warpBy(1 hours);

        Fields memory keeperF = f1(VaultLayout.SLOT_KEEPER, maskOf(VaultLayout.OFFSET_KEEPER, VaultLayout.SIZE_KEEPER));
        assertWritesOnly(address(vault), abi.encodeCall(vault.setKeeper, (alice)), keeperF);
        assertWritesOnly(address(vault), abi.encodeCall(vault.setKeeper, (keeper)), keeperF);
        Fields memory f = f1(VaultLayout.SLOT_MIN_DIRECT_DEPOSIT, type(uint256).max);
        assertWritesOnly(address(vault), abi.encodeCall(vault.setMinDirectDeposit, (2e15)), f);
        assertWritesOnly(address(vault), abi.encodeCall(vault.setMinDirectDeposit, (5e14)), f);
        f = f1(VaultLayout.SLOT_HOTKEY_DUST_RAO, type(uint256).max);
        assertWritesOnly(address(vault), abi.encodeCall(vault.setHotkeyDustRao, (2_000_000)), f);
        assertWritesOnly(address(vault), abi.encodeCall(vault.setHotkeyDustRao, (500_000)), f);
        f = f1(VaultLayout.SLOT_UNSTAKE_MARGIN_RAO, type(uint256).max);
        assertWritesOnly(address(vault), abi.encodeCall(vault.setUnstakeMarginRao, (1e9)), f);
        assertWritesOnly(address(vault), abi.encodeCall(vault.setUnstakeMarginRao, (0)), f);
        f = f1(VaultLayout.SLOT_CLAIM_GAS_REQUIRED, type(uint256).max);
        assertWritesOnly(address(vault), abi.encodeCall(vault.setClaimGasRequired, (60_000_000)), f);
        assertWritesOnly(address(vault), abi.encodeCall(vault.setClaimGasRequired, (54_500_000)), f);
        f = f1(VaultLayout.SLOT_UNSTAKE_GAS, type(uint256).max);
        assertWritesOnly(address(vault), abi.encodeCall(vault.setUnstakeGas, (5_000_000)), f);
        assertWritesOnly(address(vault), abi.encodeCall(vault.setUnstakeGas, (150_000)), f);

        // the vault's tightenings
        assertWritesOnly(
            address(vault),
            abi.encodeCall(vault.setMaxTotalAssets, (500e18)),
            f1(VaultLayout.SLOT_MAX_TOTAL_ASSETS, type(uint256).max)
        );
        assertWritesOnly(
            address(vault),
            abi.encodeCall(vault.setOutflowLimits, (2_000, 50e18, 2_000)),
            f3(
                VaultLayout.SLOT_MAX_DAILY_OUTFLOW_BPS,
                type(uint256).max,
                VaultLayout.SLOT_MIN_DAILY_OUTFLOW,
                type(uint256).max,
                VaultLayout.SLOT_GLOBAL_OUTFLOW_BPS,
                type(uint256).max
            )
        );
        assertWritesOnly(
            address(vault),
            abi.encodeCall(vault.setMessageLimits, (1_500e18, 3_000e18, 20)),
            f3(
                VaultLayout.SLOT_MAX_ENTRY_VALUE,
                type(uint256).max,
                VaultLayout.SLOT_MAX_MESSAGE_VALUE,
                type(uint256).max,
                VaultLayout.SLOT_MIN_CHUNK,
                maskOf(VaultLayout.OFFSET_MIN_CHUNK, VaultLayout.SIZE_MIN_CHUNK)
            )
        );
        assertWritesOnly(
            address(vault),
            abi.encodeCall(vault.setFeeLimits, (50, 0.01e18)),
            f2(VaultLayout.SLOT_MAX_FEE_BPS, type(uint256).max, VaultLayout.SLOT_MAX_FEE_ABS, type(uint256).max)
        );
        assertWritesOnly(
            address(vault),
            abi.encodeCall(vault.setPayoutDelay, (36 hours)),
            f1(VaultLayout.SLOT_PAYOUT_DELAY, maskOf(VaultLayout.OFFSET_PAYOUT_DELAY, VaultLayout.SIZE_PAYOUT_DELAY))
        );
        assertWritesOnly(
            address(vault),
            abi.encodeCall(vault.setRewardCut, (treasury, 500)),
            f1(
                VaultLayout.SLOT_REWARD_CUT_BPS,
                maskOf(VaultLayout.OFFSET_TREASURY, VaultLayout.SIZE_TREASURY)
                    | maskOf(VaultLayout.OFFSET_REWARD_CUT_BPS, VaultLayout.SIZE_REWARD_CUT_BPS)
            )
        );
        assertWritesOnly(
            address(vault),
            abi.encodeCall(vault.setIdleBuffer, (1_000)),
            f1(
                VaultLayout.SLOT_IDLE_BUFFER_BPS,
                maskOf(VaultLayout.OFFSET_IDLE_BUFFER_BPS, VaultLayout.SIZE_IDLE_BUFFER_BPS)
            )
        );
        assertWritesOnly(
            address(vault),
            abi.encodeCall(vault.setRewardVesting, (14 days)),
            f1(
                VaultLayout.SLOT_REWARD_VESTING,
                maskOf(VaultLayout.OFFSET_REWARD_VESTING, VaultLayout.SIZE_REWARD_VESTING)
            )
        );

        // the front door's immediate setters, both ways
        f = f1(DoorLayout.SLOT_KEEPER, maskOf(DoorLayout.OFFSET_KEEPER, DoorLayout.SIZE_KEEPER));
        assertWritesOnly(address(fd), abi.encodeCall(fd.setKeeper, (alice)), f);
        assertWritesOnly(address(fd), abi.encodeCall(fd.setKeeper, (keeper)), f);
        f = f2(DoorLayout.SLOT_MIN_DEPOSIT, type(uint256).max, DoorLayout.SLOT_DEPOSIT_CAP, type(uint256).max);
        assertWritesOnly(address(fd), abi.encodeCall(fd.setCaps, (2e18, 20_000e18)), f);
        assertWritesOnly(address(fd), abi.encodeCall(fd.setCaps, (0.5e18, 5_000e18)), f);
        f = f1(
            DoorLayout.SLOT_MAX_DEPOSITS,
            maskOf(DoorLayout.OFFSET_MAX_DEPOSITS, DoorLayout.SIZE_MAX_DEPOSITS)
                | maskOf(DoorLayout.OFFSET_MAX_REDEEMS, DoorLayout.SIZE_MAX_REDEEMS)
        );
        assertWritesOnly(address(fd), abi.encodeCall(fd.setBatchLimits, (50, 50)), f);
        assertWritesOnly(address(fd), abi.encodeCall(fd.setBatchLimits, (10, 20)), f);
        f = f1(DoorLayout.SLOT_REDEEM_REQUEST_FEE, type(uint256).max);
        assertWritesOnly(address(fd), abi.encodeCall(fd.setRedeemRequestFee, (1e15)), f);
        assertWritesOnly(address(fd), abi.encodeCall(fd.setRedeemRequestFee, (1e13)), f);

        // the front door's tightenings
        assertWritesOnly(
            address(fd),
            abi.encodeCall(fd.setMaxBatchValue, (3_000e18)),
            f1(DoorLayout.SLOT_MAX_BATCH_VALUE, type(uint256).max)
        );
        assertWritesOnly(
            address(fd),
            abi.encodeCall(fd.setBatchInterval, (18 hours)),
            f1(DoorLayout.SLOT_BATCH_INTERVAL, maskOf(DoorLayout.OFFSET_BATCH_INTERVAL, DoorLayout.SIZE_BATCH_INTERVAL))
        );
        assertWritesOnly(
            address(fd),
            abi.encodeCall(fd.setMaxDeliverySlippage, (100)),
            f1(
                DoorLayout.SLOT_MAX_DELIVERY_SLIPPAGE_BPS,
                maskOf(DoorLayout.OFFSET_MAX_DELIVERY_SLIPPAGE_BPS, DoorLayout.SIZE_MAX_DELIVERY_SLIPPAGE_BPS)
            )
        );
        // the two floors share one slot (uint128[2]): each raise writes only its own half
        assertEq(DoorLayout.SIZE_MIN_POOL_LIQUIDITY, 32, "both floors in one slot");
        assertWritesOnly(
            address(fd),
            abi.encodeCall(fd.setMinPoolLiquidity, (0, 2 * DOOR_TAO_WETH_FLOOR)),
            f1(DoorLayout.SLOT_MIN_POOL_LIQUIDITY, maskOf(DoorLayout.OFFSET_MIN_POOL_LIQUIDITY, 16))
        );
        assertWritesOnly(
            address(fd),
            abi.encodeCall(fd.setMinPoolLiquidity, (1, 2 * DOOR_WETH_USDC_FLOOR)),
            f1(DoorLayout.SLOT_MIN_POOL_LIQUIDITY, maskOf(DoorLayout.OFFSET_MIN_POOL_LIQUIDITY + 16, 16))
        );

        // no clock, no hold, and the immediate setters are no items
        assertEq(vaultLens.lastOwnerClose(), 0);
        assertEq(vaultLens.lastGuardianClose(), 0);
        assertTrue(vaultLens.exitsOpen());
        assertEq(doorLens.lastOwnerClose(), 0);
        assertEq(doorLens.lastGuardianClose(), 0);
        assertTrue(doorLens.exitsOpen());
        bytes[6] memory vaultImmediate = [
            abi.encodeCall(vault.setKeeper, (alice)),
            abi.encodeCall(vault.setMinDirectDeposit, (2e15)),
            abi.encodeCall(vault.setHotkeyDustRao, (2_000_000)),
            abi.encodeCall(vault.setUnstakeMarginRao, (1e9)),
            abi.encodeCall(vault.setClaimGasRequired, (60_000_000)),
            abi.encodeCall(vault.setUnstakeGas, (1_000_000))
        ];
        for (uint256 i; i < vaultImmediate.length; ++i) {
            vm.prank(owner);
            vm.expectRevert(UnknownSelector.selector);
            vault.schedule(vaultImmediate[i]);
        }
        bytes[4] memory doorImmediate = [
            abi.encodeCall(fd.setKeeper, (alice)),
            abi.encodeCall(fd.setCaps, (2e18, 20_000e18)),
            abi.encodeCall(fd.setBatchLimits, (40, 30)),
            abi.encodeCall(fd.setRedeemRequestFee, (1e15))
        ];
        for (uint256 i; i < doorImmediate.length; ++i) {
            vm.prank(owner);
            vm.expectRevert(UnknownSelector.selector);
            fd.schedule(doorImmediate[i]);
        }

        // the items pending through all of it run
        warpBy(47 hours);
        vm.startPrank(owner);
        vault.execute(pendingOnVault);
        fd.execute(pendingOnDoor);
        vm.stopPrank();
        assertEq(vaultLens.maxTotalAssets(), 2_000e18);
        assertEq(fd.maxBatchValue(), 4_500e18);
    }
}
