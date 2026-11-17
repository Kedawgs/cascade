// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {CcipAdapterBase} from "../../src/adapters/CcipAdapterBase.sol";
import {CcipBaseAdapter} from "../../src/adapters/CcipBaseAdapter.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeDoorLens} from "../../src/lens/CascadeDoorLens.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {Client} from "../../src/vendor/ccip/Client.sol";
import {MockRouter} from "../mocks/MockRouter.sol";
import {MockTAO} from "../mocks/MockTAO.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {defaultFrontDoorParams} from "../utils/DefaultParams.sol";
import {Schedule} from "../governance/Schedule.sol";

contract CcipBaseAdapterTest is Test {
    uint64 constant BITTENSOR = 964;
    uint64 constant BITTENSOR_SELECTOR = 2135107236357186872;

    MockTAO tao;
    MockRouter router;
    CcipBaseAdapter adapter;
    CascadeFrontDoor fd;
    /// The read-only lens on `fd` (spec §8.1).
    CascadeDoorLens doorLens;

    address adapterBit = makeAddr("adapterBit");
    address vaultAddr = makeAddr("vault");
    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address alice = makeAddr("alice");
    address keeper = makeAddr("keeper");
    address treasury = makeAddr("treasury");

    function setUp() public {
        tao = new MockTAO(18);
        router = new MockRouter(tao);
        router.setFee(1e15);
        adapter = new CcipBaseAdapter(config(5_000e18), 0.01e18);
        CascadeFrontDoor.Params memory p =
            defaultFrontDoorParams(tao, adapter, BITTENSOR, vaultAddr, new MockUSDC(), owner, guardian, keeper);
        p.minDeposit = 0.03e18;
        fd = new CascadeFrontDoor(p);
        doorLens = new CascadeDoorLens(address(fd));
        tao.mint(alice, 1_000e18);
        vm.prank(alice);
        tao.approve(address(fd), type(uint256).max);
        vm.deal(alice, 1 ether);
        vm.deal(keeper, 1 ether);
    }

    function config(uint256 maxMessageValue) internal view returns (CcipAdapterBase.Config memory) {
        return CcipAdapterBase.Config({
            router: address(router),
            token: address(tao),
            localChainId: 8453,
            remoteChainId: BITTENSOR,
            remoteSelector: BITTENSOR_SELECTOR,
            remoteAdapter: adapterBit,
            gasBase: 1_000_000,
            gasPerEntry: 25_000,
            maxMessageValue: maxMessageValue,
            treasury: treasury
        });
    }

    /// A send minimum above the per-message cap would leave no amount sendable.
    function test_constructorRejectsMinimumAboveCap() public {
        vm.expectRevert(CcipAdapterBase.MessageCapOutOfRange.selector);
        new CcipBaseAdapter(config(1e18), 1e18 + 1);
        CcipBaseAdapter ok = new CcipBaseAdapter(config(1e18), 1e18);
        assertEq(ok.maxMessageValue(), 1e18);
        assertEq(ok.minSendAmount(), 1e18);
    }

    function _approvedSender(uint256 amount) internal returns (address) {
        tao.mint(address(this), amount);
        tao.approve(address(adapter), amount);
        return address(this);
    }

    function test_send_belowMinimumReverts() public {
        _approvedSender(1e18);
        uint256 min = 0.01e18;
        vm.expectRevert(abi.encodeWithSelector(CcipAdapterBase.BelowSendMinimum.selector, min - 1, min));
        adapter.send{value: 1e15}(BITTENSOR, vaultAddr, "", min - 1);

        adapter.send{value: 1e15}(BITTENSOR, vaultAddr, "", min);
        adapter.send{value: 1e15}(BITTENSOR, vaultAddr, "", 0);
    }

    function test_send_pullsTokensAndApprovesExactly() public {
        _approvedSender(1e18);
        adapter.send{value: 1e15}(BITTENSOR, vaultAddr, "", 1e18);
        assertEq(tao.balanceOf(address(router)), 1e18);
        assertEq(tao.balanceOf(address(this)), 0);
        assertEq(tao.balanceOf(address(adapter)), 0);
        assertEq(tao.allowance(address(adapter), address(router)), 0);
    }

    function test_send_paysRouterExactlyFee() public {
        _approvedSender(1e18);
        uint256 before = address(this).balance;
        adapter.send{value: 3e15}(BITTENSOR, vaultAddr, "", 1e18);
        assertEq(address(router).balance, 1e15);
        assertEq(address(adapter).balance, 2e15);
        assertEq(before - address(this).balance, 3e15);
    }

    function test_closeBatch_throughAdapter() public {
        assertEq(doorLens.primaryBridge(), address(adapter));
        vm.prank(alice);
        fd.deposit(1e18);
        vm.warp(vm.getBlockTimestamp() + 12 hours);

        CascadeMessages.Entry[] memory deposits = new CascadeMessages.Entry[](1);
        deposits[0] = CascadeMessages.Entry(alice, 1e18);
        bytes memory batch = CascadeMessages.encodeBatch(1, deposits, new CascadeMessages.Entry[](0));

        uint256 fee = router.getFee(BITTENSOR_SELECTOR, adapter.buildMessage(vaultAddr, address(fd), batch, 1e18));
        vm.prank(keeper);
        fd.closeBatch{value: fee}(1, 1e18);

        MockRouter.Sent memory s = router.lastSend();
        assertEq(s.data, adapter.encodePayload(vaultAddr, address(fd), batch));
        assertEq(s.tokenAmounts.length, 1);
        assertEq(s.tokenAmounts[0].token, address(tao));
        assertEq(s.tokenAmounts[0].amount, 1e18);
    }

    /// README operator note 21, the front door's case (Task 30's follow-up): the cap check of setPrimaryBridge reads
    /// maxBatchValue, not the open batch. The owner lowers maxBatchValue below what the open batch already holds (an
    /// immediate tightening; the batch is then full by value and closeable), and, the old primary disabled, switches
    /// to a primary whose cap is that value. Every close then reverts MessageTooLarge in the new adapter's quoteFee,
    /// before any fee moves, and a new deposit BatchValueFull; a cancel goes through, and once the deposits left fit
    /// the cap, the batch closes.
    function test_aSwitchBelowTheOpenBatchHoldsItUntilCancels() public {
        vm.prank(alice);
        fd.deposit(10e18);
        vm.prank(owner);
        fd.setMaxBatchValue(5e18);
        assertTrue(fd.canClose(), "full by value");

        CcipBaseAdapter smaller = new CcipBaseAdapter(config(5e18), 0.01e18);
        Schedule.run(fd, owner, abi.encodeCall(fd.activateBridge, (address(smaller))));
        vm.prank(guardian);
        fd.disableBridge(address(adapter));
        vm.prank(owner);
        fd.setPrimaryBridge(address(smaller));
        assertEq(doorLens.primaryBridge(), address(smaller), "the switch passed: maxBatchValue fits the cap");

        vm.prank(keeper);
        vm.expectRevert(CcipAdapterBase.MessageTooLarge.selector);
        fd.closeBatch{value: 1e15}(1, 0);
        vm.prank(alice);
        vm.expectRevert(CascadeFrontDoor.BatchValueFull.selector);
        fd.deposit(1e18);
        assertEq(keeper.balance, 1 ether, "no fee moved");

        vm.prank(alice);
        fd.cancelDeposit(5e18);
        vm.prank(keeper);
        fd.closeBatch{value: 1e15}(1, 5e18);
        assertEq(router.lastSend().tokenAmounts[0].amount, 5e18);
        (uint64 id,,,,,) = fd.openBatch();
        assertEq(id, 2);
        assertEq(tao.balanceOf(alice), 995e18);
    }

    function _payoutsMessage() internal view returns (Client.Any2EVMMessage memory m) {
        CascadeMessages.Entry[] memory payouts = new CascadeMessages.Entry[](1);
        payouts[0] = CascadeMessages.Entry(alice, 1e18);
        bytes memory payload = adapter.encodePayload(
            address(fd), vaultAddr, CascadeMessages.encodePayouts(bytes32(uint256(1)), 0, payouts)
        );
        Client.EVMTokenAmount[] memory t = new Client.EVMTokenAmount[](1);
        t[0] = Client.EVMTokenAmount(address(tao), 1e18);
        m = Client.Any2EVMMessage({
            messageId: bytes32(uint256(7)),
            sourceChainSelector: BITTENSOR_SELECTOR,
            sender: abi.encode(adapterBit),
            data: payload,
            destTokenAmounts: t
        });
    }

    function test_ccipReceive_deliversTokensThenMessageToFrontDoor() public {
        (bool called, bool ok,) = router.deliver(address(adapter), _payoutsMessage(), 2_000_000);
        assertTrue(called);
        assertTrue(ok);
        assertEq(fd.claimable(alice), 1e18);
        assertEq(tao.balanceOf(address(adapter)), 0);
        assertEq(tao.balanceOf(address(fd)), 1e18);
    }

    function test_ccipReceive_frontDoorRevertIsAtomic() public {
        router.deliver(address(adapter), _payoutsMessage(), 2_000_000);
        uint256 adapterBal = tao.balanceOf(address(adapter));
        uint256 fdBal = tao.balanceOf(address(fd));

        (bool called, bool ok,) = router.deliver(address(adapter), _payoutsMessage(), 2_000_000);
        assertTrue(called);
        assertFalse(ok);
        assertEq(tao.balanceOf(address(adapter)), adapterBal);
        assertEq(tao.balanceOf(address(fd)), fdBal);
    }

    function test_noReceiveFunction() public {
        (bool ok,) = address(adapter).call{value: 1}("");
        assertFalse(ok);
    }

    // ---- sweepSurplus ----

    /// What the Base adapter keeps, a send's fee excess and tokens sent to it by mistake, anyone sweeps to the
    /// immutable treasury, all of it; a sweep with nothing to sweep succeeds and moves nothing.
    function test_baseSweepSendsStrayEthAndTokens() public {
        _approvedSender(1e18);
        adapter.send{value: 3e15}(BITTENSOR, vaultAddr, "", 1e18);
        tao.mint(alice, 5e18);
        vm.prank(alice);
        assertTrue(tao.transfer(address(adapter), 5e18));
        assertEq(address(adapter).balance, 2e15);
        assertEq(tao.balanceOf(address(adapter)), 5e18);

        vm.expectEmit(true, true, true, true, address(adapter));
        emit CcipAdapterBase.SurplusSwept(2e15, 5e18);
        vm.prank(alice);
        adapter.sweepSurplus();
        assertEq(treasury.balance, 2e15);
        assertEq(tao.balanceOf(treasury), 5e18);
        assertEq(address(adapter).balance, 0);
        assertEq(tao.balanceOf(address(adapter)), 0);

        vm.expectEmit(true, true, true, true, address(adapter));
        emit CcipAdapterBase.SurplusSwept(0, 0);
        adapter.sweepSurplus();
        assertEq(treasury.balance, 2e15);
        assertEq(tao.balanceOf(treasury), 5e18);
    }

    /// Ruling B12: the sweep has no lock, because its payee is the immutable treasury and nothing is written
    /// before the transfers. The tokens go first, so a treasury that re-enters from the native payment finds
    /// both balances empty and sweeps 0, and the outer sweep still pays everything once.
    function test_baseSweepReentryByTreasurySweepsZero() public {
        ReentrantTreasury t = new ReentrantTreasury();
        CcipAdapterBase.Config memory c = config(5_000e18);
        c.treasury = address(t);
        CcipBaseAdapter a = new CcipBaseAdapter(c, 0.01e18);
        t.setAdapter(a);
        tao.mint(address(this), 1e18);
        tao.approve(address(a), 1e18);
        a.send{value: 3e15}(BITTENSOR, vaultAddr, "", 1e18);
        tao.mint(address(a), 5e18);

        vm.expectEmit(true, true, true, true, address(a));
        emit CcipAdapterBase.SurplusSwept(2e15, 5e18);
        vm.expectEmit(true, true, true, true, address(a));
        emit CcipAdapterBase.SurplusSwept(0, 0);
        a.sweepSurplus();
        assertEq(t.reentries(), 1, "re-entered");
        assertEq(t.nativeSeen(), 0, "no value left to the re-entry");
        assertEq(t.tokensSeen(), 0, "no tokens left to the re-entry");
        assertEq(address(t).balance, 2e15);
        assertEq(tao.balanceOf(address(t)), 5e18);
        assertEq(address(a).balance, 0);
        assertEq(tao.balanceOf(address(a)), 0);
    }

    /// A treasury that refuses the native payment reverts the whole sweep with `TransferFailed`: the token leg,
    /// paid first, rolls back with it, so the adapter keeps both balances and nothing reaches the treasury.
    function test_baseSweepRevertsWhenTheTreasuryRefusesEth() public {
        RefusingTreasury t = new RefusingTreasury();
        CcipAdapterBase.Config memory c = config(5_000e18);
        c.treasury = address(t);
        CcipBaseAdapter a = new CcipBaseAdapter(c, 0.01e18);
        tao.mint(address(this), 1e18);
        tao.approve(address(a), 1e18);
        a.send{value: 3e15}(BITTENSOR, vaultAddr, "", 1e18);
        tao.mint(address(a), 5e18);
        assertEq(address(a).balance, 2e15);
        assertEq(tao.balanceOf(address(a)), 5e18);

        vm.expectRevert(CcipAdapterBase.TransferFailed.selector);
        a.sweepSurplus();
        assertEq(address(a).balance, 2e15, "native kept");
        assertEq(tao.balanceOf(address(a)), 5e18, "tokens kept: the token leg rolled back");
        assertEq(address(t).balance, 0);
        assertEq(tao.balanceOf(address(t)), 0);
    }

    receive() external payable {}
}

/// A treasury whose `receive` reverts: it refuses every native payment.
contract RefusingTreasury {
    error Refused();

    receive() external payable {
        revert Refused();
    }
}

/// A treasury that re-enters `sweepSurplus` from the native payment, once, recording what the adapter held then.
contract ReentrantTreasury {
    CcipBaseAdapter public adapter;
    uint256 public reentries;
    uint256 public nativeSeen;
    uint256 public tokensSeen;

    function setAdapter(CcipBaseAdapter adapter_) external {
        adapter = adapter_;
    }

    receive() external payable {
        if (reentries > 0) return;
        reentries++;
        nativeSeen = address(adapter).balance;
        tokensSeen = adapter.token().balanceOf(address(adapter));
        adapter.sweepSurplus();
    }
}
