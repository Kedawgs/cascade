// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ICascadeBridge} from "../../src/interfaces/ICascadeBridge.sol";

/// @notice Bridge test double: records the last send, never delivers, never refunds.
/// A non-zero `token` is the ERC-20 side; address(0) is the native side.
contract StubBridge is ICascadeBridge {
    using SafeERC20 for IERC20;

    error InsufficientFee();

    IERC20 public immutable token;

    uint256 public fee;
    uint64 public lastDestChain;
    address public lastRecipient;
    bytes public lastMessage;
    uint256 public lastAmount;
    uint256 public lastValue;
    uint256 public sendCount;

    constructor(IERC20 token_) {
        token = token_;
    }

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function send(uint64 destChain, address recipient, bytes calldata message, uint256 amount) external payable {
        if (address(token) == address(0)) {
            if (msg.value < amount + fee) revert InsufficientFee();
        } else {
            if (msg.value < fee) revert InsufficientFee();
            token.safeTransferFrom(msg.sender, address(this), amount);
        }
        lastDestChain = destChain;
        lastRecipient = recipient;
        lastMessage = message;
        lastAmount = amount;
        lastValue = msg.value;
        sendCount++;
    }

    function quoteFee(uint64, address, bytes calldata, uint256) external view returns (uint256) {
        return fee;
    }
}
