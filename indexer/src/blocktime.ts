import type { ChainName } from "./config.ts";

// Each chain's block time as the readings measure it, never a constant: Base went from 2-second blocks to 200 ms ones at
// block 53,556,128 (2026-11-05 18:00 UTC), so a count of blocks that meant a day before means 2.4 hours after. Every
// figure that turns a time into blocks (a look-back, a park's age told by its block, the oracle pools' history) reads it
// here, so a later change of either chain's block time needs no change of code.

/** The meta key a chain's measured seconds a block is kept under (a decimal), for the jobs that read no readings (the
 * hourly cross-check, the daily digest and APY) and for the next tick's scan. */
export const blockSKey = (chain: ChainName) => `block_s:${chain}`;

/** Readings must span this long to measure: whole-second timestamps then give the block time to within one percent. */
export const MIN_SPAN_S = 100;

/** A stored block time is written again only when the measured one moves this far from it (5%: Bittensor's blocks
 * wander by a second either side of 12), so the tick writes it rarely. */
export const REWRITE_SHARE = 0.05;

/** The seconds a block between two readings, when they are at least MIN_SPAN_S and a block apart. */
const spanS = (older: { block: bigint; time: number }, newer: { block: bigint; time: number }): number | undefined => {
  const blocks = Number(newer.block - older.block);
  const seconds = newer.time - older.time;
  return blocks > 0 && seconds >= MIN_SPAN_S ? seconds / blocks : undefined;
};

/** The seconds a block over `readings` (each a block and its time, as a reading's own getBlockNumber and
 * getCurrentBlockTimestamp give them): the faster of their two halves (the oldest to the middle one, the middle one to the
 * newest), as ops and the site read two spans of headers, so a halt or a sequencer outage in one never reads it slow;
 * while neither half spans MIN_SPAN_S, the newest to the oldest; undefined when even they span less, or no blocks. */
export function measureBlockS(readings: readonly { block: bigint; time: number }[]): number | undefined {
  if (readings.length < 2) return undefined;
  const r = [...readings].sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : a.time - b.time));
  const mid = r[Math.floor((r.length - 1) / 2)];
  const halves = [spanS(r[0], mid), spanS(mid, r[r.length - 1])].filter((s): s is number => s !== undefined);
  return halves.length ? Math.min(...halves) : spanS(r[0], r[r.length - 1]);
}

/** The block time last stored for `chain`, when there is one. */
export function storedBlockS(meta: Readonly<Record<string, string>>, chain: ChainName): number | undefined {
  const raw = meta[blockSKey(chain)];
  const v = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/** The value to store for `chain` this tick, when the measured block time has moved past REWRITE_SHARE from the stored one
 * (or none is stored). */
export function blockSToStore(meta: Readonly<Record<string, string>>, chain: ChainName, measured: number | undefined): string | undefined {
  if (measured === undefined) return undefined;
  const stored = storedBlockS(meta, chain);
  return stored === undefined || Math.abs(measured - stored) > stored * REWRITE_SHARE ? String(measured) : undefined;
}

/** The blocks `seconds` take at `blockS` seconds a block, rounded up. */
export const blocksIn = (seconds: number, blockS: number): bigint => BigInt(Math.ceil(seconds / blockS));

/** The first block of a look-back of `seconds` from `block`: blocksIn at the chain's block time, never below 0; from
 * block 0 (everything, the rule's own time filter deciding) while the block time is unknown (a first tick). */
export function lookbackFrom(block: bigint, seconds: number, blockS: number | undefined): bigint {
  if (blockS === undefined) return 0n;
  const back = blocksIn(seconds, blockS);
  return block > back ? block - back : 0n;
}

/** A Uniswap v3 pool writes at most one observation a second (Oracle.write skips a block.timestamp it has written, and a
 * timestamp is whole seconds: Base's five blocks a second share one). */
export const MIN_OBSERVATION_GAP_S = 1;

/** The observations a pool must keep for the TWAP oracle's `windowS` when it trades in every block, at Base's `blockS`: one
 * an observation over the window, and the newest (observe reverts "OLD" short of it). 901 on 2-second blocks, 1,801 on 1
 * second or less (Base's 200 ms today). Undefined while the block time is unknown. */
export const windowObservations = (blockS: number | undefined, windowS = 1_800): number | undefined =>
  blockS === undefined ? undefined : Math.ceil(windowS / Math.max(blockS, MIN_OBSERVATION_GAP_S)) + 1;
