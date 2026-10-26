// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice A manipulation-resistant market value for TAO in USDC, used as the front door's delivery floor.
interface ICascadeTwap {
    /// The USDC units (6 decimals) that `taoWei` TAO is worth at the time-weighted mean price. Reverts,
    /// never returns a value, when a pool's price history doesn't reach the full window.
    function usdcValue(uint256 taoWei) external view returns (uint256 usdcUnits);
}
