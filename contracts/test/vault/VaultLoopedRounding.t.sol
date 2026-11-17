// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeVaultLens} from "../../src/lens/CascadeVaultLens.sol";
import {VaultTestBase} from "../VaultTestBase.sol";

/// Test only: one transaction of `n` round trips, each a direct deposit of `amount` and the direct exit of exactly the
/// shares it minted, with the vault's price read after every trip. With `guardPrice` it refuses to end below its start
/// price: the loop reverts "the price fell" the moment a trip lowers it.
contract LoopAttacker {
    CascadeVault public immutable vault;
    CascadeVaultLens public immutable lens;

    constructor(CascadeVault vault_, CascadeVaultLens lens_) {
        vault = vault_;
        lens = lens_;
    }

    /// The exits pay here.
    receive() external payable {}

    /// Runs the loop; returns the price before it and the lowest after any trip.
    function loop(uint256 n, uint256 amount, bool guardPrice) external returns (uint256 startPrice, uint256 minPrice) {
        startPrice = lens.price();
        minPrice = type(uint256).max;
        for (uint256 i; i < n; ++i) {
            uint256 before = vault.balanceOf(address(this));
            vault.depositDirect{value: amount}();
            vault.redeemDirect(vault.balanceOf(address(this)) - before, false);
            uint256 p = lens.price();
            require(!guardPrice || p >= startPrice, "the price fell");
            if (p < minPrice) minPrice = p;
        }
    }
}

/// The looped-rounding question (founder, 2026-11-03; Task 35): every rounding in a direct deposit and a direct exit is
/// the vault's (shares round down at the deposit, the payment down to the rao at the exit; CascadeMath and spec
/// §3.3), so no loop of round trips in one transaction profits. CascadeMath's testFuzz_roundTripNeverProfits checks
/// the math alone; this checks the vault's path: the attacker contract's N round trips (N up to 1,000; the amounts
/// fuzzed from the minimum direct deposit up, the fixture's one-rao-short fresh reads on) end with no more TAO than
/// they started with, the vault keeping exactly what the attacker lost, and the price per share never below its
/// start, after any trip. Exits that must unstake (queued payouts reserving the liquid balance) walk the stake
/// hotkey; at no removal fee a walk's receipt is exact and its cushion stays liquid. A variant runs the loop at a
/// removal fee of 1 to 50,000 rao (past T), where each walking exit pays what the chain kept of its walk (Task 36b,
/// the leaver pays): the price still never falls, the attacker never ends with more, and the vault keeps the loss
/// less what the chain kept.
contract VaultLoopedRoundingTest is VaultTestBase {
    uint256 constant RAO = 1e9;

    LoopAttacker attacker;

    /// The fixture's mock reads a fresh position one rao short (its default, kept: the keeper's first stake below
    /// lands one rao short).
    function setUp() public override {
        super.setUp();
        attacker = new LoopAttacker(vault, vaultLens);
    }

    /// alice's `seedRao` deposited and staked (the fresh position read one rao short), `rewardRao` of root rewards
    /// claimed and `elapsed` of its 7-day schedule vested (the price off the launch price), and, when `reservedRao` is
    /// non-zero, a front-door redeem by alice of shares worth about that much queued, its payout reserving the liquid
    /// balance, so the attacker's exits walk the stake.
    function _vault(uint256 seedRao, uint256 rewardRao, uint256 elapsed, uint256 reservedRao) internal {
        depositDirect(alice, seedRao * RAO);
        vm.prank(keeper);
        vault.stakeIdle();
        assertEq(vaultLens.visibleStakeRao(), seedRao - 1, "the fresh position read one rao short");
        if (rewardRao != 0) {
            staking.setUnclaimed(vaultLens.coldkey(), HK1, rewardRao);
            vm.prank(keeper);
            vault.claimRewards{gas: 60_000_000}(HK1);
            vm.warp(vm.getBlockTimestamp() + elapsed);
        }
        if (reservedRao != 0) {
            vm.prank(alice);
            vault.setRedeemOrigin(BASE);
            uint256 shares = vault.balanceOf(alice) * reservedRao / seedRao;
            if (shares != 0) deliver(BASE, frontDoor, ++nextBatchId, noEntries(), entries1(alice, shares));
        }
    }

    /// Runs the loop and checks it: the attacker ends with no more than it started with, the vault's assets rose by
    /// exactly what the attacker lost (no wei leaks anywhere else), and the price after the loop is no lower than
    /// before it (the attacker also refused any trip that lowered it). Returns what the attacker lost.
    function _loop(uint256 n, uint256 amount) internal returns (uint256 lost) {
        // twice the trip's amount: each trip may come back short of it by its rounding
        vm.deal(address(attacker), 2 * amount);
        uint256 start = address(attacker).balance;
        uint256 assets = vaultLens.totalAssets();
        uint256 supply = vault.totalSupply();
        (uint256 startPrice, uint256 minPrice) = attacker.loop(n, amount, true);
        uint256 end = address(attacker).balance;
        assertLe(end, start, "the loop profited");
        lost = start - end;
        emit log_named_uint("wei the loop lost to the vault", lost);
        assertEq(vaultLens.totalAssets(), assets + lost, "the vault keeps exactly what the attacker lost");
        assertEq(vault.totalSupply(), supply, "every share the loop minted was burned");
        assertGe(minPrice, startPrice, "the price fell below its start");
        assertGe(vaultLens.price(), startPrice);
    }

    /// N round trips of a fuzzed amount (the minimum direct deposit, 0.001 TAO, up to 100 TAO) into a vault of a
    /// fuzzed size, price and reservation.
    /// forge-config: default.fuzz.runs = 64
    /// forge-config: parity.fuzz.runs = 64
    function testFuzz_loopedRoundTripsNeverProfit(
        uint256 n,
        uint256 amount,
        uint256 seedRao,
        uint256 rewardRao,
        uint256 elapsed,
        uint256 reservedRao
    ) public {
        seedRao = bound(seedRao, 1e9, 500e9);
        _vault(
            seedRao, bound(rewardRao, 0, seedRao / 10), bound(elapsed, 0, 7 days), bound(reservedRao, 0, seedRao / 2)
        );
        n = bound(n, 1, 1_000);
        amount = bound(amount, vaultLens.minDirectDeposit() / RAO, 100e9) * RAO;
        _loop(n, amount);
    }

    /// The loop at a removal fee (the review's Minor 6), guarded (Task 36b): the chain keeps the fee of every removal,
    /// and the walking exit whose walk it was pays it (the leaver pays its exit's whole cost), so no trip lowers the
    /// price, the guard included. Asserted: the attacker ends with no more TAO than it started with, it bore at least
    /// what the chain kept, and the vault's assets rose by what the attacker lost less what the chain kept (what the
    /// vault's balance and its coldkey's root stake, in wei, rose by less than the attacker's loss). Returns what the
    /// attacker lost and what the chain kept.
    function _loopAtAFee(uint256 n, uint256 amount) internal returns (uint256 lost, uint256 kept) {
        // twice the trip's amount and every trip's fee: each walking trip pays its removal's (one hotkey, one removal)
        vm.deal(address(attacker), 2 * amount + n * (staking.removeFeeRao() + 1) * RAO);
        uint256 start = address(attacker).balance;
        uint256 assets = vaultLens.totalAssets();
        uint256 held = _held();
        (uint256 startPrice, uint256 minPrice) = attacker.loop(n, amount, true);
        uint256 end = address(attacker).balance;
        assertLe(end, start, "the loop profited");
        lost = start - end;
        kept = held + lost - _held();
        emit log_named_uint("wei the loop lost to the vault", lost);
        emit log_named_uint("wei the chain kept of the walks", kept);
        assertGe(lost, kept, "the attacker bore what the chain kept");
        assertEq(vaultLens.totalAssets() + kept, assets + lost, "the vault keeps the loss less what the chain kept");
        assertGe(minPrice, startPrice, "the price fell below its start");
        assertGe(vaultLens.price(), startPrice);
    }

    /// The vault's TAO in wei: its balance and its coldkey's root stake.
    function _held() internal view returns (uint256) {
        return address(vault).balance + staking.getTotalColdkeyStakeOnSubnet(vaultLens.coldkey(), 0) * RAO;
    }

    /// testFuzz_loopedRoundTripsNeverProfit's vault and loop with the chain's removal fee fuzzed from 1 to 50,000 rao,
    /// past T (_loopAtAFee: never more TAO, never a lower price, and the vault keeps the loss less what the chain
    /// kept).
    /// forge-config: default.fuzz.runs = 64
    /// forge-config: parity.fuzz.runs = 64
    function testFuzz_loopedRoundTripsAtAFeeNeverProfit(
        uint256 n,
        uint256 amount,
        uint256 seedRao,
        uint256 rewardRao,
        uint256 elapsed,
        uint256 reservedRao,
        uint256 fee
    ) public {
        seedRao = bound(seedRao, 1e9, 500e9);
        _vault(
            seedRao, bound(rewardRao, 0, seedRao / 10), bound(elapsed, 0, 7 days), bound(reservedRao, 0, seedRao / 2)
        );
        staking.setRemoveFeeRao(bound(fee, 1, 50_000));
        n = bound(n, 1, 1_000);
        amount = bound(amount, vaultLens.minDirectDeposit() / RAO, 100e9) * RAO;
        _loopAtAFee(n, amount);
    }

    /// The fee variant's walking case, pinned at a 50,000-rao fee (past T): 1,000 round trips of 10 TAO while queued
    /// payouts reserve the liquid balance, so the first exits walk the stake and the chain keeps part of what they
    /// take; the attacker pays it, ends with no more than it started with, never lowers the price, and the vault keeps
    /// the loss less what the chain kept.
    function test_aThousandRoundTripsThatWalkTheStakeAtAFeePastT() public {
        _vault(100e9, 1.25e9, 3.5 days, 40e9);
        staking.setRemoveFeeRao(50_000);
        uint256 staked = vaultLens.visibleStakeRao();
        (, uint256 kept) = _loopAtAFee(1_000, 10e18);
        assertLt(vaultLens.visibleStakeRao(), staked, "the exits walked the stake");
        assertGt(kept, 0, "the chain kept part of what the walks took");
    }

    /// 1,000 round trips at the minimum direct deposit, at a price off the launch price (1.25 TAO of rewards, half
    /// vested, into 100 TAO): each trip rounds against the attacker, who ends strictly poorer, by what the vault kept.
    function test_aThousandRoundTripsAtTheMinimumEndPoorer() public {
        _vault(100e9, 1.25e9, 3.5 days, 0);
        assertGt(_loop(1_000, vaultLens.minDirectDeposit()), 0, "strictly less TAO than it started with");
    }

    /// 1,000 round trips of 10 TAO while queued payouts reserve the liquid balance: the first exits unstake (a walk of
    /// the stake hotkey, its cushion of at least the chain's minimum left liquid), and still no trip profits or lowers
    /// the price.
    function test_aThousandRoundTripsThatWalkTheStake() public {
        _vault(100e9, 1.25e9, 3.5 days, 40e9);
        uint256 staked = vaultLens.visibleStakeRao();
        assertGt(vaultLens.pendingPayouts(), 0);
        _loop(1_000, 10e18);
        assertLt(vaultLens.visibleStakeRao(), staked, "the exits walked the stake");
    }

    /// At exactly the launch price (no reward, nothing staked or reserved: 1e6 shares a wei on both sides), a round
    /// trip is exact: shares = a * 1e6 and back = a, so the loop ends where it started, never above. Strictly less
    /// needs a price off the launch price (test_aThousandRoundTripsAtTheMinimumEndPoorer).
    function test_atTheLaunchPriceARoundTripIsExact() public {
        depositDirect(alice, 10e18);
        assertEq(_loop(1_000, 1e15), 0, "exact at the launch price");
    }
}
