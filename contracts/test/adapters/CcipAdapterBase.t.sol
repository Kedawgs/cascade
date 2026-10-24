// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {CcipAdapterBase} from "../../src/adapters/CcipAdapterBase.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {Client} from "../../src/vendor/ccip/Client.sol";
import {MockTAO} from "../mocks/MockTAO.sol";
import {AdapterHarness} from "./AdapterHarness.sol";

/// @dev Fee is `baseFee + gasLimit` wei so different message sizes quote differently.
contract FakeRouter {
    uint256 public baseFee = 1e15;

    uint64 public lastSelector;
    bytes public lastReceiver;
    bytes public lastData;
    Client.EVMTokenAmount[] internal _lastTokens;
    address public lastFeeToken;
    bytes public lastExtraArgs;
    uint256 public lastValue;
    uint256 public sends;

    function setBaseFee(uint256 f) external {
        baseFee = f;
    }

    function lastTokens() external view returns (Client.EVMTokenAmount[] memory) {
        return _lastTokens;
    }

    /// @dev The gas limit is the uint32 right after the 4-byte tag of the V3 extraArgs.
    function getFee(uint64, Client.EVM2AnyMessage memory m) external view returns (uint256) {
        bytes memory a = m.extraArgs;
        uint256 gasLimit = (uint256(uint8(a[4])) << 24) | (uint256(uint8(a[5])) << 16) | (uint256(uint8(a[6])) << 8)
            | uint256(uint8(a[7]));
        return baseFee + gasLimit;
    }

    function ccipSend(uint64 selector, Client.EVM2AnyMessage calldata m) external payable returns (bytes32) {
        lastSelector = selector;
        lastReceiver = m.receiver;
        lastData = m.data;
        delete _lastTokens;
        for (uint256 i; i < m.tokenAmounts.length; i++) {
            _lastTokens.push(m.tokenAmounts[i]);
            require(MockTAO(m.tokenAmounts[i].token).transferFrom(msg.sender, address(this), m.tokenAmounts[i].amount));
        }
        lastFeeToken = m.feeToken;
        lastExtraArgs = m.extraArgs;
        lastValue = msg.value;
        sends++;
        return keccak256(abi.encode("id", sends));
    }
}

contract CcipAdapterBaseTest is Test {
    AdapterHarness h;
    FakeRouter fakeRouter;
    MockTAO tao;
    address frontDoor = makeAddr("frontDoor");
    address recipient = makeAddr("recipient");
    address stranger = makeAddr("stranger");
    uint256 previousQuote;

    function setUp() public {
        fakeRouter = new FakeRouter();
        tao = new MockTAO(18);
        CcipAdapterBase.Config memory c = cfgWith(1_000_000, 25_000);
        c.router = address(fakeRouter);
        c.token = address(tao);
        h = new AdapterHarness(c);
        tao.mint(frontDoor, 1_000_000e18);
        vm.deal(frontDoor, 10 ether);
        vm.prank(frontDoor);
        tao.approve(address(h), type(uint256).max);
    }

    function cfgWith(uint256 base, uint256 perEntry) internal returns (CcipAdapterBase.Config memory) {
        return CcipAdapterBase.Config({
            router: makeAddr("router"),
            token: makeAddr("token"),
            localChainId: 8453,
            remoteChainId: 964,
            remoteSelector: 2135107236357186872,
            remoteAdapter: makeAddr("remoteAdapter"),
            gasBase: base,
            gasPerEntry: perEntry
        });
    }

    function cfgWithRouter(address router) internal returns (CcipAdapterBase.Config memory c) {
        c = cfgWith(1_000_000, 25_000);
        c.router = router;
    }

    function cfgWithChains(uint64 local, uint64 remote) internal returns (CcipAdapterBase.Config memory c) {
        c = cfgWith(1_000_000, 25_000);
        c.localChainId = local;
        c.remoteChainId = remote;
    }

    function entries(uint256 n) internal pure returns (CascadeMessages.Entry[] memory e) {
        e = new CascadeMessages.Entry[](n);
        for (uint256 i; i < n; i++) {
            e[i] = CascadeMessages.Entry(address(uint160(i + 1)), 1e9);
        }
    }

    function test_extraArgs_is19BytesV3() public view {
        // tag || uint32 1_500_000 || bytes4 finality 0 || 7 zero bytes
        assertEq(h.extraArgs(1_500_000), hex"a69dd4aa" hex"0016e360" hex"00000000" hex"00000000000000");
        assertEq(h.extraArgs(1_500_000).length, 19);
    }

    function test_gasFor_batchCountsDepositsAndRedeems() public view {
        assertEq(h.gasFor(CascadeMessages.encodeBatch(1, entries(1), entries(0))), 1_025_000);
        assertEq(h.gasFor(CascadeMessages.encodeBatch(1, entries(100), entries(100))), 6_000_000);
        assertEq(h.gasFor(CascadeMessages.encodeBatch(1, entries(0), entries(0))), 1_000_000);
    }

    function test_gasFor_payoutsCountsEntries() public view {
        assertEq(h.gasFor(CascadeMessages.encodePayouts(bytes32(0), 0, entries(50))), 2_250_000);
    }

    function test_gasFor_capsAtGasCap() public {
        AdapterHarness big = new AdapterHarness(cfgWith(6_000_000, 5_000)); // 6_000_000 + 200 * 5_000 == cap
        assertEq(big.gasFor(CascadeMessages.encodeBatch(1, entries(100), entries(100))), 7_000_000);
    }

    function test_gasFor_malformedMessageQuotesCap() public view {
        assertEq(h.gasFor(hex"01"), 7_000_000); // not a multiple of 32
        assertEq(h.gasFor(abi.encode(uint8(7), uint64(1))), 7_000_000); // unknown kind
    }

    function test_payload_roundTrip() public view {
        bytes memory m = CascadeMessages.encodeBatch(9, entries(2), entries(1));
        (address r, address s, bytes memory out) = h.decodePayload(h.encodePayload(address(0xA), address(0xB), m));
        assertEq(r, address(0xA));
        assertEq(s, address(0xB));
        assertEq(out, m);
    }

    function test_supportsInterface() public view {
        assertTrue(h.supportsInterface(0x85572ffb));
        assertTrue(h.supportsInterface(0x01ffc9a7));
        assertFalse(h.supportsInterface(0xffffffff));
        assertFalse(
            h.supportsInterface(bytes4(0x85572ffb) ^ bytes4(keccak256("getCCVsAndFinalityConfig(uint64,bytes)")))
        );
    }

    function test_constructor_rejections() public {
        CcipAdapterBase.Config memory c = cfgWithRouter(address(0));
        vm.expectRevert(CcipAdapterBase.ZeroAddress.selector);
        new AdapterHarness(c);
        c = cfgWithChains(964, 964);
        vm.expectRevert(CcipAdapterBase.SameChain.selector);
        new AdapterHarness(c);
        c = cfgWith(6_000_001, 5_000);
        vm.expectRevert(CcipAdapterBase.GasModelTooLarge.selector);
        new AdapterHarness(c);
    }

    // ---- send ----

    function oneEntryBatch() internal pure returns (bytes memory) {
        return CascadeMessages.encodeBatch(1, entries(1), entries(0));
    }

    function test_send_buildsExactCcipMessage() public {
        bytes memory message = oneEntryBatch();
        uint256 fee = h.quoteFee(964, recipient, message, 3e18);
        vm.prank(frontDoor);
        h.send{value: fee}(964, recipient, message, 3e18);

        assertEq(fakeRouter.lastSelector(), 2135107236357186872);
        assertEq(fakeRouter.lastReceiver(), abi.encode(h.remoteAdapter()));
        assertEq(fakeRouter.lastData(), h.encodePayload(recipient, frontDoor, message));
        Client.EVMTokenAmount[] memory t = fakeRouter.lastTokens();
        assertEq(t.length, 1);
        assertEq(t[0].token, address(tao));
        assertEq(t[0].amount, 3e18);
        assertEq(fakeRouter.lastFeeToken(), address(0));
        assertEq(fakeRouter.lastExtraArgs(), h.extraArgs(1_025_000));
        assertEq(fakeRouter.lastValue(), fee);
        assertEq(tao.balanceOf(address(fakeRouter)), 3e18);
        assertEq(tao.allowance(address(h), address(fakeRouter)), 0);
    }

    function test_send_zeroAmountSendsNoToken() public {
        vm.prank(frontDoor);
        h.send{value: 2e15}(964, recipient, oneEntryBatch(), 0);
        assertEq(fakeRouter.sends(), 1);
        assertEq(fakeRouter.lastTokens().length, 0);
        assertEq(tao.balanceOf(address(fakeRouter)), 0);
        assertEq(tao.balanceOf(frontDoor), 1_000_000e18);
    }

    function test_send_wrongDestinationReverts() public {
        vm.prank(frontDoor);
        vm.expectRevert(CcipAdapterBase.WrongDestination.selector);
        h.send{value: 2e15}(1, recipient, oneEntryBatch(), 1e18);
    }

    function test_send_zeroRecipientReverts() public {
        vm.prank(frontDoor);
        vm.expectRevert(CcipAdapterBase.ZeroAddress.selector);
        h.send{value: 2e15}(964, address(0), oneEntryBatch(), 1e18);
    }

    function test_send_overCapacityReverts() public {
        bytes memory message = oneEntryBatch();
        vm.prank(frontDoor);
        vm.expectRevert(CcipAdapterBase.MessageTooLarge.selector);
        h.send{value: 2e15}(964, recipient, message, 5_000e18 + 1);

        vm.prank(frontDoor);
        h.send{value: 2e15}(964, recipient, message, 5_000e18);
        assertEq(fakeRouter.sends(), 1);
    }

    function test_send_insufficientFeeReverts() public {
        bytes memory message = oneEntryBatch();
        fakeRouter.setBaseFee(1e15 - 1_025_000); // fee is exactly 1e15 for a one-entry batch
        vm.prank(frontDoor);
        vm.expectRevert(CcipAdapterBase.InsufficientFee.selector);
        h.send{value: 1e15 - 1}(964, recipient, message, 3e18);

        vm.prank(frontDoor);
        h.send{value: 1e15}(964, recipient, message, 3e18);
        assertEq(fakeRouter.lastValue(), 1e15);
    }

    function test_send_keepsExcessAndEmits() public {
        bytes memory message = oneEntryBatch();
        fakeRouter.setBaseFee(1e15 - 1_025_000);
        uint256 balanceBefore = frontDoor.balance;
        vm.expectEmit(true, true, true, true, address(h));
        emit CcipAdapterBase.Sent(
            keccak256(abi.encode("id", uint256(1))), 964, frontDoor, recipient, 3e18, 1e15, 1_025_000
        );
        vm.prank(frontDoor);
        h.send{value: 5e15}(964, recipient, message, 3e18);

        assertEq(fakeRouter.lastValue(), 1e15);
        assertEq(address(h).balance, 4e15);
        assertEq(frontDoor.balance, balanceBefore - 5e15);
    }

    function test_quoteFee_equalsFeePaid() public {
        uint256[4] memory sizes = [uint256(0), 1, 50, 100];
        for (uint256 i; i < sizes.length; i++) {
            uint256 n = sizes[i];
            bytes memory message = CascadeMessages.encodeBatch(1, entries(n), entries(n == 100 ? 100 : 0));
            uint256 quote = h.quoteFee(964, recipient, message, 1e18);
            vm.prank(frontDoor);
            h.send{value: quote}(964, recipient, message, 1e18);
            assertEq(fakeRouter.lastValue(), quote);
            if (i > 0) assertGt(quote, previousQuote);
            previousQuote = quote;
        }
    }

    function test_quoteFee_independentOfCaller() public {
        bytes memory message = oneEntryBatch();
        uint256 asFrontDoor = h.quoteFee(964, recipient, message, 3e18);
        vm.prank(stranger);
        assertEq(h.quoteFee(964, recipient, message, 3e18), asFrontDoor);
    }

    // ---- ccipReceive ----

    function oneToken(address t, uint256 amount) internal pure returns (Client.EVMTokenAmount[] memory a) {
        a = new Client.EVMTokenAmount[](1);
        a[0] = Client.EVMTokenAmount(t, amount);
    }

    function goodMessage(uint256 amount) internal view returns (Client.Any2EVMMessage memory) {
        return Client.Any2EVMMessage({
            messageId: keccak256("incoming"),
            sourceChainSelector: 2135107236357186872,
            sender: abi.encode(h.remoteAdapter()),
            data: h.encodePayload(recipient, frontDoor, hex"aa"),
            destTokenAmounts: amount == 0 ? new Client.EVMTokenAmount[](0) : oneToken(address(tao), amount)
        });
    }

    function test_ccipReceive_notRouterReverts() public {
        Client.Any2EVMMessage memory m = goodMessage(1e18);
        vm.prank(stranger);
        vm.expectRevert(CcipAdapterBase.NotRouter.selector);
        h.ccipReceive(m);
    }

    function test_ccipReceive_wrongSourceReverts() public {
        Client.Any2EVMMessage memory m = goodMessage(1e18);
        m.sourceChainSelector = 1;
        vm.prank(address(fakeRouter));
        vm.expectRevert(CcipAdapterBase.WrongSource.selector);
        h.ccipReceive(m);
    }

    function test_ccipReceive_rejectsUnpaddedSender() public {
        Client.Any2EVMMessage memory m = goodMessage(1e18);
        m.sender = abi.encodePacked(h.remoteAdapter());
        vm.prank(address(fakeRouter));
        vm.expectRevert(CcipAdapterBase.WrongSender.selector);
        h.ccipReceive(m);
    }

    function test_ccipReceive_rejectsOtherSender() public {
        Client.Any2EVMMessage memory m = goodMessage(1e18);
        m.sender = abi.encode(stranger);
        vm.prank(address(fakeRouter));
        vm.expectRevert(CcipAdapterBase.WrongSender.selector);
        h.ccipReceive(m);
    }

    function test_ccipReceive_wrongTokenReverts() public {
        Client.Any2EVMMessage memory m = goodMessage(1e18);
        m.destTokenAmounts = oneToken(stranger, 1e18);
        vm.prank(address(fakeRouter));
        vm.expectRevert(CcipAdapterBase.WrongToken.selector);
        h.ccipReceive(m);
    }

    function test_ccipReceive_twoTokensReverts() public {
        Client.Any2EVMMessage memory m = goodMessage(1e18);
        m.destTokenAmounts = new Client.EVMTokenAmount[](2);
        m.destTokenAmounts[0] = Client.EVMTokenAmount(address(tao), 1e18);
        m.destTokenAmounts[1] = Client.EVMTokenAmount(address(tao), 1e18);
        vm.prank(address(fakeRouter));
        vm.expectRevert(CcipAdapterBase.TooManyTokens.selector);
        h.ccipReceive(m);
    }

    function test_ccipReceive_deliversDecodedPayload() public {
        Client.Any2EVMMessage memory m = goodMessage(7e18);
        vm.expectEmit(true, true, true, true, address(h));
        emit CcipAdapterBase.Delivered(keccak256("incoming"), 964, frontDoor, recipient, 7e18);
        vm.prank(address(fakeRouter));
        h.ccipReceive(m);

        assertEq(h.lastRecipient(), recipient);
        assertEq(h.lastSender(), frontDoor);
        assertEq(h.lastMessage(), hex"aa");
        assertEq(h.lastAmount(), 7e18);
        assertEq(h.deliveries(), 1);
    }

    function test_ccipReceive_noTokensDeliversZero() public {
        Client.Any2EVMMessage memory m = goodMessage(0);
        vm.prank(address(fakeRouter));
        h.ccipReceive(m);
        assertEq(h.lastAmount(), 0);
        assertEq(h.deliveries(), 1);
    }
}
