// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CascadeBase} from "../../src/CascadeBase.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeMath} from "../../src/libraries/CascadeMath.sol";
import {GLOBAL_WINDOW, MIN_REDEEM_VALUE, STAKE_RAMP} from "../../src/CascadeConstants.sol";
import {DepositedDirect, RedeemDeferred, Redeemed} from "../../src/CascadeEvents.sol";
import {NotBridge, PrimaryBridgeDisabled} from "../../src/CascadeErrors.sol";
import {StubBridge} from "../mocks/StubBridge.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {Schedule} from "../governance/Schedule.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";

/// @notice Two R4 rules on the door's burn (spec §3.5; the stuck-money review):
/// - S-H1: no door burn while the vault's primary bridge cannot send payouts (its canSendPayouts answers false, as the
///   Bittensor adapter does from ForeverMoney's migration notice or pause): every door redeem is deferred, the shares
///   stay with their holders, nothing is queued; deposits still mint and direct exits still pay. A replacement rail
///   made primary resumes the door's burns.
/// - S-L1: an entry clipped to the entry limit or the day's allowance leaves its holder 0 or at least MIN_REDEEM_VALUE,
///   never shares no door burns.
/// The fixture's limits, unless a test lowers them: nothing staked, so the allowance is the 100 TAO floor.
contract VaultExitRailTest is VaultTestBase {
    /// The fixture's own entry limit (2,000 TAO) lowered to the launch's 10 TAO for S-L1, and the floor to 10 TAO.
    function vaultParams() internal view override returns (CascadeVault.Params memory p) {
        p = super.vaultParams();
        p.maxEntryValue = 10e18;
        p.minDailyOutflow = 10e18;
    }

    function redeemVia(address user, uint256 shares) internal returns (bytes32) {
        return deliver(BASE, frontDoor, ++nextBatchId, noEntries(), entries1(user, shares));
    }

    /// The value of `shares` at the vault's price now, floored to rao.
    function valueOf(uint256 shares) internal view returns (uint256 v) {
        v = CascadeMath.assetsForRedeem(shares, vaultLens.totalAssets(), vault.totalSupply());
        v -= v % 1e9;
    }

    // ---- S-H1 ----

    /// While the primary bridge cannot send payouts (the rail closed), a door redeem is deferred: nothing burned,
    /// nothing queued, no window taken. A deposit in the same batch still mints, and a direct exit still pays. Once the
    /// rail is open again the door burns.
    function test_aDoorRedeemDefersWhileThePrimaryCannotSendPayouts() public {
        depositVia(alice, 5e18);
        vm.warp(vm.getBlockTimestamp() + STAKE_RAMP);
        bridge.setCanSendPayouts(false);

        vm.recordLogs();
        bytes32 k = deliver(BASE, frontDoor, ++nextBatchId, entries1(bob, 1e18), entries1(alice, 1e24));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool deferred;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault)) continue;
            assertTrue(logs[i].topics[0] != Redeemed.selector, "nothing burned");
            if (logs[i].topics[0] == RedeemDeferred.selector) deferred = true;
        }
        assertTrue(deferred, "RedeemDeferred");
        assertEq(vault.balanceOf(alice), 5e24, "the shares stay with the holder");
        assertGt(vault.balanceOf(bob), 0, "a deposit still mints");
        assertEq(vaultLens.pendingPayouts(), 0, "nothing queued");
        assertEq(vaultLens.getPayoutBatch(k).count, 0);
        (, uint256 burned) = vaultLens.burnWindows(GLOBAL_WINDOW);
        assertEq(burned, 0, "no window taken");

        // a direct exit is not the rail's
        vm.prank(alice);
        vault.redeemDirect(1e24, false);
        assertEq(vault.balanceOf(alice), 4e24);

        bridge.setCanSendPayouts(true);
        redeemVia(alice, 1e24);
        assertEq(vault.balanceOf(alice), 3e24, "the door burns again once the rail is open");
    }

    /// A rail closed for good (ForeverMoney migrated) is left by a replacement: a second bridge activated (7 days), the
    /// old primary disabled and the new one made primary. Its own canSendPayouts answers true, so door redeems delivered
    /// through it burn again.
    function test_aReplacementRailMadePrimaryResumesDoorRedeems() public {
        depositVia(alice, 5e18);
        vm.warp(vm.getBlockTimestamp() + STAKE_RAMP);
        bridge.setCanSendPayouts(false);
        redeemVia(alice, 1e24);
        assertEq(vault.balanceOf(alice), 5e24, "deferred on the closed rail");

        StubBridge rail = new StubBridge(IERC20(address(0)));
        rail.setFee(1e15);
        Schedule.run(vault, owner, abi.encodeCall(CascadeBase.activateBridge, (address(rail))));
        vm.prank(owner);
        vault.disableBridge(address(bridge));
        vm.prank(owner);
        vault.setPrimaryBridge(address(rail));

        StubBridge old = bridge;
        bridge = rail;
        redeemVia(alice, 1e24);
        bridge = old;
        assertEq(vault.balanceOf(alice), 4e24, "burned through the replacement rail");
        assertGt(vaultLens.pendingPayouts(), 0, "and queued for it");
    }

    /// The vault's read of its primary bridge's canSendPayouts is fail-open: a primary bridge with no such view (it
    /// answers the selector with an empty revert, as a contract without it does) reads open, and the door burns. This is
    /// the one open path by design (R4 review): a Bittensor adapter never reverts its view (each AlphaVault read fails
    /// to false, test/adapters/PayoutRailClosed.t.sol), so only a rail of another kind, which has no ForeverMoney to
    /// wait for, reaches it.
    function test_aPrimaryBridgeWithNoRailViewReadsOpen() public {
        depositVia(alice, 5e18);
        vm.warp(vm.getBlockTimestamp() + STAKE_RAMP);
        bridge.setCanSendPayouts(false);
        bridge.setRailViewMissing(true);
        (bool ok, bytes memory ret) = address(bridge).staticcall(abi.encodeWithSignature("canSendPayouts()"));
        assertFalse(ok, "the view is missing");
        assertEq(ret.length, 0);
        redeemVia(alice, 1e24);
        assertEq(vault.balanceOf(alice), 4e24, "read open: the door burns");
        assertEq(vaultLens.pendingPayouts(), 1e18, "and queues the payout");
    }

    /// The vault's call is capped at 150,000 gas (RAIL_VIEW_GAS), so no bridge's view can starve the delivery it runs in:
    /// a closed rail whose view burns 140,000 gas still answers within the cap (deferred); one that burns 160,000 runs
    /// out at the cap, fails, and reads open (the door burns) while the delivery completes. Without the cap the second
    /// would answer false; with a lower one the first would read open.
    function test_theVaultsRailCallIsCappedAt150000() public {
        depositVia(alice, 5e18);
        vm.warp(vm.getBlockTimestamp() + STAKE_RAMP);
        bridge.setCanSendPayouts(false);
        bridge.setRailViewBurn(140_000);
        redeemVia(alice, 1e24);
        assertEq(vault.balanceOf(alice), 5e24, "140,000: answered within the cap, deferred");

        bridge.setRailViewBurn(160_000);
        redeemVia(alice, 1e24);
        assertEq(vault.balanceOf(alice), 4e24, "160,000: past the cap, read open, burned");
    }

    // ---- R6 D (ChatGPT R2 claim D): a disabled primary cannot send, so no door burn ----

    /// A second bridge activated (7 days, from OPEN), as runbook section 8's replacement pair is: enabled, not primary.
    function newRail() internal returns (StubBridge rail) {
        rail = new StubBridge(IERC20(address(0)));
        rail.setFee(1e15);
        Schedule.run(vault, owner, abi.encodeCall(CascadeBase.activateBridge, (address(rail))));
    }

    /// A launch-door batch delivered through `via` (an enabled bridge, the primary or not); its key.
    function deliverThrough(
        StubBridge via,
        CascadeMessages.Entry[] memory deposits,
        CascadeMessages.Entry[] memory redeems
    ) internal returns (bytes32 k) {
        StubBridge old = bridge;
        bridge = via;
        k = deliver(BASE, frontDoor, ++nextBatchId, deposits, redeems);
        bridge = old;
    }

    /// `logs` hold a RedeemDeferred from the vault and no Redeemed.
    function assertAllDeferred(Vm.Log[] memory logs) internal view {
        bool deferred;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault)) continue;
            assertTrue(logs[i].topics[0] != Redeemed.selector, "nothing burned");
            if (logs[i].topics[0] == RedeemDeferred.selector) deferred = true;
        }
        assertTrue(deferred, "RedeemDeferred");
    }

    /// Mid-replacement (runbook section 8 with the front door switched first), the vault's primary disabled and not yet
    /// switched: a door redeem delivered through the new bridge (enabled, not primary) is deferred, as on a closed rail,
    /// though the disabled primary's own canSendPayouts still reads open (it cannot see the vault's disable): nothing
    /// burned, nothing queued, no window taken. Before R6 it burned into a queue only the owner's switch could pay.
    /// The owner's switch then reopens the door's burns, paid through the new primary.
    function test_aDoorRedeemDefersWhileTheVaultsPrimaryIsDisabled() public {
        depositVia(alice, 5e18);
        vm.warp(vm.getBlockTimestamp() + STAKE_RAMP);
        StubBridge rail = newRail();
        vm.prank(owner);
        vault.disableBridge(address(bridge));
        assertTrue(bridge.canSendPayouts(), "the disabled primary's own view still reads open");

        // the old bridge can no longer deliver (refused, so its adapter parks the batch)
        bytes memory m = CascadeMessages.encodeBatch(++nextBatchId, noEntries(), entries1(alice, 1e24));
        vm.expectRevert(NotBridge.selector);
        vm.prank(address(bridge));
        vault.onBridgeMessage(BASE, frontDoor, m, 0);

        // the front door already switched: the batch comes through the new bridge, and the redeem is deferred
        vm.recordLogs();
        bytes32 k = deliverThrough(rail, noEntries(), entries1(alice, 1e24));
        assertAllDeferred(vm.getRecordedLogs());
        assertEq(vault.balanceOf(alice), 5e24, "the shares stay with the holder");
        assertEq(vaultLens.pendingPayouts(), 0, "nothing queued");
        assertEq(vaultLens.getPayoutBatch(k).count, 0);
        (, uint256 door) = vaultLens.burnWindows(vaultLens.peerId(BASE, frontDoor));
        (, uint256 all) = vaultLens.burnWindows(GLOBAL_WINDOW);
        assertEq(door + all, 0, "no window taken");

        // the owner's switch (immediate, unscheduled): the door burns again, paid through the new primary
        vm.prank(owner);
        vault.setPrimaryBridge(address(rail));
        k = deliverThrough(rail, noEntries(), entries1(alice, 1e24));
        assertEq(vault.balanceOf(alice), 4e24, "burned once the primary is enabled");
        uint256 owed = vaultLens.pendingPayouts();
        assertGt(owed, 0, "and queued");
        CascadeMessages.Payout[] memory list = new CascadeMessages.Payout[](1);
        list[0] = CascadeMessages.Payout(alice, 1e24, owed);
        vm.warp(vm.getBlockTimestamp() + vaultLens.payoutDelay());
        vault.processPayouts(k, list, 10);
        assertEq(rail.sendCount(), 1, "paid through the new primary");
        assertEq(bridge.sendCount(), 0);
        assertEq(vaultLens.pendingPayouts(), 0);
    }

    /// The same under the guardian's disable of the primary (an incident in the half-switched window): deferred until
    /// the owner's switch.
    function test_aGuardiansDisableOfThePrimaryDefersDoorRedeemsToo() public {
        depositVia(alice, 5e18);
        vm.warp(vm.getBlockTimestamp() + STAKE_RAMP);
        StubBridge rail = newRail();
        vm.prank(guardian);
        vault.disableBridge(address(bridge));

        vm.recordLogs();
        deliverThrough(rail, noEntries(), entries1(alice, 1e24));
        assertAllDeferred(vm.getRecordedLogs());
        assertEq(vault.balanceOf(alice), 5e24, "deferred under the guardian's disable");
        assertEq(vaultLens.pendingPayouts(), 0);

        vm.prank(owner);
        vault.setPrimaryBridge(address(rail));
        deliverThrough(rail, noEntries(), entries1(alice, 1e24));
        assertEq(vault.balanceOf(alice), 4e24, "burned after the owner's switch");
    }

    /// One delivery in the window with a deposit and a redeem: the deposit mints (as under S-H1), the redeem is deferred.
    function test_aWindowDeliveryMintsItsDepositAndDefersItsRedeem() public {
        depositVia(alice, 5e18);
        vm.warp(vm.getBlockTimestamp() + STAKE_RAMP);
        StubBridge rail = newRail();
        vm.prank(owner);
        vault.disableBridge(address(bridge));

        vm.recordLogs();
        deliverThrough(rail, entries1(bob, 1e18), entries1(alice, 1e24));
        assertAllDeferred(vm.getRecordedLogs());
        assertGt(vault.balanceOf(bob), 0, "the deposit mints");
        assertEq(vault.balanceOf(alice), 5e24, "the redeem deferred");
        assertEq(vaultLens.pendingPayouts(), 0, "nothing queued");
    }

    /// The stated residual (as under S-H1): a bounced deposit delivered in the window still queues behind the disabled
    /// primary (a bounce cannot be deferred or cancelled), refused PrimaryBridgeDisabled until the owner's switch pays
    /// it through the new primary.
    function test_aBounceInTheWindowStillQueuesAndIsPaidAfterTheSwitch() public {
        depositVia(alice, 5e18);
        address dave = makeAddr("dave");
        registerFrontDoor(10, makeAddr("door10"));
        vm.prank(dave);
        vault.setRedeemOrigin(10); // a second door's chain: a launch-door deposit for dave bounces (ForeignOrigin)
        StubBridge rail = newRail();
        vm.prank(owner);
        vault.disableBridge(address(bridge));

        bytes32 k = deliverThrough(rail, entries1(dave, 1e18), noEntries());
        assertEq(vault.balanceOf(dave), 0, "bounced");
        assertEq(vaultLens.pendingPayouts(), 1e18, "queued behind the disabled primary");
        CascadeMessages.Payout[] memory list = new CascadeMessages.Payout[](1);
        list[0] = CascadeMessages.Payout(dave, 0, 1e18);
        vm.warp(vm.getBlockTimestamp() + vaultLens.payoutDelay());
        vm.expectRevert(PrimaryBridgeDisabled.selector);
        vault.processPayouts(k, list, 10);

        vm.prank(owner);
        vault.setPrimaryBridge(address(rail));
        vault.processPayouts(k, list, 10);
        assertEq(rail.sendCount(), 1, "paid through the new primary");
        assertEq(vaultLens.pendingPayouts(), 0);
    }

    /// A Reopen of the disabled primary (7 days, no gate) enables it again, and the door's burns resume by themselves.
    function test_aReopenOfTheDisabledPrimaryResumesDoorBurns() public {
        depositVia(alice, 5e18);
        vm.warp(vm.getBlockTimestamp() + STAKE_RAMP);
        StubBridge rail = newRail();
        vm.prank(owner);
        vault.disableBridge(address(bridge));
        deliverThrough(rail, noEntries(), entries1(alice, 1e24));
        assertEq(vault.balanceOf(alice), 5e24, "deferred while the primary is disabled");

        // a second after the disable's stamp, the Reopen is scheduled (it reads the owner's clock) and runs 7 days on
        vm.warp(vm.getBlockTimestamp() + 1);
        Schedule.run(vault, owner, abi.encodeCall(CascadeBase.activateBridge, (address(bridge))));
        assertTrue(vaultLens.bridgeEnabled(address(bridge)), "the primary enabled again");
        redeemVia(alice, 1e24);
        assertEq(vault.balanceOf(alice), 4e24, "the door burns again through the reopened primary");
        deliverThrough(rail, noEntries(), entries1(alice, 1e24));
        assertEq(vault.balanceOf(alice), 3e24, "and through the other enabled bridge");
    }

    /// A disabled primary reads closed before its view is asked, so the fail-open path (a primary with no rail view
    /// reads open) is never reached for it.
    function test_aDisabledPrimaryWithNoRailViewReadsClosed() public {
        depositVia(alice, 5e18);
        vm.warp(vm.getBlockTimestamp() + STAKE_RAMP);
        bridge.setRailViewMissing(true);
        StubBridge rail = newRail();
        vm.prank(owner);
        vault.disableBridge(address(bridge));

        vm.recordLogs();
        deliverThrough(rail, noEntries(), entries1(alice, 1e24));
        assertAllDeferred(vm.getRecordedLogs());
        assertEq(vault.balanceOf(alice), 5e24, "read closed: deferred, not the fail-open burn");
    }

    // ---- S-L1 ----

    /// An entry clipped to the 10 TAO entry limit leaves its holder at least MIN_REDEEM_VALUE: a holder of 10.02 TAO
    /// asking for everything is burned 9.99 TAO (not 10), keeping 0.03 TAO, which the next request burns. Without the
    /// rule the 0.02 TAO left was worth less than any door burns.
    function test_aClipToTheEntryLimitNeverLeavesAnUnredeemableRemainder() public {
        depositVia(alice, 10.02e18);
        vm.warp(vm.getBlockTimestamp() + STAKE_RAMP);
        redeemVia(alice, vault.balanceOf(alice));
        uint256 left = vault.balanceOf(alice);
        assertGe(valueOf(left), MIN_REDEEM_VALUE, "the remainder a door burns");
        assertLt(valueOf(left), MIN_REDEEM_VALUE + 1e9 + 1, "and no more than it needs");

        vm.warp(vm.getBlockTimestamp() + 1 days);
        redeemVia(alice, left);
        assertEq(vault.balanceOf(alice), 0, "burned whole by the next request");
    }

    /// The day's allowance the same: with the 10 TAO floor as the allowance (nothing staked), the holder of 10.02 TAO
    /// keeps at least 0.03 TAO. And the edge: one whose remainder is already worth at least 0.03 TAO after the clip
    /// (10.05 TAO) is burned the full 10 TAO, and one asking for less than the clip is burned what it asked.
    function test_aClipToTheAllowanceNeverLeavesAnUnredeemableRemainder() public {
        depositVia(alice, 10.02e18);
        depositVia(bob, 10.05e18);
        depositVia(carol, 10e18);
        vm.warp(vm.getBlockTimestamp() + STAKE_RAMP);

        redeemVia(alice, vault.balanceOf(alice));
        uint256 left = vault.balanceOf(alice);
        assertGe(valueOf(left), MIN_REDEEM_VALUE, "alice keeps a redeemable remainder");

        vm.warp(vm.getBlockTimestamp() + 1 days);
        uint256 bobShares = vault.balanceOf(bob);
        redeemVia(bob, bobShares);
        assertApproxEqAbs(valueOf(vault.balanceOf(bob)), 0.05e18, 1e9, "bob burned the full 10 TAO");

        vm.warp(vm.getBlockTimestamp() + 1 days);
        uint256 asked = vault.balanceOf(carol) / 2;
        redeemVia(carol, asked);
        assertApproxEqAbs(valueOf(vault.balanceOf(carol)), 5e18, 1e9, "carol burned what she asked");
    }

    // ---- R5 M-5: no gas starves a closed rail's read into a burn ----

    /// The vault reads its primary bridge's rail fail-open (`_payoutsOpen`, a staticcall capped at RAIL_VIEW_GAS): a
    /// read that fails reads open. A delivery sent with too little gas can starve that read, but then the vault's frame
    /// keeps at most a 64th of what the read was given, too little to burn anything, so the delivery reverts (CCIP
    /// FAILURE, or a park in the Bittensor adapter) and never burns while the rail is closed. On a closed stub rail whose
    /// view costs `burn`, `onBridgeMessage` of a redeem-only batch is bisected to its least succeeding gas, and then swept
    /// downward from just above it (every 500 gas to 30,000, and every 32 gas through the 2,000 below it): every
    /// outcome is the redeem deferred, or a revert that changed nothing; never `Redeemed`.
    function checkNoStarvedBurn(uint256 burn) internal {
        depositVia(alice, 5e18);
        vm.warp(vm.getBlockTimestamp() + STAKE_RAMP);
        bridge.setCanSendPayouts(false);
        bridge.setRailViewBurn(burn);
        bytes memory message = CascadeMessages.encodeBatch(++nextBatchId, noEntries(), entries1(alice, 1e24));
        uint256 snap = vm.snapshotState();
        uint256 lo = 30_000;
        uint256 hi = 3_000_000;
        assertEq(deliverWith(message, hi), 1, "deferred with plenty of gas");
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            vm.revertToState(snap);
            if (deliverWith(message, mid) == 1) hi = mid;
            else lo = mid;
        }
        uint256 need = hi;
        uint256 deferred;
        uint256 reverted;
        for (uint256 g = need + 2_000; g >= 30_000; g -= (g > need - 2_000 ? 32 : 500)) {
            vm.revertToState(snap);
            uint256 outcome = deliverWith(message, g);
            if (outcome == 1) ++deferred;
            else ++reverted;
        }
        emit log_named_uint(string.concat("view cost ", vm.toString(burn), ": least gas that delivers"), need);
        emit log_named_uint("  deliveries swept that deferred", deferred);
        emit log_named_uint("  deliveries swept that reverted", reverted);
        assertGt(deferred, 0, "the sweep starts where the delivery goes through");
        assertGt(reverted, 0, "and reaches where it does not");
    }

    /// One delivery of `message` from the launch door with exactly `gas` given to the vault: 1 when it went through with
    /// the redeem deferred, 0 when it reverted with nothing changed. A burn fails the test.
    function deliverWith(bytes memory message, uint256 gas) internal returns (uint256) {
        vm.recordLogs();
        vm.prank(address(bridge));
        (bool ok,) =
            address(vault).call{gas: gas}(abi.encodeCall(CascadeVault.onBridgeMessage, (BASE, frontDoor, message, 0)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool deferred;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault)) continue;
            assertTrue(logs[i].topics[0] != Redeemed.selector, "never burned while the rail is closed");
            if (logs[i].topics[0] == RedeemDeferred.selector) deferred = true;
        }
        assertEq(vault.balanceOf(alice), 5e24, "alice's shares untouched");
        if (!ok) return 0;
        assertTrue(deferred, "a delivery that goes through defers the redeem");
        return 1;
    }

    function test_noGasStarvesAClosedRailIntoABurn_aCheapView() public {
        checkNoStarvedBurn(0);
    }

    /// About what the Bittensor adapter's canSendPayouts costs on the live AlphaVault, cold (10,731, Task 61).
    function test_noGasStarvesAClosedRailIntoABurn_theLiveView() public {
        checkNoStarvedBurn(10_731);
    }

    /// Near the cap: the dearest view the vault still waits for.
    function test_noGasStarvesAClosedRailIntoABurn_aViewNearTheCap() public {
        checkNoStarvedBurn(140_000);
    }
}
