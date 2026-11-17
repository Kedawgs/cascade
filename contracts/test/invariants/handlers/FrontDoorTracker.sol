// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {CascadeFrontDoor} from "../../../src/CascadeFrontDoor.sol";
import {CancelTooSoon} from "../../../src/CascadeErrors.sol";
import {DoorLayout} from "../../../src/lens/generated/DoorLayout.sol";
import {TrackedHandler} from "./TrackedHandler.sol";

/// @notice The front doors' fee pots and closers, one record for every campaign that closes batches (Task 37, from
/// CoreHandler; ruling: reuse, don't copy): I-18's ghost form and I-21, per door, which FrontDoorInvariants checks
/// after every step over every door the handler tracks.
///
/// I-18 (spec §3.5): per door, every wei paid into its fee pots (every first request's fee: no tracked handler pre-pays
/// credit) is in its open pot, spent on a close's fee (BatchClosed's `potUsed`) or swept to its treasury
/// (`ghostPotIn == ghostPotUsed + ghostSwept + feePot`), and the treasury holds exactly the sweeps. I-21: a closer
/// never receives more than it sent: a handler that closes counts a closer that ends with more than it sent its value
/// for (`closerGains`): itself after its own close, a requester whose request closed the batch and got anything back.
///
/// The cancel cooldown (R11, spec §3.5): each handler that cancels deposits notes every deposit of its own that went
/// through (`_noteDeposit`: a deposit, a depositFor, a stake's depositFor through the staker) for the entry's owner,
/// and predicts each cancel's CancelTooSoon from that record alone (`_cancelTooSoon`), never from the door's view
/// (`cancelableAt`): the exact revert data, the last deposit's time plus the spec's 5 minutes, and only while the door
/// holds the cooldown (R12): unpaused, with its primary bridge enabled, both read from the door's own state (`paused()`
/// and the generated layout's bridge slots), never from the rule. A predicted refusal that does not happen, or any
/// other refusal, is unexpected; a predicted one is counted (`cancelsTooSoon`), and a cancel inside the five minutes
/// that goes because the door waives the cooldown is counted by the handler (`_cooldownWaived`).
abstract contract FrontDoorTracker is TrackedHandler {
    /// The spec's cancel cooldown (Appendix B), the model's own copy: a door with another one fails the predictions.
    uint256 internal constant CANCEL_COOLDOWN = 5 minutes;

    /// Each door's users' last deposit times, from the handler's own deposits that went through.
    mapping(address door => mapping(address user => uint256)) internal _lastDepositAt;
    /// Deposit cancels refused CancelTooSoon, as predicted (the cooldown reached).
    uint256 public cancelsTooSoon;
    /// Deposit cancels inside the five minutes that went because the door waived the cooldown, paused or with its
    /// primary disabled (R12), as predicted; and the two causes apart (paused, else the primary disabled), so a campaign
    /// can show each reached.
    uint256 public cancelsWaived;
    uint256 public cancelsWaivedPaused;
    uint256 public cancelsWaivedPrimary;

    /// The front doors the handler drives, in order: FrontDoorInvariants checks each.
    CascadeFrontDoor[] internal _doors;

    /// I-18's ghosts, per door: the ETH paid into its fee pots, the pots' part of every close's fee, and what sweepPot
    /// sent its treasury.
    mapping(address door => uint256) public ghostPotIn;
    mapping(address door => uint256) public ghostPotUsed;
    mapping(address door => uint256) public ghostSwept;
    /// I-21: closes after which the closer held more ETH than before it sent its value (asserted 0).
    uint256 public closerGains;
    /// Closes and self-closes that carried a remainder into the next pot (what I-18 and I-21 run across).
    uint256 public potsCarried;

    function trackedDoors() external view returns (CascadeFrontDoor[] memory) {
        return _doors;
    }

    /// The Base lane's fee for one front-door send, by `seed` mod 4 (the closes' draw, shared by the core and the doors
    /// campaigns since Task 37's fix round): the world's fee (0), at most the pot, so the pot covers it and carries the
    /// rest (1, 2), or anywhere up to the world's fee (3).
    function _laneFee(uint256 seed, uint256 pot, uint256 worldFee) internal pure returns (uint256) {
        uint256 kind = seed % 4;
        if (kind == 0) return worldFee;
        return bound(seed / 4, 0, kind == 3 ? worldFee : pot);
    }

    /// `d`, a door the handler drives.
    function _trackDoor(CascadeFrontDoor d) internal {
        _doors.push(d);
        _trackAccount(address(d));
    }

    /// A deposit for `user` at door `d` went through now (whoever paid): its cancel waits CANCEL_COOLDOWN from now.
    function _noteDeposit(CascadeFrontDoor d, address user) internal {
        _lastDepositAt[address(d)][user] = vm.getBlockTimestamp();
    }

    /// Whether `user`'s last deposit at door `d` is less than CANCEL_COOLDOWN old now (the handler's record).
    function _inCooldown(CascadeFrontDoor d, address user) internal view returns (bool) {
        return vm.getBlockTimestamp() < _lastDepositAt[address(d)][user] + CANCEL_COOLDOWN;
    }

    /// Whether door `d` waives the cooldown now (R12, spec §3.5): it is paused (no deposit can land, so none needs
    /// holding for a close), or its primary bridge is disabled (no close with entries can land). The primary and its
    /// enabled flag are read from the door's storage at the generated layout's slots (`primaryBridge`, then its entry
    /// in `bridgeEnabled`), not through any view of the door's.
    function _cooldownWaived(CascadeFrontDoor d) internal view returns (bool) {
        if (d.paused()) return true;
        // casting to 'uint160' is safe because primaryBridge is the slot's low 20 bytes (offset 0, size 20)
        // forge-lint: disable-next-line(unsafe-typecast)
        address primary = address(uint160(uint256(vm.load(address(d), bytes32(DoorLayout.SLOT_PRIMARY_BRIDGE)))));
        bytes32 entry = keccak256(abi.encode(primary, DoorLayout.SLOT_BRIDGE_ENABLED));
        return uint256(vm.load(address(d), entry)) & 0xff == 0;
    }

    /// The revert data a deposit cancel by `user` at door `d` must meet now: CancelTooSoon(its last deposit's time plus
    /// CANCEL_COOLDOWN) while now is before that and the door holds the cooldown (unpaused, its primary enabled: R12),
    /// else empty (the cancel's own checks decide).
    function _cancelTooSoon(CascadeFrontDoor d, address user) internal view returns (bytes memory) {
        if (!_inCooldown(d, user) || _cooldownWaived(d)) return bytes("");
        return abi.encodeWithSelector(CancelTooSoon.selector, _lastDepositAt[address(d)][user] + CANCEL_COOLDOWN);
    }

    /// Whether a cancel by `user` at door `d` now is inside its five minutes and goes only because the door waives the
    /// cooldown (R12): what the handlers count (`_countWaived`) when it goes.
    function _waivedNow(CascadeFrontDoor d, address user) internal view returns (bool) {
        return _inCooldown(d, user) && _cooldownWaived(d);
    }

    /// A waived cancel at door `d` went: counted, and by its cause (the pause, else the disabled primary).
    function _countWaived(CascadeFrontDoor d) internal {
        ++cancelsWaived;
        if (d.paused()) ++cancelsWaivedPaused;
        else ++cancelsWaivedPrimary;
    }

    /// Whether a cancel's refusal `reason` is exactly the predicted `tooSoon` (non-empty); counted when it is.
    function _refusedTooSoon(bytes memory reason, bytes memory tooSoon) internal returns (bool) {
        if (tooSoon.length == 0 || keccak256(reason) != keccak256(tooSoon)) return false;
        ++cancelsTooSoon;
        return true;
    }

    /// A first request's `fee`, paid into door `d`'s open pot.
    function _recordPotIn(CascadeFrontDoor d, uint256 fee) internal {
        ghostPotIn[address(d)] += fee;
    }

    /// The owner's sweep of `amount` from door `d`'s carried pot to its treasury.
    function _recordSweep(CascadeFrontDoor d, uint256 amount) internal {
        ghostSwept[address(d)] += amount;
    }

    /// Reads a close's BatchClosed from door `d`: the pot's part of the fee into ghostPotUsed, and a remainder carried
    /// into the next pot counted. Every successful close and self-close emits exactly one; a close without it counts as
    /// unexpected.
    function _recordClose(CascadeFrontDoor d, Vm.Log[] memory logs) internal {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(d) && logs[i].topics[0] == CascadeFrontDoor.BatchClosed.selector) {
                (,,,, uint256 potUsed, uint256 carried) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint256));
                ghostPotUsed[address(d)] += potUsed;
                if (carried != 0) ++potsCarried;
                return;
            }
        }
        ++unexpectedReverts;
    }
}
