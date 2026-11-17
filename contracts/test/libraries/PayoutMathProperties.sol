// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {CascadePayoutMath} from "../../src/libraries/CascadePayoutMath.sol";
import {FeeTooHigh} from "../../src/CascadeErrors.sol";

/// @notice The fee valve's properties (spec §3.3, Task 21) over CascadePayoutMath, one body each, asserted by forge's
/// fuzzer (CascadePayoutMath.t.sol's testFuzz_ cases, inputs bound()ed) and by Halmos (test/halmos/, symbolic inputs).
/// Plain `assert`, which both read.
abstract contract PayoutMathProperties is Test {
    uint256 internal constant RAO_WEI = 1e9;

    /// feeSplit: the fee is the quote rounded up to whole rao; the entries are charged whole rao, never more than the
    /// fee nor the ceiling (the larger of maxFeeBps of the chunk and maxFeeAbs); all of the fee when it is within the
    /// ceiling, and otherwise the ceiling floored to rao (the caller tops up the rest).
    function feeSplitHolds(uint256 quote, uint256 sum, uint256 bps, uint256 abs_) internal pure {
        (uint256 fee, uint256 charged) = CascadePayoutMath.feeSplit(quote, sum, bps, abs_);
        uint256 part = sum * bps / 10_000;
        uint256 ceiling = part > abs_ ? part : abs_;
        assert(fee % RAO_WEI == 0 && charged % RAO_WEI == 0);
        assert(fee >= quote && fee - quote < RAO_WEI);
        assert(charged <= fee && charged <= ceiling);
        if (fee <= ceiling) assert(charged == fee);
        else assert(ceiling - charged < RAO_WEI);
    }

    /// deductFee over a two-entry chunk (users 0xA and 0xB), `sum` its gross as takeChunk returns it: either it
    /// returns, each entry once, kept at a positive whole-rao net no more than its gross or dust at its gross, dust
    /// only for an entry with no shares (I-14), with net their total and net + charged within the chunk whenever
    /// anything is kept (what the vault pays never exceeds what the chunk reserved); or it reverts FeeTooHigh and
    /// nothing else, and only when an entry with shares nets 0.
    function deductFeeHolds(uint256 a0, uint256 a1, bool shares0, bool shares1, uint256 charged) internal view {
        uint256 sum = a0 + a1;
        CascadeMessages.Payout[] memory p = new CascadeMessages.Payout[](2);
        p[0] = CascadeMessages.Payout(address(0xA), shares0 ? 1 : 0, a0);
        p[1] = CascadeMessages.Payout(address(0xB), shares1 ? 1 : 0, a1);
        try this.deduct(p, charged, sum) returns (
            CascadeMessages.Entry[] memory kept, CascadeMessages.Entry[] memory dust, uint256 net
        ) {
            assert(kept.length + dust.length == 2);
            uint256 total;
            for (uint256 i; i < kept.length; ++i) {
                assert(kept[i].user == address(0xA) || kept[i].user == address(0xB));
                uint256 gross = kept[i].user == address(0xA) ? a0 : a1;
                assert(kept[i].amount != 0 && kept[i].amount % RAO_WEI == 0 && kept[i].amount <= gross);
                total += kept[i].amount;
            }
            for (uint256 i; i < dust.length; ++i) {
                assert(
                    dust[i].user == address(0xA) ? !shares0 && dust[i].amount == a0 : !shares1 && dust[i].amount == a1
                );
            }
            assert(net == total);
            if (net != 0) assert(net + charged <= sum);
        } catch (bytes memory err) {
            assert(keccak256(err) == keccak256(abi.encodeWithSelector(FeeTooHigh.selector)));
            assert((shares0 && netOf(a0, charged, sum) == 0) || (shares1 && netOf(a1, charged, sum) == 0));
        }
    }

    /// deductFee from the cursor 0 over all of `p`, external so that the library gets its list as calldata.
    function deduct(CascadeMessages.Payout[] calldata p, uint256 charged, uint256 sum)
        external
        pure
        returns (CascadeMessages.Entry[] memory, CascadeMessages.Entry[] memory, uint256)
    {
        return CascadePayoutMath.deductFee(p, 0, p.length, charged, sum);
    }

    /// An entry's net under deductFee's rule (spec §3.3): its gross less ceil(gross * charged / sum), at least 0,
    /// floored to rao.
    function netOf(uint256 gross, uint256 charged, uint256 sum) internal pure returns (uint256 a) {
        uint256 fee = (gross * charged + sum - 1) / sum;
        a = gross > fee ? gross - fee : 0;
        a -= a % RAO_WEI;
    }
}
