// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CascadeBase} from "../../src/CascadeBase.sol";
import {CascadeBaseLens} from "../../src/lens/CascadeBaseLens.sol";
import {ISTAKING_ADDRESS} from "../../src/interfaces/IStaking.sol";
import {Item} from "../../src/CascadeTypes.sol";
import {CampaignFixture} from "../utils/CampaignFixture.sol";
import {MockBridge} from "../mocks/MockBridge.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {ProbeBridge} from "../mocks/ProbeBridge.sol";
import {Schedule} from "./Schedule.sol";
import {
    Stamps,
    STAMP_VECTOR_AS_OF,
    STAMP_VECTOR_DOOR_ADDRESS,
    STAMP_VECTOR_DOOR_CHAIN_ID,
    STAMP_VECTOR_DOOR_DIGEST,
    STAMP_VECTOR_DOOR_SIG,
    STAMP_VECTOR_OWNER,
    STAMP_VECTOR_OWNER_KEY,
    STAMP_VECTOR_VAULT_ADDRESS,
    STAMP_VECTOR_VAULT_CHAIN_ID,
    STAMP_VECTOR_VAULT_DIGEST,
    STAMP_VECTOR_VAULT_SIG
} from "./StampVector.sol";

/// The governance world (Task 39, spec §3.6): CampaignFixture's two chains in one EVM (the vault on BITTENSOR, the
/// launch front door on BASE over MockBridge, both lenses, the handler the keeper of both), with the scheduler on both
/// sides, and what a governance campaign adds to it after the handler lands (`deployGovernance`):
///   - the keys: the owner and the guardian from makeAddrAndKey (the owner's key is StampVector's, pinned here to the
///     vector, so every stamp the campaign signs is the one an outside signer would), a second guardian (a swap's
///     target), a second owner (a transfer's) and a stranger who relays stamps; each with its key;
///   - a second rail, `bridge2`: a MockBridge connected to both chains with a smaller cap (BRIDGE2_CAP, below both
///     contracts' launch limits, so making it the primary needs a tightening first: AboveBridgeCap);
///   - `probe`, a ProbeBridge, a bridge that re-enters its caller's scheduler (I-25's re-entrant path);
///   - two door addresses never active: `door3` on BASE (a second launch-chain door: removing the launch door while it
///     is active closes nothing) and `door2` on SECOND_CHAIN;
///   - a second listed hotkey, HK2 (setStakeHotkey's and moveStake's arguments).
/// The helpers act as the owner (`sched`, `execAfter`) and relay the owner's signed stamps as the stranger (`stampAt`),
/// and `sweeper(bool)` drains the founder's accounts (the CO column, Task 39b), for the campaign's pins and the scenario
/// tests built on it (Tasks 39b, 40 and 41). A campaign starts the clock at
/// `START`, the vector's as-of time (2027-01-01), so every stamp's asOf is a realistic one.
abstract contract GovernanceFixture is CampaignFixture {
    uint64 internal constant SECOND_CHAIN = 10;
    bytes32 internal constant HK2 = bytes32(uint256(2));
    /// The clock and block a campaign starts at (`startGovernance`).
    uint64 internal constant START = STAMP_VECTOR_AS_OF;
    uint256 internal constant START_BLOCK = 5_000_000;
    /// The founder's pre-signed stamps are spaced 12 hours apart (Task 48's STAMP_SPACING_HOURS, R1-A's <= 12 h).
    uint64 internal constant STAMP_SPACING = 12 hours;
    /// bridge2's cap: below both contracts' launch limits (the vault's maxMessageValue, 4,000 TAO; the front door's
    /// maxBatchValue, 4,000 TAO), at least the vault's least maxEntryValue (10 TAO).
    uint256 internal constant BRIDGE2_CAP = 1_000e18;

    uint256 internal ownerKey = _keyOf("owner");
    uint256 internal guardianKey = _keyOf("guardian");
    address internal guardian2;
    uint256 internal guardian2Key;
    address internal owner2;
    uint256 internal owner2Key;
    address internal stranger;
    uint256 internal strangerKey;

    /// What deployGovernance adds.
    struct Governance {
        MockBridge bridge2;
        ProbeBridge probe;
        address door2;
        address door3;
    }

    Campaign internal _world;
    mapping(address target => CascadeBaseLens) internal _lensOf;

    /// The clock at START and the block at START_BLOCK, before anything is deployed.
    function startGovernance() internal {
        vm.warp(START);
        vm.roll(START_BLOCK);
    }

    /// The governance parts on the deployed campaign `c` (see the contract's notes), after the handler landed: each
    /// creation here follows the plan's last slot, so none moves an address the plan named. Pins the owner's key and
    /// the signer to StampVector's vector (the digest and the signature, outside the contracts' formula), and both
    /// targets' domains to EIP-712's for this chain.
    function deployGovernance(Campaign memory c) internal returns (Governance memory g) {
        _world = c;
        _lensOf[address(c.vault)] = c.vaultLens;
        _lensOf[address(c.fd)] = c.doorLens;
        (guardian2, guardian2Key) = makeAddrAndKey("guardian2");
        (owner2, owner2Key) = makeAddrAndKey("owner2");
        (stranger, strangerKey) = makeAddrAndKey("stranger");

        // the fixed point: the owner's key is the vector's, and Stamps signs the vector's digests to its signatures
        assertEq(owner, STAMP_VECTOR_OWNER, "the owner is the vector's");
        assertEq(ownerKey, STAMP_VECTOR_OWNER_KEY, "the owner's key is the vector's");
        assertEq(
            Stamps.digest(STAMP_VECTOR_VAULT_CHAIN_ID, STAMP_VECTOR_VAULT_ADDRESS, STAMP_VECTOR_AS_OF),
            STAMP_VECTOR_VAULT_DIGEST,
            "the vault's vector digest"
        );
        assertEq(
            Stamps.digest(STAMP_VECTOR_DOOR_CHAIN_ID, STAMP_VECTOR_DOOR_ADDRESS, STAMP_VECTOR_AS_OF),
            STAMP_VECTOR_DOOR_DIGEST,
            "the front door's vector digest"
        );
        assertEq(Stamps.sign(ownerKey, STAMP_VECTOR_VAULT_DIGEST), STAMP_VECTOR_VAULT_SIG, "the vault's vector sig");
        assertEq(Stamps.sign(ownerKey, STAMP_VECTOR_DOOR_DIGEST), STAMP_VECTOR_DOOR_SIG, "the door's vector sig");
        assertEq(
            c.vaultLens.DOMAIN_SEPARATOR(),
            Stamps.domainSeparator(block.chainid, address(c.vault)),
            "the vault's domain is EIP-712's"
        );
        assertEq(
            c.doorLens.DOMAIN_SEPARATOR(),
            Stamps.domainSeparator(block.chainid, address(c.fd)),
            "the front door's domain is EIP-712's"
        );

        g.bridge2 = new MockBridge(c.tao);
        g.bridge2.setFee(FEE);
        g.bridge2.setMaxMessageValue(BRIDGE2_CAP);
        g.bridge2.connect(BITTENSOR, address(c.vault), true);
        g.bridge2.connect(BASE, address(c.fd), false);
        g.probe = new ProbeBridge(address(c.vault), address(c.fd));
        g.probe.setFee(FEE);
        g.door2 = makeAddr("door on chain 10");
        g.door3 = makeAddr("second door on Base");
        MockStaking(ISTAKING_ADDRESS).addHotkey(HK2);
        vm.prank(owner);
        c.vault.addHotkey(HK2);
    }

    // ---- helpers ----

    /// The owner schedules `data` on `target`.
    function sched(CascadeBase target, bytes memory data) internal returns (bytes32 id) {
        vm.prank(owner);
        id = target.schedule(data);
    }

    /// Waits out the item `data` on `target` (its readyAt in time, its readyBlock in blocks, rolling the blocks as
    /// Schedule.warpTo does), then the owner executes it.
    function execAfter(CascadeBase target, bytes memory data) internal {
        Item memory it = _lensOf[address(target)].scheduled(keccak256(data));
        require(it.readyAt != 0, "execAfter: nothing scheduled");
        Schedule.warpTo(Math.max(vm.getBlockTimestamp(), it.readyAt));
        if (vm.getBlockNumber() < it.readyBlock) vm.roll(it.readyBlock);
        vm.prank(owner);
        target.execute(data);
    }

    /// The owner's stamp as of `asOf` for `target` on this chain, relayed by the stranger.
    function stampAt(CascadeBase target, uint64 asOf) internal {
        bytes memory sig = Stamps.signed(ownerKey, address(target), asOf);
        vm.prank(stranger);
        target.stampBySig(asOf, sig);
    }

    /// Whether the sweeper runs (spec §3.6's CO column; Task 39b): a thief holding a copy of the owner's seed (both
    /// keys: one Ledger, decision D2) drains the owner's and the guardian's accounts and front-runs every refill, so the
    /// founder's own transactions never land and it acts only through its signed stamps, relayed by any funded account
    /// (`stampAt`'s stranger); the thief signs as the owner at will.
    bool internal sweeping;

    /// The sweeper on or off; on, the owner's and the guardian's accounts are drained at once. A scripted test calls
    /// `swept()` before each step; a campaign's handler drains them itself before each of its steps
    /// (CopiedKeyHandler.setSweeper).
    function sweeper(bool on) internal virtual {
        sweeping = on;
        swept();
    }

    /// While the sweeper runs: the owner's and the guardian's accounts drained (before a step).
    function swept() internal {
        if (!sweeping) return;
        vm.deal(owner, 0);
        vm.deal(guardian, 0);
    }

    /// `name`'s key, as makeAddrAndKey derives it.
    function _keyOf(string memory name) private returns (uint256 key) {
        (, key) = makeAddrAndKey(name);
    }
}
