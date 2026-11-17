// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BatchIn, BounceReason, Holder, PayoutBatch, SharesData, Window} from "../CascadeTypes.sol";
import {addFresh, burnShares, freshOf, mintShares} from "../CascadeShares.sol";
import {DIRECT_ORIGIN, GLOBAL_WINDOW, MIN_REDEEM_VALUE, RAO} from "../CascadeConstants.sol";
import {AmountMismatch} from "../CascadeErrors.sol";
import {
    BatchDelivered,
    DepositBounced,
    DepositSkipped,
    Deposited,
    RedeemDeferred,
    RedeemSkipped,
    Redeemed
} from "../CascadeEvents.sol";
import {CascadeFormulas} from "./CascadeFormulas.sol";
import {CascadeMath} from "./CascadeMath.sol";
import {CascadeMessages} from "./CascadeMessages.sol";
import {CascadePayoutMath} from "./CascadePayoutMath.sol";

/// @notice L1, the vault's batch path (spec §8.1): the body of `onBridgeMessage` after the vault's
/// checks. It decodes the BATCH and sums its deposits, mints each deposit (or bounces it: while the vault
/// reads `insolvent`, below half the launch price or underwater, and for an address whose redeem origin
/// is another chain's), burns each redeem of a holder of the door's chain within the front door's daily
/// window and the global one all doors share, and returns the payout queue for the vault to store.
/// @dev A linked external library, run only by the vault's DELEGATECALL, in the vault's context: its
/// events come from the vault's address, and the compiler's call guard reverts a direct call. It holds
/// no state, makes no external call (no precompile, no bridge: the vault reads the stake and the price
/// inputs first and passes them in `input`), and writes only through its storage pointers: the share
/// balances and supply, the burn windows (each front door's and, at GLOBAL_WINDOW, all doors', Task 17),
/// and the holders' records (Holder): their redeem origins (origin by chain, spec §3.4, Task 18: a door's first mint
/// for an address of origin 0 sets it to the door's chain, `input.sourceChain`; nothing here changes a non-zero
/// origin) and their fresh shares (spec §3.5, R4 B-H1, the door hold: each mint adds to its holder's, and no redeem
/// burns them).
library CascadeBatchLib {
    /// Delivers the BATCH `message` whose key the vault has recorded: AmountMismatch unless its deposits
    /// sum to `input.amount`; then BatchDelivered, each deposit in order, each redeem in order. Every entry
    /// is priced at (input.A, input.S). Returns the queue, bounced deposits first and then redeems, with
    /// its source chain, front door and batch id; the vault sets `queuedAt` and stores it when
    /// `remaining` is not 0.
    function deliver(
        SharesData storage shares,
        mapping(bytes32 => Window) storage windows,
        mapping(address => Holder) storage holders,
        BatchIn memory input,
        bytes calldata message
    ) external returns (PayoutBatch memory queued) {
        (uint64 batchId, CascadeMessages.Entry[] memory deposits, CascadeMessages.Entry[] memory redeems) =
            CascadeMessages.decodeBatch(message);
        {
            uint256 sum = 0;
            for (uint256 i; i < deposits.length; ++i) {
                sum += deposits[i].amount;
            }
            if (sum != input.amount) revert AmountMismatch();
        }
        emit BatchDelivered(input.key, input.sourceChain, input.sender, batchId, input.amount);

        // one queue for both steps: bounced deposits first, then redeems
        _creditDeposits(shares, holders, input, deposits, queued);
        _burnRedeems(shares, windows, holders, input, redeems, queued);
        queued.sourceChain = input.sourceChain;
        queued.frontDoor = input.sender;
        queued.batchId = batchId;
    }

    /// Delivery step 1: mints each deposit, floored to rao, at (A, S). A zero user is skipped and its
    /// TAO stays in the vault. A non-zero deposit is bounced instead (queued in `b` as (user, 0 shares,
    /// assets), to be paid back to the front door like a redeem) while `insolvent` (Insolvent), and for a
    /// user whose redeem origin is another chain's (ForeignOrigin; spec §3.4, I-16: a door never mints for
    /// another chain's holder, so the shares never go to whoever controls the address on the door's
    /// chain). Otherwise it mints: a user of origin 0 takes the door's chain, and one of the door's chain or
    /// DIRECT_ORIGIN keeps its origin (an address that deposited directly already belongs here), and the shares join
    /// the user's fresh shares (spec §3.5, R4 B-H1: addFresh). A bounce, and a deposit of nothing, write no origin and
    /// no fresh shares.
    function _creditDeposits(
        SharesData storage shares,
        mapping(address => Holder) storage holders,
        BatchIn memory input,
        CascadeMessages.Entry[] memory deposits,
        PayoutBatch memory b
    ) private {
        uint64 chain = input.sourceChain;
        for (uint256 i; i < deposits.length; ++i) {
            address user = deposits[i].user;
            uint256 a = deposits[i].amount;
            a -= a % RAO;
            if (user == address(0)) {
                emit DepositSkipped(input.key, user, a);
                continue;
            }
            if (a != 0) {
                if (input.insolvent) {
                    _bounce(b, input.key, user, a, BounceReason.Insolvent);
                    continue;
                }
                uint64 o = holders[user].origin;
                if (o == 0) {
                    holders[user].origin = chain;
                } else if (o != chain && o != DIRECT_ORIGIN) {
                    _bounce(b, input.key, user, a, BounceReason.ForeignOrigin);
                    continue;
                }
            }
            uint256 minted = CascadeMath.sharesForDeposit(a, input.A, input.S);
            mintShares(shares, user, minted);
            // fresh for a day (spec §3.5, R4 B-H1): this delivery's redeems, and every door's for a day, burn around them
            addFresh(holders, user, minted);
            emit Deposited(input.key, user, a, minted);
        }
    }

    /// Queues deposit `assets` of `user` back to the front door in `b`, with 0 shares, and logs its
    /// DepositBounced with `reason`.
    function _bounce(PayoutBatch memory b, bytes32 key, address user, uint256 assets, BounceReason reason) private {
        _queuePayout(b, user, 0, assets);
        emit DepositBounced(key, user, assets, reason);
    }

    /// Delivery steps 2-3: burns each redeem at (A, S), clipped to the holder's balance, the per-entry
    /// bound and the smaller of two remaining daily allowances (spec §3.4, Task 17): the front door's own,
    /// max(maxDailyOutflowBps of the base, minDailyOutflow) in its window, and all doors' together,
    /// max(globalOutflowBps of the base, minDailyOutflow) in the global window (GLOBAL_WINDOW), the floor
    /// shared. Each window lasts 24 hours from the first burn after the last one ended, and each burn counts
    /// in both. Queues each burn in `b` after any bounced deposits. A redeem of a holder with no shares, or
    /// whose redeem origin is not the door's chain (0, another chain's or DIRECT_ORIGIN; spec §3.4, I-16,
    /// I-17), is skipped (RedeemSkipped): nothing burned, nothing queued. The door hold (spec §3.5, I-36, R4 B-H1): a
    /// redeem is clipped to the holder's balance less its fresh shares (freshOf: what a door's deposit or a direct
    /// deposit minted for it in its run of mints, each made while the run was still held, until STAKE_RAMP after the
    /// run's clock, the share-weighted mean of its mints' times rounded up (S-L3, addFresh); this delivery's deposits,
    /// credited first, among them), so a deposit and a redeem in one batch burn
    /// nothing and no share younger than a day takes the first-come allowance. A redeem worth less than
    /// MIN_REDEEM_VALUE after clipping, a held one included, is deferred (RedeemDeferred), not burned. A clip to the
    /// entry limit or the allowance that would leave the holder more than 0 and less than MIN_REDEEM_VALUE burns that
    /// much less (S-L1, R4). While the primary bridge cannot send payouts (`input.payoutsOpen` false: S-H1, R4; or the
    /// vault has it disabled, R6 D) the allowance reads 0, so every door redeem is deferred. Only burns count against the
    /// windows.
    /// Reads nothing when there are no redeems.
    function _burnRedeems(
        SharesData storage shares,
        mapping(bytes32 => Window) storage windows,
        mapping(address => Holder) storage holders,
        BatchIn memory input,
        CascadeMessages.Entry[] memory redeems,
        PayoutBatch memory b
    ) private {
        if (redeems.length == 0) return;
        Window memory door = CascadeFormulas.currentWindow(windows[input.peer]);
        Window memory allDoors = CascadeFormulas.currentWindow(windows[GLOBAL_WINDOW]);
        // The base (the vault's: the root stake that has ramped in, read once before the call) cannot be
        // raised by capital borrowed for a transaction, parked for less than a day, or gifted as stake.
        // Every burn below comes off both windows' rests alike, so the smaller stays the smaller.
        // While the primary bridge cannot send payouts (S-H1, R4: ForeverMoney's migration notice or pause; R6 D: the
        // vault has it disabled), the allowance reads 0, so every door redeem is deferred, as after a spent allowance, instead of burned into a
        // queue that could not be paid.
        uint256 allowance = input.payoutsOpen
            ? Math.min(
                _rest(door, input.base, input.maxDailyOutflowBps, input.minDailyOutflow),
                _rest(allDoors, input.base, input.globalOutflowBps, input.minDailyOutflow)
            )
            : 0;
        uint256 maxEntry = input.maxEntryValue;
        uint64 chain = input.sourceChain;
        // this delivery's burns, without its bounced deposits
        uint256 burned;
        for (uint256 i; i < redeems.length; ++i) {
            address user = redeems[i].user;
            uint256 balance = shares.balanceOf[user];
            uint256 s = Math.min(redeems[i].amount, balance);
            Holder memory h = holders[user];
            if (s == 0 || h.origin != chain) {
                emit RedeemSkipped(input.key, user, redeems[i].amount);
                continue;
            }
            // the door hold: only shares held a day
            s = Math.min(s, CascadeFormulas.sub0(balance, freshOf(h)));
            // the entry limit and the day's allowance; a clip leaves the holder 0 or at least MIN_REDEEM_VALUE, never
            // shares no door burns (S-L1, R4): `keep`, the least shares worth MIN_REDEEM_VALUE at this price
            uint256 cap = CascadeMath.sharesForDeposit(Math.min(maxEntry, allowance), input.A, input.S);
            if (s > cap) {
                uint256 keep = Math.mulDiv(
                    MIN_REDEEM_VALUE,
                    input.S + CascadeMath.VIRTUAL_SHARES,
                    input.A + CascadeMath.VIRTUAL_ASSETS,
                    Math.Rounding.Ceil
                );
                s = balance - cap < keep ? CascadeFormulas.sub0(balance, keep) : cap;
            }
            uint256 out = CascadeMath.assetsForRedeem(s, input.A, input.S);
            out -= out % RAO;
            if (out < MIN_REDEEM_VALUE) {
                // nothing burned; the holder keeps the shares and may request again (redeemDirect pays
                // any amount)
                emit RedeemDeferred(input.key, user, redeems[i].amount);
                continue;
            }
            burnShares(shares, user, s);
            // out <= min(maxEntry, allowance), since s <= cap = sharesForDeposit(that, A, S)
            allowance -= out;
            burned += out;
            _queuePayout(b, user, s, out);
            emit Redeemed(input.key, user, s, out);
        }
        if (burned != 0) {
            door.burned += burned;
            allDoors.burned += burned;
            windows[input.peer] = door;
            windows[GLOBAL_WINDOW] = allDoors;
        }
    }

    /// What window `w` may still burn: `bps` of the base, at least `floor`, less what it burned (0 when it burned
    /// that much or more, as after a fall in the base).
    function _rest(Window memory w, uint256 base, uint256 bps, uint256 floor) private pure returns (uint256) {
        return CascadeFormulas.sub0(Math.max(base * bps / 10_000, floor), w.burned);
    }

    /// Appends (user, shares, assets) to the payout queue `b`: its count, total (as `remaining`) and
    /// running hash.
    function _queuePayout(PayoutBatch memory b, address user, uint256 shares, uint256 assets) private pure {
        ++b.count;
        b.remaining += assets;
        b.payoutsHash = CascadePayoutMath.hashStep(b.payoutsHash, user, shares, assets);
    }
}
