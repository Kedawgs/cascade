// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ICascadeBridge {
    /// ERC-20 side: bridge pulls `amount` from msg.sender (caller approves first); msg.value == fee.
    /// Native side: msg.value == amount + fee.
    function send(bytes calldata message, uint256 amount) external payable;

    function quoteFee(bytes calldata message, uint256 amount) external view returns (uint256);
}

interface ICascadeReceiver {
    /// Called by the bridge after delivering `amount` to the receiver.
    /// ERC-20 side: tokens are transferred before the call and msg.value == 0.
    /// Native side: msg.value == amount.
    function onBridgeMessage(bytes calldata message, uint256 amount) external payable;
}
