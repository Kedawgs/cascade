// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IStaking, ISTAKING_ADDRESS} from "../src/interfaces/IStaking.sol";
import {MockStaking} from "./mocks/MockStaking.sol";
import {MockTAO} from "./mocks/MockTAO.sol";

/// @dev Forwards to the precompile so the mock sees a contract as msg.sender, like the real engine.
contract Staker {
    IStaking internal constant S = IStaking(ISTAKING_ADDRESS);

    function add(bytes32 hotkey, uint256 amount, uint256 netuid) external {
        S.addStake(hotkey, amount, netuid);
    }

    function addWithValue(bytes32 hotkey, uint256 amount, uint256 netuid) external payable {
        S.addStake{value: msg.value}(hotkey, amount, netuid);
    }

    function remove(bytes32 hotkey, uint256 amount, uint256 netuid) external {
        S.removeStake(hotkey, amount, netuid);
    }

    function move(bytes32 from, bytes32 to, uint256 fromNetuid, uint256 toNetuid, uint256 amount) external {
        S.moveStake(from, to, fromNetuid, toNetuid, amount);
    }

    function claim(bytes32 hotkey) external {
        S.claimRootWithHotkey(hotkey);
    }

    function setReject(bool enabled) external {
        S.setRejectStakingHotkeyGrowth(enabled);
    }
}

contract MockStakingTest is Test {
    MockStaking staking;
    Staker staker;
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 hotkey = bytes32("hk1");
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 hotkey2 = bytes32("hk2");

    function _installStaking() internal {
        MockStaking impl = new MockStaking();
        vm.etch(ISTAKING_ADDRESS, address(impl).code);
        staking = MockStaking(ISTAKING_ADDRESS);
    }

    function setUp() public {
        _installStaking();
        staker = new Staker();
        vm.deal(address(staker), 10 ether);
        staking.addHotkey(hotkey);
        staking.addHotkey(hotkey2);
    }

    function _coldkey() internal view returns (bytes32) {
        return staking.mirror(address(staker));
    }

    function test_addStakeDebitsBalanceAndRecordsStake() public {
        staker.add(hotkey, 3e9, 0);
        assertEq(address(staker).balance, 7 ether);
        assertEq(staking.getStake(hotkey, _coldkey(), 0), 3e9);
    }

    function test_removeStakeCreditsBalance() public {
        staker.add(hotkey, 3e9, 0);
        staker.remove(hotkey, 1e9, 0);
        assertEq(address(staker).balance, 8 ether);
        assertEq(staking.getStake(hotkey, _coldkey(), 0), 2e9);
    }

    function test_addStakeBelowMinimumReverts() public {
        vm.expectRevert(MockStaking.BelowMinStake.selector);
        staker.add(hotkey, 1_999_999, 0);
    }

    function test_addStakeUnknownHotkeyReverts() public {
        vm.expectRevert(MockStaking.UnknownHotkey.selector);
        // forge-lint: disable-next-line(unsafe-typecast)
        staker.add(bytes32("nope"), 3e9, 0);
    }

    function test_addStakeInsufficientBalanceReverts() public {
        vm.expectRevert(MockStaking.InsufficientBalance.selector);
        staker.add(hotkey, 11e9, 0);
    }

    function test_removeStakeInsufficientStakeReverts() public {
        vm.expectRevert(MockStaking.InsufficientStake.selector);
        staker.remove(hotkey, 3e9, 0);
    }

    function test_removeStakePartialBelowMinimumReverts() public {
        staker.add(hotkey, 3_000_000, 0);
        vm.expectRevert(MockStaking.BelowMinStake.selector);
        staker.remove(hotkey, 1_000_000, 0);
    }

    function test_removeStakeFullPositionBelowMinimumAllowed() public {
        staker.add(hotkey, 3_000_000, 0);
        vm.expectRevert(MockStaking.BelowMinStake.selector);
        staker.remove(hotkey, 1_000_000, 0);

        // Leave a 1_000_000-rao position, then remove all of it: allowed although below the minimum.
        staker.remove(hotkey, 2_000_000, 0);
        staker.remove(hotkey, 1_000_000, 0);
        assertEq(staking.getStake(hotkey, _coldkey(), 0), 0);
        assertEq(address(staker).balance, 10 ether);
    }

    function test_removeStakeBlockedRevertsTooEarly() public {
        staker.add(hotkey, 3e9, 0);
        staking.setUnstakeBlocked(true);
        vm.expectRevert(MockStaking.TooEarly.selector);
        staker.remove(hotkey, 1e9, 0);
    }

    function test_valueSentToPrecompileReverts() public {
        vm.expectRevert(MockStaking.UnexpectedValue.selector);
        staker.addWithValue{value: 1}(hotkey, 3e9, 0);
    }

    function test_claimRootMovesUnclaimedIntoRootStake() public {
        staking.accrueRootReward(_coldkey(), hotkey, 5e8);
        assertEq(staking.getUnclaimedRootTaoByHotkey(_coldkey(), hotkey), 5e17);
        staker.claim(hotkey);
        assertEq(staking.getStake(hotkey, _coldkey(), 0), 5e8);
        assertEq(staking.getUnclaimedRootTaoByHotkey(_coldkey(), hotkey), 0);
    }

    function test_moveStakeBetweenHotkeys() public {
        staker.add(hotkey, 3e9, 0);
        staker.move(hotkey, hotkey2, 0, 0, 3e9);
        assertEq(staking.getStake(hotkey, _coldkey(), 0), 0);
        assertEq(staking.getStake(hotkey2, _coldkey(), 0), 3e9);
    }

    function test_rejectGrowthFlagIsPerColdkey() public {
        staker.setReject(true);
        assertTrue(staking.rejectsGrowth(_coldkey()));
        assertFalse(staking.rejectsGrowth(staking.mirror(address(0xBEEF))));
    }

    function test_donateStakeIncreasesStakeWithoutPayment() public {
        staking.donateStake(hotkey, _coldkey(), 1e9);
        assertEq(staking.getStake(hotkey, _coldkey(), 0), 1e9);
        assertEq(address(staker).balance, 10 ether);
    }

    function test_mockTaoDecimalsFromConstructor() public {
        assertEq(new MockTAO(6).decimals(), 6);
        assertEq(new MockTAO(18).decimals(), 18);
    }
}
