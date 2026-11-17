// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CascadeVault} from "../src/CascadeVault.sol";
import {CascadeVaultLens} from "../src/lens/CascadeVaultLens.sol";
import {ISTAKING_ADDRESS} from "../src/interfaces/IStaking.sol";
import {ADDRESS_MAPPING_ADDRESS} from "../src/interfaces/IAddressMapping.sol";
import {CascadeMessages} from "../src/libraries/CascadeMessages.sol";
import {VaultLayout} from "../src/lens/generated/VaultLayout.sol";
import {MockStaking} from "./mocks/MockStaking.sol";
import {MockAddressMapping} from "./mocks/MockAddressMapping.sol";
import {StubBridge} from "./mocks/StubBridge.sol";
import {mirror} from "./mocks/Mirror.sol";
import {defaultVaultParams} from "./utils/DefaultParams.sol";
import {Schedule} from "./governance/Schedule.sol";

/// @notice Shared vault fixture: precompile mocks etched, native stub bridge, vault deployed at its
/// predicted address on vaultParams() (the keeper set and (BASE, frontDoor) its launch door, active from
/// the deploy, both from the constructor), the existential reserve funded, and the vault lens built on it.
abstract contract VaultTestBase is Test {
    uint64 constant BASE = 8453;
    uint64 constant BITTENSOR = 964;
    bytes32 constant HK1 = bytes32(uint256(1));
    bytes32 constant HK2 = bytes32(uint256(2));
    bytes32 constant HK3 = bytes32(uint256(3));
    bytes32 constant HK4 = bytes32(uint256(4));
    bytes32 constant HK5 = bytes32(uint256(5));
    uint256 constant ED = 1e12;

    /// The owner, and its key for signed stamps (stampBySig, spec §3.6): makeAddrAndKey("owner"), the
    /// address makeAddr("owner") gave, set in the constructor so every initializer and setUp can use both.
    address owner;
    uint256 ownerKey;
    address guardian = makeAddr("guardian");
    address keeper = makeAddr("keeper");
    address frontDoor = makeAddr("frontDoor");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    MockStaking staking = MockStaking(ISTAKING_ADDRESS);
    StubBridge bridge;
    CascadeVault vault;
    /// The read-only lens on `vault` (spec §8.1).
    CascadeVaultLens vaultLens;
    uint64 nextBatchId;
    /// When `vault` was deployed: the seed of its keeper-fallback timestamps.
    uint256 deployedAt;

    constructor() {
        (owner, ownerKey) = makeAddrAndKey("owner");
    }

    function setUp() public virtual {
        vm.etch(ISTAKING_ADDRESS, address(new MockStaking()).code);
        vm.etch(ADDRESS_MAPPING_ADDRESS, address(new MockAddressMapping()).code);
        staking.addHotkey(HK1);
        staking.addHotkey(HK2);
        staking.addHotkey(HK3);
        staking.addHotkey(HK4);
        staking.addHotkey(HK5);

        bridge = new StubBridge(IERC20(address(0)));
        bridge.setFee(1e15);

        // A chain's clock, a day in, so the first burn opens its own 24-hour window as on a live chain (a
        // fresh EVM starts at time 1, inside the zero window). Until Task 6 the registry delay of the launch
        // door's activation moved the clock a week after the deploy; the constructor now activates it.
        vm.warp(vm.getBlockTimestamp() + 1 days);
        deployedAt = vm.getBlockTimestamp();
        vault = freshVault();
        vaultLens = new CascadeVaultLens(address(vault));
        // The operator funds the existential reserve before use (Task 13 documents it).
        vm.deal(address(vault), ED);
    }

    /// The fixture vault's constructor arguments (DefaultParams.sol, ruling A12): staking to HK1 through
    /// the stub bridge, with the keeper set and (BASE, frontDoor) the launch door. Its expected coldkey is
    /// the mirror of the address this contract's next CREATE gets, so build the vault on it at once
    /// (`new CascadeVault(vaultParams())`); a suite overrides it to change a value for all its vaults.
    function vaultParams() internal view virtual returns (CascadeVault.Params memory) {
        bytes32 expectedColdkey = mirror(vm.computeCreateAddress(address(this), vm.getNonce(address(this))));
        return defaultVaultParams(expectedColdkey, HK1, bridge, owner, guardian, keeper, BASE, frontDoor);
    }

    /// A vault deployed now at its predicted address on vaultParams() (no reserve funded).
    function freshVault() internal returns (CascadeVault) {
        return deployVault(vaultParams());
    }

    /// The vault the fixture deploys on `p`: a CascadeVault, or in the lens parity tests a test-only
    /// subclass (VaultInternals) with the same constructor.
    function deployVault(CascadeVault.Params memory p) internal virtual returns (CascadeVault) {
        return new CascadeVault(p);
    }

    /// Activates front door (chain, addr) on the vault through the scheduler: its activation scheduled, the
    /// Registry class's 7 days warped, then executed.
    function registerFrontDoor(uint64 chain, address addr) internal {
        Schedule.run(vault, owner, abi.encodeCall(CascadeVault.activateFrontDoor, (chain, addr)));
    }

    /// A direct holder seeded: `user`'s depositDirect of `amount`, its shares then aged past the door hold
    /// (matureShares), as depositVia's are.
    function depositDirect(address user, uint256 amount) internal {
        vm.deal(user, user.balance + amount);
        vm.prank(user);
        vault.depositDirect{value: amount}();
        matureShares(user);
    }

    /// Delivers a BATCH from (chain, sender) through the stub bridge with value == amount == Σ deposits.
    function deliver(
        uint64 chain,
        address sender,
        uint64 batchId,
        CascadeMessages.Entry[] memory deposits,
        CascadeMessages.Entry[] memory redeems
    ) internal returns (bytes32 key) {
        bytes memory message = CascadeMessages.encodeBatch(batchId, deposits, redeems);
        uint256 sum;
        for (uint256 i; i < deposits.length; ++i) {
            sum += deposits[i].amount;
        }
        vm.deal(address(bridge), address(bridge).balance + sum);
        vm.prank(address(bridge));
        vault.onBridgeMessage{value: sum}(chain, sender, message, sum);
        return vaultLens.batchKey(chain, sender, message);
    }

    /// processPayouts as `caller`, with `value` from its balance (the fee valve's top-up, Task 21), through a plain
    /// call; bubbles a revert, so vm.expectRevert reads it as the vault's.
    function processPayoutsFrom(
        address caller,
        uint256 value,
        bytes32 key,
        CascadeMessages.Payout[] memory payouts,
        uint32 maxEntries
    ) internal {
        vm.prank(caller);
        (bool ok, bytes memory ret) =
            address(vault).call{value: value}(abi.encodeCall(CascadeVault.processPayouts, (key, payouts, maxEntries)));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    /// Burn window `peer` as the vault stores it (L1 writes it only when it burns), read raw at the generated slots:
    /// the lens's burnWindows serves it as of now (R2 F4), a window past its day or never written as a fresh one.
    function storedBurnWindow(bytes32 peer) internal view returns (uint64 start, uint256 burned) {
        uint256 slot = uint256(keccak256(abi.encode(peer, VaultLayout.SLOT_BURN_WINDOWS)));
        start = uint64(
            uint256(vm.load(address(vault), bytes32(slot + VaultLayout.WINDOW_START_SLOT)))
                >> (8 * VaultLayout.WINDOW_START_OFFSET)
        );
        burned = uint256(vm.load(address(vault), bytes32(slot + VaultLayout.WINDOW_BURNED_SLOT)));
    }

    /// `user`'s fresh shares aged past the door hold (spec §3.5, R4 B-H1) with nothing else moved: its holder record's
    /// clock and fresh shares cleared at the generated layout, its redeem origin kept, as if its last mint were more than
    /// a day old.
    function matureShares(address user) internal {
        bytes32 slot = keccak256(abi.encode(user, VaultLayout.SLOT_HOLDERS));
        uint256 word = uint256(vm.load(address(vault), slot));
        vm.store(address(vault), slot, bytes32(word & type(uint64).max));
    }

    /// A holder seeded through the launch door: `user`'s deposit of `amount` delivered, its shares then aged past the
    /// door hold (matureShares), as a holder of long standing's are. A test of the hold itself delivers its deposits
    /// with `deliver`, fresh.
    function depositVia(address user, uint256 amount) internal returns (bytes32 key) {
        key = deliver(BASE, frontDoor, ++nextBatchId, entries1(user, amount), noEntries());
        matureShares(user);
    }

    function entries1(address user, uint256 amount) internal pure returns (CascadeMessages.Entry[] memory e) {
        e = new CascadeMessages.Entry[](1);
        e[0] = CascadeMessages.Entry(user, amount);
    }

    function noEntries() internal pure returns (CascadeMessages.Entry[] memory) {
        return new CascadeMessages.Entry[](0);
    }
}
