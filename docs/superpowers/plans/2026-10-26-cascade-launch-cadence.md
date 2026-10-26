# Cascade launch cadence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make batch timing cheap while volume is low and fast when it is high: a keeper rule that closes a batch once its fees cover the bridge fee or once it is 24 hours old, a launch settings profile (1-hour minimum interval, 24-hour payout delay), a 7-day cap on the batch interval in the contract, and site estimates that show the realistic worst case.

**Architecture:** The contract only gains an upper bound on `batchInterval`. The ops tool gains a deployment *cadence* (`test` or `launch`) chosen when a plan is made and stored in the plan, so settings, verify and the keeper all read the cadence from the record (existing records, which have none, are `test`). The keeper's close decision becomes: the contract allows it (`canClose`) AND (the batch is full, OR it is at least `closeMaxWaitS` old, OR its estimated Cascade fees ≥ its bridge fee). `web-config` writes the cadence's max wait so the site's estimates use it.

**Tech Stack:** Solidity 0.8 / Foundry; TypeScript ops tool (viem, vitest); Next.js site (vitest).

**Spec:** The owner's decisions in conversation on 2026-10-26 (recorded in this plan's Global Constraints); v3 design `docs/superpowers/specs/2026-10-26-cascade-v3-design.md` for everything else.

## Global Constraints

- Branch `launch-cadence` in worktree `E:\projects\cascade-launch` (based on `v3` a2b4412). Never touch `E:\projects\cascade` (a live test is running from it).
- Cadence `test` behaves exactly as today: close as soon as `canClose()` (max wait = the batch interval), SETTINGS_V3 values unchanged. Existing records (`ops/deployments/*.json`) keep verifying and running unchanged.
- Cadence `launch`: `batchInterval` 3_600 s; `payoutDelay` 86_400 s; keeper `closeMaxWaitS` 86_400 s; every other value as SETTINGS_V3. Treasury and ownership stay as SETTINGS_V3 for now (a real launch needs its own treasury/timelock decision — out of scope, say so in docs).
- Contract: `MAX_BATCH_INTERVAL = 7 days`; constructor and `setBatchInterval` revert `InvalidParameter()` above it (the error already exists). `0` stays allowed (close any time).
- Fee estimate for a batch (all integer math, USDC 6 decimals): `nDeposits × depositFeeUsdc + totalDeposits(TAO wei) × taoPriceUsdc(per 1e18) × swapFeeBps / 10_000 / 1e18 + feePot(ETH wei) × ethPriceUsdc(per 1e18) / 1e18`. Prices from the front door's TWAP oracle (`usdcValue`) for TAO and from the WETH/USDC pool via the existing quoter path for ETH; fees from the staker (`depositFeeUsdc`, `swapFeeBps`). Bridge fee = the existing close estimate's CCIP fee, in ETH, converted the same way. If any price/fee read fails, the fee rule is "not covered" (the time rule still closes it) — never close early on a guess.
- The fee rule and max wait apply only to batches with at least one entry (empty batches are never closed, as today).
- Commit trailer on every commit:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01QsFviaJn5ejsAa5vHQciyX`

## Review Focus

1. A record made before this change (no cadence field) verifies and runs exactly as before. (Task 2)
2. A failed price or fee read never makes the keeper close a batch early. (Task 3)
3. A batch that is full closes at once regardless of the wait or fees. (Task 3)
4. `setBatchInterval(7 days + 1)` reverts; `7 days` and `0` succeed. (Task 1)
5. The site never shows a 10-minute estimate on a launch-cadence deployment. (Task 4)

---

### Task 1: Cap the batch interval

**Files:** Modify `contracts/src/CascadeFrontDoor.sol`; Test `contracts/test/frontdoor/` (the file holding setter tests — find it).

- [ ] Test: `setBatchInterval(7 days + 1)` reverts `InvalidParameter`; `7 days` and `0` succeed and emit `LimitSet("batchInterval", …)`; deploying with `batchInterval_ = 7 days + 1` reverts `InvalidParameter`.
- [ ] RED; implement `uint64 public constant MAX_BATCH_INTERVAL = 7 days;` and the two checks; GREEN; `forge build --sizes` (front door well under 24,576 B); `forge test`; commit `feat(contracts): cap the batch interval at 7 days`.

### Task 2: Deployment cadence

**Files:** Modify `ops/src/config.ts`, `ops/src/plan.ts`, `ops/src/types.ts`, `ops/src/deploy.ts`, `ops/src/verify.ts`, `ops/src/cli.ts` (wherever a v3 plan is built), `ops/src/webconfig.ts`; Tests next to each.

**Interfaces:**
- Produces: `type Cadence = "test" | "launch"`; `SETTINGS_V3_LAUNCH = { ...SETTINGS_V3, batchInterval: 3_600, payoutDelay: 86_400 }`; `CADENCE = { test: { closeMaxWaitS: null /* = batchInterval */ }, launch: { closeMaxWaitS: 86_400 } }`; `PlanV3.cadence?: Cadence` (absent = "test"); `cadenceOf(plan): Cadence`; `settingsOf(plan)` returns SETTINGS_V3_LAUNCH for launch plans; `closeMaxWaitS(plan): number`.
- The cadence is chosen when a new v3 plan is made: env `OPS_CADENCE=launch` (anything else or unset → test); later commands read it from the record, never from the env.
- `webEnv` writes `NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S=<closeMaxWaitS>` for launch plans only.
- [ ] Tests: a plan made with OPS_CADENCE=launch stores `cadence: "launch"` and its steps use 3_600 / 86_400; the existing `test-2026-10.json`-style v2 and a v3 record without `cadence` verify against SETTINGS_V3 exactly as before (use the existing verify tests' fixtures); verify of a launch record expects the launch values; `webEnv` adds the max-wait line only for launch.
- [ ] RED, implement, GREEN; `pnpm test`, `pnpm typecheck` in ops; commit `feat(ops): a launch cadence stored in the deployment plan`.

### Task 3: Keeper close rule

**Files:** Modify `ops/src/keeper/due.ts`, `ops/src/keeper/state.ts` (read `openBatch()`, `batchInterval`, the staker's fees, prices, the close's CCIP fee), `ops/src/keeper/actions.ts` if the run loop needs the plan's max wait; Test `ops/src/keeper/due.test.ts`, `state.test.ts`.

**Interfaces:**
- Produces: `State.frontDoor` gains `openStart: number; batchInterval: number; full: boolean` and `closeEconomics?: { feesUsdc: bigint; bridgeFeeUsdc: bigint } | null` (null = could not be read); `State.closeMaxWaitS: number`.
- `full = canClose && now < openStart + batchInterval` (the contract allows closing before the interval only when the batch is full).
- `decideNext`: a batch with entries is closable when `canClose && (full || now >= openStart + closeMaxWaitS || (closeEconomics && feesUsdc >= bridgeFeeUsdc))`. When it is not, the reason says which wait applies, e.g. `nothing due: the open batch waits until 14:05 UTC or until its fees cover the bridge fee ($0.31 of $1.42)`.
- [ ] Tests (`decideNext`, pure): test cadence (max wait = interval) closes as soon as canClose; launch: young batch with fees below the bridge fee waits (reason names both conditions); fees ≥ bridge fee closes; age ≥ 24 h closes; `full` closes at once; `closeEconomics: null` never closes early but the 24 h rule still closes; empty batch never closes.
- [ ] Tests (`state`): the fee estimate formula with fixed reads (one deposit of 0.4 TAO at $250, 15 bps, $0.05, pot 0.0001 ETH at $2,300 → 50_000 + 150_000 + 230_000 = 430_000 USDC units); a failed oracle read gives `closeEconomics: null`.
- [ ] RED, implement, GREEN; full ops suite + typecheck; commit `feat(ops): close a batch when its fees cover the bridge or after the cadence's max wait`.

### Task 4: Site estimates use the max wait

**Files:** Modify `web/src/lib/cascade/config.ts` (read `NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S`, written out by name), `web/src/lib/cascade/live.ts` (the three `etaMinutes` sites use `openStart + max(batchInterval, maxWait)`), `web/src/components/app/StakeForm.tsx` (format minutes over 90 as hours and over 36 hours as days, like UnstakeForm's `hoursText`); Tests `config.test.ts`, `live.test.ts`, `stake-form.test.ts`.

- [ ] Tests: no max wait in the env → estimates exactly as today; a max wait of 86_400 → a deposit estimate of about a day (e.g. `etaMinutes` ≥ 1_440 for a batch that just opened) and an unstake estimate including the 24 h payout delay; the formatter shows "about 27 minutes", "about 3 hours", "about 1 day".
- [ ] RED, implement, GREEN; web test/typecheck/lint/build; commit `feat(web): estimates use the deployment's batch max wait`.

### Task 5: Docs

- [ ] `contracts/README.md`: the batch-interval cap; checklist item 33 updated (launch cadence exists: `OPS_CADENCE=launch`; still to decide before real users: treasury, timelock owner, caps); `docs/runbook-test-run.md`: a short "Launch cadence" note (what changes, how the keeper decides, how to shorten the interval later with `setBatchInterval`); `docs/architecture.md`: one paragraph on the close rule. Run all suites; commit `docs: launch cadence`.
