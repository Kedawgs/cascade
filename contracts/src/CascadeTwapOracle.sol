// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.38;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ICascadeTwap} from "./interfaces/ICascadeTwap.sol";
import {FullMath} from "./vendor/uniswap/FullMath.sol";
import {TickMath} from "./vendor/uniswap/TickMath.sol";

/// The parts of a Uniswap v3 pool the oracle reads.
interface IUniswapV3PoolOracle {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

/// @notice The 30-minute time-weighted value of TAO in USDC on Base, read from two Uniswap v3 pools:
/// TAO -> WETH on the TAO/WETH pool, then WETH -> USDC on the WETH/USDC pool, each at its arithmetic mean
/// tick over the last `TWAP_WINDOW` seconds, and back (`taoValue`); and each pool's depth over the same
/// window, its harmonic-mean in-range liquidity (`meanLiquidity`). A price pushed off for a few blocks moves
/// the value only by its share of the window. When a pool's observations don't reach back the full window the
/// pool's `observe` reverts ("OLD") and so does every view: none answers from a shorter window. There is no
/// age gate: a quiet pool's last trade stands for the window. The constructor refuses a pool with fewer than
/// `MIN_CARDINALITY` observation slots in use, too few to reach back the window when it trades every second.
/// @dev Nothing to own or change: the pools and tokens are immutable. `_meanTick`, `_meanLiquidity` and
/// `_quoteAtTick` are Uniswap v3-periphery `OracleLibrary.consult` (its tick and its liquidity parts) and
/// `OracleLibrary.getQuoteAtTick` (0.8 branch, GPL-2.0-or-later), hence this file's license.
contract CascadeTwapOracle is ICascadeTwap {
    uint32 public constant TWAP_WINDOW = 1800;
    /// The observation slots in use (`slot0`'s `observationCardinality`, not the slots requested) each pool
    /// must hold at deploy: one per second over the window, plus one (`TWAP_WINDOW + 1`, 1,801), so a pool that
    /// trades every second still keeps an observation from before the window. Uniswap writes at most one
    /// observation per block timestamp (`Oracle.write` returns early when the last one has this timestamp), and
    /// block timestamps are whole seconds, so at any block time of a second or less no pool writes more than one
    /// a second (Revision 28: Base went from 2-second to 0.2-second blocks at block 53,556,128, on 2026-11-05, and
    /// five of its blocks share each timestamp). Too few, and a trader swapping dust every second overwrites the
    /// window's history and every view reverts "OLD" (stakes and deliveries wait; claims work): the 901 before
    /// assumed one observation per 2-second block, so it covered 15 minutes at today's speed.
    // casting to 'uint16' is safe because TWAP_WINDOW + 1 is 1,801
    // forge-lint: disable-next-line(unsafe-typecast)
    uint16 public constant MIN_CARDINALITY = uint16(TWAP_WINDOW + 1);

    address public immutable taoWethPool;
    address public immutable wethUsdcPool;
    address public immutable tao;
    address public immutable weth;
    address public immutable usdc;

    /// `pool`'s tokens are not the expected pair in Uniswap's order (token0 the lower address).
    error BadPool(address pool);
    /// `pool` has `cardinality` observation slots in use, fewer than `MIN_CARDINALITY`.
    error TooFewObservations(address pool, uint16 cardinality);

    constructor(address taoWethPool_, address wethUsdcPool_, address tao_, address weth_, address usdc_) {
        _checkPool(taoWethPool_, tao_, weth_);
        _checkPool(wethUsdcPool_, weth_, usdc_);
        taoWethPool = taoWethPool_;
        wethUsdcPool = wethUsdcPool_;
        tao = tao_;
        weth = weth_;
        usdc = usdc_;
    }

    /// @inheritdoc ICascadeTwap
    /// @dev Both hops round down. Reverts for `taoWei` (or the WETH it is worth) above 2^128 - 1.
    function usdcValue(uint256 taoWei) external view returns (uint256 usdcUnits) {
        uint256 wethWei = _quoteAtTick(_meanTick(taoWethPool), SafeCast.toUint128(taoWei), tao, weth);
        usdcUnits = _quoteAtTick(_meanTick(wethUsdcPool), SafeCast.toUint128(wethWei), weth, usdc);
    }

    /// @inheritdoc ICascadeTwap
    /// @dev USDC -> WETH at the WETH/USDC mean tick, then WETH -> TAO at the TAO/WETH mean tick, on
    /// `usdcValue`'s path. Both hops round down, so the value is a floor, under the exact inverse by less than
    /// the TAO/WETH price (TAO wei per WETH wei) plus one wei. Reverts for `usdcUnits` (or the WETH it is worth)
    /// above 2^128 - 1.
    function taoValue(uint256 usdcUnits) external view returns (uint256 taoWei) {
        uint256 wethWei = _quoteAtTick(_meanTick(wethUsdcPool), SafeCast.toUint128(usdcUnits), usdc, weth);
        taoWei = _quoteAtTick(_meanTick(taoWethPool), SafeCast.toUint128(wethWei), weth, tao);
    }

    /// @inheritdoc ICascadeTwap
    /// @dev Each rounded down. A thin stretch weighs on a harmonic mean as it does on the cost of moving the
    /// price: one second of an empty range in the window reads at most 1,800.
    function meanLiquidity() external view returns (uint128 taoWeth, uint128 wethUsdc) {
        taoWeth = _meanLiquidity(taoWethPool);
        wethUsdc = _meanLiquidity(wethUsdcPool);
    }

    /// The pool must hold exactly `a` and `b`, sorted as Uniswap sorts them (`_quoteAtTick` reads the
    /// direction of the price from the token order), and at least `MIN_CARDINALITY` observation slots in use.
    function _checkPool(address pool, address a, address b) private view {
        (address lo, address hi) = a < b ? (a, b) : (b, a);
        if (IUniswapV3PoolOracle(pool).token0() != lo || IUniswapV3PoolOracle(pool).token1() != hi) {
            revert BadPool(pool);
        }
        (,,, uint16 cardinality,,,) = IUniswapV3PoolOracle(pool).slot0();
        if (cardinality < MIN_CARDINALITY) revert TooFewObservations(pool, cardinality);
    }

    /// `pool`'s cumulatives `TWAP_WINDOW` seconds ago and now. The pool reverts "OLD" when its history is
    /// shorter.
    function _observe(address pool)
        private
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = TWAP_WINDOW;
        secondsAgos[1] = 0;
        return IUniswapV3PoolOracle(pool).observe(secondsAgos);
    }

    /// The arithmetic mean tick of `pool` over the last `TWAP_WINDOW` seconds, rounded toward negative
    /// infinity (`OracleLibrary.consult`).
    function _meanTick(address pool) private view returns (int24 meanTick) {
        (int56[] memory tickCumulatives,) = _observe(pool);

        int56 delta = tickCumulatives[1] - tickCumulatives[0];
        int56 window = int56(uint56(TWAP_WINDOW));
        // a real pool's mean tick always fits; anything else reverts here (or in TickMath) instead of wrapping
        meanTick = SafeCast.toInt24(delta / window);
        // always round to negative infinity
        if (delta < 0 && (delta % window != 0)) meanTick--;
    }

    /// The harmonic-mean in-range liquidity of `pool` over the last `TWAP_WINDOW` seconds, rounded down
    /// (`OracleLibrary.consult`): the window over the growth of the pool's seconds-per-liquidity cumulative,
    /// which adds 2^128 / liquidity each second (2^128 while the range is empty). Each second adds at least 1, so
    /// a real pool's growth over the window is at least `TWAP_WINDOW`, and the product below, not a shift, keeps
    /// the mean within 2^128 - 1. A reading no pool gives is refused, not answered: no growth divides by zero
    /// (Panic 0x12, as in the library), and a mean above 2^128 - 1 reverts in `SafeCast` where the library's cast
    /// would wrap it. The difference is checked, as in the library's 0.8 branch and as the tick's is: the pool's
    /// cumulative wraps only after 2^32 seconds of an empty range.
    function _meanLiquidity(address pool) private view returns (uint128) {
        (, uint160[] memory secondsPerLiquidityCumulativeX128s) = _observe(pool);
        uint160 growth = secondsPerLiquidityCumulativeX128s[1] - secondsPerLiquidityCumulativeX128s[0];
        uint192 windowX160 = uint192(TWAP_WINDOW) * type(uint160).max;
        return SafeCast.toUint128(windowX160 / (uint192(growth) << 32));
    }

    /// The `quoteToken` amount `baseAmount` of `baseToken` is worth at `tick` (`OracleLibrary.getQuoteAtTick`).
    function _quoteAtTick(int24 tick, uint128 baseAmount, address baseToken, address quoteToken)
        private
        pure
        returns (uint256 quoteAmount)
    {
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tick);

        // better precision when the ratio squared fits in 256 bits
        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            quoteAmount = baseToken < quoteToken
                ? FullMath.mulDiv(ratioX192, baseAmount, 1 << 192)
                : FullMath.mulDiv(1 << 192, baseAmount, ratioX192);
        } else {
            uint256 ratioX128 = FullMath.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
            quoteAmount = baseToken < quoteToken
                ? FullMath.mulDiv(ratioX128, baseAmount, 1 << 128)
                : FullMath.mulDiv(1 << 128, baseAmount, ratioX128);
        }
    }
}
