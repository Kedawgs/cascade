// SPDX-License-Identifier: MIT
// R3 second wave (ForeverMoney fidelity, W2-1): its five `test_FAILS_*` PoCs asserted what this suite asserted against
// the old MockAlphaVault and failed against ForeverMoney's deployed code. Ported by the R3 fix round (F6) as passing
// tests against the faithful MockAlphaVault, each asserting what the deployed code does.
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
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

/// @notice A recipient that accepts, or refuses while `refusing` (its batches then park as native TAO).
contract ToggleRecipient is ICascadeReceiver {
    error Refused();

    bool public refusing;
    uint256 public received;

    function setRefusing(bool on) external {
        refusing = on;
    }

    function onBridgeMessage(uint64, address, bytes calldata, uint256) external payable {
        if (refusing) revert Refused();
        received += msg.value;
    }
}

/// @notice The Bittensor adapter against ForeverMoney's deployed behaviour (MockAlphaVault since R3 F6), the chain's
/// rounding modelled by the staking double where the W2-1 PoC put it (`setOneRaoShort`, `setRemoveFeeRao`,
/// `setMinStake`): a stake 1 rao short is sent whole (D-1), a delivery 2 rao short parks with ForeverMoney's `Slippage`
/// (D-2), a halt parks with `IsHalted` and lifts itself (D-3), a converted refund under a raised chain floor waits for
/// the precompile's minimum (D-4), and a migration closes sends and converted refunds with `MigrationInProgress` while
/// deliveries, converted parks included, still go, until the position leaves (`Insolvent`) (D-5, FM-I3).
contract ForeverMoneyFidelityTest is Test, CushionHelpers {
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
    ToggleRecipient sink;

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
        sink = new ToggleRecipient();
        vm.deal(address(this), 1_000 ether);
        adapter.fundReserve{value: RESERVE}();
    }

    // ---- helpers ----

    function batch(uint64 id, uint256 amount) internal view returns (bytes memory) {
        CascadeMessages.Entry[] memory deposits = new CascadeMessages.Entry[](1);
        deposits[0] = CascadeMessages.Entry(alice, amount);
        return CascadeMessages.encodeBatch(id, deposits, new CascadeMessages.Entry[](0));
    }

    /// Delivers batch `id` of `amount` to `recipient` through the router double (the tokens released and the call
    /// made in one frame) and returns whether it parked, and how: BatchParked's `converted` and `reason`.
    function deliver(address recipient, uint64 id, uint256 amount)
        internal
        returns (bool parked, bool converted, bytes4 reason)
    {
        Client.EVMTokenAmount[] memory t = new Client.EVMTokenAmount[](1);
        t[0] = Client.EVMTokenAmount(address(taoBit), amount);
        Client.Any2EVMMessage memory m = Client.Any2EVMMessage({
            messageId: keccak256(abi.encode(id)),
            sourceChainSelector: BASE_SELECTOR,
            sender: abi.encode(adapterBase),
            data: adapter.encodePayload(recipient, frontDoor, batch(id, amount)),
            destTokenAmounts: t
        });
        vm.recordLogs();
        (bool called, bool ok,) = router.deliver(address(adapter), m, GAS);
        assertTrue(called && ok, "the message SUCCEEDS");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(adapter) || logs[i].topics[0] != CcipBittensorAdapter.BatchParked.selector) {
                continue;
            }
            (,,, converted, reason) = abi.decode(logs[i].data, (address, address, uint256, bool, bytes4));
            return (true, converted, reason);
        }
    }

    function send(uint256 amount) internal {
        adapter.send{value: amount + FEE}(BASE, frontDoor, "", amount);
    }

    /// A native park of batch `id` of `amount` (the sink refusing it), PARK_TIMEOUT old.
    function convertedPark(uint64 id, uint256 amount) internal returns (bytes memory message) {
        sink.setRefusing(true);
        (bool parked, bool converted, bytes4 reason) = deliver(address(sink), id, amount);
        assertTrue(parked && converted, "a native park");
        assertEq(reason, ToggleRecipient.Refused.selector);
        sink.setRefusing(false);
        message = batch(id, amount);
        vm.warp(vm.getBlockTimestamp() + adapter.PARK_TIMEOUT());
    }

    // ---- D-1: the stake measured, 1 rao short, is sent whole (was test_FAILS_D1_sendSideToleranceAsTask28Promises) ----

    /// The chain credits a stake into an empty position 1 rao short (the staking double's rounding): ForeverMoney mints
    /// the stake it measured, which its check against the amount less 1 rao lets through (R3 B-1), and the cushion pays
    /// the rao: the whole amount is sent.
    function test_aStakeTheChainCreditsOneRaoShortIsSentWhole() public {
        staking.loseStake(av.VALIDATOR(), av.vaultColdkey(), av.SEED_RAO());
        assertEq(av.stakedValueRao(address(taoBit)), 0, "the position emptied");
        staking.setOneRaoShort(true);
        fundCushion(taoBit, address(adapter), 1e15);
        vm.expectEmit(address(adapter));
        emit CcipBittensorAdapter.ShortfallCovered(1e9);
        send(1e18);
        assertEq(router.lastSend().tokenAmounts[0].amount, 1e18, "the whole amount");
        assertEq(av.stakedValueRao(address(taoBit)), 1e9 - 1, "the stake the chain credited");
        assertEq(taoBit.balanceOf(address(adapter)), 1e15 - 1e9, "the cushion paid the rao");
    }

    // ---- D-2: a delivery 2 rao short fails inside ForeverMoney (was test_FAILS_D2_twoRaoShortDeliveryParksAs...) ----

    /// The chain pays an unstake 2 rao short: ForeverMoney's own output check refuses it (Slippage), convertExact
    /// reverts with it, the burn rolls back, and the batch parks as tokens with ForeverMoney's reason, not the
    /// adapter's ConversionShort (R3 FM-L1). Exactly 1 rao short passes and the reserve pays it.
    function test_aDeliveryTwoRaoShortParksWithForeverMoneysSlippage() public {
        staking.setRemoveFeeRao(2);
        (bool parked, bool converted, bytes4 reason) = deliver(address(sink), 1, 10e18);
        assertTrue(parked, "parked");
        assertFalse(converted, "as tokens");
        assertEq(reason, MockAlphaVault.Slippage.selector, "ForeverMoney refused, not the adapter");
        assertEq(taoBit.balanceOf(address(adapter)), 10e18, "the burn rolled back");
        assertEq(adapter.parkedTokens(), 10e18);
        assertEq(address(adapter).balance, RESERVE, "the reserve untouched");
        assertEq(sink.received(), 0);
        assertOwed(adapter, taoBit);

        staking.setRemoveFeeRao(1);
        (parked,,) = deliver(address(sink), 2, 10e18);
        assertFalse(parked, "1 rao short delivers");
        assertEq(sink.received(), 10e18, "the recipient got the whole amount");
        assertEq(address(adapter).balance, RESERVE - 1e9, "the reserve paid the rao");
    }

    // ---- D-3: the halt is a clock (was test_FAILS_D3_pausedDeliveryParksWithTheMocksHaltedSelector) ----

    /// The guardian's halt parks a delivery with ForeverMoney's IsHalted, lifts itself after its term (then
    /// deliverParked delivers), cannot be renewed inside its cooldown, and the operator can hold past its cap.
    function test_aHaltedDeliveryParksWithIsHaltedAndTheHaltLiftsItself() public {
        av.guardianPause(1 days);
        (bool parked, bool converted, bytes4 reason) = deliver(address(sink), 1, 10e18);
        assertTrue(parked);
        assertFalse(converted);
        assertEq(reason, MockAlphaVault.IsHalted.selector, "ForeverMoney's selector");
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertFalse(av.isPaused(), "lifted by itself");
        adapter.deliverParked(address(sink), frontDoor, batch(1, 10e18));
        assertEq(sink.received(), 10e18);
        assertEq(adapter.parkedTokens(), 0);
        vm.expectRevert(MockAlphaVault.PauseCooldown.selector);
        av.guardianPause(1 days);
        av.adminHold(vm.getBlockTimestamp() + 3650 days);
        vm.warp(vm.getBlockTimestamp() + 3 days);
        assertTrue(av.isPaused(), "the operator holds past the guardian's 2-day cap");
        (parked,, reason) = deliver(address(sink), 2, 1e18);
        assertTrue(parked);
        assertEq(reason, MockAlphaVault.IsHalted.selector);
    }

    // ---- D-4: no floor of ForeverMoney's own (was test_FAILS_D4_convertedRefundUnderARaisedFloorRevertsAmountTooLow) ----

    /// A converted refund below a raised chain floor fails inside ForeverMoney's addStake with the precompile's own
    /// error (BelowMinStake here), the park intact, and is refunded whole once the floor drops.
    function test_aConvertedRefundUnderARaisedFloorWaitsForThePrecompile() public {
        bytes memory message = convertedPark(7, 1e16);
        staking.setMinStake(20_000_000);
        assertGt(adapter.floor(), 1e16, "below the chain's floor now");
        vm.expectRevert(MockStaking.BelowMinStake.selector);
        adapter.refundParked{value: FEE}(address(sink), frontDoor, message);
        assertEq(adapter.parkedNative(), 1e16, "the park stays");
        staking.setMinStake(0);
        adapter.refundParked{value: FEE}(address(sink), frontDoor, message);
        assertEq(router.lastSend().tokenAmounts[0].amount, 1e16, "refunded whole once the floor drops");
        assertEq(adapter.parkedNative(), 0);
    }

    // ---- D-5 and FM-I3: a migration (was test_FAILS_D5_convertedRefundDuringAMigrationRevertsMigrating) ----

    /// From the announcement, sends and converted refunds revert MigrationInProgress; deliveries still convert through
    /// the 7-day notice; a converted (native) park still delivers, needing no ForeverMoney call (FM-I3), during the
    /// notice and after the migration. Once the position has left, a delivery parks Insolvent, a claim ForeverMoney
    /// will not honour, and once finished, IsHalted.
    function test_aMigrationClosesSendsAndRefundsKeepsDeliveriesThenInsolvent() public {
        bytes memory first = convertedPark(7, 1e18);
        bytes memory second = convertedPark(8, 2e18);
        av.initiateMigration();
        vm.expectRevert(MockAlphaVault.MigrationInProgress.selector);
        adapter.refundParked{value: FEE}(address(sink), frontDoor, first);
        vm.expectRevert(MockAlphaVault.MigrationInProgress.selector);
        send(1e18);

        (bool parked,, bytes4 reason) = deliver(address(sink), 2, 10e18);
        assertFalse(parked, "delivered during the notice");
        adapter.deliverParked(address(sink), frontDoor, first);
        assertEq(sink.received(), 11e18, "a converted park delivers during the notice");

        vm.warp(vm.getBlockTimestamp() + av.MIGRATION_DELAY());
        av.executeMigration();
        assertEq(av.stakedValueRao(address(taoBit)), 0, "the backing left");
        (parked,, reason) = deliver(address(sink), 3, 10e18);
        assertTrue(parked, "parked");
        assertEq(reason, MockAlphaVault.Insolvent.selector);
        assertEq(taoBit.balanceOf(address(adapter)), 10e18, "the tokens sit in the park");
        av.finishMigration();
        (parked,, reason) = deliver(address(sink), 4, 1e18);
        assertEq(reason, MockAlphaVault.IsHalted.selector, "retired for good");
        adapter.deliverParked(address(sink), frontDoor, second);
        assertEq(sink.received(), 13e18, "a converted park still delivers after the migration");
        assertEq(adapter.parkedNative(), 0);
    }
}
