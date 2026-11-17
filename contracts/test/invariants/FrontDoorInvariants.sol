// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {FrontDoorTracker} from "./handlers/FrontDoorTracker.sol";

/// The front-door invariants every campaign that closes batches inherits (Task 37, from the core campaign; ruling:
/// reuse, don't copy), checked after every step over every door the handler tracks (FrontDoorTracker): the front
/// door's holdings, I-18 in both forms, the sweep's bound and I-21. A campaign calls `setFrontDoors` in its setUp. The
/// doors must have distinct treasuries, so each treasury's balance is its own door's sweeps.
abstract contract FrontDoorInvariants is Test {
    FrontDoorTracker private _doorsHandler;
    IERC20 private _doorsAsset;
    IERC20 private _doorsUsdc;

    /// The campaign's handler and the doors' tokens: the bridged TAO they hold and the USDC they deliver.
    function setFrontDoors(FrontDoorTracker handler_, IERC20 asset_, IERC20 usdc_) internal {
        _doorsHandler = handler_;
        _doorsAsset = asset_;
        _doorsUsdc = usdc_;
        CascadeFrontDoor[] memory doors = handler_.trackedDoors();
        require(doors.length != 0, "no door");
        for (uint256 i; i < doors.length; ++i) {
            require(
                address(doors[i].asset()) == address(asset_) && address(doors[i].usdc()) == address(usdc_),
                "the doors' tokens"
            );
            for (uint256 j; j < i; ++j) {
                require(doors[i].treasury() != doors[j].treasury(), "two doors share a treasury");
            }
        }
    }

    /// @dev Each front door holds exactly its open batch's deposits plus every unclaimed credit in TAO (exact because
    /// no handler donates), exactly its open batch's fee pot plus the pre-paid credits in ETH (I-18: a close's
    /// remainder carried in the pot), and no USDC (every delivery forwards all it measured).
    function invariant_frontDoorIdentities() public view {
        CascadeFrontDoor[] memory doors = _doorsHandler.trackedDoors();
        for (uint256 i; i < doors.length; ++i) {
            CascadeFrontDoor d = doors[i];
            (,, uint256 totalDeposits, uint256 feePot,,) = d.openBatch();
            assertEq(_doorsAsset.balanceOf(address(d)), totalDeposits + d.totalClaimable(), "a door's TAO");
            assertEq(address(d).balance, feePot + d.totalFeeCredit(), "I-18: a door's ETH");
            assertEq(_doorsUsdc.balanceOf(address(d)), 0, "a door's USDC");
        }
    }

    /// @dev I-21: a closer never receives more than it sent, on any door; the pot's remainder rolls into the next
    /// batch, never to the closer (Task 29). The world reaches what tells the two apart: pots above the lane's fee,
    /// closers sending more than the pot lacks, self-closes on a pot, and sweeps. Fails on v3.1's
    /// remainder-to-the-closer (Task 29's follow-up).
    function invariant_aCloserNeverReceivesMoreThanItSent() public view {
        assertEq(_doorsHandler.closerGains(), 0, "I-21: a closer received more than it sent");
    }

    /// @dev I-18's ghost form, per door: every wei paid into its fee pots is in its open pot, spent on a close's fee
    /// (`potUsed`) or swept to its treasury, which holds exactly its sweeps (no handler pre-pays credit; a roll moves
    /// no pot).
    function invariant_theFeePotIsAccounted() public view {
        CascadeFrontDoor[] memory doors = _doorsHandler.trackedDoors();
        for (uint256 i; i < doors.length; ++i) {
            address d = address(doors[i]);
            (,,, uint256 feePot,,) = doors[i].openBatch();
            assertEq(
                _doorsHandler.ghostPotIn(d),
                _doorsHandler.ghostPotUsed(d) + _doorsHandler.ghostSwept(d) + feePot,
                "I-18: a door's fee pot"
            );
            assertEq(doors[i].treasury().balance, _doorsHandler.ghostSwept(d), "I-18: a door's treasury");
        }
    }

    /// @dev The sweep's bound, per door: `potCarried` never exceeds the ETH the front door holds less what it owes
    /// (the pre-paid credits), so a sweep can never take a credit (Task 29).
    function invariant_potCarriedNeverAboveTheUnowedEth() public view {
        CascadeFrontDoor[] memory doors = _doorsHandler.trackedDoors();
        for (uint256 i; i < doors.length; ++i) {
            uint256 balance = address(doors[i]).balance;
            uint256 owed = doors[i].totalFeeCredit();
            assertLe(owed, balance);
            assertLe(doors[i].potCarried(), balance - owed);
        }
    }
}
