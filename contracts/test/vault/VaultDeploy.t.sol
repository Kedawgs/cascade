// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeVaultLens} from "../../src/lens/CascadeVaultLens.sol";
import {ICascadeBridge} from "../../src/interfaces/ICascadeBridge.sol";
import {VaultSetterChecks} from "./VaultSetterChecks.sol";
import {StubBridge} from "../mocks/StubBridge.sol";
import {mirror} from "../mocks/Mirror.sol";
import {withLaunchValues} from "../utils/DefaultParams.sol";
import {DoorState} from "../../src/CascadeTypes.sol";
import {
    AlreadyActive,
    ColdkeyMismatch,
    FeeTooHigh,
    InvalidParameter,
    NotReady,
    RenounceDisabled,
    ZeroAddress,
    ZeroHotkey
} from "../../src/CascadeErrors.sol";
import {
    BridgeActivated,
    ClaimGasSet,
    FrontDoorActivated,
    GuardianSet,
    HotkeyAdded,
    KeeperSet,
    LimitSet,
    OutflowLimitsSet,
    PrimaryBridgeSet,
    RewardCutSet,
    StakeHotkeySet
} from "../../src/CascadeEvents.sol";
import {Schedule} from "../governance/Schedule.sol";

/// The vault's constructor: what it derives, sets and refuses, and the launch door active from the deploy (moved
/// unchanged out of VaultCore.t.sol in Task 38: VaultCoreTest sits at via-IR's jump-tag limit, and the campaign's new
/// files, which sort ahead of test/vault/, pushed it over in a forced build again).
contract VaultDeployTest is VaultSetterChecks {
    // ---- constructor ----

    function test_constructorDerivesColdkey() public view {
        assertEq(vaultLens.coldkey(), mirror(address(vault)));
    }

    function test_constructorRejectsColdkeyMismatch() public {
        CascadeVault.Params memory p = vaultParams();
        bytes32 derived = p.expectedColdkey;
        p.expectedColdkey = bytes32(uint256(0xbad));
        vm.expectRevert(abi.encodeWithSelector(ColdkeyMismatch.selector, p.expectedColdkey, derived));
        new CascadeVault(p);
    }

    function test_constructorRejectsZeroHotkey() public {
        CascadeVault.Params memory p = vaultParams();
        p.hotkey = bytes32(0);
        vm.expectRevert(ZeroHotkey.selector);
        new CascadeVault(p);
    }

    function test_constructorSetsRejectGrowth() public view {
        assertTrue(staking.rejectsGrowth(vaultLens.coldkey()));
    }

    function test_constructorInitialHotkeyIsStakeHotkey() public {
        assertEq(vaultLens.hotkeys(0), HK1);
        assertTrue(vaultLens.isHotkey(HK1));
        assertEq(vaultLens.stakeHotkey(), HK1);
        assertFalse(vaultLens.isHotkey(HK2));
        vm.expectRevert();
        vaultLens.hotkeys(1);

        CascadeVault.Params memory p = vaultParams();
        p.hotkey = HK2;
        vm.expectEmit(nextAddress());
        emit StakeHotkeySet(HK2);
        new CascadeVault(p);
    }

    /// Spec §7: the owner and every launch value come from the constructor, so there is no hand-off. Each
    /// Params field reads back as given, through the vault's own getter (owner, launchChain) or its lens,
    /// and is logged as its setter logs it: on values unlike the fixture's and each other's, and on
    /// Appendix B's launch values (DefaultParams.sol).
    function test_constructorSetsEveryParam() public {
        StubBridge other = new StubBridge(IERC20(address(0)));
        CascadeVault.Params memory p = vaultParams();
        p.hotkey = HK3;
        p.bridge = other;
        p.owner = carol;
        p.guardian = bob;
        p.keeper = stranger;
        p.treasury = makeAddr("treasury");
        p.rewardCutBps = 1_234;
        p.launchChain = 10;
        p.initialFrontDoor = alice;
        p.payoutDelay = 30 hours;
        p.maxDailyOutflowBps = 3_100;
        p.minDailyOutflow = 42e18;
        p.maxEntryValue = 11e18;
        p.maxMessageValue = 17e18;
        p.minChunk = 7;
        p.maxFeeBps = 120;
        p.maxFeeAbs = 0.013e18;
        p.maxTotalAssets = 45e18;
        p.minDirectDeposit = 0.02e18;
        p.claimGasRequired = 56_000_000;
        p.hotkeyDustRao = 3_000_000;
        p.unstakeMarginRao = 5_000;
        p.msPerBlock = 7_300;
        p.rewardVesting = 9 days;
        p.globalOutflowBps = 3_300;
        p.unstakeGas = 450_000;
        p.idleBufferBps = 700;
        assertConstructs(p);

        p = withLaunchValues(vaultParams());
        p.treasury = makeAddr("treasury");
        assertConstructs(p);
    }

    /// Deploys a vault on `p` (whose coldkey is the next CREATE's, as vaultParams() gives it), expecting
    /// each value's log in the constructor's order, and checks each field against the vault and its lens.
    function assertConstructs(CascadeVault.Params memory p) internal {
        address predicted = nextAddress();
        vm.expectEmit(predicted);
        emit Ownable.OwnershipTransferred(address(0), p.owner);
        vm.expectEmit(predicted);
        emit GuardianSet(p.guardian);
        vm.expectEmit(predicted);
        emit BridgeActivated(address(p.bridge));
        vm.expectEmit(predicted);
        emit PrimaryBridgeSet(address(p.bridge));
        vm.expectEmit(predicted);
        emit HotkeyAdded(p.hotkey);
        vm.expectEmit(predicted);
        emit StakeHotkeySet(p.hotkey);
        vm.expectEmit(predicted);
        emit KeeperSet(p.keeper);
        vm.expectEmit(predicted);
        emit RewardCutSet(p.treasury, p.rewardCutBps);
        vm.expectEmit(predicted);
        emit FrontDoorActivated(p.launchChain, p.initialFrontDoor);
        vm.expectEmit(predicted);
        emit LimitSet(CascadeVault.setPayoutDelay.selector, p.payoutDelay, 0);
        vm.expectEmit(predicted);
        emit OutflowLimitsSet(p.maxDailyOutflowBps, p.minDailyOutflow, p.globalOutflowBps);
        vm.expectEmit(predicted);
        emit LimitSet(CascadeVault.setMessageLimits.selector, p.maxEntryValue, p.maxMessageValue);
        vm.expectEmit(predicted);
        emit LimitSet(CascadeVault.setMessageLimits.selector, p.minChunk, 0);
        vm.expectEmit(predicted);
        emit LimitSet(CascadeVault.setFeeLimits.selector, p.maxFeeBps, p.maxFeeAbs);
        vm.expectEmit(predicted);
        emit LimitSet(CascadeVault.setMaxTotalAssets.selector, p.maxTotalAssets, 0);
        vm.expectEmit(predicted);
        emit LimitSet(CascadeVault.setMinDirectDeposit.selector, p.minDirectDeposit, 0);
        vm.expectEmit(predicted);
        emit ClaimGasSet(p.claimGasRequired);
        vm.expectEmit(predicted);
        emit LimitSet(CascadeVault.setHotkeyDustRao.selector, p.hotkeyDustRao, 0);
        vm.expectEmit(predicted);
        emit LimitSet(CascadeVault.setUnstakeMarginRao.selector, p.unstakeMarginRao, 0);
        vm.expectEmit(predicted);
        emit LimitSet(CascadeVault.setRewardVesting.selector, p.rewardVesting, 0);
        vm.expectEmit(predicted);
        emit LimitSet(CascadeVault.setUnstakeGas.selector, p.unstakeGas, 0);
        vm.expectEmit(predicted);
        emit LimitSet(CascadeVault.setIdleBuffer.selector, p.idleBufferBps, 0);
        CascadeVault v = new CascadeVault(p);
        CascadeVaultLens l = new CascadeVaultLens(address(v));

        assertEq(l.coldkey(), p.expectedColdkey, "expectedColdkey");
        assertEq(l.hotkeyCount(), 1, "one hotkey");
        assertEq(l.hotkeys(0), p.hotkey, "hotkey");
        assertTrue(l.isHotkey(p.hotkey), "hotkey listed");
        assertEq(l.stakeHotkey(), p.hotkey, "hotkey staked to");
        assertEq(l.primaryBridge(), address(p.bridge), "bridge");
        assertTrue(l.bridgeEnabled(address(p.bridge)), "bridge enabled");
        assertEq(v.owner(), p.owner, "owner");
        assertEq(v.pendingOwner(), address(0), "no hand-off pending");
        vm.prank(p.owner);
        vm.expectRevert(RenounceDisabled.selector);
        v.renounceOwnership();
        assertEq(l.guardian(), p.guardian, "guardian");
        assertEq(l.keeper(), p.keeper, "keeper");
        assertEq(l.treasury(), p.treasury, "treasury");
        assertEq(l.rewardCutBps(), p.rewardCutBps, "rewardCutBps");
        assertEq(v.launchChain(), p.launchChain, "launchChain");
        assertEq(v.MS_PER_BLOCK(), p.msPerBlock, "msPerBlock");
        assertEq(l.MS_PER_BLOCK(), p.msPerBlock, "msPerBlock, through the lens");
        assertEq(
            uint8(l.doorState(l.peerId(p.launchChain, p.initialFrontDoor))), uint8(DoorState.Active), "initialFrontDoor"
        );
        assertEq(l.activeDoors(p.launchChain), 1, "the launch chain's one door");
        assertEq(l.payoutDelay(), p.payoutDelay, "payoutDelay");
        assertEq(l.maxDailyOutflowBps(), p.maxDailyOutflowBps, "maxDailyOutflowBps");
        assertEq(l.minDailyOutflow(), p.minDailyOutflow, "minDailyOutflow");
        assertEq(l.globalOutflowBps(), p.globalOutflowBps, "globalOutflowBps");
        assertEq(l.maxEntryValue(), p.maxEntryValue, "maxEntryValue");
        assertEq(l.maxMessageValue(), p.maxMessageValue, "maxMessageValue");
        assertEq(l.minChunk(), p.minChunk, "minChunk");
        assertEq(l.maxFeeBps(), p.maxFeeBps, "maxFeeBps");
        assertEq(l.maxFeeAbs(), p.maxFeeAbs, "maxFeeAbs");
        assertEq(l.maxTotalAssets(), p.maxTotalAssets, "maxTotalAssets");
        assertEq(l.minDirectDeposit(), p.minDirectDeposit, "minDirectDeposit");
        assertEq(l.claimGasRequired(), p.claimGasRequired, "claimGasRequired");
        assertEq(l.hotkeyDustRao(), p.hotkeyDustRao, "hotkeyDustRao");
        assertEq(l.unstakeMarginRao(), p.unstakeMarginRao, "unstakeMarginRao");
        assertEq(l.rewardVesting(), p.rewardVesting, "rewardVesting");
        assertEq(l.unstakeGas(), p.unstakeGas, "unstakeGas");
        assertEq(l.idleBufferBps(), p.idleBufferBps, "idleBufferBps");
        // no schedule runs yet: the first claim snapshots the period, and the first adoption its drip's (Revision 27)
        assertEq(l.vestingPeriod(), 0, "vestingPeriod");
        assertEq(l.adoptVestingAmount(), 0, "adoptVestingAmount");
        assertEq(l.adoptVestingStart(), 0, "adoptVestingStart");
        assertEq(l.adoptVestingPeriod(), 0, "adoptVestingPeriod");
        assertEq(l.unvestedRewards(), 0, "unvestedRewards");
        // the keeper fallbacks count from the deploy
        assertEq(l.lastStakeAt(), vm.getBlockTimestamp(), "lastStakeAt");
        assertEq(l.lastClaimAt(p.hotkey), vm.getBlockTimestamp(), "lastClaimAt");
        assertTrue(staking.rejectsGrowth(p.expectedColdkey), "reject growth");
    }

    /// Deploys a vault on `p` (its coldkey the next CREATE's), expecting it to revert `err`.
    function assertRefused(CascadeVault.Params memory p, bytes memory err) internal {
        vm.expectRevert(err);
        new CascadeVault(p);
    }

    /// No constructor can set what no setter could (spec §7, Task 6): each out-of-range value reverts the
    /// constructor with the error its setter gives the same value, shown beside it; each bound itself
    /// constructs. Five checks have no setter: a zero owner (OpenZeppelin's Ownable), a zero launch chain
    /// (launchChain is immutable), a block time below 61 or above 60,000 ms (MS_PER_BLOCK, immutable) and a
    /// zero launch door (as the scheduling of a door's activation refuses one). A zero bridge, guardian or front door is refused when its scheduled setter is scheduled.
    function test_constructorRefusesWhatItsSetterRefuses() public {
        bytes memory invalid = abi.encodeWithSelector(InvalidParameter.selector);
        bytes memory zeroAddress = abi.encodeWithSelector(ZeroAddress.selector);
        CascadeVault.Params memory p;

        // the parties
        p = vaultParams();
        p.hotkey = bytes32(0);
        assertRefused(p, abi.encodeWithSelector(ZeroHotkey.selector));
        // the first hotkey is listed as addHotkey lists one (setStakeHotkey only names a listed one, Task 14a)
        assertSetterRefuses(
            abi.encodeCall(CascadeVault.addHotkey, (bytes32(0))), abi.encodeWithSelector(ZeroHotkey.selector)
        );
        p = vaultParams();
        p.bridge = ICascadeBridge(address(0));
        assertRefused(p, zeroAddress);
        assertSetterRefuses(
            abi.encodeCall(vault.schedule, (abi.encodeCall(vault.activateBridge, (address(0))))), zeroAddress
        );
        p = vaultParams();
        p.guardian = address(0);
        assertRefused(p, zeroAddress);
        assertSetterRefuses(
            abi.encodeCall(vault.schedule, (abi.encodeCall(vault.setGuardian, (address(0))))), zeroAddress
        );
        p = vaultParams();
        p.owner = address(0);
        assertRefused(p, abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        p = vaultParams();
        p.launchChain = 0;
        assertRefused(p, invalid);
        // the block time, immutable: 61 to 60,000 milliseconds, so no block time in seconds is taken for milliseconds
        // (R1-A L-3, Revision 28, the review's I-2)
        p = vaultParams();
        p.msPerBlock = 0;
        assertRefused(p, invalid);
        p = vaultParams();
        p.msPerBlock = 60;
        assertRefused(p, invalid);
        p = vaultParams();
        p.msPerBlock = 60_001;
        assertRefused(p, invalid);
        p = vaultParams();
        p.msPerBlock = 61;
        assertEq(new CascadeVault(p).MS_PER_BLOCK(), 61, "61 ms");
        p = vaultParams();
        p.msPerBlock = 60_000;
        assertEq(new CascadeVault(p).MS_PER_BLOCK(), 60_000, "60,000 ms");
        p = vaultParams();
        p.initialFrontDoor = address(0);
        assertRefused(p, zeroAddress);
        assertSetterRefuses(
            abi.encodeCall(vault.schedule, (abi.encodeCall(vault.activateFrontDoor, (BASE, address(0))))), zeroAddress
        );

        // the reward cut: at most 20%, and a cut needs a treasury
        p = vaultParams();
        p.treasury = alice;
        p.rewardCutBps = 2_001;
        assertRefused(p, abi.encodeWithSelector(FeeTooHigh.selector));
        assertSetterRefuses(
            abi.encodeCall(CascadeVault.setRewardCut, (alice, 2_001)), abi.encodeWithSelector(FeeTooHigh.selector)
        );
        p = vaultParams();
        p.treasury = address(0);
        p.rewardCutBps = 1;
        assertRefused(p, zeroAddress);
        assertSetterRefuses(abi.encodeCall(CascadeVault.setRewardCut, (address(0), 1)), zeroAddress);

        // the payout delay: 1 hour to 48 hours (Task 23)
        p = vaultParams();
        p.payoutDelay = 1 hours - 1;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeVault.setPayoutDelay, (1 hours - 1)), invalid);
        p = vaultParams();
        p.payoutDelay = 48 hours + 1;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeVault.setPayoutDelay, (48 hours + 1)), invalid);

        // the outflow limits (Task 17): each door's and all doors' percentages 20% to 50% of the base a day, the
        // floor they share 10 to 100 TAO
        p = vaultParams();
        p.maxDailyOutflowBps = 1_999;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeVault.setOutflowLimits, (1_999, 100e18, 2_000)), invalid);
        p = vaultParams();
        p.maxDailyOutflowBps = 5_001;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeVault.setOutflowLimits, (5_001, 100e18, 2_000)), invalid);
        p = vaultParams();
        p.minDailyOutflow = 10e18 - 1;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeVault.setOutflowLimits, (2_000, 10e18 - 1, 2_000)), invalid);
        p = vaultParams();
        p.minDailyOutflow = 100e18 + 1;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeVault.setOutflowLimits, (2_000, 100e18 + 1, 2_000)), invalid);
        p = vaultParams();
        p.globalOutflowBps = 1_999;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeVault.setOutflowLimits, (2_000, 100e18, 1_999)), invalid);
        p = vaultParams();
        p.globalOutflowBps = 5_001;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeVault.setOutflowLimits, (2_000, 100e18, 5_001)), invalid);

        // the message limits: an entry within a message, a message within the lane, a chunk of 1 to 100
        p = vaultParams();
        p.maxEntryValue = p.maxMessageValue + 1;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeVault.setMessageLimits, (4_000e18 + 1, 4_000e18, 10)), invalid);
        p = vaultParams();
        p.maxMessageValue = 5_000e18 + 1;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeVault.setMessageLimits, (2_000e18, 5_000e18 + 1, 10)), invalid);
        p = vaultParams();
        p.minChunk = 0;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeVault.setMessageLimits, (2_000e18, 4_000e18, 0)), invalid);
        p = vaultParams();
        p.minChunk = 101;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeVault.setMessageLimits, (2_000e18, 4_000e18, 101)), invalid);

        // the fee ceiling: at most 5% of a chunk, and at most 0.015 TAO (MAX_FEE_ABS; its floor, MIN_FEE_ABS, in
        // VaultPayouts.t.sol's test_feeLimitBounds, Task 21)
        p = vaultParams();
        p.maxFeeBps = 501;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeVault.setFeeLimits, (501, 0.015e18)), invalid);
        p = vaultParams();
        p.maxFeeAbs = 0.015e18 + 1;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeVault.setFeeLimits, (100, 0.015e18 + 1)), invalid);

        // the unstake margin: at most 1 TAO per removal
        p = vaultParams();
        p.unstakeMarginRao = 1e9 + 1;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeVault.setUnstakeMarginRao, (1e9 + 1)), invalid);

        // the reward vesting period: 1 to 30 days (Task 15)
        p = vaultParams();
        p.rewardVesting = 1 days - 1;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeVault.setRewardVesting, (1 days - 1)), invalid);
        p = vaultParams();
        p.rewardVesting = 30 days + 1;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeVault.setRewardVesting, (30 days + 1)), invalid);

        // the walk's least gas per removal, 150,000 to 5,000,000, and the idle buffer, at most 10% (Task 20)
        p = vaultParams();
        p.unstakeGas = 150_000 - 1;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeVault.setUnstakeGas, (150_000 - 1)), invalid);
        p = vaultParams();
        p.unstakeGas = 5_000_000 + 1;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeVault.setUnstakeGas, (5_000_000 + 1)), invalid);
        p = vaultParams();
        p.idleBufferBps = 1_001;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeVault.setIdleBuffer, (1_001)), invalid);

        // each bound itself constructs (the entry limit's and the claim gas's floors since Task 23), and what the
        // setters take unbounded (a zero keeper leaves the permissionless fallback; the cap; the minimum deposit)
        p = vaultParams();
        p.treasury = alice;
        p.rewardCutBps = 2_000;
        p.payoutDelay = 48 hours;
        p.maxDailyOutflowBps = 5_000;
        p.minDailyOutflow = 100e18;
        p.globalOutflowBps = 5_000;
        p.maxEntryValue = 5_000e18;
        p.maxMessageValue = 5_000e18;
        p.minChunk = 50;
        p.maxFeeBps = 500;
        p.maxFeeAbs = 0.015e18;
        p.unstakeMarginRao = 1e9;
        p.rewardVesting = 30 days;
        p.unstakeGas = 5_000_000;
        p.idleBufferBps = 1_000;
        assertConstructs(p);
        p = vaultParams();
        p.keeper = address(0);
        p.payoutDelay = 1 hours;
        p.maxDailyOutflowBps = 2_000;
        p.minDailyOutflow = 10e18;
        p.globalOutflowBps = 2_000;
        p.maxEntryValue = 10e18;
        p.maxMessageValue = 10e18;
        p.minChunk = 1;
        p.maxFeeBps = 0;
        p.maxFeeAbs = 0.01e18;
        p.maxTotalAssets = 0;
        p.minDirectDeposit = 0;
        p.claimGasRequired = 54_100_000;
        p.hotkeyDustRao = 0;
        p.rewardVesting = 1 days;
        p.unstakeGas = 150_000;
        assertConstructs(p);
    }

    /// Spec §7: the launch door is required and active on the launch chain from the deploy, with nothing
    /// scheduled and no delay; launchChain stays a getter on the vault (verify reads it directly).
    function test_initialDoorActiveOnLaunchChain() public {
        // the fixture's: (BASE, frontDoor)
        assertEq(vault.launchChain(), BASE);
        bytes32 id = vaultLens.peerId(BASE, frontDoor);
        assertEq(uint8(vaultLens.doorState(id)), uint8(DoorState.Active));
        assertEq(vaultLens.activeDoors(BASE), 1);
        // only that pair: the same address on another chain is a different peer
        assertEq(uint8(vaultLens.doorState(vaultLens.peerId(BITTENSOR, frontDoor))), uint8(DoorState.Unknown));
        assertEq(vaultLens.activeDoors(BITTENSOR), 0);

        // a vault launched on another chain activates its door there, logged at deploy
        CascadeVault.Params memory p = vaultParams();
        p.launchChain = 10;
        p.initialFrontDoor = bob;
        vm.expectEmit(nextAddress());
        emit FrontDoorActivated(10, bob);
        CascadeVault fresh = new CascadeVault(p);
        CascadeVaultLens freshLens = new CascadeVaultLens(address(fresh));
        assertEq(fresh.launchChain(), 10);
        assertEq(uint8(freshLens.doorState(freshLens.peerId(10, bob))), uint8(DoorState.Active));
        assertEq(uint8(freshLens.doorState(freshLens.peerId(BASE, bob))), uint8(DoorState.Unknown));
        assertEq(uint8(freshLens.doorState(freshLens.peerId(BASE, frontDoor))), uint8(DoorState.Unknown));
        assertEq(freshLens.activeDoors(10), 1);
        assertEq(freshLens.activeDoors(BASE), 0);

        // and, active, it cannot be scheduled for activation
        vm.prank(owner);
        vm.expectRevert(AlreadyActive.selector);
        fresh.schedule(abi.encodeCall(fresh.activateFrontDoor, (10, bob)));
    }

    function test_initialFrontDoorDeliversAtOnceAndReturnsOnlyAfterTheDelay() public {
        CascadeVault.Params memory p = vaultParams();
        p.initialFrontDoor = bob;
        vault = new CascadeVault(p);
        vaultLens = new CascadeVaultLens(address(vault));
        vm.deal(address(vault), ED);

        // no warp: a batch from the initial front door lands in the deploy block
        deliver(BASE, bob, 1, entries1(alice, 10e18), noEntries());
        assertEq(vault.balanceOf(alice), 1e25);

        // the owner removes it at once, like any front door: a temporary hold, the door kept known (Removed)
        vm.prank(owner);
        vault.removeFrontDoor(BASE, bob);
        assertEq(uint8(vaultLens.doorState(vaultLens.peerId(BASE, bob))), uint8(DoorState.Removed));

        // and bringing it back is a scheduled activation (a Reopen), which waits the full registry delay;
        // scheduled a second after the removal, whose stamp of the owner's clock refuses an item in its second
        Schedule.warpTo(vm.getBlockTimestamp() + 1);
        uint256 t0 = vm.getBlockTimestamp();
        bytes memory activation = abi.encodeCall(vault.activateFrontDoor, (BASE, bob));
        vm.prank(owner);
        vault.schedule(activation);
        Schedule.warpTo(t0 + 7 days - 1);
        vm.prank(owner);
        vm.expectRevert(NotReady.selector);
        vault.execute(activation);

        Schedule.warpTo(t0 + 7 days);
        vm.prank(owner);
        vault.execute(activation);
        assertEq(uint8(vaultLens.doorState(vaultLens.peerId(BASE, bob))), uint8(DoorState.Active));
    }
}
