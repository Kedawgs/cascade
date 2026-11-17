// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CascadeBase} from "./CascadeBase.sol";
import {CascadeShares, addFresh, burnShares, mintShares} from "./CascadeShares.sol";
import {ICascadeBridge, ICascadeReceiver} from "./interfaces/ICascadeBridge.sol";
import {ISTAKING_ADDRESS, IStaking} from "./interfaces/IStaking.sol";
import {ADDRESS_MAPPING_ADDRESS, IAddressMapping} from "./interfaces/IAddressMapping.sol";
import {CascadeMath} from "./libraries/CascadeMath.sol";
import {CascadeMessages} from "./libraries/CascadeMessages.sol";
import {CascadeFormulas} from "./libraries/CascadeFormulas.sol";
import {CascadeBatchLib} from "./libraries/CascadeBatchLib.sol";
import {CascadeStakeLib} from "./libraries/CascadeStakeLib.sol";
import {CascadePayoutLib} from "./libraries/CascadePayoutLib.sol";
import {CascadeHotkeyLib} from "./libraries/CascadeHotkeyLib.sol";
import {CascadeLedger} from "./libraries/CascadeLedger.sol";
import {
    Actor,
    BatchIn,
    Delay,
    DoorState,
    Holder,
    Kind,
    Ledger,
    PayoutBatch,
    PayoutIn,
    PayoutPlan,
    WalkParams,
    Window
} from "./CascadeTypes.sol";
import "./CascadeConstants.sol" as Constants;
import {NETUID_ROOT} from "./CascadeConstants.sol";
import {
    AdoptTooSoon,
    AlreadyActive,
    BelowMinAdoption,
    BelowMinDeposit,
    CapExceeded,
    ColdkeyMismatch,
    DirectTransferNotAllowed,
    DuplicateBatch,
    FeeTooHigh,
    InsufficientGas,
    InvalidParameter,
    NotKeeper,
    NotListed,
    NotRaoAligned,
    NothingToStake,
    PeerNotActive,
    StakeMissing,
    TransferFailed,
    UnknownHotkey,
    UnknownOrigin,
    UnknownPeer,
    UnstakeShort,
    ValueMismatch,
    VaultInsolvent,
    WriteOffTooLarge,
    ZeroAddress,
    ZeroAmount
} from "./CascadeErrors.sol";
import {
    Cancelled,
    ClaimGasSet,
    DepositedDirect,
    ExitsClosed,
    ExitsReopened,
    FrontDoorActivated,
    FrontDoorRemoved,
    KeeperSet,
    LimitSet,
    OutflowLimitsSet,
    PayoutBatchQueued,
    RedeemOriginSet,
    RedeemedDirect,
    RewardCutMinted,
    RewardCutSet,
    RewardsClaimed,
    ShortfallAbsorbed,
    StakeAdopted,
    StakeHotkeySet,
    StakeWrittenOff,
    Staked
} from "./CascadeEvents.sol";

/// @notice Cascade vault on Bittensor EVM: holds the root stake and the csTAO share balances.
/// Front doors on other chains batch deposits and redemption requests and deliver them over a
/// registered bridge; Bittensor-native users can deposit directly.
/// @dev csTAO (CascadeShares.sol, inherited first so its storage takes slots 0 and 1) has 24 decimals
/// and is non-transferable; every mint and burn goes through mintShares and burnShares. Prices read
/// the stake at min(visible, booked) (spec §3.1): the visible stake live through the staking precompile, the
/// booked from the vault's own ledger; TAO is in wei here, and in rao (1e9 wei) at the precompile and in the
/// ledger's booked stake.
contract CascadeVault is CascadeShares, CascadeBase, ICascadeReceiver {
    // ---- constants ----

    // The vault's read surface is its lens's (spec §8.1, Task 5d-2): every constant, the immutable, the
    // state and the derived values below are internal, and CascadeVaultLens serves each under its name,
    // reading the state through extsload. The vault keeps only the share token's surface (CascadeShares)
    // and owner, pendingOwner, paused, extsload and MS_PER_BLOCK (CascadeBase; an immutable, which the
    // lens asks the vault for).

    // CascadeConstants.sol's shared constants (NETUID_ROOT is imported as is), under their names.
    uint256 internal constant RAO = Constants.RAO;
    /// Never spent and never counted, so the chain's existential deposit cannot fail a payout.
    uint256 internal constant ED_RESERVE = Constants.ED_RESERVE;
    uint64 internal constant KEEPER_FALLBACK = Constants.KEEPER_FALLBACK;
    uint16 internal constant MAX_REWARD_CUT_BPS = Constants.MAX_REWARD_CUT_BPS;
    uint256 internal constant MAX_HOTKEYS = Constants.MAX_HOTKEYS;
    /// The redeem origin no front door burns for (spec §3.4): every direct deposit sets it, and a holder may.
    uint64 internal constant DIRECT_ORIGIN = Constants.DIRECT_ORIGIN;
    /// Stake added by stakeIdle enters the outflow allowance's base linearly over this period, and a holder's fresh
    /// shares stay unburnable by a front door for it (CascadeConstants.sol's, shared with the batch library, R4 B-H1).
    uint256 internal constant STAKE_RAMP = Constants.STAKE_RAMP;
    /// The most gas the vault gives its primary bridge's canSendPayouts() inside a delivery (R4, S-H1): the Bittensor
    /// adapter's three capped reads fit in it.
    uint256 internal constant RAIL_VIEW_GAS = 150_000;
    // Hard bounds on the owner's exit-safety parameters (I-23: no setter reaches a value outside its bounds, and a
    // tightening within them is never refused), so no setting raises the outflow cap, cuts or stretches the payout
    // delay or lifts the fee ceiling past them, or sends a payout message above the lane's limit or the primary
    // bridge's (AboveBridgeCap, spec §3.9). The outflow limits are bounded below too (spec §3.4, Task 17: both
    // percentages at least the 20% launch value, the floor at least 10 TAO), the fee ceiling's absolute part (spec
    // §3.3, Task 21: at least MIN_FEE_ABS; a fee above the ceiling is the caller's to top up) and the entry limit
    // (Task 23: at least MIN_ENTRY_VALUE), so none can freeze a front-door exit; the owner can still hold exits
    // closed with its instruments (pause, a door's removal, a bridge's disable).
    uint64 internal constant MIN_PAYOUT_DELAY = 1 hours;
    uint64 internal constant MAX_PAYOUT_DELAY = 48 hours;
    uint256 internal constant MIN_OUTFLOW_BPS = 2_000;
    uint256 internal constant MAX_OUTFLOW_BPS = 5_000;
    uint256 internal constant MIN_MIN_DAILY_OUTFLOW = 10e18;
    uint256 internal constant MAX_MIN_DAILY_OUTFLOW = 100e18;
    /// The least maxEntryValue may be: 10 TAO, the launch value (Appendix B).
    uint256 internal constant MIN_ENTRY_VALUE = 10e18;
    /// The lane's per-message limit (the adapters' MAX_MESSAGE_VALUE at most).
    uint256 internal constant MAX_MESSAGE_VALUE = 5_000e18;
    uint256 internal constant MAX_FEE_BPS = 500;
    /// The payout fee ceiling's absolute part, maxFeeAbs, lies in [MIN_FEE_ABS, MAX_FEE_ABS] (spec §3.3): at most
    /// half the smallest burned exit, so an exit with shares keeps at least half its value (I-14), and at least
    /// 0.01 TAO, so a low ceiling cannot freeze payouts (the caller tops up what the quote is above it). MAX_FEE_ABS is
    /// CascadeConstants.sol's, which the front door's minimum-deposit floor is twice.
    uint256 internal constant MAX_FEE_ABS = Constants.MAX_FEE_ABS;
    uint256 internal constant MIN_FEE_ABS = 0.01e18;
    uint256 internal constant MAX_UNSTAKE_MARGIN_RAO = 1e9;
    /// How much of its walk's request an exit's walk may leave untaken, in rao of stake at face value (spec §3.3,
    /// §3.10.11; T = SHORTFALL_TOLERANCE_RAO × RAO wei), no longer a fee tolerance: the walk stops once what is unmet
    /// is within it; a direct exit's leaver bears up to it (ShortfallAbsorbed, with the walk's cost); a payout chunk's
    /// walk asks it on top of what the chunk needs, which covers the second split's rounding unless the walk ends
    /// after a whole removal with less than a rao an entry of it left (that chunk refuses UnstakeShort until the
    /// balance or the positions move); more left untaken reverts UnstakeShort. A constant: an owner-set tolerance was
    /// rejected.
    uint256 internal constant SHORTFALL_TOLERANCE_RAO = 1_000;
    /// The bounds of unstakeGas, the least gas the unstake walk forwards to each removal (spec §3.8, Appendix B).
    uint256 internal constant MIN_UNSTAKE_GAS = 150_000;
    uint256 internal constant MAX_UNSTAKE_GAS = 5_000_000;
    /// The most of the booked stake the idle buffer keeps liquid, in bps: 10% (spec §3.8, Appendix B).
    uint256 internal constant MAX_IDLE_BUFFER_BPS = 1_000;
    /// The bounds of claimGasRequired, the gas claimRewards requires left before its claim (spec §3.9, round 9 L-3):
    /// at least 54.1M, so that the call, which forwards 63/64 of it, gives the chain's claimRootWithHotkey the 53.2M it
    /// needs; at most 63.4M, the most whose claim fits Bittensor's per-transaction limit, about 65,000,000
    /// (CascadeConstants.sol's, served by the lens).
    uint256 internal constant MIN_CLAIM_GAS = Constants.MIN_CLAIM_GAS;
    uint256 internal constant MAX_CLAIM_GAS = Constants.MAX_CLAIM_GAS;
    /// The largest dust allowance (the Task 14a carry): every removal path computes hotkeyDustRao * RAO, which this
    /// keeps within a word, so no owner value can panic a removal and block the stranger's (I-6's way back).
    uint256 internal constant MAX_HOTKEY_DUST_RAO = type(uint256).max / RAO;
    // MIN_REDEEM_VALUE, the smallest front-door redeem burned, is CascadeConstants.sol's: the batch
    // library (CascadeBatchLib) applies it.
    IStaking internal constant STAKING = IStaking(ISTAKING_ADDRESS);
    IAddressMapping internal constant ADDRESS_MAPPING = IAddressMapping(ADDRESS_MAPPING_ADDRESS);

    // ---- constructor arguments ----

    /// Everything launch-specific, set by the constructor (spec §7, Appendix B): the owner is the founder's
    /// key from the start, so there is no hand-off, and every value passes the check its setter makes, so no
    /// constructor can set what no setter could. `expectedColdkey` is the mirror of the vault's own address,
    /// which the constructor derives and compares; `hotkey` is the first hotkey and the stake hotkey;
    /// `bridge` the first bridge, enabled and primary; `initialFrontDoor` the launch door, active on
    /// `launchChain` from the deploy; `msPerBlock` Bittensor's calibrated block time (7,200 ms, calibrated so half the
    /// delay in blocks takes 5/6 of it at today's 12-second blocks: 1.67 times faster blocks, Revision 28), the
    /// scheduler's block floor (CascadeBase, immutable); `rewardVesting` the
    /// period claimed rewards vest over (Task 15). A wrong value is a redeploy. `idleBufferBps` and `unstakeGas`
    /// (Task 20): the idle buffer and the walk's least gas per removal.
    struct Params {
        bytes32 expectedColdkey;
        bytes32 hotkey;
        ICascadeBridge bridge;
        address owner;
        address guardian;
        address keeper;
        address treasury;
        uint16 rewardCutBps;
        uint64 launchChain;
        address initialFrontDoor;
        uint64 payoutDelay;
        uint256 maxDailyOutflowBps;
        uint256 minDailyOutflow;
        uint256 maxEntryValue;
        uint256 maxMessageValue;
        uint32 minChunk;
        uint256 maxFeeBps;
        uint256 maxFeeAbs;
        uint256 maxTotalAssets;
        uint256 minDirectDeposit;
        uint256 claimGasRequired;
        uint256 hotkeyDustRao;
        uint256 unstakeMarginRao;
        uint64 msPerBlock;
        uint64 rewardVesting;
        uint256 globalOutflowBps;
        uint16 idleBufferBps;
        uint256 unstakeGas;
    }

    // ---- immutables ----

    /// The vault's own substrate coldkey (the mirror of its H160 address).
    bytes32 internal immutable coldkey;
    /// The chain of the launch front door. Public: verify reads it from the vault itself, not the lens.
    uint64 public immutable launchChain;

    // ---- state ----

    // hotkeys
    bytes32[] internal hotkeys;
    mapping(bytes32 => bool) internal isHotkey;
    bytes32 internal stakeHotkey;
    mapping(bytes32 => uint64) internal lastClaimAt;

    // keeper timing
    address internal keeper;
    uint64 internal lastStakeAt;

    /// The unstake guard receive() reads, set only around an unstake (the walk, L2's call; the owner's
    /// removeHotkey, L4's call, whose direct removal may unstake). Transient: set and cleared within one
    /// transaction, so it takes no storage slot and no fresh-slot write before a walk; a revert clears it with
    /// everything else. Transient storage is per address, so receive() reads it while L2 or L4 runs in the
    /// vault's context. No library sets it.
    bool internal transient _unstaking;

    /// The ledger (Ledger, CascadeTypes.sol), one struct so that a library takes one narrow pointer to it:
    ///   - pending: the wei reserved for queued payouts;
    ///   - booked: the stake the vault accounts for, in rao (spec §3.1; the lens's bookedStake(), ruling A19):
    ///     only stake-side measurements move it, each floored at 0 (I-2): what stakeIdle measured on the stake
    ///     hotkey, the visible stake's rise in a claim, less the stake each removal took off its position. The
    ///     price reads min(visible, booked), and so does the allowance base, so stake moved onto the vault's
    ///     hotkeys from outside (a gift) counts only once adopted (Task 16) or unstaked into balance (I-3);
    ///   - ramping: the wei still entering the allowance base over STAKE_RAMP from lastStakeAt: what
    ///     stakeIdle measured, less what unstakes received since (spec §3.10.12).
    Ledger internal ledger;

    // accounting: the claim schedule, the claimed rewards' drip, `vestingAmount` vesting linearly from `vestingStart`
    // over `vestingPeriod`, what the last restart snapshotted (_vest: the owner's rewardVesting, or what was left of
    // the old schedule if longer; spec §3.6: a change applies from the next restart; a carried remainder never vests
    // faster than its own schedule). Only a claim and the write-down at a supply of 0 restart it; an adoption vests on
    // its own drip (adoptVestingAmount, Revision 27).
    uint256 internal vestingAmount;
    uint64 internal vestingStart;
    uint64 internal vestingPeriod;

    // reward cut: the share of each claim minted to the treasury as csTAO
    address internal treasury;
    uint16 internal rewardCutBps;

    // front doors and direct users
    /// Each front door's state, by peer id (DoorState, CascadeTypes.sol): Active while it may deliver and be
    /// paid; Unknown again once the guardian removes it, Removed once the owner does (spec §3.6).
    mapping(bytes32 peer => DoorState) internal doorState;
    /// The active doors on each chain: the launch chain's reaching 0 is an instrument (removeFrontDoor), and only a
    /// chain with one may be named as a redeem origin (setRedeemOrigin).
    mapping(uint64 chain => uint256) internal activeDoors;
    /// The vault's two holds (spec §3.6), beside CascadeBase's primaryDisabledBy, one slot: who paused the
    /// vault, while it is paused; and who removed the launch chain's last active door, until a door there is
    /// activated again or, when it was the guardian, setGuardian runs.
    Actor internal pausedBy;
    Actor internal launchDoorRemovedBy;
    /// Each holder's record (Holder, CascadeTypes.sol): its redeem origin (spec §3.4, Task 18) and its fresh shares (spec
    /// §3.5, R4 B-H1, the door hold), one slot. The origin is 0 (none yet), the chain whose front doors may burn its
    /// shares (and only theirs), or DIRECT_ORIGIN (no door does). A door's first mint of non-zero assets for an address
    /// of origin 0 sets the door's chain (L1); every direct deposit sets DIRECT_ORIGIN; the holder sets either through
    /// setRedeemOrigin, the only write with an event of its own (RedeemOriginSet): the other two are fully determined
    /// by Deposited (of non-zero assets, from a door's chain, for an origin of 0; an entry below a rao logs Deposited of
    /// 0 and writes none) and DepositedDirect, and the state before them. The fresh shares are what a front door's
    /// deposit (L1's credit) and depositDirect minted for it in its last run of mints, which no front door burns until
    /// STAKE_RAMP after the run's clock, so a deposit and a redeem in one batch burn nothing and no share younger than
    /// about a day takes the first-come allowance. The reward cut and a cancel's re-mint touch neither. In directOnly's
    /// slot (v3-launch's mapping, which it replaces; redeemOrigin's, a uint64 at offset 0, before R4), so no other
    /// variable moved.
    mapping(address => Holder) internal holders;

    // batch delivery and the payout queue (PayoutBatch and Window are in CascadeTypes.sol)

    /// Every delivered batch, payouts or not: the replay record.
    mapping(bytes32 => bool) internal processed;
    /// Served by the vault lens's getPayoutBatch.
    mapping(bytes32 => PayoutBatch) internal payoutBatches;
    /// Value burned per front door (keyed by peerId) in its current 24-hour window, and by all doors together in
    /// the global window (keyed GLOBAL_WINDOW, 0, which no peer id takes; Task 17).
    mapping(bytes32 => Window) internal burnWindows;

    // parameters (the constructor's Params; the staking floors' fallbacks are constants since Task 23,
    // CascadeConstants.sol's FALLBACK_MIN_STAKE_RAO and FALLBACK_MIN_REMAIN_RAO)
    uint32 internal minChunk;
    uint64 internal payoutDelay;
    /// The period each restart of a drip snapshots (_restartPeriod): the claim schedule's into vestingPeriod, the
    /// adoption drip's into adoptVestingPeriod. 1 to 30 days.
    uint64 internal rewardVesting;
    uint256 internal maxDailyOutflowBps;
    uint256 internal minDailyOutflow;
    uint256 internal maxEntryValue;
    uint256 internal maxMessageValue;
    uint256 internal maxFeeBps;
    uint256 internal maxFeeAbs;
    uint256 internal maxTotalAssets;
    uint256 internal minDirectDeposit;
    uint256 internal hotkeyDustRao;
    uint256 internal claimGasRequired;
    /// Added to every unstake request, in rao, to cover a chain fee or short delivery on root unstakes.
    uint256 internal unstakeMarginRao;

    // adoption (Task 16)
    /// When adoptStake last ran, or the deploy (spec §3.10.2): the next adoption waits a STAKE_RAMP from it, and its
    /// KEEPER_FALLBACK counts from it. Last in the layout, in a slot of its own, so no other variable moved (and,
    /// alone there, it costs fewer bytes to read and write than packed beside the reward schedule).
    uint64 internal lastAdoptAt;

    // the global outflow window (Task 17)
    /// All front doors' daily allowance together, in bps of the allowance base, at least minDailyOutflow, beside each
    /// door's maxDailyOutflowBps (spec §3.4; the window at burnWindows[GLOBAL_WINDOW]). Last in the layout, as
    /// lastAdoptAt was, so no other variable moved.
    uint256 internal globalOutflowBps;

    // the unstake walk under a root hold (Task 20), last in the layout, so no other variable moved
    /// The least gas the walk forwards to each removal (L2, CascadeStakeLib; spec §3.8): each gets the larger of this
    /// and its share of what is above EXIT_GAS_RESERVE. MIN_UNSTAKE_GAS to MAX_UNSTAKE_GAS; immediate both ways.
    uint256 internal unstakeGas;
    /// The idle buffer, in bps of the booked stake (spec §3.8): what stakeIdle leaves liquid for exits a root hold
    /// on every pair would otherwise freeze (_idleBuffer). At most MAX_IDLE_BUFFER_BPS; 0, no buffer, at launch.
    uint16 internal idleBufferBps;

    // the adoption drip (Revision 27), last in the layout, so no other variable moved: laid out as the claim schedule
    /// The adopted surplus's own drip, beside the claim schedule (spec §3.1, §3.6): `adoptVestingAmount` vesting
    /// linearly from `adoptVestingStart` over `adoptVestingPeriod`, restarted only by an adoption (its remainder and
    /// the surplus) and by the write-down at a supply of 0, by the claim schedule's rule (_restartPeriod). An adoption
    /// never restarts the claim schedule, so it never pushes the claimed rewards later.
    uint256 internal adoptVestingAmount;
    uint64 internal adoptVestingStart;
    uint64 internal adoptVestingPeriod;

    // ---- errors and events ----

    // Declared at file level, in CascadeErrors.sol and CascadeEvents.sol.

    // ---- constructor ----

    /// Every value of `p` goes through the internal function its setter uses (the check, the write and the
    /// setter's event), so the constructor can set nothing a setter could not; CascadeBase sets the owner
    /// (OpenZeppelin's Ownable refuses a zero one), the guardian, the bridge and the block time (61 to 60,000
    /// ms). Only the launch chain and the block time, immutable, have no setter: a zero chain is refused.
    constructor(Params memory p) CascadeBase(p.owner, p.guardian, address(p.bridge), p.msPerBlock) {
        bytes32 derived = ADDRESS_MAPPING.addressMapping(address(this));
        if (derived != p.expectedColdkey) revert ColdkeyMismatch(p.expectedColdkey, derived);
        coldkey = derived;
        // the keeper fallbacks count from deploy, not from 0 (the hotkey's claim fallback is seeded as it is
        // added), and so does the first adoption's day
        lastStakeAt = uint64(block.timestamp);
        lastAdoptAt = uint64(block.timestamp);
        // listed through addHotkey's rules as a privileged add (L4, by DELEGATECALL): the list and the ledger are
        // empty, so nothing is missing and no precompile is read
        CascadeHotkeyLib.add(hotkeys, isHotkey, lastClaimAt, p.hotkey, true, derived, 0, 0);
        _setStakeHotkey(p.hotkey);
        _setKeeper(p.keeper);
        _setRewardCut(p.treasury, p.rewardCutBps);
        // Like the initial bridge, the launch door is active at once: nobody has deposited yet, so the
        // deployer's choice needs no delay. A later front door is a scheduled activation (REGISTRY_DELAY).
        _checkFrontDoor(p.launchChain, p.initialFrontDoor);
        launchChain = p.launchChain;
        _activateFrontDoor(peerId(p.launchChain, p.initialFrontDoor), p.launchChain, p.initialFrontDoor);
        _setPayoutDelay(p.payoutDelay);
        _setOutflowLimits(p.maxDailyOutflowBps, p.minDailyOutflow, p.globalOutflowBps);
        _setMessageLimits(p.maxEntryValue, p.maxMessageValue, p.minChunk);
        _setFeeLimits(p.maxFeeBps, p.maxFeeAbs);
        _setMaxTotalAssets(p.maxTotalAssets);
        _setMinDirectDeposit(p.minDirectDeposit);
        _setClaimGasRequired(p.claimGasRequired);
        _setHotkeyDustRao(p.hotkeyDustRao);
        _setUnstakeMarginRao(p.unstakeMarginRao);
        _setRewardVesting(p.rewardVesting);
        _setUnstakeGas(p.unstakeGas);
        _setIdleBuffer(p.idleBufferBps);
        STAKING.setRejectStakingHotkeyGrowth(true);
    }

    // ---- front doors ----

    function peerId(uint64 chain, address addr) internal pure returns (bytes32) {
        return CascadeFormulas.peerId(chain, addr);
    }

    /// Front door `addr` on `chain` becomes active: scheduled only (the Registry class, 7 days: a Reopen for a
    /// door the owner removed, else Ordinary; _classify), refusing chain 0, the zero door and an active door, as
    /// schedule does (ruling B3; the 7b review's carry). On the launch chain it clears the launch door's hold,
    /// whoever made it, stamping nothing (spec §3.6: only this, or a swap over a guardian's hold, clears it).
    function activateFrontDoor(uint64 chain, address addr) external onlyScheduled {
        _checkFrontDoor(chain, addr);
        bytes32 id = peerId(chain, addr);
        if (doorState[id] == DoorState.Active) revert AlreadyActive();
        _activateFrontDoor(id, chain, addr);
        if (chain == launchChain && launchDoorRemovedBy != Actor.None) {
            launchDoorRemovedBy = Actor.None;
            emit ExitsReopened(this.activateFrontDoor.selector);
        }
    }

    /// A front door is on a chain (never 0, as the launch chain, and never DIRECT_ORIGIN, which a door on it
    /// would read as its own chain's holders: I-17) and is never the zero address: the constructor's check of
    /// the launch door, and the activation's at schedule and at execute.
    function _checkFrontDoor(uint64 chain, address addr) internal pure {
        if (chain == 0 || chain == DIRECT_ORIGIN) revert InvalidParameter();
        if (addr == address(0)) revert ZeroAddress();
    }

    /// Front door `addr` on `chain` (peer `id`) becomes active and is counted on its chain: the launch door at
    /// deploy, any other through its scheduled activation.
    function _activateFrontDoor(bytes32 id, uint64 chain, address addr) internal {
        doorState[id] = DoorState.Active;
        ++activeDoors[chain];
        emit FrontDoorActivated(chain, addr);
    }

    /// The owner or the guardian removes an active door, counting it out of its chain. The guardian's removal
    /// makes the door unknown (its activation Ordinary, which the guardian may cancel), the owner's leaves it
    /// known (Removed: its re-activation a Reopen). The guardian may also remove a door the owner removed,
    /// making that removal its own (Task 10b; spec §3.6: a stolen owner key cannot bring a door back past an
    /// honest guardian, so it must not do so by removing the door first): the door becomes unknown, is not
    /// counted out again, and its pending Reopen, if any, is deleted (Cancelled by the guardian; one door has
    /// one canonical calldata and one id, spec §3.10.8). Any other removal reverts PeerNotActive, so no
    /// chain's count goes below the doors it counts and the owner never makes an unknown door Removed. The
    /// launch chain's last active door's removal is an instrument (spec §3.6): it records its actor (the hold),
    /// stamps that actor's clock and emits ExitsClosed; so does the guardian's removal of an owner-removed
    /// launch-chain door while the launch door's hold is the owner's, which it makes the guardian's (were the
    /// owner's record left, no Removed launch-chain door might remain for the Reopen that alone clears it,
    /// I-26). Any other removal, another chain's last door's included, records and stamps nothing.
    function removeFrontDoor(uint64 chain, address addr) external {
        Actor a = _actor();
        bytes32 id = peerId(chain, addr);
        DoorState s = doorState[id];
        bool closes;
        if (s == DoorState.Active) {
            closes = --activeDoors[chain] == 0;
        } else if (s == DoorState.Removed && a == Actor.Guardian) {
            closes = launchDoorRemovedBy == Actor.Owner;
            bytes32 reopen = keccak256(abi.encodeCall(this.activateFrontDoor, (chain, addr)));
            if (scheduled[reopen].readyAt != 0) {
                delete scheduled[reopen];
                emit Cancelled(reopen, msg.sender);
            }
        } else {
            revert PeerNotActive();
        }
        doorState[id] = a == Actor.Guardian ? DoorState.Unknown : DoorState.Removed;
        emit FrontDoorRemoved(chain, addr);
        if (closes && chain == launchChain) {
            launchDoorRemovedBy = a;
            _stamp(a);
            emit ExitsClosed(msg.sender, this.removeFrontDoor.selector);
        }
    }

    // ---- the scheduler's classes (spec §3.6) ----

    /// The vault's schedulable selectors, then CascadeBase's. activateFrontDoor is the Registry class: a Reopen
    /// for a door the owner removed (active before, and still known), else Ordinary (a door never active, or one
    /// the guardian removed, which made it unknown: spec §3.6, round 5 L-6). Its two arguments are decoded with
    /// abi.decode, which refuses dirty bits, so one door has one calldata and one id (spec §3.10.8); chain 0, a
    /// zero door and an active door are refused here, as the activation refuses them at execute. The setters'
    /// sub-word arguments are checked by their own decoder at execute (an item with dirty bits never runs).
    function _classify(bytes calldata data) internal view override returns (Delay, Kind) {
        // casting to 'bytes4' keeps the selector, the first 4 bytes of data (zero-padded when shorter)
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes4 selector = bytes4(data);
        if (selector == this.activateFrontDoor.selector) {
            _requireArgs(data, 2);
            (uint64 chain, address addr) = abi.decode(data[4:], (uint64, address));
            _checkFrontDoor(chain, addr);
            DoorState s = doorState[peerId(chain, addr)];
            if (s == DoorState.Active) revert AlreadyActive();
            return (Delay.Registry, s == DoorState.Removed ? Kind.Reopen : Kind.Ordinary);
        }
        // The rest are Ordinary, each at its canonical length (one word per argument). writeOffMissingStake (Task 16)
        // is the Registry class (7 days) whatever its amount; the others the Param class (48 hours): moveStake and
        // setStakeHotkey whatever their value, and the limit setters whatever their direction (a tightening or an
        // equal value waits and executes harmlessly, spec §3.10.6; only a loosening needs it).
        Delay class_ = Delay.Param;
        uint256 words = 1;
        if (selector == this.writeOffMissingStake.selector) {
            class_ = Delay.Registry;
        } else if (
            selector == this.setStakeHotkey.selector || selector == this.setMaxTotalAssets.selector
                || selector == this.setPayoutDelay.selector || selector == this.setRewardVesting.selector
                || selector == this.setIdleBuffer.selector
        ) {
            // one word
        } else if (selector == this.setFeeLimits.selector || selector == this.setRewardCut.selector) {
            words = 2;
        } else if (
            selector == this.moveStake.selector || selector == this.setMessageLimits.selector
                || selector == this.setOutflowLimits.selector
        ) {
            words = 3;
        } else {
            return super._classify(data);
        }
        _requireArgs(data, words);
        return (class_, Kind.Ordinary);
    }

    // ---- the vault's exits machine (spec §3.6): the pause and the launch door's hold, beside the primary's ----

    /// The owner holds the exits closed: it disabled the primary, paused the vault, or removed the launch
    /// chain's last door.
    function ownerHold() internal view override returns (bool) {
        return CascadeFormulas.holds(Actor.Owner, primaryDisabledBy, pausedBy, launchDoorRemovedBy);
    }

    function guardianHold() internal view override returns (bool) {
        return CascadeFormulas.holds(Actor.Guardian, primaryDisabledBy, pausedBy, launchDoorRemovedBy);
    }

    /// The vault's pause is an instrument (ruling A1: CascadeBase's is overridden): the owner or the guardian
    /// pauses, recording itself (the hold) and stamping its clock. A second pause reverts (EnforcedPause), so
    /// the first pauser stays recorded and no other clock is stamped through it.
    function pause() public override {
        Actor a = _actor();
        _pause();
        pausedBy = a;
        _stamp(a);
        emit ExitsClosed(msg.sender, this.pause.selector);
    }

    /// The owner unpauses: the pause's hold is cleared, whoever paused, and nothing is stamped.
    function unpause() public override onlyOwner {
        _unpause();
        pausedBy = Actor.None;
        emit ExitsReopened(this.unpause.selector);
    }

    /// After setGuardian: the launch door's hold is cleared when the guardian made it (a door hold lasts no
    /// longer than the guardian who made it; a swap to the sitting guardian is how the owner clears an honest
    /// guardian's, round 6 L-1). An owner's stays, as does any pause: only an activation on the launch chain
    /// clears the owner's door hold.
    function _onGuardianSet() internal override {
        if (launchDoorRemovedBy == Actor.Guardian) {
            launchDoorRemovedBy = Actor.None;
            emit ExitsReopened(this.setGuardian.selector);
        }
    }

    // ---- derived values ----
    // Each goes through CascadeFormulas, with which the vault lens computes the view of the same name.

    /// The visible stake: root stake across the hotkey set, in rao, read live (v3.1's rootStakeRao).
    function visibleStakeRao() internal view returns (uint256 total) {
        uint256 n = hotkeys.length;
        for (uint256 i; i < n; ++i) {
            total += _stakeOf(hotkeys[i]);
        }
    }

    /// The booked stake, in rao (ruling A19): the ledger's.
    function bookedStake() internal view returns (uint256) {
        return ledger.booked;
    }

    /// The booked stake the hotkey set does not show, in rao.
    function missingStakeRao() internal view returns (uint256) {
        return _sub0(ledger.booked, visibleStakeRao());
    }

    /// The visible stake the ledger does not hold (a gift, until adopted), in rao.
    function surplusStakeRao() internal view returns (uint256) {
        return _sub0(visibleStakeRao(), ledger.booked);
    }

    /// Whether stake is missing past the tolerance (CascadeFormulas.stakeMissing): what Task 13's guards read.
    function stakeMissing() internal view returns (bool) {
        return CascadeFormulas.stakeMissing(visibleStakeRao(), ledger.booked, ledger.pending);
    }

    /// The coldkey's root stake off the hotkey set (a swap's new hotkey, until listed), in rao
    /// (CascadeFormulas.unlistedStakeRao); reverts when the precompile cannot total it. The total is read here
    /// and in the lens, not in CascadeFormulas, so that L2's closure keeps only the precompile calls its walk
    /// makes.
    function unlistedStakeRao() internal view returns (uint256) {
        return
            CascadeFormulas.unlistedStakeRao(
                STAKING.getTotalColdkeyStakeOnSubnet(coldkey, NETUID_ROOT), visibleStakeRao()
            );
    }

    /// The stake the vault prices, in rao: min(visible, booked) (CascadeFormulas.pricedStakeRao).
    function pricedStakeRao() internal view returns (uint256) {
        return CascadeFormulas.pricedStakeRao(visibleStakeRao(), ledger.booked);
    }

    /// The priced stake and the liquid balance, less the existential reserve: what every mint and burn reads.
    function grossAssets() internal view returns (uint256) {
        return CascadeFormulas.grossAssets(CascadeFormulas.positionWei(pricedStakeRao(), address(this).balance));
    }

    /// What is still vesting of both drips, each over its own period: the claimed rewards and the adopted surplus. What
    /// totalAssets() leaves out.
    function unvestedRewards() internal view returns (uint256) {
        return _claimUnvested() + _adoptionUnvested();
    }

    /// What is still vesting of the claimed rewards, the claim schedule, over its own period (vestingPeriod): what a
    /// claim's restart carries.
    function _claimUnvested() internal view returns (uint256) {
        return CascadeFormulas.unvestedRewards(vestingAmount, vestingStart, vestingPeriod);
    }

    /// What is still vesting of the adopted surplus, the adoption drip, over its own period (adoptVestingPeriod): what
    /// an adoption's restart carries.
    function _adoptionUnvested() internal view returns (uint256) {
        return CascadeFormulas.unvestedRewards(adoptVestingAmount, adoptVestingStart, adoptVestingPeriod);
    }

    function totalAssets() internal view returns (uint256) {
        return CascadeFormulas.totalAssets(grossAssets(), ledger.pending, unvestedRewards());
    }

    /// The chain's minimum stake operation, in rao: the larger of the live read and FALLBACK_MIN_STAKE_RAO (a
    /// constant since Task 23), or the fallback alone if the read fails.
    function minStakeRao() internal view returns (uint256) {
        return CascadeFormulas.minStakeRao();
    }

    /// The chain's minimum nominator position, in rao: the larger of the live read and FALLBACK_MIN_REMAIN_RAO
    /// (a constant since Task 23), or the fallback alone if the read fails.
    function minRemainRao() internal view returns (uint256) {
        return CascadeFormulas.minRemainRao();
    }

    // ---- stake and hotkeys ----

    /// Adds `h` to the set without routing new stake to it (e.g. to claim a forfeited hotkey's rewards, or to bring
    /// stake a validator's hotkey swap moved back into the price; spec §3.1). The owner, the guardian or the keeper
    /// at any time; anyone while stake is missing, of a hotkey the vault never listed (lastClaimAt, set at the first
    /// listing and kept after removal: a removed hotkey stays in the coldkey's staking set, so a stranger could have
    /// seeded it) holding at least the chain's minimum of the vault's root stake, else NotEligible: the permissionless
    /// way back (I-6). Safe, as the price reads min(visible, booked): listing can only raise the visible stake toward
    /// the booked. The add that fills the last slot (MAX_HOTKEYS) needs stake missing and that minimum on `h`,
    /// whoever adds, else SlotReserved (round 8 L-2; checked after the zero hotkey, a listed one and a full set):
    /// other adds fill at most MAX_HOTKEYS - 1 slots, so a swap always finds one. The vault reads who the caller is
    /// (privileged: the owner, the guardian or the keeper); the rules run in L4 (CascadeHotkeyLib.add, by
    /// DELEGATECALL), which writes the list, isHotkey and lastClaimAt and logs HotkeyAdded (spec §8.1).
    function addHotkey(bytes32 h) external {
        CascadeHotkeyLib.add(
            hotkeys,
            isHotkey,
            lastClaimAt,
            h,
            msg.sender == owner() || msg.sender == guardian || msg.sender == keeper,
            coldkey,
            ledger.booked,
            ledger.pending
        );
    }

    /// Where new stake goes (spec §3.6, §3.10.3): the owner's, of a listed hotkey only, else NotListed (at execute
    /// too; listing is addHotkey's, never implicit). Immediate when it follows stake that already moved (L-1): `h`
    /// holds more than the stake hotkey and at least half the booked stake, as after a swap of the stake hotkey;
    /// otherwise scheduled (the Param class, 48 hours).
    function setStakeHotkey(bytes32 h) external onlyOwner {
        if (!isHotkey[h]) revert NotListed();
        uint256 s = _stakeOf(h);
        _requireScheduledIfLoosens(s <= _stakeOf(stakeHotkey) || s < ledger.booked / 2);
        _setStakeHotkey(h);
    }

    /// Moves root stake from `from` onto `to`, which must be the stake hotkey at execute (root to root, fee-free).
    /// Scheduled only (the Param class), whatever the amount (spec §3.6). The destination is in the calldata the
    /// guardian reviewed, so a setStakeHotkey that runs at once in the 48 hours cannot redirect the move: the item
    /// then reverts InvalidParameter (the R1-A carry). It moves what `from` holds at execute, up to `rao` (R1-A L-2):
    /// any redeem or payout walk in the 48 hours may draw on `from`, and moving less is a tightening, so the item
    /// runs rather than reverting for its whole window; on an empty position it moves nothing. The vault keeps the
    /// schedule check; the checks and the move run in L4 (CascadeHotkeyLib.move, by DELEGATECALL), which logs
    /// StakeMoved and writes nothing.
    function moveStake(bytes32 from, bytes32 to, uint256 rao) external onlyScheduled {
        CascadeHotkeyLib.move(isHotkey[from], from, to, rao, coldkey, stakeHotkey);
    }

    /// Three removal paths (spec §3.1, §3.10.4, §3.10.10), never of the stake hotkey. The owner's (v3.1's): any
    /// stake left on `h` moves to the stake hotkey, or below the chain's minimum becomes idle balance, and unless
    /// `forfeit` it refuses while `h` has unclaimed rewards above the dust allowance (HotkeyHasRewards); forfeited
    /// rewards stay owed on chain and can be claimed after re-adding `h`. The keeper's or the guardian's: only of a
    /// hotkey with no stake (exactly 0) and unclaimed rewards at most the dust allowance, forfeit or not. Anyone's:
    /// only of a hotkey with no stake and nothing unclaimed, while the set is full and stake is missing, its one
    /// purpose being to free a slot for a swap's new hotkey (so, while nothing is missing or a slot is free, no
    /// stranger can remove an empty X during the owner's scheduled setStakeHotkey(X), round 9 L-2; when the set is
    /// full and stake is missing it can, and the item then fails NotListed, kept, until the owner lists X again).
    /// Any other removal reverts NotAuthorized. HotkeyRemoved's `forfeit` is true only for the owner's forfeit (the
    /// other paths decide by the dust rule, whatever the flag). The unclaimed rewards are an optional read (spec §3.1,
    /// R2 F1): should it fail, the owner's forfeit still removes (logging 0 unclaimed) and every other path refuses
    /// as for rewards above the dust. The record of `h` (lastClaimAt) stays. The vault
    /// reads who the caller is (byOwner; byKeeperOrGuardian) and what L4 cannot (the coldkey, the stake hotkey, the
    /// booked stake, the dust allowance); the rules, the owner's leftover handling and the
    /// list's writes run in L4 (CascadeHotkeyLib.remove, by DELEGATECALL; spec §8.1), which writes only the list,
    /// isHotkey and lastClaimAt. The owner's direct removal of a leftover below the minimum is the vault's own, not
    /// L2's walk (the chain's refusal reverts), so the vault sets its transient unstake flag around the owner's
    /// call, the only one that can unstake: the precompile's TAO enters receive() under it. While it is set, L4
    /// calls nothing but the precompile (its views, a move of the leftover, or that removal). Then the vault clears
    /// it and books the removal's two measurements, which L4 returns, as it books L2's walk (CascadeLedger.applyWalk:
    /// the stake that left off the booked stake, the receipt off the ramp); nothing when nothing was removed.
    function removeHotkey(bytes32 h, bool forfeit) external {
        bool byOwner = msg.sender == owner();
        if (byOwner) _unstaking = true;
        (uint256 received, uint256 debit) = CascadeHotkeyLib.remove(
            hotkeys,
            isHotkey,
            h,
            forfeit,
            byOwner,
            msg.sender == keeper || msg.sender == guardian,
            coldkey,
            stakeHotkey,
            ledger.booked,
            ledger.pending,
            hotkeyDustRao
        );
        if (byOwner) {
            _unstaking = false;
            if (received != 0 || debit != 0) CascadeLedger.applyWalk(ledger, received, debit);
        }
    }

    /// Stakes the liquid balance not reserved for queued payouts or the existential deposit, less the idle buffer
    /// (_idleBuffer, spec §3.8), which it leaves liquid for exits (none at idleBufferBps 0). Keeper
    /// only, or anyone once KEEPER_FALLBACK has passed since the last stake (or the deploy). It books what
    /// it measured on the stake hotkey (its stake after less before: a fresh position's read can be one rao
    /// short of what was staked, and the ledger follows the read, so the guard never sees it as missing), at most
    /// what it staked (R2 F3: a chain-side credit landing inside addStake stays a surplus, which only adoptStake
    /// books, vested), and that alone joins what is still ramping, all of it entering the outflow allowance's base
    /// linearly over STAKE_RAMP from now (spec §3.10.12). Staked logs the measured gain. Stake it finds unbooked, a
    /// gift, it leaves alone: only adoptStake books that (Task 16), without a ramp.
    function stakeIdle() external whenNotPaused nonReentrant {
        uint64 last = lastStakeAt;
        _requireKeeperOrAfter(last);
        uint256 rao = _sub0(_available(), _idleBuffer()) / RAO;
        if (rao < minStakeRao()) revert NothingToStake();

        bytes32 h = stakeHotkey;
        uint256 before = _stakeOf(h);
        STAKING.addStake(h, rao, NETUID_ROOT);
        uint256 measured = _sub0(_stakeOf(h), before);
        uint256 gained = measured < rao ? measured : rao;
        ledger.booked += gained;
        ledger.ramping = _unspent(ledger.ramping, last, STAKE_RAMP) + gained * RAO;
        lastStakeAt = uint64(block.timestamp);
        emit Staked(h, rao, measured);
    }

    /// Books the surplus, the stake visible on the listed hotkeys above the booked stake (a gift, or stake that came
    /// back after a write-off; spec §3.1), and vests it into the price from now on its own drip, with no cut
    /// (Revision 27): the adoption drip restarts on what is left of it and the surplus (_vestAdoption, by the claim
    /// schedule's rule: what is still unvested carries over on its own schedule, ruling B7b), and the claim schedule is
    /// left alone, so the claimed rewards keep their own pace and no adoption pushes them later. So the price does not
    /// step and a deposit made just before gains only what vests while it is held. It enters the
    /// outflow base at once, and lastStakeAt and the ramp are left alone (spec §3.10.2: a gift cannot be withdrawn,
    /// so it is not the borrowed capital the ramp is for). Keeper only, or anyone once KEEPER_FALLBACK has passed
    /// since the last adoption (or the deploy), else NotKeeper; at most once per STAKE_RAMP (a day), else
    /// AdoptTooSoon; and only a surplus of at least the chain's minimum stake, else BelowMinAdoption. While stake is
    /// missing the surplus is 0, so nothing can be adopted. Refused while paused (spec §3.10.13).
    function adoptStake() external whenNotPaused nonReentrant {
        uint256 last = lastAdoptAt;
        _requireKeeperOrAfter(last);
        // no overflow: a timestamp plus a day, and rao (precompile reads, at most the chain's 21M TAO) times 1e9
        unchecked {
            // forge-lint: disable-next-line(block-timestamp)
            if (block.timestamp < last + STAKE_RAMP) revert AdoptTooSoon();
            uint256 visible = visibleStakeRao();
            uint256 surplus = _sub0(visible, ledger.booked);
            if (surplus < minStakeRao()) revert BelowMinAdoption();
            // booked + surplus: exactly the visible stake
            ledger.booked = visible;
            _vestAdoption(_adoptionUnvested() + surplus * RAO);
            lastAdoptAt = uint64(block.timestamp);
            emit StakeAdopted(surplus);
        }
    }

    /// Writes off stake that is gone (spec §3.1, M-1): the owner's, scheduled only (the Registry class, 7 days, and
    /// the Ordinary kind, so the guardian may cancel it, and it needs the exits open at scheduling and at execute).
    /// It writes off w = min(rao, missing), and only if w + unlisted <= missing, else WriteOffTooLarge (the item
    /// kept): `unlisted` is the vault's root stake on its coldkey under hotkeys it does not list (a swap's new hotkey,
    /// or a gift there), which listing could still bring back, so only the gap no hotkey of the coldkey holds can be
    /// written off. The coldkey's total is read in a `try` capped at 45,000,000 gas (CascadeFormulas.WRITE_OFF_READ_GAS,
    /// R6 C: the chain prices this read by the coldkey's positions, which anyone can add under the vault's own hotkeys,
    /// so READ_GAS's 100,000 could be priced out for good; the cap is the most any coldkey's read can cost today) and a
    /// failed read counts as 0: were the precompile function ever gone, or its metering raised past the cap, this bound
    /// would be lost, which the 7-day notice and the veto make acceptable. The read is given its whole cap
    /// (`requireGasFor`, else InsufficientGas and the item kept), so no gas limit, the owner's wallet estimate included,
    /// can starve it into that 0 and write off stake that listing could still bring back (Revision 28's gas audit): the
    /// execute needs about 46.5M gas, which ops sends explicitly. The booked stake falls by w and never below the
    /// visible, so the price, which reads min(visible, booked), does not move (I-4); once nothing is missing, minting
    /// reopens at that price.
    function writeOffMissingStake(uint256 rao) external onlyScheduled {
        uint256 visible = visibleStakeRao();
        uint256 booked = ledger.booked;
        uint256 missing = _sub0(booked, visible);
        uint256 w = rao < missing ? rao : missing;
        uint256 unlisted;
        CascadeFormulas.requireGasFor(CascadeFormulas.WRITE_OFF_READ_GAS);
        try STAKING.getTotalColdkeyStakeOnSubnet{gas: CascadeFormulas.WRITE_OFF_READ_GAS}(
            coldkey, NETUID_ROOT
        ) returns (
            uint256 total
        ) {
            unlisted = CascadeFormulas.unlistedStakeRao(total, visible);
        } catch {}
        // w <= missing <= booked: neither subtraction underflows
        unchecked {
            if (unlisted > missing - w) revert WriteOffTooLarge();
            ledger.booked = booked - w;
        }
        emit StakeWrittenOff(w);
    }

    // ---- rewards ----

    /// Claims `hotkey`'s root rewards and vests the measured increase of the whole position (stake
    /// across the set plus liquid balance, wherever the chain credits the claim) on top of what is still
    /// unvested of the claim schedule (the adoption drip is not touched), over the period the restart snapshots
    /// (_vest: rewardVesting, or longer to carry the remainder on its own schedule). It books the
    /// visible stake's rise, floored at 0 (spec §3.10.14): a claim paid as balance books nothing stake-side, and
    /// an unexpected fall books nothing and shows as missing stake rather than reverting the claim. The reward
    /// cut (rewardCutBps of the increase, floored) does not vest: it is minted to the treasury as csTAO at the
    /// price before the claim, rounded down, so the price is unchanged; while stake is missing (stakeMissing(),
    /// spec §3.1, I-1) before or after the claim, below half the launch price or while the vault is underwater
    /// it is skipped and vests with the rest. An empty claim leaves the schedules as they are. Keeper only, or
    /// anyone once KEEPER_FALLBACK has passed since this hotkey's last claim (or since it was first added) and the
    /// claim schedule holds nothing still vesting (R6b U1: a claim restarts the one schedule, so a stranger's claim of
    /// one small hotkey mid-schedule re-spread the rest of the others' rewards past their end; only the keeper's rounds
    /// restart a schedule that still vests), else NotKeeper. Works while paused. The chain can refuse a claim by burning the forwarded gas; the revert bubbles up and
    /// nothing changes.
    function claimRewards(bytes32 hotkey) external nonReentrant {
        if (!isHotkey[hotkey]) revert UnknownHotkey();
        _requireKeeperOrAfter(lastClaimAt[hotkey]);
        // the claim schedule before this claim, read once (the claim does not change it): the restart carries it, and
        // the cut's price reads it with the adoption drip (Revision 27: the restart carries the claim schedule's own
        // remainder, never the drip's). Only the keeper restarts a schedule that still holds rewards (R6b U1).
        uint256 own = _claimUnvested();
        if (own != 0 && msg.sender != keeper) revert NotKeeper();

        uint256 visibleBefore = visibleStakeRao();
        uint256 before = CascadeFormulas.positionWei(visibleBefore, address(this).balance);
        // checked after the measurement, right before the call it protects
        if (gasleft() < claimGasRequired) revert InsufficientGas();
        STAKING.claimRootWithHotkey(hotkey);
        uint256 visibleAfter = visibleStakeRao();
        uint256 delta = _sub0(CascadeFormulas.positionWei(visibleAfter, address(this).balance), before);
        lastClaimAt[hotkey] = uint64(block.timestamp);
        // stake missing before the claim, on the pair it read: its own booking can lift the tolerance past the gap
        bool missing = CascadeFormulas.stakeMissing(visibleBefore, ledger.booked, ledger.pending);
        ledger.booked += _sub0(visibleAfter, visibleBefore);
        uint256 fee = delta * rewardCutBps / 10_000;
        if (fee != 0) {
            // the price before this claim: the gross already counts delta, the old schedules do not
            uint256 unvested = own + _adoptionUnvested();
            uint256 grossBefore = _sub0(grossAssets(), delta);
            uint256 assetsBefore = CascadeFormulas.totalAssets(grossBefore, ledger.pending, unvested);
            uint256 supply = _shares.totalSupply;
            if (
                missing || CascadeFormulas.stakeMissing(visibleAfter, ledger.booked, ledger.pending)
                    || assetsBefore * 2_000_000 < supply
                    || CascadeFormulas.underwater(grossBefore, ledger.pending, unvested)
            ) {
                // A cut is a mint. While stake is missing (a hotkey swap moved it outside the set) the
                // price reads min(visible, booked), lowered by stake that is still the holders', so the cut
                // is skipped and vests with the rest (I-1). Below half the launch price (as for deposits)
                // too: minted at a price reading a loss, it could take most of the vault once the loss is
                // repaired. S == 0 never trips that line, so the cut is skipped underwater too (the gross
                // before this claim short of the queued payouts and the unvested rewards, assets reading 0):
                // its value would fill the hole.
                fee = 0;
            } else {
                address t = treasury;
                uint256 shares = CascadeMath.sharesForDeposit(fee, assetsBefore, supply);
                mintShares(_shares, t, shares);
                emit RewardCutMinted(t, fee, shares);
            }
        }
        // The cut does not vest, so the mint leaves the price as it was. Restarting on 0 would re-spread
        // the unvested remainder over a fresh period.
        if (delta - fee != 0) _vest(own + (delta - fee));
        emit RewardsClaimed(hotkey, delta / RAO);
    }

    // ---- direct access ----

    /// Mints csTAO for msg.value at the price before it. Refused while stake is missing (StakeMissing, spec
    /// §3.1, I-1: the price reads stake that is still the holders' as gone), below half the launch price or
    /// while the vault is underwater (VaultInsolvent; at a supply of 0, after the drips' write-down:
    /// _unvestedForMint), and above maxTotalAssets. Every direct deposit sets the caller's redeem origin to
    /// DIRECT_ORIGIN, whatever it was (spec §3.4, I-16): no front door burns its shares until it names a
    /// chain again (setRedeemOrigin), so a party at the same address on a door's chain cannot redeem them.
    function depositDirect() external payable whenNotPaused nonReentrant {
        uint256 assets = msg.value;
        if (assets % RAO != 0) revert NotRaoAligned();
        if (assets < minDirectDeposit) revert BelowMinDeposit();
        if (stakeMissing()) revert StakeMissing();
        uint256 grossBefore = _sub0(grossAssets(), assets);
        uint256 supply = _shares.totalSupply;
        uint256 unvested = _unvestedForMint(grossBefore, supply);
        uint256 assetsBefore = CascadeFormulas.totalAssets(grossBefore, ledger.pending, unvested);
        // Below half the launch price (1e-6 TAO per share) assets were lost; minting there would hand
        // this deposit much of the vault. A supply of 0 never trips that line, so an underwater vault (the
        // gross before this deposit short of the queued payouts and the unvested rewards, assets reading
        // 0) is refused too: this deposit would fill the hole. There the drips have just been written down
        // to what the gross holds beyond the payouts, so only a payout shortfall past the tolerance remains.
        if (assetsBefore * 2_000_000 < supply || CascadeFormulas.underwater(grossBefore, ledger.pending, unvested)) {
            revert VaultInsolvent();
        }
        if (assetsBefore + assets > maxTotalAssets) revert CapExceeded();
        holders[msg.sender].origin = DIRECT_ORIGIN;
        uint256 shares = CascadeMath.sharesForDeposit(assets, assetsBefore, supply);
        mintShares(_shares, msg.sender, shares);
        // fresh for a day (spec §3.5, R4 B-H1): no front door burns them before, even once the holder names a door's chain
        addFresh(holders, msg.sender, shares);
        emit DepositedDirect(msg.sender, assets, shares);
    }

    /// Sets the caller's redeem origin (spec §3.4): `chain`, whose front doors then burn its shares and only
    /// theirs, which needs an active door there now (activeDoors), else UnknownOrigin (chain 0 never has one);
    /// or DIRECT_ORIGIN, which no door burns for (redeemDirect pays it). Any address, with shares or none: so
    /// a holder whose shares came only from the reward cut (origin 0, which a rogue door could claim with a
    /// deposit ahead of a redeem in one batch) names one, the treasury DIRECT_ORIGIN right after deploy, and a
    /// fresh address can claim its origin first. A door's later removal changes no origin. Works while paused: it moves nothing, it is
    /// the holder's own routing, and deliveries revert while paused anyway. Logs RedeemOriginSet, the one event of an
    /// origin change (a door's first mint of non-zero assets and depositDirect set it as their Deposited and
    /// DepositedDirect show).
    function setRedeemOrigin(uint64 chain) external {
        if (chain != DIRECT_ORIGIN && activeDoors[chain] == 0) revert UnknownOrigin();
        holders[msg.sender].origin = chain;
        emit RedeemOriginSet(msg.sender, chain);
    }

    /// Burns `shares` and pays their value to the caller, less what its exit costs, unstaking any shortfall. No
    /// outflow cap: the share owner signs on this chain. Never held, it lowers the caller's fresh shares to the balance
    /// it leaves (spec §3.5, I-36, R6 A), so freshOf never exceeds a balance and no share gone here weighs in a later
    /// mint's share-weighted clock (addFresh): a deposit and a direct exit repeated in one block cannot shorten a later
    /// deposit's door hold. While stake is missing it reverts StakeMissing unless
    /// `acceptMissing`, the caller's consent to be paid at min(visible, booked), the floor price, which the stayers
    /// never pay for (spec §3.1, I-1). RedeemedDirect's acceptedMissing is true only when the exit was priced while
    /// stake was missing (past the revert, that implies the consent).
    /// The leaver pays (spec §3.3, the founder's ruling of 2026-11-06; round 8 H-1): the liquid balance above
    /// ED_RESERVE and the queued payouts is read once, before the walk; when it does not cover the exit's value, the
    /// walk asks for the difference and may leave at most SHORTFALL_TOLERANCE_RAO of it untaken (else UnstakeShort).
    /// The leaver bears what is unmet and the walk's cost (what the chain kept of the stake it took, rounded up to
    /// rao): paid the value less both, floored to rao, with ShortfallAbsorbed when they are non-zero, so the holders
    /// who stay pay nothing for the exit (I-13, I-35). An exit that would be paid nothing reverts ZeroAmount and keeps
    /// its shares. Simulate it first (eth_call): the walk runs in the call, so the simulation returns the exact pay.
    /// RedeemedDirect's `assets` is what was paid.
    function redeemDirect(uint256 shares, bool acceptMissing) external whenNotPaused nonReentrant {
        bool missing = stakeMissing();
        if (missing && !acceptMissing) revert StakeMissing();
        uint256 out = CascadeMath.assetsForRedeem(shares, totalAssets(), _shares.totalSupply);
        out -= out % RAO;
        // Also covers shares == 0.
        if (out == 0) revert ZeroAmount();
        burnShares(_shares, msg.sender, shares);
        // the door hold's bucket follows the balance down (R6 A): a share gone here never weighs in a later mint's clock
        Holder storage h = holders[msg.sender];
        uint256 left = _shares.balanceOf[msg.sender];
        // casting to 'uint128' is safe because left < h.fresh, a uint128
        // forge-lint: disable-next-line(unsafe-typecast)
        if (h.fresh > left) h.fresh = uint128(left);
        // Read once, before the walk: an under-delivering unstake must never be paid from ED_RESERVE or queued
        // payouts, and a payout's still-staked reservation is neither cover nor needed as cover.
        uint256 available = _available();
        uint256 unmet;
        uint256 cost;
        // unmet at most SHORTFALL_TOLERANCE_RAO (_unstake reverts UnstakeShort past it); cost what the chain kept
        if (available < out) (unmet,, cost) = _unstake(out - available);
        // the leaver bears its exit's whole cost: what the walk left untaken and what the chain kept
        uint256 borne = unmet + cost;
        uint256 paid = _sub0(out, borne);
        paid -= paid % RAO;
        // an exit its own cost leaves nothing is refused, never subsidised: it keeps its shares
        if (paid == 0) revert ZeroAmount();
        if (borne != 0) emit ShortfallAbsorbed(borne);
        (bool ok,) = msg.sender.call{value: paid}("");
        if (!ok) revert TransferFailed();
        emit RedeemedDirect(msg.sender, shares, paid, missing);
    }

    // ---- bridge delivery ----

    function batchKey(uint64 sourceChain, address sender, bytes calldata message) internal pure returns (bytes32) {
        return CascadeFormulas.batchKey(sourceChain, sender, message);
    }

    /// Delivers a front door's BATCH with its deposits' TAO. Prices every entry at one price fixed
    /// before the batch (A = assets without this delivery, S = supply), mints for deposits, then burns
    /// for redeems within the front door's daily allowance and all doors' together (the global window, Task 17;
    /// both measured on the root stake that has ramped in) and queues their payouts. Below half the launch
    /// price (which, with shares outstanding, an underwater vault always is), deposits are not minted but
    /// bounced, and so is a deposit for an address whose redeem origin is another chain's (Task 18): queued back
    /// to the front door ahead of the redeems, as entries with 0 shares. A redeem burns only for a holder of the
    /// door's chain (origin by chain, spec §3.4; a door's first mint for an address of origin 0 sets it there);
    /// any other is skipped. No per-entry condition reverts the batch. Reverts while paused so the rail holds the
    /// money, while stake is missing (StakeMissing, spec §3.1, I-1: its deposits would mint and its redeems burn at
    /// a price lowered by stake that is still the holders'), and at a supply of 0 while the vault is underwater
    /// (VaultInsolvent, after the drips' write-down, _unvestedForMint, which the revert undoes: a bounce's
    /// TAO, reserved, would fill the hole for an older queued payout; no redeem can burn there), so the adapter
    /// parks the batch whole (spec §3.2, Revision 22). No staking or claiming here.
    /// The vault runs the checks (the bridge, the pause, the peer, the missing stake, the value, the replay
    /// record) and reads the stake, the price inputs and the allowance base once; the batch library (L1,
    /// CascadeBatchLib, by DELEGATECALL) decodes the message, checks its sum, logs BatchDelivered, mints or
    /// bounces (writing the redeem origins), burns within both windows and returns the queue, which the vault
    /// stores with its reservation (spec §8.1).
    function onBridgeMessage(uint64 sourceChain, address sender, bytes calldata message, uint256 amount)
        external
        payable
        nonReentrant
    {
        // whenNotPaused, checked after the bridge
        _requireBridge();
        _requireNotPaused();
        bytes32 peer = peerId(sourceChain, sender);
        if (doorState[peer] != DoorState.Active) revert UnknownPeer();
        // one read of the stake for the whole delivery: the guard, then the price and the base
        uint256 visible = visibleStakeRao();
        uint256 booked = ledger.booked;
        if (CascadeFormulas.stakeMissing(visible, booked, ledger.pending)) revert StakeMissing();
        if (msg.value != amount) revert ValueMismatch();
        bytes32 key = batchKey(sourceChain, sender, message);
        // a replay reverts here, before L1 sums the deposits (ruling DA2: a replayed message with a wrong
        // amount reverts DuplicateBatch, where v3.1 reverted AmountMismatch)
        if (processed[key]) revert DuplicateBatch();
        processed[key] = true;

        // A is totalAssets() without this delivery's credited value
        uint256 priced = CascadeFormulas.pricedStakeRao(visible, booked);
        uint256 grossBefore = _sub0(
            CascadeFormulas.grossAssets(CascadeFormulas.positionWei(priced, address(this).balance)),
            msg.value - msg.value % RAO
        );
        uint256 S = _shares.totalSupply;
        uint256 unvested = _unvestedForMint(grossBefore, S);
        uint256 A = CascadeFormulas.totalAssets(grossBefore, ledger.pending, unvested);
        // At a supply of 0, underwater (the gross before this delivery short of the queued payouts and the unvested
        // rewards; after the write-down, a payout shortfall past the tolerance) the half-launch line reads 0 < 0, and
        // a bounce's TAO, reserved, would fill the hole for an older queued payout paid first: the batch reverts
        // whole (its write-down with it) and the adapter parks it. No redeem can burn at a supply of 0.
        if (S == 0 && CascadeFormulas.underwater(grossBefore, ledger.pending, unvested)) revert VaultInsolvent();
        PayoutBatch memory b = CascadeBatchLib.deliver(
            _shares,
            burnWindows,
            holders,
            BatchIn({
                key: key,
                peer: peer,
                sourceChain: sourceChain,
                sender: sender,
                amount: amount,
                A: A,
                S: S,
                // Below half the launch price (1e-6 TAO per share) assets were lost; minting there would
                // hand these deposits much of the vault, so they bounce instead. Underwater they would fill the
                // hole, and the line refuses that too: here S != 0 (at S == 0 the batch reverted above), and
                // underwater A reads 0. Redeems still burn, so exits keep working in a broken vault.
                insolvent: A * 2_000_000 < S,
                // The outflow allowance's base (I-5): the priced stake, min(visible, booked), in wei (liquid
                // TAO, such as this or an earlier delivery's deposits or a direct deposit, never counts), less
                // what is still ramping in over STAKE_RAMP.
                base: _sub0(priced * RAO, _unspent(ledger.ramping, lastStakeAt, STAKE_RAMP)),
                maxEntryValue: maxEntryValue,
                maxDailyOutflowBps: maxDailyOutflowBps,
                minDailyOutflow: minDailyOutflow,
                globalOutflowBps: globalOutflowBps,
                // S-H1 (R4): while the primary bridge cannot send payouts (disabled, R6 D, or its rail closed), no
                // door redeem burns
                payoutsOpen: _payoutsOpen()
            }),
            message
        );
        if (b.remaining != 0) {
            b.queuedAt = uint64(block.timestamp);
            payoutBatches[key] = b;
            ledger.pending += b.remaining;
            emit PayoutBatchQueued(key, sourceChain, b.batchId, b.count, b.remaining, CascadeMath.price(A, S));
        }
    }

    // ---- payouts ----

    /// Sends the next chunk of batch `key` to its front door through the primary bridge, once
    /// payoutDelay has passed. `payouts` is the batch's full ordered list, rebuilt from its
    /// DepositBounced and Redeemed events in log order. Permissionless; only the keeper's `maxEntries`
    /// counts, anyone else sends the largest chunk that fits. The fee valve (spec §3.3): each entry pays its
    /// share of the bridge fee, at most the ceiling in all, and is floored to rao; a bounced deposit left with
    /// nothing is PayoutDust and stays in the vault, and an entry with shares left with nothing reverts
    /// FeeTooHigh. A fee above the ceiling is the caller's to top up with the call's value, which must be whole
    /// rao (BadValue), FeeTooHigh while short; the rest of the value comes back to the caller, last, and none of it
    /// counts as the chunk's liquidity (I-12). When the chunk walks, its entries also bear the walk's cost (what the
    /// chain kept of the stake it took), pro rata like the fee, a bounce included, never the holders or the caller;
    /// a cost that would leave an entry nothing reverts FeeTooHigh (the chunk is paid once liquid TAO covers it
    /// without a walk). No staking here.
    /// The vault keeps the pause and the lock, reads what the payout engine needs (PayoutIn, the call's value
    /// with it) and runs the engine (L3, CascadePayoutLib, by DELEGATECALL) in two halves around the walk, which
    /// it runs itself: L3's `prepare` makes v3.1's checks, takes the chunk, quotes and splits the fee and logs the
    /// dust, writing nothing; the vault unstakes what the liquid balance does not cover (L2, under its transient
    /// unstake flag, which no library can set); L3's `finish` applies the effects, then sends, then logs
    /// PayoutChunkSent, then refunds. So v3.1's order holds, and the flag is never set across a bridge call or the
    /// refund (spec §8.1; the 5g ruling).
    function processPayouts(bytes32 key, CascadeMessages.Payout[] calldata payouts, uint32 maxEntries)
        external
        payable
        whenNotPaused
        nonReentrant
    {
        PayoutIn memory input = _payoutIn(key);
        PayoutPlan memory plan = CascadePayoutLib.prepare(key, payouts, maxEntries, input);
        // 3. the walk, the vault's own (spec §3.3, round 8 H-1): prepare read the liquidity once, before it, less the
        // caller's value. The walk asks need - free + SHORTFALL_TOLERANCE_RAO and may leave at most that tolerance of
        // stake untaken (else UnstakeShort, _unstake's check); what it received and what the chain kept of the stake it
        // took (its cost, the chunk's entries' to bear) go to finish, which splits the cost and checks that free and
        // the receipts fund what is sent, never ED_RESERVE or another batch's reservation. The cushion stays idle.
        if (plan.shortfall != 0) {
            (, plan.received, plan.cost) = _unstake(plan.shortfall + SHORTFALL_TOLERANCE_RAO * RAO);
        }
        CascadePayoutLib.finish(payoutBatches, ledger, key, payouts, input, plan);
    }

    /// Undoes the unsent redeems of batch `key`: re-mints each one the value it is owed, never more shares than it
    /// burned (the shares its value buys at the price before the cancel, this vault's totalAssets() over the supply,
    /// both read once, before anything is released; Task 34c), and releases its whole reservation. Chunks already
    /// sent stay sent; the front door's burn window is not restored. A bounced deposit has no shares and is owed its
    /// TAO (I-19), so the remaining bounces are carried forward, in order, as the batch's new list (still reserved, its
    /// queuedAt and chunk numbering kept: the last `bouncesCarried` of its DepositBounced entries, spec §3.10.15), for
    /// processPayouts; with none, the batch is deleted, and with nothing to re-mint the cancel reverts NothingToCancel.
    /// Owner only; works while paused and after the front door was removed. The vault keeps the owner check and the
    /// lock and passes its totalAssets() in; L3 (CascadePayoutLib.cancel) checks the list, reads the supply, re-mints,
    /// releases and carries, and returns the batch's source chain: the cancel of a launch-chain door's batch is an
    /// instrument, stamping the owner's clock (spec §3.6 row 5: a point closure, nothing recorded); any other records
    /// and stamps nothing, and a cancel that reverts (NothingToCancel among them) stamps nothing.
    function cancelPayoutBatch(bytes32 key, CascadeMessages.Payout[] calldata payouts) external onlyOwner nonReentrant {
        if (CascadePayoutLib.cancel(_shares, payoutBatches, ledger, key, payouts, totalAssets()) == launchChain) {
            _stamp(Actor.Owner);
            emit ExitsClosed(msg.sender, this.cancelPayoutBatch.selector);
        }
    }

    // ---- admin: parameters ----
    // Each setter runs the internal function below it (its check, its write and its event), which the
    // constructor runs on its Params too, so no constructor can set what no setter could.

    /// address(0) leaves only the permissionless fallback.
    function setKeeper(address newKeeper) external onlyOwner {
        _setKeeper(newKeeper);
    }

    function _setKeeper(address newKeeper) internal {
        keeper = newKeeper;
        emit KeeperSet(newKeeper);
    }

    function setMinDirectDeposit(uint256 amount) external onlyOwner {
        _setMinDirectDeposit(amount);
    }

    function _setMinDirectDeposit(uint256 amount) internal {
        minDirectDeposit = amount;
        emit LimitSet(this.setMinDirectDeposit.selector, amount, 0);
    }

    /// Up loosens: scheduled (spec §3.6); down, or the same, at once.
    function setMaxTotalAssets(uint256 amount) external onlyOwner {
        _requireScheduledIfLoosens(amount > maxTotalAssets);
        _setMaxTotalAssets(amount);
    }

    function _setMaxTotalAssets(uint256 amount) internal {
        maxTotalAssets = amount;
        emit LimitSet(this.setMaxTotalAssets.selector, amount, 0);
    }

    /// The front doors' daily allowances (spec §3.4, Task 17): each door may burn `bps` of the base a day and all
    /// doors together `globalBps` of it, each at least `minDaily`, the floor both share. Both percentages are
    /// bounded to MIN_OUTFLOW_BPS..MAX_OUTFLOW_BPS (20% to 50%) and the floor to
    /// MIN_MIN_DAILY_OUTFLOW..MAX_MIN_DAILY_OUTFLOW (10 to 100 TAO), so no setting can freeze a front-door exit.
    /// Any of the three up loosens: scheduled (spec §3.6); none up, at once. Logs OutflowLimitsSet.
    function setOutflowLimits(uint256 bps, uint256 minDaily, uint256 globalBps) external onlyOwner {
        _requireScheduledIfLoosens(
            bps > maxDailyOutflowBps || minDaily > minDailyOutflow || globalBps > globalOutflowBps
        );
        _setOutflowLimits(bps, minDaily, globalBps);
    }

    function _setOutflowLimits(uint256 bps, uint256 minDaily, uint256 globalBps) internal {
        if (
            bps < MIN_OUTFLOW_BPS || bps > MAX_OUTFLOW_BPS || globalBps < MIN_OUTFLOW_BPS || globalBps > MAX_OUTFLOW_BPS
                || minDaily < MIN_MIN_DAILY_OUTFLOW || minDaily > MAX_MIN_DAILY_OUTFLOW
        ) revert InvalidParameter();
        maxDailyOutflowBps = bps;
        minDailyOutflow = minDaily;
        globalOutflowBps = globalBps;
        emit OutflowLimitsSet(bps, minDaily, globalBps);
    }

    /// MIN_ENTRY_VALUE (10 TAO) <= maxEntryValue <= maxMessageValue <= MAX_MESSAGE_VALUE (the lane's 5,000 TAO), and
    /// minChunk 1 to MAX_ENTRIES (50), else InvalidParameter; maxMessageValue also at most the primary bridge's
    /// maxMessageValue(), else AboveBridgeCap (spec §3.9; setPrimaryBridge checks a new primary against it). Either
    /// value up, or minChunk down, loosens: scheduled (spec §3.6).
    function setMessageLimits(uint256 maxEntryValue_, uint256 maxMessageValue_, uint32 minChunk_) external onlyOwner {
        _requireScheduledIfLoosens(
            maxEntryValue_ > maxEntryValue || maxMessageValue_ > maxMessageValue || minChunk_ < minChunk
        );
        _setMessageLimits(maxEntryValue_, maxMessageValue_, minChunk_);
    }

    function _setMessageLimits(uint256 maxEntryValue_, uint256 maxMessageValue_, uint32 minChunk_) internal {
        if (
            maxEntryValue_ < MIN_ENTRY_VALUE || maxEntryValue_ > maxMessageValue_
                || maxMessageValue_ > MAX_MESSAGE_VALUE || minChunk_ == 0 || minChunk_ > CascadeMessages.MAX_ENTRIES
        ) revert InvalidParameter();
        _requireBridgeCap(primaryBridge, maxMessageValue_);
        maxEntryValue = maxEntryValue_;
        maxMessageValue = maxMessageValue_;
        minChunk = minChunk_;
        // three values: two events under the one selector, (first, second) then (third, 0) (ruling DA7)
        emit LimitSet(this.setMessageLimits.selector, maxEntryValue_, maxMessageValue_);
        emit LimitSet(this.setMessageLimits.selector, minChunk_, 0);
    }

    /// setPrimaryBridge's cap check (CascadeBase): maxMessageValue within the new primary's maxMessageValue(), else
    /// AboveBridgeCap (spec §3.9). A bridge with a smaller cap becomes primary once the owner has tightened to it.
    function _checkBridgeCaps(address bridge) internal view override {
        _requireBridgeCap(bridge, maxMessageValue);
    }

    /// The payout fee ceiling, the most a chunk's entries are charged of its bridge fee: the larger of `bps` of the
    /// chunk, at most MAX_FEE_BPS (5%), and `abs_`, in [MIN_FEE_ABS, MAX_FEE_ABS] (0.01 to 0.015 TAO; spec §3.3).
    /// Either up loosens: scheduled (spec §3.6).
    function setFeeLimits(uint256 bps, uint256 abs_) external onlyOwner {
        _requireScheduledIfLoosens(bps > maxFeeBps || abs_ > maxFeeAbs);
        _setFeeLimits(bps, abs_);
    }

    function _setFeeLimits(uint256 bps, uint256 abs_) internal {
        if (bps > MAX_FEE_BPS || abs_ < MIN_FEE_ABS || abs_ > MAX_FEE_ABS) revert InvalidParameter();
        maxFeeBps = bps;
        maxFeeAbs = abs_;
        emit LimitSet(this.setFeeLimits.selector, bps, abs_);
    }

    /// MIN_PAYOUT_DELAY (1 hour) to MAX_PAYOUT_DELAY (48 hours; Appendix B): the guardian's window to hold a rogue
    /// batch, never so long that it holds honest exits for days. Down loosens: scheduled (spec §3.6).
    function setPayoutDelay(uint64 delay) external onlyOwner {
        _requireScheduledIfLoosens(delay < payoutDelay);
        _setPayoutDelay(delay);
    }

    function _setPayoutDelay(uint64 delay) internal {
        if (delay < MIN_PAYOUT_DELAY || delay > MAX_PAYOUT_DELAY) revert InvalidParameter();
        payoutDelay = delay;
        emit LimitSet(this.setPayoutDelay.selector, delay, 0);
    }

    /// The treasury and its cut of each claim, in bps, at most MAX_REWARD_CUT_BPS. A zero treasury
    /// is allowed only with a zero cut. The cut up, or any change of treasury, loosens: scheduled (spec §3.6).
    function setRewardCut(address treasury_, uint16 bps) external onlyOwner {
        _requireScheduledIfLoosens(bps > rewardCutBps || treasury_ != treasury);
        _setRewardCut(treasury_, bps);
    }

    function _setRewardCut(address treasury_, uint16 bps) internal {
        if (bps > MAX_REWARD_CUT_BPS) revert FeeTooHigh();
        if (treasury_ == address(0) && bps != 0) revert ZeroAddress();
        treasury = treasury_;
        rewardCutBps = bps;
        emit RewardCutSet(treasury_, bps);
    }

    /// The period claimed rewards and adopted surplus vest over: 1 to 30 days. Down loosens (rewards reach the price
    /// sooner, which weakens what vesting guards against, a deposit timed around a claim): scheduled (spec §3.6). A
    /// change applies from each drip's next restart (_restartPeriod); a carried remainder never vests faster than its
    /// own schedule.
    function setRewardVesting(uint64 period) external onlyOwner {
        _requireScheduledIfLoosens(period < rewardVesting);
        _setRewardVesting(period);
    }

    function _setRewardVesting(uint64 period) internal {
        // outside 1 to 30 days: below a day the unchecked subtraction wraps far above 29 days
        unchecked {
            if (period - 1 days > 29 days) revert InvalidParameter();
        }
        rewardVesting = period;
        emit LimitSet(this.setRewardVesting.selector, period, 0);
    }

    /// The gas claimRewards requires left before its claim: MIN_CLAIM_GAS (54.1M: the call forwards 63/64 of the gas
    /// left, so the 53.2M claimRootWithHotkey needs takes about 54.03M left; the mainnet canary measures a real claim)
    /// to MAX_CLAIM_GAS (63.4M, the most whose claim fits Bittensor's per-transaction limit, about 65,000,000: 75% of the
    /// block less 10% for initialization; spec §3.9, round 9 L-3, Task 65), so no setting lets a claim start short of
    /// what the chain needs, or need more than one transaction can carry. Immediate both ways within them, and no
    /// instrument: it decides only whether a claim starts.
    function setClaimGasRequired(uint256 gasRequired) external onlyOwner {
        _setClaimGasRequired(gasRequired);
    }

    function _setClaimGasRequired(uint256 gasRequired) internal {
        // outside the bounds: below MIN_CLAIM_GAS the unchecked subtraction wraps far above the span
        unchecked {
            if (gasRequired - MIN_CLAIM_GAS > MAX_CLAIM_GAS - MIN_CLAIM_GAS) revert InvalidParameter();
        }
        claimGasRequired = gasRequired;
        emit ClaimGasSet(gasRequired);
    }

    /// At most MAX_HOTKEY_DUST_RAO (the Task 14a carry): the removal's dust check, hotkeyDustRao * RAO, never overflows,
    /// so no owner value can block a removal, the stranger's among them (I-6). Immediate both ways.
    function setHotkeyDustRao(uint256 rao) external onlyOwner {
        _setHotkeyDustRao(rao);
    }

    function _setHotkeyDustRao(uint256 rao) internal {
        if (rao > MAX_HOTKEY_DUST_RAO) revert InvalidParameter();
        hotkeyDustRao = rao;
        emit LimitSet(this.setHotkeyDustRao.selector, rao, 0);
    }

    /// At most MAX_UNSTAKE_MARGIN_RAO (1 TAO) per removal.
    function setUnstakeMarginRao(uint256 rao) external onlyOwner {
        _setUnstakeMarginRao(rao);
    }

    function _setUnstakeMarginRao(uint256 rao) internal {
        if (rao > MAX_UNSTAKE_MARGIN_RAO) revert InvalidParameter();
        unstakeMarginRao = rao;
        emit LimitSet(this.setUnstakeMarginRao.selector, rao, 0);
    }

    /// The least gas the unstake walk forwards to each removal (spec §3.8): MIN_UNSTAKE_GAS to MAX_UNSTAKE_GAS (150,000
    /// to 5,000,000). Immediate both ways, and no instrument (spec §3.6): it is a floor on what each removal gets, and
    /// whatever it is, the walk still tries every position. The walk keeps EXIT_GAS_RESERVE while each share of what is
    /// above it exceeds this floor; below that, removals that burn their gas can eat the reserve and the exit reverts
    /// out of gas, whole (README: the caller's gas limit).
    function setUnstakeGas(uint256 gas) external onlyOwner {
        _setUnstakeGas(gas);
    }

    function _setUnstakeGas(uint256 gas) internal {
        // outside the bounds: below MIN_UNSTAKE_GAS the unchecked subtraction wraps far above the span
        unchecked {
            if (gas - MIN_UNSTAKE_GAS > MAX_UNSTAKE_GAS - MIN_UNSTAKE_GAS) revert InvalidParameter();
        }
        unstakeGas = gas;
        emit LimitSet(this.setUnstakeGas.selector, gas, 0);
    }

    /// The idle buffer (spec §3.8), in bps of the booked stake, at most MAX_IDLE_BUFFER_BPS (10%): stakeIdle leaves it
    /// liquid, so exits need no unstake while it lasts, the answer to a root hold on every pair (_idleBuffer). Up, or
    /// the same, at once; down loosens (less kept for exits): scheduled (the Param class, 48 hours; spec §3.6). Once
    /// the monitor reports a non-zero RootStakeUnlockInterval, the owner raises it so the buffer covers the queued
    /// payouts and a day's floor. `bps` is taken as a word and bounded before it is stored in its uint16 (a uint16
    /// argument's decoder check costs the vault bytes it does not have to spare; Task 20's size budget).
    function setIdleBuffer(uint256 bps) external onlyOwner {
        _requireScheduledIfLoosens(bps < idleBufferBps);
        _setIdleBuffer(bps);
    }

    function _setIdleBuffer(uint256 bps) internal {
        if (bps > MAX_IDLE_BUFFER_BPS) revert InvalidParameter();
        // casting to 'uint16' is safe: at most MAX_IDLE_BUFFER_BPS, checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        idleBufferBps = uint16(bps);
        emit LimitSet(this.setIdleBuffer.selector, bps, 0);
    }

    // ---- receive ----

    /// Value arrives only through depositDirect, a batch delivery, or an unstake in progress.
    receive() external payable {
        if (!_unstaking) revert DirectTransferNotAllowed();
    }

    // ---- internal ----

    /// Whether the primary bridge can send payouts now (spec §3.5, R4 S-H1): false while the vault has it disabled (R6
    /// D: processPayouts refuses PrimaryBridgeDisabled then, and the disabled adapter's own view cannot see the vault's
    /// disable, so a batch delivered through another enabled bridge mid-replacement would burn into a queue nothing could
    /// send), else its own canSendPayouts(), read by a plain staticcall capped at RAIL_VIEW_GAS. Fail-open: a call that
    /// fails or answers anything but one word reads open. That is the one open path, and only an enabled primary bridge
    /// with no such view reaches it (the R4 review): the Bittensor adapter's view never reverts and fits the cap (each of
    /// its three AlphaVault reads fails to false within RAIL_READ_GAS), answering false from ForeverMoney's migration
    /// notice and during its pause, when no payout could be sent; a delivery too short of gas to give it the cap could
    /// not finish anyway.
    function _payoutsOpen() internal view returns (bool) {
        address p = primaryBridge;
        if (!bridgeEnabled[p]) return false;
        // capped (RAIL_VIEW_GAS), so a bridge's view that burns its gas cannot starve the delivery it runs in
        (bool ok, bytes memory ret) = p.staticcall{gas: RAIL_VIEW_GAS}(abi.encodeWithSignature("canSendPayouts()"));
        return !ok || ret.length != 32 || abi.decode(ret, (uint256)) != 0;
    }

    /// a - b, floored at 0 (CascadeFormulas.sub0).
    function _sub0(uint256 a, uint256 b) internal pure returns (uint256) {
        return CascadeFormulas.sub0(a, b);
    }

    /// What is left of `amount` spent linearly over `period` from `start` (unvested rewards, ramping
    /// stake; CascadeFormulas.unspent).
    function _unspent(uint256 amount, uint64 start, uint256 period) internal view returns (uint256) {
        return CascadeFormulas.unspent(amount, start, period);
    }

    /// The vault's root stake on `h`, in rao.
    function _stakeOf(bytes32 h) internal view returns (uint256) {
        return CascadeFormulas.stakeOf(h, coldkey);
    }

    /// NotKeeper unless the caller is the keeper or KEEPER_FALLBACK has passed since `since` (a timestamp: the last
    /// stake, the hotkey's last claim, the last adoption, or the deploy): the permissionless fallback of stakeIdle,
    /// claimRewards and adoptStake, in one place.
    function _requireKeeperOrAfter(uint256 since) internal view {
        // no overflow: a timestamp plus a week
        unchecked {
            // forge-lint: disable-next-line(block-timestamp)
            if (msg.sender != keeper && block.timestamp < since + KEEPER_FALLBACK) revert NotKeeper();
        }
    }

    /// Liquid balance above the existential reserve and queued payouts, floored at 0, in wei.
    function _available() internal view returns (uint256) {
        return _sub0(_sub0(address(this).balance, ED_RESERVE), ledger.pending);
    }

    /// The idle buffer, in wei (spec §3.8): what stakeIdle leaves liquid beyond ED_RESERVE and the queued payouts, so
    /// exits need no unstake while it lasts, even with every pair under a root hold. 0 at idleBufferBps 0; otherwise
    /// idleBufferBps of the booked stake, at least minDailyOutflow (a day's floor). Exits spend it like any liquid TAO,
    /// and the vault never unstakes to refill it.
    function _idleBuffer() internal view returns (uint256) {
        uint256 bps = idleBufferBps;
        if (bps == 0) return 0;
        // booked (rao) * RAO * bps / 10_000, exactly: RAO is a multiple of 10_000. No overflow: the booked stake is rao
        // the chain measured (at most its 21M TAO, about 2.1e16), times at most 1,000 and 1e5
        unchecked {
            uint256 share = ledger.booked * bps * (RAO / 10_000);
            uint256 floor = minDailyOutflow;
            return share > floor ? share : floor;
        }
    }

    /// What L3 needs for a payout of batch `key` (PayoutIn), read before it runs: the batch as stored (all zero
    /// for an unknown key, which L3 refuses with NotPending) and the reservation, as memory copies; the primary
    /// bridge and whether it is enabled (`_primary`'s check, which L3 makes in v3.1's place: after the batch,
    /// the delay and the door); whether the batch's front door is active; whether the caller is the keeper (the
    /// chunk size is the keeper's alone); the call's value (the fee valve's top-up, which no library reads itself);
    /// and the payout limits. Reading them first changes no result: none is written before L3's `finish`.
    function _payoutIn(bytes32 key) internal view returns (PayoutIn memory) {
        PayoutBatch memory b = payoutBatches[key];
        address primary = primaryBridge;
        return PayoutIn({
            batch: b,
            pending: ledger.pending,
            bridge: ICascadeBridge(primary),
            bridgeEnabled: bridgeEnabled[primary],
            doorActive: doorState[peerId(b.sourceChain, b.frontDoor)] == DoorState.Active,
            isKeeper: msg.sender == keeper,
            value: msg.value,
            payoutDelay: payoutDelay,
            minChunk: minChunk,
            maxMessageValue: maxMessageValue,
            maxFeeBps: maxFeeBps,
            maxFeeAbs: maxFeeAbs
        });
    }

    /// The unvested rewards a deposit reads (both drips), at supply `supply`, `grossBefore` being the gross before its
    /// money (spec §3.1, Task 15). At a supply of 0 they are no holder's: when a loss has left them above what the
    /// gross holds beyond the queued payouts, both drips are first written down to exactly that in all (Revision 27):
    /// the adoption drip to what that holds beyond the claim schedule (_vestAdoption), then, when the claim schedule
    /// alone is above it, the claim schedule to it (_vest), each restarting there by its own rule, so neither vests
    /// faster than its own schedule. So a deposit there is underwater only while the payouts themselves are short past
    /// the tolerance, and a hole in the schedules no longer refuses deposits until it vests away. With shares
    /// outstanding they are the holders' and are never written down. Logs nothing; depositDirect and the delivery call
    /// it before their underwater check.
    function _unvestedForMint(uint256 grossBefore, uint256 supply) internal returns (uint256 unvested) {
        uint256 own = _claimUnvested();
        unvested = own + _adoptionUnvested();
        if (supply == 0) {
            uint256 cover = _sub0(grossBefore, ledger.pending);
            if (unvested > cover) {
                _vestAdoption(_sub0(cover, own));
                if (own > cover) _vest(cover);
                unvested = cover;
            }
        }
    }

    /// Restarts the claim schedule on `amount` from now (ruling B7b): a claim's (what is still unvested of it, plus
    /// the claim less the cut) and the write-down at a supply of 0 (_unvestedForMint); never an adoption's, which
    /// restarts its own drip (_vestAdoption, Revision 27). It snapshots _restartPeriod's period. A remainder it
    /// carries is read under the old period first, so a restart never steps the price.
    function _vest(uint256 amount) internal {
        vestingPeriod = _restartPeriod(uint256(vestingStart) + vestingPeriod);
        vestingStart = uint64(block.timestamp);
        vestingAmount = amount;
    }

    /// Restarts the adoption drip on `amount` from now, by the claim schedule's rule (Revision 27): an adoption's (what
    /// is still unvested of it, plus the surplus) and the write-down at a supply of 0 (_unvestedForMint). The claim
    /// schedule is not touched, so an adoption never pushes the claimed rewards later. What is left of the fifth
    /// residual (spec 3.5): within the drip, an adoption re-spreads what is left of it over the longer of rewardVesting
    /// and what it has left, so anyone (KEEPER_FALLBACK after the last adoption, with a surplus of at least the chain's
    /// minimum stake) can push up to a quarter of the drip later, for a timed entrant to share. That value is adopted
    /// surplus: a gift, or stake that came back after a write-off (former holders' principal); never a claimed reward.
    function _vestAdoption(uint256 amount) internal {
        adoptVestingPeriod = _restartPeriod(uint256(adoptVestingStart) + adoptVestingPeriod);
        adoptVestingStart = uint64(block.timestamp);
        adoptVestingAmount = amount;
    }

    /// The period a restart of a drip ending at `end` snapshots (ruling B7b): the period in force, rewardVesting, or
    /// what is left of the old drip when that is longer, so a carried remainder never vests faster than its own
    /// schedule (after a decrease, the next restart does not release it within the new, shorter period; a fresh drip,
    /// with nothing left, takes rewardVesting).
    function _restartPeriod(uint256 end) internal view returns (uint64) {
        // no overflow or underflow: timestamps and periods (at most 30 days) are far below 2^64
        unchecked {
            uint256 period = rewardVesting;
            // a validator's few seconds of timestamp move the chosen period by those seconds at most
            // forge-lint: disable-next-line(block-timestamp)
            if (end > block.timestamp + period) period = end - block.timestamp;
            // casting to 'uint64' is safe: at most 30 days, the longest period any snapshot holds
            // forge-lint: disable-next-line(unsafe-typecast)
            return uint64(period);
        }
    }

    /// Stakes to `h`, a listed hotkey, from now on: setStakeHotkey's, and the constructor's, which lists its first
    /// hotkey first (through L4's add).
    function _setStakeHotkey(bytes32 h) internal {
        stakeHotkey = h;
        emit StakeHotkeySet(h);
    }

    /// Unstakes `wantWei` (when the stake allows), less at most the shortfall tolerance, through L2, the walk
    /// (CascadeStakeLib, by DELEGATECALL, on a memory copy of what it reads), which stops once what is unmet is
    /// within SHORTFALL_TOLERANCE_RAO (spec §3.10.11), with _unstaking set around the call so the precompile's TAO
    /// may enter receive(), and books the walk (CascadeLedger.applyWalk): the stake its removals took off their
    /// positions off the booked stake, what the balance received off the ramp. A removal the chain refuses (a root
    /// hold on the pair) or that burns its gas share is skipped (UnstakeSkipped, spec §3.8), and the walk goes on; it
    /// leaves EXIT_GAS_RESERVE for the work after it while each removal's share of what is above the reserve exceeds
    /// unstakeGas (below that, burning removals can eat the reserve and the exit reverts out of gas, whole). Reverts
    /// UnstakeShort when the stake the removals took, at face value, leaves more than SHORTFALL_TOLERANCE_RAO of
    /// `wantWei` unmet, every pair held included (retry later, or the idle buffer pays): both callers require `unmet
    /// <= T` (spec §3.3), so the rule is checked once, here.
    /// Returns what the walk left unmet (0 when covered; at most the tolerance, and at most `wantWei`), which
    /// redeemDirect's leaver bears, what it received (wei), and its cost: what the chain kept of the stake it took,
    /// that stake at face value less what was received, rounded up to rao (the vault's favour), which the exit bears
    /// (redeemDirect's leaver, a payout chunk's entries pro rata; spec §3.3, the founder's ruling of 2026-11-06).
    function _unstake(uint256 wantWei) internal returns (uint256 unmetWei, uint256 received, uint256 cost) {
        WalkParams memory p = _walkParams();
        uint256 debit;
        _unstaking = true;
        (unmetWei, received, debit) = CascadeStakeLib.unstake(p, wantWei);
        _unstaking = false;
        CascadeLedger.applyWalk(ledger, received, debit);
        if (unmetWei > SHORTFALL_TOLERANCE_RAO * RAO) revert UnstakeShort();
        // rounded up to rao; no overflow: debit is rao the chain measured
        cost = (_sub0(debit * RAO, received) + RAO - 1) / RAO * RAO;
    }

    /// What L2 needs for a walk and cannot read itself, built in one place for its callers (rulings DA1
    /// and DB13): the hotkey set copied to memory (at most MAX_HOTKEYS), the stake hotkey, the coldkey,
    /// the margin, the shortfall tolerance in wei and unstakeGas. L2 reads the floors (the live values against the
    /// constant fallbacks) and the stake at walk time.
    function _walkParams() internal view returns (WalkParams memory) {
        return WalkParams({
            hotkeys: hotkeys,
            first: stakeHotkey,
            coldkey: coldkey,
            margin: unstakeMarginRao,
            shortfallToleranceWei: SHORTFALL_TOLERANCE_RAO * RAO,
            unstakeGas: unstakeGas
        });
    }
}
