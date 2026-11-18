import { env } from "cloudflare:workers";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { reconcile } from "../../src/alerts.ts";
import { RULES } from "../../src/rules/ids.ts";
import { logQuery } from "../../src/rules/context.ts";
import { adminStampQuiet, batchCancelChurn, batchDepositsBlocked, batchDepositsFull, capExitsConsumed, CLOSE_LAG_READINGS, FULL_UNCLOSED_READINGS, holdBlocks, MIN_REDEEM_VALUE_RAO, payoutBouncesStranded, payoutNoRail, R4_RULES, RAIL_CLOSED_SINCE, railPayoutsClosed, SMALL_LIST_CLOSES, stakeAddFee, stakeMinNearFloor, unstakesWash, WASH_LOOKBACK_S, washBlocks } from "../../src/rules/r4.ts";
import { RUNBOOK } from "../../src/runbook.ts";
import { DEFAULTS, mergeThresholds } from "../../src/thresholds.ts";
import { TICK_RULES } from "../../src/tick.ts";
import type { MessageRow } from "../../src/store.ts";
import { testConfig, testConfigV32 } from "./fixtures.ts";
import { baseState, bitState, reading, ruleCtx, slog } from "./rule-ctx.ts";

// Checkpoint R4's monitor rules (r4o-dispatch.md; r4-A, r4-D, r4-stuck and the coordinator's additions): the stamp bot
// gone quiet (D-L3), a batch that blocks every deposit (A-L1), the deposit cap counting TAO that has left (A-L2), the
// chain's minimum stake near the redeem floor, payouts the rail can't send during a ForeverMoney migration (S-H1), and a
// bounce-only payout queue whose door or bridge is going (S-L4).

const E18 = 10n ** 18n;
const NOW = 1_800_000_000;
const H = 3_600;
const cfg = testConfigV32();
const ctxOf = (o: { base?: ReturnType<typeof baseState>; bit?: ReturnType<typeof bitState>; t?: Partial<typeof DEFAULTS>; pending?: Hex[]; logs?: ReturnType<typeof slog>[]; messages?: MessageRow[]; meta?: Record<string, string> } = {}) =>
  ruleCtx({
    cfg,
    nowS: NOW,
    meta: o.meta ?? {},
    messages: o.messages ?? [],
    t: { ...DEFAULTS, ...(o.t ?? {}) },
    pendingPayoutKeys: o.pending ?? [],
    logs: logQuery(o.logs ?? []),
    snap: {
      at: NOW,
      nonces: { base: {}, bittensor: {} },
      safeNonces: { base: {}, bittensor: {} },
      messageStates: {},
      deliveredReads: [],
      ...(o.base ? { base: reading(37_000_000n, NOW, o.base) } : {}),
      ...(o.bit ? { bittensor: reading(6_900_000n, NOW, o.bit) } : {}),
    },
  });

describe("the R4 rules are registered: each has an id, a tier, a runbook line, and runs every tick", () => {
  it("ids and tiers", () => {
    expect(RULES["admin.stamp_quiet"]).toMatchObject({ tier: "critical", kind: "condition" });
    expect(RULES["batch.deposits_blocked"]).toMatchObject({ tier: "critical", kind: "condition" });
    expect(RULES["cap.exits_consumed"]).toMatchObject({ tier: "warning", kind: "condition" });
    expect(RULES["stake.min_near_floor"]).toMatchObject({ tier: "warning", kind: "condition" });
    expect(RULES["stake.min_at_floor"]).toMatchObject({ tier: "critical", kind: "condition" });
    expect(RULES["rail.payouts_closed"]).toMatchObject({ tier: "critical", kind: "condition" });
    expect(RULES["payout.bounces_stranded"]).toMatchObject({ tier: "critical", kind: "condition" });
    for (const r of [adminStampQuiet, batchDepositsBlocked, capExitsConsumed, stakeMinNearFloor, railPayoutsClosed, payoutBouncesStranded]) expect(TICK_RULES, r.name).toContain(r);
    for (const id of ["admin.stamp_quiet", "batch.deposits_blocked", "cap.exits_consumed", "stake.min_near_floor", "stake.min_at_floor", "rail.payouts_closed", "payout.bounces_stranded"] as const) {
      expect(RUNBOOK[id]({}).length, id).toBeGreaterThan(40);
    }
  });
});

describe("D-L3: admin.stamp_quiet, the stamp bot gone quiet", () => {
  const exits = (lastOwnerClose: number) => ({ open: true, lastOwnerClose });
  it("off by default (stampQuietS 0): the founder switches it on with the bot", () => {
    expect(DEFAULTS.stampQuietS).toBe(0);
    expect(adminStampQuiet.run(ctxOf({ bit: bitState({ exits: exits(NOW - 30 * H) }), base: baseState({ exits: exits(NOW - 30 * H) }) }))).toEqual([]);
  });

  it("with the cadence set (THRESHOLDS stampQuietS), pages a chain whose owner clock (its last stamp) is older; quiet while it is newer", () => {
    expect(mergeThresholds(JSON.stringify({ stampQuietS: 14 * H }), undefined).stampQuietS).toBe(14 * H);
    const t = { stampQuietS: 14 * H };
    expect(adminStampQuiet.run(ctxOf({ t, bit: bitState({ exits: exits(NOW - 13 * H) }), base: baseState({ exits: exits(NOW - 2 * H) }) }))).toEqual([]);
    const f = adminStampQuiet.run(ctxOf({ t, bit: bitState({ exits: exits(NOW - 15 * H) }), base: baseState({ exits: exits(NOW - 2 * H) }) }));
    expect(f.map((x) => [x.rule, x.key, x.subject])).toEqual([["admin.stamp_quiet", "admin.stamp_quiet:bittensor", "No owner stamp has landed on Bittensor for 15 hours"]]);
    expect(f[0].facts).toMatchObject({ "last stamp (the owner's clock)": "2027-01-14 17:00 UTC", "expected within": "14 hours" });
  });

  it("an unread clock is unjudged, never quiet", () => {
    const c = ctxOf({ t: { stampQuietS: 14 * H }, bit: bitState({}), base: baseState({ exits: exits(NOW) }) });
    expect(adminStampQuiet.run(c)).toEqual([]);
    expect(c.unjudged).toContainEqual({ rule: "admin.stamp_quiet", key: "admin.stamp_quiet:bittensor" });
  });
});

describe("A-L1, R7 (L1), R8: batch.deposits_blocked, a batch the front door lets close because it is full, still not closed on seven readings in a row (the store's six and this tick's)", () => {
  const open = (total: bigint, o: { id?: bigint; start?: number; nDeposits?: number } = {}) => ({ id: o.id ?? 9n, start: o.start ?? NOW - 600, totalDeposits: total, feePot: 0n, nDeposits: o.nDeposits ?? 1, nRedeems: 0 });
  // the front door's own canClose() (R6b): true here 10 minutes into an hour's interval, so by its limits, not its clock
  const door = (total: bigint, o: Partial<ReturnType<typeof baseState>> = {}) =>
    baseState({ openBatch: open(total), maxBatchValue: 10n * E18, minDeposit: 4n * 10n ** 16n, maxDeposits: 50, maxRedeems: 50, batchInterval: H, canClose: true, ...o });
  /** this tick's reading (37,000,000 at NOW) and `earlier` before it, a minute apart, each from an older block */
  const readings = (now: ReturnType<typeof baseState>, earlier: ReturnType<typeof baseState>[]) => {
    const history = earlier.map((st, i) => reading(37_000_000n - 30n * BigInt(i + 1), NOW - 60 * (i + 1), st));
    return { ...ctxOf({ base: now }), previous: { base: history[0] }, history: { base: history, bittensor: [] } };
  };
  const HALF = 5n * E18;

  it("fires once the batch reads closable before its interval on this reading and the six before it (R8: seven, the store's limit; the half rule makes full routine, and a busy keeper can take several rounds to close it); its facts and line", () => {
    expect(FULL_UNCLOSED_READINGS).toBe(7);
    const f = batchDepositsBlocked.run(ruleCtx(readings(door(HALF), [door(HALF), door(HALF), door(HALF), door(HALF), door(HALF), door(HALF)])));
    // six readings of it (this tick's and five before) are not enough
    expect(batchDepositsBlocked.run(ruleCtx(readings(door(HALF), [door(HALF), door(HALF), door(HALF), door(HALF), door(HALF), door(HALF, { canClose: false })])))).toEqual([]);
    expect(f.map((x) => [x.rule, x.key])).toEqual([["batch.deposits_blocked", "batch.deposits_blocked:9"]]);
    expect(f[0].subject).toBe("The open batch is full and can close at once, but nothing has closed it for 7 readings in a row");
    expect(f[0].facts).toEqual({
      batch: "9",
      "readings in a row": "7",
      deposits: "1 of 50",
      "redeem requests": "0 of 50",
      "batch total": "5 TAO",
      "room left": "5 TAO",
      "the least deposit": "0.04 TAO",
      "its interval ends": "2027-01-15 08:50 UTC",
    });
    expect(RUNBOOK["batch.deposits_blocked"](f[0].facts)).toBe(
      "The open batch 9 is full by the front door's own rule (its deposit or redeem list, half its value limit or of the deposit cap's room, or no room left for a minimum deposit), so it can close at once, and the keeper closes a full batch on its next round, each minute: it hasn't, for 7 readings in a row. Check that the keeper runs, its ETH on Base and its Base spend cap (SPEND CAP lines), and whether it holds the batch: the monitor's hold, or the vault's payouts closed while the batch holds unstake requests (rail.payouts_closed; the keeper says closing waits). Meanwhile deposits may be refused (no room for a minimum one), or wait. If it fills again after each close with deposits cancelled before the close, someone is holding it: the levers are the minimum deposit (pnpm ops set-caps <minDeposit> <depositCap> --for-wallet --live) or the guardian's deposit pause (pnpm ops pause front-door --for-wallet), never a changed batch limit left in place: set any limit you change back in the same sitting (runbook 7.10). No funds are at risk.",
    );
  });

  it("quiet when any of the seven reads it not closable, another batch, or closable by its clock (past the interval: full can't be told from the time there, batch.past_max_wait watches that)", () => {
    expect(batchDepositsBlocked.run(ruleCtx(readings(door(HALF), [door(HALF), door(HALF), door(HALF), door(HALF), door(HALF), door(HALF, { canClose: false })])))).toEqual([]);
    expect(batchDepositsBlocked.run(ruleCtx(readings(door(HALF, { canClose: false }), [door(HALF), door(HALF), door(HALF), door(HALF), door(HALF), door(HALF)])))).toEqual([]);
    // the keeper closed batch 8 a few minutes ago and 9 filled at once: not seven readings of one batch
    expect(batchDepositsBlocked.run(ruleCtx(readings(door(HALF), [door(HALF), door(HALF), door(HALF), door(HALF), door(HALF), door(HALF, { openBatch: open(HALF, { id: 8n }) })])))).toEqual([]);
    const late = (o: Partial<ReturnType<typeof baseState>> = {}) => door(HALF, { openBatch: open(HALF, { start: NOW - 2 * H }), ...o });
    expect(batchDepositsBlocked.run(ruleCtx(readings(late(), [late(), late(), late(), late(), late(), late()])))).toEqual([]);
  });

  it("judged by the front door's own canClose(), never a copy of its rule: unread, or too few readings to confirm, is unjudged (an open alert stays open)", () => {
    const c = ruleCtx(readings(door(HALF, { canClose: undefined }), [door(HALF), door(HALF), door(HALF), door(HALF), door(HALF), door(HALF)]));
    expect(batchDepositsBlocked.run(c)).toEqual([]);
    expect(c.unjudged).toContainEqual({ rule: "batch.deposits_blocked", key: "batch.deposits_blocked" });
    const few = ruleCtx(readings(door(HALF), [door(HALF), door(HALF), door(HALF), door(HALF), door(HALF)]));
    expect(batchDepositsBlocked.run(few)).toEqual([]);
    expect(few.unjudged).toContainEqual({ rule: "batch.deposits_blocked", key: "batch.deposits_blocked" });
    const gap = ruleCtx(readings(door(HALF), [door(HALF), door(HALF), door(HALF), door(HALF, { canClose: undefined }), door(HALF), door(HALF)]));
    expect(batchDepositsBlocked.run(gap)).toEqual([]);
    expect(gap.unjudged).toContainEqual({ rule: "batch.deposits_blocked", key: "batch.deposits_blocked" });
    // the room below minDeposit with the door saying it can't close (the condition before R7) is no longer judged blocked:
    // a v3.2 door closes such a batch at once
    expect(batchDepositsBlocked.run(ruleCtx(readings(door(997n * 10n ** 16n, { canClose: false }), Array(6).fill(door(997n * 10n ** 16n, { canClose: false })))))).toEqual([]);
  });
});

describe("build B (the list half rule): batch.deposits_full, closes forced by deposit lists at half of small deposits, at least twice in 24 hours", () => {
  const MIN = 4n * 10n ** 16n;
  const door = (o: Partial<ReturnType<typeof baseState>> = {}) => baseState({ openBatch: { id: 12n, start: NOW - 600, totalDeposits: 0n, feePot: 0n, nDeposits: 0, nRedeems: 0 }, minDeposit: MIN, maxDeposits: 50, ...o });
  /** a close: its id, deposits, their total, its bridge fee and the pot's part, `ago` seconds back */
  const closed = (id: number, nDeposits: number, total: bigint, ago = 600, fee = 3n * 10n ** 15n, potUsed = 10n ** 15n) => {
    const block = 37_000_000n - BigInt(ago * 5);
    return {
      log: slog({ contract: "frontDoor", chain: "base", event: "BatchClosed", block, args: { id: String(id), totalDeposits: String(total), nDeposits: String(nDeposits), nRedeems: "0", fee: String(fee), potUsed: String(potUsed), potCarried: "0" } }),
      time: [`base:${block}`, NOW - ago] as const,
    };
  };
  const ctx = (closes: ReturnType<typeof closed>[], o: Partial<ReturnType<typeof baseState>> = {}) => {
    const times = new Map<string, number>(closes.map((c) => c.time));
    return ruleCtx({ ...ctxOf({ base: door(o), logs: closes.map((c) => c.log) }), blockTime: (chain, b) => times.get(`${chain}:${b}`) });
  };

  it("warns once two batches in 24 hours closed with half their deposit slots or more (25 of 50) of deposits averaging at most twice the minimum: each close forced at once, its bridge fee its closer's", () => {
    expect(RULES["batch.deposits_full"]).toMatchObject({ tier: "warning", kind: "condition", canHold: false });
    expect(R4_RULES).toContain(batchDepositsFull);
    expect(SMALL_LIST_CLOSES).toBe(2);
    const f = batchDepositsFull.run(ctx([closed(10, 25, 25n * MIN, 7_200), closed(11, 30, 40n * MIN)]));
    expect(f.map((x) => [x.rule, x.key])).toEqual([["batch.deposits_full", "batch.deposits_full"]]);
    expect(f[0].subject).toBe("2 batches closed in 24 hours with half their deposit slots or more taken by small deposits: each such list closes at once, its bridge fee paid by its closer");
    expect(f[0].facts).toEqual({
      "closes (24 h)": "2",
      "the last": "batch 11: 30 of 50 deposits, 1.6 TAO",
      "their bridge fees beyond their pots": "0.004 ETH",
      "the least deposit": "0.04 TAO",
    });
    const line = RUNBOOK["batch.deposits_full"](f[0].facts);
    expect(line).toMatch(/raise minDeposit/);
    expect(line).toContain("runbook 7.10");
  });

  it("quiet for one, for lists under half (24 of 50), for real deposits, and for closes older than 24 hours", () => {
    expect(batchDepositsFull.run(ctx([closed(10, 25, 25n * MIN)]))).toEqual([]);
    expect(batchDepositsFull.run(ctx([closed(10, 24, 24n * MIN), closed(11, 24, 24n * MIN)]))).toEqual([]);
    expect(batchDepositsFull.run(ctx([closed(10, 25, 50n * MIN + 1n), closed(11, 25, 25n * MIN)]))).toEqual([]);
    expect(batchDepositsFull.run(ctx([closed(10, 25, 25n * MIN, 86_401), closed(11, 25, 25n * MIN)]))).toEqual([]);
    // an odd limit: 25 of 49 is half
    expect(batchDepositsFull.run(ctx([closed(10, 25, 25n * MIN), closed(11, 25, 25n * MIN)], { maxDeposits: 49 }))).toHaveLength(1);
  });

  it("R12d (a nit): a close whose block time is unknown counts by its block, not as now: one more than 24 hours of Base's blocks back is left out; a recent one still counts; with Base's block time unknown too, the prefetch's window bounds it", () => {
    /** `c` with its block time unknown (no stored header) */
    const untimed = (c: ReturnType<typeof closed>): ReturnType<typeof closed> => ({ ...c, time: ["base:-1", 0] as const });
    // a day and a second back by its block (5 blocks a second): before R12d it counted as now
    expect(batchDepositsFull.run(ctx([untimed(closed(10, 25, 25n * MIN, 86_401)), closed(11, 25, 25n * MIN)]))).toEqual([]);
    expect(batchDepositsFull.run(ctx([untimed(closed(10, 25, 25n * MIN, 3_600)), closed(11, 25, 25n * MIN)]))).toHaveLength(1);
    // Base's block time unknown (a first tick): no block bound, the logs the prefetch loaded (25 hours) count
    const first = ruleCtx({ ...ctx([untimed(closed(10, 25, 25n * MIN, 86_401)), closed(11, 25, 25n * MIN)]), blockS: {} });
    expect(batchDepositsFull.run(first)).toHaveLength(1);
  });

  it("v3.2 only; the limits unread: unjudged", () => {
    const u = ruleCtx({ ...ctxOf({ base: baseState({ openBatch: { id: 12n, start: NOW - 600, totalDeposits: 0n, feePot: 0n, nDeposits: 0, nRedeems: 0 } }) }) });
    expect(batchDepositsFull.run(u)).toEqual([]);
    expect(u.unjudged.map((x) => x.rule)).toContain("batch.deposits_full");
  });
});

describe("R8 (the contracts review's L-1): batch.cancel_churn, one address cancelling deposits in the open batch, at half its value limit together or three times", () => {
  const HOLDER = "0x00000000000000000000000000000000000000d1" as Hex;
  const HONEST = "0x00000000000000000000000000000000000000a2" as Hex;
  const ob = { id: 9n, start: NOW - 600, totalDeposits: 0n, feePot: 0n, nDeposits: 0, nRedeems: 0 };
  const door = (o: Partial<ReturnType<typeof baseState>> = {}) => baseState({ openBatch: ob, maxBatchValue: 10n * E18, ...o });
  const cancel = (user: Hex, amount: bigint, batchId = 9n, block = 37_000_000n) =>
    slog({ contract: "frontDoor", chain: "base", event: "DepositCancelled", block, args: { batchId: String(batchId), user, amount: String(amount) } });
  const deposit = (user: Hex, amount: bigint, batchId = 9n) =>
    slog({ contract: "frontDoor", chain: "base", event: "DepositRequested", block: 36_999_000n, args: { batchId: String(batchId), user, amount: String(amount), payer: user } });

  it("warns, naming the address and the amounts, once one address's cancels in the open batch reach half its maxBatchValue: a holder filling it after a keeper round and cancelling before the next", () => {
    expect(RULES["batch.cancel_churn"]).toMatchObject({ tier: "warning", kind: "condition" });
    expect(R4_RULES).toContain(batchCancelChurn);
    expect(TICK_RULES).toContain(batchCancelChurn);
    expect([DEFAULTS.cancelChurnPct, DEFAULTS.cancelChurnCount]).toEqual([50, 3]);
    const logs = [deposit(HOLDER, 10n * E18), cancel(HOLDER, 10n * E18), deposit(HONEST, E18), cancel(HONEST, E18 / 2n)];
    const f = batchCancelChurn.run(ruleCtx(ctxOf({ base: door(), logs })));
    expect(f.map((x) => [x.rule, x.key])).toEqual([["batch.cancel_churn", `batch.cancel_churn:9:${HOLDER}`]]);
    expect(f[0].subject).toBe("One address has cancelled 10 TAO of deposits in the open batch (1 cancel): the pattern of a holder that keeps the batch full between the keeper's rounds");
    expect(f[0].facts).toEqual({
      address: HOLDER,
      batch: "9",
      cancels: "1",
      "cancelled in all": "10 TAO",
      "the largest cancel": "10 TAO",
      "deposited in this batch": "10 TAO",
      "the batch's value limit": "10 TAO",
    });
    const line = RUNBOOK["batch.cancel_churn"](f[0].facts);
    expect(line).toContain(HOLDER);
    expect(line).toContain("runbook 7.10");
    expect(line).toContain("pnpm ops close --live");
    // under half, and twice: quiet
    expect(batchCancelChurn.run(ruleCtx(ctxOf({ base: door(), logs: [cancel(HOLDER, 2n * E18), cancel(HOLDER, 3n * E18 - 1n)] })))).toEqual([]);
  });

  it("or three cancels in the batch whatever their size; cancels in another batch don't count", () => {
    const three = [cancel(HOLDER, E18 / 10n), cancel(HOLDER, E18 / 10n), cancel(HOLDER, E18 / 10n)];
    const f = batchCancelChurn.run(ruleCtx(ctxOf({ base: door(), logs: three })));
    expect(f.map((x) => x.key)).toEqual([`batch.cancel_churn:9:${HOLDER}`]);
    expect(f[0].facts).toMatchObject({ cancels: "3", "cancelled in all": "0.3 TAO", "deposited in this batch": "0 TAO" });
    expect(batchCancelChurn.run(ruleCtx(ctxOf({ base: door(), logs: [...three.slice(0, 2), cancel(HOLDER, 6n * E18, 8n)] })))).toEqual([]);
    // the thresholds are the founder's (THRESHOLDS)
    expect(batchCancelChurn.run(ruleCtx(ctxOf({ base: door(), logs: three, t: { cancelChurnCount: 4 } })))).toEqual([]);
  });

  it("v3.2 only; no open batch read, or its limit unread with nothing found by count: unjudged (an open alert stays open)", () => {
    expect(batchCancelChurn.run(ruleCtx({ ...ctxOf({ base: door(), logs: [cancel(HOLDER, 10n * E18)] }), cfg: testConfig() }))).toEqual([]);
    const none = ruleCtx(ctxOf({ base: baseState({}) }));
    expect(batchCancelChurn.run(none)).toEqual([]);
    expect(none.unjudged).toContainEqual({ rule: "batch.cancel_churn" });
    const blind = ruleCtx(ctxOf({ base: door({ maxBatchValue: undefined }), logs: [cancel(HOLDER, 10n * E18)] }));
    expect(batchCancelChurn.run(blind)).toEqual([]);
    expect(blind.unjudged).toContainEqual({ rule: "batch.cancel_churn" });
  });
});

describe("R6 (Fable's full review, L-1): cap.nearly_full's line names direct exits as a cause, and runbook 7.10", () => {
  it("says a cap filled by direct exits on Bittensor is raised by the difference", () => {
    const line = RUNBOOK["cap.nearly_full"]({});
    expect(line).toMatch(/direct exits on Bittensor/);
    expect(line).toContain("runbook 7.10");
  });

  it("R7 (L3): says the front door's rule near the cap: a batch with deposits at half the cap's room closes at once, as at half its value limit; a batch of unstakes alone waits for its interval even at the cap", () => {
    const line = RUNBOOK["cap.nearly_full"]({});
    expect(line).toContain("the front door closes a batch with deposits at once when they reach half the room the cap had left, or leave no room under it for a minimum deposit, as it does a batch at half its value limit");
    expect(line).toContain("a batch of unstakes alone waits for its interval even at the cap");
  });
});

describe("A-L2: cap.exits_consumed, the door's netForwarded against the vault's assets", () => {
  /** every Bittensor bridge read, none holding a park */
  const noParks = () => Object.fromEntries(cfg.bridges.bittensor.map((a) => [a.toLowerCase(), { parkedNative: 0n, parkedTokens: 0n }]));
  const bitA = cfg.bridges.bittensor[0].toLowerCase() as Hex;
  const message = (n: number, direction: MessageRow["direction"], amount: bigint): MessageRow => ({
    messageId: `0x${n.toString(16).padStart(64, "0")}`,
    direction,
    sender: cfg.deployment.frontDoor,
    recipient: cfg.deployment.vault,
    amount: String(amount),
    srcTx: `0x${"ab".repeat(32)}`,
    srcBlock: 1n,
    srcTime: NOW - 600,
    state: "UNTOUCHED",
    stateAt: null,
    dstTx: null,
    dstBlock: null,
  });

  it("warns when the cap counts at least capExitsGapWei (1 TAO) more than the vault holds: TAO that left by direct exits", () => {
    const f = capExitsConsumed.run(ctxOf({ base: baseState({ netForwarded: 40n * E18, depositCap: 40n * E18 }), bit: bitState({ totalAssets: 2n * E18, adapters: noParks() }) }));
    expect(f.map((x) => x.rule)).toEqual(["cap.exits_consumed"]);
    expect(f[0].subject).toBe("The deposit cap counts 38 TAO that has left the vault");
    expect(f[0].facts).toMatchObject({ "net forwarded (what the cap counts)": "40 TAO", "the vault's assets": "2 TAO", "deposit cap": "40 TAO" });
    // within the gap (rewards make the vault hold more): quiet
    expect(capExitsConsumed.run(ctxOf({ base: baseState({ netForwarded: 40n * E18, depositCap: 40n * E18 }), bit: bitState({ totalAssets: 39n * E18 + 1n, adapters: noParks() }) }))).toEqual([]);
  });

  it("R4-O's fix round (Minor 7): TAO crossing (a batch closed, a payout sent) or parked on a Bittensor adapter has not left the vault; an unread park is unjudged", () => {
    const base = baseState({ netForwarded: 40n * E18, depositCap: 40n * E18 });
    const parks = { ...noParks(), [bitA]: { parkedNative: 6n * E18, parkedTokens: 4n * E18 } };
    // 2 TAO in the vault; a 20 TAO batch crossing to Bittensor, a 7 TAO payout crossing to Base, 10 TAO parked: 1 TAO left by exits
    const crossing = [message(1, "base>bittensor", 20n * E18), message(2, "bittensor>base", 7n * E18)];
    const f = capExitsConsumed.run(ctxOf({ base, bit: bitState({ totalAssets: 2n * E18, adapters: parks }), messages: crossing }));
    expect(f.map((x) => x.subject)).toEqual(["The deposit cap counts 1 TAO that has left the vault"]);
    expect(f[0].facts).toMatchObject({ "crossing between the chains": "27 TAO", "parked on the Bittensor adapters": "10 TAO" });
    // a batch over 1 TAO in flight alone: quiet (the old rule fired on it)
    expect(capExitsConsumed.run(ctxOf({ base, bit: bitState({ totalAssets: 2n * E18, adapters: noParks() }), messages: [message(3, "base>bittensor", 38n * E18)] }))).toEqual([]);
    // parked alone: quiet
    expect(capExitsConsumed.run(ctxOf({ base, bit: bitState({ totalAssets: 2n * E18, adapters: { ...noParks(), [bitA]: { parkedNative: 38n * E18, parkedTokens: 0n } } }) }))).toEqual([]);
    // a message that arrived is not crossing
    const arrived = { ...message(4, "base>bittensor", 38n * E18), dstTx: `0x${"cd".repeat(32)}` as Hex, dstBlock: 2n };
    expect(capExitsConsumed.run(ctxOf({ base, bit: bitState({ totalAssets: 2n * E18, adapters: noParks() }), messages: [arrived] })).map((x) => x.subject)).toEqual(["The deposit cap counts 38 TAO that has left the vault"]);
    // an adapter's parks unread: unjudged, never quiet
    const u = ctxOf({ base, bit: bitState({ totalAssets: 2n * E18, adapters: {} }) });
    expect(capExitsConsumed.run(u)).toEqual([]);
    expect(u.unjudged).toContainEqual({ rule: "cap.exits_consumed", key: "cap.exits_consumed" });
  });

  it("a batch just closed is not TAO that left: netForwarded rises at the close, the message is read only once the scan settles its block", () => {
    // the launch's second batch: 0.2111 TAO staked, a 1.0495 TAO batch closed this minute, no message indexed yet
    const before = baseState({ netForwarded: 211063801n * 10n ** 9n, depositCap: 40n * E18 });
    const after = baseState({ netForwarded: 1260583455n * 10n ** 9n, depositCap: 40n * E18 });
    const bit = bitState({ totalAssets: 211063801n * 10n ** 9n, adapters: noParks() });
    /** this tick's reading `now`, with `earlier` readings a minute apart before it (newest first) */
    const at = (now: ReturnType<typeof baseState>, earlier: ReturnType<typeof baseState>[], messages: MessageRow[] = []) => {
      const history = earlier.map((st, i) => reading(37_000_000n - 300n * BigInt(i + 1), NOW - 60 * (i + 1), st));
      return { ...ctxOf({ base: now, bit, messages }), previous: { base: history[0] }, history: { base: history, bittensor: [] } };
    };
    // with no history the old reading stands (nothing shows a close): it warns, as it did live
    expect(capExitsConsumed.run(ctxOf({ base: after, bit })).map((x) => x.subject)).toEqual(["The deposit cap counts 1.049519654 TAO that has left the vault"]);
    // the reading the close lands in, and each of the next ones while the close is inside the window: quiet
    for (let n = 1; n <= CLOSE_LAG_READINGS; n++) {
      const earlier = [...Array.from({ length: n - 1 }, () => after), ...Array.from({ length: CLOSE_LAG_READINGS - n + 1 }, () => before)];
      expect(capExitsConsumed.run(at(after, earlier)), `the close ${n} reading(s) ago`).toEqual([]);
    }
    // once the message is read it is the crossing that covers it, counted once (not the rise and the message both)
    const sent = { ...message(5, "base>bittensor", 1049519654n * 10n ** 9n), srcTime: NOW - 90 };
    expect(capExitsConsumed.run(at(after, [after, before, before, before, before], [sent]))).toEqual([]);
    const half = { ...message(6, "base>bittensor", 5n * 10n ** 17n), srcTime: NOW - 90 };
    expect(capExitsConsumed.run(at(after, [after, before, before, before, before], [half]))).toEqual([]);
    // the window passed and nothing is crossing or in the vault: it really left, and the warning is back
    const stale = capExitsConsumed.run(at(after, Array.from({ length: CLOSE_LAG_READINGS }, () => after)));
    expect(stale.map((x) => x.subject)).toEqual(["The deposit cap counts 1.049519654 TAO that has left the vault"]);
    // a fall of netForwarded (a payout landed) allows nothing
    const fell = capExitsConsumed.run(at(baseState({ netForwarded: 40n * E18, depositCap: 40n * E18 }), Array.from({ length: CLOSE_LAG_READINGS }, () => baseState({ netForwarded: 45n * E18 }))));
    expect(fell.map((x) => x.subject)).toEqual(["The deposit cap counts 39.788936199 TAO that has left the vault"]);
    // an old message (sent before the window) is not what the rise was: the rise still counts, the message is plain crossing
    const old = { ...message(7, "base>bittensor", 3n * E18), srcTime: NOW - 3_600 };
    const f = capExitsConsumed.run(at(baseState({ netForwarded: 10n * E18, depositCap: 40n * E18 }), [baseState({ netForwarded: 4n * E18 })], [old]));
    expect(f).toEqual([]); // 0.2111 in the vault + 3 crossing + 6 just closed = 9.2111 of 10: under the 1 TAO gap
  });
});

describe("stake.min_near_floor and stake.min_at_floor: the chain's minimum stake against MIN_REDEEM_VALUE", () => {
  it("MIN_REDEEM_VALUE is 0.03 TAO (held to the contracts' by test/node/r4-pins.test.ts)", () => {
    expect(MIN_REDEEM_VALUE_RAO).toBe(30_000_000n);
    expect([DEFAULTS.minStakeWarnPct, DEFAULTS.minStakeCriticalPct]).toEqual([50, 80]);
  });

  it("quiet at today's 0.002 TAO; a warning from half of 0.03 TAO; critical from 80%", () => {
    expect(stakeMinNearFloor.run(ctxOf({ bit: bitState({ minStakeRao: 2_000_000n }) }))).toEqual([]);
    expect(stakeMinNearFloor.run(ctxOf({ bit: bitState({ minStakeRao: 15_000_000n - 1n }) }))).toEqual([]);
    const warn = stakeMinNearFloor.run(ctxOf({ bit: bitState({ minStakeRao: 15_000_000n }) }));
    expect(warn.map((x) => [x.rule, x.subject])).toEqual([["stake.min_near_floor", "Bittensor's minimum stake, 0.015 TAO, is 50% of the 0.03 TAO redeem floor"]]);
    const crit = stakeMinNearFloor.run(ctxOf({ bit: bitState({ minStakeRao: 24_000_000n }) }));
    expect(crit.map((x) => [x.rule, x.subject])).toEqual([["stake.min_at_floor", "Bittensor's minimum stake, 0.024 TAO, is 80% of the 0.03 TAO redeem floor"]]);
  });
});

describe("S-H1: rail.payouts_closed, the vault's primary bridge can't send payouts (its canSendPayouts())", () => {
  const KEY = `0x${"ab".repeat(32)}` as Hex;
  const user = "0x00000000000000000000000000000000000000a1";
  const other = "0x00000000000000000000000000000000000000a2";
  const queued = { [KEY]: { queuedAt: NOW - H, cursor: 0, count: 3, chunk: 0, remaining: 3n * E18 } };
  const clear = { isPaused: false, migrationReadyAt: 0n, migrationFinished: false, migrationExecuted: false };
  const notice = { ...clear, migrationReadyAt: BigInt(NOW + 5 * 86_400) };
  const PRIMARY = cfg.deployment.bitAdapter.toLowerCase() as Hex;
  const NEW = "0x00000000000000000000000000000000000000c2" as Hex;
  const half = (canSendPayouts: boolean | undefined) => ({ remote: cfg.deployment.baseAdapter, remoteChainId: 8453n, enabled: true, known: true, ...(canSendPayouts === undefined ? {} : { canSendPayouts }) });
  /** the vault's primary bridge (the deploy's adapter unless given) and its canSendPayouts() */
  const railed = (canSend: boolean | undefined, o: Partial<ReturnType<typeof bitState>> = {}, primary: Hex = PRIMARY) =>
    bitState({ primaryBridge: primary, rails: { [primary]: half(canSend) }, alpha: clear, payoutBatches: queued, ...o });
  const openWith = (nRedeems: number) => baseState({ openBatch: { id: 7n, start: NOW - 60, totalDeposits: 0n, feePot: 0n, nDeposits: 0, nRedeems } });
  // the queued batch's list: one bounce, then two redeems
  const logs = [
    slog({ contract: "vault", event: "DepositBounced", args: { key: KEY, user: other, assets: String(E18), reason: "0" }, block: 10n }),
    slog({ contract: "vault", event: "Redeemed", args: { key: KEY, user, shares: String(E18), assets: String(E18) }, block: 11n }),
    slog({ contract: "vault", event: "Redeemed", args: { key: KEY, user: other, shares: String(E18), assets: String(E18) }, block: 11n }),
    slog({ contract: "vault", event: "PayoutBatchQueued", args: { key: KEY, sourceChain: "8453", batchId: "3", count: "3", total: String(3n * E18), price: "1" }, block: 12n }),
  ];

  it("critical while the view reads false: the open batch's redeem requests (the vault defers them, not burns) and each queued payout batch, its share entries and bounces named apart", () => {
    const f = railPayoutsClosed.run(ctxOf({ base: openWith(2), bit: railed(false, { alpha: notice }), pending: [KEY], logs }));
    expect(f.map((x) => [x.rule, x.key])).toEqual([
      ["rail.payouts_closed", "rail.payouts_closed:redeems:7"],
      ["rail.payouts_closed", `rail.payouts_closed:queued:${KEY}`],
    ]);
    expect(f[0].subject).toBe("2 redeem requests in the open batch will be deferred: the vault's bridge can't send payouts");
    expect(f[0].facts).toMatchObject({ batch: "7", "the vault's primary bridge": PRIMARY, why: `ForeverMoney announced a migration of its AlphaVault (ready at ${"2027-01-20 08:00 UTC"})` });
    expect(f[1].subject).toBe("A queued payout batch can't be sent: the vault's bridge can't send payouts");
    expect(f[1].facts).toMatchObject({ key: KEY, left: "3 of 3 entries", "share entries (a cancel re-mints them)": "2, 2 TAO", "bounces (no cancel: owed TAO)": "1, 1 TAO" });
  });

  it("the view decides, not ForeverMoney's migration fields alone: a paused AlphaVault, or a failed read of it, closes the rail too; a view reading true is quiet whatever the fields", () => {
    const paused = railPayoutsClosed.run(ctxOf({ base: openWith(0), bit: railed(false, { alpha: { ...clear, isPaused: true } }), pending: [KEY], logs }));
    expect(paused.map((x) => x.key)).toEqual([`rail.payouts_closed:queued:${KEY}`]);
    expect(paused[0].facts.why).toBe("ForeverMoney's AlphaVault is paused");
    const failed = railPayoutsClosed.run(ctxOf({ base: openWith(0), bit: railed(false), pending: [KEY], logs }));
    expect(failed[0].facts.why).toMatch(/^the adapter's read of ForeverMoney's AlphaVault failed/);
    const finished = railPayoutsClosed.run(ctxOf({ base: openWith(0), bit: railed(false, { alpha: { ...clear, migrationFinished: true, migrationExecuted: true } }), pending: [KEY], logs }));
    expect(finished[0].facts.why).toBe("ForeverMoney's migration of its AlphaVault finished");
    // the fields say migrating, the view says open (the rail now primary is another vault's): quiet
    expect(railPayoutsClosed.run(ctxOf({ base: openWith(2), bit: railed(true, { alpha: notice }), pending: [KEY], logs }))).toEqual([]);
  });

  it("the reads follow the primary rail (R4-O round 4): the vault's primary as this reading names it, never the deploy's adapter after a switch", () => {
    const bit = bitState({ primaryBridge: NEW, rails: { [PRIMARY]: half(false), [NEW]: half(true) }, alpha: clear, payoutBatches: queued });
    expect(railPayoutsClosed.run(ctxOf({ base: openWith(2), bit, pending: [KEY], logs }))).toEqual([]);
    const back = bitState({ primaryBridge: NEW, rails: { [PRIMARY]: half(true), [NEW]: half(false) }, alpha: clear, payoutBatches: queued });
    expect(railPayoutsClosed.run(ctxOf({ base: openWith(0), bit: back, pending: [KEY], logs })).map((x) => x.facts["the vault's primary bridge"])).toEqual([NEW]);
  });

  it("R6 (ChatGPT R2 claim D): a primary disabled on the vault reads closed whatever its own view, as the vault's _payoutsOpen reads it; its line says to finish the switch", () => {
    const off = (canSend: boolean | undefined) => bitState({ primaryBridge: PRIMARY, rails: { [PRIMARY]: { ...half(canSend), enabled: false } }, alpha: clear, payoutBatches: queued });
    const f = railPayoutsClosed.run(ctxOf({ base: openWith(2), bit: off(true), pending: [KEY], logs }));
    expect(f.map((x) => x.key)).toEqual(["rail.payouts_closed:redeems:7", `rail.payouts_closed:queued:${KEY}`]);
    expect(f[0].facts.why).toBe("the vault's primary bridge is disabled on the vault");
    // its own view unread: disabled is closed all the same
    expect(railPayoutsClosed.run(ctxOf({ base: openWith(0), bit: off(undefined), pending: [KEY], logs })).map((x) => x.key)).toEqual([`rail.payouts_closed:queued:${KEY}`]);
    const line = RUNBOOK["rail.payouts_closed"]({ why: "the vault's primary bridge is disabled on the vault" });
    expect(line).toContain("the vault's setPrimaryBridge first (runbook section 8)");
    expect(line).not.toMatch(/Ask ForeverMoney/);
  });

  it("quiet while the view reads true; unjudged while the primary, or its view, is unread", () => {
    expect(railPayoutsClosed.run(ctxOf({ base: openWith(2), bit: railed(true), pending: [KEY], logs }))).toEqual([]);
    for (const bit of [railed(undefined), bitState({ alpha: clear, payoutBatches: queued })]) {
      const c = ctxOf({ base: openWith(2), bit, pending: [KEY], logs });
      expect(railPayoutsClosed.run(c)).toEqual([]);
      expect(c.unjudged.map((u) => u.rule)).toContain("rail.payouts_closed");
    }
  });

  it("its runbook line tells a pause (payouts wait, nothing to cancel yet) from a migration (cancel the queued batches first)", () => {
    const pause = RUNBOOK["rail.payouts_closed"]({ why: "ForeverMoney's AlphaVault is paused" });
    expect(pause).toContain("defers every front-door redeem");
    expect(pause).toMatch(/payouts wait/);
    expect(pause).not.toMatch(/cancel each queued payout batch now/);
    const migration = RUNBOOK["rail.payouts_closed"]({ why: "ForeverMoney announced a migration of its AlphaVault (ready at x)" });
    expect(migration).toMatch(/cancel each queued payout batch now/);
    expect(migration).toContain("runbook 7.7");
    expect(migration).not.toMatch(/burn/);
    // both say what becomes of the open batch's redeem requests, and that closes need no holding (runbook 7.7's rule)
    for (const line of [pause, migration]) {
      expect(line).toMatch(/open batch's redeem requests are deferred/);
      expect(line).toMatch(/request fees are spent/);
      expect(line).toMatch(/no need to hold the close/);
    }
    // a pause may lift before the batch lands, and its redeems are then burned and paid (the re-review's N4); a migration
    // never reopens the old rail
    expect(pause).toContain("The open batch's redeem requests are deferred if it arrives while the bridge still can't send payouts");
    expect(migration).toContain("The open batch's redeem requests are deferred when it arrives");
  });
});

describe("S-H1: payout.no_rail, a front-door redeem burned while the vault's bridge can't send payouts", () => {
  const KEY = `0x${"ef".repeat(32)}` as Hex;
  const user = "0x00000000000000000000000000000000000000a1";
  const PRIMARY = cfg.deployment.bitAdapter.toLowerCase() as Hex;
  const railed = (canSendPayouts: boolean | undefined) =>
    bitState({ primaryBridge: PRIMARY, rails: { [PRIMARY]: { remote: cfg.deployment.baseAdapter, remoteChainId: 8453n, enabled: true, known: true, ...(canSendPayouts === undefined ? {} : { canSendPayouts }) } }, alpha: { isPaused: true, migrationReadyAt: 0n, migrationFinished: false } });
  const redeemed = (block: bigint) => slog({ contract: "vault", event: "Redeemed", args: { key: KEY, user, shares: String(E18), assets: String(2n * E18) }, block });

  it("is a critical event that can't hold and that no hold mutes: rail.payouts_closed alone covers the queued batch (a condition), this names the burn the vault should have deferred", () => {
    expect(RULES["payout.no_rail"]).toMatchObject({ tier: "critical", kind: "event", canHold: false, mutedByHold: false });
    expect(RULES["rail.payouts_closed"]).toMatchObject({ mutedByHold: false });
    expect(TICK_RULES).toContain(payoutNoRail);
    expect(RUNBOOK["payout.no_rail"]({}).length).toBeGreaterThan(40);
    // a burn just before the reopening the monitor saw may be the bridge reopening between its readings (the re-review's N3)
    const line = RUNBOOK["payout.no_rail"]({ "reopened at": "block 6900000" });
    expect(line).toContain("A burn a few blocks before \"reopened at\" may be the bridge reopening between the monitor's readings");
    expect(line).toMatch(/read canSendPayouts\(\) at the burn's block on the archive node before treating it as a guard failure/);
  });

  it("one alert per delivery for the Redeemed stored for the first time from the block the monitor first saw the primary closed; kept through a hold", async () => {
    const c = ctxOf({ bit: railed(false), meta: { [RAIL_CLOSED_SINCE]: "6899000" }, logs: [redeemed(6_899_500n), redeemed(6_899_500n), redeemed(6_898_000n)] });
    const f = payoutNoRail.run(c);
    expect(f.map((x) => [x.rule, x.key, x.subject])).toEqual([["payout.no_rail", `payout.no_rail:${KEY}`, "Front-door redeems were burned while the vault's bridge can't send payouts"]]);
    expect(f[0].facts).toMatchObject({ key: KEY, "redeems burned": "2, 4 TAO", "the vault's primary bridge": PRIMARY, "closed since": "block 6899000", why: "ForeverMoney's AlphaVault is paused" });
    const r = reconcile(env.DB, { open: [], findings: f, nowS: NOW, t: DEFAULTS, holdActive: true });
    expect(r.due.map((d) => d.key)).toEqual([`payout.no_rail:${KEY}`]);
    // a Redeemed from before the monitor saw it closed, or one stored before this tick, is none
    expect(payoutNoRail.run(ctxOf({ bit: railed(false), meta: { [RAIL_CLOSED_SINCE]: "6899000" }, logs: [redeemed(6_898_999n)] }))).toEqual([]);
    const old = ruleCtx({ ...ctxOf({ bit: railed(false), meta: { [RAIL_CLOSED_SINCE]: "6899000" }, logs: [redeemed(6_899_500n)] }), newUids: new Set() });
    expect(payoutNoRail.run(old)).toEqual([]);
  });

  /** a context whose logs are stored up to `settled` on Bittensor (the readings run ahead of it) */
  const at = (settled: bigint, o: Parameters<typeof ctxOf>[0]) => ({ ...ctxOf(o), settled: { base: { block: 10n ** 9n, time: 2_000_000_000 }, bittensor: { block: settled, time: NOW } } });

  it("R6 (ChatGPT R2 claim D): a burn while the vault's primary is disabled is one too, its own view reading open", () => {
    const off = bitState({ primaryBridge: PRIMARY, rails: { [PRIMARY]: { remote: cfg.deployment.baseAdapter, remoteChainId: 8453n, enabled: false, known: true, canSendPayouts: true } }, alpha: { isPaused: false, migrationReadyAt: 0n, migrationFinished: false } });
    const first = ctxOf({ bit: off });
    expect(payoutNoRail.run(first)).toEqual([]);
    expect(first.writes.meta).toEqual([{ k: RAIL_CLOSED_SINCE, v: "6900000" }]);
    const f = payoutNoRail.run(ctxOf({ bit: off, meta: { [RAIL_CLOSED_SINCE]: "6899000" }, logs: [redeemed(6_899_500n)] }));
    expect(f.map((x) => [x.key, x.facts.why])).toEqual([[`payout.no_rail:${KEY}`, "the vault's primary bridge is disabled on the vault"]]);
    expect(RUNBOOK["payout.no_rail"](f[0].facts)).toContain("while its primary is disabled or its canSendPayouts() reads false");
  });

  it("marks the first reading that sees the primary closed, and leaves the mark while unread", () => {
    const first = ctxOf({ bit: railed(false), logs: [redeemed(6_899_999n)] });
    expect(payoutNoRail.run(first)).toEqual([]);
    expect(first.writes.meta).toEqual([{ k: RAIL_CLOSED_SINCE, v: "6900000" }]);
    const still = ctxOf({ bit: railed(false), meta: { [RAIL_CLOSED_SINCE]: "6899000" } });
    payoutNoRail.run(still);
    expect(still.writes.meta).toEqual([]);
    const unread = ctxOf({ bit: railed(undefined), meta: { [RAIL_CLOSED_SINCE]: "6899000" }, logs: [redeemed(6_899_500n)] });
    expect(payoutNoRail.run(unread).map((x) => x.key)).toEqual([`payout.no_rail:${KEY}`]);
    expect(unread.writes.meta).toEqual([]);
  });

  it("keeps the closed interval once the primary reads open, until the scan's settled block passes the reopening: a burn inside it stored late is still one (the review's M4)", () => {
    // reopened at the reading's block, 6,900,000, while logs are stored only to 6,899,800
    const reopened = at(6_899_800n, { bit: railed(true), meta: { [RAIL_CLOSED_SINCE]: "6899000" }, logs: [redeemed(6_899_500n)] });
    expect(payoutNoRail.run(reopened).map((x) => [x.key, x.facts["closed since"], x.facts["reopened at"]])).toEqual([[`payout.no_rail:${KEY}`, "block 6899000", "block 6900000"]]);
    expect(reopened.writes.meta).toEqual([{ k: RAIL_CLOSED_SINCE, v: "6899000:6900000" }]);
    // a later tick stores a burn from inside the closure late: flagged; one after the reopening isn't
    const late = at(6_899_950n, { bit: railed(true), meta: { [RAIL_CLOSED_SINCE]: "6899000:6900000" }, logs: [redeemed(6_899_900n)] });
    expect(payoutNoRail.run(late).map((x) => x.key)).toEqual([`payout.no_rail:${KEY}`]);
    expect(late.writes.meta).toEqual([]);
    expect(payoutNoRail.run(at(6_900_100n, { bit: railed(true), meta: { [RAIL_CLOSED_SINCE]: "6899000:6900000" }, logs: [redeemed(6_900_050n)] }))).toEqual([]);
    // once the settled block passes the reopening every log of the closure is stored: the interval goes
    const done = at(6_900_001n, { bit: railed(true), meta: { [RAIL_CLOSED_SINCE]: "6899000:6900000" } });
    payoutNoRail.run(done);
    expect(done.writes.meta).toEqual([{ k: RAIL_CLOSED_SINCE, v: "" }]);
    // closed again while an old interval waits: both kept, a burn in the gap between them is none
    const again = at(6_899_500n, { bit: railed(false), meta: { [RAIL_CLOSED_SINCE]: "6899000:6899600" }, logs: [redeemed(6_899_700n)] });
    expect(payoutNoRail.run(again)).toEqual([]);
    expect(again.writes.meta).toEqual([{ k: RAIL_CLOSED_SINCE, v: "6899000:6899600,6900000" }]);
  });
});

describe("S-L4: payout.bounces_stranded, a bounce-only queue whose door or bridge is going", () => {
  const KEY = `0x${"cd".repeat(32)}` as Hex;
  const user = "0x00000000000000000000000000000000000000a1";
  const logs = (redeemed: boolean) => [
    slog({ contract: "vault", event: "DepositBounced", args: { key: KEY, user, assets: String(E18), reason: "0" }, block: 10n }),
    ...(redeemed ? [slog({ contract: "vault", event: "Redeemed", args: { key: KEY, user, shares: String(E18), assets: String(E18) }, block: 11n })] : []),
    slog({ contract: "vault", event: "PayoutBatchQueued", args: { key: KEY, sourceChain: "8453", batchId: "3", count: redeemed ? "2" : "1", total: String(E18), price: "1" }, block: 12n }),
  ];
  const batch = { [KEY]: { queuedAt: NOW - H, cursor: 0, count: 1, chunk: 0, remaining: E18 } };

  it("critical when a queue holding only bounces waits while the launch door isn't Active on the vault, or the vault's primary is disabled", () => {
    const removed = payoutBouncesStranded.run(ctxOf({ bit: bitState({ doorState: 2, payoutBatches: batch, primaryBridge: cfg.deployment.bitAdapter, rails: {} }), pending: [KEY], logs: logs(false) }));
    expect(removed.map((x) => [x.rule, x.key])).toEqual([["payout.bounces_stranded", `payout.bounces_stranded:${KEY}`]]);
    expect(removed[0].subject).toBe("A payout batch of bounces alone waits on a door or bridge that is going: a bounce can't be cancelled");
    const disabled = payoutBouncesStranded.run(
      ctxOf({ bit: bitState({ doorState: 1, payoutBatches: batch, primaryBridge: cfg.deployment.bitAdapter, rails: { [cfg.deployment.bitAdapter.toLowerCase() as Hex]: { remote: "0x0" as Hex, remoteChainId: 8453n, enabled: false, known: true } } }), pending: [KEY], logs: logs(false) }),
    );
    expect(disabled.map((x) => x.rule)).toEqual(["payout.bounces_stranded"]);
  });

  it("quiet for a queue with a redeem in it (a cancel re-mints it), and while the door and the primary are open", () => {
    expect(payoutBouncesStranded.run(ctxOf({ bit: bitState({ doorState: 2, payoutBatches: { [KEY]: { ...batch[KEY], count: 2 } }, primaryBridge: cfg.deployment.bitAdapter, rails: {} }), pending: [KEY], logs: logs(true) }))).toEqual([]);
    expect(
      payoutBouncesStranded.run(
        ctxOf({ bit: bitState({ doorState: 1, payoutBatches: batch, primaryBridge: cfg.deployment.bitAdapter, rails: { [cfg.deployment.bitAdapter.toLowerCase() as Hex]: { remote: "0x0" as Hex, remoteChainId: 8453n, enabled: true, known: true } } }), pending: [KEY], logs: logs(false) }),
      ),
    ).toEqual([]);
  });
});

describe("stake.min_at_floor's line points to the full top-up (R4) and runbook 7.11", () => {
  it("says a payout that reverts BelowConversionFloor goes out with the full top-up, by the keeper or by hand (runbook 7.11)", () => {
    const line = RUNBOOK["stake.min_at_floor"]({});
    expect(line).toContain("full top-up");
    expect(line).toMatch(/pays the whole bridge fee/);
    expect(line).toContain("runbook 7.11");
    expect(line).not.toMatch(/until the keeper does it|post-contract follow-up/);
  });
});

describe("RedeemDeferred's new causes in the lines that expect it (R4: the hold, a closed rail)", () => {
  it("outflow.near_limit's line says a deferral also comes from the one-day hold and a closed rail", () => {
    const line = RUNBOOK["outflow.near_limit"]({ contracts: "v3.2" });
    expect(line).toContain("RedeemDeferred");
    expect(line).toMatch(/one-day hold/);
    expect(line).toMatch(/rail\.payouts_closed/);
    // v3-launch's line as it was
    expect(RUNBOOK["outflow.near_limit"]({})).toBe("Exits beyond the allowance will be deferred; expect RedeemDeferred.");
  });
});

describe("the rail.alpha_vault runbook line says payouts can't be sent at all during a migration (S-M1)", () => {
  it("v3.2's line", () => {
    const line = RUNBOOK["rail.alpha_vault"]({ contracts: "v3.2" });
    expect(line).not.toContain("payouts revert and wait");
    expect(line).toContain("During a migration no payout can be sent at all");
  });
});

describe("B-H1's off-chain side: unstakes.wash, a deposit and an unstake by one holder under one key or within the hold's window", () => {
  const user = "0x00000000000000000000000000000000000000a1";
  const K1 = `0x${"11".repeat(32)}` as Hex;
  const K2 = `0x${"22".repeat(32)}` as Hex;
  // past the deployment's baseline (6,900,040) by more than two days of blocks
  const B = 6_950_000n;
  // the hold's day and two, in blocks at Bittensor's 12 s (as the test context measures it)
  const HOLD_BLOCKS = holdBlocks(12);
  const WASH_BLOCKS = washBlocks(12);
  const deposited = (key: Hex, block: bigint, who = user) => slog({ contract: "vault", event: "Deposited", args: { key, user: who, assets: String(5n * E18), shares: String(5n * E18) }, block });
  const direct = (block: bigint) => slog({ contract: "vault", event: "DepositedDirect", args: { user, assets: String(5n * E18), shares: String(5n * E18) }, block });
  const redeemed = (key: Hex, block: bigint) => slog({ contract: "vault", event: "Redeemed", args: { key, user, shares: String(4n * E18), assets: String(4n * E18) }, block });
  const deferred = (key: Hex, block: bigint) => slog({ contract: "vault", event: "RedeemDeferred", args: { key, user, requested: String(4n * E18) }, block });
  /** `logs` all stored before this tick but `fresh`, which this tick stores */
  const run = (logs: ReturnType<typeof slog>[], fresh: ReturnType<typeof slog>[]) => unstakesWash.run({ ...ctxOf({ logs: [...logs, ...fresh] }), newUids: new Set(fresh.map((l) => l.uid)) });

  it("is a warning event that never holds, run every tick, with the spec's windows: the hold's day (STAKE_RAMP) for a deferral, two for a burn", () => {
    expect(RULES["unstakes.wash"]).toMatchObject({ tier: "warning", kind: "event", canHold: false });
    expect(TICK_RULES).toContain(unstakesWash);
    expect(HOLD_BLOCKS).toBe(7_200n);
    expect(WASH_BLOCKS).toBe(14_400n);
    expect(WASH_LOOKBACK_S).toBe(2 * 86_400 + 7_200);
    expect(RUNBOOK["unstakes.wash"]({}).length).toBeGreaterThan(40);
  });

  it("the windows are days by time, in blocks at Bittensor's block time as measured: at 6 s a block the day is 14,400 blocks", () => {
    expect(holdBlocks(6)).toBe(14_400n);
    const at6 = (logs: ReturnType<typeof slog>[], fresh: ReturnType<typeof slog>[]) => unstakesWash.run({ ...ctxOf({ logs: [...logs, ...fresh] }), blockS: { base: 0.2, bittensor: 6 }, newUids: new Set(fresh.map((l) => l.uid)) });
    const f = at6([deposited(K1, B - 14_400n)], [deferred(K2, B)]);
    expect(f.map((x) => x.subject)).toEqual(["A holder's unstake was deferred by the one-day hold: a deposit about 24 hours before it"]);
    expect(at6([deposited(K1, B - 14_401n)], [deferred(K2, B)])).toEqual([]);
  });

  it("a deposit and a burn by one holder under one key: the burn took older shares only (the hold), the rotation that crowds the allowance", () => {
    const r = redeemed(K1, B);
    const f = run([], [deposited(K1, B), r]);
    expect(f.map((x) => [x.rule, x.key, x.subject])).toEqual([["unstakes.wash", `unstakes.wash:${r.uid}`, "A holder deposited and unstaked in one batch: the pattern that crowds the daily unstake limit"]]);
    expect(f[0].facts).toMatchObject({ user, key: K1, "the deposit": `5 TAO (Deposited) at block ${B}`, "the unstake": "4 TAO burned", apart: "the same batch" });
  });

  it("a burn within two days of the holder's last deposit (a door's or a direct one), never past it; another holder's deposit is none", () => {
    const r = redeemed(K2, B);
    const f = run([deposited(K1, B - HOLD_BLOCKS)], [r]);
    expect(f.map((x) => x.subject)).toEqual(["A holder unstaked about 24 hours after a deposit: the pattern that crowds the daily unstake limit"]);
    expect(f[0].facts).toMatchObject({ "the deposit": `5 TAO (Deposited) at block ${B - HOLD_BLOCKS}`, apart: "about 24 hours (7200 blocks)" });
    expect(run([direct(B - WASH_BLOCKS)], [redeemed(K2, B)]).map((x) => x.facts["the deposit"])).toEqual([`5 TAO (DepositedDirect) at block ${B - WASH_BLOCKS}`]);
    expect(run([deposited(K1, B - WASH_BLOCKS - 1n)], [redeemed(K2, B)])).toEqual([]);
    expect(run([deposited(K1, B - 10n, "0x00000000000000000000000000000000000000b2")], [redeemed(K2, B)])).toEqual([]);
  });

  it("a fresh-share RedeemDeferred: a deposit within the hold's day before it (the wash refused, or an early unstake); past the day it is the allowance's, none", () => {
    const d = deferred(K1, B);
    const same = run([], [deposited(K1, B), d]);
    expect(same.map((x) => [x.key, x.subject])).toEqual([[`unstakes.wash:${d.uid}`, "A holder's unstake was deferred by the one-day hold: a deposit in the same batch"]]);
    expect(same[0].facts).toMatchObject({ "the unstake": "4000000000000000000 shares asked, nothing burned" });
    expect(run([deposited(K1, B - HOLD_BLOCKS)], [deferred(K2, B)]).map((x) => x.subject)).toEqual(["A holder's unstake was deferred by the one-day hold: a deposit about 24 hours before it"]);
    expect(run([deposited(K1, B - HOLD_BLOCKS - 1n)], [deferred(K2, B)])).toEqual([]);
  });

  it("each unstake once, on the tick it is stored; nothing on v3-launch", () => {
    expect(run([deposited(K1, B), redeemed(K1, B)], [])).toEqual([]);
    const v31 = ruleCtx({ cfg: testConfig(), logs: logQuery([deposited(K1, B), redeemed(K1, B)]) });
    expect(unstakesWash.run(v31)).toEqual([]);
  });
});

describe("the vault-favour review's Low 1: stake.add_fee, the chain kept part of a stake add", () => {
  const staked = (rao: bigint, measured: bigint, txHash: Hex = `0x${"5a".repeat(32)}`) =>
    slog({ contract: "vault", event: "Staked", args: { hotkey: `0x${"11".repeat(32)}`, rao: String(rao), measured: String(measured) }, txHash, block: 9_000_000n });

  it("a warning when Staked's measured stake is more than 1 rao short of what was added: every holder bears it", () => {
    expect(RULES["stake.add_fee"]).toMatchObject({ tier: "warning", kind: "event" });
    expect(TICK_RULES).toContain(stakeAddFee);
    const f = stakeAddFee.run(ctxOf({ logs: [staked(1_000_000_000n, 999_000_000n)] }));
    expect(f.map((x) => [x.rule, x.subject])).toEqual([["stake.add_fee", "The chain kept 0.001 TAO of a stake add: every holder bears it"]]);
    expect(RUNBOOK["stake.add_fee"]({}).length).toBeGreaterThan(40);
  });

  it("quiet for a full add, and within 1 rao (rounding)", () => {
    expect(stakeAddFee.run(ctxOf({ logs: [staked(1_000_000_000n, 1_000_000_000n), staked(1_000_000_000n, 999_999_999n, `0x${"5b".repeat(32)}`)] }))).toEqual([]);
  });
});
