// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ICascadeBridge, ICascadeReceiver} from "./interfaces/ICascadeBridge.sol";
import {CascadeMessages} from "./libraries/CascadeMessages.sol";

/// @title CascadeVault
/// @notice Base-side vault of Cascade and the csTAO share token. Collects bridged-TAO deposits per
/// epoch and, when an epoch closes, bridges them to the StakeEngine with an epoch request.
/// @dev Assets leave this contract only through `cancelDeposit` refunds and the bridge pull in
/// `closeEpoch`. Ether leaves only as the bridge fee and its refund to the `closeEpoch` caller.
contract CascadeVault is ERC20, ICascadeReceiver, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum EpochStatus {
        Open,
        InFlight,
        Flagged,
        Settled
    }

    struct Epoch {
        uint64 start;
        EpochStatus status;
        uint256 totalDeposits;
        uint256 totalRedeemShares;
        uint256 supplyAtClose;
        uint256 assetsBefore;
        uint256 sharesMinted;
        uint256 assetsPaid;
    }

    // ---- state ----

    IERC20 public immutable asset;
    ICascadeBridge public bridge;
    address public guardian;

    uint64 public epochDuration;
    uint256 public tvlCap;
    uint256 public minDeposit;
    uint16 public maxAprBps;
    uint16 public maxDropBps;

    /// The open epoch. Ids start at 1.
    uint64 public currentEpochId;
    /// The epoch awaiting its result from the engine; 0 = none.
    uint64 public inFlightEpoch;

    uint256 public lastTotalAssets;
    uint256 public lastPrice;
    uint64 public lastPriceTime;

    mapping(uint64 => Epoch) private _epochs;
    mapping(uint64 => mapping(address => uint256)) public depositOf;
    mapping(uint64 => mapping(address => uint256)) public redeemOf;

    // ---- errors ----

    error UnsupportedDecimals();
    error BelowMinDeposit();
    error CapExceeded();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientRequest();
    error EpochNotOver();
    error EpochInFlight();
    error InsufficientFee();
    error RefundFailed();
    error NotBridge();
    error ValueMismatch();
    error UnexpectedEpoch();
    error NotFlagged();
    error NotSettled();
    error NothingToClaim();
    error InvalidBounds();
    error NotGuardian();
    error RenounceDisabled();

    // ---- events ----

    event DepositRequested(uint64 indexed epochId, address indexed receiver, uint256 assets);
    event DepositCancelled(uint64 indexed epochId, address indexed owner, uint256 assets);
    event RedeemRequested(uint64 indexed epochId, address indexed owner, uint256 shares);
    event RedeemCancelled(uint64 indexed epochId, address indexed owner, uint256 shares);
    event EpochRolled(uint64 indexed epochId);
    event EpochClosed(uint64 indexed epochId, uint256 totalDeposits, uint256 totalRedeemShares, uint256 supplyAtClose);
    event EpochSettled(uint64 indexed epochId, uint256 assetsBefore, uint256 sharesMinted, uint256 assetsPaid);
    event EpochFlagged(uint64 indexed epochId, uint256 assetsBefore, uint256 amount);
    event SharesClaimed(uint64 indexed epochId, address indexed user, uint256 shares);
    event AssetsClaimed(uint64 indexed epochId, address indexed user, uint256 assets);
    event CapsSet(uint256 tvlCap, uint256 minDeposit);
    event EpochDurationSet(uint64 epochDuration);
    event PriceBoundsSet(uint16 maxAprBps, uint16 maxDropBps);
    event BridgeSet(address indexed bridge);
    event GuardianSet(address indexed guardian);

    constructor(
        IERC20Metadata asset_,
        ICascadeBridge bridge_,
        address owner_,
        address guardian_,
        uint64 epochDuration_,
        uint256 tvlCap_,
        uint256 minDeposit_
    ) ERC20("Cascade Staked TAO", "csTAO") Ownable(owner_) {
        if (asset_.decimals() != 18) revert UnsupportedDecimals();
        asset = IERC20(address(asset_));
        _setBridge(address(bridge_));
        _setGuardian(guardian_);
        _setEpochDuration(epochDuration_);
        _setCaps(tvlCap_, minDeposit_);
        _setPriceBounds(2000, 10);

        currentEpochId = 1;
        _epochs[1].start = uint64(block.timestamp);
    }

    // ---- views ----

    /// @notice Asset 18 decimals + 6 decimals of virtual-share offset.
    function decimals() public pure override returns (uint8) {
        return 24;
    }

    function epochs(uint64 id) external view returns (Epoch memory) {
        return _epochs[id];
    }

    /// @notice Assets as of the last settlement plus deposits not yet settled (open and in flight).
    function totalAssetsEstimate() public view returns (uint256) {
        uint256 inFlightDeposits = inFlightEpoch != 0 ? _epochs[inFlightEpoch].totalDeposits : 0;
        return lastTotalAssets + _epochs[currentEpochId].totalDeposits + inFlightDeposits;
    }

    // ---- user actions ----

    /// @notice Pulls `assets` from the caller and credits them to `receiver` in the open epoch.
    function requestDeposit(uint256 assets, address receiver) external whenNotPaused nonReentrant {
        if (assets < minDeposit) revert BelowMinDeposit();
        if (totalAssetsEstimate() + assets > tvlCap) revert CapExceeded();
        if (receiver == address(0)) revert ZeroAddress();

        uint64 id = currentEpochId;
        depositOf[id][receiver] += assets;
        _epochs[id].totalDeposits += assets;
        emit DepositRequested(id, receiver, assets);

        asset.safeTransferFrom(msg.sender, address(this), assets);
    }

    /// @notice Withdraws part or all of the caller's deposit from the open epoch. Works while paused.
    function cancelDeposit(uint256 assets) external nonReentrant {
        uint64 id = currentEpochId;
        if (assets > depositOf[id][msg.sender]) revert InsufficientRequest();

        depositOf[id][msg.sender] -= assets;
        _epochs[id].totalDeposits -= assets;
        emit DepositCancelled(id, msg.sender, assets);

        asset.safeTransfer(msg.sender, assets);
    }

    // ---- epoch actions (permissionless) ----

    /// @notice Closes the open epoch once its duration has passed: bridges its deposits to the engine
    /// with an epoch request and opens the next epoch. An empty epoch just restarts its timer.
    /// msg.value pays the bridge fee; the excess is refunded to the caller.
    function closeEpoch() external payable whenNotPaused nonReentrant {
        uint64 id = currentEpochId;
        Epoch storage epoch = _epochs[id];
        // Seconds of validator skew are irrelevant against an epoch of hours or days.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < uint256(epoch.start) + epochDuration) revert EpochNotOver();
        if (inFlightEpoch != 0) revert EpochInFlight();

        if (epoch.totalDeposits == 0 && epoch.totalRedeemShares == 0) {
            epoch.start = uint64(block.timestamp);
            _refund(msg.value);
            emit EpochRolled(id);
            return;
        }

        // Effects before any external call.
        uint256 deposits = epoch.totalDeposits;
        uint256 redeemShares = epoch.totalRedeemShares;
        uint256 supply = totalSupply();
        epoch.supplyAtClose = supply;
        epoch.status = EpochStatus.InFlight;
        inFlightEpoch = id;
        currentEpochId = id + 1;
        _epochs[id + 1].start = uint64(block.timestamp);

        bytes memory message = CascadeMessages.encodeRequest(id, redeemShares, supply);
        uint256 fee = bridge.quoteFee(message, deposits);
        if (msg.value < fee) revert InsufficientFee();

        asset.forceApprove(address(bridge), deposits);
        bridge.send{value: fee}(message, deposits);
        _refund(msg.value - fee);
        emit EpochClosed(id, deposits, redeemShares, supply);
    }

    // ---- bridge ----

    /// @dev Access checks only; no epoch result is accepted yet.
    function onBridgeMessage(bytes calldata, uint256) external payable {
        if (msg.sender != address(bridge)) revert NotBridge();
        if (msg.value != 0) revert ValueMismatch();
        revert UnexpectedEpoch();
    }

    // ---- admin ----

    function setCaps(uint256 tvlCap_, uint256 minDeposit_) external onlyOwner {
        _setCaps(tvlCap_, minDeposit_);
    }

    function setEpochDuration(uint64 epochDuration_) external onlyOwner {
        _setEpochDuration(epochDuration_);
    }

    function setPriceBounds(uint16 maxAprBps_, uint16 maxDropBps_) external onlyOwner {
        _setPriceBounds(maxAprBps_, maxDropBps_);
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

    // ---- internal ----

    /// @dev Returns unused fee payment to the caller.
    function _refund(uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert RefundFailed();
    }

    function _setCaps(uint256 tvlCap_, uint256 minDeposit_) private {
        tvlCap = tvlCap_;
        minDeposit = minDeposit_;
        emit CapsSet(tvlCap_, minDeposit_);
    }

    function _setEpochDuration(uint64 epochDuration_) private {
        epochDuration = epochDuration_;
        emit EpochDurationSet(epochDuration_);
    }

    function _setPriceBounds(uint16 maxAprBps_, uint16 maxDropBps_) private {
        if (maxAprBps_ > 10000 || maxDropBps_ > 100) revert InvalidBounds();
        maxAprBps = maxAprBps_;
        maxDropBps = maxDropBps_;
        emit PriceBoundsSet(maxAprBps_, maxDropBps_);
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
