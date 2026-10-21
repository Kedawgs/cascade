// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {StakeEngine} from "../../src/StakeEngine.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {MockTAO} from "../mocks/MockTAO.sol";

/// @notice Bounded user, keeper and reward actions for the Cascade invariant suite, over three funded
/// actors. Every action wraps its vault or engine call in try/catch and updates the ghost totals only
/// when that call succeeds. The handler itself is the keeper: it closes and settles epochs, paying
/// exactly the bridge fee.
contract Handler is CommonBase, StdCheats, StdUtils {
    uint256 internal constant MAX_DEPOSIT = 100e18;

    CascadeVault public immutable vault;
    StakeEngine public immutable engine;
    MockTAO public immutable tao;
    MockStaking public immutable staking;
    bytes32 public immutable coldkey;
    bytes32 public immutable hotkey;
    uint256 public immutable fee;

    address[3] public actors;

    // ---- ghost totals ----

    /// csTAO actors actually received from `claimShares`, in total and per epoch.
    uint256 public claimedShares;
    mapping(uint64 => uint256) public claimedSharesOf;
    /// TAO actors actually received from `claimAssets`, in total and per epoch.
    uint256 public claimedAssets;
    mapping(uint64 => uint256) public claimedAssetsOf;
    /// Sum of `assetsPaid` over the epochs settled by `settle`.
    uint256 public paidAssets;
    /// Sum of `sharesMinted` over the epochs settled by `settle`.
    uint256 public mintedShares;
    /// Highest `lastPrice` seen after any settle; a later lower price stays below it.
    uint256 public lastSeenPrice;
    /// Root rewards (rao) accrued and claimed since the last settlement.
    uint256 public accruedSinceSettle;
    /// Calls that reverted although their precondition guarantees success: a settle with an epoch
    /// pending, a close with none in flight, or a claim of a non-zero entitlement.
    uint256 public unexpectedReverts;

    // ---- reachability counters (successful calls) ----

    uint256 public settledEpochs;
    uint256 public shareClaims;
    uint256 public assetClaims;
    uint256 public rewardClaims;

    constructor(
        CascadeVault vault_,
        StakeEngine engine_,
        MockTAO tao_,
        MockStaking staking_,
        bytes32 coldkey_,
        bytes32 hotkey_,
        uint256 fee_
    ) {
        vault = vault_;
        engine = engine_;
        tao = tao_;
        staking = staking_;
        coldkey = coldkey_;
        hotkey = hotkey_;
        fee = fee_;

        actors = [makeAddr("alice"), makeAddr("bob"), makeAddr("carol")];
        for (uint256 i; i < actors.length; i++) {
            tao_.mint(actors[i], 1_000e18);
            vm.deal(actors[i], 1 ether);
            vm.prank(actors[i]);
            tao_.approve(address(vault_), type(uint256).max);
        }
        vm.deal(address(this), 100 ether);
    }

    /// @dev Takes the fee refund when `closeEpoch` only rolls an empty epoch.
    receive() external payable {}

    // ---- user actions ----

    /// @dev Capped per call so an actor keeps TAO for deposits in later epochs.
    function deposit(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        uint256 balance = tao.balanceOf(actor);
        uint256 minDeposit = vault.minDeposit();
        if (balance < minDeposit) return;
        amount = bound(amount, minDeposit, balance < MAX_DEPOSIT ? balance : MAX_DEPOSIT);
        vm.prank(actor);
        try vault.requestDeposit(amount, actor) {} catch {}
    }

    function cancelDeposit(uint256 actorSeed, uint256 amount) external {
        (address actor, uint256 requested) = _actorWith(actorSeed, _openDeposit);
        if (requested == 0) return;
        amount = bound(amount, 1, requested);
        vm.prank(actor);
        try vault.cancelDeposit(amount) {} catch {}
    }

    function redeem(uint256 actorSeed, uint256 shares) external {
        (address actor, uint256 balance) = _actorWith(actorSeed, _shareBalance);
        if (balance == 0) return;
        shares = bound(shares, 1, balance);
        vm.prank(actor);
        try vault.requestRedeem(shares) {} catch {}
    }

    function cancelRedeem(uint256 actorSeed, uint256 shares) external {
        (address actor, uint256 requested) = _actorWith(actorSeed, _openRedeem);
        if (requested == 0) return;
        shares = bound(shares, 1, requested);
        vm.prank(actor);
        try vault.cancelRedeem(shares) {} catch {}
    }

    function claimShares(uint256 actorSeed, uint256 epochId) external {
        (address actor, uint64 id, bool entitled) = _claimTarget(actorSeed, epochId, vault.claimableShares);
        uint256 before = vault.balanceOf(actor);
        vm.prank(actor);
        try vault.claimShares(id) {
            uint256 received = vault.balanceOf(actor) - before;
            claimedShares += received;
            claimedSharesOf[id] += received;
            shareClaims++;
        } catch {
            if (entitled) unexpectedReverts++;
        }
    }

    function claimAssets(uint256 actorSeed, uint256 epochId) external {
        (address actor, uint64 id, bool entitled) = _claimTarget(actorSeed, epochId, vault.claimableAssets);
        uint256 before = tao.balanceOf(actor);
        vm.prank(actor);
        try vault.claimAssets(id) {
            uint256 received = tao.balanceOf(actor) - before;
            claimedAssets += received;
            claimedAssetsOf[id] += received;
            assetClaims++;
        } catch {
            if (entitled) unexpectedReverts++;
        }
    }

    // ---- keeper actions ----

    /// @dev Warps past the epoch duration (1 day) first, so only an epoch in flight (or a pause) can
    /// stop the close. An empty epoch just rolls.
    function closeEpoch() external {
        vm.warp(block.timestamp + 1 days + 1);
        bool canClose = vault.inFlightEpoch() == 0 && !vault.paused();
        try vault.closeEpoch{value: fee}() {}
        catch {
            if (canClose) unexpectedReverts++;
        }
    }

    /// @dev The engine is never paused and the handler pays exactly the fee, so a settle with an
    /// epoch pending must succeed.
    function settle() external {
        uint64 id = vault.inFlightEpoch();
        bool pending = engine.hasPending();
        try engine.settleEpoch{value: fee}() {
            uint256 price = vault.lastPrice();
            if (price > lastSeenPrice) lastSeenPrice = price;
            CascadeVault.Epoch memory epoch = vault.epochs(id);
            mintedShares += epoch.sharesMinted;
            paidAssets += epoch.assetsPaid;
            accruedSinceSettle = 0;
            settledEpochs++;
        } catch {
            if (pending) unexpectedReverts++;
        }
    }

    /// @dev Root rewards capped at a 10% APR of the root stake since the last settlement (half the
    /// vault's 20% bound), so an honest reward can never flag an epoch.
    function accrueAndClaimRewards(uint256 rao) external {
        uint256 lastPriceTime = vault.lastPriceTime();
        if (lastPriceTime == 0) return;
        uint256 allowance = engine.rootStakeRao() * 1000 * (block.timestamp - lastPriceTime) / (10000 * 365 days);
        if (allowance <= accruedSinceSettle) return;
        rao = bound(rao, 1, allowance - accruedSinceSettle);
        staking.accrueRootReward(coldkey, hotkey, rao);
        try engine.claimRewards() {
            accruedSinceSettle += rao;
            rewardClaims++;
        } catch {}
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 12 hours));
    }

    // ---- internal ----

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    /// @dev The first actor, from the seeded one on, for whom `amountOf` is non-zero, with that
    /// amount; zero if no actor has any.
    function _actorWith(uint256 seed, function(address) internal view returns (uint256) amountOf)
        internal
        view
        returns (address actor, uint256 amount)
    {
        for (uint256 i; i < actors.length; i++) {
            actor = _actor(seed % actors.length + i);
            amount = amountOf(actor);
            if (amount != 0) return (actor, amount);
        }
    }

    function _shareBalance(address actor) internal view returns (uint256) {
        return vault.balanceOf(actor);
    }

    function _openDeposit(address actor) internal view returns (uint256) {
        return vault.depositOf(vault.currentEpochId(), actor);
    }

    function _openRedeem(address actor) internal view returns (uint256) {
        return vault.redeemOf(vault.currentEpochId(), actor);
    }

    /// @dev The first epoch (from the seeded one on, wrapping) and actor (from the seeded one on) with
    /// a non-zero `claimableOf`, which is zero unless the epoch is settled. With none, the seeded pair
    /// and `entitled == false`, so the claim's revert paths still run.
    function _claimTarget(
        uint256 actorSeed,
        uint256 epochSeed,
        function(uint64, address) external view returns (uint256) claimableOf
    ) internal view returns (address, uint64, bool entitled) {
        uint64 last = vault.currentEpochId();
        uint64 start = uint64(bound(epochSeed, 1, last));
        for (uint64 i; i < last; i++) {
            uint64 id = (start - 1 + i) % last + 1;
            for (uint256 j; j < actors.length; j++) {
                address actor = _actor(actorSeed % actors.length + j);
                if (claimableOf(id, actor) != 0) return (actor, id, true);
            }
        }
        return (_actor(actorSeed), start, false);
    }
}
