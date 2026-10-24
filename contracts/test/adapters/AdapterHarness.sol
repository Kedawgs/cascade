// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CcipAdapterBase} from "../../src/adapters/CcipAdapterBase.sol";

/// @dev Implements the base's hooks trivially: no minimum, the whole msg.value is the fee budget,
/// tokens are pulled from the caller, and deliveries are recorded in public storage.
contract AdapterHarness is CcipAdapterBase {
    using SafeERC20 for IERC20;

    address public lastRecipient;
    address public lastSender;
    bytes public lastMessage;
    uint256 public lastAmount;
    uint256 public deliveries;

    constructor(Config memory c) CcipAdapterBase(c) {}

    function _checkAmount(uint256) internal view override {}

    function _budget(uint256) internal view override returns (uint256) {
        return msg.value;
    }

    function _collect(uint256 amount) internal override {
        token.safeTransferFrom(msg.sender, address(this), amount);
        token.forceApprove(address(router), amount);
    }

    function _deliver(address recipient, address sender, bytes memory message, uint256 amount) internal override {
        lastRecipient = recipient;
        lastSender = sender;
        lastMessage = message;
        lastAmount = amount;
        deliveries++;
    }
}
