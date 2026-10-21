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
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ICascadeBridge, ICascadeReceiver} from "./interfaces/ICascadeBridge.sol";
import {CascadeMath} from "./libraries/CascadeMath.sol";
import {CascadeMessages} from "./libraries/CascadeMessages.sol";

/// @title CascadeVault
/// @notice Base-side vault of Cascade and the csTAO share token. Collects bridged-TAO deposits and
/// escrowed redemptions per epoch, bridges them to the StakeEngine with an epoch request when the
/// epoch closes, and settles the epoch from the engine's result.
/// @dev Assets leave this contract only through `cancelDeposit` refunds, the bridge pull in
/// `closeEpoch`, and `claimAssets`. Ether leaves only as the bridge fee and its refund to the
/// `closeEpoch` caller. The vault never trusts a share or payout figure from the bridge: it
/// recomputes both from the single reported `assetsBefore` and bounds that number.
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

    /// @notice csTAO `user` can claim for their deposit in `epochId`; 0 unless the epoch is settled.
    function claimableShares(uint64 epochId, address user) public view returns (uint256) {
        Epoch storage epoch = _epochs[epochId];
        uint256 deposited = depositOf[epochId][user];
        // A non-zero entry implies a non-zero `totalDeposits`.
        if (epoch.status != EpochStatus.Settled || deposited == 0) return 0;
        return Math.mulDiv(deposited, epoch.sharesMinted, epoch.totalDeposits);
    }

    /// @notice Assets `user` can claim for their redemption in `epochId`; 0 unless the epoch is settled.
    function claimableAssets(uint64 epochId, address user) public view returns (uint256) {
        Epoch storage epoch = _epochs[epochId];
        uint256 redeemed = redeemOf[epochId][user];
        // A non-zero entry implies a non-zero `totalRedeemShares`.
        if (epoch.status != EpochStatus.Settled || redeemed == 0) return 0;
        return Math.mulDiv(redeemed, epoch.assetsPaid, epoch.totalRedeemShares);
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

    /// @notice Escrows `shares` of the caller in the vault for redemption when the open epoch settles.
    function requestRedeem(uint256 shares) external whenNotPaused {
        if (shares == 0) revert ZeroAmount();

        uint64 id = currentEpochId;
        redeemOf[id][msg.sender] += shares;
        _epochs[id].totalRedeemShares += shares;
        emit RedeemRequested(id, msg.sender, shares);

        _transfer(msg.sender, address(this), shares);
    }

    /// @notice Returns part or all of the caller's escrowed shares from the open epoch. Works while paused.
    function cancelRedeem(uint256 shares) external {
        uint64 id = currentEpochId;
        if (shares > redeemOf[id][msg.sender]) revert InsufficientRequest();

        redeemOf[id][msg.sender] -= shares;
        _epochs[id].totalRedeemShares -= shares;
        emit RedeemCancelled(id, msg.sender, shares);

        _transfer(address(this), msg.sender, shares);
    }

    /// @notice Sends the caller the csTAO minted for their deposit in a settled epoch. Works while paused.
    function claimShares(uint64 epochId) external nonReentrant {
        if (_epochs[epochId].status != EpochStatus.Settled) revert NotSettled();
        uint256 shares = claimableShares(epochId, msg.sender);
        if (shares == 0) revert NothingToClaim();

        depositOf[epochId][msg.sender] = 0;
        emit SharesClaimed(epochId, msg.sender, shares);

        _transfer(address(this), msg.sender, shares);
    }

    /// @notice Sends the caller the assets paid out for their redemption in a settled epoch.
    /// Works while paused.
    function claimAssets(uint64 epochId) external nonReentrant {
        if (_epochs[epochId].status != EpochStatus.Settled) revert NotSettled();
        uint256 assets = claimableAssets(epochId, msg.sender);
        if (assets == 0) revert NothingToClaim();

        redeemOf[epochId][msg.sender] = 0;
        emit AssetsClaimed(epochId, msg.sender, assets);

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
        asset.forceApprove(address(bridge), 0);
        _refund(msg.value - fee);
        emit EpochClosed(id, deposits, redeemShares, supply);
    }

    // ---- bridge ----

    /// @notice Receives the engine's result for the in-flight epoch; `amount` is the redemption
    /// payout, transferred to the vault before the call. Works while paused.
    /// @dev Shares and payout are recomputed from `assetsBefore`. A result outside the bounds never
    /// reverts: it is stored, the epoch is flagged and the vault pauses for the owner to review.
    function onBridgeMessage(bytes calldata message, uint256 amount) external payable {
        if (msg.sender != address(bridge)) revert NotBridge();
        if (msg.value != 0) revert ValueMismatch();
        (uint64 epochId, uint256 assetsBefore) = CascadeMessages.decodeResult(message);
        Epoch storage epoch = _epochs[epochId];
        if (epochId == 0 || epochId != inFlightEpoch || epoch.status != EpochStatus.InFlight) {
            revert UnexpectedEpoch();
        }

        if (_amountInBounds(epoch, assetsBefore, amount) && _priceInBounds(epoch, assetsBefore)) {
            _applySettlement(epochId, assetsBefore, amount);
        } else {
            epoch.assetsBefore = assetsBefore;
            epoch.assetsPaid = amount;
            epoch.status = EpochStatus.Flagged;
            if (!paused()) _pause();
            emit EpochFlagged(epochId, assetsBefore, amount);
        }
    }

    // ---- admin ----

    /// @notice Applies the stored result of the flagged in-flight epoch after review. The vault
    /// stays paused until the owner unpauses.
    function acceptFlaggedEpoch() external onlyOwner {
        uint64 id = inFlightEpoch;
        Epoch storage epoch = _epochs[id];
        if (epoch.status != EpochStatus.Flagged) revert NotFlagged();
        _applySettlement(id, epoch.assetsBefore, epoch.assetsPaid);
    }

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

    /// @dev Mints the epoch's deposit shares to the vault (held for `claimShares`), burns its
    /// escrowed redemption shares, and records the new total assets and price.
    function _applySettlement(uint64 epochId, uint256 assetsBefore, uint256 amount) private {
        Epoch storage epoch = _epochs[epochId];
        uint256 deposits = epoch.totalDeposits;
        uint256 minted = CascadeMath.sharesForDeposit(deposits, assetsBefore, epoch.supplyAtClose);

        epoch.assetsBefore = assetsBefore;
        epoch.sharesMinted = minted;
        epoch.assetsPaid = amount;
        epoch.status = EpochStatus.Settled;
        inFlightEpoch = 0;

        _mint(address(this), minted);
        _burn(address(this), epoch.totalRedeemShares);

        uint256 totalAssets = assetsBefore + deposits - amount;
        lastTotalAssets = totalAssets;
        lastPrice = CascadeMath.price(totalAssets, totalSupply());
        lastPriceTime = uint64(block.timestamp);
        emit EpochSettled(epochId, assetsBefore, minted, amount);
    }

    /// @dev The payout may fall short of the recomputed redemption value by at most 1e9 wei (one rao)
    /// and never exceed it.
    function _amountInBounds(Epoch storage epoch, uint256 assetsBefore, uint256 amount) private view returns (bool) {
        uint256 expectedPay = CascadeMath.assetsForRedeem(epoch.totalRedeemShares, assetsBefore, epoch.supplyAtClose);
        return amount <= expectedPay && amount + 1e9 >= expectedPay;
    }

    /// @dev The reported price may drop by at most `maxDropBps` and rise by at most `maxAprBps`
    /// annualised since the last price, plus a 1e-9 relative tolerance. Unchecked with no supply
    /// (depositors own everything) or before the first price.
    function _priceInBounds(Epoch storage epoch, uint256 assetsBefore) private view returns (bool) {
        uint256 supply = epoch.supplyAtClose;
        if (supply == 0 || lastPriceTime == 0) return true;

        uint256 p = CascadeMath.price(assetsBefore, supply);
        uint256 last = lastPrice;
        uint256 minPrice = last - last * maxDropBps / 10000;
        uint256 elapsed = block.timestamp - lastPriceTime;
        uint256 maxPrice = last + Math.mulDiv(last, uint256(maxAprBps) * elapsed, 10000 * 365 days) + last / 1e9 + 1;
        return p >= minPrice && p <= maxPrice;
    }

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
