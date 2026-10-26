// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TickMath} from "../../src/vendor/uniswap/TickMath.sol";
import {FullMath} from "../../src/vendor/uniswap/FullMath.sol";

contract UniswapMathTest is Test {
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    function test_sqrtRatioAtTickZeroIsQ96() public pure {
        assertEq(TickMath.getSqrtRatioAtTick(0), 79228162514264337593543950336);
    }

    function test_sqrtRatioAtExtremeTicks() public pure {
        assertEq(TickMath.getSqrtRatioAtTick(887272), MAX_SQRT_RATIO);
        assertEq(TickMath.getSqrtRatioAtTick(-887272), MIN_SQRT_RATIO);
    }

    function test_mulDivDoesNotOverflowIntermediate() public pure {
        assertEq(FullMath.mulDiv(2 ** 255, 2, 4), 2 ** 254);
    }
}
