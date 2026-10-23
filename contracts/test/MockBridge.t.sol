// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ICascadeReceiver} from "../src/interfaces/ICascadeBridge.sol";
import {MockBridge} from "./mocks/MockBridge.sol";
import {MockTAO} from "./mocks/MockTAO.sol";

/// @notice Records every delivery it receives.
contract Recorder is ICascadeReceiver {
    uint256 public calls;
    uint64 public lastSourceChain;
    address public lastSender;
    bytes public lastMessage;
    uint256 public lastAmount;
    uint256 public lastValue;

    function onBridgeMessage(uint64 sourceChain, address sender, bytes calldata message, uint256 amount)
        external
        payable
    {
        ++calls;
        lastSourceChain = sourceChain;
        lastSender = sender;
        lastMessage = message;
        lastAmount = amount;
        lastValue = msg.value;
    }
}

/// @notice The mock bridge's own guards. `vaultSide` is a native endpoint on BITTENSOR, `baseSide` an
/// ERC-20 endpoint on BASE holding 1_000 TAO (approved), and `rx` a recording receiver on BASE.
contract MockBridgeTest is Test {
    uint64 constant BASE = 8453;
    uint64 constant BITTENSOR = 964;
    uint64 constant CHAIN2 = 4663;
    uint256 constant FEE = 1e15;

    address vaultSide = makeAddr("vaultSide");
    address baseSide = makeAddr("baseSide");
    address stranger = makeAddr("stranger");

    MockTAO tao;
    MockBridge bridge;
    Recorder rx;

    function setUp() public {
        tao = new MockTAO(18);
        bridge = new MockBridge(tao);
        bridge.setFee(FEE);
        rx = new Recorder();
        bridge.connect(BITTENSOR, vaultSide, true);
        bridge.connect(BASE, baseSide, false);
        bridge.connect(BASE, address(rx), false);

        vm.deal(vaultSide, 10_000e18);
        vm.deal(stranger, 1 ether);
        vm.deal(baseSide, 1 ether);
        tao.mint(baseSide, 1_000e18);
        vm.prank(baseSide);
        tao.approve(address(bridge), type(uint256).max);
    }

    function test_send_unknownSenderReverts() public {
        vm.prank(stranger);
        vm.expectRevert(MockBridge.UnknownSender.selector);
        bridge.send{value: FEE}(BASE, address(rx), "", 0);
    }

    function test_send_nativeFeeShortReverts() public {
        vm.prank(vaultSide);
        vm.expectRevert(MockBridge.InsufficientFee.selector);
        bridge.send{value: 1e18 + FEE - 1}(BASE, address(rx), "", 1e18);

        vm.prank(vaultSide);
        bridge.send{value: 1e18 + FEE}(BASE, address(rx), "", 1e18);
        assertEq(rx.calls(), 1);
    }

    function test_send_erc20FeeShortReverts() public {
        vm.prank(baseSide);
        vm.expectRevert(MockBridge.InsufficientFee.selector);
        bridge.send{value: FEE - 1}(BITTENSOR, vaultSide, "", 1e18);

        vm.prank(baseSide);
        bridge.send{value: FEE}(BITTENSOR, vaultSide, "", 1e18);
        // pulled from the sender, delivered as native value
        assertEq(tao.balanceOf(baseSide), 999e18);
        assertEq(tao.balanceOf(address(bridge)), 1e18);
        assertEq(vaultSide.balance, 10_000e18 + 1e18);
    }

    function test_send_overMaxMessageValueReverts() public {
        bridge.setMaxMessageValue(1e18);
        vm.prank(vaultSide);
        vm.expectRevert(MockBridge.RateLimited.selector);
        bridge.send{value: 1e18 + 1 + FEE}(BASE, address(rx), "", 1e18 + 1);

        vm.prank(vaultSide);
        bridge.send{value: 1e18 + FEE}(BASE, address(rx), "", 1e18);
        assertEq(rx.calls(), 1);
    }

    function test_send_unknownDestinationReverts() public {
        // the right recipient on the wrong chain
        vm.prank(vaultSide);
        vm.expectRevert(MockBridge.UnknownDestination.selector);
        bridge.send{value: FEE}(CHAIN2, address(rx), "", 0);

        // chain 0, to an address on no chain
        vm.prank(vaultSide);
        vm.expectRevert(MockBridge.UnknownDestination.selector);
        bridge.send{value: FEE}(0, stranger, "", 0);
    }

    function test_deliverNext_emptyQueueReverts() public {
        vm.expectRevert(MockBridge.NothingQueued.selector);
        bridge.deliverNext();
        vm.expectRevert(MockBridge.NothingQueued.selector);
        bridge.retryNext();
    }

    function test_autoDeliverOffKeepsSendPending() public {
        bridge.setAutoDeliver(false);
        vm.prank(vaultSide);
        bridge.send{value: 1e18 + FEE}(BASE, address(rx), "hello", 1e18);
        assertEq(bridge.pendingCount(), 1);
        assertEq(rx.calls(), 0);
        assertEq(tao.balanceOf(address(rx)), 0);

        assertTrue(bridge.deliverNext());
        assertEq(bridge.pendingCount(), 0);
        assertEq(rx.calls(), 1);
        assertEq(rx.lastSourceChain(), BITTENSOR);
        assertEq(rx.lastSender(), vaultSide);
        assertEq(rx.lastMessage(), "hello");
        assertEq(rx.lastAmount(), 1e18);
        // an ERC-20 destination: tokens minted before the call, no value
        assertEq(rx.lastValue(), 0);
        assertEq(tao.balanceOf(address(rx)), 1e18);
    }
}
