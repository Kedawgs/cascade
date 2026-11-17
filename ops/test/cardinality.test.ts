import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData, type Hex, numberToHex, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import {
  cardinalityChecks,
  cardinalityFinding,
  cardinalityNeeded,
  cardinalityReport,
  cardinalitySteps,
  cardinalityTarget,
  cardinalityTxs,
  GAS_PER_SLOT,
  gasLimitFor,
  MAX_NEW_SLOTS_PER_TX,
  maxSlotsPerTx,
  ORACLE_POOLS,
  ORACLE_TWAP_WINDOW_S,
  oracleMinCardinality,
  POOL_ABI,
  poolProblems,
  TX_GAS_CAP,
} from "../src/cardinality.ts";
import { BASE_V3, paths } from "../src/config.ts";
import { buildPlanV3 } from "../src/plan.ts";
import { COLDKEY, fakeChain } from "./fake-keeper.ts";
import { ROLES } from "./launch-roles.ts";

/** v3-launch's oracle source, frozen in ops/builds/preaudit (contracts/ now holds v3.2). */
const oracleSource = readFileSync(new URL("../builds/preaudit/src/CascadeTwapOracle.sol", import.meta.url), "utf8");
/** v3.2's oracle: its source and its build (contracts/out). */
const CONTRACTS = paths({}).contractsDir;
const v32Source = readFileSync(join(CONTRACTS, "src", "CascadeTwapOracle.sol"), "utf8");
const INCREASE = parseAbi(["function increaseObservationCardinalityNext(uint16 observationCardinalityNext)"]);

/** Base's headers as they are since block 53,556,128: five blocks a second sharing whole-second timestamps (read
 * 2026-11-13), block HEAD at T, each block holding `gasLimit` gas; its gas price `gasPrice` wei. */
const HEAD = 57_134_080;
const T = 1_794_617_191;
const baseNow = (o: { blockS?: number; gasLimit?: number; gasPrice?: bigint } = {}) => ({
  eth_getBlockByNumber: (_c: unknown, params: unknown[]) => {
    const n = params[0] === "latest" ? HEAD : Number(BigInt(params[0] as Hex));
    return { number: numberToHex(n), timestamp: numberToHex(T - Math.floor((HEAD - n) * (o.blockS ?? 0.2))), gasLimit: numberToHex(o.gasLimit ?? 40_000_000) };
  },
  eth_gasPrice: () => numberToHex(o.gasPrice ?? 6_000_000n),
});

/** Base with the TAO/WETH pool at `taoWeth` slots (and cardinalityNext), WETH/USDC at `wethUsdc` (5,000). */
const pools = (taoWeth: { cardinality: number; next: number }, o: Parameters<typeof baseNow>[0] & { wethUsdc?: number } = {}) =>
  fakeChain(
    [POOL_ABI],
    {
      slot0: (_a, c) => {
        const s = c.to.toLowerCase() === BASE_V3.TAO_WETH_POOL.toLowerCase() ? taoWeth : { cardinality: o.wethUsdc ?? 5_000, next: o.wethUsdc ?? 5_000 };
        return [2n ** 96n, 0, 0, s.cardinality, s.next, 0, true];
      },
    },
    baseNow(o),
  );

/** A contracts folder whose built oracle declares MIN_CARDINALITY = `min` (contracts/out's artifact, that one declaration's
 * value a plain literal). */
function builtWith(min: number, subdenomination?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cardinality-"));
  mkdirSync(join(dir, "out", "CascadeTwapOracle.sol"), { recursive: true });
  const art = JSON.parse(readFileSync(join(CONTRACTS, "out", "CascadeTwapOracle.sol", "CascadeTwapOracle.json"), "utf8"));
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === "object") {
      const o = n as Record<string, unknown>;
      if (o.nodeType === "VariableDeclaration" && o.name === "MIN_CARDINALITY") o.value = { nodeType: "Literal", kind: "number", value: String(min), subdenomination: subdenomination ?? null };
      else Object.values(o).forEach(walk);
    }
  };
  walk(art.ast);
  writeFileSync(join(dir, "out", "CascadeTwapOracle.sol", "CascadeTwapOracle.json"), JSON.stringify(art));
  return dir;
}

describe("the oracle's pools need 30 minutes of observations at Base's block time, measured", () => {
  it("reads the window from the oracle's source; a pool writes at most one observation a second, so 1,801 slots on Base's 200 ms blocks", () => {
    expect(oracleSource).toMatch(new RegExp(`TWAP_WINDOW = ${ORACLE_TWAP_WINDOW_S};`));
    expect(v32Source).toMatch(new RegExp(`TWAP_WINDOW = ${ORACLE_TWAP_WINDOW_S};`));
    // 2-second blocks: 900 observations and the newest; at a second a block or less, one a second
    expect(cardinalityNeeded(2)).toBe(901);
    expect(cardinalityNeeded(12)).toBe(151);
    expect(cardinalityNeeded(1)).toBe(1_801);
    expect(cardinalityNeeded(0.2)).toBe(1_801);
    expect(cardinalityNeeded(0.05)).toBe(1_801);
    expect(ORACLE_POOLS.map((p) => p.address)).toEqual([BASE_V3.TAO_WETH_POOL, BASE_V3.WETH_USDC_POOL]);
  });

  it("the target is the built oracle's MIN_CARDINALITY, TWAP_WINDOW + 1 = 1,801 (Revision 28), worked out from its AST in contracts/out", () => {
    // the source says it as an expression of the window, which the AST holds unevaluated
    expect(v32Source).toMatch(/uint16 public constant MIN_CARDINALITY = uint16\(TWAP_WINDOW \+ 1\);/);
    expect(oracleMinCardinality(CONTRACTS)).toBe(ORACLE_TWAP_WINDOW_S + 1);
    expect(oracleMinCardinality(CONTRACTS)).toBe(1_801);
    // nothing above it: the target is the oracle's own minimum, or what the window needs now if that is more
    expect(cardinalityTarget(CONTRACTS, 1_801)).toBe(1_801);
    expect(cardinalityTarget(CONTRACTS, 901)).toBe(1_801);
    expect(cardinalityTarget(CONTRACTS, 3_601)).toBe(3_601);
    // a build that changes it is followed; what the window needs is never undercut
    expect(oracleMinCardinality(builtWith(20_001))).toBe(20_001);
    expect(cardinalityTarget(builtWith(20_001), 1_801)).toBe(20_001);
    expect(cardinalityTarget(builtWith(901), 1_801)).toBe(1_801);
    expect(() => oracleMinCardinality(mkdtempSync(join(tmpdir(), "no-build-")))).toThrow();
    // a literal with a unit (30 minutes) is not its digits: refused, never read as 30 (review M-2)
    expect(() => oracleMinCardinality(builtWith(30, "minutes"))).toThrow(/the literal 30 minutes/);
  });

  it("passes slots in use or reserved (cardinalityNext) of at least that, noting a ring still growing", () => {
    expect(cardinalityFinding("P", { cardinality: 600, next: 600 }, 1_801)).toEqual({
      problem: "P has 600 observation slots (cardinalityNext 600): the oracle's 30-minute window needs 1801, or a delivery can revert; grow it with the transactions from pnpm ops cardinality",
    });
    expect(cardinalityFinding("P", { cardinality: 600, next: 1_801 }, 1_801)).toEqual({
      note: "P is growing to 1801 observation slots (600 in use): its history reaches the oracle's 30 minutes once it has grown and traded through them",
    });
    expect(cardinalityFinding("P", { cardinality: 1_801, next: 1_801 }, 1_801)).toEqual({});
    expect(cardinalityFinding("P", { cardinality: 1_800, next: 1_800 }, 1_801).problem).toBeDefined();
  });

  it("reads Base's block time from two headers, then both pools' slot0, and names a short one", async () => {
    expect(await poolProblems(pools({ cardinality: 1_800, next: 1_800 }).ctx)).toEqual([
      ["the TAO/WETH 0.3% pool (0x82dD34C6631C286cDD1dB16f2c232f60E402Dd5A) holds 30 minutes of history", expect.stringMatching(/has 1800 observation slots .* needs 1801,/)],
      ["the WETH/USDC 0.05% pool (0xd0b53D9277642d899DF5C87A3966A349A798F224) holds 30 minutes of history", null],
    ]);
    // on 2-second blocks the same pool holds enough
    expect((await poolProblems(pools({ cardinality: 1_800, next: 1_800 }, { blockS: 2 }).ctx))[0][1]).toBeNull();
  });

  it("verify: a short pool fails a launch and warns a test deployment; a growing one warns either", async () => {
    const launch = buildPlanV3(4, 9, COLDKEY, "launch", ROLES);
    const test = buildPlanV3(4, 9, COLDKEY);
    const short = pools({ cardinality: 600, next: 600 }).ctx;
    const l = await cardinalityChecks(short, launch);
    expect(l.failures).toEqual([expect.stringMatching(/^Base TAO\/WETH 0\.3% pool .* has 600 observation slots .* needs 1801,/)]);
    expect(l.warnings).toEqual([]);
    const t = await cardinalityChecks(short, test);
    expect(t).toEqual({ failures: [], warnings: l.failures });
    const growing = await cardinalityChecks(pools({ cardinality: 600, next: 2_000 }).ctx, launch);
    expect(growing).toEqual({ failures: [], warnings: [expect.stringMatching(/is growing to 2000/)] });
    // the live TAO/WETH pool's 2,000 slots cover the window on 200 ms blocks
    expect(await cardinalityChecks(pools({ cardinality: 2_000, next: 2_000 }).ctx, launch)).toEqual({ failures: [], warnings: [] });
  });
});

describe("growing the pools to the target", () => {
  it("takes at most 600 new slots a transaction (Base caps a transaction at 16,777,216 gas), fewer when a block holds less", () => {
    expect(MAX_NEW_SLOTS_PER_TX).toBe(600);
    expect(TX_GAS_CAP).toBe(16_777_216);
    expect(MAX_NEW_SLOTS_PER_TX * GAS_PER_SLOT).toBeLessThan(TX_GAS_CAP);
    // the gas limit printed for a full step is under the cap too, with room over the measured cost
    expect(gasLimitFor(MAX_NEW_SLOTS_PER_TX)).toBeLessThan(TX_GAS_CAP);
    expect(gasLimitFor(MAX_NEW_SLOTS_PER_TX)).toBeGreaterThan(13_479_008);
    // Base's 40M blocks (2026-11-13) take a full step; a block of 10M takes 396 slots, its gas limit inside the block
    expect(maxSlotsPerTx(40_000_000)).toBe(600);
    expect(maxSlotsPerTx(TX_GAS_CAP)).toBe(600);
    expect(maxSlotsPerTx(10_000_000)).toBe(396);
    expect(gasLimitFor(maxSlotsPerTx(10_000_000))).toBeLessThanOrEqual(10_000_000);
    expect(gasLimitFor(maxSlotsPerTx(10_000_000) + 1)).toBeGreaterThan(10_000_000);
    // from 600 to 2,000: three steps, the last a short one
    expect(cardinalitySteps(600, 2_000)).toEqual([1_200, 1_800, 2_000]);
    expect(cardinalitySteps(1_300, 2_000)).toEqual([1_900, 2_000]);
    expect(cardinalitySteps(2_000, 2_000)).toEqual([]);
    expect(cardinalitySteps(2_100, 2_000)).toEqual([]);
    // the live TAO/WETH pool (2,000) to a much larger target, 18,001 (30 minutes of 100 ms blocks, first proposed before
    // Revision 28 settled on 1,801): 27 steps, the last 401 slots
    const live = cardinalitySteps(2_000, 18_001);
    expect(live).toHaveLength(27);
    expect(live.slice(0, 2)).toEqual([2_600, 3_200]);
    expect(live.at(-1)! - live.at(-2)!).toBe(401);
    expect(cardinalitySteps(2_000, 18_001, 396)).toHaveLength(41);
  });

  it("encodes each step as increaseObservationCardinalityNext on the pool", () => {
    const txs = cardinalityTxs(BASE_V3.TAO_WETH_POOL, [1_200, 1_800]);
    expect(txs.map((t) => t.to)).toEqual([BASE_V3.TAO_WETH_POOL, BASE_V3.TAO_WETH_POOL]);
    expect(txs.map((t) => decodeFunctionData({ abi: INCREASE, data: t.data }))).toEqual([
      { functionName: "increaseObservationCardinalityNext", args: [1_200] },
      { functionName: "increaseObservationCardinalityNext", args: [1_800] },
    ]);
  });

  it("prints the exact transactions for both pools to the target, each under the block's gas limit, and their cost in all; sends nothing (an oracle built with a minimum of 18,001)", async () => {
    // the pools as read on 2026-11-13: TAO/WETH 2,000 slots, WETH/USDC 6,700; Base's gas price 0.006 gwei
    const chain = pools({ cardinality: 2_000, next: 2_000 }, { wethUsdc: 6_700 });
    const lines = await cardinalityReport(chain.ctx, builtWith(18_001));
    const text = lines.join("\n");
    expect(lines[0]).toBe("Base makes a block every 0.20 s (measured) and a pool keeps at most one observation a second, so the oracle's 30-minute window needs 1801 slots; the target is 18001, the v3.2 oracle's minimum.");
    const [first] = cardinalityTxs(BASE_V3.TAO_WETH_POOL, [2_600]);
    expect(lines).toContain(`  1. to ${first.to} data ${first.data}  (increaseObservationCardinalityNext(2600), about 13.5M gas; gas limit 15,100,000)`);
    expect(lines).toContain(`  27. to ${BASE_V3.TAO_WETH_POOL} data ${cardinalityTxs(BASE_V3.TAO_WETH_POOL, [18_001])[0].data}  (increaseObservationCardinalityNext(18001), about 9.0M gas; gas limit 10,125,000)`);
    expect(lines).toContain(`  19. to ${BASE_V3.WETH_USDC_POOL} data ${cardinalityTxs(BASE_V3.WETH_USDC_POOL, [18_001])[0].data}  (increaseObservationCardinalityNext(18001), about 11.3M gas; gas limit 12,625,000)`);
    expect(text).toMatch(/16,777,216 gas, a block holds 40,000,000/);
    // 16,001 + 11,301 new slots: 27,302 × 22,500 gas; at 0.006 gwei, 0.003685 ETH (0.004122 at the gas limits)
    expect(lines).toContain("In all: 46 transactions, about 614.3M gas. At Base's gas price now (0.006 gwei) that is about 0.003685 ETH, and at most 0.004122 ETH at the gas limits, plus Base's small L1 data fee on each.");
    // a wallet that pads its own gas limit could push a step over the cap: the cast line sets it
    expect(text).toMatch(/cast send 0x82dD34C6631C286cDD1dB16f2c232f60E402Dd5A "increaseObservationCardinalityNext\(uint16\)" 2600 --gas-limit 15100000/);
    expect(chain.calls.every((c) => (c.method === "eth_call" && c.fn === "slot0") || c.method === "eth_getBlockByNumber" || c.method === "eth_gasPrice")).toBe(true);
    // a block of 10M gas: steps of 396
    const small = await cardinalityReport(pools({ cardinality: 2_000, next: 2_000 }, { wethUsdc: 6_700, gasLimit: 10_000_000 }).ctx, builtWith(18_001));
    expect(small).toContain(`  1. to ${first.to} data ${cardinalityTxs(BASE_V3.TAO_WETH_POOL, [2_396])[0].data}  (increaseObservationCardinalityNext(2396), about 8.9M gas; gas limit 10,000,000)`);
  });

  it("the live pools (TAO/WETH 2,000 slots, WETH/USDC 6,700, read 2026-11-13) already hold the built oracle's 1,801: nothing to send", async () => {
    const lines = await cardinalityReport(pools({ cardinality: 2_000, next: 2_000 }, { wethUsdc: 6_700 }).ctx, CONTRACTS);
    expect(lines[0]).toBe("Base makes a block every 0.20 s (measured) and a pool keeps at most one observation a second, so the oracle's 30-minute window needs 1801 slots; the target is 1801, the v3.2 oracle's minimum.");
    expect(lines.join("\n")).toMatch(/TAO\/WETH 0\.3% pool .*2000 observation slots .*: enough \(the target is 1801\)/);
    expect(lines.join("\n")).toMatch(/WETH\/USDC 0\.05% pool .*6700 observation slots .*: enough \(the target is 1801\)/);
    expect(lines.join("\n")).not.toMatch(/In all/);
  });

  it("says when there is nothing to send", async () => {
    const lines = await cardinalityReport(pools({ cardinality: 18_001, next: 18_001 }, { wethUsdc: 18_001 }).ctx, builtWith(18_001));
    expect(lines.join("\n")).toMatch(/TAO\/WETH 0\.3% pool .*18001 observation slots .*: enough/);
    expect(lines.join("\n")).not.toMatch(/ to 0x/);
    expect(lines.join("\n")).not.toMatch(/In all/);
  });
});
