// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ICascadeBridge} from "../../src/interfaces/ICascadeBridge.sol";

/// @notice Bridge test double: records the last send, never delivers, never refunds.
/// A non-zero `token` is the ERC-20 side; address(0) is the native side.
contract StubBridge is ICascadeBridge {
    using SafeERC20 for IERC20;

    error InsufficientFee();

    IERC20 public immutable token;

    uint256 public fee;
    uint64 public lastDestChain;
    address public lastRecipient;
    bytes public lastMessage;
    uint256 public lastAmount;
    uint256 public lastValue;
    uint256 public sendCount;
    /// The gas the last send was given (gasleft() at its entry): what a payout had left for its send (Task 20).
    uint256 public lastSendGasLeft;
    /// The per-message cap (ICascadeBridge, spec §3.9): the lane's 5,000 TAO, as the adapters' largest, unless a
    /// test lowers it to check the vault's limits against it (Task 23, AboveBridgeCap).
    uint256 public maxMessageValue = 5_000e18;
    /// What `canSendPayouts` answers (R4, S-H1): true unless a test closes the rail, as a Bittensor adapter whose
    /// AlphaVault is migrating would.
    bool internal _railOpen = true;
    /// Test-only (R4 review): the view answered as a bridge with no such view would (an empty revert, which is how a
    /// Solidity contract without the selector and without a fallback answers it), and the gas it burns before answering.
    bool public railViewMissing;
    uint256 public railViewBurn;

    constructor(IERC20 token_) {
        token = token_;
    }

    function setMaxMessageValue(uint256 value) external {
        maxMessageValue = value;
    }

    function setCanSendPayouts(bool open) external {
        _railOpen = open;
    }

    function setRailViewMissing(bool missing) external {
        railViewMissing = missing;
    }

    function setRailViewBurn(uint256 burn) external {
        railViewBurn = burn;
    }

    function canSendPayouts() external view returns (bool) {
        if (railViewMissing) revert();
        uint256 start = gasleft();
        while (start - gasleft() < railViewBurn) {}
        return _railOpen;
    }

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function send(uint64 destChain, address recipient, bytes calldata message, uint256 amount) external payable {
        uint256 given = gasleft();
        if (address(token) == address(0)) {
            if (msg.value < amount + fee) revert InsufficientFee();
        } else {
            if (msg.value < fee) revert InsufficientFee();
            token.safeTransferFrom(msg.sender, address(this), amount);
        }
        lastDestChain = destChain;
        lastRecipient = recipient;
        lastMessage = message;
        lastAmount = amount;
        lastValue = msg.value;
        sendCount++;
        lastSendGasLeft = given;
    }

    function quoteFee(uint64, address, bytes calldata, uint256) external view returns (uint256) {
        return fee;
    }
}
