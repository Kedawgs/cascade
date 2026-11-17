// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeBase} from "../../src/CascadeBase.sol";
import {CcipAdapterBase} from "../../src/adapters/CcipAdapterBase.sol";
import {CcipBaseAdapter} from "../../src/adapters/CcipBaseAdapter.sol";
import {CcipBittensorAdapter} from "../../src/adapters/CcipBittensorAdapter.sol";
import {IAlphaVault} from "../../src/interfaces/IAlphaVault.sol";
import {Schedule} from "../governance/Schedule.sol";
import {AdaptersFixture} from "../adapters/AdaptersFixture.sol";
import {ReentrantRecipient} from "../mocks/ReentrantRecipient.sol";
import {DoorInternals} from "../utils/DoorInternals.sol";
import {VaultInternals} from "../utils/VaultInternals.sol";
import {BoundaryInvariants} from "./BoundaryInvariants.sol";
import {FrontDoorInvariants} from "./FrontDoorInvariants.sol";
import {MinimumHits} from "./MinimumHits.sol";
import {AdapterHandler} from "./handlers/AdapterHandler.sol";
import {TrackedHandler} from "./handlers/TrackedHandler.sol";

/// @dev The adapter campaign (Task 38, spec §3.2; I-7 to I-11): random sequences of AdapterHandler's actions over
/// AdaptersFixture's two chains (the two CCIP adapters over two mock routers, ForeverMoney's alpha vault as deployed,
/// the vault and the front door as their test-only subclasses): the front door's deposits, redeem requests (redeem-only
/// batches among them), closes and claims; the re-entrant recipient actor's own batches through the Base adapter, to
/// itself or to the vault, sometimes twice; every message relayed as the lanes carry it (a FAILURE re-executed), the
/// actor's behaviour drawn at each call that reaches it (accepting, refusing, re-entering any park function before or
/// after refusing, two levels deep, bubbling the lock's refusal); the vault paused, its stake swapped away and back,
/// its payouts processed; ForeverMoney short, exact or in the adapter's favour, halted, migrating; the staking floor
/// raised; the reserves drained and funded; time past PARK_TIMEOUT; and deliverParked, refundParked, dropParked and
/// both sweeps by anyone. Inherits BoundaryInvariants (Task 34a: lens parity, token accounting after every step, the
/// fixed libraries in the setUp) and FrontDoorInvariants (the door's holdings across every refund, I-18 and I-21).
contract AdapterInvariantTest is AdaptersFixture, BoundaryInvariants, FrontDoorInvariants, MinimumHits {
    /// This contract's creations in AdaptersFixture's setUp (the two precompile mocks, both tokens and routers on
    /// each side, the alpha vault, both adapters, the vault, the front door, both lenses), then the recipient actor's:
    /// the handler is the next, the keeper the fixture names at deploy.
    uint256 constant FIXTURE_CREATIONS = 14;

    AdapterHandler handler;
    ReentrantRecipient actor;

    /// The vault and the front door as their test-only subclasses (lens parity, I-33). The door's deposit cap is far
    /// above what a run deposits.
    function newVault(CascadeVault.Params memory p) internal override returns (CascadeVault) {
        return new VaultInternals(p);
    }

    function newDoor(CascadeFrontDoor.Params memory p) internal override returns (CascadeFrontDoor) {
        p.depositCap = 1_000_000e18;
        return new DoorInternals(p);
    }

    function setUp() public override {
        // the handler is the vault's keeper and the front door's, named at deploy as the deployment names them
        keeper = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + FIXTURE_CREATIONS + 1);
        super.setUp();
        actor = new ReentrantRecipient();
        handler = new AdapterHandler(
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
        // the boundary invariants' targets; I-32's run-time half asserted here, once
        setBoundary(
            handler, VaultInternals(payable(address(vault))), DoorInternals(payable(address(fd))), vaultLens, doorLens
        );
        setFrontDoors(handler, IERC20(address(taoBase)), IERC20(address(usdcBase)));
        // the deploy's reserves (spec §7): the native reserve to RESERVE_TARGET, the token cushion to its target, booked
        // through fundCushion (R4 F-1)
        adapterBit.fundReserve{value: adapterBit.RESERVE_TARGET() - ED}();
        taoBit.mint(address(this), adapterBit.TOKEN_RESERVE_TARGET());
        taoBit.approve(address(adapterBit), adapterBit.TOKEN_RESERVE_TARGET());
        adapterBit.fundCushion(adapterBit.TOKEN_RESERVE_TARGET());
        _oldRail();
        // pays every close's bridge fee
        vm.deal(address(handler), 1_000 ether);

        bytes4[] memory selectors = new bytes4[](29);
        selectors[0] = AdapterHandler.deposit.selector;
        selectors[1] = AdapterHandler.requestRedeem.selector;
        selectors[2] = AdapterHandler.closeBatch.selector;
        selectors[3] = AdapterHandler.claim.selector;
        selectors[4] = AdapterHandler.strangerSend.selector;
        selectors[5] = AdapterHandler.relayToBittensor.selector;
        selectors[6] = AdapterHandler.relayToBase.selector;
        selectors[7] = AdapterHandler.stakeIdle.selector;
        selectors[8] = AdapterHandler.processPayouts.selector;
        selectors[9] = AdapterHandler.pauseVault.selector;
        selectors[10] = AdapterHandler.swapAway.selector;
        selectors[11] = AdapterHandler.fmRoundShort.selector;
        selectors[12] = AdapterHandler.fmPause.selector;
        selectors[13] = AdapterHandler.fmMigrate.selector;
        selectors[14] = AdapterHandler.raiseFloor.selector;
        selectors[15] = AdapterHandler.drainCushion.selector;
        selectors[16] = AdapterHandler.warp.selector;
        selectors[17] = AdapterHandler.probeLiveness.selector;
        selectors[18] = AdapterHandler.deliverParked.selector;
        selectors[19] = AdapterHandler.refundParked.selector;
        selectors[20] = AdapterHandler.dropParked.selector;
        selectors[21] = AdapterHandler.sweepSurplus.selector;
        selectors[22] = AdapterHandler.doorRound.selector;
        selectors[23] = AdapterHandler.forgedToBittensor.selector;
        selectors[24] = AdapterHandler.forgedToBase.selector;
        selectors[25] = AdapterHandler.forgedFromOldRail.selector;
        selectors[26] = AdapterHandler.forgedRedeemOnly.selector;
        selectors[27] = AdapterHandler.forgedSweep.selector;
        selectors[28] = AdapterHandler.reenterThroughTheRouter.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// The old rail (R4, the forged-message review): a second adapter pair over the same routers, its Base half known to
    /// the front door (activated, then disabled) and its Bittensor half disabled on the vault (activated, then
    /// disabled), each activation through the scheduler (7 days each), named to the handler for forgedFromOldRail.
    function _oldRail() internal {
        uint256 n = vm.getNonce(address(this));
        address pOldBase = vm.computeCreateAddress(address(this), n);
        address pOldBit = vm.computeCreateAddress(address(this), n + 1);
        CcipBaseAdapter oldBase = new CcipBaseAdapter(
            CcipAdapterBase.Config({
                router: address(routerBase),
                token: address(taoBase),
                localChainId: BASE,
                remoteChainId: BITTENSOR,
                remoteSelector: BITTENSOR_SELECTOR,
                remoteAdapter: pOldBit,
                gasBase: 1_000_000,
                gasPerEntry: 25_000,
                maxMessageValue: 5_000e18,
                treasury: treasury
            }),
            0.01e18
        );
        CcipBittensorAdapter oldBit = new CcipBittensorAdapter(
            CcipAdapterBase.Config({
                router: address(routerBit),
                token: address(taoBit),
                localChainId: BITTENSOR,
                remoteChainId: BASE,
                remoteSelector: BASE_SELECTOR,
                remoteAdapter: pOldBase,
                gasBase: 1_000_000,
                gasPerEntry: 25_000,
                maxMessageValue: 5_000e18,
                treasury: treasury
            }),
            IAlphaVault(address(av)),
            1_000_000,
            25_000
        );
        require(address(oldBase) == pOldBase && address(oldBit) == pOldBit, "the old rail's addresses");
        Schedule.run(fd, owner, abi.encodeCall(CascadeBase.activateBridge, (address(oldBase))));
        Schedule.run(vault, owner, abi.encodeCall(CascadeBase.activateBridge, (address(oldBit))));
        vm.prank(guardian);
        fd.disableBridge(address(oldBase));
        vm.prank(guardian);
        vault.disableBridge(address(oldBit));
        handler.setOldRail(oldBase, oldBit);
    }

    // ---- the invariants ----

    /// @dev The compromised lane (R4, the forged-message review): after every forged call (to either adapter or through
    /// the old rail, each lying about the amount, the tokens, the sender, the recipient or the message), no other park,
    /// the booked cushion, a queued payout batch, a claim, the open batch, the fee pot or the credits, and not the share
    /// price, moved beyond what the call itself carried (and the unswept surplus, the treasury's, it may take; F-1); the
    /// parks and the cushion stay covered; surplus moving to the immutable treasury (the sweep a reached recipient can
    /// set off) is no leak, and nothing else is allowed. A forged redeem's burn of the holders it names is F-2's stated
    /// residual (section 5), counted apart and never a leak. And every forged action ran its path: none reverted in the
    /// handler (the R4 review: copies toward Base once did, unseen).
    function invariant_aForgedMessageMovesNothingItDidNotCarry() public view {
        assertEq(
            handler.forgedLeaks(),
            0,
            string.concat(
                "a forged call moved what it did not carry: ", string(abi.encodePacked(handler.lastForgedLeak()))
            )
        );
        assertEq(handler.forgedNotRun(), 0, "a forged action reverted in the handler: its path never ran");
    }

    /// @dev I-7 (spec §3.2): the Bittensor adapter never holds less than it owes. After every step, from the handler's
    /// own ghost records (each park's amount, parkedAt and converted, moved only by its calls and their events): each
    /// record is the adapter's, each total (parkedNative, parkedTokens) is the sum of the ghost's records and the
    /// ghost's running total, and the native balance and the token balance are each at least the total of their kind
    /// (the ghost's and the adapter's); every sweep took exactly the surplus above the reserve targets and the ghost's
    /// parks, never what is owed; and the Base adapter, which owes nothing, holds no tokens between calls.
    function invariant_neverBelowWhatIsOwed() public view {
        assertEq(handler.recordMismatches(), 0, "I-7: a park's record is not the ghost's");
        assertEq(handler.totalMismatches(), 0, "I-7: a total is not the sum of its records");
        assertEq(handler.owedShortfalls(), 0, "I-7: a balance below what is owed");
        assertEq(handler.sweepMismatches(), 0, "I-7: a sweep took other than the surplus");
        assertGe(address(adapterBit).balance, handler.ghostParkedNative(), "I-7: native below the ghost's parks");
        assertGe(taoBit.balanceOf(address(adapterBit)), handler.ghostParkedTokens(), "I-7: tokens below the parks");
        assertEq(adapterBit.parkedNative(), handler.ghostParkedNative(), "I-7: parkedNative");
        assertEq(adapterBit.parkedTokens(), handler.ghostParkedTokens(), "I-7: parkedTokens");
        assertEq(handler.baseAdapterHeld(), 0, "the Base adapter held tokens");
    }

    /// @dev I-8: every batch delivered to Bittensor is in exactly one of {delivered to its recipient, refunded, still
    /// parked, dropped empty} (or still in flight, or failed and re-executable), by the handler's ghost map: a delivery
    /// that left no state or two, a batch both minted and refunded (or delivered twice), a door batch's processed flag
    /// at the vault other than its ghost's Delivered (so a refunded, parked or dropped batch never minted), a park
    /// event for a message in another state, and a delivered batch's deposit not minted or bounced exactly once with
    /// its amount, each counted; and the door's batch is the handler's own record of it. Every case: after a re-entrant
    /// recipient, a pause, a swap, ForeverMoney short, halted or migrating, and a raised floor.
    function invariant_mintXorRefund() public view {
        assertEq(handler.lostOutcomes(), 0, "I-8: a call left no state, or two");
        assertEq(handler.mintedAndRefunded(), 0, "I-8: a batch both delivered and refunded, or twice");
        assertEq(handler.processedMismatches(), 0, "I-8: a door batch minted other than when delivered");
        assertEq(handler.stateMismatches(), 0, "I-8: a batch's state is not its record's");
        assertEq(handler.depositOutcomeMisses(), 0, "I-8: a delivered deposit not minted or bounced exactly once");
        assertEq(handler.batchContentMismatches(), 0, "the door's batch is not the handler's record of it");
    }

    /// @dev I-9: a refund credits each depositor exactly their deposit: its message is PAYOUTS(the park key,
    /// REFUND_CHUNK, the parked batch's deposits as the handler recorded them) from the park's recipient (the vault) to
    /// its sender (the door), carrying the park's amount; on Base the door logs PayoutReceived for each deposit in
    /// order, each depositor's credit rises by exactly its deposits and netForwarded falls by the refund (floored at
    /// 0); and the door's identities hold across it (FrontDoorInvariants' invariant_frontDoorIdentities, after every
    /// step).
    function invariant_refundCreditsEachDepositor() public view {
        assertEq(handler.refundMessageMismatches(), 0, "I-9: a refund's message is not the parked batch's deposits");
        assertEq(handler.refundMiscredits(), 0, "I-9: a refund credited other than each exact deposit");
    }

    /// @dev I-10, by snapshot (in `warp` and `probeLiveness`): for every park past PARK_TIMEOUT, a stranger's
    /// refundParked with the quoted fee succeeds, or, for a converted park only, refuses with exactly the rail's error
    /// its state names (ForeverMoney halted or migrating, the floor above the park, a conversion short past the
    /// cushion); an empty park's dropParked succeeds; and a converted park to the vault is delivered by deliverParked
    /// whenever the vault accepts.
    function invariant_refundLiveness() public view {
        assertEq(handler.refundLivenessFailures(), 0, "I-10: an aged park's refund refused outside the rail's states");
        assertEq(handler.dropLivenessFailures(), 0, "I-10: an aged empty park's drop refused");
        assertEq(handler.deliveryLivenessFailures(), 0, "I-10: a converted park not delivered to an accepting vault");
    }

    /// @dev I-11: a recipient that reverts and re-enters, or re-enters and then reverts (and two levels deep), never
    /// changes parkedNative, parkedTokens or the records by more than its own batch: around every call that reaches the
    /// re-entrant recipient actor, every other park's record and the totals less its own are unchanged, it receives
    /// exactly its own batch or nothing, and every re-entry into the lock is refused with ReentrancyGuardReentrantCall.
    function invariant_noReentrantDrain() public view {
        assertEq(handler.reentrantDrains(), 0, "I-11: a re-entry moved value owed elsewhere");
        assertEq(handler.reentriesThrough(), 0, "I-11: a re-entry got through the lock");
    }

    /// @dev Every call refused only as its action and state predict (AdapterHandler's list), every delivery's outcome
    /// the predicted one, and no predicted refusal lost.
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

    /// @dev Successful calls per action, and the states they ran in, to show each one is reached; asserts nothing.
    function invariant_reachabilityLogged() public {
        emit log_named_uint("deposits", handler.deposits());
        emit log_named_uint("redeemRequests", handler.redeemRequests());
        emit log_named_uint("closes", handler.closes());
        emit log_named_uint("redeemOnlyCloses", handler.redeemOnlyCloses());
        emit log_named_uint("rolls", handler.rolls());
        emit log_named_uint("claims", handler.claims());
        emit log_named_uint("strangerSends", handler.strangerSends());
        emit log_named_uint("strangerDuplicates", handler.strangerDuplicates());
        emit log_named_uint("strangerToVault", handler.strangerToVault());
        emit log_named_uint("relaysToBittensor", handler.relaysToBittensor());
        emit log_named_uint("deliveredToVault", handler.deliveredToVault());
        emit log_named_uint("deliveredToRecipient", handler.deliveredToRecipient());
        emit log_named_uint("mintsChecked", handler.mintsChecked());
        emit log_named_uint("failuresAlreadyParked", handler.failuresAlreadyParked());
        emit log_named_uint("failuresLocked", handler.failuresLocked());
        emit log_named_uint("reExecutions", handler.reExecutions());
        emit log_named_uint("parkedPaused", handler.parkedPaused());
        emit log_named_uint("parkedStakeMissing", handler.parkedStakeMissing());
        emit log_named_uint("parkedUnknownPeer", handler.parkedUnknownPeer());
        emit log_named_uint("parkedRefused", handler.parkedRefused());
        emit log_named_uint("parkedBelowFloor", handler.parkedBelowFloor());
        emit log_named_uint("parkedHalted", handler.parkedHalted());
        emit log_named_uint("parkedInsolvent", handler.parkedInsolvent());
        emit log_named_uint("parkedSlippage", handler.parkedSlippage());
        emit log_named_uint("parkedConversionShort", handler.parkedConversionShort());
        emit log_named_uint("parkedEmpty", handler.parkedEmpty());
        emit log_named_uint("parksDelivered", handler.parksDelivered());
        emit log_named_uint("parksDeliveredFromTokens", handler.parksDeliveredFromTokens());
        emit log_named_uint("parksConverted", handler.parksConverted());
        emit log_named_uint("deliverParkedRefused", handler.deliverParkedRefused());
        emit log_named_uint("deliverParkedLocked", handler.deliverParkedLocked());
        emit log_named_uint("refundsConverted", handler.refundsConverted());
        emit log_named_uint("refundsUnconverted", handler.refundsUnconverted());
        emit log_named_uint("refundsWithExcess", handler.refundsWithExcess());
        emit log_named_uint("refundsRefusedYoung", handler.refundsRefusedYoung());
        emit log_named_uint("refundsRefusedRail", handler.refundsRefusedRail());
        emit log_named_uint("refundsRefusedFee", handler.refundsRefusedFee());
        emit log_named_uint("refundsRefusedEmpty", handler.refundsRefusedEmpty());
        emit log_named_uint("refundsCredited", handler.refundsCredited());
        emit log_named_uint("refundsToRecipient", handler.refundsToRecipient());
        emit log_named_uint("drops", handler.drops());
        emit log_named_uint("dropsRefused", handler.dropsRefused());
        emit log_named_uint("notParkedRefusals", handler.notParkedRefusals());
        emit log_named_uint("relaysToBase", handler.relaysToBase());
        emit log_named_uint("failuresOnBase", handler.failuresOnBase());
        emit log_named_uint("payoutChunks", handler.payoutChunks());
        emit log_named_uint("payoutsRefusedRail", handler.payoutsRefusedRail());
        emit log_named_uint("payoutsRefusedVault", handler.payoutsRefusedVault());
        emit log_named_uint("stakes", handler.stakes());
        emit log_named_uint("sweepsBittensor", handler.sweepsBittensor());
        emit log_named_uint("sweepsBase", handler.sweepsBase());
        emit log_named_uint("sweepsNonZero", handler.sweepsNonZero());
        emit log_named_uint("vaultPauses", handler.vaultPauses());
        emit log_named_uint("vaultUnpauses", handler.vaultUnpauses());
        emit log_named_uint("swapsAway", handler.swapsAway());
        emit log_named_uint("swapsBack", handler.swapsBack());
        emit log_named_uint("fmShortSwitches", handler.fmShortSwitches());
        emit log_named_uint("fmHalts", handler.fmHalts());
        emit log_named_uint("fmHaltsRefused", handler.fmHaltsRefused());
        emit log_named_uint("fmUnpauses", handler.fmUnpauses());
        emit log_named_uint("fmMigrationsStarted", handler.fmMigrationsStarted());
        emit log_named_uint("fmMigrationsCancelled", handler.fmMigrationsCancelled());
        emit log_named_uint("fmMigrationsExecuted", handler.fmMigrationsExecuted());
        emit log_named_uint("fmMigrationsFinished", handler.fmMigrationsFinished());
        emit log_named_uint("floorRaises", handler.floorRaises());
        emit log_named_uint("reserveDrains", handler.reserveDrains());
        emit log_named_uint("cushionDrains", handler.cushionDrains());
        emit log_named_uint("reserveFunds", handler.reserveFunds());
        emit log_named_uint("cushionFunds", handler.cushionFunds());
        emit log_named_uint("warpsPastTimeout", handler.warpsPastTimeout());
        emit log_named_uint("recipientCalls", handler.recipientCalls());
        emit log_named_uint("reentriesRefused", handler.reentriesRefused());
        emit log_named_uint("reentriesOwnKey", handler.reentriesOwnKey());
        emit log_named_uint("reentriesOtherKey", handler.reentriesOtherKey());
        emit log_named_uint("reentriesSweep", handler.reentriesSweep());
        emit log_named_uint("reentriesRouter", handler.reentriesRouter());
        emit log_named_uint("routerReentryDraws", handler.routerReentryDraws());
        emit log_named_uint("refundsProbed", handler.refundsProbed());
        emit log_named_uint("refundsLive", handler.refundsLive());
        emit log_named_uint("probeRefusedHalted", handler.probeRefusedHalted());
        emit log_named_uint("probeRefusedMigrating", handler.probeRefusedMigrating());
        emit log_named_uint("probeRefusedFloor", handler.probeRefusedFloor());
        emit log_named_uint("probeRefusedSlippage", handler.probeRefusedSlippage());
        emit log_named_uint("probeRefusedCushion", handler.probeRefusedCushion());
        emit log_named_uint("dropsProbed", handler.dropsProbed());
        emit log_named_uint("deliveriesProbed", handler.deliveriesProbed());
        emit log_named_uint("forgedCalls", handler.forgedCalls());
        emit log_named_uint("forgedLanded", handler.forgedLanded());
        emit log_named_uint("forgedRefused", handler.forgedRefused());
        emit log_named_uint("forgedRedeemBurns", handler.forgedRedeemBurns());
        emit log_named_uint("forgedCopies", handler.forgedCopies());
        emit log_named_uint("forgedNotRun", handler.forgedNotRun());
        emit log_named_uint("forgedSweeps", handler.forgedSweeps());
        emit log_named_uint("forgedRedeemOnlyDraws", handler.forgedRedeemOnlyDraws());
        emit log_named_uint("forgedSweepDraws", handler.forgedSweepDraws());
        _logHitTotals();
    }

    // ---- B9: the named states' minimum hits in a long run (MinimumHits) ----

    function _hitTag() internal pure override returns (string memory) {
        return "adapter";
    }

    /// The thin states (the R4-K re-review's Minor 1: F-2's burn and the sweep a forged call sets off) and the parks'
    /// rarer causes, each with its minimum over 3,000 runs at depth 64 (MinimumHits' rule: a quarter of the slowest
    /// seed's projection, from the seeds 6111, 6222 and 6333). reentriesRouter, I-11's router re-entry, through its
    /// targeted draw (reenterThroughTheRouter, the fix round 3's I-1: about 37 in 3,000 runs before it, now about
    /// 4,000).
    function _hits() internal view override returns (Hit[] memory h) {
        h = new Hit[](14);
        h[0] = Hit("forgedRedeemBurns", handler.forgedRedeemBurns(), 386);
        h[1] = Hit("forgedSweeps", handler.forgedSweeps(), 1507);
        h[2] = Hit("forgedCopies", handler.forgedCopies(), 477);
        h[3] = Hit("parkedHalted", handler.parkedHalted(), 518);
        h[4] = Hit("parkedInsolvent", handler.parkedInsolvent(), 16);
        h[5] = Hit("parkedSlippage", handler.parkedSlippage(), 274);
        h[6] = Hit("parkedConversionShort", handler.parkedConversionShort(), 396);
        h[7] = Hit("parkedStakeMissing", handler.parkedStakeMissing(), 94);
        h[8] = Hit("refundsConverted", handler.refundsConverted(), 88);
        h[9] = Hit("probeRefusedMigrating", handler.probeRefusedMigrating(), 201);
        h[10] = Hit("probeRefusedCushion", handler.probeRefusedCushion(), 74);
        h[11] = Hit("parksDeliveredFromTokens", handler.parksDeliveredFromTokens(), 50);
        h[12] = Hit("reentriesRouter", handler.reentriesRouter(), 990);
        h[13] = Hit("deliverParkedLocked", handler.deliverParkedLocked(), 6);
    }

    // ---- scripted pins ----

    function _assertAll() internal view {
        invariant_neverBelowWhatIsOwed();
        invariant_mintXorRefund();
        invariant_refundCreditsEachDepositor();
        invariant_refundLiveness();
        invariant_noReentrantDrain();
        invariant_noUnexpectedReverts();
        invariant_frontDoorIdentities();
        invariant_theFeePotIsAccounted();
        invariant_aCloserNeverReceivesMoreThanItSent();
        invariant_tokenAccounting();
        invariant_aForgedMessageMovesNothingItDidNotCarry();
    }

    /// The handler's seeds, decoded (AdapterHandler's notes): actor `a`'s deposit of `taos` whole TAO (1 to 50).
    function _deposit(uint256 a, uint256 taos) internal {
        handler.deposit(3 + a, taos * 1e9);
    }

    /// The batch of the handler's message `i` parked under the key the handler recorded, with `amount`.
    function _assertParked(uint256 i, uint256 amount, bool converted) internal view {
        AdapterHandler.Msg memory m = handler.messageAt(i);
        (uint128 a, uint64 since, bool c) = adapterBit.parked(m.parkKey);
        assertEq(a, amount, "the park's amount");
        assertTrue(since != 0, "a record");
        assertEq(c, converted, "the park's kind");
    }

    /// I-9 end to end through the handler: two holders' batch parks as native TAO (the vault paused, EnforcedPause),
    /// a third's as tokens (ForeverMoney held, IsHalted); past PARK_TIMEOUT anyone refunds both (the converted one
    /// through depositLiquid), the refunds reach the door, and each depositor is credited exactly its deposit,
    /// netForwarded falling by each; the probe finds both refundable before.
    function test_refundsCreditEachDepositor() public {
        _deposit(0, 10);
        _deposit(1, 5);
        handler.closeBatch(0);
        handler.pauseVault(1);
        assertTrue(vault.paused(), "the guardian paused");
        handler.relayToBittensor(0, 0);
        _assertParked(0, 15e18, true);
        assertEq(handler.parkedPaused(), 1);
        handler.pauseVault(0);
        _deposit(2, 3);
        handler.closeBatch(0);
        handler.fmPause(1);
        assertTrue(av.isPaused());
        handler.relayToBittensor(1, 0);
        _assertParked(1, 3e18, false);
        assertEq(handler.parkedHalted(), 1);
        handler.fmPause(2);
        handler.warp(0);
        assertEq(handler.refundsProbed(), 2, "both aged parks probed");
        assertEq(handler.refundsLive(), 2, "both refundable");
        uint256 forwarded = fd.netForwarded();
        // (refundParked's valueSeed 5: the quoted fee, not relayed at once)
        handler.refundParked(1, 5);
        handler.refundParked(1, 5);
        assertEq(handler.refundsConverted() + handler.refundsUnconverted(), 2);
        assertEq(adapterBit.parkedNative() + adapterBit.parkedTokens(), 0, "nothing parked");
        handler.relayToBase(0, 1);
        handler.relayToBase(1, 1);
        assertEq(handler.refundsCredited(), 2, "both refunds credited on Base");
        assertEq(fd.claimable(handler.actors(0)), 10e18);
        assertEq(fd.claimable(handler.actors(1)), 5e18);
        assertEq(fd.claimable(handler.actors(2)), 3e18);
        assertEq(fd.netForwarded(), forwarded - 18e18, "netForwarded fell by both refunds");
        _assertAll();
    }

    /// A migration through the handler: a batch delivered during the notice converts and mints (withdrawals stay open);
    /// one parked as native TAO then (the vault paused) is a converted park, whose refund past PARK_TIMEOUT needs
    /// ForeverMoney's depositLiquid, closed by the notice: the probe and a refund record MigrationInProgress, allowed
    /// for a converted park; once the position has left, a delivery's conversion is refused Insolvent before the paused
    /// vault is reached, and that token park refunds as its tokens, past the migration.
    function test_aMigrationParksTokensAndTheRefundsWait() public {
        handler.fmMigrate(0);
        assertTrue(av.migrationReadyAt() != 0, "the notice");
        _deposit(0, 4);
        handler.closeBatch(0);
        handler.relayToBittensor(0, 0);
        assertEq(handler.deliveredToVault(), 1, "a delivery during the notice converts");
        _deposit(1, 3);
        handler.closeBatch(0);
        handler.pauseVault(1);
        handler.relayToBittensor(1, 0);
        _assertParked(1, 3e18, true);
        handler.warp(0);
        assertEq(handler.probeRefusedMigrating(), 1, "the converted park's refund waits for the rail");
        // (fmMigrate's seed 3: once ready, executed)
        handler.fmMigrate(3);
        assertTrue(av.migrationExecuted(), "the position left");
        _deposit(2, 2);
        handler.closeBatch(0);
        handler.relayToBittensor(2, 0);
        _assertParked(2, 2e18, false);
        assertEq(handler.parkedInsolvent(), 1, "the conversion is refused before the paused vault is reached");
        handler.warp(0);
        handler.refundParked(1, 1);
        assertEq(handler.refundsRefusedRail(), 1, "the converted park's refund: MigrationInProgress");
        handler.refundParked(9, 1);
        assertEq(handler.refundsUnconverted(), 1, "an unconverted park refunds as tokens, past the migration");
        _assertAll();
    }

    /// The re-entrant recipient actor (I-11): its own batch, refused (RevertThenReenter while refusing), parks native;
    /// a deliverParked that pays it makes it re-enter deliverParked for its own key, which the lock refuses, so it is
    /// paid once; one that re-enters another park's refund, then reverts, re-parks it, the other park whole; one that
    /// bubbles the lock's refusal reverts the whole call, the park as it was; and one that re-enters through the
    /// router, executing a door batch still in flight from inside its own delivery, is paid once while that execution
    /// fails at the lock, writing nothing, the batch re-executable (it parks, the vault paused).
    function test_theRecipientActorsReentriesAreRefused() public {
        _deposit(0, 7);
        handler.closeBatch(0);
        handler.pauseVault(1);
        handler.relayToBittensor(0, 0);
        // seed 41: not a duplicate (41 mod 8), to itself ((41 >> 3) mod 4), a deposit ((41 >> 5) mod 6)
        handler.strangerSend(41, 2e9);
        // mode 7: RevertThenReenter while refusing
        handler.relayToBittensor(1, 7);
        _assertParked(1, 2e18, true);
        assertEq(handler.parkedRefused(), 1);
        // mode 5 (bubbling) with its re-entry into another park's refund: the call reverts whole
        // (deliverParked's seed 9: the second park key, the actor's)
        handler.deliverParked(9, 5 + 8 * 2);
        assertEq(handler.deliverParkedLocked(), 1);
        _assertParked(1, 2e18, true);
        // mode 4: re-enters another park's refund, then refuses: re-parked, the vault's park whole
        handler.deliverParked(9, 4 + 8 * 2);
        _assertParked(1, 2e18, true);
        _assertParked(0, 7e18, true);
        // mode 3: accepts after re-entering deliverParked for its own key: paid once
        uint256 before = address(actor).balance;
        handler.deliverParked(9, 3);
        assertEq(address(actor).balance, before + 2e18, "paid its own batch once");
        assertEq(handler.reentriesOwnKey(), 1, "the own-key re-entry refused by the lock");
        assertGe(handler.recipientCalls(), 4);
        // mode 3 with re-entry kind 5: through the router, the door's batch (message 2) executed inside the actor's
        // own (message 3; strangerSend's seed 41 again: a deposit to itself, not relayed at once)
        _deposit(1, 4);
        handler.closeBatch(0);
        handler.strangerSend(41, 3e9);
        before = address(actor).balance;
        handler.relayToBittensor(3, 3 + 8 * 5);
        assertEq(address(actor).balance, before + 3e18, "paid its batch once");
        assertEq(handler.reentriesRouter(), 1, "the router re-entry refused by the lock");
        AdapterHandler.Msg memory inner = handler.messageAt(2);
        assertEq(uint8(inner.state), uint8(AdapterHandler.State.Failed), "the inner execution failed, re-executable");
        (, uint64 since,) = adapterBit.parked(inner.parkKey);
        assertEq(since, 0, "nothing parked for it");
        assertFalse(vaultLens.processed(inner.batchKey), "nor minted");
        handler.relayToBittensor(2, 0);
        assertEq(handler.reExecutions(), 1);
        _assertParked(2, 4e18, true);
        _assertAll();
    }

    /// A FAILURE re-executed: the actor bubbling the lock's refusal fails its batch's first delivery whole (CCIP
    /// FAILURE: nothing written); re-executed once it accepts, it delivers, once. A duplicate of a parked batch fails
    /// AlreadyParked and delivers after the park is gone.
    function test_aFailureReExecutesAndADuplicateWaitsForItsPark() public {
        handler.strangerSend(41, 2e9);
        handler.relayToBittensor(0, 5);
        assertEq(handler.failuresLocked(), 1);
        assertEq(uint8(handler.messageAt(0).state), uint8(AdapterHandler.State.Failed));
        handler.relayToBittensor(0, 2);
        assertEq(handler.reExecutions(), 1);
        _assertParked(0, 2e18, true);
        // the same message again (strangerSend's seed 0 mod 8)
        handler.strangerSend(8, 0);
        assertEq(handler.strangerDuplicates(), 1);
        handler.relayToBittensor(1, 0);
        assertEq(handler.failuresAlreadyParked(), 1);
        handler.deliverParked(1, 0);
        assertEq(handler.parksDelivered(), 1);
        handler.relayToBittensor(1, 0);
        assertEq(handler.deliveredToRecipient(), 2, "the park, then its duplicate");
        _assertAll();
    }

    // ---- the forged-lane invariant's pins (the R4 review, Important 1) ----

    /// The review's four-call replay (a fresh seed's run 112 of 128, shrunk): a forged delivery through the old rail
    /// reaches the recipient actor while the live adapter's lock is free, and the actor's re-entry sweeps the live
    /// adapter's native surplus to the treasury. Surplus moving to the immutable treasury is no leak (and nothing else
    /// is allowed); before the fix this read as one.
    function test_theReviewsFourCallReplayIsNoLeak() public {
        handler.strangerSend(
            672262193401969517836028782773079454644056248060169396920,
            811585922271375234052561668386318865700516859583524
        );
        handler.drainCushion(54236905841406077105131497730462227407687036166224758);
        handler.deliverParked(1, 92903202859989479267569308049282874335866770996483487032925443);
        handler.forgedFromOldRail(1984, 30000, 23);
        assertEq(handler.forgedCalls(), 1);
        assertEq(handler.forgedNotRun(), 0, "its path ran");
        assertEq(handler.forgedSweeps(), 1, "the actor's re-entry swept surplus to the treasury");
        assertEq(handler.forgedLeaks(), 0, "which is no leak");
        invariant_aForgedMessageMovesNothingItDidNotCarry();
        invariant_noUnexpectedReverts();
    }

    /// F-2, the stated residual, is counted and never a leak: a forged redeem-only batch from the door naming every
    /// holder (forgedToBittensor's seed 192), over a holder whose shares are held past a day, burns them and queues
    /// their value. Before the fix the payout's reservation read as a leak.
    function test_aForgedRedeemOnlyBatchIsTheStatedResidualNotALeak() public {
        _deposit(0, 10);
        handler.closeBatch(0);
        handler.relayToBittensor(0, 0);
        // about 55 hours (warp's seed 800,001: 200,000 seconds), past the door hold
        handler.warp(800_001);
        assertGt(vault.balanceOf(handler.actors(0)), 0);
        handler.forgedToBittensor(192, 0, 16);
        assertEq(handler.forgedCalls(), 1);
        assertEq(handler.forgedNotRun(), 0, "its path ran");
        assertEq(handler.forgedRedeemBurns(), 1, "the named holder's burn, counted");
        assertEq(handler.forgedLeaks(), 0, "and no leak");
        invariant_aForgedMessageMovesNothingItDidNotCarry();
    }

    /// The long run's counterexample (8d05725, 3,000 x 64, seed 20261113, shrunk to 9 calls): a forged exact copy of
    /// the stranger's honest refund, delivered on Base, reaches the recipient actor while it still carries the
    /// re-entry an earlier relay toward Bittensor set (the router's delivery of a batch then in flight, since
    /// delivered). A Base delivery cannot reach the Bittensor adapter, and CCIP never executes a delivered message
    /// again: the copy moves nothing it did not carry. Both guards are on here (the campaign's setUp); the variants
    /// below show each alone, and the leak with neither.
    function test_aForgedCopyToBaseCannotReachTheBittensorSide() public {
        _theForgedCopyToBase();
        assertEq(handler.forgedCalls(), 1, "the forged call ran");
        _assertAll();
    }

    /// The same with the routers' exactly-once mode off: the forged delivery's own rule (the actor re-enters nothing on
    /// the Base side) holds it alone.
    function test_aForgedCopyToBaseIsHeldByTheActorsModeAlone() public {
        routerBase.setExactlyOnce(false);
        routerBit.setExactlyOnce(false);
        _theForgedCopyToBase();
        assertEq(handler.forgedCalls(), 1, "the forged call ran");
        _assertAll();
    }

    /// The same with the actor's mode kept from the earlier relay: the routers' exactly-once mode holds it alone (the
    /// router refuses to execute the delivered batch again, AlreadyExecuted).
    function test_aForgedCopyToBaseIsHeldByExactlyOnceAlone() public {
        handler.setKeepActorModeOnBase(true);
        _theForgedCopyToBase();
        assertEq(handler.forgedCalls(), 1, "the forged call ran");
        _assertAll();
    }

    /// And with neither guard, the long run's counterexample again: the actor's stale re-entry executes the delivered
    /// batch a second time, the mock router mints its tokens again and the adapter parks them, a leak the
    /// forged-message check finds (so the variants above are not vacuous).
    function test_aForgedCopyToBaseLeaksWithNeitherGuard() public {
        routerBase.setExactlyOnce(false);
        routerBit.setExactlyOnce(false);
        handler.setKeepActorModeOnBase(true);
        _theForgedCopyToBase();
        assertEq(handler.forgedCalls(), 1, "the forged call ran");
        assertEq(handler.forgedLeaks(), 1, "the mock's second mint, parked: a leak");
    }

    function _theForgedCopyToBase() internal {
        handler.deposit(11464, 81650257313000347);
        handler.closeBatch(47223711613731147871770491375747174769969316228128298301856709862860338);
        handler.pauseVault(226204376712793895072938464851647049829415);
        handler.raiseFloor(8346586859);
        handler.pauseVault(2234400718000000000);
        handler.strangerSend(43470047065698810636200288305988064424996445451680821573978903438, 322382725069);
        handler.relayToBittensor(82196988274000000000, 4130793857000000000);
        handler.refundParked(26603260817140165987567911678047246133, 259859209711887378279525405);
        handler.forgedToBase(
            4943508649117891590521966,
            48804903203014155097085773664303056602388470592217200656432,
            3207298074475207523358904284459576125638
        );
    }

    /// The router re-entry's targeted draw (fix round 3, I-1): the actor's own batch and a second put in flight behind
    /// it, then the actor's relayed re-entering through the router: the lock refuses the inner execution, which is left
    /// in FAILURE, and a later relay executes it.
    function test_theRouterReentryDrawIsRefusedByTheLock() public {
        handler.reenterThroughTheRouter(0, 3e9);
        assertEq(handler.routerReentryDraws(), 1, "drawn");
        assertEq(handler.reentriesRouter(), 1, "the router re-entry refused by the lock");
        assertEq(handler.reentriesThrough(), 0);
        AdapterHandler.Msg memory inner = handler.messageAt(1);
        assertEq(uint8(inner.state), uint8(AdapterHandler.State.Failed), "the inner execution failed, re-executable");
        handler.relayToBittensor(1, 0);
        assertEq(handler.reExecutions(), 1);
        _assertAll();
    }

    /// F-2's dedicated draw (Task 42): two holders' shares delivered, then forgedRedeemOnly with its day's warp burns
    /// both (the stated residual, counted) and moves nothing else; and without the warp, on shares still fresh, it
    /// burns nothing (the door hold), still no leak.
    function test_theF2DrawBurnsTheMaturedHoldersAndLeaksNothing() public {
        // 5 TAO in all, inside a day's allowance (its 10-TAO floor) and the entry limit
        _deposit(0, 3);
        _deposit(1, 2);
        handler.closeBatch(0);
        handler.relayToBittensor(0, 0);
        handler.forgedRedeemOnly(1);
        assertEq(handler.forgedRedeemBurns(), 0, "fresh shares: the door hold burns nothing");
        handler.forgedRedeemOnly(0);
        assertEq(handler.forgedRedeemOnlyDraws(), 2);
        assertEq(handler.forgedCalls(), 2);
        assertEq(handler.forgedRedeemBurns(), 2, "both matured holders' burns, counted");
        assertEq(handler.forgedLeaks(), 0, "and no leak");
        invariant_aForgedMessageMovesNothingItDidNotCarry();
    }

    /// The sweep's dedicated draw (Task 42): surplus put on the live adapter (tokens, then native), and a forged old-rail
    /// call that reaches the recipient actor, which sweeps it to the treasury: forgedSweeps counts both, no leak; the
    /// surplus left the adapter for the treasury only inside the forged call's snapshot.
    function test_theSweepDrawSweepsTheSurplusAndLeaksNothing() public {
        uint256 tokens = taoBit.balanceOf(address(adapterBit));
        handler.forgedSweep(0, 0);
        assertEq(taoBit.balanceOf(address(adapterBit)), tokens + 1e15, "the token surplus stays after the snapshot");
        handler.forgedSweep(1, 0);
        assertEq(handler.forgedSweepDraws(), 2);
        assertEq(handler.forgedSweeps(), 2, "the actor's sweep moved each surplus");
        assertEq(handler.forgedLeaks(), 0, "and no leak");
        assertEq(handler.forgedNotRun(), 0, "its path ran");
        invariant_aForgedMessageMovesNothingItDidNotCarry();
    }

    /// A forged exact copy of an honest payout chunk toward Base runs (forgedToBase's seed 128: kind 1, the chunk's own
    /// message, sender and recipient): before the fix the handler held no body for messages toward Base and the copy
    /// reverted in the handler, unseen by the campaign.
    function test_aForgedCopyOfAPayoutChunkTowardBaseRuns() public {
        _deposit(0, 10);
        handler.closeBatch(0);
        handler.relayToBittensor(0, 0);
        handler.warp(800_001);
        handler.requestRedeem(0, 1e24);
        handler.closeBatch(0);
        handler.relayToBittensor(1, 0);
        handler.processPayouts(0);
        assertEq(handler.payoutChunks(), 1, "an honest chunk sent toward Base");
        handler.forgedToBase(128, 0, 0);
        assertEq(handler.forgedCalls(), 1);
        assertEq(handler.forgedNotRun(), 0, "its path ran");
        assertEq(handler.forgedCopies(), 1, "the chunk's exact copy delivered to the Base adapter");
        assertEq(handler.forgedLeaks(), 0);
        invariant_aForgedMessageMovesNothingItDidNotCarry();
        invariant_noUnexpectedReverts();
    }

    /// The ghost's checks are live: an adapter whose parkedNative or record reads other than the ghost's fails I-7; and
    /// a record under a delivered batch's key, where the ghost holds no park, fails I-7 (a record not the ghost's, and
    /// parkedNative below the sum of the adapter's records) and I-8 (delivered and still parked), while a park call
    /// on that key, drawn as any batch's, is refused NotParked.
    function test_theGhostChecksCanFail() public {
        _deposit(0, 7);
        handler.closeBatch(0);
        handler.pauseVault(1);
        handler.relayToBittensor(0, 0);
        vm.mockCall(address(adapterBit), abi.encodeWithSignature("parkedNative()"), abi.encode(uint256(1)));
        handler.warp(1);
        vm.clearMockedCalls();
        assertGt(handler.totalMismatches(), 0);
        vm.expectRevert();
        this.invariant_neverBelowWhatIsOwed();
        bytes32 key = handler.messageAt(0).parkKey;
        vm.mockCall(
            address(adapterBit),
            abi.encodeWithSignature("parked(bytes32)", key),
            abi.encode(uint128(7e18), uint64(1), true)
        );
        handler.warp(1);
        vm.clearMockedCalls();
        assertGt(handler.recordMismatches(), 0);

        // a delivered batch (message 1): the vault unpaused, bob's batch closed and relayed
        handler.pauseVault(0);
        _deposit(1, 5);
        handler.closeBatch(0);
        handler.relayToBittensor(1, 0);
        AdapterHandler.Msg memory delivered = handler.messageAt(1);
        assertEq(uint8(delivered.state), uint8(AdapterHandler.State.Delivered));
        // refundParked's seed 8: any batch's key ((8 / 8) mod 2: the delivered one's), refused NotParked as predicted
        uint256 notParked = handler.notParkedRefusals();
        handler.refundParked(8, 5);
        assertEq(handler.notParkedRefusals(), notParked + 1, "a delivered batch's key: NotParked");
        assertEq(handler.unexpectedReverts(), 0);
        uint256 records = handler.recordMismatches();
        uint256 totals = handler.totalMismatches();
        assertEq(handler.stateMismatches(), 0);
        vm.mockCall(
            address(adapterBit),
            abi.encodeWithSignature("parked(bytes32)", delivered.parkKey),
            abi.encode(uint128(5e18), uint64(vm.getBlockTimestamp()), true)
        );
        handler.warp(1);
        vm.clearMockedCalls();
        assertEq(handler.recordMismatches(), records + 1, "I-7: a record under a key the ghost holds no park for");
        assertEq(handler.totalMismatches(), totals + 1, "I-7: parkedNative below the sum of the records");
        assertEq(handler.stateMismatches(), 1, "I-8: delivered and still parked");
        vm.expectRevert();
        this.invariant_mintXorRefund();
    }
}
