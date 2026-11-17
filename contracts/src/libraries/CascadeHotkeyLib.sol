// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ISTAKING_ADDRESS, IStaking} from "../interfaces/IStaking.sol";
import {MAX_HOTKEYS, NETUID_ROOT, RAO} from "../CascadeConstants.sol";
import {
    HotkeyHasRewards,
    HotkeyInUse,
    HotkeyKnown,
    InvalidParameter,
    NotAuthorized,
    NotEligible,
    SlotReserved,
    TooManyHotkeys,
    UnknownHotkey,
    ZeroHotkey
} from "../CascadeErrors.sol";
import {HotkeyAdded, HotkeyRemoved, StakeMoved} from "../CascadeEvents.sol";
import {CascadeFormulas} from "./CascadeFormulas.sol";
import {CascadeLedger} from "./CascadeLedger.sol";

/// @notice L4, the vault's hotkey management (spec §8.1, the reserve lever): the bodies of `addHotkey`,
/// `removeHotkey` and `moveStake` after the vault's role reads, moved whole: the permissionless way back
/// (NotEligible), the reserved last slot (SlotReserved), the three removal paths and their authorization, the
/// owner's leftover handling (moved to the stake hotkey, or below the minimum removed into balance), the
/// list's writes (push, swap-and-pop), `isHotkey` and `lastClaimAt`, and the precompile calls they make.
/// @dev A linked external library, run only by the vault's DELEGATECALL, in the vault's context: its events come
/// from the vault's address, the precompile sees the vault as the caller (its coldkey, its balance), and the
/// compiler's call guard reverts a direct call. It holds no state and writes only through its storage pointers:
/// the hotkey list, `isHotkey` and `lastClaimAt`, exactly the write set the library rules hold it to. It writes
/// nothing of the ledger: the owner's direct removal returns its two measurements, which the vault books
/// (CascadeLedger.applyWalk), as it books L2's walk. What it only reads comes as values (the booked stake for the
/// guard, moveStake's listing of `from`). It calls only the staking precompile, and only the functions the library
/// rules allow it. It reads neither msg.sender nor msg.value: the vault passes who the caller is (`privileged`;
/// `byOwner`, `byKeeperOrGuardian`) and what it cannot read itself (the coldkey, an immutable; the stake
/// hotkey and the dust allowance, values; the staking floor it reads itself, against the constant fallback,
/// CascadeFormulas.minStakeRao, since Task 23). It never sets the vault's transient
/// unstake flag: the vault sets it around the owner's removal call, the only one that can unstake, and clears it
/// before it books what that call returns.
/// Each rule reads the stake guard as the vault does (CascadeFormulas.stakeMissing on the visible stake over
/// the list and the ledger's booked stake), and only where the vault read it, so every precompile read is made
/// in v3.1's order and only when it was.
library CascadeHotkeyLib {
    /// addHotkey's body (spec §3.1, I-6): lists `h` without routing new stake to it. `privileged` (the owner, the
    /// guardian or the keeper) may add at any time; anyone else only while stake is missing, of a hotkey never
    /// listed (`lastClaimAt[h] == 0`) holding at least the chain's minimum of the vault's root stake, else
    /// NotEligible. Then, for every caller: never the zero hotkey (ZeroHotkey) or a listed one (HotkeyKnown), at
    /// most MAX_HOTKEYS (TooManyHotkeys), and the add that fills the last slot only while stake is missing and
    /// `h` holds that minimum (SlotReserved). A hotkey never seen before starts its claim fallback now; a
    /// re-added one keeps its last claim. `booked` is the ledger's booked stake, as the vault read it (the guard's
    /// other half). The constructor lists its first hotkey here too, as `privileged`, on an empty list and ledger
    /// (nothing missing: no precompile read).
    function add(
        bytes32[] storage hotkeys,
        mapping(bytes32 => bool) storage isHotkey,
        mapping(bytes32 => uint64) storage lastClaimAt,
        bytes32 h,
        bool privileged,
        bytes32 coldkey,
        uint256 booked,
        uint256 pending
    ) external {
        bool swapped = _stakeMissing(hotkeys, booked, pending, coldkey)
            && CascadeFormulas.stakeOf(h, coldkey) >= CascadeFormulas.minStakeRao();
        if (!privileged) {
            if (!swapped || lastClaimAt[h] != 0) revert NotEligible();
        }
        if (h == bytes32(0)) revert ZeroHotkey();
        if (isHotkey[h]) revert HotkeyKnown();
        uint256 n = hotkeys.length;
        if (n >= MAX_HOTKEYS) revert TooManyHotkeys();
        if (n == MAX_HOTKEYS - 1 && !swapped) revert SlotReserved();
        hotkeys.push(h);
        isHotkey[h] = true;
        if (lastClaimAt[h] == 0) lastClaimAt[h] = uint64(block.timestamp);
        emit HotkeyAdded(h);
    }

    /// removeHotkey's body (spec §3.1, §3.10.4, §3.10.10): never an unlisted hotkey (UnknownHotkey) or the stake
    /// hotkey (HotkeyInUse). Stake left on `h` only the owner may handle (else NotAuthorized): it moves to the
    /// stake hotkey or, below the chain's minimum, is removed into balance by the vault's own direct removal (not
    /// L2's walk: the chain's refusal reverts; spec §8.1), whose two measurements it returns for the vault to book
    /// as a walk's (`receivedWei` and `debitRao`; both 0 when nothing was removed). Then the owner refuses
    /// unclaimed rewards above the dust allowance unless `forfeit` (HotkeyHasRewards); the keeper or the guardian
    /// removes only within the dust allowance, and anyone else only with nothing unclaimed while the set is full
    /// and stake is missing (else NotAuthorized; `booked`, the ledger's booked stake as the vault read it, is the
    /// guard's other half: no path that reads it has removed anything), and on both paths the event's `forfeit` is
    /// false (the dust rule decided, not the flag). The unclaimed rewards are read in a `try` (R2 F1): when the read
    /// fails, the owner's forfeit still removes and logs 0 unclaimed, and every other path refuses as for rewards
    /// above the dust (the owner's HotkeyHasRewards, the others' NotAuthorized). The list is swap-and-popped; the
    /// record of `h` (lastClaimAt) stays.
    function remove(
        bytes32[] storage hotkeys,
        mapping(bytes32 => bool) storage isHotkey,
        bytes32 h,
        bool forfeit,
        bool byOwner,
        bool byKeeperOrGuardian,
        bytes32 coldkey,
        bytes32 stakeHotkey,
        uint256 booked,
        uint256 pending,
        uint256 dustRao
    ) external returns (uint256 receivedWei, uint256 debitRao) {
        if (!isHotkey[h]) revert UnknownHotkey();
        if (h == stakeHotkey) revert HotkeyInUse();

        uint256 leftover = CascadeFormulas.stakeOf(h, coldkey);
        if (leftover != 0) {
            if (!byOwner) revert NotAuthorized();
            if (leftover < CascadeFormulas.minStakeRao()) {
                // A move below the minimum would be refused; the TAO becomes idle balance, under the vault's
                // unstake flag, which it sets around this call for the owner. The whole position; its measurements
                // go back to the vault, which books them as a walk's removals are: the stake that left off the
                // booked stake, floored (M-2: a gift on `h` can make it more than the ledger holds, and the excess
                // arrives as liquid balance, which is priced), the receipt off the ramp.
                (receivedWei, debitRao) = CascadeLedger.removalDebit(h, coldkey, leftover, leftover, true);
            } else {
                _move(h, stakeHotkey, coldkey, leftover);
            }
        }

        // The unclaimed rewards, an optional read (spec §3.1; R2 F1): should the call fail (a revert, or a dispatch
        // failure that burns the gas it is given), nothing is known of them, so every path refuses as it would for
        // rewards above the dust, but the owner's forfeit, which needs no read and logs 0. No gas cap: a working read
        // is never cut short, and a burned one leaves the forfeit a 64th of the gas. A call that succeeds with fewer
        // than 32 bytes still reverts, as Solidity decodes it outside the `catch` (as for the floors' reads).
        uint256 unclaimed;
        bool known;
        try IStaking(ISTAKING_ADDRESS).getUnclaimedRootTaoByHotkey(coldkey, h) returns (uint256 v) {
            (unclaimed, known) = (v, true);
        } catch {}
        bool aboveDust = !known || unclaimed > dustRao * RAO;
        if (byOwner) {
            if (!forfeit && aboveDust) revert HotkeyHasRewards();
        } else {
            // the keeper or the guardian: within the dust allowance; anyone else: nothing unclaimed, the set full and
            // stake missing (the guard read last, and only then, as the vault read it)
            bool refused = byKeeperOrGuardian
                ? aboveDust
                : !known || unclaimed != 0 || hotkeys.length != MAX_HOTKEYS
                    || !_stakeMissing(hotkeys, booked, pending, coldkey);
            if (refused) revert NotAuthorized();
            // the dust rule decided, not the flag: the event's forfeit is the owner's alone
            forfeit = false;
        }

        uint256 last = hotkeys.length - 1;
        for (uint256 i; i <= last; ++i) {
            if (hotkeys[i] == h) {
                hotkeys[i] = hotkeys[last];
                break;
            }
        }
        hotkeys.pop();
        isHotkey[h] = false;
        emit HotkeyRemoved(h, unclaimed, forfeit);
    }

    /// moveStake's body after the vault's schedule check (spec §3.6, §3.10.16): `from` listed (`listed`, the vault's
    /// read of isHotkey; UnknownHotkey) and
    /// not the stake hotkey (HotkeyInUse), and `to`, the destination the guardian reviewed in the calldata, the
    /// stake hotkey at execute (InvalidParameter). Moves what `from` holds now, up to `rao`; nothing on an empty
    /// position.
    function move(bool listed, bytes32 from, bytes32 to, uint256 rao, bytes32 coldkey, bytes32 stakeHotkey) external {
        if (!listed) revert UnknownHotkey();
        if (from == stakeHotkey) revert HotkeyInUse();
        if (to != stakeHotkey) revert InvalidParameter();
        uint256 held = CascadeFormulas.stakeOf(from, coldkey);
        if (rao > held) rao = held;
        if (rao != 0) _move(from, to, coldkey, rao);
    }

    /// Moves `rao` of root stake from `from` onto `to` (root to root, fee-free) and logs StakeMoved with what `to`
    /// gained, measured (its stake after less before, floored). Books nothing: the stake stays the vault's.
    function _move(bytes32 from, bytes32 to, bytes32 coldkey, uint256 rao) private {
        uint256 before = CascadeFormulas.stakeOf(to, coldkey);
        IStaking(ISTAKING_ADDRESS).moveStake(from, to, NETUID_ROOT, NETUID_ROOT, rao);
        emit StakeMoved(from, to, rao, CascadeFormulas.sub0(CascadeFormulas.stakeOf(to, coldkey), before));
    }

    /// Whether stake is missing, as the vault reads it (its stakeMissing()): the visible stake over the listed
    /// hotkeys, read live, against `booked`, the ledger's booked stake, with `pending`, its queued payouts, off the
    /// tolerance's base (CascadeFormulas.stakeMissing, R6 E-fix).
    function _stakeMissing(bytes32[] storage hotkeys, uint256 booked, uint256 pending, bytes32 coldkey)
        private
        view
        returns (bool)
    {
        uint256 visible;
        uint256 n = hotkeys.length;
        for (uint256 i; i < n; ++i) {
            visible += CascadeFormulas.stakeOf(hotkeys[i], coldkey);
        }
        return CascadeFormulas.stakeMissing(visible, booked, pending);
    }
}
