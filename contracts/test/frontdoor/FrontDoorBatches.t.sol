// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {ICascadeBridge} from "../../src/interfaces/ICascadeBridge.sol";
import {ICascadeTwap} from "../../src/interfaces/ICascadeTwap.sol";
import {CascadeDoorLens} from "../../src/lens/CascadeDoorLens.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {MockTAO} from "../mocks/MockTAO.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {StubBridge} from "../mocks/StubBridge.sol";
import {DOOR_TAO_WETH_FLOOR, DOOR_TREASURY, DOOR_WETH_USDC_FLOOR, withLaunchValues} from "../utils/DefaultParams.sol";
import {AboveBridgeCap, CancelTooSoon, NotScheduled, RenounceDisabled, ZeroAddress} from "../../src/CascadeErrors.sol";
import {BridgeActivated, GuardianSet, PrimaryBridgeSet} from "../../src/CascadeEvents.sol";
import {Schedule} from "../governance/Schedule.sol";
import {FrontDoorBatchesBase} from "./FrontDoorBatchesBase.sol";

contract FrontDoorBatchesTest is FrontDoorBatchesBase {
    // ---- constructor ----

    /// Spec §7: the owner and every launch value come from the constructor, so there is no hand-off. Each
    /// Params field reads back as given, through the front door's own getter or its lens (CascadeBase's
    /// state), and is logged as its setter logs it: on values unlike the fixture's and each other's, and on
    /// Appendix B's launch values (DefaultParams.sol).
    function test_constructorSetsEveryParam() public {
        CascadeFrontDoor.Params memory p = frontDoorParams();
        MockTAO otherTao = new MockTAO(18);
        p.asset = otherTao;
        p.bridge = new StubBridge(otherTao);
        p.vaultChain = 10;
        p.vault = makeAddr("other vault");
        p.usdc = new MockUSDC();
        p.owner = carol;
        p.guardian = bob;
        p.keeper = alice;
        p.oracle = ICascadeTwap(makeAddr("oracle"));
        p.swapper = makeAddr("swapper");
        p.treasury = makeAddr("other treasury");
        p.batchInterval = 3 hours;
        p.minDeposit = 0.05e18;
        p.depositCap = 41e18;
        p.redeemRequestFee = 2e14;
        p.maxDeposits = 31;
        p.maxRedeems = 29;
        p.maxBatchValue = 11e18;
        p.maxDeliverySlippageBps = 170;
        p.minPoolLiquidity = [uint128(3e20), 4e17];
        p.msPerBlock = 130;
        assertConstructs(p);

        p = withLaunchValues(frontDoorParams());
        p.oracle = ICascadeTwap(makeAddr("oracle"));
        p.swapper = makeAddr("swapper");
        assertConstructs(p);
    }

    /// Deploys a front door on `p`, expecting each value's log in the constructor's order, and checks each
    /// field against the front door's own getter or, for CascadeBase's state, its lens.
    function assertConstructs(CascadeFrontDoor.Params memory p) internal {
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
        emit CascadeFrontDoor.KeeperSet(p.keeper);
        vm.expectEmit(predicted);
        emit CascadeFrontDoor.OracleSet(address(p.oracle));
        vm.expectEmit(predicted);
        emit CascadeFrontDoor.SwapperSet(p.swapper);
        vm.expectEmit(predicted);
        emit CascadeFrontDoor.LimitSet("batchInterval", p.batchInterval, 0);
        vm.expectEmit(predicted);
        emit CascadeFrontDoor.LimitSet("minDeposit", p.minDeposit, p.depositCap);
        vm.expectEmit(predicted);
        emit CascadeFrontDoor.LimitSet("redeemRequestFee", p.redeemRequestFee, 0);
        vm.expectEmit(predicted);
        emit CascadeFrontDoor.LimitSet("maxDeposits", p.maxDeposits, p.maxRedeems);
        vm.expectEmit(predicted);
        emit CascadeFrontDoor.LimitSet("maxBatchValue", p.maxBatchValue, 0);
        vm.expectEmit(predicted);
        emit CascadeFrontDoor.MaxDeliverySlippageSet(p.maxDeliverySlippageBps);
        vm.expectEmit(predicted);
        emit CascadeFrontDoor.LimitSet("minPoolLiquidity", 0, p.minPoolLiquidity[0]);
        vm.expectEmit(predicted);
        emit CascadeFrontDoor.LimitSet("minPoolLiquidity", 1, p.minPoolLiquidity[1]);
        CascadeFrontDoor d = new CascadeFrontDoor(p);
        CascadeDoorLens l = new CascadeDoorLens(address(d));

        assertEq(address(d.asset()), address(p.asset), "asset");
        assertEq(l.primaryBridge(), address(p.bridge), "bridge");
        assertTrue(l.bridgeEnabled(address(p.bridge)), "bridge enabled");
        assertEq(d.vaultChain(), p.vaultChain, "vaultChain");
        assertEq(d.MS_PER_BLOCK(), p.msPerBlock, "msPerBlock");
        assertEq(l.MS_PER_BLOCK(), p.msPerBlock, "msPerBlock, through the lens");
        assertEq(d.vault(), p.vault, "vault");
        assertEq(address(d.usdc()), address(p.usdc), "usdc");
        assertEq(d.owner(), p.owner, "owner");
        assertEq(d.pendingOwner(), address(0), "no hand-off pending");
        vm.prank(p.owner);
        vm.expectRevert(RenounceDisabled.selector);
        d.renounceOwnership();
        assertEq(l.guardian(), p.guardian, "guardian");
        assertEq(d.keeper(), p.keeper, "keeper");
        assertEq(l.keeper(), p.keeper, "keeper, through the lens");
        assertEq(address(d.oracle()), address(p.oracle), "oracle");
        assertEq(d.swapper(), p.swapper, "swapper");
        assertEq(d.treasury(), p.treasury, "treasury");
        assertEq(d.potCarried(), 0, "nothing carried yet");
        assertEq(d.batchInterval(), p.batchInterval, "batchInterval");
        assertEq(d.minDeposit(), p.minDeposit, "minDeposit");
        assertEq(d.depositCap(), p.depositCap, "depositCap");
        assertEq(d.redeemRequestFee(), p.redeemRequestFee, "redeemRequestFee");
        assertEq(d.maxDeposits(), p.maxDeposits, "maxDeposits");
        assertEq(d.maxRedeems(), p.maxRedeems, "maxRedeems");
        assertEq(d.maxBatchValue(), p.maxBatchValue, "maxBatchValue");
        assertEq(d.maxDeliverySlippageBps(), p.maxDeliverySlippageBps, "maxDeliverySlippageBps");
        assertEq(d.minPoolLiquidity(0), p.minPoolLiquidity[0], "minPoolLiquidity[0], TAO/WETH");
        assertEq(d.minPoolLiquidity(1), p.minPoolLiquidity[1], "minPoolLiquidity[1], WETH/USDC");
        // batch 1 opens at the deploy
        (uint64 id, uint64 start,,,,) = d.openBatch();
        assertEq(id, 1, "batch 1");
        assertEq(start, vm.getBlockTimestamp(), "opened at the deploy");
    }

    /// Deploys a front door on `p`, expecting it to revert `err`.
    function assertRefused(CascadeFrontDoor.Params memory p, bytes memory err) internal {
        vm.expectRevert(err);
        new CascadeFrontDoor(p);
    }

    /// The owner calls `call` on the fixture's front door, expecting it to revert `err`. A loosening, refused
    /// NotScheduled outside execute (Task 11), is scheduled instead and refused by its setter at execute, 48 hours
    /// on, with `err` (the item kept).
    function assertSetterRefuses(bytes memory call, bytes memory err) internal {
        vm.prank(owner);
        (bool ok, bytes memory ret) = address(fd).call(call);
        assertFalse(ok, "the setter accepted it");
        if (keccak256(ret) == keccak256(abi.encodeWithSelector(NotScheduled.selector))) {
            vm.prank(owner);
            fd.schedule(call);
            Schedule.warpTo(vm.getBlockTimestamp() + 48 hours);
            vm.prank(owner);
            (ok, ret) = address(fd).call(abi.encodeCall(fd.execute, (call)));
            assertFalse(ok, "the scheduled setter accepted it");
        }
        assertEq(ret, err, "the setter's error");
    }

    /// No constructor can set what no setter could (spec §7, Task 6): each out-of-range value reverts the
    /// constructor with the error its setter gives the same value, shown beside it; each bound itself
    /// constructs. Nine checks have no setter: the immutables' (an asset of other than 18 decimals, a zero
    /// vault chain, a zero vault, a zero USDC, a USDC that is the asset, a zero treasury, a block time below 61
    /// or above 60,000 ms) and a zero owner (OpenZeppelin's Ownable). The minimum deposit's floor and the
    /// bridge's cap on the batch value are their own tests' (test_minDepositBelow003Refused,
    /// test_aboveBridgeCap), constructor and setters alike.
    function test_constructorRefusesWhatItsSetterRefuses() public {
        bytes memory invalid = abi.encodeWithSelector(CascadeFrontDoor.InvalidParameter.selector);
        bytes memory zeroAddress = abi.encodeWithSelector(ZeroAddress.selector);
        CascadeFrontDoor.Params memory p;

        // the immutables, which no setter changes
        p = frontDoorParams();
        p.asset = new MockTAO(6);
        assertRefused(p, abi.encodeWithSelector(CascadeFrontDoor.UnsupportedDecimals.selector));
        p = frontDoorParams();
        p.vaultChain = 0;
        assertRefused(p, invalid);
        p = frontDoorParams();
        p.vault = address(0);
        assertRefused(p, zeroAddress);
        p = frontDoorParams();
        p.usdc = IERC20(address(0));
        assertRefused(p, zeroAddress);
        p = frontDoorParams();
        p.usdc = IERC20(address(tao));
        assertRefused(p, invalid);
        // the treasury, immutable (spec §3.5: a settable treasury rejected)
        p = frontDoorParams();
        p.treasury = address(0);
        assertRefused(p, zeroAddress);
        // the block time: 61 to 60,000 milliseconds, so no block time in seconds is taken for milliseconds (R1-A L-3,
        // Revision 28, the review's I-2)
        p = frontDoorParams();
        p.msPerBlock = 0;
        assertRefused(p, invalid);
        p = frontDoorParams();
        p.msPerBlock = 60;
        assertRefused(p, invalid);
        p = frontDoorParams();
        p.msPerBlock = 60_001;
        assertRefused(p, invalid);
        p = frontDoorParams();
        p.msPerBlock = 61;
        assertEq(new CascadeFrontDoor(p).MS_PER_BLOCK(), 61, "61 ms");
        p.msPerBlock = 60_000;
        assertEq(new CascadeFrontDoor(p).MS_PER_BLOCK(), 60_000, "60,000 ms");

        // the parties
        p = frontDoorParams();
        p.owner = address(0);
        assertRefused(p, abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        p = frontDoorParams();
        p.bridge = ICascadeBridge(address(0));
        assertRefused(p, zeroAddress);
        assertSetterRefuses(abi.encodeCall(fd.schedule, (abi.encodeCall(fd.activateBridge, (address(0))))), zeroAddress);
        p = frontDoorParams();
        p.guardian = address(0);
        assertRefused(p, zeroAddress);
        assertSetterRefuses(abi.encodeCall(fd.schedule, (abi.encodeCall(fd.setGuardian, (address(0))))), zeroAddress);

        // the batch interval: at most 24 hours (spec §3.5)
        p = frontDoorParams();
        p.batchInterval = 24 hours + 1;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeFrontDoor.setBatchInterval, (24 hours + 1)), invalid);

        // the redeem-request fee: at most 0.001 ETH
        p = frontDoorParams();
        p.redeemRequestFee = 1e15 + 1;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeFrontDoor.setRedeemRequestFee, (1e15 + 1)), invalid);

        // the batch limits: 1 to 50 entries in each list (MAX_ENTRIES, 50 since Task 18)
        p = frontDoorParams();
        p.maxDeposits = 0;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeFrontDoor.setBatchLimits, (0, 50)), invalid);
        p = frontDoorParams();
        p.maxDeposits = 51;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeFrontDoor.setBatchLimits, (51, 50)), invalid);
        p = frontDoorParams();
        p.maxRedeems = 0;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeFrontDoor.setBatchLimits, (50, 0)), invalid);
        p = frontDoorParams();
        p.maxRedeems = 51;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeFrontDoor.setBatchLimits, (50, 51)), invalid);

        // the batch value: at most the lane's 5,000 TAO
        p = frontDoorParams();
        p.maxBatchValue = 5_000e18 + 1;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeFrontDoor.setMaxBatchValue, (5_000e18 + 1)), invalid);

        // the minimum deposit: at most the lane's 5,000 TAO too (R7), so canClose's sums cannot overflow
        p = frontDoorParams();
        p.minDeposit = 5_000e18 + 1;
        assertRefused(p, invalid);
        assertSetterRefuses(abi.encodeCall(CascadeFrontDoor.setCaps, (5_000e18 + 1, 10_000e18)), invalid);

        // the delivery slippage: at most 3%
        p = frontDoorParams();
        p.maxDeliverySlippageBps = 301;
        assertRefused(p, abi.encodeWithSelector(CascadeFrontDoor.FeeTooHigh.selector));
        assertSetterRefuses(
            abi.encodeCall(CascadeFrontDoor.setMaxDeliverySlippage, (301)),
            abi.encodeWithSelector(CascadeFrontDoor.FeeTooHigh.selector)
        );

        // each bound itself constructs, and what the setters take unbounded too (no keeper, which stops
        // deliveries; no oracle or swapper; any minimum deposit from the floor to the lane's 5,000 TAO, and any cap;
        // any pool-depth floor, 0, which checks nothing, included: Task 32)
        p = frontDoorParams();
        p.batchInterval = 24 hours;
        p.minDeposit = 5_000e18;
        p.depositCap = type(uint256).max;
        p.redeemRequestFee = 1e15;
        p.maxDeposits = 50;
        p.maxRedeems = 50;
        p.maxBatchValue = 5_000e18;
        p.maxDeliverySlippageBps = 300;
        p.minPoolLiquidity = [type(uint128).max, type(uint128).max];
        assertConstructs(p);
        p = frontDoorParams();
        p.keeper = address(0);
        p.oracle = ICascadeTwap(address(0));
        p.swapper = address(0);
        p.batchInterval = 0;
        p.minDeposit = 0.03e18;
        p.depositCap = 0;
        p.redeemRequestFee = 0;
        p.maxDeposits = 1;
        p.maxRedeems = 1;
        p.maxBatchValue = 0;
        p.maxDeliverySlippageBps = 0;
        p.minPoolLiquidity = [uint128(0), 0];
        assertConstructs(p);
    }

    function test_constructorOpensBatchOne() public view {
        (uint64 id, uint64 start, uint256 total, uint256 pot, uint256 nD, uint256 nR) = fd.openBatch();
        assertEq(id, 1);
        assertEq(start, vm.getBlockTimestamp());
        assertEq(total, 0);
        assertEq(pot, 0);
        assertEq(nD, 0);
        assertEq(nR, 0);
        assertEq(fd.maxDeposits(), 50);
        assertEq(fd.maxRedeems(), 50);
        assertEq(fd.maxBatchValue(), 4_000e18);
        assertEq(address(fd.asset()), address(tao));
        assertEq(fd.vaultChain(), BITTENSOR);
        assertEq(fd.vault(), vault);
        assertEq(fd.batchInterval(), 12 hours);
        assertEq(fd.minDeposit(), 1e18);
        assertEq(fd.depositCap(), 10_000e18);
        assertEq(fd.redeemRequestFee(), 1e14);
        assertEq(doorLens.primaryBridge(), address(bridge));
        assertEq(fd.owner(), owner);
        assertEq(doorLens.guardian(), guardian);
        assertEq(fd.keeper(), keeper);
        assertEq(fd.treasury(), DOOR_TREASURY);
        assertEq(fd.potCarried(), 0);
        assertEq(fd.maxDeliverySlippageBps(), 150);
        assertEq(fd.minPoolLiquidity(0), DOOR_TAO_WETH_FLOOR);
        assertEq(fd.minPoolLiquidity(1), DOOR_WETH_USDC_FLOOR);
        assertEq(fd.RAO(), 1e9);
        assertFalse(fd.canClose());
    }

    // ---- deposits ----

    function test_depositMergesPerUser() public {
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.DepositRequested(1, alice, 10e18, alice);
        dep(alice, 10e18);
        dep(alice, 10e18);

        (uint256 nD,) = openCounts();
        assertEq(nD, 1);
        assertEq(openTotal(), 20e18);
        assertEq(fd.depositOf(alice), 20e18);
        CascadeMessages.Entry[] memory d = fd.openDeposits();
        assertEq(d.length, 1);
        assertEq(d[0].user, alice);
        assertEq(d[0].amount, 20e18);
        assertEq(tao.balanceOf(address(fd)), 20e18);
        assertEq(tao.balanceOf(alice), 980e18);
    }

    function test_depositForNamesUserAndChargesPayer() public {
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.DepositRequested(1, alice, 5e18, bob);
        vm.prank(bob);
        fd.depositFor(alice, 5e18);

        assertEq(tao.balanceOf(bob), 995e18);
        assertEq(tao.balanceOf(alice), 1_000e18);
        assertEq(fd.depositOf(alice), 5e18);
        assertEq(fd.depositOf(bob), 0);
        assertEq(tao.balanceOf(address(fd)), 5e18);
    }

    function test_depositZeroAmountReverts() public {
        // the least minimum deposit the floor allows
        vm.prank(owner);
        fd.setCaps(0.03e18, 10_000e18);
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.ZeroAmount.selector);
        fd.deposit(0);
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.ZeroAmount.selector);
        fd.depositFor(alice, 0);
    }

    function test_depositRejectsMisalignedBelowMinAndZeroUser() public {
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.NotRaoAligned.selector);
        fd.deposit(1e18 + 1);
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.BelowMinDeposit.selector);
        fd.deposit(1e18 - 1e9);
        vm.prank(alice);
        vm.expectRevert(ZeroAddress.selector);
        fd.depositFor(address(0), 1e18);

        // the minimum itself is accepted
        dep(alice, 1e18);
        assertEq(fd.depositOf(alice), 1e18);
    }

    function test_depositCapCountsNetForwarded() public {
        tao.mint(alice, 10_000e18);
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.CapExceeded.selector);
        fd.deposit(10_001e18);

        dep(alice, 100e18);
        Schedule.warpTo(vm.getBlockTimestamp() + 12 hours);
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, 100e18);
        assertEq(fd.netForwarded(), 100e18);

        vm.prank(owner);
        fd.setCaps(1e18, 5_000e18);
        // the batch value up is a loosening: through the scheduler (Task 11)
        Schedule.run(fd, owner, abi.encodeCall(fd.setMaxBatchValue, (5_000e18)));
        // 100e18 forwarded + 4_901e18 = 5_001e18 > 5_000e18
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.CapExceeded.selector);
        fd.deposit(4_901e18);
        // 100e18 forwarded + 4_900e18 = 5_000e18, exactly the cap
        dep(alice, 4_900e18);
        assertEq(fd.depositOf(alice), 4_900e18);
        assertEq(openTotal(), 4_900e18);
    }

    function test_depositBatchValueFull() public {
        tao.mint(alice, 4_001e18);
        dep(alice, 3_000e18);
        // 3_000e18 + 1_001e18 = 4_001e18 > maxBatchValue 4_000e18
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.BatchValueFull.selector);
        fd.deposit(1_001e18);
        // 3_000e18 + 1_000e18 = 4_000e18 fits exactly
        dep(alice, 1_000e18);
        assertEq(openTotal(), 4_000e18);
    }

    /// A full deposit list refuses a new depositor `BatchFull`, while an entry already in it still merges. The list
    /// makes the batch closable from half its limit (R12, the list's half rule): at a limit of 3, one entry waits, two
    /// are closable before the interval (2 x 2 >= 3), and so is the full list. (Until R12 this pin's limit was 2 and the
    /// batch closable only at the full list; one entry of 2 is now half of it.)
    function test_depositBatchFullUnlessMerging() public {
        vm.prank(owner);
        fd.setBatchLimits(3, 3);
        dep(alice, 1e18);
        assertFalse(fd.canClose(), "one entry of three: it waits");
        dep(bob, 1e18);
        // the deposit list at half its limit: closable before the interval
        assertTrue(fd.canClose(), "two of three: half the list");
        dep(carol, 1e18);
        assertTrue(fd.canClose(), "the full list");

        vm.prank(makeAddr("dave"));
        vm.expectRevert(CascadeFrontDoor.BatchFull.selector);
        fd.deposit(1e18);

        dep(alice, 1e18);
        assertEq(fd.depositOf(alice), 2e18);
        (uint256 nD,) = openCounts();
        assertEq(nD, 3);
    }

    function test_depositWhilePausedReverts() public {
        pauseFd();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        fd.deposit(1e18);
        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        fd.depositFor(alice, 1e18);
    }

    function test_cancelDepositPartialThenFullFreesSlot() public {
        dep(alice, 10e18);
        waitCancel(alice);

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.DepositCancelled(1, alice, 4e18);
        vm.prank(alice);
        fd.cancelDeposit(4e18);
        assertEq(fd.depositOf(alice), 6e18);
        assertEq(openTotal(), 6e18);
        assertEq(tao.balanceOf(alice), 994e18);
        (uint256 nD,) = openCounts();
        assertEq(nD, 1);

        vm.prank(alice);
        fd.cancelDeposit(6e18);
        (nD,) = openCounts();
        assertEq(nD, 0);
        assertEq(fd.depositOf(alice), 0);
        assertEq(openTotal(), 0);
        assertEq(tao.balanceOf(alice), 1_000e18);
        assertEq(tao.balanceOf(address(fd)), 0);

        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.InsufficientRequest.selector);
        fd.cancelDeposit(6e18);
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.NotRaoAligned.selector);
        fd.cancelDeposit(1e9 + 1);
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.ZeroAmount.selector);
        fd.cancelDeposit(0);

        // more than the entry holds
        dep(alice, 2e18);
        waitCancel(alice);
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.InsufficientRequest.selector);
        fd.cancelDeposit(3e18);

        // works while paused
        pauseFd();
        vm.prank(alice);
        fd.cancelDeposit(2e18);
        assertEq(fd.depositOf(alice), 0);
        assertEq(tao.balanceOf(alice), 1_000e18);
    }

    function test_cancelDeposit_partialBelowMinimumReverts() public {
        vm.prank(alice);
        fd.deposit(2e18);
        waitCancel(alice);
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.BelowMinDeposit.selector);
        fd.cancelDeposit(1e18 + 1e9); // would leave 1e18 - 1e9
        assertEq(fd.depositOf(alice), 2e18);
    }

    function test_cancelDeposit_partialToExactMinimumSucceeds() public {
        vm.prank(alice);
        fd.deposit(2e18);
        waitCancel(alice);
        vm.prank(alice);
        fd.cancelDeposit(1e18); // leaves exactly minDeposit
        assertEq(fd.depositOf(alice), 1e18);
    }

    function test_cancelDeposit_fullCancelAlwaysSucceeds() public {
        vm.prank(alice);
        fd.deposit(1e18);
        waitCancel(alice);
        vm.prank(alice);
        fd.cancelDeposit(1e18); // leaves zero
        assertEq(fd.depositOf(alice), 0);
        assertEq(openTotal(), 0);
    }

    function test_cancelDepositFreesSlotForOthers() public {
        vm.prank(owner);
        fd.setBatchLimits(1, 1);
        dep(alice, 1e18);
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.BatchFull.selector);
        fd.deposit(1e18);
        waitCancel(alice);
        vm.prank(alice);
        fd.cancelDeposit(1e18);
        dep(bob, 1e18);
        assertEq(fd.depositOf(bob), 1e18);
        (uint256 nD,) = openCounts();
        assertEq(nD, 1);

        // swap-and-pop keeps the moved entry's slot: [bob, alice, carol] → bob leaves → [carol, alice]
        vm.prank(owner);
        fd.setBatchLimits(3, 3);
        dep(alice, 2e18);
        dep(carol, 3e18);
        waitCancel(bob);
        vm.prank(bob);
        fd.cancelDeposit(1e18);
        dep(carol, 1e18); // merges into the moved entry at index 0
        CascadeMessages.Entry[] memory d = fd.openDeposits();
        assertEq(d.length, 2);
        assertEq(d[0].user, carol);
        assertEq(d[0].amount, 4e18);
        assertEq(d[1].user, alice);
        assertEq(d[1].amount, 2e18);
        assertEq(fd.depositOf(carol), 4e18);
        assertEq(fd.depositOf(bob), 0);
        assertEq(openTotal(), 6e18);
    }

    // ---- the cancel cooldown (R11, spec §3.5) ----

    /// A cancel waits CANCEL_COOLDOWN, 5 minutes, from the user's last deposit: until then it reverts
    /// `CancelTooSoon(cancelableAt)`, naming the first second it works (the view `cancelableAt`), before any other check
    /// (a zero amount included), a second before it too; at exactly that second it works. The clock is the deposit's,
    /// not the cancel's, so the rest goes at once; and another user's clock is its own (a user that never deposited
    /// reads 0 plus the cooldown, long past on any chain).
    function test_aCancelWaitsFiveMinutesFromTheLastDeposit() public {
        assertEq(fd.CANCEL_COOLDOWN(), 5 minutes);
        uint256 t0 = vm.getBlockTimestamp();
        dep(alice, 10e18);
        uint256 ready = t0 + 5 minutes;
        assertEq(fd.cancelableAt(alice), ready);
        bytes memory tooSoon = abi.encodeWithSelector(CancelTooSoon.selector, ready);
        vm.prank(alice);
        vm.expectRevert(tooSoon);
        fd.cancelDeposit(4e18);
        vm.prank(alice);
        vm.expectRevert(tooSoon);
        fd.cancelDeposit(0);
        Schedule.warpTo(ready - 1);
        vm.prank(alice);
        vm.expectRevert(tooSoon);
        fd.cancelDeposit(4e18);
        assertEq(fd.depositOf(alice), 10e18);

        Schedule.warpTo(ready);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.DepositCancelled(1, alice, 4e18);
        vm.prank(alice);
        fd.cancelDeposit(4e18);
        assertEq(fd.depositOf(alice), 6e18);
        assertEq(tao.balanceOf(alice), 994e18);
        vm.prank(alice);
        fd.cancelDeposit(6e18);
        assertEq(fd.cancelableAt(alice), ready, "a cancel moves no clock");
        assertEq(tao.balanceOf(alice), 1_000e18);
        assertEq(fd.cancelableAt(bob), fd.CANCEL_COOLDOWN(), "never deposited: 0 plus the cooldown");
    }

    /// A top-up restarts the clock for the whole entry: past the first deposit's five minutes, the cancel still waits
    /// five minutes from the top-up, the first deposit's part included.
    function test_aTopUpRestartsTheCancelClock() public {
        uint256 t0 = vm.getBlockTimestamp();
        dep(alice, 2e18);
        Schedule.warpTo(t0 + 4 minutes);
        dep(alice, 1e18);
        uint256 ready = t0 + 9 minutes;
        assertEq(fd.cancelableAt(alice), ready);
        Schedule.warpTo(t0 + 5 minutes);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CancelTooSoon.selector, ready));
        fd.cancelDeposit(2e18);
        Schedule.warpTo(ready);
        vm.prank(alice);
        fd.cancelDeposit(3e18);
        assertEq(tao.balanceOf(alice), 1_000e18);
    }

    /// The clock is the entry's owner's, not the payer's: `depositFor(victim, ...)` restarts the victim's, so the
    /// victim cannot cancel until five minutes after it, while the payer's own cancel is free. A griefer who keeps a
    /// victim's cancel waiting gifts the victim a deposit (at least `minDeposit`) each time, and the pause stops it
    /// (`depositFor` is whenNotPaused) and frees the victim's cancel at once, inside the five minutes, gift included
    /// (R12: no cooldown while paused; until R12 the victim waited out the five minutes).
    function test_depositForRestartsTheVictimsClock() public {
        uint256 t0 = vm.getBlockTimestamp();
        dep(alice, 10e18);
        dep(bob, 1e18);
        Schedule.warpTo(t0 + 10 minutes);
        uint256 min = fd.minDeposit();
        vm.prank(bob);
        fd.depositFor(alice, min);
        uint256 ready = t0 + 15 minutes;
        assertEq(fd.cancelableAt(alice), ready, "the victim's clock restarted");
        assertEq(fd.cancelableAt(bob), t0 + 5 minutes, "the payer's did not");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CancelTooSoon.selector, ready));
        fd.cancelDeposit(10e18 + min);
        vm.prank(bob);
        fd.cancelDeposit(1e18);
        assertEq(fd.depositOf(alice), 10e18 + min, "the gift is the victim's");

        pauseFd();
        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        fd.depositFor(alice, min);
        assertLt(vm.getBlockTimestamp(), ready, "still inside the victim's five minutes");
        assertEq(fd.cancelableAt(alice), 0, "paused: no cooldown");
        vm.prank(alice);
        fd.cancelDeposit(10e18 + min);
        assertEq(tao.balanceOf(alice), 1_000e18 + min, "the victim keeps the gift");
        assertEq(tao.balanceOf(bob), 1_000e18 - min);
    }

    /// I-20 whole again (R12): no cooldown while the door is paused. No deposit can land then (`depositFor` is
    /// whenNotPaused), so none needs holding for a close: `cancelableAt` reads 0 and a cancel inside the five minutes
    /// goes at once, never refused. The owner's unpause brings the cooldown back, counted from the same last deposit.
    /// (Until R12 a paused door refused it CancelTooSoon until the five minutes had passed.)
    function test_aPausedDoorTakesACancelAtOnce() public {
        uint256 t0 = vm.getBlockTimestamp();
        dep(alice, 10e18);
        uint256 ready = t0 + 5 minutes;
        assertEq(fd.cancelableAt(alice), ready);
        pauseFd();
        assertEq(fd.cancelableAt(alice), 0, "paused: no cooldown");
        vm.prank(alice);
        fd.cancelDeposit(4e18);
        assertEq(fd.depositOf(alice), 6e18, "inside the five minutes, at once");
        assertEq(tao.balanceOf(alice), 994e18);
        assertTrue(fd.paused());

        vm.prank(owner);
        fd.unpause();
        assertEq(fd.cancelableAt(alice), ready, "unpaused: the cooldown again, from the same deposit");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CancelTooSoon.selector, ready));
        fd.cancelDeposit(6e18);
        Schedule.warpTo(ready);
        vm.prank(alice);
        fd.cancelDeposit(6e18);
        assertEq(fd.depositOf(alice), 0);
        assertEq(tao.balanceOf(alice), 1_000e18);
    }

    /// No cooldown while the primary bridge is disabled (R12): no close with entries can land then (`_primary()`
    /// reverts PrimaryBridgeDisabled), so nothing holds a deposit for one, while deposits still land (a disable is not a
    /// pause) and `depositFor` could restart a victim's clock for as long as the disable lasts. `cancelableAt` reads 0
    /// and a cancel inside the five minutes goes at once, a fresh deposit's too. Another bridge's disable changes
    /// nothing. The primary enabled again, by a switch to an enabled bridge (`setPrimaryBridge`) or by its own reopen (a
    /// scheduled `activateBridge`), brings the cooldown back, counted from the user's last deposit.
    function test_aDisabledPrimaryTakesACancelAtOnce() public {
        StubBridge standby = new StubBridge(tao);
        StubBridge spare = new StubBridge(tao);
        Schedule.run(fd, owner, abi.encodeCall(fd.activateBridge, (address(standby))));
        Schedule.run(fd, owner, abi.encodeCall(fd.activateBridge, (address(spare))));
        uint256 t0 = vm.getBlockTimestamp();
        dep(alice, 10e18);
        bytes memory tooSoon = abi.encodeWithSelector(CancelTooSoon.selector, t0 + 5 minutes);

        // a bridge that is not the primary: its disable leaves the cooldown
        vm.prank(guardian);
        fd.disableBridge(address(spare));
        assertEq(fd.cancelableAt(alice), t0 + 5 minutes, "another bridge's disable: the cooldown stays");
        vm.prank(alice);
        vm.expectRevert(tooSoon);
        fd.cancelDeposit(2e18);

        // the primary's: no close can land, and the cancel goes at once
        vm.prank(guardian);
        fd.disableBridge(address(bridge));
        assertEq(fd.cancelableAt(alice), 0, "the primary disabled: no cooldown");
        vm.prank(alice);
        fd.cancelDeposit(2e18);
        assertEq(fd.depositOf(alice), 8e18, "inside the five minutes, at once");
        // a deposit lands meanwhile (no pause), and its cancel goes at once too
        Schedule.warpTo(t0 + 1 minutes);
        dep(alice, 1e18);
        assertEq(fd.cancelableAt(alice), 0);
        vm.prank(alice);
        fd.cancelDeposit(1e18);
        assertEq(fd.depositOf(alice), 8e18);
        uint256 t1 = vm.getBlockTimestamp();
        dep(alice, 1e18);
        uint256 snap = vm.snapshotState();

        // the switch to the standby: the cooldown is back, from the last deposit
        vm.prank(owner);
        fd.setPrimaryBridge(address(standby));
        assertEq(fd.cancelableAt(alice), t1 + 5 minutes, "a new primary: the cooldown again");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CancelTooSoon.selector, t1 + 5 minutes));
        fd.cancelDeposit(9e18);
        Schedule.warpTo(t1 + 5 minutes);
        vm.prank(alice);
        fd.cancelDeposit(9e18);
        assertEq(tao.balanceOf(alice), 1_000e18);

        // the primary's own reopen, executed in the second of a fresh deposit: the cooldown is back from that deposit
        vm.revertToState(snap);
        bytes memory reopen = abi.encodeCall(fd.activateBridge, (address(bridge)));
        vm.prank(owner);
        fd.schedule(reopen);
        Schedule.wait(Schedule.delayOf(fd.activateBridge.selector));
        uint256 t2 = vm.getBlockTimestamp();
        dep(alice, 1e18);
        assertEq(fd.cancelableAt(alice), 0, "still disabled: no cooldown");
        vm.prank(owner);
        fd.execute(reopen);
        assertEq(fd.cancelableAt(alice), t2 + 5 minutes, "reopened: the cooldown again");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CancelTooSoon.selector, t2 + 5 minutes));
        fd.cancelDeposit(10e18);
        Schedule.warpTo(t2 + 5 minutes);
        vm.prank(alice);
        fd.cancelDeposit(10e18);
        assertEq(tao.balanceOf(alice), 1_000e18);
    }

    /// The bypass reads the primary's enabled flag, not the exits machine's hold (R12, the review of ae474d1). A
    /// guardian's disable is a hold that a scheduled `setGuardian` clears (R1-B M-1) while the primary stays disabled
    /// until its reopen, so no close can land yet and the cooldown stays waived: the exits open again, `cancelableAt`
    /// still reads 0, and a fresh deposit's cancel goes at once. (A bypass on `!exitsOpen()` would hold it.) The
    /// primary's reopen then brings the cooldown back.
    function test_theBypassFollowsThePrimaryNotTheHold() public {
        vm.prank(guardian);
        fd.disableBridge(address(bridge));
        assertFalse(doorLens.exitsOpen(), "the guardian's disable: a hold");
        bytes memory swap = abi.encodeCall(fd.setGuardian, (makeAddr("new guardian")));
        vm.prank(owner);
        fd.schedule(swap);
        Schedule.wait(Schedule.delayOf(fd.setGuardian.selector));
        dep(alice, 10e18);
        vm.prank(owner);
        fd.execute(swap);
        assertTrue(doorLens.exitsOpen(), "the swap clears the guardian's hold");
        assertFalse(doorLens.bridgeEnabled(address(bridge)), "the primary still disabled");
        assertEq(fd.cancelableAt(alice), 0, "no close can land: still no cooldown");
        vm.prank(alice);
        fd.cancelDeposit(4e18);
        assertEq(fd.depositOf(alice), 6e18, "inside the five minutes, at once");

        // the primary's reopen, executed in the deposit's second: the cooldown is back
        bytes memory reopen = abi.encodeCall(fd.activateBridge, (address(bridge)));
        vm.prank(owner);
        fd.schedule(reopen);
        Schedule.wait(Schedule.delayOf(fd.activateBridge.selector));
        uint256 t1 = vm.getBlockTimestamp();
        dep(alice, 1e18);
        vm.prank(owner);
        fd.execute(reopen);
        assertEq(fd.cancelableAt(alice), t1 + 5 minutes, "reopened: the cooldown again");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CancelTooSoon.selector, t1 + 5 minutes));
        fd.cancelDeposit(7e18);
    }

    // ---- redeem requests ----

    function test_requestRedeemFeeOnFirstEntryOnly() public {
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.RedeemRequested(1, alice, 5e24);
        vm.prank(alice);
        fd.requestRedeem{value: 1e14}(5e24);
        assertEq(openPot(), 1e14);
        assertEq(fd.redeemOf(alice), 5e24);

        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.WrongFee.selector);
        fd.requestRedeem{value: 1e14}(1e24);

        vm.prank(alice);
        fd.requestRedeem(3e24);
        assertEq(fd.redeemOf(alice), 8e24);
        assertEq(openPot(), 1e14);
        (, uint256 nR) = openCounts();
        assertEq(nR, 1);
        CascadeMessages.Entry[] memory r = fd.openRedeems();
        assertEq(r.length, 1);
        assertEq(r[0].user, alice);
        assertEq(r[0].amount, 8e24);
        assertEq(alice.balance, 1 ether - 1e14);
        assertEq(address(fd).balance, 1e14);
    }

    function test_requestRedeemWrongFeeReverts() public {
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.WrongFee.selector);
        fd.requestRedeem{value: 1e14 - 1}(1e24);
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.WrongFee.selector);
        fd.requestRedeem{value: 1e14 + 1}(1e24);
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.WrongFee.selector);
        fd.requestRedeem(1e24);
    }

    function test_requestRedeemFromCredit() public {
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.FeeCredited(alice, 1e14, bob);
        vm.prank(bob);
        fd.creditRedeemFee{value: 1e14}(alice);
        assertEq(fd.feeCredit(alice), 1e14);
        assertEq(fd.totalFeeCredit(), 1e14);
        assertEq(address(fd).balance, 1e14);

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.FeeCreditSpent(alice, 1e14);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.RedeemRequested(1, alice, 1e24);
        vm.prank(alice);
        fd.requestRedeem(1e24);
        assertEq(openPot(), 1e14);
        assertEq(fd.feeCredit(alice), 0);
        assertEq(fd.totalFeeCredit(), 0);
        assertEq(fd.redeemOf(alice), 1e24);
        assertEq(alice.balance, 1 ether);
        assertEq(address(fd).balance, 1e14);
    }

    function test_requestRedeemCombinesCreditAndValue() public {
        vm.prank(bob);
        fd.creditRedeemFee{value: 0.5e14}(alice);

        // half from credit, half as value
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.FeeCreditSpent(alice, 0.5e14);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.RedeemRequested(1, alice, 1e24);
        vm.prank(alice);
        fd.requestRedeem{value: 0.5e14}(1e24);
        assertEq(openPot(), 1e14);
        assertEq(fd.feeCredit(alice), 0);
        assertEq(fd.totalFeeCredit(), 0);
        assertEq(alice.balance, 1 ether - 0.5e14);
        assertEq(address(fd).balance, 1e14);
        assertEthIdentity();

        // without credit the whole fee is value, and no credit is spent
        vm.recordLogs();
        requestWithFee(carol, 1e24);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != CascadeFrontDoor.FeeCreditSpent.selector);
        }
        assertEq(openPot(), 2e14);
        assertEthIdentity();
    }

    function test_requestRedeemCreditCoversPartOfRaisedFee() public {
        vm.prank(bob);
        fd.creditRedeemFee{value: 1e14}(alice);
        vm.prank(owner);
        fd.setRedeemRequestFee(2e14);

        // credit 1e14 + value 1e14 = the raised fee
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.FeeCreditSpent(alice, 1e14);
        vm.prank(alice);
        fd.requestRedeem{value: 1e14}(1e24);
        assertEq(openPot(), 2e14);
        assertEq(fd.feeCredit(alice), 0);
        assertEq(fd.totalFeeCredit(), 0);
        assertEq(address(fd).balance, 2e14);
        assertEthIdentity();
    }

    /// Cash first: the value is used up to the fee and credit covers whatever it does not. Paying the
    /// whole fee in cash works whatever the credit; more than the fee, or too little credit, reverts.
    function test_requestRedeemCashFirstCreditCoversRest() public {
        vm.prank(bob);
        fd.creditRedeemFee{value: 1e14}(alice);

        // more than the fee is refused, credit or not
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.WrongFee.selector);
        fd.requestRedeem{value: 1e14 + 1}(1e24);

        // the full fee in cash leaves the credit untouched
        vm.prank(alice);
        fd.requestRedeem{value: 1e14}(1e24);
        assertEq(fd.feeCredit(alice), 1e14);
        assertEq(openPot(), 1e14);

        // part cash, the rest from credit: 1 wei of value, 1e14 - 1 of credit
        vm.prank(bob);
        fd.creditRedeemFee{value: 0.5e14}(carol);
        vm.prank(carol);
        vm.expectRevert(CascadeFrontDoor.WrongFee.selector);
        fd.requestRedeem{value: 0.5e14 - 1}(1e24);
        vm.prank(carol);
        vm.expectRevert(CascadeFrontDoor.WrongFee.selector);
        fd.requestRedeem(1e24);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.FeeCreditSpent(carol, 0.5e14);
        vm.prank(carol);
        fd.requestRedeem{value: 0.5e14}(1e24);
        assertEq(fd.feeCredit(carol), 0);

        // bob has no credit: only the full fee in cash works
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.WrongFee.selector);
        fd.requestRedeem{value: 1}(1e24);
        requestWithFee(bob, 1e24);

        assertEq(fd.totalFeeCredit(), 1e14);
        assertEq(openPot(), 3e14);
        assertEthIdentity();
    }

    /// A gift of 1 wei of credit cannot make a user's full-fee request revert.
    function test_requestRedeemCreditGiftCannotBreakRequest() public {
        vm.prank(bob);
        fd.creditRedeemFee{value: 1}(alice);

        vm.prank(alice);
        fd.requestRedeem{value: 1e14}(1e24);
        assertEq(fd.redeemOf(alice), 1e24);
        assertEq(fd.feeCredit(alice), 1);
        assertEq(fd.totalFeeCredit(), 1);
        assertEq(openPot(), 1e14);
        assertEthIdentity();
    }

    function test_creditNotSpendableByOthers() public {
        vm.prank(bob);
        fd.creditRedeemFee{value: 1e14}(alice);
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.WrongFee.selector);
        fd.requestRedeem(1e24);
        assertEq(fd.feeCredit(alice), 1e14);
        assertEq(fd.feeCredit(bob), 0);
    }

    function test_creditZeroValueReverts() public {
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.ZeroAmount.selector);
        fd.creditRedeemFee(alice);
        vm.prank(bob);
        vm.expectRevert(ZeroAddress.selector);
        fd.creditRedeemFee{value: 1e14}(address(0));
    }

    function test_requestRedeemZeroRevertsPausedOrNot() public {
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.ZeroAmount.selector);
        fd.requestRedeem{value: 1e14}(0);

        // zero shares stay rejected with an existing entry and with a zero fee
        requestWithFee(alice, 1e24);
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.ZeroAmount.selector);
        fd.requestRedeem(0);
        vm.prank(owner);
        fd.setRedeemRequestFee(0);
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.ZeroAmount.selector);
        fd.requestRedeem(0);

        // paused, zero shares are still refused, and a request goes through (spec §3.5, I-20)
        pauseFd();
        vm.prank(bob);
        vm.expectRevert(CascadeFrontDoor.ZeroAmount.selector);
        fd.requestRedeem(0);
        vm.prank(bob);
        fd.requestRedeem(1e24);
        assertEq(fd.redeemOf(bob), 1e24);
    }

    function test_cancelRedeemKeepsFeeAndFreesSlot() public {
        requestWithFee(alice, 5e24);

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.RedeemCancelled(1, alice, 2e24);
        vm.prank(alice);
        fd.cancelRedeem(2e24);
        assertEq(fd.redeemOf(alice), 3e24);

        vm.prank(alice);
        fd.cancelRedeem(3e24);
        (, uint256 nR) = openCounts();
        assertEq(nR, 0);
        assertEq(fd.redeemOf(alice), 0);
        assertEq(openPot(), 1e14);
        assertEq(address(fd).balance, 1e14);
        assertEthIdentity();

        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.InsufficientRequest.selector);
        fd.cancelRedeem(1);
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.ZeroAmount.selector);
        fd.cancelRedeem(0);

        // the slot is gone, so a new request is a first request again and pays the fee
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.WrongFee.selector);
        fd.requestRedeem(1e24);
        requestWithFee(alice, 1e24);

        // swap-and-pop keeps the moved entry's slot: [alice, bob, carol] → alice leaves → [carol, bob]
        requestWithFee(bob, 2e24);
        requestWithFee(carol, 3e24);
        vm.prank(alice);
        fd.cancelRedeem(1e24);
        vm.prank(carol);
        fd.requestRedeem(1e24); // merges into the moved entry at index 0
        CascadeMessages.Entry[] memory r = fd.openRedeems();
        assertEq(r.length, 2);
        assertEq(r[0].user, carol);
        assertEq(r[0].amount, 4e24);
        assertEq(r[1].user, bob);
        assertEq(r[1].amount, 2e24);

        // works while paused; no shares rounding rule
        pauseFd();
        vm.prank(bob);
        fd.cancelRedeem(2e24);
        assertEq(fd.redeemOf(bob), 0);
        // alice 1e14 twice + bob 1e14 + carol 1e14, none refunded
        assertEq(openPot(), 4e14);
        assertEq(address(fd).balance, 4e14);
        assertEthIdentity();
    }

    // ---- admin ----

    function test_settersValidateAndOwnerOnly() public {
        vm.startPrank(owner);
        vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
        fd.setBatchLimits(0, 1);
        vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
        fd.setBatchLimits(51, 1);
        vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
        fd.setBatchLimits(1, 0);
        vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
        fd.setBatchLimits(1, 51);

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.LimitSet("maxDeposits", 50, 1);
        fd.setBatchLimits(50, 1);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.LimitSet("minDeposit", 2e18, 5_000e18);
        fd.setCaps(2e18, 5_000e18);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.LimitSet("maxBatchValue", 3_000e18, 0);
        fd.setMaxBatchValue(3_000e18);
        // a tightening of the interval, at once (its loosening is scheduled: SetterDirections.t.sol)
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.LimitSet("batchInterval", 18 hours, 0);
        fd.setBatchInterval(18 hours);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.LimitSet("redeemRequestFee", 2e14, 0);
        fd.setRedeemRequestFee(2e14);
        vm.stopPrank();

        assertEq(fd.maxDeposits(), 50);
        assertEq(fd.maxRedeems(), 1);
        assertEq(fd.minDeposit(), 2e18);
        assertEq(fd.depositCap(), 5_000e18);
        assertEq(fd.maxBatchValue(), 3_000e18);
        assertEq(fd.batchInterval(), 18 hours);
        assertEq(fd.redeemRequestFee(), 2e14);

        bytes memory unauthorized = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian);
        vm.startPrank(guardian);
        vm.expectRevert(unauthorized);
        fd.setCaps(1e18, 10_000e18);
        vm.expectRevert(unauthorized);
        fd.setBatchLimits(50, 50);
        vm.expectRevert(unauthorized);
        fd.setMaxBatchValue(4_000e18);
        vm.expectRevert(unauthorized);
        fd.setBatchInterval(12 hours);
        vm.expectRevert(unauthorized);
        fd.setRedeemRequestFee(1e14);
        vm.stopPrank();
    }

    /// MAX_BATCH_INTERVAL is 24 hours (spec §3.5, from v3.1's 7 days): a request is never more than a day from its
    /// close by the timer, so batchInterval is not a freeze instrument. The constructor and setBatchInterval refuse
    /// more (InvalidParameter) and take the bound itself.
    function test_batchIntervalAbove24hRefused() public {
        assertEq(fd.MAX_BATCH_INTERVAL(), 24 hours);

        CascadeFrontDoor.Params memory p = frontDoorParams();
        p.batchInterval = 24 hours + 1;
        vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
        new CascadeFrontDoor(p);
        p.batchInterval = 24 hours;
        assertEq(new CascadeFrontDoor(p).batchInterval(), 24 hours);

        vm.startPrank(owner);
        vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
        fd.setBatchInterval(24 hours + 1);
        vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
        fd.setBatchInterval(7 days);

        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.LimitSet("batchInterval", 24 hours, 0);
        fd.setBatchInterval(24 hours);
        assertEq(fd.batchInterval(), 24 hours);

        // down is a loosening: refused directly, and run through the scheduler (Task 11)
        vm.expectRevert(NotScheduled.selector);
        fd.setBatchInterval(0);
        vm.stopPrank();
        vm.recordLogs();
        Schedule.run(fd, owner, abi.encodeCall(fd.setBatchInterval, (0)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 name = "batchInterval";
        // Scheduled, then the setter's LimitSet and Executed
        assertEq(logs.length, 3);
        assertEq(logs[1].topics[0], CascadeFrontDoor.LimitSet.selector);
        assertEq(logs[1].topics[1], name);
        assertEq(logs[1].data, abi.encode(uint256(0), uint256(0)));
        assertEq(fd.batchInterval(), 0);
    }

    /// The redeem-request fee is capped at MAX_REDEEM_REQUEST_FEE (0.001 ETH), so no setting can price
    /// every exit out; a batch's value at MAX_BATCH_VALUE (the lane's 5,000 TAO), above which no batch,
    /// its redeems included, could ever be sent.
    function test_redeemFeeAndBatchValueAreCapped() public {
        assertEq(fd.MAX_REDEEM_REQUEST_FEE(), 1e15);
        assertEq(fd.MAX_BATCH_VALUE(), 5_000e18);

        CascadeFrontDoor.Params memory p = frontDoorParams();
        p.redeemRequestFee = 1e15 + 1;
        vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
        new CascadeFrontDoor(p);
        p.redeemRequestFee = 1e15;
        CascadeFrontDoor ok = new CascadeFrontDoor(p);
        assertEq(ok.redeemRequestFee(), 1e15);

        vm.startPrank(owner);
        vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
        fd.setRedeemRequestFee(1e15 + 1);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.LimitSet("redeemRequestFee", 1e15, 0);
        fd.setRedeemRequestFee(1e15);

        // the batch value up is a loosening (Task 11): refused directly; scheduled, the setter refuses a value
        // past the cap at execute (the item kept) and takes the cap itself
        vm.expectRevert(NotScheduled.selector);
        fd.setMaxBatchValue(5_000e18 + 1);
        bytes memory past = abi.encodeCall(fd.setMaxBatchValue, (5_000e18 + 1));
        bytes memory atCap = abi.encodeCall(fd.setMaxBatchValue, (5_000e18));
        fd.schedule(past);
        fd.schedule(atCap);
        Schedule.warpTo(vm.getBlockTimestamp() + 48 hours);
        vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
        fd.execute(past);
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.LimitSet("maxBatchValue", 5_000e18, 0);
        fd.execute(atCap);
        vm.stopPrank();
        assertEq(fd.redeemRequestFee(), 1e15);
        assertEq(fd.maxBatchValue(), 5_000e18);
    }

    /// MIN_DEPOSIT_FLOOR is 0.03 TAO, twice the vault's MAX_FEE_ABS (spec §3.3, §3.5): a bounced deposit is at least
    /// minDeposit, so it keeps at least half its value under any payout fee ceiling and is never dust (I-14). The
    /// constructor and setCaps refuse a minimum below it (InvalidParameter) and take the floor itself; setCaps stays
    /// immediate either way, and the deposit cap stays unbounded (0 included: the wind-down's setCaps(minDeposit, 0)).
    function test_minDepositBelow003Refused() public {
        assertEq(fd.MIN_DEPOSIT_FLOOR(), 0.03e18);

        CascadeFrontDoor.Params memory p = frontDoorParams();
        p.minDeposit = 0.03e18 - 1;
        assertRefused(p, abi.encodeWithSelector(CascadeFrontDoor.InvalidParameter.selector));
        p.minDeposit = 0;
        assertRefused(p, abi.encodeWithSelector(CascadeFrontDoor.InvalidParameter.selector));
        p.minDeposit = 0.03e18;
        assertEq(new CascadeFrontDoor(p).minDeposit(), 0.03e18);

        vm.startPrank(owner);
        vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
        fd.setCaps(0.03e18 - 1, 10_000e18);
        vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
        fd.setCaps(0, 10_000e18);
        assertEq(fd.minDeposit(), 1e18, "unchanged");
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.LimitSet("minDeposit", 0.03e18, 0);
        fd.setCaps(0.03e18, 0);
        assertEq(fd.minDeposit(), 0.03e18);
        assertEq(fd.depositCap(), 0);
        fd.setCaps(0.03e18, 10_000e18);
        vm.stopPrank();

        // a deposit at the floor is accepted, one rao below it refused
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.BelowMinDeposit.selector);
        fd.deposit(0.03e18 - 1e9);
        dep(alice, 0.03e18);
        assertEq(fd.depositOf(alice), 0.03e18);
    }

    /// The minimum deposit's ceiling (R7, the R6b review's Info): at most MAX_BATCH_VALUE, the lane's 5,000 TAO, else
    /// InvalidParameter, in the constructor and in setCaps alike. Before, setCaps(type(uint256).max, ...) made
    /// canClose's `open.totalDeposits + minDeposit` overflow, so every closeBatch panicked until the owner set it
    /// back. At the ceiling, above the fixture's 4,000 TAO batch value, a batch with deposits takes no more, so it is
    /// closable at once, and it closes.
    function test_minDepositAboveTheLaneRefused() public {
        assertEq(fd.MAX_BATCH_VALUE(), 5_000e18);
        bytes memory invalid = abi.encodeWithSelector(CascadeFrontDoor.InvalidParameter.selector);
        CascadeFrontDoor.Params memory p = frontDoorParams();
        p.minDeposit = 5_000e18 + 1;
        assertRefused(p, invalid);
        p.minDeposit = type(uint256).max;
        assertRefused(p, invalid);
        p.minDeposit = 5_000e18;
        assertEq(new CascadeFrontDoor(p).minDeposit(), 5_000e18);

        dep(alice, 10e18);
        vm.startPrank(owner);
        vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
        fd.setCaps(type(uint256).max, 10_000e18);
        vm.expectRevert(CascadeFrontDoor.InvalidParameter.selector);
        fd.setCaps(5_000e18 + 1, 10_000e18);
        assertEq(fd.minDeposit(), 1e18, "unchanged");
        vm.expectEmit(address(fd));
        emit CascadeFrontDoor.LimitSet("minDeposit", 5_000e18, 10_000e18);
        fd.setCaps(5_000e18, 10_000e18);
        vm.stopPrank();
        assertTrue(fd.canClose(), "no deposit fits: closable at once");
        vm.prank(carol);
        fd.closeBatch{value: 1e15}(1, 10e18);
        assertEq(bridge.lastAmount(), 10e18);
        assertEq(openId(), 2);
    }

    /// maxBatchValue at most the primary bridge's maxMessageValue() (AboveBridgeCap, spec §3.9), checked by the
    /// constructor, by setMaxBatchValue in either direction and by setPrimaryBridge against the new primary, after
    /// MAX_BATCH_VALUE (InvalidParameter); the cap itself is accepted everywhere. A bridge with a smaller cap becomes
    /// primary once the owner has tightened to it (the vault's rule, Task 23).
    function test_aboveBridgeCap() public {
        bytes memory aboveCap = abi.encodeWithSelector(AboveBridgeCap.selector);

        // the constructor, against its initial bridge
        StubBridge capped = new StubBridge(tao);
        capped.setMaxMessageValue(10e18);
        CascadeFrontDoor.Params memory p = frontDoorParams();
        p.bridge = capped;
        p.maxBatchValue = 10e18 + 1;
        assertRefused(p, aboveCap);
        p.maxBatchValue = 5_000e18 + 1;
        assertRefused(p, abi.encodeWithSelector(CascadeFrontDoor.InvalidParameter.selector));
        p.maxBatchValue = 10e18;
        assertEq(new CascadeFrontDoor(p).maxBatchValue(), 10e18);

        // setMaxBatchValue, against the primary's cap: up (a loosening, refused at execute), then to the cap
        bridge.setMaxMessageValue(4_500e18);
        assertSetterRefuses(abi.encodeCall(CascadeFrontDoor.setMaxBatchValue, (4_500e18 + 1)), aboveCap);
        Schedule.run(fd, owner, abi.encodeCall(fd.setMaxBatchValue, (4_500e18)));
        assertEq(fd.maxBatchValue(), 4_500e18);
        // the bridge's cap falls: even a tightening must meet it, at once
        bridge.setMaxMessageValue(3_000e18);
        vm.startPrank(owner);
        vm.expectRevert(AboveBridgeCap.selector);
        fd.setMaxBatchValue(3_000e18 + 1);
        fd.setMaxBatchValue(3_000e18);
        vm.stopPrank();
        assertEq(fd.maxBatchValue(), 3_000e18);
        bridge.setMaxMessageValue(5_000e18);

        // setPrimaryBridge, against the new primary's cap
        StubBridge smaller = new StubBridge(tao);
        smaller.setMaxMessageValue(3_000e18 - 1);
        Schedule.run(fd, owner, abi.encodeCall(fd.activateBridge, (address(smaller))));
        vm.prank(owner);
        fd.disableBridge(address(bridge));
        vm.prank(owner);
        vm.expectRevert(AboveBridgeCap.selector);
        fd.setPrimaryBridge(address(smaller));
        assertEq(doorLens.primaryBridge(), address(bridge), "the primary unchanged");
        // the owner tightens to the smaller cap (checked against the disabled primary's, which it meets), then switches
        vm.prank(owner);
        fd.setMaxBatchValue(3_000e18 - 1);
        vm.prank(owner);
        fd.setPrimaryBridge(address(smaller));
        assertEq(doorLens.primaryBridge(), address(smaller), "switched at its cap");
        assertTrue(doorLens.exitsOpen());
        // from now on the batch value meets the new primary's cap (a loosening, scheduled once the disable's second
        // is past)
        Schedule.wait(1 hours);
        assertSetterRefuses(abi.encodeCall(CascadeFrontDoor.setMaxBatchValue, (3_000e18)), aboveCap);
        assertEq(fd.maxBatchValue(), 3_000e18 - 1);
    }

    function test_receiveRejectsEth() public {
        vm.prank(alice);
        (bool ok, bytes memory ret) = address(fd).call{value: 1}("");
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(CascadeFrontDoor.DirectTransferNotAllowed.selector));
        assertEq(address(fd).balance, 0);
    }
}
