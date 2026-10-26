// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Uniswap v3 pool double for the TWAP oracle: settable tokens, and an `observe` that reads a
/// tick history of one steady tick plus an optional spike over the most recent seconds. Like the real
/// pool, a request reaching further back than the history it holds reverts "OLD".
contract MockUniswapPool {
    /// The tick cumulative now: non-zero, so only differences of cumulatives mean anything.
    int56 public constant CUMULATIVE_NOW = 1_000_000_000_000;

    address public token0;
    address public token1;
    /// The tick the pool sat at, apart from the spike.
    int24 public tick;
    /// The tick of the last `spikeSeconds` seconds.
    int24 public spikeTick;
    uint32 public spikeSeconds;
    /// How far back, in seconds, the pool's observations reach.
    uint32 public history = type(uint32).max;

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
        }
    }
}
