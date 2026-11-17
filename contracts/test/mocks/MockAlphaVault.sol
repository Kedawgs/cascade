// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAlphaVault} from "../../src/interfaces/IAlphaVault.sol";
import {IStaking, ISTAKING_ADDRESS} from "../../src/interfaces/IStaking.sol";
import {MockStaking} from "./MockStaking.sol";
import {MockTAO} from "./MockTAO.sol";
import {mirror} from "./Mirror.sol";

/// @notice ForeverMoney's `AlphaVault` as the Bittensor adapter meets it (R3 TH-1, FM-L1, FM-I1): the behaviour of the
/// deployed code (bridge-contracts e80a443 on chain 964) for every call the adapter makes, written from that behaviour
/// over MockTAO and the staking precompile double, which must be etched at ISTAKING_ADDRESS before this is built (the
/// constructor registers VALIDATOR there and seeds the position). Its errors are ForeverMoney's, by name and so by
/// selector.
/// - `depositLiquid(token, minAlphaRao)`: `IsHalted`, `MigrationInProgress`, then the lock, `UnknownToken`,
///   `ZeroAmount`, `NotWholeRao`; then `addStake(VALIDATOR, msg.value / RAO, 0)` on the precompile, whose own refusals
///   (its minimum stake among them) surface as they are; the stake it MEASURED must pass `received < minAlphaRao ||
///   received == 0` (`Slippage`), and it mints `received * RAO`.
/// - `withdrawLiquid(token, wad, minTaoOut)`: `IsHalted`, then the lock, `UnknownToken`, `ZeroAmount`, `NotWholeRao`,
///   `InsufficientBalance`; burns `wad`; `Insolvent` when the position cannot cover it; `removeStake` on the
///   precompile; the native TAO it MEASURED must pass `taoOut < minTaoOut || taoOut == 0` (`Slippage`); pays the
///   caller with all the gas (`NativeTransferFailed`). No migration gate.
/// - The halt is a clock, `isPaused()` while `block.timestamp < pausedUntil`: the guardian's `guardianPause(dur)` of at
///   most MAX_PAUSE a shot, extend-only, with a COOLDOWN before its next; the operator's `adminHold(until)` for any
///   finite time and `unpause()`. A migration's `initiateMigration` closes deposits at once for its MIGRATION_DELAY
///   notice and leaves withdrawals open; `executeMigration` moves the position away (withdrawals are then
///   `Insolvent`), `finishMigration` halts for good, and `cancelMigration` reopens deposits while nothing has moved.
///   No roles: a test calling them is ForeverMoney's Safe. `initiateMigration` takes no target.
/// - No floor of its own (the chain's minimum is the precompile's), and a plain native send bounces
///   (`DirectSendNotAllowed`) except while an unstake is in flight.
/// The position starts at SEED_RAO on VALIDATOR (netuid 0, the vault's coldkey the mirror of its address), standing in
/// for ForeverMoney's live position and for the stake behind every bridged token the tests' routers mint.
/// Test knobs, none of them ForeverMoney's, each whole rao (the chain moves rao): `shortBy` lowers the stake a deposit
/// measures and the TAO a withdrawal measures, `overmint` raises the first and `overpay` the second, as the chain
/// rounding against or in favour of the vault would; `burnGas` makes a withdrawal consume every unit of gas it is
/// given and `revertBomb`, when non-zero, revert with that many bytes, `Bomb()` then zeros; `overburn` makes a
/// withdrawal burn that much more than `wad` of the caller's tokens (R4, F-3: ForeverMoney's own burns exactly `wad`).
/// Harness note: MockStaking moves native value by value transfers since Task 35 (addStake's debit to a sink, a
/// removal's credit by a call), which a caught revert undoes, so after a refused conversion this contract's own native
/// balance is as before it; the position (`stakedValueRao`) remains the tests' measure.
contract MockAlphaVault is IAlphaVault, ReentrancyGuard {
    // ForeverMoney's errors (AlphaVault.sol at e80a443)
    error ZeroAmount();
    error NotWholeRao();
    error Slippage();
    error Insolvent();
    error IsHalted();
    error MigrationInProgress();
    error UnknownToken();
    error InsufficientBalance(uint256 balance, uint256 needed);
    error NativeTransferFailed();
    error DirectSendNotAllowed();
    error PauseCapExceeded();
    error PauseCooldown();
    error MigrationNotInitiated();
    error MigrationNotReady();
    error MigrationPending();
    error MigrationAlreadyFinished();
    error MigrationIrreversible();
    error NothingMigrated();
    // the test knob's
    error Bomb();

    uint256 public constant MAX_PAUSE = 2 days;
    uint256 public constant COOLDOWN = 12 hours;
    uint256 public constant MIGRATION_DELAY = 7 days;
    bytes32 public constant VALIDATOR = keccak256("MockAlphaVault validator");
    /// One million TAO, in rao: ForeverMoney's live position held 15,031 TAO on 2026-11-05.
    uint256 public constant SEED_RAO = 1_000_000e9;
    uint256 private constant RAO = 1e9;
    uint256 private constant WINDOW_SHUT = 1;
    uint256 private constant WINDOW_OPEN = 2;
    IStaking private constant STAKING = IStaking(ISTAKING_ADDRESS);

    MockTAO public immutable token;
    bytes32 public immutable coldkey;

    uint256 public pausedUntil;
    uint256 public pauseableAfter;
    uint256 public migrationReadyAt;
    bool public migrationExecuted;
    bool public migrationFinished;
    /// Open only around the precompile's removeStake, 1 or 2 (never 0), as ForeverMoney keeps its window.
    uint256 private unstakeWindow = WINDOW_SHUT;

    uint256 public shortBy;
    uint256 public overpay;
    uint256 public overmint;
    bool public burnGas;
    uint256 public revertBomb;
    /// R4 (F-3): the tokens a withdrawal burns beyond `wad` (whole rao), as an AlphaVault that over-burns would.
    uint256 public overburn;

    constructor(MockTAO token_) {
        token = token_;
        coldkey = mirror(address(this));
        MockStaking(ISTAKING_ADDRESS).addHotkey(VALIDATOR);
        MockStaking(ISTAKING_ADDRESS).donateStake(VALIDATOR, coldkey, SEED_RAO);
    }

    /// Bounces every plain send, except a precompile credit paid by call while an unstake is in flight.
    receive() external payable {
        if (unstakeWindow != WINDOW_OPEN) revert DirectSendNotAllowed();
    }

    // ---- test knobs ----

    function setShortBy(uint256 v) external {
        shortBy = _wholeRao(v);
    }

    function setOverpay(uint256 v) external {
        overpay = _wholeRao(v);
    }

    function setOvermint(uint256 v) external {
        overmint = _wholeRao(v);
    }

    function setBurnGas(bool on) external {
        burnGas = on;
    }

    function setOverburn(uint256 v) external {
        overburn = _wholeRao(v);
    }

    function setRevertBomb(uint256 size) external {
        revertBomb = size;
    }

    // ---- the halt ----

    function guardianPause(uint256 dur) external {
        if (dur == 0 || dur > MAX_PAUSE) revert PauseCapExceeded();
        if (block.timestamp < pauseableAfter) revert PauseCooldown();
        uint256 until = block.timestamp + dur;
        pauseableAfter = until + COOLDOWN;
        if (until > pausedUntil) pausedUntil = until;
    }

    function unpause() external {
        _lift();
    }

    function adminHold(uint256 until) external {
        if (until > block.timestamp) {
            pausedUntil = until;
            uint256 cooldownEnd = until + COOLDOWN;
            if (cooldownEnd < pauseableAfter) pauseableAfter = cooldownEnd;
        } else {
            _lift();
        }
    }

    function isPaused() public view returns (bool) {
        return block.timestamp < pausedUntil;
    }

    // ---- a migration ----

    function initiateMigration() external {
        if (migrationFinished) revert MigrationAlreadyFinished();
        if (migrationReadyAt != 0) revert MigrationPending();
        migrationReadyAt = block.timestamp + MIGRATION_DELAY;
    }

    function cancelMigration() external {
        if (migrationReadyAt == 0) revert MigrationNotInitiated();
        if (migrationExecuted) revert MigrationIrreversible();
        migrationReadyAt = 0;
    }

    /// The whole position leaves for the target's coldkey (MockStaking has no transferStake: it is taken off).
    function executeMigration() external {
        _requireMigrationReady();
        migrationExecuted = true;
        MockStaking(ISTAKING_ADDRESS).loseStake(VALIDATOR, coldkey, stakedValueRao(address(token)));
    }

    function finishMigration() external {
        _requireMigrationReady();
        if (!migrationExecuted) revert NothingMigrated();
        migrationFinished = true;
        migrationReadyAt = 0;
        pausedUntil = type(uint256).max;
    }

    // ---- the adapter's calls ----

    /// ForeverMoney's gates run before its lock, as the deployed modifiers are ordered (`whenNotHalted`,
    /// `whenNotMigrating`, then `nonReentrant`): a gate closed while a caller holds the lock refuses with the gate's
    /// error, not the lock's (R3 re-review, new breakage 4).
    modifier whenNotHalted() {
        if (isPaused()) revert IsHalted();
        _;
    }

    modifier whenNotMigrating() {
        if (migrationReadyAt != 0 || migrationFinished) revert MigrationInProgress();
        _;
    }

    function depositLiquid(address token_, uint256 minAlphaRao)
        external
        payable
        whenNotHalted
        whenNotMigrating
        nonReentrant
        returns (uint256 minted)
    {
        _onlyListed(token_);
        if (msg.value == 0) revert ZeroAmount();
        if (msg.value % RAO != 0) revert NotWholeRao();
        uint256 s0 = _staked();
        STAKING.addStake(VALIDATOR, msg.value / RAO, 0);
        uint256 received = _staked() - s0 + overmint / RAO - shortBy / RAO;
        if (received < minAlphaRao || received == 0) revert Slippage();
        minted = received * RAO;
        token.mint(msg.sender, minted);
    }

    function withdrawLiquid(address token_, uint256 wad, uint256 minTaoOut)
        external
        whenNotHalted
        nonReentrant
        returns (uint256 taoOut)
    {
        _onlyListed(token_);
        if (wad == 0) revert ZeroAmount();
        if (wad % RAO != 0) revert NotWholeRao();
        uint256 bal = token.balanceOf(msg.sender);
        if (bal < wad) revert InsufficientBalance(bal, wad);
        if (revertBomb != 0) {
            uint256 size = revertBomb;
            bytes4 bomb = Bomb.selector;
            assembly {
                mstore(0, bomb)
                revert(0, size)
            }
        }
        if (burnGas) {
            assembly ("memory-safe") {
                invalid()
            }
        }
        token.burn(msg.sender, wad + overburn);
        uint256 alphaRao = wad / RAO;
        if (alphaRao > _staked()) revert Insolvent();
        uint256 b0 = address(this).balance;
        unstakeWindow = WINDOW_OPEN;
        STAKING.removeStake(VALIDATOR, alphaRao, 0);
        unstakeWindow = WINDOW_SHUT;
        taoOut = address(this).balance - b0 + overpay - shortBy;
        if (taoOut < minTaoOut || taoOut == 0) revert Slippage();
        (bool ok,) = msg.sender.call{value: taoOut}("");
        if (!ok) revert NativeTransferFailed();
    }

    // ---- views ----

    function stakedValueRao(address token_) public view returns (uint256) {
        _onlyListed(token_);
        return _staked();
    }

    function isListed(address token_) external view returns (bool) {
        return token_ == address(token);
    }

    function positionOf(address token_) external view returns (bytes32 validator, uint256 netuid) {
        _onlyListed(token_);
        return (VALIDATOR, 0);
    }

    function vaultColdkey() external view returns (bytes32) {
        return coldkey;
    }

    // ---- internals ----

    function _staked() private view returns (uint256) {
        return STAKING.getStake(VALIDATOR, coldkey, 0);
    }

    function _onlyListed(address token_) private view {
        if (token_ != address(token)) revert UnknownToken();
    }

    function _lift() private {
        pausedUntil = 0;
        uint256 cooldownEnd = block.timestamp + COOLDOWN;
        if (cooldownEnd < pauseableAfter) pauseableAfter = cooldownEnd;
    }

    function _requireMigrationReady() private view {
        if (migrationReadyAt == 0) revert MigrationNotInitiated();
        if (block.timestamp < migrationReadyAt) revert MigrationNotReady();
    }

    function _wholeRao(uint256 v) private pure returns (uint256) {
        if (v % RAO != 0) revert NotWholeRao();
        return v;
    }
}
