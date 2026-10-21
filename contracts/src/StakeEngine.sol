// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IStaking, ISTAKING_ADDRESS} from "./interfaces/IStaking.sol";
import {ICascadeBridge, ICascadeReceiver} from "./interfaces/ICascadeBridge.sol";
import {CascadeMessages} from "./libraries/CascadeMessages.sol";
import {CascadeMath} from "./libraries/CascadeMath.sol";

/// @title StakeEngine
/// @notice Bittensor-side engine of Cascade. Owns the root stake (netuid 0) through the staking
/// precompile, settles one bridged epoch at a time (prices it from its own on-chain stake, pays
/// redemptions back through the bridge, stakes the rest) and claims root rewards.
/// @dev TAO leaves this contract only through `bridge.send` and the settle-fee refund to the
/// caller. Never sends msg.value to the precompile: it debits and credits this contract's balance.
contract StakeEngine is ICascadeReceiver, Ownable2Step, Pausable, ReentrancyGuard {
    uint256 public constant NETUID_ROOT = 0;
    uint256 public constant RAO = 1e9;
    uint256 public constant MIN_STAKE_RAO = 2_000_000;
    IStaking public constant STAKING = IStaking(ISTAKING_ADDRESS);

    /// Mirror of this contract's H160 address on Bittensor.
    bytes32 public immutable coldkey;
    bytes32 public hotkey;
    ICascadeBridge public bridge;
    address public guardian;
    uint64 public lastSettledEpoch;
    bool public hasPending;

    struct PendingEpoch {
        uint64 epochId;
        uint256 depositAssets;
        uint256 redeemShares;
        uint256 totalSupply;
    }

    PendingEpoch public pending;

    error NotBridge();
    error ValueMismatch();
    error EpochPending();
    error StaleEpoch();
    error InvalidRedeem();
    error NoPendingEpoch();
    error InsufficientFee();
    error RefundFailed();
    error NotGuardian();
    error ZeroAddress();
    error DirectTransferNotAllowed();
    error ZeroHotkey();
    error ZeroColdkey();
    error RenounceDisabled();

    event EpochReceived(uint64 indexed epochId, uint256 depositAssets, uint256 redeemShares, uint256 totalSupply);
    event EpochSettled(uint64 indexed epochId, uint256 assetsBefore, uint256 redeemAssets);
    event Staked(uint256 rao);
    event Unstaked(uint256 rao);
    event RewardsClaimed(uint256 rao);
    event HotkeySet(bytes32 indexed oldHotkey, bytes32 indexed newHotkey);
    event BridgeSet(address indexed bridge);
    event GuardianSet(address indexed guardian);

    constructor(bytes32 coldkey_, bytes32 hotkey_, ICascadeBridge bridge_, address owner_, address guardian_)
        Ownable(owner_)
    {
        if (coldkey_ == bytes32(0)) revert ZeroColdkey();
        if (hotkey_ == bytes32(0)) revert ZeroHotkey();
        coldkey = coldkey_;
        hotkey = hotkey_;
        emit HotkeySet(bytes32(0), hotkey_);
        _setBridge(address(bridge_));
        _setGuardian(guardian_);
        STAKING.setRejectStakingHotkeyGrowth(true);
    }

    // ---- views ----

    /// @notice Root stake plus liquid balance, 18-decimal. Unclaimed root rewards are excluded.
    function totalAssets() public view returns (uint256) {
        return rootStakeRao() * RAO + address(this).balance;
    }

    function rootStakeRao() public view returns (uint256) {
        return STAKING.getStake(hotkey, coldkey, NETUID_ROOT);
    }

    /// @return 18-decimal TAO claimable into root stake by `claimRewards`.
    function unclaimedRewards() external view returns (uint256) {
        return STAKING.getUnclaimedRootTaoByHotkey(coldkey, hotkey);
    }

    // ---- bridge ----

    /// @notice Records an epoch request from the vault. `amount` is the epoch's deposits, attached
    /// as native TAO. Works while paused so a delivered message is never lost.
    function onBridgeMessage(bytes calldata message, uint256 amount) external payable {
        if (msg.sender != address(bridge)) revert NotBridge();
        if (msg.value != amount) revert ValueMismatch();
        (uint64 epochId, uint256 redeemShares, uint256 totalSupply) = CascadeMessages.decodeRequest(message);
        if (hasPending) revert EpochPending();
        if (epochId <= lastSettledEpoch) revert StaleEpoch();
        if (redeemShares > totalSupply) revert InvalidRedeem();

        pending = PendingEpoch(epochId, amount, redeemShares, totalSupply);
        hasPending = true;
        emit EpochReceived(epochId, amount, redeemShares, totalSupply);
    }

    // ---- routine (permissionless) ----

    /// @notice Settles the pending epoch: prices it, pays redemptions back through the bridge and
    /// stakes what is left. msg.value pays the bridge fee; the excess is refunded to the caller.
    function settleEpoch() external payable whenNotPaused nonReentrant {
        if (!hasPending) revert NoPendingEpoch();
        PendingEpoch memory p = pending;

        // 1-2. Price from assets held before this epoch's deposits and this call's fee payment.
        uint256 assetsBefore = totalAssets() - msg.value - p.depositAssets;
        uint256 redeemAssets = CascadeMath.assetsForRedeem(p.redeemShares, assetsBefore, p.totalSupply);

        // 3. Cover any shortfall from root stake, rounding up to whole rao. Subtensor rejects a partial
        // unstake below its minimum stake, so unstake at least MIN_STAKE_RAO but never more than the
        // whole position; the sub-minimum excess stays idle at step 8. Precompile reverts bubble up.
        uint256 available = address(this).balance - msg.value;
        if (available < redeemAssets) {
            uint256 rao = Math.max((redeemAssets - available + RAO - 1) / RAO, MIN_STAKE_RAO);
            rao = Math.min(rao, rootStakeRao());
            STAKING.removeStake(hotkey, rao, NETUID_ROOT);
            emit Unstaked(rao);
        }

        // 4. Fee check.
        bytes memory result = CascadeMessages.encodeResult(p.epochId, assetsBefore);
        uint256 fee = bridge.quoteFee(result, redeemAssets);
        if (msg.value < fee) revert InsufficientFee();

        // 5. Effects before any value leaves the contract.
        delete pending;
        hasPending = false;
        lastSettledEpoch = p.epochId;
        emit EpochSettled(p.epochId, assetsBefore, redeemAssets);

        // 6. Report and pay redemptions.
        bridge.send{value: redeemAssets + fee}(result, redeemAssets);

        // 7. Refund the unused fee payment.
        uint256 refund = msg.value - fee;
        if (refund != 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }

        // 8. Stake whatever is left.
        _stakeIdle();
    }

    /// @notice Stakes the idle balance to root. Pending deposits stay liquid so this cannot force
    /// an unstake at settlement.
    function stakeIdle() external whenNotPaused nonReentrant {
        _stakeIdle();
    }

    /// @notice Claims root rewards; they land as root stake.
    function claimRewards() external whenNotPaused nonReentrant {
        _claimRewards();
    }

    // ---- admin ----

    /// @notice Points the root stake at a new validator. Claims the old hotkey's unclaimed root
    /// rewards first so none are stranded, then moves the full root stake.
    function setHotkey(bytes32 newHotkey) external onlyOwner {
        if (newHotkey == bytes32(0)) revert ZeroHotkey();
        bytes32 oldHotkey = hotkey;
        if (STAKING.getUnclaimedRootTaoByHotkey(coldkey, oldHotkey) > 0) _claimRewards();
        uint256 rao = rootStakeRao();
        hotkey = newHotkey;
        if (rao != 0) STAKING.moveStake(oldHotkey, newHotkey, NETUID_ROOT, NETUID_ROOT, rao);
        emit HotkeySet(oldHotkey, newHotkey);
    }

    function setBridge(address newBridge) external onlyOwner {
        _setBridge(newBridge);
    }

    function setGuardian(address newGuardian) external onlyOwner {
        _setGuardian(newGuardian);
    }

    function pause() external {
        if (msg.sender != owner() && msg.sender != guardian) revert NotGuardian();
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Disabled: without an owner a guardian pause could never be lifted.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    receive() external payable {
        revert DirectTransferNotAllowed();
    }

    // ---- internal ----

    function _stakeIdle() internal {
        uint256 stakeable = address(this).balance - (hasPending ? pending.depositAssets : 0);
        uint256 rao = stakeable / RAO;
        if (rao < MIN_STAKE_RAO) return;
        STAKING.addStake(hotkey, rao, NETUID_ROOT);
        emit Staked(rao);
    }

    /// @dev Claims root rewards for the current hotkey; they land as root stake.
    function _claimRewards() internal {
        uint256 stakeBefore = rootStakeRao();
        STAKING.claimRootWithHotkey(hotkey);
        emit RewardsClaimed(rootStakeRao() - stakeBefore);
    }

    function _setBridge(address newBridge) private {
        if (newBridge == address(0)) revert ZeroAddress();
        bridge = ICascadeBridge(newBridge);
        emit BridgeSet(newBridge);
    }

    function _setGuardian(address newGuardian) private {
        if (newGuardian == address(0)) revert ZeroAddress();
        guardian = newGuardian;
        emit GuardianSet(newGuardian);
    }
}
