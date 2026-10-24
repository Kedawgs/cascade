// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ICascadeBridge} from "../interfaces/ICascadeBridge.sol";
import {CascadeMessages} from "../libraries/CascadeMessages.sol";
import {Client} from "../vendor/ccip/Client.sol";
import {IAny2EVMMessageReceiver} from "../vendor/ccip/IAny2EVMMessageReceiver.sol";
import {IRouterClient} from "../vendor/ccip/IRouterClient.sol";

/// @notice Shared base of the two Chainlink CCIP adapters (Base and Bittensor EVM). It holds the
/// fixed configuration, the gas model, the payload encoding and the sending and receiving paths;
/// the concrete adapters supply the four hooks (amount check, fee budget, token collection, delivery).
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
    }

    // ---- constants and immutables ----

    uint256 public constant GAS_CAP = 7_000_000;
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
    event Delivered(
        bytes32 indexed messageId, uint64 sourceChain, address indexed sender, address indexed recipient, uint256 amount
    );

    error ZeroAddress();
    error SameChain();
    error GasModelTooLarge();
    error WrongDestination();
    error MessageTooLarge();
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

    constructor(Config memory c) {
        if (c.router == address(0) || c.token == address(0) || c.remoteAdapter == address(0)) revert ZeroAddress();
        if (c.localChainId == c.remoteChainId) revert SameChain();
        // The largest legal message holds 2 * MAX_ENTRIES entries and must still fit under the cap.
        if (c.gasBase + 2 * CascadeMessages.MAX_ENTRIES * c.gasPerEntry > GAS_CAP) revert GasModelTooLarge();
        router = IRouterClient(c.router);
        token = IERC20(c.token);
        localChainId = c.localChainId;
        remoteChainId = c.remoteChainId;
        remoteSelector = c.remoteSelector;
        remoteAdapter = c.remoteAdapter;
        gasBase = c.gasBase;
        gasPerEntry = c.gasPerEntry;
    }

    // ---- helpers ----

    /// @notice Destination gas limit for `message`: `gasBase + entries * gasPerEntry`, capped at
    /// `GAS_CAP`; the cap itself when the message is malformed or of an unknown kind.
    function gasFor(bytes calldata message) public view returns (uint256) {
        if (message.length < 32 || message.length % 32 != 0) return GAS_CAP;
        uint256 words = message.length / 32;
        uint8 kind = uint8(uint256(bytes32(message[0:32])));
        uint256 header;
        if (kind == CascadeMessages.BATCH) header = 6;
        else if (kind == CascadeMessages.PAYOUTS) header = 5;
        else return GAS_CAP;
        if (words < header || (words - header) % 2 != 0) return GAS_CAP;
        // (words - header) is even here, so the division is exact.
        // forge-lint: disable-next-line(divide-before-multiply)
        uint256 gas = gasBase + ((words - header) / 2) * gasPerEntry;
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
    function send(uint64 destChain, address recipient, bytes calldata message, uint256 amount) external payable {
        _checkSend(destChain, recipient, amount);
        Client.EVM2AnyMessage memory m = buildMessage(recipient, msg.sender, message, amount);
        uint256 fee = router.getFee(remoteSelector, m);
        if (_budget(amount) < fee) revert InsufficientFee();
        if (amount > 0) _collect(amount);
        bytes32 id = router.ccipSend{value: fee}(remoteSelector, m);
        if (amount > 0) token.forceApprove(address(router), 0);
        emit Sent(id, destChain, msg.sender, recipient, amount, fee, gasFor(message));
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

    /// @notice The exact CCIP message `send` hands to the router.
    function buildMessage(address recipient, address sender, bytes calldata message, uint256 amount)
        public
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
        m.extraArgs = extraArgs(gasFor(message));
    }

    function _checkSend(uint64 destChain, address recipient, uint256 amount) internal view {
        if (destChain != remoteChainId) revert WrongDestination();
        if (recipient == address(0)) revert ZeroAddress();
        if (amount > MAX_MESSAGE_VALUE) revert MessageTooLarge();
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
        _deliver(recipient, sender, payload, amount);
        emit Delivered(message.messageId, remoteChainId, sender, recipient, amount);
    }

    // ---- hooks ----

    /// @dev Side-specific minimum amount check.
    function _checkAmount(uint256 amount) internal view virtual;

    /// @dev The part of msg.value available to pay the CCIP fee.
    function _budget(uint256 amount) internal view virtual returns (uint256);

    /// @dev Obtain `amount` tokens and approve the router for them.
    function _collect(uint256 amount) internal virtual;

    /// @dev Hand a verified incoming message to its recipient.
    function _deliver(address recipient, address sender, bytes memory message, uint256 amount) internal virtual;
}
