// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CascadeMessages} from "./CascadeMessages.sol";
import {RAO} from "../CascadeConstants.sol";
import {FeeTooHigh, PayoutsMismatch} from "../CascadeErrors.sol";

/// @notice The vault's payout math: the batch check, the chunking and the fee split. A linked external
/// library, so its code sits outside the vault's size limit; the vault reaches it by DELEGATECALL at the
/// address fixed when the vault is linked. The vault's only DELEGATECALLs are to its fixed, linked
/// libraries (spec §8.1, I-32; the link graph script/library-rules.mjs checks).
/// @dev Every external function is `pure`: the vault passes in what it reads from storage (the batch's
/// count and hash, the cursor, its limits) and emits every event itself, so nothing here reads or
/// writes the vault's state. Amounts are in wei; 1 rao = 1e9 wei.
library CascadePayoutMath {
    // RAO is CascadeConstants.sol's, and PayoutsMismatch and FeeTooHigh are declared in CascadeErrors.sol.

    /// One step of a batch's running hash; the vault queues with it and `verify` replays it.
    function hashStep(bytes32 h, address user, uint256 shares, uint256 assets) internal pure returns (bytes32) {
        return keccak256(abi.encode(h, user, shares, assets));
    }

    /// PayoutsMismatch unless `payouts` has `count` entries and its running hash from zero equals
    /// `payoutsHash`.
    function verify(CascadeMessages.Payout[] calldata payouts, uint256 count, bytes32 payoutsHash) external pure {
        if (payouts.length != count) revert PayoutsMismatch();
        bytes32 h = bytes32(0);
        for (uint256 i; i < payouts.length; ++i) {
            h = hashStep(h, payouts[i].user, payouts[i].shares, payouts[i].assets);
        }
        if (h != payoutsHash) revert PayoutsMismatch();
    }

    /// From `start`, the next entry always (even above `cap`), then entries in order while fewer than
    /// `limit` are taken and the sum stays within `cap`. A tail of fewer than `minChunk` entries that
    /// would be left behind is taken too when the whole chunk still fits within `cap` and MAX_ENTRIES,
    /// so a tail never pays a message fee alone. Returns the entries at their gross value, with their
    /// sum. The caller keeps `start` below the list's length and `limit` at 1 or more.
    function takeChunk(
        CascadeMessages.Payout[] calldata payouts,
        uint256 start,
        uint256 limit,
        uint256 cap,
        uint256 minChunk
    ) external pure returns (CascadeMessages.Entry[] memory entries, uint256 sum) {
        uint256 n = payouts.length;
        uint256 end = Math.min(start + limit, n);
        uint256 i = start;
        do {
            sum += payouts[i].assets;
            ++i;
        } while (i < end && sum + payouts[i].assets <= cap);
        // fold a short tail in
        if (i < n && n - i < minChunk && n - start <= CascadeMessages.MAX_ENTRIES) {
            uint256 total = sum;
            for (uint256 j = i; j < n; ++j) {
                total += payouts[j].assets;
            }
            if (total <= cap) (sum, i) = (total, n);
        }
        entries = new CascadeMessages.Entry[](i - start);
        for (uint256 j; j < entries.length; ++j) {
            entries[j] = CascadeMessages.Entry(payouts[start + j].user, payouts[start + j].assets);
        }
    }

    /// The fee valve's split of a chunk's bridge fee (spec §3.3), in wei: `fee`, the bridge's `quote` rounded up to
    /// whole rao (the chain floors value transfers to rao, so a sub-rao net + fee would reach the adapter short), and
    /// `charged`, the entries' share of it: at most the ceiling, the larger of `maxFeeBps` of the chunk's gross `sum`
    /// and `maxFeeAbs`, floored to rao. So charged <= fee, both whole rao, and the caller tops up fee - charged.
    function feeSplit(uint256 quote, uint256 sum, uint256 maxFeeBps, uint256 maxFeeAbs)
        internal
        pure
        returns (uint256 fee, uint256 charged)
    {
        fee = Math.ceilDiv(quote, RAO) * RAO;
        charged = Math.min(fee, Math.max(sum * maxFeeBps / 10_000, maxFeeAbs));
        charged -= charged % RAO;
    }

    /// The fee split over the `taken` entries from `start`, whose gross sum is `sum`: each entry pays
    /// ceil(assets * charged / sum) and is floored to rao. An entry left with 0 (every entry when
    /// sum <= charged) goes to `dust` at its gross value, in order, if it has no shares (a bounced deposit); one with
    /// shares reverts the chunk FeeTooHigh (spec §3.3, I-14: a burned exit is never finalised at zero; unreachable
    /// under the bounds, MIN_REDEEM_VALUE being twice MAX_FEE_ABS). The rest go to `kept` at their net value, in
    /// order, and `net` is their total. No assembly: each list is shrunk to the entries it holds by a copy (R1-C F-1:
    /// no library may hold assembly, a memory-only length write included).
    function deductFee(
        CascadeMessages.Payout[] calldata payouts,
        uint256 start,
        uint256 taken,
        uint256 charged,
        uint256 sum
    ) external pure returns (CascadeMessages.Entry[] memory kept, CascadeMessages.Entry[] memory dust, uint256 net) {
        kept = new CascadeMessages.Entry[](taken);
        dust = new CascadeMessages.Entry[](taken);
        uint256 k;
        uint256 d;
        for (uint256 i = start; i < start + taken; ++i) {
            address user = payouts[i].user;
            uint256 assets = payouts[i].assets;
            uint256 fee = Math.mulDiv(assets, charged, sum, Math.Rounding.Ceil);
            uint256 a = assets > fee ? assets - fee : 0;
            a -= a % RAO;
            if (a == 0) {
                if (payouts[i].shares != 0) revert FeeTooHigh();
                dust[d++] = CascadeMessages.Entry(user, assets);
                continue;
            }
            kept[k++] = CascadeMessages.Entry(user, a);
            net += a;
        }
        // shrink each to the entries it holds
        kept = _first(kept, k);
        dust = _first(dust, d);
    }

    /// The first `n` entries of `list`, in a new list of exactly `n` (the entries themselves are not copied:
    /// a memory list of structs holds pointers to them).
    function _first(CascadeMessages.Entry[] memory list, uint256 n)
        private
        pure
        returns (CascadeMessages.Entry[] memory out)
    {
        out = new CascadeMessages.Entry[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = list[i];
        }
    }
}
