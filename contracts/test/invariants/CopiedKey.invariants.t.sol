// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CascadeBase} from "../../src/CascadeBase.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {ICascadeTwap} from "../../src/interfaces/ICascadeTwap.sol";
import {Item} from "../../src/CascadeTypes.sol";
import {ExitsNotOpen} from "../../src/CascadeErrors.sol";
import {Schedule} from "../governance/Schedule.sol";
import {GovernanceWorld} from "./GovernanceWorld.sol";
import {MinimumHits} from "./MinimumHits.sol";
import {CopiedKeyHandler} from "./handlers/CopiedKeyHandler.sol";
import {TrackedHandler} from "./handlers/TrackedHandler.sol";

/// @dev The copied-key walk (Task 39b; spec §3.6's CO column and the signed stamp's CO walk), on GovernanceWorld: with
/// the sweeper on, the owner's and the guardian's accounts are drained before every step and the founder acts only
/// through its stack, pre-signed at STAMP_SPACING (12 hours, Task 48's STAMP_SPACING_HOURS) and relayed by the stranger
/// as each asOf passes; the thief holds both keys, schedules freely, waits for its items and tries them, and plays every
/// instrument (CopiedKeyHandler). Inherits BoundaryInvariants. The pins script the walk's edge: the spacing at which a
/// thief item first runs, for each class, and the 12-hour spacing against every class and kind on both targets.
contract CopiedKeyWalkTest is GovernanceWorld, MinimumHits {
    CopiedKeyHandler handler;

    uint64 constant PARAM = 48 hours;
    uint64 constant REGISTRY = 7 days;
    uint64 constant GUARDIAN = 8 days;

    function setUp() public {
        startGovernance();
        c = deployCampaign();
        handler = new CopiedKeyHandler(TrackedHandler.System(c.vault, c.vaultLens, c.fd, c.doorLens, owner, guardian));
        buildWorld(handler);
        sweeper(true);
        handler.startStack(STAMP_SPACING);
        bytes4[] memory selectors = new bytes4[](14);
        for (uint256 i; i < 4; ++i) {
            selectors[i] = CopiedKeyHandler.thiefSchedule.selector;
            selectors[4 + i] = CopiedKeyHandler.thiefExecute.selector;
        }
        selectors[8] = CopiedKeyHandler.thiefInstrument.selector;
        selectors[9] = CopiedKeyHandler.thiefInstrument.selector;
        selectors[10] = CopiedKeyHandler.thiefInstrument.selector;
        selectors[11] = CopiedKeyHandler.walkWarp.selector;
        selectors[12] = CopiedKeyHandler.walkWarp.selector;
        selectors[13] = CopiedKeyHandler.relayOutage.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// The fixture's sweeper, and the handler's with it (it drains before each of its steps).
    function sweeper(bool on) internal override {
        super.sweeper(on);
        handler.setSweeper(on);
    }

    // ---- the invariants ----

    /// @dev The CO walk (spec §3.6): under the sweeper, no item the thief schedules ever executes, through its own
    /// executes at and around each item's readyAt; and each dies to the first stamp of the founder's stack relayed at
    /// or after its schedule time (the owner's clock, read from the lens, reaches its schedule time, and executed in a
    /// snapshot once ready it is refused ExitsNotOpen); every stack stamp is accepted at its asOf; no execute ran that
    /// the ghost log refuses; and the founder's accounts hold nothing.
    function invariant_coWalkNothingExecutes() public view {
        assertEq(handler.thiefExecutions(), 0, "CO: an item the thief scheduled executed");
        assertEq(handler.clockBehind(), 0, "CO: a stack stamp left the owner's clock before a thief item it covers");
        assertEq(handler.survivors(), 0, "CO: a thief item outlived the first stack stamp at or after its schedule");
        assertEq(handler.stackRelaysRefused(), 0, "CO: a stamp of the founder's stack was refused at its asOf");
        assertEq(handler.executeViolations(), 0, "CO: an execute ran that the ghost log refuses");
        assertEq(owner.balance + guardian.balance, 0, "CO: the sweeper left the founder gas");
    }

    /// @dev Every call refused only as its action and the model predict.
    /// The campaign also fails on any handler call that reverts (Task 34's M6, carried to Task 42: a call a handler does
    /// not wrap in a try, whose revert the fuzzer would otherwise drop): fail-on-revert for this invariant's campaign.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_noUnexpectedReverts() public view {
        assertEq(handler.unexpectedReverts(), 0);
    }

    /// @dev The walk's reach; asserts nothing.
    function invariant_reachabilityLogged() public {
        uint256[3] memory scheduled = handler.schedulesByKind();
        uint256[3] memory killed = handler.killedByKind();
        string[3] memory kinds = ["Ordinary", "GuardianSwap", "Reopen"];
        for (uint256 k; k < 3; ++k) {
            emit log_named_uint(string.concat("thiefSchedules.", kinds[k]), scheduled[k]);
            emit log_named_uint(string.concat("thiefItemsKilledByStack.", kinds[k]), killed[k]);
        }
        emit log_named_uint("sweeps", handler.sweeps());
        emit log_named_uint("stackRelays", handler.stackRelays());
        emit log_named_uint("thiefSchedules", handler.thiefSchedules());
        emit log_named_uint("thiefSchedulesOnTheVault", handler.thiefSchedulesOnTheVault());
        emit log_named_uint("thiefSchedulesAtAnAsOf", handler.thiefSchedulesAtAnAsOf());
        emit log_named_uint("thiefSchedulesRightAfterARelay", handler.thiefSchedulesRightAfterARelay());
        emit log_named_uint("thiefSchedulesRefused", handler.thiefSchedulesRefused());
        emit log_named_uint("thiefExecuteAttempts", handler.thiefExecuteAttempts());
        emit log_named_uint("thiefExecuteAttemptsWhenReady", handler.thiefExecuteAttemptsWhenReady());
        emit log_named_uint("thiefExecutesRefusedDead", handler.thiefExecutesRefusedDead());
        emit log_named_uint("thiefOwnerInstruments", handler.thiefOwnerInstruments());
        emit log_named_uint("thiefGuardianInstruments", handler.thiefGuardianInstruments());
        emit log_named_uint("thiefItemsKilledByStack", handler.thiefItemsKilledByStack());
        emit log_named_uint("itemsKilledByOwner", handler.itemsKilledByOwner());
        emit log_named_uint("itemsKilledByGuardian", handler.itemsKilledByGuardian());
        emit log_named_uint("killProbes", handler.killProbes());
        emit log_named_uint("killProbesSkipped", handler.killProbesSkipped());
        emit log_named_uint("deadKillProbesKept", handler.deadKillProbesKept());
        emit log_named_uint("aliveKillProbes", handler.aliveKillProbes());
        emit log_named_uint("outages", handler.outages());
        emit log_named_uint("outageRelays", handler.outageRelays());
        emit log_named_uint("staleStampsSkipped", handler.staleStampsSkipped());
        emit log_named_uint("outagesWhileDown", handler.outagesWhileDown());
        _logHitTotals();
    }

    // ---- B9: the named states' minimum hits in a long run (MinimumHits) ----

    function _hitTag() internal pure override returns (string memory) {
        return "copiedkey";
    }

    /// The walk's named states (the Task 39b re-review's (c): the late relay, so the alive-side kill probe is reached),
    /// each with its minimum over 3,000 runs at depth 64 (MinimumHits' rule: a quarter of the slowest seed's
    /// projection).
    function _hits() internal view override returns (Hit[] memory h) {
        h = new Hit[](4);
        h[0] = Hit("aliveKillProbes", handler.aliveKillProbes(), 71);
        h[1] = Hit("outageRelays", handler.outageRelays(), 1343);
        h[2] = Hit("staleStampsSkipped", handler.staleStampsSkipped(), 668);
        h[3] = Hit("thiefItemsKilledByStack", handler.thiefItemsKilledByStack(), 5124);
    }

    // ---- the walk's edge, scripted ----

    /// At the shortest class delay's margin: with the stack spaced 48 hours and 2 seconds, a Param item the thief
    /// schedules a second after a stamp is ready a second before the next stamp's asOf, and runs, on either target. At
    /// 48 hours and 1 second the next stamp's asOf is the readyAt itself: whoever lands first in that second wins.
    function test_walkEdge_aSpacingPastTheParamDelayLetsAParamItemRun() public {
        _expectRuns(c.vault, _payoutDelay(), PARAM + 2, false);
        _expectRuns(c.fd, _batchInterval(), PARAM + 2, false);
        _expectRuns(c.vault, _payoutDelay(), PARAM + 1, false);
        _expectDies(c.vault, _payoutDelay(), PARAM + 1, true);
    }

    /// The largest safe spacing is the shortest class delay, 48 hours, with the relay in the asOf's own second, so no
    /// margin: the stamp after the one before the thief's schedule comes at the latest a second before the item is
    /// ready, on either target. A real relay needs the spacing less its latency and a block, and a spacing past the
    /// stamp's 1-day TTL leaves hours in which no covering stamp can be relayed at all; the 12-hour stack has room for
    /// both.
    function test_walkEdge_theLargestSafeSpacingIsTheParamDelay() public {
        _expectDies(c.vault, _payoutDelay(), PARAM, false);
        _expectDies(c.fd, _batchInterval(), PARAM, false);
    }

    /// Each class is safe up to its own delay and no further: a Registry item (7 days) and a Guardian-class swap (8
    /// days) run just past theirs, die at them, and die at the spacing that let a Param item run.
    function test_walkEdge_eachClassIsSafeUpToItsOwnDelay() public {
        bytes memory registry = abi.encodeCall(CascadeBase.activateBridge, (address(g.bridge2)));
        _expectRuns(c.vault, registry, REGISTRY + 2, false);
        _expectDies(c.vault, registry, REGISTRY, false);
        _expectDies(c.vault, registry, PARAM + 2, false);
        bytes memory swap = abi.encodeCall(CascadeBase.setGuardian, (guardian2));
        _expectRuns(c.fd, swap, GUARDIAN + 2, false);
        _expectDies(c.fd, swap, GUARDIAN, false);
        _expectDies(c.fd, swap, PARAM + 2, false);
    }

    /// The 12-hour stack (STAMP_SPACING) against every class and kind on both targets, each item scheduled a second after
    /// a stamp (its worst case): Param (Ordinary), Registry (a new bridge or door, the write-off: Ordinary; the primary's
    /// and the launch door's Reopen after the thief's own disable or removal), Guardian (the swap; the transfer,
    /// Ordinary). Each dies to the next stamp, 12 hours less a second later, and is refused ExitsNotOpen once ready.
    function test_walkEdge_twelveHoursHoldsForEveryClassAndKind() public {
        uint64 s = STAMP_SPACING;
        // Param
        _expectDies(c.vault, _payoutDelay(), s, false);
        _expectDies(c.vault, abi.encodeCall(CascadeVault.setStakeHotkey, (HK2)), s, false);
        _expectDies(c.fd, _batchInterval(), s, false);
        _expectDies(c.fd, abi.encodeCall(CascadeFrontDoor.setOracle, (ICascadeTwap(stranger))), s, false);
        // Registry, Ordinary
        _expectDies(c.vault, abi.encodeCall(CascadeBase.activateBridge, (address(g.bridge2))), s, false);
        _expectDies(c.vault, abi.encodeCall(CascadeVault.activateFrontDoor, (SECOND_CHAIN, g.door2)), s, false);
        _expectDies(c.vault, abi.encodeCall(CascadeVault.writeOffMissingStake, (0)), s, false);
        _expectDies(c.fd, abi.encodeCall(CascadeBase.activateBridge, (address(g.bridge2))), s, false);
        // Registry, Reopen: the thief's own disable or removal first (an owner hold, the owner's clock now)
        _reopenDies(c.vault, abi.encodeCall(CascadeBase.disableBridge, (address(c.bridge))), s);
        _reopenDies(c.fd, abi.encodeCall(CascadeBase.disableBridge, (address(c.bridge))), s);
        _reopenDies(c.vault, abi.encodeCall(CascadeVault.removeFrontDoor, (BASE, address(c.fd))), s);
        // Guardian: the swap and the transfer
        _expectDies(c.vault, abi.encodeCall(CascadeBase.setGuardian, (guardian2)), s, false);
        _expectDies(c.fd, abi.encodeCall(CascadeBase.setGuardian, (guardian2)), s, false);
        _expectDies(c.vault, abi.encodeCall(CascadeBase.transferOwnership, (owner2)), s, false);
        _expectDies(c.fd, abi.encodeCall(CascadeBase.transferOwnership, (owner2)), s, false);
    }

    /// An item the thief schedules at exactly a stamp's asOf, in that second ahead of the relay, dies to that stamp:
    /// the owner's clock reads its schedule time at once, and once ready, with no later stamp relayed, its execute is
    /// refused ExitsNotOpen; a Param item and the guardian swap, on either target (Task 39b's review, Minor 4). A stamp
    /// that killed only the items scheduled before its asOf leaves each alive here, where the 12-hour stack's next
    /// stamp would hide it.
    function test_walkEdge_anItemScheduledAtAnAsOfDiesToThatStamp() public {
        _atAnAsOf(c.vault, _payoutDelay());
        _atAnAsOf(c.fd, _batchInterval());
        _atAnAsOf(c.vault, abi.encodeCall(CascadeBase.setGuardian, (guardian2)));
        _atAnAsOf(c.fd, abi.encodeCall(CascadeBase.setGuardian, (guardian2)));
    }

    /// The relayer's outages never chain past the longest: one drawn while the relayer is down leaves its return where it
    /// was, so the stamps due meanwhile are relayed (the newest first) 36 hours less a minute after the first draw.
    function test_walkEdge_anOutageDrawnWhileDownLeavesItsReturn() public {
        uint256 longest = _seed("outage", 4, 3);
        uint64 start = uint64(vm.getBlockTimestamp());
        handler.relayOutage(longest);
        assertEq(handler.outageUntil(), start + 36 hours - 1 minutes, "the longest outage");
        handler.walkWarp(_seed("walk warp", 9, 4));
        assertEq(vm.getBlockTimestamp(), start + 12 hours, "12 hours on, the relayer down");
        handler.relayOutage(longest);
        assertEq(handler.outageUntil(), start + 36 hours - 1 minutes, "an outage drawn while down moved its return");
        assertEq(handler.outagesWhileDown(), 1, "counted");
        handler.walkWarp(_seed("walk warp", 9, 5));
        assertEq(handler.outageUntil(), 0, "the relayer back");
        assertEq(handler.lastAsOf(), start + 36 hours, "every stamp due relayed");
        assertEq(c.doorLens.lastOwnerClose(), start + 36 hours, "the door's clock");
        assertEq(c.vaultLens.lastOwnerClose(), start + 36 hours, "the vault's clock");
    }

    /// Seed 115's sweep counterexample (2026-11-14), its shrunk eight calls: three longest outages, the second and the
    /// third each drawn while the last was on, once kept the relayer down 72 hours less a minute, and the thief's
    /// setOracle(stranger) on the front door, scheduled 12 hours in, ran at its readyAt, 60 hours in, with no stamp
    /// relayed since the walk's first. Now the second draw leaves the first outage as it is: the relayer is back 36
    /// hours less a minute in, relays the stamp as of 24 hours (the newest due), and the item dies.
    function test_walkEdge_seed115ChainedOutagesNoLonger() public {
        handler.relayOutage(44374833426731600253220211024009044746574667148311304730059052000321779);
        handler.thiefSchedule(1731576783292936802470700653626713331387569131914, 12391131100, 137276397013305);
        handler.relayOutage(8311120839122364909306891404679530245551345);
        handler.walkWarp(107051105117797604332146423518534000959876972014435);
        handler.thiefSchedule(2237083643, 3041, 300);
        handler.relayOutage(12050);
        handler.thiefInstrument(3076685254566390490602029374678153287653472181, 136180168512565489014364591348);
        handler.thiefExecute(
            67814664334731032578255318628861249535853096411223044173542997387285,
            115792089237316195423570985008687907853269984665640564039457584007913129639933
        );
        assertEq(handler.thiefExecutions(), 0, "CO: an item the thief scheduled executed");
        assertEq(handler.survivors() + handler.clockBehind() + handler.stackRelaysRefused(), 0, "the stack held");
        assertGe(handler.thiefItemsKilledByStack(), 1, "the thief's item died to the stack");
    }

    /// The thief schedules `data` on `t` a second from now, then the stamp as of that second is relayed in it; no later
    /// stamp; the item, once ready, must be refused ExitsNotOpen.
    function _atAnAsOf(CascadeBase t, bytes memory data) internal {
        uint256 snap = vm.snapshotState();
        Schedule.wait(1);
        uint64 asOf = uint64(vm.getBlockTimestamp());
        swept();
        sched(t, data);
        Item memory it = _lensOf[address(t)].scheduled(keccak256(data));
        assertEq(it.scheduledAt, asOf, "scheduled at the asOf");
        swept();
        stampAt(t, asOf);
        assertGe(_lensOf[address(t)].lastOwnerClose(), it.scheduledAt, "the stamp's clock reaches the schedule time");
        Schedule.warpTo(it.readyAt);
        if (vm.getBlockNumber() < it.readyBlock) vm.roll(it.readyBlock);
        swept();
        vm.prank(owner);
        (bool ran, bytes memory why) = address(t).call(abi.encodeCall(CascadeBase.execute, (data)));
        vm.revertToStateAndDelete(snap);
        assertFalse(ran, "the thief's item scheduled at the asOf ran");
        assertEq(why, abi.encodeWithSelector(ExitsNotOpen.selector), "dead");
    }

    /// The thief's instrument `closure` on `t` (a disable, a removal), then the race for its Reopen at `s`, which dies.
    function _reopenDies(CascadeBase t, bytes memory closure, uint64 s) internal {
        uint256 snap = vm.snapshotState();
        vm.prank(owner);
        (bool ok,) = address(t).call(closure);
        assertTrue(ok, "the thief's closure");
        bytes memory reopen;
        if (bytes4(closure) == CascadeBase.disableBridge.selector) {
            reopen = abi.encodeCall(CascadeBase.activateBridge, (address(c.bridge)));
        } else {
            reopen = abi.encodeCall(CascadeVault.activateFrontDoor, (BASE, address(c.fd)));
        }
        (bool ran, bytes memory why) = _race(t, reopen, s, false);
        assertEq(uint8(_lensOf[address(t)].scheduled(keccak256(reopen)).kind), 2, "a Reopen");
        vm.revertToStateAndDelete(snap);
        assertFalse(ran, "the thief's Reopen ran");
        assertEq(why, abi.encodeWithSelector(ExitsNotOpen.selector), "dead");
    }

    function _payoutDelay() internal pure returns (bytes memory) {
        return abi.encodeCall(CascadeVault.setPayoutDelay, (12 hours));
    }

    function _batchInterval() internal pure returns (bytes memory) {
        return abi.encodeCall(CascadeFrontDoor.setBatchInterval, (6 hours));
    }

    function _expectRuns(CascadeBase t, bytes memory data, uint64 s, bool botFirst) internal {
        uint256 snap = vm.snapshotState();
        (bool ran, bytes memory why) = _race(t, data, s, botFirst);
        vm.revertToStateAndDelete(snap);
        assertTrue(ran, string.concat("the thief's item ran at spacing ", vm.toString(s), ": ", vm.toString(why)));
    }

    function _expectDies(CascadeBase t, bytes memory data, uint64 s, bool botFirst) internal {
        uint256 snap = vm.snapshotState();
        (bool ran, bytes memory why) = _race(t, data, s, botFirst);
        vm.revertToStateAndDelete(snap);
        assertFalse(ran, string.concat("the thief's item ran at spacing ", vm.toString(s)));
        assertEq(why, abi.encodeWithSelector(ExitsNotOpen.selector), "dead");
    }

    /// The race at spacing `s` (see the contract's notes): the stack's stamp as of now relayed; a second later the thief
    /// schedules `data` on `t`; each later stamp relayed as its asOf passes, while it comes before the item's readyAt; at
    /// the readyAt (and its readyBlock) the thief executes, after a stamp whose asOf is that second only when `botFirst`.
    function _race(CascadeBase t, bytes memory data, uint64 s, bool botFirst) internal returns (bool, bytes memory) {
        uint64 t0 = uint64(vm.getBlockTimestamp());
        swept();
        stampAt(t, t0);
        Schedule.wait(1);
        sched(t, data);
        Item memory it = _lensOf[address(t)].scheduled(keccak256(data));
        uint64 asOf = t0 + s;
        while (asOf < it.readyAt) {
            Schedule.warpTo(asOf);
            swept();
            stampAt(t, asOf);
            asOf += s;
        }
        Schedule.warpTo(it.readyAt);
        if (vm.getBlockNumber() < it.readyBlock) vm.roll(it.readyBlock);
        swept();
        if (asOf == it.readyAt && botFirst) stampAt(t, asOf);
        vm.prank(owner);
        return address(t).call(abi.encodeCall(CascadeBase.execute, (data)));
    }
}
