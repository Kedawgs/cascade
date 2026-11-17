// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ICascadeReceiver} from "../interfaces/ICascadeBridge.sol";
import {IAlphaVault} from "../interfaces/IAlphaVault.sol";
import {IStaking, ISTAKING_ADDRESS} from "../interfaces/IStaking.sol";
import {CcipAdapterBase} from "./CcipAdapterBase.sol";

/// @notice The Bittensor EVM side of the CCIP bridge: native TAO is converted to and from the bridged
/// token through the ForeverMoney alpha vault. Sending turns the caller's native TAO into the token and
/// hands it to the router; delivery turns the token back into native TAO and pays it to the recipient.
/// @dev The adapter keeps a native reserve (`fundReserve`) that is never spent: the fee is paid out of
/// msg.value, and any rounding surplus from the alpha vault stays in the adapter.
contract CcipBittensorAdapter is CcipAdapterBase {
    using SafeERC20 for IERC20;

    IStaking public constant STAKING = IStaking(ISTAKING_ADDRESS);

    IAlphaVault public immutable alphaVault;

    event ReserveFunded(address indexed from, uint256 amount);

    constructor(Config memory c, IAlphaVault alphaVault_) CcipAdapterBase(c) {
        if (address(alphaVault_) == address(0)) revert ZeroAddress();
        alphaVault = alphaVault_;
    }

    /// @notice Smallest non-zero amount the alpha vault converts, in wei: the chain's default minimum stake
    /// (rao) times 1e9.
    function floor() public view returns (uint256) {
        return STAKING.getDefaultMinStake() * RAO;
    }

    /// @notice Tops up the native reserve that keeps the adapter's balance above zero.
    function fundReserve() external payable {
        emit ReserveFunded(msg.sender, msg.value);
    }

    /// @dev Only the alpha vault pays native TAO in (the proceeds of `withdrawLiquid`).
    receive() external payable {
        if (msg.sender != address(alphaVault)) revert UnexpectedValue();
    }

    function _checkAmount(uint256 amount) internal view override {
        if (amount != 0 && amount < floor()) revert BelowConversionFloor(amount, floor());
    }

    function _budget(uint256 amount) internal view override returns (uint256) {
        if (msg.value < amount) revert InsufficientFee();
        return msg.value - amount;
    }

    function _collect(uint256 amount) internal override {
        if (amount % RAO != 0) revert NotRaoAligned();
        uint256 before = token.balanceOf(address(this));
        alphaVault.depositLiquid{value: amount}(address(token), amount / RAO);
        if (token.balanceOf(address(this)) - before != amount) revert ConversionShort();
        token.forceApprove(address(router), amount);
    }

    function _deliver(address recipient, address sender, bytes memory message, uint256 amount) internal override {
        if (amount > 0) {
            if (amount % RAO != 0) revert NotRaoAligned();
            if (amount < floor()) revert BelowConversionFloor(amount, floor());
            uint256 before = address(this).balance;
            alphaVault.withdrawLiquid(address(token), amount, amount);
            if (address(this).balance - before < amount) revert ConversionShort();
            ICascadeReceiver(recipient).onBridgeMessage{value: amount}(remoteChainId, sender, message, amount);
        } else {
            ICascadeReceiver(recipient).onBridgeMessage(remoteChainId, sender, message, 0);
        }
    }
}
