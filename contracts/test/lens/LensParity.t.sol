// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {ISTAKING_ADDRESS, IStaking} from "../../src/interfaces/IStaking.sol";
import {ADDRESS_MAPPING_ADDRESS, IAddressMapping} from "../../src/interfaces/IAddressMapping.sol";
import {ICascadeTwap} from "../../src/interfaces/ICascadeTwap.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {CascadeVaultLens} from "../../src/lens/CascadeVaultLens.sol";
import {CascadeDoorLens} from "../../src/lens/CascadeDoorLens.sol";
import {Redeemed} from "../../src/CascadeEvents.sol";
import {ZeroAddress} from "../../src/CascadeErrors.sol";
import {DIRECT_ORIGIN} from "../../src/CascadeConstants.sol";
import {Actor, DoorState} from "../../src/CascadeTypes.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {FrontDoorTestBase} from "../FrontDoorTestBase.sol";
import {MockTAO} from "../mocks/MockTAO.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {StubBridge} from "../mocks/StubBridge.sol";
import {mirror} from "../mocks/Mirror.sol";
import {VaultInternals} from "../utils/VaultInternals.sol";
import {DoorInternals} from "../utils/DoorInternals.sol";
import {defaultFrontDoorParams} from "../utils/DefaultParams.sol";
import {
    LensParityChecks,
    baseLensViews,
    baseMovedViews,
    doorLensViews,
    forwardedViews,
    vaultLensViews,
    vaultMovedViews
} from "../utils/LensViews.sol";
import {Schedule} from "../governance/Schedule.sol";

/// I-33 on the vault lens: every view equals the vault's own value (VaultInternals' exposure, and the
/// vault's getter for the two it keeps, totalSupply and balanceOf) over the fixture's states, reverts
/// included; every other getter is gone from the vault (CascadeBase's since Task 5d-1, the vault's own
/// since Task 5d-2). Runs under [profile.parity] (VaultInternals may pass EIP-170).
contract VaultLensParityTest is VaultTestBase, LensParityChecks {
    address treasury = makeAddr("treasury");
    address door2 = makeAddr("door2");
    StubBridge bridge2;

    /// The fixture's vault is a VaultInternals, so the parity check can read each value inside it.
    function deployVault(CascadeVault.Params memory p) internal override returns (CascadeVault) {
        return new VaultInternals(p);
    }

    /// The fixture's values with a 10% reward cut to the treasury from the constructor: naming a treasury and
    /// raising the cut are scheduled (Task 11), and the parity test claims with the cut from its first steps.
    function vaultParams() internal view override returns (CascadeVault.Params memory p) {
        p = super.vaultParams();
        p.treasury = treasury;
        p.rewardCutBps = 1_000;
    }

    function setUp() public override {
        super.setUp();
        staking.setOneRaoShort(false);
        bridge2 = new StubBridge(bridge.token());

        // hotkeys 0 (none) to 5, and a word nothing is stored under
        for (uint256 i; i <= 5; ++i) {
            trackWord(bytes32(i));
        }
        trackWord(keccak256("nothing is stored here"));
        trackPeer(BASE, frontDoor);
        trackPeer(BASE, door2);
        trackPeer(BITTENSOR, frontDoor);
        trackPeer(0, address(0));
        for (uint256 i; i < trackedChains.length; ++i) {
            trackWord(vaultLens.peerId(trackedChains[i], trackedPeers[i]));
        }
        address[11] memory accounts = [
            address(0),
            alice,
            bob,
            carol,
            owner,
            guardian,
            keeper,
            frontDoor,
            address(bridge),
            address(bridge2),
            treasury
        ];
        for (uint256 i; i < accounts.length; ++i) {
            trackAccount(accounts[i]);
        }
        trackMessage(0, address(0), "");
    }

    // ---- helpers ----

    function assertVaultLensParity(string memory label) internal view {
        assertLensParity(address(vaultLens), address(vault), vaultLensViews(), vaultMovedViews(), label);
    }

    /// External, so a test can expect the parity check itself to fail.
    function checkVaultLensParity(address lens, address internals, string[] memory views) external view {
        assertLensParity(lens, internals, views, vaultMovedViews(), "check");
    }

    /// A delivery from (BASE, frontDoor), with its batch key and message tracked; returns the key and
    /// the payouts it queued, from its Redeemed events.
    function deliverTracked(CascadeMessages.Entry[] memory deposits, CascadeMessages.Entry[] memory redeems)
        internal
        returns (bytes32 key, CascadeMessages.Payout[] memory payouts)
    {
        uint64 id = ++nextBatchId;
        vm.recordLogs();
        key = deliver(BASE, frontDoor, id, deposits, redeems);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        trackWord(key);
        trackMessage(BASE, frontDoor, CascadeMessages.encodeBatch(id, deposits, redeems));
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == Redeemed.selector) ++n;
        }
        payouts = new CascadeMessages.Payout[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != Redeemed.selector) continue;
            (uint256 shares, uint256 assets) = abi.decode(logs[i].data, (uint256, uint256));
            payouts[n++] = CascadeMessages.Payout(address(uint160(uint256(logs[i].topics[2]))), shares, assets);
        }
    }

    function entries2(address u1, uint256 a1, address u2, uint256 a2)
        internal
        pure
        returns (CascadeMessages.Entry[] memory e)
    {
        e = new CascadeMessages.Entry[](2);
        e[0] = CascadeMessages.Entry(u1, a1);
        e[1] = CascadeMessages.Entry(u2, a2);
    }

    // ---- I-33 over the fixture's states ----

    function test_vaultLensMatchesEveryGetter() public {
        // the owner's loosenings below are scheduled items (Task 11): each scheduled now and executed where the
        // test once set it directly, every such point past its 48 hours and inside its window
        bytes memory minChunkDown = abi.encodeCall(vault.setMessageLimits, (2_000e18, 4_000e18, 1));
        bytes memory toHk3 = abi.encodeCall(vault.setStakeHotkey, (HK3));
        bytes[4] memory settings = [
            abi.encodeCall(vault.setOutflowLimits, (3_000, 50e18, 3_500)),
            abi.encodeCall(vault.setFeeLimits, (200, 0.012e18)),
            abi.encodeCall(vault.setPayoutDelay, (2 hours)),
            abi.encodeCall(vault.setMaxTotalAssets, (5_000e18))
        ];
        vm.startPrank(owner);
        vault.schedule(minChunkDown);
        vault.schedule(toHk3);
        for (uint256 i; i < settings.length; ++i) {
            vault.schedule(settings[i]);
        }
        vm.stopPrank();
        assertVaultLensParity("empty");

        // deposits (direct and through the front door), a stake, a claim with a reward cut, and
        // redeems queued as a payout batch
        depositDirect(alice, 100e18);
        deliverTracked(entries2(bob, 200e18, carol, 300e18), noEntries());
        // bob's and carol's shares aged past the door hold (R4 B-H1), so their redeems below burn
        matureShares(bob);
        matureShares(carol);
        vm.prank(keeper);
        vault.stakeIdle();
        assertEq(vaultLens.rewardCutBps(), 1_000);
        staking.setUnclaimed(vaultLens.coldkey(), HK1, 2_000_000_000);
        vm.prank(keeper);
        vault.claimRewards{gas: 60_000_000}(HK1);
        (bytes32 key, CascadeMessages.Payout[] memory payouts) =
            deliverTracked(noEntries(), entries2(bob, 40e24, carol, 30e24));
        assertEq(payouts.length, 2);
        assertGt(vaultLens.getPayoutBatch(key).count, 0);
        // the redeem origins (Task 18): alice's direct deposit DIRECT_ORIGIN, bob's and carol's Base's, the
        // treasury's (the cut's holder) none
        assertEq(vaultLens.redeemOrigin(alice), DIRECT_ORIGIN);
        assertEq(vaultLens.redeemOrigin(bob), BASE);
        assertEq(vaultLens.redeemOrigin(treasury), 0);
        // the burns are in the door's window and in the global one, under the tracked word 0 (Task 17)
        (, uint256 globalBurned) = vaultLens.burnWindows(bytes32(0));
        assertGt(globalBurned, 0, "the global window written");
        assertVaultLensParity("after deposits, redeems and a queued payout batch");
        // a fresh bucket (R4 B-H1): a deposit for dave through the door, held a day, read alike by both sides
        address dave = makeAddr("dave");
        trackAccount(dave);
        deliverTracked(entries1(dave, 1e18), noEntries());
        (, uint128 daveFresh) = vaultLens.freshShares(dave);
        assertGt(daveFresh, 0, "a fresh bucket");
        assertVaultLensParity("with a fresh bucket");

        // half the rewards vested, the ramp over, the payout delay passed; then one chunk sent
        Schedule.warpTo(vm.getBlockTimestamp() + 3.5 days);
        assertGt(vaultLens.unvestedRewards(), 0);
        assertVaultLensParity("mid-vesting");
        vm.prank(owner);
        vault.execute(minChunkDown);
        vm.prank(keeper);
        vault.processPayouts(key, payouts, 1);
        assertEq(vaultLens.getPayoutBatch(key).cursor, 1);
        assertVaultLensParity("after a chunk");

        // three hotkeys, each with stake, and the stake hotkey moved (to a listed hotkey, Task 14a)
        vm.startPrank(owner);
        vault.addHotkey(HK2);
        vault.addHotkey(HK3);
        vault.execute(toHk3);
        vm.stopPrank();
        staking.donateStake(HK2, vaultLens.coldkey(), 5_000_000_000);
        staking.donateStake(HK3, vaultLens.coldkey(), 7_000_000_000);
        assertEq(vaultLens.hotkeyCount(), 3);
        assertEq(vaultLens.surplusStakeRao(), 12e9, "the gifts, unbooked");
        assertVaultLensParity("with three hotkeys");

        // the gifts adopted (Task 16): booked, vesting on their own drip beside what is left of the claim (Revision 27),
        // lastAdoptAt moved
        vm.prank(keeper);
        vault.adoptStake();
        assertEq(vaultLens.surplusStakeRao(), 0);
        assertEq(vaultLens.lastAdoptAt(), vm.getBlockTimestamp());
        assertEq(vaultLens.adoptVestingAmount(), 12e18, "the gifts' drip");
        assertGt(vaultLens.vestingAmount(), 0, "beside the claim schedule");
        assertVaultLensParity("after an adoption");

        // a validator's swap moves half of HK1's position to the unlisted HK5 (Task 12): stake missing, unlisted
        staking.swapHotkey(HK1, HK5, vaultLens.coldkey(), 5_000);
        assertGt(vaultLens.missingStakeRao(), 0);
        assertGt(vaultLens.unlistedStakeRao(), 0);
        assertTrue(vaultLens.stakeMissing());
        assertVaultLensParity("stake swapped off the set");
        // an unreadable total: both sides revert alike
        staking.setTotalReadReverts(true);
        VaultInternals internals = VaultInternals(payable(address(vault)));
        vm.expectRevert(MockStaking.TotalReadReverted.selector);
        vaultLens.unlistedStakeRao();
        vm.expectRevert(MockStaking.TotalReadReverted.selector);
        internals.exposed_unlistedStakeRao();
        staking.setTotalReadReverts(false);

        // every owner setting off its default, scheduled items pending (a door's and a bridge's Ordinary
        // activations, a GuardianSwap, an ownership transfer), alice opted in, a live staking floor
        vm.startPrank(owner);
        trackWord(vault.schedule(abi.encodeCall(vault.activateFrontDoor, (BASE, door2))));
        trackWord(vault.schedule(abi.encodeCall(vault.activateBridge, (address(bridge2)))));
        trackWord(vault.schedule(abi.encodeCall(vault.setGuardian, (carol))));
        trackWord(vault.schedule(abi.encodeCall(vault.transferOwnership, (alice))));
        for (uint256 i; i < settings.length; ++i) {
            vault.execute(settings[i]);
        }
        vault.setUnstakeMarginRao(5);
        vault.setHotkeyDustRao(7);
        vault.setClaimGasRequired(54_500_000);
        vault.setMinDirectDeposit(2e15);
        // the walk's floor and the idle buffer (Task 20; both up, so at once)
        vault.setUnstakeGas(750_000);
        vault.setIdleBuffer(900);
        vm.stopPrank();
        assertEq(vaultLens.unstakeGas(), 750_000);
        assertEq(vaultLens.idleBufferBps(), 900);
        vm.prank(alice);
        vault.setRedeemOrigin(BASE);
        assertEq(vaultLens.redeemOrigin(alice), BASE, "alice named Base (Task 18)");
        staking.setMinStake(5_000_000);
        staking.setNominatorMin(25_000_000);
        assertEq(vaultLens.globalOutflowBps(), 3_500, "the global percentage off its default (Task 17)");
        assertVaultLensParity("after the owner's settings");

        // the staking floors unreadable: both sides fall back to the constants (Task 23)
        vm.mockCallRevert(ISTAKING_ADDRESS, abi.encodeCall(IStaking.getDefaultMinStake, ()), "");
        vm.mockCallRevert(ISTAKING_ADDRESS, abi.encodeCall(IStaking.getNominatorMinRequiredStake, ()), "");
        assertEq(vaultLens.minStakeRao(), 2_000_000);
        assertEq(vaultLens.minRemainRao(), 20_000_000);
        assertVaultLensParity("with the staking floors unreadable");
        vm.clearMockedCalls();

        // a hotkey removed: the array shrinks, and its old last slot must read as past the end
        vm.prank(owner);
        vault.removeHotkey(HK2, true);
        assertEq(vaultLens.hotkeyCount(), 2);
        assertVaultLensParity("after a hotkey's removal");

        // a guardian replaced, a second launch-chain door and a bridge activated, and alice made the pending
        // owner (pendingSince set), each by its scheduled item
        Schedule.warpTo(vm.getBlockTimestamp() + 8 days);
        vm.startPrank(owner);
        vault.execute(abi.encodeCall(vault.setGuardian, (carol)));
        vault.execute(abi.encodeCall(vault.activateFrontDoor, (BASE, door2)));
        vault.execute(abi.encodeCall(vault.activateBridge, (address(bridge2))));
        vault.execute(abi.encodeCall(vault.transferOwnership, (alice)));
        vm.stopPrank();
        assertEq(uint8(vaultLens.doorState(vaultLens.peerId(BASE, door2))), uint8(DoorState.Active));
        assertEq(vaultLens.activeDoors(BASE), 2);
        assertEq(vault.pendingOwner(), alice);
        assertEq(vaultLens.pendingSince(), vm.getBlockTimestamp());
        assertVaultLensParity("a new guardian, a door and a bridge activated, an owner pending");

        // the vault's own records (Task 10): the guardian removes door2 (not the launch chain's last: it
        // becomes unknown, nothing recorded), the owner the launch door (its last: the owner's door hold and
        // clock, the door kept known), then the guardian pauses (its pause hold and clock)
        vm.prank(carol);
        vault.removeFrontDoor(BASE, door2);
        vm.prank(owner);
        vault.removeFrontDoor(BASE, frontDoor);
        Schedule.warpTo(vm.getBlockTimestamp() + 1 hours);
        vm.prank(carol);
        vault.pause();
        assertEq(uint8(vaultLens.launchDoorRemovedBy()), uint8(Actor.Owner));
        assertEq(uint8(vaultLens.pausedBy()), uint8(Actor.Guardian));
        assertTrue(vaultLens.ownerHold());
        assertTrue(vaultLens.guardianHold());
        assertEq(vaultLens.activeDoors(BASE), 0);
        assertVaultLensParity("the owner's door hold and the guardian's pause");

        // the launch door's Reopen run (the owner's hold cleared), the vault unpaused, then the guardian's
        // removal of it (the guardian's door hold, the door unknown) and the owner's pause
        vm.prank(owner);
        trackWord(vault.schedule(abi.encodeCall(vault.activateFrontDoor, (BASE, frontDoor))));
        Schedule.warpTo(vm.getBlockTimestamp() + 7 days);
        vm.startPrank(owner);
        vault.execute(abi.encodeCall(vault.activateFrontDoor, (BASE, frontDoor)));
        vault.unpause();
        vm.stopPrank();
        vm.prank(carol);
        vault.removeFrontDoor(BASE, frontDoor);
        Schedule.warpTo(vm.getBlockTimestamp() + 1 hours);
        vm.prank(owner);
        vault.pause();
        assertEq(uint8(vaultLens.launchDoorRemovedBy()), uint8(Actor.Guardian));
        assertEq(uint8(vaultLens.pausedBy()), uint8(Actor.Owner));
        assertVaultLensParity("the guardian's door hold and the owner's pause");

        // bridge2 disabled while not the primary (nothing recorded) and its re-activation (a Reopen) pending,
        // scheduled after the owner's pause (whose clock refuses an item in its own second)
        Schedule.warpTo(vm.getBlockTimestamp() + 1 hours);
        vm.prank(carol);
        vault.disableBridge(address(bridge2));
        vm.prank(owner);
        vault.schedule(abi.encodeCall(vault.activateBridge, (address(bridge2))));
        assertTrue(vaultLens.bridgeKnown(address(bridge2)));
        assertVaultLensParity("an item executed, a Reopen pending");

        // the exits machine (Task 8): the primary disabled by the guardian, its hold and its clock
        Schedule.warpTo(vm.getBlockTimestamp() + 1 hours);
        vm.prank(carol);
        vault.disableBridge(address(bridge));
        assertTrue(vaultLens.guardianHold());
        assertGt(vaultLens.lastGuardianClose(), 0);
        assertVaultLensParity("the primary disabled by the guardian");

        // bridge2's Reopen run, the primary switched to it (the hold cleared), then disabled by the owner: the
        // owner's hold and clock, the guardian's clock kept
        Schedule.warpTo(vm.getBlockTimestamp() + 7 days);
        vm.startPrank(owner);
        vault.execute(abi.encodeCall(vault.activateBridge, (address(bridge2))));
        vault.setPrimaryBridge(address(bridge2));
        Schedule.warpTo(vm.getBlockTimestamp() + 1 hours);
        vault.disableBridge(address(bridge2));
        vm.stopPrank();
        assertTrue(vaultLens.ownerHold());
        assertGt(vaultLens.lastOwnerClose(), vaultLens.lastGuardianClose());
        assertVaultLensParity("the primary switched, then disabled by the owner");
    }

    /// Whether `who.<signature>(i)` reverts, and with no revert data, as the compiler's getter for a
    /// public array does past its end.
    function revertsEmpty(address who, string memory signature, uint256 i) internal view returns (bool) {
        (bool ok, bytes memory out) = who.staticcall(abi.encodeWithSignature(signature, i));
        return !ok && out.length == 0;
    }

    /// DA6: hotkeys(i) past the end reverts on the lens exactly as inside the vault (VaultInternals'
    /// exposure, without data, as the vault's getter did before Task 5d-2), never answering 0,
    /// including over the slot a removed hotkey left behind.
    function test_vaultLensHotkeysRevertsPastTheEnd() public {
        address internals = address(vault);
        assertTrue(revertsEmpty(internals, "exposed_hotkeys(uint256)", 1), "the vault");
        assertTrue(revertsEmpty(address(vaultLens), "hotkeys(uint256)", 1), "the lens");
        assertEq(vaultLens.hotkeys(0), HK1);

        vm.startPrank(owner);
        vault.addHotkey(HK2);
        vault.addHotkey(HK3);
        vault.removeHotkey(HK3, true);
        vm.stopPrank();
        assertEq(vaultLens.hotkeys(1), HK2);
        assertTrue(revertsEmpty(internals, "exposed_hotkeys(uint256)", 2), "the vault, after a removal");
        assertTrue(revertsEmpty(address(vaultLens), "hotkeys(uint256)", 2), "the lens, after a removal");
        assertTrue(
            revertsEmpty(address(vaultLens), "hotkeys(uint256)", type(uint256).max), "the lens, far past the end"
        );
    }

    /// Spec §8.1 (Tasks 5d-1 and 5d-2): every vault getter the lens serves is gone from the vault,
    /// CascadeBase's and the trimmed price and hotkeyCount included, and the lens serves each; the vault
    /// keeps its token surface, owner, pendingOwner, paused and extsload.
    function test_movedGettersAreGoneFromTheVault() public view {
        string[] memory gone = vaultMovedViews();
        assertEq(gone.length, vaultLensViews().length - 3, "all but totalSupply, balanceOf and MS_PER_BLOCK");
        assertTrue(listed("price()", gone), "price() is trimmed");
        assertTrue(listed("hotkeyCount()", gone), "hotkeyCount() is trimmed");
        string[] memory base = baseMovedViews();
        for (uint256 i; i < base.length; ++i) {
            assertTrue(listed(base[i], gone), string.concat(base[i], " is gone since Task 5d-1"));
        }
        // the forwarded immutable stays on the vault, and the lens answers it as the vault does (R1-A L-3)
        string[] memory forwarded = forwardedViews();
        for (uint256 i; i < forwarded.length; ++i) {
            assertFalse(listed(forwarded[i], gone), forwarded[i]);
            assertTrue(answers(address(vault), forwarded[i]), string.concat("the vault lost ", forwarded[i]));
        }
        assertEq(vault.MS_PER_BLOCK(), 7_200);
        assertEq(vaultLens.MS_PER_BLOCK(), 7_200);
        for (uint256 i; i < gone.length; ++i) {
            assertFalse(answers(address(vault), gone[i]), string.concat("the vault still has ", gone[i]));
            assertTrue(answers(address(vaultLens), gone[i]), string.concat("the lens lacks ", gone[i]));
        }
        string[10] memory kept = [
            "name()",
            "symbol()",
            "decimals()",
            "totalSupply()",
            "balanceOf(address)",
            "allowance(address,address)",
            "owner()",
            "pendingOwner()",
            "paused()",
            "extsload(bytes32)"
        ];
        for (uint256 i; i < kept.length; ++i) {
            assertTrue(answers(address(vault), kept[i]), string.concat("the vault lost ", kept[i]));
        }
    }

    /// Each lens is built on one target, its only argument, and reads only that target (DB14a; the
    /// constructor's ABI and the empty storage layout are checked by script/lens-surface.mjs).
    function test_eachLensTakesOnlyItsTarget() public {
        // two vaults with different state
        CascadeVault.Params memory p = vaultParams();
        p.keeper = bob;
        CascadeVault other = deployVault(p);
        vm.deal(address(other), ED);
        vm.deal(carol, 3e18);
        vm.prank(carol);
        other.depositDirect{value: 3e18}();
        depositDirect(alice, 5e18);
        CascadeVaultLens otherLens = new CascadeVaultLens(address(other));

        assertEq(vaultLens.target(), address(vault));
        assertEq(otherLens.target(), address(other));
        assertEq(otherLens.coldkey(), mirror(address(other)));
        assertEq(vaultLens.coldkey(), mirror(address(vault)));
        assertEq(otherLens.keeper(), bob);
        assertEq(vaultLens.keeper(), keeper);
        assertEq(otherLens.totalSupply(), other.totalSupply());
        assertEq(otherLens.balanceOf(carol), other.balanceOf(carol));
        assertEq(otherLens.balanceOf(alice), 0);
        assertGt(vaultLens.balanceOf(alice), 0);
        assertLensParity(address(otherLens), address(other), vaultLensViews(), vaultMovedViews(), "the other vault");

        // two front doors with different keepers, each from its constructor
        MockTAO tao = new MockTAO(18);
        CascadeFrontDoor fdA = new CascadeFrontDoor(
            defaultFrontDoorParams(
                tao, new StubBridge(tao), BITTENSOR, address(vault), new MockUSDC(), owner, guardian, alice
            )
        );
        StubBridge bridgeB = new StubBridge(tao);
        CascadeFrontDoor fdB = new CascadeFrontDoor(
            defaultFrontDoorParams(tao, bridgeB, BITTENSOR, address(other), new MockUSDC(), owner, carol, bob)
        );
        CascadeDoorLens lensA = new CascadeDoorLens(address(fdA));
        CascadeDoorLens lensB = new CascadeDoorLens(address(fdB));
        assertEq(lensA.target(), address(fdA));
        assertEq(lensB.target(), address(fdB));
        assertEq(lensA.keeper(), alice);
        assertEq(lensB.keeper(), bob);
        assertEq(lensA.guardian(), guardian);
        assertEq(lensB.guardian(), carol);
        assertEq(lensB.primaryBridge(), address(bridgeB));
        assertTrue(lensB.primaryBridge() != lensA.primaryBridge());

        // neither lens can be built on nothing
        vm.expectRevert(ZeroAddress.selector);
        new CascadeVaultLens(address(0));
        vm.expectRevert(ZeroAddress.selector);
        new CascadeDoorLens(address(0));
    }

    /// The vault lens derives the coldkey once, at construction, from the vault's address through
    /// the address-mapping precompile, as the vault's constructor does.
    function test_vaultLensDerivesTheColdkeyOnce() public {
        vm.expectCall(ADDRESS_MAPPING_ADDRESS, abi.encodeCall(IAddressMapping.addressMapping, (address(vault))), 1);
        CascadeVaultLens lens = new CascadeVaultLens(address(vault));
        VaultInternals internals = VaultInternals(payable(address(vault)));
        assertEq(lens.coldkey(), internals.exposed_coldkey());
        assertEq(lens.totalAssets(), internals.exposed_totalAssets());
    }

    /// The test-only exposures read the vault's own state: a stake of 10 TAO ramps 10 TAO (in wei) in, which the lens
    /// serves as rampingStake() (R2 F4), and books 10 TAO, which it serves in rao (bookedStake(), Task 12); a direct
    /// exit's receipt comes off the ramp. The transient flag, which no lens serves, is clear between unstakes.
    function test_vaultInternalsExposeTheUnservedState() public {
        VaultInternals internals = VaultInternals(payable(address(vault)));
        assertEq(vaultLens.bookedStake(), 0);
        assertEq(vaultLens.rampingStake(), 0);
        depositDirect(alice, 10e18);
        vm.prank(keeper);
        vault.stakeIdle();
        assertEq(vaultLens.bookedStake(), 10e9);
        assertEq(internals.exposed_bookedStake(), 10e9);
        assertEq(vaultLens.rampingStake(), 10e18);
        assertEq(internals.exposed_rampingStake(), 10e18);
        // 2e24 of alice's 1e25 shares: 2e24 * (10e18 + 1) / (1e25 + 1e6) = 2e18, unstaked: off the ramp
        vm.prank(alice);
        vault.redeemDirect(2e24, false);
        assertEq(vaultLens.rampingStake(), 8e18);
        assertEq(internals.exposed_rampingStake(), 8e18);
        assertFalse(internals.exposed_unstaking());
    }

    /// R2 F4: burnWindows serves the window as of now, through the rule L1 burns against
    /// (CascadeFormulas.currentWindow): a door's window and the global one read as stored for 24 hours less a second
    /// after the burn that opened them, then as fresh ones opening now with nothing burned, which is what the next
    /// burn starts from; a window never written reads fresh too. Parity holds throughout.
    function test_burnWindowsIsTheCurrentWindow() public {
        bytes32 peer = vaultLens.peerId(BASE, frontDoor);
        // bob's 10 TAO through the door: 1e25 shares; a redeem of 1e24 burns 1e24 * (10e18 + 1) / (1e25 + 1e6) = 1e18
        deliverTracked(entries1(bob, 10e18), noEntries());
        matureShares(bob);
        uint256 t0 = vm.getBlockTimestamp();
        deliverTracked(noEntries(), entries1(bob, 1e24));
        assertWindow(peer, t0, 1e18);
        assertWindow(bytes32(0), t0, 1e18);
        vm.warp(t0 + 24 hours - 1);
        assertWindow(peer, t0, 1e18);
        assertWindow(bytes32(0), t0, 1e18);
        assertVaultLensParity("a window in its day");

        vm.warp(t0 + 24 hours);
        assertWindow(peer, t0 + 24 hours, 0);
        assertWindow(bytes32(0), t0 + 24 hours, 0);
        assertWindow(keccak256("never written"), t0 + 24 hours, 0);
        assertVaultLensParity("a window past its day");

        // the next burn opens exactly that window: A = 9e18, S = 9e24, so 1e24 burns 1e18 again
        deliverTracked(noEntries(), entries1(bob, 1e24));
        assertWindow(peer, t0 + 24 hours, 1e18);
        assertWindow(bytes32(0), t0 + 24 hours, 1e18);
        assertVaultLensParity("the window the burn opened");
    }

    /// The lens's burnWindows(peer) is (start, burned).
    function assertWindow(bytes32 peer, uint256 start, uint256 burned) internal view {
        (uint64 s, uint256 b) = vaultLens.burnWindows(peer);
        assertEq(s, start, "the window's start");
        assertEq(b, burned, "what it burned");
    }

    /// The parity check fails when a lens reads another target, and when a listed view does not exist
    /// (it would revert alike on both sides): it is not vacuous.
    function test_theParityCheckCanFail() public {
        CascadeVault other = freshVault();
        vm.expectRevert();
        this.checkVaultLensParity(address(vaultLens), address(other), vaultLensViews());

        string[] memory missing = new string[](1);
        missing[0] = "notAView()";
        vm.expectRevert();
        this.checkVaultLensParity(address(vaultLens), address(vault), missing);
    }
}

/// I-33 on the door lens: CascadeBase's views and the front door's keeper equal the front door's own
/// values (DoorInternals' exposure, and the front door's keeper getter) over the fixture's states;
/// CascadeBase's getters are gone from the front door since Task 5d-1.
contract DoorLensParityTest is FrontDoorTestBase, LensParityChecks {
    address fdKeeper = makeAddr("fdKeeper");
    StubBridge bridge2;
    StubBridge bridge3;

    /// The fixture's front door is a DoorInternals, so the parity check can read each value inside it.
    function deployFrontDoor(CascadeFrontDoor.Params memory p) internal override returns (CascadeFrontDoor) {
        return new DoorInternals(p);
    }

    function setUp() public override {
        super.setUp();
        bridge2 = new StubBridge(tao);
        bridge3 = new StubBridge(tao);
        address[9] memory accounts =
            [address(0), owner, guardian, alice, bob, fdKeeper, address(bridge), address(bridge2), address(bridge3)];
        for (uint256 i; i < accounts.length; ++i) {
            trackAccount(accounts[i]);
        }
        trackWord(keccak256("nothing is scheduled here"));
        trackWord(keccak256(abi.encodeCall(fd.setGuardian, (bob))));
        trackWord(keccak256(abi.encodeCall(fd.activateBridge, (address(bridge2)))));
        trackWord(keccak256(abi.encodeCall(fd.activateBridge, (address(bridge3)))));
        trackWord(keccak256(abi.encodeCall(fd.activateBridge, (address(bridge)))));
        trackWord(keccak256(abi.encodeCall(fd.transferOwnership, (carol))));
    }

    function assertDoorLensParity(string memory label) internal view {
        assertLensParity(address(doorLens), address(fd), doorLensViews(), baseMovedViews(), label);
    }

    function test_doorLensMatchesEveryBaseGetter() public {
        assertDoorLensParity("empty");

        vm.startPrank(owner);
        fd.schedule(abi.encodeCall(fd.setGuardian, (bob)));
        fd.schedule(abi.encodeCall(fd.activateBridge, (address(bridge2))));
        fd.schedule(abi.encodeCall(fd.activateBridge, (address(bridge3))));
        vm.stopPrank();
        assertDoorLensParity("scheduled items pending");

        // an item executed and one cancelled, a keeper, and the primary disabled by the guardian: its hold and
        // its clock (Task 8)
        Schedule.warpTo(vm.getBlockTimestamp() + 7 days);
        vm.startPrank(owner);
        fd.execute(abi.encodeCall(fd.activateBridge, (address(bridge2))));
        fd.setKeeper(fdKeeper);
        vm.stopPrank();
        vm.startPrank(guardian);
        fd.disableBridge(address(bridge));
        fd.cancel(keccak256(abi.encodeCall(fd.activateBridge, (address(bridge3)))));
        vm.stopPrank();
        assertTrue(doorLens.guardianHold());
        assertDoorLensParity("the primary disabled by the guardian, a keeper, an executed and a cancelled item");

        // the switch to bridge2 clears the hold (allowed only while the primary is disabled); the old primary,
        // known, re-activates as a Reopen; an ownership transfer, an Ordinary item, a second after the
        // guardian's clock
        vm.startPrank(owner);
        fd.setPrimaryBridge(address(bridge2));
        fd.schedule(abi.encodeCall(fd.activateBridge, (address(bridge))));
        Schedule.warpTo(vm.getBlockTimestamp() + 1);
        fd.schedule(abi.encodeCall(fd.transferOwnership, (carol)));
        vm.stopPrank();
        assertTrue(doorLens.exitsOpen());
        assertDoorLensParity("a new primary bridge, a Reopen and a transfer pending");

        Schedule.warpTo(vm.getBlockTimestamp() + 1 days);
        vm.prank(owner);
        fd.execute(abi.encodeCall(fd.setGuardian, (bob)));
        vm.prank(bob);
        fd.pause();
        assertDoorLensParity("a new guardian, paused");

        // the transfer executed, then the new primary disabled by the owner: the owner's hold and clock
        Schedule.warpTo(vm.getBlockTimestamp() + 7 days);
        vm.startPrank(owner);
        fd.execute(abi.encodeCall(fd.transferOwnership, (carol)));
        fd.disableBridge(address(bridge2));
        vm.stopPrank();
        assertEq(fd.pendingOwner(), carol);
        assertGt(doorLens.pendingSince(), 0);
        assertTrue(doorLens.ownerHold());
        assertGt(doorLens.lastOwnerClose(), doorLens.lastGuardianClose());
        assertDoorLensParity("an ownership transfer executed, the primary disabled by the owner");
    }

    /// The front door keeps every getter of its own (spec §8.1: `asset` and `usdc`, which the staker's
    /// constructor reads, and `oracle`, read on every stake, above all) and CascadeBase's owner,
    /// pendingOwner, paused and extsload; it loses only CascadeBase's other getters, which the door
    /// lens serves (Task 5d-1).
    function test_frontDoorKeepsItsOwnGetters() public {
        address oracle = makeAddr("oracle");
        Schedule.run(fd, owner, abi.encodeCall(fd.setOracle, (ICascadeTwap(oracle))));
        string[42] memory kept = [
            // constants and immutables
            "RAO()",
            "DESTINATION_BASE()",
            "MAX_DELIVERY_SLIPPAGE_BPS()",
            "MAX_BATCH_INTERVAL()",
            "MAX_REDEEM_REQUEST_FEE()",
            "MAX_BATCH_VALUE()",
            "MIN_DEPOSIT_FLOOR()",
            "asset()",
            "vaultChain()",
            "vault()",
            "usdc()",
            "treasury()",
            // state
            "claimable(address)",
            "totalClaimable()",
            "netForwarded()",
            "delivered(address,bytes32)",
            "feeCredit(address)",
            "totalFeeCredit()",
            "potCarried()",
            "batchInterval()",
            "maxDeposits()",
            "maxRedeems()",
            "minDeposit()",
            "depositCap()",
            "redeemRequestFee()",
            "maxBatchValue()",
            "deliveryOf(address)",
            "keeper()",
            "swapper()",
            "oracle()",
            "maxDeliverySlippageBps()",
            "minPoolLiquidity(uint256)",
            // views
            "openBatch()",
            "openDeposits()",
            "openRedeems()",
            "depositOf(address)",
            "redeemOf(address)",
            "canClose()",
            // CascadeBase's that the front door keeps
            "owner()",
            "pendingOwner()",
            "paused()",
            "extsload(bytes32)"
        ];
        for (uint256 i; i < kept.length; ++i) {
            assertTrue(answers(address(fd), kept[i]), string.concat("the front door lost ", kept[i]));
        }
        string[] memory base = baseMovedViews();
        for (uint256 i; i < base.length; ++i) {
            assertFalse(answers(address(fd), base[i]), string.concat("the front door still has ", base[i]));
            assertTrue(answers(address(doorLens), base[i]), string.concat("the door lens lacks ", base[i]));
        }
        // the forwarded immutable stays on the front door (Base's calibrated 120 ms), and its lens asks it
        assertEq(fd.MS_PER_BLOCK(), 120);
        assertEq(doorLens.MS_PER_BLOCK(), 120);
        // what on-chain callers read
        assertEq(address(fd.asset()), address(tao));
        assertEq(address(fd.usdc()), address(usdc));
        assertEq(address(fd.oracle()), oracle);
    }

    /// The door lens derives nothing from the address-mapping precompile, which exists only on
    /// Bittensor (spec §8.1).
    function test_doorLensCallsNoAddressMapping() public {
        vm.expectCall(ADDRESS_MAPPING_ADDRESS, "", 0);
        CascadeDoorLens lens = new CascadeDoorLens(address(fd));
        assertLensParity(address(lens), address(fd), doorLensViews(), baseMovedViews(), "a fresh door lens");
    }
}
