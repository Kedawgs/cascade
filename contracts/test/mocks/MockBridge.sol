// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ICascadeBridge, ICascadeReceiver} from "../../src/interfaces/ICascadeBridge.sol";
import {MockTAO} from "./MockTAO.sol";

/// @notice Connects the vault (ERC-20 side) and the engine (native side) in one EVM. Messages are
/// queued FIFO and, with `autoDeliver` (the default), delivered within the sending call.
/// @dev Vault to engine: pulls `amount` tokens from the vault, then delivers `amount` native TAO with
/// the message (dealing itself the amount first, so a delivery is value-neutral for the bridge).
/// Engine to vault: keeps the native TAO, mints `amount` tokens to the vault, then delivers the
/// message. A delivery that reverts reverts the whole call and stays queued.
contract MockBridge is ICascadeBridge {
    using SafeERC20 for IERC20;

    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct Delivery {
        address to;
        bytes message;
        uint256 amount;
        bool native;
    }

    MockTAO public immutable token;
    address public vault;
    address payable public engine;
    uint256 public fee;
    bool public autoDeliver = true;

    Delivery[] internal queue;
    uint256 internal head;

    error FeeTooLow();
    error UnknownSender();
    error NothingPending();

    constructor(MockTAO token_) {
        token = token_;
    }

    function connect(address vault_, address payable engine_) external {
        vault = vault_;
        engine = engine_;
    }

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function setAutoDeliver(bool enabled) external {
        autoDeliver = enabled;
    }

    function pendingCount() external view returns (uint256) {
        return queue.length - head;
    }

    function quoteFee(bytes calldata, uint256) external view returns (uint256) {
        return fee;
    }

    function send(bytes calldata message, uint256 amount) external payable {
        if (msg.sender == vault) {
            if (msg.value < fee) revert FeeTooLow();
            IERC20(address(token)).safeTransferFrom(msg.sender, address(this), amount);
            queue.push(Delivery(engine, message, amount, true));
        } else if (msg.sender == engine) {
            if (msg.value < amount + fee) revert FeeTooLow();
            queue.push(Delivery(vault, message, amount, false));
        } else {
            revert UnknownSender();
        }
        if (autoDeliver) deliverNext();
    }

    /// @notice Delivers the oldest queued message.
    function deliverNext() public {
        if (head == queue.length) revert NothingPending();
        Delivery memory d = queue[head];
        delete queue[head];
        head++;

        if (d.native) {
            vm.deal(address(this), address(this).balance + d.amount);
            ICascadeReceiver(d.to).onBridgeMessage{value: d.amount}(d.message, d.amount);
        } else {
            token.mint(d.to, d.amount);
            ICascadeReceiver(d.to).onBridgeMessage(d.message, d.amount);
        }
    }
}
