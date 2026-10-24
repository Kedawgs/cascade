// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ICascadeReceiver} from "../../src/interfaces/ICascadeBridge.sol";

/// @notice `ICascadeReceiver` test double for adapter deliveries. It records the last delivery and, like a
/// native-side peer, reverts `ValueMismatch` unless msg.value equals `amount`. `setTokenSide(true)` makes it
/// an ERC-20-side peer instead (the amount arrived as tokens, so no value may come with the call), and
/// `setRevert(true)` makes every delivery revert `Reverting`, so one deployment serves a failing and then
/// a succeeding attempt of the same message.
contract Sink is ICascadeReceiver {
    error ValueMismatch();
    error Reverting();

    bool public reverting;
    bool public tokenSide;

    uint256 public calls;
    uint64 public lastSourceChain;
    address public lastSender;
    bytes public lastMessage;
    uint256 public lastAmount;
    uint256 public lastValue;

    function setRevert(bool on) external {
        reverting = on;
    }

    function setTokenSide(bool on) external {
        tokenSide = on;
    }

    function onBridgeMessage(uint64 sourceChain, address sender, bytes calldata message, uint256 amount)
        external
        payable
    {
        if (reverting) revert Reverting();
        if (msg.value != (tokenSide ? 0 : amount)) revert ValueMismatch();
        ++calls;
        lastSourceChain = sourceChain;
        lastSender = sender;
        lastMessage = message;
        lastAmount = amount;
        lastValue = msg.value;
    }
}
