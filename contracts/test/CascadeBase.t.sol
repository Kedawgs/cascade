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
    address guardian2 = makeAddr("guardian2");

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

    // ---- guardian replacement ----

    function test_noImmediateGuardianSetter() public {
        vm.prank(owner);
        (bool ok,) = address(base).call(abi.encodeWithSignature("setGuardian(address)", guardian2));
        assertFalse(ok);
        assertEq(base.guardian(), guardian);
    }

    function test_guardianReplacementWaitsEightDays() public {
        assertEq(base.GUARDIAN_DELAY(), 8 days);
        uint64 t0 = uint64(block.timestamp);
        vm.expectEmit(address(base));
        emit CascadeBase.GuardianProposed(guardian2, t0 + 8 days);
        vm.prank(owner);
        base.proposeGuardian(guardian2);
        assertEq(base.pendingGuardian(), guardian2);
        assertEq(base.guardianProposedAt(), t0);

        vm.warp(t0 + 8 days - 1);
        vm.prank(owner);
        vm.expectRevert(CascadeBase.NotReady.selector);
        base.acceptGuardian();
        assertEq(base.guardian(), guardian);
        // the sitting guardian keeps its powers through the delay
        vm.prank(guardian2);
        vm.expectRevert(CascadeBase.NotGuardian.selector);
        base.pause();
        vm.prank(guardian);
        base.pause();

        vm.warp(t0 + 8 days);
        vm.prank(guardian2);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian2));
        base.acceptGuardian();

        vm.expectEmit(address(base));
        emit CascadeBase.GuardianSet(guardian2);
        vm.prank(owner);
        base.acceptGuardian();
        assertEq(base.guardian(), guardian2);
        assertEq(base.pendingGuardian(), address(0));
        assertEq(base.guardianProposedAt(), 0);

        // the old guardian is out, the new one is in
        vm.prank(guardian);
        vm.expectRevert(CascadeBase.NotGuardian.selector);
        base.disableBridge(bridge);
        vm.prank(guardian2);
        base.disableBridge(bridge);
        assertFalse(base.bridgeEnabled(bridge));
    }

    function test_proposeGuardianRules() public {
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        base.proposeGuardian(guardian2);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        base.proposeGuardian(stranger);

        vm.startPrank(owner);
        vm.expectRevert(CascadeBase.ZeroAddress.selector);
        base.proposeGuardian(address(0));
        vm.expectRevert(CascadeBase.NoProposal.selector);
        base.acceptGuardian();
        vm.expectRevert(CascadeBase.NoProposal.selector);
        base.cancelGuardianProposal();

        // re-proposing restarts the delay
        uint64 t0 = uint64(block.timestamp);
        base.proposeGuardian(stranger);
        vm.warp(t0 + 4 days);
        base.proposeGuardian(guardian2);
        assertEq(base.pendingGuardian(), guardian2);
        assertEq(base.guardianProposedAt(), t0 + 4 days);
        vm.warp(t0 + 8 days);
        vm.expectRevert(CascadeBase.NotReady.selector);
        base.acceptGuardian();
        vm.warp(t0 + 12 days);
        base.acceptGuardian();
        vm.stopPrank();
        assertEq(base.guardian(), guardian2);
    }

    function test_guardianCannotCancelItsReplacement() public {
        vm.prank(owner);
        base.proposeGuardian(guardian2);

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        base.cancelGuardianProposal();
        assertEq(base.pendingGuardian(), guardian2);

        vm.expectEmit(address(base));
        emit CascadeBase.GuardianProposalCancelled(guardian2);
        vm.prank(owner);
        base.cancelGuardianProposal();
        assertEq(base.pendingGuardian(), address(0));
        assertEq(base.guardianProposedAt(), 0);

        vm.warp(block.timestamp + 8 days);
        vm.prank(owner);
        vm.expectRevert(CascadeBase.NoProposal.selector);
        base.acceptGuardian();
        assertEq(base.guardian(), guardian);
    }

    function test_renounceReverts() public {
        vm.prank(owner);
        vm.expectRevert(CascadeBase.RenounceDisabled.selector);
        base.renounceOwnership();
    }
}
