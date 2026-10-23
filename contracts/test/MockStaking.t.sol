// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IStaking, ISTAKING_ADDRESS} from "../src/interfaces/IStaking.sol";
import {IAddressMapping, ADDRESS_MAPPING_ADDRESS} from "../src/interfaces/IAddressMapping.sol";
import {ICascadeBridge} from "../src/interfaces/ICascadeBridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockStaking} from "./mocks/MockStaking.sol";
import {MockAddressMapping} from "./mocks/MockAddressMapping.sol";
import {StubBridge} from "./mocks/StubBridge.sol";
import {MockTAO} from "./mocks/MockTAO.sol";
import {mirror} from "./mocks/Mirror.sol";

contract MockStakingTest is Test {
    bytes32 constant HK1 = keccak256("hotkey1");
    uint256 constant RAO = 1e9;

    MockStaking staking = MockStaking(ISTAKING_ADDRESS);

    function setUp() public {
        vm.etch(ISTAKING_ADDRESS, address(new MockStaking()).code);
        vm.etch(ADDRESS_MAPPING_ADDRESS, address(new MockAddressMapping()).code);
        staking.addHotkey(HK1);
        vm.deal(address(this), 1_000_000 ether);
    }

    function _me() internal view returns (bytes32) {
        return mirror(address(this));
    }

    function test_addressMappingMatchesMirror() public view {
        address x = address(0xBEEF);
        assertEq(IAddressMapping(ADDRESS_MAPPING_ADDRESS).addressMapping(x), mirror(x));
        assertEq(mirror(x), keccak256(abi.encodePacked("evm:", x)));
    }

    function test_defaultsWithoutConstructor() public view {
        assertEq(staking.getDefaultMinStake(), 2_000_000);
        assertEq(staking.getNominatorMinRequiredStake(), 20_000_000);
    }

    function test_freshPositionReadsOneRaoShort() public {
        staking.addStake(HK1, 5_000_000, 0);
        assertEq(staking.getStake(HK1, _me(), 0), 4_999_999);
        vm.expectRevert(MockStaking.BelowMinStake.selector);
        staking.addStake(HK1, 1_000_000, 0);
        staking.addStake(HK1, 2_000_000, 0);
        assertEq(staking.getStake(HK1, _me(), 0), 6_999_999);
    }

    function test_exactReadsWhenShortDisabled() public {
        staking.setOneRaoShort(false);
        staking.addStake(HK1, 5_000_000, 0);
        assertEq(staking.getStake(HK1, _me(), 0), 5_000_000);
    }

    function test_removeStakeClipsOverRequestToFullExit() public {
        staking.setOneRaoShort(false);
        staking.addStake(HK1, 30_000_000, 0);
        uint256 before = address(this).balance;
        staking.removeStake(HK1, 40_000_000, 0);
        assertEq(staking.getStake(HK1, _me(), 0), 0);
        assertEq(address(this).balance, before + 30_000_000 * RAO);
    }

    function test_removeStakePartialBelowMinReverts() public {
        staking.setOneRaoShort(false);
        staking.addStake(HK1, 30_000_000, 0);
        vm.expectRevert(MockStaking.AmountTooLow.selector);
        staking.removeStake(HK1, 1_000_000, 0);
    }

    function test_removeStakeSweepsSubNominatorRemainder() public {
        staking.setOneRaoShort(false);
        staking.addStake(HK1, 30_000_000, 0);
        uint256 before = address(this).balance;
        staking.removeStake(HK1, 15_000_000, 0);
        assertEq(staking.getStake(HK1, _me(), 0), 0);
        assertEq(address(this).balance, before + 30_000_000 * RAO);
    }

    function test_removeStakeFullEmptiesPosition() public {
        staking.setOneRaoShort(false);
        staking.addStake(HK1, 30_000_000, 0);
        uint256 before = address(this).balance;
        staking.removeStakeFull(HK1, 0);
        assertEq(staking.getStake(HK1, _me(), 0), 0);
        assertEq(address(this).balance, before + 30_000_000 * RAO);
        staking.removeStakeFull(HK1, 0); // empty position is fine
        assertEq(address(this).balance, before + 30_000_000 * RAO);
    }

    function test_claimBurnsAllGasBelowRequirement() public {
        staking.setOneRaoShort(false);
        staking.setUnclaimed(_me(), HK1, 1e6);
        (bool ok,) = address(staking).call{gas: 1_000_000}(abi.encodeCall(IStaking.claimRootWithHotkey, (HK1)));
        assertFalse(ok);
        assertEq(staking.getUnclaimedRootTaoByHotkey(_me(), HK1), 1e6 * RAO);
        assertEq(staking.getStake(HK1, _me(), 0), 0);
    }

    function test_claimTooHeavyBurnsGas() public {
        staking.setClaimTooHeavy(true);
        staking.setUnclaimed(_me(), HK1, 1e6);
        (bool ok,) = address(staking).call{gas: 60_000_000}(abi.encodeCall(IStaking.claimRootWithHotkey, (HK1)));
        assertFalse(ok);
        assertEq(staking.getUnclaimedRootTaoByHotkey(_me(), HK1), 1e6 * RAO);
    }

    function test_claimMovesUnclaimedIntoStake() public {
        staking.setOneRaoShort(false);
        staking.setUnclaimed(_me(), HK1, 1e6);
        (bool ok,) = address(staking).call{gas: 60_000_000}(abi.encodeCall(IStaking.claimRootWithHotkey, (HK1)));
        assertTrue(ok);
        assertEq(staking.getStake(HK1, _me(), 0), 1e6);
        assertEq(staking.getUnclaimedRootTaoByHotkey(_me(), HK1), 0);
    }

    function test_getUnclaimedIs18Decimals() public {
        staking.setUnclaimed(_me(), HK1, 7);
        assertEq(staking.getUnclaimedRootTaoByHotkey(_me(), HK1), 7e9);
    }

    function test_stubBridgeNativeFeeRule() public {
        StubBridge bridge = new StubBridge(IERC20(address(0)));
        bridge.setFee(1e15);
        uint256 amount = 1 ether;
        vm.expectRevert(StubBridge.InsufficientFee.selector);
        bridge.send{value: amount + 1e15 - 1}(1, address(0xA), "", amount);
        bridge.send{value: amount + 1e15 + 5}(1, address(0xA), "hi", amount);
        assertEq(bridge.lastValue(), amount + 1e15 + 5);
        assertEq(bridge.lastAmount(), amount);
        assertEq(bridge.lastDestChain(), 1);
        assertEq(bridge.lastRecipient(), address(0xA));
        assertEq(bridge.lastMessage(), "hi");
        assertEq(bridge.sendCount(), 1);
        assertEq(address(bridge).balance, amount + 1e15 + 5);
        assertEq(bridge.quoteFee(1, address(0xA), "", amount), 1e15);
    }

    function test_stubBridgeErc20FeeRule() public {
        MockTAO tao = new MockTAO(18);
        StubBridge bridge = new StubBridge(IERC20(address(tao)));
        bridge.setFee(1e15);
        tao.mint(address(this), 10 ether);
        tao.approve(address(bridge), 10 ether);
        vm.expectRevert(StubBridge.InsufficientFee.selector);
        bridge.send{value: 1e15 - 1}(1, address(0xA), "", 1 ether);
        bridge.send{value: 1e15}(1, address(0xA), "", 1 ether);
        assertEq(tao.balanceOf(address(bridge)), 1 ether);
        assertEq(bridge.lastValue(), 1e15);
        assertEq(bridge.sendCount(), 1);
    }
}
