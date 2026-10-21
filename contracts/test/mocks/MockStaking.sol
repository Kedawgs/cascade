// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IStaking} from "../../src/interfaces/IStaking.sol";

/// @notice Faithful stand-in for the Bittensor staking precompile. Install with vm.etch at
/// ISTAKING_ADDRESS. Moves the caller's native balance with vm.deal, as the real precompile does.
contract MockStaking is IStaking {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 public constant MIN_STAKE_RAO = 2_000_000;

    error UnknownHotkey();
    error BelowMinStake();
    error InsufficientBalance();
    error InsufficientStake();
    error TooEarly();
    error UnexpectedValue();

    mapping(bytes32 => bool) internal hotkeys;
    mapping(bytes32 hotkey => mapping(bytes32 coldkey => mapping(uint256 netuid => uint256))) internal stakeRao;
    mapping(bytes32 coldkey => mapping(bytes32 hotkey => uint256)) internal unclaimedRao;
    mapping(bytes32 => bool) internal rejectGrowth;
    bool internal unstakeBlocked;

    /// @dev Deterministic stand-in for Bittensor's address mapping.
    function mirror(address a) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("evm:", a));
    }

    // ---- test configuration ----

    function addHotkey(bytes32 hotkey) external {
        hotkeys[hotkey] = true;
    }

    function accrueRootReward(bytes32 coldkey, bytes32 hotkey, uint256 rao) external {
        unclaimedRao[coldkey][hotkey] += rao;
    }

    function donateStake(bytes32 hotkey, bytes32 coldkey, uint256 rao) external {
        stakeRao[hotkey][coldkey][0] += rao;
    }

    function setUnstakeBlocked(bool blocked) external {
        unstakeBlocked = blocked;
    }

    function rejectsGrowth(bytes32 coldkey) external view returns (bool) {
        return rejectGrowth[coldkey];
    }

    // ---- IStaking ----

    function addStake(bytes32 hotkey, uint256 amount, uint256 netuid) external payable {
        if (msg.value != 0) revert UnexpectedValue();
        if (!hotkeys[hotkey]) revert UnknownHotkey();
        if (amount < MIN_STAKE_RAO) revert BelowMinStake();
        uint256 cost = amount * 1e9;
        if (msg.sender.balance < cost) revert InsufficientBalance();
        vm.deal(msg.sender, msg.sender.balance - cost);
        stakeRao[hotkey][mirror(msg.sender)][netuid] += amount;
    }

    function removeStake(bytes32 hotkey, uint256 amount, uint256 netuid) external payable {
        if (msg.value != 0) revert UnexpectedValue();
        if (unstakeBlocked) revert TooEarly();
        bytes32 coldkey = mirror(msg.sender);
        uint256 staked = stakeRao[hotkey][coldkey][netuid];
        // Subtensor rejects a partial unstake below its minimum stake (AmountTooLow).
        if (amount < MIN_STAKE_RAO && amount != staked) revert BelowMinStake();
        if (staked < amount) revert InsufficientStake();
        stakeRao[hotkey][coldkey][netuid] -= amount;
        vm.deal(msg.sender, msg.sender.balance + amount * 1e9);
    }

    function moveStake(
        bytes32 origin_hotkey,
        bytes32 destination_hotkey,
        uint256 origin_netuid,
        uint256 destination_netuid,
        uint256 amount
    ) external payable {
        if (msg.value != 0) revert UnexpectedValue();
        if (!hotkeys[destination_hotkey]) revert UnknownHotkey();
        bytes32 coldkey = mirror(msg.sender);
        if (stakeRao[origin_hotkey][coldkey][origin_netuid] < amount) revert InsufficientStake();
        stakeRao[origin_hotkey][coldkey][origin_netuid] -= amount;
        stakeRao[destination_hotkey][coldkey][destination_netuid] += amount;
    }

    function getStake(bytes32 hotkey, bytes32 coldkey, uint256 netuid) external view returns (uint256) {
        return stakeRao[hotkey][coldkey][netuid];
    }

    function claimRootWithHotkey(bytes32 hotkey) external {
        bytes32 coldkey = mirror(msg.sender);
        uint256 rao = unclaimedRao[coldkey][hotkey];
        unclaimedRao[coldkey][hotkey] = 0;
        stakeRao[hotkey][coldkey][0] += rao;
    }

    function getUnclaimedRootTaoByHotkey(bytes32 coldkey, bytes32 hotkey) external view returns (uint256) {
        return unclaimedRao[coldkey][hotkey] * 1e9;
    }

    function setRejectStakingHotkeyGrowth(bool enabled) external {
        rejectGrowth[mirror(msg.sender)] = enabled;
    }
}
