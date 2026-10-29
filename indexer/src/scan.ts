import { type Hex, hexToBigInt, hexToNumber } from "viem";
import type { ChainName, RoleOf } from "./config.ts";
import { decode, identityOf, type RawLog, type StoredLog, type StoredRef, sortByPosition, storedIdentity, uidFor } from "./logs.ts";
import { type Budget, BudgetExhausted, type Rpc } from "./rpc.ts";

// The keeper's scan numbers (ops/src/keeper/state.ts; a test compares them), so the indexer and the
// keeper never disagree about what "settled" means.

/** eth_getLogs block ranges the public RPCs accept. Base's can be changed (BASE_LOG_WINDOW). */
export const WINDOW: Record<ChainName, bigint> = { base: 100n, bittensor: 1_000n };
/** Each tick reads this many blocks again before where it last stopped: a log a lagging node or a
 * reorg hid is found then, and one that vanished is noticed. */
export const REREAD: Record<ChainName, bigint> = { base: 70n, bittensor: 400n };
/** Logs this close to the head are returned but not stored, until they are this deep. */
export const SETTLE: Record<ChainName, bigint> = { base: 30n, bittensor: 10n };

export type ScanStop = "budget" | "decode" | "wall" | "lagging" | "error";

export interface ScanResult {
  /** settled logs to store: new ones, and stored ones found at another block (re-mined) */
  upserts: StoredLog[];
  /** logs within SETTLE of the head: for this tick only, not stored */
  fresh: StoredLog[];
  /** stored logs missing from a re-read of their (settled) block */
  removed: Hex[];
  cursor: { scannedTo: bigint | null; settledTo: bigint };
  /** the highest head a node reported this tick */
  head?: bigint;
  /** the head block's time, from this tick's first request */
  headTime?: number;
  stopped?: ScanStop;
  error?: string;
}

/** The blocks a tick reads again, whose stored uids it loads once (store.storedUids): from REREAD
 * blocks before the last head read up to it. Null before the first window. */
export function rereadRange(chain: ChainName, cursor: { scannedTo: bigint | null }, startBlock: bigint): { from: bigint; to: bigint } | null {
  if (cursor.scannedTo === null) return null;
  const back = cursor.scannedTo + 1n - REREAD[chain];
  return { from: back > startBlock ? back : startBlock, to: cursor.scannedTo };
}

/** A chain's head time for this tick (written every tick, so lag = head_time − settled_time grows when
 * the logs can't be read): the scan head's block time, else the reading's block time, else the Worker's
 * clock; never earlier than before. */
export function headTimeOf(o: { scanHeadTime?: number; readingTime?: number; nowS: number; previous: number | null | undefined }): number {
  const t = o.scanHeadTime ?? o.readingTime ?? o.nowS;
  return o.previous !== null && o.previous !== undefined && o.previous > t ? o.previous : t;
}

const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One chain's incremental scan for one tick (spec section 3.2).
 *
 * It starts at the start block before the first window, else REREAD blocks before the last head read.
 * It never asks for a window past a head some node has reported: a tick's first request re-reads up to
 * the last head read (or, on a first scan, asks only for the head), and each answer's head lets the next
 * window reach further. A window is accepted only from a node whose head, asked in the same request,
 * has reached the window's end; a node behind it is asked once more, then the chain stops for this tick.
 * It also stops, keeping every whole window read, when the subrequest budget (or its reserve) runs out, a
 * request fails, or the wall time is up (no window starts after `deadlineMs`). The decode budget bounds
 * the tick's CPU: each log hashed and decoded costs one unit (one already stored at the same place costs
 * nothing), and once it is spent the scan stops before the next block that needs work, keeping every
 * block taken whole, so a window busier than one tick can afford is read over several. Logs are
 * settled up to min(last block read,
 * head − SETTLE): those are returned to store; nearer ones are returned fresh. A stored log in the
 * settled part of a re-read that the read no longer has is returned as removed. */
export async function scanChain(o: {
  rpc: Rpc;
  chain: ChainName;
  roleOf: RoleOf;
  addresses: Hex[];
  startBlock: bigint;
  cursor: { scannedTo: bigint | null; settledTo: bigint };
  /** the stored logs in this chain's re-read range (store.storedUids) */
  stored: Map<Hex, StoredRef>;
  decodeBudget: Budget;
  deadlineMs: number;
  now: () => number;
  /** the window (Base's from BASE_LOG_WINDOW); the chain's default otherwise */
  window?: bigint;
  /** stop before a window once the subrequest budget is down to `keep`, so later work still runs */
  reserve?: { budget: Budget; keep: number };
}): Promise<ScanResult> {
  const { rpc, chain } = o;
  const window = o.window ?? WINDOW[chain];
  const start = o.cursor.scannedTo === null ? o.startBlock : max(o.startBlock, o.cursor.scannedTo + 1n - REREAD[chain]);
  const read: { log: StoredLog | undefined; uid: Hex; block: bigint }[] = [];
  const result: ScanResult = { upserts: [], fresh: [], removed: [], cursor: { ...o.cursor } };
  /** the highest block a node has said it has */
  let known = o.cursor.scannedTo ?? o.startBlock - 1n;
  let head: bigint | undefined;
  let firstRequest = true;
  let scannedTo: bigint | null = null;

  const stop = (why: ScanStop, e?: unknown) => {
    result.stopped = why;
    if (e !== undefined) result.error = message(e);
  };

  /** The stored logs by place, with the identity of their content: a re-read log found at the same
   * transaction, index and block with the same content is the stored one, recognised without a hash. */
  const byPlace = new Map<string, { uid: Hex; what: string }>();
  for (const [uid, s] of o.stored) {
    const what = storedIdentity(s);
    if (what !== undefined) byPlace.set(`${s.txHash}:${s.logIndex}:${s.block}`, { uid, what });
  }

  /** Takes a window's logs block by block (a block is never split: its logs number identical copies
   * together). A log recognised by place costs nothing; any other is hashed and, unless stored at that
   * block already, decoded, costing one unit of the decode budget, the tick's CPU. Before a block that
   * needs any such work once the budget is spent, it stops and returns the last block taken whole. */
  function take(logs: readonly RawLog[], a: bigint, b: bigint): bigint | undefined {
    const counts = new Map<string, number>();
    const blocks = new Map<bigint, RawLog[]>();
    for (const raw of sortByPosition(logs)) {
      const block = hexToBigInt(raw.blockNumber);
      if (block < a || block > b) continue;
      if (!blocks.has(block)) blocks.set(block, []);
      blocks.get(block)!.push(raw);
    }
    for (const [block, raws] of blocks) {
      const items = raws.map((raw) => {
        const what = identityOf(raw);
        const n = counts.get(what) ?? 0;
        counts.set(what, n + 1);
        const place = byPlace.get(`${raw.transactionHash.toLowerCase()}:${hexToNumber(raw.logIndex)}:${block}`);
        return { raw, what, n, uid: place?.what === what ? place.uid : undefined };
      });
      if (o.decodeBudget.left === 0 && items.some((i) => i.uid === undefined)) return block - 1n;
      for (const i of items) {
        if (i.uid !== undefined) {
          read.push({ log: undefined, uid: i.uid, block });
          continue;
        }
        if (o.decodeBudget.left > 0) o.decodeBudget.spend();
        const uid = uidFor(chain, i.what, i.n);
        // the same log at another index of the same block: nothing to write
        const log = o.stored.get(uid)?.block === block ? undefined : decode(chain, { uid, raw: i.raw }, o.roleOf);
        read.push({ log, uid, block });
      }
    }
    return undefined;
  }
  const failed = (e: unknown) => stop(e instanceof BudgetExhausted ? "budget" : "error", e instanceof BudgetExhausted ? undefined : e);

  scan: {
    if (start > known) {
      // nothing read before: learn the head (and its time) before asking for any window
      if (o.reserve && o.reserve.budget.left <= o.reserve.keep) {
        stop("budget");
        break scan;
      }
      try {
        const [h, block] = await rpc.batch(chain, [
          { method: "eth_blockNumber", params: [] },
          { method: "eth_getBlockByNumber", params: ["latest", false] },
        ]);
        head = hexToBigInt(h as Hex);
        known = max(known, head);
        const t = (block as { timestamp?: Hex } | null)?.timestamp;
        if (t) result.headTime = hexToNumber(t);
        firstRequest = false;
      } catch (e) {
        failed(e);
        break scan;
      }
    }

    for (let a = start; a <= known; ) {
      if (o.now() >= o.deadlineMs) {
        stop("wall");
        break;
      }
      if (o.reserve && o.reserve.budget.left <= o.reserve.keep) {
        stop("budget");
        break;
      }
      const b = min(a + window - 1n, known);
      let answer: Awaited<ReturnType<Rpc["logsWithHead"]>> | undefined;
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const r = await rpc.logsWithHead(chain, { address: o.addresses, fromBlock: a, toBlock: b }, { headTime: firstRequest });
          if (firstRequest && r.headTime !== undefined) result.headTime = r.headTime;
          firstRequest = false;
          if (r.head >= b) {
            answer = r;
            break;
          }
        }
      } catch (e) {
        failed(e);
        break;
      }
      if (!answer) {
        // a node behind the window's end answers "no logs" for blocks it hasn't seen: never count that as none
        stop("lagging");
        break;
      }
      head = head === undefined ? answer.head : max(head, answer.head);
      known = max(known, answer.head);
      const cut = take(answer.logs, a, b);
      if (cut !== undefined) {
        // the decode budget is spent: keep every block taken whole, and stop before the first one not
        if (cut >= a) scannedTo = cut;
        stop("decode");
        break;
      }
      scannedTo = b;
      a = b + 1n;
    }
  }

  result.head = head;
  if (scannedTo !== null && head !== undefined) {
    // everything read this tick runs contiguously from `start`, which is at or before the old settled
    // point (REREAD > SETTLE), so all of it up to here is stored by this tick's commit
    const settled = min(scannedTo, head - SETTLE[chain]);
    result.cursor = {
      scannedTo: o.cursor.scannedTo === null ? scannedTo : max(o.cursor.scannedTo, scannedTo),
      settledTo: max(o.cursor.settledTo, settled),
    };
    const seen = new Set(read.map((r) => r.uid));
    for (const r of read) {
      if (!r.log) continue;
      if (r.block <= result.cursor.settledTo) result.upserts.push(r.log);
      else result.fresh.push(r.log);
    }
    const checkedTo = min(scannedTo, settled);
    for (const [uid, s] of o.stored) {
      if (s.block >= start && s.block <= checkedTo && !seen.has(uid)) result.removed.push(uid);
    }
  }
  return result;
}
