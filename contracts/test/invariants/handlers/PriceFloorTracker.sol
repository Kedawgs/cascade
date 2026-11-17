// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CommonBase} from "forge-std/Base.sol";
import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CascadeVaultLens} from "../../../src/lens/CascadeVaultLens.sol";
import {ISTAKING_ADDRESS} from "../../../src/interfaces/IStaking.sol";
import {CascadeMath} from "../../../src/libraries/CascadeMath.sol";
import {ShortfallAbsorbed, Staked, Unstaked} from "../../../src/CascadeEvents.sol";
import {MockStaking} from "../../mocks/MockStaking.sol";
import {VaultInternals} from "../../utils/VaultInternals.sol";

/// @notice I-4's bookkeeping for every Phase 8 handler (moved out of CoreHandler in Task 34a; TrackedHandler extends
/// it): the price floor, the exceptions that may lower it and their bounds, and the supply-0 gap they leave.
///
/// I-4 (spec §3.1): `priceFloor` is the highest price seen since the last exception: every step raises it at its start
/// and its end, and right after each warp inside it. A step that falls under one of I-4's exceptions records it itself,
/// checks the fall against that exception's bound and restarts the floor from the price after it; the invariant reads
/// only the floor and the counters, never the price alone. Here: the exception's record (`_exception`, `_rebase`), the
/// chain's cut of the owner's own removal of a sub-minimum leftover (`_ownerRemovalCut`: at most the removal fee a
/// receipt), the 1-rao-short read of a fresh position (`_freshRead`), and, at a supply of 0, the next mint, which
/// absorbs the payout gap an earlier exception left (`holeWei`, given back through `_giveBack`), within the 1,000-rao
/// tolerance (the cut only with nothing vesting): the `mints` modifier. A cancel lowers the price only over a hole (the
/// cancel bound, `cancelBoundMet` against `cancelFloor`, a rao a re-minted entry there and none elsewhere); at a supply
/// of 0 it also gives back what an earlier exception left of the payout gap or of the whole shortfall
/// (`shortfallHoleWei`, which no mint reads: Task 36's fix round 3), and above a supply of 0 the hole it starts over
/// with the assets reading 0 (`_holeOver`), at most the re-minted entries' value (`_cancelGiveBack`). A handler's
/// other exceptions (a swap, a simulated loss) call `_exception` with what they took out. No exit is one (Task 36b,
/// the leaver pays): a walk's removal fee is the exit's own cost (`_exitRemovals` keeps its ghost).
///
/// I-35 (spec §3.1, the founder's ruling of 2026-11-06): no exit lowers the holders' price. Around every direct exit,
/// every sent payout chunk and every cancel, the handler reads the assets, the supply and the hole (the queued payouts
/// and the unvested rewards above the gross) just before the call (`_markPrice`) and checks right after it
/// (`_checkExitPrice`) that `(A' + 1)(S + 1e6) >= (A + 1)(S' + 1e6)`, the price exactly, and that the hole is no larger:
/// no allowance, at any fee (`exitPriceFalls`). A cancel that starts with totalAssets() reading 0 over a hole a recorded
/// exception left (`exceptionHole`) is the one exemption.
///
/// I-1 at a supply of 0 (`guardMisses`, which handlers add their own misses to): no mint at a supply of 0 underwater
/// (a step that starts there and ends with shares).
abstract contract PriceFloorTracker is CommonBase {
    uint256 internal constant RAO = 1e9;
    /// The vault's UNDERWATER_TOLERANCE, restated: how far, in wei, its gross may fall short of the queued
    /// payouts, with nothing vesting, before it refuses every mint (1,000 rao).
    uint256 internal constant UNDERWATER_TOLERANCE = 1_000 * RAO;
    /// The vault's SHORTFALL_TOLERANCE_RAO, restated in wei: the most of its request a walk may leave untaken at face
    /// value (Task 19, I-13; Task 36b), which a direct exit's leaver bears with the walk's cost.
    uint256 internal constant SHORTFALL_TOLERANCE = 1_000 * RAO;

    /// The vault, as its test-only subclass (ruling DA10's harness): the handler reads every value through
    /// `vaultLens`, the booked stake (Task 12) and the ramping stake (R2 F4) included.
    VaultInternals public immutable vault;
    /// The read-only lens on `vault` (spec §8.1): the vault serves no view of its own but the token's.
    CascadeVaultLens public immutable vaultLens;
    MockStaking public constant staking = MockStaking(ISTAKING_ADDRESS);

    /// I-4: the highest price seen since the last exception; each exception's step restarts it from the price after
    /// it, once it has checked the fall against the exception's bound.
    uint256 public priceFloor;
    /// I-4: exceptions that fell further than their bound (a loss, a swap or a short receipt by more than it took
    /// out, a short receipt of more than 1,000 rao, a fresh read more than 1 rao short, a mint at a supply of 0
    /// absorbing more than the recorded gap). The cancel's bound has its own counter, in the handler that cancels.
    uint256 public exceptionOverruns;
    /// I-4, at a supply of 0: the payout gap (the queued payouts above the gross) that recorded exceptions left,
    /// which the next mint absorbs (spec §3.1: within the 1,000-rao tolerance; past it every mint is refused).
    uint256 public holeWei;
    /// I-4, at a supply of 0 (Task 36's fix round 3, as ruled; since Task 36b fed only by the exceptions that are no
    /// exit: a loss, a swap, a fresh read, the owner's removal's cut): what recorded exceptions left of the vault's whole
    /// shortfall, the queued payouts and the unvested rewards above the gross (`_shortfall`), payout gap and vesting
    /// schedule together (a claim's vesting stake can move a payout gap into the schedule, so the record keeps no
    /// split). Its bounds:
    /// - it grows only at a recorded exception at a supply of 0, by at most that exception's allowance and at most the
    ///   live whole shortfall then (`_exception`);
    /// - it is forgotten when the whole shortfall closes (each step's end, `_forgetClosedShortfallHole`) or the supply
    ///   leaves 0 by any path but a cancel that absorbs it (any mint: TrackedHandler's `_onLogs`; a cancel that absorbs
    ///   it spends it, `_shortfallHoleAbsorbed`);
    /// - only a cancel at a supply of 0 reads it, which gives back max(the payout-gap give-back, min(the record, the
    ///   live whole shortfall)), at most the re-minted entries' value (`_shortfallGiveBackNow`, `_cancelGiveBack`).
    /// holeWei, `_gap`, `_giveBack` and the `mints` path never read it: a deposit at a supply of 0 writes the schedule
    /// down first (Task 15) and never absorbs it.
    uint256 public shortfallHoleWei;
    /// Cancels at a supply of 0 that gave back more than the payout-gap give-back, from shortfallHoleWei.
    uint256 public i4ShortfallHolesAbsorbed;
    /// What the chain kept of the vault's TAO, in wei: unstake receipts short of the stake their removals took (the
    /// mock's removal fee: an exit's own cost, or the owner's removal's cut), and the rao a fresh position's read came
    /// back short of what was staked for it.
    uint256 public ghostReceiptShort;
    uint256 public ghostReadShort;
    /// Whether a recorded exception left a hole (the queued payouts and the unvested rewards above the gross) that is
    /// still open: set by `_exception` when the hole is open after it, cleared once the hole closes (each step's end).
    /// I-35's exemption reads it: a cancel over such a hole may lower the price.
    bool public exceptionHole;
    /// I-35: exits (direct exits, sent chunks, cancels) checked around their call, and those whose price, exactly, or
    /// whose hole was worse after them (asserted 0).
    uint256 public exitsPriceChecked;
    uint256 public exitPriceFalls;
    /// Steps whose exit's walk cost something (the chain kept part of the stake it took, which the exit bore).
    uint256 public exitsCharged;
    /// I-1: calls that did what the vault's stake guard or its supply-0 underwater refusal forbids (see the
    /// handler's notes; the `mints` modifier counts a mint at a supply of 0 underwater here).
    uint256 public guardMisses;
    /// I-4's exceptions recorded here, each counted by the step that caused it: the owner's removals whose cut the
    /// holders absorbed, fresh reads one rao short, and mints at a supply of 0 that absorbed a recorded gap.
    uint256 public i4RemovalCuts;
    uint256 public i4FreshReads;
    uint256 public i4GapsAbsorbed;

    constructor(VaultInternals vault_, CascadeVaultLens vaultLens_) {
        vault = vault_;
        vaultLens = vaultLens_;
        priceFloor = vaultLens_.price();
    }

    /// @dev A step that can mint at a supply of 0 (a delivery, a direct deposit, a cycle, a claim's cut). Starting at a
    /// supply of 0 underwater (the vault refuses every mint there, I-1) and ending with shares is a refusal that did
    /// not happen: a guard miss. Starting at a supply of 0 with a payout gap that recorded exceptions left (holeWei),
    /// the next minter absorbs that gap (spec §3.1, I-4), so the price after it may fall by at most the gap, within
    /// the 1,000-rao tolerance (_giveBack), and the floor restarts there. A gap that closes forgets the record.
    modifier mints() {
        uint256 supply0 = vault.totalSupply();
        uint256 gap0 = _gap();
        bool underwater0 = supply0 == 0 && _underwater();
        _;
        if (supply0 == 0) {
            if (underwater0 && vault.totalSupply() != 0) ++guardMisses;
            if (holeWei != 0 && gap0 != 0) {
                if (vault.totalSupply() != 0) ++i4GapsAbsorbed;
                _rebase(_giveBack(gap0, true));
            }
        }
        if (_gap() == 0) holeWei = 0;
    }

    /// The price a cancel of a batch may fall to, before its dust: the floor alone, whatever the batch's delivery
    /// price. Each re-minted entry gets the shares its value buys at the price before the cancel, never more than it
    /// burned (Task 34c, spec §3.5), so the delay's rewards stay with the holders who stayed.
    function cancelFloor(bytes32) public view returns (uint256) {
        return priceFloor;
    }

    /// I-4's cancel bound: with one rao given back for each of `dustEntries` re-minted entries (a cancel over a hole's;
    /// none elsewhere, Task 36b: outside a hole the re-mint rounds in the vault's favour), the price of `assets` over
    /// `supply` is at least `bound_`, the cancel's floor (cancelFloor).
    function cancelBoundMet(uint256 assets, uint256 supply, uint256 dustEntries, uint256 bound_)
        public
        pure
        returns (bool)
    {
        return CascadeMath.price(assets + dustEntries * RAO, supply) >= bound_;
    }

    /// What a cancel gives back to the assets for its bound: the payout gap's and the whole shortfall's give-backs it
    /// read before the call (at a supply of 0), or `holeOver`, the hole it starts over above a supply of 0
    /// (`_holeOver`), at most `reMintedValue`, the re-minted entries' value (Task 36's re-review: the re-minted
    /// holders' fair fall is at most what they bring back, so a record above it never widens the bound).
    function _cancelGiveBack(uint256 gapAllowance, uint256 shortfallBack, uint256 holeOver, uint256 reMintedValue)
        internal
        pure
        returns (uint256)
    {
        return Math.min(Math.max(gapAllowance + shortfallBack, holeOver), reMintedValue);
    }

    // ---- the floor and the exceptions ----

    function _raiseFloor() internal {
        priceFloor = Math.max(priceFloor, vaultLens.price());
    }

    /// An I-4 exception's step: the price after it, with `allowance` wei given back to the assets (what the exception
    /// took out), must be at least the floor before it, else it overran its bound; the floor restarts from the price
    /// after it. What the exception left of a payout gap (the queued payouts above the gross) is recorded for the next
    /// mint at a supply of 0, which absorbs it; at a supply of 0, what it left of the whole shortfall (at most
    /// `allowance` and at most the live `_shortfall`) is recorded apart, for a cancel alone (shortfallHoleWei).
    function _exception(uint256 allowance) internal {
        _rebase(allowance);
        holeWei += Math.min(allowance, _gap());
        if (vault.totalSupply() == 0) shortfallHoleWei += Math.min(allowance, _shortfall());
        if (_shortfall() != 0) exceptionHole = true;
    }

    function _rebase(uint256 allowance) internal {
        if (CascadeMath.price(vaultLens.totalAssets() + allowance, vault.totalSupply()) < priceFloor) {
            ++exceptionOverruns;
        }
        priceFloor = Math.min(priceFloor, vaultLens.price());
    }

    /// What an exit's walk left with the chain (a payout chunk, a direct exit, a cycle's exit), from its `logs` and the
    /// coldkey's stake before it, in wei: the stake its removals took less what they paid (the removal fee), the exit's
    /// own cost, which its leaver or its chunk's entries bore (spec §3.3, Task 36b): no I-4 exception, only the ghost of
    /// what the chain kept (ghostReceiptShort) and the step counted (exitsCharged).
    function _exitRemovals(Vm.Log[] memory logs, uint256 stakeBefore) internal returns (uint256 short) {
        short = _removalShort(logs, stakeBefore);
        if (short == 0) return 0;
        ghostReceiptShort += short;
        ++exitsCharged;
    }

    /// The chain's cut of the owner's own removal of a sub-minimum leftover (removeHotkey's direct removal, L4, no exit:
    /// housekeeping, the founder's answer 4), from its `logs` and the coldkey's stake before it: what the removal kept
    /// back, which the holders absorb, I-4's exception, at most `perReceipt` wei a receipt (the removal fee; each
    /// Unstaked event one receipt).
    function _ownerRemovalCut(Vm.Log[] memory logs, uint256 stakeBefore, uint256 perReceipt) internal {
        uint256 short = _removalShort(logs, stakeBefore);
        if (short == 0) return;
        ghostReceiptShort += short;
        ++i4RemovalCuts;
        if (short > _receipts(logs) * perReceipt) ++exceptionOverruns;
        _exception(short);
    }

    // ---- I-35: no exit lowers the price ----

    /// I-35's reads just before an exit (see the contract's notes): the assets and the supply, and the hole.
    function _markPrice() internal view returns (uint256[3] memory m) {
        m = [vaultLens.totalAssets(), vault.totalSupply(), _shortfall()];
    }

    /// I-35 right after an exit that `m` marked: `(A' + 1)(S + 1e6) >= (A + 1)(S' + 1e6)` (the price with the virtual
    /// offsets, exactly, not the view's floored division) and the hole no larger; else exitPriceFalls.
    function _checkExitPrice(uint256[3] memory m) internal {
        ++exitsPriceChecked;
        uint256 a = vaultLens.totalAssets();
        uint256 s = vault.totalSupply();
        if ((a + 1) * (m[1] + 1e6) < (m[0] + 1) * (s + 1e6) || _shortfall() > m[2]) ++exitPriceFalls;
    }

    /// Whether a cancel that `m` marked starts with totalAssets() reading 0 over a hole a recorded exception left,
    /// I-35's one exemption (and the cancel bound's dust).
    function _cancelOverAHole(uint256[3] memory m) internal view returns (bool) {
        return m[0] == 0 && m[2] != 0 && exceptionHole;
    }

    /// The hole a cancel that `m` marked absorbs above a supply of 0: when it starts over a hole a recorded exception
    /// left with totalAssets() reading 0 and a supply above 0, that hole (I-4's "the owner's cancel that absorbs that
    /// hole", at any supply: the holders could not absorb it, their price floored at the virtual offsets, so the
    /// re-minted holders do), else 0. No record is kept above a supply of 0, and no exit leaves a hole (I-35), so the
    /// hole is the exceptions'. At a supply of 0 the records (`holeWei`, `shortfallHoleWei`) give it back instead. A
    /// dust supply's price at assets of 0 is still about the launch price (a few wei of shares against the 10^6
    /// offset), so the floor does not fall with it (Task 36b's mutation run found it; BASE's bound failed it too).
    function _holeOver(uint256[3] memory m) internal view returns (uint256) {
        return m[1] != 0 && _cancelOverAHole(m) ? m[2] : 0;
    }

    /// The vault's Unstaked events in `logs`: one per removal that went through.
    function _receipts(Vm.Log[] memory logs) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (_isVaultLog(logs[i], Unstaked.selector)) ++n;
        }
    }

    /// A stake whose fresh position read short (the vault's Staked event: `measured` below the `rao` it staked): the
    /// rao is gone and the holders absorb it, I-4's last exception, at most 1 rao, and only of a fresh position (the
    /// stake hotkey held `heldBefore` before the stake: none).
    function _freshRead(Vm.Log[] memory logs, uint256 heldBefore) internal {
        for (uint256 i; i < logs.length; ++i) {
            if (!_isVaultLog(logs[i], Staked.selector)) continue;
            (uint256 rao, uint256 measured) = abi.decode(logs[i].data, (uint256, uint256));
            if (measured >= rao) return;
            uint256 short = (rao - measured) * RAO;
            ghostReadShort += short;
            ++i4FreshReads;
            if (short > RAO || heldBefore != 0) ++exceptionOverruns;
            _exception(short);
            return;
        }
    }

    /// What a step's removals kept back, in wei: the coldkey's stake that left (from `stakeBefore`, in rao) less what
    /// the vault's Unstaked events say the balance received.
    function _removalShort(Vm.Log[] memory logs, uint256 stakeBefore) internal view returns (uint256) {
        uint256 received;
        for (uint256 i; i < logs.length; ++i) {
            if (!_isVaultLog(logs[i], Unstaked.selector)) continue;
            (, uint256 r) = abi.decode(logs[i].data, (uint256, uint256));
            received += r;
        }
        return _sub0(_sub0(stakeBefore, _coldkeyStake()) * RAO, received);
    }

    /// The `unmet` of the vault's ShortfallAbsorbed in `logs` (what a direct exit's leaver bore of its receipts'
    /// shortfall), or 0 when there is none.
    function _absorbed(Vm.Log[] memory logs) internal view returns (uint256) {
        for (uint256 i; i < logs.length; ++i) {
            if (_isVaultLog(logs[i], ShortfallAbsorbed.selector)) return abi.decode(logs[i].data, (uint256));
        }
        return 0;
    }

    // ---- the supply-0 gap ----

    /// What a step at a supply of 0 gives back to the assets of a payout gap `gap`: what recorded exceptions left of
    /// it, and, when `capped` (a mint, which the vault refuses past the tolerance), within the vault's 1,000-rao
    /// tolerance (spec §3.1). The owner's cancel is not refused underwater, so its give-back is not capped.
    function _giveBack(uint256 gap, bool capped) internal view returns (uint256 back) {
        back = Math.min(holeWei, gap);
        if (capped) back = Math.min(back, UNDERWATER_TOLERANCE);
    }

    /// `_giveBack` of the live gap when the supply is 0 now, else nothing.
    function _giveBackNow(bool capped) internal view returns (uint256) {
        return vault.totalSupply() == 0 ? _giveBack(_gap(), capped) : 0;
    }

    /// The queued payouts above the gross, in wei: the payout gap a mint at a supply of 0 would absorb.
    function _gap() internal view returns (uint256) {
        return _sub0(vaultLens.pendingPayouts(), vaultLens.grossAssets());
    }

    // ---- the supply-0 shortfall hole (Task 36's fix round 3; a cancel's alone) ----

    /// The vault's whole shortfall, in wei: the queued payouts and the unvested rewards above the gross (the payout
    /// gap, `_gap`, and the vesting schedule's shortfall together).
    function _shortfall() internal view returns (uint256) {
        return _sub0(vaultLens.pendingPayouts() + vaultLens.unvestedRewards(), vaultLens.grossAssets());
    }

    /// What a cancel at a supply of 0 gives back beyond the payout-gap give-back (`_giveBackNow(false)`), so that the
    /// two together are max(that give-back, min(shortfallHoleWei, the live whole shortfall)); 0 at any other supply.
    function _shortfallGiveBackNow() internal view returns (uint256) {
        if (vault.totalSupply() != 0) return 0;
        return _sub0(Math.min(shortfallHoleWei, _shortfall()), _giveBack(_gap(), false));
    }

    /// A cancel that gave `back` beyond the payout-gap give-back: counted, and the record spent.
    function _shortfallHoleAbsorbed(uint256 back) internal {
        if (back == 0) return;
        ++i4ShortfallHolesAbsorbed;
        shortfallHoleWei = 0;
    }

    /// The record forgotten once the supply is not 0 or the whole shortfall has closed (each step's end); the exception
    /// hole's flag once the hole has closed.
    function _forgetClosedShortfallHole() internal {
        if (shortfallHoleWei != 0 && (vault.totalSupply() != 0 || _shortfall() == 0)) shortfallHoleWei = 0;
        if (exceptionHole && _shortfall() == 0) exceptionHole = false;
    }

    /// Whether the vault refuses a deposit as underwater, by the ruling's rule as written: its gross short of the
    /// queued payouts and the unvested rewards, by any amount while any reward vests, and otherwise short of
    /// the payouts by more than the tolerance. At a supply of 0 a deposit first writes the unvested rewards down
    /// to what the gross holds beyond the payouts (Task 15), so there only a payout shortfall past the tolerance
    /// refuses. Its assets then read 0, which the half-launch line sees only while shares are outstanding.
    function _underwater() internal view returns (bool) {
        return _underwaterAs(vault.totalSupply() == 0);
    }

    /// The spec's underwater rule as written (§3.1, I-1), on the gross, the queued payouts and the unvested rewards:
    /// `pending + unvested > gross && (unvested != 0 || pending > gross + UNDERWATER_TOLERANCE)`, with the unvested
    /// rewards first written down to what the gross holds beyond the payouts when `writtenDown` (a deposit's read at a
    /// supply of 0, Task 15), and as they are otherwise (the reward cut's read, which no write-down precedes).
    function _underwaterAs(bool writtenDown) internal view returns (bool) {
        uint256 gross = vaultLens.grossAssets();
        uint256 pending = vaultLens.pendingPayouts();
        uint256 unvested = vaultLens.unvestedRewards();
        if (writtenDown) unvested = Math.min(unvested, _sub0(gross, pending));
        return pending + unvested > gross && (unvested != 0 || pending > gross + UNDERWATER_TOLERANCE);
    }

    // ---- reads ----

    /// The vault's coldkey's root stake under every hotkey, listed or not, in rao.
    function _coldkeyStake() internal view returns (uint256) {
        return staking.getTotalColdkeyStakeOnSubnet(vaultLens.coldkey(), 0);
    }

    function _isVaultLog(Vm.Log memory log, bytes32 sig) internal view returns (bool) {
        return log.emitter == address(vault) && log.topics[0] == sig;
    }

    function _sub0(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }
}
