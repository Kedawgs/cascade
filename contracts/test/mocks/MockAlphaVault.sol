// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IAlphaVault} from "../../src/interfaces/IAlphaVault.sol";
import {MockTAO} from "./MockTAO.sol";

/// @notice ForeverMoney alpha vault double over MockTAO: native TAO in mints the token one to one, burning
/// it pays native TAO out. The vault needs native funds to pay withdrawals (tests vm.deal it). `shortBy`
/// makes it deliver that many wei less than the nominal amount, after the slippage check, as the real
/// vault can when the chain rounds against it; `overpay` pays that many wei more on a withdrawal.
contract MockAlphaVault is IAlphaVault {
    error ZeroAmount();
    error NotWholeRao();
    error AmountTooLow();
    error Halted();
    error Migrating();
    error Slippage();
    error NativeTransferFailed();
    error NotListed();

    MockTAO public immutable token;
    uint256 public floorRao = 2_000_000;
    bool public paused;
    bool public migrating;
    uint256 public shortBy;
    uint256 public overpay;

    constructor(MockTAO token_) {
        token = token_;
    }

    receive() external payable {}

    function setPaused(bool on) external {
        paused = on;
    }

    function setMigrating(bool on) external {
        migrating = on;
    }

    function setFloorRao(uint256 v) external {
        floorRao = v;
    }

    function setShortBy(uint256 v) external {
        shortBy = v;
    }

    function setOverpay(uint256 v) external {
        overpay = v;
    }

    function depositLiquid(address token_, uint256 minAlphaRao) external payable returns (uint256 minted) {
        if (token_ != address(token)) revert NotListed();
        if (paused) revert Halted();
        if (migrating) revert Migrating();
        if (msg.value == 0) revert ZeroAmount();
        if (msg.value % 1e9 != 0) revert NotWholeRao();
        if (msg.value / 1e9 < floorRao) revert AmountTooLow();
        if (msg.value / 1e9 < minAlphaRao) revert Slippage();
        minted = msg.value - shortBy;
        token.mint(msg.sender, minted);
    }

    function withdrawLiquid(address token_, uint256 wad, uint256 minTaoOut) external returns (uint256 taoOut) {
        if (token_ != address(token)) revert NotListed();
        if (paused) revert Halted();
        if (wad == 0) revert ZeroAmount();
        if (wad % 1e9 != 0) revert NotWholeRao();
        if (wad / 1e9 < floorRao) revert AmountTooLow();
        token.burn(msg.sender, wad);
        if (wad < minTaoOut) revert Slippage();
        taoOut = wad - shortBy + overpay;
        (bool ok,) = msg.sender.call{value: taoOut}("");
        if (!ok) revert NativeTransferFailed();
    }

    function isPaused() external view returns (bool) {
        return paused;
    }

    function isListed(address token_) external view returns (bool) {
        return token_ == address(token);
    }

    function positionOf(address) external pure returns (bytes32 validator, uint256 netuid) {
        return (bytes32(uint256(1)), 0);
    }

    function vaultColdkey() external pure returns (bytes32) {
        return bytes32(uint256(2));
    }
}
