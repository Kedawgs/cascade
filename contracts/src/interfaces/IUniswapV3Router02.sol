// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The part of Uniswap's SwapRouter02 (Base `0x2626664c2603336E57B271c5C0b26F421741e481`) the
/// staker calls. Unlike the original SwapRouter, the struct has no deadline field.
/// @dev `path` is `token | uint24 fee | token | ...` (20 + 23n bytes), first token in, last token out.
/// `exactInput` selector: 0xb858183f.
interface IUniswapV3Router02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}
