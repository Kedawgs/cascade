import type { Hex } from "viem";
import type { ChainName, Deployment, Role } from "./config.ts";
import type { StoredLog, StoredRef } from "./logs.ts";
import { appendPages, rebuildPages, type SeedEvent, type SeedPage } from "./seed.ts";

// D1 access: reads, and prepared statements a tick commits together in one db.batch(). Every query is a
// fixed prepared statement with bound values: no SQL is ever built from data. Blocks are bigints in
// code and INTEGERs in D1 (well under 2^53); amounts and hex are TEXT.

export interface CursorRow {
  chain: ChainName;
  fromBlock: bigint;
  scannedTo: bigint | null;
  settledTo: bigint;
  settledTime: number | null;
  headTime: number | null;
  updatedAt: number;
}

export interface Reading {
  /** the tick's time, unix seconds */
  at: number;
  baseBlock: bigint | null;
  bitBlock: bigint | null;
  json: string;
}

/** One hour of running aggregates; `hour` is the unix time the hour starts at. */
export interface HourRow {
  hour: number;
  json: string;
}

export interface AlertRow {
  id: number;
  alertKey: string;
  rule: string;
  tier: "critical" | "warning";
  kind: "condition" | "event";
  subject: string;
  body: string;
  runbook: string;
  openedAt: number;
  lastSeenAt: number;
  resolvedAt: number | null;
  notifiedAt: number | null;
  notifyCount: number;
  acknowledgedAt: number | null;
}

export interface HoldRow {
  id: string;
  publicId: string;
  rule: string;
  summary: string;
  raisedAt: number;
  clearedAt: number | null;
  clearedNote: string | null;
}

/** A watched address (spec 6.1 keys.unexplained_tx). Its transactions the logs don't explain are
 * `nonce − baseline − seen`. */
export interface NonceRow {
  chain: ChainName;
  /** lowercase */
  address: Hex;
  /** the roles it holds, e.g. "frontDoor.owner"; none once it holds none */
  roles: string[];
  /** transactions the logs never explained: those before watching began, and those already alerted */
  baseline: number;
  /** transactions seen in Cascade's logs since watching began */
  seen: number;
  /** the last count read (an account's transaction count, or a Safe's nonce()) */
  nonce: number;
  /** since when the count has been ahead of what the logs explain (or when that last began) */
  changedAt: number;
}

export interface MessageRow {
  messageId: Hex;
  direction: "base>bittensor" | "bittensor>base";
  sender: Hex;
  recipient: Hex;
  amount: string;
  srcTx: Hex;
  srcBlock: bigint;
  srcTime: number;
  state: string;
  stateAt: number | null;
  dstTx: Hex | null;
  dstBlock: bigint | null;
}

export type BatchCheckStatus = "waiting" | "ok" | "mismatch" | "ok_by_owner";

/** One delivery's cross-check (one row per batch id and delivered key). */
export interface BatchCheckRow {
  batchId: bigint;
  deliveredKey: Hex;
  deliveredUid: Hex;
  deliveredTx: Hex;
  closedTx: Hex | null;
  messageId: Hex | null;
  expectedKey: Hex | null;
  status: BatchCheckStatus;
  detail: string | null;
  approvedNote: string | null;
  approvedAt: number | null;
  queuedBlock: bigint | null;
  payoutDoneBlock: bigint | null;
  /** where the delivery came from (its BatchDelivered's sourceChain and frontDoor) */
  sourceChain: number | null;
  frontDoor: Hex | null;
  /** the tick time the monitor first saw the check (null until a rule has looked at it) */
  firstSeen: number | null;
}
export type ChunkCheckStatus = "waiting" | "awaiting_read" | "ok" | "mismatch";

export interface ChunkCheckRow {
  landedUid: Hex;
  batchKey: Hex;
  chunk: number;
  landedTx: Hex;
  landedBlock: bigint;
  sentTx: Hex | null;
  messageId: Hex | null;
  expectedHash: Hex | null;
  status: ChunkCheckStatus;
  detail: string | null;
  /** the tick time the monitor first saw the check (null until a rule has looked at it) */
  firstSeen: number | null;
  /** the bridge the landing came through (loaded with the landings awaiting a delivered() read) */
  bridge?: Hex;
}

/** The sender of a transaction behind an attributable event (spec 3.3): fetched (with `to`, selector and
 * nonce), or known from an event's arguments (`from` only). */
export interface TxRow {
  chain: ChainName;
  hash: Hex;
  from: Hex;
  to?: Hex;
  selector?: Hex;
  nonce?: number;
}

/** Everything a tick needs from D1 before it reads the chains, loaded in one db.batch(). */
export interface TickState {
  cursors: Partial<Record<ChainName, CursorRow>>;
  openAlerts: AlertRow[];
  activeHolds: HoldRow[];
  /** every hold id ever raised, cleared or not: a cleared id is never raised again */
  holdIds: string[];
  /** every hold, cleared or not (the price rule resets its high when its hold is cleared) */
  holds: HoldRow[];
  /** the last 6 readings with each chain's block, newest first (price.drop needs three settled ones) */
  lastReadings: Reading[];
  /** the last 170 hour rows (a week), newest first */
  hours: HourRow[];
  /** the watched addresses */
  nonces: NonceRow[];
  pendingMessages: MessageRow[];
  /** payout landings waiting for a delivered(...) read */
  awaitingReads: ChunkCheckRow[];
  /** the cross-checks still open: deliveries waiting, landings waiting or awaiting their read */
  openChecks: { batches: BatchCheckRow[]; chunks: ChunkCheckRow[] };
  /** delivery checks the owner approved since the last tick saw (meta.approvals_seen) */
  approvals: BatchCheckRow[];
  /** at most 50 users with a PayoutReceived in the last 7 days, not since claimed or delivered */
  payoutUsers: Hex[];
  /** the same users with the time of their last PayoutReceived */
  lastPayouts: { user: Hex; at: number }[];
  /** deliveries whose payouts are queued and not yet done */
  pendingPayoutKeys: { key: Hex; queuedBlock: bigint }[];
  meta: Record<string, string>;
  /** the last seed page (appending fills it up first); null before any seed event is paged */
  lastSeedPage: SeedPage | null;
}

const big = (x: unknown): bigint | null => (x === null || x === undefined ? null : BigInt(x as number));
const num = (x: unknown): number | null => (x === null || x === undefined ? null : Number(x));
/** A block or count as D1 takes it. */
const int = (x: bigint | number | null | undefined): number | null => (x === null || x === undefined ? null : Number(x));
const opt = <T>(x: T | undefined): T | null => (x === undefined ? null : x);

type Row = Record<string, unknown>;

const cursorOf = (r: Row): CursorRow => ({
  chain: r.chain as ChainName,
  fromBlock: BigInt(r.from_block as number),
  scannedTo: big(r.scanned_to),
  settledTo: BigInt(r.settled_to as number),
  settledTime: num(r.settled_time),
  headTime: num(r.head_time),
  updatedAt: Number(r.updated_at),
});

const alertOf = (r: Row): AlertRow => ({
  id: Number(r.id),
  alertKey: r.alert_key as string,
  rule: r.rule as string,
  tier: r.tier as AlertRow["tier"],
  kind: r.kind as AlertRow["kind"],
  subject: r.subject as string,
  body: r.body as string,
  runbook: r.runbook as string,
  openedAt: Number(r.opened_at),
  lastSeenAt: Number(r.last_seen_at),
  resolvedAt: num(r.resolved_at),
  notifiedAt: num(r.notified_at),
  notifyCount: Number(r.notify_count),
  acknowledgedAt: num(r.acknowledged_at),
});

const holdOf = (r: Row): HoldRow => ({
  id: r.id as string,
  publicId: r.public_id as string,
  rule: r.rule as string,
  summary: r.summary as string,
  raisedAt: Number(r.raised_at),
  clearedAt: num(r.cleared_at),
  clearedNote: (r.cleared_note as string | null) ?? null,
});

const readingOf = (r: Row): Reading => ({ at: Number(r.at), baseBlock: big(r.base_block), bitBlock: big(r.bit_block), json: r.json as string });

const messageOf = (r: Row): MessageRow => ({
  messageId: r.message_id as Hex,
  direction: r.direction as MessageRow["direction"],
  sender: r.sender as Hex,
  recipient: r.recipient as Hex,
  amount: r.amount as string,
  srcTx: r.src_tx as Hex,
  srcBlock: BigInt(r.src_block as number),
  srcTime: Number(r.src_time),
  state: r.state as string,
  stateAt: num(r.state_at),
  dstTx: (r.dst_tx as Hex | null) ?? null,
  dstBlock: big(r.dst_block),
});

export const batchCheckOf = (r: Row): BatchCheckRow => ({
  batchId: BigInt(r.batch_id as number),
  deliveredKey: r.delivered_key as Hex,
  deliveredUid: r.delivered_uid as Hex,
  deliveredTx: r.delivered_tx as Hex,
  closedTx: (r.closed_tx as Hex | null) ?? null,
  messageId: (r.message_id as Hex | null) ?? null,
  expectedKey: (r.expected_key as Hex | null) ?? null,
  status: r.status as BatchCheckStatus,
  detail: (r.detail as string | null) ?? null,
  approvedNote: (r.approved_note as string | null) ?? null,
  approvedAt: num(r.approved_at),
  queuedBlock: big(r.queued_block),
  payoutDoneBlock: big(r.payout_done_block),
  sourceChain: num(r.source_chain),
  frontDoor: (r.front_door as Hex | null | undefined) ?? null,
  firstSeen: num(r.first_seen),
});

/** A stored log as read back. */
export const logOf = (r: Row): StoredLog => {
  const log: StoredLog = {
    uid: r.uid as Hex,
    chain: r.chain as ChainName,
    contract: r.contract as Role,
    address: r.address as Hex,
    block: BigInt(r.block as number),
    logIndex: Number(r.log_index),
    txHash: r.tx_hash as Hex,
    event: r.event as string,
    data: r.data as Hex,
    args: JSON.parse(r.args as string) as StoredLog["args"],
  };
  if (r.topic1) log.topic1 = r.topic1 as Hex;
  if (r.topic2) log.topic2 = r.topic2 as Hex;
  if (r.topic3) log.topic3 = r.topic3 as Hex;
  if (Number(r.removed) === 1) log.removed = true;
  return log;
};

export const txRowOf = (r: Row): TxRow => {
  const row: TxRow = { chain: r.chain as ChainName, hash: r.hash as Hex, from: r.from_addr as Hex };
  if (r.to_addr) row.to = r.to_addr as Hex;
  if (r.selector) row.selector = r.selector as Hex;
  if (r.nonce !== null && r.nonce !== undefined) row.nonce = Number(r.nonce);
  return row;
};

export const chunkCheckOf = (r: Row): ChunkCheckRow => ({
  landedUid: r.landed_uid as Hex,
  batchKey: r.batch_key as Hex,
  chunk: Number(r.chunk),
  landedTx: r.landed_tx as Hex,
  landedBlock: BigInt(r.landed_block as number),
  sentTx: (r.sent_tx as Hex | null) ?? null,
  messageId: (r.message_id as Hex | null) ?? null,
  expectedHash: (r.expected_hash as Hex | null) ?? null,
  status: r.status as ChunkCheckStatus,
  detail: (r.detail as string | null) ?? null,
  firstSeen: num(r.first_seen),
  ...(typeof r.bridge === "string" ? { bridge: r.bridge as Hex } : {}),
});

/** Seven days of Base's 2-second blocks: how far back a PayoutReceived makes its user worth reading. */
const PAYOUT_USERS_BLOCKS = 302_400;

/** The tick's whole D1 load (spec section 1, step 2), as one query. */
export async function loadTickState(db: D1Database, nowS: number): Promise<TickState> {
  const rs = await db.batch<Row>([
    db.prepare("SELECT chain, from_block, scanned_to, settled_to, settled_time, head_time, updated_at FROM cursors"),
    db.prepare("SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY id"),
    db.prepare("SELECT * FROM holds ORDER BY raised_at, id"),
    db.prepare("SELECT at, base_block, bit_block, json FROM readings WHERE base_block IS NOT NULL ORDER BY at DESC LIMIT 6"),
    db.prepare("SELECT at, base_block, bit_block, json FROM readings WHERE bit_block IS NOT NULL ORDER BY at DESC LIMIT 6"),
    db.prepare("SELECT hour, json FROM hours ORDER BY hour DESC LIMIT 170"),
    db.prepare("SELECT chain, address, roles, baseline, seen, nonce, changed_at FROM nonces"),
    db.prepare("SELECT * FROM messages WHERE dst_tx IS NULL AND state <> 'SUCCESS' ORDER BY src_block LIMIT 100"),
    // with the bridge the landing came through: delivered(bridge, hash) is read for it
    db.prepare(
      `SELECT c.*, json_extract(l.args, '$.bridge') AS bridge FROM chunk_checks c
       LEFT JOIN logs l ON l.uid = c.landed_uid WHERE c.status = 'awaiting_read'`,
    ),
    db.prepare(
      `SELECT r.user AS user, r.at AS at FROM (
         SELECT p.topic2 AS user, MAX(p.block) AS last, MAX(b.time) AS at FROM logs p
         JOIN blocks b ON b.chain = 'base' AND b.number = p.block
         WHERE p.chain = 'base' AND p.contract = 'frontDoor' AND p.event = 'PayoutReceived' AND p.removed = 0
           AND p.block >= COALESCE((SELECT settled_to FROM cursors WHERE chain = 'base'), 0) - ?1
           AND b.time >= ?2
         GROUP BY p.topic2
       ) r
       WHERE NOT EXISTS (
         -- by the user's index: SQLite would otherwise pick logs_by_event and walk everyone's claims
         SELECT 1 FROM logs c INDEXED BY logs_by_topic1
         WHERE c.contract = 'frontDoor' AND c.event IN ('Claimed', 'Delivered') AND c.topic1 = r.user
           AND c.block > r.last AND c.chain = 'base' AND c.removed = 0
       )
       ORDER BY r.last DESC LIMIT 50`,
    ).bind(PAYOUT_USERS_BLOCKS, nowS - 7 * 86400),
    db.prepare("SELECT delivered_key, queued_block FROM batch_checks WHERE queued_block IS NOT NULL AND payout_done_block IS NULL"),
    db.prepare("SELECT k, v FROM meta"),
    db.prepare("SELECT * FROM batch_checks WHERE status = 'waiting'"),
    db.prepare("SELECT * FROM chunk_checks WHERE status IN ('waiting', 'awaiting_read')"),
    db.prepare(
      `SELECT * FROM batch_checks INDEXED BY batch_checks_approved WHERE approved_at IS NOT NULL
       AND approved_at > COALESCE((SELECT CAST(v AS INTEGER) FROM meta WHERE k = 'approvals_seen'), 0) ORDER BY approved_at`,
    ),
    db.prepare("SELECT page, first_block, last_block, count, delivered, staked, payouts FROM seed_pages ORDER BY page DESC LIMIT 1"),
  ]);
  const rows = (i: number) => rs[i].results;
  const cursors: TickState["cursors"] = {};
  for (const c of rows(0).map(cursorOf)) cursors[c.chain] = c;
  const holds = rows(2).map(holdOf);
  const readings = new Map<number, Reading>();
  for (const r of [...rows(3), ...rows(4)].map(readingOf)) readings.set(r.at, r);
  return {
    cursors,
    openAlerts: rows(1).map(alertOf),
    activeHolds: holds.filter((h) => h.clearedAt === null),
    holdIds: holds.map((h) => h.id),
    holds,
    lastReadings: [...readings.values()].sort((a, b) => b.at - a.at),
    hours: rows(5).map((r) => ({ hour: Number(r.hour), json: r.json as string })),
    nonces: rows(6).map((r) => ({
      chain: r.chain as ChainName,
      address: r.address as Hex,
      roles: JSON.parse(r.roles as string) as string[],
      baseline: Number(r.baseline),
      seen: Number(r.seen),
      nonce: Number(r.nonce),
      changedAt: Number(r.changed_at),
    })),
    pendingMessages: rows(7).map(messageOf),
    awaitingReads: rows(8).map(chunkCheckOf),
    payoutUsers: rows(9).map((r) => `0x${(r.user as string).slice(-40)}` as Hex),
    lastPayouts: rows(9).map((r) => ({ user: `0x${(r.user as string).slice(-40)}` as Hex, at: Number(r.at) })),
    pendingPayoutKeys: rows(10).map((r) => ({ key: r.delivered_key as Hex, queuedBlock: BigInt(r.queued_block as number) })),
    meta: Object.fromEntries(rows(11).map((r) => [r.k as string, r.v as string])),
    openChecks: { batches: rows(12).map(batchCheckOf), chunks: rows(13).map(chunkCheckOf) },
    approvals: rows(14).map(batchCheckOf),
    lastSeedPage: rows(15).length ? seedPageOf(rows(15)[0]) : null,
  };
}

/** The stored, not removed logs in each chain's re-read range (uid → place and content), in one query:
 * the only range a tick's windows read again, so the only place a stored log can go missing. */
export async function storedUids(db: D1Database, ranges: readonly { chain: ChainName; from: bigint; to: bigint }[]): Promise<Map<ChainName, Map<Hex, StoredRef>>> {
  return (await rereadStored(db, ranges)).stored;
}

/** As storedUids, and the uids of the range's removed logs too, from the same query: a removed log a re-read
 * finds again is re-mined, not new (an event rule reports a log once). */
export async function rereadStored(
  db: D1Database,
  ranges: readonly { chain: ChainName; from: bigint; to: bigint }[],
): Promise<{ stored: Map<ChainName, Map<Hex, StoredRef>>; removed: Set<Hex> }> {
  const stored = new Map<ChainName, Map<Hex, StoredRef>>();
  const removed = new Set<Hex>();
  if (ranges.length === 0) return { stored, removed };
  // a chain without a range gets an empty one (from 1 to 0)
  const range = (chain: ChainName) => ranges.find((r) => r.chain === chain) ?? { from: 1n, to: 0n };
  const base = range("base");
  const bit = range("bittensor");
  const { results } = await db
    .prepare(
      `SELECT chain, uid, block, log_index, tx_hash, contract, event, topic1, topic2, topic3, data, removed FROM logs WHERE
         (chain = 'base' AND block BETWEEN ?1 AND ?2) OR (chain = 'bittensor' AND block BETWEEN ?3 AND ?4)`,
    )
    .bind(int(base.from), int(base.to), int(bit.from), int(bit.to))
    .all<Row>();
  for (const r of results) {
    if (Number(r.removed) === 1) {
      removed.add(r.uid as Hex);
      continue;
    }
    const chain = r.chain as ChainName;
    if (!stored.has(chain)) stored.set(chain, new Map());
    stored.get(chain)!.set(r.uid as Hex, {
      block: BigInt(r.block as number),
      logIndex: Number(r.log_index),
      txHash: r.tx_hash as Hex,
      contract: r.contract as Role,
      event: r.event as string,
      topic1: (r.topic1 as Hex | null) ?? null,
      topic2: (r.topic2 as Hex | null) ?? null,
      topic3: (r.topic3 as Hex | null) ?? null,
      data: r.data as Hex,
    });
  }
  return { stored, removed };
}

/** Takes the tick's lease for `leaseS` under `holder` (random per tick) unless another holds it. */
export async function takeLease(db: D1Database, holder: string, leaseS: number, nowS: number): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT INTO lease (name, holder, until) VALUES ('tick', ?1, ?2)
       ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, until = excluded.until WHERE lease.until < ?3`,
    )
    .bind(holder, nowS + leaseS, nowS)
    .run();
  return r.meta.changes === 1;
}

/** Who holds the lease: read once after a failed commit, to tell a lost lease from a D1 failure. */
export async function leaseHolder(db: D1Database): Promise<{ holder: string; until: number } | null> {
  const r = await db.prepare("SELECT holder, until FROM lease WHERE name = 'tick'").first<{ holder: string; until: number }>();
  return r ? { holder: r.holder, until: Number(r.until) } : null;
}

/** A commit's first statement: fails the whole batch once another tick holds the lease. It checks the
 * holder only, never `until`, so a slow tick nobody replaced still commits what it read. */
export const guardStatement = (db: D1Database, holder: string): D1PreparedStatement =>
  db.prepare("INSERT INTO guard (x) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM lease WHERE name = 'tick' AND holder = ?1)").bind(holder);

export const releaseLease = (db: D1Database, holder: string): D1PreparedStatement =>
  db.prepare("UPDATE lease SET until = 0 WHERE name = 'tick' AND holder = ?1").bind(holder);

/** Upserts, so a log marked removed by a reorg and re-mined in a later block comes back at its new place.
 * A delivery (vault BatchDelivered) or a landing (front door PayoutsDelivered) gets its check row, waiting,
 * in the same statements, whatever its block: no stored delivery can miss its cross-check, even when a rule
 * fails on the tick that stores it. A row already there (decided or not) is left as it is. */
export function upsertLogs(db: D1Database, logs: readonly StoredLog[]): D1PreparedStatement[] {
  const stmt = db.prepare(
    `INSERT INTO logs (uid, chain, contract, address, block, log_index, tx_hash, event, topic1, topic2, topic3, data, args, removed)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0)
     ON CONFLICT (uid) DO UPDATE SET removed = 0, block = excluded.block, log_index = excluded.log_index`,
  );
  const delivery = db.prepare(
    `INSERT INTO batch_checks (batch_id, delivered_key, delivered_uid, delivered_tx, status, source_chain, front_door)
     VALUES (?1, ?2, ?3, ?4, 'waiting', ?5, ?6) ON CONFLICT DO NOTHING`,
  );
  const landing = db.prepare(
    `INSERT INTO chunk_checks (landed_uid, batch_key, chunk, landed_tx, landed_block, status)
     VALUES (?1, ?2, ?3, ?4, ?5, 'waiting') ON CONFLICT DO NOTHING`,
  );
  const text = (x: unknown) => String(x).toLowerCase();
  return logs.flatMap((l) => {
    const out = [stmt.bind(l.uid, l.chain, l.contract, l.address, int(l.block), l.logIndex, l.txHash, l.event, opt(l.topic1), opt(l.topic2), opt(l.topic3), l.data, JSON.stringify(l.args))];
    const a = l.args;
    // (a decoded log always has these args; the checks keep anything else out)
    if (l.chain === "bittensor" && l.contract === "vault" && l.event === "BatchDelivered" && typeof a.key === "string") {
      out.push(delivery.bind(Number(a.batchId), text(a.key), l.uid, l.txHash, Number(a.sourceChain), text(a.frontDoor)));
    } else if (l.chain === "base" && l.contract === "frontDoor" && l.event === "PayoutsDelivered" && typeof a.batchKey === "string") {
      out.push(landing.bind(l.uid, text(a.batchKey), Number(a.chunk), l.txHash, int(l.block)));
    }
    return out;
  });
}

export function markRemoved(db: D1Database, uids: readonly Hex[]): D1PreparedStatement[] {
  const stmt = db.prepare("UPDATE logs SET removed = 1 WHERE uid = ?1");
  return uids.map((u) => stmt.bind(u));
}

/** A chain's cursor. `settled_to` and `scanned_to` only move forward (with `settled_time` following
 * `settled_to`), and `head_time` only forward, written every tick. */
export function setCursor(
  db: D1Database,
  c: { chain: ChainName; fromBlock: bigint; scannedTo: bigint | null; settledTo: bigint; settledTime: number | null; headTime: number | null; nowS: number },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO cursors (chain, from_block, scanned_to, settled_to, settled_time, head_time, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (chain) DO UPDATE SET
         scanned_to = CASE WHEN excluded.scanned_to IS NULL THEN cursors.scanned_to
                           WHEN cursors.scanned_to IS NULL THEN excluded.scanned_to
                           ELSE MAX(cursors.scanned_to, excluded.scanned_to) END,
         settled_time = CASE WHEN excluded.settled_to > cursors.settled_to THEN excluded.settled_time
                             ELSE COALESCE(cursors.settled_time, excluded.settled_time) END,
         settled_to = MAX(cursors.settled_to, excluded.settled_to),
         head_time = MAX(COALESCE(cursors.head_time, excluded.head_time), COALESCE(excluded.head_time, cursors.head_time)),
         updated_at = excluded.updated_at`,
    )
    .bind(c.chain, int(c.fromBlock), int(c.scannedTo), int(c.settledTo), c.settledTime, c.headTime, c.nowS);
}

export function upsertBlocks(db: D1Database, rows: readonly { chain: ChainName; number: bigint; time: number }[]): D1PreparedStatement[] {
  const stmt = db.prepare("INSERT INTO blocks (chain, number, time) VALUES (?1, ?2, ?3) ON CONFLICT (chain, number) DO UPDATE SET time = excluded.time");
  return rows.map((r) => stmt.bind(r.chain, int(r.number), r.time));
}

/** Watched addresses' rows, written as the keys rule decided them. */
export function upsertNonces(db: D1Database, rows: readonly NonceRow[]): D1PreparedStatement[] {
  const stmt = db.prepare(
    `INSERT INTO nonces (chain, address, roles, baseline, seen, nonce, changed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (chain, address) DO UPDATE SET roles = excluded.roles, baseline = excluded.baseline, seen = excluded.seen,
       nonce = excluded.nonce, changed_at = excluded.changed_at`,
  );
  return rows.map((r) => stmt.bind(r.chain, r.address, JSON.stringify(r.roles), r.baseline, r.seen, r.nonce, r.changedAt));
}

/** A fetched transaction (with `to`, selector and nonce) fills in, and wins over, one known only from an
 * event's arguments; one known from arguments never overwrites a fetched one. */
export function insertTxs(db: D1Database, rows: readonly TxRow[]): D1PreparedStatement[] {
  const stmt = db.prepare(
    `INSERT INTO txs (chain, hash, from_addr, to_addr, selector, nonce) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (chain, hash) DO UPDATE SET
       from_addr = CASE WHEN excluded.to_addr IS NOT NULL OR excluded.selector IS NOT NULL THEN excluded.from_addr ELSE txs.from_addr END,
       to_addr = COALESCE(excluded.to_addr, txs.to_addr),
       selector = COALESCE(excluded.selector, txs.selector),
       nonce = COALESCE(excluded.nonce, txs.nonce)`,
  );
  return rows.map((r) => stmt.bind(r.chain, r.hash, r.from, opt(r.to), opt(r.selector), opt(r.nonce)));
}

export const insertReading = (db: D1Database, r: Reading): D1PreparedStatement =>
  db.prepare("INSERT OR REPLACE INTO readings (at, base_block, bit_block, json) VALUES (?1, ?2, ?3, ?4)").bind(r.at, int(r.baseBlock), int(r.bitBlock), r.json);

export const pruneReadings = (db: D1Database, keep = 120): D1PreparedStatement =>
  db.prepare("DELETE FROM readings WHERE at NOT IN (SELECT at FROM readings ORDER BY at DESC LIMIT ?1)").bind(keep);

export const upsertHour = (db: D1Database, hour: number, json: string): D1PreparedStatement =>
  db.prepare("INSERT INTO hours (hour, json) VALUES (?1, ?2) ON CONFLICT (hour) DO UPDATE SET json = excluded.json").bind(hour, json);

export const pruneHours = (db: D1Database, nowS: number, days = 35): D1PreparedStatement =>
  db.prepare("DELETE FROM hours WHERE hour < ?1").bind(nowS - days * 86400);

export const setMeta = (db: D1Database, k: string, v: string): D1PreparedStatement =>
  db.prepare("INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(k, v);

/** Records each payout batch the reading shows done (snapshot.payoutsDone), once: the one completion
 * source for okKeys and payout.overdue. */
export function payoutDoneStatements(db: D1Database, done: readonly { key: Hex; block: bigint }[]): D1PreparedStatement[] {
  const stmt = db.prepare(
    "UPDATE batch_checks SET payout_done_block = ?1 WHERE delivered_key = ?2 AND queued_block IS NOT NULL AND payout_done_block IS NULL",
  );
  return done.map((x) => stmt.bind(int(x.block), x.key));
}

/** Marks the database as holding this deployment (its "<frontDoor>:<vault>" id): every commit includes
 * it, the first one writes it, and it is never changed after. */
export const deploymentStatement = (db: D1Database, d: Pick<Deployment, "id">): D1PreparedStatement =>
  db.prepare("INSERT INTO meta (k, v) VALUES ('deployment', ?1) ON CONFLICT (k) DO NOTHING").bind(d.id);

/** Whether the database holds the configured deployment: "new" before the first commit, "other" when
 * DEPLOYMENT has changed under it (the tick then refuses to run, and the API to serve). */
export function checkDeployment(meta: Readonly<Record<string, string>>, d: Pick<Deployment, "id">): "new" | "same" | "other" {
  const v = meta.deployment;
  return v === undefined ? "new" : v === d.id ? "same" : "other";
}

/** One delivery's cross-check row (one per batch id and delivered key). An owner's approval is never
 * overwritten by a later check. */
export interface BatchCheckWrite {
  batchId: bigint;
  deliveredKey: Hex;
  deliveredUid: Hex;
  deliveredTx: Hex;
  closedTx?: Hex;
  messageId?: Hex;
  expectedKey?: Hex;
  status: Exclude<BatchCheckStatus, "ok_by_owner">;
  detail?: string;
  queuedBlock?: bigint;
  sourceChain?: number;
  frontDoor?: Hex;
  /** kept from the first write that gives one */
  firstSeen?: number;
}

export interface ChunkCheckWrite {
  landedUid: Hex;
  batchKey: Hex;
  chunk: number;
  landedTx: Hex;
  landedBlock: bigint;
  sentTx?: Hex;
  messageId?: Hex;
  expectedHash?: Hex;
  status: ChunkCheckStatus;
  detail?: string;
  /** kept from the first write that gives one */
  firstSeen?: number;
}

export function upsertBatchCheck(db: D1Database, c: BatchCheckWrite): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO batch_checks (batch_id, delivered_key, delivered_uid, delivered_tx, closed_tx, message_id, expected_key, status, detail, queued_block,
         source_chain, front_door, first_seen)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
       ON CONFLICT (batch_id, delivered_key) DO UPDATE SET
         delivered_uid = excluded.delivered_uid,
         delivered_tx = excluded.delivered_tx,
         closed_tx = COALESCE(excluded.closed_tx, batch_checks.closed_tx),
         message_id = COALESCE(excluded.message_id, batch_checks.message_id),
         expected_key = COALESCE(excluded.expected_key, batch_checks.expected_key),
         status = CASE WHEN batch_checks.status = 'ok_by_owner' THEN batch_checks.status ELSE excluded.status END,
         detail = CASE WHEN batch_checks.status = 'ok_by_owner' THEN batch_checks.detail ELSE excluded.detail END,
         queued_block = COALESCE(excluded.queued_block, batch_checks.queued_block),
         source_chain = COALESCE(excluded.source_chain, batch_checks.source_chain),
         front_door = COALESCE(excluded.front_door, batch_checks.front_door),
         first_seen = COALESCE(batch_checks.first_seen, excluded.first_seen)`,
    )
    .bind(
      int(c.batchId),
      c.deliveredKey,
      c.deliveredUid,
      c.deliveredTx,
      opt(c.closedTx),
      opt(c.messageId),
      opt(c.expectedKey),
      c.status,
      opt(c.detail),
      int(c.queuedBlock),
      opt(c.sourceChain),
      opt(c.frontDoor),
      opt(c.firstSeen),
    );
}

/** One payout landing's cross-check row, keyed by its PayoutsDelivered log: a forged duplicate landing
 * gets its own row and never touches the honest one's. */
export function upsertChunkCheck(db: D1Database, c: ChunkCheckWrite): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO chunk_checks (landed_uid, batch_key, chunk, landed_tx, landed_block, sent_tx, message_id, expected_hash, status, detail, first_seen)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT (landed_uid) DO UPDATE SET
         sent_tx = COALESCE(excluded.sent_tx, chunk_checks.sent_tx),
         message_id = COALESCE(excluded.message_id, chunk_checks.message_id),
         expected_hash = COALESCE(excluded.expected_hash, chunk_checks.expected_hash),
         status = excluded.status,
         detail = excluded.detail,
         first_seen = COALESCE(chunk_checks.first_seen, excluded.first_seen)`,
    )
    .bind(c.landedUid, c.batchKey, c.chunk, c.landedTx, int(c.landedBlock), opt(c.sentTx), opt(c.messageId), opt(c.expectedHash), c.status, opt(c.detail), opt(c.firstSeen));
}

const writePages = (db: D1Database, pages: readonly SeedPage[]): D1PreparedStatement[] => {
  const stmt = db.prepare(
    `INSERT INTO seed_pages (page, first_block, last_block, count, delivered, staked, payouts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (page) DO UPDATE SET first_block = excluded.first_block, last_block = excluded.last_block, count = excluded.count,
       delivered = excluded.delivered, staked = excluded.staked, payouts = excluded.payouts`,
  );
  return pages.map((p) => stmt.bind(p.page, int(p.firstBlock), int(p.lastBlock), p.count, p.delivered, p.staked, p.payouts));
};

/** A seed_pages row as read back. */
export const seedPageOf = (r: Record<string, unknown>): SeedPage => ({
  page: Number(r.page),
  firstBlock: BigInt(r.first_block as number),
  lastBlock: BigInt(r.last_block as number),
  count: Number(r.count),
  delivered: r.delivered as string,
  staked: r.staked as string,
  payouts: r.payouts as string,
});

/** The seed pages after newly settled seed events: the last page filled up to 500, then new pages
 * (committed with the cursor that settled them). */
export const appendStatements = (db: D1Database, lastPage: { page: number; events: SeedEvent[] } | null, events: readonly SeedEvent[], pageSize?: number): D1PreparedStatement[] =>
  writePages(db, appendPages(lastPage, events, pageSize));

/** Every stored, not removed log the seed pages are made of (the vault's BatchDelivered, Staked and
 * PayoutChunkSent), by their event index: read only on a tick that must rebuild the pages. */
export async function seedLogs(db: D1Database): Promise<StoredLog[]> {
  const { results } = await db
    .prepare("SELECT * FROM logs WHERE chain = 'bittensor' AND contract = 'vault' AND event IN ('BatchDelivered', 'Staked', 'PayoutChunkSent') AND removed = 0")
    .all<Row>();
  return results.map(logOf);
}

/** Every seed page written again from all the seed events (after a log was removed or re-mined). */
export const rebuildStatements = (db: D1Database, allEvents: readonly SeedEvent[], pageSize?: number): D1PreparedStatement[] => [
  db.prepare("DELETE FROM seed_pages"),
  ...writePages(db, rebuildPages(allEvents, pageSize)),
];

/** "h_" and 8 random hex digits: what the public status shows of a hold. */
export function newPublicId(): string {
  const b = crypto.getRandomValues(new Uint8Array(4));
  return `h_${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** Raises a hold unless its id was ever raised (a cleared id isn't raised again). Holds are cleared only
 * by the owner's script, never here. */
export const insertHold = (db: D1Database, h: { id: string; rule: string; summary: string; raisedAt: number }, publicId = newPublicId()): D1PreparedStatement =>
  db
    .prepare("INSERT INTO holds (id, public_id, rule, summary, raised_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (id) DO NOTHING RETURNING id, public_id")
    .bind(h.id, publicId, h.rule, h.summary, h.raisedAt);

/** What a commit's statements hand back (RETURNING): each new alert's id by its key (for pnpm alerts:ack in
 * its email), and each hold actually raised, by its id, with its public id. */
export function returnedIds(results: readonly D1Result<unknown>[]): { alerts: Map<string, number>; holds: Map<string, string> } {
  const alerts = new Map<string, number>();
  const holds = new Map<string, string>();
  for (const r of results) {
    for (const row of (r.results ?? []) as Row[]) {
      if (typeof row.alert_key === "string" && row.id !== undefined) alerts.set(row.alert_key, Number(row.id));
      else if (typeof row.public_id === "string" && typeof row.id === "string") holds.set(row.id, row.public_id);
    }
  }
  return { alerts, holds };
}

/** The per-day counters the digest shows (meta ticks_run, ticks_failed, ticks_skipped, emails_sent, for the
 * UTC day in ticks_date): all set to 0 together when the day changes, then these added. One batch. */
export const COUNTERS = ["ticks_run", "ticks_failed", "ticks_skipped", "emails_sent"] as const;
export function countStatements(db: D1Database, date: string, add: Partial<Record<(typeof COUNTERS)[number], number>>): D1PreparedStatement[] {
  const reset = db.prepare(
    `INSERT INTO meta (k, v) SELECT value, '0' FROM json_each(?1)
     WHERE COALESCE((SELECT v FROM meta WHERE k = 'ticks_date'), '') <> ?2
     ON CONFLICT (k) DO UPDATE SET v = '0'`,
  );
  // (a bound JS number arrives as a REAL: cast it, or "2" becomes "2.0")
  const plus = db.prepare(
    "INSERT INTO meta (k, v) VALUES (?1, CAST(CAST(?2 AS INTEGER) AS TEXT)) ON CONFLICT (k) DO UPDATE SET v = CAST(CAST(meta.v AS INTEGER) + CAST(?2 AS INTEGER) AS TEXT)",
  );
  return [
    reset.bind(JSON.stringify(COUNTERS), date),
    setMeta(db, "ticks_date", date),
    ...Object.entries(add).flatMap(([k, n]) => (n ? [plus.bind(k, n)] : [])),
  ];
}
