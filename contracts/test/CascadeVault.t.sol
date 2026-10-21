// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ICascadeBridge} from "../src/interfaces/ICascadeBridge.sol";
import {CascadeMessages} from "../src/libraries/CascadeMessages.sol";
import {CascadeVault} from "../src/CascadeVault.sol";
import {MockTAO} from "./mocks/MockTAO.sol";
import {StubBridge} from "./mocks/StubBridge.sol";

contract CascadeVaultTest is Test {
    address constant GUARDIAN = address(0x6A2D);
    address constant BAD = address(0xBAD);
    address constant KEEPER = address(0xCAFE);
    uint256 constant FEE = 0.001 ether;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    MockTAO tao;
    StubBridge bridge;
    CascadeVault vault;

    function setUp() public {
        tao = new MockTAO(18);
        bridge = new StubBridge(IERC20(address(tao)));
        bridge.setFee(FEE);
        vault = new CascadeVault(IERC20Metadata(address(tao)), bridge, address(this), GUARDIAN, 1 days, 1000e18, 1e18);

        _fund(alice);
        _fund(bob);
        vm.deal(address(this), 10 ether);
    }

    /// @dev The test contract closes epochs itself and must accept fee refunds.
    receive() external payable {}

    function _fund(address user) internal {
        tao.mint(user, 1_000e18);
        vm.prank(user);
        tao.approve(address(vault), type(uint256).max);
        vm.deal(user, 1 ether);
    }

    function _deposit(address user, uint256 assets) internal {
        vm.prank(user);
        vault.requestDeposit(assets, user);
    }

    function _status(uint64 id) internal view returns (uint8) {
        return uint8(vault.epochs(id).status);
    }

    // ---- constructor and metadata ----

    function test_constructorRejectsNon18Decimals() public {
        MockTAO six = new MockTAO(6);
        vm.expectRevert(CascadeVault.UnsupportedDecimals.selector);
        new CascadeVault(IERC20Metadata(address(six)), bridge, address(this), GUARDIAN, 1 days, 1000e18, 1e18);
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(CascadeVault.ZeroAddress.selector);
        new CascadeVault(
            IERC20Metadata(address(tao)), ICascadeBridge(address(0)), address(this), GUARDIAN, 1 days, 1000e18, 1e18
        );

        vm.expectRevert(CascadeVault.ZeroAddress.selector);
        new CascadeVault(IERC20Metadata(address(tao)), bridge, address(this), address(0), 1 days, 1000e18, 1e18);
    }

    function test_tokenMetadata() public view {
        assertEq(vault.name(), "Cascade Staked TAO");
        assertEq(vault.symbol(), "csTAO");
        assertEq(vault.decimals(), 24);
        assertEq(address(vault.asset()), address(tao));
        assertEq(vault.currentEpochId(), 1);
        assertEq(vault.inFlightEpoch(), 0);
        assertEq(vault.epochs(1).start, block.timestamp);
        assertEq(_status(1), uint8(CascadeVault.EpochStatus.Open));
        assertEq(vault.maxAprBps(), 2000);
        assertEq(vault.maxDropBps(), 10);
    }

    // ---- requestDeposit ----

    function test_requestDeposit_pullsAssetsAndCredits() public {
        vm.expectEmit(address(vault));
        emit CascadeVault.DepositRequested(1, alice, 100e18);
        _deposit(alice, 100e18);

        assertEq(tao.balanceOf(address(vault)), 100e18);
        assertEq(tao.balanceOf(alice), 900e18);
        assertEq(vault.depositOf(1, alice), 100e18);
        assertEq(vault.epochs(1).totalDeposits, 100e18);
        assertEq(vault.totalAssetsEstimate(), 100e18);
    }

    function test_requestDeposit_creditsReceiverNotSender() public {
        vm.prank(alice);
        vault.requestDeposit(100e18, bob);

        assertEq(vault.depositOf(1, bob), 100e18);
        assertEq(vault.depositOf(1, alice), 0);
        assertEq(tao.balanceOf(alice), 900e18);
        assertEq(tao.balanceOf(bob), 1_000e18);
    }

    function test_requestDeposit_belowMinReverts() public {
        vm.prank(alice);
        vm.expectRevert(CascadeVault.BelowMinDeposit.selector);
        vault.requestDeposit(1e18 - 1, alice);
    }

    function test_requestDeposit_capExceededReverts() public {
        _deposit(alice, 500e18);
        _deposit(bob, 500e18);
        assertEq(vault.totalAssetsEstimate(), 1000e18);

        vm.prank(alice);
        vm.expectRevert(CascadeVault.CapExceeded.selector);
        vault.requestDeposit(1e18, alice);
    }

    function test_requestDeposit_zeroReceiverReverts() public {
        vm.prank(alice);
        vm.expectRevert(CascadeVault.ZeroAddress.selector);
        vault.requestDeposit(100e18, address(0));
    }

    function test_requestDeposit_whenPausedReverts() public {
        vault.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.requestDeposit(100e18, alice);
    }

    // ---- cancelDeposit ----

    function test_cancelDeposit_returnsAssets() public {
        _deposit(alice, 100e18);

        vm.expectEmit(address(vault));
        emit CascadeVault.DepositCancelled(1, alice, 40e18);
        vm.prank(alice);
        vault.cancelDeposit(40e18);

        assertEq(tao.balanceOf(alice), 940e18);
        assertEq(tao.balanceOf(address(vault)), 60e18);
        assertEq(vault.depositOf(1, alice), 60e18);
        assertEq(vault.epochs(1).totalDeposits, 60e18);
    }

    function test_cancelDeposit_tooMuchReverts() public {
        _deposit(alice, 100e18);
        vm.prank(alice);
        vm.expectRevert(CascadeVault.InsufficientRequest.selector);
        vault.cancelDeposit(100e18 + 1);
    }

    function test_cancelDeposit_worksWhilePaused() public {
        _deposit(alice, 100e18);
        vault.pause();

        vm.prank(alice);
        vault.cancelDeposit(100e18);

        assertEq(tao.balanceOf(alice), 1_000e18);
        assertEq(vault.depositOf(1, alice), 0);
        assertEq(vault.epochs(1).totalDeposits, 0);
    }

    function test_cancelDeposit_afterCloseReverts() public {
        _deposit(alice, 100e18);
        vm.warp(block.timestamp + 1 days);
        vault.closeEpoch{value: FEE}();

        vm.prank(alice);
        vm.expectRevert(CascadeVault.InsufficientRequest.selector);
        vault.cancelDeposit(1);
    }

    // ---- closeEpoch ----

    function test_closeEpoch_beforeDurationReverts() public {
        _deposit(alice, 100e18);
        vm.warp(block.timestamp + 1 days - 1);
        vm.expectRevert(CascadeVault.EpochNotOver.selector);
        vault.closeEpoch{value: FEE}();
    }

    function test_closeEpoch_emptyEpochRolls() public {
        vm.warp(block.timestamp + 1 days + 1);
        uint256 balanceBefore = address(this).balance;

        vm.expectEmit(address(vault));
        emit CascadeVault.EpochRolled(1);
        vault.closeEpoch{value: FEE}();

        assertEq(vault.currentEpochId(), 1);
        assertEq(vault.epochs(1).start, block.timestamp);
        assertEq(_status(1), uint8(CascadeVault.EpochStatus.Open));
        assertEq(vault.inFlightEpoch(), 0);
        assertEq(address(this).balance, balanceBefore);
        assertEq(address(vault).balance, 0);
        assertEq(bridge.sendCount(), 0);
    }

    function test_closeEpoch_sendsDepositsAndOpensNext() public {
        _deposit(alice, 100e18);
        vm.warp(block.timestamp + 1 days + 1);

        vm.expectEmit(address(vault));
        emit CascadeVault.EpochClosed(1, 100e18, 0, 0);
        vault.closeEpoch{value: FEE}();

        assertEq(bridge.lastAmount(), 100e18);
        assertEq(bridge.lastMessage(), CascadeMessages.encodeRequest(1, 0, 0));
        assertEq(bridge.lastValue(), FEE);
        assertEq(bridge.sendCount(), 1);
        assertEq(tao.balanceOf(address(vault)), 0);
        assertEq(tao.balanceOf(address(bridge)), 100e18);
        assertEq(tao.allowance(address(vault), address(bridge)), 0);
        assertEq(vault.currentEpochId(), 2);
        assertEq(vault.inFlightEpoch(), 1);
        assertEq(_status(1), uint8(CascadeVault.EpochStatus.InFlight));
        assertEq(vault.epochs(1).supplyAtClose, 0);
        assertEq(vault.epochs(2).start, block.timestamp);
        assertEq(_status(2), uint8(CascadeVault.EpochStatus.Open));
        assertEq(vault.epochs(2).totalDeposits, 0);
        assertEq(vault.totalAssetsEstimate(), 100e18);
    }

    function test_closeEpoch_whileInFlightReverts() public {
        _deposit(alice, 100e18);
        vm.warp(block.timestamp + 1 days + 1);
        vault.closeEpoch{value: FEE}();

        vm.warp(block.timestamp + 1 days + 1);
        vm.expectRevert(CascadeVault.EpochInFlight.selector);
        vault.closeEpoch{value: FEE}();
    }

    function test_closeEpoch_insufficientFeeReverts() public {
        _deposit(alice, 100e18);
        vm.warp(block.timestamp + 1 days + 1);
        bridge.setFee(FEE);

        vm.expectRevert(CascadeVault.InsufficientFee.selector);
        vault.closeEpoch{value: FEE - 1}();
    }

    function test_closeEpoch_refundsExcess() public {
        _deposit(alice, 100e18);
        vm.warp(block.timestamp + 1 days + 1);
        uint256 balanceBefore = address(this).balance;

        vault.closeEpoch{value: FEE + 1 ether}();

        assertEq(balanceBefore - address(this).balance, FEE);
        assertEq(bridge.lastValue(), FEE);
        assertEq(address(vault).balance, 0);
    }

    function test_closeEpoch_whenPausedReverts() public {
        _deposit(alice, 100e18);
        vm.warp(block.timestamp + 1 days + 1);
        vault.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.closeEpoch{value: FEE}();
    }

    function test_closeEpoch_permissionless() public {
        _deposit(alice, 100e18);
        vm.warp(block.timestamp + 1 days + 1);
        vm.deal(KEEPER, 1 ether);

        vm.prank(KEEPER);
        vault.closeEpoch{value: FEE}();

        assertEq(vault.currentEpochId(), 2);
        assertEq(vault.inFlightEpoch(), 1);
        assertEq(bridge.sendCount(), 1);
        assertEq(KEEPER.balance, 1 ether - FEE);
    }

    // ---- onBridgeMessage (access checks only until settlement lands) ----

    function test_onBridgeMessage_onlyBridge() public {
        vm.prank(BAD);
        vm.expectRevert(CascadeVault.NotBridge.selector);
        vault.onBridgeMessage(CascadeMessages.encodeResult(1, 0), 0);
    }

    function test_onBridgeMessage_withValueReverts() public {
        vm.deal(address(bridge), 1);
        vm.prank(address(bridge));
        vm.expectRevert(CascadeVault.ValueMismatch.selector);
        vault.onBridgeMessage{value: 1}(CascadeMessages.encodeResult(1, 0), 0);
    }

    // ---- admin ----

    function test_setPriceBounds_validatesAndEmits() public {
        vm.expectRevert(CascadeVault.InvalidBounds.selector);
        vault.setPriceBounds(10001, 10);

        vm.expectRevert(CascadeVault.InvalidBounds.selector);
        vault.setPriceBounds(2000, 101);

        vm.expectEmit(address(vault));
        emit CascadeVault.PriceBoundsSet(1500, 20);
        vault.setPriceBounds(1500, 20);
        assertEq(vault.maxAprBps(), 1500);
        assertEq(vault.maxDropBps(), 20);

        // The limits themselves are allowed.
        vault.setPriceBounds(10000, 100);
        assertEq(vault.maxAprBps(), 10000);
        assertEq(vault.maxDropBps(), 100);
    }

    function test_setCaps_emitsAndApplies() public {
        vm.expectEmit(address(vault));
        emit CascadeVault.CapsSet(10e18, 2e18);
        vault.setCaps(10e18, 2e18);
        assertEq(vault.tvlCap(), 10e18);
        assertEq(vault.minDeposit(), 2e18);

        vm.prank(alice);
        vm.expectRevert(CascadeVault.BelowMinDeposit.selector);
        vault.requestDeposit(1.5e18, alice);

        vm.prank(alice);
        vm.expectRevert(CascadeVault.CapExceeded.selector);
        vault.requestDeposit(11e18, alice);
    }

    function test_setEpochDuration_applies() public {
        vm.expectEmit(address(vault));
        emit CascadeVault.EpochDurationSet(2 days);
        vault.setEpochDuration(2 days);
        assertEq(vault.epochDuration(), 2 days);

        vm.warp(block.timestamp + 1 days + 1);
        vm.expectRevert(CascadeVault.EpochNotOver.selector);
        vault.closeEpoch{value: FEE}();
    }

    function test_setBridge_zeroReverts() public {
        vm.expectRevert(CascadeVault.ZeroAddress.selector);
        vault.setBridge(address(0));

        vm.prank(BAD);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, BAD));
        vault.setBridge(address(0xB41D6E));
    }

    function test_pause_guardianCanPauseButNotUnpause() public {
        vm.prank(BAD);
        vm.expectRevert(CascadeVault.NotGuardian.selector);
        vault.pause();

        vm.prank(GUARDIAN);
        vault.pause();
        assertTrue(vault.paused());

        vm.prank(GUARDIAN);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, GUARDIAN));
        vault.unpause();

        vault.unpause();
        assertFalse(vault.paused());
    }

    function test_renounceOwnershipDisabled() public {
        vm.expectRevert(CascadeVault.RenounceDisabled.selector);
        vault.renounceOwnership();
        assertEq(vault.owner(), address(this));
    }
}
