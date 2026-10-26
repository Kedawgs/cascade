// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {CascadeTwapOracle} from "../../src/CascadeTwapOracle.sol";
import {MockUniswapPool} from "../mocks/MockUniswapPool.sol";

/// @notice The TWAP oracle over two mock pools laid out like the live Base pools: the real token
/// addresses, so WETH sorts first in both (TAO/WETH: token0 WETH, token1 TAO; WETH/USDC: token0 WETH,
/// token1 USDC).
contract TwapOracleTest is Test {
    address constant TAO = 0xf3081494B87e8D5fb7960f066E931D1D0e6E3d67;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    /// `slot0` ticks of the live pools on 2026-10-26.
    int24 constant LIVE_TAO_WETH_TICK = 22227;
    int24 constant LIVE_WETH_USDC_TICK = -198877;

    MockUniswapPool taoWeth;
    MockUniswapPool wethUsdc;
    CascadeTwapOracle oracle;

    function setUp() public {
        taoWeth = new MockUniswapPool(WETH, TAO);
        wethUsdc = new MockUniswapPool(WETH, USDC);
        oracle = new CascadeTwapOracle(address(taoWeth), address(wethUsdc), TAO, WETH, USDC);
    }

    function test_constructorKeepsPoolsAndTokens() public view {
        assertEq(oracle.TWAP_WINDOW(), 1800);
        assertEq(oracle.taoWethPool(), address(taoWeth));
        assertEq(oracle.wethUsdcPool(), address(wethUsdc));
        assertEq(oracle.tao(), TAO);
        assertEq(oracle.weth(), WETH);
        assertEq(oracle.usdc(), USDC);
    }

    function test_valueAtTickZeroIsOneToOneScaled() public view {
        // tick 0 is a 1:1 price in raw units: 1e18 TAO wei -> 1e18 WETH wei -> 1e18 USDC units
        assertEq(oracle.usdcValue(1e18), 1e18);
        assertEq(oracle.usdcValue(0), 0);
    }

    function test_valueMatchesSpotForStableTicks() public {
        taoWeth.setTick(LIVE_TAO_WETH_TICK);
        wethUsdc.setTick(LIVE_WETH_USDC_TICK);
        uint256 value = oracle.usdcValue(1e18);
        emit log_named_decimal_uint("1 TAO in USDC", value, 6);
        assertGe(value, 240e6);
        assertLe(value, 265e6);
    }

    /// Both pools at the same tick: TAO -> WETH divides by the price (TAO is token1), WETH -> USDC multiplies
    /// by it (WETH is token0), so the value comes back to the amount. Covers both quote branches: a sqrt
    /// ratio that fits in 128 bits (|tick| 22227) and one that doesn't (|tick| 500000 > 443636). Amounts keep
    /// the WETH leg under 2^128 (above it the value reverts, see below).
    function test_sameTickOnBothPoolsRoundTrips() public {
        int24[4] memory ticks = [int24(22227), -22227, 500000, -500000];
        uint256[4] memory amounts = [uint256(1e18), 1e18, 1e30, 1e16];
        for (uint256 i; i < ticks.length; ++i) {
            taoWeth.setTick(ticks[i]);
            wethUsdc.setTick(ticks[i]);
            // within 1e-8: at tick 500000 the WETH leg is ~1.9e8 wei, so flooring it costs up to ~5e-9
            assertApproxEqRel(oracle.usdcValue(amounts[i]), amounts[i], 1e10);
        }
    }

    /// Review Focus 5: a pool whose history doesn't reach 30 minutes makes the value revert, never
    /// fall back to a shorter window; exactly 30 minutes of history is enough.
    function test_oldHistoryReverts() public {
        taoWeth.setTick(LIVE_TAO_WETH_TICK);
        wethUsdc.setTick(LIVE_WETH_USDC_TICK);

        taoWeth.setHistory(1799);
        vm.expectRevert(bytes("OLD"));
        oracle.usdcValue(1e18);

        taoWeth.setHistory(1800);
        wethUsdc.setHistory(1799);
        vm.expectRevert(bytes("OLD"));
        oracle.usdcValue(1e18);

        wethUsdc.setHistory(1800);
        assertGt(oracle.usdcValue(1e18), 0);
    }

    function test_wrongPoolTokensRejected() public {
        MockUniswapPool wethTao = new MockUniswapPool(TAO, WETH); // the right pair, unsorted

        // the TAO/WETH slot given the WETH/USDC pool
        vm.expectRevert(abi.encodeWithSelector(CascadeTwapOracle.BadPool.selector, address(wethUsdc)));
        new CascadeTwapOracle(address(wethUsdc), address(wethUsdc), TAO, WETH, USDC);

        // the WETH/USDC slot given the TAO/WETH pool
        vm.expectRevert(abi.encodeWithSelector(CascadeTwapOracle.BadPool.selector, address(taoWeth)));
        new CascadeTwapOracle(address(taoWeth), address(taoWeth), TAO, WETH, USDC);

        // the two pools swapped
        vm.expectRevert(abi.encodeWithSelector(CascadeTwapOracle.BadPool.selector, address(wethUsdc)));
        new CascadeTwapOracle(address(wethUsdc), address(taoWeth), TAO, WETH, USDC);

        // tokens in the wrong order: the quote direction depends on token0 < token1
        vm.expectRevert(abi.encodeWithSelector(CascadeTwapOracle.BadPool.selector, address(wethTao)));
        new CascadeTwapOracle(address(wethTao), address(wethUsdc), TAO, WETH, USDC);

        // a token that is not the expected one
        wethUsdc.setTokens(WETH, address(0xBEEF));
        vm.expectRevert(abi.encodeWithSelector(CascadeTwapOracle.BadPool.selector, address(wethUsdc)));
        new CascadeTwapOracle(address(taoWeth), address(wethUsdc), TAO, WETH, USDC);
    }

    /// OracleLibrary's `consult`: the mean tick rounds toward negative infinity, not toward zero.
    function test_meanTickRoundsTowardNegativeInfinity() public {
        taoWeth.setTick(-1);
        uint256 atMinusOne = oracle.usdcValue(1e18);
        taoWeth.setTick(0);
        uint256 atZero = oracle.usdcValue(1e18);
        assertTrue(atMinusOne != atZero);

        // cumulative delta -1 over 1800 s: -0.0006 rounds down to -1 (truncation would give 0)
        taoWeth.setSpike(-1, 1);
        assertEq(oracle.usdcValue(1e18), atMinusOne);

        // cumulative delta +1 over 1800 s: +0.0006 rounds down to 0
        taoWeth.setSpike(1, 1);
        assertEq(oracle.usdcValue(1e18), atZero);
    }

    /// A spot price pushed far off for one Base block moves the 30-minute value by a sliver of the push.
    function test_shortSpotSpikeBarelyMovesTheValue() public {
        taoWeth.setTick(LIVE_TAO_WETH_TICK);
        wethUsdc.setTick(LIVE_WETH_USDC_TICK);
        uint256 steady = oracle.usdcValue(1e18);

        // TAO 100x cheaper (+46055 ticks) for the last 2 seconds: the mean moves 51 ticks, about 0.5%
        taoWeth.setSpike(LIVE_TAO_WETH_TICK + 46055, 2);
        uint256 spiked = oracle.usdcValue(1e18);
        emit log_named_decimal_uint("steady", steady, 6);
        emit log_named_decimal_uint("after a 2 s 100x spike", spiked, 6);
        assertLt(spiked, steady);
        assertGe(spiked, steady * 99 / 100);
    }

    function test_amountAboveUint128Reverts() public {
        uint256 tooMuch = uint256(type(uint128).max) + 1;
        vm.expectRevert(abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, 128, tooMuch));
        oracle.usdcValue(tooMuch);
    }
}
