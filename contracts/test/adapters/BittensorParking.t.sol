// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeVaultLens} from "../../src/lens/CascadeVaultLens.sol";
import {CcipAdapterBase} from "../../src/adapters/CcipAdapterBase.sol";
import {CcipBittensorAdapter} from "../../src/adapters/CcipBittensorAdapter.sol";
import {IAlphaVault} from "../../src/interfaces/IAlphaVault.sol";
import {ICascadeBridge, ICascadeReceiver} from "../../src/interfaces/ICascadeBridge.sol";
import {ADDRESS_MAPPING_ADDRESS} from "../../src/interfaces/IAddressMapping.sol";
import {IStaking, ISTAKING_ADDRESS} from "../../src/interfaces/IStaking.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {Client} from "../../src/vendor/ccip/Client.sol";
import {IRouterClient} from "../../src/vendor/ccip/IRouterClient.sol";
import {MockAddressMapping} from "../mocks/MockAddressMapping.sol";
import {MockAlphaVault} from "../mocks/MockAlphaVault.sol";
import {MockRouter} from "../mocks/MockRouter.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {MockTAO} from "../mocks/MockTAO.sol";
import {ReentrantRecipient} from "../mocks/ReentrantRecipient.sol";
import {CushionHelpers} from "./CushionHelpers.sol";
import {mirror} from "../mocks/Mirror.sol";
import {defaultVaultParams} from "../utils/DefaultParams.sol";
import {AmountMismatch, InsufficientGas, StakeMissing, UnknownPeer, VaultInsolvent} from "../../src/CascadeErrors.sol";

/// @notice A recipient that consumes every unit of gas it is given (an invalid opcode), as a vault that runs out
/// of gas would.
contract GasBurningReceiver is ICascadeReceiver {
    function onBridgeMessage(uint64, address, bytes calldata, uint256) external payable {
        assembly ("memory-safe") {
            invalid()
        }
    }
}

/// @notice A recipient that reverts with `size` bytes of return data, `Bomb()` then zeros (a returndata bomb).
contract ReturnBombReceiver is ICascadeReceiver {
    error Bomb();

    uint256 public immutable size;

    constructor(uint256 size_) {
        size = size_;
    }

    function onBridgeMessage(uint64, address, bytes calldata, uint256) external payable {
        uint256 n = size;
        bytes4 bomb = Bomb.selector;
        assembly {
            mstore(0, bomb)
            revert(0, n)
        }
    }
}

/// @notice A recipient that, inside its delivery, has the router deliver another message to the adapter (as any
/// recipient can on the real lane, through the OffRamp's permissionless manual execution), records what that
/// returned, and then either accepts its own delivery or reverts with the re-entry's failure.
contract RouterReentrantReceiver is ICascadeReceiver {
    MockRouter public immutable router;
    address public immutable adapter;
    bytes public next;
    bool public revertAfter;

    bool public reentryOk;
    bytes public reentryReason;

    error Reentered(bytes reason);

    constructor(MockRouter router_, address adapter_) {
        router = router_;
        adapter = adapter_;
    }

    function arm(Client.Any2EVMMessage memory m, bool revertAfter_) external {
        next = abi.encode(m);
        revertAfter = revertAfter_;
    }

    function onBridgeMessage(uint64, address, bytes calldata, uint256) external payable {
        Client.Any2EVMMessage memory m = abi.decode(next, (Client.Any2EVMMessage));
        (, bool ok, bytes memory reason) = router.deliver(adapter, m, 1_000_000);
        if (revertAfter) revert Reentered(reason);
        reentryOk = ok;
        reentryReason = reason;
    }
}

/// @notice A recipient whose own lock is held, as the vault's is while a stranger's code runs under its nonReentrant
/// (R3 CC-L1): while `locked` every delivery reverts ReentrancyGuardReentrantCall, exactly as OpenZeppelin's guard does;
/// while `refusing`, Refused(); otherwise it accepts and counts.
contract LockedReceiver is ICascadeReceiver {
    error Refused();

    bool public locked;
    bool public refusing;
    uint256 public delivered;

    function setLocked(bool on) external {
        locked = on;
    }

    function setRefusing(bool on) external {
        refusing = on;
    }

    function onBridgeMessage(uint64, address, bytes calldata, uint256) external payable {
        if (locked) revert ReentrancyGuard.ReentrancyGuardReentrantCall();
        if (refusing) revert Refused();
        ++delivered;
    }
}

/// @notice R3 CC-L1's stranger: it holds direct shares in the vault, and the vault's `redeemDirect` pays it native TAO
/// from inside the vault's nonReentrant; its receive() then has the router deliver an honest door batch to the adapter
/// (on the real lane, a permissionless `OffRamp.execute` of a verified message) and records what that returned.
contract VaultLockStranger {
    CascadeVault public immutable vault;
    MockRouter public immutable router;
    address public immutable adapter;
    bytes internal next;
    bool public tried;
    bool public innerOk;
    bytes public innerReason;

    constructor(CascadeVault vault_, MockRouter router_, address adapter_) {
        vault = vault_;
        router = router_;
        adapter = adapter_;
    }

    function arm(Client.Any2EVMMessage memory m) external {
        next = abi.encode(m);
    }

    function buyShares() external payable {
        vault.depositDirect{value: msg.value}();
    }

    function attack() external {
        vault.redeemDirect(vault.balanceOf(address(this)), false);
    }

    receive() external payable {
        if (next.length == 0 || tried) return;
        tried = true;
        Client.Any2EVMMessage memory m = abi.decode(next, (Client.Any2EVMMessage));
        (, innerOk, innerReason) = router.deliver(adapter, m, 3_000_000);
    }
}

/// @notice R3 fix round 2's stranger: it withdraws from ForeverMoney's AlphaVault, and from the payment it takes inside
/// the AlphaVault's own lock it either has the router deliver an honest door batch to the adapter (on the real lane, a
/// permissionless `OffRamp.execute`) or calls `deliverParked`, and records what that returned.
contract AlphaVaultLockStranger {
    MockAlphaVault public immutable av;
    MockTAO public immutable tao;
    MockRouter public immutable router;
    CcipBittensorAdapter public immutable adapter;
    bytes internal message;
    bytes internal park;
    bool public tried;
    bool public innerOk;
    bytes public innerReason;

    constructor(MockAlphaVault av_, MockTAO tao_, MockRouter router_, CcipBittensorAdapter adapter_) {
        av = av_;
        tao = tao_;
        router = router_;
        adapter = adapter_;
    }

    function armDelivery(Client.Any2EVMMessage memory m) external {
        message = abi.encode(m);
        delete park;
        tried = false;
    }

    function armDeliverParked(address recipient, address sender, bytes memory batch) external {
        park = abi.encode(recipient, sender, batch);
        delete message;
        tried = false;
    }

    function withdraw(uint256 wad) external {
        av.withdrawLiquid(address(tao), wad, 0);
    }

    receive() external payable {
        if (tried) return;
        tried = true;
        if (message.length != 0) {
            Client.Any2EVMMessage memory m = abi.decode(message, (Client.Any2EVMMessage));
            (, innerOk, innerReason) = router.deliver(address(adapter), m, 3_000_000);
        } else if (park.length != 0) {
            (address recipient, address sender, bytes memory batch) = abi.decode(park, (address, address, bytes));
            try adapter.deliverParked(recipient, sender, batch) {
                innerOk = true;
            } catch (bytes memory e) {
                innerReason = e;
            }
        }
    }
}

/// @notice Parking in the Bittensor adapter (Task 25; spec §3.2, I-7, I-11): a delivered batch the adapter cannot
/// convert, or that its recipient refuses, is kept under a record (its tokens, or its native TAO), and the CCIP
/// message succeeds, instead of the whole message reverting into FAILURE, whose re-execution fails again while its
/// cause lasts. Only a malformed batch, a batch already parked, books that do not cover a token park, a recipient with
/// no code, a recipient or a conversion refused by a held lock (ReentrancyGuardReentrantCall, since R3) and a delivery
/// left too little gas to write the park revert. The adapter runs over the mock router and alpha vault, in front of a
/// real vault whose launch door is `frontDoor`.
/// Since Task 26 anyone delivers a park with deliverParked, under the same lock (H-3): a token park is converted
/// first, the record deleted and its total lowered before the recipient's call, and a refusal restores it as a
/// converted park with its first parkedAt. Since Task 27 anyone refunds a park to its door after PARK_TIMEOUT
/// (refundParked, its fee quoted by quoteRefund) or drops an empty one (dropParked), under the same lock.
contract BittensorParkingTest is Test, CushionHelpers {
    using stdStorage for StdStorage;

    uint64 constant BASE = 8453;
    uint64 constant BASE_SELECTOR = 15971525489660198786;
    uint256 constant RESERVE = 1e12;
    uint256 constant GAS = 3_000_000;
    bytes32 constant HK1 = bytes32(uint256(1));
    bytes32 constant HK5 = bytes32(uint256(5));
    /// What PARK_GAS_RESERVE must still have spare once a park is written after a failure that burned all its gas:
    /// the park then uses at most PARK_GAS_RESERVE - SPARE (measured: about 57,300 for a native park, whose value
    /// call's own cost comes out of the reserve, and about 53,000 for a token park).
    uint256 constant SPARE = 50_000;
    /// The router's CCIP fee toward Base, which a refund pays out of its msg.value (Task 27).
    uint256 constant FEE = 1e15;
    uint32 constant REFUND_CHUNK = type(uint32).max;

    MockStaking staking = MockStaking(ISTAKING_ADDRESS);
    MockTAO taoBit;
    MockRouter router;
    MockAlphaVault av;
    CcipBittensorAdapter adapter;
    CascadeVault vault;
    CascadeVaultLens vaultLens;

    address adapterBase = makeAddr("adapterBase");
    address frontDoor = makeAddr("frontDoor");
    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address keeper = makeAddr("keeper");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address anyone = makeAddr("anyone");

    /// ForeverMoney's operator holds the AlphaVault (adminHold, for ten years): every conversion reverts IsHalted
    /// until `av.unpause()`.
    function holdRail() internal {
        av.adminHold(vm.getBlockTimestamp() + 3650 days);
    }

    /// ForeverMoney's staked position, in rao: where a conversion's TAO goes, or comes from (the double's own native
    /// balance is not meaningful after a refused conversion: MockAlphaVault's harness note).
    function staked() internal view returns (uint256) {
        return av.stakedValueRao(address(taoBit));
    }

    function setUp() public {
        vm.etch(ISTAKING_ADDRESS, address(new MockStaking()).code);
        vm.etch(ADDRESS_MAPPING_ADDRESS, address(new MockAddressMapping()).code);
        staking.addHotkey(HK1);

        taoBit = new MockTAO(18);
        router = new MockRouter(taoBit);
        av = new MockAlphaVault(taoBit);
        vm.deal(address(av), 1_000e18);

        uint256 nonce = vm.getNonce(address(this));
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
        vault = new CascadeVault(
            defaultVaultParams(
                mirror(predictedVault), HK1, ICascadeBridge(address(adapter)), owner, guardian, keeper, BASE, frontDoor
            )
        );
        assertEq(address(vault), predictedVault);
        vaultLens = new CascadeVaultLens(address(vault));

        vm.deal(address(vault), RESERVE);
        adapter.fundReserve{value: RESERVE}();
        router.setFee(FEE);
        vm.deal(anyone, 1 ether);
    }

    // ---- helpers ----

    function entries1(address user, uint256 amount) internal pure returns (CascadeMessages.Entry[] memory e) {
        e = new CascadeMessages.Entry[](1);
        e[0] = CascadeMessages.Entry(user, amount);
    }

    function none() internal pure returns (CascadeMessages.Entry[] memory) {
        return new CascadeMessages.Entry[](0);
    }

    function depositBatch(uint64 id, address user, uint256 amount) internal pure returns (bytes memory) {
        return CascadeMessages.encodeBatch(id, entries1(user, amount), none());
    }

    function redeemBatch(uint64 id, address user, uint256 shares) internal pure returns (bytes memory) {
        return CascadeMessages.encodeBatch(id, none(), entries1(user, shares));
    }

    /// The CCIP message the OffRamp hands the adapter: `amount` of the bridged token (no token entry when 0) and the
    /// payload (recipient, sender, message), its id derived from all of them.
    function ccip(address recipient, address sender, bytes memory message, uint256 amount)
        internal
        view
        returns (Client.Any2EVMMessage memory m)
    {
        Client.EVMTokenAmount[] memory t = new Client.EVMTokenAmount[](amount == 0 ? 0 : 1);
        if (amount != 0) t[0] = Client.EVMTokenAmount(address(taoBit), amount);
        m = Client.Any2EVMMessage({
            messageId: keccak256(abi.encode(recipient, sender, message, amount)),
            sourceChainSelector: BASE_SELECTOR,
            sender: abi.encode(adapterBase),
            data: adapter.encodePayload(recipient, sender, message),
            destTokenAmounts: t
        });
    }

    /// The park key by its formula (spec §3.2), independent of the adapter.
    function keyOf(address recipient, address sender, bytes memory message) internal pure returns (bytes32) {
        return keccak256(abi.encode(BASE, sender, recipient, message));
    }

    /// Delivers `m` through the router double (tokens minted and the call made in one frame, as the 2.0 OffRamp).
    function deliver(Client.Any2EVMMessage memory m) internal returns (bool ok, bytes memory reason) {
        bool called;
        (called, ok, reason) = router.deliver(address(adapter), m, GAS);
        assertTrue(called, "the receiver was called");
    }

    /// A deposit batch to the vault from its door that delivers, unparked.
    function depositOk(uint64 id, address user, uint256 amount) internal {
        bytes memory message = depositBatch(id, user, amount);
        (bool ok,) = deliver(ccip(address(vault), frontDoor, message, amount));
        assertTrue(ok, "delivered");
        assertNotParked(keyOf(address(vault), frontDoor, message));
    }

    /// Delivers `message` with `amount` and expects it parked as native TAO (converted) for `reason`.
    function expectNativePark(address recipient, address sender, bytes memory message, uint256 amount, bytes4 reason)
        internal
        returns (bytes32 key)
    {
        key = expectPark(recipient, sender, message, amount, true, reason);
    }

    /// Delivers `message` with `amount` and expects it parked as tokens (unconverted) for `reason`.
    function expectTokenPark(address recipient, address sender, bytes memory message, uint256 amount, bytes4 reason)
        internal
        returns (bytes32 key)
    {
        key = expectPark(recipient, sender, message, amount, false, reason);
    }

    function expectPark(
        address recipient,
        address sender,
        bytes memory message,
        uint256 amount,
        bool converted,
        bytes4 reason
    ) internal returns (bytes32 key) {
        Client.Any2EVMMessage memory m = ccip(recipient, sender, message, amount);
        key = keyOf(recipient, sender, message);
        uint256 native = adapter.parkedNative();
        uint256 tokens = adapter.parkedTokens();
        vm.expectEmit(address(adapter));
        emit CcipBittensorAdapter.BatchParked(key, m.messageId, recipient, sender, amount, converted, reason);
        (bool ok,) = deliver(m);
        assertTrue(ok, "SUCCESS: the message is done, the batch parked");
        assertParked(key, amount, converted);
        assertEq(adapter.parkedNative(), converted ? native + amount : native, "parkedNative");
        assertEq(adapter.parkedTokens(), converted ? tokens : tokens + amount, "parkedTokens");
        assertOwed(adapter, taoBit);
    }

    /// Delivers `m` and expects the whole CCIP message to fail with the adapter's `expected` revert data (any, if
    /// empty): nothing parked, the token release rolled back.
    function expectFailure(Client.Any2EVMMessage memory m, bytes memory expected) internal {
        uint256 supply = taoBit.totalSupply();
        uint256 native = adapter.parkedNative();
        uint256 tokens = adapter.parkedTokens();
        (bool ok, bytes memory reason) = deliver(m);
        assertFalse(ok, "FAILURE");
        if (expected.length != 0) assertEq(inner(reason), expected);
        assertEq(taoBit.totalSupply(), supply, "no token released");
        assertEq(adapter.parkedNative(), native);
        assertEq(adapter.parkedTokens(), tokens);
    }

    function assertParked(bytes32 key, uint256 amount, bool converted) internal view {
        (uint128 a, uint64 parkedAt, bool c) = adapter.parked(key);
        assertEq(a, amount, "parked amount");
        assertEq(parkedAt, vm.getBlockTimestamp(), "parkedAt");
        assertEq(c, converted, "converted");
    }

    /// A token park of the door's `message` to `recipient`: ForeverMoney halted for its delivery (IsHalted), then back.
    function tokenPark(address recipient, bytes memory message, uint256 amount) internal returns (bytes32 key) {
        holdRail();
        key = expectTokenPark(recipient, frontDoor, message, amount, MockAlphaVault.IsHalted.selector);
        av.unpause();
    }

    /// `deliverParked` of the door's `message` to `recipient`, called by `anyone` (it is permissionless). Delivered,
    /// it expects ParkedDelivered and the record and its total gone; refused, ParkedConverted and the record a
    /// converted park of the same amount since the same parkedAt (a token park's amount moved from parkedTokens to
    /// parkedNative). I-7 after either.
    function expectDeliverParked(address recipient, bytes memory message, bool delivers)
        internal
        returns (bytes32 key)
    {
        key = keyOf(recipient, frontDoor, message);
        (uint128 amount, uint64 since, bool converted) = adapter.parked(key);
        assertTrue(since != 0, "parked before the call");
        uint256 native = adapter.parkedNative();
        uint256 tokens = adapter.parkedTokens();
        vm.expectEmit(address(adapter));
        if (delivers) emit CcipBittensorAdapter.ParkedDelivered(key);
        else emit CcipBittensorAdapter.ParkedConverted(key);
        vm.prank(anyone);
        adapter.deliverParked(recipient, frontDoor, message);
        assertEq(adapter.parkedTokens(), converted ? tokens : tokens - amount, "parkedTokens");
        if (delivers) {
            assertNotParked(key);
            assertEq(adapter.parkedNative(), converted ? native - amount : native, "parkedNative");
        } else {
            assertParkedSince(key, amount, true, since);
            assertEq(adapter.parkedNative(), converted ? native : native + amount, "parkedNative");
        }
        assertOwed(adapter, taoBit);
    }

    /// `deliverParked` of the door's `message` to `recipient` with exactly `limit` gas, from a cold start (a
    /// transaction of its own on chain). Returns a lower bound on the gas it left unused, as receiveWithGas.
    function deliverParkedWithGas(address recipient, bytes memory message, uint256 limit)
        internal
        returns (uint256 left)
    {
        vm.cool(address(adapter));
        vm.cool(address(taoBit));
        vm.cool(address(av));
        vm.cool(recipient);
        uint256 g = gasleft();
        adapter.deliverParked{gas: limit}(recipient, frontDoor, message);
        left = limit - (g - gasleft());
    }

    function assertParkedSince(bytes32 key, uint256 amount, bool converted, uint64 since) internal view {
        (uint128 a, uint64 parkedAt, bool c) = adapter.parked(key);
        assertEq(a, amount, "parked amount");
        assertEq(parkedAt, since, "parkedAt");
        assertEq(c, converted, "converted");
    }

    function entries2(address a, uint256 x, address b, uint256 y)
        internal
        pure
        returns (CascadeMessages.Entry[] memory e)
    {
        e = new CascadeMessages.Entry[](2);
        e[0] = CascadeMessages.Entry(a, x);
        e[1] = CascadeMessages.Entry(b, y);
    }

    /// A deposit batch of alice's `a` and bob's `b`.
    function twoDeposits(uint64 id, uint256 a, uint256 b) internal view returns (bytes memory) {
        return CascadeMessages.encodeBatch(id, entries2(alice, a, bob, b), none());
    }

    /// The CCIP message a refund of the park of the door's `message` to `recipient` hands the router, by its formula
    /// (spec §3.2), independent of the adapter: to the Base adapter; the payload with the door as its recipient and
    /// the park's recipient (the vault) as its sender, so the door takes it as a payout from its vault (I-9), and
    /// PAYOUTS(the park's key, REFUND_CHUNK, `deposits`) as its message; `amount` of the token; the gas the model
    /// gives `deposits`' entries.
    function refundMessage(
        address recipient,
        bytes memory message,
        CascadeMessages.Entry[] memory deposits,
        uint256 amount
    ) internal view returns (Client.EVM2AnyMessage memory m) {
        bytes memory payouts =
            CascadeMessages.encodePayouts(keyOf(recipient, frontDoor, message), REFUND_CHUNK, deposits);
        m.receiver = abi.encode(adapterBase);
        // the payload is (recipient, sender, message)
        m.data = abi.encode(frontDoor, recipient, payouts);
        m.tokenAmounts = new Client.EVMTokenAmount[](1);
        m.tokenAmounts[0] = Client.EVMTokenAmount(address(taoBit), amount);
        m.feeToken = address(0);
        m.extraArgs = adapter.extraArgs(1_000_000 + deposits.length * 25_000);
    }

    /// `refundParked` of the door's `message` to `recipient`, by `anyone` with `value`. Expects Sent (the park's
    /// recipient as sender, the door as recipient) and then ParkedRefunded with the router's next message id; the
    /// router's message is refundMessage of `deposits` (each depositor's exact deposit), paid exactly the router's
    /// fee; then the record gone, the park's own total lowered by its amount and the other unchanged, the router's
    /// approval reset, and I-7.
    function expectRefund(
        address recipient,
        bytes memory message,
        CascadeMessages.Entry[] memory deposits,
        uint256 value
    ) internal returns (bytes32 id) {
        bytes32 key = keyOf(recipient, frontDoor, message);
        (uint128 amount,, bool converted) = adapter.parked(key);
        assertGt(amount, 0, "parked with an amount");
        uint256 native = adapter.parkedNative();
        uint256 tokens = adapter.parkedTokens();
        Client.EVM2AnyMessage memory expected = refundMessage(recipient, message, deposits, amount);
        id = keccak256(abi.encode(router.sendCount() + 1));
        vm.expectEmit(address(adapter));
        emit CcipAdapterBase.Sent(id, BASE, recipient, frontDoor, amount, FEE, 1_000_000 + deposits.length * 25_000);
        vm.expectEmit(address(adapter));
        emit CcipBittensorAdapter.ParkedRefunded(key, id);
        vm.prank(anyone);
        adapter.refundParked{value: value}(recipient, frontDoor, message);
        MockRouter.Sent memory s = router.lastSend();
        assertEq(s.messageId, id);
        assertEq(s.destSelector, BASE_SELECTOR, "toward Base");
        assertEq(s.receiver, expected.receiver, "to the Base adapter");
        assertEq(
            s.data, expected.data, "PAYOUTS of each deposit, the park's recipient its sender, the door its recipient"
        );
        assertEq(s.tokenAmounts.length, 1);
        assertEq(s.tokenAmounts[0].token, address(taoBit));
        assertEq(s.tokenAmounts[0].amount, amount, "the park's whole amount");
        assertEq(s.feeToken, address(0));
        assertEq(s.extraArgs, expected.extraArgs, "the gas for the deposits' entries");
        assertEq(s.value, FEE, "the router paid exactly its fee");
        assertNotParked(key);
        assertEq(adapter.parkedNative(), converted ? native - amount : native, "parkedNative");
        assertEq(adapter.parkedTokens(), converted ? tokens : tokens - amount, "parkedTokens");
        assertEq(taoBit.allowance(address(adapter), address(router)), 0, "the approval reset");
        assertOwed(adapter, taoBit);
    }

    function assertNotParked(bytes32 key) internal view {
        (uint128 a, uint64 parkedAt, bool c) = adapter.parked(key);
        assertEq(a, 0);
        assertEq(parkedAt, 0, "no record");
        assertFalse(c);
    }

    /// The adapter's own revert data, unwrapped from the router's DeliveryFailed(bytes).
    function inner(bytes memory reason) internal pure returns (bytes memory out) {
        bytes memory body = new bytes(reason.length - 4);
        for (uint256 i; i < body.length; ++i) {
            body[i] = reason[i + 4];
        }
        out = abi.decode(body, (bytes));
    }

    /// `ccipReceive` of `m` called as the router with exactly `limit` gas, from a cold start (the delivery is a
    /// transaction of its own on chain); the caller has released the tokens to the adapter first, as the OffRamp
    /// does. Returns a lower bound on the gas the adapter left unused: the limit less what the call cost this frame,
    /// which also counts the call's own cold access and argument copy.
    function receiveWithGas(Client.Any2EVMMessage memory m, uint256 limit) internal returns (uint256 left) {
        vm.cool(address(adapter));
        vm.cool(address(taoBit));
        vm.cool(address(av));
        vm.cool(address(vault));
        vm.prank(address(router));
        uint256 g = gasleft();
        adapter.ccipReceive{gas: limit}(m);
        left = limit - (g - gasleft());
    }

    // ---- conversion failures park the tokens ----

    /// A conversion short by more than SHORTFALL_TOLERANCE_WEI (1 rao) is refused inside ForeverMoney (R3 FM-L1: its
    /// withdrawLiquid checks the TAO it measured, `taoOut < minTaoOut`, against the amount less 1 rao: `Slippage`),
    /// which reverts convertExact and rolls ForeverMoney's burn back with it: the batch parks as the tokens the pool
    /// released, with ForeverMoney's reason, the position unstaked by nothing, and the reserve untouched. Exactly 1 rao
    /// short passes ForeverMoney's check, is covered from the reserve and delivers.
    function test_shortConversionRollsTheBurnBackAndParksTokens() public {
        uint256 snap = vm.snapshotState();
        av.setShortBy(1e9);
        depositOk(1, alice, 10e18);
        assertEq(address(adapter).balance, RESERVE - 1e9, "the rao came from the reserve");
        assertEq(vault.balanceOf(alice), 1e25);

        vm.revertToState(snap);
        av.setShortBy(2e9);
        uint256 stakedBefore = staked();
        expectTokenPark(
            address(vault), frontDoor, depositBatch(1, alice, 10e18), 10e18, MockAlphaVault.Slippage.selector
        );
        assertEq(taoBit.balanceOf(address(adapter)), 10e18, "the burn rolled back");
        assertEq(taoBit.totalSupply(), 10e18);
        assertEq(staked(), stakedBefore, "the unstake rolled back: ForeverMoney paid nothing");
        assertEq(address(adapter).balance, RESERVE);
        assertEq(adapter.parkedNative(), 0);
        assertEq(vault.totalSupply(), 0);
        assertEq(address(vault).balance, RESERVE);
    }

    /// Below the chain's staking floor (0.002 TAO; the root key can raise it) convertExact reverts
    /// BelowConversionFloor: the batch parks as tokens (L-9), refundable as they are (Task 27).
    function test_subFloorAmountParksTokens() public {
        expectTokenPark(
            address(vault), frontDoor, depositBatch(1, alice, 1e15), 1e15, CcipAdapterBase.BelowConversionFloor.selector
        );
        // a raised floor parks a batch the old one would have taken
        staking.setMinStake(20_000_000);
        expectTokenPark(
            address(vault), frontDoor, depositBatch(2, alice, 1e16), 1e16, CcipAdapterBase.BelowConversionFloor.selector
        );
        assertEq(adapter.parkedTokens(), 1.1e16);
        assertEq(taoBit.balanceOf(address(adapter)), 1.1e16);
        assertEq(address(adapter).balance, RESERVE);
    }

    /// The floor is read inside convertExact's frame, so a failing read parks the tokens too, its selector the
    /// reason; an empty revert reads 0x00000000.
    function test_failingFloorReadParksTokens() public {
        bytes memory read = abi.encodeWithSelector(IStaking.getDefaultMinStake.selector);
        vm.mockCallRevert(ISTAKING_ADDRESS, read, abi.encodeWithSignature("ReadGone()"));
        expectTokenPark(address(vault), frontDoor, depositBatch(1, alice, 1e18), 1e18, bytes4(keccak256("ReadGone()")));
        vm.mockCallRevert(ISTAKING_ADDRESS, read, "");
        expectTokenPark(address(vault), frontDoor, depositBatch(2, alice, 1e18), 1e18, bytes4(0));
        assertEq(adapter.parkedTokens(), 2e18);
    }

    /// A conversion whose withdrawLiquid consumes all the gas it is given still leaves a record: convertExact runs
    /// with all but PARK_GAS_RESERVE, so the token park is written from the reserve, at any gas limit, with at least
    /// SPARE to spare. Logs a lower bound on the gas left unused after the park (it grows with the limit:
    /// withdrawLiquid burns 63/64 of convertExact's gas, and convertExact's last 64th comes back with its revert).
    function test_gasBurningConversionStillLeavesARecord() public {
        av.setBurnGas(true);
        bytes memory message = depositBatch(1, alice, 10e18);
        bytes32 key = keyOf(address(vault), frontDoor, message);
        uint256[3] memory limits = [uint256(1_000_000), 3_000_000, 7_000_000];
        for (uint256 i; i < limits.length; ++i) {
            uint256 snap = vm.snapshotState();
            Client.Any2EVMMessage memory m = ccip(address(vault), frontDoor, message, 10e18);
            taoBit.mint(address(adapter), 10e18);
            vm.expectEmit(address(adapter));
            emit CcipBittensorAdapter.BatchParked(key, m.messageId, address(vault), frontDoor, 10e18, false, bytes4(0));
            uint256 left = receiveWithGas(m, limits[i]);
            assertParked(key, 10e18, false);
            assertEq(adapter.parkedTokens(), 10e18);
            assertEq(taoBit.balanceOf(address(adapter)), 10e18);
            assertOwed(adapter, taoBit);
            emit log_named_uint(string.concat("token park: gas left unused, limit ", vm.toString(limits[i])), left);
            assertGe(left, SPARE, "the reserve outlasts the park");
            vm.revertToState(snap);
        }
    }

    /// A conversion whose withdrawLiquid reverts with a returndata bomb still parks (review round 1, M4): the adapter
    /// reads only the reason's 4 bytes, so no length of revert data reaches the reserve. convertExact bubbles the
    /// bomb when it can afford to copy it (the alpha vault's unused gas comes back with its revert): a 64 KiB bomb at
    /// every limit, and a 1 MiB one (about 2.3M gas to copy) at 5M and 7M, each parking with the bomb's selector; at
    /// 3M it cannot, fails out of gas in its own frame, and the batch parks with 0x00000000. Every case writes the
    /// park with SPARE to spare. At 5M a catch that copied the 1 MiB it caught would run out of gas, so the case pins
    /// the 4-byte read.
    function test_aConversionsReturndataBombStillParks() public {
        bytes memory message = depositBatch(1, alice, 10e18);
        bytes32 key = keyOf(address(vault), frontDoor, message);
        uint256[2] memory sizes = [uint256(1 << 16), 1 << 20];
        uint256[3] memory limits = [uint256(3_000_000), 5_000_000, 7_000_000];
        bytes4 b = MockAlphaVault.Bomb.selector;
        // reasons[size][limit]
        bytes4[3][2] memory reasons = [[b, b, b], [bytes4(0), b, b]];
        for (uint256 i; i < sizes.length; ++i) {
            for (uint256 j; j < limits.length; ++j) {
                uint256 snap = vm.snapshotState();
                av.setRevertBomb(sizes[i]);
                Client.Any2EVMMessage memory m = ccip(address(vault), frontDoor, message, 10e18);
                taoBit.mint(address(adapter), 10e18);
                vm.expectEmit(address(adapter));
                emit CcipBittensorAdapter.BatchParked(
                    key, m.messageId, address(vault), frontDoor, 10e18, false, reasons[i][j]
                );
                uint256 left = receiveWithGas(m, limits[j]);
                assertParked(key, 10e18, false);
                assertEq(taoBit.balanceOf(address(adapter)), 10e18);
                assertOwed(adapter, taoBit);
                assertGe(left, SPARE, "the reserve outlasts the park");
                emit log_named_uint(
                    string.concat(
                        "conversion bomb ", vm.toString(sizes[i]), " B, limit ", vm.toString(limits[j]), ": gas left"
                    ),
                    left
                );
                vm.revertToState(snap);
            }
        }
    }

    // ---- recipient failures park the native TAO ----

    /// A recipient that reverts with a 1 MiB returndata bomb still leaves a native park, its reason the bomb's
    /// selector (review round 1, M4): the adapter reads the 4 bytes alone, so copying the rest (about 2.2M gas of
    /// memory) never falls on the reserve.
    function test_aRecipientsReturndataBombStillParks() public {
        address bomb = address(new ReturnBombReceiver(1 << 20));
        bytes memory message = depositBatch(1, alice, 10e18);
        bytes32 key = keyOf(bomb, frontDoor, message);
        uint256[2] memory limits = [uint256(3_000_000), 7_000_000];
        for (uint256 i; i < limits.length; ++i) {
            uint256 snap = vm.snapshotState();
            Client.Any2EVMMessage memory m = ccip(bomb, frontDoor, message, 10e18);
            taoBit.mint(address(adapter), 10e18);
            vm.expectEmit(address(adapter));
            emit CcipBittensorAdapter.BatchParked(
                key, m.messageId, bomb, frontDoor, 10e18, true, ReturnBombReceiver.Bomb.selector
            );
            uint256 left = receiveWithGas(m, limits[i]);
            assertParked(key, 10e18, true);
            assertEq(adapter.parkedNative(), 10e18);
            assertOwed(adapter, taoBit);
            assertGe(left, SPARE, "the reserve outlasts the park");
            emit log_named_uint(
                string.concat("recipient bomb 1 MiB, limit ", vm.toString(limits[i]), ": gas left"), left
            );
            vm.revertToState(snap);
        }
    }

    /// Every refusal of the vault parks the converted TAO (spec §3.2 step 4): paused (EnforcedPause), a door it does
    /// not know (UnknownPeer), stake missing (StakeMissing). The records add up to parkedNative, the adapter holds
    /// them beside its reserve, and the vault is untouched.
    function test_vaultRefusalParksNative() public {
        depositOk(1, alice, 10e18);
        vm.prank(keeper);
        vault.stakeIdle();
        uint256 vaultBalance = address(vault).balance;
        uint256 supply = vault.totalSupply();

        vm.prank(guardian);
        vault.pause();
        expectNativePark(address(vault), frontDoor, depositBatch(2, bob, 1e18), 1e18, Pausable.EnforcedPause.selector);
        vm.prank(owner);
        vault.unpause();

        expectNativePark(address(vault), makeAddr("stranger"), depositBatch(1, bob, 2e18), 2e18, UnknownPeer.selector);

        staking.swapHotkey(HK1, HK5, vaultLens.coldkey(), 5_000);
        assertTrue(vaultLens.stakeMissing());
        expectNativePark(address(vault), frontDoor, depositBatch(3, bob, 3e18), 3e18, StakeMissing.selector);

        assertEq(adapter.parkedNative(), 6e18, "the sum of the records");
        assertEq(address(adapter).balance, RESERVE + 6e18);
        assertEq(adapter.parkedTokens(), 0);
        assertEq(taoBit.balanceOf(address(adapter)), 0);
        assertEq(address(vault).balance, vaultBalance);
        assertEq(vault.totalSupply(), supply);
    }

    /// A recipient that consumes all its gas still leaves a record: it is called with all but PARK_GAS_RESERVE, so
    /// the native park is written from the reserve, at any gas limit, its reason 0x00000000, with at least SPARE to
    /// spare. Logs a lower bound on the gas left unused after the park.
    function test_gasBurningVaultStillLeavesARecord() public {
        address burner = address(new GasBurningReceiver());
        bytes memory message = depositBatch(1, alice, 10e18);
        bytes32 key = keyOf(burner, frontDoor, message);
        uint256[3] memory limits = [uint256(1_000_000), 3_000_000, 7_000_000];
        for (uint256 i; i < limits.length; ++i) {
            uint256 snap = vm.snapshotState();
            Client.Any2EVMMessage memory m = ccip(burner, frontDoor, message, 10e18);
            taoBit.mint(address(adapter), 10e18);
            vm.expectEmit(address(adapter));
            emit CcipBittensorAdapter.BatchParked(key, m.messageId, burner, frontDoor, 10e18, true, bytes4(0));
            uint256 left = receiveWithGas(m, limits[i]);
            assertParked(key, 10e18, true);
            assertEq(adapter.parkedNative(), 10e18);
            assertEq(address(adapter).balance, RESERVE + 10e18);
            assertEq(taoBit.balanceOf(address(adapter)), 0);
            assertOwed(adapter, taoBit);
            emit log_named_uint(string.concat("native park: gas left unused, limit ", vm.toString(limits[i])), left);
            assertGe(left, SPARE, "the reserve outlasts the park");
            vm.revertToState(snap);
        }
    }

    /// The covering rao of a conversion comes from the reserve, never from parked TAO: with the reserve drained (the
    /// adapter holding exactly its native parks), a conversion 1 rao short, within the tolerance, passes ForeverMoney's
    /// check and fails convertExact's second one (the balance must still cover parkedNative + amount): the adapter's
    /// ConversionShort, the one a live delivery can meet (R3 FM-L1). It parks as tokens, the native parks untouched.
    /// Topped up, the same shortfall comes out of the reserve and the batch delivers.
    function test_topUpThatWouldDipIntoParkedNativeParksTokens() public {
        vm.prank(guardian);
        vault.pause();
        expectNativePark(address(vault), frontDoor, depositBatch(1, alice, 5e18), 5e18, Pausable.EnforcedPause.selector);
        vm.prank(owner);
        vault.unpause();

        vm.deal(address(adapter), 5e18);
        av.setShortBy(1e9);
        expectTokenPark(
            address(vault), frontDoor, depositBatch(2, bob, 1e18), 1e18, CcipAdapterBase.ConversionShort.selector
        );
        assertEq(address(adapter).balance, 5e18, "the native parks untouched");
        assertEq(adapter.parkedNative(), 5e18);
        assertEq(taoBit.balanceOf(address(adapter)), 1e18);

        adapter.fundReserve{value: RESERVE}();
        depositOk(3, carol, 1e18);
        assertEq(address(adapter).balance, 5e18 + RESERVE - 1e9, "the rao from the reserve");
        assertEq(vault.balanceOf(carol), 1e24);
    }

    // ---- redeem-only batches ----

    /// A redeem-only batch carries no tokens and needs no conversion (L-A): it is delivered with no call to the
    /// alpha vault, even while ForeverMoney is paused. Paused, the adapter cannot send payouts (canSendPayouts, R4
    /// S-H1), so the vault defers the redeem rather than burn it into a queue that could not be paid; once the pause
    /// ends, the next redeem-only batch burns, again with no conversion.
    function test_redeemOnlyBatchDeliversWithoutConversion() public {
        depositOk(1, alice, 10e18);
        // alice's shares held a day, so her redeem is not held (the door hold, R4 B-H1)
        vm.warp(vm.getBlockTimestamp() + 1 days);
        holdRail();
        assertFalse(adapter.canSendPayouts(), "paused: no payouts");
        bytes memory message = redeemBatch(2, alice, 1e24);
        // no conversion in either delivery below
        vm.expectCall(address(av), abi.encodeWithSelector(IAlphaVault.withdrawLiquid.selector), 0);
        (bool ok,) = deliver(ccip(address(vault), frontDoor, message, 0));
        assertTrue(ok);
        assertNotParked(keyOf(address(vault), frontDoor, message));
        assertEq(vault.balanceOf(alice), 1e25, "deferred while the rail cannot pay");
        assertEq(vaultLens.pendingPayouts(), 0);

        av.unpause();
        assertTrue(adapter.canSendPayouts());
        message = redeemBatch(3, alice, 1e24);
        (ok,) = deliver(ccip(address(vault), frontDoor, message, 0));
        assertTrue(ok);
        assertNotParked(keyOf(address(vault), frontDoor, message));
        assertEq(vault.balanceOf(alice), 9e24);
        assertEq(vaultLens.pendingPayouts(), 1e18);
    }

    /// Refused, a redeem-only batch parks the same way with amount 0 (converted, nothing owed), and its record
    /// still holds the key: the same batch again is AlreadyParked (Task 26 delivers it; Task 27's dropParked
    /// removes it after PARK_TIMEOUT).
    function test_redeemOnlyBatchParksEmptyOnRefusal() public {
        depositOk(1, alice, 10e18);
        vm.prank(guardian);
        vault.pause();
        bytes memory message = redeemBatch(2, alice, 1e24);
        expectNativePark(address(vault), frontDoor, message, 0, Pausable.EnforcedPause.selector);
        assertEq(adapter.parkedNative(), 0);
        assertEq(address(adapter).balance, RESERVE);
        assertEq(vault.balanceOf(alice), 1e25, "nothing burned");

        vm.prank(owner);
        vault.unpause();
        Client.Any2EVMMessage memory again = ccip(address(vault), frontDoor, message, 0);
        again.messageId = bytes32(uint256(77));
        expectFailure(again, abi.encodeWithSelector(CcipBittensorAdapter.AlreadyParked.selector));
    }

    // ---- what still reverts ----

    /// A malformed batch reverts the whole message (CCIP FAILURE; only a malformed sender produces one): deposits
    /// that do not sum to the tokens carried (AmountMismatch), a message of another kind, too many entries, or one
    /// that does not decode. Nothing is parked and the token release is rolled back.
    function test_malformedBatchReverts() public {
        bytes memory mismatch = abi.encodeWithSelector(AmountMismatch.selector);
        expectFailure(ccip(address(vault), frontDoor, depositBatch(1, alice, 2e18), 1e18), mismatch);
        expectFailure(ccip(address(vault), frontDoor, depositBatch(2, alice, 1e18), 0), mismatch);
        expectFailure(ccip(address(vault), frontDoor, redeemBatch(3, alice, 1e24), 1e18), mismatch);
        expectFailure(
            ccip(
                address(vault),
                frontDoor,
                CascadeMessages.encodePayouts(bytes32(uint256(1)), 0, entries1(alice, 1e18)),
                1e18
            ),
            abi.encodeWithSelector(
                CascadeMessages.WrongMessageKind.selector, CascadeMessages.BATCH, CascadeMessages.PAYOUTS
            )
        );
        CascadeMessages.Entry[] memory many = new CascadeMessages.Entry[](51);
        for (uint256 i; i < many.length; ++i) {
            many[i] = CascadeMessages.Entry(alice, 1e18);
        }
        expectFailure(
            ccip(address(vault), frontDoor, CascadeMessages.encodeBatch(4, many, none()), 51e18),
            abi.encodeWithSelector(CascadeMessages.TooManyEntries.selector)
        );
        // a BATCH kind word and nothing after it
        expectFailure(ccip(address(vault), frontDoor, abi.encode(uint8(1)), 0), "");
        assertEq(address(adapter).balance, RESERVE);
        assertEq(taoBit.balanceOf(address(adapter)), 0);
    }

    /// A recipient with no code still reverts the whole message, as on v3.1: Solidity checks the target has code
    /// before the try, outside it (only a sender that names such a recipient produces this, stranding its own
    /// tokens). The conversion is rolled back with it.
    function test_aRecipientWithNoCodeReverts() public {
        uint256 stakedBefore = staked();
        expectFailure(ccip(makeAddr("noCode"), frontDoor, depositBatch(1, alice, 1e18), 1e18), "");
        assertEq(staked(), stakedBefore, "the unstake rolled back");
        assertEq(address(adapter).balance, RESERVE);
    }

    /// An amount that is not whole rao reverts NotRaoAligned, after the sum check, as in v3.1.
    function test_notRaoAlignedReverts() public {
        expectFailure(
            ccip(address(vault), frontDoor, depositBatch(1, alice, 1e18 + 1), 1e18 + 1),
            abi.encodeWithSelector(CcipAdapterBase.NotRaoAligned.selector)
        );
    }

    /// A batch already parked reverts AlreadyParked: a second CCIP message of the same content (a new id), or the
    /// same one run again, leaves the record and the total as the first delivery wrote them, and its tokens are
    /// never released; still so once the vault would take it (a park is delivered by Task 26's deliverParked).
    function test_alreadyParked() public {
        vm.prank(guardian);
        vault.pause();
        bytes memory message = depositBatch(1, alice, 1e18);
        bytes32 key = expectNativePark(address(vault), frontDoor, message, 1e18, Pausable.EnforcedPause.selector);

        bytes memory already = abi.encodeWithSelector(CcipBittensorAdapter.AlreadyParked.selector);
        Client.Any2EVMMessage memory m = ccip(address(vault), frontDoor, message, 1e18);
        expectFailure(m, already);
        m.messageId = bytes32(uint256(77));
        expectFailure(m, already);
        vm.prank(owner);
        vault.unpause();
        expectFailure(m, already);

        assertParked(key, 1e18, true);
        assertEq(adapter.parkedNative(), 1e18);
        assertEq(address(adapter).balance, RESERVE + 1e18);
        assertEq(vault.balanceOf(alice), 0);
    }

    /// A token park needs the adapter's token balance to cover parkedTokens + amount (M-B: the pool has just
    /// released `amount`, so only wrong books fail it): forced wrong, the delivery reverts ReserveShort, a
    /// bookkeeping fault, and parks once the books are right.
    function test_reserveShortWhenTheBooksAreWrong() public {
        uint256 slot = stdstore.target(address(adapter)).sig("parkedTokens()").find();
        vm.store(address(adapter), bytes32(slot), bytes32(uint256(1)));
        assertEq(adapter.parkedTokens(), 1);
        bytes memory message = depositBatch(1, alice, 1e15);
        expectFailure(
            ccip(address(vault), frontDoor, message, 1e15),
            abi.encodeWithSelector(CcipBittensorAdapter.ReserveShort.selector)
        );

        vm.store(address(adapter), bytes32(slot), bytes32(0));
        expectTokenPark(address(vault), frontDoor, message, 1e15, CcipAdapterBase.BelowConversionFloor.selector);
    }

    // ---- the lock and the self-only conversion ----

    /// convertExact is the adapter's own: anyone else is refused (OnlySelf), even with tokens in hand.
    function test_convertExactIsSelfOnly() public {
        taoBit.mint(address(this), 1e18);
        vm.expectRevert(CcipBittensorAdapter.OnlySelf.selector);
        adapter.convertExact(1e18);
    }

    /// A recipient that re-enters through the router (the real lane's manual execution is permissionless) is refused
    /// by the lock over every inbound path (H-3, I-11): the inner delivery fails ReentrancyGuardReentrantCall, its
    /// tokens never released, and neither the records nor the totals move but for the outer batch's own park when
    /// the recipient then reverts.
    function test_aRecipientReenteringThroughTheRouterIsRefusedByTheLock() public {
        RouterReentrantReceiver r = new RouterReentrantReceiver(router, address(adapter));
        bytes memory innerMessage = depositBatch(2, bob, 1e18);
        r.arm(ccip(address(vault), frontDoor, innerMessage, 1e18), false);
        bytes memory refused = abi.encodeWithSelector(
            MockRouter.DeliveryFailed.selector,
            abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
        );

        uint256 snap = vm.snapshotState();
        (bool ok,) = deliver(ccip(address(r), frontDoor, depositBatch(1, alice, 1e18), 1e18));
        assertTrue(ok, "the outer delivery accepted");
        assertFalse(r.reentryOk());
        assertEq(r.reentryReason(), refused);
        assertEq(address(r).balance, 1e18);
        assertNotParked(keyOf(address(vault), frontDoor, innerMessage));
        assertEq(adapter.parkedNative(), 0);
        assertEq(taoBit.totalSupply(), 0, "the inner release rolled back, the outer converted");

        vm.revertToState(snap);
        r.arm(ccip(address(vault), frontDoor, innerMessage, 1e18), true);
        expectNativePark(
            address(r), frontDoor, depositBatch(1, alice, 1e18), 1e18, RouterReentrantReceiver.Reentered.selector
        );
        assertNotParked(keyOf(address(vault), frontDoor, innerMessage));
        assertEq(adapter.parkedNative(), 1e18, "the outer batch's own park alone");
        assertEq(address(adapter).balance, RESERVE + 1e18);
        assertEq(taoBit.totalSupply(), 0);
    }

    // ---- a held lock's refusal reverts, it never parks (R3 CC-L1) ----

    /// A recipient that refuses with ReentrancyGuardReentrantCall (the vault while a stranger's code runs under its
    /// lock) has not answered the batch; the lock is released when that outer transaction ends. So the adapter reverts
    /// the whole delivery instead of parking it: CCIP records FAILURE, nothing is written and no token is released,
    /// and it is re-executed later with the committee's verifierResults, which the OffRamp checks on every execution, a
    /// FAILURE's included (R3's CC-L3 reading corrected; at launch the founder re-executes it by hand). A redeem-only
    /// batch alike. Once the lock is free the same message delivers. Any other refusal still parks.
    function test_aHeldLockRevertsTheDeliveryWhole() public {
        LockedReceiver r = new LockedReceiver();
        r.setLocked(true);
        bytes memory locked = abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        bytes memory message = depositBatch(1, alice, 10e18);
        Client.Any2EVMMessage memory m = ccip(address(r), frontDoor, message, 10e18);
        bytes memory redeems = redeemBatch(2, alice, 1e24);
        expectFailure(m, locked);
        expectFailure(ccip(address(r), frontDoor, redeems, 0), locked);
        assertNotParked(keyOf(address(r), frontDoor, message));
        assertNotParked(keyOf(address(r), frontDoor, redeems));
        assertEq(address(adapter).balance, RESERVE, "no native moved");
        assertEq(taoBit.balanceOf(address(adapter)), 0, "no token held");
        assertEq(r.delivered(), 0);

        r.setLocked(false);
        (bool ok,) = deliver(m);
        assertTrue(ok, "re-executed, it delivers");
        assertEq(r.delivered(), 1);
        assertEq(address(r).balance, 10e18);
        assertNotParked(keyOf(address(r), frontDoor, message));

        r.setRefusing(true);
        expectNativePark(address(r), frontDoor, depositBatch(3, bob, 1e18), 1e18, LockedReceiver.Refused.selector);
    }

    /// deliverParked meets the same rule: a recipient refusing with ReentrancyGuardReentrantCall reverts the whole call
    /// with it, so the park stays exactly as it was. A token park is not converted (it can still be refunded as its
    /// tokens, with no rail) and a native park keeps its first parkedAt; neither total moves. Once the lock is free each
    /// delivers.
    function test_deliverParkedKeepsTheParkWhenAHeldLockRefuses() public {
        LockedReceiver r = new LockedReceiver();
        bytes memory tokens = depositBatch(1, alice, 10e18);
        bytes32 tokenKey = tokenPark(address(r), tokens, 10e18);
        r.setRefusing(true);
        bytes memory native = depositBatch(2, bob, 4e18);
        bytes32 nativeKey = expectNativePark(address(r), frontDoor, native, 4e18, LockedReceiver.Refused.selector);
        uint64 since = uint64(vm.getBlockTimestamp());
        r.setRefusing(false);
        r.setLocked(true);
        vm.warp(since + 1 days);

        vm.startPrank(anyone);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        adapter.deliverParked(address(r), frontDoor, tokens);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        adapter.deliverParked(address(r), frontDoor, native);
        vm.stopPrank();
        assertParkedSince(tokenKey, 10e18, false, since);
        assertParkedSince(nativeKey, 4e18, true, since);
        assertEq(adapter.parkedTokens(), 10e18, "the token park not converted");
        assertEq(adapter.parkedNative(), 4e18);
        assertEq(taoBit.balanceOf(address(adapter)), 10e18, "nothing burned");
        assertEq(address(adapter).balance, RESERVE + 4e18);

        r.setLocked(false);
        expectDeliverParked(address(r), tokens, true);
        expectDeliverParked(address(r), native, true);
        assertEq(r.delivered(), 2);
        assertEq(address(r).balance, 14e18);
    }

    /// The deployed-OffRamp scenario of R3 CC-L1 (its fork PoC), with the router double: a stranger with direct shares
    /// calls redeemDirect, and from the payment it takes inside the vault's lock it delivers an honest door batch. The
    /// adapter's lock is free there and the conversion runs, but the vault refuses with ReentrancyGuardReentrantCall,
    /// so the inner delivery reverts whole: no park, no token released, the stranger's redeem itself paid. Delivered
    /// again outside the lock, the batch mints alice her shares (before R3 it parked native on its first delivery,
    /// its CCIP message spent).
    function test_aStrangerUnderTheVaultsLockCannotParkAnHonestBatch() public {
        VaultLockStranger s = new VaultLockStranger(vault, router, address(adapter));
        vm.deal(address(s), 1e16);
        vm.prank(address(s));
        s.buyShares{value: 1e16}();
        assertGt(vault.balanceOf(address(s)), 0, "direct shares");
        bytes memory message = depositBatch(1, alice, 1e18);
        Client.Any2EVMMessage memory m = ccip(address(vault), frontDoor, message, 1e18);
        s.arm(m);

        s.attack();
        assertTrue(s.tried(), "delivered from inside the vault's lock");
        assertFalse(s.innerOk(), "the inner delivery failed whole");
        assertEq(
            s.innerReason(),
            abi.encodeWithSelector(
                MockRouter.DeliveryFailed.selector,
                abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
            )
        );
        assertNotParked(keyOf(address(vault), frontDoor, message));
        assertEq(adapter.parkedNative(), 0);
        assertEq(taoBit.totalSupply(), 0, "the release rolled back");
        assertEq(address(adapter).balance, RESERVE);
        assertEq(vault.balanceOf(address(s)), 0, "the stranger's own redeem paid");
        assertEq(vault.balanceOf(alice), 0);

        (bool ok,) = deliver(m);
        assertTrue(ok);
        assertNotParked(keyOf(address(vault), frontDoor, message));
        assertEq(vault.balanceOf(alice), 1e24, "minted once, outside the lock");
    }

    /// The same grief one call earlier (R3 fix round 2): ForeverMoney's withdrawLiquid pays its caller inside its own
    /// lock, so a stranger withdrawing there can deliver an honest batch from the payment. The adapter's lock is free,
    /// but its conversion meets ForeverMoney's (OpenZeppelin v5's ReentrancyGuardReentrantCall): the adapter reverts
    /// the whole delivery rather than park the tokens, so nothing is written, no token released, and the message stays
    /// re-executable; the stranger's own withdrawal is paid. Delivered again outside the lock, the batch mints.
    function test_aStrangerUnderForeverMoneysLockCannotParkAnHonestBatch() public {
        AlphaVaultLockStranger s = new AlphaVaultLockStranger(av, taoBit, router, adapter);
        taoBit.mint(address(s), 1e18);
        bytes memory message = depositBatch(1, alice, 10e18);
        Client.Any2EVMMessage memory m = ccip(address(vault), frontDoor, message, 10e18);
        s.armDelivery(m);

        s.withdraw(1e18);
        assertTrue(s.tried(), "delivered from inside ForeverMoney's lock");
        assertFalse(s.innerOk(), "the inner delivery failed whole");
        assertEq(
            s.innerReason(),
            abi.encodeWithSelector(
                MockRouter.DeliveryFailed.selector,
                abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
            )
        );
        assertNotParked(keyOf(address(vault), frontDoor, message));
        assertEq(adapter.parkedTokens(), 0);
        assertEq(taoBit.totalSupply(), 0, "the release rolled back (and the stranger's own token burned)");
        assertEq(address(adapter).balance, RESERVE);
        assertEq(address(s).balance, 1e18, "the stranger's own withdrawal paid");

        (bool ok,) = deliver(m);
        assertTrue(ok);
        assertNotParked(keyOf(address(vault), frontDoor, message));
        assertEq(vault.balanceOf(alice), 1e25, "minted once, outside the lock");
    }

    /// deliverParked converts with no try, so meeting ForeverMoney's lock it reverts whole with that refusal, and the
    /// token park stays exactly as it was (unconverted, its first parkedAt); outside the lock it delivers.
    function test_deliverParkedUnderForeverMoneysLockKeepsTheTokenPark() public {
        bytes memory message = depositBatch(1, alice, 10e18);
        bytes32 key = tokenPark(address(vault), message, 10e18);
        AlphaVaultLockStranger s = new AlphaVaultLockStranger(av, taoBit, router, adapter);
        taoBit.mint(address(s), 1e18);
        s.armDeliverParked(address(vault), frontDoor, message);

        s.withdraw(1e18);
        assertTrue(s.tried());
        assertFalse(s.innerOk(), "deliverParked reverted");
        assertEq(s.innerReason(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        assertParked(key, 10e18, false);
        assertEq(adapter.parkedTokens(), 10e18);
        assertEq(adapter.parkedNative(), 0);
        assertEq(taoBit.balanceOf(address(adapter)), 10e18, "nothing burned");

        expectDeliverParked(address(vault), message, true);
        assertEq(vault.balanceOf(alice), 1e25);
    }

    // ---- the vault's supply-0 refusal (Task 25's carry from Task 10c) ----

    /// At a supply of 0 an underwater vault reverts a delivery VaultInsolvent, and the adapter parks it whole as
    /// native TAO: bob's deposit never reaches the hole in alice's queued payout. Not underwater, a supply-0
    /// delivery mints.
    function test_supply0UnderwaterDeliveryParksNative() public {
        depositOk(1, alice, 10e18);
        // alice's shares held a day, so her redeem burns (the door hold, R4 B-H1)
        vm.warp(vm.getBlockTimestamp() + 1 days);
        (bool ok,) = deliver(ccip(address(vault), frontDoor, redeemBatch(2, alice, 1e25), 0));
        assertTrue(ok);
        assertEq(vault.totalSupply(), 0);
        assertEq(vaultLens.pendingPayouts(), 10e18);

        // 1 TAO of what backs alice's payout is lost: underwater, past the tolerance
        vm.deal(address(vault), address(vault).balance - 1e18);
        uint256 vaultBalance = address(vault).balance;
        expectNativePark(address(vault), frontDoor, depositBatch(3, bob, 3e18), 3e18, VaultInsolvent.selector);
        assertEq(vault.totalSupply(), 0);
        assertEq(vaultLens.pendingPayouts(), 10e18, "no bounce reserved");
        assertEq(address(vault).balance, vaultBalance, "bob's TAO is not the vault's");
        assertEq(address(adapter).balance, RESERVE + 3e18);

        vm.deal(address(vault), address(vault).balance + 1e18);
        depositOk(4, carol, 1e18);
        assertEq(vault.balanceOf(carol), 1e24);
    }

    // ---- deliverParked (Task 26) ----

    /// A token park (ForeverMoney paused at its delivery) is delivered by anyone once ForeverMoney is back:
    /// deliverParked converts it with convertExact, the self-call the lock does not cover, and pays the vault, which
    /// mints; the record and parkedTokens are gone, the tokens burned, the reserve untouched. A native park (the
    /// vault paused at its delivery) is delivered with no conversion.
    function test_deliverParkedConvertsAndDelivers() public {
        bytes memory message = depositBatch(1, alice, 10e18);
        tokenPark(address(vault), message, 10e18);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        uint256 stakedBefore = staked();
        vm.expectCall(address(av), abi.encodeCall(IAlphaVault.withdrawLiquid, (address(taoBit), 10e18, 10e18 - 1e9)), 1);
        expectDeliverParked(address(vault), message, true);
        assertEq(vault.balanceOf(alice), 1e25, "minted");
        assertEq(address(vault).balance, RESERVE + 10e18);
        assertEq(stakedBefore - staked(), 10e9, "unstaked from ForeverMoney's position");
        assertEq(taoBit.totalSupply(), 0, "the tokens burned");
        assertEq(address(adapter).balance, RESERVE, "the reserve untouched");
        assertEq(adapter.parkedTokens(), 0);
        assertEq(adapter.parkedNative(), 0);

        vm.prank(guardian);
        vault.pause();
        bytes memory second = depositBatch(2, bob, 2e18);
        expectNativePark(address(vault), frontDoor, second, 2e18, Pausable.EnforcedPause.selector);
        vm.prank(owner);
        vault.unpause();
        vm.expectCall(address(av), abi.encodeWithSelector(IAlphaVault.withdrawLiquid.selector), 0);
        expectDeliverParked(address(vault), second, true);
        assertEq(vault.balanceOf(bob), 2e24);
        assertEq(address(adapter).balance, RESERVE);
        assertEq(adapter.parkedNative(), 0);
    }

    /// While the vault still refuses, deliverParked converts a token park and the batch stays parked as native TAO
    /// (ParkedConverted): the amount moves from parkedTokens to parkedNative, the record keeps its amount and
    /// parkedAt, and the tokens are out of ForeverMoney's token. Once the vault accepts, the converted park is
    /// delivered with no second conversion.
    function test_deliverParkedConvertsAndStaysParked() public {
        bytes memory message = depositBatch(1, alice, 10e18);
        tokenPark(address(vault), message, 10e18);
        vm.prank(guardian);
        vault.pause();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        expectDeliverParked(address(vault), message, false);
        assertEq(adapter.parkedNative(), 10e18);
        assertEq(adapter.parkedTokens(), 0);
        assertEq(taoBit.balanceOf(address(adapter)), 0, "converted");
        assertEq(address(adapter).balance, RESERVE + 10e18);
        assertEq(vault.totalSupply(), 0);

        vm.prank(owner);
        vault.unpause();
        vm.expectCall(address(av), abi.encodeWithSelector(IAlphaVault.withdrawLiquid.selector), 0);
        expectDeliverParked(address(vault), message, true);
        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(address(adapter).balance, RESERVE);
    }

    /// A failed delivery restores the record with its first parkedAt (spec §3.2: "restore the record"), so retries
    /// never move the refund's PARK_TIMEOUT: anyone may call deliverParked, and a reset clock would let a caller
    /// postpone the refund forever (I-10). Three failed retries over 15 days leave it at the first park's time,
    /// past the timeout.
    function test_aFailedDeliveryKeepsItsParkedAt() public {
        vm.prank(guardian);
        vault.pause();
        bytes memory message = depositBatch(1, alice, 1e18);
        bytes32 key = expectNativePark(address(vault), frontDoor, message, 1e18, Pausable.EnforcedPause.selector);
        uint64 since = uint64(vm.getBlockTimestamp());
        for (uint256 i; i < 3; ++i) {
            vm.warp(vm.getBlockTimestamp() + 5 days);
            expectDeliverParked(address(vault), message, false);
        }
        assertParkedSince(key, 1e18, true, since);
        assertGt(vm.getBlockTimestamp(), since + adapter.PARK_TIMEOUT(), "the refund's clock ran on");
    }

    /// A conversion that still fails reverts deliverParked with its own error (no try: convertExact's revert is the
    /// call's), and the record stays as it was: ForeverMoney still halted (IsHalted), a conversion short past the
    /// tolerance (ForeverMoney's Slippage, R3 FM-L1), a sub-floor amount (BelowConversionFloor). Nothing is paid or
    /// burned.
    function test_deliverParkedRevertsWhenTheConversionFails() public {
        bytes memory message = depositBatch(1, alice, 10e18);
        holdRail();
        bytes32 key = expectTokenPark(address(vault), frontDoor, message, 10e18, MockAlphaVault.IsHalted.selector);
        bytes memory small = depositBatch(2, bob, 1e15);
        av.unpause();
        bytes32 smallKey =
            expectTokenPark(address(vault), frontDoor, small, 1e15, CcipAdapterBase.BelowConversionFloor.selector);
        uint256 stakedBefore = staked();

        holdRail();
        vm.prank(anyone);
        vm.expectRevert(MockAlphaVault.IsHalted.selector);
        adapter.deliverParked(address(vault), frontDoor, message);
        av.unpause();

        av.setShortBy(2e9);
        vm.prank(anyone);
        vm.expectRevert(MockAlphaVault.Slippage.selector);
        adapter.deliverParked(address(vault), frontDoor, message);
        av.setShortBy(0);

        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(CcipAdapterBase.BelowConversionFloor.selector, 1e15, 2e15));
        adapter.deliverParked(address(vault), frontDoor, small);

        assertParked(key, 10e18, false);
        assertParked(smallKey, 1e15, false);
        assertEq(adapter.parkedTokens(), 10e18 + 1e15);
        assertEq(adapter.parkedNative(), 0);
        assertEq(taoBit.balanceOf(address(adapter)), 10e18 + 1e15, "nothing burned");
        assertEq(address(adapter).balance, RESERVE);
        assertEq(staked(), stakedBefore, "nothing unstaked");
        assertEq(vault.totalSupply(), 0);
    }

    /// M-7: during ForeverMoney's migration notice (depositLiquid closed, withdrawLiquid open for its 7 days) the
    /// keeper gets every token park out of ForeverMoney's token with deliverParked even while the vault is paused:
    /// each converts and stays parked as native TAO (ParkedConverted), and is delivered once the vault accepts.
    function test_tokenParkConvertedWhileTheVaultIsPaused() public {
        bytes memory first = depositBatch(1, alice, 10e18);
        bytes memory second = depositBatch(2, bob, 5e18);
        tokenPark(address(vault), first, 10e18);
        tokenPark(address(vault), second, 5e18);
        av.initiateMigration();
        vm.prank(guardian);
        vault.pause();

        expectDeliverParked(address(vault), first, false);
        expectDeliverParked(address(vault), second, false);
        assertEq(adapter.parkedTokens(), 0, "no token park left");
        assertEq(taoBit.balanceOf(address(adapter)), 0, "out of ForeverMoney's token");
        assertEq(adapter.parkedNative(), 15e18);
        assertEq(address(adapter).balance, RESERVE + 15e18);
        assertEq(vault.totalSupply(), 0);

        vm.prank(owner);
        vault.unpause();
        expectDeliverParked(address(vault), first, true);
        expectDeliverParked(address(vault), second, true);
        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(vault.balanceOf(bob), 5e24);
        assertEq(adapter.parkedNative(), 0);
        assertEq(address(adapter).balance, RESERVE);
    }

    /// H-3, I-11: a recipient that refused its batch (so it parked as native TAO) and, when deliverParked pays it,
    /// re-enters deliverParked for the same key, to be paid twice out of the native parks. The record is deleted and
    /// parkedNative lowered before the call, and the call runs under the lock: the re-entry is refused
    /// (ReentrancyGuardReentrantCall), the recipient is paid once, and another batch's park is untouched. A re-entry
    /// into ccipReceive through the router with the same batch again (its record deleted while the call runs) meets
    /// the same lock: its tokens are never released and nothing parks.
    function test_revertingThenReenteringRecipient() public {
        ReentrantRecipient r = new ReentrantRecipient();
        r.setRefusing(true);
        bytes memory own = depositBatch(1, alice, 1e18);
        expectNativePark(address(r), frontDoor, own, 1e18, ReentrantRecipient.Refused.selector);
        vm.prank(guardian);
        vault.pause();
        bytes32 otherKey = expectNativePark(
            address(vault), frontDoor, depositBatch(2, bob, 2e18), 2e18, Pausable.EnforcedPause.selector
        );
        uint64 since = uint64(vm.getBlockTimestamp());

        r.setMode(
            ReentrantRecipient.Mode.RevertThenReenter,
            address(adapter),
            abi.encodeCall(CcipBittensorAdapter.deliverParked, (address(r), frontDoor, own)),
            false
        );
        r.setRefusing(false);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        expectDeliverParked(address(r), own, true);
        assertFalse(r.reentryOk(), "the re-entry refused");
        assertEq(r.reentryReturn(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        assertEq(r.delivered(), 1);
        assertEq(address(r).balance, 1e18, "paid once");
        assertParkedSince(otherKey, 2e18, true, since);
        assertEq(adapter.parkedNative(), 2e18, "the other park's own");
        assertEq(address(adapter).balance, RESERVE + 2e18);

        // parked again, it re-enters through the router with the same batch in a new message
        r.setRefusing(true);
        expectNativePark(address(r), frontDoor, own, 1e18, ReentrantRecipient.Refused.selector);
        Client.Any2EVMMessage memory again = ccip(address(r), frontDoor, own, 1e18);
        again.messageId = bytes32(uint256(77));
        r.setMode(
            ReentrantRecipient.Mode.RevertThenReenter,
            address(router),
            abi.encodeCall(MockRouter.deliver, (address(adapter), again, 1_000_000)),
            false
        );
        r.setRefusing(false);
        expectDeliverParked(address(r), own, true);
        assertTrue(r.reentryOk());
        (bool called, bool ok, bytes memory reason) = abi.decode(r.reentryReturn(), (bool, bool, bytes));
        assertTrue(called);
        assertFalse(ok, "the re-entry refused");
        assertEq(
            reason,
            abi.encodeWithSelector(
                MockRouter.DeliveryFailed.selector,
                abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
            )
        );
        assertEq(r.delivered(), 2);
        assertEq(address(r).balance, 2e18, "each park paid once");
        assertNotParked(keyOf(address(r), frontDoor, own));
        assertEq(taoBit.totalSupply(), 0, "the new message's tokens never released");
        assertEq(adapter.parkedNative(), 2e18);
        assertEq(address(adapter).balance, RESERVE + 2e18);
    }

    /// I-11's other order: a recipient that re-enters and then reverts. Its first delivery, through ccipReceive,
    /// re-enters deliverParked under the lock (refused) and reverts Refused(), so the batch parks as native TAO.
    /// deliverParked of that park, and of a token park of the same recipient (converted first), is re-entered (refused)
    /// and reverted: each catch restores the record as a converted park, same amount and parkedAt, and the totals move
    /// by the recipient's own batches alone. A recipient that instead bubbles the lock's refusal makes the whole call
    /// revert (R3 CC-L1: that selector never parks): deliverParked leaves its park as it was, and its own new message
    /// fails whole.
    function test_reenteringThenRevertingRecipient() public {
        ReentrantRecipient r = new ReentrantRecipient();
        vm.prank(guardian);
        vault.pause();
        bytes32 otherKey = expectNativePark(
            address(vault), frontDoor, depositBatch(9, bob, 2e18), 2e18, Pausable.EnforcedPause.selector
        );
        uint64 since = uint64(vm.getBlockTimestamp());

        bytes memory own = depositBatch(1, alice, 1e18);
        bytes memory reenterOwn = abi.encodeCall(CcipBittensorAdapter.deliverParked, (address(r), frontDoor, own));
        r.setMode(ReentrantRecipient.Mode.ReenterThenRevert, address(adapter), reenterOwn, false);
        expectNativePark(address(r), frontDoor, own, 1e18, ReentrantRecipient.Refused.selector);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        expectDeliverParked(address(r), own, false);

        bytes memory tokens = depositBatch(2, carol, 3e18);
        tokenPark(address(r), tokens, 3e18);
        bytes memory reenter = abi.encodeCall(CcipBittensorAdapter.deliverParked, (address(r), frontDoor, tokens));
        r.setMode(ReentrantRecipient.Mode.ReenterThenRevert, address(adapter), reenter, false);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        // the call and its re-entry
        vm.expectCall(address(adapter), reenter, 2);
        expectDeliverParked(address(r), tokens, false);

        // bubbling the lock's refusal: the whole call reverts, the park and the new message untouched
        bytes memory locked = abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        r.setMode(ReentrantRecipient.Mode.ReenterThenRevert, address(adapter), reenterOwn, true);
        vm.prank(anyone);
        vm.expectRevert(locked);
        adapter.deliverParked(address(r), frontDoor, own);
        bytes memory fresh = depositBatch(3, carol, 1e18);
        expectFailure(ccip(address(r), frontDoor, fresh, 1e18), locked);
        assertNotParked(keyOf(address(r), frontDoor, fresh));

        assertParkedSince(keyOf(address(r), frontDoor, own), 1e18, true, since);
        assertParkedSince(keyOf(address(r), frontDoor, tokens), 3e18, true, since + 1 days);
        assertParkedSince(otherKey, 2e18, true, since);
        assertEq(adapter.parkedNative(), 6e18, "the sum of the records");
        assertEq(adapter.parkedTokens(), 0);
        assertEq(taoBit.balanceOf(address(adapter)), 0);
        assertEq(address(adapter).balance, RESERVE + 6e18);
        assertEq(address(r).balance, 0);
        assertEq(r.delivered(), 0);
    }

    /// H-3: a two-level re-entry. The recipient, paid by deliverParked, re-enters through the router (the real
    /// lane's manual execution is permissionless) with a new message to itself; had that delivery got in, it would
    /// have called the recipient again from inside its own re-entry, where the recipient re-enters a second time,
    /// deliverParked for its own key. The one lock refuses the first level (ReentrancyGuardReentrantCall), so the
    /// second is never reached: the recipient is paid once, the new message's tokens are never released, and the
    /// other park is exact. The other way round, ccipReceive's delivery re-entering deliverParked, is refused the same
    /// way.
    function test_twoLevelReentry() public {
        ReentrantRecipient r = new ReentrantRecipient();
        r.setRefusing(true);
        bytes memory own = depositBatch(1, alice, 1e18);
        bytes32 ownKey = expectNativePark(address(r), frontDoor, own, 1e18, ReentrantRecipient.Refused.selector);
        vm.prank(guardian);
        vault.pause();
        bytes32 otherKey = expectNativePark(
            address(vault), frontDoor, depositBatch(2, bob, 2e18), 2e18, Pausable.EnforcedPause.selector
        );
        bytes memory fresh = depositBatch(3, carol, 1e18);
        Client.Any2EVMMessage memory m = ccip(address(r), frontDoor, fresh, 1e18);
        bytes memory viaRouter = abi.encodeCall(MockRouter.deliver, (address(adapter), m, 1_000_000));
        bytes memory ownAgain = abi.encodeCall(CcipBittensorAdapter.deliverParked, (address(r), frontDoor, own));
        bytes memory refused = abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        r.setRefusing(false);

        uint256 snap = vm.snapshotState();
        r.setMode(ReentrantRecipient.Mode.TwoLevel, address(router), viaRouter, false);
        r.setSecondLevel(address(adapter), ownAgain);
        expectDeliverParked(address(r), own, true);
        (bool called, bool ok, bytes memory reason) = abi.decode(r.reentryReturn(), (bool, bool, bytes));
        assertTrue(called);
        assertFalse(ok, "the first level refused");
        assertEq(reason, abi.encodeWithSelector(MockRouter.DeliveryFailed.selector, refused));
        assertFalse(r.secondLevelReached(), "the second level never reached");
        assertEq(r.delivered(), 1);
        assertEq(address(r).balance, 1e18, "paid once");
        assertNotParked(keyOf(address(r), frontDoor, fresh));
        assertEq(taoBit.totalSupply(), 0, "the new message's tokens never released");
        assertParked(otherKey, 2e18, true);
        assertEq(adapter.parkedNative(), 2e18);
        assertEq(address(adapter).balance, RESERVE + 2e18);

        vm.revertToState(snap);
        r.setMode(ReentrantRecipient.Mode.TwoLevel, address(adapter), ownAgain, false);
        r.setSecondLevel(address(router), viaRouter);
        (bool delivered,) = deliver(m);
        assertTrue(delivered, "the new message delivered");
        assertFalse(r.reentryOk(), "the first level refused");
        assertEq(r.reentryReturn(), refused);
        assertFalse(r.secondLevelReached(), "the second level never reached");
        assertEq(address(r).balance, 1e18, "the new batch's own");
        assertNotParked(keyOf(address(r), frontDoor, fresh));
        assertParked(ownKey, 1e18, true);
        assertParked(otherKey, 2e18, true);
        assertEq(adapter.parkedNative(), 3e18);
        assertEq(address(adapter).balance, RESERVE + 3e18);
        assertOwed(adapter, taoBit);
    }

    /// deliverParked recomputes the key from (remoteChainId, sender, recipient, message), so it reverts NotParked for
    /// a batch never parked, for any other sender, recipient or message than the park's, and for a park already
    /// delivered: no second payment.
    function test_notParked() public {
        bytes memory message = depositBatch(1, alice, 1e18);
        bytes memory notParked = abi.encodeWithSelector(CcipBittensorAdapter.NotParked.selector);
        vm.expectRevert(notParked);
        adapter.deliverParked(address(vault), frontDoor, message);

        vm.prank(guardian);
        vault.pause();
        expectNativePark(address(vault), frontDoor, message, 1e18, Pausable.EnforcedPause.selector);
        vm.prank(owner);
        vault.unpause();
        vm.expectRevert(notParked);
        adapter.deliverParked(address(vault), makeAddr("stranger"), message);
        vm.expectRevert(notParked);
        adapter.deliverParked(makeAddr("elsewhere"), frontDoor, message);
        vm.expectRevert(notParked);
        adapter.deliverParked(address(vault), frontDoor, depositBatch(2, alice, 1e18));

        expectDeliverParked(address(vault), message, true);
        vm.expectRevert(notParked);
        adapter.deliverParked(address(vault), frontDoor, message);
        assertEq(vault.balanceOf(alice), 1e24, "delivered once");
        assertEq(address(adapter).balance, RESERVE);
    }

    /// A redeem-only batch's empty park (amount 0, converted) is delivered with no conversion and no value; refused
    /// again, it is restored the same way, amount 0 and parkedNative unchanged.
    function test_redeemOnlyParkIsDelivered() public {
        depositOk(1, alice, 10e18);
        // alice's shares held a day, so her redeem burns (the door hold, R4 B-H1)
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.prank(guardian);
        vault.pause();
        bytes memory message = redeemBatch(2, alice, 1e24);
        expectNativePark(address(vault), frontDoor, message, 0, Pausable.EnforcedPause.selector);
        vm.expectCall(address(av), abi.encodeWithSelector(IAlphaVault.withdrawLiquid.selector), 0);
        expectDeliverParked(address(vault), message, false);
        vm.prank(owner);
        vault.unpause();
        expectDeliverParked(address(vault), message, true);
        assertEq(vault.balanceOf(alice), 9e24);
        assertEq(vaultLens.pendingPayouts(), 1e18);
        assertEq(adapter.parkedNative(), 0);
    }

    /// A token park for a recipient with no code (only a sender that names one produces it) cannot be delivered:
    /// Solidity's code check precedes the try, outside it, and reverts with no data, so deliverParked reverts whole
    /// after its conversion ran (withdrawLiquid called once), the conversion with it, and the record stays a token
    /// park (refundable as tokens after PARK_TIMEOUT, Task 27). The revert data is read by a plain call, not
    /// expectRevert: from -vvv up, Foundry's revert diagnostic replaces an empty revert from a call to an address with
    /// no code by its own description of that cause, so the check accepts exactly the two.
    function test_aCodelessRecipientsParkCannotBeDelivered() public {
        address noCode = makeAddr("noCode");
        bytes memory message = depositBatch(1, alice, 1e18);
        bytes32 key = tokenPark(noCode, message, 1e18);
        uint256 stakedBefore = staked();
        vm.expectCall(address(av), abi.encodeCall(IAlphaVault.withdrawLiquid, (address(taoBit), 1e18, 1e18 - 1e9)), 1);
        vm.prank(anyone);
        (bool ok, bytes memory reason) =
            address(adapter).call(abi.encodeCall(CcipBittensorAdapter.deliverParked, (noCode, frontDoor, message)));
        assertFalse(ok, "deliverParked reverted");
        bytes memory diagnosed = abi.encode(string.concat("call to non-contract address ", vm.toString(noCode)));
        assertTrue(reason.length == 0 || keccak256(reason) == keccak256(diagnosed), "the code check's empty revert");
        assertParked(key, 1e18, false);
        assertEq(adapter.parkedTokens(), 1e18);
        assertEq(taoBit.balanceOf(address(adapter)), 1e18, "the conversion rolled back");
        assertEq(taoBit.totalSupply(), 1e18, "the burn rolled back");
        assertEq(staked(), stakedBefore, "the unstake rolled back");
        assertEq(address(adapter).balance, RESERVE);
    }

    /// A recipient that re-enters convertExact in deliverParked's call window, to convert another batch's parked tokens
    /// out from under its record, is refused OnlySelf: convertExact takes no lock (it runs inside one), but only the
    /// adapter may call it. Through ccipReceive the bubbled refusal is the park's reason. Under deliverParked,
    /// re-entered then reverted, a token park (its own conversion done first) and a native park are each restored
    /// converted, same amount, first parkedAt; re-entered then accepted, the recipient records OnlySelf and is paid
    /// once. The other batch's token park, both totals and I-7 hold throughout, and its tokens are never converted.
    function test_aRecipientReenteringConvertExactIsRefused() public {
        ReentrantRecipient r = new ReentrantRecipient();
        bytes32 otherKey = tokenPark(address(vault), depositBatch(9, bob, 2e18), 2e18);
        uint64 since = uint64(vm.getBlockTimestamp());
        bytes memory reenter = abi.encodeCall(CcipBittensorAdapter.convertExact, (2e18));
        r.setMode(ReentrantRecipient.Mode.ReenterThenRevert, address(adapter), reenter, true);

        bytes memory own = depositBatch(1, alice, 1e18);
        expectNativePark(address(r), frontDoor, own, 1e18, CcipBittensorAdapter.OnlySelf.selector);
        bytes memory tokens = depositBatch(2, carol, 3e18);
        tokenPark(address(r), tokens, 3e18);
        vm.warp(vm.getBlockTimestamp() + 1 days);

        // from here: the three re-entries below, deliverParked's own 3e18 conversion once, the other batch's never
        vm.expectCall(address(adapter), reenter, 3);
        vm.expectCall(address(adapter), abi.encodeCall(CcipBittensorAdapter.convertExact, (3e18)), 1);
        vm.expectCall(address(av), abi.encodeCall(IAlphaVault.withdrawLiquid, (address(taoBit), 2e18, 2e18 - 1e9)), 0);
        expectDeliverParked(address(r), tokens, false);
        expectDeliverParked(address(r), own, false);
        assertParkedSince(keyOf(address(r), frontDoor, tokens), 3e18, true, since);
        assertParkedSince(keyOf(address(r), frontDoor, own), 1e18, true, since);
        assertParkedSince(otherKey, 2e18, false, since);
        assertEq(adapter.parkedTokens(), 2e18);
        assertEq(taoBit.balanceOf(address(adapter)), 2e18, "the other batch's tokens");
        assertEq(adapter.parkedNative(), 4e18);
        assertEq(address(adapter).balance, RESERVE + 4e18);
        assertEq(address(r).balance, 0);

        r.setMode(ReentrantRecipient.Mode.RevertThenReenter, address(adapter), reenter, false);
        expectDeliverParked(address(r), own, true);
        assertFalse(r.reentryOk(), "the re-entry refused");
        assertEq(r.reentryReturn(), abi.encodeWithSelector(CcipBittensorAdapter.OnlySelf.selector));
        assertEq(address(r).balance, 1e18, "paid once");
        assertParkedSince(otherKey, 2e18, false, since);
        assertEq(adapter.parkedTokens(), 2e18);
        assertEq(taoBit.balanceOf(address(adapter)), 2e18);
        assertEq(adapter.parkedNative(), 3e18);
        assertEq(address(adapter).balance, RESERVE + 3e18);
    }

    /// deliverParked calls the recipient with all the gas but PARK_GAS_RESERVE, as _deliver's step 4, and since R4 only
    /// with at least PARK_GAS_RESERVE plus the lane's inbound model for the batch left right before that call
    /// (parkedDeliveryGas: here 150,000 + 1,000,000 + 25,000). Below the requirement (a 1,000,000 limit) it reverts
    /// InsufficientGas and the park is exactly as it was, still tokens: a starved call never converts or re-parks.
    /// Above it (3,000,000 and 7,000,000), a recipient that consumes all its gas still leaves the catch enough to
    /// restore the record and emit ParkedConverted, so a token park's conversion is kept, with at least SPARE to spare.
    /// Logs a lower bound on the gas left unused after the restore.
    function test_gasBurningRecipientStillLeavesTheParkConverted() public {
        address burner = address(new GasBurningReceiver());
        bytes memory message = depositBatch(1, alice, 10e18);
        bytes32 key = tokenPark(burner, message, 10e18);
        uint64 since = uint64(vm.getBlockTimestamp());
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertGt(adapter.parkedDeliveryGas(message), 1_000_000, "the requirement above the low limit");
        vm.cool(address(adapter));
        vm.cool(address(taoBit));
        vm.cool(address(av));
        vm.expectRevert(InsufficientGas.selector);
        adapter.deliverParked{gas: 1_000_000}(burner, frontDoor, message);
        assertParkedSince(key, 10e18, false, since);
        assertEq(adapter.parkedTokens(), 10e18, "still tokens");
        assertEq(adapter.parkedNative(), 0);
        assertEq(taoBit.balanceOf(address(adapter)), 10e18, "no conversion");
        uint256[2] memory limits = [uint256(3_000_000), 7_000_000];
        for (uint256 i; i < limits.length; ++i) {
            uint256 snap = vm.snapshotState();
            vm.expectEmit(address(adapter));
            emit CcipBittensorAdapter.ParkedConverted(key);
            uint256 left = deliverParkedWithGas(burner, message, limits[i]);
            assertParkedSince(key, 10e18, true, since);
            assertEq(adapter.parkedNative(), 10e18);
            assertEq(adapter.parkedTokens(), 0);
            assertEq(taoBit.balanceOf(address(adapter)), 0, "the conversion kept");
            assertEq(address(adapter).balance, RESERVE + 10e18);
            assertOwed(adapter, taoBit);
            emit log_named_uint(
                string.concat("deliverParked restore: gas left unused, limit ", vm.toString(limits[i])), left
            );
            assertGe(left, SPARE, "the reserve outlasts the restore");
            vm.revertToState(snap);
        }
    }

    /// A recipient that reverts with a 1 MiB returndata bomb is restored the same way: the catch reads the reason's
    /// 4 bytes alone, so no length of revert data reaches the reserve.
    function test_aRecipientsReturndataBombStillRestoresThePark() public {
        address bomb = address(new ReturnBombReceiver(1 << 20));
        bytes memory message = depositBatch(1, alice, 10e18);
        bytes32 key = expectNativePark(bomb, frontDoor, message, 10e18, ReturnBombReceiver.Bomb.selector);
        uint64 since = uint64(vm.getBlockTimestamp());
        vm.warp(vm.getBlockTimestamp() + 1 days);
        uint256[2] memory limits = [uint256(3_000_000), 7_000_000];
        for (uint256 i; i < limits.length; ++i) {
            uint256 snap = vm.snapshotState();
            vm.expectEmit(address(adapter));
            emit CcipBittensorAdapter.ParkedConverted(key);
            uint256 left = deliverParkedWithGas(bomb, message, limits[i]);
            assertParkedSince(key, 10e18, true, since);
            assertEq(adapter.parkedNative(), 10e18);
            assertOwed(adapter, taoBit);
            emit log_named_uint(
                string.concat("deliverParked restore after a 1 MiB bomb: gas left, limit ", vm.toString(limits[i])),
                left
            );
            assertGe(left, SPARE, "the reserve outlasts the restore");
            vm.revertToState(snap);
        }
    }

    // ---- refundParked, quoteRefund, dropParked (Task 27) ----

    /// A park is refunded only once PARK_TIMEOUT (14 days) has passed since its parkedAt: at the park and a second
    /// before the timeout, refundParked reverts ParkedTooYoung, and the record, both totals and the balances stay;
    /// from exactly parkedAt + PARK_TIMEOUT anyone refunds it.
    function test_refundBeforeTheTimeout() public {
        vm.prank(guardian);
        vault.pause();
        bytes memory message = twoDeposits(1, 6e18, 4e18);
        bytes32 key = expectNativePark(address(vault), frontDoor, message, 10e18, Pausable.EnforcedPause.selector);
        uint64 since = uint64(vm.getBlockTimestamp());
        uint256 opens = since + adapter.PARK_TIMEOUT();

        uint256[2] memory early = [uint256(since), opens - 1];
        for (uint256 i; i < early.length; ++i) {
            vm.warp(early[i]);
            vm.prank(anyone);
            vm.expectRevert(CcipBittensorAdapter.ParkedTooYoung.selector);
            adapter.refundParked{value: FEE}(address(vault), frontDoor, message);
        }
        assertParkedSince(key, 10e18, true, since);
        assertEq(adapter.parkedNative(), 10e18);
        assertEq(address(adapter).balance, RESERVE + 10e18);
        assertEq(router.sendCount(), 0);

        vm.warp(opens);
        expectRefund(address(vault), message, entries2(alice, 6e18, bob, 4e18), FEE);
    }

    /// refundParked recomputes the key, so a batch never parked, or any other sender, recipient or message than a
    /// park's, reverts NotParked; an empty park (a refused redeem-only batch) has nothing to refund, NothingToRefund,
    /// after the timeout too (it is dropped instead).
    function test_refundNeedsAParkWithAnAmount() public {
        depositOk(1, alice, 10e18);
        vm.prank(guardian);
        vault.pause();
        bytes memory message = depositBatch(2, bob, 1e18);
        expectNativePark(address(vault), frontDoor, message, 1e18, Pausable.EnforcedPause.selector);
        bytes memory empty = redeemBatch(3, alice, 1e24);
        expectNativePark(address(vault), frontDoor, empty, 0, Pausable.EnforcedPause.selector);
        vm.warp(vm.getBlockTimestamp() + adapter.PARK_TIMEOUT());

        bytes memory notParked = abi.encodeWithSelector(CcipBittensorAdapter.NotParked.selector);
        vm.startPrank(anyone);
        vm.expectRevert(notParked);
        adapter.refundParked{value: FEE}(address(vault), frontDoor, depositBatch(9, bob, 1e18));
        vm.expectRevert(notParked);
        adapter.refundParked{value: FEE}(address(vault), makeAddr("stranger"), message);
        vm.expectRevert(notParked);
        adapter.refundParked{value: FEE}(makeAddr("elsewhere"), frontDoor, message);
        vm.expectRevert(CcipBittensorAdapter.NothingToRefund.selector);
        adapter.refundParked{value: FEE}(address(vault), frontDoor, empty);
        vm.stopPrank();
        assertEq(router.sendCount(), 0);
        assertEq(adapter.parkedNative(), 1e18);
    }

    /// A converted park (the vault refused it) is refunded to its door after PARK_TIMEOUT: the record is deleted and
    /// parkedNative lowered first, then the native TAO goes back into ForeverMoney's token through _collect
    /// (depositLiquid of exactly the park's amount, asking at least that less 1 rao, the token balance grown by exactly
    /// it) and is sent with the fee from msg.value. The router's message is PAYOUTS(key, REFUND_CHUNK, each depositor's exact deposit) to the Base
    /// adapter, the payload's sender the vault (the park's recipient) and its recipient the door (the park's sender),
    /// so the door takes it as a payout from its vault (I-9). While depositLiquid is closed (ForeverMoney's migration
    /// notice) the refund reverts and the record stays: I-10's condition for a converted park. Refunded, the park
    /// can be neither refunded again nor delivered to the vault (I-8).
    function test_refundConverted() public {
        vm.prank(guardian);
        vault.pause();
        bytes memory message = twoDeposits(1, 6e18, 4e18);
        bytes32 key = expectNativePark(address(vault), frontDoor, message, 10e18, Pausable.EnforcedPause.selector);
        uint64 since = uint64(vm.getBlockTimestamp());
        vm.warp(since + adapter.PARK_TIMEOUT());

        av.initiateMigration();
        vm.prank(anyone);
        vm.expectRevert(MockAlphaVault.MigrationInProgress.selector);
        adapter.refundParked{value: FEE}(address(vault), frontDoor, message);
        assertParkedSince(key, 10e18, true, since);
        assertEq(adapter.parkedNative(), 10e18);
        assertEq(address(adapter).balance, RESERVE + 10e18);
        assertEq(router.sendCount(), 0);
        av.cancelMigration();

        uint256 stakedBefore = staked();
        // minAlphaRao is the amount less 1 rao, the send-side tolerance (R3 B-1)
        vm.expectCall(address(av), 10e18, abi.encodeCall(IAlphaVault.depositLiquid, (address(taoBit), 10e9 - 1)), 1);
        vm.expectCall(address(av), abi.encodeWithSelector(IAlphaVault.withdrawLiquid.selector), 0);
        expectRefund(address(vault), message, entries2(alice, 6e18, bob, 4e18), FEE);
        assertEq(staked() - stakedBefore, 10e9, "the native TAO went back into ForeverMoney's token, staked");
        assertEq(address(adapter).balance, RESERVE, "the reserve untouched");
        assertEq(taoBit.balanceOf(address(router)), 10e18, "the tokens left with the message");
        assertEq(taoBit.balanceOf(address(adapter)), 0);
        assertEq(adapter.parkedNative(), 0);
        assertEq(vault.totalSupply(), 0);

        bytes memory notParked = abi.encodeWithSelector(CcipBittensorAdapter.NotParked.selector);
        vm.prank(owner);
        vault.unpause();
        vm.startPrank(anyone);
        vm.expectRevert(notParked);
        adapter.refundParked{value: FEE}(address(vault), frontDoor, message);
        vm.expectRevert(notParked);
        adapter.deliverParked(address(vault), frontDoor, message);
        vm.stopPrank();
        assertEq(vault.totalSupply(), 0, "refunded, never minted");
        assertEq(router.sendCount(), 1);
    }

    /// An unconverted park (its conversion failed) is refunded as the tokens it holds, never converted: neither
    /// depositLiquid nor withdrawLiquid is called, the router is approved for exactly the amount and takes it, and
    /// the native balance and parkedNative are untouched (preflight A6), with ForeverMoney open for the first refund
    /// (where a needless conversion would succeed, out of the other park's native TAO beside it) and paused for the
    /// second. The message has the same shape: each depositor's exact deposit, the vault its sender, the door its
    /// recipient.
    function test_refundUnconverted() public {
        bytes memory message = twoDeposits(1, 7e18, 3e18);
        bytes memory second = depositBatch(3, carol, 5e18);
        holdRail();
        bytes32 key = expectTokenPark(address(vault), frontDoor, message, 10e18, MockAlphaVault.IsHalted.selector);
        bytes32 secondKey = expectTokenPark(address(vault), frontDoor, second, 5e18, MockAlphaVault.IsHalted.selector);
        av.unpause();
        vm.prank(guardian);
        vault.pause();
        bytes32 otherKey = expectNativePark(
            address(vault), frontDoor, depositBatch(2, carol, 20e18), 20e18, Pausable.EnforcedPause.selector
        );
        uint64 since = uint64(vm.getBlockTimestamp());
        vm.warp(since + adapter.PARK_TIMEOUT());

        uint256 native = address(adapter).balance;
        assertEq(native, RESERVE + 20e18, "enough native TAO for a needless conversion");
        vm.expectCall(address(av), abi.encodeWithSelector(IAlphaVault.depositLiquid.selector), 0);
        vm.expectCall(address(av), abi.encodeWithSelector(IAlphaVault.withdrawLiquid.selector), 0);
        vm.expectCall(address(taoBit), abi.encodeCall(IERC20.approve, (address(router), 10e18)), 1);
        vm.expectCall(address(taoBit), abi.encodeCall(IERC20.approve, (address(router), 5e18)), 1);
        expectRefund(address(vault), second, entries1(carol, 5e18), FEE);
        assertEq(address(adapter).balance, native, "the native balance untouched");
        assertEq(adapter.parkedNative(), 20e18, "parkedNative untouched");
        holdRail();
        expectRefund(address(vault), message, entries2(alice, 7e18, bob, 3e18), FEE);
        assertNotParked(key);
        assertNotParked(secondKey);
        assertEq(address(adapter).balance, native, "the native balance untouched");
        assertEq(adapter.parkedNative(), 20e18, "parkedNative untouched");
        assertParkedSince(otherKey, 20e18, true, since);
        assertEq(adapter.parkedTokens(), 0);
        assertEq(taoBit.balanceOf(address(adapter)), 0);
        assertEq(taoBit.balanceOf(address(router)), 15e18, "the tokens as they were");
        assertEq(taoBit.totalSupply(), 15e18, "never burned");
    }

    /// A token park below the conversion floor (L-9) is exactly what the refund is for: the refund's send skips the
    /// floor check (spec §3.2, L-7), so the tokens go back as they are, with no BelowConversionFloor, below today's
    /// floor and below a raised one.
    function test_refundOfASubFloorTokenPark() public {
        bytes memory small = depositBatch(1, alice, 1e15);
        expectTokenPark(address(vault), frontDoor, small, 1e15, CcipAdapterBase.BelowConversionFloor.selector);
        staking.setMinStake(20_000_000);
        bytes memory raised = depositBatch(2, bob, 1e16);
        expectTokenPark(address(vault), frontDoor, raised, 1e16, CcipAdapterBase.BelowConversionFloor.selector);
        vm.warp(vm.getBlockTimestamp() + adapter.PARK_TIMEOUT());
        assertEq(adapter.floor(), 2e16, "both below the floor");

        vm.expectCall(address(av), abi.encodeWithSelector(IAlphaVault.depositLiquid.selector), 0);
        expectRefund(address(vault), small, entries1(alice, 1e15), FEE);
        expectRefund(address(vault), raised, entries1(bob, 1e16), FEE);
        assertEq(taoBit.balanceOf(address(router)), 1.1e16);
        assertEq(adapter.parkedTokens(), 0);
        assertEq(address(adapter).balance, RESERVE);
    }

    /// Ruling 1 (Task 27): a converted refund makes neither of send's amount checks either, so no per-message cap
    /// below a parked batch can trap it, and the adapter's own floor check never runs on it (I-10); it still converts
    /// through _collect, and ForeverMoney's depositLiquid stakes through the precompile, so a park below a raised chain
    /// floor waits for the precompile's minimum (BelowMinStake, from inside ForeverMoney, which has no floor of its
    /// own: R3 FM-I1; the record intact) and goes once the floor drops. A 1e16 park under a floor raised to 2e16, and a
    /// 6,000 TAO park over this adapter's 5,000 TAO cap, both converted (their recipient refused them), are refunded,
    /// the large one while the floor is still raised.
    function test_aConvertedRefundSkipsTheFloorAndTheCap() public {
        ReentrantRecipient r = new ReentrantRecipient();
        r.setRefusing(true);
        bytes memory small = depositBatch(1, alice, 1e16);
        bytes32 smallKey = expectNativePark(address(r), frontDoor, small, 1e16, ReentrantRecipient.Refused.selector);
        bytes memory large = depositBatch(2, bob, 6_000e18);
        expectNativePark(address(r), frontDoor, large, 6_000e18, ReentrantRecipient.Refused.selector);
        uint64 since = uint64(vm.getBlockTimestamp());
        vm.warp(since + adapter.PARK_TIMEOUT());
        staking.setMinStake(20_000_000);
        assertGt(adapter.floor(), 1e16, "below the chain's floor");
        assertGt(6_000e18, adapter.maxMessageValue(), "over the cap");

        vm.prank(anyone);
        vm.expectRevert(MockStaking.BelowMinStake.selector);
        adapter.refundParked{value: FEE}(address(r), frontDoor, small);
        assertParkedSince(smallKey, 1e16, true, since);
        assertEq(adapter.parkedNative(), 6_000e18 + 1e16);
        expectRefund(address(r), large, entries1(bob, 6_000e18), FEE);
        staking.setMinStake(0);

        expectRefund(address(r), small, entries1(alice, 1e16), FEE);
        assertEq(taoBit.balanceOf(address(router)), 6_000e18 + 1e16);
        assertEq(adapter.parkedNative(), 0);
        assertEq(address(adapter).balance, RESERVE);
        assertEq(r.delivered(), 0, "the recipient is never called");
    }

    /// The refund's CCIP fee comes from msg.value: below the router's fee it reverts InsufficientFee and nothing
    /// moves; above it the router is paid exactly its fee and the excess stays in the adapter (surplus, which Task
    /// 28's sweep takes), never in a park: a converted refund's depositLiquid takes the park's own amount, not
    /// msg.value, and an unconverted one moves no native TAO but the fee.
    function test_refundFeeFromValueExcessKept() public {
        vm.prank(guardian);
        vault.pause();
        bytes memory converted = twoDeposits(1, 6e18, 4e18);
        bytes32 key = expectNativePark(address(vault), frontDoor, converted, 10e18, Pausable.EnforcedPause.selector);
        bytes memory tokens = depositBatch(2, carol, 1e15);
        expectTokenPark(address(vault), frontDoor, tokens, 1e15, CcipAdapterBase.BelowConversionFloor.selector);
        uint64 since = uint64(vm.getBlockTimestamp());
        vm.warp(since + adapter.PARK_TIMEOUT());

        vm.prank(anyone);
        vm.expectRevert(CcipAdapterBase.InsufficientFee.selector);
        adapter.refundParked{value: FEE - 1}(address(vault), frontDoor, converted);
        assertParkedSince(key, 10e18, true, since);
        assertEq(adapter.parkedNative(), 10e18);
        assertEq(address(adapter).balance, RESERVE + 10e18);
        assertEq(router.sendCount(), 0);

        uint256 paid = anyone.balance;
        // minAlphaRao is the amount less 1 rao, the send-side tolerance (R3 B-1)
        vm.expectCall(address(av), 10e18, abi.encodeCall(IAlphaVault.depositLiquid, (address(taoBit), 10e9 - 1)), 1);
        expectRefund(address(vault), converted, entries2(alice, 6e18, bob, 4e18), FEE + 7e14);
        assertEq(paid - anyone.balance, FEE + 7e14, "the caller paid its msg.value");
        assertEq(address(router).balance, FEE, "the router got exactly its fee");
        assertEq(address(adapter).balance, RESERVE + 7e14, "the excess kept");

        expectRefund(address(vault), tokens, entries1(carol, 1e15), FEE + 3e14);
        assertEq(address(router).balance, 2 * FEE);
        assertEq(address(adapter).balance, RESERVE + 7e14 + 3e14, "the excess kept again");
        assertEq(adapter.parkedNative(), 0);
        assertEq(adapter.parkedTokens(), 0);
    }

    /// quoteRefund is the router's fee for exactly the message refundParked sends: it asks getFee for that message
    /// (the same payload, tokens and gas limit) and the send asks for the same and pays it, for a converted park of
    /// two deposits and an unconverted one of one, each at its own fee. It is not time-gated (the keeper quotes
    /// before the timeout); without a record it reverts NotParked, and for an empty park NothingToRefund.
    function test_quoteRefundMatchesTheSend() public {
        vm.prank(guardian);
        vault.pause();
        bytes memory converted = twoDeposits(1, 6e18, 4e18);
        expectNativePark(address(vault), frontDoor, converted, 10e18, Pausable.EnforcedPause.selector);
        bytes memory tokens = depositBatch(2, carol, 3e18);
        holdRail();
        expectTokenPark(address(vault), frontDoor, tokens, 3e18, MockAlphaVault.IsHalted.selector);
        av.unpause();
        bytes memory empty = redeemBatch(3, alice, 1e24);
        expectNativePark(address(vault), frontDoor, empty, 0, Pausable.EnforcedPause.selector);

        vm.expectRevert(CcipBittensorAdapter.NotParked.selector);
        adapter.quoteRefund(address(vault), frontDoor, depositBatch(9, bob, 1e18));
        vm.expectRevert(CcipBittensorAdapter.NothingToRefund.selector);
        adapter.quoteRefund(address(vault), frontDoor, empty);

        bytes[2] memory messages = [converted, tokens];
        Client.EVM2AnyMessage[2] memory expected = [
            refundMessage(address(vault), converted, entries2(alice, 6e18, bob, 4e18), 10e18),
            refundMessage(address(vault), tokens, entries1(carol, 3e18), 3e18)
        ];
        uint256[2] memory fees = [uint256(2e15), 3e15];
        uint256[2] memory quotes;
        for (uint256 i; i < 2; ++i) {
            router.setFee(fees[i]);
            // the quote's before the timeout, the quote's after it, and the send's
            vm.expectCall(address(router), abi.encodeCall(IRouterClient.getFee, (BASE_SELECTOR, expected[i])), 3);
            vm.expectCall(
                address(router), fees[i], abi.encodeCall(IRouterClient.ccipSend, (BASE_SELECTOR, expected[i])), 1
            );
            quotes[i] = adapter.quoteRefund(address(vault), frontDoor, messages[i]);
            assertEq(quotes[i], fees[i], "the fee of exactly that message");
        }
        vm.warp(vm.getBlockTimestamp() + adapter.PARK_TIMEOUT());
        for (uint256 i; i < 2; ++i) {
            router.setFee(fees[i]);
            assertEq(
                adapter.quoteRefund(address(vault), frontDoor, messages[i]), quotes[i], "the same after the timeout"
            );
            uint256 before = address(adapter).balance;
            vm.prank(anyone);
            adapter.refundParked{value: quotes[i]}(address(vault), frontDoor, messages[i]);
            assertEq(router.lastSend().value, quotes[i], "the send paid the quote");
            assertEq(address(adapter).balance, before - (i == 0 ? 10e18 : 0), "the quote covers it, nothing kept");
        }
        assertEq(router.sendCount(), 2);
    }

    /// dropParked deletes an empty park (a refused redeem-only batch, amount 0) once PARK_TIMEOUT has passed, with
    /// ParkedDropped: before it, ParkedTooYoung; a park that owes something (refunded, never dropped), or none at
    /// all, is NotParked. The redeems in a dropped batch were never burned (the vault refused them), so nothing else
    /// is owed: alice keeps her shares and asks again. Dropped, the park is gone for every park function, and
    /// another park is untouched.
    function test_dropOnlyEmptyAfterTheTimeout() public {
        depositOk(1, alice, 10e18);
        vm.prank(guardian);
        vault.pause();
        bytes memory empty = redeemBatch(2, alice, 1e24);
        bytes32 key = expectNativePark(address(vault), frontDoor, empty, 0, Pausable.EnforcedPause.selector);
        bytes memory full = depositBatch(3, bob, 1e18);
        bytes32 fullKey = expectNativePark(address(vault), frontDoor, full, 1e18, Pausable.EnforcedPause.selector);
        uint64 since = uint64(vm.getBlockTimestamp());
        bytes memory notParked = abi.encodeWithSelector(CcipBittensorAdapter.NotParked.selector);

        vm.startPrank(anyone);
        vm.warp(since + adapter.PARK_TIMEOUT() - 1);
        vm.expectRevert(CcipBittensorAdapter.ParkedTooYoung.selector);
        adapter.dropParked(address(vault), frontDoor, empty);
        vm.warp(since + adapter.PARK_TIMEOUT());
        vm.expectRevert(notParked);
        adapter.dropParked(address(vault), frontDoor, full);
        vm.expectRevert(notParked);
        adapter.dropParked(address(vault), frontDoor, depositBatch(4, bob, 1e18));
        vm.expectRevert(notParked);
        adapter.dropParked(address(vault), makeAddr("stranger"), empty);

        vm.expectEmit(address(adapter));
        emit CcipBittensorAdapter.ParkedDropped(key);
        adapter.dropParked(address(vault), frontDoor, empty);
        assertNotParked(key);
        assertParkedSince(fullKey, 1e18, true, since);
        assertEq(adapter.parkedNative(), 1e18);
        assertEq(adapter.parkedTokens(), 0);
        assertEq(address(adapter).balance, RESERVE + 1e18);
        assertEq(vault.balanceOf(alice), 1e25, "the redeems were never burned");
        assertEq(vaultLens.pendingPayouts(), 0);

        vm.expectRevert(notParked);
        adapter.dropParked(address(vault), frontDoor, empty);
        vm.expectRevert(notParked);
        adapter.refundParked{value: FEE}(address(vault), frontDoor, empty);
        vm.expectRevert(notParked);
        adapter.deliverParked(address(vault), frontDoor, empty);
        vm.stopPrank();
        assertEq(router.sendCount(), 0);
    }

    /// Ruling 5 (Task 26 keeps a refused delivery's first parkedAt): a retry the vault refuses does not postpone the
    /// refund, which still opens PARK_TIMEOUT after the first park, not after the last retry. Retried at day 13, the
    /// token park is converted on the way (ParkedConverted, Task 26's carry: deliverParked can turn a token park into
    /// a converted one), so at day 14 its refund goes back through depositLiquid rather than as the tokens.
    function test_aRefusedRetryDoesNotPostponeTheRefund() public {
        bytes memory message = twoDeposits(1, 6e18, 4e18);
        bytes32 key = tokenPark(address(vault), message, 10e18);
        uint64 since = uint64(vm.getBlockTimestamp());
        vm.prank(guardian);
        vault.pause();
        vm.warp(since + 13 days);
        expectDeliverParked(address(vault), message, false);
        assertParkedSince(key, 10e18, true, since);

        vm.warp(since + adapter.PARK_TIMEOUT());
        // minAlphaRao is the amount less 1 rao, the send-side tolerance (R3 B-1)
        vm.expectCall(address(av), 10e18, abi.encodeCall(IAlphaVault.depositLiquid, (address(taoBit), 10e9 - 1)), 1);
        expectRefund(address(vault), message, entries2(alice, 6e18, bob, 4e18), FEE);
        assertEq(address(adapter).balance, RESERVE);
        assertEq(taoBit.balanceOf(address(router)), 10e18);
    }

    /// Task 26's carry: a token park for a recipient with no code cannot be delivered, but it is refunded as its
    /// tokens after PARK_TIMEOUT, since the refund never calls the recipient (it is only the payload's sender).
    function test_aCodelessRecipientsTokenParkIsRefunded() public {
        address noCode = makeAddr("noCode");
        bytes memory message = depositBatch(1, alice, 1e18);
        tokenPark(noCode, message, 1e18);
        vm.warp(vm.getBlockTimestamp() + adapter.PARK_TIMEOUT());
        expectRefund(noCode, message, entries1(alice, 1e18), FEE);
        assertEq(taoBit.balanceOf(address(router)), 1e18);
        assertEq(address(adapter).balance, RESERVE);
    }

    /// I-9's other half (review M1): a parked batch that carries redeems beside its deposits refunds its deposits
    /// alone. The PAYOUTS message lists exactly the depositors' entries, with the gas for those entries only, and
    /// no redeemer appears in it. The redeems leave nothing behind: the vault refused the batch, so they were never
    /// burned, the redeemer keeps every share and no payout is queued. Both a converted park (the vault paused) and
    /// an unconverted one (ForeverMoney paused).
    function test_refundOfAMixedBatchRefundsOnlyItsDeposits() public {
        depositOk(1, bob, 2e18);
        assertEq(vault.balanceOf(bob), 2e24);
        uint256 supply = vault.totalSupply();
        vm.prank(guardian);
        vault.pause();
        bytes memory mixed = CascadeMessages.encodeBatch(2, entries1(alice, 6e18), entries1(bob, 1e24));
        expectNativePark(address(vault), frontDoor, mixed, 6e18, Pausable.EnforcedPause.selector);
        bytes memory tokens = CascadeMessages.encodeBatch(3, entries2(alice, 3e18, carol, 1e18), entries1(bob, 5e23));
        holdRail();
        expectTokenPark(address(vault), frontDoor, tokens, 4e18, MockAlphaVault.IsHalted.selector);
        av.unpause();
        vm.warp(vm.getBlockTimestamp() + adapter.PARK_TIMEOUT());

        expectRefund(address(vault), mixed, entries1(alice, 6e18), FEE);
        expectRefund(address(vault), tokens, entries2(alice, 3e18, carol, 1e18), FEE);
        uint256[2] memory counts = [uint256(1), 2];
        for (uint256 i; i < 2; ++i) {
            (,, bytes memory payouts) = adapter.decodePayload(router.sendAt(i).data);
            (, uint32 chunk, CascadeMessages.Entry[] memory p) = CascadeMessages.decodePayouts(payouts);
            assertEq(chunk, REFUND_CHUNK);
            assertEq(p.length, counts[i], "the deposits' entries alone");
            for (uint256 j; j < p.length; ++j) {
                assertTrue(p[j].user != bob, "no redeemer is paid");
            }
        }
        assertEq(vault.balanceOf(bob), 2e24, "the redeems were never burned");
        assertEq(vault.totalSupply(), supply);
        assertEq(vaultLens.pendingPayouts(), 0, "no payout queued");
        assertEq(adapter.parkedNative(), 0);
        assertEq(adapter.parkedTokens(), 0);
        assertEq(address(adapter).balance, RESERVE);
        assertEq(taoBit.balanceOf(address(router)), 10e18, "the deposits' 6 + 4 TAO");
    }

    /// refundParked and dropParked take the adapter's one lock (H-3): a recipient that re-enters either from inside
    /// a delivery is refused ReentrancyGuardReentrantCall (not the InsufficientFee or the success it would meet
    /// unlocked), for parks old enough to refund and to drop, which anyone then refunds and drops outside the lock.
    function test_refundAndDropAreUnderTheLock() public {
        vm.prank(guardian);
        vault.pause();
        bytes memory full = depositBatch(1, alice, 1e18);
        bytes32 fullKey = expectNativePark(address(vault), frontDoor, full, 1e18, Pausable.EnforcedPause.selector);
        bytes memory empty = redeemBatch(2, alice, 1e24);
        bytes32 emptyKey = expectNativePark(address(vault), frontDoor, empty, 0, Pausable.EnforcedPause.selector);
        uint64 since = uint64(vm.getBlockTimestamp());
        vm.warp(since + adapter.PARK_TIMEOUT());

        ReentrantRecipient r = new ReentrantRecipient();
        bytes[2] memory reentries = [
            abi.encodeCall(CcipBittensorAdapter.refundParked, (address(vault), frontDoor, full)),
            abi.encodeCall(CcipBittensorAdapter.dropParked, (address(vault), frontDoor, empty))
        ];
        for (uint256 i; i < reentries.length; ++i) {
            r.setMode(ReentrantRecipient.Mode.RevertThenReenter, address(adapter), reentries[i], false);
            // casting to 'uint64' is safe because i is 0 or 1
            // forge-lint: disable-next-line(unsafe-typecast)
            (bool ok,) = deliver(ccip(address(r), frontDoor, depositBatch(uint64(10 + i), carol, 1e18), 1e18));
            assertTrue(ok, "delivered to the recipient");
            assertFalse(r.reentryOk(), "the re-entry refused");
            assertEq(r.reentryReturn(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        }
        assertEq(r.delivered(), 2);
        assertParkedSince(fullKey, 1e18, true, since);
        assertParkedSince(emptyKey, 0, true, since);
        assertEq(router.sendCount(), 0);

        expectRefund(address(vault), full, entries1(alice, 1e18), FEE);
        vm.prank(anyone);
        adapter.dropParked(address(vault), frontDoor, empty);
        assertNotParked(emptyKey);
        assertEq(adapter.parkedNative(), 0);
        assertEq(address(adapter).balance, RESERVE);
    }

    // ---- Task 28: the cushion under a converted refund, and the sweep (fundCushion, shortfallsLogged:
    // CushionHelpers) ----

    /// A converted refund goes back into the token through _collect, so the send side's tolerance holds there too
    /// (Task 28, spec §3.3): ForeverMoney minting up to 1 rao less than the park's TAO is made up from the token
    /// cushion, with ShortfallCovered, never from the token park beside it, and the refund still carries the park's
    /// whole amount, each depositor's exact deposit (I-9).
    function test_aConvertedRefundOneRaoShortIsCoveredByTheCushion() public {
        vm.prank(guardian);
        vault.pause();
        bytes memory message = twoDeposits(1, 6e18, 4e18);
        expectNativePark(address(vault), frontDoor, message, 10e18, Pausable.EnforcedPause.selector);
        bytes32 tokenKey = tokenPark(address(vault), depositBatch(2, carol, 5e18), 5e18);
        uint64 since = uint64(vm.getBlockTimestamp());
        vm.warp(since + adapter.PARK_TIMEOUT());
        fundCushion(taoBit, address(adapter), 1e15);

        av.setShortBy(1e9);
        vm.recordLogs();
        expectRefund(address(vault), message, entries2(alice, 6e18, bob, 4e18), FEE);
        uint256[] memory covered = shortfallsLogged(address(adapter));
        assertEq(covered.length, 1, "one shortfall covered");
        assertEq(covered[0], 1e9, "the rao");
        assertEq(taoBit.balanceOf(address(router)), 10e18, "the park's whole amount");
        assertEq(taoBit.balanceOf(address(adapter)), 5e18 + 1e15 - 1e9, "the cushion paid the rao");
        assertEq(adapter.parkedTokens(), 5e18);
        assertParkedSince(tokenKey, 5e18, false, since);
        assertEq(adapter.parkedNative(), 0);
        assertEq(address(adapter).balance, RESERVE, "the native reserve untouched");
    }

    /// With the cushion empty, a converted refund 1 rao short reverts ConversionShort, as a payout send does, and its
    /// record and the native park stay (I-10: it stays refundable); the token park beside it, which could have paid the
    /// rao, never does. A plain transfer that tops the cushion up unblocks the refund.
    function test_aConvertedRefundWaitsForADrainedCushion() public {
        vm.prank(guardian);
        vault.pause();
        bytes memory message = twoDeposits(1, 6e18, 4e18);
        bytes32 key = expectNativePark(address(vault), frontDoor, message, 10e18, Pausable.EnforcedPause.selector);
        bytes32 tokenKey = tokenPark(address(vault), depositBatch(2, carol, 5e18), 5e18);
        uint64 since = uint64(vm.getBlockTimestamp());
        vm.warp(since + adapter.PARK_TIMEOUT());
        assertEq(taoBit.balanceOf(address(adapter)), adapter.parkedTokens(), "no cushion");

        av.setShortBy(1e9);
        vm.prank(anyone);
        vm.expectRevert(CcipAdapterBase.ConversionShort.selector);
        adapter.refundParked{value: FEE}(address(vault), frontDoor, message);
        assertParkedSince(key, 10e18, true, since);
        assertEq(adapter.parkedNative(), 10e18);
        assertEq(address(adapter).balance, RESERVE + 10e18);
        assertEq(taoBit.balanceOf(address(adapter)), 5e18, "the token park never pays the rao");
        assertEq(router.sendCount(), 0);

        fundCushion(taoBit, address(adapter), 1e9);
        vm.recordLogs();
        expectRefund(address(vault), message, entries2(alice, 6e18, bob, 4e18), FEE);
        assertEq(shortfallsLogged(address(adapter)).length, 1);
        assertEq(taoBit.balanceOf(address(adapter)), 5e18, "the top-up paid the rao");
        assertParkedSince(tokenKey, 5e18, false, since);
        assertEq(address(adapter).balance, RESERVE);
    }

    /// Task 27's carry: a refund's kept fee excess is surplus, and the sweep sends exactly it to the treasury once the
    /// native reserve is at RESERVE_TARGET, while another batch's native park beside it stays whole (I-7).
    function test_sweepTakesARefundsKeptFeeExcess() public {
        vm.prank(guardian);
        vault.pause();
        bytes memory converted = twoDeposits(1, 6e18, 4e18);
        expectNativePark(address(vault), frontDoor, converted, 10e18, Pausable.EnforcedPause.selector);
        bytes32 otherKey = expectNativePark(
            address(vault), frontDoor, depositBatch(2, carol, 3e18), 3e18, Pausable.EnforcedPause.selector
        );
        bytes memory tokens = depositBatch(3, carol, 1e15);
        expectTokenPark(address(vault), frontDoor, tokens, 1e15, CcipAdapterBase.BelowConversionFloor.selector);
        uint64 since = uint64(vm.getBlockTimestamp());
        vm.warp(since + adapter.PARK_TIMEOUT());
        uint256 target = adapter.RESERVE_TARGET();
        adapter.fundReserve{value: target - RESERVE}();

        expectRefund(address(vault), converted, entries2(alice, 6e18, bob, 4e18), FEE + 7e14);
        expectRefund(address(vault), tokens, entries1(carol, 1e15), FEE + 3e14);
        assertEq(address(adapter).balance, target + 3e18 + 7e14 + 3e14);

        vm.expectEmit(address(adapter));
        emit CcipAdapterBase.SurplusSwept(7e14 + 3e14, 0);
        vm.prank(anyone);
        adapter.sweepSurplus();
        assertEq(treasury.balance, 7e14 + 3e14, "exactly the refunds' kept excess");
        assertEq(address(adapter).balance, target + 3e18, "the reserve and the other park");
        assertEq(adapter.parkedNative(), 3e18);
        assertParkedSince(otherKey, 3e18, true, since);
        assertOwed(adapter, taoBit);
    }
}
