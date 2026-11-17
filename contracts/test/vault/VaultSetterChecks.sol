// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {InvalidParameter, NotScheduled} from "../../src/CascadeErrors.sol";
import {Schedule} from "../governance/Schedule.sol";
import {VaultTestBase} from "../VaultTestBase.sol";

/// The setter checks VaultCore.t.sol and VaultSetters.t.sol share, moved out of VaultCore.t.sol in Task 37: its test
/// contract sits at via-IR's jump-tag limit, which the tree's growth pushed it past in a forced build. With them, the
/// stranger and the next-creation helper VaultCore.t.sol and VaultDeploy.t.sol share (moved in Task 38, unchanged).
abstract contract VaultSetterChecks is VaultTestBase {
    address stranger = makeAddr("stranger");

    function nextAddress() internal view returns (address) {
        return vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
    }

    /// The owner calls `call` on the fixture vault, expecting it to revert `err`. A loosening, refused
    /// NotScheduled outside execute (Task 11), is scheduled instead and refused by its setter at execute, 48 hours
    /// on, with `err` (the item kept).
    function assertSetterRefuses(bytes memory call, bytes memory err) internal {
        vm.prank(owner);
        (bool ok, bytes memory ret) = address(vault).call(call);
        assertFalse(ok, "the setter accepted it");
        if (keccak256(ret) == keccak256(abi.encodeWithSelector(NotScheduled.selector))) {
            vm.prank(owner);
            vault.schedule(call);
            Schedule.warpTo(vm.getBlockTimestamp() + 48 hours);
            vm.prank(owner);
            (ok, ret) = address(vault).call(abi.encodeCall(vault.execute, (call)));
            assertFalse(ok, "the scheduled setter accepted it");
        }
        assertEq(ret, err, "the setter's error");
    }

    /// A value past a bound in the loosening direction: refused directly as a loosening (NotScheduled, Task
    /// 11), and, scheduled, by the setter's own check at execute (InvalidParameter).
    function assertLooseningRefused(bytes memory call) internal {
        vm.prank(owner);
        (bool ok, bytes memory ret) = address(vault).call(call);
        assertFalse(ok, "a loosening applied outside execute");
        assertEq(ret, abi.encodeWithSelector(NotScheduled.selector), "NotScheduled");
        assertSetterRefuses(call, abi.encodeWithSelector(InvalidParameter.selector));
    }
}
