// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CascadeVault} from "../../src/CascadeVault.sol";
import {IStaking} from "../../src/interfaces/IStaking.sol";
import {IAddressMapping} from "../../src/interfaces/IAddressMapping.sol";
import {CascadeFormulas} from "../../src/libraries/CascadeFormulas.sol";
import {CascadeMath} from "../../src/libraries/CascadeMath.sol";
import {EXIT_GAS_RESERVE, FALLBACK_MIN_REMAIN_RAO, FALLBACK_MIN_STAKE_RAO} from "../../src/CascadeConstants.sol";
import {Actor, DoorState, Holder, Item, PayoutBatch, Window} from "../../src/CascadeTypes.sol";

/// Test only: a CascadeVault that adds no storage and exposes, as `exposed_<name>` with the vault lens
/// view's arguments and return type, each value the lens serves, read inside the vault (ruling DB3a).
/// The lens parity tests (I-33) compare each lens view with its exposure here. Each exposure reads
/// the vault's own state or internal function, not a public getter: since Task 5d-2 the vault has none
/// but the share token's. It also exposes the state no lens serves (the transient unstake flag, under v3.1's name;
/// the booked stake is the lens's bookedStake() since Task 12, the ramping stake its rampingStake() since R2 F4). Its
/// bytecode may pass EIP-170: tests that deploy it run under [profile.parity].
contract VaultInternals is CascadeVault {
    constructor(Params memory p) CascadeVault(p) {}

    // ---- constants and the immutable ----

    function exposed_ADDRESS_MAPPING() external pure returns (IAddressMapping) {
        return ADDRESS_MAPPING;
    }

    function exposed_DIRECT_ORIGIN() external pure returns (uint64) {
        return DIRECT_ORIGIN;
    }

    function exposed_ED_RESERVE() external pure returns (uint256) {
        return ED_RESERVE;
    }

    /// CascadeConstants.sol's, which the walk (L2) applies: the vault holds no copy (Task 20).
    function exposed_EXIT_GAS_RESERVE() external pure returns (uint256) {
        return EXIT_GAS_RESERVE;
    }

    /// CascadeConstants.sol's, which the floors' formulas apply (CascadeFormulas): the vault holds no copy (Task 23).
    function exposed_FALLBACK_MIN_STAKE_RAO() external pure returns (uint256) {
        return FALLBACK_MIN_STAKE_RAO;
    }

    function exposed_FALLBACK_MIN_REMAIN_RAO() external pure returns (uint256) {
        return FALLBACK_MIN_REMAIN_RAO;
    }

    function exposed_GUARDIAN_DELAY() external pure returns (uint64) {
        return GUARDIAN_DELAY;
    }

    function exposed_KEEPER_FALLBACK() external pure returns (uint64) {
        return KEEPER_FALLBACK;
    }

    function exposed_MAX_REWARD_CUT_BPS() external pure returns (uint16) {
        return MAX_REWARD_CUT_BPS;
    }

    function exposed_MAX_CLAIM_GAS() external pure returns (uint256) {
        return MAX_CLAIM_GAS;
    }

    function exposed_MIN_CLAIM_GAS() external pure returns (uint256) {
        return MIN_CLAIM_GAS;
    }

    function exposed_RAO() external pure returns (uint256) {
        return RAO;
    }

    function exposed_REGISTRY_DELAY() external pure returns (uint64) {
        return REGISTRY_DELAY;
    }

    function exposed_STAKING() external pure returns (IStaking) {
        return STAKING;
    }

    function exposed_coldkey() external view returns (bytes32) {
        return coldkey;
    }

    // ---- CascadeBase ----

    function exposed_guardian() external view returns (address) {
        return guardian;
    }

    function exposed_bridgeEnabled(address bridge) external view returns (bool) {
        return bridgeEnabled[bridge];
    }

    function exposed_primaryBridge() external view returns (address) {
        return primaryBridge;
    }

    function exposed_PARAM_DELAY() external pure returns (uint64) {
        return PARAM_DELAY;
    }

    function exposed_EXECUTE_WINDOW() external pure returns (uint64) {
        return EXECUTE_WINDOW;
    }

    function exposed_STAMP_TYPEHASH() external pure returns (bytes32) {
        return STAMP_TYPEHASH;
    }

    function exposed_STAMP_MAX_TTL() external pure returns (uint64) {
        return STAMP_MAX_TTL;
    }

    function exposed_DOMAIN_SEPARATOR() external view returns (bytes32) {
        return DOMAIN_SEPARATOR;
    }

    function exposed_scheduled(bytes32 id) external view returns (Item memory) {
        return scheduled[id];
    }

    function exposed_bridgeKnown(address bridge) external view returns (bool) {
        return bridgeKnown[bridge];
    }

    function exposed_lastOwnerClose() external view returns (uint64) {
        return lastOwnerClose;
    }

    function exposed_lastGuardianClose() external view returns (uint64) {
        return lastGuardianClose;
    }

    function exposed_primaryDisabledBy() external view returns (Actor) {
        return primaryDisabledBy;
    }

    function exposed_pendingSince() external view returns (uint64) {
        return pendingSince;
    }

    function exposed_MS_PER_BLOCK() external view returns (uint64) {
        return MS_PER_BLOCK;
    }

    function exposed_ownerHold() external view returns (bool) {
        return ownerHold();
    }

    function exposed_guardianHold() external view returns (bool) {
        return guardianHold();
    }

    function exposed_exitsOpen() external view returns (bool) {
        return exitsOpen();
    }

    // ---- the share token ----

    function exposed_totalSupply() external view returns (uint256) {
        return _shares.totalSupply;
    }

    function exposed_balanceOf(address account) external view returns (uint256) {
        return _shares.balanceOf[account];
    }

    // ---- hotkeys and the keeper ----

    /// Past the end it reverts without data, as the compiler's getter for a public array does (an
    /// index into the array itself would revert Panic(0x32) instead).
    function exposed_hotkeys(uint256 i) external view returns (bytes32) {
        if (i >= hotkeys.length) revert();
        return hotkeys[i];
    }

    /// The vault has no hotkeyCount (trimmed in Task 5d-2, spec §8): the set's length.
    function exposed_hotkeyCount() external view returns (uint256) {
        return hotkeys.length;
    }

    function exposed_isHotkey(bytes32 h) external view returns (bool) {
        return isHotkey[h];
    }

    function exposed_stakeHotkey() external view returns (bytes32) {
        return stakeHotkey;
    }

    function exposed_lastClaimAt(bytes32 h) external view returns (uint64) {
        return lastClaimAt[h];
    }

    function exposed_keeper() external view returns (address) {
        return keeper;
    }

    function exposed_lastStakeAt() external view returns (uint64) {
        return lastStakeAt;
    }

    // ---- accounting and the reward cut ----

    function exposed_pendingPayouts() external view returns (uint256) {
        return ledger.pending;
    }

    function exposed_vestingAmount() external view returns (uint256) {
        return vestingAmount;
    }

    function exposed_vestingStart() external view returns (uint64) {
        return vestingStart;
    }

    function exposed_vestingPeriod() external view returns (uint64) {
        return vestingPeriod;
    }

    function exposed_lastAdoptAt() external view returns (uint64) {
        return lastAdoptAt;
    }

    // the adoption drip (Revision 27)

    function exposed_adoptVestingAmount() external view returns (uint256) {
        return adoptVestingAmount;
    }

    function exposed_adoptVestingStart() external view returns (uint64) {
        return adoptVestingStart;
    }

    function exposed_adoptVestingPeriod() external view returns (uint64) {
        return adoptVestingPeriod;
    }

    function exposed_treasury() external view returns (address) {
        return treasury;
    }

    function exposed_rewardCutBps() external view returns (uint16) {
        return rewardCutBps;
    }

    // ---- front doors, direct users, batches ----

    function exposed_doorState(bytes32 peer) external view returns (DoorState) {
        return doorState[peer];
    }

    function exposed_activeDoors(uint64 chain) external view returns (uint256) {
        return activeDoors[chain];
    }

    function exposed_pausedBy() external view returns (Actor) {
        return pausedBy;
    }

    function exposed_launchDoorRemovedBy() external view returns (Actor) {
        return launchDoorRemovedBy;
    }

    function exposed_redeemOrigin(address user) external view returns (uint64) {
        return holders[user].origin;
    }

    /// `user`'s fresh-share bucket as stored (R4 B-H1).
    function exposed_freshShares(address user) external view returns (uint64 since, uint128 shares) {
        Holder memory h = holders[user];
        return (h.since, h.fresh);
    }

    function exposed_peerId(uint64 chain, address addr) external pure returns (bytes32) {
        return peerId(chain, addr);
    }

    function exposed_processed(bytes32 key) external view returns (bool) {
        return processed[key];
    }

    function exposed_getPayoutBatch(bytes32 key) external view returns (PayoutBatch memory) {
        return payoutBatches[key];
    }

    /// The window as of now, through the rule L1 burns against (CascadeFormulas.currentWindow, R2 F4).
    function exposed_burnWindows(bytes32 peer) external view returns (uint64 start, uint256 burned) {
        Window memory w = CascadeFormulas.currentWindow(burnWindows[peer]);
        return (w.start, w.burned);
    }

    function exposed_batchKey(uint64 sourceChain, address sender, bytes calldata message)
        external
        pure
        returns (bytes32)
    {
        return batchKey(sourceChain, sender, message);
    }

    // ---- parameters ----

    function exposed_minChunk() external view returns (uint32) {
        return minChunk;
    }

    function exposed_payoutDelay() external view returns (uint64) {
        return payoutDelay;
    }

    function exposed_rewardVesting() external view returns (uint64) {
        return rewardVesting;
    }

    function exposed_maxDailyOutflowBps() external view returns (uint256) {
        return maxDailyOutflowBps;
    }

    function exposed_minDailyOutflow() external view returns (uint256) {
        return minDailyOutflow;
    }

    function exposed_globalOutflowBps() external view returns (uint256) {
        return globalOutflowBps;
    }

    function exposed_maxEntryValue() external view returns (uint256) {
        return maxEntryValue;
    }

    function exposed_maxMessageValue() external view returns (uint256) {
        return maxMessageValue;
    }

    function exposed_maxFeeBps() external view returns (uint256) {
        return maxFeeBps;
    }

    function exposed_maxFeeAbs() external view returns (uint256) {
        return maxFeeAbs;
    }

    function exposed_maxTotalAssets() external view returns (uint256) {
        return maxTotalAssets;
    }

    function exposed_minDirectDeposit() external view returns (uint256) {
        return minDirectDeposit;
    }

    function exposed_hotkeyDustRao() external view returns (uint256) {
        return hotkeyDustRao;
    }

    function exposed_claimGasRequired() external view returns (uint256) {
        return claimGasRequired;
    }

    function exposed_unstakeMarginRao() external view returns (uint256) {
        return unstakeMarginRao;
    }

    function exposed_unstakeGas() external view returns (uint256) {
        return unstakeGas;
    }

    function exposed_idleBufferBps() external view returns (uint16) {
        return idleBufferBps;
    }

    // ---- the computed views ----

    function exposed_visibleStakeRao() external view returns (uint256) {
        return visibleStakeRao();
    }

    function exposed_bookedStake() external view returns (uint256) {
        return bookedStake();
    }

    function exposed_missingStakeRao() external view returns (uint256) {
        return missingStakeRao();
    }

    function exposed_surplusStakeRao() external view returns (uint256) {
        return surplusStakeRao();
    }

    function exposed_stakeMissing() external view returns (bool) {
        return stakeMissing();
    }

    function exposed_unlistedStakeRao() external view returns (uint256) {
        return unlistedStakeRao();
    }

    function exposed_grossAssets() external view returns (uint256) {
        return grossAssets();
    }

    function exposed_unvestedRewards() external view returns (uint256) {
        return unvestedRewards();
    }

    function exposed_totalAssets() external view returns (uint256) {
        return totalAssets();
    }

    /// The vault has no price (trimmed in Task 5d-2, spec §8): the lens's formula over the vault's
    /// internal values.
    function exposed_price() external view returns (uint256) {
        return CascadeMath.price(totalAssets(), _shares.totalSupply);
    }

    function exposed_minStakeRao() external view returns (uint256) {
        return minStakeRao();
    }

    function exposed_minRemainRao() external view returns (uint256) {
        return minRemainRao();
    }

    /// The ledger's ramping stake, in wei (served by the lens since R2 F4).
    function exposed_rampingStake() external view returns (uint256) {
        return ledger.ramping;
    }

    // ---- what no lens serves ----

    /// The transient flag: false between unstakes, since every unstake clears it before it returns.
    function exposed_unstaking() external view returns (bool) {
        return _unstaking;
    }
}
