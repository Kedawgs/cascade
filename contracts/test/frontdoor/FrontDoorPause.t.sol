// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {ICascadeTwap} from "../../src/interfaces/ICascadeTwap.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {MockSwapper} from "../mocks/MockSwapper.sol";
import {MockTwap} from "../mocks/MockTwap.sol";
import {StubBridge} from "../mocks/StubBridge.sol";
import {RenounceDisabled} from "../../src/CascadeErrors.sol";
import {Schedule} from "../governance/Schedule.sol";
import {Stamps} from "../governance/StampVector.sol";
import {DOOR_TAO_WETH_FLOOR} from "../utils/DefaultParams.sol";
import {doorEntryPoints} from "../utils/DoorEntryPoints.sol";
import {FrontDoorPayoutsBase} from "./FrontDoorPayoutsBase.sol";

contract FrontDoorPauseTest is FrontDoorPayoutsBase {
    // ---- the pause (spec §3.5, I-20) ----

    /// I-20: a paused front door refuses no exit call. While the guardian's pause lasts, holders cancel a deposit (at
    /// once, its cooldown waived while paused, R12), request redeems (with a delivery preference too), cancel a request,
    /// close the batch, have a request close a full one on its pot (the self-close), receive a payout and claim it, the
    /// claim clearing the preference.
    function test_everyExitCallWorksPaused() public {
        dep(alice, 10e18);
        dep(bob, 5e18);
        pauseFd();
        uint256 fee = fd.redeemRequestFee();
        uint64 deadline = uint64(vm.getBlockTimestamp() + 7 days);
        uint32 base = fd.DESTINATION_BASE();

        // the cancel at once, inside its five minutes: no cooldown while paused (R12; under R11 it waited them out)
        assertEq(fd.cancelableAt(alice), 0, "paused: no cooldown");
        vm.prank(alice);
        fd.cancelDeposit(4e18);
        assertEq(fd.depositOf(alice), 6e18);
        assertEq(tao.balanceOf(alice), 994e18);
        vm.prank(alice);
        fd.requestRedeem{value: fee}(3e24);
        vm.prank(carol);
        fd.requestRedeemWithDelivery{value: fee}(2e24, 250e6, deadline, base);
        (uint128 floor,,) = fd.deliveryOf(carol);
        assertEq(floor, 250e6);
        vm.prank(alice);
        fd.cancelRedeem(1e24);
        assertEq(fd.redeemOf(alice), 2e24);
        assertEq(fd.redeemOf(carol), 2e24);

        // the close, once due: the pot's 2e14 and 8e14 of bob's value
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        vm.prank(bob);
        fd.closeBatch{value: 1e15}(1, 11e18);
        assertEq(bridge.sendCount(), 1);
        assertEq(
            bridge.lastMessage(),
            CascadeMessages.encodeBatch(1, entries2(alice, 6e18, bob, 5e18), entries2(alice, 2e24, carol, 2e24))
        );
        assertEq(bridge.lastAmount(), 11e18);
        assertEq(bob.balance, 1 ether - 8e14);

        // the self-close: a request meeting a full redeem list sends it on its pot and lands in the next batch
        bridge.setFee(fee);
        vm.prank(owner);
        fd.setBatchLimits(50, 1);
        vm.prank(alice);
        fd.requestRedeem{value: fee}(1e24);
        vm.prank(bob);
        fd.requestRedeem{value: fee}(1e24);
        assertEq(bridge.sendCount(), 2);
        assertEq(bridge.lastMessage(), CascadeMessages.encodeBatch(2, noEntries(), entries1(alice, 1e24)));
        (uint64 id,,,,,) = fd.openBatch();
        assertEq(id, 3);
        assertEq(fd.redeemOf(bob), 1e24);

        // an incoming payout, and the claims
        deliverPayouts(KEY, 0, entries2(alice, 3e18, carol, 2e18), true);
        vm.prank(alice);
        fd.claim();
        vm.prank(carol);
        fd.claim();
        assertEq(tao.balanceOf(alice), 997e18);
        assertEq(tao.balanceOf(carol), 1_002e18);
        (floor,,) = fd.deliveryOf(carol);
        assertEq(floor, 0, "the claim cleared the preference");
        assertTrue(fd.paused(), "paused throughout");
        assertTokenIdentity();
    }

    /// One row of the pause sweep: a call into the front door for the entry point `entry` (the selector of its
    /// doorEntryPoints() signature), made by `from` with `value` wei after `prep` (made by `prepFrom`, when not empty);
    /// `expected` is its revert data, or empty when it succeeds. A scheduled-only setter's row runs it through
    /// `execute`, so its data is execute's and its entry the setter's. `pausedOnly` marks the rows whose outcome is the
    /// pause's own (the three it stops, pause and unpause), which the unpaused re-run skips.
    struct DoorCall {
        string name;
        bytes4 entry;
        address from;
        uint256 value;
        bytes data;
        bytes expected;
        address prepFrom;
        bytes prep;
        bool pausedOnly;
    }

    /// What the sweep's rows need, prepared before the pause.
    struct SweepState {
        uint64 deadline;
        bytes32 lapsedId;
        bytes32 oracleId;
        bytes oracleItem;
        bytes swapperItem;
        bytes guardianItem;
        bytes ownerItem;
        bytes bridgeItem;
        bytes executeItem;
        address newOwner;
        address bridge2;
        address other;
        MockSwapper swapper;
    }

    function _row(string memory name, address from, uint256 value, bytes memory data, bytes memory expected)
        internal
        pure
        returns (DoorCall memory c)
    {
        c.name = name;
        c.entry = bytes4(data);
        c.from = from;
        c.value = value;
        c.data = data;
        c.expected = expected;
    }

    /// A scheduled-only setter's row: the owner executes `item`, scheduled and ready before the pause.
    function _scheduledRow(string memory name, bytes memory item) internal view returns (DoorCall memory c) {
        c = _row(name, owner, 0, abi.encodeCall(fd.execute, (item)), "");
        c.entry = bytes4(item);
    }

    /// Runs `c` (its prep first) and checks its outcome against `c.expected`; `when` labels the run.
    function _runRow(DoorCall memory c, string memory when) internal {
        if (c.prep.length != 0) {
            vm.prank(c.prepFrom);
            (bool prepped,) = address(fd).call(c.prep);
            assertTrue(prepped, string.concat(c.name, ": its prep", when));
        }
        vm.prank(c.from);
        (bool ok, bytes memory ret) = address(fd).call{value: c.value}(c.data);
        if (c.expected.length == 0) {
            assertTrue(ok, string.concat(c.name, when));
        } else {
            assertFalse(ok, string.concat(c.name, when));
            assertEq(ret, c.expected, string.concat(c.name, when));
        }
    }

    /// The sweep's state before the pause. At t0 an item is scheduled that lapses before the sweep (prune's row); two
    /// days on, the books (a deposit, a request, a credit with a delivery preference) and every other item, all ready
    /// and none lapsed eight days later: the real oracle and swapper, a second bridge (all three executed before the
    /// pause), and one item for each scheduled-only setter, for execute and for cancel.
    function _prepareSweep() internal returns (SweepState memory s) {
        s.other = makeAddr("other");
        s.newOwner = makeAddr("new owner");
        vm.prank(owner);
        s.lapsedId = fd.schedule(abi.encodeCall(fd.setBatchInterval, (6 hours)));
        Schedule.wait(2 days);

        dep(alice, 2e18);
        requestWithFee(bob, 1e24);
        deliverPayouts(KEY, 0, entries1(carol, 10e18), true);
        s.deadline = uint64(vm.getBlockTimestamp() + 30 days);
        vm.prank(carol);
        fd.setDelivery(240e6, s.deadline, 6);

        s.swapper = new MockSwapper(tao, usdc);
        s.swapper.setMode(MockSwapper.Mode.Honest, 248e6);
        s.bridge2 = address(new StubBridge(tao));
        bytes[3] memory before = [
            abi.encodeCall(fd.setOracle, (ICascadeTwap(address(new MockTwap(250e6))))),
            abi.encodeCall(fd.setSwapper, (address(s.swapper))),
            abi.encodeCall(fd.activateBridge, (s.bridge2))
        ];
        s.oracleItem = abi.encodeCall(fd.setOracle, (ICascadeTwap(makeAddr("other oracle"))));
        s.swapperItem = abi.encodeCall(fd.setSwapper, (s.other));
        s.guardianItem = abi.encodeCall(fd.setGuardian, (makeAddr("new guardian")));
        s.ownerItem = abi.encodeCall(fd.transferOwnership, (s.newOwner));
        s.bridgeItem = abi.encodeCall(fd.activateBridge, (address(new StubBridge(tao))));
        s.executeItem = abi.encodeCall(fd.setMaxBatchValue, (4_500e18));
        vm.startPrank(owner);
        for (uint256 i; i < before.length; ++i) {
            fd.schedule(before[i]);
        }
        s.oracleId = fd.schedule(s.oracleItem);
        fd.schedule(s.swapperItem);
        fd.schedule(s.guardianItem);
        fd.schedule(s.ownerItem);
        fd.schedule(s.bridgeItem);
        fd.schedule(s.executeItem);
        vm.stopPrank();

        // the Guardian class's 8 days: every item ready, the Param ones a day inside their window, the t0 one lapsed
        Schedule.wait(8 days);
        vm.startPrank(owner);
        for (uint256 i; i < before.length; ++i) {
            fd.execute(before[i]);
        }
        vm.stopPrank();
        tao.mint(address(fd), 1e18);
        pauseFd();
    }

    /// The sweep's 38 rows, in doorEntryPoints()'s order.
    function _sweepRows(SweepState memory s) internal view returns (DoorCall[] memory calls) {
        bytes memory enforced = abi.encodeWithSelector(Pausable.EnforcedPause.selector);
        uint64 asOf = uint64(vm.getBlockTimestamp());
        calls = new DoorCall[](38);
        // what the pause stops, and pause itself
        calls[0] = _row("deposit", alice, 0, abi.encodeCall(fd.deposit, (1e18)), enforced);
        calls[1] = _row("depositFor", bob, 0, abi.encodeCall(fd.depositFor, (alice, 1e18)), enforced);
        calls[2] = _row("deliver", keeper, 0, abi.encodeCall(fd.deliver, (carol, 0)), enforced);
        calls[3] = _row("pause", guardian, 0, abi.encodeCall(fd.pause, ()), enforced);
        // the exits
        calls[4] = _row("cancelDeposit", alice, 0, abi.encodeCall(fd.cancelDeposit, (1e18)), "");
        calls[5] = _row("requestRedeem", alice, 1e14, abi.encodeCall(fd.requestRedeem, (1e24)), "");
        calls[6] = _row(
            "requestRedeemWithDelivery",
            carol,
            1e14,
            abi.encodeCall(fd.requestRedeemWithDelivery, (1e24, 240e6, s.deadline, 6)),
            ""
        );
        calls[7] = _row("cancelRedeem", bob, 0, abi.encodeCall(fd.cancelRedeem, (1e24)), "");
        calls[8] = _row("closeBatch", alice, 1e15, abi.encodeCall(fd.closeBatch, (1, 2e18)), "");
        calls[9] = _row(
            "onBridgeMessage",
            address(bridge),
            0,
            abi.encodeCall(
                fd.onBridgeMessage,
                (BITTENSOR, vault, CascadeMessages.encodePayouts(KEY2, 0, entries1(bob, 1e18)), 1e18)
            ),
            ""
        );
        calls[10] = _row("claim", carol, 0, abi.encodeCall(fd.claim, ()), "");
        // the rest of a holder's surface
        calls[11] = _row("creditRedeemFee", bob, 1e14, abi.encodeCall(fd.creditRedeemFee, (bob)), "");
        calls[12] = _row("setDelivery", alice, 0, abi.encodeCall(fd.setDelivery, (250e6, s.deadline, 6)), "");
        calls[13] = _row(
            "stampBySig",
            s.other,
            0,
            abi.encodeCall(fd.stampBySig, (asOf, Stamps.signed(ownerKey, address(fd), asOf))),
            ""
        );
        // the owner's
        calls[14] = _row("sweepPot", owner, 0, abi.encodeCall(fd.sweepPot, (0)), "");
        calls[15] = _row("setCaps", owner, 0, abi.encodeCall(fd.setCaps, (1e18, 10_000e18)), "");
        calls[16] = _row("setBatchLimits", owner, 0, abi.encodeCall(fd.setBatchLimits, (50, 50)), "");
        calls[17] = _row("setMaxBatchValue", owner, 0, abi.encodeCall(fd.setMaxBatchValue, (4_000e18)), "");
        calls[18] = _row("setBatchInterval", owner, 0, abi.encodeCall(fd.setBatchInterval, (12 hours)), "");
        calls[19] = _row("setRedeemRequestFee", owner, 0, abi.encodeCall(fd.setRedeemRequestFee, (1e14)), "");
        calls[20] = _row("setKeeper", owner, 0, abi.encodeCall(fd.setKeeper, (keeper)), "");
        calls[21] = _row("setMaxDeliverySlippage", owner, 0, abi.encodeCall(fd.setMaxDeliverySlippage, (150)), "");
        calls[22] = _row(
            "setMinPoolLiquidity", owner, 0, abi.encodeCall(fd.setMinPoolLiquidity, (0, DOOR_TAO_WETH_FLOOR + 1)), ""
        );
        // the scheduled-only setters, each run through execute: each succeeds on its own logic
        calls[23] = _scheduledRow("setOracle", s.oracleItem);
        calls[24] = _scheduledRow("setSwapper", s.swapperItem);
        calls[25] = _scheduledRow("setGuardian", s.guardianItem);
        calls[26] = _scheduledRow("transferOwnership", s.ownerItem);
        calls[27] = _scheduledRow("activateBridge", s.bridgeItem);
        // the scheduler and the instruments, each where it succeeds
        calls[28] = _row(
            "schedule", owner, 0, abi.encodeCall(fd.schedule, (abi.encodeCall(fd.setMaxDeliverySlippage, (200)))), ""
        );
        calls[29] = _row("execute", owner, 0, abi.encodeCall(fd.execute, (s.executeItem)), "");
        calls[30] = _row("cancel", guardian, 0, abi.encodeCall(fd.cancel, (s.oracleId)), "");
        calls[31] = _row("prune", s.other, 0, abi.encodeCall(fd.prune, (s.lapsedId)), "");
        // the pending owner accepts, once its transfer has executed
        calls[32] = _row("acceptOwnership", s.newOwner, 0, abi.encodeCall(fd.acceptOwnership, ()), "");
        calls[32].prepFrom = owner;
        calls[32].prep = abi.encodeCall(fd.execute, (s.ownerItem));
        calls[33] = _row("disableBridge", guardian, 0, abi.encodeCall(fd.disableBridge, (address(bridge))), "");
        // the switch, once the primary is disabled
        calls[34] = _row("setPrimaryBridge", owner, 0, abi.encodeCall(fd.setPrimaryBridge, (s.bridge2)), "");
        calls[34].prepFrom = guardian;
        calls[34].prep = abi.encodeCall(fd.disableBridge, (address(bridge)));
        calls[35] = _row(
            "renounceOwnership",
            owner,
            0,
            abi.encodeCall(fd.renounceOwnership, ()),
            abi.encodeWithSelector(RenounceDisabled.selector)
        );
        calls[36] =
            _row("receive", alice, 1, "", abi.encodeWithSelector(CascadeFrontDoor.DirectTransferNotAllowed.selector));
        calls[36].entry = bytes4(keccak256("receive()"));
        calls[37] = _row("unpause", owner, 0, abi.encodeCall(fd.unpause, ()), "");
        for (uint256 i; i < 4; ++i) {
            calls[i].pausedOnly = true;
        }
        calls[37].pausedOnly = true;
    }

    /// The pause's reach (spec §3.5): while paused, deposit, depositFor and deliver revert EnforcedPause (and pause
    /// itself, OpenZeppelin's, which refuses a second pause), and every other entry point of the front door gets past
    /// the pause. The rows are doorEntryPoints(), the door's whole non-view ABI with receive, which the build checks
    /// pin to the built ABI (script/lens-surface.mjs) and this test to its rows, one per entry point in order. Each row
    /// runs where it succeeds, or reverts on its own logic (renounceOwnership, receive): the scheduled-only setters
    /// through execute, prune on a lapsed item, acceptOwnership after its transfer, setPrimaryBridge after the primary's
    /// disable. Each runs from the same paused state (a state snapshot), its revert data compared exactly, and again
    /// unpaused from that state, with the same outcome: no row's error is the pause's. Once unpaused, the three it stops
    /// go through: the deposits land and the keeper's delivery pays carol. The exits' own effects are
    /// test_everyExitCallWorksPaused's.
    function test_pauseStopsDepositAndDeliverOnly() public {
        SweepState memory s = _prepareSweep();
        DoorCall[] memory calls = _sweepRows(s);
        string[] memory points = doorEntryPoints();
        assertEq(calls.length, points.length, "one row per entry point");

        for (uint256 i; i < calls.length; ++i) {
            assertEq(
                calls[i].entry, bytes4(keccak256(bytes(points[i]))), string.concat(calls[i].name, " is not ", points[i])
            );
            uint256 snap = vm.snapshotState();
            _runRow(calls[i], " (paused)");
            vm.revertToState(snap);
            if (!calls[i].pausedOnly) {
                snap = vm.snapshotState();
                vm.prank(owner);
                fd.unpause();
                _runRow(calls[i], " (unpaused)");
                vm.revertToState(snap);
            }
            assertTrue(fd.paused());
        }

        // unpaused, the three go through: the deposits land, and the keeper sells carol's 10 TAO credit at the
        // swapper's 248 USDC, above the largest floor (her 240, the oracle's 250 less 1.5%), and pays her
        vm.prank(owner);
        fd.unpause();
        dep(alice, 1e18);
        vm.prank(bob);
        fd.depositFor(alice, 1e18);
        assertEq(fd.depositOf(alice), 4e18);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.Delivered(carol, 10e18, 2_480e6);
        vm.prank(keeper);
        assertEq(fd.deliver(carol, 0), 2_480e6);
        assertEq(usdc.balanceOf(carol), 2_480e6);
        assertEq(fd.claimable(carol), 0);
        assertEq(tao.balanceOf(address(s.swapper)), 10e18);
    }

    function test_payoutWrongPeerReverts() public {
        bytes memory m = CascadeMessages.encodePayouts(KEY, 0, entries1(alice, 3e18));
        tao.mint(address(fd), 3e18);
        address other = makeAddr("other");

        vm.prank(address(bridge));
        vm.expectRevert(CascadeFrontDoor.UnknownPeer.selector);
        fd.onBridgeMessage(BITTENSOR, other, m, 3e18);

        // the vault's address on another chain is another peer
        vm.prank(address(bridge));
        vm.expectRevert(CascadeFrontDoor.UnknownPeer.selector);
        fd.onBridgeMessage(BASE, vault, m, 3e18);

        assertFalse(fd.delivered(address(bridge), keccak256(m)));
        assertEq(fd.totalClaimable(), 0);

        // the vault itself is accepted
        vm.prank(address(bridge));
        fd.onBridgeMessage(BITTENSOR, vault, m, 3e18);
        assertEq(fd.claimable(alice), 3e18);
    }

    function test_payoutValueMismatchReverts() public {
        bytes memory m = CascadeMessages.encodePayouts(KEY, 0, entries1(alice, 3e18));
        tao.mint(address(fd), 3e18);
        vm.deal(address(bridge), 1);

        vm.prank(address(bridge));
        vm.expectRevert(CascadeFrontDoor.ValueMismatch.selector);
        fd.onBridgeMessage{value: 1}(BITTENSOR, vault, m, 3e18);

        assertFalse(fd.delivered(address(bridge), keccak256(m)));
        assertEq(address(fd).balance, 0);
        assertEq(address(bridge).balance, 1);
    }

    function test_payoutAmountMismatchReverts() public {
        bytes memory m = CascadeMessages.encodePayouts(KEY, 0, entries2(alice, 3e18, bob, 2e18));
        tao.mint(address(fd), 6e18);

        // Σ 5e18 against 4e18 and 6e18
        vm.prank(address(bridge));
        vm.expectRevert(CascadeFrontDoor.AmountMismatch.selector);
        fd.onBridgeMessage(BITTENSOR, vault, m, 4e18);
        vm.prank(address(bridge));
        vm.expectRevert(CascadeFrontDoor.AmountMismatch.selector);
        fd.onBridgeMessage(BITTENSOR, vault, m, 6e18);

        // an empty list with tokens attached
        bytes memory empty = CascadeMessages.encodePayouts(KEY, 0, noEntries());
        vm.prank(address(bridge));
        vm.expectRevert(CascadeFrontDoor.AmountMismatch.selector);
        fd.onBridgeMessage(BITTENSOR, vault, empty, 1e18);

        assertFalse(fd.delivered(address(bridge), keccak256(m)));
        assertFalse(fd.delivered(address(bridge), keccak256(empty)));
        assertEq(fd.totalClaimable(), 0);
    }

    function test_payoutTokensNotReceivedThenRedelivered() public {
        CascadeMessages.Entry[] memory p = entries1(alice, 5e18);

        vm.expectRevert(CascadeFrontDoor.TokensNotReceived.selector);
        deliverPayouts(KEY, 0, p, false);

        // the open batch's deposits are not payout tokens: 10e18 held, 10e18 + 0 + 5e18 needed
        dep(bob, 10e18);
        vm.expectRevert(CascadeFrontDoor.TokensNotReceived.selector);
        deliverPayouts(KEY, 0, p, false);

        // one wei short: 15e18 - 1 held
        tao.mint(address(fd), 5e18 - 1);
        vm.expectRevert(CascadeFrontDoor.TokensNotReceived.selector);
        deliverPayouts(KEY, 0, p, false);
        assertFalse(fd.delivered(address(bridge), hashOf(KEY, 0, p)));

        // the rest arrives; the same message is re-delivered and goes through
        tao.mint(address(fd), 1);
        deliverPayouts(KEY, 0, p, false);
        assertEq(fd.claimable(alice), 5e18);
        assertEq(fd.totalClaimable(), 5e18);
        assertTrue(fd.delivered(address(bridge), hashOf(KEY, 0, p)));

        // existing claimable is not payout tokens either: 15e18 held, 10e18 + 5e18 + 2e18 needed
        vm.expectRevert(CascadeFrontDoor.TokensNotReceived.selector);
        deliverPayouts(KEY, 1, entries1(carol, 2e18), false);
        deliverPayouts(KEY, 1, entries1(carol, 2e18), true);
        assertEq(fd.claimable(carol), 2e18);
        assertEq(fd.totalClaimable(), 7e18);
        assertEq(tao.balanceOf(address(fd)), 17e18);
    }

    function test_payoutDuplicateChunkReverts() public {
        StubBridge bridge2 = enableBridge2();
        CascadeMessages.Entry[] memory p = entries1(alice, 3e18);
        bytes memory m = CascadeMessages.encodePayouts(KEY, 0, p);
        deliverPayouts(KEY, 0, p, true);
        assertTrue(fd.delivered(address(bridge), keccak256(m)));

        // a copy from a second enabled bridge with no tokens behind it: 3e18 held, 3e18 + 3e18 needed
        vm.prank(address(bridge2));
        vm.expectRevert(CascadeFrontDoor.TokensNotReceived.selector);
        fd.onBridgeMessage(BITTENSOR, vault, m, 3e18);

        // the same message from the same bridge, even with its tokens here again
        tao.mint(address(fd), 3e18);
        vm.expectRevert(CascadeFrontDoor.DuplicatePayouts.selector);
        deliverPayouts(KEY, 0, p, false);
        assertEq(fd.claimable(alice), 3e18);
        assertEq(fd.totalClaimable(), 3e18);

        // the same message from the second bridge is its own slot: accepted, as tokens now back it
        assertFalse(fd.delivered(address(bridge2), keccak256(m)));
        vm.prank(address(bridge2));
        fd.onBridgeMessage(BITTENSOR, vault, m, 3e18);
        assertTrue(fd.delivered(address(bridge2), keccak256(m)));
        assertEq(fd.claimable(alice), 6e18);
        // and only once from that bridge too
        tao.mint(address(fd), 3e18);
        vm.prank(address(bridge2));
        vm.expectRevert(CascadeFrontDoor.DuplicatePayouts.selector);
        fd.onBridgeMessage(BITTENSOR, vault, m, 3e18);

        // the next chunk of the same batch (those tokens now back it)
        deliverPayouts(KEY, 1, p, false);
        // chunk 0 of another batch
        deliverPayouts(KEY2, 0, p, true);

        assertEq(fd.claimable(alice), 12e18);
        assertEq(fd.totalClaimable(), 12e18);
        assertTrue(fd.delivered(address(bridge), hashOf(KEY, 1, p)));
        assertTrue(fd.delivered(address(bridge), hashOf(KEY2, 0, p)));
        assertEq(tao.balanceOf(address(fd)), 12e18);
    }

    function test_payoutReducesNetForwardedFloored() public {
        dep(alice, 10e18);
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, 10e18);
        assertEq(fd.netForwarded(), 10e18);

        deliverPayouts(KEY, 0, entries1(alice, 4e18), true);
        assertEq(fd.netForwarded(), 6e18);

        // more paid out than forwarded (gains): floored at 0
        deliverPayouts(KEY, 1, entries1(bob, 20e18), true);
        assertEq(fd.netForwarded(), 0);
        assertEq(fd.totalClaimable(), 24e18);

        // and stays at 0
        deliverPayouts(KEY2, 0, entries1(carol, 1e18), true);
        assertEq(fd.netForwarded(), 0);
    }

    function test_payoutWorksWhilePaused() public {
        pauseFd();
        assertTrue(fd.paused());

        tao.mint(address(fd), 3e18);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.PayoutReceived(KEY, 0, alice, 3e18);
        deliverPayouts(KEY, 0, entries1(alice, 3e18), false);

        assertEq(fd.claimable(alice), 3e18);
        assertEq(fd.totalClaimable(), 3e18);
        assertTrue(fd.delivered(address(bridge), hashOf(KEY, 0, entries1(alice, 3e18))));
    }

    function test_payoutEmptyListAccepted() public {
        vm.recordLogs();
        deliverPayouts(KEY, 0, noEntries(), false);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // exactly one event: PayoutsDelivered(KEY, 0, 0, bridge)
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(fd));
        assertEq(logs[0].topics.length, 2);
        assertEq(logs[0].topics[0], CascadeFrontDoor.PayoutsDelivered.selector);
        assertEq(logs[0].topics[1], KEY);
        assertEq(logs[0].data, abi.encode(uint32(0), uint256(0), address(bridge)));

        assertTrue(fd.delivered(address(bridge), hashOf(KEY, 0, noEntries())));
        assertEq(fd.totalClaimable(), 0);
        assertEq(fd.netForwarded(), 0);
        assertEq(tao.balanceOf(address(fd)), 0);

        // and is not replayable
        vm.expectRevert(CascadeFrontDoor.DuplicatePayouts.selector);
        deliverPayouts(KEY, 0, noEntries(), false);

        // an empty (KEY, 0) does not occupy the real chunk 0 of that batch
        deliverPayouts(KEY, 0, entries1(alice, 3e18), true);
        assertEq(fd.claimable(alice), 3e18);
        assertTrue(fd.delivered(address(bridge), hashOf(KEY, 0, entries1(alice, 3e18))));
    }
}
