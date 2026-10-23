// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Test-only coldkey mirror of an H160 address. The real chain uses blake2; the mocks only need
/// the vault and the staking mock to agree.
function mirror(address a) pure returns (bytes32) {
    return keccak256(abi.encodePacked("evm:", a));
}
