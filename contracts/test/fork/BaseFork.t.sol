// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Vm} from "forge-std/Vm.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CcipAdapterBase} from "../../src/adapters/CcipAdapterBase.sol";
import {CcipBaseAdapter} from "../../src/adapters/CcipBaseAdapter.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {IRouterClient} from "../../src/vendor/ccip/IRouterClient.sol";
import {MessageV1Codec} from "../vendor/ccip/MessageV1Codec.sol";
import {ForkBase, IOffRamp20, IPoolView, ITypeAndVersion} from "./ForkBase.sol";
import {Probe} from "./Probe.sol";
import {Sink} from "./Sink.sol";

interface IRouterExtra {
    function getOnRamp(uint64 destChainSelector) external view returns (address);
    function getWrappedNative() external view returns (address);
}

/// @notice The Base adapter and front door against the live CCIP lane on a Base mainnet fork: sends go
/// through the real Router, OnRamp 2.0.0 and BurnMint pool; deliveries come in through the real
/// OffRamp 2.0.0 (verifiers stubbed), pool and Router. Run with `FORK=1` (optionally `BASE_RPC=<url>`).
contract BaseForkTest is ForkBase {
    uint64 constant BITTENSOR = 964;
    address constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");
    address vaultAddr = makeAddr("vault");
    address remoteAdapter = makeAddr("adapterBit");

    address offRamp;
    CcipBaseAdapter adapterBase;
    CascadeFrontDoor fd;
    IERC20 tao = IERC20(BASE_TAO);

    function setUp() public {
        forkFrom("BASE_RPC", "https://mainnet.base.org");
        if (!isFork()) return;
        emit log_named_uint("fork block", block.number);
        offRamp = offRamp20(BASE_ROUTER, BITTENSOR_SELECTOR);
        adapterBase = new CcipBaseAdapter(
            CcipAdapterBase.Config({
                router: BASE_ROUTER,
                token: BASE_TAO,
                localChainId: 8453,
                remoteChainId: BITTENSOR,
                remoteSelector: BITTENSOR_SELECTOR,
                remoteAdapter: remoteAdapter,
                gasBase: 1_000_000,
                gasPerEntry: 25_000,
                maxMessageValue: 5_000e18
            }),
            0.01e18
        );
        fd = new CascadeFrontDoor(
            IERC20Metadata(BASE_TAO),
            adapterBase,
            BITTENSOR,
            vaultAddr,
            owner,
            guardian,
            12 hours,
            0.01e18,
            10_000e18,
            1e14,
            IERC20(BASE_USDC)
        );
        vm.deal(keeper, 1 ether);
    }

    // ---- spike ----

    function test_spike_executeDeliversTokensToSink() public onlyFork {
        Probe probe = new Probe();
        address srcSender = makeAddr("bittensorSender");
        MessageV1Codec.MessageV1 memory m = message(
            BITTENSOR_SELECTOR,
            BASE_SELECTOR,
            BIT_ONRAMP,
            offRamp,
            srcSender,
            address(probe),
            BIT_POOL,
            BIT_TAO,
            BASE_TAO,
            1e18,
            "spike",
            500_000
        );
        (bytes32 id, bool ok, bytes memory err) = execute(offRamp, m);
        assertEq(err, "", "no error");
        assertTrue(ok, "executed");
        assertEq(IOffRamp20(offRamp).getExecutionState(id), SUCCESS, "state");
        assertEq(tao.balanceOf(address(probe)), 1e18, "probe tokens");
        assertEq(probe.calls(), 1, "probe called");
        assertEq(probe.lastCaller(), BASE_ROUTER, "called by the router");
        assertEq(probe.lastMessageId(), id, "message id");
        assertEq(probe.lastSourceChain(), BITTENSOR_SELECTOR, "source chain");
        assertEq(probe.lastSender(), abi.encode(srcSender), "sender");
        assertEq(probe.lastData(), bytes("spike"), "data");
        assertEq(probe.lastTokenCount(), 1, "one token");
        assertEq(probe.lastToken(), BASE_TAO, "token");
        assertEq(probe.lastAmount(), 1e18, "amount");
    }

    // ---- lane limits ----

    function test_fork_limitsMatchSpec() public onlyFork {
        (uint256 maxDataBytes, uint256 maxPerMsgGasLimit) = destChainLimits(BASE_ONRAMP, BITTENSOR_SELECTOR);
        assertEq(maxDataBytes, 32_000, "maxDataBytes");
        assertEq(maxPerMsgGasLimit, 8_000_000, "maxPerMsgGasLimit");
        assertEq(
            IPoolView(BASE_POOL).getCurrentOutboundRateLimiterState(BITTENSOR_SELECTOR).capacity,
            5_000e18,
            "pool outbound capacity"
        );
        assertEq(ITypeAndVersion(BASE_ONRAMP).typeAndVersion(), "OnRamp 2.0.0", "OnRamp version");
        assertEq(IRouterExtra(BASE_ROUTER).getOnRamp(BITTENSOR_SELECTOR), BASE_ONRAMP, "router's OnRamp");
    }

    // ---- sending ----

    function test_fork_closeBatchBurnsThroughRealRouter() public onlyFork {
        deal(BASE_TAO, alice, 10e18);
        vm.startPrank(alice);
        tao.approve(address(fd), type(uint256).max);
        fd.deposit(1e18);
        vm.stopPrank();
        vm.warp(block.timestamp + 12 hours);

        // the front door's own message and quote (the adapter takes msg.sender as the payload sender)
        bytes memory batch = CascadeMessages.encodeBatch(1, entries1(alice, 1e18), noEntries());
        vm.prank(address(fd));
        uint256 quote = adapterBase.quoteFee(BITTENSOR, vaultAddr, batch, 1e18);
        assertGt(quote, 0, "live quote");

        address weth = IRouterExtra(BASE_ROUTER).getWrappedNative();
        uint256 supplyBefore = tao.totalSupply();
        uint256 wethBefore = weth.balance;
        uint256 routerBefore = BASE_ROUTER.balance;
        uint256 keeperBefore = keeper.balance;

        vm.recordLogs();
        vm.prank(keeper);
        fd.closeBatch{value: quote + 1}();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(tao.totalSupply(), supplyBefore - 1e18, "BurnMint pool burned the deposit");
        assertEq(tao.balanceOf(address(fd)), 0, "front door forwarded the deposit");
        assertEq(tao.balanceOf(address(adapterBase)), 0, "adapter holds no tokens");
        assertEq(address(adapterBase).balance, 0, "adapter holds no ETH");
        assertEq(keeper.balance, keeperBefore - quote, "keeper paid the quote, the extra wei came back");
        assertEq(sentFee(logs), quote, "Sent fee == quote");
        assertEq(weth.balance - wethBefore, quote, "router wrapped exactly the fee");
        assertEq(BASE_ROUTER.balance, routerBefore, "router keeps no ETH");
        assertBatchSent(logs, adapterBase.encodePayload(vaultAddr, address(fd), batch));
    }

    function test_fork_quoteMatchesRouterForSizes() public onlyFork {
        uint256[3] memory sizes = [uint256(1), 50, 100];
        for (uint256 s; s < sizes.length; ++s) {
            uint256 n = sizes[s];
            CascadeMessages.Entry[] memory deposits = new CascadeMessages.Entry[](n);
            for (uint256 i; i < n; ++i) {
                deposits[i] = CascadeMessages.Entry(vm.addr(i + 1), 1e18);
            }
            bytes memory batch = CascadeMessages.encodeBatch(1, deposits, noEntries());
            uint256 amount = n * 1e18;
            uint256 quote = adapterBase.quoteFee(BITTENSOR, vaultAddr, batch, amount);
            uint256 routerFee = IRouterClient(BASE_ROUTER)
                .getFee(BITTENSOR_SELECTOR, adapterBase.buildMessage(vaultAddr, address(this), batch, amount));
            emit log_named_uint(string.concat("fee (wei) for entries: ", vm.toString(n)), quote);
            assertGt(quote, 0, "non-zero fee");
            assertEq(quote, routerFee, "quoteFee == Router.getFee");
        }
    }

    // ---- receiving ----

    function test_fork_payoutsDeliveredThroughRealOffRamp() public onlyFork {
        bytes memory payouts = CascadeMessages.encodePayouts(keccak256("batch"), 0, entries1(alice, 1e18));
        MessageV1Codec.MessageV1 memory m = fromBittensor(address(fd), payouts, 1e18);
        uint256 fdBefore = tao.balanceOf(address(fd));
        uint256 supplyBefore = tao.totalSupply();

        (bytes32 id, bool ok, bytes memory err) = execute(offRamp, m);

        assertEq(err, "", "no error");
        assertTrue(ok, "executed");
        assertEq(IOffRamp20(offRamp).getExecutionState(id), SUCCESS, "state");
        assertEq(tao.totalSupply(), supplyBefore + 1e18, "BurnMint pool minted");
        assertEq(tao.balanceOf(address(fd)), fdBefore + 1e18, "front door received the tokens");
        assertEq(tao.balanceOf(address(adapterBase)), 0, "adapter holds no tokens");
        assertEq(fd.claimable(alice), 1e18, "alice credited");
        assertEq(fd.totalClaimable(), 1e18, "total claimable");
    }

    function test_fork_failedDeliveryIsRetriable() public onlyFork {
        // an ERC-20-side receiver that is broken for the first attempt
        Sink sink = new Sink();
        sink.setTokenSide(true);
        sink.setRevert(true);
        bytes memory payouts = CascadeMessages.encodePayouts(keccak256("batch"), 0, entries1(alice, 1e18));
        MessageV1Codec.MessageV1 memory m = fromBittensor(address(sink), payouts, 1e18);
        uint256 fdBefore = tao.balanceOf(address(fd));
        uint256 supplyBefore = tao.totalSupply();

        (bytes32 id, bool ok, bytes memory err) = execute(offRamp, m);

        assertFalse(ok, "first attempt failed");
        assertEq(IOffRamp20(offRamp).getExecutionState(id), FAILURE, "state FAILURE");
        assertEq(
            err,
            abi.encodeWithSignature("ReceiverError(bytes)", abi.encodeWithSelector(Sink.Reverting.selector)),
            "receiver's revert, wrapped by the OffRamp"
        );
        assertEq(tao.totalSupply(), supplyBefore, "mint rolled back");
        assertEq(tao.balanceOf(address(sink)), 0, "sink got nothing");
        assertEq(tao.balanceOf(address(adapterBase)), 0, "adapter holds no tokens");
        assertEq(tao.balanceOf(address(fd)), fdBefore, "front door unchanged");
        assertEq(sink.calls(), 0, "no delivery recorded");

        // the receiver is fixed; anyone re-executes the same message
        sink.setRevert(false);
        (bytes32 id2, bool ok2, bytes memory err2) = execute(offRamp, m);

        assertEq(id2, id, "same message");
        assertEq(err2, "", "no error");
        assertTrue(ok2, "retry executed");
        assertEq(IOffRamp20(offRamp).getExecutionState(id), SUCCESS, "state SUCCESS");
        assertEq(tao.totalSupply(), supplyBefore + 1e18, "minted once");
        assertEq(tao.balanceOf(address(sink)), 1e18, "sink holds the tokens");
        assertEq(tao.balanceOf(address(adapterBase)), 0, "adapter holds no tokens");
        assertEq(sink.calls(), 1, "delivered once");
        assertEq(sink.lastSourceChain(), BITTENSOR, "source chain");
        assertEq(sink.lastSender(), vaultAddr, "sender");
        assertEq(sink.lastMessage(), payouts, "message");
        assertEq(sink.lastAmount(), 1e18, "amount");
        assertEq(sink.lastValue(), 0, "no value on the ERC-20 side");
    }

    // ---- helpers ----

    /// A message from the Bittensor adapter to `recipient` through the Base adapter, carrying `amount`
    /// bridged TAO and the adapter's own gas limit for `cascadeMessage`.
    function fromBittensor(address recipient, bytes memory cascadeMessage, uint256 amount)
        internal
        view
        returns (MessageV1Codec.MessageV1 memory m)
    {
        m = message(
            BITTENSOR_SELECTOR,
            BASE_SELECTOR,
            BIT_ONRAMP,
            offRamp,
            remoteAdapter,
            address(adapterBase),
            BIT_POOL,
            BIT_TAO,
            BASE_TAO,
            amount,
            "",
            0
        );
        // set after the call: twelve arguments plus these locals do not fit the stack
        m.data = adapterBase.encodePayload(recipient, vaultAddr, cascadeMessage);
        // gasFor never exceeds GAS_CAP (7_000_000), which fits in uint32
        // forge-lint: disable-next-line(unsafe-typecast)
        m.ccipReceiveGasLimit = uint32(adapterBase.gasFor(cascadeMessage));
    }

    /// The real OnRamp's message for a 1-deposit batch of 1e18: the remote adapter is receiver and token
    /// receiver, in the encoding `message` builds for the opposite direction.
    function assertBatchSent(Vm.Log[] memory logs, bytes memory payload) internal view {
        MessageV1Codec.MessageV1 memory sent = sentMessage(logs, BASE_ONRAMP);
        assertEq(sent.sourceChainSelector, BASE_SELECTOR, "source selector");
        assertEq(sent.destChainSelector, BITTENSOR_SELECTOR, "dest selector");
        assertEq(sent.ccipReceiveGasLimit, 1_025_000, "receiver gas: gasBase + 1 entry");
        assertEq(sent.finality, bytes4(0), "wait for finality");
        assertEq(sent.onRampAddress, abi.encode(BASE_ONRAMP), "onRamp");
        assertEq(sent.offRampAddress, abi.encodePacked(BIT_OFFRAMP), "offRamp");
        assertEq(sent.sender, abi.encode(address(adapterBase)), "sender");
        assertEq(sent.receiver, abi.encodePacked(remoteAdapter), "receiver");
        assertEq(sent.data, payload, "data");
        assertEq(sent.tokenTransfer.length, 1, "one token");
        assertEq(sent.tokenTransfer[0].amount, 1e18, "amount");
        assertEq(sent.tokenTransfer[0].sourcePoolAddress, abi.encode(BASE_POOL), "source pool");
        assertEq(sent.tokenTransfer[0].sourceTokenAddress, abi.encode(BASE_TAO), "source token");
        assertEq(sent.tokenTransfer[0].destTokenAddress, abi.encodePacked(BIT_TAO), "dest token");
        assertEq(sent.tokenTransfer[0].tokenReceiver, abi.encodePacked(remoteAdapter), "token receiver");
    }

    /// The fee in the Base adapter's single Sent event among `logs`.
    function sentFee(Vm.Log[] memory logs) internal view returns (uint256 fee) {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(adapterBase) || logs[i].topics[0] != CcipAdapterBase.Sent.selector) {
                continue;
            }
            (,, fee,) = abi.decode(logs[i].data, (uint64, uint256, uint256, uint256));
            ++n;
        }
        assertEq(n, 1, "one Sent event");
    }

    function entries1(address user, uint256 amount) internal pure returns (CascadeMessages.Entry[] memory e) {
        e = new CascadeMessages.Entry[](1);
        e[0] = CascadeMessages.Entry(user, amount);
    }

    function noEntries() internal pure returns (CascadeMessages.Entry[] memory) {
        return new CascadeMessages.Entry[](0);
    }
}
