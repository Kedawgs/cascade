// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ICascadeTwap} from "../../src/interfaces/ICascadeTwap.sol";

/// @notice TWAP oracle stand-in: values TAO at a set price, or reverts like a pool whose history
/// doesn't reach the window ("OLD").
contract MockTwap is ICascadeTwap {
    /// USDC units (6 decimals) per 1e18 TAO wei.
    uint256 public usdcPerTao;
    bool public reverts;

    constructor(uint256 usdcPerTao_) {
        usdcPerTao = usdcPerTao_;
    }

    function setPrice(uint256 usdcPerTao_) external {
        usdcPerTao = usdcPerTao_;
    }

    function setReverts(bool reverts_) external {
        reverts = reverts_;
    }

    function usdcValue(uint256 taoWei) external view returns (uint256) {
        if (reverts) revert("OLD");
        return taoWei * usdcPerTao / 1e18;
    }
}
