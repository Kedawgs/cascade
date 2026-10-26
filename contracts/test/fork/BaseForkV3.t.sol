// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeStaker} from "../../src/CascadeStaker.sol";
import {CascadeTwapOracle, IUniswapV3PoolOracle} from "../../src/CascadeTwapOracle.sol";
import {IUniswapV3Router02} from "../../src/interfaces/IUniswapV3Router02.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {StubBridge} from "../mocks/StubBridge.sol";
import {ForkBase} from "./ForkBase.sol";

/// Uniswap v3 QuoterV2 (and Slipstream's Quoter, same selector): quotes by running the swap and
/// reverting, so it is not `view`.
interface IQuoterV2 {
    function quoteExactInput(bytes memory path, uint256 amountIn)
        external
        returns (
            uint256 amountOut,
            uint160[] memory sqrtPriceX96AfterList,
            uint32[] memory initializedTicksCrossedList,
            uint256 gasEstimate
        );
}

/// @notice Cascade v3 on a Base mainnet fork: the TWAP oracle over the live Uniswap TAO/WETH 0.3% and
/// WETH/USDC 0.05% pools, and the staker swapping through the live SwapRouter02 and Slipstream router
/// into a front door whose vault side is a stub bridge (payouts credited by pranking it), all at the
/// launch fees (0.15% swap fee, $0.05 deposit fee). Run with `FORK=1` (optionally `BASE_RPC=<url>`).
contract BaseForkV3Test is ForkBase {
    address constant BASE_WETH = 0x4200000000000000000000000000000000000006;
    address constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant TAO_WETH_POOL = 0x82dD34C6631C286cDD1dB16f2c232f60E402Dd5A;
    address constant WETH_USDC_POOL = 0xd0b53D9277642d899DF5C87A3966A349A798F224;
    address constant QUOTER_V2 = 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a;
    address constant SWAP_ROUTER_02 = 0x2626664c2603336E57B271c5C0b26F421741e481;
    /// Aerodrome Slipstream SwapRouter and Quoter bound to the factory of the TAO/USDC tickSpacing-100 pool.
    address constant SLIPSTREAM_ROUTER = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;
    address constant SLIPSTREAM_QUOTER = 0x514c8B5f54112481E28028F1166Bd78501089259;

    uint64 constant BITTENSOR = 964;
    uint32 constant BASE_DOMAIN = 6;
    uint256 constant RAO = 1e9;
    uint16 constant SWAP_FEE_BPS = 15;
    uint256 constant DEPOSIT_FEE = 50_000;

    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    address owner = makeAddr("v3 owner");
    address guardian = makeAddr("v3 guardian");
    address keeper = makeAddr("v3 keeper");
    address treasury = makeAddr("v3 treasury");
    address vaultAddr = makeAddr("v3 vault");

    IERC20 tao = IERC20(BASE_TAO);
    IERC20 usdc = IERC20(BASE_USDC);

    CascadeTwapOracle oracle;
    StubBridge bridge;
    CascadeFrontDoor fd;
    CascadeStaker staker;
    uint256 payoutCount;

    function setUp() public {
        forkFrom("BASE_RPC", "https://mainnet.base.org");
        if (!isFork()) return;
        emit log_named_uint("fork block", block.number);
        oracle = new CascadeTwapOracle(TAO_WETH_POOL, WETH_USDC_POOL, BASE_TAO, BASE_WETH, BASE_USDC);

        bridge = new StubBridge(tao);
        fd = new CascadeFrontDoor(
            IERC20Metadata(BASE_TAO),
            bridge,
            BITTENSOR,
            vaultAddr,
            owner,
            guardian,
            12 hours,
            0.01e18,
            10_000e18,
            1e14,
            usdc
        );
        staker = new CascadeStaker(IERC20Permit(BASE_USDC), tao, fd, owner, treasury);

        vm.startPrank(owner);
        staker.setRoute(
            0,
            CascadeStaker.Route(CascadeStaker.RouterKind.UniswapV3, SWAP_ROUTER_02, uniBuyPath(), uniSellPath(), true)
        );
        staker.setRoute(
            1,
            CascadeStaker.Route(
                CascadeStaker.RouterKind.Slipstream, SLIPSTREAM_ROUTER, slipBuyPath(), slipSellPath(), true
            )
        );
        staker.setDeliveryRoute(0);
        staker.setFees(SWAP_FEE_BPS, DEPOSIT_FEE);
        fd.setKeeper(keeper);
        fd.setSwapper(address(staker));
        fd.setOracle(oracle);
        vm.stopPrank();
    }

    // ---- helpers ----

    /// USDC -(0.05%)-> WETH -(0.3%)-> TAO
    function uniBuyPath() internal pure returns (bytes memory) {
        return abi.encodePacked(BASE_USDC, uint24(500), BASE_WETH, uint24(3000), BASE_TAO);
    }

    /// TAO -(0.3%)-> WETH -(0.05%)-> USDC
    function uniSellPath() internal pure returns (bytes memory) {
        return abi.encodePacked(BASE_TAO, uint24(3000), BASE_WETH, uint24(500), BASE_USDC);
    }

    /// USDC -(tickSpacing 100)-> TAO
    function slipBuyPath() internal pure returns (bytes memory) {
        return abi.encodePacked(BASE_USDC, int24(100), BASE_TAO);
    }

    function slipSellPath() internal pure returns (bytes memory) {
        return abi.encodePacked(BASE_TAO, int24(100), BASE_USDC);
    }

    function quote(address quoter, bytes memory path, uint256 amountIn) internal returns (uint256 amountOut) {
        (amountOut,,,) = IQuoterV2(quoter).quoteExactInput(path, amountIn);
    }

    /// The QuoterV2 sell quote for `taoWei` TAO along TAO -(0.3%)-> WETH -(0.05%)-> USDC.
    function quoteTaoToUsdc(uint256 taoWei) internal returns (uint256 usdcOut) {
        return quote(QUOTER_V2, uniSellPath(), taoWei);
    }

    /// The staker's fees on a stake of `usdcIn`: the deposit fee, then the swap fee on the rest.
    function stakeFees(uint256 usdcIn) internal pure returns (uint256) {
        return DEPOSIT_FEE + (usdcIn - DEPOSIT_FEE) * SWAP_FEE_BPS / 10_000;
    }

    /// The staker's swap fee on a delivery sell that returned `gross` USDC.
    function sellFee(uint256 gross) internal pure returns (uint256) {
        return gross * SWAP_FEE_BPS / 10_000;
    }

    /// The front door's market floor for `taoWei`: the oracle's 30-minute value less its slippage.
    function marketFloorOf(uint256 taoWei) internal view returns (uint256) {
        return oracle.usdcValue(taoWei) * (10_000 - fd.maxDeliverySlippageBps()) / 10_000;
    }

    /// A one-entry PAYOUTS chunk from (BITTENSOR, vault) through the stub bridge, tokens first.
    function payout(address user, uint256 amount) internal {
        CascadeMessages.Entry[] memory e = new CascadeMessages.Entry[](1);
        e[0] = CascadeMessages.Entry(user, amount);
        deal(BASE_TAO, address(fd), tao.balanceOf(address(fd)) + amount);
        bytes memory message = CascadeMessages.encodePayouts(keccak256(abi.encode("v3 batch", ++payoutCount)), 0, e);
        vm.prank(address(bridge));
        fd.onBridgeMessage(BITTENSOR, vaultAddr, message, amount);
        assertEq(fd.claimable(user), amount, "payout credited");
    }

    /// `user`'s delivery preference, live for a day, to Base.
    function prefer(address user, uint128 minUsdcPerTao) internal {
        vm.prank(user);
        fd.setDelivery(minUsdcPerTao, uint64(block.timestamp + 1 days), BASE_DOMAIN);
    }

    function signPermit(uint256 key, address holder, uint256 value, uint256 nonce, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IERC20Permit(BASE_USDC).DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, holder, address(staker), value, nonce, deadline))
            )
        );
        return vm.sign(key, digest);
    }

    /// A reverted delivery moved nothing: `user`'s `amount` TAO still credited and held by the front
    /// door, the preference intact, no USDC paid out or left behind, nothing in the staker.
    function assertClaimRestored(address user, uint256 amount, uint128 minUsdcPerTao) internal view {
        assertEq(fd.claimable(user), amount, "claim restored");
        assertEq(fd.totalClaimable(), amount, "total claimable restored");
        assertEq(tao.balanceOf(address(fd)), amount, "front door still holds the TAO");
        assertEq(tao.balanceOf(address(staker)), 0, "staker holds no TAO");
        assertEq(usdc.balanceOf(user), 0, "user paid nothing");
        assertEq(usdc.balanceOf(address(fd)), 0, "front door holds no USDC");
        assertEq(usdc.balanceOf(treasury), 0, "no fee taken");
        (uint128 m,,) = fd.deliveryOf(user);
        assertEq(m, minUsdcPerTao, "preference intact");
    }

    /// The staker holds no USDC, only `taoDust` sub-rao TAO, and leaves no allowance behind.
    function assertStakerClean(uint256 taoDust, address router) internal view {
        assertEq(usdc.balanceOf(address(staker)), 0, "staker usdc");
        assertEq(tao.balanceOf(address(staker)), taoDust, "staker tao dust");
        assertEq(usdc.allowance(address(staker), router), 0, "usdc allowance to router");
        assertEq(tao.allowance(address(staker), router), 0, "tao allowance to router");
        assertEq(tao.allowance(address(staker), address(fd)), 0, "tao allowance to front door");
    }

    function totalOpenDeposits() internal view returns (uint256 total) {
        (,, total,,,) = fd.openBatch();
    }

    // ---- oracle ----

    function test_fork_bothPoolsObserveThirtyMinutes() public onlyFork {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = 1800;
        secondsAgos[1] = 0;
        (int56[] memory taoWeth,) = IUniswapV3PoolOracle(TAO_WETH_POOL).observe(secondsAgos);
        (int56[] memory wethUsdc,) = IUniswapV3PoolOracle(WETH_USDC_POOL).observe(secondsAgos);
        assertEq(taoWeth.length, 2);
        assertEq(wethUsdc.length, 2);
        emit log_named_int("TAO/WETH 30-min mean tick", (taoWeth[1] - taoWeth[0]) / 1800);
        emit log_named_int("WETH/USDC 30-min mean tick", (wethUsdc[1] - wethUsdc[0]) / 1800);
    }

    function test_fork_oracleValueWithinThreePercentOfQuoterSpot() public onlyFork {
        uint256 twap = oracle.usdcValue(1e18);
        uint256 spot = quoteTaoToUsdc(1e18);
        emit log_named_decimal_uint("oracle: 1 TAO in USDC (30-min TWAP)", twap, 6);
        emit log_named_decimal_uint("QuoterV2: 1 TAO sell in USDC", spot, 6);
        assertApproxEqRel(twap, spot, 0.03e18);
    }

    // ---- staking ----

    /// A fresh key signs a real USDC permit; one `stakeWithPermit` call pulls the USDC, takes the fees,
    /// buys TAO through SwapRouter02 and deposits it into the front door.
    function test_fork_permitStakeThroughUniswap() public onlyFork {
        (address payer, uint256 key) = makeAddrAndKey("v3 permit payer");
        uint256 usdcIn = 100e6;
        deal(BASE_USDC, payer, usdcIn);
        assertEq(usdc.balanceOf(payer), usdcIn, "payer funded");

        // the domain the website signs with is real USDC's on Base
        assertEq(block.chainid, 8453, "Base");
        assertEq(
            IERC20Permit(BASE_USDC).DOMAIN_SEPARATOR(),
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("USD Coin"), keccak256("2"), uint256(8453), BASE_USDC)),
            "USDC permit domain: USD Coin / 2 / 8453"
        );
        uint256 nonce = IERC20Permit(BASE_USDC).nonces(payer);
        uint256 permitDeadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = signPermit(key, payer, usdcIn, nonce, permitDeadline);

        uint256 fees = stakeFees(usdcIn);
        uint256 taoQuote = quote(QUOTER_V2, uniBuyPath(), usdcIn - fees);
        uint256 minTaoOut = taoQuote * 99 / 100;
        emit log_named_decimal_uint("USDC in", usdcIn, 6);
        emit log_named_decimal_uint("fees to the treasury (USDC)", fees, 6);
        emit log_named_decimal_uint("QuoterV2: TAO for the USDC after fees", taoQuote, 18);
        emit log_named_decimal_uint("minTaoOut (quote x 0.99)", minTaoOut, 18);

        vm.prank(payer);
        uint256 deposited =
            staker.stakeWithPermit(payer, usdcIn, minTaoOut, 0, block.timestamp, permitDeadline, v, r, s);
        emit log_named_decimal_uint("TAO deposited", deposited, 18);

        assertEq(IERC20Permit(BASE_USDC).nonces(payer), nonce + 1, "the permit was used");
        assertEq(usdc.allowance(payer, address(staker)), 0, "allowance spent exactly");
        assertEq(usdc.balanceOf(payer), 0, "payer paid usdcIn");
        assertEq(usdc.balanceOf(treasury), fees, "treasury got the fees");
        assertGe(deposited, minTaoOut, "deposit >= quote x 0.99");
        assertEq(deposited, taoQuote - taoQuote % RAO, "the quoted swap, floored to whole rao");
        assertEq(fd.depositOf(payer), deposited, "payer's open deposit");
        assertEq(totalOpenDeposits(), deposited, "open batch total");
        assertEq(tao.balanceOf(address(fd)), deposited, "front door holds the TAO");
        assertStakerClean(taoQuote % RAO, SWAP_ROUTER_02);
    }

    /// Route 1: a $10 stake through Aerodrome's Slipstream router, path USDC -(tickSpacing 100)-> TAO.
    function test_fork_slipstreamRoute() public onlyFork {
        address payer = makeAddr("v3 slipstream payer");
        uint256 usdcIn = 10e6;
        deal(BASE_USDC, payer, usdcIn);

        uint256 fees = stakeFees(usdcIn);
        uint256 taoQuote = quote(SLIPSTREAM_QUOTER, slipBuyPath(), usdcIn - fees);
        uint256 minTaoOut = taoQuote * 99 / 100;
        emit log_named_decimal_uint("fees to the treasury (USDC)", fees, 6);
        emit log_named_decimal_uint("Slipstream quoter: TAO for the USDC after fees", taoQuote, 18);

        vm.startPrank(payer);
        usdc.approve(address(staker), usdcIn);
        uint256 deposited = staker.stake(payer, usdcIn, minTaoOut, 1, block.timestamp);
        vm.stopPrank();
        emit log_named_decimal_uint("TAO deposited", deposited, 18);

        assertGt(deposited, 0, "staked");
        assertGe(deposited, minTaoOut, "deposit >= quote x 0.99");
        assertEq(deposited, taoQuote - taoQuote % RAO, "the quoted swap, floored to whole rao");
        assertEq(usdc.balanceOf(payer), 0, "payer paid usdcIn");
        assertEq(usdc.balanceOf(treasury), fees, "treasury got the fees");
        assertEq(fd.depositOf(payer), deposited, "payer's open deposit");
        assertEq(tao.balanceOf(address(fd)), deposited, "front door holds the TAO");
        assertStakerClean(taoQuote % RAO, SLIPSTREAM_ROUTER);
    }

    // ---- delivery ----

    /// A 1-TAO payout sold through SwapRouter02 for the user. A keeper floor 5% above the quote can't be
    /// met: the router refuses ("Too little received", the staker passes the delivery's minimum on as
    /// the router's `amountOutMinimum`) and the whole delivery reverts with the claim intact. Then the
    /// same claim is delivered at the keeper's real floor and pays at least the largest floor.
    function test_fork_deliverThroughUniswapWithTwapFloor() public onlyFork {
        address user = makeAddr("v3 delivery user");
        payout(user, 1e18);
        uint256 sellQuote = quoteTaoToUsdc(1e18);
        uint128 pref = SafeCast.toUint128(sellQuote * 98 / 100);
        prefer(user, pref);

        uint256 twap = oracle.usdcValue(1e18);
        uint256 marketFloor = marketFloorOf(1e18);
        uint256 netQuote = sellQuote - sellFee(sellQuote);
        uint256 userFloor = pref; // 1 TAO at the user's per-TAO floor
        emit log_named_decimal_uint("QuoterV2: 1 TAO sell in USDC", sellQuote, 6);
        emit log_named_decimal_uint("quote less the 0.15% swap fee", netQuote, 6);
        emit log_named_decimal_uint("oracle: 1 TAO (30-min TWAP)", twap, 6);
        emit log_named_decimal_uint("market floor (TWAP less 1.5%)", marketFloor, 6);
        emit log_named_decimal_uint("user floor (quote x 0.98)", userFloor, 6);

        uint256 tooHigh = sellQuote * 105 / 100;
        vm.prank(keeper);
        vm.expectRevert(bytes("Too little received"));
        fd.deliver(user, tooHigh);
        assertClaimRestored(user, 1e18, pref);

        // the keeper's floor: the quote after the swap fee, less 0.5%
        uint256 keeperMinOut = netQuote * 995 / 1000;
        uint256 largest = Math.max(userFloor, Math.max(keeperMinOut, marketFloor));
        emit log_named_decimal_uint("keeper floor (net quote x 0.995)", keeperMinOut, 6);
        emit log_named_decimal_uint("largest floor", largest, 6);

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.Delivered(user, 1e18, netQuote);
        vm.prank(keeper);
        uint256 received = fd.deliver(user, keeperMinOut);
        emit log_named_decimal_uint("USDC delivered", received, 6);

        assertGe(received, largest, "paid at least the largest floor");
        assertEq(received, netQuote, "the quoted sell less the swap fee");
        assertEq(usdc.balanceOf(user), received, "user paid");
        assertEq(usdc.balanceOf(treasury), sellFee(sellQuote), "treasury got the swap fee");
        assertEq(usdc.balanceOf(address(fd)), 0, "front door forwarded everything");
        assertEq(fd.claimable(user), 0, "claim spent");
        assertEq(fd.totalClaimable(), 0, "total claimable");
        assertEq(tao.balanceOf(address(fd)), 0, "front door sold the TAO");
        assertStakerClean(0, SWAP_ROUTER_02);
        (uint128 m,,) = fd.deliveryOf(user);
        assertEq(m, pref, "preference survives the delivery");
    }

    /// An attacker dumps TAO into the TAO/WETH pool in the same block as a delivery whose user and keeper
    /// floors are negligible. Spot falls well below the TWAP floor but the 30-minute TWAP doesn't move,
    /// so the front door still asks for the TWAP floor, the router can't pay it and the delivery reverts
    /// with the claim intact. Without the dump the same delivery goes through above the TWAP floor.
    function test_fork_spotManipulationCannotBeatTwapFloor() public onlyFork {
        address user = makeAddr("v3 manipulated user");
        payout(user, 1e18);
        uint128 pref = 1e6; // 1 USDC per TAO: the user's floor never binds
        prefer(user, pref);

        uint256 twap = oracle.usdcValue(1e18);
        uint256 marketFloor = marketFloorOf(1e18);
        uint256 honestQuote = quoteTaoToUsdc(1e18);
        emit log_named_decimal_uint("oracle: 1 TAO (30-min TWAP)", twap, 6);
        emit log_named_decimal_uint("market floor (TWAP less 1.5%)", marketFloor, 6);
        emit log_named_decimal_uint("QuoterV2 before the dump: 1 TAO", honestQuote, 6);
        uint256 untouched = vm.snapshotState();

        // same block: half as much TAO as the TAO/WETH 0.3% pool holds is sold into it
        address attacker = makeAddr("v3 attacker");
        uint256 dump = tao.balanceOf(TAO_WETH_POOL) / 2;
        emit log_named_decimal_uint("TAO dumped (half the pool's TAO)", dump, 18);
        deal(BASE_TAO, attacker, dump);
        IUniswapV3Router02.ExactInputParams memory sell = IUniswapV3Router02.ExactInputParams({
            path: abi.encodePacked(BASE_TAO, uint24(3000), BASE_WETH),
            recipient: attacker,
            amountIn: dump,
            amountOutMinimum: 0
        });
        vm.startPrank(attacker);
        tao.approve(SWAP_ROUTER_02, dump);
        IUniswapV3Router02(SWAP_ROUTER_02).exactInput(sell);
        vm.stopPrank();

        uint256 dumpedQuote = quoteTaoToUsdc(1e18);
        emit log_named_decimal_uint("QuoterV2 after the dump: 1 TAO", dumpedQuote, 6);
        assertLt(dumpedQuote, marketFloor, "the dump pushed spot below the TWAP floor");
        assertEq(oracle.usdcValue(1e18), twap, "a same-block swap leaves the TWAP unchanged");

        // the staker is asked for exactly the TWAP floor (the user's and keeper's are lower)
        vm.expectCall(address(staker), abi.encodeCall(CascadeStaker.sellFor, (1e18, address(fd), marketFloor)));
        vm.prank(keeper);
        vm.expectRevert(bytes("Too little received"));
        fd.deliver(user, 0);
        assertClaimRestored(user, 1e18, pref);

        // no dump: the same delivery, same floors, succeeds
        vm.revertToState(untouched);
        assertEq(quoteTaoToUsdc(1e18), honestQuote, "back to the undisturbed pool");
        vm.prank(keeper);
        uint256 received = fd.deliver(user, 0);
        emit log_named_decimal_uint("USDC delivered without the dump", received, 6);
        assertGe(received, marketFloor, "at least the TWAP floor");
        assertEq(received, honestQuote - sellFee(honestQuote), "the honest quote less the swap fee");
        assertEq(usdc.balanceOf(user), received, "user paid");
        assertEq(fd.claimable(user), 0, "claim spent");
    }
}
