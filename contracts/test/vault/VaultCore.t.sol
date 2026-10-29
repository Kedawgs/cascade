// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeBase} from "../../src/CascadeBase.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {mirror} from "../mocks/Mirror.sol";

contract VaultCoreTest is VaultTestBase {
    address stranger = makeAddr("stranger");

    function nextAddress() internal view returns (address) {
        return vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
    }

    // ---- constructor ----

    function test_constructorDerivesColdkey() public view {
        assertEq(vault.coldkey(), mirror(address(vault)));
    }

    function test_constructorRejectsColdkeyMismatch() public {
        bytes32 derived = mirror(nextAddress());
        bytes32 wrong = bytes32(uint256(0xbad));
        vm.expectRevert(abi.encodeWithSelector(CascadeVault.ColdkeyMismatch.selector, wrong, derived));
        new CascadeVault(wrong, HK1, bridge, owner, guardian, 1e15, 0, address(0));
    }

    function test_constructorRejectsZeroHotkey() public {
        bytes32 expected = mirror(nextAddress());
        vm.expectRevert(CascadeVault.ZeroHotkey.selector);
        new CascadeVault(expected, bytes32(0), bridge, owner, guardian, 1e15, 0, address(0));
    }

    function test_constructorSetsRejectGrowth() public view {
        assertTrue(staking.rejectsGrowth(vault.coldkey()));
    }

    function test_constructorInitialHotkeyIsStakeHotkey() public {
        assertEq(vault.hotkeys(0), HK1);
        assertTrue(vault.isHotkey(HK1));
        assertEq(vault.stakeHotkey(), HK1);
        assertFalse(vault.isHotkey(HK2));
        vm.expectRevert();
        vault.hotkeys(1);

        address predicted = nextAddress();
        vm.expectEmit(predicted);
        emit CascadeVault.StakeHotkeySet(HK2);
        new CascadeVault(mirror(predicted), HK2, bridge, owner, guardian, 1e15, 0, address(0));
    }

    function test_constructorActivatesInitialFrontDoor() public {
        address predicted = nextAddress();
        vm.expectEmit(predicted);
        emit CascadeVault.FrontDoorActivated(BASE, bob);
        CascadeVault fresh = new CascadeVault(mirror(predicted), HK1, bridge, owner, guardian, 1e15, BASE, bob);

        bytes32 id = fresh.peerId(BASE, bob);
        assertTrue(fresh.frontDoorActive(id));
        assertEq(fresh.frontDoorProposedAt(id), 0);
        // only that pair: the same address on another chain is a different peer
        assertFalse(fresh.frontDoorActive(fresh.peerId(BITTENSOR, bob)));

        vm.prank(owner);
        vm.expectRevert(CascadeVault.PeerKnown.selector);
        fresh.proposeFrontDoor(BASE, bob);
    }

    function test_constructorWithoutInitialFrontDoorActivatesNone() public {
        vm.recordLogs();
        CascadeVault fresh =
            new CascadeVault(mirror(nextAddress()), HK1, bridge, owner, guardian, 1e15, BASE, address(0));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics.length == 0 || logs[i].topics[0] != CascadeVault.FrontDoorActivated.selector);
        }
        assertFalse(fresh.frontDoorActive(fresh.peerId(BASE, address(0))));
    }

    function test_initialFrontDoorDeliversAtOnceAndReturnsOnlyAfterTheDelay() public {
        vault = new CascadeVault(mirror(nextAddress()), HK1, bridge, owner, guardian, 1e15, BASE, bob);
        vm.deal(address(vault), ED);

        // no warp: a batch from the initial front door lands in the deploy block
        deliver(BASE, bob, 1, entries1(alice, 10e18), noEntries());
        assertEq(vault.balanceOf(alice), 1e25);

        // the guardian removes it at once, like any front door
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, bob);
        assertFalse(vault.frontDoorActive(vault.peerId(BASE, bob)));

        // and bringing it back waits the full registry delay
        uint256 t0 = block.timestamp;
        vm.prank(owner);
        vault.proposeFrontDoor(BASE, bob);
        vm.warp(t0 + 7 days - 1);
        vm.prank(owner);
        vm.expectRevert(CascadeBase.NotReady.selector);
        vault.activateFrontDoor(BASE, bob);

        vm.warp(t0 + 7 days);
        vm.prank(owner);
        vault.activateFrontDoor(BASE, bob);
        assertTrue(vault.frontDoorActive(vault.peerId(BASE, bob)));
    }

    // ---- token ----

    function test_tokenMetadata() public view {
        assertEq(vault.name(), "Cascade Staked TAO");
        assertEq(vault.symbol(), "csTAO");
        assertEq(vault.decimals(), 24);
    }

    function test_sharesNonTransferable() public {
        depositDirect(alice, 10e18);

        vm.startPrank(alice);
        vm.expectRevert(CascadeVault.NonTransferable.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        vault.transfer(bob, 1);
        vm.expectRevert(CascadeVault.NonTransferable.selector);
        vault.approve(bob, 1);
        vm.stopPrank();

        vm.prank(bob);
        vm.expectRevert(CascadeVault.NonTransferable.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        vault.transferFrom(alice, bob, 1);

        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(vault.balanceOf(bob), 0);
        assertEq(vault.allowance(alice, bob), 0);
    }

    // ---- front-door registry ----

    function test_frontDoorProposeActivateDelay() public {
        // setUp registered (BASE, frontDoor); the same address on another chain is a different peer.
        assertTrue(vault.frontDoorActive(vault.peerId(BASE, frontDoor)));
        assertFalse(vault.frontDoorActive(vault.peerId(BITTENSOR, frontDoor)));

        bytes32 id = vault.peerId(BASE, bob);
        assertEq(id, keccak256(abi.encode(uint64(8453), bob)));

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        vault.proposeFrontDoor(BASE, bob);

        vm.prank(owner);
        vm.expectRevert(CascadeBase.ZeroAddress.selector);
        vault.proposeFrontDoor(BASE, address(0));

        vm.prank(owner);
        vm.expectRevert(CascadeBase.NoProposal.selector);
        vault.activateFrontDoor(BASE, bob);

        uint64 t0 = uint64(block.timestamp);
        vm.expectEmit(address(vault));
        emit CascadeVault.FrontDoorProposed(BASE, bob, t0 + 7 days);
        vm.prank(owner);
        vault.proposeFrontDoor(BASE, bob);
        assertEq(vault.frontDoorProposedAt(id), t0);

        vm.warp(t0 + 7 days - 1);
        vm.prank(owner);
        vm.expectRevert(CascadeBase.NotReady.selector);
        vault.activateFrontDoor(BASE, bob);

        vm.warp(t0 + 7 days);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        vault.activateFrontDoor(BASE, bob);

        vm.expectEmit(address(vault));
        emit CascadeVault.FrontDoorActivated(BASE, bob);
        vm.prank(owner);
        vault.activateFrontDoor(BASE, bob);
        assertTrue(vault.frontDoorActive(id));
        assertEq(vault.frontDoorProposedAt(id), 0);

        vm.prank(owner);
        vm.expectRevert(CascadeVault.PeerKnown.selector);
        vault.proposeFrontDoor(BASE, bob);
    }

    function test_frontDoorCancelByGuardian() public {
        bytes32 id = vault.peerId(BASE, bob);
        vm.prank(owner);
        vault.proposeFrontDoor(BASE, bob);

        vm.prank(stranger);
        vm.expectRevert(CascadeBase.NotGuardian.selector);
        vault.cancelFrontDoorProposal(BASE, bob);

        vm.expectEmit(address(vault));
        emit CascadeVault.FrontDoorProposalCancelled(BASE, bob);
        vm.prank(guardian);
        vault.cancelFrontDoorProposal(BASE, bob);
        assertEq(vault.frontDoorProposedAt(id), 0);

        vm.prank(guardian);
        vm.expectRevert(CascadeBase.NoProposal.selector);
        vault.cancelFrontDoorProposal(BASE, bob);

        vm.warp(block.timestamp + 7 days);
        vm.prank(owner);
        vm.expectRevert(CascadeBase.NoProposal.selector);
        vault.activateFrontDoor(BASE, bob);
        assertFalse(vault.frontDoorActive(id));
    }

    function test_frontDoorRemoveByGuardian() public {
        bytes32 id = vault.peerId(BASE, frontDoor);

        vm.prank(stranger);
        vm.expectRevert(CascadeBase.NotGuardian.selector);
        vault.removeFrontDoor(BASE, frontDoor);

        vm.expectEmit(address(vault));
        emit CascadeVault.FrontDoorRemoved(BASE, frontDoor);
        vm.prank(guardian);
        vault.removeFrontDoor(BASE, frontDoor);
        assertFalse(vault.frontDoorActive(id));

        vm.prank(guardian);
        vm.expectRevert(CascadeVault.PeerNotActive.selector);
        vault.removeFrontDoor(BASE, frontDoor);
    }

    // ---- direct deposits ----

    function test_depositDirectMintsAtOffsetPrice() public {
        vm.deal(alice, 10e18);
        // A = 10e18 - 10e18 = 0, S = 0: 10e18 * (0 + 1e6) / (0 + 1) = 1e25
        vm.expectEmit(address(vault));
        emit CascadeVault.DepositedDirect(alice, 10e18, 1e25);
        vm.prank(alice);
        vault.depositDirect{value: 10e18}();

        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(vault.totalSupply(), 1e25);
        assertTrue(vault.directOnly(alice));
        assertEq(address(vault).balance, ED + 10e18);
        assertEq(alice.balance, 0);
    }

    function test_depositDirectSecondDepositExcludesOwnValue() public {
        depositDirect(alice, 10e18);
        // A = 15e18 - 5e18 = 10e18, S = 1e25:
        // 5e18 * (1e25 + 1e6) / (10e18 + 1) = 5e24 * (1e19 + 1) / (1e19 + 1) = 5e24
        vm.expectEmit(address(vault));
        emit CascadeVault.DepositedDirect(bob, 5e18, 5e24);
        depositDirect(bob, 5e18);

        assertEq(vault.balanceOf(bob), 5e24);
        assertEq(vault.totalSupply(), 15e24);
        assertTrue(vault.directOnly(bob));
    }

    function test_depositDirectRejectsMisaligned() public {
        vm.deal(alice, 10e18 + 1);
        vm.prank(alice);
        vm.expectRevert(CascadeVault.NotRaoAligned.selector);
        vault.depositDirect{value: 10e18 + 1}();
        assertEq(vault.totalSupply(), 0);
    }

    function test_depositDirectRejectsBelowMin() public {
        // 1e15 - 1e9 = 999_999 rao: aligned, one rao under the 1e15 minimum
        vm.deal(alice, 1e15 - 1e9);
        vm.prank(alice);
        vm.expectRevert(CascadeVault.BelowMinDeposit.selector);
        vault.depositDirect{value: 1e15 - 1e9}();

        // exactly the minimum mints 1e15 * 1e6 = 1e21
        depositDirect(bob, 1e15);
        assertEq(vault.balanceOf(bob), 1e21);

        vm.expectEmit(address(vault));
        emit CascadeVault.LimitSet("minDirectDeposit", 2e15, 0);
        vm.prank(owner);
        vault.setMinDirectDeposit(2e15);
        assertEq(vault.minDirectDeposit(), 2e15);

        vm.deal(carol, 1e15);
        vm.prank(carol);
        vm.expectRevert(CascadeVault.BelowMinDeposit.selector);
        vault.depositDirect{value: 1e15}();
    }

    function test_depositDirectRejectsAboveCap() public {
        vm.deal(alice, 1_001e18);
        vm.prank(alice);
        vm.expectRevert(CascadeVault.CapExceeded.selector);
        vault.depositDirect{value: 1_001e18}();

        // A = 0: 1_000e18 * 1e6 = 1e27, exactly at the cap
        vm.prank(alice);
        vault.depositDirect{value: 1_000e18}();
        assertEq(vault.balanceOf(alice), 1e27);

        // existing assets count against the cap: 1_000e18 + 1e15 > 1_000e18
        vm.deal(bob, 1e15);
        vm.prank(bob);
        vm.expectRevert(CascadeVault.CapExceeded.selector);
        vault.depositDirect{value: 1e15}();

        vm.expectEmit(address(vault));
        emit CascadeVault.LimitSet("maxTotalAssets", 1_001e18, 0);
        vm.prank(owner);
        vault.setMaxTotalAssets(1_001e18);
        assertEq(vault.maxTotalAssets(), 1_001e18);

        // A = 1_000e18, S = 1e27: 1e15 * (1e27 + 1e6) / (1_000e18 + 1) = 1e21 * (1e21 + 1) / (1e21 + 1) = 1e21
        vm.prank(bob);
        vault.depositDirect{value: 1e15}();
        assertEq(vault.balanceOf(bob), 1e21);
    }

    function test_depositDirectWhilePausedReverts() public {
        vm.prank(guardian);
        vault.pause();

        vm.deal(alice, 10e18);
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.depositDirect{value: 10e18}();
    }

    function test_allowFrontDoorRedeemsClearsFlagAndDepositSetsItAgain() public {
        depositDirect(alice, 10e18);
        assertTrue(vault.directOnly(alice));

        vm.expectEmit(address(vault));
        emit CascadeVault.FrontDoorRedeemsAllowed(alice);
        vm.prank(alice);
        vault.allowFrontDoorRedeems();
        assertFalse(vault.directOnly(alice));

        depositDirect(alice, 1e15);
        assertTrue(vault.directOnly(alice));
    }

    // ---- views ----

    function test_grossAssetsEqualsDepositsWithReserveFunded() public {
        // reserve only: 0 * 1e9 + 1e12 - 1e12 = 0
        assertEq(vault.grossAssets(), 0);

        depositDirect(alice, 10e18);
        assertEq(vault.rootStakeRao(), 0);
        assertEq(vault.grossAssets(), 10e18);
        assertEq(vault.unvestedRewards(), 0);
        assertEq(vault.totalAssets(), 10e18);
        // (10e18 + 1) * 1e18 / (1e25 + 1e6) = (1e19 + 1) * 1e18 / (1e6 * (1e19 + 1)) = 1e12
        assertEq(vault.price(), 1e12);

        // stake on a hotkey in the set counts (2_000_000 rao = 2e15 wei); stake elsewhere does not
        staking.donateStake(HK1, vault.coldkey(), 2_000_000);
        staking.donateStake(HK2, vault.coldkey(), 3_000_000);
        assertEq(vault.rootStakeRao(), 2_000_000);
        // 2_000_000 * 1e9 + (1e12 + 10e18) - 1e12 = 10_002e15
        assertEq(vault.grossAssets(), 10_002e15);
    }

    function test_grossAssetsFloorsAtZeroOnEmptyVault() public {
        address predicted = nextAddress();
        CascadeVault fresh = new CascadeVault(mirror(predicted), HK1, bridge, owner, guardian, 1e15, 0, address(0));
        assertEq(address(fresh).balance, 0);
        // 0 * 1e9 + 0 - 1e12 floors to 0
        assertEq(fresh.grossAssets(), 0);
        assertEq(fresh.totalAssets(), 0);
        // (0 + 1) * 1e18 / (0 + 1e6) = 1e12
        assertEq(fresh.price(), 1e12);

        // a partly funded reserve still floors: 1e12 - 1 - 1e12 → 0
        vm.deal(address(fresh), ED - 1);
        assertEq(fresh.grossAssets(), 0);
    }

    // ---- parameters ----

    function test_settersRejectInvalid() public {
        // spec defaults (maxTotalAssets is a plan decision)
        assertEq(vault.maxDailyOutflowBps(), 2000);
        assertEq(vault.minDailyOutflow(), 100e18);
        assertEq(vault.maxEntryValue(), 2_000e18);
        assertEq(vault.maxMessageValue(), 4_000e18);
        assertEq(vault.minChunk(), 10);
        assertEq(vault.payoutDelay(), 24 hours);
        assertEq(vault.maxFeeBps(), 100);
        assertEq(vault.maxFeeAbs(), 0.02e18);
        assertEq(vault.maxTotalAssets(), 1_000e18);
        assertEq(vault.minDirectDeposit(), 1e15);
        assertEq(vault.hotkeyDustRao(), 1_000_000);
        assertEq(vault.claimGasRequired(), 55_000_000);
        assertEq(vault.fallbackMinStakeRao(), 2_000_000);
        assertEq(vault.fallbackMinRemainRao(), 20_000_000);

        vm.startPrank(owner);
        // the exit protections have hard bounds: at most 50% of the base a day, a floor of at most 100 TAO
        vm.expectRevert(CascadeVault.InvalidParameter.selector);
        vault.setOutflowLimits(5_001, 100e18);
        vm.expectRevert(CascadeVault.InvalidParameter.selector);
        vault.setOutflowLimits(2000, 100e18 + 1);
        vm.expectRevert(CascadeVault.InvalidParameter.selector);
        vault.setMessageLimits(4_000e18 + 1, 4_000e18, 10);
        vm.expectRevert(CascadeVault.InvalidParameter.selector);
        vault.setMessageLimits(2_000e18, 4_000e18, 0);
        vm.expectRevert(CascadeVault.InvalidParameter.selector);
        vault.setMessageLimits(2_000e18, 4_000e18, 101);
        // a payout message above the lane's 5,000 TAO could never be sent
        vm.expectRevert(CascadeVault.InvalidParameter.selector);
        vault.setMessageLimits(2_000e18, 5_000e18 + 1, 10);
        // the fee ceiling: at most 5% of a chunk, or 0.1 TAO
        vm.expectRevert(CascadeVault.InvalidParameter.selector);
        vault.setFeeLimits(501, 0.02e18);
        vm.expectRevert(CascadeVault.InvalidParameter.selector);
        vault.setFeeLimits(100, 0.1e18 + 1);
        // the payout delay: 1 hour to 7 days
        vm.expectRevert(CascadeVault.InvalidParameter.selector);
        vault.setPayoutDelay(7 days + 1);
        vm.expectRevert(CascadeVault.InvalidParameter.selector);
        vault.setPayoutDelay(1 hours - 1);
        vm.expectRevert(CascadeVault.InvalidParameter.selector);
        vault.setPayoutDelay(0);
        // the unstake margin: at most 1 TAO per removal
        vm.expectRevert(CascadeVault.InvalidParameter.selector);
        vault.setUnstakeMarginRao(1e9 + 1);
        vm.expectRevert(CascadeVault.InvalidParameter.selector);
        vault.setFloorFallbacks(0, 1);
        vm.expectRevert(CascadeVault.InvalidParameter.selector);
        vault.setFloorFallbacks(5, 4);
        vm.expectRevert(CascadeVault.InvalidParameter.selector);
        vault.setFloorFallbacks(1, 1e9 + 1);

        // the boundaries themselves are accepted, each with its event
        vm.expectEmit(address(vault));
        emit CascadeVault.LimitSet("maxDailyOutflowBps", 5_000, 100e18);
        vault.setOutflowLimits(5_000, 100e18);
        vault.setOutflowLimits(0, 0);
        vm.expectEmit(address(vault));
        emit CascadeVault.LimitSet("maxEntryValue", 5_000e18, 5_000e18);
        vm.expectEmit(address(vault));
        emit CascadeVault.LimitSet("minChunk", 100, 0);
        vault.setMessageLimits(5_000e18, 5_000e18, 100);
        vault.setMessageLimits(1e18, 2e18, 1);
        vm.expectEmit(address(vault));
        emit CascadeVault.LimitSet("maxFeeBps", 500, 0.1e18);
        vault.setFeeLimits(500, 0.1e18);
        vm.expectEmit(address(vault));
        emit CascadeVault.LimitSet("payoutDelay", 1 hours, 0);
        vault.setPayoutDelay(1 hours);
        vm.expectEmit(address(vault));
        emit CascadeVault.LimitSet("payoutDelay", 7 days, 0);
        vault.setPayoutDelay(7 days);
        vm.expectEmit(address(vault));
        emit CascadeVault.LimitSet("unstakeMarginRao", 1e9, 0);
        vault.setUnstakeMarginRao(1e9);
        vm.expectEmit(address(vault));
        emit CascadeVault.LimitSet("fallbackMinStakeRao", 1e9, 1e9);
        vault.setFloorFallbacks(1e9, 1e9);
        vault.setFloorFallbacks(1, 1);
        vm.expectEmit(address(vault));
        emit CascadeVault.LimitSet("hotkeyDustRao", 5, 0);
        vault.setHotkeyDustRao(5);
        vm.expectEmit(address(vault));
        emit CascadeVault.ClaimGasSet(70_000_000);
        vault.setClaimGasRequired(70_000_000);
        vm.stopPrank();

        assertEq(vault.maxDailyOutflowBps(), 0);
        assertEq(vault.minDailyOutflow(), 0);
        assertEq(vault.maxEntryValue(), 1e18);
        assertEq(vault.maxMessageValue(), 2e18);
        assertEq(vault.minChunk(), 1);
        assertEq(vault.maxFeeBps(), 500);
        assertEq(vault.maxFeeAbs(), 0.1e18);
        assertEq(vault.payoutDelay(), 7 days);
        assertEq(vault.unstakeMarginRao(), 1e9);
        assertEq(vault.fallbackMinStakeRao(), 1);
        assertEq(vault.fallbackMinRemainRao(), 1);
        assertEq(vault.hotkeyDustRao(), 5);
        assertEq(vault.claimGasRequired(), 70_000_000);
    }

    function test_settersOwnerOnly() public {
        bytes memory unauthorized = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian);
        vm.startPrank(guardian);
        vm.expectRevert(unauthorized);
        vault.setOutflowLimits(2000, 100e18);
        vm.expectRevert(unauthorized);
        vault.setKeeper(guardian);
        vm.expectRevert(unauthorized);
        vault.setMinDirectDeposit(0);
        vm.expectRevert(unauthorized);
        vault.setMaxTotalAssets(0);
        vm.expectRevert(unauthorized);
        vault.setMessageLimits(1, 1, 1);
        vm.expectRevert(unauthorized);
        vault.setFeeLimits(0, 0);
        vm.expectRevert(unauthorized);
        vault.setPayoutDelay(0);
        vm.expectRevert(unauthorized);
        vault.setClaimGasRequired(0);
        vm.expectRevert(unauthorized);
        vault.setHotkeyDustRao(0);
        vm.expectRevert(unauthorized);
        vault.setFloorFallbacks(1, 1);
        vm.stopPrank();

        // the owner may clear the keeper (fallback-only mode)
        assertEq(vault.keeper(), keeper);
        vm.expectEmit(address(vault));
        emit CascadeVault.KeeperSet(address(0));
        vm.prank(owner);
        vault.setKeeper(address(0));
        assertEq(vault.keeper(), address(0));
    }

    // ---- receive ----

    function test_receiveRejectsDirectTransfer() public {
        vm.deal(alice, 1e18);
        vm.prank(alice);
        (bool ok, bytes memory data) = address(vault).call{value: 1e18}("");
        assertFalse(ok);
        assertEq(data, abi.encodeWithSelector(CascadeVault.DirectTransferNotAllowed.selector));
        assertEq(address(vault).balance, ED);
        assertEq(alice.balance, 1e18);
    }
}
