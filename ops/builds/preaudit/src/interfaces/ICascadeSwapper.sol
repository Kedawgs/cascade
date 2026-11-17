// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Sells TAO the front door has just transferred to it for USDC paid to `recipient`.
interface ICascadeSwapper {
    /// Sells `taoIn` TAO (already sent to the swapper) and pays at least `minUsdcOut` USDC to `recipient`.
    /// The front door trusts only the recipient's USDC balance delta, never this return value.
    function sellFor(uint256 taoIn, address recipient, uint256 minUsdcOut) external returns (uint256 usdcOut);
}
