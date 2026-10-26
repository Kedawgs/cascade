// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {ICascadeTwap} from "../../src/interfaces/ICascadeTwap.sol";
import {MockSwapper} from "../mocks/MockSwapper.sol";
import {MockTwap} from "../mocks/MockTwap.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {FrontDoorTestBase} from "../FrontDoorTestBase.sol";

/// @notice USDC delivery: alice has 10 TAO credited by a payout and a preference of 240 USDC/TAO for
/// 7 days; the TWAP values TAO at 250 USDC; the swapper sells honestly at 248 USDC/TAO.
contract FrontDoorDeliveryTest is FrontDoorTestBase {
    bytes32 constant KEY = keccak256("batch-1");
    bytes32 constant KEY2 = keccak256("batch-2");
    uint32 constant BASE_DOMAIN = 6;
    uint32 constant ETHEREUM_DOMAIN = 0;

    uint128 constant USER_FLOOR = 240e6;
    uint256 constant TWAP_PRICE = 250e6;
    uint256 constant SWAP_RATE = 248e6;
    /// max(10 × 240 = 2_400e6, 10 × 250 × (1 − 1.5%) = 2_462.5e6)
    uint256 constant MIN_OUT = 2_462_500_000;

    address keeper = makeAddr("keeper");
    MockTwap twap;
    MockSwapper swapper;
    uint64 deadline;

    function setUp() public override {
        super.setUp();
        twap = new MockTwap(TWAP_PRICE);
        swapper = new MockSwapper(tao, usdc);
        swapper.setMode(MockSwapper.Mode.Honest, SWAP_RATE);
        vm.startPrank(owner);
        fd.setKeeper(keeper);
        fd.setSwapper(address(swapper));
        fd.setOracle(twap);
        vm.stopPrank();

        payout(KEY, alice, 10e18);
        deadline = uint64(block.timestamp + 7 days);
        prefer(alice, USER_FLOOR, deadline);
    }

    // ---- helpers ----

    /// A one-entry PAYOUTS chunk from (BITTENSOR, vault) through the stub bridge, tokens first.
    function payout(bytes32 key, address user, uint256 amount) internal {
        CascadeMessages.Entry[] memory e = new CascadeMessages.Entry[](1);
        e[0] = CascadeMessages.Entry(user, amount);
        tao.mint(address(fd), amount);
        vm.prank(address(bridge));
        fd.onBridgeMessage(BITTENSOR, vault, CascadeMessages.encodePayouts(key, 0, e), amount);
    }

    function prefer(address user, uint128 minUsdcPerTao, uint64 deadline_) internal {
        vm.prank(user);
        fd.setDelivery(minUsdcPerTao, deadline_, BASE_DOMAIN);
    }

    function deliverAs(address caller, address user, uint256 keeperMinOut) internal returns (uint256) {
        vm.prank(caller);
        return fd.deliver(user, keeperMinOut);
    }

    function assertPreference(address user, uint128 minUsdcPerTao, uint64 deadline_, uint32 destination) internal view {
        (uint128 m, uint64 d, uint32 dest) = fd.deliveryOf(user);
        assertEq(m, minUsdcPerTao, "minUsdcPerTao");
        assertEq(d, deadline_, "deadline");
        assertEq(dest, destination, "destination");
    }

    /// Nothing moved: alice's 10 TAO still credited and held, no USDC paid, the preference intact.
    function assertRestored() internal view {
        assertEq(fd.claimable(alice), 10e18);
        assertEq(fd.totalClaimable(), 10e18);
        assertEq(tao.balanceOf(address(fd)), 10e18);
        assertEq(tao.balanceOf(address(swapper)), 0);
        assertEq(usdc.balanceOf(alice), 0);
        assertPreference(alice, USER_FLOOR, deadline, BASE_DOMAIN);
    }

    // ---- delivery ----

    function test_deliverPaysAtLeastTheLargestFloor() public {
        uint256 totalBefore = fd.totalClaimable();
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.Delivered(alice, 10e18, 2_480e6);
        uint256 received = deliverAs(keeper, alice, 0);

        assertEq(received, 2_480e6);
        assertGe(received, MIN_OUT);
        assertEq(usdc.balanceOf(alice), 2_480e6);
        // the swapper was asked for the largest floor, to alice, with the TAO already in hand
        assertEq(swapper.lastMinOut(), MIN_OUT);
        assertEq(swapper.lastTaoIn(), 10e18);
        assertEq(swapper.lastRecipient(), alice);
        assertEq(swapper.taoHeldAtCall(), 10e18);
        assertEq(fd.claimable(alice), 0);
        assertEq(fd.totalClaimable(), totalBefore - 10e18);
        assertEq(tao.balanceOf(address(fd)), 0);
        assertEq(tao.balanceOf(address(swapper)), 10e18);
        assertPreference(alice, USER_FLOOR, deadline, BASE_DOMAIN);
    }

    function test_userFloorRoundsUpAndEachFloorCanBind() public {
        // the market floor binds: 245/TAO clears the user's 2_400e6 but not 2_462.5e6
        swapper.setMode(MockSwapper.Mode.Honest, 245e6);
        vm.prank(keeper);
        vm.expectRevert(CascadeFrontDoor.BelowMinimum.selector);
        fd.deliver(alice, 0);
        swapper.setMode(MockSwapper.Mode.Honest, SWAP_RATE);

        // the user's floor binds: 10 × 260 = 2_600e6 > the market's 2_462.5e6
        prefer(alice, 260e6, deadline);
        vm.prank(keeper);
        vm.expectRevert(CascadeFrontDoor.BelowMinimum.selector);
        fd.deliver(alice, 0);
        swapper.setMode(MockSwapper.Mode.Honest, 260e6);
        assertEq(deliverAs(keeper, alice, 0), 2_600e6);
        assertEq(swapper.lastMinOut(), 2_600e6);

        // the keeper's floor binds
        payout(KEY2, alice, 10e18);
        vm.prank(keeper);
        vm.expectRevert(CascadeFrontDoor.BelowMinimum.selector);
        fd.deliver(alice, 2_700e6);
        swapper.setMode(MockSwapper.Mode.Honest, 270e6);
        assertEq(deliverAs(keeper, alice, 2_700e6), 2_700e6);
        assertEq(swapper.lastMinOut(), 2_700e6);

        // the user's floor is rounded up, never shaved: (1e18 + 1) × 240e6 / 1e18 → 240_000_001
        twap.setPrice(1);
        payout(keccak256("batch-3"), bob, 1e18 + 1);
        prefer(bob, USER_FLOOR, deadline);
        swapper.setMode(MockSwapper.Mode.Honest, 240e6); // pays 240_000_000, one unit short
        vm.prank(keeper);
        vm.expectRevert(CascadeFrontDoor.BelowMinimum.selector);
        fd.deliver(bob, 0);
        swapper.setMode(MockSwapper.Mode.Honest, 241e6);
        deliverAs(keeper, bob, 0);
        assertEq(swapper.lastMinOut(), 240_000_001);
    }

    function test_keepsTaoSwapperReverts() public {
        swapper.setMode(MockSwapper.Mode.KeepsTao, 0);
        vm.prank(keeper);
        vm.expectRevert(CascadeFrontDoor.BelowMinimum.selector);
        fd.deliver(alice, 0);
        assertRestored();
    }

    function test_paysLessSwapperReverts() public {
        swapper.setMode(MockSwapper.Mode.PaysLess, 1); // 0.01% short of the minimum
        vm.prank(keeper);
        vm.expectRevert(CascadeFrontDoor.BelowMinimum.selector);
        fd.deliver(alice, 0);
        assertRestored();
    }

    function test_revertingSwapperReverts() public {
        swapper.setMode(MockSwapper.Mode.Reverts, 0);
        vm.prank(keeper);
        vm.expectRevert(MockSwapper.SwapFailed.selector);
        fd.deliver(alice, 0);
        assertRestored();
    }

    /// Review Focus 1: an address USDC refuses still gets out by claiming the TAO.
    function test_usdcRefusingRecipientCanStillClaim() public {
        usdc.setBlocked(alice);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.RecipientBlocked.selector, alice));
        fd.deliver(alice, 0);
        assertRestored();

        vm.prank(alice);
        fd.claim();
        assertEq(tao.balanceOf(alice), 1_010e18);
        assertEq(fd.claimable(alice), 0);
        assertEq(fd.totalClaimable(), 0);
        assertEq(tao.balanceOf(address(fd)), 0);
    }

    function test_preferenceServesTwoPayouts() public {
        assertEq(deliverAs(keeper, alice, 0), 2_480e6);

        payout(KEY2, alice, 4e18);
        // max(4 × 240 = 960e6, 4 × 250 × 0.985 = 985e6)
        assertEq(deliverAs(keeper, alice, 0), 992e6);
        assertEq(swapper.lastMinOut(), 985e6);
        assertEq(swapper.calls(), 2);
        assertEq(usdc.balanceOf(alice), 2_480e6 + 992e6);
        assertEq(fd.claimable(alice), 0);
        assertEq(fd.totalClaimable(), 0);
        assertPreference(alice, USER_FLOOR, deadline, BASE_DOMAIN);
    }

    function test_expiredUnsetOrForeignDestination() public {
        // one second past the deadline: expired
        vm.warp(deadline + 1);
        vm.prank(keeper);
        vm.expectRevert(CascadeFrontDoor.DeliveryExpired.selector);
        fd.deliver(alice, 0);
        // at the deadline itself it still delivers
        vm.warp(deadline);
        assertEq(deliverAs(keeper, alice, 0), 2_480e6);

        // a payout to a user with no preference
        payout(KEY2, bob, 5e18);
        vm.prank(keeper);
        vm.expectRevert(CascadeFrontDoor.NoDelivery.selector);
        fd.deliver(bob, 0);

        // a preference but nothing credited
        uint64 later = uint64(block.timestamp + 1 days);
        prefer(carol, USER_FLOOR, later);
        vm.prank(keeper);
        vm.expectRevert(CascadeFrontDoor.NothingToClaim.selector);
        fd.deliver(carol, 0);

        // only Base (CCTP domain 6), and only a future deadline
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.UnsupportedDestination.selector);
        fd.setDelivery(USER_FLOOR, later, ETHEREUM_DOMAIN);
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.DeadlinePassed.selector);
        fd.setDelivery(USER_FLOOR, uint64(block.timestamp), BASE_DOMAIN);
        assertPreference(bob, 0, 0, 0);
    }

    function test_setDeliveryEmitsAndZeroFloorClears() public {
        uint64 later = uint64(block.timestamp + 1 days);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.DeliverySet(alice, 245e6, later, BASE_DOMAIN);
        prefer(alice, 245e6, later);
        assertPreference(alice, 245e6, later, BASE_DOMAIN);

        // a zero floor clears, whatever else is passed
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.DeliverySet(alice, 0, 0, 0);
        vm.prank(alice);
        fd.setDelivery(0, 0, ETHEREUM_DOMAIN);
        assertPreference(alice, 0, 0, 0);

        vm.prank(keeper);
        vm.expectRevert(CascadeFrontDoor.NoDelivery.selector);
        fd.deliver(alice, 0);
    }

    function test_onlyKeeperAndNotPaused() public {
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.NotKeeper.selector);
        fd.deliver(alice, 0);
        vm.prank(owner);
        vm.expectRevert(CascadeFrontDoor.NotKeeper.selector);
        fd.deliver(alice, 0);

        vm.prank(guardian);
        fd.pause();
        vm.prank(keeper);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        fd.deliver(alice, 0);
        // the preference can still be changed, and the TAO still claimed by hand
        prefer(alice, 241e6, deadline);
        vm.prank(alice);
        fd.claim();
        assertEq(tao.balanceOf(alice), 1_010e18);
        assertEq(fd.claimable(alice), 0);
    }

    function test_claimClearsPreference() public {
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.DeliverySet(alice, 0, 0, 0);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.Claimed(alice, 10e18);
        vm.prank(alice);
        fd.claim();
        assertPreference(alice, 0, 0, 0);
        assertEq(tao.balanceOf(alice), 1_010e18);

        // a later payout waits for a new preference or a claim
        payout(KEY2, alice, 2e18);
        vm.prank(keeper);
        vm.expectRevert(CascadeFrontDoor.NoDelivery.selector);
        fd.deliver(alice, 0);
    }

    function test_requestRedeemWithDeliverySetsBoth() public {
        uint256 fee = fd.redeemRequestFee();

        // first request in the batch: pays the fee, records the shares and the preference
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.DeliverySet(carol, 250e6, deadline, BASE_DOMAIN);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.RedeemRequested(1, carol, 5e18);
        vm.prank(carol);
        fd.requestRedeemWithDelivery{value: fee}(5e18, 250e6, deadline, BASE_DOMAIN);
        assertEq(fd.redeemOf(carol), 5e18);
        assertPreference(carol, 250e6, deadline, BASE_DOMAIN);
        (,,, uint256 pot,,) = fd.openBatch();
        assertEq(pot, fee);

        // adding to it is free (and any fee is refused), and replaces the preference
        vm.prank(carol);
        vm.expectRevert(CascadeFrontDoor.WrongFee.selector);
        fd.requestRedeemWithDelivery{value: fee}(1e18, 245e6, deadline, BASE_DOMAIN);
        vm.prank(carol);
        fd.requestRedeemWithDelivery(2e18, 245e6, deadline, BASE_DOMAIN);
        assertEq(fd.redeemOf(carol), 7e18);
        assertPreference(carol, 245e6, deadline, BASE_DOMAIN);
        (,,, pot,,) = fd.openBatch();
        assertEq(pot, fee);

        // more than the fee, or too little without credit, is refused; credit covers the rest
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.WrongFee.selector);
        fd.requestRedeemWithDelivery{value: fee + 1}(1e18, 250e6, deadline, BASE_DOMAIN);
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.WrongFee.selector);
        fd.requestRedeemWithDelivery(1e18, 250e6, deadline, BASE_DOMAIN);
        vm.prank(bob);
        fd.creditRedeemFee{value: fee}(bob);
        vm.prank(bob);
        fd.requestRedeemWithDelivery(1e18, 250e6, deadline, BASE_DOMAIN);
        assertEq(fd.redeemOf(bob), 1e18);
        assertEq(fd.feeCredit(bob), 0);

        // a refused preference refuses the request too
        address dave = makeAddr("dave");
        vm.deal(dave, 1 ether);
        vm.prank(dave);
        vm.expectRevert(CascadeFrontDoor.UnsupportedDestination.selector);
        fd.requestRedeemWithDelivery{value: fee}(1e18, 250e6, deadline, ETHEREUM_DOMAIN);
        assertEq(fd.redeemOf(dave), 0);

        // paused like requestRedeem
        vm.prank(guardian);
        fd.pause();
        vm.prank(dave);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        fd.requestRedeemWithDelivery{value: fee}(1e18, 250e6, deadline, BASE_DOMAIN);
    }

    function test_slippageCap() public {
        assertEq(fd.maxDeliverySlippageBps(), 150);
        assertEq(fd.MAX_DELIVERY_SLIPPAGE_BPS(), 300);

        vm.prank(owner);
        vm.expectRevert(CascadeFrontDoor.FeeTooHigh.selector);
        fd.setMaxDeliverySlippage(301);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        fd.setMaxDeliverySlippage(300);

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.MaxDeliverySlippageSet(300);
        vm.prank(owner);
        fd.setMaxDeliverySlippage(300);
        assertEq(fd.maxDeliverySlippageBps(), 300);

        // with a negligible user floor the market floor binds: 10 × 250 × 0.97 = 2_425e6
        prefer(alice, 1, deadline);
        deliverAs(keeper, alice, 0);
        assertEq(swapper.lastMinOut(), 2_425e6);
    }

    /// Review Focus 5: a TWAP that can't answer blocks delivery, never the manual claim.
    function test_twapRevertBlocksDelivery() public {
        twap.setReverts(true);
        vm.prank(keeper);
        vm.expectRevert(bytes("OLD"));
        fd.deliver(alice, 0);
        assertRestored();

        vm.prank(alice);
        fd.claim();
        assertEq(tao.balanceOf(alice), 1_010e18);
    }

    // ---- admin ----

    function test_deliverySettersOwnerOnly() public {
        assertEq(address(fd.usdc()), address(usdc));
        assertEq(fd.DESTINATION_BASE(), 6);
        address k2 = makeAddr("keeper2");
        address s2 = makeAddr("swapper2");
        ICascadeTwap o2 = ICascadeTwap(makeAddr("oracle2"));

        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        fd.setKeeper(k2);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        fd.setSwapper(s2);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        fd.setOracle(o2);
        vm.stopPrank();

        vm.startPrank(owner);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.KeeperSet(k2);
        fd.setKeeper(k2);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.SwapperSet(s2);
        fd.setSwapper(s2);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.OracleSet(address(o2));
        fd.setOracle(o2);
        vm.stopPrank();
        assertEq(fd.keeper(), k2);
        assertEq(fd.swapper(), s2);
        assertEq(address(fd.oracle()), address(o2));

        // the old keeper is out
        vm.prank(keeper);
        vm.expectRevert(CascadeFrontDoor.NotKeeper.selector);
        fd.deliver(alice, 0);
    }
}
