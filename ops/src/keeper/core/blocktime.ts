import { type Hex, hexToNumber, numberToHex } from "viem";
import type { Rpc } from "./rpc.ts";
import type { ChainName } from "./types.ts";

// A chain's block time, measured from two of its block headers, never assumed: Base went from 2-second blocks to 200 ms
// ones at block 53,556,128 (2026-11-05 18:00 UTC), so a count of blocks that meant an hour before means six minutes after.
// Every figure that turns a time into blocks (a look-back, a block near a time, how long blocks last) reads it here, so a
// later change of either chain's block time needs no change of code.

/** How far apart the two headers are, in blocks: about 200 s of Base's and an hour of Bittensor's today, so whole-second
 * timestamps give the block time to within one percent. */
export const BLOCK_TIME_SPAN: Record<ChainName, bigint> = { base: 1_000n, bittensor: 300n };

/** A block and its timestamp (unix seconds). */
export interface BlockAt {
  block: bigint;
  time: number;
}

/** A block time is read again after this long (an hour), so a keeper left running follows a change of either chain's. */
export const BLOCK_TIME_FRESH_MS = 3_600_000;

/** Each RPC's block times by chain: the reading, and when it was started (0: read again on the next call). */
const measured = new WeakMap<Rpc, Map<ChainName, { at: number; reading: Promise<number> }>>();

const timeOf = async (rpc: Rpc, chain: ChainName, block: bigint | "latest"): Promise<BlockAt> => {
  const b = (await rpc.request(chain, "eth_getBlockByNumber", [block === "latest" ? "latest" : numberToHex(block), false])) as { number?: Hex; timestamp: Hex } | null;
  if (!b) throw new Error(`${chain === "base" ? "Base" : "Bittensor"} has no block ${block}`);
  return { block: block === "latest" ? BigInt(b.number ?? "0x0") : block, time: hexToNumber(b.timestamp) };
};

/** The seconds a block between two headers, or undefined when they are not apart in both block and time (a chain younger
 * than one block, or a test's blocks all at one time). */
export function secondsPerBlock(older: BlockAt, newer: BlockAt): number | undefined {
  const blocks = Number(newer.block - older.block);
  const seconds = newer.time - older.time;
  return blocks > 0 && seconds > 0 ? seconds / blocks : undefined;
}

/** `chain`'s seconds a block now: the faster of two spans of BLOCK_TIME_SPAN blocks back from its head's header (`head`,
 * when the caller has read it), the newest and the one before it (from block 0 on a younger chain), read once for each
 * `rpc` (a run's, or a command's) and again after BLOCK_TIME_FRESH_MS. The faster, because a halt or a sequencer outage in
 * one span makes it read slow, and a time counted back in blocks at a slow reading lands after the block it wants. A first
 * read throws, keeping nothing, when a header can't be read or neither span is apart in time; a refresh that fails keeps
 * the last block time read, and the next call tries again. */
export function blockTimeOf(rpc: Rpc, chain: ChainName, head?: BlockAt): Promise<number> {
  let byChain = measured.get(rpc);
  if (!byChain) measured.set(rpc, (byChain = new Map()));
  const cache = byChain;
  const known = cache.get(chain);
  const now = Date.now();
  if (known && now - known.at < BLOCK_TIME_FRESH_MS) return known.reading;
  const fresh = (async () => {
    const span = BLOCK_TIME_SPAN[chain];
    const newer = head ?? (await timeOf(rpc, chain, "latest"));
    const mid = await timeOf(rpc, chain, newer.block > span ? newer.block - span : 0n);
    const recent = secondsPerBlock(mid, newer);
    const before = mid.block > 0n ? secondsPerBlock(await timeOf(rpc, chain, mid.block > span ? mid.block - span : 0n), mid) : undefined;
    const s = recent === undefined ? before : before === undefined ? recent : Math.min(recent, before);
    if (s === undefined) throw new Error(`${chain === "base" ? "Base" : "Bittensor"}'s block time can't be read: its blocks up to ${newer.block} are not apart in time`);
    return s;
  })();
  const entry = { at: now, reading: fresh };
  if (known) {
    // a refresh that fails: the last block time read, marked to be read again on the next call
    entry.reading = fresh.catch(() => {
      entry.at = 0;
      return known.reading;
    });
  } else {
    fresh.catch(() => {
      if (cache.get(chain) === entry) cache.delete(chain);
    });
  }
  cache.set(chain, entry);
  return entry.reading;
}

/** The blocks `chain` makes in `seconds` at `blockS` seconds a block, rounded up. */
export const blocksIn = (seconds: number, blockS: number): bigint => BigInt(Math.ceil(seconds / blockS));

/** The block time a margin (logs.ts REREAD_S and SETTLE_S; the indexer's the same) is counted at while a chain's own was
 * never measured (logs.ts marginsOf keeps the last one measured in the keeper's memory): Base's 0.2 s (since block
 * 53,556,128) and Bittensor's 12 s, the chains' block times today. Erring high on blocks, the safe side everywhere a margin
 * is used: a fallback of Base's old 2 s would re-read and settle a tenth of the time, and let a first run raise its scans'
 * seenFrom past blocks the next run should re-read (review Minor 1). */
export const MARGIN_FALLBACK_S: Record<ChainName, number> = { base: 0.2, bittensor: 12 };
