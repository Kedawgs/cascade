// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ISTAKING_ADDRESS, IStaking} from "../interfaces/IStaking.sol";
import {WalkParams} from "../CascadeTypes.sol";
import {EXIT_GAS_RESERVE, NETUID_ROOT, RAO} from "../CascadeConstants.sol";
import {UnstakeSkipped} from "../CascadeEvents.sol";
import {CascadeFormulas} from "./CascadeFormulas.sol";
import {CascadeLedger} from "./CascadeLedger.sol";

/// @notice L2, the vault's unstake walk (spec §8.1): v3.1's `_unstake`, moved whole, and since Task 20 robust to a root
/// hold (spec §3.8): each removal runs in a `try` with its share of the gas, and one that fails is skipped.
/// @dev A linked external library, run only by the vault's DELEGATECALL, in the vault's context: its
/// Unstaked and UnstakeSkipped events come from the vault's address, the precompile sees the vault as the caller (its
/// coldkey, its balance), and the compiler's call guard reverts a direct call. It writes nothing: it
/// holds no state and takes no storage pointer (the hotkey set comes as a memory copy in `p`), and
/// returns what the walk received and the stake it took for the caller to book (CascadeLedger.applyWalk).
/// It calls only the staking precompile: the floor and stake reads and the removals. The vault sets its
/// transient `_unstaking` around the call, so the precompile's TAO enters the vault's receive() as in v3.1. Its
/// one caller is the vault's `_unstake`, for exactly redeemDirect and processPayouts (rev 12 L-3), whose walk the
/// vault runs between the payout engine's two halves: L3 neither links nor calls L2 (the 5g ruling, since no
/// library can set the transient flag); removeHotkey keeps its direct removal (the owner's, in L4,
/// CascadeHotkeyLib), which reverts when the chain refuses it.
library CascadeStakeLib {
    /// Unstakes `wantWei` (when the stake allows), less at most `p.shortfallToleranceWei`, walking `p.first`
    /// (the stake hotkey) first and then `p.hotkeys` in order, skipping the stake hotkey there. The walk counts the
    /// stake its removals take, at face value (rao × RAO), against the request, never what the chain paid for it
    /// (what the chain keeps is the caller's exit's cost: spec §3.3, the founder's ruling of 2026-11-06), and stops
    /// once what is unmet is within `p.shortfallToleranceWei` (spec §3.10.11): a removal fee never sends it to a
    /// further position, no further position is stripped of the minimum stake for a remainder the caller's tolerance
    /// covers, and a `wantWei` already within it removes nothing. Before the walk it reads each position once and
    /// counts those of at least the minimum stake (`positionsLeft`, spec §3.10.9); a position below it is neither
    /// counted nor tried (the chain may refuse to touch it). Rounds each request up to the minimum stake, adds
    /// `p.margin`, and exits a position fully when the chain would sweep its remainder anyway. The floors are read
    /// here, at walk time: the larger of the precompile's live read and the constant fallback (CascadeFormulas:
    /// FALLBACK_MIN_STAKE_RAO, FALLBACK_MIN_REMAIN_RAO).
    /// Each removal is forwarded max(p.unstakeGas, (gasleft - EXIT_GAS_RESERVE) / positionsLeft) gas, positionsLeft
    /// counting itself and the positions after it, so the last one tried gets the rest less the reserve and the
    /// walk's caller keeps EXIT_GAS_RESERVE for its work after the walk (spec §3.8), as long as each share is at least
    /// p.unstakeGas. Below that every removal gets p.unstakeGas, and removals that burn it can eat into the reserve:
    /// the caller then runs out of gas and reverts whole (nothing lost; README, the caller's gas limit). A removal
    /// that fails, however (a refusal, a root hold on the pair above all, or burning the gas it was given), is skipped:
    /// it logs UnstakeSkipped, adds nothing to what was received or debited, and the walk goes on to the next
    /// position; what it leaves unmet is the caller's to judge (the vault's UnstakeShort). The catch takes every
    /// failure of the removal call itself (any revert data, a panic, the gas it was given running out), never one in
    /// this frame (the compiler's check that the precompile has code still reverts the walk, as before).
    /// Returns the part of `wantWei` the stake the removals took, at face value, did not cover (0 when covered, never
    /// more than `wantWei`; the caller decides what is too much), the total received (wei: the ramp's debit) and the
    /// stake the removals that went through took off their positions (rao, each one's stake before less after: the
    /// booked stake's debit). What the chain kept of that stake, debitRao × RAO less receivedWei, is the caller's to
    /// charge (the vault's `_unstake`). Any excess received stays idle for stakeIdle.
    function unstake(WalkParams memory p, uint256 wantWei)
        external
        returns (uint256 unmetWei, uint256 receivedWei, uint256 debitRao)
    {
        unmetWei = wantWei;
        uint256 minStake = CascadeFormulas.minStakeRao();
        uint256 minRemain = CascadeFormulas.minRemainRao();
        // The positions large enough to unstake, in the walk's order, each read once: no removal moves another
        // position, and a skipped one moves nothing. i == 0 is the stake hotkey; i >= 1 is p.hotkeys[i - 1], skipping
        // the stake hotkey. An empty position is below the minimum too (minStake >= the fallback >= 1).
        uint256 n = p.hotkeys.length;
        bytes32[] memory keys = new bytes32[](n + 1);
        uint256[] memory stakes = new uint256[](n + 1);
        uint256 positionsLeft;
        for (uint256 i; i <= n; ++i) {
            bytes32 h = i == 0 ? p.first : p.hotkeys[i - 1];
            if (i != 0 && h == p.first) continue;
            uint256 s = CascadeFormulas.stakeOf(h, p.coldkey);
            if (s < minStake) continue;
            keys[positionsLeft] = h;
            stakes[positionsLeft] = s;
            ++positionsLeft;
        }
        uint256 count = positionsLeft;
        for (uint256 i; i < count && unmetWei > p.shortfallToleranceWei; ++i) {
            (bytes32 h, uint256 s) = (keys[i], stakes[i]);
            uint256 want = Math.max(Math.ceilDiv(unmetWei, RAO), minStake) + p.margin;
            bool full = want >= s || s - want < minRemain;
            // a full removal takes the whole position, which its Unstaked logs (R2 F2); a partial one, the request
            if (full) want = s;
            uint256 before = address(this).balance;
            // positionsLeft >= 1 here: it counts this position and those after it
            uint256 gas = Math.max(p.unstakeGas, CascadeFormulas.sub0(gasleft(), EXIT_GAS_RESERVE) / positionsLeft);
            --positionsLeft;
            if (!_tryRemoval(h, want, full, gas)) {
                emit UnstakeSkipped(h);
                continue;
            }
            (uint256 received, uint256 debit) = CascadeLedger.removalMeasured(h, p.coldkey, s, want, before);
            // the stake taken at face value, not the receipt: what the chain kept is the exit's cost, never unmet
            unmetWei = CascadeFormulas.sub0(unmetWei, debit * RAO);
            receivedWei += received;
            debitRao += debit;
        }
    }

    /// One removal of the walk, `want` rao off `h` (its whole root position when `full`), forwarded `gas`: whether it
    /// went through. Any failure of the call is caught (spec §3.8): the walk skips the position.
    function _tryRemoval(bytes32 h, uint256 want, bool full, uint256 gas) private returns (bool) {
        if (full) {
            try IStaking(ISTAKING_ADDRESS).removeStakeFull{gas: gas}(h, NETUID_ROOT) {
                return true;
            } catch {
                return false;
            }
        }
        try IStaking(ISTAKING_ADDRESS).removeStake{gas: gas}(h, want, NETUID_ROOT) {
            return true;
        } catch {
            return false;
        }
    }
}
