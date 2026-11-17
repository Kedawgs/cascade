// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CascadeBaseLens} from "./CascadeBaseLens.sol";
import {VaultLayout} from "./generated/VaultLayout.sol";
import {ISTAKING_ADDRESS, IStaking} from "../interfaces/IStaking.sol";
import {ADDRESS_MAPPING_ADDRESS, IAddressMapping} from "../interfaces/IAddressMapping.sol";
import {CascadeFormulas} from "../libraries/CascadeFormulas.sol";
import {CascadeMath} from "../libraries/CascadeMath.sol";
import "../CascadeConstants.sol" as Constants;
import {Actor, DoorState, PayoutBatch, Window} from "../CascadeTypes.sol";

/// @notice The vault's read-only lens (spec §8.1): each view of the vault's read surface, under the
/// name, arguments and return type of the getter it replaces (internal on the vault: CascadeBase's
/// since Task 5d-1, the vault's own since Task 5d-2, when price and hotkeyCount left the vault; the
/// vault keeps only the share token's totalSupply and balanceOf of these), read from the vault's
/// storage through its `extsload` with the slots generated from its storage layout (VaultLayout.sol).
/// Derived values go through the vault's own formulas (CascadeFormulas), and the stake is read from
/// the staking precompile as the vault reads it, so a lens value differs from the vault's only if a
/// raw read does, which the lens parity tests rule out (I-33).
/// @dev Bittensor only: the constructor derives the vault's coldkey through the address-mapping
/// precompile, as the vault's constructor does.
contract CascadeVaultLens is CascadeBaseLens {
    // ---- constants (CascadeConstants.sol and the precompiles, as the vault serves them) ----

    uint256 public constant RAO = Constants.RAO;
    uint256 public constant ED_RESERVE = Constants.ED_RESERVE;
    uint64 public constant KEEPER_FALLBACK = Constants.KEEPER_FALLBACK;
    uint16 public constant MAX_REWARD_CUT_BPS = Constants.MAX_REWARD_CUT_BPS;
    /// The redeem origin no front door burns for (Task 18): a direct depositor's, or one that chose Bittensor.
    uint64 public constant DIRECT_ORIGIN = Constants.DIRECT_ORIGIN;
    /// The gas the unstake walk leaves for its exit's work after it (Task 20): each removal gets max(unstakeGas,
    /// (gasleft - EXIT_GAS_RESERVE) / positionsLeft).
    uint256 public constant EXIT_GAS_RESERVE = Constants.EXIT_GAS_RESERVE;
    /// The staking floors' fallbacks, in rao (Task 23: constants, where v3.1 had the owner's fallbackMinStakeRao and
    /// fallbackMinRemainRao): minStakeRao() and minRemainRao() are the larger of the live read and these.
    uint256 public constant FALLBACK_MIN_STAKE_RAO = Constants.FALLBACK_MIN_STAKE_RAO;
    uint256 public constant FALLBACK_MIN_REMAIN_RAO = Constants.FALLBACK_MIN_REMAIN_RAO;
    /// The bounds of claimGasRequired (Task 23): the vault refuses a value outside them.
    uint256 public constant MIN_CLAIM_GAS = Constants.MIN_CLAIM_GAS;
    uint256 public constant MAX_CLAIM_GAS = Constants.MAX_CLAIM_GAS;
    IStaking public constant STAKING = IStaking(ISTAKING_ADDRESS);
    IAddressMapping public constant ADDRESS_MAPPING = IAddressMapping(ADDRESS_MAPPING_ADDRESS);

    /// The vault's substrate coldkey, the mirror of its address: the vault keeps it as an immutable,
    /// which extsload cannot read, so the lens derives it the same way.
    bytes32 public immutable coldkey;

    constructor(address vault) CascadeBaseLens(vault) {
        coldkey = ADDRESS_MAPPING.addressMapping(vault);
    }

    // ---- the share token ----

    function totalSupply() public view returns (uint256) {
        return _field(
            VaultLayout.SLOT_SHARES + VaultLayout.SHARES_DATA_TOTAL_SUPPLY_SLOT,
            VaultLayout.SHARES_DATA_TOTAL_SUPPLY_OFFSET,
            VaultLayout.SHARES_DATA_TOTAL_SUPPLY_SIZE
        );
    }

    function balanceOf(address account) external view returns (uint256) {
        return _word(_entry(VaultLayout.SLOT_SHARES + VaultLayout.SHARES_DATA_BALANCE_OF_SLOT, _key(account)));
    }

    // ---- hotkeys and the keeper ----

    /// The hotkey at index `i` of the set. Past the end it reverts without data, exactly as the vault's
    /// getter did (and VaultInternals' exposure does), never answering 0: a reader takes a failed read as
    /// the end of the set (ruling DA6).
    function hotkeys(uint256 i) external view returns (bytes32) {
        if (i >= hotkeyCount()) revert();
        // the elements of a dynamic array start at keccak256(its slot), one slot each
        unchecked {
            return bytes32(_word(_hotkeysStart() + i));
        }
    }

    function hotkeyCount() public view returns (uint256) {
        return _word(VaultLayout.SLOT_HOTKEYS);
    }

    function isHotkey(bytes32 h) external view returns (bool) {
        return _bool(_entry(VaultLayout.SLOT_IS_HOTKEY, h), 0, 1);
    }

    function stakeHotkey() external view returns (bytes32) {
        return
            bytes32(
                _field(VaultLayout.SLOT_STAKE_HOTKEY, VaultLayout.OFFSET_STAKE_HOTKEY, VaultLayout.SIZE_STAKE_HOTKEY)
            );
    }

    function lastClaimAt(bytes32 h) external view returns (uint64) {
        return _uint64(_entry(VaultLayout.SLOT_LAST_CLAIM_AT, h), 0, 8);
    }

    function keeper() external view returns (address) {
        return _address(VaultLayout.SLOT_KEEPER, VaultLayout.OFFSET_KEEPER, VaultLayout.SIZE_KEEPER);
    }

    function lastStakeAt() external view returns (uint64) {
        return _uint64(VaultLayout.SLOT_LAST_STAKE_AT, VaultLayout.OFFSET_LAST_STAKE_AT, VaultLayout.SIZE_LAST_STAKE_AT);
    }

    // ---- accounting and the reward cut ----

    /// The ledger's pending payouts (Ledger.pending, Task 5f).
    function pendingPayouts() public view returns (uint256) {
        return _field(
            VaultLayout.SLOT_LEDGER + VaultLayout.LEDGER_PENDING_SLOT,
            VaultLayout.LEDGER_PENDING_OFFSET,
            VaultLayout.LEDGER_PENDING_SIZE
        );
    }

    /// The ledger's ramping stake, in wei (Ledger.ramping; R2 F4), as last written: what stakeIdle added, less the
    /// walks' receipts, re-based at each stake. What of it still ramps in now is that spent linearly over a day
    /// (STAKE_RAMP) from lastStakeAt(), and the outflow allowance's base is min(visible, booked) in wei less that
    /// (spec §3.10.12, I-5).
    function rampingStake() external view returns (uint256) {
        return _field(
            VaultLayout.SLOT_LEDGER + VaultLayout.LEDGER_RAMPING_SLOT,
            VaultLayout.LEDGER_RAMPING_OFFSET,
            VaultLayout.LEDGER_RAMPING_SIZE
        );
    }

    function vestingAmount() public view returns (uint256) {
        return
            _field(VaultLayout.SLOT_VESTING_AMOUNT, VaultLayout.OFFSET_VESTING_AMOUNT, VaultLayout.SIZE_VESTING_AMOUNT);
    }

    function vestingStart() public view returns (uint64) {
        return _uint64(VaultLayout.SLOT_VESTING_START, VaultLayout.OFFSET_VESTING_START, VaultLayout.SIZE_VESTING_START);
    }

    /// The period the claim schedule vests over, as its last restart snapshotted it (Task 15): rewardVesting, or
    /// what was left of the old schedule when that was longer; 0 before the first claim.
    function vestingPeriod() public view returns (uint64) {
        return
            _uint64(VaultLayout.SLOT_VESTING_PERIOD, VaultLayout.OFFSET_VESTING_PERIOD, VaultLayout.SIZE_VESTING_PERIOD);
    }

    /// The adoption drip (Revision 27), beside the claim schedule: what its last restart set vesting, from when, over
    /// what period (the claim schedule's rule). An adoption restarts it on the drip's remainder and the surplus; the
    /// write-down at a supply of 0 restarts it too, whenever it writes down, even with no adoption ever (then the
    /// amount is 0 but the start and the period are set). All three are 0 until its first restart. unvestedRewards()
    /// reads both drips.
    function adoptVestingAmount() public view returns (uint256) {
        return _field(
            VaultLayout.SLOT_ADOPT_VESTING_AMOUNT,
            VaultLayout.OFFSET_ADOPT_VESTING_AMOUNT,
            VaultLayout.SIZE_ADOPT_VESTING_AMOUNT
        );
    }

    function adoptVestingStart() public view returns (uint64) {
        return _uint64(
            VaultLayout.SLOT_ADOPT_VESTING_START,
            VaultLayout.OFFSET_ADOPT_VESTING_START,
            VaultLayout.SIZE_ADOPT_VESTING_START
        );
    }

    function adoptVestingPeriod() public view returns (uint64) {
        return _uint64(
            VaultLayout.SLOT_ADOPT_VESTING_PERIOD,
            VaultLayout.OFFSET_ADOPT_VESTING_PERIOD,
            VaultLayout.SIZE_ADOPT_VESTING_PERIOD
        );
    }

    /// When adoptStake last ran, or the deploy (Task 16): the next adoption waits a day (STAKE_RAMP) from it, and
    /// anyone may adopt once KEEPER_FALLBACK has passed since it.
    function lastAdoptAt() external view returns (uint64) {
        return _uint64(VaultLayout.SLOT_LAST_ADOPT_AT, VaultLayout.OFFSET_LAST_ADOPT_AT, VaultLayout.SIZE_LAST_ADOPT_AT);
    }

    function treasury() external view returns (address) {
        return _address(VaultLayout.SLOT_TREASURY, VaultLayout.OFFSET_TREASURY, VaultLayout.SIZE_TREASURY);
    }

    function rewardCutBps() external view returns (uint16) {
        return
            _uint16(VaultLayout.SLOT_REWARD_CUT_BPS, VaultLayout.OFFSET_REWARD_CUT_BPS, VaultLayout.SIZE_REWARD_CUT_BPS);
    }

    // ---- front doors, direct users, batches ----

    /// Door `peer`'s state (DoorState: Unknown, Active, Removed), a one-byte enum at offset 0 of its entry.
    function doorState(bytes32 peer) external view returns (DoorState) {
        return DoorState(_field(_entry(VaultLayout.SLOT_DOOR_STATE, peer), 0, 1));
    }

    /// How many doors are active on `chain` (a uint64 mapping key is hashed as a 32-byte word).
    function activeDoors(uint64 chain) external view returns (uint256) {
        return _word(_entry(VaultLayout.SLOT_ACTIVE_DOORS, bytes32(uint256(chain))));
    }

    /// `user`'s redeem origin (spec §3.4, Task 18), its holder record's `origin`: 0 (none yet: no door burns
    /// for it), the chain whose front doors burn for it, or DIRECT_ORIGIN (no door does).
    function redeemOrigin(address user) external view returns (uint64) {
        uint256 h = _entry(VaultLayout.SLOT_HOLDERS, _key(user));
        return
            _uint64(
                h + VaultLayout.HOLDER_ORIGIN_SLOT, VaultLayout.HOLDER_ORIGIN_OFFSET, VaultLayout.HOLDER_ORIGIN_SIZE
            );
    }

    /// `user`'s fresh shares as stored (spec §3.5, R4 B-H1, the door hold), from its holder record: `since`, the clock of
    /// its last run of mints by a front door's deposit or a direct deposit (their share-weighted mean time), and
    /// `shares`, what that run minted. While `since` + a day is ahead, a front door burns at most the holder's balance
    /// less `shares`. Read at a delivery's block, it tells a RedeemDeferred held by it from one the day's allowance
    /// deferred.
    function freshShares(address user) external view returns (uint64 since, uint128 shares) {
        uint256 h = _entry(VaultLayout.SLOT_HOLDERS, _key(user));
        since =
            _uint64(h + VaultLayout.HOLDER_SINCE_SLOT, VaultLayout.HOLDER_SINCE_OFFSET, VaultLayout.HOLDER_SINCE_SIZE);
        // casting to 'uint128' is safe because _field keeps only the member's 16 bytes
        // forge-lint: disable-next-line(unsafe-typecast)
        shares = uint128(
            _field(h + VaultLayout.HOLDER_FRESH_SLOT, VaultLayout.HOLDER_FRESH_OFFSET, VaultLayout.HOLDER_FRESH_SIZE)
        );
    }

    function peerId(uint64 chain, address addr) external pure returns (bytes32) {
        return CascadeFormulas.peerId(chain, addr);
    }

    function processed(bytes32 key) external view returns (bool) {
        return _bool(_entry(VaultLayout.SLOT_PROCESSED, key), 0, 1);
    }

    /// Batch `key`'s queued payouts, member by member at the generated struct offsets.
    function getPayoutBatch(bytes32 key) external view returns (PayoutBatch memory b) {
        uint256 s = _entry(VaultLayout.SLOT_PAYOUT_BATCHES, key);
        b.sourceChain = _uint64(
            s + VaultLayout.PAYOUT_BATCH_SOURCE_CHAIN_SLOT,
            VaultLayout.PAYOUT_BATCH_SOURCE_CHAIN_OFFSET,
            VaultLayout.PAYOUT_BATCH_SOURCE_CHAIN_SIZE
        );
        b.frontDoor = _address(
            s + VaultLayout.PAYOUT_BATCH_FRONT_DOOR_SLOT,
            VaultLayout.PAYOUT_BATCH_FRONT_DOOR_OFFSET,
            VaultLayout.PAYOUT_BATCH_FRONT_DOOR_SIZE
        );
        b.batchId = _uint64(
            s + VaultLayout.PAYOUT_BATCH_BATCH_ID_SLOT,
            VaultLayout.PAYOUT_BATCH_BATCH_ID_OFFSET,
            VaultLayout.PAYOUT_BATCH_BATCH_ID_SIZE
        );
        b.queuedAt = _uint64(
            s + VaultLayout.PAYOUT_BATCH_QUEUED_AT_SLOT,
            VaultLayout.PAYOUT_BATCH_QUEUED_AT_OFFSET,
            VaultLayout.PAYOUT_BATCH_QUEUED_AT_SIZE
        );
        b.cursor = _uint32(
            s + VaultLayout.PAYOUT_BATCH_CURSOR_SLOT,
            VaultLayout.PAYOUT_BATCH_CURSOR_OFFSET,
            VaultLayout.PAYOUT_BATCH_CURSOR_SIZE
        );
        b.count = _uint32(
            s + VaultLayout.PAYOUT_BATCH_COUNT_SLOT,
            VaultLayout.PAYOUT_BATCH_COUNT_OFFSET,
            VaultLayout.PAYOUT_BATCH_COUNT_SIZE
        );
        b.chunk = _uint32(
            s + VaultLayout.PAYOUT_BATCH_CHUNK_SLOT,
            VaultLayout.PAYOUT_BATCH_CHUNK_OFFSET,
            VaultLayout.PAYOUT_BATCH_CHUNK_SIZE
        );
        b.remaining = _field(
            s + VaultLayout.PAYOUT_BATCH_REMAINING_SLOT,
            VaultLayout.PAYOUT_BATCH_REMAINING_OFFSET,
            VaultLayout.PAYOUT_BATCH_REMAINING_SIZE
        );
        b.payoutsHash = bytes32(
            _field(
                s + VaultLayout.PAYOUT_BATCH_PAYOUTS_HASH_SLOT,
                VaultLayout.PAYOUT_BATCH_PAYOUTS_HASH_OFFSET,
                VaultLayout.PAYOUT_BATCH_PAYOUTS_HASH_SIZE
            )
        );
    }

    /// A front door's current burn window (keyed by its peer id), or all doors' together (bytes32(0), the global
    /// window, Task 17): when it started and what it burned, as of now (R2 F4). The stored window through the rule L1
    /// burns against (CascadeFormulas.currentWindow): one 24 hours past its start, or never written, reads as a fresh
    /// one opening now with nothing burned, as the next burn would start it; L1 writes it only when it burns.
    function burnWindows(bytes32 peer) external view returns (uint64 start, uint256 burned) {
        uint256 s = _entry(VaultLayout.SLOT_BURN_WINDOWS, peer);
        Window memory w = CascadeFormulas.currentWindow(
            Window(
                _uint64(
                    s + VaultLayout.WINDOW_START_SLOT, VaultLayout.WINDOW_START_OFFSET, VaultLayout.WINDOW_START_SIZE
                ),
                _field(
                    s + VaultLayout.WINDOW_BURNED_SLOT, VaultLayout.WINDOW_BURNED_OFFSET, VaultLayout.WINDOW_BURNED_SIZE
                )
            )
        );
        return (w.start, w.burned);
    }

    function batchKey(uint64 sourceChain, address sender, bytes calldata message) external pure returns (bytes32) {
        return CascadeFormulas.batchKey(sourceChain, sender, message);
    }

    // ---- the vault's exits machine (spec §3.6): its two holds, beside CascadeBase's primaryDisabledBy ----

    function pausedBy() public view returns (Actor) {
        return Actor(_field(VaultLayout.SLOT_PAUSED_BY, VaultLayout.OFFSET_PAUSED_BY, VaultLayout.SIZE_PAUSED_BY));
    }

    function launchDoorRemovedBy() public view returns (Actor) {
        return Actor(
            _field(
                VaultLayout.SLOT_LAUNCH_DOOR_REMOVED_BY,
                VaultLayout.OFFSET_LAUNCH_DOOR_REMOVED_BY,
                VaultLayout.SIZE_LAUNCH_DOOR_REMOVED_BY
            )
        );
    }

    /// The vault's holds, through the formula the vault uses (CascadeFormulas.holds), from its three records:
    /// the primary's disable (CascadeBase's), the pause and the launch door's removal.
    function ownerHold() public view override returns (bool) {
        return CascadeFormulas.holds(Actor.Owner, primaryDisabledBy(), pausedBy(), launchDoorRemovedBy());
    }

    function guardianHold() public view override returns (bool) {
        return CascadeFormulas.holds(Actor.Guardian, primaryDisabledBy(), pausedBy(), launchDoorRemovedBy());
    }

    // ---- parameters ----

    function minChunk() external view returns (uint32) {
        return _uint32(VaultLayout.SLOT_MIN_CHUNK, VaultLayout.OFFSET_MIN_CHUNK, VaultLayout.SIZE_MIN_CHUNK);
    }

    function payoutDelay() external view returns (uint64) {
        return _uint64(VaultLayout.SLOT_PAYOUT_DELAY, VaultLayout.OFFSET_PAYOUT_DELAY, VaultLayout.SIZE_PAYOUT_DELAY);
    }

    /// The owner's reward vesting period, 1 to 30 days: what the next restart of the schedule snapshots.
    function rewardVesting() external view returns (uint64) {
        return
            _uint64(VaultLayout.SLOT_REWARD_VESTING, VaultLayout.OFFSET_REWARD_VESTING, VaultLayout.SIZE_REWARD_VESTING);
    }

    function maxDailyOutflowBps() external view returns (uint256) {
        return _field(
            VaultLayout.SLOT_MAX_DAILY_OUTFLOW_BPS,
            VaultLayout.OFFSET_MAX_DAILY_OUTFLOW_BPS,
            VaultLayout.SIZE_MAX_DAILY_OUTFLOW_BPS
        );
    }

    function minDailyOutflow() external view returns (uint256) {
        return _field(
            VaultLayout.SLOT_MIN_DAILY_OUTFLOW, VaultLayout.OFFSET_MIN_DAILY_OUTFLOW, VaultLayout.SIZE_MIN_DAILY_OUTFLOW
        );
    }

    /// All front doors' daily allowance together, in bps of the base, at least minDailyOutflow (Task 17): the
    /// window at burnWindows(bytes32(0)).
    function globalOutflowBps() external view returns (uint256) {
        return _field(
            VaultLayout.SLOT_GLOBAL_OUTFLOW_BPS,
            VaultLayout.OFFSET_GLOBAL_OUTFLOW_BPS,
            VaultLayout.SIZE_GLOBAL_OUTFLOW_BPS
        );
    }

    function maxEntryValue() external view returns (uint256) {
        return
            _field(
                VaultLayout.SLOT_MAX_ENTRY_VALUE, VaultLayout.OFFSET_MAX_ENTRY_VALUE, VaultLayout.SIZE_MAX_ENTRY_VALUE
            );
    }

    function maxMessageValue() external view returns (uint256) {
        return _field(
            VaultLayout.SLOT_MAX_MESSAGE_VALUE, VaultLayout.OFFSET_MAX_MESSAGE_VALUE, VaultLayout.SIZE_MAX_MESSAGE_VALUE
        );
    }

    function maxFeeBps() external view returns (uint256) {
        return _field(VaultLayout.SLOT_MAX_FEE_BPS, VaultLayout.OFFSET_MAX_FEE_BPS, VaultLayout.SIZE_MAX_FEE_BPS);
    }

    function maxFeeAbs() external view returns (uint256) {
        return _field(VaultLayout.SLOT_MAX_FEE_ABS, VaultLayout.OFFSET_MAX_FEE_ABS, VaultLayout.SIZE_MAX_FEE_ABS);
    }

    function maxTotalAssets() external view returns (uint256) {
        return _field(
            VaultLayout.SLOT_MAX_TOTAL_ASSETS, VaultLayout.OFFSET_MAX_TOTAL_ASSETS, VaultLayout.SIZE_MAX_TOTAL_ASSETS
        );
    }

    function minDirectDeposit() external view returns (uint256) {
        return _field(
            VaultLayout.SLOT_MIN_DIRECT_DEPOSIT,
            VaultLayout.OFFSET_MIN_DIRECT_DEPOSIT,
            VaultLayout.SIZE_MIN_DIRECT_DEPOSIT
        );
    }

    function hotkeyDustRao() external view returns (uint256) {
        return
            _field(
                VaultLayout.SLOT_HOTKEY_DUST_RAO, VaultLayout.OFFSET_HOTKEY_DUST_RAO, VaultLayout.SIZE_HOTKEY_DUST_RAO
            );
    }

    function claimGasRequired() external view returns (uint256) {
        return _field(
            VaultLayout.SLOT_CLAIM_GAS_REQUIRED,
            VaultLayout.OFFSET_CLAIM_GAS_REQUIRED,
            VaultLayout.SIZE_CLAIM_GAS_REQUIRED
        );
    }

    function unstakeMarginRao() external view returns (uint256) {
        return _field(
            VaultLayout.SLOT_UNSTAKE_MARGIN_RAO,
            VaultLayout.OFFSET_UNSTAKE_MARGIN_RAO,
            VaultLayout.SIZE_UNSTAKE_MARGIN_RAO
        );
    }

    /// The least gas the unstake walk forwards to each removal, 150,000 to 5,000,000 (Task 20).
    function unstakeGas() external view returns (uint256) {
        return _field(VaultLayout.SLOT_UNSTAKE_GAS, VaultLayout.OFFSET_UNSTAKE_GAS, VaultLayout.SIZE_UNSTAKE_GAS);
    }

    /// The idle buffer, in bps of the booked stake, at most 1,000 (Task 20): stakeIdle leaves the larger of that share
    /// and minDailyOutflow liquid, none at 0.
    function idleBufferBps() external view returns (uint16) {
        return
            _uint16(
                VaultLayout.SLOT_IDLE_BUFFER_BPS, VaultLayout.OFFSET_IDLE_BUFFER_BPS, VaultLayout.SIZE_IDLE_BUFFER_BPS
            );
    }

    // ---- the computed views, through the vault's formulas ----

    /// The visible stake: root stake across the hotkey set, in rao, read from the staking precompile as the
    /// vault reads it (v3.1's rootStakeRao).
    function visibleStakeRao() public view returns (uint256 total) {
        uint256 n = hotkeyCount();
        uint256 start = _hotkeysStart();
        for (uint256 i; i < n; ++i) {
            total += CascadeFormulas.stakeOf(bytes32(_word(start + i)), coldkey);
        }
    }

    /// The booked stake, in rao (ruling A19): the ledger's (Ledger.booked).
    function bookedStake() public view returns (uint256) {
        return _field(
            VaultLayout.SLOT_LEDGER + VaultLayout.LEDGER_BOOKED_SLOT,
            VaultLayout.LEDGER_BOOKED_OFFSET,
            VaultLayout.LEDGER_BOOKED_SIZE
        );
    }

    /// The booked stake the hotkey set does not show, in rao: a swap's, until its new hotkey is listed.
    function missingStakeRao() external view returns (uint256) {
        return CascadeFormulas.sub0(bookedStake(), visibleStakeRao());
    }

    /// The visible stake the ledger does not hold, in rao: a gift, until adopted or unstaked into balance.
    function surplusStakeRao() external view returns (uint256) {
        return CascadeFormulas.sub0(visibleStakeRao(), bookedStake());
    }

    /// Whether stake is missing past the tolerance (spec §3.1), as the vault's guards read it.
    function stakeMissing() external view returns (bool) {
        return CascadeFormulas.stakeMissing(visibleStakeRao(), bookedStake(), pendingPayouts());
    }

    /// The vault's root stake off the hotkey set, in rao (CascadeFormulas.unlistedStakeRao). Reverts when the
    /// staking precompile cannot total it, as the vault's read does.
    function unlistedStakeRao() external view returns (uint256) {
        return CascadeFormulas.unlistedStakeRao(
            STAKING.getTotalColdkeyStakeOnSubnet(coldkey, Constants.NETUID_ROOT), visibleStakeRao()
        );
    }

    /// The priced stake, min(visible, booked), and the vault's balance, less the existential reserve.
    function grossAssets() public view returns (uint256) {
        return CascadeFormulas.grossAssets(
            CascadeFormulas.positionWei(
                CascadeFormulas.pricedStakeRao(visibleStakeRao(), bookedStake()), target.balance
            )
        );
    }

    /// What is still vesting of both drips, the claim schedule and the adoption drip (Revision 27), each over its own
    /// period, as the vault reads it: what totalAssets() leaves out.
    function unvestedRewards() public view returns (uint256) {
        return CascadeFormulas.unvestedRewards(vestingAmount(), vestingStart(), vestingPeriod())
            + CascadeFormulas.unvestedRewards(adoptVestingAmount(), adoptVestingStart(), adoptVestingPeriod());
    }

    function totalAssets() public view returns (uint256) {
        return CascadeFormulas.totalAssets(grossAssets(), pendingPayouts(), unvestedRewards());
    }

    /// Assets per share, scaled by 1e18.
    function price() external view returns (uint256) {
        return CascadeMath.price(totalAssets(), totalSupply());
    }

    function minStakeRao() external view returns (uint256) {
        return CascadeFormulas.minStakeRao();
    }

    function minRemainRao() external view returns (uint256) {
        return CascadeFormulas.minRemainRao();
    }

    // ---- CascadeBase's state in the vault ----

    function _guardianField() internal pure override returns (uint256, uint256, uint256) {
        return (VaultLayout.SLOT_GUARDIAN, VaultLayout.OFFSET_GUARDIAN, VaultLayout.SIZE_GUARDIAN);
    }

    function _primaryBridgeField() internal pure override returns (uint256, uint256, uint256) {
        return (VaultLayout.SLOT_PRIMARY_BRIDGE, VaultLayout.OFFSET_PRIMARY_BRIDGE, VaultLayout.SIZE_PRIMARY_BRIDGE);
    }

    function _bridgeEnabledSlot() internal pure override returns (uint256) {
        return VaultLayout.SLOT_BRIDGE_ENABLED;
    }

    function _scheduledSlot() internal pure override returns (uint256) {
        return VaultLayout.SLOT_SCHEDULED;
    }

    function _bridgeKnownSlot() internal pure override returns (uint256) {
        return VaultLayout.SLOT_BRIDGE_KNOWN;
    }

    function _lastOwnerCloseField() internal pure override returns (uint256, uint256, uint256) {
        return
            (VaultLayout.SLOT_LAST_OWNER_CLOSE, VaultLayout.OFFSET_LAST_OWNER_CLOSE, VaultLayout.SIZE_LAST_OWNER_CLOSE);
    }

    function _lastGuardianCloseField() internal pure override returns (uint256, uint256, uint256) {
        return (
            VaultLayout.SLOT_LAST_GUARDIAN_CLOSE,
            VaultLayout.OFFSET_LAST_GUARDIAN_CLOSE,
            VaultLayout.SIZE_LAST_GUARDIAN_CLOSE
        );
    }

    function _primaryDisabledByField() internal pure override returns (uint256, uint256, uint256) {
        return (
            VaultLayout.SLOT_PRIMARY_DISABLED_BY,
            VaultLayout.OFFSET_PRIMARY_DISABLED_BY,
            VaultLayout.SIZE_PRIMARY_DISABLED_BY
        );
    }

    function _pendingSinceField() internal pure override returns (uint256, uint256, uint256) {
        return (VaultLayout.SLOT_PENDING_SINCE, VaultLayout.OFFSET_PENDING_SINCE, VaultLayout.SIZE_PENDING_SINCE);
    }

    function _itemMembers() internal pure override returns (uint256[2][6] memory) {
        return [
            [VaultLayout.ITEM_SCHEDULED_AT_OFFSET, VaultLayout.ITEM_SCHEDULED_AT_SIZE],
            [VaultLayout.ITEM_READY_AT_OFFSET, VaultLayout.ITEM_READY_AT_SIZE],
            [VaultLayout.ITEM_CLASS_OFFSET, VaultLayout.ITEM_CLASS_SIZE],
            [VaultLayout.ITEM_KIND_OFFSET, VaultLayout.ITEM_KIND_SIZE],
            [VaultLayout.ITEM_SELECTOR_OFFSET, VaultLayout.ITEM_SELECTOR_SIZE],
            [VaultLayout.ITEM_READY_BLOCK_OFFSET, VaultLayout.ITEM_READY_BLOCK_SIZE]
        ];
    }

    /// Where the hotkey array's elements start: keccak256 of its slot.
    function _hotkeysStart() internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(VaultLayout.SLOT_HOTKEYS)));
    }
}
