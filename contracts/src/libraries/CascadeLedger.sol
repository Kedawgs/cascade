// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ISTAKING_ADDRESS, IStaking} from "../interfaces/IStaking.sol";
import {NETUID_ROOT} from "../CascadeConstants.sol";
import {Ledger} from "../CascadeTypes.sol";
import {Unstaked} from "../CascadeEvents.sol";
import {CascadeFormulas} from "./CascadeFormulas.sol";

/// @notice The ledger's shared helpers (spec §8.1), each written once: the measured debit of one stake removal,
/// shared by L2's walk (CascadeStakeLib, which makes its removals itself, each in a `try` since Task 20) and the
/// owner's direct removal in removeHotkey (L4, CascadeHotkeyLib, removalDebit, whose refusal reverts), and the
/// post-walk ledger update, shared by the vault's unstake (redeemDirect and processPayouts, whose walk the vault
/// runs between the payout engine's two halves) and that direct removal.
/// @dev Internal functions only: compiled into each user, with no call and no link of their own (ruling
/// DB7c).
library CascadeLedger {
    /// One stake removal: `want` rao off hotkey `h` (its whole root position when `full`) through the
    /// staking precompile, `staked` being `coldkey`'s position on `h` as read just before. Returns its two
    /// measurements (removalMeasured). The chain's refusal reverts, bubbled up: the owner's direct removal in
    /// removeHotkey (L4), which must not delist a hotkey whose removal was refused (spec §8.1). The walk (L2) makes
    /// its removals itself, each in a `try` with a capped gas, and measures them here too. The vault sets its
    /// transient `_unstaking` around it and the caller books both (applyWalk).
    function removalDebit(bytes32 h, bytes32 coldkey, uint256 staked, uint256 want, bool full)
        internal
        returns (uint256 receivedWei, uint256 debitRao)
    {
        uint256 before = address(this).balance;
        if (full) IStaking(ISTAKING_ADDRESS).removeStakeFull(h, NETUID_ROOT);
        else IStaking(ISTAKING_ADDRESS).removeStake(h, want, NETUID_ROOT);
        return removalMeasured(h, coldkey, staked, want, before);
    }

    /// The two measurements of a removal of `want` rao off hotkey `h` that went through, `staked` being `coldkey`'s
    /// position on `h` and `before` the balance, both read just before it: what the balance received, in wei, and its
    /// ledger debit, the stake that left the position (`staked` less the position after, floored), in rao (spec §3.1:
    /// the ledger moves only on stake-side measurements). Logs Unstaked with `want`: the caller passes the whole
    /// position for a full removal (R2 F2), the request for a partial one.
    function removalMeasured(bytes32 h, bytes32 coldkey, uint256 staked, uint256 want, uint256 before)
        internal
        returns (uint256 receivedWei, uint256 debitRao)
    {
        receivedWei = CascadeFormulas.sub0(address(this).balance, before);
        debitRao = CascadeFormulas.sub0(staked, CascadeFormulas.stakeOf(h, coldkey));
        emit Unstaked(h, want, receivedWei);
    }

    /// The ledger after an unstake whose removals took `debitRao` off their positions and paid `receivedWei`
    /// into the balance: the stake off the booked stake (spec §3.1, M-2), the receipt off the ramping stake
    /// (v3.1's ramp debit, spec §3.10.12), each floored at 0 (I-2: no exit reverts for a ledger reason), so an
    /// unstake leaves the outflow allowance's base where it was and cycled stake nets to nothing. Booking a
    /// walk's totals once is booking each removal in turn: a floored subtraction composes,
    /// sub0(sub0(x, a), b) == sub0(x, a + b).
    function applyWalk(Ledger storage ledger, uint256 receivedWei, uint256 debitRao) internal {
        ledger.booked = CascadeFormulas.sub0(ledger.booked, debitRao);
        ledger.ramping = CascadeFormulas.sub0(ledger.ramping, receivedWei);
    }
}
