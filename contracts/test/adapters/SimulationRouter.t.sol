// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {CcipAdapterBase} from "../../src/adapters/CcipAdapterBase.sol";
import {CcipBittensorAdapter} from "../../src/adapters/CcipBittensorAdapter.sol";
import {IAlphaVault} from "../../src/interfaces/IAlphaVault.sol";
import {ISTAKING_ADDRESS} from "../../src/interfaces/IStaking.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {Client} from "../../src/vendor/ccip/Client.sol";
import {IAny2EVMMessageReceiver} from "../../src/vendor/ccip/IAny2EVMMessageReceiver.sol";
import {MockAlphaVault} from "../mocks/MockAlphaVault.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {MockTAO} from "../mocks/MockTAO.sol";
import {Sink} from "../fork/Sink.sol";
import {SimulationRouter} from "../fork/SimulationRouter.sol";

/// @notice The live simulation's Router stand-in (`script/simulate_inbound.sh`, Task 25 fix round 1), run here
/// over the mock alpha vault: the script's verdict is OK only when the stand-in's call returns, which it does only
/// when the batch reached the sink and nothing parked. A conversion failure (a token park) and a sink refusal (a
/// native park) each revert SimulationParked with the totals and the record; an adapter revert is bubbled.
contract SimulationRouterTest is Test {
    uint64 constant BASE_SELECTOR = 15971525489660198786;
    uint256 constant RESERVE = 1e12;
    uint256 constant AMOUNT = 1e18;

    MockTAO tao;
    MockAlphaVault av;
    CcipBittensorAdapter adapter;
    SimulationRouter router;
    Sink sink;
    address remoteAdapter = makeAddr("remoteAdapter");
    address frontDoor = makeAddr("frontDoor");
    address alice = makeAddr("alice");
    bytes batch;

    /// ForeverMoney's operator holds the AlphaVault (adminHold, for ten years): every conversion reverts IsHalted
    /// until `av.unpause()`.
    function holdRail() internal {
        av.adminHold(vm.getBlockTimestamp() + 3650 days);
    }

    function setUp() public {
        vm.etch(ISTAKING_ADDRESS, address(new MockStaking()).code);
        tao = new MockTAO(18);
        av = new MockAlphaVault(tao);
        vm.deal(address(av), 1_000e18);
        sink = new Sink();

        CascadeMessages.Entry[] memory deposits = new CascadeMessages.Entry[](1);
        deposits[0] = CascadeMessages.Entry(alice, AMOUNT);
        batch = CascadeMessages.encodeBatch(1, deposits, new CascadeMessages.Entry[](0));
        // the script's key: keccak256(abi.encode(8453, front door, sink, batch))
        bytes32 key = keccak256(abi.encode(uint64(8453), frontDoor, address(sink), batch));

        uint256 nonce = vm.getNonce(address(this));
        address predictedAdapter = vm.computeCreateAddress(address(this), nonce + 1);
        router = new SimulationRouter(CcipBittensorAdapter(payable(predictedAdapter)), key);
        adapter = new CcipBittensorAdapter(
            CcipAdapterBase.Config({
                router: address(router),
                token: address(tao),
                localChainId: 964,
                remoteChainId: 8453,
                remoteSelector: BASE_SELECTOR,
                remoteAdapter: remoteAdapter,
                gasBase: 140_000,
                gasPerEntry: 29_900,
                maxMessageValue: 5_000e18,
                treasury: makeAddr("treasury")
            }),
            IAlphaVault(address(av)),
            // the lane's inbound model (R4): the deploy's pair toward Bittensor
            780_000,
            58_000
        );
        assertEq(address(adapter), predictedAdapter);
        assertEq(address(router.adapter()), address(adapter), "the script's pre-flight read");
        // the script's balance-slot override: the adapter holds the batch's tokens
        tao.mint(address(adapter), AMOUNT);
    }

    /// The script's eth_call: `ccipReceive` sent to the stand-in with the reserve as value.
    function simulate(address sender) internal returns (bool ok, bytes memory ret) {
        Client.EVMTokenAmount[] memory t = new Client.EVMTokenAmount[](1);
        t[0] = Client.EVMTokenAmount(address(tao), AMOUNT);
        Client.Any2EVMMessage memory m = Client.Any2EVMMessage({
            messageId: keccak256("cascade simulate_inbound"),
            sourceChainSelector: BASE_SELECTOR,
            sender: abi.encode(sender),
            data: abi.encode(address(sink), frontDoor, batch),
            destTokenAmounts: t
        });
        (ok, ret) = address(router).call{value: RESERVE}(abi.encodeCall(IAny2EVMMessageReceiver.ccipReceive, (m)));
    }

    function test_aDeliveryToTheSinkPasses() public {
        (bool ok,) = simulate(remoteAdapter);
        assertTrue(ok, "SIMULATION OK");
        assertEq(sink.lastValue(), AMOUNT);
        assertEq(address(adapter).balance, RESERVE);
    }

    /// A failed conversion (ForeverMoney halted) parks the tokens: the stand-in reverts with the token park.
    function test_aTokenParkFails() public {
        holdRail();
        (bool ok, bytes memory ret) = simulate(remoteAdapter);
        assertFalse(ok);
        assertEq(
            ret,
            abi.encodeWithSelector(
                SimulationRouter.SimulationParked.selector, 0, AMOUNT, AMOUNT, vm.getBlockTimestamp(), false
            )
        );
    }

    /// A sink that refuses the TAO parks it as native: the stand-in reverts with the native park.
    function test_aNativeParkFails() public {
        sink.setRevert(true);
        (bool ok, bytes memory ret) = simulate(remoteAdapter);
        assertFalse(ok);
        assertEq(
            ret,
            abi.encodeWithSelector(
                SimulationRouter.SimulationParked.selector, AMOUNT, 0, AMOUNT, vm.getBlockTimestamp(), true
            )
        );
    }

    /// An adapter revert is bubbled as it is, for the script to name.
    function test_anAdapterRevertIsBubbled() public {
        (bool ok, bytes memory ret) = simulate(makeAddr("someoneElse"));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(CcipAdapterBase.WrongSender.selector));
    }
}
