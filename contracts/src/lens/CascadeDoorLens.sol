// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CascadeBaseLens} from "./CascadeBaseLens.sol";
import {DoorLayout} from "./generated/DoorLayout.sol";

/// @notice The front door's read-only lens (spec §8.1): CascadeBase's getters, which the front door
/// no longer has (internal since Task 5d-1), under those getters' names, arguments and return types,
/// and the front door's keeper, read from its storage through its `extsload` with the slots generated
/// from its storage layout (DoorLayout.sol). The front door keeps its own getters, `keeper` among them
/// and `asset`, `usdc` and `oracle` above all, which on-chain callers read.
/// @dev Works on any chain: it calls nothing but its target's `extsload` (no address-mapping
/// precompile, which exists only on Bittensor).
contract CascadeDoorLens is CascadeBaseLens {
    constructor(address frontDoor) CascadeBaseLens(frontDoor) {}

    function keeper() external view returns (address) {
        return _address(DoorLayout.SLOT_KEEPER, DoorLayout.OFFSET_KEEPER, DoorLayout.SIZE_KEEPER);
    }

    // ---- CascadeBase's state in the front door ----

    function _guardianField() internal pure override returns (uint256, uint256, uint256) {
        return (DoorLayout.SLOT_GUARDIAN, DoorLayout.OFFSET_GUARDIAN, DoorLayout.SIZE_GUARDIAN);
    }

    function _primaryBridgeField() internal pure override returns (uint256, uint256, uint256) {
        return (DoorLayout.SLOT_PRIMARY_BRIDGE, DoorLayout.OFFSET_PRIMARY_BRIDGE, DoorLayout.SIZE_PRIMARY_BRIDGE);
    }

    function _bridgeEnabledSlot() internal pure override returns (uint256) {
        return DoorLayout.SLOT_BRIDGE_ENABLED;
    }

    function _scheduledSlot() internal pure override returns (uint256) {
        return DoorLayout.SLOT_SCHEDULED;
    }

    function _bridgeKnownSlot() internal pure override returns (uint256) {
        return DoorLayout.SLOT_BRIDGE_KNOWN;
    }

    function _lastOwnerCloseField() internal pure override returns (uint256, uint256, uint256) {
        return (DoorLayout.SLOT_LAST_OWNER_CLOSE, DoorLayout.OFFSET_LAST_OWNER_CLOSE, DoorLayout.SIZE_LAST_OWNER_CLOSE);
    }

    function _lastGuardianCloseField() internal pure override returns (uint256, uint256, uint256) {
        return (
            DoorLayout.SLOT_LAST_GUARDIAN_CLOSE,
            DoorLayout.OFFSET_LAST_GUARDIAN_CLOSE,
            DoorLayout.SIZE_LAST_GUARDIAN_CLOSE
        );
    }

    function _primaryDisabledByField() internal pure override returns (uint256, uint256, uint256) {
        return (
            DoorLayout.SLOT_PRIMARY_DISABLED_BY,
            DoorLayout.OFFSET_PRIMARY_DISABLED_BY,
            DoorLayout.SIZE_PRIMARY_DISABLED_BY
        );
    }

    function _pendingSinceField() internal pure override returns (uint256, uint256, uint256) {
        return (DoorLayout.SLOT_PENDING_SINCE, DoorLayout.OFFSET_PENDING_SINCE, DoorLayout.SIZE_PENDING_SINCE);
    }

    function _itemMembers() internal pure override returns (uint256[2][6] memory) {
        return [
            [DoorLayout.ITEM_SCHEDULED_AT_OFFSET, DoorLayout.ITEM_SCHEDULED_AT_SIZE],
            [DoorLayout.ITEM_READY_AT_OFFSET, DoorLayout.ITEM_READY_AT_SIZE],
            [DoorLayout.ITEM_CLASS_OFFSET, DoorLayout.ITEM_CLASS_SIZE],
            [DoorLayout.ITEM_KIND_OFFSET, DoorLayout.ITEM_KIND_SIZE],
            [DoorLayout.ITEM_SELECTOR_OFFSET, DoorLayout.ITEM_SELECTOR_SIZE],
            [DoorLayout.ITEM_READY_BLOCK_OFFSET, DoorLayout.ITEM_READY_BLOCK_SIZE]
        ];
    }
}
