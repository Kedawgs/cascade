// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ICascadeTwap} from "./interfaces/ICascadeTwap.sol";
import {FullMath} from "./vendor/uniswap/FullMath.sol";
import {TickMath} from "./vendor/uniswap/TickMath.sol";

/// The parts of a Uniswap v3 pool the oracle reads.
interface IUniswapV3PoolOracle {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

/// @notice The 30-minute time-weighted value of TAO in USDC on Base, read from two Uniswap v3 pools:
/// TAO -> WETH on the TAO/WETH pool, then WETH -> USDC on the WETH/USDC pool, each at its arithmetic mean
/// tick over the last `TWAP_WINDOW` seconds. A price pushed off for a few blocks moves the value only by
/// its share of the window. When a pool's observations don't reach back the full window the pool's
/// `observe` reverts ("OLD") and so does `usdcValue`: it never answers from a shorter window.
/// @dev Nothing to own or change: the pools and tokens are immutable. `_meanTick` and `_quoteAtTick` are
/// Uniswap v3-periphery `OracleLibrary.consult` (its tick part) and `OracleLibrary.getQuoteAtTick`
/// (0.8 branch, GPL-2.0-or-later), hence this file's license.
contract CascadeTwapOracle is ICascadeTwap {
    uint32 public constant TWAP_WINDOW = 1800;

    address public immutable taoWethPool;
    address public immutable wethUsdcPool;
    address public immutable tao;
    address public immutable weth;
    address public immutable usdc;

    /// `pool`'s tokens are not the expected pair in Uniswap's order (token0 the lower address).
    error BadPool(address pool);

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

    /// The pool must hold exactly `a` and `b`, sorted as Uniswap sorts them: `_quoteAtTick` reads the
    /// direction of the price from the token order.
    function _checkPool(address pool, address a, address b) private view {
        (address lo, address hi) = a < b ? (a, b) : (b, a);
        if (IUniswapV3PoolOracle(pool).token0() != lo || IUniswapV3PoolOracle(pool).token1() != hi) {
            revert BadPool(pool);
        }
    }

    /// The arithmetic mean tick of `pool` over the last `TWAP_WINDOW` seconds, rounded toward negative
    /// infinity (`OracleLibrary.consult`). The pool reverts "OLD" when its history is shorter.
    function _meanTick(address pool) private view returns (int24 meanTick) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = TWAP_WINDOW;
        secondsAgos[1] = 0;
        (int56[] memory tickCumulatives,) = IUniswapV3PoolOracle(pool).observe(secondsAgos);

        int56 delta = tickCumulatives[1] - tickCumulatives[0];
        int56 window = int56(uint56(TWAP_WINDOW));
        // a real pool's mean tick always fits; anything else reverts here (or in TickMath) instead of wrapping
        meanTick = SafeCast.toInt24(delta / window);
        // always round to negative infinity
        if (delta < 0 && (delta % window != 0)) meanTick--;
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
