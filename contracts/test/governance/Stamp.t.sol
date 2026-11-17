// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeDoorLens} from "../../src/lens/CascadeDoorLens.sol";
import {CascadeVaultLens} from "../../src/lens/CascadeVaultLens.sol";
import {DoorLayout} from "../../src/lens/generated/DoorLayout.sol";
import {VaultLayout} from "../../src/lens/generated/VaultLayout.sol";
import {Actor} from "../../src/CascadeTypes.sol";
import {BadStamp, ExitsNotOpen, StampOutOfWindow} from "../../src/CascadeErrors.sol";
import {StampedBySig} from "../../src/CascadeEvents.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {FrontDoorTestBase} from "../FrontDoorTestBase.sol";
import {MockTAO} from "../mocks/MockTAO.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {StubBridge} from "../mocks/StubBridge.sol";
import {mirror} from "../mocks/Mirror.sol";
import {defaultFrontDoorParams, defaultVaultParams} from "../utils/DefaultParams.sol";
import {SchedulerHarness} from "./SchedulerHarness.sol";
import {Schedule} from "./Schedule.sol";
import {
    Stamps,
    STAMP_VECTOR_AS_OF,
    STAMP_VECTOR_DOOR_ADDRESS,
    STAMP_VECTOR_DOOR_CHAIN_ID,
    STAMP_VECTOR_DOOR_DIGEST,
    STAMP_VECTOR_DOOR_DOMAIN_SEPARATOR,
    STAMP_VECTOR_DOOR_SIG,
    STAMP_VECTOR_OWNER,
    STAMP_VECTOR_OWNER_KEY,
    STAMP_VECTOR_STRUCT_HASH,
    STAMP_VECTOR_TYPEHASH,
    STAMP_VECTOR_VAULT_ADDRESS,
    STAMP_VECTOR_VAULT_CHAIN_ID,
    STAMP_VECTOR_VAULT_DIGEST,
    STAMP_VECTOR_VAULT_DOMAIN_SEPARATOR,
    STAMP_VECTOR_VAULT_SIG
} from "./StampVector.sol";

// secp256k1's group order, half of it (rounded down: the order is odd), and its generator's x coordinate.
uint256 constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
uint256 constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
uint256 constant GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798;

/// An owner account whose code approves any signature through ERC-1271, as a contract wallet's, or an
/// EIP-7702 delegate's on Base, might: stampBySig never asks it (spec §3.6: ECDSA only).
contract ApproveEverything {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0x1626ba7e;
    }
}

/// The owner-signed stamp (spec §3.6, §3.10.7; I-29) on SchedulerHarness: `stampBySig(asOf, sig)`, relayed by
/// any account, moves the owner's clock to max(lastOwnerClose, asOf) and does nothing else, so it kills
/// every owner-clock item (every kind) scheduled at or before asOf. The signature is the owner's EIP-712
/// one over OwnerStamp(asOf), exactly 65 bytes, v 27 or 28, s in the lower half, recovered by ecrecover
/// (never ERC-1271); else BadStamp. asOf <= now <= asOf + 1 day, else StampOutOfWindow. No nonce: a
/// replay changes nothing and emits again.
contract StampTest is Test {
    using stdStorage for StdStorage;

    SchedulerHarness h;
    address owner;
    uint256 ownerKey;
    address guardian;
    uint256 guardianKey;
    address bridge = makeAddr("bridge");
    address bridge2 = makeAddr("bridge2");
    address bridge3 = makeAddr("bridge3");
    address stranger = makeAddr("stranger");
    address relayer2 = makeAddr("relayer2");
    address guardian2 = makeAddr("guardian2");
    address guardian3 = makeAddr("guardian3");

    function setUp() public {
        (owner, ownerKey) = makeAddrAndKey("owner");
        (guardian, guardianKey) = makeAddrAndKey("guardian");
        Schedule.warpTo(1_000_000);
        h = new SchedulerHarness(owner, guardian, bridge);
    }

    // ---- helpers ----

    function now_() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
    }

    function knob(uint256 v) internal view returns (bytes memory) {
        return abi.encodeCall(h.setKnob, (v));
    }

    function swap(address g) internal view returns (bytes memory) {
        return abi.encodeCall(h.setGuardian, (g));
    }

    function activation(address b) internal view returns (bytes memory) {
        return abi.encodeCall(h.activateBridge, (b));
    }

    function sched(bytes memory data) internal returns (bytes32 id) {
        vm.prank(owner);
        id = h.schedule(data);
    }

    function exec(bytes memory data) internal {
        vm.prank(owner);
        h.execute(data);
    }

    /// The owner's stamp as of `asOf` for the harness on this chain.
    function stamp(uint64 asOf) internal view returns (bytes memory) {
        return Stamps.signed(ownerKey, address(h), asOf);
    }

    function relay(address by, uint64 asOf, bytes memory sig) internal {
        vm.prank(by);
        h.stampBySig(asOf, sig);
    }

    /// A stranger's relay of (asOf, sig) reverts `err` and leaves the owner's clock as it was.
    function assertRefused(uint64 asOf, bytes memory sig, bytes4 err) internal {
        uint64 clock = h.exposed_lastOwnerClose();
        vm.prank(stranger);
        vm.expectRevert(err);
        h.stampBySig(asOf, sig);
        assertEq(h.exposed_lastOwnerClose(), clock, "the clock is unchanged");
    }

    function assertDead(bytes memory data) internal {
        vm.prank(owner);
        vm.expectRevert(ExitsNotOpen.selector);
        h.execute(data);
    }

    // ---- the stamp ----

    /// The constants as the spec sets them, and the harness's domain is EIP-712's for its address.
    function test_stampConstants() public view {
        assertEq(h.exposed_STAMP_TYPEHASH(), keccak256("OwnerStamp(uint64 asOf)"));
        assertEq(h.exposed_STAMP_MAX_TTL(), 1 days);
        assertEq(h.exposed_DOMAIN_SEPARATOR(), Stamps.domainSeparator(block.chainid, address(h)));
    }

    /// A stamp signed by the owner and relayed by a stranger moves the owner's clock to asOf and emits
    /// StampedBySig(asOf, stranger): every item scheduled at asOf dies, whatever its kind (Ordinary,
    /// GuardianSwap, Reopen: all read the owner's clock), and every item scheduled a second later lives.
    function test_validStampRelayedByAStranger() public {
        // two known bridges, disabled (neither is the primary: no hold, no stamp), for two Reopens
        Schedule.run(h, owner, activation(bridge2));
        Schedule.run(h, owner, activation(bridge3));
        vm.startPrank(owner);
        h.disableBridge(bridge2);
        h.disableBridge(bridge3);
        vm.stopPrank();
        Schedule.warpTo(vm.getBlockTimestamp() + 1);

        uint64 asOf = now_();
        bytes[3] memory atAsOf = [knob(5), swap(guardian2), activation(bridge2)];
        for (uint256 i; i < 3; ++i) {
            sched(atAsOf[i]);
        }
        Schedule.warpTo(asOf + 1);
        bytes[3] memory later = [knob(6), swap(guardian3), activation(bridge3)];
        for (uint256 i; i < 3; ++i) {
            sched(later[i]);
        }

        bytes memory sig = stamp(asOf);
        vm.expectEmit(address(h));
        emit StampedBySig(asOf, stranger);
        relay(stranger, asOf, sig);
        assertEq(h.exposed_lastOwnerClose(), asOf);
        assertEq(h.exposed_lastGuardianClose(), 0);

        Schedule.warpTo(uint256(asOf) + 8 days + 1);
        for (uint256 i; i < 3; ++i) {
            assertDead(atAsOf[i]);
        }
        for (uint256 i; i < 3; ++i) {
            exec(later[i]);
        }
        assertEq(h.knob(), 6);
        assertEq(h.exposed_guardian(), guardian3);
        assertTrue(h.exposed_bridgeEnabled(bridge3));
        assertFalse(h.exposed_bridgeEnabled(bridge2));
    }

    /// A replay, by anyone, emits StampedBySig again and writes nothing; an item scheduled after asOf
    /// survives every replay (spec §3.6: why there is no nonce).
    function test_replayChangesNothingButEmits() public {
        uint64 asOf = now_();
        bytes memory sig = stamp(asOf);
        relay(stranger, asOf, sig);
        Schedule.warpTo(asOf + 1);
        bytes memory data = knob(5);
        sched(data);

        address[3] memory relayers = [stranger, relayer2, owner];
        for (uint256 i; i < 3; ++i) {
            Schedule.warpTo(vm.getBlockTimestamp() + 1 hours);
            vm.record();
            vm.recordLogs();
            relay(relayers[i], asOf, sig);
            (, bytes32[] memory writes) = vm.accesses(address(h));
            assertEq(writes.length, 0, "a replay writes nothing");
            Vm.Log[] memory logs = vm.getRecordedLogs();
            assertEq(logs.length, 1, "one log");
            assertEq(logs[0].topics[0], StampedBySig.selector);
            assertEq(logs[0].topics[1], bytes32(uint256(uint160(relayers[i]))), "the relayer");
            assertEq(abi.decode(logs[0].data, (uint64)), asOf);
            assertEq(h.exposed_lastOwnerClose(), asOf);
        }
        Schedule.warpTo(uint256(asOf) + 1 + 48 hours);
        exec(data);
        assertEq(h.knob(), 5);
    }

    /// A valid stamp older than the clock emits and changes nothing, whether the clock came from a later
    /// stamp or from an owner instrument; a later one moves it.
    function test_olderAsOfChangesNothing() public {
        uint64 t = now_();
        Schedule.warpTo(t + 2 hours);
        relay(stranger, t + 1 hours, stamp(t + 1 hours));
        assertEq(h.exposed_lastOwnerClose(), t + 1 hours);

        vm.expectEmit(address(h));
        emit StampedBySig(t, stranger);
        relay(stranger, t, stamp(t));
        assertEq(h.exposed_lastOwnerClose(), t + 1 hours);

        // an owner instrument now: a stamp of an earlier time leaves its clock
        vm.prank(owner);
        h.ownerInstrument();
        assertEq(h.exposed_lastOwnerClose(), t + 2 hours);
        relay(stranger, t + 1 hours, stamp(t + 1 hours));
        assertEq(h.exposed_lastOwnerClose(), t + 2 hours);

        Schedule.warpTo(t + 3 hours);
        relay(stranger, t + 3 hours, stamp(t + 3 hours));
        assertEq(h.exposed_lastOwnerClose(), t + 3 hours);
    }

    /// The window: asOf <= now <= asOf + 1 day. A stamp of the future is refused until its time; one
    /// exactly a day old passes, a second more is refused.
    function test_futureAndExpired() public {
        uint64 t = now_();
        bytes memory next = stamp(t + 1);
        assertRefused(t + 1, next, StampOutOfWindow.selector);
        // as of now: the lower bound is inclusive
        relay(stranger, t, stamp(t));
        assertEq(h.exposed_lastOwnerClose(), t);
        Schedule.warpTo(t + 1);
        relay(stranger, t + 1, next);
        assertEq(h.exposed_lastOwnerClose(), t + 1);

        bytes memory sig = stamp(t + 2);
        Schedule.warpTo(uint256(t) + 2 + 1 days);
        relay(stranger, t + 2, sig);
        assertEq(h.exposed_lastOwnerClose(), t + 2);
        Schedule.warpTo(uint256(t) + 2 + 1 days + 1);
        assertRefused(t + 2, sig, StampOutOfWindow.selector);
        // a fresh stamp passes again
        relay(stranger, now_(), stamp(now_()));
        assertEq(h.exposed_lastOwnerClose(), now_());
    }

    /// The window's arithmetic cannot overflow: asOf + 1 day is computed past uint64 (asOf at its maximum).
    /// Far in the future it is refused as of the future, never a panic; at a clock that far it passes, up
    /// to a day later.
    function test_theWindowCannotOverflow() public {
        uint64 maxT = type(uint64).max;
        bytes memory sig = stamp(maxT);
        assertRefused(maxT, sig, StampOutOfWindow.selector);
        Schedule.warpTo(maxT);
        relay(stranger, maxT, sig);
        assertEq(h.exposed_lastOwnerClose(), maxT);
        Schedule.warpTo(uint256(maxT) + 1 days);
        relay(stranger, maxT, sig);
        Schedule.warpTo(uint256(maxT) + 1 days + 1);
        assertRefused(maxT, sig, StampOutOfWindow.selector);
    }

    /// Only the owner's key stamps: the guardian's, a stranger's, and the owner's signature of another
    /// asOf (asOf is signed) are BadStamp.
    function test_wrongSigner() public {
        uint64 t = now_();
        assertRefused(t, Stamps.signed(guardianKey, address(h), t), BadStamp.selector);
        (, uint256 strangerKey) = makeAddrAndKey("a stranger's key");
        assertRefused(t, Stamps.signed(strangerKey, address(h), t), BadStamp.selector);
        assertRefused(t, stamp(t - 1), BadStamp.selector);
        relay(stranger, t, stamp(t));
        assertEq(h.exposed_lastOwnerClose(), t);
    }

    /// Two contracts with one owner: a stamp signed for one is BadStamp on the other (the domain names
    /// the verifying contract).
    function test_anotherContractsStamp() public {
        SchedulerHarness other = new SchedulerHarness(owner, guardian, bridge);
        uint64 t = now_();
        assertRefused(t, Stamps.signed(ownerKey, address(other), t), BadStamp.selector);
        vm.prank(stranger);
        other.stampBySig(t, Stamps.signed(ownerKey, address(other), t));
        assertEq(other.exposed_lastOwnerClose(), t);
    }

    /// The domain names the chain: built on chain 964, a contract refuses a stamp signed for the same
    /// address on chain 8453 and takes the one for 964. The domain is hashed once, in the constructor (spec
    /// §3.6: an immutable, no ERC-5267), so on a later chain id the contract still checks its own.
    function test_otherChainId() public {
        vm.chainId(964);
        SchedulerHarness b = new SchedulerHarness(owner, guardian, bridge);
        uint64 t = now_();
        bytes memory onBase = Stamps.sign(ownerKey, Stamps.digest(8453, address(b), t));
        vm.prank(stranger);
        vm.expectRevert(BadStamp.selector);
        b.stampBySig(t, onBase);
        vm.prank(stranger);
        b.stampBySig(t, Stamps.sign(ownerKey, Stamps.digest(964, address(b), t)));
        assertEq(b.exposed_lastOwnerClose(), t);

        vm.chainId(8453);
        Schedule.warpTo(t + 1);
        vm.prank(stranger);
        vm.expectRevert(BadStamp.selector);
        b.stampBySig(t + 1, Stamps.sign(ownerKey, Stamps.digest(8453, address(b), t + 1)));
        assertEq(b.exposed_DOMAIN_SEPARATOR(), Stamps.domainSeparator(964, address(b)));
    }

    /// The malleable twin of the owner's signature, (r, n - s, the other v), recovers the owner too, but its
    /// s is in the upper half: BadStamp. The original stamps.
    function test_highS() public {
        uint64 t = now_();
        bytes32 d = Stamps.digest(block.chainid, address(h), t);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, d);
        bytes32 twinS = bytes32(N - uint256(s));
        uint8 twinV = v == 27 ? 28 : 27;
        assertEq(ecrecover(d, twinV, r, twinS), owner, "the twin recovers the owner");
        assertGt(uint256(twinS), HALF_N);
        assertRefused(t, abi.encodePacked(r, twinS, twinV), BadStamp.selector);
        relay(stranger, t, abi.encodePacked(r, s, v));
        assertEq(h.exposed_lastOwnerClose(), t);
    }

    /// The bound itself: s equal to half the order passes, half + 1 is refused, though ecrecover returns the
    /// owner for both (they are each other's twins, the order being odd). The owner is the account ecrecover
    /// answers for (r = the generator's x, s = half, v = 27) over the digest of the harness built next.
    function test_highSBoundary() public {
        uint64 t = now_();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        bytes32 d = Stamps.digest(block.chainid, predicted, t);
        bytes32 r = bytes32(GX);
        address signer = ecrecover(d, 27, r, bytes32(HALF_N));
        assertTrue(signer != address(0));
        assertEq(ecrecover(d, 28, r, bytes32(HALF_N + 1)), signer, "the twin recovers the same account");
        SchedulerHarness b = new SchedulerHarness(signer, guardian, bridge);
        assertEq(address(b), predicted);

        vm.prank(stranger);
        vm.expectRevert(BadStamp.selector);
        b.stampBySig(t, abi.encodePacked(r, bytes32(HALF_N + 1), uint8(28)));
        assertEq(b.exposed_lastOwnerClose(), 0);
        vm.prank(stranger);
        b.stampBySig(t, abi.encodePacked(r, bytes32(HALF_N), uint8(27)));
        assertEq(b.exposed_lastOwnerClose(), t);
    }

    /// v must be 27 or 28: 0 and 1 (the form some wallets return), 29 and 255 are BadStamp.
    function test_vOutside27And28() public {
        uint64 t = now_();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, Stamps.digest(block.chainid, address(h), t));
        uint8[5] memory bad = [0, 1, 29, 255, v - 27];
        for (uint256 i; i < bad.length; ++i) {
            assertRefused(t, abi.encodePacked(r, s, bad[i]), BadStamp.selector);
        }
        relay(stranger, t, abi.encodePacked(r, s, v));
        assertEq(h.exposed_lastOwnerClose(), t);
    }

    /// Exactly 65 bytes: EIP-2098's 64-byte compact form of the owner's signature, the owner's signature
    /// with a byte appended (66), and nothing at all are BadStamp.
    function test_64And66ByteSignatures() public {
        uint64 t = now_();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, Stamps.digest(block.chainid, address(h), t));
        bytes32 vs = bytes32(uint256(s) | (uint256(v - 27) << 255));
        assertRefused(t, abi.encodePacked(r, vs), BadStamp.selector);
        assertRefused(t, abi.encodePacked(r, s, v, uint8(0)), BadStamp.selector);
        assertRefused(t, abi.encodePacked(r, s, v, v), BadStamp.selector);
        assertRefused(t, "", BadStamp.selector);
        relay(stranger, t, abi.encodePacked(r, s, v));
        assertEq(h.exposed_lastOwnerClose(), t);
    }

    /// Each shape check stands on its own: with ecrecover answering the owner for every input (the
    /// precompile mocked), v outside {27, 28}, s above half the order, and 64 or 66 bytes are still BadStamp;
    /// a well-shaped signature then passes, which shows the mock answers.
    function test_eachShapeCheckStandsAlone() public {
        uint64 t = now_();
        bytes32 r = bytes32(uint256(1));
        bytes32 s = bytes32(uint256(2));
        vm.mockCall(address(1), bytes(""), abi.encode(owner));
        assertRefused(t, abi.encodePacked(r, s, uint8(0)), BadStamp.selector);
        assertRefused(t, abi.encodePacked(r, s, uint8(1)), BadStamp.selector);
        assertRefused(t, abi.encodePacked(r, s, uint8(29)), BadStamp.selector);
        assertRefused(t, abi.encodePacked(r, bytes32(HALF_N + 1), uint8(27)), BadStamp.selector);
        assertRefused(t, abi.encodePacked(r, s), BadStamp.selector);
        assertRefused(t, abi.encodePacked(r, s, uint8(27), uint8(27)), BadStamp.selector);
        relay(stranger, t, abi.encodePacked(r, s, uint8(27)));
        assertEq(h.exposed_lastOwnerClose(), t);
    }

    /// Defence in depth: a signature ecrecover cannot recover (it answers 0) is refused even with the owner
    /// written to the zero address, which no call can do (renounceOwnership is disabled, and
    /// acceptOwnership is called by the pending owner).
    function test_anUnrecoverableSignatureNeverStamps() public {
        uint256 slot = stdstore.target(address(h)).sig(h.owner.selector).find();
        vm.store(address(h), bytes32(slot), bytes32(0));
        assertEq(h.owner(), address(0));
        uint64 t = now_();
        assertEq(ecrecover(bytes32(0), 27, bytes32(0), bytes32(uint256(1))), address(0));
        assertRefused(t, abi.encodePacked(bytes32(0), bytes32(uint256(1)), uint8(27)), BadStamp.selector);
    }

    /// An owner that is a contract cannot stamp: no key recovers to it, and ERC-1271 is never asked, even
    /// by a contract that approves everything; the old owner's key no longer stamps either.
    function test_contractOwnerCannotStamp() public {
        ApproveEverything wallet = new ApproveEverything();
        Schedule.run(h, owner, abi.encodeCall(h.transferOwnership, (address(wallet))));
        vm.prank(address(wallet));
        h.acceptOwnership();
        assertEq(h.owner(), address(wallet));
        uint64 t = now_();
        assertRefused(t, stamp(t), BadStamp.selector);
        assertRefused(t, abi.encodePacked(bytes32(GX), bytes32(uint256(1)), uint8(27)), BadStamp.selector);
        vm.prank(address(wallet));
        vm.expectRevert(BadStamp.selector);
        h.stampBySig(t, stamp(t));
    }

    /// An owner account with code that would approve anything (an EIP-7702 delegate on Base): its code is
    /// never asked, so another key's signature is BadStamp; its own key's ECDSA signature stamps.
    function test_delegatedOwnerCodeIsNeverAsked() public {
        vm.etch(owner, address(new ApproveEverything()).code);
        uint64 t = now_();
        (, uint256 otherKey) = makeAddrAndKey("not the owner");
        assertRefused(t, Stamps.signed(otherKey, address(h), t), BadStamp.selector);
        relay(stranger, t, stamp(t));
        assertEq(h.exposed_lastOwnerClose(), t);
    }

    /// I-29 on the harness: a stamp writes one storage slot, the clocks', and of it only lastOwnerClose's
    /// bytes; it records and clears no hold, and emits exactly StampedBySig. From a state with something in
    /// every field it could reach: the guardian's hold on the primary, both clocks set, a pause, a pending
    /// item, a knob.
    function test_stampTouchesOnlyTheOwnerClock() public {
        Schedule.run(h, owner, knob(7));
        vm.prank(owner);
        h.ownerInstrument();
        Schedule.warpTo(vm.getBlockTimestamp() + 1);
        bytes memory data = swap(guardian2);
        sched(data);
        vm.prank(guardian);
        h.disableBridge(bridge);
        vm.prank(guardian);
        h.pause();
        Schedule.warpTo(vm.getBlockTimestamp() + 1 hours);
        uint64 asOf = now_();
        uint64 guardianClock = h.exposed_lastGuardianClose();
        assertGt(guardianClock, 0);
        assertGt(asOf, h.exposed_lastOwnerClose());

        bytes memory sig = stamp(asOf);
        vm.record();
        vm.recordLogs();
        relay(stranger, asOf, sig);
        (, bytes32[] memory writes) = vm.accesses(address(h));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], StampedBySig.selector);
        assertEq(writes.length, 1, "one slot written");
        // the slot holds lastOwnerClose in its low 8 bytes, beside the guardian's clock and the hold
        uint256 word = uint256(vm.load(address(h), writes[0]));
        assertEq(word & type(uint64).max, asOf, "lastOwnerClose, at offset 0");
        assertEq((word >> 64) & type(uint64).max, guardianClock, "lastGuardianClose, untouched");
        assertEq((word >> 128) & 0xff, uint8(Actor.Guardian), "the guardian's hold, untouched");
        assertEq(word >> 136, 0);

        assertEq(h.exposed_lastOwnerClose(), asOf);
        assertEq(h.exposed_lastGuardianClose(), guardianClock);
        assertEq(uint8(h.exposed_primaryDisabledBy()), uint8(Actor.Guardian));
        assertTrue(h.exposed_guardianHold());
        assertFalse(h.exposed_ownerHold());
        assertTrue(h.paused());
        assertEq(h.knob(), 7);
        assertEq(h.exposed_guardian(), guardian);
        assertEq(h.owner(), owner);
        assertGt(h.item(keccak256(data)).readyAt, 0, "the swap is still pending (dead now)");
    }
}

/// The stamp on the real targets: a stamp signed for the vault is refused by the front door, and the reverse;
/// the old owner's key no longer stamps after a transfer; I-29 on the vault, read through its lens; the vault
/// lens serves the stamp's constants and recomputes the domain.
contract VaultStampTest is VaultTestBase {
    address stranger = makeAddr("stranger");
    CascadeFrontDoor fd;
    CascadeDoorLens doorLens;

    function setUp() public override {
        super.setUp();
        MockTAO tao = new MockTAO(18);
        fd = new CascadeFrontDoor(
            defaultFrontDoorParams(
                tao, new StubBridge(tao), BITTENSOR, address(vault), new MockUSDC(), owner, guardian, keeper
            )
        );
        doorLens = new CascadeDoorLens(address(fd));
    }

    function now_() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
    }

    /// One owner, one chain, two contracts: a stamp signed for the front door is BadStamp on the vault, and
    /// one signed for the vault is BadStamp on the front door; each stamps its own.
    function test_otherContractsDomain() public {
        uint64 t = now_();
        bytes memory forVault = Stamps.signed(ownerKey, address(vault), t);
        bytes memory forDoor = Stamps.signed(ownerKey, address(fd), t);

        vm.prank(stranger);
        vm.expectRevert(BadStamp.selector);
        vault.stampBySig(t, forDoor);
        vm.prank(stranger);
        vm.expectRevert(BadStamp.selector);
        fd.stampBySig(t, forVault);
        assertEq(vaultLens.lastOwnerClose(), 0);
        assertEq(doorLens.lastOwnerClose(), 0);

        vm.prank(stranger);
        vault.stampBySig(t, forVault);
        assertEq(vaultLens.lastOwnerClose(), t);
        assertEq(doorLens.lastOwnerClose(), 0);
        vm.prank(stranger);
        fd.stampBySig(t, forDoor);
        assertEq(doorLens.lastOwnerClose(), t);
    }

    /// After an ownership transfer the old owner's key stamps nothing, a stamp it signed beforehand
    /// included; while the transfer is pending the pending owner's key stamps nothing, the owner's does; the
    /// new owner's does. The owner's stamp while the transfer is pending is as of the second before its
    /// execute: one as of the execute or later would refuse the pending owner (R1-A L-1, PendingOwner.t.sol).
    function test_theOldOwnersStampAfterATransfer() public {
        (address newOwner, uint256 newKey) = makeAddrAndKey("new owner");
        Schedule.run(vault, owner, abi.encodeCall(vault.transferOwnership, (newOwner)));
        uint64 t = now_();
        // pre-signed by the old owner for an hour from now, as a daily bot's stamps are
        bytes memory preSigned = Stamps.signed(ownerKey, address(vault), t + 1 hours);
        vm.prank(stranger);
        vm.expectRevert(BadStamp.selector);
        vault.stampBySig(t - 1, Stamps.signed(newKey, address(vault), t - 1));
        vm.prank(stranger);
        vault.stampBySig(t - 1, Stamps.signed(ownerKey, address(vault), t - 1));
        assertEq(vaultLens.lastOwnerClose(), t - 1);

        vm.prank(newOwner);
        vault.acceptOwnership();
        Schedule.warpTo(t + 1 hours);
        vm.prank(stranger);
        vm.expectRevert(BadStamp.selector);
        vault.stampBySig(t + 1 hours, preSigned);
        vm.prank(stranger);
        vm.expectRevert(BadStamp.selector);
        vault.stampBySig(t + 1 hours, Stamps.signed(ownerKey, address(vault), t + 1 hours));
        assertEq(vaultLens.lastOwnerClose(), t - 1);
        vm.prank(stranger);
        vault.stampBySig(t + 1 hours, Stamps.signed(newKey, address(vault), t + 1 hours));
        assertEq(vaultLens.lastOwnerClose(), t + 1 hours);
    }

    /// I-29 on the vault: in the guardian's hold, then in the owner's, a stamp writes only the clocks' slot
    /// and only lastOwnerClose in it; every hold, the other clock and exitsOpen read the same through the
    /// lens; one log, StampedBySig.
    function test_stampTouchesOnlyTheOwnerClockOnTheVault() public {
        vm.prank(guardian);
        vault.disableBridge(address(bridge));
        Schedule.warpTo(vm.getBlockTimestamp() + 1 hours);
        assertStampTouchesOnlyTheOwnerClock(Actor.Guardian);

        // the owner's hold: the guardian's disabled primary reopened (scheduled a second after the stamp, whose
        // clock would refuse it in its own second), then disabled by the owner
        Schedule.warpTo(vm.getBlockTimestamp() + 1);
        Schedule.run(vault, owner, abi.encodeCall(vault.activateBridge, (address(bridge))));
        vm.prank(owner);
        vault.disableBridge(address(bridge));
        Schedule.warpTo(vm.getBlockTimestamp() + 1 hours);
        assertStampTouchesOnlyTheOwnerClock(Actor.Owner);
    }

    function assertStampTouchesOnlyTheOwnerClock(Actor held) internal {
        uint64 asOf = now_();
        uint64 guardianClock = vaultLens.lastGuardianClose();
        bool ownerHold = vaultLens.ownerHold();
        bool guardianHold = vaultLens.guardianHold();
        bytes32 before = vm.load(address(vault), bytes32(VaultLayout.SLOT_LAST_OWNER_CLOSE));
        bytes memory sig = Stamps.signed(ownerKey, address(vault), asOf);
        vm.record();
        vm.recordLogs();
        vm.prank(stranger);
        vault.stampBySig(asOf, sig);
        (, bytes32[] memory writes) = vm.accesses(address(vault));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], StampedBySig.selector);
        assertEq(writes.length, 1, "one slot written");
        assertEq(writes[0], bytes32(VaultLayout.SLOT_LAST_OWNER_CLOSE), "the clocks' slot");
        uint256 mask =
            ((uint256(1) << (VaultLayout.SIZE_LAST_OWNER_CLOSE * 8)) - 1) << (VaultLayout.OFFSET_LAST_OWNER_CLOSE * 8);
        bytes32 afterWord = vm.load(address(vault), bytes32(VaultLayout.SLOT_LAST_OWNER_CLOSE));
        assertEq(uint256(afterWord) & ~mask, uint256(before) & ~mask, "only lastOwnerClose's bytes change");
        assertEq(vaultLens.lastOwnerClose(), asOf);
        assertEq(vaultLens.lastGuardianClose(), guardianClock);
        assertEq(uint8(vaultLens.primaryDisabledBy()), uint8(held));
        assertEq(vaultLens.ownerHold(), ownerHold);
        assertEq(vaultLens.guardianHold(), guardianHold);
        assertFalse(vaultLens.exitsOpen());
    }

    /// The vault lens serves the stamp's constants and recomputes the vault's domain from this chain's id
    /// and its target, equal to the vault's own (VaultInternals' exposure is compared in LensParity).
    function test_theVaultLensServesTheStampConstants() public view {
        assertEq(vaultLens.STAMP_TYPEHASH(), keccak256("OwnerStamp(uint64 asOf)"));
        assertEq(vaultLens.STAMP_MAX_TTL(), 1 days);
        assertEq(vaultLens.DOMAIN_SEPARATOR(), Stamps.domainSeparator(block.chainid, address(vault)));
        assertTrue(vaultLens.DOMAIN_SEPARATOR() != doorLens.DOMAIN_SEPARATOR());
    }
}

/// I-29 on the front door, read through its lens.
contract DoorStampTest is FrontDoorTestBase {
    address stranger = makeAddr("stranger");

    /// In the guardian's hold on the primary and a pause, a stamp writes only the clocks' slot and only
    /// lastOwnerClose in it; the hold, the other clock and the pause read the same; one log.
    function test_stampTouchesOnlyTheOwnerClockOnTheDoor() public {
        Schedule.warpTo(vm.getBlockTimestamp() + 1 days);
        vm.prank(guardian);
        fd.disableBridge(address(bridge));
        vm.prank(guardian);
        fd.pause();
        Schedule.warpTo(vm.getBlockTimestamp() + 1 hours);
        uint64 asOf = uint64(vm.getBlockTimestamp());
        uint64 guardianClock = doorLens.lastGuardianClose();
        bytes32 before = vm.load(address(fd), bytes32(DoorLayout.SLOT_LAST_OWNER_CLOSE));
        bytes memory sig = Stamps.signed(ownerKey, address(fd), asOf);

        vm.record();
        vm.recordLogs();
        vm.prank(stranger);
        fd.stampBySig(asOf, sig);
        (, bytes32[] memory writes) = vm.accesses(address(fd));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], StampedBySig.selector);
        assertEq(writes.length, 1, "one slot written");
        assertEq(writes[0], bytes32(DoorLayout.SLOT_LAST_OWNER_CLOSE), "the clocks' slot");
        uint256 mask =
            ((uint256(1) << (DoorLayout.SIZE_LAST_OWNER_CLOSE * 8)) - 1) << (DoorLayout.OFFSET_LAST_OWNER_CLOSE * 8);
        bytes32 afterWord = vm.load(address(fd), bytes32(DoorLayout.SLOT_LAST_OWNER_CLOSE));
        assertEq(uint256(afterWord) & ~mask, uint256(before) & ~mask, "only lastOwnerClose's bytes change");
        assertEq(doorLens.lastOwnerClose(), asOf);
        assertEq(doorLens.lastGuardianClose(), guardianClock);
        assertEq(uint8(doorLens.primaryDisabledBy()), uint8(Actor.Guardian));
        assertTrue(doorLens.guardianHold());
        assertFalse(doorLens.ownerHold());
        assertTrue(fd.paused());
    }

    function test_theDoorLensServesTheStampConstants() public view {
        assertEq(doorLens.STAMP_TYPEHASH(), keccak256("OwnerStamp(uint64 asOf)"));
        assertEq(doorLens.STAMP_MAX_TTL(), 1 days);
        assertEq(doorLens.DOMAIN_SEPARATOR(), Stamps.domainSeparator(block.chainid, address(fd)));
    }
}

/// Rulings B5 and C4: the pinned vector (StampVector.sol), computed outside the contracts with viem and cast.
/// Each target is deployed at the vector's address on the vector's chain; each lens serves the vector's
/// domain separator and typehash, and the target takes the vector's signature, so its own digest is the
/// vector's. The tests' signing helper (Stamps) is pinned to the same vector.
contract StampVectorTest is VaultTestBase {
    address stranger = makeAddr("stranger");

    function test_domainAndTypehashMatchLocalComputation() public {
        assertEq(owner, STAMP_VECTOR_OWNER, "the fixtures' owner is the vector's");
        assertEq(ownerKey, STAMP_VECTOR_OWNER_KEY, "the fixtures' owner key is the vector's");

        // the vault on Bittensor
        vm.chainId(STAMP_VECTOR_VAULT_CHAIN_ID);
        CascadeVault.Params memory p = defaultVaultParams(
            mirror(STAMP_VECTOR_VAULT_ADDRESS), HK1, bridge, owner, guardian, keeper, BASE, frontDoor
        );
        deployCodeTo("CascadeVault.sol:CascadeVault", abi.encode(p), STAMP_VECTOR_VAULT_ADDRESS);
        CascadeVault v = CascadeVault(payable(STAMP_VECTOR_VAULT_ADDRESS));
        CascadeVaultLens vl = new CascadeVaultLens(STAMP_VECTOR_VAULT_ADDRESS);
        assertEq(vl.STAMP_TYPEHASH(), STAMP_VECTOR_TYPEHASH);
        assertEq(vl.DOMAIN_SEPARATOR(), STAMP_VECTOR_VAULT_DOMAIN_SEPARATOR);
        Schedule.warpTo(STAMP_VECTOR_AS_OF);
        vm.prank(stranger);
        vm.expectRevert(BadStamp.selector);
        v.stampBySig(STAMP_VECTOR_AS_OF, STAMP_VECTOR_DOOR_SIG);
        vm.expectEmit(STAMP_VECTOR_VAULT_ADDRESS);
        emit StampedBySig(STAMP_VECTOR_AS_OF, stranger);
        vm.prank(stranger);
        v.stampBySig(STAMP_VECTOR_AS_OF, STAMP_VECTOR_VAULT_SIG);
        assertEq(vl.lastOwnerClose(), STAMP_VECTOR_AS_OF);

        // the front door on Base
        vm.chainId(STAMP_VECTOR_DOOR_CHAIN_ID);
        MockTAO tao = new MockTAO(18);
        CascadeFrontDoor.Params memory dp = defaultFrontDoorParams(
            tao, new StubBridge(tao), BITTENSOR, STAMP_VECTOR_VAULT_ADDRESS, new MockUSDC(), owner, guardian, keeper
        );
        deployCodeTo("CascadeFrontDoor.sol:CascadeFrontDoor", abi.encode(dp), STAMP_VECTOR_DOOR_ADDRESS);
        CascadeFrontDoor d = CascadeFrontDoor(payable(STAMP_VECTOR_DOOR_ADDRESS));
        CascadeDoorLens dl = new CascadeDoorLens(STAMP_VECTOR_DOOR_ADDRESS);
        assertEq(dl.STAMP_TYPEHASH(), STAMP_VECTOR_TYPEHASH);
        assertEq(dl.DOMAIN_SEPARATOR(), STAMP_VECTOR_DOOR_DOMAIN_SEPARATOR);
        vm.prank(stranger);
        vm.expectRevert(BadStamp.selector);
        d.stampBySig(STAMP_VECTOR_AS_OF, STAMP_VECTOR_VAULT_SIG);
        vm.expectEmit(STAMP_VECTOR_DOOR_ADDRESS);
        emit StampedBySig(STAMP_VECTOR_AS_OF, stranger);
        vm.prank(stranger);
        d.stampBySig(STAMP_VECTOR_AS_OF, STAMP_VECTOR_DOOR_SIG);
        assertEq(dl.lastOwnerClose(), STAMP_VECTOR_AS_OF);

        // the vector's own consistency, and the tests' signing helper pinned to it
        assertEq(keccak256(abi.encode(STAMP_VECTOR_TYPEHASH, STAMP_VECTOR_AS_OF)), STAMP_VECTOR_STRUCT_HASH);
        assertEq(
            keccak256(abi.encodePacked("\x19\x01", STAMP_VECTOR_VAULT_DOMAIN_SEPARATOR, STAMP_VECTOR_STRUCT_HASH)),
            STAMP_VECTOR_VAULT_DIGEST
        );
        assertEq(
            keccak256(abi.encodePacked("\x19\x01", STAMP_VECTOR_DOOR_DOMAIN_SEPARATOR, STAMP_VECTOR_STRUCT_HASH)),
            STAMP_VECTOR_DOOR_DIGEST
        );
        assertEq(
            Stamps.digest(STAMP_VECTOR_VAULT_CHAIN_ID, STAMP_VECTOR_VAULT_ADDRESS, STAMP_VECTOR_AS_OF),
            STAMP_VECTOR_VAULT_DIGEST
        );
        assertEq(
            Stamps.digest(STAMP_VECTOR_DOOR_CHAIN_ID, STAMP_VECTOR_DOOR_ADDRESS, STAMP_VECTOR_AS_OF),
            STAMP_VECTOR_DOOR_DIGEST
        );
        assertEq(Stamps.sign(STAMP_VECTOR_OWNER_KEY, STAMP_VECTOR_VAULT_DIGEST), STAMP_VECTOR_VAULT_SIG);
        assertEq(Stamps.sign(STAMP_VECTOR_OWNER_KEY, STAMP_VECTOR_DOOR_DIGEST), STAMP_VECTOR_DOOR_SIG);
    }
}
