// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeStaker} from "../../src/CascadeStaker.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {ISlipstreamRouter} from "../../src/interfaces/ISlipstreamRouter.sol";
import {IUniswapV3Router02} from "../../src/interfaces/IUniswapV3Router02.sol";
import {MockSwapRouter} from "../mocks/MockSwapRouter.sol";
import {MockTAO} from "../mocks/MockTAO.sol";
import {MockTwap} from "../mocks/MockTwap.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {FrontDoorTestBase} from "../FrontDoorTestBase.sol";

/// A contract payer (a bridge executor later): holds USDC, approves exactly and stakes for someone else.
contract StakeCaller {
    function stakeFor(CascadeStaker staker, IERC20 usdc, address beneficiary, uint256 usdcIn, uint256 minTaoOut)
        external
        returns (uint256)
    {
        usdc.approve(address(staker), usdcIn);
        return staker.stake(beneficiary, usdcIn, minTaoOut, 0, block.timestamp);
    }
}

/// @notice CascadeStaker against a real front door (FrontDoorTestBase: 1 TAO minimum, 10,000 TAO cap,
/// 4,000 TAO batch value) and a mock router that buys at 4,000,000,001 TAO wei per USDC unit (about
/// $250/TAO, leaving sub-rao dust) and sells at 250 USDC per TAO. Route 0 is the Uniswap two-hop
/// USDC -0.05%-> WETH -0.3%-> TAO, also the delivery route; fees 15 bps and 50_000 ($0.05).
contract StakerTest is FrontDoorTestBase {
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    uint256 constant BUY_PER_UNIT = 4_000_000_001;
    uint256 constant SELL_RATE = 250e6;
    uint16 constant SWAP_FEE = 15;
    uint256 constant DEPOSIT_FEE = 50_000;

    uint256 constant USDC_IN = 1_000e6;
    /// 0.15% of 1_000e6 - 50_000 = 999_950_000, rounded down
    uint256 constant SWAP_FEE_AMOUNT = 1_499_925;
    uint256 constant FEES = 1_549_925;
    uint256 constant TO_ROUTER = 998_450_075;
    uint256 constant TAO_OUT = 3_993_800_300_998_450_075;
    uint256 constant DEPOSITED = 3_993_800_300_000_000_000;
    uint256 constant DUST = 998_450_075;
    uint256 constant MIN_TAO = 3.9e18;

    address treasury = makeAddr("treasury");
    address weth = makeAddr("weth");
    address keeper = makeAddr("keeper");

    CascadeStaker staker;
    MockSwapRouter router;
    bytes buyPath;
    bytes sellPath;

    function setUp() public override {
        super.setUp();
        staker = new CascadeStaker(usdc, tao, fd, owner, treasury);
        router = new MockSwapRouter();
        router.setRate(address(usdc), BUY_PER_UNIT * 1e18);
        router.setRate(address(tao), SELL_RATE);
        buyPath = abi.encodePacked(address(usdc), uint24(500), weth, uint24(3000), address(tao));
        sellPath = abi.encodePacked(address(tao), uint24(3000), weth, uint24(500), address(usdc));

        vm.startPrank(owner);
        staker.setRoute(0, route(CascadeStaker.RouterKind.UniswapV3, buyPath, sellPath, true));
        staker.setDeliveryRoute(0);
        staker.setFees(SWAP_FEE, DEPOSIT_FEE);
        vm.stopPrank();
    }

    // ---- helpers ----

    function route(CascadeStaker.RouterKind kind, bytes memory buy, bytes memory sell, bool active)
        internal
        view
        returns (CascadeStaker.Route memory)
    {
        return CascadeStaker.Route(kind, address(router), buy, sell, active);
    }

    function fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(staker), amount);
    }

    function stakeAs(address payer, address beneficiary, uint256 usdcIn, uint8 routeId) internal returns (uint256) {
        vm.prank(payer);
        return staker.stake(beneficiary, usdcIn, MIN_TAO, routeId, block.timestamp);
    }

    function signPermit(uint256 key, address holder, uint256 value, uint256 nonce, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, holder, address(staker), value, nonce, deadline))
            )
        );
        return vm.sign(key, digest);
    }

    /// The front door has sent the staker `amount` TAO, as `deliver` does before calling sellFor.
    function sendTaoFromFrontDoor(uint256 amount) internal {
        tao.mint(address(fd), amount);
        vm.prank(address(fd));
        assertTrue(tao.transfer(address(staker), amount));
    }

    /// The staker holds nothing and leaves no allowance behind.
    function assertClean(uint256 taoDust) internal view {
        assertEq(usdc.balanceOf(address(staker)), 0, "staker usdc");
        assertEq(tao.balanceOf(address(staker)), taoDust, "staker tao");
        assertEq(usdc.allowance(address(staker), address(router)), 0, "usdc allowance");
        assertEq(tao.allowance(address(staker), address(router)), 0, "tao allowance to router");
        assertEq(tao.allowance(address(staker), address(fd)), 0, "tao allowance to front door");
    }

    function totalOpenDeposits() internal view returns (uint256 total) {
        (,, total,,,) = fd.openBatch();
    }

    // ---- stake ----

    function test_stakeTakesFeesSwapsAndDeposits() public {
        assertEq(TO_ROUTER * BUY_PER_UNIT, TAO_OUT);
        assertEq(TAO_OUT - DEPOSITED, DUST);
        fund(alice, USDC_IN);

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.DepositRequested(1, bob, DEPOSITED, address(staker));
        vm.expectEmit(address(staker));
        emit CascadeStaker.Staked(alice, bob, USDC_IN, FEES, DEPOSITED);
        uint256 got = stakeAs(alice, bob, USDC_IN, 0);

        assertEq(got, DEPOSITED);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(treasury), DEPOSIT_FEE + SWAP_FEE_AMOUNT);
        assertEq(usdc.balanceOf(address(router)), TO_ROUTER);
        assertEq(router.calls(), 1);
        assertEq(uint8(router.lastKind()), uint8(MockSwapRouter.Kind.UniswapV3));
        assertEq(router.lastPath(), buyPath);
        assertEq(router.lastRecipient(), address(staker));
        assertEq(router.lastAmountIn(), TO_ROUTER);
        assertEq(router.lastAmountOutMinimum(), MIN_TAO);

        assertEq(fd.depositOf(bob), DEPOSITED);
        assertEq(fd.depositOf(alice), 0);
        assertEq(totalOpenDeposits(), DEPOSITED);
        assertEq(tao.balanceOf(address(fd)), DEPOSITED);
        assertClean(DUST);
    }

    function test_feeCaps() public {
        assertEq(staker.MAX_SWAP_FEE_BPS(), 50);
        assertEq(staker.MAX_DEPOSIT_FEE_USDC(), 250_000);
        vm.startPrank(owner);
        vm.expectRevert(CascadeStaker.FeeTooHigh.selector);
        staker.setFees(51, 0);
        vm.expectRevert(CascadeStaker.FeeTooHigh.selector);
        staker.setFees(0, 250_001);
        vm.expectEmit(address(staker));
        emit CascadeStaker.FeesSet(50, 250_000);
        staker.setFees(50, 250_000);
        vm.stopPrank();
        assertEq(staker.swapFeeBps(), 50);
        assertEq(staker.depositFeeUsdc(), 250_000);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        staker.setFees(0, 0);

        // at the caps: 1_000e6 - 250_000 = 999_750_000; 0.5% of it = 4_998_750; 994_751_250 swapped
        fund(alice, USDC_IN);
        stakeAs(alice, alice, USDC_IN, 0);
        assertEq(usdc.balanceOf(treasury), 250_000 + 4_998_750);
        assertEq(router.lastAmountIn(), 994_751_250);
        assertEq(fd.depositOf(alice), 994_751_250 * BUY_PER_UNIT / 1e9 * 1e9);

        // no fees: everything is swapped, nothing sent to the treasury
        vm.prank(owner);
        staker.setFees(0, 0);
        fund(bob, USDC_IN);
        stakeAs(bob, bob, USDC_IN, 0);
        assertEq(usdc.balanceOf(treasury), 5_248_750);
        assertEq(router.lastAmountIn(), USDC_IN);

        // the deposit fee must leave something to swap
        vm.prank(owner);
        staker.setFees(15, 50_000);
        fund(carol, 50_000);
        vm.expectRevert(CascadeStaker.AmountTooSmall.selector);
        vm.prank(carol);
        staker.stake(carol, 50_000, 0, 0, block.timestamp);
    }

    function test_minTaoOutEnforcedByBalanceDelta() public {
        // reports MIN_TAO (3.9 TAO) as paid but delivers about 3.8 TAO, which the front door would accept
        router.setLies(true);
        router.setRate(address(usdc), 3_806_000_000e18);
        fund(alice, USDC_IN);

        vm.expectRevert(CascadeStaker.InsufficientOutput.selector);
        stakeAs(alice, alice, USDC_IN, 0);

        assertEq(usdc.balanceOf(alice), USDC_IN);
        assertEq(usdc.allowance(alice, address(staker)), USDC_IN);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(fd.depositOf(alice), 0);
        assertEq(totalOpenDeposits(), 0);
        assertClean(0);

        // an honest router refuses on its own minimum, which the staker sets to minTaoOut
        router.setLies(false);
        vm.expectRevert(bytes("Too little received"));
        stakeAs(alice, alice, USDC_IN, 0);
        assertEq(usdc.balanceOf(alice), USDC_IN);
    }

    /// A router that leaves part of the USDC behind would leave user funds in the staker: refused.
    function test_routerMustSpendExactlyTheInput() public {
        router.setPullShort(1);
        fund(alice, USDC_IN);
        vm.expectRevert(CascadeStaker.SwapIncomplete.selector);
        stakeAs(alice, alice, USDC_IN, 0);
        assertEq(usdc.balanceOf(alice), USDC_IN);
        assertClean(0);

        sendTaoFromFrontDoor(10e18);
        vm.expectRevert(CascadeStaker.SwapIncomplete.selector);
        vm.prank(address(fd));
        staker.sellFor(10e18, alice, 0);
    }

    function test_pathsMustMatchTokens() public {
        CascadeStaker.Route memory r = route(CascadeStaker.RouterKind.UniswapV3, buyPath, sellPath, true);
        bytes[] memory badBuys = new bytes[](8);
        badBuys[0] = sellPath; // TAO -> USDC
        badBuys[1] = abi.encodePacked(address(usdc), uint24(500), weth); // ends at WETH
        badBuys[2] = abi.encodePacked(weth, uint24(3000), address(tao)); // starts at WETH
        badBuys[3] = abi.encodePacked(address(usdc), address(tao)); // no fee: 40 bytes
        badBuys[4] = abi.encodePacked(address(usdc), uint24(500), uint8(0), address(tao)); // 44 bytes
        badBuys[5] = abi.encodePacked(address(usdc)); // no hop
        badBuys[6] = abi.encodePacked(address(tao));
        badBuys[7] = "";
        vm.startPrank(owner);
        for (uint256 i; i < badBuys.length; ++i) {
            r.buyPath = badBuys[i];
            vm.expectRevert(CascadeStaker.BadPath.selector);
            staker.setRoute(1, r);
        }
        r.buyPath = buyPath;
        r.sellPath = buyPath; // USDC -> TAO
        vm.expectRevert(CascadeStaker.BadPath.selector);
        staker.setRoute(1, r);
        r.sellPath = abi.encodePacked(address(tao), uint24(3000), weth); // ends at WETH
        vm.expectRevert(CascadeStaker.BadPath.selector);
        staker.setRoute(1, r);

        // one hop each way is a valid path
        r.buyPath = abi.encodePacked(address(usdc), uint24(3000), address(tao));
        r.sellPath = abi.encodePacked(address(tao), uint24(3000), address(usdc));
        vm.expectEmit(address(staker));
        emit CascadeStaker.RouteSet(1, CascadeStaker.RouterKind.UniswapV3, address(router), r.buyPath, r.sellPath, true);
        staker.setRoute(1, r);
        (
            CascadeStaker.RouterKind kind,
            address routerAddr,
            bytes memory storedBuy,
            bytes memory storedSell,
            bool active
        ) = staker.routes(1);
        assertEq(uint8(kind), uint8(CascadeStaker.RouterKind.UniswapV3));
        assertEq(routerAddr, address(router));
        assertEq(storedBuy, r.buyPath);
        assertEq(storedSell, r.sellPath);
        assertTrue(active);

        r.router = address(0);
        vm.expectRevert(CascadeStaker.ZeroAddress.selector);
        staker.setRoute(1, r);

        // an inactive route refuses stakes and cannot become the delivery route
        staker.setRoute(2, route(CascadeStaker.RouterKind.UniswapV3, buyPath, sellPath, false));
        vm.expectRevert(CascadeStaker.RouteInactive.selector);
        staker.setDeliveryRoute(2);
        vm.expectRevert(CascadeStaker.RouteInactive.selector);
        staker.setDeliveryRoute(9);
        vm.stopPrank();

        fund(alice, USDC_IN);
        vm.expectRevert(CascadeStaker.RouteInactive.selector);
        stakeAs(alice, alice, USDC_IN, 2);
        vm.expectRevert(CascadeStaker.RouteInactive.selector);
        stakeAs(alice, alice, USDC_IN, 9);

        // switching the delivery route off stops sells
        vm.prank(owner);
        staker.setRoute(0, route(CascadeStaker.RouterKind.UniswapV3, buyPath, sellPath, false));
        sendTaoFromFrontDoor(10e18);
        vm.expectRevert(CascadeStaker.RouteInactive.selector);
        vm.prank(address(fd));
        staker.sellFor(10e18, alice, 0);

        // only the owner sets routes
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        staker.setRoute(0, route(CascadeStaker.RouterKind.UniswapV3, buyPath, sellPath, true));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        staker.setDeliveryRoute(1);
    }

    /// Review Focus 3: whatever happens to the permit, the stake runs on the allowance there is and
    /// never pulls more than usdcIn.
    function test_permitPaths() public {
        (address payer, uint256 key) = makeAddrAndKey("payer");
        usdc.mint(payer, 3_000e6);
        uint256 permitDeadline = block.timestamp + 1 hours;

        // a valid permit stakes
        (uint8 v, bytes32 r, bytes32 s) = signPermit(key, payer, USDC_IN, 0, permitDeadline);
        vm.expectEmit(address(staker));
        emit CascadeStaker.Staked(payer, payer, USDC_IN, FEES, DEPOSITED);
        vm.prank(payer);
        uint256 got = staker.stakeWithPermit(payer, USDC_IN, MIN_TAO, 0, block.timestamp, permitDeadline, v, r, s);
        assertEq(got, DEPOSITED);
        assertEq(usdc.nonces(payer), 1);
        assertEq(usdc.allowance(payer, address(staker)), 0);
        assertEq(usdc.balanceOf(payer), 2_000e6);
        assertEq(fd.depositOf(payer), DEPOSITED);

        // a front-runner submits the permit first: the stake proceeds on the allowance it left
        (v, r, s) = signPermit(key, payer, USDC_IN, 1, permitDeadline);
        vm.prank(carol);
        usdc.permit(payer, address(staker), USDC_IN, permitDeadline, v, r, s);
        vm.prank(payer);
        staker.stakeWithPermit(payer, USDC_IN, MIN_TAO, 0, block.timestamp, permitDeadline, v, r, s);
        assertEq(usdc.nonces(payer), 2);
        assertEq(usdc.allowance(payer, address(staker)), 0);
        assertEq(usdc.balanceOf(payer), 1_000e6);
        assertEq(fd.depositOf(payer), 2 * DEPOSITED);

        // a permit for a smaller amount does not verify for usdcIn: transferFrom reverts, nothing moves
        (v, r, s) = signPermit(key, payer, 500e6, 2, permitDeadline);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(staker), 0, USDC_IN)
        );
        vm.prank(payer);
        staker.stakeWithPermit(payer, USDC_IN, MIN_TAO, 0, block.timestamp, permitDeadline, v, r, s);
        // ... nor with a smaller allowance already in place, which is never exceeded
        vm.prank(payer);
        usdc.approve(address(staker), 500e6);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(staker), 500e6, USDC_IN)
        );
        vm.prank(payer);
        staker.stakeWithPermit(payer, USDC_IN, MIN_TAO, 0, block.timestamp, permitDeadline, v, r, s);
        assertEq(usdc.balanceOf(payer), 1_000e6);
        assertEq(usdc.nonces(payer), 2);
        assertEq(usdc.balanceOf(treasury), 2 * FEES);
        assertEq(fd.depositOf(payer), 2 * DEPOSITED);

        // an expired permit with no allowance reverts
        vm.prank(payer);
        usdc.approve(address(staker), 0);
        (v, r, s) = signPermit(key, payer, USDC_IN, 2, permitDeadline);
        vm.warp(permitDeadline + 1);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(staker), 0, USDC_IN)
        );
        vm.prank(payer);
        staker.stakeWithPermit(payer, USDC_IN, MIN_TAO, 0, block.timestamp, permitDeadline, v, r, s);
        assertEq(usdc.balanceOf(payer), 1_000e6);

        // ... and stakes when an approve (the fallback for wallets whose permits fail) is in place,
        // pulling exactly usdcIn out of a larger allowance
        vm.prank(payer);
        usdc.approve(address(staker), 5_000e6);
        vm.prank(payer);
        staker.stakeWithPermit(payer, USDC_IN, MIN_TAO, 0, block.timestamp, permitDeadline, v, r, s);
        assertEq(usdc.balanceOf(payer), 0);
        assertEq(usdc.allowance(payer, address(staker)), 4_000e6);
        assertEq(usdc.nonces(payer), 2);
        assertEq(fd.depositOf(payer), 3 * DEPOSITED);
        assertClean(3 * DUST);
    }

    function test_stakeForAnyBeneficiaryFromAContract() public {
        StakeCaller caller = new StakeCaller();
        usdc.mint(address(caller), USDC_IN);

        vm.expectEmit(address(staker));
        emit CascadeStaker.Staked(address(caller), bob, USDC_IN, FEES, DEPOSITED);
        caller.stakeFor(staker, usdc, bob, USDC_IN, MIN_TAO);

        assertEq(fd.depositOf(bob), DEPOSITED);
        assertEq(fd.depositOf(address(caller)), 0);
        assertEq(fd.depositOf(address(staker)), 0);
        CascadeMessages.Entry[] memory entries = fd.openDeposits();
        assertEq(entries.length, 1);
        assertEq(entries[0].user, bob);
        assertEq(entries[0].amount, DEPOSITED);
        assertEq(usdc.balanceOf(address(caller)), 0);
    }

    /// Review Focus 4: no deposit lands on an address nobody controls.
    function test_badBeneficiaries() public {
        fund(alice, USDC_IN);
        address[3] memory bad = [address(0), address(staker), address(fd)];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(CascadeStaker.BadBeneficiary.selector);
            stakeAs(alice, bad[i], USDC_IN, 0);
        }
        // the permit entry point too
        (address payer, uint256 key) = makeAddrAndKey("payer");
        usdc.mint(payer, USDC_IN);
        (uint8 v, bytes32 r, bytes32 s) = signPermit(key, payer, USDC_IN, 0, block.timestamp);
        vm.expectRevert(CascadeStaker.BadBeneficiary.selector);
        vm.prank(payer);
        staker.stakeWithPermit(address(fd), USDC_IN, MIN_TAO, 0, block.timestamp, block.timestamp, v, r, s);

        assertEq(usdc.balanceOf(alice), USDC_IN);
        assertEq(usdc.balanceOf(payer), USDC_IN);
        assertEq(usdc.nonces(payer), 0);
        assertEq(totalOpenDeposits(), 0);
        assertEq(router.calls(), 0);
    }

    function test_expiredDeadline() public {
        fund(alice, USDC_IN);
        uint256 deadline = block.timestamp;
        vm.warp(deadline + 1);
        vm.expectRevert(CascadeStaker.Expired.selector);
        vm.prank(alice);
        staker.stake(alice, USDC_IN, MIN_TAO, 0, deadline);

        // the deadline itself is still in time
        vm.prank(alice);
        staker.stake(alice, USDC_IN, MIN_TAO, 0, block.timestamp);
        assertEq(fd.depositOf(alice), DEPOSITED);
    }

    function test_frontDoorCapRevertsWholeStake() public {
        fund(alice, USDC_IN);

        // a 3 TAO cap below the 3.99 TAO this stake buys
        vm.prank(owner);
        fd.setCaps(1e18, 3e18);
        vm.expectRevert(CascadeFrontDoor.CapExceeded.selector);
        stakeAs(alice, alice, USDC_IN, 0);
        assertWholeStakeReverted();

        // the batch's value limit
        vm.startPrank(owner);
        fd.setCaps(1e18, 10_000e18);
        fd.setMaxBatchValue(3e18);
        vm.stopPrank();
        vm.expectRevert(CascadeFrontDoor.BatchValueFull.selector);
        stakeAs(alice, alice, USDC_IN, 0);
        assertWholeStakeReverted();

        // the front door's minimum
        vm.startPrank(owner);
        fd.setMaxBatchValue(4_000e18);
        fd.setCaps(5e18, 10_000e18);
        vm.stopPrank();
        vm.expectRevert(CascadeFrontDoor.BelowMinDeposit.selector);
        stakeAs(alice, alice, USDC_IN, 0);
        assertWholeStakeReverted();

        // a paused front door
        vm.prank(owner);
        fd.setCaps(1e18, 10_000e18);
        vm.prank(guardian);
        fd.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        stakeAs(alice, alice, USDC_IN, 0);
        assertWholeStakeReverted();
    }

    function assertWholeStakeReverted() internal view {
        assertEq(usdc.balanceOf(alice), USDC_IN, "payer usdc");
        assertEq(usdc.balanceOf(treasury), 0, "treasury");
        assertEq(usdc.balanceOf(address(router)), 0, "router usdc");
        assertEq(router.calls(), 0, "router calls");
        assertEq(totalOpenDeposits(), 0, "deposits");
        assertClean(0);
    }

    // ---- sellFor ----

    function test_sellForOnlyFrontDoor() public {
        sendTaoFromFrontDoor(10e18);
        vm.expectRevert(CascadeStaker.NotFrontDoor.selector);
        vm.prank(alice);
        staker.sellFor(10e18, alice, 0);
        vm.expectRevert(CascadeStaker.NotFrontDoor.selector);
        vm.prank(owner);
        staker.sellFor(10e18, alice, 0);

        // 10 TAO at 250 = 2_500e6; 0.15% = 3_750_000 to the treasury; 2_496_250_000 to alice
        vm.expectEmit(address(staker));
        emit CascadeStaker.Sold(alice, 10e18, 2_496_250_000, 3_750_000);
        vm.prank(address(fd));
        uint256 out = staker.sellFor(10e18, alice, 2_400e6);
        assertEq(out, 2_496_250_000);
        assertEq(usdc.balanceOf(alice), 2_496_250_000);
        assertEq(usdc.balanceOf(treasury), 3_750_000);
        assertEq(uint8(router.lastKind()), uint8(MockSwapRouter.Kind.UniswapV3));
        assertEq(router.lastPath(), sellPath);
        assertEq(router.lastRecipient(), address(staker));
        assertEq(router.lastAmountIn(), 10e18);
        assertEq(router.lastAmountOutMinimum(), 2_400e6);
        assertEq(tao.balanceOf(address(router)), 10e18);
        assertClean(0);

        // the fee comes out of the minimum's margin: one unit above the net reverts
        sendTaoFromFrontDoor(10e18);
        vm.expectRevert(CascadeStaker.InsufficientOutput.selector);
        vm.prank(address(fd));
        staker.sellFor(10e18, alice, 2_496_250_001);
        vm.prank(address(fd));
        assertEq(staker.sellFor(10e18, alice, 2_496_250_000), 2_496_250_000);

        // a router paying short of the minimum, whatever it reports
        router.setLies(true);
        router.setRate(address(tao), 200e6);
        sendTaoFromFrontDoor(10e18);
        vm.expectRevert(CascadeStaker.InsufficientOutput.selector);
        vm.prank(address(fd));
        staker.sellFor(10e18, alice, 2_400e6);
    }

    /// The real delivery path: the front door sends alice's 10 TAO to the staker and checks her USDC.
    function test_deliverThroughStaker() public {
        MockTwap twap = new MockTwap(250e6);
        vm.startPrank(owner);
        fd.setKeeper(keeper);
        fd.setSwapper(address(staker));
        fd.setOracle(twap);
        vm.stopPrank();

        CascadeMessages.Entry[] memory e = new CascadeMessages.Entry[](1);
        e[0] = CascadeMessages.Entry(alice, 10e18);
        tao.mint(address(fd), 10e18);
        vm.prank(address(bridge));
        fd.onBridgeMessage(BITTENSOR, vault, CascadeMessages.encodePayouts(keccak256("batch-1"), 0, e), 10e18);
        vm.prank(alice);
        fd.setDelivery(240e6, uint64(block.timestamp + 7 days), 6);

        // a route selling below the market floor (2_462.5e6) only makes the delivery revert
        router.setRate(address(tao), 245e6);
        vm.expectRevert(bytes("Too little received"));
        vm.prank(keeper);
        fd.deliver(alice, 0);
        assertEq(fd.claimable(alice), 10e18);

        router.setRate(address(tao), SELL_RATE);
        vm.prank(keeper);
        uint256 received = fd.deliver(alice, 0);
        assertEq(received, 2_496_250_000);
        assertEq(usdc.balanceOf(alice), 2_496_250_000);
        assertEq(usdc.balanceOf(treasury), 3_750_000);
        assertEq(router.lastAmountOutMinimum(), 2_462_500_000);
        assertEq(fd.claimable(alice), 0);
        assertClean(0);
    }

    function test_slipstreamStructCarriesDeadline() public {
        bytes memory buy = abi.encodePacked(address(usdc), int24(100), address(tao));
        bytes memory sell = abi.encodePacked(address(tao), int24(100), address(usdc));
        vm.prank(owner);
        staker.setRoute(1, route(CascadeStaker.RouterKind.Slipstream, buy, sell, true));

        fund(alice, 2 * USDC_IN);
        uint256 deadline = block.timestamp + 600;
        vm.prank(alice);
        staker.stake(alice, USDC_IN, MIN_TAO, 1, deadline);
        assertEq(uint8(router.lastKind()), uint8(MockSwapRouter.Kind.Slipstream));
        assertEq(router.lastDeadline(), deadline);
        assertEq(router.lastPath(), buy);
        assertEq(router.lastRecipient(), address(staker));
        assertEq(router.lastAmountIn(), TO_ROUTER);
        assertEq(router.lastAmountOutMinimum(), MIN_TAO);
        assertEq(fd.depositOf(alice), DEPOSITED);

        // SwapRouter02's struct has no deadline field
        stakeAs(alice, alice, USDC_IN, 0);
        assertEq(uint8(router.lastKind()), uint8(MockSwapRouter.Kind.UniswapV3));
        assertEq(router.lastDeadline(), 0);

        // a Slipstream delivery route sells with the block's own time as the deadline
        vm.prank(owner);
        staker.setDeliveryRoute(1);
        assertEq(staker.deliveryRouteId(), 1);
        vm.warp(block.timestamp + 1 days);
        sendTaoFromFrontDoor(10e18);
        vm.prank(address(fd));
        staker.sellFor(10e18, alice, 0);
        assertEq(uint8(router.lastKind()), uint8(MockSwapRouter.Kind.Slipstream));
        assertEq(router.lastDeadline(), block.timestamp);
        assertEq(router.lastPath(), sell);
    }

    function test_routerSelectorsMatchTheRealRouters() public pure {
        assertEq(IUniswapV3Router02.exactInput.selector, bytes4(0xb858183f));
        assertEq(ISlipstreamRouter.exactInput.selector, bytes4(0xc04b8d59));
    }

    // ---- dust and admin ----

    function test_dustAndSweep() public {
        fund(alice, 2 * USDC_IN);
        stakeAs(alice, alice, USDC_IN, 0);
        assertLt(DUST, 1e9);
        assertEq(tao.balanceOf(address(staker)), DUST);

        // a second stake deposits its own floored output, not the dust left by the first
        stakeAs(alice, alice, USDC_IN, 0);
        assertEq(fd.depositOf(alice), 2 * DEPOSITED);
        assertEq(tao.balanceOf(address(staker)), 2 * DUST);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        staker.sweep(tao);

        vm.expectEmit(address(staker));
        emit CascadeStaker.Swept(address(tao), 2 * DUST);
        vm.prank(owner);
        staker.sweep(tao);
        assertEq(tao.balanceOf(treasury), 2 * DUST);
        assertEq(tao.balanceOf(address(staker)), 0);

        usdc.mint(address(staker), 7);
        vm.prank(owner);
        staker.sweep(usdc);
        assertEq(usdc.balanceOf(treasury), 2 * FEES + 7);
        assertClean(0);
    }

    function test_constructorAndAdmin() public {
        assertEq(address(staker.usdc()), address(usdc));
        assertEq(address(staker.tao()), address(tao));
        assertEq(address(staker.frontDoor()), address(fd));
        assertEq(staker.owner(), owner);
        assertEq(staker.treasury(), treasury);

        vm.expectRevert(CascadeStaker.ZeroAddress.selector);
        new CascadeStaker(IERC20Permit(address(0)), tao, fd, owner, treasury);
        vm.expectRevert(CascadeStaker.ZeroAddress.selector);
        new CascadeStaker(usdc, IERC20(address(0)), fd, owner, treasury);
        vm.expectRevert(CascadeStaker.ZeroAddress.selector);
        new CascadeStaker(usdc, tao, CascadeFrontDoor(payable(address(0))), owner, treasury);
        vm.expectRevert(CascadeStaker.ZeroAddress.selector);
        new CascadeStaker(usdc, tao, fd, owner, address(0));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new CascadeStaker(usdc, tao, fd, address(0), treasury);
        // tokens other than the front door's own
        MockTAO otherTao = new MockTAO(18);
        MockUSDC otherUsdc = new MockUSDC();
        vm.expectRevert(CascadeStaker.TokenMismatch.selector);
        new CascadeStaker(usdc, otherTao, fd, owner, treasury);
        vm.expectRevert(CascadeStaker.TokenMismatch.selector);
        new CascadeStaker(otherUsdc, tao, fd, owner, treasury);

        address newTreasury = makeAddr("newTreasury");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        staker.setTreasury(newTreasury);
        vm.startPrank(owner);
        vm.expectRevert(CascadeStaker.ZeroAddress.selector);
        staker.setTreasury(address(0));
        vm.expectEmit(address(staker));
        emit CascadeStaker.TreasurySet(newTreasury);
        staker.setTreasury(newTreasury);
        assertEq(staker.treasury(), newTreasury);

        vm.expectEmit(address(staker));
        emit CascadeStaker.DeliveryRouteSet(0);
        staker.setDeliveryRoute(0);

        vm.expectRevert(CascadeStaker.RenounceDisabled.selector);
        staker.renounceOwnership();
        vm.stopPrank();
        assertEq(staker.owner(), owner);
    }
}
