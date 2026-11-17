// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";

/// Pins the toolchain: solc 0.8.38 (transient storage keyword), Cancun opcodes, IR pipeline.
contract TransientBox {
    bool transient flag;

    function set() external {
        flag = true;
    }

    function get() external view returns (bool) {
        return flag;
    }

    function clear() external {
        flag = false;
    }

    function setReadClear() external returns (bool during, bool after_) {
        flag = true;
        during = flag;
        flag = false;
        after_ = flag;
    }

    function setOnly() external {
        flag = true;
    }
}

contract ToolchainTest is Test {
    TransientBox box;

    function setUp() public {
        box = new TransientBox();
    }

    function test_transientStorageRoundTrips() public {
        (bool during, bool after_) = box.setReadClear();
        assertTrue(during);
        assertFalse(after_);
        assertFalse(box.get());
    }

    /// forge-config: default.isolate = true
    function test_transientClearsBetweenTransactions() public {
        box.setOnly();
        assertFalse(box.get(), "transient flag must be clear in the next call");
    }

    function test_cancunOpcodes() public {
        uint256 got;
        bytes memory src = hex"0102030405060708";
        bytes memory dst = new bytes(8);
        assembly {
            tstore(7, 0xabc)
            got := tload(7)
            tstore(7, 0)
            mcopy(add(dst, 32), add(src, 32), 8)
        }
        assertEq(got, 0xabc);
        assertEq(dst, src);
    }
}
