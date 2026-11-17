import { type Address, type Hex, hexToNumber, parseAbi } from "viem";
import { ORACLE_POOLS, ORACLE_TWAP_WINDOW_S } from "../cardinality.ts";
import { read, type Rpc } from "../rpc.ts";

// The front door's pool floors (spec Appendix B; plan Task 61 step 4): each of the oracle's pools' 30-minute
// harmonic-mean in-range liquidity, as CascadeTwapOracle.meanLiquidity() computes it, read from an archive RPC at one
// block a day over the last 30 days; each floor by the founder's rule (2026-11-13, FLOOR_RULES): TAO/WETH a quarter of
// the median, WETH/USDC half the lowest reading. A day is found by time, never by a count of blocks:
// Base moved from 2-second blocks to 200 ms ones at block 53,556,128 (2026-11-05 18:00 UTC), so a day is 43,200 blocks
// before it and 432,000 after. `pnpm ops pool-floors` prints the readings and the
// two floors for ops/src/v32/settings.ts MEASURED_V32.poolFloors (TAO/WETH, then WETH/USDC, as the front door's
// minPoolLiquidity takes them). Reads only.

/** Base's public RPC, which answers eth_call at blocks 30 days back (checked 2026-11-13) and carries no key. */
export const PUBLIC_BASE_ARCHIVE = "https://mainnet.base.org";
/** A day, in seconds: the readings are a day apart by the blocks' timestamps. */
export const DAY_S = 86_400;
/** The readings: one a day, the head's and 29 more back. */
export const FLOOR_DAYS = 30;

const OBSERVE = parseAbi(["function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)"]);
const U160 = (1n << 160n) - 1n;
const U128 = (1n << 128n) - 1n;

/** The harmonic-mean in-range liquidity over the window from a pool's seconds-per-liquidity cumulatives at its start
 * (`before`) and end (`after`): CascadeTwapOracle._meanLiquidity's `window * (2^160 - 1) / (growth << 32)`, each step
 * as the contract does it. Refused, as the contract reverts, for no growth and for a mean above 2^128 - 1. */
export function harmonicMeanLiquidity(before: bigint, after: bigint, windowS: number = ORACLE_TWAP_WINDOW_S): bigint {
  if (after < before) throw new Error("the cumulative went down over the window");
  const growth = after - before;
  if (growth === 0n) throw new Error("no growth over the window (the contract divides by zero)");
  const mean = (BigInt(windowS) * U160) / (growth << 32n);
  if (mean > U128) throw new Error("the mean is above 2^128 - 1 (the contract's SafeCast reverts)");
  return mean;
}

/** The median: the middle reading, or the mean of the middle two for an even count, rounded down. */
export function medianOf(xs: readonly bigint[]): bigint {
  if (!xs.length) throw new Error("no readings");
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2n;
}

/** Each pool's floor, by the founder's ruling of 2026-11-13 (owner-adjustable later: setMinPoolLiquidity, a raise at once,
 * a cut a 48-hour item), in the front door's order: TAO/WETH a quarter of the 30-day median, so it refuses only the
 * thinnest days (half the median refused 2 days in 30); WETH/USDC half the 30-day lowest, as it was falling over the
 * month (half the median sat 1.4% under that day's reading). */
export const FLOOR_RULES: readonly { rule: string; floor: (r: { median: bigint; lowest: bigint }) => bigint }[] = [
  { rule: "a quarter of the median", floor: ({ median }) => median / 4n },
  { rule: "half the lowest reading", floor: ({ lowest }) => lowest / 2n },
];

export interface PoolFloor {
  name: string;
  address: Address;
  readings: { block: number; time: number; liquidity: bigint }[];
  median: bigint;
  /** The lowest reading. */
  lowest: bigint;
  /** By its rule (FLOOR_RULES). */
  rule: string;
  floor: bigint;
  /** How many of the readings are below the floor: on those days a delivery would have waited (ThinPool). */
  below: number;
}

export interface PoolFloors {
  head: number;
  pools: PoolFloor[];
  /** [TAO/WETH, WETH/USDC], the front door's minPoolLiquidity order. */
  floors: [bigint, bigint];
}

const blockTime = async (rpc: Rpc, block: number): Promise<number> => {
  const b = (await rpc.request("base", "eth_getBlockByNumber", [`0x${block.toString(16)}`, false])) as { timestamp: Hex } | null;
  if (!b) throw new Error(`Base has no block ${block}`);
  return hexToNumber(b.timestamp);
};

/** The last block at or before `time` (by its timestamp; several 200 ms blocks share a second), searched between block 0
 * and `head`: steps that guess from the timestamps (exact where the block time is steady) alternate with halvings, so a
 * change of block time inside the range still ends in about log2 of it. */
export async function blockAtOrBefore(rpc: Rpc, time: number, head: number): Promise<number> {
  const at = new Map<number, number>();
  const t = async (n: number) => {
    let v = at.get(n);
    if (v === undefined) {
      v = await blockTime(rpc, n);
      at.set(n, v);
    }
    return v;
  };
  if ((await t(head)) <= time) return head;
  if ((await t(0)) > time) throw new Error(`no Base block is at or before ${time}: it is before block 0`);
  // time(lo) <= time < time(hi)
  let lo = 0;
  let hi = head;
  for (let step = 0; hi - lo > 1; step++) {
    let mid: number;
    if (step % 2 === 0) {
      const [tl, th] = [await t(lo), await t(hi)];
      mid = lo + Math.floor(((time - tl) * (hi - lo)) / Math.max(1, th - tl));
      mid = Math.min(hi - 1, Math.max(lo + 1, mid));
    } else mid = lo + Math.floor((hi - lo) / 2);
    if ((await t(mid)) <= time) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Each oracle pool's mean liquidity at the head (Base's latest block, or `head`) and at the last block at or before
 * each whole day back by time, FLOOR_DAYS readings in all, and the floors from them. A reading that fails (a revert such
 * as "OLD", or a node that keeps no state that far back) stops it, naming the pool and the block: no floor is set from
 * fewer days. */
export async function readPoolFloors(rpc: Rpc, o: { head?: number; days?: number } = {}): Promise<PoolFloors> {
  const head = o.head ?? hexToNumber((await rpc.request("base", "eth_blockNumber", [])) as Hex);
  const days = o.days ?? FLOOR_DAYS;
  const headTime = await blockTime(rpc, head);
  const blocks: number[] = [];
  const times = new Map<number, number>();
  for (let k = 0; k < days; k++) {
    const b = await blockAtOrBefore(rpc, headTime - k * DAY_S, blocks.at(-1) ?? head);
    blocks.push(b);
    times.set(b, await blockTime(rpc, b));
  }
  const pools: PoolFloor[] = [];
  for (const [i, p] of ORACLE_POOLS.entries()) {
    const readings: PoolFloor["readings"] = [];
    for (const block of blocks) {
      let liquidity: bigint;
      try {
        const [, cum] = (await read(rpc, "base", { address: p.address, abi: OBSERVE, functionName: "observe", args: [[ORACLE_TWAP_WINDOW_S, 0]] }, BigInt(block))) as readonly [unknown, readonly bigint[]];
        liquidity = harmonicMeanLiquidity(cum[0], cum[1]);
      } catch (e) {
        throw new Error(`the ${p.name} (${p.address}) at block ${block}: ${(e as Error).message.split("\n")[0]}; no floor set from fewer than ${days} days`);
      }
      readings.push({ block, time: times.get(block) ?? 0, liquidity });
    }
    const median = medianOf(readings.map((r) => r.liquidity));
    const lowest = readings.reduce((m, x) => (x.liquidity < m ? x.liquidity : m), readings[0].liquidity);
    const { rule, floor: floorOf } = FLOOR_RULES[i];
    const floor = floorOf({ median, lowest });
    pools.push({ name: p.name, address: p.address, readings, median, lowest, rule, floor, below: readings.filter((r) => r.liquidity < floor).length });
  }
  return { head, pools, floors: [pools[0].floor, pools[1].floor] };
}

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");

/** What `pnpm ops pool-floors` prints: each pool's readings, its median and floor, how many days read below it, and the
 * line for settings.ts. */
export function floorLines(r: PoolFloors): string[] {
  const out: string[] = [`The oracle's pools' 30-minute harmonic-mean liquidity on Base, one block a day for ${r.pools[0]?.readings.length ?? 0} days back from block ${r.head}:`];
  for (const p of r.pools) {
    out.push(`  the ${p.name} (${p.address}):`);
    for (const x of p.readings) out.push(`    block ${x.block} (${day(x.time)} UTC): ${x.liquidity}`);
    const max = p.readings.reduce((m, x) => (x.liquidity > m ? x.liquidity : m), p.readings[0].liquidity);
    out.push(`    median ${p.median}; floor (${p.rule}) ${p.floor}; lowest ${p.lowest}, highest ${max}`);
    out.push(`    ${p.below} of the ${p.readings.length} daily readings are below it: on such a day a USDC delivery waits (ThinPool) until the pool deepens`);
  }
  out.push(`For ops/src/v32/settings.ts MEASURED_V32: poolFloors: [${r.floors[0]}n, ${r.floors[1]}n]`);
  return out;
}
