// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// Toolchain probe: an immutable fed by an EXTERNAL library function, so the
/// deployed bytecode contains a link placeholder (not an inlined body). Used to
/// check that Sourcify, taostats and Basescan accept solc 0.8.38 + viaIR + cancun
/// + a linked library. Not part of the protocol.
library ProbeMath {
    function triple(uint256 x) external pure returns (uint256) {
        return x * 3;
    }
}

contract VerifyProbe {
    uint256 public immutable TRIPLED;

    constructor(uint256 x) {
        TRIPLED = ProbeMath.triple(x);
    }

    function again(uint256 x) external pure returns (uint256) {
        return ProbeMath.triple(x);
    }
}
