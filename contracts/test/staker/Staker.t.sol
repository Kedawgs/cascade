// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeStaker} from "../../src/CascadeStaker.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {ICascadeTwap} from "../../src/interfaces/ICascadeTwap.sol";
import {ISlipstreamRouter} from "../../src/interfaces/ISlipstreamRouter.sol";
import {IUniswapV3Router02} from "../../src/interfaces/IUniswapV3Router02.sol";
import {MockSwapRouter} from "../mocks/MockSwapRouter.sol";
import {MockTAO} from "../mocks/MockTAO.sol";
import {MockTwap} from "../mocks/MockTwap.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {FrontDoorTestBase} from "../FrontDoorTestBase.sol";
import {Schedule} from "../governance/Schedule.sol";
import {defaultStakerParams} from "../utils/DefaultParams.sol";

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
/// 4,000 TAO batch value) whose oracle, from its constructor, is a mock TWAP at 250 USDC per TAO (so the
/// staker's buy floor is 95% of 4e9 TAO wei per USDC unit swapped), and a mock router that buys at
/// 4,000,000,001 TAO wei per USDC unit (about $250/TAO, just above the TWAP's value, leaving sub-rao dust) and
/// sells at 250 USDC per TAO. Route 0 is the Uniswap two-hop USDC -0.05%-> WETH -0.3%-> TAO, also the delivery
/// route; fees 15 bps and 50_000 ($0.05); all three from the staker's constructor (defaultStakerParams).
contract StakerTest is FrontDoorTestBase {
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    uint256 constant BUY_PER_UNIT = 4_000_000_001;
    uint256 constant SELL_RATE = 250e6;
    uint16 constant SWAP_FEE = 15;
    uint256 constant DEPOSIT_FEE = 50_000;
    uint256 constant RAO = 1e9;

    uint256 constant USDC_IN = 1_000e6;
    /// 0.15% of 1_000e6 - 50_000 = 999_950_000, rounded down
    uint256 constant SWAP_FEE_AMOUNT = 1_499_925;
    uint256 constant FEES = 1_549_925;
    uint256 constant TO_ROUTER = 998_450_075;
    uint256 constant TAO_OUT = 3_993_800_300_998_450_075;
    uint256 constant DEPOSITED = 3_993_800_300_000_000_000;
    uint256 constant DUST = 998_450_075;
    uint256 constant MIN_TAO = 3.9e18;
    /// The order tripwires' revert data (tripThePull, tripTheSwap).
    bytes usdcMoved = abi.encodeWithSignature("Error(string)", "the USDC moved");
    bytes swapRan = abi.encodeWithSignature("Error(string)", "the swap ran");

    address treasury = makeAddr("treasury");
    address weth = makeAddr("weth");

    CascadeStaker staker;
    MockSwapRouter router;
    /// The front door's oracle (its constructor's): 250 USDC per TAO until a test sets it.
    MockTwap twap;
    bytes buyPath;
    bytes sellPath;

    function setUp() public override {
        super.setUp();
        router = new MockSwapRouter();
        router.setRate(address(usdc), BUY_PER_UNIT * 1e18);
        router.setRate(address(tao), SELL_RATE);
        buyPath = abi.encodePacked(address(usdc), uint24(500), weth, uint24(3000), address(tao));
        sellPath = abi.encodePacked(address(tao), uint24(3000), weth, uint24(500), address(usdc));
        staker = new CascadeStaker(stakerParams());
    }

    function beforeFrontDoor() internal override {
        twap = new MockTwap(250e6);
    }

    function frontDoorParams() internal view override returns (CascadeFrontDoor.Params memory p) {
        p = super.frontDoorParams();
        p.oracle = twap;
    }

    // ---- helpers ----

    /// The fixture staker's constructor arguments: route 0 through `router` along the two-hop paths, also the
    /// delivery route, and fees 15 bps and 50_000.
    function stakerParams() internal view returns (CascadeStaker.Params memory) {
        return defaultStakerParams(usdc, tao, fd, owner, treasury, address(router), buyPath, sellPath);
    }

    /// Makes the router pay exactly `taoOut` TAO wei for `usdcSwapped` USDC units: the rate ceil(taoOut * 1e18 /
    /// usdcSwapped) pays floor(usdcSwapped * rate / 1e18), which is taoOut for any usdcSwapped up to 1e18.
    function payExactly(uint256 usdcSwapped, uint256 taoOut) internal {
        uint256 rate = Math.ceilDiv(taoOut * 1e18, usdcSwapped);
        router.setRate(address(usdc), rate);
        assertEq(usdcSwapped * rate / 1e18, taoOut, "the router pays exactly taoOut");
    }

    /// The staker's fees on a stake of `usdcIn` at the fixture's fees: the deposit fee, then the swap fee on the rest.
    function feesOn(uint256 usdcIn) internal pure returns (uint256) {
        return DEPOSIT_FEE + (usdcIn - DEPOSIT_FEE) * SWAP_FEE / 10_000;
    }

    /// The order tripwires (Task 33's review, M1): alice's USDC pull into the staker, the first token a stake moves,
    /// mocked to revert "the USDC moved"; and every swap through the router mocked to revert "the swap ran". A refusal
    /// that still comes first was decided before that step.
    function tripThePull() internal {
        vm.mockCallRevert(
            address(usdc), abi.encodeCall(usdc.transferFrom, (alice, address(staker), USDC_IN)), usdcMoved
        );
    }

    function tripTheSwap() internal {
        vm.mockCallRevert(address(router), abi.encodeWithSelector(IUniswapV3Router02.exactInput.selector), swapRan);
    }

    /// The buy floor as I-31 states it, written apart from the contract's expression: the oracle's value of the USDC
    /// swapped, times 95%, rounded down.
    function floorOf(uint256 usdcSwapped) internal view returns (uint256) {
        return twap.taoValue(usdcSwapped) * 95 / 100;
    }

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
        return staker.stake(beneficiary, usdcIn, MIN_TAO, routeId, vm.getBlockTimestamp());
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
        staker.stake(carol, 50_000, 0, 0, vm.getBlockTimestamp());
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
        uint256 permitDeadline = vm.getBlockTimestamp() + 1 hours;

        // a valid permit stakes
        (uint8 v, bytes32 r, bytes32 s) = signPermit(key, payer, USDC_IN, 0, permitDeadline);
        vm.expectEmit(address(staker));
        emit CascadeStaker.Staked(payer, payer, USDC_IN, FEES, DEPOSITED);
        vm.prank(payer);
        uint256 got =
            staker.stakeWithPermit(payer, USDC_IN, MIN_TAO, 0, vm.getBlockTimestamp(), permitDeadline, v, r, s);
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
        staker.stakeWithPermit(payer, USDC_IN, MIN_TAO, 0, vm.getBlockTimestamp(), permitDeadline, v, r, s);
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
        staker.stakeWithPermit(payer, USDC_IN, MIN_TAO, 0, vm.getBlockTimestamp(), permitDeadline, v, r, s);
        // ... nor with a smaller allowance already in place, which is never exceeded
        vm.prank(payer);
        usdc.approve(address(staker), 500e6);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(staker), 500e6, USDC_IN)
        );
        vm.prank(payer);
        staker.stakeWithPermit(payer, USDC_IN, MIN_TAO, 0, vm.getBlockTimestamp(), permitDeadline, v, r, s);
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
        staker.stakeWithPermit(payer, USDC_IN, MIN_TAO, 0, vm.getBlockTimestamp(), permitDeadline, v, r, s);
        assertEq(usdc.balanceOf(payer), 1_000e6);

        // ... and stakes when an approve (the fallback for wallets whose permits fail) is in place,
        // pulling exactly usdcIn out of a larger allowance
        vm.prank(payer);
        usdc.approve(address(staker), 5_000e6);
        vm.prank(payer);
        staker.stakeWithPermit(payer, USDC_IN, MIN_TAO, 0, vm.getBlockTimestamp(), permitDeadline, v, r, s);
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
        (uint8 v, bytes32 r, bytes32 s) = signPermit(key, payer, USDC_IN, 0, vm.getBlockTimestamp());
        vm.expectRevert(CascadeStaker.BadBeneficiary.selector);
        vm.prank(payer);
        staker.stakeWithPermit(
            address(fd), USDC_IN, MIN_TAO, 0, vm.getBlockTimestamp(), vm.getBlockTimestamp(), v, r, s
        );

        assertEq(usdc.balanceOf(alice), USDC_IN);
        assertEq(usdc.balanceOf(payer), USDC_IN);
        assertEq(usdc.nonces(payer), 0);
        assertEq(totalOpenDeposits(), 0);
        assertEq(router.calls(), 0);
    }

    function test_expiredDeadline() public {
        fund(alice, USDC_IN);
        uint256 deadline = vm.getBlockTimestamp();
        vm.warp(deadline + 1);
        vm.expectRevert(CascadeStaker.Expired.selector);
        vm.prank(alice);
        staker.stake(alice, USDC_IN, MIN_TAO, 0, deadline);

        // the deadline itself is still in time
        vm.prank(alice);
        staker.stake(alice, USDC_IN, MIN_TAO, 0, vm.getBlockTimestamp());
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

        // the front door's minimum (the batch value back up is a loosening: through the scheduler, Task 11)
        Schedule.run(fd, owner, abi.encodeCall(fd.setMaxBatchValue, (4_000e18)));
        vm.prank(owner);
        fd.setCaps(5e18, 10_000e18);
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

    // ---- the buy floor (spec §3.7, I-31; Task 33) ----

    /// A route paying 6% under the oracle's value of the USDC swapped is refused BelowOracleFloor though it pays the
    /// caller's own minimum (or with none at all), by `stake` and by `stakeWithPermit`, with nothing moved.
    function test_sixPercentShortReverts() public {
        assertEq(staker.MAX_BUY_SLIPPAGE_BPS(), 500);
        // 998_450_075 USDC units swapped at 4e9 TAO wei each; the floor 95% of it
        uint256 value = twap.taoValue(TO_ROUTER);
        assertEq(value, 3_993_800_300e9);
        assertEq(floorOf(TO_ROUTER), 3_794_110_285e9);
        uint256 paid = value * 94 / 100;
        assertEq(paid, 3_754_172_282e9);
        payExactly(TO_ROUTER, paid);
        fund(alice, USDC_IN);

        // a minimum the route meets (the router's own check passes), and none at all
        uint256[2] memory minimums = [paid, 0];
        for (uint256 i; i < minimums.length; ++i) {
            vm.expectRevert(CascadeStaker.BelowOracleFloor.selector);
            vm.prank(alice);
            staker.stake(alice, USDC_IN, minimums[i], 0, vm.getBlockTimestamp());
        }
        assertWholeStakeReverted();

        // the permit entry point: the permit is undone with the stake
        (address payer, uint256 key) = makeAddrAndKey("payer");
        usdc.mint(payer, USDC_IN);
        uint256 permitDeadline = vm.getBlockTimestamp() + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = signPermit(key, payer, USDC_IN, 0, permitDeadline);
        vm.expectRevert(CascadeStaker.BelowOracleFloor.selector);
        vm.prank(payer);
        staker.stakeWithPermit(payer, USDC_IN, paid, 0, vm.getBlockTimestamp(), permitDeadline, v, r, s);
        assertEq(usdc.balanceOf(payer), USDC_IN);
        assertEq(usdc.nonces(payer), 0);
        assertEq(fd.depositOf(payer), 0);
        assertClean(0);
    }

    /// A route paying 4% under the oracle's value clears the floor: `stake` and `stakeWithPermit` each deposit what
    /// it paid (here whole rao).
    function test_fourPercentShortStakes() public {
        uint256 paid = twap.taoValue(TO_ROUTER) * 96 / 100;
        assertEq(paid, 3_834_048_288e9);
        assertGt(paid, floorOf(TO_ROUTER));
        payExactly(TO_ROUTER, paid);
        uint256 minTaoOut = paid * 995 / 1000; // the site's quote less 0.5%
        fund(alice, USDC_IN);

        vm.expectEmit(address(staker));
        emit CascadeStaker.Staked(alice, alice, USDC_IN, FEES, paid);
        vm.prank(alice);
        assertEq(staker.stake(alice, USDC_IN, minTaoOut, 0, vm.getBlockTimestamp()), paid);
        assertEq(fd.depositOf(alice), paid);

        (address payer, uint256 key) = makeAddrAndKey("payer");
        usdc.mint(payer, USDC_IN);
        uint256 permitDeadline = vm.getBlockTimestamp() + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = signPermit(key, payer, USDC_IN, 0, permitDeadline);
        vm.prank(payer);
        assertEq(
            staker.stakeWithPermit(payer, USDC_IN, minTaoOut, 0, vm.getBlockTimestamp(), permitDeadline, v, r, s), paid
        );
        assertEq(fd.depositOf(payer), paid);
        assertEq(usdc.balanceOf(treasury), 2 * FEES);
        assertEq(totalOpenDeposits(), 2 * paid);
        assertClean(0);
    }

    /// The floor's boundary at every size (I-31): one wei under taoValue(usdcIn - fees) x 95%, rounded down (never
    /// above the exact 95%), reverts BelowOracleFloor; exactly at it the floor passes and the front door decides: it
    /// takes the deposit (the TAO floored to whole rao) or refuses it by its own limits, ZeroAmount when no whole rao
    /// is left, BelowMinDeposit under its 1 TAO minimum, CapExceeded above its cap (lowered here to its 4,000 TAO
    /// batch value, so that one refusal covers every deposit too large). First at the fixture's TWAP (250 USDC per
    /// TAO), where `usdcIn` from one unit above the deposit fee to $1M runs from tiny stakes the door's minimum refuses
    /// to deposits of up to 3,800 TAO; then at any TWAP price from 1 USDC unit a TAO to 1e30, which reaches prices at
    /// which the floor rounds to 0 (a value of 1 wei or none), where no payment is under the floor and only the front
    /// door refuses.
    function testFuzz_floorAtEverySize(uint256 usdcIn, uint256 usdcPerTao) public {
        usdcIn = bound(usdcIn, DEPOSIT_FEE + 1, 1_000_000e6);
        (uint256 minDeposit, uint256 batchValue) = (fd.minDeposit(), fd.maxBatchValue());
        vm.prank(owner);
        fd.setCaps(minDeposit, batchValue);
        fund(alice, usdcIn);
        uint256 untouched = vm.snapshotState();
        assertFloorBoundary(usdcIn);

        vm.revertToState(untouched);
        twap.setPrice(bound(usdcPerTao, 1, 1e30));
        assertFloorBoundary(usdcIn);
    }

    /// alice stakes `usdcIn` with no minimum of her own: one wei under the floor reverts BelowOracleFloor; exactly at
    /// it she gets the front door's own outcome for the floored amount.
    function assertFloorBoundary(uint256 usdcIn) internal {
        uint256 swapped = usdcIn - feesOn(usdcIn);
        uint256 value = twap.taoValue(swapped);
        uint256 atFloor = floorOf(swapped);
        // the largest whole wei at or under the exact 95% of the value
        assertLe(atFloor * 100, value * 95, "never above the exact 95%");
        assertGt((atFloor + 1) * 100, value * 95, "the largest such");
        if (atFloor > 0) {
            payExactly(swapped, atFloor - 1);
            vm.expectRevert(CascadeStaker.BelowOracleFloor.selector);
            vm.prank(alice);
            staker.stake(alice, usdcIn, 0, 0, vm.getBlockTimestamp());
        }

        payExactly(swapped, atFloor);
        uint256 amount = atFloor - atFloor % RAO;
        bytes4 refusal;
        if (amount == 0) refusal = CascadeFrontDoor.ZeroAmount.selector;
        else if (amount < fd.minDeposit()) refusal = CascadeFrontDoor.BelowMinDeposit.selector;
        else if (amount > fd.depositCap()) refusal = CascadeFrontDoor.CapExceeded.selector;
        if (refusal != bytes4(0)) {
            vm.expectRevert(refusal);
            vm.prank(alice);
            staker.stake(alice, usdcIn, 0, 0, vm.getBlockTimestamp());
            assertEq(usdc.balanceOf(alice), usdcIn, "nothing moved");
            assertEq(totalOpenDeposits(), 0, "no deposit");
        } else {
            vm.prank(alice);
            assertEq(staker.stake(alice, usdcIn, 0, 0, vm.getBlockTimestamp()), amount);
            assertEq(fd.depositOf(alice), amount, "the floored TAO deposited");
            assertEq(tao.balanceOf(address(staker)), atFloor % RAO, "the sub-rao dust stays");
            assertEq(usdc.balanceOf(treasury), usdcIn - swapped, "the fees");
        }
    }

    /// No oracle, no stake (I-31 fails closed): while the front door's oracle is the zero address (a scheduled
    /// `setOracle(0)`, which also stops deliveries) a stake reverts NoOracle, by either entry point, before any token
    /// moves, pinned by which revert wins: with the USDC pull and the swap each made to fail with its own error,
    /// NoOracle still comes first, and with the oracle back each tripwire fires. A non-zero oracle address with no
    /// code reverts with no data (the call's return data does not decode). There is no switch that skips the floor:
    /// staking resumes when an oracle is back.
    function test_zeroOracleRefusesStake() public {
        Schedule.run(fd, owner, abi.encodeCall(fd.setOracle, (ICascadeTwap(address(0)))));
        assertEq(address(fd.oracle()), address(0));
        fund(alice, USDC_IN);
        vm.expectRevert(CascadeStaker.NoOracle.selector);
        stakeAs(alice, alice, USDC_IN, 0);

        (address payer, uint256 key) = makeAddrAndKey("payer");
        usdc.mint(payer, USDC_IN);
        uint256 permitDeadline = vm.getBlockTimestamp() + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = signPermit(key, payer, USDC_IN, 0, permitDeadline);
        vm.expectRevert(CascadeStaker.NoOracle.selector);
        vm.prank(payer);
        staker.stakeWithPermit(payer, USDC_IN, MIN_TAO, 0, vm.getBlockTimestamp(), permitDeadline, v, r, s);
        assertEq(usdc.nonces(payer), 0);
        assertEq(usdc.balanceOf(payer), USDC_IN);
        assertWholeStakeReverted();

        // the pull and the swap both trip, then the swap alone: NoOracle comes first each time
        tripThePull();
        tripTheSwap();
        vm.expectRevert(CascadeStaker.NoOracle.selector);
        stakeAs(alice, alice, USDC_IN, 0);
        vm.clearMockedCalls();
        tripTheSwap();
        vm.expectRevert(CascadeStaker.NoOracle.selector);
        stakeAs(alice, alice, USDC_IN, 0);
        vm.clearMockedCalls();

        Schedule.run(fd, owner, abi.encodeCall(fd.setOracle, (ICascadeTwap(makeAddr("codeless oracle")))));
        vm.expectRevert(bytes(""));
        stakeAs(alice, alice, USDC_IN, 0);
        assertWholeStakeReverted();

        // an oracle back: each tripwire is live, the stake reaching the pull, then (the pull let through) the swap
        Schedule.run(fd, owner, abi.encodeCall(fd.setOracle, (twap)));
        tripThePull();
        tripTheSwap();
        vm.expectRevert(usdcMoved);
        stakeAs(alice, alice, USDC_IN, 0);
        vm.clearMockedCalls();
        tripTheSwap();
        vm.expectRevert(swapRan);
        stakeAs(alice, alice, USDC_IN, 0);
        vm.clearMockedCalls();
        assertWholeStakeReverted();
        assertEq(stakeAs(alice, alice, USDC_IN, 0), DEPOSITED);
    }

    /// An oracle that cannot answer (a pool whose history no longer reaches the window: "OLD") refuses the stake with
    /// its own reason, by either entry point, before any token moves, pinned by which revert wins: with the USDC pull
    /// and the swap each made to fail with its own error, "OLD" still comes first, and with the oracle answering each
    /// tripwire fires. Staking resumes when it answers.
    function test_revertingOracleRefusesStake() public {
        twap.setReverts(true);
        fund(alice, USDC_IN);
        vm.expectRevert(bytes("OLD"));
        stakeAs(alice, alice, USDC_IN, 0);

        (address payer, uint256 key) = makeAddrAndKey("payer");
        usdc.mint(payer, USDC_IN);
        uint256 permitDeadline = vm.getBlockTimestamp() + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = signPermit(key, payer, USDC_IN, 0, permitDeadline);
        vm.expectRevert(bytes("OLD"));
        vm.prank(payer);
        staker.stakeWithPermit(payer, USDC_IN, MIN_TAO, 0, vm.getBlockTimestamp(), permitDeadline, v, r, s);
        assertEq(usdc.nonces(payer), 0);
        assertEq(usdc.balanceOf(payer), USDC_IN);
        assertWholeStakeReverted();

        // the pull and the swap both trip: "OLD" comes first; the tripwire is live, as the answering oracle shows
        tripThePull();
        tripTheSwap();
        vm.expectRevert(bytes("OLD"));
        stakeAs(alice, alice, USDC_IN, 0);
        twap.setReverts(false);
        vm.expectRevert(usdcMoved);
        stakeAs(alice, alice, USDC_IN, 0);

        // the swap alone trips: "OLD" still comes first, and with the oracle answering the swap's own error does
        vm.clearMockedCalls();
        tripTheSwap();
        twap.setReverts(true);
        vm.expectRevert(bytes("OLD"));
        stakeAs(alice, alice, USDC_IN, 0);
        twap.setReverts(false);
        vm.expectRevert(swapRan);
        stakeAs(alice, alice, USDC_IN, 0);
        vm.clearMockedCalls();
        assertWholeStakeReverted();

        assertEq(stakeAs(alice, alice, USDC_IN, 0), DEPOSITED);
    }

    /// The buy floor is the stake's alone: `sellFor` never reads the oracle (the front door's delivery floor covers
    /// the sale), so it sells while the oracle cannot answer and while the front door has none.
    function test_sellForReadsNoBuyFloor() public {
        twap.setReverts(true);
        sendTaoFromFrontDoor(10e18);
        vm.expectCall(address(twap), abi.encodeWithSelector(ICascadeTwap.taoValue.selector), 0);
        vm.prank(address(fd));
        assertEq(staker.sellFor(10e18, alice, 0), 2_496_250_000);

        Schedule.run(fd, owner, abi.encodeCall(fd.setOracle, (ICascadeTwap(address(0)))));
        sendTaoFromFrontDoor(10e18);
        vm.prank(address(fd));
        assertEq(staker.sellFor(10e18, alice, 0), 2_496_250_000);
        assertEq(usdc.balanceOf(alice), 2 * 2_496_250_000);
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
        // the swapper is scheduled only (Task 11); the oracle is the fixture's, from the front door's constructor
        Schedule.run(fd, owner, abi.encodeCall(fd.setSwapper, (address(staker))));

        CascadeMessages.Entry[] memory e = new CascadeMessages.Entry[](1);
        e[0] = CascadeMessages.Entry(alice, 10e18);
        tao.mint(address(fd), 10e18);
        vm.prank(address(bridge));
        fd.onBridgeMessage(BITTENSOR, vault, CascadeMessages.encodePayouts(keccak256("batch-1"), 0, e), 10e18);
        vm.prank(alice);
        fd.setDelivery(240e6, uint64(vm.getBlockTimestamp() + 7 days), 6);

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
        uint256 deadline = vm.getBlockTimestamp() + 600;
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
        vm.warp(vm.getBlockTimestamp() + 1 days);
        sendTaoFromFrontDoor(10e18);
        vm.prank(address(fd));
        staker.sellFor(10e18, alice, 0);
        assertEq(uint8(router.lastKind()), uint8(MockSwapRouter.Kind.Slipstream));
        assertEq(router.lastDeadline(), vm.getBlockTimestamp());
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

    /// The constructor stores route 0, the delivery route and the fees, each checked as its setter checks it and
    /// logged as its setter logs it (after the treasury's TreasurySet), so a deploy needs no owner call before the
    /// first stake. Only route 0 exists then, so the delivery route can only be 0.
    function test_constructorSetsRouteAndFees() public {
        CascadeStaker.Params memory p = stakerParams();
        p.route0.kind = CascadeStaker.RouterKind.Slipstream;
        // the caps themselves are accepted
        p.swapFeeBps = 50;
        p.depositFeeUsdc = 250_000;
        address next = nextAddress();
        vm.expectEmit(next);
        emit CascadeStaker.TreasurySet(treasury);
        vm.expectEmit(next);
        emit CascadeStaker.RouteSet(0, CascadeStaker.RouterKind.Slipstream, address(router), buyPath, sellPath, true);
        vm.expectEmit(next);
        emit CascadeStaker.DeliveryRouteSet(0);
        vm.expectEmit(next);
        emit CascadeStaker.FeesSet(50, 250_000);
        CascadeStaker s = new CascadeStaker(p);
        assertEq(address(s), next);

        (
            CascadeStaker.RouterKind kind,
            address routerAddr,
            bytes memory storedBuy,
            bytes memory storedSell,
            bool active
        ) = s.routes(0);
        assertEq(uint8(kind), uint8(CascadeStaker.RouterKind.Slipstream));
        assertEq(routerAddr, address(router));
        assertEq(storedBuy, buyPath);
        assertEq(storedSell, sellPath);
        assertTrue(active);
        (, address router1,,, bool active1) = s.routes(1);
        assertEq(router1, address(0));
        assertFalse(active1);
        assertEq(s.deliveryRouteId(), 0);
        assertEq(s.swapFeeBps(), 50);
        assertEq(s.depositFeeUsdc(), 250_000);
        assertEq(s.treasury(), treasury);
        assertEq(s.owner(), owner);
        assertEq(s.pendingOwner(), address(0));

        // it stakes and sells at once, with no owner call first: at the caps 994_751_250 USDC units are swapped
        usdc.mint(alice, USDC_IN);
        vm.startPrank(alice);
        usdc.approve(address(s), USDC_IN);
        s.stake(alice, USDC_IN, MIN_TAO, 0, vm.getBlockTimestamp());
        vm.stopPrank();
        assertEq(uint8(router.lastKind()), uint8(MockSwapRouter.Kind.Slipstream));
        assertEq(fd.depositOf(alice), 994_751_250 * BUY_PER_UNIT / 1e9 * 1e9);
        tao.mint(address(s), 10e18);
        vm.prank(address(fd));
        // 2_500e6 less 0.5%
        assertEq(s.sellFor(10e18, alice, 0), 2_487_500_000);

        // what a setter refuses, the constructor refuses
        p = stakerParams();
        p.swapFeeBps = 51;
        vm.expectRevert(CascadeStaker.FeeTooHigh.selector);
        new CascadeStaker(p);
        p = stakerParams();
        p.depositFeeUsdc = 250_001;
        vm.expectRevert(CascadeStaker.FeeTooHigh.selector);
        new CascadeStaker(p);
        p = stakerParams();
        p.route0.router = address(0);
        vm.expectRevert(CascadeStaker.ZeroAddress.selector);
        new CascadeStaker(p);
        bytes[4] memory badBuys = [
            sellPath, // TAO -> USDC
            abi.encodePacked(address(usdc), uint24(500), weth), // ends at WETH
            abi.encodePacked(address(usdc), uint24(500), uint8(0), address(tao)), // 44 bytes
            bytes("")
        ];
        for (uint256 i; i < badBuys.length; ++i) {
            p = stakerParams();
            p.route0.buyPath = badBuys[i];
            vm.expectRevert(CascadeStaker.BadPath.selector);
            new CascadeStaker(p);
        }
        p = stakerParams();
        p.route0.sellPath = buyPath; // USDC -> TAO
        vm.expectRevert(CascadeStaker.BadPath.selector);
        new CascadeStaker(p);
        p = stakerParams();
        p.route0.sellPath = abi.encodePacked(weth, uint24(500), address(usdc)); // starts at WETH
        vm.expectRevert(CascadeStaker.BadPath.selector);
        new CascadeStaker(p);
        // the delivery route must be active: not an inactive route 0, nor an id that names no route yet
        p = stakerParams();
        p.route0.active = false;
        vm.expectRevert(CascadeStaker.RouteInactive.selector);
        new CascadeStaker(p);
        uint8[2] memory otherIds = [1, 255];
        for (uint256 i; i < otherIds.length; ++i) {
            p = stakerParams();
            p.deliveryRouteId = otherIds[i];
            vm.expectRevert(CascadeStaker.RouteInactive.selector);
            new CascadeStaker(p);
        }
    }

    function test_constructorAndAdmin() public {
        assertEq(address(staker.usdc()), address(usdc));
        assertEq(address(staker.tao()), address(tao));
        assertEq(address(staker.frontDoor()), address(fd));
        assertEq(staker.owner(), owner);
        assertEq(staker.treasury(), treasury);

        CascadeStaker.Params memory p = stakerParams();
        p.usdc = IERC20Permit(address(0));
        vm.expectRevert(CascadeStaker.ZeroAddress.selector);
        new CascadeStaker(p);
        p = stakerParams();
        p.tao = IERC20(address(0));
        vm.expectRevert(CascadeStaker.ZeroAddress.selector);
        new CascadeStaker(p);
        p = stakerParams();
        p.frontDoor = CascadeFrontDoor(payable(address(0)));
        vm.expectRevert(CascadeStaker.ZeroAddress.selector);
        new CascadeStaker(p);
        p = stakerParams();
        p.treasury = address(0);
        vm.expectRevert(CascadeStaker.ZeroAddress.selector);
        new CascadeStaker(p);
        p = stakerParams();
        p.owner = address(0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new CascadeStaker(p);
        // tokens other than the front door's own (checked before route 0's paths, which name the fixture's)
        p = stakerParams();
        p.tao = new MockTAO(18);
        vm.expectRevert(CascadeStaker.TokenMismatch.selector);
        new CascadeStaker(p);
        p = stakerParams();
        p.usdc = new MockUSDC();
        vm.expectRevert(CascadeStaker.TokenMismatch.selector);
        new CascadeStaker(p);

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
