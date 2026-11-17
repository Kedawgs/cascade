// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ICascadeBridge} from "../../src/interfaces/ICascadeBridge.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";

/// The vault's entry points a re-entering bridge calls.
interface IReenteredVault {
    function processPayouts(bytes32 key, CascadeMessages.Payout[] calldata payouts, uint32 maxEntries) external;
    function redeemDirect(uint256 shares, bool acceptMissing) external;
}

/// @notice A native-side bridge whose `send` re-enters the vault (Task 5g): the payout engine sends last, under
/// the vault's lock and with its transient unstake flag clear. `Mode.Catch` tries processPayouts, redeemDirect
/// and a plain 1-wei transfer back to the vault, records what each returned and completes the send; each
/// `Bubble` mode makes one of them and bubbles its revert, so the vault's call reverts whole. `Mode.Off` is a
/// plain bridge. Never refunds.
contract ReentrantBridge is ICascadeBridge {
    enum Mode {
        Off,
        Catch,
        BubbleProcess,
        BubbleRedeem,
        BubbleTransfer
    }

    error InsufficientFee();

    address public immutable vault;
    uint256 public fee;
    Mode public mode;
    /// The batch the re-entering processPayouts names.
    bytes32 public reenterKey;

    uint256 public sendCount;
    uint256 public lastValue;
    uint256 public lastAmount;

    // what each re-entry returned, in Mode.Catch
    bool public processOk;
    bytes public processReturn;
    bool public redeemOk;
    bytes public redeemReturn;
    bool public transferOk;
    bytes public transferReturn;

    constructor(address vault_) {
        vault = vault_;
    }

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function setMode(Mode mode_, bytes32 key) external {
        mode = mode_;
        reenterKey = key;
    }

    function send(uint64, address, bytes calldata, uint256 amount) external payable {
        if (msg.value < amount + fee) revert InsufficientFee();
        ++sendCount;
        lastValue = msg.value;
        lastAmount = amount;
        Mode m = mode;
        if (m == Mode.Off) return;

        CascadeMessages.Payout[] memory none;
        bytes memory process = abi.encodeCall(IReenteredVault.processPayouts, (reenterKey, none, 0));
        bytes memory redeem = abi.encodeCall(IReenteredVault.redeemDirect, (1, false));
        if (m == Mode.Catch) {
            (processOk, processReturn) = vault.call(process);
            (redeemOk, redeemReturn) = vault.call(redeem);
            (transferOk, transferReturn) = vault.call{value: 1}("");
            return;
        }
        bool ok;
        bytes memory ret;
        if (m == Mode.BubbleProcess) (ok, ret) = vault.call(process);
        else if (m == Mode.BubbleRedeem) (ok, ret) = vault.call(redeem);
        else (ok, ret) = vault.call{value: 1}("");
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function quoteFee(uint64, address, bytes calldata, uint256) external view returns (uint256) {
        return fee;
    }

    /// The lane's 5,000 TAO (ICascadeBridge, spec §3.9): any of the vault's message limits fits.
    function maxMessageValue() external pure returns (uint256) {
        return 5_000e18;
    }
}
