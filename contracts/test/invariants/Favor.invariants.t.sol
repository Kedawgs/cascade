// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeVaultLens} from "../../src/lens/CascadeVaultLens.sol";
import {CascadeFormulas} from "../../src/libraries/CascadeFormulas.sol";
import {Schedule} from "../governance/Schedule.sol";
import {CampaignFixture} from "../utils/CampaignFixture.sol";
import {VaultInternals} from "../utils/VaultInternals.sol";
import {BoundaryInvariants} from "./BoundaryInvariants.sol";
import {MinimumHits} from "./MinimumHits.sol";
import {FavorHandler} from "./handlers/FavorHandler.sol";
import {TrackedHandler} from "./handlers/TrackedHandler.sol";

/// @dev The vault-favour campaign (Task 42, the R4 vault-favour review's proposal; the founder's rule of 2026-11-06,
/// "we need to always go in the vault's favour"): no one gains except by time held. FavorHandler's actions (its notes,
/// the actors' roles and the precise form of each invariant there)
/// over CampaignFixture's world at the launch's reward settings (a 10% cut to the treasury, rewardVesting 30 days),
/// two honest holders seeded with 20 TAO between them before the campaign begins (the founder's own launch deposit:
/// a supply that never returns to 0, whose rewards a newcomer could otherwise take; spec §3.1's write-down covers
/// that corner). Inherits BoundaryInvariants: lens parity on both lenses and token accounting after every step.
contract FavorInvariantTest is CampaignFixture, BoundaryInvariants, MinimumHits {
    uint256 constant RAO = 1e9;

    VaultInternals vault;
    CascadeVaultLens vaultLens;
    FavorHandler handler;

    /// The launch's reward settings (spec Appendix B): a 10% cut to the treasury and 30 days of vesting.
    function campaignVaultParams(CascadeVault.Params memory p) internal view override {
        p.treasury = treasury;
        p.rewardCutBps = 1_000;
        p.rewardVesting = 30 days;
    }

    function setUp() public {
        Campaign memory c = deployCampaign();
        vault = c.vault;
        vaultLens = c.vaultLens;
        handler = new FavorHandler(
            TrackedHandler.System(c.vault, c.vaultLens, c.fd, c.doorLens, owner, guardian),
            FavorHandler.Parts(c.tao, c.bridge, BASE)
        );
        landed(Slot.Handler, address(handler));
        setBoundary(handler, c.vault, c.fd, c.vaultLens, c.doorLens);
        assertEq(vaultLens.rewardVesting(), 30 days, "the launch's vesting period");
        assertEq(vaultLens.rewardCutBps(), 1_000, "the launch's cut");
        // pays every close's bridge fee and every payout's fee
        vm.deal(address(handler), 1_000 ether);
        // the honest holders' 12 + 8 TAO, staked, through the handler's own steps (I-34 folds their mints)
        handler.depositDirect(0, 12e9);
        handler.depositDirect(1, 8e9);
        handler.stakeIdle();
        handler.begin();

        bytes4[] memory selectors = new bytes4[](23);
        selectors[0] = FavorHandler.doorDeposit.selector;
        selectors[1] = FavorHandler.doorRequest.selector;
        selectors[2] = FavorHandler.sameBatch.selector;
        selectors[3] = FavorHandler.cancel.selector;
        selectors[4] = FavorHandler.claimBase.selector;
        selectors[5] = FavorHandler.depositDirect.selector;
        selectors[6] = FavorHandler.redeemDirect.selector;
        selectors[7] = FavorHandler.gift.selector;
        selectors[8] = FavorHandler.donate.selector;
        selectors[9] = FavorHandler.holderClaim.selector;
        selectors[10] = FavorHandler.closeBatch.selector;
        selectors[11] = FavorHandler.processPayouts.selector;
        selectors[12] = FavorHandler.stakeIdle.selector;
        selectors[13] = FavorHandler.keeperClaim.selector;
        selectors[14] = FavorHandler.adopt.selector;
        selectors[15] = FavorHandler.warp.selector;
        selectors[16] = FavorHandler.setRemoveFee.selector;
        selectors[17] = FavorHandler.lateEntry.selector;
        selectors[18] = FavorHandler.ownerCancel.selector;
        selectors[19] = FavorHandler.pauseVault.selector;
        selectors[20] = FavorHandler.retryDelivery.selector;
        // R6b U1: the owner's moves onto the standby, a second listed hotkey that accrues unevenly
        selectors[21] = FavorHandler.moveToStandby.selector;
        // R7: a holder's or the stranger's claim the moment the claim schedule has fully vested
        selectors[22] = FavorHandler.claimAtVestEnd.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ---- no one gains except by time held ----

    /// @dev Across every action (time's excepted), the acting actor's wealth does not rise: every mint and burn rounds
    /// against it, one price per batch, a direct exit pays its own costs, a cancel gives back what was put in, a closer
    /// never gets back more than it sent, and a gift or a donation is the giver's loss. A holder's own reward claim may
    /// raise it by its share of the cut's rounding, which favours the holders over the treasury (under 2 wei; allowed
    /// 1 rao), and the attacker's own retry of a filed delivery by the other entries' rounding dust it prices (1 rao an
    /// entry and 2 more, as for another actor's retry; seed 9403, R6). And across every action the attacker does not make (the keeper's closes, payouts, stakes, claims and
    /// adoptions, where every door-path mint, burn and payout is priced; the owner's cancel and pause; a retry; the
    /// honest holders' and the stranger's acts), the attacker's wealth does not rise beyond the action's rounding (1
    /// rao an entry it prices and 1 more; at a donation, its share of it).
    function invariant_noActorGainsByActing() public view {
        assertEq(
            handler.selfGains(),
            0,
            string.concat(
                "an actor gained by acting: ",
                string(abi.encodePacked(handler.lastSelfGainAction())),
                " ",
                vm.toString(handler.lastSelfGainWei())
            )
        );
        assertEq(
            handler.attackerGains(),
            0,
            string.concat(
                "the attacker gained by another's act: ",
                string(abi.encodePacked(handler.lastAttackerGainAction())),
                " ",
                vm.toString(handler.lastAttackerGainWei())
            )
        );
    }

    /// @dev The attacker gains at most its time share: at the shares it held at each moment, its share of the rewards
    /// that accrued then (net of the cut), of the gifts as they vested and of the donations as they landed, and of the
    /// vest above the accrual rate as far as the stake that left funded it (the recapture term: each of the attacker's
    /// departures whose walk took booked stake credits net rate x that stake x the vesting period, for two vesting
    /// periods; FavorHandler's notes; since Revision 27 an adoption vests on its own drip and credits nothing), plus 1
    /// rao an action; and the stranger, who holds no shares, never gains. No one
    /// but the attacker leaves (the honest holders stay), so no one else's forfeit can reach it; its own can (what its
    /// departed stake earned before it left vests to whoever holds then, its later shares included: the rerun's
    /// counterexample, pinned below; the premise before said no forfeit could). The stated precondition (the R4
    /// review's Medium 1): no two claims further apart than the vesting period, 30 days, which the keeper's routine
    /// holds (claimGapOverruns asserted 0). And the recapture term's premise (Revision 27): an adoption leaves the
    /// claim schedule as it was (adoptionsMovedClaims asserted 0), so departures alone can make the vest outrun the
    /// accrual; the old behaviour, an adoption restarting the claim schedule, fails here.
    function invariant_gainsOnlyByTimeShare() public view {
        (int256 gain, uint256 bound_) = handler.attackerBound();
        // the recapture term in the message (review M-3): unfundedVest above 0 with the pool empty marks a credit's
        // expiry tail (a false failure the notes describe), not a regression
        assertLe(
            gain,
            int256(bound_),
            string.concat(
                "the attacker gained more than its time share (unfundedVest ",
                vm.toString(handler.unfundedVest()),
                ", recapturePool ",
                vm.toString(handler.recapturePool()),
                ", expiredCredit ",
                vm.toString(handler.expiredCredit()),
                ")"
            )
        );
        assertLe(handler.gainOf(handler.stranger()), 0, "the stranger gained");
        assertEq(handler.claimGapOverruns(), 0, "the precondition: two claims further apart than the vesting period");
        assertEq(handler.adoptionsMovedClaims(), 0, "the premise: an adoption moved the claim schedule");
    }

    /// @dev Every gain is matched by a loss or a vested reward: the actors' and the keeper's gains together, with the
    /// stranger's gifts the vault has not booked yet (its loss, no one's gain yet), are at most the rewards claimed net
    /// of the cut less what of the schedule is still vesting (an adopted gift is its giver's loss and the holders' gain
    /// only as it vests), plus 1 rao an action. Its slack is what leaves the world (the bridge's and the chain's fees,
    /// the keeper's top-ups) and the treasury's share of what vests after its cut; the cut is the stated exception.
    function invariant_gainsAreConserved() public view {
        (int256 sum, int256 bound_) = handler.conservation();
        assertLe(sum, bound_, "the actors gained more than the vested rewards");
    }

    /// @dev Every call refused only with an error its action allows (FavorHandler's list).
    /// The campaign also fails on any handler call that reverts (Task 34's M6, carried to Task 42: a call a handler does
    /// not wrap in a try, whose revert the fuzzer would otherwise drop): fail-on-revert for this invariant's campaign.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_noUnexpectedReverts() public view {
        assertEq(handler.unexpectedReverts(), 0);
    }

    /// @dev Successful calls per action, and the states they ran in; asserts nothing.
    function invariant_reachabilityLogged() public {
        emit log_named_uint("doorDeposits", handler.doorDeposits());
        emit log_named_uint("directDeposits", handler.directDeposits());
        emit log_named_uint("requests", handler.requests());
        emit log_named_uint("sameBatchPairs", handler.sameBatchPairs());
        emit log_named_uint("depositCancels", handler.depositCancels());
        emit log_named_uint("cancelsTooSoon", handler.cancelsTooSoon());
        emit log_named_uint("requestCancels", handler.requestCancels());
        emit log_named_uint("closes", handler.closes());
        emit log_named_uint("burns", handler.burns());
        emit log_named_uint("deferrals", handler.deferrals());
        emit log_named_uint("payoutChunks", handler.payoutChunks());
        emit log_named_uint("topUpChunks", handler.topUpChunks());
        emit log_named_uint("payoutsRefused", handler.payoutsRefused());
        emit log_named_uint("baseClaims", handler.baseClaims());
        emit log_named_uint("directExits", handler.directExits());
        emit log_named_uint("directExitsRefused", handler.directExitsRefused());
        emit log_named_uint("stakes", handler.stakes());
        emit log_named_uint("rewardClaims", handler.rewardClaims());
        emit log_named_uint("forcedClaims", handler.forcedClaims());
        emit log_named_uint("holderClaims", handler.holderClaims());
        emit log_named_uint("strangerClaims", handler.strangerClaims());
        emit log_named_uint("claimsHeldWhileVesting", handler.claimsHeldWhileVesting());
        emit log_named_uint("outsideClaimsMade", handler.outsideClaimsMade());
        emit log_named_uint("claimsAtVestEnd", handler.claimsAtVestEnd());
        emit log_named_uint("standbyMoves", handler.standbyMoves());
        emit log_named_uint("standbyUnclaimedRao", handler.standbyUnclaimedRao());
        emit log_named_uint("cutsMinted", handler.cutsMinted());
        emit log_named_uint("gifts", handler.gifts());
        emit log_named_uint("adoptions", handler.adoptions());
        emit log_named_uint("donations", handler.donations());
        emit log_named_uint("feeSwitches", handler.feeSwitches());
        emit log_named_uint("lateEntries", handler.lateEntries());
        emit log_named_uint("recaptured", handler.recaptured());
        emit log_named_uint("recapturePool", handler.recapturePool());
        emit log_named_uint("departedCredit", handler.departedCredit());
        emit log_named_uint("movedCredit", handler.movedCredit());
        emit log_named_uint("cappedCredit", handler.cappedCredit());
        emit log_named_uint("expiredCredit", handler.expiredCredit());
        emit log_named_uint("unfundedVest", handler.unfundedVest());
        emit log_named_uint("lateEntryDraws", handler.lateEntryDraws());
        emit log_named_uint("exitsWhileVesting", handler.exitsWhileVesting());
        emit log_named_uint("ownerCancels", handler.ownerCancels());
        emit log_named_uint("cancelsRefused", handler.cancelsRefused());
        emit log_named_uint("pauses", handler.pauses());
        emit log_named_uint("unpauses", handler.unpauses());
        emit log_named_uint("failedDeliveries", handler.failedDeliveries());
        emit log_named_uint("retriesDelivered", handler.retriesDelivered());
        emit log_named_uint("retriesByAttacker", handler.retriesByAttacker());
        emit log_named_uint("retriesFailed", handler.retriesFailed());
        emit log_named_uint("adoptionsRefused", handler.adoptionsRefused());
        emit log_named_uint("closestMargin", handler.closestMargin());
        emit log_named_uint("closestConservationMargin", handler.closestConservationMargin());
        emit log_named_int("attackerGain", handler.gainOf(handler.attacker()));
        emit log_named_uint("attackerAllowance", handler.allowance());
        emit log_named_uint("netRewardsClaimed", handler.netRewardsClaimed());
        _logHitTotals();
        string[8] memory names = _recaptureTotals();
        for (uint256 i; i < names.length; ++i) {
            emit log_named_uint(string.concat("favor total ", names[i]), hitTotal(names[i]));
        }
    }

    // ---- B9 ----

    function _hitTag() internal pure override returns (string memory) {
        return "favor";
    }

    /// The recapture term's campaign totals (Task 42's fix round 4), summed over every run beside the named states'
    /// (MinimumHits' environment totals), logged and never asserted: what the allowance recaptured, the vest above the
    /// accrual that nothing funded, the runs with any, the departure credits (after the cap), the owner's moves'
    /// credits (R7), what the cap cut, what expired unspent, and the pool left at each run's end (wei, but the runs).
    /// The adoption-restart credit is gone (Revision 27: an adoption vests on its own drip).
    function _recaptureTotals() internal pure returns (string[8] memory) {
        return [
            "recapturedWei",
            "unfundedVestWei",
            "runsWithUnfundedVest",
            "departedCreditWei",
            "movedCreditWei",
            "cappedCreditWei",
            "expiredCreditWei",
            "leftoverPoolWei"
        ];
    }

    function afterInvariant() public override {
        uint256[8] memory v = [
            handler.recaptured(),
            handler.unfundedVest(),
            handler.unfundedVest() == 0 ? 0 : 1,
            handler.departedCredit(),
            handler.movedCredit(),
            handler.cappedCredit(),
            handler.expiredCredit(),
            handler.recapturePool()
        ];
        string[8] memory names = _recaptureTotals();
        for (uint256 i; i < v.length; ++i) {
            string memory key = _hitKey(_hitTag(), names[i]);
            vm.setEnv(key, vm.toString(vm.envOr(key, uint256(0)) + v[i]));
        }
        super.afterInvariant();
    }

    /// The named states of the review's actions and Task 42's fix round (the owner's cancel, a failed delivery and its
    /// retry, by the attacker among them), each with its minimum over 3,000 runs at depth 64 (MinimumHits' rule: a
    /// quarter of the slowest seed's projection, from the seeds 7111, 7222 and 7333). R7's two from the seeds 9401 to
    /// 9403 of the campaign with claimAtVestEnd (slowest projections 6,040 and 4,162); the others kept, each under a
    /// third of that campaign's slowest projection.
    function _hits() internal view override returns (Hit[] memory h) {
        h = new Hit[](18);
        // R11's cancel cooldown, both ways: cancels that went, and those refused CancelTooSoon as predicted (the minimums
        // by MinimumHits' rule from R12's seeds 9401-9403 at 128 x 64, the lower of its two sweeps: slowest projections
        // 423 and 517)
        h[16] = Hit("depositCancels", handler.depositCancels(), 105);
        h[17] = Hit("cancelsTooSoon", handler.cancelsTooSoon(), 129);
        h[9] = Hit("strangerClaims", handler.strangerClaims(), 350);
        h[10] = Hit("ownerCancels", handler.ownerCancels(), 67);
        h[11] = Hit("failedDeliveries", handler.failedDeliveries(), 184);
        h[12] = Hit("retriesDelivered", handler.retriesDelivered(), 50);
        h[13] = Hit("retriesByAttacker", handler.retriesByAttacker(), 61);
        // R7 (the R6b review's coverage note): under U1 holderClaims and strangerClaims count refusals too, so the
        // claims the vault took, and those made once a schedule had fully vested, have minimums of their own
        h[14] = Hit("outsideClaimsMade", handler.outsideClaimsMade(), 1510);
        h[15] = Hit("claimsAtVestEnd", handler.claimsAtVestEnd(), 1040);
        h[0] = Hit("lateEntries", handler.lateEntries(), 3013);
        h[1] = Hit("exitsWhileVesting", handler.exitsWhileVesting(), 871);
        h[2] = Hit("sameBatchPairs", handler.sameBatchPairs(), 1265);
        h[3] = Hit("holderClaims", handler.holderClaims(), 399);
        h[4] = Hit("forcedClaims", handler.forcedClaims(), 359);
        h[5] = Hit("adoptions", handler.adoptions(), 646);
        h[6] = Hit("burns", handler.burns(), 247);
        h[7] = Hit("topUpChunks", handler.topUpChunks(), 59);
        h[8] = Hit("directExits", handler.directExits(), 835);
    }

    // ---- pins ----

    function _assertAll() internal view {
        invariant_noActorGainsByActing();
        invariant_gainsOnlyByTimeShare();
        invariant_gainsAreConserved();
        invariant_noUnexpectedReverts();
        invariant_tokenAccounting();
    }

    /// The review's test (Medium 1), at the launch's 30 days of vesting: 29 days of rewards accrue on the honest 20
    /// TAO, the attacker deposits 24 TAO directly, the keeper's claim comes at day 30, 7 days pass and the attacker
    /// leaves: it gained, and no more than its time share.
    function test_aLateEntrantEarnsNoMoreThanItsTimeShare() public {
        _lateEntry();
        address a = handler.attacker();
        (int256 gain, uint256 bound_) = handler.attackerBound();
        assertGt(gain, 0, "the late entrant gained something");
        assertLe(gain, int256(bound_), "within its time share");
        handler.redeemDirect(0, 0);
        assertEq(vault.balanceOf(a), 0, "it left");
        _assertAll();
    }

    /// The same at the old 7 days of vesting (the review's Medium 1, a known-bad setting): the late entrant takes the
    /// whole month's lump in a week, more than its time share, and gainsOnlyByTimeShare fails. The pin that shows the
    /// invariant can fail.
    function test_atSevenDaysOfVestingTheLateEntrantTakesMoreThanItsTimeShare() public {
        Schedule.run(vault, owner, abi.encodeCall(CascadeVault.setRewardVesting, (7 days)));
        _lateEntry();
        (int256 gain, uint256 bound_) = handler.attackerBound();
        assertGt(gain, int256(bound_), "the late entrant took more than its time share");
        vm.expectRevert();
        this.gainsOnlyByTimeShareExternal();
    }

    /// invariant_gainsOnlyByTimeShare, called from outside so a pin can expect its failure.
    function gainsOnlyByTimeShareExternal() external view {
        invariant_gainsOnlyByTimeShare();
    }

    /// A gift, a donation and a same-batch deposit and redeem: each is its actor's loss (noActorGainsByActing), and the
    /// totals stay within the rewards.
    function test_aGiftADonationAndASameBatchPairAreTheirActorsLoss() public {
        handler.gift(1e9);
        handler.donate(1e8);
        // the attacker's shares, a day old, then a deposit and a redeem of them in one batch
        handler.depositDirect(2, 5e9);
        handler.warp(1 days + 1);
        handler.sameBatch(0, 5e9, 0);
        handler.closeBatch(0);
        assertEq(handler.sameBatchPairs(), 1);
        assertEq(handler.gifts(), 1);
        assertEq(handler.donations(), 1);
        handler.warp(2 days);
        handler.adopt();
        assertEq(handler.adoptions(), 1, "the gift adopted");
        assertLt(handler.gainOf(handler.stranger()), 0, "the giver lost");
        _assertAll();
    }

    /// The attacker's door path end to end: a deposit delivered, a day for the door hold, a request burned, the payout
    /// sent and claimed on Base; it paid the fees and gained nothing beyond its share of the rewards.
    function test_theDoorPathRoundTripGainsNothingButTime() public {
        handler.doorDeposit(2, 10e9);
        handler.closeBatch(0);
        handler.warp(1 days + 1);
        handler.doorRequest(0, 0);
        handler.closeBatch(0);
        assertEq(handler.burns(), 1, "burned");
        handler.processPayouts(0);
        handler.claimBase();
        assertEq(handler.baseClaims(), 1, "claimed on Base");
        _assertAll();
    }

    /// The rerun's counterexample (dece524, 3,000 x 64, seed 20261113, shrunk to 13 calls): the attacker burns all its
    /// shares at the door into a 38.985 TAO payout, about 26.2 TAO of it still staked (the rest liquid: its own door
    /// deposits, which the queue's reservation kept unstaked), earning for the holders for 24.5 days (about 0.32 TAO
    /// net); it re-enters with 19.6 TAO, which the reservation keeps liquid too, and the payout leaves, its walk taking
    /// only 6.19 TAO of stake (booked 46.757 -> 40.566 TAO), and the keeper claims: the schedule then vests 4% faster
    /// than the smaller stake accrues, and its new shares take their share of that, beyond its accrual share by
    /// 0.000533 TAO. The recapture term credits it, funded by the 6.19 TAO that left alone (0.0916 TAO, for the 0.023
    /// TAO of vest above the accrual over the next 27 days): within its time share.
    function test_aReentryAtThePayoutRecapturesOnlyWhatItsDepartedStakeEarned() public {
        handler.lateEntry(12796, 2182872980);
        handler.holderClaim(2947985107396947940935178913611161565230404056928931928201374608603305);
        handler.sameBatch(
            4301054148531007737071459656688556865000442231,
            54849951990852595777225088432317918565227809075951710,
            39233810531360130970748637625987
        );
        handler.lateEntry(2455, 17600);
        handler.closeBatch(1004631275115);
        handler.doorRequest(15016432, 16101);
        // the attacker's claim here (holderClaim(3613140) in the shrunk sequence) came mid-schedule, which R6b U1
        // refuses (NotKeeper): the keeper's claim at the same moment is the same restart
        handler.keeperClaim(0);
        handler.processPayouts(405352220);
        handler.closeBatch(81982815);
        handler.lateEntry(827845676448004557, 1028018770014);
        handler.processPayouts(115792089237316195423570985008687907853269984665640564039457584007913129639934);
        // the payout's walk took 6.19 TAO of booked stake: the pool holds that stake's bound alone (0.0916 TAO), not
        // what the 26.2 TAO of the queue still staked earned while it waited, nor the burned shares' forfeit
        assertGt(handler.recapturePool(), 0.09e18, "the walk's departed stake funded the pool");
        assertLt(handler.recapturePool(), 0.1e18, "only the stake that left");
        handler.keeperClaim(44374833426731600253220211024009044746574667148311304730059052000321779);
        handler.lateEntry(
            202494615624398364366984566880346480153468823448941632699563371684, 18469817972671164363714492583405035654
        );
        _assertAll();
        assertGt(handler.recaptured(), 0, "the vest above the accrual rate, recaptured");
        assertEq(handler.unfundedVest(), 0, "all of it funded by the attacker's departed stake");
    }

    /// Fix round 4's seeds (7222, shrunk to 6 calls), now with the adoption drip (Revision 27): the attacker enters
    /// late, the stranger gives 1.41 TAO of stake, the keeper claims, the attacker enters again, and the keeper adopts
    /// the gift 5.2 days before the first schedule ends. Before, that restart spread the schedule's last 0.0515 TAO of
    /// rewards over 30 more days, so after the next claim the schedule vested 3% faster than the stake accrued with no
    /// stake gone (0.0053 TAO above the accrual), which an adoption credit to the pool had to fund. Now the gift vests on
    /// its own drip and the claim schedule keeps its amount, start and period: with no departure and no credit at all,
    /// the vest never outruns the accrual (no vest above it, funded or not), and the attacker stays within its time
    /// share. The old behaviour's mutations fail here: the claim schedule restarted with the gift (the old code) or on
    /// its own remainder alone (the delay alone), first on the vest above the accrual.
    function test_anAdoptionNoLongerLetsTheVestOutrunTheAccrual() public {
        handler.lateEntry(2, 2984673100525377573602659128984051604119013);
        handler.gift(1650749588946);
        handler.keeperClaim(4123417804747011432889809042075760479);
        handler.lateEntry(42118383412653057493261712082581631917279639920817583418365722809325, 0);
        bytes32 claims =
            keccak256(abi.encode(vaultLens.vestingAmount(), vaultLens.vestingStart(), vaultLens.vestingPeriod()));
        handler.adopt();
        assertEq(handler.adoptions(), 1, "the gift adopted");
        bytes32 claimsAfter =
            keccak256(abi.encode(vaultLens.vestingAmount(), vaultLens.vestingStart(), vaultLens.vestingPeriod()));
        uint256 drip = vaultLens.adoptVestingAmount();
        handler.warp(7170853912840801672595857592877757569112539979370518719722835979977);
        assertGe(handler.rewardClaims(), 2, "a claim after the adoption");
        assertEq(handler.departedCredit(), 0, "no stake left");
        assertEq(handler.unfundedVest(), 0, "the vest never outran the accrual");
        assertEq(handler.recapturePool(), 0, "nothing credited");
        assertEq(handler.recaptured(), 0, "nothing to recapture");
        _assertAll();
        assertGt(drip, 1.4e18, "the gift on its own drip");
        assertEq(claimsAfter, claims, "the claim schedule (amount, start, period) untouched by the adoption");
    }

    /// The pool's cap (fix round 4's review, M-1): a credit never lifts the pool above the rewards still to vest (the
    /// claim schedule's unvested and the unclaimed rewards net of the cut). A day after the start the attacker's 20 TAO,
    /// staked, leaves directly: its walk's credit (about 0.3 TAO) is cut to the day's rewards.
    function test_thePoolNeverHoldsMoreThanTheRewardsStillToVest() public {
        handler.depositDirect(2, 20e9);
        handler.stakeIdle();
        handler.warp(1 days);
        handler.redeemDirect(0, 0);
        assertEq(handler.directExits(), 1, "it left directly");
        assertGt(handler.departedCredit(), 0, "its walk credited the pool");
        assertLe(handler.recapturePool(), _rewardsStillToVest(), "no more than the rewards still to vest");
        _assertAll();
    }

    /// R6b U1, the two-hotkey case (the multi-agent review's Medium): the owner moves a tenth of the stake onto the
    /// standby, which accrues at half the rate, and the keeper's round claims both. Fifteen days on, the standby's
    /// fallback is open and its rewards small: the stranger's claim of the standby alone is held NotKeeper while the
    /// claim schedule vests (before R6b it re-spread the whole schedule over 30 days from then). The keeper's next
    /// round, at the gap, claims both, and nothing vests above the accrual.
    function test_aStrangersStandbyClaimMidScheduleIsHeld() public {
        handler.moveToStandby(type(uint256).max);
        assertEq(handler.standbyMoves(), 1, "a tenth of the stake on the standby");
        // fifteen days of rewards on both, then the keeper's round starts the schedule
        handler.warp(15 days);
        handler.keeperClaim(0);
        assertGt(vaultLens.unvestedRewards(), 0, "a schedule vesting");
        handler.warp(15 days);
        assertGt(handler.standbyUnclaimedRao(), 0, "the standby's rewards accrued");
        // seed 3: the stranger, the standby
        handler.holderClaim(3);
        assertEq(handler.strangerClaims(), 1, "past the fallback");
        assertEq(handler.claimsHeldWhileVesting(), 1, "held: the schedule still vests");
        handler.warp(15 days);
        assertEq(handler.unfundedVest(), 0, "the vest never outran the accrual");
        _assertAll();
    }

    /// R7 (the R6b review's coverage note): a non-keeper's claim still opens once the claim schedule has fully vested.
    /// The keeper's round starts a schedule on day 10; claimAtVestEnd (seed 0: the attacker, the stake hotkey) passes
    /// time to its end, day 40, where the keeper's round is due too, and claims first: taken. The standby is idle, so
    /// the claim covers the round.
    function test_aClaimTheMomentTheScheduleHasVestedIsTaken() public {
        handler.warp(10 days);
        handler.keeperClaim(0);
        assertGt(vaultLens.unvestedRewards(), 0, "a schedule vesting");
        uint256 end = uint256(vaultLens.vestingStart()) + vaultLens.vestingPeriod();
        handler.claimAtVestEnd(0);
        assertEq(vm.getBlockTimestamp(), end, "at the schedule's end");
        assertEq(handler.holderClaims(), 1, "past the fallback");
        assertEq(handler.claimsHeldWhileVesting(), 0, "not held");
        assertEq(handler.outsideClaimsMade(), 1, "the attacker's claim taken");
        assertEq(handler.claimsAtVestEnd(), 1, "once the schedule had vested");
        handler.warp(1 hours);
        assertEq(handler.claimGapOverruns(), 0, "no claim gap overran");
        _assertAll();
    }

    /// The same with the standby holding stake: at the schedule's end the stranger claims the standby alone (seed 3),
    /// taken; the stake hotkey's round, due at that moment, follows at the next step that passes time, in the same
    /// second, so no claim gap overruns and nothing vests above the accrual.
    function test_aStrangersStandbyClaimAtTheVestedEndIsTakenAndTheRoundFollows() public {
        handler.moveToStandby(type(uint256).max);
        handler.warp(10 days);
        handler.keeperClaim(0);
        uint256 end = uint256(vaultLens.vestingStart()) + vaultLens.vestingPeriod();
        handler.claimAtVestEnd(3);
        assertEq(vm.getBlockTimestamp(), end, "at the schedule's end");
        assertEq(handler.strangerClaims(), 1, "past the fallback");
        assertEq(handler.outsideClaimsMade(), 1, "the stranger's claim taken");
        assertEq(handler.claimsAtVestEnd(), 1, "once the schedule had vested");
        assertGt(handler.unclaimedRao(), 0, "the stake hotkey's round still to come");
        uint256 forced = handler.forcedClaims();
        handler.warp(1 hours);
        assertEq(handler.forcedClaims(), forced + 1, "the round followed");
        assertEq(handler.claimGapOverruns(), 0, "no claim gap overran");
        assertEq(handler.unfundedVest(), 0, "the vest never outran the accrual");
        _assertAll();
    }

    /// Seed 9402's shrunk sequence (R7's calibration run), on the R6 campaign's own actions: the attacker's door deposit
    /// delivered by its retry (24.9 of 44.9 TAO, unstaked), then the owner moves part of the stake onto the standby,
    /// which accrues at half the rate, mid-schedule. The schedule still holds a month's rewards earned at the old rate,
    /// so over the next month it vests above the lower accrual, and the attacker, holding through it, gains its share of
    /// that: 0.0027 TAO beyond its bound when nothing funded it (unfundedVest 0.0049 TAO), whether the month passes by
    /// two warps or by the claim at the schedule's end. The move's credit to the pool (its rate given up x the moved
    /// stake x the vesting period, as a departure's) funds it, and the attacker's allowance takes its share.
    function test_aMoveOntoTheLowerRateStandbyMidScheduleIsCreditedLikeADeparture() public {
        handler.sameBatch(325535124, 893873308, 2220);
        handler.pauseVault(12260966772027404396469573077582809104);
        handler.lateEntry(1106149789387517483322146, 404443121730919273);
        handler.warp(49605778937179412897478876734253238048172864156841412701124350375);
        handler.closeBatch(154410185898457946680162931);
        handler.warp(762088691647042679676804831662929456891277659694291666837);
        handler.pauseVault(1543046439);
        handler.retryDelivery(10643463);
        assertGt(vault.balanceOf(handler.attacker()) * 2, vault.totalSupply(), "the attacker holds most of the shares");
        assertGt(handler.claimUnvested(), 0, "mid-schedule");
        handler.moveToStandby(371662216350774846407791573539688074712741992145333109899485170764932701253);
        assertEq(handler.standbyMoves(), 1, "a move onto the standby");
        uint256 moved = vm.snapshotState();

        handler.claimAtVestEnd(245515368610858629414324765406474699187566868130014532802957973062248119);
        assertEq(handler.claimsAtVestEnd(), 1, "the stranger's claim at the schedule's end");
        _assertAll();
        assertGt(handler.movedCredit(), 0, "the move credited the pool");
        assertEq(handler.unfundedVest(), 0, "the vest above the accrual funded");
        assertGt(handler.recaptured(), 0, "the attacker's share of it in its allowance");

        vm.revertToState(moved);
        handler.warp(15 days);
        handler.warp(15 days);
        assertEq(handler.unfundedVest(), 0, "the same by two warps");
        _assertAll();
    }

    /// Seed 9403's shrunk sequence (R6's final sweep; it fails the same way on the code before R6): an honest holder's
    /// door deposit closed while the vault is paused (the bridge files it), a donation, the attacker's late direct
    /// entry, and the attacker's retry of the filed batch. The retry mints the honest holder's deposit, whose rounding
    /// down lifts every holder's value, the attacker's 24 TAO of shares by 1 wei: dust from another holder's entry, which
    /// the campaign allows an actor that retries, as it allows it when another actor's retry prices the entry, and no
    /// gain the attacker made.
    function test_anAttackersRetryGainsOnlyAnotherEntrysRoundingDust() public {
        handler.doorDeposit(
            11119426813897890045475247104843980616326015651632689, 87984920030970017446472213140964104552808614
        );
        handler.pauseVault(8139244185244);
        handler.closeBatch(5456);
        handler.pauseVault(234966360661473456128056794195571501190);
        handler.donate(1017990912786);
        handler.lateEntry(1132437087083530315038, 1130);
        address m = handler.attacker();
        uint256 before = handler.wealthOf(m);
        uint256 shares = vault.balanceOf(m);
        handler.retryDelivery(618);
        assertEq(handler.retriesByAttacker(), 1, "the attacker retried");
        assertEq(vault.balanceOf(m), shares, "another holder's deposit");
        assertLe(handler.wealthOf(m), before + 1, "a wei of dust at most");
        _assertAll();
    }

    /// The claim schedule's unvested (the adoption drip's gifts are not rewards, Revision 27) and the unclaimed rewards
    /// net of the cut (wei), restated here apart from the handler's cap.
    function _rewardsStillToVest() internal view returns (uint256) {
        uint256 u = CascadeFormulas.unvestedRewards(
            vaultLens.vestingAmount(), vaultLens.vestingStart(), vaultLens.vestingPeriod()
        );
        uint256 c = (handler.unclaimedRao() + handler.standbyUnclaimedRao()) * RAO;
        return u + c - c * vaultLens.rewardCutBps() / 10_000;
    }

    /// The failure branch this world has, end to end: the attacker's door deposit and request closed while the vault is
    /// paused (the bridge files the delivery), three days of rewards vesting, the owner's unpause, and the attacker's
    /// retry at the moment it picks: the deposit counts at face meanwhile, is minted at the price of the retry, and the
    /// attacker gains nothing by the moment.
    function test_aDeliveryRefusedWhilePausedIsRetriedByTheAttackerForNothing() public {
        handler.depositDirect(2, 5e9);
        handler.warp(1 days + 1);
        handler.sameBatch(0, 4e9, 0);
        handler.pauseVault(0);
        assertTrue(vault.paused(), "paused");
        handler.closeBatch(0);
        assertEq(handler.failedDeliveries(), 1, "the paused vault refused the delivery, and the bridge filed it");
        handler.warp(3 days);
        handler.pauseVault(1);
        assertFalse(vault.paused(), "unpaused");
        handler.retryDelivery(0);
        assertEq(handler.retriesByAttacker(), 1, "the attacker retried");
        assertEq(handler.retriesDelivered(), 1, "delivered");
        assertEq(handler.burns(), 1, "its request burned at the retry's price");
        _assertAll();
    }

    /// The owner's cancel: the attacker's door request burned and queued, two days of rewards vesting (the price rises
    /// past the burn's), then the cancel: it re-mints at most the shares burned, so the attacker gets back no more
    /// than it was owed.
    function test_theOwnersCancelReMintsTheAttackerNoMoreThanItWasOwed() public {
        handler.depositDirect(2, 5e9);
        handler.warp(1 days + 1);
        handler.doorRequest(0, 0);
        handler.closeBatch(0);
        assertEq(handler.burns(), 1, "burned and queued");
        handler.warp(2 days);
        uint256 before = handler.wealthOf(handler.attacker());
        handler.ownerCancel(0);
        assertEq(handler.ownerCancels(), 1, "cancelled");
        assertGt(vault.balanceOf(handler.attacker()), 0, "re-minted");
        assertLe(handler.wealthOf(handler.attacker()), before + RAO, "no more than it was owed");
        _assertAll();
    }

    /// 29 days after the last claim on the honest 20 TAO, the attacker's 24 TAO directly (staked by the keeper), the
    /// keeper's forced claim at day 30, and 7 more days.
    function _lateEntry() internal {
        _warpTo(handler.lastClaimAt() + 29 days);
        handler.depositDirect(2, 24e9);
        handler.stakeIdle();
        _warpTo(handler.lastClaimAt() + 30 days);
        assertEq(handler.forcedClaims(), 1, "the keeper's claim at the vesting period");
        _warpTo(vm.getBlockTimestamp() + 7 days);
    }

    /// The handler's warps (at most 10 days each) until `t`.
    function _warpTo(uint256 t) internal {
        while (vm.getBlockTimestamp() < t) {
            handler.warp(t - vm.getBlockTimestamp());
        }
    }
}
