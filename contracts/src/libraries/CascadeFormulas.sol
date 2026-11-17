// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ISTAKING_ADDRESS, IStaking} from "../interfaces/IStaking.sol";
import {
    ED_RESERVE,
    FALLBACK_MIN_REMAIN_RAO,
    FALLBACK_MIN_STAKE_RAO,
    MIN_MISSING_TOLERANCE_RAO,
    MISSING_TOLERANCE_BPS,
    NETUID_ROOT,
    RAO,
    UNDERWATER_TOLERANCE
} from "../CascadeConstants.sol";
import {Actor, Window} from "../CascadeTypes.sol";
import {InsufficientGas} from "../CascadeErrors.sol";

/// @notice The vault's derived values, each written once (spec §8.1): the vault and its lens compute
/// the priced stake, gross and total assets, unvested rewards, the missing tolerance, the unlisted stake and
/// the staking floors through these functions from the same raw values, which the lens reads from the vault's
/// storage through `extsload` (and the staking precompile), so only those reads can differ, and the lens
/// parity tests compare them (I-33). The exits machine's holds and `exitsOpen` are here too, for CascadeBase
/// (both targets) and both lenses.
/// @dev Internal functions only: compiled into each user, with no call and no link (ruling DB7c).
library CascadeFormulas {
    /// The gas each capped read of the staking precompile is given (the floors' reads here): a failed read counts as a
    /// fallback, so `requireGasFor` makes sure it is given all of it.
    uint256 internal constant READ_GAS = 100_000;
    /// The gas the vault's write-off read of its coldkey's root total is given (spec §3.1, R6 C): the chain meters
    /// getTotalColdkeyStakeOnSubnet by the coldkey's positions (runtime 490: 1,875 + 1,250 per hotkey in its staking
    /// set + 1,250 per position on any subnet + 12,500 per root position, at 625 gas a database read), and anyone can
    /// add positions under a hotkey already in the vault's set, so READ_GAS's 100,000 could be priced out and the read
    /// counted as 0 at every gas limit. This is the most any coldkey's read can cost today, 256 hotkeys (the chain's
    /// MAX_STAKING_HOTKEYS) each on 128 subnets and root: 1,875 + 256 x (1,250 + 129 x 1,250 + 12,500) = 44,801,875,
    /// rounded up. Given whole (`requireGasFor`), it needs about 45.72M left at the read and about 46.5M of a transaction
    /// (two 63/64 steps, execute's self-call and the read), under Bittensor's 64,998,400 per transaction.
    uint256 internal constant WRITE_OFF_READ_GAS = 45_000_000;
    /// What `requireGasFor` adds for the gas spent between its check and the call: the arguments and the call's own
    /// cost (a cold account's 2,600 included).
    uint256 private constant CAP_GAS_MARGIN = 5_000;

    /// a - b, floored at 0.
    function sub0(uint256 a, uint256 b) internal pure returns (uint256) {
        // a - b only when a > b: it cannot underflow, so no checked subtraction (Task 16's size trim)
        unchecked {
            return a > b ? a - b : 0;
        }
    }

    /// What is left now of `amount`, spent linearly over `period` from `start` (unvested rewards,
    /// ramping stake).
    function unspent(uint256 amount, uint64 start, uint256 period) internal view returns (uint256) {
        uint256 elapsed = block.timestamp - start;
        return elapsed >= period ? 0 : amount * (period - elapsed) / period;
    }

    /// `coldkey`'s root stake on hotkey `h`, in rao, as the staking precompile reports it.
    function stakeOf(bytes32 h, bytes32 coldkey) internal view returns (uint256) {
        return IStaking(ISTAKING_ADDRESS).getStake(h, coldkey, NETUID_ROOT);
    }

    /// A position in wei: `stakeRao` of root stake (in rao) and the liquid balance (in wei), before any
    /// reserve. The vault's whole position, which a claim measures, holds its visible stake; the one it
    /// prices, its priced stake (pricedStakeRao).
    function positionWei(uint256 stakeRao, uint256 balance) internal pure returns (uint256) {
        return stakeRao * RAO + balance;
    }

    /// The root stake the vault prices, in rao (spec §3.1): the smaller of the visible stake (on the listed
    /// hotkeys, read live) and the booked (the ledger: what the vault's own stake-side measurements put
    /// there). A swap that moves stake off the set lowers it at once; a gift on a listed hotkey does not raise
    /// it until it is adopted or unstaked into balance (I-3).
    function pricedStakeRao(uint256 visibleRao, uint256 bookedRao) internal pure returns (uint256) {
        return Math.min(visibleRao, bookedRao);
    }

    /// The coldkey's root stake that is not on the listed hotkeys, in rao (spec §3.1): `totalRao`, its whole root
    /// stake as the staking precompile totals it, less the visible, floored at 0. Pure: the vault and the lens
    /// each make the precompile read themselves, so L2, which compiles this file in, makes no call it does not
    /// need (and Task 16's write-off can make its read inside a `try`).
    function unlistedStakeRao(uint256 totalRao, uint256 visibleRao) internal pure returns (uint256) {
        return sub0(totalRao, visibleRao);
    }

    /// Whether stake is missing (spec §3.1): the booked stake above the visible by more than the larger of
    /// MISSING_TOLERANCE_BPS of the booked stake less the queued payouts (`pendingWei`, in rao, floored at 0) and
    /// MIN_MISSING_TOLERANCE_RAO (rao, as the stake arguments are). The bps part's base is the stake that still backs
    /// shares (R6 E-fix): a door redeem's payout stays staked until it is sent, so with a large queue 0.1% of the booked
    /// stake could be most of what backs the shares, and a gap that size would read as nothing missing while mints run at
    /// a price cut far more than 0.1%. All of the queue is taken off, though part of it may be liquid (a bounce): that
    /// only tightens the tolerance, and reads no balance a delivery's own value could raise.
    function stakeMissing(uint256 visibleRao, uint256 bookedRao, uint256 pendingWei) internal pure returns (bool) {
        return sub0(bookedRao, visibleRao)
            > Math.max(sub0(bookedRao, pendingWei / RAO) * MISSING_TOLERANCE_BPS / 10_000, MIN_MISSING_TOLERANCE_RAO);
    }

    /// The position less the existential reserve, floored at 0.
    function grossAssets(uint256 position) internal pure returns (uint256) {
        return sub0(position, ED_RESERVE);
    }

    /// What is still vesting of one drip, the claim schedule or the adoption drip (Revision 27): `vestingAmount` spread
    /// over `vestingPeriod` from `vestingStart` (the period the drip snapshotted when it last restarted; 0 before any:
    /// nothing vests). The vault's unvestedRewards() is the two drips' sum, and so is the lens's.
    function unvestedRewards(uint256 vestingAmount, uint64 vestingStart, uint64 vestingPeriod)
        internal
        view
        returns (uint256)
    {
        return unspent(vestingAmount, vestingStart, vestingPeriod);
    }

    /// Gross assets less the queued payouts and the unvested rewards, floored at 0: what the shares
    /// are worth.
    function totalAssets(uint256 gross, uint256 pendingPayouts, uint256 unvested) internal pure returns (uint256) {
        return sub0(gross, pendingPayouts + unvested);
    }

    /// Whether the vault is underwater, so every mint refuses (spec §3.1): totalAssets() floors the shortfall at
    /// 0, so at a supply of 0 the half-launch line cannot see it, and each mint checks this on the gross before
    /// its own money. While any reward still vests, any shortfall of the gross against the queued payouts and
    /// the unvested rewards counts: a shortfall in the schedule closes as the schedule vests (within its period
    /// with no new claim; a claim adds as much to the gross as to the schedule), so it never refuses deposits for
    /// good, and at a supply of 0 a deposit writes it down first (the vault's _unvestedForMint, Task 15). With
    /// nothing vesting, only a shortfall against the queued payouts of more than UNDERWATER_TOLERANCE counts: one
    /// within it is a rounding of the chain's at a supply of 0 (no exit leaves one, spec §3.3), which the next minter
    /// absorbs (I-4's exception) and which nothing would ever close. That is, `pendingPayouts + unvested > gross &&
    /// (unvested != 0 || pendingPayouts > gross + UNDERWATER_TOLERANCE)`, written with no sum, so it cannot overflow.
    function underwater(uint256 gross, uint256 pendingPayouts, uint256 unvested) internal pure returns (bool) {
        if (unvested != 0) return unvested > sub0(gross, pendingPayouts);
        return sub0(pendingPayouts, gross) > UNDERWATER_TOLERANCE;
    }

    /// InsufficientGas unless enough gas is left for a call capped at `cap`, made next, to be given all of it
    /// (Revision 28's gas audit). EIP-150 forwards at most all but a 64th of the gas left after a call's own cost, so
    /// with less than cap * 64 / 63 a capped call is given less than its cap, and a read whose failure is counted (as
    /// 0, or as a fallback) could be starved by the caller's gas limit into the answer a failure gives, if the
    /// callee's failure left the caller the gas to go on (a precompile that refuses with a revert returns what it was
    /// not charged): a wallet's estimate could pick such a limit by itself, as Bittensor's estimator bisects to the
    /// least gas that succeeds. With the check, a read that fails has failed with its whole cap.
    function requireGasFor(uint256 cap) internal view {
        if (gasleft() < cap * 64 / 63 + CAP_GAS_MARGIN) revert InsufficientGas();
    }

    /// The chain's minimum stake operation, in rao: the larger of the live read and FALLBACK_MIN_STAKE_RAO, or
    /// FALLBACK_MIN_STAKE_RAO alone if the read fails (a constant since Task 23). The read is capped at READ_GAS and
    /// given all of it (`requireGasFor`), so no caller's gas limit can starve it into the fallback, which is lower
    /// whenever the chain's minimum is above it.
    function minStakeRao() internal view returns (uint256) {
        requireGasFor(READ_GAS);
        try IStaking(ISTAKING_ADDRESS).getDefaultMinStake{gas: READ_GAS}() returns (uint256 v) {
            return Math.max(v, FALLBACK_MIN_STAKE_RAO);
        } catch {
            return FALLBACK_MIN_STAKE_RAO;
        }
    }

    /// The chain's minimum nominator position, in rao: the larger of the live read and FALLBACK_MIN_REMAIN_RAO,
    /// or FALLBACK_MIN_REMAIN_RAO alone if the read fails (a constant since Task 23). Read as minStakeRao is, given
    /// all of READ_GAS.
    function minRemainRao() internal view returns (uint256) {
        requireGasFor(READ_GAS);
        try IStaking(ISTAKING_ADDRESS).getNominatorMinRequiredStake{gas: READ_GAS}() returns (uint256 v) {
            return Math.max(v, FALLBACK_MIN_REMAIN_RAO);
        } catch {
            return FALLBACK_MIN_REMAIN_RAO;
        }
    }

    /// Burn window `w` as of now (spec §3.4, I-15): a fresh one (opening now, nothing burned) once 24 hours have
    /// passed since it opened. L1 burns against it and writes it back only when it burns; the vault lens serves it,
    /// so a window past its day reads as L1 would start it (R2 F4).
    function currentWindow(Window memory w) internal view returns (Window memory) {
        // forge-lint: disable-next-line(block-timestamp)
        return block.timestamp >= w.start + 24 hours ? Window(uint64(block.timestamp), 0) : w;
    }

    /// Whether `by` holds the exits closed (spec §3.6): whether any recorded hold names it, the primary
    /// bridge's disable, the vault's pause or its launch door's removal. The front door records only the
    /// first ("the vault's machine without doors") and passes Actor.None for the other two. None is no actor:
    /// it holds nothing, so a record of None never reads as a hold.
    function holds(Actor by, Actor primaryDisabledBy, Actor pausedBy, Actor launchDoorRemovedBy)
        internal
        pure
        returns (bool)
    {
        return by != Actor.None && (primaryDisabledBy == by || pausedBy == by || launchDoorRemovedBy == by);
    }

    /// Exits are open when neither actor holds them closed (spec §3.6's OPEN state).
    function exitsOpen(bool ownerHold, bool guardianHold) internal pure returns (bool) {
        return !ownerHold && !guardianHold;
    }

    /// The EIP-712 domain separator of the owner-signed stamp (spec §3.6) for `verifyingContract` on this
    /// chain: name "Cascade", version "3.2". CascadeBase hashes it once, in its constructor; each lens
    /// recomputes it for its target.
    function domainSeparator(address verifyingContract) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Cascade"),
                keccak256("3.2"),
                block.chainid,
                verifyingContract
            )
        );
    }

    /// A front door's id: its chain and address.
    function peerId(uint64 chain, address addr) internal pure returns (bytes32) {
        return keccak256(abi.encode(chain, addr));
    }

    /// A delivered batch's key, its replay record and payout-queue key: the source chain, the sending
    /// front door and the message's hash.
    function batchKey(uint64 sourceChain, address sender, bytes calldata message) internal pure returns (bytes32) {
        return keccak256(abi.encode(sourceChain, sender, keccak256(message)));
    }
}
