// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

// Every event of CascadeBase, CascadeVault (its share token included) and the vault's libraries,
// each declared once at file level (spec §8.1) and imported by name where it is emitted. A library's
// events come from the vault's address, but an event only a library emits is in that library's ABI,
// not the vault's; abi/CascadeVault.json (script/merge-abi.mjs) merges them. The front door's, the
// adapters' and the staker's own events stay in those contracts.

import {BounceReason, Kind} from "./CascadeTypes.sol";

// ---- CascadeBase ----

event GuardianSet(address indexed guardian);
event BridgeActivated(address indexed bridge);
event BridgeDisabled(address indexed bridge);
event PrimaryBridgeSet(address indexed bridge);
// the scheduler (spec §3.6)
/// `data` is the item's whole calldata, so the monitor decodes every item's arguments (D1); the id is
/// keccak256(data).
event Scheduled(bytes32 indexed id, Kind kind, bytes4 indexed selector, uint64 readyAt, bytes data);
event Executed(bytes32 indexed id);
event Cancelled(bytes32 indexed id, address indexed by);
event Lapsed(bytes32 indexed id);
// the exits machine (spec §3.6)
/// `by` played the instrument `instrument` (its selector), recording a hold or stamping its clock.
event ExitsClosed(address indexed by, bytes4 indexed instrument);
/// `instrument` (its selector) cleared a hold.
event ExitsReopened(bytes4 indexed instrument);
/// A valid owner-signed stamp as of `asOf`, relayed by `relayer`: on every valid call, replays included
/// (spec §3.10.7), whether or not it moved the owner's clock.
event StampedBySig(uint64 asOf, address indexed relayer);

// ---- CascadeShares (the vault's share token) ----

/// ERC-20's event, on every mint (from the zero address) and burn (to the zero address); shares never
/// move between accounts.
event Transfer(address indexed from, address indexed to, uint256 value);

// ---- CascadeVault ----

event StakeHotkeySet(bytes32 indexed hotkey);
event HotkeyAdded(bytes32 indexed hotkey);
/// `unclaimed` is the hotkey's unclaimed root reward at removal, 18-decimal.
event HotkeyRemoved(bytes32 indexed hotkey, uint256 unclaimed, bool forfeit);
/// `moved` is the destination's measured stake increase, in rao.
event StakeMoved(bytes32 indexed from, bytes32 indexed to, uint256 rao, uint256 moved);
/// `measured` is the stake hotkey's measured stake increase, in rao.
event Staked(bytes32 indexed hotkey, uint256 rao, uint256 measured);
/// adoptStake booked `rao` of surplus stake (visible above booked: a gift, or stake back after a write-off), which
/// vests into the price from now (spec §3.1, Task 16).
event StakeAdopted(uint256 rao);
/// The owner's scheduled writeOffMissingStake lowered the booked stake by `rao`, stake that is gone (spec §3.1,
/// M-1); the price, which reads min(visible, booked), does not move.
event StakeWrittenOff(uint256 rao);
/// `wantRao` is what the removal asked of the position, in rao: the whole position on a full removal, the request
/// on a partial one (R2 F2); `receivedWei` is the vault's measured balance increase. When the chain takes exactly
/// what was asked, `wantRao` × 1e9 less `receivedWei` is what it kept (its removal fee). The exit that walked is
/// charged `debit` × 1e9 less what it received, rounded up to rao, `debit` being the position's measured fall
/// (CascadeLedger), and bears it (spec §3.3): a direct exit's leaver (ShortfallAbsorbed) or a payout chunk's entries
/// (PayoutChunkSent's `unstakeCost`), which off-chain readers read directly rather than rebuild from these events.
event Unstaked(bytes32 indexed hotkey, uint256 wantRao, uint256 receivedWei);
/// The unstake walk's removal from `hotkey` failed (a refusal such as a root hold on the pair, or the gas it was given
/// burned), so the walk received nothing from it and went on to the next position (spec §3.8, Task 20). Logged by L2,
/// CascadeStakeLib, from the vault's address.
event UnstakeSkipped(bytes32 indexed hotkey);
/// `deltaRao` is the vault's measured position increase from the claim (stake across the set plus
/// liquid balance), in rao, floored.
event RewardsClaimed(bytes32 indexed hotkey, uint256 deltaRao);
event RewardCutSet(address treasury, uint16 bps);
/// `assets` is the cut, 18-decimal; `shares` its csTAO at the price before the claim.
event RewardCutMinted(address indexed treasury, uint256 assets, uint256 shares);
event FrontDoorActivated(uint64 indexed chain, address indexed addr);
event FrontDoorRemoved(uint64 indexed chain, address indexed addr);
event DepositedDirect(address indexed user, uint256 assets, uint256 shares);
/// `assets` is what the caller was paid: the shares' value, floored to rao, less what a ShortfallAbsorbed logged
/// just before it says the leaver bore, floored to rao again (Task 19; never 0: an exit that would pay nothing
/// reverts ZeroAmount). `acceptedMissing` is true only when the exit was
/// priced while stake was missing, at min(visible, booked), with the caller's consent (its acceptMissing flag; spec
/// §3.1, I-1).
event RedeemedDirect(address indexed user, uint256 shares, uint256 assets, bool acceptedMissing);
/// `amount` is everything a direct exit's leaver bore of its exit's cost, in wei (spec §3.3, the founder's ruling of
/// 2026-11-06): what its walk left untaken of the exit's value beyond the liquidity read once before it (`unmet`, at
/// most SHORTFALL_TOLERANCE_RAO, 1,000 rao; with no walk needed of a part within it, that part), and the walk's
/// cost, what the chain kept of the stake it took, rounded up to rao. The leaver is paid that much less (floored to
/// rao), as the RedeemedDirect after it in the same transaction shows. Logged only when non-zero.
event ShortfallAbsorbed(uint256 amount);
/// `user` set its redeem origin to `chain` (setRedeemOrigin, spec §3.4): a chain with an active front door, or
/// DIRECT_ORIGIN. The only event of an origin change: the other two writes are fully determined by their own events
/// and the state before them (a door's Deposited of non-zero assets sets an origin of 0 to that door's chain, and
/// DepositedDirect sets DIRECT_ORIGIN; an entry below a rao logs Deposited(key, user, 0, 0) and writes none).
event RedeemOriginSet(address indexed user, uint64 chain);
event KeeperSet(address indexed keeper);
event ClaimGasSet(uint256 claimGasRequired);
/// An owner setter's new values, keyed by that setter's selector (spec §8's trim). A setter with three
/// values emits two under its selector, in a fixed order: (first, second), then (third, 0) (ruling DA7).
event LimitSet(bytes4 indexed selector, uint256 a, uint256 b);
/// setOutflowLimits' three values, in one event in place of LimitSet's two (Task 17): each front door's daily
/// percentage of the allowance base, the floor every window shares, and all doors' percentage together.
event OutflowLimitsSet(uint256 bps, uint256 minDaily, uint256 globalBps);
event BatchDelivered(
    bytes32 indexed key, uint64 indexed sourceChain, address indexed frontDoor, uint64 batchId, uint256 amount
);
event DepositSkipped(bytes32 indexed key, address user, uint256 assets);
event Deposited(bytes32 indexed key, address indexed user, uint256 assets, uint256 shares);
/// A deposit delivered while the vault is insolvent (`reason` Insolvent), or for an address whose redeem origin is
/// another chain's (ForeignOrigin, Task 18): no shares are minted, and `assets` is queued back to the front door
/// with the batch's payouts as an entry with 0 shares.
event DepositBounced(bytes32 indexed key, address indexed user, uint256 assets, BounceReason reason);
event RedeemSkipped(bytes32 indexed key, address indexed user, uint256 requested);
event RedeemDeferred(bytes32 indexed key, address indexed user, uint256 requested);
event Redeemed(bytes32 indexed key, address indexed user, uint256 shares, uint256 assets);
/// `price` is the batch price, CascadeMath.price(A, S).
event PayoutBatchQueued(
    bytes32 indexed key, uint64 indexed sourceChain, uint64 batchId, uint32 count, uint256 total, uint256 price
);
/// `gross` is the chunk's queued value; `net + fee` is the value sent (both 0 when nothing was sent). The fee valve
/// (spec §3.3, Task 21): `fee` is what the bridge was paid, the quote rounded up to rao, `charged` plus the caller's
/// top-up; `charged` is what the chunk's entries paid of it, at most the fee ceiling (0 when nothing was sent).
/// `unstakeCost` is the chunk's walk's cost, what the chain kept of the stake it took, whole rao (0 without a walk):
/// the entries bear `charged + unstakeCost` pro rata (each share rounded up, each net floored to rao), so each one's
/// net is rebuilt with that split.
event PayoutChunkSent(
    bytes32 indexed key,
    uint32 chunk,
    uint32 taken,
    uint256 gross,
    uint256 net,
    uint256 fee,
    uint256 charged,
    uint256 unstakeCost
);
/// A bounced deposit (an entry with no shares) left with nothing after its share of the fee; `assets` stays in the
/// vault. An entry with shares is never dust: the chunk reverts FeeTooHigh instead (spec §3.3, I-14, Task 21).
event PayoutDust(bytes32 indexed key, address indexed user, uint256 assets);
/// An unsent redeem undone by the owner's cancel (spec §3.5): `shares` re-minted to `user`, what `assets`, the value
/// it was owed, buys at the price before the cancel, never more than it burned (Task 34c; 0 when that rounds to 0);
/// its reservation released.
event RedeemReversed(bytes32 indexed key, address indexed user, uint256 shares, uint256 assets);
/// A cancel (spec §3.5, Task 22): `reminted` is the value of the unsent entries with shares (each re-minted what its
/// value buys, never more than it burned, Task 34c), their whole reservation released; `bouncesCarried` is how many
/// unsent bounced deposits stay queued as the batch's new list (in their order: the last `bouncesCarried` of its
/// DepositBounced entries, §3.10.15), the batch deleted when it is 0.
event PayoutBatchCancelled(bytes32 indexed key, uint256 reminted, uint32 bouncesCarried);
