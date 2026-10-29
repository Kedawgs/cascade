// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeStaker} from "../../src/CascadeStaker.sol";
import {ISTAKING_ADDRESS} from "../../src/interfaces/IStaking.sol";
import {CascadeMath} from "../../src/libraries/CascadeMath.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {MockBridge} from "../mocks/MockBridge.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {MockSwapRouter} from "../mocks/MockSwapRouter.sol";
import {MockSwapper} from "../mocks/MockSwapper.sol";
import {MockTAO} from "../mocks/MockTAO.sol";
import {MockTwap} from "../mocks/MockTwap.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @notice Bounded user, keeper and owner actions for the Cascade invariant suite, over three actors.
/// Each actor holds 10_000 bridged TAO on Base, and 10_000 native TAO plus 10 ether of fee money as one
/// native balance (both chains share one EVM here). Every action wraps its call in try/catch and
/// updates the ghosts only when it succeeds. The handler is the vault's keeper and the front door's,
/// pays every close's bridge fee, and acts as the owner (by prank) to cancel queued payouts, set the
/// reward cut and swap the front door's swapper. No donations; rarely, a simulated loss takes TAO out of
/// the vault (see simulateLoss), which can make it insolvent.
contract Handler is CommonBase, StdCheats, StdUtils {
    /// The v3 fixture: the front door's USDC, its swapper (the staker, selling through `router`), the
    /// TWAP it floors deliveries on, a swapper that pays short, and the vault's treasury.
    struct V3 {
        MockUSDC usdc;
        CascadeStaker staker;
        MockSwapRouter router;
        MockTwap twap;
        MockSwapper shortPayer;
        address treasury;
    }

    /// A delivery preference the handler left for an actor: USDC units per 1e18 TAO, and its deadline.
    struct Preference {
        uint128 floor;
        uint64 deadline;
    }

    uint256 internal constant RAO = 1e9;
    uint256 internal constant ED = 1e12;
    uint256 internal constant MAX_DEPOSIT = 100e18;
    /// Native balance an actor keeps back from direct deposits, for redeem-request fees.
    uint256 internal constant FEE_MONEY = 10 ether;
    uint256 internal constant MIN_STAKE_RAO = 2_000_000;
    /// The most entries one processPayouts call asks for (it asks for 1 to CHUNK_ENTRIES); with the
    /// vault's minChunk at 1, a 2- or 3-entry batch can go out in several chunks.
    uint32 internal constant CHUNK_ENTRIES = 3;
    /// simulateLoss acts on at most this many calls per run.
    uint256 internal constant MAX_LOSSES = 2;
    /// The front door's default discount to the TWAP's value, which the fixture keeps.
    uint256 internal constant SLIPPAGE_BPS = 150;
    uint32 internal constant DESTINATION_BASE = 6;

    CascadeVault public immutable vault;
    CascadeFrontDoor public immutable fd;
    MockTAO public immutable tao;
    MockBridge public immutable bridge;
    MockStaking public constant staking = MockStaking(ISTAKING_ADDRESS);
    address public immutable owner;
    bytes32 public immutable hotkey;
    /// The front door's peer id at the vault.
    bytes32 public immutable peer;
    MockUSDC public immutable usdc;
    CascadeStaker public immutable staker;
    MockSwapRouter public immutable router;
    MockTwap public immutable twap;
    MockSwapper public immutable shortPayer;
    address public immutable treasury;

    address[3] public actors;
    mapping(address => Preference) public preferences;

    // ---- ghosts ----

    /// Native TAO delivered into the vault: every delivered batch's amount and every direct deposit.
    uint256 public ghostIn;
    /// Native TAO sent out of the vault: net + fee of every payout chunk and every direct redeem paid.
    uint256 public ghostOut;
    /// Claimed root rewards, in wei.
    uint256 public ghostRewards;
    /// Net of every payout chunk the vault sent to the front door.
    uint256 public ghostPayoutsReceived;
    /// Bridged TAO actors received from `claim`.
    uint256 public ghostClaimed;
    /// Bridged TAO credits the front door sold for USDC in successful deliveries.
    uint256 public ghostDelivered;
    /// Native TAO taken out of the vault by simulateLoss.
    uint256 public ghostLoss;
    /// Highest price seen; a cancel resets it to the post-cancel price, at most the cancelled batch's
    /// delivery price.
    uint256 public priceFloor;
    /// Deliveries that left a front door's burn window above its daily allowance.
    uint256 public burnViolations;
    /// Cancels that left the price below min(priceFloor, delivery price) by a rao or more per
    /// re-minted entry.
    uint256 public cancelDustViolations;
    /// Calls (and bridge deliveries) that failed although the handler checked their precondition.
    uint256 public unexpectedReverts;
    /// Keys of the batches with payouts left, and per key the delivery price and the full payout list.
    bytes32[] public queuedKeys;
    mapping(bytes32 => uint256) public deliveryPrice;
    mapping(bytes32 => CascadeMessages.Payout[]) internal lists;
    /// The share price right before and right after each successful reward claim, cut or not, and
    /// right after it as if one more share had been minted.
    uint256[] public claimPriceBefore;
    uint256[] public claimPriceAfter;
    uint256[] public claimPriceOneMoreShare;
    /// Each successful USDC delivery's floor, as the handler computed it (the user's floor rounded up,
    /// the keeper's, the TWAP's value less SLIPPAGE_BPS), and what the actor's USDC balance rose by.
    uint256[] public deliveryFloor;
    uint256[] public deliveryReceived;
    /// Successful deliveries after their preference's deadline.
    uint256 public lateDeliveries;

    // ---- reachability counters (successful calls) ----

    uint256 public deposits;
    uint256 public redeemRequests;
    uint256 public depositCancels;
    uint256 public redeemCancels;
    uint256 public closes;
    uint256 public deliveries;
    uint256 public payoutChunks;
    /// Chunks that left entries in their batch.
    uint256 public partialChunks;
    uint256 public claims;
    uint256 public directDeposits;
    uint256 public directRedeems;
    uint256 public stakes;
    uint256 public rewardClaims;
    uint256 public cancels;
    /// Cancels of a batch that had already sent a chunk.
    uint256 public cancelsAfterPartial;
    /// RedeemDeferred and RedeemSkipped events seen in deliveries.
    uint256 public redeemDeferred;
    uint256 public redeemSkipped;
    /// DepositBounced events seen in deliveries (reached only after a simulated loss).
    uint256 public depositBounces;
    /// Bounced entries sent in payout chunks, and bounced entries a cancel released into the vault.
    uint256 public bouncesPaid;
    uint256 public bouncesCancelled;
    /// simulateLoss calls that took TAO out of the vault.
    uint256 public losses;
    /// High-water mark of queuedKeys.length.
    uint256 public maxQueueDepth;
    /// Exits refused UnstakeShort because the only stake sat below the minimum stake, which the
    /// vault's unstake walk skips.
    uint256 public dustBlocked;
    /// Claims that minted a cut: in all, while an earlier claim was still vesting, and while payouts
    /// were pending; claims whose cut was skipped (below half the launch price).
    uint256 public cutsMinted;
    uint256 public cutsWhileVesting;
    uint256 public cutsWithPending;
    uint256 public cutsSkipped;
    /// Successful USDC deliveries: in all, while other actors held credits and while the open batch held
    /// deposits (TAO the front door holds but must not sell), and paying exactly the floor; then the
    /// deliveries refused as the handler expected (expired, the market below the floor, or a swapper
    /// paying short).
    uint256 public usdcDeliveries;
    uint256 public deliveriesBesideOtherCredits;
    uint256 public deliveriesBesideOpenDeposits;
    uint256 public deliveriesAtFloor;
    uint256 public deliveriesRefused;

    constructor(
        CascadeVault vault_,
        CascadeFrontDoor fd_,
        MockTAO tao_,
        MockBridge bridge_,
        address owner_,
        bytes32 hotkey_,
        uint64 chain,
        V3 memory v3
    ) {
        vault = vault_;
        fd = fd_;
        tao = tao_;
        bridge = bridge_;
        owner = owner_;
        hotkey = hotkey_;
        peer = vault_.peerId(chain, address(fd_));
        usdc = v3.usdc;
        staker = v3.staker;
        router = v3.router;
        twap = v3.twap;
        shortPayer = v3.shortPayer;
        treasury = v3.treasury;

        actors = [makeAddr("alice"), makeAddr("bob"), makeAddr("carol")];
        for (uint256 i; i < actors.length; ++i) {
            tao_.mint(actors[i], 10_000e18);
            vm.prank(actors[i]);
            tao_.approve(address(fd_), type(uint256).max);
            vm.deal(actors[i], 10_000e18 + FEE_MONEY);
        }
        priceFloor = vault_.price();
    }

    /// @dev Takes the unused part of each close's budget back from the front door.
    receive() external payable {}

    // ---- front door: users ----

    function deposit(uint256 actorSeed, uint256 amount) external {
        address actor = actors[actorSeed % actors.length];
        uint256 maxRao = Math.min(MAX_DEPOSIT, tao.balanceOf(actor)) / RAO;
        if (maxRao < 1e18 / RAO) return;
        amount = bound(amount, 1e18 / RAO, maxRao) * RAO;
        // rao-aligned, within the actor's balance and allowance: only a cap or a full list may refuse it
        (,, uint256 open,, uint256 nDeposits,) = fd.openBatch();
        bool ready = amount >= fd.minDeposit() && fd.netForwarded() + open + amount <= fd.depositCap()
            && open + amount <= fd.maxBatchValue() && (fd.depositOf(actor) != 0 || nDeposits < fd.maxDeposits());
        vm.prank(actor);
        try fd.deposit(amount) {
            ++deposits;
            _raiseFloor();
        } catch {
            if (ready) ++unexpectedReverts;
        }
    }

    /// @dev Prefers a holder without a request in the open batch, so batches carry several entries (and
    /// pay out in several chunks); adds to an existing request once every holder has one. Pays the
    /// redeem-request fee by value on the actor's first request in the open batch.
    function requestRedeem(uint256 actorSeed, uint256 shares) external {
        (address actor, uint256 balance) = _actorWith(actorSeed, _sharesNotRequested);
        if (balance == 0) (actor, balance) = _actorWith(actorSeed, _shares);
        if (balance == 0) return;
        shares = bound(shares, 1, balance);
        bool hasEntry = fd.redeemOf(actor) != 0;
        uint256 fee = hasEntry ? 0 : fd.redeemRequestFee();
        (,,,,, uint256 nRedeems) = fd.openBatch();
        bool ready = actor.balance >= fee && (hasEntry || nRedeems < fd.maxRedeems());
        vm.prank(actor);
        try fd.requestRedeem{value: fee}(shares) {
            ++redeemRequests;
            _raiseFloor();
        } catch {
            if (ready) ++unexpectedReverts;
        }
    }

    function cancelDeposit(uint256 actorSeed, uint256 amount) external {
        (address actor, uint256 open) = _actorWith(actorSeed, _openDeposit);
        if (open == 0) return;
        // rao-aligned and at most the entry
        amount = bound(amount, 1, open / RAO) * RAO;
        // a partial cancel must leave at least minDeposit, so a smaller remainder cancels in full
        uint256 left = open - amount;
        if (left != 0 && left < fd.minDeposit()) amount = open;
        vm.prank(actor);
        try fd.cancelDeposit(amount) {
            ++depositCancels;
            _raiseFloor();
        } catch {
            ++unexpectedReverts;
        }
    }

    function cancelRedeem(uint256 actorSeed, uint256 shares) external {
        (address actor, uint256 open) = _actorWith(actorSeed, _openRedeem);
        if (open == 0) return;
        // at most the entry
        shares = bound(shares, 1, open);
        vm.prank(actor);
        try fd.cancelRedeem(shares) {
            ++redeemCancels;
            _raiseFloor();
        } catch {
            ++unexpectedReverts;
        }
    }

    /// @dev A claim also clears the actor's delivery preference.
    function claim(uint256 actorSeed) external {
        (address actor, uint256 owed) = _actorWith(actorSeed, _claimable);
        if (owed == 0) return;
        uint256 before = tao.balanceOf(actor);
        vm.prank(actor);
        try fd.claim() {
            ghostClaimed += tao.balanceOf(actor) - before;
            delete preferences[actor];
            ++claims;
            _raiseFloor();
        } catch {
            ++unexpectedReverts;
        }
    }

    // ---- front door: keeper ----

    /// @dev Warps 12 hours, so the open batch is due, and pays the bridge fee on top of the pot. The
    /// bridge delivers inside the close: the delivery's events give its amount, its payout list (from
    /// the DepositBounced and Redeemed events) and its delivery price.
    function closeBatch() external {
        vm.warp(block.timestamp + 12 hours);
        (,,,, uint256 nDeposits, uint256 nRedeems) = fd.openBatch();
        if (nDeposits + nRedeems == 0) return;
        bool ready = fd.canClose();
        uint256 fee = bridge.fee();
        vm.recordLogs();
        try fd.closeBatch{value: fee}() {
            ++closes;
            _recordDelivery(vm.getRecordedLogs());
            _raiseFloor();
        } catch {
            if (ready) ++unexpectedReverts;
        }
    }

    /// @dev Sells an actor's whole credit for USDC as the front door's keeper. The actor first leaves a
    /// preference (200 to 260 USDC per TAO, for 1 hour to 7 days) if it has none, or replaces an expired
    /// one on an even `floorSeed`; on an odd one the expired preference stays, and the delivery must be
    /// refused. The market is drawn per call: the TWAP at 240 to 260 USDC per TAO and, by `marketSeed`
    /// mod 4, the staker selling through an honest router (0, 1) or a lying one that pays its rate
    /// whatever the minimum (2), both at 225 to 275, or (3) the front door's swapper swapped for one
    /// that pays the front door's minimum less 0 to 100 bps, restored afterwards. The keeper's floor is
    /// 0, the staker's expected output, or one unit more. As the keeper does, when no actor holds a credit
    /// it first sends a queued batch's next payout chunk (as processPayouts does), then delivers what that
    /// credited. It runs from whatever state the run reached: other actors' credits and open deposits
    /// in the front door (TAO it must not sell), a credit grown over several chunks, more payouts still
    /// queued at the vault.
    function deliver(uint256 actorSeed, uint256 floorSeed, uint256 marketSeed, uint256 keeperSeed) external {
        (address actor, uint256 owed) = _actorWith(actorSeed, _claimable);
        if (owed == 0) {
            _processPayouts(actorSeed);
            (actor, owed) = _actorWith(actorSeed, _claimable);
            if (owed == 0) return;
        }
        Preference memory p = _prefer(actor, floorSeed);
        if (p.floor == 0) return;
        twap.setPrice(bound(keeperSeed >> 8, 240e6, 260e6));
        (bool viaShortPayer, uint256 expected, bool paysInFull) = _drawMarket(owed, marketSeed);
        uint256 keeperMinOut = keeperSeed % 3 == 0 ? 0 : expected + keeperSeed % 3 - 1;
        uint256 floor = _deliveryFloor(owed, p.floor, keeperMinOut);
        // test-controlled time
        // forge-lint: disable-next-line(block-timestamp)
        bool live = block.timestamp <= p.deadline;
        _deliver(actor, owed, keeperMinOut, floor, live, live && (viaShortPayer ? paysInFull : expected >= floor));
        if (viaShortPayer) {
            vm.prank(owner);
            fd.setSwapper(address(staker));
        }
    }

    // ---- vault: keeper and permissionless ----

    /// @dev Warps 24 hours past the payout delay of a queued batch (preferring one with 2 or more entries
    /// left, which can go out in several chunks) and sends its next chunk of 1 to CHUNK_ENTRIES entries
    /// (from the seed) from the stored list.
    function processPayouts(uint256 keySeed) external {
        _processPayouts(keySeed);
    }

    function _processPayouts(uint256 keySeed) internal {
        uint256 n = queuedKeys.length;
        if (n == 0) return;
        bytes32 key = _keyWith(keySeed, _entriesLeft, 2);
        // casting to 'uint32' is safe because the value is at most CHUNK_ENTRIES
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 maxEntries = uint32(1 + (keySeed / n) % CHUNK_ENTRIES);
        vm.warp(block.timestamp + 24 hours);
        CascadeMessages.Payout[] memory list = lists[key];
        // test-controlled time
        // forge-lint: disable-next-line(block-timestamp)
        bool ready = block.timestamp >= uint256(vault.getPayoutBatch(key).queuedAt) + vault.payoutDelay()
            && vault.frontDoorActive(peer) && vault.bridgeEnabled(vault.primaryBridge());
        uint256 cursor = vault.getPayoutBatch(key).cursor;
        vm.recordLogs();
        try vault.processPayouts(key, list, maxEntries) {
            _recordPayout(key, vm.getRecordedLogs());
            CascadeVault.PayoutBatch memory b = vault.getPayoutBatch(key);
            bouncesPaid += _bounces(list, cursor, b.count == 0 ? list.length : b.cursor);
            if (b.count == 0) _dropKey(key);
            else ++partialChunks;
            _raiseFloor();
        } catch (bytes memory reason) {
            if (ready && !_dustBlocked(reason)) ++unexpectedReverts;
        }
    }

    function stakeIdle() external {
        uint256 idle = _sub0(_sub0(address(vault).balance, ED), vault.pendingPayouts());
        if (idle / RAO < MIN_STAKE_RAO) return;
        try vault.stakeIdle() {
            ++stakes;
            _raiseFloor();
        } catch {
            ++unexpectedReverts;
        }
    }

    /// @dev Accrues `rao` of root rewards on the hotkey and claims them as the keeper, under whatever
    /// reward cut is set (none until claimWithCut sets one).
    function accrueAndClaim(uint256 rao) external {
        _claim(rao);
    }

    /// @dev As the owner, sets the reward cut to `bps` (0 to MAX_REWARD_CUT_BPS; 0 turns it off), which
    /// stays set for later claims, then accrues and claims `rao` as accrueAndClaim does. It runs from
    /// whatever state the run reached: a schedule still vesting, payouts pending, a vault below half
    /// the launch price (where the cut is skipped).
    function claimWithCut(uint256 bps, uint256 rao) external {
        // casting to 'uint16' is safe because bps is bounded to MAX_REWARD_CUT_BPS
        // forge-lint: disable-next-line(unsafe-typecast)
        uint16 cut = uint16(bound(bps, 0, vault.MAX_REWARD_CUT_BPS()));
        vm.prank(owner);
        vault.setRewardCut(treasury, cut);
        _claim(rao);
    }

    // ---- vault: direct users ----

    /// @dev A direct deposit marks the actor direct-only; the handler opts it back in to front-door
    /// redeems unless the amount in rao is 3 mod 4, so both paths stay in use and the vault's
    /// direct-only skip is reached too.
    function depositDirect(uint256 actorSeed, uint256 amount) external {
        address actor = actors[actorSeed % actors.length];
        uint256 maxRao = Math.min(MAX_DEPOSIT, _sub0(actor.balance, FEE_MONEY)) / RAO;
        if (maxRao < 1e15 / RAO) return;
        amount = bound(amount, 1e15 / RAO, maxRao) * RAO;
        // within the cap, and not below half the launch price (VaultInsolvent, reachable after a loss)
        uint256 assets = vault.totalAssets();
        bool ready = assets + amount <= vault.maxTotalAssets() && assets * 2_000_000 >= vault.totalSupply();
        vm.prank(actor);
        try vault.depositDirect{value: amount}() {
            ghostIn += amount;
            ++directDeposits;
            if ((amount / RAO) % 4 != 3) {
                vm.prank(actor);
                vault.allowFrontDoorRedeems();
            }
            _raiseFloor();
        } catch {
            if (ready) ++unexpectedReverts;
        }
    }

    function redeemDirect(uint256 actorSeed, uint256 shares) external {
        (address actor, uint256 balance) = _actorWith(actorSeed, _shares);
        if (balance == 0) return;
        shares = bound(shares, 1, balance);
        uint256 out = CascadeMath.assetsForRedeem(shares, vault.totalAssets(), vault.totalSupply());
        uint256 before = actor.balance;
        vm.prank(actor);
        try vault.redeemDirect(shares) {
            ghostOut += actor.balance - before;
            ++directRedeems;
            _raiseFloor();
        } catch (bytes memory reason) {
            if (out >= RAO && !_dustBlocked(reason)) ++unexpectedReverts;
        }
    }

    // ---- owner ----

    /// @dev Cancels a queued batch's unsent payouts. The price may fall to that batch's delivery price,
    /// and below it by the rounding dust of the entries re-minted: each burned entry left less than 1 rao
    /// in the vault, which a holder who exits before the cancel can take. So the post-cancel price is
    /// checked once here, with one rao per re-minted entry, and the floor restarts from it.
    function cancelQueued(uint256 keySeed) external {
        uint256 n = queuedKeys.length;
        if (n == 0) return;
        // prefers a batch that already sent a chunk
        bytes32 key = _keyWith(keySeed, _chunksSent, 1);
        CascadeMessages.Payout[] memory list = lists[key];
        CascadeVault.PayoutBatch memory b = vault.getPayoutBatch(key);
        uint256 reMinted = b.count - b.cursor;
        vm.prank(owner);
        try vault.cancelPayoutBatch(key, list) {
            uint256 f = Math.min(priceFloor, deliveryPrice[key]);
            if (CascadeMath.price(vault.totalAssets() + reMinted * RAO, vault.totalSupply()) < f) {
                ++cancelDustViolations;
            }
            priceFloor = Math.min(f, vault.price());
            bouncesCancelled += _bounces(list, b.cursor, list.length);
            _dropKey(key);
            ++cancels;
            if (b.cursor != 0) ++cancelsAfterPartial;
        } catch {
            ++unexpectedReverts;
        }
    }

    // ---- losses ----

    /// @dev Rarely (seed % 7 == 0, on at most MAX_LOSSES calls a run) takes TAO out of the vault, as a
    /// lost or misread position would: between half and all of the liquid balance that is neither the
    /// existential reserve nor reserved for queued payouts (so every queued payout stays fundable and
    /// a payout's UnstakeShort stays unexpected), floored to rao. A large one makes the vault insolvent,
    /// so later deliveries bounce their deposits. A loss legitimately lowers the price, so the floor
    /// restarts from the post-loss price.
    function simulateLoss(uint256 seed) external {
        if (seed % 7 != 0 || losses >= MAX_LOSSES) return;
        uint256 balance = address(vault).balance;
        uint256 free = _sub0(_sub0(balance, ED), vault.pendingPayouts());
        uint256 x = bound(seed / 7, free / 2, free);
        x -= x % RAO;
        if (x == 0) return;
        vm.deal(address(vault), balance - x);
        ghostLoss += x;
        ++losses;
        priceFloor = vault.price();
    }

    // ---- time ----

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1 hours, 3 days));
        _raiseFloor();
    }

    // ---- views ----

    function queuedCount() external view returns (uint256) {
        return queuedKeys.length;
    }

    function claimCount() external view returns (uint256) {
        return claimPriceBefore.length;
    }

    function deliveryCount() external view returns (uint256) {
        return deliveryFloor.length;
    }

    // ---- internal ----

    /// Claims `rao` of accrued root rewards as the keeper, recording the share price right before and
    /// right after (and after with one more share), the reward (from RewardsClaimed) and whether a cut
    /// was minted, skipped, or minted while a schedule was vesting or payouts were pending.
    function _claim(uint256 rao) internal {
        rao = bound(rao, 1e6, 1e9);
        staking.setUnclaimed(vault.coldkey(), hotkey, rao);
        bool vesting = vault.unvestedRewards() != 0;
        bool pending = vault.pendingPayouts() != 0;
        uint256 priceBefore = vault.price();
        vm.recordLogs();
        // claimRewards needs claimGasRequired (55M) left before the claim
        try vault.claimRewards{gas: 60_000_000}(hotkey) {
            claimPriceBefore.push(priceBefore);
            claimPriceAfter.push(vault.price());
            claimPriceOneMoreShare.push(CascadeMath.price(vault.totalAssets(), vault.totalSupply() + 1));
            Vm.Log[] memory logs = vm.getRecordedLogs();
            uint256 delta;
            bool minted;
            for (uint256 i; i < logs.length; ++i) {
                if (_isVaultLog(logs[i], CascadeVault.RewardsClaimed.selector)) {
                    delta = abi.decode(logs[i].data, (uint256)) * RAO;
                } else if (_isVaultLog(logs[i], CascadeVault.RewardCutMinted.selector)) {
                    minted = true;
                }
            }
            ghostRewards += delta;
            if (minted) {
                ++cutsMinted;
                if (vesting) ++cutsWhileVesting;
                if (pending) ++cutsWithPending;
            } else if (delta * vault.rewardCutBps() / 10_000 != 0) {
                ++cutsSkipped;
            }
            ++rewardClaims;
            _raiseFloor();
        } catch {
            ++unexpectedReverts;
        }
    }

    /// The actor's live preference, or a fresh one (see deliver); a zero floor if setDelivery failed.
    function _prefer(address actor, uint256 seed) internal returns (Preference memory p) {
        p = preferences[actor];
        // test-controlled time
        // forge-lint: disable-next-line(block-timestamp)
        if (p.floor != 0 && (block.timestamp <= p.deadline || seed % 2 == 1)) return p;
        uint256 perTao = bound(seed, 200e6, 260e6);
        uint256 until = block.timestamp + bound(seed >> 128, 1 hours, 7 days);
        // casting to 'uint128' and 'uint64' is safe because both values are bounded far below their maxima
        // forge-lint: disable-next-line(unsafe-typecast)
        p = Preference(uint128(perTao), uint64(until));
        vm.prank(actor);
        try fd.setDelivery(p.floor, p.deadline, DESTINATION_BASE) {
            preferences[actor] = p;
        } catch {
            ++unexpectedReverts;
            p.floor = 0;
        }
    }

    /// Sets this call's market (see deliver). Returns whether the short-paying swapper sells, what the
    /// staker would pay the front door (its router's rate less the swap fee), and whether the short
    /// payer pays the front door's whole minimum.
    function _drawMarket(uint256 owed, uint256 seed)
        internal
        returns (bool viaShortPayer, uint256 expected, bool paysInFull)
    {
        uint256 rate = bound(seed >> 8, 225e6, 275e6);
        router.setRate(address(tao), rate);
        router.setLies(seed % 4 == 2);
        uint256 gross = owed * rate / 1e18;
        expected = gross - gross * staker.swapFeeBps() / 10_000;
        if (seed % 4 == 3) {
            viaShortPayer = true;
            uint256 shortBps = (seed >> 128) % 2 == 0 ? 0 : 1 + (seed >> 129) % 100;
            paysInFull = shortBps == 0;
            shortPayer.setMode(MockSwapper.Mode.PaysLess, shortBps);
            vm.prank(owner);
            fd.setSwapper(address(shortPayer));
        }
    }

    /// The delivery's floor, computed here: the largest of the user's floor (USDC units per 1e18 TAO)
    /// rounded up, the keeper's, and the TWAP's value less SLIPPAGE_BPS.
    function _deliveryFloor(uint256 owed, uint256 perTao, uint256 keeperMinOut) internal view returns (uint256) {
        uint256 market = owed * twap.usdcPerTao() / 1e18 * (10_000 - SLIPPAGE_BPS) / 10_000;
        return Math.max(Math.ceilDiv(owed * perTao, 1e18), Math.max(keeperMinOut, market));
    }

    /// Calls deliver. A success records its floor and what the actor's USDC rose by; a refusal the
    /// handler did not expect (`ready`) counts as an unexpected revert.
    function _deliver(address actor, uint256 owed, uint256 keeperMinOut, uint256 floor, bool live, bool ready)
        internal
    {
        uint256 before = usdc.balanceOf(actor);
        bool otherCredits = fd.totalClaimable() > owed;
        (,, uint256 openDeposits,,,) = fd.openBatch();
        try fd.deliver(actor, keeperMinOut) {
            uint256 received = usdc.balanceOf(actor) - before;
            deliveryFloor.push(floor);
            deliveryReceived.push(received);
            ghostDelivered += owed;
            ++usdcDeliveries;
            if (!live) ++lateDeliveries;
            if (otherCredits) ++deliveriesBesideOtherCredits;
            if (openDeposits != 0) ++deliveriesBesideOpenDeposits;
            if (received == floor) ++deliveriesAtFloor;
            _raiseFloor();
        } catch {
            if (ready) ++unexpectedReverts;
            else ++deliveriesRefused;
        }
    }

    /// Reads one auto-delivered batch: its amount, its payout list and delivery price if it queued
    /// payouts, and the burn window it wrote. A delivery the bridge filed as failed counts as an
    /// unexpected revert: the vault is never paused and its peer is always active here.
    function _recordDelivery(Vm.Log[] memory logs) internal {
        bool burned;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory log = logs[i];
            if (log.emitter == address(bridge) && log.topics[0] == MockBridge.DeliveryFailed.selector) {
                ++unexpectedReverts;
            }
            if (_isVaultLog(log, CascadeVault.BatchDelivered.selector)) {
                (, uint256 amount) = abi.decode(log.data, (uint64, uint256));
                ghostIn += amount;
                ++deliveries;
            } else if (_isVaultLog(log, CascadeVault.DepositBounced.selector)) {
                // a bounced deposit is queued ahead of the redeems, with 0 shares
                // casting to 'uint160' is safe because the topic is an indexed address
                // forge-lint: disable-next-line(unsafe-typecast)
                address user = address(uint160(uint256(log.topics[2])));
                lists[log.topics[1]].push(CascadeMessages.Payout(user, 0, abi.decode(log.data, (uint256))));
                ++depositBounces;
            } else if (_isVaultLog(log, CascadeVault.Redeemed.selector)) {
                (uint256 shares, uint256 assets) = abi.decode(log.data, (uint256, uint256));
                // casting to 'uint160' is safe because the topic is an indexed address
                // forge-lint: disable-next-line(unsafe-typecast)
                address user = address(uint160(uint256(log.topics[2])));
                lists[log.topics[1]].push(CascadeMessages.Payout(user, shares, assets));
                burned = true;
            } else if (_isVaultLog(log, CascadeVault.PayoutBatchQueued.selector)) {
                (,,, uint256 price) = abi.decode(log.data, (uint64, uint32, uint256, uint256));
                deliveryPrice[log.topics[1]] = price;
                queuedKeys.push(log.topics[1]);
                maxQueueDepth = Math.max(maxQueueDepth, queuedKeys.length);
            } else if (_isVaultLog(log, CascadeVault.RedeemDeferred.selector)) {
                ++redeemDeferred;
            } else if (_isVaultLog(log, CascadeVault.RedeemSkipped.selector)) {
                ++redeemSkipped;
            }
        }
        // The window is written only by a delivery that burns (a Redeemed event; bounced deposits alone
        // queue payouts without burning); checked then, against the most the vault's allowance base can
        // be: its root stake (the base is the stake less what is still ramping in, and never counts
        // liquid TAO, so neither this delivery's deposits nor any other; a delivery stakes nothing).
        if (burned) {
            (, uint256 windowBurned) = vault.burnWindows(peer);
            uint256 stake = vault.rootStakeRao() * RAO;
            if (windowBurned > Math.max(stake * 2000 / 10_000, 100e18)) ++burnViolations;
        }
    }

    /// Adds batch `key`'s sent chunk to the outflow and to what the front door was paid. A payout
    /// delivery the bridge filed as failed counts as an unexpected revert.
    function _recordPayout(bytes32 key, Vm.Log[] memory logs) internal {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory log = logs[i];
            if (log.emitter == address(bridge) && log.topics[0] == MockBridge.DeliveryFailed.selector) {
                ++unexpectedReverts;
            }
            if (_isVaultLog(log, CascadeVault.PayoutChunkSent.selector) && log.topics[1] == key) {
                (,,, uint256 net, uint256 fee) = abi.decode(log.data, (uint32, uint32, uint256, uint256, uint256));
                ghostOut += net + fee;
                ghostPayoutsReceived += net;
                ++payoutChunks;
            }
        }
    }

    /// An UnstakeShort while the vault's stake is non-zero but below the minimum stake: the unstake walk
    /// skips such a position, so an exit that needs it waits for stakeIdle (or the owner) to clear it.
    /// Counted in dustBlocked.
    function _dustBlocked(bytes memory reason) internal returns (bool) {
        uint256 s = staking.getStake(hotkey, vault.coldkey(), 0);
        // truncating to the selector is the point of the cast
        // forge-lint: disable-next-line(unsafe-typecast)
        if (s == 0 || s >= MIN_STAKE_RAO || bytes4(reason) != CascadeVault.UnstakeShort.selector) return false;
        ++dustBlocked;
        return true;
    }

    /// Swap-and-pop.
    function _dropKey(bytes32 key) internal {
        uint256 n = queuedKeys.length;
        for (uint256 i; i < n; ++i) {
            if (queuedKeys[i] == key) {
                queuedKeys[i] = queuedKeys[n - 1];
                queuedKeys.pop();
                break;
            }
        }
        delete lists[key];
    }

    function _raiseFloor() internal {
        priceFloor = Math.max(priceFloor, vault.price());
    }

    function _isVaultLog(Vm.Log memory log, bytes32 sig) internal view returns (bool) {
        return log.emitter == address(vault) && log.topics[0] == sig;
    }

    /// The first actor from `seed` on with a non-zero `amountOf`, or (actors[seed], 0).
    function _actorWith(uint256 seed, function(address) internal view returns (uint256) amountOf)
        internal
        view
        returns (address actor, uint256 amount)
    {
        uint256 n = actors.length;
        for (uint256 i; i < n; ++i) {
            actor = actors[(seed % n + i) % n];
            amount = amountOf(actor);
            if (amount != 0) return (actor, amount);
        }
        return (actors[seed % n], 0);
    }

    /// The first queued key from `seed` on whose `measure` is at least `min`, or queuedKeys[seed].
    /// Requires a non-empty queue.
    function _keyWith(uint256 seed, function(bytes32) internal view returns (uint256) measure, uint256 min)
        internal
        view
        returns (bytes32)
    {
        uint256 n = queuedKeys.length;
        for (uint256 i; i < n; ++i) {
            bytes32 key = queuedKeys[(seed % n + i) % n];
            if (measure(key) >= min) return key;
        }
        return queuedKeys[seed % n];
    }

    function _entriesLeft(bytes32 key) internal view returns (uint256) {
        CascadeVault.PayoutBatch memory b = vault.getPayoutBatch(key);
        return b.count - b.cursor;
    }

    function _chunksSent(bytes32 key) internal view returns (uint256) {
        return vault.getPayoutBatch(key).cursor;
    }

    function _shares(address a) internal view returns (uint256) {
        return vault.balanceOf(a);
    }

    function _sharesNotRequested(address a) internal view returns (uint256) {
        return fd.redeemOf(a) == 0 ? vault.balanceOf(a) : 0;
    }

    function _openDeposit(address a) internal view returns (uint256) {
        return fd.depositOf(a);
    }

    function _openRedeem(address a) internal view returns (uint256) {
        return fd.redeemOf(a);
    }

    function _claimable(address a) internal view returns (uint256) {
        return fd.claimable(a);
    }

    /// The bounced deposits (0 shares) among list[from:to].
    function _bounces(CascadeMessages.Payout[] memory list, uint256 from, uint256 to)
        internal
        pure
        returns (uint256 n)
    {
        for (uint256 i = from; i < to; ++i) {
            if (list[i].shares == 0) ++n;
        }
    }

    function _sub0(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }
}
