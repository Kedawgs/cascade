// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CascadeBase} from "../../../src/CascadeBase.sol";
import {CascadeVault} from "../../../src/CascadeVault.sol";
import {DoorState, Kind} from "../../../src/CascadeTypes.sol";
import {ExitsNotOpen} from "../../../src/CascadeErrors.sol";
import {Stamps} from "../../governance/StampVector.sol";
import {GovernanceHandler} from "./GovernanceHandler.sol";

/// @notice The copied-key walk (Task 39b; spec §3.6's CO column, the signed stamp's "CO walk"), on GovernanceHandler's
/// world, ghost log, model and judged bodies. A thief holds a copy of the owner's seed, so it signs as the owner (and
/// as the guardian: one Ledger, decision D2) and runs a sweeper: the owner's and the guardian's accounts are drained
/// before every step, so the founder never sends a transaction. The founder acts only through its pre-signed stack
/// (`asOf` = the walk's start, then every `spacing`), which the stranger relays as each `asOf` passes: every advance of
/// time goes through `_advanceTo`, which stops at each `asOf` to relay that stamp on both targets. The thief schedules
/// freely (any setter-table item, a Reopen it opened by disabling or removing, a swap to its own guardian; now, a
/// second after a relay, or at an `asOf` a moment before its relay in the same second), waits for its items' readyAt
/// and tries them, and plays every instrument either key has. Every call is judged as in Task 39a's campaign.
///
/// The walk's claim (`invariant_coWalkNothingExecutes`): no item the thief schedules ever executes (`thiefExecutions`),
/// and each dies to the first stack stamp relayed at or after its schedule time: after each relay, the owner's clock
/// (read from the lens) must be at or past the schedule time of every thief item the stamp covers that was alive
/// (`clockBehind`), and each such item, executed in a snapshot once ready, must be refused ExitsNotOpen (`survivors`).
/// The first half is the defence; the second is its mechanism, and the half that sees a stamp's off-by-one at its own
/// `asOf`, since at a 12-hour spacing the next stamp kills such an item anyway. The clock is read as well as the
/// execute because an item can be refused ExitsNotOpen by its gate whatever the clock reads (an Ordinary item under a
/// hold, a swap under an owner hold).
contract CopiedKeyHandler is GovernanceHandler {
    /// The relayer's shortest outage: 2 seconds (a block of Base's before Revision 28, ten of its 0.2-second blocks
    /// now; kept, so the outages draw as before).
    uint256 internal constant BLINK = 2;
    /// The sweeper: the owner's and the guardian's accounts drained before every step.
    bool public sweeping;
    /// The founder's stack: its spacing and the next stamp's asOf, not yet relayed.
    uint64 public spacing;
    uint64 public nextAsOf;
    uint64 public lastAsOf;

    // ---- the walk's findings ----

    /// An item the thief scheduled that executed (the walk's own executes, judged or not).
    uint256 public thiefExecutions;
    /// A thief item a relayed stack stamp covered (scheduled at or before its asOf, alive before it) that a snapshot
    /// execute once ready did not refuse ExitsNotOpen.
    uint256 public survivors;
    /// A thief item a relayed stack stamp covered whose schedule time the owner's clock (its lens) did not reach.
    uint256 public clockBehind;
    /// A stack stamp refused at its asOf.
    uint256 public stackRelaysRefused;

    // ---- reach ----

    uint256 public sweeps;
    uint256 public stackRelays;
    uint256 public thiefSchedules;
    uint256[3] public thiefSchedulesByKind;
    uint256 public thiefSchedulesOnTheVault;
    uint256 public thiefSchedulesAtAnAsOf;
    uint256 public thiefSchedulesRightAfterARelay;
    uint256 public thiefSchedulesRefused;
    uint256 public thiefExecuteAttempts;
    uint256 public thiefExecuteAttemptsWhenReady;
    uint256 public thiefExecutesRefusedDead;
    uint256 public thiefOwnerInstruments;
    uint256 public thiefGuardianInstruments;
    /// Thief items a stack stamp killed, each probed in a snapshot once ready.
    uint256 public thiefItemsKilledByStack;
    uint256[3] public thiefItemsKilledByStackByKind;
    /// Task 39a's kill probes after a stack relay (`_probeKills`): left out (the newest dead item, when a stack relay
    /// covered it); a dead pick no relay covered, kept; the alive-side picks run.
    uint256 public killProbesSkipped;
    uint256 public deadKillProbesKept;
    uint256 public aliveKillProbes;

    /// The relayer's outages (Task 42, the Task 39b re-review's (c)): while `outageUntil` is ahead no stamp is relayed;
    /// back, the relayer relays the newest stamp due first (its clock covers every older one, and the older can be past
    /// their 1-day TTL), the older ones skipped. Drawn by `relayOutage`: a block, an hour, 12 hours, or just under 36
    /// hours, each within the newest due stamp's TTL. Items the thief schedules after the newest due asOf and before the
    /// relay are then alive after it, so the alive-side kill probe runs on them (`aliveKillProbes`). An outage drawn
    /// while the relayer is down leaves its return where it was (`outagesWhileDown`): outages never chain past the
    /// longest, so every stamp is relayed, or a newer one is, within 36 hours less a minute of its asOf, the 12-hour
    /// stack's budget against the 48-hour Param delay (seed 115's sweep chained three, 72 hours less a minute unrelayed).
    uint256 public outageUntil;
    uint256 public outages;
    uint256 public outagesWhileDown;
    uint256 public outageRelays;
    uint256 public staleStampsSkipped;

    /// The stack relay in progress (`_relayStack`), its serial number, and the serial of the last relay that covered
    /// each ghost (by index + 1, as `_probeKills` picks; 0 when none has).
    bool internal _stackRelaying;
    uint256 internal _relaySerial;
    mapping(uint256 => uint256) internal _coveredBy;

    constructor(System memory s) GovernanceHandler(s) {}

    /// Once, from the walk's setUp: the sweeper on or off.
    function setSweeper(bool on) external {
        sweeping = on;
        _sweep();
    }

    /// Once, from the walk's setUp: the founder's stack starts now, spaced `spacing_`.
    function startStack(uint64 spacing_) external {
        require(spacing == 0, "started");
        spacing = spacing_;
        nextAsOf = uint64(vm.getBlockTimestamp());
    }

    /// @dev Every walk action: the founder's accounts drained (the sweeper), the stack's due stamps relayed, the
    /// action, and the due stamps again (a relay the action front-ran in its last second).
    modifier walk() {
        _sweep();
        _relayDue();
        _;
        _relayDue();
    }

    function _sweep() internal {
        if (!sweeping) return;
        vm.deal(owner, 0);
        vm.deal(guardian, 0);
        ++sweeps;
    }

    // =====================================================================================================
    // the founder's stack, relayed by the stranger
    // =====================================================================================================

    /// The stack's stamps whose asOf has come, relayed now (each was due this second: every advance stops at each asOf);
    /// none while the relayer is down, and back from an outage, the newest due first (`_newestFirst`).
    function _relayDue() internal {
        if (outageUntil != 0) {
            if (vm.getBlockTimestamp() < outageUntil) return;
            outageUntil = 0;
            _newestFirst();
        }
        while (spacing != 0 && nextAsOf <= vm.getBlockTimestamp()) {
            _relayStack();
        }
    }

    /// Back from an outage with stamps due: the next to relay is the newest due one; the older ones are skipped.
    function _newestFirst() internal {
        if (spacing == 0 || nextAsOf > vm.getBlockTimestamp()) return;
        uint256 skip = (vm.getBlockTimestamp() - nextAsOf) / spacing;
        // casting to 'uint64' is safe because the skip is a few spacings of a uint64 clock
        // forge-lint: disable-next-line(unsafe-typecast)
        nextAsOf += uint64(skip * spacing);
        staleStampsSkipped += skip;
        ++outageRelays;
    }

    /// @dev The relayer goes down for a blink (BLINK), an hour, 12 hours or just under 36 hours (see `outageUntil`); the
    /// stamps due meanwhile wait for its return. While it is down already, the draw leaves the outage as it is.
    function relayOutage(uint256 seed) external step pinned walk act {
        if (outageUntil != 0) {
            ++outagesWhileDown;
            return;
        }
        uint256[4] memory latency = [BLINK, 1 hours, 12 hours, 36 hours - 1 minutes];
        outageUntil = vm.getBlockTimestamp() + latency[_r(seed, "outage") % 4];
        ++outages;
    }

    /// Time moves to `to`, stopping at each stack asOf on the way to relay it there. With `frontRun`, a stamp whose asOf
    /// is `to` itself is left for after the caller's next call (the thief's transaction lands first in that second).
    function _advanceTo(uint256 to, bool frontRun) internal {
        while (spacing != 0 && nextAsOf <= to) {
            if (frontRun && nextAsOf == to) break;
            if (outageUntil != 0) {
                // the relayer is down: time runs to its return (or to `to`, if that comes first) with no relay, then it
                // relays the newest due stamp
                uint256 back = Math.min(outageUntil, to);
                if (back > vm.getBlockTimestamp()) _warp(back - vm.getBlockTimestamp(), doorBlockTime);
                if (vm.getBlockTimestamp() < outageUntil) break;
                _relayDue();
                continue;
            }
            if (nextAsOf > vm.getBlockTimestamp()) _warp(nextAsOf - vm.getBlockTimestamp(), doorBlockTime);
            _relayStack();
        }
        if (to > vm.getBlockTimestamp()) _warp(to - vm.getBlockTimestamp(), doorBlockTime);
    }

    /// The stack's next stamp, relayed by the stranger on both targets (judged: a valid stamp in its window, moving each
    /// owner's clock to its asOf), then each thief item it newly covers probed (see the contract's notes).
    function _relayStack() internal {
        uint64 asOf = nextAsOf;
        for (uint8 t; t < 2; ++t) {
            uint256[] memory covered = _covered(t, asOf);
            uint256 serial = ++_relaySerial;
            for (uint256 k; k < covered.length; ++k) {
                _coveredBy[covered[k] + 1] = serial;
            }
            // the relay's own kill probes (_probeKills, below) leave out what the survivor probe runs
            bytes memory sig = Stamps.sign(w.ownerKey, Stamps.digest(block.chainid, address(_target(t)), asOf));
            uint256 relayed0 = stampsRelayed;
            _stackRelaying = true;
            _relay(t, asOf, sig, true, w.stranger, 1);
            _stackRelaying = false;
            if (stampsRelayed == relayed0) ++stackRelaysRefused;
            else ++stackRelays;
            _probeSurvivors(t, covered);
        }
        lastAsOf = asOf;
        nextAsOf = asOf + spacing;
    }

    /// Task 39a's kill probes after a stack relay (GovernanceHandler._relay calls `_probeKills`), less the survivor
    /// probe's own (Task 39b's timing ruling, proposal 3). 39a picks up to three pending items on `t`: the newest
    /// scheduled at or before the clock, the oldest after it, and the newest overall. Here the first is left out when a
    /// stack relay covered it, this one or an earlier one: `_probeSurvivors` executed it once ready then, and a dead
    /// item stays dead (the clocks only rise; a re-schedule is a new ghost), so 39a's probe of it repeats that one. The
    /// alive-side picks (the oldest after the clock, where an over-kill would show, and the newest when it is neither),
    /// and a dead pick no relay covered (one an instrument killed), still run as 39a runs them: executed in a snapshot
    /// once ready, each as the ghost log predicts. The picks and the probe are 39a's own (`_killPicks`, `_killProbe`:
    /// Task 42 folded the copy, the Task 39b re-review's Minor 4, 39a's campaign replayed identical).
    function _probeKills(uint8 t) internal override {
        if (!_stackRelaying) {
            super._probeKills(t);
            return;
        }
        (uint256 newestDead, uint256 oldestAlive, uint256 newest, uint64 clock) = _killPicks(t);
        uint256[3] memory pick;
        uint256 n;
        if (newestDead != 0) {
            if (_coveredBy[newestDead] == 0) {
                pick[n++] = newestDead;
            } else if (!_lapsed(t, _ghosts[newestDead - 1].readyAt, _ghosts[newestDead - 1].readyBlock)) {
                ++killProbesSkipped;
            }
        }
        if (oldestAlive != 0) pick[n++] = oldestAlive;
        if (newest != 0 && newest != newestDead && newest != oldestAlive) pick[n++] = newest;
        if (n == 0) return;
        _readLogs();
        uint256 misses;
        uint256 probed;
        for (uint256 k; k < n; ++k) {
            (bool ran, bool matched) = _killProbe(t, pick[k]);
            if (!ran) continue;
            ++probed;
            if (_ghosts[pick[k] - 1].scheduledAt > clock) ++aliveKillProbes;
            else ++deadKillProbesKept;
            if (!matched) ++misses;
        }
        _dropLogs();
        _countKillProbes(probed, misses);
    }

    /// The pending items on `t` a stamp as of `asOf` covers that are alive now (scheduled at or before it, not dead by the
    /// model's clocks), as ghost indexes.
    function _covered(uint8 t, uint64 asOf) internal view returns (uint256[] memory list) {
        uint256 n;
        uint256[] memory all = new uint256[](_ghosts.length);
        for (uint256 i; i < _ghosts.length; ++i) {
            Ghost storage g = _ghosts[i];
            if (g.t == t && g.life == Life.Pending && g.scheduledAt <= asOf && !_dead(t, g)) all[n++] = i;
        }
        list = new uint256[](n);
        for (uint256 k; k < n; ++k) {
            list[k] = all[k];
        }
    }

    /// For each covered item, the owner's clock read from the lens must be at or past its schedule time (`clockBehind`
    /// otherwise), and its execute in a snapshot by the thief once ready (its readyAt and readyBlock) must be refused
    /// ExitsNotOpen: the stamp killed it. One lapsed already (its windows in time and in blocks passed) is not executed.
    function _probeSurvivors(uint8 t, uint256[] memory covered) internal {
        if (covered.length == 0) return;
        _readLogs();
        uint256 t0 = vm.getBlockTimestamp();
        uint256 b0 = vm.getBlockNumber();
        uint64 clock = _lens(t).lastOwnerClose();
        uint256 lived;
        uint256 probed;
        uint256[3] memory byKind;
        for (uint256 k; k < covered.length; ++k) {
            Ghost memory g = _ghosts[covered[k]];
            if (clock < g.scheduledAt) ++clockBehind;
            if (_lapsed(t, g.readyAt, g.readyBlock)) continue;
            uint256 snap = vm.snapshotState();
            if (t0 < g.readyAt) vm.warp(g.readyAt);
            if (vm.getBlockNumber() < g.readyBlock) vm.roll(g.readyBlock);
            vm.prank(owner);
            (bool ok, bytes memory reason) = address(_target(t)).call(abi.encodeCall(CascadeBase.execute, (g.data)));
            vm.revertToStateAndDelete(snap);
            vm.warp(t0);
            vm.roll(b0);
            ++probed;
            ++byKind[uint8(g.kind)];
            if (ok || keccak256(reason) != keccak256(abi.encodeWithSelector(ExitsNotOpen.selector))) ++lived;
        }
        _dropLogs();
        thiefItemsKilledByStack += probed;
        for (uint256 k; k < 3; ++k) {
            thiefItemsKilledByStackByKind[k] += byKind[k];
        }
        survivors += lived;
        unexpectedReverts += lived;
    }

    // =====================================================================================================
    // the thief
    // =====================================================================================================

    /// @dev The thief schedules an item on either target: a setter-table item (Task 39a's draw), or, one draw in four, a
    /// Reopen it can open (a known bridge disabled on the target, a Removed door on the vault) or else a swap to the
    /// other guardian candidate (the thief's own). When: now; one second after the stack's next relay (the worst case,
    /// the next stamp a whole spacing away); or at the next stack asOf, a moment before its relay in that second.
    function thiefSchedule(uint256 entrySeed, uint256 argSeed, uint256 how) external step pinned walk act {
        uint256 when = _r(how, "when") % 4;
        if (when == 1) {
            _advanceTo(nextAsOf, false);
            _advanceTo(vm.getBlockTimestamp() + 1, false);
        } else if (when == 2) {
            _advanceTo(nextAsOf, true);
        }
        (uint8 t, bytes memory data) =
            _r(how, "reopen") % 4 == 0 ? _thiefReopen(argSeed) : _thiefItem(entrySeed, argSeed);
        bool atAnAsOf = spacing != 0 && nextAsOf == vm.getBlockTimestamp();
        bool rightAfter = lastAsOf + 1 == vm.getBlockTimestamp();
        if (_schedule(t, data, owner)) {
            ++thiefSchedules;
            Kind kind = _ghosts[_live[t][keccak256(data)] - 1].kind;
            ++thiefSchedulesByKind[uint8(kind)];
            if (t == V) ++thiefSchedulesOnTheVault;
            if (atAnAsOf) ++thiefSchedulesAtAnAsOf;
            if (rightAfter) ++thiefSchedulesRightAfterARelay;
        } else {
            ++thiefSchedulesRefused;
        }
    }

    /// A setter-table item (GovernanceHandler's schedulable entries, its argument draw).
    function _thiefItem(uint256 entrySeed, uint256 argSeed) internal view returns (uint8, bytes memory) {
        uint256 e = _scheduledEntry(entrySeed, 0);
        if (_r(entrySeed, "multi") % 8 == 0) e = [uint256(1), 2, 3, 5][_r(entrySeed, "which") % 4];
        return _generate(e, argSeed);
    }

    /// A Reopen the thief can schedule: a known bridge disabled on a target (the primary first), or a Removed door's on
    /// the vault; with none, one draw in two the thief opens one itself (as the owner it disables the target's primary,
    /// an owner hold that stamps the owner's clock now, then waits a second, the stack relayed on the way), else a swap
    /// to the guardian candidate the target does not name (a Reopen needs no gate, a swap no owner hold).
    function _thiefReopen(uint256 seed) internal returns (uint8, bytes memory) {
        uint8 t = uint8(_r(seed, "reopen target") % 2);
        for (uint256 j; j < 3; ++j) {
            if (_m[_f(t, F_KNOWN + j)] != 0 && _m[_f(t, F_ENABLED + j)] == 0) {
                return (t, abi.encodeCall(CascadeBase.activateBridge, (bridges[j])));
            }
        }
        for (uint256 i; i < 3; ++i) {
            if (DoorState(_m[V_DOOR + i]) == DoorState.Removed) return (V, _activation(i));
        }
        if (_r(seed, "open one") % 2 == 0) {
            uint256 p = _bridgeIndex(address(uint160(_m[_f(t, F_PRIMARY)])));
            _disable(t, p, owner);
            ++thiefOwnerInstruments;
            _advanceTo(vm.getBlockTimestamp() + 1, false);
            if (_m[_f(t, F_ENABLED + p)] == 0) return (t, abi.encodeCall(CascadeBase.activateBridge, (bridges[p])));
        }
        return (t, abi.encodeCall(CascadeBase.setGuardian, (_staleGuardian(t))));
    }

    /// @dev The thief executes one of its pending items (Task 39a's pick: an alive one first), after, three draws in four, a
    /// wait to its readyAt (the stack relayed on the way; one draw in two of those, at a readyAt that is a stack asOf, the
    /// thief's execute lands before that second's relay). Judged; any success is a finding.
    function thiefExecute(uint256 itemSeed, uint256 how) external step pinned walk act {
        (uint8 t, bytes memory data, bool fromLog) = _pickData(itemSeed, how);
        if (!fromLog || _live[t][keccak256(data)] == 0) return;
        Ghost memory g = _ghosts[_live[t][keccak256(data)] - 1];
        if (_r(how, "wait") % 4 != 0) {
            _advanceTo(g.readyAt, _r(how, "front run") % 2 == 0);
            if (vm.getBlockNumber() < g.readyBlock) vm.roll(g.readyBlock);
        }
        ++thiefExecuteAttempts;
        if (vm.getBlockTimestamp() >= g.readyAt && vm.getBlockNumber() >= g.readyBlock) {
            ++thiefExecuteAttemptsWhenReady;
        }
        uint256 before = executes + executeViolations;
        uint256 dead0 = executesRefusedDead;
        _execute(t, data, owner);
        if (executes + executeViolations != before) ++thiefExecutions;
        if (executesRefusedDead != dead0) ++thiefExecutesRefusedDead;
    }

    /// @dev The thief plays an instrument with either key (one Ledger): as the owner, a pause, an unpause, a door's
    /// removal, a bridge's disable, a primary switch, a direct setter call (Task 39a's draw: a tightening applies at once,
    /// a loosening is refused NotScheduled) or a cancel of any item; as the guardian, a pause, a removal, a disable or a
    /// cancel of an Ordinary item. Each judged; each owner instrument stamps the owner's clock, killing the thief's own
    /// items, as the table says.
    function thiefInstrument(uint256 kindSeed, uint256 argSeed) external step pinned walk act {
        uint256 k = _r(kindSeed, "thief instrument") % 11;
        uint8 t = uint8(_r(argSeed, "on") % 2);
        bool asGuardian = k >= 7;
        address as_ = asGuardian ? _guardianOf(t) : owner;
        if (k == 0 || k == 7) {
            _pause(t, as_);
        } else if (k == 1) {
            _unpause(t, owner);
        } else if (k == 2 || k == 8) {
            _removeDoor(_r(argSeed, "door") % 3, asGuardian ? guardianOfVault() : owner);
        } else if (k == 3 || k == 9) {
            uint256 j = _r(argSeed, "bridge") % 3;
            if (_r(argSeed, "primary") % 2 == 0) j = _bridgeIndex(address(uint160(_m[_f(t, F_PRIMARY)])));
            _disable(t, j, as_);
        } else if (k == 4) {
            _setPrimary(t, _r(argSeed, "to") % 3, owner);
        } else if (k == 5) {
            (uint8 dt, bytes memory data) = _generate(_r(argSeed, "direct") % 34, argSeed);
            _direct(dt, data, owner);
        } else {
            (uint8 ct, bytes memory data, bool fromLog) = _pickData(argSeed, argSeed);
            if (!fromLog) return;
            _cancel(ct, data, asGuardian ? _guardianOf(ct) : owner);
        }
        if (asGuardian) ++thiefGuardianInstruments;
        else ++thiefOwnerInstruments;
    }

    /// @dev Time passes (a second, a minute, an hour, six hours, half a day, a day, two, three or eight days), the stack
    /// relayed at each asOf on the way. The chain never halts here: a halt is the spec's stated first-block race (§5).
    function walkWarp(uint256 seed) external step pinned walk act {
        uint32[9] memory secs = [uint32(1), 1 minutes, 1 hours, 6 hours, 12 hours, 1 days, 2 days, 3 days, 8 days];
        _advanceTo(vm.getBlockTimestamp() + secs[_r(seed, "walk warp") % 9], false);
    }

    function killedByKind() external view returns (uint256[3] memory) {
        return thiefItemsKilledByStackByKind;
    }

    function schedulesByKind() external view returns (uint256[3] memory) {
        return thiefSchedulesByKind;
    }
}
