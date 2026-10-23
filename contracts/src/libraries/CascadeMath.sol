// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Share pricing shared by the vault (Base) and the engine (Bittensor) so both sides
/// compute identical numbers from the same inputs. Uses the OpenZeppelin ERC-4626 virtual
/// offset defence against donation / inflation attacks. All results round down, in favour
/// of the vault.
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
