// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {CcipBittensorAdapter} from "../../src/adapters/CcipBittensorAdapter.sol";
import {MockRouter} from "../mocks/MockRouter.sol";
import {AdaptersFixture} from "./AdaptersFixture.sol";
import {DuplicateBatch, PrimaryBridgeDisabled, UnknownPeer} from "../../src/CascadeErrors.sol";
import {RedeemDeferred} from "../../src/CascadeEvents.sol";

contract AdaptersEndToEndTest is AdaptersFixture {
    function test_fullLifecycle() public {
        uint256 stakedBefore = av.stakedValueRao(address(taoBit));
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
        // the alpha vault unstaked the 10e18 from its position, paid it out and burned the bridged token
        assertEq(stakedBefore - av.stakedValueRao(address(taoBit)), 10e9);
        assertEq(taoBit.totalSupply(), 0);

        // a day on, past the door hold (R4 B-H1), redeem all shares: A = 10e18, S = 1e25,
        // 1e25 * (10e18 + 1) / (1e25 + 1e6) = 10e18 after the rao floor
        vm.warp(vm.getBlockTimestamp() + 1 days);
        (bytes32 key, CascadeMessages.Payout[] memory list) = redeemAndRelay(fd, alice, 1e25, 2, 1);
        assertEq(list.length, 1);
        assertEq(list[0].user, alice);
        assertEq(list[0].shares, 1e25);
        assertEq(list[0].assets, 10e18);
        assertEq(vault.balanceOf(alice), 0);
        assertEq(vaultLens.pendingPayouts(), 10e18);
        // a redeem-only batch carries no token
        assertEq(routerBase.sendAt(1).tokenAmounts.length, 0);

        pay(key, list);
        uint256 net = 10e18 - FEE;
        assertEq(routerBit.sendCount(), 1);
        assertEq(routerBit.lastSend().tokenAmounts[0].amount, net);
        assertEq(vaultLens.pendingPayouts(), 0);

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

    /// A payout below the conversion floor could never be sent: the Bittensor adapter reverts
    /// BelowConversionFloor for its chunk on every processPayouts, and only the owner's cancel frees it.
    /// Here alice keeps 2.5e21 shares (0.0025 TAO) and asks for 1e22: the vault's clip to her balance
    /// leaves 0.0025 TAO, which after the 0.001 TAO fee would net 0.0015 TAO, under the 0.002 TAO floor.
    /// The vault defers it instead (below 0.01 TAO), so nothing unpayable is queued; her first payout,
    /// queued before it, goes out as usual.
    function test_redeemBelowConversionFloorIsDeferredNotQueued() public {
        depositAndRelay(fd, alice, 10e18, 0);
        // A = 10e18, S = 1e25: (1e25 - 2.5e21) * (10e18 + 1) / (1e25 + 1e6) = 9.9975e18
        (bytes32 k1, CascadeMessages.Payout[] memory list) = redeemAndRelay(fd, alice, 1e25 - 2.5e21, 2, 1);
        assertEq(list[0].assets, 9.9975e18);
        assertEq(vault.balanceOf(alice), 2.5e21);

        requestVia(fd, alice, 1e22);
        bytes32 k2 = keyOf(BASE, address(fd), 3, noEntries(), entries1(alice, 1e22));
        close(fd);
        vm.expectEmit(address(vault));
        emit RedeemDeferred(k2, alice, 1e22);
        (bool ok,) = relayToBittensor(2);
        assertTrue(ok);
        assertTrue(vaultLens.processed(k2));
        assertEq(vaultLens.getPayoutBatch(k2).count, 0);
        assertEq(vault.balanceOf(alice), 2.5e21);
        assertEq(vaultLens.pendingPayouts(), 9.9975e18);

        pay(k1, list);
        assertEq(vaultLens.pendingPayouts(), 0);
        (ok,) = relayToBase(0);
        assertTrue(ok);
        assertEq(fd.claimable(alice), 9.9975e18 - FEE);
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
        // nothing is staked, so each window allows the 100 TAO floor, and the doors share it in the global
        // window (Task 17): alice's 100 TAO spends it, so bob's request goes in the next day's window
        vm.warp(vm.getBlockTimestamp() + 1 days);
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

    /// The park key of router send `i` toward Bittensor (spec §3.2): keccak256(abi.encode(the source chain, the
    /// payload's sender, its recipient, its message)).
    function parkKeyOf(uint256 i) internal view returns (bytes32) {
        (address recipient, address sender, bytes memory message) = adapterBit.decodePayload(routerBase.sendAt(i).data);
        return keccak256(abi.encode(BASE, sender, recipient, message));
    }

    /// Batch `i`'s park: amount and whether it is native TAO.
    function parkOf(uint256 i) internal view returns (uint256 amount, bool converted) {
        (uint128 a,, bool c) = adapterBit.parked(parkKeyOf(i));
        return (a, c);
    }

    /// A delivery into a paused vault no longer fails the CCIP message (v3.1 left it in FAILURE, whose re-execution
    /// failed again until the vault reopened): since Task 25 the Bittensor adapter converts the tokens and parks the
    /// native TAO under the batch's record, and the message succeeds. A replay of the same message (the real lane
    /// never runs one twice) meets the record, AlreadyParked, even once the vault reopens: a park is delivered by
    /// Task 26's deliverParked.
    function test_pausedVaultParksTheBatch() public {
        depositVia(fd, alice, 10e18);
        close(fd);
        vm.prank(guardian);
        vault.pause();

        MockRouter.Sent memory s = routerBase.sendAt(0);
        vm.expectEmit(address(adapterBit));
        emit CcipBittensorAdapter.BatchParked(
            parkKeyOf(0), s.messageId, address(vault), address(fd), 10e18, true, Pausable.EnforcedPause.selector
        );
        (bool ok,) = relayToBittensor(0);
        assertTrue(ok, "SUCCESS: the batch parked");
        (uint256 amount, bool converted) = parkOf(0);
        assertEq(amount, 10e18);
        assertTrue(converted);
        assertEq(adapterBit.parkedNative(), 10e18);
        assertAdaptersHold(ED + 10e18);
        assertEq(vault.balanceOf(alice), 0);
        assertEq(address(vault).balance, ED);

        vm.prank(owner);
        vault.unpause();
        bytes memory reason;
        (ok, reason) = relayToBittensor(0);
        assertFalse(ok);
        assertEq(inner(reason), abi.encodeWithSelector(CcipBittensorAdapter.AlreadyParked.selector));
        assertAdaptersHold(ED + 10e18);
        assertEq(vault.balanceOf(alice), 0);
    }

    /// A replayed delivery (the router double allows one; the real lane executes a message at most once) is refused
    /// by the vault as a duplicate, and since Task 25 the adapter parks the replay's converted TAO under its record
    /// rather than failing: the vault's books and balance are untouched.
    function test_redeliveryAfterSuccessParksAsDuplicate() public {
        depositVia(fd, alice, 10e18);
        close(fd);
        (bool ok,) = relayToBittensor(0);
        assertTrue(ok);
        uint256 supply = vault.totalSupply();

        MockRouter.Sent memory s = routerBase.sendAt(0);
        vm.expectEmit(address(adapterBit));
        emit CcipBittensorAdapter.BatchParked(
            parkKeyOf(0), s.messageId, address(vault), address(fd), 10e18, true, DuplicateBatch.selector
        );
        (ok,) = relayToBittensor(0);
        assertTrue(ok, "the replay parked");
        (uint256 amount, bool converted) = parkOf(0);
        assertEq(amount, 10e18, "the replay's record");
        assertTrue(converted, "as native TAO");
        assertEq(adapterBit.parkedNative(), 10e18);
        assertEq(adapterBit.parkedTokens(), 0);
        assertEq(vault.totalSupply(), supply);
        assertEq(vault.balanceOf(alice), supply);
        assertAdaptersHold(ED + 10e18);
        assertEq(address(vault).balance, ED + 10e18);
    }

    /// Anyone may send through the Base adapter, but a batch from a sender the vault does not know is refused
    /// (UnknownPeer) and, since Task 25, parked as native TAO under its own record (refundable to that sender after
    /// PARK_TIMEOUT, Task 27): it strands only itself, and the vault is untouched.
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

        MockRouter.Sent memory s = routerBase.sendAt(0);
        vm.expectEmit(address(adapterBit));
        emit CcipBittensorAdapter.BatchParked(
            parkKeyOf(0), s.messageId, address(vault), stranger, 1e18, true, UnknownPeer.selector
        );
        (bool ok,) = relayToBittensor(0);
        assertTrue(ok);
        (uint256 amount, bool converted) = parkOf(0);
        assertEq(amount, 1e18);
        assertTrue(converted);
        assertEq(vault.totalSupply(), 0);
        assertEq(vault.balanceOf(stranger), 0);
        assertEq(taoBase.balanceOf(address(routerBase)), 1e18);
        assertAdaptersHold(ED + 1e18);
        assertEq(address(vault).balance, ED);
    }

    /// I-9 end to end (Task 27): a refund credits each depositor exactly their deposit on Base, as a payout from the
    /// door's vault. Batch 0 (alice 10 TAO, bob 5) parks as native TAO (the vault paused) and batch 1 (alice 3) as
    /// tokens (ForeverMoney paused). After PARK_TIMEOUT anyone refunds both at the quoted fee: the Bittensor adapter
    /// sends each as PAYOUTS(the park key, REFUND_CHUNK, the batch's deposits) with the vault as the payload's sender
    /// and the door as its recipient, and the Base adapter delivers them to the door, which credits alice 10 + 3 and
    /// bob 5, netForwarded falling by each refund (18 to 3 to 0) and the door holding exactly what it owes. They claim
    /// back exactly what they deposited; the vault never minted, and neither adapter keeps anything but the reserve.
    function test_refundCreditsEachDepositorOnBase() public {
        depositVia(fd, alice, 10e18);
        depositVia(fd, bob, 5e18);
        close(fd);
        assertEq(fd.netForwarded(), 15e18);
        vm.prank(guardian);
        vault.pause();
        (bool ok,) = relayToBittensor(0);
        assertTrue(ok);
        (uint256 amount, bool converted) = parkOf(0);
        assertEq(amount, 15e18);
        assertTrue(converted, "parked as native TAO");

        depositVia(fd, alice, 3e18);
        close(fd);
        assertEq(fd.netForwarded(), 18e18);
        holdRail();
        (ok,) = relayToBittensor(1);
        assertTrue(ok);
        (amount, converted) = parkOf(1);
        assertEq(amount, 3e18);
        assertFalse(converted, "parked as tokens");
        av.unpause();
        assertEq(adapterBit.parkedNative(), 15e18);
        assertEq(adapterBit.parkedTokens(), 3e18);

        vm.warp(vm.getBlockTimestamp() + adapterBit.PARK_TIMEOUT());
        for (uint256 i; i < 2; ++i) {
            (address recipient, address sender, bytes memory message) =
                adapterBit.decodePayload(routerBase.sendAt(i).data);
            assertEq(recipient, address(vault));
            assertEq(sender, address(fd));
            uint256 quote = adapterBit.quoteRefund(recipient, sender, message);
            assertEq(quote, FEE);
            vm.prank(bob);
            adapterBit.refundParked{value: quote}(recipient, sender, message);
        }
        assertEq(routerBit.sendCount(), 2);
        CascadeMessages.Entry[] memory first = new CascadeMessages.Entry[](2);
        first[0] = CascadeMessages.Entry(alice, 10e18);
        first[1] = CascadeMessages.Entry(bob, 5e18);
        bytes32 key0 = parkKeyOf(0);
        bytes32 key1 = parkKeyOf(1);
        uint32 chunk = adapterBit.REFUND_CHUNK();
        assertEq(chunk, type(uint32).max);
        assertEq(
            routerBit.sendAt(0).data,
            abi.encode(address(fd), address(vault), CascadeMessages.encodePayouts(key0, chunk, first)),
            "PAYOUTS of each deposit, from the vault to the door"
        );
        assertEq(routerBit.sendAt(0).tokenAmounts[0].amount, 15e18);
        assertEq(
            routerBit.sendAt(1).data,
            abi.encode(address(fd), address(vault), CascadeMessages.encodePayouts(key1, chunk, entries1(alice, 3e18)))
        );
        assertEq(routerBit.sendAt(1).tokenAmounts[0].amount, 3e18);
        assertEq(adapterBit.parkedNative(), 0);
        assertEq(adapterBit.parkedTokens(), 0);

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.PayoutsDelivered(key0, chunk, 15e18, address(adapterBase));
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.PayoutReceived(key0, chunk, alice, 10e18);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.PayoutReceived(key0, chunk, bob, 5e18);
        (ok,) = relayToBase(0);
        assertTrue(ok, "the door took the refund as a payout from its vault");
        assertEq(fd.claimable(alice), 10e18);
        assertEq(fd.claimable(bob), 5e18);
        assertEq(fd.netForwarded(), 3e18, "netForwarded fell by the refund");

        (ok,) = relayToBase(1);
        assertTrue(ok);
        assertEq(fd.claimable(alice), 13e18);
        assertEq(fd.claimable(bob), 5e18);
        assertEq(fd.netForwarded(), 0);
        assertEq(fd.totalClaimable(), 18e18);
        assertEq(taoBase.balanceOf(address(fd)), 18e18, "the door holds what it owes");

        vm.prank(alice);
        fd.claim();
        vm.prank(bob);
        fd.claim();
        assertEq(taoBase.balanceOf(alice), 1_000e18, "alice has her 13 TAO back");
        assertEq(taoBase.balanceOf(bob), 1_000e18, "bob has his 5 TAO back");
        assertEq(fd.totalClaimable(), 0);
        assertEq(taoBase.balanceOf(address(fd)), 0);
        assertEq(vault.totalSupply(), 0, "never minted");
        assertEq(address(vault).balance, ED);
        assertAdaptersHold(ED);
    }

    /// I-9's other half end to end (review M1): a parked batch that carries a redeem beside its deposit refunds the
    /// deposit alone, and the redeem leaves nothing behind on either side. Bob holds 5e24 shares from a delivered
    /// batch. Batch 2 carries alice's 10 TAO deposit and bob's request for all his shares, and parks as native TAO
    /// (the vault paused). Its refund is PAYOUTS(the park key, REFUND_CHUNK, [(alice, 10e18)]) alone, and the door
    /// credits alice 10 and bob nothing, netForwarded falling by alice's 10 to bob's 5. On Base bob has no credit, no
    /// fee credit and no token back. On Bittensor his shares are intact, the vault never recorded the batch or
    /// queued a payout, and the adapter keeps nothing parked. Once the vault reopens, bob's shares are redeemed in a
    /// new batch as usual.
    function test_refundOfAMixedBatchCreditsOnlyItsDepositors() public {
        depositAndRelay(fd, bob, 5e18, 0);
        assertEq(vault.balanceOf(bob), 5e24);
        uint256 bobOnBase = taoBase.balanceOf(bob);

        depositVia(fd, alice, 10e18);
        requestVia(fd, bob, 5e24);
        close(fd);
        assertEq(fd.netForwarded(), 15e18);
        bytes32 batchKey = keyOf(BASE, address(fd), 2, entries1(alice, 10e18), entries1(bob, 5e24));
        (address recipient, address sender, bytes memory message) = adapterBit.decodePayload(routerBase.sendAt(1).data);
        assertEq(message, CascadeMessages.encodeBatch(2, entries1(alice, 10e18), entries1(bob, 5e24)), "mixed");
        vm.prank(guardian);
        vault.pause();
        (bool ok,) = relayToBittensor(1);
        assertTrue(ok);
        (uint256 amount, bool converted) = parkOf(1);
        assertEq(amount, 10e18, "the deposit alone");
        assertTrue(converted);
        assertEq(vault.balanceOf(bob), 5e24, "not burned");

        vm.warp(vm.getBlockTimestamp() + adapterBit.PARK_TIMEOUT());
        uint256 quote = adapterBit.quoteRefund(recipient, sender, message);
        vm.prank(keeper);
        adapterBit.refundParked{value: quote}(recipient, sender, message);
        bytes32 parkKey = parkKeyOf(1);
        uint32 chunk = adapterBit.REFUND_CHUNK();
        assertEq(routerBit.sendCount(), 1);
        assertEq(
            routerBit.sendAt(0).data,
            abi.encode(
                address(fd), address(vault), CascadeMessages.encodePayouts(parkKey, chunk, entries1(alice, 10e18))
            ),
            "PAYOUTS of the deposit alone"
        );
        assertEq(routerBit.sendAt(0).tokenAmounts[0].amount, 10e18);

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.PayoutsDelivered(parkKey, chunk, 10e18, address(adapterBase));
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.PayoutReceived(parkKey, chunk, alice, 10e18);
        (ok,) = relayToBase(0);
        assertTrue(ok);
        assertEq(fd.claimable(alice), 10e18);
        assertEq(fd.claimable(bob), 0, "the redeemer is credited nothing");
        assertEq(fd.netForwarded(), 5e18, "fell by the deposit alone");
        assertEq(fd.totalClaimable(), 10e18);
        assertEq(taoBase.balanceOf(address(fd)), 10e18, "the door holds what it owes");
        assertEq(fd.feeCredit(bob), 0);
        assertEq(taoBase.balanceOf(bob), bobOnBase);
        vm.prank(alice);
        fd.claim();
        assertEq(taoBase.balanceOf(alice), 1_000e18, "alice has her 10 TAO back");

        assertEq(vault.balanceOf(bob), 5e24, "bob's shares intact");
        assertEq(vault.totalSupply(), 5e24);
        assertEq(address(vault).balance, ED + 5e18);
        assertEq(vaultLens.pendingPayouts(), 0, "no payout queued");
        assertFalse(vaultLens.processed(batchKey), "the vault never recorded the batch");
        assertEq(vaultLens.getPayoutBatch(batchKey).count, 0);
        assertEq(adapterBit.parkedNative(), 0);
        assertEq(adapterBit.parkedTokens(), 0);
        assertAdaptersHold(ED);

        vm.prank(owner);
        vault.unpause();
        (, CascadeMessages.Payout[] memory list) = redeemAndRelay(fd, bob, 5e24, 3, 2);
        assertEq(list.length, 1);
        assertEq(list[0].user, bob);
        assertEq(list[0].assets, 5e18, "redeemed as usual");
        assertEq(vault.balanceOf(bob), 0);
    }

    /// A refund through a disabled Base twin (spec §3.2's tests, the front door's side; I-9): the door's inbound check
    /// is bridgeKnown, so a Base adapter the door has disabled since the batch left (known, no longer enabled) still
    /// delivers the refund, and the door credits each depositor exactly their deposit. Batch 0 (alice 10 TAO, bob 5)
    /// parks as native TAO (the vault paused); then the guardian disables the door's primary, adapterBase, which stops
    /// the door's closes (PrimaryBridgeDisabled) and nothing else. After PARK_TIMEOUT the refund arrives through it and
    /// is credited as a payout from the door's vault, and both claim their TAO back.
    function test_refundThroughADisabledBaseTwinCreditsEachDepositor() public {
        depositVia(fd, alice, 10e18);
        depositVia(fd, bob, 5e18);
        close(fd);
        vm.prank(guardian);
        vault.pause();
        (bool ok,) = relayToBittensor(0);
        assertTrue(ok);
        (uint256 amount, bool converted) = parkOf(0);
        assertEq(amount, 15e18);
        assertTrue(converted, "parked as native TAO");

        vm.prank(guardian);
        fd.disableBridge(address(adapterBase));
        assertFalse(doorLens.bridgeEnabled(address(adapterBase)));
        assertTrue(doorLens.bridgeKnown(address(adapterBase)));
        depositVia(fd, alice, 1e18);
        (uint64 id,,,,,) = fd.openBatch();
        vm.warp(vm.getBlockTimestamp() + 12 hours);
        vm.prank(keeper);
        vm.expectRevert(PrimaryBridgeDisabled.selector);
        fd.closeBatch{value: FEE}(id, 0);

        vm.warp(vm.getBlockTimestamp() + adapterBit.PARK_TIMEOUT());
        (address recipient, address sender, bytes memory message) = adapterBit.decodePayload(routerBase.sendAt(0).data);
        uint256 quote = adapterBit.quoteRefund(recipient, sender, message);
        vm.prank(keeper);
        adapterBit.refundParked{value: quote}(recipient, sender, message);
        bytes32 parkKey = parkKeyOf(0);
        uint32 chunk = adapterBit.REFUND_CHUNK();
        CascadeMessages.Entry[] memory deposits = new CascadeMessages.Entry[](2);
        deposits[0] = CascadeMessages.Entry(alice, 10e18);
        deposits[1] = CascadeMessages.Entry(bob, 5e18);
        assertEq(
            routerBit.sendAt(0).data,
            abi.encode(address(fd), address(vault), CascadeMessages.encodePayouts(parkKey, chunk, deposits)),
            "PAYOUTS of each deposit, from the vault to the door"
        );

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.PayoutsDelivered(parkKey, chunk, 15e18, address(adapterBase));
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.PayoutReceived(parkKey, chunk, alice, 10e18);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.PayoutReceived(parkKey, chunk, bob, 5e18);
        (ok,) = relayToBase(0);
        assertTrue(ok, "the disabled twin delivered the refund");
        assertEq(fd.claimable(alice), 10e18);
        assertEq(fd.claimable(bob), 5e18);
        assertEq(fd.netForwarded(), 0, "fell by the refund");
        assertTrue(
            fd.delivered(address(adapterBase), keccak256(CascadeMessages.encodePayouts(parkKey, chunk, deposits)))
        );
        // the door holds the open deposit and what it owes
        assertEq(taoBase.balanceOf(address(fd)), 16e18);

        vm.prank(alice);
        fd.claim();
        vm.prank(bob);
        fd.claim();
        vm.prank(alice);
        fd.cancelDeposit(1e18);
        assertEq(taoBase.balanceOf(alice), 1_000e18, "alice has her 11 TAO back");
        assertEq(taoBase.balanceOf(bob), 1_000e18, "bob has his 5 TAO back");
        assertEq(taoBase.balanceOf(address(fd)), 0);
        assertEq(vault.totalSupply(), 0, "never minted");
        assertEq(adapterBit.parkedNative(), 0);
        assertAdaptersHold(ED);
    }

    function test_oversizedBatchLeavesBatchOpen() public {
        depositVia(fd, alice, 10e18);
        routerBase.setMaxDataBytes(100);
        (uint64 id, uint64 start,,,,) = fd.openBatch();
        vm.warp(vm.getBlockTimestamp() + 12 hours);
        // the payload is the batch plus two addresses, well over 100 bytes
        vm.prank(keeper);
        vm.expectPartialRevert(MockRouter.DataTooLarge.selector);
        fd.closeBatch{value: FEE}(id, 10e18);

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
        fd.closeBatch{value: FEE}(id, 10e18);
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
