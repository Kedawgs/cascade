// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm, VmSafe} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CascadeDoorLens} from "../../../src/lens/CascadeDoorLens.sol";
import {CascadeVaultLens} from "../../../src/lens/CascadeVaultLens.sol";
import {CascadeBase} from "../../../src/CascadeBase.sol";
import {CascadeFrontDoor} from "../../../src/CascadeFrontDoor.sol";
import {NotReady} from "../../../src/CascadeErrors.sol";
import {
    BatchDelivered,
    BridgeActivated,
    FrontDoorActivated,
    FrontDoorRemoved,
    HotkeyAdded,
    PayoutBatchQueued,
    Scheduled,
    Transfer
} from "../../../src/CascadeEvents.sol";
import {VaultLayout} from "../../../src/lens/generated/VaultLayout.sol";
import {Schedule} from "../../governance/Schedule.sol";
import {VaultInternals} from "../../utils/VaultInternals.sol";
import {PriceFloorTracker} from "./PriceFloorTracker.sol";

/// @notice The base every Phase 8 handler extends (Task 34a): I-4's bookkeeping (PriceFloorTracker), the step modifier
/// around every action, the record of unexpected reverts that `invariant_noUnexpectedReverts` reads, the owner's
/// scheduled items through the scheduler fixture, the warps that roll the blocks, and what BoundaryInvariants checks
/// after every step: the argument sets both lenses are compared over (I-33) and the token's `Transfer` logs folded
/// into per-account sums (I-34).
///
/// The log buffer has one owner (ruling DB2). `step` calls vm.recordLogs() once at its start, which also clears what
/// anything outside a step left in the buffer (an invariant's own logs, a reverted step's), and reads the buffer once
/// at its end. A site that needs a call's logs mid-step reads them with `_readLogs()`, which hands the logs since the
/// last read to `_onLogs` and returns them, recording on: every log of a step reaches `_onLogs` exactly once, in order,
/// and no handler calls vm.recordLogs or vm.getRecordedLogs itself. Forge's buffer also keeps the logs of frames that
/// reverted, which no chain keeps, so a handler reads the buffer right before each call it may see revert and drops
/// what that call logged when it does (`_dropLogs`, in the catch). A frame that reverts inside a call that succeeds (a
/// bridge's caught delivery) is not dropped: none of the vault's refusals of a delivery comes after a mint or a burn,
/// so no `Transfer` sits in one, and a campaign whose rail catches a refusal after one must drop it too.
///
/// Expected reverts: an action predicts its refusal from its state (`expect`, the error's selector, or none). A
/// success where a refusal was predicted, a refusal where none was, and a refusal with another error than the one
/// predicted each count in `unexpectedReverts` (`_succeeded`, `_refused`).
abstract contract TrackedHandler is PriceFloorTracker, StdCheats, StdUtils {
    /// What a bytes32 argument is (for the lenses' kind-sorted checks, BoundaryInvariants): a hotkey, a peer id or
    /// window key (the global window's is bytes32(0)), a batch key, a scheduled item's id, or none of those.
    enum WordKind {
        Other,
        Hotkey,
        Peer,
        BatchKey,
        Scheduled
    }

    /// The word nothing is stored under, in every kind's set.
    bytes32 public constant NOTHING = keccak256("nothing is stored here");

    /// The system a handler drives: the vault and the front door, their lenses, the owner and the guardian.
    struct System {
        VaultInternals vault;
        CascadeVaultLens vaultLens;
        CascadeFrontDoor fd;
        CascadeDoorLens doorLens;
        address owner;
        address guardian;
    }

    CascadeFrontDoor public immutable fd;
    /// The read-only lens on `fd` (spec §8.1).
    CascadeDoorLens public immutable doorLens;
    /// The owner of the vault and of the front door, whom the handler pranks, and their guardian.
    address public immutable owner;
    address public immutable guardian;
    /// The vault's and the front door's MS_PER_BLOCK (the deploy's 7,200 and 120 ms, twice as fast as Bittensor's
    /// 12-second and Base's 0.2-second blocks, Revision 28): the block rate each chain's warps roll at (`_warp`).
    uint256 public immutable vaultBlockTime;
    uint256 public immutable doorBlockTime;

    /// Calls (and bridge deliveries) that failed although the handler checked their precondition, failed with
    /// another error than the one their state predicts, or succeeded where the handler predicted a refusal.
    uint256 public unexpectedReverts;
    /// Steps taken (successful handler calls): the deterministic count BoundaryInvariants reads to run the lenses' full
    /// argument cross product on every 8th step.
    uint256 public steps;

    // ---- I-33: the argument sets the lenses are compared over ----

    /// The bytes32 arguments: hotkeys, peer ids, batch keys, scheduled ids, and words nothing is stored under; and the
    /// same words by kind.
    bytes32[] internal _words;
    mapping(bytes32 => bool) internal _isWord;
    mapping(WordKind => bytes32[]) internal _kindWords;
    mapping(WordKind => mapping(bytes32 => bool)) internal _isKindWord;
    /// The address arguments: users, roles, bridges, front doors, every account a Transfer named, the zero address.
    address[] internal _accounts;
    mapping(address => bool) internal _isAccount;
    /// The (chain, address) arguments, pairwise: the doors, and pairs no door is; the chains alone are the (uint64)
    /// arguments.
    uint64[] internal _chains;
    address[] internal _peers;
    mapping(bytes32 => bool) internal _isPeer;
    /// The (chain, sender, message) arguments of batchKey, by index.
    uint64[] internal _sourceChains;
    address[] internal _senders;
    bytes[] internal _messages;
    /// Every id the vault's scheduler logged, and its calldata (the Scheduled event's), in order.
    bytes32[] internal _vaultScheduled;
    mapping(bytes32 => bytes) internal _scheduledData;

    // ---- I-34: the token's Transfer logs, folded ----

    /// Per account, what the vault's Transfer logs moved to it and from it: a mint (from 0) is an inflow, a burn (to 0)
    /// an outflow, and a transfer between two holders both, so each account's balance is its inflow less its outflow.
    mapping(address => uint256) public inflow;
    mapping(address => uint256) public outflow;
    /// Transfers between two non-zero accounts (csTAO is non-transferable: I-34 says none).
    uint256 public holderTransfers;

    /// Test-only (no action sets it): whether each step keeps its logs for `stepLogs()`.
    bool public keepLogs;
    bytes[] internal _kept;

    constructor(System memory s) PriceFloorTracker(s.vault, s.vaultLens) {
        fd = s.fd;
        doorLens = s.doorLens;
        owner = s.owner;
        guardian = s.guardian;
        vaultBlockTime = s.vaultLens.MS_PER_BLOCK();
        doorBlockTime = s.doorLens.MS_PER_BLOCK();
        require(s.vaultLens.target() == address(s.vault) && s.doorLens.target() == address(s.fd), "the lenses");
        address[8] memory roles = [
            address(0),
            s.owner,
            s.guardian,
            address(this),
            address(s.vault),
            address(s.fd),
            s.vaultLens.treasury(),
            s.vaultLens.primaryBridge()
        ];
        for (uint256 i; i < roles.length; ++i) {
            _trackAccount(roles[i]);
        }
        _trackAccount(s.doorLens.primaryBridge());
        // the global window's key and a word nothing is stored under
        _trackWord(bytes32(0), WordKind.Peer);
        _trackWord(NOTHING, WordKind.Other);
        _trackPeer(0, address(0));
        _trackMessage(0, address(0), "");
    }

    /// @dev Every action. The logs: recorded from its start, read at its end (see the contract's notes). The floor
    /// (I-4) rises to the price at its start and at its end: raising it to any price observed is sound; only an
    /// exception's step lowers it, to the price after it. Steps that move time also raise it right after each warp,
    /// before the call they measure (`_warp`). At its end, a supply-0 shortfall hole whose shortfall closed, or whose
    /// supply left 0, is forgotten (PriceFloorTracker's shortfallHoleWei).
    modifier step() {
        vm.recordLogs();
        if (keepLogs) delete _kept;
        _raiseFloor();
        _;
        _raiseFloor();
        _readLogs();
        _forgetClosedShortfallHole();
        ++steps;
    }

    // ---- the log buffer ----

    /// The logs since the last read (or the step's start), handed to `_onLogs` and returned; recording stays on.
    function _readLogs() internal returns (Vm.Log[] memory logs) {
        logs = vm.getRecordedLogs();
        if (keepLogs) {
            for (uint256 i; i < logs.length; ++i) {
                _kept.push(abi.encode(logs[i]));
            }
        }
        _onLogs(logs);
    }

    /// In a catch: drops what the reverted call logged since the last read (read right before the call), which no
    /// chain keeps; recording stays on. A view to the compiler, as forge-std declares the cheatcode.
    function _dropLogs() internal view {
        vm.getRecordedLogs();
    }

    /// Every log of every step, once, in order (kept frames only; see the contract's notes). Folds the vault's
    /// Transfer logs (I-34) and grows the lenses' argument sets: every account a Transfer names, every id the
    /// schedulers log, every batch key the vault logs, every hotkey it adds, every door it activates or removes and
    /// every bridge either activates. A handler that overrides it calls this one.
    function _onLogs(Vm.Log[] memory logs) internal virtual {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory log = logs[i];
            if (log.topics.length == 0) continue;
            bytes32 sig = log.topics[0];
            bool fromVault = log.emitter == address(vault);
            if (fromVault && sig == Transfer.selector) {
                address from = _topicAddress(log.topics[1]);
                address to = _topicAddress(log.topics[2]);
                uint256 value = abi.decode(log.data, (uint256));
                if (from != address(0)) outflow[from] += value;
                if (to != address(0)) inflow[to] += value;
                if (from != address(0) && to != address(0)) ++holderTransfers;
                // a mint: the supply has left 0, so a recorded supply-0 shortfall hole is forgotten (a cancel that
                // absorbs it has spent it already)
                if (from == address(0) && value != 0) shortfallHoleWei = 0;
                _trackAccount(from);
                _trackAccount(to);
            } else if ((fromVault || log.emitter == address(fd)) && sig == Scheduled.selector) {
                bytes32 id = log.topics[1];
                _trackWord(id, WordKind.Scheduled);
                if (fromVault) {
                    (,, bytes memory data) = abi.decode(log.data, (uint8, uint64, bytes));
                    if (_scheduledData[id].length == 0) _vaultScheduled.push(id);
                    _scheduledData[id] = data;
                }
            } else if (fromVault && (sig == BatchDelivered.selector || sig == PayoutBatchQueued.selector)) {
                _trackWord(log.topics[1], WordKind.BatchKey);
            } else if (fromVault && sig == HotkeyAdded.selector) {
                _trackWord(log.topics[1], WordKind.Hotkey);
            } else if (fromVault && (sig == FrontDoorActivated.selector || sig == FrontDoorRemoved.selector)) {
                // casting to 'uint64' is safe because the topic is an indexed uint64
                // forge-lint: disable-next-line(unsafe-typecast)
                _trackPeer(uint64(uint256(log.topics[1])), _topicAddress(log.topics[2]));
            } else if ((fromVault || log.emitter == address(fd)) && sig == BridgeActivated.selector) {
                _trackAccount(_topicAddress(log.topics[1]));
            }
        }
    }

    // ---- the door hold (R4 B-H1), aged by a unit test ----

    /// Test-only (no action sets it): whether each delivery the handler drives first ages every tracked account's fresh
    /// shares past the door hold (`_ageShares`). The unit tests that predate the hold, and pin exits rather than the
    /// hold, set it; a campaign never does, so its deliveries meet the hold as deployed (and the core campaign's I-36
    /// checks them).
    bool public ageAtDeliveries;

    function setAgeAtDeliveries(bool on) external {
        ageAtDeliveries = on;
    }

    /// `user`'s fresh shares aged past the door hold (spec §3.5, R4 B-H1) with nothing else moved: its holder record's
    /// clock and fresh shares cleared at the generated layout, its redeem origin kept, as if its last mint were more than
    /// a day old.
    function _age(address user) internal virtual {
        bytes32 slot = keccak256(abi.encode(user, VaultLayout.SLOT_HOLDERS));
        uint256 word = uint256(vm.load(address(vault), slot));
        if (word >> 64 != 0) vm.store(address(vault), slot, bytes32(word & type(uint64).max));
    }

    /// Every tracked account's fresh shares aged past the door hold (`_age`), while `ageAtDeliveries` is set.
    function _ageShares() internal {
        if (!ageAtDeliveries) return;
        for (uint256 i; i < _accounts.length; ++i) {
            _age(_accounts[i]);
        }
    }

    /// Test-only: whether each step keeps its logs for `stepLogs()` (a unit test's view of a step's logs, which it
    /// cannot record itself: the step owns the buffer).
    function setKeepLogs(bool on) external {
        keepLogs = on;
        delete _kept;
    }

    /// The last step's logs, while keepLogs is set.
    function stepLogs() external view returns (Vm.Log[] memory logs) {
        logs = new Vm.Log[](_kept.length);
        for (uint256 i; i < logs.length; ++i) {
            logs[i] = abi.decode(_kept[i], (VmSafe.Log));
        }
    }

    // ---- the argument sets ----

    /// `w`, a word of kind `kind` (a word may be of several kinds).
    function _trackWord(bytes32 w, WordKind kind) internal {
        if (!_isWord[w]) {
            _isWord[w] = true;
            _words.push(w);
        }
        if (!_isKindWord[kind][w]) {
            _isKindWord[kind][w] = true;
            _kindWords[kind].push(w);
        }
    }

    function _trackAccount(address a) internal {
        if (_isAccount[a]) return;
        _isAccount[a] = true;
        _accounts.push(a);
    }

    /// A (chain, address) pair, its chain, and its peer id (a word) when it is a door's.
    function _trackPeer(uint64 chain, address addr) internal {
        bytes32 id = keccak256(abi.encode(chain, addr));
        if (_isPeer[id]) return;
        _isPeer[id] = true;
        _chains.push(chain);
        _peers.push(addr);
        _trackWord(vaultLens.peerId(chain, addr), WordKind.Peer);
    }

    function _trackMessage(uint64 sourceChain, address sender, bytes memory message) internal {
        _sourceChains.push(sourceChain);
        _senders.push(sender);
        _messages.push(message);
    }

    function trackedWords() external view returns (bytes32[] memory) {
        return _words;
    }

    /// The tracked words of kind `kind`.
    function trackedWordsOf(WordKind kind) external view returns (bytes32[] memory) {
        return _kindWords[kind];
    }

    function trackedAccounts() external view returns (address[] memory) {
        return _accounts;
    }

    function trackedPeers() external view returns (uint64[] memory chains, address[] memory peers) {
        return (_chains, _peers);
    }

    function trackedMessages()
        external
        view
        returns (uint64[] memory sourceChains, address[] memory senders, bytes[] memory messages)
    {
        return (_sourceChains, _senders, _messages);
    }

    /// Every id the vault's scheduler logged, and the calldata it logged for `id`.
    function vaultScheduled() external view returns (bytes32[] memory) {
        return _vaultScheduled;
    }

    function scheduledData(bytes32 id) external view returns (bytes memory) {
        return _scheduledData[id];
    }

    // ---- expected reverts ----

    /// A call that succeeded: a predicted refusal (`expect` non-zero) that did not happen is unexpected.
    function _succeeded(bytes4 expect) internal {
        if (expect != 0) ++unexpectedReverts;
    }

    /// A call that reverted with `reason`: whether it is the refusal `expect` predicted. Any other (or any refusal
    /// where none was predicted) counts as unexpected.
    function _refused(bytes memory reason, bytes4 expect) internal returns (bool predicted) {
        predicted = expect != 0 && _selector(reason) == expect;
        if (!predicted) ++unexpectedReverts;
    }

    /// The first 4 bytes of revert data (zero-padded when shorter).
    function _selector(bytes memory reason) internal pure returns (bytes4) {
        // truncating to the selector is the point of the cast
        // forge-lint: disable-next-line(unsafe-typecast)
        return bytes4(reason);
    }

    // ---- time ----

    /// Moves the clock `secs` forward and the block number with it, a block per `msPerBlock` milliseconds (the
    /// vault's 7,200 for a delay the vault keeps, the front door's 120 for one the front door keeps; one EVM holds
    /// both chains, so the faster rate meets both schedulers' block floors), as a chain at its calibrated speed does:
    /// the schedulers read readyBlock (R1-A L-3), which a warp that left the blocks behind would hold back, and the
    /// lapse reads the blocks too (Revision 28). Then raises the floor (I-4).
    function _warp(uint256 secs, uint256 msPerBlock) internal {
        vm.warp(vm.getBlockTimestamp() + secs);
        vm.roll(vm.getBlockNumber() + secs * 1000 / msPerBlock);
        _raiseFloor();
    }

    // ---- the owner's scheduled items ----

    /// The scheduler fixture's run (Schedule.run's steps: schedule as the owner, wait the class delay, execute), the
    /// floor raised after the wait, before the execute (I-1 of the fix round: a step that moves time raises the floor
    /// before the call it measures).
    function _runScheduled(CascadeBase c, bytes memory data) internal {
        _scheduleAndWait(c, data);
        vm.prank(owner);
        c.execute(data);
    }

    /// Schedule.run's steps with each call tried (for a way back whose silent loss would hide a refusal): `data` is
    /// scheduled as the owner, its class delay proved and waited out, then executed. A refusal of the schedule or the
    /// execute counts as unexpected (`_refused(reason, 0)`); returns whether the item ran.
    function _tryRunScheduled(CascadeBase c, bytes memory data) internal returns (bool ran) {
        _waitOutTheClocks(c);
        _readLogs();
        vm.prank(owner);
        try c.schedule(data) {}
        catch (bytes memory reason) {
            _dropLogs();
            _refused(reason, 0);
            return false;
        }
        _waitTheDelay(c, data);
        _readLogs();
        vm.prank(owner);
        try c.execute(data) {
            ran = true;
        } catch (bytes memory reason) {
            _dropLogs();
            _refused(reason, 0);
        }
    }

    /// Schedule.run's first half, for a caller that reads the state right before the execute: schedules `data` as the
    /// owner (_ownerSchedules), proves the class delay as Schedule.run does (one second before it, execute reverts
    /// NotReady), waits it out, rolling the blocks along (Schedule.warpTo), and raises the floor.
    function _scheduleAndWait(CascadeBase c, bytes memory data) internal {
        _ownerSchedules(c, data);
        _waitTheDelay(c, data);
    }

    /// From an item's schedule this second: one second before its class delay its execute reverts NotReady (as
    /// Schedule.run proves), then the delay is waited out, rolling the blocks along (Schedule.warpTo), and the floor
    /// raised.
    function _waitTheDelay(CascadeBase c, bytes memory data) internal {
        // casting to 'bytes4' keeps the selector, the first 4 bytes of data
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 readyAt = vm.getBlockTimestamp() + Schedule.delayOf(bytes4(data));
        Schedule.warpTo(readyAt - 1);
        _readLogs();
        vm.prank(owner);
        (bool early, bytes memory why) = address(c).call(abi.encodeCall(CascadeBase.execute, (data)));
        _dropLogs();
        require(!early && keccak256(why) == keccak256(abi.encodeWithSelector(NotReady.selector)), "the delay");
        Schedule.warpTo(readyAt);
        _raiseFloor();
    }

    /// The owner schedules `data` on `c`, a second later when an instrument this second (a launch-door cancel, a door's
    /// removal) has stamped either of its clocks, which an item's schedule refuses (an Ordinary item reads both).
    function _ownerSchedules(CascadeBase c, bytes memory data) internal returns (bytes32 id) {
        _waitOutTheClocks(c);
        vm.prank(owner);
        id = c.schedule(data);
    }

    /// A second's wait when either of `c`'s clocks reads this second.
    function _waitOutTheClocks(CascadeBase c) internal {
        bool onVault = address(c) == address(vault);
        uint256 clock = onVault
            ? Math.max(vaultLens.lastOwnerClose(), vaultLens.lastGuardianClose())
            : Math.max(doorLens.lastOwnerClose(), doorLens.lastGuardianClose());
        if (clock >= vm.getBlockTimestamp()) Schedule.wait(1);
    }

    // ---- reads ----

    function _topicAddress(bytes32 topic) internal pure returns (address) {
        // casting to 'uint160' is safe because the topic is an indexed address
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(uint256(topic)));
    }
}
