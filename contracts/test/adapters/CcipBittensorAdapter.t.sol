// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CcipAdapterBase} from "../../src/adapters/CcipAdapterBase.sol";
import {CcipBittensorAdapter} from "../../src/adapters/CcipBittensorAdapter.sol";
import {IAlphaVault} from "../../src/interfaces/IAlphaVault.sol";
import {ICascadeBridge} from "../../src/interfaces/ICascadeBridge.sol";
import {ADDRESS_MAPPING_ADDRESS} from "../../src/interfaces/IAddressMapping.sol";
import {ISTAKING_ADDRESS} from "../../src/interfaces/IStaking.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {Client} from "../../src/vendor/ccip/Client.sol";
import {MockAddressMapping} from "../mocks/MockAddressMapping.sol";
import {MockAlphaVault} from "../mocks/MockAlphaVault.sol";
import {MockRouter} from "../mocks/MockRouter.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {MockTAO} from "../mocks/MockTAO.sol";
import {mirror} from "../mocks/Mirror.sol";

contract CcipBittensorAdapterTest is Test {
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
    CascadeVault vault;

    address adapterBase = makeAddr("adapterBase");
    address frontDoor = makeAddr("frontDoor");
    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address alice = makeAddr("alice");

    function setUp() public {
        vm.etch(ISTAKING_ADDRESS, address(new MockStaking()).code);
        vm.etch(ADDRESS_MAPPING_ADDRESS, address(new MockAddressMapping()).code);
        staking.addHotkey(bytes32(uint256(1)));

        taoBit = new MockTAO(18);
        router = new MockRouter(taoBit);
        router.setFee(FEE);
        av = new MockAlphaVault(taoBit);
        vm.deal(address(av), 1_000e18);

        uint256 nonce = vm.getNonce(address(this));
        address predictedAdapter = vm.computeCreateAddress(address(this), nonce);
        address predictedVault = vm.computeCreateAddress(address(this), nonce + 1);

        adapter = new CcipBittensorAdapter(
            CcipAdapterBase.Config({
                router: address(router),
                token: address(taoBit),
                localChainId: 964,
                remoteChainId: BASE,
                remoteSelector: BASE_SELECTOR,
                remoteAdapter: adapterBase,
                gasBase: 1_000_000,
                gasPerEntry: 25_000
            }),
            IAlphaVault(address(av))
        );
        vault = new CascadeVault(
            mirror(predictedVault), bytes32(uint256(1)), ICascadeBridge(address(adapter)), owner, guardian, 1e15
        );
        assertEq(address(adapter), predictedAdapter);
        assertEq(address(vault), predictedVault);

        vm.deal(address(vault), RESERVE);
        vm.prank(owner);
        vault.proposeFrontDoor(BASE, frontDoor);
        vm.warp(block.timestamp + 7 days);
        vm.prank(owner);
        vault.activateFrontDoor(BASE, frontDoor);

        adapter.fundReserve{value: RESERVE}();
    }

    // ---- helpers ----

    function _batch(uint256 amount) internal view returns (bytes memory) {
        CascadeMessages.Entry[] memory deposits = new CascadeMessages.Entry[](1);
        deposits[0] = CascadeMessages.Entry(alice, amount);
        return CascadeMessages.encodeBatch(1, deposits, new CascadeMessages.Entry[](0));
    }

    /// An inbound BATCH from the Base front door; `tokenAmount` is what CCIP delivers (if `withToken`),
    /// `batchSum` what the batch claims.
    function _incoming(uint256 tokenAmount, uint256 batchSum, bool withToken)
        internal
        view
        returns (Client.Any2EVMMessage memory m)
    {
        Client.EVMTokenAmount[] memory t;
        if (withToken) {
            t = new Client.EVMTokenAmount[](1);
            t[0] = Client.EVMTokenAmount(address(taoBit), tokenAmount);
        } else {
            t = new Client.EVMTokenAmount[](0);
        }
        m = Client.Any2EVMMessage({
            messageId: bytes32(uint256(9)),
            sourceChainSelector: BASE_SELECTOR,
            sender: abi.encode(adapterBase),
            data: adapter.encodePayload(address(vault), frontDoor, _batch(batchSum)),
            destTokenAmounts: t
        });
    }

    /// The adapter's own revert data, unwrapped from the router's DeliveryFailed(bytes).
    function _inner(bytes memory reason) internal pure returns (bytes memory inner) {
        bytes memory body = new bytes(reason.length - 4);
        for (uint256 i; i < body.length; ++i) {
            body[i] = reason[i + 4];
        }
        inner = abi.decode(body, (bytes));
    }

    function _send(uint256 amount, uint256 value) internal {
        adapter.send{value: value}(BASE, frontDoor, "", amount);
    }

    // ---- floor ----

    function test_floor_readsPrecompile() public {
        assertEq(adapter.floor(), 2e15);
        staking.setMinStake(5_000_000);
        assertEq(adapter.floor(), 5e15);
    }

    // ---- send ----

    function test_send_belowFloorReverts() public {
        bytes memory err = abi.encodeWithSelector(CcipAdapterBase.BelowConversionFloor.selector, 1e15, 2e15);
        vm.expectRevert(err);
        adapter.quoteFee(BASE, frontDoor, "", 1e15);
        vm.expectRevert(err);
        _send(1e15, 1e15 + FEE);
    }

    function test_send_budgetMustCoverAmountPlusFee() public {
        vm.expectRevert(CcipAdapterBase.InsufficientFee.selector);
        _send(1e18, 1e18 + FEE - 1);
        vm.expectRevert(CcipAdapterBase.InsufficientFee.selector);
        _send(1e18, 1e18 - 1);
    }

    function test_send_convertsThroughAlphaVaultAndSendsToken() public {
        uint256 avBefore = address(av).balance;
        _send(1e18, 1e18 + FEE + 7);
        assertEq(taoBit.balanceOf(address(router)), 1e18);
        assertEq(taoBit.balanceOf(address(adapter)), 0);
        assertEq(taoBit.allowance(address(adapter), address(router)), 0);
        assertEq(address(av).balance - avBefore, 1e18);
        assertEq(address(router).balance, FEE);
        assertEq(address(adapter).balance, RESERVE + 7);
        assertEq(router.lastSend().tokenAmounts[0].amount, 1e18);
    }

    function test_send_notRaoAlignedReverts() public {
        vm.expectRevert(CcipAdapterBase.NotRaoAligned.selector);
        _send(1e18 + 1, 1e18 + 1 + FEE);
    }

    function test_send_conversionShortReverts() public {
        av.setShortBy(1);
        vm.expectRevert(CcipAdapterBase.ConversionShort.selector);
        _send(1e18, 1e18 + FEE);
    }

    function test_send_pausedAlphaVaultReverts() public {
        av.setPaused(true);
        vm.expectRevert(MockAlphaVault.Halted.selector);
        _send(1e18, 1e18 + FEE);
    }

    // ---- ccipReceive ----

    function test_ccipReceive_convertsAndDeliversNativeToVault() public {
        (bool called, bool ok,) = router.deliver(address(adapter), _incoming(1e18, 1e18, true), GAS);
        assertTrue(called);
        assertTrue(ok);
        assertGt(vault.balanceOf(alice), 0);
        assertEq(taoBit.balanceOf(address(adapter)), 0);
        assertEq(address(adapter).balance, RESERVE);
    }

    function test_ccipReceive_belowFloorReverts() public {
        (, bool ok, bytes memory reason) = router.deliver(address(adapter), _incoming(1e15, 1e15, true), GAS);
        assertFalse(ok);
        assertEq(_inner(reason), abi.encodeWithSelector(CcipAdapterBase.BelowConversionFloor.selector, 1e15, 2e15));
    }

    function test_ccipReceive_noTokensWithNonZeroBatchFailsAtVault() public {
        (bool called, bool ok, bytes memory reason) = router.deliver(address(adapter), _incoming(0, 1e18, false), GAS);
        assertTrue(called);
        assertFalse(ok);
        assertEq(bytes4(_inner(reason)), CascadeVault.AmountMismatch.selector);
        assertEq(vault.balanceOf(alice), 0);
        assertEq(address(adapter).balance, RESERVE);
        assertEq(taoBit.balanceOf(address(adapter)), 0);
    }

    function test_ccipReceive_overpaymentStaysInAdapter() public {
        av.setOverpay(5);
        uint256 supplyBefore = vault.totalSupply();
        (, bool ok,) = router.deliver(address(adapter), _incoming(1e18, 1e18, true), GAS);
        assertTrue(ok);
        assertGt(vault.totalSupply(), supplyBefore);
        assertEq(address(adapter).balance, RESERVE + 5);
    }

    function test_ccipReceive_shortPaymentReverts() public {
        av.setShortBy(1);
        (, bool ok, bytes memory reason) = router.deliver(address(adapter), _incoming(1e18, 1e18, true), GAS);
        assertFalse(ok);
        assertEq(bytes4(_inner(reason)), CcipAdapterBase.ConversionShort.selector);
    }

    function test_ccipReceive_vaultPausedIsAtomic() public {
        vm.prank(guardian);
        vault.pause();
        uint256 avBefore = address(av).balance;
        (bool called, bool ok,) = router.deliver(address(adapter), _incoming(1e18, 1e18, true), GAS);
        assertTrue(called);
        assertFalse(ok);
        assertEq(taoBit.balanceOf(address(adapter)), 0);
        assertEq(address(adapter).balance, RESERVE);
        assertEq(address(av).balance, avBefore);
    }

    // ---- native value and reserve ----

    function test_receive_rejectsStrangers() public {
        (bool ok, bytes memory ret) = address(adapter).call{value: 1}("");
        assertFalse(ok);
        assertEq(bytes4(ret), CcipAdapterBase.UnexpectedValue.selector);
    }

    function test_fundReserve_isNeverSpent() public {
        vm.expectEmit(true, false, false, true, address(adapter));
        emit CcipBittensorAdapter.ReserveFunded(address(this), 5);
        adapter.fundReserve{value: 5}();

        _send(1e18, 1e18 + FEE);
        assertGe(address(adapter).balance, RESERVE + 5);
        (, bool ok,) = router.deliver(address(adapter), _incoming(1e18, 1e18, true), GAS);
        assertTrue(ok);
        assertGe(address(adapter).balance, RESERVE + 5);
    }

    receive() external payable {}
}
