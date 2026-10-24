// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Client} from "../../src/vendor/ccip/Client.sol";
import {IAny2EVMMessageReceiver} from "../../src/vendor/ccip/IAny2EVMMessageReceiver.sol";

/// @notice Minimal CCIP receiver for the fork harness spike: it passes the OffRamp's ERC-165 gate and
/// records each `ccipReceive` call (at most one token amount, as CCIP 2.0 carries).
contract Probe is IAny2EVMMessageReceiver, IERC165 {
    uint256 public calls;
    address public lastCaller;
    bytes32 public lastMessageId;
    uint64 public lastSourceChain;
    bytes public lastSender;
    bytes public lastData;
    uint256 public lastTokenCount;
    address public lastToken;
    uint256 public lastAmount;

    function ccipReceive(Client.Any2EVMMessage calldata message) external {
        ++calls;
        lastCaller = msg.sender;
        lastMessageId = message.messageId;
        lastSourceChain = message.sourceChainSelector;
        lastSender = message.sender;
        lastData = message.data;
        lastTokenCount = message.destTokenAmounts.length;
        if (message.destTokenAmounts.length > 0) {
            lastToken = message.destTokenAmounts[0].token;
            lastAmount = message.destTokenAmounts[0].amount;
        }
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IAny2EVMMessageReceiver).interfaceId || id == type(IERC165).interfaceId;
    }
}
