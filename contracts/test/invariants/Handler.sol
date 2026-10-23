// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {ISTAKING_ADDRESS} from "../../src/interfaces/IStaking.sol";
import {CascadeMath} from "../../src/libraries/CascadeMath.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {MockBridge} from "../mocks/MockBridge.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {MockTAO} from "../mocks/MockTAO.sol";

/// @notice Bounded user, keeper and owner actions for the Cascade invariant suite, over three actors.
/// Each actor holds 10_000 bridged TAO on Base, and 10_000 native TAO plus 10 ether of fee money as one
/// native balance (both chains share one EVM here). Every action wraps its call in try/catch and
/// updates the ghosts only when it succeeds. The handler is the vault's keeper, pays every close's
/// bridge fee, and acts as the owner (by prank) to cancel queued payouts. No donations.
contract Handler is CommonBase, StdCheats, StdUtils {
    uint256 internal constant RAO = 1e9;
    uint256 internal constant ED = 1e12;
    uint256 internal constant MAX_DEPOSIT = 100e18;
    /// Native balance an actor keeps back from direct deposits, for redeem-request fees.
    uint256 internal constant FEE_MONEY = 10 ether;
    uint256 internal constant MIN_STAKE_RAO = 2_000_000;
    /// The most entries one processPayouts call asks for (it asks for 1 to CHUNK_ENTRIES); with the
    /// vault's minChunk at 1, a 2- or 3-entry batch can go out in several chunks.
    uint32 internal constant CHUNK_ENTRIES = 3;

    CascadeVault public immutable vault;
    CascadeFrontDoor public immutable fd;
    MockTAO public immutable tao;
    MockBridge public immutable bridge;
    MockStaking public constant staking = MockStaking(ISTAKING_ADDRESS);
    address public immutable owner;
    bytes32 public immutable hotkey;
    /// The front door's peer id at the vault.
    bytes32 public immutable peer;

    address[3] public actors;

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
    /// High-water mark of queuedKeys.length.
    uint256 public maxQueueDepth;
    /// Exits refused UnstakeShort because the only stake sat below the minimum stake, which the
    /// vault's unstake walk skips.
    uint256 public dustBlocked;

    constructor(
        CascadeVault vault_,
        CascadeFrontDoor fd_,
        MockTAO tao_,
        MockBridge bridge_,
        address owner_,
        bytes32 hotkey_,
        uint64 chain
    ) {
        vault = vault_;
        fd = fd_;
        tao = tao_;
        bridge = bridge_;
        owner = owner_;
        hotkey = hotkey_;
        peer = vault_.peerId(chain, address(fd_));

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

    function claim(uint256 actorSeed) external {
        (address actor, uint256 owed) = _actorWith(actorSeed, _claimable);
        if (owed == 0) return;
        uint256 before = tao.balanceOf(actor);
        vm.prank(actor);
        try fd.claim() {
            ghostClaimed += tao.balanceOf(actor) - before;
            ++claims;
            _raiseFloor();
        } catch {
            ++unexpectedReverts;
        }
    }

    // ---- front door: keeper ----

    /// @dev Warps 12 hours, so the open batch is due, and pays the bridge fee on top of the pot. The
    /// bridge delivers inside the close: the delivery's events give its amount, its payout list (from
    /// the Redeemed events) and its delivery price.
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

    // ---- vault: keeper and permissionless ----

    /// @dev Warps 24 hours past the payout delay of a queued batch (preferring one with 2 or more entries
    /// left, which can go out in several chunks) and sends its next chunk of 1 to CHUNK_ENTRIES entries
    /// (from the seed) from the stored list.
    function processPayouts(uint256 keySeed) external {
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
        vm.recordLogs();
        try vault.processPayouts(key, list, maxEntries) {
            _recordPayout(key, vm.getRecordedLogs());
            if (vault.getPayoutBatch(key).count == 0) _dropKey(key);
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

    /// @dev Accrues `rao` of root rewards on the hotkey and claims them as the keeper.
    function accrueAndClaim(uint256 rao) external {
        rao = bound(rao, 1e6, 1e9);
        staking.setUnclaimed(vault.coldkey(), hotkey, rao);
        vm.recordLogs();
        // claimRewards needs claimGasRequired (55M) left before the claim
        try vault.claimRewards{gas: 60_000_000}(hotkey) {
            Vm.Log[] memory logs = vm.getRecordedLogs();
            for (uint256 i; i < logs.length; ++i) {
                if (_isVaultLog(logs[i], CascadeVault.RewardsClaimed.selector)) {
                    ghostRewards += abi.decode(logs[i].data, (uint256)) * RAO;
                }
            }
            ++rewardClaims;
            _raiseFloor();
        } catch {
            ++unexpectedReverts;
        }
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
        bool ready = vault.totalAssets() + amount <= vault.maxTotalAssets();
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
            _dropKey(key);
            ++cancels;
            if (b.cursor != 0) ++cancelsAfterPartial;
        } catch {
            ++unexpectedReverts;
        }
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

    // ---- internal ----

    /// Reads one auto-delivered batch: its amount, its payout list and delivery price if it queued
    /// payouts, and the burn window it wrote. A delivery the bridge filed as failed counts as an
    /// unexpected revert: the vault is never paused and its peer is always active here.
    function _recordDelivery(Vm.Log[] memory logs) internal {
        bool burned;
        uint256 delivered;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory log = logs[i];
            if (log.emitter == address(bridge) && log.topics[0] == MockBridge.DeliveryFailed.selector) {
                ++unexpectedReverts;
            }
            if (_isVaultLog(log, CascadeVault.BatchDelivered.selector)) {
                (, uint256 amount) = abi.decode(log.data, (uint64, uint256));
                ghostIn += amount;
                delivered = amount;
                ++deliveries;
            } else if (_isVaultLog(log, CascadeVault.Redeemed.selector)) {
                (uint256 shares, uint256 assets) = abi.decode(log.data, (uint256, uint256));
                // casting to 'uint160' is safe because the topic is an indexed address
                // forge-lint: disable-next-line(unsafe-typecast)
                address user = address(uint160(uint256(log.topics[2])));
                lists[log.topics[1]].push(CascadeMessages.Payout(user, shares, assets));
            } else if (_isVaultLog(log, CascadeVault.PayoutBatchQueued.selector)) {
                (,,, uint256 price) = abi.decode(log.data, (uint64, uint32, uint256, uint256));
                deliveryPrice[log.topics[1]] = price;
                queuedKeys.push(log.topics[1]);
                maxQueueDepth = Math.max(maxQueueDepth, queuedKeys.length);
                burned = true;
            } else if (_isVaultLog(log, CascadeVault.RedeemDeferred.selector)) {
                ++redeemDeferred;
            } else if (_isVaultLog(log, CascadeVault.RedeemSkipped.selector)) {
                ++redeemSkipped;
            }
        }
        // The window is written only by a delivery that burns; checked then, against the gross the
        // vault measured its allowance on: the gross before this delivery's deposits (nothing else has
        // changed it since, inside the same close).
        if (burned) {
            (, uint256 windowBurned) = vault.burnWindows(peer);
            uint256 grossBefore = _sub0(vault.grossAssets(), delivered);
            if (windowBurned > Math.max(grossBefore * 2000 / 10_000, 100e18)) ++burnViolations;
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

    function _sub0(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }
}
