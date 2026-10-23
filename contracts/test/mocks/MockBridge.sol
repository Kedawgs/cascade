// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ICascadeBridge, ICascadeReceiver} from "../../src/interfaces/ICascadeBridge.sol";
import {MockTAO} from "./MockTAO.sol";

/// @notice Chain-aware bridge double: one EVM holds several "chains", each connected contract an
/// endpoint on its chain, either native (value moves as msg.value) or ERC-20 (`token`). A send queues
/// a delivery; with autoDeliver (the default) it is delivered at once, inside the sender's transaction,
/// and a failing delivery is filed for retry instead of reverting the send, as on a real rail. Never
/// refunds.
contract MockBridge is ICascadeBridge {
    using SafeERC20 for IERC20;

    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct Delivery {
        uint64 destChain;
        address recipient;
        uint64 sourceChain;
        address sender;
        bytes message;
        uint256 amount;
        bool funded;
    }

    error UnknownSender();
    error InsufficientFee();
    error RateLimited();
    error NothingQueued();

    /// `index` is the delivery's position in `deliveries`; `reason` is the receiver's revert data,
    /// empty when it ran out of gas or the attempt was failed by failNext.
    event DeliveryFailed(uint256 index, bytes reason);

    MockTAO public immutable token;

    mapping(uint64 chain => address) public endpoint;
    mapping(uint64 chain => bool) public nativeOf;
    mapping(address endpoint => uint64) public chainOf;

    uint256 public fee;
    uint256 public maxMessageValue = 5_000e18;
    uint256 public deliveryGas = 7_000_000;
    bool public autoDeliver = true;
    /// Set by failNext: the next delivery attempt is filed as failed without funding or calling.
    bool public failNextAttempt;

    /// Every delivery ever queued; the two queues hold indexes into it, oldest first.
    Delivery[] public deliveries;
    uint256[] internal pending;
    uint256 internal pendingHead;
    uint256[] internal failed;
    uint256 internal failedHead;

    constructor(MockTAO token_) {
        token = token_;
    }

    // ---- configuration ----

    function connect(uint64 chain, address contract_, bool native) external {
        endpoint[chain] = contract_;
        nativeOf[chain] = native;
        chainOf[contract_] = chain;
    }

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function setMaxMessageValue(uint256 value) external {
        maxMessageValue = value;
    }

    function setDeliveryGas(uint256 gas_) external {
        deliveryGas = gas_;
    }

    function setAutoDeliver(bool on) external {
        autoDeliver = on;
    }

    function failNext() external {
        failNextAttempt = true;
    }

    // ---- ICascadeBridge ----

    function quoteFee(uint64, address, bytes calldata, uint256) external view returns (uint256) {
        return fee;
    }

    /// The source chain is the sender's connected chain. Native: msg.value covers amount + fee.
    /// ERC-20: msg.value covers the fee and `amount` tokens are pulled from the sender.
    function send(uint64 destChain, address recipient, bytes calldata message, uint256 amount) external payable {
        uint64 sourceChain = chainOf[msg.sender];
        if (sourceChain == 0) revert UnknownSender();
        bool native = nativeOf[sourceChain];
        if (msg.value < (native ? amount + fee : fee)) revert InsufficientFee();
        if (amount > maxMessageValue) revert RateLimited();
        if (!native) IERC20(address(token)).safeTransferFrom(msg.sender, address(this), amount);

        pending.push(deliveries.length);
        deliveries.push(Delivery(destChain, recipient, sourceChain, msg.sender, message, amount, false));
        if (autoDeliver) deliverNext();
    }

    // ---- delivery ----

    /// Attempts the oldest pending delivery; a failure is filed for retryNext.
    function deliverNext() public returns (bool ok) {
        if (pendingHead == pending.length) revert NothingQueued();
        return _attempt(pending[pendingHead++]);
    }

    /// Attempts the oldest failed delivery again; a failure is filed again, at the back.
    function retryNext() external returns (bool ok) {
        if (failedHead == failed.length) revert NothingQueued();
        return _attempt(failed[failedHead++]);
    }

    function pendingCount() external view returns (uint256) {
        return pending.length - pendingHead;
    }

    function failedCount() external view returns (uint256) {
        return failed.length - failedHead;
    }

    /// Funds the delivery on its destination chain once (native: the bridge's own balance; ERC-20:
    /// tokens minted to the recipient before the call), then calls the recipient with deliveryGas.
    function _attempt(uint256 index) internal returns (bool ok) {
        bytes memory reason;
        if (failNextAttempt) {
            failNextAttempt = false;
        } else {
            Delivery memory d = deliveries[index];
            bool native = nativeOf[d.destChain];
            if (!d.funded) {
                deliveries[index].funded = true;
                if (native) vm.deal(address(this), address(this).balance + d.amount);
                else token.mint(d.recipient, d.amount);
            }
            (ok, reason) = d.recipient.call{value: native ? d.amount : 0, gas: deliveryGas}(
                abi.encodeCall(ICascadeReceiver.onBridgeMessage, (d.sourceChain, d.sender, d.message, d.amount))
            );
            if (ok) return true;
        }
        failed.push(index);
        emit DeliveryFailed(index, reason);
    }
}
