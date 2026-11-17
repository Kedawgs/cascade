// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {CascadeBase} from "../../src/CascadeBase.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {NotReady} from "../../src/CascadeErrors.sol";

/// Test only: an owner change through the scheduler in one step (spec §3.6): `run` schedules `data` as
/// `owner`, warps the item's class delay and executes it. The class delays are spec §3.6's table:
/// Guardian (8 days) for setGuardian and transferOwnership, Registry (7 days) for the activations and the
/// vault's writeOffMissingStake (Task 16), Param (48 hours) for everything else. `run` proves the table on
/// every call: one second before the
/// delay it expects execute to revert NotReady, so a helper delay longer than the contract's fails,
/// and the execute at the delay fails if it is shorter. Its warps roll the block number along (`warpTo`),
/// so an item's block floor (R1-A L-3) is met whenever its delay is, and its window in blocks passes with its
/// window in time (Revision 28).
library Schedule {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    /// `warpTo`'s blocks a second: a block every 2 ms, more than half of any time in 61 ms blocks (the fastest
    /// calibration the constructor takes) asks for.
    uint256 internal constant BLOCKS_PER_SECOND = 500;

    /// Schedules `data` on `c` as `owner`, warps its class delay and executes it; returns the item's id.
    function run(CascadeBase c, address owner, bytes memory data) internal returns (bytes32 id) {
        vm.prank(owner);
        id = c.schedule(data);
        // casting to 'bytes4' keeps the selector, the first 4 bytes of data
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 readyAt = vm.getBlockTimestamp() + delayOf(bytes4(data));
        warpTo(readyAt - 1);
        vm.prank(owner);
        (bool early, bytes memory why) = address(c).call(abi.encodeCall(CascadeBase.execute, (data)));
        require(
            !early && keccak256(why) == keccak256(abi.encodeWithSelector(NotReady.selector)),
            "Schedule.run: the item was ready before its class delay"
        );
        warpTo(readyAt);
        vm.prank(owner);
        c.execute(data);
    }

    /// Moves the clock to `t` and the block number along with it, a block every 2 ms (never back): at least
    /// the blocks any MS_PER_BLOCK (61 to 60,000 ms) asks of an item over that time, half the time in blocks, so
    /// a delay waited in time is waited in blocks too (R1-A L-3), and a window passed in time is passed in
    /// blocks too (the lapse, Revision 28), whichever chain's block time the target has.
    function warpTo(uint256 t) internal {
        uint256 from = vm.getBlockTimestamp();
        vm.warp(t);
        if (t > from) vm.roll(vm.getBlockNumber() + (t - from) * BLOCKS_PER_SECOND);
    }

    /// `warpTo` `secs` seconds from now.
    function wait(uint256 secs) internal {
        warpTo(vm.getBlockTimestamp() + secs);
    }

    /// The class delay of `selector` (spec §3.6's table).
    function delayOf(bytes4 selector) internal pure returns (uint256) {
        if (selector == CascadeBase.setGuardian.selector || selector == CascadeBase.transferOwnership.selector) {
            return 8 days;
        }
        if (
            selector == CascadeBase.activateBridge.selector || selector == CascadeVault.activateFrontDoor.selector
                || selector == CascadeVault.writeOffMissingStake.selector
        ) {
            return 7 days;
        }
        return 48 hours;
    }
}
