// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm, VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeVaultLens} from "../../src/lens/CascadeVaultLens.sol";
import {CascadeDoorLens} from "../../src/lens/CascadeDoorLens.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {ISTAKING_ADDRESS} from "../../src/interfaces/IStaking.sol";
import {CascadeMath} from "../../src/libraries/CascadeMath.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {CascadePayoutMath} from "../../src/libraries/CascadePayoutMath.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {MockBridge} from "../mocks/MockBridge.sol";
import {MockTAO} from "../mocks/MockTAO.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {VaultLayout} from "../../src/lens/generated/VaultLayout.sol";
import {CampaignFixture} from "../utils/CampaignFixture.sol";
import {VaultInternals} from "../utils/VaultInternals.sol";
import {DoorInternals} from "../utils/DoorInternals.sol";
import {WordKinds, doorLensViews, vaultLensViews} from "../utils/LensViews.sol";
import {BoundaryInvariants} from "./BoundaryInvariants.sol";
import {FrontDoorInvariants} from "./FrontDoorInvariants.sol";
import {MinimumHits} from "./MinimumHits.sol";
import {CoreHandler} from "./handlers/CoreHandler.sol";
import {TrackedHandler} from "./handlers/TrackedHandler.sol";
import {Actor, DoorState, Item, Kind, PayoutBatch} from "../../src/CascadeTypes.sol";
import {RedeemReversed, Transfer} from "../../src/CascadeEvents.sol";
import {STAKE_RAMP} from "../../src/CascadeConstants.sol";

/// Test only: a handler that takes no action, whose `_onLogs` is fed forged logs (I-34's negative test).
contract ForgedLogsHandler is TrackedHandler {
    constructor(System memory s) TrackedHandler(s) {}

    /// Feeds the fold a vault Transfer(from, to, value) that no call emitted.
    function forgeTransfer(address from, address to, uint256 value) external {
        Vm.Log[] memory logs = new Vm.Log[](1);
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = Transfer.selector;
        topics[1] = bytes32(uint256(uint160(from)));
        topics[2] = bytes32(uint256(uint160(to)));
        logs[0] = VmSafe.Log(topics, abi.encode(value), address(vault));
        _onLogs(logs);
    }
}

/// @dev Random sequences of front-door deposits, redeem requests and cancels, batch closes (delivered at
/// once by MockBridge; by a stale id or with a minimum at random), payouts (at a drawn fee, with and without a
/// top-up), claims, USDC deliveries, direct deposits and redeems, staking, root rewards with and without a reward
/// cut, payout cancels, rare simulated losses (which can make the vault insolvent, so deliveries bounce deposits),
/// stake gifts from outside, deposit-stake-redeem cycles through the keeper, validator swaps that leave stake
/// missing across calls (and flagged exits, refused deliveries and their retries while it is), the chain's removal
/// fee and one-rao-short fresh read switched at random, and time jumps, over the EndToEnd fixture: the vault on
/// BITTENSOR, one front door on BASE, bridge fee 1e15, redeem-request fee 1e14. The front door's closes draw the Base
/// lane's fee per send (the world's 1e15, at most the pot, or 0 to 1e15; put back after), send a fuzzed extra, are
/// forced as a request's self-close (selfClose) and carry their pot's remainder, which the owner sweeps (sweepPot;
/// Task 29's follow-up). The owner's loosenings run through the scheduler fixture (Schedule, Task 11).
/// v3: the front door's keeper is the handler, its swapper a CascadeStaker (swap fee 15 bps) selling
/// through a mock router, its oracle a mock TWAP; the vault's treasury takes the reward cut and never
/// acts. Only the handler's actions are fuzzed. The vault's deposit cap and the front door's are raised
/// so that neither is ever why a call fails. Task 34 moved the handler to handlers/CoreHandler.sol and re-based the
/// invariants on v3.2's rules (I-4 exactly as spec §3.1 states it); Task 34c tightened the cancel's bound to its dust.
/// Task 34a deploys it through CampaignFixture (the vault and the front door as their test-only subclasses), adds the
/// launch door's removals and ways back, and inherits BoundaryInvariants: lens parity on both lenses and token
/// accounting after every step, the fixed libraries asserted in the setUp.
contract CascadeInvariantTest is CampaignFixture, BoundaryInvariants, FrontDoorInvariants, MinimumHits {
    uint256 constant RAO = 1e9;

    MockStaking staking = MockStaking(ISTAKING_ADDRESS);
    MockTAO tao;
    MockUSDC usdc;
    MockBridge bridge;
    /// The vault as its test-only subclass, so the handler can read its ramping stake (ruling DA10) and the lens
    /// parity invariant its internal values; it adds no storage and no behaviour. Runs under [profile.parity].
    VaultInternals vault;
    /// The handler's lens on `vault` (spec §8.1).
    CascadeVaultLens vaultLens;
    /// The front door as its test-only subclass (DoorInternals, for the door lens's parity), as a CascadeFrontDoor.
    CascadeFrontDoor fd;
    /// The read-only lens on `fd` (spec §8.1).
    CascadeDoorLens doorLens;
    CoreHandler handler;

    function setUp() public {
        Campaign memory c = deployCampaign();
        tao = c.tao;
        usdc = c.usdc;
        bridge = c.bridge;
        vault = c.vault;
        fd = c.fd;
        vaultLens = c.vaultLens;
        doorLens = c.doorLens;
        handler = new CoreHandler(
            TrackedHandler.System(c.vault, c.vaultLens, c.fd, c.doorLens, owner, guardian),
            c.tao,
            c.bridge,
            HK1,
            BASE,
            CoreHandler.V3(c.usdc, c.staker, c.router, c.twap, c.shortPayer, treasury)
        );
        landed(Slot.Handler, address(handler));
        assertEq(doorLens.keeper(), address(handler));
        assertEq(vaultLens.keeper(), address(handler));
        // the boundary invariants' targets; I-32's run-time half asserted here, once
        setBoundary(handler, c.vault, c.fd, c.vaultLens, c.doorLens);
        // the front-door invariants' handler and tokens (FrontDoorInvariants)
        setFrontDoors(handler, IERC20(address(c.tao)), IERC20(address(c.usdc)));
        // pays every close's bridge fee and every payout's top-up
        vm.deal(address(handler), 100 ether);

        bytes4[] memory selectors = new bytes4[](34);
        selectors[0] = CoreHandler.deposit.selector;
        selectors[1] = CoreHandler.requestRedeem.selector;
        selectors[2] = CoreHandler.cancelDeposit.selector;
        selectors[3] = CoreHandler.cancelRedeem.selector;
        selectors[4] = CoreHandler.closeBatch.selector;
        selectors[5] = CoreHandler.processPayouts.selector;
        selectors[6] = CoreHandler.claim.selector;
        selectors[7] = CoreHandler.depositDirect.selector;
        selectors[8] = CoreHandler.redeemDirect.selector;
        selectors[9] = CoreHandler.stakeIdle.selector;
        selectors[10] = CoreHandler.accrueAndClaim.selector;
        selectors[11] = CoreHandler.warp.selector;
        selectors[12] = CoreHandler.cancelQueued.selector;
        selectors[13] = CoreHandler.simulateLoss.selector;
        selectors[14] = CoreHandler.claimWithCut.selector;
        selectors[15] = CoreHandler.deliver.selector;
        selectors[16] = CoreHandler.gift.selector;
        selectors[17] = CoreHandler.cycle.selector;
        selectors[18] = CoreHandler.redeemDirectWhileMissing.selector;
        selectors[19] = CoreHandler.setVesting.selector;
        selectors[20] = CoreHandler.adopt.selector;
        selectors[21] = CoreHandler.selfClose.selector;
        selectors[22] = CoreHandler.sweepPot.selector;
        selectors[23] = CoreHandler.swapAway.selector;
        selectors[24] = CoreHandler.restoreStake.selector;
        selectors[25] = CoreHandler.retryDelivery.selector;
        selectors[26] = CoreHandler.setRemoveFee.selector;
        selectors[27] = CoreHandler.setFreshRead.selector;
        selectors[28] = CoreHandler.removeDoor.selector;
        selectors[29] = CoreHandler.reopenDoor.selector;
        selectors[30] = CoreHandler.stake.selector;
        selectors[31] = CoreHandler.removeTwice.selector;
        selectors[32] = CoreHandler.partialThenCancel.selector;
        selectors[33] = CoreHandler.deliverThin.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev I-4 (spec §3.1, Revision 23): the price never falls but by I-4's exceptions, none of them an exit, each
    /// recorded by the handler step that caused it, which checks the fall against its bound (exceptionOverruns) and
    /// restarts the floor from the price after it: visible stake below booked (swapAway), a simulated loss
    /// (simulateLoss), the 1-rao-short read of a fresh position (stakeIdle), at a supply of 0 the next mint, from the
    /// gap one of these recorded, and the owner's cancel over a hole one of these left (to the handler's cancelFloor,
    /// the floor alone, less 1 rao per re-minted entry: cancelQueued, its own counters in invariant_cancelDustBounded).
    /// No other tolerance: every other step's rounding is the vault's, and a walk's removal fee is the walking exit's
    /// own cost (Task 36b: the short-receipt exception is gone).
    function invariant_priceFallsOnlyByI4sExceptions() public view {
        assertGe(vaultLens.price(), handler.priceFloor(), "the price fell outside I-4's exceptions");
        assertEq(handler.exceptionOverruns(), 0, "an I-4 exception fell further than its bound");
    }

    /// @dev I-4's cancel bound: a cancel leaves the price no lower than the handler's cancelFloor, the floor before it,
    /// with nothing given back but over a hole a recorded exception left with the assets reading 0 (there 1 rao per
    /// re-minted entry, and at a supply of 0 the payout gap or the whole shortfall the re-minted holders absorb, at most
    /// their value). Each entry gets the shares its value buys at the price before the cancel, never more than it
    /// burned (Task 34c), so the delay's rewards stay with the holders who stayed, and while totalAssets() reads above
    /// 0 the price cannot fall at all (I-35 checks every cancel but one over such a hole).
    function invariant_cancelDustBounded() public view {
        assertEq(handler.cancelDustViolations(), 0, "a cancel fell further than its dust");
        assertEq(handler.cancelFallsWithAssets(), 0, "a cancel lowered the price while assets read above 0");
    }

    /// @dev The vault holds every wei delivered or deposited, less every wei sent out, plus every claimed reward and
    /// every stake gift, less every simulated loss and every wei the chain kept (a walk's removal fees, which the
    /// walking exit bore, Task 36b; a fresh read's rao).
    /// What it holds is its root stake under every hotkey of its coldkey and its balance above ED: the gross (which
    /// prices min(visible, booked), Task 12) plus the surplus (gifts no removal or adoption has taken in, I-3) plus the
    /// unlisted stake (a swap's, while it lasts). Every rao missing from the set sits under that unlisted hotkey. The
    /// identity reads the coldkey's total, so the vault's visible read is pinned beside it to the mock's own positions:
    /// the listed hotkey's stake, and the swap's hotkey's as the unlisted stake.
    function invariant_grossAssetsConserved() public view {
        // ordered so nothing underflows
        assertEq(
            vaultLens.grossAssets() + (vaultLens.surplusStakeRao() + vaultLens.unlistedStakeRao()) * RAO,
            handler.ghostIn() + handler.ghostRewards() + handler.ghostGifts() - handler.ghostOut() - handler.ghostLoss()
                - handler.ghostReceiptShort() - handler.ghostReadShort()
        );
        bytes32 cold = vaultLens.coldkey();
        assertEq(vaultLens.visibleStakeRao(), staking.getStake(HK1, cold, 0), "the visible read is the listed stake");
        assertEq(
            vaultLens.unlistedStakeRao(),
            staking.getStake(handler.SWAPPED(), cold, 0),
            "the unlisted read is the swap's"
        );
        assertLe(vaultLens.missingStakeRao(), vaultLens.unlistedStakeRao(), "stake missing that no hotkey holds");
    }

    /// @dev Every reserved wei belongs to a batch still in the queue.
    function invariant_pendingPayoutsMatchQueue() public view {
        uint256 sum;
        uint256 n = handler.queuedCount();
        for (uint256 i; i < n; ++i) {
            sum += vaultLens.getPayoutBatch(handler.queuedKeys(i)).remaining;
        }
        assertEq(sum, vaultLens.pendingPayouts());
    }

    /// @dev I-15, checked on every burning delivery (a retried one too) against the allowance base the vault computed
    /// (rebuilt from its storage), with gifts, swaps and keeper cycles in the mix: the door's window within its
    /// allowance, and the global one (Task 17) within the global allowance, each on its own counter (with the
    /// handler's one door the two windows burn together, and only their percentages differ).
    function invariant_burnWindowsRespected() public view {
        assertEq(handler.doorWindowViolations(), 0, "a door's window above its allowance");
        assertEq(handler.globalWindowViolations(), 0, "the global window above its allowance");
    }

    /// @dev I-36 (spec §3.5, R4 B-H1, the door hold), checked at every door burn against the handler's own model of each
    /// holder's fresh shares (CoreHandler's _noteFresh: the door's mints and the direct deposits, each mint while the run
    /// is held moving its clock to the share-weighted mean, held until a day after it): no door burn ever leaves a holder
    /// with fewer shares than that. And a floor on no restated formula (the R4 review, Minor 4): no delivery burns the
    /// shares it minted itself.
    function invariant_aDoorNeverBurnsFreshShares() public view {
        assertEq(handler.freshBurns(), 0, "a door burned fresh shares");
        assertEq(handler.mintBurns(), 0, "a delivery burned shares it minted itself");
    }

    /// @dev I-36's bound on the vault's own record (R6 A, ChatGPT R2 claim A): no holder's fresh shares, as the vault
    /// reads them (freshOf: the bucket while its clock is younger than STAKE_RAMP, else 0), ever exceed its balance, so
    /// a later mint's clock weighs only shares the holder still holds. A mint raises both; a door's burn never takes the
    /// balance below them; a direct exit lowers the bucket to the balance it leaves; a cancel's re-mint raises only the
    /// balance.
    function invariant_freshSharesNeverAboveTheBalance() public view {
        for (uint256 i; i < 3; ++i) {
            address a = handler.actors(i);
            (uint64 since, uint128 stored) = vaultLens.freshShares(a);
            uint256 fresh = vm.getBlockTimestamp() < uint256(since) + STAKE_RAMP ? stored : 0;
            assertLe(fresh, vault.balanceOf(a), "a holder's fresh shares above its balance");
        }
    }

    /// @dev Checked at each gift and cycle on the ledger and the base the vault computes: a gift is never booked
    /// (bookedStake() unchanged, I-3), and moves neither the base nor the price, but for the missing stake it makes
    /// up, by which both may rise (never fall); capital cycled through the keeper (deposit, stake, redeem) never
    /// raises the base, and leaves it exactly where it was, less what its receipts came back short, when the booked
    /// stake ends no lower than it began.
    function invariant_giftsAndCyclesHoldTheBase() public view {
        assertEq(handler.giftsBooked(), 0, "a gift was booked");
        assertEq(handler.giftBaseRises(), 0, "a gift raised the base");
        assertEq(handler.giftPriceMoves(), 0, "a gift moved the price");
        assertEq(handler.cycleBaseMoves(), 0, "a cycle moved the base");
    }

    /// @dev The keeper's adoptions of the gifts (Task 16, I-3, I-4) move no price at the adoption (the gift vests),
    /// leave no surplus behind (the ledger books exactly the visible stake), run only when due (a surplus of at least
    /// the chain's minimum, a day after the last adoption), and leave the claim schedule as it was (Revision 27: the
    /// gift vests on its own drip).
    function invariant_anAdoptionMovesNoPriceAndBooksTheSurplus() public view {
        assertEq(handler.adoptPriceMoves(), 0, "an adoption moved the price");
        assertEq(
            handler.unexpectedAdoptions(), 0, "an adoption not due, one that left a surplus or moved the claim schedule"
        );
    }

    /// @dev The surplus stake (visible above booked) is never more than the gifts: no removal books less than
    /// the stake it took, and the vault never books what it did not measure (I-2, I-3; Task 12).
    function invariant_surplusNeverAboveTheGifts() public view {
        assertLe(vaultLens.surplusStakeRao() * RAO, handler.ghostGifts());
    }

    // The front door's holdings, I-18 in both forms, the sweep's bound and I-21 are FrontDoorInvariants' (shared with
    // the doors campaign since Task 37): invariant_frontDoorIdentities, invariant_aCloserNeverReceivesMoreThanItSent,
    // invariant_theFeePotIsAccounted and invariant_potCarriedNeverAboveTheUnowedEth, over the one door here.

    /// @dev Users claim or have delivered at most what the vault paid out, and the front door owes
    /// exactly the rest.
    function invariant_claimsNeverExceedPayouts() public view {
        uint256 out = handler.ghostClaimed() + handler.ghostDelivered();
        assertLe(out, handler.ghostPayoutsReceived());
        assertEq(fd.totalClaimable(), handler.ghostPayoutsReceived() - out);
    }

    /// @dev A reward claim, with or without a cut, leaves the share price where it was: the rest of the
    /// claim vests, and the cut is minted at the pre-claim price, rounded down. So the price never falls,
    /// and it rises by less than one share's rounding: one more share would have taken it back to or
    /// below the pre-claim price. Near the launch price (a share is worth a millionth of a wei) that is
    /// at most +1 in the price's 18 decimals, as test_cutLeavesPriceUnchanged checks; where shares are
    /// coarse (rewards vesting into a vault with no shares, see
    /// test_cutIntoEmptyVaultRoundsByLessThanOneShare) one share's rounding is more than that. A cut minted at a
    /// supply of 0 absorbs the payout gap I-4's exceptions recorded (spec §3.1: "the cut only with nothing
    /// vesting"), so the handler records its price after with that gap given back.
    function invariant_cutNeverMovesPrice() public view {
        uint256 n = handler.claimCount();
        for (uint256 i; i < n; ++i) {
            uint256 before = handler.claimPriceBefore(i);
            assertGe(handler.claimPriceAfter(i), before, "claim lowered the price");
            assertLe(handler.claimPriceOneMoreShare(i), before, "claim raised the price by a share or more");
        }
    }

    /// @dev The owner's vesting period changes (Task 15; setVesting: up at once, down as its executed item) move no
    /// price, and no restart, a claim's of the claim schedule or an adoption's of its own drip (Task 16, Revision 27),
    /// ends a carried remainder sooner than its own schedule did (_restartPeriod keeps the longer of the period in
    /// force and what was left).
    function invariant_aPeriodChangeMovesNoPriceAndSpeedsNoRemainder() public view {
        assertEq(handler.vestingPriceMoves(), 0, "a period change moved the price");
        assertEq(handler.remaindersSpedUp(), 0, "a restart sped a carried remainder up");
    }

    /// @dev I-30 (spec §3.7): a delivery never settles below the user's, the keeper's or the TWAP floor. Every successful
    /// delivery paid the user at least each of its three floors as the handler computed them apart (the user's floor
    /// rounded up, the keeper's minimum, the oracle's own value of the credit less 1.5%) and at least their largest, and
    /// none went out after the user's deadline. A delivery needs a deposit, a close, a redeem, a close and a payout
    /// first, so this campaign runs four times deeper than the others.
    /// forge-config: default.invariant.depth = 256
    function invariant_deliveryNeverBelowFloor() public view {
        uint256 n = handler.deliveryCount();
        for (uint256 i; i < n; ++i) {
            uint256 got = handler.deliveryReceived(i);
            assertGe(got, handler.deliveryFloor(i), "delivery below its floor");
            assertGe(got, handler.deliveryUserFloor(i), "I-30: delivery below the user's floor");
            assertGe(got, handler.deliveryKeeperFloor(i), "I-30: delivery below the keeper's floor");
            assertGe(got, handler.deliveryTwapFloor(i), "I-30: delivery below the TWAP floor");
        }
        assertEq(handler.lateDeliveries(), 0, "delivery after its deadline");
    }

    /// @dev I-31 (spec §3.7): no delivery settles while a pool's mean liquidity is below the floor (the deliver action
    /// thins one pool one draw in eight through the oracle double's depth, MockTwap.setMeanLiquidity: each such delivery
    /// is refused ThinPool, and a delivery that settles is checked against the depth the oracle reads in its block), and
    /// no stake settles more than 5% below the oracle's value (the stake action, Task 42: a route paying around the
    /// floor, the stake's TAO measured from what the route paid against 95% of the oracle's value of the USDC swapped).
    function invariant_noThinPoolOrUnderFloorStake() public view {
        assertEq(handler.thinDeliveries(), 0, "I-31: a delivery settled while a pool was below its floor");
        assertEq(handler.stakesBelowFloor(), 0, "I-31: a stake settled more than 5% below the oracle's value");
    }

    /// @dev I-1 under fuzzing (Task 13), now with stake missing across calls (swapAway, Task 34): while stake is
    /// missing no direct deposit mints and no unflagged direct redeem burns (each reverts StakeMissing, whichever
    /// action makes it), and a flagged exit pays exactly its shares' value at min(visible, booked) floored to the rao,
    /// less what its leaver bore (what its walk left untaken and the walk's cost, Task 36b), takes exactly that and what
    /// the chain kept out of the assets, and leaves every other holder's redeemable value unchanged to the wei but for
    /// the leaver's rounding, which only ever raises it.
    function invariant_consentedExitWhileMissingTakesNothingFromTheOthers() public view {
        assertEq(handler.guardMisses(), 0, "a mint or an unconsented burn while stake was missing");
        assertEq(handler.missingMispaid(), 0, "a flagged exit paid other than the floor price");
        assertEq(handler.missingOthersMoved(), 0, "a stayer's value fell, or rose past the rounding");
    }

    /// @dev The walk's removals (spec §3.10.11, Task 36's fix round 2): every payout chunk, direct exit and cycle the
    /// vault walked for logs exactly the Unstaked events the handler's restatement predicts before the call from the
    /// mock's position (VaultModel's _checkWalk): with the one listed hotkey, at most one removal, at the walk's ask
    /// or the whole position, and none when the free balance covers the call.
    function invariant_walkRemovesWhatTheModelPredicts() public view {
        assertEq(handler.walkMismatches(), 0, "a walk's Unstaked events were not the removals the model predicts");
    }

    /// @dev I-35 (Revision 23, the founder's ruling of 2026-11-06): no exit lowers the holders' price. Around every
    /// payout chunk sent (the keeper's, and through deliver), every direct exit paid (redeemDirect, the flagged exit,
    /// the cycle's) and every cancel, from the handler's own reads just before and after the call, (A' + 1)(S + 1e6) >=
    /// (A + 1)(S' + 1e6) exactly and the hole (the queued payouts and the unvested rewards above the gross) no larger,
    /// with no allowance at any removal fee; exempt only a cancel that starts with totalAssets() reading 0 over a hole
    /// a recorded exception (a loss, a swap, a fresh read) left. And I-13's direct half: an unflagged direct exit is
    /// paid exactly floorToRao(out - unmet - cost), `unmet` and `cost` measured from the coldkey's stake drop and the
    /// vault's balance, its ShortfallAbsorbed their sum, and all as VaultModel predicts, its walk's cost the leaver's
    /// (the flagged exit's pay is invariant_consentedExitWhileMissingTakesNothingFromTheOthers').
    function invariant_noExitLowersThePrice() public view {
        assertEq(handler.exitPriceFalls(), 0, "I-35: an exit lowered the holders' price or widened the hole");
        assertEq(handler.directMispaid(), 0, "I-13: a direct exit paid other than its value less its own cost");
    }

    /// @dev Every call refused only as its action and state predict (the handler's list, CoreHandler's notes), and
    /// no predicted refusal lost.
    /// The campaign also fails on any handler call that reverts (Task 34's M6, carried to Task 42: a call a handler does
    /// not wrap in a try, whose revert the fuzzer would otherwise drop): fail-on-revert for this invariant's campaign.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_noUnexpectedReverts() public view {
        assertEq(handler.unexpectedReverts(), 0);
    }

    /// @dev Successful calls per action, and the states they ran in, to show each one is reached; asserts nothing.
    function invariant_reachabilityLogged() public {
        emit log_named_uint("deposits", handler.deposits());
        emit log_named_uint("redeemRequests", handler.redeemRequests());
        emit log_named_uint("depositCancels", handler.depositCancels());
        emit log_named_uint("cancelsTooSoon", handler.cancelsTooSoon());
        emit log_named_uint("redeemCancels", handler.redeemCancels());
        emit log_named_uint("closes", handler.closes());
        emit log_named_uint("closesWithExtra", handler.closesWithExtra());
        emit log_named_uint("potsCarried", handler.potsCarried());
        emit log_named_uint("selfCloses", handler.selfCloses());
        emit log_named_uint("sweeps", handler.sweeps());
        emit log_named_uint("wrongBatches", handler.wrongBatches());
        emit log_named_uint("tooSmallCloses", handler.tooSmallCloses());
        emit log_named_uint("deliveries", handler.deliveries());
        emit log_named_uint("payoutChunks", handler.payoutChunks());
        emit log_named_uint("partialChunks", handler.partialChunks());
        emit log_named_uint("topUpChunks", handler.topUpChunks());
        emit log_named_uint("payoutsFeeRefused", handler.payoutsFeeRefused());
        emit log_named_uint("payoutsUncoverable", handler.payoutsUncoverable());
        emit log_named_uint("chunksRefusedWalkCost", handler.chunksRefusedWalkCost());
        emit log_named_uint("exitsRefusedByCost", handler.exitsRefusedByCost());
        emit log_named_uint("claims", handler.claims());
        emit log_named_uint("directDeposits", handler.directDeposits());
        emit log_named_uint("directRedeems", handler.directRedeems());
        emit log_named_uint("walksChecked", handler.walksChecked());
        emit log_named_uint("i4ShortfallHolesAbsorbed", handler.i4ShortfallHolesAbsorbed());
        emit log_named_uint("stakes", handler.stakes());
        emit log_named_uint("rewardClaims", handler.rewardClaims());
        emit log_named_uint("cancels", handler.cancels());
        emit log_named_uint("cancelsOverAHole", handler.cancelsOverAHole());
        emit log_named_uint("cancelsAfterPartial", handler.cancelsAfterPartial());
        emit log_named_uint("redeemDeferred", handler.redeemDeferred());
        emit log_named_uint("redeemSkipped", handler.redeemSkipped());
        emit log_named_uint("freshHolds", handler.freshHolds());
        emit log_named_uint("losses", handler.losses());
        emit log_named_uint("gifts", handler.gifts());
        emit log_named_uint("cycles", handler.cycles());
        emit log_named_uint("cyclesIntoOlderStake", handler.cyclesIntoOlderStake());
        emit log_named_uint("depositBounces", handler.depositBounces());
        emit log_named_uint("bouncesPaid", handler.bouncesPaid());
        emit log_named_uint("bouncesCarried", handler.bouncesCarried());
        emit log_named_uint("maxQueueDepth", handler.maxQueueDepth());
        emit log_named_uint("dustBlocked", handler.dustBlocked());
        emit log_named_uint("cutsMinted", handler.cutsMinted());
        emit log_named_uint("cutsWhileVesting", handler.cutsWhileVesting());
        emit log_named_uint("cutsWithPending", handler.cutsWithPending());
        emit log_named_uint("cutsSkipped", handler.cutsSkipped());
        emit log_named_uint("cutLoosenings", handler.cutLoosenings());
        emit log_named_uint("vestingChanges", handler.vestingChanges());
        emit log_named_uint("vestingLoosenings", handler.vestingLoosenings());
        emit log_named_uint("usdcDeliveries", handler.usdcDeliveries());
        emit log_named_uint("deliveriesBesideOtherCredits", handler.deliveriesBesideOtherCredits());
        emit log_named_uint("deliveriesBesideOpenDeposits", handler.deliveriesBesideOpenDeposits());
        emit log_named_uint("deliveriesAtFloor", handler.deliveriesAtFloor());
        emit log_named_uint("deliveriesRefused", handler.deliveriesRefused());
        emit log_named_uint("thinPoolRefusals", handler.thinPoolRefusals());
        emit log_named_uint("deliveriesBoundByUser", handler.deliveriesBoundByUser());
        emit log_named_uint("deliveriesBoundByKeeper", handler.deliveriesBoundByKeeper());
        emit log_named_uint("deliveriesBoundByTwap", handler.deliveriesBoundByTwap());
        emit log_named_uint("stakesSettled", handler.stakesSettled());
        emit log_named_uint("stakesNearFloor", handler.stakesNearFloor());
        emit log_named_uint("stakesRefusedFloor", handler.stakesRefusedFloor());
        emit log_named_uint("stakesRefusedMinimum", handler.stakesRefusedMinimum());
        emit log_named_uint("stakesRefusedOracle", handler.stakesRefusedOracle());
        emit log_named_uint("stakesRefusedNoOracle", handler.stakesRefusedNoOracle());
        emit log_named_uint("stakesRefusedDoor", handler.stakesRefusedDoor());
        emit log_named_uint("adoptions", handler.adoptions());
        emit log_named_uint("swapsMissing", handler.swapsMissing());
        emit log_named_uint("swapsWithinTolerance", handler.swapsWithinTolerance());
        emit log_named_uint("restores", handler.restores());
        emit log_named_uint("missingExits", handler.missingExits());
        emit log_named_uint("depositsRefusedWhileMissing", handler.depositsRefusedWhileMissing());
        emit log_named_uint("redeemsRefusedWhileMissing", handler.redeemsRefusedWhileMissing());
        emit log_named_uint("deliveriesRefusedWhileMissing", handler.deliveriesRefusedWhileMissing());
        emit log_named_uint("payoutsWhileMissing", handler.payoutsWhileMissing());
        emit log_named_uint("claimsWhileMissing", handler.claimsWhileMissing());
        emit log_named_uint("stakesWhileMissing", handler.stakesWhileMissing());
        emit log_named_uint("cancelsWhileMissing", handler.cancelsWhileMissing());
        emit log_named_uint("deliveriesRefusedUnderwater", handler.deliveriesRefusedUnderwater());
        emit log_named_uint("retriesDelivered", handler.retriesDelivered());
        emit log_named_uint("i4Swaps", handler.i4Swaps());
        emit log_named_uint("i4CancelFalls", handler.i4CancelFalls());
        emit log_named_uint("i4FreshReads", handler.i4FreshReads());
        emit log_named_uint("i4GapsAbsorbed", handler.i4GapsAbsorbed());
        emit log_named_uint("exitsCharged", handler.exitsCharged());
        emit log_named_uint("exitsPriceChecked", handler.exitsPriceChecked());
        emit log_named_uint("feeSwitches", handler.feeSwitches());
        emit log_named_uint("marginSwitches", handler.marginSwitches());
        emit log_named_uint("removeTwiceDraws", handler.removeTwiceDraws());
        emit log_named_uint("partialThenCancelDraws", handler.partialThenCancelDraws());
        emit log_named_uint("thinDraws", handler.thinDraws());
        emit log_named_uint("readSwitches", handler.readSwitches());
        emit log_named_uint("removalsByOwner", handler.removalsByOwner());
        emit log_named_uint("removalsByGuardian", handler.removalsByGuardian());
        emit log_named_uint("guardianRemovalsOfRemoved", handler.guardianRemovalsOfRemoved());
        emit log_named_uint("reopensDeleted", handler.reopensDeleted());
        emit log_named_uint("removalsRefused", handler.removalsRefused());
        emit log_named_uint("reopensScheduled", handler.reopensScheduled());
        emit log_named_uint("reopensExecuted", handler.reopensExecuted());
        emit log_named_uint("reopensRescheduled", handler.reopensRescheduled());
        emit log_named_uint("swapRestores", handler.swapRestores());
        emit log_named_uint("deliveriesRefusedDoorDown", handler.deliveriesRefusedDoorDown());
        emit log_named_uint("payoutsRefusedDoorDown", handler.payoutsRefusedDoorDown());
        emit log_named_uint("originsRefusedDoorDown", handler.originsRefusedDoorDown());
        emit log_named_uint("looseningsRefused", handler.looseningsRefused());
        _logHitTotals();
    }

    // ---- B9: the named states' minimum hits in a long run (MinimumHits) ----

    function _hitTag() internal pure override returns (string memory) {
        return "core";
    }

    /// The ledger's named states for this campaign (Tasks 34, 34a, 36, 36b carries) and I-31's, each with its minimum
    /// over 3,000 runs at depth 64 (MinimumHits' rule: a quarter of the slowest seed's projection). A minimum of 0 is
    /// logged, not asserted: i4GapsAbsorbed and deliveriesRefusedUnderwater need a mint at a supply of 0 over a hole an
    /// exception recorded, which no campaign draws (pinned: test_aMintAtAnEmptyVaultAbsorbsASwapsRecordedGap and
    /// test_aMintAtAnEmptyVaultUnderwaterIsRefused here, and BittensorParking's
    /// test_supply0UnderwaterDeliveryParksNative); i4CancelFalls comes about twice in 3,000 runs (pinned:
    /// test_aCancelAboveASupplyOfZeroOverAHoleGivesBackTheHole); dustBlocked, bouncesCarried and chunksRefusedWalkCost
    /// are thin here (all three asserted in the payout campaign, the last through its walk-cost draw); partialChunks,
    /// cancelsAfterPartial and payoutsUncoverable vary by seed here (one seed projects under 8): the first two are
    /// asserted in the payout campaign (cancelsAfterPartial through its cancel-after-partial draw, Task 42's fix round
    /// 4), the third in the ledger campaign.
    function _hits() internal view override returns (Hit[] memory h) {
        h = new Hit[](19);
        // R11's cancel cooldown, both ways: cancels that went, and those refused CancelTooSoon as predicted (the minimums
        // by MinimumHits' rule from R12's seeds 9401-9403 at 128 x 64, the lower of its two sweeps: slowest projections
        // 1,258 and 1,061)
        h[17] = Hit("depositCancels", handler.depositCancels(), 314);
        h[18] = Hit("cancelsTooSoon", handler.cancelsTooSoon(), 265);
        h[0] = Hit("i4GapsAbsorbed", handler.i4GapsAbsorbed(), 0);
        h[1] = Hit("deliveriesRefusedUnderwater", handler.deliveriesRefusedUnderwater(), 0);
        h[2] = Hit("dustBlocked", handler.dustBlocked(), 0);
        h[3] = Hit("bouncesCarried", handler.bouncesCarried(), 0);
        h[4] = Hit("payoutsUncoverable", handler.payoutsUncoverable(), 0);
        h[5] = Hit("i4FreshReads", handler.i4FreshReads(), 16);
        h[6] = Hit("i4CancelFalls", handler.i4CancelFalls(), 0);
        h[7] = Hit("cancelsAfterPartial", handler.cancelsAfterPartial(), 0);
        h[8] = Hit("partialChunks", handler.partialChunks(), 0);
        h[9] = Hit("chunksRefusedWalkCost", handler.chunksRefusedWalkCost(), 0);
        h[10] = Hit("exitsRefusedByCost", handler.exitsRefusedByCost(), 19);
        h[11] = Hit("guardianRemovalsOfRemoved", handler.guardianRemovalsOfRemoved(), 597);
        h[12] = Hit("reopensDeleted", handler.reopensDeleted(), 596);
        h[13] = Hit("thinPoolRefusals", handler.thinPoolRefusals(), 52);
        h[14] = Hit("stakesRefusedFloor", handler.stakesRefusedFloor(), 201);
        h[15] = Hit("stakesNearFloor", handler.stakesNearFloor(), 214);
        h[16] = Hit("stakesRefusedNoOracle", handler.stakesRefusedNoOracle(), 12);
    }

    // ---- regression ----

    /// I-31's stake half through the handler (Task 42): a stake whose route pays exactly the buy floor settles; one at 90%
    /// of the oracle's value is refused BelowOracleFloor; with the oracle unable to answer the stake reverts with its
    /// "OLD"; with the door's oracle the zero address (a scheduled setOracle, and back) it reverts NoOracle. All as
    /// predicted, and no stake settled below the floor.
    function test_theStakeActionHoldsTheBuyFloor() public {
        handler.stake(0, 1_000e6, 0, 0);
        assertEq(handler.stakesSettled(), 1, "at the floor: settled");
        assertEq(handler.stakesNearFloor(), 1, "within 1% of it");
        handler.stake(0, 1_000e6, 1, 0);
        assertEq(handler.stakesRefusedFloor(), 1, "at 90%: BelowOracleFloor");
        handler.stake(0, 1_000e6, 1 << 128, 0);
        assertEq(handler.stakesRefusedOracle(), 1, "the oracle's revert");
        handler.stake(0, 1_000e6, 2 << 128, 0);
        assertEq(handler.stakesRefusedNoOracle(), 1, "no oracle: NoOracle");
        assertEq(address(fd.oracle()), address(handler.twap()), "the oracle back");
        assertEq(handler.unexpectedReverts(), 0);
        invariant_noThinPoolOrUnderFloorStake();
        invariant_frontDoorIdentities();
        invariant_tokenAccounting();
    }

    /// @dev The handler reads the vault's booked stake (in rao, Task 12) and its ramping stake (R2 F4) through the
    /// lens; this pins what it reads, against VaultInternals' exposure of the ramp.
    function test_handlerReadsTheLedgerAndTheBase() public {
        handler.depositDirect(0, 100_000_000_000);
        handler.stakeIdle();
        assertEq(handler.booked(), 100e9);
        assertEq(handler.ramping(), 100e18);
        assertEq(handler.ramping(), vault.exposed_rampingStake());
        assertEq(handler.base(), 0);
        handler.warp(1 days);
        assertEq(handler.base(), 100e18);
        // a gift is never booked by a stake (I-3), nor priced
        handler.gift(10e9);
        assertEq(vaultLens.visibleStakeRao(), 110e9);
        assertEq(handler.booked(), 100e9);
        assertEq(handler.base(), 100e18);
        assertEq(vaultLens.surplusStakeRao(), 10e9);
        handler.depositDirect(0, 1_000_000_000);
        handler.stakeIdle();
        assertEq(handler.booked(), 101e9);
        assertEq(handler.ramping(), 1e18);
        invariant_grossAssetsConserved();
    }

    /// @dev The exit while stake is missing (Task 13), with the swap its own action (Task 34): alice and bob deposit
    /// directly and are staked; 30% of the stake is swapped away and stays missing; a direct deposit and an unflagged
    /// redeem are refused StakeMissing; alice's flagged exit of half her shares pays the floor price and leaves bob
    /// unchanged; the restore brings the stake back, the stayers keeping what she gave up. A 0.05% swap stays within
    /// the tolerance. Each swap is I-4's first exception, recorded by swapAway.
    function test_handlerExitsWhileMissing() public {
        handler.depositDirect(0, 60_000_000_000);
        handler.depositDirect(1, 40_000_000_000);
        handler.stakeIdle();
        uint256 price = vaultLens.price();
        address alice = handler.actors(0);
        address bob = handler.actors(1);
        uint256 bobValue = CascadeMath.assetsForRedeem(vault.balanceOf(bob), 70e18, vault.totalSupply());

        handler.swapAway(3_000);
        assertTrue(vaultLens.stakeMissing());
        assertEq(handler.swapsMissing(), 1);
        assertEq(handler.i4Swaps(), 1);
        assertEq(vaultLens.totalAssets(), 70e18, "priced at min(visible, booked)");
        assertEq(handler.priceFloor(), vaultLens.price(), "the floor restarts from the swap's price");
        // the deposit and the unflagged redeem, as their own actions while it is missing
        handler.depositDirect(2, 1_000_000_000);
        handler.redeemDirect(1, 1e24);
        assertEq(handler.depositsRefusedWhileMissing(), 1);
        assertEq(handler.redeemsRefusedWhileMissing(), 1);

        handler.redeemDirectWhileMissing(0, 30e24);
        assertEq(handler.missingExits(), 1);
        assertEq(vault.balanceOf(alice), 30e24);
        assertEq(CascadeMath.assetsForRedeem(vault.balanceOf(bob), 49e18, vault.totalSupply()), bobValue);
        assertEq(vaultLens.totalAssets(), 49e18, "alice was paid 21 TAO, the floor price");

        handler.restoreStake();
        assertEq(handler.restores(), 1);
        assertEq(vaultLens.missingStakeRao(), 0, "restored");
        assertEq(vaultLens.totalAssets(), 79e18);
        assertGt(vaultLens.price(), price, "what she gave up stays with the stayers");

        handler.swapAway(5);
        assertEq(handler.swapsWithinTolerance(), 1);
        assertFalse(vaultLens.stakeMissing());
        handler.redeemDirectWhileMissing(1, 1e24);
        assertEq(handler.missingExits(), 1, "nothing missing: no flagged exit");
        handler.restoreStake();

        invariant_consentedExitWhileMissingTakesNothingFromTheOthers();
        invariant_priceFallsOnlyByI4sExceptions();
        invariant_grossAssetsConserved();
        invariant_noUnexpectedReverts();
    }

    /// @dev The T13 carry (Task 34): a batch delivered while stake is missing reverts StakeMissing, which the bridge
    /// files (MockBridge's form of the adapter's park); a retry while it is still missing is refused again; once the
    /// stake is back the retry delivers, and bob's deposit mints at the restored price.
    function test_aDeliveryWhileStakeIsMissingIsFiledAndRetried() public {
        handler.depositDirect(0, 60_000_000_000);
        handler.stakeIdle();
        handler.swapAway(3_000);
        assertTrue(vaultLens.stakeMissing());

        // bob deposits 10 TAO at the front door; its close's delivery is refused
        handler.deposit(1, 10_000_000_000);
        handler.closeBatch(0, 0, 0);
        assertEq(handler.closes(), 1);
        assertEq(handler.deliveriesRefusedWhileMissing(), 1);
        assertEq(bridge.failedCount(), 1);
        assertEq(vault.balanceOf(handler.actors(1)), 0);

        handler.retryDelivery();
        assertEq(handler.deliveriesRefusedWhileMissing(), 2);
        assertEq(handler.retriesDelivered(), 0);

        handler.restoreStake();
        handler.retryDelivery();
        assertEq(handler.retriesDelivered(), 1);
        assertEq(bridge.failedCount(), 0);
        assertEq(vault.balanceOf(handler.actors(1)), 1e25);

        invariant_priceFallsOnlyByI4sExceptions();
        invariant_grossAssetsConserved();
        invariant_frontDoorIdentities();
        invariant_noUnexpectedReverts();
    }

    /// @dev The 512-run campaign's counterexample to invariant_grossAssetsConserved (seed 0xf87d...0da9, shrunk to 7
    /// calls) before the fixture paid removals by call: 652.4 TAO deposited at the front door and staked, 11.3 TAO of
    /// it redeemed and queued, then a swap leaves 0.2978 TAO on the listed hotkey; the keeper's payout (inside
    /// deliver) walks that hotkey and still cannot cover the chunk, so it reverts UnstakeShort, as the handler
    /// predicts. With MockStaking's old default vm.deal credit the walk's receipt survived the revert; paid by call
    /// (the fixture's setting in Task 34, the mock's default since Task 35), it goes with it.
    function test_aPayoutRefusedWhileStakeIsMissingKeepsNoReceipt() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        handler.deposit(65_536, 652_400_000_000);
        handler.closeBatch(
            974_744_959_162_475_509_729_599_699_354_776_057_522_422_287_748_926_985_193_156,
            448_382_580_782_187_462_017_547_664_154,
            72_470_101_996_568_179_404_217_715_999_784_321_665_466_549_388_291_230_155_102_198_814_620
        );
        handler.stakeIdle();
        handler.requestRedeem(81_650_257_313_000_347, 11_325_059_674_660_342_635_851_782);
        handler.closeBatch(
            68_588_501_180_625_526, 5_850_020_050_873, 21_536_398_431_854_498_973_022_614_468_672_465_349_461
        );
        handler.swapAway(541_048_322_601_635_877_733_680_999_949);
        assertTrue(vaultLens.stakeMissing());
        uint256 balance = address(vault).balance;
        handler.deliver(
            64_403_022_592_078_655_163_449_786_019,
            1_625_952_966_564_243_706_003_467_190_691_841_733_712_159_568_709_159_963_118_882_717,
            233_190_573_556_295_442_968_917_277_244_704_747_783_261_249_863,
            9_461_837_034_657_092_443_798
        );
        assertEq(handler.payoutsUncoverable(), 1);
        assertEq(handler.payoutChunks(), 0);
        assertEq(address(vault).balance, balance, "no receipt kept from the reverted walk");

        invariant_grossAssetsConserved();
        invariant_priceFallsOnlyByI4sExceptions();
        invariant_noUnexpectedReverts();
    }

    /// @dev I-4's cancel exception after a rise (the scripted sequence of Task 34's NEEDS_CONTEXT round, which Task 34c
    /// inverts): alice and bob deposit 10 TAO each at the front door, alice redeems half, burned at the delivery price
    /// 1.0e12 for 5 TAO and queued; 1 TAO of rewards vests for 3 days (price 1.028571428571e12); the owner cancels. The
    /// re-mint is the shares alice's 5 TAO buys at the price before the cancel, fewer than she burned and worth 5 TAO,
    /// less at most 1 wei, at the price after it: the delay's rewards stay with bob, the price does not fall and the
    /// cancel uses none of its dust. The bound is the floor alone (cancelFloor); the bound check refuses the assets
    /// just below it, and the I-4 invariant fails on any fall after the cancel that no step recorded.
    function test_aCancelAfterARiseDoesNotLowerThePrice() public {
        handler.deposit(0, 10_000_000_000);
        handler.closeBatch(0, 0, 0);
        handler.deposit(1, 10_000_000_000);
        handler.closeBatch(0, 0, 0);
        handler.requestRedeem(0, 5e24);
        handler.closeBatch(0, 0, 0);
        bytes32 key = handler.queuedKeys(0);
        assertEq(handler.deliveryPrice(key), 1e12);
        handler.accrueAndClaim(1e9);
        handler.warp(3 days);
        uint256 before = vaultLens.price();
        assertEq(before, 1_028_571_428_571);
        uint256 bound_ = handler.cancelFloor(key);
        assertEq(bound_, handler.priceFloor(), "the floor alone");
        assertEq(bound_, before);

        // alice's entry: 5e24 shares burned for 5e24 * (20e18 + 1) / (2e25 + 1e6) = 5 TAO
        address alice = handler.actors(0);
        uint256 held = vault.balanceOf(alice);
        uint256 reMint = CascadeMath.sharesForDeposit(5e18, vaultLens.totalAssets(), vault.totalSupply());
        assertLt(reMint, 5e24, "fewer shares than she burned");
        handler.cancelQueued(0);
        assertEq(handler.cancels(), 1);
        assertEq(vault.balanceOf(alice) - held, reMint, "the shares her 5 TAO buys");
        assertEq(handler.i4CancelFalls(), 0, "the price did not fall");
        assertEq(handler.cancelDustViolations(), 0);
        uint256 assets = vaultLens.totalAssets();
        uint256 supply = vault.totalSupply();
        assertGe(vaultLens.price(), before);
        uint256 value = CascadeMath.assetsForRedeem(reMint, assets, supply);
        assertLe(value, 5e18, "worth at most what she was owed");
        assertGe(value, 5e18 - 1, "and at least 1 wei less");
        // at or above the bound with no dust given back, and the floor restarts from the post-cancel price
        assertTrue(handler.cancelBoundMet(assets, supply, 0, bound_));
        assertEq(handler.priceFloor(), vaultLens.price());

        // a deeper fall fails the bound: the most assets that miss it, by one wei, with the entry's rao given back
        uint256 deeper = Math.ceilDiv(bound_ * (supply + 1e6), 1e18) - 1 - 1e9 - 1;
        assertFalse(handler.cancelBoundMet(deeper, supply, 1, bound_));
        assertTrue(handler.cancelBoundMet(deeper + 1, supply, 1, bound_));

        invariant_cancelDustBounded();
        invariant_priceFallsOnlyByI4sExceptions();
        invariant_grossAssetsConserved();
        invariant_pendingPayoutsMatchQueue();
        invariant_noUnexpectedReverts();

        // and a fall after it that no step recorded fails I-4
        vm.deal(address(vault), address(vault).balance - 1e9);
        vm.expectRevert();
        this.invariant_priceFallsOnlyByI4sExceptions();
    }

    /// @dev The leaver pays (Task 36b; before, I-4's short-receipt exception): with the chain's removal fee at 1,000
    /// rao, a payout whose walk unstakes receives 1,000 rao less than the stake it took; the chunk's entry bears the
    /// 1,000 rao with its share of the bridge fee, the holders' price does not move, nothing is recorded as an
    /// exception (the floor stays), and the ghosts count what the chain kept.
    function test_aPayoutsEntryBearsItsWalksCost() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        handler.depositDirect(0, 10_000_000_000);
        handler.depositDirect(1, 10_000_000_000);
        handler.stakeIdle();
        handler.requestRedeem(0, 5e24);
        handler.closeBatch(0, 0, 0);
        assertEq(vaultLens.pendingPayouts(), 5e18);
        // 3_001 % 3 == 1: a fee of 3_001 / 3 = 1_000 rao
        handler.setRemoveFee(3_001);
        assertEq(staking.removeFeeRao(), 1_000);
        uint256 priceBefore = vaultLens.price();

        uint256 floorBefore = handler.priceFloor();
        bytes32 key = handler.queuedKeys(0);
        uint256 entry = handler.listOf(key)[0].assets;
        address alice = handler.actors(0);
        uint256 claimable = fd.claimable(alice);

        handler.processPayouts(0, 0);
        assertEq(handler.payoutChunks(), 1);
        assertEq(handler.exitsCharged(), 1, "the walk cost something");
        assertEq(handler.ghostReceiptShort(), 1_000e9);
        uint256 net = entry - 1e15 - 1_000e9;
        assertEq(fd.claimable(alice) - claimable, net - net % 1e9, "the entry bore the fee with its share");
        assertGe(vaultLens.price(), priceBefore, "the holders' price unmoved");
        assertGe(handler.priceFloor(), floorBefore, "no exception: the floor never restarted lower");

        invariant_priceFallsOnlyByI4sExceptions();
        invariant_grossAssetsConserved();
        invariant_claimsNeverExceedPayouts();
        invariant_noExitLowersThePrice();
        invariant_noUnexpectedReverts();
    }

    /// @dev An emptied vault's payout leaves no gap (Task 36b; before, the chunk's short receipt left one the next
    /// minter absorbed): alice and bob deposit 10 TAO each directly, are staked, and redeem everything at the front door
    /// (a supply of 0, 20 TAO queued). With the chain's removal fee at 1,000 rao, the first chunk's walk receives 1,000
    /// rao short and alice's entry bears it; the gross still covers the queued payouts exactly, nothing is recorded,
    /// and carol's direct deposit mints at the launch price and is worth her deposit exactly.
    function test_anEmptiedVaultsPayoutLeavesNoGap() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        handler.depositDirect(0, 10_000_000_000);
        handler.depositDirect(1, 10_000_000_000);
        handler.stakeIdle();
        handler.requestRedeem(0, type(uint256).max);
        handler.requestRedeem(1, type(uint256).max);
        handler.closeBatch(0, 0, 0);
        assertEq(vault.totalSupply(), 0);
        assertEq(vaultLens.getPayoutBatch(handler.queuedKeys(0)).count, 2);
        handler.setRemoveFee(3_001);
        assertEq(staking.removeFeeRao(), 1_000);

        // key seed 0: one entry, alice's
        handler.processPayouts(0, 0);
        assertEq(handler.payoutChunks(), 1);
        assertEq(handler.exitsCharged(), 1);
        assertEq(vaultLens.grossAssets(), vaultLens.pendingPayouts(), "no gap: the walk's cushion paid for the fee");
        assertEq(handler.holeWei(), 0, "nothing recorded");

        handler.depositDirect(2, 1_000_000_000);
        assertEq(handler.directDeposits(), 3);
        assertEq(handler.i4GapsAbsorbed(), 0);
        assertEq(vault.totalSupply(), 1e24, "minted at the launch price");
        assertEq(vaultLens.totalAssets(), 1e18, "worth the deposit exactly");

        invariant_priceFallsOnlyByI4sExceptions();
        invariant_grossAssetsConserved();
        invariant_pendingPayoutsMatchQueue();
        invariant_noExitLowersThePrice();
        invariant_noUnexpectedReverts();
    }

    /// @dev I-4's swap exception at a supply of 0, which the next minter absorbs (the mints path, fed since Task 36b by
    /// the exceptions that are no exit): alice and bob deposit 10 TAO each directly, are staked, and redeem everything at
    /// the front door (a supply of 0, 20 TAO queued, all of it staked). A validator's swap of 4 bps of the stake
    /// (8,000,000 rao) leaves the gross that much short of the queued payouts, a gap the swap's step records (holeWei),
    /// past the 1,000-rao tolerance. Since R6's E-fix it reads as missing too (the tolerance's base is the stake backing
    /// shares, none here, so it is the 0.001 TAO floor; before R6, 0.1% of the 20 TAO booked); a gift of 7,999,000 rao
    /// onto HK1 narrows the gap to exactly the 1,000-rao tolerance, inside the missing-stake one. Carol's direct deposit then mints at the launch price and absorbs the 1,000 rao;
    /// its step reads the record (i4GapsAbsorbed), and her shares are worth her deposit less the gap.
    function test_aMintAtAnEmptyVaultAbsorbsASwapsRecordedGap() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        handler.depositDirect(0, 10_000_000_000);
        handler.depositDirect(1, 10_000_000_000);
        handler.stakeIdle();
        handler.requestRedeem(0, type(uint256).max);
        handler.requestRedeem(1, type(uint256).max);
        handler.closeBatch(0, 0, 0);
        assertEq(vault.totalSupply(), 0);

        handler.swapAway(4);
        assertTrue(vaultLens.stakeMissing(), "past the tolerance's floor: the queue is all the booked stake (R6 E-fix)");
        assertEq(handler.i4Swaps(), 1);
        assertEq(vaultLens.pendingPayouts() - vaultLens.grossAssets(), 8_000_000e9);
        assertEq(handler.holeWei(), 8_000_000e9, "the swap's gap, recorded");
        handler.gift(7_999_000);
        assertFalse(vaultLens.stakeMissing(), "the gift brought it inside");
        uint256 gap = vaultLens.pendingPayouts() - vaultLens.grossAssets();
        assertEq(gap, 1_000e9, "narrowed to the tolerance");
        assertEq(vaultLens.price(), 1e12, "a supply of 0 does not show it");

        handler.depositDirect(2, 1_000_000_000);
        assertEq(handler.directDeposits(), 3);
        assertEq(handler.i4GapsAbsorbed(), 1);
        assertEq(handler.holeWei(), 0);
        assertEq(vault.totalSupply(), 1e24, "minted at the launch price");
        assertEq(vaultLens.totalAssets(), 1e18 - gap, "worth the deposit less the gap");

        invariant_priceFallsOnlyByI4sExceptions();
        invariant_grossAssetsConserved();
        invariant_pendingPayoutsMatchQueue();
        invariant_noExitLowersThePrice();
        invariant_noUnexpectedReverts();
    }

    /// @dev The cancel bound's give-back is capped at the re-minted entries' value (Task 36's re-review, its
    /// out-of-scope note, closed by Task 36b): alice (10 TAO) and bob (0.1 TAO) deposit directly, are staked, and
    /// redeem everything at the front door in two batches (a supply of 0). A validator's swap of 2% of the stake (0.202
    /// TAO) leaves a payout gap past bob's whole entry, which the swap's step records. The owner cancels bob's batch
    /// alone at a supply of 0, over that hole (I-35's exemption): the bound gives back what the re-minted holder absorbs,
    /// but at most its entry's 0.1 TAO, not the recorded 0.202 TAO. The cap bites: an over-mint of twice bob's shares
    /// would pass the bound with the record's whole give-back and fails it with the capped one.
    function test_aCancelsGiveBackIsCappedAtItsEntriesValue() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        handler.depositDirect(0, 10_000_000_000);
        handler.depositDirect(1, 100_000_000);
        handler.stakeIdle();
        handler.requestRedeem(0, type(uint256).max);
        handler.closeBatch(0, 0, 0);
        handler.requestRedeem(1, type(uint256).max);
        handler.closeBatch(0, 0, 0);
        assertEq(vault.totalSupply(), 0);
        assertEq(handler.queuedCount(), 2);
        bytes32 bobsKey = handler.queuedKeys(1);
        CascadeMessages.Payout[] memory list = handler.listOf(bobsKey);
        assertEq(list.length, 1);
        uint256 entry = list[0].assets;
        assertEq(entry, 0.1e18, "bob's entry");

        // 200 bps of 10.1 TAO: 202,000,000 rao
        handler.swapAway(200);
        uint256 gap = vaultLens.pendingPayouts() - vaultLens.grossAssets();
        assertEq(gap, 202_000_000e9);
        assertEq(handler.holeWei(), gap, "the record, past bob's entry");
        uint256 floor_ = handler.priceFloor();

        // key seed 1: bob's batch
        handler.cancelQueued(1);
        assertEq(handler.cancels(), 1);
        assertEq(handler.cancelsOverAHole(), 1, "over the swap's hole, with the assets reading 0");
        assertEq(handler.lastCancelGiveBack(), entry, "capped at the entry's value, not the record");
        assertEq(handler.cancelDustViolations(), 0);
        uint256 assets = vaultLens.totalAssets();
        uint256 supply = vault.totalSupply();
        assertEq(assets, 0, "the hole swallows the entry");
        assertTrue(handler.cancelBoundMet(assets + entry, supply, 1, floor_), "the real re-mint passes");
        // twice the shares: the record's give-back would let it pass; the capped one does not
        assertTrue(handler.cancelBoundMet(assets + gap, 2 * supply, 1, floor_), "uncapped, an over-mint passes");
        assertFalse(handler.cancelBoundMet(assets + entry, 2 * supply, 1, floor_), "capped, it fails");

        invariant_priceFallsOnlyByI4sExceptions();
        invariant_cancelDustBounded();
        invariant_pendingPayoutsMatchQueue();
        invariant_noExitLowersThePrice();
        invariant_noUnexpectedReverts();
    }

    /// @dev Above a supply of 0, a cancel over a swap's hole with the assets reading 0 gives back that hole (the
    /// handler's _holeOver; Task 36b's mutation run found the state, and BASE's bound failed it too): alice (10 TAO)
    /// and bob (0.1 TAO) deposit directly, are staked, and redeem at the front door in two batches, bob all but 3 wei
    /// of his shares (a dust supply, whose price at assets of 0 is still about the launch price). A swap of 2% of the
    /// stake (0.202 TAO) leaves a hole past the dust's value, so the assets read 0. The owner cancels alice's batch: she
    /// absorbs the hole (I-4's "the owner's cancel that absorbs that hole", I-35's exemption), and the price falls
    /// below the floor by it. The bound gives back the hole, so it holds; without the give-back it would not.
    function test_aCancelAboveASupplyOfZeroOverAHoleGivesBackTheHole() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        handler.depositDirect(0, 10_000_000_000);
        handler.depositDirect(1, 100_000_000);
        handler.stakeIdle();
        handler.requestRedeem(0, type(uint256).max);
        handler.closeBatch(0, 0, 0);
        address bob = handler.actors(1);
        handler.requestRedeem(1, vault.balanceOf(bob) - 3);
        handler.closeBatch(0, 0, 0);
        assertEq(vault.totalSupply(), 3, "bob's dust");
        assertEq(handler.queuedCount(), 2);
        bytes32 alicesKey = handler.queuedKeys(0);
        uint256 entry = handler.listOf(alicesKey)[0].assets;
        assertEq(entry, 10e18, "alice's entry");

        // 200 bps of 10.1 TAO: 202,000,000 rao
        handler.swapAway(200);
        assertEq(vaultLens.totalAssets(), 0, "the hole is past the dust's value");
        uint256 hole = vaultLens.pendingPayouts() + vaultLens.unvestedRewards() - vaultLens.grossAssets();
        assertGt(hole, 0);
        uint256 floor_ = handler.priceFloor();

        // key seed 0: alice's batch
        handler.cancelQueued(0);
        assertEq(handler.cancels(), 1);
        assertEq(handler.cancelsOverAHole(), 1, "over the swap's hole, with the assets reading 0");
        assertEq(handler.lastCancelGiveBack(), hole, "the hole, above a supply of 0");
        assertEq(handler.cancelDustViolations(), 0);
        uint256 assets = vaultLens.totalAssets();
        uint256 supply = vault.totalSupply();
        assertLt(vaultLens.price(), floor_, "alice absorbed the hole");
        assertFalse(handler.cancelBoundMet(assets, supply, 1, floor_), "without the give-back the bound fails");
        assertTrue(handler.cancelBoundMet(assets + hole, supply, 1, floor_), "with it, it holds");

        invariant_priceFallsOnlyByI4sExceptions();
        invariant_cancelDustBounded();
        invariant_pendingPayoutsMatchQueue();
        invariant_noExitLowersThePrice();
        invariant_noUnexpectedReverts();
    }

    /// @dev I-1 at a supply of 0 underwater (Task 34's fix round, I2 and I3): alice and bob deposit 5 TAO each
    /// directly, are staked, and redeem everything at the front door (a supply of 0, 10 TAO queued, all of it staked).
    /// A validator's swap of 0.01% of the stake stays within the missing-stake tolerance (exactly its 0.001 TAO floor:
    /// since R6's E-fix the base is the stake backing shares, none here; the 0.04% this test swapped before R6 now reads
    /// as missing), so nothing reads as missing, but it leaves the gross 0.001 TAO short of the queued payouts, past the
    /// 1,000-rao tolerance: every mint is refused. Carol's direct deposit reverts VaultInsolvent and her front-door batch's delivery is refused and filed;
    /// once the swap is undone the retry delivers. A vault that let either mint would count a guard miss.
    function test_aMintAtAnEmptyVaultUnderwaterIsRefused() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        handler.depositDirect(0, 5_000_000_000);
        handler.depositDirect(1, 5_000_000_000);
        handler.stakeIdle();
        handler.requestRedeem(0, type(uint256).max);
        handler.requestRedeem(1, type(uint256).max);
        handler.closeBatch(0, 0, 0);
        assertEq(vault.totalSupply(), 0);

        // 1 bp of 10 TAO: 1,000,000 rao, exactly the tolerance (its floor: the queue is all the booked stake)
        handler.swapAway(1);
        assertFalse(vaultLens.stakeMissing());
        assertEq(handler.swapsWithinTolerance(), 1);
        assertEq(vaultLens.pendingPayouts() - vaultLens.grossAssets(), 1_000_000e9);

        handler.depositDirect(2, 1_000_000_000);
        assertEq(handler.directDeposits(), 2, "refused VaultInsolvent");
        handler.deposit(2, 1_000_000_000);
        handler.closeBatch(0, 0, 0);
        assertEq(handler.deliveriesRefusedUnderwater(), 1);
        assertEq(bridge.failedCount(), 1);
        assertEq(vault.totalSupply(), 0);

        handler.restoreStake();
        handler.retryDelivery();
        assertEq(handler.retriesDelivered(), 1);
        assertGt(vault.balanceOf(handler.actors(2)), 0, "minted once the gap closed");

        invariant_consentedExitWhileMissingTakesNothingFromTheOthers();
        invariant_priceFallsOnlyByI4sExceptions();
        invariant_grossAssetsConserved();
        invariant_noUnexpectedReverts();
    }

    /// @dev I-4's last exception: a fresh position's read one rao short. With the mock's fresh read on, the keeper's
    /// first stake measures one rao less than it staked; that rao is gone, the holders absorb it, and stakeIdle
    /// records it (i4FreshReads) from the vault's own Staked event.
    function test_aFreshReadOneRaoShortIsRecordedByTheStake() public {
        handler.setFreshRead(1);
        handler.depositDirect(0, 10_000_000_000);
        uint256 priceBefore = vaultLens.price();
        handler.stakeIdle();
        assertEq(handler.i4FreshReads(), 1);
        assertEq(handler.ghostReadShort(), 1e9);
        assertEq(handler.booked(), 10e9 - 1);
        assertLt(vaultLens.price(), priceBefore);

        invariant_priceFallsOnlyByI4sExceptions();
        invariant_grossAssetsConserved();
        invariant_noUnexpectedReverts();
    }

    /// @dev The refusals the handler predicts are the ones the contracts make: a close by a stale id (WrongBatch) and
    /// one asking more than its deposits (BatchTooSmall), then the close by the open id; a payout chunk under 3 TAO at
    /// a fee above the 0.015 TAO ceiling with no top-up (FeeTooHigh), then the same with the whole fee as its top-up.
    function test_theCloseByIdAndTheFeeValveRefuseAsPredicted() public {
        handler.depositDirect(0, 10_000_000_000);
        handler.deposit(1, 1_000_000_000);
        // seed 1 (mod 8): the batch before the open one
        handler.closeBatch(0, 0, 1);
        assertEq(handler.wrongBatches(), 1);
        // seed 2 (mod 8) with the largest minimum, 2 * 1 TAO + 1 TAO, above the 1 TAO of deposits
        handler.closeBatch(0, 0, (3e18 << 3) | 2);
        assertEq(handler.tooSmallCloses(), 1);
        handler.closeBatch(0, 0, 0);
        assertEq(handler.closes(), 1);

        // alice asks for 1 TAO's worth: one entry, under 3 TAO, so a fee above MAX_FEE_ABS exceeds the ceiling
        handler.requestRedeem(0, 1e24);
        handler.closeBatch(0, 0, 0);
        assertEq(handler.queuedCount(), 1);
        // fee seed 3 (mod 4): above the ceiling; bit 2 clear: no top-up
        handler.processPayouts(0, 3);
        assertEq(handler.payoutsFeeRefused(), 1);
        assertEq(handler.payoutChunks(), 0);
        // bit 2 set: the whole fee as the top-up
        handler.processPayouts(0, 7);
        assertEq(handler.payoutChunks(), 1);
        assertEq(handler.topUpChunks(), 1);
        assertEq(bridge.fee(), FEE, "the world's fee put back");

        invariant_grossAssetsConserved();
        invariant_claimsNeverExceedPayouts();
        invariant_noUnexpectedReverts();
    }

    /// @dev The handler's restated chunk math (chunkSum, feeCeiling: the fee valve's FeeTooHigh prediction and the
    /// payout walk's coverage) is the library's: over fuzzed lists of 1 to 8 entries, a start, a limit, a message cap
    /// and a minChunk, chunkSum is CascadePayoutMath.takeChunk's sum, and with a fee above the ceiling feeSplit charges
    /// exactly the ceiling floored to rao (and the whole fee, floored, at or below it).
    function testFuzz_theHandlersChunkMathIsTheLibrarys(
        uint256 seed,
        uint256 startSeed,
        uint256 limitSeed,
        uint256 capSeed,
        uint256 minChunkSeed,
        uint256 feeSeed
    ) public view {
        uint256 n = bound(seed, 1, 8);
        CascadeMessages.Payout[] memory list = new CascadeMessages.Payout[](n);
        for (uint256 i; i < n; ++i) {
            uint256 assets = bound(uint256(keccak256(abi.encode(seed, i))), 0.03e18, 2_000e18);
            list[i] = CascadeMessages.Payout(address(uint160(i + 1)), i % 2, assets);
        }
        uint256 start = bound(startSeed, 0, n - 1);
        uint256 limit = bound(limitSeed, 1, CascadeMessages.MAX_ENTRIES);
        uint256 cap = bound(capSeed, 0.03e18, 4_000e18);
        uint256 minChunk = bound(minChunkSeed, 1, 10);
        (, uint256 sum) = CascadePayoutMath.takeChunk(list, start, limit, cap, minChunk);
        assertEq(handler.chunkSum(list, start, limit, cap, minChunk), sum, "chunkSum");

        uint256 ceiling = handler.feeCeiling(sum, 100, 0.015e18);
        uint256 quote = bound(feeSeed, 0, 2 * ceiling + 1e9);
        (uint256 fee, uint256 charged) = CascadePayoutMath.feeSplit(quote, sum, 100, 0.015e18);
        uint256 expected = Math.min(fee, ceiling);
        assertEq(charged, expected - expected % 1e9, "feeCeiling");
    }

    /// @dev The sequence that took a cancel more than one rao below its batch's delivery price while the re-mint
    /// returned the burned shares: alice keeps part of her shares through a 3-entry batch, takes the rest out by a
    /// direct redeem with her part of the batch's rounding, then the owner cancels the batch. Her exit was the last
    /// stayer's, so the cancel runs at a supply of 0 with one rao left beyond the reservations, where a share unit is
    /// worth about 1e3 wei. Since Task 34c each entry gets the shares its value buys there (no special case at a supply
    /// of 0): far fewer than it burned, the three together worth what they were owed less a wei; the price does not
    /// fall, so the cancel uses none of its dust. Amounts are inside the handler's bounds, so they pass through
    /// unchanged; neither direct deposit is 3 mod 4 in rao, so both actors are opted back in.
    function test_cancelAfterExitStaysWithinDustTolerance() public {
        // alice and carol deposit directly; 0.818140478 TAO of rewards vest
        handler.depositDirect(0, 10_889_328_168);
        handler.depositDirect(2, 8_834_290_024);
        handler.accrueAndClaim(818_140_478);
        handler.warp(3 days);
        handler.warp(3 days);
        handler.warp(3 days);
        // bob deposits 19.000000012 TAO at the front door; more rewards vest
        handler.deposit(1, 19_000_000_012);
        handler.closeBatch(0, 0, 0);
        handler.accrueAndClaim(879_191_032);
        handler.warp(3 days);
        handler.warp(3 days);
        handler.warp(3 days);
        // alice asks for part of her shares, bob and carol for all of theirs: one batch, 3 entries
        handler.requestRedeem(0, 1_883_245_995_349_222_618_070_820);
        handler.requestRedeem(1, type(uint256).max);
        handler.requestRedeem(2, type(uint256).max);
        handler.closeBatch(0, 0, 0);
        assertEq(handler.queuedCount(), 1);
        bytes32 key = handler.queuedKeys(0);
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        assertEq(b.count, 3);
        CascadeMessages.Payout[] memory burned = handler.listOf(key);
        assertEq(burned.length, 3);
        // alice exits with the rest; the owner cancels the batch, at a supply of 0
        handler.redeemDirect(0, type(uint256).max);
        assertEq(vault.balanceOf(handler.actors(0)), 0);
        assertEq(vault.totalSupply(), 0, "the last stayer gone");
        assertEq(vaultLens.totalAssets(), 1e9, "one rao beyond the reservations");
        uint256 f = handler.priceFloor();
        assertEq(f, vaultLens.price());
        assertEq(handler.cancelFloor(key), f, "the floor alone");
        // the step owns the log buffer (TrackedHandler): its logs, kept for this test
        handler.setKeepLogs(true);
        handler.cancelQueued(0);
        uint256[2][] memory back = reversals(handler.stepLogs());
        handler.setKeepLogs(false);
        assertEq(handler.cancels(), 1);

        // each entry the shares its value buys at 1e9 over 0, far fewer than it burned
        assertEq(back.length, 3);
        uint256 owed;
        uint256 shares;
        for (uint256 i; i < 3; ++i) {
            assertEq(back[i][1], burned[i].assets, "the entry's value");
            assertEq(back[i][0], CascadeMath.sharesForDeposit(burned[i].assets, 1e9, 0));
            assertLt(back[i][0] * 1e6, burned[i].shares);
            owed += back[i][1];
            shares += back[i][0];
        }
        uint256 assets = vaultLens.totalAssets();
        uint256 supply = vault.totalSupply();
        assertEq(supply, shares);
        uint256 worth = CascadeMath.assetsForRedeem(shares, assets, supply);
        assertLe(worth, owed, "together, at most what they were owed");
        assertGe(worth, owed - 1, "less at most a wei");
        // no fall: the cancel needs none of its dust
        assertGe(vaultLens.price(), f);
        assertEq(handler.i4CancelFalls(), 0);
        assertTrue(handler.cancelBoundMet(assets, supply, 0, f));
        assertEq(handler.cancelDustViolations(), 0);
        // the floor restarts from the post-cancel price
        assertEq(handler.priceFloor(), vaultLens.price());
        invariant_cancelDustBounded();
        invariant_priceFallsOnlyByI4sExceptions();
        invariant_grossAssetsConserved();
        invariant_pendingPayoutsMatchQueue();
        invariant_noUnexpectedReverts();
    }

    /// The (shares, assets) of each of the vault's RedeemReversed in `logs`, in log order.
    function reversals(Vm.Log[] memory logs) internal view returns (uint256[2][] memory out) {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == RedeemReversed.selector) ++n;
        }
        out = new uint256[2][](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault) || logs[i].topics[0] != RedeemReversed.selector) continue;
            (uint256 shares, uint256 assets) = abi.decode(logs[i].data, (uint256, uint256));
            out[n++] = [shares, assets];
        }
    }

    /// @dev A simulated loss makes the vault insolvent: a direct deposit is refused (expected), a batch's
    /// deposits bounce ahead of its redeem, one bounce is paid back to Base and claimed, and the owner
    /// cancels the rest of the batch, which carries the other bounce forward (Task 22) for the next chunk to
    /// pay, all with every invariant holding.
    function test_lossBouncesDepositsThenPayoutAndCancel() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        // alice deposits 10 TAO at the front door: 1e25 shares, left liquid
        handler.deposit(0, 10_000_000_000);
        handler.closeBatch(0, 0, 0);
        assertEq(vault.balanceOf(handler.actors(0)), 1e25);

        // seed 42e18: 42e18 % 7 == 0 and 6e18 lies in [free / 2, free] = [5e18, 10e18], so 6e18 is lost.
        // totalAssets 4e18 against 1e25 shares is below half the launch price.
        handler.simulateLoss(42e18);
        assertEq(handler.losses(), 1);
        assertEq(handler.ghostLoss(), 6e18);
        assertLt(vaultLens.totalAssets() * 2_000_000, vault.totalSupply());
        // refused VaultInsolvent, which the handler expects
        handler.depositDirect(1, 1_000_000_000);
        assertEq(handler.directDeposits(), 0);

        // bob and carol deposit, alice asks to redeem half: both deposits bounce ahead of her redeem
        handler.deposit(1, 1_000_000_000);
        handler.deposit(2, 2_000_000_000);
        handler.requestRedeem(0, 5e24);
        handler.closeBatch(0, 0, 0);
        assertEq(handler.depositBounces(), 2);
        assertEq(handler.queuedCount(), 1);
        bytes32 key = handler.queuedKeys(0);
        assertEq(vaultLens.getPayoutBatch(key).count, 3);
        assertEq(vault.balanceOf(handler.actors(1)), 0);
        assertEq(vault.balanceOf(handler.actors(2)), 0);

        // the keeper's first chunk (1 entry, minChunk 1) pays bob's bounce back; bob claims it on Base
        handler.processPayouts(0, 0);
        assertEq(handler.bouncesPaid(), 1);
        assertEq(handler.partialChunks(), 1);
        handler.claim(1);
        assertEq(handler.claims(), 1);

        // the owner cancels the rest: alice gets the shares her 2 TAO buys at the price before the cancel (A = 2e18,
        // S = 5e24: 1.5e6 short of the 5e24 she burned, under a wei's worth, which the stayers keep), and carol's
        // bounce is carried forward, still queued
        uint256 reMint = CascadeMath.sharesForDeposit(2e18, vaultLens.totalAssets(), vault.totalSupply());
        assertEq(reMint, 4_999_999_999_999_999_998_500_000);
        handler.cancelQueued(0);
        assertEq(handler.bouncesCarried(), 1);
        assertEq(handler.cancelsAfterPartial(), 1);
        assertEq(vault.balanceOf(handler.actors(0)), 5e24 + reMint);
        assertEq(handler.queuedCount(), 1);
        assertEq(vaultLens.getPayoutBatch(key).count, 1);
        invariant_pendingPayoutsMatchQueue();
        // a second cancel has nothing to re-mint (NothingToCancel, which the handler expects); the next chunk pays
        // carol's bounce back
        handler.cancelQueued(0);
        // (a lost refusal would count as unexpected)
        invariant_noUnexpectedReverts();
        assertEq(handler.cancels(), 1);
        handler.processPayouts(0, 0);
        assertEq(handler.bouncesPaid(), 2);
        assertEq(handler.queuedCount(), 0);

        invariant_priceFallsOnlyByI4sExceptions();
        invariant_cancelDustBounded();
        invariant_grossAssetsConserved();
        invariant_pendingPayoutsMatchQueue();
        invariant_frontDoorIdentities();
        invariant_claimsNeverExceedPayouts();
        invariant_noUnexpectedReverts();
        invariant_vaultLensParity();
        invariant_doorLensParity();
        invariant_tokenAccounting();
    }

    /// @dev A position below the minimum stake is skipped by the unstake walk: alice's full exit empties
    /// HK1, a 0.001-TAO reward lands on it, and bob's full exit (which needs that reward) is refused
    /// UnstakeShort, counted as dust-blocked rather than unexpected. Once stakeIdle tops HK1 up, bob exits.
    function test_subMinimumStakeBlocksExitUntilToppedUp() public {
        handler.depositDirect(0, 10_000_000_000);
        handler.stakeIdle();
        handler.redeemDirect(0, type(uint256).max);
        assertEq(staking.getStake(HK1, vaultLens.coldkey(), 0), 0);
        handler.depositDirect(1, 10_000_000_000);
        handler.accrueAndClaim(1_000_000);
        assertEq(staking.getStake(HK1, vaultLens.coldkey(), 0), 1_000_000);
        handler.warp(3 days);
        handler.warp(3 days);
        handler.warp(3 days);

        handler.redeemDirect(1, type(uint256).max);
        assertEq(handler.dustBlocked(), 1);
        assertEq(handler.directRedeems(), 1);
        invariant_noUnexpectedReverts();
        // the refused exit burned before its walk reverted: forge recorded that Transfer, the chain keeps none, and the
        // step dropped it, so the fold still matches the token (I-34)
        invariant_tokenAccounting();

        // bob's 10 TAO staked onto the dust position, then he exits in full
        handler.stakeIdle();
        handler.redeemDirect(1, type(uint256).max);
        assertEq(handler.directRedeems(), 2);
        assertEq(vault.totalSupply(), 0);
        invariant_noUnexpectedReverts();
        invariant_grossAssetsConserved();
    }

    /// @dev A loss inside a burn window, then a delivery whose only payouts are bounced deposits: the vault
    /// burns nothing, so the window an earlier delivery filled against the higher base is not measured
    /// again against the lower one. (Found at 512 runs x depth 256: the handler checked the window on
    /// every queued payout batch, counting this as a violation.)
    function test_bounceAfterLossDoesNotRecheckBurnWindow() public {
        // alice, bob and carol deposit 200e18 each directly; neither amount is 3 mod 4 in rao. The keeper
        // stakes it and a day later all of it is in the allowance base.
        for (uint256 i; i < 3; ++i) {
            handler.depositDirect(i, 100_000_000_000);
            handler.depositDirect(i, 100_000_000_000);
        }
        handler.stakeIdle();
        handler.warp(1 days);
        // carol adds 800e18 directly, which stays liquid, outside the base
        for (uint256 i; i < 8; ++i) {
            handler.depositDirect(2, 100_000_000_000);
        }
        // alice asks for all of hers: the window allows 20% of the 600e18 staked, 120e18
        handler.requestRedeem(0, type(uint256).max);
        handler.closeBatch(0, 0, 0);
        (, uint256 burned) = vaultLens.burnWindows(handler.peer());
        assertEq(burned, 120e18);
        assertEq(vaultLens.pendingPayouts(), 120e18);

        // seed 7 * 680e18: all the liquid TAO not reserved for her payout is lost: 600e18 of assets left
        // against 1_280e24 shares, so the vault is insolvent
        handler.simulateLoss(7 * 680e18);
        assertEq(handler.ghostLoss(), 680e18);
        assertEq(vaultLens.totalAssets(), 600e18);
        // bob leaves directly at the lowered price: 200e24 * (600e18 + 1) / (1_280e24 + 1e6) = 93.75e18, all
        // of it unstaked, so the stake (the base) falls to 506.25e18
        handler.redeemDirect(1, type(uint256).max);
        assertEq(vaultLens.visibleStakeRao(), 506_250_000_000);

        // 12 hours into the same window, bob's 1 TAO bounces against a base of 506.25e18, whose 20%
        // (101.25e18) and the 100e18 minimum are both below the 120e18 already burned
        handler.deposit(1, 1_000_000_000);
        handler.closeBatch(0, 0, 0);
        assertEq(handler.depositBounces(), 1);
        assertEq(handler.queuedCount(), 2);
        (, burned) = vaultLens.burnWindows(handler.peer());
        assertEq(burned, 120e18);

        invariant_burnWindowsRespected();
        invariant_noUnexpectedReverts();
        invariant_grossAssetsConserved();
        invariant_pendingPayoutsMatchQueue();
    }

    // ---- Task 34a: the door's removals and its ways back ----

    /// @dev The owner removes the launch door (a seed whose draw acts, for the owner): it is Removed, the owner's hold closes the
    /// exits. While it is down bob's batch is refused UnknownPeer and filed, the queued payout refused
    /// FrontDoorInactive, carol's opt-back-in after a direct deposit refused UnknownOrigin, a shorter vesting period
    /// (a loosening) refused ExitsNotOpen at its schedule, and the owner's second removal PeerNotActive. The Reopen is
    /// scheduled and left pending (a seed whose draw leaves it: the invariant sees it name the Removed door), then executed by the next
    /// call, its 7 days and blocks waited out; the door is back, the filed batch delivers and the payout goes out.
    function test_theOwnersRemovalComesBackByItsReopen() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        handler.deposit(0, 10_000_000_000);
        handler.closeBatch(0, 0, 0);
        handler.requestRedeem(0, 5e24);
        handler.closeBatch(0, 0, 0);
        assertEq(handler.queuedCount(), 1);
        bytes32 peer = handler.peer();

        handler.removeDoor(_removalSeed(false));
        assertEq(handler.removalsByOwner(), 1);
        assertEq(uint8(vaultLens.doorState(peer)), uint8(DoorState.Removed));
        assertEq(uint8(vaultLens.launchDoorRemovedBy()), uint8(Actor.Owner));
        assertFalse(vaultLens.exitsOpen());

        handler.deposit(1, 1_000_000_000);
        handler.closeBatch(0, 0, 0);
        assertEq(handler.deliveriesRefusedDoorDown(), 1);
        assertEq(bridge.failedCount(), 1);
        handler.processPayouts(0, 0);
        assertEq(handler.payoutsRefusedDoorDown(), 1);
        assertEq(handler.payoutChunks(), 0);
        handler.depositDirect(2, 1_000_000_000);
        assertEq(handler.originsRefusedDoorDown(), 1);
        handler.setVesting(1 days);
        assertEq(handler.looseningsRefused(), 1);
        assertEq(handler.vestingChanges(), 0);
        handler.removeDoor(_removalSeed(false));
        assertEq(handler.removalsRefused(), 1);
        invariant_noUnexpectedReverts();

        handler.reopenDoor(_reopenSeed(true));
        assertEq(handler.reopensScheduled(), 1);
        assertEq(uint8(vaultLens.doorState(peer)), uint8(DoorState.Removed), "left pending");
        Item memory it = vaultLens.scheduled(keccak256(abi.encodeCall(vault.activateFrontDoor, (BASE, address(fd)))));
        assertEq(uint8(it.kind), uint8(Kind.Reopen));
        invariant_aPendingReopenNamesARemovedDoor();
        // the vault's one non-zero scheduled Item a committed state holds: both lenses checked beside it, the step's
        // kind-sorted words and the full cross product both
        invariant_vaultLensParity();
        invariant_doorLensParity();
        assertGt(handler.steps() % 8, 0, "a kind-sorted step");
        handler.warp(1 hours);
        handler.warp(1 hours);
        while (handler.steps() % 8 != 0) {
            handler.warp(1 hours);
        }
        assertGt(
            vaultLens.scheduled(keccak256(abi.encodeCall(vault.activateFrontDoor, (BASE, address(fd))))).readyAt, 0
        );
        invariant_vaultLensParity();
        invariant_doorLensParity();
        handler.reopenDoor(_reopenSeed(false));
        assertEq(handler.reopensExecuted(), 1);
        assertEq(uint8(vaultLens.doorState(peer)), uint8(DoorState.Active));
        assertEq(uint8(vaultLens.launchDoorRemovedBy()), uint8(Actor.None));
        assertTrue(vaultLens.exitsOpen());

        handler.retryDelivery();
        assertEq(handler.retriesDelivered(), 1);
        assertGt(vault.balanceOf(handler.actors(1)), 0, "bob's batch delivered");
        handler.processPayouts(0, 0);
        assertEq(handler.payoutChunks(), 1);

        invariant_noUnexpectedReverts();
        invariant_aPendingReopenNamesARemovedDoor();
        invariant_priceFallsOnlyByI4sExceptions();
        invariant_grossAssetsConserved();
        invariant_pendingPayoutsMatchQueue();
        invariant_vaultLensParity();
        invariant_doorLensParity();
        invariant_tokenAccounting();
    }

    /// @dev Task 10b's path: the owner removes the door and schedules its Reopen; the guardian then removes the
    /// owner-removed door (a seed whose draw acts, for the guardian), which makes it unknown, deletes the pending Reopen and makes the
    /// owner's hold the guardian's. A Reopen left pending past that would name a door that is not Removed, which the
    /// invariant refuses (shown on a forged door state). The way back is the guardian swap, then the door's Ordinary
    /// activation.
    function test_theGuardiansRemovalOfAnOwnerRemovedDoorDeletesItsReopen() public {
        handler.depositDirect(0, 10_000_000_000);
        bytes32 peer = handler.peer();
        bytes32 reopen = keccak256(abi.encodeCall(vault.activateFrontDoor, (BASE, address(fd))));
        handler.removeDoor(_removalSeed(false));
        handler.reopenDoor(_reopenSeed(true));
        assertGt(vaultLens.scheduled(reopen).readyAt, 0, "a Reopen pending");
        invariant_aPendingReopenNamesARemovedDoor();

        // the invariant is not vacuous: the same pending Reopen beside a door forged unknown fails it
        uint256 snap = vm.snapshotState();
        vm.store(address(vault), keccak256(abi.encode(peer, VaultLayout.SLOT_DOOR_STATE)), bytes32(0));
        vm.expectRevert();
        this.invariant_aPendingReopenNamesARemovedDoor();
        vm.revertToState(snap);

        handler.removeDoor(_removalSeed(true));
        assertEq(handler.removalsByGuardian(), 1);
        assertEq(handler.guardianRemovalsOfRemoved(), 1);
        assertEq(handler.reopensDeleted(), 1);
        assertEq(vaultLens.scheduled(reopen).readyAt, 0, "the Reopen deleted");
        assertEq(uint8(vaultLens.doorState(peer)), uint8(DoorState.Unknown));
        assertEq(uint8(vaultLens.launchDoorRemovedBy()), uint8(Actor.Guardian));
        invariant_aPendingReopenNamesARemovedDoor();
        // the guardian's removal of an unknown door is refused, but the run's removals are spent (MAX_REMOVALS)
        handler.removeDoor(_removalSeed(true));
        assertEq(handler.removalsRefused(), 0);

        handler.reopenDoor(_reopenSeed(false));
        assertEq(handler.swapRestores(), 1);
        assertEq(uint8(vaultLens.doorState(peer)), uint8(DoorState.Active));
        assertEq(uint8(vaultLens.launchDoorRemovedBy()), uint8(Actor.None));
        assertEq(vaultLens.guardian(), guardian, "swapped for the same guardian");

        invariant_noUnexpectedReverts();
        invariant_priceFallsOnlyByI4sExceptions();
        invariant_vaultLensParity();
        invariant_doorLensParity();
        invariant_tokenAccounting();
    }

    /// @dev The guardian removes the active door: unknown, its hold. Then the guardian's removal of the unknown door and
    /// the owner's are each refused PeerNotActive, as predicted; a draw that removes nothing brings the door back (the
    /// guardian swap, then the Ordinary activation), and one while the door is up does nothing.
    function test_aRemovalOfADoorThatIsNotActiveIsRefused() public {
        handler.removeDoor(_removalSeed(true));
        assertEq(handler.removalsByGuardian(), 1);
        assertEq(uint8(vaultLens.doorState(handler.peer())), uint8(DoorState.Unknown));
        // the guardian again, an unknown door; the owner, a door not active
        handler.removeDoor(_removalSeed(true));
        handler.removeDoor(_removalSeed(false));
        assertEq(handler.removalsRefused(), 2);
        // one draw in eight removes; another, while the door is down, brings it back, and while it is up does nothing
        handler.removeDoor(_idleSeed());
        assertEq(handler.removalsRefused(), 2);
        assertEq(handler.swapRestores(), 1);
        assertEq(uint8(vaultLens.doorState(handler.peer())), uint8(DoorState.Active));
        handler.removeDoor(_idleSeed());
        assertEq(uint8(vaultLens.doorState(handler.peer())), uint8(DoorState.Active));
        assertEq(handler.swapRestores(), 1);
        invariant_noUnexpectedReverts();
    }

    /// The first seed whose doorDraw removes the door, by the guardian or the owner.
    function _removalSeed(bool byGuardian) internal view returns (uint256 seed) {
        for (;; ++seed) {
            (bool acts, bool guardian_,) = handler.doorDraw(seed);
            if (acts && guardian_ == byGuardian) return seed;
        }
    }

    /// The first seed whose doorDraw does not remove the door.
    function _idleSeed() internal view returns (uint256 seed) {
        for (;; ++seed) {
            (bool acts,,) = handler.doorDraw(seed);
            if (!acts) return seed;
        }
    }

    /// The first seed whose doorDraw leaves a fresh Reopen pending, or executes it.
    function _reopenSeed(bool leavePending) internal view returns (uint256 seed) {
        for (;; ++seed) {
            (,, bool pending) = handler.doorDraw(seed);
            if (pending == leavePending) return seed;
        }
    }

    // ---- Task 34a: the step's logs, the fold, the block rolls, the boundary checks ----

    /// @dev The handler's warps roll the blocks (the schedulers read readyBlock, and the lapse its window in blocks):
    /// the free warp at the front door's calibrated 120 ms blocks, the close's 12 hours at the front door's, the
    /// payout's 24 hours at the vault's 7,200 ms (Revision 28).
    function test_theWarpsRollTheBlocks() public {
        // a test from before the door hold (R4 B-H1): its deliveries age every holder past it first
        handler.setAgeAtDeliveries(true);
        uint256 b = vm.getBlockNumber();
        handler.warp(1 hours);
        assertEq(vm.getBlockNumber(), b + 30_000);
        handler.deposit(0, 1_000_000_000);
        handler.closeBatch(0, 0, 0);
        assertEq(vm.getBlockNumber(), b + 30_000 + 360_000);
        handler.requestRedeem(0, 1e23);
        handler.closeBatch(0, 0, 0);
        uint256 b2 = vm.getBlockNumber();
        handler.processPayouts(0, 0);
        assertEq(vm.getBlockNumber(), b2 + 12_000);
        assertEq(handler.payoutChunks(), 1);
        invariant_noUnexpectedReverts();
    }

    /// @dev I-34's fold and I-33's loops are not vacuous: a balance written outside any Transfer fails the token
    /// accounting, and a vault lens whose code reads another layout (the door lens's, at its address) fails the vault
    /// lens's parity; the step's own logs stay readable to a test (stepLogs) though the step owns the buffer.
    function test_theBoundaryChecksCanFail() public {
        handler.depositDirect(0, 10_000_000_000);
        handler.deposit(1, 10_000_000_000);
        handler.setKeepLogs(true);
        handler.closeBatch(0, 0, 0);
        Vm.Log[] memory logs = handler.stepLogs();
        handler.setKeepLogs(false);
        uint256 transfers;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(vault) && logs[i].topics[0] == keccak256("Transfer(address,address,uint256)")
            ) {
                ++transfers;
            }
        }
        assertEq(transfers, 1, "bob's mint, in the close's logs");
        invariant_tokenAccounting();
        invariant_vaultLensParity();
        invariant_doorLensParity();

        uint256 snap = vm.snapshotState();
        address alice = handler.actors(0);
        bytes32 slot = keccak256(abi.encode(alice, VaultLayout.SLOT_SHARES + VaultLayout.SHARES_DATA_BALANCE_OF_SLOT));
        vm.store(address(vault), slot, bytes32(uint256(vm.load(address(vault), slot)) + 1));
        vm.expectRevert();
        this.invariant_tokenAccounting();
        vm.revertToState(snap);

        vm.etch(address(vaultLens), address(doorLens).code);
        vm.expectRevert();
        this.invariant_vaultLensParity();
    }

    /// @dev The lens parity cadence (fix round 1): the full cross product on every 8th step by the handler's step count,
    /// never a draw; on the others each bytes32 view the map names takes its own kind's words and the word nothing is
    /// stored under. Every map entry names a bytes32 view of a lens, so no entry is dead and a view the map misses
    /// takes every word.
    function test_theParityCadenceIsDeterministicAndItsMapNamesLensViews() public {
        assertEq(handler.steps(), 0);
        assertEq(wordKinds().views.length, 0, "the setUp's check: the full cross product");
        handler.warp(1 hours);
        WordKinds memory k = wordKinds();
        assertEq(k.views.length, 7);
        string[] memory vaultViews = vaultLensViews();
        string[] memory doorViews = doorLensViews();
        for (uint256 i; i < k.views.length; ++i) {
            assertEq(argumentTypes(k.views[i]), "(bytes32)", k.views[i]);
            assertTrue(listed(k.views[i], vaultViews) || listed(k.views[i], doorViews), k.views[i]);
            assertEq(k.words[i][k.words[i].length - 1], handler.NOTHING(), "the word nothing is stored under");
        }
        for (uint256 n = 1; n < 8; ++n) {
            assertEq(handler.steps(), n);
            assertEq(wordKinds().views.length, 7);
            handler.warp(1 hours);
        }
        assertEq(handler.steps(), 8);
        assertEq(wordKinds().views.length, 0, "every 8th step");
    }

    /// @dev I-34's holder-transfer check is not vacuous (review M-8). A test-only handler made the boundary's, its fold
    /// fed a forged vault Transfer(alice, bob) that no call emitted: holderTransfers counts it, and the per-account check
    /// fails (alice out, bob in, neither balance moved). A forged round trip (alice to bob and back) leaves every
    /// account's sum where its balance is, and the holder-transfer check alone fails.
    function test_aForgedHolderTransferFailsTheTokenAccounting() public {
        handler.depositDirect(0, 10_000_000_000);
        address alice = handler.actors(0);
        address bob = handler.actors(1);
        ForgedLogsHandler forged =
            new ForgedLogsHandler(TrackedHandler.System(vault, vaultLens, fd, doorLens, owner, guardian));
        vm.startPrank(owner);
        vault.setKeeper(address(forged));
        fd.setKeeper(address(forged));
        vm.stopPrank();
        setBoundary(forged, vault, DoorInternals(payable(address(fd))), vaultLens, doorLens);
        // alice's shares, from a mint the forged handler never saw, folded in as a mint
        forged.forgeTransfer(address(0), alice, vault.balanceOf(alice));
        invariant_tokenAccounting();

        uint256 snap = vm.snapshotState();
        forged.forgeTransfer(alice, bob, 1e24);
        assertEq(forged.holderTransfers(), 1);
        assertEq(forged.outflow(alice), 1e24);
        assertEq(forged.inflow(bob), 1e24);
        _assertTokenAccountingFails("I-34: 0x");
        vm.revertToState(snap);

        forged.forgeTransfer(alice, bob, 1e24);
        forged.forgeTransfer(bob, alice, 1e24);
        assertEq(forged.holderTransfers(), 2);
        _assertTokenAccountingFails("I-34: a Transfer between two holders");
    }

    /// invariant_tokenAccounting fails, its reason starting with `prefix`.
    function _assertTokenAccountingFails(string memory prefix) internal {
        try this.invariant_tokenAccounting() {
            fail();
        } catch (bytes memory reason) {
            // Error(string): the selector, the offset, the length, the text
            bytes memory text = new bytes(reason.length - 68);
            for (uint256 i; i < text.length; ++i) {
                text[i] = reason[68 + i];
            }
            bytes memory want = bytes(prefix);
            assertGe(text.length, want.length, string(text));
            for (uint256 i; i < want.length; ++i) {
                assertEq(text[i], want[i], string(text));
            }
        }
    }

    /// @dev The persisted counterexample (seed 0x6161...54d2) to invariant_cutNeverMovesPrice and
    /// invariant_priceNeverFallsExceptAcrossCancel (now invariant_priceFallsOnlyByI4sExceptions): rewards vest into
    /// the empty vault, a deposit-stake-redeem cycle unstakes part of them back into the liquid balance, a loss takes
    /// it, and the vault, empty again, owes more in unvested rewards than it holds while its assets read 0. The cut
    /// was minted there at the launch price and its value filled the hole; it is now skipped and the whole claim
    /// vests (the cut's naming of the treasury is a scheduled item, so its 48 hours pass first, the vault still
    /// underwater in its schedule). A direct deposit (refused there by Task 10c) now writes the schedule down to what
    /// the gross holds (Task 15: at a supply of 0 the unvested rewards are no holder's) and mints at the launch price,
    /// worth what it paid in; the price does not fall.
    function test_noCutAtAnEmptyUnderwaterVaultAndADepositWritesTheScheduleDown() public {
        handler.accrueAndClaim(12_873_845);
        handler.cycle(66_523_511_651_475, 3_429_937_920_164_812_171_578_319_212_222_972_578_087_370_599_320_449_345);
        handler.simulateLoss(1_408_989_069_049_650_969_816_446_827_302_910_708_196_822_280_549);
        assertEq(handler.losses(), 1);
        assertEq(vault.totalSupply(), 0);
        assertEq(vaultLens.totalAssets(), 0);
        // underwater past the vault's 1,000-rao tolerance
        assertLt(vaultLens.grossAssets() + 1_000e9, vaultLens.pendingPayouts() + vaultLens.unvestedRewards());

        handler.claimWithCut(19_300, 13_400);
        assertEq(handler.cutLoosenings(), 1);
        assertEq(handler.rewardClaims(), 2);
        assertEq(handler.cutsMinted(), 0);
        assertEq(handler.cutsSkipped(), 1);
        assertEq(vault.balanceOf(treasury), 0);
        assertEq(vault.totalSupply(), 0);

        _depositWritesTheScheduleDown();

        invariant_cutNeverMovesPrice();
        invariant_priceFallsOnlyByI4sExceptions();
        invariant_grossAssetsConserved();
        invariant_noUnexpectedReverts();
    }

    /// @dev The persisted sequence's state once the vesting remainder has shrunk the shortfall into the 1,000-rao
    /// window: the loss left the empty vault short of its unvested rewards, and as they vest the shortfall falls,
    /// passing through (1 rao, 1,000 rao] for under a minute; the handler's own warps can stop there. While any
    /// reward still vests, any shortfall skips the cut, so the price holds. (Under a tolerance on the whole
    /// shortfall, Task 10c's first rule, the cut and a deposit minted at the launch price and lowered it by the
    /// shortfall.) The cut's naming of the treasury is a scheduled item, so the handler stops 48 hours before that
    /// second and the item's wait lands the claim on it. A direct deposit then writes the schedule down (Task 15) and
    /// mints at the launch price, worth what it paid in: it fills no part of the hole.
    function test_noCutInsideTheToleranceWhileRewardsVestAndADepositWritesItDown() public {
        uint256 target = _toTheToleranceWindow(48 hours);
        handler.claimWithCut(1_000, 1_000_000);
        assertEq(vm.getBlockTimestamp(), target, "the claim lands in the window");
        // a skipped cut vests the whole claim, which adds as much to the gross as to the schedule
        _assertInTheToleranceWindow();
        assertEq(handler.cutsMinted(), 0);
        assertEq(handler.cutsSkipped(), 1);
        assertEq(vault.totalSupply(), 0);
        _depositWritesTheScheduleDown();

        invariant_cutNeverMovesPrice();
        invariant_priceFallsOnlyByI4sExceptions();
        invariant_grossAssetsConserved();
        invariant_noUnexpectedReverts();
    }

    /// The handler's direct deposit of 1 TAO at an empty vault underwater in its schedule alone: the schedule is
    /// written down to what the gross holds beyond the queued payouts, exactly, and the deposit mints at the launch
    /// price, worth what it paid in (Task 15).
    function _depositWritesTheScheduleDown() internal {
        uint256 cover = vaultLens.grossAssets() - vaultLens.pendingPayouts();
        assertGt(vaultLens.unvestedRewards(), cover, "underwater in the schedule alone");
        assertEq(vault.totalSupply(), 0);
        uint256 directBefore = handler.directDeposits();
        handler.depositDirect(1, 1_000_000_000);
        assertEq(handler.directDeposits(), directBefore + 1);
        assertEq(vaultLens.unvestedRewards(), cover, "written down exactly");
        assertEq(vaultLens.vestingStart(), vm.getBlockTimestamp());
        // the launch price: 1e18 * (0 + 1e6) / (0 + 1)
        assertEq(vault.totalSupply(), 1e24);
        assertEq(vaultLens.totalAssets(), 1e18);
        assertEq(vaultLens.price(), 1e12);
    }

    /// @dev The same state once the vesting period has passed: nothing is left vesting, the gross covers the
    /// (empty) payout queue, so deposits mint again, at full value. No lock.
    function test_depositsReopenOnceTheRemainderHasVested() public {
        _toTheToleranceWindow(0);
        _assertInTheToleranceWindow();
        handler.warp(3 days);
        handler.warp(3 days);
        handler.warp(1 days);
        assertEq(vaultLens.unvestedRewards(), 0);
        handler.depositDirect(1, 1_000_000_000);
        assertEq(handler.directDeposits(), 1);
        // worth what was paid in, less under one share's rounding (shares are coarse at a supply of 0 with
        // assets, see test_cutIntoEmptyVaultRoundsByLessThanOneShare)
        uint256 assets = vaultLens.totalAssets();
        uint256 supply = vault.totalSupply();
        uint256 value = CascadeMath.assetsForRedeem(vault.balanceOf(handler.actors(1)), assets, supply);
        assertGe(value + CascadeMath.assetsForRedeem(1, assets, supply), 1e18);

        invariant_priceFallsOnlyByI4sExceptions();
        invariant_grossAssetsConserved();
        invariant_noUnexpectedReverts();
    }

    /// The persisted sequence's first three calls, then the handler's warps to `lead` seconds before the first second
    /// at which the vault's shortfall (all of it in the unvested remainder) is at most 500 rao; returns that second.
    function _toTheToleranceWindow(uint256 lead) internal returns (uint256 target) {
        handler.accrueAndClaim(12_873_845);
        handler.cycle(66_523_511_651_475, 3_429_937_920_164_812_171_578_319_212_222_972_578_087_370_599_320_449_345);
        handler.simulateLoss(1_408_989_069_049_650_969_816_446_827_302_910_708_196_822_280_549);
        uint256 covered = vaultLens.grossAssets() - vaultLens.pendingPayouts();
        // the unvested remainder after e seconds, v * (T - e) / T, at most covered + 500 rao
        uint256 v = vaultLens.vestingAmount();
        uint256 period = vaultLens.vestingPeriod();
        uint256 e = period - (covered + 500e9) * period / v;
        while (v * (period - e) / period > covered + 500e9) {
            ++e;
        }
        target = vaultLens.vestingStart() + e;
        uint256 stop = target - lead;
        assertGt(stop, vm.getBlockTimestamp(), "the window is more than the lead away");
        while (vm.getBlockTimestamp() < stop) {
            uint256 need = stop - vm.getBlockTimestamp();
            // each warp is 1 hour to 3 days; never leave less than an hour for the last
            handler.warp(need <= 3 days ? need : (need - 3 days < 1 hours ? need - 1 hours : 3 days));
        }
        assertEq(vm.getBlockTimestamp(), stop);
    }

    /// The vault's shortfall, all of it in the unvested remainder, lies in (1 rao, 1,000 rao], the window a
    /// tolerance on the whole shortfall would let a mint through, at a supply of 0.
    function _assertInTheToleranceWindow() internal view {
        uint256 shortfall = vaultLens.pendingPayouts() + vaultLens.unvestedRewards() - vaultLens.grossAssets();
        assertGt(shortfall, 1e9);
        assertLe(shortfall, 1_000e9);
        assertGt(vaultLens.unvestedRewards(), 0);
        assertEq(vault.totalSupply(), 0);
    }

    /// @dev The fuzzer's counterexample to a fixed "+1" tolerance, in round numbers: 1 TAO of rewards vests into a
    /// vault with no shares, and 1/14 of its period later a claim of 1 TAO with a 10% cut mints the treasury at the
    /// pre-claim price, where one share is worth about 7.1e10 wei. Rounding its shares down lifts the price by far
    /// more than 1 in its 18 decimals, yet by less than one share: the treasury gets its 1e17 cut less under one
    /// share's worth, which stays with the vault. The cut is a scheduled loosening whose 48 hours pass inside
    /// claimWithCut, so the period is 28 days (an increase, at once), and 48 hours are the same 1/14 that 12 hours
    /// were of 7 days.
    function test_cutIntoEmptyVaultRoundsByLessThanOneShare() public {
        handler.setVesting(28 days);
        assertEq(vaultLens.rewardVesting(), 28 days);
        // S = 0: the whole 1e18 vests over 28 days; 48 hours in, 1e18 - 1e18 * 13 / 14 (rounded down) has vested
        handler.accrueAndClaim(1e9);
        assertEq(vault.totalSupply(), 0);

        // A = 71_428_571_428_571_429, S = 0: 1e17 * 1e6 / (A + 1) = 1_399_999.99..., rounded down
        handler.claimWithCut(1_000, 1e9);
        assertEq(handler.cutLoosenings(), 1);
        assertEq(handler.cutsMinted(), 1);
        assertEq(vault.balanceOf(treasury), 1_399_999);
        assertEq(vaultLens.totalAssets(), 71_428_571_428_571_429 + 1e17);

        // (A + 1) * 1e18 / 1e6, then (A + 1e17 + 1) * 1e18 / (1_399_999 + 1e6), and with one more share
        uint256 before = handler.claimPriceBefore(1);
        assertEq(before, 71_428_571_428_571_430_000_000_000_000);
        assertEq(handler.claimPriceAfter(1), 71_428_601_190_488_591_870_246_612_602);
        assertGt(handler.claimPriceAfter(1), before + 1);
        assertEq(handler.claimPriceOneMoreShare(1), 71_428_571_428_571_429_166_666_666_666);
        assertLe(handler.claimPriceOneMoreShare(1), before);

        // the treasury is short of its cut by 29_761_917_162 wei, under one share's 71_428_601_190
        uint256 value = CascadeMath.assetsForRedeem(1_399_999, vaultLens.totalAssets(), vault.totalSupply());
        assertEq(value, 99_999_970_238_082_838);
        assertLt(1e17 - value, CascadeMath.assetsForRedeem(1, vaultLens.totalAssets(), vault.totalSupply()));

        invariant_cutNeverMovesPrice();
        invariant_priceFallsOnlyByI4sExceptions();
        invariant_grossAssetsConserved();
        invariant_noUnexpectedReverts();
    }
}
