// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CascadeTwapOracle, IUniswapV3PoolOracle} from "../../src/CascadeTwapOracle.sol";
import {ForkBase} from "./ForkBase.sol";

/// Uniswap v3 QuoterV2: quotes by running the swap and reverting, so it is not `view`.
interface IQuoterV2 {
    function quoteExactInput(bytes memory path, uint256 amountIn)
        external
        returns (
            uint256 amountOut,
            uint160[] memory sqrtPriceX96AfterList,
            uint32[] memory initializedTicksCrossedList,
            uint256 gasEstimate
        );
}

/// @notice Cascade v3 on a Base mainnet fork: the TWAP oracle over the live Uniswap TAO/WETH 0.3% and
/// WETH/USDC 0.05% pools. Run with `FORK=1` (optionally `BASE_RPC=<url>`).
contract BaseForkV3Test is ForkBase {
    address constant BASE_WETH = 0x4200000000000000000000000000000000000006;
    address constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant TAO_WETH_POOL = 0x82dD34C6631C286cDD1dB16f2c232f60E402Dd5A;
    address constant WETH_USDC_POOL = 0xd0b53D9277642d899DF5C87A3966A349A798F224;
    address constant QUOTER_V2 = 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a;

    CascadeTwapOracle oracle;

    function setUp() public {
        forkFrom("BASE_RPC", "https://mainnet.base.org");
        if (!isFork()) return;
        emit log_named_uint("fork block", block.number);
        oracle = new CascadeTwapOracle(TAO_WETH_POOL, WETH_USDC_POOL, BASE_TAO, BASE_WETH, BASE_USDC);
    }

    /// The QuoterV2 sell quote for `taoWei` TAO along TAO -(0.3%)-> WETH -(0.05%)-> USDC.
    function quoteTaoToUsdc(uint256 taoWei) internal returns (uint256 usdcOut) {
        bytes memory path = abi.encodePacked(BASE_TAO, uint24(3000), BASE_WETH, uint24(500), BASE_USDC);
        (usdcOut,,,) = IQuoterV2(QUOTER_V2).quoteExactInput(path, taoWei);
    }

    // ---- oracle ----

    function test_fork_bothPoolsObserveThirtyMinutes() public onlyFork {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = 1800;
        secondsAgos[1] = 0;
        (int56[] memory taoWeth,) = IUniswapV3PoolOracle(TAO_WETH_POOL).observe(secondsAgos);
        (int56[] memory wethUsdc,) = IUniswapV3PoolOracle(WETH_USDC_POOL).observe(secondsAgos);
        assertEq(taoWeth.length, 2);
        assertEq(wethUsdc.length, 2);
        emit log_named_int("TAO/WETH 30-min mean tick", (taoWeth[1] - taoWeth[0]) / 1800);
        emit log_named_int("WETH/USDC 30-min mean tick", (wethUsdc[1] - wethUsdc[0]) / 1800);
    }

    function test_fork_oracleValueWithinThreePercentOfQuoterSpot() public onlyFork {
        uint256 twap = oracle.usdcValue(1e18);
        uint256 quote = quoteTaoToUsdc(1e18);
        emit log_named_decimal_uint("oracle: 1 TAO in USDC (30-min TWAP)", twap, 6);
        emit log_named_decimal_uint("QuoterV2: 1 TAO sell in USDC", quote, 6);
        assertApproxEqRel(twap, quote, 0.03e18);
    }
}
