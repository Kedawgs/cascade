import { env } from "cloudflare:workers";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { reconcile } from "../../src/alerts.ts";
import { type Config, PATH_TAO_TO_USDC } from "../../src/config.ts";
import { poolPriceUsd, PRICE_URLS, referencePrice } from "../../src/prices.ts";
import { logQuery, type RuleCtx, utc } from "../../src/rules/context.ts";
import { fmtaoDepeg, fmtaoMintSurge, fmtaoUnbacked, MARKET_RULES, oracleThinPool, pathFees, poolLiquidity, referenceUnavailable, swapBelowOracle, twapDivergence } from "../../src/rules/market.ts";
import { RULES } from "../../src/rules/ids.ts";
import { RUNBOOK } from "../../src/runbook.ts";
import type { BaseState, BitState, ChainReading, HourAgg } from "../../src/snapshot.ts";
import { DEFAULTS } from "../../src/thresholds.ts";
import { D, h } from "./bridge-fixtures.ts";
import { testConfig, testConfigV32 } from "./fixtures.ts";
import { baseState, bitState, reading, ruleCtx, slog } from "./rule-ctx.ts";

const E18 = 10n ** 18n;
const NOW = 1_800_000_000;
const Q96 = 2 ** 96;
const cfg = testConfig();
const T = cfg.tokens.base;

/** A TAO/WETH and a WETH/USDC pool at these USD prices, with the tokens in their real order on Base. */
function pools(taoUsd: number, wethUsd = 3000): Pick<BaseState, "taoWethPool" | "wethUsdcPool"> {
  const taoFirst = T.fmTao.toLowerCase() < T.weth.toLowerCase();
  const taoInWeth = taoUsd / wethUsd;
  const p1 = taoFirst ? taoInWeth : 1 / taoInWeth;
  const wethFirst = T.weth.toLowerCase() < T.usdc.toLowerCase();
  const p2 = wethFirst ? wethUsd * 1e-12 : 1 / (wethUsd * 1e-12);
  const sqrt = (p: number) => BigInt(Math.round(Math.sqrt(p) * Q96));
  return {
    taoWethPool: { sqrtPriceX96: sqrt(p1), liquidity: 10n ** 20n, tao: 1000n * E18, token0: (taoFirst ? T.fmTao : T.weth) as Hex },
    wethUsdcPool: { sqrtPriceX96: sqrt(p2), liquidity: 10n ** 20n, token0: (wethFirst ? T.weth : T.usdc) as Hex },
  };
}
const base = (block: bigint, o: Partial<BaseState> = {}): ChainReading<BaseState> => reading(block, NOW, baseState({ ...pools(400), ...o }));
const bit = (block: bigint, o: Partial<BitState> = {}): ChainReading<BitState> => reading(block, NOW, bitState(o));

function ctx(o: {
  base?: ChainReading<BaseState>;
  bit?: ChainReading<BitState>;
  prev?: { base?: ChainReading<BaseState>; bit?: ChainReading<BitState> };
  reference?: RuleCtx["reference"];
  meta?: Record<string, string>;
  hours?: HourAgg[];
  cfg?: Config;
  nowS?: number;
  logs?: ReturnType<typeof slog>[];
}): RuleCtx {
  const c = ruleCtx();
  return ruleCtx({
    cfg: o.cfg ?? cfg,
    nowS: o.nowS ?? NOW,
    snap: { ...c.snap, at: o.nowS ?? NOW, base: o.base, bittensor: o.bit },
    previous: { base: o.prev?.base, bittensor: o.prev?.bit },
    history: { base: o.prev?.base ? [o.prev.base] : [], bittensor: o.prev?.bit ? [o.prev.bit] : [] },
    reference: o.reference,
    meta: o.meta ?? {},
    hours: o.hours ?? [],
    logs: logQuery(o.logs ?? []),
    blockTime: () => NOW - 600,
  });
}
const meta = (c: RuleCtx) => Object.fromEntries(c.writes.meta.map((w) => [w.k, w.v]));

describe("referencePrice and poolPriceUsd", () => {
  const answers = (cg: unknown, cb: unknown) => async (url: string) => {
    const a = url === PRICE_URLS.coingecko ? cg : cb;
    if (a instanceof Error) throw a;
    return a;
  };
  const cg = (usd: number) => ({ bittensor: { usd } });
  const cb = (usd: number) => ({ data: { amount: String(usd), base: "TAO", currency: "USD" } });

  it("takes the median of the sources that answer", async () => {
    expect(await referencePrice({ getJson: answers(cg(400), cb(404)), sources: ["coingecko", "coinbase"] })).toEqual({ usd: 402, sources: 2 });
    expect(await referencePrice({ getJson: answers(new Error("down"), cb(404)), sources: ["coingecko", "coinbase"] })).toEqual({ usd: 404, sources: 1 });
  });

  it("is unavailable when the sources disagree by more than 2%, none answers, or none is configured", async () => {
    // the reason carries no price (it is stored and served); the answers ride beside it for the tick's log
    expect(await referencePrice({ getJson: answers(cg(412), cb(400)), sources: ["coingecko", "coinbase"] })).toEqual({ unavailable: "the price sources disagree by more than 2%", answers: [400, 412] });
    expect(await referencePrice({ getJson: answers(new Error("x"), { nonsense: true }), sources: ["coingecko", "coinbase"] })).toEqual({ unavailable: expect.stringContaining("answered") });
    expect(await referencePrice({ getJson: answers(cg(400), cb(400)), sources: [] })).toEqual({ unavailable: expect.stringContaining("configured") });
  });

  it("prices TAO in USD from both pools within 0.01%", () => {
    const usd = poolPriceUsd(baseState(pools(412.37, 2875.5)), cfg.tokens);
    expect(Math.abs((usd as number) / 412.37 - 1)).toBeLessThan(1e-4);
    expect(poolPriceUsd(baseState({}), cfg.tokens)).toBeUndefined();
  });
});

describe("fmtao.unbacked", () => {
  it("is quiet at the lock exactly, and finds supply above the lock by more than 0.01 TAO on two readings", () => {
    const at = (b: bigint, supply: bigint, lock: bigint) => ({ base: base(b, { fmTaoSupply: supply }), bit: bit(b, { lockPoolFmTao: lock }) });
    const now = at(11n, 100n * E18, 100n * E18);
    expect(fmtaoUnbacked.run(ctx({ ...now, prev: at(10n, 100n * E18, 100n * E18) }))).toEqual([]);
    const over = 100n * E18 + 10n ** 16n + 1n;
    expect(fmtaoUnbacked.run(ctx({ ...at(11n, over, 100n * E18), prev: at(10n, 100n * E18, 100n * E18) }))).toEqual([]);
    const [f] = fmtaoUnbacked.run(ctx({ ...at(12n, over, 100n * E18), prev: at(11n, over, 100n * E18) }));
    expect(f).toMatchObject({ rule: "fmtao.unbacked", key: "fmtao.unbacked", facts: { excess: "10000000000000001" } });
  });

  it("on v3.2 its runbook says a front-door pause never stops a close (I-20), and names the guardian's and the owner's real options", () => {
    const at = (b: bigint, supply: bigint) => ({ base: base(b, { fmTaoSupply: supply }), bit: bit(b, { lockPoolFmTao: 100n * E18 }) });
    const over = 100n * E18 + 10n ** 16n + 1n;
    const [f] = fmtaoUnbacked.run(ctx({ cfg: testConfigV32(), ...at(12n, over), prev: at(11n, over) }));
    expect(f.facts.contracts).toBe("v3.2");
    const says = RUNBOOK["fmtao.unbacked"](f.facts);
    expect(says).not.toMatch(/stops new batches|new batches stop|no new batch crosses/);
    expect(says).toContain("never stops a close");
    expect(says).toContain("deposit, depositFor and deliver");
    expect(says).toContain("pause() the vault");
    expect(says).toContain("disableBridge(<the primary bridge>) on the front door");
    expect(says).toContain("cancelPayoutBatch(key, payouts)");
    // its blind spot stays named
    expect(says).toContain("Robinhood");
    // v3-launch's line is as it was
    const [g] = fmtaoUnbacked.run(ctx({ ...at(12n, over), prev: at(11n, over) }));
    expect(g.facts.contracts).toBeUndefined();
    expect(RUNBOOK["fmtao.unbacked"](g.facts)).toContain("pause the front door (stops new batches and deliveries)");
  });
});

describe("fmtao.depeg and price.reference_unavailable", () => {
  it("is quiet 4.9% from the reference, and finds 5.1% on two price reads about 5 minutes apart", () => {
    expect(fmtaoDepeg.run(ctx({ base: base(10n, pools(400 * 1.049)), reference: { usd: 400 } }))).toEqual([]);
    const first = ctx({ base: base(10n, pools(400 * 1.051)), reference: { usd: 400 } });
    expect(fmtaoDepeg.run(first)).toEqual([]);
    const state = meta(first).depeg;
    expect(JSON.parse(state)).toMatchObject({ at: NOW, off: true, confirmed: false });
    const second = ctx({ base: base(11n, pools(400 * 1.051)), reference: { usd: 400 }, meta: { depeg: state }, nowS: NOW + 300 });
    const [f] = fmtaoDepeg.run(second);
    expect(f).toMatchObject({ rule: "fmtao.depeg", key: "fmtao.depeg" });
    // between price reads the last verdict stands, so the alert doesn't resolve
    const between = ctx({ base: base(12n, pools(400 * 1.051)), meta: { depeg: meta(second).depeg }, nowS: NOW + 360 });
    expect(fmtaoDepeg.run(between).map((x) => x.rule)).toEqual(["fmtao.depeg"]);
  });

  it("leaves the verdict alone on an unavailable read, and confirms on two available reads 4 to 30 minutes apart", () => {
    const off = pools(400 * 1.051);
    const first = ctx({ base: base(10n, off), reference: { usd: 400, sources: 2 } });
    fmtaoDepeg.run(first);
    // an unreliable source answers nothing in between: no reset
    const gap = ctx({ base: base(11n, off), reference: { unavailable: "no price source answered" }, meta: { depeg: meta(first).depeg }, nowS: NOW + 300 });
    expect(fmtaoDepeg.run(gap)).toEqual([]);
    expect(gap.writes.meta.filter((w) => w.k === "depeg")).toEqual([]);
    const second = ctx({ base: base(12n, off), reference: { usd: 400, sources: 2 }, meta: { depeg: meta(first).depeg }, nowS: NOW + 600 });
    expect(fmtaoDepeg.run(second).map((f) => f.key)).toEqual(["fmtao.depeg"]);
    // two reads 31 minutes apart are not a confirmation
    const late = ctx({ base: base(12n, off), reference: { usd: 400, sources: 2 }, meta: { depeg: meta(first).depeg }, nowS: NOW + 31 * 60 });
    expect(fmtaoDepeg.run(late)).toEqual([]);
    // too close together either
    const soon = ctx({ base: base(12n, off), reference: { usd: 400, sources: 2 }, meta: { depeg: meta(first).depeg }, nowS: NOW + 180 });
    expect(fmtaoDepeg.run(soon)).toEqual([]);
  });

  it("needs a third read when only one source answered", () => {
    const off = pools(400 * 1.051);
    let state: string | undefined;
    const read = (t: number) => {
      const c = ctx({ base: base(10n, off), reference: { usd: 400, sources: 1 }, meta: state ? { depeg: state } : {}, nowS: NOW + t });
      const found = fmtaoDepeg.run(c);
      state = meta(c).depeg;
      return found.map((f) => f.key);
    };
    expect(read(0)).toEqual([]);
    expect(read(300)).toEqual([]);
    expect(read(600)).toEqual(["fmtao.depeg"]);
  });

  it("warns on a low share of available reads over the last hour", () => {
    // every other read unavailable never makes a full hour without a price, but half of an hour's reads is too few
    const reads = JSON.stringify(Array.from({ length: 11 }, (_, i) => [NOW - 3300 + i * 300, i % 2 === 0 ? 0 : 1]));
    const c = ctx({ base: base(10n), reference: { unavailable: "no price source answered" }, meta: { reference_reads: reads } });
    const [f] = referenceUnavailable.run(c);
    expect(f).toMatchObject({ rule: "price.reference_unavailable" });
    expect(f.facts["available reads (last hour)"]).toBe("5 of 12");
    const fine = JSON.stringify(Array.from({ length: 11 }, (_, i) => [NOW - 3300 + i * 300, i === 3 ? 0 : 1]));
    expect(referenceUnavailable.run(ctx({ base: base(10n), reference: { usd: 400, sources: 2 }, meta: { reference_reads: fine } }))).toEqual([]);
  });

  it("finds no depeg while the reference is unavailable, and says so after 61 minutes", () => {
    const first = ctx({ base: base(10n, pools(500)), reference: { unavailable: "no price source answered" } });
    expect(fmtaoDepeg.run(first)).toEqual([]);
    expect(referenceUnavailable.run(first)).toEqual([]);
    const since = meta(first).reference_unavailable_since;
    expect(since).toBe(String(NOW));
    const later = ctx({ base: base(11n, pools(500)), reference: { unavailable: "no price source answered" }, meta: { reference_unavailable_since: since }, nowS: NOW + 61 * 60 });
    expect(referenceUnavailable.run(later).map((f) => f.rule)).toEqual(["price.reference_unavailable"]);
    // back: the mark is cleared
    const back = ctx({ base: base(12n), reference: { usd: 400 }, meta: { reference_unavailable_since: since }, nowS: NOW + 62 * 60 });
    expect(referenceUnavailable.run(back)).toEqual([]);
    expect(meta(back).reference_unavailable_since).toBe("");
  });

  it("runs neither rule with no price source configured", () => {
    const none = testConfig({ PRICE_SOURCES: [] });
    const c = ctx({ cfg: none, base: base(10n, pools(500)), reference: { unavailable: "no price source is configured" }, meta: { reference_unavailable_since: String(NOW - 7200) } });
    expect([...fmtaoDepeg.run(c), ...referenceUnavailable.run(c)]).toEqual([]);
  });
});

describe("twap.divergence", () => {
  const window = (usd: number) => JSON.stringify([0, 300, 600, 900, 1200, 1500].map((s) => [NOW - 1800 + s, usd]));
  const oracle = (usd: number) => ({ oracleValue: BigInt(Math.round(usd * 1e6)) });

  it("finds the oracle 3.1% from the mean of the last 30 minutes of our spot readings, twice; not 2.9%", () => {
    const first = ctx({ base: base(10n, { ...pools(400), ...oracle(400 * 1.031) }), meta: { spot_30m: window(400) } });
    expect(twapDivergence.run(first)).toEqual([]);
    const marks = meta(first);
    expect(marks.twap_off_since).toBe(String(NOW));
    const second = ctx({ base: base(11n, { ...pools(400), ...oracle(400 * 1.031) }), meta: { spot_30m: marks.spot_30m, twap_off_since: marks.twap_off_since }, nowS: NOW + 60 });
    expect(twapDivergence.run(second).map((f) => f.key)).toEqual(["twap.divergence"]);
    const close = ctx({ base: base(11n, { ...pools(400), ...oracle(400 * 1.029) }), meta: { spot_30m: window(400), twap_off_since: String(NOW) }, nowS: NOW + 60 });
    expect(twapDivergence.run(close)).toEqual([]);
    expect(meta(close).twap_off_since).toBe("");
  });

  it("keeps 30 minutes of spot readings", () => {
    const c = ctx({ base: base(10n), meta: { spot_30m: JSON.stringify([[NOW - 1801, 1], [NOW - 1799, 2]]) } });
    twapDivergence.run(c);
    expect(JSON.parse(meta(c).spot_30m).map((x: number[]) => x[0])).toEqual([NOW - 1799, NOW]);
  });

  it("leaves the oracle reverting to the critical oracle.reverted (rules-deps.test.ts)", () => {
    expect(twapDivergence.run(ctx({ base: base(11n, { oracleReverted: true }), prev: { base: base(10n, { oracleReverted: true }) } }))).toEqual([]);
  });
});

describe("pool.liquidity and fmtao.mint_surge", () => {
  const week = (tao: bigint): HourAgg[] => Array.from({ length: 168 }, (_, i) => ({ hour: NOW - (i + 1) * 3600, ticks: 60, spotSum: 0, spotCount: 0, poolTaoLast: tao, liquidityLast: 10n ** 20n }));

  it("finds the pool's TAO below 50% of its 7-day median once it has stayed low for 30 minutes", () => {
    const low = base(10n, { taoWethPool: { ...pools(400).taoWethPool, tao: 490n * E18 } });
    const first = ctx({ base: low, hours: week(1000n * E18) });
    expect(poolLiquidity.run(first)).toEqual([]);
    expect(meta(first).pool_low_since).toBe(String(NOW));
    const early = ctx({ base: low, hours: week(1000n * E18), meta: { pool_low_since: String(NOW) }, nowS: NOW + DEFAULTS.liquidityLowS - 1 });
    expect(poolLiquidity.run(early)).toEqual([]);
    expect(early.writes.meta).toEqual([]);
    const held = ctx({ base: low, hours: week(1000n * E18), meta: { pool_low_since: String(NOW) }, nowS: NOW + DEFAULTS.liquidityLowS });
    const found = poolLiquidity.run(held);
    expect(found.map((f) => f.key)).toEqual(["pool.liquidity"]);
    expect(found[0].facts.since).toBe(utc(NOW));
    const fine = base(10n, { taoWethPool: { ...pools(400).taoWethPool, tao: 510n * E18 } });
    const back = ctx({ base: fine, hours: week(1000n * E18), meta: { pool_low_since: String(NOW) }, nowS: NOW + 60 });
    expect(poolLiquidity.run(back)).toEqual([]);
    expect(meta(back).pool_low_since).toBe("");
    const quiet = ctx({ base: fine, hours: week(1000n * E18) });
    expect(poolLiquidity.run(quiet)).toEqual([]);
    expect(quiet.writes.meta).toEqual([]);
  });

  it("finds the in-range liquidity below 50% of its 7-day median only after 30 minutes, the mark kept while unjudged", () => {
    const thin = base(10n, { taoWethPool: { ...pools(400).taoWethPool, tao: 1000n * E18, liquidity: 10n ** 19n } });
    const held = ctx({ base: thin, hours: week(1000n * E18), meta: { pool_low_since: String(NOW) }, nowS: NOW + DEFAULTS.liquidityLowS });
    expect(poolLiquidity.run(held).map((f) => f.subject)).toEqual(["The TAO/WETH pool's liquidity is below 50% of its 7-day median"]);
    // a tick without the pool's reading judges nothing and leaves the mark where it was
    const unread = ctx({ base: base(10n, { taoWethPool: undefined }), hours: week(1000n * E18), meta: { pool_low_since: String(NOW) }, nowS: NOW + 60 });
    poolLiquidity.run(unread);
    expect(meta(unread).pool_low_since).toBeUndefined();
  });

  it("finds FM-TAO up 600 in an hour with 50 of Cascade payouts landed, unless switched off", () => {
    const hourAgo = Math.floor((NOW - 3600) / 3600) * 3600;
    const hours: HourAgg[] = [{ hour: hourAgo, ticks: 60, spotSum: 0, spotCount: 0, supplyLast: 1000n * E18 }];
    const landed = slog({ contract: "frontDoor", event: "PayoutsDelivered", chain: "base", block: 37_000_100n, args: { batchKey: h("k"), chunk: 0, amount: String(50n * E18), bridge: D.baseAdapter } });
    const c = ctx({ base: base(10n, { fmTaoSupply: 1600n * E18 }), hours, logs: [landed] });
    const found = fmtaoMintSurge.run(c);
    expect(found.map((f) => f.rule)).toEqual(["fmtao.mint_surge"]);
    expect(found[0].facts).toMatchObject({ rise: "600 TAO", "Cascade payouts": "50 TAO" });
    expect(fmtaoMintSurge.run(ctx({ base: base(10n, { fmTaoSupply: 1540n * E18 }), hours, logs: [landed] }))).toEqual([]);
    const off = reconcile(env.DB, { open: [], findings: found, nowS: NOW, t: { ...DEFAULTS, rules: { off: ["fmtao.mint_surge"] } }, holdActive: false });
    expect(off.statements).toEqual([]);
  });
});

describe("oracle.thin_pool and oracle.thin_pool_repeated (v3.2)", () => {
  const v32 = testConfigV32();
  const USER = "0x00000000000000000000000000000000000a11ce" as Hex;
  // the floors deliver() checks (ThinPool below either), and each pool's 30-minute mean in-range liquidity
  const floors = { taoWeth: 10n ** 17n, wethUsdc: 10n ** 16n };
  const deep = { taoWeth: 6n * 10n ** 17n, wethUsdc: 2n * 10n ** 17n };
  const at = (block: bigint, mean: { taoWeth: bigint; wethUsdc: bigint } | undefined, o: Partial<BaseState> = {}) =>
    base(block, { minPoolLiquidity: floors, ...(mean ? { meanLiquidity: mean } : {}), ...o });
  const thin = { ...deep, taoWeth: 10n ** 17n - 1n };
  const run = (o: Parameters<typeof ctx>[0]) => oracleThinPool.run(ctx({ cfg: v32, ...o }));

  it("is in the tick as a warning, its repeated form too, each with a runbook line", () => {
    expect(MARKET_RULES).toContain(oracleThinPool);
    expect(RULES["oracle.thin_pool"]).toMatchObject({ tier: "warning", kind: "condition" });
    expect(RULES["oracle.thin_pool_repeated"]).toMatchObject({ tier: "warning", kind: "condition" });
    for (const id of ["oracle.thin_pool", "oracle.thin_pool_repeated"] as const) expect(RUNBOOK[id]({}).length, id).toBeGreaterThan(80);
  });

  it("warns while a pool's mean liquidity is under the front door's floor, on two readings, one alert per pool, naming the deliveries waiting", () => {
    const waiting = { claimable: { [USER]: E18 }, deliveryOf: { [USER]: { minUsdcPerTao: 390_000_000n, deadline: NOW + 3600, destination: 6 } } };
    expect(run({ base: at(11n, deep), prev: { base: at(10n, deep) } })).toEqual([]);
    expect(run({ base: at(11n, thin), prev: { base: at(10n, deep) } })).toEqual([]);
    const c = ctx({ cfg: v32, base: at(11n, thin, waiting), prev: { base: at(10n, thin) } });
    const [f] = oracleThinPool.run(c);
    expect(f).toMatchObject({ rule: "oracle.thin_pool", key: "oracle.thin_pool:taoWeth", facts: { pool: "TAO/WETH", "mean liquidity (30 minutes)": String(thin.taoWeth), floor: String(floors.taoWeth), "deliveries waiting": "1 (of the users read)" } });
    expect(f.subject).toBe("The TAO/WETH pool is thinner than the front door's floor: USDC deliveries wait (ThinPool)");
    // the episode's start is remembered, and counted among the day's episodes
    expect(meta(c)).toEqual({ "thin_pool_since:taoWeth": String(NOW), "thin_pool_episodes:taoWeth": String(NOW) });
    // exactly the floor passes, as deliver() does
    expect(run({ base: at(11n, { ...deep, taoWeth: floors.taoWeth }), prev: { base: at(10n, { ...deep, taoWeth: floors.taoWeth }) } })).toEqual([]);
    const both = { taoWeth: 1n, wethUsdc: 1n };
    expect(run({ base: at(11n, both), prev: { base: at(10n, both) } }).map((x) => x.key)).toEqual(["oracle.thin_pool:taoWeth", "oracle.thin_pool:wethUsdc"]);
  });

  it("held thin for more than two hours is oracle.thin_pool_repeated: deliveries skipped round after round (R3 C-L1)", () => {
    const m = { "thin_pool_since:taoWeth": String(NOW - 7200) };
    expect(run({ base: at(11n, thin), prev: { base: at(10n, thin) }, meta: m }).map((x) => x.rule)).toEqual(["oracle.thin_pool"]);
    const later = { "thin_pool_since:taoWeth": String(NOW - 7201) };
    const found = run({ base: at(11n, thin), prev: { base: at(10n, thin) }, meta: later });
    expect(found.map((x) => x.rule)).toEqual(["oracle.thin_pool", "oracle.thin_pool_repeated"]);
    const r = found[1];
    expect(r).toMatchObject({ key: "oracle.thin_pool_repeated:taoWeth", facts: { since: utc(NOW - 7201) } });
    expect(r.subject).toBe("The TAO/WETH pool has been thinner than the floor for 2 hours: USDC deliveries are held round after round");
    expect(RUNBOOK["oracle.thin_pool_repeated"](r.facts)).toContain("claim");
    // deep again: the mark clears
    const c = ctx({ cfg: v32, base: at(11n, deep), prev: { base: at(10n, thin) }, meta: later });
    expect(oracleThinPool.run(c)).toEqual([]);
    expect(meta(c)).toEqual({ "thin_pool_since:taoWeth": "" });
  });

  it("counts thin episodes in a day: a griefer thinning the pool only around the keeper's rounds is oracle.thin_pool_repeated at the third (R3 C-L1)", () => {
    let m: Record<string, string> = {};
    const HOUR = 3600;
    /** One tick at `nowS`, this reading's means and the one before, the meta carried to the next. */
    const tick = (nowS: number, now: typeof thin, before: typeof thin) => {
      const c = ctx({ cfg: v32, nowS, base: at(11n, now), prev: { base: at(10n, before) }, meta: m });
      const found = oracleThinPool.run(c);
      m = Object.fromEntries(Object.entries({ ...m, ...meta(c) }).filter(([, v]) => v !== ""));
      return found;
    };
    const rules = (f: ReturnType<typeof tick>) => f.map((x) => x.rule);
    /** A keeper round the griefer thins the pool around: thin on two readings (one episode), deep again 30 minutes on. */
    const round = (t0: number) => {
      expect(rules(tick(t0, thin, deep))).toEqual([]);
      const found = tick(t0 + 60, thin, thin);
      expect(rules(tick(t0 + 1800, deep, thin)).includes("oracle.thin_pool")).toBe(false);
      return found;
    };
    // never thin for two hours in a row, so the old reading (continuous thinness) never fired
    expect(rules(round(NOW))).toEqual(["oracle.thin_pool"]);
    expect(rules(round(NOW + 4 * HOUR))).toEqual(["oracle.thin_pool"]);
    expect(m["thin_pool_episodes:taoWeth"]).toBe(`${NOW},${NOW + 4 * HOUR}`);
    const third = round(NOW + 8 * HOUR);
    expect(rules(third)).toEqual(["oracle.thin_pool", "oracle.thin_pool_repeated"]);
    const r = third[1];
    expect(r).toMatchObject({ key: "oracle.thin_pool_repeated:taoWeth", facts: { "thin episodes in 24 hours": `3: ${utc(NOW)}, ${utc(NOW + 4 * HOUR)}, ${utc(NOW + 8 * HOUR)}` } });
    expect(r.subject).toBe("The TAO/WETH pool has gone thinner than the floor 3 times in 24 hours: USDC deliveries are held round after round");
    expect(RUNBOOK["oracle.thin_pool_repeated"](r.facts)).toContain("3 times in 24 hours");
    // it stands between the rounds, the pool deep, while three fall within the day
    expect(rules(tick(NOW + 12 * HOUR, deep, deep))).toEqual(["oracle.thin_pool_repeated"]);
    // a day after the first, it has dropped out: two left, quiet, and the mark forgets it
    expect(rules(tick(NOW + 24 * HOUR + 1, deep, deep))).toEqual([]);
    expect(m["thin_pool_episodes:taoWeth"]).toBe(`${NOW + 4 * HOUR},${NOW + 8 * HOUR}`);
  });

  it("is unjudged without the reading, the mean or the floor, its mark left as it is; v3-launch doesn't run it", () => {
    const m = { "thin_pool_since:taoWeth": String(NOW - 600) };
    const c = ctx({ cfg: v32, base: at(11n, undefined), prev: { base: at(10n, thin) }, meta: m });
    expect(oracleThinPool.run(c)).toEqual([]);
    expect(c.writes.meta).toEqual([]);
    expect(c.unjudged).toEqual(expect.arrayContaining([{ rule: "oracle.thin_pool", key: "oracle.thin_pool:taoWeth" }, { rule: "oracle.thin_pool_repeated", key: "oracle.thin_pool_repeated:taoWeth" }]));
    const v31 = ctx({ base: at(11n, thin), prev: { base: at(10n, thin) } });
    expect(oracleThinPool.run(v31)).toEqual([]);
    expect(v31.unjudged).toEqual([]);
  });
});

describe("fmtao.depeg's reference age (v3.2, the founder's veto ruling)", () => {
  it("names how old the reference price behind the verdict is; v3-launch's email is today's", () => {
    const v32 = testConfigV32();
    const off = pools(400 * 1.051);
    const first = ctx({ cfg: v32, base: base(10n, off), reference: { usd: 400, sources: 2 } });
    fmtaoDepeg.run(first);
    const second = ctx({ cfg: v32, base: base(11n, off), reference: { usd: 400, sources: 2 }, meta: { depeg: meta(first).depeg }, nowS: NOW + 300 });
    fmtaoDepeg.run(second);
    // four minutes on, no new price read: the verdict stands, and its reference is four minutes old
    const between = ctx({ cfg: v32, base: base(12n, off), meta: { depeg: meta(second).depeg }, nowS: NOW + 540 });
    const [f] = fmtaoDepeg.run(between);
    expect(f.facts["reference's age"]).toBe(`4 minutes (read ${utc(NOW + 300)})`);
    const old = ctx({ base: base(12n, off), meta: { depeg: meta(second).depeg }, nowS: NOW + 540 });
    expect(fmtaoDepeg.run(old)[0].facts["reference's age"]).toBeUndefined();
  });
});

describe("swap.below_oracle (v3.2): a stake or delivery settled more than 1% below the oracle", () => {
  const v32 = testConfigV32();
  const USER = "0x00000000000000000000000000000000000a11ce" as Hex;
  const TX = h("a swap");
  // the oracle values 1 TAO at $400 (usdcValue(1e18) = 400e6)
  const read = (block: bigint, o: Partial<BaseState> = {}) => base(block, { oracleValue: 400_000_000n, ...o });
  const staked = (usdcIn: bigint, fees: bigint, taoDeposited: bigint) =>
    slog({ contract: "staker", event: "Staked", chain: "base", block: 37_000_500n, txHash: TX, args: { payer: USER, beneficiary: USER, usdcIn: String(usdcIn), fees: String(fees), taoDeposited: String(taoDeposited) } });
  const delivered = (taoIn: bigint, usdcOut: bigint) => slog({ contract: "frontDoor", event: "Delivered", chain: "base", block: 37_000_500n, txHash: TX, args: { user: USER, taoIn: String(taoIn), usdcOut: String(usdcOut) } });
  const sold = (taoIn: bigint, usdcOut: bigint, fee: bigint) => slog({ contract: "staker", event: "Sold", chain: "base", block: 37_000_500n, txHash: TX, args: { recipient: cfg.deployment.frontDoor, taoIn: String(taoIn), usdcOut: String(usdcOut), fee: String(fee) } });
  const run = (logs: ReturnType<typeof slog>[], o: Parameters<typeof ctx>[0] = {}) => swapBelowOracle.run(ctx({ cfg: v32, base: read(37_000_600n), prev: { base: read(37_000_490n, pools(400)) }, logs, ...o }));

  it("is a warning event in the tick, with a runbook line", () => {
    expect(MARKET_RULES).toContain(swapBelowOracle);
    expect(RULES["swap.below_oracle"]).toMatchObject({ tier: "warning", kind: "event", canHold: false });
    expect(RUNBOOK["swap.below_oracle"]({}).length).toBeGreaterThan(80);
  });

  it("a stake: the TAO it got against the oracle's value of the USDC swapped (after the staker's fees); 1% below is quiet, more warns", () => {
    // $1,000 in, $10 of fees: $990 swapped is 2.475 TAO at the oracle
    expect(run([staked(1_000_000_000n, 10_000_000n, 2_450_250_000_000_000_000n)])).toEqual([]);
    const l = staked(1_000_000_000n, 10_000_000n, 2_400_000_000_000_000_000n);
    const [f] = run([l]);
    expect(f).toMatchObject({ rule: "swap.below_oracle", key: `swap.below_oracle:${l.uid}`, facts: { trade: "a stake", "TAO received": "2.4 TAO", "the oracle's value": "2.475 TAO", "below the oracle": "3.03%" } });
    expect(f.subject).toBe("A stake filled 3.03% below the oracle's price");
  });

  it("a delivery: the USDC paid, the swapper's fee added back, against the oracle and against the pools' price before it (R3 C-I6)", () => {
    // 1 TAO at the oracle's $400; the swapper kept $2
    expect(run([delivered(E18, 394_000_000n), sold(E18, 394_000_000n, 2_000_000n)])).toEqual([]);
    const [f] = run([delivered(E18, 390_000_000n), sold(E18, 390_000_000n, 2_000_000n)]);
    expect(f).toMatchObject({ facts: { trade: "a USDC delivery", "USDC paid": "390 USDC", "the swapper's fee": "2 USDC", "the oracle's value": "400 USDC", "below the oracle": "2.00%" } });
    expect(f.subject).toBe("A USDC delivery filled 2.00% below the oracle's price");
    // the pools' price before it ($420) above the oracle: below the spot too, once the route's pool fees are taken off
    // it ($420 × 0.997 × 0.9995 = $418.53)
    const spot = run([delivered(E18, 405_000_000n)], { base: read(37_000_600n), prev: { base: read(37_000_490n, pools(420)) } });
    expect(spot[0].facts).toMatchObject({ "below the oracle": "none", "the pools' price before it": "420.00 USD a TAO", "the route's pool fees": "0.30% + 0.05%", "below it": "3.23%" });
    expect(spot[0].subject).toBe("A USDC delivery filled 3.23% below the pools' price before it, after the pools' fees");
  });

  it("the pools' price is compared after the route's pool fees (PATH_TAO_TO_USDC's tiers), so an honest delivery's fees don't trip it", () => {
    expect(pathFees(PATH_TAO_TO_USDC)).toEqual([3000, 500]);
    // the oracle at $395, so only the spot ($400) judges: $400 less 0.3% and 0.05% is $398.6006 a TAO
    const at395 = { base: read(37_000_600n, { oracleValue: 395_000_000n }), prev: { base: read(37_000_490n, { ...pools(400), oracleValue: 395_000_000n }) } };
    // an honest fill at the pools' price less their fees: quiet
    expect(run([delivered(E18, 398_600_600n)], at395)).toEqual([]);
    // exactly 1% under that (1.35% under the bare mid price, which used to warn): quiet, at the boundary
    expect(run([delivered(E18, 394_614_594n)], at395)).toEqual([]);
    // 1.01% under it: warns
    const [f] = run([delivered(E18, 394_574_000n)], at395);
    expect(f.facts).toMatchObject({ "below the oracle": "0.10%", "below it": "1.01%" });
    expect(f.subject).toBe("A USDC delivery filled 1.01% below the pools' price before it, after the pools' fees");
  });

  it("without the oracle's value it judges nothing (unjudged), and v3-launch doesn't run it", () => {
    const c = ctx({ cfg: v32, base: base(37_000_600n), logs: [delivered(E18, 300_000_000n)] });
    expect(swapBelowOracle.run(c)).toEqual([]);
    expect(c.unjudged).toEqual([{ rule: "swap.below_oracle" }]);
    expect(swapBelowOracle.run(ctx({ base: read(37_000_600n), logs: [delivered(E18, 300_000_000n)] }))).toEqual([]);
  });
});
