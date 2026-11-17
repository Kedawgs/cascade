// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ICascadeBridge} from "./interfaces/ICascadeBridge.sol";

// The structs the vault, its libraries and its lens share, each declared once at file level
// (spec §8.1): the lens reads them out of the vault's storage, and a library takes storage pointers
// to exactly the ones it writes. Shared enums live here too.

// ---- the share token ----

/// csTAO's storage (CascadeShares.sol): the vault inherits the token first, so this struct takes its
/// first two slots (totalSupply at 0, balanceOf at 1). The vault, and from Tasks 5e and 5g its batch
/// and payout libraries, mint and burn through mintShares and burnShares with a pointer to it.
struct SharesData {
    uint256 totalSupply;
    mapping(address => uint256) balanceOf;
}

/// A holder's record, one slot per holder in the vault's `holders` (spec §3.4, §3.5): its redeem origin (`origin`,
/// Task 18: 0, the chain whose front doors may burn its shares, or DIRECT_ORIGIN), and its fresh shares (R4 B-H1, the
/// door hold): what a front door's deposit or a direct deposit minted for it in its last run of mints (`fresh`,
/// saturating at 2^128 - 1, above every share supply) and the run's clock (`since`, the share-weighted mean of its
/// mints' times). No front door burns the fresh shares while `since + STAKE_RAMP` is ahead (CascadeShares.sol's
/// freshOf); a cancel's re-mint and the reward cut never add to them. In the origin's slot, so a door's first mint
/// for an address writes one new slot, not two (the delivery's gas model counts every new depositor's).
struct Holder {
    uint64 origin;
    uint64 since;
    uint128 fresh;
}

// ---- the owner scheduler (CascadeBase, spec §3.6) ----

/// An item's class: the delay it waits between `schedule` and `execute` (CascadeConstants.sol's
/// PARAM_DELAY 48 hours, REGISTRY_DELAY 7 days, GUARDIAN_DELAY 8 days).
enum Delay {
    Param,
    Registry,
    Guardian
}

/// An item's kind, which decides who may cancel it (I-24): the guardian cancels an Ordinary item, only
/// the owner a GuardianSwap (`setGuardian`) or a Reopen (the activation of a bridge active before).
enum Kind {
    Ordinary,
    GuardianSwap,
    Reopen
}

/// Who played an instrument (spec §3.6's exits machine): the actor a hold records and whose clock an
/// instrument stamps. None is no hold.
enum Actor {
    None,
    Owner,
    Guardian
}

/// A front door's state on the vault, by peer id (spec §3.6): Unknown (never active, or removed by the
/// guardian, so its activation is Ordinary and guardian-cancellable), Active (it may deliver and be paid), or
/// Removed (removed by the owner after being active, so its re-activation is a Reopen).
enum DoorState {
    Unknown,
    Active,
    Removed
}

/// A scheduled owner change, under id = keccak256(its calldata): when it was scheduled, when it may
/// execute (until it lapses: readyAt + EXECUTE_WINDOW passed, and readyBlock plus half EXECUTE_WINDOW in blocks,
/// Revision 28), its class, its kind, its selector, and the first block it may execute in (readyBlock: half its
/// delay in blocks too, R1-A L-3, so a halted chain cannot consume the veto).
/// One slot (8 + 8 + 1 + 1 + 4 + 8 bytes); readyAt == 0 means nothing is scheduled under the id.
struct Item {
    uint64 scheduledAt;
    uint64 readyAt;
    Delay class;
    Kind kind;
    bytes4 selector;
    uint64 readyBlock;
}

// ---- batch delivery and the payout queue ----

/// A delivered batch's payouts, queued under its key. The entries are not stored: the keeper
/// resubmits them from the DepositBounced and Redeemed events and the vault checks them against
/// payoutsHash.
struct PayoutBatch {
    uint64 sourceChain;
    address frontDoor;
    uint64 batchId;
    uint64 queuedAt;
    uint32 cursor;
    uint32 count;
    uint32 chunk;
    uint256 remaining;
    bytes32 payoutsHash;
}

/// Why a front door's deposit bounced (DepositBounced; spec §3.1, §3.4): the vault read insolvent (below half the
/// launch price, or underwater), or the address's redeem origin is another chain's (ForeignOrigin, Task 18).
enum BounceReason {
    Insolvent,
    ForeignOrigin
}

/// A front door's 24-hour burn window: when it started and the value burned in it.
struct Window {
    uint64 start;
    uint256 burned;
}

// ---- the ledger and the unstake walk ----

/// The vault's ledger, one struct so that a library takes one narrow pointer to it (spec §8.1; L3's
/// `finish` and `cancel` since Task 5g). `pending`: the wei reserved for queued payouts (v3.1's
/// pendingPayouts). `booked`: the stake the vault accounts for, in rao (the spec's bookedStakeRao; v3.1's
/// bookedStake, in wei; Task 12), moved only by stake-side measurements and floored at 0. `ramping`: the
/// wei still entering the outflow allowance's base (v3.1's rampingStake).
/// v3.1's _unstaking is not here: it is the vault's transient `_unstaking`, set and cleared within one
/// transaction, so it costs no storage slot; no library sets it.
struct Ledger {
    uint256 pending;
    uint256 booked;
    uint256 ramping;
}

/// What the vault hands L2 (CascadeStakeLib.unstake) for one walk, built once for both its callers
/// (rulings DA1 and DB13): a memory copy of the hotkey set (at most MAX_HOTKEYS entries), the stake
/// hotkey walked first, the vault's coldkey, the margin added to each request (rao), the shortfall tolerance
/// (`shortfallToleranceWei`, in wei: the vault's SHORTFALL_TOLERANCE_RAO × RAO, Task 19), within which the walk
/// stops (spec §3.10.11), and the owner's `unstakeGas`, the least gas each removal is forwarded (spec §3.8, Task
/// 20). Only what L2 cannot read itself: the staking floors it reads at walk time (CascadeFormulas, the live reads
/// against the constant fallbacks, which Task 23 dropped from here). Memory only: never stored (gen-lens-layout's
/// MEMORY_ONLY).
struct WalkParams {
    bytes32[] hotkeys;
    bytes32 first;
    bytes32 coldkey;
    uint256 margin;
    uint256 shortfallToleranceWei;
    uint256 unstakeGas;
}

/// Everything the vault decided or read before it hands a delivery to L1 (CascadeBatchLib.deliver):
/// the batch's key, its front door (`peer`, the peerId; `sourceChain` and `sender`, for the events and
/// the queue), the value it carried, the price inputs read once (A, S and whether A is below half the
/// launch price), the outflow allowance's base read once, and the limits L1 applies: the per-entry bound,
/// each door's and all doors' daily percentages of the base, and the floor both windows share (Task 17); and whether
/// the vault's primary bridge can send payouts now (`payoutsOpen`: false while the vault has it disabled, R6 D, else
/// its own canSendPayouts, R4 S-H1; while false no door redeem burns). Memory only: never stored (gen-lens-layout's
/// MEMORY_ONLY).
struct BatchIn {
    bytes32 key;
    bytes32 peer;
    uint64 sourceChain;
    address sender;
    uint256 amount;
    uint256 A;
    uint256 S;
    bool insolvent;
    uint256 base;
    uint256 maxEntryValue;
    uint256 maxDailyOutflowBps;
    uint256 minDailyOutflow;
    uint256 globalOutflowBps;
    bool payoutsOpen;
}

// ---- the payout engine ----

/// Everything the vault decided or read before it hands a payout to L3 (CascadePayoutLib.prepare, then
/// finish): the batch under the key as read (`batch`, all zero for an unknown key) and the reservation
/// (`pending`, the ledger's), memory copies of what L3 only reads; the primary bridge, which L3 calls, and
/// whether it is enabled (v3.1's `_primary` check, made by L3 in v3.1's place, after the door check); the door
/// check's result (`doorActive`, whether the batch's front door is active); whether the caller is the keeper
/// (`isKeeper`: L3 reads msg.sender only as its refund's target); the caller's msg.value (`value`, the fee valve's
/// top-up, Task 21: L3 never reads msg.value, and counts this once); and the vault's limits. L3 calls the bridge only
/// on this field, as passed (the library rules' field target, script/library-rules.mjs). Memory only: never stored
/// (gen-lens-layout's MEMORY_ONLY).
struct PayoutIn {
    PayoutBatch batch;
    uint256 pending;
    ICascadeBridge bridge;
    bool bridgeEnabled;
    bool doorActive;
    bool isKeeper;
    uint256 value;
    uint64 payoutDelay;
    uint32 minChunk;
    uint256 maxMessageValue;
    uint256 maxFeeBps;
    uint256 maxFeeAbs;
}

/// What L3's `prepare` decided for one chunk, which the vault's walk and L3's `finish` carry out: the entries
/// taken from the cursor (`taken`) and their gross value (`sum`), what is sent (`net`, before the walk; `finish`
/// splits again when the walk cost anything) and the bridge fee on top (`fee`, the whole quote in rao, 0 when
/// nothing is sent), the entries' share of it (`charged`, at most the fee ceiling, `fee - charged` being the
/// caller's top-up; 0 when nothing is sent), the part of what the vault itself pays, net + charged, that the
/// liquidity read before the walk does not cover (`shortfall`, what the vault unstakes first, T above it; 0 for
/// none), the caller's value less its top-up (`refund`, paid back last), that liquidity (`free`: the balance less
/// the caller's value, beyond ED_RESERVE and the other batches' reservations), the entries the split left with
/// nothing (`dust`, the PayoutDust `prepare` logged), what the vault's walk received (`received`, wei) and its cost
/// (`cost`, what the chain kept of the stake it took, whole rao; the entries' to bear), both 0 without a walk, and
/// the chunk's payout message (empty when nothing is sent). Memory only: never stored (gen-lens-layout's
/// MEMORY_ONLY).
struct PayoutPlan {
    uint32 taken;
    uint256 sum;
    uint256 net;
    uint256 fee;
    uint256 charged;
    uint256 shortfall;
    uint256 refund;
    uint256 free;
    uint256 dust;
    uint256 received;
    uint256 cost;
    bytes message;
}
