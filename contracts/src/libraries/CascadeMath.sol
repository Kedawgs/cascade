// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Share pricing for the vault on Bittensor EVM (front doors never price). Uses the
/// OpenZeppelin ERC-4626 virtual offset defence against donation / inflation attacks: 1e6
/// virtual shares and 1 wei of virtual assets. All results round down, in favour of the vault.
/// Callers keep `totalAssets`, `totalSupply` and the amounts below 1e36 (the vault caps assets at
/// `maxTotalAssets`); `Math.mulDiv` panics on products that exceed 2^256 instead of returning a wrong value.
library CascadeMath {
    /// Shares carry 6 more decimals than the asset.
    uint256 internal constant VIRTUAL_SHARES = 1e6;
    uint256 internal constant VIRTUAL_ASSETS = 1;

    function sharesForDeposit(uint256 assets, uint256 totalAssets, uint256 totalSupply)
        internal
        pure
        returns (uint256)
    {
        return Math.mulDiv(assets, totalSupply + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
    }

    function assetsForRedeem(uint256 shares, uint256 totalAssets, uint256 totalSupply) internal pure returns (uint256) {
        return Math.mulDiv(shares, totalAssets + VIRTUAL_ASSETS, totalSupply + VIRTUAL_SHARES);
    }

    /// Assets per share, scaled by 1e18.
    function price(uint256 totalAssets, uint256 totalSupply) internal pure returns (uint256) {
        return Math.mulDiv(totalAssets + VIRTUAL_ASSETS, 1e18, totalSupply + VIRTUAL_SHARES);
    }
}
