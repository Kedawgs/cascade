// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {CcipBittensorAdapter} from "../../src/adapters/CcipBittensorAdapter.sol";
import {MockTAO} from "../mocks/MockTAO.sol";

/// @notice The Bittensor adapter's token cushion in tests (Task 28; spec §3.2, §3.3), shared by
/// `CcipBittensorAdapter.t.sol` and `BittensorParking.t.sol`: funding it as the operator does, and reading back what
/// `ShortfallCovered` says the cushion paid.
abstract contract CushionHelpers is Test {
    /// Funds `adapter`'s token cushion as the operator does since R4 (F-1): the bridged token approved and pulled by the
    /// adapter's `fundCushion`, which books it (a plain transfer is surplus, the sweep's).
    function fundCushion(MockTAO token, address adapter, uint256 amount) internal {
        token.mint(address(this), amount);
        token.approve(adapter, amount);
        CcipBittensorAdapter(payable(adapter)).fundCushion(amount);
    }

    /// The amounts of the ShortfallCovered events `adapter` logged since vm.recordLogs(), in order: the wei its cushion
    /// paid for each short conversion.
    function shortfallsLogged(address adapter) internal view returns (uint256[] memory amounts) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (isShortfall(logs[i], adapter)) ++n;
        }
        amounts = new uint256[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (isShortfall(logs[i], adapter)) amounts[n++] = abi.decode(logs[i].data, (uint256));
        }
    }

    /// I-7: the adapter holds at least what it owes to its parks.
    function assertOwed(CcipBittensorAdapter adapter, MockTAO taoBit) internal view {
        assertGe(address(adapter).balance, adapter.parkedNative(), "I-7 native");
        assertGe(taoBit.balanceOf(address(adapter)), adapter.parkedTokens(), "I-7 tokens");
    }

    function isShortfall(Vm.Log memory log, address adapter) private pure returns (bool) {
        return log.emitter == adapter && log.topics[0] == CcipBittensorAdapter.ShortfallCovered.selector;
    }
}
