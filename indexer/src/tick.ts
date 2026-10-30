import type { Hex } from "viem";
import { type Due, type Finding, markSent, reconcile } from "./alerts.ts";
import { argSenders, blockTimes, fetchTxs, PER_TICK, txsToFetch } from "./attribute.ts";
import { type ChainName, type Config, rolesOf, scanAddresses } from "./config.ts";
import { deliveredChecks } from "./crosscheck/payouts.ts";
import { type AlertItem, type Outgoing, renderCritical, renderDbFailing, renderResolved, renderWarnings, sendAll } from "./email.ts";
import { holdStatements } from "./hold.ts";
import { getJson } from "./http.ts";
import type { StoredLog, StoredRef } from "./logs.ts";
import { arrivals, arrivalStatements, messagesFrom, messageStatements, stateStatements } from "./messages.ts";
import { poolPriceUsd, type Reference, referencePrice } from "./prices.ts";
import { ADMIN_RULES, roleWallets, watchedRoles } from "./rules/admin.ts";
import { APPROVAL_RULES } from "./rules/approvals.ts";
import { BRIDGE_RULES } from "./rules/bridge.ts";
import { CCIP_RULES } from "./rules/ccip.ts";
import { logQuery, prefetch, type PrefetchNeeds, type RuleCtx } from "./rules/context.ts";
import { type Rule, runRules } from "./rules/index.ts";
import { MARKET_RULES } from "./rules/market.ts";
import { lagLimitOf, OPS_RULES } from "./rules/ops.ts";
import { PRICE_RULES } from "./rules/price.ts";
import { SITE_RULES } from "./rules/site.ts";
import { SOLVENCY_RULES } from "./rules/solvency.ts";
import { Budget, createRpc } from "./rpc.ts";
import { headTimeOf, rereadRange, type ScanResult, type ScanStop, scanChain } from "./scan.ts";
import { pageEvents, seedEventsOf } from "./seed.ts";
import { type BaseState, type BitState, type ChainReading, compact, compactHour, expand, expandHour, type HourAgg, hourRollup, payoutsDone, readSnapshot, type Snapshot } from "./snapshot.ts";
import {
  appendStatements,
  type BatchCheckRow,
  type ChunkCheckRow,
  checkDeployment,
  countStatements,
  type CursorRow,
  deploymentStatement,
  guardStatement,
  insertReading,
  insertTxs,
  leaseHolder,
  loadTickState,
  markRemoved,
  type MessageRow,
  payoutDoneStatements,
  rebuildStatements,
  releaseLease,
  rereadStored,
  returnedIds,
  seedLogs,
  setCursor,
  setMeta,
  takeLease,
  type TickState,
  type TxRow,
  upsertBatchCheck,
  upsertBlocks,
  upsertChunkCheck,
  upsertHour,
  upsertLogs,
  upsertNonces,
} from "./store.ts";

// The minute's tick (spec section 1): take the lease, load, scan both chains, read their state, run the rules,
// commit everything under the lease, then send the emails due and mark them sent. It never runs the site check
// (its own cron) and holds no key.

const CHAINS: readonly ChainName[] = ["bittensor", "base"];

/** Every rule the tick runs. The bridge cross-checks wait while either chain is catching up. */
export const TICK_RULES: readonly Rule[] = [
  ...SITE_RULES,
  ...APPROVAL_RULES,
  ...ADMIN_RULES,
  ...PRICE_RULES,
  ...SOLVENCY_RULES,
  ...BRIDGE_RULES,
  ...CCIP_RULES,
  ...MARKET_RULES,
  ...OPS_RULES,
];

/** Subrequests kept back from the scan for everything after it (spec 3.6): two multicalls, two nonce batches,
 * up to two block-time and two transaction batches, and two price reads. */
export const RESERVE = 10;
/** Bittensor is scanned first; this many more subrequests, and the last quarter of the wall time, are kept
 * for Base's scan, so Base can't stall while Bittensor backfills (the decode budget is shared out too). */
const BASE_SCAN_RESERVE = 4;
const BIT_WALL_SHARE = 0.75;
/** The RPC client's deadline for the whole tick: the lease less this, so the commit lands inside the lease. */
const LEASE_MARGIN_S = 30;
/** The lag must shrink by at least this much in a tick (settled time gained beyond the head's) to count as
 * catching up: a chain whose settled block is frozen, or that only keeps pace, is stuck, and its alerts fire. */
export const CATCH_UP_GAIN_S = 60;
/** The findings quiet while a chain catches up: a check waiting on the other chain is expected to. */
const QUIET_WHILE_CATCHING_UP: ReadonlySet<string> = new Set(["bridge.check_stuck", "bridge.payout_unchecked"]);
/** Base blocks in 24 hours (2-second blocks): the redeem requests unstakes.tiny_wave counts. */
const DAY_BASE_BLOCKS = 43_200n;
/** At most this many transactions wait in the retry list (meta tx_backlog), the newest kept. */
const TX_BACKLOG_MAX = 500;
/** A transaction a node has answered without this many times (a minute apart) is given up. */
const MAX_TX_TRIES = 10;
/** The payout delay used before any reading has given one: v3-test's, the shortest (the earliest deadline,
 * the tightest lag limit). */
export const DEFAULT_PAYOUT_DELAY_S = 3600;

export interface TickDeps {
  env: { DB: D1Database; EMAIL?: SendEmail };
  cfg: Config;
  /** every external request goes through this: the RPCs and the price APIs */
  fetch: typeof fetch;
  /** the Worker's clock, in ms */
  now: () => number;
  /** when the cron fired, in ms: its minute decides the price reads and the db_failing email */
  scheduledMs: number;
  /** the lease's holder for this tick (random by default) */
  holder?: string;
  sleep?: (ms: number) => Promise<void>;
  spacingMs?: Partial<Record<ChainName, number>>;
}

export interface TickReport {
  outcome: "done" | "skipped" | "refused" | "lost_lease" | "db_failing" | "failed";
  stopped?: Partial<Record<ChainName, ScanStop>>;
  catchingUp?: ChainName[];
  findings?: number;
  due?: number;
  sent?: number;
  failedEmails?: number;
  /** external requests made */
  subrequests?: number;
  /** logs hashed and decoded */
  decoded?: number;
  error?: string;
}

const dayOf = (nowS: number) => new Date(nowS * 1000).toISOString().slice(0, 10);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const big = (x: unknown) => BigInt(String(x));
const lower = (x: unknown) => String(x).toLowerCase() as Hex;
const num = (s: string | undefined) => (s === undefined || s === "" || !Number.isFinite(Number(s)) ? undefined : Number(s));
const uniq = <T>(xs: Iterable<T>) => [...new Set(xs)];
const json = <T>(s: string | undefined): T | undefined => {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
};
const bestEffort = async (p: () => Promise<unknown>) => {
  try {
    await p();
  } catch {
    // counting a skipped or failed tick is never worth failing over
  }
};

/** A chain's cursor before its first commit: nothing scanned, settled to the block before its start. */
const freshCursor = (chain: ChainName, startBlock: bigint, nowS: number): CursorRow => ({
  chain,
  fromBlock: startBlock,
  scannedTo: null,
  settledTo: startBlock - 1n,
  settledTime: null,
  headTime: null,
  updatedAt: nowS,
});

/** The readings stored before this tick, per chain, newest first. */
export function historyOf(state: Pick<TickState, "lastReadings">): { base: ChainReading<BaseState>[]; bittensor: ChainReading<BitState>[] } {
  const out: { base: ChainReading<BaseState>[]; bittensor: ChainReading<BitState>[] } = { base: [], bittensor: [] };
  for (const r of state.lastReadings) {
    let s: Snapshot;
    try {
      s = expand(r.json);
    } catch {
      continue;
    }
    if (r.baseBlock !== null && s.base) out.base.push(s.base);
    if (r.bitBlock !== null && s.bittensor) out.bittensor.push(s.bittensor);
  }
  const newest = <T>(a: ChainReading<T>, b: ChainReading<T>) => (a.block > b.block ? -1 : a.block < b.block ? 1 : 0);
  out.base.sort(newest);
  out.bittensor.sort(newest);
  return out;
}

/** The payout delay: this reading's, else the last reading's that had one, else the last recorded, else
 * v3-test's (never undefined or NaN: a deadline and the lag limit are worked out from it). */
export function payoutDelayOf(snap: Snapshot, history: readonly ChainReading<BitState>[], meta: Readonly<Record<string, string>>): number {
  const ok = (x: number | undefined) => (x !== undefined && Number.isFinite(x) && x > 0 ? x : undefined);
  return ok(snap.bittensor?.state.payoutDelay) ?? ok(history.find((r) => ok(r.state.payoutDelay))?.state.payoutDelay) ?? ok(num(meta.payout_delay)) ?? DEFAULT_PAYOUT_DELAY_S;
}

/** Which blocks' times to fetch on a chain, at most PER_TICK: the new settled block first (its time is the
 * cursor's settled time), then the deliveries' and landings' blocks the cross-checks wait on, then the blocks
 * of the logs stored this tick, newest first. Blocks whose time is known are left out. */
export function blocksToTime(o: { settledTo?: bigint; checks: readonly bigint[]; logs: readonly bigint[]; known: (n: bigint) => boolean }): bigint[] {
  const out: bigint[] = [];
  const add = (n: bigint) => {
    if (out.length < PER_TICK && !o.known(n) && !out.includes(n)) out.push(n);
  };
  if (o.settledTo !== undefined) add(o.settledTo);
  for (const n of [...o.checks].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) add(n);
  for (const n of [...o.logs].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))) add(n);
  return out;
}

/** The chains catching up this tick (spec 3.2): during the first backfill only, until both chains have first come
 * within `floorS` of their heads (`caughtUp`, meta.caught_up), those more than `floorS` behind whose lag shrank by
 * CATCH_UP_GAIN_S or more this tick (their settled time gained that much more than their head's; a settled time
 * first known this tick counts as a gain). `floorS` is the lag limit (lagLimitOf: 15 minutes on v3-test, 30 at
 * launch), so a backfill never ends inside the lag or blind limits and pages on its way down. A settled block that
 * is frozen, or merely keeps pace, is not catching up. While a chain catches up its lag alerts are quiet, a
 * cross-check waiting on it isn't reported stuck, and the digest says so. */
export function catchingUpChains(o: {
  caughtUp: boolean;
  floorS: number;
  chains: Readonly<Record<ChainName, { lagS: number; settled: { before: number | null; now: number | null }; head: { before: number | null; now: number } }>>;
}): ChainName[] {
  if (o.caughtUp) return [];
  return CHAINS.filter((c) => {
    const x = o.chains[c];
    if (x.lagS <= o.floorS || x.settled.now === null) return false;
    if (x.settled.before === null) return true;
    const headGain = x.head.before === null ? 0 : x.head.now - x.head.before;
    return x.settled.now - x.settled.before - headGain >= CATCH_UP_GAIN_S;
  });
}

/** The seed is rebuilt instead of appended when a seed log was removed or re-mined, or a new seed event lies
 * at or below the last block already paged (a log a re-read found late): the pages stay in block order. */
export function seedNeedsRebuild(o: { lastPagedBlock?: bigint; newEvents: readonly { block: string }[]; changed: readonly Pick<StoredRef, "contract" | "event">[] }): boolean {
  const seedKind = (r: Pick<StoredRef, "contract" | "event">) => r.contract === "vault" && ["BatchDelivered", "Staked", "PayoutChunkSent"].includes(r.event);
  if (o.changed.some(seedKind)) return true;
  return o.lastPagedBlock !== undefined && o.newEvents.some((e) => BigInt(e.block) <= (o.lastPagedBlock as bigint));
}

/** One minute's tick. Never throws: what went wrong is in the report (and the log). */
export async function runTick(deps: TickDeps): Promise<TickReport> {
  const { cfg } = deps;
  const db = deps.env.DB;
  const startMs = deps.now();
  const nowS = Math.floor(startMs / 1000);
  const minute = new Date(deps.scheduledMs).getUTCMinutes();
  const holder = deps.holder ?? crypto.randomUUID();
  const date = dayOf(nowS);

  let leased: boolean;
  try {
    leased = await takeLease(db, holder, cfg.budgets.leaseS, nowS);
  } catch (e) {
    // the database can't even be asked: the one email that needs no D1, at most once an hour
    console.error(`tick: the lease couldn't be taken: ${message(e)}`);
    if (minute === 0) await sendAll(deps.env, cfg, [{ id: 0, ...renderDbFailing(message(e), nowS) }]);
    return { outcome: "db_failing", error: message(e) };
  }
  if (!leased) {
    await bestEffort(() => db.batch(countStatements(db, date, { ticks_skipped: 1 })));
    return { outcome: "skipped" };
  }
  try {
    return await work(deps, { db, startMs, nowS, minute, holder, date });
  } catch (e) {
    await bestEffort(() => db.batch([...countStatements(db, date, { ticks_failed: 1 }), releaseLease(db, holder)]));
    if (e instanceof DbError) {
      // the database can't be read: as a failing commit, no alert email, and the one stateless email at minute 0
      console.error(`tick: ${message(e)}`);
      if (minute === 0) await sendAll(deps.env, cfg, [{ id: 0, ...renderDbFailing(message(e.cause), nowS) }]);
      return { outcome: "db_failing", error: message(e.cause) };
    }
    // a bug: nothing was committed; the watchdog notices if it happens every tick
    console.error(`tick failed: ${message(e)}`);
    return { outcome: "failed", error: message(e) };
  }
}

/** A D1 query of the tick failed (after the lease was taken): the database is failing, not the code. */
class DbError extends Error {
  constructor(what: string, cause: unknown) {
    super(`${what} failed: ${message(cause)}`, { cause });
    this.name = "DbError";
  }
}

/** A tick's D1 read, failing as a DbError. */
const fromD1 = async <T>(what: string, read: () => Promise<T>): Promise<T> => {
  try {
    return await read();
  } catch (e) {
    throw new DbError(what, e);
  }
};

interface TickRun {
  db: D1Database;
  startMs: number;
  nowS: number;
  minute: number;
  holder: string;
  date: string;
}

async function work(deps: TickDeps, run: TickRun): Promise<TickReport> {
  const { cfg } = deps;
  const { db, startMs, nowS, minute, holder, date } = run;
  const d = cfg.deployment;
  const t = cfg.thresholds;

  // 2. what D1 holds
  const state = await fromD1("loading the tick's state", () => loadTickState(db, nowS));
  const refuse = async (why: string): Promise<TickReport> => {
    console.error(`tick refused: ${why}`);
    await bestEffort(() => releaseLease(db, holder).run());
    return { outcome: "refused", error: why };
  };
  if (checkDeployment(state.meta, d) === "other") return refuse("the database holds another deployment than DEPLOYMENT");
  const cursors = {} as Record<ChainName, CursorRow>;
  for (const c of CHAINS) {
    const cur = state.cursors[c] ?? freshCursor(c, d[c].startBlock, nowS);
    if (cur.fromBlock !== d[c].startBlock) return refuse(`the ${c} cursor starts at another block than DEPLOYMENT's`);
    cursors[c] = cur;
  }

  // 3. the stored logs of each chain's re-read range (one query; none before the first window)
  const ranges = CHAINS.flatMap((c) => {
    const r = rereadRange(c, cursors[c], d[c].startBlock);
    return r ? [{ chain: c, ...r }] : [];
  });
  const reread = ranges.length
    ? await fromD1("loading the re-read ranges' logs", () => rereadStored(db, ranges))
    : { stored: new Map<ChainName, Map<Hex, StoredRef>>(), removed: new Set<Hex>() };

  // 4. scan Bittensor, then Base
  const budget = new Budget(cfg.budgets.subrequests);
  const rpcDeadlineMs = startMs + Math.max(cfg.budgets.scanWallS, cfg.budgets.leaseS - LEASE_MARGIN_S) * 1000;
  const rpc = createRpc({
    urls: { base: cfg.rpc.base, baseLogs: cfg.rpc.baseLogs, bittensor: cfg.rpc.bittensor },
    fetch: deps.fetch,
    budget,
    sleep: deps.sleep,
    now: deps.now,
    spacingMs: deps.spacingMs,
    deadlineMs: rpcDeadlineMs,
  });
  const roleOf = rolesOf(d, cfg.bridges);
  const addresses = scanAddresses(cfg);
  const bitShare = Math.ceil(cfg.budgets.decode / 2);
  const bitDecode = new Budget(bitShare, "decode");
  const scans = {} as Record<ChainName, ScanResult>;
  scans.bittensor = await scanChain({
    rpc,
    chain: "bittensor",
    roleOf,
    addresses: addresses.bittensor,
    startBlock: d.bittensor.startBlock,
    cursor: cursors.bittensor,
    stored: reread.stored.get("bittensor") ?? new Map(),
    decodeBudget: bitDecode,
    deadlineMs: startMs + Math.floor(cfg.budgets.scanWallS * 1000 * BIT_WALL_SHARE),
    now: deps.now,
    reserve: { budget, keep: RESERVE + BASE_SCAN_RESERVE },
  });
  const bitSpent = bitShare - bitDecode.left;
  const baseDecode = new Budget(cfg.budgets.decode - bitSpent, "decode");
  scans.base = await scanChain({
    rpc,
    chain: "base",
    roleOf,
    addresses: addresses.base,
    startBlock: d.base.startBlock,
    cursor: cursors.base,
    stored: reread.stored.get("base") ?? new Map(),
    decodeBudget: baseDecode,
    deadlineMs: startMs + cfg.budgets.scanWallS * 1000,
    now: deps.now,
    window: cfg.baseLogWindow,
    reserve: { budget, keep: RESERVE },
  });
  for (const c of CHAINS) if (scans[c].error) console.warn(`${c} scan stopped (${scans[c].stopped}): ${scans[c].error}`);

  // what this tick stores: settled logs new to the store, and re-mined ones coming back
  const upserts = [...scans.bittensor.upserts, ...scans.base.upserts];
  const known = (l: StoredLog) => reread.stored.get(l.chain)?.has(l.uid) === true || reread.removed.has(l.uid);
  const newLogs = upserts.filter((l) => !known(l));
  const newUids = new Set(newLogs.map((l) => l.uid));
  const removed = CHAINS.flatMap((c) => scans[c].removed.map((uid) => ({ chain: c, uid })));
  const removedUids = new Set(removed.map((r) => r.uid));

  // 6. the readings: from the last reading, the hotkeys, keepers, oracle and role holders to read
  const history = historyOf(state);
  const previous = { base: history.base[0], bittensor: history.bittensor[0] };
  const last: Snapshot = { at: 0, base: previous.base, bittensor: previous.bittensor, nonces: { base: {}, bittensor: {} }, safeNonces: {}, messageStates: {}, deliveredReads: [] };
  const holders = watchedRoles(last);
  const watched = new Map<string, { chain: ChainName; address: Hex }>();
  for (const w of [...state.nonces.filter((r) => r.roles.length > 0), ...holders]) watched.set(`${w.chain}:${lower(w.address)}`, { chain: w.chain, address: lower(w.address) });
  const blockTimesKnown = new Map<string, number>();
  const pendingFresh = messagesFrom(newLogs, d, () => undefined, nowS);
  const snap = await readSnapshot(
    rpc,
    cfg,
    {
      last: { base: previous.base?.block, bittensor: previous.bittensor?.block },
      hotkeys: previous.bittensor?.state.hotkeys,
      stakeHotkey: previous.bittensor?.state.stakeHotkey,
      keepers: { base: previous.base?.state.keeper, bittensor: previous.bittensor?.state.keeper },
      oracle: previous.base?.state.oracle,
      pendingMessages: [...state.pendingMessages, ...pendingFresh].map((m) => ({ messageId: m.messageId, direction: m.direction })),
      // every watched address both ways: its transaction count, and nonce() in case it is a Safe (the keys rule
      // takes a Safe's nonce() over its count). The reading keeps a nonce() only from an address with contract
      // code of its own: an account answers nothing, and an EIP-7702 delegated account (code 0xef0100…), whose
      // delegate may answer, is judged by its transaction count
      // (snapshot.ts isContractCode)
      watched: [...watched.values()].flatMap((w) => [w, { ...w, isSafe: true }]),
      // every role wallet's code, the treasuries' too, for keys.delegated (in the same batch as the counts)
      codesOf: roleWallets(last).map((w) => ({ chain: w.chain, address: w.address })),
      payoutUsers: state.payoutUsers,
      deliveredChecks: deliveredChecks(state.awaitingReads),
      pendingPayoutKeys: state.pendingPayoutKeys,
    },
    nowS,
  );

  // the reference price, every fifth minute, when there is budget for it
  let reference: Reference | undefined;
  if (minute % 5 === 0 && cfg.priceSources.length > 0 && budget.left >= cfg.priceSources.length) {
    const timeoutMs = Math.max(1000, Math.min(10_000, rpcDeadlineMs - deps.now()));
    reference = await referencePrice({ getJson: (url) => getJson(url, { fetch: deps.fetch, budget, timeoutMs }), sources: cfg.priceSources });
  }

  // 7. what the rules read from D1
  const newDeliveries = newLogs.filter((l) => l.chain === "bittensor" && l.contract === "vault" && l.event === "BatchDelivered");
  const newLandings = newLogs.filter((l) => l.chain === "base" && l.contract === "frontDoor" && l.event === "PayoutsDelivered");
  const backlog = (json<{ chain: ChainName; hash: Hex; tries?: number }[]>(state.meta.tx_backlog) ?? []).filter((x) => (x.chain === "base" || x.chain === "bittensor") && /^0x[0-9a-f]{64}$/.test(x.hash));
  const triesOf = new Map(backlog.map((x) => [`${x.chain}:${x.hash}`, Number.isSafeInteger(x.tries) ? (x.tries as number) : 0]));
  const fromArgs = argSenders(newLogs);
  const toFetch = uniq([...txsToFetch(newLogs), ...backlog].map((x) => `${x.chain}:${x.hash}`)).map((k) => ({ chain: k.slice(0, k.indexOf(":")) as ChainName, hash: k.slice(k.indexOf(":") + 1) as Hex }));
  const oldest = (rs: readonly ChainReading<unknown>[], fallback: bigint) => (rs.length ? rs[rs.length - 1].block : fallback);
  const settledBase = scans.base.cursor.settledTo;
  const needs: PrefetchNeeds = {
    since: { base: oldest(history.base, settledBase + 1n), bittensor: oldest(history.bittensor, scans.bittensor.cursor.settledTo + 1n) },
    batchIds: uniq([...state.openChecks.batches.map((r) => r.batchId), ...newDeliveries.map((l) => big(l.args.batchId))]),
    bitTxs: uniq([...state.openChecks.batches.map((r) => r.deliveredTx), ...newDeliveries.map((l) => l.txHash)]),
    baseTxs: uniq([...state.openChecks.chunks.map((r) => r.landedTx), ...newLandings.map((l) => l.txHash)]),
    payoutKeys: uniq([...state.openChecks.chunks.map((r) => r.batchKey), ...newLandings.map((l) => lower(l.args.batchKey))]),
    txHashes: uniq([...toFetch.map((x) => x.hash), ...fromArgs.map((x) => x.hash)]),
    blocks: state.openChecks.chunks.map((r) => ({ chain: "base" as const, number: r.landedBlock })),
    requestsSince: settledBase > DAY_BASE_BLOCKS ? settledBase - DAY_BASE_BLOCKS : 0n,
    openBatch: snap.base?.state.openBatch?.id,
    messageIds: uniq([...state.pendingMessages, ...pendingFresh].map((m) => m.messageId)),
  };
  const pre = await fromD1("the prefetch", () => prefetch(db, needs));
  for (const [k, v] of pre.blockTimes) blockTimesKnown.set(k, v);

  // 5. block times and transactions (after the prefetch, which says which are stored already)
  const timeOf = (c: ChainName, n: bigint) => blockTimesKnown.get(`${c}:${n}`);
  const checkBlocks: Record<ChainName, bigint[]> = {
    bittensor: [...pre.logs.filter((l) => l.chain === "bittensor" && l.contract === "vault" && l.event === "BatchDelivered" && needs.bitTxs.includes(l.txHash)).map((l) => l.block), ...newDeliveries.map((l) => l.block)],
    base: [...state.openChecks.chunks.map((r) => r.landedBlock), ...newLandings.map((l) => l.block)],
  };
  const fetchedTimes: { chain: ChainName; number: bigint; time: number }[] = [];
  const fetched: TxRow[] = [];
  /** transactions a node answered for, with or without them */
  const answered = new Set<string>();
  await Promise.all(
    CHAINS.map(async (c) => {
      const settledTo = scans[c].cursor.settledTo > cursors[c].settledTo ? scans[c].cursor.settledTo : undefined;
      const blocks = blocksToTime({ settledTo, checks: checkBlocks[c], logs: newLogs.filter((l) => l.chain === c).map((l) => l.block), known: (n) => timeOf(c, n) !== undefined });
      if (blocks.length) {
        try {
          for (const [n, time] of await blockTimes(rpc, c, blocks)) {
            blockTimesKnown.set(`${c}:${n}`, time);
            fetchedTimes.push({ chain: c, number: n, time });
          }
        } catch (e) {
          console.warn(`${c} block times failed: ${message(e)}`);
        }
      }
      const fetchedBefore = new Set(pre.txs.filter((x) => x.chain === c && (x.to !== undefined || x.selector !== undefined)).map((x) => x.hash));
      const hashes = toFetch.filter((x) => x.chain === c && !fetchedBefore.has(x.hash)).map((x) => x.hash);
      if (hashes.length) {
        try {
          const asked = hashes.slice(0, PER_TICK);
          fetched.push(...(await fetchTxs(rpc, c, asked)));
          for (const h of asked) answered.add(`${c}:${h}`);
        } catch (e) {
          console.warn(`${c} transactions failed: ${message(e)}`);
        }
      }
    }),
  );
  const fetchedKeys = new Set(fetched.map((x) => `${x.chain}:${x.hash}`));
  const fetchedBeforeKeys = new Set(pre.txs.filter((x) => x.to !== undefined || x.selector !== undefined).map((x) => `${x.chain}:${x.hash}`));
  // what is still to fetch, the newest first, waits for the next tick; one a node answered without, MAX_TX_TRIES
  // times, is given up (a tick while the node is down doesn't count)
  const txBacklog = toFetch
    .filter((x) => !fetchedKeys.has(`${x.chain}:${x.hash}`) && !fetchedBeforeKeys.has(`${x.chain}:${x.hash}`))
    .map((x) => {
      const k = `${x.chain}:${x.hash}`;
      return { ...x, tries: (triesOf.get(k) ?? 0) + (answered.has(k) ? 1 : 0) };
    })
    .filter((x) => x.tries < MAX_TX_TRIES)
    .slice(0, TX_BACKLOG_MAX);
  const txRows = new Map<string, TxRow>();
  for (const r of fromArgs) if (!txRows.has(`${r.chain}:${r.hash}`)) txRows.set(`${r.chain}:${r.hash}`, r);
  for (const r of fetched) txRows.set(`${r.chain}:${r.hash}`, r);
  const storedTxs = new Map(pre.txs.map((x) => [`${x.chain}:${x.hash}`, x]));
  const newTxs = [...txRows.entries()].filter(([k]) => !storedTxs.has(k)).map(([, r]) => r);
  const txs = new Map(storedTxs);
  for (const [k, r] of txRows) if (!txs.has(k) || r.to !== undefined || r.selector !== undefined) txs.set(k, r);

  // each chain's cursor: settled_to moves only with its block's time known (settled_time is that block's time)
  const headTime = {} as Record<ChainName, number>;
  const next = {} as Record<ChainName, { scannedTo: bigint | null; settledTo: bigint; settledTime: number | null }>;
  for (const c of CHAINS) {
    headTime[c] = headTimeOf({ scanHeadTime: scans[c].headTime, readingTime: snap[c]?.time, nowS, previous: cursors[c].headTime });
    let settledTo = scans[c].cursor.settledTo;
    let settledTime = cursors[c].settledTime;
    if (settledTo > cursors[c].settledTo) {
      const time = timeOf(c, settledTo);
      if (time === undefined) settledTo = cursors[c].settledTo;
      else settledTime = time;
    }
    next[c] = { scannedTo: scans[c].cursor.scannedTo, settledTo, settledTime };
  }

  // messages: this tick's new ones, with their source time now that it may be known; arrivals, new or stored
  const newMessages = messagesFrom(newLogs, d, timeOf, nowS);
  const messageIds = new Set(needs.messageIds);
  const arrived = arrivals([...pre.logs.filter((l) => !removedUids.has(l.uid)), ...newLogs]).filter((a) => messageIds.has(a.messageId));
  const firstArrival = new Map<Hex, (typeof arrived)[number]>();
  for (const a of arrived) if (!firstArrival.has(a.messageId)) firstArrival.set(a.messageId, a);
  const messages: MessageRow[] = [...state.pendingMessages, ...newMessages.filter((m) => !state.pendingMessages.some((p) => p.messageId === m.messageId))].map((m) => {
    const a = firstArrival.get(m.messageId);
    return a && m.dstTx === null ? { ...m, dstTx: a.dstTx, dstBlock: a.dstBlock } : m;
  });

  // the seed pages: appended, or rebuilt from every seed log when one changed or a late one arrived
  const newSeed = seedEventsOf(newLogs.filter((l) => l.chain === "bittensor"), d);
  const changed = [
    ...scans.bittensor.removed.flatMap((uid) => {
      const r = reread.stored.get("bittensor")?.get(uid);
      return r ? [r] : [];
    }),
    ...upserts.filter((l) => l.chain === "bittensor" && known(l)),
  ];
  let seedStatements: D1PreparedStatement[] = [];
  if (seedNeedsRebuild({ lastPagedBlock: state.lastSeedPage?.lastBlock, newEvents: newSeed, changed })) {
    const byUid = new Map((await fromD1("reading the seed logs", () => seedLogs(db))).map((l) => [l.uid, l]));
    for (const uid of scans.bittensor.removed) byUid.delete(uid);
    for (const l of upserts) if (l.chain === "bittensor") byUid.set(l.uid, l);
    seedStatements = rebuildStatements(db, seedEventsOf([...byUid.values()], d));
  } else if (newSeed.length) {
    const last = state.lastSeedPage;
    seedStatements = appendStatements(db, last ? { page: last.page, events: pageEvents(last) } : null, newSeed);
  }

  // 8. the rules
  const payoutDelayS = payoutDelayOf(snap, history.bittensor, state.meta);
  const lagOf = (c: ChainName) => headTime[c] - (next[c].settledTime ?? 0);
  const caughtUp = state.meta.caught_up !== undefined && state.meta.caught_up !== "";
  // catching up lasts until the lag is under the lag limit, so the end of a backfill never pages
  const floorS = lagLimitOf(payoutDelayS, t);
  const catchingUp = catchingUpChains({
    caughtUp,
    floorS,
    chains: Object.fromEntries(
      CHAINS.map((c) => [c, { lagS: lagOf(c), settled: { before: cursors[c].settledTime, now: next[c].settledTime }, head: { before: cursors[c].headTime, now: headTime[c] } }]),
    ) as Parameters<typeof catchingUpChains>[0]["chains"],
  });
  // both chains within the lag limit for the first time: catching up is over for good (indexer.blind is never quiet after)
  const firstCaughtUp = !caughtUp && CHAINS.every((c) => next[c].settledTime !== null && lagOf(c) <= floorS);
  const hours = state.hours.flatMap((r) => {
    const h = expandHour(r.json);
    return h ? [h] : [];
  });
  const checks = mergeChecks(pre.batchChecks, state.openChecks.batches, pre.chunkChecks, state.openChecks.chunks);
  const ctx: RuleCtx = {
    cfg,
    nowS,
    snap,
    previous,
    history,
    holds: state.holds,
    hours,
    settled: {
      base: { block: next.base.settledTo, time: next.base.settledTime ?? 0, headTime: headTime.base },
      bittensor: { block: next.bittensor.settledTo, time: next.bittensor.settledTime ?? 0, headTime: headTime.bittensor },
    },
    newUids,
    payoutDelayS,
    lagLimitS: lagLimitOf(payoutDelayS, t),
    logs: logQuery([...pre.logs.map((l) => (removedUids.has(l.uid) ? { ...l, removed: true } : l)), ...upserts]),
    checks,
    blockTime: timeOf,
    txs,
    newTxs,
    messages,
    reference,
    payoutUsers: state.lastPayouts,
    pendingPayoutKeys: state.pendingPayoutKeys.map((p) => p.key),
    removed,
    approvals: state.approvals,
    nonces: state.nonces,
    t,
    holdActive: state.activeHolds.length > 0,
    meta: state.meta,
    writes: { batchChecks: [], chunkChecks: [], nonces: [], meta: [] },
  };
  // every rule runs, the cross-checks too (they wait for the other chain by themselves); while a chain catches
  // up, its lag alerts and the reports of checks stuck waiting are quiet: dropped if new, left as they are if open
  const findings = runRules(TICK_RULES, ctx);
  const quiet = (a: { rule: string; key: string }) =>
    catchingUp.length > 0 && (QUIET_WHILE_CATCHING_UP.has(a.rule) || catchingUp.some((c) => a.key === `indexer.lag:${c}` || a.key === `indexer.blind:${c}`));
  const r = reconcile(db, { open: state.openAlerts, findings, nowS, t, holdActive: ctx.holdActive, lastWarningSentAt: num(state.meta.last_warning_at), quiet });
  const holds = holdStatements(db, r.holds, state.holdIds, nowS);

  // 9. commit 1, guarded by the lease
  const meta = new Map<string, string>();
  for (const w of ctx.writes.meta) meta.set(w.k, w.v);
  // written only when they change (every row written counts against D1's quota)
  const changes = (k: string, v: string) => (state.meta[k] ?? "") !== v && meta.set(k, v);
  changes("tx_backlog", txBacklog.length ? JSON.stringify(txBacklog) : "");
  if (snap.bittensor?.state.payoutDelay !== undefined) changes("payout_delay", String(snap.bittensor.state.payoutDelay));
  changes("catching_up", catchingUp.join(","));
  if (firstCaughtUp) meta.set("caught_up", String(nowS));
  meta.set("last_complete_tick", String(nowS));
  const hourNow = Math.floor(nowS / 3600) * 3600;
  const hourPrev = hours.find((h) => h.hour === hourNow);
  const spot = snap.base ? poolPriceUsd(snap.base.state, cfg.tokens) : undefined;
  const statements: D1PreparedStatement[] = [
    guardStatement(db, holder),
    deploymentStatement(db, d),
    ...upsertLogs(db, upserts),
    ...markRemoved(db, removed.map((x) => x.uid)),
    ...CHAINS.map((c) => setCursor(db, { chain: c, fromBlock: d[c].startBlock, scannedTo: next[c].scannedTo, settledTo: next[c].settledTo, settledTime: next[c].settledTime, headTime: headTime[c], nowS })),
    ...seedStatements,
    ...upsertBlocks(db, fetchedTimes),
    ...insertTxs(db, [...txRows.values()]),
    ...(snap.base || snap.bittensor ? [insertReading(db, { at: nowS, baseBlock: snap.base?.block ?? null, bitBlock: snap.bittensor?.block ?? null, json: compact(snap) })] : []),
    upsertHour(db, hourNow, compactHour(hourRollup(hourPrev, snap, spot) as HourAgg)),
    ...messageStatements(db, newMessages),
    ...arrivalStatements(db, [...firstArrival.values()]),
    ...stateStatements(db, snap.messageStates, nowS),
    ...payoutDoneStatements(db, payoutsDone(snap, state.pendingPayoutKeys)),
    ...ctx.writes.batchChecks.map((c) => upsertBatchCheck(db, c)),
    ...ctx.writes.chunkChecks.map((c) => upsertChunkCheck(db, c)),
    ...upsertNonces(db, ctx.writes.nonces),
    ...[...meta].map(([k, v]) => setMeta(db, k, v)),
    ...r.statements,
    ...holds,
    ...countStatements(db, date, { ticks_run: 1 }),
  ];
  const report: TickReport = {
    outcome: "done",
    stopped: { base: scans.base.stopped, bittensor: scans.bittensor.stopped },
    catchingUp,
    findings: findings.length,
    due: r.due.length,
    decoded: bitSpent + (baseDecode.limit - baseDecode.left),
  };
  let results: D1Result<unknown>[];
  try {
    results = await db.batch(statements);
  } catch (e) {
    let lost = false;
    try {
      const h = await leaseHolder(db);
      lost = h !== null && h.holder !== holder;
    } catch {
      // the database can't be read either: a D1 failure
    }
    if (lost) {
      // another tick took the lease over and does the work: stop quietly
      return { ...report, outcome: "lost_lease", subrequests: budget.limit - budget.left };
    }
    console.error(`tick: commit 1 failed: ${message(e)}`);
    // counted, and the lease let go, if the database takes even that: the next tick tries again at once
    await bestEffort(() => db.batch([...countStatements(db, date, { ticks_failed: 1 }), releaseLease(db, holder)]));
    // no alert email (none is committed); the one stateless email, at most once an hour
    if (minute === 0) await sendAll(deps.env, cfg, [{ id: 0, ...renderDbFailing(message(e), nowS) }]);
    return { ...report, outcome: "db_failing", error: message(e), subrequests: budget.limit - budget.left };
  }

  // 10. the emails due, now that their alerts are committed
  const ids = returnedIds(results);
  const byKey = new Map<string, Finding>();
  for (const f of findings) if (!byKey.has(f.key)) byKey.set(f.key, f);
  const itemOf = (x: Due): AlertItem => {
    const h = byKey.get(x.key)?.hold;
    const active = h ? state.activeHolds.find((a) => a.id === h.id) : undefined;
    const raised = h ? ids.holds.get(h.id) : undefined;
    return {
      due: x,
      alertId: ids.alerts.get(x.key) ?? state.openAlerts.find((a) => a.alertKey === x.key)?.id,
      hold: active ? { publicId: active.publicId, summary: active.summary } : raised && h ? { publicId: raised, summary: h.summary } : null,
    };
  };
  const criticals = r.due.filter((x) => x.tier === "critical");
  const warnings = r.due.filter((x) => x.tier === "warning");
  const outgoing: Outgoing[] = criticals.map((x, i) => ({ id: i, ...(x.reason === "resolved" ? renderResolved(x) : renderCritical(itemOf(x))) }));
  if (warnings.length) outgoing.push({ id: criticals.length, ...renderWarnings(warnings.map(itemOf)) });
  const sent = outgoing.length ? await sendAll(deps.env, cfg, outgoing) : { sent: [], failed: [] };
  const sentDues = [...criticals.filter((_, i) => sent.sent.includes(i)), ...(sent.sent.includes(criticals.length) ? warnings : [])];

  // 11. commit 2: the emails marked sent, the lease released
  const after: D1PreparedStatement[] = [...markSent(db, sentDues, nowS), releaseLease(db, holder), ...countStatements(db, date, { emails_sent: sent.sent.length })];
  if (sent.failed.length) {
    if (!num(state.meta.email_failing_since)) after.push(setMeta(db, "email_failing_since", String(nowS)));
    after.push(setMeta(db, "email_failing_error", sent.failed.map((f) => f.code).join(", ").slice(0, 200)));
  } else if (sent.sent.length && num(state.meta.email_failing_since)) {
    after.push(setMeta(db, "email_failing_since", ""));
  }
  try {
    await db.batch(after);
  } catch (e) {
    // the emails may go out once more next tick; the lease runs out by itself
    console.error(`tick: commit 2 failed: ${message(e)}`);
  }
  return { ...report, sent: sent.sent.length, failedEmails: sent.failed.length, subrequests: budget.limit - budget.left };
}

/** The check rows the rules look at: those the prefetch loaded (every row of the candidates' batch ids and
 * payout keys, decided ones too) and the open ones, each once. */
function mergeChecks(preBatches: readonly BatchCheckRow[], openBatches: readonly BatchCheckRow[], preChunks: readonly ChunkCheckRow[], openChunks: readonly ChunkCheckRow[]): RuleCtx["checks"] {
  const batches = new Map<string, BatchCheckRow>();
  for (const r of [...openBatches, ...preBatches]) batches.set(`${r.batchId}:${r.deliveredKey}`, r);
  const chunks = new Map<Hex, ChunkCheckRow>();
  for (const r of [...preChunks, ...openChunks]) chunks.set(r.landedUid, { ...chunks.get(r.landedUid), ...r });
  return { batches: [...batches.values()], chunks: [...chunks.values()] };
}

// re-exported for the jobs
export { dayOf };
