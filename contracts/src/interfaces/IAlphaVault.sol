// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @notice The subset of ForeverMoney's alpha vault that the Bittensor-side adapter calls.
interface IAlphaVault {
    function depositLiquid(address token, uint256 minAlphaRao) external payable returns (uint256 minted);

    function withdrawLiquid(address token, uint256 wad, uint256 minTaoOut) external returns (uint256 taoOut);

    function isPaused() external view returns (bool);

    /// When an announced migration may execute; 0 while none is announced (from the announcement `depositLiquid` is
    /// closed, until ForeverMoney's `cancelMigration()` sets this back to 0 and reopens it). Read by the adapter's
    /// `canSendPayouts` (R4, S-H1), live each time.
    function migrationReadyAt() external view returns (uint256);

    /// Whether a migration has finished (the vault halted for good).
    function migrationFinished() external view returns (bool);

    function isListed(address token) external view returns (bool);

    function positionOf(address token) external view returns (bytes32 validator, uint256 netuid);

    function vaultColdkey() external view returns (bytes32);
}
