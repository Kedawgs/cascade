// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The part of Aerodrome Slipstream's SwapRouter (Base `0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F`,
/// same selectors on Aero's `0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418`) the staker calls. The struct
/// carries a deadline; the router reverts once `block.timestamp` is past it.
/// @dev `path` is `token | int24 tickSpacing | token | ...` (20 + 23n bytes), first token in, last token
/// out. `exactInput` selector: 0xc04b8d59.
interface ISlipstreamRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}
