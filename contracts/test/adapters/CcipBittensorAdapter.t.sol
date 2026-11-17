// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeVaultLens} from "../../src/lens/CascadeVaultLens.sol";
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
import {ReentrantRecipient} from "../mocks/ReentrantRecipient.sol";
import {CushionHelpers} from "./CushionHelpers.sol";
import {mirror} from "../mocks/Mirror.sol";
import {defaultVaultParams} from "../utils/DefaultParams.sol";
import {AmountMismatch} from "../../src/CascadeErrors.sol";
import {DoorState} from "../../src/CascadeTypes.sol";

contract CcipBittensorAdapterTest is Test, CushionHelpers {
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
    /// The read-only lens on `vault` (spec §8.1).
    CascadeVaultLens vaultLens;

    address adapterBase = makeAddr("adapterBase");
    address frontDoor = makeAddr("frontDoor");
    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address keeper = makeAddr("keeper");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");

    /// ForeverMoney's operator holds the AlphaVault (adminHold, for ten years): every conversion reverts IsHalted
    /// until `av.unpause()`.
    function holdRail() internal {
        av.adminHold(vm.getBlockTimestamp() + 3650 days);
    }

    /// ForeverMoney's staked position, in rao: where a conversion's TAO goes, or comes from (the double's own native
    /// balance is not meaningful after a refused conversion: MockAlphaVault's harness note).
    function _staked() internal view returns (uint256) {
        return av.stakedValueRao(address(taoBit));
    }

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
                gasPerEntry: 25_000,
                maxMessageValue: 5_000e18,
                treasury: treasury
            }),
            IAlphaVault(address(av)),
            // the lane's inbound model (R4): the fixtures' Base-side pair
            1_000_000,
            25_000
        );
        // the Base front door is the vault's launch door, active from the deploy
        vault = new CascadeVault(
            defaultVaultParams(
                mirror(predictedVault),
                bytes32(uint256(1)),
                ICascadeBridge(address(adapter)),
                owner,
                guardian,
                keeper,
                BASE,
                frontDoor
            )
        );
        assertEq(address(adapter), predictedAdapter);
        assertEq(address(vault), predictedVault);
        vaultLens = new CascadeVaultLens(address(vault));
        assertEq(uint8(vaultLens.doorState(vaultLens.peerId(BASE, frontDoor))), uint8(DoorState.Active));
        assertEq(vaultLens.activeDoors(BASE), 1);

        vm.deal(address(vault), RESERVE);
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
        uint256 stakedBefore = _staked();
        _send(1e18, 1e18 + FEE + 7);
        assertEq(taoBit.balanceOf(address(router)), 1e18);
        assertEq(taoBit.balanceOf(address(adapter)), 0);
        assertEq(taoBit.allowance(address(adapter), address(router)), 0);
        assertEq(_staked() - stakedBefore, 1e9, "ForeverMoney staked the TAO");
        assertEq(address(router).balance, FEE);
        assertEq(address(adapter).balance, RESERVE + 7);
        assertEq(router.lastSend().tokenAmounts[0].amount, 1e18);
    }

    function test_send_notRaoAlignedReverts() public {
        vm.expectRevert(CcipAdapterBase.NotRaoAligned.selector);
        _send(1e18 + 1, 1e18 + 1 + FEE);
    }

    /// With no token cushion (none is funded here) even a deposit 1 rao short reverts, in the adapter (ForeverMoney is
    /// asked for the amount less 1 rao, R3 B-1): the rao could come only from the cushion, which is empty (Task 28; the
    /// tolerance and the cushion are tested below). The chain moves whole rao, so no deposit is 1 wei short.
    function test_send_conversionShortReverts() public {
        av.setShortBy(1e9);
        vm.expectRevert(CcipAdapterBase.ConversionShort.selector);
        _send(1e18, 1e18 + FEE);
    }

    function test_send_pausedAlphaVaultReverts() public {
        holdRail();
        vm.expectRevert(MockAlphaVault.IsHalted.selector);
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

    /// Below the floor the conversion is refused inside convertExact, and the batch parks as its tokens (Task 25):
    /// the message succeeds, nothing reaches the vault.
    function test_ccipReceive_belowFloorParksTokens() public {
        (, bool ok,) = router.deliver(address(adapter), _incoming(1e15, 1e15, true), GAS);
        assertTrue(ok);
        assertEq(adapter.parkedTokens(), 1e15);
        assertEq(taoBit.balanceOf(address(adapter)), 1e15);
        assertEq(vault.balanceOf(alice), 0);
    }

    /// Deposits the tokens do not cover are a malformed batch: the adapter itself refuses it (AmountMismatch, spec
    /// §3.2 step 1, Task 25; v3.1 left it to the vault), and the whole message fails.
    function test_ccipReceive_noTokensWithNonZeroBatchFailsAtTheAdapter() public {
        (bool called, bool ok, bytes memory reason) = router.deliver(address(adapter), _incoming(0, 1e18, false), GAS);
        assertTrue(called);
        assertFalse(ok);
        assertEq(_inner(reason), abi.encodeWithSelector(AmountMismatch.selector));
        assertEq(vault.balanceOf(alice), 0);
        assertEq(address(adapter).balance, RESERVE);
        assertEq(taoBit.balanceOf(address(adapter)), 0);
    }

    function test_ccipReceive_overpaymentStaysInAdapter() public {
        av.setOverpay(5e9);
        uint256 supplyBefore = vault.totalSupply();
        (, bool ok,) = router.deliver(address(adapter), _incoming(1e18, 1e18, true), GAS);
        assertTrue(ok);
        assertGt(vault.totalSupply(), supplyBefore);
        assertEq(address(adapter).balance, RESERVE + 5e9);
    }

    /// A payment at most 1 rao short (the chain pays whole rao) is covered from the reserve (SHORTFALL_TOLERANCE_WEI,
    /// Task 25): ForeverMoney's own check takes it (`minTaoOut = amount - 1 rao`), the vault gets the full amount and
    /// the reserve pays the rao. (Past the tolerance the batch parks: BittensorParking.t.sol.)
    function test_ccipReceive_shortPaymentWithinOneRaoIsCovered() public {
        av.setShortBy(1e9);
        uint256 supplyBefore = vault.totalSupply();
        (, bool ok,) = router.deliver(address(adapter), _incoming(1e18, 1e18, true), GAS);
        assertTrue(ok);
        assertGt(vault.totalSupply(), supplyBefore);
        assertEq(address(vault).balance, RESERVE + 1e18);
        assertEq(address(adapter).balance, RESERVE - 1e9);
    }

    /// A BATCH of `amount` for alice under batch id `id`, as CCIP delivers it with its tokens (message id `id`).
    function _incomingBatch(uint64 id, uint256 amount) internal view returns (Client.Any2EVMMessage memory m) {
        CascadeMessages.Entry[] memory deposits = new CascadeMessages.Entry[](1);
        deposits[0] = CascadeMessages.Entry(alice, amount);
        bytes memory message = CascadeMessages.encodeBatch(id, deposits, new CascadeMessages.Entry[](0));
        Client.EVMTokenAmount[] memory t = new Client.EVMTokenAmount[](1);
        t[0] = Client.EVMTokenAmount(address(taoBit), amount);
        m = Client.Any2EVMMessage({
            messageId: bytes32(uint256(id)),
            sourceChainSelector: BASE_SELECTOR,
            sender: abi.encode(adapterBase),
            data: adapter.encodePayload(address(vault), frontDoor, message),
            destTokenAmounts: t
        });
    }

    /// The payload of `m`: (sender, recipient, message).
    function _decoded(Client.Any2EVMMessage memory m) internal view returns (address, address, bytes memory) {
        (address recipient, address sender, bytes memory message) = adapter.decodePayload(m.data);
        return (sender, recipient, message);
    }

    /// While the vault's stake is missing it refuses every batch (StakeMissing, Task 13). On v3.1 the adapter could
    /// only fail with it, leaving the message in CCIP FAILURE, whose re-execution failed again until the stake was
    /// listed; since Task 25 it parks the batch: the tokens are converted, the native TAO is kept under
    /// the batch's record (converted), the message succeeds, and nothing reaches the vault. Task 26's
    /// deliverParked delivers it once the stake is listed again.
    function test_ccipReceive_stakeMissingParksNative() public {
        bytes32 hk1 = bytes32(uint256(1));
        bytes32 hk5 = bytes32(uint256(5));
        (, bool ok,) = router.deliver(address(adapter), _incomingBatch(1, 10e18), GAS);
        assertTrue(ok);
        vm.prank(keeper);
        vault.stakeIdle();
        staking.swapHotkey(hk1, hk5, vaultLens.coldkey(), 5_000);
        assertTrue(vaultLens.stakeMissing());

        uint256 supply = vault.totalSupply();
        uint256 vaultBalance = address(vault).balance;
        Client.Any2EVMMessage memory m = _incomingBatch(2, 1e18);
        bool called;
        (called, ok,) = router.deliver(address(adapter), m, GAS);
        assertTrue(called);
        assertTrue(ok, "SUCCESS: the batch parked");
        (, address recipient, bytes memory message) = _decoded(m);
        (uint128 amount,, bool converted) = adapter.parked(keccak256(abi.encode(BASE, frontDoor, recipient, message)));
        assertEq(amount, 1e18);
        assertTrue(converted);
        assertEq(adapter.parkedNative(), 1e18);
        assertEq(taoBit.balanceOf(address(adapter)), 0);
        assertEq(address(adapter).balance, RESERVE + 1e18);
        assertEq(address(vault).balance, vaultBalance);
        assertEq(vault.totalSupply(), supply, "nothing minted");
    }

    /// A paused vault refuses the delivery and the converted TAO parks in the adapter (Task 25); on v3.1 the whole
    /// message failed atomically.
    function test_ccipReceive_vaultPausedParksNative() public {
        vm.prank(guardian);
        vault.pause();
        uint256 stakedBefore = _staked();
        (bool called, bool ok,) = router.deliver(address(adapter), _incoming(1e18, 1e18, true), GAS);
        assertTrue(called);
        assertTrue(ok);
        assertEq(adapter.parkedNative(), 1e18);
        assertEq(taoBit.balanceOf(address(adapter)), 0);
        assertEq(address(adapter).balance, RESERVE + 1e18);
        assertEq(stakedBefore - _staked(), 1e9, "converted: unstaked from ForeverMoney's position");
        assertEq(vault.totalSupply(), 0);
    }

    // ---- the send-side tolerance and the token cushion (Task 28; spec §3.2, §3.3, I-7; fundCushion and
    // shortfallsLogged: CushionHelpers) ----

    /// The park key of the door's `message` to the vault, by its formula (spec §3.2).
    function _key(bytes memory message) internal view returns (bytes32) {
        return keccak256(abi.encode(BASE, frontDoor, address(vault), message));
    }

    /// Parks alice's batch `id` of `amount` as tokens (ForeverMoney paused for its delivery, then back).
    function _tokenPark(uint64 id, uint256 amount) internal returns (bytes memory message) {
        holdRail();
        Client.Any2EVMMessage memory m = _incomingBatch(id, amount);
        (, bool ok,) = router.deliver(address(adapter), m, GAS);
        assertTrue(ok, "parked");
        av.unpause();
        (,, message) = _decoded(m);
        (uint128 parkedAmount,, bool converted) = adapter.parked(_key(message));
        assertEq(parkedAmount, amount, "a token park");
        assertFalse(converted);
    }

    /// Parks alice's batch `id` of `amount` as native TAO (the vault paused for its delivery, then back).
    function _nativePark(uint64 id, uint256 amount) internal returns (bytes memory message) {
        vm.prank(guardian);
        vault.pause();
        Client.Any2EVMMessage memory m = _incomingBatch(id, amount);
        (, bool ok,) = router.deliver(address(adapter), m, GAS);
        assertTrue(ok, "parked");
        vm.prank(owner);
        vault.unpause();
        (,, message) = _decoded(m);
        (uint128 parkedAmount,, bool converted) = adapter.parked(_key(message));
        assertEq(parkedAmount, amount, "a native park");
        assertTrue(converted);
    }

    /// A deposit that mints more than it was paid (the chain crediting ForeverMoney's stake in the adapter's favour, a
    /// whole number of rao) is accepted, with no cushion at all (spec §3.3; v3.1's exact check reverted
    /// ConversionShort): the router takes exactly `amount`, the extra stays in the adapter (surplus, for the sweep), and
    /// no shortfall is reported.
    function test_overMintAccepted() public {
        av.setOvermint(5e9);
        vm.recordLogs();
        _send(1e18, 1e18 + FEE);
        assertEq(shortfallsLogged(address(adapter)).length, 0, "nothing to cover");
        assertEq(router.sendCount(), 1);
        assertEq(router.lastSend().tokenAmounts[0].amount, 1e18);
        assertEq(taoBit.balanceOf(address(router)), 1e18);
        assertEq(taoBit.balanceOf(address(adapter)), 5e9, "the extra rao stay");
        assertEq(taoBit.allowance(address(adapter), address(router)), 0);
        assertEq(address(adapter).balance, RESERVE);
    }

    /// A deposit that mints 1 rao (SHORTFALL_TOLERANCE_WEI) less than it was paid no longer stalls the payout (spec
    /// §3.3; v3.1 reverted ConversionShort on any shortfall): ForeverMoney, asked for the amount less 1 rao (R3 B-1),
    /// mints the stake it measured, the token cushion, funded by a plain transfer, pays the difference, the router still
    /// takes the whole amount, and ShortfallCovered names what the cushion paid; twice, each covered. The chain credits
    /// whole rao, so a mint is never short by a wei. The native reserve is never touched.
    function test_oneRaoUnderMintCoveredByTheCushion() public {
        fundCushion(taoBit, address(adapter), 1e15);
        av.setShortBy(1e9);
        vm.expectEmit(address(adapter));
        emit CcipBittensorAdapter.ShortfallCovered(1e9);
        _send(1e18, 1e18 + FEE);
        assertEq(router.lastSend().tokenAmounts[0].amount, 1e18, "the whole amount");
        assertEq(taoBit.balanceOf(address(adapter)), 1e15 - 1e9, "the cushion paid the rao");

        vm.expectEmit(address(adapter));
        emit CcipBittensorAdapter.ShortfallCovered(1e9);
        _send(2e18, 2e18 + FEE);
        assertEq(router.lastSend().tokenAmounts[0].amount, 2e18, "the whole amount");
        assertEq(taoBit.balanceOf(address(router)), 3e18);
        assertEq(taoBit.balanceOf(address(adapter)), 1e15 - 2e9, "the cushion paid each rao");
        assertEq(taoBit.allowance(address(adapter), address(router)), 0);
        assertEq(address(adapter).balance, RESERVE, "the native reserve untouched");
    }

    /// The tolerance is exactly 1 rao: a deposit 2 or 3 rao short is refused inside ForeverMoney (its measured-stake
    /// check, `Slippage`, against the amount less 1 rao) however full the cushion, and nothing moves (the payout is
    /// retried later), while exactly 1 rao short is covered.
    function test_twoRaoUnderMintReverts() public {
        fundCushion(taoBit, address(adapter), 1e15);
        av.setShortBy(2e9);
        vm.expectRevert(MockAlphaVault.Slippage.selector);
        _send(1e18, 1e18 + FEE);
        av.setShortBy(3e9);
        vm.expectRevert(MockAlphaVault.Slippage.selector);
        _send(1e18, 1e18 + FEE);
        assertEq(router.sendCount(), 0);
        assertEq(taoBit.balanceOf(address(adapter)), 1e15, "the cushion untouched");
        assertEq(address(adapter).balance, RESERVE);

        av.setShortBy(1e9);
        _send(1e18, 1e18 + FEE);
        assertEq(taoBit.balanceOf(address(adapter)), 1e15 - 1e9);
    }

    /// The rao comes from the cushion, never from a token park (spec §3.3, I-7). With a token park beside it and the
    /// cushion drained by a covered shortfall, the adapter's token balance is exactly parkedTokens: a deposit 1 rao
    /// short passes ForeverMoney and reverts the adapter's ConversionShort, though the parked tokens could have paid
    /// it, and an exact one still sends. A plain transfer tops the cushion up, the same shortfall then comes out of it,
    /// and the park is whole: delivered in full afterwards.
    function test_drainedCushionRevertsCollectUntilToppedUp() public {
        bytes memory parkedMessage = _tokenPark(1, 5e18);
        fundCushion(taoBit, address(adapter), 1e9);
        av.setShortBy(1e9);
        _send(1e18, 1e18 + FEE);
        assertEq(taoBit.balanceOf(address(adapter)), adapter.parkedTokens(), "the cushion drained");

        vm.expectRevert(CcipAdapterBase.ConversionShort.selector);
        _send(1e18, 1e18 + FEE);
        assertEq(taoBit.balanceOf(address(adapter)), 5e18, "the parked tokens never pay the rao");
        av.setShortBy(0);
        _send(1e18, 1e18 + FEE);
        assertEq(router.sendCount(), 2);

        fundCushion(taoBit, address(adapter), 1e15);
        av.setShortBy(1e9);
        vm.expectEmit(address(adapter));
        emit CcipBittensorAdapter.ShortfallCovered(1e9);
        _send(1e18, 1e18 + FEE);
        assertEq(router.sendCount(), 3);
        assertEq(taoBit.balanceOf(address(adapter)), 5e18 + 1e15 - 1e9, "out of the top-up");
        assertEq(adapter.parkedTokens(), 5e18);
        assertOwed(adapter, taoBit);

        av.setShortBy(0);
        adapter.deliverParked(address(vault), frontDoor, parkedMessage);
        assertEq(adapter.parkedTokens(), 0);
        assertEq(vault.balanceOf(alice), 5e24, "the park delivered in full");
        assertEq(taoBit.balanceOf(address(adapter)), 1e15 - 1e9, "the cushion left");
    }

    /// Parking never depends on the cushion (spec §3.2, M-B: the cushion is no parking condition). With the cushion
    /// drained by a covered shortfall and a token park already held, a delivery whose conversion fails, ForeverMoney
    /// halted or the withdraw short past the tolerance, still parks its tokens (the pool has just released them), and
    /// the message succeeds.
    function test_drainedCushionDoesNotStopATokenPark() public {
        _tokenPark(1, 5e18);
        fundCushion(taoBit, address(adapter), 1e9);
        av.setShortBy(1e9);
        _send(1e18, 1e18 + FEE);
        assertEq(taoBit.balanceOf(address(adapter)), adapter.parkedTokens(), "the cushion drained");

        av.setShortBy(0);
        bytes memory paused = _tokenPark(2, 3e18);
        av.setShortBy(2e9);
        Client.Any2EVMMessage memory m = _incomingBatch(3, 1e18);
        (, bool ok,) = router.deliver(address(adapter), m, GAS);
        assertTrue(ok, "SUCCESS: parked");
        (,, bytes memory short) = _decoded(m);
        (uint128 amount,, bool converted) = adapter.parked(_key(short));
        assertEq(amount, 1e18);
        assertFalse(converted);
        (amount,,) = adapter.parked(_key(paused));
        assertEq(amount, 3e18);
        assertEq(adapter.parkedTokens(), 9e18);
        assertEq(taoBit.balanceOf(address(adapter)), 9e18, "exactly the parks: no cushion");
        assertEq(vault.totalSupply(), 0);
    }

    /// Spec §3.3's fuzz, in the chain's whole rao: a send's conversion short by 0, 1 or 2 rao (up to 2 x
    /// SHORTFALL_TOLERANCE_WEI), beside a 5e18 token park, with the cushion empty, partial (any amount from 1 wei to 2
    /// rao) or full (TOKEN_RESERVE_TARGET). It goes exactly when the shortfall is within the tolerance and the cushion
    /// covers it: the router takes the whole amount, the cushion falls by exactly the shortfall, and ShortfallCovered
    /// carries it (none when the mint is exact). Past the tolerance ForeverMoney refuses it (`Slippage`, its measured
    /// stake below the amount less 1 rao); within it with the cushion short, the adapter (`ConversionShort`); either way
    /// nothing moves. The token park and its total are untouched, the token balance never falls below parkedTokens, the
    /// native balance is unchanged, and I-7 holds.
    function testFuzz_shortfallAgainstTheCushion(uint256 shortBy, uint8 kind, uint256 part) public {
        uint256 tolerance = adapter.SHORTFALL_TOLERANCE_WEI();
        shortBy = bound(shortBy, 0, 2) * tolerance;
        uint256 cushion;
        if (kind % 3 == 1) cushion = bound(part, 1, 2 * tolerance);
        else if (kind % 3 == 2) cushion = adapter.TOKEN_RESERVE_TARGET();
        bytes memory parkedMessage = _tokenPark(1, 5e18);
        if (cushion != 0) fundCushion(taoBit, address(adapter), cushion);
        av.setShortBy(shortBy);
        uint256 native = address(adapter).balance;

        if (shortBy <= tolerance && cushion >= shortBy) {
            vm.recordLogs();
            _send(1e18, 1e18 + FEE);
            uint256[] memory covered = shortfallsLogged(address(adapter));
            if (shortBy == 0) {
                assertEq(covered.length, 0, "an exact mint covers nothing");
            } else {
                assertEq(covered.length, 1, "one shortfall covered");
                assertEq(covered[0], shortBy, "the wei the cushion paid");
            }
            assertEq(router.sendCount(), 1);
            assertEq(router.lastSend().tokenAmounts[0].amount, 1e18, "the whole amount");
            assertEq(taoBit.balanceOf(address(adapter)), 5e18 + cushion - shortBy, "the cushion paid the shortfall");
        } else {
            vm.expectRevert(
                shortBy > tolerance ? MockAlphaVault.Slippage.selector : CcipAdapterBase.ConversionShort.selector
            );
            _send(1e18, 1e18 + FEE);
            assertEq(router.sendCount(), 0);
            assertEq(taoBit.balanceOf(address(adapter)), 5e18 + cushion, "nothing moved");
        }
        assertEq(adapter.parkedTokens(), 5e18);
        (uint128 amount,, bool converted) = adapter.parked(_key(parkedMessage));
        assertEq(amount, 5e18, "the token park untouched");
        assertFalse(converted);
        assertGe(taoBit.balanceOf(address(adapter)), adapter.parkedTokens(), "the parked tokens never pay");
        assertEq(address(adapter).balance, native, "the native balance unchanged");
        assertOwed(adapter, taoBit);
    }

    // ---- sweepSurplus (Task 28; spec §3.2, I-7) ----

    /// sweepSurplus sends the treasury only what the adapter holds above its reserves and its parks (I-7): native above
    /// RESERVE_TARGET + parkedNative, tokens above TOKEN_RESERVE_TARGET + parkedTokens. With a native park, a token
    /// park, both reserves at their targets and a surplus of each (a send's fee excess and a withdraw's rounding
    /// surplus; an over-mint and tokens sent by mistake), anyone's sweep takes exactly the surplus; both parks, both
    /// totals and both reserves stay; a second sweep finds nothing; and each park is delivered in full afterwards.
    function test_sweepNeverTouchesParkedTotals() public {
        bytes memory native = _nativePark(1, 4e18);
        bytes memory tokens = _tokenPark(2, 3e18);
        uint256 reserveTarget = adapter.RESERVE_TARGET();
        uint256 tokenTarget = adapter.TOKEN_RESERVE_TARGET();
        adapter.fundReserve{value: reserveTarget - RESERVE}();
        fundCushion(taoBit, address(adapter), tokenTarget);

        av.setOvermint(3e9);
        _send(1e18, 1e18 + FEE + 7e14);
        av.setOvermint(0);
        av.setOverpay(5e9);
        (, bool ok,) = router.deliver(address(adapter), _incomingBatch(3, 1e18), GAS);
        assertTrue(ok);
        av.setOverpay(0);
        taoBit.mint(alice, 2e18);
        vm.prank(alice);
        assertTrue(taoBit.transfer(address(adapter), 2e18));
        assertEq(address(adapter).balance, reserveTarget + 4e18 + 7e14 + 5e9);
        assertEq(taoBit.balanceOf(address(adapter)), tokenTarget + 3e18 + 2e18 + 3e9);

        vm.expectEmit(address(adapter));
        emit CcipAdapterBase.SurplusSwept(7e14 + 5e9, 2e18 + 3e9);
        vm.prank(alice);
        adapter.sweepSurplus();
        assertEq(treasury.balance, 7e14 + 5e9, "the native surplus");
        assertEq(taoBit.balanceOf(treasury), 2e18 + 3e9, "the token surplus");
        assertEq(adapter.parkedNative(), 4e18);
        assertEq(adapter.parkedTokens(), 3e18);
        assertEq(address(adapter).balance, reserveTarget + 4e18, "the native park and the reserve");
        assertEq(taoBit.balanceOf(address(adapter)), tokenTarget + 3e18, "the token park and the cushion");
        (uint128 amount,, bool converted) = adapter.parked(_key(native));
        assertEq(amount, 4e18);
        assertTrue(converted);
        (amount,, converted) = adapter.parked(_key(tokens));
        assertEq(amount, 3e18);
        assertFalse(converted);

        vm.expectEmit(address(adapter));
        emit CcipAdapterBase.SurplusSwept(0, 0);
        adapter.sweepSurplus();
        assertEq(treasury.balance, 7e14 + 5e9);
        assertEq(taoBit.balanceOf(treasury), 2e18 + 3e9);

        adapter.deliverParked(address(vault), frontDoor, native);
        adapter.deliverParked(address(vault), frontDoor, tokens);
        assertEq(adapter.parkedNative() + adapter.parkedTokens(), 0, "both delivered");
        assertEq(address(adapter).balance, reserveTarget, "the reserve left");
        assertEq(taoBit.balanceOf(address(adapter)), tokenTarget, "the cushion left");
    }

    /// A sweep with nothing to sweep succeeds and sends 0 and 0 (the launch's no-op sweep, spec §7). Each amount floors
    /// at 0: the deployed adapter's 1e12-wei reserve is below RESERVE_TARGET and it holds no token; with a native and a
    /// token park held and the reserves still below their targets above them; and with both exactly at their targets.
    function test_sweepWithNothingToSweepSendsZero() public {
        vm.expectEmit(address(adapter));
        emit CcipAdapterBase.SurplusSwept(0, 0);
        adapter.sweepSurplus();

        _nativePark(1, 4e18);
        _tokenPark(2, 3e18);
        fundCushion(taoBit, address(adapter), 1e12);
        assertLt(address(adapter).balance, adapter.RESERVE_TARGET() + adapter.parkedNative());
        assertLt(taoBit.balanceOf(address(adapter)), adapter.TOKEN_RESERVE_TARGET() + adapter.parkedTokens());
        vm.expectEmit(address(adapter));
        emit CcipAdapterBase.SurplusSwept(0, 0);
        adapter.sweepSurplus();

        adapter.fundReserve{value: adapter.RESERVE_TARGET() - RESERVE}();
        fundCushion(taoBit, address(adapter), adapter.TOKEN_RESERVE_TARGET() - 1e12);
        vm.expectEmit(address(adapter));
        emit CcipAdapterBase.SurplusSwept(0, 0);
        adapter.sweepSurplus();
        assertEq(treasury.balance, 0);
        assertEq(taoBit.balanceOf(treasury), 0);
        assertEq(address(adapter).balance, adapter.RESERVE_TARGET() + 4e18);
        assertEq(taoBit.balanceOf(address(adapter)), adapter.TOKEN_RESERVE_TARGET() + 3e18);
    }

    /// What CCIP hands the adapter `a` for the door's `message` to `recipient` with `amount` of the token, as message
    /// `id`.
    function _incomingTo(CcipBittensorAdapter a, address recipient, bytes memory message, uint256 amount, uint256 id)
        internal
        view
        returns (Client.Any2EVMMessage memory m)
    {
        Client.EVMTokenAmount[] memory t = new Client.EVMTokenAmount[](1);
        t[0] = Client.EVMTokenAmount(address(taoBit), amount);
        m = Client.Any2EVMMessage({
            messageId: bytes32(id),
            sourceChainSelector: BASE_SELECTOR,
            sender: abi.encode(adapterBase),
            data: a.encodePayload(recipient, frontDoor, message),
            destTokenAmounts: t
        });
    }

    /// Unlike the Base adapter's (ruling B12), this sweep is under the adapter's one lock (spec §3.2, H-3), since this
    /// adapter owes its parks. A treasury that re-enters from the native payment, the sweep's one call into its code,
    /// is refused: sweepSurplus again, and deliverParked of a native park whose recipient now accepts (unlocked, that
    /// delivery would go). It gets ReentrancyGuardReentrantCall and takes exactly the surplus once, and the parks, the
    /// totals and the reserves stay. A treasury that bubbles the refusal fails its own payment, so the sweep reverts
    /// TransferFailed and nothing moves.
    function test_sweepReentryThroughTheTreasuryIsLocked() public {
        ReentrantRecipient t = new ReentrantRecipient();
        CcipBittensorAdapter a = new CcipBittensorAdapter(
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
                treasury: address(t)
            }),
            IAlphaVault(address(av)),
            // the lane's inbound model (R4): the fixtures' Base-side pair
            1_000_000,
            25_000
        );
        a.fundReserve{value: a.RESERVE_TARGET()}();
        ReentrantRecipient r = new ReentrantRecipient();
        r.setRefusing(true);
        bytes memory nativeMessage = _batch(4e18);
        (, bool ok,) = router.deliver(address(a), _incomingTo(a, address(r), nativeMessage, 4e18, 1), GAS);
        assertTrue(ok);
        holdRail();
        (, ok,) = router.deliver(address(a), _incomingTo(a, address(r), _batch(3e18), 3e18, 2), GAS);
        assertTrue(ok);
        av.unpause();
        assertEq(a.parkedNative(), 4e18);
        assertEq(a.parkedTokens(), 3e18);
        r.setRefusing(false);

        a.send{value: 1e18 + FEE + 7e14}(BASE, frontDoor, "", 1e18);
        // the cushion booked through fundCushion (R4 F-1), and 2 TAO of surplus above it
        taoBit.mint(address(this), a.TOKEN_RESERVE_TARGET());
        taoBit.approve(address(a), a.TOKEN_RESERVE_TARGET());
        a.fundCushion(a.TOKEN_RESERVE_TARGET());
        taoBit.mint(address(a), 2e18);
        bytes memory locked = abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);

        t.setMode(
            ReentrantRecipient.Mode.ReenterOnReceive,
            address(a),
            abi.encodeCall(CcipBittensorAdapter.sweepSurplus, ()),
            false
        );
        vm.expectEmit(address(a));
        emit CcipAdapterBase.SurplusSwept(7e14, 2e18);
        a.sweepSurplus();
        assertEq(t.received(), 1);
        assertFalse(t.reentryOk(), "the re-entered sweep refused");
        assertEq(t.reentryReturn(), locked);
        assertEq(address(t).balance, 7e14, "the surplus, once");
        assertEq(taoBit.balanceOf(address(t)), 2e18);

        a.send{value: 1e18 + FEE + 3e14}(BASE, frontDoor, "", 1e18);
        t.setMode(
            ReentrantRecipient.Mode.ReenterOnReceive,
            address(a),
            abi.encodeCall(CcipBittensorAdapter.deliverParked, (address(r), frontDoor, nativeMessage)),
            false
        );
        vm.expectEmit(address(a));
        emit CcipAdapterBase.SurplusSwept(3e14, 0);
        a.sweepSurplus();
        assertEq(t.received(), 2);
        assertFalse(t.reentryOk(), "the re-entered delivery refused");
        assertEq(t.reentryReturn(), locked);
        assertEq(r.delivered(), 0);
        assertEq(address(t).balance, 1e15);
        assertEq(a.parkedNative(), 4e18);
        assertEq(a.parkedTokens(), 3e18);
        assertEq(address(a).balance, a.RESERVE_TARGET() + 4e18, "the native park and the reserve");
        assertEq(taoBit.balanceOf(address(a)), a.TOKEN_RESERVE_TARGET() + 3e18, "the token park and the cushion");

        a.send{value: 1e18 + FEE + 2e14}(BASE, frontDoor, "", 1e18);
        t.setMode(
            ReentrantRecipient.Mode.ReenterOnReceive,
            address(a),
            abi.encodeCall(CcipBittensorAdapter.sweepSurplus, ()),
            true
        );
        vm.expectRevert(CcipAdapterBase.TransferFailed.selector);
        a.sweepSurplus();
        assertEq(address(t).balance, 1e15, "nothing moved");
        assertEq(address(a).balance, a.RESERVE_TARGET() + 4e18 + 2e14);

        a.deliverParked(address(r), frontDoor, nativeMessage);
        assertEq(r.delivered(), 1, "delivered outside the lock");
        assertEq(a.parkedNative(), 0);
    }

    // ---- native value and reserve ----

    function test_receive_rejectsStrangers() public {
        (bool ok, bytes memory ret) = address(adapter).call{value: 1}("");
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(CcipAdapterBase.UnexpectedValue.selector));
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
