import { RULES, type RuleId } from "./rules/ids.ts";
import { RUNBOOK } from "./runbook.ts";
import { type AlertRow, setMeta } from "./store.ts";
import type { Thresholds } from "./thresholds.ts";

// The alert lifecycle (spec sections 6 and 7): one alert per stable key, opened by a finding, kept while
// found, resolved by kind; which emails are due. Every alert is committed (commit 1) before its email is
// sent, and marked sent after (commit 2).

/** What a rule found. `key` is stable for as long as the thing it describes lasts (e.g. "bridge.batch:42"),
 * so a finding that persists is one alert, not one per tick. */
export interface Finding {
  rule: RuleId;
  key: string;
  subject: string;
  /** what happened, as name → value lines (explorer links and hashes only) */
  facts: Record<string, string>;
  /** a hold this finding raises (only for a rule that can hold) */
  hold?: { id: string; summary: string };
}

/** An email due this tick: a new alert, a critical's hourly resend, or a critical condition that cleared. */
export interface Due {
  key: string;
  rule: RuleId;
  tier: "critical" | "warning";
  kind: "condition" | "event";
  subject: string;
  body: string;
  runbook: string;
  reason: "alert" | "resend" | "resolved";
  openedAt: number;
  /** how often it was sent before */
  notifyCount: number;
}

/** An event alert not found any more closes quietly this long after it opened (or once acknowledged). */
export const EVENT_CLOSES_AFTER_S = 7 * 86400;

export const renderFacts = (facts: Record<string, string>): string =>
  Object.entries(facts)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

interface Live {
  key: string;
  rule: RuleId;
  tier: Due["tier"];
  kind: Due["kind"];
  subject: string;
  body: string;
  runbook: string;
  openedAt: number;
  notifiedAt: number | null;
  notifyCount: number;
  acknowledgedAt: number | null;
}

const asDue = (a: Live, reason: Due["reason"]): Due => ({
  key: a.key,
  rule: a.rule,
  tier: a.tier,
  kind: a.kind,
  subject: a.subject,
  body: a.body,
  runbook: a.runbook,
  reason,
  openedAt: a.openedAt,
  notifyCount: a.notifyCount,
});

/** This tick's alert changes, the emails due, and the holds the findings raise.
 *
 * - Findings of rules switched off (`rules.off`), and of rules a hold mutes while one is on, are dropped.
 * - A new key opens an alert; a key still found updates its last-seen time (and its facts).
 * - A *condition* not found any more resolves; a critical one that was sent is due again as "resolved".
 *   An *event* not found any more stays open until acknowledged, or closes quietly 7 days after opening.
 * - A critical is due when never sent, and again every `criticalResendS` while open and unacknowledged,
 *   at most `criticalMaxSends` times in all. Warnings are due once each, all together, when the last
 *   warning email is at least `warningEveryS` old.
 * - Holds come only from rules that can hold. */
export function reconcile(
  db: D1Database,
  o: { open: readonly AlertRow[]; findings: readonly Finding[]; nowS: number; t: Thresholds; holdActive: boolean; lastWarningSentAt?: number },
): { statements: D1PreparedStatement[]; due: Due[]; holds: { id: string; rule: RuleId; summary: string }[] } {
  const { nowS, t } = o;
  const off = new Set(t.rules.off);
  const kept = new Map<string, Finding>();
  for (const f of o.findings) {
    if (off.has(f.rule) || (o.holdActive && RULES[f.rule].mutedByHold) || kept.has(f.key)) continue;
    kept.set(f.key, f);
  }
  const open = new Map(o.open.map((a) => [a.alertKey, a]));
  const statements: D1PreparedStatement[] = [];
  const due: Due[] = [];
  const live: Live[] = [];

  const insert = db.prepare(
    "INSERT INTO alerts (alert_key, rule, tier, kind, subject, body, runbook, opened_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8) RETURNING id, alert_key",
  );
  const seen = db.prepare("UPDATE alerts SET last_seen_at = ?1, subject = ?2, body = ?3, runbook = ?4 WHERE id = ?5");
  const resolve = db.prepare("UPDATE alerts SET resolved_at = ?1 WHERE id = ?2");

  for (const f of kept.values()) {
    const spec = RULES[f.rule];
    const body = renderFacts(f.facts);
    const runbook = RUNBOOK[f.rule](f.facts);
    const a = open.get(f.key);
    if (a) {
      statements.push(seen.bind(nowS, f.subject, body, runbook, a.id));
      live.push({ key: f.key, rule: f.rule, tier: spec.tier, kind: spec.kind, subject: f.subject, body, runbook, openedAt: a.openedAt, notifiedAt: a.notifiedAt, notifyCount: a.notifyCount, acknowledgedAt: a.acknowledgedAt });
    } else {
      statements.push(insert.bind(f.key, f.rule, spec.tier, spec.kind, f.subject, body, runbook, nowS));
      live.push({ key: f.key, rule: f.rule, tier: spec.tier, kind: spec.kind, subject: f.subject, body, runbook, openedAt: nowS, notifiedAt: null, notifyCount: 0, acknowledgedAt: null });
    }
  }

  for (const a of o.open) {
    if (kept.has(a.alertKey)) continue;
    const row: Live = {
      key: a.alertKey,
      rule: a.rule as RuleId,
      tier: a.tier,
      kind: a.kind,
      subject: a.subject,
      body: a.body,
      runbook: a.runbook,
      openedAt: a.openedAt,
      notifiedAt: a.notifiedAt,
      notifyCount: a.notifyCount,
      acknowledgedAt: a.acknowledgedAt,
    };
    if (a.kind === "condition") {
      statements.push(resolve.bind(nowS, a.id));
      if (a.tier === "critical" && a.notifiedAt !== null) due.push(asDue(row, "resolved"));
    } else if (a.acknowledgedAt !== null || nowS - a.openedAt >= EVENT_CLOSES_AFTER_S) {
      // an event closes quietly: never a "resolved" email
      statements.push(resolve.bind(nowS, a.id));
    } else {
      live.push(row);
    }
  }

  const warningsDue = o.lastWarningSentAt === undefined || nowS - o.lastWarningSentAt >= t.warningEveryS;
  for (const a of live) {
    if (a.tier === "critical") {
      if (a.acknowledgedAt !== null) continue;
      if (a.notifiedAt === null) due.push(asDue(a, "alert"));
      else if (nowS - a.notifiedAt >= t.criticalResendS && a.notifyCount < t.criticalMaxSends) due.push(asDue(a, "resend"));
    } else if (a.notifiedAt === null && warningsDue) {
      due.push(asDue(a, "alert"));
    }
  }

  const holds = [...kept.values()].flatMap((f) => (f.hold && RULES[f.rule].canHold ? [{ id: f.hold.id, rule: f.rule, summary: f.hold.summary }] : []));
  return { statements, due, holds };
}

/** Commit 2: the emails that went out, marked sent (and when the last warnings went out). A "resolved"
 * email needs no mark: its alert was resolved in commit 1. */
export function markSent(db: D1Database, sent: readonly Pick<Due, "key" | "tier" | "reason">[], nowS: number): D1PreparedStatement[] {
  const stmt = db.prepare("UPDATE alerts SET notified_at = ?1, notify_count = notify_count + 1 WHERE alert_key = ?2 AND resolved_at IS NULL");
  const out = sent.filter((s) => s.reason !== "resolved").map((s) => stmt.bind(nowS, s.key));
  if (sent.some((s) => s.tier === "warning" && s.reason !== "resolved")) out.push(setMeta(db, "last_warning_at", String(nowS)));
  return out;
}
