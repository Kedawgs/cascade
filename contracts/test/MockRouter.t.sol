// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Client} from "../src/vendor/ccip/Client.sol";
import {IAny2EVMMessageReceiver} from "../src/vendor/ccip/IAny2EVMMessageReceiver.sol";
import {IRouterClient} from "../src/vendor/ccip/IRouterClient.sol";
import {MockRouter} from "./mocks/MockRouter.sol";
import {MockTAO} from "./mocks/MockTAO.sol";

contract RevertingReceiver is IERC165 {
    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == IAny2EVMMessageReceiver.ccipReceive.selector;
    }

    function ccipReceive(Client.Any2EVMMessage calldata) external pure {
        revert("nope");
    }
}

contract MockRouterTest is Test {
    uint64 constant SEL = 7;

    MockTAO tao;
    MockRouter router;

    function setUp() public {
        tao = new MockTAO(18);
        router = new MockRouter(tao);
        vm.deal(address(this), 100 ether);
    }

    function _args(uint32 gas) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes4(0xa69dd4aa), gas, bytes11(0));
    }

    function _msg(uint256 dataLen, uint256 amount) internal view returns (Client.EVM2AnyMessage memory m) {
        m.receiver = abi.encode(address(0xBEEF));
        m.data = new bytes(dataLen);
        m.extraArgs = _args(200_000);
        if (amount != 0) {
            m.tokenAmounts = new Client.EVMTokenAmount[](1);
            m.tokenAmounts[0] = Client.EVMTokenAmount(address(tao), amount);
        }
    }

    function _incoming(uint256 amount) internal view returns (Client.Any2EVMMessage memory m) {
        m.messageId = bytes32(uint256(1));
        m.sourceChainSelector = SEL;
        m.sender = abi.encode(address(0xCAFE));
        m.destTokenAmounts = new Client.EVMTokenAmount[](1);
        m.destTokenAmounts[0] = Client.EVMTokenAmount(address(tao), amount);
    }

    function test_getFee_rejectsBadExtraArgs() public {
        Client.EVM2AnyMessage memory m = _msg(0, 0);
        m.extraArgs = new bytes(68);
        vm.expectRevert(MockRouter.BadExtraArgs.selector);
        router.getFee(SEL, m);
    }

    function test_getFee_rejectsGasOverMax() public {
        Client.EVM2AnyMessage memory m = _msg(0, 0);
        m.extraArgs = _args(7_000_001);
        vm.expectRevert(abi.encodeWithSelector(MockRouter.GasTooHigh.selector, 7_000_001, 7_000_000));
        router.getFee(SEL, m);
        m.extraArgs = _args(7_000_000);
        router.getFee(SEL, m);
        assertEq(router.gasLimitOf(m.extraArgs), 7_000_000);
    }

    function test_getFee_rejectsDataOver32000() public {
        vm.expectRevert(abi.encodeWithSelector(MockRouter.DataTooLarge.selector, 32_000));
        router.getFee(SEL, _msg(32_000, 0));
        router.getFee(SEL, _msg(31_999, 0));
    }

    function test_ccipSend_requiresExactValue() public {
        router.setFee(1 ether);
        Client.EVM2AnyMessage memory m = _msg(4, 0);
        vm.expectRevert(IRouterClient.InvalidMsgValue.selector);
        router.ccipSend{value: 1 ether + 1}(SEL, m);
        vm.expectRevert(IRouterClient.InvalidMsgValue.selector);
        router.ccipSend{value: 1 ether - 1}(SEL, m);
        router.ccipSend{value: 1 ether}(SEL, m);
    }

    function test_ccipSend_pullsTokensAndRecords() public {
        router.setFee(1 ether);
        tao.mint(address(this), 10e18);
        tao.approve(address(router), 4e18);
        Client.EVM2AnyMessage memory m = _msg(4, 4e18);
        bytes32 id = router.ccipSend{value: 1 ether}(SEL, m);
        assertEq(id, keccak256(abi.encode(uint256(1))));
        assertEq(router.sendCount(), 1);
        assertEq(tao.balanceOf(address(router)), 4e18);
        assertEq(tao.balanceOf(address(this)), 6e18);
        MockRouter.Sent memory s = router.lastSend();
        assertEq(s.destSelector, SEL);
        assertEq(s.receiver, m.receiver);
        assertEq(s.data, m.data);
        assertEq(s.tokenAmounts.length, 1);
        assertEq(s.tokenAmounts[0].amount, 4e18);
        assertEq(s.extraArgs, m.extraArgs);
        assertEq(s.value, 1 ether);
        assertEq(s.messageId, id);
        assertEq(router.sendAt(0).messageId, id);
    }

    function test_deliver_skipsNonReceiverButMintsTokens() public {
        address eoa = address(0xE0A);
        (bool called, bool ok, bytes memory reason) = router.deliver(eoa, _incoming(3e18), 1_000_000);
        assertFalse(called);
        assertTrue(ok);
        assertEq(reason.length, 0);
        assertEq(tao.balanceOf(eoa), 3e18);
    }

    function test_deliver_isAtomic() public {
        address r = address(new RevertingReceiver());
        (bool called, bool ok, bytes memory reason) = router.deliver(r, _incoming(3e18), 1_000_000);
        assertTrue(called);
        assertFalse(ok);
        assertEq(bytes4(reason), MockRouter.DeliveryFailed.selector);
        assertEq(tao.balanceOf(r), 0);
    }
}
