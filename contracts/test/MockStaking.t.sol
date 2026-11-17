// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {IStaking, ISTAKING_ADDRESS} from "../src/interfaces/IStaking.sol";
import {IAddressMapping, ADDRESS_MAPPING_ADDRESS} from "../src/interfaces/IAddressMapping.sol";
import {ICascadeBridge} from "../src/interfaces/ICascadeBridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockStaking, STAKED_TAO_SINK} from "./mocks/MockStaking.sol";
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

    /// This contract is the coldkey's stand-in: its removals pay it by a call with value (the mock's default since
    /// Task 35), so it takes TAO as the vault's receive() does during an unstake.
    receive() external payable {}

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

    function test_unstakeBlockedRevertsBothRemovals() public {
        staking.setOneRaoShort(false);
        staking.addStake(HK1, 30_000_000, 0);
        staking.setUnstakeBlocked(true);
        vm.expectRevert(MockStaking.TooEarly.selector);
        staking.removeStake(HK1, 5_000_000, 0);
        vm.expectRevert(MockStaking.TooEarly.selector);
        staking.removeStakeFull(HK1, 0);
        assertEq(staking.getStake(HK1, _me(), 0), 30_000_000);

        staking.setUnstakeBlocked(false);
        staking.removeStakeFull(HK1, 0);
        assertEq(staking.getStake(HK1, _me(), 0), 0);
    }

    function test_removeFeeDeductedFromBothRemovals() public {
        staking.setOneRaoShort(false);
        staking.addStake(HK1, 100_000_000, 0);
        staking.setRemoveFeeRao(50_000);
        uint256 before = address(this).balance;

        // 30_000_000 removed, 30_000_000 - 50_000 credited
        staking.removeStake(HK1, 30_000_000, 0);
        assertEq(staking.getStake(HK1, _me(), 0), 70_000_000);
        assertEq(address(this).balance, before + 29_950_000 * RAO);

        // 70_000_000 removed, 70_000_000 - 50_000 credited
        staking.removeStakeFull(HK1, 0);
        assertEq(staking.getStake(HK1, _me(), 0), 0);
        assertEq(address(this).balance, before + (29_950_000 + 69_950_000) * RAO);
    }

    function test_claimToBalancePaysOutInsteadOfStaking() public {
        staking.setOneRaoShort(false);
        staking.setClaimToBalance(true);
        staking.setUnclaimed(_me(), HK1, 1e6);
        uint256 before = address(this).balance;
        (bool ok,) = address(staking).call{gas: 60_000_000}(abi.encodeCall(IStaking.claimRootWithHotkey, (HK1)));
        assertTrue(ok);
        assertEq(staking.getStake(HK1, _me(), 0), 0);
        assertEq(address(this).balance, before + 1e6 * RAO);
        assertEq(staking.getUnclaimedRootTaoByHotkey(_me(), HK1), 0);
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

    /// R2 F3: a credit inside addStake (setAddStakeCreditRao) lands on the staked position beyond what was paid for.
    function test_addStakeCreditLandsBeyondTheStake() public {
        staking.setOneRaoShort(false);
        staking.setAddStakeCreditRao(1_000);
        uint256 before = address(this).balance;
        staking.addStake(HK1, 5_000_000, 0);
        assertEq(staking.getStake(HK1, _me(), 0), 5_001_000);
        assertEq(address(this).balance, before - 5_000_000 * RAO, "only the stake is paid for");
        assertEq(staking.getTotalColdkeyStakeOnSubnet(_me(), 0), 5_001_000);
    }

    /// R2 F1: an unreadable unclaimed amount reverts (setUnclaimedReadReverts), as a vanished precompile function
    /// would.
    function test_unclaimedReadReverts() public {
        staking.setUnclaimed(_me(), HK1, 7);
        staking.setUnclaimedReadReverts(true);
        vm.expectRevert(MockStaking.UnclaimedReadReverted.selector);
        staking.getUnclaimedRootTaoByHotkey(_me(), HK1);
        staking.setUnclaimedReadReverts(false);
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

    /// Task 12: the coldkey's root stake across every hotkey, kept through every kind of write; another
    /// subnet's (alpha) and another coldkey's are apart.
    function test_totalColdkeyStakeOnSubnetSumsEveryHotkey() public {
        staking.setOneRaoShort(false);
        bytes32 hk2 = keccak256("hotkey2");
        staking.addHotkey(hk2);
        staking.addStake(HK1, 50_000_000, 0);
        staking.donateStake(hk2, _me(), 5_000_000);
        staking.donateStakeOnSubnet(HK1, _me(), 7, 9_000_000);
        staking.donateStake(HK1, keccak256("another coldkey"), 1_000_000);
        assertEq(staking.getTotalColdkeyStakeOnSubnet(_me(), 0), 55_000_000);
        assertEq(staking.getTotalColdkeyStakeOnSubnet(_me(), 7), 9_000_000);

        staking.moveStake(HK1, hk2, 0, 0, 10_000_000);
        assertEq(staking.getTotalColdkeyStakeOnSubnet(_me(), 0), 55_000_000);
        staking.removeStake(HK1, 2_000_000, 0);
        assertEq(staking.getTotalColdkeyStakeOnSubnet(_me(), 0), 53_000_000);
        staking.setUnclaimed(_me(), hk2, 4_000_000);
        (bool ok,) = address(staking).call{gas: 60_000_000}(abi.encodeCall(IStaking.claimRootWithHotkey, (hk2)));
        assertTrue(ok);
        assertEq(staking.getTotalColdkeyStakeOnSubnet(_me(), 0), 57_000_000);
        staking.removeStakeFull(hk2, 0);
        assertEq(staking.getTotalColdkeyStakeOnSubnet(_me(), 0), 38_000_000);
        assertEq(staking.getStake(HK1, _me(), 0), 38_000_000);
    }

    /// Task 12: an unreadable total reverts (setTotalReadReverts), as a vanished precompile function would.
    function test_totalReadReverts() public {
        staking.setTotalReadReverts(true);
        vm.expectRevert(MockStaking.TotalReadReverted.selector);
        staking.getTotalColdkeyStakeOnSubnet(_me(), 0);
        staking.setTotalReadReverts(false);
        assertEq(staking.getTotalColdkeyStakeOnSubnet(_me(), 0), 0);
    }

    /// Task 16: a read that burns all the gas it is given (setTotalReadBurnsGas): a capped call fails having
    /// spent its cap, and nothing else.
    function test_totalReadBurnsGas() public {
        staking.setTotalReadBurnsGas(true);
        bytes memory read = abi.encodeCall(IStaking.getTotalColdkeyStakeOnSubnet, (_me(), 0));
        uint256 g = gasleft();
        (bool ok,) = address(staking).staticcall{gas: 100_000}(read);
        uint256 used = g - gasleft();
        assertFalse(ok);
        assertGe(used, 100_000, "the whole cap");
        assertLt(used, 110_000);
        staking.setTotalReadBurnsGas(false);
        assertEq(staking.getTotalColdkeyStakeOnSubnet(_me(), 0), 0);
    }

    /// Task 16: stake lost for good (loseStake) leaves the position and the coldkey's total together, floored at 0,
    /// and pays nothing; another hotkey's position is untouched.
    function test_loseStakeLowersThePositionAndTheTotal() public {
        staking.setOneRaoShort(false);
        bytes32 hk2 = keccak256("hotkey2");
        staking.addHotkey(hk2);
        staking.addStake(HK1, 50_000_000, 0);
        staking.addStake(hk2, 20_000_000, 0);
        uint256 balance = address(this).balance;
        staking.loseStake(HK1, _me(), 30_000_000);
        assertEq(staking.getStake(HK1, _me(), 0), 20_000_000);
        assertEq(staking.getStake(hk2, _me(), 0), 20_000_000);
        assertEq(staking.getTotalColdkeyStakeOnSubnet(_me(), 0), 40_000_000, "gone from the total too");
        assertEq(address(this).balance, balance, "nothing paid");
        staking.loseStake(HK1, _me(), 100_000_000);
        assertEq(staking.getStake(HK1, _me(), 0), 0, "never below 0");
        assertEq(staking.getTotalColdkeyStakeOnSubnet(_me(), 0), 20_000_000);
    }

    /// Task 12: a validator's hotkey swap moves movedBps of the coldkey's root position from `from` to `to`
    /// (10_000 the whole position, 0 none, between them a split), exactly, and registers `to`; the total stays.
    function test_swapHotkeyMovesTheShareOfThePosition() public {
        staking.setOneRaoShort(false);
        bytes32 to = keccak256("new hotkey");
        staking.addStake(HK1, 100_000_000, 0);
        staking.swapHotkey(HK1, to, _me(), 0);
        assertEq(staking.getStake(HK1, _me(), 0), 100_000_000, "0 retains the position");
        assertEq(staking.getStake(to, _me(), 0), 0);
        staking.swapHotkey(HK1, to, _me(), 3_000);
        assertEq(staking.getStake(HK1, _me(), 0), 70_000_000);
        assertEq(staking.getStake(to, _me(), 0), 30_000_000, "a split: exact, never one rao short");
        assertTrue(staking.knownHotkey(to));
        staking.swapHotkey(HK1, to, _me(), 10_000);
        assertEq(staking.getStake(HK1, _me(), 0), 0, "10_000 moves the position");
        assertEq(staking.getStake(to, _me(), 0), 100_000_000);
        assertEq(staking.getTotalColdkeyStakeOnSubnet(_me(), 0), 100_000_000);
        vm.expectRevert(MockStaking.InvalidBps.selector);
        staking.swapHotkey(to, HK1, _me(), 10_001);
    }

    /// Task 14b: a swap with retained credits moves the position as swapHotkey does and leaves the credits
    /// owed on the old hotkey, added to what was owed (18-decimal read).
    function test_swapWithCreditsRetainsCreditsOnTheOldHotkey() public {
        staking.setOneRaoShort(false);
        bytes32 to = keccak256("new hotkey");
        staking.addStake(HK1, 100_000_000, 0);
        staking.setUnclaimed(_me(), HK1, 5);
        staking.swapHotkeyWithCredits(HK1, to, _me(), 4_000, 7);
        assertEq(staking.getStake(HK1, _me(), 0), 60_000_000);
        assertEq(staking.getStake(to, _me(), 0), 40_000_000);
        assertEq(staking.getTotalColdkeyStakeOnSubnet(_me(), 0), 100_000_000, "the totals stay consistent");
        assertEq(staking.getUnclaimedRootTaoByHotkey(_me(), HK1), 12 * RAO, "added to what was owed");
        assertEq(staking.getUnclaimedRootTaoByHotkey(_me(), to), 0, "nothing on the new hotkey");
        vm.expectRevert(MockStaking.InvalidBps.selector);
        staking.swapHotkeyWithCredits(HK1, to, _me(), 10_001, 1);
    }

    function test_creditsPaidAsStakeOnTheOldHotkey() public {
        staking.setOneRaoShort(false);
        bytes32 to = keccak256("new hotkey");
        staking.addStake(HK1, 100_000_000, 0);
        staking.swapHotkeyWithCredits(HK1, to, _me(), 10_000, 3_000_000);
        staking.setCreditsPayTo(true);
        uint256 before = address(this).balance;
        (bool ok,) = address(staking).call{gas: 60_000_000}(abi.encodeCall(IStaking.claimRootWithHotkey, (HK1)));
        assertTrue(ok);
        assertEq(staking.getStake(HK1, _me(), 0), 3_000_000, "stake on `from`, not on `to`");
        assertEq(staking.getStake(to, _me(), 0), 100_000_000);
        assertEq(staking.getTotalColdkeyStakeOnSubnet(_me(), 0), 103_000_000);
        assertEq(address(this).balance, before);
        assertEq(staking.getUnclaimedRootTaoByHotkey(_me(), HK1), 0);
    }

    function test_creditsPaidAsBalance() public {
        staking.setOneRaoShort(false);
        bytes32 to = keccak256("new hotkey");
        staking.addStake(HK1, 100_000_000, 0);
        staking.swapHotkeyWithCredits(HK1, to, _me(), 10_000, 3_000_000);
        staking.setCreditsPayTo(false);
        uint256 before = address(this).balance;
        (bool ok,) = address(staking).call{gas: 60_000_000}(abi.encodeCall(IStaking.claimRootWithHotkey, (HK1)));
        assertTrue(ok);
        assertEq(staking.getStake(HK1, _me(), 0), 0);
        assertEq(staking.getTotalColdkeyStakeOnSubnet(_me(), 0), 100_000_000);
        assertEq(address(this).balance, before + 3_000_000 * RAO);
        assertEq(staking.getUnclaimedRootTaoByHotkey(_me(), HK1), 0);
    }

    /// Task 12: a claim during which the position falls (setClaimFallRao): the claimed hotkey's root position
    /// loses up to that much after the claim lands.
    function test_claimFallLowersThePosition() public {
        staking.setOneRaoShort(false);
        staking.addStake(HK1, 30_000_000, 0);
        staking.setUnclaimed(_me(), HK1, 1_000_000);
        staking.setClaimFallRao(5_000_000);
        (bool ok,) = address(staking).call{gas: 60_000_000}(abi.encodeCall(IStaking.claimRootWithHotkey, (HK1)));
        assertTrue(ok);
        assertEq(staking.getStake(HK1, _me(), 0), 26_000_000);
        assertEq(staking.getTotalColdkeyStakeOnSubnet(_me(), 0), 26_000_000);
        staking.setClaimFallRao(100_000_000);
        (ok,) = address(staking).call{gas: 60_000_000}(abi.encodeCall(IStaking.claimRootWithHotkey, (HK1)));
        assertTrue(ok);
        assertEq(staking.getStake(HK1, _me(), 0), 0, "never below 0");
    }

    function test_coldkeyAliasRoutesStake() public {
        staking.setOneRaoShort(false);
        bytes32 alias_ = keccak256("alias");
        staking.setColdkeyAlias(address(this), alias_);
        staking.addStake(HK1, 5 * RAO, 0);
        assertEq(staking.getStake(HK1, alias_, 0), 5 * RAO);
        assertEq(staking.getStake(HK1, _me(), 0), 0);
    }

    // ---- every debit and credit is a value transfer, undone by a revert (Task 35) ----

    /// A stake whose caller reverts after it: the caller's balance and the position are as before (before Task 35 the
    /// debit was a vm.deal, which survived the revert; it is now a value call to the sink, which the revert undoes);
    /// without the revert the caller paid exactly the stake.
    function test_aRevertedStakeKeepsTheCallersBalance() public {
        StakeThenRevert c = new StakeThenRevert();
        vm.deal(address(c), 1e18);
        staking.setOneRaoShort(false);
        vm.expectRevert(bytes("after"));
        c.stakeThenRevert(HK1, 30_000_000, true);
        assertEq(address(c).balance, 1e18, "the debit went with the revert");
        assertEq(staking.getStake(HK1, mirror(address(c)), 0), 0);
        c.stakeThenRevert(HK1, 30_000_000, false);
        assertEq(address(c).balance, 1e18 - 30_000_000 * RAO);
        assertEq(STAKED_TAO_SINK.balance, 30_000_000 * RAO, "the debit went to the sink");
    }

    /// A removal whose caller reverts after it: paid by a call (the default) or forced, the credit goes with the
    /// revert; without one, the caller got the receipt.
    function test_aRevertedRemovalKeepsNoReceiptInEitherMode() public {
        StakeThenRevert c = new StakeThenRevert();
        staking.donateStake(HK1, mirror(address(c)), 30_000_000);
        assertTrue(staking.payByCall(), "by a call, by default");
        vm.expectRevert(bytes("after"));
        c.removeThenRevert(HK1, true);
        assertEq(address(c).balance, 0, "the credit went with the revert");
        assertEq(staking.getStake(HK1, mirror(address(c)), 0), 30_000_000);

        staking.setPayByCall(false);
        assertFalse(staking.payByCall());
        vm.expectRevert(bytes("after"));
        c.removeThenRevert(HK1, true);
        assertEq(address(c).balance, 0, "forced, it went with the revert too");
        c.removeThenRevert(HK1, false);
        assertEq(address(c).balance, 30_000_000 * RAO);
        assertEq(c.received(), 0, "a forced credit runs none of the caller's code");
    }

    /// By default a removal's credit enters the caller's receive() (a refusing caller reverts the removal), and a claim
    /// paid as balance is forced (no code runs, as the chain credits it). setPayByCall(true) pays the claim by a call
    /// too, which a refusing caller refuses.
    function test_aRemovalPaysByACallAndAClaimIsForcedByDefault() public {
        StakeThenRevert c = new StakeThenRevert();
        bytes32 cold = mirror(address(c));
        staking.donateStake(HK1, cold, 30_000_000);
        c.removeThenRevert(HK1, false);
        assertEq(c.received(), 30_000_000 * RAO, "by a call: its receive() ran");
        c.setRefuse(true);
        staking.donateStake(HK1, cold, 30_000_000);
        vm.expectRevert(bytes("refused"));
        c.removeThenRevert(HK1, false);

        staking.setClaimToBalance(true);
        staking.setUnclaimed(cold, HK1, 1_000_000);
        c.claim(HK1);
        assertEq(address(c).balance, 30_000_000 * RAO + 1_000_000 * RAO, "forced: the refusing caller is paid");

        staking.setPayByCall(true);
        staking.setUnclaimed(cold, HK1, 1_000_000);
        vm.expectRevert(bytes("refused"));
        c.claim(HK1);
    }

    /// The stake's debit is made as the caller (a prank), whatever the test's own prank: none, a single prank or a
    /// recurring one, which stays in force after it.
    function test_theDebitWorksUnderEveryOuterPrank() public {
        StakeThenRevert c = new StakeThenRevert();
        vm.deal(address(c), 1e18);
        staking.setOneRaoShort(false);
        address someone = makeAddr("someone");
        vm.prank(someone);
        c.stakeThenRevert(HK1, 2_000_000, false);
        vm.startPrank(someone, someone);
        c.stakeThenRevert(HK1, 2_000_000, false);
        assertEq(c.who(), someone, "the recurring prank is still in force");
        vm.stopPrank();
        assertEq(address(c).balance, 1e18 - 4_000_000 * RAO);
        assertEq(c.who(), address(this));
    }
}

/// A coldkey stand-in that stakes, removes or claims at the mock and may revert afterwards, and counts what its
/// receive() took.
contract StakeThenRevert {
    MockStaking constant STAKING = MockStaking(ISTAKING_ADDRESS);
    uint256 public received;
    bool public refuse;

    function setRefuse(bool on) external {
        refuse = on;
    }

    function stakeThenRevert(bytes32 hotkey, uint256 rao, bool revertAfter) external {
        STAKING.addStake(hotkey, rao, 0);
        if (revertAfter) revert("after");
    }

    function removeThenRevert(bytes32 hotkey, bool revertAfter) external {
        STAKING.removeStakeFull(hotkey, 0);
        if (revertAfter) revert("after");
    }

    function claim(bytes32 hotkey) external {
        STAKING.claimRootWithHotkey{gas: 60_000_000}(hotkey);
    }

    function who() external view returns (address) {
        return msg.sender;
    }

    receive() external payable {
        if (refuse) revert("refused");
        received += msg.value;
    }
}
