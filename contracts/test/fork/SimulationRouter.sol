// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CcipBittensorAdapter} from "../../src/adapters/CcipBittensorAdapter.sol";

/// @notice The CCIP Router's stand-in for `script/simulate_inbound.sh`, placed by code override at the live
/// Router's address, so the adapter sees msg.sender == router. Its fallback funds the adapter's reserve with
/// msg.value (`fundReserve`) and forwards the calldata (the `ccipReceive` call) to the adapter, bubbling a revert.
/// Since Task 25 the adapter parks a batch it cannot convert or deliver instead of reverting, so a `ccipReceive`
/// that returns is not a delivery: unless `parkedNative` and `parkedTokens` are both 0 afterwards, the fallback
/// reverts `SimulationParked` with both totals and the batch's record (`key`, the script's batch). `adapter()`
/// answers the script's check that the code override took effect. A plain transfer is refused.
contract SimulationRouter {
    error SimulationParked(
        uint256 parkedNative, uint256 parkedTokens, uint256 amount, uint256 parkedAt, bool converted
    );
    error PlainTransfer();

    CcipBittensorAdapter public immutable adapter;
    bytes32 public immutable key;

    constructor(CcipBittensorAdapter adapter_, bytes32 key_) {
        adapter = adapter_;
        key = key_;
    }

    receive() external payable {
        revert PlainTransfer();
    }

    fallback(bytes calldata data) external payable returns (bytes memory ret) {
        adapter.fundReserve{value: msg.value}();
        bool ok;
        (ok, ret) = address(adapter).call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        uint256 native = adapter.parkedNative();
        uint256 tokens = adapter.parkedTokens();
        if (native != 0 || tokens != 0) {
            (uint128 amount, uint64 parkedAt, bool converted) = adapter.parked(key);
            revert SimulationParked(native, tokens, amount, parkedAt, converted);
        }
    }
}
