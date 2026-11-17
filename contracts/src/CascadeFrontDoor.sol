// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CascadeBase} from "./CascadeBase.sol";
import {ICascadeBridge, ICascadeReceiver} from "./interfaces/ICascadeBridge.sol";
import {ICascadeSwapper} from "./interfaces/ICascadeSwapper.sol";
import {ICascadeTwap} from "./interfaces/ICascadeTwap.sol";
import {CascadeMessages} from "./libraries/CascadeMessages.sol";
import "./CascadeConstants.sol" as Constants;
import {Delay, Kind} from "./CascadeTypes.sol";
import {CancelTooSoon, NotBridge, ZeroAddress} from "./CascadeErrors.sol";

/// @notice Cascade front door on Base: holds bridged TAO, collects deposits and redeem requests
/// into one open batch (one merged entry per user per list) and forwards the batch to the vault
/// through the primary bridge. It never prices deposits or redeems; the vault does. The one price
/// it reads is a delivery's floor: a TWAP oracle's 30-minute value of the TAO being sold; a delivery also
/// waits while either of the oracle's pools is thinner than its floor (`minPoolLiquidity`, spec §3.7).
/// @dev Redeem requests need no shares (the front door cannot see Bittensor), so the first request
/// per user per batch pays `redeemRequestFee` in ETH into the batch's fee pot, the pot pays the
/// batch's bridge fee first, and a request that meets a full redeem list closes the batch itself.
/// What the pot does not spend rolls into the next batch's pot, never to a closer (spec §3.5, I-21);
/// the owner may sweep that carried remainder, and only it, to the immutable treasury (`sweepPot`).
/// ETH held always equals the open batch's `feePot` plus `totalFeeCredit` (I-18). Payouts from the vault
/// arrive in chunks and are credited for users to claim; the asset held is always at least the open
/// batch's `totalDeposits` plus `totalClaimable`. A user may instead leave a delivery preference: the
/// keeper then sells their credit for USDC through the owner-set swapper, which pays the front door;
/// the front door requires its own USDC balance to rise by at least the largest of the user's floor,
/// the keeper's floor and the oracle's 30-minute value less `maxDeliverySlippageBps`, then forwards
/// all of it to the user, or reverts everything. `claim()` works in every state and clears the
/// preference. Its exits machine is CascadeBase's alone (spec §3.6): the primary bridge's disable is its
/// one recorded hold, and its pause records and stamps nothing. The pause stops only `deposit`, `depositFor` and
/// `deliver` (a sale): every exit call works while paused, a deposit's cancel at once (spec §3.5, I-20). Unpaused, a
/// deposit's cancel waits five minutes after the user's last deposit (`CANCEL_COOLDOWN`, R11), except while the
/// primary bridge is disabled, when no close can take it (R12). Payouts come in from any known bridge, ever activated,
/// a disabled one included (spec §3.2, H-2 i); only the primary, enabled, carries a close.
contract CascadeFrontDoor is CascadeBase, ICascadeReceiver {
    using SafeERC20 for IERC20Metadata;
    using SafeERC20 for IERC20;

    // ---- constants and immutables ----

    uint256 public constant RAO = 1e9;
    /// Circle CCTP domain number of Base, the only delivery destination accepted.
    uint32 public constant DESTINATION_BASE = 6;
    uint16 public constant MAX_DELIVERY_SLIPPAGE_BPS = 300;

    IERC20Metadata public immutable asset;
    uint64 public immutable vaultChain;
    address public immutable vault;
    IERC20 public immutable usdc;
    address public immutable treasury;

    // ---- constructor arguments ----

    /// Everything launch-specific, set by the constructor (spec §7, Appendix B): the owner is the founder's
    /// key from the start, so there is no hand-off, and every value passes the check its setter makes, so no
    /// constructor can set what no setter could. `asset`, `vaultChain`, `vault`, `usdc` and `treasury` (where
    /// `sweepPot` sends, non-zero) are immutable; `bridge` is the first bridge, enabled and primary; `keeper`,
    /// `oracle` and `swapper` are the delivery parties (zero stops deliveries, never claims); `minPoolLiquidity` the
    /// pools' depth floors on deliveries (TAO/WETH, then WETH/USDC; 0 checks nothing); `msPerBlock` Base's
    /// calibrated block time (120 ms, calibrated so half the delay in blocks takes 5/6 of it at today's 0.2-second
    /// blocks: 1.67 times faster blocks, Revision 28), the scheduler's block floor
    /// (CascadeBase, immutable). A wrong value is a redeploy or a setter call.
    struct Params {
        IERC20Metadata asset;
        ICascadeBridge bridge;
        uint64 vaultChain;
        address vault;
        IERC20 usdc;
        address owner;
        address guardian;
        address keeper;
        ICascadeTwap oracle;
        address swapper;
        address treasury;
        uint128[2] minPoolLiquidity;
        uint64 batchInterval;
        uint256 minDeposit;
        uint256 depositCap;
        uint256 redeemRequestFee;
        uint32 maxDeposits;
        uint32 maxRedeems;
        uint256 maxBatchValue;
        uint16 maxDeliverySlippageBps;
        uint64 msPerBlock;
    }

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

    // parameters (the constructor's Params)
    /// @notice Upper bound on `batchInterval` (spec §3.5): a request is never more than a day from its close by the
    /// timer, so the interval is not a freeze instrument.
    uint64 public constant MAX_BATCH_INTERVAL = 24 hours;
    /// @notice Upper bound on `redeemRequestFee` (0.001 ETH, ten times the launch fee), so no setting
    /// can price every exit out.
    uint256 public constant MAX_REDEEM_REQUEST_FEE = 1e15;
    /// @notice Upper bound on `maxBatchValue`: the lane's per-message limit. A batch above it could
    /// never be sent, and its redeems would wait with it. The primary bridge's own cap bounds it too (AboveBridgeCap).
    uint256 public constant MAX_BATCH_VALUE = 5_000e18;
    /// @notice Lower bound on `minDeposit`, 0.03 TAO: twice the vault's MAX_FEE_ABS, the top of the payout fee
    /// ceiling's absolute part (spec §3.3), so a bounced deposit, at least `minDeposit`, keeps at least half its value
    /// under any ceiling and is never dust (I-14).
    uint256 public constant MIN_DEPOSIT_FLOOR = 2 * Constants.MAX_FEE_ABS;
    /// @notice How long a user's deposit cancel waits after its last deposit (R11, spec §3.5): `cancelDeposit` reverts
    /// `CancelTooSoon(cancelableAt)` before `lastDepositAt[user] + CANCEL_COOLDOWN` (`cancelableAt(user)`). Five of the
    /// keeper's one-minute rounds, so a deposit that lifts the batch over the half rule's line, or the deposit list to
    /// half its limit, is still there when the keeper's next round, or anyone's `closeBatch`, closes it: a holder can no
    /// longer fill a batch after one round and cancel it before the next. It applies only while the door is unpaused
    /// with its primary bridge enabled (R12): while paused no deposit can land, so there is no fresh deposit for it to
    /// hold (I-20 whole again), and while the primary is disabled no close with entries can land, so it would hold only
    /// the depositors; either way the cancel goes at once. Otherwise the way out waits at most this long.
    uint64 public constant CANCEL_COOLDOWN = 5 minutes;
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
    uint16 public maxDeliverySlippageBps;

    // the fee pot's carried remainder (Task 29), declared last so that no earlier variable moves
    /// The pot's remainder at the last close, carried into the open batch's `feePot`, less what `sweepPot`
    /// has sent since: at most the open batch's `feePot`, and all `sweepPot` may send.
    uint256 public potCarried;

    // the pools' depth floors on deliveries (Task 32), declared last so that no earlier variable moves
    /// @notice Each pool's least 30-minute harmonic-mean in-range liquidity for a delivery (spec §3.7, I-31): [0] the
    /// TAO/WETH pool, [1] the WETH/USDC pool, as `oracle.meanLiquidity()` returns them. `deliver` reverts `ThinPool`
    /// while a pool reads below its floor; `claim` never reads them. A floor of 0 checks nothing.
    /// @dev The reading is a harmonic mean, so one block of a near-empty range (Uniswap divides by max(L, 1)) collapses
    /// it for up to the whole window: whoever pushes TAO/WETH into a thin range for one block (about two swap fees)
    /// holds every delivery for up to 30 minutes, a delay and never a loss (users still claim by hand). It measures
    /// organic depth that is there, not a proven cost to move the price (anyone can raise it with narrow liquidity of
    /// their own), so the 30-minute window, not this floor, stays the main defence.
    uint128[2] public minPoolLiquidity;

    // the cancel cooldown's clock (R11), declared last so that no earlier variable moves
    /// When each user's entry last grew: the `block.timestamp` of the last `deposit` or `depositFor` naming it as the
    /// user (whoever paid), kept across batches; 0 before its first. Its cancel waits until this plus
    /// `CANCEL_COOLDOWN` while the door is unpaused with its primary enabled (`cancelableAt`).
    mapping(address => uint256) internal lastDepositAt;

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
    error WrongBatch(uint64 openId);
    error BatchTooSmall();
    /// A delivery refused while pool `index` (0 TAO/WETH, 1 WETH/USDC) reads `liquidity`, below its floor.
    error ThinPool(uint8 index, uint128 liquidity);

    // ---- events ----

    event DepositRequested(uint64 indexed batchId, address indexed user, uint256 amount, address payer);
    event DepositCancelled(uint64 indexed batchId, address indexed user, uint256 amount);
    event FeeCredited(address indexed user, uint256 amount, address payer);
    event FeeCreditSpent(address indexed user, uint256 amount);
    event RedeemRequested(uint64 indexed batchId, address indexed user, uint256 shares);
    event RedeemCancelled(uint64 indexed batchId, address indexed user, uint256 shares);
    /// `potUsed` is the part of `fee` paid from the batch's fee pot, the closer the rest; `potCarried` is the
    /// pot's remainder, the next batch's pot to start with.
    event BatchClosed(
        uint64 indexed id,
        uint256 totalDeposits,
        uint256 nDeposits,
        uint256 nRedeems,
        uint256 fee,
        uint256 potUsed,
        uint256 potCarried
    );
    /// `sweepPot` sent `amount` of the carried remainder to the treasury.
    event PotSwept(uint256 amount);
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

    /// Every value of `p` goes through the internal function its setter uses (the check, the write and the
    /// setter's event), so the constructor can set nothing a setter could not; CascadeBase sets the owner
    /// (OpenZeppelin's Ownable refuses a zero one), the guardian, the bridge and the block time (61 to 60,000
    /// ms). Only the immutables have no setter: an 18-decimal asset, a non-zero vault chain, a vault, a
    /// USDC that is not the asset, a treasury, and the block time.
    constructor(Params memory p) CascadeBase(p.owner, p.guardian, address(p.bridge), p.msPerBlock) {
        if (p.asset.decimals() != 18) revert UnsupportedDecimals();
        if (p.vault == address(0) || address(p.usdc) == address(0) || p.treasury == address(0)) revert ZeroAddress();
        if (address(p.usdc) == address(p.asset) || p.vaultChain == 0) revert InvalidParameter();
        asset = p.asset;
        vaultChain = p.vaultChain;
        vault = p.vault;
        usdc = p.usdc;
        treasury = p.treasury;
        _setKeeper(p.keeper);
        _setOracle(p.oracle);
        _setSwapper(p.swapper);
        _setBatchInterval(p.batchInterval);
        _setCaps(p.minDeposit, p.depositCap);
        _setRedeemRequestFee(p.redeemRequestFee);
        _setBatchLimits(p.maxDeposits, p.maxRedeems);
        _setMaxBatchValue(p.maxBatchValue);
        _setMaxDeliverySlippage(p.maxDeliverySlippageBps);
        _setMinPoolLiquidity(0, p.minPoolLiquidity[0]);
        _setMinPoolLiquidity(1, p.minPoolLiquidity[1]);
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

    /// The first second at which `user` may cancel its deposit (R11): its last deposit's time plus `CANCEL_COOLDOWN`
    /// (`CANCEL_COOLDOWN` itself before any deposit); before it `cancelDeposit` reverts `CancelTooSoon` with this value.
    /// 0, no cooldown, while the door is paused or its primary bridge is disabled (R12): paused, no deposit can land, so
    /// none needs holding for a close; with the primary disabled no close with entries can land (`_primary()` reverts
    /// PrimaryBridgeDisabled), so the cooldown would hold only the deposit's owner, whose clock a `depositFor` could
    /// restart for as long as the disable lasts. Either way the cancel goes at once (I-20). An unpause, or the primary
    /// enabled again (its reopen, or `setPrimaryBridge`), brings the cooldown back from the user's last deposit.
    function cancelableAt(address user) public view returns (uint256) {
        if (paused() || !bridgeEnabled[primaryBridge]) return 0;
        return lastDepositAt[user] + CANCEL_COOLDOWN;
    }

    /// Due by time; or the deposit list at half its limit or more (R12, below), or the redeem list at its limit; or,
    /// while the open batch holds deposits, the half rule (R7; spec
    /// §3.5): its deposits are at least half of maxBatchValue, or no minimum deposit fits under it (the room rule of R6b
    /// U4, so also a batch at or over a lowered maxBatchValue), or they are at least half the room left under depositCap
    /// (netForwarded + 2 x deposits >= depositCap, with no subtraction, so a cap lowered below netForwarded cannot
    /// underflow), or no minimum deposit fits under that cap. One address can no longer hold every batch just under a
    /// limit, or with room for exactly one minimum deposit, and cancel before each close: such a batch is closable at
    /// once, and a close that lands while it is over the line commits its deposits: the keeper's, once a minute, or the
    /// depositor's own (closeBatch is permissionless; the web offers "close this batch, then deposit"). The cancel
    /// cooldown (R11, `CANCEL_COOLDOWN`, 5 minutes) makes that close land first: a holder can no longer deposit a full
    /// batch after one keeper round and cancel it before the next (Revision 34's hold), and a lift over half cancelled
    /// back within a round needs a second address's deposit five minutes old, which was under half at an earlier round,
    /// so such lifts add up to less than half a batch over any five rounds, while each keeper close lands (the keeper
    /// built from v3.2-wire names a lenient `minValue`, so an aged one-rao cancel cannot void its close). The deposit
    /// list's half rule (R12, Revision 36) does the same for the list: a round that finds the batch waiting finds under
    /// half the list (at most 24 of 50 entries), so a holder that fills the list after it pushes at least 26 entries too
    /// young to cancel, and the next round finds half the list or more and commits them (the R6 list hold, 49 aged
    /// entries cycled one a round, is gone). What is left is stated (Revision 35): one under half refuses only deposits
    /// above about half a batch (or half the cap's room); to stay under half it must cancel as much as each honest
    /// deposit adds, so honest deposits keep landing. A batch with no deposits
    /// (redeems only, or empty) waits for its interval or a full redeem list whatever the limits: at a filled cap, a cap
    /// of 0 or a minimum above maxBatchValue the room rule alone held every redeem-only batch closable at once. A close
    /// pays its closer nothing (the pot rolls forward) and `minValue` guards it against a cancel landing first, so an
    /// early close only forwards the deposits.
    function canClose() public view returns (bool) {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= uint256(open.start) + batchInterval) return true;
        // the deposit list at half its limit or more (R12: under the cancel cooldown a list filled after a keeper's
        // round holds at least 26 entries too young to cancel, so the next round closes it; `>=`, so an odd limit's
        // half rounds up, 25 of 49); the redeem list at its limit, as a full one closes itself on its pot
        // (`_requestRedeem`)
        if (2 * open.deposits.length >= maxDeposits || open.redeems.length >= maxRedeems) return true;
        uint256 total = open.totalDeposits;
        if (total == 0) return false;
        // no overflow: the deposits and minDeposit are each at most MAX_BATCH_VALUE, netForwarded what was forwarded
        uint256 limit = maxBatchValue;
        uint256 withAMinimum = total + minDeposit;
        if (2 * total >= limit || withAMinimum > limit) return true;
        uint256 forwarded = netForwarded;
        uint256 cap = depositCap;
        return forwarded + 2 * total >= cap || forwarded + withAMinimum > cap;
    }

    // ---- deposits ----

    function deposit(uint256 amount) external {
        depositFor(msg.sender, amount);
    }

    /// Pulls `amount` from the caller and adds it to `user`'s entry; shares go only to `user`. Restarts `user`'s cancel
    /// cooldown (`lastDepositAt`, R11), whoever pays: a `depositFor` that holds back a victim's cancel for five more
    /// minutes gifts the victim its deposit (at least `minDeposit`). The pause stops the gifts and frees every cancel at
    /// once (R12: no cooldown while paused), as a disabled primary frees them (no close can take a deposit then).
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
        lastDepositAt[user] = block.timestamp;
        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit DepositRequested(id, user, amount, msg.sender);
    }

    /// Reduces the caller's own deposit in the open batch and returns the tokens, once `CANCEL_COOLDOWN` (5 minutes) has
    /// passed since the caller's last deposit: before that it reverts `CancelTooSoon(cancelableAt)` ahead of every other
    /// check (R11, spec §3.5). No cooldown while the door is paused or its primary bridge is disabled (`cancelableAt`
    /// reads 0, R12), so it works at once while paused (I-20). A partial cancel must leave at least `minDeposit` (a full
    /// cancel is always allowed), so an entry left below a later-raised `minDeposit` can only be cancelled in full.
    function cancelDeposit(uint256 amount) external nonReentrant {
        uint256 ready = cancelableAt(msg.sender);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < ready) revert CancelTooSoon(ready);
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
    /// full it first closes the batch on the pot alone (the remainder carried, none to the caller) and
    /// lands in the next one; a pot short of the fee reverts it `InsufficientFee`, and the caller can
    /// close the full batch with a top-up (`closeBatch`) and request again. Works while paused (I-20).
    function requestRedeem(uint256 shares) external payable nonReentrant {
        _requestRedeem(shares);
    }

    /// `setDelivery` and `requestRedeem` in one call, under the same fee rule; works while paused (I-20).
    function requestRedeemWithDelivery(uint256 shares, uint128 minUsdcPerTao, uint64 deadline, uint32 destination)
        external
        payable
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
            // the pot alone: this call's msg.value is its own request's fee, never the close's
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

    /// Permissionless. Closes batch `expectedId` (else `WrongBatch`, naming the open one), when it can
    /// close (`BatchNotReady`): an empty batch restarts its timer and refunds msg.value, whatever
    /// `minValue`; one whose deposits total less than `minValue` reverts `BatchTooSmall`; else it is sent,
    /// the pot paying the bridge fee first and msg.value the rest, and only the unused msg.value comes
    /// back (spec §3.5). Works while paused (I-20): a pause never stops a close, a disabled primary does
    /// (`PrimaryBridgeDisabled`).
    function closeBatch(uint64 expectedId, uint256 minValue) external payable nonReentrant {
        uint64 id = open.id;
        if (expectedId != id) revert WrongBatch(id);
        if (!canClose()) revert BatchNotReady();
        if (open.deposits.length == 0 && open.redeems.length == 0) {
            open.start = uint64(block.timestamp);
            _pay(msg.sender, msg.value);
            emit BatchRolled(id);
            return;
        }
        if (open.totalDeposits < minValue) revert BatchTooSmall();
        _closeBatch(open.feePot + msg.value);
    }

    /// Owner only: sends `amount` of the pot's carried remainder to the immutable treasury, at most
    /// `potCarried` (else `InvalidParameter`): never the open batch's own request fees, which pay for its
    /// close, and never the pre-paid credits. A treasury that refuses reverts the whole sweep.
    function sweepPot(uint256 amount) external onlyOwner nonReentrant {
        uint256 carried = potCarried;
        if (amount > carried) revert InvalidParameter();
        potCarried = carried - amount;
        open.feePot -= amount;
        _pay(treasury, amount);
        emit PotSwept(amount);
    }

    // ---- payouts in ----

    /// Credits one PAYOUTS chunk from the vault, whose tokens the adapter transferred before the
    /// call, from any known bridge (`_requireBridge`: ever activated, disabled since included, spec §3.2),
    /// so a late payout or a refund through a disabled bridge still lands. Each bridge delivers a given
    /// message once; a copy from another known bridge must still find its own tokens here, so it can only
    /// spend surplus. An empty chunk is accepted and recorded. Works while paused: the tokens are already here.
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

    /// Keeper only: sells everything credited to `user` through the swapper, which pays the USDC to
    /// the front door, and forwards all of it to `user`. The minimum is the largest of the user's
    /// floor (rounded up), `keeperMinOut`, and the oracle's 30-minute value less
    /// `maxDeliverySlippageBps`. The front door measures its own USDC across the sell (never the
    /// user's, which anyone could top up mid-call with an unrelated payout), so a swapper that pays
    /// short, keeps the TAO or reverts, a USDC that refuses the user, or an oracle that can't answer
    /// only reverts the delivery, TAO included; `claim()` stays open. Before any token moves, each pool's
    /// 30-minute mean liquidity must be at least its floor (spec §3.7, I-31), else `ThinPool(index,
    /// liquidity)` for the first pool below it, TAO/WETH first. All at once (R3 C-L2): the market floor is
    /// the marginal 30-minute value, which ignores this sale's own price impact, so a claim too large for
    /// the pools (about 13 TAO or more on the November 2026 pools) can never deliver and is claimed by hand.
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

        // the pools' depth, then the price: one oracle call each (a floor of 0 passes any reading)
        ICascadeTwap o = oracle;
        (uint128 taoWeth, uint128 wethUsdc) = o.meanLiquidity();
        if (taoWeth < minPoolLiquidity[0]) revert ThinPool(0, taoWeth);
        if (wethUsdc < minPoolLiquidity[1]) revert ThinPool(1, wethUsdc);
        uint256 userFloor = Math.mulDiv(amount, d.minUsdcPerTao, 1e18, Math.Rounding.Ceil);
        uint256 marketFloor = o.usdcValue(amount) * (10_000 - maxDeliverySlippageBps) / 10_000;
        uint256 minOut = Math.max(userFloor, Math.max(keeperMinOut, marketFloor));

        claimable[user] = 0;
        totalClaimable -= amount;
        address s = swapper;
        asset.safeTransfer(s, amount);
        uint256 before = usdc.balanceOf(address(this));
        ICascadeSwapper(s).sellFor(amount, address(this), minOut);
        uint256 balance = usdc.balanceOf(address(this));
        received = balance > before ? balance - before : 0;
        if (received < minOut) revert BelowMinimum();
        usdc.safeTransfer(user, received);
        emit Delivered(user, amount, received);
    }

    // ---- admin ----
    // Each setter runs the internal function below it (its check, its write and its event), which the
    // constructor runs on its Params too, so no constructor can set what no setter could.

    function setCaps(uint256 minDeposit_, uint256 depositCap_) external onlyOwner {
        _setCaps(minDeposit_, depositCap_);
    }

    /// `minDeposit_` at least MIN_DEPOSIT_FLOOR (0.03 TAO, spec §3.3) and at most MAX_BATCH_VALUE (the lane's 5,000
    /// TAO, R7: no deposit above it could ever be sent, and the bound keeps canClose's sums from overflowing, which
    /// panicked every close), else InvalidParameter; the cap is unbounded. Immediate either way. The constructor sets
    /// both through here.
    function _setCaps(uint256 minDeposit_, uint256 depositCap_) internal {
        if (minDeposit_ < MIN_DEPOSIT_FLOOR || minDeposit_ > MAX_BATCH_VALUE) revert InvalidParameter();
        minDeposit = minDeposit_;
        depositCap = depositCap_;
        emit LimitSet("minDeposit", minDeposit_, depositCap_);
    }

    function setBatchLimits(uint32 maxDeposits_, uint32 maxRedeems_) external onlyOwner {
        _setBatchLimits(maxDeposits_, maxRedeems_);
    }

    function _setBatchLimits(uint32 maxDeposits_, uint32 maxRedeems_) internal {
        if (
            maxDeposits_ == 0 || maxDeposits_ > CascadeMessages.MAX_ENTRIES || maxRedeems_ == 0
                || maxRedeems_ > CascadeMessages.MAX_ENTRIES
        ) revert InvalidParameter();
        maxDeposits = maxDeposits_;
        maxRedeems = maxRedeems_;
        emit LimitSet("maxDeposits", maxDeposits_, maxRedeems_);
    }

    /// Up loosens: scheduled (spec §3.6); down, or the same, at once.
    function setMaxBatchValue(uint256 value) external onlyOwner {
        _requireScheduledIfLoosens(value > maxBatchValue);
        _setMaxBatchValue(value);
    }

    /// At most MAX_BATCH_VALUE (the lane's 5,000 TAO), else InvalidParameter, and at most the primary bridge's
    /// maxMessageValue(), else AboveBridgeCap (spec §3.9; setPrimaryBridge checks a new primary against it).
    function _setMaxBatchValue(uint256 value) internal {
        if (value > MAX_BATCH_VALUE) revert InvalidParameter();
        _requireBridgeCap(primaryBridge, value);
        maxBatchValue = value;
        emit LimitSet("maxBatchValue", value, 0);
    }

    /// Down loosens (a batch, and its redeems, leave sooner): scheduled (spec §3.6); up, or the same, at once.
    function setBatchInterval(uint64 interval) external onlyOwner {
        _requireScheduledIfLoosens(interval < batchInterval);
        _setBatchInterval(interval);
    }

    function _setBatchInterval(uint64 interval) internal {
        if (interval > MAX_BATCH_INTERVAL) revert InvalidParameter();
        batchInterval = interval;
        emit LimitSet("batchInterval", interval, 0);
    }

    function setRedeemRequestFee(uint256 fee) external onlyOwner {
        _setRedeemRequestFee(fee);
    }

    function _setRedeemRequestFee(uint256 fee) internal {
        if (fee > MAX_REDEEM_REQUEST_FEE) revert InvalidParameter();
        redeemRequestFee = fee;
        emit LimitSet("redeemRequestFee", fee, 0);
    }

    /// address(0) stops deliveries; manual claims are unaffected.
    function setKeeper(address newKeeper) external onlyOwner {
        _setKeeper(newKeeper);
    }

    function _setKeeper(address newKeeper) internal {
        keeper = newKeeper;
        emit KeeperSet(newKeeper);
    }

    /// The swapper receives a delivery's TAO and pays the front door; it can make a delivery revert,
    /// never pay short. Scheduled only (the Param class), whatever the swapper (spec §3.6).
    function setSwapper(address newSwapper) external onlyScheduled {
        _setSwapper(newSwapper);
    }

    function _setSwapper(address newSwapper) internal {
        swapper = newSwapper;
        emit SwapperSet(newSwapper);
    }

    /// Scheduled only (the Param class), whatever the oracle (spec §3.6).
    function setOracle(ICascadeTwap newOracle) external onlyScheduled {
        _setOracle(newOracle);
    }

    function _setOracle(ICascadeTwap newOracle) internal {
        oracle = newOracle;
        emit OracleSet(address(newOracle));
    }

    /// The market floor's discount to the oracle's value, in bps, at most MAX_DELIVERY_SLIPPAGE_BPS. Up
    /// loosens (a lower floor): scheduled (spec §3.6).
    function setMaxDeliverySlippage(uint16 bps) external onlyOwner {
        _requireScheduledIfLoosens(bps > maxDeliverySlippageBps);
        _setMaxDeliverySlippage(bps);
    }

    function _setMaxDeliverySlippage(uint16 bps) internal {
        if (bps > MAX_DELIVERY_SLIPPAGE_BPS) revert FeeTooHigh();
        maxDeliverySlippageBps = bps;
        emit MaxDeliverySlippageSet(bps);
    }

    /// Pool `index`'s depth floor on deliveries (`minPoolLiquidity`: 0 TAO/WETH, 1 WETH/USDC). Down loosens (a
    /// delivery through a thinner pool): scheduled (spec §3.6); up, or the same, at once. Any value, 0 included, which
    /// checks nothing: the emergency path if liquidity moves to other pools for good. An index above 1 names no pool,
    /// so it has no floor to cut: InvalidParameter whatever the value, directly or at execute. The floor reads a
    /// harmonic mean, which one block of a near-empty range collapses for up to 30 minutes (see `minPoolLiquidity`):
    /// whoever thins TAO/WETH for a block holds deliveries that long, a delay and never a loss, as `claim` never reads
    /// the floors.
    function setMinPoolLiquidity(uint8 index, uint128 value) external onlyOwner {
        if (index > 1) revert InvalidParameter();
        _requireScheduledIfLoosens(value < minPoolLiquidity[index]);
        _setMinPoolLiquidity(index, value);
    }

    /// The write and its log, which the constructor runs on each of `Params.minPoolLiquidity`'s two floors.
    function _setMinPoolLiquidity(uint8 index, uint128 value) internal {
        minPoolLiquidity[index] = value;
        emit LimitSet("minPoolLiquidity", index, value);
    }

    /// The front door's schedulable setters (spec §3.6), then CascadeBase's: each the Param class (48 hours),
    /// Ordinary, at its canonical length of one word per argument (setMinPoolLiquidity's two, the rest one).
    /// setOracle and setSwapper whatever their value; the limit setters whatever their direction (a tightening or
    /// an equal value waits and executes harmlessly, spec §3.10.6), and setMinPoolLiquidity whatever its index (one
    /// above 1 fails at execute). Each setter's own decoder checks its arguments at execute (an item with dirty bits
    /// never runs).
    function _classify(bytes calldata data) internal view override returns (Delay, Kind) {
        // casting to 'bytes4' keeps the selector, the first 4 bytes of data (zero-padded when shorter)
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes4 s = bytes4(data);
        if (
            s == this.setOracle.selector || s == this.setSwapper.selector || s == this.setMaxDeliverySlippage.selector
                || s == this.setBatchInterval.selector || s == this.setMaxBatchValue.selector
        ) {
            _requireArgs(data, 1);
            return (Delay.Param, Kind.Ordinary);
        }
        if (s == this.setMinPoolLiquidity.selector) {
            _requireArgs(data, 2);
            return (Delay.Param, Kind.Ordinary);
        }
        return super._classify(data);
    }

    /// setPrimaryBridge's cap check (CascadeBase): maxBatchValue within the new primary's maxMessageValue(), else
    /// AboveBridgeCap (spec §3.9). A bridge with a smaller cap becomes primary once the owner has tightened to it.
    function _checkBridgeCaps(address bridge) internal view override {
        _requireBridgeCap(bridge, maxBatchValue);
    }

    /// The inbound check (spec §3.2, H-2 i): NotBridge unless the caller is a known bridge, ever activated, enabled or
    /// disabled since. A delivery credits only tokens that have arrived (TokensNotReceived) into that bridge's own
    /// replay record, so a disabled bridge is bounded exactly as an enabled one; disableBridge stops only its sends.
    function _requireBridge() internal view override {
        if (!bridgeKnown[msg.sender]) revert NotBridge();
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

    /// Sends the open batch through the primary bridge with `budget` wei for the fee: the batch's pot plus
    /// the closer's msg.value, or the pot alone for a self-close. The fee is paid from the pot first and from
    /// the closer's value only for the rest; the pot's remainder opens the next batch as its pot
    /// (`potCarried`), and the caller gets back only the unused part of its own value. Requires `budget >=
    /// open.feePot` (each caller passes the pot plus what it adds), which keeps the refund from underflowing.
    /// (A budget, not the closer's value alone: a constant 0 from the self-close made via_ir inline a second
    /// copy, about 830 B.)
    function _closeBatch(uint256 budget) internal {
        uint64 id = open.id;
        uint256 totalDeposits = open.totalDeposits;
        bytes memory message = CascadeMessages.encodeBatch(id, open.deposits, open.redeems);
        ICascadeBridge bridge = _primary();
        uint256 fee = bridge.quoteFee(vaultChain, vault, message, totalDeposits);
        if (budget < fee) revert InsufficientFee();
        uint256 pot = open.feePot;
        uint256 potUsed = Math.min(pot, fee);
        uint256 carried = pot - potUsed;
        uint256 nDeposits = open.deposits.length;
        uint256 nRedeems = open.redeems.length;

        netForwarded += totalDeposits;
        delete open;
        open.id = id + 1;
        open.start = uint64(block.timestamp);
        open.feePot = carried;
        potCarried = carried;

        if (totalDeposits > 0) asset.forceApprove(address(bridge), totalDeposits);
        bridge.send{value: fee}(vaultChain, vault, message, totalDeposits);
        if (totalDeposits > 0) asset.forceApprove(address(bridge), 0);
        // the refund, budget - fee - carried: a closer's msg.value - (fee - potUsed), a self-close's 0, never any
        // of the pot (I-21); with budget >= fee and budget >= feePot it is at least 0 (carried is 0 or pot - fee)
        _pay(msg.sender, budget - fee - carried);
        emit BatchClosed(id, totalDeposits, nDeposits, nRedeems, fee, potUsed, carried);
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
