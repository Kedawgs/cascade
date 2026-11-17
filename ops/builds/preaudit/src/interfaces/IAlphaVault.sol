// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The subset of ForeverMoney's alpha vault that the Bittensor-side adapter calls.
interface IAlphaVault {
    function depositLiquid(address token, uint256 minAlphaRao) external payable returns (uint256 minted);

    function withdrawLiquid(address token, uint256 wad, uint256 minTaoOut) external returns (uint256 taoOut);

    function isPaused() external view returns (bool);

    function isListed(address token) external view returns (bool);

    function positionOf(address token) external view returns (bytes32 validator, uint256 netuid);

    function vaultColdkey() external view returns (bytes32);
}
