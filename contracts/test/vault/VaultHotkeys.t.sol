// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {Schedule} from "../governance/Schedule.sol";
import {
    HotkeyInUse,
    InvalidParameter,
    NotAuthorized,
    NotEligible,
    NotListed,
    NotScheduled,
    SlotReserved,
    TooManyHotkeys
} from "../../src/CascadeErrors.sol";
import {HotkeyAdded, HotkeyRemoved, StakeHotkeySet, StakeMoved, Staked} from "../../src/CascadeEvents.sol";

/// The hotkey rules (spec §3.1 "Unlisted stake, the slots, and the permissionless way back", §3.6, §3.10.3,
/// §3.10.4, §3.10.10; I-6; Task 14a). A validator's hotkey swap can move the vault's stake to a hotkey it does not
/// list, and stakeMissing() then closes every mint (Task 13); this is the way back:
///   - addHotkey: the owner, the guardian or the keeper at any time; anyone while stake is missing, of a hotkey the
///     vault never listed (lastClaimAt == 0) holding at least the chain's minimum of the vault's root stake
///     (NotEligible). The add that fills the last slot (MAX_HOTKEYS) needs stake missing and that minimum on the
///     hotkey, whoever adds (SlotReserved): other adds fill at most three slots.
///   - removeHotkey: the owner's, v3.1's rule; the keeper's or the guardian's, of a non-stake hotkey with no stake
///     and unclaimed rewards at most hotkeyDustRao; anyone's, of a non-stake hotkey with no stake and nothing
///     unclaimed, while the set is full and stake is missing (NotAuthorized). HotkeyRemoved's forfeit is the owner's
///     alone. So, while nothing is missing or a slot is free, no stranger can remove an empty X during a scheduled
///     setStakeHotkey(X) (round 9 L-2); full and missing, one can, and the kept item waits for X's re-listing.
///   - setStakeHotkey: the owner's, of a listed hotkey (NotListed, at execute too); immediate when it follows stake
///     that already moved (more than the stake hotkey holds, and at least half the booked stake), else scheduled.
///   - moveStake names its destination, which must be the stake hotkey at execute (R1-A carry): an immediate
///     setStakeHotkey cannot redirect a move the guardian reviewed.
/// A swap is modelled as the chain moving the vault's root position off a hotkey (the precompile called as the
/// vault, as PentestBase.swapAway does); within the set the same call stands in for an executed moveStake.
contract VaultHotkeysTest is VaultTestBase {
    bytes32 constant HK6 = bytes32(uint256(6));
    uint256 constant RAO = 1e9;
    address stranger = makeAddr("stranger");

    /// Exact stake reads (no one-rao-short fresh position), and a sixth hotkey the chain knows.
    function setUp() public override {
        super.setUp();
        staking.setOneRaoShort(false);
        staking.addHotkey(HK6);
    }

    // ---- helpers ----

    function coldkey() internal view returns (bytes32) {
        return vaultLens.coldkey();
    }

    function stakeOf(bytes32 h) internal view returns (uint256) {
        return staking.getStake(h, coldkey(), 0);
    }

    /// `amount` wei deposited directly by alice and staked by the keeper on the stake hotkey (HK1): with exact
    /// reads the booked stake is amount / RAO.
    function fund(uint256 amount) internal {
        depositDirect(alice, amount);
        vm.prank(keeper);
        vault.stakeIdle();
    }

    /// The chain moves `rao` of the vault's root position from `from` to `to`: a validator's hotkey swap when `to`
    /// is not listed, an executed moveStake when it is.
    function chainMoves(bytes32 from, bytes32 to, uint256 rao) internal {
        vm.prank(address(vault));
        staking.moveStake(from, to, 0, 0, rao);
    }

    function list(address who, bytes32 h) internal {
        vm.prank(who);
        vault.addHotkey(h);
    }

    function refusedAdd(address who, bytes32 h, bytes4 err) internal {
        vm.prank(who);
        vm.expectRevert(err);
        vault.addHotkey(h);
    }

    function refusedRemove(address who, bytes32 h, bool forfeit, bytes4 err) internal {
        vm.prank(who);
        vm.expectRevert(err);
        vault.removeHotkey(h, forfeit);
    }

    function toStakeHotkey(bytes32 h) internal pure returns (bytes memory) {
        return abi.encodeCall(CascadeVault.setStakeHotkey, (h));
    }

    /// HK2 and HK3 listed by the owner beside HK1: three slots used, the last one free.
    function threeListed() internal {
        vm.startPrank(owner);
        vault.addHotkey(HK2);
        vault.addHotkey(HK3);
        vm.stopPrank();
        assertEq(vaultLens.hotkeyCount(), 3);
    }

    // ---- addHotkey: anyone, while stake is missing (I-6) ----

    /// I-6: a 1 TAO vault (its tolerance the 0.001 TAO floor) whose validator swapped exactly the chain's minimum
    /// onto HK5, a hotkey the vault never listed: stake is missing, and a stranger's listing of HK5 clears it. The
    /// listing only widens what the price reads, routes no stake, and starts HK5's record.
    function test_strangerListsTheSwapsNewHotkey() public {
        fund(1e18);
        uint256 min = vaultLens.minStakeRao();
        assertEq(min, 2_000_000);
        chainMoves(HK1, HK5, min);
        assertTrue(vaultLens.stakeMissing(), "2_000_000 rao missing, past the 1_000_000 rao tolerance");
        assertEq(vaultLens.totalAssets(), 1e18 - min * RAO, "priced at the visible stake");
        assertEq(vaultLens.lastClaimAt(HK5), 0, "never listed");

        vm.expectEmit(address(vault));
        emit HotkeyAdded(HK5);
        list(stranger, HK5);

        assertTrue(vaultLens.isHotkey(HK5));
        assertFalse(vaultLens.stakeMissing(), "the stranger's listing clears it");
        assertEq(vaultLens.visibleStakeRao(), vaultLens.bookedStake());
        assertEq(vaultLens.totalAssets(), 1e18, "the price back where it was");
        assertEq(vaultLens.lastClaimAt(HK5), vm.getBlockTimestamp(), "the record starts at its first listing");
        assertEq(vaultLens.stakeHotkey(), HK1, "listing routes no new stake");
        assertEq(vaultLens.hotkeyCount(), 2);
    }

    /// One rao under the chain's minimum, a stranger may not list it (nor a hotkey holding nothing). A rao more
    /// reaches it, unless the chain's live minimum rises past it; at the minimum, the stranger may.
    function test_strangerRefusedBelowTheMinimum() public {
        fund(1e18);
        uint256 min = vaultLens.minStakeRao();
        chainMoves(HK1, HK5, min - 1);
        assertTrue(vaultLens.stakeMissing());

        refusedAdd(stranger, HK5, NotEligible.selector);
        refusedAdd(stranger, HK4, NotEligible.selector);

        // a rao more (a gift onto HK5) reaches the minimum, but the chain's live minimum raised past it refuses
        staking.donateStake(HK5, coldkey(), 1);
        staking.setMinStake(min + 1);
        refusedAdd(stranger, HK5, NotEligible.selector);
        staking.setMinStake(min);
        list(stranger, HK5);
        assertFalse(vaultLens.stakeMissing());
    }

    /// A hotkey the vault once listed keeps its record after removal (lastClaimAt), and the coldkey's staking set
    /// keeps it, so a stranger could have seeded it: its re-listing is the owner's, the guardian's or the keeper's,
    /// even while the vault's own stake sits on it. A listed hotkey is refused to a stranger too.
    function test_strangerRefusedForAHotkeyOnceListed() public {
        fund(10e18);
        list(owner, HK2);
        uint256 listedAt = vm.getBlockTimestamp();
        Schedule.wait(1 days);
        // empty, nothing unclaimed: the keeper frees the slot
        vm.prank(keeper);
        vault.removeHotkey(HK2, false);
        assertFalse(vaultLens.isHotkey(HK2));
        assertEq(vaultLens.lastClaimAt(HK2), listedAt, "kept after removal");

        // a swap lands the stake hotkey's whole position on HK2
        chainMoves(HK1, HK2, stakeOf(HK1));
        assertTrue(vaultLens.stakeMissing());
        refusedAdd(stranger, HK2, NotEligible.selector);
        // HK1, listed: refused to a stranger as well
        refusedAdd(stranger, HK1, NotEligible.selector);

        list(keeper, HK2);
        assertFalse(vaultLens.stakeMissing());
        assertEq(vaultLens.lastClaimAt(HK2), listedAt, "a re-listed hotkey keeps its record");
    }

    /// A swap within the tolerance leaves nothing missing: a stranger may not list its hotkey, though it holds the
    /// minimum. One rao more is missing, and then the stranger may.
    function test_strangerRefusedWhileNothingIsMissing() public {
        fund(100e18);
        // 100 TAO booked: the tolerance is 0.1%, 100_000_000 rao
        chainMoves(HK1, HK5, 100_000_000);
        assertFalse(vaultLens.stakeMissing());
        assertGe(stakeOf(HK5), vaultLens.minStakeRao());
        refusedAdd(stranger, HK5, NotEligible.selector);

        chainMoves(HK1, HK5, 1);
        assertTrue(vaultLens.stakeMissing());
        list(stranger, HK5);
        assertFalse(vaultLens.stakeMissing());
    }

    // ---- the last slot ----

    /// Three listed: the add that would fill the fourth is refused to the owner, the guardian and the keeper while
    /// nothing is missing, even of a hotkey holding the minimum (a gift); while stake is missing, of a hotkey holding
    /// less than the minimum too; while missing, of a hotkey holding the swapped stake, it lists it. Then the set is
    /// full.
    function test_lastSlotOnlyWhileMissing() public {
        fund(10e18);
        threeListed();

        refusedAdd(owner, HK4, SlotReserved.selector);
        refusedAdd(guardian, HK4, SlotReserved.selector);
        refusedAdd(keeper, HK4, SlotReserved.selector);
        // the minimum on HK4 (a gift), with nothing missing: still reserved
        staking.donateStake(HK4, coldkey(), vaultLens.minStakeRao());
        refusedAdd(owner, HK4, SlotReserved.selector);
        // a stranger: not eligible, nothing is missing
        refusedAdd(stranger, HK4, NotEligible.selector);

        chainMoves(HK1, HK5, 5_000_000_000);
        assertTrue(vaultLens.stakeMissing());
        // while missing, a hotkey under the minimum is refused the last slot
        refusedAdd(owner, HK6, SlotReserved.selector);

        vm.expectEmit(address(vault));
        emit HotkeyAdded(HK5);
        list(keeper, HK5);
        assertEq(vaultLens.hotkeyCount(), 4);
        assertEq(vaultLens.hotkeys(3), HK5);
        assertFalse(vaultLens.stakeMissing());

        refusedAdd(owner, HK4, TooManyHotkeys.selector);
        assertFalse(vaultLens.isHotkey(HK4));
    }

    // ---- removeHotkey: the keeper's and the guardian's, anyone's ----

    /// The keeper and the guardian may remove a non-stake hotkey only when it holds no stake (exactly 0) and its
    /// unclaimed rewards are at most the dust allowance, forfeit or not; never the stake hotkey. The owner keeps
    /// v3.1's rule (VaultStake.t.sol).
    function test_keeperOrGuardianRemovesOnlyEmptyAndDust() public {
        fund(10e18);
        threeListed();
        uint256 dust = vaultLens.hotkeyDustRao();
        assertEq(dust, 1_000_000);

        // HK2 holds stake
        chainMoves(HK1, HK2, 1_000_000_000);
        refusedRemove(keeper, HK2, false, NotAuthorized.selector);
        refusedRemove(guardian, HK2, true, NotAuthorized.selector);
        // one rao is stake
        chainMoves(HK2, HK1, 999_999_999);
        assertEq(stakeOf(HK2), 1);
        refusedRemove(keeper, HK2, false, NotAuthorized.selector);
        chainMoves(HK2, HK1, 1);

        // unclaimed rewards above the dust: refused, forfeit or not (the read is 18-decimal)
        staking.setUnclaimed(coldkey(), HK2, dust + 1);
        refusedRemove(keeper, HK2, false, NotAuthorized.selector);
        refusedRemove(guardian, HK2, true, NotAuthorized.selector);

        // at the dust: the keeper removes it
        staking.setUnclaimed(coldkey(), HK2, dust);
        vm.expectEmit(address(vault));
        emit HotkeyRemoved(HK2, dust * RAO, false);
        vm.prank(keeper);
        vault.removeHotkey(HK2, false);
        assertFalse(vaultLens.isHotkey(HK2));

        // the guardian removes HK3, empty with nothing unclaimed
        vm.expectEmit(address(vault));
        emit HotkeyRemoved(HK3, 0, false);
        vm.prank(guardian);
        vault.removeHotkey(HK3, false);
        assertEq(vaultLens.hotkeyCount(), 1);

        // never the stake hotkey, and a stranger only when the set is full and stake is missing
        refusedRemove(keeper, HK1, false, HotkeyInUse.selector);
        list(owner, HK2);
        refusedRemove(stranger, HK2, false, NotAuthorized.selector);
        assertEq(vaultLens.visibleStakeRao(), 10_000_000_000, "no stake moved");
    }

    /// Anyone may remove a non-stake hotkey with no stake and nothing unclaimed, only while the set is full and
    /// stake is missing: its one purpose is to free a slot for a swap's new hotkey (I-6's precondition).
    function test_strangerRemovesOnlyWhenFullAndMissing() public {
        fund(10e18);
        threeListed();
        refusedRemove(stranger, HK2, false, NotAuthorized.selector);

        // a swap: stake missing, but the set is not full
        chainMoves(HK1, HK5, 4_000_000_000);
        assertTrue(vaultLens.stakeMissing());
        refusedRemove(stranger, HK2, false, NotAuthorized.selector);

        // its hotkey, listed by a stranger in the last slot: full, nothing missing
        list(stranger, HK5);
        assertEq(vaultLens.hotkeyCount(), 4);
        assertFalse(vaultLens.stakeMissing());
        refusedRemove(stranger, HK2, false, NotAuthorized.selector);

        // a second swap: full and missing
        chainMoves(HK1, HK6, 4_000_000_000);
        assertTrue(vaultLens.stakeMissing());
        // a rao unclaimed: no dust for a stranger
        staking.setUnclaimed(coldkey(), HK2, 1);
        refusedRemove(stranger, HK2, false, NotAuthorized.selector);
        staking.setUnclaimed(coldkey(), HK2, 0);
        // a rao of stake
        staking.donateStake(HK3, coldkey(), 1);
        refusedRemove(stranger, HK3, true, NotAuthorized.selector);
        // never the stake hotkey
        refusedRemove(stranger, HK1, false, HotkeyInUse.selector);

        vm.expectEmit(address(vault));
        emit HotkeyRemoved(HK2, 0, false);
        vm.prank(stranger);
        vault.removeHotkey(HK2, false);
        assertEq(vaultLens.hotkeyCount(), 3);

        // the way back goes on: the stranger lists the second swap's hotkey
        list(stranger, HK6);
        assertFalse(vaultLens.stakeMissing());
    }

    /// Round 9 L-2, as it holds: the owner lists an empty X and schedules setStakeHotkey(X) (48 hours: X holds
    /// nothing). X is empty with nothing unclaimed, yet no stranger can remove it while nothing is missing, with the
    /// set below full or full; the item runs. (Full and missing, one can: the next test.)
    function test_strangerCannotRemoveXDuringAScheduledSetStakeHotkeyX() public {
        fund(10e18);
        list(owner, HK2);
        vm.prank(owner);
        vault.schedule(toStakeHotkey(HK2));
        refusedRemove(stranger, HK2, false, NotAuthorized.selector);

        // the set full (a swap resolved in the last slot), nothing missing
        list(owner, HK3);
        chainMoves(HK1, HK5, 4_000_000_000);
        list(stranger, HK5);
        assertEq(vaultLens.hotkeyCount(), 4);
        refusedRemove(stranger, HK2, false, NotAuthorized.selector);

        Schedule.wait(48 hours);
        vm.prank(owner);
        vault.execute(toStakeHotkey(HK2));
        assertEq(vaultLens.stakeHotkey(), HK2);
    }

    /// The accepted rest of round 9 L-2: while the set is full and stake is missing, a stranger may remove an empty
    /// X during the owner's scheduled setStakeHotkey(X), since freeing a slot for a swap's hotkey is that removal's
    /// one purpose (a pending-item check would block I-6's way back whenever X is the only empty slot). The item
    /// then fails NotListed at execute and is kept; the owner frees a non-reserved slot, lists X again and executes
    /// the same item inside its window, no re-scheduling.
    function test_aStrangerRemovesXDuringItsScheduledSwitchOnlyWhenFullAndMissing() public {
        fund(10e18);
        vm.startPrank(owner);
        vault.addHotkey(HK2);
        bytes32 id = vault.schedule(toStakeHotkey(HK2));
        vault.addHotkey(HK3);
        vm.stopPrank();
        // HK3's position swapped to HK5, listed by a stranger in the last slot; then HK1's part swapped to HK6
        chainMoves(HK1, HK3, 3_000_000_000);
        chainMoves(HK3, HK5, 3_000_000_000);
        list(stranger, HK5);
        chainMoves(HK1, HK6, 2_000_000_000);
        assertEq(vaultLens.hotkeyCount(), 4);
        assertTrue(vaultLens.stakeMissing());

        // the stranger removes X (not the emptied HK3) and lists HK6
        vm.prank(stranger);
        vault.removeHotkey(HK2, false);
        list(stranger, HK6);
        assertFalse(vaultLens.stakeMissing());

        Schedule.wait(48 hours);
        vm.prank(owner);
        vm.expectRevert(NotListed.selector);
        vault.execute(toStakeHotkey(HK2));
        assertGt(vaultLens.scheduled(id).readyAt, 0, "the item kept");

        // full, nothing missing: X needs a non-reserved slot, so the owner removes the emptied HK3 and consolidates
        // HK5 onto the stake hotkey, lists X and runs the kept item inside its window
        vm.startPrank(owner);
        vault.removeHotkey(HK3, false);
        vm.expectRevert(SlotReserved.selector);
        vault.addHotkey(HK2);
        vault.removeHotkey(HK5, false);
        vault.addHotkey(HK2);
        vault.execute(toStakeHotkey(HK2));
        vm.stopPrank();
        assertEq(vaultLens.stakeHotkey(), HK2);
        assertEq(vaultLens.visibleStakeRao(), vaultLens.bookedStake(), "nothing lost");
    }

    /// HotkeyRemoved's forfeit is the owner's alone: the keeper's, the guardian's and a stranger's removals, each
    /// passing forfeit = true, succeed under their own rules and the event reads false; the owner's forfeit reads
    /// true.
    function test_onlyTheOwnersRemovalReportsAForfeit() public {
        fund(10e18);
        threeListed();
        uint256 dust = vaultLens.hotkeyDustRao();
        staking.setUnclaimed(coldkey(), HK2, dust);
        vm.expectEmit(address(vault));
        emit HotkeyRemoved(HK2, dust * RAO, false);
        vm.prank(keeper);
        vault.removeHotkey(HK2, true);
        vm.expectEmit(address(vault));
        emit HotkeyRemoved(HK3, 0, false);
        vm.prank(guardian);
        vault.removeHotkey(HK3, true);

        // a stranger's: the set full (a swap listed in the last slot) and stake missing (a second swap)
        staking.setUnclaimed(coldkey(), HK2, 0);
        threeListed();
        chainMoves(HK1, HK5, 4_000_000_000);
        list(keeper, HK5);
        chainMoves(HK1, HK6, 4_000_000_000);
        assertTrue(vaultLens.stakeMissing());
        vm.expectEmit(address(vault));
        emit HotkeyRemoved(HK2, 0, false);
        vm.prank(stranger);
        vault.removeHotkey(HK2, true);

        // the owner's forfeit of rewards above the dust
        staking.setUnclaimed(coldkey(), HK3, dust + 1);
        vm.expectEmit(address(vault));
        emit HotkeyRemoved(HK3, (dust + 1) * RAO, true);
        vm.prank(owner);
        vault.removeHotkey(HK3, true);
    }

    // ---- setStakeHotkey ----

    /// L-1: the stake hotkey's whole position swapped to HK5, listed by the keeper: the owner's setStakeHotkey(HK5)
    /// is immediate, as HK5 holds more than HK1 and at least half the booked stake. The keeper then frees HK1's
    /// slot, and new stake goes to HK5. At exactly half the booked stake it is immediate too.
    function test_setStakeHotkeyFollowsMovedStakeAtOnce() public {
        fund(10e18);
        chainMoves(HK1, HK5, stakeOf(HK1));
        list(keeper, HK5);

        vm.expectEmit(address(vault));
        emit StakeHotkeySet(HK5);
        vm.prank(owner);
        vault.setStakeHotkey(HK5);
        assertEq(vaultLens.stakeHotkey(), HK5);

        vm.prank(keeper);
        vault.removeHotkey(HK1, false);
        assertEq(vaultLens.hotkeyCount(), 1);
        depositDirect(bob, 1e18);
        vm.expectEmit(address(vault));
        emit Staked(HK5, 1_000_000_000, 1_000_000_000);
        vm.prank(keeper);
        vault.stakeIdle();

        // booked 11e9: HK2 at exactly half (5.5e9) and above the stake hotkey's 4.5e9 follows at once
        list(owner, HK2);
        list(owner, HK3);
        chainMoves(HK5, HK2, 5_500_000_000);
        chainMoves(HK5, HK3, 1_000_000_000);
        assertEq(vaultLens.bookedStake(), 11_000_000_000);
        assertEq(stakeOf(HK5), 4_500_000_000);
        vm.prank(owner);
        vault.setStakeHotkey(HK2);
        assertEq(vaultLens.stakeHotkey(), HK2);
    }

    /// Otherwise the change is a scheduled one (48 hours, Ordinary): a listed hotkey holding no more than the
    /// stake hotkey (equal included, even at half the booked stake), or more but under half the booked stake, or
    /// less. Only the owner calls it; the scheduled path runs it, and the guardian may cancel it.
    function test_setStakeHotkeyOtherwiseScheduled() public {
        fund(10e18);
        threeListed();
        // HK1 5e9, HK2 5e9: HK2 at half the booked 1e10, but only equal to the stake hotkey
        chainMoves(HK1, HK2, 5_000_000_000);
        vm.prank(owner);
        vm.expectRevert(NotScheduled.selector);
        vault.setStakeHotkey(HK2);
        // HK1 3.000000001e9, HK2 4.999999999e9, HK3 2e9: HK2 more, but one rao under half the booked 1e10
        chainMoves(HK1, HK3, 2_000_000_000);
        chainMoves(HK2, HK1, 1);
        vm.prank(owner);
        vm.expectRevert(NotScheduled.selector);
        vault.setStakeHotkey(HK2);
        // HK3 holds less
        vm.prank(owner);
        vm.expectRevert(NotScheduled.selector);
        vault.setStakeHotkey(HK3);
        // the owner's alone
        address[3] memory others = [guardian, keeper, stranger];
        for (uint256 i; i < 3; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, others[i]));
            vault.setStakeHotkey(HK2);
        }
        assertEq(vaultLens.stakeHotkey(), HK1);

        // the guardian may cancel it
        vm.prank(owner);
        bytes32 id = vault.schedule(toStakeHotkey(HK2));
        vm.prank(guardian);
        vault.cancel(id);
        // scheduled, it runs
        Schedule.run(vault, owner, toStakeHotkey(HK3));
        assertEq(vaultLens.stakeHotkey(), HK3);
    }

    /// No implicit listing (spec §3.10.3): an unlisted hotkey is NotListed directly, even holding the swapped
    /// stake, and at execute (the item kept); so is one removed between scheduling and execute. Listed, the same
    /// item runs.
    function test_setStakeHotkeyUnlistedReverts() public {
        fund(10e18);
        chainMoves(HK1, HK5, stakeOf(HK1));
        vm.startPrank(owner);
        vm.expectRevert(NotListed.selector);
        vault.setStakeHotkey(HK5);
        vm.expectRevert(NotListed.selector);
        vault.setStakeHotkey(bytes32(0));

        bytes32 id2 = vault.schedule(toStakeHotkey(HK2));
        vault.addHotkey(HK3);
        vault.schedule(toStakeHotkey(HK3));
        vm.stopPrank();
        vm.prank(keeper);
        vault.removeHotkey(HK3, false);

        Schedule.wait(48 hours);
        vm.startPrank(owner);
        vm.expectRevert(NotListed.selector);
        vault.execute(toStakeHotkey(HK2));
        vm.expectRevert(NotListed.selector);
        vault.execute(toStakeHotkey(HK3));
        assertGt(vaultLens.scheduled(id2).readyAt, 0, "the item kept");
        assertEq(vaultLens.stakeHotkey(), HK1);

        vault.addHotkey(HK2);
        vault.execute(toStakeHotkey(HK2));
        vm.stopPrank();
        assertEq(vaultLens.stakeHotkey(), HK2);
        assertFalse(vaultLens.isHotkey(HK5));
    }

    // ---- I-6's preconditions ----

    /// Two validators swap at once and one slot is free: the first new hotkey takes it, the second waits for a
    /// removal, which anyone may make (the set full, stake missing) of a hotkey its swap emptied.
    function test_twoSwapsOneFreeSlotNeedARemovalFirst() public {
        fund(10e18);
        threeListed();
        chainMoves(HK1, HK2, 3_000_000_000);
        chainMoves(HK1, HK3, 3_000_000_000);

        chainMoves(HK2, HK5, 3_000_000_000);
        chainMoves(HK3, HK6, 3_000_000_000);
        assertTrue(vaultLens.stakeMissing());

        list(stranger, HK5);
        assertTrue(vaultLens.stakeMissing(), "HK6's share is still missing");
        refusedAdd(stranger, HK6, TooManyHotkeys.selector);

        vm.prank(stranger);
        vault.removeHotkey(HK2, false);
        list(stranger, HK6);
        assertFalse(vaultLens.stakeMissing());
        assertEq(vaultLens.visibleStakeRao(), vaultLens.bookedStake());
        assertEq(vaultLens.totalAssets(), 10e18);
    }

    /// In a vault with less than 2 TAO booked, a swapped position can exceed the tolerance and stay under the
    /// chain's minimum: no stranger may list it, and the last slot is not for it either. A gift clears it,
    /// harmlessly: the price reads min(visible, booked), never above what the vault booked.
    function test_subMinimumSwapClearsOnlyByAGift() public {
        fund(1e18);
        threeListed();
        chainMoves(HK1, HK5, 1_500_000);
        assertTrue(vaultLens.stakeMissing(), "1_500_000 rao past the 1_000_000 rao tolerance");
        assertLt(stakeOf(HK5), vaultLens.minStakeRao());
        refusedAdd(stranger, HK5, NotEligible.selector);
        refusedAdd(keeper, HK5, SlotReserved.selector);

        // a gift of 500_000 rao onto a listed hotkey brings the gap to the tolerance
        staking.donateStake(HK1, coldkey(), 500_000);
        assertFalse(vaultLens.stakeMissing());
        assertEq(vaultLens.bookedStake(), 1_000_000_000, "the gift booked nothing");
        assertEq(vaultLens.totalAssets(), 999_000_000 * RAO, "min(visible, booked): no more than booked");
    }

    // ---- moveStake names its destination (R1-A carry) ----

    /// The guardian reviews "HK2 -> HK1" while HK1 is the stake hotkey. Inside the 48 hours, a swap moves HK1's
    /// position to HK5 and the owner follows it at once: the reviewed move would now land on HK5, so its execute
    /// reverts (InvalidParameter), the item kept. A move naming another hotkey than the stake hotkey reverts too;
    /// one naming the stake hotkey runs.
    function test_aScheduledMoveStakeNamesItsDestination() public {
        fund(10e18);
        list(owner, HK2);
        list(owner, HK3);
        chainMoves(HK1, HK2, 3_000_000_000);
        bytes memory reviewed = abi.encodeCall(CascadeVault.moveStake, (HK2, HK1, 3_000_000_000));
        bytes memory elsewhere = abi.encodeCall(CascadeVault.moveStake, (HK2, HK3, 3_000_000_000));
        vm.startPrank(owner);
        bytes32 id = vault.schedule(reviewed);
        vault.schedule(elsewhere);
        vm.stopPrank();

        chainMoves(HK1, HK5, stakeOf(HK1));
        list(keeper, HK5);
        vm.prank(owner);
        vault.setStakeHotkey(HK5);

        Schedule.wait(48 hours);
        vm.startPrank(owner);
        vm.expectRevert(InvalidParameter.selector);
        vault.execute(reviewed);
        vm.expectRevert(InvalidParameter.selector);
        vault.execute(elsewhere);
        vm.stopPrank();
        assertGt(vaultLens.scheduled(id).readyAt, 0, "the item kept");
        assertEq(stakeOf(HK2), 3_000_000_000, "nothing moved");

        bytes memory onto = abi.encodeCall(CascadeVault.moveStake, (HK2, HK5, 3_000_000_000));
        vm.prank(owner);
        vault.schedule(onto);
        Schedule.wait(48 hours);
        vm.expectEmit(address(vault));
        emit StakeMoved(HK2, HK5, 3_000_000_000, 3_000_000_000);
        vm.prank(owner);
        vault.execute(onto);
        assertEq(stakeOf(HK2), 0);
        assertEq(stakeOf(HK5), 10_000_000_000);
    }

    // ---- retained-swap credits (Task 14b; the runtime's HotkeySwapStakeRetained / HotkeySwapBasketCredits) ----

    /// A swap that also retains root rewards as credits on the old hotkey (MockStaking.swapHotkeyWithCredits): the
    /// credits read as unclaimed on `from` and claimRootWithHotkey(from) pays them as stake on `from` or as balance.
    function swapWithCredits(bytes32 from, bytes32 to, uint256 movedBps, uint256 creditRao, bool asStake) internal {
        staking.setCreditsPayTo(asStake);
        staking.swapHotkeyWithCredits(from, to, coldkey(), movedBps, creditRao);
    }

    function claim(bytes32 h) internal {
        vm.prank(keeper);
        vault.claimRewards{gas: 60_000_000}(h);
    }

    /// The credits stay claimable while `from` is listed, booked stake-side only as stake on a listed hotkey, vested
    /// either way, and the claim itself never moves the missing/not-missing verdict.
    function claimableWhileListed(bool asStake, uint256 movedBps) internal {
        fund(10e18);
        uint256 credit = 5_000_000;
        swapWithCredits(HK1, HK5, movedBps, credit, asStake);
        bool missingBefore = vaultLens.stakeMissing();
        assertEq(missingBefore, movedBps != 0, "a retained position misses nothing; a moved one does");
        assertEq(staking.getUnclaimedRootTaoByHotkey(coldkey(), HK1), credit * RAO, "owed on `from`");
        uint256 booked = vaultLens.bookedStake();
        uint256 balance = address(vault).balance;
        uint256 stakeBefore = stakeOf(HK1);

        claim(HK1);

        assertEq(staking.getUnclaimedRootTaoByHotkey(coldkey(), HK1), 0, "claimed");
        assertEq(vaultLens.stakeMissing(), missingBefore, "the claim alone trips nothing");
        if (asStake) {
            assertEq(stakeOf(HK1), stakeBefore + credit, "paid as stake on `from`");
            assertEq(vaultLens.bookedStake(), booked + credit, "booked by the stake delta");
            assertEq(address(vault).balance, balance);
        } else {
            assertEq(stakeOf(HK1), stakeBefore);
            assertEq(vaultLens.bookedStake(), booked, "a balance payment is never booked stake-side");
            assertEq(address(vault).balance, balance + credit * RAO);
        }
        // vests either way: the cut skipped while stake is missing (it is a mint), else taken from the delta
        uint256 fee = missingBefore ? 0 : credit * RAO * vaultLens.rewardCutBps() / 10_000;
        assertEq(vaultLens.vestingAmount(), credit * RAO - fee, "the reward vests");
        assertEq(vaultLens.lastClaimAt(HK1), block.timestamp);
    }

    function test_retainedSwapCreditsClaimableWhileListed_asStake() public {
        claimableWhileListed(true, 0);
    }

    function test_retainedSwapCreditsClaimableWhileListed_asBalance() public {
        claimableWhileListed(false, 0);
    }

    function test_retainedSwapCreditsClaimableWhileListed_asStakeWhileMissing() public {
        claimableWhileListed(true, 4_000);
    }

    function test_retainedSwapCreditsClaimableWhileListed_asBalanceWhileMissing() public {
        claimableWhileListed(false, 4_000);
    }

    /// HK2 held 4 TAO of stake, a validator swapped it to HK5 (unlisted) retaining `credit` rao as credits on HK2:
    /// HK2 now holds no stake, and the credits are what keeps the keeper and the guardian from removing it.
    function keeperRemovalRefusesWhileCredits(bool asStake) internal {
        fund(10e18);
        threeListed();
        uint256 dust = vaultLens.hotkeyDustRao();
        chainMoves(HK1, HK2, 4_000_000_000);
        swapWithCredits(HK2, HK5, 10_000, dust + 1, asStake);
        assertEq(stakeOf(HK2), 0);

        refusedRemove(keeper, HK2, false, NotAuthorized.selector);
        refusedRemove(guardian, HK2, true, NotAuthorized.selector);

        claim(HK2);
        if (asStake) {
            // the credits landed as stake on HK2: still not empty; the chainMoves below stands in for the
            // owner's scheduled move, after which it is empty
            assertEq(stakeOf(HK2), dust + 1);
            refusedRemove(keeper, HK2, false, NotAuthorized.selector);
            chainMoves(HK2, HK1, dust + 1);
        }
        assertEq(staking.getUnclaimedRootTaoByHotkey(coldkey(), HK2), 0);
        vm.expectEmit(address(vault));
        emit HotkeyRemoved(HK2, 0, false);
        vm.prank(keeper);
        vault.removeHotkey(HK2, false);
        assertFalse(vaultLens.isHotkey(HK2));
        assertEq(vaultLens.hotkeyCount(), 2);
    }

    function test_keeperRemovalRefusesWhileCreditsAboveDust_asStake() public {
        keeperRemovalRefusesWhileCredits(true);
    }

    function test_keeperRemovalRefusesWhileCreditsAboveDust_asBalance() public {
        keeperRemovalRefusesWhileCredits(false);
    }

    /// Credits at the dust allowance do not hold the keeper (the existing dust rule), the guardian likewise.
    function test_guardianRemovesAHotkeyWhoseCreditsAreAtTheDust() public {
        fund(10e18);
        threeListed();
        uint256 dust = vaultLens.hotkeyDustRao();
        chainMoves(HK1, HK2, 4_000_000_000);
        swapWithCredits(HK2, HK5, 10_000, dust, true);
        vm.expectEmit(address(vault));
        emit HotkeyRemoved(HK2, dust * RAO, false);
        vm.prank(guardian);
        vault.removeHotkey(HK2, false);
    }

    /// Full and stake missing, a stranger cannot remove a hotkey with ANY unclaimed credits (one rao); once claimed
    /// (and empty) they can, and the freed slot takes the second swap's new hotkey (I-6, end to end).
    function strangerRemovalRefusesWhileCredits(bool asStake) internal {
        fund(10e18);
        threeListed();
        chainMoves(HK1, HK2, 3_000_000_000);
        // the validator behind HK2 swaps to HK5, retaining one rao of credits on HK2
        swapWithCredits(HK2, HK5, 10_000, 1, asStake);
        assertTrue(vaultLens.stakeMissing());
        list(stranger, HK5);
        assertEq(vaultLens.hotkeyCount(), 4);
        assertFalse(vaultLens.stakeMissing());
        // a second swap: full and missing
        chainMoves(HK1, HK6, 3_000_000_000);
        assertTrue(vaultLens.stakeMissing());
        assertEq(stakeOf(HK2), 0);

        refusedRemove(stranger, HK2, false, NotAuthorized.selector);
        refusedAdd(stranger, HK6, TooManyHotkeys.selector);

        claim(HK2);
        assertEq(staking.getUnclaimedRootTaoByHotkey(coldkey(), HK2), 0);
        assertTrue(vaultLens.stakeMissing(), "the claim alone changes nothing");
        if (asStake) {
            assertEq(stakeOf(HK2), 1);
            refusedRemove(stranger, HK2, false, NotAuthorized.selector);
            // stands in for the owner's scheduled move; a stranger cannot clear stake
            chainMoves(HK2, HK1, 1);
        }
        vm.expectEmit(address(vault));
        emit HotkeyRemoved(HK2, 0, false);
        vm.prank(stranger);
        vault.removeHotkey(HK2, false);
        assertEq(vaultLens.hotkeyCount(), 3);

        list(stranger, HK6);
        assertFalse(vaultLens.stakeMissing());
        assertEq(vaultLens.hotkeyCount(), 4);
    }

    function test_strangerRemovalRefusesWhileCreditsUnclaimed_asStake() public {
        strangerRemovalRefusesWhileCredits(true);
    }

    function test_strangerRemovalRefusesWhileCreditsUnclaimed_asBalance() public {
        strangerRemovalRefusesWhileCredits(false);
    }

    /// Credits paid as stake leave stake on the old hotkey, so with the set full and a second swap neither the keeper
    /// nor a stranger can remove it: the way back is the owner's removeHotkey, which moves the leftover to the stake
    /// hotkey at once (value-neutral), after which a stranger lists the second swap's new hotkey.
    function test_stakePaidCreditsLeaveTheWayBackToTheOwner() public {
        fund(10e18);
        threeListed();
        chainMoves(HK1, HK2, 3_000_000_000);
        swapWithCredits(HK2, HK5, 10_000, 5_000_000, true);
        list(stranger, HK5);
        chainMoves(HK1, HK6, 3_000_000_000);
        assertEq(vaultLens.hotkeyCount(), 4);
        assertTrue(vaultLens.stakeMissing());

        claim(HK2);
        assertEq(stakeOf(HK2), 5_000_000, "the credits landed as stake on HK2");
        refusedRemove(keeper, HK2, false, NotAuthorized.selector);
        refusedRemove(stranger, HK2, false, NotAuthorized.selector);

        uint256 booked = vaultLens.bookedStake();
        uint256 visible = vaultLens.visibleStakeRao();
        uint256 stakeHk = stakeOf(HK1);
        vm.prank(owner);
        vault.removeHotkey(HK2, false);
        assertFalse(vaultLens.isHotkey(HK2));
        assertEq(stakeOf(HK2), 0);
        assertEq(stakeOf(HK1), stakeHk + 5_000_000, "moved to the stake hotkey at once");
        assertEq(vaultLens.bookedStake(), booked, "value-neutral");
        assertEq(vaultLens.visibleStakeRao(), visible, "value-neutral");
        assertTrue(vaultLens.stakeMissing());

        list(stranger, HK6);
        assertFalse(vaultLens.stakeMissing());
    }
}
