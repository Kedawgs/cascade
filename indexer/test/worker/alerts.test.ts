import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { type Finding, markSent, reconcile } from "../../src/alerts.ts";
import { RULES, type RuleId } from "../../src/rules/ids.ts";
import { RUNBOOK } from "../../src/runbook.ts";
import { loadTickState } from "../../src/store.ts";
import { DEFAULTS, mergeThresholds } from "../../src/thresholds.ts";
import { wipe } from "./d1-count.ts";

const db = env.DB;
const T0 = 1_800_000_000;

const finding = (rule: RuleId, key: string, o: Partial<Finding> = {}): Finding => ({ rule, key, subject: `${rule} ${key}`, facts: { what: "it happened" }, ...o });

/** One tick of the alert lifecycle against D1: reconcile, commit, then mark what was due as sent. */
async function tick(nowS: number, findings: Finding[], o: { holdActive?: boolean; t?: typeof DEFAULTS; send?: boolean } = {}) {
  const state = await loadTickState(db, nowS);
  const lastWarning = state.meta.last_warning_at === undefined ? undefined : Number(state.meta.last_warning_at);
  const r = reconcile(db, { open: state.openAlerts, findings, nowS, t: o.t ?? DEFAULTS, holdActive: o.holdActive ?? false, lastWarningSentAt: lastWarning });
  if (r.statements.length) await db.batch(r.statements);
  const marks = o.send === false ? [] : markSent(db, r.due, nowS);
  if (marks.length) await db.batch(marks);
  return r;
}
const rows = async () => (await db.prepare("SELECT alert_key, rule, resolved_at, notify_count, notified_at FROM alerts ORDER BY id").all()).results;

beforeEach(async () => {
  await wipe(db);
});

describe("the rules and their runbook lines", () => {
  it("every rule has a runbook line, filled from its facts", () => {
    expect(Object.keys(RULES).length).toBeGreaterThan(45);
    for (const id of Object.keys(RULES) as RuleId[]) {
      const line = RUNBOOK[id]({});
      expect(line.length, id).toBeGreaterThan(20);
    }
    expect(RUNBOOK["bridge.batch_mismatch"]({ deadline: "2026-11-01 13:00 UTC" })).toContain("2026-11-01 13:00 UTC");
  });

  it("names a tier and kind for every rule, and which can hold or are muted by one", () => {
    expect(RULES["bridge.batch_mismatch"]).toEqual({ tier: "critical", kind: "event", canHold: true, mutedByHold: false });
    expect(RULES["frontdoor.solvency"]).toMatchObject({ tier: "critical", kind: "condition", canHold: true });
    expect(RULES["payout.overdue"]).toMatchObject({ tier: "warning", kind: "condition", mutedByHold: true });
    expect(RULES["admin.event"]).toMatchObject({ canHold: false });
  });
});

describe("criticals", () => {
  it("are due at once, then not again next tick, and are never duplicated", async () => {
    const f = finding("vault.solvency", "vault.solvency");
    const first = await tick(T0, [f]);
    expect(first.due.map((x) => [x.key, x.reason])).toEqual([["vault.solvency", "alert"]]);
    const second = await tick(T0 + 60, [f]);
    expect(second.due).toEqual([]);
    expect(await rows()).toHaveLength(1);
  });

  it("are sent again every hour while open and unacknowledged, at most six times", async () => {
    const f = finding("vault.solvency", "vault.solvency");
    await tick(T0, [f]);
    expect((await tick(T0 + 3599, [f])).due).toEqual([]);
    expect((await tick(T0 + 3600, [f])).due.map((x) => x.reason)).toEqual(["resend"]);
    for (let n = 2; n < 6; n++) expect((await tick(T0 + 3600 * n, [f])).due).toHaveLength(1);
    expect((await rows())[0].notify_count).toBe(6);
    expect((await tick(T0 + 3600 * 6, [f])).due).toEqual([]);
  });

  it("are not sent again once acknowledged", async () => {
    const f = finding("vault.solvency", "vault.solvency");
    await tick(T0, [f]);
    await db.prepare("UPDATE alerts SET acknowledged_at = ?").bind(T0 + 10).run();
    expect((await tick(T0 + 3600, [f])).due).toEqual([]);
  });

  it("are due as resolved when a condition clears", async () => {
    await tick(T0, [finding("vault.solvency", "vault.solvency")]);
    const r = await tick(T0 + 60, []);
    expect(r.due.map((x) => [x.key, x.reason])).toEqual([["vault.solvency", "resolved"]]);
    expect((await rows())[0].resolved_at).toBe(T0 + 60);
  });

  it("an event stays open when it isn't found again, with nothing due, and closes quietly after 7 days", async () => {
    await tick(T0, [finding("admin.event", "admin.event:0xabc#0")]);
    expect((await tick(T0 + 60, [])).due).toEqual([]);
    expect((await rows())[0].resolved_at).toBeNull();
    // still open (and, unacknowledged, sent again hourly like any critical)
    await tick(T0 + 7 * 86400 - 1, []);
    expect((await rows())[0].resolved_at).toBeNull();
    const closing = await tick(T0 + 7 * 86400, []);
    expect(closing.due).toEqual([]);
    expect((await rows())[0].resolved_at).toBe(T0 + 7 * 86400);
  });

  it("an acknowledged event closes when it is no longer found", async () => {
    await tick(T0, [finding("admin.event", "admin.event:0xabc#0")]);
    await db.prepare("UPDATE alerts SET acknowledged_at = ?").bind(T0 + 10).run();
    await tick(T0 + 60, []);
    expect((await rows())[0].resolved_at).toBe(T0 + 60);
  });
});

describe("warnings", () => {
  it("go out together, at most every 30 minutes", async () => {
    // a warning email went out at T0
    await db.prepare("INSERT INTO meta (k, v) VALUES ('last_warning_at', ?)").bind(String(T0)).run();
    const a = finding("keeper.low_eth", "keeper.low_eth");
    const b = finding("adapter.low_reserve", "adapter.low_reserve");
    expect((await tick(T0 + 60, [a])).due).toEqual([]);
    expect((await tick(T0 + 660, [a, b])).due).toEqual([]);
    const together = await tick(T0 + 1800, [a, b]);
    expect(together.due.map((x) => x.key).sort()).toEqual(["adapter.low_reserve", "keeper.low_eth"]);
    // sent once: not again
    expect((await tick(T0 + 3600, [a, b])).due).toEqual([]);
  });

  it("go out at once when none has gone out for 30 minutes, and resolve quietly", async () => {
    const r = await tick(T0, [finding("keeper.low_eth", "keeper.low_eth")]);
    expect(r.due.map((x) => x.reason)).toEqual(["alert"]);
    expect((await tick(T0 + 60, [])).due).toEqual([]);
    expect((await rows())[0].resolved_at).toBe(T0 + 60);
  });
});

describe("what is dropped", () => {
  it("drops payout.overdue and batch.past_max_wait while a hold is on", async () => {
    const r = await tick(T0, [finding("payout.overdue", "payout.overdue:0x01"), finding("batch.past_max_wait", "batch.past_max_wait"), finding("keeper.low_eth", "keeper.low_eth")], { holdActive: true });
    expect((await rows()).map((x) => x.rule)).toEqual(["keeper.low_eth"]);
    expect(r.due.map((x) => x.rule)).toEqual(["keeper.low_eth"]);
  });

  it("drops a rule switched off in THRESHOLDS", async () => {
    const t = mergeThresholds('{"rules":{"off":["fmtao.mint_surge"]}}', undefined);
    await tick(T0, [finding("fmtao.mint_surge", "fmtao.mint_surge:1"), finding("keeper.low_eth", "keeper.low_eth")], { t });
    expect((await rows()).map((x) => x.rule)).toEqual(["keeper.low_eth"]);
  });

  it("leaves a quieted alert alone: an open one isn't resolved or sent again, and a new one isn't opened", async () => {
    // indexer.blind on Bittensor opened and sent; then Bittensor is quieted (catching up), Base isn't
    await tick(T0, [finding("indexer.blind", "indexer.blind:bittensor"), finding("indexer.blind", "indexer.blind:base")]);
    const state = await loadTickState(db, T0 + 3600);
    const quiet = (a: { rule: string; key: string }) => a.key === "indexer.blind:bittensor" || a.rule === "bridge.check_stuck";
    const r = reconcile(db, {
      open: state.openAlerts,
      findings: [finding("indexer.blind", "indexer.blind:bittensor"), finding("bridge.check_stuck", "bridge.check_stuck:1:0xk")],
      nowS: T0 + 3600,
      t: DEFAULTS,
      holdActive: false,
      quiet,
    });
    if (r.statements.length) await db.batch(r.statements);
    // Bittensor's: neither resolved nor due again (an hour on, a resend would be due); Base's, not quieted and
    // not found, resolves as usual; the quieted check_stuck opens nothing
    expect(r.due.map((x) => [x.key, x.reason])).toEqual([["indexer.blind:base", "resolved"]]);
    expect(await rows()).toEqual([
      expect.objectContaining({ alert_key: "indexer.blind:bittensor", resolved_at: null }),
      expect.objectContaining({ alert_key: "indexer.blind:base", resolved_at: T0 + 3600 }),
    ]);
  });

  it("never returns a hold for a rule that can't hold", async () => {
    const r = await tick(T0, [
      finding("admin.event", "admin.event:1", { hold: { id: "admin.event:1", summary: "no" } }),
      finding("vault.solvency", "vault.solvency", { hold: { id: "vault.solvency:6905000", summary: "the vault can't cover its payouts" } }),
    ]);
    expect(r.holds).toEqual([{ id: "vault.solvency:6905000", rule: "vault.solvency", summary: "the vault can't cover its payouts" }]);
  });
});

describe("the stored alert", () => {
  it("carries the subject, the facts and the runbook line", async () => {
    await tick(T0, [finding("bridge.batch_mismatch", "bridge.batch:42:0x07531aa4", { subject: "Batch 42 failed the cross-check", facts: { batch: "42", step: "the key", deadline: "2026-11-01 13:00 UTC" } })]);
    const row = await db.prepare("SELECT subject, body, runbook, tier, kind FROM alerts").first<Record<string, string>>();
    expect(row?.subject).toBe("Batch 42 failed the cross-check");
    expect(row?.body).toContain("step: the key");
    expect(row?.runbook).toContain("2026-11-01 13:00 UTC");
    expect([row?.tier, row?.kind]).toEqual(["critical", "event"]);
  });
});
