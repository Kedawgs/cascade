// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {CascadeBase} from "../../src/CascadeBase.sol";
import {Delay, Item, Kind} from "../../src/CascadeTypes.sol";
import {LapsedItem, NotReady} from "../../src/CascadeErrors.sol";
import {Lapsed} from "../../src/CascadeEvents.sol";

/// CascadeBase at any block time, with a Param-class item (48 hours) that changes nothing but a counter, beside
/// CascadeBase's own Registry (7 days: activateBridge) and Guardian (8 days: setGuardian) classes.
contract FloorHarness is CascadeBase {
    uint256 public touches;

    constructor(address owner_, address guardian_, address bridge_, uint64 msPerBlock)
        CascadeBase(owner_, guardian_, bridge_, msPerBlock)
    {}

    /// The Param-class item: scheduled only.
    function touch() external onlyScheduled {
        ++touches;
    }

    function item(bytes32 id) external view returns (Item memory) {
        return scheduled[id];
    }

    function _classify(bytes calldata data) internal view override returns (Delay, Kind) {
        // casting to 'bytes4' keeps the selector, the first 4 bytes of data
        // forge-lint: disable-next-line(unsafe-typecast)
        if (bytes4(data) == this.touch.selector) {
            _requireArgs(data, 0);
            return (Delay.Param, Kind.Ordinary);
        }
        return super._classify(data);
    }
}

/// @notice Revision 28 (Base's 0.2-second blocks from block 53,556,128, 2026-11-05): the scheduler's block floor in
/// milliseconds, calibrated for blocks twice as fast as each chain's today (Base 120 ms against 0.2 s, Bittensor 7,200
/// against 12 s), and its lapse, which needs both its window in time and its window in blocks passed, so a slowdown
/// never strands an item and a speed-up leaves the lapse exactly the time window it was.
///
/// The numbers, each exact at the deploy values (no rounding): half a delay in calibrated blocks is 720,000 (48 hours),
/// 2,520,000 (7 days) and 2,880,000 (8 days) on Base, 12,000, 42,000 and 48,000 on Bittensor; at today's speeds they
/// take 40, 140 and 160 hours, 5/6 of each delay, and after a 2x speed-up half that, 5/12. The window in blocks after
/// readyBlock is half EXECUTE_WINDOW in calibrated blocks: 2,520,000 on Base, 42,000 on Bittensor.
///
/// The floor guards a chain whose blocks stop in a halt, Bittensor's (the vault). Base's block number follows its
/// timestamp and an outage's blocks are back-filled, so the front door's floor comes with readyAt (the review's I-1:
/// test_onBaseAnOutageBackfillsItsBlocksSoTheFloorComesWithReadyAt); the halts here are Bittensor's, the slowdowns
/// both chains' (on Base only a fork could slow its blocks).
contract BlockFloorTest is Test {
    uint64 constant BASE_MS = 120;
    uint64 constant BITTENSOR_MS = 7_200;
    /// Today's block times, in milliseconds.
    uint256 constant BASE_TODAY = 200;
    uint256 constant BITTENSOR_TODAY = 12_000;
    uint256 constant WINDOW = 7 days;

    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address bridge = makeAddr("bridge");
    address bridge2 = makeAddr("bridge2");
    address guardian2 = makeAddr("guardian2");
    address stranger = makeAddr("stranger");

    // ---- helpers ----

    /// The three classes' items: the 48-hour touch, the 7-day activation, the 8-day guardian swap.
    function _items(FloorHarness h) internal view returns (bytes[3] memory data, uint256[3] memory delays) {
        data = [
            abi.encodeCall(h.touch, ()),
            abi.encodeCall(h.activateBridge, (bridge2)),
            abi.encodeCall(h.setGuardian, (guardian2))
        ];
        delays = [uint256(48 hours), 7 days, 8 days];
    }

    /// A harness told `ms` milliseconds a block, with each class's item scheduled at (`t0`, `b0`) = (1,000,000, 100).
    function _scheduled(uint64 ms) internal returns (FloorHarness h, bytes[3] memory data, uint256[3] memory delays) {
        vm.warp(1_000_000);
        vm.roll(100);
        h = new FloorHarness(owner, guardian, bridge, ms);
        (data, delays) = _items(h);
        for (uint256 k; k < 3; ++k) {
            vm.prank(owner);
            h.schedule(data[k]);
        }
    }

    function _item(FloorHarness h, bytes memory data) internal view returns (Item memory) {
        return h.item(keccak256(data));
    }

    /// Half `secs` in `ms` blocks, rounded up: the contract's _halfInBlocks.
    function _half(uint256 secs, uint256 ms) internal pure returns (uint256) {
        return (secs * 1000 + 2 * ms - 1) / (2 * ms);
    }

    /// Whether the owner's execute of `data` runs at (`t`, `n`), tried in a snapshot; its revert data if not.
    function _runsAt(FloorHarness h, bytes memory data, uint256 t, uint256 n) internal returns (bool ok, bytes memory) {
        uint256 snap = vm.snapshotState();
        vm.warp(t);
        vm.roll(n);
        vm.prank(owner);
        bytes memory why;
        (ok, why) = address(h).call(abi.encodeCall(CascadeBase.execute, (data)));
        vm.revertToState(snap);
        return (ok, why);
    }

    function _assertRuns(FloorHarness h, bytes memory data, uint256 t, uint256 n, string memory what) internal {
        (bool ok, bytes memory why) = _runsAt(h, data, t, n);
        assertTrue(ok, what);
        assertEq(why.length, 0, what);
    }

    function _assertRefused(FloorHarness h, bytes memory data, uint256 t, uint256 n, bytes4 err, string memory what)
        internal
    {
        (bool ok, bytes memory why) = _runsAt(h, data, t, n);
        assertFalse(ok, what);
        assertEq(why, abi.encodeWithSelector(err), what);
    }

    /// Whether anyone's prune of `data`'s item works at (`t`, `n`), tried in a snapshot.
    function _prunesAt(FloorHarness h, bytes memory data, uint256 t, uint256 n) internal returns (bool ok) {
        uint256 snap = vm.snapshotState();
        vm.warp(t);
        vm.roll(n);
        vm.prank(stranger);
        (ok,) = address(h).call(abi.encodeCall(CascadeBase.prune, (keccak256(data))));
        vm.revertToState(snap);
    }

    // ---- the floor at the deploy values ----

    /// Each class's readyBlock at both deploy values, and the time it takes at today's speeds (5/6 of the delay) and
    /// after a 2x speed-up (5/12); on today's chain the floor's blocks are in before readyAt, so each item runs at
    /// its readyAt and not a second before.
    function test_theFloorAtTheDeployValues() public {
        uint256[3] memory baseBlocks = [uint256(720_000), 2_520_000, 2_880_000];
        uint256[3] memory bittensorBlocks = [uint256(12_000), 42_000, 48_000];
        uint256[3] memory hoursToday = [uint256(40), 140, 160];
        for (uint256 c; c < 2; ++c) {
            uint64 ms = c == 0 ? BASE_MS : BITTENSOR_MS;
            uint256 today = c == 0 ? BASE_TODAY : BITTENSOR_TODAY;
            (FloorHarness h, bytes[3] memory data, uint256[3] memory delays) = _scheduled(ms);
            assertEq(h.MS_PER_BLOCK(), ms);
            for (uint256 k; k < 3; ++k) {
                Item memory it = _item(h, data[k]);
                uint256 blocks = it.readyBlock - 100;
                assertEq(blocks, c == 0 ? baseBlocks[k] : bittensorBlocks[k], "half the delay in calibrated blocks");
                assertEq(blocks, _half(delays[k], ms), "the contract's rounding");
                assertEq(it.readyAt, 1_000_000 + delays[k], "and the delay in time");
                // today: 5/6 of the delay; after a 2x speed-up: 5/12
                assertEq(blocks * today / 1000, hoursToday[k] * 1 hours, "the floor's time at today's speed");
                assertEq(blocks * today * 6, delays[k] * 5 * 1000, "5/6 of the delay today");
                assertEq(blocks * (today / 2) * 12, delays[k] * 5 * 1000, "5/12 after a 2x speed-up");
                // on today's chain: not a second early, and at readyAt its blocks are in
                uint256 early = it.readyAt - 1;
                _assertRefused(
                    h, data[k], early, 100 + (early - 1_000_000) * 1000 / today, NotReady.selector, "a second early"
                );
                uint256 atReady = 100 + delays[k] * 1000 / today;
                assertGe(atReady, it.readyBlock, "the floor's blocks are in by readyAt today");
                _assertRuns(h, data[k], it.readyAt, atReady, "at readyAt on today's chain");
            }
        }
    }

    // ---- a halt ----

    /// A halt longer than an item's delay, on the vault's chain, Bittensor, whose blocks stop in a halt: the item
    /// stays NotReady after the chain resumes until its floor's blocks have come (39 hours of 12-second blocks after
    /// one live hour), so the guardian has the resume blocks to cancel in; it runs at readyBlock and not a block
    /// before.
    function test_aHaltHoldsAnItemUntilItsFloorAfterTheResume() public {
        (FloorHarness h, bytes[3] memory data,) = _scheduled(BITTENSOR_MS);
        bytes memory touch = data[0];
        Item memory it = _item(h, touch);
        // one live hour of Bittensor's blocks, then a 3-day halt, then one block
        uint256 live = 1 hours * 1000 / BITTENSOR_TODAY;
        uint256 resumedAt = 1_000_000 + 1 hours + 3 days;
        uint256 resumeBlock = 100 + live + 1;
        assertGt(resumedAt, it.readyAt, "the delay has passed in time");
        _assertRefused(h, touch, resumedAt, resumeBlock, NotReady.selector, "the first block after the resume");
        // the guardian cancels in it
        uint256 snap = vm.snapshotState();
        vm.warp(resumedAt);
        vm.roll(resumeBlock);
        vm.prank(guardian);
        h.cancel(keccak256(touch));
        assertEq(_item(h, touch).readyAt, 0, "cancelled in the resume block");
        vm.revertToState(snap);
        // the live chain from the resume: one block short of readyBlock is not ready, readyBlock is
        uint256 left = it.readyBlock - resumeBlock;
        assertEq(left, 12_000 - live - 1, "the floor's blocks less the live hour's and the resume block");
        assertApproxEqAbs(left * BITTENSOR_TODAY / 1000, 39 hours, 12, "39 hours of 12-second blocks left");
        uint256 lastNot = resumedAt + (left - 1) * BITTENSOR_TODAY / 1000;
        _assertRefused(h, touch, lastNot, it.readyBlock - 1, NotReady.selector, "a block short of readyBlock");
        _assertRuns(h, touch, resumedAt + left * BITTENSOR_TODAY / 1000, it.readyBlock, "at readyBlock");
    }

    /// ChatGPT R2 G (R6): the floor counts blocks since the scheduling block, not after a halt. A halt that begins once
    /// the floor's 12,000 blocks are in (41 live hours of a 48-hour item) and spans readyAt leaves the item ready in the
    /// first block after the resume: the guardian's window was the 12,300 live blocks before the halt, and a cancel in
    /// the resume block races the execute (whichever is ordered first wins).
    function test_aHaltAfterTheFloorSpanningReadyAtLeavesItReadyAtTheResume() public {
        (FloorHarness h, bytes[3] memory data,) = _scheduled(BITTENSOR_MS);
        bytes memory touch = data[0];
        Item memory it = _item(h, touch);
        uint256 live = 41 hours * 1000 / BITTENSOR_TODAY; // 12,300 blocks of 12 s
        uint256 haltedAt = 1_000_000 + 41 hours;
        assertGt(100 + live, it.readyBlock, "the floor's blocks came before the halt");
        assertLt(haltedAt, it.readyAt, "the halt began before readyAt");
        _assertRefused(h, touch, haltedAt, 100 + live, NotReady.selector, "not ready in the last block before the halt");
        // a 9-hour halt, then one block at 50 hours
        uint256 resumedAt = 1_000_000 + 50 hours;
        uint256 resumeBlock = 100 + live + 1;
        _assertRuns(h, touch, resumedAt, resumeBlock, "ready in the first block after the resume");
        // the guardian can still cancel in that block
        vm.warp(resumedAt);
        vm.roll(resumeBlock);
        vm.prank(guardian);
        h.cancel(keccak256(touch));
        assertEq(_item(h, touch).readyAt, 0, "cancelled in the resume block");
    }

    /// A halt longer than the whole window, on Bittensor: the old lapse (time only) killed the item at the resume;
    /// now it keeps its window in blocks, so it runs once its floor's blocks are in, and lapses only after its window
    /// in blocks.
    function test_aHaltLongerThanTheWindowStrandsNoItem() public {
        (FloorHarness h, bytes[3] memory data,) = _scheduled(BITTENSOR_MS);
        bytes memory touch = data[0];
        Item memory it = _item(h, touch);
        uint256 live = 1 hours * 1000 / BITTENSOR_TODAY;
        uint256 resumedAt = 1_000_000 + 1 hours + 20 days;
        assertGt(resumedAt, uint256(it.readyAt) + WINDOW, "the window has passed in time");
        // NotReady, not lapsed: prune is refused
        _assertRefused(h, touch, resumedAt, 100 + live + 1, NotReady.selector, "the resume block");
        assertFalse(_prunesAt(h, touch, resumedAt, 100 + live + 1), "no prune: its window in blocks is ahead");
        // runs at readyBlock, and at the window in blocks' last block
        uint256 window = _half(WINDOW, BITTENSOR_MS);
        assertEq(window, 42_000, "half EXECUTE_WINDOW in 7.2-second blocks");
        uint256 runsAt = resumedAt + (it.readyBlock - 100 - live - 1) * BITTENSOR_TODAY / 1000;
        _assertRuns(h, touch, runsAt, it.readyBlock, "at readyBlock, 20 days after its window in time");
        uint256 end = runsAt + window * BITTENSOR_TODAY / 1000;
        _assertRuns(h, touch, end, it.readyBlock + window, "the window in blocks' last block");
        assertFalse(_prunesAt(h, touch, end, it.readyBlock + window), "no prune in it");
        uint256 after_ = end + BITTENSOR_TODAY / 1000;
        _assertRefused(h, touch, after_, it.readyBlock + window + 1, LapsedItem.selector, "lapsed after it");
        assertTrue(_prunesAt(h, touch, after_, it.readyBlock + window + 1), "pruned after it");
    }

    /// Base gives each block number a fixed timestamp (genesis plus n blocks of its block time, piecewise across the
    /// 0.2-second fork), and an outage's blocks are filled in at their own timestamps (the sequencer's catch-up, or
    /// derivation past the sequencing window; the review's I-1): on the front door a halt leaves no floor to wait
    /// for. After a 3-day outage the catch-up blocks pass readyBlock, and a 48-hour item runs at the first of them
    /// whose timestamp reaches readyAt. There the protection is the guardian's cancel (by L1 forced inclusion
    /// too) and the owner's stamp, as it always was under R1-A L-3; the floor protects the vault's chain. On Base's
    /// clock the floor's blocks are in by 5/6 of each delay, so it never holds an item past readyAt.
    function test_onBaseAnOutageBackfillsItsBlocksSoTheFloorComesWithReadyAt() public {
        (FloorHarness h, bytes[3] memory data, uint256[3] memory delays) = _scheduled(BASE_MS);
        uint256 resumedAt = 1_000_000 + 1 hours + 3 days;
        uint256 backfilled = 100 + (resumedAt - 1_000_000) * 1000 / BASE_TODAY;
        assertGt(backfilled, _item(h, data[0]).readyBlock, "the back-filled blocks pass readyBlock");
        _assertRuns(h, data[0], resumedAt, backfilled, "the first block after the outage");
        for (uint256 k; k < 3; ++k) {
            assertGe(100 + delays[k] * 1000 / BASE_TODAY, _item(h, data[k]).readyBlock, "in by readyAt on Base's clock");
        }
    }

    // ---- the lapse ----

    /// On blocks ten times slower than calibrated (Base 1.2 s, Bittensor 72 s) every class's floor lands after its
    /// time window (48 hours: 10 days against 9), where the old time-only lapse stranded it: now it is NotReady
    /// until readyBlock (and not prunable), runs from readyBlock to the last block of its window in blocks, and
    /// lapses, prunable, only after both windows.
    function test_onBlocksTenTimesSlowerAnItemRunsAfterBothClocksAndLapsesAfterBothWindows() public {
        for (uint256 c; c < 2; ++c) {
            uint64 ms = c == 0 ? BASE_MS : BITTENSOR_MS;
            uint256 slow = uint256(ms) * 10;
            uint256 window = _half(WINDOW, ms);
            assertEq(window, c == 0 ? 2_520_000 : 42_000);
            (FloorHarness h, bytes[3] memory data,) = _scheduled(ms);
            for (uint256 k; k < 3; ++k) {
                Item memory it = _item(h, data[k]);
                uint256 floorAt = 1_000_000 + (it.readyBlock - 100) * slow / 1000;
                assertGt(floorAt, uint256(it.readyAt) + WINDOW, "the floor lands after the time window");
                // past the time window, blocks short: NotReady, and no prune
                uint256 t = uint256(it.readyAt) + WINDOW + 1;
                uint256 n = 100 + (t - 1_000_000) * 1000 / slow;
                _assertRefused(h, data[k], t, n, NotReady.selector, "past the time window, before readyBlock");
                assertFalse(_prunesAt(h, data[k], t, n), "not lapsed");
                _assertRefused(h, data[k], floorAt - slow / 1000, it.readyBlock - 1, NotReady.selector, "a block short");
                _assertRuns(h, data[k], floorAt, it.readyBlock, "at readyBlock");
                uint256 end = floorAt + window * slow / 1000;
                _assertRuns(h, data[k], end, it.readyBlock + window, "the window in blocks' last block");
                assertFalse(_prunesAt(h, data[k], end, it.readyBlock + window), "not lapsed in it");
                uint256 after_ = end + slow / 1000;
                _assertRefused(
                    h, data[k], after_, it.readyBlock + window + 1, LapsedItem.selector, "lapsed after both windows"
                );
                assertTrue(_prunesAt(h, data[k], after_, it.readyBlock + window + 1), "prunable after both windows");
            }
        }
    }

    /// On the calibrated blocks, twice as fast, and today's (5/3 of the calibrated block time), the blocks pass
    /// first, so every class lapses exactly as its time window ends, as before Revision 28: it runs at readyAt +
    /// EXECUTE_WINDOW, not prunable, and one second later it is lapsed and prunable.
    function test_onBlocksUpToTodaysTheLapseIsTheTimeWindow() public {
        for (uint256 c; c < 2; ++c) {
            uint64 ms = c == 0 ? BASE_MS : BITTENSOR_MS;
            uint256[3] memory speeds = [uint256(ms), ms / 2, c == 0 ? BASE_TODAY : BITTENSOR_TODAY];
            (FloorHarness h, bytes[3] memory data,) = _scheduled(ms);
            for (uint256 s; s < 3; ++s) {
                for (uint256 k; k < 3; ++k) {
                    Item memory it = _item(h, data[k]);
                    uint256 end = uint256(it.readyAt) + WINDOW;
                    uint256 n = 100 + (end - 1_000_000) * 1000 / speeds[s];
                    _assertRuns(h, data[k], end, n, "the time window's last second");
                    assertFalse(_prunesAt(h, data[k], end, n), "not prunable in it");
                    uint256 n1 = 100 + (end + 1 - 1_000_000) * 1000 / speeds[s];
                    assertGt(n1, it.readyBlock + _half(WINDOW, ms), "the window in blocks has passed already");
                    _assertRefused(h, data[k], end + 1, n1, LapsedItem.selector, "lapsed a second after");
                    assertTrue(_prunesAt(h, data[k], end + 1, n1), "prunable a second after");
                }
            }
        }
    }

    /// The rule at its edges: past the time window with the window in blocks' last block, or past the window in
    /// blocks at the time window's last second, the item runs; one past both, it is lapsed.
    function test_theLapseNeedsBothWindowsPassed() public {
        (FloorHarness h, bytes[3] memory data,) = _scheduled(BASE_MS);
        Item memory it = _item(h, data[0]);
        uint256 end = uint256(it.readyAt) + WINDOW;
        uint256 lastBlock = it.readyBlock + _half(WINDOW, BASE_MS);
        _assertRuns(h, data[0], end + 1, lastBlock, "time passed, blocks not");
        _assertRuns(h, data[0], end, lastBlock + 1, "blocks passed, time not");
        _assertRefused(h, data[0], end + 1, lastBlock + 1, LapsedItem.selector, "both passed");
        // and prune with it, the Lapsed event logged
        vm.warp(end + 1);
        vm.roll(lastBlock + 1);
        vm.expectEmit(address(h));
        emit Lapsed(keccak256(data[0]));
        vm.prank(stranger);
        h.prune(keccak256(data[0]));
        assertEq(_item(h, data[0]).readyAt, 0, "pruned");
    }
}
