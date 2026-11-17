// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

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

    /// The most value one message carries (the adapters' immutable, at most their MAX_MESSAGE_VALUE): the vault's
    /// maxMessageValue and the front door's maxBatchValue stay at or below the primary's (spec §3.9, AboveBridgeCap).
    /// It must never change for the bridge's lifetime (the CCIP adapters' is `immutable`): the vault and the front
    /// door check their limits against it only when they set them or switch the primary, and every later setter call,
    /// a tightening included, is checked again. A cap that fell below a limit already set would make the owner's
    /// tightening revert AboveBridgeCap, breaking I-23 (a tightening is never refused); a bridge with another cap is a
    /// new bridge, activated and made primary through the scheduler.
    function maxMessageValue() external view returns (uint256);
}

interface ICascadeReceiver {
    /// Delivered by the adapter after transferring `amount` (ERC-20: before the call, msg.value == 0;
    /// native: msg.value == amount). `sourceChain`/`sender` are verified by the adapter.
    function onBridgeMessage(uint64 sourceChain, address sender, bytes calldata message, uint256 amount)
        external
        payable;
}
