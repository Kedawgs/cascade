// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {CcipAdapterBase} from "../../src/adapters/CcipAdapterBase.sol";
import {CcipBaseAdapter} from "../../src/adapters/CcipBaseAdapter.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {Client} from "../../src/vendor/ccip/Client.sol";
import {MockRouter} from "../mocks/MockRouter.sol";
import {MockTAO} from "../mocks/MockTAO.sol";

contract CcipBaseAdapterTest is Test {
    uint64 constant BITTENSOR = 964;
    uint64 constant BITTENSOR_SELECTOR = 2135107236357186872;

    MockTAO tao;
    MockRouter router;
    CcipBaseAdapter adapter;
    CascadeFrontDoor fd;

    address adapterBit = makeAddr("adapterBit");
    address vaultAddr = makeAddr("vault");
    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address alice = makeAddr("alice");
    address keeper = makeAddr("keeper");

    function setUp() public {
        tao = new MockTAO(18);
        router = new MockRouter(tao);
        router.setFee(1e15);
        adapter = new CcipBaseAdapter(
            CcipAdapterBase.Config({
                router: address(router),
                token: address(tao),
                localChainId: 8453,
                remoteChainId: BITTENSOR,
                remoteSelector: BITTENSOR_SELECTOR,
                remoteAdapter: adapterBit,
                gasBase: 1_000_000,
                gasPerEntry: 25_000
            }),
            0.01e18
        );
        fd = new CascadeFrontDoor(
            tao, adapter, BITTENSOR, vaultAddr, owner, guardian, 12 hours, 0.01e18, 10_000e18, 1e14
        );
        tao.mint(alice, 1_000e18);
        vm.prank(alice);
        tao.approve(address(fd), type(uint256).max);
        vm.deal(alice, 1 ether);
        vm.deal(keeper, 1 ether);
    }

    function _approvedSender(uint256 amount) internal returns (address) {
        tao.mint(address(this), amount);
        tao.approve(address(adapter), amount);
        return address(this);
    }

    function test_send_belowMinimumReverts() public {
        _approvedSender(1e18);
        uint256 min = 0.01e18;
        vm.expectRevert(abi.encodeWithSelector(CcipAdapterBase.BelowSendMinimum.selector, min - 1, min));
        adapter.send{value: 1e15}(BITTENSOR, vaultAddr, "", min - 1);

        adapter.send{value: 1e15}(BITTENSOR, vaultAddr, "", min);
        adapter.send{value: 1e15}(BITTENSOR, vaultAddr, "", 0);
    }

    function test_send_pullsTokensAndApprovesExactly() public {
        _approvedSender(1e18);
        adapter.send{value: 1e15}(BITTENSOR, vaultAddr, "", 1e18);
        assertEq(tao.balanceOf(address(router)), 1e18);
        assertEq(tao.balanceOf(address(this)), 0);
        assertEq(tao.balanceOf(address(adapter)), 0);
        assertEq(tao.allowance(address(adapter), address(router)), 0);
    }

    function test_send_paysRouterExactlyFee() public {
        _approvedSender(1e18);
        uint256 before = address(this).balance;
        adapter.send{value: 3e15}(BITTENSOR, vaultAddr, "", 1e18);
        assertEq(address(router).balance, 1e15);
        assertEq(address(adapter).balance, 2e15);
        assertEq(before - address(this).balance, 3e15);
    }

    function test_closeBatch_throughAdapter() public {
        vm.prank(alice);
        fd.deposit(1e18);
        vm.warp(block.timestamp + 12 hours);

        CascadeMessages.Entry[] memory deposits = new CascadeMessages.Entry[](1);
        deposits[0] = CascadeMessages.Entry(alice, 1e18);
        bytes memory batch = CascadeMessages.encodeBatch(1, deposits, new CascadeMessages.Entry[](0));

        uint256 fee = router.getFee(BITTENSOR_SELECTOR, adapter.buildMessage(vaultAddr, address(fd), batch, 1e18));
        vm.prank(keeper);
        fd.closeBatch{value: fee}();

        MockRouter.Sent memory s = router.lastSend();
        assertEq(s.data, adapter.encodePayload(vaultAddr, address(fd), batch));
        assertEq(s.tokenAmounts.length, 1);
        assertEq(s.tokenAmounts[0].token, address(tao));
        assertEq(s.tokenAmounts[0].amount, 1e18);
    }

    function _payoutsMessage() internal view returns (Client.Any2EVMMessage memory m) {
        CascadeMessages.Entry[] memory payouts = new CascadeMessages.Entry[](1);
        payouts[0] = CascadeMessages.Entry(alice, 1e18);
        bytes memory payload = adapter.encodePayload(
            address(fd), vaultAddr, CascadeMessages.encodePayouts(bytes32(uint256(1)), 0, payouts)
        );
        Client.EVMTokenAmount[] memory t = new Client.EVMTokenAmount[](1);
        t[0] = Client.EVMTokenAmount(address(tao), 1e18);
        m = Client.Any2EVMMessage({
            messageId: bytes32(uint256(7)),
            sourceChainSelector: BITTENSOR_SELECTOR,
            sender: abi.encode(adapterBit),
            data: payload,
            destTokenAmounts: t
        });
    }

    function test_ccipReceive_deliversTokensThenMessageToFrontDoor() public {
        (bool called, bool ok,) = router.deliver(address(adapter), _payoutsMessage(), 2_000_000);
        assertTrue(called);
        assertTrue(ok);
        assertEq(fd.claimable(alice), 1e18);
        assertEq(tao.balanceOf(address(adapter)), 0);
        assertEq(tao.balanceOf(address(fd)), 1e18);
    }

    function test_ccipReceive_frontDoorRevertIsAtomic() public {
        router.deliver(address(adapter), _payoutsMessage(), 2_000_000);
        uint256 adapterBal = tao.balanceOf(address(adapter));
        uint256 fdBal = tao.balanceOf(address(fd));

        (bool called, bool ok,) = router.deliver(address(adapter), _payoutsMessage(), 2_000_000);
        assertTrue(called);
        assertFalse(ok);
        assertEq(tao.balanceOf(address(adapter)), adapterBal);
        assertEq(tao.balanceOf(address(fd)), fdBal);
    }

    function test_noReceiveFunction() public {
        (bool ok,) = address(adapter).call{value: 1}("");
        assertFalse(ok);
    }

    receive() external payable {}
}
