// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {CascadeFrontDoor} from "../src/CascadeFrontDoor.sol";
import {MockTAO} from "./mocks/MockTAO.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {StubBridge} from "./mocks/StubBridge.sol";

/// @notice Shared front-door fixture: 18-decimal bridged TAO, 6-decimal USDC, an ERC-20-side stub
/// bridge charging 1e15 wei, and a front door with a 12h interval, 1 TAO minimum, 10,000 TAO cap and
/// a 1e14 wei redeem-request fee. alice, bob and carol each hold 1,000 TAO (approved) and 1 ether.
abstract contract FrontDoorTestBase is Test {
    uint64 constant BITTENSOR = 964;

    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address vault = makeAddr("vault");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    MockTAO tao;
    MockUSDC usdc;
    StubBridge bridge;
    CascadeFrontDoor fd;
    uint256 fillerCount;

    function setUp() public virtual {
        tao = new MockTAO(18);
        usdc = new MockUSDC();
        bridge = new StubBridge(tao);
        bridge.setFee(1e15);
        fd = new CascadeFrontDoor(tao, bridge, BITTENSOR, vault, owner, guardian, 12 hours, 1e18, 10_000e18, 1e14, usdc);

        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < users.length; ++i) {
            tao.mint(users[i], 1_000e18);
            vm.prank(users[i]);
            tao.approve(address(fd), type(uint256).max);
            vm.deal(users[i], 1 ether);
        }
    }

    /// n fresh addresses, each dealt 1e14 wei, each requesting 1 share with the fee.
    function fillRedeems(uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            address filler = makeAddr(string.concat("filler", vm.toString(++fillerCount)));
            vm.deal(filler, 1e14);
            requestWithFee(filler, 1);
        }
    }

    /// A first request in the open batch, paying the current redeemRequestFee as msg.value.
    function requestWithFee(address user, uint256 shares) internal {
        uint256 fee = fd.redeemRequestFee();
        vm.prank(user);
        fd.requestRedeem{value: fee}(shares);
    }
}
