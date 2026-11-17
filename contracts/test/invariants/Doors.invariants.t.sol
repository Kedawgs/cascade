// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeVaultLens} from "../../src/lens/CascadeVaultLens.sol";
import {ICascadeTwap} from "../../src/interfaces/ICascadeTwap.sol";
import {GLOBAL_WINDOW} from "../../src/CascadeConstants.sol";
import {DoorState} from "../../src/CascadeTypes.sol";
import {CampaignFixture} from "../utils/CampaignFixture.sol";
import {defaultFrontDoorParams} from "../utils/DefaultParams.sol";
import {VaultInternals} from "../utils/VaultInternals.sol";
import {BoundaryInvariants} from "./BoundaryInvariants.sol";
import {MinimumHits} from "./MinimumHits.sol";
import {FrontDoorInvariants} from "./FrontDoorInvariants.sol";
import {DoorsHandler} from "./handlers/DoorsHandler.sol";
import {TrackedHandler} from "./handlers/TrackedHandler.sol";

/// @dev The two-door campaign (Task 37, spec §3.4 and §3.5; I-15 to I-18, I-20 and I-21, with I-35 and I-4): random
/// sequences of DoorsHandler's actions over the launch door on BASE and a second door on chain 10, activated through
/// the owner's real schedule: deposits (and depositFor) and redeem requests (with and without a delivery preference)
/// at either door by five holders whatever their origin, cancels, claims, closes by the open id, a stale id or a random
/// minimum (an empty batch rolled), self-closes on the pot, the owner's sweeps of either door's carried pot, either
/// door paused (by the owner or the guardian) and unpaused (by the owner), payout chunks to either door, the owner's
/// cancels, direct deposits and exits, origins set to either chain, DIRECT_ORIGIN or a chain with no door, stakes, the
/// outflow limits moved within their hard bounds and past each of them, the chain's removal fee and time. The outflow
/// floor is at its lowest (10 TAO), so the base, not the floor, bounds most windows. Inherits BoundaryInvariants (Task
/// 34a: lens parity on both lenses of the launch door and the vault, token accounting after every step, the fixed
/// libraries asserted in the setUp) and FrontDoorInvariants (the doors' holdings, I-18 and I-21, over both doors).
contract DoorsInvariantTest is CampaignFixture, BoundaryInvariants, FrontDoorInvariants, MinimumHits {
    uint256 constant RAO = 1e9;
    /// The second door's chain, and its treasury (a fixed address with no code, apart from the launch door's).
    uint64 constant SECOND_CHAIN = 10;
    address constant DOOR2_TREASURY =
        address(uint160(uint256(keccak256("doors campaign: the second door's treasury"))));

    VaultInternals vault;
    CascadeVaultLens vaultLens;
    CascadeFrontDoor fd;
    CascadeFrontDoor fd2;
    DoorsHandler handler;

    /// The outflow floor at its lowest, 10 TAO (each percentage at Appendix B's 20%).
    function campaignVaultParams(CascadeVault.Params memory p) internal pure override {
        p.minDailyOutflow = 10e18;
    }

    function setUp() public {
        Campaign memory c = deployCampaign();
        vault = c.vault;
        vaultLens = c.vaultLens;
        fd = c.fd;
        handler = new DoorsHandler(
            TrackedHandler.System(c.vault, c.vaultLens, c.fd, c.doorLens, owner, guardian),
            DoorsHandler.Parts(c.tao, c.bridge, BASE, SECOND_CHAIN, 2_000, 10e18, 2_000)
        );
        landed(Slot.Handler, address(handler));
        // the boundary invariants' targets; I-32's run-time half asserted here, once
        setBoundary(handler, c.vault, c.fd, c.vaultLens, c.doorLens);
        // the second door, on chain 10: the launch door's values, its own treasury, the handler its keeper; its
        // deliver is only ever tried while it is paused, so its swapper is the short payer
        CascadeFrontDoor.Params memory fp = defaultFrontDoorParams(
            c.tao, c.bridge, BITTENSOR, address(c.vault), c.usdc, owner, guardian, address(handler)
        );
        fp.depositCap = HIGH_CAP;
        fp.redeemRequestFee = REQUEST_FEE;
        fp.oracle = ICascadeTwap(address(c.twap));
        fp.swapper = address(c.shortPayer);
        fp.treasury = DOOR2_TREASURY;
        fd2 = new CascadeFrontDoor(fp);
        c.bridge.connect(SECOND_CHAIN, address(fd2), false);
        handler.addSecondDoor(fd2);
        assertEq(vaultLens.activeDoors(BASE), 1, "the launch door");
        assertEq(vaultLens.activeDoors(SECOND_CHAIN), 1, "the second door");
        assertEq(uint8(vaultLens.doorState(handler.peers(1))), uint8(DoorState.Active), "the second door is active");
        // the front-door invariants' handler and tokens, over both doors
        setFrontDoors(handler, IERC20(address(c.tao)), IERC20(address(c.usdc)));
        // pays every close's bridge fee
        vm.deal(address(handler), 1_000 ether);

        bytes4[] memory selectors = new bytes4[](20);
        selectors[0] = DoorsHandler.deposit.selector;
        selectors[1] = DoorsHandler.requestRedeem.selector;
        selectors[2] = DoorsHandler.selfClose.selector;
        selectors[3] = DoorsHandler.cancelDeposit.selector;
        selectors[4] = DoorsHandler.cancelRedeem.selector;
        selectors[5] = DoorsHandler.claim.selector;
        selectors[6] = DoorsHandler.closeBatch.selector;
        selectors[7] = DoorsHandler.sweepPot.selector;
        selectors[8] = DoorsHandler.togglePause.selector;
        selectors[9] = DoorsHandler.processPayouts.selector;
        selectors[10] = DoorsHandler.cancelQueued.selector;
        selectors[11] = DoorsHandler.depositDirect.selector;
        selectors[12] = DoorsHandler.redeemDirect.selector;
        selectors[13] = DoorsHandler.setRedeemOrigin.selector;
        selectors[14] = DoorsHandler.stakeIdle.selector;
        selectors[15] = DoorsHandler.setOutflowLimits.selector;
        selectors[16] = DoorsHandler.setRemoveFee.selector;
        selectors[17] = DoorsHandler.warp.selector;
        selectors[18] = DoorsHandler.bankRun.selector;
        selectors[19] = DoorsHandler.depositAtALimit.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev I-15 (spec §3.4): per window, each door's burns are at most its allowance and all doors' burns at most the
    /// global allowance, each max(its percentage of the base, the floor), measured from the handler's own record of
    /// the vault's Redeemed events at every burning delivery (each window opening at the first burn a day or more
    /// after it last opened), against allowances the handler computes on its ghost base (the booked root stake that
    /// has ramped in, replayed from its own stakes and removals) and its own record of the outflow limits, never the
    /// vault's allowance view. The model's checks beside it: the handler's windows, its ghost ledger and ramp, and its
    /// record of the limits are the vault's after every step.
    function invariant_perDoorAndGlobalWindows() public view {
        assertEq(handler.doorWindowViolations(), 0, "I-15: a door burned past its allowance on the ghost base");
        assertEq(handler.globalWindowViolations(), 0, "I-15: all doors burned past the global allowance");
        assertEq(handler.windowRecordMismatches(), 0, "the handler's window record is not the vault's");
        assertEq(handler.ghostLedgerMismatches(), 0, "the ghost ledger and ramp are not the vault's");
        assertEq(handler.limitMismatches(), 0, "the handler's record of the outflow limits is not the vault's");
    }

    /// @dev I-16, every clause, from the handler's own origins (its setRedeemOrigin and depositDirect calls and the
    /// vault's Deposited events): a door on chain C burns only for holders of origin C (others skipped, and no holder
    /// of C with shares skipped); mints only for a holder of origin 0, C or DIRECT_ORIGIN, and every deposit the close
    /// sent (the door's open entries, snapshot before it) comes out minted or bounced, exactly one of the two and its
    /// full amount, a deposit for another chain's origin bouncing ForeignOrigin and a ForeignOrigin bounce only for
    /// such a deposit; never changes a non-zero origin; a direct deposit always leaves DIRECT_ORIGIN; a door's first mint
    /// for an address of origin 0 sets it to C. The vault's origins are the handler's after every step.
    function invariant_originRule() public view {
        assertEq(handler.originBurnViolations(), 0, "I-16: a door burned for another origin than its chain");
        assertEq(handler.originSkipViolations(), 0, "I-16: a door skipped a holder of its chain with shares");
        assertEq(handler.originMintViolations(), 0, "I-16: a door minted for another chain's origin, or bounced one");
        assertEq(handler.foreignDepositsNotBounced(), 0, "I-16: a deposit for another chain's origin did not bounce");
        assertEq(handler.depositOutcomeMisses(), 0, "I-16: a deposit sent was not minted or bounced, exactly once");
        assertEq(handler.directOriginMisses(), 0, "I-16: a direct deposit did not leave DIRECT_ORIGIN");
        assertEq(handler.firstMintMisses(), 0, "I-16: a door's first mint did not set its chain");
        assertEq(handler.originMismatches(), 0, "I-16: an origin at the vault is not the handler's");
    }

    /// @dev I-17: a direct depositor's shares are never burned by a door unless the holder set that door's chain
    /// afterwards: at every burn, for a holder that ever deposited directly, its last origin change after its last
    /// direct deposit (the handler numbers both, in order) names the burning door's chain.
    function invariant_directSharesNeverBurnedByADoor() public view {
        assertEq(handler.directSharesBurnedByADoor(), 0, "I-17: a door burned a direct depositor's shares");
    }

    /// @dev I-20 (spec §3.5): a paused front door refuses no exit call: requestRedeem, requestRedeemWithDelivery,
    /// cancelRedeem, cancelDeposit, closeBatch, claim and an incoming payout chunk never revert EnforcedPause, on
    /// either door (the handler records any that does); deposit, depositFor and deliver refuse EnforcedPause there
    /// (each predicted, through invariant_noUnexpectedReverts).
    function invariant_pausedDoorRefusesNoExit() public view {
        assertEq(handler.exitsRefusedWhilePaused(), 0, "I-20: an exit call reverted EnforcedPause");
    }

    /// @dev I-35 (the leaver pays, Task 36b) across both doors: around every close and self-close (a door's burns),
    /// every payout chunk sent, every direct exit and every owner's cancel, from the handler's own reads just before
    /// and after the call, (A' + 1)(S + 1e6) >= (A + 1)(S' + 1e6) exactly and the hole no larger, with no allowance at
    /// any removal fee; I-13's direct half (a direct exit paid exactly VaultModel's _exitPlan, its ShortfallAbsorbed
    /// the walk's unmet and cost); and every walk's removals the model's.
    function invariant_noExitLowersThePrice() public view {
        assertEq(handler.exitPriceFalls(), 0, "I-35: an exit lowered the holders' price or widened the hole");
        assertEq(handler.directMispaid(), 0, "I-13: a direct exit paid other than its value less its own cost");
        assertEq(handler.walkMismatches(), 0, "a walk's Unstaked events were not the removals the model predicts");
    }

    /// @dev I-4 (spec §3.1): the price never falls but by I-4's exceptions, and none happens here (no loss, swap or
    /// fresh read short; no exit is one): the price is never below the highest seen.
    function invariant_priceFallsOnlyByI4sExceptions() public view {
        assertGe(vaultLens.price(), handler.priceFloor(), "the price fell outside I-4's exceptions");
        assertEq(handler.exceptionOverruns(), 0, "an I-4 exception fell further than its bound");
        assertEq(handler.guardMisses(), 0, "a mint at a supply of 0 underwater");
    }

    /// @dev Every call refused only as its action and state predict (DoorsHandler's list), and no predicted refusal
    /// lost.
    /// The campaign also fails on any handler call that reverts (Task 34's M6, carried to Task 42: a call a handler does
    /// not wrap in a try, whose revert the fuzzer would otherwise drop): fail-on-revert for this invariant's campaign.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_noUnexpectedReverts() public view {
        assertEq(handler.unexpectedReverts(), 0);
    }

    /// @dev Successful calls per action, and the states they ran in, to show each one is reached; asserts nothing.
    function invariant_reachabilityLogged() public {
        for (uint256 i; i < 2; ++i) {
            string memory door = i == 0 ? "[0]" : "[1]";
            emit log_named_uint(string.concat("deposits", door), handler.deposits(i));
            emit log_named_uint(string.concat("depositsFor", door), handler.depositsFor(i));
            emit log_named_uint(string.concat("redeemRequests", door), handler.redeemRequests(i));
            emit log_named_uint(string.concat("closes", door), handler.closes(i));
            emit log_named_uint(string.concat("rolls", door), handler.rolls(i));
            emit log_named_uint(string.concat("deliveries", door), handler.deliveries(i));
            emit log_named_uint(string.concat("burningDeliveries", door), handler.burningDeliveries(i));
            emit log_named_uint(string.concat("payoutChunks", door), handler.payoutChunks(i));
            emit log_named_uint(string.concat("claims", door), handler.claims(i));
        }
        emit log_named_uint("requestsWithDelivery", handler.requestsWithDelivery());
        emit log_named_uint("depositCancels", handler.depositCancels());
        emit log_named_uint("cancelsTooSoon", handler.cancelsTooSoon());
        emit log_named_uint("redeemCancels", handler.redeemCancels());
        emit log_named_uint("selfCloses", handler.selfCloses());
        emit log_named_uint("closesWithExtra", handler.closesWithExtra());
        emit log_named_uint("potsCarried", handler.potsCarried());
        emit log_named_uint("rollsWithMinValue", handler.rollsWithMinValue());
        emit log_named_uint("wrongBatches", handler.wrongBatches());
        emit log_named_uint("tooSmallCloses", handler.tooSmallCloses());
        emit log_named_uint("sweeps", handler.sweeps());
        emit log_named_uint("sweepsRefused", handler.sweepsRefused());
        emit log_named_uint("partialChunks", handler.partialChunks());
        emit log_named_uint("payoutsUncoverable", handler.payoutsUncoverable());
        emit log_named_uint("chunksRefusedWalkCost", handler.chunksRefusedWalkCost());
        emit log_named_uint("cancels", handler.cancels());
        emit log_named_uint("cancelsRefusedNothing", handler.cancelsRefusedNothing());
        emit log_named_uint("bouncesCarried", handler.bouncesCarried());
        emit log_named_uint("directDeposits", handler.directDeposits());
        emit log_named_uint("directDepositsOverADoorOrigin", handler.directDepositsOverADoorOrigin());
        emit log_named_uint("directRedeems", handler.directRedeems());
        emit log_named_uint("directExitsShort", handler.directExitsShort());
        emit log_named_uint("exitsRefusedByCost", handler.exitsRefusedByCost());
        emit log_named_uint("depositsRefusedAtALimit", handler.depositsRefusedAtALimit());
        emit log_named_uint("limitDraws", handler.limitDraws());
        emit log_named_uint("requestsRefusedFee", handler.requestsRefusedFee());
        emit log_named_uint("directDepositsRefused", handler.directDepositsRefused());
        emit log_named_uint("directExitsRefused", handler.directExitsRefused());
        emit log_named_uint("stakes", handler.stakes());
        emit log_named_uint("bankRuns", handler.bankRuns());
        emit log_named_uint("feeSwitches", handler.feeSwitches());
        emit log_named_uint("exitsCharged", handler.exitsCharged());
        emit log_named_uint("exitsPriceChecked", handler.exitsPriceChecked());
        emit log_named_uint("walksChecked", handler.walksChecked());
        emit log_named_uint("firstMints", handler.firstMints());
        emit log_named_uint("homeMints", handler.homeMints());
        emit log_named_uint("directOriginMints", handler.directOriginMints());
        emit log_named_uint("foreignBounces", handler.foreignBounces());
        emit log_named_uint("burns", handler.burns());
        emit log_named_uint("burnsAfterADirectDeposit", handler.burnsAfterADirectDeposit());
        emit log_named_uint("skipsForeign", handler.skipsForeign());
        emit log_named_uint("skipsDirect", handler.skipsDirect());
        emit log_named_uint("skipsNoShares", handler.skipsNoShares());
        emit log_named_uint("redeemsDeferred", handler.redeemsDeferred());
        emit log_named_uint("originsSet", handler.originsSet());
        emit log_named_uint("originsSetToDirect", handler.originsSetToDirect());
        emit log_named_uint("originsRefusedChain42", handler.originsRefusedChain42());
        emit log_named_uint("originsRefusedChain0", handler.originsRefusedChain0());
        emit log_named_uint("depositOutcomesChecked", handler.depositOutcomesChecked());
        emit log_named_uint("globalTighter", handler.globalTighter());
        emit log_named_uint("doorTighter", handler.doorTighter());
        emit log_named_uint("windowsSpent", handler.windowsSpent());
        emit log_named_uint("globalDaysWithBothDoors", handler.globalDaysWithBothDoors());
        emit log_named_uint("deferredByTheOtherDoor", handler.deferredByTheOtherDoor());
        emit log_named_uint("burnsAtTheFloor", handler.burnsAtTheFloor());
        emit log_named_uint("limitsTightened", handler.limitsTightened());
        emit log_named_uint("limitsLoosened", handler.limitsLoosened());
        emit log_named_uint("limitsRefusedUnscheduled", handler.limitsRefusedUnscheduled());
        string[6] memory past = ["bpsLow", "bpsHigh", "floorLow", "floorHigh", "globalLow", "globalHigh"];
        for (uint256 i; i < 6; ++i) {
            emit log_named_uint(string.concat("limitsRefused.", past[i]), handler.limitsRefusedOutOfBounds(i));
        }
        emit log_named_uint("pausesByOwner", handler.pausesByOwner());
        emit log_named_uint("pausesByGuardian", handler.pausesByGuardian());
        emit log_named_uint("unpauses", handler.unpauses());
        emit log_named_uint("unpausesRefused", handler.unpausesRefused());
        emit log_named_uint("depositsRefusedPaused", handler.depositsRefusedPaused());
        emit log_named_uint("depositForsRefusedPaused", handler.depositForsRefusedPaused());
        emit log_named_uint("deliversRefusedPaused", handler.deliversRefusedPaused());
        emit log_named_uint("pausedRequests", handler.pausedRequests());
        emit log_named_uint("pausedRequestsWithDelivery", handler.pausedRequestsWithDelivery());
        emit log_named_uint("pausedRedeemCancels", handler.pausedRedeemCancels());
        emit log_named_uint("pausedDepositCancels", handler.pausedDepositCancels());
        emit log_named_uint("cancelsWaived", handler.cancelsWaived());
        emit log_named_uint("pausedCloses", handler.pausedCloses());
        emit log_named_uint("pausedSelfCloses", handler.pausedSelfCloses());
        emit log_named_uint("pausedClaims", handler.pausedClaims());
        emit log_named_uint("pausedPayouts", handler.pausedPayouts());
        _logHitTotals();
    }

    // ---- B9: the named states' minimum hits in a long run (MinimumHits) ----

    function _hitTag() internal pure override returns (string memory) {
        return "doors";
    }

    /// The ledger's named states for this campaign (the Task 37 carry: the uncoverable chunk, the walk-cost refusal,
    /// the cancel carrying a bounce, the deposit-limit refusals; partialChunks and globalDaysWithBothDoors thin), each
    /// with its minimum over 3,000 runs at depth 64.
    /// Each minimum is MinimumHits' rule (a quarter of the slowest seed's projection). A minimum of 0 is logged, not
    /// asserted: payoutsUncoverable and chunksRefusedWalkCost, unreached here (the first asserted in the ledger
    /// campaign; the second in the payout campaign, through its walk-cost draw, and pinned in LeaverPays).
    function _hits() internal view override returns (Hit[] memory h) {
        h = new Hit[](11);
        // R11's cancel cooldown, both ways: cancels that went, those refused CancelTooSoon as predicted, and (R12) those
        // that went inside the five minutes because the door was paused (the pause waives the cooldown; this campaign
        // disables no primary, so every waiver here is the pause's); the minimums by MinimumHits' rule from R12's seeds
        // 9401-9403 at 128 x 64, the lower of its two sweeps (ae474d1, f6b306f: slowest projections 471, 245 and 20)
        h[8] = Hit("depositCancels", handler.depositCancels(), 117);
        h[9] = Hit("cancelsTooSoon", handler.cancelsTooSoon(), 61);
        h[10] = Hit("cancelsWaived", handler.cancelsWaived(), 5);
        h[0] = Hit("globalDaysWithBothDoors", handler.globalDaysWithBothDoors(), 80);
        h[1] = Hit("partialChunks", handler.partialChunks(), 492);
        h[2] = Hit("payoutsUncoverable", handler.payoutsUncoverable(), 0);
        h[3] = Hit("chunksRefusedWalkCost", handler.chunksRefusedWalkCost(), 0);
        h[4] = Hit("bouncesCarried", handler.bouncesCarried(), 82);
        h[5] = Hit("depositsRefusedAtALimit", handler.depositsRefusedAtALimit(), 1428);
        h[6] = Hit("deferredByTheOtherDoor", handler.deferredByTheOtherDoor(), 31);
        h[7] = Hit("foreignBounces", handler.foreignBounces(), 2263);
    }

    // ---- scripted pins ----

    /// The handler's seeds, decoded (DoorsHandler's notes): a plain deposit at door `i` (no depositFor, no deliver).
    function _depositAt(uint256 i, uint256 actor, uint256 taos) internal {
        handler.deposit(actor, 10 + i, taos * 1e9);
    }

    /// A request of all of `actor`'s shares at door `i`, without a delivery preference.
    function _redeemAllAt(uint256 i, uint256 actor) internal {
        handler.requestRedeem(actor, 2 + i, 0);
    }

    /// The keeper's close of door `i`'s open batch by its id, at the world's fee, with no minimum.
    function _closeAt(uint256 i) internal {
        handler.closeBatch(i, 0, 0, 0);
    }

    function _assertAll() internal view {
        invariant_perDoorAndGlobalWindows();
        invariant_originRule();
        invariant_directSharesNeverBurnedByADoor();
        invariant_pausedDoorRefusesNoExit();
        invariant_noExitLowersThePrice();
        invariant_priceFallsOnlyByI4sExceptions();
        invariant_noUnexpectedReverts();
        invariant_frontDoorIdentities();
        invariant_aCloserNeverReceivesMoreThanItSent();
        invariant_theFeePotIsAccounted();
        invariant_potCarriedNeverAboveTheUnowedEth();
        invariant_tokenAccounting();
    }

    /// The origin rule across two doors, one clause after another: a first mint sets the door's chain; a deposit at
    /// the other door bounces ForeignOrigin and a request there is skipped; a direct deposit leaves DIRECT_ORIGIN and
    /// a door's request for it is skipped until the holder sets that chain; then the door burns it.
    function test_theOriginRuleAcrossTwoDoors() public {
        address alice = handler.actors(0);
        _depositAt(0, 0, 50);
        _closeAt(0);
        assertEq(vaultLens.redeemOrigin(alice), BASE, "a first mint sets the door's chain");
        assertEq(handler.firstMints(), 1);
        _depositAt(1, 0, 20);
        _closeAt(1);
        assertEq(handler.foreignBounces(), 1, "a deposit at the other chain's door bounces");
        _redeemAllAt(1, 0);
        _closeAt(1);
        assertEq(handler.skipsForeign(), 1, "a request at the other chain's door is skipped");
        assertEq(handler.burns(), 0);
        handler.depositDirect(0, 1e9);
        assertEq(vaultLens.redeemOrigin(alice), type(uint64).max, "a direct deposit leaves DIRECT_ORIGIN");
        _redeemAllAt(0, 0);
        _closeAt(0);
        assertEq(handler.skipsDirect(), 1, "a door skips a DIRECT_ORIGIN holder");
        handler.setRedeemOrigin(0, 0);
        assertEq(vaultLens.redeemOrigin(alice), BASE);
        _redeemAllAt(0, 0);
        _closeAt(0);
        assertEq(handler.burns(), 1, "the holder set the door's chain: it burns");
        assertEq(handler.burnsAfterADirectDeposit(), 1);
        handler.setRedeemOrigin(0, 6);
        assertEq(handler.originsRefusedChain42(), 1, "a chain with no door is refused UnknownOrigin");
        handler.setRedeemOrigin(0, 7);
        assertEq(handler.originsRefusedChain0(), 1, "chain 0 is refused UnknownOrigin");
        assertEq(handler.depositOutcomesChecked(), 2, "each deposit resolved: one minted, one bounced");
        _assertAll();
    }

    /// The global window binds across doors: with each door's percentage at 20% and the global one at 30% of a 400 TAO
    /// base, the launch door's holder burns the launch door's 80 TAO, and the second door's holder, the same day, only
    /// the 40 TAO the global window has left (the second door's own window had 80).
    function test_theGlobalWindowBindsAcrossDoors() public {
        _depositAt(0, 0, 200);
        _closeAt(0);
        _depositAt(1, 2, 200);
        _closeAt(1);
        handler.stakeIdle();
        // the global percentage to 30%: a loosening, scheduled (48 hours, so the stake has ramped in)
        handler.setOutflowLimits(0, 2_000, 1, 3_000);
        assertEq(handler.limitsLoosened(), 1);
        assertEq(vaultLens.globalOutflowBps(), 3_000);
        assertEq(handler.ghostBase(), 400e18, "the base: the stake, ramped in");
        _redeemAllAt(0, 0);
        _closeAt(0);
        (, uint256 first) = handler.windowOf(0);
        assertApproxEqAbs(first, 80e18, 1e9, "the launch door's window: 20% of the base");
        _redeemAllAt(1, 2);
        _closeAt(1);
        (, uint256 second) = handler.windowOf(1);
        (, uint256 all) = handler.windowOf(2);
        assertApproxEqAbs(second, 40e18, 2e9, "the second door: what the global window had left");
        assertLe(all, 120e18, "the global window: 30% of the base");
        assertEq(handler.globalTighter(), 1, "the global window was the tighter one");
        assertEq(handler.globalDaysWithBothDoors(), 1);
        (, uint256 vaultGlobal) = vaultLens.burnWindows(GLOBAL_WINDOW);
        assertEq(vaultGlobal, all, "the handler's record is the vault's");
        _assertAll();
    }

    /// At Appendix B's limits (each door 20%, all doors 20%), the launch door's burn spends the global window, so the
    /// second door's holder, the same day, is deferred whole: one allowance shared first-come across the doors.
    function test_theGlobalWindowHoldsTheSecondDoorBack() public {
        _depositAt(0, 0, 200);
        _closeAt(0);
        _depositAt(1, 2, 200);
        _closeAt(1);
        handler.stakeIdle();
        handler.warp(1 days);
        _redeemAllAt(0, 0);
        _closeAt(0);
        (, uint256 first) = handler.windowOf(0);
        assertApproxEqAbs(first, 80e18, 1e9, "the launch door's window: 20% of the base");
        _redeemAllAt(1, 2);
        _closeAt(1);
        (, uint256 second) = handler.windowOf(1);
        assertEq(second, 0, "the second door burned nothing");
        assertEq(handler.deferredByTheOtherDoor(), 1, "held back by the global window the other door spent");
        assertEq(handler.burns(), 1);
        _assertAll();
    }

    /// A paused door refuses deposits, depositFor and deliver, and takes every exit call: a deposit cancel, a request
    /// with and without a delivery preference, a request cancel, a close, a self-close, a payout chunk to it and a
    /// claim; the guardian's unpause is refused, the owner's is not.
    function test_aPausedDoorTakesEveryExitCall() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        _depositAt(1, 2, 100);
        _depositAt(1, 3, 100);
        _closeAt(1);
        handler.stakeIdle();
        _depositAt(1, 2, 30);
        // the guardian pauses the second door
        handler.togglePause(1, 1);
        assertTrue(fd2.paused());
        assertEq(handler.pausesByGuardian(), 1);
        _depositAt(1, 2, 10);
        handler.deposit(2, 9, 10e9);
        handler.deposit(2, 1, 10e9);
        assertEq(handler.depositsRefusedPaused(), 1, "deposit refused");
        assertEq(handler.depositForsRefusedPaused(), 1, "depositFor refused");
        assertEq(handler.deliversRefusedPaused(), 1, "deliver refused");
        // within five minutes of carol's deposit her cancel goes at once, never refused: the pause waives the cooldown
        // (R12; under R11 it was refused CancelTooSoon until the five minutes had passed)
        handler.cancelDeposit(2, 1, 10e9);
        assertEq(handler.cancelsWaived(), 1, "inside the five minutes, at once");
        assertEq(handler.cancelsTooSoon(), 0);
        // carol asks for 40 TAO's worth with a delivery preference (seed bits: door 1, with delivery, not all), then
        // takes one share back; dave asks for all of his
        handler.requestRedeem(2, 1, 40e24 + 4);
        handler.cancelRedeem(2, 1, 1);
        handler.requestRedeem(3, 3, 0);
        _closeAt(1);
        assertEq(handler.burningDeliveries(1), 1);
        // the lane's fee at most the pot (feeSeed 1), so the self-close goes through on it
        handler.selfClose(2, 1, 1, 1e18);
        handler.processPayouts(0);
        handler.processPayouts(0);
        handler.claim(2, 1);
        assertEq(handler.pausedDepositCancels(), 1);
        assertGe(handler.pausedRequestsWithDelivery(), 1);
        assertEq(handler.pausedRedeemCancels(), 1);
        assertGe(handler.pausedRequests(), 1);
        assertEq(handler.pausedCloses(), 1);
        assertEq(handler.pausedSelfCloses(), 1);
        assertGe(handler.pausedPayouts(), 1);
        assertEq(handler.pausedClaims(), 1);
        // only the owner unpauses
        handler.togglePause(1, 0);
        assertEq(handler.unpausesRefused(), 1);
        assertTrue(fd2.paused());
        handler.togglePause(1, 1);
        assertFalse(fd2.paused());
        _assertAll();
    }

    /// setOutflowLimits refuses each value past its hard bound (InvalidParameter: at once below, at the scheduled
    /// item's execute above) and a loosening called directly (NotScheduled), and the limits stay.
    function test_theOutflowLimitsRefuseEachValuePastItsBound() public {
        for (uint256 f; f < 6; ++f) {
            handler.setOutflowLimits(5 + 8 * f, 0, 0, 0);
            assertEq(handler.limitsRefusedOutOfBounds(f), 1);
        }
        handler.setOutflowLimits(4, 3_000, 0, 0);
        assertEq(handler.limitsRefusedUnscheduled(), 1);
        assertEq(vaultLens.maxDailyOutflowBps(), 2_000);
        assertEq(vaultLens.minDailyOutflow(), 10e18);
        assertEq(vaultLens.globalOutflowBps(), 2_000);
        _assertAll();
    }

    /// The model's checks are live: an origin the vault reads other than the handler's, and a window the vault reads
    /// other than the handler's record, each fail their invariant.
    function test_theOriginAndWindowChecksCanFail() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        address alice = handler.actors(0);
        _depositAt(0, 0, 50);
        _closeAt(0);
        vm.mockCall(
            address(vaultLens), abi.encodeCall(CascadeVaultLens.redeemOrigin, (alice)), abi.encode(SECOND_CHAIN)
        );
        handler.warp(1 hours);
        vm.clearMockedCalls();
        assertEq(handler.originMismatches(), 1);
        vm.expectRevert();
        this.invariant_originRule();
        vm.mockCall(
            address(vaultLens),
            abi.encodeCall(CascadeVaultLens.burnWindows, (handler.peers(0))),
            abi.encode(uint64(1), uint256(1))
        );
        _redeemAllAt(0, 0);
        _closeAt(0);
        vm.clearMockedCalls();
        assertEq(handler.windowRecordMismatches(), 1);
        vm.expectRevert();
        this.invariant_perDoorAndGlobalWindows();
    }
}
