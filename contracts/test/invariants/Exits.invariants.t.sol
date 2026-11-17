// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {AdaptersFixture} from "../adapters/AdaptersFixture.sol";
import {ReentrantRecipient} from "../mocks/ReentrantRecipient.sol";
import {DoorInternals} from "../utils/DoorInternals.sol";
import {VaultInternals} from "../utils/VaultInternals.sol";
import {BoundaryInvariants} from "./BoundaryInvariants.sol";
import {MinimumHits} from "./MinimumHits.sol";
import {AdapterHandler} from "./handlers/AdapterHandler.sol";
import {ExitHandler} from "./handlers/ExitHandler.sol";
import {TrackedHandler} from "./handlers/TrackedHandler.sol";

/// @dev The exits campaign (Task 42, the stuck-money review's invariant; spec §3.5): every claim has a non-owner exit.
/// ExitHandler's actions over AdaptersFixture's world (AdapterHandler's honest actions: the door's deposits, requests,
/// closes and claims, both lanes relayed, the vault paused, the stake swapped away, ForeverMoney short, held,
/// migrating, the floor raised, the reserves drained, time, every park function by anyone; and the users' own
/// direct exits and the Bittensor EOA's deposits), with the probe: one blocker drawn and applied in a snapshot, the
/// non-owner routine, and every holding left judged against the table in ExitHandler's notes (and the README's "Exit
/// liveness"), asserted exactly. Beside it the two burn rules every delivery is read for (S-H1: no burn behind a
/// closed rail; S-L1: no unredeemable remainder). Inherits BoundaryInvariants: lens parity on both lenses and token
/// accounting after every step.
contract ExitsInvariantTest is AdaptersFixture, BoundaryInvariants, MinimumHits {
    /// This contract's creations in AdaptersFixture's setUp, then the recipient actor's: the handler is the next, the
    /// keeper the fixture names at deploy (as the adapter campaign's).
    uint256 constant FIXTURE_CREATIONS = 14;

    ExitHandler handler;
    ReentrantRecipient actor;

    function newVault(CascadeVault.Params memory p) internal virtual override returns (CascadeVault) {
        return new VaultInternals(p);
    }

    function newDoor(CascadeFrontDoor.Params memory p) internal override returns (CascadeFrontDoor) {
        p.depositCap = 1_000_000e18;
        return new DoorInternals(p);
    }

    function setUp() public override {
        keeper = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + FIXTURE_CREATIONS + 1);
        super.setUp();
        actor = new ReentrantRecipient();
        handler = new ExitHandler(
            TrackedHandler.System(VaultInternals(payable(address(vault))), vaultLens, fd, doorLens, owner, guardian),
            AdapterHandler.Parts(
                taoBase,
                taoBit,
                routerBase,
                routerBit,
                adapterBase,
                adapterBit,
                av,
                actor,
                treasury,
                BASE,
                BITTENSOR,
                BASE_SELECTOR,
                BITTENSOR_SELECTOR
            )
        );
        require(address(handler) == keeper, "the handler did not land where the fixture named the keeper");
        // CCIP executes a delivered message once (MockRouter's opt-in; defence in depth beside the forged-to-Base rule)
        routerBase.setExactlyOnce(true);
        routerBit.setExactlyOnce(true);
        setBoundary(
            handler, VaultInternals(payable(address(vault))), DoorInternals(payable(address(fd))), vaultLens, doorLens
        );
        // the deploy's reserves (spec §7): the native reserve to RESERVE_TARGET, the token cushion booked through
        // fundCushion (R4 F-1)
        adapterBit.fundReserve{value: adapterBit.RESERVE_TARGET() - ED}();
        taoBit.mint(address(this), adapterBit.TOKEN_RESERVE_TARGET());
        taoBit.approve(address(adapterBit), adapterBit.TOKEN_RESERVE_TARGET());
        adapterBit.fundCushion(adapterBit.TOKEN_RESERVE_TARGET());
        // pays every close's bridge fee
        vm.deal(address(handler), 1_000 ether);

        bytes4[] memory selectors = new bytes4[](28);
        selectors[0] = AdapterHandler.deposit.selector;
        selectors[1] = AdapterHandler.requestRedeem.selector;
        selectors[2] = AdapterHandler.closeBatch.selector;
        selectors[3] = AdapterHandler.claim.selector;
        selectors[4] = AdapterHandler.relayToBittensor.selector;
        selectors[5] = AdapterHandler.relayToBase.selector;
        selectors[6] = AdapterHandler.stakeIdle.selector;
        selectors[7] = AdapterHandler.processPayouts.selector;
        selectors[8] = AdapterHandler.pauseVault.selector;
        selectors[9] = AdapterHandler.swapAway.selector;
        selectors[10] = AdapterHandler.fmRoundShort.selector;
        selectors[11] = AdapterHandler.fmPause.selector;
        selectors[12] = AdapterHandler.fmMigrate.selector;
        selectors[13] = AdapterHandler.raiseFloor.selector;
        selectors[14] = AdapterHandler.drainCushion.selector;
        selectors[15] = AdapterHandler.warp.selector;
        selectors[16] = AdapterHandler.deliverParked.selector;
        selectors[17] = AdapterHandler.refundParked.selector;
        selectors[18] = AdapterHandler.dropParked.selector;
        selectors[19] = AdapterHandler.doorRound.selector;
        selectors[20] = ExitHandler.directExit.selector;
        selectors[21] = ExitHandler.taoDeposit.selector;
        selectors[22] = ExitHandler.taoExit.selector;
        selectors[23] = ExitHandler.probeExits.selector;
        selectors[24] = ExitHandler.probeExits.selector;
        selectors[25] = ExitHandler.relayShortGas.selector;
        selectors[26] = ExitHandler.nearTheEntryLimit.selector;
        selectors[27] = ExitHandler.crowdTheAllowance.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ---- exit liveness ----

    /// @dev Every claim has a non-owner exit (the stuck-money review's I-36 proposal, "exit liveness"): from every
    /// state the run reaches, with one more blocker applied (none, the vault paused, the door paused, the launch door
    /// removed by the owner or the guardian, either primary disabled, ForeverMoney held, announcing or finished, the
    /// stake swapped or lost, the chain's minimum raised, the cushion drained), the users, anyone and the keeper's
    /// routine work alone get every user's money out within about 19 days, but what the table's closers hold; and the
    /// table holds nothing that got out: under a closer that holds a whole kind, that kind of holding never falls (its
    /// rows are exactly what the contracts do). What got out reached its own user (its wallet rose by it, with its
    /// request fees, less the stated rounding); no burn left a user shares under MIN_REDEEM_VALUE the table would call
    /// its own choice; and a clean probe needs no refusal model to explain a holding.
    function invariant_everyClaimHasANonOwnerExit() public view {
        assertEq(
            handler.exitFailures(),
            0,
            string.concat("money left with a path open: ", vm.toString(handler.lastExitFailure()))
        );
        assertEq(
            handler.tableOverclaims(),
            0,
            string.concat("the table held money that got out: ", vm.toString(handler.lastOverclaim()))
        );
        assertEq(
            handler.remainderFailures(),
            0,
            string.concat(
                "the routine burned shares down to under the minimum: ", vm.toString(handler.lastExitFailure())
            )
        );
        assertEq(
            handler.receiptShortfalls(),
            0,
            string.concat("money left a user but did not reach it: ", vm.toString(handler.lastReceiptShortfall()))
        );
        assertEq(handler.cleanModelExcuses(), 0, "a clean probe needed a refusal model to explain a holding");
        assertEq(handler.outsideReceipts(), 0, "a user's money reached anyone or the door's treasury");
    }

    /// @dev S-H1 (R4): no front-door redeem is burned while the vault's primary cannot send payouts (ForeverMoney
    /// paused, a migration announced or finished): it is deferred, so no share is burned into a queue that cannot be
    /// paid.
    function invariant_noBurnBehindAClosedRail() public view {
        assertEq(handler.burnsBehindAClosedRail(), 0, "a door redeem burned behind a closed rail");
    }

    /// @dev S-L1 (R4): a door burn of a holder that asked for all of its shares (none fresh) leaves it 0 or at least
    /// MIN_REDEEM_VALUE, never shares no door burns; and it leaves it shares only for a cause, the entry limit's worth
    /// burned or the day's allowance spent. Inside the probe's routine too.
    function invariant_noUnredeemableRemainder() public view {
        assertEq(handler.unredeemableRemainders(), 0, "a door burn left an unredeemable remainder");
        assertEq(handler.unexplainedClips(), 0, "a door burn clipped a full request with no cause");
    }

    /// @dev Every call refused only as its action and state predict (AdapterHandler's and ExitHandler's lists).
    /// The campaign also fails on any handler call that reverts (Task 34's M6, carried to Task 42: a call a handler does
    /// not wrap in a try, whose revert the fuzzer would otherwise drop): fail-on-revert for this invariant's campaign.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_noUnexpectedReverts() public view {
        assertEq(
            handler.unexpectedReverts(),
            0,
            string.concat("unexpected: ", string(abi.encodePacked(handler.lastUnexpected())))
        );
    }

    /// @dev The probe's reach (by scenario, by kind of holding left and got out, by what held it) and the users' own
    /// actions; asserts nothing.
    function invariant_reachabilityLogged() public {
        emit log_named_uint("probes", handler.probes());
        string[14] memory names = [
            "none",
            "vaultPaused",
            "doorPaused",
            "doorRemovedByOwner",
            "doorRemovedByGuardian",
            "vaultRailOff",
            "doorRailOff",
            "fmHeld",
            "fmNotice",
            "fmFinished",
            "stakeSwapped",
            "stakeLost",
            "floorRaised",
            "cushionShort"
        ];
        for (uint256 s; s < 14; ++s) {
            emit log_named_uint(string.concat("probes ", names[s]), handler.probesOf(s));
        }
        string[7] memory kinds = ["deposit", "parkTokens", "parkNative", "shares", "queued", "claimable", "inFlight"];
        for (uint256 k; k < 7; ++k) {
            emit log_named_uint(string.concat("left ", kinds[k]), handler.stuckOf(k));
            emit log_named_uint(string.concat("out ", kinds[k]), handler.outOf(k));
        }
        emit log_named_uint("stuckByPause", handler.stuckByPause());
        emit log_named_uint("stuckByDoorGone", handler.stuckByDoorGone());
        emit log_named_uint("stuckByVaultRail", handler.stuckByVaultRail());
        emit log_named_uint("stuckByDoorRail", handler.stuckByDoorRail());
        emit log_named_uint("stuckByStakeLost", handler.stuckByStakeLost());
        emit log_named_uint("stuckByRailClosed", handler.stuckByRailClosed());
        emit log_named_uint("stuckByRail", handler.stuckByRail());
        emit log_named_uint("stuckByWalk", handler.stuckByWalk());
        emit log_named_uint("stuckByAllowance", handler.stuckByAllowance());
        emit log_named_uint("stuckByOwnChoice", handler.stuckByOwnChoice());
        emit log_named_uint("stuckByClip", handler.stuckByClip());
        emit log_named_uint("cleanProbes", handler.cleanProbes());
        emit log_named_uint("shortGasFailures", handler.shortGasFailures());
        emit log_named_uint("failuresJudged", handler.failuresJudged());
        emit log_named_uint("entryClips", handler.entryClips());
        emit log_named_uint("allowanceHolds", handler.allowanceHolds());
        emit log_named_uint("keepsHeld", handler.keepsHeld());
        emit log_named_uint("coarseMints", handler.coarseMints());
        emit log_named_uint("keepDraws", handler.keepDraws());
        emit log_named_uint("allowanceDraws", handler.allowanceDraws());
        emit log_named_uint("smartWalletOuts", handler.smartWalletOuts());
        emit log_named_uint("burnsChecked", handler.burnsChecked());
        emit log_named_uint("fullRequestBurns", handler.fullRequestBurns());
        emit log_named_uint("deferralsWhileClosed", handler.deferralsWhileClosed());
        emit log_named_uint("directExits", handler.directExits());
        emit log_named_uint("directExitsRefused", handler.directExitsRefused());
        emit log_named_uint("taoDeposits", handler.taoDeposits());
        emit log_named_uint("taoExits", handler.taoExits());
        emit log_named_uint("cancelsTooSoon", handler.cancelsTooSoon());
        emit log_named_uint("cancelsWaived", handler.cancelsWaived());
        emit log_named_uint("cancelsWaivedPaused", handler.cancelsWaivedPaused());
        emit log_named_uint("cancelsWaivedPrimary", handler.cancelsWaivedPrimary());
        _logHitTotals();
    }

    // ---- B9 ----

    function _hitTag() internal pure virtual override returns (string memory) {
        return "exits";
    }

    /// The table's blockers, the probe and the deferrals, each with its minimum over 3,000 runs at depth 64
    /// (MinimumHits' rule: a quarter of the slowest seed's projection, from the seeds 7111, 7222 and 7333);
    /// queuedHeldChecks is the over-claim check's reach on queued entries (users whose queued holding a whole-kind
    /// closer held, from the start or the routine's first relay). The table's rows (the review's I-4): each kind of
    /// holding judged gone (outOf) and the native park and the queued payout judged held; the clean probes; the
    /// FAILUREs relayShortGas makes and the probes that judged one; the full requests the burn rules judged and their
    /// clips, the allowance's among them through its targeted draw (crowdTheAllowance, the fix round 3's I-1; the
    /// fixture's 100 TAO floor makes it rarer here than at the launch's limits). A minimum of 0 is logged, not
    /// asserted: the entry limit never clips at the fixture's 2,000 TAO, and the coarse mints (a supply of 0 over an
    /// orphan, the receipt check's pins) are rarer still. The routine's deposit cancels, refused CancelTooSoon as
    /// predicted (R11) and gone inside the five minutes because the door was paused or its primary disabled (R12,
    /// `cancelsWaived`, and by cause, `cancelsWaivedPaused` and `cancelsWaivedPrimary`), are carried out of the probe's
    /// snapshot; their minimums are from R12's seeds 9401-9403 at 128 x 64, by the same rule.
    function _hits() internal view virtual override returns (Hit[] memory h) {
        h = new Hit[](31);
        h[0] = Hit("probes", handler.probes(), 3171);
        h[1] = Hit("stuckByPause", handler.stuckByPause(), 1835);
        h[2] = Hit("stuckByDoorGone", handler.stuckByDoorGone(), 128);
        h[3] = Hit("stuckByVaultRail", handler.stuckByVaultRail(), 43);
        h[4] = Hit("stuckByDoorRail", handler.stuckByDoorRail(), 68);
        h[5] = Hit("stuckByStakeLost", handler.stuckByStakeLost(), 44);
        h[6] = Hit("stuckByRailClosed", handler.stuckByRailClosed(), 153);
        h[7] = Hit("stuckByRail", handler.stuckByRail(), 128);
        h[8] = Hit("smartWalletOuts", handler.smartWalletOuts(), 97);
        h[9] = Hit("deferralsWhileClosed", handler.deferralsWhileClosed(), 710);
        h[10] = Hit("queuedHeldChecks", handler.queuedHeldChecks(), 15);
        _rowHits(h, 11, [uint256(457), 1271, 876, 1653, 2, 147, 409, 704, 144, 60, 97, 71, 360, 0, 5]);
        h[26] = Hit("coarseMints", handler.coarseMints(), 0);
        // the routine's cancels (R11, R12), refused and waived, and the waiver by its cause (the pause, the disabled
        // primary): MinimumHits' rule from R12's seeds 9401-9403 at 128 x 64, the lowest of its two full sweeps' and the
        // exits-only runs' (slowest projections 1,177, 141, 70 and 57)
        h[27] = Hit("cancelsTooSoon", handler.cancelsTooSoon(), 294);
        h[28] = Hit("cancelsWaived", handler.cancelsWaived(), 35);
        h[29] = Hit("cancelsWaivedPaused", handler.cancelsWaivedPaused(), 17);
        h[30] = Hit("cancelsWaivedPrimary", handler.cancelsWaivedPrimary(), 14);
    }

    /// The table's rows (see _hits), at h[from] on: 15 states, with each contract's minimums `m`.
    function _rowHits(Hit[] memory h, uint256 from, uint256[15] memory m) internal view {
        h[from] = Hit("outDeposit", handler.outOf(0), m[0]);
        h[from + 1] = Hit("outParkTokens", handler.outOf(1), m[1]);
        h[from + 2] = Hit("outParkNative", handler.outOf(2), m[2]);
        h[from + 3] = Hit("outShares", handler.outOf(3), m[3]);
        h[from + 4] = Hit("outQueued", handler.outOf(4), m[4]);
        h[from + 5] = Hit("outClaimable", handler.outOf(5), m[5]);
        h[from + 6] = Hit("outInFlight", handler.outOf(6), m[6]);
        h[from + 7] = Hit("leftParkNative", handler.stuckOf(2), m[7]);
        h[from + 8] = Hit("leftQueued", handler.stuckOf(4), m[8]);
        h[from + 9] = Hit("cleanProbes", handler.cleanProbes(), m[9]);
        h[from + 10] = Hit("shortGasFailures", handler.shortGasFailures(), m[10]);
        h[from + 11] = Hit("failuresJudged", handler.failuresJudged(), m[11]);
        h[from + 12] = Hit("fullRequestBurns", handler.fullRequestBurns(), m[12]);
        h[from + 13] = Hit("entryClips", handler.entryClips(), m[13]);
        h[from + 14] = Hit("allowanceHolds", handler.allowanceHolds(), m[14]);
    }

    // ---- pins ----

    function _assertAll() internal view {
        invariant_everyClaimHasANonOwnerExit();
        invariant_noBurnBehindAClosedRail();
        invariant_noUnredeemableRemainder();
        invariant_noUnexpectedReverts();
        invariant_tokenAccounting();
    }

    /// The handler's seeds, decoded (AdapterHandler's notes): actor `a`'s deposit of `taos` whole TAO (1 to 50).
    function _deposit(uint256 a, uint256 taos) internal {
        handler.deposit(3 + a, taos * 1e9);
    }

    /// Three holders' shares (the smart wallet's among them) and the Bittensor EOA's, a day old; then the probe under
    /// every scenario: each gets everything out or the table names what holds it, and with no blocker every user
    /// gets everything out.
    function test_everyScenarioIsJudgedByTheTable() public {
        _deposit(0, 5);
        _deposit(1, 4);
        _deposit(2, 3);
        handler.closeBatch(0);
        handler.relayToBittensor(0, 0);
        handler.taoDeposit(2e9);
        handler.stakeIdle();
        handler.warp(4);
        for (uint256 s; s < 14; ++s) {
            handler.probeExits(s);
        }
        assertEq(handler.probes(), 14);
        assertGt(handler.outOf(3), 0, "shares got out");
        assertGt(handler.smartWalletOuts(), 0, "the smart wallet got out");
        assertGt(handler.stuckByPause(), 0, "the vault's pause held shares (owner-only)");
        assertGt(handler.stuckByDoorGone(), 0, "the removed door held the smart wallet's shares (owner-only)");
        _assertAll();
    }

    /// S-H1 through the handler: ForeverMoney's migration announced, a request closed and delivered: deferred, no burn;
    /// and the probe judges the smart wallet's shares held by the closed rail.
    function test_aRedeemInAMigrationNoticeIsDeferredNotBurned() public {
        _deposit(1, 4);
        handler.closeBatch(0);
        handler.relayToBittensor(0, 0);
        handler.warp(4);
        handler.fmMigrate(0);
        assertTrue(av.migrationReadyAt() != 0, "the notice");
        handler.requestRedeem(1 + 3 * 4, 0);
        handler.closeBatch(0);
        handler.relayToBittensor(1, 0);
        assertEq(handler.deferralsWhileClosed(), 1, "a redeem-carrying delivery while the rail was closed");
        assertGt(vault.balanceOf(handler.actors(1)), 0, "deferred: the shares stay");
        handler.probeExits(0);
        assertGt(handler.stuckByRailClosed(), 0, "the closed rail holds the smart wallet's shares");
        _assertAll();
    }

    /// The door's primary disabled holds no queued payout (the table's queued row: a payout already queued is sent by
    /// the vault's primary and credited by the door from any known bridge, a disabled one included): the smart
    /// wallet's request burned and queued, then the probe under that scenario gets it out, and the over-claim check
    /// holds the queued kind to that (a table that named the door's primary among the queued row's closers fails it).
    function test_aDisabledDoorPrimaryHoldsNoQueuedPayout() public {
        _deposit(1, 5);
        handler.closeBatch(0);
        handler.relayToBittensor(0, 0);
        handler.warp(4);
        handler.requestRedeem(1 + 3 * 4, 0);
        handler.closeBatch(0);
        handler.relayToBittensor(1, 0);
        assertEq(handler.burnsChecked(), 1, "burned and queued");
        handler.probeExits(6);
        assertGt(handler.outOf(4), 0, "the queued payout got out under the door's primary disabled");
        _assertAll();
    }

    /// A FAILURE: a batch in flight delivered with too little gas stays in CCIP FAILURE, nothing moved; the probe
    /// judges the holding in it and anyone's re-execution gets the money out.
    function test_aShortGasRelayIsAFailureAnyoneReExecutes() public {
        _deposit(1, 5);
        handler.closeBatch(0);
        handler.relayShortGas(0);
        assertEq(handler.shortGasFailures(), 1, "the batch is in FAILURE");
        handler.probeExits(0);
        assertEq(handler.failuresJudged(), 1, "the probe judged the money in it");
        assertGt(handler.outOf(6), 0, "anyone's re-execution got it out");
        _assertAll();
    }

    /// The receipt check can fail: with the routine's claims moved to a stranger once claimed, the smart wallet's money
    /// leaves its holdings without reaching its wallet.
    function test_theReceiptCheckCanFail() public {
        _deposit(1, 5);
        handler.closeBatch(0);
        handler.relayToBittensor(0, 0);
        handler.warp(4);
        handler.setDivertClaims(true);
        handler.probeExits(0);
        assertGt(handler.receiptShortfalls(), 0, "the diverted claim is a shortfall");
        assertGt(handler.outsideReceipts(), 0, "and it reached anyone");
        vm.expectRevert();
        this.everyClaimExternal();
    }

    /// The long run's counterexample (8d05725, 3,000 x 64, seed 20261113, shrunk to 7 calls): the Bittensor EOA, the
    /// only holder, is staked; a validator's swap leaves the stake missing; the BEs' and the smart wallet's door
    /// deposits park; the EOA exits everything with consent at the floor price, forfeiting its staked share. In the
    /// probe anyone lists the swapped hotkey: a supply of 0 holds that stake, a share is worth it over the 1e6 virtual
    /// shares, and the parks' mints each round to whole shares. What reaches each user is its deposit less at most one
    /// share's value, which the receipt check allows.
    function test_aMintOverAnOrphanAtASupplyOf0RoundsAtOneSharesValue() public {
        handler.taoDeposit(9800450678868829659210289356008853151887639838057040138656508061769399456);
        handler.stakeIdle();
        handler.taoDeposit(761187366059345702);
        handler.swapAway();
        handler.doorRound(2022149146269282470255155564765458770089192023638);
        handler.taoExit(96, 3594900161);
        handler.probeExits(20321);
        assertGt(handler.coarseMints(), 0, "the parks minted at a coarse share price");
        _assertAll();
    }

    /// The re-review's N-1: the smart wallet's own partial request (all but 0.2% of its shares), closed before a probe
    /// and delivered by its first relay, leaves it under MIN_REDEEM_VALUE: its own choice of what to ask, not a burn
    /// the routine made.
    function test_aPendingPartialRequestLeavesTheHoldersOwnRemainder() public {
        _deposit(1, 5);
        handler.closeBatch(0);
        handler.relayToBittensor(0, 0);
        handler.warp(4);
        uint256 bal = vault.balanceOf(handler.actors(1));
        handler.requestRedeem(4, bal - bal / 500);
        handler.closeBatch(0);
        handler.probeExits(0);
        assertEq(handler.remainderFailures(), 0, "its own partial request");
        _assertAll();
    }

    /// The judge can fail: with the routine's claims skipped, the smart wallet's door exit ends as a credit on Base
    /// left unclaimed, money left with a path open.
    function test_theJudgeCanFail() public {
        _deposit(1, 5);
        handler.closeBatch(0);
        handler.relayToBittensor(0, 0);
        handler.warp(4);
        handler.setSkipClaims(true);
        handler.probeExits(0);
        assertGt(handler.exitFailures(), 0, "credits left unclaimed are exit failures");
        vm.expectRevert();
        this.everyClaimExternal();
    }

    function everyClaimExternal() external view {
        invariant_everyClaimHasANonOwnerExit();
    }
}

/// @dev The exits campaign at the launch's exit limits (`ops/src/v32/settings.ts`: maxEntryValue 10 TAO,
/// minDailyOutflow 10 TAO), against the fixture's 2,000 TAO and 100 TAO (the review's I-3: there a full request almost
/// never clipped). Deposits of up to 50 TAO each now clip at the entry limit, and the day's allowance holds the rest:
/// every clip's cause, S-L1's keep and the table's last-round hold are judged as often as they happen. Everything else
/// is the exits campaign's, its pins included.
contract ExitsAtLaunchLimitsInvariantTest is ExitsInvariantTest {
    function newVault(CascadeVault.Params memory p) internal override returns (CascadeVault) {
        p.maxEntryValue = 10e18;
        p.minDailyOutflow = 10e18;
        // the launch's message cap (DefaultParams' withLaunchValues): payout chunks split at 15 TAO (the re-review's
        // M-7); not the launch's 44 TAO asset cap, which the campaign's deposits would hit
        p.maxMessageValue = 15e18;
        return super.newVault(p);
    }

    function _hitTag() internal pure override returns (string memory) {
        return "exitslaunch";
    }

    /// The exits campaign's rows, and the clips the launch's limits make, each with its minimum over 3,000 runs at
    /// depth 64 (MinimumHits' rule: a quarter of the slowest seed's projection, from the seeds 7111, 7222 and 7333),
    /// the allowance's holds through crowdTheAllowance (about 26 in 3,000 runs before it, now about 1,600 or more). A
    /// minimum of 0 is logged, not asserted: the coarse mints. The routine's deposit cancels as the exits campaign's
    /// (R11, R12).
    function _hits() internal view override returns (Hit[] memory h) {
        h = new Hit[](23);
        h[0] = Hit("probes", handler.probes(), 3127);
        h[1] = Hit("stuckByClip", handler.stuckByClip(), 115);
        h[17] = Hit("keepsHeld", handler.keepsHeld(), 430);
        h[18] = Hit("coarseMints", handler.coarseMints(), 0);
        // the routine's cancels (R11, R12), as the exits campaign's (slowest projections 926, 136, 65 and 64)
        h[19] = Hit("cancelsTooSoon", handler.cancelsTooSoon(), 231);
        h[20] = Hit("cancelsWaived", handler.cancelsWaived(), 34);
        h[21] = Hit("cancelsWaivedPaused", handler.cancelsWaivedPaused(), 16);
        h[22] = Hit("cancelsWaivedPrimary", handler.cancelsWaivedPrimary(), 16);
        _rowHits(h, 2, [uint256(441), 2084, 1523, 2169, 326, 391, 653, 1114, 1351, 71, 134, 75, 1774, 837, 396]);
    }

    /// The long run's counterexample at the launch's limits (8d05725, 3,000 x 64, seed 20261113, shrunk to 9 calls):
    /// as the exits campaign's pin, a supply of 0 over the 49 TAO a consenting sole holder forfeited, each park's mint
    /// rounding up to one share's value (about 49,000 rao here).
    function test_atTheLaunchLimitsAMintOverAnOrphanRoundsAtOneSharesValue() public {
        handler.drainCushion(18454891306030347167122084054300576333336);
        handler.taoDeposit(3400);
        handler.doorRound(79);
        handler.nearTheEntryLimit(0);
        handler.taoDeposit(180726932583174953040662197);
        handler.swapAway();
        handler.refundParked(12087182042749664269998284472, 1606723921292);
        handler.taoExit(80291530665000000000, 12121);
        handler.probeExits(10297608937042554516230705667381920982738046800753920341642047023519008197);
        assertGt(handler.coarseMints(), 0, "the parks minted at a coarse share price");
        _assertAll();
    }

    /// The rerun's counterexample at the launch's limits (dece524, 3,000 x 64, seed 20261113, shrunk to 8 calls): a
    /// swap moves 0.03 TAO, under the stake-missing tolerance (0.1% of 34.2 TAO booked); in the probe the smart
    /// wallet's shares go out at the door, then the other holders' direct exits shrink the booked stake to 14.9 TAO, so
    /// the same shortfall now counts as missing. Anyone relists the swapped hotkey at the next boundary and the rest
    /// goes out; and the table, which holds the smart wallet's shares to stake missing, is judged only from when it
    /// came on. Without the relist at every boundary (the routine's two relists before the rerun's fix: at its start
    /// and after its first warp) the smart wallet's last shares stay, held by stake missing (fix round 4, the review's
    /// I-3: this pin's last two checks fail so).
    function test_atTheLaunchLimitsStakeGoingMissingInTheRoutineIsRelisted() public {
        _theLaunchOverclaim();
        uint256 held = handler.stuckByStakeLost();
        uint256 outs = handler.smartWalletOuts();
        handler.probeExits(0);
        assertEq(handler.tableOverclaims(), 0, "no over-claim");
        assertEq(handler.stuckByStakeLost(), held, "nothing held by stake missing: the swapped hotkey relisted");
        assertGt(handler.smartWalletOuts(), outs, "the smart wallet's shares all went out");
        _assertAll();
    }

    /// The same, the chain's minimum raised above the 0.03 TAO the swap moved, so no one can relist it (NotEligible:
    /// I-6's stated precondition): the stuck state stays, the smart wallet's last shares held by stake missing as the
    /// table says (stuckByStakeLost), and the shares that went out before it came on are no over-claim.
    function test_atTheLaunchLimitsAnUnlistableSwapStaysHeldAsTheTableSays() public {
        _theLaunchOverclaim();
        staking.setMinStake(30_000_000);
        uint256 held = handler.stuckByStakeLost();
        handler.probeExits(0);
        assertGt(handler.stuckByStakeLost(), held, "the smart wallet's last shares held by stake missing");
        assertEq(handler.tableOverclaims(), 0, "no over-claim");
        assertEq(handler.exitFailures(), 0);
        _assertAll();
    }

    function _theLaunchOverclaim() internal {
        handler.nearTheEntryLimit(9488);
        handler.pauseVault(2140875);
        handler.pauseVault(12986951535286600595285787092153383601764310599570464276957845523739098514);
        handler.stakeIdle();
        handler.doorRound(1001929467127241738698920141107);
        handler.swapAway();
        handler.doorRound(11024759059368535244801131879787294291959897772148296176375264103296086216);
    }

    /// S-L1's keep through its targeted draw: the smart wallet topped up to 10.015 TAO and asking for all of it keeps
    /// 0.03 TAO, not 0.015.
    function test_atTheLaunchLimitsTheKeepDrawReachesSL1sKeep() public {
        handler.nearTheEntryLimit(0);
        assertEq(handler.keepDraws(), 1, "drawn");
        assertEq(handler.keepsHeld(), 1, "the clip kept the minimum");
        assertEq(handler.unredeemableRemainders(), 0);
        _assertAll();
    }

    /// The allowance's targeted draw (fix round 3, I-1): from an empty vault the windows allow the 10 TAO floor, so
    /// alice is topped up to 7.5 TAO and carol to 10.09; a day on, alice asks for 7.5 TAO's worth and carol for
    /// everything in one batch: alice burns whole, carol's request is clipped to the 2.5 TAO alice left and spends it,
    /// a clip the burn rules put down to the allowance.
    function test_atTheLaunchLimitsTheAllowanceDrawClipsAtTheAllowance() public {
        handler.crowdTheAllowance(0);
        assertEq(handler.allowanceDraws(), 1, "drawn");
        assertEq(handler.allowanceHolds(), 1, "the clip put down to the spent allowance");
        assertEq(handler.unexplainedClips(), 0);
        assertGt(vault.balanceOf(handler.actors(2)), 0, "carol keeps the rest");
        _assertAll();
    }

    /// The 32-seed sweep's counterexample at the launch's limits (seed 112, 128 x 64, shrunk to 4 calls): the
    /// allowance's draw leaves alice under a rao of shares (its top-up's extra rao; she asks for the draw's worth
    /// only), so her direct exit is refused ZeroAmount in all four of the probe's rounds; the last round's delivery,
    /// after her exit, lifts them to exactly a rao by bob's burn rounding, and at the end her direct path is open.
    /// The routine's last direct exits take it, as she would (before them, this pin's two checks fail so).
    function test_atTheLaunchLimitsARaoTheLastDeliveryLeavesGoesOutDirectly() public {
        handler.crowdTheAllowance(30030263919000000000);
        handler.doorRound(512);
        handler.doorRound(7936);
        handler.probeExits(type(uint256).max - 3);
        assertEq(handler.exitFailures(), 0, "no holding left with a path open");
        assertEq(handler.receiptShortfalls(), 0, "every user received what left its holdings");
        _assertAll();
    }

    /// At the launch's limits a full request of 30 TAO burns the entry limit's 10 and keeps the rest, for its cause;
    /// the probe gets the rest out over its rounds.
    function test_atTheLaunchLimitsAFullRequestClipsToTheEntryLimit() public {
        assertEq(vaultLens.maxEntryValue(), 10e18, "the launch's entry limit");
        _deposit(1, 30);
        handler.closeBatch(0);
        handler.relayToBittensor(0, 0);
        handler.warp(4);
        handler.requestRedeem(1 + 3 * 4, 0);
        handler.closeBatch(0);
        handler.relayToBittensor(1, 0);
        assertEq(handler.entryClips(), 1, "clipped to the entry limit");
        assertGt(vault.balanceOf(handler.actors(1)), 0, "the rest kept");
        handler.probeExits(0);
        assertGt(handler.outOf(3), 0, "the probe got the shares out");
        _assertAll();
    }
}
