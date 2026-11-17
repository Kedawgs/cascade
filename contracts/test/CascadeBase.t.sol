// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CascadeBase} from "../src/CascadeBase.sol";
import {Item} from "../src/CascadeTypes.sol";
import {
    BridgeNotEnabled,
    InvalidParameter,
    NotBridge,
    NotReady,
    NotGuardian,
    NotScheduled,
    PrimaryBridgeDisabled,
    PrimaryStillEnabled,
    RenounceDisabled,
    ZeroAddress
} from "../src/CascadeErrors.sol";
import {Schedule} from "./governance/Schedule.sol";

/// CascadeBase with its internal helpers and state exposed (no storage of its own). The scheduler, the
/// guardian's replacement and the bridge activations are test/governance/Scheduler.t.sol's (Task 7b removed
/// the registries they replace).
contract BaseHarness is CascadeBase {
    constructor(address owner_, address guardian_, address initialBridge, uint64 msPerBlock)
        CascadeBase(owner_, guardian_, initialBridge, msPerBlock)
    {}

    function requireBridge() external view {
        _requireBridge();
    }

    function primary() external view returns (address) {
        return address(_primary());
    }

    // CascadeBase's state, internal since Task 5d-1 (spec §8.1)

    function exposed_guardian() external view returns (address) {
        return guardian;
    }

    function exposed_bridgeEnabled(address bridge) external view returns (bool) {
        return bridgeEnabled[bridge];
    }

    function exposed_primaryBridge() external view returns (address) {
        return primaryBridge;
    }

    function item(bytes32 id) external view returns (Item memory) {
        return scheduled[id];
    }
}

contract CascadeBaseTest is Test {
    BaseHarness base;
    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address bridge = makeAddr("bridge");
    address bridge2 = makeAddr("bridge2");
    address stranger = makeAddr("stranger");
    address guardian2 = makeAddr("guardian2");

    function setUp() public {
        base = new BaseHarness(owner, guardian, bridge, 7_200);
    }

    function test_constructorEnablesInitialBridgeAsPrimary() public view {
        assertTrue(base.exposed_bridgeEnabled(bridge));
        assertEq(base.exposed_primaryBridge(), bridge);
        assertEq(base.exposed_guardian(), guardian);
        assertEq(base.owner(), owner);
    }

    function test_constructorRejectsZeroGuardianAndBridge() public {
        vm.expectRevert(ZeroAddress.selector);
        new BaseHarness(owner, address(0), bridge, 7_200);
        vm.expectRevert(ZeroAddress.selector);
        new BaseHarness(owner, guardian, address(0), 7_200);
    }

    // ---- the block floor (R1-A L-3; in milliseconds since Revision 28) ----

    /// The block time is 61 to 60,000 milliseconds, else InvalidParameter: every value a block time in seconds took
    /// before Revision 28 (1 to 60) is refused, so seconds cannot be taken for milliseconds (2 on Base would make a
    /// 48-hour item wait about 100 days, 12 on Bittensor about 1,000, behind an immutable; the review's I-2). It is
    /// immutable and public (the lenses ask the target for it).
    function test_constructorTakesABlockTimeOf61To60000Milliseconds() public {
        uint64[5] memory refused = [uint64(0), 1, 2, 12, 60];
        for (uint256 i; i < refused.length; ++i) {
            vm.expectRevert(InvalidParameter.selector);
            new BaseHarness(owner, guardian, bridge, refused[i]);
        }
        vm.expectRevert(InvalidParameter.selector);
        new BaseHarness(owner, guardian, bridge, 60_001);
        assertEq(new BaseHarness(owner, guardian, bridge, 61).MS_PER_BLOCK(), 61);
        assertEq(new BaseHarness(owner, guardian, bridge, 60_000).MS_PER_BLOCK(), 60_000);
        assertEq(base.MS_PER_BLOCK(), 7_200);
    }

    /// An item's readyBlock is the scheduling block plus half its delay in blocks, rounded up: 4 days of
    /// 7-second (7,000 ms) blocks is 49,371.43, so 49,372. At readyAt it still waits for readyBlock, and runs in it.
    function test_readyBlockIsHalfTheDelayInBlocksRoundedUp() public {
        BaseHarness b = new BaseHarness(owner, guardian, bridge, 7_000);
        vm.roll(1_000);
        bytes memory data = abi.encodeCall(b.setGuardian, (guardian2));
        vm.prank(owner);
        bytes32 id = b.schedule(data);
        Item memory it = b.item(id);
        assertEq(it.readyAt, vm.getBlockTimestamp() + 8 days);
        assertEq(it.readyBlock, 1_000 + 49_372);

        vm.warp(it.readyAt);
        vm.roll(it.readyBlock - 1);
        vm.prank(owner);
        vm.expectRevert(NotReady.selector);
        b.execute(data);
        vm.roll(it.readyBlock);
        vm.prank(owner);
        b.execute(data);
        assertEq(b.exposed_guardian(), guardian2);
    }

    /// The real chain from (`t0`, `b0`): `secs` seconds on, and the blocks a chain whose blocks take `ms`
    /// milliseconds makes in them, whole blocks only.
    function _chainAt(uint256 t0, uint256 b0, uint256 secs, uint256 ms) internal {
        vm.warp(t0 + secs);
        vm.roll(b0 + secs * 1000 / ms);
    }

    /// Schedules the guardian swap (the 8-day class) on a new contract told `ms` milliseconds a block, and
    /// returns the contract, the swap's calldata, and the time and block it was scheduled in.
    function _swapOn(uint64 ms) internal returns (BaseHarness b, bytes memory swap, uint256 t0, uint256 b0) {
        vm.warp(1_000_000);
        vm.roll(100);
        b = new BaseHarness(owner, guardian, bridge, ms);
        swap = abi.encodeCall(b.setGuardian, (guardian2));
        vm.prank(owner);
        b.schedule(swap);
        (t0, b0) = (vm.getBlockTimestamp(), vm.getBlockNumber());
    }

    /// R1 re-review, `test_lowSecondsPerBlockBricksTheGuardianSwap` ported: a block time of 6 s (6,000 ms) on a
    /// 12-second chain asked the 8-day swap for 115,200 blocks, 16 days of them, past readyAt + EXECUTE_WINDOW,
    /// so it could never run. Half its delay in blocks, 57,600, is 8 days of the real chain's: it runs at readyAt.
    function test_aBlockTimeHalfTheRealOneStillRunsTheGuardianSwap() public {
        (BaseHarness b, bytes memory swap, uint256 t0, uint256 b0) = _swapOn(6_000);
        assertEq(b.item(keccak256(swap)).readyBlock, b0 + 57_600);
        _chainAt(t0, b0, 8 days, 12_000);
        vm.prank(owner);
        b.execute(swap);
        assertEq(b.exposed_guardian(), guardian2);
    }

    /// R1 re-review, `test_secondsPerBlockOneOnBaseBricksTheGuardianSwap` ported to Base's 0.2-second blocks
    /// (Revision 28): a block time of 100 ms, half the real one, asks the swap for half its delay in 100 ms
    /// blocks, 3,456,000, which is 8 days of Base's: it runs at readyAt.
    function test_aBlockTimeHalfBasesRealOneStillRunsTheGuardianSwap() public {
        (BaseHarness b, bytes memory swap, uint256 t0, uint256 b0) = _swapOn(100);
        assertEq(b.item(keccak256(swap)).readyBlock, b0 + 3_456_000);
        _chainAt(t0, b0, 8 days, 200);
        vm.prank(owner);
        b.execute(swap);
        assertEq(b.exposed_guardian(), guardian2);
    }

    /// A chain slower than its block time: blocks 1.9 times slower (22.8 s against 12) make the 8-day swap's
    /// 28,800 blocks (half its delay) take 7.6 days, so it runs at readyAt; on blocks 3.7 times slower (44.4 s)
    /// they take 14.8 days, so it runs once its blocks are in, not before (and on slower blocks still, its window
    /// in blocks keeps it from lapsing first: BlockFloor.t.sol).
    function test_aChainSlowerThanItsBlockTimeStillRunsTheGuardianSwap() public {
        (BaseHarness b, bytes memory swap, uint256 t0, uint256 b0) = _swapOn(12_000);
        _chainAt(t0, b0, 8 days, 22_800);
        vm.prank(owner);
        b.execute(swap);
        assertEq(b.exposed_guardian(), guardian2);

        (b, swap, t0, b0) = _swapOn(12_000);
        _chainAt(t0, b0, 8 days, 44_400);
        vm.prank(owner);
        vm.expectRevert(NotReady.selector);
        b.execute(swap);
        // 28,800 blocks of 44.4 s: 1,278,720 seconds, 14.8 days
        uint256 half = 28_800;
        vm.roll(b0 + half - 1);
        vm.warp(t0 + (half - 1) * 444 / 10);
        vm.prank(owner);
        vm.expectRevert(NotReady.selector);
        b.execute(swap);
        vm.roll(b0 + half);
        vm.warp(t0 + half * 444 / 10);
        vm.prank(owner);
        b.execute(swap);
        assertEq(b.exposed_guardian(), guardian2);
    }

    function test_guardianDisablesBridge() public {
        vm.prank(guardian);
        base.disableBridge(bridge);
        assertFalse(base.exposed_bridgeEnabled(bridge));

        vm.prank(guardian);
        vm.expectRevert(BridgeNotEnabled.selector);
        base.disableBridge(bridge);
    }

    /// The switch is allowed only while the primary is disabled (Task 8), and only to an enabled bridge.
    function test_setPrimaryRequiresEnabled() public {
        vm.prank(owner);
        vm.expectRevert(PrimaryStillEnabled.selector);
        base.setPrimaryBridge(bridge2);
        vm.prank(guardian);
        base.disableBridge(bridge);
        vm.prank(owner);
        vm.expectRevert(BridgeNotEnabled.selector);
        base.setPrimaryBridge(bridge2);
    }

    /// The way off a disabled primary to a new bridge (spec §3.6 row 3): the new bridge is activated from
    /// OPEN (an Ordinary item, refused while the primary is held), then the primary is disabled and switched.
    function test_disabledPrimaryMakesPrimaryQueryRevert() public {
        Schedule.run(base, owner, abi.encodeCall(base.activateBridge, (bridge2)));
        vm.prank(guardian);
        base.disableBridge(bridge);
        vm.expectRevert(PrimaryBridgeDisabled.selector);
        base.primary();

        vm.prank(owner);
        base.setPrimaryBridge(bridge2);
        assertEq(base.primary(), bridge2);
    }

    function test_requireBridgeRejectsStranger() public {
        vm.prank(stranger);
        vm.expectRevert(NotBridge.selector);
        base.requireBridge();

        vm.prank(bridge);
        base.requireBridge();
    }

    function test_pauseByGuardianUnpauseByOwnerOnly() public {
        vm.prank(guardian);
        base.pause();
        assertTrue(base.paused());

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        base.unpause();

        vm.prank(owner);
        base.unpause();
        assertFalse(base.paused());

        vm.prank(stranger);
        vm.expectRevert(NotGuardian.selector);
        base.pause();
    }

    // ---- guardian replacement ----

    function test_noImmediateGuardianSetter() public {
        vm.prank(owner);
        vm.expectRevert(NotScheduled.selector);
        base.setGuardian(guardian2);
        assertEq(base.exposed_guardian(), guardian);
    }

    function test_renounceReverts() public {
        vm.prank(owner);
        vm.expectRevert(RenounceDisabled.selector);
        base.renounceOwnership();
    }
}
