import { type Hex, hexToNumber, numberToHex } from "viem";
import type { ChainName } from "../config.ts";
import type { Rpc } from "../rpc.ts";

// A chain's block time, measured from its block headers, never assumed: Base went from 2-second blocks to 200 ms ones at
// block 53,556,128 (2026-11-05 18:00 UTC), so a count of blocks that meant half an hour before means three minutes
// after. Every figure that turns a time into blocks (a look-back, a block at a time, the oracle pools' history) reads it
// here, so a later change of either chain's block time needs no change of code.

/** How far apart the headers are, in blocks: about 200 s of Base's and an hour of Bittensor's today, so whole-second
 * timestamps give the block time to within one percent. */
export const BLOCK_TIME_SPAN: Record<ChainName, bigint> = { base: 1_000n, bittensor: 300n };

/** A block and its timestamp (unix seconds). */
export interface BlockAt {
  block: bigint;
  time: number;
}

const measured = new WeakMap<Rpc, Map<ChainName, Promise<number>>>();

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
 * `rpc` (a run's, or a command's). The faster, because a halt or a sequencer outage in one span makes it read slow, and a
 * time counted back in blocks at a slow reading lands after the block it wants. Throws, keeping nothing, when a header
 * can't be read or neither span is apart in time. */
export function blockTimeOf(rpc: Rpc, chain: ChainName, head?: BlockAt): Promise<number> {
  let byChain = measured.get(rpc);
  if (!byChain) measured.set(rpc, (byChain = new Map()));
  const known = byChain.get(chain);
  if (known) return known;
  const reading = (async () => {
    const span = BLOCK_TIME_SPAN[chain];
    const newer = head ?? (await timeOf(rpc, chain, "latest"));
    const mid = await timeOf(rpc, chain, newer.block > span ? newer.block - span : 0n);
    const recent = secondsPerBlock(mid, newer);
    const before = mid.block > 0n ? secondsPerBlock(await timeOf(rpc, chain, mid.block > span ? mid.block - span : 0n), mid) : undefined;
    const s = recent === undefined ? before : before === undefined ? recent : Math.min(recent, before);
    if (s === undefined) throw new Error(`${chain === "base" ? "Base" : "Bittensor"}'s block time can't be read: its blocks up to ${newer.block} are not apart in time`);
    return s;
  })();
  const cache = byChain;
  cache.set(chain, reading);
  reading.catch(() => cache.delete(chain));
  return reading;
}

/** The blocks `chain` makes in `seconds` at `blockS` seconds a block, rounded up. */
export const blocksIn = (seconds: number, blockS: number): bigint => BigInt(Math.ceil(seconds / blockS));

/** The block time a margin (keeper/state.ts REREAD_S and SETTLE_S, registry.ts's; the indexer's the same) is counted at
 * while a chain's own can't be read: the block times the margins were set at, Base's 2 s (until block 53,556,128) and
 * Bittensor's 12 s, so they count the blocks they always did then; the next read that measures it re-reads the full
 * depth. */
export const MARGIN_FALLBACK_S: Record<ChainName, number> = { base: 2, bittensor: 12 };

/** `seconds` of `chain`'s blocks at its block time measured from `rpc`'s headers (blockTimeOf), or at MARGIN_FALLBACK_S
 * while that can't be read. Never throws. */
export async function marginBlocks(rpc: Rpc, chain: ChainName, seconds: number): Promise<bigint> {
  return blocksIn(seconds, await blockTimeOf(rpc, chain).catch(() => MARGIN_FALLBACK_S[chain]));
}
