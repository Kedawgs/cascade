// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CascadeBase} from "../../src/CascadeBase.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeStaker} from "../../src/CascadeStaker.sol";
import {CascadeBaseLens} from "../../src/lens/CascadeBaseLens.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {CascadeFormulas} from "../../src/libraries/CascadeFormulas.sol";
import {Delay, DoorState, Item, Kind, PayoutBatch} from "../../src/CascadeTypes.sol";
import {MIN_REDEEM_VALUE, RAO} from "../../src/CascadeConstants.sol";
import {ExitsNotOpen, InvalidParameter, NotReady, PayoutDelayed, UnknownPeer} from "../../src/CascadeErrors.sol";
import {
    PayoutBatchQueued,
    PayoutChunkSent,
    Redeemed,
    RedeemDeferred,
    RedeemReversed
} from "../../src/CascadeEvents.sol";
import {MockBridge} from "../mocks/MockBridge.sol";
import {defaultStakerParams} from "../utils/DefaultParams.sol";
import {GovernanceFixture} from "./GovernanceFixture.sol";
import {Schedule} from "./Schedule.sol";
import {Stamps} from "./StampVector.sol";

/// The keeper's stand-in at the campaign's Handler slot (CampaignFixture's plan names the keeper of both contracts
/// there before anything is deployed): no code that runs, pranked as the keeper.
contract ExitsKeeper {}

/// The exits machine's scenario world (Task 40; spec §3.6's table): GovernanceFixture's two chains with holders in
/// them, and the probes and clocks a cell's outcome and bound are read with.
///   - holders: twenty Base holders of 50 TAO each, in through the launch door (redeem origin BASE), and dave, a
///     direct holder of 100 TAO (an EOA on Bittensor); all of it staked and ramped into the outflow allowance's base
///     (1,100 TAO), so the exits draw on stake;
///   - the delays are read from the contracts (VaultInternals' and DoorInternals' exposed constants), pinned once to
///     the table's figures in the setUp, and every bound is measured with them, in time and in blocks
///     (`_executeAtReady`);
///   - every probe of what users can do runs in a snapshot and is reverted, so a cell's state moves only by its own
///     script: a direct exit (`_directExit`), a door exit end to end (`_doorExit`: the request on Base, the close,
///     the delivery to the vault, the payout after its delay, the credit on Base), a queued batch's payout
///     (`_payoutErr`) and a rogue door's forged delivery (`_forgedErr`);
///   - `_lensParity` compares both lenses with the targets' internal values (T34a's carry: the views the core
///     campaign saw only at zero), over every item a cell scheduled.
///   - the copied seed (`_copySeed`, the CO column): Task 39b's sweeper on, the founder acting only through its
///     12-hour stack, relayed by the stranger as each asOf passes (`_coWait`), and a fresh staker; the thief's items
///     under the stack (`_thiefUnderTheStack`), each tried at its readyAt.
abstract contract ExitsFixture is GovernanceFixture {
    /// What one door close did: the delivery filed as failed (with the vault's revert data) or delivered (its queued
    /// payout batch, the list the keeper rebuilds from the Redeemed events, what it burned, how many redeems it
    /// deferred), and whether a redeem was burned after one was deferred (the allowance is first come).
    struct Delivery {
        bool failed;
        bytes reason;
        bytes32 key;
        CascadeMessages.Payout[] list;
        uint256 burned;
        uint256 deferred;
        bool burnedAfterDeferred;
    }

    /// A door exit's outcome, step by step: 0 where the step worked, else the selector it reverted with (the
    /// delivery's: the vault's revert data the bridge filed; NOT_QUEUED when the vault took the batch but burned
    /// nothing), and what the exit credited the holder on Base.
    struct DoorExit {
        bytes4 delivery;
        bytes4 payout;
        uint256 credited;
        bytes4 request;
    }

    bytes4 internal constant NOT_QUEUED = bytes4(keccak256("the delivery queued no payout"));

    uint256 internal constant HOLDERS = 20;
    uint256 internal constant HOLDING = 50e18;
    uint256 internal constant DIRECT = 100e18;

    Campaign internal c;
    Governance internal g;
    ExitsKeeper internal keeperC;
    address[] internal holders;
    address internal dave = makeAddr("dave, a direct holder");
    address internal closer = makeAddr("closer");
    address internal rogue = makeAddr("rogue door");

    // the delays as the contracts hold them (the setUp pins them to the table's)
    uint64 internal PARAM;
    uint64 internal REGISTRY;
    uint64 internal GUARDIAN;
    uint64 internal WINDOW;

    /// The block each item was scheduled in, by target and id, and every id each target scheduled (for the lenses).
    mapping(address target => mapping(bytes32 id => uint256)) internal _schedBlock;
    mapping(address target => bytes32[]) internal _ids;
    uint64 private _forgedBatch = 1_000_000;

    function _setUpExits() internal {
        startGovernance();
        c = deployCampaign();
        keeperC = new ExitsKeeper();
        landed(Slot.Handler, address(keeperC));
        g = deployGovernance(c);

        // the scheduler's delays and block times, read from both contracts: the table's (spec §3.6)
        PARAM = c.vault.exposed_PARAM_DELAY();
        REGISTRY = c.vault.exposed_REGISTRY_DELAY();
        GUARDIAN = c.vault.exposed_GUARDIAN_DELAY();
        WINDOW = c.vault.exposed_EXECUTE_WINDOW();
        assertEq(PARAM, 48 hours, "the Param class: 48 hours");
        assertEq(REGISTRY, 7 days, "the Registry class: 7 days");
        assertEq(GUARDIAN, 8 days, "the Guardian class: 8 days");
        assertEq(WINDOW, 7 days, "the execute window: 7 days");
        assertEq(c.fd.exposed_PARAM_DELAY(), PARAM, "the front door's Param class");
        assertEq(c.fd.exposed_REGISTRY_DELAY(), REGISTRY, "the front door's Registry class");
        assertEq(c.fd.exposed_GUARDIAN_DELAY(), GUARDIAN, "the front door's Guardian class");
        assertEq(c.vault.MS_PER_BLOCK(), 7_200, "Bittensor's calibrated block time, twice as fast as its 12 s");
        assertEq(c.fd.MS_PER_BLOCK(), 120, "Base's calibrated block time, twice as fast as its 0.2 s");

        // the Base holders, through the launch door in one batch
        for (uint256 i; i < HOLDERS; ++i) {
            address h = makeAddr(string.concat("holder ", vm.toString(i)));
            holders.push(h);
            c.tao.mint(h, HOLDING);
            vm.prank(h);
            c.tao.approve(address(c.fd), type(uint256).max);
            vm.prank(h);
            c.fd.deposit(HOLDING);
        }
        vm.deal(closer, 10_000 ether);
        Delivery memory d = _closeDoor();
        assertFalse(d.failed, "the holders' deposits are delivered");
        // dave, on Bittensor
        vm.deal(dave, DIRECT);
        vm.prank(dave);
        c.vault.depositDirect{value: DIRECT}();
        // all of it staked, and ramped into the allowance's base
        vm.prank(address(keeperC));
        c.vault.stakeIdle();
        Schedule.wait(1 days);
        assertEq(_base(), HOLDERS * HOLDING + DIRECT, "the allowance's base: every holder's TAO, staked");
        for (uint256 i; i < HOLDERS; ++i) {
            assertEq(c.vaultLens.redeemOrigin(holders[i]), BASE, "a launch-door holder");
        }
        assertTrue(c.vaultLens.exitsOpen(), "OPEN at the start");
    }

    // ---- calls ----

    function _err(bytes4 selector) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(selector);
    }

    function _notOwner(address caller) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller);
    }

    /// `caller` calls `target` with `data`, which must revert with exactly `want`.
    function _refuses(address caller, address target, bytes memory data, bytes memory want, string memory why)
        internal
    {
        vm.prank(caller);
        (bool ok, bytes memory ret) = target.call(data);
        assertFalse(ok, why);
        assertEq(ret, want, why);
    }

    // ---- the scheduler ----

    function _transfer(address to) internal pure returns (bytes memory) {
        return abi.encodeCall(CascadeBase.transferOwnership, (to));
    }

    function _swap(address to) internal pure returns (bytes memory) {
        return abi.encodeCall(CascadeBase.setGuardian, (to));
    }

    function _activateDoor(uint64 chain, address door) internal pure returns (bytes memory) {
        return abi.encodeCall(CascadeVault.activateFrontDoor, (chain, door));
    }

    function _activateBridge(address bridge) internal pure returns (bytes memory) {
        return abi.encodeCall(CascadeBase.activateBridge, (bridge));
    }

    /// The owner of `t` schedules `data`; the block is kept for `_executeAtReady`.
    function _sched(CascadeBase t, bytes memory data) internal returns (bytes32 id) {
        id = keccak256(data);
        _schedBlock[address(t)][id] = vm.getBlockNumber();
        _ids[address(t)].push(id);
        vm.prank(t.owner());
        assertEq(t.schedule(data), id, "the item's id");
        assertEq(_lensOf[address(t)].scheduled(id).scheduledAt, vm.getBlockTimestamp(), "scheduled now");
    }

    /// The owner of `t` schedules `data`, refused with `err`.
    function _schedRefused(CascadeBase t, bytes memory data, bytes memory err, string memory why) internal {
        _refuses(t.owner(), address(t), abi.encodeCall(CascadeBase.schedule, (data)), err, why);
    }

    /// The owner of `t` executes `data`, refused with `err` (the item, if any, stays).
    function _execRefused(CascadeBase t, bytes memory data, bytes memory err, string memory why) internal {
        _refuses(t.owner(), address(t), abi.encodeCall(CascadeBase.execute, (data)), err, why);
    }

    function _kind(CascadeBase t, bytes memory data) internal view returns (Kind) {
        return _lensOf[address(t)].scheduled(keccak256(data)).kind;
    }

    function _pending(CascadeBase t, bytes memory data) internal view returns (bool) {
        return _lensOf[address(t)].scheduled(keccak256(data)).readyAt != 0;
    }

    /// The delay of `cls` on `t`, as the contract holds it.
    function _classDelay(CascadeBase t, Delay cls) internal view returns (uint64) {
        bool vault = address(t) == address(c.vault);
        if (cls == Delay.Param) return vault ? c.vault.exposed_PARAM_DELAY() : c.fd.exposed_PARAM_DELAY();
        if (cls == Delay.Registry) return vault ? c.vault.exposed_REGISTRY_DELAY() : c.fd.exposed_REGISTRY_DELAY();
        return vault ? c.vault.exposed_GUARDIAN_DELAY() : c.fd.exposed_GUARDIAN_DELAY();
    }

    /// Executes the item `data` on `t` at its bound, measured (`_toReady`), and returns the time it ran. The caller
    /// is still before readyAt.
    function _executeAtReady(CascadeBase t, bytes memory data) internal returns (uint64 when) {
        when = _toReady(t, data);
        vm.prank(t.owner());
        t.execute(data);
        assertFalse(_pending(t, data), "executed: the item is gone");
    }

    /// Brings the item `data` on `t` to its bound, measured, without executing it (a caller that acts first in that
    /// second executes it after): its readyAt is its scheduling time plus its class's delay as the contract holds
    /// it, and its readyBlock its scheduling block plus half that delay in `t`'s blocks (ceil(delay * 1000 / (2 *
    /// MS_PER_BLOCK))); one second before readyAt, and at readyAt one block before readyBlock (a halt, in a
    /// snapshot), the execute is refused NotReady; the clock is left at readyAt, which it returns. The caller is
    /// still before readyAt.
    function _toReady(CascadeBase t, bytes memory data) internal returns (uint64) {
        bytes32 id = keccak256(data);
        Item memory it = _lensOf[address(t)].scheduled(id);
        require(it.readyAt != 0, "_toReady: nothing scheduled");
        require(vm.getBlockTimestamp() < it.readyAt, "_toReady: already past readyAt");
        uint64 delay = _classDelay(t, it.class);
        assertEq(it.readyAt - it.scheduledAt, delay, "ready after its class delay, in time");
        uint64 twoBlocks = 2 * t.MS_PER_BLOCK();
        assertEq(
            it.readyBlock,
            _schedBlock[address(t)][id] + (delay * 1000 + twoBlocks - 1) / twoBlocks,
            "and half of it in blocks"
        );
        Schedule.warpTo(it.readyAt - 1);
        assertGe(vm.getBlockNumber(), it.readyBlock, "the blocks are not what holds it here");
        _execRefused(t, data, _err(NotReady.selector), "one second before its delay: not ready");
        uint256 snap = vm.snapshotState();
        vm.warp(it.readyAt);
        vm.roll(it.readyBlock - 1);
        _execRefused(t, data, _err(NotReady.selector), "at its delay but a block short of half of it: not ready");
        vm.revertToState(snap);
        Schedule.warpTo(it.readyAt);
        return it.readyAt;
    }

    /// The owner executes the ready item `data` on `t` now.
    function _executeNow(CascadeBase t, bytes memory data) internal {
        vm.prank(t.owner());
        t.execute(data);
    }

    /// The owner's signed stamp on `t` as of `asOf`, signed with `key` and relayed by the stranger.
    function _stampWith(CascadeBase t, uint256 key, uint64 asOf) internal returns (bool ok, bytes memory ret) {
        bytes memory sig = Stamps.signed(key, address(t), asOf);
        vm.prank(stranger);
        (ok, ret) = address(t).call(abi.encodeCall(CascadeBase.stampBySig, (asOf, sig)));
    }

    // ---- the machine's state ----

    /// The vault's holds and gate, through its lens and its internal values alike.
    function _assertVault(bool ownerHold_, bool guardianHold_, string memory why) internal view {
        assertEq(c.vaultLens.ownerHold(), ownerHold_, string.concat(why, ": the owner's hold"));
        assertEq(c.vaultLens.guardianHold(), guardianHold_, string.concat(why, ": the guardian's hold"));
        assertEq(c.vaultLens.exitsOpen(), !ownerHold_ && !guardianHold_, string.concat(why, ": exitsOpen"));
        _lensParity();
    }

    /// Both lenses read what the targets hold (T34a's carry): the clocks, the holds and their records, the
    /// pending owner's time, the guardian, the bridges and doors this world names, and every item scheduled.
    function _lensParity() internal view {
        CascadeBaseLens vl = c.vaultLens;
        assertEq(vl.lastOwnerClose(), c.vault.exposed_lastOwnerClose(), "vault lens: lastOwnerClose");
        assertEq(vl.lastGuardianClose(), c.vault.exposed_lastGuardianClose(), "vault lens: lastGuardianClose");
        assertEq(
            uint8(vl.primaryDisabledBy()), uint8(c.vault.exposed_primaryDisabledBy()), "vault lens: primaryDisabledBy"
        );
        assertEq(vl.pendingSince(), c.vault.exposed_pendingSince(), "vault lens: pendingSince");
        assertEq(uint8(c.vaultLens.pausedBy()), uint8(c.vault.exposed_pausedBy()), "vault lens: pausedBy");
        assertEq(
            uint8(c.vaultLens.launchDoorRemovedBy()),
            uint8(c.vault.exposed_launchDoorRemovedBy()),
            "vault lens: launchDoorRemovedBy"
        );
        assertEq(vl.ownerHold(), c.vault.exposed_ownerHold(), "vault lens: ownerHold");
        assertEq(vl.guardianHold(), c.vault.exposed_guardianHold(), "vault lens: guardianHold");
        assertEq(vl.exitsOpen(), c.vault.exposed_exitsOpen(), "vault lens: exitsOpen");
        assertEq(vl.guardian(), c.vault.exposed_guardian(), "vault lens: guardian");
        assertEq(vl.primaryBridge(), c.vault.exposed_primaryBridge(), "vault lens: primaryBridge");
        address[2] memory bridges = [address(c.bridge), address(g.bridge2)];
        for (uint256 i; i < 2; ++i) {
            assertEq(vl.bridgeEnabled(bridges[i]), c.vault.exposed_bridgeEnabled(bridges[i]), "vault lens: enabled");
            assertEq(vl.bridgeKnown(bridges[i]), c.vault.exposed_bridgeKnown(bridges[i]), "vault lens: known");
            assertEq(c.doorLens.bridgeEnabled(bridges[i]), c.fd.exposed_bridgeEnabled(bridges[i]), "door lens: on");
            assertEq(c.doorLens.bridgeKnown(bridges[i]), c.fd.exposed_bridgeKnown(bridges[i]), "door lens: known");
        }
        address[3] memory doors = [address(c.fd), g.door3, rogue];
        for (uint256 i; i < 3; ++i) {
            bytes32 peer = c.vaultLens.peerId(BASE, doors[i]);
            assertEq(uint8(c.vaultLens.doorState(peer)), uint8(c.vault.exposed_doorState(peer)), "vault lens: door");
        }
        assertEq(c.vaultLens.activeDoors(BASE), c.vault.exposed_activeDoors(BASE), "vault lens: activeDoors");
        _itemsParity(c.vault);
        CascadeBaseLens dl = c.doorLens;
        assertEq(dl.lastOwnerClose(), c.fd.exposed_lastOwnerClose(), "door lens: lastOwnerClose");
        assertEq(dl.lastGuardianClose(), c.fd.exposed_lastGuardianClose(), "door lens: lastGuardianClose");
        assertEq(uint8(dl.primaryDisabledBy()), uint8(c.fd.exposed_primaryDisabledBy()), "door lens: disabledBy");
        assertEq(dl.pendingSince(), c.fd.exposed_pendingSince(), "door lens: pendingSince");
        assertEq(dl.ownerHold(), c.fd.exposed_ownerHold(), "door lens: ownerHold");
        assertEq(dl.guardianHold(), c.fd.exposed_guardianHold(), "door lens: guardianHold");
        assertEq(dl.exitsOpen(), c.fd.exposed_exitsOpen(), "door lens: exitsOpen");
        assertEq(dl.primaryBridge(), c.fd.exposed_primaryBridge(), "door lens: primaryBridge");
        _itemsParity(c.fd);
    }

    function _itemsParity(CascadeBase t) private view {
        bytes32[] storage ids = _ids[address(t)];
        for (uint256 i; i < ids.length; ++i) {
            Item memory a = _lensOf[address(t)].scheduled(ids[i]);
            Item memory b =
                address(t) == address(c.vault) ? c.vault.exposed_scheduled(ids[i]) : c.fd.exposed_scheduled(ids[i]);
            assertEq(a.scheduledAt, b.scheduledAt, "lens: an item's scheduledAt");
            assertEq(a.readyAt, b.readyAt, "lens: an item's readyAt");
            assertEq(uint8(a.class), uint8(b.class), "lens: an item's class");
            assertEq(uint8(a.kind), uint8(b.kind), "lens: an item's kind");
            assertEq(a.selector, b.selector, "lens: an item's selector");
            assertEq(a.readyBlock, b.readyBlock, "lens: an item's readyBlock");
        }
    }

    // ---- what users can do ----

    /// The allowance's base the vault reads at a delivery (spec §3.4, I-5): the priced stake, min(visible,
    /// booked), in wei, less what still ramps in over the day from the last stake.
    function _base() internal view returns (uint256) {
        uint256 priced = Math.min(c.vaultLens.visibleStakeRao(), c.vaultLens.bookedStake()) * RAO;
        return CascadeFormulas.sub0(
            priced, CascadeFormulas.unspent(c.vaultLens.rampingStake(), c.vaultLens.lastStakeAt(), 1 days)
        );
    }

    /// What `who`'s shares are worth now.
    function _valueOf(address who) internal view returns (uint256) {
        return c.vault.balanceOf(who) * c.vaultLens.totalAssets() / c.vault.totalSupply();
    }

    /// `who` redeems `shares` directly on Bittensor, in a snapshot: 0 and what it was paid, or the revert's selector.
    function _directExit(address who, uint256 shares) internal returns (bytes4 err, uint256 paid) {
        uint256 snap = vm.snapshotState();
        uint256 before = who.balance;
        vm.prank(who);
        try c.vault.redeemDirect(shares, false) {
            paid = who.balance - before;
        } catch (bytes memory r) {
            err = bytes4(r);
        }
        vm.revertToState(snap);
    }

    /// A direct exit of a tenth of dave's shares works now.
    function _assertDirectWorks(string memory why) internal {
        (bytes4 err, uint256 paid) = _directExit(dave, c.vault.balanceOf(dave) / 10);
        assertEq(err, bytes4(0), string.concat(why, ": a direct exit works"));
        assertGt(paid, 0, string.concat(why, ": and pays"));
    }

    function _assertDirectRefused(bytes4 want, string memory why) internal {
        (bytes4 err,) = _directExit(dave, c.vault.balanceOf(dave) / 10);
        assertEq(err, want, string.concat(why, ": a direct exit is refused"));
    }

    /// Closes the launch door's open batch (`_closeDoor(door)`).
    function _closeDoor() internal returns (Delivery memory d) {
        return _closeDoor(c.fd);
    }

    /// Closes `door`'s open batch (waiting out its interval if it cannot close yet), the closer paying the bridge
    /// fee; the mock rail delivers to the vault within the call. What the delivery did, from the logs.
    function _closeDoor(CascadeFrontDoor door) internal returns (Delivery memory d) {
        (uint64 id, uint64 start,,,,) = door.openBatch();
        if (!door.canClose()) Schedule.warpTo(uint256(start) + door.batchInterval());
        vm.recordLogs();
        vm.prank(closer);
        door.closeBatch{value: FEE}(id, 0);
        d = _delivery(vm.getRecordedLogs());
    }

    /// The bridge retries its oldest failed delivery; what it did.
    function _retry(MockBridge bridge) internal returns (Delivery memory d) {
        vm.recordLogs();
        bridge.retryNext();
        d = _delivery(vm.getRecordedLogs());
    }

    function _delivery(Vm.Log[] memory logs) internal view returns (Delivery memory d) {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (_isVault(logs[i], Redeemed.selector)) ++n;
        }
        d.list = new CascadeMessages.Payout[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.topics.length != 0 && l.topics[0] == MockBridge.DeliveryFailed.selector) {
                d.failed = true;
                (, d.reason) = abi.decode(l.data, (uint256, bytes));
            } else if (_isVault(l, PayoutBatchQueued.selector)) {
                d.key = l.topics[1];
            } else if (_isVault(l, Redeemed.selector)) {
                (uint256 shares, uint256 assets) = abi.decode(l.data, (uint256, uint256));
                d.list[n++] = CascadeMessages.Payout(address(uint160(uint256(l.topics[2]))), shares, assets);
                d.burned += assets;
                if (d.deferred != 0) d.burnedAfterDeferred = true;
            } else if (_isVault(l, RedeemDeferred.selector)) {
                ++d.deferred;
            }
        }
    }

    function _isVault(Vm.Log memory l, bytes32 sig) private view returns (bool) {
        return l.emitter == address(c.vault) && l.topics.length > 1 && l.topics[0] == sig;
    }

    /// `who` asks the launch door to redeem `shares` (`_request(door, ...)`).
    function _request(address who, uint256 shares) internal {
        _request(c.fd, who, shares);
    }

    /// `who` asks `door` to redeem `shares`, paying the request fee (none when it adds to its request already in the
    /// open batch: the front door's fee rule).
    function _request(CascadeFrontDoor door, address who, uint256 shares) internal {
        uint256 fee = door.redeemOf(who) == 0 ? door.redeemRequestFee() : 0;
        vm.deal(who, who.balance + fee);
        vm.prank(who);
        door.requestRedeem{value: fee}(shares);
    }

    /// The payout of the queued batch `key`, by anyone, now; what it sent, from the vault's logs: the gross of each
    /// chunk sent (PayoutChunkSent), the value of the holders' claims that left the vault.
    function _payout(bytes32 key, CascadeMessages.Payout[] memory list) internal returns (uint256 sent) {
        vm.recordLogs();
        vm.prank(closer);
        c.vault.processPayouts(key, list, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (_isVault(logs[i], PayoutChunkSent.selector)) {
                (,, uint256 gross,,,,) =
                    abi.decode(logs[i].data, (uint32, uint32, uint256, uint256, uint256, uint256, uint256));
                sent += gross;
            }
        }
    }

    /// The payout of the queued batch `key` once due, in a snapshot: 0, or the revert's selector.
    function _payoutErr(bytes32 key, CascadeMessages.Payout[] memory list) internal returns (bytes4 err) {
        uint256 snap = vm.snapshotState();
        uint256 due = uint256(c.vaultLens.getPayoutBatch(key).queuedAt) + c.vaultLens.payoutDelay();
        if (vm.getBlockTimestamp() < due) Schedule.warpTo(due);
        vm.prank(closer);
        try c.vault.processPayouts(key, list, 0) {}
        catch (bytes memory r) {
            err = bytes4(r);
        }
        vm.revertToState(snap);
    }

    /// A holder's exit through `door`, end to end, in a snapshot: the request on Base and the close (both work
    /// whatever the vault's state: Base-side, row 4's), the delivery to the vault, the payout after its delay, the
    /// credit on Base.
    function _doorExit(CascadeFrontDoor door, address who, uint256 shares) internal returns (DoorExit memory e) {
        uint256 snap = vm.snapshotState();
        // the request on Base, wrapped so that a refusal names its step (Task 41a's review, Minor 5)
        uint256 fee = door.redeemOf(who) == 0 ? door.redeemRequestFee() : 0;
        vm.deal(who, who.balance + fee);
        vm.prank(who);
        try door.requestRedeem{value: fee}(shares) {}
        catch (bytes memory r) {
            e.request = bytes4(r);
            vm.revertToState(snap);
            return e;
        }
        Delivery memory d = _closeDoor(door);
        if (d.failed) {
            e.delivery = bytes4(d.reason);
        } else if (d.key == bytes32(0)) {
            e.delivery = NOT_QUEUED;
        } else {
            Schedule.wait(c.vaultLens.payoutDelay());
            uint256 before = door.claimable(who);
            vm.prank(closer);
            try c.vault.processPayouts(d.key, d.list, 0) {
                e.credited = door.claimable(who) - before;
            } catch (bytes memory r) {
                e.payout = bytes4(r);
            }
        }
        vm.revertToState(snap);
    }

    /// A tenth of the first holder's shares leave through the launch door, end to end, and are credited on Base.
    function _assertDoorWorks(string memory why) internal {
        _assertDoorWorks(c.fd, why);
    }

    function _assertDoorWorks(CascadeFrontDoor door, string memory why) internal {
        DoorExit memory e = _doorExit(door, holders[0], c.vault.balanceOf(holders[0]) / 10);
        assertEq(e.request, bytes4(0), string.concat(why, ": a door exit's request is taken"));
        assertEq(e.delivery, bytes4(0), string.concat(why, ": a door exit is delivered"));
        assertEq(e.payout, bytes4(0), string.concat(why, ": and paid"));
        assertGt(e.credited, 0, string.concat(why, ": and credited on Base"));
    }

    // ---- the Base side (rows 4 and 5, Task 41a) ----

    /// The front door's holds and gate, through its lens, and both lenses' parity (`_lensParity`: the front door's
    /// clocks, `pendingSince`, primary and items among them).
    function _assertDoor(bool ownerHold_, bool guardianHold_, string memory why) internal view {
        assertEq(c.doorLens.ownerHold(), ownerHold_, string.concat(why, ": the front door's owner hold"));
        assertEq(c.doorLens.guardianHold(), guardianHold_, string.concat(why, ": the front door's guardian hold"));
        assertEq(c.doorLens.exitsOpen(), !ownerHold_ && !guardianHold_, string.concat(why, ": the front door OPEN"));
        _lensParity();
    }

    /// A holder's request on Base and the launch door's close, in a snapshot: 0 if the close goes out, else the
    /// selector it reverts with (PrimaryBridgeDisabled while the front door's primary is disabled). The request itself
    /// is always taken: it waits in the open batch.
    function _baseCloseErr() internal returns (bytes4 err) {
        uint256 snap = vm.snapshotState();
        _request(holders[0], c.vault.balanceOf(holders[0]) / 10);
        (uint64 id, uint64 start,,,,) = c.fd.openBatch();
        if (!c.fd.canClose()) Schedule.warpTo(uint256(start) + c.fd.batchInterval());
        vm.prank(closer);
        try c.fd.closeBatch{value: FEE}(id, 0) {}
        catch (bytes memory r) {
            err = bytes4(r);
        }
        vm.revertToState(snap);
    }

    /// The queued batch `queued` is paid once due and credited on Base (to its first entry's holder, less its share of
    /// the bridge fee), in a snapshot: payouts land through any bridge the front door knows.
    function _assertPayoutLands(Delivery memory queued, string memory why) internal {
        uint256 snap = vm.snapshotState();
        uint256 due = uint256(c.vaultLens.getPayoutBatch(queued.key).queuedAt) + c.vaultLens.payoutDelay();
        if (vm.getBlockTimestamp() < due) Schedule.warpTo(due);
        address who = queued.list[0].user;
        uint256 before = c.fd.claimable(who);
        _payout(queued.key, queued.list);
        assertEq(c.fd.claimable(who) - before, queued.burned - FEE, string.concat(why, ": a queued payout lands"));
        vm.revertToState(snap);
    }

    /// A door exit's delivery to the vault is refused with `want` (the request and the close on Base work).
    function _assertDoorRefused(bytes4 want, string memory why) internal {
        DoorExit memory e = _doorExit(c.fd, holders[0], c.vault.balanceOf(holders[0]) / 10);
        assertEq(e.delivery, want, string.concat(why, ": a door exit's delivery is refused"));
    }

    /// A launch-door exit is delivered and burned, and its payout refused with `want`.
    function _assertDoorPayoutRefused(bytes4 want, string memory why) internal {
        DoorExit memory e = _doorExit(c.fd, holders[0], c.vault.balanceOf(holders[0]) / 10);
        assertEq(e.delivery, bytes4(0), string.concat(why, ": a door exit is delivered"));
        assertEq(e.payout, want, string.concat(why, ": its payout is refused"));
    }

    // ---- snapshots of a whole script ----

    /// A point to come back to: the state, with the clock and the block (restored explicitly).
    struct Mark {
        uint256 snap;
        uint256 t;
        uint256 b;
    }

    function _mark() internal returns (Mark memory m) {
        m = Mark(vm.snapshotState(), vm.getBlockTimestamp(), vm.getBlockNumber());
    }

    function _back(Mark memory m) internal {
        vm.revertToState(m.snap);
        vm.warp(m.t);
        vm.roll(m.b);
    }

    /// A rogue door's forged redeem of `victim`'s shares, delivered by the vault's primary bridge from (BASE, door),
    /// in a snapshot: 0 and what it burned, or the revert's selector.
    function _forgedErr(address door, address victim) internal returns (bytes4 err, uint256 burned) {
        uint256 snap = vm.snapshotState();
        Delivery memory d;
        (err, d) = _forge(c.vault.exposed_primaryBridge(), door, victim);
        burned = d.burned;
        vm.revertToState(snap);
    }

    /// The same forged delivery, committed (a compromised rail's), from `bridge`: the revert's selector, or 0 and what
    /// the vault did with it (what it burned and queued).
    function _forge(address bridge, address door, address victim) internal returns (bytes4 err, Delivery memory d) {
        CascadeMessages.Entry[] memory redeems = new CascadeMessages.Entry[](1);
        redeems[0] = CascadeMessages.Entry(victim, c.vault.balanceOf(victim));
        return _forge(bridge, door, redeems);
    }

    /// A forged delivery of the redeems `redeems` from (BASE, door) through `bridge`, committed.
    function _forge(address bridge, address door, CascadeMessages.Entry[] memory redeems)
        internal
        returns (bytes4 err, Delivery memory d)
    {
        bytes memory message = CascadeMessages.encodeBatch(_forgedBatch++, new CascadeMessages.Entry[](0), redeems);
        vm.recordLogs();
        vm.prank(bridge);
        try c.vault.onBridgeMessage(BASE, door, message, 0) {
            d = _delivery(vm.getRecordedLogs());
        } catch (bytes memory r) {
            vm.getRecordedLogs();
            err = bytes4(r);
        }
    }

    // ---- the run at the floor (row 1 SOG, and rows 2 and 3 as row 1) ----

    /// The thief, holding the owner key, tightens every exit limit the run reads to its floor at once (a tightening is
    /// never refused, I-23): both outflow percentages and the daily floor, and the per-entry limit. Each is shown to be
    /// the floor by the contract itself: one past it is refused InvalidParameter.
    function _tightenToTheFloor() internal {
        CascadeVault v = c.vault;
        uint256 message = c.vaultLens.maxMessageValue();
        uint32 chunk = c.vaultLens.minChunk();
        vm.prank(owner);
        v.setOutflowLimits(2_000, 10e18, 2_000);
        bytes memory bad = _err(InvalidParameter.selector);
        _refuses(owner, address(v), abi.encodeCall(v.setOutflowLimits, (1_999, 10e18, 2_000)), bad, "the door's floor");
        _refuses(owner, address(v), abi.encodeCall(v.setOutflowLimits, (2_000, 10e18 - 1, 2_000)), bad, "the floor's");
        _refuses(owner, address(v), abi.encodeCall(v.setOutflowLimits, (2_000, 10e18, 1_999)), bad, "the global floor");
        vm.prank(owner);
        v.setMessageLimits(10e18, message, chunk);
        _refuses(owner, address(v), abi.encodeCall(v.setMessageLimits, (10e18 - 1, message, chunk)), bad, "entry floor");
        assertEq(c.vaultLens.maxDailyOutflowBps(), 2_000, "the door's percentage at its floor");
        assertEq(c.vaultLens.globalOutflowBps(), 2_000, "the global percentage at its floor");
        assertEq(c.vaultLens.minDailyOutflow(), 10e18, "the daily floor at its floor");
        assertEq(c.vaultLens.maxEntryValue(), 10e18, "the entry limit at its floor");
    }

    /// The result of `_runAtTheFloor`: the door's base at the first delivery; what the run burned and paid, measured
    /// and as the vault's own numbers predict; the days on which a redeem was deferred; and the batches still queued
    /// at its end (their keys, lists and values, oldest first).
    struct Run {
        uint256 base0;
        uint256 burned;
        uint256 predicted;
        uint256 paid;
        uint256 predictedPaid;
        uint256 daysDeferred;
        uint256 deliveries;
        uint256 rolls;
        uint256 honestPaid;
        bytes32[] queuedKeys;
        CascadeMessages.Payout[][] queuedLists;
        uint256[] queuedBurned;
        uint256 queued;
    }

    /// How a run is played (`_runAtTheFloor`): the day the thief raises the payout delay (0 for none); whether it rolls
    /// every empty due batch; whether one holder asks again right after each close (the roll's defence); and a thief's
    /// own holder that requests first each day (address(0) for none).
    struct RunPlan {
        uint256 raiseOn;
        bool rollEmpty;
        bool keepOneWaiting;
        address crowder;
    }

    /// `_runAtTheFloor` at the launch's payout delay, untouched.
    function _runAtTheFloor(uint256 t0, uint256 days_, address rogueDoor) internal returns (Run memory r) {
        return _runAtTheFloor(t0, days_, rogueDoor, RunPlan(0, false, false, address(0)));
    }

    /// `_runAtTheFloor` with the payout delay raised on day `raiseOn`.
    function _runAtTheFloor(uint256 t0, uint256 days_, address rogueDoor, uint256 raiseOn)
        internal
        returns (Run memory r)
    {
        return _runAtTheFloor(t0, days_, rogueDoor, RunPlan(raiseOn, false, false, address(0)));
    }

    /// `_runAtTheFloor` with the rolls.
    function _runAtTheFloor(uint256 t0, uint256 days_, address rogueDoor, uint256 raiseOn, bool rollEmpty)
        internal
        returns (Run memory r)
    {
        return _runAtTheFloor(t0, days_, rogueDoor, RunPlan(raiseOn, rollEmpty, false, address(0)));
    }

    /// A bank run through the launch door from `t0`, a day at a time for `days_` days: each day every queued batch now
    /// due goes out first, oldest first (so the base falls by what left: the users' worst case), then every Base
    /// holder asks to redeem all its shares (every holder with more than dust), in the same order, and the batch is
    /// delivered. The vault burns within the shared allowance, first come. With `raiseOn` (a day, 0 for none), the
    /// thief raises the payout delay to its 48-hour bound a second before that day's payouts (a tightening, at once,
    /// stamping nothing). With `rollEmpty`, the thief, first in each day's second, rolls the open batch whenever it
    /// comes due empty (anyone may), so that day's requests wait a day: a delivery every other day (the users here ask
    /// only as each day starts, so after a close the batch waits empty until it is due). With `keepOneWaiting`, one
    /// holder asks again right after each close, so no batch falls due empty. With `crowder`, a thief's own holder
    /// asks first each day; `honestPaid` is what the other holders were paid. Checks, each day: the vault
    /// reads OPEN, a forged delivery from `rogueDoor` is refused UnknownPeer (no drain), no redeem is burned after one
    /// was deferred, each payout sends its whole batch (`paid`: what the vault sent, beyond its reach and the thief's;
    /// Task 40's I-1 ruling, "out" means paid), the oldest batch not paid is refused PayoutDelayed, and each batch is
    /// queued at its day's start. `predicted` and `predictedPaid` are the same deliveries by the vault's own numbers,
    /// read at run time: max(bps of the base, the floor) burned at each, bps the smaller of the door's and the global,
    /// the base falling by each batch paid, a batch paid once its queue time and the payout delay are past.
    function _runAtTheFloor(uint256 t0, uint256 days_, address rogueDoor, RunPlan memory plan)
        internal
        returns (Run memory r)
    {
        assertLe(c.vaultLens.payoutDelay(), 1 days, "each day's payouts land before the next day's window");
        r.base0 = _base();
        uint256 bps = Math.min(c.vaultLens.maxDailyOutflowBps(), c.vaultLens.globalOutflowBps());
        uint256 floor = c.vaultLens.minDailyOutflow();
        bytes32[] memory keys = new bytes32[](days_);
        CascadeMessages.Payout[][] memory lists = new CascadeMessages.Payout[][](days_);
        uint256[] memory burnedOf = new uint256[](days_);
        uint256[] memory predictedOf = new uint256[](days_);
        uint256[] memory queuedAt = new uint256[](days_);
        uint256[] memory honestOf = new uint256[](days_);
        uint256 n;
        uint256 head;
        uint256 predictedHead;
        uint256 rest = r.base0;
        for (uint256 k; k < days_; ++k) {
            uint256 when = t0 + k * 1 days;
            if (plan.raiseOn != 0 && k == plan.raiseOn) {
                Schedule.warpTo(when - 1);
                vm.prank(owner);
                c.vault.setPayoutDelay(48 hours);
                assertTrue(c.vaultLens.exitsOpen(), "the raise closes nothing");
            }
            if (vm.getBlockTimestamp() < when) Schedule.warpTo(when);
            bool rolled = plan.rollEmpty && _rollIfEmpty();
            if (rolled) ++r.rolls;
            uint256 delay = c.vaultLens.payoutDelay();
            // the vault's numbers: each batch due by now paid, the base falling by it
            while (predictedHead < n && queuedAt[predictedHead] + delay <= when) {
                rest -= predictedOf[predictedHead];
                r.predictedPaid += predictedOf[predictedHead++];
            }
            // measured: every queued batch now due goes out, whole; the oldest left is not yet due
            while (head < n && c.vaultLens.getPayoutBatch(keys[head]).queuedAt + delay <= vm.getBlockTimestamp()) {
                uint256 sent = _payout(keys[head], lists[head]);
                assertEq(sent, burnedOf[head], "a due batch paid whole");
                PayoutBatch memory b = c.vaultLens.getPayoutBatch(keys[head]);
                assertEq(b.cursor, b.count, "nothing of it left queued");
                r.paid += sent;
                r.honestPaid += honestOf[head];
                ++head;
            }
            if (head < n) _assertNotDue(keys[head], lists[head]);
            assertTrue(c.vaultLens.exitsOpen(), "OPEN on each day of the run");
            (bytes4 forged,) = _forgedErr(rogueDoor, holders[0]);
            assertEq(forged, UnknownPeer.selector, "the rogue door cannot deliver yet: no drain");
            // a holder whose shares are worth less than the smallest door redeem is out (its dust leaves directly:
            // redeemDirect pays any amount), so every deferral below is the allowance's; the thief's own holder first
            if (plan.crowder != address(0) && _valueOf(plan.crowder) >= MIN_REDEEM_VALUE) {
                _request(plan.crowder, c.vault.balanceOf(plan.crowder));
            }
            for (uint256 i; i < HOLDERS; ++i) {
                if (_valueOf(holders[i]) >= MIN_REDEEM_VALUE) _request(holders[i], c.vault.balanceOf(holders[i]));
            }
            if (rolled) {
                assertFalse(c.fd.canClose(), "rolled: today's requests wait a day");
                continue;
            }
            predictedOf[n] = Math.min(Math.max(rest * bps / 10_000, floor), rest);
            r.predicted += predictedOf[n];
            Delivery memory d = _closeDoor();
            assertFalse(d.failed, "each batch is delivered");
            assertFalse(d.burnedAfterDeferred, "first come: nothing burned after a deferral");
            assertEq(c.vaultLens.getPayoutBatch(d.key).queuedAt, when, "queued at the day's start");
            r.burned += d.burned;
            if (d.deferred != 0) ++r.daysDeferred;
            queuedAt[n] = when;
            for (uint256 i; i < d.list.length; ++i) {
                if (d.list[i].user != plan.crowder) honestOf[n] += d.list[i].assets;
            }
            keys[n] = d.key;
            lists[n] = d.list;
            burnedOf[n++] = d.burned;
            if (plan.keepOneWaiting) _askAgainAtOnce();
        }
        r.deliveries = n;
        uint256 left = n - head;
        r.queuedKeys = new bytes32[](left);
        r.queuedLists = new CascadeMessages.Payout[][](left);
        r.queuedBurned = new uint256[](left);
        for (uint256 j; j < left; ++j) {
            r.queuedKeys[j] = keys[head + j];
            r.queuedLists[j] = lists[head + j];
            r.queuedBurned[j] = burnedOf[head + j];
            r.queued += burnedOf[head + j];
        }
    }

    /// The roll's defence: right after a close, the first holder with shares left asks again at once, so the open batch
    /// is not empty when it falls due.
    function _askAgainAtOnce() internal {
        for (uint256 i; i < HOLDERS; ++i) {
            if (_valueOf(holders[i]) >= MIN_REDEEM_VALUE) {
                _request(holders[i], c.vault.balanceOf(holders[i]));
                return;
            }
        }
    }

    /// The thief rolls the launch door's open batch if it is due and empty (`closeBatch` of an empty batch restarts its
    /// timer); whether it did.
    function _rollIfEmpty() internal returns (bool) {
        (uint64 id,,,, uint256 deposits, uint256 redeems) = c.fd.openBatch();
        if (deposits + redeems != 0 || !c.fd.canClose()) return false;
        vm.prank(owner);
        c.fd.closeBatch(id, 0);
        (, uint64 start,,,,) = c.fd.openBatch();
        assertEq(start, vm.getBlockTimestamp(), "rolled: its timer restarted");
        return true;
    }

    /// The payout of the queued batch `key` now is refused PayoutDelayed (by anyone, committed: it changes nothing).
    function _assertNotDue(bytes32 key, CascadeMessages.Payout[] memory list) internal {
        vm.prank(closer);
        (bool ok, bytes memory why) = address(c.vault).call(abi.encodeCall(c.vault.processPayouts, (key, list, 0)));
        assertFalse(ok, "a queued batch not yet due cannot be paid");
        assertEq(why, _err(PayoutDelayed.selector), "it is not yet due");
    }

    /// The Base side's move at the rogue door's scheduling (Task 40's re-review, N-1), both keys stolen: the front
    /// door's batch interval raised to its 24-hour bound (up is a tightening: at once, stamping nothing), then the empty
    /// open batch rolled (`closeBatch` of an empty batch restarts its timer; anyone may), so the requests every holder
    /// makes now wait a day: with fewer than `maxRedeems` requesters the batch cannot close before then. Nothing stamps
    /// on either chain.
    function _holdTheFirstClose() internal {
        _holdTheFirstClose(address(0));
    }

    /// The same, `first` (a thief's own holder, or address(0)) asking before every holder.
    function _holdTheFirstClose(address first) internal {
        CascadeFrontDoor fd = c.fd;
        uint64 doorClock = c.doorLens.lastOwnerClose();
        uint64 bound = fd.MAX_BATCH_INTERVAL();
        vm.prank(owner);
        fd.setBatchInterval(bound);
        assertEq(fd.batchInterval(), 24 hours, "the batch interval at its bound");
        (uint64 id,,,, uint256 deposits, uint256 redeems) = fd.openBatch();
        assertEq(deposits + redeems, 0, "the open batch is empty");
        vm.prank(owner);
        fd.closeBatch(id, 0);
        (uint64 rolled, uint64 start,,,,) = fd.openBatch();
        assertEq(rolled, id, "a roll, not a close");
        assertEq(start, vm.getBlockTimestamp(), "its timer restarted now");
        assertEq(c.doorLens.lastOwnerClose(), doorClock, "the front door's clock untouched");
        assertTrue(c.doorLens.exitsOpen(), "the front door OPEN");
        // every holder asks now: twenty requests do not close it, nor does a day less a second
        if (first != address(0)) _request(first, c.vault.balanceOf(first));
        for (uint256 i; i < HOLDERS; ++i) {
            _request(holders[i], c.vault.balanceOf(holders[i]));
        }
        assertLt(HOLDERS + 1, fd.maxRedeems(), "fewer requesters than close a batch by themselves");
        assertFalse(fd.canClose(), "twenty requests do not close it");
        Schedule.warpTo(uint256(start) + 1 days - 1);
        _refuses(
            closer,
            address(fd),
            abi.encodeCall(fd.closeBatch, (id, 0)),
            _err(CascadeFrontDoor.BatchNotReady.selector),
            "nor does a day less a second"
        );
    }

    /// The rogue door `door` (scheduled at the run's start) at its readyAt, both keys stolen (Task 40's I-1): one
    /// second before it, the earliest the door could execute less a second, every batch still queued is not yet due
    /// (PayoutDelayed; at the launch's 24-hour payout delay, the last day's, queued a day before) and the rogue door
    /// cannot deliver; `r.paid` is what left by then. In the readyAt's second the thief acts first: it executes the
    /// door (measured, `_toReady`; an owner stamp before it would kill the door), then cancels every queued batch (the
    /// owner's, at any time: their holders' shares re-minted, the value they were owed; a launch-door cancel stamps,
    /// but the door is already active), then redeems the re-minted shares through the rogue door's forged delivery,
    /// in a fresh window. Returns when the door ran, what the cancels re-minted and what that delivery burned.
    function _theThiefTakesWhatIsQueued(Run memory r, bytes memory door, address rogueDoor)
        internal
        returns (uint64 when, uint256 reminted, uint256 taken)
    {
        CascadeVault v = c.vault;
        Item memory it = c.vaultLens.scheduled(keccak256(door));
        Schedule.warpTo(it.readyAt - 1);
        for (uint256 j; j < r.queuedKeys.length; ++j) {
            _assertNotDue(r.queuedKeys[j], r.queuedLists[j]);
        }
        (bytes4 forged,) = _forgedErr(rogueDoor, holders[0]);
        assertEq(forged, UnknownPeer.selector, "and the rogue door cannot deliver");

        // the readyAt's second: the door first
        when = _toReady(v, door);
        _executeNow(v, door);
        assertEq(uint8(c.vaultLens.doorState(c.vaultLens.peerId(BASE, rogueDoor))), uint8(DoorState.Active), "active");
        // then the cancel of every queued batch, the owner's: its holders' shares re-minted
        uint256 n;
        for (uint256 j; j < r.queuedLists.length; ++j) {
            n += r.queuedLists[j].length;
        }
        CascadeMessages.Entry[] memory entries = new CascadeMessages.Entry[](n);
        n = 0;
        for (uint256 j; j < r.queuedKeys.length; ++j) {
            vm.recordLogs();
            vm.prank(owner);
            v.cancelPayoutBatch(r.queuedKeys[j], r.queuedLists[j]);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            assertEq(c.vaultLens.lastOwnerClose(), when, "the cancel stamps, after the door ran");
            uint256 owed;
            uint256 reversed;
            for (uint256 i; i < logs.length; ++i) {
                if (_isVault(logs[i], RedeemReversed.selector)) {
                    (uint256 shares, uint256 assets) = abi.decode(logs[i].data, (uint256, uint256));
                    entries[n++] = CascadeMessages.Entry(address(uint160(uint256(logs[i].topics[2]))), shares);
                    owed += assets;
                    ++reversed;
                }
            }
            assertEq(reversed, r.queuedLists[j].length, "every redeem of a queued batch re-minted");
            assertEq(owed, r.queuedBurned[j], "re-minted: the value the batch owed");
            reminted += owed;
        }
        // then the rogue door's forged redeem of those shares, through the primary
        (bytes4 err, Delivery memory d) = _forge(c.vault.exposed_primaryBridge(), rogueDoor, entries);
        assertEq(err, bytes4(0), "the rogue door delivers once active");
        taken = d.burned;
    }

    // ---- the copied seed (spec §3.6's CO column; Task 39b's sweeper and 12-hour stack) ----

    /// The founder's stack: the next stamp's asOf, not yet relayed (0 while no stack runs), and how many it relayed.
    uint64 internal _stackNext;
    uint256 internal _stackRelays;
    /// The founder's fresh staker, and the door's outflow percentage, at the copy (`_copySeed`).
    CascadeStaker internal freshStaker;
    uint256 internal _outflowAtCopy;

    /// The copy (spec §3.6's CO column): the thief holds a copy of the owner's seed, so both keys (one Ledger,
    /// decision D2), and runs the sweeper (GovernanceFixture's `sweeper(bool)`): the founder's accounts, which held
    /// gas before the copy, are drained now and before every step, so the founder's own transactions never land
    /// (`_founderSends`). The founder acts only through what the copy leaves it: its pre-signed stack, spaced
    /// STAMP_SPACING (12 hours, Task 48's), the first as of now, relayed by the stranger on both targets as each asOf
    /// passes (`_coWait`); and a fresh staker from a fresh account the seed does not hold, since the thief takes the
    /// old one at once (its plain two-step ownership; spec §5: the web points at a fresh staker).
    function _copySeed() internal {
        vm.deal(owner, 1 ether);
        vm.deal(guardian, 1 ether);
        sweeper(true);
        _assertSwept("the copy");
        _outflowAtCopy = c.vaultLens.maxDailyOutflowBps();
        // the old staker: the thief's at once
        vm.prank(owner);
        c.staker.transferOwnership(owner2);
        vm.prank(owner2);
        c.staker.acceptOwnership();
        assertEq(c.staker.owner(), owner2, "the thief takes the staker at once");
        // the fresh staker, beyond the seed
        address fresh = makeAddr("the founder's fresh account");
        CascadeStaker.Params memory sp = defaultStakerParams(
            c.usdc,
            c.tao,
            c.fd,
            fresh,
            treasury,
            address(c.router),
            abi.encodePacked(address(c.usdc), uint24(3000), address(c.tao)),
            abi.encodePacked(address(c.tao), uint24(3000), address(c.usdc))
        );
        vm.prank(fresh);
        freshStaker = new CascadeStaker(sp);
        assertEq(freshStaker.owner(), fresh, "the fresh staker is the fresh account's");
        _refuses(
            owner,
            address(freshStaker),
            abi.encodeCall(Ownable.transferOwnership, (owner2)),
            _notOwner(owner),
            "the copied seed cannot take it"
        );
        // the stack, its first stamp as of now
        _stackNext = uint64(vm.getBlockTimestamp());
        _relayDue();
    }

    /// The founder's accounts hold nothing (the sweeper's work).
    function _assertSwept(string memory why) internal view {
        assertEq(owner.balance + guardian.balance, 0, string.concat(why, ": the founder's accounts swept"));
    }

    /// The founder's own transaction `data` to `target` from `account` (the owner's or the guardian's), modelled with
    /// its gas: it is sent only while the account holds any, which under the sweeper it never does (spec §3.6: the
    /// thief drains the accounts and front-runs every refill). Whether it landed. A check of this model, not of a
    /// contract: a test EVM charges a pranked sender nothing, so no assertion on it is contract evidence.
    function _founderSends(address account, address target, bytes memory data) internal returns (bool landed) {
        swept();
        if (account.balance == 0) return false;
        vm.prank(account);
        (landed,) = target.call(data);
    }

    /// The stack's stamps whose asOf has come, relayed now by the stranger on both targets, each moving both owner
    /// clocks to its asOf.
    function _relayDue() internal {
        while (_stackNext != 0 && _stackNext <= vm.getBlockTimestamp()) {
            swept();
            stampAt(c.vault, _stackNext);
            stampAt(c.fd, _stackNext);
            assertGe(c.vaultLens.lastOwnerClose(), _stackNext, "the vault's owner clock at the stamp");
            assertGe(c.doorLens.lastOwnerClose(), _stackNext, "the front door's owner clock at the stamp");
            ++_stackRelays;
            _stackNext += STAMP_SPACING;
        }
    }

    /// Time moves to `to` (a block a second), stopping at each of the stack's asOfs on the way to relay it there; with
    /// `frontRun`, a stamp whose asOf is `to` itself is left for after the caller's next step (the thief lands first in
    /// that second). The sweeper drains the founder's accounts at the end.
    function _coWait(uint256 to, bool frontRun) internal {
        while (_stackNext != 0 && _stackNext <= to) {
            if (frontRun && _stackNext == to) break;
            if (_stackNext > vm.getBlockTimestamp()) Schedule.warpTo(_stackNext);
            _relayDue();
        }
        if (to > vm.getBlockTimestamp()) Schedule.warpTo(to);
        swept();
    }

    /// The thief's items `items` on `t` under the founder's stack, until `until`. Each is scheduled now (the caller is
    /// a second after a relay: the thief's best second, the next stamp coming STAMP_SPACING less a second later) and
    /// tried at its readyAt (and readyBlock), ahead of any relay in that second: the owner's clock has passed its
    /// schedule time and its execute is refused ExitsNotOpen; the thief schedules it again a second after the next
    /// relay. Time moves event by event (the next readyAt or the next relay), so every try is at its readyAt. At the
    /// end the next stamp is relayed, so every item still pending has died too. Nothing executes. Returns how many
    /// executes were tried.
    function _thiefUnderTheStack(CascadeBase t, bytes[] memory items, uint256 until) internal returns (uint256 tries) {
        CascadeBaseLens lens = _lensOf[address(t)];
        bool[] memory pending = new bool[](items.length);
        _scheduleDead(t, items, pending);
        for (;;) {
            uint64 next = type(uint64).max;
            for (uint256 i; i < items.length; ++i) {
                uint64 readyAt = lens.scheduled(keccak256(items[i])).readyAt;
                if (pending[i] && readyAt < next) next = readyAt;
            }
            if (next <= _stackNext) {
                if (next > until) break;
                _coWait(next, true);
                for (uint256 i; i < items.length; ++i) {
                    Item memory it = lens.scheduled(keccak256(items[i]));
                    if (!pending[i] || it.readyAt != next) continue;
                    assertGe(vm.getBlockNumber(), it.readyBlock, "at its readyBlock too");
                    assertGe(lens.lastOwnerClose(), it.scheduledAt, "a stack stamp came after it");
                    swept();
                    _execRefused(t, items[i], _err(ExitsNotOpen.selector), "the thief's item dies to the stack");
                    ++tries;
                    pending[i] = false;
                }
            } else {
                if (_stackNext + 1 > until) break;
                _coWait(_stackNext, false);
                Schedule.wait(1);
                _scheduleDead(t, items, pending);
            }
        }
        _coWait(_stackNext, false);
        for (uint256 i; i < items.length; ++i) {
            if (pending[i]) assertGe(lens.lastOwnerClose(), lens.scheduled(keccak256(items[i])).scheduledAt, "dead");
        }
    }

    /// The thief schedules now every item of `items` not pending.
    function _scheduleDead(CascadeBase t, bytes[] memory items, bool[] memory pending) private {
        for (uint256 i; i < items.length; ++i) {
            if (pending[i]) continue;
            swept();
            _sched(t, items[i]);
            pending[i] = true;
            assertLe(_stackNext - vm.getBlockTimestamp(), STAMP_SPACING, "the next stamp within the spacing");
        }
    }
}
