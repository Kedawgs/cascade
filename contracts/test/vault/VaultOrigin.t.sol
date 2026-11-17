// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeMath} from "../../src/libraries/CascadeMath.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {CascadePayoutMath} from "../../src/libraries/CascadePayoutMath.sol";
import {DIRECT_ORIGIN, GLOBAL_WINDOW, MIN_REDEEM_VALUE} from "../../src/CascadeConstants.sol";
import {BounceReason, PayoutBatch} from "../../src/CascadeTypes.sol";
import {InvalidParameter, UnknownOrigin} from "../../src/CascadeErrors.sol";
import {DepositBounced, Deposited, RedeemOriginSet, RedeemSkipped, Redeemed} from "../../src/CascadeEvents.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {Schedule} from "../governance/Schedule.sol";

/// Two front doors on two chains (spec §3.4): the fixture's launch door on Base (8453) and a second door, door10,
/// on chain 10, activated through the scheduler in setUp. Task 17: the global outflow window beside each door's
/// own. Task 18: origin by chain, each holder's redeem origin (the chain whose doors may burn its shares, or
/// DIRECT_ORIGIN, which no door burns for). The fixture's limits: each door may burn 20% of the allowance base a
/// day (maxDailyOutflowBps, the fixture's), all doors together 30% (globalOutflowBps, set above the per-door
/// percentage so that the two windows tell apart), each at least the shared 100 TAO floor (minDailyOutflow);
/// exact stake reads; a 10% reward cut to `treasury`, an address no door deposits for (origin 0).
contract VaultOriginTest is VaultTestBase {
    uint64 constant OPTIMISM = 10;
    /// A chain with no front door.
    uint64 constant POLYGON = 137;
    /// What a burn may fall short of the TAO it aims at: the floor to rao, and the share conversion's rounding.
    uint256 constant ROUNDING = 1e10;

    address door10 = makeAddr("door10");
    address treasury = makeAddr("treasury");

    function vaultParams() internal view override returns (CascadeVault.Params memory p) {
        p = super.vaultParams();
        p.globalOutflowBps = 3_000;
        p.treasury = treasury;
        p.rewardCutBps = 1_000;
    }

    function setUp() public override {
        super.setUp();
        staking.setOneRaoShort(false);
        registerFrontDoor(OPTIMISM, door10);
    }

    // ---- helpers ----

    /// alice deposits `a` through Base and bob `b` through chain 10; the keeper stakes both, and a day later all
    /// of it is in the allowance base.
    function fund(uint256 a, uint256 b) internal {
        deliver(BASE, frontDoor, ++nextBatchId, entries1(alice, a), noEntries());
        deliver(OPTIMISM, door10, ++nextBatchId, entries1(bob, b), noEntries());
        vm.prank(keeper);
        vault.stakeIdle();
        vm.warp(vm.getBlockTimestamp() + 1 days);
    }

    /// Delivers a redeem of `shares` of `user`'s from the door (chain, door) and returns the TAO it burned: 0 when
    /// it was deferred.
    function redeem(uint64 chain, address door, address user, uint256 shares) internal returns (uint256 out) {
        vm.recordLogs();
        deliver(chain, door, ++nextBatchId, noEntries(), entries1(user, shares));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == Redeemed.selector) {
                (, out) = abi.decode(logs[i].data, (uint256, uint256));
            }
        }
    }

    /// A redeem of all of `user`'s shares from the door (chain, door).
    function redeemAll(uint64 chain, address door, address user) internal returns (uint256) {
        return redeem(chain, door, user, vault.balanceOf(user));
    }

    function burnedIn(bytes32 window) internal view returns (uint256 burned) {
        (, burned) = vaultLens.burnWindows(window);
    }

    function baseDoor() internal view returns (bytes32) {
        return vaultLens.peerId(BASE, frontDoor);
    }

    function tenDoor() internal view returns (bytes32) {
        return vaultLens.peerId(OPTIMISM, door10);
    }

    /// The key of the next batch from (chain, door) with these entries: the one the next `deliver` gets.
    function nextKey(
        uint64 chain,
        address door,
        CascadeMessages.Entry[] memory deposits,
        CascadeMessages.Entry[] memory redeems
    ) internal view returns (bytes32) {
        return vaultLens.batchKey(chain, door, CascadeMessages.encodeBatch(nextBatchId + 1, deposits, redeems));
    }

    /// Delivers a deposit of `assets` for `user` from the door (chain, door), the holder's shares then aged past the
    /// door hold (matureShares, R4 B-H1), as depositVia's are.
    function depositFrom(uint64 chain, address door, address user, uint256 assets) internal {
        deliver(chain, door, ++nextBatchId, entries1(user, assets), noEntries());
        matureShares(user);
    }

    /// Delivers a redeem of `shares` of `user`'s from the door (chain, door), expecting it skipped (RedeemSkipped):
    /// nothing burned, nothing queued, the batch itself delivered.
    function expectSkipped(uint64 chain, address door, address user, uint256 shares) internal {
        uint256 held = vault.balanceOf(user);
        uint256 supply = vault.totalSupply();
        uint256 pending = vaultLens.pendingPayouts();
        bytes32 key = nextKey(chain, door, noEntries(), entries1(user, shares));
        vm.expectEmit(address(vault));
        emit RedeemSkipped(key, user, shares);
        deliver(chain, door, ++nextBatchId, noEntries(), entries1(user, shares));
        assertEq(vault.balanceOf(user), held, "skipped: nothing burned");
        assertEq(vault.totalSupply(), supply, "skipped: the supply as it was");
        assertEq(vaultLens.pendingPayouts(), pending, "skipped: nothing queued");
        assertEq(vaultLens.getPayoutBatch(key).count, 0, "skipped: no payout batch");
        assertTrue(vaultLens.processed(key), "the batch itself delivered");
    }

    /// Delivers a redeem of `shares` of `user`'s from the door (chain, door), expecting all of it burned (Redeemed),
    /// and returns the batch's key and its payout list (that one entry).
    function expectBurned(uint64 chain, address door, address user, uint256 shares)
        internal
        returns (bytes32 key, CascadeMessages.Payout[] memory list)
    {
        uint256 held = vault.balanceOf(user);
        uint256 out = CascadeMath.assetsForRedeem(shares, vaultLens.totalAssets(), vault.totalSupply());
        out -= out % 1e9;
        key = nextKey(chain, door, noEntries(), entries1(user, shares));
        vm.expectEmit(address(vault));
        emit Redeemed(key, user, shares, out);
        deliver(chain, door, ++nextBatchId, noEntries(), entries1(user, shares));
        assertEq(vault.balanceOf(user), held - shares, "burned");
        list = new CascadeMessages.Payout[](1);
        list[0] = CascadeMessages.Payout(user, shares, out);
    }

    function setOrigin(address user, uint64 chain) internal {
        vm.prank(user);
        vault.setRedeemOrigin(chain);
    }

    /// The keeper claims `rao` of HK1's rewards: the fixture's 10% cut is minted to the treasury.
    function claimWithCut(uint256 rao) internal {
        staking.setUnclaimed(vaultLens.coldkey(), HK1, rao);
        vm.prank(keeper);
        vault.claimRewards{gas: 60_000_000}(HK1);
    }

    // ---- the global window (spec §3.4) ----

    /// The global window binds across doors. In a 2,000 TAO vault each door may burn 400 TAO a day and all doors
    /// together 600: alice takes her door's 400 through Base; bob, through chain 10, gets only the 200 the global
    /// window has left, though his door's own window allows 400; then a request from either door is deferred. A
    /// day later both windows open again. (With only a window per door, bob burned 400, 800 in all.)
    function test_globalWindowBindsAcrossDoors() public {
        fund(1_000e18, 1_000e18);
        assertApproxEqAbs(redeemAll(BASE, frontDoor, alice), 400e18, ROUNDING, "alice: her door's 20%");
        assertApproxEqAbs(redeemAll(OPTIMISM, door10, bob), 200e18, ROUNDING, "bob: what the global window left");
        assertApproxEqAbs(burnedIn(tenDoor()), 200e18, ROUNDING, "door10's window counts what it burned");
        assertEq(redeemAll(OPTIMISM, door10, bob), 0, "the global window is spent: deferred");
        assertEq(redeemAll(BASE, frontDoor, alice), 0, "at Base too");
        assertApproxEqAbs(burnedIn(GLOBAL_WINDOW), 600e18, 2 * ROUNDING, "all doors: 30%");
        assertEq(burnedIn(GLOBAL_WINDOW), burnedIn(baseDoor()) + burnedIn(tenDoor()), "the sum of the doors'");

        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertApproxEqAbs(redeemAll(OPTIMISM, door10, bob), 400e18, ROUNDING, "a day later: bob's door's 20%");
        assertApproxEqAbs(redeemAll(BASE, frontDoor, alice), 200e18, ROUNDING, "and alice the global's rest");
        assertApproxEqAbs(burnedIn(GLOBAL_WINDOW), 600e18, 2 * ROUNDING);
    }

    /// Each door's own window still counts, on its own clock. alice takes Base's 400 TAO, and her next request is
    /// deferred though the global window has 200 left. Twelve hours on, bob burns those 200 through chain 10, which
    /// opens door10's window then. A day after the first burn the global and Base windows open again, but door10's
    /// is still the one opened twelve hours ago: bob gets its 200 left, not 400, while alice gets 400.
    function test_eachDoorsWindowStillCounts() public {
        fund(1_000e18, 1_000e18);
        uint256 opened = vm.getBlockTimestamp();
        assertApproxEqAbs(redeemAll(BASE, frontDoor, alice), 400e18, ROUNDING, "alice: her door's 20%");
        assertEq(redeemAll(BASE, frontDoor, alice), 0, "Base's window is spent, the global's not: deferred");
        assertApproxEqAbs(burnedIn(GLOBAL_WINDOW), 400e18, ROUNDING, "the global window has 200 left");

        vm.warp(opened + 12 hours);
        assertApproxEqAbs(redeemAll(OPTIMISM, door10, bob), 200e18, ROUNDING, "bob: the global's rest");
        (uint64 tenStart,) = vaultLens.burnWindows(tenDoor());
        assertEq(tenStart, opened + 12 hours, "door10's window opened at its first burn");

        vm.warp(opened + 1 days);
        assertApproxEqAbs(redeemAll(OPTIMISM, door10, bob), 200e18, ROUNDING, "bob: what door10's window left");
        assertApproxEqAbs(redeemAll(BASE, frontDoor, alice), 400e18, ROUNDING, "alice: Base's window, opened again");
        (uint64 globalStart,) = vaultLens.burnWindows(GLOBAL_WINDOW);
        (uint64 baseStart,) = vaultLens.burnWindows(baseDoor());
        assertEq(globalStart, opened + 1 days, "the global window opened again");
        assertEq(baseStart, opened + 1 days, "and Base's");
        (tenStart,) = vaultLens.burnWindows(tenDoor());
        assertEq(tenStart, opened + 12 hours, "door10's did not");
        assertApproxEqAbs(burnedIn(tenDoor()), 400e18, 2 * ROUNDING);
        assertApproxEqAbs(burnedIn(GLOBAL_WINDOW), 600e18, 2 * ROUNDING);
    }

    /// The floor is shared: one floor for all doors together, not one per door. In a 300 TAO vault 20% (60 TAO)
    /// and 30% (90) are both below the 100 TAO floor, so each door's allowance and the global one are 100 TAO:
    /// alice's 100 through Base spends the global window, and bob's request through chain 10 is deferred.
    function test_theFloorIsSharedByAllDoors() public {
        fund(150e18, 150e18);
        assertApproxEqAbs(redeemAll(BASE, frontDoor, alice), 100e18, ROUNDING, "alice: the floor, not 60");
        assertEq(redeemAll(OPTIMISM, door10, bob), 0, "the global window's floor is spent: deferred");
        assertApproxEqAbs(burnedIn(GLOBAL_WINDOW), 100e18, ROUNDING);
    }

    // ---- origin by chain (spec §3.4, I-16, I-17) ----

    /// A door's first mint for an address of origin 0 sets its origin to the door's chain, and a later mint leaves
    /// it: alice's through Base, bob's through chain 10, and each door burns for its own chain's holder. A bounce is
    /// no mint: carol's deposit into an insolvent vault bounces (Insolvent) and leaves her origin 0.
    function test_firstDoorMintSetsOrigin() public {
        assertEq(vaultLens.redeemOrigin(alice), 0, "no origin before any deposit");
        bytes32 key = nextKey(BASE, frontDoor, entries1(alice, 10e18), noEntries());
        vm.expectEmit(address(vault));
        emit Deposited(key, alice, 10e18, 1e25);
        depositFrom(BASE, frontDoor, alice, 10e18);
        assertEq(vaultLens.redeemOrigin(alice), BASE, "Base's first mint: origin Base");

        depositFrom(OPTIMISM, door10, bob, 10e18);
        assertEq(vault.balanceOf(bob), 1e25);
        assertEq(vaultLens.redeemOrigin(bob), OPTIMISM, "chain 10's first mint: origin 10");

        depositFrom(BASE, frontDoor, alice, 5e18);
        assertEq(vault.balanceOf(alice), 15e24, "a later mint from the same chain");
        assertEq(vaultLens.redeemOrigin(alice), BASE, "leaves the origin as it was");
        expectBurned(BASE, frontDoor, alice, 5e24);
        expectBurned(OPTIMISM, door10, bob, 5e24);

        // lost assets (a gross of 0 against the supply): the vault is insolvent
        vm.deal(address(vault), 0);
        key = nextKey(BASE, frontDoor, entries1(carol, 1e18), noEntries());
        vm.expectEmit(address(vault));
        emit DepositBounced(key, carol, 1e18, BounceReason.Insolvent);
        depositFrom(BASE, frontDoor, carol, 1e18);
        assertEq(vault.balanceOf(carol), 0);
        assertEq(vaultLens.redeemOrigin(carol), 0, "a bounce sets no origin");
    }

    /// M-4: a door deposit for an address whose origin is another chain bounces (DepositBounced, ForeignOrigin):
    /// nothing minted, the origin unchanged, the TAO queued back to that door as an entry with 0 shares. The rest of
    /// the batch delivers: carol, of origin 0, mints and takes chain 10.
    function test_foreignOriginBounces() public {
        depositFrom(BASE, frontDoor, alice, 10e18);
        CascadeMessages.Entry[] memory d = new CascadeMessages.Entry[](2);
        d[0] = CascadeMessages.Entry(alice, 5e18);
        d[1] = CascadeMessages.Entry(carol, 2e18);
        bytes32 key = nextKey(OPTIMISM, door10, d, noEntries());
        vm.expectEmit(address(vault));
        emit DepositBounced(key, alice, 5e18, BounceReason.ForeignOrigin);
        vm.expectEmit(address(vault));
        emit Deposited(key, carol, 2e18, 2e24);
        deliver(OPTIMISM, door10, ++nextBatchId, d, noEntries());

        assertEq(vault.balanceOf(alice), 1e25, "nothing minted for alice");
        assertEq(vaultLens.redeemOrigin(alice), BASE, "her origin unchanged");
        assertEq(vault.balanceOf(carol), 2e24);
        assertEq(vaultLens.redeemOrigin(carol), OPTIMISM);
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        assertEq(b.sourceChain, OPTIMISM, "queued back to chain 10");
        assertEq(b.frontDoor, door10, "to the door that sent it");
        assertEq(b.count, 1);
        assertEq(b.remaining, 5e18);
        assertEq(b.payoutsHash, CascadePayoutMath.hashStep(bytes32(0), alice, 0, 5e18), "one entry, 0 shares");
        assertEq(vaultLens.pendingPayouts(), 5e18, "its TAO reserved");
    }

    /// A deposit that is both into an insolvent vault and for another chain's address bounces as Insolvent: the
    /// vault-wide reason is checked first, reading no origin.
    function test_insolventAndForeignBouncesInsolvent() public {
        depositFrom(BASE, frontDoor, alice, 10e18);
        vm.deal(address(vault), 0);
        bytes32 key = nextKey(OPTIMISM, door10, entries1(alice, 1e18), noEntries());
        vm.expectEmit(address(vault));
        emit DepositBounced(key, alice, 1e18, BounceReason.Insolvent);
        depositFrom(OPTIMISM, door10, alice, 1e18);
        assertEq(vaultLens.redeemOrigin(alice), BASE);
    }

    /// A deposit of nothing (0, or less than a rao, which floors to 0) mints nothing and writes no origin: a door's
    /// claim on an address takes a deposit. A rao and more does.
    function test_aZeroDepositWritesNoOrigin() public {
        bytes32 key = nextKey(OPTIMISM, door10, entries1(carol, 0), noEntries());
        vm.expectEmit(address(vault));
        emit Deposited(key, carol, 0, 0);
        depositFrom(OPTIMISM, door10, carol, 0);
        depositFrom(OPTIMISM, door10, carol, 1e9 - 1);
        assertEq(vault.balanceOf(carol), 0);
        assertEq(vaultLens.redeemOrigin(carol), 0, "no origin for a deposit of nothing");
        depositFrom(BASE, frontDoor, carol, 1e9);
        assertGt(vault.balanceOf(carol), 0);
        assertEq(vaultLens.redeemOrigin(carol), BASE, "a rao's deposit takes the origin");
    }

    /// I-17: a direct depositor's shares are never burned by a door unless the holder set that chain afterwards.
    /// alice's direct deposit sets DIRECT_ORIGIN; a deposit for her from either door mints (her address already
    /// belongs here, so the shares go to no one else) and leaves DIRECT_ORIGIN; neither door burns for her. Once she
    /// sets Base, Base's door burns for her and chain 10's still does not.
    function test_directOriginMintsAndIsNeverBurnedByADoor() public {
        depositDirect(alice, 10e18);
        assertEq(vaultLens.redeemOrigin(alice), DIRECT_ORIGIN, "a direct deposit: DIRECT_ORIGIN");

        bytes32 key = nextKey(BASE, frontDoor, entries1(alice, 10e18), noEntries());
        vm.expectEmit(address(vault));
        emit Deposited(key, alice, 10e18, 1e25);
        depositFrom(BASE, frontDoor, alice, 10e18);
        depositFrom(OPTIMISM, door10, alice, 10e18);
        assertEq(vault.balanceOf(alice), 3e25, "both doors' deposits minted");
        assertEq(vaultLens.redeemOrigin(alice), DIRECT_ORIGIN, "and left DIRECT_ORIGIN");

        expectSkipped(BASE, frontDoor, alice, 1e25);
        expectSkipped(OPTIMISM, door10, alice, 1e25);

        setOrigin(alice, BASE);
        expectBurned(BASE, frontDoor, alice, 1e25);
        expectSkipped(OPTIMISM, door10, alice, 1e25);
    }

    /// setRedeemOrigin: the holder names a chain with an active door, or DIRECT_ORIGIN (RedeemOriginSet); a chain
    /// with none (one never served, chain 0, or one whose only door was removed) reverts UnknownOrigin, and a
    /// removal leaves the origins already set. An address may set its origin before it holds shares.
    function test_setRedeemOriginWithAndWithoutADoor() public {
        vm.expectEmit(address(vault));
        emit RedeemOriginSet(alice, OPTIMISM);
        setOrigin(alice, OPTIMISM);
        assertEq(vaultLens.redeemOrigin(alice), OPTIMISM, "a chain with a door");
        vm.expectEmit(address(vault));
        emit RedeemOriginSet(alice, BASE);
        setOrigin(alice, BASE);
        assertEq(vaultLens.redeemOrigin(alice), BASE);
        vm.expectEmit(address(vault));
        emit RedeemOriginSet(alice, DIRECT_ORIGIN);
        setOrigin(alice, DIRECT_ORIGIN);
        assertEq(vaultLens.redeemOrigin(alice), DIRECT_ORIGIN, "DIRECT_ORIGIN, always");

        vm.startPrank(alice);
        vm.expectRevert(UnknownOrigin.selector);
        vault.setRedeemOrigin(POLYGON);
        vm.expectRevert(UnknownOrigin.selector);
        vault.setRedeemOrigin(BITTENSOR);
        vm.expectRevert(UnknownOrigin.selector);
        vault.setRedeemOrigin(0);
        vm.stopPrank();
        assertEq(vaultLens.redeemOrigin(alice), DIRECT_ORIGIN, "a refusal changes nothing");

        // chain 10's only door removed: no origin can be set there now, and bob's stays
        setOrigin(bob, OPTIMISM);
        vm.prank(guardian);
        vault.removeFrontDoor(OPTIMISM, door10);
        assertEq(vaultLens.activeDoors(OPTIMISM), 0);
        vm.prank(alice);
        vm.expectRevert(UnknownOrigin.selector);
        vault.setRedeemOrigin(OPTIMISM);
        assertEq(vaultLens.redeemOrigin(bob), OPTIMISM, "a removal leaves the origins set");
        // the door activated again serves bob as before
        registerFrontDoor(OPTIMISM, door10);
        depositFrom(OPTIMISM, door10, bob, 10e18);
        expectBurned(OPTIMISM, door10, bob, 5e24);
    }

    /// setRedeemOrigin works while the vault is paused (ruling Q2): it moves nothing, it is the holder's own
    /// routing, and deliveries revert while paused anyway. Both a chain with a door and DIRECT_ORIGIN are written
    /// and logged, and a chain without a door is still refused.
    function test_setRedeemOriginWorksWhilePaused() public {
        vm.prank(guardian);
        vault.pause();
        assertTrue(vault.paused());
        vm.expectEmit(address(vault));
        emit RedeemOriginSet(alice, OPTIMISM);
        setOrigin(alice, OPTIMISM);
        assertEq(vaultLens.redeemOrigin(alice), OPTIMISM, "written while paused");
        vm.expectEmit(address(vault));
        emit RedeemOriginSet(treasury, DIRECT_ORIGIN);
        setOrigin(treasury, DIRECT_ORIGIN);
        assertEq(vaultLens.redeemOrigin(treasury), DIRECT_ORIGIN);
        vm.prank(alice);
        vm.expectRevert(UnknownOrigin.selector);
        vault.setRedeemOrigin(POLYGON);
    }

    /// No front door is ever on chain DIRECT_ORIGIN, which it would read as its own chain's holders and so burn a
    /// direct depositor's shares (I-17): its activation is refused at schedule, and so is a launch door there.
    function test_noFrontDoorOnTheDirectOrigin() public {
        vm.prank(owner);
        vm.expectRevert(InvalidParameter.selector);
        vault.schedule(abi.encodeCall(CascadeVault.activateFrontDoor, (DIRECT_ORIGIN, makeAddr("door"))));
        CascadeVault.Params memory p = vaultParams();
        p.launchChain = DIRECT_ORIGIN;
        vm.expectRevert(InvalidParameter.selector);
        new CascadeVault(p);
    }

    /// The DIRECT_ORIGIN flip, both ways. alice's direct deposit: Base skips her; she sets Base: Base burns; her next
    /// direct deposit sets DIRECT_ORIGIN again: Base skips her again. bob, of origin Base, sets DIRECT_ORIGIN: Base
    /// skips him, and a later Base deposit mints for him and leaves DIRECT_ORIGIN.
    function test_directOriginFlip() public {
        depositDirect(alice, 10e18);
        expectSkipped(BASE, frontDoor, alice, 1e24);
        setOrigin(alice, BASE);
        expectBurned(BASE, frontDoor, alice, 1e24);
        depositDirect(alice, 1e15);
        assertEq(vaultLens.redeemOrigin(alice), DIRECT_ORIGIN, "every direct deposit sets DIRECT_ORIGIN");
        expectSkipped(BASE, frontDoor, alice, 1e24);

        depositFrom(BASE, frontDoor, bob, 10e18);
        expectBurned(BASE, frontDoor, bob, 1e24);
        setOrigin(bob, DIRECT_ORIGIN);
        expectSkipped(BASE, frontDoor, bob, 1e24);
        uint256 held = vault.balanceOf(bob);
        depositFrom(BASE, frontDoor, bob, 1e18);
        assertGt(vault.balanceOf(bob), held, "a Base deposit mints for him");
        assertEq(vaultLens.redeemOrigin(bob), DIRECT_ORIGIN, "and leaves DIRECT_ORIGIN");
    }

    /// A second door on the same chain burns for the first door's depositors (origin is by chain, not by door), and
    /// still does once the first is removed: a door replacement on the same chain strands nobody.
    function test_secondBaseDoorBurnsForTheFirstsDepositors() public {
        address door2 = makeAddr("door2");
        depositFrom(BASE, frontDoor, alice, 10e18);
        registerFrontDoor(BASE, door2);
        assertEq(vaultLens.activeDoors(BASE), 2);
        expectBurned(BASE, door2, alice, 2e24);

        vm.prank(owner);
        vault.removeFrontDoor(BASE, frontDoor);
        assertEq(vaultLens.redeemOrigin(alice), BASE);
        expectBurned(BASE, door2, alice, 2e24);
        depositFrom(BASE, door2, alice, 1e18);
        assertEq(vaultLens.redeemOrigin(alice), BASE, "the new door's deposit leaves it");
    }

    /// Neither the reward cut nor a cancel's re-mint touches an origin. The cut mints to the treasury at origin 0 and
    /// leaves it 0, and, once the treasury set chain 10, leaves chain 10. alice's Base redeem is burned and queued; she
    /// then sets chain 10; the owner's cancel re-mints her shares and leaves her origin at chain 10, not the batch's
    /// Base.
    function test_cutAndCancelLeaveOriginsAlone() public {
        fund(100e18, 100e18);
        claimWithCut(10e9);
        uint256 cut = vault.balanceOf(treasury);
        assertGt(cut, 0, "the cut minted");
        assertEq(vaultLens.redeemOrigin(treasury), 0, "the cut sets no origin");
        setOrigin(treasury, OPTIMISM);
        claimWithCut(10e9);
        assertGt(vault.balanceOf(treasury), cut, "a second cut minted");
        assertEq(vaultLens.redeemOrigin(treasury), OPTIMISM, "the cut changes no origin");

        uint256 held = vault.balanceOf(alice);
        (bytes32 key, CascadeMessages.Payout[] memory list) = expectBurned(BASE, frontDoor, alice, held / 2);
        setOrigin(alice, OPTIMISM);
        vm.prank(owner);
        vault.cancelPayoutBatch(key, list);
        assertEq(vault.balanceOf(alice), held, "re-minted");
        assertEq(vaultLens.redeemOrigin(alice), OPTIMISM, "the re-mint changes no origin");
    }

    /// An address whose only shares came from the cut has origin 0: no door burns for it until it sets an origin
    /// (the treasury runbook: setRedeemOrigin, or redeemDirect), and then only that chain's.
    function test_originZeroCutHolderSkippedUntilItSetsOrigin() public {
        fund(100e18, 100e18);
        claimWithCut(10e9);
        uint256 cut = vault.balanceOf(treasury);
        assertGt(cut, 0);
        expectSkipped(BASE, frontDoor, treasury, cut);
        expectSkipped(OPTIMISM, door10, treasury, cut);

        setOrigin(treasury, BASE);
        expectSkipped(OPTIMISM, door10, treasury, cut / 2);
        expectBurned(BASE, frontDoor, treasury, cut / 2);
    }

    /// Review Focus 4: a Base redeem for a holder whose origin is elsewhere is skipped (RedeemSkipped): nothing
    /// burned, no payout; its request fee was spent for nothing. alice deposited directly (DIRECT_ORIGIN), bob
    /// through chain 10; carol, of origin Base, in the same batch burns, so the skip is per entry.
    function test_baseRedeemForADirectOriginHolderIsSkipped() public {
        depositDirect(alice, 10e18);
        depositFrom(OPTIMISM, door10, bob, 10e18);
        depositFrom(BASE, frontDoor, carol, 10e18);
        uint256 supply = vault.totalSupply();

        CascadeMessages.Entry[] memory r = new CascadeMessages.Entry[](3);
        r[0] = CascadeMessages.Entry(alice, 5e24);
        r[1] = CascadeMessages.Entry(bob, 5e24);
        r[2] = CascadeMessages.Entry(carol, 5e24);
        bytes32 key = nextKey(BASE, frontDoor, noEntries(), r);
        vm.expectEmit(address(vault));
        emit RedeemSkipped(key, alice, 5e24);
        vm.expectEmit(address(vault));
        emit RedeemSkipped(key, bob, 5e24);
        vm.expectEmit(address(vault));
        emit Redeemed(key, carol, 5e24, 5e18);
        deliver(BASE, frontDoor, ++nextBatchId, noEntries(), r);

        assertEq(vault.balanceOf(alice), 1e25, "alice: nothing burned");
        assertEq(vault.balanceOf(bob), 1e25, "bob: nothing burned");
        assertEq(vault.totalSupply(), supply - 5e24, "carol's burn only");
        PayoutBatch memory b = vaultLens.getPayoutBatch(key);
        assertEq(b.count, 1, "carol's payout only");
        assertEq(b.remaining, 5e18);
        assertEq(b.payoutsHash, CascadePayoutMath.hashStep(bytes32(0), carol, 5e24, 5e18));
        assertEq(vaultLens.pendingPayouts(), 5e18);
        // alone in its batch, alice's request queues nothing at all
        expectSkipped(BASE, frontDoor, alice, 5e24);
    }

    // ---- I-15 at unit level ----

    /// A window as the vault keeps it (Window, CascadeTypes.sol), rebuilt here from the Redeemed events.
    struct Ghost {
        uint64 start;
        uint256 burned;
    }

    /// What a door's redeem of `asked` (in TAO, by a holder whose whole balance is worth `held`) burns against `room`,
    /// the tighter of its two windows: `asked`, or the room when the room clips it; but when the clip would leave the
    /// holder under MIN_REDEEM_VALUE, S-L1's keep (CascadeBatchLib) burns its balance less MIN_REDEEM_VALUE instead
    /// (the review of Revision 27, M-6). Within ROUNDING of the keep's line (the clip's edge, or the keep's), the
    /// vault's share rounding decides which: `want` or `alt`; else both are the one expected burn.
    function expectedBurn(uint256 asked, uint256 held, uint256 room) internal pure returns (uint256 want, uint256 alt) {
        uint256 clipped = Math.min(asked, room);
        uint256 kept = held > MIN_REDEEM_VALUE ? held - MIN_REDEEM_VALUE : 0;
        bool mayKeep = asked + ROUNDING > room && held < room + MIN_REDEEM_VALUE + ROUNDING;
        bool mustKeep = asked > room + ROUNDING && held + ROUNDING < room + MIN_REDEEM_VALUE;
        if (mustKeep) return (kept, kept);
        if (mayKeep) return (clipped, kept);
        return (clipped, clipped);
    }

    /// Whether a burn of `out` is the expected `want`: deferred (0) below the minimum, within ROUNDING of it above;
    /// at the minimum's own edge, either.
    function burnMatches(uint256 out, uint256 want) internal pure returns (bool) {
        if (want + ROUNDING < MIN_REDEEM_VALUE) return out == 0;
        if (want > MIN_REDEEM_VALUE + ROUNDING) return out + ROUNDING >= want && out <= want + ROUNDING;
        return true;
    }

    /// What `user`'s whole balance is worth now.
    function heldBy(address user) internal view returns (uint256) {
        return CascadeMath.assetsForRedeem(vault.balanceOf(user), vaultLens.totalAssets(), vault.totalSupply());
    }

    /// A burn of `out` is one of expectedBurn's answers; else it fails, against `want`.
    function assertBurn(uint256 out, uint256 want, uint256 alt) internal pure {
        if (burnMatches(out, want) || burnMatches(out, alt)) return;
        assertEq(out, want, "all the room allows, less S-L1's keep where it applies");
    }

    /// What window `w` (allowance `cap`) still allows now: all of `cap` once 24 hours have passed since it opened.
    function rest(Ghost memory w, uint256 cap) internal view returns (uint256) {
        if (vm.getBlockTimestamp() >= w.start + 24 hours) return cap;
        return w.burned >= cap ? 0 : cap - w.burned;
    }

    /// Window `w` as of now: a fresh one (opening now, nothing burned) once 24 hours have passed since it opened, as
    /// the lens serves the vault's (R2 F4).
    function current(Ghost memory w) internal view returns (uint64, uint256) {
        if (vm.getBlockTimestamp() >= w.start + 24 hours) return (uint64(vm.getBlockTimestamp()), 0);
        return (w.start, w.burned);
    }

    /// Books a burn of `out` now in window `w`, opening it afresh first once 24 hours have passed since it opened.
    function book(Ghost memory w, uint256 out) internal view {
        if (vm.getBlockTimestamp() >= w.start + 24 hours) (w.start, w.burned) = (uint64(vm.getBlockTimestamp()), 0);
        w.burned += out;
    }

    /// The final forced run's counterexample to the I-15 fuzz test (Revision 27's review, M-6), pinned: bob's 100% redeem
    /// asks 52.2 TAO against door10's 52.2 TAO of room, and the earlier rao-floored burns have lifted the price so his
    /// balance is a hair above the room. The clip to the room would leave him under MIN_REDEEM_VALUE, so S-L1's keep
    /// (CascadeBatchLib) burns his balance less MIN_REDEEM_VALUE instead, 52.17 TAO; the test's model accepts that (the
    /// ask is within ROUNDING of the room, so the clip itself is on its edge: expectedBurn's two answers).
    function test_I15_aClipThatWouldLeaveUnderTheMinimumKeepsIt() public {
        uint256[10] memory steps = [
            uint256(27_064_142_633_305),
            3_175_624_634,
            2_191_165_145,
            65_536,
            245_000_000,
            22_083,
            1_499_000,
            691_199,
            718_984_099,
            3618
        ];
        testFuzz_I15_eachDoorWithinItsAllowanceAndAllWithinTheGlobal(
            108_000, 3915, 10_800, 14_759, 2_182_872_980, steps
        );
    }

    /// I-15 (spec §3.4): per window, each door's burns stay within its allowance and all doors' burns within the
    /// global allowance, under any limits the bounds allow, over redeems from both doors at random times. Each
    /// window opens at its first burn and again at the first burn a day or more after it opened; each allowance is
    /// its percentage of the base, at least the shared floor. And each redeem burns what the tighter of its two
    /// windows leaves it (or is deferred when that is below MIN_REDEEM_VALUE), so the bound is not met by burning
    /// less than allowed, except where S-L1's keep applies (CascadeBatchLib: a clip that would leave the holder under
    /// MIN_REDEEM_VALUE burns its balance less MIN_REDEEM_VALUE instead; the review of Revision 27, M-6), and within
    /// ROUNDING of the keep's line either burn is accepted (expectedBurn). The vault's own windows, as the lens serves
    /// them now, read the same as the ones rebuilt here.
    function testFuzz_I15_eachDoorWithinItsAllowanceAndAllWithinTheGlobal(
        uint256 bps,
        uint256 floor,
        uint256 globalBps,
        uint256 aliceTao,
        uint256 bobTao,
        uint256[10] memory steps
    ) public {
        bps = bound(bps, 2_000, 5_000);
        floor = bound(floor, 10e18, 100e18);
        globalBps = bound(globalBps, 2_000, 5_000);
        // any limits within the bounds, through the scheduler whichever way they move
        Schedule.run(vault, owner, abi.encodeCall(CascadeVault.setOutflowLimits, (bps, floor, globalBps)));
        // from 50 TAO (the floor binds) to 2,000 TAO (it never does)
        fund(bound(aliceTao, 25, 1_000) * 1e18, bound(bobTao, 25, 1_000) * 1e18);
        // all of it ramped in, nothing missing: the base is the booked stake
        uint256 base = vaultLens.bookedStake() * 1e9;
        assertEq(vaultLens.visibleStakeRao(), vaultLens.bookedStake());
        uint256 doorCap = Math.max(base * bps / 10_000, floor);
        uint256 globalCap = Math.max(base * globalBps / 10_000, floor);

        // 0: Base's window, 1: door10's, 2: the global one
        Ghost[3] memory w;
        bytes32[3] memory keys = [baseDoor(), tenDoor(), GLOBAL_WINDOW];
        for (uint256 i; i < steps.length; ++i) {
            uint256 d = steps[i] & 1;
            address user = d == 0 ? alice : bob;
            vm.warp(vm.getBlockTimestamp() + (steps[i] >> 8) % 16 hours);
            uint256 shares = vault.balanceOf(user) * ((steps[i] >> 1) % 100 + 1) / 100;
            if (shares == 0) continue;
            uint256 asked = CascadeMath.assetsForRedeem(shares, vaultLens.totalAssets(), vault.totalSupply());
            uint256 room = Math.min(rest(w[d], doorCap), rest(w[2], globalCap));
            // all the room allows (or deferred below the minimum), less S-L1's keep where it applies
            (uint256 want, uint256 alt) = expectedBurn(asked, heldBy(user), room);
            uint256 out = d == 0 ? redeem(BASE, frontDoor, user, shares) : redeem(OPTIMISM, door10, user, shares);
            assertBurn(out, want, alt);
            if (out != 0) {
                book(w[d], out);
                book(w[2], out);
            }
            assertLe(w[d].burned, doorCap, "I-15: a door's burns within its allowance");
            assertLe(w[2].burned, globalCap, "I-15: all doors' burns within the global allowance");
            for (uint256 k; k < 3; ++k) {
                (uint64 start, uint256 burned) = vaultLens.burnWindows(keys[k]);
                (uint64 ghostStart, uint256 ghostBurned) = current(w[k]);
                assertEq(start, ghostStart, "the vault's window opened when rebuilt");
                assertEq(burned, ghostBurned, "and burned what was rebuilt");
            }
        }
    }
}
