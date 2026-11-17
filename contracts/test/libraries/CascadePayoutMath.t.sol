// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {CascadePayoutMath} from "../../src/libraries/CascadePayoutMath.sol";
import {FeeTooHigh, PayoutsMismatch} from "../../src/CascadeErrors.sol";
import {PayoutMathProperties} from "./PayoutMathProperties.sol";

/// @notice The vault's payout math on its own. Each case's values are copied from the vault case in
/// test/vault/VaultPayouts.t.sol that it names, so the library answers what the vault did in v3.1.
contract CascadePayoutMathTest is PayoutMathProperties {
    uint256 constant MAX = CascadeMessages.MAX_ENTRIES;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    // ---- helpers ----

    function pay1(address u, uint256 s, uint256 a) internal pure returns (CascadeMessages.Payout[] memory p) {
        p = new CascadeMessages.Payout[](1);
        p[0] = CascadeMessages.Payout(u, s, a);
    }

    function pay2(address u1, uint256 s1, uint256 a1, address u2, uint256 s2, uint256 a2)
        internal
        pure
        returns (CascadeMessages.Payout[] memory p)
    {
        p = new CascadeMessages.Payout[](2);
        p[0] = CascadeMessages.Payout(u1, s1, a1);
        p[1] = CascadeMessages.Payout(u2, s2, a2);
    }

    /// queueThree's list: alice, bob and carol, 6e25 shares and 60e18 each.
    function three() internal view returns (CascadeMessages.Payout[] memory p) {
        p = new CascadeMessages.Payout[](3);
        p[0] = CascadeMessages.Payout(alice, 6e25, 60e18);
        p[1] = CascadeMessages.Payout(bob, 6e25, 60e18);
        p[2] = CascadeMessages.Payout(carol, 6e25, 60e18);
    }

    /// queueEleven's list (`n` holders here): 1e24 shares and 1e18 each.
    function many(uint256 n) internal returns (CascadeMessages.Payout[] memory p) {
        p = new CascadeMessages.Payout[](n);
        for (uint256 i; i < n; ++i) {
            p[i] = CascadeMessages.Payout(makeAddr(string.concat("holder", vm.toString(i))), 1e24, 1e18);
        }
    }

    function hashOf(CascadeMessages.Payout[] memory p) internal pure returns (bytes32 h) {
        for (uint256 i; i < p.length; ++i) {
            h = CascadePayoutMath.hashStep(h, p[i].user, p[i].shares, p[i].assets);
        }
    }

    function assertEntry(CascadeMessages.Entry memory e, address user, uint256 amount) internal pure {
        assertEq(e.user, user, "user");
        assertEq(e.amount, amount, "amount");
    }

    /// The entries `p[start..start + n)` at their gross value.
    function assertGross(CascadeMessages.Entry[] memory e, CascadeMessages.Payout[] memory p, uint256 start, uint256 n)
        internal
        pure
    {
        assertEq(e.length, n, "length");
        for (uint256 j; j < n; ++j) {
            assertEntry(e[j], p[start + j].user, p[start + j].assets);
        }
    }

    // ---- hashStep and verify ----

    /// test_processPayouts_wrongListReverts and test_cancelPayoutBatch_wrongListReverts: batch K is alice's
    /// (1e26 shares, 100e18).
    function test_verifyRejectsLengthAndHash() public {
        bytes32 h = keccak256(abi.encode(bytes32(0), alice, uint256(1e26), uint256(100e18)));
        assertEq(CascadePayoutMath.hashStep(bytes32(0), alice, 1e26, 100e18), h, "hashStep");
        assertEq(
            CascadePayoutMath.hashStep(h, bob, 0, 1e9),
            keccak256(abi.encode(h, bob, uint256(0), uint256(1e9))),
            "chained"
        );

        // the right list passes
        CascadePayoutMath.verify(pay1(alice, 1e26, 100e18), 1, h);

        // wrong user, wrong shares, wrong assets
        vm.expectRevert(PayoutsMismatch.selector);
        CascadePayoutMath.verify(pay1(bob, 1e26, 100e18), 1, h);
        vm.expectRevert(PayoutsMismatch.selector);
        CascadePayoutMath.verify(pay1(alice, 1e26 + 1, 100e18), 1, h);
        vm.expectRevert(PayoutsMismatch.selector);
        CascadePayoutMath.verify(pay1(alice, 1e26, 100e18 + 1), 1, h);

        // wrong length: the right entry twice, or nothing
        vm.expectRevert(PayoutsMismatch.selector);
        CascadePayoutMath.verify(pay2(alice, 1e26, 100e18, alice, 1e26, 100e18), 1, h);
        vm.expectRevert(PayoutsMismatch.selector);
        CascadePayoutMath.verify(new CascadeMessages.Payout[](0), 1, h);

        // the length is checked against the count, not only through the hash: the two-entry list with its
        // own hash still fails a count of 1
        CascadeMessages.Payout[] memory two = pay2(alice, 1e26, 100e18, alice, 1e26, 100e18);
        CascadePayoutMath.verify(two, 2, hashOf(two));
        vm.expectRevert(PayoutsMismatch.selector);
        CascadePayoutMath.verify(two, 1, hashOf(two));

        // an empty batch hashes to zero
        CascadePayoutMath.verify(new CascadeMessages.Payout[](0), 0, bytes32(0));
    }

    // ---- takeChunk ----

    /// test_processPayouts_oversizedFirstEntryStillTaken: setMessageLimits(50e18, 50e18, 10), a stranger
    /// (limit MAX_ENTRIES) sends alice's 60e18 alone.
    function test_takeChunkAlwaysTakesTheFirstEntryAboveCap() public view {
        (CascadeMessages.Entry[] memory e, uint256 sum) =
            CascadePayoutMath.takeChunk(pay1(alice, 6e25, 60e18), 0, MAX, 50e18, 10);
        assertEq(sum, 60e18, "sum");
        assertEq(e.length, 1, "length");
        assertEntry(e[0], alice, 60e18);

        // with more behind it, only the first goes: 60e18 + 60e18 > 50e18, and the tail (two entries,
        // fewer than minChunk) does not fit either
        CascadeMessages.Payout[] memory p = three();
        (e, sum) = CascadePayoutMath.takeChunk(p, 0, MAX, 50e18, 10);
        assertEq(sum, 60e18, "sum of three");
        assertGross(e, p, 0, 1);
        // and from a later cursor
        (e, sum) = CascadePayoutMath.takeChunk(p, 1, MAX, 50e18, 10);
        assertEq(sum, 60e18, "sum from 1");
        assertGross(e, p, 1, 1);
    }

    function test_takeChunkStopsAtLimitAndCap() public {
        CascadeMessages.Payout[] memory p = three();

        // test_processPayouts_chunksByMessageValue: setMessageLimits(150e18, 150e18, 1), limit MAX_ENTRIES:
        // 60e18 + 60e18 = 120e18 <= 150e18, a third would exceed it; then carol alone
        (CascadeMessages.Entry[] memory e, uint256 sum) = CascadePayoutMath.takeChunk(p, 0, MAX, 150e18, 1);
        assertEq(sum, 120e18, "cap: sum");
        assertGross(e, p, 0, 2);
        (e, sum) = CascadePayoutMath.takeChunk(p, 2, MAX, 150e18, 1);
        assertEq(sum, 60e18, "cap: rest");
        assertGross(e, p, 2, 1);

        // test_processPayouts_keeperChoosesChunkSize: setMessageLimits(2_000e18, 4_000e18, 1); the keeper's
        // maxEntries 1 makes the limit 1; a stranger then gets the rest
        (e, sum) = CascadePayoutMath.takeChunk(p, 0, 1, 4_000e18, 1);
        assertEq(sum, 60e18, "limit 1: sum");
        assertGross(e, p, 0, 1);
        (e, sum) = CascadePayoutMath.takeChunk(p, 1, MAX, 4_000e18, 1);
        assertEq(sum, 120e18, "limit MAX: rest");
        assertGross(e, p, 1, 2);

        // test_processPayouts_maxEntriesRaisedToMinChunk: setMessageLimits(120e18, 120e18, 2); the keeper's
        // maxEntries 1 is raised to minChunk 2 by the vault, and the third entry is not folded in (180e18 >
        // 120e18); then the last entry alone
        (e, sum) = CascadePayoutMath.takeChunk(p, 0, 2, 120e18, 2);
        assertEq(sum, 120e18, "limit 2: sum");
        assertGross(e, p, 0, 2);
        (e, sum) = CascadePayoutMath.takeChunk(p, 2, 2, 120e18, 2);
        assertEq(sum, 60e18, "limit 2: rest");
        assertGross(e, p, 2, 1);

        // test_processPayouts_strangerSendsLargestChunk: setMessageLimits(2_000e18, 4_000e18, 1), all three
        (e, sum) = CascadePayoutMath.takeChunk(p, 0, MAX, 4_000e18, 1);
        assertEq(sum, 180e18, "stranger: sum");
        assertGross(e, p, 0, 3);

        // MAX_ENTRIES + 5 entries of 1e18 at the launch defaults: the chunk stops at MAX_ENTRIES
        CascadeMessages.Payout[] memory big = many(MAX + 5);
        (e, sum) = CascadePayoutMath.takeChunk(big, 0, MAX, 4_000e18, 1);
        assertEq(sum, MAX * 1e18, "MAX_ENTRIES: sum");
        assertGross(e, big, 0, MAX);
    }

    function test_takeChunkFoldsAShortTail() public {
        CascadeMessages.Payout[] memory p = many(11);

        // test_processPayouts_shortTailFoldedIntoChunk: the keeper's maxEntries 10 (= minChunk) would leave one
        // entry, fewer than minChunk; it fits within 4_000e18 and MAX_ENTRIES, so all 11 go
        (CascadeMessages.Entry[] memory e, uint256 sum) = CascadePayoutMath.takeChunk(p, 0, 10, 4_000e18, 10);
        assertEq(sum, 11e18, "folded: sum");
        assertGross(e, p, 0, 11);

        // test_processPayouts_tailOverMessageValueNotFolded: setMessageLimits(10e18, 10.5e18, 10); ten
        // entries make 10e18, with the eleventh 11e18 > 10.5e18, so the tail waits; then it goes alone
        (e, sum) = CascadePayoutMath.takeChunk(p, 0, 10, 10.5e18, 10);
        assertEq(sum, 10e18, "over cap: sum");
        assertGross(e, p, 0, 10);
        (e, sum) = CascadePayoutMath.takeChunk(p, 10, 10, 10.5e18, 10);
        assertEq(sum, 1e18, "over cap: tail");
        assertGross(e, p, 10, 1);

        // a tail of minChunk or more is not folded: minChunk 1 leaves the eleventh behind
        (e, sum) = CascadePayoutMath.takeChunk(p, 0, 10, 4_000e18, 1);
        assertEq(sum, 10e18, "minChunk 1: sum");
        assertGross(e, p, 0, 10);

        // the folded chunk must stay within MAX_ENTRIES: MAX_ENTRIES + 5 entries, the stranger's limit MAX_ENTRIES
        // leaves five (fewer than minChunk 10), but all of them would be over MAX_ENTRIES, so they wait
        CascadeMessages.Payout[] memory big = many(MAX + 5);
        (e, sum) = CascadePayoutMath.takeChunk(big, 0, MAX, 4_000e18, 10);
        assertEq(sum, MAX * 1e18, "over MAX_ENTRIES: sum");
        assertGross(e, big, 0, MAX);
        // at the boundary: from cursor 5 a limit of MAX_ENTRIES - 5 leaves five, and together they are exactly
        // MAX_ENTRIES, so they fold; from cursor 4 they would be one over, and the limit holds
        (e, sum) = CascadePayoutMath.takeChunk(big, 5, MAX - 5, 4_000e18, 10);
        assertEq(sum, MAX * 1e18, "exactly MAX_ENTRIES: sum");
        assertGross(e, big, 5, MAX);
        (e, sum) = CascadePayoutMath.takeChunk(big, 4, MAX - 5, 4_000e18, 10);
        assertEq(sum, (MAX - 5) * 1e18, "one over MAX_ENTRIES: sum");
        assertGross(e, big, 4, MAX - 5);
        (e, sum) = CascadePayoutMath.takeChunk(big, MAX - 5, 9, 4_000e18, 10);
        assertEq(sum, 10e18, "from MAX_ENTRIES - 5, limit 9, a one-entry tail folded: sum");
        assertGross(e, big, MAX - 5, 10);
    }

    // ---- deductFee ----

    function test_deductFeeCeilsEachShareAndFloorsToRao() public view {
        // test_processPayouts_feeRoundingRemainderStaysInVault: sum 3e18, fee 1e15. alice: ceil(1e18 * 1e15 /
        // 3e18) = 333_333_333_333_334, leaving 999_666_666_666_666_666, floored to 999_666_666_000_000_000;
        // bob: ceil(2e18 * 1e15 / 3e18) = 666_666_666_666_667, leaving 1_999_333_333_333_333_333, floored to
        // 1_999_333_333_000_000_000
        CascadeMessages.Payout[] memory p = pay2(alice, 1e24, 1e18, bob, 2e24, 2e18);
        (CascadeMessages.Entry[] memory kept, CascadeMessages.Entry[] memory dust, uint256 net) =
            CascadePayoutMath.deductFee(p, 0, 2, 1e15, 3e18);
        assertEq(net, 2_998_999_999_000_000_000, "net");
        assertEq(kept.length, 2, "kept");
        assertEntry(kept[0], alice, 999_666_666_000_000_000);
        assertEntry(kept[1], bob, 1_999_333_333_000_000_000);
        assertEq(dust.length, 0, "dust");

        // test_processPayouts_subRaoFeeRoundsUpToWholeRao: the vault rounds the quote 1e15 + 1 up to
        // 1_000_001_000_000_000; 100e18 less that is rao-aligned already
        (kept, dust, net) = CascadePayoutMath.deductFee(pay1(alice, 1e26, 100e18), 0, 1, 1_000_001_000_000_000, 100e18);
        assertEq(net, 99_998_999_999_000_000_000, "sub-rao: net");
        assertEq(kept.length, 1, "sub-rao: kept");
        assertEntry(kept[0], alice, 99_998_999_999_000_000_000);
        assertEq(dust.length, 0, "sub-rao: dust");

        // test_processPayouts_strangerSendsLargestChunk: each of three pays ceil(60e18 * 1e15 / 180e18) =
        // 333_333_333_333_334 and floors to 59_999_666_666_000_000_000
        p = three();
        (kept, dust, net) = CascadePayoutMath.deductFee(p, 0, 3, 1e15, 180e18);
        assertEq(net, 179_998_999_998_000_000_000, "three: net");
        assertEq(kept.length, 3, "three: kept");
        assertEntry(kept[0], alice, 59_999_666_666_000_000_000);
        assertEntry(kept[1], bob, 59_999_666_666_000_000_000);
        assertEntry(kept[2], carol, 59_999_666_666_000_000_000);
        assertEq(dust.length, 0, "three: dust");

        // test_processPayouts_chunksByMessageValue: the chunk is taken from the cursor. Chunk 0 is alice and
        // bob (5e14 each), chunk 1 is carol alone (the whole 1e15)
        (kept, dust, net) = CascadePayoutMath.deductFee(p, 0, 2, 1e15, 120e18);
        assertEq(net, 119_999e15, "chunk 0: net");
        assertEq(kept.length, 2, "chunk 0: kept");
        assertEntry(kept[0], alice, 59_999_500_000_000_000_000);
        assertEntry(kept[1], bob, 59_999_500_000_000_000_000);
        (kept, dust, net) = CascadePayoutMath.deductFee(p, 2, 1, 1e15, 60e18);
        assertEq(net, 59_999e15, "chunk 1: net");
        assertEq(kept.length, 1, "chunk 1: kept");
        assertEntry(kept[0], carol, 59_999e15);
        assertEq(dust.length, 0, "chunk 1: dust");
    }

    function test_deductFeeReturnsZeroNetEntriesAsDust() public view {
        // test_processPayouts_individualDustEntryDropped: sum = 1_666_666_667e9, fee 1e15. bob's bounce:
        // ceil(1e9 * 1e15 / sum) = 600_000, 999_400_000 floors to 0, dust at its gross 1e9. alice:
        // ceil(1_666_666_666e9 * 1e15 / sum) = 999_999_999_400_001, leaving 1_665_666_666_000_599_999, floored
        // to 1_665_666_666e9
        CascadeMessages.Payout[] memory p = pay2(bob, 0, 1e9, alice, 5e24, 1_666_666_666e9);
        (CascadeMessages.Entry[] memory kept, CascadeMessages.Entry[] memory dust, uint256 net) =
            CascadePayoutMath.deductFee(p, 0, 2, 1e15, 1_666_666_667e9);
        assertEq(net, 1_665_666_666e9, "net");
        assertEq(kept.length, 1, "kept");
        assertEntry(kept[0], alice, 1_665_666_666e9);
        assertEq(dust.length, 1, "dust");
        assertEntry(dust[0], bob, 1e9);

        // test_processPayouts_dustTailCompletesBatch: bob's 1e16 bounce (0 shares) charged the 0.015e18 ceiling nets
        // nothing: no entry is kept and the whole chunk is dust
        (kept, dust, net) = CascadePayoutMath.deductFee(pay1(bob, 0, 1e16), 0, 1, 15e15, 1e16);
        assertEq(net, 0, "all dust: net");
        assertEq(kept.length, 0, "all dust: kept");
        assertEq(dust.length, 1, "all dust: dust");
        assertEntry(dust[0], bob, 1e16);

        // every entry of a chunk worth no more than its fee is dust, in order, when none has shares
        p = three();
        for (uint256 i; i < p.length; ++i) {
            p[i].shares = 0;
        }
        (kept, dust, net) = CascadePayoutMath.deductFee(p, 0, 3, 180e18, 180e18);
        assertEq(net, 0, "three: net");
        assertEq(kept.length, 0, "three: kept");
        assertGross(dust, p, 0, 3);
    }

    /// An entry with shares is never finalised at zero (spec §3.3, I-14, Task 21): one its fee share would leave with
    /// nothing reverts the chunk FeeTooHigh, wherever it sits; v3.1 dropped it as dust. One left with a rao is kept.
    function test_deductFeeRevertsWhenAnEntryWithSharesNetsZero() public {
        // v3.1's test_processPayouts_dustTailCompletesBatch: bob's burned 1e16 under a 2e16 fee
        vm.expectRevert(FeeTooHigh.selector);
        CascadePayoutMath.deductFee(pay1(bob, 1e22, 1e16), 0, 1, 2e16, 1e16);
        // v3.1's all-dust chunk of three burned entries
        vm.expectRevert(FeeTooHigh.selector);
        CascadePayoutMath.deductFee(three(), 0, 3, 180e18, 180e18);
        // behind a bounce that is dust: the bounce alone would pass, the burned entry after it does not
        vm.expectRevert(FeeTooHigh.selector);
        CascadePayoutMath.deductFee(pay2(bob, 0, 1e9, alice, 5e24, 1e9), 0, 2, 2e9, 2e9);
        // left with exactly one rao, an entry with shares is kept
        (CascadeMessages.Entry[] memory kept, CascadeMessages.Entry[] memory dust, uint256 net) =
            CascadePayoutMath.deductFee(pay1(bob, 1e22, 1e16), 0, 1, 1e16 - 1e9, 1e16);
        assertEq(net, 1e9, "one rao: net");
        assertEq(dust.length, 0, "one rao: dust");
        assertEntry(kept[0], bob, 1e9);
    }

    // ---- feeSplit (the fee valve, Task 21) ----

    /// The fee is the quote rounded up to rao; the entries are charged at most the ceiling, the larger of maxFeeBps
    /// of the chunk and maxFeeAbs, floored to rao; the caller tops up the difference. Each case is a vault case's.
    function test_feeSplitChargesAtMostTheCeiling() public pure {
        // test_lonelyChunkWithA002Fee: 3e16 at 1% / 0.015 TAO, a 2e16 quote: the ceiling is 1.5e16 (the 3e14 bps
        // part is smaller), so the entries are charged 1.5e16 and the caller tops up 5e15
        (uint256 fee, uint256 charged) = CascadePayoutMath.feeSplit(2e16, 3e16, 100, 15e15);
        assertEq(fee, 2e16, "lonely: fee");
        assertEq(charged, 15e15, "lonely: charged");
        // test_processPayouts_subRaoFeeRoundsUpToWholeRao: 1e15 + 1 rounds up to 1e15 + 1e9, within the 1e18 ceiling
        (fee, charged) = CascadePayoutMath.feeSplit(1e15 + 1, 100e18, 100, 15e15);
        assertEq(fee, 1_000_001_000_000_000, "sub-rao: fee");
        assertEq(charged, fee, "sub-rao: charged whole");
        // test_processPayouts_feeCeilingReverts: 1e18 + 1 rounds up to 1e18 + 1e9, a rao above the bps ceiling
        (fee, charged) = CascadePayoutMath.feeSplit(1e18 + 1, 100e18, 100, 15e15);
        assertEq(fee, 1e18 + 1e9, "above: fee");
        assertEq(charged, 1e18, "above: the bps ceiling");
        // a ceiling that is not whole rao is floored: 1% of 100e18 + 12_345 wei is 1e18 + 123
        (fee, charged) = CascadePayoutMath.feeSplit(2e18, 100e18 + 12_345, 100, 15e15);
        assertEq(charged, 1e18, "floored ceiling");
        // no quote, no fee
        (fee, charged) = CascadePayoutMath.feeSplit(0, 100e18, 100, 15e15);
        assertEq(fee, 0, "zero: fee");
        assertEq(charged, 0, "zero: charged");
    }

    // ---- the fee valve's properties, fuzzed (fix round 1: the Halmos proofs of these two did not finish) ----

    /// feeSplitHolds (PayoutMathProperties, the body Halmos's check_feeSplitChargesAtMostTheCeiling asserts) for any
    /// chunk up to 1e6 TAO, any maxFeeBps the bound allows (0 to 500), any maxFeeAbs in [MIN_FEE_ABS, MAX_FEE_ABS] and a
    /// quote from 0 to twice the ceiling and a rao, so both branches (within the ceiling, topped up) are common.
    function testFuzz_feeSplitChargesAtMostTheCeiling(uint256 quote, uint256 sum, uint256 bps, uint256 abs_)
        public
        pure
    {
        sum = bound(sum, 0, 1e24);
        bps = bound(bps, 0, 500);
        abs_ = bound(abs_, 0.01e18, 0.015e18);
        uint256 part = sum * bps / 10_000;
        quote = bound(quote, 0, 2 * (part > abs_ ? part : abs_) + 1e9);
        feeSplitHolds(quote, sum, bps, abs_);
    }

    /// deductFeeHolds (the body of Halmos's check_deductFeeKeepsWithinTheChunkAndDustHasNoShares) for two entries of 1
    /// rao to 1e4 TAO, whole rao as every queued payout is (a burn's value and a bounce are floored to rao), with or
    /// without shares, and any share charged from 0 to twice the chunk, so dust, FeeTooHigh and kept entries are all
    /// common.
    function testFuzz_deductFeeKeepsWithinTheChunkAndDustHasNoShares(
        uint256 a0,
        uint256 a1,
        bool shares0,
        bool shares1,
        uint256 charged
    ) public view {
        a0 = bound(a0, 1, 1e13) * 1e9;
        a1 = bound(a1, 1, 1e13) * 1e9;
        charged = bound(charged, 0, 2 * (a0 + a1));
        deductFeeHolds(a0, a1, shares0, shares1, charged);
    }
}
