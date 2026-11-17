// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeVaultLens} from "../../src/lens/CascadeVaultLens.sol";
import {VaultSetterChecks} from "./VaultSetterChecks.sol";
import {DoorState} from "../../src/CascadeTypes.sol";
import {DirectTransferNotAllowed, NonTransferable, NotGuardian, PeerNotActive} from "../../src/CascadeErrors.sol";
import {FrontDoorRemoved} from "../../src/CascadeEvents.sol";

contract VaultCoreTest is VaultSetterChecks {
    // ---- token ----

    function test_tokenMetadata() public view {
        assertEq(vault.name(), "Cascade Staked TAO");
        assertEq(vault.symbol(), "csTAO");
        assertEq(vault.decimals(), 24);
    }

    function test_sharesNonTransferable() public {
        depositDirect(alice, 10e18);

        vm.startPrank(alice);
        vm.expectRevert(NonTransferable.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        vault.transfer(bob, 1);
        vm.expectRevert(NonTransferable.selector);
        vault.approve(bob, 1);
        vm.stopPrank();

        vm.prank(bob);
        vm.expectRevert(NonTransferable.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        vault.transferFrom(alice, bob, 1);

        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(vault.balanceOf(bob), 0);
        assertEq(vault.allowance(alice, bob), 0);
    }

    // ---- front doors (their activation is the scheduler's: test/governance/Scheduler.t.sol) ----

    function test_frontDoorRemoveByGuardian() public {
        bytes32 id = vaultLens.peerId(BASE, frontDoor);

        vm.prank(stranger);
        vm.expectRevert(NotGuardian.selector);
        vault.removeFrontDoor(BASE, frontDoor);

        vm.expectEmit(address(vault));
        emit FrontDoorRemoved(BASE, frontDoor);
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, frontDoor);
        assertEq(uint8(vaultLens.doorState(id)), uint8(DoorState.Unknown));
        assertEq(vaultLens.activeDoors(BASE), 0);

        vm.prank(guardian);
        vm.expectRevert(PeerNotActive.selector);
        vault.removeFrontDoor(BASE, frontDoor);
    }

    // ---- direct deposits: VaultDirectDeposits.t.sol's (moved in Task 42a: this contract sits at via-IR's jump-tag
    // limit) ----

    // ---- views ----

    function test_grossAssetsEqualsDepositsWithReserveFunded() public {
        // reserve only: 0 * 1e9 + 1e12 - 1e12 = 0
        assertEq(vaultLens.grossAssets(), 0);

        depositDirect(alice, 10e18);
        assertEq(vaultLens.visibleStakeRao(), 0);
        assertEq(vaultLens.grossAssets(), 10e18);
        assertEq(vaultLens.unvestedRewards(), 0);
        assertEq(vaultLens.totalAssets(), 10e18);
        // (10e18 + 1) * 1e18 / (1e25 + 1e6) = (1e19 + 1) * 1e18 / (1e6 * (1e19 + 1)) = 1e12
        assertEq(vaultLens.price(), 1e12);

        // stake on a hotkey in the set is visible (2_000_000 rao = 2e15 wei); stake elsewhere is not. Neither is
        // priced unbooked (Task 12): the gross reads min(visible, booked) * 1e9 + 1e12 + 10e18 - 1e12 = 10e18
        staking.donateStake(HK1, vaultLens.coldkey(), 2_000_000);
        staking.donateStake(HK2, vaultLens.coldkey(), 3_000_000);
        assertEq(vaultLens.visibleStakeRao(), 2_000_000);
        assertEq(vaultLens.bookedStake(), 0);
        assertEq(vaultLens.grossAssets(), 10e18);
        // what the vault stakes is booked and priced: 10_000_000_000 rao staked onto the non-empty HK1
        vm.prank(keeper);
        vault.stakeIdle();
        assertEq(vaultLens.bookedStake(), 10_000_000_000);
        assertEq(vaultLens.visibleStakeRao(), 10_002_000_000);
        assertEq(vaultLens.grossAssets(), 10e18);
    }

    function test_grossAssetsFloorsAtZeroOnEmptyVault() public {
        CascadeVault fresh = new CascadeVault(vaultParams());
        CascadeVaultLens freshLens = new CascadeVaultLens(address(fresh));
        assertEq(address(fresh).balance, 0);
        // 0 * 1e9 + 0 - 1e12 floors to 0
        assertEq(freshLens.grossAssets(), 0);
        assertEq(freshLens.totalAssets(), 0);
        // (0 + 1) * 1e18 / (0 + 1e6) = 1e12
        assertEq(freshLens.price(), 1e12);

        // a partly funded reserve still floors: 1e12 - 1 - 1e12 → 0
        vm.deal(address(fresh), ED - 1);
        assertEq(freshLens.grossAssets(), 0);
    }

    // ---- parameters: the setters' tests are VaultSetters.t.sol's (moved in Task 37: this contract sits at via-IR's
    // jump-tag limit) ----

    // ---- receive ----

    function test_receiveRejectsDirectTransfer() public {
        vm.deal(alice, 1e18);
        vm.prank(alice);
        (bool ok, bytes memory data) = address(vault).call{value: 1e18}("");
        assertFalse(ok);
        assertEq(data, abi.encodeWithSelector(DirectTransferNotAllowed.selector));
        assertEq(address(vault).balance, ED);
        assertEq(alice.balance, 1e18);
    }
}
