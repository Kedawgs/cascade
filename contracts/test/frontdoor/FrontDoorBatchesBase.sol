// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {FrontDoorTestBase} from "../FrontDoorTestBase.sol";

abstract contract FrontDoorBatchesBase is FrontDoorTestBase {
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
}
