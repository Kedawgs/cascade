// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISlipstreamRouter} from "../../src/interfaces/ISlipstreamRouter.sol";
import {IUniswapV3Router02} from "../../src/interfaces/IUniswapV3Router02.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @notice Router double with both `exactInput` shapes: SwapRouter02's (no deadline) and Slipstream's
/// (with a deadline, which it enforces like the real router). It reads tokenIn and tokenOut from the
/// path's first and last 20 bytes, pulls `amountIn - pullShort` of tokenIn from the caller and mints
/// `amountIn * rate[tokenIn] / 1e18` of tokenOut to the recipient. An honest router (the default)
/// reverts below `amountOutMinimum`; a lying one pays the rate anyway and reports the minimum as paid.
/// Every call records the struct it received.
contract MockSwapRouter {
    using SafeERC20 for IERC20;

    enum Kind {
        UniswapV3,
        Slipstream
    }

    /// tokenOut units per 1e18 units of tokenIn, by tokenIn.
    mapping(address => uint256) public rate;
    bool public lies;
    uint256 public pullShort;

    uint256 public calls;
    Kind public lastKind;
    bytes public lastPath;
    address public lastRecipient;
    uint256 public lastDeadline;
    uint256 public lastAmountIn;
    uint256 public lastAmountOutMinimum;

    function setRate(address tokenIn, uint256 rate_) external {
        rate[tokenIn] = rate_;
    }

    function setLies(bool lies_) external {
        lies = lies_;
    }

    function setPullShort(uint256 pullShort_) external {
        pullShort = pullShort_;
    }

    function exactInput(IUniswapV3Router02.ExactInputParams calldata p) external payable returns (uint256) {
        lastKind = Kind.UniswapV3;
        lastDeadline = 0;
        return _swap(p.path, p.recipient, p.amountIn, p.amountOutMinimum);
    }

    function exactInput(ISlipstreamRouter.ExactInputParams calldata p) external payable returns (uint256) {
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp <= p.deadline, "Transaction too old");
        lastKind = Kind.Slipstream;
        lastDeadline = p.deadline;
        return _swap(p.path, p.recipient, p.amountIn, p.amountOutMinimum);
    }

    function _swap(bytes calldata path, address recipient, uint256 amountIn, uint256 amountOutMinimum)
        private
        returns (uint256)
    {
        calls++;
        lastPath = path;
        lastRecipient = recipient;
        lastAmountIn = amountIn;
        lastAmountOutMinimum = amountOutMinimum;
        address tokenIn = address(bytes20(path[:20]));
        address tokenOut = address(bytes20(path[path.length - 20:]));
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn - pullShort);
        uint256 out = amountIn * rate[tokenIn] / 1e18;
        if (!lies) require(out >= amountOutMinimum, "Too little received");
        IMintable(tokenOut).mint(recipient, out);
        return lies ? amountOutMinimum : out;
    }
}
