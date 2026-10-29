import { env } from "cloudflare:workers";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { reconcile } from "../../src/alerts.ts";
import type { Config } from "../../src/config.ts";
import { poolPriceUsd, PRICE_URLS, referencePrice } from "../../src/prices.ts";
import { logQuery, type RuleCtx } from "../../src/rules/context.ts";
import { fmtaoDepeg, fmtaoMintSurge, fmtaoUnbacked, poolLiquidity, referenceUnavailable, twapDivergence } from "../../src/rules/market.ts";
import type { BaseState, BitState, ChainReading, HourAgg } from "../../src/snapshot.ts";
import { DEFAULTS } from "../../src/thresholds.ts";
import { D, h } from "./bridge-fixtures.ts";
import { testConfig } from "./fixtures.ts";
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
    expect(await referencePrice({ getJson: answers(cg(400), cb(404)), sources: ["coingecko", "coinbase"] })).toEqual({ usd: 402 });
    expect(await referencePrice({ getJson: answers(new Error("down"), cb(404)), sources: ["coingecko", "coinbase"] })).toEqual({ usd: 404 });
  });

  it("is unavailable when the sources disagree by more than 2%, none answers, or none is configured", async () => {
    expect(await referencePrice({ getJson: answers(cg(400), cb(412)), sources: ["coingecko", "coinbase"] })).toEqual({ unavailable: expect.stringContaining("disagree") });
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

  it("finds the oracle reverting on two readings, worded unavailable", () => {
    const [f] = twapDivergence.run(ctx({ base: base(11n, { oracleReverted: true }), prev: { base: base(10n, { oracleReverted: true }) } }));
    expect(f.key).toBe("twap.divergence:unavailable");
    expect(f.subject).toContain("unavailable");
    expect(twapDivergence.run(ctx({ base: base(11n, { oracleReverted: true }), prev: { base: base(10n) } }))).toEqual([]);
  });
});

describe("pool.liquidity and fmtao.mint_surge", () => {
  const week = (tao: bigint): HourAgg[] => Array.from({ length: 168 }, (_, i) => ({ hour: NOW - (i + 1) * 3600, ticks: 60, spotSum: 0, spotCount: 0, poolTaoLast: tao, liquidityLast: 10n ** 20n }));

  it("finds the pool's TAO below 50% of its 7-day median", () => {
    const low = base(10n, { taoWethPool: { ...pools(400).taoWethPool, tao: 490n * E18 } });
    expect(poolLiquidity.run(ctx({ base: low, hours: week(1000n * E18) })).map((f) => f.key)).toEqual(["pool.liquidity"]);
    const fine = base(10n, { taoWethPool: { ...pools(400).taoWethPool, tao: 510n * E18 } });
    expect(poolLiquidity.run(ctx({ base: fine, hours: week(1000n * E18) }))).toEqual([]);
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
