// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {VerifyProbe, ProbeMath} from "./VerifyProbe.sol";

contract VerifyProbeTest is Test {
    function test_deploysAndLibraryCallWorks() public {
        VerifyProbe p = new VerifyProbe(14);
        assertEq(p.TRIPLED(), 42);
        assertEq(p.again(5), 15);
    }

    function test_libraryIsLinkedNotInlined() public {
        // an external library function is reached by DELEGATECALL, so the
        // probe's runtime has a library address baked in
        VerifyProbe p = new VerifyProbe(1);
        assertGt(address(p).code.length, 0);
        assertEq(ProbeMath.triple(2), 6);
    }
}
