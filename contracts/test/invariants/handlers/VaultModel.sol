// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FeeTooHigh, UnstakeShort, ZeroAmount} from "../../../src/CascadeErrors.sol";
import {UnstakeSkipped, Unstaked} from "../../../src/CascadeEvents.sol";
import {CascadeMessages} from "../../../src/libraries/CascadeMessages.sol";
import {PayoutBatch} from "../../../src/CascadeTypes.sol";
import {TrackedHandler} from "./TrackedHandler.sol";

/// @notice The vault's formulas the Phase 8 handlers restate, in one place (Task 36's ruling: reuse, don't copy): the
/// payout chunk and its fee ceiling (CascadePayoutMath.takeChunk and feeSplit, from CoreHandler), the fee's split over
/// a chunk's entries (CascadePayoutMath.deductFee, the payout campaign's), the unstake walk (CascadeStakeLib.unstake,
/// from LedgerHandler; a pair under a root hold skipped, the payout campaign's): the removals it makes, in order, the
/// stake it takes counted at face value (Task 36b), its cost (what the chain keeps of that stake, the exit's to bear),
/// and what follows for an exit (_exitPlan: the leaver's pay, or its refusal) and a chunk (_chunkAfterWalk: the split
/// again on the fee's share and the cost, or the refusal), with the check of a call's Unstaked events against those
/// removals (Task 36's fix round 2), and the assets priced on the mock's positions, the liquid balance beyond ED and
/// the reservations, and the missing-stake tolerance (from LedgerHandler), and the ghost ledger and ramp the allowance
/// base is replayed on (I-2, I-5; from LedgerHandler in Task 37, for the windows of the doors campaign too: ghostBooked,
/// ghostRamping, ghostLastStakeAt, _bookStake, _bookRemovals, ghostBase). Each is the handlers' own reading of the
/// rule, never the vault's view of it: `testFuzz_theHandlersChunkMathIsTheLibrarys` (the core campaign) pins the chunk and the
/// ceiling to the library, `testFuzz_thePayoutSplitIsTheLibrarys` (the payout campaign) the chunk's entries, the fee
/// split and the split, and `testFuzz_theWalkRestatementIsTheVaults` (the ledger campaign) and
/// `testFuzz_theWalkUnderAHoldIsTheVaults` (the payout campaign) the walk's coverage and its removals to the vault.
/// Every handler that needs one extends this base, which extends TrackedHandler.
abstract contract VaultModel is TrackedHandler {
    uint256 internal constant ED = 1e12;
    /// The vault's missing-stake tolerance, restated (spec §3.1, `stakeMissing()`): stake is missing when the booked
    /// exceeds the visible by more than the larger of 0.1% of the booked less the queued payouts (R6 E-fix) and 0.001
    /// TAO, all in rao.
    uint256 internal constant MISSING_TOLERANCE_BPS = 10;
    uint256 internal constant MIN_MISSING_TOLERANCE_RAO = 1_000_000;
    /// The staking floors' fallbacks, restated (the spec's parameter table: 2,000,000 and 20,000,000 rao): the walk's
    /// minimum stake and minimum remainder are the chain's reads raised to these.
    uint256 internal constant MIN_STAKE_FALLBACK_RAO = 2_000_000;
    uint256 internal constant MIN_REMAIN_FALLBACK_RAO = 20_000_000;
    /// The vault's STAKE_RAMP, restated: a stake's gain ramps into the allowance base over a day (I-5).
    uint256 internal constant STAKE_RAMP = 1 days;

    /// One attempt of the unstake walk, as the model predicts it: the position's hotkey, the rao the vault asks of it
    /// (the whole position when `full`, which its Unstaked then logs), and whether the chain refuses it (`skipped`: a
    /// pair under a root hold, which the vault logs UnstakeSkipped for and goes on, adding nothing).
    struct Removal {
        bytes32 hotkey;
        uint256 wantRao;
        bool full;
        bool skipped;
    }

    /// A payout chunk after its walk, as the model predicts it (_chunkAfterWalk): the walk's attempts (none when the
    /// free balance covers the chunk), the refusal the walk and finish's checks make (UnstakeShort, FeeTooHigh, or
    /// none), what the walk receives and its cost (whole rao, the entries'), and the entries' nets in order (0 for a
    /// dust entry) and their total, after the split on charged + cost (the first split's when the walk cost nothing);
    /// what the walk left untaken of its ask at face value (`unmet`), and whether the split on charged + cost leaves an
    /// entry nothing that the first split did not (`zeroed`: the walk-cost FeeTooHigh).
    struct ChunkOut {
        Removal[] walk;
        bytes4 refusal;
        uint256 received;
        uint256 cost;
        uint256[] nets;
        uint256 net;
        uint256 unmet;
        bool zeroed;
    }

    /// A direct exit as the model predicts it (_exitPlan): the walk's attempts (none when the liquid balance covers
    /// it), its refusal (ZeroAmount, UnstakeShort, or none), what the walk leaves unmet of the request at face value
    /// and its cost (what the chain keeps of the stake it takes), and what the leaver is paid: floorToRao(out - unmet -
    /// cost), the leaver bearing its exit's whole cost (spec §3.3, Task 36b).
    struct ExitOut {
        Removal[] walk;
        bytes4 refusal;
        uint256 unmet;
        uint256 cost;
        uint256 paid;
    }

    /// The vault's coldkey (its mirror), whose positions the restatements read on the mock.
    bytes32 public immutable coldkey;

    /// _checkWalk's tallies: the calls whose Unstaked and UnstakeSkipped events were not the predicted walk, the
    /// walks checked (an attempt predicted or logged), and those of two or more removals.
    uint256 public walkMismatches;
    uint256 public walksChecked;
    uint256 public walksOfSeveralRemovals;

    // ---- the ghost ledger (I-2) and ramp (I-5), replayed by the handlers that book them ----

    /// The booked stake, in rao, replayed from the handler's own measurements on the mock's positions (never the
    /// vault's events): a stake adds what the stake hotkey's position rose by, at most what the vault's balance paid
    /// (_bookStake); every removal takes off what each position fell by, floored (_bookRemovals); a handler with other
    /// stake-side measurements (the ledger campaign's claims, adoptions and write-offs) books them itself. The ramp and
    /// its clock the same way: a stake adds its gain over STAKE_RAMP from now, each removal takes off what the mock
    /// paid for it. A handler that books nothing leaves them at the deploy's.
    uint256 public ghostBooked;
    uint256 public ghostRamping;
    uint64 public ghostLastStakeAt;

    constructor(System memory s) TrackedHandler(s) {
        coldkey = s.vaultLens.coldkey();
        ghostLastStakeAt = s.vaultLens.lastStakeAt();
    }

    // ---- the payout chunk (CascadePayoutMath) ----

    /// The sum of the chunk processPayouts takes of `b` (maxEntries from its cursor, raised to minChunk, the vault's
    /// chunk rules) and its fee ceiling, the larger of maxFeeBps of that sum and maxFeeAbs.
    function _chunkCeiling(CascadeMessages.Payout[] memory list, PayoutBatch memory b, uint32 maxEntries)
        internal
        view
        returns (uint256 sum, uint256 ceiling)
    {
        uint256 limit = Math.min(Math.max(maxEntries, vaultLens.minChunk()), CascadeMessages.MAX_ENTRIES);
        sum = chunkSum(list, b.cursor, limit, vaultLens.maxMessageValue(), vaultLens.minChunk());
        ceiling = feeCeiling(sum, vaultLens.maxFeeBps(), vaultLens.maxFeeAbs());
    }

    /// The chunk processPayouts takes of `b` for the keeper's `maxEntries` at the bridge's `quote` with the caller's
    /// `value`, restated through its walk (spec §3.3's fee valve, with the leaver pays, Task 36b): the chunk, the fee
    /// split (the entries charged nothing when `value` covers the whole fee: the full top-up, R4) and the first split
    /// (VaultModel's takeChunk, feeSplit, deductFee; nothing is sent, and so nothing is needed, when every entry is
    /// dust), then what the free balance beyond ED and the other batches' reservations lacks of what the vault pays,
    /// walked (_chunkAfterWalk). The early refusals (the delay, the door, the bridge, the value) are the caller's.
    function _chunkOutcome(
        CascadeMessages.Payout[] memory list,
        PayoutBatch memory b,
        uint32 maxEntries,
        uint256 quote,
        uint256 value
    ) internal view returns (ChunkOut memory o) {
        uint256 limit = Math.min(Math.max(maxEntries, vaultLens.minChunk()), CascadeMessages.MAX_ENTRIES);
        (uint256 taken, uint256 sum) =
            _takeChunk(list, b.cursor, limit, vaultLens.maxMessageValue(), vaultLens.minChunk());
        (uint256 fee, uint256 charged) = _feeSplit(quote, sum);
        if (value >= fee) charged = 0;
        (uint256[] memory nets, uint256 net, bool sharesAtZero, uint256 dust) =
            _deductFee(list, b.cursor, taken, charged, sum);
        if (sharesAtZero) {
            o.refusal = FeeTooHigh.selector;
            return o;
        }
        if (net == 0) charged = 0;
        o = _chunkAfterWalk(list, b.cursor, taken, charged, sum, nets, net, dust, _chunkFree(b));
    }

    /// A chunk's walk and what follows it (CascadePayoutLib.finish's checks, the vault's walk between them): with the
    /// first split's `nets` and `net` (its `dust` entries left with nothing) and `free` to pay from, what the vault pays
    /// is net + charged; when free covers it there is no walk, else the walk asks need - free + T (_chunkWalk), and
    /// refuses UnstakeShort past T untaken. Its cost (what the chain keeps of the stake it takes, _walkCost) is the
    /// entries': the split runs again on charged + cost, and refuses FeeTooHigh when that leaves an entry with shares
    /// at 0 or a bounce more (the dust count); then UnstakeShort unless free and the receipts fund net + charged.
    function _chunkAfterWalk(
        CascadeMessages.Payout[] memory list,
        uint256 cursor,
        uint256 taken,
        uint256 charged,
        uint256 sum,
        uint256[] memory nets,
        uint256 net,
        uint256 dust,
        uint256 free
    ) internal view returns (ChunkOut memory o) {
        o.nets = nets;
        o.net = net;
        uint256 need = net == 0 ? 0 : net + charged;
        if (free >= need) return o;
        (o.walk, o.unmet) = _walk(need - free + SHORTFALL_TOLERANCE);
        if (o.unmet > SHORTFALL_TOLERANCE) {
            o.refusal = UnstakeShort.selector;
            return o;
        }
        (o.received, o.cost) = _walkCost(o.walk);
        if (o.cost != 0) {
            bool sharesAtZero;
            uint256 dust2;
            (o.nets, o.net, sharesAtZero, dust2) = _deductFee(list, cursor, taken, charged + o.cost, sum);
            if (sharesAtZero || dust2 != dust) {
                o.zeroed = true;
                o.refusal = FeeTooHigh.selector;
                return o;
            }
        }
        if (free + o.received < o.net + charged) o.refusal = UnstakeShort.selector;
    }

    /// CascadePayoutMath.feeSplit's ceiling, restated: the larger of `maxFeeBps` of the chunk's `sum` and `maxFeeAbs`
    /// (testFuzz_theHandlersChunkMathIsTheLibrarys pins it to the library).
    function feeCeiling(uint256 sum, uint256 maxFeeBps, uint256 maxFeeAbs) public pure returns (uint256) {
        return Math.max(sum * maxFeeBps / 10_000, maxFeeAbs);
    }

    /// CascadePayoutMath.feeSplit, restated (spec §3.3's fee valve): `fee` the bridge's `quote` rounded up to whole
    /// rao, `charged` the entries' share of it, at most the chunk's ceiling (feeCeiling), floored to rao. The payout
    /// campaign's testFuzz_thePayoutSplitIsTheLibrarys pins it to the library.
    function feeSplit(uint256 quote, uint256 sum, uint256 maxFeeBps, uint256 maxFeeAbs)
        public
        pure
        returns (uint256 fee, uint256 charged)
    {
        fee = Math.ceilDiv(quote, RAO) * RAO;
        charged = Math.min(fee, feeCeiling(sum, maxFeeBps, maxFeeAbs));
        charged -= charged % RAO;
    }

    /// feeSplit at the vault's fee limits, read through the lens.
    function _feeSplit(uint256 quote, uint256 sum) internal view returns (uint256 fee, uint256 charged) {
        return feeSplit(quote, sum, vaultLens.maxFeeBps(), vaultLens.maxFeeAbs());
    }

    /// CascadePayoutMath.takeChunk's sum (_takeChunk's; testFuzz_theHandlersChunkMathIsTheLibrarys pins it to the
    /// library).
    function chunkSum(CascadeMessages.Payout[] memory list, uint256 start, uint256 limit, uint256 cap, uint256 minChunk)
        public
        pure
        returns (uint256 sum)
    {
        (, sum) = _takeChunk(list, start, limit, cap, minChunk);
    }

    /// CascadePayoutMath.takeChunk, restated: from `start`, the next entry always, then entries while fewer than
    /// `limit` are taken and the sum stays within `cap`; a tail of fewer than `minChunk` entries is folded in when the
    /// whole fits within `cap` and MAX_ENTRIES. Returns how many entries it takes and their sum (the payout campaign's
    /// testFuzz_thePayoutSplitIsTheLibrarys pins both to the library).
    function _takeChunk(
        CascadeMessages.Payout[] memory list,
        uint256 start,
        uint256 limit,
        uint256 cap,
        uint256 minChunk
    ) internal pure returns (uint256 taken, uint256 sum) {
        uint256 n = list.length;
        uint256 end = Math.min(start + limit, n);
        uint256 i = start;
        do {
            sum += list[i].assets;
            ++i;
        } while (i < end && sum + list[i].assets <= cap);
        if (i < n && n - i < minChunk && n - start <= CascadeMessages.MAX_ENTRIES) {
            uint256 total = sum;
            for (uint256 j = i; j < n; ++j) {
                total += list[j].assets;
            }
            if (total <= cap) (sum, i) = (total, n);
        }
        taken = i - start;
    }

    /// CascadePayoutMath.deductFee, restated, over the `taken` entries from `start` whose gross sum is `sum`: each
    /// entry pays ceil(assets * charged / sum) and is floored to rao (`nets`, in order; `net` their total). An entry
    /// left with 0 is dust if it has no shares (a bounce: `dust` counts them, their net 0) and refuses the chunk
    /// FeeTooHigh if it has shares (`sharesAtZero`; spec §3.3, I-14). The payout campaign's
    /// testFuzz_thePayoutSplitIsTheLibrarys pins it to the library.
    function _deductFee(
        CascadeMessages.Payout[] memory list,
        uint256 start,
        uint256 taken,
        uint256 charged,
        uint256 sum
    ) internal pure returns (uint256[] memory nets, uint256 net, bool sharesAtZero, uint256 dust) {
        nets = new uint256[](taken);
        for (uint256 i; i < taken; ++i) {
            CascadeMessages.Payout memory p = list[start + i];
            uint256 a = _sub0(p.assets, Math.mulDiv(p.assets, charged, sum, Math.Rounding.Ceil));
            a -= a % RAO;
            if (a == 0) {
                if (p.shares != 0) sharesAtZero = true;
                else ++dust;
                continue;
            }
            nets[i] = a;
            net += a;
        }
    }

    // ---- the chain's removal fee ----

    /// The removal fee a campaign's setRemoveFee sets (MockStaking.setRemoveFeeRao), in rao, from `seed` (the core and
    /// the doors campaigns' draw, one copy since Task 37's fix round): 0 one draw in three, 1 to the tolerance (1,000 rao)
    /// one in three, else 1,001, 50,000, 4,000,000 or 16,000,000 rao (one rao past the tolerance, 50,000, above the
    /// chain's minimum stake, above the fee ceiling's 0.015 TAO), each the walking exit's own cost (Task 36b).
    function _removeFeeDraw(uint256 seed) internal pure returns (uint256 fee) {
        if (seed % 3 == 1) fee = bound(seed / 3, 1, SHORTFALL_TOLERANCE / RAO);
        else if (seed % 3 == 2) fee = [uint256(1_001), 50_000, 4_000_000, 16_000_000][(seed / 3) % 4];
    }

    // ---- the walk (CascadeStakeLib) ----

    /// The vault's liquid balance beyond ED and `reserved` (spec §3.3: `available` with every reservation, a chunk's
    /// `free` with the other batches'), each step floored at 0.
    function _availableAt(uint256 reserved) internal view returns (uint256) {
        return _sub0(_sub0(address(vault).balance, ED), reserved);
    }

    /// _availableAt, for the campaigns' tests (not in the fuzzer's selectors).
    function availableAt(uint256 reserved) external view returns (uint256) {
        return _availableAt(reserved);
    }

    /// The free balance a chunk of batch `b` may pay from, read on the vault's balance and the lens: above ED and the
    /// other batches' reservations (spec §3.3's `free`, with no value sent).
    function _chunkFree(PayoutBatch memory b) internal view returns (uint256) {
        return _availableAt(vaultLens.pendingPayouts() - b.remaining);
    }

    /// Whether a chunk needing `need` wei is paid from `free` and the walk: free covers it, or the walk, asked
    /// `need - free + T`, leaves at most T untaken (spec §3.3's fee valve; T = SHORTFALL_TOLERANCE). The walk's cost
    /// and finish's checks after it are _chunkAfterWalk's.
    function _coversChunk(uint256 free, uint256 need) internal view returns (bool covers) {
        (, covers) = _chunkWalk(free, need);
    }

    /// The walk a chunk needing `need` wei makes with `free` to pay from (_coversChunk's): none when free covers it,
    /// else the walk asked `need - free + T`; and whether it leaves at most T of that untaken.
    function _chunkWalk(uint256 free, uint256 need) internal view returns (Removal[] memory rs, bool covers) {
        if (free >= need) return (rs, true);
        uint256 unmet;
        (rs, unmet) = _walk(need - free + SHORTFALL_TOLERANCE);
        covers = unmet <= SHORTFALL_TOLERANCE;
    }

    /// The walk a direct exit of `out` wei makes with `available` liquid (redeemDirect's): none when that covers it,
    /// else the walk asked `out - available`; and whether it leaves at most T of that untaken (whether it pays is
    /// _exitPlan's).
    function _exitWalk(uint256 available, uint256 out) internal view returns (Removal[] memory rs, bool covers) {
        if (available >= out) return (rs, true);
        uint256 unmet;
        (rs, unmet) = _walk(out - available);
        covers = unmet <= SHORTFALL_TOLERANCE;
    }

    /// A direct exit of `out` wei (its value, floored to rao) with `available` liquid, as redeemDirect makes it (spec
    /// §3.3, the leaver pays, Task 36b): ZeroAmount at 0; no walk when the liquid balance covers it; else the walk asked
    /// out - available, UnstakeShort when it leaves more than T untaken, and the leaver paid floorToRao(out - unmet -
    /// cost), refused ZeroAmount when that is 0. A refusal for stake missing is the caller's.
    function _exitPlan(uint256 available, uint256 out) internal view returns (ExitOut memory e) {
        if (out == 0) {
            e.refusal = ZeroAmount.selector;
            return e;
        }
        if (available >= out) {
            e.paid = out;
            return e;
        }
        (e.walk, e.unmet) = _walk(out - available);
        if (e.unmet > SHORTFALL_TOLERANCE) {
            e.refusal = UnstakeShort.selector;
            return e;
        }
        (, e.cost) = _walkCost(e.walk);
        e.paid = _sub0(out, e.unmet + e.cost);
        e.paid -= e.paid % RAO;
        if (e.paid == 0) e.refusal = ZeroAmount.selector;
    }

    /// Whether the unstake walk (_walk) leaves at most SHORTFALL_TOLERANCE of `wantWei` untaken.
    function _walkCovers(uint256 wantWei) internal view returns (bool) {
        (, uint256 unmet) = _walk(wantWei);
        return unmet <= SHORTFALL_TOLERANCE;
    }

    /// The stake the positions the walk may take hold, at face value, in rao (I-13's liveness, spec §3.3): the stake
    /// hotkey's position and the list's others, each read on the mock, counted when it holds at least the chain's
    /// minimum stake (the walk never tries a smaller one) and its pair is not held (a held one is skipped). The
    /// spec's sufficient condition reads it, not the walk's verdict.
    function _walkableStake() internal view returns (uint256 total) {
        uint256 minStake = Math.max(staking.getDefaultMinStake(), MIN_STAKE_FALLBACK_RAO);
        bytes32 first = vaultLens.stakeHotkey();
        uint256 n = vaultLens.hotkeyCount();
        for (uint256 i; i <= n; ++i) {
            bytes32 h = i == 0 ? first : vaultLens.hotkeys(i - 1);
            if (i != 0 && h == first) continue;
            uint256 s = _stakeOf(h);
            if (s >= minStake && !staking.pairLocked(h)) total += s;
        }
    }

    /// What the walk's attempts `rs` receive and cost at the mock's removal fee: each removal that goes through takes
    /// its ask off its position (the whole position when full) and pays it less the fee (MockStaking's _afterFee), so
    /// the chain keeps min(ask, fee) of each; the cost is their sum, whole rao, as the vault's ceilToRao(stake taken x
    /// RAO - received) reads it. A skipped attempt takes and pays nothing.
    function _walkCost(Removal[] memory rs) internal view returns (uint256 received, uint256 cost) {
        uint256 fee = staking.removeFeeRao();
        for (uint256 i; i < rs.length; ++i) {
            if (rs[i].skipped) continue;
            received += _sub0(rs[i].wantRao, fee) * RAO;
            cost += Math.min(rs[i].wantRao, fee) * RAO;
        }
    }

    /// The unstake walk (CascadeStakeLib.unstake), restated on the mock's positions, the chain's floors and its
    /// removal fee (spec §3.10.11): the attempts it makes for `wantWei`, in order, and what it leaves unmet. Every
    /// position is read once, before it (no removal moves another): the stake hotkey's first, then the list's in order
    /// without it, each of at least the chain's minimum stake (a smaller one is never tried). While more than
    /// SHORTFALL_TOLERANCE is unmet, the next is asked max(ceil(unmet / RAO), minimum) + the margin, or all of it when
    /// that is all of it or leaves less than the chain's minimum remainder, and the stake it takes, at face value,
    /// counts against what is unmet (Task 36b: never what the chain pays for it, which only sets the walk's cost,
    /// _walkCost); once at most SHORTFALL_TOLERANCE is unmet the walk stops, so a removal fee never sends it to a
    /// further position and no further position is tried for a remainder the tolerance covers. A pair under a root
    /// hold (the mock's pairLocked; spec §3.8) is tried and refused: skipped, it takes nothing. The floors are the
    /// mock's reads raised to the spec's fallbacks, and the stake hotkey, the list and the margin the vault's stored
    /// values (the lens's raw reads of its storage): nothing from the vault's libraries.
    function _walk(uint256 wantWei) internal view returns (Removal[] memory rs, uint256 unmet) {
        unmet = wantWei;
        uint256 minStake = Math.max(staking.getDefaultMinStake(), MIN_STAKE_FALLBACK_RAO);
        uint256 minRemain = Math.max(staking.getNominatorMinRequiredStake(), MIN_REMAIN_FALLBACK_RAO);
        uint256 margin = vaultLens.unstakeMarginRao();
        bytes32 first = vaultLens.stakeHotkey();
        uint256 n = vaultLens.hotkeyCount();
        rs = new Removal[](n + 1);
        uint256 k;
        for (uint256 i; i <= n && unmet > SHORTFALL_TOLERANCE; ++i) {
            bytes32 h = i == 0 ? first : vaultLens.hotkeys(i - 1);
            if (i != 0 && h == first) continue;
            uint256 s = _stakeOf(h);
            if (s < minStake) continue;
            uint256 want = Math.max(Math.ceilDiv(unmet, RAO), minStake) + margin;
            bool full = want >= s || s - want < minRemain;
            if (full) want = s;
            bool skipped = staking.pairLocked(h);
            rs[k++] = Removal(h, want, full, skipped);
            if (!skipped) unmet = _sub0(unmet, want * RAO);
        }
        // the attempts made: the array cut to them
        assembly ("memory-safe") {
            mstore(rs, k)
        }
    }

    /// The walk's restatement (_walkCovers), for its pin against the vault (not in the fuzzer's selectors).
    function walkCovers(uint256 wantWei) external view returns (bool) {
        return _walkCovers(wantWei);
    }

    /// The walk's attempts (_walk), for its pins against the vault (not in the fuzzer's selectors).
    function walkRemovals(uint256 wantWei) external view returns (Removal[] memory rs) {
        (rs,) = _walk(wantWei);
    }

    /// A direct exit's restatement (_exitPlan), for its pins against the vault (not in the fuzzer's selectors).
    function exitPlanOf(uint256 available, uint256 out) external view returns (ExitOut memory) {
        return _exitPlan(available, out);
    }

    /// The cost from a call's logs (the check's side of _walkCost): what the chain kept of the stake its walk took,
    /// the vault's Unstaked events' wantRao x RAO less their receivedWei, summed and floored at 0, rounded up to rao
    /// (redeemDirect's and processPayouts' ceilToRao), and that stake at face value. Unstaked logs the whole position
    /// for a full removal and the ask for a partial one, so this assumes each removal's debit (the position's measured
    /// fall, which the vault charges against: debit x RAO less what it received) is its logged wantRao. That holds by
    /// construction on the mock, which takes exactly what is asked; on a chain whose removal fell by more than
    /// `want`, the vault would charge a rao the logs do not show (the README's checklist item 2 confirms it does not).
    function _loggedCost(Vm.Log[] memory logs) internal view returns (uint256 cost, uint256 taken) {
        uint256 received;
        for (uint256 i; i < logs.length; ++i) {
            if (!_isVaultLog(logs[i], Unstaked.selector)) continue;
            (uint256 wantRao, uint256 r) = abi.decode(logs[i].data, (uint256, uint256));
            taken += wantRao * RAO;
            received += r;
        }
        cost = Math.ceilDiv(_sub0(taken, received), RAO) * RAO;
    }

    /// After a call that may walk, its logs against the walk the model predicted for it before the call (`rs`, empty
    /// when it needs none; Task 36's fix round 2): the vault's Unstaked and UnstakeSkipped events, in order, must be
    /// exactly the predicted attempts, the same hotkeys in the same order, each removal's logged wantRao its predicted
    /// ask (the whole position for a full one) and each skip a held pair's; else walkMismatches. So a walk that tries a
    /// further position once at most T is unmet (spec §3.10.11), passes over one it should take, or asks other than its
    /// rule, is caught, whatever its receipts. Counts the walks checked (an attempt predicted or logged) and those of
    /// two or more removals.
    function _checkWalk(Vm.Log[] memory logs, Removal[] memory rs) internal {
        uint256 k;
        uint256 removals;
        bool off;
        for (uint256 i; i < logs.length; ++i) {
            bool skip = _isVaultLog(logs[i], UnstakeSkipped.selector);
            if (!skip && !_isVaultLog(logs[i], Unstaked.selector)) continue;
            if (!skip) ++removals;
            if (k == rs.length) {
                off = true;
                continue;
            }
            Removal memory r = rs[k++];
            if (logs[i].topics[1] != r.hotkey || skip != r.skipped) {
                off = true;
            } else if (!skip) {
                (uint256 wantRao,) = abi.decode(logs[i].data, (uint256, uint256));
                if (wantRao != r.wantRao) off = true;
            }
        }
        if (off || k != rs.length) ++walkMismatches;
        if (rs.length != 0 || k != 0 || off) ++walksChecked;
        if (removals > 1) ++walksOfSeveralRemovals;
    }

    // ---- the ghost ledger's stakes and removals, and the ghost base (I-2, I-5) ----

    /// A stake onto hotkey `h` that went through: the ghost books what `h`'s position rose by from `heldBefore`, at
    /// most what the vault's balance paid for it from `balanceBefore` (in rao), and the ramp restarts from now with
    /// its unspent part and that gain.
    function _bookStake(bytes32 h, uint256 heldBefore, uint256 balanceBefore) internal {
        uint256 paidRao = (balanceBefore - address(vault).balance) / RAO;
        uint256 gained = Math.min(_sub0(_stakeOf(h), heldBefore), paidRao);
        ghostBooked += gained;
        ghostRamping = _unspentRamp() + gained * RAO;
        ghostLastStakeAt = uint64(vm.getBlockTimestamp());
    }

    /// The listed hotkeys and the coldkey's position on each, read before a call that may remove stake.
    function _positions() internal view returns (bytes32[] memory hs, uint256[] memory ss) {
        uint256 n = vaultLens.hotkeyCount();
        hs = new bytes32[](n);
        ss = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            hs[i] = vaultLens.hotkeys(i);
            ss[i] = _stakeOf(hs[i]);
        }
    }

    /// Books a call's removals in the ghost ledger, from the positions before it (`hs`, `ss`): each fell by what was
    /// removed, which comes off the booked stake (floored), and the mock paid what was removed less its fee, which
    /// comes off the ramp (floored). Returns the positions removed from.
    function _bookRemovals(bytes32[] memory hs, uint256[] memory ss) internal returns (uint256 removals) {
        uint256 fee = staking.removeFeeRao();
        uint256 debit;
        uint256 received;
        for (uint256 i; i < hs.length; ++i) {
            uint256 d = _sub0(ss[i], _stakeOf(hs[i]));
            if (d == 0) continue;
            ++removals;
            debit += d;
            received += _sub0(d, fee) * RAO;
        }
        ghostBooked = _sub0(ghostBooked, debit);
        ghostRamping = _sub0(ghostRamping, received);
    }

    /// The ghost ramp's unspent part now (CascadeFormulas.unspent over STAKE_RAMP from the ghost's last stake).
    function _unspentRamp() internal view returns (uint256) {
        uint256 elapsed = vm.getBlockTimestamp() - ghostLastStakeAt;
        return elapsed >= STAKE_RAMP ? 0 : ghostRamping * (STAKE_RAMP - elapsed) / STAKE_RAMP;
    }

    /// I-5's base on the ghosts: min(visible, booked) in wei, the visible stake read on the mock's positions and the
    /// booked from the ghost ledger, less the ghost ramp's unspent part.
    function ghostBase() public view returns (uint256) {
        return _sub0(Math.min(_visible(), ghostBooked) * RAO, _unspentRamp());
    }

    // ---- the assets, on the mock's positions ----

    function _stakeOf(bytes32 h) internal view returns (uint256) {
        return staking.getStake(h, coldkey, 0);
    }

    /// The listed stake, read on the mock's positions over the vault's list.
    function _visible() internal view returns (uint256 total) {
        uint256 n = vaultLens.hotkeyCount();
        for (uint256 i; i < n; ++i) {
            total += _stakeOf(vaultLens.hotkeys(i));
        }
    }

    /// The vault's assets with `bookedRao` booked: min(visible, booked) in wei plus the balance, less the reserve, the
    /// queued payouts (the lens's) and the unvested rewards, floored.
    function _assetsAt(uint256 bookedRao) internal view returns (uint256) {
        return _assetsAt(bookedRao, vaultLens.pendingPayouts());
    }

    /// _assetsAt with `pending` as the queued payouts (a handler's own count of them, where it keeps one).
    function _assetsAt(uint256 bookedRao, uint256 pending) internal view returns (uint256) {
        uint256 gross = _sub0(Math.min(_visible(), bookedRao) * RAO + address(vault).balance, ED);
        return _sub0(gross, pending + vaultLens.unvestedRewards());
    }

    /// Whether stake is missing with `listedRao` listed and `bookedRao` booked, by the spec's rule restated (§3.1):
    /// the booked above the listed stake by more than the larger of 0.1% of the booked less the queued payouts (the
    /// lens's, in rao; R6 E-fix) and 0.001 TAO. No handler step it models moves the queue.
    function _missingAt(uint256 listedRao, uint256 bookedRao) internal view returns (bool) {
        uint256 backing = _sub0(bookedRao, vaultLens.pendingPayouts() / RAO);
        return
            _sub0(bookedRao, listedRao) > Math.max(backing * MISSING_TOLERANCE_BPS / 10_000, MIN_MISSING_TOLERANCE_RAO);
    }
}
