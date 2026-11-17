import { type AbiEvent, type Address, decodeEventLog, encodeEventTopics, type Hex, hexToBigInt, hexToNumber, numberToHex } from "viem";
import { blocksIn, blockTimeOf, MARGIN_FALLBACK_S } from "./blocktime.ts";
import type { Rpc } from "./rpc.ts";
import type { ChainName } from "./types.ts";

// Log scans over the fetch-based Rpc (moved whole from keeper/state.ts, which re-exports them).

/** What a log scan reads with: the RPC, the server log scans go to (absent: `rpc`), and each chain's eth_getLogs
 * block range (absent: WINDOW). send.ts's Ctx is one. */
export interface LogsCtx {
  rpc: Rpc;
  /** Where log scans go (rpc.ts logsRpc): the live tools' own Base logs server. Absent = `rpc`. */
  logs?: Rpc;
  /** The block range one eth_getLogs asks `logs` for, per chain. Absent = WINDOW. */
  logsWindow?: Partial<Record<ChainName, bigint>>;
}

/** The RPC for log scans and their heads: the context's logs server, else its main RPC. */
export const logsOf = (ctx: Pick<LogsCtx, "rpc" | "logs">): Rpc => ctx.logs ?? ctx.rpc;

/** eth_getLogs block ranges the public RPCs accept. Base's go to OPS_BASE_LOGS_RPC (mainnet.base.org
 * refuses eth_getLogs altogether); some public Base endpoints refuse more than 200 blocks. */
export const WINDOW: Record<ChainName, bigint> = { base: 100n, bittensor: 1_000n };
/** One eth_getLogs's block range on `chain`: the logs server's own (live Base: OPS_BASE_LOGS_WINDOW), else WINDOW. */
export const windowOf = (ctx: Pick<LogsCtx, "logsWindow">, chain: ChainName): bigint => ctx.logsWindow?.[chain] ?? WINDOW[chain];

/** The first step of blockAtOrAfter's bracket around its guess: a minute of the chain's blocks. */
const BLOCK_SEARCH_STEP_S = 60;

/** The first block of `chain` at or after `time` (a Unix second), by its timestamps: a guess from the head's time at
 * the chain's block time, measured from two of its headers (blocktime.ts, once for each `rpc`), a bracket around it
 * (each side stepped away from a minute of blocks, doubling, until it is on its side of `time`), then bisected. About
 * two reads when the guess is right (and one more to measure), a handful more when blocks ran late; when the block time
 * can't be read, a bracket up from block 0 (correct, in more reads). `head + 1` when no block is at `time` yet. */
export async function blockAtOrAfter(rpc: Rpc, chain: ChainName, time: number, head: bigint, headTime: number): Promise<bigint> {
  const timeOf = async (n: bigint) => hexToNumber(((await rpc.request(chain, "eth_getBlockByNumber", [numberToHex(n), false])) as { timestamp: Hex }).timestamp);
  if (headTime < time) return head + 1n;
  const blockS = await blockTimeOf(rpc, chain, { block: head, time: headTime }).catch(() => undefined);
  const back = blockS === undefined ? head : BigInt(Math.floor((headTime - time) / blockS));
  const guess = back < head ? head - back : 0n;
  const first = blockS === undefined ? 1n : blocksIn(BLOCK_SEARCH_STEP_S, blockS);
  // lo is before `time` (or -1, before the chain); hi is at or after it
  let lo = guess - 1n;
  let hi = guess;
  for (let step = first; hi < head && (await timeOf(hi)) < time; step *= 2n) {
    lo = hi;
    hi = hi + step < head ? hi + step : head;
  }
  for (let step = first; lo >= 0n && (await timeOf(lo)) >= time; step *= 2n) {
    hi = lo;
    lo -= step;
  }
  if (lo < 0n) lo = -1n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await timeOf(mid)) >= time) hi = mid;
    else lo = mid;
  }
  return hi;
}
/** The re-read and settle depths in blocks the keeper used before its margins were time: v3-launch's keeper
 * (keeper/state.ts) still scans with them (main's live v3-launch keeper counts them in time since its own Base block-time
 * fix), and v3.2's reads seed a cursor saved by that code from them (its seenFrom and settledTo: where it let ids go and
 * where it kept logs; review M-1, Minor 2). v3.2's core scans with REREAD_S and SETTLE_S at each chain's measured block
 * time (marginsOf). */
export const REREAD: Record<ChainName, bigint> = { base: 70n, bittensor: 400n };
/** REREAD's note: the old settle depth in blocks. */
export const SETTLE: Record<ChainName, bigint> = { base: 30n, bittensor: 10n };

/** Each later scan of an event starts this long of the chain's blocks before the last head it reached, so a log a
 * lagging (load-balanced) node or a reorg hid is found on a later round: 140 s of Base's blocks (700 of its 200 ms ones
 * since block 53,556,128) and 4,800 s of Bittensor's (400 of its 12 s), what 70 and 400 blocks meant on Base's 2-second
 * blocks. In blocks at each chain's block time, measured (marginsOf). The indexer's are the same (a test holds them equal). */
export const REREAD_S: Record<ChainName, number> = { base: 140, bittensor: 4_800 };
/** Logs this close to the head, in time, are returned but not kept: they are read again next round, so one from a block
 * that is then dropped (a reorg) never sticks: 60 s of Base's blocks (300 of its 200 ms ones), 120 s of Bittensor's (10). */
export const SETTLE_S: Record<ChainName, number> = { base: 60, bittensor: 120 };

/** A chain's re-read and settle margins in blocks. */
export interface Margins {
  reread: bigint;
  settle: bigint;
}

/** REREAD_S and SETTLE_S in `chain`'s blocks at `blockS` seconds a block, or at the chains' block times today
 * (MARGIN_FALLBACK_S) while that is unknown. */
export function marginsAt(chain: ChainName, blockS: number | undefined): Margins {
  const s = blockS ?? MARGIN_FALLBACK_S[chain];
  return { reread: blocksIn(REREAD_S[chain], s), settle: blocksIn(SETTLE_S[chain], s) };
}

/** REREAD_S and SETTLE_S in `chain`'s blocks now: at its block time measured from `rpc`'s headers (blocktime.ts, read again
 * hourly). `last` keeps the last block time measured, across runs (the keeper's memory: the Worker makes a new RPC each run,
 * so a read that fails there has nothing else to fall back on): a measurement is written into it, and a read that fails
 * counts the margins at it; at MARGIN_FALLBACK_S only while none was ever measured. A fallback narrower
 * than the measured margins would let a run raise its scans' seenFrom past blocks the next run's full re-read should
 * reach (review I-1). Never throws. */
export async function marginsOf(rpc: Rpc, chain: ChainName, last?: Partial<Record<ChainName, number>>): Promise<Margins> {
  const measured = await blockTimeOf(rpc, chain).catch(() => undefined);
  if (measured !== undefined && last) last[chain] = measured;
  return marginsAt(chain, measured ?? last?.[chain]);
}

/** Each log with an id from its transaction and content, numbered when one transaction logs the same
 * thing twice: the same in every read of its block, and the same when a reorg mines the transaction
 * again in another block or at another index, so that copy is not taken for a second log. */
export function identified(logs: readonly ScannedLog[]): [string, ScannedLog][] {
  const count = new Map<string, number>();
  return logs.map((l) => {
    const what = `${l.transactionHash}:${l.raw.topics.join(",")}:${l.raw.data}`;
    const n = count.get(what) ?? 0;
    count.set(what, n + 1);
    return [`${what}#${n}`, l];
  });
}

/** The event `name` of `abi`. */
export const event = (abi: readonly unknown[], name: string) =>
  (abi as AbiEvent[]).find((i) => i.type === "event" && i.name === name) as AbiEvent;

export interface ScannedLog {
  raw: { address: Address; topics: Hex[]; data: Hex };
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

/** What a scan in windows got: the logs of every window it read in full, in order, and the last block of the last one
 * (`from - 1` when it read none); `stopped`, when it ended before `to`, with what stopped the next window (the Worker's
 * read deadline, a budget, a node's error, an answer that doesn't decode), whose logs are not taken. */
export interface ScanPart {
  logs: ScannedLog[];
  scannedTo: bigint;
  stopped?: { error: unknown };
}

/** One event from one contract, from `from` to `to` (default: the latest block), in windows the public RPCs accept,
 * window by window: a window's logs are taken only once the whole window is read and decoded, and `scannedTo` moves to
 * its last block then. A failure ends the scan at that window and comes back with what it had (`stopped`), never
 * thrown, so a caller keeps the progress of a scan cut off part way (design-keeper-worker.md §5: "a long log scan resumes
 * across runs from its cursor"). Only reading the head (`to` absent) can throw: then nothing was scanned. */
export async function scanLogsInParts(
  ctx: LogsCtx,
  chain: ChainName,
  address: Address,
  ev: AbiEvent,
  from: bigint,
  topics: (Hex | null)[] = [],
  to?: bigint,
): Promise<ScanPart> {
  const rpc = logsOf(ctx);
  const step = windowOf(ctx, chain);
  const latest = to ?? hexToBigInt((await rpc.request(chain, "eth_blockNumber", [])) as Hex);
  const topic0 = encodeEventTopics({ abi: [ev], eventName: ev.name } as never)[0];
  const out: ScannedLog[] = [];
  let scannedTo = from - 1n;
  for (let start = from; start <= latest; start += step) {
    const end = start + step - 1n < latest ? start + step - 1n : latest;
    const window: ScannedLog[] = [];
    try {
      const logs = (await rpc.request(chain, "eth_getLogs", [
        { address, fromBlock: numberToHex(start), toBlock: numberToHex(end), topics: [topic0, ...topics] },
      ])) as { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; logIndex: Hex; transactionHash: Hex }[];
      for (const l of logs) {
        const d = decodeEventLog({ abi: [ev], topics: l.topics as [Hex, ...Hex[]], data: l.data });
        window.push({
          raw: { address: l.address, topics: l.topics, data: l.data },
          args: d.args as Record<string, unknown>,
          blockNumber: hexToBigInt(l.blockNumber),
          logIndex: hexToNumber(l.logIndex),
          transactionHash: l.transactionHash,
        });
      }
    } catch (error) {
      return { logs: out, scannedTo, stopped: { error } };
    }
    out.push(...window);
    scannedTo = end;
  }
  return { logs: out, scannedTo };
}

/** One event from one contract, from `from` to `to` (default: the latest block), in windows the public
 * RPCs accept: every log, or the failure that stopped it thrown (scanLogsInParts, all or nothing; v3-launch's reads and
 * verify use it as they always have). */
export async function scanLogs(
  ctx: LogsCtx,
  chain: ChainName,
  address: Address,
  ev: AbiEvent,
  from: bigint,
  topics: (Hex | null)[] = [],
  to?: bigint,
) {
  const part = await scanLogsInParts(ctx, chain, address, ev, from, topics, to);
  if (part.stopped) throw part.stopped.error;
  return part.logs;
}
