import { type Due, type Finding, markSent, reconcile } from "./alerts.ts";
import type { Config } from "./config.ts";
import { renderCritical, sendAll } from "./email.ts";
import { utc } from "./rules/context.ts";
import { RULES } from "./rules/ids.ts";
import { RUNBOOK } from "./runbook.ts";
import { type AlertRow, alertOf, pruneHours, pruneReadings, returnedIds, setMeta } from "./store.ts";

// The hourly job (minute 17): the watchdog, and pruning. The watchdog is the one thing besides the tick that
// sends alert email: a tick killed for CPU commits nothing, so only another job can notice it (spec 1).

export interface JobDeps {
  env: { DB: D1Database; EMAIL?: SendEmail };
  cfg: Config;
  /** when the job runs, seconds */
  nowS: number;
}

const num = (s: string | undefined) => (s === undefined || s === "" || !Number.isFinite(Number(s)) ? undefined : Number(s));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface WatchdogResult {
  /** no complete tick for longer than stalledS (or the database couldn't be read) */
  stalled: boolean;
  /** the alert is recorded in D1 */
  recorded: boolean;
  /** an email went out (from the record, or straight from memory) */
  emailed: boolean;
}

/** The monitor.stalled finding, and the email due for it built from memory alone. */
function stalledFinding(lastTick: number | undefined, nowS: number, error?: string): Finding {
  const facts: Record<string, string> = { "last complete tick": lastTick === undefined ? "never" : utc(lastTick), "checked at": utc(nowS) };
  if (error) facts["the database"] = `couldn't be read: ${error.slice(0, 200)}`;
  const minutes = lastTick === undefined ? undefined : Math.floor((nowS - lastTick) / 60);
  return {
    rule: "monitor.stalled",
    key: "monitor.stalled",
    subject: error ? "The monitor's watchdog can't read its database" : minutes === undefined ? "No tick of the monitor has completed yet" : `No tick of the monitor has completed for ${minutes} minutes`,
    facts,
  };
}

const fromMemory = (f: Finding, nowS: number): Due => ({
  key: f.key,
  rule: f.rule,
  tier: "critical",
  kind: RULES[f.rule].kind,
  subject: f.subject,
  body: Object.entries(f.facts)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n"),
  runbook: RUNBOOK[f.rule](f.facts),
  reason: "alert",
  openedAt: nowS,
  notifyCount: 0,
});

/** The watchdog (the hourly and daily jobs): when meta.last_complete_tick is more than stalledS old, the
 * critical monitor.stalled is recorded and emailed by the job itself, re-sent hourly while unacknowledged
 * (at most criticalMaxSends times); the next complete tick resolves it. It never depends on D1 being
 * writable: when the record can't be written, or the database can't even be read, the email goes out
 * straight from memory, at most once per job run. A database no tick ever completed in is given stalledS
 * from when the watchdog first saw it so (meta.watchdog_since). */
export async function watchdog(deps: JobDeps): Promise<WatchdogResult> {
  const { cfg, nowS } = deps;
  const db = deps.env.DB;
  const t = cfg.thresholds;
  let meta: Record<string, string>;
  let open: AlertRow[];
  try {
    const rs = await db.batch<Record<string, unknown>>([
      db.prepare("SELECT k, v FROM meta WHERE k IN ('last_complete_tick', 'watchdog_since')"),
      db.prepare("SELECT * FROM alerts WHERE alert_key = 'monitor.stalled' AND resolved_at IS NULL"),
    ]);
    meta = Object.fromEntries(rs[0].results.map((r) => [r.k as string, r.v as string]));
    open = rs[1].results.map(alertOf);
  } catch (e) {
    console.error(`watchdog: the database can't be read: ${message(e)}`);
    const sent = await sendAll(deps.env, cfg, [{ id: 0, ...renderCritical({ due: fromMemory(stalledFinding(undefined, nowS, message(e)), nowS) }) }]);
    return { stalled: true, recorded: false, emailed: sent.sent.length > 0 };
  }

  const last = num(meta.last_complete_tick);
  let since = last;
  if (last === undefined) {
    since = num(meta.watchdog_since);
    if (since === undefined) {
      try {
        await setMeta(db, "watchdog_since", String(nowS)).run();
      } catch (e) {
        console.error(`watchdog: couldn't note when it first looked: ${message(e)}`);
      }
      return { stalled: false, recorded: false, emailed: false };
    }
  }
  if (nowS - (since as number) <= t.stalledS) return { stalled: false, recorded: false, emailed: false };

  const finding = stalledFinding(last, nowS);
  // the alert lifecycle for this one key: opened, or re-sent hourly while unacknowledged (resolved by the tick)
  const r = reconcile(db, { open, findings: [finding], nowS, t, holdActive: false });
  let ids: ReturnType<typeof returnedIds> | undefined;
  try {
    ids = returnedIds(await db.batch(r.statements));
  } catch (e) {
    // the record can't be written: email it straight from memory (this job's cadence is the rate limit)
    console.error(`watchdog: monitor.stalled couldn't be recorded: ${message(e)}`);
    const due = r.due[0] ?? fromMemory(finding, nowS);
    const sent = await sendAll(deps.env, cfg, [{ id: 0, ...renderCritical({ due, alertId: open[0]?.id }) }]);
    return { stalled: true, recorded: false, emailed: sent.sent.length > 0 };
  }
  const due = r.due.filter((d) => d.key === finding.key && d.reason !== "resolved");
  if (due.length === 0) return { stalled: true, recorded: true, emailed: false };
  const alertId = ids.alerts.get(finding.key) ?? open[0]?.id;
  const sent = await sendAll(deps.env, cfg, [{ id: 0, ...renderCritical({ due: due[0], alertId }) }]);
  if (sent.sent.length) {
    try {
      await db.batch(markSent(db, due, nowS));
    } catch (e) {
      console.error(`watchdog: the email couldn't be marked sent: ${message(e)}`);
    }
  }
  return { stalled: true, recorded: true, emailed: sent.sent.length > 0 };
}

/** The hourly job: the watchdog, then readings pruned to the newest 120 and hour rows to 35 days. The hour
 * rows themselves are kept up to date by every tick (there is nothing to close). */
export async function runHourly(deps: JobDeps): Promise<{ watchdog: WatchdogResult; pruned: boolean }> {
  const w = await watchdog(deps);
  const db = deps.env.DB;
  let pruned = false;
  try {
    await db.batch([pruneReadings(db, 120), pruneHours(db, deps.nowS, 35)]);
    pruned = true;
  } catch (e) {
    console.error(`hourly: pruning failed: ${message(e)}`);
  }
  return { watchdog: w, pruned };
}
