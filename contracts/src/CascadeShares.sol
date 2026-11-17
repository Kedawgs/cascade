// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Holder, SharesData} from "./CascadeTypes.sol";
import {STAKE_RAMP} from "./CascadeConstants.sol";
import {ERC20InsufficientBalance, NonTransferable} from "./CascadeErrors.sol";
import {Transfer} from "./CascadeEvents.sol";

// csTAO, the vault's share token (spec §8.1): a minimal, non-transferable ERC-20 surface in place of
// OpenZeppelin's ERC20, an audited component, so the auditor reviews these lines instead. Shares only
// ever appear by a mint and leave by a burn, each with ERC-20's Transfer event from or to the zero
// address. Unlike OpenZeppelin's _mint and _burn, the helpers do not refuse the zero address: the vault
// never mints to it or burns from it (a delivery skips a zero user, a cancel re-mints only the users
// its batch's payout hash fixed at delivery, a direct deposit or redeem is the caller's, and the
// treasury is non-zero whenever the reward cut is).

/// Mints `amount` shares to `to`. The vault, and from Tasks 5e and 5g its batch and payout libraries,
/// mint through this one helper, so every mint emits Transfer(0, to, amount).
function mintShares(SharesData storage s, address to, uint256 amount) {
    s.totalSupply += amount;
    // cannot overflow: a balance is at most the total supply, which the line above checked
    unchecked {
        s.balanceOf[to] += amount;
    }
    emit Transfer(address(0), to, amount);
}

/// Burns `amount` of `from`'s shares; reverts ERC20InsufficientBalance (OpenZeppelin's error, as v3.1's
/// _burn did) when `from` holds fewer.
function burnShares(SharesData storage s, address from, uint256 amount) {
    uint256 balance = s.balanceOf[from];
    if (balance < amount) revert ERC20InsufficientBalance(from, balance, amount);
    // cannot underflow: amount <= balance <= totalSupply
    unchecked {
        s.balanceOf[from] = balance - amount;
        s.totalSupply -= amount;
    }
    emit Transfer(from, address(0), amount);
}

/// The fresh shares of holder record `h` (spec §3.5, R4 B-H1, the door hold): its `fresh` while `h.since + STAKE_RAMP`
/// is ahead, 0 after. A front door burns at most a holder's balance less these, and redeemDirect lowers the bucket to
/// the balance it leaves (R6 A), so they never exceed the balance.
function freshOf(Holder memory h) view returns (uint256) {
    // a validator's seconds of timestamp skew are nothing against a day
    // forge-lint: disable-next-line(block-timestamp)
    return block.timestamp < uint256(h.since) + STAKE_RAMP ? h.fresh : 0;
}

/// Adds `minted` shares to `user`'s fresh shares in `holders` (spec §3.5, R4 B-H1): while they are still held the new
/// ones join them and the clock moves to the share-weighted mean of theirs and now, rounded up (S-L3: a mint moves it by
/// its share alone, so a stranger's gift cannot keep a holder's own fresh shares held much past a day); once they are
/// not, the run restarts at now with the new ones alone. The count saturates at 2^128 - 1, above every share supply, so
/// a saturated record still holds the whole balance. A mint of nothing writes nothing; the origin is left as it is.
/// Called after each mint of a front door's deposit (the batch library's credit) and of depositDirect, never after a
/// cancel's re-mint (shares handed back, no new capital) or the reward cut.
function addFresh(mapping(address => Holder) storage holders, address user, uint256 minted) {
    if (minted == 0) return;
    Holder storage h = holders[user];
    uint256 still = freshOf(h);
    // still != 0 only while h.since + STAKE_RAMP is ahead, so h.since <= now and the mean is at most now
    uint256 since = still == 0
        ? block.timestamp
        : h.since + Math.mulDiv(block.timestamp - h.since, minted, still + minted, Math.Rounding.Ceil);
    uint256 fresh = Math.min(still + minted, type(uint128).max);
    // casting to 'uint64' is safe because `since` is at most now, and to 'uint128' because `fresh` is capped above
    // forge-lint: disable-next-line(unsafe-typecast)
    h.since = uint64(since);
    // forge-lint: disable-next-line(unsafe-typecast)
    h.fresh = uint128(fresh);
}

/// The ERC-20 surface wallets and explorers read: name, symbol, 24 decimals, balances and the supply.
/// transfer, transferFrom and approve revert and allowance is always 0, which wallets handle better
/// than unknown selectors. First in the vault's inheritance, so `_shares` takes its first slots.
abstract contract CascadeShares {
    SharesData internal _shares;

    function name() external pure returns (string memory) {
        return "Cascade Staked TAO";
    }

    function symbol() external pure returns (string memory) {
        return "csTAO";
    }

    function decimals() external pure returns (uint8) {
        return 24;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _shares.balanceOf[account];
    }

    function totalSupply() external view returns (uint256) {
        return _shares.totalSupply;
    }

    function allowance(address, address) external pure returns (uint256) {
        return 0;
    }

    function transfer(address, uint256) external pure returns (bool) {
        revert NonTransferable();
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        revert NonTransferable();
    }

    function approve(address, uint256) external pure returns (bool) {
        revert NonTransferable();
    }
}
