// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ICascadeTwap} from "../../src/interfaces/ICascadeTwap.sol";

/// @notice TWAP oracle stand-in: values TAO at a set price and the pools at a set depth, or reverts like a pool
/// whose history doesn't reach the window ("OLD"), every view alike.
contract MockTwap is ICascadeTwap {
    /// USDC units (6 decimals) per 1e18 TAO wei.
    uint256 public usdcPerTao;
    bool public reverts;
    /// The pools' mean in-range liquidity: deep (the uint128 maximum) until a test sets it, so no depth floor
    /// binds by default.
    uint128 public taoWethLiquidity = type(uint128).max;
    uint128 public wethUsdcLiquidity = type(uint128).max;

    constructor(uint256 usdcPerTao_) {
        usdcPerTao = usdcPerTao_;
    }

    function setPrice(uint256 usdcPerTao_) external {
        usdcPerTao = usdcPerTao_;
    }

    function setReverts(bool reverts_) external {
        reverts = reverts_;
    }

    function setMeanLiquidity(uint128 taoWeth_, uint128 wethUsdc_) external {
        taoWethLiquidity = taoWeth_;
        wethUsdcLiquidity = wethUsdc_;
    }

    function usdcValue(uint256 taoWei) external view returns (uint256) {
        if (reverts) revert("OLD");
        return taoWei * usdcPerTao / 1e18;
    }

    /// The inverse of `usdcValue` at the set price, rounded down.
    function taoValue(uint256 usdcUnits) external view returns (uint256) {
        if (reverts) revert("OLD");
        return usdcUnits * 1e18 / usdcPerTao;
    }

    function meanLiquidity() external view returns (uint128, uint128) {
        if (reverts) revert("OLD");
        return (taoWethLiquidity, wethUsdcLiquidity);
    }
}
