// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Client} from "../../src/vendor/ccip/Client.sol";
import {IRouterClient} from "../../src/vendor/ccip/IRouterClient.sol";
import {IAny2EVMMessageReceiver} from "../../src/vendor/ccip/IAny2EVMMessageReceiver.sol";
import {MockTAO} from "./MockTAO.sol";

/// @notice Chainlink CCIP router double: the send-side checks of the real Router (V3 extra args, gas and
/// data caps, exact native fee) and the delivery rules of the 2.0 OffRamp (a receiver is only called if
/// it advertises ccipReceive; a failed call leaves no tokens minted). Sends are recorded, never delivered;
/// tests call `deliver` themselves.
contract MockRouter is IRouterClient {
    using SafeERC20 for IERC20;

    struct Sent {
        uint64 destSelector;
        bytes receiver;
        bytes data;
        Client.EVMTokenAmount[] tokenAmounts;
        address feeToken;
        bytes extraArgs;
        uint256 value;
        bytes32 messageId;
    }

    error GasTooHigh(uint256 gasLimit, uint256 maxGas);
    error DataTooLarge(uint256 length);
    error TooManyTokens();
    error BadExtraArgs();
    error UnsupportedFeeToken();
    error DeliveryFailed(bytes reason);
    error OnlySelf();

    /// The 4-byte tag of the 19-byte V3 extra args.
    bytes4 private constant V3_TAG = 0xa69dd4aa;
    /// The interface id the OffRamp checks with supportsInterface: ccipReceive's selector.
    bytes4 private constant RECEIVER_ID = 0x85572ffb;

    /// The local bridged token: pulled on send, minted on delivery.
    MockTAO public immutable token;

    uint256 public fee;
    uint256 public maxGas = 7_000_000;
    uint256 public maxDataBytes = 32_000;

    Sent[] private _sent;

    constructor(MockTAO token_) {
        token = token_;
    }

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function setMaxGas(uint256 maxGas_) external {
        maxGas = maxGas_;
    }

    function setMaxDataBytes(uint256 maxDataBytes_) external {
        maxDataBytes = maxDataBytes_;
    }

    function isChainSupported(uint64) external pure returns (bool) {
        return true;
    }

    /// @dev `public` so ccipSend can call it; the interface declares it external, which this may override.
    function getFee(uint64, Client.EVM2AnyMessage memory m) public view returns (uint256) {
        uint256 gasLimit = gasLimitOf(m.extraArgs);
        if (gasLimit > maxGas) revert GasTooHigh(gasLimit, maxGas);
        if (m.data.length >= maxDataBytes) revert DataTooLarge(m.data.length);
        if (m.tokenAmounts.length > 1) revert TooManyTokens();
        return fee;
    }

    /// @dev Parses the 19-byte V3 extra args: the tag (4 bytes) then the uint32 gas limit (bytes 4..8).
    // bytes4 of bytes keeps the first four bytes by design; the tag is compared, not a value.
    function gasLimitOf(bytes memory extraArgs) public pure returns (uint32 gasLimit) {
        // forge-lint: disable-next-line(unsafe-typecast)
        if (extraArgs.length != 19 || bytes4(extraArgs) != V3_TAG) revert BadExtraArgs();
        uint256 word;
        assembly {
            word := mload(add(extraArgs, 0x20))
        }
        // The top 32 bits after the shift hold the 4 gas-limit bytes, so the narrowing is exact.
        // forge-lint: disable-next-line(unsafe-typecast)
        gasLimit = uint32(word >> 192);
    }

    function ccipSend(uint64 sel, Client.EVM2AnyMessage calldata m) external payable returns (bytes32 id) {
        if (m.feeToken != address(0)) revert UnsupportedFeeToken();
        if (msg.value != getFee(sel, m)) revert InvalidMsgValue();
        for (uint256 i; i < m.tokenAmounts.length; ++i) {
            IERC20(m.tokenAmounts[i].token).safeTransferFrom(msg.sender, address(this), m.tokenAmounts[i].amount);
        }
        id = keccak256(abi.encode(_sent.length + 1));
        Sent storage s = _sent.push();
        s.destSelector = sel;
        s.receiver = m.receiver;
        s.data = m.data;
        for (uint256 i; i < m.tokenAmounts.length; ++i) {
            s.tokenAmounts.push(m.tokenAmounts[i]);
        }
        s.feeToken = m.feeToken;
        s.extraArgs = m.extraArgs;
        s.value = msg.value;
        s.messageId = id;
    }

    function sendCount() external view returns (uint256) {
        return _sent.length;
    }

    function sendAt(uint256 i) external view returns (Sent memory) {
        return _sent[i];
    }

    function lastSend() external view returns (Sent memory) {
        return _sent[_sent.length - 1];
    }

    /// @notice Delivers `m` to `receiver` the way the 2.0 OffRamp does.
    /// @return called whether the receiver's ccipReceive was invoked
    /// @return ok whether the delivery succeeded
    /// @return reason the revert data when it did not
    function deliver(address receiver, Client.Any2EVMMessage memory m, uint256 gas)
        external
        returns (bool called, bool ok, bytes memory reason)
    {
        if (receiver.code.length == 0 || !_supportsReceiver(receiver)) {
            _mintTo(receiver, m);
            return (false, true, "");
        }
        try this.deliverAtomic(receiver, m, gas) {
            return (true, true, "");
        } catch (bytes memory err) {
            return (true, false, err);
        }
    }

    /// @dev Only callable through `deliver`, so the mint and the call revert together.
    function deliverAtomic(address receiver, Client.Any2EVMMessage memory m, uint256 gas) external {
        if (msg.sender != address(this)) revert OnlySelf();
        _mintTo(receiver, m);
        (bool success, bytes memory ret) =
            receiver.call{gas: gas}(abi.encodeCall(IAny2EVMMessageReceiver.ccipReceive, (m)));
        if (!success) revert DeliveryFailed(ret);
    }

    function _mintTo(address receiver, Client.Any2EVMMessage memory m) private {
        for (uint256 i; i < m.destTokenAmounts.length; ++i) {
            require(m.destTokenAmounts[i].token == address(token), "MockRouter: wrong token");
            token.mint(receiver, m.destTokenAmounts[i].amount);
        }
    }

    function _supportsReceiver(address receiver) private view returns (bool) {
        try IERC165(receiver).supportsInterface(RECEIVER_ID) returns (bool yes) {
            return yes;
        } catch {
            return false;
        }
    }
}
