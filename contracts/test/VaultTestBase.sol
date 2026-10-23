// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CascadeVault} from "../src/CascadeVault.sol";
import {ISTAKING_ADDRESS} from "../src/interfaces/IStaking.sol";
import {ADDRESS_MAPPING_ADDRESS} from "../src/interfaces/IAddressMapping.sol";
import {CascadeMessages} from "../src/libraries/CascadeMessages.sol";
import {MockStaking} from "./mocks/MockStaking.sol";
import {MockAddressMapping} from "./mocks/MockAddressMapping.sol";
import {StubBridge} from "./mocks/StubBridge.sol";
import {mirror} from "./mocks/Mirror.sol";

/// @notice Shared vault fixture: precompile mocks etched, native stub bridge, vault deployed at its
/// predicted address with the existential reserve funded, keeper set and (BASE, frontDoor) registered.
abstract contract VaultTestBase is Test {
    uint64 constant BASE = 8453;
    uint64 constant BITTENSOR = 964;
    bytes32 constant HK1 = bytes32(uint256(1));
    bytes32 constant HK2 = bytes32(uint256(2));
    bytes32 constant HK3 = bytes32(uint256(3));
    bytes32 constant HK4 = bytes32(uint256(4));
    bytes32 constant HK5 = bytes32(uint256(5));
    uint256 constant ED = 1e12;

    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address keeper = makeAddr("keeper");
    address frontDoor = makeAddr("frontDoor");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    MockStaking staking = MockStaking(ISTAKING_ADDRESS);
    StubBridge bridge;
    CascadeVault vault;
    uint64 nextBatchId;

    function setUp() public virtual {
        vm.etch(ISTAKING_ADDRESS, address(new MockStaking()).code);
        vm.etch(ADDRESS_MAPPING_ADDRESS, address(new MockAddressMapping()).code);
        staking.addHotkey(HK1);
        staking.addHotkey(HK2);
        staking.addHotkey(HK3);
        staking.addHotkey(HK4);
        staking.addHotkey(HK5);

        bridge = new StubBridge(IERC20(address(0)));
        bridge.setFee(1e15);

        bytes32 expectedColdkey = mirror(vm.computeCreateAddress(address(this), vm.getNonce(address(this))));
        vault = new CascadeVault(expectedColdkey, HK1, bridge, owner, guardian, 1e15);
        // The operator funds the existential reserve before use (Task 13 documents it).
        vm.deal(address(vault), ED);

        vm.prank(owner);
        vault.setKeeper(keeper);
        registerFrontDoor(BASE, frontDoor);
    }

    function registerFrontDoor(uint64 chain, address addr) internal {
        vm.prank(owner);
        vault.proposeFrontDoor(chain, addr);
        vm.warp(block.timestamp + 7 days);
        vm.prank(owner);
        vault.activateFrontDoor(chain, addr);
    }

    function depositDirect(address user, uint256 amount) internal {
        vm.deal(user, user.balance + amount);
        vm.prank(user);
        vault.depositDirect{value: amount}();
    }

    /// Delivers a BATCH from (chain, sender) through the stub bridge with value == amount == Σ deposits.
    function deliver(
        uint64 chain,
        address sender,
        uint64 batchId,
        CascadeMessages.Entry[] memory deposits,
        CascadeMessages.Entry[] memory redeems
    ) internal returns (bytes32 key) {
        bytes memory message = CascadeMessages.encodeBatch(batchId, deposits, redeems);
        uint256 sum;
        for (uint256 i; i < deposits.length; ++i) {
            sum += deposits[i].amount;
        }
        vm.deal(address(bridge), address(bridge).balance + sum);
        vm.prank(address(bridge));
        vault.onBridgeMessage{value: sum}(chain, sender, message, sum);
        return vault.batchKey(chain, sender, message);
    }

    function depositVia(address user, uint256 amount) internal returns (bytes32) {
        return deliver(BASE, frontDoor, ++nextBatchId, entries1(user, amount), noEntries());
    }

    function entries1(address user, uint256 amount) internal pure returns (CascadeMessages.Entry[] memory e) {
        e = new CascadeMessages.Entry[](1);
        e[0] = CascadeMessages.Entry(user, amount);
    }

    function noEntries() internal pure returns (CascadeMessages.Entry[] memory) {
        return new CascadeMessages.Entry[](0);
    }
}
