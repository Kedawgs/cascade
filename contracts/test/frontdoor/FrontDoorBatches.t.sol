// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeBase} from "../../src/CascadeBase.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {MockTAO} from "../mocks/MockTAO.sol";
import {FrontDoorTestBase} from "../FrontDoorTestBase.sol";

contract FrontDoorBatchesTest is FrontDoorTestBase {
    // ---- helpers ----

    function dep(address user, uint256 amount) internal {
        vm.prank(user);
        fd.deposit(amount);
    }

    function pauseFd() internal {
        vm.prank(guardian);
        fd.pause();
    }

    function openId() internal view returns (uint64 id) {
        (id,,,,,) = fd.openBatch();
    }

    function openTotal() internal view returns (uint256 total) {
        (,, total,,,) = fd.openBatch();
    }

    function openPot() internal view returns (uint256 pot) {
        (,,, pot,,) = fd.openBatch();
    }

    function openCounts() internal view returns (uint256 nDeposits, uint256 nRedeems) {
        (,,,, nDeposits, nRedeems) = fd.openBatch();
    }

    function entries1(address user, uint256 amount) internal pure returns (CascadeMessages.Entry[] memory e) {
        e = new CascadeMessages.Entry[](1);
        e[0] = CascadeMessages.Entry(user, amount);
    }

    function noEntries() internal pure returns (CascadeMessages.Entry[] memory) {
        return new CascadeMessages.Entry[](0);
    }

    function assertEthIdentity() internal view {
        assertEq(address(fd).balance, openPot() + fd.totalFeeCredit());
    }

    // ---- constructor ----

    function test_constructorRejectsNon18Decimals() public {
        MockTAO six = new MockTAO(6);
        vm.expectRevert(CascadeFrontDoor.UnsupportedDecimals.selector);
        new CascadeFrontDoor(six, bridge, BITTENSOR, vault, owner, guardian, 12 hours, 1e18, 10_000e18, 1e14);

        // and a zero vault
        vm.expectRevert(CascadeBase.ZeroAddress.selector);
        new CascadeFrontDoor(tao, bridge, BITTENSOR, address(0), owner, guardian, 12 hours, 1e18, 10_000e18, 1e14);
    }

    function test_constructorOpensBatchOne() public view {
        (uint64 id, uint64 start, uint256 total, uint256 pot, uint256 nD, uint256 nR) = fd.openBatch();
        assertEq(id, 1);
        assertEq(start, block.timestamp);
        assertEq(total, 0);
        assertEq(pot, 0);
        assertEq(nD, 0);
        assertEq(nR, 0);
        assertEq(fd.maxDeposits(), 50);
        assertEq(fd.maxRedeems(), 50);
        assertEq(fd.maxBatchValue(), 4_000e18);
        assertEq(address(fd.asset()), address(tao));
        assertEq(fd.vaultChain(), BITTENSOR);
        assertEq(fd.vault(), vault);
        assertEq(fd.batchInterval(), 12 hours);
        assertEq(fd.minDeposit(), 1e18);
        assertEq(fd.depositCap(), 10_000e18);
        assertEq(fd.redeemRequestFee(), 1e14);
        assertEq(fd.primaryBridge(), address(bridge));
        assertEq(fd.owner(), owner);
        assertEq(fd.guardian(), guardian);
        assertEq(fd.RAO(), 1e9);
        assertFalse(fd.canClose());
    }

    // ---- deposits ----

    function test_depositMergesPerUser() public {
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.DepositRequested(1, alice, 10e18, alice);
        dep(alice, 10e18);
        dep(alice, 10e18);

        (uint256 nD,) = openCounts();
        assertEq(nD, 1);
        assertEq(openTotal(), 20e18);
        assertEq(fd.depositOf(alice), 20e18);
        CascadeMessages.Entry[] memory d = fd.openDeposits();
        assertEq(d.length, 1);
        assertEq(d[0].user, alice);
        assertEq(d[0].amount, 20e18);
        assertEq(tao.balanceOf(address(fd)), 20e18);
        assertEq(tao.balanceOf(alice), 980e18);
    }

    function test_depositForNamesUserAndChargesPayer() public {
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.DepositRequested(1, alice, 5e18, bob);
        vm.prank(bob);
        fd.depositFor(alice, 5e18);

        assertEq(tao.balanceOf(bob), 995e18);
        assertEq(tao.balanceOf(alice), 1_000e18);
        assertEq(fd.depositOf(alice), 5e18);
        assertEq(fd.depositOf(bob), 0);
        assertEq(tao.balanceOf(address(fd)), 5e18);
    }

    function test_depositZeroAmountReverts() public {
        vm.prank(owner);
        fd.setCaps(0, 10_000e18);
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.ZeroAmount.selector);
        fd.deposit(0);
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.ZeroAmount.selector);
        fd.depositFor(alice, 0);
    }

    function test_depositRejectsMisalignedBelowMinAndZeroUser() public {
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.NotRaoAligned.selector);
        fd.deposit(1e18 + 1);
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.BelowMinDeposit.selector);
        fd.deposit(1e18 - 1e9);
        vm.prank(alice);
        vm.expectRevert(CascadeBase.ZeroAddress.selector);
        fd.depositFor(address(0), 1e18);

        // the minimum itself is accepted
        dep(alice, 1e18);
        assertEq(fd.depositOf(alice), 1e18);
    }

    function test_depositCapCountsNetForwarded() public {
        tao.mint(alice, 10_000e18);
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.CapExceeded.selector);
        fd.deposit(10_001e18);

        dep(alice, 100e18);
        vm.warp(block.timestamp + 12 hours);
        vm.prank(carol);
        fd.closeBatch{value: 1e15}();
        assertEq(fd.netForwarded(), 100e18);

        vm.prank(owner);
        fd.setMaxBatchValue(10_000e18);
        // 100e18 forwarded + 9_901e18 = 10_001e18 > 10_000e18
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.CapExceeded.selector);
        fd.deposit(9_901e18);
        // 100e18 forwarded + 9_900e18 = 10_000e18, exactly the cap
        dep(alice, 9_900e18);
        assertEq(fd.depositOf(alice), 9_900e18);
        assertEq(openTotal(), 9_900e18);
    }

    function test_depositBatchValueFull() public {
        tao.mint(alice, 4_001e18);
        dep(alice, 3_000e18);
        // 3_000e18 + 1_001e18 = 4_001e18 > maxBatchValue 4_000e18
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.BatchValueFull.selector);
        fd.deposit(1_001e18);
        // 3_000e18 + 1_000e18 = 4_000e18 fits exactly
        dep(alice, 1_000e18);
        assertEq(openTotal(), 4_000e18);
    }

    function test_depositBatchFullUnlessMerging() public {
        vm.prank(owner);
        fd.setBatchLimits(2, 2);
        dep(alice, 1e18);
        assertFalse(fd.canClose());
        dep(bob, 1e18);
        // the deposit list is at its limit: closable before the interval
        assertTrue(fd.canClose());

        vm.prank(carol);
        vm.expectRevert(CascadeFrontDoor.BatchFull.selector);
        fd.deposit(1e18);

        dep(alice, 1e18);
        assertEq(fd.depositOf(alice), 2e18);
        (uint256 nD,) = openCounts();
        assertEq(nD, 2);
    }

    function test_depositWhilePausedReverts() public {
        pauseFd();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        fd.deposit(1e18);
        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        fd.depositFor(alice, 1e18);
    }

    function test_cancelDepositPartialThenFullFreesSlot() public {
        dep(alice, 10e18);

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.DepositCancelled(1, alice, 4e18);
        vm.prank(alice);
        fd.cancelDeposit(4e18);
        assertEq(fd.depositOf(alice), 6e18);
        assertEq(openTotal(), 6e18);
        assertEq(tao.balanceOf(alice), 994e18);
        (uint256 nD,) = openCounts();
        assertEq(nD, 1);

        vm.prank(alice);
        fd.cancelDeposit(6e18);
        (nD,) = openCounts();
        assertEq(nD, 0);
        assertEq(fd.depositOf(alice), 0);
        assertEq(openTotal(), 0);
        assertEq(tao.balanceOf(alice), 1_000e18);
        assertEq(tao.balanceOf(address(fd)), 0);

        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.InsufficientRequest.selector);
        fd.cancelDeposit(6e18);
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.NotRaoAligned.selector);
        fd.cancelDeposit(1e9 + 1);
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.ZeroAmount.selector);
        fd.cancelDeposit(0);

        // more than the entry holds
        dep(alice, 2e18);
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.InsufficientRequest.selector);
        fd.cancelDeposit(3e18);

        // works while paused
        pauseFd();
        vm.prank(alice);
        fd.cancelDeposit(2e18);
        assertEq(fd.depositOf(alice), 0);
        assertEq(tao.balanceOf(alice), 1_000e18);
    }

    function test_cancelDepositFreesSlotForOthers() public {
        vm.prank(owner);
        fd.setBatchLimits(1, 1);
        dep(alice, 1e18);
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.BatchFull.selector);
        fd.deposit(1e18);
        vm.prank(alice);
        fd.cancelDeposit(1e18);
        dep(bob, 1e18);
        assertEq(fd.depositOf(bob), 1e18);
        (uint256 nD,) = openCounts();
        assertEq(nD, 1);

        // swap-and-pop keeps the moved entry's slot: [bob, alice, carol] → bob leaves → [carol, alice]
        vm.prank(owner);
        fd.setBatchLimits(3, 3);
        dep(alice, 2e18);
        dep(carol, 3e18);
        vm.prank(bob);
        fd.cancelDeposit(1e18);
        dep(carol, 1e18); // merges into the moved entry at index 0
        CascadeMessages.Entry[] memory d = fd.openDeposits();
        assertEq(d.length, 2);
        assertEq(d[0].user, carol);
        assertEq(d[0].amount, 4e18);
        assertEq(d[1].user, alice);
        assertEq(d[1].amount, 2e18);
        assertEq(fd.depositOf(carol), 4e18);
        assertEq(fd.depositOf(bob), 0);
        assertEq(openTotal(), 6e18);
    }

    // ---- redeem requests ----

    function test_requestRedeemFeeOnFirstEntryOnly() public {
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.RedeemRequested(1, alice, 5e24);
        vm.prank(alice);
        fd.requestRedeem{value: 1e14}(5e24);
        assertEq(openPot(), 1e14);
        assertEq(fd.redeemOf(alice), 5e24);

        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.WrongFee.selector);
        fd.requestRedeem{value: 1e14}(1e24);

        vm.prank(alice);
        fd.requestRedeem(3e24);
        assertEq(fd.redeemOf(alice), 8e24);
        assertEq(openPot(), 1e14);
        (, uint256 nR) = openCounts();
        assertEq(nR, 1);
        CascadeMessages.Entry[] memory r = fd.openRedeems();
        assertEq(r.length, 1);
        assertEq(r[0].user, alice);
        assertEq(r[0].amount, 8e24);
        assertEq(alice.balance, 1 ether - 1e14);
        assertEq(address(fd).balance, 1e14);
    }

    function test_requestRedeemWrongFeeReverts() public {
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.WrongFee.selector);
        fd.requestRedeem{value: 1e14 - 1}(1e24);
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.WrongFee.selector);
        fd.requestRedeem{value: 1e14 + 1}(1e24);
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.WrongFee.selector);
        fd.requestRedeem(1e24);
    }

    function test_requestRedeemFromCredit() public {
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.FeeCredited(alice, 1e14, bob);
        vm.prank(bob);
        fd.creditRedeemFee{value: 1e14}(alice);
        assertEq(fd.feeCredit(alice), 1e14);
        assertEq(fd.totalFeeCredit(), 1e14);
        assertEq(address(fd).balance, 1e14);

        vm.prank(alice);
        fd.requestRedeem(1e24);
        assertEq(openPot(), 1e14);
        assertEq(fd.feeCredit(alice), 0);
        assertEq(fd.totalFeeCredit(), 0);
        assertEq(fd.redeemOf(alice), 1e24);
        assertEq(alice.balance, 1 ether);
        assertEq(address(fd).balance, 1e14);
    }

    function test_creditNotSpendableByOthers() public {
        vm.prank(bob);
        fd.creditRedeemFee{value: 1e14}(alice);
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.WrongFee.selector);
        fd.requestRedeem(1e24);
        assertEq(fd.feeCredit(alice), 1e14);
        assertEq(fd.feeCredit(bob), 0);
    }

    function test_creditZeroValueReverts() public {
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.ZeroAmount.selector);
        fd.creditRedeemFee(alice);
        vm.prank(bob);
        vm.expectRevert(CascadeBase.ZeroAddress.selector);
        fd.creditRedeemFee{value: 1e14}(address(0));
    }

    function test_requestRedeemZeroAndPausedRevert() public {
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.ZeroAmount.selector);
        fd.requestRedeem{value: 1e14}(0);

        // zero shares stay rejected with an existing entry and with a zero fee
        requestWithFee(alice, 1e24);
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.ZeroAmount.selector);
        fd.requestRedeem(0);
        vm.prank(owner);
        fd.setRedeemRequestFee(0);
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.ZeroAmount.selector);
        fd.requestRedeem(0);

        pauseFd();
        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        fd.requestRedeem(1e24);
    }

    function test_cancelRedeemKeepsFeeAndFreesSlot() public {
        requestWithFee(alice, 5e24);

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.RedeemCancelled(1, alice, 2e24);
        vm.prank(alice);
        fd.cancelRedeem(2e24);
        assertEq(fd.redeemOf(alice), 3e24);

        vm.prank(alice);
        fd.cancelRedeem(3e24);
        (, uint256 nR) = openCounts();
        assertEq(nR, 0);
        assertEq(fd.redeemOf(alice), 0);
        assertEq(openPot(), 1e14);
        assertEq(address(fd).balance, 1e14);
        assertEthIdentity();

        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.InsufficientRequest.selector);
        fd.cancelRedeem(1);
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.ZeroAmount.selector);
        fd.cancelRedeem(0);

        // the slot is gone, so a new request is a first request again and pays the fee
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.WrongFee.selector);
        fd.requestRedeem(1e24);
        requestWithFee(alice, 1e24);

        // swap-and-pop keeps the moved entry's slot: [alice, bob, carol] → alice leaves → [carol, bob]
        requestWithFee(bob, 2e24);
        requestWithFee(carol, 3e24);
        vm.prank(alice);
        fd.cancelRedeem(1e24);
        vm.prank(carol);
        fd.requestRedeem(1e24); // merges into the moved entry at index 0
        CascadeMessages.Entry[] memory r = fd.openRedeems();
        assertEq(r.length, 2);
        assertEq(r[0].user, carol);
        assertEq(r[0].amount, 4e24);
        assertEq(r[1].user, bob);
        assertEq(r[1].amount, 2e24);

        // works while paused; no shares rounding rule
        pauseFd();
        vm.prank(bob);
        fd.cancelRedeem(2e24);
        assertEq(fd.redeemOf(bob), 0);
        // alice 1e14 twice + bob 1e14 + carol 1e14, none refunded
        assertEq(openPot(), 4e14);
        assertEq(address(fd).balance, 4e14);
        assertEthIdentity();
    }

    // ---- close ----

    function test_closeBatchBeforeIntervalReverts() public {
        uint256 t0 = block.timestamp;
        dep(alice, 10e18);
        vm.prank(carol);
        vm.expectRevert(CascadeFrontDoor.BatchNotReady.selector);
        fd.closeBatch{value: 1e15}();

        vm.warp(t0 + 12 hours - 1);
        assertFalse(fd.canClose());
        vm.prank(carol);
        vm.expectRevert(CascadeFrontDoor.BatchNotReady.selector);
        fd.closeBatch{value: 1e15}();

        vm.warp(t0 + 12 hours);
        assertTrue(fd.canClose());
        vm.prank(carol);
        fd.closeBatch{value: 1e15}();
        assertEq(openId(), 2);
    }

    function test_closeBatchSendsThroughPrimaryBridge() public {
        dep(alice, 10e18);
        requestWithFee(bob, 1e24);
        vm.warp(block.timestamp + 12 hours);

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.BatchClosed(1, 10e18, 1, 1, 1e15, 1e14);
        vm.prank(carol);
        fd.closeBatch{value: 1e15}();

        assertEq(bridge.lastDestChain(), BITTENSOR);
        assertEq(bridge.lastRecipient(), vault);
        assertEq(bridge.lastAmount(), 10e18);
        assertEq(bridge.lastValue(), 1e15);
        assertEq(bridge.sendCount(), 1);
        assertEq(bridge.lastMessage(), CascadeMessages.encodeBatch(1, entries1(alice, 10e18), entries1(bob, 1e24)));
        assertEq(tao.balanceOf(address(bridge)), 10e18);
        assertEq(tao.balanceOf(address(fd)), 0);
        assertEq(tao.allowance(address(fd), address(bridge)), 0);
        // budget = pot 1e14 + 1e15 = 1.1e15; fee 1e15; carol gets 1e14 back: net -9e14
        assertEq(carol.balance, 1 ether - 9e14);

        (uint64 id, uint64 start, uint256 total, uint256 pot, uint256 nD, uint256 nR) = fd.openBatch();
        assertEq(id, 2);
        assertEq(start, block.timestamp);
        assertEq(total, 0);
        assertEq(pot, 0);
        assertEq(nD, 0);
        assertEq(nR, 0);
        assertEq(fd.depositOf(alice), 0);
        assertEq(fd.redeemOf(bob), 0);
        assertEq(fd.netForwarded(), 10e18);
        assertEq(address(fd).balance, 0);
    }

    function test_closeBatchPotCoversFeeRemainderToCloser() public {
        bridge.setFee(5e13);
        requestWithFee(alice, 1e24); // pot 1e14
        vm.warp(block.timestamp + 12 hours);

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.BatchClosed(1, 0, 0, 1, 5e13, 5e13);
        vm.prank(carol);
        fd.closeBatch();

        // budget = pot 1e14; fee 5e13; carol receives 1e14 - 5e13 = 5e13
        assertEq(carol.balance, 1 ether + 5e13);
        assertEq(bridge.lastValue(), 5e13);
        assertEq(address(fd).balance, 0);
    }

    function test_closeBatchInsufficientFeeReverts() public {
        dep(alice, 10e18);
        vm.warp(block.timestamp + 12 hours);
        vm.prank(carol);
        vm.expectRevert(CascadeFrontDoor.InsufficientFee.selector);
        fd.closeBatch{value: 1e15 - 1}();
        assertEq(openId(), 1);
        assertEq(openTotal(), 10e18);

        vm.prank(carol);
        fd.closeBatch{value: 1e15}();
        assertEq(openId(), 2);
        assertEq(carol.balance, 1 ether - 1e15);
    }

    function test_closeBatchEmptyRollsAndRefunds() public {
        uint256 t1 = block.timestamp + 12 hours;
        vm.warp(t1);

        // a closer that cannot take the refund fails the roll (this test contract has no receive)
        vm.expectRevert(CascadeFrontDoor.TransferFailed.selector);
        fd.closeBatch{value: 7}();

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.BatchRolled(1);
        vm.prank(carol);
        fd.closeBatch{value: 7}();

        (uint64 id, uint64 start,,,,) = fd.openBatch();
        assertEq(id, 1);
        assertEq(start, t1);
        assertEq(carol.balance, 1 ether);
        assertEq(address(fd).balance, 0);
        assertEq(bridge.sendCount(), 0);

        // the timer restarted
        vm.prank(carol);
        vm.expectRevert(CascadeFrontDoor.BatchNotReady.selector);
        fd.closeBatch();
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
        fd.closeBatch{value: 8e14}();
        assertEq(openId(), 2);
        CascadeMessages.Entry[] memory r = new CascadeMessages.Entry[](2);
        r[0] = CascadeMessages.Entry(alice, 1e24);
        r[1] = CascadeMessages.Entry(bob, 2e24);
        assertEq(bridge.lastMessage(), CascadeMessages.encodeBatch(1, noEntries(), r));
        assertEq(carol.balance, 1 ether - 8e14);
    }

    function test_closeBatchEarlyWhenFullByValue() public {
        tao.mint(alice, 3_000e18);
        assertFalse(fd.canClose());
        dep(alice, 3_999_500_000_000_000_000_000);
        // 3_999.5e18 + minDeposit 1e18 > 4_000e18
        assertTrue(fd.canClose());

        // boundary: 3_999.5e18 + 0.5e18 == 4_000e18 is not full
        vm.prank(owner);
        fd.setCaps(5e17, 10_000e18);
        assertFalse(fd.canClose());
        vm.prank(owner);
        fd.setCaps(1e18, 10_000e18);

        vm.prank(carol);
        fd.closeBatch{value: 1e15}();
        assertEq(bridge.lastAmount(), 3_999_500_000_000_000_000_000);
        assertEq(openId(), 2);
    }

    function test_closeBatchAfterMaxBatchValueLoweredBelowTotal() public {
        tao.mint(alice, 2_000e18);
        dep(alice, 3_000e18);
        assertFalse(fd.canClose());

        vm.prank(owner);
        fd.setMaxBatchValue(2_000e18);
        // 3_000e18 + 1e18 > 2_000e18: full, and no underflow
        assertTrue(fd.canClose());
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.BatchValueFull.selector);
        fd.deposit(1e18);

        vm.prank(carol);
        fd.closeBatch{value: 1e15}();
        assertEq(bridge.lastAmount(), 3_000e18);
        assertEq(openId(), 2);
        assertEq(fd.netForwarded(), 3_000e18);
    }

    function test_closeBatchRedeemOnlyBatchSendsZeroAmount() public {
        requestWithFee(alice, 1e24);
        vm.warp(block.timestamp + 12 hours);

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.BatchClosed(1, 0, 0, 1, 1e15, 1e14);
        vm.prank(carol);
        fd.closeBatch{value: 1e15}();

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
        // budget 1e14 + 1e15; fee 1e15; carol gets 1e14 back
        assertEq(carol.balance, 1 ether - 9e14);
    }

    function test_closeBatchPrimaryDisabledReverts() public {
        dep(alice, 10e18);
        vm.warp(block.timestamp + 12 hours);
        vm.prank(guardian);
        fd.disableBridge(address(bridge));

        vm.prank(carol);
        vm.expectRevert(CascadeBase.PrimaryBridgeDisabled.selector);
        fd.closeBatch{value: 1e15}();
        assertEq(openId(), 1);

        vm.prank(alice);
        fd.cancelDeposit(10e18);
        assertEq(tao.balanceOf(alice), 1_000e18);
    }

    function test_closeBatchWhilePausedReverts() public {
        dep(alice, 10e18);
        vm.warp(block.timestamp + 12 hours);
        pauseFd();
        vm.prank(carol);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        fd.closeBatch{value: 1e15}();
    }

    // ---- self-closing requests ----

    function test_requestRedeemSelfClosesFullBatch() public {
        bridge.setFee(2e14);
        vm.prank(owner);
        fd.setBatchLimits(50, 3);
        fillRedeems(3); // pot 3e14

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.BatchClosed(1, 0, 0, 3, 2e14, 2e14);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.RedeemRequested(2, alice, 1e24);
        vm.prank(alice);
        fd.requestRedeem{value: 1e14}(1e24);

        // remainder pot 3e14 - fee 2e14 = 1e14 to alice, who paid her own 1e14 fee: net zero
        assertEq(alice.balance, 1 ether);
        assertEq(bridge.lastValue(), 2e14);
        assertEq(bridge.sendCount(), 1);
        (, CascadeMessages.Entry[] memory d, CascadeMessages.Entry[] memory r) =
            CascadeMessages.decodeBatch(bridge.lastMessage());
        assertEq(d.length, 0);
        assertEq(r.length, 3);

        (uint64 id,,, uint256 pot,, uint256 nR) = fd.openBatch();
        assertEq(id, 2);
        assertEq(pot, 1e14);
        assertEq(nR, 1);
        assertEq(fd.redeemOf(alice), 1e24);
        assertEq(address(fd).balance, 1e14);
    }

    function test_requestRedeemSelfCloseInsufficientPotReverts() public {
        vm.prank(owner);
        fd.setBatchLimits(50, 3);
        fillRedeems(3); // pot 3e14 < fee 1e15

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
        fd.closeBatch{value: 7e14}();
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
        vm.warp(block.timestamp + 12 hours);
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(); // budget 1.3e15, fee 1e15, carol +3e14
        assertEthIdentity();
        assertEq(address(fd).balance, 2e14);
        assertEq(carol.balance, 1 ether - 1e14 - 1e15 + 3e14);

        vm.warp(block.timestamp + 12 hours);
        vm.prank(carol);
        fd.closeBatch{value: 5}(); // empty: rolls and refunds
        assertEthIdentity();

        vm.prank(alice);
        fd.requestRedeem(1e24); // credit 1e14, pot 1e14
        assertEthIdentity();
        assertEq(address(fd).balance, 2e14);
        assertEq(fd.totalFeeCredit(), 1e14);
        assertEq(openPot(), 1e14);
    }

    // ---- admin ----

    function test_settersValidateAndOwnerOnly() public {
        vm.startPrank(owner);
        vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
        fd.setBatchLimits(0, 1);
        vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
        fd.setBatchLimits(101, 1);
        vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
        fd.setBatchLimits(1, 0);
        vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
        fd.setBatchLimits(1, 101);

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.LimitSet("maxDeposits", 100, 1);
        fd.setBatchLimits(100, 1);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.LimitSet("minDeposit", 2e18, 5_000e18);
        fd.setCaps(2e18, 5_000e18);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.LimitSet("maxBatchValue", 3_000e18, 0);
        fd.setMaxBatchValue(3_000e18);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.LimitSet("batchInterval", 6 hours, 0);
        fd.setBatchInterval(6 hours);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.LimitSet("redeemRequestFee", 2e14, 0);
        fd.setRedeemRequestFee(2e14);
        vm.stopPrank();

        assertEq(fd.maxDeposits(), 100);
        assertEq(fd.maxRedeems(), 1);
        assertEq(fd.minDeposit(), 2e18);
        assertEq(fd.depositCap(), 5_000e18);
        assertEq(fd.maxBatchValue(), 3_000e18);
        assertEq(fd.batchInterval(), 6 hours);
        assertEq(fd.redeemRequestFee(), 2e14);

        bytes memory unauthorized = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian);
        vm.startPrank(guardian);
        vm.expectRevert(unauthorized);
        fd.setCaps(1e18, 10_000e18);
        vm.expectRevert(unauthorized);
        fd.setBatchLimits(50, 50);
        vm.expectRevert(unauthorized);
        fd.setMaxBatchValue(4_000e18);
        vm.expectRevert(unauthorized);
        fd.setBatchInterval(12 hours);
        vm.expectRevert(unauthorized);
        fd.setRedeemRequestFee(1e14);
        vm.stopPrank();
    }

    function test_receiveRejectsEth() public {
        vm.prank(alice);
        (bool ok, bytes memory ret) = address(fd).call{value: 1}("");
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(CascadeFrontDoor.DirectTransferNotAllowed.selector));
        assertEq(address(fd).balance, 0);
    }
}
