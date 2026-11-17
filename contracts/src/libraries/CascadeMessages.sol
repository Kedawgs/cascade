// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @notice Encoding and decoding of the two cross-chain messages: the deposit/redeem BATCH
/// (Base to vault) and the PAYOUTS chunks (vault to Base).
/// @dev Every message is `abi.encode(uint8 kind, fields...)`.
library CascadeMessages {
    struct Entry {
        address user;
        uint256 amount;
    }

    struct Payout {
        address user;
        uint256 shares;
        uint256 assets;
    }

    uint8 internal constant BATCH = 1;
    uint8 internal constant PAYOUTS = 2;
    /// The most entries in any list of a message: a BATCH's deposits and its redeems, each, and a PAYOUTS chunk.
    /// 50 since v3.2's Task 18 (100 before): a first deposit now also writes its redeem origin, so a 100 + 100
    /// batch of new depositors would need more than the lane's 7,000,000 gas cap, and at 50 + 50 every legal
    /// message fits it (the adapters' gas model is checked over 2 * MAX_ENTRIES entries).
    uint256 internal constant MAX_ENTRIES = 50;

    error WrongMessageKind(uint8 expected, uint8 actual);
    error TooManyEntries();

    function encodeBatch(uint64 batchId, Entry[] memory deposits, Entry[] memory redeems)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(BATCH, batchId, deposits, redeems);
    }

    function decodeBatch(bytes memory message)
        internal
        pure
        returns (uint64 batchId, Entry[] memory deposits, Entry[] memory redeems)
    {
        uint8 actual = kind(message);
        if (actual != BATCH) revert WrongMessageKind(BATCH, actual);
        (, batchId, deposits, redeems) = abi.decode(message, (uint8, uint64, Entry[], Entry[]));
        if (deposits.length > MAX_ENTRIES || redeems.length > MAX_ENTRIES) revert TooManyEntries();
    }

    function encodePayouts(bytes32 batchKey, uint32 chunk, Entry[] memory payouts)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(PAYOUTS, batchKey, chunk, payouts);
    }

    function decodePayouts(bytes memory message)
        internal
        pure
        returns (bytes32 batchKey, uint32 chunk, Entry[] memory payouts)
    {
        uint8 actual = kind(message);
        if (actual != PAYOUTS) revert WrongMessageKind(PAYOUTS, actual);
        (, batchKey, chunk, payouts) = abi.decode(message, (uint8, bytes32, uint32, Entry[]));
        if (payouts.length > MAX_ENTRIES) revert TooManyEntries();
    }

    function kind(bytes memory message) internal pure returns (uint8) {
        return abi.decode(message, (uint8));
    }
}
