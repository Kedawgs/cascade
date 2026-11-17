// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IAlphaVault} from "../../src/interfaces/IAlphaVault.sol";

/// @notice An AlphaVault whose code answers the Bittensor adapter's three rail reads (isPaused, migrationReadyAt,
/// migrationFinished: R4 S-H1) healthily (false, 0, false), but one of them (`which`, 0 to 2) in a broken way: as a
/// missing getter answered by a fallback with empty data, with one byte, with a revert, by burning all its gas, or by
/// burning `burn` gas and then answering healthily. Etched over the fixture's AlphaVault for the R4 review's tests of
/// canSendPayouts, which must read every broken answer as false and never revert.
contract BrokenRailAlphaVault {
    enum Answer {
        Missing,
        Short,
        Reverts,
        BurnsAll,
        Burns
    }

    uint256 public immutable which;
    Answer public immutable answer;
    uint256 public immutable burn;

    constructor(uint256 which_, Answer answer_, uint256 burn_) {
        which = which_;
        answer = answer_;
        burn = burn_;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        bytes4 sig = msg.sig;
        uint256 k = sig == IAlphaVault.isPaused.selector
            ? 0
            : sig == IAlphaVault.migrationReadyAt.selector ? 1 : sig == IAlphaVault.migrationFinished.selector ? 2 : 3;
        if (k != which) return abi.encode(uint256(0));
        if (answer == Answer.Missing) return "";
        if (answer == Answer.Short) return hex"00";
        if (answer == Answer.Reverts) revert("broken rail read");
        if (answer == Answer.BurnsAll) {
            while (true) {}
        }
        uint256 start = gasleft();
        while (start - gasleft() < burn) {}
        return abi.encode(uint256(0));
    }
}
