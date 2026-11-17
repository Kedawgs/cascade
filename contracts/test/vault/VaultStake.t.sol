// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeVaultLens} from "../../src/lens/CascadeVaultLens.sol";
import {ISTAKING_ADDRESS, IStaking} from "../../src/interfaces/IStaking.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {Schedule} from "../governance/Schedule.sol";
import {
    HotkeyHasRewards,
    HotkeyInUse,
    HotkeyKnown,
    NotEligible,
    NotKeeper,
    NotListed,
    NotScheduled,
    NothingToStake,
    SlotReserved,
    UnknownHotkey,
    UnstakeShort,
    ZeroAmount,
    ZeroHotkey
} from "../../src/CascadeErrors.sol";
import {
    HotkeyAdded,
    HotkeyRemoved,
    LimitSet,
    RedeemedDirect,
    ShortfallAbsorbed,
    StakeHotkeySet,
    StakeMoved,
    Staked,
    Unstaked
} from "../../src/CascadeEvents.sol";

contract VaultStakeTest is VaultTestBase {
    address stranger = makeAddr("stranger");

    function stakeOf(bytes32 h) internal view returns (uint256) {
        return staking.getStake(h, vaultLens.coldkey(), 0);
    }

    function keeperStakes() internal {
        vm.prank(keeper);
        vault.stakeIdle();
    }

    function redeem(address user, uint256 shares) internal {
        vm.prank(user);
        vault.redeemDirect(shares, false);
    }

    /// The owner's change `data` through the scheduler (Task 11: setStakeHotkey and moveStake are scheduled
    /// only, the Param class): scheduled, 48 hours warped, executed.
    function scheduled(bytes memory data) internal {
        Schedule.run(vault, owner, data);
    }

    function toStakeHotkey(bytes32 h) internal pure returns (bytes memory) {
        return abi.encodeCall(CascadeVault.setStakeHotkey, (h));
    }

    function move(bytes32 from, bytes32 to, uint256 rao) internal pure returns (bytes memory) {
        return abi.encodeCall(CascadeVault.moveStake, (from, to, rao));
    }

    /// The owner lists `h`, then its scheduled setStakeHotkey(h) runs (setStakeHotkey names a listed hotkey only,
    /// Task 14a).
    function switchTo(bytes32 h) internal {
        vm.prank(owner);
        vault.addHotkey(h);
        scheduled(toStakeHotkey(h));
    }

    /// alice's 10e18 staked on HK1 (fresh position, one rao short: 9_999_999_999), then HK2, listed, becomes the
    /// stake hotkey and 5_000_000_000 rao moves onto it (fresh again: HK2 4_999_999_999, HK1 4_999_999_999).
    /// Both changes are scheduled before the deposit and executed right after the stake, 48 hours on.
    function splitAcrossHk1AndHk2() internal {
        vm.startPrank(owner);
        vault.addHotkey(HK2);
        vault.schedule(toStakeHotkey(HK2));
        vault.schedule(move(HK1, HK2, 5_000_000_000));
        vm.stopPrank();
        Schedule.warpTo(vm.getBlockTimestamp() + 48 hours);
        depositDirect(alice, 10e18);
        keeperStakes();
        vm.startPrank(owner);
        vault.execute(toStakeHotkey(HK2));
        vault.execute(move(HK1, HK2, 5_000_000_000));
        vm.stopPrank();
    }

    // ---- stakeIdle ----

    function test_stakeIdleByKeeperStakesEverythingAboveReserve() public {
        depositDirect(alice, 10e18);

        // idle = (1e12 + 10e18) - 1e12 - 0 = 10e18 wei = 10_000_000_000 rao; a fresh position reads one rao short
        vm.expectEmit(address(vault));
        emit Staked(HK1, 10_000_000_000, 9_999_999_999);
        keeperStakes();

        assertEq(stakeOf(HK1), 9_999_999_999);
        assertEq(address(vault).balance, ED);
        // 9_999_999_999 * 1e9 + 1e12 - 1e12
        assertEq(vaultLens.grossAssets(), 10e18 - 1e9);
        assertEq(vaultLens.lastStakeAt(), vm.getBlockTimestamp());
    }

    function test_stakeIdleFallbackSeededAtDeploy() public {
        uint256 t0 = vm.getBlockTimestamp();
        CascadeVault v = freshVault();
        CascadeVaultLens vLens = new CascadeVaultLens(address(v));
        // idle TAO a stranger could otherwise stake at once
        vm.deal(address(v), ED + 10e18);

        vm.prank(stranger);
        vm.expectRevert(NotKeeper.selector);
        v.stakeIdle();
        Schedule.warpTo(t0 + 7 days - 1);
        vm.prank(stranger);
        vm.expectRevert(NotKeeper.selector);
        v.stakeIdle();
        assertEq(vLens.lastStakeAt(), t0);

        Schedule.warpTo(t0 + 7 days);
        vm.prank(stranger);
        v.stakeIdle();
        assertEq(vLens.lastStakeAt(), t0 + 7 days);
        assertEq(address(v).balance, ED);
    }

    function test_stakeIdleStrangerBeforeFallbackReverts() public {
        // The keeper stakes first, so the window counts from its stake rather than from the deploy seed
        // (test_stakeIdleFallbackSeededAtDeploy covers that one).
        depositDirect(alice, 10e18);
        keeperStakes();
        uint256 t0 = vm.getBlockTimestamp();
        depositDirect(bob, 1e18);

        vm.prank(stranger);
        vm.expectRevert(NotKeeper.selector);
        vault.stakeIdle();

        Schedule.warpTo(t0 + 7 days - 1);
        vm.prank(stranger);
        vm.expectRevert(NotKeeper.selector);
        vault.stakeIdle();

        // bob's 1e18 = 1_000_000_000 rao onto the existing HK1 position (no short)
        Schedule.warpTo(t0 + 7 days);
        vm.expectEmit(address(vault));
        emit Staked(HK1, 1_000_000_000, 1_000_000_000);
        vm.prank(stranger);
        vault.stakeIdle();
        // 9_999_999_999 + 1_000_000_000
        assertEq(stakeOf(HK1), 10_999_999_999);
        assertEq(vaultLens.lastStakeAt(), t0 + 7 days);
    }

    /// Task 16 review (trim 1, the shared keeper-fallback check): the stake, adoption and claim fallbacks
    /// each count KEEPER_FALLBACK from their own timer, never from another's, and opening one moves no other.
    function test_eachFallbackReadsItsOwnTimer() public {
        uint256 d = deployedAt;
        assertEq(vaultLens.lastClaimAt(HK1), d);
        depositDirect(alice, 10e18);
        // lastAdoptAt = d + 1 day
        vm.warp(d + 1 days);
        staking.donateStake(HK1, vaultLens.coldkey(), 5e9);
        vm.prank(keeper);
        vault.adoptStake();
        assertEq(vaultLens.lastAdoptAt(), d + 1 days);
        // lastStakeAt = d + 2 days
        vm.warp(d + 2 days);
        vm.prank(keeper);
        vault.stakeIdle();
        assertEq(vaultLens.lastStakeAt(), d + 2 days);
        depositDirect(bob, 1e18);
        staking.donateStake(HK1, vaultLens.coldkey(), 5e9);

        // d + 7 days: only the claim's timer (d) has run out
        vm.warp(d + 7 days);
        vm.prank(stranger);
        vm.expectRevert(NotKeeper.selector);
        vault.adoptStake();
        vm.prank(stranger);
        vm.expectRevert(NotKeeper.selector);
        vault.stakeIdle();
        vm.prank(stranger);
        vault.claimRewards(HK1);
        assertEq(vaultLens.lastClaimAt(HK1), d + 7 days);

        // d + 8 days: the adoption's (d + 1 day) too, not the stake's (d + 2 days), nor the claim's (now d + 7)
        vm.warp(d + 8 days);
        vm.prank(stranger);
        vm.expectRevert(NotKeeper.selector);
        vault.stakeIdle();
        vm.prank(stranger);
        vm.expectRevert(NotKeeper.selector);
        vault.claimRewards(HK1);
        vm.prank(stranger);
        vault.adoptStake();
        assertEq(vaultLens.lastAdoptAt(), d + 8 days);

        // d + 9 days - 1: still not the stake's; d + 9 days: it is
        vm.warp(d + 9 days - 1);
        vm.prank(stranger);
        vm.expectRevert(NotKeeper.selector);
        vault.stakeIdle();
        vm.warp(d + 9 days);
        vm.prank(stranger);
        vault.stakeIdle();
        assertEq(vaultLens.lastStakeAt(), d + 9 days);
        // the adoption's and the claim's timers did not move with it
        assertEq(vaultLens.lastAdoptAt(), d + 8 days);
        assertEq(vaultLens.lastClaimAt(HK1), d + 7 days);
    }

    function test_stakeIdleBelowMinReverts() public {
        // 1e15 wei = 1_000_000 rao < 2_000_000
        depositDirect(alice, 1e15);
        vm.prank(keeper);
        vm.expectRevert(NothingToStake.selector);
        vault.stakeIdle();
        assertEq(address(vault).balance, ED + 1e15);
    }

    function test_stakeIdleWhilePausedReverts() public {
        depositDirect(alice, 10e18);
        vm.prank(guardian);
        vault.pause();

        vm.prank(keeper);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.stakeIdle();
        assertEq(stakeOf(HK1), 0);
    }

    function test_priceToleratesOneRaoShort() public {
        depositDirect(alice, 10e18);
        keeperStakes();

        assertEq(vaultLens.totalAssets(), 10e18 - 1e9);
        // (10e18 - 1e9 + 1) * 1e18 / (1e25 + 1e6) = (1e19 - 1e9 + 1) * 1e12 / (1e19 + 1)
        // = (1e31 - 1e21 + 1e12) / (1e19 + 1); (1e12 - 100) * (1e19 + 1) = 1e31 - 1e21 + 1e12 - 100,
        // so the floor is 1e12 - 100 with remainder 100
        assertEq(vaultLens.price(), 999_999_999_900);
    }

    // ---- floors ----

    function test_floorsReadLive() public {
        assertEq(vaultLens.minStakeRao(), 2_000_000);
        assertEq(vaultLens.minRemainRao(), 20_000_000);

        staking.setMinStake(2_500_000);
        assertEq(vaultLens.minStakeRao(), 2_500_000);
        staking.setNominatorMin(25_000_000);
        assertEq(vaultLens.minRemainRao(), 25_000_000);
    }

    /// The fallbacks are constants since Task 23 (2_000_000 / 20_000_000 rao, test_floorFallbacksAreConstants).
    function test_floorsAreTheLargerOfLiveAndFallback() public {
        // live lowered below the fallbacks
        staking.setMinStake(1_000_000);
        staking.setNominatorMin(10_000_000);
        assertEq(vaultLens.minStakeRao(), 2_000_000);
        assertEq(vaultLens.minRemainRao(), 20_000_000);

        // live raised above the fallbacks
        staking.setMinStake(4_000_000);
        staking.setNominatorMin(40_000_000);
        assertEq(vaultLens.minStakeRao(), 4_000_000);
        assertEq(vaultLens.minRemainRao(), 40_000_000);
    }

    function test_floorsFallBackWhenReadReverts() public {
        // live reads differ from the fallbacks, so the fallback is visible
        staking.setMinStake(2_500_000);
        staking.setNominatorMin(25_000_000);

        vm.mockCallRevert(ISTAKING_ADDRESS, abi.encodeWithSelector(IStaking.getDefaultMinStake.selector), "");
        assertEq(vaultLens.minStakeRao(), 2_000_000);
        assertEq(vaultLens.minRemainRao(), 25_000_000);

        vm.mockCallRevert(ISTAKING_ADDRESS, abi.encodeWithSelector(IStaking.getNominatorMinRequiredStake.selector), "");
        assertEq(vaultLens.minRemainRao(), 20_000_000);
    }

    // ---- hotkey set ----

    /// The owner lists any hotkey into the first three slots; the fourth, the last, is reserved for a swap's
    /// hotkey while stake is missing (SlotReserved; Task 14a, VaultHotkeys.t.sol); a stranger may list only while
    /// stake is missing (NotEligible). A listed hotkey and the zero hotkey are refused.
    function test_addHotkeyRules() public {
        vm.prank(stranger);
        vm.expectRevert(NotEligible.selector);
        vault.addHotkey(HK2);

        vm.startPrank(owner);
        vm.expectEmit(address(vault));
        emit HotkeyAdded(HK2);
        vault.addHotkey(HK2);
        vault.addHotkey(HK3);
        assertEq(vaultLens.hotkeyCount(), 3);
        assertEq(vaultLens.hotkeys(2), HK3);
        assertTrue(vaultLens.isHotkey(HK3));

        vm.expectRevert(SlotReserved.selector);
        vault.addHotkey(HK4);
        vm.expectRevert(HotkeyKnown.selector);
        vault.addHotkey(HK2);
        vm.expectRevert(ZeroHotkey.selector);
        vault.addHotkey(bytes32(0));
        vm.stopPrank();

        assertEq(vaultLens.hotkeyCount(), 3);
        assertFalse(vaultLens.isHotkey(HK4));
        assertEq(vaultLens.stakeHotkey(), HK1);
    }

    function test_addHotkeyByKeeperOrGuardian() public {
        // a validator's hotkey swap is fixed by re-adding the new hotkey fast: the keeper or guardian may
        vm.expectEmit(address(vault));
        emit HotkeyAdded(HK2);
        vm.prank(keeper);
        vault.addHotkey(HK2);
        vm.expectEmit(address(vault));
        emit HotkeyAdded(HK3);
        vm.prank(guardian);
        vault.addHotkey(HK3);
        assertEq(vaultLens.hotkeyCount(), 3);
        assertTrue(vaultLens.isHotkey(HK2));
        assertTrue(vaultLens.isHotkey(HK3));
        // adding never routes new stake
        assertEq(vaultLens.stakeHotkey(), HK1);

        // the last slot is reserved, and a listed hotkey refused, for them too
        vm.prank(keeper);
        vm.expectRevert(SlotReserved.selector);
        vault.addHotkey(HK4);
        vm.prank(guardian);
        vm.expectRevert(SlotReserved.selector);
        vault.addHotkey(HK5);
        vm.prank(keeper);
        vm.expectRevert(HotkeyKnown.selector);
        vault.addHotkey(HK2);

        // setStakeHotkey stays the owner's (Task 14a), and moveStake runs only as a scheduled item (Task 11); the
        // keeper's and the guardian's removals are VaultHotkeys.t.sol's
        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        vault.setStakeHotkey(HK2);
        vm.expectRevert(NotScheduled.selector);
        vault.moveStake(HK2, HK1, 1);
        vm.stopPrank();
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        vault.setStakeHotkey(HK2);
    }

    /// setStakeHotkey names a listed hotkey (NotListed otherwise, directly and at execute; spec §3.10.3) and is
    /// the owner's; to a hotkey holding nothing it is scheduled (Task 11; the immediate case is VaultHotkeys.t.sol's).
    function test_setStakeHotkeySwitchesToAListedHotkey() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vault.setStakeHotkey(HK2);
        vm.prank(owner);
        vm.expectRevert(NotListed.selector);
        vault.setStakeHotkey(HK2);

        vm.startPrank(owner);
        vault.addHotkey(HK2);
        vm.expectRevert(NotScheduled.selector);
        vault.setStakeHotkey(HK2);
        vault.schedule(toStakeHotkey(HK2));
        vault.schedule(toStakeHotkey(bytes32(0)));
        vm.stopPrank();
        Schedule.warpTo(vm.getBlockTimestamp() + 48 hours);
        vm.recordLogs();
        vm.prank(owner);
        vault.execute(toStakeHotkey(HK2));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2, "StakeHotkeySet, then Executed: no HotkeyAdded");
        assertEq(logs[0].topics[0], StakeHotkeySet.selector);
        assertEq(logs[0].topics[1], HK2);

        assertTrue(vaultLens.isHotkey(HK2));
        assertEq(vaultLens.stakeHotkey(), HK2);
        assertEq(vaultLens.hotkeyCount(), 2);

        // switching back to a listed hotkey
        scheduled(toStakeHotkey(HK1));
        assertEq(vaultLens.stakeHotkey(), HK1);
        assertEq(vaultLens.hotkeyCount(), 2);

        // the zero hotkey: refused by the setter at execute (the item kept)
        vm.prank(owner);
        vm.expectRevert(NotListed.selector);
        vault.execute(toStakeHotkey(bytes32(0)));
    }

    function test_moveStakeMeasuresBothSides() public {
        depositDirect(alice, 10e18);
        keeperStakes();
        assertEq(stakeOf(HK1), 9_999_999_999);
        switchTo(HK2);
        vm.prank(owner);
        vault.schedule(move(HK1, HK2, 5_000_000_000));
        Schedule.warpTo(vm.getBlockTimestamp() + 48 hours);

        // HK2 is an empty position, so the credit lands one rao short: 5_000_000_000 - 1
        vm.expectEmit(address(vault));
        emit StakeMoved(HK1, HK2, 5_000_000_000, 4_999_999_999);
        vm.prank(owner);
        vault.execute(move(HK1, HK2, 5_000_000_000));

        // 9_999_999_999 - 5_000_000_000
        assertEq(stakeOf(HK1), 4_999_999_999);
        assertEq(stakeOf(HK2), 4_999_999_999);
        // 4_999_999_999 + 4_999_999_999
        assertEq(vaultLens.visibleStakeRao(), 9_999_999_998);
    }

    /// moveStake is scheduled only (Task 11): a direct call is NotScheduled; scheduled, a move from the stake
    /// hotkey or an unknown one is refused at execute (the item kept).
    function test_moveStakeFromStakeHotkeyReverts() public {
        depositDirect(alice, 10e18);
        keeperStakes();

        vm.prank(stranger);
        vm.expectRevert(NotScheduled.selector);
        vault.moveStake(HK1, HK1, 5_000_000_000);

        vm.startPrank(owner);
        vm.expectRevert(NotScheduled.selector);
        vault.moveStake(HK1, HK1, 5_000_000_000);
        vault.schedule(move(HK1, HK1, 5_000_000_000));
        vault.schedule(move(HK3, HK1, 5_000_000_000));
        Schedule.warpTo(vm.getBlockTimestamp() + 48 hours);
        vm.expectRevert(HotkeyInUse.selector);
        vault.execute(move(HK1, HK1, 5_000_000_000));
        vm.expectRevert(UnknownHotkey.selector);
        vault.execute(move(HK3, HK1, 5_000_000_000));
        vm.stopPrank();

        assertEq(stakeOf(HK1), 9_999_999_999);
    }

    /// R1-A L-2 (ported from R1A_MoveStakeGrief): a scheduled moveStake carries an amount fixed 48 hours
    /// before it can run, while any holder's redeemDirect walks the stake hotkey first and then the other
    /// listed hotkeys. After a stake-hotkey swap the new stake hotkey is empty, so one redeem draws on `from`;
    /// the item still runs, moving what is there (moving less is a tightening), instead of reverting for its
    /// whole window.
    function test_aScheduledMoveStakeMovesWhatIsThereUpToItsAmount() public {
        depositDirect(alice, 1_000e18);
        keeperStakes();
        uint256 all = stakeOf(HK1);
        assertGt(all, 0);

        // the owner moves the vault to a new validator: HK2 becomes the stake hotkey, then the stake follows
        switchTo(HK2);
        vm.prank(owner);
        vault.schedule(move(HK1, HK2, all));

        // inside the 48 hours a holder redeems: HK2 holds nothing, so the walk takes it from HK1
        Schedule.warpTo(vm.getBlockTimestamp() + 1 hours);
        uint256 shares = vault.balanceOf(alice) / 1_000;
        vm.prank(alice);
        vault.redeemDirect(shares, false);
        uint256 left = stakeOf(HK1);
        assertLt(left, all, "the walk took from the moveStake's position");

        // the item runs and moves what is left (HK2, an empty position, is credited one rao short)
        Schedule.warpTo(vm.getBlockTimestamp() + 47 hours);
        vm.expectEmit(address(vault));
        emit StakeMoved(HK1, HK2, left, left - 1);
        vm.prank(owner);
        vault.execute(move(HK1, HK2, all));
        assertEq(stakeOf(HK1), 0);
        assertEq(stakeOf(HK2), left - 1);
    }

    /// The clamp only lowers: an item below the position moves exactly its amount; and an item whose position
    /// is empty at execute runs as a no-op (no precompile call, no StakeMoved), the item consumed.
    function test_aScheduledMoveStakeNeverMovesMoreThanItsAmount() public {
        depositDirect(alice, 10e18);
        keeperStakes();
        switchTo(HK2);
        vm.startPrank(owner);
        vault.schedule(move(HK1, HK2, 4_000_000_000));
        vault.schedule(move(HK1, HK2, 9_000_000_000));
        vm.stopPrank();
        Schedule.warpTo(vm.getBlockTimestamp() + 48 hours);

        vm.prank(owner);
        vault.execute(move(HK1, HK2, 4_000_000_000));
        assertEq(stakeOf(HK1), 5_999_999_999, "exactly its amount");

        // the rest moves by the second item, clamped to the 5_999_999_999 there
        vm.prank(owner);
        vault.execute(move(HK1, HK2, 9_000_000_000));
        assertEq(stakeOf(HK1), 0);

        // an empty position: the item runs and moves nothing
        vm.prank(owner);
        vault.schedule(move(HK1, HK2, 1_000_000_000));
        Schedule.warpTo(vm.getBlockTimestamp() + 48 hours);
        uint256 hk2 = stakeOf(HK2);
        vm.recordLogs();
        vm.prank(owner);
        vault.execute(move(HK1, HK2, 1_000_000_000));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != StakeMoved.selector, "nothing moved, no StakeMoved");
        }
        assertEq(stakeOf(HK2), hk2);
        assertEq(vaultLens.scheduled(keccak256(move(HK1, HK2, 1_000_000_000))).readyAt, 0, "the item ran");
    }

    function test_removeHotkeyMovesLeftoverAboveMin() public {
        splitAcrossHk1AndHk2();

        // leftover 4_999_999_999 >= 2_000_000 moves onto the non-empty HK2 position (no short)
        vm.expectEmit(address(vault));
        emit StakeMoved(HK1, HK2, 4_999_999_999, 4_999_999_999);
        vm.expectEmit(address(vault));
        emit HotkeyRemoved(HK1, 0, false);
        vm.prank(owner);
        vault.removeHotkey(HK1, false);

        assertEq(stakeOf(HK1), 0);
        // 4_999_999_999 + 4_999_999_999
        assertEq(stakeOf(HK2), 9_999_999_998);
        assertEq(vaultLens.hotkeyCount(), 1);
        assertEq(vaultLens.hotkeys(0), HK2);
        assertFalse(vaultLens.isHotkey(HK1));
        assertEq(vaultLens.visibleStakeRao(), 9_999_999_998);
    }

    function test_removeHotkeyFullExitsLeftoverBelowMin() public {
        switchTo(HK2);
        staking.donateStake(HK1, vaultLens.coldkey(), 1_500_000);

        // 1_500_000 < 2_000_000: a full exit, 1_500_000 * 1e9 = 1.5e15 wei becomes idle balance
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStakeFull, (HK1, 0)));
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 1_500_000, 1.5e15);
        vm.expectEmit(address(vault));
        emit HotkeyRemoved(HK1, 0, false);
        vm.prank(owner);
        vault.removeHotkey(HK1, false);

        assertEq(address(vault).balance, ED + 1.5e15);
        assertEq(stakeOf(HK1), 0);
        assertEq(vaultLens.hotkeyCount(), 1);
        assertEq(vaultLens.hotkeys(0), HK2);
        assertFalse(vaultLens.isHotkey(HK1));
    }

    /// The stake hotkey is never removed, whoever asks (Task 14a: the keeper's, the guardian's and anyone's removal
    /// paths refuse it too).
    function test_removeHotkeyRejectsStakeHotkey() public {
        vm.prank(stranger);
        vm.expectRevert(HotkeyInUse.selector);
        vault.removeHotkey(HK1, false);

        vm.startPrank(owner);
        vm.expectRevert(HotkeyInUse.selector);
        vault.removeHotkey(HK1, false);
        vm.expectRevert(HotkeyInUse.selector);
        vault.removeHotkey(HK1, true);
        vm.expectRevert(UnknownHotkey.selector);
        vault.removeHotkey(HK3, false);
        vm.stopPrank();

        assertEq(vaultLens.hotkeyCount(), 1);
        assertTrue(vaultLens.isHotkey(HK1));
    }

    function test_removeHotkeyRejectsRewardsAboveDust() public {
        switchTo(HK2);

        // the read is 18-decimal: 1_000_001 rao * 1e9 > hotkeyDustRao (1_000_000) * 1e9
        staking.setUnclaimed(vaultLens.coldkey(), HK1, 1_000_001);
        vm.prank(owner);
        vm.expectRevert(HotkeyHasRewards.selector);
        vault.removeHotkey(HK1, false);
        assertTrue(vaultLens.isHotkey(HK1));

        // 1_000_000 rao * 1e9 = 1e15 wei, exactly the dust allowance
        staking.setUnclaimed(vaultLens.coldkey(), HK1, 1_000_000);
        vm.expectEmit(address(vault));
        emit HotkeyRemoved(HK1, 1e15, false);
        vm.prank(owner);
        vault.removeHotkey(HK1, false);
        assertFalse(vaultLens.isHotkey(HK1));
        assertEq(vaultLens.hotkeyCount(), 1);
    }

    function test_removeHotkeyForfeitThenReAdd() public {
        switchTo(HK2);
        staking.setUnclaimed(vaultLens.coldkey(), HK1, 5_000_000);

        // 5_000_000 rao * 1e9 = 5e15 wei, forfeited (stays owed on chain)
        vm.expectEmit(address(vault));
        emit HotkeyRemoved(HK1, 5e15, true);
        vm.prank(owner);
        vault.removeHotkey(HK1, true);
        assertEq(vaultLens.hotkeyCount(), 1);
        assertFalse(vaultLens.isHotkey(HK1));

        vm.expectEmit(address(vault));
        emit HotkeyAdded(HK1);
        vm.prank(owner);
        vault.addHotkey(HK1);
        assertEq(vaultLens.hotkeyCount(), 2);
        assertTrue(vaultLens.isHotkey(HK1));
        assertEq(vaultLens.stakeHotkey(), HK2);
    }

    // ---- redeemDirect ----

    function test_redeemDirectFromLiquidBalance() public {
        depositDirect(alice, 10e18);

        // 5e24 * (10e18 + 1) / (1e25 + 1e6) = 5e24 / 1e6 = 5e18 (the denominator is 1e6 * (1e19 + 1))
        vm.expectEmit(address(vault));
        emit RedeemedDirect(alice, 5e24, 5e18, false);
        redeem(alice, 5e24);

        assertEq(alice.balance, 5e18);
        assertEq(vault.totalSupply(), 5e24);
        assertEq(vault.balanceOf(alice), 5e24);
        assertEq(address(vault).balance, ED + 5e18);
    }

    function test_redeemDirectUnstakesFullPositionForShortfall() public {
        staking.setOneRaoShort(false);
        depositDirect(alice, 10e18);
        keeperStakes();
        assertEq(stakeOf(HK1), 10_000_000_000);

        // out = 1e25 * (10e18 + 1) / (1e25 + 1e6) = 10e18; available 0; want = ceil(10e18 / 1e9) = 10_000_000_000 >= s
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStakeFull, (HK1, 0)));
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 10_000_000_000, 10e18);
        vm.expectEmit(address(vault));
        emit RedeemedDirect(alice, 1e25, 10e18, false);
        redeem(alice, 1e25);

        assertEq(alice.balance, 10e18);
        assertEq(stakeOf(HK1), 0);
        assertEq(address(vault).balance, ED);
        assertEq(vault.totalSupply(), 0);

        // the unstake guard is cleared once the walk ends
        vm.deal(bob, 1e18);
        vm.prank(bob);
        (bool ok,) = address(vault).call{value: 1e18}("");
        assertFalse(ok);
    }

    function test_redeemDirectPartialUnstakeKeepsRemainder() public {
        staking.setOneRaoShort(false);
        // 100e18 * (0 + 1e6) / (0 + 1) = 1e26 shares
        depositDirect(alice, 100e18);
        keeperStakes();
        assertEq(stakeOf(HK1), 100_000_000_000);

        // out = 1e25 * (100e18 + 1) / (1e26 + 1e6) = 1e25 / 1e6 = 10e18; want 10_000_000_000 leaves
        // 90_000_000_000 >= 20_000_000, so a partial removeStake
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 10_000_000_000, 0)));
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 10_000_000_000, 10e18);
        redeem(alice, 1e25);

        assertEq(stakeOf(HK1), 90_000_000_000);
        assertEq(alice.balance, 10e18);
        assertEq(address(vault).balance, ED);
        assertEq(vault.balanceOf(alice), 9e25);
    }

    function test_redeemDirectFullExitsWhenRemainderBelowNominatorMin() public {
        staking.setOneRaoShort(false);
        depositDirect(alice, 10e18);
        keeperStakes();

        // out = 9.99e24 / 1e6 = 9.99e18; want 9_990_000_000 leaves 10_000_000 < 20_000_000, so the
        // whole 10_000_000_000 rao position exits and 10e18 arrives (a full exit, never a partial request), and its
        // Unstaked logs the position taken (R2 F2)
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStakeFull, (HK1, 0)));
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeWithSelector(IStaking.removeStake.selector), 0);
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 10_000_000_000, 10e18);
        vm.expectEmit(address(vault));
        emit RedeemedDirect(alice, 9_990_000_000_000_000_000_000_000, 9.99e18, false);
        redeem(alice, 9_990_000_000_000_000_000_000_000);

        assertEq(stakeOf(HK1), 0);
        assertEq(alice.balance, 9.99e18);
        // 1e12 + 10e18 - 9.99e18; the swept surplus stays idle, it is not restaked
        assertEq(address(vault).balance, ED + 1e16);
    }

    function test_redeemDirectWalksHotkeysStakeHotkeyFirst() public {
        staking.setOneRaoShort(false);
        depositDirect(alice, 10e18);
        keeperStakes();
        vm.prank(owner);
        vault.addHotkey(HK2);
        scheduled(toStakeHotkey(HK2));
        scheduled(move(HK1, HK2, 5_000_000_000));
        assertEq(stakeOf(HK1), 5_000_000_000);
        assertEq(stakeOf(HK2), 5_000_000_000);

        // out = 8e24 / 1e6 = 8e18. HK2 (stake hotkey) first: want 8_000_000_000 >= 5_000_000_000, a full
        // exit of 5e18, which its Unstaked logs (R2 F2); remaining 3e18. Then HK1: want 3_000_000_000 leaves
        // 2_000_000_000 >= 20_000_000.
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStakeFull, (HK2, 0)));
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 3_000_000_000, 0)));
        vm.expectEmit(address(vault));
        emit Unstaked(HK2, 5_000_000_000, 5e18);
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 3_000_000_000, 3e18);
        redeem(alice, 8e24);

        assertEq(stakeOf(HK2), 0);
        assertEq(stakeOf(HK1), 2_000_000_000);
        assertEq(alice.balance, 8e18);
        assertEq(address(vault).balance, ED);
    }

    function test_redeemDirectRetriesAfterPrecompileRevert() public {
        // a partial unstake (removeStake); test_redeemDirectRetriesAfterFullExitRevert covers removeStakeFull
        staking.setOneRaoShort(false);
        depositDirect(alice, 100e18);
        keeperStakes();
        staking.setUnstakeBlocked(true);

        // the walk skips the refused removal (Task 20) and no other position can pay: UnstakeShort, nothing burned
        vm.prank(alice);
        vm.expectRevert(UnstakeShort.selector);
        vault.redeemDirect(1e25, false);

        assertEq(vault.balanceOf(alice), 1e26);
        assertEq(vault.totalSupply(), 1e26);
        assertEq(stakeOf(HK1), 100_000_000_000);
        assertEq(alice.balance, 0);

        staking.setUnstakeBlocked(false);
        // 1e25 * (100e18 + 1) / (1e26 + 1e6) = 10e18
        redeem(alice, 1e25);
        assertEq(alice.balance, 10e18);
        assertEq(vault.balanceOf(alice), 9e25);
        assertEq(stakeOf(HK1), 90_000_000_000);
    }

    function test_redeemDirectRetriesAfterFullExitRevert() public {
        staking.setOneRaoShort(false);
        depositDirect(alice, 10e18);
        keeperStakes();
        staking.setUnstakeBlocked(true);

        // out = 10e18 needs the whole 10_000_000_000 rao position: removeStakeFull, blocked
        // the walk skips the refused removal (Task 20) and no other position can pay: UnstakeShort, nothing burned
        vm.prank(alice);
        vm.expectRevert(UnstakeShort.selector);
        vault.redeemDirect(1e25, false);

        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(vault.totalSupply(), 1e25);
        assertEq(stakeOf(HK1), 10_000_000_000);
        assertEq(alice.balance, 0);

        staking.setUnstakeBlocked(false);
        redeem(alice, 1e25);
        assertEq(alice.balance, 10e18);
        assertEq(vault.balanceOf(alice), 0);
        assertEq(stakeOf(HK1), 0);
    }

    function test_redeemDirectRevertsWhenUnstakeDeliversShort() public {
        staking.setOneRaoShort(false);
        // 1e26 shares, 100_000_000_000 rao staked
        depositDirect(alice, 100e18);
        keeperStakes();
        // the partial removeStake returns without crediting anything
        vm.mockCall(ISTAKING_ADDRESS, abi.encodeWithSelector(IStaking.removeStake.selector), "");

        // out = 1e19 * (100e18 + 1) / (1e26 + 1e6) = 1e19 / 1e6 = 1e13, 10_000 rao, past the 1_000-rao
        // shortfall tolerance (Task 19; an exit within it walks nothing: VaultExits.t.sol); available 0; want =
        // max(10_000, 2_000_000) = 2_000_000 (partial) arrives as 0, so all 1e13 is unmet. Without the check the
        // shares would burn for nothing.
        vm.prank(alice);
        vm.expectRevert(UnstakeShort.selector);
        vault.redeemDirect(1e19, false);

        assertEq(vault.balanceOf(alice), 1e26);
        assertEq(vault.totalSupply(), 1e26);
        assertEq(stakeOf(HK1), 100_000_000_000);
        assertEq(alice.balance, 0);
        assertEq(address(vault).balance, ED);

        // a delivering unstake goes through: 1e12 + 2_000_000 * 1e9 - 1e13 stays liquid
        vm.clearMockedCalls();
        redeem(alice, 1e19);
        assertEq(alice.balance, 1e13);
        assertEq(stakeOf(HK1), 99_998_000_000);
        assertEq(address(vault).balance, 1e12 + 2e15 - 1e13);
    }

    function test_redeemDirectSkipsEmptyStakeHotkey() public {
        staking.setOneRaoShort(false);
        depositDirect(alice, 10e18);
        keeperStakes();
        vm.prank(owner);
        vault.addHotkey(HK2);
        scheduled(toStakeHotkey(HK2));
        assertEq(stakeOf(HK2), 0);

        // out = 5e24 / 1e6 = 5e18. HK2 (stake hotkey) holds nothing and is skipped; HK1: want
        // 5_000_000_000 leaves 5_000_000_000 >= 20_000_000, a partial removeStake
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStakeFull, (HK2, 0)), 0);
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeWithSelector(IStaking.removeStake.selector, HK2), 0);
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 5_000_000_000, 0)));
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 5_000_000_000, 5e18);
        redeem(alice, 5e24);

        assertEq(stakeOf(HK1), 5_000_000_000);
        assertEq(stakeOf(HK2), 0);
        assertEq(alice.balance, 5e18);
        assertEq(address(vault).balance, ED);
    }

    function test_redeemDirectSkipsSubMinimumHotkey() public {
        staking.setOneRaoShort(false);
        depositDirect(alice, 10e18);
        keeperStakes();
        // HK2 becomes the stake hotkey holding 1_500_000 rao, below the 2_000_000 minimum (the mock does
        // not enforce the minimum on moves; on chain dust arrives by rewards or a transfer)
        switchTo(HK2);
        scheduled(move(HK1, HK2, 1_500_000));
        assertEq(stakeOf(HK2), 1_500_000);
        assertEq(stakeOf(HK1), 9_998_500_000);

        // out = 5e24 * (10e18 + 1) / (1e25 + 1e6) = 5e18. HK2 is below the minimum and is not touched;
        // HK1: want 5_000_000_000 leaves 4_998_500_000 >= 20_000_000, a partial removeStake
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStakeFull, (HK2, 0)), 0);
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeWithSelector(IStaking.removeStake.selector, HK2), 0);
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 5_000_000_000, 0)));
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 5_000_000_000, 5e18);
        redeem(alice, 5e24);

        assertEq(stakeOf(HK2), 1_500_000);
        assertEq(stakeOf(HK1), 4_998_500_000);
        assertEq(alice.balance, 5e18);
        assertEq(address(vault).balance, ED);
    }

    /// The walk rounds a request up to the chain's minimum, raised above the constant fallbacks (the fallbacks alone,
    /// with the reads failing: VaultBounds.t.sol's test_floorFallbacksAreConstants, Task 23).
    function test_redeemDirectRequestsRaisedMinStake() public {
        staking.setOneRaoShort(false);
        // 1e26 shares, 100_000_000_000 rao staked
        depositDirect(alice, 100e18);
        keeperStakes();
        // the chain raises its floors above the fallbacks, 2_000_000 / 20_000_000
        staking.setMinStake(5_000_000);
        staking.setNominatorMin(50_000_000);

        // out = 1e19 * (100e18 + 1) / (1e26 + 1e6) = 1e13, 10_000 rao (past the 1_000-rao shortfall tolerance,
        // within which the walk does nothing, Task 19); want = max(10_000, 5_000_000) = 5_000_000 leaves
        // 99_995_000_000 >= 50_000_000, a partial removeStake
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 5_000_000, 0)));
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 5_000_000, 5e15);
        redeem(alice, 1e19);

        assertEq(alice.balance, 1e13);
        assertEq(stakeOf(HK1), 99_995_000_000);
        // 1e12 + 5e15 - 1e13 stays liquid
        assertEq(address(vault).balance, 1e12 + 5e15 - 1e13);
    }

    /// A 50,000-rao removal fee is the leaver's, the unstake margin or none (Task 36b, the founder's ruling of
    /// 2026-11-06): the walk counts the stake it takes, at face value, so without the margin the exit is paid its
    /// value less the fee (before, it reverted UnstakeShort), and with it the leaver still bears the fee (before, the
    /// margin made it the holders') while the margin's stake sits idle at full value. The holders' price does not move
    /// either way.
    function test_redeemDirectUnstakeMarginMovesNoRemoveFee() public {
        staking.setOneRaoShort(false);
        // 1e26 shares, 100_000_000_000 rao staked
        depositDirect(alice, 100e18);
        keeperStakes();
        uint256 price = vaultLens.price();
        // the chain keeps 50_000 rao of every removal
        staking.setRemoveFeeRao(50_000);

        // out = 1e25 * (100e18 + 1) / (1e26 + 1e6) = 10e18; the walk takes 10_000_000_000 rao, which arrives as
        // 9_999_950_000: the leaver bears the 50_000
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 10_000_000_000, 9_999_950_000e9);
        vm.expectEmit(address(vault));
        emit ShortfallAbsorbed(50_000e9);
        vm.expectEmit(address(vault));
        emit RedeemedDirect(alice, 1e25, 10e18 - 50_000e9, false);
        redeem(alice, 1e25);
        assertEq(alice.balance, 10e18 - 50_000e9);
        assertEq(stakeOf(HK1), 90_000_000_000);
        assertEq(address(vault).balance, ED);
        assertEq(vaultLens.price(), price, "the holders' price unmoved");

        vm.expectEmit(address(vault));
        emit LimitSet(CascadeVault.setUnstakeMarginRao.selector, 50_000, 0);
        vm.prank(owner);
        vault.setUnstakeMarginRao(50_000);
        assertEq(vaultLens.unstakeMarginRao(), 50_000);

        // out = 1e25 * (90e18 + 1) / (9e25 + 1e6) = 10e18; want = 10_000_000_000 + 50_000 = 10_000_050_000, which
        // arrives as exactly 10e18: the leaver still bears the 50_000, and the margin's 50_000 rao stay idle
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 10_000_050_000, 0)));
        vm.expectEmit(address(vault));
        emit Unstaked(HK1, 10_000_050_000, 10e18);
        vm.expectEmit(address(vault));
        emit ShortfallAbsorbed(50_000e9);
        vm.expectEmit(address(vault));
        emit RedeemedDirect(alice, 1e25, 10e18 - 50_000e9, false);
        redeem(alice, 1e25);
        assertEq(alice.balance, 2 * (10e18 - 50_000e9));
        // 90_000_000_000 - 10_000_050_000
        assertEq(stakeOf(HK1), 79_999_950_000);
        assertEq(address(vault).balance, ED + 50_000e9, "the margin idle, at full value");
        assertEq(vaultLens.price(), price, "the holders' price unmoved");

        // with no fee the margin's excess stays idle for stakeIdle. A = 80e18, S = 8e25: out = 1e18; available
        // 50_000 rao, so the walk asks ceil((1e18 - 50_000e9) / 1e9) + 50_000 = 1_000_000_000 rao, paid whole
        staking.setRemoveFeeRao(0);
        vm.expectCall(ISTAKING_ADDRESS, abi.encodeCall(IStaking.removeStake, (HK1, 1_000_000_000, 0)));
        redeem(alice, 1e24);
        assertEq(alice.balance, 2 * (10e18 - 50_000e9) + 1e18);
        // 50_000e9 + 1e18 - 1e18 = 50_000 rao idle
        assertEq(address(vault).balance, ED + 50_000e9);
    }

    function test_setUnstakeMarginRaoOwnerOnly() public {
        assertEq(vaultLens.unstakeMarginRao(), 0);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        vault.setUnstakeMarginRao(1);
        assertEq(vaultLens.unstakeMarginRao(), 0);
    }

    function test_redeemDirectBelowOneRaoReverts() public {
        depositDirect(alice, 10e18);

        // 1 * (10e18 + 1) / (1e25 + 1e6) = 0
        vm.prank(alice);
        vm.expectRevert(ZeroAmount.selector);
        vault.redeemDirect(1, false);
        // (1e15 - 1) / 1e6 = 999_999_999 wei, floored to whole rao = 0
        vm.prank(alice);
        vm.expectRevert(ZeroAmount.selector);
        vault.redeemDirect(1e15 - 1, false);

        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(vault.totalSupply(), 1e25);
        assertEq(address(vault).balance, ED + 10e18);

        // 1e15 / 1e6 = 1e9 wei, exactly one rao
        redeem(alice, 1e15);
        assertEq(alice.balance, 1e9);
        assertEq(vault.balanceOf(alice), 1e25 - 1e15);
    }

    function test_redeemDirectZeroReverts() public {
        depositDirect(alice, 10e18);
        vm.prank(alice);
        vm.expectRevert(ZeroAmount.selector);
        vault.redeemDirect(0, false);
    }

    function test_redeemDirectWhilePausedReverts() public {
        depositDirect(alice, 10e18);
        vm.prank(guardian);
        vault.pause();

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.redeemDirect(1e25, false);
        assertEq(vault.balanceOf(alice), 1e25);
    }

    function test_redeemDirectDoesNotRestake() public {
        staking.setOneRaoShort(false);
        depositDirect(alice, 10e18);
        keeperStakes();
        // totalAssets 10e18 before bob: 1e18 * (1e25 + 1e6) / (10e18 + 1) = 1e18 * 1e6 = 1e24 shares
        depositDirect(bob, 1e18);
        assertEq(vault.balanceOf(bob), 1e24);

        // out = 1e24 * (11e18 + 1) / (1.1e25 + 1e6) = 1e24 / 1e6 = 1e18; available = 1e18, paid from balance
        vm.recordLogs();
        redeem(bob, 1e24);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != Unstaked.selector);
            assertTrue(logs[i].topics[0] != Staked.selector);
        }

        assertEq(bob.balance, 1e18);
        assertEq(stakeOf(HK1), 10_000_000_000);
        assertEq(address(vault).balance, ED);
    }
}
