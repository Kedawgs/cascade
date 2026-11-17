// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {RedeemDeferred, Redeemed} from "../../src/CascadeEvents.sol";
import {BrokenRailAlphaVault} from "../mocks/BrokenRailAlphaVault.sol";
import {AdaptersFixture} from "./AdaptersFixture.sol";

/// @notice S-H1 through the real adapters (spec §3.5; R4, the stuck-money review): from ForeverMoney's migration
/// announcement its `depositLiquid` is closed for good, so the Bittensor adapter can never send a payout again, and
/// answers canSendPayouts false (so too while ForeverMoney is paused). The vault then burns no door redeem: the request
/// is deferred, the holder keeps the shares, nothing is queued that could never be paid, and the holder can still
/// leave directly.
contract PayoutRailClosedTest is AdaptersFixture {
    /// alice's 10 TAO, delivered and held a day, then ForeverMoney announces a migration (or pauses): her door redeem
    /// is relayed and deferred, her shares stay, nothing is queued, and redeemDirect pays her.
    function test_aDoorRedeemInAMigrationNoticeIsDeferredAndADirectExitPays() public {
        depositAndRelay(fd, alice, 10e18, 0);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertTrue(adapterBit.canSendPayouts(), "the rail open");
        av.initiateMigration();
        assertFalse(adapterBit.canSendPayouts(), "closed from the announcement");

        requestVia(fd, alice, 5e24);
        bytes32 key = keyOf(BASE, address(fd), 2, noEntries(), entries1(alice, 5e24));
        close(fd);
        vm.expectEmit(address(vault));
        emit RedeemDeferred(key, alice, 5e24);
        vm.recordLogs();
        (bool ok,) = relayToBittensor(1);
        assertTrue(ok);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault)) {
                assertTrue(logs[i].topics[0] != Redeemed.selector, "nothing burned");
            }
        }
        assertEq(vault.balanceOf(alice), 1e25, "the shares stay with alice");
        assertEq(vaultLens.pendingPayouts(), 0, "nothing queued that could never be paid");

        uint256 before = alice.balance;
        vm.prank(alice);
        vault.redeemDirect(5e24, false);
        assertEq(alice.balance, before + 5e18, "a direct exit pays");
    }

    /// ForeverMoney's pause closes the rail too, and its end reopens it: a door redeem relayed during the pause is
    /// deferred, one after it burns.
    function test_aForeverMoneyPauseDefersDoorRedeemsUntilItEnds() public {
        depositAndRelay(fd, alice, 10e18, 0);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        av.adminHold(vm.getBlockTimestamp() + 3650 days);
        assertFalse(adapterBit.canSendPayouts());
        (, CascadeMessages.Payout[] memory list) = redeemAndRelay(fd, alice, 5e24, 2, 1);
        assertEq(list.length, 0, "deferred, not burned");
        assertEq(vault.balanceOf(alice), 1e25);

        av.unpause();
        assertTrue(adapterBit.canSendPayouts());
        (, list) = redeemAndRelay(fd, alice, 5e24, 3, 2);
        assertEq(list.length, 1, "burned once the rail reopens");
        assertEq(vault.balanceOf(alice), 5e24);
    }

    // ---- the rail's reads never revert (R4 review, Important 2) ----

    /// alice's 10 TAO delivered through the real lane and held a day, the rail open.
    function heldHolder() internal {
        depositAndRelay(fd, alice, 10e18, 0);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertTrue(adapterBit.canSendPayouts(), "the rail open");
    }

    /// The rail reads false, and alice's door redeem, relayed as batch 2 (send 1) within the lane's gas model, is
    /// deferred: nothing burned or queued.
    function assertDoorRedeemDefers() internal {
        assertFalse(adapterBit.canSendPayouts(), "the rail reads false");
        (, CascadeMessages.Payout[] memory list) = redeemAndRelay(fd, alice, 5e24, 2, 1);
        assertEq(list.length, 0, "deferred, not burned");
        assertEq(vault.balanceOf(alice), 1e25, "the shares stay with alice");
        assertEq(vaultLens.pendingPayouts(), 0, "nothing queued");
    }

    /// The AlphaVault's code replaced by `which`'s broken answer (BrokenRailAlphaVault), the other two reads healthy.
    function breakRead(uint256 which, BrokenRailAlphaVault.Answer answer, uint256 burn) internal {
        vm.etch(address(av), address(new BrokenRailAlphaVault(which, answer, burn)).code);
    }

    /// No code at the AlphaVault's address: canSendPayouts reads false, never reverts, and the vault defers the door
    /// redeem (before the review's fix the view reverted and the vault, reading open, burned it).
    function test_anAlphaVaultWithNoCodeReadsFalse() public {
        heldHolder();
        vm.etch(address(av), "");
        assertDoorRedeemDefers();
    }

    /// A getter missing at the AlphaVault, answered by its fallback with empty data, or with a single byte: each of the
    /// three reads so broken reads false and the door redeem is deferred.
    function test_aMissingGetterOrAShortAnswerReadsFalse() public {
        heldHolder();
        for (uint256 which; which < 3; ++which) {
            for (uint256 a; a < 2; ++a) {
                uint256 snap = vm.snapshotState();
                breakRead(which, a == 0 ? BrokenRailAlphaVault.Answer.Missing : BrokenRailAlphaVault.Answer.Short, 0);
                assertDoorRedeemDefers();
                vm.revertToState(snap);
            }
        }
    }

    /// A getter that reverts: each read so broken reads false (no revert reaches the vault) and the door redeem is
    /// deferred.
    function test_aRevertingGetterReadsFalse() public {
        heldHolder();
        for (uint256 which; which < 3; ++which) {
            uint256 snap = vm.snapshotState();
            breakRead(which, BrokenRailAlphaVault.Answer.Reverts, 0);
            assertDoorRedeemDefers();
            vm.revertToState(snap);
        }
    }

    /// A getter that burns every gas it is given stops at the cap (RAIL_READ_GAS): it reads false, the delivery still
    /// completes inside the lane's gas model, and the door redeem is deferred.
    function test_aGasBurningGetterStopsAtTheCapAndReadsFalse() public {
        heldHolder();
        for (uint256 which; which < 3; ++which) {
            uint256 snap = vm.snapshotState();
            breakRead(which, BrokenRailAlphaVault.Answer.BurnsAll, 0);
            uint256 g = gasleft();
            assertFalse(adapterBit.canSendPayouts());
            assertLt(g - gasleft(), adapterBit.RAIL_READ_GAS() + 20_000, "one read burned no more than its cap");
            assertDoorRedeemDefers();
            vm.revertToState(snap);
        }
    }

    /// Each read's cap is RAIL_READ_GAS, 30,000: a getter that needs 25,000 answers within it (true, the redeem burns);
    /// one that needs 35,000 runs out at the cap and reads false. Without the cap the second would answer true.
    function test_eachReadIsCappedAtRailReadGas() public {
        heldHolder();
        assertEq(adapterBit.RAIL_READ_GAS(), 30_000);
        for (uint256 which; which < 3; ++which) {
            uint256 snap = vm.snapshotState();
            breakRead(which, BrokenRailAlphaVault.Answer.Burns, 25_000);
            assertTrue(adapterBit.canSendPayouts(), "25,000: within the cap");
            breakRead(which, BrokenRailAlphaVault.Answer.Burns, 35_000);
            assertFalse(adapterBit.canSendPayouts(), "35,000: past the cap");
            vm.revertToState(snap);
        }
        breakRead(0, BrokenRailAlphaVault.Answer.Burns, 25_000);
        (, CascadeMessages.Payout[] memory list) = redeemAndRelay(fd, alice, 5e24, 2, 1);
        assertEq(list.length, 1, "a slow but answering rail is open: the redeem burns");
    }
}
