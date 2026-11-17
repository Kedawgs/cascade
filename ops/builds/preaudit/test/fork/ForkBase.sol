// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {MessageV1Codec} from "../vendor/ccip/MessageV1Codec.sol";
import {StubVerifier} from "./StubVerifier.sol";

/// The parts of the CCIP `OffRamp 2.0.0` the harness drives. `getExecutionState` returns the
/// `Internal.MessageExecutionState` enum: UNTOUCHED 0, IN_PROGRESS 1, SUCCESS 2, FAILURE 3.
interface IOffRamp20 {
    function execute(bytes calldata, address[] calldata, bytes[] calldata, uint32) external;
    function getCCVsForMessage(bytes calldata) external view returns (address[] memory, address[] memory, uint8);
    function getExecutionState(bytes32) external view returns (uint8);
}

interface IRouterView {
    struct OffRamp {
        uint64 sourceChainSelector;
        address offRamp;
    }

    function getOffRamps() external view returns (OffRamp[] memory);
    function getOnRamp(uint64 destChainSelector) external view returns (address);
    function getWrappedNative() external view returns (address);
}

interface ITypeAndVersion {
    function typeAndVersion() external view returns (string memory);
}

/// `OnRamp 2.0.0`'s dynamic config (a struct of three static fields, read as a tuple).
interface IOnRamp20 {
    function getDynamicConfig()
        external
        view
        returns (address feeQuoter, bool reentrancyGuardEntered, address feeAggregator);
}

/// The rate-limiter view of the 1.5.1 token pools on this lane (BurnMint on Base, LockRelease on Bittensor).
interface IPoolView {
    struct TokenBucket {
        uint128 tokens;
        uint32 lastUpdated;
        bool isEnabled;
        uint128 capacity;
        uint128 rate;
    }

    function getCurrentOutboundRateLimiterState(uint64 remoteChainSelector) external view returns (TokenBucket memory);
}

/// @notice Fork harness for the CCIP adapters: the live CCIP lane between Base and Bittensor EVM, and a
/// way to deliver a message through the real `OffRamp 2.0.0` with only its verifiers stubbed.
/// @dev Fork tests run only with `FORK` set (`FORK=1 forge test --match-path "test/fork/*.t.sol"`);
/// without it `forkFrom` creates no fork and every `onlyFork` test reports as skipped.
abstract contract ForkBase is Test {
    uint64 constant BASE_SELECTOR = 15971525489660198786;
    uint64 constant BITTENSOR_SELECTOR = 2135107236357186872;
    address constant BASE_ROUTER = 0x881e3A65B4d4a04dD529061dd0071cf975F58bCD;
    address constant BIT_ROUTER = 0xD941fBEcD2b971d0F54b4C34286C95faB52B60B8;
    address constant BASE_ONRAMP = 0xF75bf16b03aaE98677926F0987F195A2153996B9;
    address constant BIT_ONRAMP = 0x5aA05e14ac7FaF23F1757d46429E6CA7e3FC1274;
    address constant BASE_OFFRAMP = 0x16E577f1724AE2598F9b43a52C19E6f67eE13808;
    address constant BIT_OFFRAMP = 0xF9410A08FD57e629c66E1f37a5Ae8f0a757d9AD9;
    address constant BASE_TAO = 0xf3081494B87e8D5fb7960f066E931D1D0e6E3d67;
    address constant BIT_TAO = 0xC5b6C1632d34901239396F5E1BDe54B342900256;
    address constant BASE_POOL = 0xF5AC6D6Bd12d8b87dE3c136FAc9375961577e794;
    address constant BIT_POOL = 0xB66b9c085ab711ECC373aaF6dc959a4A6B42BE2e;
    address constant ALPHA_VAULT = 0x11837459896D96F821a8D88eC93a3C8D152033D4;

    uint8 constant UNTOUCHED = 0;
    uint8 constant IN_PROGRESS = 1;
    uint8 constant SUCCESS = 2;
    uint8 constant FAILURE = 3;

    bytes32 constant EXECUTION_STATE_CHANGED = keccak256("ExecutionStateChanged(uint64,uint64,bytes32,uint8,bytes)");
    /// `OnRamp 2.0.0`'s send event; its data starts (address feeToken, uint256 amount, bytes encodedMessage, ...).
    bytes32 constant CCIP_MESSAGE_SENT = keccak256(
        "CCIPMessageSent(uint64,address,bytes32,address,uint256,bytes,(address,uint32,uint32,uint256,bytes)[],bytes[])"
    );

    /// `isFork()` is forge-std's (StdCheats): true once `forkFrom` has selected a fork.
    modifier onlyFork() {
        if (!isFork()) vm.skip(true);
        _;
    }

    /// Forks the chain at `envKey`'s RPC (or `defaultRpc`), only when `FORK` is set: at block `FORK_BLOCK` when
    /// that is set, so Foundry's RPC cache can serve repeat runs, else at the latest block. `FORK_BLOCK` applies
    /// to every fork in the run, so pin one chain at a time (`--match-path`).
    function forkFrom(string memory envKey, string memory defaultRpc) internal {
        if (!vm.envOr("FORK", false)) return;
        string memory url = vm.envOr(envKey, defaultRpc);
        uint256 pinned = vm.envOr("FORK_BLOCK", uint256(0));
        if (pinned == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, pinned);
    }

    /// The `OffRamp 2.0.0` that `router` accepts for messages from `sourceSelector`, found by version
    /// string among the router's off-ramps; it must be the only one and match this file's constant.
    function offRamp20(address router, uint64 sourceSelector) internal view returns (address found) {
        IRouterView.OffRamp[] memory ramps = IRouterView(router).getOffRamps();
        uint256 n;
        for (uint256 i; i < ramps.length; ++i) {
            if (ramps[i].sourceChainSelector != sourceSelector) continue;
            if (keccak256(bytes(ITypeAndVersion(ramps[i].offRamp).typeAndVersion())) != keccak256("OffRamp 2.0.0")) {
                continue;
            }
            found = ramps[i].offRamp;
            ++n;
        }
        assertEq(n, 1, "exactly one OffRamp 2.0.0 for the source chain");
        assertEq(found, router == BASE_ROUTER ? BASE_OFFRAMP : BIT_OFFRAMP, "OffRamp 2.0.0 address");
    }

    /// The lane limits that `onRamp`'s FeeQuoter enforces toward `destSelector`: words [1] and [2] of the
    /// raw 11-word `getDestChainConfig` return (`FeeQuoter 2.0.0`'s DestChainConfig).
    function destChainLimits(address onRamp, uint64 destSelector)
        internal
        view
        returns (uint256 maxDataBytes, uint256 maxPerMsgGasLimit)
    {
        (address feeQuoter,,) = IOnRamp20(onRamp).getDynamicConfig();
        (bool ok, bytes memory raw) =
            feeQuoter.staticcall(abi.encodeWithSignature("getDestChainConfig(uint64)", destSelector));
        assertTrue(ok, "getDestChainConfig");
        assertEq(raw.length, 11 * 32, "DestChainConfig is 11 words");
        (, maxDataBytes, maxPerMsgGasLimit) = abi.decode(raw, (uint256, uint256, uint256));
    }

    /// A CCIP 2.0 message as the source OnRamp would emit it: source-side addresses `abi.encode`d,
    /// destination-side addresses as raw 20 bytes, our adapter as both receiver and token receiver.
    function message(
        uint64 srcSel,
        uint64 dstSel,
        address srcOnRamp,
        address dstOffRamp,
        address srcAdapter,
        address dstAdapter,
        address srcPool,
        address srcToken,
        address dstToken,
        uint256 amount,
        bytes memory data,
        uint32 gas
    ) internal pure returns (MessageV1Codec.MessageV1 memory m) {
        m.sourceChainSelector = srcSel;
        m.destChainSelector = dstSel;
        m.messageNumber = 0;
        m.executionGasLimit = 0;
        m.ccipReceiveGasLimit = gas;
        m.finality = bytes4(0);
        m.ccvAndExecutorHash = bytes32(0);
        m.onRampAddress = abi.encode(srcOnRamp);
        m.offRampAddress = abi.encodePacked(dstOffRamp);
        m.sender = abi.encode(srcAdapter);
        m.receiver = abi.encodePacked(dstAdapter);
        m.destBlob = "";
        m.tokenTransfer = new MessageV1Codec.TokenTransferV1[](amount == 0 ? 0 : 1);
        if (amount > 0) {
            m.tokenTransfer[0] = MessageV1Codec.TokenTransferV1({
                amount: amount,
                sourcePoolAddress: abi.encode(srcPool),
                sourceTokenAddress: abi.encode(srcToken),
                destTokenAddress: abi.encodePacked(dstToken),
                tokenReceiver: abi.encodePacked(dstAdapter),
                extraData: ""
            });
        }
        m.data = data;
    }

    /// Executes `m` on the real `offRamp` with every verifier it requires stubbed for the call. `ok` is true
    /// only when the call returned and the message reached SUCCESS; `err` is the revert data when `execute`
    /// itself reverted, else the `returnData` of the OffRamp's ExecutionStateChanged event (the receiver's
    /// or pool's error on FAILURE, empty on SUCCESS). Uses (and so consumes) `vm.recordLogs`.
    function execute(address offRamp, MessageV1Codec.MessageV1 memory m)
        internal
        returns (bytes32 id, bool ok, bytes memory err)
    {
        (id, ok, err,) = executeLogged(offRamp, m);
    }

    /// `execute`, also returning every log the execution emitted (none when `execute` itself reverted),
    /// e.g. for a keeper rebuilding a payout list from the receiver's events. The verifiers' real code is
    /// put back afterwards: a lane's default CCV also resolves the verifier for sends, so a stub left in
    /// place would break a later send on the same fork.
    function executeLogged(address offRamp, MessageV1Codec.MessageV1 memory m)
        internal
        returns (bytes32 id, bool ok, bytes memory err, Vm.Log[] memory logs)
    {
        bytes memory encoded = MessageV1Codec._encodeMessageV1(m);
        id = keccak256(encoded);
        (address[] memory required, address[] memory optional,) = IOffRamp20(offRamp).getCCVsForMessage(encoded);
        address[] memory ccvs = new address[](required.length + optional.length);
        uint256 n;
        for (uint256 i; i < ccvs.length; ++i) {
            address ccv = i < required.length ? required[i] : optional[i - required.length];
            if (ccv == address(0)) continue;
            ccvs[n++] = ccv;
        }
        // drop the address(0) slots: shrink the array to the n CCVs written
        assembly ("memory-safe") {
            mstore(ccvs, n)
        }
        // every original is read before any etch, so a CCV listed twice still gets its real code back
        bytes[] memory realCode = new bytes[](n);
        for (uint256 i; i < n; ++i) {
            realCode[i] = ccvs[i].code;
        }
        for (uint256 i; i < n; ++i) {
            vm.etch(ccvs[i], type(StubVerifier).runtimeCode);
        }
        bytes[] memory results = new bytes[](n);

        vm.recordLogs();
        try IOffRamp20(offRamp).execute(encoded, ccvs, results, 0) {
            ok = IOffRamp20(offRamp).getExecutionState(id) == SUCCESS;
            logs = vm.getRecordedLogs();
            for (uint256 i; i < logs.length; ++i) {
                if (logs[i].emitter == offRamp && logs[i].topics[0] == EXECUTION_STATE_CHANGED) {
                    (, err) = abi.decode(logs[i].data, (uint8, bytes));
                }
            }
        } catch (bytes memory reason) {
            err = reason;
        }
        for (uint256 i; i < n; ++i) {
            vm.etch(ccvs[i], realCode[i]);
        }
    }

    /// The `MessageV1` in `onRamp`'s single CCIPMessageSent event among `logs`.
    function sentMessage(Vm.Log[] memory logs, address onRamp)
        internal
        view
        returns (MessageV1Codec.MessageV1 memory m)
    {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != onRamp || logs[i].topics[0] != CCIP_MESSAGE_SENT) continue;
            (,, bytes memory encoded) = abi.decode(logs[i].data, (address, uint256, bytes));
            m = this.decodeMessageV1(encoded);
            ++n;
        }
        assertEq(n, 1, "one CCIPMessageSent");
    }

    /// External so the codec reads the message from calldata, as it requires.
    function decodeMessageV1(bytes calldata encoded) external pure returns (MessageV1Codec.MessageV1 memory) {
        return MessageV1Codec._decodeMessageV1(encoded);
    }
}
