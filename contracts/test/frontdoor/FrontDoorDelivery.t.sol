// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {ICascadeTwap} from "../../src/interfaces/ICascadeTwap.sol";
import {MockSwapper} from "../mocks/MockSwapper.sol";
import {MockTwap} from "../mocks/MockTwap.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {FrontDoorTestBase} from "../FrontDoorTestBase.sol";
import {NotReady, NotScheduled} from "../../src/CascadeErrors.sol";
import {Schedule} from "../governance/Schedule.sol";
import {DOOR_TAO_WETH_FLOOR, DOOR_WETH_USDC_FLOOR} from "../utils/DefaultParams.sol";

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

    MockTwap twap;
    MockSwapper swapper;
    uint64 deadline;

    function setUp() public override {
        super.setUp();
        payout(KEY, alice, 10e18);
        deadline = uint64(vm.getBlockTimestamp() + 7 days);
        prefer(alice, USER_FLOOR, deadline);
    }

    /// The oracle and the swapper exist before the front door, whose constructor names them.
    function beforeFrontDoor() internal override {
        twap = new MockTwap(TWAP_PRICE);
        swapper = new MockSwapper(tao, usdc);
        swapper.setMode(MockSwapper.Mode.Honest, SWAP_RATE);
    }

    /// The fixture's keeper (FrontDoorTestBase's), the TWAP and the swapper, from the constructor.
    function frontDoorParams() internal view override returns (CascadeFrontDoor.Params memory p) {
        p = super.frontDoorParams();
        p.oracle = twap;
        p.swapper = address(swapper);
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

    /// Nothing moved: alice's 10 TAO still credited and held, no USDC paid or left in the front door,
    /// the preference intact.
    function assertRestored() internal view {
        assertEq(fd.claimable(alice), 10e18);
        assertEq(fd.totalClaimable(), 10e18);
        assertEq(tao.balanceOf(address(fd)), 10e18);
        assertEq(tao.balanceOf(address(swapper)), 0);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(address(fd)), 0);
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
        // the swapper was asked for the largest floor, paid to the front door (which forwarded all of
        // it), with the TAO already in hand
        assertEq(swapper.lastMinOut(), MIN_OUT);
        assertEq(swapper.lastTaoIn(), 10e18);
        assertEq(swapper.lastRecipient(), address(fd));
        assertEq(swapper.taoHeldAtCall(), 10e18);
        assertEq(usdc.balanceOf(address(fd)), 0);
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

    /// USDC landing on the user mid-sell from someone else (e.g. a relayed CCTP message) is not the
    /// delivery: the swapper paid the front door nothing, so it reverts and the TAO stays.
    function test_unrelatedPayoutToUserDoesNotCount() public {
        swapper.setBystander(alice);
        swapper.setMode(MockSwapper.Mode.TriggersUnrelatedPayout, 5_000e6);
        vm.prank(keeper);
        vm.expectRevert(CascadeFrontDoor.BelowMinimum.selector);
        fd.deliver(alice, 0);
        assertRestored();
    }

    /// USDC already in the front door (sent to it by anyone) is never counted or forwarded.
    function test_strayFrontDoorUsdcIsNotCounted() public {
        usdc.mint(address(fd), 5_000e6);
        swapper.setMode(MockSwapper.Mode.KeepsTao, 0);
        vm.prank(keeper);
        vm.expectRevert(CascadeFrontDoor.BelowMinimum.selector);
        fd.deliver(alice, 0);
        assertEq(fd.claimable(alice), 10e18);
        assertEq(tao.balanceOf(address(fd)), 10e18);

        swapper.setMode(MockSwapper.Mode.Honest, SWAP_RATE);
        assertEq(deliverAs(keeper, alice, 0), 2_480e6);
        assertEq(usdc.balanceOf(alice), 2_480e6);
        assertEq(usdc.balanceOf(address(fd)), 5_000e6);
    }

    /// An unset oracle or swapper only blocks delivery; the claim stays open. Each change is scheduled (Task 11:
    /// setOracle and setSwapper always are), 48 hours apiece, inside alice's 7-day preference.
    function test_unsetOracleOrSwapperBlocksDelivery() public {
        Schedule.run(fd, owner, abi.encodeCall(fd.setOracle, (ICascadeTwap(address(0)))));
        vm.prank(keeper);
        vm.expectRevert();
        fd.deliver(alice, 0);
        assertRestored();

        Schedule.run(fd, owner, abi.encodeCall(fd.setOracle, (twap)));
        Schedule.run(fd, owner, abi.encodeCall(fd.setSwapper, (address(0))));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0)));
        fd.deliver(alice, 0);
        assertRestored();

        vm.prank(alice);
        fd.claim();
        assertEq(tao.balanceOf(alice), 1_010e18);
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
        Schedule.warpTo(deadline + 1);
        vm.prank(keeper);
        vm.expectRevert(CascadeFrontDoor.DeliveryExpired.selector);
        fd.deliver(alice, 0);
        // at the deadline itself it still delivers
        Schedule.warpTo(deadline);
        assertEq(deliverAs(keeper, alice, 0), 2_480e6);

        // a payout to a user with no preference
        payout(KEY2, bob, 5e18);
        vm.prank(keeper);
        vm.expectRevert(CascadeFrontDoor.NoDelivery.selector);
        fd.deliver(bob, 0);

        // a preference but nothing credited
        uint64 later = uint64(vm.getBlockTimestamp() + 1 days);
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
        fd.setDelivery(USER_FLOOR, uint64(vm.getBlockTimestamp()), BASE_DOMAIN);
        assertPreference(bob, 0, 0, 0);
    }

    function test_setDeliveryEmitsAndZeroFloorClears() public {
        uint64 later = uint64(vm.getBlockTimestamp() + 1 days);
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

        // works while paused, like requestRedeem (spec §3.5, I-20)
        vm.prank(guardian);
        fd.pause();
        vm.prank(dave);
        fd.requestRedeemWithDelivery{value: fee}(1e18, 250e6, deadline, BASE_DOMAIN);
        assertEq(fd.redeemOf(dave), 1e18);
        assertPreference(dave, 250e6, deadline, BASE_DOMAIN);
    }

    function test_slippageCap() public {
        assertEq(fd.maxDeliverySlippageBps(), 150);
        assertEq(fd.MAX_DELIVERY_SLIPPAGE_BPS(), 300);

        // up is a loosening (Task 11): refused directly; scheduled, the setter refuses a value past the cap at
        // execute (the item kept) and takes the cap itself, 48 hours on (inside alice's 7-day preference)
        vm.prank(owner);
        vm.expectRevert(NotScheduled.selector);
        fd.setMaxDeliverySlippage(301);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        fd.setMaxDeliverySlippage(300);

        bytes memory past = abi.encodeCall(fd.setMaxDeliverySlippage, (301));
        bytes memory atCap = abi.encodeCall(fd.setMaxDeliverySlippage, (300));
        vm.startPrank(owner);
        fd.schedule(past);
        fd.schedule(atCap);
        Schedule.warpTo(vm.getBlockTimestamp() + 48 hours);
        vm.expectRevert(CascadeFrontDoor.FeeTooHigh.selector);
        fd.execute(past);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.MaxDeliverySlippageSet(300);
        fd.execute(atCap);
        vm.stopPrank();
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

    // ---- the pool-depth floor (spec §3.7, I-31; Task 32) ----

    /// While a pool's 30-minute mean liquidity is below its floor, `deliver` reverts ThinPool(index, liquidity),
    /// TAO/WETH (index 0) checked first, and nothing moves; the claim by hand is untouched and pays the TAO while both
    /// pools stay thin. That the check runs before any token moves is test_thinPoolRefusedBeforeAnyTokenMoves's.
    function test_thinPoolBlocksDeliveryNotClaim() public {
        assertEq(fd.minPoolLiquidity(0), DOOR_TAO_WETH_FLOOR, "TAO/WETH's floor, from the constructor");
        assertEq(fd.minPoolLiquidity(1), DOOR_WETH_USDC_FLOOR, "WETH/USDC's floor, from the constructor");

        // TAO/WETH one below its floor, WETH/USDC deep
        twap.setMeanLiquidity(DOOR_TAO_WETH_FLOOR - 1, type(uint128).max);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CascadeFrontDoor.ThinPool.selector, 0, DOOR_TAO_WETH_FLOOR - 1));
        fd.deliver(alice, 0);
        assertRestored();

        // WETH/USDC one below its floor, TAO/WETH deep
        twap.setMeanLiquidity(type(uint128).max, DOOR_WETH_USDC_FLOOR - 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CascadeFrontDoor.ThinPool.selector, 1, DOOR_WETH_USDC_FLOOR - 1));
        fd.deliver(alice, 0);
        assertRestored();

        // both thin (empty): the first pool below its floor is named
        twap.setMeanLiquidity(0, 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CascadeFrontDoor.ThinPool.selector, 0, 0));
        fd.deliver(alice, 0);
        assertRestored();

        // the claim by hand pays while both pools stay thin, and clears the preference
        vm.prank(alice);
        fd.claim();
        assertEq(tao.balanceOf(alice), 1_010e18);
        assertEq(fd.claimable(alice), 0);
        assertEq(fd.totalClaimable(), 0);
        assertPreference(alice, 0, 0, 0);
    }

    /// The depth check runs before any token moves (spec §3.7), pinned by which revert wins: every later step of a
    /// thin-pool delivery is made to fail with its own error, so a check moved after any of them would surface that
    /// error, not ThinPool. The TAO's transfer to the swapper reverts "the TAO moved" (a mocked call), and the swapper
    /// itself reverts SwapFailed; with the mock cleared, the reverting swapper alone still loses to ThinPool. With the
    /// pools deep again the same delivery meets the swapper's own refusal, so each tripwire is live.
    function test_thinPoolRefusedBeforeAnyTokenMoves() public {
        bytes memory toSwapper = abi.encodeCall(tao.transfer, (address(swapper), 10e18));
        bytes memory taoMoved = abi.encodeWithSignature("Error(string)", "the TAO moved");
        bytes memory thin = abi.encodeWithSelector(CascadeFrontDoor.ThinPool.selector, 0, DOOR_TAO_WETH_FLOOR - 1);
        swapper.setMode(MockSwapper.Mode.Reverts, 0);
        twap.setMeanLiquidity(DOOR_TAO_WETH_FLOOR - 1, type(uint128).max);

        // the TAO's transfer and the sale both trip: ThinPool comes first
        vm.mockCallRevert(address(tao), toSwapper, taoMoved);
        vm.prank(keeper);
        vm.expectRevert(thin);
        fd.deliver(alice, 0);
        // the tripwire is live: with deep pools the delivery reaches the transfer and fails on it
        twap.setMeanLiquidity(type(uint128).max, type(uint128).max);
        vm.prank(keeper);
        vm.expectRevert(taoMoved);
        fd.deliver(alice, 0);

        // the sale alone trips: ThinPool still comes first, and with deep pools the sale's own error does
        vm.clearMockedCalls();
        twap.setMeanLiquidity(DOOR_TAO_WETH_FLOOR - 1, type(uint128).max);
        vm.prank(keeper);
        vm.expectRevert(thin);
        fd.deliver(alice, 0);
        twap.setMeanLiquidity(type(uint128).max, type(uint128).max);
        vm.prank(keeper);
        vm.expectRevert(MockSwapper.SwapFailed.selector);
        fd.deliver(alice, 0);
        assertRestored();
    }

    /// The floors' setter (spec §3.6, §3.7): a raise, or an equal value, applies at once, and the next delivery
    /// meets it; a cut loosens, so it runs only as a scheduled item (the Param class, 48 hours): a direct cut reverts
    /// NotScheduled, the owner's included. Each change logs LimitSet("minPoolLiquidity", index, value). An index
    /// above 1 names no pool and reverts InvalidParameter, directly and at execute. A floor of 0 checks nothing.
    function test_floorRaiseImmediateCutScheduled() public {
        uint128 depth0 = 5e20;
        uint128 depth1 = 5e17;
        twap.setMeanLiquidity(depth0, depth1);

        // TAO/WETH's floor raised above the pool's depth, at once: the next delivery is refused
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.LimitSet("minPoolLiquidity", 0, depth0 + 1);
        vm.prank(owner);
        fd.setMinPoolLiquidity(0, depth0 + 1);
        assertEq(fd.minPoolLiquidity(0), depth0 + 1, "a raise at once");
        assertEq(fd.minPoolLiquidity(1), DOOR_WETH_USDC_FLOOR, "the other floor untouched");
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CascadeFrontDoor.ThinPool.selector, 0, depth0));
        fd.deliver(alice, 0);
        vm.prank(owner);
        fd.setMinPoolLiquidity(0, depth0 + 1);
        assertEq(fd.minPoolLiquidity(0), depth0 + 1, "an equal value at once");

        // a cut, directly: NotScheduled for the owner, refused for anyone else
        vm.prank(owner);
        vm.expectRevert(NotScheduled.selector);
        fd.setMinPoolLiquidity(0, depth0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        fd.setMinPoolLiquidity(0, depth0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        fd.setMinPoolLiquidity(0, depth0 + 2);
        assertEq(fd.minPoolLiquidity(0), depth0 + 1);

        // the cut, scheduled: 48 hours on (inside alice's 7-day preference) it runs, and she is delivered
        bytes memory cut = abi.encodeCall(fd.setMinPoolLiquidity, (0, depth0));
        vm.prank(owner);
        fd.schedule(cut);
        Schedule.warpTo(vm.getBlockTimestamp() + 48 hours - 1);
        vm.prank(owner);
        vm.expectRevert(NotReady.selector);
        fd.execute(cut);
        Schedule.warpTo(vm.getBlockTimestamp() + 1);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.LimitSet("minPoolLiquidity", 0, depth0);
        vm.prank(owner);
        fd.execute(cut);
        assertEq(fd.minPoolLiquidity(0), depth0, "the scheduled cut");
        assertEq(deliverAs(keeper, alice, 0), 2_480e6);

        // WETH/USDC's floor the same way
        payout(KEY2, alice, 4e18);
        vm.prank(owner);
        fd.setMinPoolLiquidity(1, depth1 + 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CascadeFrontDoor.ThinPool.selector, 1, depth1));
        fd.deliver(alice, 0);
        vm.prank(owner);
        vm.expectRevert(NotScheduled.selector);
        fd.setMinPoolLiquidity(1, depth1);

        // both cut to 0, each scheduled: no check, so even empty pools deliver (the emergency path)
        Schedule.run(fd, owner, abi.encodeCall(fd.setMinPoolLiquidity, (0, 0)));
        Schedule.run(fd, owner, abi.encodeCall(fd.setMinPoolLiquidity, (1, 0)));
        assertEq(fd.minPoolLiquidity(0), 0);
        assertEq(fd.minPoolLiquidity(1), 0);
        twap.setMeanLiquidity(0, 0);
        assertEq(deliverAs(keeper, alice, 0), 992e6);

        // an index above 1 names no pool: InvalidParameter, a raise or a cut, directly or at execute (the item kept)
        uint8[2] memory bad = [2, type(uint8).max];
        for (uint256 i; i < bad.length; ++i) {
            vm.startPrank(owner);
            vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
            fd.setMinPoolLiquidity(bad[i], 1);
            vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
            fd.setMinPoolLiquidity(bad[i], 0);
            vm.stopPrank();
        }
        bytes memory noPool = abi.encodeCall(fd.setMinPoolLiquidity, (2, 0));
        vm.prank(owner);
        bytes32 id = fd.schedule(noPool);
        Schedule.warpTo(vm.getBlockTimestamp() + 48 hours);
        vm.prank(owner);
        vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
        fd.execute(noPool);
        assertGt(doorLens.scheduled(id).readyAt, 0, "the item stays");
    }

    /// I-31's edge: a pool exactly at its floor is deep enough, so the delivery settles as before, at the largest
    /// price floor; one unit below either floor refuses the next one.
    function test_deliveryAtTheFloorSettles() public {
        twap.setMeanLiquidity(DOOR_TAO_WETH_FLOOR, DOOR_WETH_USDC_FLOOR);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.Delivered(alice, 10e18, 2_480e6);
        assertEq(deliverAs(keeper, alice, 0), 2_480e6);
        assertEq(swapper.lastMinOut(), MIN_OUT, "the price floors unchanged");
        assertEq(usdc.balanceOf(alice), 2_480e6);
        assertEq(fd.claimable(alice), 0);

        payout(KEY2, alice, 4e18);
        twap.setMeanLiquidity(DOOR_TAO_WETH_FLOOR, DOOR_WETH_USDC_FLOOR - 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CascadeFrontDoor.ThinPool.selector, 1, DOOR_WETH_USDC_FLOOR - 1));
        fd.deliver(alice, 0);
        twap.setMeanLiquidity(DOOR_TAO_WETH_FLOOR - 1, DOOR_WETH_USDC_FLOOR);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CascadeFrontDoor.ThinPool.selector, 0, DOOR_TAO_WETH_FLOOR - 1));
        fd.deliver(alice, 0);
        assertEq(fd.claimable(alice), 4e18, "the refused delivery left the credit");

        twap.setMeanLiquidity(DOOR_TAO_WETH_FLOOR, DOOR_WETH_USDC_FLOOR);
        assertEq(deliverAs(keeper, alice, 0), 992e6);
    }

    // ---- admin ----

    function test_deliverySettersOwnerOnly() public {
        assertEq(address(fd.usdc()), address(usdc));
        assertEq(fd.DESTINATION_BASE(), 6);
        address k2 = makeAddr("keeper2");
        address s2 = makeAddr("swapper2");
        ICascadeTwap o2 = ICascadeTwap(makeAddr("oracle2"));

        // the swapper and the oracle are scheduled only (Task 11): a direct call is NotScheduled, the owner's too
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        fd.setKeeper(k2);
        vm.expectRevert(NotScheduled.selector);
        fd.setSwapper(s2);
        vm.expectRevert(NotScheduled.selector);
        fd.setOracle(o2);
        vm.stopPrank();

        vm.startPrank(owner);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.KeeperSet(k2);
        fd.setKeeper(k2);
        vm.expectRevert(NotScheduled.selector);
        fd.setSwapper(s2);
        vm.expectRevert(NotScheduled.selector);
        fd.setOracle(o2);
        bytes memory toS2 = abi.encodeCall(fd.setSwapper, (s2));
        bytes memory toO2 = abi.encodeCall(fd.setOracle, (o2));
        fd.schedule(toS2);
        fd.schedule(toO2);
        Schedule.warpTo(vm.getBlockTimestamp() + 48 hours);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.SwapperSet(s2);
        fd.execute(toS2);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.OracleSet(address(o2));
        fd.execute(toO2);
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
