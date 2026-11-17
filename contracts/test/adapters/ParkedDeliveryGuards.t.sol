// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CcipAdapterBase} from "../../src/adapters/CcipAdapterBase.sol";
import {CcipBittensorAdapter} from "../../src/adapters/CcipBittensorAdapter.sol";
import {IAlphaVault} from "../../src/interfaces/IAlphaVault.sol";
import {ICascadeBridge, ICascadeReceiver} from "../../src/interfaces/ICascadeBridge.sol";
import {ADDRESS_MAPPING_ADDRESS} from "../../src/interfaces/IAddressMapping.sol";
import {ISTAKING_ADDRESS} from "../../src/interfaces/IStaking.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {Client} from "../../src/vendor/ccip/Client.sol";
import {MockAddressMapping} from "../mocks/MockAddressMapping.sol";
import {MockAlphaVault} from "../mocks/MockAlphaVault.sol";
import {MockRouter} from "../mocks/MockRouter.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {MockTAO} from "../mocks/MockTAO.sol";
import {CushionHelpers} from "./CushionHelpers.sol";
import {mirror} from "../mocks/Mirror.sol";
import {defaultVaultParams} from "../utils/DefaultParams.sol";
import {InsufficientGas, InvalidParameter} from "../../src/CascadeErrors.sol";

/// @notice A recipient that accepts a delivery only with at least `need` gas left on entry, and refuses (reverts)
/// with less: a vault whose call for a batch needs that much.
contract GasHungryReceiver is ICascadeReceiver {
    uint256 public immutable need;

    error Starved(uint256 left);

    constructor(uint256 need_) {
        need = need_;
    }

    function onBridgeMessage(uint64, address, bytes calldata, uint256) external payable {
        uint256 left = gasleft();
        if (left < need) revert Starved(left);
    }
}

/// @notice R4's two guards on the Bittensor adapter (spec §3.2, I-7; section 5's Chainlink row):
/// - C-L1, the adapter converts or spends only tokens that arrived: an inbound delivery, deliverParked and an
///   unconverted refund each require the token balance to cover the other token parks plus their own amount
///   and the booked cushion (ReserveShort, F-1), so a forged amount with no tokens behind it can take at most the
///   unswept surplus, never a park or the cushion;
/// - A-M1/C-M1's contract half, a parked delivery requires the vault's gas: deliverParked reverts InsufficientGas
///   unless the lane's inbound model for the message (parkedDeliveryGas, which includes PARK_GAS_RESERVE since the R4
///   review) is left right before the recipient's call, so a call starved of gas never converts or re-parks.
/// The adapter runs over the mock router and alpha vault in front of a real vault whose launch door is `frontDoor`, as
/// in BittensorParking.t.sol, with the fixtures' inbound model (1,000,000 and 25,000 an entry).
contract ParkedDeliveryGuardsTest is Test, CushionHelpers {
    uint64 constant BASE = 8453;
    uint64 constant BASE_SELECTOR = 15971525489660198786;
    uint256 constant RESERVE = 1e12;
    uint256 constant FEE = 1e15;
    bytes32 constant HK1 = bytes32(uint256(1));
    uint256 constant INBOUND_BASE = 1_000_000;
    uint256 constant INBOUND_PER_ENTRY = 25_000;

    MockStaking staking = MockStaking(ISTAKING_ADDRESS);
    MockTAO taoBit;
    MockRouter router;
    MockAlphaVault av;
    CcipBittensorAdapter adapter;
    CascadeVault vault;

    address adapterBase = makeAddr("adapterBase");
    address frontDoor = makeAddr("frontDoor");
    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address keeper = makeAddr("keeper");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address anyone = makeAddr("anyone");

    function setUp() public {
        vm.etch(ISTAKING_ADDRESS, address(new MockStaking()).code);
        vm.etch(ADDRESS_MAPPING_ADDRESS, address(new MockAddressMapping()).code);
        staking.addHotkey(HK1);
        taoBit = new MockTAO(18);
        router = new MockRouter(taoBit);
        av = new MockAlphaVault(taoBit);
        vm.deal(address(av), 1_000e18);

        address predictedVault = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        adapter = new CcipBittensorAdapter(config(), IAlphaVault(address(av)), INBOUND_BASE, INBOUND_PER_ENTRY);
        vault = new CascadeVault(
            defaultVaultParams(
                mirror(predictedVault), HK1, ICascadeBridge(address(adapter)), owner, guardian, keeper, BASE, frontDoor
            )
        );
        assertEq(address(vault), predictedVault);
        vm.deal(address(vault), RESERVE);
        adapter.fundReserve{value: RESERVE}();
        router.setFee(FEE);
        vm.deal(anyone, 1 ether);
    }

    // ---- helpers ----

    function config() internal view returns (CcipAdapterBase.Config memory) {
        return CcipAdapterBase.Config({
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
        });
    }

    function depositBatch(uint64 id, address user, uint256 amount) internal pure returns (bytes memory) {
        CascadeMessages.Entry[] memory d = new CascadeMessages.Entry[](1);
        d[0] = CascadeMessages.Entry(user, amount);
        return CascadeMessages.encodeBatch(id, d, new CascadeMessages.Entry[](0));
    }

    /// The CCIP message the OffRamp hands the adapter, naming `amount` of the bridged token.
    function ccip(address recipient, bytes memory message, uint256 amount)
        internal
        view
        returns (Client.Any2EVMMessage memory m)
    {
        Client.EVMTokenAmount[] memory t = new Client.EVMTokenAmount[](amount == 0 ? 0 : 1);
        if (amount != 0) t[0] = Client.EVMTokenAmount(address(taoBit), amount);
        m = Client.Any2EVMMessage({
            messageId: keccak256(abi.encode(recipient, frontDoor, message, amount)),
            sourceChainSelector: BASE_SELECTOR,
            sender: abi.encode(adapterBase),
            data: adapter.encodePayload(recipient, frontDoor, message),
            destTokenAmounts: t
        });
    }

    function keyOf(address recipient, bytes memory message) internal view returns (bytes32) {
        return keccak256(abi.encode(BASE, frontDoor, recipient, message));
    }

    /// A token park of the door's `message` to `recipient`, delivered honestly (the router releases the tokens) while
    /// ForeverMoney is halted, then the rail back.
    function tokenPark(address recipient, bytes memory message, uint256 amount) internal returns (bytes32 key) {
        av.adminHold(vm.getBlockTimestamp() + 3650 days);
        (bool called, bool ok,) = router.deliver(address(adapter), ccip(recipient, message, amount), 3_000_000);
        assertTrue(called && ok, "parked");
        av.unpause();
        key = keyOf(recipient, message);
        assertParked(key, amount, false);
    }

    function assertParked(bytes32 key, uint256 amount, bool converted) internal view {
        (uint128 a, uint64 parkedAt, bool c) = adapter.parked(key);
        assertEq(a, amount, "parked amount");
        assertTrue(parkedAt != 0, "a record");
        assertEq(c, converted, "converted");
    }

    function assertNotParked(bytes32 key) internal view {
        (, uint64 parkedAt,) = adapter.parked(key);
        assertEq(parkedAt, 0, "no record");
    }

    // ---- C-L1: only tokens that arrived ----

    /// A forged delivery (a compromised lane: the router names 1 TAO, and no token arrived) is refused ReserveShort
    /// before any conversion, beside another batch's 2 TAO token park and a funded cushion. Before R4 the conversion
    /// burned the park's tokens and minted for the forger. The park, both totals, the cushion, the adapter's balances,
    /// ForeverMoney's position and the vault are all as they were (I-7).
    function test_aForgedAmountWithNoTokensIsRefused() public {
        bytes32 other = tokenPark(address(vault), depositBatch(1, bob, 2e18), 2e18);
        fundCushion(taoBit, address(adapter), 1e15);
        uint256 stakedBefore = av.stakedValueRao(address(taoBit));
        bytes memory message = depositBatch(2, alice, 1e18);
        Client.Any2EVMMessage memory m = ccip(address(vault), message, 1e18);

        vm.expectRevert(CcipBittensorAdapter.ReserveShort.selector);
        vm.prank(address(router));
        adapter.ccipReceive(m);

        assertParked(other, 2e18, false);
        assertNotParked(keyOf(address(vault), message));
        assertEq(adapter.parkedTokens(), 2e18);
        assertEq(adapter.parkedNative(), 0);
        assertEq(taoBit.balanceOf(address(adapter)), 2e18 + 1e15, "the park's tokens and the cushion");
        assertEq(adapter.tokenCushion(), 1e15);
        assertEq(address(adapter).balance, RESERVE);
        assertEq(av.stakedValueRao(address(taoBit)), stakedBefore, "nothing withdrawn from ForeverMoney");
        assertEq(vault.balanceOf(alice), 0, "nothing minted");
        assertEq(address(vault).balance, RESERVE);
        assertOwed(adapter, taoBit);
    }

    /// F-1 (R4): the cushion is booked (`tokenCushion`, funded through `fundCushion`), and C-L1's check covers it: with a
    /// 0.001 TAO cushion beside a 2 TAO token park, a forged amount of 1 rao, of a sub-floor 0.0005 TAO, of exactly the
    /// cushion and of the cushion and a rao, none with tokens behind it, is each refused ReserveShort, and the park, the
    /// totals, the booked cushion and the balance are as they were.
    function test_aForgedAmountTakesNeitherAParkNorTheCushion() public {
        bytes32 other = tokenPark(address(vault), depositBatch(1, bob, 2e18), 2e18);
        fundCushion(taoBit, address(adapter), 1e15);
        assertEq(adapter.tokenCushion(), 1e15, "booked");
        uint256[4] memory amounts = [uint256(1e9), 5e14, 1e15, 1e15 + 1e9];
        for (uint256 i; i < amounts.length; ++i) {
            // casting to 'uint64' is safe because i is below 4
            // forge-lint: disable-next-line(unsafe-typecast)
            uint64 id = uint64(2 + i);
            Client.Any2EVMMessage memory m = ccip(address(vault), depositBatch(id, alice, amounts[i]), amounts[i]);
            vm.expectRevert(CcipBittensorAdapter.ReserveShort.selector);
            vm.prank(address(router));
            adapter.ccipReceive(m);
            assertParked(other, 2e18, false);
            assertEq(adapter.parkedTokens(), 2e18);
            assertEq(adapter.tokenCushion(), 1e15, "the cushion untouched");
            assertEq(taoBit.balanceOf(address(adapter)), 2e18 + 1e15);
        }
        assertOwed(adapter, taoBit);
    }

    /// How the cushion and the surplus are told apart (F-1): by the books, never the balance. A plain transfer of the
    /// token is surplus above the parks and the booked cushion: the sweep sends exactly it to the treasury and leaves the
    /// park and the cushion. Until it is swept a forged amount can take it, and only it (the treasury's, never a park or
    /// the cushion): one rao more than the surplus is refused.
    function test_thePlainTransferIsTheSweepsSurplusNotTheCushion() public {
        bytes32 other = tokenPark(address(vault), depositBatch(1, bob, 2e18), 2e18);
        fundCushion(taoBit, address(adapter), 1e15);
        taoBit.mint(address(this), 3e15);
        assertTrue(taoBit.transfer(address(adapter), 3e15));
        assertEq(adapter.tokenCushion(), 1e15, "a plain transfer books nothing");

        Client.Any2EVMMessage memory over = ccip(address(vault), depositBatch(2, alice, 3e15 + 1e9), 3e15 + 1e9);
        vm.expectRevert(CcipBittensorAdapter.ReserveShort.selector);
        vm.prank(address(router));
        adapter.ccipReceive(over);

        uint256 snap = vm.snapshotState();
        Client.Any2EVMMessage memory within = ccip(address(vault), depositBatch(3, alice, 3e15), 3e15);
        vm.prank(address(router));
        adapter.ccipReceive(within);
        assertParked(other, 2e18, false);
        assertEq(adapter.tokenCushion(), 1e15);
        assertEq(taoBit.balanceOf(address(adapter)), 2e18 + 1e15, "only the surplus spent");
        vm.revertToState(snap);

        uint256 treasuryBefore = taoBit.balanceOf(treasury);
        vm.prank(anyone);
        adapter.sweepSurplus();
        assertEq(taoBit.balanceOf(treasury), treasuryBefore + 3e15, "the sweep takes the surplus");
        assertEq(taoBit.balanceOf(address(adapter)), 2e18 + 1e15, "and leaves the park and the cushion");
        assertEq(adapter.tokenCushion(), 1e15);
        assertParked(other, 2e18, false);
    }

    /// F-3 (R4): convertExact refuses a conversion that burned more than its amount of the adapter's tokens (an under-burn
    /// is surplus: the vault-favour review). An AlphaVault that burns a rao more is refused (ConversionShort, its burn rolled back): an honest delivery beside another token park parks its
    /// own tokens instead of taking the rao from the other park, and deliverParked of a token park reverts with it
    /// unchanged. The cushion and the other park keep every token.
    function test_anAlphaVaultThatOverBurnsIsRefused() public {
        bytes memory otherMessage = depositBatch(1, bob, 2e18);
        bytes32 other = tokenPark(address(vault), otherMessage, 2e18);
        fundCushion(taoBit, address(adapter), 1e15);
        av.setOverburn(1e9);

        bytes memory message = depositBatch(2, alice, 1e18);
        Client.Any2EVMMessage memory m = ccip(address(vault), message, 1e18);
        vm.expectEmit(address(adapter));
        emit CcipBittensorAdapter.BatchParked(
            keyOf(address(vault), message),
            m.messageId,
            address(vault),
            frontDoor,
            1e18,
            false,
            CcipAdapterBase.ConversionShort.selector
        );
        (bool called, bool ok,) = router.deliver(address(adapter), m, 3_000_000);
        assertTrue(called && ok, "parked, not converted");
        assertEq(vault.balanceOf(alice), 0);
        assertEq(taoBit.balanceOf(address(adapter)), 3e18 + 1e15, "every token kept");

        vm.expectRevert(CcipAdapterBase.ConversionShort.selector);
        vm.prank(anyone);
        adapter.deliverParked(address(vault), frontDoor, otherMessage);
        assertParked(other, 2e18, false);
        assertEq(adapter.parkedTokens(), 3e18);
        assertEq(adapter.tokenCushion(), 1e15);
        assertOwed(adapter, taoBit);

        av.setOverburn(0);
        vm.prank(anyone);
        adapter.deliverParked(address(vault), frontDoor, otherMessage);
        assertNotParked(other);
    }

    /// F-5 (R4): a converted park's delivery and its refund spend only its own native TAO: with the native balance
    /// written 1 TAO below the books (a bookkeeping fault), deliverParked of the 2 TAO park and its refund each revert
    /// ReserveShort, both parks as they were, where before R4 either paid out the other park's TAO.
    function test_aConvertedParkSpendsOnlyItsOwnNativeTao() public {
        vm.prank(guardian);
        vault.pause();
        bytes memory message = depositBatch(1, alice, 2e18);
        (bool called, bool ok,) = router.deliver(address(adapter), ccip(address(vault), message, 2e18), 3_000_000);
        assertTrue(called && ok);
        (called, ok,) =
            router.deliver(address(adapter), ccip(address(vault), depositBatch(2, bob, 1e18), 1e18), 3_000_000);
        assertTrue(called && ok);
        bytes32 key = keyOf(address(vault), message);
        assertParked(key, 2e18, true);
        assertEq(adapter.parkedNative(), 3e18);
        vm.prank(owner);
        vault.unpause();
        vm.deal(address(adapter), 2e18);

        vm.expectRevert(CcipBittensorAdapter.ReserveShort.selector);
        vm.prank(anyone);
        adapter.deliverParked(address(vault), frontDoor, message);
        assertParked(key, 2e18, true);

        vm.warp(vm.getBlockTimestamp() + adapter.PARK_TIMEOUT());
        uint256 fee = adapter.quoteRefund(address(vault), frontDoor, message);
        vm.expectRevert(CcipBittensorAdapter.ReserveShort.selector);
        vm.prank(anyone);
        adapter.refundParked{value: fee}(address(vault), frontDoor, message);
        assertParked(key, 2e18, true);
        assertEq(adapter.parkedNative(), 3e18);
    }

    /// deliverParked converts a token park only while the token balance covers the other token parks and its own: with
    /// the balance written 1 TAO below the books (a bookkeeping fault), the 2 TAO park's delivery reverts ReserveShort
    /// and both parks stay as they were, where before R4 it burned the other park's tokens. With the books covered it
    /// converts and delivers.
    function test_deliverParkedRefusesAParkTheTokensDoNotCover() public {
        bytes memory message = depositBatch(1, alice, 2e18);
        bytes32 key = tokenPark(address(vault), message, 2e18);
        bytes32 other = tokenPark(address(vault), depositBatch(2, bob, 1e18), 1e18);
        deal(address(taoBit), address(adapter), 2e18);

        vm.expectRevert(CcipBittensorAdapter.ReserveShort.selector);
        vm.prank(anyone);
        adapter.deliverParked(address(vault), frontDoor, message);
        assertParked(key, 2e18, false);
        assertParked(other, 1e18, false);
        assertEq(adapter.parkedTokens(), 3e18);

        deal(address(taoBit), address(adapter), 3e18);
        vm.prank(anyone);
        adapter.deliverParked(address(vault), frontDoor, message);
        assertNotParked(key);
        assertEq(vault.balanceOf(alice), 2e24, "delivered");
        assertOwed(adapter, taoBit);
    }

    /// An unconverted park's refund sends its tokens only while the balance covers the other token parks and its own:
    /// with the balance 1 TAO below the books it reverts ReserveShort, where before R4 the refund took the other park's
    /// tokens. Covered, it refunds.
    function test_anUnconvertedRefundTheTokensDoNotCoverIsRefused() public {
        bytes memory message = depositBatch(1, alice, 2e18);
        bytes32 key = tokenPark(address(vault), message, 2e18);
        bytes32 other = tokenPark(address(vault), depositBatch(2, bob, 1e18), 1e18);
        vm.warp(vm.getBlockTimestamp() + adapter.PARK_TIMEOUT());
        uint256 fee = adapter.quoteRefund(address(vault), frontDoor, message);
        deal(address(taoBit), address(adapter), 2e18);

        vm.expectRevert(CcipBittensorAdapter.ReserveShort.selector);
        vm.prank(anyone);
        adapter.refundParked{value: fee}(address(vault), frontDoor, message);
        assertParked(key, 2e18, false);
        assertParked(other, 1e18, false);

        deal(address(taoBit), address(adapter), 3e18);
        vm.prank(anyone);
        adapter.refundParked{value: fee}(address(vault), frontDoor, message);
        assertNotParked(key);
        assertEq(taoBit.balanceOf(address(adapter)), 1e18, "the other park's tokens stay");
        assertOwed(adapter, taoBit);
    }

    // ---- the parked delivery's gas ----

    /// The constructor holds the inbound pair to the base's own model checks: within GAS_CAP at 2 × MAX_ENTRIES
    /// entries, and not both 0. Both are served, and parkedDeliveryGas is PARK_GAS_RESERVE plus the model for the
    /// message's own entries (GAS_CAP for a message that does not parse).
    function test_theInboundModelIsCheckedAndServed() public {
        vm.expectRevert(CcipAdapterBase.GasModelTooLarge.selector);
        new CcipBittensorAdapter(config(), IAlphaVault(address(av)), 6_000_001, 10_000);
        vm.expectRevert(InvalidParameter.selector);
        new CcipBittensorAdapter(config(), IAlphaVault(address(av)), 0, 0);
        new CcipBittensorAdapter(config(), IAlphaVault(address(av)), 6_000_000, 10_000);
        // the pair includes PARK_GAS_RESERVE (the R4 review), so its base must exceed it
        uint256 reserve = adapter.PARK_GAS_RESERVE();
        vm.expectRevert(InvalidParameter.selector);
        new CcipBittensorAdapter(config(), IAlphaVault(address(av)), reserve, 10_000);
        new CcipBittensorAdapter(config(), IAlphaVault(address(av)), reserve + 1, 10_000);

        assertEq(adapter.inboundGasBase(), INBOUND_BASE);
        assertEq(adapter.inboundGasPerEntry(), INBOUND_PER_ENTRY);
        // the reserve counted once, in the pair: the requirement is the model alone
        assertEq(adapter.parkedDeliveryGas(depositBatch(1, alice, 1e18)), INBOUND_BASE + INBOUND_PER_ENTRY);
        CascadeMessages.Entry[] memory two = new CascadeMessages.Entry[](2);
        two[0] = CascadeMessages.Entry(alice, 1e18);
        two[1] = CascadeMessages.Entry(bob, 1e18);
        assertEq(
            adapter.parkedDeliveryGas(CascadeMessages.encodeBatch(1, two, two)), INBOUND_BASE + 4 * INBOUND_PER_ENTRY
        );
        assertEq(adapter.parkedDeliveryGas(hex"01"), adapter.GAS_CAP());
    }

    /// Sent with its requirement as the whole call's gas limit, deliverParked cannot keep it at the recipient's call
    /// (the conversion and the lock come first): it reverts InsufficientGas, and the token park is exactly as it was,
    /// still tokens. Before R4 that call converted the park and handed the vault what was left.
    function test_deliverParkedBelowItsRequirementRevertsWithTheParkUnchanged() public {
        bytes memory message = depositBatch(1, alice, 10e18);
        bytes32 key = tokenPark(address(vault), message, 10e18);
        (, uint64 since,) = adapter.parked(key);
        uint256 stakedBefore = av.stakedValueRao(address(taoBit));
        uint256 need = adapter.parkedDeliveryGas(message);

        vm.expectRevert(InsufficientGas.selector);
        vm.prank(anyone);
        adapter.deliverParked{gas: need}(address(vault), frontDoor, message);

        (uint128 a, uint64 parkedAt, bool c) = adapter.parked(key);
        assertEq(a, 10e18);
        assertEq(parkedAt, since, "parkedAt kept");
        assertFalse(c, "still tokens");
        assertEq(adapter.parkedTokens(), 10e18);
        assertEq(adapter.parkedNative(), 0);
        assertEq(taoBit.balanceOf(address(adapter)), 10e18);
        assertEq(av.stakedValueRao(address(taoBit)), stakedBefore, "no conversion");
        assertEq(vault.balanceOf(alice), 0);
    }

    /// No gas limit makes deliverParked re-park a recipient for want of gas (R4): over a recipient that accepts only
    /// with what a CCIP delivery's recipient call can be given (the lane's inbound model less PARK_GAS_RESERVE), less
    /// 10,000 for the call's own overhead, left on entry, a token park's delivery either reverts whole (below the
    /// requirement: InsufficientGas, or out of gas sooner) or delivers, never converts and re-parks. The least gas limit
    /// that does not revert, found by bisection, delivers, and so does every limit from it in 1,000-gas steps over the
    /// next 100,000; one gas below it reverts with the park unchanged. Each call starts cold, as a transaction of its own.
    function test_noGasLimitReParksForWantOfGas() public {
        assertNoLimitReParks(depositBatch(1, alice, 10e18));
    }

    /// The same at the largest legal batch, 50 + 50 (the R4 review, Minor 9), where the message's copy and the 63/64
    /// margin are largest.
    function test_noGasLimitReParksForWantOfGasAt50Plus50() public {
        CascadeMessages.Entry[] memory d = new CascadeMessages.Entry[](50);
        CascadeMessages.Entry[] memory r = new CascadeMessages.Entry[](50);
        for (uint256 i; i < 50; ++i) {
            d[i] = CascadeMessages.Entry(address(uint160(0x5000 + i)), 0.2e18);
            r[i] = CascadeMessages.Entry(address(uint160(0x6000 + i)), 1e24);
        }
        bytes memory message = CascadeMessages.encodeBatch(1, d, r);
        assertEq(adapter.parkedDeliveryGas(message), INBOUND_BASE + 100 * INBOUND_PER_ENTRY);
        assertNoLimitReParks(message);
    }

    /// The bisection of test_noGasLimitReParksForWantOfGas over the token park of `message` (10 TAO) to a recipient that
    /// needs the model less PARK_GAS_RESERVE and 10,000.
    function assertNoLimitReParks(bytes memory message) internal {
        uint256 given = adapter.parkedDeliveryGas(message) - adapter.PARK_GAS_RESERVE();
        GasHungryReceiver hungry = new GasHungryReceiver(given - 10_000);
        bytes32 key = tokenPark(address(hungry), message, 10e18);

        uint256 lo = 21_000;
        uint256 hi = 20_000_000;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            (bool ok,) = tryDeliver(address(hungry), message, mid);
            if (ok) hi = mid;
            else lo = mid + 1;
        }
        for (uint256 g = lo; g < lo + 100_000; g += 1_000) {
            (bool ok, bool delivered) = tryDeliver(address(hungry), message, g);
            assertTrue(ok, "a limit above the least succeeds");
            assertTrue(delivered, string.concat("delivered, never re-parked, at ", vm.toString(g)));
        }
        (bool okBelow,) = tryDeliver(address(hungry), message, lo - 1);
        assertFalse(okBelow, "one gas below the least reverts");
        assertParked(key, 10e18, false);
        emit log_named_uint("the least gas limit that delivers", lo);
        emit log_named_uint("parkedDeliveryGas", adapter.parkedDeliveryGas(message));
    }

    /// deliverParked of the park of `message` to `recipient` with exactly `limit` gas, cold, from a snapshot it reverts
    /// to: whether the call succeeded, and whether it delivered (the record gone and the recipient paid).
    function tryDeliver(address recipient, bytes memory message, uint256 limit)
        internal
        returns (bool ok, bool delivered)
    {
        uint256 snap = vm.snapshotState();
        vm.cool(address(adapter));
        vm.cool(address(taoBit));
        vm.cool(address(av));
        vm.cool(recipient);
        try adapter.deliverParked{gas: limit}(recipient, frontDoor, message) {
            ok = true;
            (, uint64 parkedAt,) = adapter.parked(keyOf(recipient, message));
            delivered = parkedAt == 0 && recipient.balance == 10e18;
        } catch {}
        vm.revertToState(snap);
    }
}
