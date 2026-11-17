// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test, stdError} from "forge-std/Test.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {CascadeTwapOracle} from "../../src/CascadeTwapOracle.sol";
import {FullMath} from "../../src/vendor/uniswap/FullMath.sol";
import {TickMath} from "../../src/vendor/uniswap/TickMath.sol";
import {MockUniswapPool} from "../mocks/MockUniswapPool.sol";

/// @notice The TWAP oracle over two mock pools laid out like the live Base pools: the real token
/// addresses, so WETH sorts first in both (TAO/WETH: token0 WETH, token1 TAO; WETH/USDC: token0 WETH,
/// token1 USDC).
contract TwapOracleTest is Test {
    address constant TAO = 0xf3081494B87e8D5fb7960f066E931D1D0e6E3d67;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    /// `slot0` ticks of the live pools on 2026-10-26.
    int24 constant LIVE_TAO_WETH_TICK = 22227;
    int24 constant LIVE_WETH_USDC_TICK = -198877;

    uint256 constant WINDOW = 1800;
    uint256 constant Q128 = 1 << 128;

    MockUniswapPool taoWeth;
    MockUniswapPool wethUsdc;
    CascadeTwapOracle oracle;

    function setUp() public {
        taoWeth = new MockUniswapPool(WETH, TAO);
        wethUsdc = new MockUniswapPool(WETH, USDC);
        // the constructor's minimum observation slots in use (the live pools hold more)
        taoWeth.setCardinality(1_801, 1_801);
        wethUsdc.setCardinality(1_801, 1_801);
        oracle = new CascadeTwapOracle(address(taoWeth), address(wethUsdc), TAO, WETH, USDC);
    }

    // ---- helpers ----

    /// The price `_quoteAtTick` reads at `tick`, times 2^192: token1 per token0 in raw units, the square of the
    /// tick's sqrt ratio. Only the branch where the sqrt ratio fits in 128 bits (every tick below 443,636), where
    /// the tests stay.
    function ratioX192(int24 tick) internal pure returns (uint256) {
        uint160 sqrtRatio = TickMath.getSqrtRatioAtTick(tick);
        require(sqrtRatio <= type(uint128).max, "a tick in the 128-bit branch");
        return uint256(sqrtRatio) * sqrtRatio;
    }

    /// `a - b`, or 0 below it.
    function sub0(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }

    /// `usdcValue` and `taoValue` at TAO/WETH tick `t1` and WETH/USDC tick `t2`, against the exact inverse pair
    /// they round. With R1 and R2 the two pools' prices times 2^192 (TAO per WETH, USDC per WETH: WETH is token0 of
    /// both), `x` TAO is worth E = x * R2 / R1 USDC and `u` USDC is worth E' = u * R1 / R2 TAO. Each view is two
    /// hops, each rounded down: usdcValue's first hop loses under 1 WETH wei, which the second scales to under
    /// r2 = R2 / 2^192 USDC, and its second loses under 1 more, so E - r2 - 1 < usdcValue(x) <= E; likewise
    /// E' - r1 - 1 < taoValue(u) <= E'. As integers, with F = floor(E): F - floor(r2) - 1 <= usdcValue(x) <= F.
    /// Composed: taoValue(usdcValue(x)) > (E - r2 - 1) * R1 / R2 - r1 - 1 = x - 2 r1 - R1 / R2 - 1, and never above
    /// x, so x - 3 - 2 floor(r1) - floor(R1 / R2) <= taoValue(usdcValue(x)) <= x; and the same with the pools'
    /// roles swapped for usdcValue(taoValue(u)). At the live ticks (r1 = 9.2, r2 = 2.3e-9) the TAO bound is about
    /// 4.3e9 wei, one USDC unit's worth of TAO, and the USDC bound is 3 units.
    function checkInverses(int24 t1, int24 t2, uint256 x, uint256 u) internal {
        taoWeth.setTick(t1);
        wethUsdc.setTick(t2);
        uint256 r1 = ratioX192(t1);
        uint256 r2 = ratioX192(t2);

        // each view: a floor of the exact value, short by at most a hop's rounding
        uint256 exactUsdc = FullMath.mulDiv(x, r2, r1);
        uint256 usdc = oracle.usdcValue(x);
        assertLe(usdc, exactUsdc, "usdcValue rounds down");
        assertGe(usdc, sub0(exactUsdc, (r2 >> 192) + 1), "usdcValue within its rounding");
        uint256 exactTao = FullMath.mulDiv(u, r1, r2);
        uint256 tao = oracle.taoValue(u);
        assertLe(tao, exactTao, "taoValue rounds down");
        assertGe(tao, sub0(exactTao, (r1 >> 192) + 1), "taoValue within its rounding");

        // composed, each way
        uint256 back = oracle.taoValue(usdc);
        assertLe(back, x, "taoValue(usdcValue(x)) <= x");
        assertGe(back, sub0(x, 3 + 2 * (r1 >> 192) + r1 / r2), "taoValue(usdcValue(x)) within the rounding");
        back = oracle.usdcValue(tao);
        assertLe(back, u, "usdcValue(taoValue(u)) <= u");
        assertGe(back, sub0(u, 3 + 2 * (r2 >> 192) + r2 / r1), "usdcValue(taoValue(u)) within the rounding");
    }

    /// A pool's harmonic-mean liquidity over the window: `ta` seconds at `la`, then `tb` at `lb` (ta + tb the
    /// window; a liquidity of 0 counts as 1, as in the pool), against H = T / (ta / la + tb / lb). The pool writes
    /// each stretch's seconds-per-liquidity growth rounded down, so the k stretches' growth d falls under the exact
    /// D = 2^128 * T / H by less than k; the oracle's floor(T * (2^160 - 1) / (d * 2^32)) is then above H - 1 - H /
    /// 2^160 and below T * 2^128 / (D - k) = H + k H^2 / (T * 2^128 - k H). As integers: from floor(H) - 1 to
    /// floor(H) plus that excess rounded up (H itself under floor(H) + 1).
    function checkHarmonic(uint128 actual, uint256 ta, uint256 la, uint256 tb, uint256 lb, string memory what)
        internal
        pure
    {
        la = la > 0 ? la : 1;
        lb = lb > 0 ? lb : 1;
        uint256 h = FullMath.mulDiv(WINDOW * la, lb, ta * lb + tb * la);
        uint256 k = (ta > 0 ? 1 : 0) + (tb > 0 ? 1 : 0);
        uint256 hc = h + 1;
        uint256 excess = FullMath.mulDiv(k * hc, hc, WINDOW * Q128 - k * hc) + 1;
        assertGe(actual, sub0(h, 1), string.concat(what, ": at least floor(H) - 1"));
        assertLe(actual, h + excess, string.concat(what, ": at most floor(H) plus the growth's rounding"));
    }

    // ---- the constructor ----

    function test_constructorKeepsPoolsAndTokens() public view {
        assertEq(oracle.TWAP_WINDOW(), 1800);
        assertEq(oracle.MIN_CARDINALITY(), 1_801);
        assertEq(oracle.MIN_CARDINALITY(), oracle.TWAP_WINDOW() + 1, "one a second over the window, plus one");
        assertEq(oracle.taoWethPool(), address(taoWeth));
        assertEq(oracle.wethUsdcPool(), address(wethUsdc));
        assertEq(oracle.tao(), TAO);
        assertEq(oracle.weth(), WETH);
        assertEq(oracle.usdc(), USDC);
    }

    /// The live TAO/WETH pool before its growth: 600 observation slots in use, 2,000 requested. The constructor
    /// reads the slots in use, on each pool.
    function test_constructorRefusesCardinality600() public {
        taoWeth.setCardinality(600, 2000);
        vm.expectRevert(abi.encodeWithSelector(CascadeTwapOracle.TooFewObservations.selector, address(taoWeth), 600));
        new CascadeTwapOracle(address(taoWeth), address(wethUsdc), TAO, WETH, USDC);

        taoWeth.setCardinality(1_801, 1_801);
        wethUsdc.setCardinality(600, 2000);
        vm.expectRevert(abi.encodeWithSelector(CascadeTwapOracle.TooFewObservations.selector, address(wethUsdc), 600));
        new CascadeTwapOracle(address(taoWeth), address(wethUsdc), TAO, WETH, USDC);
    }

    /// 1,801 slots in use is enough (one a second over the 30-minute window, plus one: Uniswap writes at most one
    /// observation per block timestamp, whole seconds, whatever the block time; Revision 28); 1,800 is not, nor the
    /// 901 of 2-second blocks, nor a fresh pool's 1 however many it has requested. The live pools' 2,000 and 6,700
    /// (November 2026) are enough.
    function test_constructorNeedsMinCardinalityInUse() public {
        uint16[2] memory few = [uint16(1_800), 901];
        for (uint256 i; i < few.length; ++i) {
            taoWeth.setCardinality(few[i], 2_000);
            vm.expectRevert(
                abi.encodeWithSelector(CascadeTwapOracle.TooFewObservations.selector, address(taoWeth), few[i])
            );
            new CascadeTwapOracle(address(taoWeth), address(wethUsdc), TAO, WETH, USDC);
        }

        taoWeth.setCardinality(1, type(uint16).max);
        vm.expectRevert(abi.encodeWithSelector(CascadeTwapOracle.TooFewObservations.selector, address(taoWeth), 1));
        new CascadeTwapOracle(address(taoWeth), address(wethUsdc), TAO, WETH, USDC);

        taoWeth.setCardinality(1_801, 1_801);
        wethUsdc.setCardinality(1_800, 2_000);
        vm.expectRevert(abi.encodeWithSelector(CascadeTwapOracle.TooFewObservations.selector, address(wethUsdc), 1_800));
        new CascadeTwapOracle(address(taoWeth), address(wethUsdc), TAO, WETH, USDC);

        wethUsdc.setCardinality(1_801, 1_801);
        new CascadeTwapOracle(address(taoWeth), address(wethUsdc), TAO, WETH, USDC);

        taoWeth.setCardinality(2_000, 2_000);
        wethUsdc.setCardinality(6_700, 6_700);
        new CascadeTwapOracle(address(taoWeth), address(wethUsdc), TAO, WETH, USDC);

        wethUsdc.setCardinality(type(uint16).max, type(uint16).max);
        new CascadeTwapOracle(address(taoWeth), address(wethUsdc), TAO, WETH, USDC);
    }

    function test_wrongPoolTokensRejected() public {
        MockUniswapPool wethTao = new MockUniswapPool(TAO, WETH); // the right pair, unsorted
        wethTao.setCardinality(1_801, 1_801);

        // the TAO/WETH slot given the WETH/USDC pool
        vm.expectRevert(abi.encodeWithSelector(CascadeTwapOracle.BadPool.selector, address(wethUsdc)));
        new CascadeTwapOracle(address(wethUsdc), address(wethUsdc), TAO, WETH, USDC);

        // the WETH/USDC slot given the TAO/WETH pool
        vm.expectRevert(abi.encodeWithSelector(CascadeTwapOracle.BadPool.selector, address(taoWeth)));
        new CascadeTwapOracle(address(taoWeth), address(taoWeth), TAO, WETH, USDC);

        // the two pools swapped
        vm.expectRevert(abi.encodeWithSelector(CascadeTwapOracle.BadPool.selector, address(wethUsdc)));
        new CascadeTwapOracle(address(wethUsdc), address(taoWeth), TAO, WETH, USDC);

        // tokens in the wrong order: the quote direction depends on token0 < token1
        vm.expectRevert(abi.encodeWithSelector(CascadeTwapOracle.BadPool.selector, address(wethTao)));
        new CascadeTwapOracle(address(wethTao), address(wethUsdc), TAO, WETH, USDC);

        // a token that is not the expected one
        wethUsdc.setTokens(WETH, address(0xBEEF));
        vm.expectRevert(abi.encodeWithSelector(CascadeTwapOracle.BadPool.selector, address(wethUsdc)));
        new CascadeTwapOracle(address(taoWeth), address(wethUsdc), TAO, WETH, USDC);
    }

    // ---- usdcValue and taoValue ----

    function test_valueAtTickZeroIsOneToOneScaled() public view {
        // tick 0 is a 1:1 price in raw units: 1e18 TAO wei -> 1e18 WETH wei -> 1e18 USDC units, and back
        assertEq(oracle.usdcValue(1e18), 1e18);
        assertEq(oracle.usdcValue(0), 0);
        assertEq(oracle.taoValue(1e18), 1e18);
        assertEq(oracle.taoValue(0), 0);
    }

    function test_valueMatchesSpotForStableTicks() public {
        taoWeth.setTick(LIVE_TAO_WETH_TICK);
        wethUsdc.setTick(LIVE_WETH_USDC_TICK);
        uint256 value = oracle.usdcValue(1e18);
        emit log_named_decimal_uint("1 TAO in USDC", value, 6);
        assertGe(value, 240e6);
        assertLe(value, 265e6);
        // $250 buys about one TAO back
        uint256 tao = oracle.taoValue(250e6);
        emit log_named_decimal_uint("250 USDC in TAO", tao, 18);
        assertGe(tao, 0.94e18);
        assertLe(tao, 1.05e18);
    }

    /// `taoValue` is `usdcValue`'s inverse within each view's rounding, both rounding down (see `checkInverses`
    /// for the bounds): at the live ticks, from a wei to 10^12 TAO and from a USDC unit to 10^12 USDC.
    function test_taoValueInvertsUsdcValue() public {
        uint256[7] memory taoAmounts = [uint256(0), 1, 4.3e9, 1e15, 0.03e18, 1e18, 1e30];
        uint256[7] memory usdcAmounts = [uint256(0), 1, 9, 1e6, 7.5e6, 250e6, 1e18];
        for (uint256 i; i < taoAmounts.length; ++i) {
            checkInverses(LIVE_TAO_WETH_TICK, LIVE_WETH_USDC_TICK, taoAmounts[i], usdcAmounts[i]);
        }
        // the round trip from TAO loses at most about a USDC unit's worth: a 1e18 TAO round trip comes back within
        // 1e-8 of itself
        uint256 back = oracle.taoValue(oracle.usdcValue(1e18));
        emit log_named_uint("1e18 TAO wei -> USDC -> TAO wei", back);
        assertApproxEqRel(back, 1e18, 1e10);
    }

    /// The same bounds at the live ticks for any amount the WETH leg can carry.
    function testFuzz_taoValueInvertsUsdcValueAtTheLiveTicks(uint256 x, uint256 u) public {
        checkInverses(LIVE_TAO_WETH_TICK, LIVE_WETH_USDC_TICK, bound(x, 0, 2 ** 96), bound(u, 0, 2 ** 96));
    }

    /// And at any pair of ticks within a factor of about 4.9e8 of 1:1 (|tick| <= 200,000), for amounts up to 2^64
    /// (so every WETH leg, at most 2^64 * 2^29, stays under 2^128).
    function testFuzz_taoValueInvertsUsdcValue(int24 t1, int24 t2, uint256 x, uint256 u) public {
        t1 = int24(bound(t1, -200_000, 200_000));
        t2 = int24(bound(t2, -200_000, 200_000));
        checkInverses(t1, t2, bound(x, 0, 2 ** 64), bound(u, 0, 2 ** 64));
    }

    // ---- either token order ----

    /// Addresses that sort below WETH (0x4200…0006), where the live TAO and USDC sort above it: with them TAO is
    /// token0 of the TAO/WETH pool, or USDC of the WETH/USDC pool. The oracle reads only the order of the addresses.
    address constant TAO_BELOW_WETH = 0x1000000000000000000000000000000000000001;
    address constant USDC_BELOW_WETH = 0x2000000000000000000000000000000000000002;

    /// Two pools and an oracle over them, in a chosen token order.
    struct Layout {
        MockUniswapPool taoWeth;
        MockUniswapPool wethUsdc;
        CascadeTwapOracle oracle;
        bool taoFirst;
        bool usdcFirst;
    }

    function buildLayout(bool taoFirst, bool usdcFirst) internal returns (Layout memory l) {
        address tao_ = taoFirst ? TAO_BELOW_WETH : TAO;
        address usdc_ = usdcFirst ? USDC_BELOW_WETH : USDC;
        l.taoWeth = taoFirst ? new MockUniswapPool(tao_, WETH) : new MockUniswapPool(WETH, tao_);
        l.wethUsdc = usdcFirst ? new MockUniswapPool(usdc_, WETH) : new MockUniswapPool(WETH, usdc_);
        l.taoWeth.setCardinality(1_801, 1_801);
        l.wethUsdc.setCardinality(1_801, 1_801);
        l.oracle = new CascadeTwapOracle(address(l.taoWeth), address(l.wethUsdc), tao_, WETH, usdc_);
        l.taoFirst = taoFirst;
        l.usdcFirst = usdcFirst;
    }

    function ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a + b - 1) / b;
    }

    /// `checkInverses` for any token order. A pool's tick prices its token1 in its token0 (R / 2^192), so each hop's
    /// rate is R / 2^192 or its inverse, by the pool's order: WETH per TAO a = an / ad, USDC per WETH b = bn / bd.
    /// usdcValue(x) is the two hops rounded down, floor(floor(x a) b): under the exact E = x a b by less than b + 1,
    /// and E lies between the hops rounded down (below) and rounded up (above). Likewise taoValue(u) at the inverse
    /// rates, under E' = u / (a b) by less than 1 / a + 1. Composed, as in `checkInverses`: taoValue(usdcValue(x)) is
    /// at most x and under it by less than 1 + 2 (TAO per WETH) + (TAO per USDC), usdcValue(taoValue(u)) at most u and
    /// under it by less than 1 + 2 (USDC per WETH) + (USDC per TAO). Those prices are bounded here from above, each
    /// rate rounded up (TAO per USDC as the WETH per USDC rounded up, times TAO per WETH, rounded up).
    function checkAnyOrder(Layout memory l, int24 t1, int24 t2, uint256 x, uint256 u) internal {
        l.taoWeth.setTick(t1);
        l.wethUsdc.setTick(t2);
        uint256 q192 = 1 << 192;
        (uint256 an, uint256 ad) = l.taoFirst ? (ratioX192(t1), q192) : (q192, ratioX192(t1));
        (uint256 bn, uint256 bd) = l.usdcFirst ? (q192, ratioX192(t2)) : (ratioX192(t2), q192);

        uint256 usdc = l.oracle.usdcValue(x);
        uint256 above = FullMath.mulDivRoundingUp(FullMath.mulDivRoundingUp(x, an, ad), bn, bd);
        uint256 below = FullMath.mulDiv(FullMath.mulDiv(x, an, ad), bn, bd);
        assertLe(usdc, above, "usdcValue at most the exact value");
        assertGe(usdc, sub0(below, bn / bd + 1), "usdcValue within its rounding");
        uint256 tao = l.oracle.taoValue(u);
        above = FullMath.mulDivRoundingUp(FullMath.mulDivRoundingUp(u, bd, bn), ad, an);
        below = FullMath.mulDiv(FullMath.mulDiv(u, bd, bn), ad, an);
        assertLe(tao, above, "taoValue at most the exact value");
        assertGe(tao, sub0(below, ad / an + 1), "taoValue within its rounding");

        uint256 back = l.oracle.taoValue(usdc);
        assertLe(back, x, "taoValue(usdcValue(x)) <= x");
        uint256 slack = 3 + 2 * ceilDiv(ad, an) + FullMath.mulDivRoundingUp(ceilDiv(bd, bn), ad, an);
        assertGe(back, sub0(x, slack), "taoValue(usdcValue(x)) within the rounding");
        back = l.oracle.usdcValue(tao);
        assertLe(back, u, "usdcValue(taoValue(u)) <= u");
        slack = 3 + 2 * ceilDiv(bn, bd) + FullMath.mulDivRoundingUp(ceilDiv(an, ad), bn, bd);
        assertGe(back, sub0(u, slack), "usdcValue(taoValue(u)) within the rounding");
    }

    /// TAO before WETH in its pool, USDC before WETH in its, and both. At the live market, each reversed pool at the
    /// opposite tick (it quotes the inverse price), every order values 1 TAO at $240 to $265 and $250 at about 1 TAO,
    /// keeps both views within `checkAnyOrder`'s bounds from a wei to 10^12 TAO and from a USDC unit to 10^12 USDC,
    /// and reads each pool's depth as the live order does.
    function test_eitherTokenOrder() public {
        uint256[7] memory taoAmounts = [uint256(0), 1, 4.3e9, 1e15, 0.03e18, 1e18, 1e30];
        uint256[7] memory usdcAmounts = [uint256(0), 1, 9, 1e6, 7.5e6, 250e6, 1e18];
        for (uint256 order = 1; order < 4; ++order) {
            Layout memory l = buildLayout(order & 1 != 0, order & 2 != 0);
            int24 t1 = l.taoFirst ? -LIVE_TAO_WETH_TICK : LIVE_TAO_WETH_TICK;
            int24 t2 = l.usdcFirst ? -LIVE_WETH_USDC_TICK : LIVE_WETH_USDC_TICK;
            for (uint256 i; i < taoAmounts.length; ++i) {
                checkAnyOrder(l, t1, t2, taoAmounts[i], usdcAmounts[i]);
            }
            uint256 value = l.oracle.usdcValue(1e18);
            assertGe(value, 240e6, "1 TAO at least $240");
            assertLe(value, 265e6, "1 TAO at most $265");
            uint256 tao = l.oracle.taoValue(250e6);
            assertGe(tao, 0.94e18, "$250 at least 0.94 TAO");
            assertLe(tao, 1.05e18, "$250 at most 1.05 TAO");

            // the token order plays no part in the depth: test_meanLiquidityIsTheHarmonicMean's levels, its readings
            l.taoWeth.setLiquidity(1e18);
            l.taoWeth.setRecentLiquidity(4e18, 600);
            l.wethUsdc.setLiquidity(3e15);
            l.wethUsdc.setRecentLiquidity(0, 1);
            (uint128 a, uint128 b) = l.oracle.meanLiquidity();
            assertEq(a, 1_333_333_333_333_333_333, "TAO/WETH depth in this order");
            assertEq(b, 1799, "WETH/USDC depth in this order");
        }
    }

    /// Every token order (the live one included) at any pair of ticks with |tick| <= 200,000 and amounts up to 2^64,
    /// as `testFuzz_taoValueInvertsUsdcValue`.
    function testFuzz_eitherTokenOrder(uint8 order, int24 t1, int24 t2, uint256 x, uint256 u) public {
        Layout memory l = buildLayout(order & 1 != 0, order & 2 != 0);
        t1 = int24(bound(t1, -200_000, 200_000));
        t2 = int24(bound(t2, -200_000, 200_000));
        checkAnyOrder(l, t1, t2, bound(x, 0, 2 ** 64), bound(u, 0, 2 ** 64));
    }

    /// Both pools at the same tick: TAO -> WETH divides by the price (TAO is token1), WETH -> USDC multiplies
    /// by it (WETH is token0), so the value comes back to the amount. Covers both quote branches: a sqrt
    /// ratio that fits in 128 bits (|tick| 22227) and one that doesn't (|tick| 500000 > 443636). Amounts keep
    /// the WETH leg under 2^128 (above it the value reverts, see below).
    function test_sameTickOnBothPoolsRoundTrips() public {
        int24[4] memory ticks = [int24(22227), -22227, 500000, -500000];
        uint256[4] memory amounts = [uint256(1e18), 1e18, 1e30, 1e16];
        for (uint256 i; i < ticks.length; ++i) {
            taoWeth.setTick(ticks[i]);
            wethUsdc.setTick(ticks[i]);
            // within 1e-8: at tick 500000 the WETH leg is ~1.9e8 wei, so flooring it costs up to ~5e-9
            assertApproxEqRel(oracle.usdcValue(amounts[i]), amounts[i], 1e10);
            assertApproxEqRel(oracle.taoValue(amounts[i]), amounts[i], 1e10);
        }
    }

    /// OracleLibrary's `consult`: the mean tick rounds toward negative infinity, not toward zero.
    function test_meanTickRoundsTowardNegativeInfinity() public {
        taoWeth.setTick(-1);
        uint256 atMinusOne = oracle.usdcValue(1e18);
        taoWeth.setTick(0);
        uint256 atZero = oracle.usdcValue(1e18);
        assertTrue(atMinusOne != atZero);

        // cumulative delta -1 over 1800 s: -0.0006 rounds down to -1 (truncation would give 0)
        taoWeth.setSpike(-1, 1);
        assertEq(oracle.usdcValue(1e18), atMinusOne);

        // cumulative delta +1 over 1800 s: +0.0006 rounds down to 0
        taoWeth.setSpike(1, 1);
        assertEq(oracle.usdcValue(1e18), atZero);
    }

    /// A spot price pushed far off for one Base block moves the 30-minute value by a sliver of the push.
    function test_shortSpotSpikeBarelyMovesTheValue() public {
        taoWeth.setTick(LIVE_TAO_WETH_TICK);
        wethUsdc.setTick(LIVE_WETH_USDC_TICK);
        uint256 steady = oracle.usdcValue(1e18);

        // TAO 100x cheaper (+46055 ticks) for the last 2 seconds: the mean moves 51 ticks, about 0.5%
        taoWeth.setSpike(LIVE_TAO_WETH_TICK + 46055, 2);
        uint256 spiked = oracle.usdcValue(1e18);
        emit log_named_decimal_uint("steady", steady, 6);
        emit log_named_decimal_uint("after a 2 s 100x spike", spiked, 6);
        assertLt(spiked, steady);
        assertGe(spiked, steady * 99 / 100);
    }

    /// Both views cast their input and their WETH leg to the 128 bits `_quoteAtTick` takes, reverting above.
    function test_amountAboveUint128Reverts() public {
        uint256 tooMuch = uint256(type(uint128).max) + 1;
        vm.expectRevert(abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, 128, tooMuch));
        oracle.usdcValue(tooMuch);
        vm.expectRevert(abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, 128, tooMuch));
        oracle.taoValue(tooMuch);

        // at the live WETH/USDC tick 2^100 USDC units are worth about 2^128.7 WETH wei
        wethUsdc.setTick(LIVE_WETH_USDC_TICK);
        uint256 wethWei = FullMath.mulDiv(1 << 192, 2 ** 100, ratioX192(LIVE_WETH_USDC_TICK));
        assertGt(wethWei, type(uint128).max);
        vm.expectRevert(abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, 128, wethWei));
        oracle.taoValue(2 ** 100);
    }

    // ---- meanLiquidity ----

    /// The harmonic mean, window over the sum of each second's 1 / liquidity, which a thin stretch dominates:
    /// TAO/WETH at 1e18 for 20 minutes then 4e18 for 10 reads 1.333e18 (the arithmetic mean would be 2e18);
    /// WETH/USDC at 3e15 with one second of an empty range (0, which the pool counts as 1) reads under 1,800.
    function test_meanLiquidityIsTheHarmonicMean() public {
        taoWeth.setLiquidity(1e18);
        taoWeth.setRecentLiquidity(4e18, 600);
        wethUsdc.setLiquidity(3e15);
        wethUsdc.setRecentLiquidity(0, 1);

        (uint128 a, uint128 b) = oracle.meanLiquidity();
        emit log_named_uint("TAO/WETH mean liquidity", a);
        emit log_named_uint("WETH/USDC mean liquidity", b);
        assertEq(a, 1_333_333_333_333_333_333, "TAO/WETH: 1800 / (1200 / 1e18 + 600 / 4e18)");
        checkHarmonic(a, 1200, 1e18, 600, 4e18, "TAO/WETH");
        assertEq(b, 1799, "WETH/USDC: 1800 / (1799 / 3e15 + 1 / 1)");
        checkHarmonic(b, 1799, 3e15, 1, 0, "WETH/USDC");

        // a steady level reads as itself
        taoWeth.setLiquidity(5e20);
        wethUsdc.setLiquidity(7e17);
        (a, b) = oracle.meanLiquidity();
        assertEq(a, 5e20);
        assertEq(b, 7e17);
    }

    /// Any two levels over any split of the window, each pool read on its own.
    function testFuzz_meanLiquidityIsTheHarmonicMean(uint128 la, uint128 lb, uint32 tb, uint128 lc) public {
        tb = uint32(bound(tb, 0, WINDOW));
        taoWeth.setLiquidity(la);
        taoWeth.setRecentLiquidity(lb, tb);
        wethUsdc.setLiquidity(lc);
        (uint128 a, uint128 b) = oracle.meanLiquidity();
        checkHarmonic(a, WINDOW - tb, la, tb, lb, "TAO/WETH");
        checkHarmonic(b, WINDOW, lc, 0, 1, "WETH/USDC");
    }

    /// The largest liquidity a pool can hold reads as itself: each second adds at least 1 to the
    /// seconds-per-liquidity cumulative, so the window's growth is at least 1,800 and OracleLibrary's product
    /// T * (2^160 - 1) (not a shift, T << 160) keeps the mean at 2^128 - 1 at most. A growth below the window, which
    /// only a liquidity above 2^128 - 1 gives (a reading no pool makes; the mock's), would mean more than 2^128 - 1:
    /// the oracle reverts there, where OracleLibrary's cast would wrap it to a small number.
    function test_meanLiquidityAtTheUint128Limit() public {
        taoWeth.setLiquidity(type(uint128).max);
        // where the growth is exact (here 3,600 at 2^127) the product's 2^160 - 1 reads one below
        wethUsdc.setLiquidity(1 << 127);
        (uint128 a, uint128 b) = oracle.meanLiquidity();
        assertEq(a, type(uint128).max);
        assertEq(b, (1 << 127) - 1);

        // 1.5 x 2^128 for the window: a growth of 1,200 and a mean of 1.5 x 2^128 - 1
        MockUniswapPool[2] memory pools = [taoWeth, wethUsdc];
        for (uint256 i; i < 2; ++i) {
            pools[i].setLiquidity(3 << 127);
            vm.expectRevert(
                abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, 128, (3 << 127) - 1)
            );
            oracle.meanLiquidity();
            pools[i].setLiquidity(1e18);
        }
    }

    /// A window with no seconds-per-liquidity growth (again a reading no pool makes: here a mock liquidity above
    /// 1,800 x 2^128) divides by zero, as in OracleLibrary: the view reverts (Panic 0x12), never answers.
    function test_meanLiquidityRevertsOnZeroGrowth() public {
        MockUniswapPool[2] memory pools = [taoWeth, wethUsdc];
        for (uint256 i; i < 2; ++i) {
            pools[i].setLiquidity(1 << 140);
            vm.expectRevert(stdError.divisionError);
            oracle.meanLiquidity();
            pools[i].setLiquidity(1e18);
        }
        // the price views read no liquidity: a pool with no growth still prices
        taoWeth.setLiquidity(1 << 140);
        assertEq(oracle.usdcValue(1e18), 1e18);
        assertEq(oracle.taoValue(1e18), 1e18);
    }

    // ---- the window ----

    /// Review Focus 5, and section 3.7's "no staleness revert": a pool whose history doesn't reach 30 minutes makes
    /// every view revert, never fall back to a shorter window; exactly 30 minutes of history is enough, however
    /// long ago the pool last traded.
    function test_oldHistoryStillReverts() public {
        taoWeth.setTick(LIVE_TAO_WETH_TICK);
        wethUsdc.setTick(LIVE_WETH_USDC_TICK);
        taoWeth.setLiquidity(1e18);
        wethUsdc.setLiquidity(1e18);

        MockUniswapPool[2] memory pools = [taoWeth, wethUsdc];
        for (uint256 i; i < 2; ++i) {
            pools[i].setHistory(1799);
            vm.expectRevert(bytes("OLD"));
            oracle.usdcValue(1e18);
            vm.expectRevert(bytes("OLD"));
            oracle.taoValue(250e6);
            vm.expectRevert(bytes("OLD"));
            oracle.meanLiquidity();
            pools[i].setHistory(1800);
        }

        assertGt(oracle.usdcValue(1e18), 0);
        assertGt(oracle.taoValue(250e6), 0);
        (uint128 a, uint128 b) = oracle.meanLiquidity();
        assertEq(a, 1e18);
        assertEq(b, 1e18);
    }
}
