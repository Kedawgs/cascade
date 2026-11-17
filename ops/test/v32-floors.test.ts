import { readFileSync } from "node:fs";
import { decodeFunctionData, encodeFunctionResult, type Hex, hexToNumber, numberToHex, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { BASE_V3 } from "../src/config.ts";
import type { Rpc } from "../src/rpc.ts";
import { blockAtOrBefore, DAY_S, FLOOR_DAYS, FLOOR_RULES, floorLines, harmonicMeanLiquidity, medianOf, readPoolFloors } from "../src/v32/floors.ts";
import { MEASURED_V32 } from "../src/v32/settings.ts";

const oracleSource = readFileSync(new URL("../../contracts/src/CascadeTwapOracle.sol", import.meta.url), "utf8");
const OBSERVE = parseAbi(["function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)"]);
const U160 = (1n << 160n) - 1n;

/** The cumulative growth a pool of constant in-range liquidity `l` shows over the oracle's 1,800 seconds. */
const growthFor = (l: bigint) => (1800n << 128n) / l;

/** Base's real history: 2-second blocks until block 53,556,127 (2026-11-05 18:00:01 UTC), then five blocks a second, the
 * timestamp in whole seconds (block 53,556,128 at 18:00:01.2 reads 18:00:01). */
const SWITCH = 53_556_127;
const SWITCH_T = 1_793_901_601;
const timeOf = (n: number) => (n <= SWITCH ? SWITCH_T - 2 * (SWITCH - n) : SWITCH_T + Math.floor((n - SWITCH) / 5));

/** Base at `head`, each pool's 30-minute mean liquidity given by `liquidity(pool, block)` (null: the read reverts). */
function fakeBase(head: number, liquidity: (pool: string, block: number) => bigint | null, seen: { blocks: number[] } = { blocks: [] }): Rpc {
  return {
    async request(_chain, method, params) {
      if (method === "eth_blockNumber") return numberToHex(head);
      if (method === "eth_getBlockByNumber") {
        const n = params[0] === "latest" ? head : hexToNumber(params[0] as Hex);
        if (n > head) return null;
        return { number: numberToHex(n), timestamp: numberToHex(timeOf(n)) };
      }
      if (method === "eth_call") {
        const [call, tag] = params as [{ to: string; data: Hex }, Hex];
        const block = hexToNumber(tag);
        seen.blocks.push(block);
        const { args } = decodeFunctionData({ abi: OBSERVE, data: call.data });
        expect(args[0]).toEqual([1800, 0]);
        const l = liquidity(call.to.toLowerCase(), block);
        if (l === null) throw Object.assign(new Error("execution reverted: OLD"), { code: 3 });
        const start = 10n ** 30n;
        return encodeFunctionResult({ abi: OBSERVE, functionName: "observe", result: [[0n, 0n], [start, start + growthFor(l)]] });
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

describe("the pool floors (Task 61 step 4): each pool's 30-minute harmonic-mean liquidity, a block a day for 30 days", () => {
  it("computes the mean as the oracle does (OracleLibrary.consult's window over the growth, the product not a shift)", () => {
    expect(oracleSource).toMatch(/TWAP_WINDOW = 1800;/);
    expect(oracleSource).toMatch(/uint192 windowX160 = uint192\(TWAP_WINDOW\) \* type\(uint160\)\.max;/);
    expect(oracleSource).toMatch(/windowX160 \/ \(uint192\(growth\) << 32\)/);
    // the oracle's formula, by hand: (1800 * (2^160 - 1)) / (growth << 32)
    const growth = 123_456_789_012_345_678_901n;
    expect(harmonicMeanLiquidity(10n, 10n + growth)).toBe((1800n * U160) / (growth << 32n));
    // a constant liquidity reads back as itself, within the growth's rounding (l^2 / (1800 * 2^128), and a unit)
    for (const l of [10n ** 18n, 7n * 10n ** 21n, 3n * 10n ** 15n]) {
      const got = harmonicMeanLiquidity(0n, growthFor(l));
      const slack = (l * l) / (1800n << 128n) + 1n;
      expect(got >= l - slack && got <= l + slack).toBe(true);
    }
    expect(() => harmonicMeanLiquidity(5n, 5n)).toThrow(/no growth/);
    expect(() => harmonicMeanLiquidity(6n, 5n)).toThrow(/went down/);
  });

  it("takes the median of the readings (the mean of the middle two for an even count, rounded down)", () => {
    expect(medianOf([5n, 1n, 3n])).toBe(3n);
    expect(medianOf([4n, 1n, 3n, 10n])).toBe(3n);
    expect(medianOf([7n])).toBe(7n);
    expect(() => medianOf([])).toThrow(/no readings/);
  });

  it("finds the last block at or before a time by its timestamp, across Base's change from 2-second to 200 ms blocks", async () => {
    const head = 57_075_728;
    const rpc = fakeBase(head, () => 1n);
    for (const t of [timeOf(head), timeOf(head) - DAY_S, SWITCH_T, SWITCH_T + 1, SWITCH_T - 1, timeOf(SWITCH - 1_000_000) + 1]) {
      const b = await blockAtOrBefore(rpc, t, head);
      // the head is the last block there is: nothing after it to compare
      expect(timeOf(b) <= t && (b === head || timeOf(b + 1) > t)).toBe(true);
    }
    // the switch: 53,556,127 is the last block at 18:00:01 before the 200 ms blocks; four of those share its second
    expect(await blockAtOrBefore(rpc, SWITCH_T, head)).toBe(SWITCH + 4);
    await expect(blockAtOrBefore(rpc, timeOf(0) - 1, head)).rejects.toThrow(/before block 0/);
  });

  it("the founder's floors (2026-11-13): TAO/WETH a quarter of the 30-day median, WETH/USDC half the 30-day lowest, from that day's readings", () => {
    // the readings of 2026-11-13 (settings.ts MEASURED_V32's note): TAO/WETH's median, WETH/USDC's lowest
    expect(FLOOR_RULES.map((r) => r.rule)).toEqual(["a quarter of the median", "half the lowest reading"]);
    expect(FLOOR_RULES[0].floor({ median: 3_363_287_060_484_724_984_767n, lowest: 435_581_045_435_153_588_269n })).toBe(840_821_765_121_181_246_191n);
    expect(FLOOR_RULES[1].floor({ median: 890_124_659_366_939_137n, lowest: 451_512_037_179_130_368n })).toBe(225_756_018_589_565_184n);
    expect(MEASURED_V32.poolFloors).toEqual([840_821_765_121_181_246_191n, 225_756_018_589_565_184n]);
  });

  it("reads both oracle pools at the head and at the last block a day apart back for 30 days, and sets each floor by its rule", async () => {
    const head = 57_075_728;
    const seen = { blocks: [] as number[] };
    const dayOf = (block: number) => Math.round((timeOf(head) - timeOf(block)) / DAY_S);
    const tw = (block: number) => 10n ** 20n * BigInt(1 + (dayOf(block) % 5));
    const rpc = fakeBase(head, (pool, block) => (pool === BASE_V3.TAO_WETH_POOL.toLowerCase() ? tw(block) : 4n * 10n ** 18n), seen);
    const r = await readPoolFloors(rpc);
    expect(FLOOR_DAYS).toBe(30);
    expect(DAY_S).toBe(86_400);
    expect(r.head).toBe(head);
    // one block a day by time, not by a fixed count of blocks: each the last at or before head's time less k days
    const blocks = await Promise.all(Array.from({ length: 30 }, (_, k) => blockAtOrBefore(rpc, timeOf(head) - k * DAY_S, head)));
    expect([...new Set(seen.blocks)].sort((a, b) => b - a)).toEqual(blocks);
    blocks.forEach((b, k) => expect(timeOf(b)).toBe(timeOf(head) - k * DAY_S));
    // the readings reach back over the switch to 2-second blocks (2026-11-05): 30 days, not 3
    expect(blocks.at(-1)).toBeLessThan(SWITCH);
    expect(r.pools.map((p) => p.address)).toEqual([BASE_V3.TAO_WETH_POOL, BASE_V3.WETH_USDC_POOL]);
    const [taoWeth, wethUsdc] = r.pools;
    expect(taoWeth.readings.map((x) => x.block)).toEqual(blocks);
    // 1..5 x 1e20, six of each: the median is 3e20 (within the growth's rounding), the floor a quarter of it
    expect(taoWeth.median >= 3n * 10n ** 20n - 10n && taoWeth.median <= 3n * 10n ** 20n + 10n).toBe(true);
    expect(taoWeth.floor).toBe(taoWeth.median / 4n);
    expect(taoWeth.lowest >= 10n ** 20n - 10n && taoWeth.lowest <= 10n ** 20n + 10n).toBe(true);
    // no reading is below a quarter of the median here (the 1e20 days are a third of it)
    expect(taoWeth.below).toBe(0);
    // WETH/USDC: half its lowest reading
    expect(wethUsdc.floor).toBe(wethUsdc.lowest / 2n);
    expect(wethUsdc.below).toBe(0);
    expect(r.floors).toEqual([taoWeth.floor, wethUsdc.floor]);
    const lines = floorLines(r).join("\n");
    expect(lines).toMatch(/TAO\/WETH 0\.3% pool/);
    expect(lines).toMatch(/floor \(a quarter of the median\)/);
    expect(lines).toMatch(/floor \(half the lowest reading\)/);
    expect(lines).toMatch(/0 of the 30 daily readings are below it/);
    expect(lines).toMatch(/poolFloors: \[\d+n, \d+n\]/);
  });

  it("refuses to set a floor when a day's reading fails, naming the block", async () => {
    const head = 57_075_728;
    const bad = await blockAtOrBefore(fakeBase(head, () => 1n), timeOf(head) - 3 * DAY_S, head);
    const rpc = fakeBase(head, (pool, block) => (block === bad && pool === BASE_V3.WETH_USDC_POOL.toLowerCase() ? null : 10n ** 18n));
    await expect(readPoolFloors(rpc)).rejects.toThrow(new RegExp(`WETH/USDC 0\\.05% pool .*block ${bad}.*OLD.*no floor set`));
  });
});
