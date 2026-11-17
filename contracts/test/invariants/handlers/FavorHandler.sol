// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeMessages} from "../../../src/libraries/CascadeMessages.sol";
import {CascadeMath} from "../../../src/libraries/CascadeMath.sol";
import {CascadeFormulas} from "../../../src/libraries/CascadeFormulas.sol";
import {
    AdoptTooSoon,
    BelowMinAdoption,
    NotKeeper,
    NothingToCancel,
    NothingToStake
} from "../../../src/CascadeErrors.sol";
import {KEEPER_FALLBACK} from "../../../src/CascadeConstants.sol";
import {
    DepositBounced,
    Deposited,
    PayoutBatchQueued,
    RedeemDeferred,
    Redeemed,
    RewardCutMinted,
    RewardsClaimed
} from "../../../src/CascadeEvents.sol";
import {PayoutBatch} from "../../../src/CascadeTypes.sol";
import {MockBridge} from "../../mocks/MockBridge.sol";
import {MockTAO} from "../../mocks/MockTAO.sol";
import {FrontDoorTracker} from "./FrontDoorTracker.sol";
import {VaultModel} from "./VaultModel.sol";

/// @notice The vault-favour campaign's handler (Task 42, from the R4 vault-favour review: "no one gains except by time
/// held"), over CampaignFixture's world (the vault on Bittensor, one front door on Base over MockBridge), at the
/// launch's reward settings: a 10% cut to the treasury and rewardVesting of 30 days. Four actors, the keeper and the
/// owners:
/// - two honest holders, who deposit (at the door and directly) and stay: the holders the founder's rule protects;
/// - the attacker, who does everything a holder can: deposits at the door or directly, asks the door to redeem (in the
///   same batch as a deposit too, and right after a late deposit), cancels either, exits directly, claims on Base,
///   claims the rewards itself once the keeper's fallback has passed (and the moment the claim schedule has fully
///   vested, `claimAtVestEnd`, R7), enters late in a claim gap (`lateEntry`, the shape of the review's Medium 1), and
///   retries a failed delivery at the moment it picks (`retryDelivery`);
/// - the stranger, who holds no shares: it gives stake to the vault's hotkey (a gift, booked only by an adoption, which
///   vests), forces native TAO into the vault (a donation, priced at once) and claims the rewards itself once the
///   fallback has passed ("a stranger picks the moment", the review's Low 2), the vested schedule's end included;
/// - the keeper (the handler), which closes batches, sends payouts (topping up the fee above the ceiling), stakes,
///   claims at a random gap up to 30 days (a round: the stake hotkey and the standby, R6b U1), adopts and retries a
///   failed delivery; the owner's moves put up to a quarter of the stake on the standby, a second listed hotkey that
///   accrues at half the rate, so a holder's or the stranger's claim of one hotkey is a partial claim;
/// - the guardian, who pauses the vault (the owner unpauses: a door's delivery meanwhile is refused and filed by the
///   bridge, the failure branch this world has, retried later by the attacker or the keeper), and the owner, who
///   cancels a queued batch's unsent payouts (`ownerCancel`: the re-mint). The chain's removal fee is switched at
///   random.
///
/// Rewards accrue with time (`_passTime`, the only way time moves): root rewards on the vault's stake at APR_PERCENT a
/// year, credited to the mock's unclaimed balance, and claimed by the keeper at least every CLAIM_GAP (the vesting
/// period: the stated precondition of gainsOnlyByTimeShare, the review's Medium 1, which holds only once claims come no
/// further apart than the vesting period). The attacker's `allowance` (its time share) takes, at the shares it holds at
/// each moment over the supply, rounded up: its share of each accrual of rewards, net of the cut; its share of each
/// donation when it lands; its share of each gift as it vests (an adopted gift vests on the adoption drip, the
/// rewards on the claim schedule: Revision 27, so a warp's release is split by the two drips' own reads); and its
/// share of the vest above the accrual rate, as far as the stake that left the vault funded it (`recaptured`: the
/// rerun's counterexample, Task 42's fix round 3; the pool rebuilt in fix round 4, the review's I-1). A claim restarts
/// the claim schedule on what is left of it and the claim, over 30 days from then, whatever the stake did since the
/// rewards accrued: once stake has left, the schedule vests faster than the smaller stake accrues, and every holder
/// then gets more than its share of the accrual, out of what the departed stake earned before it left. Only the
/// attacker leaves here, so only its departures fund the pool (`recapturePool`; the departure credits,
/// `departedCredit`): at each departure whose walk took booked stake (a payout
/// chunk paying its entries, by their part of the chunk's value, or its direct exit), the pool takes the net reward
/// rate (APR_PERCENT less the cut) x the booked stake the walk took x the vesting period (30 days, the longest claim
/// gap: a position's unclaimed and unvested rewards together are at most that rate x the position x the period while
/// claims come no further apart, so this bounds what the departed stake can still add to the release beyond the
/// accrual), rounded up. A queued payout's stake earns nothing for the pool while it waits (it is still the vault's
/// stake, and its rewards accrue as they come), a burn's forfeit adds nothing (the attacker's share of it is already in
/// its allowance, credited as it accrued), liquid balance that pays a payout never earned, and the stranger's unadopted
/// gifts are not booked, so they never count as departed stake. Departures were the pool's only credit until R7, when
/// seed 9402 found a fall in the reward rate does the same: the owner's move onto the standby, at half the rate, mid-
/// schedule (`moveToStandby` credits the rate given up x the moved stake x the period, `movedCredit`). Fix round 4
/// found another source, an adoption's restart of the one schedule (it re-spread the rewards left over a fresh
/// period, so rewards that accrued earlier vested later, above the accrual of then), credited for a while
/// (`delayedCredit`, removed); since Revision 27 an adoption vests on its own drip and never restarts the claim
/// schedule, so that source is gone (pinned in the campaign, and the old behaviour's mutation fails it). A credit
/// never lifts the pool above the rewards still to vest (the claim schedule's unvested and the unclaimed rewards net
/// of the cut; review M-1): what is above is cut (`cappedCredit`). Each credit lasts two vesting periods
/// (CREDIT_LIFE: its unclaimed rewards are claimed within one and vest over the next; time stops at each expiry, so a
/// credit funds no warp past it) and is spent oldest first. An owner's cancel takes no credit back: it re-mints only
/// unsent entries, whose stake no walk took. A warp's vest above that warp's net accrual is credited at the attacker's
/// share only as far as the pool holds (and spends it); the rest is logged (`unfundedVest`) and credited to no one, so
/// a schedule that released faster than the stake that earned it (a lump vesting at once, or over less than the gap)
/// is still the attacker's gain beyond its bound. The credit is an upper bound, not the exact recapture: it can count
/// again what the attacker forfeited at its burn (already in its allowance), and a departure's excess decays over
/// later restarts, so a tail of it past CREDIT_LIFE goes unfunded (logged, credited to no one).
///
/// Wealth (`wealthOf`): an actor's native TAO (its fee money with it), its bridged TAO on Base, its credit on Base, its
/// deposit in the open batch, its deposits in a closed batch whose delivery failed (at face, till the retry delivers
/// it), its queued payout entries at the value they were burned for, and its shares at the exact price (totalAssets() +
/// 1) / (totalSupply + 1e6), floored. The keeper's is its native TAO. What each invariant reads:
/// - noActorGainsByActing: across every action but time's, the acting actor's wealth does not rise (`selfGains`), a
///   holder's own reward claim excepted by its share of the cut's rounding (the treasury's shares round down, holders
///   over the treasury, under 2 wei), allowed 1 rao; and across every action the attacker does not make (the keeper's
///   closes, payouts, stakes, claims and adoptions, which price every door-path mint, burn and payout; the owner's
///   cancel and pause; the honest holders' and the stranger's acts; a retry), the attacker's wealth does not rise
///   beyond that action's rounding dust, 1 rao an entry it prices and 1 more (`attackerGains`; a donation lets it rise
///   by its share, which its allowance takes).
/// - gainsOnlyByTimeShare: the attacker gains no more than its allowance, plus 1 rao an action; the stranger never
///   gains. No one leaves but the attacker (the honest holders stay; the stranger holds nothing), so no one else's
///   forfeit can reach it. Its own can (the premise before Task 42's fix round 3 said none could, and the rerun's
///   counterexample shows it): what its departed stake earned before it left vests to whoever holds then, its later
///   shares included, which the allowance's recapture term takes, funded by the stake that left alone. That premise
///   holds only while an adoption leaves the claim schedule alone (Revision 27), asserted with the bound
///   (`adoptionsMovedClaims`).
///   The honest holders have no bound of their own (the review asked one for every actor): they never act against the
///   vault (their only acts are deposits and cancels), and what reaches them is bounded by gainsAreConserved.
/// - gainsAreConserved: every actor's gain and the keeper's together, plus the stranger's gifts the vault has not
///   booked yet (the stake visible above the booked: their giver's loss, no one's gain yet), are at most the rewards
///   claimed net of the cut less what of the schedule is still unvesting (rewards and adopted gifts alike: an adopted
///   gift is its giver's loss and becomes the holders' gain only as it vests), plus 1 rao an action: every gain is
///   matched by a loss or a vested reward. Its slack is only what leaves the world (the bridge's and the chain's fees,
///   the keeper's top-ups) and the treasury's share of what vests after its cut.
/// The treasury's cut is the stated exception (it never acts; the review's Low 3, its fee excess, does not arise over
/// MockBridge). Not in this world (the README's "Vault favour" names the campaigns and pins that hold them): a park and
/// its delivery or refund (no adapter here: MockBridge refuses nothing but the paused vault's), a bounce (one door, no
/// loss), and stake missing; nor the review's griefing actions (a gift deposit, filling a batch's room, forcing a
/// failure, raising the bridge fee, halting a lane, and its assertion 3).
///
/// Refusals each action may meet, each predicted from the state; any other is unexpected: depositDirect, redeemDirect,
/// processPayouts, stakeIdle and adopt EnforcedPause while the vault is paused; redeemDirect ZeroAmount and
/// UnstakeShort as VaultModel's _exitPlan says; processPayouts FeeTooHigh and UnstakeShort as VaultModel's
/// _chunkOutcome says (the whole fee as value); claimRewards NotKeeper (a holder before the fallback, or while the
/// claim schedule still vests, R6b U1); adopt
/// AdoptTooSoon (inside a day of the last) and BelowMinAdoption (a surplus below the chain's minimum); stakeIdle
/// NothingToStake (what it would stake under the chain's minimum, `_stakeRefusal`); ownerCancel NothingToCancel
/// (nothing unsent to re-mint); a retry fails only while the vault is paused; cancel (a deposit) CancelTooSoon within
/// five minutes of the canceller's last door deposit (R11, FrontDoorTracker's model, the exact revert data; waived while
/// the door is paused or its primary disabled, R12, neither of which this campaign does).
contract FavorHandler is VaultModel, FrontDoorTracker {
    struct Parts {
        MockTAO tao;
        MockBridge bridge;
        uint64 doorChain;
    }

    /// The root rewards' rate, a year, on the stake hotkey; and the standby's (R6b U1: a second listed hotkey that
    /// accrues unevenly, at half the rate, so a claim of one hotkey alone is a partial claim). The departure credit
    /// counts every booked rao at APR_PERCENT, the higher, so it stays an upper bound.
    uint256 public constant APR_PERCENT = 20;
    uint256 public constant STANDBY_APR_PERCENT = 10;
    /// The standby hotkey (the owner's listing in the constructor; its stake comes only by the owner's moves,
    /// `moveToStandby`).
    bytes32 public constant STANDBY = bytes32(uint256(2));
    /// The longest gap between two claims: the vesting period (rewardVesting at launch, Appendix B).
    uint256 public constant CLAIM_GAP = 30 days;
    /// How long a departure's credit to the recapture pool lasts: two vesting periods (see the contract's notes).
    uint256 public constant CREDIT_LIFE = 2 * CLAIM_GAP;
    uint256 internal constant ACTORS = 4;
    uint256 internal constant MAX_DEPOSIT = 25e18;
    uint32 internal constant CHUNK_ENTRIES = 3;

    MockTAO public immutable tao;
    MockBridge public immutable bridge;
    bytes32 public immutable hotkey;
    uint64 public immutable doorChain;

    /// honest[0], honest[1], the attacker, the stranger.
    address[ACTORS] public actors;

    /// Each actor's wealth when the campaign began (`begin`), and the attacker's allowance (its time share).
    mapping(address => uint256) public startWealth;
    uint256 public allowance;
    bool public begun;
    /// The mock's unclaimed rewards (rao) on the stake hotkey and on the standby, the handler's last claim of each
    /// (`lastClaimAt`, the earlier of them: the keeper's rounds claim both, so the precondition is a round at least
    /// every CLAIM_GAP), and the rewards the vault booked from claims net of the cut (wei).
    uint256 public unclaimedRao;
    uint256 public standbyUnclaimedRao;
    uint256 public stakeHotkeyClaimAt;
    uint256 public standbyClaimAt;
    uint256 public netRewardsClaimed;
    /// The recapture term (see the contract's notes), in wei: the pool (the unexpired credits left), what the
    /// attacker's departures credited in all (`departedCredit`, after the cap), what the owner's moves onto the
    /// lower-rate standby credited (`movedCredit`, R7), what the cap cut (`cappedCredit`), what expired unspent, what
    /// the allowance took of the vest above the accrual rate at its share, and the vest above it that nothing funded.
    uint256 public recapturePool;
    uint256 public departedCredit;
    uint256 public movedCredit;
    uint256 public cappedCredit;
    uint256 public expiredCredit;
    uint256 public recaptured;
    uint256 public unfundedVest;
    /// The pool's credits, oldest first: when each was made and what is left of it; `_creditHead` is the oldest with
    /// something left and unexpired.
    uint256[] internal _creditAt;
    uint256[] internal _creditLeft;
    uint256 internal _creditHead;

    /// The vault's queued payout lists, from the Redeemed and DepositBounced events, in order.
    bytes32[] public queuedKeys;
    mapping(bytes32 => CascadeMessages.Payout[]) internal _lists;

    /// The deposits of each closed batch whose delivery the bridge filed as failed, in the bridge's order (its retry
    /// takes the oldest and files a failure again at the back): `_transit[_transitHead]` is the next it retries.
    mapping(uint256 => CascadeMessages.Entry[]) internal _transit;
    uint256 internal _transitHead;
    uint256 internal _transitTail;

    // ---- what the invariants read ----

    /// Actions after which the acting actor was wealthier than before, the last one's actor, tag and excess.
    uint256 public selfGains;
    address public lastSelfGainer;
    bytes32 public lastSelfGainAction;
    uint256 public lastSelfGainWei;
    /// Actions the attacker did not make after which it was wealthier beyond their dust, the last one's tag and excess.
    uint256 public attackerGains;
    bytes32 public lastAttackerGainAction;
    uint256 public lastAttackerGainWei;
    /// Gaps between claims longer than CLAIM_GAP (the precondition; asserted 0).
    uint256 public claimGapOverruns;
    /// Adoptions that moved the claim schedule (its amount, start or period): the recapture term's premise since
    /// Revision 27, that departures alone can make the vest outrun the accrual, holds only while an adoption vests on
    /// its own drip (asserted 0).
    uint256 public adoptionsMovedClaims;

    // ---- reach ----

    uint256 public doorDeposits;
    uint256 public directDeposits;
    uint256 public requests;
    uint256 public sameBatchPairs;
    uint256 public depositCancels;
    uint256 public requestCancels;
    uint256 public closes;
    uint256 public burns;
    uint256 public deferrals;
    uint256 public payoutChunks;
    uint256 public topUpChunks;
    uint256 public payoutsRefused;
    uint256 public baseClaims;
    uint256 public directExits;
    uint256 public directExitsRefused;
    uint256 public stakes;
    uint256 public rewardClaims;
    uint256 public forcedClaims;
    /// The attacker's and the stranger's claims past the fallback: made, or refused NotKeeper while the claim schedule
    /// still vested (R6b U1); and those refusals alone.
    uint256 public holderClaims;
    uint256 public strangerClaims;
    uint256 public claimsHeldWhileVesting;
    /// The attacker's and the stranger's claims the vault took (R7: under U1 the counts above are nearly all
    /// refusals), and those of them made once a claim schedule had fully vested (`claimAtVestEnd`'s moment).
    uint256 public outsideClaimsMade;
    uint256 public claimsAtVestEnd;
    uint256 public standbyMoves;
    uint256 public cutsMinted;
    uint256 public gifts;
    uint256 public adoptions;
    uint256 public adoptionsRefused;
    uint256 public donations;
    uint256 public feeSwitches;
    /// The owner's cancels that re-minted (and those refused NothingToCancel), the guardian's pauses and the owner's
    /// unpauses, the closes whose delivery the paused vault refused, and the retries (by the attacker among them) that
    /// delivered and that failed again.
    uint256 public ownerCancels;
    uint256 public cancelsRefused;
    uint256 public pauses;
    uint256 public unpauses;
    uint256 public failedDeliveries;
    uint256 public retriesDelivered;
    uint256 public retriesByAttacker;
    uint256 public retriesFailed;
    /// The attacker's mints in the last third of a claim gap (a late entry, Medium 1's shape; lateEntry's draws among
    /// them), and its exits while rewards were still vesting (a forfeit to the stayers).
    uint256 public lateEntries;
    uint256 public lateEntryDraws;
    uint256 public exitsWhileVesting;
    /// The attacker's closest approach to its bound while it was ahead (wei: its allowance and tolerance less its gain,
    /// at the step it was least, over the steps its gain was above 0), and gainsAreConserved's (wei: its bound less its
    /// sum, at the step it was least).
    uint256 public closestMargin = type(uint256).max;
    uint256 public closestConservationMargin = type(uint256).max;

    constructor(System memory s, Parts memory p) VaultModel(s) {
        tao = p.tao;
        bridge = p.bridge;
        doorChain = p.doorChain;
        hotkey = s.vaultLens.stakeHotkey();
        actors = [
            makeAddr("favor: honest hana"),
            makeAddr("favor: honest hugo"),
            makeAddr("favor: attacker mallory"),
            makeAddr("favor: stranger sam")
        ];
        for (uint256 i; i < ACTORS; ++i) {
            p.tao.mint(actors[i], 500e18);
            vm.prank(actors[i]);
            p.tao.approve(address(s.fd), type(uint256).max);
            vm.deal(actors[i], 500e18);
            _trackAccount(actors[i]);
        }
        _trackWord(hotkey, WordKind.Hotkey);
        _trackWord(STANDBY, WordKind.Hotkey);
        _trackPeer(p.doorChain, address(s.fd));
        _trackDoor(s.fd);
        // the standby, listed by the owner (no stake on it until the owner moves some)
        staking.addHotkey(STANDBY);
        vm.prank(s.owner);
        s.vault.addHotkey(STANDBY);
        stakeHotkeyClaimAt = vm.getBlockTimestamp();
        standbyClaimAt = vm.getBlockTimestamp();
    }

    /// The handler's last claim, the earlier of the two hotkeys' (the stake hotkey's alone while the standby is idle:
    /// no stake, nothing unclaimed): the keeper's next round is due CLAIM_GAP after it.
    function lastClaimAt() public view returns (uint256) {
        return _standbyIdle() ? stakeHotkeyClaimAt : Math.min(stakeHotkeyClaimAt, standbyClaimAt);
    }

    /// Whether the standby holds no stake and nothing unclaimed: a claim of the stake hotkey then covers it (a
    /// one-hotkey world, as the campaign was before R6b, whose pinned sequences replay unchanged).
    function _standbyIdle() internal view returns (bool) {
        return staking.getStake(STANDBY, coldkey, 0) == 0 && standbyUnclaimedRao == 0;
    }

    /// @dev Takes the unused part of each close's budget and each payout's top-up back.
    receive() external payable {}

    /// Records every actor's and the keeper's wealth at the start (the test calls it once, after funding the keeper).
    function begin() external {
        require(!begun, "begun");
        begun = true;
        for (uint256 i; i < ACTORS; ++i) {
            startWealth[actors[i]] = wealthOf(actors[i]);
        }
        startWealth[address(this)] = wealthOf(address(this));
    }

    function attacker() public view returns (address) {
        return actors[2];
    }

    function stranger() public view returns (address) {
        return actors[3];
    }

    // ==== the holders ====

    /// @dev An honest holder or the attacker deposits 1 to 25 TAO at the front door.
    function doorDeposit(uint256 actorSeed, uint256 amount) external step {
        address a = actors[actorSeed % 3];
        uint256 w = wealthOf(a);
        uint256 wa = wealthOf(attacker());
        _doorDeposit(a, amount);
        _checkSelf(a, w, "doorDeposit");
        if (a != attacker()) _checkAttacker(wa, "doorDeposit", 0);
    }

    /// @dev The attacker asks the door to redeem 1 to all of its shares not yet asked (all one draw in four).
    function doorRequest(uint256 seed, uint256 shares) external step {
        address a = attacker();
        uint256 w = wealthOf(a);
        _request(a, seed, shares);
        _checkSelf(a, w, "doorRequest");
    }

    /// @dev The attacker deposits and asks to redeem its shares in one open batch, both priced at the batch's one price
    /// when the keeper closes it.
    function sameBatch(uint256 seed, uint256 amount, uint256 shares) external step {
        address a = attacker();
        uint256 w = wealthOf(a);
        if (_doorDeposit(a, amount) && _request(a, seed, shares)) ++sameBatchPairs;
        _checkSelf(a, w, "sameBatch");
    }

    /// @dev An honest holder or the attacker cancels its open deposit, or the attacker its open request.
    function cancel(uint256 actorSeed) external step {
        address a = actors[actorSeed % 3];
        uint256 w = wealthOf(a);
        uint256 wa = wealthOf(attacker());
        uint256 open = fd.depositOf(a);
        if ((actorSeed >> 4) % 2 == 0 && open != 0) {
            // within five minutes of a's last deposit, CancelTooSoon (R11: FrontDoorTracker's model)
            bytes memory tooSoon = _cancelTooSoon(fd, a);
            vm.prank(a);
            try fd.cancelDeposit(open) {
                // a predicted refusal lost
                if (tooSoon.length != 0) ++unexpectedReverts;
                ++depositCancels;
            } catch (bytes memory reason) {
                if (!_refusedTooSoon(reason, tooSoon)) _refused(reason, 0);
            }
        } else if (fd.redeemOf(a) != 0) {
            uint256 asked = fd.redeemOf(a);
            vm.prank(a);
            try fd.cancelRedeem(asked) {
                ++requestCancels;
            } catch (bytes memory reason) {
                _refused(reason, 0);
            }
        }
        _checkSelf(a, w, "cancel");
        if (a != attacker()) _checkAttacker(wa, "cancel", 0);
    }

    /// @dev The attacker claims its credits on Base.
    function claimBase() external step {
        address a = attacker();
        if (fd.claimable(a) == 0) return;
        uint256 w = wealthOf(a);
        vm.prank(a);
        try fd.claim() {
            ++baseClaims;
        } catch (bytes memory reason) {
            _refused(reason, 0);
        }
        _checkSelf(a, w, "claimBase");
    }

    /// @dev An honest holder or the attacker deposits 0.01 to 25 TAO directly (its origin then DIRECT_ORIGIN); the
    /// attacker names the door's chain again one draw in two, so the door can burn its shares.
    function depositDirect(uint256 actorSeed, uint256 amount) external step {
        _depositDirect(actorSeed % 3, actorSeed >> 4, amount, "depositDirect");
    }

    /// @dev Medium 1's shape, aimed at (a targeted draw, ruling B9): time passes to 1 hour to 10 days before the
    /// keeper's next claim at the vesting period's gap, and the attacker deposits 1 to 25 TAO directly, which the
    /// keeper stakes, so it holds through the claim and the lump's vesting having held for little of its accrual.
    function lateEntry(uint256 seed, uint256 amount) external step {
        uint256 from = lastClaimAt() + CLAIM_GAP - bound(seed, 1 hours, 10 days);
        if (vm.getBlockTimestamp() < from) _passTime(from - vm.getBlockTimestamp());
        if (_depositDirect(2, seed >> 64, bound(amount, 1e18 / RAO, MAX_DEPOSIT / RAO), "lateEntry")) {
            ++lateEntryDraws;
            uint256 wa = wealthOf(attacker());
            _stake();
            _checkAttacker(wa, "lateEntry: stake", RAO);
        }
    }

    /// @dev The attacker exits directly with 1 to all of its shares.
    function redeemDirect(uint256 seed, uint256 shares) external step {
        address a = attacker();
        uint256 held = vault.balanceOf(a);
        if (held == 0) return;
        shares = seed % 4 == 0 ? held : bound(shares, 1, held);
        uint256 w = wealthOf(a);
        bool vesting = vaultLens.unvestedRewards() != 0;
        bytes4 expect = _directRefusal(shares);
        uint256 booked = vaultLens.bookedStake();
        _readLogs();
        vm.prank(a);
        try vault.redeemDirect(shares, false) {
            _succeeded(expect);
            _departed(booked, 1, 1);
            ++directExits;
            if (vesting) ++exitsWhileVesting;
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, expect)) ++directExitsRefused;
        }
        _checkSelf(a, w, "redeemDirect");
    }

    /// @dev The attacker, or the stranger, claims one hotkey's rewards itself, the stake hotkey's or the standby's
    /// (permissionless once KEEPER_FALLBACK has passed since that hotkey's last claim, and since R6b U1 only while the
    /// claim schedule holds nothing still vesting; NotKeeper otherwise, as predicted): it picks the moment and the
    /// hotkey, so a claim of the standby alone is a partial claim.
    function holderClaim(uint256 seed) external step {
        _outsideClaim(seed % 2 == 0 ? attacker() : stranger(), (seed >> 1) % 2 == 0 ? hotkey : STANDBY, "holderClaim");
    }

    /// @dev The attacker or the stranger claims one hotkey's rewards the moment the claim schedule has fully vested
    /// (R7, the R6b review's coverage note: U1 refuses a non-keeper's claim while the schedule still vests, so the
    /// claims above meet a vesting schedule nearly every time). Time passes to the schedule's end when that is ahead
    /// and no later than the keeper's next round is due, and stops there before that round (it follows at the same
    /// moment: at the next step that passes time, or the keeper's own claim, so no claim gap overruns); the claim must
    /// then succeed, the hotkey's fallback long past. A schedule already over (none yet: the start) claims at once; a
    /// schedule ending after the round is due (a later restart than the round's) is left to the keeper.
    function claimAtVestEnd(uint256 seed) external step {
        uint256 end = uint256(vaultLens.vestingStart()) + vaultLens.vestingPeriod();
        if (end > vm.getBlockTimestamp()) {
            if (end > lastClaimAt() + CLAIM_GAP) return;
            _passTimeTo(end, false);
        }
        _outsideClaim(
            seed % 2 == 0 ? attacker() : stranger(), (seed >> 1) % 2 == 0 ? hotkey : STANDBY, "claimAtVestEnd"
        );
    }

    /// `a`'s claim of `h` (the attacker's or the stranger's, `_claimRewards`), counted: past the fallback, made, and
    /// made once a claim schedule had fully vested (its amount above 0, nothing of it left; before any schedule the
    /// amount is 0).
    function _outsideClaim(address a, bytes32 h, bytes32 tag) internal {
        uint256 w = wealthOf(a);
        uint256 wa = wealthOf(attacker());
        bool vested = vaultLens.vestingAmount() != 0 && claimUnvested() == 0;
        (bool claimed, bool held) = _claimRewards(a, h);
        if (claimed || held) {
            if (a == attacker()) ++holderClaims;
            else ++strangerClaims;
        }
        if (claimed) {
            ++outsideClaimsMade;
            if (vested) ++claimsAtVestEnd;
        }
        // the one action that may raise its actor's wealth, by its share of the cut's rounding (the treasury's shares
        // are rounded down, holders over the treasury: under 2 wei in all), so within 1 rao
        _checkSelfWithin(a, w, tag, RAO);
        if (a != attacker()) _checkAttacker(wa, tag, RAO);
    }

    // ==== the stranger ====

    /// @dev The stranger gives 0.002 to 5 TAO of stake to the vault's hotkey from outside, paid from its own native
    /// TAO: a gift, booked only by an adoption, which vests.
    function gift(uint256 amount) external step {
        address a = stranger();
        amount = bound(amount, 2_000_000, 5e9);
        if (a.balance < amount * RAO) return;
        uint256 w = wealthOf(a);
        uint256 wa = wealthOf(attacker());
        vm.deal(a, a.balance - amount * RAO);
        staking.donateStake(hotkey, coldkey, amount);
        ++gifts;
        _checkSelf(a, w, "gift");
        _checkAttacker(wa, "gift", 0);
    }

    /// @dev The stranger forces 0.001 to 1 TAO of native TAO into the vault (as a self-destruct would): priced at once,
    /// the holders' gain and the stranger's loss; the attacker's allowance takes its share of it now, and so may its
    /// wealth.
    function donate(uint256 amount) external step {
        address a = stranger();
        amount = bound(amount, 1e6, 1e9) * RAO;
        if (a.balance < amount) return;
        uint256 w = wealthOf(a);
        uint256 wa = wealthOf(attacker());
        uint256 supply = vault.totalSupply();
        uint256 share = supply == 0 ? 0 : Math.mulDiv(amount, vault.balanceOf(attacker()), supply, Math.Rounding.Ceil);
        _credit(amount);
        vm.deal(a, a.balance - amount);
        vm.deal(address(vault), address(vault).balance + amount);
        ++donations;
        _checkSelf(a, w, "donate");
        _checkAttacker(wa, "donate", share + RAO);
    }

    // ==== the keeper ====

    /// @dev The keeper closes the door's batch once it is due (time passes to it), paying what the pot lacks of the fee
    /// and 0 to the fee more; the bridge delivers at once, or, while the vault is paused, files the delivery as failed.
    function closeBatch(uint256 valueSeed) external step {
        (uint64 id, uint64 start,,, uint256 nDeposits, uint256 nRedeems) = fd.openBatch();
        if (nDeposits + nRedeems == 0) return;
        uint256 due = uint256(start) + fd.batchInterval();
        if (vm.getBlockTimestamp() < due) _passTime(due - vm.getBlockTimestamp());
        uint256 w = wealthOf(address(this));
        uint256 wa = wealthOf(attacker());
        (,,, uint256 pot,,) = fd.openBatch();
        uint256 fee = bridge.fee();
        uint256 value = (pot < fee ? fee - pot : 0) + bound(valueSeed, 0, fee);
        bool late = _late();
        bool refused = vault.paused();
        CascadeMessages.Entry[] memory deposits = fd.openDeposits();
        uint256 failedBefore = bridge.failedCount();
        _readLogs();
        try fd.closeBatch{value: value}(id, 0) {
            ++closes;
            Vm.Log[] memory logs = _readLogs();
            _recordClose(fd, logs);
            bool failed = bridge.failedCount() > failedBefore;
            // the delivery is refused, and filed by the bridge, exactly while the vault is paused
            if (failed != refused) ++unexpectedReverts;
            if (failed) {
                _fileTransit(deposits);
                ++failedDeliveries;
            } else {
                _recordDelivery(logs, late);
            }
        } catch (bytes memory reason) {
            _dropLogs();
            _refused(reason, 0);
        }
        _checkSelf(address(this), w, "closeBatch");
        _checkAttacker(wa, "closeBatch", (nDeposits + nRedeems + 1) * RAO);
    }

    /// @dev The attacker (one draw in two) or the keeper retries the oldest delivery the bridge filed as failed, at the
    /// moment it picks: delivered while the vault is open, priced then; filed again, at the back, while it is paused.
    function retryDelivery(uint256 seed) external step {
        if (bridge.failedCount() == 0) return;
        address a = seed % 2 == 0 ? attacker() : address(this);
        uint256 w = wealthOf(a);
        uint256 wa = wealthOf(attacker());
        uint256 entries = _transit[_transitHead].length;
        bool late = _late();
        bool refused = vault.paused();
        _readLogs();
        vm.prank(a);
        bool ok = bridge.retryNext();
        Vm.Log[] memory logs = _readLogs();
        if (ok == refused) ++unexpectedReverts;
        if (a == attacker()) ++retriesByAttacker;
        if (ok) {
            delete _transit[_transitHead++];
            _recordDelivery(logs, late);
            ++retriesDelivered;
        } else {
            _requeueTransit();
            ++retriesFailed;
        }
        // the attacker's own retry prices the batch's other entries too, whose mints' rounding lifts every holder's
        // value, its own shares' included, by dust: allowed it as it is when another actor's retry prices them (seed
        // 9403, R6: a 1-wei rise from an honest holder's mint, on the code before R6 too)
        _checkSelfWithin(a, w, "retryDelivery", a == attacker() ? (entries + 2) * RAO : 0);
        if (a != attacker()) _checkAttacker(wa, "retryDelivery", (entries + 2) * RAO);
    }

    /// @dev The keeper sends a queued batch's next chunk once its payout delay has passed (time passes to it), with the
    /// whole fee as value (the part above the ceiling is its top-up, the rest comes back); MockBridge credits the door
    /// at once.
    function processPayouts(uint256 keySeed) external step {
        uint256 n = queuedKeys.length;
        if (n == 0) return;
        bytes32 key = queuedKeys[keySeed % n];
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        uint256 due = uint256(b.queuedAt) + vaultLens.payoutDelay();
        if (vm.getBlockTimestamp() < due) _passTime(due - vm.getBlockTimestamp());
        uint256 w = wealthOf(address(this));
        uint256 wa = wealthOf(attacker());
        uint256 fee = bridge.fee();
        uint256 held = address(this).balance;
        bytes4 expect = vault.paused()
            ? Pausable.EnforcedPause.selector
            : _chunkOutcome(_lists[key], vaultLens.getPayoutBatch(key), CHUNK_ENTRIES, fee, fee).refusal;
        uint256 booked = vaultLens.bookedStake();
        _readLogs();
        try vault.processPayouts{value: fee}(key, _lists[key], CHUNK_ENTRIES) {
            _succeeded(expect);
            _readLogs();
            ++payoutChunks;
            if (address(this).balance < held) ++topUpChunks;
            PayoutBatch memory after_ = vaultLens.getPayoutBatch(key);
            _chunkDeparted(key, b.cursor, after_.count == 0 ? _lists[key].length : after_.cursor, booked);
            if (after_.count == 0) _dropKey(key);
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, expect)) ++payoutsRefused;
        }
        _checkSelf(address(this), w, "processPayouts");
        _checkAttacker(wa, "processPayouts", (CHUNK_ENTRIES + 1) * RAO);
    }

    /// @dev The keeper stakes the vault's idle balance.
    function stakeIdle() external step {
        uint256 w = wealthOf(address(this));
        uint256 wa = wealthOf(attacker());
        _stake();
        _checkSelf(address(this), w, "stakeIdle");
        _checkAttacker(wa, "stakeIdle", RAO);
    }

    /// @dev The keeper claims the rewards at a random gap: once 0 to 30 days have passed since the last claim.
    function keeperClaim(uint256 gapSeed) external step {
        if (vm.getBlockTimestamp() < lastClaimAt() + bound(gapSeed, 0, CLAIM_GAP)) return;
        uint256 w = wealthOf(address(this));
        uint256 wa = wealthOf(attacker());
        _claimRound();
        _checkSelf(address(this), w, "keeperClaim");
        _checkAttacker(wa, "keeperClaim", RAO);
    }

    /// @dev The keeper adopts the gifts (once a day at most; at least the chain's minimum): they vest on the adoption
    /// drip (Revision 27), which the allowance credits at the shares held as it vests; the claim schedule is not
    /// touched (else `adoptionsMovedClaims`), so the pool takes no credit.
    function adopt() external step {
        uint256 w = wealthOf(address(this));
        uint256 wa = wealthOf(attacker());
        bytes4 expect = _adoptRefusal();
        bytes32 claims = _claimSchedule();
        _readLogs();
        try vault.adoptStake() {
            _succeeded(expect);
            ++adoptions;
            _readLogs();
            if (_claimSchedule() != claims) ++adoptionsMovedClaims;
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, expect)) ++adoptionsRefused;
        }
        _checkSelf(address(this), w, "adopt");
        _checkAttacker(wa, "adopt", RAO);
    }

    // ==== the owners ====

    /// @dev The owner cancels a queued batch's unsent payouts (spec §3.10.15): each unsent redeem re-minted at most the
    /// shares it burned, at the price before the cancel (the leaver gets the worse of the two); the attacker's are the
    /// only redeems here, so its wealth is checked across it as a bystander's. NothingToCancel with nothing to re-mint.
    function ownerCancel(uint256 keySeed) external step {
        uint256 n = queuedKeys.length;
        if (n == 0) return;
        bytes32 key = queuedKeys[keySeed % n];
        CascadeMessages.Payout[] memory list = _lists[key];
        uint256 cursor = vaultLens.getPayoutBatch(key).cursor;
        uint256 reMinted;
        for (uint256 i = cursor; i < list.length; ++i) {
            if (list[i].shares != 0) ++reMinted;
        }
        bytes4 expect = reMinted == 0 ? NothingToCancel.selector : bytes4(0);
        uint256 wa = wealthOf(attacker());
        _readLogs();
        vm.prank(owner);
        try vault.cancelPayoutBatch(key, list) {
            _succeeded(expect);
            _readLogs();
            ++ownerCancels;
            // the recapture pool keeps its credits: they are the sent chunks' alone, whose stake left, and this cancel
            // re-mints only the unsent entries, whose stake no walk took (the cancelled part's credit is 0)
            // no bounce here to carry, so the batch is gone
            if (vaultLens.getPayoutBatch(key).count != 0) ++unexpectedReverts;
            delete _lists[key];
            _dropKey(key);
        } catch (bytes memory reason) {
            _dropLogs();
            if (_refused(reason, expect)) ++cancelsRefused;
        }
        _checkAttacker(wa, "ownerCancel", RAO);
    }

    /// @dev The guardian pauses the vault (one draw in four), or, while it is paused, the owner unpauses it (every
    /// draw: so it is paused about a fifth of the time): meanwhile the vault refuses deposits, exits, stakes, adoptions
    /// and payouts, and a door's delivery, which the bridge files for a retry.
    function pauseVault(uint256 seed) external step {
        bool paused = vault.paused();
        if (!paused && seed % 4 != 0) return;
        uint256 wa = wealthOf(attacker());
        _readLogs();
        vm.prank(paused ? owner : guardian);
        try (paused ? vault.unpause : vault.pause)() {
            if (paused) ++unpauses;
            else ++pauses;
        } catch (bytes memory reason) {
            _dropLogs();
            _refused(reason, 0);
        }
        _checkAttacker(wa, "pauseVault", 0);
    }

    // ==== the world ====

    /// @dev Time: 1 hour to 15 days (rewards accrue; the keeper's claim comes at the vesting period's gap at most).
    function warp(uint256 secs) external step {
        _passTime(bound(secs, 1 hours, 15 days));
    }

    /// @dev The chain's removal fee (VaultModel's draw): every exit's own cost.
    function setRemoveFee(uint256 seed) external step {
        uint256 wa = wealthOf(attacker());
        staking.setRemoveFeeRao(_removeFeeDraw(seed));
        ++feeSwitches;
        _checkAttacker(wa, "setRemoveFee", 0);
    }

    // ==== wealth ====

    /// `a`'s wealth (see the contract's notes); the keeper's (this handler) is its native TAO.
    function wealthOf(address a) public view returns (uint256 w) {
        w = a.balance;
        if (a == address(this)) return w;
        w += tao.balanceOf(a) + fd.claimable(a) + fd.depositOf(a) + _inTransit(a) + _queuedOwed(a);
        w += Math.mulDiv(vault.balanceOf(a), vaultLens.totalAssets() + 1, vault.totalSupply() + 1e6);
    }

    /// `a`'s gain since `begin` (signed).
    function gainOf(address a) public view returns (int256) {
        return int256(wealthOf(a)) - int256(startWealth[a]);
    }

    /// The attacker's gain and its bound: its allowance and 1 rao an action.
    function attackerBound() public view returns (int256 gain, uint256 bound_) {
        gain = gainOf(attacker());
        bound_ = allowance + steps * RAO;
    }

    /// Every actor's gain and the keeper's, together.
    function totalGain() public view returns (int256 g) {
        for (uint256 i; i < ACTORS; ++i) {
            g += gainOf(actors[i]);
        }
        g += gainOf(address(this));
    }

    /// The stake visible on the listed hotkeys above the booked (wei): the gifts not adopted yet (nothing else makes it
    /// here: a stake, a claim and a walk each book what the position moved by).
    function unadoptedGifts() public view returns (uint256) {
        return _sub0(_visible(), vaultLens.bookedStake()) * RAO;
    }

    /// gainsAreConserved's two sides (see the contract's notes): the gains with the unadopted gifts, and the rewards
    /// claimed net of the cut less what is still unvesting, plus 1 rao an action.
    function conservation() public view returns (int256 sum, int256 bound_) {
        sum = totalGain() + int256(unadoptedGifts());
        bound_ = int256(netRewardsClaimed) - int256(vaultLens.unvestedRewards()) + int256(steps * RAO);
    }

    // ==== internal ====

    function _doorDeposit(address a, uint256 amount) internal returns (bool ok) {
        uint256 maxRao = Math.min(MAX_DEPOSIT, tao.balanceOf(a)) / RAO;
        if (maxRao < 1e18 / RAO) return false;
        amount = bound(amount, 1e18 / RAO, maxRao) * RAO;
        bool late = _late();
        vm.prank(a);
        try fd.deposit(amount) {
            ok = true;
            ++doorDeposits;
            _noteDeposit(fd, a);
            if (late && a == attacker()) ++lateEntries;
        } catch (bytes memory reason) {
            _refused(reason, 0);
        }
    }

    function _request(address a, uint256 seed, uint256 shares) internal returns (bool ok) {
        uint256 held = vault.balanceOf(a);
        uint256 asked = fd.redeemOf(a);
        if (held <= asked) return false;
        shares = seed % 4 == 0 ? held - asked : bound(shares, 1, held - asked);
        uint256 fee = asked == 0 ? fd.redeemRequestFee() : 0;
        if (a.balance < fee) return false;
        vm.prank(a);
        try fd.requestRedeem{value: fee}(shares) {
            ok = true;
            ++requests;
            _recordPotIn(fd, fee);
        } catch (bytes memory reason) {
            _refused(reason, 0);
        }
    }

    /// Actor `i`'s direct deposit of `rao` (bounded to 0.01 to 25 TAO), its wealth checked, and the attacker's when
    /// another deposits; the attacker names the door's chain again when `originSeed` is even. EnforcedPause while
    /// paused.
    function _depositDirect(uint256 i, uint256 originSeed, uint256 rao, bytes32 tag) internal returns (bool ok) {
        address a = actors[i];
        uint256 amount = bound(rao, 0.01e18 / RAO, MAX_DEPOSIT / RAO) * RAO;
        if (a.balance < amount) return false;
        uint256 w = wealthOf(a);
        uint256 wa = wealthOf(attacker());
        bool late = _late();
        bytes4 expect = vault.paused() ? Pausable.EnforcedPause.selector : bytes4(0);
        _readLogs();
        vm.prank(a);
        try vault.depositDirect{value: amount}() {
            _succeeded(expect);
            ok = true;
            ++directDeposits;
            if (a == attacker()) {
                if (late) ++lateEntries;
                if (originSeed % 2 == 0) {
                    vm.prank(a);
                    vault.setRedeemOrigin(doorChain);
                }
            }
        } catch (bytes memory reason) {
            _dropLogs();
            _refused(reason, expect);
        }
        _checkSelf(a, w, tag);
        if (a != attacker()) _checkAttacker(wa, tag, RAO);
    }

    /// The keeper's stake of the idle balance, its refusal predicted (the re-review's M-8): EnforcedPause while paused,
    /// else NothingToStake when what it would stake (the balance above ED and the queued payouts, less the idle
    /// buffer, in rao) is under the chain's minimum stake.
    function _stake() internal {
        bytes4 expect = _stakeRefusal();
        _readLogs();
        try vault.stakeIdle() {
            _succeeded(expect);
            ++stakes;
        } catch (bytes memory reason) {
            _dropLogs();
            _refused(reason, expect);
        }
    }

    /// stakeIdle's refusal now, for the keeper: EnforcedPause; NothingToStake (CascadeVault's stakeIdle and
    /// _idleBuffer, restated: idleBufferBps of the booked stake, at least minDailyOutflow, when the bps are set).
    function _stakeRefusal() internal view returns (bytes4) {
        if (vault.paused()) return Pausable.EnforcedPause.selector;
        uint256 bps = vaultLens.idleBufferBps();
        uint256 buffer =
            bps == 0 ? 0 : Math.max(vaultLens.bookedStake() * bps * (RAO / 10_000), vaultLens.minDailyOutflow());
        uint256 rao = _sub0(_availableAt(vaultLens.pendingPayouts()), buffer) / RAO;
        uint256 minStake = Math.max(staking.getDefaultMinStake(), MIN_STAKE_FALLBACK_RAO);
        return rao < minStake ? NothingToStake.selector : bytes4(0);
    }

    /// redeemDirect's refusal for `shares` now: EnforcedPause; then the walk's (_exitPlan: ZeroAmount, UnstakeShort).
    function _directRefusal(uint256 shares) internal view returns (bytes4) {
        if (vault.paused()) return Pausable.EnforcedPause.selector;
        uint256 out = CascadeMath.assetsForRedeem(shares, vaultLens.totalAssets(), vault.totalSupply());
        out -= out % RAO;
        return _exitPlan(_availableAt(vaultLens.pendingPayouts()), out).refusal;
    }

    /// adoptStake's refusal now, for the keeper: EnforcedPause; AdoptTooSoon inside STAKE_RAMP of the last adoption;
    /// BelowMinAdoption for a surplus (the visible above the booked stake) below the chain's minimum.
    function _adoptRefusal() internal view returns (bytes4) {
        if (vault.paused()) return Pausable.EnforcedPause.selector;
        if (vm.getBlockTimestamp() < uint256(vaultLens.lastAdoptAt()) + STAKE_RAMP) return AdoptTooSoon.selector;
        uint256 minStake = Math.max(staking.getDefaultMinStake(), MIN_STAKE_FALLBACK_RAO);
        if (_sub0(_visible(), vaultLens.bookedStake()) < minStake) return BelowMinAdoption.selector;
        return 0;
    }

    /// The keeper's round: every listed hotkey claimed, in one block (the precondition's form since R6b U1). Whether
    /// it claimed.
    function _claimRound() internal returns (bool claimed) {
        (claimed,) = _claimRewards(address(this), hotkey);
        (bool second,) = _claimRewards(address(this), STANDBY);
        claimed = claimed || second;
    }

    /// One claim of hotkey `h`'s rewards by `caller`: the keeper's at any time; a holder's or the stranger's once the
    /// fallback has passed since `h`'s last claim and the claim schedule holds nothing still vesting (R6b U1: `held`
    /// when that alone refused it), else NotKeeper as predicted. Its net (the increase less the cut) is what the vault
    /// vests.
    function _claimRewards(address caller, bytes32 h) internal returns (bool claimed, bool held) {
        bool notKeeper = caller != address(this);
        bool beforeFallback = vm.getBlockTimestamp() < vaultLens.lastClaimAt(h) + KEEPER_FALLBACK;
        bool early = notKeeper && (beforeFallback || claimUnvested() != 0);
        held = notKeeper && !beforeFallback && claimUnvested() != 0;
        _readLogs();
        vm.prank(caller);
        try vault.claimRewards{gas: 60_000_000}(h) {
            if (early) ++unexpectedReverts;
            held = false;
            claimed = true;
            Vm.Log[] memory logs = _readLogs();
            uint256 delta;
            uint256 cut;
            for (uint256 i; i < logs.length; ++i) {
                if (_isVaultLog(logs[i], RewardsClaimed.selector)) {
                    delta = abi.decode(logs[i].data, (uint256)) * RAO;
                } else if (_isVaultLog(logs[i], RewardCutMinted.selector)) {
                    (cut,) = abi.decode(logs[i].data, (uint256, uint256));
                    ++cutsMinted;
                }
            }
            netRewardsClaimed += delta - cut;
            uint256 last = h == hotkey ? stakeHotkeyClaimAt : standbyClaimAt;
            if (vm.getBlockTimestamp() > last + CLAIM_GAP && !(h == STANDBY && _standbyIdle())) ++claimGapOverruns;
            if (h == hotkey) {
                unclaimedRao = 0;
                stakeHotkeyClaimAt = vm.getBlockTimestamp();
                if (_standbyIdle()) standbyClaimAt = vm.getBlockTimestamp();
            } else {
                standbyUnclaimedRao = 0;
                standbyClaimAt = vm.getBlockTimestamp();
            }
            ++rewardClaims;
        } catch (bytes memory reason) {
            _dropLogs();
            if (!(early && _selector(reason) == NotKeeper.selector)) {
                _refused(reason, 0);
                held = false;
            } else if (held) {
                ++claimsHeldWhileVesting;
            }
        }
    }

    /// @dev The owner moves up to a tenth of the stake hotkey's position onto the standby (its scheduled moveStake,
    /// modelled through the mock as the vault's own move: the booked and the visible stake unchanged, so nothing is
    /// priced), while the standby holds less than a quarter of the listed stake: the standby's rewards then accrue,
    /// unevenly, beside the stake hotkey's. The move lowers the vault's accrual rate by the rate the moved stake gives
    /// up (APR_PERCENT less STANDBY_APR_PERCENT), while what is still to vest and still unclaimed was earned at the old
    /// rate: the schedule then vests above the accrual, as after a departure, by at most that rate x the moved stake x
    /// the vesting period, net of the cut (the departure credit's argument), so the pool takes that credit
    /// (`movedCredit`; R7, seed 9402: without it the release above the accrual after a move mid-schedule went
    /// unfunded, and an attacker holding through it gained beyond its bound, on the R6 campaign's actions alone).
    function moveToStandby(uint256 seed) external step {
        uint256 here = staking.getStake(hotkey, coldkey, 0);
        uint256 there = staking.getStake(STANDBY, coldkey, 0);
        if (there * 4 >= here + there) return;
        uint256 rao = bound(seed, 0, here / 10);
        if (rao < MIN_STAKE_FALLBACK_RAO) return;
        uint256 w = wealthOf(address(this));
        uint256 wa = wealthOf(attacker());
        // an idle standby has nothing to claim: its claim record starts with its stake
        if (_standbyIdle()) standbyClaimAt = vm.getBlockTimestamp();
        vm.prank(address(vault));
        staking.moveStake(hotkey, STANDBY, 0, 0, rao);
        ++standbyMoves;
        uint256 period = Math.max(vaultLens.rewardVesting(), CLAIM_GAP);
        movedCredit += _addCredit(
            Math.mulDiv(
                rao * RAO,
                (APR_PERCENT - STANDBY_APR_PERCENT) * (10_000 - vaultLens.rewardCutBps()) * period,
                100 * 10_000 * 365 days,
                Math.Rounding.Ceil
            )
        );
        _checkSelf(address(this), w, "moveToStandby");
        _checkAttacker(wa, "moveToStandby", 0);
    }

    /// What is still vesting of the claimed rewards (the claim schedule) and of the adopted gifts (the adoption drip),
    /// apart (Revision 27), by the vault's one-drip formula over the lens's fields; the vault's unvestedRewards() is
    /// their sum.
    function claimUnvested() public view returns (uint256) {
        return
            CascadeFormulas.unvestedRewards(
                vaultLens.vestingAmount(), vaultLens.vestingStart(), vaultLens.vestingPeriod()
            );
    }

    function dripUnvested() public view returns (uint256) {
        return CascadeFormulas.unvestedRewards(
            vaultLens.adoptVestingAmount(), vaultLens.adoptVestingStart(), vaultLens.adoptVestingPeriod()
        );
    }

    /// The claim schedule's three fields as one word.
    function _claimSchedule() internal view returns (bytes32) {
        return keccak256(abi.encode(vaultLens.vestingAmount(), vaultLens.vestingStart(), vaultLens.vestingPeriod()));
    }

    /// Moves time `secs` forward: rewards accrue on the vault's stake (the attacker's allowance takes its share, and
    /// its share of the gifts the warp vests, and of the vest above the accrual as far as the pool funds it), and the
    /// keeper claims whenever the last claim is CLAIM_GAP old, so no two claims are further apart. Time also stops at
    /// the oldest credit's expiry, so no credit funds a warp that ends past it.
    function _passTime(uint256 secs) internal {
        _passTimeTo(vm.getBlockTimestamp() + secs, true);
    }

    /// The same to `end`; with `roundAtEnd` false, a keeper's round due at `end` itself is left for the next step
    /// (`claimAtVestEnd` claims first at that moment), and any due before it is made.
    function _passTimeTo(uint256 end, bool roundAtEnd) internal {
        while (vm.getBlockTimestamp() < end) {
            _expireCredits();
            uint256 due = lastClaimAt() + CLAIM_GAP;
            uint256 to = Math.min(end, due);
            if (_creditHead < _creditAt.length) to = Math.min(to, _creditAt[_creditHead] + CREDIT_LIFE);
            uint256 dt = to - vm.getBlockTimestamp();
            uint256 accruedNet = _accrue(dt);
            uint256 rewards = claimUnvested();
            uint256 gifted = dripUnvested();
            _warp(dt, vaultBlockTime);
            // what the warp vested: the adoption drip's (gifts) credited at the shares held now, and the claim
            // schedule's (rewards) above what the warp accrued recaptured as far as the stake that left funded it
            _credit(gifted - dripUnvested());
            _recapture(rewards - claimUnvested(), accruedNet);
            if (vm.getBlockTimestamp() >= due && (roundAtEnd || vm.getBlockTimestamp() < end)) {
                if (_claimRound()) ++forcedClaims;
            }
        }
        _expireCredits();
    }

    /// `dt` seconds of root rewards on the vault's stake hotkey, at APR_PERCENT, and on the standby, at
    /// STANDBY_APR_PERCENT; the attacker's allowance takes its share of them net of the cut, at the shares it holds now.
    /// Returns the net accrued.
    function _accrue(uint256 dt) internal returns (uint256 net) {
        uint256 accrued = staking.getStake(hotkey, coldkey, 0) * APR_PERCENT * dt / (100 * 365 days);
        uint256 standby = staking.getStake(STANDBY, coldkey, 0) * STANDBY_APR_PERCENT * dt / (100 * 365 days);
        if (standby != 0) {
            standbyUnclaimedRao += standby;
            staking.setUnclaimed(coldkey, STANDBY, standbyUnclaimedRao);
        }
        if (accrued != 0) {
            unclaimedRao += accrued;
            staking.setUnclaimed(coldkey, hotkey, unclaimedRao);
        }
        accrued += standby;
        if (accrued == 0) return 0;
        uint256 gross = accrued * RAO;
        net = gross - gross * vaultLens.rewardCutBps() / 10_000;
        _credit(net);
    }

    /// The vest above the accrual rate (Task 42's fix round 3, ruling (C); its pool rebuilt in fix round 4): of
    /// `vestedRewards` (a warp's release of rewards, its gifts' part taken out), what is above `accruedNet` (that warp's
    /// accrual, net of the cut) is funded by the pool as far as it holds, its credits spent oldest first; the
    /// attacker's share of the funded part enters its allowance (`recaptured`), the pool spends it all (every holder's
    /// share), and the unfunded rest is logged, credited to no one.
    function _recapture(uint256 vestedRewards, uint256 accruedNet) internal {
        uint256 extra = _sub0(vestedRewards, accruedNet);
        if (extra == 0) return;
        uint256 funded = Math.min(extra, recapturePool);
        recapturePool -= funded;
        unfundedVest += extra - funded;
        // the pool is the credits left from the head on, so this spends within them
        uint256 spend = funded;
        for (uint256 i = _creditHead; spend != 0; ++i) {
            uint256 take = Math.min(spend, _creditLeft[i]);
            _creditLeft[i] -= take;
            spend -= take;
        }
        uint256 before = allowance;
        _credit(funded);
        recaptured += allowance - before;
    }

    /// A departure of the attacker's stake (Task 42's fix round 4, the review's I-1): the booked stake its exit's walk
    /// took (`bookedBefore` less the booked stake now, rao), at the attacker's part of what the exit paid (`mine` of
    /// `paid`), credits the pool the net reward rate x that stake x the vesting period, rounded up (see the contract's
    /// notes), for CREDIT_LIFE from now. An exit paid from the liquid balance alone took no stake and credits nothing.
    function _departed(uint256 bookedBefore, uint256 mine, uint256 paid) internal {
        uint256 took = _sub0(bookedBefore, vaultLens.bookedStake());
        if (took == 0 || mine == 0) return;
        uint256 period = Math.max(vaultLens.rewardVesting(), CLAIM_GAP);
        uint256 credit = Math.mulDiv(
            took * RAO * mine,
            APR_PERCENT * (10_000 - vaultLens.rewardCutBps()) * period,
            paid * 100 * 10_000 * 365 days,
            Math.Rounding.Ceil
        );
        departedCredit += _addCredit(credit);
    }

    /// A credit to the pool, made now, for CREDIT_LIFE, capped (fix round 4's review, M-1) so the pool never holds more
    /// than the rewards still to vest (`rewardsStillToVest`: each live credit's need is a disjoint part of them, the
    /// backlog its stake left); what the cap cuts is `cappedCredit`. Returns what it added.
    function _addCredit(uint256 credit) internal returns (uint256 added) {
        added = Math.min(credit, _sub0(rewardsStillToVest(), recapturePool));
        cappedCredit += credit - added;
        if (added == 0) return 0;
        _creditAt.push(vm.getBlockTimestamp());
        _creditLeft.push(added);
        recapturePool += added;
    }

    /// The rewards still to vest (wei): the claim schedule's unvested (the adoption drip's gifts are not rewards) and
    /// the unclaimed rewards net of the cut. Every excess the pool can fund comes out of them.
    function rewardsStillToVest() public view returns (uint256) {
        uint256 c = (unclaimedRao + standbyUnclaimedRao) * RAO;
        return claimUnvested() + c - c * vaultLens.rewardCutBps() / 10_000;
    }

    /// A payout chunk of batch `key` sent its entries [from, to): a departure, at the attacker's part of their value
    /// (all of it here: no bounce reaches this world, so every entry is the attacker's redeem).
    function _chunkDeparted(bytes32 key, uint256 from, uint256 to, uint256 bookedBefore) internal {
        CascadeMessages.Payout[] storage list = _lists[key];
        uint256 paid;
        uint256 mine;
        for (uint256 i = from; i < to; ++i) {
            paid += list[i].assets;
            if (list[i].user == attacker()) mine += list[i].assets;
        }
        if (paid != 0) _departed(bookedBefore, mine, paid);
    }

    /// The credits CREDIT_LIFE old (what is left of them leaves the pool, `expiredCredit`) and the spent ones, from
    /// the oldest on.
    function _expireCredits() internal {
        uint256 n = _creditAt.length;
        while (
            _creditHead < n
                && (_creditLeft[_creditHead] == 0 || _creditAt[_creditHead] + CREDIT_LIFE <= vm.getBlockTimestamp())
        ) {
            uint256 left = _creditLeft[_creditHead];
            recapturePool -= left;
            expiredCredit += left;
            ++_creditHead;
        }
    }

    /// The attacker's share of `amount` entering the holders' value now: its shares over the supply, rounded up.
    function _credit(uint256 amount) internal {
        uint256 supply = vault.totalSupply();
        uint256 s = vault.balanceOf(attacker());
        if (amount == 0 || supply == 0 || s == 0) return;
        allowance += Math.mulDiv(amount, s, supply, Math.Rounding.Ceil);
    }

    /// The delivery a close (or a retry) made: its payout list (from the Redeemed and DepositBounced events) and its
    /// burns.
    function _recordDelivery(Vm.Log[] memory logs, bool late) internal {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory log = logs[i];
            if (_isVaultLog(log, DepositBounced.selector)) {
                (uint256 assets,) = abi.decode(log.data, (uint256, uint8));
                _lists[log.topics[1]].push(CascadeMessages.Payout(_topicAddress(log.topics[2]), 0, assets));
            } else if (_isVaultLog(log, Redeemed.selector)) {
                (uint256 shares, uint256 assets) = abi.decode(log.data, (uint256, uint256));
                _lists[log.topics[1]].push(CascadeMessages.Payout(_topicAddress(log.topics[2]), shares, assets));
                ++burns;
                if (vaultLens.unvestedRewards() != 0) ++exitsWhileVesting;
            } else if (_isVaultLog(log, PayoutBatchQueued.selector)) {
                queuedKeys.push(log.topics[1]);
            } else if (_isVaultLog(log, RedeemDeferred.selector)) {
                ++deferrals;
            } else if (late && _isVaultLog(log, Deposited.selector) && _topicAddress(log.topics[2]) == attacker()) {
                ++lateEntries;
            }
        }
    }

    /// A closed batch's deposits, its delivery filed as failed: at the back of the bridge's queue.
    function _fileTransit(CascadeMessages.Entry[] memory deposits) internal {
        CascadeMessages.Entry[] storage t = _transit[_transitTail++];
        for (uint256 i; i < deposits.length; ++i) {
            t.push(deposits[i]);
        }
    }

    /// The oldest failed delivery failed again: the bridge files it at the back, and so does the record.
    function _requeueTransit() internal {
        CascadeMessages.Entry[] storage from = _transit[_transitHead];
        CascadeMessages.Entry[] storage to = _transit[_transitTail++];
        for (uint256 i; i < from.length; ++i) {
            to.push(from[i]);
        }
        delete _transit[_transitHead++];
    }

    /// `a`'s deposits in closed batches whose delivery failed, at face.
    function _inTransit(address a) internal view returns (uint256 owed) {
        for (uint256 k = _transitHead; k < _transitTail; ++k) {
            CascadeMessages.Entry[] storage t = _transit[k];
            for (uint256 i; i < t.length; ++i) {
                if (t[i].user == a) owed += t[i].amount;
            }
        }
    }

    /// Whether this moment is in the last third of the claim gap (a late entry's window).
    function _late() internal view returns (bool) {
        return vm.getBlockTimestamp() + CLAIM_GAP / 3 >= lastClaimAt() + CLAIM_GAP;
    }

    /// `a`'s queued payout entries at the value they were burned for, from each batch's cursor on.
    function _queuedOwed(address a) internal view returns (uint256 owed) {
        for (uint256 k; k < queuedKeys.length; ++k) {
            bytes32 key = queuedKeys[k];
            CascadeMessages.Payout[] storage list = _lists[key];
            uint256 cursor = vaultLens.getPayoutBatch(key).cursor;
            for (uint256 i = cursor; i < list.length; ++i) {
                if (list[i].user == a) owed += list[i].assets;
            }
        }
    }

    function _dropKey(bytes32 key) internal {
        uint256 n = queuedKeys.length;
        for (uint256 k; k < n; ++k) {
            if (queuedKeys[k] != key) continue;
            queuedKeys[k] = queuedKeys[n - 1];
            queuedKeys.pop();
            return;
        }
    }

    /// noActorGainsByActing: `a`'s wealth after its action, against `before`.
    function _checkSelf(address a, uint256 before, bytes32 tag) internal {
        _checkSelfWithin(a, before, tag, 0);
    }

    /// The same, allowing a rise of at most `dust` (a holder's own reward claim: see holderClaim). Also records the
    /// attacker's closest approach to its bound and gainsAreConserved's (reach, not assertions).
    function _checkSelfWithin(address a, uint256 before, bytes32 tag, uint256 dust) internal {
        uint256 w = wealthOf(a);
        if (w > before + dust) {
            ++selfGains;
            lastSelfGainer = a;
            lastSelfGainAction = tag;
            lastSelfGainWei = w - before;
        }
        (int256 gain, uint256 bound_) = attackerBound();
        if (gain > 0 && int256(bound_) >= gain) {
            closestMargin = Math.min(closestMargin, uint256(int256(bound_) - gain));
        }
        (int256 sum, int256 cBound) = conservation();
        if (cBound >= sum) closestConservationMargin = Math.min(closestConservationMargin, uint256(cBound - sum));
    }

    /// noActorGainsByActing's second half: across an action the attacker did not make, its wealth against `before`,
    /// allowed `dust` (the action's rounding: 1 rao an entry it prices and 1 more; a donation's share).
    function _checkAttacker(uint256 before, bytes32 tag, uint256 dust) internal {
        uint256 w = wealthOf(attacker());
        if (w > before + dust) {
            ++attackerGains;
            lastAttackerGainAction = tag;
            lastAttackerGainWei = w - before;
        }
    }
}
