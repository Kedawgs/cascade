// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {Client} from "../../src/vendor/ccip/Client.sol";
import {AdaptersFixture} from "./AdaptersFixture.sol";

/// @notice An honest action after a forged park (the R4 review, Minor 8): the forged-lane campaign judges each forged
/// call from a snapshot it reverts, so it never sees a later honest call on what a forged call left. Here a
/// compromised router hands the Bittensor adapter two forged batches that carry their own tokens, from the door to the
/// vault, for mallory, who never deposited on Base: one while the vault is paused (it converts, then parks as native
/// TAO), one while ForeverMoney is paused (it parks as tokens). Then anyone's deliverParked of the first mints mallory
/// the TAO it brought, and anyone's refundParked of the second, past PARK_TIMEOUT, sends its tokens to the door, which
/// credits mallory exactly them. Through all of it I-7 holds (the adapter's books cover every park and the booked
/// cushion), the vault's holders lose nothing, and the door's books hold (its tokens cover the open batch and every
/// credit). A forged batch that brought real tokens is, to everyone after it, an honest delivery of those tokens.
contract ForgedParkHonestActionsTest is AdaptersFixture {
    address mallory = makeAddr("mallory");

    /// The forged BATCH a compromised router delivers to the Bittensor adapter: from its paired Base adapter, payload
    /// (vault, door, a deposit of `amount` for mallory), carrying `amount` of the bridged token minted to the adapter.
    function forged(uint64 batchId, uint256 amount) internal returns (bytes memory message) {
        message = CascadeMessages.encodeBatch(batchId, entries1(mallory, amount), noEntries());
        taoBit.mint(address(adapterBit), amount);
        Client.EVMTokenAmount[] memory t = new Client.EVMTokenAmount[](1);
        t[0] = Client.EVMTokenAmount(address(taoBit), amount);
        Client.Any2EVMMessage memory m = Client.Any2EVMMessage({
            messageId: keccak256(abi.encode("forged", batchId)),
            sourceChainSelector: BASE_SELECTOR,
            sender: abi.encode(address(adapterBase)),
            data: adapterBit.encodePayload(address(vault), address(fd), message),
            destTokenAmounts: t
        });
        vm.prank(address(routerBit));
        adapterBit.ccipReceive(m);
    }

    function parkKey(bytes memory message) internal view returns (bytes32) {
        return keccak256(abi.encode(BASE, address(fd), address(vault), message));
    }

    /// I-7 with the booked cushion: the adapter's native balance covers its native parks, its tokens its token parks and
    /// the cushion.
    function assertAdapterBooks() internal view {
        assertGe(address(adapterBit).balance, adapterBit.parkedNative(), "I-7: native");
        assertGe(
            taoBit.balanceOf(address(adapterBit)), adapterBit.parkedTokens() + adapterBit.tokenCushion(), "I-7: tokens"
        );
    }

    /// The door's books: its tokens cover the open batch's deposits and every credit.
    function assertDoorBooks() internal view {
        (,, uint256 openDeposits,,,) = fd.openBatch();
        assertGe(taoBase.balanceOf(address(fd)), openDeposits + fd.totalClaimable(), "the door's books");
    }

    function test_anHonestDeliveryAndRefundAfterForgedParks() public {
        // alice, an honest holder of long standing
        depositAndRelay(fd, alice, 10e18, 0);
        matureShares(alice);
        uint256 aliceShares = vault.balanceOf(alice);
        uint256 aliceValue = vaultLens.totalAssets();

        // forged batch 1, the vault paused: converted, then parked as native TAO
        vm.prank(guardian);
        vault.pause();
        bytes memory m1 = forged(1001, 2e18);
        (uint128 a1,, bool c1) = adapterBit.parked(parkKey(m1));
        assertEq(a1, 2e18);
        assertTrue(c1, "converted");
        vm.prank(owner);
        vault.unpause();

        // forged batch 2, ForeverMoney paused: parked as tokens
        holdRail();
        bytes memory m2 = forged(1002, 3e18);
        (uint128 a2,, bool c2) = adapterBit.parked(parkKey(m2));
        assertEq(a2, 3e18);
        assertFalse(c2, "tokens");
        av.unpause();
        assertAdapterBooks();

        // anyone delivers the native park: the vault mints mallory what the forged batch brought, and nobody else moves
        adapterBit.deliverParked(address(vault), address(fd), m1);
        (, uint64 gone,) = adapterBit.parked(parkKey(m1));
        assertEq(gone, 0, "delivered");
        assertGt(vault.balanceOf(mallory), 0, "mallory's 2 TAO minted");
        assertEq(vaultLens.totalAssets(), aliceValue + 2e18, "the vault took exactly the TAO it was brought");
        assertEq(vault.balanceOf(alice), aliceShares, "alice untouched");
        assertGe(vaultLens.price(), 1e12, "the price did not fall");
        assertAdapterBooks();

        // past PARK_TIMEOUT anyone refunds the token park: its tokens go to the door, which credits mallory exactly them
        vm.warp(vm.getBlockTimestamp() + adapterBit.PARK_TIMEOUT());
        uint256 fee = adapterBit.quoteRefund(address(vault), address(fd), m2);
        uint256 sends = routerBit.sendCount();
        vm.deal(bob, fee);
        vm.prank(bob);
        adapterBit.refundParked{value: fee}(address(vault), address(fd), m2);
        (, gone,) = adapterBit.parked(parkKey(m2));
        assertEq(gone, 0, "refunded");
        assertEq(adapterBit.parkedTokens() + adapterBit.parkedNative(), 0, "nothing parked");
        assertAdapterBooks();

        uint256 claimableBefore = fd.claimable(mallory);
        uint256 aliceCredit = fd.claimable(alice);
        (bool ok,) = relayToBase(sends);
        assertTrue(ok, "the refund delivered on Base");
        assertEq(fd.claimable(mallory), claimableBefore + 3e18, "mallory credited exactly the tokens that came");
        assertEq(fd.claimable(alice), aliceCredit, "alice's credit untouched");
        assertDoorBooks();
    }
}
