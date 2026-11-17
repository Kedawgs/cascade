// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ledger, PayoutBatch, PayoutIn, PayoutPlan, SharesData} from "../CascadeTypes.sol";
import {mintShares} from "../CascadeShares.sol";
import {ED_RESERVE, RAO} from "../CascadeConstants.sol";
import {
    BadValue,
    FeeTooHigh,
    FrontDoorInactive,
    NotPending,
    NothingToCancel,
    PayoutDelayed,
    PrimaryBridgeDisabled,
    TransferFailed,
    UnstakeShort
} from "../CascadeErrors.sol";
import {PayoutBatchCancelled, PayoutChunkSent, PayoutDust, RedeemReversed} from "../CascadeEvents.sol";
import {CascadeMath} from "./CascadeMath.sol";
import {CascadeMessages} from "./CascadeMessages.sol";
import {CascadePayoutMath} from "./CascadePayoutMath.sol";

/// @notice L3, the vault's payout engine (spec §8.1): v3.1's processPayouts and cancelPayoutBatch after the
/// vault's own checks, moved whole. A payout runs in two halves around the walk, which the vault runs itself
/// (the controller's 5g ruling): `prepare` (the batch check, the delay, the door and bridge checks, the chunk,
/// the fee quote and the fee valve, the dust, what must be unstaked, the caller's refund; it writes nothing), the
/// vault's walk through L2 under its transient unstake flag, then `finish` (the walk's cost split over the entries
/// and the check that the liquidity and the receipts fund what is sent, then the effects, the send, PayoutChunkSent,
/// then the caller's refund, last). So v3.1's order of checks, effects, external calls and events holds, with the
/// refund (Task 21) after all of it, and the flag, which no library can set, is never set across a bridge call or
/// the refund.
/// @dev A linked external library, run only by the vault's DELEGATECALL, in the vault's context: its events
/// come from the vault's address, the bridge sees the vault as the caller and the TAO it sends is the vault's,
/// and the compiler's call guard reverts a direct call. It holds no state; `finish` and `cancel` write only
/// through their storage pointers (the payout queue and the ledger; on a cancel, the share token too), and
/// `prepare` takes memory copies of what it reads. It calls only the bridge the vault passes in
/// PayoutIn.bridge (quoteFee, send; send after every effect), the vault's caller for its refund (value only,
/// empty calldata, finish's last statement) and, by DELEGATECALL, the payout math it links (CascadePayoutMath);
/// never L2, whose walk is the vault's. It reads msg.sender only as that refund's target (the vault passes whether
/// the caller is the keeper) and never msg.value (the vault passes it in PayoutIn.value, counted once here).
library CascadePayoutLib {
    /// processPayouts' first half: v3.1's checks in v3.1's order (NotPending unless entries are left, an
    /// unknown key having none; PayoutsMismatch unless `payouts` is the batch's full ordered list; the delay;
    /// the door; the primary bridge), then the chunk from the cursor (the keeper's `maxEntries`, raised to
    /// minChunk and capped at MAX_ENTRIES, or MAX_ENTRIES for anyone else; CascadePayoutMath.takeChunk), then the
    /// fee valve, spec §3.3's block line for line: the fee the bridge quotes on the gross message, rounded up to
    /// whole rao, and the entries' share of it, at most the ceiling (CascadePayoutMath.feeSplit); the split (each
    /// entry pays its share and is floored to rao; a 0-share entry left with nothing is PayoutDust and stays in the
    /// vault, one with shares reverts FeeTooHigh); BadValue unless the caller's value is whole rao, FeeTooHigh while
    /// it is short of the fee above the ceiling (the top-up), the whole fee the caller's when its value covers it (the
    /// full top-up, R4: the entries charged nothing); and what the liquid balance beyond the reserve and the
    /// other batches' reservations, the caller's value not counted (I-12), does not cover of what the vault pays,
    /// net and the entries' share, with that liquidity (`free`) and the dust count kept for `finish`. When nothing is
    /// sent (net 0) there is no fee and the whole value comes back. Writes nothing; the vault unstakes the shortfall,
    /// then runs `finish`.
    function prepare(bytes32 key, CascadeMessages.Payout[] calldata payouts, uint32 maxEntries, PayoutIn memory input)
        external
        returns (PayoutPlan memory plan)
    {
        PayoutBatch memory b = input.batch;
        if (b.cursor >= b.count) revert NotPending();
        CascadePayoutMath.verify(payouts, b.count, b.payoutsHash);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < uint256(b.queuedAt) + input.payoutDelay) revert PayoutDelayed();
        if (!input.doorActive) revert FrontDoorInactive();
        if (!input.bridgeEnabled) revert PrimaryBridgeDisabled();

        // 1. chunk; 2. the fee valve (spec §3.3), on the fee quoted on the gross message
        uint256 limit = input.isKeeper
            ? Math.min(Math.max(maxEntries, input.minChunk), CascadeMessages.MAX_ENTRIES)
            : CascadeMessages.MAX_ENTRIES;
        (CascadeMessages.Entry[] memory entries, uint256 sum) =
            CascadePayoutMath.takeChunk(payouts, b.cursor, limit, input.maxMessageValue, input.minChunk);
        // casting to 'uint32' is safe because a chunk holds at most MAX_ENTRIES entries
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 taken = uint32(entries.length);
        bytes memory gross = CascadeMessages.encodePayouts(key, b.chunk, entries);
        // fee = ceilToRao(quote); charged = floorToRao(min(fee, ceiling)); topUp = fee - charged, all whole rao
        (uint256 fee, uint256 charged) = CascadePayoutMath.feeSplit(
            input.bridge.quoteFee(b.sourceChain, b.frontDoor, gross, sum), sum, input.maxFeeBps, input.maxFeeAbs
        );
        uint256 value = input.value;
        // the full top-up (spec §3.3, R4): a caller whose value covers the whole fee pays all of it, and the entries are
        // charged nothing and sent their gross, so a conversion floor raised between a chunk's net and its gross never
        // strands it; the vault still pays exactly `sum`, and the caller gets back value - fee, last
        if (value >= fee) charged = 0;
        uint256 topUp = fee - charged;
        (CascadeMessages.Entry[] memory kept, CascadeMessages.Entry[] memory dust, uint256 net) =
            CascadePayoutMath.deductFee(payouts, b.cursor, taken, charged, sum);
        for (uint256 i; i < dust.length; ++i) {
            emit PayoutDust(key, dust[i].user, dust[i].amount);
        }
        if (value % RAO != 0) revert BadValue();
        if (value < topUp) revert FeeTooHigh();
        // nothing sent: no fee, and the caller's whole value comes back
        if (net == 0) (fee, charged, topUp) = (0, 0, 0);

        // 3. liquidity beyond the reserve and the other batches' reservations, floored at 0, read once, before the
        // walk, on the balance less the caller's value (own = balance - msg.value: never cover, I-12). OpenZeppelin's
        // saturatingSub equals the formulas' sub0 for every input; L3 does not import CascadeFormulas, whose
        // stake reads the library rules would count against L3's closure (they read its whole closure)
        uint256 free = Math.saturatingSub(
            Math.saturatingSub(address(this).balance - value, ED_RESERVE), input.pending - b.remaining
        );
        uint256 need = net + charged;
        plan.taken = taken;
        plan.sum = sum;
        plan.net = net;
        plan.fee = fee;
        plan.charged = charged;
        plan.free = free;
        plan.dust = dust.length;
        // the vault walks need - free + T
        if (free < need) plan.shortfall = need - free;
        plan.refund = value - topUp;
        if (net != 0) plan.message = CascadeMessages.encodePayouts(key, b.chunk, kept);
    }

    /// processPayouts' second half, after the vault's walk, `payouts` the list `prepare` checked: the leaver pays
    /// (spec §3.3, the founder's ruling of 2026-11-06): when the walk cost anything (`plan.cost`, what the chain kept
    /// of the stake it took), the entries bear it with their share of the fee, the split run again on `charged +
    /// cost` (CascadePayoutMath.deductFee: each share rounded up, each net floored to rao, a bounce included), and
    /// FeeTooHigh when that leaves an entry nothing that the first split did not (an entry with shares reverts in the
    /// split; a bounce by the dust count, which only grows with the charge, so equal counts are equal sets and the
    /// PayoutDust `prepare` logged stand); the message is then the new split's. UnstakeShort unless the liquidity read
    /// before the walk and the walk's receipts fund what the vault pays, net + charged (I-12). Then the effects (the
    /// reservation released, the batch advanced or, when done, deleted; the vault's replay record stays), then the
    /// send of exactly net + fee through the primary bridge (the caller's top-up pays the fee above what the entries
    /// are charged; the rounding difference sum - net - charged and the walk's cost stay out of what is sent); then
    /// PayoutChunkSent; then, last, the caller's value less its top-up back to the caller (msg.sender, the vault's
    /// caller under DELEGATECALL), value only and empty calldata, TransferFailed if it refuses. The send and the
    /// refund, the external calls that could re-enter, run under the vault's lock and with its unstake flag clear.
    function finish(
        mapping(bytes32 => PayoutBatch) storage batches,
        Ledger storage ledger,
        bytes32 key,
        CascadeMessages.Payout[] calldata payouts,
        PayoutIn memory input,
        PayoutPlan memory plan
    ) external {
        PayoutBatch memory b = input.batch;
        // 3b. the walk's cost, the entries' (a walk ran: plan.net is not 0), and what funds the send
        if (plan.cost != 0) {
            (CascadeMessages.Entry[] memory kept, CascadeMessages.Entry[] memory dust, uint256 net) =
                CascadePayoutMath.deductFee(payouts, b.cursor, plan.taken, plan.charged + plan.cost, plan.sum);
            if (dust.length != plan.dust) revert FeeTooHigh();
            plan.net = net;
            plan.message = CascadeMessages.encodePayouts(key, b.chunk, kept);
        }
        if (plan.free + plan.received < plan.net + plan.charged) revert UnstakeShort();
        // 4. effects
        ledger.pending -= plan.sum;
        if (b.cursor + plan.taken == b.count) {
            delete batches[key];
        } else {
            PayoutBatch storage s = batches[key];
            s.cursor = b.cursor + plan.taken;
            s.chunk = b.chunk + 1;
            s.remaining = b.remaining - plan.sum;
        }

        // 5. send exactly net + fee
        if (plan.net != 0) {
            input.bridge.send{value: plan.net + plan.fee}(b.sourceChain, b.frontDoor, plan.message, plan.net);
        }
        emit PayoutChunkSent(key, b.chunk, plan.taken, plan.sum, plan.net, plan.fee, plan.charged, plan.cost);

        // 6. refund msg.value - topUp to the caller, last
        if (plan.refund != 0) {
            (bool ok,) = payable(msg.sender).call{value: plan.refund}("");
            if (!ok) revert TransferFailed();
        }
    }

    /// cancelPayoutBatch after the vault's owner check: NotPending unless entries are left; PayoutsMismatch
    /// unless `payouts` is the batch's full ordered list; then re-mints each remaining entry with shares the value it
    /// is owed, never more shares than it burned: min(shares, sharesForDeposit(assets, assetsBefore, supplyBefore)),
    /// one price for the whole cancel, `assetsBefore` the vault's totalAssets() and `supplyBefore` the supply, both
    /// read before anything is released (Task 34c; an entry that buys 0 shares mints nothing, its value stays in the
    /// vault), and releases each one's whole reservation; and carries the remaining bounced deposits (0 shares)
    /// forward (spec §3.5, §3.10.5): in their order they become the batch's new list (its count, its hash by the
    /// queue's own step, which processPayouts verifies, their value as `remaining`, the cursor at 0; `queuedAt` and
    /// `chunk` kept), still reserved (I-19). Nothing carried deletes the batch; nothing to re-mint (every remaining
    /// entry a bounce, by its shares) reverts NothingToCancel. Returns the batch's source chain, for the vault's
    /// launch-door cancel stamp (Task 10), which a revert here never reaches.
    function cancel(
        SharesData storage shares,
        mapping(bytes32 => PayoutBatch) storage batches,
        Ledger storage ledger,
        bytes32 key,
        CascadeMessages.Payout[] calldata payouts,
        uint256 assetsBefore
    ) external returns (uint64 sourceChain) {
        PayoutBatch storage b = batches[key];
        uint256 cursor = b.cursor;
        if (cursor >= b.count) revert NotPending();
        CascadePayoutMath.verify(payouts, b.count, b.payoutsHash);
        uint256 supplyBefore = shares.totalSupply;
        uint256 reminted;
        uint32 carried;
        bytes32 h;
        for (uint256 i = cursor; i < payouts.length; ++i) {
            CascadeMessages.Payout calldata p = payouts[i];
            if (p.shares == 0) {
                ++carried;
                h = CascadePayoutMath.hashStep(h, p.user, 0, p.assets);
                continue;
            }
            uint256 s = Math.min(p.shares, CascadeMath.sharesForDeposit(p.assets, assetsBefore, supplyBefore));
            // an entry whose value buys no share mints nothing (no Transfer of 0); its value stays in the vault
            if (s != 0) mintShares(shares, p.user, s);
            reminted += p.assets;
            emit RedeemReversed(key, p.user, s, p.assets);
        }
        // every remaining entry a bounce: nothing to re-mint (decided by the entries' shares, not their value)
        if (carried == payouts.length - cursor) revert NothingToCancel();
        sourceChain = b.sourceChain;
        ledger.pending -= reminted;
        if (carried == 0) {
            delete batches[key];
        } else {
            // the remaining value less the re-minted: the carried bounces' own
            b.remaining -= reminted;
            b.count = carried;
            b.cursor = 0;
            b.payoutsHash = h;
        }
        emit PayoutBatchCancelled(key, reminted, carried);
    }
}
