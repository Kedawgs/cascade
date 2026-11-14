import { readFileSync } from "node:fs";
import { decodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import {
  CARDINALITY_TARGET,
  cardinalityChecks,
  cardinalityFinding,
  cardinalityNeeded,
  cardinalityNeededNow,
  cardinalityReport,
  cardinalitySteps,
  cardinalityTxs,
  gasLimitFor,
  MAX_NEW_SLOTS_PER_TX,
  MIN_OBSERVATION_GAP_S,
  ORACLE_POOLS,
  ORACLE_TWAP_WINDOW_S,
  POOL_ABI,
  poolProblems,
} from "../src/cardinality.ts";
import { BASE_V3 } from "../src/config.ts";
import { buildPlanV3 } from "../src/plan.ts";
import { COLDKEY, fakeChain, headers } from "./fake-keeper.ts";
import { ROLES } from "./launch-roles.ts";

const oracleSource = readFileSync(new URL("../../contracts/src/CascadeTwapOracle.sol", import.meta.url), "utf8");
const INCREASE = parseAbi(["function increaseObservationCardinalityNext(uint16 observationCardinalityNext)"]);

/** Base with the TAO/WETH pool at `taoWeth` slots (and cardinalityNext), WETH/USDC at 5,000; its blocks `blockS` seconds
 * apart (whole-second timestamps, as headers give them): 0.2, Base's since block 53,556,128, unless said. */
const pools = (taoWeth: { cardinality: number; next: number }, blockS = 0.2) =>
  fakeChain(
    [POOL_ABI],
    {
      slot0: (_a, c) => {
        const s = c.to.toLowerCase() === BASE_V3.TAO_WETH_POOL.toLowerCase() ? taoWeth : { cardinality: 5_000, next: 5_000 };
        return [2n ** 96n, 0, 0, s.cardinality, s.next, 0, true];
      },
    },
    { eth_getBlockByNumber: headers(blockS) },
  );

describe("the oracle's pools need 30 minutes of observations at Base's block time, measured", () => {
  it("reads the window from the oracle's source: 1,800 s; a pool keeps at most one observation a second, so 1,801 slots on Base's 200 ms blocks, 901 on its old 2-second ones", () => {
    expect(oracleSource).toMatch(new RegExp(`TWAP_WINDOW = ${ORACLE_TWAP_WINDOW_S};`));
    expect(MIN_OBSERVATION_GAP_S).toBe(1);
    expect(cardinalityNeeded(2)).toBe(901);
    expect(cardinalityNeeded(1)).toBe(1_801);
    expect(cardinalityNeeded(0.2)).toBe(1_801);
    expect(cardinalityNeeded(0.1)).toBe(1_801);
    expect(cardinalityNeeded(12)).toBe(151);
    expect(CARDINALITY_TARGET).toBe(2_000);
    expect(ORACLE_POOLS.map((p) => p.address)).toEqual([BASE_V3.TAO_WETH_POOL, BASE_V3.WETH_USDC_POOL]);
  });

  it("measures Base's block time from its headers: 1,801 today, 901 on 2-second blocks", async () => {
    expect(await cardinalityNeededNow(pools({ cardinality: 0, next: 0 }).ctx)).toBe(1_801);
    expect(await cardinalityNeededNow(pools({ cardinality: 0, next: 0 }, 2).ctx)).toBe(901);
  });

  it("passes slots in use or reserved (cardinalityNext) of at least that, noting a ring still growing", () => {
    expect(cardinalityFinding("P", { cardinality: 600, next: 600 }, 1_801)).toEqual({
      problem: "P has 600 observation slots (cardinalityNext 600): the oracle's 30-minute window needs 1801 at Base's block time, or a delivery can revert; grow it with the transactions from pnpm ops cardinality",
    });
    expect(cardinalityFinding("P", { cardinality: 600, next: 2_000 }, 1_801)).toEqual({
      note: "P is growing to 2000 observation slots (600 in use): its history reaches the oracle's 30 minutes once it has grown and traded through them",
    });
    expect(cardinalityFinding("P", { cardinality: 1_801, next: 1_801 }, 1_801)).toEqual({});
    expect(cardinalityFinding("P", { cardinality: 1_800, next: 1_800 }, 1_801).problem).toBeDefined();
    expect(cardinalityFinding("P", { cardinality: 901, next: 901 }, 901)).toEqual({});
  });

  it("preflight: a pool of 1,500 slots, enough on 2-second blocks, is short on Base's 200 ms blocks", async () => {
    const pool = { cardinality: 1_500, next: 1_500 };
    expect((await poolProblems(pools(pool).ctx))[0][1]).toMatch(/has 1500 observation slots .*needs 1801/);
    expect((await poolProblems(pools(pool, 2).ctx))[0][1]).toBeNull();
  });

  it("reads both pools' slot0 and names a short one", async () => {
    expect(await poolProblems(pools({ cardinality: 600, next: 600 }).ctx)).toEqual([
      ["the TAO/WETH 0.3% pool (0x82dD34C6631C286cDD1dB16f2c232f60E402Dd5A) holds 30 minutes of history", expect.stringMatching(/has 600 observation slots/)],
      ["the WETH/USDC 0.05% pool (0xd0b53D9277642d899DF5C87A3966A349A798F224) holds 30 minutes of history", null],
    ]);
  });

  it("verify: a short pool fails a launch and warns a test deployment; a growing one warns either", async () => {
    const launch = buildPlanV3(4, 9, COLDKEY, "launch", ROLES);
    const test = buildPlanV3(4, 9, COLDKEY);
    const short = pools({ cardinality: 600, next: 600 }).ctx;
    const l = await cardinalityChecks(short, launch);
    expect(l.failures).toEqual([expect.stringMatching(/^Base TAO\/WETH 0\.3% pool .* has 600 observation slots/)]);
    expect(l.warnings).toEqual([]);
    const t = await cardinalityChecks(short, test);
    expect(t).toEqual({ failures: [], warnings: l.failures });
    const growing = await cardinalityChecks(pools({ cardinality: 600, next: 2_000 }).ctx, launch);
    expect(growing).toEqual({ failures: [], warnings: [expect.stringMatching(/is growing to 2000/)] });
    expect(await cardinalityChecks(pools({ cardinality: 2_000, next: 2_000 }).ctx, launch)).toEqual({ failures: [], warnings: [] });
    // 1,800 slots: enough on 2-second blocks, short of 1,801 on Base's 200 ms ones
    expect(await cardinalityChecks(pools({ cardinality: 1_800, next: 1_800 }, 2).ctx, launch)).toEqual({ failures: [], warnings: [] });
    expect((await cardinalityChecks(pools({ cardinality: 1_800, next: 1_800 }).ctx, launch)).failures).toEqual([expect.stringMatching(/has 1800 observation slots .*needs 1801/)]);
  });
});

describe("growing the TAO/WETH pool", () => {
  it("takes at most 600 new slots a transaction: Base caps a transaction at 16,777,216 gas and a slot costs about 22,500", () => {
    expect(MAX_NEW_SLOTS_PER_TX).toBe(600);
    expect(MAX_NEW_SLOTS_PER_TX * 22_500).toBeLessThan(16_777_216);
    // the gas limit printed for a full step is under the cap too, with room over the measured cost
    expect(gasLimitFor(MAX_NEW_SLOTS_PER_TX)).toBeLessThan(16_777_216);
    expect(gasLimitFor(MAX_NEW_SLOTS_PER_TX)).toBeGreaterThan(13_479_008);
    // to 2,000 from today's 600: three steps, the last a short one
    expect(cardinalitySteps(600)).toEqual([1_200, 1_800, 2_000]);
    expect(cardinalitySteps(1_200)).toEqual([1_800, 2_000]);
    expect(cardinalitySteps(1_300)).toEqual([1_900, 2_000]);
    expect(cardinalitySteps(100)).toEqual([700, 1_300, 1_900, 2_000]);
    expect(cardinalitySteps(1_800)).toEqual([2_000]);
    expect(cardinalitySteps(2_000)).toEqual([]);
    expect(cardinalitySteps(2_100)).toEqual([]);
  });

  it("encodes each step as increaseObservationCardinalityNext on the pool", () => {
    const txs = cardinalityTxs(BASE_V3.TAO_WETH_POOL, [1_200, 1_800]);
    expect(txs.map((t) => t.to)).toEqual([BASE_V3.TAO_WETH_POOL, BASE_V3.TAO_WETH_POOL]);
    expect(txs.map((t) => decodeFunctionData({ abi: INCREASE, data: t.data }))).toEqual([
      { functionName: "increaseObservationCardinalityNext", args: [1_200] },
      { functionName: "increaseObservationCardinalityNext", args: [1_800] },
    ]);
  });

  it("prints the exact transactions to send from any wallet, and sends nothing", async () => {
    const chain = pools({ cardinality: 600, next: 600 });
    const lines = await cardinalityReport(chain.ctx);
    const [first, second, third] = cardinalityTxs(BASE_V3.TAO_WETH_POOL, [1_200, 1_800, 2_000]);
    expect(lines).toContain(`  1. to ${first.to} data ${first.data}  (increaseObservationCardinalityNext(1200), about 13.5M gas; gas limit 15,100,000)`);
    expect(lines).toContain(`  2. to ${second.to} data ${second.data}  (increaseObservationCardinalityNext(1800), about 13.5M gas; gas limit 15,100,000)`);
    expect(lines).toContain(`  3. to ${third.to} data ${third.data}  (increaseObservationCardinalityNext(2000), about 4.5M gas; gas limit 5,100,000)`);
    expect(lines.join("\n")).toMatch(/16,777,216 gas/);
    // a wallet that pads its own gas limit could push a step over the cap: the cast line sets it
    expect(lines.join("\n")).toMatch(/cast send 0x82dD34C6631C286cDD1dB16f2c232f60E402Dd5A "increaseObservationCardinalityNext\(uint16\)" 1200 --gas-limit 15100000/);
    expect(lines.join("\n")).toMatch(/WETH\/USDC 0\.05% pool .*5000 observation slots .*: enough/);
    // the need at Base's block time, measured from its headers
    expect(lines[0]).toBe("Base makes a block every 0.20 s (measured) and a pool keeps at most one observation a second, so the oracle's 30-minute window needs 1801 slots; the target is 2000.");
    expect(chain.calls.every((c) => (c.method === "eth_call" && c.fn === "slot0") || c.method === "eth_getBlockByNumber")).toBe(true);
  });

  it("says when there is nothing to send", async () => {
    const lines = await cardinalityReport(pools({ cardinality: 2_000, next: 2_000 }).ctx);
    expect(lines.join("\n")).toMatch(/TAO\/WETH 0\.3% pool .*2000 observation slots .*: enough/);
    expect(lines.join("\n")).not.toMatch(/ to 0x/);
  });
});
