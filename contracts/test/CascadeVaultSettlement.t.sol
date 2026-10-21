// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeMessages} from "../src/libraries/CascadeMessages.sol";
import {CascadeVault} from "../src/CascadeVault.sol";
import {MockTAO} from "./mocks/MockTAO.sol";
import {StubBridge} from "./mocks/StubBridge.sol";

/// @dev Literals are hand-derived. After a first deposit at the offset price the vault holds
/// S + 1e6 == 1e6 * (A + 1), so price == 1e12 exactly and 1e24 shares redeem for exactly 1e18.
contract CascadeVaultSettlementTest is Test {
    address constant GUARDIAN = address(0x6A2D);
    address constant BAD = address(0xBAD);
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

    // ---- helpers ----

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

    function _closeWithDeposit(address who, uint256 assets) internal {
        _deposit(who, assets);
        vm.warp(block.timestamp + 1 days + 1);
        vault.closeEpoch{value: FEE}();
    }

    /// @dev Simulates the bridge delivering an epoch result: the payout lands first, then the call.
    function _settle(uint64 id, uint256 assetsBefore, uint256 amount) internal {
        if (amount > 0) tao.mint(address(vault), amount);
        _deliver(id, assetsBefore, amount);
    }

    /// @dev The call half of `_settle`, for tests that mint the payout before an `expectEmit`.
    function _deliver(uint64 id, uint256 assetsBefore, uint256 amount) internal {
        vm.prank(address(bridge));
        vault.onBridgeMessage(CascadeMessages.encodeResult(id, assetsBefore), amount);
    }

    /// @dev Epoch 1: alice deposits 100e18, settled at the offset price (100e24 shares held by the vault).
    function _firstEpoch() internal {
        _closeWithDeposit(alice, 100e18);
        _settle(1, 0, 0);
    }

    /// @dev Epoch 1 settled and claimed by alice; a day later bob deposits 100e18 and epoch 2 closes.
    /// Its result arrives 2 days + 1 s after the last price (1e12), so the price bounds are
    /// [1e12 - 1e9, 1e12 + 1095896752 + 1000 + 1].
    function _secondDepositEpoch() internal {
        _firstEpoch();
        _claimShares(alice, 1);
        vm.warp(block.timestamp + 1 days);
        _closeWithDeposit(bob, 100e18);
    }

    /// @dev Epoch 1 settled and claimed by alice; alice escrows `shares` and epoch 2 closes with no
    /// deposits. Supply at close is 100e24 against 100e18 of assets.
    function _redeemEpoch(uint256 shares) internal {
        _firstEpoch();
        _claimShares(alice, 1);
        _requestRedeem(alice, shares);
        vm.warp(block.timestamp + 1 days + 1);
        vault.closeEpoch{value: FEE}();
    }

    function _claimShares(address user, uint64 id) internal {
        vm.prank(user);
        vault.claimShares(id);
    }

    function _claimAssets(address user, uint64 id) internal {
        vm.prank(user);
        vault.claimAssets(id);
    }

    function _requestRedeem(address user, uint256 shares) internal {
        vm.prank(user);
        vault.requestRedeem(shares);
    }

    function _assertStatus(uint64 id, CascadeVault.EpochStatus expected) internal view {
        assertEq(uint8(vault.epochs(id).status), uint8(expected));
    }

    // ---- settlement ----

    function test_settle_firstEpochMintsAtOffsetPrice() public {
        _closeWithDeposit(alice, 100e18);

        vm.expectEmit(address(vault));
        emit CascadeVault.EpochSettled(1, 0, 100e24, 0);
        _settle(1, 0, 0);

        _assertStatus(1, CascadeVault.EpochStatus.Settled);
        assertEq(vault.epochs(1).sharesMinted, 100e24);
        assertEq(vault.balanceOf(address(vault)), 100e24);
        assertEq(vault.totalSupply(), 100e24);
        assertEq(vault.lastTotalAssets(), 100e18);
        assertEq(vault.lastPrice(), 1e12);
        assertEq(vault.lastPriceTime(), block.timestamp);
        assertEq(vault.inFlightEpoch(), 0);
    }

    function test_settle_rewardsRaisePriceWithinBounds() public {
        _secondDepositEpoch();

        // price(100.05e18, 100e24) = 1000499999999, inside the upper bound 1001095897753.
        _settle(2, 100.05e18, 0);

        _assertStatus(2, CascadeVault.EpochStatus.Settled);
        assertFalse(vault.paused());
        assertGt(vault.lastPrice(), 1e12);
        // 100e18 * (100e24 + 1e6) / (100.05e18 + 1), rounded down.
        assertEq(vault.epochs(2).sharesMinted, 99950024987506246876562218);
    }

    function test_settle_priceDropFlagsAndPauses() public {
        _secondDepositEpoch();
        uint256 priceTime = vault.lastPriceTime();

        // price(99e18, 100e24) = 0.99e12, below the lower bound 1e12 - 1e9.
        vm.expectEmit(address(vault));
        emit CascadeVault.EpochFlagged(2, 99e18, 0);
        _settle(2, 99e18, 0);

        _assertStatus(2, CascadeVault.EpochStatus.Flagged);
        assertTrue(vault.paused());
        assertEq(vault.inFlightEpoch(), 2);
        assertEq(vault.totalSupply(), 100e24);
        assertEq(vault.epochs(2).assetsBefore, 99e18);
        assertEq(vault.epochs(2).assetsPaid, 0);
        assertEq(vault.epochs(2).sharesMinted, 0);
        assertEq(vault.lastTotalAssets(), 100e18);
        assertEq(vault.lastPrice(), 1e12);
        assertEq(vault.lastPriceTime(), priceTime);
    }

    function test_settle_priceJumpFlags() public {
        _secondDepositEpoch();

        // price(110e18, 100e24) = 1.1e12 - 1, above the upper bound 1001095897753.
        _settle(2, 110e18, 0);

        _assertStatus(2, CascadeVault.EpochStatus.Flagged);
        assertTrue(vault.paused());
        assertEq(vault.inFlightEpoch(), 2);
        assertEq(vault.totalSupply(), 100e24);
    }

    function test_settle_tinyGrowthAllowedByToleranceTerm() public {
        _firstEpoch();
        _claimShares(alice, 1);
        // An epoch cannot close sooner than epochDuration after the last price, and one day at the
        // default 20% APR already admits ~5.5e8 of price growth. Zero APR isolates the tolerance term:
        // the upper bound is lastPrice + lastPrice / 1e9 + 1 = 1e12 + 1001.
        vault.setPriceBounds(0, 10);
        _closeWithDeposit(bob, 100e18);

        // price(100e18 + 1e9, 100e24) = 1e12 + 9.
        _settle(2, 100e18 + 1e9, 0);

        _assertStatus(2, CascadeVault.EpochStatus.Settled);
        assertFalse(vault.paused());
    }

    function test_settle_flagWhilePausedDoesNotRevert() public {
        _secondDepositEpoch();
        vault.pause();

        vm.expectEmit(address(vault));
        emit CascadeVault.EpochFlagged(2, 99e18, 0);
        _settle(2, 99e18, 0);

        _assertStatus(2, CascadeVault.EpochStatus.Flagged);
        assertTrue(vault.paused());
        assertEq(vault.inFlightEpoch(), 2);
    }

    // ---- redemption payouts ----

    function test_settle_redeemBurnsEscrowAndPaysOut() public {
        _redeemEpoch(40e24);

        // 40e24 * (100e18 + 1) / (100e24 + 1e6) == 40e18 exactly.
        tao.mint(address(vault), 40e18);
        vm.expectEmit(address(vault));
        emit CascadeVault.EpochSettled(2, 100e18, 0, 40e18);
        _deliver(2, 100e18, 40e18);

        assertEq(vault.totalSupply(), 60e24);
        assertEq(vault.balanceOf(address(vault)), 0);
        assertEq(vault.epochs(2).assetsPaid, 40e18);
        assertEq(vault.lastTotalAssets(), 60e18);
        assertEq(vault.lastPrice(), 1e12);
        assertEq(vault.claimableAssets(2, alice), 40e18);

        vm.expectEmit(address(vault));
        emit CascadeVault.AssetsClaimed(2, alice, 40e18);
        _claimAssets(alice, 2);

        assertEq(tao.balanceOf(alice), 940e18);
        assertEq(tao.balanceOf(address(vault)), 0);
        assertEq(vault.redeemOf(2, alice), 0);
        assertEq(vault.claimableAssets(2, alice), 0);

        vm.prank(alice);
        vm.expectRevert(CascadeVault.NothingToClaim.selector);
        vault.claimAssets(2);
    }

    function test_settle_payoutShortByMoreThanToleranceFlags() public {
        _redeemEpoch(40e24);

        _settle(2, 100e18, 40e18 - 1e9 - 1);

        _assertStatus(2, CascadeVault.EpochStatus.Flagged);
        assertTrue(vault.paused());
        assertEq(vault.epochs(2).assetsPaid, 40e18 - 1e9 - 1);
        // The escrow is not burned.
        assertEq(vault.totalSupply(), 100e24);
        assertEq(vault.balanceOf(address(vault)), 40e24);
    }

    function test_settle_payoutWithinToleranceSettles() public {
        _redeemEpoch(40e24);

        _settle(2, 100e18, 40e18 - 1e9);

        _assertStatus(2, CascadeVault.EpochStatus.Settled);
        assertFalse(vault.paused());
        assertEq(vault.epochs(2).assetsPaid, 40e18 - 1e9);
    }

    function test_settle_overpaymentFlags() public {
        _redeemEpoch(40e24);

        _settle(2, 100e18, 40e18 + 1);

        _assertStatus(2, CascadeVault.EpochStatus.Flagged);
        assertTrue(vault.paused());
        assertEq(vault.totalSupply(), 100e24);
    }

    function test_settle_fullRedeemThenNewDepositDoesNotFlag() public {
        _redeemEpoch(100e24);

        // 100e24 * (100e18 + 1) / (100e24 + 1e6) == 100e18 exactly.
        _settle(2, 100e18, 100e18);

        _assertStatus(2, CascadeVault.EpochStatus.Settled);
        assertEq(vault.totalSupply(), 0);
        assertEq(vault.lastTotalAssets(), 0);
        _claimAssets(alice, 2);
        assertEq(tao.balanceOf(alice), 1_000e18);

        // Epoch 3: the engine reports 1000 wei of leftover dust against a zero supply.
        _closeWithDeposit(bob, 100e18);
        _settle(3, 1000, 0);

        _assertStatus(3, CascadeVault.EpochStatus.Settled);
        assertFalse(vault.paused());
        _claimShares(bob, 3);
        // 100e18 * (0 + 1e6) / (1000 + 1), rounded down.
        assertEq(vault.balanceOf(bob), 99900099900099900099900);
    }

    // ---- onBridgeMessage ----

    function test_onBridgeMessage_wrongEpochReverts() public {
        _closeWithDeposit(alice, 100e18);

        vm.expectRevert(CascadeVault.UnexpectedEpoch.selector);
        _settle(2, 0, 0);

        vm.expectRevert(CascadeVault.UnexpectedEpoch.selector);
        _settle(0, 0, 0);

        _assertStatus(1, CascadeVault.EpochStatus.InFlight);
        assertEq(vault.inFlightEpoch(), 1);
    }

    function test_onBridgeMessage_duplicateResultReverts() public {
        _firstEpoch();

        vm.expectRevert(CascadeVault.UnexpectedEpoch.selector);
        _settle(1, 0, 0);

        assertEq(vault.totalSupply(), 100e24);
    }

    function test_onBridgeMessage_worksWhilePaused() public {
        _closeWithDeposit(alice, 100e18);
        vault.pause();

        _settle(1, 0, 0);

        _assertStatus(1, CascadeVault.EpochStatus.Settled);
        assertEq(vault.inFlightEpoch(), 0);
        assertTrue(vault.paused());
    }

    function test_onBridgeMessage_flaggedEpochRejectsSecondResult() public {
        _secondDepositEpoch();
        _settle(2, 99e18, 0);

        vm.expectRevert(CascadeVault.UnexpectedEpoch.selector);
        _settle(2, 100e18, 0);

        _assertStatus(2, CascadeVault.EpochStatus.Flagged);
        assertEq(vault.epochs(2).assetsBefore, 99e18);
    }

    // ---- acceptFlaggedEpoch ----

    function test_acceptFlaggedEpoch_appliesStoredValues() public {
        _secondDepositEpoch();
        _settle(2, 99e18, 0);

        // 100e18 * (100e24 + 1e6) / (99e18 + 1), rounded down.
        uint256 minted = 101010101010101010100999897;
        vm.expectEmit(address(vault));
        emit CascadeVault.EpochSettled(2, 99e18, minted, 0);
        vault.acceptFlaggedEpoch();

        _assertStatus(2, CascadeVault.EpochStatus.Settled);
        assertTrue(vault.paused());
        assertEq(vault.inFlightEpoch(), 0);
        assertEq(vault.epochs(2).sharesMinted, minted);
        assertEq(vault.totalSupply(), 100e24 + minted);
        assertEq(vault.lastTotalAssets(), 199e18);
        assertEq(vault.lastPriceTime(), block.timestamp);
    }

    function test_acceptFlaggedEpoch_onlyOwnerAndOnlyFlagged() public {
        // Nothing in flight.
        vm.expectRevert(CascadeVault.NotFlagged.selector);
        vault.acceptFlaggedEpoch();

        // In flight but not flagged.
        _secondDepositEpoch();
        vm.expectRevert(CascadeVault.NotFlagged.selector);
        vault.acceptFlaggedEpoch();

        _settle(2, 99e18, 0);
        vm.prank(BAD);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, BAD));
        vault.acceptFlaggedEpoch();

        // Accepted once; a second accept finds nothing flagged.
        vault.acceptFlaggedEpoch();
        vm.expectRevert(CascadeVault.NotFlagged.selector);
        vault.acceptFlaggedEpoch();
    }

    // ---- requestRedeem / cancelRedeem ----

    function test_requestRedeem_escrowsShares() public {
        _firstEpoch();
        _claimShares(alice, 1);

        vm.expectEmit(address(vault));
        emit CascadeVault.RedeemRequested(2, alice, 40e24);
        _requestRedeem(alice, 40e24);

        assertEq(vault.balanceOf(alice), 60e24);
        assertEq(vault.balanceOf(address(vault)), 40e24);
        assertEq(vault.redeemOf(2, alice), 40e24);
        assertEq(vault.epochs(2).totalRedeemShares, 40e24);
        assertEq(vault.totalSupply(), 100e24);
    }

    function test_requestRedeem_zeroReverts() public {
        _firstEpoch();
        _claimShares(alice, 1);

        vm.prank(alice);
        vm.expectRevert(CascadeVault.ZeroAmount.selector);
        vault.requestRedeem(0);
    }

    function test_requestRedeem_whenPausedReverts() public {
        _firstEpoch();
        _claimShares(alice, 1);
        vault.pause();

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.requestRedeem(40e24);
    }

    function test_cancelRedeem_returnsShares() public {
        _firstEpoch();
        _claimShares(alice, 1);
        _requestRedeem(alice, 40e24);

        vm.expectEmit(address(vault));
        emit CascadeVault.RedeemCancelled(2, alice, 15e24);
        vm.prank(alice);
        vault.cancelRedeem(15e24);

        assertEq(vault.balanceOf(alice), 75e24);
        assertEq(vault.balanceOf(address(vault)), 25e24);
        assertEq(vault.redeemOf(2, alice), 25e24);
        assertEq(vault.epochs(2).totalRedeemShares, 25e24);

        vm.prank(alice);
        vm.expectRevert(CascadeVault.InsufficientRequest.selector);
        vault.cancelRedeem(25e24 + 1);

        vault.pause();
        vm.prank(alice);
        vault.cancelRedeem(25e24);

        assertEq(vault.balanceOf(alice), 100e24);
        assertEq(vault.redeemOf(2, alice), 0);
        assertEq(vault.epochs(2).totalRedeemShares, 0);
    }

    function test_closeEpoch_sendsRedeemSharesAndSupply() public {
        _firstEpoch();
        _claimShares(alice, 1);
        _requestRedeem(alice, 40e24);
        vm.warp(block.timestamp + 1 days + 1);

        vm.expectEmit(address(vault));
        emit CascadeVault.EpochClosed(2, 0, 40e24, 100e24);
        vault.closeEpoch{value: FEE}();

        assertEq(bridge.lastMessage(), CascadeMessages.encodeRequest(2, 40e24, 100e24));
        assertEq(bridge.lastAmount(), 0);
        assertEq(vault.inFlightEpoch(), 2);

        // Escrowed shares are committed once their epoch is in flight.
        vm.prank(alice);
        vm.expectRevert(CascadeVault.InsufficientRequest.selector);
        vault.cancelRedeem(1);
    }

    // ---- claims ----

    function test_claimShares_paysEntitlement() public {
        _firstEpoch();
        assertEq(vault.claimableShares(1, alice), 100e24);

        vm.expectEmit(address(vault));
        emit CascadeVault.SharesClaimed(1, alice, 100e24);
        _claimShares(alice, 1);

        assertEq(vault.balanceOf(alice), 100e24);
        assertEq(vault.balanceOf(address(vault)), 0);
        assertEq(vault.depositOf(1, alice), 0);
        assertEq(vault.claimableShares(1, alice), 0);

        vm.prank(alice);
        vm.expectRevert(CascadeVault.NothingToClaim.selector);
        vault.claimShares(1);
    }

    function test_claimShares_beforeSettledReverts() public {
        _closeWithDeposit(alice, 100e18);

        vm.prank(alice);
        vm.expectRevert(CascadeVault.NotSettled.selector);
        vault.claimShares(1);

        assertEq(vault.claimableShares(1, alice), 0);
    }

    function test_claimShares_twoDepositorsProRata() public {
        _deposit(alice, 100e18);
        _closeWithDeposit(bob, 300e18);
        _settle(1, 0, 0);
        assertEq(vault.epochs(1).sharesMinted, 400e24);

        _claimShares(alice, 1);
        _claimShares(bob, 1);

        assertEq(vault.balanceOf(alice), 100e24);
        assertEq(vault.balanceOf(bob), 300e24);
        assertEq(vault.balanceOf(address(vault)), 0);
    }

    function test_claimShares_worksWhilePaused() public {
        _firstEpoch();
        vault.pause();

        _claimShares(alice, 1);

        assertEq(vault.balanceOf(alice), 100e24);
    }

    function test_claimShares_oldEpochStillClaimable() public {
        _firstEpoch();
        _closeWithDeposit(bob, 100e18);
        _settle(2, 100e18, 0);
        _assertStatus(2, CascadeVault.EpochStatus.Settled);
        // 100e18 * (100e24 + 1e6) / (100e18 + 1) == 100e24 exactly.
        assertEq(vault.epochs(2).sharesMinted, 100e24);

        _claimShares(alice, 1);

        assertEq(vault.balanceOf(alice), 100e24);
        assertEq(vault.balanceOf(address(vault)), 100e24);
    }

    function test_claimAssets_twoRedeemersProRata() public {
        _deposit(alice, 100e18);
        _closeWithDeposit(bob, 100e18);
        _settle(1, 0, 0);
        _claimShares(alice, 1);
        _claimShares(bob, 1);

        _requestRedeem(alice, 50e24);
        _requestRedeem(bob, 100e24);
        vm.warp(block.timestamp + 1 days + 1);
        vault.closeEpoch{value: FEE}();
        // 150e24 * (200e18 + 1) / (200e24 + 1e6) == 150e18 exactly.
        _settle(2, 200e18, 150e18);

        _claimAssets(alice, 2);
        _claimAssets(bob, 2);

        assertEq(tao.balanceOf(alice), 950e18);
        assertEq(tao.balanceOf(bob), 1_000e18);
        assertEq(tao.balanceOf(address(vault)), 0);
    }

    function test_claimAssets_zeroEntitlementReverts() public {
        _redeemEpoch(40e24);
        _settle(2, 100e18, 40e18);

        assertEq(vault.claimableAssets(2, bob), 0);
        vm.prank(bob);
        vm.expectRevert(CascadeVault.NothingToClaim.selector);
        vault.claimAssets(2);

        // A redeem-only epoch has no deposits: nothing to claim in shares either.
        assertEq(vault.claimableShares(2, alice), 0);
        vm.prank(alice);
        vm.expectRevert(CascadeVault.NothingToClaim.selector);
        vault.claimShares(2);
    }

    function test_claimAssets_flaggedEpochNotClaimableUntilAccepted() public {
        _redeemEpoch(40e24);
        _settle(2, 100e18, 40e18 + 1);

        assertEq(vault.claimableAssets(2, alice), 0);
        vm.prank(alice);
        vm.expectRevert(CascadeVault.NotSettled.selector);
        vault.claimAssets(2);

        vault.acceptFlaggedEpoch();

        // Still paused: claims work regardless and pay the accepted amount.
        assertTrue(vault.paused());
        _claimAssets(alice, 2);
        assertEq(tao.balanceOf(alice), 940e18 + 1);
        assertEq(vault.lastTotalAssets(), 60e18 - 1);
    }
}
