// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeVaultLens} from "../../src/lens/CascadeVaultLens.sol";
import {CascadeDoorLens} from "../../src/lens/CascadeDoorLens.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {ISTAKING_ADDRESS} from "../../src/interfaces/IStaking.sol";
import {CascadeFormulas} from "../../src/libraries/CascadeFormulas.sol";
import {CascadeMath} from "../../src/libraries/CascadeMath.sol";
import {ShortfallAbsorbed, Unstaked} from "../../src/CascadeEvents.sol";
import {VaultLayout} from "../../src/lens/generated/VaultLayout.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {MockBridge} from "../mocks/MockBridge.sol";
import {CampaignFixture} from "../utils/CampaignFixture.sol";
import {VaultInternals} from "../utils/VaultInternals.sol";
import {BoundaryInvariants} from "./BoundaryInvariants.sol";
import {MinimumHits} from "./MinimumHits.sol";
import {LedgerHandler} from "./handlers/LedgerHandler.sol";
import {TrackedHandler} from "./handlers/TrackedHandler.sol";
import {VaultModel} from "./handlers/VaultModel.sol";

/// @dev The ledger campaign (Task 35, spec §3.1; I-1 to I-6): random sequences over a hotkey set of up to four of the
/// handler's actions (LedgerHandler's notes): validators' swaps (whole, partial, retaining credits), strangers' adds,
/// removals, gifts and seeds of removed hotkeys, the keeper's listings, stakes (a credit landing inside some),
/// claims (as stake or balance, some with a fall), adoptions and payouts, the owner's removals, stake-hotkey
/// switches, scheduled moves and scheduled write-offs, the chain's losses, removal fee and fresh read, direct
/// deposits and exits (flagged while stake is missing), front-door deposits and redeems delivered by MockBridge, and
/// time. The vault takes a 10% reward cut (so the cut's I-1 half runs) and has a 10 TAO outflow floor (so the
/// allowance base, not the floor, bounds most burns: I-5). Inherits BoundaryInvariants (Task 34a): lens parity on
/// both lenses and token accounting after every step, the fixed libraries asserted in the setUp.
contract LedgerInvariantTest is CampaignFixture, BoundaryInvariants, MinimumHits {
    uint256 constant RAO = 1e9;
    uint256 constant PANIC = 0x4e487b71;

    MockStaking staking = MockStaking(ISTAKING_ADDRESS);
    VaultInternals vault;
    CascadeVaultLens vaultLens;
    CascadeFrontDoor fd;
    CascadeDoorLens doorLens;
    MockBridge bridge;
    LedgerHandler handler;

    /// A 10% reward cut to the treasury and the outflow floor at its lowest, 10 TAO.
    function campaignVaultParams(CascadeVault.Params memory p) internal view override {
        p.treasury = treasury;
        p.rewardCutBps = 1_000;
        p.minDailyOutflow = 10e18;
    }

    function setUp() public {
        Campaign memory c = deployCampaign();
        vault = c.vault;
        vaultLens = c.vaultLens;
        fd = c.fd;
        doorLens = c.doorLens;
        bridge = c.bridge;
        handler = new LedgerHandler(
            TrackedHandler.System(c.vault, c.vaultLens, c.fd, c.doorLens, owner, guardian),
            LedgerHandler.Parts(c.tao, c.bridge, HK1, BASE, treasury)
        );
        landed(Slot.Handler, address(handler));
        // the boundary invariants' targets; I-32's run-time half asserted here, once
        setBoundary(handler, c.vault, c.fd, c.vaultLens, c.doorLens);
        // pays every close's bridge fee
        vm.deal(address(handler), 100 ether);

        bytes4[] memory selectors = new bytes4[](27);
        selectors[0] = LedgerHandler.depositDirect.selector;
        selectors[1] = LedgerHandler.redeemDirect.selector;
        selectors[2] = LedgerHandler.depositWhileMissing.selector;
        selectors[3] = LedgerHandler.redeemDirectWhileMissing.selector;
        selectors[4] = LedgerHandler.stakeIdle.selector;
        selectors[5] = LedgerHandler.accrueAndClaim.selector;
        selectors[6] = LedgerHandler.adopt.selector;
        selectors[7] = LedgerHandler.swapAway.selector;
        selectors[8] = LedgerHandler.retainedSwapWithCredits.selector;
        selectors[9] = LedgerHandler.loseStake.selector;
        selectors[10] = LedgerHandler.strangerAddHotkey.selector;
        selectors[11] = LedgerHandler.seedRemovedHotkey.selector;
        selectors[12] = LedgerHandler.giftListed.selector;
        selectors[13] = LedgerHandler.reAddHotkey.selector;
        selectors[14] = LedgerHandler.removeHotkey.selector;
        selectors[15] = LedgerHandler.followStake.selector;
        selectors[16] = LedgerHandler.moveStake.selector;
        selectors[17] = LedgerHandler.writeOff.selector;
        selectors[18] = LedgerHandler.doorDeposit.selector;
        selectors[19] = LedgerHandler.doorRedeem.selector;
        selectors[20] = LedgerHandler.closeBatch.selector;
        selectors[21] = LedgerHandler.retryDelivery.selector;
        selectors[22] = LedgerHandler.processPayouts.selector;
        selectors[23] = LedgerHandler.warp.selector;
        selectors[24] = LedgerHandler.setRemoveFee.selector;
        selectors[25] = LedgerHandler.setFreshRead.selector;
        selectors[26] = LedgerHandler.moveIntoEmpty.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ---- I-1 to I-6 ----

    /// @dev I-1, no mispriced mint, no unconsented mispriced burn: no Deposited, DepositedDirect, Redeemed or
    /// RewardCutMinted while stake is missing (folded with the state armed before each call, and a cut checked after
    /// its claim too); no Deposited, DepositedDirect or RewardCutMinted while the vault is underwater, at any supply
    /// (a deposit read with the schedule written down at a supply of 0, the cut with it as it is); and every
    /// RedeemedDirect says acceptedMissing exactly when stake was missing and pays its shares' value at min(visible,
    /// booked), read on the mock's positions and the ghost ledger, floored to the rao, less what its leaver bore (what
    /// the walk left untaken and its cost, both measured on the mock, and as VaultModel predicts them: Task 36b); a
    /// flagged exit takes from the gross assets only what it paid and the chain kept, and moves no stayer's value down
    /// at all, nor up past the leaver's rounding.
    function invariant_noMispricedMintOrBurn() public view {
        assertEq(handler.mintsOrBurnsWhileMissing(), 0, "a mint or a burn while stake was missing");
        assertEq(handler.mintsWhileUnderwater(), 0, "a mint while the vault was underwater");
        assertEq(handler.guardMisses(), 0, "a mint at a supply of 0 underwater");
        assertEq(handler.directFlagMismatches(), 0, "a RedeemedDirect's flag is not the missing state it ran in");
        assertEq(handler.directMispaid(), 0, "a direct exit not paid its value at min(visible, booked)");
        assertEq(handler.missingMispaid(), 0, "a flagged exit took more than it paid and the chain kept");
        assertEq(handler.missingOthersMoved(), 0, "a stayer's value moved past its share or the rounding");
    }

    /// @dev I-2, ledger conservation, floored: the booked stake is the ghost ledger, which replays every stake-side
    /// measurement the handler makes on the mock's positions, each floored at 0 (a stake's gain at most what it paid,
    /// a claim's rise of the listed stake, every removal's fall, an adoption's visible stake, a write-off's
    /// min(rao, missing)); no claim lowers it; no exit reverts for a ledger reason (a panic; every other unpredicted
    /// refusal is noUnexpectedReverts'); every write-off books exactly what it logs.
    function invariant_ledgerConservedFloored() public view {
        assertEq(vaultLens.bookedStake(), handler.ghostBooked(), "the booked stake is not the measurements replayed");
        assertEq(handler.claimsLoweringLedger(), 0, "a claim lowered the ledger");
        assertEq(handler.exitPanics(), 0, "an exit reverted for a ledger reason");
        assertEq(handler.writeOffMisbooked(), 0, "a write-off booked other than min(rao, missing)");
        assertEq(handler.writeOffsBelowVisible(), 0, "a write-off took the booked stake below the visible");
    }

    /// @dev I-3, gifts do not move the price until adopted or unstaked into balance: a gift (root or alpha, on a listed
    /// hotkey, on a swap's unlisted one, or a stranger's seed of a removed one) books nothing, moves no price while
    /// nothing is missing and only makes up missing stake otherwise (by at most the ghost ledger less the mock's listed
    /// positions); an adoption moves no price and leaves no surplus; the surplus (visible above booked) is never more
    /// than what came from outside (gifts, and credits landing inside a stake); and after every step the vault's assets
    /// are min(visible, booked) priced on the mock's positions and the ghost ledger, plus the balance, less the
    /// reserve, the queued payouts and the unvested rewards: a gift reaches the price only once adopted (booked) or
    /// unstaked into balance.
    function invariant_giftsDoNotMoveThePrice() public view {
        assertEq(handler.giftsBooked(), 0, "a gift was booked");
        assertEq(handler.giftPriceMoves(), 0, "a gift moved the price");
        assertEq(handler.adoptPriceMoves(), 0, "an adoption moved the price");
        assertEq(handler.unexpectedAdoptions(), 0, "an adoption left a surplus");
        assertLe(
            vaultLens.surplusStakeRao(), handler.ghostGiftsRao() + handler.ghostCreditsRao(), "a surplus not given"
        );
        assertEq(
            vaultLens.totalAssets(), handler.ghostAssets(), "the assets are not min(visible, booked) on the ghosts"
        );
    }

    /// @dev I-4 in the ledger's states (Revision 23): the price never falls but by the exceptions the handler records,
    /// none of them an exit (visible below booked: a swap, a loss, a claim's fall, and the vault's own move only into an
    /// empty position with the short reads on, by at most a rao, any other fall across a move an overrun; the chain's
    /// cut of the owner's removal of a sub-minimum leftover, at most the removal fee a receipt; the 1-rao-short fresh
    /// read of a stake; at a supply of 0 the next mint's recorded gap), each checked against its bound; and a write-off
    /// never moves it. A walk's removal fee, across however many positions it takes, is the exit's own cost (Task 36b).
    function invariant_priceFallsOnlyByI4sExceptions() public view {
        assertGe(vaultLens.price(), handler.priceFloor(), "the price fell outside I-4's exceptions");
        assertEq(handler.exceptionOverruns(), 0, "an I-4 exception fell further than its bound");
        assertEq(handler.writeOffPriceMoves(), 0, "a write-off moved the price");
    }

    /// @dev I-35 (Revision 23, the founder's ruling of 2026-11-06): no exit lowers the holders' price. Around every
    /// direct exit (flagged or not) and every payout chunk sent, from the handler's own reads just before and after the
    /// call, (A' + 1)(S + 1e6) >= (A + 1)(S' + 1e6) exactly and the hole (the queued payouts and the unvested rewards
    /// above the gross) no larger, with no allowance at any removal fee and across any walk of the hotkey set.
    function invariant_noExitLowersThePrice() public view {
        assertEq(handler.exitPriceFalls(), 0, "I-35: an exit lowered the holders' price or widened the hole");
    }

    /// @dev I-5, the outflow base never exceeds min(visible, booked) less what is ramping: the ramp is the ghost's
    /// (every stake's gain over STAKE_RAMP, every removal's receipt off it), the base the vault computes from its
    /// storage is the ghost base (the mock's visible stake and the ghost ledger), and every burning delivery grew each
    /// window by no more than what the allowance on the ghost base left it.
    function invariant_outflowBaseBounded() public view {
        assertEq(vaultLens.rampingStake(), handler.ghostRamping(), "the ramp is not the stakes and receipts replayed");
        assertEq(vaultLens.lastStakeAt(), handler.ghostLastStakeAt(), "the ramp's clock");
        uint256 elapsed = block.timestamp - vaultLens.lastStakeAt();
        uint256 unspent = elapsed >= 1 days ? 0 : vaultLens.rampingStake() * (1 days - elapsed) / 1 days;
        uint256 base =
            CascadeFormulas.sub0(Math.min(vaultLens.visibleStakeRao(), vaultLens.bookedStake()) * RAO, unspent);
        assertEq(base, handler.ghostBase(), "the vault's base is not min(visible, booked) less the ramp");
        assertEq(handler.doorWindowOverruns(), 0, "a door's window past its allowance on the base");
        assertEq(handler.globalWindowOverruns(), 0, "the global window past its allowance on the base");
    }

    /// @dev I-6, permissionless recovery, under its stated preconditions (round 9 L-4): after every step that leaves
    /// stake missing, a stranger's way back (listing the swaps' never-listed hotkeys holding at least the chain's
    /// minimum, removing empty old hotkeys when the set is full) clears it exactly when those preconditions hold (the
    /// slots, the chain's minimum, empty old hotkeys); outside them the owner's immediate way back (removeHotkey, then
    /// the listings) clears it wherever it can reach the stake; a gift of the missing stake always clears it,
    /// harmlessly; no step of either plan is refused, whether or not the plan applies (each is one the spec allows its
    /// maker in that state); and no stranger ever lists a hotkey the vault once listed.
    function invariant_permissionlessRecovery() public view {
        assertEq(handler.strangerFailures(), 0, "a stranger's way back did not do what its preconditions say");
        assertEq(handler.ownerFailures(), 0, "the owner's immediate way back failed where it reaches the stake");
        assertEq(handler.giftFailures(), 0, "a gift of the missing stake did not clear it, or priced above booked");
        assertEq(handler.planRefusals(), 0, "a step a recovery plan may make was refused");
        assertEq(handler.strangerListedOnceListed(), 0, "a stranger listed a hotkey the vault once listed");
    }

    /// @dev The walk's removals (spec §3.10.11, Task 36's fix round 2): every direct exit and payout chunk the vault
    /// walked for logs exactly the Unstaked events the handler's restatement predicts before the call from the mock's
    /// positions (VaultModel's _checkWalk): the same hotkeys in order and each removal's wantRao, so no further
    /// position is stripped of the minimum stake for a remainder the tolerance covers, none is passed over, and none is
    /// asked other than the rule.
    function invariant_walkRemovesWhatTheModelPredicts() public view {
        assertEq(handler.walkMismatches(), 0, "a walk's Unstaked events were not the removals the model predicts");
    }

    /// @dev Every call refused only as its action and state predict (LedgerHandler's list), and no predicted refusal
    /// lost.
    /// The campaign also fails on any handler call that reverts (Task 34's M6, carried to Task 42: a call a handler does
    /// not wrap in a try, whose revert the fuzzer would otherwise drop): fail-on-revert for this invariant's campaign.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_noUnexpectedReverts() public view {
        assertEq(handler.unexpectedReverts(), 0);
    }

    /// @dev Successful calls per action, the states they ran in and the refusals as predicted; asserts nothing.
    function invariant_reachabilityLogged() public {
        emit log_named_uint("directDeposits", handler.directDeposits());
        emit log_named_uint("directRedeems", handler.directRedeems());
        emit log_named_uint("depositsRefusedWhileMissing", handler.depositsRefusedWhileMissing());
        emit log_named_uint("depositsRefusedInsolvent", handler.depositsRefusedInsolvent());
        emit log_named_uint("redeemsRefusedWhileMissing", handler.redeemsRefusedWhileMissing());
        emit log_named_uint("exitsUncoverable", handler.exitsUncoverable());
        emit log_named_uint("multiPositionWalks", handler.multiPositionWalks());
        emit log_named_uint("walksChecked", handler.walksChecked());
        emit log_named_uint("walksOfSeveralRemovals", handler.walksOfSeveralRemovals());
        emit log_named_uint("missingExits", handler.missingExits());
        emit log_named_uint("probesOfDepositsWhileMissing", handler.probesOfDepositsWhileMissing());
        emit log_named_uint("stakes", handler.stakes());
        emit log_named_uint("stakesWithCredit", handler.stakesWithCredit());
        emit log_named_uint("stakesWhileMissing", handler.stakesWhileMissing());
        emit log_named_uint("claims", handler.claims());
        emit log_named_uint("claimsToBalance", handler.claimsToBalance());
        emit log_named_uint("claimsWithFall", handler.claimsWithFall());
        emit log_named_uint("claimsWhileMissing", handler.claimsWhileMissing());
        emit log_named_uint("claimsOfCredits", handler.claimsOfCredits());
        emit log_named_uint("cutEvents", handler.cutEvents());
        emit log_named_uint("cutsSkippedWhileMissing", handler.cutsSkippedWhileMissing());
        emit log_named_uint("adoptions", handler.adoptions());
        emit log_named_uint("adoptionsRefused", handler.adoptionsRefused());
        emit log_named_uint("swapsMissing", handler.swapsMissing());
        emit log_named_uint("swapsWithinTolerance", handler.swapsWithinTolerance());
        emit log_named_uint("swapsOfTheStakeHotkey", handler.swapsOfTheStakeHotkey());
        emit log_named_uint("retainedSwaps", handler.retainedSwaps());
        emit log_named_uint("losses", handler.losses());
        emit log_named_uint("strangerAdds", handler.strangerAdds());
        emit log_named_uint("strangerAddsRefused", handler.strangerAddsRefused());
        emit log_named_uint("strangerAddsFillingTheLastSlot", handler.strangerAddsFillingTheLastSlot());
        emit log_named_uint("seedsRefused", handler.seedsRefused());
        emit log_named_uint("seedsRefusedWhileMissing", handler.seedsRefusedWhileMissing());
        emit log_named_uint("gifts", handler.gifts());
        emit log_named_uint("giftsWhileMissing", handler.giftsWhileMissing());
        emit log_named_uint("giftsUnlisted", handler.giftsUnlisted());
        emit log_named_uint("giftsAlpha", handler.giftsAlpha());
        emit log_named_uint("reAdds", handler.reAdds());
        emit log_named_uint("reAddsOfOnceListed", handler.reAddsOfOnceListed());
        emit log_named_uint("reAddsRefused", handler.reAddsRefused());
        emit log_named_uint("slotsReservedRefused", handler.slotsReservedRefused());
        emit log_named_uint("removalsByOwner", handler.removalsByOwner());
        emit log_named_uint("removalsMovingStake", handler.removalsMovingStake());
        emit log_named_uint("removalsIntoBalance", handler.removalsIntoBalance());
        emit log_named_uint("removalsByKeeper", handler.removalsByKeeper());
        emit log_named_uint("removalsByStranger", handler.removalsByStranger());
        emit log_named_uint("removalsRefused", handler.removalsRefused());
        emit log_named_uint("stakeHotkeySwitches", handler.stakeHotkeySwitches());
        emit log_named_uint("stakeHotkeySwitchesScheduled", handler.stakeHotkeySwitchesScheduled());
        emit log_named_uint("stakeHotkeySwitchesRefused", handler.stakeHotkeySwitchesRefused());
        emit log_named_uint("moves", handler.moves());
        emit log_named_uint("writeOffs", handler.writeOffs());
        emit log_named_uint("writeOffsOfSomething", handler.writeOffsOfSomething());
        emit log_named_uint("writeOffsReopening", handler.writeOffsReopening());
        emit log_named_uint("writeOffsTooLarge", handler.writeOffsTooLarge());
        emit log_named_uint("writeOffsUnscheduled", handler.writeOffsUnscheduled());
        emit log_named_uint("writeOffsEarly", handler.writeOffsEarly());
        emit log_named_uint("doorDeposits", handler.doorDeposits());
        emit log_named_uint("doorRedeems", handler.doorRedeems());
        emit log_named_uint("closes", handler.closes());
        emit log_named_uint("deliveries", handler.deliveries());
        emit log_named_uint("burningDeliveries", handler.burningDeliveries());
        emit log_named_uint("redeemsHeldBack", handler.redeemsHeldBack());
        emit log_named_uint("deliveriesRefusedWhileMissing", handler.deliveriesRefusedWhileMissing());
        emit log_named_uint("deliveriesRefusedUnderwater", handler.deliveriesRefusedUnderwater());
        emit log_named_uint("retriesDelivered", handler.retriesDelivered());
        emit log_named_uint("payoutChunks", handler.payoutChunks());
        emit log_named_uint("payoutsUncoverable", handler.payoutsUncoverable());
        emit log_named_uint("chunksRefusedWalkCost", handler.chunksRefusedWalkCost());
        emit log_named_uint("exitsRefusedByCost", handler.exitsRefusedByCost());
        emit log_named_uint("depositedEvents", handler.depositedEvents());
        emit log_named_uint("depositedDirectEvents", handler.depositedDirectEvents());
        emit log_named_uint("redeemedEvents", handler.redeemedEvents());
        emit log_named_uint("directRedeemEvents", handler.directRedeemEvents());
        emit log_named_uint("flaggedDirectRedeems", handler.flaggedDirectRedeems());
        emit log_named_uint("feeSwitches", handler.feeSwitches());
        emit log_named_uint("readSwitches", handler.readSwitches());
        emit log_named_uint("i4Swaps", handler.i4Swaps());
        emit log_named_uint("i4Losses", handler.i4Losses());
        emit log_named_uint("i4ClaimFalls", handler.i4ClaimFalls());
        emit log_named_uint("i4MoveShorts", handler.i4MoveShorts());
        emit log_named_uint("moveIntoEmptyDraws", handler.moveIntoEmptyDraws());
        emit log_named_uint("i4RemovalCuts", handler.i4RemovalCuts());
        emit log_named_uint("i4FreshReads", handler.i4FreshReads());
        emit log_named_uint("i4GapsAbsorbed", handler.i4GapsAbsorbed());
        emit log_named_uint("exitsCharged", handler.exitsCharged());
        emit log_named_uint("exitsPriceChecked", handler.exitsPriceChecked());
        emit log_named_uint("recoveryProbes", handler.recoveryProbes());
        emit log_named_uint("probesStranger", handler.probesStranger());
        emit log_named_uint("probesNotASwap", handler.probesNotASwap());
        emit log_named_uint("probesSeededOnly", handler.probesSeededOnly());
        emit log_named_uint("probesSubMinimum", handler.probesSubMinimum());
        emit log_named_uint("probesOldNotEmpty", handler.probesOldNotEmpty());
        emit log_named_uint("probesSlotsShort", handler.probesSlotsShort());
        emit log_named_uint("probesOwner", handler.probesOwner());
        emit log_named_uint("probesGiftOnly", handler.probesGiftOnly());
        _logHitTotals();
    }

    // ---- B9: the named states' minimum hits in a long run (MinimumHits) ----

    function _hitTag() internal pure override returns (string memory) {
        return "ledger";
    }

    /// The ledger's named states for this campaign (the Task 35 carry: i4MoveShorts, unreached in campaign runs
    /// before), each with its minimum over 3,000 runs at depth 64.
    /// Each minimum is MinimumHits' rule (a quarter of the slowest seed's projection). A minimum of 0 is logged, not
    /// asserted: i4GapsAbsorbed and deliveriesRefusedUnderwater (a supply of 0 underwater, pinned in the core file and
    /// BittensorParking.t.sol), chunksRefusedWalkCost (asserted in the payout campaign, through its walk-cost draw;
    /// pinned by LeaverPays' test_aBounceAWalksCostWouldZeroIsRefused) and exitsUncoverable (about 1 in 3,000 runs in
    /// the first long run).
    function _hits() internal view override returns (Hit[] memory h) {
        h = new Hit[](10);
        h[0] = Hit("i4MoveShorts", handler.i4MoveShorts(), 140);
        h[1] = Hit("i4GapsAbsorbed", handler.i4GapsAbsorbed(), 0);
        h[2] = Hit("i4FreshReads", handler.i4FreshReads(), 34);
        h[3] = Hit("deliveriesRefusedUnderwater", handler.deliveriesRefusedUnderwater(), 0);
        h[4] = Hit("payoutsUncoverable", handler.payoutsUncoverable(), 2);
        h[5] = Hit("chunksRefusedWalkCost", handler.chunksRefusedWalkCost(), 0);
        h[6] = Hit("exitsUncoverable", handler.exitsUncoverable(), 0);
        h[7] = Hit("strangerAddsFillingTheLastSlot", handler.strangerAddsFillingTheLastSlot(), 48);
        h[8] = Hit("writeOffsReopening", handler.writeOffsReopening(), 8);
        h[9] = Hit("probesSlotsShort", handler.probesSlotsShort(), 265);
    }

    function _all() internal view {
        invariant_noMispricedMintOrBurn();
        invariant_ledgerConservedFloored();
        invariant_giftsDoNotMoveThePrice();
        invariant_priceFallsOnlyByI4sExceptions();
        invariant_outflowBaseBounded();
        invariant_permissionlessRecovery();
        invariant_walkRemovesWhatTheModelPredicts();
        invariant_noExitLowersThePrice();
        invariant_noUnexpectedReverts();
        invariant_tokenAccounting();
    }

    // ---- scripted states: each way back, the write-off, the checks' non-vacuity ----

    /// alice's `amount` deposited directly and staked on HK1 (exact reads): booked and visible.
    function _funded(uint256 amount) internal {
        handler.depositDirect(0, amount / RAO);
        handler.stakeIdle(1);
        assertEq(vaultLens.bookedStake(), amount / RAO);
        assertEq(handler.ghostBooked(), amount / RAO);
    }

    /// I-6 proper: a 10 TAO vault whose validator swaps 40% of HK1 to a fresh hotkey. Stake is missing, the probe after
    /// the swap finds the stranger's way back open (one free slot or more, the swap's hotkey above the chain's minimum,
    /// never listed) and clears it inside its snapshot; then the stranger's own listing clears it for real, at the
    /// price the booked stake prices.
    function test_aStrangerListsTheSwapsNewHotkey() public {
        _funded(10e18);
        handler.swapAway(0, 4_000);
        assertTrue(vaultLens.stakeMissing());
        assertEq(handler.recoveryProbes(), 1);
        assertEq(handler.probesStranger(), 1);
        bytes32 target = handler.swapTargets()[0];
        // the stranger's candidate draw: seed 0 names the swap's hotkey holding the most stake off the list
        handler.strangerAddHotkey(0);
        assertEq(handler.strangerAdds(), 1);
        assertTrue(vaultLens.isHotkey(target));
        assertFalse(vaultLens.stakeMissing());
        assertEq(vaultLens.totalAssets(), 10e18, "the price the booked stake prices");
        _all();
    }

    /// I-6's first precondition, the chain's minimum: in a 1 TAO vault (tolerance 0.001 TAO), a swap of 0.15% moves
    /// 1.5M rao, past the tolerance and under the 2M-rao minimum: no stranger may list it (refused NotEligible), so the
    /// probe classes it subMinimum and the owner's way back (a listing into a free slot) is the expected path; a gift
    /// clears it too.
    function test_aSubMinimumSwapIsTheOwnersOrAGifts() public {
        _funded(1e18);
        handler.swapAway(0, 15);
        assertTrue(vaultLens.stakeMissing());
        assertEq(handler.probesSubMinimum(), 1);
        assertEq(handler.probesOwner(), 1);
        handler.strangerAddHotkey(0);
        assertEq(handler.strangerAddsRefused(), 1, "NotEligible: under the chain's minimum");
        assertTrue(vaultLens.stakeMissing());
        handler.giftListed(0, 1_500_000);
        assertFalse(vaultLens.stakeMissing(), "a gift clears it");
        assertEq(vaultLens.bookedStake(), 1e9, "the gift booked nothing");
        _all();
    }

    /// I-6 with two swaps and one free slot: HK2 and HK3 listed, each holding 3 TAO (moved within the set), both
    /// swapped away whole. The stranger's way back needs an old hotkey removed first, which it may make (the set full,
    /// stake missing, the old hotkey empty and owed nothing): the probe clears it, and so does the real sequence.
    function test_twoSwapsOneFreeSlotNeedARemovalFirst() public {
        _funded(10e18);
        // HK2 and HK3 listed (the candidate draw 4 names the vault's own hotkeys; the lister, by seed mod 5, is
        // privileged)
        handler.reAddHotkey(4 + 8 * 1);
        handler.reAddHotkey(4 + 8 * 2);
        assertEq(vaultLens.hotkeyCount(), 3);
        vm.startPrank(address(vault));
        staking.moveStake(HK1, handler.HK2(), 0, 0, 3e9);
        staking.moveStake(HK1, handler.HK3(), 0, 0, 3e9);
        vm.stopPrank();
        handler.swapAway(1, 10_000);
        handler.swapAway(2, 10_000);
        assertTrue(vaultLens.stakeMissing());
        assertEq(handler.probesStranger(), 2, "both probes: the stranger's way back applies");
        assertEq(handler.strangerFailures(), 0);
        // the real sequence: list the first (the last slot), remove an emptied old hotkey, list the second
        bytes32[] memory t = handler.swapTargets();
        vm.prank(handler.stranger());
        vault.addHotkey(t[0]);
        assertTrue(vaultLens.stakeMissing());
        vm.prank(handler.stranger());
        vault.removeHotkey(handler.HK2(), false);
        vm.prank(handler.stranger());
        vault.addHotkey(t[1]);
        assertFalse(vaultLens.stakeMissing());
        _all();
    }

    /// I-6's third precondition: HK2 holds 3 TAO and HK3 1 TAO; HK2's validator swaps it retaining 25% on HK2 with
    /// credits; with the set then full (the swap's hotkey listed) a second swap leaves stake missing, and no old hotkey
    /// is empty, so no stranger can free a slot: the probe classes it oldNotEmpty, and the owner's immediate
    /// removeHotkey (each leftover moved onto the stake hotkey, the credits forfeited) and listing is the way back.
    function test_aRetainedPositionLeavesTheWayBackToTheOwner() public {
        _funded(10e18);
        handler.reAddHotkey(4 + 8 * 1);
        handler.reAddHotkey(4 + 8 * 2);
        bytes32 hk2 = handler.HK2();
        bytes32 hk3 = handler.HK3();
        vm.startPrank(address(vault));
        staking.moveStake(HK1, hk2, 0, 0, 3e9);
        staking.moveStake(HK1, hk3, 0, 0, 1e9);
        vm.stopPrank();
        handler.retainedSwapWithCredits(1, 7_500, 5_000_000);
        bytes32 first = handler.swapTargets()[0];
        // the keeper lists the swap's hotkey into the last slot (stake is missing: 2.25 TAO under it)
        assertTrue(vaultLens.stakeMissing());
        handler.reAddHotkey(0);
        assertTrue(vaultLens.isHotkey(first));
        assertEq(vaultLens.hotkeyCount(), 4);
        assertFalse(vaultLens.stakeMissing());
        // a second swap, of HK1
        handler.swapAway(0, 5_000);
        assertTrue(vaultLens.stakeMissing());
        assertEq(handler.probesOldNotEmpty(), 1);
        assertEq(handler.probesOwner(), 1);
        assertEq(handler.ownerFailures(), 0);
        _all();
    }

    /// A loss (stake gone for good) is not a swap's: no listing can clear it, so neither the stranger's nor the owner's
    /// way back applies and only a gift or the owner's write-off can. The write-off runs through its schedule: the
    /// owner's direct call refused NotScheduled, an execute before its 7 days refused NotReady, then the execute,
    /// which writes off exactly the loss, moves no price, and reopens minting.
    function test_aLossIsTheWriteOffsAndItRunsThroughItsSchedule() public {
        _funded(10e18);
        // seed 0 acts (one draw in four) on the first listed hotkey with stake
        handler.loseStake(0, 2e9);
        assertTrue(vaultLens.stakeMissing());
        assertEq(handler.probesNotASwap(), 1);
        assertEq(handler.probesGiftOnly(), 1);
        uint256 price = vaultLens.price();
        // mode 0: the direct call first, the bound itself as the amount
        handler.writeOff(0, 0);
        assertEq(handler.writeOffsUnscheduled(), 1);
        assertEq(handler.writeOffsEarly(), 1);
        assertEq(handler.writeOffs(), 1);
        assertEq(handler.writeOffsReopening(), 1);
        assertEq(vaultLens.bookedStake(), 8e9, "the loss written off");
        assertFalse(vaultLens.stakeMissing());
        assertGe(vaultLens.price(), price, "no fall: the price already read the loss");
        handler.depositDirect(1, 1e9);
        assertEq(handler.directDeposits(), 2, "minting reopened");
        _all();
    }

    /// The write-off's bound, missing less unlisted (M-1): a swap of 2 TAO (unlisted) and a loss of 1 TAO leave 3 TAO
    /// missing, of which only the loss can go; one rao past it is refused WriteOffTooLarge at execute (the item kept),
    /// and the bound itself runs, leaving the swap's 2 TAO missing for a listing.
    function test_aWriteOffPastMissingLessUnlistedIsRefused() public {
        _funded(10e18);
        handler.swapAway(0, 2_000);
        handler.loseStake(0, 1e9);
        assertEq(vaultLens.missingStakeRao(), 3e9);
        assertEq(handler.unlistedRao(), 2e9);
        // mode 1 << 5: one rao past the bound; no direct call (bit 3 set)
        handler.writeOff(0, (1 << 5) | (1 << 3));
        assertEq(handler.writeOffsTooLarge(), 1);
        assertEq(vaultLens.bookedStake(), 10e9);
        handler.writeOff(0, 1 << 3);
        assertEq(handler.writeOffs(), 1);
        assertEq(vaultLens.bookedStake(), 9e9, "the loss alone");
        assertTrue(vaultLens.stakeMissing(), "the swap's 2 TAO are still missing, under its hotkey");
        _all();
    }

    /// A stranger seeds a hotkey the vault once listed (HK2, listed and removed by the keeper) with the chain's minimum
    /// while stake is missing: its listing is refused NotEligible (I-6: never a hotkey the vault ever listed), the
    /// seed moves no price and is unlisted stake, which blocks as much write-off.
    function test_aSeededRemovedHotkeyIsNeverAStrangers() public {
        _funded(10e18);
        handler.reAddHotkey(4 + 8 * 1);
        // the keeper removes HK2 (empty, owed nothing): the draw (seed >> 1) % 4 == 1, index (seed >> 3) % n == 1
        handler.removeHotkey((1 << 3) | (1 << 1));
        assertFalse(vaultLens.isHotkey(handler.HK2()));
        assertGt(vaultLens.lastClaimAt(handler.HK2()), 0);
        handler.swapAway(0, 4_000);
        handler.seedRemovedHotkey(0, 5e9);
        assertEq(handler.seedsRefusedWhileMissing(), 1);
        assertEq(handler.strangerListedOnceListed(), 0);
        assertEq(handler.unlistedRao(), 9e9, "the swap's 4 TAO and the seed's 5");
        _all();
    }

    /// The probes are not vacuous: with the vault's addHotkey made to fail, the stranger's way back that its plan says
    /// applies does not clear the state, its refused add counts, and invariant_permissionlessRecovery fails.
    function test_theRecoveryProbesCanFail() public {
        _funded(10e18);
        vm.mockCallRevert(address(vault), abi.encodeWithSelector(CascadeVault.addHotkey.selector), "");
        handler.swapAway(0, 4_000);
        assertEq(handler.strangerFailures(), 1);
        assertEq(handler.planRefusals(), 1, "the plan's add refused");
        vm.expectRevert();
        this.invariant_permissionlessRecovery();
    }

    /// The ghost ledger is not vacuous: a booked stake moved by one rao behind the vault's back fails I-2.
    function test_theGhostLedgerCanFail() public {
        _funded(10e18);
        invariant_ledgerConservedFloored();
        bytes32 slot = bytes32(VaultLayout.SLOT_LEDGER + VaultLayout.LEDGER_BOOKED_SLOT);
        vm.store(address(vault), slot, bytes32(uint256(vm.load(address(vault), slot)) + 1));
        vm.expectRevert();
        this.invariant_ledgerConservedFloored();
    }

    /// The handler's restatement of the unstake walk (VaultModel's _walk and _exitPlan) is the vault's: over up to three
    /// listed positions (HK1 the stake hotkey, HK2 and HK3 beside it, each from nothing to 4 TAO, some under the chain's
    /// minimum), a removal fee up to 0.02 TAO, and an exit of a fuzzed value, the handler's verdict is whether the
    /// vault's own redeemDirect pays or reverts, and with which error (UnstakeShort past T untaken, ZeroAmount when the
    /// walk's cost leaves nothing); on a payment the leaver is paid exactly the predicted floorToRao(out - unmet -
    /// cost) and bears unmet + cost (ShortfallAbsorbed; Task 36b), and its predicted removals are the vault's (Task 36's
    /// fix round 2): its Unstaked events, in order, are the predicted hotkeys and asks, each position left with what
    /// was not asked of it (nothing when taken whole).
    function testFuzz_theWalkRestatementIsTheVaults(uint256 s2, uint256 s3, uint256 fee, uint256 shares) public {
        _funded(10e18);
        handler.reAddHotkey(4 + 8 * 1);
        handler.reAddHotkey(4 + 8 * 2);
        vm.startPrank(address(vault));
        staking.moveStake(HK1, handler.HK2(), 0, 0, bound(s2, 0, 4e9));
        staking.moveStake(HK1, handler.HK3(), 0, 0, bound(s3, 0, 4e9));
        vm.stopPrank();
        staking.setRemoveFeeRao(bound(fee, 0, 20_000_000));
        address alice = handler.actors(0);
        shares = bound(shares, 1, vault.balanceOf(alice));
        uint256 out = CascadeMath.assetsForRedeem(shares, vaultLens.totalAssets(), vault.totalSupply());
        out -= out % RAO;
        vm.assume(out != 0);
        assertEq(handler.availableAt(vaultLens.pendingPayouts()), 0, "the walk is asked the whole exit");
        VaultModel.ExitOut memory e = handler.exitPlanOf(0, out);
        VaultModel.Removal[] memory walk = e.walk;
        uint256[] memory before = new uint256[](walk.length);
        for (uint256 i; i < walk.length; ++i) {
            before[i] = staking.getStake(walk[i].hotkey, vaultLens.coldkey(), 0);
        }
        uint256 paidBefore = alice.balance;
        vm.recordLogs();
        vm.prank(alice);
        (bool ok, bytes memory ret) = address(vault).call(abi.encodeCall(CascadeVault.redeemDirect, (shares, false)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(ok, e.refusal == 0, "the restatement and the vault disagree");
        if (!ok) {
            assertEq(bytes4(ret), e.refusal, "the refusal the restatement predicts");
            return;
        }
        assertEq(alice.balance - paidBefore, e.paid, "paid out less what was unmet and the walk's cost");
        uint256 borne;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == ShortfallAbsorbed.selector) {
                borne = abi.decode(logs[i].data, (uint256));
            }
        }
        assertEq(borne, e.unmet + e.cost, "the leaver bore what was unmet and the walk's cost");
        uint256 k;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault) || logs[i].topics[0] != Unstaked.selector) continue;
            assertLt(k, walk.length, "a removal the model does not predict");
            (uint256 wantRao,) = abi.decode(logs[i].data, (uint256, uint256));
            assertEq(logs[i].topics[1], walk[k].hotkey, "the walk's order");
            assertEq(wantRao, walk[k].wantRao, "the walk's ask");
            uint256 left = staking.getStake(walk[k].hotkey, vaultLens.coldkey(), 0);
            assertEq(left, walk[k].full ? 0 : before[k] - walk[k].wantRao, "what the removal left");
            ++k;
        }
        assertEq(k, walk.length, "a removal the model predicts, not made");
    }

    /// The walk skips a position under the chain's minimum: with 1,500,000 rao on HK2 (under the 2,000,000-rao
    /// minimum), alice's full exit cannot be covered past the tolerance, so the handler predicts UnstakeShort and the
    /// vault reverts it (exitsUncoverable), a state the campaign's depth-64 sweep did not reach (Task 35).
    function test_aPositionUnderTheMinimumLeavesAnExitUncoverable() public {
        _funded(10e18);
        handler.reAddHotkey(4 + 8 * 1);
        bytes32 hk2 = handler.HK2();
        vm.prank(address(vault));
        staking.moveStake(HK1, hk2, 0, 0, 1_500_000);
        address alice = handler.actors(0);
        handler.redeemDirect(0, vault.balanceOf(alice));
        assertEq(handler.exitsUncoverable(), 1);
        assertEq(vault.balanceOf(alice), 1e25, "nothing burned");
        _all();
    }

    // ---- the review's pins (Task 35, fix round 1) ----

    /// HK1, the stake hotkey, swapped away whole (its 10 TAO under the swap's new hotkey, which the stranger then
    /// lists), and the mock's short reads turned on: the vault's next move onto the empty stake hotkey reads one rao
    /// short. Returns the swap's hotkey.
    function _anEmptyStakeHotkeyWithShortReads() internal returns (bytes32 target) {
        _funded(10e18);
        handler.swapAway(0, 10_000);
        target = handler.swapTargets()[0];
        assertEq(staking.getStake(HK1, vaultLens.coldkey(), 0), 0, "the stake hotkey is empty");
        // seed 0 names the swap's hotkey holding the most stake off the list
        handler.strangerAddHotkey(0);
        assertTrue(vaultLens.isHotkey(target));
        assertFalse(vaultLens.stakeMissing());
        // seed 1: a credit into an empty position reads one rao short
        handler.setFreshRead(1);
        assertFalse(staking.exactStakeReads());
    }

    /// I-4's first exception across the vault's own move, bounded (the review's Important 1): the owner's scheduled
    /// move of 5 TAO from the listed swap's hotkey into the empty stake hotkey, the short reads on, lands one rao
    /// short. The move books nothing, so visible sits one rao below booked and the assets fall by a rao. The handler
    /// records it (the destination held nothing, the reads were short, the fall is a rao) and counts no overrun; any
    /// other fall across the vault's own move would be one.
    function test_aMoveIntoAnEmptyPositionReadShortIsI4sException() public {
        bytes32 target = _anEmptyStakeHotkeyWithShortReads();
        // seed 0: the first listed hotkey holding stake, the swap's (HK1 holds none)
        handler.moveStake(0, 5e9);
        assertEq(handler.moves(), 1);
        assertEq(staking.getStake(HK1, vaultLens.coldkey(), 0), 5e9 - 1, "one rao short");
        assertEq(staking.getStake(target, vaultLens.coldkey(), 0), 5e9);
        assertEq(vaultLens.bookedStake(), 10e9, "a move books nothing");
        assertEq(vaultLens.totalAssets(), 10e18 - RAO, "the rao the read kept");
        assertEq(handler.i4MoveShorts(), 1, "recorded as I-4's first exception");
        assertEq(handler.exceptionOverruns(), 0, "within its bound of a rao");
        _all();
    }

    /// The same exception across the owner's removal of the swap's hotkey (the review's Important 1): its 10 TAO move
    /// onto the empty stake hotkey with the short reads on and land one rao short; recorded, no overrun.
    function test_aRemovalMovingIntoAnEmptyPositionReadShortIsI4sException() public {
        bytes32 target = _anEmptyStakeHotkeyWithShortReads();
        // seed 8: (8 >> 3) % 2 == 1, the swap's hotkey; (8 >> 1) % 4 == 0, the owner; (8 >> 2) % 2 == 0, no forfeit
        handler.removeHotkey(8);
        assertEq(handler.removalsMovingStake(), 1);
        assertFalse(vaultLens.isHotkey(target));
        assertEq(staking.getStake(HK1, vaultLens.coldkey(), 0), 10e9 - 1, "one rao short");
        assertEq(vaultLens.totalAssets(), 10e18 - RAO);
        assertEq(handler.i4MoveShorts(), 1, "recorded as I-4's first exception");
        assertEq(handler.exceptionOverruns(), 0, "within its bound of a rao");
        _all();
    }

    /// A walk across three positions is the leaver's, every removal's fee (Task 36b; before, the stayer absorbed the
    /// first two receipts' fees): alice's 9 TAO and bob's 1 TAO staked and spread over HK1 (4 TAO, the stake hotkey),
    /// HK2 (3 TAO) and HK3 (3 TAO), the chain's removal fee at 1,000 rao. alice's full exit walks all three, HK1 and HK2
    /// whole and HK3 for the 2 TAO the stake taken leaves (at face value: no fee in the ask), each receipt 1,000 rao
    /// short of the stake it took. So the receipts are 3,000 rao short in all, alice bears all of it (ShortfallAbsorbed:
    /// nothing untaken, the cost 3,000 rao), and bob, the stayer, loses nothing.
    function test_aThreePositionExitAtTheTopFeeIsTheLeavers() public {
        handler.depositDirect(0, 9e9);
        handler.depositDirect(1, 1e9);
        handler.stakeIdle(1);
        assertEq(vaultLens.bookedStake(), 10e9);
        handler.reAddHotkey(4 + 8 * 1);
        handler.reAddHotkey(4 + 8 * 2);
        vm.startPrank(address(vault));
        staking.moveStake(HK1, handler.HK2(), 0, 0, 3e9);
        staking.moveStake(HK1, handler.HK3(), 0, 0, 3e9);
        vm.stopPrank();
        staking.setRemoveFeeRao(1_000);
        address alice = handler.actors(0);
        address bob = handler.actors(1);
        uint256 bobBefore = _valueOf(bob);
        uint256 aliceBefore = alice.balance;
        uint256 shortBefore = handler.ghostReceiptShort();
        handler.setKeepLogs(true);
        handler.redeemDirect(0, vault.balanceOf(alice));
        Vm.Log[] memory logs = handler.stepLogs();
        handler.setKeepLogs(false);
        uint256 receipts;
        uint256 unmet;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault)) continue;
            if (logs[i].topics[0] == Unstaked.selector) ++receipts;
            if (logs[i].topics[0] == ShortfallAbsorbed.selector) unmet = abi.decode(logs[i].data, (uint256));
        }
        assertEq(handler.directRedeems(), 1);
        assertEq(handler.multiPositionWalks(), 1);
        assertEq(receipts, 3, "three receipts");
        assertEq(handler.walksOfSeveralRemovals(), 1, "the three removals the model predicts");
        assertEq(handler.walkMismatches(), 0);
        assertEq(handler.ghostReceiptShort() - shortBefore, 3_000 * RAO, "the receipts 3,000 rao short in all");
        assertEq(unmet, 3_000 * RAO, "alice bears every removal's fee");
        assertEq(alice.balance - aliceBefore, 9e18 - 3_000 * RAO);
        assertEq(_valueOf(bob), bobBefore, "the stayer loses nothing");
        assertEq(staking.getStake(handler.HK3(), vaultLens.coldkey(), 0), 1e9, "HK3 asked 2 TAO, no more");
        assertEq(handler.i4RemovalCuts(), 0, "no I-4 exception");
        assertEq(handler.exitsCharged(), 1);
        assertEq(handler.exceptionOverruns(), 0);
        _all();
    }

    /// A flagged exit of nearly every share at a removal fee, the campaign's shrunk sequence (found by Task 35's fix
    /// round's whole-suite run): alice's 33.93 TAO staked with a 1,000,000-rao credit landing inside the stake, 15.77
    /// TAO lost, a 13,520,973-rao claim as stake (it vests whole: stake is missing), a fee of 872 rao, then alice's
    /// flagged exit of all but 2 shares. Its value is all of the assets, and the walk takes HK1 whole (its remainder
    /// would be under the chain's minimum); the leaver pays the chain's 872 rao (Task 36b: before, they came out of
    /// the stake backing the unvested rewards and holed the schedule), so the gross falls by exactly what was paid and
    /// what the chain kept, and lands exactly on the unvested rewards: the total assets read 0 with no hole, and the 2
    /// shares lose nothing (I-35).
    function test_aFlaggedExitOfNearlyEverythingAtAFeePaysTheFee() public {
        handler.depositDirect(0, 33_931_984_029);
        // creditSeed 4e6: a credit of 1,000,000 rao lands inside the stake
        handler.stakeIdle(4_000_000);
        handler.loseStake(0, 15_766_555_769);
        // modeSeed 5: paid as stake, no fall
        handler.accrueAndClaim(0, 13_520_973, 5);
        // seed 2617: 2617 % 3 != 0, a fee of 2617 / 3 = 872 rao
        handler.setRemoveFee(2617);
        assertEq(staking.removeFeeRao(), 872);
        assertTrue(vaultLens.stakeMissing());
        address alice = handler.actors(0);
        uint256 assets = vaultLens.totalAssets();
        uint256 gross = vaultLens.grossAssets();
        uint256 unvested = vaultLens.unvestedRewards();
        uint256 aliceBefore = alice.balance;
        handler.redeemDirectWhileMissing(0, vault.balanceOf(alice) - 2);
        assertEq(handler.missingExits(), 1);
        assertEq(alice.balance - aliceBefore, assets - 872 * RAO, "the leaver is paid all of the assets less the fee");
        assertEq(gross - vaultLens.grossAssets(), assets, "the gross falls by the pay and the fee");
        assertEq(vaultLens.unvestedRewards(), unvested);
        assertEq(vaultLens.grossAssets(), unvested, "the schedule whole: no hole");
        assertEq(vaultLens.totalAssets(), 0, "exactly 0");
        assertEq(vault.totalSupply(), 2);
        assertEq(handler.missingMispaid(), 0);
        assertEq(handler.missingOthersMoved(), 0);
        assertEq(handler.exceptionOverruns(), 0);
        _all();
    }

    function _valueOf(address a) internal view returns (uint256) {
        return CascadeMath.assetsForRedeem(vault.balanceOf(a), vaultLens.totalAssets(), vault.totalSupply());
    }

    /// The probes' class for a gap only a once-listed hotkey's stake could fill (the review's Minor 8): a loss of 2 TAO
    /// on HK1, then a stranger's seed of 5 TAO on HK2, which the keeper listed and removed. Before the seed no unlisted
    /// stake could clear it (notASwap); after it only HK2's could, and no stranger may list HK2, so the probe classes
    /// it seededOnly, not subMinimum, and the owner's listing of HK2 is the way back.
    function test_aGapOnlyASeededHotkeyFillsIsTheOwners() public {
        _funded(10e18);
        handler.reAddHotkey(4 + 8 * 1);
        // the keeper removes HK2 (empty, owed nothing): the draw (seed >> 1) % 4 == 1, index (seed >> 3) % n == 1
        handler.removeHotkey((1 << 3) | (1 << 1));
        assertFalse(vaultLens.isHotkey(handler.HK2()));
        handler.loseStake(0, 2e9);
        assertEq(handler.probesNotASwap(), 1);
        handler.seedRemovedHotkey(0, 5e9);
        assertEq(handler.seedsRefusedWhileMissing(), 1);
        assertEq(handler.probesSeededOnly(), 1, "only the seeded, once-listed hotkey could fill the gap");
        assertEq(handler.probesSubMinimum(), 0);
        assertEq(handler.probesOwner(), 1, "the owner's listing of it is the way back");
        _all();
    }

    // ---- the spec's two fuzz tests, through the campaign's handler ----

    /// Random swaps against the tolerance (spec §3.1 Fuzz): a vault of 0.01 to 100 TAO, a swap of 1 to 10,000 bps.
    /// The guard trips exactly past max(0.1% of the booked stake, 0.001 TAO); the price reads min(visible, booked) at
    /// once; within the tolerance a deposit still mints and an unflagged exit still burns, past it both are refused
    /// StakeMissing and the probe's ways back hold; a stranger's listing of the swap's hotkey then clears it whenever
    /// that holds the chain's minimum. Every invariant holds after.
    function testFuzz_swapsAgainstTheTolerance(uint256 amount, uint256 bps) public {
        amount = bound(amount, 0.01e18 / RAO, 100e18 / RAO) * RAO;
        _funded(amount);
        bps = bound(bps, 1, 10_000);
        uint256 booked = vaultLens.bookedStake();
        handler.swapAway(0, bps);
        uint256 moved = booked * bps / 10_000;
        uint256 tolerance = Math.max(booked * 10 / 10_000, 1_000_000);
        assertEq(vaultLens.stakeMissing(), moved > tolerance, "the guard trips exactly past the tolerance");
        assertEq(vaultLens.totalAssets(), amount - moved * RAO, "priced at min(visible, booked) at once");
        handler.depositDirect(1, 1e6);
        handler.redeemDirect(0, 1);
        if (moved > tolerance) {
            assertEq(handler.depositsRefusedWhileMissing(), 1);
            assertEq(handler.redeemsRefusedWhileMissing(), 1);
            if (moved >= vaultLens.minStakeRao()) {
                handler.strangerAddHotkey(0);
                assertFalse(vaultLens.stakeMissing(), "the stranger's listing clears it");
            }
        } else {
            assertEq(handler.directDeposits(), 2, "a swap within the tolerance still mints");
        }
        _all();
    }

    /// Random gifts against full exits (spec §3.1 Fuzz), through the campaign: alice and bob deposit 10 TAO each,
    /// staked; a gift of 1 rao to 100 TAO lands on HK1 (or on HK2 beside it); every holder's full exit then runs, none
    /// reverting (no underflow), none paid any of the gift; the ledger ends at 0 and what is left is the gift, liquid
    /// where a removal took it, else still unpriced surplus. Every invariant holds after.
    function testFuzz_giftsAgainstFullExits(uint256 giftRao, bool onHk2) public {
        handler.depositDirect(0, 10e9);
        handler.depositDirect(1, 10e9);
        handler.stakeIdle(1);
        giftRao = bound(giftRao, 1, 100e9);
        uint256 seed;
        if (onHk2) {
            handler.reAddHotkey(4 + 8 * 1);
            // index 1 of the list: HK2
            seed = 1 << 3;
        }
        handler.giftListed(seed, giftRao);
        address alice = handler.actors(0);
        address bob = handler.actors(1);
        uint256 a = alice.balance;
        uint256 b = bob.balance;
        handler.redeemDirect(0, vault.balanceOf(alice));
        handler.redeemDirect(1, vault.balanceOf(bob));
        assertEq(vault.totalSupply(), 0, "every holder exited");
        assertLe(alice.balance - a, 10e18, "alice is paid none of the gift");
        assertLe(bob.balance - b, 10e18, "bob is paid none of the gift");
        assertGe(alice.balance - a, 10e18 - RAO);
        assertGe(bob.balance - b, 10e18 - RAO);
        assertEq(vaultLens.bookedStake(), 0, "the ledger floored at 0");
        _all();
    }
}
