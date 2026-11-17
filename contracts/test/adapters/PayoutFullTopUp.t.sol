// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CcipAdapterBase} from "../../src/adapters/CcipAdapterBase.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {PayoutChunkSent} from "../../src/CascadeEvents.sol";
import {AdaptersFixture} from "./AdaptersFixture.sol";

/// @notice The full top-up (spec §3.3, I-13; R4, an outside review): the Bittensor adapter refuses a send below the
/// chain's live minimum stake, checked on the chunk's net, after the entries' fee. A floor raised between a chunk's net
/// and its gross would strand it, a bounce-only batch for good (it cannot be cancelled). A caller whose value covers the
/// whole fee pays all of it: the entries are charged nothing and sent their gross, the caller is refunded the rest,
/// last, and nothing else moves. Through the real adapters, over the mock routers and alpha vault; the router's fee is
/// 0.001 TAO, within the fee ceiling, so the entries' share is the whole fee and the keeper's top-up is 0.
contract PayoutFullTopUpTest is AdaptersFixture {
    /// bob's bounced deposit queued alone: alice deposits 10 TAO, a loss takes the vault below half the launch price,
    /// and bob's 0.04 TAO deposit bounces (no shares).
    function bounceOnly() internal returns (bytes32 key, CascadeMessages.Payout[] memory list) {
        depositAndRelay(fd, alice, 10e18, 0);
        vm.deal(address(vault), ED + 1e18);
        depositVia(fd, bob, 0.04e18);
        key = keyOf(BASE, address(fd), 2, entries1(bob, 0.04e18), noEntries());
        close(fd);
        (bool ok,) = relayToBittensor(1);
        assertTrue(ok, "delivered");
        assertEq(vaultLens.getPayoutBatch(key).count, 1, "the bounce queued");
        list = new CascadeMessages.Payout[](1);
        list[0] = CascadeMessages.Payout(bob, 0, 0.04e18);
    }

    /// processPayouts of `key` by the keeper with `value`, expected to revert at the adapter: the chunk's net, its gross
    /// less the fee, below the raised floor.
    function expectBelowFloor(bytes32 key, CascadeMessages.Payout[] memory list, uint256 gross, uint256 value)
        internal
    {
        vm.expectRevert(abi.encodeWithSelector(CcipAdapterBase.BelowConversionFloor.selector, gross - FEE, gross));
        vm.prank(keeper);
        vault.processPayouts{value: value}(key, list, 50);
    }

    /// The whole fee with `extra` on top: the chunk goes at its `gross`, the keeper pays exactly the fee (the extra
    /// refunded), the vault pays exactly the gross it reserved, no holder's price moves and the adapter keeps nothing.
    function payWholeFee(bytes32 key, CascadeMessages.Payout[] memory list, uint256 gross, uint256 extra) internal {
        uint256 keeperBefore = keeper.balance;
        uint256 vaultBefore = address(vault).balance;
        uint256 priceBefore = vaultLens.price();
        uint256 adapterBefore = address(adapterBit).balance;
        vm.expectEmit(address(vault));
        emit PayoutChunkSent(key, 0, 1, gross, gross, FEE, 0, 0);
        vm.prank(keeper);
        vault.processPayouts{value: FEE + extra}(key, list, 50);
        assertEq(keeper.balance, keeperBefore - FEE, "the caller paid exactly the fee");
        assertEq(address(vault).balance, vaultBefore - gross, "the vault paid exactly the reserved gross");
        assertEq(vaultLens.pendingPayouts(), 0, "the reservation released");
        assertEq(vaultLens.price(), priceBefore, "no holder's price moved");
        assertEq(address(adapterBit).balance, adapterBefore, "the adapter kept nothing");
        assertEq(routerBit.lastSend().tokenAmounts[0].amount, gross, "sent at the gross");
    }

    /// A bounce-only batch, the floor then raised to its gross (0.04 TAO): with the keeper's top-up alone (0) the chunk
    /// reverts BelowConversionFloor on its 0.039 TAO net, and a value one rao short of the whole fee is a top-up, so it
    /// reverts too. With the whole fee (and some extra, refunded) it goes at its gross, and bob is credited his whole
    /// deposit on Base.
    function test_aBounceOnlyBatchUnderARaisedFloorGoesAtItsGross() public {
        (bytes32 key, CascadeMessages.Payout[] memory list) = bounceOnly();
        staking.setMinStake(0.04e18 / 1e9);
        assertEq(adapterBit.floor(), 0.04e18);
        vm.warp(vm.getBlockTimestamp() + vaultLens.payoutDelay());

        expectBelowFloor(key, list, 0.04e18, 0);
        expectBelowFloor(key, list, 0.04e18, FEE - 1e9);
        payWholeFee(key, list, 0.04e18, 5e14);
        (bool ok,) = relayToBase(0);
        assertTrue(ok);
        assertEq(fd.claimable(bob), 0.04e18, "bob's whole deposit");
    }

    /// A share-backed entry the same: alice's 0.05 TAO redeem, held a day and burned, queued, the floor then raised to
    /// its gross. The top-up alone reverts; the whole fee sends it at its gross, alice is credited all of it, and her
    /// remaining shares are worth what they were.
    function test_aShareBackedEntryUnderARaisedFloorGoesAtItsGross() public {
        depositAndRelay(fd, alice, 10e18, 0);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        (bytes32 key, CascadeMessages.Payout[] memory list) = redeemAndRelay(fd, alice, 5e22, 2, 1);
        assertEq(list[0].assets, 0.05e18);
        uint256 left = vault.balanceOf(alice);
        staking.setMinStake(0.05e18 / 1e9);
        vm.warp(vm.getBlockTimestamp() + vaultLens.payoutDelay());

        expectBelowFloor(key, list, 0.05e18, 0);
        expectBelowFloor(key, list, 0.05e18, FEE - 1e9);
        payWholeFee(key, list, 0.05e18, 0);
        (bool ok,) = relayToBase(0);
        assertTrue(ok);
        assertEq(fd.claimable(alice), 0.05e18, "alice's whole payout");
        assertEq(vault.balanceOf(alice), left, "her other shares untouched");
    }

    /// The full top-up changes nothing at the normal floor but who pays the fee: the keeper's top-up alone sends the net
    /// (the entry pays its share); the whole fee sends the gross (the caller pays it). Either way the vault pays at most
    /// the gross it reserved, and the holders' price does not move.
    function test_atTheNormalFloorTheWholeFeeOnlyMovesWhoPays() public {
        (bytes32 key, CascadeMessages.Payout[] memory list) = bounceOnly();
        vm.warp(vm.getBlockTimestamp() + vaultLens.payoutDelay());
        uint256 snap = vm.snapshotState();
        uint256 priceBefore = vaultLens.price();
        vm.prank(keeper);
        vault.processPayouts(key, list, 50);
        assertEq(routerBit.lastSend().tokenAmounts[0].amount, 0.04e18 - FEE, "the top-up alone: the entry pays");
        assertEq(vaultLens.price(), priceBefore);
        vm.revertToState(snap);
        payWholeFee(key, list, 0.04e18, 0);
    }
}
