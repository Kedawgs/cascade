// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {ICascadeTwap} from "../../src/interfaces/ICascadeTwap.sol";
import {IExtsload} from "../../src/interfaces/IExtsload.sol";
import {Actor, DoorState, Item, PayoutBatch} from "../../src/CascadeTypes.sol";
import {DoorLayout} from "../../src/lens/generated/DoorLayout.sol";
import {VaultLayout} from "../../src/lens/generated/VaultLayout.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {MockTAO} from "../mocks/MockTAO.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {StubBridge} from "../mocks/StubBridge.sol";
import {VaultInternals} from "../utils/VaultInternals.sol";
import {DoorInternals} from "../utils/DoorInternals.sol";
import {defaultFrontDoorParams} from "../utils/DefaultParams.sol";
import {CascadeDoorLens} from "../../src/lens/CascadeDoorLens.sol";
import {Schedule} from "../governance/Schedule.sol";

/// extsload on the vault and the front door (CascadeBase, spec §8.1): a view that returns one storage
/// slot's raw word, and nothing else; and the generated layout constants, checked against the
/// compiler's own reads, which decode the same storage independently of the generator: the targets'
/// getters where they keep them (the vault's token, the front door's own), and for the state whose
/// getters are internal (CascadeBase's since Task 5d-1, the vault's own since Task 5d-2) the
/// test-only subclasses' exposures (VaultInternals, DoorInternals), which add no storage. Never the
/// lens, which reads through the generated constants under test.
contract ExtsloadTest is VaultTestBase {
    DoorInternals fd;
    /// The read-only lens on `fd`, built as every fixture builds it; these tests read through extsload,
    /// never through it.
    CascadeDoorLens doorLens;
    VaultInternals vaultInternals;
    address fdKeeper = makeAddr("fdKeeper");

    function deployVault(CascadeVault.Params memory p) internal override returns (CascadeVault) {
        return new VaultInternals(p);
    }

    function setUp() public override {
        super.setUp();
        vaultInternals = VaultInternals(payable(address(vault)));
        MockTAO tao = new MockTAO(18);
        StubBridge fdBridge = new StubBridge(tao);
        fd = new DoorInternals(
            defaultFrontDoorParams(tao, fdBridge, BITTENSOR, address(vault), new MockUSDC(), owner, guardian, fdKeeper)
        );
        doorLens = new CascadeDoorLens(address(fd));
        assertEq(doorLens.keeper(), fdKeeper);
    }

    // ---- helpers ----

    /// The value `size` bytes long at byte `offset` of `target`'s slot `slot`, read through extsload.
    function field(address target, uint256 slot, uint256 offset, uint256 size) internal view returns (uint256) {
        uint256 word = uint256(IExtsload(target).extsload(bytes32(slot)));
        return size == 32 ? word : (word >> (offset * 8)) & ((uint256(1) << (size * 8)) - 1);
    }

    /// Writes `value` into the `size` bytes at byte `offset` of `target`'s slot `slot`, keeping the rest.
    function put(address target, uint256 slot, uint256 offset, uint256 size, uint256 value) internal {
        uint256 mask = size == 32 ? type(uint256).max : ((uint256(1) << (size * 8)) - 1) << (offset * 8);
        uint256 word = uint256(vm.load(target, bytes32(slot)));
        vm.store(target, bytes32(slot), bytes32((word & ~mask) | ((value << (offset * 8)) & mask)));
    }

    function mappingSlot(bytes32 key, uint256 slot) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(key, slot)));
    }

    /// Each member of the item at `itemSlot` in `target`, read through extsload at the generated Item
    /// constants (`m`: slot, offset and size of scheduledAt, readyAt, class, kind, selector), equals `item`,
    /// the target's own read of it.
    function assertItemMembers(address target, uint256 itemSlot, uint256[3][5] memory m, Item memory item)
        internal
        view
    {
        assertGt(item.readyAt, 0, "an item is scheduled");
        uint256[5] memory want =
            [uint256(item.scheduledAt), item.readyAt, uint8(item.class), uint8(item.kind), uint32(item.selector)];
        for (uint256 i; i < 5; ++i) {
            assertEq(field(target, itemSlot + m[i][0], m[i][1], m[i][2]), want[i], "an Item member");
        }
    }

    /// Every slot from 0 to `last` and a far, hashed one read the same through extsload as vm.load.
    function assertRawSlots(address target, uint256 last, uint256 far) internal view {
        for (uint256 slot; slot <= last; ++slot) {
            assertEq(IExtsload(target).extsload(bytes32(slot)), vm.load(target, bytes32(slot)), "slot");
        }
        assertEq(IExtsload(target).extsload(bytes32(far)), vm.load(target, bytes32(far)), "far slot");
    }

    // ---- extsload ----

    function test_extsloadReturnsTheRawSlot() public {
        depositDirect(alice, 5e18);
        vm.prank(owner);
        bytes32 id = vault.schedule(abi.encodeCall(vault.setGuardian, (bob)));
        // every declared slot (the last is unstakeMarginRao), one past it, and the balance of alice
        uint256 balances = VaultLayout.SLOT_SHARES + VaultLayout.SHARES_DATA_BALANCE_OF_SLOT;
        uint256 aliceSlot = mappingSlot(bytes32(uint256(uint160(alice))), balances);
        assertRawSlots(address(vault), VaultLayout.SLOT_UNSTAKE_MARGIN_RAO + 1, aliceSlot);
        assertEq(uint256(vault.extsload(bytes32(aliceSlot))), vault.balanceOf(alice));
        assertGt(vault.balanceOf(alice), 0);
        // and the scheduled item's slot, a hashed one: the raw word, not zero
        bytes32 itemSlot = bytes32(mappingSlot(id, VaultLayout.SLOT_SCHEDULED));
        assertEq(vault.extsload(itemSlot), vm.load(address(vault), itemSlot));
        assertTrue(vault.extsload(itemSlot) != bytes32(0), "the item is written");

        // any slot, written or not: the raw word, all 32 bytes
        bytes32 far = keccak256("anywhere");
        assertEq(vault.extsload(far), bytes32(0));
        vm.store(address(vault), far, bytes32(type(uint256).max - 7));
        assertEq(vault.extsload(far), bytes32(type(uint256).max - 7));

        assertRawSlots(address(fd), DoorLayout.SLOT_MAX_DELIVERY_SLIPPAGE_BPS + 1, uint256(far));
        vm.store(address(fd), far, bytes32(uint256(42)));
        assertEq(fd.extsload(far), bytes32(uint256(42)));
    }

    function test_extsloadIsASingleSlotView() public view {
        // a static call succeeds and returns exactly one word
        bytes32 slot = bytes32(VaultLayout.SLOT_GUARDIAN);
        for (uint256 i; i < 2; ++i) {
            address target = i == 0 ? address(vault) : address(fd);
            (bool ok, bytes memory ret) = target.staticcall(abi.encodeCall(IExtsload.extsload, (slot)));
            assertTrue(ok);
            assertEq(ret.length, 32);
            // and never a batch form: neither a list of slots nor a start and a count
            (ok,) = target.staticcall(abi.encodeWithSignature("extsload(bytes32[])", new bytes32[](1)));
            assertFalse(ok);
            (ok,) = target.staticcall(abi.encodeWithSignature("extsload(bytes32,uint256)", slot, uint256(2)));
            assertFalse(ok);
        }
    }

    // ---- the generated constants against the compiler's getters ----

    function test_generatedVariablesMatchTheVaultsGetters() public {
        // the reward cut to carol is a loosening: through the scheduler first (Task 11)
        Schedule.run(vault, owner, abi.encodeCall(vault.setRewardCut, (carol, 1_500)));
        depositDirect(alice, 5e18);
        vm.startPrank(owner);
        bytes32 id = vault.schedule(abi.encodeCall(vault.setGuardian, (bob)));
        vault.setPayoutDelay(30 hours);
        vm.stopPrank();
        address v = address(vault);

        assertEq(field(v, VaultLayout.SLOT_SHARES, 0, 32), vault.totalSupply());
        assertEq(
            field(v, VaultLayout.SLOT_GUARDIAN, VaultLayout.OFFSET_GUARDIAN, VaultLayout.SIZE_GUARDIAN),
            uint160(vaultInternals.exposed_guardian())
        );
        // the scheduled item (one slot of the scheduled mapping), member by member
        assertItemMembers(
            v,
            mappingSlot(id, VaultLayout.SLOT_SCHEDULED),
            [
                [
                    VaultLayout.ITEM_SCHEDULED_AT_SLOT,
                    VaultLayout.ITEM_SCHEDULED_AT_OFFSET,
                    VaultLayout.ITEM_SCHEDULED_AT_SIZE
                ],
                [VaultLayout.ITEM_READY_AT_SLOT, VaultLayout.ITEM_READY_AT_OFFSET, VaultLayout.ITEM_READY_AT_SIZE],
                [VaultLayout.ITEM_CLASS_SLOT, VaultLayout.ITEM_CLASS_OFFSET, VaultLayout.ITEM_CLASS_SIZE],
                [VaultLayout.ITEM_KIND_SLOT, VaultLayout.ITEM_KIND_OFFSET, VaultLayout.ITEM_KIND_SIZE],
                [VaultLayout.ITEM_SELECTOR_SLOT, VaultLayout.ITEM_SELECTOR_OFFSET, VaultLayout.ITEM_SELECTOR_SIZE]
            ],
            vaultInternals.exposed_scheduled(id)
        );
        assertEq(
            field(
                v, VaultLayout.SLOT_PRIMARY_BRIDGE, VaultLayout.OFFSET_PRIMARY_BRIDGE, VaultLayout.SIZE_PRIMARY_BRIDGE
            ),
            uint160(vaultInternals.exposed_primaryBridge())
        );
        assertEq(
            field(v, VaultLayout.SLOT_KEEPER, VaultLayout.OFFSET_KEEPER, VaultLayout.SIZE_KEEPER),
            uint160(vaultInternals.exposed_keeper())
        );
        assertEq(
            field(v, VaultLayout.SLOT_LAST_STAKE_AT, VaultLayout.OFFSET_LAST_STAKE_AT, VaultLayout.SIZE_LAST_STAKE_AT),
            vaultInternals.exposed_lastStakeAt()
        );
        assertEq(
            field(v, VaultLayout.SLOT_TREASURY, VaultLayout.OFFSET_TREASURY, VaultLayout.SIZE_TREASURY),
            uint160(vaultInternals.exposed_treasury())
        );
        assertEq(
            field(
                v, VaultLayout.SLOT_REWARD_CUT_BPS, VaultLayout.OFFSET_REWARD_CUT_BPS, VaultLayout.SIZE_REWARD_CUT_BPS
            ),
            vaultInternals.exposed_rewardCutBps()
        );
        assertEq(
            field(v, VaultLayout.SLOT_MIN_CHUNK, VaultLayout.OFFSET_MIN_CHUNK, VaultLayout.SIZE_MIN_CHUNK),
            vaultInternals.exposed_minChunk()
        );
        assertEq(
            field(v, VaultLayout.SLOT_PAYOUT_DELAY, VaultLayout.OFFSET_PAYOUT_DELAY, VaultLayout.SIZE_PAYOUT_DELAY),
            vaultInternals.exposed_payoutDelay()
        );
        assertEq(field(v, VaultLayout.SLOT_STAKE_HOTKEY, 0, 32), uint256(vaultInternals.exposed_stakeHotkey()));
        assertEq(field(v, VaultLayout.SLOT_UNSTAKE_MARGIN_RAO, 0, 32), vaultInternals.exposed_unstakeMarginRao());
        // a dynamic array's slot holds its length; its first element sits at keccak256(slot)
        assertEq(field(v, VaultLayout.SLOT_HOTKEYS, 0, 32), 1);
        assertEq(
            field(v, uint256(keccak256(abi.encode(VaultLayout.SLOT_HOTKEYS))), 0, 32),
            uint256(vaultInternals.exposed_hotkeys(0))
        );
    }

    /// The exits machine's state (Task 8), one packed slot on each target after CascadeBase's scheduler state:
    /// the guardian's disable of each primary reads the same through extsload at the constants as inside the
    /// target; then a distinct value written into each variable by the constants reads back through the
    /// target's own read, so a wrong slot, offset or size shows as a wrong variable.
    function test_generatedExitsMachineVariablesMatchBothTargets() public {
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.startPrank(guardian);
        vault.disableBridge(address(bridge));
        fd.disableBridge(doorLens.primaryBridge());
        vm.stopPrank();
        uint64 t = uint64(vm.getBlockTimestamp());
        address v = address(vault);
        address d = address(fd);
        assertEq(VaultLayout.SLOT_LAST_OWNER_CLOSE, VaultLayout.SLOT_BRIDGE_KNOWN + 1);
        assertEq(DoorLayout.SLOT_LAST_OWNER_CLOSE, DoorLayout.SLOT_BRIDGE_KNOWN + 1);

        uint256[3][3] memory vc = [
            [VaultLayout.SLOT_LAST_OWNER_CLOSE, VaultLayout.OFFSET_LAST_OWNER_CLOSE, VaultLayout.SIZE_LAST_OWNER_CLOSE],
            [
                VaultLayout.SLOT_LAST_GUARDIAN_CLOSE,
                VaultLayout.OFFSET_LAST_GUARDIAN_CLOSE,
                VaultLayout.SIZE_LAST_GUARDIAN_CLOSE
            ],
            [
                VaultLayout.SLOT_PRIMARY_DISABLED_BY,
                VaultLayout.OFFSET_PRIMARY_DISABLED_BY,
                VaultLayout.SIZE_PRIMARY_DISABLED_BY
            ]
        ];
        uint256[3][3] memory dc = [
            [DoorLayout.SLOT_LAST_OWNER_CLOSE, DoorLayout.OFFSET_LAST_OWNER_CLOSE, DoorLayout.SIZE_LAST_OWNER_CLOSE],
            [
                DoorLayout.SLOT_LAST_GUARDIAN_CLOSE,
                DoorLayout.OFFSET_LAST_GUARDIAN_CLOSE,
                DoorLayout.SIZE_LAST_GUARDIAN_CLOSE
            ],
            [
                DoorLayout.SLOT_PRIMARY_DISABLED_BY,
                DoorLayout.OFFSET_PRIMARY_DISABLED_BY,
                DoorLayout.SIZE_PRIMARY_DISABLED_BY
            ]
        ];
        // the real record and stamp
        assertEq(field(v, vc[0][0], vc[0][1], vc[0][2]), vaultInternals.exposed_lastOwnerClose());
        assertEq(field(v, vc[1][0], vc[1][1], vc[1][2]), t);
        assertEq(vaultInternals.exposed_lastGuardianClose(), t);
        assertEq(field(v, vc[2][0], vc[2][1], vc[2][2]), uint8(Actor.Guardian));
        assertEq(uint8(vaultInternals.exposed_primaryDisabledBy()), uint8(Actor.Guardian));
        assertEq(field(d, dc[0][0], dc[0][1], dc[0][2]), fd.exposed_lastOwnerClose());
        assertEq(field(d, dc[1][0], dc[1][1], dc[1][2]), t);
        assertEq(fd.exposed_lastGuardianClose(), t);
        assertEq(field(d, dc[2][0], dc[2][1], dc[2][2]), uint8(Actor.Guardian));
        assertEq(uint8(fd.exposed_primaryDisabledBy()), uint8(Actor.Guardian));

        // distinct values through the constants, read back inside each target
        uint256[3] memory values = [uint256(type(uint64).max - 1), 7, uint8(Actor.Owner)];
        for (uint256 i; i < 3; ++i) {
            put(v, vc[i][0], vc[i][1], vc[i][2], values[i]);
            put(d, dc[i][0], dc[i][1], dc[i][2], values[i]);
        }
        assertEq(vaultInternals.exposed_lastOwnerClose(), type(uint64).max - 1);
        assertEq(vaultInternals.exposed_lastGuardianClose(), 7);
        assertEq(uint8(vaultInternals.exposed_primaryDisabledBy()), uint8(Actor.Owner));
        assertTrue(vaultInternals.exposed_ownerHold());
        assertFalse(vaultInternals.exposed_guardianHold());
        assertEq(fd.exposed_lastOwnerClose(), type(uint64).max - 1);
        assertEq(fd.exposed_lastGuardianClose(), 7);
        assertEq(uint8(fd.exposed_primaryDisabledBy()), uint8(Actor.Owner));
        assertTrue(fd.exposed_ownerHold());
        assertFalse(fd.exposed_exitsOpen());
    }

    /// The vault's own exits-machine state (Task 10): the door states and per-chain counts, two mappings, and
    /// the two holds, one slot. First the real records (the guardian's pause and its removal of the launch
    /// door) read through the constants, then distinct values written through them and read back inside the
    /// vault (VaultInternals' exposures, and the holds they give).
    function test_generatedVaultExitsMachineVariablesMatchTheVault() public {
        address v = address(vault);
        bytes32 launchPeer = vaultInternals.exposed_peerId(BASE, frontDoor);
        uint256 doorEntry = mappingSlot(launchPeer, VaultLayout.SLOT_DOOR_STATE);
        uint256 countEntry = mappingSlot(bytes32(uint256(BASE)), VaultLayout.SLOT_ACTIVE_DOORS);
        assertEq(VaultLayout.SLOT_LAUNCH_DOOR_REMOVED_BY, VaultLayout.SLOT_PAUSED_BY, "the two holds share a slot");
        assertEq(field(v, doorEntry, 0, 1), uint8(DoorState.Active));
        assertEq(field(v, countEntry, 0, 32), 1);

        vm.startPrank(guardian);
        vault.pause();
        vault.removeFrontDoor(BASE, frontDoor);
        vm.stopPrank();
        uint256[3][2] memory holds = [
            [VaultLayout.SLOT_PAUSED_BY, VaultLayout.OFFSET_PAUSED_BY, VaultLayout.SIZE_PAUSED_BY],
            [
                VaultLayout.SLOT_LAUNCH_DOOR_REMOVED_BY,
                VaultLayout.OFFSET_LAUNCH_DOOR_REMOVED_BY,
                VaultLayout.SIZE_LAUNCH_DOOR_REMOVED_BY
            ]
        ];
        assertEq(field(v, holds[0][0], holds[0][1], holds[0][2]), uint8(Actor.Guardian));
        assertEq(field(v, holds[1][0], holds[1][1], holds[1][2]), uint8(Actor.Guardian));
        assertEq(field(v, doorEntry, 0, 1), uint8(DoorState.Unknown));
        assertEq(field(v, countEntry, 0, 32), 0);
        assertEq(uint8(vaultInternals.exposed_pausedBy()), uint8(Actor.Guardian));
        assertEq(uint8(vaultInternals.exposed_launchDoorRemovedBy()), uint8(Actor.Guardian));

        // distinct values through the constants, read back inside the vault
        put(v, holds[0][0], holds[0][1], holds[0][2], uint8(Actor.Owner));
        put(v, holds[1][0], holds[1][1], holds[1][2], uint8(Actor.None));
        put(v, doorEntry, 0, 1, uint8(DoorState.Removed));
        put(v, countEntry, 0, 32, 7);
        assertEq(uint8(vaultInternals.exposed_pausedBy()), uint8(Actor.Owner));
        assertEq(uint8(vaultInternals.exposed_launchDoorRemovedBy()), uint8(Actor.None));
        assertEq(uint8(vaultInternals.exposed_doorState(launchPeer)), uint8(DoorState.Removed));
        assertEq(vaultInternals.exposed_activeDoors(BASE), 7);
        assertTrue(vaultInternals.exposed_ownerHold());
        assertFalse(vaultInternals.exposed_guardianHold());
        put(v, holds[1][0], holds[1][1], holds[1][2], uint8(Actor.Guardian));
        assertEq(uint8(vaultInternals.exposed_pausedBy()), uint8(Actor.Owner), "the neighbour byte kept");
        assertTrue(vaultInternals.exposed_guardianHold());
    }

    function test_generatedStructMembersMatchTheVaultsGetters() public {
        address v = address(vault);
        // SharesData: the supply and a balance
        depositDirect(alice, 5e18);
        uint256 balances = VaultLayout.SLOT_SHARES + VaultLayout.SHARES_DATA_BALANCE_OF_SLOT;
        assertEq(
            field(v, VaultLayout.SLOT_SHARES + VaultLayout.SHARES_DATA_TOTAL_SUPPLY_SLOT, 0, 32), vault.totalSupply()
        );
        assertEq(field(v, mappingSlot(bytes32(uint256(uint160(alice))), balances), 0, 32), vault.balanceOf(alice));

        // PayoutBatch: a distinct value written into each member by the constants, read back by the
        // compiler's own read inside the vault, so a wrong slot, offset or size shows as a wrong member
        bytes32 key = keccak256("a batch");
        uint256 b = mappingSlot(key, VaultLayout.SLOT_PAYOUT_BATCHES);
        put(
            v,
            b + VaultLayout.PAYOUT_BATCH_SOURCE_CHAIN_SLOT,
            VaultLayout.PAYOUT_BATCH_SOURCE_CHAIN_OFFSET,
            VaultLayout.PAYOUT_BATCH_SOURCE_CHAIN_SIZE,
            8453
        );
        put(
            v,
            b + VaultLayout.PAYOUT_BATCH_FRONT_DOOR_SLOT,
            VaultLayout.PAYOUT_BATCH_FRONT_DOOR_OFFSET,
            VaultLayout.PAYOUT_BATCH_FRONT_DOOR_SIZE,
            uint160(frontDoor)
        );
        put(
            v,
            b + VaultLayout.PAYOUT_BATCH_BATCH_ID_SLOT,
            VaultLayout.PAYOUT_BATCH_BATCH_ID_OFFSET,
            VaultLayout.PAYOUT_BATCH_BATCH_ID_SIZE,
            type(uint64).max - 1
        );
        put(
            v,
            b + VaultLayout.PAYOUT_BATCH_QUEUED_AT_SLOT,
            VaultLayout.PAYOUT_BATCH_QUEUED_AT_OFFSET,
            VaultLayout.PAYOUT_BATCH_QUEUED_AT_SIZE,
            1_700_000_000
        );
        put(
            v,
            b + VaultLayout.PAYOUT_BATCH_CURSOR_SLOT,
            VaultLayout.PAYOUT_BATCH_CURSOR_OFFSET,
            VaultLayout.PAYOUT_BATCH_CURSOR_SIZE,
            3
        );
        put(
            v,
            b + VaultLayout.PAYOUT_BATCH_COUNT_SLOT,
            VaultLayout.PAYOUT_BATCH_COUNT_OFFSET,
            VaultLayout.PAYOUT_BATCH_COUNT_SIZE,
            9
        );
        put(
            v,
            b + VaultLayout.PAYOUT_BATCH_CHUNK_SLOT,
            VaultLayout.PAYOUT_BATCH_CHUNK_OFFSET,
            VaultLayout.PAYOUT_BATCH_CHUNK_SIZE,
            type(uint32).max
        );
        put(
            v,
            b + VaultLayout.PAYOUT_BATCH_REMAINING_SLOT,
            VaultLayout.PAYOUT_BATCH_REMAINING_OFFSET,
            VaultLayout.PAYOUT_BATCH_REMAINING_SIZE,
            42e18
        );
        put(
            v,
            b + VaultLayout.PAYOUT_BATCH_PAYOUTS_HASH_SLOT,
            VaultLayout.PAYOUT_BATCH_PAYOUTS_HASH_OFFSET,
            VaultLayout.PAYOUT_BATCH_PAYOUTS_HASH_SIZE,
            uint256(keccak256("payouts"))
        );
        PayoutBatch memory got = vaultInternals.exposed_getPayoutBatch(key);
        assertEq(got.sourceChain, 8453);
        assertEq(got.frontDoor, frontDoor);
        assertEq(got.batchId, type(uint64).max - 1);
        assertEq(got.queuedAt, 1_700_000_000);
        assertEq(got.cursor, 3);
        assertEq(got.count, 9);
        assertEq(got.chunk, type(uint32).max);
        assertEq(got.remaining, 42e18);
        assertEq(got.payoutsHash, keccak256("payouts"));

        // Window
        bytes32 door = vaultInternals.exposed_peerId(BASE, frontDoor);
        uint256 w = mappingSlot(door, VaultLayout.SLOT_BURN_WINDOWS);
        put(
            v,
            w + VaultLayout.WINDOW_START_SLOT,
            VaultLayout.WINDOW_START_OFFSET,
            VaultLayout.WINDOW_START_SIZE,
            type(uint64).max - 1 days
        );
        put(
            v,
            w + VaultLayout.WINDOW_BURNED_SLOT,
            VaultLayout.WINDOW_BURNED_OFFSET,
            VaultLayout.WINDOW_BURNED_SIZE,
            7e18
        );
        // the exposure serves the current window (R2 F4): a start still in the future reads as stored, its top bits
        // all set; one at type(uint64).max would overflow the rule's start + 24 hours
        (uint64 start, uint256 burned) = vaultInternals.exposed_burnWindows(door);
        assertEq(start, type(uint64).max - 1 days);
        assertEq(burned, 7e18);
    }

    function test_generatedVariablesMatchTheFrontDoorsGetters() public {
        // a new oracle and the slippage up are scheduled (Task 11): through the scheduler first
        Schedule.run(fd, owner, abi.encodeCall(fd.setOracle, (ICascadeTwap(makeAddr("oracle")))));
        Schedule.run(fd, owner, abi.encodeCall(fd.setMaxDeliverySlippage, (250)));
        vm.startPrank(owner);
        bytes32 id = fd.schedule(abi.encodeCall(fd.setGuardian, (bob)));
        fd.setBatchLimits(47, 36);
        fd.setMinPoolLiquidity(0, 7e20);
        fd.setMinPoolLiquidity(1, 3e17);
        vm.stopPrank();
        address d = address(fd);

        // guardian sits at slot 3 in the front door, which has no share token (spec §8.1)
        assertEq(DoorLayout.SLOT_GUARDIAN, 3);
        assertEq(
            field(d, DoorLayout.SLOT_GUARDIAN, DoorLayout.OFFSET_GUARDIAN, DoorLayout.SIZE_GUARDIAN),
            uint160(fd.exposed_guardian())
        );
        assertItemMembers(
            d,
            mappingSlot(id, DoorLayout.SLOT_SCHEDULED),
            [
                [
                    DoorLayout.ITEM_SCHEDULED_AT_SLOT,
                    DoorLayout.ITEM_SCHEDULED_AT_OFFSET,
                    DoorLayout.ITEM_SCHEDULED_AT_SIZE
                ],
                [DoorLayout.ITEM_READY_AT_SLOT, DoorLayout.ITEM_READY_AT_OFFSET, DoorLayout.ITEM_READY_AT_SIZE],
                [DoorLayout.ITEM_CLASS_SLOT, DoorLayout.ITEM_CLASS_OFFSET, DoorLayout.ITEM_CLASS_SIZE],
                [DoorLayout.ITEM_KIND_SLOT, DoorLayout.ITEM_KIND_OFFSET, DoorLayout.ITEM_KIND_SIZE],
                [DoorLayout.ITEM_SELECTOR_SLOT, DoorLayout.ITEM_SELECTOR_OFFSET, DoorLayout.ITEM_SELECTOR_SIZE]
            ],
            fd.exposed_scheduled(id)
        );
        assertEq(
            field(d, DoorLayout.SLOT_PRIMARY_BRIDGE, DoorLayout.OFFSET_PRIMARY_BRIDGE, DoorLayout.SIZE_PRIMARY_BRIDGE),
            uint160(fd.exposed_primaryBridge())
        );
        assertEq(field(d, DoorLayout.SLOT_KEEPER, DoorLayout.OFFSET_KEEPER, DoorLayout.SIZE_KEEPER), uint160(fdKeeper));
        assertEq(
            field(d, DoorLayout.SLOT_BATCH_INTERVAL, DoorLayout.OFFSET_BATCH_INTERVAL, DoorLayout.SIZE_BATCH_INTERVAL),
            fd.batchInterval()
        );
        assertEq(
            field(d, DoorLayout.SLOT_MAX_DEPOSITS, DoorLayout.OFFSET_MAX_DEPOSITS, DoorLayout.SIZE_MAX_DEPOSITS),
            fd.maxDeposits()
        );
        assertEq(
            field(d, DoorLayout.SLOT_MAX_REDEEMS, DoorLayout.OFFSET_MAX_REDEEMS, DoorLayout.SIZE_MAX_REDEEMS),
            fd.maxRedeems()
        );
        assertEq(
            field(d, DoorLayout.SLOT_ORACLE, DoorLayout.OFFSET_ORACLE, DoorLayout.SIZE_ORACLE),
            uint160(address(fd.oracle()))
        );
        assertEq(
            field(
                d,
                DoorLayout.SLOT_MAX_DELIVERY_SLIPPAGE_BPS,
                DoorLayout.OFFSET_MAX_DELIVERY_SLIPPAGE_BPS,
                DoorLayout.SIZE_MAX_DELIVERY_SLIPPAGE_BPS
            ),
            fd.maxDeliverySlippageBps()
        );
        assertEq(field(d, DoorLayout.SLOT_REDEEM_REQUEST_FEE, 0, 32), fd.redeemRequestFee());
        // the pool-depth floors (Task 32), a uint128[2] in one slot: TAO/WETH's in the low half, WETH/USDC's above it
        assertEq(DoorLayout.SIZE_MIN_POOL_LIQUIDITY, 32);
        assertEq(field(d, DoorLayout.SLOT_MIN_POOL_LIQUIDITY, DoorLayout.OFFSET_MIN_POOL_LIQUIDITY, 16), 7e20);
        assertEq(field(d, DoorLayout.SLOT_MIN_POOL_LIQUIDITY, DoorLayout.OFFSET_MIN_POOL_LIQUIDITY + 16, 16), 3e17);
        assertEq(fd.minPoolLiquidity(0), 7e20);
        assertEq(fd.minPoolLiquidity(1), 3e17);
    }
}
