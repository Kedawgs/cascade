// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {CancelTooSoon, PrimaryBridgeDisabled} from "../../src/CascadeErrors.sol";
import {Schedule} from "../governance/Schedule.sol";
import {FrontDoorBatchesBase} from "./FrontDoorBatchesBase.sol";

contract FrontDoorCloseTest is FrontDoorBatchesBase {
    function test_closeBatchBeforeIntervalReverts() public {
        uint256 t0 = vm.getBlockTimestamp();
        dep(alice, 10e18);
        vm.prank(carol);
        vm.expectRevert(CascadeFrontDoor.BatchNotReady.selector);
        fd.closeBatch{value: 1e15}(1, 0);

        Schedule.warpTo(t0 + 12 hours - 1);
        assertFalse(fd.canClose());
        vm.prank(carol);
        vm.expectRevert(CascadeFrontDoor.BatchNotReady.selector);
        fd.closeBatch{value: 1e15}(1, 0);

        Schedule.warpTo(t0 + 12 hours);
        assertTrue(fd.canClose());
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, 0);
        assertEq(openId(), 2);
    }

    function test_closeBatchSendsThroughPrimaryBridge() public {
        dep(alice, 10e18);
        requestWithFee(bob, 1e24);
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.BatchClosed(1, 10e18, 1, 1, 1e15, 1e14, 0);
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, 10e18);

        assertEq(bridge.lastDestChain(), BITTENSOR);
        assertEq(bridge.lastRecipient(), vault);
        assertEq(bridge.lastAmount(), 10e18);
        assertEq(bridge.lastValue(), 1e15);
        assertEq(bridge.sendCount(), 1);
        assertEq(bridge.lastMessage(), CascadeMessages.encodeBatch(1, entries1(alice, 10e18), entries1(bob, 1e24)));
        assertEq(tao.balanceOf(address(bridge)), 10e18);
        assertEq(tao.balanceOf(address(fd)), 0);
        assertEq(tao.allowance(address(fd), address(bridge)), 0);
        // the pot's 1e14 first, then 9e14 of carol's 1e15; carol gets the unused 1e14 back: net -9e14
        assertEq(carol.balance, 1 ether - 9e14);

        (uint64 id, uint64 start, uint256 total, uint256 pot, uint256 nD, uint256 nR) = fd.openBatch();
        assertEq(id, 2);
        assertEq(start, vm.getBlockTimestamp());
        assertEq(total, 0);
        assertEq(pot, 0);
        assertEq(nD, 0);
        assertEq(nR, 0);
        assertEq(fd.depositOf(alice), 0);
        assertEq(fd.redeemOf(bob), 0);
        assertEq(fd.netForwarded(), 10e18);
        assertEq(address(fd).balance, 0);
    }

    /// v3.1 paid the pot's remainder to the closer; v3.2 carries it into the next batch's pot (L-7).
    function test_closeBatchPotCoversFeeRemainderCarried() public {
        bridge.setFee(5e13);
        requestWithFee(alice, 1e24); // pot 1e14
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.BatchClosed(1, 0, 0, 1, 5e13, 5e13, 5e13);
        vm.prank(carol);
        fd.closeBatch(1, 0);

        // the pot 1e14 pays the 5e13 fee; the 5e13 left is batch 2's, not carol's
        assertEq(carol.balance, 1 ether);
        assertEq(bridge.lastValue(), 5e13);
        assertEq(openPot(), 5e13);
        assertEq(fd.potCarried(), 5e13);
        assertEq(address(fd).balance, 5e13);
        assertEthIdentity();
    }

    function test_closeBatchInsufficientFeeReverts() public {
        dep(alice, 10e18);
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        vm.prank(carol);
        vm.expectRevert(CascadeFrontDoor.InsufficientFee.selector);
        fd.closeBatch{value: 1e15 - 1}(1, 0);
        assertEq(openId(), 1);
        assertEq(openTotal(), 10e18);

        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, 0);
        assertEq(openId(), 2);
        assertEq(carol.balance, 1 ether - 1e15);
    }

    function test_closeBatchEmptyRollsAndRefunds() public {
        uint256 t1 = vm.getBlockTimestamp() + 12 hours;
        Schedule.warpTo(t1);

        // a closer that cannot take the refund fails the roll (this test contract has no receive)
        vm.expectRevert(CascadeFrontDoor.TransferFailed.selector);
        fd.closeBatch{value: 7}(1, 0);

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.BatchRolled(1);
        vm.prank(carol);
        fd.closeBatch{value: 7}(1, 0);

        (uint64 id, uint64 start,,,,) = fd.openBatch();
        assertEq(id, 1);
        assertEq(start, t1);
        assertEq(carol.balance, 1 ether);
        assertEq(address(fd).balance, 0);
        assertEq(bridge.sendCount(), 0);

        // the timer restarted
        vm.prank(carol);
        vm.expectRevert(CascadeFrontDoor.BatchNotReady.selector);
        fd.closeBatch(1, 0);
    }

    function test_closeBatchEarlyWhenRedeemListFull() public {
        vm.prank(owner);
        fd.setBatchLimits(50, 2);
        requestWithFee(alice, 1e24);
        assertFalse(fd.canClose());
        requestWithFee(bob, 2e24);
        assertTrue(fd.canClose());

        // pot 2e14 + 8e14 = 1e15, exactly the fee
        vm.prank(carol);
        fd.closeBatch{value: 8e14}(1, 0);
        assertEq(openId(), 2);
        CascadeMessages.Entry[] memory r = new CascadeMessages.Entry[](2);
        r[0] = CascadeMessages.Entry(alice, 1e24);
        r[1] = CascadeMessages.Entry(bob, 2e24);
        assertEq(bridge.lastMessage(), CascadeMessages.encodeBatch(1, noEntries(), r));
        assertEq(carol.balance, 1 ether - 8e14);
    }

    function test_closeBatchEarlyWhenFilledExactlyWithTheLeastMinimum() public {
        vm.prank(owner);
        fd.setCaps(0.03e18, 10_000e18);
        tao.mint(alice, 3_000e18);
        dep(alice, 3_999e18);
        // 1e18 of room left, room for a minimum deposit, but at least half the batch value: closable already (the half
        // rule, R7; before it this batch waited)
        assertTrue(fd.canClose());
        dep(alice, 1e18);
        // exactly maxBatchValue 4_000e18: full before the interval
        assertEq(openTotal(), 4_000e18);
        assertTrue(fd.canClose());

        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, 4_000e18);
        assertEq(bridge.lastAmount(), 4_000e18);
        assertEq(openId(), 2);
    }

    /// Under half the 4,000 TAO limit (1,500 TAO: the half rule of R7 not met) the batch waits; the owner lowers the
    /// limit to 1,000 TAO, below what the batch holds, and it is full by value, closable at once. (Before R7 the pin
    /// deposited 3,000 TAO, which the half rule now closes before the lowering.)
    function test_closeBatchAfterMaxBatchValueLoweredBelowTotal() public {
        tao.mint(alice, 500e18);
        dep(alice, 1_500e18);
        assertFalse(fd.canClose());

        vm.prank(owner);
        fd.setMaxBatchValue(1_000e18);
        // 1_500e18 >= 1_000e18: full by value
        assertTrue(fd.canClose());
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.BatchValueFull.selector);
        fd.deposit(1e18);

        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, 1_500e18);
        assertEq(bridge.lastAmount(), 1_500e18);
        assertEq(openId(), 2);
        assertEq(fd.netForwarded(), 1_500e18);
    }

    function test_closeBatchRedeemOnlyBatchSendsZeroAmount() public {
        requestWithFee(alice, 1e24);
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.BatchClosed(1, 0, 0, 1, 1e15, 1e14, 0);
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, 0);

        assertEq(bridge.lastAmount(), 0);
        assertEq(bridge.lastValue(), 1e15);
        bytes memory message = bridge.lastMessage();
        assertEq(message, CascadeMessages.encodeBatch(1, noEntries(), entries1(alice, 1e24)));
        (uint64 batchId, CascadeMessages.Entry[] memory d, CascadeMessages.Entry[] memory r) =
            CascadeMessages.decodeBatch(message);
        assertEq(batchId, 1);
        assertEq(d.length, 0);
        assertEq(r.length, 1);
        assertEq(tao.balanceOf(address(bridge)), 0);
        assertEq(tao.allowance(address(fd), address(bridge)), 0);
        assertEq(fd.netForwarded(), 0);
        // the pot's 1e14, then 9e14 of carol's 1e15; carol gets the unused 1e14 back
        assertEq(carol.balance, 1 ether - 9e14);
    }

    function test_closeBatchPrimaryDisabledReverts() public {
        dep(alice, 10e18);
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        vm.prank(guardian);
        fd.disableBridge(address(bridge));

        vm.prank(carol);
        vm.expectRevert(PrimaryBridgeDisabled.selector);
        fd.closeBatch{value: 1e15}(1, 0);
        assertEq(openId(), 1);

        vm.prank(alice);
        fd.cancelDeposit(10e18);
        assertEq(tao.balanceOf(alice), 1_000e18);
    }

    /// A pause never stops a close (spec §3.5, I-20): the batch, its redeems with it, leaves on time.
    function test_closeBatchWorksWhilePaused() public {
        dep(alice, 10e18);
        requestWithFee(bob, 1e24);
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        pauseFd();
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, 10e18);
        assertTrue(fd.paused());
        assertEq(openId(), 2);
        assertEq(bridge.sendCount(), 1);
        assertEq(bridge.lastAmount(), 10e18);
        assertEq(bridge.lastMessage(), CascadeMessages.encodeBatch(1, entries1(alice, 10e18), entries1(bob, 1e24)));
        assertEq(fd.netForwarded(), 10e18);
        // the pot's 1e14 and 9e14 of carol's 1e15; the unused 1e14 back
        assertEq(carol.balance, 1 ether - 9e14);
    }

    // ---- self-closing requests ----

    function test_requestRedeemSelfClosesFullBatch() public {
        bridge.setFee(2e14);
        vm.prank(owner);
        fd.setBatchLimits(50, 3);
        fillRedeems(fd, 3); // pot 3e14

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.BatchClosed(1, 0, 0, 3, 2e14, 2e14, 1e14);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.RedeemRequested(2, alice, 1e24);
        vm.prank(alice);
        fd.requestRedeem{value: 1e14}(1e24);

        // the pot's 3e14 pays the 2e14 fee and carries 1e14 into batch 2 (v3.1 paid it to alice); alice paid her
        // own 1e14 fee, into batch 2's pot
        assertEq(alice.balance, 1 ether - 1e14);
        assertEq(bridge.lastValue(), 2e14);
        assertEq(bridge.sendCount(), 1);
        (, CascadeMessages.Entry[] memory d, CascadeMessages.Entry[] memory r) =
            CascadeMessages.decodeBatch(bridge.lastMessage());
        assertEq(d.length, 0);
        assertEq(r.length, 3);

        (uint64 id,,, uint256 pot,, uint256 nR) = fd.openBatch();
        assertEq(id, 2);
        assertEq(pot, 2e14);
        assertEq(fd.potCarried(), 1e14);
        assertEq(nR, 1);
        assertEq(fd.redeemOf(alice), 1e24);
        assertEq(address(fd).balance, 2e14);
    }

    function test_requestRedeemSelfCloseInsufficientPotReverts() public {
        vm.prank(owner);
        fd.setBatchLimits(50, 3);
        fillRedeems(fd, 3); // pot 3e14 < fee 1e15

        // msg.value is excluded from the close budget
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.InsufficientFee.selector);
        fd.requestRedeem{value: 1e14}(1e24);
        (uint64 id,,, uint256 pot,, uint256 nR) = fd.openBatch();
        assertEq(id, 1);
        assertEq(pot, 3e14);
        assertEq(nR, 3);

        // anyone can top up the close; then the request lands in batch 2
        vm.prank(carol);
        fd.closeBatch{value: 7e14}(1, 0);
        requestWithFee(alice, 1e24);
        assertEq(openId(), 2);
        assertEq(fd.redeemOf(alice), 1e24);
    }

    // ---- ETH accounting ----

    function test_ethIdentityHolds() public {
        vm.prank(bob);
        fd.creditRedeemFee{value: 3e14}(alice);
        assertEthIdentity();
        assertEq(address(fd).balance, 3e14);

        requestWithFee(bob, 1e24); // pot 1e14
        assertEthIdentity();
        vm.prank(alice);
        fd.requestRedeem(2e24); // credit 2e14, pot 2e14
        assertEthIdentity();
        requestWithFee(carol, 1e24); // pot 3e14
        vm.prank(carol);
        fd.cancelRedeem(1e24);
        assertEthIdentity();
        assertEq(address(fd).balance, 5e14);

        dep(alice, 10e18);
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, 10e18); // the pot's 3e14, then 7e14 of carol's 1e15: carol +3e14
        assertEthIdentity();
        assertEq(address(fd).balance, 2e14);
        assertEq(carol.balance, 1 ether - 1e14 - 1e15 + 3e14);

        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        vm.prank(carol);
        fd.closeBatch{value: 5}(2, 0); // empty: rolls and refunds
        assertEthIdentity();

        vm.prank(alice);
        fd.requestRedeem(1e24); // credit 1e14, pot 1e14
        assertEthIdentity();
        assertEq(address(fd).balance, 2e14);
        assertEq(fd.totalFeeCredit(), 1e14);
        assertEq(openPot(), 1e14);
    }

    // ---- close by id, the pot rolled forward (v3.2, Task 29, spec §3.5) ----

    /// A close names the batch it means: any other id reverts `WrongBatch(open.id)` before every other check
    /// (before `BatchNotReady`, the roll and `BatchTooSmall`), so a closer whose batch already left never pays
    /// for the next one, and a stale id never rolls an empty batch.
    function test_staleId() public {
        dep(alice, 10e18);
        // not due yet: the wrong id is refused first, naming the open one
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(CascadeFrontDoor.WrongBatch.selector, uint64(1)));
        fd.closeBatch{value: 1e15}(2, 0);
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(CascadeFrontDoor.WrongBatch.selector, uint64(1)));
        fd.closeBatch{value: 1e15}(0, 0);
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, 10e18);
        assertEq(openId(), 2);
        assertEq(bridge.sendCount(), 1);

        // batch 1 is now stale, though batch 2 is due and has a deposit, and with a minimum it would meet
        dep(bob, 5e18);
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        assertTrue(fd.canClose());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CascadeFrontDoor.WrongBatch.selector, uint64(2)));
        fd.closeBatch{value: 1e15}(1, 5e18);
        // and before a roll: batch 2 emptied still refuses the stale id, and rolls only on its own
        vm.prank(bob);
        fd.cancelDeposit(5e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CascadeFrontDoor.WrongBatch.selector, uint64(2)));
        fd.closeBatch{value: 1e15}(1, 0);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.BatchRolled(2);
        vm.prank(alice);
        fd.closeBatch{value: 1e15}(2, 0);
        assertEq(bridge.sendCount(), 1);
        assertEq(alice.balance, 1 ether);
        assertEthIdentity();
    }

    /// `minValue` is the least the closer will pay to send: a batch whose deposits total less reverts
    /// `BatchTooSmall()`, after `WrongBatch` and `BatchNotReady`, so a cancel between the closer's read and its
    /// close cannot make it pay for a smaller batch. At exactly `minValue` it closes; a redeem-only batch totals 0.
    function test_minValue() public {
        dep(alice, 10e18);
        // not due: BatchNotReady comes first
        vm.prank(carol);
        vm.expectRevert(CascadeFrontDoor.BatchNotReady.selector);
        fd.closeBatch{value: 1e15}(1, 10e18 + 1);
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        // a stale id comes first too
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(CascadeFrontDoor.WrongBatch.selector, uint64(1)));
        fd.closeBatch{value: 1e15}(2, 10e18 + 1);
        vm.prank(carol);
        vm.expectRevert(CascadeFrontDoor.BatchTooSmall.selector);
        fd.closeBatch{value: 1e15}(1, 10e18 + 1);

        // alice cancels most of hers before the closer's call lands: the closer's minimum refuses the rest
        vm.prank(alice);
        fd.cancelDeposit(9e18);
        vm.prank(carol);
        vm.expectRevert(CascadeFrontDoor.BatchTooSmall.selector);
        fd.closeBatch{value: 1e15}(1, 10e18);
        assertEq(openId(), 1);
        assertEq(bridge.sendCount(), 0);
        assertEq(carol.balance, 1 ether);

        // exactly minValue closes
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, 1e18);
        assertEq(openId(), 2);
        assertEq(bridge.lastAmount(), 1e18);

        // a redeem-only batch: any minimum above 0 refuses it, 0 sends it
        requestWithFee(bob, 1e24);
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        vm.prank(carol);
        vm.expectRevert(CascadeFrontDoor.BatchTooSmall.selector);
        fd.closeBatch{value: 1e15}(2, 1);
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(2, 0);
        assertEq(openId(), 3);
        assertEq(bridge.sendCount(), 2);
    }

    /// An empty batch's close is a roll whatever `minValue` asks: the roll comes before `BatchTooSmall`, so the
    /// timer restarts, the id stays, `msg.value` comes back and nothing is sent. A pot the batch kept from a
    /// cancelled request stays in it.
    function test_emptyRollIgnoresMinValue() public {
        uint256 t1 = vm.getBlockTimestamp() + 12 hours;
        Schedule.warpTo(t1);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.BatchRolled(1);
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, type(uint256).max);
        (uint64 id, uint64 start,,,,) = fd.openBatch();
        assertEq(id, 1);
        assertEq(start, t1);
        assertEq(carol.balance, 1 ether);
        assertEq(address(fd).balance, 0);
        assertEq(bridge.sendCount(), 0);

        // emptied by its cancels: still a roll, the cancelled request's fee kept in the pot
        requestWithFee(bob, 1e24);
        vm.prank(bob);
        fd.cancelRedeem(1e24);
        dep(alice, 5e18);
        waitCancel(alice);
        vm.prank(alice);
        fd.cancelDeposit(5e18);
        Schedule.warpTo(t1 + 12 hours);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.BatchRolled(1);
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, 5e18);
        assertEq(openId(), 1);
        assertEq(openPot(), 1e14);
        assertEq(fd.potCarried(), 0);
        assertEq(carol.balance, 1 ether);
        assertEq(bridge.sendCount(), 0);
        assertEthIdentity();
    }

    /// L-7: a close spends the pot first and the closer's value only for what the pot lacks. The pot's remainder
    /// rolls into the next batch's pot (`potCarried`, `BatchClosed`'s last field): nothing to the closer, nothing to
    /// a self-closing requester, nothing to the treasury. A later close spends the carried part with that batch's
    /// own fees.
    function test_potCarriedNothingToCallerOrTreasury() public {
        address t = fd.treasury();
        bridge.setFee(2e14);
        fillRedeems(fd, 5); // pot 5e14
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.BatchClosed(1, 0, 0, 5, 2e14, 2e14, 3e14);
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, 0);
        // carol's value was not needed: all of it comes back, and none of the pot
        assertEq(carol.balance, 1 ether);
        assertEq(t.balance, 0);
        assertEq(bridge.lastValue(), 2e14);
        assertEq(openPot(), 3e14);
        assertEq(fd.potCarried(), 3e14);
        assertEq(address(fd).balance, 3e14);
        assertEthIdentity();

        // a self-close: the carried 3e14 and batch 2's own 2e14 pay 2e14 and carry 3e14 again; alice, whose
        // request closed it, gets nothing back and pays her own fee into batch 3
        vm.prank(owner);
        fd.setBatchLimits(50, 2);
        fillRedeems(fd, 2);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.BatchClosed(2, 0, 0, 2, 2e14, 2e14, 3e14);
        vm.prank(alice);
        fd.requestRedeem{value: 1e14}(1e24);
        assertEq(alice.balance, 1 ether - 1e14);
        assertEq(t.balance, 0);
        assertEq(openId(), 3);
        assertEq(fd.potCarried(), 3e14);
        assertEq(openPot(), 4e14);
        assertEq(address(fd).balance, 4e14);
        assertEthIdentity();
    }

    /// L-7: no close calls the treasury, so one that refuses ETH cannot block the requester whose request
    /// closes a full batch; it can only refuse its own sweep, which then reverts whole (`TransferFailed`): the pot
    /// and `potCarried` as they were, nothing stranded, and the next self-close still works.
    function test_revertingTreasuryAndASelfClose() public {
        CascadeFrontDoor.Params memory p = frontDoorParams();
        p.treasury = address(new RefusingPotTreasury());
        p.maxRedeems = 3;
        CascadeFrontDoor d = new CascadeFrontDoor(p);
        bridge.setFee(2e14);
        fillRedeems(d, 3); // pot 3e14

        // the fourth request closes batch 1 on the pot alone: 2e14 paid, 1e14 carried, the treasury not called
        vm.prank(alice);
        d.requestRedeem{value: 1e14}(1e24);
        (uint64 id,,, uint256 pot,, uint256 nR) = d.openBatch();
        assertEq(id, 2);
        assertEq(pot, 2e14);
        assertEq(nR, 1);
        assertEq(d.potCarried(), 1e14);
        assertEq(bridge.sendCount(), 1);
        assertEq(alice.balance, 1 ether - 1e14);

        // the treasury refuses its sweep: the whole sweep reverts, and nothing moves
        vm.prank(owner);
        vm.expectRevert(CascadeFrontDoor.TransferFailed.selector);
        d.sweepPot(1e14);
        (,,, pot,,) = d.openBatch();
        assertEq(pot, 2e14);
        assertEq(d.potCarried(), 1e14);
        assertEq(address(d).balance, 2e14);

        // batch 2 fills (pot 1e14 carried + 3e14) and the next request closes it too
        fillRedeems(d, 2);
        vm.prank(bob);
        d.requestRedeem{value: 1e14}(1e24);
        (id,,, pot,, nR) = d.openBatch();
        assertEq(id, 3);
        assertEq(d.potCarried(), 2e14);
        assertEq(pot, 3e14);
        assertEq(bridge.sendCount(), 2);
        assertEq(address(d).balance, pot + d.totalFeeCredit());
    }

    /// A pot still short makes the self-closing request revert `InsufficientFee`; the full batch can close at
    /// once, so the requester closes it with a top-up, getting back what the pot did not need of it (a carried
    /// remainder counts in the pot), and requests again, landing in the next batch.
    function test_shortPotThenATopUpCloseAndTheRequest() public {
        vm.prank(owner);
        fd.setBatchLimits(50, 3);
        // batch 1 carries 1e14: its pot of 3e14 against a 2e14 fee
        bridge.setFee(2e14);
        fillRedeems(fd, 3);
        vm.prank(carol);
        fd.closeBatch(1, 0);
        assertEq(fd.potCarried(), 1e14);
        assertEq(carol.balance, 1 ether);

        // batch 2 filled by junk: 1e14 carried + 3e14 = 4e14, short of a 1e15 fee
        bridge.setFee(1e15);
        fillRedeems(fd, 3);
        assertTrue(fd.canClose());
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.InsufficientFee.selector);
        fd.requestRedeem{value: 1e14}(1e24);
        (uint64 id,,, uint256 pot,, uint256 nR) = fd.openBatch();
        assertEq(id, 2);
        assertEq(pot, 4e14);
        assertEq(nR, 3);
        assertEq(alice.balance, 1 ether);

        // alice tops it up: the pot's 4e14 first, then 6e14 of her 1e15, the unused 4e14 back
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.BatchClosed(2, 0, 0, 3, 1e15, 4e14, 0);
        vm.prank(alice);
        fd.closeBatch{value: 1e15}(2, 0);
        assertEq(alice.balance, 1 ether - 6e14);
        assertEq(fd.potCarried(), 0);
        assertEq(openPot(), 0);

        // and her request lands in batch 3
        requestWithFee(alice, 1e24);
        assertEq(openId(), 3);
        assertEq(fd.redeemOf(alice), 1e24);
        assertEq(alice.balance, 1 ether - 7e14);
        assertEthIdentity();
    }

    /// `sweepPot` is the owner's and sends the immutable treasury at most `potCarried`, the remainder carried at
    /// the last close and still in the pot: never the open batch's own request fees, which pay for its close, and
    /// never the pre-paid credits (round 6, Info 2). Each close sets the bound anew.
    function test_sweepPotBoundedByCarried() public {
        address t = fd.treasury();
        bridge.setFee(2e14);
        vm.prank(bob);
        fd.creditRedeemFee{value: 5e14}(carol);
        fillRedeems(fd, 5); // pot 5e14
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        vm.prank(carol);
        fd.closeBatch(1, 0); // 2e14 paid, 3e14 carried
        fillRedeems(fd, 2); // batch 2's own fees: the pot is 3e14 carried + 2e14
        assertEq(openPot(), 5e14);
        assertEq(fd.potCarried(), 3e14);

        // the owner's alone
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        fd.sweepPot(1);
        // one wei above potCarried is refused, though the pot holds more and the credits more still
        vm.prank(owner);
        vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
        fd.sweepPot(3e14 + 1);

        // part, then the rest
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.PotSwept(1e14);
        vm.prank(owner);
        fd.sweepPot(1e14);
        assertEq(t.balance, 1e14);
        assertEq(fd.potCarried(), 2e14);
        assertEq(openPot(), 4e14);
        assertEthIdentity();
        vm.prank(owner);
        fd.sweepPot(2e14);
        assertEq(t.balance, 3e14);
        assertEq(fd.potCarried(), 0);
        assertEq(openPot(), 2e14);

        // nothing carried is left: batch 2's own 2e14 and carol's 5e14 of credit stay
        vm.prank(owner);
        vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
        fd.sweepPot(1);
        assertEq(fd.totalFeeCredit(), 5e14);
        assertEq(address(fd).balance, 7e14);
        assertEthIdentity();

        // batch 2's own fees pay its close (2e14 against 2e14: nothing carried, nothing to sweep); batch 3's
        // remainder is the new bound
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        vm.prank(carol);
        fd.closeBatch(2, 0);
        assertEq(fd.potCarried(), 0);
        vm.prank(owner);
        vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
        fd.sweepPot(1);
        bridge.setFee(1e14);
        fillRedeems(fd, 3);
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        vm.prank(carol);
        fd.closeBatch(3, 0); // 3e14 against 1e14: 2e14 carried
        assertEq(fd.potCarried(), 2e14);
        vm.prank(owner);
        vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
        fd.sweepPot(2e14 + 1);
        vm.prank(owner);
        fd.sweepPot(2e14);
        assertEq(t.balance, 5e14);
        assertEq(address(fd).balance, 5e14);
        assertEthIdentity();
    }

    /// `sweepPot(0)` is allowed (the ruling of Revision 22): it succeeds and logs `PotSwept(0)`, and moves nothing:
    /// no wei to the treasury or out of the door, the pot, `potCarried` and the credits as they were. With
    /// nothing carried too.
    function test_sweepPotZeroMovesNothing() public {
        address t = fd.treasury();
        vm.prank(owner);
        fd.sweepPot(0);
        assertEq(fd.potCarried(), 0);

        bridge.setFee(2e14);
        vm.prank(bob);
        fd.creditRedeemFee{value: 5e14}(carol);
        fillRedeems(fd, 5); // pot 5e14
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        vm.prank(carol);
        fd.closeBatch(1, 0); // 3e14 carried
        fillRedeems(fd, 1); // batch 2's own 1e14

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.PotSwept(0);
        vm.prank(owner);
        fd.sweepPot(0);
        assertEq(fd.potCarried(), 3e14);
        assertEq(openPot(), 4e14);
        assertEq(fd.totalFeeCredit(), 5e14);
        assertEq(address(fd).balance, 9e14);
        assertEq(t.balance, 0);
        assertEthIdentity();
    }

    /// A treasury that re-enters from its payment is refused at both doors in: `closeBatch` by the lock
    /// (`ReentrancyGuardReentrantCall`), and `sweepPot` by `onlyOwner` when the treasury is not the owner, as
    /// deployed, or by the lock when it is. A treasury that swallows the refusals lets the outer sweep complete,
    /// with the accounting exact: what it swept, out of `potCarried` and the pot, I-18 holding.
    function test_aReenteringTreasuryIsRefusedAndTheSweepCompletes() public {
        // the treasury is not the owner
        ReentrantPotTreasury t = new ReentrantPotTreasury();
        CascadeFrontDoor.Params memory p = frontDoorParams();
        p.treasury = address(t);
        CascadeFrontDoor d = new CascadeFrontDoor(p);
        t.setDoor(d);
        carryOn(d, 1); // 3e14 carried, batch 2 open
        vm.prank(owner);
        d.sweepPot(2e14);
        assertEq(t.reentries(), 1);
        assertEq(t.sweepRefusal(), abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(t)));
        assertEq(t.closeRefusal(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        assertSwept(d, address(t), 2e14, 1e14);

        // the treasury is the owner too, so only the lock stands in the sweep's way
        ReentrantPotTreasury t2 = new ReentrantPotTreasury();
        p = frontDoorParams();
        p.owner = address(t2);
        p.treasury = address(t2);
        CascadeFrontDoor d2 = new CascadeFrontDoor(p);
        t2.setDoor(d2);
        carryOn(d2, 1);
        t2.sweep(2e14);
        assertEq(t2.reentries(), 1);
        assertEq(t2.sweepRefusal(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        assertEq(t2.closeRefusal(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        assertSwept(d2, address(t2), 2e14, 1e14);
    }

    /// A treasury whose re-entry refusal escapes its `receive` refuses its own payment, so the whole sweep reverts
    /// `TransferFailed` and nothing moves: the pot, `potCarried` and the treasury as they were.
    function test_aReenteringTreasuryThatBubblesRevertsTheWholeSweep() public {
        ReentrantPotTreasury t = new ReentrantPotTreasury();
        CascadeFrontDoor.Params memory p = frontDoorParams();
        p.owner = address(t);
        p.treasury = address(t);
        CascadeFrontDoor d = new CascadeFrontDoor(p);
        t.setDoor(d);
        t.setBubble(true);
        carryOn(d, 1);
        vm.expectRevert(CascadeFrontDoor.TransferFailed.selector);
        t.sweep(2e14);
        assertEq(t.reentries(), 0);
        assertEq(d.potCarried(), 3e14);
        (,,, uint256 pot,,) = d.openBatch();
        assertEq(pot, 4e14);
        assertEq(address(d).balance, 4e14);
        assertEq(address(t).balance, 0);
    }

    /// Batch 1 of `d` closed with a remainder: 5 requests (pot 5e14) against a 2e14 fee, so 3e14 is carried into
    /// batch 2, which then takes `own` requests of its own.
    function carryOn(CascadeFrontDoor d, uint256 own) internal {
        bridge.setFee(2e14);
        fillRedeems(d, 5);
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        vm.prank(carol);
        d.closeBatch(1, 0);
        fillRedeems(d, own);
        assertEq(d.potCarried(), 3e14);
    }

    /// After a sweep of `swept` from a 3e14 remainder with `own` of batch 2's fees beside it (carryOn): the treasury
    /// got exactly `swept`, `potCarried` and the pot fell by it, and the door's ETH is its pot (I-18, no credits).
    function assertSwept(CascadeFrontDoor d, address t, uint256 swept, uint256 own) internal view {
        assertEq(t.balance, swept);
        assertEq(d.potCarried(), 3e14 - swept);
        (,,, uint256 pot,,) = d.openBatch();
        assertEq(pot, 3e14 - swept + own);
        assertEq(address(d).balance, pot + d.totalFeeCredit());
    }

    /// The room rule, back (R6b U4; the founder reversed decision 6): a batch with room for no minimum deposit is
    /// closable at once. v3.1 dropped it as "a free grief" while a close paid its closer the pot's surplus; since v3.2
    /// the pot's remainder rolls forward (a closer never gains, I-21) and `minValue` protects the closer from a cancel
    /// landing first, so an early close only forwards the deposits. Without it one address could hold every batch just
    /// under its limit and cancel before each close (the multi-agent review's U4). 0.5 TAO of room under the 4,000 TAO
    /// limit, below the 1 TAO minimum: no deposit fits, and anyone closes at once.
    function test_aBatchWithNoRoomForAMinimumDepositClosesAtOnce() public {
        tao.mint(alice, 3_000e18);
        dep(alice, 3_999.5e18);
        assertTrue(fd.canClose(), "no room for a minimum deposit: closable at once");
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.BatchValueFull.selector);
        fd.deposit(1e18);
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, 3_999.5e18);
        assertEq(bridge.lastAmount(), 3_999.5e18);
        assertEq(openId(), 2);
    }

    /// U4's hold: a deposit of the value limit less a minimum deposit plus a rao refuses every honest deposit
    /// (BatchValueFull). Before R6b the batch then waited for its interval and the holder cancelled just before each
    /// close, every batch; now it is closable at once, and anyone's close (the keeper's) commits the holder's deposit.
    function test_aDepositHeldJustUnderTheValueLimitIsClosedAtOnce() public {
        uint256 hold = fd.maxBatchValue() - fd.minDeposit() + 1e9;
        tao.mint(alice, hold);
        dep(alice, hold);
        uint256 min = fd.minDeposit();
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.BatchValueFull.selector);
        fd.deposit(min);
        assertTrue(fd.canClose(), "closable at once");
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, hold);
        assertEq(bridge.lastAmount(), hold, "the holder's deposit committed");
        assertEq(openId(), 2);
    }

    /// The same under the deposit cap: with netForwarded and the open batch within a minimum deposit of depositCap, no
    /// deposit fits (CapExceeded), and the batch is closable at once.
    function test_aBatchWithNoRoomUnderTheDepositCapClosesAtOnce() public {
        dep(alice, 10e18);
        uint256 min = fd.minDeposit();
        uint256 cap = fd.netForwarded() + 10e18 + min / 2;
        vm.prank(owner);
        fd.setCaps(min, cap);
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.CapExceeded.selector);
        fd.deposit(min);
        assertTrue(fd.canClose(), "no room under the cap: closable at once");
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, 10e18);
        assertEq(bridge.lastAmount(), 10e18);
        assertEq(openId(), 2);
    }

    /// An honest batch under half its value limit and under half the room left under the cap still waits for its
    /// interval (or a full list): at half the limit less a rao it is not closable; the timer opens it. (Until R7 this
    /// pin filled the batch to room for exactly one minimum deposit, which the room rule alone left waiting: the
    /// exact-room hold, Low-1 of the R6b review; under the half rule that batch is closable at once.)
    function test_aBatchUnderHalfItsLimitsWaitsForItsInterval() public {
        uint256 t0 = vm.getBlockTimestamp();
        dep(alice, 100e18);
        assertFalse(fd.canClose());
        vm.prank(carol);
        vm.expectRevert(CascadeFrontDoor.BatchNotReady.selector);
        fd.closeBatch{value: 1e15}(1, 0);
        uint256 more = fd.maxBatchValue() / 2 - 100e18 - 1e9;
        tao.mint(bob, more);
        dep(bob, more);
        assertFalse(fd.canClose(), "half the batch value less a rao: it waits");
        Schedule.warpTo(t0 + 12 hours);
        assertTrue(fd.canClose(), "the timer opens it");
    }

    /// The launch's batch value and minimum deposit (Appendix B: 10 TAO and 0.04 TAO), both immediate tightenings of
    /// the fixture's; the cap stays the fixture's 10,000 TAO.
    function launchValueAndMinimum() internal {
        vm.startPrank(owner);
        fd.setMaxBatchValue(10e18);
        fd.setCaps(0.04e18, fd.depositCap());
        vm.stopPrank();
    }

    /// Low-1 of the R6b review, the exact-room hold: a holder leaves room for exactly one minimum deposit (9.96 of the
    /// launch's 10 TAO, at its 0.04 TAO minimum). The room rule alone left that batch waiting while every honest
    /// deposit above 0.04 reverted BatchValueFull, and the holder cancelled each 0.04 that landed, then everything
    /// before the interval. Under the half rule (R7) a batch holding at least half its value limit is closable at
    /// once, so anyone's close (the keeper's) commits the holder's deposit.
    function test_anExactRoomHoldIsClosableAtOnce() public {
        launchValueAndMinimum();
        uint256 hold = fd.maxBatchValue() - fd.minDeposit();
        dep(alice, hold);
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.BatchValueFull.selector);
        fd.deposit(0.05e18);
        assertTrue(fd.canClose(), "at least half the batch value: closable at once");
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, hold);
        assertEq(bridge.lastAmount(), hold, "the holder's deposit committed");
        assertEq(openId(), 2);
    }

    /// The hold that is left under the half rule (R7, stated): a holder at half the value limit less a rao keeps the
    /// batch waiting, but honest deposits larger than the minimum fit, up to the room (half the limit and a rao), and
    /// the first one brings the batch to half, closable at once. To keep it waiting the holder must cancel as much as
    /// each honest deposit adds, so the honest deposits stay in the batch; only a deposit above about half a batch is
    /// refused. The holder's deposit has sat five minutes (R11), so its cancel goes at once.
    function test_aHoldJustUnderHalfTakesHonestDepositsAndTheFirstMakesItClosable() public {
        launchValueAndMinimum();
        uint256 hold = fd.maxBatchValue() / 2 - 1e9;
        dep(alice, hold);
        assertFalse(fd.canClose(), "half less a rao: it waits");
        waitCancel(alice);
        uint256 room = fd.maxBatchValue() - hold;
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.BatchValueFull.selector);
        fd.deposit(room + 1e9);

        uint256 before = vm.snapshotState();
        dep(bob, 1e18);
        assertTrue(fd.canClose(), "the honest deposit brings it to half: closable at once");
        // the holder cancels as much to hold it under half again: the honest deposit stays
        vm.prank(alice);
        fd.cancelDeposit(1e18);
        assertFalse(fd.canClose(), "back under half");
        assertEq(fd.depositOf(bob), 1e18, "the honest deposit landed and stays");
        // a deposit of the minimum brings it to half too
        dep(carol, fd.minDeposit());
        assertTrue(fd.canClose(), "a minimum deposit brings it to half");

        // the whole room fits in one honest deposit
        vm.revertToState(before);
        dep(bob, room);
        assertEq(openTotal(), fd.maxBatchValue());
        assertTrue(fd.canClose());
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, fd.maxBatchValue());
        assertEq(bridge.lastAmount(), 10e18);
    }

    /// Revision 34's hold between the keeper's rounds, closed by the cancel cooldown (R11): a holder deposits a full
    /// batch (the launch's 10 TAO) just after a keeper's round, so every honest deposit reverts BatchValueFull, and
    /// cannot cancel it for five minutes, at once or a second before the keeper's next round. That round, a minute
    /// later, finds the batch over the half rule's line and closes it with the holder's deposit: committed, no loss (it
    /// goes to the vault as any deposit does). Once the five minutes have passed there is nothing left to cancel, and
    /// the honest deposit lands in the next batch.
    function test_aFullBatchCannotBeFlappedBetweenTheKeepersRounds() public {
        launchValueAndMinimum();
        vm.deal(keeper, 1 ether);
        uint256 t0 = vm.getBlockTimestamp();
        uint256 full = fd.maxBatchValue();
        dep(alice, full);
        uint256 min = fd.minDeposit();
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.BatchValueFull.selector);
        fd.deposit(min);
        assertTrue(fd.canClose(), "a full batch: closable at once");
        bytes memory tooSoon = abi.encodeWithSelector(CancelTooSoon.selector, t0 + fd.CANCEL_COOLDOWN());
        vm.prank(alice);
        vm.expectRevert(tooSoon);
        fd.cancelDeposit(full);
        Schedule.warpTo(t0 + 59);
        vm.prank(alice);
        vm.expectRevert(tooSoon);
        fd.cancelDeposit(full);

        Schedule.warpTo(t0 + 1 minutes);
        vm.prank(keeper);
        fd.closeBatch{value: 1e15}(1, full);
        assertEq(
            bridge.lastMessage(),
            CascadeMessages.encodeBatch(1, entries1(alice, full), noEntries()),
            "the holder's deposit committed"
        );
        assertEq(bridge.lastAmount(), full);
        Schedule.warpTo(t0 + fd.CANCEL_COOLDOWN());
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.InsufficientRequest.selector);
        fd.cancelDeposit(full);
        assertEq(tao.balanceOf(alice), 1_000e18 - full);
        dep(bob, min);
        assertEq(fd.depositOf(bob), min, "the honest deposit lands in the next batch");
    }

    /// The keeper-voiding pattern (R12's review of the cooldown; the cure is the keeper's, off-chain, and this pin
    /// documents the contract's side). An aged entry of minDeposit plus a rao from one address, a fresh fill from a
    /// second to just under maxBatchValue (a rao of room, so no deposit fits; closable by the half rule), and the aged
    /// entry's one-rao cancel landing between the keeper's read and its close. A close naming the total it read as
    /// `minValue` reverts BatchTooSmall, so the fill would wait another round; the fill itself cannot be cancelled for
    /// five minutes, and a lenient `minValue` commits it. Hence the keeper passes a lenient `minValue` on a batch it
    /// closes early, and the "one round in five" bound of R11 holds only through closes that land.
    function test_anAgedOneRaoCancelVoidsAnExactMinValueButNotALenientOne() public {
        launchValueAndMinimum();
        vm.deal(keeper, 1 ether);
        uint256 min = fd.minDeposit();
        uint256 aged = min + 1e9;
        dep(alice, aged);
        Schedule.wait(fd.CANCEL_COOLDOWN());
        uint256 fill = fd.maxBatchValue() - aged - 1e9;
        dep(bob, fill);
        assertTrue(fd.canClose(), "the fill: closable at once");
        // the keeper reads the batch's total
        uint256 read = openTotal();
        assertEq(read, fd.maxBatchValue() - 1e9);
        // the aged entry's one-rao cancel lands first
        vm.prank(alice);
        fd.cancelDeposit(1e9);
        assertEq(fd.depositOf(alice), min, "the aged entry kept at the minimum");
        assertTrue(fd.canClose(), "still over half");
        vm.prank(keeper);
        vm.expectRevert(CascadeFrontDoor.BatchTooSmall.selector);
        fd.closeBatch{value: 1e15}(1, read);
        // the fill is fresh: its cancel waits five minutes
        bytes memory tooSoon =
            abi.encodeWithSelector(CancelTooSoon.selector, vm.getBlockTimestamp() + fd.CANCEL_COOLDOWN());
        vm.prank(bob);
        vm.expectRevert(tooSoon);
        fd.cancelDeposit(fill);
        // a lenient minimum commits it
        vm.prank(keeper);
        fd.closeBatch{value: 1e15}(1, 0);
        CascadeMessages.Entry[] memory sent = new CascadeMessages.Entry[](2);
        sent[0] = CascadeMessages.Entry(alice, min);
        sent[1] = CascadeMessages.Entry(bob, fill);
        assertEq(bridge.lastMessage(), CascadeMessages.encodeBatch(1, sent, noEntries()), "the fill committed");
        assertEq(bridge.lastAmount(), min + fill);
    }

    /// The same pattern against the deposit list's half rule (R12): an aged entry of minDeposit plus a rao, then 24
    /// fresh entries (25 of 50: closable), and the aged entry's one-rao cancel after the keeper's read, which leaves the
    /// list at 25 (a partial cancel keeps its entry). An exact `minValue` reverts BatchTooSmall; a lenient one commits
    /// all 25.
    function test_anAgedOneRaoCancelVoidsAnExactMinValueOnAHalfFullList() public {
        vm.deal(keeper, 1 ether);
        uint256 min = fd.minDeposit();
        dep(alice, min + 1e9);
        Schedule.wait(fd.CANCEL_COOLDOWN());
        fillDeposits(24);
        assertTrue(fd.canClose(), "25 of 50: closable at once");
        uint256 read = openTotal();
        vm.prank(alice);
        fd.cancelDeposit(1e9);
        (uint256 nD,) = openCounts();
        assertEq(nD, 25, "a partial cancel keeps the entry");
        assertTrue(fd.canClose(), "still half the list");
        vm.prank(keeper);
        vm.expectRevert(CascadeFrontDoor.BatchTooSmall.selector);
        fd.closeBatch{value: 1e15}(1, read);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.BatchClosed(1, read - 1e9, 25, 0, 1e15, 0, 0);
        vm.prank(keeper);
        fd.closeBatch{value: 1e15}(1, 0);
        assertEq(openId(), 2);
    }

    /// What the cooldown leaves (R11, stated): a holder that lifts the batch over half between two rounds must cancel
    /// back under it with deposits at least five minutes old, and they were in the batch, under half, at the earlier
    /// round. One address cannot: its top-up restarts its clock for the whole entry. With a second address the holder
    /// sits at half less a rao for five minutes (the keeper's round finds it waiting), the second address adds as much
    /// (all but two rao: every honest deposit refused) and the first cancels at once, back under half, so the next round
    /// finds it waiting again. It cannot repeat that in the next round: the batch is now the second address's fresh
    /// deposit, so a new lift stays for the keeper, who commits both. Over any five rounds such lifts add up to less
    /// than half a batch.
    function test_aLiftOverHalfCancelsOnlyAnOldDeposit() public {
        launchValueAndMinimum();
        vm.deal(keeper, 1 ether);
        uint256 cooldown = fd.CANCEL_COOLDOWN();
        uint256 half = fd.maxBatchValue() / 2 - 1e9;
        uint256 t0 = vm.getBlockTimestamp();
        dep(alice, half);
        Schedule.warpTo(t0 + cooldown);
        assertFalse(fd.canClose(), "the keeper's round finds half less a rao");
        uint256 snap = vm.snapshotState();
        dep(alice, half);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CancelTooSoon.selector, t0 + 2 * cooldown));
        fd.cancelDeposit(half);
        vm.revertToState(snap);

        dep(bob, half);
        uint256 min = fd.minDeposit();
        vm.prank(carol);
        vm.expectRevert(CascadeFrontDoor.BatchValueFull.selector);
        fd.deposit(min);
        assertTrue(fd.canClose(), "lifted over half");
        vm.prank(alice);
        fd.cancelDeposit(half);
        Schedule.warpTo(t0 + cooldown + 1 minutes);
        assertFalse(fd.canClose(), "the next round finds half less a rao again");

        dep(alice, half);
        assertTrue(fd.canClose(), "lifted over half again");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CancelTooSoon.selector, t0 + 2 * cooldown));
        fd.cancelDeposit(half);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CancelTooSoon.selector, t0 + 2 * cooldown + 1 minutes));
        fd.cancelDeposit(half);
        Schedule.warpTo(t0 + cooldown + 2 minutes);
        vm.prank(keeper);
        fd.closeBatch{value: 1e15}(1, 2 * half);
        CascadeMessages.Entry[] memory sent = new CascadeMessages.Entry[](2);
        sent[0] = CascadeMessages.Entry(bob, half);
        sent[1] = CascadeMessages.Entry(alice, half);
        assertEq(bridge.lastMessage(), CascadeMessages.encodeBatch(1, sent, noEntries()), "both committed");
    }

    /// `n` fresh depositors of the minimum each in the open batch, one entry each; returns the last of them.
    function fillDeposits(uint256 n) internal returns (address last) {
        uint256 min = fd.minDeposit();
        for (uint256 i; i < n; ++i) {
            last = makeAddr(string.concat("listFiller", vm.toString(++fillerCount)));
            tao.mint(last, min);
            vm.startPrank(last);
            tao.approve(address(fd), min);
            fd.deposit(min);
            vm.stopPrank();
        }
    }

    /// The deposit list's half rule (R12, Revision 36): a batch whose deposit list holds at least half its limit is
    /// closable at once (`2 x entries >= maxDeposits`), whatever its value. At the launch's 50, 24 entries wait and 25
    /// close; at an odd limit, 49, 24 wait (48 < 49) and 25 close (50 >= 49). Minimum deposits of 1 TAO keep every value
    /// clause far off (25 of 4,000 TAO), and the clock is far from the interval. The rule reads the list as it is, so a
    /// cancel back under half makes the batch wait again (no latch). Why: since the cooldown (R11) a list filled after a
    /// keeper's round holds at least 26 entries too young to cancel, so the next round closes it.
    function test_theDepositListsHalfIsTheEdge() public {
        uint256 snap = vm.snapshotState();
        fillDeposits(24);
        assertFalse(fd.canClose(), "24 of 50: it waits");
        vm.prank(carol);
        vm.expectRevert(CascadeFrontDoor.BatchNotReady.selector);
        fd.closeBatch{value: 1e15}(1, 0);
        fillDeposits(1);
        assertTrue(fd.canClose(), "25 of 50: half the list, closable at once");
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.BatchClosed(1, 25e18, 25, 0, 1e15, 0, 0);
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, 25e18);
        assertEq(bridge.lastAmount(), 25e18, "the 25 entries sent");
        assertEq(openId(), 2);

        vm.revertToState(snap);
        vm.prank(owner);
        fd.setBatchLimits(49, 50);
        fillDeposits(24);
        assertFalse(fd.canClose(), "24 of 49: it waits");
        address last = fillDeposits(1);
        assertTrue(fd.canClose(), "25 of 49: closable at once");
        Schedule.wait(fd.CANCEL_COOLDOWN());
        uint256 min = fd.minDeposit();
        vm.prank(last);
        fd.cancelDeposit(min);
        assertFalse(fd.canClose(), "back to 24: it waits again");
        fillDeposits(1);
        assertTrue(fd.canClose(), "25 again");
    }

    /// The redeem list stays at its full limit (R12): a request pays its fee into the pot, and a request meeting a full
    /// list closes the batch on that pot itself, so a list of fake requests pays its own close. 25 and 49 requests of 50
    /// wait; 50 close. At an odd limit, 49: 48 wait, 49 close.
    function test_aRedeemListStillClosesOnlyWhenFull() public {
        uint256 snap = vm.snapshotState();
        fillRedeems(fd, 25);
        assertFalse(fd.canClose(), "25 of 50 requests: it waits");
        fillRedeems(fd, 24);
        assertFalse(fd.canClose(), "49 of 50: it waits");
        fillRedeems(fd, 1);
        assertTrue(fd.canClose(), "50 of 50: full");

        vm.revertToState(snap);
        vm.prank(owner);
        fd.setBatchLimits(50, 49);
        fillRedeems(fd, 48);
        assertFalse(fd.canClose(), "48 of 49: it waits");
        fillRedeems(fd, 1);
        assertTrue(fd.canClose(), "49 of 49: full");
    }

    /// The value clause of the half rule at its edge: a batch holding exactly half of maxBatchValue (2,000 of 4,000
    /// TAO) is closable at once; a rao less waits (the room clause, at a 1 TAO minimum, is far from met).
    function test_halfTheBatchValueIsTheEdge() public {
        tao.mint(alice, 1_000e18);
        dep(alice, 2_000e18);
        assertTrue(fd.canClose(), "exactly half: closable at once");
        waitCancel(alice);
        vm.prank(alice);
        fd.cancelDeposit(1e9);
        assertFalse(fd.canClose(), "half less a rao: it waits");
    }

    /// The room clause at its edge: deposits plus minDeposit above maxBatchValue. 1,000 TAO in the batch under the
    /// 4,000 TAO limit (the half clause not met) and a 3,000 TAO minimum: 4,000 is not above 4,000, so it waits; a
    /// minimum a wei higher makes it closable at once. With the deposits cancelled the redeems left wait, a minimum above
    /// the batch value included (before R7 that minimum made every batch closable at once, with or without deposits).
    function test_theRoomClauseAtItsEdge() public {
        dep(alice, 1_000e18);
        requestWithFee(bob, 1e24);
        vm.startPrank(owner);
        fd.setCaps(3_000e18, 10_000e18);
        assertFalse(fd.canClose(), "1,000 + 3,000 is not above 4,000");
        fd.setCaps(3_000e18 + 1, 10_000e18);
        assertTrue(fd.canClose(), "a wei above: closable at once");
        vm.stopPrank();
        waitCancel(alice);
        vm.prank(alice);
        fd.cancelDeposit(1_000e18);
        vm.prank(owner);
        fd.setCaps(4_000e18 + 1, 10_000e18);
        assertFalse(fd.canClose(), "no deposits: the redeems wait");
    }

    /// The cap clause of the half rule at its edge: netForwarded plus twice the deposits at least depositCap. With 50
    /// TAO forwarded and a 250 TAO cap (200 TAO of room), 100 TAO in the batch is closable at once; a rao less waits
    /// (the cap's room clause, at a 1 TAO minimum, is far from met).
    function test_halfTheRoomUnderTheCapIsTheEdge() public {
        dep(carol, 50e18);
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, 50e18);
        assertEq(fd.netForwarded(), 50e18);
        vm.prank(owner);
        fd.setCaps(1e18, 250e18);
        dep(alice, 100e18);
        assertTrue(fd.canClose(), "half the room under the cap: closable at once");
        waitCancel(alice);
        vm.prank(alice);
        fd.cancelDeposit(1e9);
        assertFalse(fd.canClose(), "half the room less a rao: it waits");
    }

    /// The cap's room clause at its edge: netForwarded, deposits and minDeposit above depositCap. 100 TAO in the batch
    /// under a 1,000 TAO cap (the half clause not met) and a 900 TAO minimum: 1,000 is not above 1,000, so it waits; a
    /// minimum a wei higher makes it closable at once. With the deposits cancelled the redeems left wait, at a cap
    /// below the minimum too (before R7 such a cap made every batch closable at once).
    function test_theCapRoomClauseAtItsEdge() public {
        dep(alice, 100e18);
        requestWithFee(bob, 1e24);
        vm.startPrank(owner);
        fd.setCaps(900e18, 1_000e18);
        assertFalse(fd.canClose(), "100 + 900 is not above 1,000");
        fd.setCaps(900e18 + 1, 1_000e18);
        assertTrue(fd.canClose(), "a wei above: closable at once");
        vm.stopPrank();
        waitCancel(alice);
        vm.prank(alice);
        fd.cancelDeposit(100e18);
        vm.prank(owner);
        fd.setCaps(900e18 + 1, 900e18);
        assertFalse(fd.canClose(), "no deposits: the redeems wait");
    }

    /// Low-1's cap version: with 60 TAO forwarded and a 160 TAO cap, a holder's 99 TAO leaves room for exactly one 1
    /// TAO minimum, and every larger honest deposit reverts CapExceeded; the room rule alone left it waiting. Under the
    /// half rule it is closable at once. A holder at half the room less a rao keeps it waiting, but larger honest
    /// deposits fit up to the room, and the first makes it closable.
    function test_aCapHoldIsClosableAtOnceAndUnderHalfTakesHonestDeposits() public {
        dep(carol, 60e18);
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, 60e18);
        vm.prank(owner);
        fd.setCaps(1e18, 160e18);
        uint256 before = vm.snapshotState();

        dep(alice, 99e18);
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.CapExceeded.selector);
        fd.deposit(1e18 + 1e9);
        assertTrue(fd.canClose(), "the exact-room hold under the cap: closable at once");

        vm.revertToState(before);
        dep(alice, 50e18 - 1e9);
        assertFalse(fd.canClose(), "half the room less a rao: it waits");
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.CapExceeded.selector);
        fd.deposit(50e18 + 2e9);
        dep(bob, 2e18);
        assertTrue(fd.canClose(), "the honest deposit brings it past half: closable at once");
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(2, 52e18 - 1e9);
        assertEq(bridge.lastAmount(), 52e18 - 1e9, "both deposits sent");
    }

    /// Low-3 of the R6b review: at a filled deposit cap a batch with no deposits waits for its interval. The room
    /// rule's cap clause read netForwarded + minDeposit > depositCap with nothing in the batch, which stays true once
    /// the cap is filled, so anyone closed every redeem-only batch at once, each close drawing the pot for its bridge
    /// fee, and rolled every empty one. The value and cap clauses now apply only while the batch holds deposits; the
    /// same with the cap lowered below netForwarded (written without a subtraction, so nothing underflows).
    function test_aRedeemOnlyBatchAtAFilledCapWaitsForItsInterval() public {
        dep(alice, 100e18);
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, 100e18);
        assertEq(fd.netForwarded(), 100e18);
        vm.prank(owner);
        fd.setCaps(1e18, 100e18);
        uint256 t0 = vm.getBlockTimestamp();
        assertFalse(fd.canClose(), "an empty batch at the cap waits");
        vm.prank(carol);
        vm.expectRevert(CascadeFrontDoor.BatchNotReady.selector);
        fd.closeBatch(2, 0);

        requestWithFee(bob, 1e24);
        assertFalse(fd.canClose(), "redeems only, at the cap: it waits");
        vm.prank(carol);
        vm.expectRevert(CascadeFrontDoor.BatchNotReady.selector);
        fd.closeBatch{value: 1e15}(2, 0);
        vm.prank(owner);
        fd.setCaps(1e18, 50e18);
        assertFalse(fd.canClose(), "a cap below netForwarded: it waits");
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.CapExceeded.selector);
        fd.deposit(1e18);

        Schedule.warpTo(t0 + 12 hours);
        assertTrue(fd.canClose(), "the timer opens it");
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(2, 0);
        assertEq(openId(), 3);
    }

    /// Low-3's other two cases: at depositCap 0 (the wind-down's setCaps(minDeposit, 0)) and at a minimum deposit above
    /// the batch value, a batch of redeems alone waits for its interval; before R7 each made every such batch closable
    /// at once.
    function test_aRedeemOnlyBatchWaitsAtCapZeroAndAtAMinimumAboveTheBatchValue() public {
        uint256 t0 = vm.getBlockTimestamp();
        requestWithFee(bob, 1e24);
        vm.prank(owner);
        fd.setCaps(1e18, 0);
        assertFalse(fd.canClose(), "a cap of 0: it waits");
        vm.prank(owner);
        fd.setCaps(4_500e18, 10_000e18);
        assertFalse(fd.canClose(), "a minimum above the 4,000 TAO batch value: it waits");
        vm.prank(carol);
        vm.expectRevert(CascadeFrontDoor.BatchNotReady.selector);
        fd.closeBatch{value: 1e15}(1, 0);
        Schedule.warpTo(t0 + 12 hours);
        assertTrue(fd.canClose(), "the timer opens it");
    }

    /// The raw draws of `testFuzz_canCloseMatchesTheRule`, bounded in the test, and the bytes that pick its modes (each
    /// mode from its own byte, so no bounded draw skews a mode).
    struct CloseRuleDraw {
        uint256 forwarded;
        uint256 deposits;
        uint256 cancelled;
        uint256 minDeposit;
        uint256 depositCap;
        uint256 maxBatchValue;
        uint256 elapsed;
        uint256 maxDeposits;
        uint256 maxRedeems;
        uint8 entries;
        uint8 redeems;
        uint8 scale;
        uint8 focus;
        uint8 edge;
        uint8 clock;
        uint8 lists;
    }

    /// What `canClose` reads, as the test set it: the model the rule is computed on, never read from the rule.
    struct CloseRuleState {
        uint256 start;
        uint256 interval;
        uint256 nDeposits;
        uint256 maxDeposits;
        uint256 nRedeems;
        uint256 maxRedeems;
        uint256 total;
        uint256 forwarded;
        uint256 minDeposit;
        uint256 maxBatchValue;
        uint256 depositCap;
    }

    /// The close rule, written from spec 3.5 (Revisions 33 and 36), not from `canClose`: due at `start + interval`; or
    /// the deposit list at half its limit or more (2 x entries >= maxDeposits, Revision 36) or the redeem list at its
    /// limit; or, while the batch holds deposits, (a) 2 x deposits >= maxBatchValue, (b) deposits + minDeposit >
    /// maxBatchValue, (c) netForwarded + 2 x deposits >= depositCap or (d) netForwarded + deposits + minDeposit >
    /// depositCap. A batch without deposits waits whatever the limits.
    function closeRule(CloseRuleState memory s, uint256 timestamp) internal pure returns (bool) {
        if (timestamp >= s.start + s.interval) return true;
        if (2 * s.nDeposits >= s.maxDeposits || s.nRedeems >= s.maxRedeems) return true;
        if (s.total == 0) return false;
        bool a = 2 * s.total >= s.maxBatchValue;
        bool b = s.total + s.minDeposit > s.maxBatchValue;
        bool c = s.forwarded + 2 * s.total >= s.depositCap;
        bool d = s.forwarded + s.total + s.minDeposit > s.depositCap;
        return a || b || c || d;
    }

    /// The door holds the model's state, and `canClose()` answers the rule on it without reverting.
    function assertCanCloseIsTheRule(CloseRuleState memory s, uint64 id, string memory when) internal view {
        (uint64 bid, uint64 start, uint256 total,, uint256 nD, uint256 nR) = fd.openBatch();
        assertEq(bid, id, when);
        assertEq(start, s.start, when);
        assertEq(total, s.total, when);
        assertEq(nD, s.nDeposits, when);
        assertEq(nR, s.nRedeems, when);
        assertEq(fd.netForwarded(), s.forwarded, when);
        assertEq(fd.minDeposit(), s.minDeposit, when);
        assertEq(fd.depositCap(), s.depositCap, when);
        assertEq(fd.maxBatchValue(), s.maxBatchValue, when);
        assertEq(fd.maxDeposits(), s.maxDeposits, when);
        assertEq(fd.maxRedeems(), s.maxRedeems, when);
        (bool ok, bytes memory ret) = address(fd).staticcall(abi.encodeCall(CascadeFrontDoor.canClose, ()));
        assertTrue(ok, string.concat(when, ": canClose reverted"));
        assertEq(abi.decode(ret, (bool)), closeRule(s, vm.getBlockTimestamp()), string.concat(when, ": not the rule"));
    }

    /// `amount` of fresh TAO deposited by `user` into `fd`.
    function depositAs(address user, uint256 amount) internal {
        tao.mint(user, amount);
        vm.startPrank(user);
        tao.approve(address(fd), amount);
        fd.deposit(amount);
        vm.stopPrank();
    }

    /// `x` rounded down to whole rao (1e9 wei), as every deposit must be.
    function toRao(uint256 x) internal pure returns (uint256) {
        return x - x % 1e9;
    }

    /// The upper end of a drawn amount: 1, 50, 2,500 or 5,000 TAO, so small batches are drawn as often as large.
    function magnitude(uint256 k) internal pure returns (uint256) {
        uint256[4] memory tops = [uint256(1e18), 50e18, 2_500e18, 5_000e18];
        return tops[k % 4];
    }

    /// `edge` less a wei (`off` 0), `edge` (1) or `edge` plus a wei (2), floored at 0 and at most `top`.
    function nearEdge(uint256 edge, uint256 off, uint256 top) internal pure returns (uint256) {
        uint256 y = edge + off;
        y = y == 0 ? 0 : y - 1;
        return y < top ? y : top;
    }

    /// L-2 of the R7 review: the campaigns predict BatchNotReady from `canClose()` itself, so a wrong clause would pass
    /// every one of them. This checks `canClose()` against the rule recomputed here (`closeRule`, from spec 3.5) over
    /// fuzzed deposits (up to three entries that stay, and one deposited and cancelled in full five minutes later, past
    /// its cooldown (R11), its entry removed),
    /// netForwarded (a real close of an earlier batch), minDeposit, depositCap, maxBatchValue, the list limits and the
    /// clock, at four points: as deployed, with the limits set, with the list limits set, and after the clock moves.
    /// The limits are drawn freely or set far from their edges, and then one clause may be aimed at its edge (a wei
    /// below, at or above it), so each clause decides alone at its edge. Clauses (b) and (d) decide alone only with the
    /// minimum above the batch's deposits (I-1: every entry was at least the minimum when made), so aiming at them
    /// raises minDeposit over a batch already holding deposits. Then a closable batch closes for the bridge fee (its
    /// deposits sent, or an empty batch rolled), and any other reverts BatchNotReady.
    function testFuzz_canCloseMatchesTheRule(CloseRuleDraw memory draw) public {
        uint256 most = fd.MAX_BATCH_VALUE(); // 5,000 TAO, the stub bridge's maxMessageValue too
        uint256 least = fd.MIN_DEPOSIT_FLOOR(); // 0.03 TAO
        // a door at the widest limits, so each limit drawn below is a setCaps or an immediate tightening
        CascadeFrontDoor.Params memory p = frontDoorParams();
        p.minDeposit = least;
        p.depositCap = type(uint256).max;
        p.maxBatchValue = most;
        fd = deployFrontDoor(p);
        CloseRuleState memory s = CloseRuleState({
            start: vm.getBlockTimestamp(),
            interval: p.batchInterval,
            nDeposits: 0,
            maxDeposits: p.maxDeposits,
            nRedeems: 0,
            maxRedeems: p.maxRedeems,
            total: 0,
            forwarded: 0,
            minDeposit: least,
            maxBatchValue: most,
            depositCap: type(uint256).max
        });
        uint64 id = 1;

        // netForwarded from a real close of an earlier batch, by its interval
        if (draw.scale & 1 != 0) {
            s.forwarded = toRao(bound(draw.forwarded, least, magnitude(draw.scale >> 4)));
            depositAs(makeAddr("earlier depositor"), s.forwarded);
            Schedule.warpTo(s.start + s.interval);
            vm.prank(carol);
            fd.closeBatch{value: 1e15}(1, s.forwarded);
            s.start = vm.getBlockTimestamp();
            id = 2;
        }

        // the open batch: a deposit cancelled in full after the others, up to three deposits that stay, up to two
        // redeem requests
        s.nDeposits = draw.entries % 4;
        if (s.nDeposits != 0) s.total = toRao(bound(draw.deposits, s.nDeposits * least, magnitude(draw.scale >> 1)));
        uint256 cancelled;
        if (draw.scale & 8 != 0 && most - s.total >= least) {
            cancelled = toRao(bound(draw.cancelled, least, most - s.total));
        }
        address canceller = makeAddr("canceller");
        if (cancelled != 0) depositAs(canceller, cancelled);
        uint256 each = s.nDeposits == 0 ? 0 : toRao(s.total / s.nDeposits);
        for (uint256 i; i < s.nDeposits; ++i) {
            address depositor = makeAddr(string.concat("depositor", vm.toString(i)));
            depositAs(depositor, i + 1 == s.nDeposits ? s.total - each * i : each);
        }
        if (cancelled != 0) {
            // its cancel once the cooldown has passed (R11): five minutes into the batch, far from its interval
            Schedule.wait(fd.CANCEL_COOLDOWN());
            vm.prank(canceller);
            fd.cancelDeposit(cancelled);
        }
        s.nRedeems = draw.redeems % 3;
        fillRedeems(fd, s.nRedeems);
        assertCanCloseIsTheRule(s, id, "as deployed");

        // the limits: drawn freely, or far from their edges; then one clause aimed at its edge, or none
        uint256 off = draw.edge % 3;
        uint256 focus = draw.focus % 5;
        bool free = (draw.focus / 5) % 2 == 1;
        s.minDeposit = free ? bound(draw.minDeposit, least, most) : least;
        s.maxBatchValue = free ? bound(draw.maxBatchValue, 0, most) : most;
        s.depositCap = free ? bound(draw.depositCap, 0, s.forwarded + 3 * most) : type(uint256).max;
        if ((focus == 2 || focus == 4) && s.total + 1 < most) {
            // (b) or (d) alone: the minimum raised over the batch's deposits, with room left under maxBatchValue
            uint256 lo = s.total + 2 > least ? s.total + 2 : least;
            if (lo <= most - s.total - 1) s.minDeposit = bound(draw.minDeposit, lo, most - s.total - 1);
        }
        if (focus == 1) s.maxBatchValue = nearEdge(2 * s.total, off, most);
        else if (focus == 2) s.maxBatchValue = nearEdge(s.total + s.minDeposit, off, most);
        else if (focus == 3) s.depositCap = nearEdge(s.forwarded + 2 * s.total, off, type(uint256).max);
        else if (focus == 4) s.depositCap = nearEdge(s.forwarded + s.total + s.minDeposit, off, type(uint256).max);
        vm.startPrank(owner);
        fd.setCaps(s.minDeposit, s.depositCap);
        fd.setMaxBatchValue(s.maxBatchValue);
        vm.stopPrank();
        assertCanCloseIsTheRule(s, id, "the limits set");

        // the list limits: the deployed 50 each, or down to around the lists' lengths (the deposit list's to 7, so
        // each of its up to three entries meets its half edge, 2n against 2n and 2n + 1: Revision 36)
        if (draw.lists & 1 != 0) s.maxDeposits = bound(draw.maxDeposits, 1, 7);
        if (draw.lists & 2 != 0) s.maxRedeems = bound(draw.maxRedeems, 1, 3);
        vm.prank(owner);
        fd.setBatchLimits(uint32(s.maxDeposits), uint32(s.maxRedeems));
        assertCanCloseIsTheRule(s, id, "the list limits set");

        // the clock: before the interval (half the runs), at its edge (a second before, at or after it), or past it;
        // never back before now (the cancel's cooldown may have passed five minutes already)
        uint256 clock = draw.clock % 4;
        uint256 elapsed;
        if (clock < 2) elapsed = bound(draw.elapsed, vm.getBlockTimestamp() - s.start, s.interval - 1);
        else if (clock == 2) elapsed = s.interval + (draw.edge / 3) % 3 - 1;
        else elapsed = bound(draw.elapsed, s.interval, 3 * s.interval);
        Schedule.warpTo(s.start + elapsed);
        assertCanCloseIsTheRule(s, id, "the clock moved");

        // a closable batch closes for the bridge fee; any other is not ready
        uint256 sends = bridge.sendCount();
        bool closable = closeRule(s, vm.getBlockTimestamp());
        vm.prank(carol);
        if (!closable) {
            vm.expectRevert(CascadeFrontDoor.BatchNotReady.selector);
            fd.closeBatch{value: 1e15}(id, 0);
            return;
        }
        fd.closeBatch{value: 1e15}(id, s.total);
        if (s.nDeposits == 0 && s.nRedeems == 0) {
            assertEq(openId(), id, "an empty batch rolls");
            assertEq(bridge.sendCount(), sends, "and sends nothing");
        } else {
            assertEq(openId(), id + 1, "the batch closed");
            assertEq(bridge.sendCount(), sends + 1, "and was sent");
            assertEq(bridge.lastAmount(), s.total, "with its deposits");
            assertEq(fd.netForwarded(), s.forwarded + s.total, "now forwarded");
        }
    }

    /// I-21: a closer never receives more than it sent. Over any pot, fee and value, the closer gets back exactly
    /// its value less what the pot lacked (all of it when the pot covers the fee), never any of the pot, or the
    /// close reverts `InsufficientFee` and it gets everything back; a requester whose request closes the batch
    /// gets nothing back. The pot keeps the rest, and I-18 holds.
    function test_closerNeverReceivesMoreThanItSent(uint256 nRequests, uint256 fee, uint256 value, bool selfClose)
        public
    {
        nRequests = bound(nRequests, 1, 50);
        fee = bound(fee, 0, 1e16);
        value = bound(value, 0, 1e17);
        bridge.setFee(fee);
        uint256 pot = nRequests * 1e14;
        uint256 potUsed = pot < fee ? pot : fee;
        bool covered = selfClose ? pot >= fee : pot + value >= fee;

        if (selfClose) {
            vm.prank(owner);
            fd.setBatchLimits(50, uint32(nRequests));
            fillRedeems(fd, nRequests);
            uint256 before = alice.balance;
            vm.prank(alice);
            if (!covered) vm.expectRevert(CascadeFrontDoor.InsufficientFee.selector);
            fd.requestRedeem{value: 1e14}(1e24);
            // the requester's 1e14 went into the next batch's pot, or stayed with it
            assertEq(alice.balance, covered ? before - 1e14 : before, "the requester got some of the pot");
            assertLe(alice.balance, before, "I-21");
        } else {
            fillRedeems(fd, nRequests);
            Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
            vm.deal(carol, 1 ether);
            vm.prank(carol);
            if (!covered) vm.expectRevert(CascadeFrontDoor.InsufficientFee.selector);
            fd.closeBatch{value: value}(1, 0);
            assertEq(carol.balance, covered ? 1 ether - (fee - potUsed) : 1 ether, "the closer's refund");
            assertLe(carol.balance, 1 ether, "I-21");
        }
        if (covered) {
            assertEq(fd.potCarried(), pot - potUsed, "the remainder carried");
            assertEq(bridge.lastValue(), fee, "the fee sent");
        }
        assertEthIdentity();
    }

    /// I-18: the ETH the front door holds is the open batch's pot plus the pre-paid credits after every close
    /// (the remainder carried), every self-close, every sweep, every top-up close and every roll.
    function test_ethIdentityAcrossCloseAndSweep() public {
        address t = fd.treasury();
        bridge.setFee(2e14);
        vm.prank(bob);
        fd.creditRedeemFee{value: 3e14}(alice);
        assertEthIdentity();
        fillRedeems(fd, 4);
        vm.prank(alice);
        fd.requestRedeem(1e24); // from credit: pot 5e14, credit 2e14
        assertEthIdentity();

        // a close with value the pot does not need: 3e14 carried, carol's 1e14 back
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        vm.prank(carol);
        fd.closeBatch{value: 1e14}(1, 0);
        assertEthIdentity();
        assertEq(address(fd).balance, 3e14 + 2e14);
        assertEq(carol.balance, 1 ether);

        // a sweep of part of the carried remainder
        vm.prank(owner);
        fd.sweepPot(1e14);
        assertEthIdentity();
        assertEq(t.balance, 1e14);

        // a self-close on the carried 2e14 and batch 2's own 2e14: 2e14 paid, 2e14 carried; alice's request,
        // from credit, lands in batch 3
        vm.prank(owner);
        fd.setBatchLimits(50, 2);
        fillRedeems(fd, 2);
        vm.prank(alice);
        fd.requestRedeem(1e24);
        assertEthIdentity();
        assertEq(openPot(), 3e14);
        assertEq(fd.totalFeeCredit(), 1e14);
        assertEq(address(fd).balance, 4e14);

        // the rest of the carried remainder swept
        vm.prank(owner);
        fd.sweepPot(2e14);
        assertEthIdentity();
        assertEq(t.balance, 3e14);

        // a top-up close: the pot's 1e14, then 1e14 of carol's 1e15, 9e14 back
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(3, 0);
        assertEthIdentity();
        assertEq(carol.balance, 1 ether - 1e14);

        // a roll refunds its value
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        vm.prank(carol);
        fd.closeBatch{value: 5}(4, 0);
        assertEthIdentity();
        assertEq(address(fd).balance, 1e14);
        assertEq(fd.totalFeeCredit(), 1e14);
        assertEq(openPot(), 0);
        assertEq(fd.potCarried(), 0);
    }
}

/// A front door's treasury that, on each payment, re-enters `sweepPot` and `closeBatch` (Task 29's follow-up). By
/// default it records each refusal and accepts the payment; with `bubble` it re-enters without a `try`, so a refusal
/// escapes its `receive` and it refuses the payment. When it is also the door's owner, `sweep` sweeps as the owner.
contract ReentrantPotTreasury {
    CascadeFrontDoor public door;
    bool public bubble;
    uint256 public reentries;
    bytes public sweepRefusal;
    bytes public closeRefusal;

    function setDoor(CascadeFrontDoor door_) external {
        door = door_;
    }

    function setBubble(bool on) external {
        bubble = on;
    }

    function sweep(uint256 amount) external {
        door.sweepPot(amount);
    }

    receive() external payable {
        ++reentries;
        (uint64 id,,,,,) = door.openBatch();
        if (bubble) {
            door.sweepPot(1);
            return;
        }
        try door.sweepPot(1) {}
        catch (bytes memory why) {
            sweepRefusal = why;
        }
        try door.closeBatch(id, 0) {}
        catch (bytes memory why) {
            closeRefusal = why;
        }
    }
}

/// A front door's treasury whose `receive` reverts: it refuses every native payment (Task 29).
contract RefusingPotTreasury {
    error Refused();

    receive() external payable {
        revert Refused();
    }
}
