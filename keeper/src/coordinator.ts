import { DurableObject } from "cloudflare:workers";
import type { JournalRow } from "../../ops/src/keeper/core/journal.ts";
import { fromJson, type KeeperMemory, toJson } from "../../ops/src/keeper/core/memory.ts";
import { CRON_LEASE_MS, HAND_LEASE_MS, HAND_WAIT_MS, RUNS_KEPT_MS } from "./config.ts";
import { PATCH_FIELDS, statusAfter } from "./journal.ts";
import type { StoredRow } from "./proof.ts";

// The keeper's one Durable Object per deployment (design-keeper-worker.md §3, §4): the lease, the kill switch and the
// deliveries switch, the round's memory, the send journal and the runs log, all in its own SQLite storage, so the lease
// check and the state write it fences are one atomic step. Every method runs without awaiting anything, so each is all
// or nothing. Times come from this object's clock only: callers send durations, never times.

export type LeaseKind = "cron" | "hand";

export interface Lease {
  holder: string | null;
  kind: LeaseKind | null;
  /** The fencing number: up by one each time the lease changes hands (an acquire after it was free, a break) */
  token: number;
  since: number;
  until: number;
  /** A hand run refused while a cron run held the lease: the next cron waits for it until `wantedUntil` */
  wantedBy: string | null;
  wantedUntil: number;
}

export interface Control {
  stopped: boolean;
  /** Why, who and when (a person's stop, or the keeper's own: by "the keeper itself") */
  reason: string | null;
  by: string | null;
  at: number | null;
  deliveries: boolean;
  deliveriesBy: string | null;
  deliveriesAt: number | null;
}

export type Acquired =
  | { granted: true; token: number; until: number; now: number; renewed: boolean; control: Control; load?: { memory: string | null; pending: string; host: string | null } }
  | { granted: false; why: "stopped"; now: number; control: Control }
  | { granted: false; why: "held" | "wanted"; now: number; holder: string; kind: LeaseKind; until: number };

export type Fenced = { ok: true; until?: number } | { ok: false; why: string };

/** A journal row's change, applied by its hash in a commit (design §5: the status moves in the same commit as the
 * memory): its status, receipt, bridge message, what came back, and the settling's mark (passedAt, its reset to 0
 * included: Task 51's two readings a block apart before a drop). Only these (PATCH_FIELDS: the re-review's N2). */
export interface JournalPatch {
  hash: string;
  patch: Partial<Pick<JournalRow, (typeof PATCH_FIELDS)[number]>>;
}

/** What a row is when written ahead, and nothing more: a field a later step sets (a receipt, a mark, the first raw a
 * replacement keeps) never comes in with the write-ahead. */
const AHEAD_FIELDS = ["chain", "from", "nonce", "hashes", "request", "raw", "status", "at"] as const;

export interface Commit {
  holder: string;
  token: number;
  /** encodeMemory's text; absent: the stored memory is left as it is */
  memory?: string;
  /** JSON (memory.ts toJson) of JournalPatch[] */
  journal?: string;
  host?: string;
  lines?: string[];
  /** The keeper stopped itself: saved, so later crons don't run until `start` */
  stop?: string;
  release?: boolean;
}

const MAX_TTL: Record<LeaseKind, number> = { cron: 2 * CRON_LEASE_MS, hand: 2 * HAND_LEASE_MS };
const FRESH_STOP = "a new keeper starts stopped: check pnpm ops keeper status, then pnpm ops keeper start";

export class KeeperCoordinator extends DurableObject {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK (id = 1), holder TEXT, kind TEXT, token INTEGER NOT NULL,
        since INTEGER NOT NULL, until INTEGER NOT NULL, wanted_by TEXT, wanted_until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS control (id INTEGER PRIMARY KEY CHECK (id = 1), stopped INTEGER NOT NULL, reason TEXT, by TEXT,
        at INTEGER, deliveries INTEGER NOT NULL, deliveries_by TEXT, deliveries_at INTEGER);
      CREATE TABLE IF NOT EXISTS memory (id INTEGER PRIMARY KEY CHECK (id = 1), text TEXT NOT NULL, v INTEGER, token INTEGER, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS host (id INTEGER PRIMARY KEY CHECK (id = 1), text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal (id INTEGER PRIMARY KEY AUTOINCREMENT, chain TEXT NOT NULL, sender TEXT NOT NULL,
        nonce INTEGER NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL, hashes TEXT NOT NULL, row TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal_hashes (hash TEXT PRIMARY KEY, row_id INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS journal_status ON journal (status);
      CREATE INDEX IF NOT EXISTS journal_at ON journal (at);
      CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, token INTEGER, holder TEXT, line TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_at ON runs (at);
    `);
  }

  // ---- reading the rows

  private lease(): Lease {
    const r = this.sql.exec("SELECT holder, kind, token, since, until, wanted_by, wanted_until FROM lease WHERE id = 1").toArray()[0];
    if (!r) return { holder: null, kind: null, token: 0, since: 0, until: 0, wantedBy: null, wantedUntil: 0 };
    return {
      holder: r.holder as string | null,
      kind: r.kind as LeaseKind | null,
      token: Number(r.token),
      since: Number(r.since),
      until: Number(r.until),
      wantedBy: r.wanted_by as string | null,
      wantedUntil: Number(r.wanted_until),
    };
  }

  private writeLease(l: Lease) {
    this.sql.exec(
      "INSERT OR REPLACE INTO lease (id, holder, kind, token, since, until, wanted_by, wanted_until) VALUES (1, ?, ?, ?, ?, ?, ?, ?)",
      l.holder,
      l.kind,
      l.token,
      l.since,
      l.until,
      l.wantedBy,
      l.wantedUntil,
    );
  }

  private control(): Control {
    const r = this.sql.exec("SELECT stopped, reason, by, at, deliveries, deliveries_by, deliveries_at FROM control WHERE id = 1").toArray()[0];
    // a fresh object has no control row, and that reads as stopped: a first deploy sends nothing until `start`
    if (!r) return { stopped: true, reason: FRESH_STOP, by: null, at: null, deliveries: true, deliveriesBy: null, deliveriesAt: null };
    return {
      stopped: Number(r.stopped) === 1,
      reason: r.reason as string | null,
      by: r.by as string | null,
      at: r.at === null ? null : Number(r.at),
      deliveries: Number(r.deliveries) === 1,
      deliveriesBy: r.deliveries_by as string | null,
      deliveriesAt: r.deliveries_at === null ? null : Number(r.deliveries_at),
    };
  }

  private writeControl(c: Control) {
    this.sql.exec(
      "INSERT OR REPLACE INTO control (id, stopped, reason, by, at, deliveries, deliveries_by, deliveries_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)",
      c.stopped ? 1 : 0,
      c.reason,
      c.by,
      c.at,
      c.deliveries ? 1 : 0,
      c.deliveriesBy,
      c.deliveriesAt,
    );
  }

  private line(line: string, l?: Pick<Lease, "token" | "holder">) {
    this.sql.exec("INSERT INTO runs (at, token, holder, line) VALUES (?, ?, ?, ?)", Date.now(), l?.token ?? null, l?.holder ?? null, line);
  }

  private memoryText(): string | null {
    return (this.sql.exec("SELECT text FROM memory WHERE id = 1").toArray()[0]?.text as string | undefined) ?? null;
  }

  private pendingRows(): JournalRow[] {
    return this.sql
      .exec("SELECT row FROM journal WHERE status IN ('signed', 'sent') ORDER BY id")
      .toArray()
      .map((r) => fromJson<JournalRow>(r.row as string));
  }

  /** Why `holder` may not write with `token` (none: it may). `valid`: its lease must not have run out (a send);
   * `cronStop`: a cron holder may not while the kill switch is on (a send). */
  private fence(holder: string, token: number, o: { valid?: boolean; cronStop?: boolean } = {}): string | undefined {
    const l = this.lease();
    if (l.holder !== holder || l.token !== token) {
      return l.holder ? `the lease is no longer this run's: ${l.holder} holds it (token ${l.token})` : `the lease is no longer this run's (it was released or broken; token ${l.token})`;
    }
    if (o.valid && Date.now() >= l.until) return `this run's lease ran out at ${new Date(l.until).toISOString()}`;
    if (o.cronStop && l.kind === "cron") {
      const c = this.control();
      if (c.stopped) return `the keeper is stopped (${c.reason ?? "no reason given"})`;
    }
    return undefined;
  }

  // ---- the lease (design §3)

  /** The lease for `holder`: granted when free or past its end (the token goes up by one), or as a renew to the same
   * holder; otherwise refused naming who holds it and until when. A cron acquire is also refused while the kill switch
   * is on, and while a hand run waits for the lease. With `load`, the grant brings the memory, the journal's unsettled
   * rows and the host's state (one call for the run's start). */
  acquire(req: { holder: string; kind: LeaseKind; ttlMs: number; load?: boolean }): Acquired {
    const now = Date.now();
    const kind: LeaseKind = req.kind === "hand" ? "hand" : "cron";
    const ttl = Math.max(1, Math.min(Math.floor(req.ttlMs), MAX_TTL[kind]));
    const c = this.control();
    if (kind === "cron" && c.stopped) return { granted: false, why: "stopped", now, control: c };
    const l = this.lease();
    const free = l.holder === null || now >= l.until;
    if (!free && l.holder !== req.holder) {
      if (kind === "hand" && l.kind === "cron") {
        l.wantedBy = req.holder;
        l.wantedUntil = now + HAND_WAIT_MS;
        this.writeLease(l);
      }
      return { granted: false, why: "held", now, holder: l.holder as string, kind: l.kind as LeaseKind, until: l.until };
    }
    if (free && kind === "cron" && l.wantedBy && now < l.wantedUntil) {
      return { granted: false, why: "wanted", now, holder: l.wantedBy, kind: "hand", until: l.wantedUntil };
    }
    const next: Lease = {
      holder: req.holder,
      kind,
      token: free ? l.token + 1 : l.token,
      since: free ? now : l.since,
      until: now + ttl,
      wantedBy: kind === "hand" && l.wantedBy === req.holder ? null : l.wantedBy,
      wantedUntil: kind === "hand" && l.wantedBy === req.holder ? 0 : l.wantedUntil,
    };
    this.writeLease(next);
    if (free && kind === "hand") this.line(`LEASE taken by a hand run: ${req.holder} (token ${next.token}, until ${new Date(next.until).toISOString()})`, next);
    const load = req.load ? { memory: this.memoryText(), pending: toJson(this.pendingRows()), host: (this.sql.exec("SELECT text FROM host WHERE id = 1").toArray()[0]?.text as string | undefined) ?? null } : undefined;
    return { granted: true, token: next.token, until: next.until, now, renewed: !free, control: c, ...(load ? { load } : {}) };
  }

  /** Renews `holder`'s lease: only while it still holds that token and its lease has not run out; a cron renew also
   * fails once the kill switch is on. Every send renews first. */
  renew(req: { holder: string; token: number; ttlMs: number }): Fenced {
    const why = this.fence(req.holder, req.token, { valid: true, cronStop: true });
    if (why) return { ok: false, why };
    const l = this.lease();
    l.until = Date.now() + Math.max(1, Math.min(Math.floor(req.ttlMs), MAX_TTL[l.kind ?? "cron"]));
    this.writeLease(l);
    return { ok: true, until: l.until };
  }

  /** Frees `holder`'s lease (only its own, by its token). A run that dies never releases: its lease runs out. */
  release(req: { holder: string; token: number }): Fenced {
    const why = this.fence(req.holder, req.token);
    if (why) return { ok: false, why };
    const l = this.lease();
    if (l.kind === "hand") this.line(`LEASE released by the hand run ${req.holder} (token ${l.token})`, l);
    this.writeLease({ ...l, holder: null, kind: null, until: 0 });
    return { ok: true };
  }

  /** `pnpm ops keeper lease --break`: frees the lease at once, whoever holds it, and logs who did it. The token goes up,
   * so the old holder's next renew, write or commit fails. */
  breakLease(req: { by: string }): { was: Lease } {
    const l = this.lease();
    const line = l.holder
      ? `LEASE BROKEN by ${req.by}: it was ${l.holder}'s (${l.kind}, token ${l.token}, until ${new Date(l.until).toISOString()})`
      : `LEASE BROKEN by ${req.by}: it was free (token ${l.token})`;
    const next: Lease = { holder: null, kind: null, token: l.token + 1, since: 0, until: 0, wantedBy: null, wantedUntil: 0 };
    this.writeLease(next);
    this.line(line, next);
    return { was: l };
  }

  // ---- the journal (design §4, §5)

  /** A send's row, before its broadcast: refused (nothing may be broadcast) unless `holder` still holds a lease that
   * has not run out, and, for a cron run, the kill switch is off. */
  writeAhead(req: { holder: string; token: number; row: string }): Fenced {
    const why = this.fence(req.holder, req.token, { valid: true, cronStop: true });
    if (why) return { ok: false, why };
    const sent = fromJson<JournalRow>(req.row);
    const row = Object.fromEntries(AHEAD_FIELDS.filter((k) => sent[k] !== undefined).map((k) => [k, sent[k]])) as unknown as JournalRow;
    // a hand run's row is timed by this object's clock (the re-review's N2: callers send durations, never times; a time
    // of the caller's own could bring its replacement forward); a cron run's by its run's clock, the round's own
    if (this.lease().kind === "hand") row.at = Date.now();
    // who wrote it (the review's W1): a hand run changes only its own rows over the route
    (row as StoredRow).writer = req.holder;
    const known = this.rowHolding(row.hashes[0]);
    if (known) {
      // the same signed bytes again (the same call, nonce and fees): a row marked never sent is open once more, its writer's
      if (known.row.status === "never-sent") this.saveRow(known.id, { ...known.row, status: "signed", at: row.at, writer: req.holder } as StoredRow);
      return { ok: true };
    }
    this.sql.exec(
      "INSERT INTO journal (chain, sender, nonce, status, at, hashes, row) VALUES (?, ?, ?, ?, ?, ?, ?)",
      row.chain,
      row.from.toLowerCase(),
      row.nonce,
      row.status,
      row.at,
      JSON.stringify(row.hashes.map((h) => h.toLowerCase())),
      toJson(row),
    );
    const id = Number(this.sql.exec("SELECT last_insert_rowid() AS id").one().id);
    for (const h of row.hashes) this.sql.exec("INSERT OR IGNORE INTO journal_hashes (hash, row_id) VALUES (?, ?)", h.toLowerCase(), id);
    return { ok: true };
  }

  /** A replacement at a row's nonce, before its broadcast: fenced as writeAhead. The row's first transaction is kept
   * (requestRaw): it proves the row's request, which a cancel in its place never does (proof.ts). */
  replaced(req: { holder: string; token: number; hash: string; next: { hash: string; raw: string } }): Fenced {
    const why = this.fence(req.holder, req.token, { valid: true, cronStop: true });
    if (why) return { ok: false, why };
    const r = this.rowHolding(req.hash) as { id: number; row: StoredRow } | undefined;
    if (!r) return { ok: false, why: `the journal has no send with transaction ${req.hash}` };
    r.row.requestRaw ??= r.row.raw;
    r.row.hashes = [...r.row.hashes, req.next.hash as `0x${string}`];
    r.row.raw = req.next.raw as `0x${string}`;
    this.saveRow(r.id, r.row);
    this.sql.exec("INSERT OR IGNORE INTO journal_hashes (hash, row_id) VALUES (?, ?)", req.next.hash.toLowerCase(), r.id);
    return { ok: true };
  }

  /** A row moved on at once (a broadcast the node took: "sent"), fenced by the token. */
  update(req: { holder: string; token: number; patch: string }): Fenced {
    const why = this.fence(req.holder, req.token);
    if (why) return { ok: false, why };
    this.applyPatches(fromJson<JournalPatch[]>(req.patch));
    return { ok: true };
  }

  /** The rows not settled yet (signed or sent), oldest first (the core's Journal.pending). */
  pending(): string {
    return toJson(this.pendingRows());
  }

  /** The row holding `hash` (its JSON), or null. */
  rowOf(req: { hash: string }): string | null {
    const r = this.rowHolding(req.hash);
    return r ? toJson(r.row) : null;
  }

  /** Every row written at or after `sinceMs`, oldest first (the 24 h spend cap). */
  since(req: { sinceMs: number }): string {
    return toJson(
      this.sql
        .exec("SELECT row FROM journal WHERE at >= ? ORDER BY id", req.sinceMs)
        .toArray()
        .map((r) => fromJson<JournalRow>(r.row as string)),
    );
  }

  private rowHolding(hash: string): { id: number; row: JournalRow } | undefined {
    const r = this.sql.exec("SELECT j.id AS id, j.row AS row FROM journal_hashes h JOIN journal j ON j.id = h.row_id WHERE h.hash = ?", hash.toLowerCase()).toArray()[0];
    return r ? { id: Number(r.id), row: fromJson<JournalRow>(r.row as string) } : undefined;
  }

  private saveRow(id: number, row: JournalRow) {
    this.sql.exec("UPDATE journal SET status = ?, hashes = ?, row = ? WHERE id = ?", row.status, JSON.stringify(row.hashes.map((h) => h.toLowerCase())), toJson(row), id);
  }

  /** Each patch onto the row holding its hash: only PATCH_FIELDS, each one the patch carries (a 0 too: passedAt's reset
   * is 0, T51). A settled row's status never moves back (a late "sent" after "landed"). */
  private applyPatches(patches: JournalPatch[]) {
    for (const p of patches) {
      const r = this.rowHolding(p.hash);
      if (!r) continue;
      const next: Record<string, unknown> = { ...r.row };
      for (const k of PATCH_FIELDS) {
        if (!Object.hasOwn(p.patch, k) || p.patch[k] === undefined) continue;
        next[k] = k === "status" ? statusAfter(r.row.status, p.patch.status as JournalRow["status"]) : p.patch[k];
      }
      r.row = next as unknown as JournalRow;
      this.saveRow(r.id, r.row);
    }
  }

  // ---- the commit

  /** The run's memory, its journal rows' changes, the host's state and its lines, in one atomic step, fenced by the
   * token: a run that lost its lease writes nothing. A self-stop is saved with it; `release` frees the lease. */
  commit(req: Commit): Fenced {
    const why = this.fence(req.holder, req.token);
    if (why) return { ok: false, why };
    this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const l = this.lease();
      if (req.memory !== undefined) {
        const v = (fromJson<Partial<KeeperMemory>>(req.memory).v as number | undefined) ?? null;
        this.sql.exec("INSERT OR REPLACE INTO memory (id, text, v, token, at) VALUES (1, ?, ?, ?, ?)", req.memory, v, req.token, now);
      }
      if (req.journal) this.applyPatches(fromJson<JournalPatch[]>(req.journal));
      if (req.host !== undefined) this.sql.exec("INSERT OR REPLACE INTO host (id, text) VALUES (1, ?)", req.host);
      for (const line of req.lines ?? []) this.line(line, l);
      if (req.stop) {
        const c = this.control();
        this.writeControl({ ...c, stopped: true, reason: req.stop, by: "the keeper itself", at: now });
      }
      if (req.release) this.writeLease({ ...l, holder: null, kind: null, until: 0 });
      this.sql.exec("DELETE FROM runs WHERE at < ?", now - RUNS_KEPT_MS);
    });
    return { ok: true };
  }

  // ---- the switches (design §6)

  /** The kill switch on: the next cron acquire or renew is refused, so before the next send and within a minute. */
  stop(req: { reason: string; by: string }): Control {
    const c = { ...this.control(), stopped: true, reason: req.reason, by: req.by, at: Date.now() };
    this.writeControl(c);
    this.line(`STOPPED by ${req.by}: ${req.reason}`);
    return c;
  }

  start(req: { by: string }): Control {
    const was = this.control();
    const c = { ...was, stopped: false, reason: null, by: req.by, at: Date.now() };
    this.writeControl(c);
    this.line(`STARTED by ${req.by}${was.stopped && was.reason ? ` (it was stopped: ${was.reason})` : ""}`);
    return c;
  }

  /** The deliveries switch: off means no delivery at all (as deployments.json usdcDelivery off), without a deploy. */
  deliveries(req: { on: boolean; by: string }): Control {
    const c = { ...this.control(), deliveries: req.on, deliveriesBy: req.by, deliveriesAt: Date.now() };
    this.writeControl(c);
    this.line(`DELIVERIES ${req.on ? "ON" : "OFF"} by ${req.by}`);
    return c;
  }

  /** Forgets a final refusal (memory.final, T50 M4), so the next run tries that action again. Refused while a run
   * holds the lease (it would write its own memory over this). */
  retry(req: { key: string; by: string }): Fenced {
    const l = this.lease();
    if (l.holder && Date.now() < l.until) return { ok: false, why: `${l.holder} holds the lease until ${new Date(l.until).toISOString()}: try again once it is free` };
    // a run whose lease ran out, which nobody took, could still commit its memory over this: its token is moved on
    if (l.holder) this.writeLease({ ...l, holder: null, kind: null, token: l.token + 1, until: 0 });
    const text = this.memoryText();
    let m: KeeperMemory | undefined;
    try {
      m = text ? fromJson<KeeperMemory>(text) : undefined;
    } catch {
      return { ok: false, why: "the saved memory does not parse" };
    }
    if (!m || !m.final || !Object.hasOwn(m.final, req.key)) return { ok: false, why: `nothing final is saved for ${req.key}` };
    delete m.final[req.key];
    this.sql.exec("UPDATE memory SET text = ?, at = ? WHERE id = 1", toJson(m), Date.now());
    this.line(`RETRY by ${req.by}: ${req.key} is tried again from the next run`);
    return { ok: true };
  }

  // ---- what `pnpm ops keeper status` prints

  status(req: { runs?: number } = {}): string {
    const text = this.memoryText();
    let m: KeeperMemory | undefined;
    let unreadable = false;
    try {
      m = text ? fromJson<KeeperMemory>(text) : undefined;
    } catch {
      // a memory that does not parse is shown as such: the status still answers
      unreadable = true;
    }
    const row = this.sql.exec("SELECT at FROM memory WHERE id = 1").toArray()[0];
    return toJson({
      now: Date.now(),
      control: this.control(),
      lease: this.lease(),
      memory: m
        ? {
            v: m.v,
            tick: m.tick,
            nextAt: m.nextAt,
            failing: m.failing,
            unexpected: m.unexpected,
            final: m.final ?? {},
            watching: (m.unreceipted ?? []).map((u) => ({ chain: u.chain, what: u.what, hashes: u.hashes })),
            savedAt: Number(row?.at ?? 0),
          }
        : unreadable
          ? { unreadable: true, savedAt: Number(row?.at ?? 0) }
          : null,
      pending: this.pendingRows().map((r) => ({ chain: r.chain, nonce: r.nonce, status: r.status, label: r.request.label, hashes: r.hashes, at: r.at })),
      runs: this.sql
        .exec("SELECT at, line FROM runs ORDER BY id DESC LIMIT ?", Math.max(1, Math.min(Number.isFinite(Number(req.runs)) ? Number(req.runs) : 40, 500)))
        .toArray()
        .map((r) => ({ at: Number(r.at), line: r.line as string }))
        .reverse(),
    });
  }
}
