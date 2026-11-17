// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {TickMath} from "../../src/vendor/uniswap/TickMath.sol";

/// @notice Uniswap v3 pool double for the TWAP oracle: settable tokens, a `slot0` with settable observation
/// slots, and an `observe` that reads a tick history of one steady tick plus an optional spike over the most
/// recent seconds, and a liquidity history of one steady level plus an optional level over the most recent
/// seconds. Like the real pool, a request reaching further back than the history it holds reverts "OLD".
contract MockUniswapPool {
    /// The tick cumulative now: non-zero, so only differences of cumulatives mean anything.
    int56 public constant CUMULATIVE_NOW = 1_000_000_000_000;
    /// The seconds-per-liquidity cumulative now (X128): non-zero, and above anything the oracle's window
    /// subtracts (at most 1,800 x 2^128), so the cumulatives the oracle reads never wrap.
    uint160 public constant SECONDS_PER_LIQUIDITY_NOW = 1 << 159;

    address public token0;
    address public token1;
    /// The tick the pool sat at, apart from the spike.
    int24 public tick;
    /// The tick of the last `spikeSeconds` seconds.
    int24 public spikeTick;
    uint32 public spikeSeconds;
    /// How far back, in seconds, the pool's observations reach.
    uint32 public history = type(uint32).max;
    /// `slot0`'s observation slots in use and requested: a fresh pool's 1 and 1.
    uint16 public cardinality = 1;
    uint16 public cardinalityNext = 1;
    /// The in-range liquidity the pool held, apart from the last `recentLiquiditySeconds` seconds. A real
    /// pool's liquidity is a uint128 and 0 counts as 1 (`Oracle.transform`); the mock takes wider values, to
    /// reach readings no real pool gives (a seconds-per-liquidity growth of 0, or below the window).
    uint256 public liquidity;
    /// The in-range liquidity of the last `recentLiquiditySeconds` seconds.
    uint256 public recentLiquidity;
    uint32 public recentLiquiditySeconds;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    function setTokens(address token0_, address token1_) external {
        token0 = token0_;
        token1 = token1_;
    }

    /// A steady `tick_` over the whole history (clears any spike).
    function setTick(int24 tick_) external {
        tick = tick_;
        spikeSeconds = 0;
    }

    /// The last `seconds_` seconds at `tick_`, the time before at the steady tick.
    function setSpike(int24 tick_, uint32 seconds_) external {
        spikeTick = tick_;
        spikeSeconds = seconds_;
    }

    function setHistory(uint32 seconds_) external {
        history = seconds_;
    }

    /// `slot0`'s `observationCardinality` (in use) and `observationCardinalityNext` (requested).
    function setCardinality(uint16 inUse, uint16 next) external {
        cardinality = inUse;
        cardinalityNext = next;
    }

    /// A steady in-range liquidity over the whole history (clears any recent level).
    function setLiquidity(uint256 liquidity_) external {
        liquidity = liquidity_;
        recentLiquiditySeconds = 0;
    }

    /// The last `seconds_` seconds at `liquidity_`, the time before at the steady level.
    function setRecentLiquidity(uint256 liquidity_, uint32 seconds_) external {
        recentLiquidity = liquidity_;
        recentLiquiditySeconds = seconds_;
    }

    /// The pool's current state: the tick (the spike's while one is set), its sqrt price, and the observation
    /// slots; the index, protocol fee and lock are a fresh, unlocked pool's.
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick_,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        tick_ = spikeSeconds > 0 ? spikeTick : tick;
        sqrtPriceX96 = TickMath.getSqrtRatioAtTick(tick_);
        return (sqrtPriceX96, tick_, 0, cardinality, cardinalityNext, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        for (uint256 i; i < secondsAgos.length; ++i) {
            uint32 ago = secondsAgos[i];
            require(ago <= history, "OLD");
            uint32 recent = ago < spikeSeconds ? ago : spikeSeconds;
            tickCumulatives[i] =
                CUMULATIVE_NOW - int56(spikeTick) * int56(uint56(recent)) - int56(tick) * int56(uint56(ago - recent));
            uint32 recentL = ago < recentLiquiditySeconds ? ago : recentLiquiditySeconds;
            // the pool's own arithmetic wraps; so does the mock's, for `history` reaching back further than the
            // oracle's window at a liquidity of 0 or 1
            unchecked {
                secondsPerLiquidityCumulativeX128s[i] =
                    SECONDS_PER_LIQUIDITY_NOW - _growth(recentL, recentLiquidity) - _growth(ago - recentL, liquidity);
            }
        }
    }

    /// What `seconds_` seconds at `liquidity_` add to the seconds-per-liquidity cumulative, as the pool's
    /// `Oracle.transform` writes it: `(seconds << 128) / (liquidity > 0 ? liquidity : 1)`, rounded down.
    function _growth(uint32 seconds_, uint256 liquidity_) private pure returns (uint160) {
        return uint160((uint256(seconds_) << 128) / (liquidity_ > 0 ? liquidity_ : 1));
    }
}
