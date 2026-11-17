// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CascadeBase} from "../../../src/CascadeBase.sol";
import {CascadeVault} from "../../../src/CascadeVault.sol";
import {CascadeMessages} from "../../../src/libraries/CascadeMessages.sol";
import {Actor, DoorState, Item, Kind, PayoutBatch} from "../../../src/CascadeTypes.sol";
import {BatchDelivered, DepositBounced, Redeemed, Scheduled} from "../../../src/CascadeEvents.sol";
import {MockBridge} from "../../mocks/MockBridge.sol";
import {GovernanceHandler} from "./GovernanceHandler.sol";

// The probe families (`LivenessHandler.probes`, bits): each runs in its own campaign contract, the pins with all on.
uint256 constant PROBE_ACTIVATION = 1;
uint256 constant PROBE_OWNER_PATH = 2;
uint256 constant PROBE_SWAP = 4;
uint256 constant PROBE_LIVENESS = 8;
uint256 constant PROBE_ALL = 15;

/// @notice The governance campaign's liveness half (Task 39b; spec §3.6, I-26 to I-28 and the T7 B3 invariant), on
/// GovernanceHandler's actors, setter table, ghost log and model, unchanged: after every action (`_afterAct`) the state
/// it left is probed, each probe in a snapshot that is reverted, so the campaign walks on as if nothing had been tried.
/// Only the probe families `probes` names run (Task 39b's timing ruling: Foundry runs each invariant as its own
/// campaign, so each family has its own contract, its own invariant, `invariant_noUnexpectedReverts` and reach log, and
/// the boundary invariants run probe-free; the pins switch every probe on, `setProbes`).
///
/// - **I-26, the owner's way back** (`_checkOwnerReachesOpen`): from the state, the honest owner alone (no guardian
///   action, no redeploy) unpauses, clears each owner hold (a primary's by a switch to another enabled bridge within its
///   cap or by the primary's Reopen; the launch door's by a Removed launch-chain door's Reopen), then each guardian hold
///   (by the setGuardian swap to the sitting guardian, or by the same Reopen or switch), waiting each item's delay in
///   time and in blocks; both targets must then read OPEN. Every call goes through the handler's judged bodies, so a
///   refusal on the path, predicted or not, is a finding. The path each state needed is counted (`pathCount`,
///   `pathByMask`).
/// - **I-27, the guardian never delays its replacement** (`_checkSwapNeverDelayed`): for every pending setGuardian the
///   owner's clock has not killed, with no owner hold, the guardian plays every instrument it has, on both targets, one
///   second before the item's readyAt (a pause of each, each primary's disable, every door's removal, its cancel of
///   every Ordinary item it may cancel, and of the swap itself: NotCanceller), and the owner's execute at exactly the
///   readyAt (from the schedule) must run and clear the guardian's holds; and, with no swap pending, the owner's
///   schedule of one under that storm must be admitted and run eight days later after a second storm.
/// - **I-28, the two-chain liveness under the mock rails** (`_checkTwoChainLiveness`; the spec's sentence since Task
///   39b's ruling): while both targets read OPEN, a launch batch (alice's redeem, and a deposit while the front door
///   takes them) closed as soon as it can close is tried for delivery (the vault takes it: the rail files nothing, the
///   key is processed), and a payout batch sent as soon as it is due for credit at the front door (the rail files
///   nothing, the entry is claimable). Each half is judged on its own rail (Task 39b's review, Important 2): the
///   delivery by the front door's primary (`_deliveryClass`), the payout by the vault's (`_payoutClass`); each outcome
///   is counted by its half's class, and a coherent half's must succeed. OPEN alone implies no launch door, no enabled
///   primary and no rail the other side takes (spec §3.6, after a swap; the one-sided rail switch, the residual below
///   section 5's table). ProbeBridge delivers nothing by construction (a re-entry probe, not a rail): only the half
///   whose primary it is goes untried.
/// - **No pending activation names an active target** (`_checkNoPendingActivation`, T7 B3): read from the contracts
///   alone (both lenses' items over every id the schedulers ever logged, each decoded from its own Scheduled log), so a
///   schedule the handler did not predict is checked too.
/// Each violation counts in its own counter (the invariants read them) and in `unexpectedReverts` when a judged call
/// went other than predicted.
contract LivenessHandler is GovernanceHandler {
    // ---- I-26: the path's parts (pathCount's indexes and pathByMask's bits) ----

    uint256 internal constant P_UNPAUSE = 0;
    uint256 internal constant P_SWITCH = 1;
    uint256 internal constant P_BRIDGE_REOPEN = 2;
    uint256 internal constant P_DOOR_REOPEN = 3;
    uint256 internal constant P_SWAP = 4;
    /// A swap an owner hold kept back until the Reopen that cleared it ran (the two phases).
    uint256 internal constant P_SWAP_AFTER = 5;
    uint256 internal constant NP = 6;

    /// I-26: states probed; already OPEN; a call on the path refused or judged unexpected (a finding); the path ran
    /// and OPEN was not reached (a finding).
    uint256 public ownerPathProbes;
    uint256 public ownerPathsAlreadyOpen;
    uint256 public ownerPathRefused;
    uint256 public ownerPathNotOpen;
    /// The parts each path took, and how many paths took each combination (a bitmask of the parts).
    uint256[6] public pathCount;
    uint256[64] public pathByMask;
    /// The rail class (I-28's, see L_LAUNCH_DOOR_OUT; the state's, `_railClass`) of each state a path reached: a
    /// census, not I-26's requirement.
    uint256[5] public pathEndsByClass;
    /// The holds the probed states held, by kind: the vault's pause by the owner (0) or the guardian (1), the vault's
    /// primary (2, 3), the launch door's (4, 5), the front door's primary (6, 7).
    uint256[8] public heldStates;

    // ---- I-27 ----

    /// Pending swaps probed through a storm; of them, storms one second before the readyAt; skipped under an owner
    /// hold (the owner's own doing); swaps that did not run at their readyAt after the storm (a finding).
    uint256 public swapProbes;
    uint256 public swapProbesJustBeforeReady;
    uint256 public swapProbesUnderOwnerHold;
    uint256 public swapsDelayedByGuardian;
    /// The schedule half: the owner's setGuardian scheduled under a storm and run eight days later; one refused or not
    /// run (a finding).
    uint256 public swapSchedulesUnderStorm;
    uint256 public swapSchedulesRefused;
    /// The committed action (guardianBeforeSwap): a guardian instrument a moment before a pending swap's readyAt, and the
    /// swaps that then ran.
    uint256 public guardianInstrumentsBeforeSwap;
    uint256 public swapsAfterGuardianInstrument;

    // ---- I-28 ----

    /// I-28's rail classes of each half of a state both targets read OPEN (`_deliveryClass`, `_payoutClass`), the first
    /// that holds: 0 the launch door out of the vault (another launch-chain door active, or none after a swap ended a
    /// guardian's door hold: spec §3.6); 1 the half's primary disabled on its own side (OPEN once a swap ended a
    /// guardian's bridge hold, until the primary's Reopen: spec §3.6); 2 the half's rail not taken by the other side
    /// (the front door's primary not enabled on the vault; the vault's primary never known to the front door: the
    /// one-sided rail switch, the residual below spec section 5's table); 3 coherent, the only class asserted; 4 the
    /// half's primary is the probe (not a rail), so that half alone goes untried.
    uint256 internal constant L_LAUNCH_DOOR_OUT = 0;
    uint256 internal constant L_PRIMARY_DISABLED = 1;
    uint256 internal constant L_RAIL_NOT_TAKEN = 2;
    uint256 internal constant L_COHERENT = 3;
    uint256 internal constant L_PROBE_RAIL = 4;

    /// States both targets read OPEN; of them, by each half's class.
    uint256 public openStates;
    uint256[5] public openByDeliveryClass;
    uint256[5] public openByPayoutClass;
    /// The delivery half, by its class: launch batches delivered; not delivered (the close refused, or a delivery the
    /// rail filed or the vault did not process), with the last refusal seen (its selector; zero when the rail filed the
    /// delivery). Apart: batches with nothing to carry (alice held no shares and the door took no deposit).
    uint256[5] public deliveredBy;
    uint256[5] public undeliveredBy;
    bytes4[5] public undeliveredWhy;
    uint256 public emptyBatches;
    /// The payout half, by its class: payout chunks credited; refused or not credited, with the last refusal seen.
    /// Apart: probes with no payout batch to send.
    uint256[5] public creditedBy;
    uint256[5] public uncreditedBy;
    bytes4[5] public uncreditedWhy;
    uint256 public noPayoutBatch;
    /// Of the coherent halves tried: a delivery while the vault's primary is the probe, and a payout while the front
    /// door's is (the states a whole-state class left out before the review); a payout through a vault primary the
    /// front door knows but has disabled (the correction's half: a payout needs its bridge known there, not enabled
    /// now).
    uint256 public deliveriesBesideTheProbe;
    uint256 public payoutsBesideTheProbe;
    uint256 public payoutsThroughAKnownDisabledBridge;

    // ---- T7 B3 ----

    /// A pending activation of an active door or an enabled bridge, read from the contracts (a finding); and the
    /// pending activations checked.
    uint256 public pendingActivationsOfActive;
    uint256 public pendingActivationChecks;

    /// The front door's items' calldata, from its own Scheduled logs (TrackedHandler keeps the vault's).
    mapping(bytes32 => bytes) internal _doorData;

    /// The probe families `_afterAct` runs (the PROBE_ bits): the campaign contract's, from the constructor.
    uint256 public probes;

    constructor(System memory s, uint256 probes_) GovernanceHandler(s) {
        probes = probes_;
    }

    /// For the pins: the probe families on from here (PROBE_ALL: the pins run on a handler with every probe on). Not a
    /// fuzzed action.
    function setProbes(uint256 probes_) external {
        probes = probes_;
    }

    // =====================================================================================================
    // after every action
    // =====================================================================================================

    function _afterAct() internal override {
        uint256 p = probes;
        if (p == 0) return;
        // the action's own logs first, folded as the step would (I-34): what the probes log is dropped after each
        _readLogs();
        if (p & PROBE_ACTIVATION != 0) _checkNoPendingActivation();
        if (p & PROBE_OWNER_PATH != 0) _checkOwnerReachesOpen();
        if (p & PROBE_SWAP != 0) _checkSwapNeverDelayed();
        if (p & PROBE_LIVENESS != 0) _checkTwoChainLiveness();
    }

    /// The front door's Scheduled logs' calldata, beside TrackedHandler's fold.
    function _onLogs(Vm.Log[] memory logs) internal override {
        super._onLogs(logs);
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(fd) || l.topics.length == 0 || l.topics[0] != Scheduled.selector) continue;
            (,, bytes memory data) = abi.decode(l.data, (uint8, uint64, bytes));
            _doorData[l.topics[1]] = data;
        }
    }

    // =====================================================================================================
    // T7 B3: no pending activation of an active target
    // =====================================================================================================

    /// Over every id either scheduler ever logged (TrackedHandler's Scheduled words): each pending activateFrontDoor on
    /// the vault must name a door that is not Active, and each pending activateBridge on either target a bridge that is
    /// not enabled, all read from the lenses; the target decoded from the item's own Scheduled log.
    function _checkNoPendingActivation() internal {
        bytes32[] storage ids = _kindWords[WordKind.Scheduled];
        for (uint256 i; i < ids.length; ++i) {
            bytes32 id = ids[i];
            for (uint8 t; t < 2; ++t) {
                Item memory it = _lens(t).scheduled(id);
                if (it.readyAt == 0) continue;
                bool door = t == V && it.selector == CascadeVault.activateFrontDoor.selector;
                if (!door && it.selector != CascadeBase.activateBridge.selector) continue;
                bytes memory data = t == V ? _scheduledData[id] : _doorData[id];
                ++pendingActivationChecks;
                // an item no Scheduled log of this campaign explains (none is expected): counted as a finding
                if (keccak256(data) != id) {
                    ++pendingActivationsOfActive;
                    continue;
                }
                bool active;
                if (door) {
                    (uint64 chain, address addr) = abi.decode(_args(data), (uint64, address));
                    active = vaultLens.doorState(vaultLens.peerId(chain, addr)) == DoorState.Active;
                } else {
                    active = _lens(t).bridgeEnabled(abi.decode(_args(data), (address)));
                }
                if (active) ++pendingActivationsOfActive;
            }
        }
    }

    // =====================================================================================================
    // I-26: the owner reaches OPEN
    // =====================================================================================================

    /// The owner's way back from this state, in a snapshot (see the contract's notes). A state both lenses read OPEN
    /// needs none (read from the contracts, as I-28 reads it: this file runs none of Task 39a's model-against-lens
    /// checks, so a model that read OPEN where the contracts do not shows here as a path that does not reach OPEN).
    function _checkOwnerReachesOpen() internal {
        ++ownerPathProbes;
        if (vaultLens.exitsOpen() && doorLens.exitsOpen()) {
            ++ownerPathsAlreadyOpen;
            return;
        }
        _countHolds();
        (bool ran, bool open, uint256 mask, uint256 du, uint256 endClass) =
            _tryOwnerPath(uint256(keccak256(abi.encode(steps, "owner path"))));
        unexpectedReverts += du;
        if (!ran || du != 0) {
            ++ownerPathRefused;
        } else if (!open) {
            ++ownerPathNotOpen;
        } else {
            ++pathEndsByClass[endClass];
            ++pathByMask[mask];
            for (uint256 k; k < NP; ++k) {
                if (mask & (1 << k) != 0) ++pathCount[k];
            }
        }
    }

    /// The owner's path (`_ownerPath`, the choices drawn by `r`) in a snapshot, reverted: whether it ran, whether both
    /// lenses then read OPEN, the parts it took, how many of its judged calls went other than predicted, and the rail
    /// class of the state it reached (I-28's, a census: OPEN is I-26's requirement, coherent rails are not).
    function _tryOwnerPath(uint256 r)
        internal
        returns (bool ran, bool open, uint256 mask, uint256 du, uint256 endClass)
    {
        uint256 u0 = unexpectedReverts;
        uint256 t0 = vm.getBlockTimestamp();
        uint256 b0 = vm.getBlockNumber();
        uint256 snap = vm.snapshotState();
        _pinned = true;
        (ran, mask) = _ownerPath(r);
        open = vaultLens.exitsOpen() && doorLens.exitsOpen();
        endClass = _railClass();
        du = unexpectedReverts - u0;
        vm.revertToStateAndDelete(snap);
        vm.warp(t0);
        vm.roll(b0);
        _dropLogs();
    }

    /// For the pins: the owner's path from this state with the choices `r` names (bit 0 of each target's byte: the swap
    /// for a guardian's bridge hold, when `r >> (8 * t)` is 0 mod 3; bit 2 the switch; bit 20 a Removed door's Reopen for
    /// the guardian's launch hold; bit 24 which Removed door), probed and reverted; not a fuzzed action.
    function probeOwnerPath(uint256 r) external returns (bool ran, bool open, uint256 mask) {
        uint256 du;
        (ran, open, mask, du,) = _tryOwnerPath(r);
        unexpectedReverts += du;
    }

    function _countHolds() internal {
        uint256 o = uint256(Actor.Owner);
        uint256 g = uint256(Actor.Guardian);
        uint256[4] memory by = [_m[V_PAUSED_BY], _m[_f(V, F_DISABLED_BY)], _m[V_LAUNCH_BY], _m[_f(D, F_DISABLED_BY)]];
        for (uint256 k; k < 4; ++k) {
            if (by[k] == o) ++heldStates[2 * k];
            else if (by[k] == g) ++heldStates[2 * k + 1];
        }
    }

    /// The owner's calls from this state to OPEN on both targets (I-26), each judged; `r` chooses among the ways back
    /// where there are several. Whether every call ran as it must, and the parts the path took.
    function _ownerPath(uint256 r) internal returns (bool ran, uint256 mask) {
        // 1. the vault's pause, whoever paused: the owner's unpause, at once
        if (_m[_f(V, F_PAUSED)] != 0) {
            _unpause(V, owner);
            mask |= 1 << P_UNPAUSE;
            if (_m[_f(V, F_PAUSED)] != 0) return (false, mask);
        }
        // 2. the items to schedule now (the Reopens, which have no gate), and which targets want a swap
        bytes[3] memory reopens;
        uint8[3] memory reopenOn;
        uint256 n;
        bool[2] memory wantSwap;
        for (uint8 t; t < 2; ++t) {
            uint256 by = _m[_f(t, F_DISABLED_BY)];
            if (by == 0) continue;
            // a guardian's bridge hold: one draw in three left to the swap (which clears it, R1-B M-1)
            if (by == uint256(Actor.Guardian) && (r >> (8 * t)) % 3 == 0) {
                wantSwap[t] = true;
                continue;
            }
            // one draw in two a switch to another enabled bridge within the cap, when there is one; else the Reopen
            uint256 j = _switchTarget(t);
            if (j < 3 && (r >> (8 * t + 2)) % 2 == 0) {
                _setPrimary(t, j, owner);
                mask |= 1 << P_SWITCH;
                if (_m[_f(t, F_DISABLED_BY)] != 0) return (false, mask);
            } else {
                address p = address(uint160(_m[_f(t, F_PRIMARY)]));
                reopens[n] = abi.encodeCall(CascadeBase.activateBridge, (p));
                reopenOn[n++] = t;
                mask |= 1 << P_BRIDGE_REOPEN;
            }
        }
        uint256 launchBy = _m[V_LAUNCH_BY];
        if (launchBy != 0) {
            uint256 removed = _removedLaunchDoor(r);
            if (launchBy == uint256(Actor.Owner)) {
                // the owner's launch hold: only a Removed launch-chain door's Reopen clears it (spec §3.6)
                if (removed == 3) return (false, mask);
                reopens[n] = _activation(removed);
                reopenOn[n++] = V;
                mask |= 1 << P_DOOR_REOPEN;
            } else if (removed < 3 && (r >> 20) % 2 == 0) {
                // the guardian's, one draw in two by a Removed launch-chain door's Reopen when there is one
                reopens[n] = _activation(removed);
                reopenOn[n++] = V;
                mask |= 1 << P_DOOR_REOPEN;
            } else {
                wantSwap[V] = true;
            }
        }
        _waitOutClocks(V);
        _waitOutClocks(D);
        for (uint256 k; k < n; ++k) {
            if (!_schedule(reopenOn[k], reopens[k], owner)) return (false, mask);
        }
        // 3. the swaps no owner hold keeps back: scheduled with the Reopens
        bytes[2] memory swaps;
        bool[2] memory swapScheduled;
        for (uint8 t; t < 2; ++t) {
            if (!wantSwap[t]) continue;
            swaps[t] = abi.encodeCall(CascadeBase.setGuardian, (_guardianOf(t)));
            if (_ownerHold(t)) continue;
            if (!_schedule(t, swaps[t], owner)) return (false, mask);
            swapScheduled[t] = true;
            mask |= 1 << P_SWAP;
        }
        // 4. the Reopens, each at its readyAt
        for (uint256 k; k < n; ++k) {
            _waitFor(reopenOn[k], reopens[k], 1);
            if (!_execute(reopenOn[k], reopens[k], owner)) return (false, mask);
        }
        // 5. the swaps an owner hold kept back, now that the Reopens cleared it; then every swap at its readyAt
        for (uint8 t; t < 2; ++t) {
            if (!wantSwap[t] || swapScheduled[t]) continue;
            if (_ownerHold(t)) return (false, mask);
            _waitOutClocks(t);
            if (!_schedule(t, swaps[t], owner)) return (false, mask);
            mask |= 1 << P_SWAP_AFTER;
        }
        for (uint8 t; t < 2; ++t) {
            if (!wantSwap[t]) continue;
            _waitFor(t, swaps[t], 1);
            if (!_execute(t, swaps[t], owner)) return (false, mask);
        }
        ran = true;
    }

    /// Another enabled bridge on `t` within its cap (setPrimaryBridge's checks), the first from a draw; 3 when none.
    function _switchTarget(uint8 t) internal view returns (uint256) {
        uint256 p = _bridgeIndex(address(uint160(_m[_f(t, F_PRIMARY)])));
        uint256 limit = _m[t == V ? V_MSG : D_MAX_BATCH];
        for (uint256 j; j < 3; ++j) {
            if (j != p && _m[_f(t, F_ENABLED + j)] != 0 && limit <= _capOf(j)) return j;
        }
        return 3;
    }

    /// A Removed launch-chain door (the launch door or the second one, the first from `r`); 3 when none.
    function _removedLaunchDoor(uint256 r) internal view returns (uint256) {
        uint256 first = (r >> 24) % 2;
        for (uint256 k; k < 2; ++k) {
            uint256 i = (first + k) % 2;
            if (DoorState(_m[V_DOOR + i]) == DoorState.Removed) return i;
        }
        return 3;
    }

    // =====================================================================================================
    // I-27: a guardian's instruments never delay setGuardian
    // =====================================================================================================

    /// Every pending swap the owner's clock has not killed, probed through a storm; with none on a target, the schedule
    /// half there (one target a step, by the step's parity).
    function _checkSwapNeverDelayed() internal {
        for (uint8 t; t < 2; ++t) {
            bool pending;
            for (uint256 i; i < _ids.length; ++i) {
                uint256 ix = _live[t][_ids[i]];
                if (ix == 0) continue;
                Ghost memory g = _ghosts[ix - 1];
                if (g.kind != Kind.GuardianSwap) continue;
                if (_m[_f(t, F_OWNER_CLOCK)] >= g.scheduledAt) continue;
                if (_lapsed(t, g.readyAt, g.readyBlock)) continue;
                pending = true;
                // the owner's hold, or the setter's own refusal (a target now the owner or the pending owner), is not
                // the guardian's doing
                if (_ownerHold(t)) {
                    ++swapProbesUnderOwnerHold;
                    continue;
                }
                if (_setterErr(t, g.data).length != 0) continue;
                (bool ok, bool justBefore) = _probeSwap(t, g);
                ++swapProbes;
                if (justBefore) ++swapProbesJustBeforeReady;
                if (!ok) ++swapsDelayedByGuardian;
            }
            if (!pending && steps % 2 == t && !_ownerHold(t)) {
                ++swapSchedulesUnderStorm;
                if (!_probeSwapSchedule(t)) ++swapSchedulesRefused;
            }
        }
    }

    /// In a snapshot: one second before `g`'s readyAt (or now, when that has passed) the guardian's storm and its
    /// cancel of the swap itself (NotCanceller), then the owner's execute at the readyAt; whether it ran there and
    /// ended the guardian's holds on `t`.
    function _probeSwap(uint8 t, Ghost memory g) internal returns (bool ok, bool justBefore) {
        uint256 u0 = unexpectedReverts;
        uint256 t0 = vm.getBlockTimestamp();
        uint256 b0 = vm.getBlockNumber();
        uint256 snap = vm.snapshotState();
        _pinned = true;
        if (t0 + 1 < g.readyAt) _warp(g.readyAt - 1 - t0, doorBlockTime);
        justBefore = vm.getBlockTimestamp() + 1 == g.readyAt;
        _storm();
        _cancel(t, g.data, _guardianOf(t));
        _waitFor(t, g.data, 1);
        bool ran = _execute(t, g.data, owner);
        ok = ran && vm.getBlockTimestamp() == Math.max(t0, g.readyAt) && _guardianEnded(t, g.data);
        ok = ok && unexpectedReverts == u0;
        uint256 du = unexpectedReverts - u0;
        vm.revertToStateAndDelete(snap);
        vm.warp(t0);
        vm.roll(b0);
        _dropLogs();
        unexpectedReverts += du;
    }

    /// In a snapshot: the guardian's storm now, the owner's setGuardian (the sitting guardian) scheduled at once (a
    /// second later only when the owner's own clock reads now: an owner instrument this step), a second storm one
    /// second before its readyAt with the guardian's cancel of the swap (NotCanceller), and the execute at the readyAt;
    /// whether every call ran.
    function _probeSwapSchedule(uint8 t) internal returns (bool ok) {
        uint256 u0 = unexpectedReverts;
        uint256 t0 = vm.getBlockTimestamp();
        uint256 b0 = vm.getBlockNumber();
        uint256 snap = vm.snapshotState();
        _pinned = true;
        _storm();
        // never waits for the guardian's clock (the storm's): a swap reads the owner's alone
        if (_m[_f(t, F_OWNER_CLOCK)] >= vm.getBlockTimestamp()) _warp(1, doorBlockTime);
        bytes memory data = abi.encodeCall(CascadeBase.setGuardian, (_guardianOf(t)));
        bool scheduled = _schedule(t, data, owner);
        bool ran;
        if (scheduled) {
            uint256 readyAt = _ghosts[_live[t][keccak256(data)] - 1].readyAt;
            _warp(readyAt - 1 - vm.getBlockTimestamp(), doorBlockTime);
            _storm();
            _cancel(t, data, _guardianOf(t));
            _waitFor(t, data, 1);
            ran = _execute(t, data, owner) && vm.getBlockTimestamp() == readyAt && _guardianEnded(t, data);
        }
        ok = scheduled && ran && unexpectedReverts == u0;
        uint256 du = unexpectedReverts - u0;
        vm.revertToStateAndDelete(snap);
        vm.warp(t0);
        vm.roll(b0);
        _dropLogs();
        unexpectedReverts += du;
    }

    /// After a swap `data` ran on `t`, read from the lenses: `t` names the new guardian and holds no guardian's hold that
    /// setGuardian clears (the primary's; on the vault, the launch door's).
    function _guardianEnded(uint8 t, bytes memory data) internal view returns (bool) {
        if (_lens(t).guardian() != abi.decode(_args(data), (address))) return false;
        if (_lens(t).primaryDisabledBy() == Actor.Guardian) return false;
        return t == D || vaultLens.launchDoorRemovedBy() != Actor.Guardian;
    }

    /// The guardian plays every instrument it has, on both targets, this second, each judged (the follow-ups are off:
    /// the caller pins): each target's pause (the vault's records and stamps; EnforcedPause when paused), each primary's
    /// disable (BridgeNotEnabled when disabled), every active door's removal and every owner-removed door's (PeerNotActive
    /// otherwise), and its cancel of up to four pending Ordinary items on each target.
    function _storm() internal {
        _pause(V, _guardianOf(V));
        _pause(D, _guardianOf(D));
        for (uint8 t; t < 2; ++t) {
            _disable(t, _bridgeIndex(address(uint160(_m[_f(t, F_PRIMARY)]))), _guardianOf(t));
        }
        for (uint256 i; i < 3; ++i) {
            DoorState s = DoorState(_m[V_DOOR + i]);
            if (s == DoorState.Active || s == DoorState.Removed) _removeDoor(i, guardianOfVault());
        }
        for (uint8 t; t < 2; ++t) {
            uint256 cancelled;
            for (uint256 i; i < _ids.length && cancelled < 4; ++i) {
                uint256 ix = _live[t][_ids[i]];
                if (ix == 0 || _ghosts[ix - 1].kind != Kind.Ordinary) continue;
                _cancel(t, _ghosts[ix - 1].data, _guardianOf(t));
                ++cancelled;
            }
        }
    }

    /// @dev A guardian instrument a moment before a pending setGuardian is ready, then the owner's execute at its readyAt
    /// (I-27, committed: the campaign walks on with the swap done). With no swap pending on the target drawn, the owner
    /// schedules one (to either candidate) when no owner hold keeps it back. The moment: one second, a minute, an hour or
    /// half a day before the readyAt. The instrument: either target's pause, a primary's disable, a door's removal, or a
    /// cancel (an Ordinary item's, or the swap's itself: NotCanceller). A swap the owner's clock had not killed, under no
    /// owner hold, that does not run then counts in swapsDelayedByGuardian.
    function guardianBeforeSwap(uint256 seed) external step act pinned {
        uint8 t = uint8(_r(seed, "swap target") % 2);
        uint256 ix = _pendingSwap(t);
        if (ix == 0) {
            if (_ownerHold(t)) return;
            _waitOutClocks(t);
            _schedule(t, abi.encodeCall(CascadeBase.setGuardian, (guardians[_r(seed, "swap to") % 2])), owner);
            return;
        }
        Ghost memory g = _ghosts[ix - 1];
        uint32[4] memory before = [uint32(1), 1 minutes, 1 hours, 12 hours];
        uint256 when = uint256(g.readyAt) - before[_r(seed, "before") % 4];
        if (when > vm.getBlockTimestamp()) _warp(when - vm.getBlockTimestamp(), doorBlockTime);
        bool alive = _m[_f(t, F_OWNER_CLOCK)] < g.scheduledAt && !_ownerHold(t) && !_lapsed(t, g.readyAt, g.readyBlock)
            && _setterErr(t, g.data).length == 0;
        _guardianInstrument(t, g.data, seed);
        ++guardianInstrumentsBeforeSwap;
        _waitFor(t, g.data, 1);
        if (_execute(t, g.data, owner)) ++swapsAfterGuardianInstrument;
        else if (alive) ++swapsDelayedByGuardian;
    }

    /// One guardian instrument drawn by `seed` (see guardianBeforeSwap), judged.
    function _guardianInstrument(uint8 t, bytes memory swap, uint256 seed) internal {
        uint256 k = _r(seed, "guardian instrument") % 5;
        if (k == 0) {
            _pause(V, _guardianOf(V));
        } else if (k == 1) {
            _pause(D, _guardianOf(D));
        } else if (k == 2) {
            uint8 on = uint8(_r(seed, "disable on") % 2);
            _disable(on, _bridgeIndex(address(uint160(_m[_f(on, F_PRIMARY)]))), _guardianOf(on));
        } else if (k == 3) {
            uint256 i = _r(seed, "remove") % 3;
            for (uint256 m; m < 3; ++m) {
                uint256 d = (i + m) % 3;
                if (DoorState(_m[V_DOOR + d]) != DoorState.Unknown) {
                    i = d;
                    break;
                }
            }
            _removeDoor(i, guardianOfVault());
        } else {
            // an Ordinary item's cancel when there is one, else the swap's own (NotCanceller)
            for (uint256 i; i < _ids.length; ++i) {
                uint256 ix = _live[t][_ids[i]];
                if (ix != 0 && _ghosts[ix - 1].kind == Kind.Ordinary) {
                    _cancel(t, _ghosts[ix - 1].data, _guardianOf(t));
                    return;
                }
            }
            _cancel(t, swap, _guardianOf(t));
        }
    }

    /// The pending setGuardian on `t` the owner's clock has not killed, inside its window (its ghost index + 1); 0 when
    /// none.
    function _pendingSwap(uint8 t) internal view returns (uint256) {
        for (uint256 i; i < _ids.length; ++i) {
            uint256 ix = _live[t][_ids[i]];
            if (ix == 0) continue;
            Ghost storage g = _ghosts[ix - 1];
            if (g.kind == Kind.GuardianSwap && _alive(g)) return ix;
        }
        return 0;
    }

    // =====================================================================================================
    // I-28: the two-chain liveness under the mock rails
    // =====================================================================================================

    /// While both targets read OPEN (their lenses): a launch batch closed as soon as it can close is delivered, and a
    /// payout batch sent as soon as it is due is credited, in a snapshot (see the contract's notes); each half's
    /// outcome counted by its own class, read before the snapshot.
    function _checkTwoChainLiveness() internal {
        if (!vaultLens.exitsOpen() || !doorLens.exitsOpen()) return;
        ++openStates;
        address dp = doorLens.primaryBridge();
        address vp = vaultLens.primaryBridge();
        uint256 dc = _deliveryClass();
        uint256 pc = _payoutClass();
        ++openByDeliveryClass[dc];
        ++openByPayoutClass[pc];
        // the probe's own half goes untried; the other is tried and judged by its own class
        bool deliveryHalf = dc != L_PROBE_RAIL;
        bool payoutHalf = pc != L_PROBE_RAIL;
        bool knownDisabled = payoutHalf && !doorLens.bridgeEnabled(vp);
        uint256 u0 = unexpectedReverts;
        uint256 t0 = vm.getBlockTimestamp();
        uint256 b0 = vm.getBlockNumber();
        uint256 snap = vm.snapshotState();
        _pinned = true;
        Outcome memory o;
        if (deliveryHalf) _closeLaunchBatch(MockBridge(dp), o);
        if (payoutHalf) _sendPayout(MockBridge(vp), o);
        uint256 du = unexpectedReverts - u0;
        vm.revertToStateAndDelete(snap);
        vm.warp(t0);
        vm.roll(b0);
        _dropLogs();
        unexpectedReverts += du;
        if (deliveryHalf) {
            if (o.empty) {
                ++emptyBatches;
            } else {
                if (o.delivered) {
                    ++deliveredBy[dc];
                } else {
                    ++undeliveredBy[dc];
                    undeliveredWhy[dc] = o.closeRefusal;
                }
                if (dc == L_COHERENT && pc == L_PROBE_RAIL) ++deliveriesBesideTheProbe;
            }
        }
        if (payoutHalf) {
            if (!o.paid && !o.payoutRefused) {
                ++noPayoutBatch;
            } else {
                if (o.credited) {
                    ++creditedBy[pc];
                } else {
                    ++uncreditedBy[pc];
                    uncreditedWhy[pc] = o.payoutRefusal;
                }
                if (pc == L_COHERENT && dc == L_PROBE_RAIL) ++payoutsBesideTheProbe;
                if (pc == L_COHERENT && knownDisabled) ++payoutsThroughAKnownDisabledBridge;
            }
        }
    }

    /// The delivery half's class (see L_LAUNCH_DOOR_OUT), from both lenses: coherent when the front door's primary is a
    /// rail (not the probe), the launch door is Active on the vault (its delivery's peer, else UnknownPeer), and the
    /// primary is enabled on the front door (closeBatch sends only through an enabled primary) and now on the vault
    /// (the vault takes a delivery from an enabled bridge only, CascadeBase._requireBridge). The vault's own primary
    /// plays no part in a delivery. In this world one MockBridge serves both chains (the fixture connects each to both
    /// ends), so a primary's other half is the same address.
    function _deliveryClass() internal view returns (uint256) {
        address dp = doorLens.primaryBridge();
        if (dp == bridges[2]) return L_PROBE_RAIL;
        if (!_launchDoorActive()) return L_LAUNCH_DOOR_OUT;
        if (!doorLens.bridgeEnabled(dp)) return L_PRIMARY_DISABLED;
        if (!vaultLens.bridgeEnabled(dp)) return L_RAIL_NOT_TAKEN;
        return L_COHERENT;
    }

    /// The payout half's class: coherent when the vault's primary is a rail, the launch door is Active on the vault (a
    /// payout of its batch needs it, FrontDoorInactive), and the primary is enabled on the vault (processPayouts sends
    /// only through an enabled primary) and known to the front door (which takes a payout from any bridge it ever
    /// enabled, CascadeFrontDoor._requireBridge, H-2 i). The front door's own primary plays no part in a payout.
    function _payoutClass() internal view returns (uint256) {
        address vp = vaultLens.primaryBridge();
        if (vp == bridges[2]) return L_PROBE_RAIL;
        if (!_launchDoorActive()) return L_LAUNCH_DOOR_OUT;
        if (!vaultLens.bridgeEnabled(vp)) return L_PRIMARY_DISABLED;
        if (!doorLens.bridgeKnown(vp)) return L_RAIL_NOT_TAKEN;
        return L_COHERENT;
    }

    /// The state's class (I-26's census): the probe's when either half's primary is the probe, else the lower of the
    /// two halves' classes (coherent only when both are).
    function _railClass() internal view returns (uint256) {
        uint256 d = _deliveryClass();
        uint256 p = _payoutClass();
        if (d == L_PROBE_RAIL || p == L_PROBE_RAIL) return L_PROBE_RAIL;
        return Math.min(d, p);
    }

    /// Whether the launch door is Active on the vault, read from its lens.
    function _launchDoorActive() internal view returns (bool) {
        return vaultLens.doorState(vaultLens.peerId(BASE_CHAIN, address(fd))) == DoorState.Active;
    }

    /// What one I-28 probe saw.
    struct Outcome {
        bool empty;
        bool delivered;
        bytes4 closeRefusal;
        bytes32 key;
        CascadeMessages.Payout[] list;
        bool paid;
        bool payoutRefused;
        bytes4 payoutRefusal;
        bool credited;
    }

    /// alice asks to redeem 1% of her shares at the launch door and, on every other step (a redeem-only batch on the
    /// rest), while the door takes deposits and the batch has room, deposits a TAO (or the minimum); the batch closes
    /// as soon as it can (a wait to its interval when it is not full). The request and the deposit are judged (each
    /// must succeed); the close's refusal, or a delivery `rail` filed or the vault did not process, is the probe's
    /// finding. A batch with nothing in it carries nothing (`o.empty`). On a delivery: its key, and the payout list it
    /// queued (its DepositBounced and Redeemed entries, in log order).
    function _closeLaunchBatch(MockBridge rail, Outcome memory o) internal {
        address alice = w.alice;
        uint256 shares = vault.balanceOf(alice) / 100;
        if (shares != 0) {
            // the first request in a batch pays the fee; a second one in the same batch pays nothing
            uint256 fee = fd.redeemOf(alice) == 0 ? fd.redeemRequestFee() : 0;
            vm.deal(alice, alice.balance + fee);
            _readLogs();
            vm.prank(alice);
            try fd.requestRedeem{value: fee}(shares) {
                _readLogs();
            } catch (bytes memory reason) {
                _dropLogs();
                _judge(false, reason, "");
                return;
            }
        }
        if (steps % 2 == 0) _probeDeposit(alice);
        (uint64 id, uint64 start,,, uint256 nd, uint256 nr) = fd.openBatch();
        if (nd == 0 && nr == 0) {
            o.empty = true;
            return;
        }
        if (!fd.canClose()) {
            uint256 due = uint256(start) + fd.batchInterval();
            if (due > vm.getBlockTimestamp()) _warp(due - vm.getBlockTimestamp(), doorBlockTime);
        }
        uint256 failed = rail.failedCount();
        _readLogs();
        try fd.closeBatch{value: FEE}(id, 0) {}
        catch (bytes memory reason) {
            _dropLogs();
            o.closeRefusal = _selector(reason);
            return;
        }
        Vm.Log[] memory logs = _readLogs();
        uint256 entries;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(vault) || l.topics.length < 2) continue;
            if (l.topics[0] == BatchDelivered.selector) o.key = l.topics[1];
            if (l.topics[0] == Redeemed.selector || l.topics[0] == DepositBounced.selector) ++entries;
        }
        o.delivered = rail.failedCount() == failed && o.key != bytes32(0) && vaultLens.processed(o.key);
        if (!o.delivered) {
            o.key = bytes32(0);
            return;
        }
        o.list = new CascadeMessages.Payout[](entries);
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(vault) || l.topics.length < 3 || l.topics[1] != o.key) continue;
            if (l.topics[0] == Redeemed.selector) {
                (uint256 s, uint256 assets) = abi.decode(l.data, (uint256, uint256));
                o.list[n++] = CascadeMessages.Payout(_topicAddress(l.topics[2]), s, assets);
            } else if (l.topics[0] == DepositBounced.selector) {
                (uint256 assets,) = abi.decode(l.data, (uint256, uint8));
                o.list[n++] = CascadeMessages.Payout(_topicAddress(l.topics[2]), 0, assets);
            }
        }
    }

    /// alice's deposit into the probe's batch, while the front door takes it: a TAO, or the minimum if higher, rao
    /// aligned; skipped when the door is paused or the batch has no room (by count, by value or under the cap).
    function _probeDeposit(address alice) internal {
        if (_m[_f(D, F_PAUSED)] != 0 || fd.minDeposit() > fd.maxBatchValue()) return;
        uint256 amount = Math.max(1e18, fd.minDeposit());
        amount = (amount + 1e9 - 1) / 1e9 * 1e9;
        (,, uint256 total,, uint256 nd,) = fd.openBatch();
        if (total + amount > fd.maxBatchValue() || fd.netForwarded() + total + amount > fd.depositCap()) return;
        if (fd.depositOf(alice) == 0 && nd >= fd.maxDeposits()) return;
        w.tao.mint(alice, amount);
        _readLogs();
        vm.prank(alice);
        try fd.deposit(amount) {
            _readLogs();
        } catch (bytes memory reason) {
            _dropLogs();
            _judge(false, reason, "");
        }
    }

    /// The payout batch the probe's delivery queued (`o.key`, `o.list`), else one queued earlier, sent once due through
    /// the vault's primary `rail` (a top-up of the bridge fee with the call, so a tightened fee ceiling refuses
    /// nothing): whether one was sent (or refused, and why), and whether the front door credited it (`rail` filed
    /// nothing and the first entry's claimable rose: the first entry is always in the first chunk).
    function _sendPayout(MockBridge rail, Outcome memory o) internal {
        bytes32 key = o.key;
        CascadeMessages.Payout[] memory list = o.list;
        if (key == bytes32(0) || list.length == 0) {
            if (_queued.length == 0) return;
            Queued memory q = _queued[0];
            key = q.key;
            list = new CascadeMessages.Payout[](1);
            list[0] = CascadeMessages.Payout(q.user, q.shares, q.assets);
        }
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        if (b.remaining == 0) return;
        uint256 due = uint256(b.queuedAt) + _m[V_DELAY];
        if (due > vm.getBlockTimestamp()) _warp(due - vm.getBlockTimestamp(), doorBlockTime);
        uint256 before = fd.claimable(list[0].user);
        uint256 failed = rail.failedCount();
        _readLogs();
        try vault.processPayouts{value: FEE}(key, list, 0) {
            _readLogs();
        } catch (bytes memory reason) {
            _dropLogs();
            o.payoutRefused = true;
            o.payoutRefusal = _selector(reason);
            return;
        }
        o.paid = true;
        o.credited = rail.failedCount() == failed && fd.claimable(list[0].user) > before;
    }

    // =====================================================================================================
    // views for the pins and the log
    // =====================================================================================================

    function pathCounts() external view returns (uint256[6] memory) {
        return pathCount;
    }

    function pathMasks() external view returns (uint256[64] memory) {
        return pathByMask;
    }

    function heldStateCounts() external view returns (uint256[8] memory) {
        return heldStates;
    }
}
