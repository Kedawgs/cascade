// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MessageV1Codec} from "../vendor/ccip/MessageV1Codec.sol";

/// @notice Fork-test stand-in for a CCIP 2.0 cross-chain verifier (CCV). `ForkBase.execute` etches this
/// runtime code over every CCV the real OffRamp asks for, so the OffRamp resolves each CCV to itself and
/// its `verifyMessage` accepts any message. Only the verifier is faked; the OffRamp, Router, pool and
/// token stay live.
contract StubVerifier {
    /// The resolver step: this CCV is its own inbound implementation.
    function getInboundImplementation(bytes calldata) external view returns (address) {
        return address(this);
    }

    /// Accepts any message.
    function verifyMessage(MessageV1Codec.MessageV1 memory, bytes32, bytes memory) external pure {}

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }
}
