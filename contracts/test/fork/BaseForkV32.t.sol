// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Vm} from "forge-std/Vm.sol";
import {CascadeBase} from "../../src/CascadeBase.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeTwapOracle, IUniswapV3PoolOracle} from "../../src/CascadeTwapOracle.sol";
import {CcipAdapterBase} from "../../src/adapters/CcipAdapterBase.sol";
import {CcipBaseAdapter} from "../../src/adapters/CcipBaseAdapter.sol";
import {CascadeDoorLens} from "../../src/lens/CascadeDoorLens.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {Schedule} from "../governance/Schedule.sol";
import {defaultFrontDoorParams, withLaunchValues} from "../utils/DefaultParams.sol";
import {MessageV1Codec} from "../vendor/ccip/MessageV1Codec.sol";
import {ForkBase, IOffRamp20} from "./ForkBase.sol";
import {
    REAL_EXECUTE_INPUT,
    REAL_EXECUTION_AMOUNT,
    REAL_EXECUTION_FORK_BLOCK,
    REAL_EXECUTION_MESSAGE_ID,
    REAL_EXECUTION_RECEIVER
} from "./RealExecution.sol";

/// @notice Cascade v3.2's front door and Base adapter on a Base mainnet fork (Task 61, spec §9.2's fork rehearsal), at
/// the launch values, over the real FM-TAO, Router, OffRamp 2.0.0 (verifiers stubbed, except in the one test that runs
/// the real committee verifier) and BurnMint pool: the receive gas of payout chunks and of a 50-deposit refund against
/// the toward-Base model (R3 TH-5), a refund through the real OffRamp to a front door that accepts its known bridges
/// after a rail switch (T27 c9), the close with the id through the real Router (B16b), a real CCIP FAILURE recovered by
/// hand with the committee's real results (R3 fix c3, T52), and the oracle's history requirement (C7, Revision 28).
/// Run with `FORK=1` (optionally `BASE_RPC=<url>`).
contract BaseForkV32Test is ForkBase {
    uint64 constant BITTENSOR = 964;
    address constant BASE_WETH = 0x4200000000000000000000000000000000000006;
    address constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant TAO_WETH_POOL = 0x82dD34C6631C286cDD1dB16f2c232f60E402Dd5A;
    address constant WETH_USDC_POOL = 0xd0b53D9277642d899DF5C87A3966A349A798F224;
    /// The launch gas pairs: the Base adapter's own (toward Bittensor), and the Bittensor adapter's toward Base, which
    /// sets the gas of every message this side receives (raised at Task 65 from 140,000 / 29,900, the T61a review's
    /// I-2).
    uint256 constant TO_BITTENSOR_BASE = 1_300_000;
    uint256 constant TO_BITTENSOR_PER_ENTRY = 57_000;
    uint256 constant TO_BASE_BASE = 180_000;
    uint256 constant TO_BASE_PER_ENTRY = 32_000;
    /// What the live door's last write costs above these forks' (the T61a review's I-2): here no batch was ever closed,
    /// so `netForwarded = forwarded > amount ? forwarded - amount : 0` stores 0 over 0 (100 gas, the slot read cold either
    /// way); on the live door it changes a non-zero value (2,900): 2,800 more at every landing.
    uint256 constant NET_FORWARDED_WRITE = 2_800;
    uint32 constant REFUND_CHUNK = type(uint32).max;

    address owner = makeAddr("v32 base owner");
    address guardian = makeAddr("v32 base guardian");
    address keeper = makeAddr("v32 base keeper");
    address treasury = makeAddr("v32 base treasury");
    address vaultAddr = makeAddr("v32 vault");
    /// The Bittensor adapter that A1's messages come from, and its twin for the second pair.
    address remoteBit = makeAddr("v32 adapterBit");
    address remoteBit2 = makeAddr("v32 adapterBit 2");

    IERC20 tao = IERC20(BASE_TAO);
    address offRamp;
    CcipBaseAdapter a1;
    CascadeFrontDoor fd;
    CascadeDoorLens doorLens;

    function setUp() public {
        forkFrom("BASE_RPC", "https://mainnet.base.org");
        if (!isFork()) return;
        emit log_named_uint("fork block", vm.getBlockNumber());
        offRamp = offRamp20(BASE_ROUTER, BITTENSOR_SELECTOR);
        a1 = newAdapter(remoteBit);
        CascadeFrontDoor.Params memory p = withLaunchValues(
            defaultFrontDoorParams(
                IERC20Metadata(BASE_TAO), a1, BITTENSOR, vaultAddr, IERC20(BASE_USDC), owner, guardian, keeper
            )
        );
        fd = new CascadeFrontDoor(p);
        doorLens = new CascadeDoorLens(address(fd));
        vm.deal(keeper, 1 ether);
    }

    // ---- the receive gas toward Base (R3 TH-5) ----

    /// Whether `payouts` (carrying `amount`) from the vault reaches the front door through the real OffRamp, BurnMint pool
    /// and A1, the adapter given exactly `limit` gas.
    function lands(bytes memory payouts, uint256 amount, uint256 limit) internal returns (bool ok) {
        (, ok,) = execute(offRamp, fromBittensor(a1, remoteBit, payouts, amount, limit));
    }

    /// The least receiver gas, to 64 gas, at which `payouts` lands, bisected over cold runs (setUp is a transaction of
    /// its own, and a revert to the snapshot brings back the cold state: GasProbes' ColdRuns).
    function leastLandingLimit(bytes memory payouts, uint256 amount) internal returns (uint256 hi) {
        uint256 snap = vm.snapshotState();
        assertTrue(lands(payouts, amount, 7_000_000), "lands with plenty of gas");
        uint256 lo = 20_000;
        hi = 7_000_000;
        while (hi - lo > 64) {
            uint256 mid = (lo + hi) / 2;
            vm.revertToState(snap);
            if (lands(payouts, amount, mid)) hi = mid;
            else lo = mid;
        }
        vm.revertToState(snap);
    }

    /// `n` entries of 1 TAO each to fresh addresses (0x3000 + i).
    function entriesN(uint256 n) internal pure returns (CascadeMessages.Entry[] memory e) {
        e = new CascadeMessages.Entry[](n);
        for (uint256 i; i < n; ++i) {
            e[i] = CascadeMessages.Entry(address(uint160(0x3000 + i)), 1e18);
        }
    }

    /// One shape against the toward-Base model (180,000 + 32,000 an entry, the Bittensor adapter's launch pair): the
    /// least landing gas through the real OffRamp with the real FM-TAO into a real front door, plus the live door's
    /// non-zero netForwarded write, and the 15% margin on it.
    function checkLanding(bytes memory payouts, uint256 entries) internal {
        uint256 least = leastLandingLimit(payouts, entries * 1e18) + NET_FORWARDED_WRITE;
        uint256 model = TO_BASE_BASE + entries * TO_BASE_PER_ENTRY;
        emit log_named_uint("entries", entries);
        emit log_named_uint("  base least landing gas", least);
        emit log_named_int("  base slack under the 15% rule", int256(model) - int256(least * 115 / 100));
        assertGe(model, least * 115 / 100, "the model covers the need with 15%");
    }

    function test_fork_v32_onePayoutLandsWithinTheModel() public onlyFork {
        checkLanding(CascadeMessages.encodePayouts(keccak256("v32 batch"), 0, entriesN(1)), 1);
    }

    function test_fork_v32_twentyFivePayoutsLandWithinTheModel() public onlyFork {
        checkLanding(CascadeMessages.encodePayouts(keccak256("v32 batch"), 0, entriesN(25)), 25);
    }

    function test_fork_v32_fiftyPayoutsLandWithinTheModel() public onlyFork {
        checkLanding(CascadeMessages.encodePayouts(keccak256("v32 batch"), 0, entriesN(50)), 50);
    }

    /// A park's refund (spec §3.2, Task 27): PAYOUTS(the park's key, REFUND_CHUNK, the parked batch's deposits), here a
    /// whole batch of 50 deposits, the largest refund.
    function test_fork_v32_aFiftyDepositRefundLandsWithinTheModel() public onlyFork {
        bytes memory refund = CascadeMessages.encodePayouts(keccak256("v32 park"), REFUND_CHUNK, entriesN(50));
        checkLanding(refund, 50);
    }

    // ---- a refund through the old rail after a switch (T27 c9, B16a) ----

    /// Spec §3.2 (H-2 i) through the real lane: deposits close through A1; the owner switches the front door to a new
    /// pair (A2 activated through the scheduler, A1 disabled by the guardian, A2 made primary); the vault's side parks
    /// the batch and, after PARK_TIMEOUT, refunds it through A1's Bittensor twin. The refund arrives through the real
    /// OffRamp at A1, disabled but known, and the door credits each depositor its deposit, and its net forwarded falls by
    /// it. A copy of the refund through an adapter the door never knew is refused (NotBridge): CCIP FAILURE.
    function test_fork_v32_refundLandsThroughTheDisabledTwin() public onlyFork {
        address alice = makeAddr("v32 alice");
        address bob = makeAddr("v32 bob");
        depositAs(alice, 1e18);
        depositAs(bob, 1e18);
        closeOpen(1);
        assertEq(fd.netForwarded(), 2e18, "forwarded");
        switchToASecondPair();

        CascadeMessages.Entry[] memory d = new CascadeMessages.Entry[](2);
        d[0] = CascadeMessages.Entry(alice, 1e18);
        d[1] = CascadeMessages.Entry(bob, 1e18);
        bytes memory refund = CascadeMessages.encodePayouts(keccak256("v32 park key"), REFUND_CHUNK, d);
        refusedThroughAStranger(refund);

        (bytes32 id, bool ok, bytes memory err) =
            execute(offRamp, fromBittensor(a1, remoteBit, refund, 2e18, TO_BASE_BASE + 2 * TO_BASE_PER_ENTRY));
        assertEq(err, "", "no error");
        assertTrue(ok, "landed through the disabled twin");
        assertEq(IOffRamp20(offRamp).getExecutionState(id), SUCCESS, "SUCCESS");
        assertEq(fd.claimable(alice), 1e18, "alice's deposit back");
        assertEq(fd.claimable(bob), 1e18, "bob's");
        assertEq(fd.netForwarded(), 0, "nothing forwarded any more");
        vm.prank(alice);
        fd.claim();
        assertEq(tao.balanceOf(alice), 1e18, "alice claims her TAO");
    }

    /// The owner's switch to a second pair: A2 activated through the scheduler (7 days), A1 disabled by the guardian,
    /// A2 made primary; A1 stays known.
    function switchToASecondPair() internal {
        CcipBaseAdapter a2 = newAdapter(remoteBit2);
        Schedule.run(fd, owner, abi.encodeCall(CascadeBase.activateBridge, (address(a2))));
        vm.prank(guardian);
        fd.disableBridge(address(a1));
        vm.prank(owner);
        fd.setPrimaryBridge(address(a2));
        assertEq(doorLens.primaryBridge(), address(a2), "the new pair is primary");
        assertFalse(doorLens.bridgeEnabled(address(a1)), "the old one disabled");
        assertTrue(doorLens.bridgeKnown(address(a1)), "and still known");
    }

    /// `refund` through an adapter the door never knew: refused (NotBridge), CCIP FAILURE, the mint rolled back.
    function refusedThroughAStranger(bytes memory refund) internal {
        CcipBaseAdapter stranger = newAdapter(remoteBit);
        uint256 supply = tao.totalSupply();
        (bytes32 id, bool ok, bytes memory err) =
            execute(offRamp, fromBittensor(stranger, remoteBit, refund, 2e18, TO_BASE_BASE + 2 * TO_BASE_PER_ENTRY));
        assertFalse(ok, "refused");
        assertEq(IOffRamp20(offRamp).getExecutionState(id), FAILURE, "FAILURE");
        assertEq(
            err, abi.encodeWithSignature("ReceiverError(bytes)", abi.encodeWithSignature("NotBridge()")), "NotBridge"
        );
        assertEq(tao.totalSupply(), supply, "the mint rolled back");
    }

    // ---- the close with the id through the real Router (B16b) ----

    /// Spec §3.5 (Task 29/30): closeBatch(expectedId, minValue) names the batch it closes. A wrong id reverts
    /// WrongBatch(the open id); the right one sends the open batch through the real Router and OnRamp, the pot (the
    /// requests' fees) paying the fee first and the closer's value the rest (its unused part back), the BurnMint pool
    /// burning the deposits; the message the OnRamp emits carries the batch with that id from the door to the vault,
    /// and the next batch is open with the next id.
    function test_fork_v32_closeWithTheIdThroughTheRealRouter() public onlyFork {
        address alice = makeAddr("v32 close alice");
        address carol = makeAddr("v32 close carol");
        depositAs(alice, 2e18);
        vm.deal(carol, 1 ether);
        uint256 requestFee = fd.redeemRequestFee();
        vm.prank(carol);
        fd.requestRedeem{value: requestFee}(5e24);
        (uint64 id, uint64 start,, uint256 pot,,) = fd.openBatch();
        assertEq(id, 1, "the open batch");
        assertEq(pot, requestFee, "the pot holds the request's fee");
        vm.warp(uint256(start) + fd.batchInterval());

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CascadeFrontDoor.WrongBatch.selector, uint64(1)));
        fd.closeBatch{value: 1 ether}(2, 0);

        bytes memory batch = CascadeMessages.encodeBatch(1, entries1(alice, 2e18), entries1(carol, 5e24));
        vm.prank(address(fd));
        uint256 fee = a1.quoteFee(BITTENSOR, vaultAddr, batch, 2e18);
        uint256 supply = tao.totalSupply();
        uint256 keeperBefore = keeper.balance;
        vm.recordLogs();
        vm.prank(keeper);
        fd.closeBatch{value: fee}(1, 2e18);
        assertBatchSent(vm.getRecordedLogs(), batch);
        assertEq(keeper.balance, keeperBefore - (fee - pot), "the pot paid first, the closer the rest");
        assertEq(tao.totalSupply(), supply - 2e18, "the BurnMint pool burned the deposits");
        (uint64 next,,,,,) = fd.openBatch();
        assertEq(next, 2, "the next batch is open");
    }

    // ---- a real FAILURE recovered by hand with the committee's real results (R3 fix c3, T52) ----

    /// T52's ruling on the real committee verifier: OffRamp 2.0.0's re-execution of a FAILURE checks the committee's
    /// results again (no verifier is stubbed here), so an empty proof is refused, and the results the failed attempt
    /// carried in its own calldata deliver the message. A real Bittensor-to-Base message (RealExecution.sol), forked at
    /// the block before its execution; its first attempt, the real transaction's calldata, made to fail by the token's
    /// mint reverting (the BurnMint pool's release); then the same calldata re-executed by hand once the mint works.
    function test_fork_v32_realFailureRecoveredWithTheCommitteesResults() public onlyFork {
        vm.createSelectFork(vm.envOr("BASE_RPC", string("https://mainnet.base.org")), REAL_EXECUTION_FORK_BLOCK);
        (bytes memory encoded, address[] memory ccvs) = executeArgs();
        bytes32 id = keccak256(encoded);
        assertEq(id, REAL_EXECUTION_MESSAGE_ID, "the message id");
        assertEq(ccvs.length, 1, "one committee verifier");
        assertEq(IOffRamp20(BASE_OFFRAMP).getExecutionState(id), UNTOUCHED, "untouched before its block");
        uint256 before = tao.balanceOf(REAL_EXECUTION_RECEIVER);

        // the first attempt fails: the token's mint (the pool's release) reverts
        vm.mockCallRevert(BASE_TAO, abi.encodeWithSelector(bytes4(keccak256("mint(address,uint256)"))), "");
        (bool first,) = BASE_OFFRAMP.call(REAL_EXECUTE_INPUT);
        assertTrue(first, "the attempt returns");
        assertEq(IOffRamp20(BASE_OFFRAMP).getExecutionState(id), FAILURE, "FAILURE written");
        vm.clearMockedCalls();
        uint256 snap = vm.snapshotState();

        // by hand with no committee results: refused, still FAILURE
        (bool emptyOk,) =
            BASE_OFFRAMP.call(abi.encodeCall(IOffRamp20.execute, (encoded, ccvs, new bytes[](ccvs.length), uint32(0))));
        assertFalse(emptyOk, "an empty proof is refused");
        assertEq(IOffRamp20(BASE_OFFRAMP).getExecutionState(id), FAILURE, "still FAILURE");
        assertEq(tao.balanceOf(REAL_EXECUTION_RECEIVER), before, "nothing minted");

        // by hand with the failed attempt's own calldata, its committee results: delivered
        vm.revertToState(snap);
        (bool again,) = BASE_OFFRAMP.call(REAL_EXECUTE_INPUT);
        assertTrue(again, "the re-execution returns");
        assertEq(IOffRamp20(BASE_OFFRAMP).getExecutionState(id), SUCCESS, "SUCCESS");
        assertEq(tao.balanceOf(REAL_EXECUTION_RECEIVER), before + REAL_EXECUTION_AMOUNT, "the tokens minted");
    }

    /// R4 C's unconfirmed item and T52's W2-L2 (a stranger's junk attempt), on the real committee verifier: the same
    /// real message, UNTOUCHED, executed first by a stranger with no committee results. What that attempt leaves decides
    /// what the keeper's hand re-execution must find: here the attempt writes FAILURE (the proof is checked inside the
    /// OffRamp's inner call, whose failure it records), and its calldata holds no usable proof; the honest results (the
    /// real transaction's) still deliver it from that FAILURE, so a junk FAILURE is recovered by whoever holds them.
    function test_fork_v32_aStrangersEmptyProofWritesAFailureTheRealResultsRecover() public onlyFork {
        vm.createSelectFork(vm.envOr("BASE_RPC", string("https://mainnet.base.org")), REAL_EXECUTION_FORK_BLOCK);
        (bytes memory encoded, address[] memory ccvs) = executeArgs();
        bytes32 id = keccak256(encoded);
        uint256 before = tao.balanceOf(REAL_EXECUTION_RECEIVER);
        vm.prank(makeAddr("v32 stranger"));
        (bool strangerOk,) =
            BASE_OFFRAMP.call(abi.encodeCall(IOffRamp20.execute, (encoded, ccvs, new bytes[](ccvs.length), uint32(0))));
        uint8 state = IOffRamp20(BASE_OFFRAMP).getExecutionState(id);
        emit log_named_uint("the stranger's attempt returned (1) or reverted (0)", strangerOk ? 1 : 0);
        emit log_named_uint("the state it left (0 untouched, 3 failure)", state);
        // what the real OffRamp does (the README's note 18 and checklist item 27): the attempt returns and writes FAILURE,
        // so a change in the OffRamp's behaviour fails here (the T61a review's Minor 2)
        assertTrue(strangerOk, "the stranger's attempt returns");
        assertEq(state, FAILURE, "and writes FAILURE");
        assertEq(tao.balanceOf(REAL_EXECUTION_RECEIVER), before, "nothing minted");
        (bool honest,) = BASE_OFFRAMP.call(REAL_EXECUTE_INPUT);
        assertTrue(honest, "the honest results go through");
        assertEq(IOffRamp20(BASE_OFFRAMP).getExecutionState(id), SUCCESS, "SUCCESS");
        assertEq(tao.balanceOf(REAL_EXECUTION_RECEIVER), before + REAL_EXECUTION_AMOUNT, "the tokens minted");
    }

    /// The real transaction's first two arguments, the encoded message and the verifiers: its input, the selector
    /// checked, then skipped (the length word moved up over it in memory), decoded.
    function executeArgs() internal pure returns (bytes memory encoded, address[] memory ccvs) {
        bytes memory input = REAL_EXECUTE_INPUT;
        assertEq(bytes4(input), IOffRamp20.execute.selector, "execute's selector");
        bytes memory args;
        assembly ("memory-safe") {
            args := add(input, 4)
            mstore(args, sub(mload(input), 4))
        }
        (encoded, ccvs) = abi.decode(args, (bytes, address[]));
    }

    // ---- the oracle's history (C7, Revision 28) ----

    /// C7 with Revision 28's minimum: the live pools hold at least MIN_CARDINALITY (1,801) observation slots, the deploy's
    /// precondition (spec section 7); a fork pinned before the TAO/WETH pool grew (block 53,341,000, 600 slots) has the
    /// oracle's constructor refuse it, which is why the suites that build the oracle skip there
    /// (ForkBase.skipBelowMinCardinality).
    function test_fork_v32_oracleHistoryRequirement() public onlyFork {
        (,,, uint16 taoWeth,,,) = IUniswapV3PoolOracle(TAO_WETH_POOL).slot0();
        (,,, uint16 wethUsdc,,,) = IUniswapV3PoolOracle(WETH_USDC_POOL).slot0();
        emit log_named_uint("TAO/WETH observation slots in use", taoWeth);
        emit log_named_uint("WETH/USDC observation slots in use", wethUsdc);
        assertGe(taoWeth, ORACLE_MIN_CARDINALITY, "TAO/WETH meets the oracle's minimum");
        assertGe(wethUsdc, ORACLE_MIN_CARDINALITY, "WETH/USDC meets it");
        CascadeTwapOracle oracle = new CascadeTwapOracle(TAO_WETH_POOL, WETH_USDC_POOL, BASE_TAO, BASE_WETH, BASE_USDC);
        assertEq(oracle.MIN_CARDINALITY(), ORACLE_MIN_CARDINALITY, "1,801");

        vm.createSelectFork(vm.envOr("BASE_RPC", string("https://mainnet.base.org")), 53_341_000);
        (,,, uint16 early,,,) = IUniswapV3PoolOracle(TAO_WETH_POOL).slot0();
        assertEq(early, 600, "600 slots before the pool grew");
        vm.expectRevert(abi.encodeWithSelector(CascadeTwapOracle.TooFewObservations.selector, TAO_WETH_POOL, 600));
        new CascadeTwapOracle(TAO_WETH_POOL, WETH_USDC_POOL, BASE_TAO, BASE_WETH, BASE_USDC);
    }

    // ---- helpers ----

    /// The real OnRamp's one message among `logs`: `batch` from the door to the vault, to the Bittensor adapter, at the
    /// launch pair's gas for its two entries.
    function assertBatchSent(Vm.Log[] memory logs, bytes memory batch) internal view {
        MessageV1Codec.MessageV1 memory sent = sentMessage(logs, BASE_ONRAMP);
        assertEq(sent.data, a1.encodePayload(vaultAddr, address(fd), batch), "the batch with its id, door to vault");
        assertEq(sent.receiver, abi.encodePacked(remoteBit), "to the Bittensor adapter");
        assertEq(
            sent.ccipReceiveGasLimit, TO_BITTENSOR_BASE + 2 * TO_BITTENSOR_PER_ENTRY, "the launch pair for two entries"
        );
    }

    /// A Base adapter at the launch pair toward Bittensor and the launch cap (50 TAO a message), whose Bittensor twin
    /// is `remote`.
    function newAdapter(address remote) internal returns (CcipBaseAdapter) {
        return new CcipBaseAdapter(
            CcipAdapterBase.Config({
                router: BASE_ROUTER,
                token: BASE_TAO,
                localChainId: 8453,
                remoteChainId: BITTENSOR,
                remoteSelector: BITTENSOR_SELECTOR,
                remoteAdapter: remote,
                gasBase: TO_BITTENSOR_BASE,
                gasPerEntry: TO_BITTENSOR_PER_ENTRY,
                maxMessageValue: 50e18,
                treasury: treasury
            }),
            0.01e18
        );
    }

    /// The vault's `payouts` (carrying `amount` bridged TAO) from the Bittensor adapter `remote` through adapter `a` to
    /// the front door, its receiver gas `gas`.
    function fromBittensor(CcipBaseAdapter a, address remote, bytes memory payouts, uint256 amount, uint256 gas)
        internal
        view
        returns (MessageV1Codec.MessageV1 memory m)
    {
        m = message(
            BITTENSOR_SELECTOR,
            BASE_SELECTOR,
            BIT_ONRAMP,
            offRamp,
            remote,
            address(a),
            BIT_POOL,
            BIT_TAO,
            BASE_TAO,
            amount,
            "",
            0
        );
        m.data = a.encodePayload(address(fd), vaultAddr, payouts);
        // gas stays under 7,000,001, which fits uint32
        // forge-lint: disable-next-line(unsafe-typecast)
        m.ccipReceiveGasLimit = uint32(gas);
    }

    function depositAs(address user, uint256 amount) internal {
        deal(BASE_TAO, user, amount);
        vm.startPrank(user);
        tao.approve(address(fd), amount);
        fd.deposit(amount);
        vm.stopPrank();
    }

    /// The keeper closes open batch `id` once due, through the primary, paying the real Router's fee.
    function closeOpen(uint64 id) internal {
        (, uint64 start,,,,) = fd.openBatch();
        vm.warp(uint256(start) + fd.batchInterval());
        vm.prank(keeper);
        fd.closeBatch{value: 0.01 ether}(id, 0);
    }

    function entries1(address user, uint256 amount) internal pure returns (CascadeMessages.Entry[] memory e) {
        e = new CascadeMessages.Entry[](1);
        e[0] = CascadeMessages.Entry(user, amount);
    }
}
