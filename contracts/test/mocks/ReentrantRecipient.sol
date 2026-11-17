// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ICascadeReceiver} from "../../src/interfaces/ICascadeBridge.sol";

/// @notice A caller and bridge recipient that re-enters whatever pays it (ruling C5). It makes its calls through
/// `forward`, so it is their msg.sender. `Mode.Off` accepts any value and any delivery. In `Mode.ReenterOnReceive`
/// (Task 21) each payment its receive() takes (the vault's refund to its caller) calls `target` back with `reentry`,
/// records what that call returned, and then, with `bubble`, reverts with the re-entry's revert data, so the payment
/// to it fails, or else accepts the value.
/// The adapter modes (Task 26; spec §3.2, H-3, I-11) act on `onBridgeMessage`, the Bittensor adapter's delivery, and
/// record the re-entry the same way (`reentryOk`, `reentryReturn`):
/// - `Mode.RevertThenReenter`: a recipient that refuses its batch (while `refusing`, so the batch parks as native
///   TAO) and, once a delivery pays it, re-enters (`deliverParked` for its own key: the double payment the spec's
///   delete-then-call order and lock prevent) and accepts;
/// - `Mode.ReenterThenRevert`: re-enters, then reverts, with the re-entry's revert data when `bubble` and the
///   re-entry failed (else `Refused()`), so the delivery fails after the re-entry;
/// - `Mode.TwoLevel`: re-enters and accepts; if the adapter calls it again from inside that re-entry (a nested
///   delivery), it re-enters a second time there, `target2` with `reentry2`, and records that it got there
///   (`secondLevelReached`, `reentry2Ok`, `reentry2Return`).
/// While `refusing` is set, every delivery reverts `Refused()`, in any mode.
contract ReentrantRecipient is ICascadeReceiver {
    enum Mode {
        Off,
        ReenterOnReceive,
        RevertThenReenter,
        ReenterThenRevert,
        TwoLevel
    }

    error Refused();

    Mode public mode;
    address public target;
    bytes public reentry;
    bool public bubble;
    /// Every delivery reverts Refused() while set.
    bool public refusing;
    /// `Mode.TwoLevel`'s second re-entry, made from a nested delivery.
    address public target2;
    bytes public reentry2;

    /// How many payments receive() took.
    uint256 public received;
    /// How many deliveries onBridgeMessage accepted.
    uint256 public delivered;
    /// What the last re-entry returned.
    bool public reentryOk;
    bytes public reentryReturn;
    /// `Mode.TwoLevel`: whether a nested delivery reached it, and what its second re-entry returned.
    bool public secondLevelReached;
    bool public reentry2Ok;
    bytes public reentry2Return;
    /// `Mode.TwoLevel`: 1 while its first re-entry runs.
    uint256 private depth;

    function setMode(Mode mode_, address target_, bytes calldata reentry_, bool bubble_) external {
        mode = mode_;
        target = target_;
        reentry = reentry_;
        bubble = bubble_;
    }

    function setRefusing(bool on) external {
        refusing = on;
    }

    function setSecondLevel(address target2_, bytes calldata reentry2_) external {
        target2 = target2_;
        reentry2 = reentry2_;
    }

    /// Calls `to` with `data` and this call's value, as this contract; bubbles a revert.
    function forward(address to, bytes calldata data) external payable returns (bytes memory ret) {
        bool ok;
        (ok, ret) = to.call{value: msg.value}(data);
        if (!ok) _bubble(ret);
    }

    receive() external payable {
        ++received;
        if (mode != Mode.ReenterOnReceive) return;
        (reentryOk, reentryReturn) = target.call(reentry);
        if (!reentryOk && bubble) _bubble(reentryReturn);
    }

    function onBridgeMessage(uint64, address, bytes calldata, uint256) external payable {
        if (refusing) revert Refused();
        if (mode == Mode.RevertThenReenter) {
            (reentryOk, reentryReturn) = target.call(reentry);
        } else if (mode == Mode.ReenterThenRevert) {
            (reentryOk, reentryReturn) = target.call(reentry);
            if (bubble && !reentryOk) _bubble(reentryReturn);
            revert Refused();
        } else if (mode == Mode.TwoLevel) {
            if (depth == 0) {
                depth = 1;
                (reentryOk, reentryReturn) = target.call(reentry);
                depth = 0;
            } else {
                secondLevelReached = true;
                (reentry2Ok, reentry2Return) = target2.call(reentry2);
            }
        }
        ++delivered;
    }

    function _bubble(bytes memory ret) private pure {
        assembly ("memory-safe") {
            revert(add(ret, 32), mload(ret))
        }
    }
}
