// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {Actor, Item} from "../../src/CascadeTypes.sol";

/// Test only: a CascadeFrontDoor that adds no storage and exposes, as `exposed_<name>` with the door
/// lens view's arguments and return type, each value the door lens serves (CascadeBase's state and the
/// front door's keeper), read inside the front door (rulings DA3, DB3a). The door lens parity tests
/// (I-33) compare each lens view with its exposure here, before and after Task 5d makes CascadeBase's
/// getters internal.
contract DoorInternals is CascadeFrontDoor {
    constructor(Params memory p) CascadeFrontDoor(p) {}

    function exposed_GUARDIAN_DELAY() external pure returns (uint64) {
        return GUARDIAN_DELAY;
    }

    function exposed_REGISTRY_DELAY() external pure returns (uint64) {
        return REGISTRY_DELAY;
    }

    function exposed_guardian() external view returns (address) {
        return guardian;
    }

    function exposed_bridgeEnabled(address bridge) external view returns (bool) {
        return bridgeEnabled[bridge];
    }

    function exposed_primaryBridge() external view returns (address) {
        return primaryBridge;
    }

    function exposed_PARAM_DELAY() external pure returns (uint64) {
        return PARAM_DELAY;
    }

    function exposed_EXECUTE_WINDOW() external pure returns (uint64) {
        return EXECUTE_WINDOW;
    }

    function exposed_STAMP_TYPEHASH() external pure returns (bytes32) {
        return STAMP_TYPEHASH;
    }

    function exposed_STAMP_MAX_TTL() external pure returns (uint64) {
        return STAMP_MAX_TTL;
    }

    function exposed_DOMAIN_SEPARATOR() external view returns (bytes32) {
        return DOMAIN_SEPARATOR;
    }

    function exposed_scheduled(bytes32 id) external view returns (Item memory) {
        return scheduled[id];
    }

    function exposed_bridgeKnown(address bridge) external view returns (bool) {
        return bridgeKnown[bridge];
    }

    function exposed_lastOwnerClose() external view returns (uint64) {
        return lastOwnerClose;
    }

    function exposed_lastGuardianClose() external view returns (uint64) {
        return lastGuardianClose;
    }

    function exposed_primaryDisabledBy() external view returns (Actor) {
        return primaryDisabledBy;
    }

    function exposed_pendingSince() external view returns (uint64) {
        return pendingSince;
    }

    function exposed_MS_PER_BLOCK() external view returns (uint64) {
        return MS_PER_BLOCK;
    }

    function exposed_ownerHold() external view returns (bool) {
        return ownerHold();
    }

    function exposed_guardianHold() external view returns (bool) {
        return guardianHold();
    }

    function exposed_exitsOpen() external view returns (bool) {
        return exitsOpen();
    }

    function exposed_keeper() external view returns (address) {
        return keeper;
    }
}
