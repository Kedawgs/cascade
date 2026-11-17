// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CascadeBase} from "../../src/CascadeBase.sol";
import {GovernanceFixture} from "../governance/GovernanceFixture.sol";
import {BoundaryInvariants} from "./BoundaryInvariants.sol";
import {GovernanceHandler} from "./handlers/GovernanceHandler.sol";

/// The world Task 39b's two governance campaigns share (the liveness half and the copied-key walk), built as Task
/// 39a's campaign builds its own (Governance.invariants.t.sol's setUp, which stays as it is): GovernanceFixture's two
/// chains and governance parts, the probe known and enabled on both targets before the handler's model is read, the
/// handler wired and funded, and alice's first deposit. A campaign starts the clock, deploys the fixture, creates its
/// handler (a GovernanceHandler subclass) as the next creation, then calls `buildWorld` with it. This base carries no
/// invariant: GovernanceWorld adds BoundaryInvariants, and the liveness file's probe-family contracts, which run one
/// probe each, build on this base alone, so the boundary campaigns run once, probe-free (Task 39b's timing ruling).
abstract contract GovernanceWorldBase is GovernanceFixture {
    Campaign c;
    Governance g;
    address alice = makeAddr("alice");

    /// Everything after the handler's creation (see the contract's notes).
    function buildWorld(GovernanceHandler handler) internal {
        landed(Slot.Handler, address(handler));
        _boundary(handler);
        g = deployGovernance(c);
        // through the fixture's own helpers (7 days), before the handler's model is read: the probe known and enabled
        // on both targets (Task 39a's setUp)
        bytes memory probe = abi.encodeCall(CascadeBase.activateBridge, (address(g.probe)));
        sched(c.vault, probe);
        sched(c.fd, probe);
        execAfter(c.vault, probe);
        execAfter(c.fd, probe);
        handler.wire(
            GovernanceHandler.Wiring({
                tao: c.tao,
                bridge: c.bridge,
                bridge2: g.bridge2,
                probe: g.probe,
                door2: g.door2,
                door3: g.door3,
                guardian2: guardian2,
                owner2: owner2,
                stranger: stranger,
                alice: alice,
                treasury: treasury,
                twap: address(c.twap),
                swapper: address(c.staker),
                ownerKey: ownerKey,
                guardianKey: guardianKey,
                owner2Key: owner2Key,
                strangerKey: strangerKey
            })
        );
        // pays every close's bridge fee
        vm.deal(address(handler), 1_000 ether);
        handler.seedHolder();
    }

    /// The boundary invariants' setUp half (BoundaryInvariants.setBoundary), right after the handler landed: none here.
    function _boundary(GovernanceHandler handler) internal virtual {}

    /// Task 39a's fuzzed actions with its weights (Governance.invariants.t.sol), `extra` slots left at the end for the
    /// campaign's own.
    function governanceSelectors(uint256 extra) internal pure returns (bytes4[] memory s) {
        s = new bytes4[](35 + extra);
        s[0] = GovernanceHandler.schedule.selector;
        s[1] = GovernanceHandler.execute.selector;
        s[2] = GovernanceHandler.directSet.selector;
        s[3] = GovernanceHandler.cancel.selector;
        s[4] = GovernanceHandler.prune.selector;
        s[5] = GovernanceHandler.pause.selector;
        s[6] = GovernanceHandler.unpause.selector;
        s[7] = GovernanceHandler.removeDoor.selector;
        s[8] = GovernanceHandler.disableBridge.selector;
        s[9] = GovernanceHandler.setPrimary.selector;
        s[10] = GovernanceHandler.relayStamp.selector;
        s[11] = GovernanceHandler.selfCall.selector;
        s[12] = GovernanceHandler.acceptOwnership.selector;
        s[13] = GovernanceHandler.queueRedeem.selector;
        s[14] = GovernanceHandler.processPayouts.selector;
        s[15] = GovernanceHandler.cancelBatch.selector;
        s[16] = GovernanceHandler.warp.selector;
        s[17] = GovernanceHandler.restore.selector;
        s[18] = GovernanceHandler.schedule.selector;
        s[19] = GovernanceHandler.schedule.selector;
        s[20] = GovernanceHandler.execute.selector;
        s[21] = GovernanceHandler.execute.selector;
        s[22] = GovernanceHandler.directSet.selector;
        s[23] = GovernanceHandler.restore.selector;
        s[24] = GovernanceHandler.queueRedeem.selector;
        s[25] = GovernanceHandler.restore.selector;
        s[26] = GovernanceHandler.processPayouts.selector;
        s[27] = GovernanceHandler.removeDoor.selector;
        s[28] = GovernanceHandler.loneLoosening.selector;
        s[29] = GovernanceHandler.loneLoosening.selector;
        s[30] = GovernanceHandler.loneLoosening.selector;
        s[31] = GovernanceHandler.loneLoosening.selector;
        s[32] = GovernanceHandler.pastABound.selector;
        s[33] = GovernanceHandler.pastABound.selector;
        // Revision 28's window in blocks, directed (the review's M-2)
        s[34] = GovernanceHandler.haltPastTheWindow.selector;
    }

    /// A seed whose draw under `salt`, mod `n`, is `want` (the handlers draw by a hash).
    function _seed(bytes32 salt, uint256 n, uint256 want) internal pure returns (uint256 s) {
        while (uint256(keccak256(abi.encode(s, salt))) % n != want) ++s;
    }
}

/// GovernanceWorldBase with the boundary invariants every Phase 8 campaign inherits (lens parity, token accounting,
/// the pending Reopens after every step; the fixed libraries in the setUp): the copied-key walk's world, and the
/// liveness file's probe-free campaign's.
abstract contract GovernanceWorld is GovernanceWorldBase, BoundaryInvariants {
    function _boundary(GovernanceHandler handler) internal virtual override {
        setBoundary(handler, c.vault, c.fd, c.vaultLens, c.doorLens);
    }
}
