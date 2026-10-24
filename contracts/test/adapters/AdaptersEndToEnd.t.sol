// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {MockRouter} from "../mocks/MockRouter.sol";
import {AdaptersFixture} from "./AdaptersFixture.sol";

contract AdaptersEndToEndTest is AdaptersFixture {
    function test_fullLifecycle() public {
        uint256 avBefore = address(av).balance;
        depositVia(fd, alice, 10e18);
        close(fd);
        assertEq(routerBase.sendCount(), 1);
        assertEq(taoBase.balanceOf(address(routerBase)), 10e18);
        (bool ok,) = relayToBittensor(0);
        assertTrue(ok);
        // A = 0, S = 0: 10e18 * (0 + 1e6) / (0 + 1) = 1e25
        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(vault.totalSupply(), 1e25);
        assertEq(address(vault).balance, ED + 10e18);
        // the alpha vault paid the 10e18 out and burned the bridged token
        assertEq(avBefore - address(av).balance, 10e18);
        assertEq(taoBit.totalSupply(), 0);

        // redeem all shares: A = 10e18, S = 1e25, 1e25 * (10e18 + 1) / (1e25 + 1e6) = 10e18 after the rao floor
        (bytes32 key, CascadeMessages.Payout[] memory list) = redeemAndRelay(fd, alice, 1e25, 2, 1);
        assertEq(list.length, 1);
        assertEq(list[0].user, alice);
        assertEq(list[0].shares, 1e25);
        assertEq(list[0].assets, 10e18);
        assertEq(vault.balanceOf(alice), 0);
        assertEq(vault.pendingPayouts(), 10e18);
        // a redeem-only batch carries no token
        assertEq(routerBase.sendAt(1).tokenAmounts.length, 0);

        pay(key, list);
        uint256 net = 10e18 - FEE;
        assertEq(routerBit.sendCount(), 1);
        assertEq(routerBit.lastSend().tokenAmounts[0].amount, net);
        assertEq(vault.pendingPayouts(), 0);

        (ok,) = relayToBase(0);
        assertTrue(ok);
        assertEq(fd.claimable(alice), net);
        vm.prank(alice);
        fd.claim();

        assertEq(taoBase.balanceOf(alice), 1_000e18 - 10e18 + net);
        assertAdaptersHold(ED);
        assertEq(taoBase.balanceOf(address(fd)), 0);
        // the vault's fee equals the router's, so nothing is left over on top of the reserve
        assertEq(address(adapterBit).balance, ED);
        assertEq(address(vault).balance, ED);
        assertEq(vault.totalSupply(), 0);
    }

    function test_twoFrontDoorsThroughOneAdapter() public {
        CascadeFrontDoor fd2 = newFrontDoor();
        registerFrontDoor(BASE, address(fd2));
        vm.prank(bob);
        taoBase.approve(address(fd2), type(uint256).max);

        // alice at A = 0, S = 0: 100e18 * 1e6 = 1e26; bob at A = 100e18, S = 1e26: 1e26
        depositAndRelay(fd, alice, 100e18, 0);
        depositAndRelay(fd2, bob, 100e18, 1);
        assertEq(vault.balanceOf(alice), 1e26);
        assertEq(vault.balanceOf(bob), 1e26);

        (bytes32 k1, CascadeMessages.Payout[] memory list1) = redeemAndRelay(fd, alice, 1e26, 2, 2);
        (bytes32 k2, CascadeMessages.Payout[] memory list2) = redeemAndRelay(fd2, bob, 1e26, 2, 3);
        assertEq(list1.length, 1);
        assertEq(list2.length, 1);
        assertEq(list1[0].user, alice);
        assertEq(list2[0].user, bob);
        // A = 100e18, S = 1e26 at alice's redeem: 1e26 * (100e18 + 1) / (1e26 + 1e6) = 100e18; likewise bob's
        assertEq(list1[0].shares, 1e26);
        assertEq(list1[0].assets, 100e18);
        assertEq(list2[0].shares, 1e26);
        assertEq(list2[0].assets, 100e18);

        pay(k1, list1);
        pay(k2, list2);
        assertEq(routerBit.sendCount(), 2);
        (bool ok,) = relayToBase(0);
        assertTrue(ok);
        (ok,) = relayToBase(1);
        assertTrue(ok);

        // the payload names the recipient, so each payout reached its own door
        assertEq(fd.claimable(alice), list1[0].assets - FEE);
        assertEq(fd2.claimable(bob), list2[0].assets - FEE);
        assertEq(fd.claimable(bob), 0);
        assertEq(fd2.claimable(alice), 0);
        assertEq(taoBase.balanceOf(address(fd)), list1[0].assets - FEE);
        assertEq(taoBase.balanceOf(address(fd2)), list2[0].assets - FEE);
        assertAdaptersHold(ED);
    }

    function test_failedDeliveryIsRetried() public {
        depositVia(fd, alice, 10e18);
        close(fd);
        vm.prank(guardian);
        vault.pause();

        (bool ok, bytes memory reason) = relayToBittensor(0);
        assertFalse(ok);
        assertEq(inner(reason), abi.encodeWithSelector(Pausable.EnforcedPause.selector));
        // atomic: no token minted, nothing converted
        assertAdaptersHold(ED);
        assertEq(taoBit.totalSupply(), 0);
        assertEq(vault.balanceOf(alice), 0);
        assertEq(address(vault).balance, ED);

        vm.prank(owner);
        vault.unpause();
        (ok,) = relayToBittensor(0);
        assertTrue(ok);
        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(address(vault).balance, ED + 10e18);
        assertAdaptersHold(ED);
    }

    function test_redeliveryAfterSuccessIsRejected() public {
        depositVia(fd, alice, 10e18);
        close(fd);
        (bool ok,) = relayToBittensor(0);
        assertTrue(ok);
        uint256 supply = vault.totalSupply();

        bytes memory reason;
        (ok, reason) = relayToBittensor(0);
        assertFalse(ok);
        assertEq(inner(reason), abi.encodeWithSelector(CascadeVault.DuplicateBatch.selector));
        assertEq(vault.totalSupply(), supply);
        assertEq(vault.balanceOf(alice), supply);
        assertAdaptersHold(ED);
        assertEq(address(vault).balance, ED + 10e18);
    }

    function test_strangerSendStrandsOnlyItself() public {
        address stranger = makeAddr("stranger");
        taoBase.mint(stranger, 1e18);
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        taoBase.approve(address(adapterBase), 1e18);
        bytes memory batch = CascadeMessages.encodeBatch(1, entries1(stranger, 1e18), noEntries());
        vm.prank(stranger);
        adapterBase.send{value: FEE}(BITTENSOR, address(vault), batch, 1e18);
        assertEq(taoBase.balanceOf(stranger), 0);

        (bool ok, bytes memory reason) = relayToBittensor(0);
        assertFalse(ok);
        assertEq(bytes4(inner(reason)), CascadeVault.UnknownPeer.selector);
        assertEq(vault.totalSupply(), 0);
        assertEq(vault.balanceOf(stranger), 0);
        assertEq(taoBase.balanceOf(address(routerBase)), 1e18);
        assertAdaptersHold(ED);
        assertEq(address(vault).balance, ED);
    }

    function test_oversizedBatchLeavesBatchOpen() public {
        depositVia(fd, alice, 10e18);
        routerBase.setMaxDataBytes(100);
        (uint64 id, uint64 start,,,,) = fd.openBatch();
        vm.warp(block.timestamp + 12 hours);
        // the payload is the batch plus two addresses, well over 100 bytes
        vm.prank(keeper);
        vm.expectPartialRevert(MockRouter.DataTooLarge.selector);
        fd.closeBatch{value: FEE}();

        (uint64 id2, uint64 start2,,,,) = fd.openBatch();
        assertEq(id2, id);
        assertEq(start2, start);
        assertEq(routerBase.sendCount(), 0);
        assertAdaptersHold(ED);
        assertEq(taoBase.balanceOf(address(fd)), 10e18);
        assertEq(taoBase.balanceOf(address(routerBase)), 0);

        // restored, the same batch goes out
        routerBase.setMaxDataBytes(32_000);
        vm.prank(keeper);
        fd.closeBatch{value: FEE}();
        (bool ok,) = relayToBittensor(0);
        assertTrue(ok);
        assertAdaptersHold(ED);
    }

    function test_payoutFeeExcessStaysInAdapter() public {
        depositAndRelay(fd, alice, 10e18, 0);
        (bytes32 key, CascadeMessages.Payout[] memory list) = redeemAndRelay(fd, alice, 1e25, 2, 1);
        assertEq(list[0].assets, 10e18);

        // the router wants 1e15 + 1; the vault rounds that up to whole rao (1e15 + 1e9) and sends
        // net + roundedFee; the adapter pays the router exactly 1e15 + 1 and keeps the 1e9 - 1
        routerBit.setFee(FEE + 1);
        uint256 roundedFee = FEE + 1e9;
        pay(key, list);
        uint256 net = 10e18 - roundedFee;
        assertEq(routerBit.lastSend().tokenAmounts[0].amount, net);
        assertEq(routerBit.lastSend().value, FEE + 1);
        assertEq(address(routerBit).balance, FEE + 1);
        assertEq(address(adapterBit).balance, ED + 1e9 - 1);
        assertAdaptersHold(ED + 1e9 - 1);

        (bool ok,) = relayToBase(0);
        assertTrue(ok);
        assertEq(fd.claimable(alice), net);
        assertAdaptersHold(ED + 1e9 - 1);
    }
}
