// SPDX-License-Identifier: MIT
// R3 seat B's B-1 PoC (Checkpoint R3), inverted by the R3 fix round (F1): against ForeverMoney's deployed check a stake
// credited 1 rao short reverted `Slippage()` inside `depositLiquid`, because `_collect` passed `minAlphaRao = amount /
// RAO`; it now passes `amount / RAO - 1`, so the short stake reaches the adapter's own tolerance and the cushion pays
// the rao. First run over a local double with the deployed measured-output checks; since F6 over MockAlphaVault,
// faithful to them.
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {CcipAdapterBase} from "../../src/adapters/CcipAdapterBase.sol";
import {CcipBittensorAdapter} from "../../src/adapters/CcipBittensorAdapter.sol";
import {IAlphaVault} from "../../src/interfaces/IAlphaVault.sol";
import {ICascadeReceiver} from "../../src/interfaces/ICascadeBridge.sol";
import {ISTAKING_ADDRESS} from "../../src/interfaces/IStaking.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {Client} from "../../src/vendor/ccip/Client.sol";
import {MockAlphaVault} from "../mocks/MockAlphaVault.sol";
import {MockRouter} from "../mocks/MockRouter.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {MockTAO} from "../mocks/MockTAO.sol";
import {CushionHelpers} from "./CushionHelpers.sol";

contract AcceptingRecipient is ICascadeReceiver {
    uint256 public received;

    function onBridgeMessage(uint64, address, bytes calldata, uint256) external payable {
        received += msg.value;
    }
}

contract RefusingRecipient is ICascadeReceiver {
    error Refused();

    function onBridgeMessage(uint64, address, bytes calldata, uint256) external payable {
        revert Refused();
    }
}

/// @notice The send-side 1-rao tolerance (spec §3.3, Task 28) against ForeverMoney's measured-stake check (R3 B-1).
/// `_collect` passes `minAlphaRao = amount / RAO - 1`: ForeverMoney then lets a stake 1 rao short through, minting the
/// stake it measured, and the adapter's own check (`minted >= amount - 1 rao` and the balance covering `parkedTokens +
/// amount`) is the binding one, the token cushion paying the rao. A stake short by 2 rao or more still fails inside
/// ForeverMoney. The delivery side (`minTaoOut = amount - 1 rao`) already tolerated the same rounding.
contract SendSideToleranceTest is Test, CushionHelpers {
    uint64 constant BASE = 8453;
    uint64 constant BASE_SELECTOR = 15971525489660198786;
    uint256 constant RESERVE = 1e12;
    uint256 constant FEE = 1e15;
    uint256 constant GAS = 3_000_000;

    MockStaking staking = MockStaking(ISTAKING_ADDRESS);
    MockTAO taoBit;
    MockRouter router;
    MockAlphaVault av;
    CcipBittensorAdapter adapter;
    AcceptingRecipient sink;
    RefusingRecipient refuser;

    address adapterBase = makeAddr("adapterBase");
    address frontDoor = makeAddr("frontDoor");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");

    function setUp() public {
        vm.etch(ISTAKING_ADDRESS, address(new MockStaking()).code);
        taoBit = new MockTAO(18);
        router = new MockRouter(taoBit);
        router.setFee(FEE);
        av = new MockAlphaVault(taoBit);
        vm.deal(address(av), 1_000e18);
        adapter = new CcipBittensorAdapter(
            CcipAdapterBase.Config({
                router: address(router),
                token: address(taoBit),
                localChainId: 964,
                remoteChainId: BASE,
                remoteSelector: BASE_SELECTOR,
                remoteAdapter: adapterBase,
                gasBase: 1_000_000,
                gasPerEntry: 25_000,
                maxMessageValue: 5_000e18,
                treasury: treasury
            }),
            IAlphaVault(address(av)),
            // the lane's inbound model (R4): the fixtures' Base-side pair
            1_000_000,
            25_000
        );
        sink = new AcceptingRecipient();
        refuser = new RefusingRecipient();
        vm.deal(address(this), 100 ether);
        adapter.fundReserve{value: RESERVE}();
    }

    function _send(uint256 amount) internal {
        adapter.send{value: amount + FEE}(BASE, frontDoor, "", amount);
    }

    function _batch(uint256 amount) internal view returns (bytes memory) {
        CascadeMessages.Entry[] memory deposits = new CascadeMessages.Entry[](1);
        deposits[0] = CascadeMessages.Entry(alice, amount);
        return CascadeMessages.encodeBatch(1, deposits, new CascadeMessages.Entry[](0));
    }

    function _incoming(address recipient, uint256 amount) internal view returns (Client.Any2EVMMessage memory m) {
        Client.EVMTokenAmount[] memory t = new Client.EVMTokenAmount[](1);
        t[0] = Client.EVMTokenAmount(address(taoBit), amount);
        m = Client.Any2EVMMessage({
            messageId: keccak256("one"),
            sourceChainSelector: BASE_SELECTOR,
            sender: abi.encode(adapterBase),
            data: adapter.encodePayload(recipient, frontDoor, _batch(amount)),
            destTokenAmounts: t
        });
    }

    /// `_collect` asks ForeverMoney for at least the amount less 1 rao, `amount / RAO - 1`, not the whole amount.
    function test_collectAsksForTheAmountLessOneRao() public {
        vm.expectCall(address(av), 1e18, abi.encodeCall(IAlphaVault.depositLiquid, (address(taoBit), 1e9 - 1)));
        _send(1e18);
        assertEq(router.lastSend().tokenAmounts[0].amount, 1e18, "an exact mint sends whole");
    }

    /// The behaviour spec §3.3 promises, against ForeverMoney's real check: a stake credited 1 rao short is minted as
    /// the stake ForeverMoney measured, and the token cushion pays the rao: ShortfallCovered(1 rao), the router takes
    /// the whole amount, the cushion falls by exactly the rao, the native reserve is untouched.
    function test_aStakeOneRaoShortIsSentWholeTheCushionPaying() public {
        fundCushion(taoBit, address(adapter), 1e15);
        av.setShortBy(1e9);
        vm.expectEmit(address(adapter));
        emit CcipBittensorAdapter.ShortfallCovered(1e9);
        _send(1e18);
        assertEq(router.lastSend().tokenAmounts[0].amount, 1e18, "the whole amount");
        assertEq(taoBit.balanceOf(address(router)), 1e18);
        assertEq(taoBit.balanceOf(address(adapter)), 1e15 - 1e9, "the cushion paid the rao");
        assertEq(address(adapter).balance, RESERVE, "the native reserve untouched");
    }

    /// The adapter's own check is the binding one: a stake 1 rao short with the cushion empty now passes ForeverMoney
    /// and reverts the adapter's ConversionShort (a transfer to the cushion unblocks it), and one 2 rao short still
    /// reverts inside ForeverMoney (Slippage) however full the cushion. Nothing is sent and the cushion is untouched
    /// by either refusal.
    function test_theAdaptersCheckBindsAndTwoRaoShortFailsInsideForeverMoney() public {
        av.setShortBy(1e9);
        vm.expectRevert(CcipAdapterBase.ConversionShort.selector);
        _send(1e18);

        fundCushion(taoBit, address(adapter), 1e15);
        av.setShortBy(2e9);
        vm.expectRevert(MockAlphaVault.Slippage.selector);
        _send(1e18);
        assertEq(router.sendCount(), 0, "nothing sent");
        assertEq(taoBit.balanceOf(address(adapter)), 1e15, "the cushion untouched");

        av.setShortBy(1e9);
        _send(1e18);
        assertEq(router.sendCount(), 1, "1 rao short goes once the cushion is funded");
        assertEq(taoBit.balanceOf(address(adapter)), 1e15 - 1e9);
    }

    /// The other converting path (gap critic's SE-1): a converted (native) park refunded after PARK_TIMEOUT goes back
    /// into the token through the same `_collect`; a stake 1 rao short is paid by the cushion and the refund still
    /// carries exactly the park's amount (sending what was minted would make the door's sum check refuse it on every
    /// re-execution).
    function test_aConvertedRefundOneRaoShortIsSentWholeTheCushionPaying() public {
        (, bool ok,) = router.deliver(address(adapter), _incoming(address(refuser), 1e18), GAS);
        assertTrue(ok, "parked");
        assertEq(adapter.parkedNative(), 1e18, "a native park");
        vm.warp(vm.getBlockTimestamp() + adapter.PARK_TIMEOUT());

        fundCushion(taoBit, address(adapter), 1e15);
        av.setShortBy(1e9);
        vm.expectEmit(address(adapter));
        emit CcipBittensorAdapter.ShortfallCovered(1e9);
        adapter.refundParked{value: FEE}(address(refuser), frontDoor, _batch(1e18));
        assertEq(router.lastSend().tokenAmounts[0].amount, 1e18, "the park's whole amount");
        assertEq(adapter.parkedNative(), 0, "the park refunded");
        assertEq(taoBit.balanceOf(address(adapter)), 1e15 - 1e9, "the cushion paid the rao");
        assertEq(address(adapter).balance, RESERVE, "the native reserve untouched");
        assertOwed(adapter, taoBit);
    }

    /// The delivery side passes `minTaoOut = amount - SHORTFALL_TOLERANCE_WEI`, so the same 1-rao rounding on
    /// `withdrawLiquid` passes ForeverMoney's output check and the reserve covers the rao (it did before the fix too).
    function test_theDeliverySideToleratesTheSameRounding() public {
        av.setShortBy(1e9);
        (bool called, bool ok,) = router.deliver(address(adapter), _incoming(address(sink), 1e18), GAS);
        assertTrue(called);
        assertTrue(ok, "delivered");
        assertEq(sink.received(), 1e18, "the recipient got the whole amount");
        assertEq(address(adapter).balance, RESERVE - 1e9, "the reserve paid the rao");
        assertEq(adapter.parkedTokens(), 0, "no park");
    }
}
