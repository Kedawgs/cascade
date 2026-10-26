// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CascadeBase} from "./CascadeBase.sol";
import {ICascadeBridge, ICascadeReceiver} from "./interfaces/ICascadeBridge.sol";
import {ICascadeSwapper} from "./interfaces/ICascadeSwapper.sol";
import {ICascadeTwap} from "./interfaces/ICascadeTwap.sol";
import {CascadeMessages} from "./libraries/CascadeMessages.sol";

/// @notice Cascade front door on Base: holds bridged TAO, collects deposits and redeem requests
/// into one open batch (one merged entry per user per list) and forwards the batch to the vault
/// through the primary bridge. It never prices anything; the vault does.
/// @dev Redeem requests need no shares (the front door cannot see Bittensor), so the first request
/// per user per batch pays `redeemRequestFee` in ETH into the batch's fee pot, the pot pays the
/// batch's bridge fee first, and a request that meets a full redeem list closes the batch itself.
/// ETH held always equals the open batch's `feePot` plus `totalFeeCredit`. Payouts from the vault
/// arrive in chunks and are credited for users to claim; the asset held is always at least the open
/// batch's `totalDeposits` plus `totalClaimable`. A user may instead leave a delivery preference: the
/// keeper then sells their credit for USDC through the owner-set swapper, and the front door itself
/// requires the user's USDC balance to rise by at least the largest of the user's floor, the keeper's
/// floor and the oracle's 30-minute value less `maxDeliverySlippageBps`, or reverts everything.
/// `claim()` works in every state and clears the preference.
contract CascadeFrontDoor is CascadeBase, ICascadeReceiver {
    using SafeERC20 for IERC20Metadata;

    // ---- constants and immutables ----

    uint256 public constant RAO = 1e9;
    /// Circle CCTP domain number of Base, the only delivery destination accepted.
    uint32 public constant DESTINATION_BASE = 6;
    uint16 public constant MAX_DELIVERY_SLIPPAGE_BPS = 300;

    IERC20Metadata public immutable asset;
    uint64 public immutable vaultChain;
    address public immutable vault;
    IERC20 public immutable usdc;

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

    // USDC delivery
    /// `minUsdcPerTao` is USDC units (6 decimals) per 1e18 TAO wei; live while `block.timestamp <=
    /// deadline`; `destination` is a CCTP domain number. All zero = no preference.
    struct Delivery {
        uint128 minUsdcPerTao;
        uint64 deadline;
        uint32 destination;
    }

    mapping(address => Delivery) public deliveryOf;
    address public keeper;
    address public swapper;
    ICascadeTwap public oracle;
    uint16 public maxDeliverySlippageBps = 150;

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
    error NotKeeper();
    error NoDelivery();
    error DeliveryExpired();
    error BelowMinimum();
    error UnsupportedDestination();
    error DeadlinePassed();
    error FeeTooHigh();

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
    /// All zero when the preference is cleared (by the user or by `claim`).
    event DeliverySet(address indexed user, uint128 minUsdcPerTao, uint64 deadline, uint32 destination);
    event Delivered(address indexed user, uint256 taoIn, uint256 usdcOut);
    event KeeperSet(address indexed keeper);
    event SwapperSet(address indexed swapper);
    event OracleSet(address indexed oracle);
    event MaxDeliverySlippageSet(uint16 bps);

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
        uint256 redeemRequestFee_,
        IERC20 usdc_
    ) CascadeBase(owner_, guardian_, address(bridge)) {
        if (asset_.decimals() != 18) revert UnsupportedDecimals();
        if (vault_ == address(0) || address(usdc_) == address(0)) revert ZeroAddress();
        asset = asset_;
        vaultChain = vaultChain_;
        vault = vault_;
        usdc = usdc_;
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
    /// A partial cancel must leave at least `minDeposit` (a full cancel is always allowed), so an entry
    /// left below a later-raised `minDeposit` can only be cancelled in full.
    function cancelDeposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount % RAO != 0) revert NotRaoAligned();
        uint64 id = open.id;
        _reduce(open.deposits, depositSlot[id], amount);
        uint256 slot = depositSlot[id][msg.sender];
        uint256 left = slot == 0 ? 0 : open.deposits[slot - 1].amount;
        if (left != 0 && left < minDeposit) revert BelowMinDeposit();
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

    /// Adds to the caller's redeem request. The first request per batch pays `redeemRequestFee`,
    /// cash first: msg.value (at most the fee) and the caller's credit for the rest, so the full fee
    /// in cash always works and a gift of credit cannot make a request revert. If the redeem list is
    /// full it first closes the batch on the pot alone (any remainder to the caller) and lands in
    /// the next one.
    function requestRedeem(uint256 shares) external payable whenNotPaused nonReentrant {
        _requestRedeem(shares);
    }

    /// `setDelivery` and `requestRedeem` in one call, under the same fee rule.
    function requestRedeemWithDelivery(uint256 shares, uint128 minUsdcPerTao, uint64 deadline, uint32 destination)
        external
        payable
        whenNotPaused
        nonReentrant
    {
        _setDelivery(minUsdcPerTao, deadline, destination);
        _requestRedeem(shares);
    }

    function _requestRedeem(uint256 shares) internal {
        if (shares == 0) revert ZeroAmount();
        uint256 slot = redeemSlot[open.id][msg.sender];
        if (slot != 0) {
            if (msg.value != 0) revert WrongFee();
            open.redeems[slot - 1].amount += shares;
        } else {
            if (open.redeems.length >= maxRedeems) _closeBatch(open.feePot);
            uint256 fee = redeemRequestFee;
            if (msg.value > fee) revert WrongFee();
            uint256 fromCredit = fee - msg.value;
            if (feeCredit[msg.sender] < fromCredit) revert WrongFee();
            if (fromCredit != 0) {
                feeCredit[msg.sender] -= fromCredit;
                totalFeeCredit -= fromCredit;
                emit FeeCreditSpent(msg.sender, fromCredit);
            }
            open.feePot += fee;
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
        uint256 sum = 0;
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

    /// Sends the caller everything credited to them and clears their delivery preference; works
    /// while paused.
    function claim() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        totalClaimable -= amount;
        if (deliveryOf[msg.sender].minUsdcPerTao != 0) {
            delete deliveryOf[msg.sender];
            emit DeliverySet(msg.sender, 0, 0, 0);
        }
        asset.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    // ---- USDC delivery ----

    /// The caller's delivery preference: at least `minUsdcPerTao` USDC units per 1e18 TAO for every
    /// payout delivered until `deadline` (inclusive), to `destination` (only `DESTINATION_BASE`). It
    /// survives deliveries; a zero floor clears it. Works while paused.
    function setDelivery(uint128 minUsdcPerTao, uint64 deadline, uint32 destination) external {
        _setDelivery(minUsdcPerTao, deadline, destination);
    }

    /// Keeper only: sells everything credited to `user` through the swapper for USDC paid to `user`.
    /// The minimum is the largest of the user's floor (rounded up), `keeperMinOut`, and the oracle's
    /// 30-minute value less `maxDeliverySlippageBps`. The front door measures the user's USDC itself,
    /// so a swapper that pays short, keeps the TAO or reverts, a USDC that refuses the user, or an
    /// oracle that can't answer only reverts the delivery, TAO included; `claim()` stays open.
    function deliver(address user, uint256 keeperMinOut)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 received)
    {
        if (msg.sender != keeper) revert NotKeeper();
        uint256 amount = claimable[user];
        if (amount == 0) revert NothingToClaim();
        Delivery memory d = deliveryOf[user];
        if (d.minUsdcPerTao == 0) revert NoDelivery();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > d.deadline) revert DeliveryExpired();
        // setDelivery stores no other destination; checked again so none is ever delivered elsewhere
        if (d.destination != DESTINATION_BASE) revert UnsupportedDestination();

        uint256 userFloor = Math.mulDiv(amount, d.minUsdcPerTao, 1e18, Math.Rounding.Ceil);
        uint256 marketFloor = oracle.usdcValue(amount) * (10_000 - maxDeliverySlippageBps) / 10_000;
        uint256 minOut = Math.max(userFloor, Math.max(keeperMinOut, marketFloor));

        claimable[user] = 0;
        totalClaimable -= amount;
        address s = swapper;
        asset.safeTransfer(s, amount);
        uint256 before = usdc.balanceOf(user);
        ICascadeSwapper(s).sellFor(amount, user, minOut);
        uint256 balance = usdc.balanceOf(user);
        received = balance > before ? balance - before : 0;
        if (received < minOut) revert BelowMinimum();
        emit Delivered(user, amount, received);
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

    /// address(0) stops deliveries; manual claims are unaffected.
    function setKeeper(address newKeeper) external onlyOwner {
        keeper = newKeeper;
        emit KeeperSet(newKeeper);
    }

    /// The swapper receives a delivery's TAO; it can make a delivery revert, never pay short.
    function setSwapper(address newSwapper) external onlyOwner {
        swapper = newSwapper;
        emit SwapperSet(newSwapper);
    }

    function setOracle(ICascadeTwap newOracle) external onlyOwner {
        oracle = newOracle;
        emit OracleSet(address(newOracle));
    }

    /// The market floor's discount to the oracle's value, in bps, at most MAX_DELIVERY_SLIPPAGE_BPS.
    function setMaxDeliverySlippage(uint16 bps) external onlyOwner {
        if (bps > MAX_DELIVERY_SLIPPAGE_BPS) revert FeeTooHigh();
        maxDeliverySlippageBps = bps;
        emit MaxDeliverySlippageSet(bps);
    }

    // ---- receive ----

    /// ETH enters only through requestRedeem, creditRedeemFee and closeBatch.
    receive() external payable {
        revert DirectTransferNotAllowed();
    }

    // ---- internal ----

    function _setDelivery(uint128 minUsdcPerTao, uint64 deadline, uint32 destination) internal {
        if (minUsdcPerTao == 0) {
            delete deliveryOf[msg.sender];
            emit DeliverySet(msg.sender, 0, 0, 0);
            return;
        }
        if (destination != DESTINATION_BASE) revert UnsupportedDestination();
        // forge-lint: disable-next-line(block-timestamp)
        if (deadline <= block.timestamp) revert DeadlinePassed();
        deliveryOf[msg.sender] = Delivery(minUsdcPerTao, deadline, destination);
        emit DeliverySet(msg.sender, minUsdcPerTao, deadline, destination);
    }

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
