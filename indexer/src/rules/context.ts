import { type Hex, numberToHex, pad } from "viem";
import type { Finding, Unjudged } from "../alerts.ts";
import type { ChainName, Config, Role } from "../config.ts";
import type { StoredLog } from "../logs.ts";
import type { BaseState, BitState, ChainReading, HourAgg, Snapshot } from "../snapshot.ts";
import {
  type BatchCheckRow,
  type BatchCheckWrite,
  batchCheckOf,
  type ChunkCheckRow,
  type ChunkCheckWrite,
  chunkCheckOf,
  type HoldRow,
  logOf,
  type MessageRow,
  type NonceRow,
  type TxRow,
  txRowOf,
} from "../store.ts";
import type { Reference } from "../prices.ts";
import type { Thresholds } from "../thresholds.ts";
import type { RuleId } from "./ids.ts";

/** The logs the rules read, in memory: what the prefetch loaded and this tick's own. */
export interface LogQuery {
  /** a contract's events on a chain, from `from` to `to` (inclusive), in log order */
  range(chain: ChainName, role: Role, events: string | readonly string[], from?: bigint, to?: bigint): StoredLog[];
  /** a transaction's logs on a chain, in log order */
  inTx(chain: ChainName, txHash: Hex): StoredLog[];
  all(): StoredLog[];
}

const byPosition = (a: StoredLog, b: StoredLog) => (a.block !== b.block ? (a.block < b.block ? -1 : 1) : a.logIndex - b.logIndex);

/** A LogQuery over `logs`: one copy per uid (a later copy wins: this tick's over the stored one), removed
 * logs left out. */
export function logQuery(logs: readonly StoredLog[]): LogQuery {
  const one = new Map<Hex, StoredLog>();
  for (const l of logs) one.set(l.uid, l);
  const kept = [...one.values()].filter((l) => !l.removed).sort(byPosition);
  const byEvent = new Map<string, StoredLog[]>();
  const byTx = new Map<string, StoredLog[]>();
  for (const l of kept) {
    const e = `${l.chain}:${l.contract}:${l.event}`;
    if (!byEvent.has(e)) byEvent.set(e, []);
    byEvent.get(e)!.push(l);
    const t = `${l.chain}:${l.txHash}`;
    if (!byTx.has(t)) byTx.set(t, []);
    byTx.get(t)!.push(l);
  }
  return {
    range(chain, role, events, from, to) {
      const names = typeof events === "string" ? [events] : events;
      return names
        .flatMap((n) => byEvent.get(`${chain}:${role}:${n}`) ?? [])
        .filter((l) => (from === undefined || l.block >= from) && (to === undefined || l.block <= to))
        .sort(byPosition);
    },
    inTx: (chain, txHash) => byTx.get(`${chain}:${txHash.toLowerCase()}`) ?? [],
    all: () => kept,
  };
}

export type Readings = { base?: BaseState; bittensor?: BitState };

/** Everything a rule may read. Rules never query D1 or the chains: the tick gathers this first. */
export interface RuleCtx {
  cfg: Config;
  nowS: number;
  snap: Snapshot;
  /** the last readings kept before this tick's (older blocks) */
  previous: { base?: ChainReading<BaseState>; bittensor?: ChainReading<BitState> };
  /** the last few readings kept before this tick's, newest first (previous is the first) */
  history: { base: ChainReading<BaseState>[]; bittensor: ChainReading<BitState>[] };
  /** every hold, cleared or not */
  holds: HoldRow[];
  /** the last 170 hours' aggregates (a week, for pool.liquidity's median), newest first */
  hours: HourAgg[];
  /** how far each chain's logs are stored, and that block's time */
  settled: Record<ChainName, { block: bigint; time: number; headTime?: number }>;
  /** the uids this tick upserts that weren't stored before: settled logs stored for the first time,
   * wherever their block (a log a re-read finds late, below what was settled before, is one). Not the
   * scan's `fresh` (logs within the settle margin of the head, not stored), and not re-mined logs coming back. An
   * event rule reports a log once, on the tick it is first stored. */
  newUids: ReadonlySet<Hex>;
  payoutDelayS: number;
  lagLimitS: number;
  logs: LogQuery;
  /** the cross-check rows of the batches and payout keys this tick looks at */
  checks: { batches: BatchCheckRow[]; chunks: ChunkCheckRow[] };
  /** a block's time, when known (blocks holding stored logs) */
  blockTime: (chain: ChainName, block: bigint) => number | undefined;
  /** each chain's seconds a block, measured from the readings (src/blocktime.ts); absent while unknown (a first tick) */
  blockS: Partial<Record<ChainName, number>>;
  /** senders of transactions, by `${chain}:${hash}` */
  txs: Map<string, TxRow>;
  /** the transactions first stored this tick (fetched, or known from an event's args), one per hash */
  newTxs: TxRow[];
  /** the bridge messages still pending (loaded), with this tick's new ones */
  messages: MessageRow[];
  /** the reference TAO price, on the ticks that read it (every fifth minute) */
  reference?: Reference;
  /** users with a PayoutReceived in the last 7 days not since claimed or delivered, and its time */
  payoutUsers: { user: Hex; at: number }[];
  /** delivery keys whose payouts are queued and not done (by payout_done_block) */
  pendingPayoutKeys: Hex[];
  /** stored logs this tick found missing from a re-read (marked removed) */
  removed: { chain: ChainName; uid: Hex }[];
  /** delivery checks the owner approved since the last tick saw (meta.approvals_seen) */
  approvals: BatchCheckRow[];
  /** the watched addresses' rows */
  nonces: NonceRow[];
  t: Thresholds;
  holdActive: boolean;
  meta: Record<string, string>;
  /** rows the rules decided this tick, committed with everything else */
  writes: { batchChecks: BatchCheckWrite[]; chunkChecks: ChunkCheckWrite[]; nonces: NonceRow[]; meta: { k: string; v: string }[] };
  /** the conditions the rules couldn't judge this tick (`unjudged`): their open alerts are left as they are */
  unjudged: Unjudged[];
}

/** A condition `rule` couldn't judge this tick (`key`'s, or with no key every alert of the rule): the reading it reads
 * is missing, or lacks a field it needs. Its open alerts stay open (never resolved, still sent and re-sent as usual),
 * so a condition resolves only on a reading that shows it cleared. Returns no findings, for `return unjudged(…)`. */
export function unjudged(ctx: RuleCtx, rule: RuleId, key?: string): Finding[] {
  ctx.unjudged.push(key === undefined ? { rule } : { rule, key });
  return [];
}

const EXPLORER: Record<ChainName, string> = { base: "https://basescan.org", bittensor: "https://evm.taostats.io" };
export const addressLink = (chain: ChainName, a: Hex): string => `${EXPLORER[chain]}/address/${a}`;
export const txLink = (chain: ChainName, hash: Hex): string => `${EXPLORER[chain]}/tx/${hash}`;

/** A chain time as an email shows it: "2026-10-29 14:05 UTC"; "unknown" for a time that isn't a number
 * (an email must never fail to render). */
export const utc = (t: number): string => (Number.isFinite(t) ? `${new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC` : "unknown");

/** How an email names a scanned contract. */
export const CONTRACT_NAMES: Record<Role, string> = {
  frontDoor: "front door",
  staker: "staker",
  baseAdapter: "Base adapter",
  vault: "vault",
  bitAdapter: "Bittensor adapter",
  // ForeverMoney's (watched for their admin events only): FM-TAO on Base is wTAO on Bittensor
  fmTao: "FM-TAO (wTAO on Bittensor)",
  tokenPool: "CCIP token pool",
  alphaVault: "AlphaVault",
};

/** This tick stores the log for the first time. */
export const isNew = (ctx: RuleCtx, l: Pick<StoredLog, "uid">): boolean => ctx.newUids.has(l.uid);

/** A condition on readings: true or false, or undefined when a reading lacks what it needs to tell. */
export type Cond = (r: Readings) => boolean | undefined;

/** The condition held in this reading and in the previous one too, from an older block, on each chain it
 * reads: one bad answer can't trip a rule marked ×2. False as soon as this tick's reading shows it doesn't hold
 * (one good reading clears it). Undefined when that can't be told: a chain without this tick's reading, the
 * condition unknown on it, or holding on it with no older reading (or one lacking the field) to confirm it. A rule
 * leaves its open alert as it is on undefined (`unjudged`). */
export function twice(ctx: RuleCtx, chains: ChainName | readonly ChainName[], cond: Cond): boolean | undefined {
  const list = typeof chains === "string" ? [chains] : chains;
  if (list.some((c) => !ctx.snap[c])) return undefined;
  const now = cond({ base: ctx.snap.base?.state, bittensor: ctx.snap.bittensor?.state });
  if (now !== true) return now;
  for (const c of list) {
    const before = ctx.previous[c];
    if (!before || before.block >= (ctx.snap[c] as ChainReading<unknown>).block) return undefined;
  }
  return cond({ base: ctx.previous.base?.state, bittensor: ctx.previous.bittensor?.state });
}

/** `twice` holds on one chain and this is its first tick: the reading before the previous one (if older)
 * didn't hold. A rule that holds raises its hold only then, under an id of that occurrence (a cleared
 * hold id is never raised again), and keeps finding the same alert while the condition lasts. A reading before the
 * previous one that couldn't tell (the field unread) counts as not holding: a condition that outlasts an unread
 * reading raises its hold again under a new id. That fails closed (one more hold to look at and clear), and
 * test/worker/rules-unjudged.test.ts pins it. A condition on both chains (rails.incoherent) is in its first tick when
 * the readings before the previous ones, on both chains, didn't hold together (either one missing: first). */
export function onset(ctx: RuleCtx, chains: ChainName | readonly ChainName[], cond: Cond): boolean {
  if (!twice(ctx, chains, cond)) return false;
  const earlier: Readings = {};
  for (const c of typeof chains === "string" ? [chains] : chains) {
    const [p, e] = ctx.history[c];
    if (!p || !e || e.block >= p.block) return true;
    if (c === "base") earlier.base = e.state as BaseState;
    else earlier.bittensor = e.state as BitState;
  }
  return !cond(earlier);
}

/** The other chain's stored history reaches past `time`: a cross-chain rule may judge an event then, and
 * never before its other side could be stored. */
export const afterSettled = (ctx: RuleCtx, chain: ChainName, time: number): boolean => ctx.settled[chain].time >= time;

/** What one tick's rules need from D1, beyond the tick's own logs and readings. */
export interface PrefetchNeeds {
  /** every stored log on each chain from this block on (the readings' range) */
  since: Record<ChainName, bigint>;
  /** front door histories (requests, cancels, the close) of these batch ids, with the close's transaction */
  batchIds: bigint[];
  /** Bittensor transactions (deliveries) whose logs to load */
  bitTxs: Hex[];
  /** Base transactions (landings) whose logs to load */
  baseTxs: Hex[];
  /** payout keys: their delivery's payout list and queue, their chunks and the chunks' transactions */
  payoutKeys: Hex[];
  /** transactions whose senders to load (this tick's own too: those found are not new) */
  txHashes: Hex[];
  /** blocks whose times to load (and, with them, the times of every block from `since` on, of Base's from
   * `requestsSince` on, and of the blocks of `bitTxs` and `baseTxs`) */
  blocks: { chain: ChainName; number: bigint }[];
  /** Base block 24 hours back: the redeem requests since */
  requestsSince: bigint;
  /** the open batch: its deposits' transactions (the staker's Staked there names who really paid) and its deposit
   * cancels' (R8: batch.cancel_churn) */
  openBatch?: bigint;
  /** bridge messages whose destination adapter's Delivered to load (one stored before its Sent arrived) */
  messageIds?: Hex[];
  /** v3.2: the keys of this tick's own park events, whose earlier park events to load (every open park's are loaded
   * anyway, and the parks of the deliveries `bitTxs` checks, and of the landings `payoutKeys` names: a refund's key is
   * its park's) */
  parkKeys?: Hex[];
  /** v3.2: payout batches still queued (pendingPayoutKeys): their vault events, so the entries not sent yet are known */
  queuedKeys?: Hex[];
  /** v3.2 (unstakes.wash): the holders of this tick's new Redeemed and RedeemDeferred, whose vault Deposited (by topic2)
   * and DepositedDirect (by topic1) to load from Bittensor block `washSince` on */
  washUsers?: Hex[];
  washSince?: bigint;
}

const PARK_EVENT_LIST = "'BatchParked', 'ParkedConverted', 'ParkedDelivered', 'ParkedRefunded', 'ParkedDropped'";
/** The keys of the parks still open in D1: a BatchParked with no ParkedDelivered, ParkedRefunded or ParkedDropped of
 * its adapter and key after it (src/parks.ts). */
const OPEN_PARK_KEYS = `SELECT p.topic1 FROM logs p INDEXED BY logs_by_event WHERE p.chain = 'bittensor' AND p.contract = 'bitAdapter'
  AND p.event = 'BatchParked' AND p.removed = 0 AND NOT EXISTS (
    SELECT 1 FROM logs c WHERE c.contract = 'bitAdapter' AND c.event IN ('ParkedDelivered', 'ParkedRefunded', 'ParkedDropped')
    AND c.topic1 = p.topic1 AND c.chain = 'bittensor' AND c.address = p.address AND c.removed = 0
    AND (c.block > p.block OR (c.block = p.block AND c.log_index > p.log_index)))`;
/** The Base adapter's Sent of each park a refund landing names (by the BatchParked's message id): the parked batch's
 * close transaction. */
const REFUNDED_CLOSE_TXS = `SELECT s.tx_hash FROM logs s WHERE s.contract = 'baseAdapter' AND s.event = 'Sent' AND s.chain = 'base' AND s.removed = 0
  AND s.topic1 IN (SELECT b.topic2 FROM logs b WHERE b.contract = 'bitAdapter' AND b.event = 'BatchParked' AND b.chain = 'bittensor'
    AND b.removed = 0 AND b.topic1 IN (SELECT value FROM json_each(?1)))`;

export interface Prefetched {
  logs: StoredLog[];
  batchChecks: BatchCheckRow[];
  chunkChecks: ChunkCheckRow[];
  txs: TxRow[];
  /** `${chain}:${number}` → time */
  blockTimes: Map<string, number>;
}

type Row = Record<string, unknown>;
const json = (xs: readonly unknown[]) => JSON.stringify(xs);
const REQUESTS = ["DepositRequested", "DepositCancelled", "RedeemRequested", "RedeemCancelled", "BatchClosed", "BatchRolled"];

/** Everything the rules read from D1, in one db.batch(). Lists are bound as JSON arrays (json_each), so
 * every statement is fixed. Removed logs are never loaded. */
export async function prefetch(db: D1Database, n: PrefetchNeeds): Promise<Prefetched> {
  const batchTopics = json(n.batchIds.map((id) => pad(numberToHex(id))));
  const keys = json(n.payoutKeys.map((k) => k.toLowerCase()));
  // the vault's events of the payout keys the checks look at, and of the batches still queued
  const vaultKeys = json([...new Set([...n.payoutKeys, ...(n.queuedKeys ?? [])].map((k) => k.toLowerCase()))]);
  const parkKeys = json([...new Set([...(n.parkKeys ?? []), ...n.payoutKeys].map((k) => k.toLowerCase()))]);
  const washTopics = json([...new Set((n.washUsers ?? []).map((u) => pad(u.toLowerCase() as Hex)))]);
  const washSince = Number(n.washSince ?? 0n);
  const rs = await db.batch<Row>([
    db.prepare("SELECT * FROM logs WHERE chain = 'bittensor' AND block >= ?1 AND removed = 0").bind(Number(n.since.bittensor)),
    db.prepare("SELECT * FROM logs WHERE chain = 'base' AND block >= ?1 AND removed = 0").bind(Number(n.since.base)),
    // the batches' front door histories, by batch id (topic1 of every request, cancel and close)
    db
      .prepare(
        `SELECT * FROM logs INDEXED BY logs_by_topic1 WHERE contract = 'frontDoor' AND event IN (SELECT value FROM json_each(?1))
         AND topic1 IN (SELECT value FROM json_each(?2)) AND chain = 'base' AND removed = 0`,
      )
      .bind(json(REQUESTS), batchTopics),
    // the closes' transactions (the adapter's Sent comes before each BatchClosed)
    db
      .prepare(
        `SELECT * FROM logs WHERE chain = 'base' AND removed = 0 AND tx_hash IN (
           SELECT tx_hash FROM logs INDEXED BY logs_by_topic1 WHERE contract = 'frontDoor' AND event = 'BatchClosed'
           AND topic1 IN (SELECT value FROM json_each(?1)))`,
      )
      .bind(batchTopics),
    db.prepare("SELECT * FROM logs WHERE chain = 'bittensor' AND tx_hash IN (SELECT value FROM json_each(?1)) AND removed = 0").bind(json(n.bitTxs)),
    db.prepare("SELECT * FROM logs WHERE chain = 'base' AND tx_hash IN (SELECT value FROM json_each(?1)) AND removed = 0").bind(json(n.baseTxs)),
    // the payout keys' lists, queues and chunks on the vault
    db
      .prepare(
        `SELECT * FROM logs INDEXED BY logs_by_topic1 WHERE contract = 'vault'
         AND event IN ('BatchDelivered', 'DepositBounced', 'Redeemed', 'PayoutBatchQueued', 'PayoutChunkSent', 'PayoutBatchCancelled')
         AND topic1 IN (SELECT value FROM json_each(?1)) AND chain = 'bittensor' AND removed = 0`,
      )
      .bind(vaultKeys),
    // the chunks' transactions (the Bittensor adapter's Sent comes before each PayoutChunkSent)
    db
      .prepare(
        `SELECT * FROM logs WHERE chain = 'bittensor' AND removed = 0 AND tx_hash IN (
           SELECT tx_hash FROM logs INDEXED BY logs_by_topic1 WHERE contract = 'vault' AND event = 'PayoutChunkSent'
           AND topic1 IN (SELECT value FROM json_each(?1)))`,
      )
      .bind(keys),
    db.prepare("SELECT * FROM batch_checks WHERE batch_id IN (SELECT value FROM json_each(?1))").bind(json(n.batchIds.map(Number))),
    db.prepare("SELECT * FROM chunk_checks WHERE batch_key IN (SELECT value FROM json_each(?1))").bind(keys),
    db.prepare("SELECT * FROM txs WHERE chain IN ('base', 'bittensor') AND hash IN (SELECT value FROM json_each(?1))").bind(json(n.txHashes.map((x) => x.toLowerCase()))),
    // the times of the blocks asked, of the loaded deliveries' and landings' blocks, and of every block from
    // the readings' range (and Base's day) on: the blocks table holds only blocks with stored logs
    db
      .prepare(
        `SELECT b.chain, b.number, b.time FROM json_each(?1) j
         JOIN blocks b ON b.chain = json_extract(j.value, '$.chain') AND b.number = json_extract(j.value, '$.number')
         UNION SELECT chain, number, time FROM blocks WHERE chain = 'bittensor' AND number IN (
           SELECT block FROM logs WHERE chain = 'bittensor' AND tx_hash IN (SELECT value FROM json_each(?2)))
         UNION SELECT chain, number, time FROM blocks WHERE chain = 'base' AND number IN (
           SELECT block FROM logs WHERE chain = 'base' AND tx_hash IN (SELECT value FROM json_each(?3)))
         UNION SELECT chain, number, time FROM blocks WHERE (chain = 'base' AND number >= ?4) OR (chain = 'bittensor' AND number >= ?5)
         UNION SELECT chain, number, time FROM blocks WHERE chain = 'bittensor' AND number IN (
           SELECT block FROM logs WHERE chain = 'bittensor' AND contract = 'bitAdapter' AND event = 'BatchParked' AND removed = 0
           AND topic1 IN (${OPEN_PARK_KEYS}))`,
      )
      .bind(
        json(n.blocks.map((b) => ({ chain: b.chain, number: Number(b.number) }))),
        json(n.bitTxs),
        json(n.baseTxs),
        Number(n.since.base < n.requestsSince ? n.since.base : n.requestsSince),
        Number(n.since.bittensor),
      ),
    // the last 25 hours' redeem requests (unstakes.tiny_wave) and closes (batch.deposits_full: lists closed at their half)
    db.prepare("SELECT * FROM logs WHERE chain = 'base' AND contract = 'frontDoor' AND event IN ('RedeemRequested', 'BatchClosed') AND block >= ?1 AND removed = 0").bind(Number(n.requestsSince)),
    // the open batch's deposits' and deposit cancels' transactions (nothing matches '' when there is none): the cancels
    // whatever their age, for batch.cancel_churn (R8)
    db
      .prepare(
        `SELECT * FROM logs WHERE chain = 'base' AND removed = 0 AND tx_hash IN (
           SELECT tx_hash FROM logs INDEXED BY logs_by_topic1 WHERE contract = 'frontDoor' AND event IN ('DepositRequested', 'DepositCancelled') AND topic1 = ?1)`,
      )
      .bind(n.openBatch === undefined ? "" : pad(numberToHex(n.openBatch))),
    db
      .prepare(
        `SELECT * FROM logs INDEXED BY logs_by_topic1 WHERE contract IN ('baseAdapter', 'bitAdapter') AND event = 'Delivered'
         AND topic1 IN (SELECT value FROM json_each(?1)) AND removed = 0`,
      )
      .bind(json((n.messageIds ?? []).map((m) => m.toLowerCase()))),
    // v3.2's parks (src/parks.ts): every event of each park still open, of this tick's park events' keys and the payout
    // keys (a refund's key is its park's), and of the parks the checked deliveries delivered (their ParkedDelivered)
    db
      .prepare(
        `SELECT * FROM logs INDEXED BY logs_by_event WHERE chain = 'bittensor' AND contract = 'bitAdapter' AND event IN (${PARK_EVENT_LIST})
         AND removed = 0 AND (topic1 IN (${OPEN_PARK_KEYS}) OR topic1 IN (SELECT value FROM json_each(?1))
           OR topic1 IN (SELECT d.topic1 FROM logs d WHERE d.chain = 'bittensor' AND d.contract = 'bitAdapter' AND d.event = 'ParkedDelivered'
             AND d.removed = 0 AND d.tx_hash IN (SELECT value FROM json_each(?2))))`,
      )
      .bind(parkKeys, json(n.bitTxs)),
    // a refund landing's: the refund's transaction (the adapter's Sent, then ParkedRefunded) ...
    db
      .prepare(
        `SELECT * FROM logs WHERE chain = 'bittensor' AND removed = 0 AND tx_hash IN (
           SELECT r.tx_hash FROM logs r WHERE r.contract = 'bitAdapter' AND r.event = 'ParkedRefunded' AND r.chain = 'bittensor'
           AND r.removed = 0 AND r.topic1 IN (SELECT value FROM json_each(?1)))`,
      )
      .bind(keys),
    // ... the parked batch's close on Base (the Base adapter's Sent of the park's message, then BatchClosed) ...
    db.prepare(`SELECT * FROM logs WHERE chain = 'base' AND removed = 0 AND tx_hash IN (${REFUNDED_CLOSE_TXS})`).bind(keys),
    // ... and that batch's requests and cancels
    db
      .prepare(
        `SELECT * FROM logs INDEXED BY logs_by_topic1 WHERE contract = 'frontDoor' AND event IN (SELECT value FROM json_each(?2)) AND chain = 'base'
         AND removed = 0 AND topic1 IN (SELECT c.topic1 FROM logs c WHERE c.chain = 'base' AND c.contract = 'frontDoor' AND c.event = 'BatchClosed'
           AND c.removed = 0 AND c.tx_hash IN (${REFUNDED_CLOSE_TXS}))`,
      )
      .bind(keys, json(REQUESTS)),
    // v3.2 (unstakes.wash): the mints of this tick's unstaking holders, a door's deposit (user in topic2) or a direct one
    // (user in topic1), back to washSince (nothing matches with none asked)
    db
      .prepare(
        `SELECT * FROM logs INDEXED BY logs_by_topic2 WHERE contract = 'vault' AND event = 'Deposited' AND topic2 IN (SELECT value FROM json_each(?1))
         AND chain = 'bittensor' AND block >= ?2 AND removed = 0`,
      )
      .bind(washTopics, washSince),
    db
      .prepare(
        `SELECT * FROM logs INDEXED BY logs_by_topic1 WHERE contract = 'vault' AND event = 'DepositedDirect' AND topic1 IN (SELECT value FROM json_each(?1))
         AND chain = 'bittensor' AND block >= ?2 AND removed = 0`,
      )
      .bind(washTopics, washSince),
  ]);
  const rows = (i: number) => rs[i].results;
  return {
    logs: [0, 1, 2, 3, 4, 5, 6, 7, 12, 13, 14, 15, 16, 17, 18, 19, 20].flatMap((i) => rows(i).map(logOf)),
    batchChecks: rows(8).map(batchCheckOf),
    chunkChecks: rows(9).map(chunkCheckOf),
    txs: rows(10).map(txRowOf),
    blockTimes: new Map(rows(11).map((r) => [`${r.chain}:${r.number}`, Number(r.time)])),
  };
}
