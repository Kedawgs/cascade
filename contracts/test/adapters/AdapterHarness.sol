// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CcipAdapterBase} from "../../src/adapters/CcipAdapterBase.sol";
import {Client} from "../../src/vendor/ccip/Client.sol";

/// @dev Exposes the base's public helpers; the sending and receiving hooks are stubbed.
contract AdapterHarness is CcipAdapterBase {
    constructor(Config memory c) CcipAdapterBase(c) {}

    function send(uint64, address, bytes calldata, uint256) external payable override {
        revert();
    }

    function quoteFee(uint64, address, bytes calldata, uint256) external pure override returns (uint256) {
        revert();
    }

    function ccipReceive(Client.Any2EVMMessage calldata) external pure override {
        revert();
    }
}
