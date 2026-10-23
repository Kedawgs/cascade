// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CascadeBase} from "../src/CascadeBase.sol";

contract BaseHarness is CascadeBase {
    constructor(address owner_, address guardian_, address initialBridge)
        CascadeBase(owner_, guardian_, initialBridge)
    {}

    function requireBridge() external view {
        _requireBridge();
    }

    function primary() external view returns (address) {
        return address(_primary());
    }
}

contract CascadeBaseTest is Test {
    BaseHarness base;
    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address bridge = makeAddr("bridge");
    address bridge2 = makeAddr("bridge2");
    address stranger = makeAddr("stranger");

    function setUp() public {
        base = new BaseHarness(owner, guardian, bridge);
    }

    function test_constructorEnablesInitialBridgeAsPrimary() public view {
        assertTrue(base.bridgeEnabled(bridge));
        assertEq(base.primaryBridge(), bridge);
        assertEq(base.guardian(), guardian);
        assertEq(base.owner(), owner);
    }

    function test_constructorRejectsZeroGuardianAndBridge() public {
        vm.expectRevert(CascadeBase.ZeroAddress.selector);
        new BaseHarness(owner, address(0), bridge);
        vm.expectRevert(CascadeBase.ZeroAddress.selector);
        new BaseHarness(owner, guardian, address(0));
    }

    function test_proposeThenActivateAfterSevenDays() public {
        uint64 t0 = uint64(block.timestamp);
        vm.expectEmit(true, false, false, true);
        emit CascadeBase.BridgeProposed(bridge2, t0 + 7 days);
        vm.prank(owner);
        base.proposeBridge(bridge2);
        assertEq(base.bridgeProposedAt(bridge2), t0);

        vm.warp(t0 + 7 days - 1);
        vm.prank(owner);
        vm.expectRevert(CascadeBase.NotReady.selector);
        base.activateBridge(bridge2);

        vm.warp(t0 + 7 days);
        vm.prank(owner);
        base.activateBridge(bridge2);
        assertTrue(base.bridgeEnabled(bridge2));
        assertEq(base.bridgeProposedAt(bridge2), 0);
    }

    function test_proposeEnabledBridgeReverts() public {
        vm.prank(owner);
        vm.expectRevert(CascadeBase.BridgeKnown.selector);
        base.proposeBridge(bridge);
    }

    function test_activateWithoutProposalReverts() public {
        vm.prank(owner);
        vm.expectRevert(CascadeBase.NoProposal.selector);
        base.activateBridge(bridge2);
    }

    function test_guardianCancelsProposal() public {
        vm.prank(owner);
        base.proposeBridge(bridge2);

        vm.prank(stranger);
        vm.expectRevert(CascadeBase.NotGuardian.selector);
        base.cancelBridgeProposal(bridge2);

        vm.prank(guardian);
        base.cancelBridgeProposal(bridge2);
        assertEq(base.bridgeProposedAt(bridge2), 0);
    }

    function test_guardianDisablesBridge() public {
        vm.prank(guardian);
        base.disableBridge(bridge);
        assertFalse(base.bridgeEnabled(bridge));

        vm.prank(guardian);
        vm.expectRevert(CascadeBase.BridgeNotEnabled.selector);
        base.disableBridge(bridge);
    }

    function test_setPrimaryRequiresEnabled() public {
        vm.prank(owner);
        vm.expectRevert(CascadeBase.BridgeNotEnabled.selector);
        base.setPrimaryBridge(bridge2);
    }

    function test_disabledPrimaryMakesPrimaryQueryRevert() public {
        vm.prank(guardian);
        base.disableBridge(bridge);
        vm.expectRevert(CascadeBase.PrimaryBridgeDisabled.selector);
        base.primary();

        vm.startPrank(owner);
        base.proposeBridge(bridge2);
        vm.warp(block.timestamp + 7 days);
        base.activateBridge(bridge2);
        base.setPrimaryBridge(bridge2);
        vm.stopPrank();
        assertEq(base.primary(), bridge2);
    }

    function test_requireBridgeRejectsStranger() public {
        vm.prank(stranger);
        vm.expectRevert(CascadeBase.NotBridge.selector);
        base.requireBridge();

        vm.prank(bridge);
        base.requireBridge();
    }

    function test_pauseByGuardianUnpauseByOwnerOnly() public {
        vm.prank(guardian);
        base.pause();
        assertTrue(base.paused());

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        base.unpause();

        vm.prank(owner);
        base.unpause();
        assertFalse(base.paused());

        vm.prank(stranger);
        vm.expectRevert(CascadeBase.NotGuardian.selector);
        base.pause();
    }

    function test_renounceReverts() public {
        vm.prank(owner);
        vm.expectRevert(CascadeBase.RenounceDisabled.selector);
        base.renounceOwnership();
    }
}
