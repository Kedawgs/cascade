// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {CascadeMath} from "../../src/libraries/CascadeMath.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {GLOBAL_WINDOW, STAKE_RAMP} from "../../src/CascadeConstants.sol";
import {Deposited, RedeemDeferred, Redeemed} from "../../src/CascadeEvents.sol";
import {VaultTestBase} from "../VaultTestBase.sol";

/// @notice The door hold on fresh shares (spec §3.5, I-36; R4 B-H1): a front door burns only shares held a day. Each
/// holder's bucket (FreshShares) counts what a door's deposit or a direct deposit minted for it in the last run of
/// mints each within STAKE_RAMP of the last, and no door burns them until STAKE_RAMP after that last mint; a cancel's
/// re-mint never adds to it. The fixture's limits: nothing staked, so each window's allowance is the 100 TAO floor.
contract VaultDoorHoldTest is VaultTestBase {
    address mallory = makeAddr("mallory");

    // ---- helpers ----

    /// `user`'s deposit of `amount` through the launch door, delivered and left fresh (the fixture's depositVia ages its
    /// holders past the hold).
    function depositFresh(address user, uint256 amount) internal returns (bytes32) {
        return deliver(BASE, frontDoor, ++nextBatchId, entries1(user, amount), noEntries());
    }

    function entries2(address u1, uint256 a1, address u2, uint256 a2)
        internal
        pure
        returns (CascadeMessages.Entry[] memory e)
    {
        e = new CascadeMessages.Entry[](2);
        e[0] = CascadeMessages.Entry(u1, a1);
        e[1] = CascadeMessages.Entry(u2, a2);
    }

    /// What the door burned in its window and in the global one, as of now.
    function burnedNow() internal view returns (uint256 door, uint256 all) {
        (, door) = vaultLens.burnWindows(vaultLens.peerId(BASE, frontDoor));
        (, all) = vaultLens.burnWindows(GLOBAL_WINDOW);
    }

    /// A door redeem of `shares` of `user`'s, alone in its batch; returns the batch key.
    function redeemVia(address user, uint256 shares) internal returns (bytes32) {
        return deliver(BASE, frontDoor, ++nextBatchId, noEntries(), entries1(user, shares));
    }

    // ---- the reviewer's sequence ----

    /// The wash (R4 B-H1): mallory deposits the day's whole allowance and asks to redeem it in the same batch, ahead
    /// of alice's request. Before the hold her burn took the allowance and alice was deferred; now mallory's fresh
    /// shares are held (RedeemDeferred: nothing burned, nothing of the windows taken), alice is paid, and the windows
    /// count alice's burn alone. A day later mallory's shares are hers like any other.
    function test_aDepositAndARedeemInOneBatchTakeNothingOfTheAllowance() public {
        depositFresh(alice, 50e18);
        vm.warp(vm.getBlockTimestamp() + STAKE_RAMP);
        uint256 A = vaultLens.totalAssets();
        uint256 S = vault.totalSupply();
        uint256 minted = CascadeMath.sharesForDeposit(100e18, A, S);
        uint256 out = CascadeMath.assetsForRedeem(1e25, A, S);
        out -= out % 1e9;

        bytes memory m = CascadeMessages.encodeBatch(
            ++nextBatchId, entries1(mallory, 100e18), entries2(mallory, type(uint128).max, alice, 1e25)
        );
        bytes32 key = vaultLens.batchKey(BASE, frontDoor, m);
        vm.expectEmit(address(vault));
        emit Deposited(key, mallory, 100e18, minted);
        vm.expectEmit(address(vault));
        emit RedeemDeferred(key, mallory, type(uint128).max);
        vm.expectEmit(address(vault));
        emit Redeemed(key, alice, 1e25, out);
        vm.deal(address(bridge), 100e18);
        vm.prank(address(bridge));
        vault.onBridgeMessage{value: 100e18}(BASE, frontDoor, m, 100e18);

        assertEq(vault.balanceOf(mallory), minted, "mallory's fresh shares unburned");
        assertEq(vault.balanceOf(alice), 4e25);
        (uint256 door, uint256 all) = burnedNow();
        assertEq(door, out, "the door's window took alice's burn alone");
        assertEq(all, out, "the global window took alice's burn alone");
        (uint64 since, uint128 fresh) = vaultLens.freshShares(mallory);
        assertEq(since, vm.getBlockTimestamp());
        assertEq(fresh, minted);

        // a day later they are mallory's like any other: her redeem burns
        vm.warp(vm.getBlockTimestamp() + STAKE_RAMP);
        redeemVia(mallory, minted);
        assertEq(vault.balanceOf(mallory), 0);
    }

    // ---- the day, to the second ----

    /// Shares a door minted are held for STAKE_RAMP from that mint: a second short of a day the redeem is deferred,
    /// at a day and a second it burns.
    function test_aRedeemADayAndASecondLaterBurns() public {
        depositFresh(alice, 10e18);
        uint256 t0 = vm.getBlockTimestamp();
        (uint64 since, uint128 fresh) = vaultLens.freshShares(alice);
        assertEq(since, t0);
        assertEq(fresh, 1e25);

        vm.warp(t0 + STAKE_RAMP - 1);
        vm.recordLogs();
        bytes32 k1 = redeemVia(alice, 1e25);
        assertDeferred(vm.getRecordedLogs(), k1, alice, 1e25);
        assertEq(vault.balanceOf(alice), 1e25, "held a second short of a day");
        (uint256 door,) = burnedNow();
        assertEq(door, 0, "a held request takes nothing of the window");

        vm.warp(t0 + STAKE_RAMP + 1);
        redeemVia(alice, 1e25);
        assertEq(vault.balanceOf(alice), 0, "burned a day and a second later");
    }

    /// Two mints within a day are one run (R4 S-L3): the bucket holds both, and its clock moves to their share-weighted
    /// mean, not to the second: 5 TAO at t0 and about 5 TAO twelve hours later put it at t0 + 6 hours, so both stay held
    /// until a day after that, and burn from then.
    function test_aMintWithinTheDayJoinsTheBucketAtTheWeightedClock() public {
        depositFresh(alice, 5e18);
        uint256 t0 = vm.getBlockTimestamp();
        vm.warp(t0 + 12 hours);
        depositFresh(alice, 5e18);
        uint256 balance = vault.balanceOf(alice);
        (uint64 since, uint128 fresh) = vaultLens.freshShares(alice);
        assertEq(since, t0 + 6 hours, "the share-weighted mean of the two mints");
        assertEq(fresh, balance, "both mints in the bucket");

        vm.warp(t0 + 6 hours + STAKE_RAMP - 1);
        redeemVia(alice, balance);
        assertEq(vault.balanceOf(alice), balance, "held a second short of a day from the weighted clock");

        vm.warp(t0 + 6 hours + STAKE_RAMP);
        redeemVia(alice, balance);
        assertEq(vault.balanceOf(alice), 0);
    }

    /// A stranger's gifts cannot hold a holder's own fresh shares much past a day (R4 S-L3): alice deposits 50 TAO,
    /// held at first; a stranger then gifts her 0.04 TAO every hour for 23 hours, each joining her bucket. Each gift
    /// moves the clock by its share of the bucket only (at most about a minute), so a day and half an hour after her deposit
    /// every share she holds, hers and the gifts, burns. With the clock moved to each mint, the last gift would have
    /// held all of it until 23 hours later.
    function test_aStrangersGiftsCannotHoldTheHoldersOwnSharesPastADay() public {
        depositFresh(alice, 50e18);
        uint256 t0 = vm.getBlockTimestamp();
        vm.warp(t0 + 30 minutes);
        redeemVia(alice, 5e25);
        assertEq(vault.balanceOf(alice), 5e25, "her own fresh shares held");
        for (uint256 h = 1; h <= 23; ++h) {
            vm.warp(t0 + h * 1 hours);
            depositFresh(alice, 0.04e18);
        }
        (uint64 since,) = vaultLens.freshShares(alice);
        assertLt(since, t0 + 15 minutes, "the gifts moved the clock by their share alone (about 13 minutes)");

        vm.warp(t0 + STAKE_RAMP + 30 minutes);
        uint256 all = vault.balanceOf(alice);
        redeemVia(alice, all);
        assertEq(vault.balanceOf(alice), 0, "everything burns a day and half an hour after her own deposit");
    }

    // ---- a direct deposit ----

    /// depositDirect writes the bucket too, so a direct depositor who names Base (setRedeemOrigin) cannot redeem the
    /// fresh shares through the door either: held for a day, then burned. redeemDirect is never held.
    function test_depositDirectThenSetRedeemOriginThenADoorRedeemIsHeld() public {
        vm.deal(bob, 10e18);
        vm.prank(bob);
        vault.depositDirect{value: 10e18}();
        (uint64 since, uint128 fresh) = vaultLens.freshShares(bob);
        assertEq(since, vm.getBlockTimestamp());
        assertEq(fresh, 1e25);
        vm.prank(bob);
        vault.setRedeemOrigin(BASE);

        vm.recordLogs();
        bytes32 k = redeemVia(bob, 5e24);
        assertDeferred(vm.getRecordedLogs(), k, bob, 5e24);
        assertEq(vault.balanceOf(bob), 1e25);

        // a direct exit is not held (it takes no allowance); it lowers `fresh` to the balance it leaves (spec §3.5, R6 A)
        vm.prank(bob);
        vault.redeemDirect(1e24, false);
        assertEq(vault.balanceOf(bob), 9e24);
        (, fresh) = vaultLens.freshShares(bob);
        assertEq(fresh, 9e24, "fresh follows the balance down");

        // the same day, a door redeem over a balance that is all fresh (sub0: nothing to burn) is deferred
        vm.recordLogs();
        k = redeemVia(bob, 5e24);
        assertDeferred(vm.getRecordedLogs(), k, bob, 5e24);
        assertEq(vault.balanceOf(bob), 9e24, "nothing burned");

        vm.warp(vm.getBlockTimestamp() + STAKE_RAMP);
        redeemVia(bob, 5e24);
        assertEq(vault.balanceOf(bob), 4e24, "burned once the day has passed");
    }

    // ---- a direct exit lowers the bucket (R6 A, ChatGPT R2 claim A) ----

    /// A direct exit lowers the bucket to the balance it leaves, so shares that left on Bittensor never weigh in a later
    /// mint's clock. mallory recycles 100 TAO through depositDirect and redeemDirect 50 times in one block: her bucket
    /// ends at 0 (without the cap it kept about 5,000 TAO of burned shares at t0, and her later door deposit's clock sat
    /// near t0, held under an hour). Ten minutes short of a day later her 150 TAO door deposit starts a run of its own
    /// at the deposit, as carol's identical one does; 55 minutes later both are held while alice, a day-old holder, burns;
    /// a second short of a day after the deposit mallory is still held, and at the day she burns.
    function test_aDirectExitLowersTheBucketSoBurnedSharesCannotShortenALaterHold() public {
        depositVia(alice, 50e18); // aged past the hold
        uint256 t0 = vm.getBlockTimestamp();

        // one block on Bittensor: 50 round trips of the same 100 TAO
        vm.deal(mallory, 100e18);
        for (uint256 i; i < 50; ++i) {
            uint256 cash = mallory.balance - mallory.balance % 1e9;
            vm.prank(mallory);
            vault.depositDirect{value: cash}();
            uint256 held = vault.balanceOf(mallory);
            vm.prank(mallory);
            vault.redeemDirect(held, false);
        }
        assertEq(vault.balanceOf(mallory), 0, "mallory holds no shares");
        assertGt(mallory.balance, 99.99e18, "and has her TAO back");
        (, uint128 left) = vaultLens.freshShares(mallory);
        assertEq(left, 0, "the bucket followed the balance down: no burned share is counted");
        vm.prank(mallory);
        vault.setRedeemOrigin(BASE);

        // 23 h 50 min later: mallory's and carol's 150 TAO door deposits, one batch
        vm.warp(t0 + STAKE_RAMP - 10 minutes);
        uint256 tDeposit = vm.getBlockTimestamp();
        deliver(BASE, frontDoor, ++nextBatchId, entries2(mallory, 150e18, carol, 150e18), noEntries());
        (uint64 sinceM,) = vaultLens.freshShares(mallory);
        (uint64 sinceC,) = vaultLens.freshShares(carol);
        assertEq(sinceM, tDeposit, "mallory's run starts at her deposit");
        assertEq(sinceC, tDeposit, "as carol's does");

        // 55 minutes after the deposits: mallory, alice and carol ask, in that order
        vm.warp(tDeposit + 55 minutes);
        uint256 malloryBefore = vault.balanceOf(mallory);
        uint256 carolBefore = vault.balanceOf(carol);
        CascadeMessages.Entry[] memory r = new CascadeMessages.Entry[](3);
        r[0] = CascadeMessages.Entry(mallory, type(uint128).max);
        r[1] = CascadeMessages.Entry(alice, 1e25);
        r[2] = CascadeMessages.Entry(carol, type(uint128).max);
        vm.recordLogs();
        bytes32 k = deliver(BASE, frontDoor, ++nextBatchId, noEntries(), r);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertUserDeferred(logs, k, mallory, type(uint128).max);
        assertEq(vault.balanceOf(mallory), malloryBefore, "mallory's 55-minute-old deposit held");
        assertUserDeferred(logs, k, carol, type(uint128).max);
        assertEq(vault.balanceOf(carol), carolBefore, "and carol's");
        assertEq(burnedOf(logs, k, alice), 1e25, "alice, a day-old holder, burns");

        // the full day from the deposit: a second short of it still held, at it burned
        vm.warp(tDeposit + STAKE_RAMP - 1);
        vm.recordLogs();
        k = redeemVia(mallory, type(uint128).max);
        assertDeferred(vm.getRecordedLogs(), k, mallory, type(uint128).max);
        vm.warp(tDeposit + STAKE_RAMP);
        vm.recordLogs();
        k = redeemVia(mallory, type(uint128).max);
        assertGt(burnedOf(vm.getRecordedLogs(), k, mallory), 0, "held the full day, then burned");
    }

    /// A holder with aged shares beside the fresh ones it exits directly: the bucket is capped at the balance, so the
    /// aged shares stand in for the burned fresh ones and are held in their place for the run (nothing gained over
    /// redeeming them through the door). mallory holds 30 TAO of aged shares and round-trips 20 TAO three times: the
    /// bucket is left at her 30 TAO, never above it, and a door redeem that day is clipped to the balance less the bucket
    /// (nothing). A door deposit of 30 TAO twelve hours in joins that real bucket at the share-weighted mean, about
    /// t0 + 6 hours (the stale count of 60 TAO would have put it at t0 + 4 hours), and everything is held until a day
    /// after it, then burns.
    function test_aDirectExitOfFreshSharesLeavesTheAgedSharesHeldInTheirPlace() public {
        depositVia(mallory, 30e18); // aged past the hold, origin Base
        uint256 aged = vault.balanceOf(mallory);
        uint256 t0 = vm.getBlockTimestamp();
        vm.deal(mallory, 20e18);
        for (uint256 i; i < 3; ++i) {
            uint256 cash = mallory.balance - mallory.balance % 1e9;
            uint256 before = vault.balanceOf(mallory);
            vm.prank(mallory);
            vault.depositDirect{value: cash}();
            uint256 minted = vault.balanceOf(mallory) - before;
            vm.prank(mallory);
            vault.redeemDirect(minted, false);
            (, uint128 bucket) = vaultLens.freshShares(mallory);
            assertLe(bucket, vault.balanceOf(mallory), "the bucket never above the balance");
        }
        assertEq(vault.balanceOf(mallory), aged, "the aged shares are left");
        (uint64 since, uint128 fresh) = vaultLens.freshShares(mallory);
        assertEq(since, t0);
        assertEq(fresh, aged, "capped at the balance: the aged shares stand in for the burned fresh ones");
        vm.prank(mallory);
        vault.setRedeemOrigin(BASE);

        // the same day, a door redeem is clipped to the balance less the bucket: nothing burns
        vm.warp(t0 + 1 hours);
        vm.recordLogs();
        bytes32 k = redeemVia(mallory, type(uint128).max);
        assertDeferred(vm.getRecordedLogs(), k, mallory, type(uint128).max);
        assertEq(vault.balanceOf(mallory), aged);

        // twelve hours in, a door deposit of about the aged shares' worth joins the real bucket
        vm.warp(t0 + 12 hours);
        depositFresh(mallory, 30e18);
        uint256 balance = vault.balanceOf(mallory);
        (since, fresh) = vaultLens.freshShares(mallory);
        assertEq(fresh, balance, "the whole balance in the bucket");
        assertApproxEqAbs(since, t0 + 6 hours, 60, "the clock at the mean of the real bucket and the deposit");

        // held until a day after that clock, then burned
        vm.warp(uint256(since) + STAKE_RAMP - 1);
        vm.recordLogs();
        k = redeemVia(mallory, type(uint128).max);
        assertDeferred(vm.getRecordedLogs(), k, mallory, type(uint128).max);
        assertEq(vault.balanceOf(mallory), balance, "held a second short of a day from the clock");
        vm.warp(uint256(since) + STAKE_RAMP);
        redeemVia(mallory, type(uint128).max);
        assertEq(vault.balanceOf(mallory), 0, "burned at the day");
    }

    // ---- a cancel's re-mint ----

    /// The owner's cancel hands the shares back: it adds nothing to the bucket, so the re-minted holder's next door
    /// redeem, at once, burns.
    function test_aCancelsReMintIsNotHeld() public {
        depositFresh(alice, 20e18);
        vm.warp(vm.getBlockTimestamp() + STAKE_RAMP);
        (uint64 at0, uint128 fresh0) = vaultLens.freshShares(alice);

        bytes32 k = redeemVia(alice, 1e25);
        CascadeMessages.Payout[] memory list = new CascadeMessages.Payout[](1);
        list[0] = CascadeMessages.Payout(alice, 1e25, vaultLens.getPayoutBatch(k).remaining);
        vm.prank(owner);
        vault.cancelPayoutBatch(k, list);
        uint256 balance = vault.balanceOf(alice);
        assertGt(balance, 1e25, "re-minted");
        (uint64 since, uint128 fresh) = vaultLens.freshShares(alice);
        assertEq(since, at0, "the re-mint left the bucket's clock");
        assertEq(fresh, fresh0, "and its shares");

        redeemVia(alice, balance);
        assertEq(vault.balanceOf(alice), 0, "the re-minted holder is not held");
    }

    // ---- a stranger's gift ----

    /// A stranger's depositFor(alice) holds only what it gives (R4: one bucket per holder, never the whole balance):
    /// every day for three days a stranger's gift for alice lands in the same batch as her request for everything, and
    /// each time her older shares burn and only that day's gift stays held. The bucket restarts with each gift (a day
    /// apart), so yesterday's gift burns today.
    function test_aStrangersDailyGiftHoldsOnlyTheGift() public {
        depositFresh(alice, 20e18);
        vm.warp(vm.getBlockTimestamp() + STAKE_RAMP);
        for (uint256 day; day < 3; ++day) {
            uint256 A = vaultLens.totalAssets();
            uint256 S = vault.totalSupply();
            uint256 gift = CascadeMath.sharesForDeposit(1e18, A, S);
            uint256 old = vault.balanceOf(alice);
            vm.recordLogs();
            bytes32 k =
                deliver(BASE, frontDoor, ++nextBatchId, entries1(alice, 1e18), entries1(alice, type(uint128).max));
            Vm.Log[] memory logs = vm.getRecordedLogs();
            assertEq(burnedOf(logs, k, alice), old, "every older share burned");
            assertEq(vault.balanceOf(alice), gift, "only the day's gift held");
            (uint64 since, uint128 fresh) = vaultLens.freshShares(alice);
            assertEq(since, vm.getBlockTimestamp());
            assertEq(fresh, gift, "the bucket restarted with the gift alone");
            vm.warp(vm.getBlockTimestamp() + STAKE_RAMP);
        }
    }

    // ---- log readers ----

    /// The shares `user`'s Redeemed under `key` burned in `logs` (0 for none).
    function burnedOf(Vm.Log[] memory logs, bytes32 key, address user) internal view returns (uint256 shares) {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(vault) || l.topics[0] != Redeemed.selector || l.topics[1] != key) continue;
            if (l.topics[2] != bytes32(uint256(uint160(user)))) continue;
            (shares,) = abi.decode(l.data, (uint256, uint256));
        }
    }

    /// `logs` hold `user`'s RedeemDeferred of `requested` under `key`, and no Redeemed.
    function assertDeferred(Vm.Log[] memory logs, bytes32 key, address user, uint256 requested) internal view {
        bool deferred;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(vault) || l.topics[1] != key) continue;
            assertTrue(l.topics[0] != Redeemed.selector, "nothing burned");
            if (l.topics[0] == RedeemDeferred.selector && l.topics[2] == bytes32(uint256(uint160(user)))) {
                assertEq(abi.decode(l.data, (uint256)), requested);
                deferred = true;
            }
        }
        assertTrue(deferred, "RedeemDeferred");
    }

    /// `logs` hold `user`'s RedeemDeferred of `requested` under `key`, and no Redeemed of `user`'s under it (others' may
    /// burn in the same batch, which assertDeferred forbids).
    function assertUserDeferred(Vm.Log[] memory logs, bytes32 key, address user, uint256 requested) internal view {
        bytes32 u = bytes32(uint256(uint160(user)));
        bool deferred;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(vault) || l.topics.length < 3 || l.topics[1] != key || l.topics[2] != u) continue;
            assertTrue(l.topics[0] != Redeemed.selector, "nothing of the user's burned");
            if (l.topics[0] == RedeemDeferred.selector) {
                assertEq(abi.decode(l.data, (uint256)), requested);
                deferred = true;
            }
        }
        assertTrue(deferred, "RedeemDeferred");
    }
}
