// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CascadeBase} from "../../src/CascadeBase.sol";
import {Actor, Delay, Item, Kind} from "../../src/CascadeTypes.sol";
import {NotGuardian} from "../../src/CascadeErrors.sol";
import {LimitSet} from "../../src/CascadeEvents.sol";

/// Test only: CascadeBase with an owner setter of each shape the scheduler serves (spec §3.6), its own
/// classification of them, and the base's internal state exposed. `setKnob` is an `onlyOwner` limit
/// setter whose loosening (a higher value) runs only under `execute`, while a tightening or an equal
/// value is immediate; `setBoom` always reverts; `probe` and `reenter` are `onlyScheduled` instruments
/// for the security tests: `probe` records what it sees inside `execute`'s self-call, and `reenter`
/// re-enters the harness with calldata armed beforehand. All four are (Param, Ordinary). The execute
/// hash (private to CascadeBase) is read from its transient slot, 0, which `probe` proves. For the gates
/// (Task 8): an instrument per actor that stamps its clock and records nothing (ruling B4: the base alone
/// gives the guardian no instrument while the owner holds the primary), a hold written without its
/// instrument, and `_checkBridgeCaps` refusing one armed bridge.
contract SchedulerHarness is CascadeBase {
    error Boom();
    error CapsRefused(address bridge);

    uint256 public knob;
    /// How many times `_onGuardianSet` ran (setGuardian's hook).
    uint256 public guardianHookCalls;
    /// What `probe` saw inside execute: whether it was a scheduled call, its own item's readyAt, and the
    /// execute hash in transient slot 0.
    bool public probeSawScheduledCall;
    uint64 public probeSawReadyAt;
    bytes32 public probeSawHash;
    bool public probeRan;
    /// The calldata `reenter` sends to the harness itself (set by `arm`).
    bytes internal reentry;
    /// The bridge `_checkBridgeCaps` refuses (set by `refuseCaps`); none while zero.
    address public capsRefused;

    /// Bittensor's deploy calibration, 7,200 ms (twice as fast as its 12-second blocks, Revision 28): MS_PER_BLOCK,
    /// the scheduler's block floor (R1-A L-3) and block window.
    constructor(address owner_, address guardian_, address bridge_) CascadeBase(owner_, guardian_, bridge_, 7_200) {}

    /// A limit whose loosening is a higher value: scheduled only; a tightening or an equal value is
    /// immediate. The event carries the setter's explicit selector, as the vault's LimitSet does.
    function setKnob(uint256 v) external onlyOwner {
        _requireScheduledIfLoosens(v > knob);
        knob = v;
        emit LimitSet(this.setKnob.selector, v, 0);
    }

    function setBoom() external view onlyOwner {
        revert Boom();
    }

    /// Records, inside execute's self-call, whether it is a scheduled call and what its own item reads
    /// (its id is the hash of its calldata, msg.data in this frame).
    function probe() external onlyScheduled {
        probeRan = true;
        probeSawScheduledCall = _scheduledCall();
        probeSawReadyAt = scheduled[keccak256(msg.data)].readyAt;
        probeSawHash = executingHash();
    }

    /// Re-enters the harness with the armed calldata and bubbles its revert. No real scheduled setter
    /// calls out (spec §3.6); this one does, to show what a re-entry from inside execute can reach.
    function reenter() external onlyScheduled {
        (bool ok, bytes memory ret) = address(this).call(reentry);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    /// Unrestricted test hook: the calldata `reenter` sends.
    function arm(bytes calldata data) external {
        reentry = data;
    }

    function _classify(bytes calldata data) internal view override returns (Delay, Kind) {
        // casting to 'bytes4' keeps the selector, the first 4 bytes of data
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes4 s = bytes4(data);
        if (s == this.setKnob.selector) {
            _requireArgs(data, 1);
            return (Delay.Param, Kind.Ordinary);
        }
        if (s == this.setBoom.selector || s == this.probe.selector || s == this.reenter.selector) {
            _requireArgs(data, 0);
            return (Delay.Param, Kind.Ordinary);
        }
        return super._classify(data);
    }

    function _onGuardianSet() internal override {
        ++guardianHookCalls;
    }

    // ---- the gates' test hooks (Task 8) ----

    /// The guardian's instrument (ruling B4): stamps the guardian's clock at block.timestamp and records
    /// nothing, as the vault's pause will (Task 10). The guardian's alone (_actor()).
    function guardianInstrument() external {
        if (_actor() != Actor.Guardian) revert NotGuardian();
        _stamp(Actor.Guardian);
    }

    /// The owner's instrument: stamps the owner's clock and records nothing, as the vault's cancel stamp
    /// will (Task 10). The owner's alone.
    function ownerInstrument() external {
        if (_actor() != Actor.Owner) revert NotGuardian();
        _stamp(Actor.Owner);
    }

    /// Unrestricted test hook: `_stamp(a)` for any `a`, None included. No instrument passes None (`_actor()`
    /// never answers it, and the vault's cancel stamp names the owner), so this is the only way to show
    /// that None stamps nothing (the Task 8 review's carry).
    function stampAs(Actor a) external {
        _stamp(a);
    }

    /// Records `a` as the primary's disabler with no instrument and no stamp. Unreachable through the API:
    /// every instrument that records a hold also stamps its actor's clock, so the clock kills an item
    /// before the gate at execute can. This isolates that gate (spec §3.6's "at execution", defence in
    /// depth).
    function forceHold(Actor a) external {
        primaryDisabledBy = a;
    }

    /// Unrestricted test hook: `_checkBridgeCaps` refuses `bridge` from now on.
    function refuseCaps(address bridge) external {
        capsRefused = bridge;
    }

    function _checkBridgeCaps(address bridge) internal view override {
        if (bridge != address(0) && bridge == capsRefused) revert CapsRefused(bridge);
    }

    // ---- CascadeBase's internal state ----

    function item(bytes32 id) external view returns (Item memory) {
        return scheduled[id];
    }

    function exposed_guardian() external view returns (address) {
        return guardian;
    }

    function exposed_bridgeEnabled(address b) external view returns (bool) {
        return bridgeEnabled[b];
    }

    function exposed_bridgeKnown(address b) external view returns (bool) {
        return bridgeKnown[b];
    }

    function exposed_primaryBridge() external view returns (address) {
        return primaryBridge;
    }

    function exposed_lastOwnerClose() external view returns (uint64) {
        return lastOwnerClose;
    }

    function exposed_lastGuardianClose() external view returns (uint64) {
        return lastGuardianClose;
    }

    function exposed_primaryDisabledBy() external view returns (Actor) {
        return primaryDisabledBy;
    }

    function exposed_ownerHold() external view returns (bool) {
        return ownerHold();
    }

    function exposed_guardianHold() external view returns (bool) {
        return guardianHold();
    }

    function exposed_exitsOpen() external view returns (bool) {
        return exitsOpen();
    }

    function exposed_STAMP_TYPEHASH() external pure returns (bytes32) {
        return STAMP_TYPEHASH;
    }

    function exposed_STAMP_MAX_TTL() external pure returns (uint64) {
        return STAMP_MAX_TTL;
    }

    function exposed_DOMAIN_SEPARATOR() external view returns (bytes32) {
        return DOMAIN_SEPARATOR;
    }

    function exposed_PARAM_DELAY() external pure returns (uint64) {
        return PARAM_DELAY;
    }

    function exposed_REGISTRY_DELAY() external pure returns (uint64) {
        return REGISTRY_DELAY;
    }

    function exposed_GUARDIAN_DELAY() external pure returns (uint64) {
        return GUARDIAN_DELAY;
    }

    function exposed_EXECUTE_WINDOW() external pure returns (uint64) {
        return EXECUTE_WINDOW;
    }

    function exposed_MS_PER_BLOCK() external view returns (uint64) {
        return MS_PER_BLOCK;
    }

    /// CascadeBase's transient `_executingHash` (private), read from its transient slot: CascadeBase
    /// declares no other transient variable and the harness none, so it is slot 0 (`probe` checks it
    /// equals the running item's id inside execute). Transient storage lasts the whole transaction, and a
    /// Foundry test is one, so a hash left set by `execute` reads non-zero here.
    function executingHash() public view returns (bytes32 h) {
        assembly ("memory-safe") {
            h := tload(0)
        }
    }
}
