// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ISTAKING_ADDRESS} from "../src/interfaces/IStaking.sol";
import {CascadeVault} from "../src/CascadeVault.sol";
import {StakeEngine} from "../src/StakeEngine.sol";
import {MockBridge} from "./mocks/MockBridge.sol";
import {MockStaking} from "./mocks/MockStaking.sol";
import {MockTAO} from "./mocks/MockTAO.sol";

/// @dev Whole epoch cycles with the vault and the engine wired together through MockBridge in one
/// EVM and MockStaking at the precompile address. Carol is a third-party keeper who closes and
/// settles every epoch, paying exactly the bridge fee. Literals are hand-derived from the
/// CascadeMath formulas: after a first deposit at the offset price S + 1e6 == 1e6 * (A + 1), so
/// 1e24 shares are worth exactly 1e18 until the stake grows.
contract EndToEndTest is Test {
    bytes32 constant HOTKEY = keccak256("validator");
    address constant GUARDIAN = address(0x6A2D);
    uint256 constant FEE = 0.001 ether;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    MockStaking staking;
    MockTAO tao;
    MockBridge bridge;
    StakeEngine engine;
    CascadeVault vault;
    bytes32 COLDKEY;

    function setUp() public {
        MockStaking impl = new MockStaking();
        vm.etch(ISTAKING_ADDRESS, address(impl).code);
        staking = MockStaking(ISTAKING_ADDRESS);
        staking.addHotkey(HOTKEY);

        tao = new MockTAO(18);
        bridge = new MockBridge(tao);

        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        COLDKEY = staking.mirror(predicted);
        engine = new StakeEngine(COLDKEY, HOTKEY, bridge, address(this), GUARDIAN);
        assertEq(address(engine), predicted);

        vault = new CascadeVault(IERC20Metadata(address(tao)), bridge, address(this), GUARDIAN, 1 days, 10_000e18, 1e18);
        bridge.connect(address(vault), payable(address(engine)));
        bridge.setFee(FEE);

        _fund(alice);
        _fund(bob);
        _fund(carol);
    }

    // ---- helpers ----

    function _fund(address user) internal {
        tao.mint(user, 1_000e18);
        vm.deal(user, 1 ether);
        vm.prank(user);
        tao.approve(address(vault), type(uint256).max);
    }

    function _deposit(address user, uint256 amount) internal {
        vm.prank(user);
        vault.requestDeposit(amount, user);
    }

    function _requestRedeem(address user, uint256 shares) internal {
        vm.prank(user);
        vault.requestRedeem(shares);
    }

    /// @dev Carol closes the open epoch once its duration has passed.
    function _close() internal {
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(carol);
        vault.closeEpoch{value: FEE}();
    }

    /// @dev Carol settles the engine's pending epoch.
    function _settle() internal {
        vm.prank(carol);
        engine.settleEpoch{value: FEE}();
    }

    function _claimShares(address user, uint64 id) internal {
        vm.prank(user);
        vault.claimShares(id);
    }

    function _claimAssets(address user, uint64 id) internal {
        vm.prank(user);
        vault.claimAssets(id);
    }

    function _assertStatus(uint64 id, CascadeVault.EpochStatus expected) internal view {
        assertEq(uint8(vault.epochs(id).status), uint8(expected));
    }

    /// @dev With nothing in flight the two books agree: the vault's recorded assets are exactly what
    /// the engine holds as root stake plus liquid balance.
    function _assertBooksAgree() internal view {
        assertEq(vault.inFlightEpoch(), 0);
        assertFalse(engine.hasPending());
        assertEq(vault.lastTotalAssets(), engine.totalAssets());
    }

    /// @dev Epoch 1: alice deposits 100e18 at the offset price and claims 100e24 csTAO; the engine
    /// stakes all of it to root.
    function _firstEpoch() internal {
        _deposit(alice, 100e18);
        _close();
        _settle();
        _claimShares(alice, 1);
    }

    /// @dev Epoch 2: alice escrows 50e24 of her 100e24 csTAO (worth exactly 50e18) and the epoch
    /// closes with no deposits.
    function _redeemEpoch() internal {
        _firstEpoch();
        _requestRedeem(alice, 50e24);
        _close();
    }

    // ---- end to end ----

    function test_e2e_depositCloseSettleClaim() public {
        _deposit(alice, 100e18);
        _close();
        assertTrue(engine.hasPending());
        assertEq(address(engine).balance, 100e18);
        _assertStatus(1, CascadeVault.EpochStatus.InFlight);

        _settle();
        _assertStatus(1, CascadeVault.EpochStatus.Settled);
        assertEq(engine.rootStakeRao(), 100e9);
        assertEq(address(engine).balance, 0);

        _claimShares(alice, 1);
        assertEq(vault.balanceOf(alice), 100e24);
        assertEq(tao.balanceOf(address(vault)), 0);
        assertEq(bridge.pendingCount(), 0);
        _assertBooksAgree();
    }

    /// @dev 0.05 TAO of root rewards in a day (about 18% APR) stays inside the vault's 20% bound.
    /// Bob's shares: 100e18 * (100e24 + 1e6) / (100.05e18 + 1), rounded down.
    function test_e2e_rewardsRaiseSharePrice() public {
        _firstEpoch();
        staking.accrueRootReward(COLDKEY, HOTKEY, 5e7);
        engine.claimRewards();
        assertEq(engine.rootStakeRao(), 100.05e9);

        _deposit(bob, 100e18);
        _close();
        vm.expectEmit(address(engine));
        emit StakeEngine.EpochSettled(2, 100.05e18, 0);
        _settle();

        _assertStatus(2, CascadeVault.EpochStatus.Settled);
        assertEq(vault.epochs(2).assetsBefore, 100.05e18);
        assertEq(engine.rootStakeRao(), 200.05e9);

        _claimShares(bob, 2);
        assertEq(vault.balanceOf(bob), 99950024987506246876562218);
        assertLt(vault.balanceOf(bob), vault.balanceOf(alice));
        assertGt(vault.lastPrice(), 1e12);
        _assertBooksAgree();
    }

    /// @dev Alice's payout: 50e24 * (100e18 + 1) / (100e24 + 1e6) == 50e18 exactly.
    function test_e2e_redeemRoundTrip() public {
        _redeemEpoch();
        vm.expectEmit(address(engine));
        emit StakeEngine.Unstaked(50e9);
        _settle();

        assertEq(engine.rootStakeRao(), 50e9);
        assertEq(address(engine).balance, 0);
        _assertStatus(2, CascadeVault.EpochStatus.Settled);
        assertEq(vault.epochs(2).assetsPaid, 50e18);
        assertEq(vault.totalSupply(), 50e24);

        _claimAssets(alice, 2);
        assertEq(tao.balanceOf(alice), 900e18 + 50e18);
        _assertBooksAgree();
    }

    /// @dev Bob's 60e18 covers alice's 50e18 payout, so the engine never unstakes and stakes the
    /// 10e18 net. Bob's shares: 60e18 * (100e24 + 1e6) / (100e18 + 1) == 60e24 exactly.
    function test_e2e_depositAndRedeemSameEpochNetsOnEngine() public {
        _firstEpoch();
        _deposit(bob, 60e18);
        _requestRedeem(alice, 50e24);
        _close();

        vm.recordLogs();
        _settle();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(engine)) assertNotEq(logs[i].topics[0], StakeEngine.Unstaked.selector);
        }
        assertEq(engine.rootStakeRao(), 110e9);
        assertEq(address(engine).balance, 0);
        _assertStatus(2, CascadeVault.EpochStatus.Settled);

        _claimShares(bob, 2);
        _claimAssets(alice, 2);
        assertEq(vault.balanceOf(bob), 60e24);
        assertEq(tao.balanceOf(alice), 900e18 + 50e18);
        _assertBooksAgree();
    }

    function test_e2e_manualDeliveryOrder() public {
        bridge.setAutoDeliver(false);
        _deposit(alice, 100e18);
        _close();
        assertEq(bridge.pendingCount(), 1);
        assertFalse(engine.hasPending());
        assertEq(address(engine).balance, 0);
        _assertStatus(1, CascadeVault.EpochStatus.InFlight);

        bridge.deliverNext();
        assertEq(bridge.pendingCount(), 0);
        assertTrue(engine.hasPending());
        assertEq(address(engine).balance, 100e18);

        _settle();
        assertEq(bridge.pendingCount(), 1);
        assertEq(engine.lastSettledEpoch(), 1);
        assertEq(engine.rootStakeRao(), 100e9);
        _assertStatus(1, CascadeVault.EpochStatus.InFlight);

        bridge.deliverNext();
        assertEq(bridge.pendingCount(), 0);
        _assertStatus(1, CascadeVault.EpochStatus.Settled);
        _assertBooksAgree();

        vm.expectRevert(MockBridge.NothingPending.selector);
        bridge.deliverNext();
    }

    /// @dev A 5% stake jump two days after the last price exceeds the 20% APR bound. Bob's shares
    /// after the owner accepts: 100e18 * (100e24 + 1e6) / (105e18 + 1), rounded down.
    function test_e2e_unexpectedStakeJumpFlagsAndOwnerAccepts() public {
        _firstEpoch();
        vm.warp(block.timestamp + 1 days);
        staking.donateStake(HOTKEY, COLDKEY, 5e9);
        _deposit(bob, 100e18);
        _close();
        _settle();

        _assertStatus(2, CascadeVault.EpochStatus.Flagged);
        assertTrue(vault.paused());
        assertEq(vault.epochs(2).assetsBefore, 105e18);
        assertFalse(engine.hasPending());
        assertFalse(engine.paused());
        assertEq(engine.lastSettledEpoch(), 2);
        assertEq(engine.rootStakeRao(), 205e9);

        vault.acceptFlaggedEpoch();
        _assertStatus(2, CascadeVault.EpochStatus.Settled);
        assertTrue(vault.paused());
        vault.unpause();

        _claimShares(bob, 2);
        assertEq(vault.balanceOf(bob), 95238095238095238095283446);
        _assertBooksAgree();
    }

    function test_e2e_unstakeBlockedCanRetryLater() public {
        _redeemEpoch();
        staking.setUnstakeBlocked(true);
        vm.expectRevert(MockStaking.TooEarly.selector);
        _settle();

        _assertStatus(2, CascadeVault.EpochStatus.InFlight);
        assertTrue(engine.hasPending());
        assertEq(engine.rootStakeRao(), 100e9);
        assertEq(bridge.pendingCount(), 0);

        staking.setUnstakeBlocked(false);
        _settle();
        _assertStatus(2, CascadeVault.EpochStatus.Settled);
        assertEq(engine.rootStakeRao(), 50e9);

        _claimAssets(alice, 2);
        assertEq(tao.balanceOf(alice), 900e18 + 50e18);
        _assertBooksAgree();
    }

    function test_e2e_vaultPausedStillReceivesResult() public {
        _deposit(alice, 100e18);
        _close();
        vm.prank(GUARDIAN);
        vault.pause();

        _settle();
        _assertStatus(1, CascadeVault.EpochStatus.Settled);
        assertTrue(vault.paused());
        assertEq(engine.rootStakeRao(), 100e9);

        _claimShares(alice, 1);
        assertEq(vault.balanceOf(alice), 100e24);
        _assertBooksAgree();
    }

    /// @dev Two closes and two settles pay four fees into the bridge, plus the 50e18 payout. The
    /// bridge's vault-to-engine deliveries are value-neutral: it deals itself what it forwards.
    function test_e2e_allValueLeavingEngineReachesTheBridge() public {
        _redeemEpoch();
        _settle();

        assertEq(address(engine).balance, 0);
        assertEq(address(bridge).balance, 50e18 + 4 * FEE);
        assertEq(carol.balance, 1 ether - 4 * FEE);
        assertEq(address(vault).balance, 0);
        assertEq(tao.balanceOf(address(vault)), 50e18);
        _assertBooksAgree();
    }
}
