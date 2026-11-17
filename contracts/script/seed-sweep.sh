#!/usr/bin/env bash
# The invariant seed sweep (Task 42, the plan's Step 3; the Task 35 carry: a fixed seed per run, so a failure
# reproduces). Runs the invariant suite once per seed, through --fuzz-seed, one forge at a time, at the runs and depth
# given, under the whole-suite profile (parity), and writes for each seed its full output, its result and the named
# states' campaign totals (each file's reach log, ruling B9) to the log directory, with one summary line a seed in
# sweep.log there. Each seed saves and replays its fuzz and invariant failures in a folder of its own beside its log
# (failures-seed-N/, through FOUNDRY_INVARIANT_FAILURE_PERSIST_DIR and FOUNDRY_FUZZ_FAILURE_PERSIST_DIR, which forge
# 1.7 honours): one seed's failure never replays in a later seed, which would count it again and take that campaign's
# runs from exploring (the Task 42 review's Minor 8). Forge's own saved failures in cache/ are neither read nor touched:
# it never forces a build (a forced build removes them). It stops nothing: a seed that fails is recorded and the next
# one runs; it starts and ends no other process. Run from contracts/:
#
#   script/seed-sweep.sh RUNS DEPTH LOG_DIR SEED [SEED ...]
#   script/seed-sweep.sh RUNS DEPTH LOG_DIR --seeds-file FILE      (one seed a line; # comments and blank lines skipped)
#
# Environment: FORGE (the forge binary, default `forge`), CASCADE_MIN_HITS_RUNS (passed through: set it to assert the
# minimum hits in each seed's run, MinimumHits.sol; unset, nothing is asserted). Exit status: 0 when every seed passed,
# 1 when any failed, 2 on a usage error.
set -u

usage() {
  echo "usage: $0 RUNS DEPTH LOG_DIR SEED [SEED ...] | $0 RUNS DEPTH LOG_DIR --seeds-file FILE" >&2
  exit 2
}

[ $# -ge 4 ] || usage
RUNS=$1
DEPTH=$2
LOG_DIR=$3
shift 3
case "$RUNS$DEPTH" in *[!0-9]*) echo "RUNS and DEPTH must be whole numbers" >&2; usage ;; esac

SEEDS=()
if [ "$1" = "--seeds-file" ]; then
  [ $# -eq 2 ] && [ -f "$2" ] || usage
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%%#*}
    line=$(echo "$line" | tr -d '[:space:]')
    [ -n "$line" ] && SEEDS+=("$line")
  done <"$2"
else
  SEEDS=("$@")
fi
[ ${#SEEDS[@]} -ge 1 ] || usage

FORGE=${FORGE:-forge}
[ -f foundry.toml ] || { echo "run from contracts/ (no foundry.toml here)" >&2; exit 2; }
mkdir -p "$LOG_DIR"
SUMMARY="$LOG_DIR/sweep.log"
echo "# seed sweep $(date -u +%Y-%m-%dT%H:%M:%SZ): runs $RUNS, depth $DEPTH, ${#SEEDS[@]} seeds; CASCADE_MIN_HITS_RUNS=${CASCADE_MIN_HITS_RUNS:-unset}" >>"$SUMMARY"

failed=0
for seed in "${SEEDS[@]}"; do
  out="$LOG_DIR/seed-$seed.log"
  persist="$LOG_DIR/failures-seed-$seed"
  start=$(date +%s)
  FOUNDRY_PROFILE=parity FOUNDRY_INVARIANT_RUNS="$RUNS" FOUNDRY_INVARIANT_DEPTH="$DEPTH" \
    FOUNDRY_INVARIANT_FAILURE_PERSIST_DIR="$persist/invariant" FOUNDRY_FUZZ_FAILURE_PERSIST_DIR="$persist/fuzz" \
    "$FORGE" test --match-path "test/invariants/*" --fuzz-seed "$seed" -vv >"$out" 2>&1
  status=$?
  secs=$(( $(date +%s) - start ))
  # the result: forge's last summary line, and each failing test
  result=$(grep -E '^Ran [0-9]+ test suites' "$out" | tail -1)
  fails=$(grep -cE '^\[FAIL' "$out")
  if [ "$status" -ne 0 ] || [ "$fails" -ne 0 ]; then
    failed=1
    verdict=FAIL
  else
    verdict=PASS
  fi
  echo "seed $seed: $verdict, exit $status, $fails failing, ${secs}s: ${result:-no summary line}" >>"$SUMMARY"
  grep -E '^\[FAIL' "$out" | sed "s/^/  seed $seed: /" >>"$SUMMARY"
  # the named states' campaign totals (each file's reach log ends with them), for this seed
  grep -E 'B9 [a-z0-9]+ (runs counted|total )' "$out" >"$LOG_DIR/seed-$seed.hits"
  # what this seed saved is already in its own folder, kept (a passing seed leaves it absent)
  echo "seed $seed: $verdict (${secs}s)"
done
echo "# done: $([ $failed -eq 0 ] && echo 'every seed passed' || echo 'some seeds failed')" >>"$SUMMARY"
exit $failed
