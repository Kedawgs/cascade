// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {CascadePayoutMath} from "../../src/libraries/CascadePayoutMath.sol";
import {PayoutMathProperties} from "../libraries/PayoutMathProperties.sol";

/// @notice Halmos symbolic proofs of CascadePayoutMath's pure fee math (Task 21's extra step, the controller's ruling):
/// the fee valve's split (feeSplit), the split over a chunk's entries (deductFee) and the chunk itself (takeChunk).
/// Every input is symbolic within the stated bounds; the lists are two entries long (deductFee) or three (takeChunk).
/// The first two share their bodies with forge's fuzz cases (PayoutMathProperties, CascadePayoutMath.t.sol).
/// forge runs none of these (check_ is not a test prefix). Run from contracts/:
/// `halmos --contract PayoutMathHalmos --loop 4 --solver-threads 2`.
/// Status (Task 21, Halmos 0.3.3 with yices on the dev machine): check_takeChunkSumsItsEntriesWithinTheBatch passes
/// (125 paths). The other two do not finish: their solver queries carry symbolic 256-bit multiplications (OpenZeppelin
/// Math's branchless min, max and ternary multiply by a condition; deductFee's mulDiv is 512-bit), which ran yices to
/// several GB without an answer. They need a bit-vector solver such as bitwuzla, or a longer run; until then the
/// fuzz cases (fix round 1) hold the same properties on sampled inputs. Task 42 retried both at narrowed input widths
/// (the _narrow checks below), yices only (no new solver), with a 12-minute query timeout and a 15-minute cap each:
/// check_feeSplitChargesAtMostTheCeiling_narrow40 timed out (23 paths, 778 s) and
/// check_deductFeeKeepsWithinTheChunk_narrow16 reached its cap (one query past 5 GB); the wider _narrow64 and
/// _narrow32 were stopped once those had failed. Narrowing the inputs does not narrow the queries: the multiplications
/// stay 256-bit (mulDiv's 512) whatever the inputs' width. The four stay as the retry for a bit-vector solver.
contract PayoutMathHalmos is PayoutMathProperties {
    uint256 constant MAX_FEE_BPS = 500;
    uint256 constant MIN_FEE_ABS = 0.01e18;
    uint256 constant MAX_FEE_ABS = 0.015e18;

    address constant A = address(0xA);
    address constant B = address(0xB);
    address constant C = address(0xC);

    /// The fee ceiling (spec §3.3), feeSplitHolds: for any quote, chunk and absolute ceiling the bounds allow, and
    /// maxFeeBps at 0, the launch's 100 and the bound's 500 (concrete, so the solver multiplies by a constant).
    function check_feeSplitChargesAtMostTheCeiling(uint128 quote, uint128 sum, uint64 abs_) public pure {
        vm.assume(abs_ >= MIN_FEE_ABS && abs_ <= MAX_FEE_ABS);
        uint256[3] memory bpsSet = [uint256(0), 100, MAX_FEE_BPS];
        for (uint256 k; k < 3; ++k) {
            feeSplitHolds(quote, sum, bpsSet[k], abs_);
        }
    }

    /// The fee split over a two-entry chunk, deductFeeHolds, for any amounts, shares and share `charged`.
    function check_deductFeeKeepsWithinTheChunkAndDustHasNoShares(
        uint64 a0,
        uint64 a1,
        bool shares0,
        bool shares1,
        uint64 charged
    ) public view {
        vm.assume(uint256(a0) + a1 != 0);
        deductFeeHolds(a0, a1, shares0, shares1, charged);
    }

    // ---- narrowed widths (Task 42: the two that did not finish, retried with no new solver; see Status) ----

    /// feeSplitHolds at 64-bit quotes and chunks (up to about 18.4 TAO; the absolute ceiling's whole bound), and at
    /// 40-bit ones (up to about 0.0000011 TAO, below the ceiling's floor: the absolute part always binds).
    function check_feeSplitChargesAtMostTheCeiling_narrow64(uint64 quote, uint64 sum, uint64 abs_) public pure {
        vm.assume(abs_ >= MIN_FEE_ABS && abs_ <= MAX_FEE_ABS);
        uint256[3] memory bpsSet = [uint256(0), 100, MAX_FEE_BPS];
        for (uint256 k; k < 3; ++k) {
            feeSplitHolds(quote, sum, bpsSet[k], abs_);
        }
    }

    function check_feeSplitChargesAtMostTheCeiling_narrow40(uint40 quote, uint40 sum, uint64 abs_) public pure {
        vm.assume(abs_ >= MIN_FEE_ABS && abs_ <= MAX_FEE_ABS);
        uint256[3] memory bpsSet = [uint256(0), 100, MAX_FEE_BPS];
        for (uint256 k; k < 3; ++k) {
            feeSplitHolds(quote, sum, bpsSet[k], abs_);
        }
    }

    /// deductFeeHolds at 32-bit and 16-bit amounts and charge.
    function check_deductFeeKeepsWithinTheChunk_narrow32(
        uint32 a0,
        uint32 a1,
        bool shares0,
        bool shares1,
        uint32 charged
    ) public view {
        vm.assume(uint256(a0) + a1 != 0);
        deductFeeHolds(a0, a1, shares0, shares1, charged);
    }

    function check_deductFeeKeepsWithinTheChunk_narrow16(
        uint16 a0,
        uint16 a1,
        bool shares0,
        bool shares1,
        uint16 charged
    ) public view {
        vm.assume(uint256(a0) + a1 != 0);
        deductFeeHolds(a0, a1, shares0, shares1, charged);
    }

    /// The chunk from each cursor of a three-entry list (the cursor concrete: a symbolic calldata offset is beyond
    /// Halmos), for any limit, cap and minChunk: at least one entry, the list's entries in order at their gross value
    /// from the cursor, `sum` their total, within the list's rest (the batch's remaining), and within the cap
    /// whenever more than the first entry is taken.
    function check_takeChunkSumsItsEntriesWithinTheBatch(
        uint64 a0,
        uint64 a1,
        uint64 a2,
        uint8 limit,
        uint64 cap,
        uint8 minChunk
    ) public view {
        vm.assume(limit >= 1);
        CascadeMessages.Payout[] memory p = new CascadeMessages.Payout[](3);
        p[0] = CascadeMessages.Payout(A, 1, a0);
        p[1] = CascadeMessages.Payout(B, 1, a1);
        p[2] = CascadeMessages.Payout(C, 1, a2);
        for (uint256 start; start < 3; ++start) {
            (CascadeMessages.Entry[] memory e, uint256 sum) = this.chunk(p, start, limit, cap, minChunk);
            assert(e.length >= 1 && start + e.length <= 3);
            uint256 total;
            for (uint256 j; j < e.length; ++j) {
                assert(e[j].user == p[start + j].user && e[j].amount == p[start + j].assets);
                total += e[j].amount;
            }
            uint256 rest;
            for (uint256 i = start; i < 3; ++i) {
                rest += p[i].assets;
            }
            assert(sum == total && sum <= rest);
            if (e.length > 1) assert(sum <= cap);
        }
    }

    // ---- the calls, external so that the library gets its lists as calldata ----

    function chunk(CascadeMessages.Payout[] calldata p, uint256 start, uint256 limit, uint256 cap, uint256 minChunk)
        external
        pure
        returns (CascadeMessages.Entry[] memory, uint256)
    {
        return CascadePayoutMath.takeChunk(p, start, limit, cap, minChunk);
    }
}
