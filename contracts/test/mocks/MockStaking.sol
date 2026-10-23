// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IStaking} from "../../src/interfaces/IStaking.sol";
import {mirror} from "./Mirror.sol";

/// @notice Test double for the staking precompile. Etch at ISTAKING_ADDRESS with vm.etch (constructors
/// never run), so every setting is zero-valued by default and means "use the real-chain default".
/// Like the precompile it debits/credits the caller's native balance directly (rao * 1e9 wei).
contract MockStaking is IStaking {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error UnknownHotkey();
    error BelowMinStake();
    error AmountTooLow();
    error InsufficientBalance();
    error InsufficientStake();
    error TooEarly();
    error UnexpectedValue();

    uint256 private constant RAO_TO_WEI = 1e9;

    // Overrides: 0 means default.
    uint256 public minStakeOverride;
    uint256 public nominatorMinOverride;
    uint256 public claimGasOverride;
    /// @dev false (default) means a credit into an empty position lands one rao short.
    bool public exactStakeReads;
    bool public claimTooHeavy;
    bool public unstakeBlocked;
    /// @dev A chain fee, in rao, deducted from what each removeStake / removeStakeFull credits.
    uint256 public removeFeeRao;
    /// @dev true pays a claim out as the caller's native balance instead of stake on the hotkey.
    bool public claimToBalance;

    mapping(bytes32 hotkey => bool) public knownHotkey;
    mapping(bytes32 hotkey => mapping(bytes32 coldkey => mapping(uint256 netuid => uint256))) private _stake;
    mapping(bytes32 coldkey => mapping(bytes32 hotkey => uint256)) private _unclaimed;
    mapping(bytes32 coldkey => bool) private _rejectsGrowth;

    // ---- test configuration ----

    function addHotkey(bytes32 hotkey) external {
        knownHotkey[hotkey] = true;
    }

    function setMinStake(uint256 v) external {
        minStakeOverride = v;
    }

    function setNominatorMin(uint256 v) external {
        nominatorMinOverride = v;
    }

    function setClaimGasRequired(uint256 v) external {
        claimGasOverride = v;
    }

    function setOneRaoShort(bool on) external {
        exactStakeReads = !on;
    }

    function setClaimTooHeavy(bool v) external {
        claimTooHeavy = v;
    }

    function setUnstakeBlocked(bool v) external {
        unstakeBlocked = v;
    }

    function setRemoveFeeRao(uint256 rao) external {
        removeFeeRao = rao;
    }

    function setClaimToBalance(bool v) external {
        claimToBalance = v;
    }

    /// @dev Sets (does not add to) the unclaimed root amount, in rao.
    function setUnclaimed(bytes32 coldkey, bytes32 hotkey, uint256 rao) external {
        _unclaimed[coldkey][hotkey] = rao;
    }

    function donateStake(bytes32 hotkey, bytes32 coldkey, uint256 rao) external {
        _stake[hotkey][coldkey][0] += rao;
    }

    function rejectsGrowth(bytes32 coldkey) external view returns (bool) {
        return _rejectsGrowth[coldkey];
    }

    // ---- IStaking ----

    function addStake(bytes32 hotkey, uint256 amount, uint256 netuid) external payable {
        if (msg.value != 0) revert UnexpectedValue();
        if (!knownHotkey[hotkey]) revert UnknownHotkey();
        if (amount < _minStake()) revert BelowMinStake();
        uint256 cost = amount * RAO_TO_WEI;
        if (msg.sender.balance < cost) revert InsufficientBalance();
        vm.deal(msg.sender, msg.sender.balance - cost);
        _credit(hotkey, mirror(msg.sender), netuid, amount);
    }

    function removeStake(bytes32 hotkey, uint256 amount, uint256 netuid) external payable {
        if (unstakeBlocked) revert TooEarly();
        bytes32 cold = mirror(msg.sender);
        uint256 staked = _stake[hotkey][cold][netuid];
        if (amount > staked) amount = staked;
        if (amount < _minStake() && amount != staked) revert AmountTooLow();
        uint256 remainder = staked - amount;
        uint256 removed = amount;
        if (remainder != 0 && remainder < _nominatorMin()) {
            removed = staked;
            remainder = 0;
        }
        _stake[hotkey][cold][netuid] = remainder;
        _payOut(_afterFee(removed));
    }

    function removeStakeFull(bytes32 hotkey, uint256 netuid) external payable {
        if (unstakeBlocked) revert TooEarly();
        bytes32 cold = mirror(msg.sender);
        uint256 staked = _stake[hotkey][cold][netuid];
        _stake[hotkey][cold][netuid] = 0;
        _payOut(_afterFee(staked));
    }

    function moveStake(
        bytes32 originHotkey,
        bytes32 destHotkey,
        uint256 originNetuid,
        uint256 destNetuid,
        uint256 amount
    ) external payable {
        if (!knownHotkey[destHotkey]) revert UnknownHotkey();
        bytes32 cold = mirror(msg.sender);
        if (amount > _stake[originHotkey][cold][originNetuid]) revert InsufficientStake();
        _stake[originHotkey][cold][originNetuid] -= amount;
        _credit(destHotkey, cold, destNetuid, amount);
    }

    function getStake(bytes32 hotkey, bytes32 coldkey, uint256 netuid) external view returns (uint256) {
        return _stake[hotkey][coldkey][netuid];
    }

    function claimRootWithHotkey(bytes32 hotkey) external {
        if (gasleft() < _claimGas() || claimTooHeavy) {
            // Burns all forwarded gas, like a dispatch failure on the real precompile.
            assembly {
                invalid()
            }
        }
        bytes32 cold = mirror(msg.sender);
        uint256 amount = _unclaimed[cold][hotkey];
        _unclaimed[cold][hotkey] = 0;
        if (claimToBalance) _payOut(amount);
        else _stake[hotkey][cold][0] += amount;
    }

    /// @return taoValue 18-decimal (rao * 1e9)
    function getUnclaimedRootTaoByHotkey(bytes32 coldkey, bytes32 hotkey) external view returns (uint256 taoValue) {
        return _unclaimed[coldkey][hotkey] * RAO_TO_WEI;
    }

    function setRejectStakingHotkeyGrowth(bool enabled) external {
        _rejectsGrowth[mirror(msg.sender)] = enabled;
    }

    function getDefaultMinStake() external view returns (uint256) {
        return _minStake();
    }

    function getNominatorMinRequiredStake() external view returns (uint256) {
        return _nominatorMin();
    }

    // ---- internals ----

    function _minStake() private view returns (uint256) {
        return minStakeOverride == 0 ? 2_000_000 : minStakeOverride;
    }

    function _nominatorMin() private view returns (uint256) {
        return nominatorMinOverride == 0 ? 20_000_000 : nominatorMinOverride;
    }

    function _claimGas() private view returns (uint256) {
        return claimGasOverride == 0 ? 53_200_000 : claimGasOverride;
    }

    /// @dev Any credit into an empty position lands one rao short unless exactStakeReads is set.
    function _credit(bytes32 hotkey, bytes32 coldkey, uint256 netuid, uint256 rao) private {
        uint256 current = _stake[hotkey][coldkey][netuid];
        _stake[hotkey][coldkey][netuid] = current + ((current == 0 && !exactStakeReads && rao != 0) ? rao - 1 : rao);
    }

    function _afterFee(uint256 rao) private view returns (uint256) {
        return rao > removeFeeRao ? rao - removeFeeRao : 0;
    }

    function _payOut(uint256 rao) private {
        vm.deal(msg.sender, msg.sender.balance + rao * RAO_TO_WEI);
    }
}
