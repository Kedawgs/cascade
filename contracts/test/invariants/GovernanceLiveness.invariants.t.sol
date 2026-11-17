// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CascadeBase} from "../../src/CascadeBase.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {Actor} from "../../src/CascadeTypes.sol";
import {TokenAccounting} from "./BoundaryInvariants.sol";
import {GovernanceWorld, GovernanceWorldBase} from "./GovernanceWorld.sol";
import {GovernanceHandler} from "./handlers/GovernanceHandler.sol";
import {
    LivenessHandler,
    PROBE_ACTIVATION,
    PROBE_ALL,
    PROBE_LIVENESS,
    PROBE_OWNER_PATH,
    PROBE_SWAP
} from "./handlers/LivenessHandler.sol";
import {TrackedHandler} from "./handlers/TrackedHandler.sol";

/// @dev The governance campaign's liveness half (Task 39b; spec §3.6, I-26 to I-28 and T7 B3): Task 39a's actors and
/// actions on its world (GovernanceWorldBase), and after every action the state it left probed in snapshots
/// (LivenessHandler): the owner's own way back to OPEN (I-26), every pending setGuardian run at its readyAt through the
/// guardian's every instrument a second before (I-27), a launch batch and a payout carried while both targets read OPEN
/// (I-28), and no pending activation naming an active target. Foundry runs each invariant as its own campaign, so each
/// probe family has its own contract below, with only its own probe on, its invariant, its own
/// `invariant_noUnexpectedReverts` and its reach log; the boundary invariants run once, probe-free, in
/// GovernanceLivenessTest, whose pins switch every probe on (Task 39b's timing ruling).
abstract contract LivenessWorld is GovernanceWorldBase {
    LivenessHandler handler;

    uint8 constant V = 0;
    uint8 constant D = 1;

    /// The campaign's setUp with the probe families `probes` on (LivenessHandler's PROBE_ bits): Task 39a's actions
    /// with its weights, and a guardian instrument a moment before a pending swap's readyAt (I-27's committed half),
    /// twice.
    function setUpLiveness(uint256 probes) internal {
        startGovernance();
        c = deployCampaign();
        handler =
            new LivenessHandler(TrackedHandler.System(c.vault, c.vaultLens, c.fd, c.doorLens, owner, guardian), probes);
        buildWorld(handler);
        bytes4[] memory selectors = governanceSelectors(2);
        selectors[35] = LivenessHandler.guardianBeforeSwap.selector;
        selectors[36] = LivenessHandler.guardianBeforeSwap.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev Every call refused only as its action and the model predict, the probes' included (each family's contract
    /// runs it on its own probe).
    /// The campaign also fails on any handler call that reverts (Task 34's M6, carried to Task 42: a call a handler does
    /// not wrap in a try, whose revert the fuzzer would otherwise drop): fail-on-revert for this invariant's campaign.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_noUnexpectedReverts() public view {
        assertEq(handler.unexpectedReverts(), 0);
    }

    // ---- the families' assertions (their invariants, and the pins' _assertAll) ----

    /// I-26: see GovernanceLivenessI26Test.
    function _assertOwnerReachesOpen() internal view {
        assertEq(handler.ownerPathRefused(), 0, "I-26: a call on the owner's way back was refused");
        assertEq(handler.ownerPathNotOpen(), 0, "I-26: the owner's way back did not reach OPEN");
    }

    /// I-27: see GovernanceLivenessI27Test.
    function _assertGuardianNeverDelays() internal view {
        assertEq(handler.swapsDelayedByGuardian(), 0, "I-27: a guardian instrument delayed a pending setGuardian");
        assertEq(handler.swapSchedulesRefused(), 0, "I-27: a setGuardian could not be scheduled or run under a storm");
    }

    /// I-28: see GovernanceLivenessI28Test. The coherent class (3) of each half.
    function _assertTwoChainLiveness() internal view {
        assertEq(
            handler.undeliveredBy(3),
            0,
            "I-28: a launch batch closed with both OPEN on a coherent front-door rail was not delivered"
        );
        assertEq(
            handler.uncreditedBy(3), 0, "I-28: a payout sent with both OPEN on a coherent vault rail was not credited"
        );
    }

    /// T7 B3: see GovernanceLivenessActivationTest.
    function _assertNoPendingActivation() internal view {
        assertEq(handler.pendingActivationsOfActive(), 0, "a pending activation names an active target");
    }

    /// The actions' reach, in every family's log: the committed guardian instrument before a swap and what ran after
    /// it, and the moves the probes' states come from.
    function _logActions() internal {
        emit log_named_uint("guardianInstrumentsBeforeSwap", handler.guardianInstrumentsBeforeSwap());
        emit log_named_uint("swapsAfterGuardianInstrument", handler.swapsAfterGuardianInstrument());
        emit log_named_uint("guardianSwaps", handler.guardianSwaps());
        emit log_named_uint("executes", handler.executes());
        emit log_named_uint("primarySwitches", handler.primarySwitches());
        emit log_named_uint("bridgeActivationsNew", handler.bridgeActivationsNew());
    }
}

/// @dev The liveness campaign's actions with no probe on, under the boundary invariants (lens parity, token accounting,
/// the pending Reopens, after every step; the fixed libraries in the setUp) and `invariant_noUnexpectedReverts`; and
/// the pins, each on a handler with every probe on (`allProbes`), each family's assertions checked (`_assertAll`).
contract GovernanceLivenessTest is LivenessWorld, GovernanceWorld {
    function setUp() public {
        setUpLiveness(0);
    }

    /// GovernanceWorld's: the boundary invariants' setUp half.
    function _boundary(GovernanceHandler h) internal override(GovernanceWorldBase, GovernanceWorld) {
        super._boundary(h);
    }

    /// Every probe family on, from the pin's first step.
    modifier allProbes() {
        handler.setProbes(PROBE_ALL);
        _;
    }

    function _assertAll() internal view {
        _assertOwnerReachesOpen();
        _assertGuardianNeverDelays();
        _assertTwoChainLiveness();
        _assertNoPendingActivation();
        invariant_noUnexpectedReverts();
        invariant_tokenAccounting();
        invariant_aPendingReopenNamesARemovedDoor();
    }

    /// I-28's gap, scripted (Task 39b's finding): a rail migration done on the vault's side only. The vault activates
    /// bridge2 (7 days), tightens its message limit to bridge2's cap, disables its primary (the launch rail, an owner
    /// hold) and switches to bridge2 (the hold cleared): the vault reads OPEN, and so does the front door, which still
    /// sends through the launch rail, now disabled on the vault, and has never known bridge2. Each half is a rail the
    /// other side does not take: a launch batch closed then is refused by the vault (NotBridge, filed by the rail), and
    /// a payout sent then by the front door (NotBridge).
    function test_I28_aOneSidedRailMigration() public allProbes {
        handler.queueRedeem(_seed("redeem", 50, 9));
        assertEq(handler.redeemsQueued(), 1, "a payout batch to send");
        bytes memory activation = abi.encodeCall(CascadeBase.activateBridge, (address(g.bridge2)));
        handler.pinSchedule(V, activation);
        handler.pinExecute(V, activation, 1);
        handler.pinDirect(V, abi.encodeCall(CascadeVault.setMessageLimits, (1_000e18, 1_000e18, 1)));
        handler.pinDisable(V, 0, owner);
        handler.pinWarp(1);
        handler.pinSetPrimary(V, 1);
        assertEq(c.vaultLens.primaryBridge(), address(g.bridge2));
        assertTrue(c.vaultLens.exitsOpen() && c.doorLens.exitsOpen(), "both read OPEN");
        assertFalse(c.vaultLens.bridgeEnabled(address(c.bridge)), "the front door's rail, off the vault");
        assertFalse(c.doorLens.bridgeKnown(address(g.bridge2)), "the vault's rail, unknown to the front door");
        assertEq(handler.undeliveredBy(2), 1, "the launch batch was not delivered: a rail the vault does not take");
        assertEq(handler.undeliveredWhy(2), bytes4(0), "the rail filed it (the vault's NotBridge)");
        assertEq(handler.uncreditedBy(2), 1, "the payout was not credited: a rail the front door does not know");
        assertEq(handler.uncreditedWhy(2), bytes4(0), "the rail filed it (the front door's NotBridge)");
        _assertAll();
    }

    /// I-28's gap on the other side: the front door activates bridge2 (7 days), tightens its batch value to bridge2's
    /// cap, disables its primary (a hold) and switches to bridge2: both read OPEN, and the vault, which never enabled
    /// bridge2, refuses every launch batch (NotBridge). The payout half is coherent and asserted: the vault's primary,
    /// the launch rail, is one the front door has disabled but knows, so its payouts are credited (the correction's
    /// half).
    function test_I28_aDoorSwitchToARailTheVaultNeverEnabled() public allProbes {
        handler.queueRedeem(_seed("redeem", 50, 9));
        assertEq(handler.redeemsQueued(), 1, "a payout batch to send");
        bytes memory activation = abi.encodeCall(CascadeBase.activateBridge, (address(g.bridge2)));
        handler.pinSchedule(D, activation);
        handler.pinExecute(D, activation, 1);
        handler.pinDirect(D, abi.encodeCall(CascadeFrontDoor.setMaxBatchValue, (1_000e18)));
        handler.pinDisable(D, 0, owner);
        handler.pinWarp(1);
        uint256 credited0 = handler.creditedBy(3);
        handler.pinSetPrimary(D, 1);
        assertEq(c.doorLens.primaryBridge(), address(g.bridge2));
        assertTrue(c.vaultLens.exitsOpen() && c.doorLens.exitsOpen(), "both read OPEN");
        assertFalse(c.vaultLens.bridgeEnabled(address(g.bridge2)), "the front door's rail, never enabled on the vault");
        assertFalse(c.doorLens.bridgeEnabled(address(c.bridge)), "the vault's rail, disabled on the front door");
        assertTrue(c.doorLens.bridgeKnown(address(c.bridge)), "and known to it");
        assertEq(handler.undeliveredBy(2), 1, "the launch batch was not delivered: a rail the vault does not take");
        assertEq(handler.creditedBy(3), credited0 + 1, "the payout through the vault's coherent rail was credited");
        assertEq(handler.payoutsThroughAKnownDisabledBridge(), 1, "through a bridge the front door knows, disabled");
        assertEq(handler.uncreditedBy(3), 0);
        _assertAll();
    }

    /// I-28 halfway through a two-sided rail switch (Task 39b's review, Minor 3; the correction's payout half): both
    /// targets activate bridge2 (7 days), the front door tightens its batch value to bridge2's cap, disables the launch
    /// rail (its own hold) and switches to bridge2; the vault, not switched yet, keeps the launch rail as its primary,
    /// which the front door has now disabled but still knows. The primaries differ and each half is coherent: a launch
    /// batch is delivered through bridge2, and a payout is credited through the launch rail.
    function test_I28_halfwayThroughATwoSidedSwitchEachHalfIsCoherent() public allProbes {
        handler.queueRedeem(_seed("redeem", 50, 9));
        assertEq(handler.redeemsQueued(), 1, "a payout batch to send");
        bytes memory activation = abi.encodeCall(CascadeBase.activateBridge, (address(g.bridge2)));
        handler.pinSchedule(V, activation);
        handler.pinSchedule(D, activation);
        handler.pinExecute(V, activation, 1);
        handler.pinExecute(D, activation, 1);
        handler.pinDirect(D, abi.encodeCall(CascadeFrontDoor.setMaxBatchValue, (1_000e18)));
        handler.pinDisable(D, 0, owner);
        handler.pinWarp(1);
        uint256 open0 = handler.openStates();
        uint256 deliveryHalves0 = handler.openByDeliveryClass(3);
        uint256 payoutHalves0 = handler.openByPayoutClass(3);
        uint256 delivered0 = handler.deliveredBy(3);
        uint256 credited0 = handler.creditedBy(3);
        handler.pinSetPrimary(D, 1);
        assertEq(c.doorLens.primaryBridge(), address(g.bridge2), "the front door on bridge2");
        assertEq(c.vaultLens.primaryBridge(), address(c.bridge), "the vault still on the launch rail");
        assertTrue(c.vaultLens.exitsOpen() && c.doorLens.exitsOpen(), "both read OPEN");
        assertTrue(c.vaultLens.bridgeEnabled(address(g.bridge2)), "the front door's rail, enabled on the vault");
        assertFalse(c.doorLens.bridgeEnabled(address(c.bridge)), "the vault's rail, disabled on the front door");
        assertTrue(c.doorLens.bridgeKnown(address(c.bridge)), "and known to it");
        assertEq(handler.openStates(), open0 + 1, "the state probed once");
        assertEq(handler.openByDeliveryClass(3), deliveryHalves0 + 1, "the delivery half: coherent (class 3)");
        assertEq(handler.openByPayoutClass(3), payoutHalves0 + 1, "the payout half: coherent (class 3)");
        assertEq(handler.deliveredBy(3), delivered0 + 1, "a launch batch delivered through bridge2");
        assertEq(handler.creditedBy(3), credited0 + 1, "a payout credited through the launch rail");
        assertEq(handler.payoutsThroughAKnownDisabledBridge(), 1, "through a bridge the front door knows, disabled");
        _assertAll();
    }

    /// I-28 beside the probe, the delivery half (Task 39b's review, Important 2: the probe exempts only its own half).
    /// The owner disables the vault's primary (its hold), switches the vault to the probe (the hold cleared) and
    /// reopens the launch rail on the vault (7 days). The vault's payout half is the probe's, untried; the front door
    /// still sends through the launch rail, enabled on both sides, so its delivery half is coherent and a launch batch
    /// closed then must be delivered. Random runs rarely reach this state (the switch leaves the launch rail disabled on
    /// the vault until its Reopen).
    function test_I28_besideTheProbeTheDeliveryHalfIsAsserted() public allProbes {
        handler.pinDisable(V, 0, owner);
        handler.pinWarp(1);
        handler.pinSetPrimary(V, 2);
        handler.pinWarp(1);
        bytes memory reopen = abi.encodeCall(CascadeBase.activateBridge, (address(c.bridge)));
        handler.pinSchedule(V, reopen);
        uint256 delivered0 = handler.deliveredBy(3);
        uint256 untried0 = handler.openByPayoutClass(4);
        handler.pinExecute(V, reopen, 1);
        assertEq(c.vaultLens.primaryBridge(), address(g.probe), "the vault on the probe");
        assertTrue(c.vaultLens.bridgeEnabled(address(c.bridge)), "the launch rail enabled on the vault again");
        assertTrue(c.vaultLens.exitsOpen() && c.doorLens.exitsOpen(), "both read OPEN");
        assertEq(handler.deliveredBy(3), delivered0 + 1, "a launch batch delivered through the launch rail");
        assertEq(handler.deliveriesBesideTheProbe(), 1, "a coherent delivery half beside the probe");
        assertEq(handler.openByPayoutClass(4), untried0 + 1, "the payout half, the probe's own, untried");
        _assertAll();
    }

    /// I-28 beside the probe, the payout half: a payout batch is queued, then the owner disables the front door's
    /// primary (its hold) and switches the front door to the probe (the hold cleared). The front door's delivery half is
    /// the probe's, untried; the vault still pays through the launch rail, which the front door has disabled but knows,
    /// so its payout half is coherent and the payout must be credited.
    function test_I28_besideTheProbeThePayoutHalfIsAsserted() public allProbes {
        handler.queueRedeem(_seed("redeem", 50, 9));
        assertEq(handler.redeemsQueued(), 1, "a payout batch to send");
        handler.pinDisable(D, 0, owner);
        handler.pinWarp(1);
        uint256 credited0 = handler.creditedBy(3);
        uint256 untried0 = handler.openByDeliveryClass(4);
        handler.pinSetPrimary(D, 2);
        assertEq(c.doorLens.primaryBridge(), address(g.probe), "the front door on the probe");
        assertFalse(c.doorLens.bridgeEnabled(address(c.bridge)), "the vault's rail, disabled on the front door");
        assertTrue(c.vaultLens.exitsOpen() && c.doorLens.exitsOpen(), "both read OPEN");
        assertEq(handler.creditedBy(3), credited0 + 1, "the payout through the launch rail was credited");
        assertEq(handler.payoutsBesideTheProbe(), 1, "a coherent payout half beside the probe");
        assertEq(handler.payoutsThroughAKnownDisabledBridge(), 1, "through a bridge the front door knows, disabled");
        assertEq(handler.openByDeliveryClass(4), untried0 + 1, "the delivery half, the probe's own, untried");
        _assertAll();
    }

    /// I-28 and the spec's own exception (spec section 3.6: "a contract reads OPEN with its primary disabled"): the
    /// guardian disables the front door's primary (its hold) and the owner's setGuardian, executed 8 days later, ends
    /// the hold (R1-B M-1) and leaves the primary disabled until its Reopen. Both read OPEN, and a launch batch's close
    /// is refused PrimaryBridgeDisabled (the delivery half's class 1).
    function test_I28_openWithThePrimaryDisabledAfterASwap() public allProbes {
        bytes memory swap = abi.encodeCall(CascadeBase.setGuardian, (guardian2));
        handler.pinSchedule(D, swap);
        handler.pinDisable(D, 0, guardian);
        handler.pinExecute(D, swap, 1);
        assertTrue(c.vaultLens.exitsOpen() && c.doorLens.exitsOpen(), "both read OPEN");
        assertFalse(c.doorLens.bridgeEnabled(address(c.bridge)), "the front door's primary, still disabled");
        assertEq(handler.undeliveredBy(1), 1, "the launch batch was not delivered");
        assertEq(handler.undeliveredWhy(1), bytes4(keccak256("PrimaryBridgeDisabled()")), "the close refused");
        _assertAll();
    }

    // I-26, each way back pinned (the campaign draws among them; `_path`'s `r` names the draw, see probeOwnerPath).
    uint256 constant UNPAUSE = 1 << 0;
    uint256 constant SWITCH = 1 << 1;
    uint256 constant BRIDGE_REOPEN = 1 << 2;
    uint256 constant DOOR_REOPEN = 1 << 3;
    uint256 constant SWAP = 1 << 4;
    uint256 constant SWAP_AFTER = 1 << 5;

    /// A guardian's pause: the owner's unpause, alone.
    function test_I26_aPauseNeedsOnlyTheUnpause() public allProbes {
        handler.pinPause(V, guardian);
        _path(0, UNPAUSE);
        _assertAll();
    }

    /// The owner's disable of the vault's primary: a switch to another enabled bridge within its cap (the probe), or
    /// the primary's Reopen (7 days).
    function test_I26_anOwnerBridgeHoldNeedsASwitchOrTheReopen() public allProbes {
        handler.pinDisable(V, 0, owner);
        _path(0, SWITCH);
        _path(1 << 2, BRIDGE_REOPEN);
        _assertAll();
    }

    /// The owner's removal of the launch door (the launch chain's last): only its Reopen (7 days).
    function test_I26_anOwnerDoorHoldNeedsTheDoorsReopen() public allProbes {
        handler.pinRemove(0, owner);
        _path(0, DOOR_REOPEN);
        _path(1 << 24, DOOR_REOPEN);
        _assertAll();
    }

    /// The guardian's removal of the launch door: the swap to the sitting guardian (8 days); with an owner-removed
    /// second launch-chain door, that door's Reopen too (7 days: it clears the hold whoever made it).
    function test_I26_aGuardianDoorHoldNeedsTheSwapOrARemovedDoorsReopen() public allProbes {
        bytes memory door3 = abi.encodeCall(CascadeVault.activateFrontDoor, (BASE, g.door3));
        handler.pinSchedule(V, door3);
        handler.pinExecute(V, door3, 1);
        handler.pinRemove(1, owner);
        handler.pinWarp(1);
        handler.pinRemove(0, guardian);
        assertEq(uint8(c.vaultLens.launchDoorRemovedBy()), uint8(Actor.Guardian));
        _path(0, DOOR_REOPEN);
        _path(1 << 20, SWAP);
        _assertAll();
    }

    /// Both actors' holds at once: the owner's disable of the vault's primary and the guardian's removal of the launch
    /// door. The swap needs no owner hold, so with the primary's Reopen chosen it waits for that Reopen to run (the two
    /// phases: 7 days, then 8); with the switch, it is scheduled at once.
    function test_I26_aSwapAnOwnerHoldKeepsBackWaitsForTheReopen() public allProbes {
        handler.pinDisable(V, 0, owner);
        handler.pinWarp(1);
        handler.pinRemove(0, guardian);
        _path(1 << 2, BRIDGE_REOPEN | SWAP_AFTER);
        _path(0, SWITCH | SWAP);
        _assertAll();
    }

    /// The owner's path with the choices `r`, which must run, reach OPEN and take exactly the parts `want`.
    function _path(uint256 r, uint256 want) internal {
        (bool ran, bool open, uint256 mask) = handler.probeOwnerPath(r);
        assertTrue(ran, "the owner's way back ran");
        assertTrue(open, "the owner's way back reached OPEN");
        assertEq(mask, want, "the path's parts");
    }

    /// I-27, committed: the owner schedules setGuardian(guardian2) on the vault; one second before its readyAt the
    /// guardian pauses the vault, disables its primary, removes the launch door (the launch chain's last: its hold) and
    /// tries to cancel the swap (NotCanceller); the swap runs at exactly its readyAt and ends the guardian's door and
    /// bridge holds (the pause stays, the owner's to lift).
    function test_I27_aGuardianStormBeforeTheSwapDelaysNothing() public allProbes {
        bytes memory swap = abi.encodeCall(CascadeBase.setGuardian, (guardian2));
        handler.pinSchedule(V, swap);
        uint64 readyAt = c.vaultLens.scheduled(keccak256(swap)).readyAt;
        handler.pinWarp(readyAt - 1 - vm.getBlockTimestamp());
        handler.pinPause(V, guardian);
        handler.pinDisable(V, 0, guardian);
        handler.pinRemove(0, guardian);
        handler.pinCancel(V, swap, guardian);
        assertEq(handler.cancelsRefusedGuardian(), 1, "the guardian cannot cancel a swap");
        assertGt(handler.swapProbes(), 0, "the probe ran the swap through a storm");
        assertGt(handler.swapProbesJustBeforeReady(), 0);
        handler.pinExecute(V, swap, 1);
        assertEq(vm.getBlockTimestamp(), readyAt, "at its readyAt, from its schedule");
        assertEq(c.vaultLens.guardian(), guardian2);
        assertEq(uint8(c.vaultLens.primaryDisabledBy()), uint8(Actor.None), "the guardian's bridge hold ended");
        assertEq(uint8(c.vaultLens.launchDoorRemovedBy()), uint8(Actor.None), "the guardian's door hold ended");
        assertEq(uint8(c.vaultLens.pausedBy()), uint8(Actor.Guardian), "the pause stays, the owner's to lift");
        _assertAll();
    }

    /// T7 B3: an activation of an active door or an enabled bridge is refused at schedule (AlreadyActive), and once an
    /// activation is pending nothing else can activate its target (one calldata, one id), so the checks see pending
    /// activations and none names an active target; the setter's AlreadyActive at execute never occurs.
    function test_aPendingActivationNeverNamesAnActiveTarget() public allProbes {
        handler.pinSchedule(V, abi.encodeCall(CascadeVault.activateFrontDoor, (BASE, address(c.fd))));
        handler.pinSchedule(V, abi.encodeCall(CascadeBase.activateBridge, (address(c.bridge))));
        assertEq(handler.schedulesRefused(), 2, "AlreadyActive at schedule, twice");
        bytes memory door2 = abi.encodeCall(CascadeVault.activateFrontDoor, (SECOND_CHAIN, g.door2));
        bytes memory bridge2 = abi.encodeCall(CascadeBase.activateBridge, (address(g.bridge2)));
        handler.pinSchedule(V, door2);
        handler.pinSchedule(D, bridge2);
        assertGt(handler.pendingActivationChecks(), 0, "the pending activations were checked");
        handler.pinExecute(V, door2, 1);
        handler.pinExecute(D, bridge2, 1);
        assertEq(handler.executesRefusedSetter(), 0, "no AlreadyActive at execute");
        _assertAll();
    }
}

/// @dev I-26 (spec §3.6), the owner's way back, with only its probe on: from every state the instruments create, the
/// owner's own calls reach OPEN on both targets, with no guardian action and no redeploy: after every step, in a
/// snapshot, the vault's unpause, each owner hold cleared (a switch to another enabled bridge within its cap, the
/// primary's Reopen, a Removed launch-chain door's Reopen), then each guardian hold (setGuardian to the sitting
/// guardian, or the same Reopen or switch), waiting each item's delay in time and in blocks; every call judged; both
/// lenses then read OPEN.
contract GovernanceLivenessI26Test is LivenessWorld {
    function setUp() public {
        setUpLiveness(PROBE_OWNER_PATH);
    }

    function invariant_ownerReachesOpen() public view {
        _assertOwnerReachesOpen();
    }

    /// @dev The probe's reach: the paths' parts and combinations, the holds probed, the classes the paths reached;
    /// asserts nothing.
    function invariant_reachabilityLogged() public {
        string[6] memory parts = ["unpause", "switch", "bridgeReopen", "doorReopen", "swap", "swapAfterReopen"];
        uint256[6] memory counts = handler.pathCounts();
        for (uint256 k; k < 6; ++k) {
            emit log_named_uint(string.concat("path.", parts[k]), counts[k]);
        }
        uint256[64] memory masks = handler.pathMasks();
        for (uint256 m; m < 64; ++m) {
            if (masks[m] != 0) emit log_named_uint(string.concat("pathMask.", vm.toString(m)), masks[m]);
        }
        string[8] memory held = [
            "pausedByOwner",
            "pausedByGuardian",
            "vaultBridgeByOwner",
            "vaultBridgeByGuardian",
            "launchDoorByOwner",
            "launchDoorByGuardian",
            "doorBridgeByOwner",
            "doorBridgeByGuardian"
        ];
        uint256[8] memory states = handler.heldStateCounts();
        for (uint256 k; k < 8; ++k) {
            emit log_named_uint(string.concat("held.", held[k]), states[k]);
        }
        string[5] memory classes = ["launchDoorOut", "primaryDisabled", "railNotTaken", "coherent", "probeRail"];
        for (uint256 k; k < 5; ++k) {
            emit log_named_uint(string.concat("pathEndsByClass.", classes[k]), handler.pathEndsByClass(k));
        }
        emit log_named_uint("ownerPathProbes", handler.ownerPathProbes());
        emit log_named_uint("ownerPathsAlreadyOpen", handler.ownerPathsAlreadyOpen());
        _logActions();
    }
}

/// @dev I-27, with only its probe on: a guardian's pause, disable, removal or cancel never delays setGuardian: every
/// pending swap the owner's clock has not killed, under no owner hold, runs at exactly its readyAt (measured from its
/// schedule) after the guardian played every instrument on both targets one second before, its cancel of the swap
/// itself included, and ends the guardian's holds; with none pending, the owner's schedule under such a storm is
/// admitted and runs eight days later through a second one; and a single guardian instrument a moment before a
/// pending swap's readyAt (the committed action) delays nothing.
contract GovernanceLivenessI27Test is LivenessWorld {
    function setUp() public {
        setUpLiveness(PROBE_SWAP);
    }

    function invariant_guardianNeverDelaysItsReplacement() public view {
        _assertGuardianNeverDelays();
    }

    /// @dev The probe's reach; asserts nothing.
    function invariant_reachabilityLogged() public {
        emit log_named_uint("swapProbes", handler.swapProbes());
        emit log_named_uint("swapProbesJustBeforeReady", handler.swapProbesJustBeforeReady());
        emit log_named_uint("swapProbesUnderOwnerHold", handler.swapProbesUnderOwnerHold());
        emit log_named_uint("swapSchedulesUnderStorm", handler.swapSchedulesUnderStorm());
        _logActions();
    }
}

/// @dev I-28 (spec §3.6, as Task 39b's ruling words it), with only its probe on: while both targets read OPEN under
/// the mock rails, each half judged on its own rail: a launch batch closed as soon as it can close is delivered while
/// the front door's rail is coherent (the launch door active on the vault, the front door's primary enabled on the
/// front door and on the vault), and a payout batch sent as soon as it is due is credited at the front door while the
/// vault's rail is coherent (the launch door active, the vault's primary enabled on the vault and known to the front
/// door); in a snapshot after every step. OPEN alone implies none of these (spec §3.6, after a swap; the one-sided rail
/// switch, the residual below section 5's table): a half in another class is tried and counted, not asserted, and a
/// half whose primary is the probe (not a rail) goes untried (the test_I28 pins).
contract GovernanceLivenessI28Test is LivenessWorld, TokenAccounting {
    function setUp() public {
        setUpLiveness(PROBE_LIVENESS);
    }

    /// @dev I-28, and I-34's token accounting with it (Task 42, the Task 39b re-review's Minor 1): this family's probe is
    /// the one that moves tokens (a batch delivered, a payout credited, each in a snapshot), so a probe that left a log
    /// undropped or state unreverted fails here at random, not in the pins alone.
    function invariant_twoChainLiveness() public view {
        _assertTwoChainLiveness();
        _assertTokenAccounting(handler, c.vault);
    }

    /// @dev The probe's reach, each half by its class; asserts nothing.
    function invariant_reachabilityLogged() public {
        emit log_named_uint("openStates", handler.openStates());
        string[5] memory classes = ["launchDoorOut", "primaryDisabled", "railNotTaken", "coherent", "probeRail"];
        for (uint256 k; k < 5; ++k) {
            emit log_named_uint(string.concat("openByDeliveryClass.", classes[k]), handler.openByDeliveryClass(k));
            emit log_named_uint(string.concat("openByPayoutClass.", classes[k]), handler.openByPayoutClass(k));
            emit log_named_uint(string.concat("deliveredBy.", classes[k]), handler.deliveredBy(k));
            emit log_named_uint(string.concat("undeliveredBy.", classes[k]), handler.undeliveredBy(k));
            emit log_named_uint(string.concat("creditedBy.", classes[k]), handler.creditedBy(k));
            emit log_named_uint(string.concat("uncreditedBy.", classes[k]), handler.uncreditedBy(k));
            emit log_named_bytes32(string.concat("undeliveredWhy.", classes[k]), bytes32(handler.undeliveredWhy(k)));
            emit log_named_bytes32(string.concat("uncreditedWhy.", classes[k]), bytes32(handler.uncreditedWhy(k)));
        }
        emit log_named_uint("emptyBatches", handler.emptyBatches());
        emit log_named_uint("noPayoutBatch", handler.noPayoutBatch());
        emit log_named_uint("deliveriesBesideTheProbe", handler.deliveriesBesideTheProbe());
        emit log_named_uint("payoutsBesideTheProbe", handler.payoutsBesideTheProbe());
        emit log_named_uint("payoutsThroughAKnownDisabledBridge", handler.payoutsThroughAKnownDisabledBridge());
        _logActions();
    }
}

/// @dev Spec §3.6 (round 6 L-2, T7 B3), with only its probe on: no pending activation ever names an active door or an
/// enabled bridge, read from the contracts over every id either scheduler ever logged; so the setters' AlreadyActive
/// at execute is unreachable.
contract GovernanceLivenessActivationTest is LivenessWorld {
    function setUp() public {
        setUpLiveness(PROBE_ACTIVATION);
    }

    function invariant_noPendingActivationOfAnActiveTarget() public view {
        _assertNoPendingActivation();
    }

    /// @dev The probe's reach; asserts nothing.
    function invariant_reachabilityLogged() public {
        emit log_named_uint("pendingActivationChecks", handler.pendingActivationChecks());
        emit log_named_uint("activationsNew", handler.activationsNew());
        emit log_named_uint("activationsKnown", handler.activationsKnown());
        emit log_named_uint("bridgeActivationsKnown", handler.bridgeActivationsKnown());
        _logActions();
    }
}
