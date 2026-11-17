// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";

// The views each lens serves, and the parity check that calls each of them (I-33). Each list names
// every view of its lens but `target()`, as "name(argument types)"; script/lens-surface.mjs fails the
// build checks unless a list equals its lens's ABI, so a view added to a lens without a parity check,
// or listed here without a lens view, is caught at build time (ruling DB3b).

/// Every view of CascadeVaultLens but target().
function vaultLensViews() pure returns (string[] memory views) {
    string[93] memory v = [
        // constants and the derived coldkey
        "ADDRESS_MAPPING()",
        "DIRECT_ORIGIN()",
        "ED_RESERVE()",
        "EXECUTE_WINDOW()",
        "EXIT_GAS_RESERVE()",
        "FALLBACK_MIN_STAKE_RAO()",
        "FALLBACK_MIN_REMAIN_RAO()",
        "GUARDIAN_DELAY()",
        "KEEPER_FALLBACK()",
        "MAX_CLAIM_GAS()",
        "MAX_REWARD_CUT_BPS()",
        "MIN_CLAIM_GAS()",
        "PARAM_DELAY()",
        "RAO()",
        "REGISTRY_DELAY()",
        "STAKING()",
        "coldkey()",
        // CascadeBase
        "STAMP_TYPEHASH()",
        "STAMP_MAX_TTL()",
        "DOMAIN_SEPARATOR()",
        "MS_PER_BLOCK()",
        "guardian()",
        "bridgeEnabled(address)",
        "primaryBridge()",
        "scheduled(bytes32)",
        "bridgeKnown(address)",
        "lastOwnerClose()",
        "lastGuardianClose()",
        "primaryDisabledBy()",
        "pendingSince()",
        "ownerHold()",
        "guardianHold()",
        "exitsOpen()",
        // the share token
        "totalSupply()",
        "balanceOf(address)",
        // hotkeys and the keeper
        "hotkeys(uint256)",
        "hotkeyCount()",
        "isHotkey(bytes32)",
        "stakeHotkey()",
        "lastClaimAt(bytes32)",
        "keeper()",
        "lastStakeAt()",
        // accounting and the reward cut
        "pendingPayouts()",
        "rampingStake()",
        "vestingAmount()",
        "vestingStart()",
        "vestingPeriod()",
        "lastAdoptAt()",
        "adoptVestingAmount()",
        "adoptVestingStart()",
        "adoptVestingPeriod()",
        "treasury()",
        "rewardCutBps()",
        // front doors, direct users, batches
        "doorState(bytes32)",
        "activeDoors(uint64)",
        "redeemOrigin(address)",
        "freshShares(address)",
        "peerId(uint64,address)",
        "processed(bytes32)",
        "getPayoutBatch(bytes32)",
        "burnWindows(bytes32)",
        "batchKey(uint64,address,bytes)",
        // the vault's exits machine: its two holds
        "pausedBy()",
        "launchDoorRemovedBy()",
        // parameters
        "minChunk()",
        "payoutDelay()",
        "rewardVesting()",
        "maxDailyOutflowBps()",
        "minDailyOutflow()",
        "globalOutflowBps()",
        "maxEntryValue()",
        "maxMessageValue()",
        "maxFeeBps()",
        "maxFeeAbs()",
        "maxTotalAssets()",
        "minDirectDeposit()",
        "hotkeyDustRao()",
        "claimGasRequired()",
        "unstakeMarginRao()",
        "unstakeGas()",
        "idleBufferBps()",
        // the computed views
        "visibleStakeRao()",
        "bookedStake()",
        "missingStakeRao()",
        "surplusStakeRao()",
        "stakeMissing()",
        "unlistedStakeRao()",
        "grossAssets()",
        "unvestedRewards()",
        "totalAssets()",
        "price()",
        "minStakeRao()",
        "minRemainRao()"
    ];
    views = new string[](v.length);
    for (uint256 i; i < v.length; ++i) {
        views[i] = v[i];
    }
}

/// The lens views their targets keep too (R1-A L-3): MS_PER_BLOCK, an immutable, which extsload cannot
/// read, so each lens asks its target's own getter (script/lens-surface.mjs's FORWARDED).
function forwardedViews() pure returns (string[] memory views) {
    views = new string[](1);
    views[0] = "MS_PER_BLOCK()";
}

/// The vault lens's views the vault no longer has (spec §8.1, Task 5d-2): every one but the share
/// token's totalSupply and balanceOf, which the vault keeps for wallets and explorers, and the forwarded
/// MS_PER_BLOCK. It includes CascadeBase's (gone since Task 5d-1) and the trimmed price and
/// hotkeyCount. The parity check asserts each one is gone from the vault; script/lens-surface.mjs fails the
/// build checks if the vault has any view but its kept list.
function vaultMovedViews() pure returns (string[] memory gone) {
    string[] memory all = vaultLensViews();
    gone = new string[](all.length - 3);
    uint256 n;
    for (uint256 i; i < all.length; ++i) {
        bytes32 h = keccak256(bytes(all[i]));
        if (h == keccak256("totalSupply()") || h == keccak256("balanceOf(address)")) continue;
        if (h == keccak256("MS_PER_BLOCK()")) continue;
        gone[n++] = all[i];
    }
    require(n == gone.length, "vaultLensViews() lacks totalSupply(), balanceOf(address) or MS_PER_BLOCK()");
}

/// CascadeBaseLens's views neither target has (Task 5d-1): every one but the forwarded MS_PER_BLOCK.
function baseMovedViews() pure returns (string[] memory gone) {
    string[] memory all = baseLensViews();
    gone = new string[](all.length - 1);
    uint256 n;
    for (uint256 i; i < all.length; ++i) {
        if (keccak256(bytes(all[i])) == keccak256("MS_PER_BLOCK()")) continue;
        gone[n++] = all[i];
    }
    require(n == gone.length, "baseLensViews() lacks MS_PER_BLOCK()");
}

/// The views CascadeBaseLens serves for CascadeBase, on both lenses: since Task 5d-1 neither the vault
/// nor the front door has these getters (spec §8.1), but the forwarded MS_PER_BLOCK, so the parity
/// check asserts each other one is gone from its target (baseMovedViews). script/lens-surface.mjs fails
/// the build checks unless this list equals CascadeBaseLens's views, less target().
function baseLensViews() pure returns (string[] memory views) {
    string[20] memory v = [
        "PARAM_DELAY()",
        "REGISTRY_DELAY()",
        "GUARDIAN_DELAY()",
        "EXECUTE_WINDOW()",
        "STAMP_TYPEHASH()",
        "STAMP_MAX_TTL()",
        "DOMAIN_SEPARATOR()",
        "MS_PER_BLOCK()",
        "guardian()",
        "bridgeEnabled(address)",
        "primaryBridge()",
        "scheduled(bytes32)",
        "bridgeKnown(address)",
        "lastOwnerClose()",
        "lastGuardianClose()",
        "primaryDisabledBy()",
        "pendingSince()",
        "ownerHold()",
        "guardianHold()",
        "exitsOpen()"
    ];
    views = new string[](v.length);
    for (uint256 i; i < v.length; ++i) {
        views[i] = v[i];
    }
}

/// Every view of CascadeDoorLens but target(): CascadeBase's, and the front door's keeper.
function doorLensViews() pure returns (string[] memory views) {
    string[21] memory v = [
        "PARAM_DELAY()",
        "REGISTRY_DELAY()",
        "GUARDIAN_DELAY()",
        "EXECUTE_WINDOW()",
        "STAMP_TYPEHASH()",
        "STAMP_MAX_TTL()",
        "DOMAIN_SEPARATOR()",
        "MS_PER_BLOCK()",
        "guardian()",
        "bridgeEnabled(address)",
        "primaryBridge()",
        "scheduled(bytes32)",
        "bridgeKnown(address)",
        "lastOwnerClose()",
        "lastGuardianClose()",
        "primaryDisabledBy()",
        "pendingSince()",
        "ownerHold()",
        "guardianHold()",
        "exitsOpen()",
        "keeper()"
    ];
    views = new string[](v.length);
    for (uint256 i; i < v.length; ++i) {
        views[i] = v[i];
    }
}

/// The argument sets a parity check calls each view with, by argument type (see argumentsFor): the tests'
/// tracked ones (LensParityChecks.trackedSets), or an invariant campaign's handler's (BoundaryInvariants).
struct ParitySets {
    bytes32[] words;
    address[] accounts;
    uint64[] chains;
    address[] peers;
    uint64[] sourceChains;
    address[] senders;
    bytes[] messages;
}

/// The words some bytes32 views take instead of every tracked word (BoundaryInvariants' kind-sorted steps): views[i]
/// takes words[i]. A bytes32 view not named here takes every word of the sets, so a view added later is checked in
/// full; empty lists, the full cross product.
struct WordKinds {
    string[] views;
    bytes32[][] words;
}

/// The lens parity check (I-33): every view of a lens, over the tracked arguments, returns the same
/// bytes as `exposed_<view>` on the target's test-only subclass (VaultInternals, DoorInternals), which
/// reads the value inside the target, and, where the target still has the getter (the vault's
/// totalSupply and balanceOf, the front door's keeper), as that getter.
/// A revert must match too, data included: a lens view reverts exactly when the target does.
abstract contract LensParityChecks is Test {
    /// Indices tried on a view that takes one (hotkeys): 0 up to this bound, past the end of any set
    /// (the vault holds at most four hotkeys), so the reverts past the end are compared too (DA6).
    uint256 internal constant INDEX_BOUND = 6;

    /// The bytes32 arguments: hotkeys, peer ids, batch keys, and values nothing is stored under.
    bytes32[] internal trackedWords;
    /// The address arguments: users, roles, bridges, front doors, and the zero address.
    address[] internal trackedAccounts;
    /// The (chain, address) arguments, pairwise; the chains alone are the (uint64) arguments (activeDoors).
    uint64[] internal trackedChains;
    address[] internal trackedPeers;
    /// The (chain, sender, message) arguments, by index.
    uint64[] internal trackedSourceChains;
    address[] internal trackedSenders;
    bytes[] internal trackedMessages;

    function trackWord(bytes32 w) internal {
        trackedWords.push(w);
    }

    function trackAccount(address a) internal {
        trackedAccounts.push(a);
    }

    function trackPeer(uint64 chain, address addr) internal {
        trackedChains.push(chain);
        trackedPeers.push(addr);
    }

    function trackMessage(uint64 sourceChain, address sender, bytes memory message) internal {
        trackedSourceChains.push(sourceChain);
        trackedSenders.push(sender);
        trackedMessages.push(message);
    }

    /// Asserts lens parity for each of `views` (see the contract's comment). Every view not in `gone`
    /// is also compared with the target's own getter of the same name. Each view in `gone` is one the
    /// target no longer has (internal since Task 5d, spec §8.1; vaultMovedViews() on the vault,
    /// baseLensViews() on the front door): its selector must revert on the
    /// target, with no data (neither target has a fallback), for every argument tuple. Each view must
    /// answer at least once: a misspelt view would revert alike on both sides.
    function assertLensParity(
        address lens,
        address internals,
        string[] memory views,
        string[] memory gone,
        string memory label
    ) internal view {
        for (uint256 v; v < views.length; ++v) {
            string memory view_ = views[v];
            bool isGone = listed(view_, gone);
            bytes[] memory args = argumentsFor(view_);
            uint256 answered;
            for (uint256 a; a < args.length; ++a) {
                string memory where = string.concat(label, ": ", view_, " #", vm.toString(a));
                if (assertCallParity(lens, internals, view_, args[a], isGone, where)) ++answered;
            }
            assertGt(answered, 0, string.concat(label, ": ", view_, " never answered"));
        }
    }

    /// One call of `view_` with the encoded arguments `args`: the lens against `exposed_<view_>` and,
    /// unless `isGone`, against the target's getter; when `isGone`, the target's getter must be absent.
    /// Returns whether the lens answered.
    function assertCallParity(
        address lens,
        address internals,
        string memory view_,
        bytes memory args,
        bool isGone,
        string memory where
    ) private view returns (bool ok) {
        bytes4 selector = bytes4(keccak256(bytes(view_)));
        bytes memory out;
        (ok, out) = lens.staticcall(abi.encodePacked(selector, args));
        (bool okI, bytes memory outI) =
            internals.staticcall(abi.encodePacked(bytes4(keccak256(bytes(string.concat("exposed_", view_)))), args));
        assertEq(ok, okI, string.concat(where, " (reverts on one side only, vs exposed_)"));
        assertEq(out, outI, string.concat(where, " (vs exposed_)"));
        (bool okG, bytes memory outG) = internals.staticcall(abi.encodePacked(selector, args));
        if (isGone) {
            assertFalse(okG, string.concat(where, " (the target still has the getter)"));
            assertEq(outG.length, 0, string.concat(where, " (the target's call reverted with data)"));
        } else {
            assertEq(ok, okG, string.concat(where, " (reverts on one side only, vs the getter)"));
            assertEq(out, outG, string.concat(where, " (vs the getter)"));
        }
    }

    /// Whether `target` answers a static call of `signature` ("name(types)", static argument types
    /// only) with every argument zero: a getter the target has answers, one it lacks reverts.
    function answers(address target, string memory signature) internal view returns (bool ok) {
        bytes memory types = bytes(argumentTypes(signature));
        uint256 n = types.length > 2 ? 1 : 0;
        for (uint256 i; i < types.length; ++i) {
            if (types[i] == ",") ++n;
        }
        (ok,) = target.staticcall(abi.encodePacked(bytes4(keccak256(bytes(signature))), new bytes(32 * n)));
    }

    /// Whether `view_` is one of `list`.
    function listed(string memory view_, string[] memory list) internal pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (keccak256(bytes(view_)) == keccak256(bytes(list[i]))) return true;
        }
        return false;
    }

    /// Every argument tuple `view_` is called with, ABI-encoded, chosen by its argument types, from the tracked
    /// sets.
    function argumentsFor(string memory view_) internal view returns (bytes[] memory) {
        return argumentsFor(view_, trackedSets());
    }

    /// The tracked sets, as one value.
    function trackedSets() internal view returns (ParitySets memory) {
        return ParitySets(
            trackedWords,
            trackedAccounts,
            trackedChains,
            trackedPeers,
            trackedSourceChains,
            trackedSenders,
            trackedMessages
        );
    }

    /// Every argument tuple `view_` is called with, ABI-encoded, chosen by its argument types, from `s`.
    function argumentsFor(string memory view_, ParitySets memory s) internal pure returns (bytes[] memory args) {
        bytes32 types = keccak256(bytes(argumentTypes(view_)));
        if (types == keccak256("()")) {
            args = new bytes[](1);
        } else if (types == keccak256("(uint256)")) {
            args = new bytes[](INDEX_BOUND + 1);
            for (uint256 i; i <= INDEX_BOUND; ++i) {
                args[i] = abi.encode(i);
            }
        } else if (types == keccak256("(bytes32)")) {
            args = new bytes[](s.words.length);
            for (uint256 i; i < s.words.length; ++i) {
                args[i] = abi.encode(s.words[i]);
            }
        } else if (types == keccak256("(address)")) {
            args = new bytes[](s.accounts.length);
            for (uint256 i; i < s.accounts.length; ++i) {
                args[i] = abi.encode(s.accounts[i]);
            }
        } else if (types == keccak256("(uint64)")) {
            args = new bytes[](s.chains.length);
            for (uint256 i; i < s.chains.length; ++i) {
                args[i] = abi.encode(s.chains[i]);
            }
        } else if (types == keccak256("(uint64,address)")) {
            args = new bytes[](s.chains.length);
            for (uint256 i; i < s.chains.length; ++i) {
                args[i] = abi.encode(s.chains[i], s.peers[i]);
            }
        } else if (types == keccak256("(uint64,address,bytes)")) {
            args = new bytes[](s.messages.length);
            for (uint256 i; i < s.messages.length; ++i) {
                args[i] = abi.encode(s.sourceChains[i], s.senders[i], s.messages[i]);
            }
        } else {
            revert(string.concat("no tracked arguments for ", view_));
        }
    }

    /// I-33 after a campaign's step (BoundaryInvariants): every one of `views` (a lens's whole ABI less target(), as
    /// vaultLensViews() or doorLensViews() lists it, which script/lens-surface.mjs holds to the lens's ABI), over every
    /// tuple of `sets` its argument types take (a bytes32 view that `kinds` names, over its own words instead),
    /// returns from `lens` exactly the bytes `exposed_<view>` returns from `internals`, a revert and its data
    /// included; each of `kept`, the getters the target keeps, matches the target's own getter too; and every view
    /// answers at least once. The label is built only for a difference, which fails the check with it.
    function checkLensParity(
        address lens,
        address internals,
        string[] memory views,
        string[] memory kept,
        ParitySets memory sets,
        WordKinds memory kinds,
        string memory label
    ) internal view {
        bytes32[] memory everyWord = sets.words;
        for (uint256 v; v < views.length; ++v) {
            string memory view_ = views[v];
            sets.words = wordsFor(view_, kinds, everyWord);
            if (!answersAlike(lens, internals, view_, argumentsFor(view_, sets), listed(view_, kept), label)) {
                revert(string.concat(label, ": ", view_, " never answered"));
            }
        }
    }

    /// The words bytes32 view `view_` takes: its own, when `kinds` names it, else `everyWord`.
    function wordsFor(string memory view_, WordKinds memory kinds, bytes32[] memory everyWord)
        internal
        pure
        returns (bytes32[] memory)
    {
        for (uint256 k; k < kinds.views.length; ++k) {
            if (keccak256(bytes(kinds.views[k])) == keccak256(bytes(view_))) return kinds.words[k];
        }
        return everyWord;
    }

    /// One view's calls in checkLensParity: `lens` against `exposed_<view_>` on `internals` (and, when `isKept`,
    /// against the target's own getter) for each of `args`; returns whether the lens answered any.
    function answersAlike(
        address lens,
        address internals,
        string memory view_,
        bytes[] memory args,
        bool isKept,
        string memory label
    ) internal view returns (bool answered) {
        bytes4 selector = bytes4(keccak256(bytes(view_)));
        bytes4 exposed = bytes4(keccak256(bytes(string.concat("exposed_", view_))));
        for (uint256 a; a < args.length; ++a) {
            (bool ok, bytes memory out) = lens.staticcall(abi.encodePacked(selector, args[a]));
            (bool okI, bytes memory outI) = internals.staticcall(abi.encodePacked(exposed, args[a]));
            if (ok != okI || keccak256(out) != keccak256(outI)) {
                revert(string.concat(label, ": ", view_, " #", vm.toString(a), " differs from exposed_", view_));
            }
            if (isKept) {
                (bool okG, bytes memory outG) = internals.staticcall(abi.encodePacked(selector, args[a]));
                if (ok != okG || keccak256(out) != keccak256(outG)) {
                    revert(string.concat(label, ": ", view_, " #", vm.toString(a), " differs from the getter"));
                }
            }
            answered = answered || ok;
        }
    }

    /// "(bytes32)" for "isHotkey(bytes32)".
    function argumentTypes(string memory view_) internal pure returns (string memory) {
        bytes memory b = bytes(view_);
        uint256 open;
        while (open < b.length && b[open] != "(") {
            ++open;
        }
        bytes memory types = new bytes(b.length - open);
        for (uint256 i; i < types.length; ++i) {
            types[i] = b[open + i];
        }
        return string(types);
    }
}
