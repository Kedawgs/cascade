// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {InvalidParameter} from "../CascadeErrors.sol";
import {ICascadeBridge} from "../interfaces/ICascadeBridge.sol";
import {CascadeMessages} from "../libraries/CascadeMessages.sol";
import {Client} from "../vendor/ccip/Client.sol";
import {IAny2EVMMessageReceiver} from "../vendor/ccip/IAny2EVMMessageReceiver.sol";
import {IRouterClient} from "../vendor/ccip/IRouterClient.sol";

/// @notice Shared base of the two Chainlink CCIP adapters (Base and Bittensor EVM). It holds the
/// fixed configuration, the gas model, the payload encoding, the one path to the router
/// (`_ccipSend`), the receiving path and the treasury payment of a sweep; the concrete adapters
/// supply the four hooks (amount check, fee budget, token collection, delivery).
/// @dev The gas limit for the destination call is a linear function of the number of batch or
/// payout entries, capped at `GAS_CAP`. A message that does not parse quotes the cap.
abstract contract CcipAdapterBase is ICascadeBridge, IAny2EVMMessageReceiver, IERC165 {
    using SafeERC20 for IERC20;

    struct Config {
        address router;
        address token;
        uint64 localChainId;
        uint64 remoteChainId;
        uint64 remoteSelector;
        address remoteAdapter;
        uint256 gasBase;
        uint256 gasPerEntry;
        uint256 maxMessageValue;
        address treasury;
    }

    // ---- constants and immutables ----

    uint256 public constant GAS_CAP = 7_000_000;
    /// @notice The lane's per-message limit (ForeverMoney's pool bucket capacity): the most
    /// `maxMessageValue` may be.
    uint256 public constant MAX_MESSAGE_VALUE = 5_000e18;
    bytes4 public constant EXTRA_ARGS_V3_TAG = 0xa69dd4aa;
    uint256 internal constant RAO = 1e9;

    IRouterClient public immutable router;
    IERC20 public immutable token;
    uint64 public immutable localChainId;
    uint64 public immutable remoteChainId;
    uint64 public immutable remoteSelector;
    address public immutable remoteAdapter;
    uint256 public immutable gasBase;
    uint256 public immutable gasPerEntry;
    /// @notice The most one send may carry, chosen at deployment (near the real batch and payout size),
    /// at most MAX_MESSAGE_VALUE.
    uint256 public immutable maxMessageValue;
    /// @notice The one payee of a sweep (`SurplusSwept`), fixed at deployment.
    address public immutable treasury;

    // ---- events and errors ----

    event Sent(
        bytes32 indexed messageId,
        uint64 destChain,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        uint256 fee,
        uint256 gasLimit
    );
    /// CCIP's message `messageId` was handled: on Base, delivered; on Bittensor, delivered or parked, since
    /// `ccipReceive` emits it after a park too (R3 B-I3), so an indexer reads the same transaction's
    /// `BatchParked` first.
    event Delivered(
        bytes32 indexed messageId, uint64 sourceChain, address indexed sender, address indexed recipient, uint256 amount
    );
    event SurplusSwept(uint256 native, uint256 tokens);

    error ZeroAddress();
    error SameChain();
    error GasModelTooLarge();
    error WrongDestination();
    error MessageTooLarge();
    error MessageCapOutOfRange();
    error BelowSendMinimum(uint256 amount, uint256 minimum);
    error BelowConversionFloor(uint256 amount, uint256 floor);
    error InsufficientFee();
    error NotRaoAligned();
    error ConversionShort();
    error NotRouter();
    error WrongSource();
    error WrongSender();
    error WrongToken();
    error TooManyTokens();
    error UnexpectedValue();
    error TransferFailed();

    constructor(Config memory c) {
        if (
            c.router == address(0) || c.token == address(0) || c.remoteAdapter == address(0) || c.treasury == address(0)
        ) revert ZeroAddress();
        if (c.localChainId == c.remoteChainId) revert SameChain();
        _checkGasModel(c.gasBase, c.gasPerEntry);
        // A zero selector names no lane.
        if (c.remoteSelector == 0) revert InvalidParameter();
        if (c.maxMessageValue == 0 || c.maxMessageValue > MAX_MESSAGE_VALUE) revert MessageCapOutOfRange();
        router = IRouterClient(c.router);
        token = IERC20(c.token);
        localChainId = c.localChainId;
        remoteChainId = c.remoteChainId;
        remoteSelector = c.remoteSelector;
        remoteAdapter = c.remoteAdapter;
        gasBase = c.gasBase;
        gasPerEntry = c.gasPerEntry;
        maxMessageValue = c.maxMessageValue;
        treasury = c.treasury;
    }

    // ---- helpers ----

    /// @dev A gas model's two checks: the largest legal message holds 2 * MAX_ENTRIES entries and must still fit under
    /// the cap (`GasModelTooLarge`), and a model of 0 and 0 gives every message no gas (`InvalidParameter`, R3 A-I4).
    function _checkGasModel(uint256 base, uint256 perEntry) internal pure {
        if (base + 2 * CascadeMessages.MAX_ENTRIES * perEntry > GAS_CAP) revert GasModelTooLarge();
        if (base + perEntry == 0) revert InvalidParameter();
    }

    /// @notice Destination gas limit for `message`: `gasBase + entries * gasPerEntry`, capped at
    /// `GAS_CAP`; the cap itself when the message is malformed or of an unknown kind.
    function gasFor(bytes memory message) public view returns (uint256) {
        return _gasModel(message, gasBase, gasPerEntry);
    }

    /// @dev The gas model `base + entries * perEntry` for `message`, capped at `GAS_CAP`; the cap itself when the
    /// message is malformed or of an unknown kind. `gasFor` runs it on this adapter's own pair (its sends); the
    /// Bittensor adapter also runs it on the lane's inbound pair (its parked deliveries' gas requirement, R4).
    function _gasModel(bytes memory message, uint256 base, uint256 perEntry) internal pure returns (uint256) {
        if (message.length < 32 || message.length % 32 != 0) return GAS_CAP;
        uint256 words = message.length / 32;
        // casting to 'bytes32' is safe because the length check above leaves at least one whole word,
        // and the conversion reads exactly that first word (the kind)
        // forge-lint: disable-next-line(unsafe-typecast)
        uint8 kind = uint8(uint256(bytes32(message)));
        uint256 header;
        if (kind == CascadeMessages.BATCH) header = 6;
        else if (kind == CascadeMessages.PAYOUTS) header = 5;
        else return GAS_CAP;
        if (words < header || (words - header) % 2 != 0) return GAS_CAP;
        // (words - header) is even here, so the division is exact.
        // forge-lint: disable-next-line(divide-before-multiply)
        uint256 gas = base + ((words - header) / 2) * perEntry;
        return gas > GAS_CAP ? GAS_CAP : gas;
    }

    /// @notice CCIP GenericExtraArgsV3 with only a gas limit: tag, uint32 gas, no finality, no extras.
    function extraArgs(uint256 gasLimit) public pure returns (bytes memory) {
        // gasLimit never exceeds GAS_CAP (7_000_000), which fits in uint32.
        // forge-lint: disable-next-line(unsafe-typecast)
        return abi.encodePacked(EXTRA_ARGS_V3_TAG, uint32(gasLimit), bytes4(0), bytes7(0));
    }

    function encodePayload(address recipient, address sender, bytes memory message) public pure returns (bytes memory) {
        return abi.encode(recipient, sender, message);
    }

    function decodePayload(bytes memory data)
        public
        pure
        returns (address recipient, address sender, bytes memory message)
    {
        return abi.decode(data, (address, address, bytes));
    }

    /// @dev Only the CCIP receiver interface and ERC-165; not the CCV interface of other CCIP versions.
    function supportsInterface(bytes4 id) public pure virtual returns (bool) {
        return id == type(IAny2EVMMessageReceiver).interfaceId || id == type(IERC165).interfaceId;
    }

    // ---- sending ----

    /// @inheritdoc ICascadeBridge
    /// @dev Checks everything before anything moves (the amount checks included, so the error is the
    /// adapter's own and not the conversion's), takes the fee budget from msg.value, collects, then
    /// hands over to the shared path, which makes no amount check of its own. It takes no lock, so from
    /// the collection to `router.ccipSend` it must call no code but the immutable token, alpha vault and
    /// router: the value in flight (the collected tokens, the fee budget) is in the balance but in no
    /// park total, and the Bittensor adapter's `sweepSurplus` would count it as surplus (I-7). A future
    /// callback here must take that lock or account for the value in flight.
    function send(uint64 destChain, address recipient, bytes calldata message, uint256 amount) external payable {
        _checkSend(destChain, recipient, amount);
        uint256 feeBudget = _budget(amount);
        if (amount > 0) _collect(amount);
        _ccipSend(recipient, msg.sender, message, amount, feeBudget);
    }

    /// @inheritdoc ICascadeBridge
    function quoteFee(uint64 destChain, address recipient, bytes calldata message, uint256 amount)
        external
        view
        returns (uint256)
    {
        _checkSend(destChain, recipient, amount);
        return router.getFee(remoteSelector, buildMessage(recipient, msg.sender, message, amount));
    }

    /// @notice The exact CCIP message `send` (and every other send, through `_ccipSend`) hands to the router.
    function buildMessage(address recipient, address sender, bytes memory message, uint256 amount)
        public
        view
        returns (Client.EVM2AnyMessage memory)
    {
        return _buildMessage(recipient, sender, message, amount, gasFor(message));
    }

    /// @dev The one path to the router, shared by `send` and the Bittensor adapter's refund. It never
    /// collects: the caller has already brought `amount` tokens into the adapter and approved the
    /// router for them (`_collect`, or a refund's approval of tokens it holds). It makes no amount
    /// check: `send` makes send's two (`_checkSend`: this adapter's per-message cap and the side's
    /// minimum) before it collects, and a refund makes neither (spec §3.2: the conversion floor
    /// applies only to conversions; I-10: no floor or cap may trap a refund). `sender` is the
    /// payload's sender, the one `Sent` names. `feeBudget` is what the caller's msg.value leaves for
    /// the fee: the router is paid exactly the quoted fee, and any excess stays in the adapter.
    function _ccipSend(address recipient, address sender, bytes memory message, uint256 amount, uint256 feeBudget)
        internal
        returns (bytes32 messageId)
    {
        uint256 gasLimit = gasFor(message);
        Client.EVM2AnyMessage memory m = _buildMessage(recipient, sender, message, amount, gasLimit);
        uint256 fee = router.getFee(remoteSelector, m);
        if (feeBudget < fee) revert InsufficientFee();
        messageId = router.ccipSend{value: fee}(remoteSelector, m);
        if (amount > 0) token.forceApprove(address(router), 0);
        emit Sent(messageId, remoteChainId, sender, recipient, amount, fee, gasLimit);
    }

    function _buildMessage(address recipient, address sender, bytes memory message, uint256 amount, uint256 gasLimit)
        private
        view
        returns (Client.EVM2AnyMessage memory m)
    {
        m.receiver = abi.encode(remoteAdapter);
        m.data = encodePayload(recipient, sender, message);
        if (amount > 0) {
            m.tokenAmounts = new Client.EVMTokenAmount[](1);
            m.tokenAmounts[0] = Client.EVMTokenAmount(address(token), amount);
        }
        m.feeToken = address(0);
        m.extraArgs = extraArgs(gasLimit);
    }

    /// @dev Send's checks: the destination, the recipient, then its two amount checks, this adapter's
    /// per-message cap and the side's minimum.
    function _checkSend(uint64 destChain, address recipient, uint256 amount) internal view {
        if (destChain != remoteChainId) revert WrongDestination();
        if (recipient == address(0)) revert ZeroAddress();
        if (amount > maxMessageValue) revert MessageTooLarge();
        _checkAmount(amount);
    }

    // ---- receiving ----

    /// @inheritdoc IAny2EVMMessageReceiver
    function ccipReceive(Client.Any2EVMMessage calldata message) external {
        if (msg.sender != address(router)) revert NotRouter();
        if (message.sourceChainSelector != remoteSelector) revert WrongSource();
        if (message.sender.length != 32 || abi.decode(message.sender, (address)) != remoteAdapter) {
            revert WrongSender();
        }
        uint256 amount;
        if (message.destTokenAmounts.length > 1) revert TooManyTokens();
        if (message.destTokenAmounts.length == 1) {
            if (message.destTokenAmounts[0].token != address(token)) revert WrongToken();
            amount = message.destTokenAmounts[0].amount;
        }
        (address recipient, address sender, bytes memory payload) = decodePayload(message.data);
        _deliver(message.messageId, recipient, sender, payload, amount);
        emit Delivered(message.messageId, remoteChainId, sender, recipient, amount);
    }

    // ---- sweeping ----

    /// @dev Pays `tokens` and then `native` to the immutable treasury, with `SurplusSwept`. Tokens
    /// first: the native payment is the one call into the treasury's code, and by then both amounts
    /// have left, so a treasury that re-enters a sweep finds nothing to sweep (native first, a
    /// re-entry would take the tokens and the outer token transfer would revert). The caller
    /// computes the amounts and must write no state before this.
    function _sweep(uint256 native, uint256 tokens) internal {
        emit SurplusSwept(native, tokens);
        if (tokens > 0) token.safeTransfer(treasury, tokens);
        if (native > 0) {
            (bool ok,) = treasury.call{value: native}("");
            if (!ok) revert TransferFailed();
        }
    }

    // ---- hooks ----

    /// @dev Side-specific minimum amount check.
    function _checkAmount(uint256 amount) internal view virtual;

    /// @dev The part of msg.value available to pay the CCIP fee.
    function _budget(uint256 amount) internal view virtual returns (uint256);

    /// @dev Obtain `amount` tokens and approve the router for them (before `_ccipSend`, which never collects).
    function _collect(uint256 amount) internal virtual;

    /// @dev Hand a verified incoming message, CCIP's `messageId`, to its recipient.
    function _deliver(bytes32 messageId, address recipient, address sender, bytes memory message, uint256 amount)
        internal
        virtual;
}
