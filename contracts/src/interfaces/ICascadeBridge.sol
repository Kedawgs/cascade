// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ICascadeBridge {
    /// ERC-20 side: pulls `amount` tokens from msg.sender (approve first); msg.value is the fee budget.
    /// Native side: msg.value == amount + fee budget.
    /// The fee budget (msg.value, or msg.value - amount) must be >= the adapter's real fee; the
    /// adapter keeps any excess and NEVER sends value back to the caller.
    function send(uint64 destChain, address recipient, bytes calldata message, uint256 amount) external payable;

    function quoteFee(uint64 destChain, address recipient, bytes calldata message, uint256 amount)
        external
        view
        returns (uint256);
}

interface ICascadeReceiver {
    /// Delivered by the adapter after transferring `amount` (ERC-20: before the call, msg.value == 0;
    /// native: msg.value == amount). `sourceChain`/`sender` are verified by the adapter.
    function onBridgeMessage(uint64 sourceChain, address sender, bytes calldata message, uint256 amount)
        external
        payable;
}
