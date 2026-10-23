// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CascadeBase} from "./CascadeBase.sol";
import {ICascadeBridge, ICascadeReceiver} from "./interfaces/ICascadeBridge.sol";
import {CascadeMessages} from "./libraries/CascadeMessages.sol";

/// @notice Cascade front door on Base: holds bridged TAO, collects deposits and redeem requests
/// into one open batch (one merged entry per user per list) and forwards the batch to the vault
/// through the primary bridge. It never prices anything; the vault does.
/// @dev Redeem requests need no shares (the front door cannot see Bittensor), so the first request
/// per user per batch pays `redeemRequestFee` in ETH into the batch's fee pot, the pot pays the
/// batch's bridge fee first, and a request that meets a full redeem list closes the batch itself.
/// ETH held always equals the open batch's `feePot` plus `totalFeeCredit`. Payouts from the vault
/// arrive in chunks and are credited for users to claim; the asset held is always at least the open
/// batch's `totalDeposits` plus `totalClaimable`.
contract CascadeFrontDoor is CascadeBase, ICascadeReceiver {
    using SafeERC20 for IERC20Metadata;

    // ---- constants and immutables ----

    uint256 public constant RAO = 1e9;

    IERC20Metadata public immutable asset;
    uint64 public immutable vaultChain;
    address public immutable vault;

    // ---- state ----

    struct Batch {
        uint64 id;
        uint64 start;
        uint256 totalDeposits;
        uint256 feePot;
        CascadeMessages.Entry[] deposits;
        CascadeMessages.Entry[] redeems;
    }

    Batch internal open;
    /// Index + 1 of a user's entry in the open batch's lists (0 = none), keyed by batch id so a
    /// closed batch's slots are orphaned rather than cleared.
    mapping(uint64 => mapping(address => uint256)) internal depositSlot;
    mapping(uint64 => mapping(address => uint256)) internal redeemSlot;

    // payouts in, claims out
    mapping(address => uint256) public claimable;
    uint256 public totalClaimable;
    /// Forwarded deposits minus payouts received, floored at 0.
    uint256 public netForwarded;
    /// Replay record, per delivering bridge and message hash: an adapter can only occupy its own
    /// slots, never an honest adapter's (batch keys and chunk numbers are predictable).
    mapping(address bridge => mapping(bytes32 messageHash => bool)) public delivered;

    // pre-paid redeem-request fees
    mapping(address => uint256) public feeCredit;
    uint256 public totalFeeCredit;

    // parameters
    uint64 public batchInterval;
    uint32 public maxDeposits;
    uint32 public maxRedeems;
    uint256 public minDeposit;
    uint256 public depositCap;
    uint256 public redeemRequestFee;
    uint256 public maxBatchValue;

    // ---- errors ----

    error UnsupportedDecimals();
    error ZeroAmount();
    error NotRaoAligned();
    error BelowMinDeposit();
    error CapExceeded();
    error BatchValueFull();
    error BatchFull();
    error InsufficientRequest();
    error WrongFee();
    error BatchNotReady();
    error InsufficientFee();
    error TransferFailed();
    error InvalidParameter();
    error DirectTransferNotAllowed();
    error UnknownPeer();
    error ValueMismatch();
    error AmountMismatch();
    error TokensNotReceived();
    error DuplicatePayouts();
    error NothingToClaim();

    // ---- events ----

    event DepositRequested(uint64 indexed batchId, address indexed user, uint256 amount, address payer);
    event DepositCancelled(uint64 indexed batchId, address indexed user, uint256 amount);
    event FeeCredited(address indexed user, uint256 amount, address payer);
    event FeeCreditSpent(address indexed user, uint256 amount);
    event RedeemRequested(uint64 indexed batchId, address indexed user, uint256 shares);
    event RedeemCancelled(uint64 indexed batchId, address indexed user, uint256 shares);
    /// `potUsed` is the part of `fee` paid from the batch's fee pot; the closer paid the rest.
    event BatchClosed(
        uint64 indexed id, uint256 totalDeposits, uint256 nDeposits, uint256 nRedeems, uint256 fee, uint256 potUsed
    );
    /// An empty batch reached its close: the timer restarted and the id stayed.
    event BatchRolled(uint64 indexed id);
    event LimitSet(bytes32 indexed name, uint256 a, uint256 b);
    event PayoutsDelivered(bytes32 indexed batchKey, uint32 chunk, uint256 amount, address bridge);
    event PayoutReceived(bytes32 indexed batchKey, uint32 chunk, address indexed user, uint256 amount);
    event Claimed(address indexed user, uint256 amount);

    // ---- constructor ----

    constructor(
        IERC20Metadata asset_,
        ICascadeBridge bridge,
        uint64 vaultChain_,
        address vault_,
        address owner_,
        address guardian_,
        uint64 batchInterval_,
        uint256 minDeposit_,
        uint256 depositCap_,
        uint256 redeemRequestFee_
    ) CascadeBase(owner_, guardian_, address(bridge)) {
        if (asset_.decimals() != 18) revert UnsupportedDecimals();
        if (vault_ == address(0)) revert ZeroAddress();
        asset = asset_;
        vaultChain = vaultChain_;
        vault = vault_;
        batchInterval = batchInterval_;
        minDeposit = minDeposit_;
        depositCap = depositCap_;
        redeemRequestFee = redeemRequestFee_;
        maxDeposits = 50;
        maxRedeems = 50;
        maxBatchValue = 4_000e18;
        open.id = 1;
        open.start = uint64(block.timestamp);
    }

    // ---- views ----

    function openBatch()
        external
        view
        returns (uint64 id, uint64 start, uint256 totalDeposits, uint256 feePot, uint256 nDeposits, uint256 nRedeems)
    {
        return (open.id, open.start, open.totalDeposits, open.feePot, open.deposits.length, open.redeems.length);
    }

    function openDeposits() external view returns (CascadeMessages.Entry[] memory) {
        return open.deposits;
    }

    function openRedeems() external view returns (CascadeMessages.Entry[] memory) {
        return open.redeems;
    }

    /// The user's deposit in the open batch.
    function depositOf(address user) external view returns (uint256) {
        uint256 slot = depositSlot[open.id][user];
        return slot == 0 ? 0 : open.deposits[slot - 1].amount;
    }

    /// The user's redeem request in the open batch, in shares.
    function redeemOf(address user) external view returns (uint256) {
        uint256 slot = redeemSlot[open.id][user];
        return slot == 0 ? 0 : open.redeems[slot - 1].amount;
    }

    /// Due by time, either list at its limit, or full by value: at or over maxBatchValue (which may
    /// have been lowered below the total), or with no room left for another minimum deposit.
    function canClose() public view returns (bool) {
        // forge-lint: disable-next-line(block-timestamp)
        return block.timestamp >= uint256(open.start) + batchInterval || open.deposits.length >= maxDeposits
            || open.redeems.length >= maxRedeems || open.totalDeposits >= maxBatchValue
            || maxBatchValue - open.totalDeposits < minDeposit;
    }

    // ---- deposits ----

    function deposit(uint256 amount) external {
        depositFor(msg.sender, amount);
    }

    /// Pulls `amount` from the caller and adds it to `user`'s entry; shares go only to `user`.
    function depositFor(address user, uint256 amount) public whenNotPaused nonReentrant {
        if (user == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount % RAO != 0) revert NotRaoAligned();
        if (amount < minDeposit) revert BelowMinDeposit();
        uint256 total = open.totalDeposits + amount;
        if (netForwarded + total > depositCap) revert CapExceeded();
        if (total > maxBatchValue) revert BatchValueFull();
        uint64 id = open.id;
        uint256 slot = depositSlot[id][user];
        if (slot == 0) {
            if (open.deposits.length >= maxDeposits) revert BatchFull();
            open.deposits.push(CascadeMessages.Entry(user, amount));
            depositSlot[id][user] = open.deposits.length;
        } else {
            open.deposits[slot - 1].amount += amount;
        }
        open.totalDeposits = total;
        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit DepositRequested(id, user, amount, msg.sender);
    }

    /// Reduces the caller's own deposit in the open batch and returns the tokens; works while paused.
    function cancelDeposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount % RAO != 0) revert NotRaoAligned();
        uint64 id = open.id;
        _reduce(open.deposits, depositSlot[id], amount);
        open.totalDeposits -= amount;
        asset.safeTransfer(msg.sender, amount);
        emit DepositCancelled(id, msg.sender, amount);
    }

    // ---- redeem requests ----

    /// Pre-pays redeem-request fees for `user`; spendable only on `user`'s own requests.
    function creditRedeemFee(address user) external payable {
        if (user == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert ZeroAmount();
        feeCredit[user] += msg.value;
        totalFeeCredit += msg.value;
        emit FeeCredited(user, msg.value, msg.sender);
    }

    /// Adds to the caller's redeem request. The first request per batch pays `redeemRequestFee`
    /// (as msg.value, or from the caller's credit); if the redeem list is full it first closes the
    /// batch on the pot alone (any remainder to the caller) and lands in the next one.
    function requestRedeem(uint256 shares) external payable whenNotPaused nonReentrant {
        if (shares == 0) revert ZeroAmount();
        uint256 slot = redeemSlot[open.id][msg.sender];
        if (slot != 0) {
            if (msg.value != 0) revert WrongFee();
            open.redeems[slot - 1].amount += shares;
        } else {
            if (open.redeems.length >= maxRedeems) _closeBatch(open.feePot);
            uint256 fee = redeemRequestFee;
            if (msg.value == fee) {
                open.feePot += msg.value;
            } else if (msg.value == 0 && feeCredit[msg.sender] >= fee) {
                feeCredit[msg.sender] -= fee;
                totalFeeCredit -= fee;
                open.feePot += fee;
                emit FeeCreditSpent(msg.sender, fee);
            } else {
                revert WrongFee();
            }
            open.redeems.push(CascadeMessages.Entry(msg.sender, shares));
            redeemSlot[open.id][msg.sender] = open.redeems.length;
        }
        emit RedeemRequested(open.id, msg.sender, shares);
    }

    /// Reduces the caller's own redeem request; the fee is not refunded; works while paused.
    function cancelRedeem(uint256 shares) external nonReentrant {
        if (shares == 0) revert ZeroAmount();
        uint64 id = open.id;
        _reduce(open.redeems, redeemSlot[id], shares);
        emit RedeemCancelled(id, msg.sender, shares);
    }

    // ---- close ----

    /// Permissionless. The pot pays the bridge fee first, msg.value tops it up, the rest goes to
    /// the caller. An empty batch restarts its timer and refunds msg.value.
    function closeBatch() external payable whenNotPaused nonReentrant {
        if (!canClose()) revert BatchNotReady();
        if (open.deposits.length == 0 && open.redeems.length == 0) {
            open.start = uint64(block.timestamp);
            _pay(msg.sender, msg.value);
            emit BatchRolled(open.id);
            return;
        }
        _closeBatch(open.feePot + msg.value);
    }

    // ---- payouts in ----

    /// Credits one PAYOUTS chunk from the vault, whose tokens the adapter transferred before the
    /// call. Each bridge delivers a given message once; a copy from another enabled bridge must
    /// still find its own tokens here, so it can only spend surplus. An empty chunk is accepted and
    /// recorded. Works while paused: the tokens are already here.
    function onBridgeMessage(uint64 sourceChain, address sender, bytes calldata message, uint256 amount)
        external
        payable
        nonReentrant
    {
        _requireBridge();
        if (sourceChain != vaultChain || sender != vault) revert UnknownPeer();
        if (msg.value != 0) revert ValueMismatch();
        (bytes32 batchKey, uint32 chunk, CascadeMessages.Entry[] memory payouts) =
            CascadeMessages.decodePayouts(message);
        uint256 sum;
        for (uint256 i; i < payouts.length; ++i) {
            sum += payouts[i].amount;
        }
        if (sum != amount) revert AmountMismatch();
        // the open batch's deposits and earlier credits are not this chunk's tokens
        if (asset.balanceOf(address(this)) < open.totalDeposits + totalClaimable + amount) {
            revert TokensNotReceived();
        }
        bytes32 messageHash = keccak256(message);
        if (delivered[msg.sender][messageHash]) revert DuplicatePayouts();

        delivered[msg.sender][messageHash] = true;
        emit PayoutsDelivered(batchKey, chunk, amount, msg.sender);
        for (uint256 i; i < payouts.length; ++i) {
            CascadeMessages.Entry memory p = payouts[i];
            claimable[p.user] += p.amount;
            emit PayoutReceived(batchKey, chunk, p.user, p.amount);
        }
        totalClaimable += amount;
        uint256 forwarded = netForwarded;
        netForwarded = forwarded > amount ? forwarded - amount : 0;
    }

    /// Sends the caller everything credited to them; works while paused.
    function claim() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        totalClaimable -= amount;
        asset.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    // ---- admin ----

    function setCaps(uint256 minDeposit_, uint256 depositCap_) external onlyOwner {
        minDeposit = minDeposit_;
        depositCap = depositCap_;
        emit LimitSet("minDeposit", minDeposit_, depositCap_);
    }

    function setBatchLimits(uint32 maxDeposits_, uint32 maxRedeems_) external onlyOwner {
        if (
            maxDeposits_ == 0 || maxDeposits_ > CascadeMessages.MAX_ENTRIES || maxRedeems_ == 0
                || maxRedeems_ > CascadeMessages.MAX_ENTRIES
        ) revert InvalidParameter();
        maxDeposits = maxDeposits_;
        maxRedeems = maxRedeems_;
        emit LimitSet("maxDeposits", maxDeposits_, maxRedeems_);
    }

    function setMaxBatchValue(uint256 value) external onlyOwner {
        maxBatchValue = value;
        emit LimitSet("maxBatchValue", value, 0);
    }

    function setBatchInterval(uint64 interval) external onlyOwner {
        batchInterval = interval;
        emit LimitSet("batchInterval", interval, 0);
    }

    function setRedeemRequestFee(uint256 fee) external onlyOwner {
        redeemRequestFee = fee;
        emit LimitSet("redeemRequestFee", fee, 0);
    }

    // ---- receive ----

    /// ETH enters only through requestRedeem, creditRedeemFee and closeBatch.
    receive() external payable {
        revert DirectTransferNotAllowed();
    }

    // ---- internal ----

    /// Sends the open batch through the primary bridge with `budget` wei for the fee, opens the
    /// next batch, and pays `budget - fee` to the caller.
    function _closeBatch(uint256 budget) internal {
        uint64 id = open.id;
        uint256 totalDeposits = open.totalDeposits;
        bytes memory message = CascadeMessages.encodeBatch(id, open.deposits, open.redeems);
        ICascadeBridge bridge = _primary();
        uint256 fee = bridge.quoteFee(vaultChain, vault, message, totalDeposits);
        if (budget < fee) revert InsufficientFee();
        uint256 nDeposits = open.deposits.length;
        uint256 nRedeems = open.redeems.length;
        uint256 pot = open.feePot;

        netForwarded += totalDeposits;
        delete open;
        open.id = id + 1;
        open.start = uint64(block.timestamp);

        if (totalDeposits > 0) asset.forceApprove(address(bridge), totalDeposits);
        bridge.send{value: fee}(vaultChain, vault, message, totalDeposits);
        if (totalDeposits > 0) asset.forceApprove(address(bridge), 0);
        _pay(msg.sender, budget - fee);
        emit BatchClosed(id, totalDeposits, nDeposits, nRedeems, fee, pot < fee ? pot : fee);
    }

    /// Takes `amount` off the caller's entry in `list`, removing the entry (swap-and-pop, the
    /// moved entry's slot updated) when it reaches zero.
    function _reduce(CascadeMessages.Entry[] storage list, mapping(address => uint256) storage slots, uint256 amount)
        internal
    {
        uint256 slot = slots[msg.sender];
        if (slot == 0) revert InsufficientRequest();
        uint256 have = list[slot - 1].amount;
        if (amount > have) revert InsufficientRequest();
        if (amount < have) {
            list[slot - 1].amount = have - amount;
            return;
        }
        uint256 last = list.length;
        if (slot != last) {
            CascadeMessages.Entry memory moved = list[last - 1];
            list[slot - 1] = moved;
            slots[moved.user] = slot;
        }
        list.pop();
        delete slots[msg.sender];
    }

    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
