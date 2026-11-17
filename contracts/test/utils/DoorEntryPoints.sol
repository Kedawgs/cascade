// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

// The front door's entry points, for the pause sweep (spec §3.5, I-20; Task 30's follow-up): every function of its ABI
// that is not a view (its own and CascadeBase's, the pure renounceOwnership included), and receive, as "name(argument
// types)". script/lens-surface.mjs fails the build checks unless this list equals the built ABI's, so an entry point the
// door gains (or loses) without a row in FrontDoorPayouts' test_pauseStopsDepositAndDeliverOnly is caught at build
// time; the sweep itself checks that its rows are this list, row for row and in this order.

/// Every non-view entry point of CascadeFrontDoor, in the pause sweep's order.
function doorEntryPoints() pure returns (string[] memory points) {
    string[38] memory p = [
        // what the pause stops, and pause itself (OpenZeppelin's refuses a second one)
        "deposit(uint256)",
        "depositFor(address,uint256)",
        "deliver(address,uint256)",
        "pause()",
        // the exits (I-20)
        "cancelDeposit(uint256)",
        "requestRedeem(uint256)",
        "requestRedeemWithDelivery(uint256,uint128,uint64,uint32)",
        "cancelRedeem(uint256)",
        "closeBatch(uint64,uint256)",
        "onBridgeMessage(uint64,address,bytes,uint256)",
        "claim()",
        // the rest of a holder's surface
        "creditRedeemFee(address)",
        "setDelivery(uint128,uint64,uint32)",
        "stampBySig(uint64,bytes)",
        // the owner's and the guardian's
        "sweepPot(uint256)",
        "setCaps(uint256,uint256)",
        "setBatchLimits(uint32,uint32)",
        "setMaxBatchValue(uint256)",
        "setBatchInterval(uint64)",
        "setRedeemRequestFee(uint256)",
        "setKeeper(address)",
        "setMaxDeliverySlippage(uint16)",
        "setMinPoolLiquidity(uint8,uint128)",
        // scheduled only: run through execute
        "setOracle(address)",
        "setSwapper(address)",
        "setGuardian(address)",
        "transferOwnership(address)",
        "activateBridge(address)",
        // the scheduler and the instruments
        "schedule(bytes)",
        "execute(bytes)",
        "cancel(bytes32)",
        "prune(bytes32)",
        "acceptOwnership()",
        "disableBridge(address)",
        "setPrimaryBridge(address)",
        "renounceOwnership()",
        "receive()",
        "unpause()"
    ];
    points = new string[](p.length);
    for (uint256 i; i < p.length; ++i) {
        points[i] = p[i];
    }
}
