// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeDoorLens} from "../../src/lens/CascadeDoorLens.sol";
import {CascadeVaultLens} from "../../src/lens/CascadeVaultLens.sol";
import {DoorState, Item, Kind} from "../../src/CascadeTypes.sol";
import {DoorInternals} from "../utils/DoorInternals.sol";
import {LibraryLinks} from "../utils/generated/LibraryLinks.sol";
import {LinkedLibraries} from "../utils/LinkedLibraries.sol";
import {
    LensParityChecks,
    ParitySets,
    WordKinds,
    doorLensViews,
    forwardedViews,
    vaultLensViews
} from "../utils/LensViews.sol";
import {VaultInternals} from "../utils/VaultInternals.sol";
import {TrackedHandler} from "./handlers/TrackedHandler.sol";

/// I-34's check on its own (Task 42, the Task 39b re-review's Minor 1), for BoundaryInvariants' invariant_tokenAccounting
/// and for a campaign that runs without the boundary invariants but whose probe moves tokens (the liveness file's I-28
/// family): for every account handler `h` tracks, its balanceOf on `v` is what the token's Transfer logs moved to it less
/// what they moved from it, and the sum over them is totalSupply; no Transfer between two holders.
abstract contract TokenAccounting is Test {
    function _assertTokenAccounting(TrackedHandler h, CascadeVault v) internal view {
        address[] memory accounts = h.trackedAccounts();
        uint256 sum;
        for (uint256 i; i < accounts.length; ++i) {
            address a = accounts[i];
            uint256 inflow = h.inflow(a);
            uint256 outflow = h.outflow(a);
            assertLe(outflow, inflow, string.concat("I-34: more out than in: ", vm.toString(a)));
            assertEq(v.balanceOf(a), inflow - outflow, string.concat("I-34: ", vm.toString(a)));
            sum += inflow - outflow;
        }
        assertEq(sum, v.totalSupply(), "I-34: the folded sums are not totalSupply");
        assertEq(h.holderTransfers(), 0, "I-34: a Transfer between two holders");
    }
}

/// The boundary invariants every Phase 8 campaign inherits (Task 34a), so they hold after every step of every
/// campaign: I-33, lens parity, for both lenses over the handler's tracked argument sets; I-34, token accounting,
/// from the handler's fold of the token's Transfer logs; spec §3.6's pending Reopens (Task 10b); and I-32's run-time
/// half, the fixed libraries, asserted once in the campaign's setUp (`setBoundary`): code cannot change after deploy,
/// so a check after every step would repeat one fact thousands of times (ruling DB9). Each campaign deploys through
/// CampaignFixture and calls `setBoundary` with its handler in its setUp.
abstract contract BoundaryInvariants is LensParityChecks, TokenAccounting {
    /// The full argument cross product runs on every FULL_EVERY-th step (fix round 1's cadence): on the others each
    /// bytes32 view takes the words of its own kind (`wordKinds`).
    uint256 internal constant FULL_EVERY = 8;

    TrackedHandler private _boundaryHandler;
    VaultInternals private _boundaryVault;
    DoorInternals private _boundaryDoor;
    CascadeVaultLens private _boundaryVaultLens;
    CascadeDoorLens private _boundaryDoorLens;

    /// The campaign's handler, its vault and front door (the test-only subclasses) and their lenses; asserts I-32's
    /// run-time half on the vault (LinkedLibraries: the vault's code names the deployed L1 to L4, L3's the deployed
    /// payout math, and each linked address holds that library's deployed code). The handler must be the keeper of
    /// both, as the fixture named it at deploy at its planned slot (CampaignFixture.Slot.Handler): a campaign whose
    /// handler did not land there fails here.
    function setBoundary(
        TrackedHandler handler_,
        VaultInternals vault_,
        DoorInternals door_,
        CascadeVaultLens vaultLens_,
        CascadeDoorLens doorLens_
    ) internal {
        require(address(handler_.vault()) == address(vault_) && address(handler_.fd()) == address(door_), "the handler");
        require(vaultLens_.target() == address(vault_) && doorLens_.target() == address(door_), "the lenses");
        require(
            address(handler_.vaultLens()) == address(vaultLens_) && address(handler_.doorLens()) == address(doorLens_),
            "the handler's lenses"
        );
        require(
            vaultLens_.keeper() == address(handler_) && doorLens_.keeper() == address(handler_),
            "the handler is not the keeper the fixture named: it did not land at its planned slot"
        );
        _boundaryHandler = handler_;
        _boundaryVault = vault_;
        _boundaryDoor = door_;
        _boundaryVaultLens = vaultLens_;
        _boundaryDoorLens = doorLens_;
        LinkedLibraries.assertLinked(address(vault_), LibraryLinks.vaultInternals());
    }

    /// @dev I-33 on the vault lens: every view of its ABI (vaultLensViews(), which the build checks hold to the
    /// lens), over the tuples of the handler's tracked users, hotkeys, batch keys, doors, bridges and scheduled ids
    /// that its argument types take, returns the raw bytes VaultInternals' exposure returns (reverts included), and
    /// the getters the vault keeps (totalSupply, balanceOf, MS_PER_BLOCK) return them too. Each bytes32 view
    /// takes the words of its own kind on most steps and every tracked word on every FULL_EVERY-th (wordKinds).
    function invariant_vaultLensParity() public view {
        string[] memory kept = new string[](3);
        kept[0] = "totalSupply()";
        kept[1] = "balanceOf(address)";
        kept[2] = forwardedViews()[0];
        checkLensParity(
            address(_boundaryVaultLens),
            address(_boundaryVault),
            vaultLensViews(),
            kept,
            _boundarySets(),
            wordKinds(),
            "vault lens"
        );
    }

    /// @dev I-33 on the door lens: every view of its ABI (doorLensViews()) over the same sets returns the raw bytes
    /// DoorInternals' exposure returns, and the getters the front door keeps (keeper, MS_PER_BLOCK) return them
    /// too.
    function invariant_doorLensParity() public view {
        string[] memory kept = new string[](2);
        kept[0] = "keeper()";
        kept[1] = forwardedViews()[0];
        checkLensParity(
            address(_boundaryDoorLens),
            address(_boundaryDoor),
            doorLensViews(),
            kept,
            _boundarySets(),
            wordKinds(),
            "door lens"
        );
    }

    /// @dev I-34: for every account the handler tracks (every one a Transfer ever named among them), its balanceOf is
    /// what the token's Transfer logs moved to it less what they moved from it, and the sum over them is totalSupply,
    /// so no balance sits outside the logs. csTAO is non-transferable: no Transfer between two non-zero accounts
    /// appears.
    function invariant_tokenAccounting() public view {
        _assertTokenAccounting(_boundaryHandler, _boundaryVault);
    }

    /// @dev Spec §3.6 (Task 10b): every pending Reopen-kind activateFrontDoor names a Removed door, one the owner
    /// removed and the guardian has not removed since: the guardian's removal of an owner-removed door makes it
    /// unknown and deletes its pending Reopen, so no Reopen outlives it (a stolen owner key cannot bring a door back
    /// past an honest guardian). Over every item the vault's scheduler ever logged (TrackedHandler's record).
    function invariant_aPendingReopenNamesARemovedDoor() public view {
        TrackedHandler h = _boundaryHandler;
        bytes32[] memory ids = h.vaultScheduled();
        for (uint256 i; i < ids.length; ++i) {
            Item memory it = _boundaryVaultLens.scheduled(ids[i]);
            if (it.readyAt == 0 || it.kind != Kind.Reopen || it.selector != CascadeVault.activateFrontDoor.selector) {
                continue;
            }
            (uint64 chain, address door) = abi.decode(_args(h.scheduledData(ids[i])), (uint64, address));
            assertEq(
                uint8(_boundaryVaultLens.doorState(_boundaryVaultLens.peerId(chain, door))),
                uint8(DoorState.Removed),
                "a pending Reopen names a door that is not Removed"
            );
        }
    }

    /// The words each bytes32 view takes this step. On every FULL_EVERY-th step (a deterministic count of the handler's
    /// steps, never a draw) none: every bytes32 view takes every tracked word, the full cross product. On the others,
    /// each view in the map takes the words of its own kind and the word nothing is stored under; a bytes32 view the
    /// map does not name takes every word, so a view added later is checked in full by construction (DB3).
    function wordKinds() internal view returns (WordKinds memory k) {
        TrackedHandler h = _boundaryHandler;
        if (h.steps() % FULL_EVERY == 0) return k;
        bytes32 nothing = h.NOTHING();
        bytes32[] memory hotkeys = _withNothing(h.trackedWordsOf(TrackedHandler.WordKind.Hotkey), nothing);
        bytes32[] memory peers = _withNothing(h.trackedWordsOf(TrackedHandler.WordKind.Peer), nothing);
        bytes32[] memory keys = _withNothing(h.trackedWordsOf(TrackedHandler.WordKind.BatchKey), nothing);
        bytes32[] memory ids = _withNothing(h.trackedWordsOf(TrackedHandler.WordKind.Scheduled), nothing);
        string[7] memory views = [
            "isHotkey(bytes32)",
            "lastClaimAt(bytes32)",
            "doorState(bytes32)",
            "burnWindows(bytes32)",
            "processed(bytes32)",
            "getPayoutBatch(bytes32)",
            "scheduled(bytes32)"
        ];
        k.views = new string[](views.length);
        k.words = new bytes32[][](views.length);
        for (uint256 i; i < views.length; ++i) {
            k.views[i] = views[i];
        }
        k.words[0] = hotkeys;
        k.words[1] = hotkeys;
        k.words[2] = peers;
        k.words[3] = peers;
        k.words[4] = keys;
        k.words[5] = keys;
        k.words[6] = ids;
    }

    /// `words` and `nothing`, the word nothing is stored under.
    function _withNothing(bytes32[] memory words, bytes32 nothing) private pure returns (bytes32[] memory all) {
        all = new bytes32[](words.length + 1);
        for (uint256 i; i < words.length; ++i) {
            all[i] = words[i];
        }
        all[words.length] = nothing;
    }

    /// `data` without its selector.
    function _args(bytes memory data) internal pure returns (bytes memory args) {
        args = new bytes(data.length - 4);
        for (uint256 i; i < args.length; ++i) {
            args[i] = data[i + 4];
        }
    }

    /// The handler's argument sets, as the parity check takes them.
    function _boundarySets() internal view returns (ParitySets memory s) {
        TrackedHandler h = _boundaryHandler;
        s.words = h.trackedWords();
        s.accounts = h.trackedAccounts();
        (s.chains, s.peers) = h.trackedPeers();
        (s.sourceChains, s.senders, s.messages) = h.trackedMessages();
    }
}
