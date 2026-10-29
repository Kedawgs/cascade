import { type Hex, numberToHex, pad } from "viem";
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
   * scan's `fresh` (logs within SETTLE of the head, not stored), and not re-mined logs coming back. An
   * event rule reports a log once, on the tick it is first stored. */
  newUids: ReadonlySet<Hex>;
  payoutDelayS: number;
  lagLimitS: number;
  logs: LogQuery;
  /** the cross-check rows of the batches and payout keys this tick looks at */
  checks: { batches: BatchCheckRow[]; chunks: ChunkCheckRow[] };
  /** a block's time, when known (blocks holding stored logs) */
  blockTime: (chain: ChainName, block: bigint) => number | undefined;
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
  /** the watched addresses' rows */
  nonces: NonceRow[];
  t: Thresholds;
  holdActive: boolean;
  meta: Record<string, string>;
  /** rows the rules decided this tick, committed with everything else */
  writes: { batchChecks: BatchCheckWrite[]; chunkChecks: ChunkCheckWrite[]; nonces: NonceRow[]; meta: { k: string; v: string }[] };
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
};

/** This tick stores the log for the first time. */
export const isNew = (ctx: RuleCtx, l: Pick<StoredLog, "uid">): boolean => ctx.newUids.has(l.uid);

/** The condition held in this reading and in the previous one too, from an older block, on each chain it
 * reads: one bad answer can't trip a rule marked ×2. */
export function twice(ctx: RuleCtx, chains: ChainName | readonly ChainName[], cond: (r: Readings) => boolean): boolean {
  const list = typeof chains === "string" ? [chains] : chains;
  for (const c of list) {
    const now = ctx.snap[c];
    const before = ctx.previous[c];
    if (!now || !before || before.block >= now.block) return false;
  }
  const now: Readings = { base: ctx.snap.base?.state, bittensor: ctx.snap.bittensor?.state };
  const before: Readings = { base: ctx.previous.base?.state, bittensor: ctx.previous.bittensor?.state };
  return cond(now) && cond(before);
}

/** `twice` holds on one chain and this is its first tick: the reading before the previous one (if older)
 * didn't hold. A rule that holds raises its hold only then, under an id of that occurrence (a cleared
 * hold id is never raised again), and keeps finding the same alert while the condition lasts. */
export function onset(ctx: RuleCtx, chain: ChainName, cond: (r: Readings) => boolean): boolean {
  if (!twice(ctx, chain, cond)) return false;
  const [p, e] = ctx.history[chain];
  if (!p || !e || e.block >= p.block) return true;
  return !cond({ [chain]: e.state });
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
  /** blocks whose times to load */
  blocks: { chain: ChainName; number: bigint }[];
  /** Base block 24 hours back: the redeem requests since */
  requestsSince: bigint;
}

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
         AND event IN ('BatchDelivered', 'DepositBounced', 'Redeemed', 'PayoutBatchQueued', 'PayoutChunkSent')
         AND topic1 IN (SELECT value FROM json_each(?1)) AND chain = 'bittensor' AND removed = 0`,
      )
      .bind(keys),
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
    db
      .prepare(
        `SELECT b.chain, b.number, b.time FROM json_each(?1) j
         JOIN blocks b ON b.chain = json_extract(j.value, '$.chain') AND b.number = json_extract(j.value, '$.number')`,
      )
      .bind(json(n.blocks.map((b) => ({ chain: b.chain, number: Number(b.number) })))),
    db.prepare("SELECT * FROM logs WHERE chain = 'base' AND contract = 'frontDoor' AND event = 'RedeemRequested' AND block >= ?1 AND removed = 0").bind(Number(n.requestsSince)),
  ]);
  const rows = (i: number) => rs[i].results;
  return {
    logs: [0, 1, 2, 3, 4, 5, 6, 7, 12].flatMap((i) => rows(i).map(logOf)),
    batchChecks: rows(8).map(batchCheckOf),
    chunkChecks: rows(9).map(chunkCheckOf),
    txs: rows(10).map(txRowOf),
    blockTimes: new Map(rows(11).map((r) => [`${r.chain}:${r.number}`, Number(r.time)])),
  };
}
