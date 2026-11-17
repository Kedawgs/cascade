// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Bittensor address-mapping precompile address.
address constant ADDRESS_MAPPING_ADDRESS = 0x000000000000000000000000000000000000080C;

/// @notice Maps an H160 address to its mirrored SS58 public key (coldkey).
interface IAddressMapping {
    function addressMapping(address addr) external view returns (bytes32);
}
