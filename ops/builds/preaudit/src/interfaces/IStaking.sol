// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Bittensor staking precompile address.
address constant ISTAKING_ADDRESS = 0x0000000000000000000000000000000000000805;

/// @notice Subset of the Bittensor staking precompile (stakingV2.sol) used by Cascade.
/// @dev The calling contract's coldkey is the mirror of its H160 address. Never send msg.value
/// to addStake: the precompile debits the contract's own balance.
interface IStaking {
    /// @param amount in rao, debited from caller balance
    function addStake(bytes32 hotkey, uint256 amount, uint256 netuid) external payable;

    /// @param amount in alpha (root: rao of TAO), credited to caller balance
    function removeStake(bytes32 hotkey, uint256 amount, uint256 netuid) external payable;

    /// @param amount in rao
    function moveStake(
        bytes32 origin_hotkey,
        bytes32 destination_hotkey,
        uint256 origin_netuid,
        uint256 destination_netuid,
        uint256 amount
    ) external payable;

    function getStake(bytes32 hotkey, bytes32 coldkey, uint256 netuid) external view returns (uint256);

    function claimRootWithHotkey(bytes32 hotkey) external;

    /// @return taoValue 18-decimal
    function getUnclaimedRootTaoByHotkey(bytes32 coldkey, bytes32 hotkey) external view returns (uint256 taoValue);

    function setRejectStakingHotkeyGrowth(bool enabled) external;

    /// @dev Removes the caller's entire stake on (hotkey, netuid), credited to caller balance.
    function removeStakeFull(bytes32 hotkey, uint256 netuid) external payable;

    /// @return minimum stake in rao for a default stake operation
    function getDefaultMinStake() external view returns (uint256);

    /// @return minimum nominator stake in rao
    function getNominatorMinRequiredStake() external view returns (uint256);
}
