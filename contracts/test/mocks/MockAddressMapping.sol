// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IAddressMapping} from "../../src/interfaces/IAddressMapping.sol";
import {mirror} from "./Mirror.sol";

/// @notice Test double for the address-mapping precompile. Etch at ADDRESS_MAPPING_ADDRESS.
contract MockAddressMapping is IAddressMapping {
    function addressMapping(address addr) external pure returns (bytes32) {
        return mirror(addr);
    }
}
