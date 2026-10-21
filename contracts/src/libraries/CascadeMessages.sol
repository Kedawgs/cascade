// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Encoding and decoding of the two cross-chain epoch messages.
/// @dev Every message is `abi.encode(uint8 kind, fields...)`.
library CascadeMessages {
    uint8 internal constant EPOCH_REQUEST = 1;
    uint8 internal constant EPOCH_RESULT = 2;

    error WrongMessageKind(uint8 expected, uint8 actual);

    function encodeRequest(uint64 epochId, uint256 redeemShares, uint256 totalSupply)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(EPOCH_REQUEST, epochId, redeemShares, totalSupply);
    }

    function decodeRequest(bytes memory message)
        internal
        pure
        returns (uint64 epochId, uint256 redeemShares, uint256 totalSupply)
    {
        uint8 actual = kind(message);
        if (actual != EPOCH_REQUEST) revert WrongMessageKind(EPOCH_REQUEST, actual);
        (, epochId, redeemShares, totalSupply) = abi.decode(message, (uint8, uint64, uint256, uint256));
    }

    function encodeResult(uint64 epochId, uint256 assetsBefore) internal pure returns (bytes memory) {
        return abi.encode(EPOCH_RESULT, epochId, assetsBefore);
    }

    function decodeResult(bytes memory message) internal pure returns (uint64 epochId, uint256 assetsBefore) {
        uint8 actual = kind(message);
        if (actual != EPOCH_RESULT) revert WrongMessageKind(EPOCH_RESULT, actual);
        (, epochId, assetsBefore) = abi.decode(message, (uint8, uint64, uint256));
    }

    function kind(bytes memory message) internal pure returns (uint8) {
        return abi.decode(message, (uint8));
    }
}
