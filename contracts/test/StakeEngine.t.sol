// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ISTAKING_ADDRESS} from "../src/interfaces/IStaking.sol";
import {ICascadeBridge} from "../src/interfaces/ICascadeBridge.sol";
import {CascadeMessages} from "../src/libraries/CascadeMessages.sol";
import {StakeEngine} from "../src/StakeEngine.sol";
import {MockStaking} from "./mocks/MockStaking.sol";
import {StubBridge} from "./mocks/StubBridge.sol";

contract StakeEngineTest is Test {
    bytes32 constant HOTKEY = keccak256("validator");
    bytes32 constant HOTKEY2 = keccak256("validator2");
    address constant GUARDIAN = address(0x6A2D);
    address constant BAD = address(0xBAD);

    MockStaking staking;
    StubBridge bridge;
    StakeEngine engine;
    bytes32 coldkey;

    function setUp() public {
        MockStaking impl = new MockStaking();
        vm.etch(ISTAKING_ADDRESS, address(impl).code);
        staking = MockStaking(ISTAKING_ADDRESS);
        staking.addHotkey(HOTKEY);
        staking.addHotkey(HOTKEY2);

        bridge = new StubBridge(IERC20(address(0)));

        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        coldkey = staking.mirror(predicted);
        engine = new StakeEngine(coldkey, HOTKEY, bridge, address(this), GUARDIAN);
        assertEq(address(engine), predicted);
    }

    /// @dev Delivers an epoch request from the bridge with `deposits` attached as native TAO.
    function _deliver(uint64 id, uint256 deposits, uint256 redeemShares, uint256 supply) internal {
        vm.deal(address(bridge), deposits);
        vm.prank(address(bridge));
        engine.onBridgeMessage{value: deposits}(CascadeMessages.encodeRequest(id, redeemShares, supply), deposits);
    }

    /// @dev Epoch 1: a 10 TAO first deposit, settled and staked to root.
    function _stakeTen() internal {
        _deliver(1, 10e18, 0, 0);
        engine.settleEpoch();
        assertEq(engine.rootStakeRao(), 10e9);
    }

    // ---- constructor ----

    function test_constructorSetsRejectGrowth() public view {
        assertTrue(staking.rejectsGrowth(coldkey));
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(StakeEngine.ZeroAddress.selector);
        new StakeEngine(coldkey, HOTKEY, ICascadeBridge(address(0)), address(this), GUARDIAN);

        vm.expectRevert(StakeEngine.ZeroAddress.selector);
        new StakeEngine(coldkey, HOTKEY, bridge, address(this), address(0));
    }

    // ---- onBridgeMessage ----

    function test_onBridgeMessage_onlyBridge() public {
        vm.prank(BAD);
        vm.expectRevert(StakeEngine.NotBridge.selector);
        engine.onBridgeMessage(CascadeMessages.encodeRequest(1, 0, 0), 0);
    }

    function test_onBridgeMessage_valueMustMatchAmount() public {
        vm.deal(address(bridge), 1e18);
        vm.prank(address(bridge));
        vm.expectRevert(StakeEngine.ValueMismatch.selector);
        engine.onBridgeMessage{value: 1e18}(CascadeMessages.encodeRequest(1, 0, 0), 2e18);
    }

    function test_onBridgeMessage_recordsRequest() public {
        vm.expectEmit(address(engine));
        emit StakeEngine.EpochReceived(1, 10e18, 0, 0);
        _deliver(1, 10e18, 0, 0);

        assertTrue(engine.hasPending());
        (uint64 epochId, uint256 depositAssets, uint256 redeemShares, uint256 totalSupply) = engine.pending();
        assertEq(epochId, 1);
        assertEq(depositAssets, 10e18);
        assertEq(redeemShares, 0);
        assertEq(totalSupply, 0);
        assertEq(address(engine).balance, 10e18);
    }

    function test_onBridgeMessage_rejectsSecondWhilePending() public {
        _deliver(1, 10e18, 0, 0);
        vm.expectRevert(StakeEngine.EpochPending.selector);
        _deliver(2, 1e18, 0, 0);
    }

    function test_onBridgeMessage_rejectsStaleEpoch() public {
        _deliver(1, 10e18, 0, 0);
        engine.settleEpoch();
        vm.expectRevert(StakeEngine.StaleEpoch.selector);
        _deliver(1, 1e18, 0, 0);
    }

    function test_onBridgeMessage_rejectsRedeemOverSupply() public {
        vm.expectRevert(StakeEngine.InvalidRedeem.selector);
        _deliver(1, 0, 5, 4);
    }

    function test_onBridgeMessage_worksWhilePaused() public {
        vm.prank(GUARDIAN);
        engine.pause();
        _deliver(1, 10e18, 0, 0);
        assertTrue(engine.paused());
        assertTrue(engine.hasPending());
    }

    // ---- settleEpoch ----

    function test_settleEpoch_noPendingReverts() public {
        vm.expectRevert(StakeEngine.NoPendingEpoch.selector);
        engine.settleEpoch();
    }

    function test_settleEpoch_firstDepositStakesEverything() public {
        _deliver(1, 10e18, 0, 0);
        vm.expectEmit(address(engine));
        emit StakeEngine.EpochSettled(1, 0, 0);
        vm.expectEmit(address(engine));
        emit StakeEngine.Staked(10e9);
        engine.settleEpoch();

        assertEq(engine.rootStakeRao(), 10e9);
        assertEq(address(engine).balance, 0);
        assertFalse(engine.hasPending());
        (uint64 epochId, uint256 depositAssets,,) = engine.pending();
        assertEq(epochId, 0);
        assertEq(depositAssets, 0);
        assertEq(engine.lastSettledEpoch(), 1);
        assertEq(bridge.lastAmount(), 0);
        assertEq(bridge.lastMessage(), CascadeMessages.encodeResult(1, 0));
        assertEq(bridge.sendCount(), 1);
    }

    function test_settleEpoch_emptyRequestStillReports() public {
        _stakeTen();
        _deliver(2, 0, 0, 10e24);
        vm.expectEmit(address(engine));
        emit StakeEngine.EpochSettled(2, 10e18, 0);
        engine.settleEpoch();

        assertEq(bridge.lastAmount(), 0);
        assertEq(bridge.sendCount(), 2);
        assertEq(bridge.lastMessage(), CascadeMessages.encodeResult(2, 10e18));
    }

    function test_settleEpoch_reportsAssetsBeforeExcludingNewDeposits() public {
        _stakeTen();
        staking.donateStake(HOTKEY, coldkey, 1e9);
        _deliver(2, 5e18, 0, 10e24);
        vm.expectEmit(address(engine));
        emit StakeEngine.EpochSettled(2, 11e18, 0);
        engine.settleEpoch();

        assertEq(engine.rootStakeRao(), 16e9);
        assertEq(address(engine).balance, 0);
    }

    function test_settleEpoch_redeemUsesIdleThenUnstakes() public {
        _stakeTen();
        _deliver(2, 4e18, 5e24, 10e24);
        // 5e24 * (10e18 + 1) / (10e24 + 1e6) == 5e18; 4e18 is liquid, so 1e9 rao is unstaked.
        vm.expectEmit(address(engine));
        emit StakeEngine.Unstaked(1e9);
        vm.expectEmit(address(engine));
        emit StakeEngine.EpochSettled(2, 10e18, 5e18);
        engine.settleEpoch();

        assertEq(bridge.lastAmount(), 5e18);
        assertEq(bridge.lastValue(), 5e18);
        assertEq(engine.rootStakeRao(), 9e9);
        assertEq(address(engine).balance, 0);
        assertEq(bridge.lastMessage(), CascadeMessages.encodeResult(2, 10e18));
    }

    function test_settleEpoch_redeemWithoutIdleUnstakesAll() public {
        _stakeTen();
        _deliver(2, 0, 10e24, 10e24);
        // 10e24 + 1e6 == 1e6 * (10e18 + 1), so the payout is exactly 10e18.
        vm.expectEmit(address(engine));
        emit StakeEngine.Unstaked(10e9);
        vm.expectEmit(address(engine));
        emit StakeEngine.EpochSettled(2, 10e18, 10e18);
        engine.settleEpoch();

        assertEq(engine.rootStakeRao(), 0);
        assertEq(address(engine).balance, 0);
        assertEq(bridge.lastAmount(), 10e18);
    }

    function test_settleEpoch_unstakeBlockedRevertsAndKeepsPending() public {
        _stakeTen();
        _deliver(2, 4e18, 5e24, 10e24);
        staking.setUnstakeBlocked(true);
        vm.expectRevert(MockStaking.TooEarly.selector);
        engine.settleEpoch();

        assertTrue(engine.hasPending());
        assertEq(engine.lastSettledEpoch(), 1);
        assertEq(bridge.sendCount(), 1);

        // Retry once the precompile allows the unstake.
        staking.setUnstakeBlocked(false);
        engine.settleEpoch();
        assertFalse(engine.hasPending());
        assertEq(engine.lastSettledEpoch(), 2);
        assertEq(bridge.lastAmount(), 5e18);
    }

    function test_settleEpoch_insufficientFeeReverts() public {
        _deliver(1, 10e18, 0, 0);
        bridge.setFee(0.01 ether);
        vm.expectRevert(StakeEngine.InsufficientFee.selector);
        engine.settleEpoch{value: 0}();
    }

    function test_settleEpoch_refundsExcessFee() public {
        _stakeTen();
        _deliver(2, 4e18, 5e24, 10e24);
        bridge.setFee(0.01 ether);
        address keeper = makeAddr("keeper");
        vm.deal(keeper, 1 ether);

        vm.prank(keeper);
        engine.settleEpoch{value: 0.05 ether}();

        assertEq(keeper.balance, 0.99 ether);
        assertEq(bridge.lastValue(), 5e18 + 0.01 ether);
        assertEq(bridge.lastAmount(), 5e18);
        // The caller's fee payment is not counted in assetsBefore.
        assertEq(bridge.lastMessage(), CascadeMessages.encodeResult(2, 10e18));
        assertEq(address(engine).balance, 0);
    }

    function test_settleEpoch_whenPausedReverts() public {
        _deliver(1, 10e18, 0, 0);
        engine.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        engine.settleEpoch();
    }

    // ---- stakeIdle ----

    function test_stakeIdle_keepsPendingDepositsLiquid() public {
        _deliver(1, 10e18, 0, 0);
        engine.stakeIdle();
        assertEq(engine.rootStakeRao(), 0);
        assertEq(address(engine).balance, 10e18);
    }

    function test_stakeIdle_ignoresBelowMinimum() public {
        vm.deal(address(engine), 1_999_999 * 1e9);
        engine.stakeIdle();
        assertEq(engine.rootStakeRao(), 0);
        assertEq(address(engine).balance, 1_999_999 * 1e9);
    }

    function test_stakeIdle_stakesAtMinimum() public {
        vm.deal(address(engine), 2_000_000 * 1e9);
        vm.expectEmit(address(engine));
        emit StakeEngine.Staked(2_000_000);
        engine.stakeIdle();
        assertEq(engine.rootStakeRao(), 2_000_000);
        assertEq(address(engine).balance, 0);
    }

    // ---- rewards and accounting ----

    function test_claimRewards_movesUnclaimedIntoRootStake() public {
        _stakeTen();
        staking.accrueRootReward(coldkey, HOTKEY, 5e8);
        assertEq(engine.unclaimedRewards(), 5e17);

        vm.expectEmit(address(engine));
        emit StakeEngine.RewardsClaimed(5e8);
        engine.claimRewards();

        assertEq(engine.rootStakeRao(), 10e9 + 5e8);
        assertEq(engine.unclaimedRewards(), 0);
        assertEq(engine.totalAssets(), 10e18 + 5e17);
    }

    function test_totalAssets_sumsStakeAndBalance() public {
        _stakeTen();
        vm.deal(address(engine), 1e18);
        assertEq(engine.totalAssets(), 11e18);
    }

    // ---- admin ----

    function test_setHotkey_movesStakeAndEmits() public {
        _stakeTen();
        vm.expectEmit(address(engine));
        emit StakeEngine.HotkeySet(HOTKEY, HOTKEY2);
        engine.setHotkey(HOTKEY2);

        assertEq(engine.hotkey(), HOTKEY2);
        assertEq(staking.getStake(HOTKEY, coldkey, 0), 0);
        assertEq(staking.getStake(HOTKEY2, coldkey, 0), 10e9);
        assertEq(engine.rootStakeRao(), 10e9);
    }

    function test_setHotkey_onlyOwner() public {
        vm.prank(BAD);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, BAD));
        engine.setHotkey(HOTKEY2);
    }

    function test_setBridge_zeroReverts() public {
        vm.expectRevert(StakeEngine.ZeroAddress.selector);
        engine.setBridge(address(0));
    }

    function test_pause_guardianCanPauseButNotUnpause() public {
        vm.prank(BAD);
        vm.expectRevert(StakeEngine.NotGuardian.selector);
        engine.pause();

        vm.prank(GUARDIAN);
        engine.pause();
        assertTrue(engine.paused());

        vm.prank(GUARDIAN);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, GUARDIAN));
        engine.unpause();

        engine.unpause();
        assertFalse(engine.paused());
    }

    function test_receive_rejectsDirectTransfer() public {
        (bool ok, bytes memory data) = address(engine).call{value: 1}("");
        assertFalse(ok);
        assertEq(data, abi.encodeWithSelector(StakeEngine.DirectTransferNotAllowed.selector));
    }
}
