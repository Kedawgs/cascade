// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";

/// @notice Ruling B9 (Phase 8, Task 42): every campaign's named rare states must be reached a minimum number of times
/// in the long runs. Each invariant file names its states and their minimums (`_hits`); this base adds each run's
/// counts to campaign totals and, in a long run only, asserts the minimums.
///
/// How the totals survive the runs. Forge resets the EVM state between runs, so the handler's counters are per run.
/// `afterInvariant` (forge calls it at the end of every run of every campaign of the contract) adds the run's counters
/// to totals kept as environment variables of the forge process (`vm.setEnv`), which no state reset touches. The totals
/// are per test contract (its `_hitTag`), summed over all of its campaigns: every campaign of a contract runs the same
/// handler and selectors, so the sum over N runs, whichever campaigns ran them, reaches each state as one campaign of N
/// runs would. A run that forge re-plays (the last run's replay for its logs, a shrink) counts again: only ever more.
///
/// The mechanism that turns the assertion on: the environment variable `CASCADE_MIN_HITS_RUNS`. Unset or 0 (every
/// ordinary run, the default 128 x 64 included), nothing is asserted, so no ordinary run is flaky. Set to R (part 2's
/// long run sets it to 3000 beside FOUNDRY_INVARIANT_RUNS=3000), the first `afterInvariant` that finds the contract's
/// total runs at R or more asserts every named state's total against its minimum, once. Each minimum is set for R =
/// 3000 runs at depth 64 by the controller's rule of 2026-11-12: a quarter of what the SLOWEST of three 128 x 64 seed
/// runs projects for 3,000 runs (its total x 3,000 / its runs counted), and 0 (logged, not asserted) when that
/// projection is under 8, so a 3000 x 64 run meets it with room. Task 42's fix round re-derived every file's on that
/// rule and checked each against the realised totals of the first long run (8d05725, seed 20261113). A shortfall fails
/// that campaign, and every later `afterInvariant` of the contract fails at once with the same message, so the other
/// campaigns fail fast and each shrink ends in a few replays, not thousands.
///
/// The seed sweep (one forge process per seed) starts each process at zero; it asserts nothing unless it sets the
/// variable itself.
///
/// What it does not do (the Task 42 review's Minor 7). The read, add and write of a total is not atomic across a
/// contract's campaigns, which forge runs in parallel: two campaigns ending together can each read the same total and
/// one write is lost, so a total can only come out short (a long run's check stricter, never looser). A file's reach
/// log prints the totals as of that campaign's end, not the whole run's. Nothing fails when a contract's campaigns
/// never reach R counted runs together (the check never fires): part 2 checks every tag's `B9 <tag> runs counted`
/// against R in its log. The three contracts of GovernanceLiveness.invariants.t.sol name no states (their probes' reach
/// is logged only).
abstract contract MinimumHits is Test {
    /// A named state: its handler counter's value in this run, and the minimum its total must reach in a long run.
    struct Hit {
        string name;
        uint256 value;
        uint256 minimum;
    }

    /// The environment variable that turns the minimums on (see the contract's notes).
    string internal constant LONG_RUN_ENV = "CASCADE_MIN_HITS_RUNS";

    /// The test contract's key for its totals: unique per contract, letters and digits only.
    function _hitTag() internal pure virtual returns (string memory);

    /// This run's counters for the contract's named states, with their minimums.
    function _hits() internal view virtual returns (Hit[] memory);

    /// The number of runs at which the minimums are asserted (0: never). A test of this base overrides it.
    function _longRunAt() internal view virtual returns (uint256) {
        return vm.envOr(LONG_RUN_ENV, uint256(0));
    }

    /// Adds this run's counts to the totals; in a long run, asserts the minimums once the totals cover enough runs.
    function afterInvariant() public virtual {
        string memory tag = _hitTag();
        string memory failed = vm.envOr(_hitKey(tag, "FAILED"), string(""));
        if (bytes(failed).length != 0) revert(failed);
        uint256 runs = vm.envOr(_hitKey(tag, "RUNS"), uint256(0)) + 1;
        vm.setEnv(_hitKey(tag, "RUNS"), vm.toString(runs));
        Hit[] memory h = _hits();
        for (uint256 i; i < h.length; ++i) {
            string memory key = _hitKey(tag, h[i].name);
            vm.setEnv(key, vm.toString(vm.envOr(key, uint256(0)) + h[i].value));
        }
        uint256 due = _longRunAt();
        if (due == 0 || runs < due || vm.envOr(_hitKey(tag, "CHECKED"), uint256(0)) != 0) return;
        vm.setEnv(_hitKey(tag, "CHECKED"), "1");
        string memory shortfalls;
        for (uint256 i; i < h.length; ++i) {
            uint256 total = hitTotal(h[i].name);
            if (total < h[i].minimum) {
                shortfalls = string.concat(
                    shortfalls, " ", h[i].name, " ", vm.toString(total), " < ", vm.toString(h[i].minimum), ";"
                );
            }
        }
        if (bytes(shortfalls).length == 0) return;
        string memory message =
            string.concat("B9 minimum hits not met after ", vm.toString(runs), " runs (", tag, "):", shortfalls);
        vm.setEnv(_hitKey(tag, "FAILED"), message);
        revert(message);
    }

    /// A named state's campaign total so far (this process, this contract), and the runs counted.
    function hitTotal(string memory name) public view returns (uint256) {
        return vm.envOr(_hitKey(_hitTag(), name), uint256(0));
    }

    function hitRuns() public view returns (uint256) {
        return vm.envOr(_hitKey(_hitTag(), "RUNS"), uint256(0));
    }

    /// Logs every named state's campaign total beside the runs counted (each file's reach log calls it).
    function _logHitTotals() internal {
        string memory tag = _hitTag();
        emit log_named_uint(string.concat("B9 ", tag, " runs counted"), hitRuns());
        Hit[] memory h = _hits();
        for (uint256 i; i < h.length; ++i) {
            emit log_named_uint(
                string.concat("B9 ", tag, " total ", h[i].name, " (min ", vm.toString(h[i].minimum), ")"),
                hitTotal(h[i].name)
            );
        }
    }

    function _hitKey(string memory tag, string memory name) internal pure returns (string memory) {
        return string.concat("CASCADE_HITS_", tag, "_", name);
    }
}
