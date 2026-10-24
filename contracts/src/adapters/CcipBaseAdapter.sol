// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ICascadeReceiver} from "../interfaces/ICascadeBridge.sol";
import {CcipAdapterBase} from "./CcipAdapterBase.sol";

/// @notice The Base side of the CCIP bridge: the bridged TAO is an ERC-20 here, so sending pulls
/// tokens from the caller and delivery transfers them to the recipient.
/// @dev No `receive` or `fallback`: the whole msg.value of a send is the fee budget, and the router
/// is paid exactly the quoted fee; any excess stays in the adapter.
contract CcipBaseAdapter is CcipAdapterBase {
    using SafeERC20 for IERC20;

    /// @notice Smallest non-zero token amount a send may carry.
    uint256 public immutable minSendAmount;

    constructor(Config memory c, uint256 minSendAmount_) CcipAdapterBase(c) {
        minSendAmount = minSendAmount_;
    }

    function _checkAmount(uint256 amount) internal view override {
        if (amount != 0 && amount < minSendAmount) revert BelowSendMinimum(amount, minSendAmount);
    }

    function _budget(uint256) internal view override returns (uint256) {
        return msg.value;
    }

    function _collect(uint256 amount) internal override {
        token.safeTransferFrom(msg.sender, address(this), amount);
        token.forceApprove(address(router), amount);
    }

    /// @dev Tokens first: the recipient checks its token balance inside `onBridgeMessage`.
    function _deliver(address recipient, address sender, bytes memory message, uint256 amount) internal override {
        if (amount > 0) token.safeTransfer(recipient, amount);
        ICascadeReceiver(recipient).onBridgeMessage(remoteChainId, sender, message, amount);
    }
}
