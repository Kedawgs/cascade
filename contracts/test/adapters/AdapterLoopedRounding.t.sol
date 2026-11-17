// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CcipAdapterBase} from "../../src/adapters/CcipAdapterBase.sol";
import {CcipBaseAdapter} from "../../src/adapters/CcipBaseAdapter.sol";
import {CcipBittensorAdapter} from "../../src/adapters/CcipBittensorAdapter.sol";
import {ICascadeReceiver} from "../../src/interfaces/ICascadeBridge.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {AdaptersFixture} from "./AdaptersFixture.sol";
import {CushionHelpers} from "./CushionHelpers.sol";

/// Test only: a stranger looping value through the adapter pair, its own recipient on both chains (anyone may send
/// through either adapter and name any recipient). On Base it sends bridged TAO to itself on Bittensor in a well-formed
/// BATCH of one deposit (the Bittensor adapter delivers only that), which arrives as native TAO; on Bittensor it sends
/// that native TAO back to itself on Base, which arrives as bridged TAO. It accepts every delivery and pays every fee
/// from its own native balance (one EVM holds both chains' coins).
contract Looper is ICascadeReceiver {
    CcipBaseAdapter public immutable baseAdapter;
    CcipBittensorAdapter public immutable bitAdapter;
    uint64 public immutable baseChain;
    uint64 public immutable bitChain;

    constructor(CcipBaseAdapter base_, CcipBittensorAdapter bit_, IERC20 taoBase) {
        baseAdapter = base_;
        bitAdapter = bit_;
        baseChain = base_.localChainId();
        bitChain = bit_.localChainId();
        taoBase.approve(address(base_), type(uint256).max);
    }

    receive() external payable {}

    function onBridgeMessage(uint64, address, bytes calldata, uint256) external payable {}

    /// Base to Bittensor: `amount` bridged TAO in BATCH(`id`, [(this, amount)], []), the fee `fee`.
    function toBittensor(uint64 id, uint256 amount, uint256 fee) external {
        CascadeMessages.Entry[] memory d = new CascadeMessages.Entry[](1);
        d[0] = CascadeMessages.Entry(address(this), amount);
        bytes memory batch = CascadeMessages.encodeBatch(id, d, new CascadeMessages.Entry[](0));
        baseAdapter.send{value: fee}(bitChain, address(this), batch, amount);
    }

    /// Bittensor to Base: `amount` native TAO, the fee `fee` beside it.
    function toBase(uint256 amount, uint256 fee) external {
        bitAdapter.send{value: amount + fee}(baseChain, address(this), "", amount);
    }
}

/// The adapters' half of the looped-rounding test (the founder's question of 2026-11-03; the ruling split it from the
/// vault's half, Task 35's VaultLoopedRounding.t.sol, to the adapter campaign, Task 38): the Bittensor adapter covers a
/// conversion at most 1 rao short (SHORTFALL_TOLERANCE_WEI) from its own reserves, the native reserve on a delivery and
/// the token cushion on a send, never from a park. Every send that draws on them costs its sender the lane's fee, a
/// million rao at the fixture's 0.001 TAO, against the 1 rao it draws, so a loop of round trips through the pair never
/// profits: a looper sending bridged TAO to itself on Bittensor and back, with ForeverMoney paying 1 rao short both
/// ways (the worst case for the reserves), exact, or 1 rao in the looper's favour, ends each trip with its tokens back
/// and its native balance lower by exactly the two fees; each trip draws exactly its rao from each reserve when short
/// and nothing otherwise (a favourable rounding stays in the adapter as surplus, swept only to the treasury, never to
/// the looper); the parks beside it never move (I-7). A looper that drains a reserve stops being covered: its next
/// delivery parks its tokens (ConversionShort) and its next send reverts, nothing lost, until the operator tops the
/// reserve up.
contract AdapterLoopedRoundingTest is AdaptersFixture, CushionHelpers {
    using stdStorage for StdStorage;

    uint256 constant RAO = 1e9;

    Looper looper;
    /// A park of each kind beside the loop, which the loop must never touch.
    uint256 constant NATIVE_PARK = 7e18;
    uint256 constant TOKEN_PARK = 3e18;

    function setUp() public override {
        super.setUp();
        looper = new Looper(adapterBase, adapterBit, IERC20(address(taoBase)));
        taoBase.mint(address(looper), 1_000e18);
        vm.deal(address(looper), 100 ether);
        // the deploy's reserves, at their targets (spec §7): the native reserve topped up to RESERVE_TARGET, and the
        // token cushion booked through fundCushion (R4 F-1), TOKEN_RESERVE_TARGET
        adapterBit.fundReserve{value: adapterBit.RESERVE_TARGET() - ED}();
        fundCushion(taoBit, address(adapterBit), adapterBit.TOKEN_RESERVE_TARGET());
        _parkOneOfEach();
    }

    /// One converted park (the vault paused: a batch of NATIVE_PARK refused EnforcedPause) and one token park
    /// (ForeverMoney halted: a batch of TOKEN_PARK), then both unpaused.
    function _parkOneOfEach() internal {
        depositVia(fd, alice, NATIVE_PARK);
        close(fd);
        vm.prank(guardian);
        vault.pause();
        (bool ok,) = relayToBittensor(0);
        assertTrue(ok);
        vm.prank(owner);
        vault.unpause();
        depositVia(fd, bob, TOKEN_PARK);
        close(fd);
        holdRail();
        (ok,) = relayToBittensor(1);
        assertTrue(ok);
        av.unpause();
        assertEq(adapterBit.parkedNative(), NATIVE_PARK);
        assertEq(adapterBit.parkedTokens(), TOKEN_PARK);
    }

    /// What the looper holds, native and bridged TAO on Base together (1:1).
    function _looperValue() internal view returns (uint256) {
        return address(looper).balance + taoBase.balanceOf(address(looper));
    }

    /// The native reserve and the token cushion: what the adapter holds above its parks of each kind.
    function _reserves() internal view returns (uint256 native, uint256 cushion) {
        native = address(adapterBit).balance - adapterBit.parkedNative();
        cushion = taoBit.balanceOf(address(adapterBit)) - adapterBit.parkedTokens();
    }

    /// _trip in its own call frame (the long loop's: memory is per frame).
    function trip(uint64 id, uint256 amount) external {
        require(msg.sender == address(this), "self");
        _trip(id, amount);
    }

    /// One round trip of `amount`: Base to Bittensor, relayed; Bittensor back to Base, relayed. Each send pays FEE.
    function _trip(uint64 id, uint256 amount) internal {
        uint256 sends = routerBase.sendCount();
        looper.toBittensor(id, amount, FEE);
        (bool ok,) = relayToBittensor(sends);
        assertTrue(ok, "the delivery");
        sends = routerBit.sendCount();
        looper.toBase(amount, FEE);
        (ok,) = relayToBase(sends);
        assertTrue(ok, "the payment back");
    }

    /// N round trips of a fuzzed amount (the Base adapter's 0.01 TAO minimum to 10 TAO, whole rao), ForeverMoney 1 rao
    /// short both ways, exact, or 1 rao in the looper's favour: after every trip the looper has its tokens back and
    /// exactly two fees less; each short trip draws exactly 1 rao from each reserve, which is a millionth of the fee
    /// it rode on, and the others draw nothing (a favourable rounding stays as surplus, the sweep's, never the
    /// looper's); the parks are whole throughout.
    /// forge-config: default.fuzz.runs = 32
    /// forge-config: parity.fuzz.runs = 32
    function testFuzz_loopedRoundTripsCostMoreThanTheyDraw(uint256 n, uint256 amount, uint256 rounding) public {
        n = bound(n, 1, 100);
        amount = bound(amount, adapterBase.minSendAmount() / RAO, 10e18 / RAO) * RAO;
        rounding %= 3;
        if (rounding == 0) av.setShortBy(1e9);
        if (rounding == 2) {
            av.setOverpay(1e9);
            av.setOvermint(1e9);
        }
        uint256 tokens = taoBase.balanceOf(address(looper));
        assertLt(RAO, FEE, "what a send draws is less than the fee it pays");
        for (uint256 i; i < n; ++i) {
            uint256 before = _looperValue();
            (uint256 native0, uint256 cushion0) = _reserves();
            // casting to 'uint64' is safe because i < 100
            // forge-lint: disable-next-line(unsafe-typecast)
            _trip(uint64(100 + i), amount);
            (uint256 native1, uint256 cushion1) = _reserves();
            assertEq(_looperValue(), before - 2 * FEE, "a trip costs its sender exactly the two fees");
            assertEq(taoBase.balanceOf(address(looper)), tokens, "its tokens back, whole");
            if (rounding == 0) {
                assertEq(native0 - native1, RAO, "the delivery drew 1 rao from the native reserve");
                assertEq(cushion0 - cushion1, RAO, "the send drew 1 rao from the token cushion");
            } else if (rounding == 1) {
                assertEq(native1, native0, "an exact trip draws nothing");
                assertEq(cushion1, cushion0);
            } else {
                assertEq(native1, native0 + RAO, "a favourable rounding stays in the adapter");
                assertEq(cushion1, cushion0 + RAO);
            }
            assertEq(adapterBit.parkedNative(), NATIVE_PARK, "the native park untouched");
            assertEq(adapterBit.parkedTokens(), TOKEN_PARK, "the token park untouched");
            assertOwed(adapterBit, taoBit);
        }
        if (rounding == 2) {
            // the surplus goes to the treasury, never the looper
            uint256 looperBefore = _looperValue();
            adapterBit.sweepSurplus();
            assertEq(treasury.balance, n * RAO, "the native surplus, swept to the treasury");
            assertEq(taoBit.balanceOf(treasury), n * RAO, "the token surplus, swept to the treasury");
            assertEq(_looperValue(), looperBefore);
        }
    }

    /// Five hundred round trips at the Base adapter's minimum send, 0.01 TAO, ForeverMoney 1 rao short both ways: the
    /// looper ends 1,000 fees poorer, and the reserves 500 rao lower each, the parks whole. (A trip costs about a
    /// million gas here, each in its own frame: a thousand pass the test's 2^30 gas limit.)
    function test_fiveHundredShortTripsAtTheMinimumCostTheirFees() public {
        av.setShortBy(1e9);
        uint256 amount = adapterBase.minSendAmount();
        uint256 start = _looperValue();
        (uint256 native0, uint256 cushion0) = _reserves();
        for (uint64 i; i < 500; ++i) {
            // each trip in its own frame, so the loop's memory does not grow with it
            this.trip(100 + i, amount);
        }
        (uint256 native1, uint256 cushion1) = _reserves();
        assertEq(_looperValue(), start - 1_000 * FEE, "1,000 fees");
        assertEq(native0 - native1, 500 * RAO, "a rao a delivery");
        assertEq(cushion0 - cushion1, 500 * RAO, "a rao a send");
        assertEq(adapterBit.parkedNative(), NATIVE_PARK);
        assertEq(adapterBit.parkedTokens(), TOKEN_PARK);
        assertOwed(adapterBit, taoBit);
    }

    /// A looper that drains the reserves stops being covered, and nothing is lost: with each reserve at 1 rao, one
    /// short trip draws both; the next delivery parks the looper's own tokens (ConversionShort: the rao would have come
    /// out of the native park beside it) and its next send reverts ConversionShort (it would have come out of the token
    /// park), the parks whole; once the operator tops the reserves up the looper's token park is delivered and its send
    /// goes.
    function test_aLooperThatDrainsTheReservesStopsBeingCovered() public {
        (uint256 native, uint256 cushion) = _reserves();
        vm.deal(address(adapterBit), address(adapterBit).balance - native + RAO);
        taoBit.burn(address(adapterBit), cushion - RAO);
        // the booked cushion drawn down with it (R4 F-1: the books, not the balance, say what the cushion is)
        stdstore.target(address(adapterBit)).sig("tokenCushion()").checked_write(RAO);
        av.setShortBy(1e9);
        _trip(100, 1e18);
        (native, cushion) = _reserves();
        assertEq(native, 0, "the native reserve drawn dry");
        assertEq(cushion, 0, "the token cushion drawn dry");

        uint256 sends = routerBase.sendCount();
        looper.toBittensor(101, 1e18, FEE);
        (bool ok,) = relayToBittensor(sends);
        assertTrue(ok, "the message succeeds: the batch parks");
        CascadeMessages.Entry[] memory d = new CascadeMessages.Entry[](1);
        d[0] = CascadeMessages.Entry(address(looper), 1e18);
        bytes memory batch = CascadeMessages.encodeBatch(101, d, new CascadeMessages.Entry[](0));
        bytes32 key = keccak256(abi.encode(BASE, address(looper), address(looper), batch));
        (uint128 parked,, bool converted) = adapterBit.parked(key);
        assertEq(parked, 1e18, "the looper's own tokens park");
        assertFalse(converted);
        assertEq(adapterBit.parkedNative(), NATIVE_PARK, "the native park never pays the rao");

        vm.deal(address(looper), address(looper).balance + 1e18);
        vm.expectRevert(CcipAdapterBase.ConversionShort.selector);
        looper.toBase(1e18, FEE);
        assertEq(adapterBit.parkedTokens(), TOKEN_PARK + 1e18, "the token parks never pay the rao");

        adapterBit.fundReserve{value: RAO}();
        fundCushion(taoBit, address(adapterBit), RAO);
        adapterBit.deliverParked(address(looper), address(looper), batch);
        (parked,,) = adapterBit.parked(key);
        assertEq(parked, 0, "delivered once topped up");
        looper.toBase(1e18, FEE);
        assertEq(adapterBit.parkedNative(), NATIVE_PARK);
        assertEq(adapterBit.parkedTokens(), TOKEN_PARK);
        assertOwed(adapterBit, taoBit);
    }
}
