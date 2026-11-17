// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm, VmSafe} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeBase} from "../../src/CascadeBase.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {ICascadeTwap} from "../../src/interfaces/ICascadeTwap.sol";
import {ISTAKING_ADDRESS} from "../../src/interfaces/IStaking.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {Actor, DoorState, Item, Kind} from "../../src/CascadeTypes.sol";
import {MIN_REDEEM_VALUE, RAO} from "../../src/CascadeConstants.sol";
import {
    AboveBridgeCap,
    BadStamp,
    BridgeNotEnabled,
    ExitsNotOpen,
    FrontDoorInactive,
    LapsedItem,
    NotAuthorized,
    NotBridge,
    NotCanceller,
    NotGuardian,
    PeerNotActive,
    PrimaryBridgeDisabled,
    PrimaryStillEnabled,
    StakeMissing,
    TooManyHotkeys,
    UnknownOrigin,
    UnknownPeer,
    UnstakeShort
} from "../../src/CascadeErrors.sol";
import {Cancelled, RedeemReversed} from "../../src/CascadeEvents.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {defaultFrontDoorParams} from "../utils/DefaultParams.sol";
import {ExitsFixture, ExitsKeeper} from "./ExitsFixture.sol";
import {Schedule} from "./Schedule.sol";

/// @dev The exits machine, rows 1 to 5 of spec §3.6's scenario table, `T-6` and `T-R` (Tasks 40, 41a and 41b):
/// one test per cell, each asserting the cell's outcome and its bound as the table states them (the cell quoted above
/// its test), on the real contracts in GovernanceFixture's two-chain world (ExitsFixture: twenty launch-door holders
/// and a direct one, all staked). Columns:
/// SO the owner key stolen (the honest owner cannot act; the guardian is honest), SG the guardian key stolen, SOG both,
/// HO the honest owner in a real incident. Every delay is the contract's (pinned to the table's in the setUp) and every
/// bound is measured with it, in time and in blocks (`_executeAtReady`); every "users can still" is a probe of the exit
/// itself, run in a snapshot (a direct exit, a door exit end to end, a queued payout, a rogue door's delivery). CO, the
/// owner's seed copied (both keys, one Ledger), is each row's SO script under the copy (`_copySeed`: Task 39b's sweeper
/// and 12-hour stack, the founder acting only through the stack and a fresh staker).
contract ExitsMachineTest is ExitsFixture {
    /// A third hotkey, listed by T-6's hotkey management (the chain's mock lists it first).
    bytes32 internal constant HK3 = bytes32(uint256(3));

    function setUp() public {
        _setUpExits();
    }

    function _paused() internal pure returns (bytes4) {
        return Pausable.EnforcedPause.selector;
    }

    function _bridgeUp(CascadeBase t, address b) internal view returns (bool) {
        return _lensOf[address(t)].bridgeEnabled(b);
    }

    function _doorState(address door) internal view returns (DoorState) {
        return c.vaultLens.doorState(c.vaultLens.peerId(BASE, door));
    }

    // =====================================================================================================
    // row 1: the vault's pause
    // =====================================================================================================

    /// Row 1, SO: "state O: no takeover progress; every exit frozen until the thief unpauses; principal safe;
    /// **bound: indefinite freeze, no loss** (as today; the Safe prevents it)".
    /// The H-1 script: the thief (the owner key) schedules the takeover's items from OPEN (a transfer to its own
    /// account, its own guardian, a rogue door), then pauses. Nothing schedules or executes under state O, every exit
    /// is frozen, and after 60 days totalAssets, the supply and every balance are unchanged; only the thief's unpause
    /// ends it. Then the carry (Task 39a's reading 2): a transfer committed and a new owner who acts.
    function test_T1_SO() public {
        CascadeVault v = c.vault;
        bytes memory transfer = _transfer(owner2);
        bytes memory swap = _swap(guardian2);
        bytes memory door = _activateDoor(BASE, rogue);
        _sched(v, transfer);
        _sched(v, swap);
        _sched(v, door);
        // a launch-door redeem queued before the freeze: its payout is an exit too
        _request(holders[0], v.balanceOf(holders[0]) / 5);
        Delivery memory queued = _closeDoor();
        assertTrue(queued.key != bytes32(0), "a payout is queued");
        uint256 assets = c.vaultLens.totalAssets();
        uint256 supply = v.totalSupply();
        uint256 price = c.vaultLens.price();
        uint256 daveShares = v.balanceOf(dave);
        uint256 heldShares = v.balanceOf(holders[2]);

        uint64 t0 = uint64(vm.getBlockTimestamp());
        vm.prank(owner);
        v.pause();
        assertEq(uint8(c.vaultLens.pausedBy()), uint8(Actor.Owner), "the thief's pause records the owner");
        assertEq(c.vaultLens.lastOwnerClose(), t0, "and stamps the owner's clock");
        _assertVault(true, false, "state O");

        // no takeover progress: nothing schedules under state O
        bytes memory closed = _err(ExitsNotOpen.selector);
        _schedRefused(v, transfer, closed, "O: no transfer schedules");
        _schedRefused(v, swap, closed, "O: no guardian swap schedules");
        _schedRefused(v, door, closed, "O: no door schedules");
        _schedRefused(v, abi.encodeCall(v.setOutflowLimits, (5_000, 100e18, 5_000)), closed, "O: no loosening");

        // every exit frozen: direct, through the door, a queued payout; a door request is filed by the rail, not lost
        _assertDirectRefused(_paused(), "O");
        _assertDoorRefused(_paused(), "O");
        assertEq(_payoutErr(queued.key, queued.list), _paused(), "O: a queued payout is refused");
        _request(holders[1], v.balanceOf(holders[1]) / 5);
        Delivery memory filed = _closeDoor();
        assertTrue(filed.failed, "O: a door request made now is filed by the rail");
        assertEq(bytes4(filed.reason), _paused(), "refused by the pause");

        // nothing executes under state O: each item refused at its readyAt (by the hold and the pause's stamp; the
        // blocks are not what refuses it: the warps roll a block a second)
        Schedule.warpTo(t0 + REGISTRY);
        _execRefused(v, door, closed, "O: the rogue door at its 7 days");
        Schedule.warpTo(t0 + GUARDIAN);
        _execRefused(v, transfer, closed, "O: the transfer at its 8 days");
        _execRefused(v, swap, closed, "O: the swap at its 8 days");
        // and dead, not only held: the pause stamped the thief's own clock
        Mark memory m = _mark();
        vm.prank(owner);
        v.unpause();
        _execRefused(v, transfer, closed, "killed by the pause's stamp: the transfer");
        _execRefused(v, swap, closed, "killed by the pause's stamp: the swap");
        _execRefused(v, door, closed, "killed by the pause's stamp: the door");
        _back(m);
        // nobody but the thief ends it
        _refuses(guardian, address(v), abi.encodeCall(v.unpause, ()), _notOwner(guardian), "the guardian cannot");
        _refuses(stranger, address(v), abi.encodeCall(v.unpause, ()), _notOwner(stranger), "nor anyone else");

        // bound: an indefinite freeze, no loss; 60 days on
        Schedule.warpTo(t0 + 60 days);
        _assertVault(true, false, "still state O on day 60");
        // the clock long past, the hold alone refuses every item
        _schedRefused(v, swap, closed, "day 60: no guardian swap under the owner's hold");
        _schedRefused(v, _transfer(guardian2), closed, "day 60: no transfer");
        _schedRefused(v, _activateDoor(BASE, g.door3), closed, "day 60: no door");
        assertEq(c.vaultLens.totalAssets(), assets, "no loss: totalAssets unchanged after 60 days");
        assertEq(v.totalSupply(), supply, "the supply unchanged");
        assertEq(c.vaultLens.price(), price, "the price unchanged");
        assertEq(v.balanceOf(dave), daveShares, "dave's shares unchanged");
        assertEq(v.balanceOf(holders[2]), heldShares, "a holder's shares unchanged");
        _assertDirectRefused(_paused(), "day 60");
        _assertDoorRefused(_paused(), "day 60");
        assertEq(_payoutErr(queued.key, queued.list), _paused(), "day 60: the queued payout still refused");
        _execRefused(v, transfer, _err(LapsedItem.selector), "the takeover's items lapsed");
        vm.prank(stranger);
        v.prune(keccak256(transfer));

        // until the thief unpauses: then every exit works and nothing was lost
        vm.prank(owner);
        v.unpause();
        _assertVault(false, false, "OPEN once the thief unpauses");
        assertEq(c.vaultLens.lastOwnerClose(), t0, "the unpause stamps nothing");
        Delivery memory retried = _retry(c.bridge);
        assertFalse(retried.failed, "the filed request is delivered");
        assertGt(retried.burned, 0, "and burned");
        uint256 credit = c.fd.claimable(holders[0]);
        _payout(queued.key, queued.list);
        assertEq(
            c.fd.claimable(holders[0]) - credit, queued.burned - FEE, "the queued payout is credited, less its fee"
        );
        _assertDirectWorks("after the unpause");
        _assertDoorWorks("after the unpause");

        // the carry (Task 39a, reading 2): a committed transfer. From OPEN the honest guardian cancels the thief's.
        bytes32 tid = _sched(v, transfer);
        vm.prank(guardian);
        v.cancel(tid);
        assertFalse(_pending(v, transfer), "the guardian's veto");
        // Let run, it executes on day 8, and the pending owner accepts only from OPEN with no closure since
        _sched(v, transfer);
        uint64 ran = _executeAtReady(v, transfer);
        assertEq(v.pendingOwner(), owner2, "pending after its 8 days");
        assertEq(c.vaultLens.pendingSince(), ran, "pendingSince: the execute");
        _lensParity();
        vm.prank(guardian);
        v.pause();
        _refuses(owner2, address(v), abi.encodeCall(v.acceptOwnership, ()), closed, "a closure refuses the acceptance");
        vm.prank(owner);
        v.unpause();
        _refuses(owner2, address(v), abi.encodeCall(v.acceptOwnership, ()), closed, "for good: the clock passed it");
        Schedule.wait(1);
        _sched(v, transfer);
        _executeAtReady(v, transfer);
        vm.prank(owner2);
        v.acceptOwnership();
        assertEq(v.owner(), owner2, "committed: the new owner");
        assertEq(v.pendingOwner(), address(0), "nothing pending");
        assertEq(c.vaultLens.pendingSince(), 0, "pendingSince cleared");
        // the new owner acts, through the same machine; the old key is no one
        _refuses(owner, address(v), abi.encodeCall(CascadeBase.schedule, (swap)), _notOwner(owner), "the old key");
        Schedule.wait(1);
        (bool ok, bytes memory ret) = _stampWith(v, ownerKey, uint64(vm.getBlockTimestamp()));
        assertFalse(ok, "the old key's stamp");
        assertEq(ret, _err(BadStamp.selector), "is no owner's");
        vm.prank(owner2);
        v.pause();
        assertEq(uint8(c.vaultLens.pausedBy()), uint8(Actor.Owner), "the new owner's pause is the owner's");
        assertEq(c.vaultLens.lastOwnerClose(), vm.getBlockTimestamp(), "and stamps the owner's clock");
        _assertVault(true, false, "state O under the new owner");
        _schedRefused(v, swap, closed, "no takeover progress under the new owner's O either");
        Schedule.wait(1);
        (ok,) = _stampWith(v, owner2Key, uint64(vm.getBlockTimestamp()));
        assertTrue(ok, "the new owner's stamp is the owner's");
        assertEq(c.vaultLens.lastOwnerClose(), vm.getBlockTimestamp(), "and moves the owner's clock");
    }

    /// Row 1, SG: "state G: `setGuardian` schedulable and executable; replaced in 8 days; **bound: 8 days**".
    /// The stolen guardian pauses first and re-pauses after every unpause (a pause bot); the owner's `setGuardian`,
    /// scheduled at once under G, executes on day 8, and the exits are open by day 8: direct, through the door, and a
    /// payout queued before the pause.
    function test_T1_SG() public {
        CascadeVault v = c.vault;
        _request(holders[0], v.balanceOf(holders[0]) / 5);
        Delivery memory queued = _closeDoor();
        assertTrue(queued.key != bytes32(0), "a payout is queued");
        uint64 t0 = uint64(vm.getBlockTimestamp());
        vm.prank(guardian);
        v.pause();
        assertEq(uint8(c.vaultLens.pausedBy()), uint8(Actor.Guardian), "the stolen guardian's pause");
        assertEq(c.vaultLens.lastGuardianClose(), t0, "stamps the guardian's clock");
        assertEq(c.vaultLens.lastOwnerClose(), 0, "and not the owner's");
        _assertVault(false, true, "state G");

        // setGuardian schedulable under G: no owner hold, and the owner's clock untouched
        bytes memory swap = _swap(guardian2);
        bytes32 id = _sched(v, swap);
        assertEq(uint8(_kind(v, swap)), uint8(Kind.GuardianSwap), "a GuardianSwap");
        _refuses(guardian, address(v), abi.encodeCall(v.cancel, (id)), _err(NotCanceller.selector), "owner-only");
        _assertDirectRefused(_paused(), "G");
        _assertDoorRefused(_paused(), "G");
        assertEq(_payoutErr(queued.key, queued.list), _paused(), "G: a queued payout is refused");

        // the pause bot: each unpause answered by a re-pause in the same block, each stamping the guardian's clock
        for (uint256 d = 1; d < 8; ++d) {
            Schedule.warpTo(t0 + d * 1 days);
            vm.prank(owner);
            v.unpause();
            vm.prank(guardian);
            v.pause();
            assertEq(c.vaultLens.lastGuardianClose(), vm.getBlockTimestamp(), "the bot's re-pause stamps");
            assertTrue(_pending(v, swap), "the swap survives every re-pause");
            _assertDirectRefused(_paused(), "under the bot");
            _assertDoorRefused(_paused(), "under the bot");
        }

        // day 8: the swap executes, still under the bot's pause, at its bound in time and in blocks
        uint64 when = _executeAtReady(v, swap);
        assertEq(when - t0, GUARDIAN, "replaced on day 8: the Guardian class's delay");
        assertEq(GUARDIAN, 8 days, "the table's 8 days");
        assertEq(c.vaultLens.guardian(), guardian2, "the guardian replaced");
        vm.prank(owner);
        v.unpause();
        _refuses(guardian, address(v), abi.encodeCall(v.pause, ()), _err(NotGuardian.selector), "the bot is no one");

        // exits open by day 8
        _assertVault(false, false, "OPEN on day 8");
        _assertDirectWorks("day 8");
        _assertDoorWorks("day 8");
        uint256 credit = c.fd.claimable(holders[0]);
        _payout(queued.key, queued.list);
        assertEq(
            c.fd.claimable(holders[0]) - credit, queued.burned - FEE, "day 8: the queued payout credited, less its fee"
        );
    }

    /// Row 1, SOG: "O or G at will; nothing to veto them; a rogue door needs **7 OPEN days** (no guardian swap is
    /// needed when both keys are held), in which the shared allowance lets about 36% of a door's base be paid out at
    /// the floor, first-come, in the worst case found: both keys stolen, each move at once and stamping nothing: the
    /// Base `batchInterval` raised to its 24-hour bound and the open batch rolled every time it falls due empty (anyone
    /// may roll an empty batch), so a delivery comes only every other day (fewer requesters than `maxRedeems`), and the
    /// payout delay raised to its 48-hour bound, which strands the batches queued under the old delay, since
    /// `processPayouts` reads the live delay; what is still queued at the rogue door's ready time the thief cancels and
    /// takes; the defence: one request waiting in the batch when it falls due, anyone's, stops the roll; but only
    /// waiting requests are delivered, so about 59% is paid only when every request is waiting as each batch falls due
    /// (the batch interval and the payout delay raised), with the payout delay raised alone about 67%, with neither
    /// about 74%; guidance: request your exit within the first 3 days (no user controls when others request); these
    /// figures assume no thief-held shares in the queue: a thief with both keys and capital of its own, its requests
    /// first, takes the first-come allowance ahead of honest holders, and about 1.4 times the honest holdings empties
    /// the honest share paid (about 0.6 times with the rolls, 2.1 with the payout delay alone, 2.8 with neither; 3.8
    /// takes all seven days' allowance); with both keys stolen, honest holders may get little or nothing out, and
    /// keeping the two keys apart is the defence; the worst case found; Task 41's tightenings (`test_T6`) are checked
    /// there; a contract change could restore more, the founder's decision (Task 65; any change sized against the roll
    /// of empty batches too, a longer wait before a new front door activates the leading candidate; snapshotting the
    /// payout delay does not cover the rolls; a longer wait does not address crowding, an allowance shared pro rata
    /// among the waiting holders, not first-come, would); **bound: 7 days of open exits on the vault before any
    /// drain**; Base exits can be closed throughout (row 4, or a guardian's door hold cleared by `setGuardian`)" (the
    /// cell as Task 40's rulings restate it: "out" means paid).
    /// Both keys: the thief pauses with either at will and unpauses; a rogue door scheduled from OPEN dies to its own
    /// pause and cannot be scheduled under it; re-scheduled, it needs 7 OPEN days. Runs at the floor from that
    /// schedule, each measured before the door could execute, then the thief's cancel and take at its readyAt, in the
    /// spec's order: every empty due batch rolled with the batch interval and the delay raised (about 36% paid, the
    /// worst case found); every request waiting, the same two raised (about 59%), and the roll's defence, one holder
    /// asking again after each close (no roll lands: 59%); the payout delay raised alone (about 67%); neither (about
    /// 74%); and the crowding the figures assume away, a thief's own stake of about 1.44 times the honest holdings
    /// asking first (the honest share paid: nothing). (Base exits closed by the Base primary are row 4's, Task 41.)
    function test_T1_SOG() public {
        CascadeVault v = c.vault;
        // O or G at will, and nothing vetoes them
        vm.prank(guardian);
        v.pause();
        _assertVault(false, true, "G at will");
        vm.prank(owner);
        v.unpause();
        Schedule.wait(1);
        vm.prank(owner);
        v.pause();
        _assertVault(true, false, "O at will");
        vm.prank(owner);
        v.unpause();
        Schedule.wait(1);

        // a rogue door scheduled from OPEN dies to any closure; none schedules under one
        bytes memory door = _activateDoor(BASE, rogue);
        uint64 ta = uint64(vm.getBlockTimestamp());
        _sched(v, door);
        Schedule.warpTo(ta + 3 days);
        vm.prank(guardian);
        v.pause();
        _schedRefused(v, door, _err(ExitsNotOpen.selector), "no rogue door under a closure");
        vm.prank(owner);
        v.unpause();
        Schedule.warpTo(ta + REGISTRY);
        _execRefused(v, door, _err(ExitsNotOpen.selector), "the closure on day 3 killed it");

        // re-scheduled from OPEN; the thief holds every limit at its floor; dave leaves directly, whole (no window)
        Schedule.wait(1);
        uint64 t0 = uint64(vm.getBlockTimestamp());
        _sched(v, door);
        _tightenToTheFloor();
        uint256 daveBefore = dave.balance;
        uint256 daveAll = v.balanceOf(dave);
        vm.prank(dave);
        v.redeemDirect(daveAll, false);
        assertGe(dave.balance - daveBefore, DIRECT - 1e15, "a direct exit, whole and at once");

        // seven days of open exits on the vault: a run through the launch door at the floor, at the launch's 24-hour
        // payout delay; at the door's readyAt the thief takes the last day's batch
        Mark memory run = _mark();
        Run memory r = _runAtTheFloor(t0, 7, rogue);
        (uint64 when, uint256 reminted, uint256 taken) = _theThiefTakesWhatIsQueued(r, door, rogue);
        assertEq(when - t0, REGISTRY, "the rogue door needs 7 OPEN days");
        assertEq(REGISTRY, 7 days, "the table's 7 days");
        _assertShare(r, reminted, taken);

        // the thief can strand a second day's batch (a reading for the controller, Task 40's fix round): the payout
        // delay raised to its 48-hour bound a second before the sixth day's payouts (a tightening: at once, stamping
        // nothing) leaves the fifth and sixth days' batches queued at the door's readyAt, the fifth due in that very
        // second; about 67% paid before the door could execute, 1 - 0.8^5 by the vault's numbers
        _back(run);
        r = _runAtTheFloor(t0, 7, rogue, 6);
        (when, reminted, taken) = _theThiefTakesWhatIsQueued(r, door, rogue);
        assertEq(when - t0, REGISTRY, "the same 7 OPEN days");
        _assertRaisedShare(r, reminted, taken);

        // the stacked tightenings, the worst case found (Task 40's re-review, N-1; the controller's ruling): at the
        // door's scheduling the thief also raises the Base batch interval to 24 hours and rolls the empty open batch,
        // so the first close waits a day and six deliveries fit before the door, from t0 + 1 d; then the payout delay
        // raised a second before the fifth of them is due strands the fifth and sixth: about 59% paid, 1 - 0.8^4 by
        // the vault's numbers. Nothing stamps on either chain.
        _back(run);
        uint64 ownerClock = c.vaultLens.lastOwnerClose();
        uint64 guardianClock = c.vaultLens.lastGuardianClose();
        _holdTheFirstClose();
        r = _runAtTheFloor(t0 + 1 days, 6, rogue, 5);
        assertEq(c.vaultLens.lastOwnerClose(), ownerClock, "the stacked moves stamp nothing: the owner's clock");
        assertEq(c.vaultLens.lastGuardianClose(), guardianClock, "nor the guardian's");
        assertTrue(c.doorLens.exitsOpen(), "the front door OPEN throughout");
        (when, reminted, taken) = _theThiefTakesWhatIsQueued(r, door, rogue);
        assertEq(when - t0, REGISTRY, "the same 7 OPEN days");
        _assertStackedShare(r, reminted, taken);

        // the ordering check found one that strands more, under a condition (Task 40 round 2, reported): users who ask
        // only as each day starts leave the batch empty after each close until it comes due, and the thief rolls it
        // every time (anyone may), so a delivery comes every other day from t0 + 1 d, three before the door; the payout
        // delay raised before the third is paid strands it: about 36% paid, 1 - 0.8^2. A request waiting in the open
        // batch when it comes due (one user's suffices) prevents each roll, which leaves the case above.
        _back(run);
        _holdTheFirstClose();
        r = _runAtTheFloor(t0 + 1 days, 6, rogue, 5, true);
        assertEq(c.vaultLens.lastOwnerClose(), ownerClock, "the rolls stamp nothing: the owner's clock");
        assertEq(c.vaultLens.lastGuardianClose(), guardianClock, "nor the guardian's");
        assertTrue(c.doorLens.exitsOpen(), "the front door OPEN throughout");
        (when, reminted, taken) = _theThiefTakesWhatIsQueued(r, door, rogue);
        assertEq(when - t0, REGISTRY, "the same 7 OPEN days");
        _assertRolledShare(r, reminted, taken);

        // the roll's defence (Task 40 round 3, Minor 1): the same rolls tried every day, but one holder asks again
        // right after each close, so no batch falls due empty: no roll lands and a delivery comes every day; with every
        // request waiting as each batch falls due, the stacked case's 59%
        _back(run);
        _holdTheFirstClose();
        r = _runAtTheFloor(t0 + 1 days, 6, rogue, RunPlan(5, true, true, address(0)));
        assertEq(r.rolls, 0, "the defence: no roll lands, the batch never empty when it falls due");
        assertEq(r.deliveries, 6, "a delivery every day");
        (when, reminted, taken) = _theThiefTakesWhatIsQueued(r, door, rogue);
        _assertStackedShare(r, reminted, taken);

        // the crowded allowance (Task 40 round 3, N-2; the controller's ruling): a thief with capital of its own in the
        // launch door's queue, its requests first each day, takes the first-come allowance ahead of the honest holders.
        // Before scheduling its door it loosens the entry limit to the message limit (48 h, Ordinary: one entry can
        // then take a day's allowance; at the launch's 10-TAO limit it would split its stake across addresses) and
        // deposits the least stake that empties the honest share paid before the door, every request waiting (the
        // batch interval and the delay raised, as the third branch): T* = H (1 - 0.8^4) / 0.8^4, about 1.44 times the
        // honest holdings H, from the vault's numbers.
        _back(run);
        _crowd(door);
    }

    /// The fifth branch of `test_T1_SOG` (see there), from its mark at the door's first scheduling.
    function _crowd(bytes memory door) internal {
        CascadeVault v = c.vault;
        address crowder = makeAddr("the thief's own holder");
        uint256 honest;
        for (uint256 i; i < HOLDERS; ++i) {
            honest += _valueOf(holders[i]);
        }
        uint256 q = 10_000 - Math.min(c.vaultLens.maxDailyOutflowBps(), c.vaultLens.globalOutflowBps());
        uint256 stake = honest * (10_000 ** 4 - q ** 4) / q ** 4 + 1e18;
        uint256 message = c.vaultLens.maxMessageValue();
        bytes memory entries = abi.encodeCall(v.setMessageLimits, (message, message, c.vaultLens.minChunk()));
        _sched(v, entries);
        c.tao.mint(crowder, stake);
        vm.prank(crowder);
        c.tao.approve(address(c.fd), type(uint256).max);
        vm.prank(crowder);
        c.fd.deposit(stake);
        Delivery memory deposited = _closeDoor();
        assertFalse(deposited.failed, "the thief's capital delivered");
        vm.prank(address(keeperC));
        v.stakeIdle();
        _executeAtReady(v, entries);
        assertEq(c.vaultLens.maxEntryValue(), message, "one entry can take a day's allowance");
        assertEq(c.vaultLens.redeemOrigin(crowder), BASE, "a launch-door holder");
        assertApproxEqAbs(_valueOf(crowder), stake, 1e12, "its shares: its stake");
        // the door scheduled again from OPEN, nothing stamped since; then the third branch's moves
        uint64 t1 = uint64(vm.getBlockTimestamp());
        _sched(v, door);
        uint64 ownerClock = c.vaultLens.lastOwnerClose();
        uint64 guardianClock = c.vaultLens.lastGuardianClose();
        _holdTheFirstClose(crowder);
        Run memory r = _runAtTheFloor(t1 + 1 days, 6, rogue, RunPlan(5, false, false, crowder));
        assertEq(c.vaultLens.lastOwnerClose(), ownerClock, "nothing stamps: the owner's clock");
        assertEq(c.vaultLens.lastGuardianClose(), guardianClock, "nor the guardian's");
        assertApproxEqAbs(r.base0, honest + stake, 1e15, "the base: the honest holdings and the thief's stake");
        (uint64 when, uint256 reminted, uint256 taken) = _theThiefTakesWhatIsQueued(r, door, rogue);
        assertEq(when - t1, REGISTRY, "the same 7 OPEN days");
        _assertCrowdedShare(r, honest, stake, crowder, reminted, taken);
    }

    /// The crowded share: four deliveries paid before the door, each taken whole by the thief's own entry (first
    /// come), so the honest holders are paid nothing; the stake is the least that fills the four, to a TAO: by the
    /// fifth delivery the thief's entry is under a TAO (the stake less the four days' allowances, (H + T) (1 - 0.8^4),
    /// leaves 0.8^4 of the TAO added), and a TAO less would leave the honest holders that much of the fourth.
    function _assertCrowdedShare(
        Run memory r,
        uint256 honest,
        uint256 stake,
        address crowder,
        uint256 reminted,
        uint256 taken
    ) internal {
        _logShare(r, reminted, taken);
        emit log_named_decimal_uint("the honest holdings, TAO", honest, 18);
        emit log_named_decimal_uint("the thief's own stake, TAO", stake, 18);
        emit log_named_decimal_uint("the thief's stake, times the honest holdings", stake * 100 / honest, 2);
        emit log_named_decimal_uint("the honest share paid before the door, TAO", r.honestPaid, 18);
        assertGe(stake * 100 / honest, 144, "about 1.44 times the honest holdings");
        assertLt(stake * 100 / honest, 145, "1 - 0.8^4 over 0.8^4");
        assertEq(r.honestPaid, 0, "crowded out: the honest holders paid nothing before the door");
        assertGe(r.daysDeferred, 4, "the honest redeems deferred on every paid delivery");
        assertLe(r.paid, r.predictedPaid, "paid, all the thief's: no more than the allowances allow");
        assertGe(r.paid + 4 * MIN_REDEEM_VALUE, r.predictedPaid, "the four days' allowances, less their clipping");
        assertEq(r.queuedKeys.length, 2, "two batches queued at the door's ready time");
        assertEq(r.burned, r.paid + r.queued, "every batch but the two paid, whole");
        uint256 lastOwn;
        for (uint256 i; i < r.queuedLists[0].length; ++i) {
            if (r.queuedLists[0][i].user == crowder) lastOwn += r.queuedLists[0][i].assets;
        }
        assertLt(lastOwn, 1e18, "the least stake, to a TAO: by the fifth delivery the thief's entry is under a TAO");
        assertGt(lastOwn, 0, "and the thief's entry is still first");
        assertEq(reminted, r.queued, "the thief's cancels re-mint both batches' value");
        uint256 allowance = Math.max(_base() * c.vaultLens.globalOutflowBps() / 10_000, c.vaultLens.minDailyOutflow());
        assertLe(taken, allowance, "at once, the window's allowance");
        assertGe(taken + MIN_REDEEM_VALUE, allowance, "all of it");
    }

    /// The run's share (Task 40's I-1 ruling: "out" means paid, beyond the vault's and the thief's reach): what the
    /// vault paid out before the rogue door's earliest execute (its readyAt less a second), of the door's base at the
    /// first delivery, against the table's restated figure (about 74%) and against what the vault's own numbers
    /// predict: six days' allowances, 1 - 0.8^6 = 73.79% while 20% of the base is above the 10-TAO floor (it is: the
    /// sixth day's is 65.5 TAO of a 1,000 TAO base). The measured share is the vault's numbers less what each day's
    /// clipping defers, under a MIN_REDEEM_VALUE a day. What the seven days burned is the paid share and the last
    /// day's batch, which is still queued at the door's readyAt, and which the thief cancels and takes at once
    /// (`reminted`, `taken`).
    function _assertShare(Run memory r, uint256 reminted, uint256 taken) internal {
        _logShare(r, reminted, taken);
        uint256 paidBps = r.paid * 10_000 / r.base0;
        uint256 predictedBps = r.predictedPaid * 10_000 / r.base0;
        assertGe(predictedBps, 7_375, "the vault's numbers: 1 - 0.8^6 of the base paid in 6 days");
        assertLt(predictedBps, 7_385, "the vault's numbers: 73.79%");
        assertLe(r.paid, r.predictedPaid, "paid: no more than the allowances allow");
        assertGe(r.paid + 6 * MIN_REDEEM_VALUE, r.predictedPaid, "paid: each day's allowance, less its clipping");
        assertGe(paidBps, 7_375, "about 74% of the door's base paid before the rogue door can execute");
        assertLt(paidBps, 7_385, "and no more: the last day's batch is still queued");
        // the burns: the seven days' allowances (79%), the last day's batch queued at the door's ready time
        assertApproxEqAbs(r.burned, r.predicted, 7 * MIN_REDEEM_VALUE, "burned is what the allowance allows");
        assertEq(r.queuedKeys.length, 1, "one batch queued at the door's ready time: the last day's");
        assertEq(r.burned, r.paid + r.queued, "every batch but the last paid, whole");
        assertEq(reminted, r.queued, "the thief's cancel re-mints the last batch's value");
        assertLe(taken, reminted, "the thief takes no more than it re-minted");
        // whole, at once, but for an entry queued at the door's minimum (merge 7b, with R4's S-L1): a clip to the
        // allowance keeps its holder at least MIN_REDEEM_VALUE, so that holder's next request queues exactly that; the
        // cancel re-mints it at the price then, which redeems a rounding under the minimum, so the forged delivery
        // defers it and it stays with its holder
        uint256 atTheMinimum;
        for (uint256 i; i < r.queuedLists[0].length; ++i) {
            if (r.queuedLists[0][i].assets == MIN_REDEEM_VALUE) atTheMinimum += MIN_REDEEM_VALUE;
        }
        assertApproxEqAbs(taken + atTheMinimum, reminted, 1e12, "the thief takes the last day's batch, whole, at once");
        assertGt(r.daysDeferred, 0, "the allowance bound: later requests waited, first come");
    }

    /// The same share with the payout delay raised on the sixth day: the fifth and sixth days' batches queued at the
    /// door's readyAt; paid, five days' allowances, 1 - 0.8^5 = 67.23% by the vault's numbers; the thief re-mints both
    /// and its forged delivery takes the window's allowance at once (20% of the base then), the rest of the re-minted
    /// shares in later windows.
    function _assertRaisedShare(Run memory r, uint256 reminted, uint256 taken) internal {
        _logShare(r, reminted, taken);
        uint256 paidBps = r.paid * 10_000 / r.base0;
        uint256 predictedBps = r.predictedPaid * 10_000 / r.base0;
        assertEq(c.vaultLens.payoutDelay(), 48 hours, "the payout delay at its bound");
        assertGe(predictedBps, 6_720, "the vault's numbers: 1 - 0.8^5 of the base paid in 5 days");
        assertLt(predictedBps, 6_730, "the vault's numbers: 67.23%");
        assertLe(r.paid, r.predictedPaid, "paid: no more than the allowances allow");
        assertGe(r.paid + 5 * MIN_REDEEM_VALUE, r.predictedPaid, "paid: each day's allowance, less its clipping");
        assertGe(paidBps, 6_720, "about 67% paid before the rogue door can execute");
        assertLt(paidBps, 6_730, "and no more: two days' batches still queued");
        assertApproxEqAbs(r.burned, r.predicted, 7 * MIN_REDEEM_VALUE, "burned is what the allowance allows");
        assertEq(r.queuedKeys.length, 2, "two batches queued at the door's ready time: the fifth and sixth days'");
        assertEq(r.burned, r.paid + r.queued, "every batch but the two paid, whole");
        assertEq(reminted, r.queued, "the thief's cancels re-mint both batches' value");
        uint256 allowance = Math.max(_base() * c.vaultLens.globalOutflowBps() / 10_000, c.vaultLens.minDailyOutflow());
        assertLe(taken, allowance, "at once, the window's allowance");
        assertGe(taken + MIN_REDEEM_VALUE, allowance, "all of it");
    }

    /// The stacked share: six deliveries from t0 + 1 d, the payout delay raised before the fifth is paid, so the fifth
    /// and sixth are queued at the door's readyAt; paid, four days' allowances, 1 - 0.8^4 = 59.04% by the vault's
    /// numbers; the thief re-mints both and takes the window's allowance at once.
    function _assertStackedShare(Run memory r, uint256 reminted, uint256 taken) internal {
        _logShare(r, reminted, taken);
        uint256 paidBps = r.paid * 10_000 / r.base0;
        uint256 predictedBps = r.predictedPaid * 10_000 / r.base0;
        assertEq(c.fd.batchInterval(), 24 hours, "the batch interval at its bound");
        assertEq(c.vaultLens.payoutDelay(), 48 hours, "the payout delay at its bound");
        assertGe(predictedBps, 5_900, "the vault's numbers: 1 - 0.8^4 of the base paid in 4 days");
        assertLt(predictedBps, 5_910, "the vault's numbers: 59.04%");
        assertLe(r.paid, r.predictedPaid, "paid: no more than the allowances allow");
        assertGe(r.paid + 4 * MIN_REDEEM_VALUE, r.predictedPaid, "paid: each day's allowance, less its clipping");
        assertGe(paidBps, 5_900, "about 59% paid before the rogue door can execute");
        assertLt(paidBps, 5_910, "and no more: the first close held a day, two batches queued");
        assertApproxEqAbs(r.burned, r.predicted, 6 * MIN_REDEEM_VALUE, "burned is what the allowance allows");
        assertEq(r.queuedKeys.length, 2, "two batches queued at the door's ready time: the fifth and sixth");
        assertEq(r.burned, r.paid + r.queued, "every batch but the two paid, whole");
        assertEq(reminted, r.queued, "the thief's cancels re-mint both batches' value");
        uint256 allowance = Math.max(_base() * c.vaultLens.globalOutflowBps() / 10_000, c.vaultLens.minDailyOutflow());
        assertLe(taken, allowance, "at once, the window's allowance");
        assertGe(taken + MIN_REDEEM_VALUE, allowance, "all of it");
    }

    /// The share with every empty due batch rolled: three deliveries, from t0 + 1 d every other day, the payout delay
    /// raised before the third is paid; paid, two deliveries' allowances, 1 - 0.8^2 = 36% by the vault's numbers; the
    /// thief re-mints the third and takes it at once (the window's allowance is its size: the same base).
    function _assertRolledShare(Run memory r, uint256 reminted, uint256 taken) internal {
        _logShare(r, reminted, taken);
        uint256 paidBps = r.paid * 10_000 / r.base0;
        uint256 predictedBps = r.predictedPaid * 10_000 / r.base0;
        assertEq(r.deliveries, 3, "a delivery every other day: three before the door");
        assertEq(c.vaultLens.payoutDelay(), 48 hours, "the payout delay at its bound");
        assertGe(predictedBps, 3_595, "the vault's numbers: 1 - 0.8^2 of the base paid in 2 deliveries");
        assertLt(predictedBps, 3_605, "the vault's numbers: 36%");
        assertLe(r.paid, r.predictedPaid, "paid: no more than the allowances allow");
        assertGe(r.paid + 2 * MIN_REDEEM_VALUE, r.predictedPaid, "paid: each delivery's allowance, less its clipping");
        assertGe(paidBps, 3_595, "about 36% paid before the rogue door can execute");
        assertLt(paidBps, 3_605, "and no more: every other day rolled, the third delivery queued");
        assertApproxEqAbs(r.burned, r.predicted, 3 * MIN_REDEEM_VALUE, "burned is what the allowance allows");
        assertEq(r.queuedKeys.length, 1, "one batch queued at the door's ready time: the third delivery's");
        assertEq(r.burned, r.paid + r.queued, "every batch but the third paid, whole");
        assertEq(reminted, r.queued, "the thief's cancel re-mints its value");
        assertLe(taken, reminted, "the thief takes no more than it re-minted");
        assertApproxEqAbs(taken, reminted, 1e12, "the thief takes the third delivery's batch, whole, at once");
    }

    function _logShare(Run memory r, uint256 reminted, uint256 taken) internal {
        emit log_named_decimal_uint("the door's base at the first delivery, TAO", r.base0, 18);
        emit log_named_decimal_uint("paid before the rogue door could execute, TAO", r.paid, 18);
        emit log_named_decimal_uint("paid, % of the base (measured)", r.paid * 10_000 / r.base0, 2);
        emit log_named_decimal_uint("paid, % of the base (the vault's numbers)", r.predictedPaid * 10_000 / r.base0, 2);
        emit log_named_decimal_uint("burned in the 7 days, % of the base", r.burned * 10_000 / r.base0, 2);
        emit log_named_decimal_uint("queued at the door's readyAt, re-minted by the thief, TAO", reminted, 18);
        emit log_named_decimal_uint("taken at once through the rogue door, TAO", taken, 18);
    }

    /// Row 1, HO: "pauses with the guardian account (no owner stamp, so a pending `setGuardian` or Reopen survives),
    /// investigates, unpauses, re-schedules; cost: 48 h to 8 d of delay (the loosenings 48 h or 7 d; a pending
    /// `transferOwnership`, Ordinary in the Guardian class, 8 d)".
    /// Pending at the incident: a Reopen (bridge2, known and disabled), a guardian swap, a Param-class loosening and a
    /// Registry-class activation. The guardian-account pause stamps no owner clock: the swap and the Reopen run at
    /// their own readyAt; the loosenings die; unpaused, re-scheduled, they run a class delay later (48 h, 7 d). The
    /// owner account's pause, in a snapshot, would have killed the swap and the Reopen too. (The 8 days are a pending
    /// transfer's, which such a pause kills too: the Guardian class's delay, measured in `test_T1_SO`'s carry.)
    function test_T1_HO() public {
        CascadeVault v = c.vault;
        bytes memory b2 = _activateBridge(address(g.bridge2));
        _sched(v, b2);
        _executeAtReady(v, b2);
        vm.prank(owner);
        v.disableBridge(address(g.bridge2));
        assertEq(c.vaultLens.lastOwnerClose(), 0, "a non-primary's disable stamps nothing");
        Schedule.wait(1);
        uint64 s = uint64(vm.getBlockTimestamp());
        _sched(v, b2);
        assertEq(uint8(_kind(v, b2)), uint8(Kind.Reopen), "a known bridge's activation: a Reopen");
        bytes memory swap = _swap(guardian2);
        _sched(v, swap);
        bytes memory door = _activateDoor(BASE, g.door3);
        _sched(v, door);
        assertEq(uint8(_kind(v, door)), uint8(Kind.Ordinary), "a new door: Ordinary");
        Schedule.warpTo(s + 5 days);
        bytes memory outflow = abi.encodeCall(v.setOutflowLimits, (2_500, 100e18, 2_000));
        _sched(v, outflow);

        // the incident, day 6
        Schedule.warpTo(s + 6 days);
        uint64 t1 = uint64(vm.getBlockTimestamp());
        // the contrast: the owner account's pause stamps the owner's clock, which kills the swap and the Reopen
        Mark memory m = _mark();
        vm.prank(owner);
        v.pause();
        Schedule.warpTo(s + GUARDIAN);
        vm.prank(owner);
        v.unpause();
        _execRefused(v, swap, _err(ExitsNotOpen.selector), "an owner-account pause kills the swap");
        _execRefused(v, b2, _err(ExitsNotOpen.selector), "and the Reopen");
        _back(m);
        // the honest owner pauses with the guardian account
        vm.prank(guardian);
        v.pause();
        assertEq(c.vaultLens.lastOwnerClose(), 0, "no owner stamp");
        assertEq(c.vaultLens.lastGuardianClose(), t1, "the guardian's clock");
        _assertVault(false, true, "the incident's hold");
        // the Reopen survives: it runs at its own readyAt, while paused
        uint64 when = _executeAtReady(v, b2);
        assertEq(when, s + REGISTRY, "the Reopen on time");
        assertTrue(_bridgeUp(v, address(g.bridge2)), "bridge2 back");
        // investigates; unpauses
        Schedule.warpTo(s + 7 days + 12 hours);
        vm.prank(owner);
        v.unpause();
        assertEq(c.vaultLens.lastOwnerClose(), 0, "the unpause stamps nothing");
        _assertVault(false, false, "OPEN after the investigation");
        // the swap survives: it runs at its own readyAt
        when = _executeAtReady(v, swap);
        assertEq(when, s + GUARDIAN, "the swap on time");
        assertEq(c.vaultLens.guardian(), guardian2, "the guardian replaced as planned");
        // the loosenings died with the closure
        _execRefused(v, outflow, _err(ExitsNotOpen.selector), "the closure killed the Param-class loosening");
        _execRefused(v, door, _err(ExitsNotOpen.selector), "and the Registry-class activation");
        // re-scheduled: each runs a class delay later, the incident's cost
        uint64 r = uint64(vm.getBlockTimestamp());
        _sched(v, outflow);
        _sched(v, door);
        when = _executeAtReady(v, outflow);
        assertEq(when - r, PARAM, "the cost: 48 hours");
        assertEq(c.vaultLens.maxDailyOutflowBps(), 2_500, "the loosening ran");
        when = _executeAtReady(v, door);
        assertEq(when - r, REGISTRY, "the cost: 7 days");
        assertEq(PARAM, 48 hours, "the table's 48 h");
        assertEq(uint8(_doorState(g.door3)), uint8(DoorState.Active), "the activation ran");
        _assertDirectWorks("after the incident");
        _assertDoorWorks("after the incident");
    }

    // =====================================================================================================
    // row 2: removeFrontDoor of the launch chain's last door
    // =====================================================================================================

    /// Row 2, SO: "state O: no progress; direct exits only; re-activation is a Reopen (7 d, owner-cancellable);
    /// **bound: indefinite, no loss**; a door the thief removes ahead of the guardian is still the guardian's to
    /// remove: it becomes unknown, its Reopen dies and, on the launch chain, the hold becomes the guardian's, so it
    /// comes back only after a guardian swap (8 d, then 7)".
    /// The thief removes the launch door: no progress; direct exits only (a launch-door holder's too); 60 days on,
    /// still closed, nothing lost; another chain's Reopen leaves the hold; only the launch door's Reopen (7 days)
    /// brings it back. Then, from the start again: the thief removes it ahead of the guardian, which removes it too.
    function test_T2_SO() public {
        CascadeVault v = c.vault;
        bytes memory reopen = _activateDoor(BASE, address(c.fd));
        // another chain's door, removed by the owner earlier (its last: records and stamps nothing)
        bytes memory d2 = _activateDoor(SECOND_CHAIN, g.door2);
        _sched(v, d2);
        _executeAtReady(v, d2);
        vm.prank(owner);
        v.removeFrontDoor(SECOND_CHAIN, g.door2);
        assertEq(c.vaultLens.lastOwnerClose(), 0, "another chain's last door: no stamp");
        _request(holders[0], v.balanceOf(holders[0]) / 5);
        Delivery memory queued = _closeDoor();
        Schedule.wait(1);
        Mark memory start = _mark();

        uint64 t0 = uint64(vm.getBlockTimestamp());
        uint256 price = c.vaultLens.price();
        uint256 heldShares = v.balanceOf(holders[2]);
        uint256 assets = c.vaultLens.totalAssets();
        uint256 supply = v.totalSupply();
        vm.prank(owner);
        v.removeFrontDoor(BASE, address(c.fd));
        assertEq(uint8(_doorState(address(c.fd))), uint8(DoorState.Removed), "the owner's removal: Removed");
        assertEq(c.vaultLens.activeDoors(BASE), 0, "the launch chain's last door");
        assertEq(uint8(c.vaultLens.launchDoorRemovedBy()), uint8(Actor.Owner), "the owner's hold");
        assertEq(c.vaultLens.lastOwnerClose(), t0, "the owner's clock");
        _assertVault(true, false, "state O");

        // no progress
        bytes memory closed = _err(ExitsNotOpen.selector);
        _schedRefused(v, _transfer(owner2), closed, "O: no transfer");
        _schedRefused(v, _swap(guardian2), closed, "O: no swap");
        _schedRefused(v, _activateDoor(BASE, rogue), closed, "O: no new door");
        // direct exits only
        _assertDirectWorks("O");
        (bytes4 err,) = _directExit(holders[1], v.balanceOf(holders[1]));
        assertEq(err, bytes4(0), "a launch-door holder's own direct exit (an EOA on Bittensor)");
        _assertDoorRefused(UnknownPeer.selector, "O");
        assertEq(_payoutErr(queued.key, queued.list), FrontDoorInactive.selector, "O: the queued payout waits");
        _refuses(
            holders[2],
            address(v),
            abi.encodeCall(v.setRedeemOrigin, (BASE)),
            _err(UnknownOrigin.selector),
            "no door to route to"
        );
        _request(holders[3], v.balanceOf(holders[3]) / 5);
        Delivery memory filed = _closeDoor();
        assertEq(bytes4(filed.reason), UnknownPeer.selector, "a request now is filed by the rail");
        // the re-activation is a Reopen, owner-cancellable: the guardian cannot end it, the thief can
        bytes32 rid = _sched(v, reopen);
        assertEq(uint8(_kind(v, reopen)), uint8(Kind.Reopen), "a Reopen");
        _refuses(guardian, address(v), abi.encodeCall(v.cancel, (rid)), _err(NotCanceller.selector), "owner-only");
        vm.prank(owner);
        v.cancel(rid);
        // another chain's Reopen leaves the launch door's hold
        _sched(v, d2);
        _executeAtReady(v, d2);
        assertEq(uint8(c.vaultLens.launchDoorRemovedBy()), uint8(Actor.Owner), "another chain's door: the hold stays");
        _assertVault(true, false, "still O");

        // bound: indefinite, no loss
        Schedule.warpTo(t0 + 60 days);
        _assertVault(true, false, "state O on day 60");
        _schedRefused(v, _swap(guardian2), closed, "day 60: the hold alone refuses a swap");
        _schedRefused(v, _activateDoor(BASE, rogue), closed, "day 60: and a new door");
        assertEq(c.vaultLens.price(), price, "no loss: the price unchanged");
        assertEq(c.vaultLens.totalAssets(), assets, "totalAssets unchanged");
        assertEq(v.totalSupply(), supply, "the supply unchanged");
        assertEq(v.balanceOf(holders[2]), heldShares, "a holder's shares unchanged");
        _assertDirectWorks("day 60");
        _assertDoorRefused(UnknownPeer.selector, "day 60");

        // only a Reopen of that door brings it back: 7 days
        uint64 tr = uint64(vm.getBlockTimestamp());
        _sched(v, reopen);
        uint64 when = _executeAtReady(v, reopen);
        assertEq(when - tr, REGISTRY, "the Reopen's 7 days");
        _assertVault(false, false, "OPEN");
        assertEq(uint8(_doorState(address(c.fd))), uint8(DoorState.Active), "the door back");
        Delivery memory retried = _retry(c.bridge);
        assertGt(retried.burned, 0, "the filed request delivered");
        _payout(queued.key, queued.list);
        _assertDoorWorks("after the Reopen");

        // ahead of the guardian: the thief removes the door and schedules its Reopen, which the guardian cannot cancel
        _back(start);
        vm.prank(owner);
        v.removeFrontDoor(BASE, address(c.fd));
        Schedule.wait(1);
        rid = _sched(v, reopen);
        // still the guardian's to remove: unknown, its Reopen dies, the hold becomes the guardian's
        vm.expectEmit(true, true, false, false, address(v));
        emit Cancelled(rid, guardian);
        vm.prank(guardian);
        v.removeFrontDoor(BASE, address(c.fd));
        uint64 tg = uint64(vm.getBlockTimestamp());
        assertEq(uint8(_doorState(address(c.fd))), uint8(DoorState.Unknown), "the guardian's: unknown");
        assertFalse(_pending(v, reopen), "its Reopen died");
        assertEq(c.vaultLens.activeDoors(BASE), 0, "not counted out twice");
        assertEq(uint8(c.vaultLens.launchDoorRemovedBy()), uint8(Actor.Guardian), "the hold is the guardian's");
        assertEq(c.vaultLens.lastGuardianClose(), tg, "stamped with the guardian's clock");
        _assertVault(false, true, "the guardian's hold");
        // it comes back only after a guardian swap (8 days), then its Ordinary activation (7)
        _schedRefused(v, reopen, closed, "no activation under the guardian's hold");
        Schedule.wait(1);
        uint64 ts = uint64(vm.getBlockTimestamp());
        bytes memory swap = _swap(guardian2);
        _sched(v, swap);
        when = _executeAtReady(v, swap);
        assertEq(when - ts, GUARDIAN, "the swap: 8 days");
        _assertVault(false, false, "OPEN, no launch door");
        _assertDirectWorks("between the swap and the activation");
        _assertDoorRefused(UnknownPeer.selector, "between the swap and the activation");
        _sched(v, reopen);
        assertEq(uint8(_kind(v, reopen)), uint8(Kind.Ordinary), "now Ordinary");
        when = _executeAtReady(v, reopen);
        assertEq(when - ts, GUARDIAN + REGISTRY, "back only after 8 days, then 7");
        _assertDoorWorks("after 15 days");
    }

    /// Row 2, SG: "state G: `setGuardian` unaffected; the door is now unknown (L-6) and no Ordinary activation can be
    /// scheduled under the guardian's door hold; the swap on day 8 clears its holds (the door's and, had it also
    /// disabled the primary, the bridge's), then the door's Ordinary activation (7 d); a stolen guardian may also
    /// remove a door the owner removed (its Reopen dies; the owner's launch-door hold becomes the guardian's, which the
    /// swap clears); **bound ≤ 15 days and a block**".
    /// The stolen guardian removes the launch door, and disables the primary in the swap's own second, ahead of it
    /// (R1-B M-1): the swap on day 8 clears both holds; the bridge's Reopen runs on day 15 and the door's activation,
    /// which the guardian's stamp in the swap's second pushes a block later, on day 15 and a block. Then, from the
    /// start again, its removal of a door the owner removed.
    function test_T2_SG() public {
        CascadeVault v = c.vault;
        _request(holders[0], v.balanceOf(holders[0]) / 5);
        Delivery memory queued = _closeDoor();
        Mark memory start = _mark();
        bytes memory door = _activateDoor(BASE, address(c.fd));
        bytes memory swap = _swap(guardian2);
        bytes memory closed = _err(ExitsNotOpen.selector);

        uint64 t0 = uint64(vm.getBlockTimestamp());
        vm.prank(guardian);
        v.removeFrontDoor(BASE, address(c.fd));
        assertEq(uint8(_doorState(address(c.fd))), uint8(DoorState.Unknown), "the door unknown");
        assertEq(uint8(c.vaultLens.launchDoorRemovedBy()), uint8(Actor.Guardian), "the guardian's door hold");
        _assertVault(false, true, "state G");
        // setGuardian unaffected
        _sched(v, swap);
        // no Ordinary activation under the guardian's door hold: not the door's, not another
        _schedRefused(v, door, closed, "G: the door's activation");
        _schedRefused(v, _activateDoor(BASE, g.door3), closed, "G: another door's");
        _assertDirectWorks("G");
        _assertDoorRefused(UnknownPeer.selector, "G");

        // in the swap's own second, ahead of it, the thief disables the primary too (R1-B M-1; Task 40's review, M-1)
        uint64 when = _toReady(v, swap);
        vm.prank(guardian);
        v.disableBridge(address(c.bridge));
        assertEq(uint8(c.vaultLens.primaryDisabledBy()), uint8(Actor.Guardian), "the guardian's bridge hold");
        assertEq(c.vaultLens.lastGuardianClose(), when, "stamped in the swap's second");
        // M-4: the door and the bridge both down, a payout names the door first
        assertEq(_payoutErr(queued.key, queued.list), FrontDoorInactive.selector, "the door before the bridge");
        bytes memory reopenBridge = _activateBridge(address(c.bridge));
        _sched(v, reopenBridge);
        assertEq(uint8(_kind(v, reopenBridge)), uint8(Kind.Reopen), "the bridge's Reopen at once (the owner's clock)");

        // day 8: the swap clears both holds; the primary stays disabled until its Reopen
        _executeNow(v, swap);
        assertEq(when - t0, GUARDIAN, "the swap on day 8");
        assertEq(uint8(c.vaultLens.launchDoorRemovedBy()), uint8(Actor.None), "the door's hold cleared");
        assertEq(uint8(c.vaultLens.primaryDisabledBy()), uint8(Actor.None), "the bridge's hold cleared");
        assertFalse(_bridgeUp(v, address(c.bridge)), "the primary still disabled");
        _assertVault(false, false, "OPEN on day 8");
        // the guardian's stamp in this second refuses an Ordinary item at birth: the door's activation a block later
        _schedRefused(v, door, closed, "the door's activation, in the second of the guardian's stamp");
        Schedule.wait(1);
        _sched(v, door);
        assertEq(uint8(_kind(v, door)), uint8(Kind.Ordinary), "the door's activation: Ordinary");
        _assertDirectWorks("days 8 to 15");
        _assertDoorRefused(NotBridge.selector, "days 8 to 15");

        // by day 15 and a block: the bridge's Reopen on day 15, then the door's activation a block later
        uint64 reopened = _executeAtReady(v, reopenBridge);
        assertEq(reopened - t0, GUARDIAN + REGISTRY, "the bridge's Reopen on day 15");
        when = _executeAtReady(v, door);
        assertEq(when - t0, GUARDIAN + REGISTRY + 1, "the door's activation: 15 days and a block (a second here)");
        assertLe(when - t0, 15 days + 1, "bound: 15 days and a block");
        _assertDoorWorks("day 15");
        assertEq(_payoutErr(queued.key, queued.list), bytes4(0), "the queued payout goes out");

        // a stolen guardian may also remove a door the owner removed
        _back(start);
        vm.prank(owner);
        v.removeFrontDoor(BASE, address(c.fd));
        Schedule.wait(1);
        bytes32 rid = _sched(v, door);
        assertEq(uint8(_kind(v, door)), uint8(Kind.Reopen), "the owner's Reopen pending");
        _schedRefused(v, swap, closed, "under the owner's hold no swap schedules");
        uint64 t1 = uint64(vm.getBlockTimestamp());
        vm.expectEmit(true, true, false, false, address(v));
        emit Cancelled(rid, guardian);
        vm.prank(guardian);
        v.removeFrontDoor(BASE, address(c.fd));
        assertFalse(_pending(v, door), "its Reopen dies");
        assertEq(uint8(c.vaultLens.launchDoorRemovedBy()), uint8(Actor.Guardian), "the hold made the guardian's");
        _assertVault(false, true, "state G");
        Schedule.wait(1);
        _sched(v, swap);
        when = _executeAtReady(v, swap);
        _assertVault(false, false, "the swap clears it");
        _sched(v, door);
        when = _executeAtReady(v, door);
        assertLe(when - t1, 15 days + 1, "bound: 15 days and a block (a second of scheduling)");
        assertEq(when - t1, GUARDIAN + REGISTRY + 1, "8 days, then 7");
        _assertDoorWorks("after the guardian's conversion");
    }

    /// Row 2, SOG: "as row 1" (O or G at will; nothing to veto them; a rogue door needs 7 OPEN days, in which the
    /// shared allowance lets about 36% of a door's base be paid out at the floor, first-come, in the worst case found,
    /// every empty due batch rolled with the Base batch interval and the payout delay raised; one request waiting when
    /// a batch falls due stops the roll, and with every request waiting about 59%; about 67% with the delay alone,
    /// about 74% with neither (the case this cell runs; `test_T1_SOG` runs the others); all assuming no thief-held
    /// shares in the queue, which can crowd the honest holders out; bound: 7 days of open exits on the vault before any
    /// drain; Base exits can be closed throughout (row 4, or a guardian's door hold cleared by `setGuardian`)).
    /// Both keys, with the launch door's removal: by either key it kills a rogue door scheduled before it and refuses
    /// one under it. With the owner key, the door's Reopen (7 days) then 7 OPEN days with the door back: the run at the
    /// floor pays about 74% out first, and the thief takes the last day's batch at the door's readyAt. With the
    /// guardian key, the swap (8 days) clears the hold with no launch door: 7 OPEN days with Base exits closed
    /// throughout and direct exits open, before the rogue door.
    function test_T2_SOG() public {
        CascadeVault v = c.vault;
        bytes memory door = _activateDoor(BASE, rogue);
        bytes memory reopen = _activateDoor(BASE, address(c.fd));
        bytes memory closed = _err(ExitsNotOpen.selector);
        Mark memory start = _mark();

        // the owner key
        _sched(v, door);
        Schedule.wait(1 days);
        vm.prank(owner);
        v.removeFrontDoor(BASE, address(c.fd));
        _assertVault(true, false, "O at will");
        _schedRefused(v, door, closed, "O: no rogue door");
        Schedule.wait(1);
        _sched(v, reopen);
        _executeAtReady(v, reopen);
        _assertVault(false, false, "the owner key's way back: the Reopen");
        _execRefused(v, door, closed, "the removal killed the rogue door");
        Schedule.wait(1);
        uint64 t0 = uint64(vm.getBlockTimestamp());
        _sched(v, door);
        _tightenToTheFloor();
        uint256 daveAll = v.balanceOf(dave);
        vm.prank(dave);
        v.redeemDirect(daveAll, false);
        Run memory r = _runAtTheFloor(t0, 7, rogue);
        (uint64 when, uint256 reminted, uint256 taken) = _theThiefTakesWhatIsQueued(r, door, rogue);
        assertEq(when - t0, REGISTRY, "7 OPEN days before the rogue door");
        _assertShare(r, reminted, taken);

        // the guardian key
        _back(start);
        _sched(v, door);
        Schedule.wait(1 days);
        vm.prank(guardian);
        v.removeFrontDoor(BASE, address(c.fd));
        _assertVault(false, true, "G at will");
        _schedRefused(v, door, closed, "G: no rogue door");
        Schedule.wait(1);
        bytes memory swap = _swap(guardian2);
        _sched(v, swap);
        _executeAtReady(v, swap);
        _assertVault(false, false, "the guardian's hold cleared by setGuardian");
        _execRefused(v, door, closed, "the removal killed the rogue door");
        Schedule.wait(1);
        t0 = uint64(vm.getBlockTimestamp());
        _sched(v, door);
        for (uint256 d; d < 7; ++d) {
            Schedule.warpTo(t0 + d * 1 days);
            assertTrue(c.vaultLens.exitsOpen(), "the vault reads OPEN each day");
            _assertDirectWorks("open exits on the vault");
            _assertDoorRefused(UnknownPeer.selector, "Base exits closed throughout");
            (bytes4 err,) = _forgedErr(rogue, holders[0]);
            assertEq(err, UnknownPeer.selector, "no drain yet");
        }
        when = _executeAtReady(v, door);
        assertEq(when - t0, REGISTRY, "7 OPEN days before the rogue door");
    }

    /// Row 2, HO: "a buggy launch door is paused on Base and replaced from OPEN (7 d) before its removal; a removal
    /// meant to last is signed with the **guardian** account (the door becomes unknown; `setGuardian` to the same
    /// guardian clears the hold on day 8, a replacement activates on day 15); the **owner** account removes only for a
    /// temporary hold, which only a Reopen of that door undoes (7 d) unless the guardian account removes the door too,
    /// which makes the removal lasting (row 2 SG's way back, 15 d)".
    /// Four scripts from one start: the replacement from OPEN (a real second front door), the vault OPEN throughout;
    /// a guardian-removed rogue door kept out past a stolen owner key; the lasting removal (the same-guardian swap on
    /// day 8, the replacement on day 15); the temporary one (only its Reopen, 7 days, or the guardian's removal too).
    function test_T2_HO() public {
        CascadeVault v = c.vault;
        CascadeFrontDoor.Params memory fp =
            defaultFrontDoorParams(c.tao, c.bridge, BITTENSOR, address(v), c.usdc, owner, guardian, address(keeperC));
        fp.depositCap = HIGH_CAP;
        fp.redeemRequestFee = REQUEST_FEE;
        fp.oracle = ICascadeTwap(address(c.twap));
        fp.swapper = address(c.staker);
        CascadeFrontDoor replacement = new CascadeFrontDoor(fp);
        c.bridge.connect(BASE, address(replacement), false);
        bytes memory repl = _activateDoor(BASE, address(replacement));
        bytes memory closed = _err(ExitsNotOpen.selector);
        Mark memory start = _mark();

        // a buggy launch door: paused on Base (deposits and deliveries only; it stamps nothing), replaced from OPEN
        uint64 t0 = uint64(vm.getBlockTimestamp());
        vm.prank(owner);
        c.fd.pause();
        assertEq(c.doorLens.lastOwnerClose(), 0, "the front door's pause stamps nothing");
        _assertDoorWorks("exits through the paused buggy door");
        _sched(v, repl);
        uint64 when = _executeAtReady(v, repl);
        assertEq(when - t0, REGISTRY, "the replacement in 7 days");
        assertEq(c.vaultLens.activeDoors(BASE), 2, "both active");
        vm.prank(owner);
        v.removeFrontDoor(BASE, address(c.fd));
        assertEq(c.vaultLens.lastOwnerClose(), 0, "not the launch chain's last: no stamp");
        assertEq(uint8(c.vaultLens.launchDoorRemovedBy()), uint8(Actor.None), "no hold");
        _assertVault(false, false, "OPEN throughout");
        _assertDoorWorks(replacement, "through the replacement");

        // a guardian-removed rogue door kept out past a stolen owner key
        _back(start);
        bytes memory rd = _activateDoor(BASE, rogue);
        _sched(v, rd);
        _executeAtReady(v, rd);
        vm.prank(guardian);
        v.removeFrontDoor(BASE, rogue);
        assertEq(uint8(_doorState(rogue)), uint8(DoorState.Unknown), "the guardian's removal: unknown");
        _assertVault(false, false, "not the last door: no hold");
        bytes32 id = _sched(v, rd);
        assertEq(uint8(_kind(v, rd)), uint8(Kind.Ordinary), "the thief's re-activation is Ordinary");
        vm.prank(guardian);
        v.cancel(id);
        assertFalse(_pending(v, rd), "and the guardian cancels it");
        _refuses(
            owner,
            address(v),
            abi.encodeCall(v.removeFrontDoor, (BASE, rogue)),
            _err(PeerNotActive.selector),
            "the thief cannot make it its own removal"
        );
        (bytes4 err,) = _forgedErr(rogue, holders[0]);
        assertEq(err, UnknownPeer.selector, "kept out");

        // a removal meant to last: the guardian account; the same guardian swapped in on day 8; a replacement on 15
        _back(start);
        t0 = uint64(vm.getBlockTimestamp());
        vm.prank(guardian);
        v.removeFrontDoor(BASE, address(c.fd));
        _assertVault(false, true, "the lasting removal's hold");
        bytes memory same = _swap(guardian);
        _sched(v, same);
        _schedRefused(v, repl, closed, "no replacement under the hold");
        when = _executeAtReady(v, same);
        assertEq(when - t0, GUARDIAN, "the hold cleared on day 8");
        assertEq(c.vaultLens.guardian(), guardian, "the same guardian");
        _assertVault(false, false, "OPEN, no launch door");
        _assertDirectWorks("days 8 to 15");
        _sched(v, repl);
        when = _executeAtReady(v, repl);
        assertEq(when - t0, GUARDIAN + REGISTRY, "the replacement on day 15");
        _assertDoorWorks(replacement, "day 15");

        // a temporary hold: the owner account; only a Reopen of that door undoes it
        _back(start);
        vm.prank(owner);
        v.removeFrontDoor(BASE, address(c.fd));
        _assertVault(true, false, "the temporary hold");
        Schedule.wait(1);
        _schedRefused(v, same, closed, "a swap cannot undo it (the hold, the clock past)");
        _schedRefused(v, repl, closed, "nor a replacement");
        bytes memory reopen = _activateDoor(BASE, address(c.fd));
        uint64 tr = uint64(vm.getBlockTimestamp());
        id = _sched(v, reopen);
        assertEq(uint8(_kind(v, reopen)), uint8(Kind.Reopen), "its Reopen");
        Mark memory held = _mark();
        when = _executeAtReady(v, reopen);
        assertEq(when - tr, REGISTRY, "undone by its Reopen in 7 days");
        _assertVault(false, false, "OPEN");
        _assertDoorWorks("after the Reopen");
        // unless the guardian account removes it too: lasting, row 2 SG's way back
        _back(held);
        uint64 tl = uint64(vm.getBlockTimestamp());
        vm.prank(guardian);
        v.removeFrontDoor(BASE, address(c.fd));
        assertFalse(_pending(v, reopen), "the Reopen is gone");
        assertEq(uint8(c.vaultLens.launchDoorRemovedBy()), uint8(Actor.Guardian), "the hold the guardian's");
        Schedule.wait(1);
        _sched(v, same);
        _executeAtReady(v, same);
        _sched(v, repl);
        when = _executeAtReady(v, repl);
        assertEq(when - tl, GUARDIAN + REGISTRY + 1, "lasting: 8 days, then 7");
        _assertDoorWorks(replacement, "after the lasting removal's way back");
    }

    // =====================================================================================================
    // row 3: disableBridge of the vault's primary
    // =====================================================================================================

    /// Row 3, SO: "state O: as row 2; the only ways back are a Reopen of that bridge (7 d) or a switch to an enabled
    /// bridge: from OPEN, a new bridge (7 d) then disable-and-switch, or, under the hold, a known bridge reopened (7 d,
    /// no gate) then the switch; each needs the owner key and 7 d; **bound: indefinite, no loss**".
    /// The thief disables the vault's primary: no progress, direct exits only, 60 days with nothing lost. In O no new
    /// bridge activates and no switch has a target; a Reopen of another known bridge leaves the primary's hold; the
    /// primary's Reopen (7 days) brings it back. Then, from the start again: from OPEN a new bridge on both chains
    /// (7 days), then the disable and the switch in one step.
    function test_T3_SO() public {
        CascadeVault v = c.vault;
        bytes memory b2 = _activateBridge(address(g.bridge2));
        bytes memory reopen = _activateBridge(address(c.bridge));
        bytes memory closed = _err(ExitsNotOpen.selector);
        Mark memory start = _mark();
        // bridge2 known and disabled (its Reopen below)
        _sched(v, b2);
        _executeAtReady(v, b2);
        vm.prank(owner);
        v.disableBridge(address(g.bridge2));
        _request(holders[0], v.balanceOf(holders[0]) / 5);
        Delivery memory queued = _closeDoor();
        Schedule.wait(1);

        uint64 t0 = uint64(vm.getBlockTimestamp());
        uint256 price = c.vaultLens.price();
        uint256 heldShares = v.balanceOf(holders[2]);
        uint256 assets = c.vaultLens.totalAssets();
        uint256 supply = v.totalSupply();
        vm.prank(owner);
        v.disableBridge(address(c.bridge));
        assertEq(uint8(c.vaultLens.primaryDisabledBy()), uint8(Actor.Owner), "the owner's bridge hold");
        assertEq(c.vaultLens.lastOwnerClose(), t0, "the owner's clock");
        _assertVault(true, false, "state O");
        // as row 2: no progress, direct exits only
        _schedRefused(v, _transfer(owner2), closed, "O: no transfer");
        _schedRefused(v, _swap(guardian2), closed, "O: no swap");
        _schedRefused(v, _activateDoor(BASE, rogue), closed, "O: no new door");
        _assertDirectWorks("O");
        _assertDoorRefused(NotBridge.selector, "O");
        assertEq(_payoutErr(queued.key, queued.list), PrimaryBridgeDisabled.selector, "O: the queued payout waits");
        _request(holders[3], v.balanceOf(holders[3]) / 5);
        Delivery memory filed = _closeDoor();
        assertEq(bytes4(filed.reason), NotBridge.selector, "a request now is filed by the rail");
        // no other way back: a new bridge cannot activate under O; a switch needs an enabled bridge
        _schedRefused(v, _activateBridge(makeAddr("a new bridge")), closed, "O: no new bridge");
        _refuses(
            owner,
            address(v),
            abi.encodeCall(v.setPrimaryBridge, (address(g.bridge2))),
            _err(BridgeNotEnabled.selector),
            "no enabled bridge to switch to"
        );
        // a Reopen of another known bridge (no gate) runs, and leaves the primary's hold
        _sched(v, b2);
        _executeAtReady(v, b2);
        assertTrue(_bridgeUp(v, address(g.bridge2)), "bridge2 enabled again");
        assertEq(uint8(c.vaultLens.primaryDisabledBy()), uint8(Actor.Owner), "the primary's hold stays");
        _assertVault(true, false, "still O");
        // (a reading: that Reopen makes bridge2 a switch target, a way back the cell does not list, as long as a
        // Reopen: 7 days)
        Mark memory third = _mark();
        uint32 chunk0 = c.vaultLens.minChunk();
        vm.prank(owner);
        v.setMessageLimits(BRIDGE2_CAP, BRIDGE2_CAP, chunk0);
        vm.prank(owner);
        v.setPrimaryBridge(address(g.bridge2));
        _assertVault(false, false, "a reopened known bridge, switched to");
        _back(third);
        vm.prank(owner);
        v.disableBridge(address(g.bridge2));

        // bound: indefinite, no loss
        Schedule.warpTo(t0 + 60 days);
        _assertVault(true, false, "state O on day 60");
        _schedRefused(v, _swap(guardian2), closed, "day 60: the hold alone refuses a swap");
        _schedRefused(v, _activateDoor(BASE, rogue), closed, "day 60: and a new door");
        assertEq(c.vaultLens.price(), price, "no loss");
        assertEq(c.vaultLens.totalAssets(), assets, "totalAssets unchanged");
        assertEq(v.totalSupply(), supply, "the supply unchanged");
        assertEq(v.balanceOf(holders[2]), heldShares, "a holder's shares unchanged");
        _assertDirectWorks("day 60");

        // a Reopen of that bridge: 7 days
        uint64 tr = uint64(vm.getBlockTimestamp());
        _sched(v, reopen);
        assertEq(uint8(_kind(v, reopen)), uint8(Kind.Reopen), "a Reopen");
        uint64 when = _executeAtReady(v, reopen);
        assertEq(when - tr, REGISTRY, "7 days");
        _assertVault(false, false, "OPEN");
        Delivery memory retried = _retry(c.bridge);
        assertGt(retried.burned, 0, "the filed request delivered");
        _payout(queued.key, queued.list);
        _assertDoorWorks("after the Reopen");

        // from OPEN, a new bridge (7 days, on both chains), then the disable and the switch in one step
        _back(start);
        _sched(v, b2);
        Schedule.wait(1);
        _sched(c.fd, b2);
        _lensParity();
        _executeAtReady(v, b2);
        _executeAtReady(c.fd, b2);
        _refuses(
            owner,
            address(v),
            abi.encodeCall(v.setPrimaryBridge, (address(g.bridge2))),
            _err(PrimaryStillEnabled.selector),
            "no switch while the primary is enabled"
        );
        // the caps to bridge2's (a tightening, at once), on both chains
        vm.prank(owner);
        v.disableBridge(address(c.bridge));
        _refuses(
            owner,
            address(v),
            abi.encodeCall(v.setPrimaryBridge, (address(g.bridge2))),
            _err(AboveBridgeCap.selector),
            "the cap first"
        );
        uint32 chunk = c.vaultLens.minChunk();
        vm.prank(owner);
        v.setMessageLimits(BRIDGE2_CAP, BRIDGE2_CAP, chunk);
        uint64 t1 = uint64(vm.getBlockTimestamp());
        vm.prank(owner);
        v.setPrimaryBridge(address(g.bridge2));
        _assertVault(false, false, "OPEN at once: the switch clears the hold");
        assertEq(c.vaultLens.lastOwnerClose(), t1, "only the disable stamped");
        vm.prank(owner);
        c.fd.setMaxBatchValue(BRIDGE2_CAP);
        vm.prank(owner);
        c.fd.disableBridge(address(c.bridge));
        assertEq(uint8(c.doorLens.primaryDisabledBy()), uint8(Actor.Owner), "the front door's own hold, a moment");
        assertEq(c.doorLens.lastOwnerClose(), vm.getBlockTimestamp(), "the front door's owner clock");
        _lensParity();
        vm.prank(owner);
        c.fd.setPrimaryBridge(address(g.bridge2));
        assertTrue(c.doorLens.exitsOpen(), "the front door OPEN on bridge2");
        _assertDoorWorks("over the new bridge");
        (bytes4 err,) = _forgedErr2(address(c.bridge));
        assertEq(err, NotBridge.selector, "the old rail is refused");
    }

    /// A forged launch-door redeem from `bridge`, in a snapshot.
    function _forgedErr2(address bridge) internal returns (bytes4 err, uint256 burned) {
        Mark memory m = _mark();
        Delivery memory d;
        (err, d) = _forge(bridge, address(c.fd), holders[0]);
        burned = d.burned;
        _back(m);
    }

    /// Row 3, SG: "state G: the owner schedules `setGuardian` and the Reopen together and, on day 8, executes the swap
    /// first, then the Reopen (the thief re-disables one that lands earlier); **bound ≤ 8 days, Reopen executed after
    /// the swap** (up to about 15 if the thief also removed the launch door: the swap ends both of its holds, so the
    /// door's Ordinary activation runs beside the Reopen; 15 is the SG bound overall)".
    /// The stolen guardian disables the primary; the owner schedules the swap and the Reopen together. Landed early
    /// (day 7) the Reopen is re-closed by the thief and must run again (day 15); on day 8 the swap first, then the
    /// Reopen: OPEN on day 8. Then, with the launch door removed too: the door's activation runs by day 15, the door
    /// named before the bridge in every refused payout (M-4).
    function test_T3_SG() public {
        CascadeVault v = c.vault;
        _request(holders[0], v.balanceOf(holders[0]) / 5);
        Delivery memory queued = _closeDoor();
        Mark memory start = _mark();
        bytes memory swap = _swap(guardian2);
        bytes memory reopen = _activateBridge(address(c.bridge));

        uint64 t0 = uint64(vm.getBlockTimestamp());
        vm.prank(guardian);
        v.disableBridge(address(c.bridge));
        _assertVault(false, true, "state G");
        bytes32 sid = _sched(v, swap);
        bytes32 rid = _sched(v, reopen);
        assertEq(uint8(_kind(v, reopen)), uint8(Kind.Reopen), "the Reopen");
        _refuses(guardian, address(v), abi.encodeCall(v.cancel, (sid)), _err(NotCanceller.selector), "not the swap");
        _refuses(guardian, address(v), abi.encodeCall(v.cancel, (rid)), _err(NotCanceller.selector), "nor the Reopen");
        _assertDirectWorks("G");
        _assertDoorRefused(NotBridge.selector, "G");
        Mark memory scheduled_ = _mark();

        // landed before the swap, the Reopen is re-closed by the thief
        _executeAtReady(v, reopen);
        _assertVault(false, false, "OPEN for a moment");
        vm.prank(guardian);
        v.disableBridge(address(c.bridge));
        _assertVault(false, true, "re-closed by the thief");
        _executeAtReady(v, swap);
        _assertVault(false, false, "the swap ends the guardian's hold");
        assertFalse(_bridgeUp(v, address(c.bridge)), "but the primary is disabled again");
        _assertDoorRefused(NotBridge.selector, "door exits still wait");
        _sched(v, reopen);
        uint64 when = _executeAtReady(v, reopen);
        assertEq(when - t0, GUARDIAN + REGISTRY, "the wrong order: a second Reopen, door exits on day 15");

        // the right order, on day 8: the swap first, then the Reopen
        _back(scheduled_);
        when = _executeAtReady(v, swap);
        assertEq(when - t0, GUARDIAN, "the swap on day 8");
        _executeNow(v, reopen);
        assertTrue(_bridgeUp(v, address(c.bridge)), "the primary enabled");
        _assertVault(false, false, "OPEN on day 8");
        _refuses(
            guardian,
            address(v),
            abi.encodeCall(v.disableBridge, (address(c.bridge))),
            _err(NotGuardian.selector),
            "the old guardian cannot re-close it"
        );
        assertLe(vm.getBlockTimestamp() - t0, 8 days, "bound: at most 8 days");
        _assertDoorWorks("day 8");
        assertEq(_payoutErr(queued.key, queued.list), bytes4(0), "the queued payout goes out");

        // with the launch door removed too: about 15 days
        _back(start);
        bytes memory door = _activateDoor(BASE, address(c.fd));
        vm.prank(guardian);
        v.removeFrontDoor(BASE, address(c.fd));
        vm.prank(guardian);
        v.disableBridge(address(c.bridge));
        _sched(v, swap);
        _sched(v, reopen);
        assertEq(_payoutErr(queued.key, queued.list), FrontDoorInactive.selector, "M-4: the door before the bridge");
        _schedRefused(v, door, _err(ExitsNotOpen.selector), "no activation under the holds");
        when = _executeAtReady(v, swap);
        assertEq(when - t0, GUARDIAN, "the swap ends both holds, day 8");
        _executeNow(v, reopen);
        _assertVault(false, false, "OPEN, no launch door");
        assertEq(_payoutErr(queued.key, queued.list), FrontDoorInactive.selector, "the door still down");
        _assertDoorRefused(UnknownPeer.selector, "no door yet");
        _sched(v, door);
        when = _executeAtReady(v, door);
        assertEq(when - t0, GUARDIAN + REGISTRY, "the door's activation beside the Reopen: day 15");
        _assertDoorWorks("day 15");
        assertEq(_payoutErr(queued.key, queued.list), bytes4(0), "the queued payout goes out");
    }

    /// Row 3, SOG: "as row 1" (O or G at will; nothing to veto them; a rogue door needs 7 OPEN days, in which the
    /// shared allowance lets about 36% of a door's base be paid out at the floor, first-come, in the worst case found,
    /// every empty due batch rolled with the Base batch interval and the payout delay raised; one request waiting when
    /// a batch falls due stops the roll, and with every request waiting about 59%; about 67% with the delay alone,
    /// about 74% with neither (the case this cell runs; `test_T1_SOG` runs the others); all assuming no thief-held
    /// shares in the queue, which can crowd the honest holders out; bound: 7 days of open exits on the vault before any
    /// drain; Base exits can be closed throughout).
    /// Both keys, with the primary's disable: by either key it kills a rogue door scheduled before it and refuses one
    /// under it. With the owner key, the primary's Reopen (7 days) then 7 OPEN days with the bridge back: about 74%
    /// paid out first, and the last day's batch the thief's. With the guardian key, the swap (8 days) ends the hold
    /// while the primary stays disabled: 7 OPEN days with door exits closed and direct exits open, before the rogue
    /// door.
    function test_T3_SOG() public {
        CascadeVault v = c.vault;
        bytes memory door = _activateDoor(BASE, rogue);
        bytes memory reopen = _activateBridge(address(c.bridge));
        bytes memory closed = _err(ExitsNotOpen.selector);
        Mark memory start = _mark();

        // the owner key
        _sched(v, door);
        Schedule.wait(1 days);
        vm.prank(owner);
        v.disableBridge(address(c.bridge));
        _assertVault(true, false, "O at will");
        _schedRefused(v, door, closed, "O: no rogue door");
        Schedule.wait(1);
        _sched(v, reopen);
        _executeAtReady(v, reopen);
        _assertVault(false, false, "the owner key's way back: the Reopen");
        _execRefused(v, door, closed, "the disable killed the rogue door");
        Schedule.wait(1);
        uint64 t0 = uint64(vm.getBlockTimestamp());
        _sched(v, door);
        _tightenToTheFloor();
        uint256 daveAll = v.balanceOf(dave);
        vm.prank(dave);
        v.redeemDirect(daveAll, false);
        Run memory r = _runAtTheFloor(t0, 7, rogue);
        (uint64 when, uint256 reminted, uint256 taken) = _theThiefTakesWhatIsQueued(r, door, rogue);
        assertEq(when - t0, REGISTRY, "7 OPEN days before the rogue door");
        _assertShare(r, reminted, taken);

        // the guardian key
        _back(start);
        _sched(v, door);
        Schedule.wait(1 days);
        vm.prank(guardian);
        v.disableBridge(address(c.bridge));
        _assertVault(false, true, "G at will");
        _schedRefused(v, door, closed, "G: no rogue door");
        Schedule.wait(1);
        bytes memory swap = _swap(guardian2);
        _sched(v, swap);
        _executeAtReady(v, swap);
        _assertVault(false, false, "the guardian's hold cleared by setGuardian");
        assertFalse(_bridgeUp(v, address(c.bridge)), "the primary still disabled");
        _execRefused(v, door, closed, "the disable killed the rogue door");
        Schedule.wait(1);
        t0 = uint64(vm.getBlockTimestamp());
        _sched(v, door);
        for (uint256 d; d < 7; ++d) {
            Schedule.warpTo(t0 + d * 1 days);
            assertTrue(c.vaultLens.exitsOpen(), "the vault reads OPEN each day");
            _assertDirectWorks("open exits on the vault");
            _assertDoorRefused(NotBridge.selector, "door exits closed throughout");
        }
        when = _executeAtReady(v, door);
        assertEq(when - t0, REGISTRY, "7 OPEN days before the rogue door");
    }

    /// Row 3, HO: "a compromised rail is reopened (7 d), a new bridge activated from OPEN (7 d), the old disabled and
    /// the primary switched in one step: a 14-day migration under the guardian's watch; a rail **still being
    /// exploited** resets the new bridge's 7-day activation with every forged delivery answered, so the ways off it,
    /// none of which reopens it, are the rail operator's fix, a redeploy (section 5), a known standby bridge's Reopen
    /// (7 d, no gate) then the switch while the primary stays disabled, or, with none, `setGuardian` to the same
    /// guardian (8 d), which clears the guardian's bridge hold with the primary still disabled (OPEN, no forged
    /// delivery landing), then a new bridge from OPEN (7 d) and the switch: 15 d".
    /// (The two last ways are each asserted step by step elsewhere in this file, not run here as one script: a known
    /// bridge's Reopen under the hold and the switch to it, `test_T3_SO`; the swap clearing a guardian's bridge hold
    /// with the primary still disabled, `test_T3_SOG`; a new bridge from OPEN then the switch, `test_T3_SO`.)
    /// A forged delivery through the primary, answered at once (the guardian's disable, the owner's cancel of the
    /// forged batch, then the Reopen scheduled after its stamp); the Reopen on day 7; the new bridge activated from
    /// OPEN on both chains (7 days); the switch on day 14, a round trip over it. Then, from the Reopen again: a rail
    /// still exploited kills the new bridge's activation with each answered forged delivery.
    function test_T3_HO() public {
        CascadeVault v = c.vault;
        bytes memory reopen = _activateBridge(address(c.bridge));
        bytes memory nb = _activateBridge(address(g.bridge2));
        uint64 t0 = uint64(vm.getBlockTimestamp());
        uint256 victimShares = v.balanceOf(holders[5]);
        uint64 tr = _answerForged(holders[5]);
        assertLe(v.balanceOf(holders[5]), victimShares, "never more shares than were burned");
        assertApproxEqAbs(v.balanceOf(holders[5]), victimShares, 1e12, "the forged burn re-minted");
        uint64 when = _executeAtReady(v, reopen);
        assertEq(when - tr, REGISTRY, "the rail reopened in 7 days");
        _assertVault(false, false, "OPEN");
        Mark memory reopened = _mark();

        // from OPEN, the new bridge on both chains, the caps tightened to it
        _sched(v, nb);
        Schedule.wait(1);
        _sched(c.fd, nb);
        _lensParity();
        uint32 chunk = c.vaultLens.minChunk();
        vm.prank(owner);
        v.setMessageLimits(BRIDGE2_CAP, BRIDGE2_CAP, chunk);
        vm.prank(owner);
        c.fd.setMaxBatchValue(BRIDGE2_CAP);
        _executeAtReady(v, nb);
        _executeAtReady(c.fd, nb);
        // the old disabled and the primary switched in one step, on both chains
        vm.prank(owner);
        v.disableBridge(address(c.bridge));
        vm.prank(owner);
        v.setPrimaryBridge(address(g.bridge2));
        vm.prank(owner);
        c.fd.disableBridge(address(c.bridge));
        _lensParity();
        vm.prank(owner);
        c.fd.setPrimaryBridge(address(g.bridge2));
        uint256 took = vm.getBlockTimestamp() - t0;
        assertGe(took, 2 * REGISTRY, "a 14-day migration");
        assertLe(took, 2 * REGISTRY + 3, "a 14-day migration (and the seconds of scheduling)");
        _assertVault(false, false, "OPEN on the new bridge");
        assertTrue(c.doorLens.exitsOpen(), "the front door OPEN on the new bridge");
        _assertDoorWorks("over the new bridge");
        (bytes4 err,) = _forgedErr2(address(c.bridge));
        assertEq(err, NotBridge.selector, "the old rail is refused");

        // a rail still exploited: each answered forged delivery resets the new bridge's activation
        _back(reopened);
        for (uint256 k; k < 2; ++k) {
            uint64 ts = uint64(vm.getBlockTimestamp());
            _sched(v, nb);
            Schedule.warpTo(ts + 2 days);
            tr = _answerForged(holders[6 + k]);
            Item memory it = c.vaultLens.scheduled(keccak256(nb));
            _executeAtReady(v, reopen);
            if (vm.getBlockTimestamp() < it.readyAt) Schedule.warpTo(it.readyAt);
            _execRefused(v, nb, _err(ExitsNotOpen.selector), "the answer killed the new bridge's activation");
            assertFalse(_bridgeUp(v, address(g.bridge2)), "the new bridge never activates");
            Schedule.wait(1);
        }
    }

    /// A forged launch-door redeem of `victim`'s shares through the vault's primary, answered as the runbook says: the
    /// guardian disables the primary at once, the owner cancels the forged batch (re-minting what it burned; an
    /// instrument, stamping the owner's clock), then schedules the primary's Reopen after its stamp. Returns when the
    /// Reopen was scheduled.
    function _answerForged(address victim) internal returns (uint64 tr) {
        CascadeVault v = c.vault;
        (bytes4 err, Delivery memory d) = _forge(address(c.bridge), address(c.fd), victim);
        assertEq(err, bytes4(0), "the compromised rail's forged delivery lands");
        assertGt(d.burned, 0, "and burns");
        vm.prank(guardian);
        v.disableBridge(address(c.bridge));
        vm.prank(owner);
        v.cancelPayoutBatch(d.key, d.list);
        assertEq(c.vaultLens.lastOwnerClose(), vm.getBlockTimestamp(), "the cancel stamps the owner's clock");
        Schedule.wait(1);
        tr = uint64(vm.getBlockTimestamp());
        _sched(v, _activateBridge(address(c.bridge)));
    }

    // =====================================================================================================
    // the copied-key cells, rows 1 to 3 (the CO column): each its SO script under the copy (`_copySeed`)
    // =====================================================================================================

    /// The thief's takeover items on the vault, as T1.SO's (a transfer to its own account, its own guardian, a rogue
    /// door) and a Param-class loosening.
    function _takeover() internal view returns (bytes[] memory items) {
        items = new bytes[](4);
        items[0] = _transfer(owner2);
        items[1] = _swap(guardian2);
        items[2] = _activateDoor(BASE, rogue);
        items[3] = abi.encodeCall(c.vault.setOutflowLimits, (5_000, 100e18, 5_000));
    }

    /// Nothing the thief scheduled ran: the owner, the guardian, the rogue door and the outflow limits as they were.
    function _assertNothingRan(string memory why) internal view {
        assertEq(c.vault.owner(), owner, string.concat(why, ": the owner unchanged"));
        assertEq(c.vault.pendingOwner(), address(0), string.concat(why, ": no pending owner"));
        assertEq(c.vaultLens.guardian(), guardian, string.concat(why, ": the guardian unchanged"));
        assertEq(uint8(_doorState(rogue)), uint8(DoorState.Unknown), string.concat(why, ": no rogue door"));
        assertEq(c.vaultLens.maxDailyOutflowBps(), _outflowAtCopy, string.concat(why, ": no loosening"));
    }

    /// Row 1, CO: "stalemate through signed stamps: the thief may pause and sweep the keys' gas, but every item it
    /// schedules dies to the founder's owner stamp, relayed from any account within the delay; principal safe, exits
    /// frozen while it pauses; without `stampBySig` this is SOG; **the Safe prevents it** and cannot be installed
    /// after a copy".
    /// T1.SO's script under the copy: a payout queued, then the thief schedules the takeover's items from OPEN and
    /// keeps the vault OPEN for them (its own pause would stamp them dead), scheduling each again as it dies, for 30
    /// days: every one dies to the stack; the founder's own transactions (its guardian's veto, its Safe's transfer)
    /// never land; nothing executes and the principal is intact. Without the stack, in a snapshot, the rogue door
    /// runs at its 7 days: SOG. Then the thief pauses: every exit frozen while it pauses, nothing schedules under it,
    /// and with the guardian account's pause its swap dies to the stack too; nothing lost; its unpause opens them.
    function test_T1_CO() public {
        CascadeVault v = c.vault;
        _request(holders[0], v.balanceOf(holders[0]) / 5);
        Delivery memory queued = _closeDoor();
        assertTrue(queued.key != bytes32(0), "a payout is queued");
        _copySeed();
        uint64 t0 = uint64(vm.getBlockTimestamp());
        uint256 assets = c.vaultLens.totalAssets();
        uint256 supply = v.totalSupply();
        uint256 price = c.vaultLens.price();
        uint256 daveShares = v.balanceOf(dave);
        uint256 heldShares = v.balanceOf(holders[2]);

        // a second after the stack's first stamp, the thief schedules the takeover from OPEN
        Schedule.wait(1);
        bytes[] memory items = _takeover();
        for (uint256 i; i < items.length; ++i) {
            swept();
            _sched(v, items[i]);
        }
        _assertVault(false, false, "OPEN: the thief keeps it open for its items");
        // without stampBySig this is SOG: with no stamp relayed, the rogue door runs at its 7 days
        Mark memory m = _mark();
        uint64 when = _executeAtReady(v, items[2]);
        assertEq(when - t0 - 1, REGISTRY, "no stamp: the rogue door at its 7 days");
        assertEq(uint8(_doorState(rogue)), uint8(DoorState.Active), "SOG: the drain can start");
        _back(m);
        // the gas model, not a contract check (Task 40's re-review, Minor): the founder's own transactions, its
        // guardian's veto and its owner's schedule of a Safe's transfer, are not sent from swept accounts
        // (`_founderSends`); what the cell shows of the contracts is the stack's work below
        address safe = makeAddr("the founder's Safe");
        assertFalse(
            _founderSends(guardian, address(v), abi.encodeCall(v.cancel, (keccak256(items[2])))),
            "the gas model: the guardian's veto is not sent, its account swept"
        );
        assertFalse(
            _founderSends(owner, address(v), abi.encodeCall(CascadeBase.schedule, (_transfer(safe)))),
            "the gas model: nor the Safe's transfer"
        );

        // 30 days: every item the thief schedules dies to the stack, relayed by the stranger, within 12 hours of it
        uint256 tries = _thiefUnderTheStack(v, items, t0 + 30 days);
        emit log_named_uint("the thief's executes in 30 days, each refused", tries);
        emit log_named_uint("the stack's stamps relayed, each on both targets", _stackRelays);
        assertEq(
            tries, 4 + 3 + 3 + 12, "each tried at each readyAt: 4 rogue doors, 3 swaps, 3 transfers, 12 loosenings"
        );
        _assertSwept("30 days on");
        _assertNothingRan("30 days under the stack");
        assertEq(c.vaultLens.totalAssets(), assets, "principal intact: totalAssets");
        assertEq(v.totalSupply(), supply, "the supply");
        assertEq(c.vaultLens.price(), price, "the price");
        assertEq(v.balanceOf(dave), daveShares, "dave's shares");
        assertEq(v.balanceOf(holders[2]), heldShares, "a holder's shares");
        _assertDirectWorks("OPEN under the stack");
        _assertDoorWorks("OPEN under the stack");

        // the thief pauses: every exit frozen while it pauses, nothing schedules, nothing lost
        _coWait(_stackNext, false);
        Schedule.wait(1);
        swept();
        vm.prank(owner);
        v.pause();
        _assertVault(true, false, "the thief's pause: state O");
        bytes memory closed = _err(ExitsNotOpen.selector);
        for (uint256 i; i < items.length; ++i) {
            _schedRefused(v, items[i], closed, "O: nothing schedules");
        }
        _assertDirectRefused(_paused(), "frozen while it pauses");
        _assertDoorRefused(_paused(), "frozen while it pauses");
        assertEq(_payoutErr(queued.key, queued.list), _paused(), "the queued payout frozen");
        _coWait(vm.getBlockTimestamp() + 10 days, false);
        _assertVault(true, false, "still O, 10 days on");
        assertEq(c.vaultLens.totalAssets(), assets, "nothing lost while paused");
        assertEq(v.totalSupply(), supply, "the supply");
        // the guardian account's pause instead: the swap schedules under G, and dies to the stack
        swept();
        vm.prank(owner);
        v.unpause();
        _coWait(_stackNext, false);
        Schedule.wait(1);
        swept();
        vm.prank(guardian);
        v.pause();
        _assertVault(false, true, "the thief's guardian-account pause: state G");
        bytes[] memory swap = new bytes[](1);
        swap[0] = _swap(guardian2);
        assertEq(_thiefUnderTheStack(v, swap, vm.getBlockTimestamp() + 9 days), 1, "the swap under G, tried once");
        _assertNothingRan("under the thief's pauses");
        // only the thief's unpause opens them; nothing was lost
        swept();
        vm.prank(owner);
        v.unpause();
        _assertVault(false, false, "OPEN once the thief unpauses");
        uint256 credit = c.fd.claimable(holders[0]);
        _payout(queued.key, queued.list);
        assertEq(c.fd.claimable(holders[0]) - credit, queued.burned - FEE, "the queued payout, credited");
        _assertDirectWorks("after the unpause");
        _assertDoorWorks("after the unpause");
        assertEq(c.vaultLens.price(), price, "the price unchanged");
        _assertSwept("the end");
    }

    /// Row 2, CO: "stalemate; funds safe".
    /// T2.SO's script under the copy: a payout queued, then the thief removes the launch door with the owner account
    /// (state O): no progress, direct exits only; the one item O lets it schedule, the door's Reopen, dies to the
    /// stack again and again for 30 days (the founder's own Reopen not sent: the gas model); then the thief's
    /// guardian-account removal makes the hold the guardian's, and its swap, which G lets it schedule, dies too. The
    /// door never comes back and nothing executes; the principal is intact.
    function test_T2_CO() public {
        CascadeVault v = c.vault;
        _request(holders[0], v.balanceOf(holders[0]) / 5);
        Delivery memory queued = _closeDoor();
        _copySeed();
        bytes memory reopen = _activateDoor(BASE, address(c.fd));
        bytes memory closed = _err(ExitsNotOpen.selector);
        uint256 price = c.vaultLens.price();
        uint256 assets = c.vaultLens.totalAssets();
        uint256 supply = v.totalSupply();
        uint256 heldShares = v.balanceOf(holders[2]);

        Schedule.wait(1);
        uint64 t0 = uint64(vm.getBlockTimestamp());
        swept();
        vm.prank(owner);
        v.removeFrontDoor(BASE, address(c.fd));
        assertEq(uint8(c.vaultLens.launchDoorRemovedBy()), uint8(Actor.Owner), "the thief's removal: the owner's hold");
        _assertVault(true, false, "state O");
        // no progress: under O nothing but a Reopen schedules
        bytes[] memory takeover = _takeover();
        for (uint256 i; i < takeover.length; ++i) {
            _schedRefused(v, takeover[i], closed, "O: no takeover item schedules");
        }
        // direct exits only
        _assertDirectWorks("O");
        (bytes4 err,) = _directExit(holders[1], v.balanceOf(holders[1]));
        assertEq(err, bytes4(0), "a launch-door holder's own direct exit (an EOA on Bittensor)");
        _assertDoorRefused(UnknownPeer.selector, "O");
        assertEq(_payoutErr(queued.key, queued.list), FrontDoorInactive.selector, "O: the queued payout waits");

        // 30 days: the thief's Reopen, scheduled a second after each relay, dies to the stack each time
        _coWait(_stackNext, false);
        Schedule.wait(1);
        // the gas model, not a contract check: the founder's own Reopen is not sent from its swept account (a second
        // after a stamp, where a funded one would schedule)
        assertFalse(
            _founderSends(owner, address(v), abi.encodeCall(CascadeBase.schedule, (reopen))),
            "the gas model: the founder's Reopen is not sent, its account swept"
        );
        bytes[] memory items = new bytes[](1);
        items[0] = reopen;
        swept();
        _sched(v, reopen);
        assertEq(uint8(_kind(v, reopen)), uint8(Kind.Reopen), "a Reopen: no gate, only the owner's clock");
        uint256 tries = _thiefUnderTheStack(v, items, t0 + 30 days);
        emit log_named_uint("the thief's executes in 30 days, each refused", tries);
        emit log_named_uint("the stack's stamps relayed, each on both targets", _stackRelays);
        assertEq(tries, 4, "its Reopen tried at each of its readyAts");
        _assertVault(true, false, "state O on day 30: stalemate");
        assertEq(uint8(_doorState(address(c.fd))), uint8(DoorState.Removed), "the door never comes back");
        assertEq(c.vaultLens.price(), price, "funds safe: the price unchanged");
        assertEq(c.vaultLens.totalAssets(), assets, "totalAssets unchanged");
        assertEq(v.totalSupply(), supply, "the supply unchanged");
        assertEq(v.balanceOf(holders[2]), heldShares, "a holder's shares unchanged");
        _assertDirectWorks("day 30");
        _assertDoorRefused(UnknownPeer.selector, "day 30");

        // the thief's guardian account removes the owner-removed door: the hold the guardian's; its swap dies too
        _coWait(_stackNext, false);
        Schedule.wait(1);
        swept();
        vm.prank(guardian);
        v.removeFrontDoor(BASE, address(c.fd));
        assertEq(uint8(c.vaultLens.launchDoorRemovedBy()), uint8(Actor.Guardian), "the hold made the guardian's");
        assertEq(uint8(_doorState(address(c.fd))), uint8(DoorState.Unknown), "the door unknown");
        _assertVault(false, true, "state G");
        _schedRefused(v, reopen, closed, "G: no activation of the door");
        Schedule.wait(1);
        items[0] = _swap(guardian2);
        assertEq(_thiefUnderTheStack(v, items, vm.getBlockTimestamp() + 9 days), 1, "the swap under G, tried once");
        _assertVault(false, true, "still G: stalemate");
        assertEq(c.vaultLens.guardian(), guardian, "the swap never runs");
        assertEq(c.vaultLens.totalAssets(), assets, "funds safe");
        _assertDirectWorks("under G");
        _assertSwept("the end");
    }

    /// Row 3, CO: "stalemate".
    /// T3.SO's script under the copy: bridge2 known and disabled, a payout queued, then the thief disables the
    /// primary with the owner account (state O): direct exits only; no new bridge activates under O and no enabled
    /// bridge is there to switch to; the Reopens O lets it schedule (the primary's, and bridge2's, row 3 SO's third
    /// way back) die to the stack again and again for 30 days (the founder's own Reopen not sent: the gas model).
    /// The rail never comes back and nothing executes; the principal is intact.
    function test_T3_CO() public {
        CascadeVault v = c.vault;
        bytes memory b2 = _activateBridge(address(g.bridge2));
        bytes memory reopen = _activateBridge(address(c.bridge));
        bytes memory closed = _err(ExitsNotOpen.selector);
        // bridge2 known and disabled, before the copy
        _sched(v, b2);
        _executeAtReady(v, b2);
        vm.prank(owner);
        v.disableBridge(address(g.bridge2));
        _request(holders[0], v.balanceOf(holders[0]) / 5);
        Delivery memory queued = _closeDoor();
        Schedule.wait(1);
        _copySeed();
        uint256 price = c.vaultLens.price();
        uint256 assets = c.vaultLens.totalAssets();
        uint256 supply = v.totalSupply();
        uint256 heldShares = v.balanceOf(holders[2]);

        Schedule.wait(1);
        uint64 t0 = uint64(vm.getBlockTimestamp());
        swept();
        vm.prank(owner);
        v.disableBridge(address(c.bridge));
        assertEq(uint8(c.vaultLens.primaryDisabledBy()), uint8(Actor.Owner), "the thief's disable: the owner's hold");
        _assertVault(true, false, "state O");
        // no progress, direct exits only
        bytes[] memory takeover = _takeover();
        for (uint256 i; i < takeover.length; ++i) {
            _schedRefused(v, takeover[i], closed, "O: no takeover item schedules");
        }
        _schedRefused(v, _activateBridge(makeAddr("a new bridge")), closed, "O: no new bridge");
        _refuses(
            owner,
            address(v),
            abi.encodeCall(v.setPrimaryBridge, (address(g.bridge2))),
            _err(BridgeNotEnabled.selector),
            "no enabled bridge to switch to"
        );
        _assertDirectWorks("O");
        _assertDoorRefused(NotBridge.selector, "O");
        assertEq(_payoutErr(queued.key, queued.list), PrimaryBridgeDisabled.selector, "O: the queued payout waits");

        // 30 days: the thief's Reopens, of the primary and of bridge2, die to the stack each time
        _coWait(_stackNext, false);
        Schedule.wait(1);
        // the gas model, not a contract check: the founder's own Reopen is not sent from its swept account (a second
        // after a stamp, where a funded one would schedule)
        assertFalse(
            _founderSends(owner, address(v), abi.encodeCall(CascadeBase.schedule, (reopen))),
            "the gas model: the founder's Reopen is not sent, its account swept"
        );
        bytes[] memory items = new bytes[](2);
        items[0] = reopen;
        items[1] = b2;
        uint256 tries = _thiefUnderTheStack(v, items, t0 + 30 days);
        emit log_named_uint("the thief's executes in 30 days, each refused", tries);
        emit log_named_uint("the stack's stamps relayed, each on both targets", _stackRelays);
        assertEq(tries, 8, "each Reopen tried at each of its readyAts");
        _assertVault(true, false, "state O on day 30: stalemate");
        assertFalse(_bridgeUp(v, address(c.bridge)), "the primary never comes back");
        assertFalse(_bridgeUp(v, address(g.bridge2)), "nor bridge2: no switch target");
        assertEq(c.vaultLens.price(), price, "no loss: the price unchanged");
        assertEq(c.vaultLens.totalAssets(), assets, "totalAssets unchanged");
        assertEq(v.totalSupply(), supply, "the supply unchanged");
        assertEq(v.balanceOf(holders[2]), heldShares, "a holder's shares unchanged");
        _assertDirectWorks("day 30");
        _assertDoorRefused(NotBridge.selector, "day 30");
        _assertSwept("the end");
    }

    // =====================================================================================================
    // row 4: the Base side's instruments (the front door's primary disabled) (Task 41a)
    // =====================================================================================================

    /// A queued launch-door payout: holders[0]'s fifth, delivered now.
    function _queueOne() internal returns (Delivery memory queued) {
        _request(holders[0], c.vault.balanceOf(holders[0]) / 5);
        queued = _closeDoor();
        assertTrue(queued.key != bytes32(0), "a payout is queued");
        assertEq(queued.list.length, 1, "one entry");
    }

    /// Row 4, SO: "**the vault cannot see it**: closes fail on Base and stay failed, since only the owner key can
    /// Reopen; the vault reads OPEN; the guardian can veto the thief's door but not its `setGuardian` (day 8), after
    /// which a door runs unvetoed about 7 days later; **bound: a Base-side user has no door exit at all before a drain
    /// at about day 15; EOA holders on Bittensor can leave directly throughout; a Base smart-wallet holder cannot
    /// leave**" (the cell as Task 41a's review, I-2, gives it).
    /// The thief, holding the owner key, schedules its vault items from OPEN (a rogue door, its own guardian) and
    /// disables the front door's primary: the front door is in state O, its owner clock stamped; the vault reads OPEN
    /// with its clocks untouched. Base closes fail every day (requests are taken and wait), payouts still land, direct
    /// exits work. The rogue door would run at its 7 days; the honest guardian vetoes it, but not the swap, which runs
    /// on day 8, the thief scheduling its door again in that second; the old guardian's cancel is then refused, and
    /// the door runs 7 days later, on day 15: the drain. Base closes fail on every day to then. The thief's own
    /// front-door item dies with the hold it made.
    function test_T4_SO() public {
        CascadeVault v = c.vault;
        CascadeFrontDoor fd = c.fd;
        Delivery memory queued = _queueOne();
        Schedule.wait(1);
        bytes memory door = _activateDoor(BASE, rogue);
        bytes memory swap = _swap(guardian2);
        bytes memory fdSwap = _swap(guardian2);
        uint64 t0 = uint64(vm.getBlockTimestamp());
        _sched(v, door);
        _sched(v, swap);
        _sched(fd, fdSwap);
        Schedule.wait(1);
        uint64 td = uint64(vm.getBlockTimestamp());
        vm.prank(owner);
        fd.disableBridge(address(c.bridge));
        assertEq(uint8(c.doorLens.primaryDisabledBy()), uint8(Actor.Owner), "the front door: the owner's bridge hold");
        assertEq(c.doorLens.lastOwnerClose(), td, "and the front door's owner clock");
        _assertDoor(true, false, "the front door: state O");
        // the vault cannot see it
        _assertVault(false, false, "the vault reads OPEN");
        assertEq(c.vaultLens.lastOwnerClose(), 0, "the vault's owner clock untouched");
        assertEq(c.vaultLens.lastGuardianClose(), 0, "and its guardian's");
        // closes fail on Base; requests are taken and wait; payouts still land; direct exits work
        assertEq(_baseCloseErr(), PrimaryBridgeDisabled.selector, "a Base close fails");
        _assertPayoutLands(queued, "the front door's primary disabled");
        _assertDirectWorks("direct exits");
        // the notice: each day, Base closes fail, the vault reads OPEN, the rogue door cannot deliver yet
        for (uint256 d; d < 7; ++d) {
            Schedule.warpTo(t0 + d * 1 days);
            assertEq(_baseCloseErr(), PrimaryBridgeDisabled.selector, "no door exit on any day of the notice");
            assertTrue(c.vaultLens.exitsOpen(), "the vault reads OPEN");
            _assertDirectWorks("direct exits only");
            (bytes4 forged,) = _forgedErr(rogue, holders[0]);
            assertEq(forged, UnknownPeer.selector, "no drain yet");
        }
        // the thief's items run: the rogue door at its 7 days, with no veto
        Mark memory m = _mark();
        uint64 when = _executeAtReady(v, door);
        assertEq(when - t0, REGISTRY, "a Base-side user has no door exit for the 7 days of the notice");
        (bytes4 err, uint256 burned) = _forgedErr(rogue, holders[0]);
        assertEq(err, bytes4(0), "the rogue door delivers");
        assertGt(burned, 0, "the drain can start");
        assertEq(_baseCloseErr(), PrimaryBridgeDisabled.selector, "while Base closes still fail");
        _back(m);
        // the vault's defence in SO: the honest guardian vetoes the rogue door (Ordinary); not the swap (owner-only)
        vm.prank(guardian);
        v.cancel(keccak256(door));
        _refuses(guardian, address(v), abi.encodeCall(v.cancel, (keccak256(swap))), _err(NotCanceller.selector), "swap");
        // day 8: in the swap's second the thief schedules its door again, then the swap runs
        when = _toReady(v, swap);
        _sched(v, door);
        _executeNow(v, swap);
        assertEq(when - t0, GUARDIAN, "the thief's own guardian at 8 days");
        assertEq(c.vaultLens.guardian(), guardian2, "the guardian replaced");
        _refuses(
            guardian, address(v), abi.encodeCall(v.cancel, (keccak256(door))), _err(NotCanceller.selector), "too late"
        );
        // the thief's own front-door item died with its hold
        _execRefused(fd, fdSwap, _err(ExitsNotOpen.selector), "the front door's swap: refused under its owner hold");
        // no door exit on any day to the drain; direct exits throughout
        for (uint256 d = 8; d < 15; ++d) {
            Schedule.warpTo(t0 + d * 1 days);
            assertEq(_baseCloseErr(), PrimaryBridgeDisabled.selector, "Base closes still fail");
            _assertDirectWorks("direct exits throughout");
            (bytes4 early,) = _forgedErr(rogue, holders[0]);
            assertEq(early, UnknownPeer.selector, "no drain yet");
        }
        uint64 drain = _executeAtReady(v, door);
        assertEq(drain - t0, GUARDIAN + REGISTRY, "the unvetoed door: the drain at day 15");
        (err, burned) = _forgedErr(rogue, holders[0]);
        assertEq(err, bytes4(0), "the rogue door delivers");
        assertGt(burned, 0, "the drain starts");
        assertEq(_baseCloseErr(), PrimaryBridgeDisabled.selector, "a Base-side user got no door exit before it");
        _assertDoor(true, false, "the front door still in state O");
    }

    /// Row 4, SG: "as row 3 on the front door's scheduler (its `setGuardian` first on day 8, then the Base twin's
    /// Reopen); payouts still land (known bridges are accepted); **bound ≤ 8 days of Base closes, Reopen executed
    /// after the swap**".
    /// The stolen guardian disables the front door's primary (state G there, the front door's guardian clock
    /// stamped); the owner schedules the front door's swap and the primary's Reopen together. Base closes fail,
    /// payouts land, the vault reads OPEN. Landed early (day 7) the Reopen is re-closed by the thief and must run
    /// again (day 15); on day 8 the swap first, then the Reopen: Base closes again by day 8.
    function test_T4_SG() public {
        CascadeFrontDoor fd = c.fd;
        Delivery memory queued = _queueOne();
        Schedule.wait(1);
        bytes memory swap = _swap(guardian2);
        bytes memory reopen = _activateBridge(address(c.bridge));
        uint64 t0 = uint64(vm.getBlockTimestamp());
        vm.prank(guardian);
        fd.disableBridge(address(c.bridge));
        assertEq(uint8(c.doorLens.primaryDisabledBy()), uint8(Actor.Guardian), "the front door: the guardian's hold");
        assertEq(c.doorLens.lastGuardianClose(), t0, "the front door's guardian clock (the lens carry: non-zero)");
        assertEq(c.doorLens.lastOwnerClose(), 0, "and not its owner's");
        _assertDoor(false, true, "the front door: state G");
        _assertVault(false, false, "the vault reads OPEN");
        bytes32 sid = _sched(fd, swap);
        bytes32 rid = _sched(fd, reopen);
        assertEq(uint8(_kind(fd, swap)), uint8(Kind.GuardianSwap), "the front door's swap");
        assertEq(uint8(_kind(fd, reopen)), uint8(Kind.Reopen), "the Base twin's Reopen");
        _refuses(guardian, address(fd), abi.encodeCall(fd.cancel, (sid)), _err(NotCanceller.selector), "not the swap");
        _refuses(guardian, address(fd), abi.encodeCall(fd.cancel, (rid)), _err(NotCanceller.selector), "nor the Reopen");
        assertEq(_baseCloseErr(), PrimaryBridgeDisabled.selector, "G: Base closes fail");
        _assertPayoutLands(queued, "G");
        _assertDirectWorks("G");
        Mark memory scheduled_ = _mark();

        // landed before the swap, the Reopen is re-closed by the thief
        _executeAtReady(fd, reopen);
        _assertDoor(false, false, "the front door OPEN for a moment");
        vm.prank(guardian);
        fd.disableBridge(address(c.bridge));
        _assertDoor(false, true, "re-closed by the thief");
        _executeAtReady(fd, swap);
        _assertDoor(false, false, "the swap ends the guardian's hold");
        assertFalse(_bridgeUp(fd, address(c.bridge)), "but the primary is disabled again");
        assertEq(_baseCloseErr(), PrimaryBridgeDisabled.selector, "Base closes still fail");
        _sched(fd, reopen);
        uint64 when = _executeAtReady(fd, reopen);
        assertEq(when - t0, GUARDIAN + REGISTRY, "the wrong order: a second Reopen, Base closes on day 15");

        // the right order, on day 8: the swap first, then the Reopen
        _back(scheduled_);
        when = _executeAtReady(fd, swap);
        assertEq(when - t0, GUARDIAN, "the swap on day 8");
        assertEq(c.doorLens.guardian(), guardian2, "the front door's guardian replaced");
        _executeNow(fd, reopen);
        assertTrue(_bridgeUp(fd, address(c.bridge)), "the Base primary enabled");
        _assertDoor(false, false, "the front door OPEN on day 8");
        _refuses(
            guardian,
            address(fd),
            abi.encodeCall(fd.disableBridge, (address(c.bridge))),
            _err(NotGuardian.selector),
            "the old guardian cannot re-close it"
        );
        assertLe(vm.getBlockTimestamp() - t0, 8 days, "bound: at most 8 days of Base closes");
        assertEq(_baseCloseErr(), bytes4(0), "Base closes again");
        _assertDoorWorks("day 8");
        _assertPayoutLands(queued, "day 8");
    }

    /// Row 4, SOG: "as SO" (the vault cannot see it: closes fail on Base while the vault reads OPEN; the thief's
    /// items run; bound: direct exits only during the notice period; a Base-side user has no door exit for 7 days).
    /// Both keys: the rogue door scheduled from OPEN on the vault and the front door's primary disabled. Nothing
    /// vetoes the door. For the 7 days of the notice Base closes fail every day while the vault reads OPEN and dave
    /// leaves directly, whole; at 7 days the door runs and the drain starts: the Base holders got nothing out.
    function test_T4_SOG() public {
        CascadeVault v = c.vault;
        bytes memory door = _activateDoor(BASE, rogue);
        uint256 heldShares = v.balanceOf(holders[2]);
        uint64 t0 = uint64(vm.getBlockTimestamp());
        _sched(v, door);
        vm.prank(owner);
        c.fd.disableBridge(address(c.bridge));
        _assertDoor(true, false, "the front door: state O");
        _assertVault(false, false, "the vault reads OPEN");
        uint256 daveBefore = dave.balance;
        uint256 daveAll = v.balanceOf(dave);
        vm.prank(dave);
        v.redeemDirect(daveAll, false);
        assertGe(dave.balance - daveBefore, DIRECT - 1e15, "an EOA holder on Bittensor leaves directly, whole");
        for (uint256 d; d < 7; ++d) {
            Schedule.warpTo(t0 + d * 1 days);
            assertEq(_baseCloseErr(), PrimaryBridgeDisabled.selector, "no Base close on any day of the notice");
            assertTrue(c.vaultLens.exitsOpen(), "the vault reads OPEN each day");
            (bytes4 forged,) = _forgedErr(rogue, holders[0]);
            assertEq(forged, UnknownPeer.selector, "no drain yet");
        }
        uint64 when = _executeAtReady(v, door);
        assertEq(when - t0, REGISTRY, "the rogue door at 7 days: no veto");
        assertEq(v.balanceOf(holders[2]), heldShares, "the Base holders got nothing out");
        (bytes4 err, uint256 burned) = _forgedErr(rogue, holders[2]);
        assertEq(err, bytes4(0), "the rogue door delivers");
        assertGt(burned, 0, "the drain starts");
    }

    /// Row 4, CO: "stalemate".
    /// Under the copy (`_copySeed`), the thief disables the front door's primary with the owner key (the front
    /// door in state O, its owner clock stamped) while the vault reads OPEN: Base closes fail, direct exits work. Its
    /// vault takeover items die to the stack for 30 days, and so does its front-door Reopen, the one item the front
    /// door's hold lets it schedule (the stamps on the front door). Nothing runs; nothing is lost; Base exits stay
    /// closed: a stalemate.
    function test_T4_CO() public {
        CascadeVault v = c.vault;
        CascadeFrontDoor fd = c.fd;
        Delivery memory queued = _queueOne();
        _copySeed();
        uint256 assets = c.vaultLens.totalAssets();
        uint256 supply = v.totalSupply();
        uint256 price = c.vaultLens.price();
        Schedule.wait(1);
        uint64 t0 = uint64(vm.getBlockTimestamp());
        swept();
        vm.prank(owner);
        fd.disableBridge(address(c.bridge));
        _assertDoor(true, false, "the front door: state O");
        _assertVault(false, false, "the vault reads OPEN");
        assertEq(_baseCloseErr(), PrimaryBridgeDisabled.selector, "Base closes fail");
        _assertDirectWorks("direct exits");
        // the thief's vault items, from OPEN, die to the stack (the vault's clock)
        _coWait(_stackNext, false);
        Schedule.wait(1);
        uint256 tries = _thiefUnderTheStack(v, _takeover(), t0 + 30 days);
        assertEq(tries, 4 + 3 + 3 + 12, "each vault item tried at each readyAt, each refused");
        // and its front-door Reopen dies to the stack's stamps on the front door
        _coWait(_stackNext, false);
        Schedule.wait(1);
        // the gas model, not a contract check: the founder's own front-door Reopen is not sent from its swept account
        bytes[] memory items = new bytes[](1);
        items[0] = _activateBridge(address(c.bridge));
        assertFalse(
            _founderSends(owner, address(fd), abi.encodeCall(CascadeBase.schedule, (items[0]))),
            "the gas model: the founder's Reopen is not sent, its account swept"
        );
        uint64 t1 = uint64(vm.getBlockTimestamp());
        tries = _thiefUnderTheStack(fd, items, t1 + 30 days);
        assertEq(tries, 4, "the front-door Reopen tried at each of its readyAts, each refused");
        // a stalemate: nothing ran, nothing lost, Base exits closed
        _assertNothingRan("60 days under the stack");
        assertFalse(_bridgeUp(fd, address(c.bridge)), "the Base primary never comes back");
        _assertDoor(true, false, "the front door still in state O");
        assertEq(c.vaultLens.totalAssets(), assets, "principal intact: totalAssets");
        assertEq(v.totalSupply(), supply, "the supply");
        assertEq(c.vaultLens.price(), price, "the price");
        assertEq(_baseCloseErr(), PrimaryBridgeDisabled.selector, "Base closes still fail");
        _assertPayoutLands(queued, "payouts land under the stalemate");
        _assertDirectWorks("direct exits still");
        _assertSwept("the end");
    }

    /// Row 4, HO: "a Reopen".
    /// The honest owner disables the front door's primary (its Base rail suspect): the front door in state O; Base
    /// requests wait in the open batch, payouts land, the vault reads OPEN. Its Reopen, scheduled a second after the
    /// disable's stamp, runs in 7 days: the waiting requests close and are delivered. Then the hand-off the owner key
    /// exists for: the front door transferred to a Safe (8 days), whose acceptance clears the pending owner's time
    /// (the lens carry: the front door's `pendingSince`, non-zero while it waits).
    function test_T4_HO() public {
        CascadeFrontDoor fd = c.fd;
        Delivery memory queued = _queueOne();
        Schedule.wait(1);
        vm.prank(owner);
        fd.disableBridge(address(c.bridge));
        _assertDoor(true, false, "the honest owner's hold on the front door");
        _assertVault(false, false, "the vault reads OPEN");
        _request(holders[3], c.vault.balanceOf(holders[3]) / 5);
        assertEq(fd.redeemOf(holders[3]), c.vault.balanceOf(holders[3]) / 5, "a request waits in the open batch");
        assertEq(_baseCloseErr(), PrimaryBridgeDisabled.selector, "closes wait for the Reopen");
        _assertPayoutLands(queued, "payouts land meanwhile");
        // the Reopen, scheduled after the disable's stamp: 7 days
        Schedule.wait(1);
        bytes memory reopen = _activateBridge(address(c.bridge));
        uint64 tr = uint64(vm.getBlockTimestamp());
        _sched(fd, reopen);
        assertEq(uint8(_kind(fd, reopen)), uint8(Kind.Reopen), "a Reopen");
        uint64 when = _executeAtReady(fd, reopen);
        assertEq(when - tr, REGISTRY, "the Reopen's 7 days");
        _assertDoor(false, false, "the front door OPEN");
        Delivery memory waited = _closeDoor();
        assertFalse(waited.failed, "the waiting request is delivered");
        assertGt(waited.burned, 0, "and burned");
        _assertDoorWorks("after the Reopen");
        // the hand-off to a Safe: 8 days, then the Safe accepts from OPEN
        address safe = makeAddr("the founder's Safe");
        bytes memory transfer = _transfer(safe);
        _sched(fd, transfer);
        uint64 ran = _executeAtReady(fd, transfer);
        assertEq(ran - when, GUARDIAN, "the transfer's 8 days");
        assertEq(fd.pendingOwner(), safe, "the Safe pending");
        assertEq(c.doorLens.pendingSince(), ran, "the front door's pendingSince: the execute (the lens carry)");
        _lensParity();
        vm.prank(safe);
        fd.acceptOwnership();
        assertEq(fd.owner(), safe, "the front door the Safe's");
        assertEq(c.doorLens.pendingSince(), 0, "pendingSince cleared");
        _lensParity();
    }

    // =====================================================================================================
    // row 5: the daily cancelPayoutBatch of launch-door batches (Task 41a)
    // =====================================================================================================

    /// The day's run of the cancel campaign: every holder with more than dust asks to redeem a tenth of its shares,
    /// the batch is delivered, and the thief, holding the owner key, cancels it at once: each entry re-minted the value
    /// it was owed, never more shares than it burned; the cancel stamps the owner's clock. Returns how many entries.
    function _deliverAndCancel() internal returns (uint256 entries) {
        CascadeVault v = c.vault;
        uint256[] memory before = new uint256[](HOLDERS);
        for (uint256 i; i < HOLDERS; ++i) {
            before[i] = v.balanceOf(holders[i]);
            if (_valueOf(holders[i]) >= 10 * MIN_REDEEM_VALUE) _request(holders[i], before[i] / 10);
        }
        Delivery memory d = _closeDoor();
        assertFalse(d.failed, "the day's batch is delivered");
        entries = d.list.length;
        assertGt(entries, 0, "and burns");
        vm.recordLogs();
        vm.prank(owner);
        v.cancelPayoutBatch(d.key, d.list);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(c.vaultLens.lastOwnerClose(), vm.getBlockTimestamp(), "each cancel stamps the owner's clock");
        uint256 reversed;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(v) || logs[i].topics.length < 3) continue;
            if (logs[i].topics[0] != RedeemReversed.selector) continue;
            (uint256 shares,) = abi.decode(logs[i].data, (uint256, uint256));
            address user = address(uint160(uint256(logs[i].topics[2])));
            for (uint256 j; j < d.list.length; ++j) {
                if (d.list[j].user == user) assertLe(shares, d.list[j].shares, "never more shares than it burned");
            }
            ++reversed;
        }
        assertEq(reversed, entries, "every entry re-minted");
        for (uint256 i; i < HOLDERS; ++i) {
            assertLe(v.balanceOf(holders[i]), before[i], "a holder's shares back, never more");
            assertApproxEqAbs(v.balanceOf(holders[i]), before[i], 1e9, "a holder's shares back, to rounding");
        }
        assertEq(c.vaultLens.getPayoutBatch(d.key).count, 0, "the batch gone: nothing went out");
    }

    /// Every one of the vault's `items` (each ready and inside its window) is dead: the owner's clock is past its
    /// schedule time and its execute is refused ExitsNotOpen.
    function _assertAllDead(bytes[] memory items) internal {
        for (uint256 i; i < items.length; ++i) {
            Item memory it = c.vaultLens.scheduled(keccak256(items[i]));
            assertGe(vm.getBlockTimestamp(), it.readyAt, "ready");
            assertGe(c.vaultLens.lastOwnerClose(), it.scheduledAt, "a stamp came after it");
            _execRefused(c.vault, items[i], _err(ExitsNotOpen.selector), "the thief's item, dead");
        }
    }

    /// Row 5, SO: "each cancel stamps the owner's clock: no progress; Base exits do not complete while it continues;
    /// **bound: indefinite, no loss** (the owed value comes back each time, never more shares than were burned, so a
    /// fall in between stays the redeemers'; while the cancels continue, the redeemers forgo the vault's rewards on
    /// that value)".
    /// (The rewards clause is not asserted: no rewards accrue in this world.)
    /// The thief, holding the owner key, schedules its takeover items from OPEN and cancels every launch-door batch
    /// as it is delivered, a day at a time for 30 days: each cancel stamps the owner's clock and re-mints each entry
    /// its owed value; its own items die to its own stamps; the vault stays OPEN (a cancel is a point closure, no hold)
    /// and direct exits work; no Base exit completes; 30 days on nothing is lost.
    function test_T5_SO() public {
        CascadeVault v = c.vault;
        // the outflow limit as at the start, which `_assertNothingRan` compares against
        _outflowAtCopy = c.vaultLens.maxDailyOutflowBps();
        uint256 assets = c.vaultLens.totalAssets();
        uint256 supply = v.totalSupply();
        uint256 price = c.vaultLens.price();
        bytes[] memory items = _takeover();
        for (uint256 i; i < items.length; ++i) {
            _sched(v, items[i]);
        }
        uint64 t0 = uint64(vm.getBlockTimestamp());
        for (uint256 d; d < 30; ++d) {
            Schedule.warpTo(t0 + d * 1 days + 1 hours);
            _deliverAndCancel();
            _assertVault(false, false, "a cancel is a point closure: OPEN");
            _assertDirectWorks("direct exits work");
            // no progress: on day 8 every takeover item is ready, inside its window, and dead to the cancels' stamps
            if (d == 8) _assertAllDead(items);
        }
        _assertNothingRan("30 days of cancels");
        // bound: indefinite, no loss
        assertEq(c.vaultLens.totalAssets(), assets, "no loss: totalAssets");
        assertEq(v.totalSupply(), supply, "the supply");
        assertEq(c.vaultLens.price(), price, "the price");
    }

    /// Row 5, SG: "cannot (owner-only)".
    /// The stolen guardian's cancel of a launch-door batch is refused (the owner's only), stamping nothing; the batch
    /// is paid once due and credited on Base.
    function test_T5_SG() public {
        CascadeVault v = c.vault;
        Delivery memory queued = _queueOne();
        _refuses(
            guardian,
            address(v),
            abi.encodeCall(v.cancelPayoutBatch, (queued.key, queued.list)),
            _notOwner(guardian),
            "the guardian cannot cancel a batch"
        );
        assertEq(c.vaultLens.lastOwnerClose(), 0, "nothing stamped");
        assertEq(c.vaultLens.lastGuardianClose(), 0, "on either clock");
        _assertVault(false, false, "OPEN");
        _assertPayoutLands(queued, "the batch goes out");
    }

    /// Row 5, SOG: "as row 1" (O or G at will; nothing to veto them; a rogue door needs 7 OPEN days, in which the
    /// shared allowance lets about 36% of a door's base be paid out at the floor in the worst case found, about 74%
    /// with neither tightening, the case this cell runs; all assuming no thief-held shares in the queue; bound: 7
    /// days of open exits on the vault before any drain).
    /// Both keys: while the thief cancels the day's batch, each cancel stamps and kills its own rogue door, scheduled
    /// again each day; so the door can run only 7 OPEN days after its last cancel. It stops; the door's 7 days, a run
    /// at the floor: about 74% paid first, and the last day's batch the thief's at the door's readyAt.
    function test_T5_SOG() public {
        CascadeVault v = c.vault;
        bytes memory door = _activateDoor(BASE, rogue);
        uint64 ts = uint64(vm.getBlockTimestamp());
        for (uint256 d; d < 5; ++d) {
            Schedule.warpTo(ts + d * 1 days + 1 hours);
            _sched(v, door);
            Schedule.wait(1);
            _deliverAndCancel();
            Item memory it = c.vaultLens.scheduled(keccak256(door));
            assertGe(c.vaultLens.lastOwnerClose(), it.scheduledAt, "each cancel kills the door scheduled before it");
        }
        Schedule.warpTo(c.vaultLens.scheduled(keccak256(door)).readyAt);
        _execRefused(v, door, _err(ExitsNotOpen.selector), "a door scheduled before a cancel never runs");
        _assertVault(false, false, "OPEN throughout: each cancel a point closure");
        // the cancels stop: the door's 7 OPEN days, a run at the floor first
        Schedule.wait(1);
        uint64 t0 = uint64(vm.getBlockTimestamp());
        _sched(v, door);
        _tightenToTheFloor();
        uint256 daveAll = v.balanceOf(dave);
        vm.prank(dave);
        v.redeemDirect(daveAll, false);
        Run memory r = _runAtTheFloor(t0, 7, rogue);
        (uint64 when, uint256 reminted, uint256 taken) = _theThiefTakesWhatIsQueued(r, door, rogue);
        assertEq(when - t0, REGISTRY, "7 OPEN days after the last cancel");
        _assertShare(r, reminted, taken);
    }

    /// Row 5, CO: "stalemate".
    /// Under the copy, the thief cancels every launch-door batch as it is delivered, for 30 days: its own stamps and
    /// the founder's stack kill every item it schedules; nothing runs, nothing is lost, and no Base exit completes
    /// while it continues: a stalemate. (The thief's own cancels stamp too, so this cell cannot tell the stack's work
    /// from the cancels': the relay count shows the stack ran, not that it mattered. `test_T1_CO` carries the stack's
    /// evidence, its items tried with the vault OPEN and no cancel.)
    function test_T5_CO() public {
        CascadeVault v = c.vault;
        _copySeed();
        uint256 assets = c.vaultLens.totalAssets();
        uint256 supply = v.totalSupply();
        uint256 price = c.vaultLens.price();
        Schedule.wait(1);
        bytes[] memory items = _takeover();
        for (uint256 i; i < items.length; ++i) {
            swept();
            _sched(v, items[i]);
        }
        uint64 t0 = uint64(vm.getBlockTimestamp());
        for (uint256 d; d < 30; ++d) {
            _coWait(t0 + d * 1 days + 1 hours, false);
            swept();
            _deliverAndCancel();
            _assertVault(false, false, "OPEN: a cancel is a point closure");
            _assertDirectWorks("direct exits work");
            if (d == 8) _assertAllDead(items);
        }
        _assertNothingRan("30 days of cancels under the stack");
        assertEq(c.vaultLens.totalAssets(), assets, "no loss: totalAssets");
        assertEq(v.totalSupply(), supply, "the supply");
        assertEq(c.vaultLens.price(), price, "the price");
        assertEq(_stackRelays, 59, "the stack relayed throughout: a stamp every 12 hours");
        _assertSwept("the end");
    }

    /// Row 5, HO: "a real cancel stamps once; re-schedule after".
    /// Pending at the incident: a Param-class loosening, a guardian swap and a Registry-class activation. A forged
    /// launch-door batch lands (a rail's fault); the honest owner cancels it, re-minting the holder's shares: one
    /// stamp, which kills every item pending; re-scheduled a second after it, each runs at its class delay.
    function test_T5_HO() public {
        CascadeVault v = c.vault;
        bytes memory outflow = abi.encodeCall(v.setOutflowLimits, (2_500, 100e18, 2_000));
        bytes memory swap = _swap(guardian2);
        bytes memory door = _activateDoor(BASE, g.door3);
        _sched(v, outflow);
        _sched(v, swap);
        _sched(v, door);
        Schedule.wait(1 days);
        uint256 victimShares = v.balanceOf(holders[5]);
        (bytes4 err, Delivery memory d) = _forge(address(c.bridge), address(c.fd), holders[5]);
        assertEq(err, bytes4(0), "the forged batch lands");
        uint64 tc = uint64(vm.getBlockTimestamp());
        vm.prank(owner);
        v.cancelPayoutBatch(d.key, d.list);
        assertEq(c.vaultLens.lastOwnerClose(), tc, "a real cancel stamps once");
        assertApproxEqAbs(v.balanceOf(holders[5]), victimShares, 1e9, "the holder's shares re-minted");
        assertLe(v.balanceOf(holders[5]), victimShares, "never more than burned");
        _assertVault(false, false, "no hold: OPEN");
        // what was pending died
        Schedule.warpTo(c.vaultLens.scheduled(keccak256(swap)).readyAt);
        _execRefused(v, outflow, _err(ExitsNotOpen.selector), "the stamp killed the loosening");
        _execRefused(v, swap, _err(ExitsNotOpen.selector), "the swap");
        _execRefused(v, door, _err(ExitsNotOpen.selector), "and the activation");
        // re-scheduled after the stamp, each runs at its class delay
        uint64 r = uint64(vm.getBlockTimestamp());
        _sched(v, outflow);
        _sched(v, swap);
        _sched(v, door);
        uint64 when = _executeAtReady(v, outflow);
        assertEq(when - r, PARAM, "re-scheduled after: the loosening in 48 hours");
        when = _executeAtReady(v, door);
        assertEq(when - r, REGISTRY, "the activation in 7 days");
        when = _executeAtReady(v, swap);
        assertEq(when - r, GUARDIAN, "the swap in 8 days");
        assertEq(c.vaultLens.guardian(), guardian2, "the swap ran");
        _assertDirectWorks("after");
        _assertDoorWorks("after");
    }

    // =====================================================================================================
    // T-6: every non-instrument at its bounds (Task 41a)
    // =====================================================================================================

    /// One non-instrument at a bound: `data` on `target` by the owner (or `caller`, when set), at once, or, when
    /// `scheduled` (its loosening direction), through the scheduler and executed at its class delay.
    struct Setting {
        CascadeBase target;
        bytes data;
        bool scheduled;
        address caller;
        string name;
    }

    function _at(CascadeBase t, bytes memory data, string memory name) internal pure returns (Setting memory) {
        return Setting(t, data, false, address(0), name);
    }

    function _later(CascadeBase t, bytes memory data, string memory name) internal pure returns (Setting memory) {
        return Setting(t, data, true, address(0), name);
    }

    /// Every non-instrument the table's row 6 names, at each of its bounds (both ends where it has two), on both
    /// contracts: the vault's keeper, limit setters, caps, vesting, gas settings and hotkey management; the front
    /// door's caps, batch settings, keeper, delivery settings, pause (by either account) and pot sweep. A loosening
    /// direction is scheduled; everything else is at once.
    function _nonInstruments() internal view returns (Setting[] memory s) {
        CascadeVault v = c.vault;
        CascadeFrontDoor fd = c.fd;
        uint256 message = c.vaultLens.maxMessageValue();
        address tr = treasury;
        s = new Setting[](50);
        uint256 n;
        // the vault
        s[n++] = _at(v, abi.encodeCall(v.setKeeper, (address(0))), "vault setKeeper(0)");
        s[n++] = _at(v, abi.encodeCall(v.setKeeper, (stranger)), "vault setKeeper(another)");
        s[n++] = _at(v, abi.encodeCall(v.setMinDirectDeposit, (0)), "setMinDirectDeposit(0)");
        s[n++] = _at(v, abi.encodeCall(v.setMinDirectDeposit, (type(uint256).max)), "setMinDirectDeposit(max)");
        s[n++] = _at(v, abi.encodeCall(v.setMaxTotalAssets, (0)), "setMaxTotalAssets(0)");
        s[n++] = _later(v, abi.encodeCall(v.setMaxTotalAssets, (type(uint256).max)), "setMaxTotalAssets(max)");
        s[n++] = _at(v, abi.encodeCall(v.setOutflowLimits, (2_000, 10e18, 2_000)), "setOutflowLimits(floor)");
        s[n++] = _later(v, abi.encodeCall(v.setOutflowLimits, (5_000, 100e18, 5_000)), "setOutflowLimits(top)");
        s[n++] = _at(
            v,
            abi.encodeCall(v.setMessageLimits, (10e18, 10e18, uint32(CascadeMessages.MAX_ENTRIES))),
            "messages(floor)"
        );
        s[n++] = _later(v, abi.encodeCall(v.setMessageLimits, (message, message, 1)), "setMessageLimits(top)");
        s[n++] = _at(v, abi.encodeCall(v.setFeeLimits, (0, 0.01e18)), "setFeeLimits(floor)");
        s[n++] = _later(v, abi.encodeCall(v.setFeeLimits, (500, 0.015e18)), "setFeeLimits(top)");
        s[n++] = _at(v, abi.encodeCall(v.setPayoutDelay, (48 hours)), "setPayoutDelay(48 h)");
        s[n++] = _later(v, abi.encodeCall(v.setPayoutDelay, (1 hours)), "setPayoutDelay(1 h)");
        s[n++] = _later(v, abi.encodeCall(v.setRewardCut, (tr, 2_000)), "setRewardCut(top)");
        s[n++] = _at(v, abi.encodeCall(v.setRewardVesting, (30 days)), "setRewardVesting(30 days)");
        s[n++] = _later(v, abi.encodeCall(v.setRewardVesting, (1 days)), "setRewardVesting(1 day)");
        s[n++] = _at(v, abi.encodeCall(v.setClaimGasRequired, (54_100_000)), "setClaimGasRequired(floor)");
        s[n++] = _at(v, abi.encodeCall(v.setClaimGasRequired, (63_400_000)), "setClaimGasRequired(top)");
        s[n++] = _at(v, abi.encodeCall(v.setHotkeyDustRao, (0)), "setHotkeyDustRao(0)");
        s[n++] = _at(v, abi.encodeCall(v.setHotkeyDustRao, (type(uint256).max / RAO)), "setHotkeyDustRao(top)");
        s[n++] = _at(v, abi.encodeCall(v.setUnstakeMarginRao, (1e9)), "setUnstakeMarginRao(1 TAO)");
        s[n++] = _at(v, abi.encodeCall(v.setUnstakeGas, (150_000)), "setUnstakeGas(floor)");
        s[n++] = _at(v, abi.encodeCall(v.setUnstakeGas, (5_000_000)), "setUnstakeGas(top)");
        s[n++] = _at(v, abi.encodeCall(v.setIdleBuffer, (1_000)), "setIdleBuffer(10%)");
        s[n++] = _at(v, abi.encodeCall(v.addHotkey, (HK3)), "addHotkey");
        s[n++] = Setting(v, abi.encodeCall(v.addHotkey, (HK3)), false, guardian, "addHotkey (guardian)");
        s[n++] = Setting(v, abi.encodeCall(v.addHotkey, (HK3)), false, address(keeperC), "addHotkey (keeper)");
        s[n++] = _at(v, abi.encodeCall(v.removeHotkey, (HK2, false)), "removeHotkey (an empty one)");
        s[n++] = Setting(v, abi.encodeCall(v.removeHotkey, (HK2, false)), false, guardian, "removeHotkey (guardian)");
        s[n++] =
            Setting(v, abi.encodeCall(v.removeHotkey, (HK2, false)), false, address(keeperC), "removeHotkey (keeper)");
        s[n++] = _later(v, abi.encodeCall(v.setStakeHotkey, (HK2)), "setStakeHotkey");
        s[n++] = _later(v, abi.encodeCall(v.moveStake, (HK2, HK1, 1e9)), "moveStake (an empty position)");
        // the front door
        s[n++] = _at(fd, abi.encodeCall(fd.setKeeper, (address(0))), "door setKeeper(0)");
        s[n++] = _at(fd, abi.encodeCall(fd.setCaps, (fd.MIN_DEPOSIT_FLOOR(), 0)), "setCaps(no deposits)");
        s[n++] = _at(fd, abi.encodeCall(fd.setCaps, (fd.MIN_DEPOSIT_FLOOR(), type(uint256).max)), "setCaps(top)");
        s[n++] = _at(fd, abi.encodeCall(fd.setBatchLimits, (1, 1)), "setBatchLimits(1, 1)");
        s[n++] = _at(
            fd,
            abi.encodeCall(
                fd.setBatchLimits, (uint32(CascadeMessages.MAX_ENTRIES), uint32(CascadeMessages.MAX_ENTRIES))
            ),
            "setBatchLimits(top)"
        );
        s[n++] = _at(fd, abi.encodeCall(fd.setMaxBatchValue, (0)), "setMaxBatchValue(0)");
        s[n++] = _later(fd, abi.encodeCall(fd.setMaxBatchValue, (fd.MAX_BATCH_VALUE())), "maxBatchValue(top)");
        s[n++] = _at(fd, abi.encodeCall(fd.setBatchInterval, (24 hours)), "setBatchInterval(24 h)");
        s[n++] = _later(fd, abi.encodeCall(fd.setBatchInterval, (0)), "setBatchInterval(0)");
        s[n++] = _at(fd, abi.encodeCall(fd.setRedeemRequestFee, (0)), "setRedeemRequestFee(0)");
        s[n++] = _at(fd, abi.encodeCall(fd.setRedeemRequestFee, (fd.MAX_REDEEM_REQUEST_FEE())), "requestFee(top)");
        s[n++] = _at(fd, abi.encodeCall(fd.setMaxDeliverySlippage, (0)), "setMaxDeliverySlippage(0)");
        s[n++] = _later(fd, abi.encodeCall(fd.setMaxDeliverySlippage, (300)), "setMaxDeliverySlippage(top)");
        s[n++] = _at(fd, abi.encodeCall(fd.setMinPoolLiquidity, (0, type(uint128).max)), "setMinPoolLiquidity(top)");
        s[n++] = _at(fd, abi.encodeCall(CascadeBase.pause, ()), "the Base pause (owner)");
        s[n++] = Setting(fd, abi.encodeCall(CascadeBase.pause, ()), false, guardian, "the Base pause (guardian)");
        s[n++] = _at(fd, abi.encodeCall(fd.sweepPot, (fd.potCarried())), "sweepPot");
        assertEq(n, s.length, "every setting listed");
    }

    /// T-6: "everything else (`setKeeper`, every limit setter, caps, Base `pause`, `setBatchInterval`,
    /// `setUnstakeGas`, hotkey management, vesting up): no exit affected; no stamp; no progress gained
    /// (`setBatchLimits(1, 1)` makes each request close its own batch, so each requester pays a bridge fee; no exit is
    /// blocked)" (row 6, SO; SG: "no exit affected").
    /// Each non-instrument at each of its bounds, from the same start (a payout queued), in a snapshot: set at once or
    /// scheduled and executed at its class delay; then neither contract's clocks moved, both read OPEN, and every
    /// exit works: a direct exit, a door exit end to end (request, close, delivery, payout, credit on Base) and the
    /// queued payout.
    function test_T6() public {
        MockStaking(ISTAKING_ADDRESS).addHotkey(HK3);
        Delivery memory queued = _queueOne();
        Setting[] memory s = _nonInstruments();
        for (uint256 i; i < s.length; ++i) {
            Mark memory m = _mark();
            uint64[4] memory clocks = _clocks();
            if (s[i].scheduled) {
                _sched(s[i].target, s[i].data);
                _executeAtReady(s[i].target, s[i].data);
            } else {
                vm.prank(s[i].caller == address(0) ? s[i].target.owner() : s[i].caller);
                (bool set, bytes memory reason) = address(s[i].target).call(s[i].data);
                assertTrue(set, string.concat(s[i].name, ": set at once, ", vm.toString(reason)));
            }
            _assertNonInstrument(clocks, queued, s[i].name);
            _back(m);
        }

        // row 6's own example, combined with a zero request fee: each request closes the batch before it, and with an
        // empty pot that close is refused, so a second request waits until anyone closes the first, paying the fee
        Mark memory w = _mark();
        uint64[4] memory before = _clocks();
        vm.prank(owner);
        c.fd.setBatchLimits(1, 1);
        vm.prank(owner);
        c.fd.setRedeemRequestFee(0);
        _assertNonInstrument(before, queued, "setBatchLimits(1, 1) with no request fee");
        _request(holders[1], c.vault.balanceOf(holders[1]) / 10);
        uint256 second = c.vault.balanceOf(holders[2]) / 10;
        vm.prank(holders[2]);
        (bool ok, bytes memory why) = address(c.fd).call(abi.encodeCall(c.fd.requestRedeem, (second)));
        assertFalse(ok, "a second request waits: its auto-close has no pot");
        assertEq(why, _err(CascadeFrontDoor.InsufficientFee.selector), "the pot short of the bridge fee");
        Delivery memory first = _closeDoor();
        assertFalse(first.failed, "anyone closes the first, paying the fee");
        _request(holders[2], c.vault.balanceOf(holders[2]) / 10);
        assertGt(c.fd.redeemOf(holders[2]), 0, "then the second goes in: no exit blocked");
        _back(w);

        // setStakeHotkey's immediate path: after the stake hotkey's validator swaps its key (whole) and the new one is
        // listed, the owner points new stake at it at once; no stamp, every exit works
        before = _clocks();
        MockStaking(ISTAKING_ADDRESS).swapHotkey(HK1, HK3, c.vault.exposed_coldkey(), 10_000);
        vm.prank(stranger);
        c.vault.addHotkey(HK3);
        vm.prank(owner);
        c.vault.setStakeHotkey(HK3);
        assertEq(c.vault.exposed_stakeHotkey(), HK3, "at once: it follows the moved stake");
        _assertNonInstrument(before, queued, "setStakeHotkey after moved stake");
    }

    function _clocks() internal view returns (uint64[4] memory) {
        return [
            c.vaultLens.lastOwnerClose(),
            c.vaultLens.lastGuardianClose(),
            c.doorLens.lastOwnerClose(),
            c.doorLens.lastGuardianClose()
        ];
    }

    /// After a non-instrument: no clock moved on either contract, both read OPEN, and every exit works (a direct
    /// exit, a door exit end to end, the queued payout).
    function _assertNonInstrument(uint64[4] memory clocks, Delivery memory queued, string memory name) internal {
        assertEq(c.vaultLens.lastOwnerClose(), clocks[0], string.concat(name, ": no stamp (the vault, owner)"));
        assertEq(c.vaultLens.lastGuardianClose(), clocks[1], string.concat(name, ": nor its guardian's"));
        assertEq(c.doorLens.lastOwnerClose(), clocks[2], string.concat(name, ": nor the front door's owner's"));
        assertEq(c.doorLens.lastGuardianClose(), clocks[3], string.concat(name, ": nor its guardian's"));
        _assertVault(false, false, name);
        _assertDoor(false, false, name);
        _assertDirectWorks(name);
        _assertDoorWorks(name);
        _assertPayoutLands(queued, name);
    }

    /// The vault's stake on hotkey `h`, read from the staking precompile (root).
    function _stakeOn(bytes32 h) internal view returns (uint256) {
        return MockStaking(ISTAKING_ADDRESS).getStake(h, c.vault.exposed_coldkey(), 0);
    }

    /// T-6's tightenings against the payouts (Task 40's carry, the re-review's N-1 follow-up): the fee limits,
    /// `setUnstakeGas` and hotkey management strand nothing more than Task 40's worst cases. None of them moves a
    /// close's due time (`canClose` reads the batch interval and limits) or a payout's (`processPayouts` reads only its
    /// batch's queue time and the payout delay); none cuts the allowance's base (min(visible, booked) less what ramps:
    /// a stake move stays on a listed hotkey, an owner's removal moves its stake to the stake hotkey, only `stakeIdle`
    /// ramps); a fee above the ceiling is any caller's to top up, and a removal's gas floor the caller's gas to meet.
    /// Measured: Task 40's stacked case (`test_T1_SOG`'s third branch, 59%) with each at its worst as well. Before its
    /// door the thief splits the stake across two hotkeys (the stake hotkey moved to HK2, half of HK1's stake moved
    /// onto it: 48 hours each) and lists a third, so the payout walks take from more than one position; then the gas
    /// floor at its top and the fee ceiling at its floor. The share paid before the rogue door is the same. Two of the
    /// three steps prove nothing in this world: the mock rail's fee (0.001 TAO) is under the fee ceiling's floor (0.01),
    /// so the ceiling never binds, and the test EVM has no block gas limit, so the gas floor never binds; the README's
    /// gas notes give the arithmetic for the chain. The hotkey freeze, hotkey management's one way to stop every exit,
    /// is `test_T6_hotkeyFreeze`.
    function test_T6_noMoreStranding() public {
        CascadeVault v = c.vault;
        uint256 base0 = _base();
        bytes memory toHK2 = abi.encodeCall(v.setStakeHotkey, (HK2));
        bytes memory move = abi.encodeCall(v.moveStake, (HK1, HK2, _stakeOn(HK1) / 2));
        _sched(v, toHK2);
        _sched(v, move);
        _executeAtReady(v, toHK2);
        _executeNow(v, move);
        assertEq(c.vault.exposed_stakeHotkey(), HK2, "the stake hotkey moved");
        assertGt(_stakeOn(HK1), 0, "stake on HK1");
        assertGt(_stakeOn(HK2), 0, "and on HK2");
        assertEq(_base(), base0, "the base unchanged by the split");
        MockStaking(ISTAKING_ADDRESS).addHotkey(HK3);
        vm.prank(owner);
        v.addHotkey(HK3);
        // the door from OPEN, the floor, the gas floor and the fee ceiling at their worst, dave out
        Schedule.wait(1);
        bytes memory door = _activateDoor(BASE, rogue);
        uint64 t0 = uint64(vm.getBlockTimestamp());
        _sched(v, door);
        _tightenToTheFloor();
        vm.prank(owner);
        v.setUnstakeGas(5_000_000);
        vm.prank(owner);
        v.setFeeLimits(0, 0.01e18);
        uint256 daveAll = v.balanceOf(dave);
        vm.prank(dave);
        v.redeemDirect(daveAll, false);
        uint256 hk1 = _stakeOn(HK1);
        uint256 hk2 = _stakeOn(HK2);
        // the stacked case, as Task 40's third branch
        _holdTheFirstClose();
        Run memory r = _runAtTheFloor(t0 + 1 days, 6, rogue, 5);
        assertLt(_stakeOn(HK2), hk2, "the payouts drew on HK2");
        assertLt(_stakeOn(HK1), hk1, "and walked on to HK1");
        _assertVault(false, false, "OPEN throughout");
        _assertDoor(false, false, "both chains");
        (uint64 when, uint256 reminted, uint256 taken) = _theThiefTakesWhatIsQueued(r, door, rogue);
        assertEq(when - t0, REGISTRY, "the same 7 OPEN days");
        _assertStackedShare(r, reminted, taken);
    }

    /// The thief's validator's hotkeys: `V(0)` the one it lists, `V(k)` the k-th swap's.
    function _V(uint256 k) internal pure returns (bytes32) {
        return bytes32(uint256(0xA0 + k));
    }

    /// The freeze's state after a swap: stake missing, the vault OPEN with neither clock moved, a direct exit and a
    /// door delivery refused StakeMissing; a queued payout (`processPayouts` reads no stake guard) is paid from what
    /// the listed hotkeys still hold, else refused UnstakeShort (`payoutErr`: a whole swap leaves them nothing).
    function _assertFrozen(Delivery memory queued, bytes4 payoutErr, string memory why) internal {
        assertGt(c.vault.exposed_missingStakeRao(), 0, string.concat(why, ": stake reads missing"));
        _assertVault(false, false, string.concat(why, ": the vault reads OPEN"));
        assertEq(c.vaultLens.lastOwnerClose(), 0, string.concat(why, ": no stamp, the owner's clock"));
        assertEq(c.vaultLens.lastGuardianClose(), 0, string.concat(why, ": nor the guardian's"));
        _assertDirectRefused(StakeMissing.selector, why);
        _assertDoorRefused(StakeMissing.selector, why);
        assertEq(_payoutErr(queued.key, queued.list), payoutErr, string.concat(why, ": the queued payout"));
    }

    /// The stranger re-lists the swap's new hotkey `h` (anyone may while stake is missing, of a never-listed hotkey
    /// holding the chain's minimum), first removing an empty one when the set is full (anyone may, then); whether it
    /// could.
    function _strangerRelists(bytes32 h) internal returns (bool) {
        CascadeVault v = c.vault;
        if (c.vault.exposed_hotkeyCount() == 4) {
            bool removed;
            for (uint256 i; i < 4 && !removed; ++i) {
                bytes32 e = c.vault.exposed_hotkeys(i);
                if (_stakeOn(e) != 0 || e == c.vault.exposed_stakeHotkey()) continue;
                vm.prank(stranger);
                v.removeHotkey(e, false);
                removed = true;
            }
            if (!removed) return false;
        }
        vm.prank(stranger);
        (bool ok,) = address(v).call(abi.encodeCall(v.addHotkey, (h)));
        return ok;
    }

    /// The hotkey freeze (Task 41a's review, I-1; the controller's ruling: the both-keys class, tests and docs only).
    /// Hotkey management with real stake: the thief lists a hotkey of a validator it runs, moves the stake hotkey and
    /// the stake onto it (`setStakeHotkey`, `moveStake`: the Param class, 48 hours, Ordinary, so with an honest guardian
    /// it is vetoed, shown first; under SOG nothing vetoes it), then swaps that validator's hotkey on the chain. The
    /// stake now sits under a hotkey the vault does not list: stake reads missing, and every door delivery and direct
    /// exit is refused StakeMissing while the vault reads OPEN, with no stamp. Whole swaps: a stranger re-lists the new
    /// hotkey each time and exits work again, until the next swap. Partial swaps (the old hotkey keeps a share: the
    /// mock's model, unverified on the chain, Task 63): after the fourth swap the set is full of hotkeys holding stake,
    /// no stranger can make room, and exits stay refused; only the owner, the thief, could list the new hotkey.
    function test_T6_hotkeyFreeze() public {
        CascadeVault v = c.vault;
        Delivery memory queued = _queueOne();
        uint256 all = _stakeOn(HK1);
        MockStaking(ISTAKING_ADDRESS).addHotkey(_V(0));
        vm.prank(owner);
        v.addHotkey(_V(0));
        bytes memory toV = abi.encodeCall(v.setStakeHotkey, (_V(0)));
        bytes memory move = abi.encodeCall(v.moveStake, (HK1, _V(0), all));
        uint64 t0 = uint64(vm.getBlockTimestamp());
        _sched(v, toV);
        _sched(v, move);
        // with an honest guardian: the veto (both are Ordinary)
        Mark memory m = _mark();
        vm.prank(guardian);
        v.cancel(keccak256(move));
        assertFalse(_pending(v, move), "SO: the honest guardian vetoes the move");
        _back(m);
        // under SOG: nothing vetoes it; in 48 hours the stake is on the thief's validator
        uint64 when = _executeAtReady(v, toV);
        _executeNow(v, move);
        assertEq(when - t0, PARAM, "48 hours");
        assertEq(_stakeOn(_V(0)), all, "the stake on the thief's validator");
        _assertVault(false, false, "OPEN, no stamp");
        _assertDirectWorks("before any swap");
        _assertDoorWorks("before any swap");
        Mark memory moved = _mark();

        // whole swaps: a stranger re-lists each new hotkey, and exits work again until the next swap
        for (uint256 k = 1; k <= 6; ++k) {
            Schedule.wait(1 hours);
            MockStaking(ISTAKING_ADDRESS).swapHotkey(_V(k - 1), _V(k), c.vault.exposed_coldkey(), 10_000);
            _assertFrozen(queued, UnstakeShort.selector, string.concat("whole swap ", vm.toString(k)));
            assertTrue(_strangerRelists(_V(k)), "a stranger re-lists the new hotkey");
            assertEq(c.vault.exposed_missingStakeRao(), 0, "nothing missing again");
            _assertDirectWorks("re-listed");
            _assertDoorWorks("re-listed");
        }

        // partial swaps, the mock's model (unverified on the chain): the old hotkey keeps 10% each time
        _back(moved);
        for (uint256 k = 1; k <= 3; ++k) {
            Schedule.wait(1 hours);
            MockStaking(ISTAKING_ADDRESS).swapHotkey(_V(k - 1), _V(k), c.vault.exposed_coldkey(), 9_000);
            _assertFrozen(queued, bytes4(0), string.concat("partial swap ", vm.toString(k)));
            assertTrue(_strangerRelists(_V(k)), "a stranger re-lists it while a slot can be freed");
            assertEq(c.vault.exposed_missingStakeRao(), 0, "nothing missing again");
            _assertDirectWorks("re-listed");
        }
        assertEq(c.vault.exposed_hotkeyCount(), 4, "the set full");
        for (uint256 i; i < 4; ++i) {
            assertGt(_stakeOn(c.vault.exposed_hotkeys(i)), 0, "of hotkeys that each hold stake");
        }
        Schedule.wait(1 hours);
        MockStaking(ISTAKING_ADDRESS).swapHotkey(_V(3), _V(4), c.vault.exposed_coldkey(), 9_000);
        _assertFrozen(queued, bytes4(0), "partial swap 4");
        assertFalse(_strangerRelists(_V(4)), "the slots run out: no stranger can make room");
        _refuses(
            stranger, address(v), abi.encodeCall(v.addHotkey, (_V(4))), _err(TooManyHotkeys.selector), "the set full"
        );
        _refuses(
            stranger,
            address(v),
            abi.encodeCall(v.removeHotkey, (_V(1), false)),
            _err(NotAuthorized.selector),
            "no stranger may remove a hotkey that holds stake"
        );
        Schedule.wait(30 days);
        _assertFrozen(queued, bytes4(0), "30 days on: still frozen");
    }

    // =====================================================================================================
    // T-R: the reachability sweep (I-26, Task 41b)
    // =====================================================================================================

    /// The launch door's record, by the route to it: kept (no record, the door active), the owner's removal (the
    /// owner's record, the door Removed), the guardian's removal (the guardian's record, the door unknown), or the
    /// guardian's removal of the door the owner removed (the owner's record made the guardian's, the door unknown).
    uint8 internal constant KEPT = 0;
    uint8 internal constant BY_OWNER = 1;
    uint8 internal constant BY_GUARDIAN = 2;
    uint8 internal constant CONVERTED = 3;
    /// Not yet.
    uint64 internal constant NEVER = type(uint64).max;

    /// One closure of the sweep: who made each of the four records (None: unset).
    struct Closure {
        Actor paused; // the vault's pausedBy
        Actor bridge; // the vault's primaryDisabledBy
        uint8 door; // the vault's launchDoorRemovedBy, by its route
        Actor fdBridge; // the front door's primaryDisabledBy
    }

    /// The plan's `test_TR` (I-26): "every combination of the three vault records and the front door's record, each by
    /// owner and by guardian, then the owner's scripted way back reaches OPEN with no redeploy and no guardian action".
    /// The spec's I-26: "from every state the instruments can create, a sequence of owner calls (unpause, `setGuardian`,
    /// Reopen items, `setPrimaryBridge` while disabled) reaches OPEN, with no redeploy and no guardian action; over the
    /// four exit records it takes at most 15 days to OPEN and 22 to the launch door's return". `setPrimaryBridge` never
    /// runs here: no other bridge is enabled in this world, so each primary comes back by its Reopen. Task 40's
    /// `test_T3_SO` (the switch to a reopened known bridge) and the 39b liveness campaign (`LivenessHandler._ownerPath`,
    /// which draws the switch) cover it.
    /// The combinations: each of the four records unset, the owner's or the guardian's: 3^4 = 81. No combination is
    /// impossible: each instrument is open to both actors from any state (a closure has no gate), and each record
    /// holds one actor, a second instrument on a held record refused (`_assertOneActorARecord`), so the records make
    /// exactly these 81 states. The launch door's guardian record has two routes (the guardian's removal of the
    /// active door, and its removal of the door the owner removed, which makes the owner's record its own), both
    /// swept: 108 closures, one test per route of the launch door's record, each over the 27 combinations of the
    /// other three.
    /// Each closure is reached through the real instruments from OPEN (`_close`), the lenses compared with the targets
    /// at every step; then the owner's way back alone (`_wayBack`): it must reach OPEN on both chains at the time the
    /// contracts' delays give (`_assertBack`), with nothing created, no call by the guardian (a state-diff recording of
    /// the script), the same contracts, owner, guardian and rails, and every exit working.
    /// The times (from the owner's first call): the pause alone, at once; a primary disabled on either chain, or the
    /// door removed by the owner, 7 days (the Reopens); the door removed by the guardian, OPEN at 8 days (the swap) and
    /// the door back at 15 (its Ordinary activation); with the owner's own disable of the vault's primary besides,
    /// OPEN at 15 days (the swap waits out the owner's hold, its primary's Reopen) and the door back at 22.
    function test_TR_doorKept() public {
        _sweep(KEPT);
    }

    function test_TR_doorByOwner() public {
        _sweep(BY_OWNER);
    }

    function test_TR_doorByGuardian() public {
        _sweep(BY_GUARDIAN);
    }

    function test_TR_doorConverted() public {
        _sweep(CONVERTED);
    }

    /// The 27 closures with the launch door's record by `door`, each from OPEN, in its own snapshot.
    function _sweep(uint8 door) internal {
        _recorderControl();
        assertEq(c.fd.owner(), owner, "one owner on both chains");
        assertEq(c.doorLens.guardian(), guardian, "one guardian on both chains");
        assertEq(c.vaultLens.guardian(), guardian, "the vault's guardian");
        bytes32[2] memory code = [address(c.vault).codehash, address(c.fd).codehash];
        Actor[3] memory by = [Actor.None, Actor.Owner, Actor.Guardian];
        for (uint256 p; p < 3; ++p) {
            for (uint256 b; b < 3; ++b) {
                for (uint256 f; f < 3; ++f) {
                    Closure memory k = Closure(by[p], by[b], door, by[f]);
                    string memory name = _name(k);
                    Mark memory m = _mark();
                    _close(k, name);
                    _assertOneActorARecord(k, name);
                    // the owner acts an hour on (never in a stamp's second, which would kill its items at birth)
                    Schedule.wait(1 hours);
                    (uint64 open, uint64 done) = _wayBack(k, name);
                    _assertBack(k, open, done, code, name);
                    emit log_named_string(
                        name,
                        string.concat(
                            "OPEN on both chains at ",
                            vm.toString(open),
                            " s; the last item at ",
                            vm.toString(done),
                            " s"
                        )
                    );
                    _back(m);
                }
            }
        }
    }

    function _who(Actor a) internal pure returns (string memory) {
        return a == Actor.Owner ? "owner" : a == Actor.Guardian ? "guardian" : "-";
    }

    function _name(Closure memory k) internal pure returns (string memory) {
        string memory door = k.door == KEPT
            ? "-"
            : k.door == BY_OWNER ? "owner" : k.door == BY_GUARDIAN ? "guardian" : "owner, then guardian";
        return string.concat(
            "[pause ",
            _who(k.paused),
            "; vault primary ",
            _who(k.bridge),
            "; launch door ",
            door,
            "; Base primary ",
            _who(k.fdBridge),
            "]"
        );
    }

    function _doorActor(uint8 door) internal pure returns (Actor) {
        return door == KEPT ? Actor.None : door == BY_OWNER ? Actor.Owner : Actor.Guardian;
    }

    /// `a` (the owner or the guardian) calls `t` with `data`, which must work.
    function _actAs(Actor a, CascadeBase t, bytes memory data, string memory name) internal {
        address who = a == Actor.Owner ? owner : guardian;
        vm.prank(who);
        (bool ok, bytes memory ret) = address(t).call(data);
        assertTrue(ok, string.concat(name, ": an instrument refused, ", vm.toString(ret)));
    }

    /// Reaches `k` from OPEN through the real instruments, in this order: the front door's primary, the vault's pause,
    /// its primary, its launch door (for the conversion, the owner's removal, then the guardian's of the Removed door).
    /// After each, `_assertStep`. One order only: no instrument is gated by another's record, so the order changes only
    /// when each clock is stamped, and the way back starts an hour after the last stamp. The 39b liveness campaign
    /// (`GovernanceLiveness`) draws the instruments in other orders.
    function _close(Closure memory k, string memory name) internal {
        bytes memory disable = abi.encodeCall(CascadeBase.disableBridge, (address(c.bridge)));
        bytes memory remove = abi.encodeCall(CascadeVault.removeFrontDoor, (BASE, address(c.fd)));
        Closure memory s;
        _assertRecords(s, string.concat(name, " OPEN"));
        if (k.fdBridge != Actor.None) {
            _actAs(k.fdBridge, c.fd, disable, name);
            s.fdBridge = k.fdBridge;
            _assertStep(s, c.fd, k.fdBridge, name);
        }
        if (k.paused != Actor.None) {
            _actAs(k.paused, c.vault, abi.encodeCall(CascadeBase.pause, ()), name);
            s.paused = k.paused;
            _assertStep(s, c.vault, k.paused, name);
        }
        if (k.bridge != Actor.None) {
            _actAs(k.bridge, c.vault, disable, name);
            s.bridge = k.bridge;
            _assertStep(s, c.vault, k.bridge, name);
        }
        if (k.door == BY_OWNER || k.door == CONVERTED) {
            _actAs(Actor.Owner, c.vault, remove, name);
            s.door = BY_OWNER;
            _assertStep(s, c.vault, Actor.Owner, name);
        }
        if (k.door == BY_GUARDIAN || k.door == CONVERTED) {
            _actAs(Actor.Guardian, c.vault, remove, name);
            s.door = k.door;
            _assertStep(s, c.vault, Actor.Guardian, name);
        }
    }

    /// After an instrument by `by` on `t`: its maker's clock there reads now, and the records are `s`'s
    /// (`_assertRecords`).
    function _assertStep(Closure memory s, CascadeBase t, Actor by, string memory name) internal view {
        uint64 clock =
            by == Actor.Owner ? _lensOf[address(t)].lastOwnerClose() : _lensOf[address(t)].lastGuardianClose();
        assertEq(clock, vm.getBlockTimestamp(), string.concat(name, ": the instrument stamps its maker's clock"));
        _assertRecords(s, name);
    }

    /// The four records read `s`'s makers, the launch door's state is its route's, and both chains' holds and gates
    /// are the ones the records make, through both lenses and the targets' internal values alike (`_assertVault` and
    /// `_assertDoor`, whose `_lensParity` compares every view the machine has).
    function _assertRecords(Closure memory s, string memory name) internal view {
        Actor door = _doorActor(s.door);
        assertEq(uint8(c.vaultLens.pausedBy()), uint8(s.paused), string.concat(name, ": pausedBy"));
        assertEq(uint8(c.vaultLens.primaryDisabledBy()), uint8(s.bridge), string.concat(name, ": the vault's primary"));
        assertEq(uint8(c.vaultLens.launchDoorRemovedBy()), uint8(door), string.concat(name, ": launchDoorRemovedBy"));
        assertEq(uint8(c.doorLens.primaryDisabledBy()), uint8(s.fdBridge), string.concat(name, ": Base's primary"));
        DoorState state = s.door == KEPT ? DoorState.Active : s.door == BY_OWNER ? DoorState.Removed : DoorState.Unknown;
        assertEq(uint8(_doorState(address(c.fd))), uint8(state), string.concat(name, ": the launch door's state"));
        _assertVault(
            s.paused == Actor.Owner || s.bridge == Actor.Owner || door == Actor.Owner,
            s.paused == Actor.Guardian || s.bridge == Actor.Guardian || door == Actor.Guardian,
            name
        );
        _assertDoor(s.fdBridge == Actor.Owner, s.fdBridge == Actor.Guardian, name);
    }

    /// Each record holds one actor: every second instrument on a held record is refused, by either actor (a second
    /// pause EnforcedPause, a second disable BridgeNotEnabled, a removal of the door already removed PeerNotActive),
    /// except the guardian's removal of the door the owner removed, which makes the record the guardian's (the
    /// CONVERTED route). So the records make exactly 3^4 states, and the owner never makes a guardian's door record
    /// its own (it cannot remove an unknown door).
    function _assertOneActorARecord(Closure memory k, string memory name) internal {
        bytes memory disable = abi.encodeCall(CascadeBase.disableBridge, (address(c.bridge)));
        bytes memory remove = abi.encodeCall(CascadeVault.removeFrontDoor, (BASE, address(c.fd)));
        address[2] memory both = [owner, guardian];
        for (uint256 i; i < 2; ++i) {
            address who = both[i];
            if (k.paused != Actor.None) {
                _refuses(
                    who,
                    address(c.vault),
                    abi.encodeCall(CascadeBase.pause, ()),
                    _err(_paused()),
                    string.concat(name, ": a second pause")
                );
            }
            if (k.bridge != Actor.None) {
                _refuses(
                    who,
                    address(c.vault),
                    disable,
                    _err(BridgeNotEnabled.selector),
                    string.concat(name, ": a second disable")
                );
            }
            if (k.fdBridge != Actor.None) {
                _refuses(who, address(c.fd), disable, _err(BridgeNotEnabled.selector), string.concat(name, ": on Base"));
            }
            if (k.door >= BY_GUARDIAN || (k.door == BY_OWNER && who == owner)) {
                _refuses(
                    who, address(c.vault), remove, _err(PeerNotActive.selector), string.concat(name, ": a removal")
                );
            }
        }
    }

    /// The owner's way back from `k`, alone. No other bridge is enabled in this world, so `setPrimaryBridge` (a switch
    /// to an enabled bridge) is never open, and each primary comes back by its Reopen:
    ///   - at once: the owner's unpause, whoever paused (it stamps nothing);
    ///   - with it, the Reopens (no gate, only no owner stamp since they were scheduled): each disabled primary's, on
    ///     its chain, and the launch door's when the owner removed it (Removed, so its activation is a Reopen);
    ///   - over a guardian's door record (the door unknown): the swap to the sitting guardian, which clears it, then the
    ///     door's activation, Ordinary, scheduled once the vault reads OPEN. The swap is a GuardianSwap, refused while
    ///     the owner's own hold lasts, so it is scheduled after the primary's Reopen when the owner disabled the vault's
    ///     primary.
    /// Each item runs at its readyAt, in time and in blocks (`_executeAtReady`). The script is recorded
    /// (`_assertOwnerAlone`); the probes at OPEN, which other accounts make, are not. Returns, from the owner's first
    /// call, when both chains first read OPEN and when the last item ran.
    function _wayBack(Closure memory k, string memory name) internal returns (uint64 open, uint64 done) {
        CascadeVault v = c.vault;
        CascadeFrontDoor fd = c.fd;
        bytes memory primary = _activateBridge(address(c.bridge));
        bytes memory door = _activateDoor(BASE, address(fd));
        bytes memory swap = _swap(guardian);
        bool guardianDoor = k.door >= BY_GUARDIAN;
        bool swapLater = guardianDoor && k.bridge == Actor.Owner;
        bool any = k.paused != Actor.None || k.bridge != Actor.None || k.door != KEPT || k.fdBridge != Actor.None;
        uint64 t0 = uint64(vm.getBlockTimestamp());
        open = NEVER;
        vm.startStateDiffRecording();
        // at once
        if (k.paused != Actor.None) {
            vm.prank(owner);
            v.unpause();
        }
        if (k.fdBridge != Actor.None) _schedKind(fd, primary, Kind.Reopen, name);
        if (k.bridge != Actor.None) _schedKind(v, primary, Kind.Reopen, name);
        if (k.door == BY_OWNER) _schedKind(v, door, Kind.Reopen, name);
        if (swapLater) {
            _schedRefused(
                v, swap, _err(ExitsNotOpen.selector), string.concat(name, ": the swap waits out the owner's hold")
            );
        } else if (guardianDoor) {
            _schedKind(v, swap, Kind.GuardianSwap, name);
        }
        open = _openSince(t0, open);
        // day 7: the Reopens
        if (k.fdBridge != Actor.None) _runDue(fd, primary);
        if (k.bridge != Actor.None) _runDue(v, primary);
        if (k.door == BY_OWNER) _runDue(v, door);
        open = _openSince(t0, open);
        if (guardianDoor) {
            // the swap (day 8, or day 15 after the owner's own hold), then the door's Ordinary activation
            if (swapLater) _schedKind(v, swap, Kind.GuardianSwap, name);
            _runDue(v, swap);
            open = _openSince(t0, open);
            _schedKind(v, door, Kind.Ordinary, name);
            _assertOwnerAlone(vm.stopAndReturnStateDiff(), true, name);
            // OPEN with no launch door: direct exits only (spec §3.6), until the door's activation
            assertEq(uint8(c.vaultLens.launchDoorRemovedBy()), uint8(Actor.None), string.concat(name, ": cleared"));
            assertEq(uint8(_doorState(address(fd))), uint8(DoorState.Unknown), string.concat(name, ": no door yet"));
            _assertVault(false, false, string.concat(name, " at OPEN"));
            _assertDoor(false, false, string.concat(name, " at OPEN"));
            _assertDirectWorks(string.concat(name, " at OPEN, no door yet"));
            _assertDoorRefused(UnknownPeer.selector, string.concat(name, " at OPEN, no door yet"));
            vm.startStateDiffRecording();
            _runDue(v, door);
        }
        done = uint64(vm.getBlockTimestamp()) - t0;
        _assertOwnerAlone(vm.stopAndReturnStateDiff(), any, name);
    }

    /// The owner schedules `data` on `t`, an item of `kind`.
    function _schedKind(CascadeBase t, bytes memory data, Kind kind, string memory name) internal {
        _sched(t, data);
        assertEq(uint8(_kind(t, data)), uint8(kind), string.concat(name, ": the item's kind"));
    }

    /// Runs the item `data` on `t` at its readyAt: measured (`_executeAtReady`) when that is still ahead, else in this
    /// second, which must be its readyAt (an item due with one run just before it).
    function _runDue(CascadeBase t, bytes memory data) internal {
        Item memory it = _lensOf[address(t)].scheduled(keccak256(data));
        require(it.readyAt != 0, "_runDue: nothing scheduled");
        if (vm.getBlockTimestamp() < it.readyAt) {
            _executeAtReady(t, data);
            return;
        }
        assertEq(it.readyAt, vm.getBlockTimestamp(), "due in this second");
        assertGe(vm.getBlockNumber(), it.readyBlock, "and in blocks");
        _executeNow(t, data);
        assertFalse(_pending(t, data), "executed: the item is gone");
    }

    /// `open` if already set; else the time since `t0` if both chains read OPEN now.
    function _openSince(uint64 t0, uint64 open) internal view returns (uint64) {
        if (open != NEVER || !c.vaultLens.exitsOpen() || !c.doorLens.exitsOpen()) return open;
        return uint64(vm.getBlockTimestamp()) - t0;
    }

    /// In a recording of the owner's script: nothing created (no redeploy); no call by the guardian; every call into
    /// either contract the owner's or the contract's own (`execute` calls itself); and, when `owned`, at least one of
    /// the owner's seen (the recording sees pranked calls).
    function _assertOwnerAlone(VmSafe.AccountAccess[] memory acc, bool owned, string memory name) internal view {
        bool seen;
        for (uint256 i; i < acc.length; ++i) {
            VmSafe.AccountAccess memory a = acc[i];
            assertTrue(a.kind != VmSafe.AccountAccessKind.Create, string.concat(name, ": nothing created, no redeploy"));
            assertTrue(a.accessor != guardian, string.concat(name, ": no guardian call"));
            if (a.kind != VmSafe.AccountAccessKind.Call) continue;
            if (a.account != address(c.vault) && a.account != address(c.fd)) continue;
            assertTrue(a.accessor == owner || a.accessor == a.account, string.concat(name, ": only the owner calls"));
            if (a.accessor == owner) seen = true;
        }
        if (owned) assertTrue(seen, string.concat(name, ": the recording saw the owner's calls"));
    }

    /// The sweep's own control: the recording sees a guardian's call and a creation (in a snapshot).
    function _recorderControl() internal {
        uint256 snap = vm.snapshotState();
        vm.startStateDiffRecording();
        vm.prank(guardian);
        c.vault.pause();
        new ExitsKeeper();
        VmSafe.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        vm.revertToState(snap);
        bool guardianSeen;
        bool created;
        for (uint256 i; i < acc.length; ++i) {
            if (acc[i].accessor == guardian && acc[i].account == address(c.vault)) guardianSeen = true;
            if (acc[i].kind == VmSafe.AccountAccessKind.Create) created = true;
        }
        assertTrue(guardianSeen, "the recording sees a guardian's call");
        assertTrue(created, "and a creation");
    }

    /// Back at OPEN from `k`: the times are the contracts' delays (see `test_TR_doorKept`); every record clear, the door
    /// active and both chains OPEN, the lenses reading the targets; the same contracts, owner, guardian, primary rail on
    /// both chains and launch door; and every exit works (a direct one, and a door exit end to end). "The same
    /// contracts" is checked by code hash: `c.vault` and `c.fd` are the fixture's fixed handles, so the same address
    /// still holding the same code is the same contract (and the recording shows nothing created).
    function _assertBack(Closure memory k, uint64 open, uint64 done, bytes32[2] memory code, string memory name)
        internal
    {
        bool guardianDoor = k.door >= BY_GUARDIAN;
        uint64 vaultOpen = guardianDoor
            ? (k.bridge == Actor.Owner ? REGISTRY + GUARDIAN : GUARDIAN)
            : (k.bridge != Actor.None || k.door == BY_OWNER ? REGISTRY : 0);
        uint64 doorOpen = k.fdBridge != Actor.None ? REGISTRY : 0;
        uint64 bothOpen = vaultOpen > doorOpen ? vaultOpen : doorOpen;
        uint64 last = guardianDoor ? (vaultOpen + REGISTRY > doorOpen ? vaultOpen + REGISTRY : doorOpen) : bothOpen;
        assertEq(open, bothOpen, string.concat(name, ": OPEN on both chains when the delays say"));
        assertEq(done, last, string.concat(name, ": the last item when the delays say"));
        _assertRecords(Closure(Actor.None, Actor.None, KEPT, Actor.None), string.concat(name, " back"));
        assertEq(address(c.vault).codehash, code[0], string.concat(name, ": the same vault"));
        assertEq(address(c.fd).codehash, code[1], string.concat(name, ": the same front door"));
        assertEq(c.vault.owner(), owner, string.concat(name, ": the same owner"));
        assertEq(c.fd.owner(), owner, string.concat(name, ": on both"));
        assertEq(c.vaultLens.guardian(), guardian, string.concat(name, ": the same guardian"));
        assertEq(c.doorLens.guardian(), guardian, string.concat(name, ": on both"));
        assertEq(c.vaultLens.primaryBridge(), address(c.bridge), string.concat(name, ": the same rail"));
        assertEq(c.doorLens.primaryBridge(), address(c.bridge), string.concat(name, ": on both"));
        assertTrue(_bridgeUp(c.vault, address(c.bridge)), string.concat(name, ": enabled"));
        assertTrue(_bridgeUp(c.fd, address(c.bridge)), string.concat(name, ": on both"));
        assertEq(c.vaultLens.activeDoors(BASE), 1, string.concat(name, ": the launch door, the one active"));
        _assertDirectWorks(name);
        _assertDoorWorks(name);
    }
}
