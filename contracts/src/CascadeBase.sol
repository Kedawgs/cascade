// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ICascadeBridge} from "./interfaces/ICascadeBridge.sol";
import {Actor, Delay, Item, Kind} from "./CascadeTypes.sol";
import "./CascadeConstants.sol" as Constants;
import {CascadeFormulas} from "./libraries/CascadeFormulas.sol";
import {
    AboveBridgeCap,
    AlreadyActive,
    BadCalldata,
    BadStamp,
    BridgeNotEnabled,
    ExitsNotOpen,
    InvalidParameter,
    LapsedItem,
    NoProposal,
    NotBridge,
    NotCanceller,
    NotGuardian,
    NotReady,
    NotScheduled,
    PrimaryBridgeDisabled,
    PrimaryStillEnabled,
    RenounceDisabled,
    StampOutOfWindow,
    UnknownSelector,
    ZeroAddress
} from "./CascadeErrors.sol";
import {
    BridgeActivated,
    BridgeDisabled,
    Cancelled,
    Executed,
    ExitsClosed,
    ExitsReopened,
    GuardianSet,
    Lapsed,
    PrimaryBridgeSet,
    Scheduled,
    StampedBySig
} from "./CascadeEvents.sol";

/// Shared admin surface: two-step owner, guardian, pause, bridges, and the owner scheduler (spec §3.6):
/// an owner change that loosens a limit, swaps the guardian, transfers ownership or activates a bridge
/// (or, on the vault, a front door) waits its class delay as a scheduled item the guardian (or, for some
/// kinds, only the owner) can cancel, and runs only through `execute`'s self-call. The scheduler is the
/// only delayed path: there is no registry beside it.
abstract contract CascadeBase is Ownable2Step, Pausable, ReentrancyGuard {
    // Internal (spec §8.1): CascadeBaseLens serves each under its name on both targets, read through
    // extsload; no on-chain caller reads them. The targets keep owner, pendingOwner, paused and extsload.
    // The delays and the window are CascadeConstants.sol's.
    uint64 internal constant PARAM_DELAY = Constants.PARAM_DELAY;
    uint64 internal constant REGISTRY_DELAY = Constants.REGISTRY_DELAY;
    uint64 internal constant GUARDIAN_DELAY = Constants.GUARDIAN_DELAY;
    uint64 internal constant EXECUTE_WINDOW = Constants.EXECUTE_WINDOW;
    /// The owner-signed stamp's EIP-712 type and relay window (spec §3.6): CascadeConstants.sol's, served by
    /// the lenses.
    bytes32 internal constant STAMP_TYPEHASH = Constants.STAMP_TYPEHASH;
    uint64 internal constant STAMP_MAX_TTL = Constants.STAMP_MAX_TTL;
    /// Half the secp256k1 group order: a signature's s above it is the malleable twin of one below (EIP-2).
    uint256 private constant HALF_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    /// The stamp's EIP-712 domain separator, hashed once in the constructor (spec §3.6: no ERC-5267); the
    /// lenses recompute it from the chain id and their target (CascadeFormulas.domainSeparator).
    bytes32 internal immutable DOMAIN_SEPARATOR;

    /// This chain's block time, in milliseconds, from the constructor (61 to 60,000, Revision 28: 60 or less is
    /// refused, so a block time in seconds, as it was given before, is never taken for milliseconds): the deploy
    /// calibrates it so half the delay in blocks takes 5/6 of it at today's speed, 1.67 times faster blocks than the
    /// chain's today (Bittensor 7,200 against 12 s, Base 120 against 0.2 s). An item also waits half its delay in blocks, ceil(delay * 1000 / (2 * MS_PER_BLOCK)) of
    /// them (R1-A L-3), counted from the block that scheduled it. On a chain whose blocks stop in a halt (Bittensor:
    /// the vault), the guardian and a relayed stamp therefore always get that many live blocks before an item can run,
    /// about 0.83 of its delay at today's speed (0.42 after a 2x speed-up), however the chain halts. The count is
    /// cumulative (R6 G): a halt that begins once those blocks are in and spans readyAt leaves the item ready in the
    /// first block after the resume, where a cancel races the execute. Base gives each block number a fixed timestamp, and an outage's blocks are filled in at their
    /// own timestamps (the sequencer's catch-up, or derivation past the sequencing window), so the front door's
    /// readyBlock comes with its readyAt, met by catch-up blocks: after an
    /// outage its protection is the guardian's cancel (by L1 forced inclusion too) and the owner's stamp, as it
    /// always was under R1-A L-3, and its window in blocks matters only if a fork slows Base's blocks past twice
    /// the calibrated time. Blocks more than twice the calibrated time apart (1.2 times today's) make an item
    /// wait longer than its delay, and never strand it: an item lapses only once both its window in time and its
    /// window in blocks have passed (`_lapsed`). Public, as an immutable extsload cannot read: the lenses serve
    /// it by asking the target.
    uint64 public immutable MS_PER_BLOCK;

    address internal guardian;
    mapping(address => bool) internal bridgeEnabled;
    address internal primaryBridge;
    /// The scheduled items, under id = keccak256(calldata) (Item, CascadeTypes.sol).
    mapping(bytes32 id => Item) internal scheduled;
    /// Every bridge ever active: set by the constructor and every activation, never cleared. Its
    /// re-activation is a Reopen.
    mapping(address => bool) internal bridgeKnown;
    /// The clocks (spec §3.6): when the owner, and the guardian, last played an instrument. An item dies
    /// once its kind's clock reaches its scheduledAt.
    uint64 internal lastOwnerClose;
    uint64 internal lastGuardianClose;
    /// Who disabled the primary bridge, while it is disabled: the hold the primary's disable records.
    Actor internal primaryDisabledBy;
    /// When the pending owner's scheduled transfer executed (R1-A L-1), beside the clocks; 0 while no owner is
    /// pending (transferOwnership(0) and acceptOwnership clear it). Acceptance is that item's tail: until
    /// pendingSince + EXECUTE_WINDOW, while the exits are open, and while neither clock has reached it.
    uint64 internal pendingSince;

    /// The hash of the calldata execute is running (its item's id), set only around execute's self-call
    /// and 0 otherwise: a call is scheduled only when it comes from this contract with exactly that
    /// calldata (_scheduledCall), so a nested self-call with other calldata, made while an item runs, is
    /// not. A deliberate strengthening of spec §3.6's `bool _executing`. Transient: cleared with the
    /// transaction, and by a revert; private, so no derived contract can set it.
    bytes32 private transient _executingHash;

    // Its errors and events are declared at file level, in CascadeErrors.sol and CascadeEvents.sol.

    modifier onlyOwnerOrGuardian() {
        _actor();
        _;
    }

    /// Reachable only through execute's self-call (I-25).
    modifier onlyScheduled() {
        if (!_scheduledCall()) revert NotScheduled();
        _;
    }

    /// The guardian is never the owner's account: were they one, _actor() would read every instrument as
    /// the owner's, so a guardian's instrument would stamp the owner's clock and delay setGuardian (I-27).
    /// `msPerBlock` is this chain's calibrated block time, 61 to 60,000 milliseconds, else InvalidParameter.
    constructor(address owner_, address guardian_, address initialBridge, uint64 msPerBlock) Ownable(owner_) {
        if (guardian_ == address(0) || initialBridge == address(0)) revert ZeroAddress();
        if (guardian_ == owner_ || msPerBlock < 61 || msPerBlock > 60_000) revert InvalidParameter();
        MS_PER_BLOCK = msPerBlock;
        DOMAIN_SEPARATOR = CascadeFormulas.domainSeparator(address(this));
        guardian = guardian_;
        emit GuardianSet(guardian_);
        _enableBridge(initialBridge);
        primaryBridge = initialBridge;
        emit PrimaryBridgeSet(initialBridge);
    }

    // ---- the scheduler (spec §3.6) ----

    /// Schedules the owner change `data` (exactly a classified selector's canonical calldata) under
    /// id = keccak256(data), ready after its class delay in time and half of it in blocks (readyBlock: this
    /// block plus ceil(delay * 1000 / (2 * MS_PER_BLOCK)), R1-A L-3, `_halfInBlocks`), if its kind's gate holds
    /// and its clock is older than this second (an instrument earlier in this block would kill it at birth).
    /// Re-scheduling the same data restarts the delay.
    function schedule(bytes calldata data) external onlyOwner returns (bytes32 id) {
        (Delay class_, Kind kind) = _classify(data);
        _gate(kind, uint64(block.timestamp));
        id = keccak256(data);
        uint64 delay = _delayOf(class_);
        uint64 readyAt = uint64(block.timestamp) + delay;
        uint64 readyBlock = uint64(block.number) + _halfInBlocks(delay);
        // casting to 'bytes4' keeps the selector, the first 4 bytes of data, which _classify has matched
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes4 selector = bytes4(data);
        scheduled[id] = Item(uint64(block.timestamp), readyAt, class_, kind, selector, readyBlock);
        emit Scheduled(id, kind, selector, readyAt, data);
    }

    /// Runs the item scheduled under keccak256(data), from its readyAt and its readyBlock on until it lapses
    /// (`_lapsed`), if its kind's gate still holds and its clock is older than its scheduledAt: deletes it, then
    /// calls this contract with `data`, the one call that is scheduled while it runs, bubbling any revert
    /// (which restores the item).
    function execute(bytes calldata data) external onlyOwner {
        bytes32 id = keccak256(data);
        Item storage it = _pending(id);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < it.readyAt || block.number < it.readyBlock) revert NotReady();
        if (_lapsed(it)) revert LapsedItem();
        _gate(it.kind, it.scheduledAt);
        delete scheduled[id];
        _executingHash = id;
        (bool ok, bytes memory ret) = address(this).call(data);
        _executingHash = 0;
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        emit Executed(id);
    }

    /// The owner cancels any item; the guardian only an Ordinary one (I-24).
    function cancel(bytes32 id) external {
        Kind kind = _pending(id).kind;
        if (msg.sender != owner() && (msg.sender != guardian || kind != Kind.Ordinary)) revert NotCanceller();
        delete scheduled[id];
        emit Cancelled(id, msg.sender);
    }

    /// Anyone removes an item that has lapsed (`_lapsed`).
    function prune(bytes32 id) external {
        if (!_lapsed(_pending(id))) revert NotReady();
        delete scheduled[id];
        emit Lapsed(id);
    }

    /// Whether `it` has lapsed (Revision 28): both its window in time, until readyAt + EXECUTE_WINDOW, and its
    /// window in blocks, until readyBlock plus half EXECUTE_WINDOW in blocks (`_halfInBlocks`, as its readyBlock
    /// is half its delay), have passed. On blocks up to about twice the calibrated block time apart (today's
    /// speeds, and any faster) the blocks pass first, so an item lapses exactly as its time window ends, as
    /// before; on a slower chain, which reaches readyBlock after readyAt, an item keeps its window in blocks
    /// after readyBlock (half EXECUTE_WINDOW of calibrated blocks, more time the slower they come), so a slowdown
    /// can make an item wait longer than its delay but can never strand it. A halt is the extreme slowdown: it
    /// holds the blocks, so an item whose window in blocks had not passed when the chain halted keeps the rest of
    /// it after the resume, however long the halt, and runs once its floor's blocks are in.
    function _lapsed(Item storage it) private view returns (bool) {
        // forge-lint: disable-next-line(block-timestamp)
        return block.timestamp > uint256(it.readyAt) + EXECUTE_WINDOW
            && block.number > uint256(it.readyBlock) + _halfInBlocks(EXECUTE_WINDOW);
    }

    /// Half of `secs` in this chain's calibrated blocks, rounded up: ceil(secs * 1000 / (2 * MS_PER_BLOCK)).
    function _halfInBlocks(uint64 secs) private view returns (uint64) {
        uint64 twoBlocks = 2 * MS_PER_BLOCK;
        return (secs * 1000 + twoBlocks - 1) / twoBlocks;
    }

    /// The guardian, replaced (or kept: setting the sitting guardian is allowed). GuardianSwap. Never the
    /// owner or the pending owner, checked again here: either may have changed since schedule. A guardian's
    /// bridge hold ends with the guardian (R1-B M-1, as its door hold does on the vault): the primary stays
    /// disabled until its Reopen, but the gate opens, so a stolen guardian's late disable cannot hold the
    /// Ordinary activations it gates past the swap (the SG bound, spec §3.6).
    function setGuardian(address newGuardian) external onlyScheduled {
        _requireNotOwner(newGuardian);
        guardian = newGuardian;
        emit GuardianSet(newGuardian);
        if (primaryDisabledBy == Actor.Guardian) _reopenPrimary(this.setGuardian.selector);
        _onGuardianSet();
    }

    /// Ownership transfer is scheduled (Guardian class, Ordinary). OpenZeppelin's own onlyOwner passes the
    /// scheduled call through _checkOwner. Never to the guardian, checked again here: the guardian may have
    /// changed since schedule. So the pending owner is never the guardian. Its execute starts the pending
    /// owner's acceptance (pendingSince); transferOwnership(0) clears it.
    function transferOwnership(address newOwner) public override onlyScheduled {
        if (newOwner == guardian) revert InvalidParameter();
        pendingSince = newOwner == address(0) ? 0 : uint64(block.timestamp);
        super.transferOwnership(newOwner);
    }

    /// The pending owner accepts as the tail of its scheduled transfer (R1-A L-1, I-22): until EXECUTE_WINDOW
    /// after the transfer executed, else LapsedItem; and as an Ordinary item executes, while the exits are open
    /// and neither clock has reached pendingSince (no closure by either actor and no owner stamp at or after
    /// the execute), else ExitsNotOpen. So a pending owner expires, and the owner's own instrument or stamp, or
    /// the guardian's closure, refuses it at once. Then OpenZeppelin's check of the caller.
    function acceptOwnership() public override {
        uint64 since = pendingSince;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > uint256(since) + EXECUTE_WINDOW) revert LapsedItem();
        _gate(Kind.Ordinary, since);
        pendingSince = 0;
        super.acceptOwnership();
    }

    /// A bridge's activation: scheduled only (Registry class: Ordinary for a bridge never active, Reopen for a
    /// known one), reverting AlreadyActive for an enabled bridge, as schedule does (ruling B3). The primary's
    /// clears its hold.
    function activateBridge(address bridge) external onlyScheduled {
        if (bridgeEnabled[bridge]) revert AlreadyActive();
        _enableBridge(bridge);
        if (bridge == primaryBridge) _reopenPrimary(this.activateBridge.selector);
    }

    /// The owner's stamp, relayed by any account (spec §3.6): the owner's clock moves to `asOf` if later,
    /// killing every owner-clock item (every kind) scheduled at or before it, and nothing else changes. `sig`
    /// is the owner's EIP-712 signature of OwnerStamp(asOf), checked by hand (no OpenZeppelin EIP712 or
    /// ECDSA): exactly 65 bytes (r, s, v), v 27 or 28, s in the lower half of the curve order, recovered by
    /// ecrecover to the owner, never asked of a contract (no ERC-1271), else BadStamp; and
    /// asOf <= now <= asOf + STAMP_MAX_TTL, else StampOutOfWindow. No nonce: a replay moves nothing, since
    /// the clock only moves forward; every valid call emits StampedBySig (spec §3.10.7).
    function stampBySig(uint64 asOf, bytes calldata sig) external {
        if (sig.length != 65) revert BadStamp();
        bytes32 r = bytes32(sig[:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if ((v != 27 && v != 28) || uint256(s) > HALF_ORDER) revert BadStamp();
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, keccak256(abi.encode(STAMP_TYPEHASH, asOf))));
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != owner()) revert BadStamp();
        // forge-lint: disable-next-line(block-timestamp)
        if (asOf > block.timestamp || block.timestamp > uint256(asOf) + STAMP_MAX_TTL) revert StampOutOfWindow();
        if (asOf > lastOwnerClose) lastOwnerClose = asOf;
        emit StampedBySig(asOf, msg.sender);
    }

    /// Whether this call is execute's self-call: from this contract, with exactly the calldata of the item
    /// execute is running. The sender is checked first, so an ordinary call never hashes its calldata.
    function _scheduledCall() internal view returns (bool) {
        return msg.sender == address(this) && _executingHash != 0 && _executingHash == keccak256(msg.data);
    }

    /// OpenZeppelin's onlyOwner also admits execute's self-call, so an owner setter reads as the spec's
    /// onlyOwnerOrScheduled. Only classified selectors are ever executed (_classify), so no other
    /// onlyOwner function is reachable this way.
    function _checkOwner() internal view override {
        if (!_scheduledCall()) super._checkOwner();
    }

    /// An owner setter's direction rule (spec §3.6): NotScheduled when its change `loosens` a protective limit
    /// outside execute's self-call, so a loosening waits as a scheduled item (its setter classified Param,
    /// Ordinary), while a tightening or an equal value applies at once and is never refused (I-23). A
    /// multi-field setter passes whether any field loosens.
    function _requireScheduledIfLoosens(bool loosens) internal view {
        if (loosens && !_scheduledCall()) revert NotScheduled();
    }

    /// The class and kind of `data`, which must be a schedulable selector's canonical calldata: a derived
    /// contract classifies its own selectors, then defers to this. Activations decode their target with
    /// abi.decode, which refuses dirty bits, so one target has one calldata and one id (spec §3.10.8).
    function _classify(bytes calldata data) internal view virtual returns (Delay, Kind) {
        // casting to 'bytes4' keeps the selector, the first 4 bytes of data (zero-padded when shorter)
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes4 s = bytes4(data);
        if (s == this.setGuardian.selector) {
            address g = _addressArg(data);
            if (g == address(0)) revert ZeroAddress();
            _requireNotOwner(g);
            return (Delay.Guardian, Kind.GuardianSwap);
        }
        if (s == this.transferOwnership.selector) {
            if (_addressArg(data) == guardian) revert InvalidParameter();
            return (Delay.Guardian, Kind.Ordinary);
        }
        if (s == this.activateBridge.selector) {
            address bridge = _addressArg(data);
            if (bridge == address(0)) revert ZeroAddress();
            if (bridgeEnabled[bridge]) revert AlreadyActive();
            return (Delay.Registry, bridgeKnown[bridge] ? Kind.Reopen : Kind.Ordinary);
        }
        revert UnknownSelector();
    }

    /// Refuses `data` unless it is a selector and exactly `words` ABI words.
    function _requireArgs(bytes calldata data, uint256 words) internal pure {
        if (data.length != 4 + 32 * words) revert BadCalldata();
    }

    /// The one address argument of `data`, strictly decoded: BadCalldata unless exactly one word, and a
    /// bare revert on dirty upper bits. Internal, for the derived contracts' address setters.
    function _addressArg(bytes calldata data) internal pure returns (address) {
        _requireArgs(data, 1);
        return abi.decode(data[4:], (address));
    }

    /// InvalidParameter when `g` is the owner or the pending owner: the guardian and the owner are never one
    /// account (the constructor's rule), at schedule and at execute of setGuardian.
    function _requireNotOwner(address g) private view {
        if (g == owner() || g == pendingOwner()) revert InvalidParameter();
    }

    /// The item under `id`; NoProposal when nothing is scheduled there. A storage pointer: each caller reads
    /// only the field it needs.
    function _pending(bytes32 id) private view returns (Item storage it) {
        it = scheduled[id];
        if (it.readyAt == 0) revert NoProposal();
    }

    function _delayOf(Delay class_) private pure returns (uint64) {
        if (class_ == Delay.Param) return PARAM_DELAY;
        if (class_ == Delay.Registry) return REGISTRY_DELAY;
        return GUARDIAN_DELAY;
    }

    /// Runs after setGuardian: the vault clears a guardian's door hold here (Task 10).
    function _onGuardianSet() internal virtual {}

    // ---- the exits machine (spec §3.6): holds, clocks and gates ----

    /// Whether the owner holds the exits closed. The base records one hold, the primary's disable (the
    /// front door's whole machine); the vault adds its pause and its launch door's removal (Task 10).
    function ownerHold() internal view virtual returns (bool) {
        return CascadeFormulas.holds(Actor.Owner, primaryDisabledBy, Actor.None, Actor.None);
    }

    function guardianHold() internal view virtual returns (bool) {
        return CascadeFormulas.holds(Actor.Guardian, primaryDisabledBy, Actor.None, Actor.None);
    }

    /// OPEN: neither actor holds the exits closed.
    function exitsOpen() internal view virtual returns (bool) {
        return CascadeFormulas.exitsOpen(ownerHold(), guardianHold());
    }

    /// The caller as an instrument's actor: the owner, else the guardian; NotGuardian for anyone else.
    function _actor() internal view returns (Actor) {
        if (msg.sender == owner()) return Actor.Owner;
        if (msg.sender == guardian) return Actor.Guardian;
        revert NotGuardian();
    }

    /// `a`'s clock reads block.timestamp: every item of a kind on that clock scheduled until now dies. None is
    /// no actor and has no clock: it reverts (no instrument passes it, since _actor() never answers None).
    function _stamp(Actor a) internal {
        if (a == Actor.Owner) lastOwnerClose = uint64(block.timestamp);
        else if (a == Actor.Guardian) lastGuardianClose = uint64(block.timestamp);
        else revert InvalidParameter();
    }

    /// ExitsNotOpen unless an item of `kind` passes its gate and its clock is older than `notBefore`
    /// (spec §3.6's table): Ordinary needs exitsOpen() and reads both clocks; a GuardianSwap needs no owner
    /// hold and reads the owner's; a Reopen needs no gate and reads the owner's. `notBefore` is
    /// block.timestamp at schedule, the item's scheduledAt at execute, and pendingSince at acceptOwnership.
    function _gate(Kind kind, uint64 notBefore) private view {
        uint64 clock = lastOwnerClose;
        if (kind == Kind.Ordinary) {
            if (!exitsOpen()) revert ExitsNotOpen();
            uint64 g = lastGuardianClose;
            if (g > clock) clock = g;
        } else if (kind == Kind.GuardianSwap) {
            if (ownerHold()) revert ExitsNotOpen();
        }
        if (clock >= notBefore) revert ExitsNotOpen();
    }

    /// The primary is enabled again (its Reopen) or replaced by an enabled bridge, or the guardian whose hold it
    /// was is replaced (setGuardian): its hold is cleared, with nothing stamped.
    function _reopenPrimary(bytes4 instrument) private {
        primaryDisabledBy = Actor.None;
        emit ExitsReopened(instrument);
    }

    /// The caps a new primary must meet (spec §3.9), which setPrimaryBridge checks: each contract's own per-message
    /// limit within the new bridge's, through _requireBridgeCap (the vault's maxMessageValue, Task 23; the front
    /// door's maxBatchValue, Task 30). None here.
    function _checkBridgeCaps(address bridge) internal view virtual {}

    /// AboveBridgeCap unless `bridge` carries `value` in one message: `value` at most its maxMessageValue() (spec
    /// §3.9). The one cap check, shared by the vault's and the front door's constructors, limit setters and
    /// _checkBridgeCaps. A view call: the bridge, the primary or the one being made it, can change nothing here.
    function _requireBridgeCap(address bridge, uint256 value) internal view {
        if (value > ICascadeBridge(bridge).maxMessageValue()) revert AboveBridgeCap();
    }

    // ---- bridges and the instruments ----

    /// The owner or the guardian disables an enabled bridge. The primary's disable is an instrument: it
    /// records its actor (the hold) and stamps that actor's clock. Any other bridge's records nothing.
    function disableBridge(address bridge) external {
        Actor a = _actor();
        if (!bridgeEnabled[bridge]) revert BridgeNotEnabled();
        bridgeEnabled[bridge] = false;
        emit BridgeDisabled(bridge);
        if (bridge == primaryBridge) {
            primaryDisabledBy = a;
            _stamp(a);
            emit ExitsClosed(msg.sender, this.disableBridge.selector);
        }
    }

    /// The owner switches the primary to an enabled bridge meeting the caps, only while the current
    /// primary is disabled (H-2 ii): the switch clears the hold and stamps nothing.
    function setPrimaryBridge(address bridge) external onlyOwner {
        if (bridgeEnabled[primaryBridge]) revert PrimaryStillEnabled();
        if (!bridgeEnabled[bridge]) revert BridgeNotEnabled();
        _checkBridgeCaps(bridge);
        primaryBridge = bridge;
        emit PrimaryBridgeSet(bridge);
        _reopenPrimary(this.setPrimaryBridge.selector);
    }

    /// The base's pause records and stamps nothing (the front door's: deposits and sales only, spec §3.6);
    /// the vault overrides both (Task 10).
    function pause() public virtual onlyOwnerOrGuardian {
        _pause();
    }

    function unpause() public virtual onlyOwner {
        _unpause();
    }

    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// The raw word in storage slot `slot`, for the read-only lenses (spec §8.1), which locate each
    /// variable with the constants generated from this contract's storage layout. One slot per call,
    /// never a batch form: a multicall batches reads.
    function extsload(bytes32 slot) external view returns (bytes32 value) {
        assembly ("memory-safe") {
            value := sload(slot)
        }
    }

    /// `bridge` becomes enabled and known: the constructor's, and every activation's.
    function _enableBridge(address bridge) internal {
        bridgeEnabled[bridge] = true;
        bridgeKnown[bridge] = true;
        emit BridgeActivated(bridge);
    }

    /// The inbound check: NotBridge unless the caller is an enabled bridge, the vault's rule (a rogue inbound to the
    /// vault is the registry's business). The front door overrides it with bridgeKnown (spec §3.2, H-2 i).
    function _requireBridge() internal view virtual {
        if (!bridgeEnabled[msg.sender]) revert NotBridge();
    }

    function _primary() internal view returns (ICascadeBridge) {
        address p = primaryBridge;
        if (!bridgeEnabled[p]) revert PrimaryBridgeDisabled();
        return ICascadeBridge(p);
    }
}
