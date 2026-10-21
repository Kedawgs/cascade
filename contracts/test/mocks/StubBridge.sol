// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ICascadeBridge} from "../../src/interfaces/ICascadeBridge.sol";

/// @notice Records the last send and charges a settable fee. Never delivers anything.
/// @dev With a non-zero token it is the ERC-20 side (pulls `amount` tokens, msg.value pays the
/// fee); with token == address(0) it is the native side (msg.value carries amount + fee).
contract StubBridge is ICascadeBridge {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    uint256 public fee;
    bytes public lastMessage;
    uint256 public lastAmount;
    uint256 public lastValue;
    uint256 public sendCount;

    error FeeTooLow();

    constructor(IERC20 token_) {
        token = token_;
    }

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function send(bytes calldata message, uint256 amount) external payable {
        if (address(token) != address(0)) {
            if (msg.value < fee) revert FeeTooLow();
            token.safeTransferFrom(msg.sender, address(this), amount);
        } else {
            if (msg.value < amount + fee) revert FeeTooLow();
        }
        lastMessage = message;
        lastAmount = amount;
        lastValue = msg.value;
        sendCount++;
    }

    function quoteFee(bytes calldata, uint256) external view returns (uint256) {
        return fee;
    }
}
