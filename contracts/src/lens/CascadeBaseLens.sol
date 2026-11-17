// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IExtsload} from "../interfaces/IExtsload.sol";
import "../CascadeConstants.sol" as Constants;
import {ZeroAddress} from "../CascadeErrors.sol";
import {Actor, Delay, Item, Kind} from "../CascadeTypes.sol";
import {CascadeFormulas} from "../libraries/CascadeFormulas.sol";

/// @notice The read-only lenses' shared part (spec §8.1): the target's address, the reads through its
/// `extsload`, and CascadeBase's getters, internal on both the vault and the front door. Each lens
/// locates CascadeBase's state in its target from that target's generated layout constants: the
/// variables sit at different slots in the two (guardian at 5 in the vault, behind the share token,
/// and at 3 in the front door).
/// @dev A lens holds no state and has no owner: its only input is the immutable target, it reads the
/// target only through `extsload` (but MS_PER_BLOCK, an immutable it asks the target for), and every
/// function is a view. A wrong lens shows wrong numbers,
/// never moves funds, and can be redeployed without its target.
abstract contract CascadeBaseLens {
    /// The contract this lens reads.
    address public immutable target;

    uint64 public constant PARAM_DELAY = Constants.PARAM_DELAY;
    uint64 public constant REGISTRY_DELAY = Constants.REGISTRY_DELAY;
    uint64 public constant GUARDIAN_DELAY = Constants.GUARDIAN_DELAY;
    uint64 public constant EXECUTE_WINDOW = Constants.EXECUTE_WINDOW;
    bytes32 public constant STAMP_TYPEHASH = Constants.STAMP_TYPEHASH;
    uint64 public constant STAMP_MAX_TTL = Constants.STAMP_MAX_TTL;

    constructor(address target_) {
        if (target_ == address(0)) revert ZeroAddress();
        target = target_;
    }

    // ---- CascadeBase's getters ----

    /// The target's EIP-712 domain separator for the owner-signed stamp: the target hashes it once, in its
    /// constructor, into an immutable that extsload cannot read, so the lens recomputes it with the same
    /// formula from this chain's id and its target (spec §8.1, rev 12 L-1).
    // forge-lint: disable-next-line(mixed-case-function)
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return CascadeFormulas.domainSeparator(target);
    }

    /// The target's calibrated block time in milliseconds, its scheduler's block floor and block window (R1-A
    /// L-3, Revision 28): an immutable, which extsload cannot read and no formula gives, so the lens asks the
    /// target, which keeps this one getter for it (lens-surface.mjs's FORWARDED).
    // forge-lint: disable-next-line(mixed-case-function)
    function MS_PER_BLOCK() external view returns (uint64) {
        return IExtsload(target).MS_PER_BLOCK();
    }

    function guardian() external view returns (address) {
        (uint256 slot, uint256 offset, uint256 size) = _guardianField();
        return _address(slot, offset, size);
    }

    function bridgeEnabled(address bridge) external view returns (bool) {
        return _bool(_entry(_bridgeEnabledSlot(), _key(bridge)), 0, 1);
    }

    function primaryBridge() external view returns (address) {
        (uint256 slot, uint256 offset, uint256 size) = _primaryBridgeField();
        return _address(slot, offset, size);
    }

    /// The item scheduled under `id` (all zero when none). An Item is one slot (CascadeTypes.sol), so one
    /// extsload reads it, and each member is cut from that word at the offset and size of the generated
    /// Item constants (script/gen-lens-layout.test.mjs pins every member to the item's first slot).
    function scheduled(bytes32 id) external view returns (Item memory item) {
        uint256 word = _word(_entry(_scheduledSlot(), id));
        uint256[2][6] memory m = _itemMembers();
        // casting to 'uint64' is safe because _bits keeps only the member's 8 bytes, a uint64's
        // forge-lint: disable-next-line(unsafe-typecast)
        item.scheduledAt = uint64(_bits(word, m[0][0], m[0][1]));
        // casting to 'uint64' is safe because _bits keeps only the member's 8 bytes, a uint64's
        // forge-lint: disable-next-line(unsafe-typecast)
        item.readyAt = uint64(_bits(word, m[1][0], m[1][1]));
        item.class = Delay(_bits(word, m[2][0], m[2][1]));
        item.kind = Kind(_bits(word, m[3][0], m[3][1]));
        // casting to 'uint32' is safe because _bits keeps only the member's 4 bytes, a bytes4's
        // forge-lint: disable-next-line(unsafe-typecast)
        item.selector = bytes4(uint32(_bits(word, m[4][0], m[4][1])));
        // casting to 'uint64' is safe because _bits keeps only the member's 8 bytes, a uint64's
        // forge-lint: disable-next-line(unsafe-typecast)
        item.readyBlock = uint64(_bits(word, m[5][0], m[5][1]));
    }

    function bridgeKnown(address bridge) external view returns (bool) {
        return _bool(_entry(_bridgeKnownSlot(), _key(bridge)), 0, 1);
    }

    // ---- the exits machine (spec §3.6) ----

    function lastOwnerClose() external view returns (uint64) {
        (uint256 slot, uint256 offset, uint256 size) = _lastOwnerCloseField();
        return _uint64(slot, offset, size);
    }

    function lastGuardianClose() external view returns (uint64) {
        (uint256 slot, uint256 offset, uint256 size) = _lastGuardianCloseField();
        return _uint64(slot, offset, size);
    }

    function primaryDisabledBy() public view returns (Actor) {
        (uint256 slot, uint256 offset, uint256 size) = _primaryDisabledByField();
        return Actor(_field(slot, offset, size));
    }

    /// When the pending owner's scheduled transfer executed; 0 while no owner is pending (R1-A L-1): the
    /// pending owner accepts until pendingSince + EXECUTE_WINDOW, while exitsOpen() and neither clock has
    /// reached it.
    function pendingSince() external view returns (uint64) {
        (uint256 slot, uint256 offset, uint256 size) = _pendingSinceField();
        return _uint64(slot, offset, size);
    }

    /// The holds and exitsOpen through the formulas the target uses (CascadeFormulas), from the recorded
    /// holds read here: the primary's disable, the front door's one hold; the vault lens adds the vault's
    /// (Task 10).
    function ownerHold() public view virtual returns (bool) {
        return CascadeFormulas.holds(Actor.Owner, primaryDisabledBy(), Actor.None, Actor.None);
    }

    function guardianHold() public view virtual returns (bool) {
        return CascadeFormulas.holds(Actor.Guardian, primaryDisabledBy(), Actor.None, Actor.None);
    }

    function exitsOpen() external view returns (bool) {
        return CascadeFormulas.exitsOpen(ownerHold(), guardianHold());
    }

    // ---- where the target keeps CascadeBase's state: each lens answers from its generated layout ----

    /// (slot, byte offset, size in bytes) of `guardian`.
    function _guardianField() internal pure virtual returns (uint256, uint256, uint256);
    function _primaryBridgeField() internal pure virtual returns (uint256, uint256, uint256);
    /// The slot of the `bridgeEnabled` mapping.
    function _bridgeEnabledSlot() internal pure virtual returns (uint256);
    function _scheduledSlot() internal pure virtual returns (uint256);
    function _bridgeKnownSlot() internal pure virtual returns (uint256);
    function _lastOwnerCloseField() internal pure virtual returns (uint256, uint256, uint256);
    function _lastGuardianCloseField() internal pure virtual returns (uint256, uint256, uint256);
    function _primaryDisabledByField() internal pure virtual returns (uint256, uint256, uint256);
    function _pendingSinceField() internal pure virtual returns (uint256, uint256, uint256);
    /// (byte offset, size in bytes) of each Item member in the item's one slot, in declaration order:
    /// scheduledAt, readyAt, class, kind, selector, readyBlock.
    function _itemMembers() internal pure virtual returns (uint256[2][6] memory);

    // ---- reading the target ----

    /// The raw word in the target's slot `slot`.
    function _word(uint256 slot) internal view returns (uint256) {
        return uint256(IExtsload(target).extsload(bytes32(slot)));
    }

    /// The `size` bytes at byte `offset` of the target's slot `slot`, counted from the low-order end, as
    /// the compiler packs a variable into its slot (offsets and sizes from the generated layout).
    function _field(uint256 slot, uint256 offset, uint256 size) internal view returns (uint256) {
        uint256 word = _word(slot);
        return size == 32 ? word : (word >> (offset * 8)) & ((uint256(1) << (size * 8)) - 1);
    }

    /// The `size` bytes at byte `offset` of `word`, counted from the low-order end: _field's cut, for a word
    /// already read (an Item's, by `scheduled`). _field keeps its own copy of the expression: written
    /// through this function, the optimizer's inlining grows the vault lens by about 1.9 KB.
    function _bits(uint256 word, uint256 offset, uint256 size) internal pure returns (uint256) {
        return size == 32 ? word : (word >> (offset * 8)) & ((uint256(1) << (size * 8)) - 1);
    }

    /// The slot of `key`'s entry in the mapping at slot `slot`: keccak256(key . slot), as the compiler
    /// lays a mapping out. A mapping's value sits at offset 0 of that slot, with its own type's size
    /// (the layout's size for a mapping variable is its root slot's, 32, so the lenses do not use it).
    function _entry(uint256 slot, bytes32 key) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(key, slot)));
    }

    /// An address mapping key, as the compiler hashes it: left-padded to 32 bytes.
    function _key(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _address(uint256 slot, uint256 offset, uint256 size) internal view returns (address) {
        // casting to 'uint160' is safe because _field keeps only `size` bytes, an address's 20
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(_field(slot, offset, size)));
    }

    function _uint64(uint256 slot, uint256 offset, uint256 size) internal view returns (uint64) {
        // casting to 'uint64' is safe because _field keeps only `size` bytes, a uint64's 8
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(_field(slot, offset, size));
    }

    function _uint32(uint256 slot, uint256 offset, uint256 size) internal view returns (uint32) {
        // casting to 'uint32' is safe because _field keeps only `size` bytes, a uint32's 4
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint32(_field(slot, offset, size));
    }

    function _uint16(uint256 slot, uint256 offset, uint256 size) internal view returns (uint16) {
        // casting to 'uint16' is safe because _field keeps only `size` bytes, a uint16's 2
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint16(_field(slot, offset, size));
    }

    /// A bool as the compiler reads one: any non-zero byte is true.
    function _bool(uint256 slot, uint256 offset, uint256 size) internal view returns (bool) {
        return _field(slot, offset, size) != 0;
    }
}
