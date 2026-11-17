// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CcipAdapterBase} from "../../src/adapters/CcipAdapterBase.sol";

/// @dev Implements the base's hooks trivially: no minimum unless `setMinAmount` sets one, the whole
/// msg.value is the fee budget, tokens are pulled from the caller, and deliveries are recorded in
/// public storage. `exposedCcipSend` reaches the shared send path as a refund of held tokens does.
contract AdapterHarness is CcipAdapterBase {
    using SafeERC20 for IERC20;

    bytes32 public lastMessageId;
    address public lastRecipient;
    address public lastSender;
    bytes public lastMessage;
    uint256 public lastAmount;
    uint256 public deliveries;
    /// The side's minimum `_checkAmount` enforces; 0 (the default) enforces none.
    uint256 public minAmount;

    constructor(Config memory c) CcipAdapterBase(c) {}

    function setMinAmount(uint256 minAmount_) external {
        minAmount = minAmount_;
    }

    /// `_ccipSend` over tokens the adapter already holds (the test transfers them in first), with the
    /// router approved here as an unconverted refund approves it; `feeBudget` as given.
    function exposedCcipSend(
        address recipient,
        address sender,
        bytes calldata message,
        uint256 amount,
        uint256 feeBudget
    ) external payable returns (bytes32) {
        if (amount > 0) token.forceApprove(address(router), amount);
        return _ccipSend(recipient, sender, message, amount, feeBudget);
    }

    function _checkAmount(uint256 amount) internal view override {
        if (amount != 0 && amount < minAmount) revert BelowSendMinimum(amount, minAmount);
    }

    function _budget(uint256) internal view override returns (uint256) {
        return msg.value;
    }

    function _collect(uint256 amount) internal override {
        token.safeTransferFrom(msg.sender, address(this), amount);
        token.forceApprove(address(router), amount);
    }

    function _deliver(bytes32 messageId, address recipient, address sender, bytes memory message, uint256 amount)
        internal
        override
    {
        lastMessageId = messageId;
        lastRecipient = recipient;
        lastSender = sender;
        lastMessage = message;
        lastAmount = amount;
        deliveries++;
    }
}
