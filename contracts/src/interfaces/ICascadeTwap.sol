// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @notice A manipulation-resistant market value for TAO in USDC, used as the front door's delivery floor and the
/// staker's buy floor, and the depth of the pools it is read from, used as the front door's liquidity floor.
interface ICascadeTwap {
    /// The USDC units (6 decimals) that `taoWei` TAO is worth at the time-weighted mean price. Reverts,
    /// never returns a value, when a pool's price history doesn't reach the full window.
    function usdcValue(uint256 taoWei) external view returns (uint256 usdcUnits);

    /// The TAO wei that `usdcUnits` USDC is worth at the same mean price: `usdcValue`'s inverse, rounded down.
    /// Reverts, never returns a value, when a pool's price history doesn't reach the full window.
    function taoValue(uint256 usdcUnits) external view returns (uint256 taoWei);

    /// Each pool's harmonic-mean in-range liquidity over the same window (TAO/WETH, then WETH/USDC). Reverts,
    /// never returns a value, when a pool's history doesn't reach the full window.
    function meanLiquidity() external view returns (uint128 taoWeth, uint128 wethUsdc);
}
