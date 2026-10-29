import { formatUnits } from "viem";
import type { Finding } from "../alerts.ts";
import { poolPriceUsd } from "../prices.ts";
import { type Readings, type RuleCtx, twice, utc } from "./context.ts";
import type { Rule } from "./index.ts";

// Spec 6.1 fmtao.unbacked and fmtao.depeg, 6.3 twap.divergence, price.reference_unavailable and
// pool.liquidity, 6.4 fmtao.mint_surge. Rules that need more than this tick's reading keep a small state in
// meta (written with the tick's commit): the last depeg verdict, since when the reference has been
// unavailable, the last 30 minutes of spot prices, and since when the oracle has been off.

const tao = (wei: bigint) => `${formatUnits(wei, 18)} TAO`;
const json = <T>(s: string | undefined): T | undefined => {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
};
const num = (s: string | undefined) => (s ? Number(s) : undefined);

/** fmtao.unbacked: FM-TAO's supply on Base above the Bittensor lock pool's FM-TAO by more than the slack, on
 * two readings of each chain. A condition re-checked every tick: the backstop for a forged message that
 * carries tokens. */
export const fmtaoUnbacked: Rule = {
  name: "fmtao.unbacked",
  run(ctx) {
    const excess = (r: Readings) =>
      r.base?.fmTaoSupply === undefined || r.bittensor?.lockPoolFmTao === undefined ? undefined : r.base.fmTaoSupply - r.bittensor.lockPoolFmTao;
    const over = (r: Readings) => (excess(r) ?? 0n) > ctx.t.fmtaoBackingSlackWei;
    if (!twice(ctx, ["base", "bittensor"], over)) return [];
    const now: Readings = { base: ctx.snap.base?.state, bittensor: ctx.snap.bittensor?.state };
    const e = excess(now) as bigint;
    return [
      {
        rule: "fmtao.unbacked",
        key: "fmtao.unbacked",
        subject: `FM-TAO on Base exceeds its lock on Bittensor by ${tao(e)}`,
        facts: { supply: String(now.base?.fmTaoSupply), lock: String(now.bittensor?.lockPoolFmTao), excess: String(e), "excess (TAO)": tao(e) },
      },
    ];
  },
};

interface DepegState {
  at: number;
  off: boolean;
  confirmed: boolean;
  spot?: number;
  ref?: number;
}

/** fmtao.depeg: the pool's TAO price differs from the reference by more than depegBps on two price reads
 * about 5 minutes apart (4 to 15). The verdict is kept in meta, so it stands between price reads. */
export const fmtaoDepeg: Rule = {
  name: "fmtao.depeg",
  run(ctx) {
    if (ctx.cfg.priceSources.length === 0) return [];
    const last = json<DepegState>(ctx.meta.depeg);
    let state = last;
    if (ctx.reference) {
      const spot = ctx.snap.base ? poolPriceUsd(ctx.snap.base.state, ctx.cfg.tokens) : undefined;
      if ("unavailable" in ctx.reference || spot === undefined) {
        state = { at: ctx.nowS, off: false, confirmed: false };
      } else {
        const ref = ctx.reference.usd;
        const off = Math.abs(spot / ref - 1) * 10_000 > ctx.t.depegBps;
        const gap = ctx.nowS - (last?.at ?? 0);
        const confirmed = off && last?.off === true && (last.confirmed || (gap >= 240 && gap <= 900));
        state = { at: ctx.nowS, off, confirmed, spot, ref };
      }
      ctx.writes.meta.push({ k: "depeg", v: JSON.stringify(state) });
    }
    if (!state?.confirmed) return [];
    const bps = state.spot && state.ref ? Math.round(Math.abs(state.spot / state.ref - 1) * 10_000) : undefined;
    return [
      {
        rule: "fmtao.depeg",
        key: "fmtao.depeg",
        subject: `TAO on Base trades ${bps ?? "more than " + ctx.t.depegBps} bps away from TAO`,
        facts: { "pool price (USD)": String(state.spot?.toFixed(2)), "reference (USD)": String(state.ref?.toFixed(2)), "read at": utc(state.at) },
      },
    ];
  },
};

/** price.reference_unavailable: no reference price for more than referenceUnavailableS. */
export const referenceUnavailable: Rule = {
  name: "price.reference_unavailable",
  run(ctx) {
    if (ctx.cfg.priceSources.length === 0) return [];
    let since = num(ctx.meta.reference_unavailable_since);
    if (ctx.reference) {
      if ("unavailable" in ctx.reference) {
        if (since === undefined) {
          since = ctx.nowS;
          ctx.writes.meta.push({ k: "reference_unavailable_since", v: String(since) });
        }
      } else {
        if (since !== undefined) ctx.writes.meta.push({ k: "reference_unavailable_since", v: "" });
        since = undefined;
      }
    }
    if (since === undefined || ctx.nowS - since <= ctx.t.referenceUnavailableS) return [];
    const facts: Record<string, string> = { since: utc(since) };
    if (ctx.reference && "unavailable" in ctx.reference) facts.why = ctx.reference.unavailable;
    return [{ rule: "price.reference_unavailable", key: "price.reference_unavailable", subject: "No reference TAO price: the depeg rule can't run", facts }];
  },
};

const WINDOW_S = 1800;

/** twap.divergence: the front door's oracle (usdcValue of 1 TAO) differs by more than twapDivergenceBps from
 * the mean of this monitor's own spot prices over the last 30 minutes, on this tick and the last; or the
 * oracle's call reverts on two readings. */
export const twapDivergence: Rule = {
  name: "twap.divergence",
  run(ctx) {
    const b = ctx.snap.base;
    if (!b) return [];
    const out: Finding[] = [];
    if (twice(ctx, "base", (r) => r.base?.oracleReverted === true)) {
      out.push({ rule: "twap.divergence", key: "twap.divergence:unavailable", subject: "The TWAP oracle is unavailable: its call reverts", facts: { oracle: ctx.cfg.deployment.oracle, block: String(b.block) } });
    }
    const spot = poolPriceUsd(b.state, ctx.cfg.tokens);
    const window = (json<[number, number][]>(ctx.meta.spot_30m) ?? []).filter(([t]) => t < ctx.nowS);
    if (spot !== undefined) window.push([ctx.nowS, spot]);
    const kept = window.filter(([t]) => t > ctx.nowS - WINDOW_S);
    ctx.writes.meta.push({ k: "spot_30m", v: JSON.stringify(kept) });
    const since = num(ctx.meta.twap_off_since);
    const clear = () => since !== undefined && ctx.writes.meta.push({ k: "twap_off_since", v: "" });
    if (b.state.oracleValue === undefined || kept.length === 0) {
      clear();
      return out;
    }
    const mean = kept.reduce((s, [, p]) => s + p, 0) / kept.length;
    const oracleUsd = Number(b.state.oracleValue) / 1e6;
    const off = Math.abs(oracleUsd / mean - 1) * 10_000;
    if (off <= ctx.t.twapDivergenceBps) {
      clear();
      return out;
    }
    if (since === undefined) {
      ctx.writes.meta.push({ k: "twap_off_since", v: String(ctx.nowS) });
      return out;
    }
    out.push({
      rule: "twap.divergence",
      key: "twap.divergence",
      subject: `The TWAP oracle is ${Math.round(off)} bps from the pool's 30-minute price`,
      facts: { "oracle (USD)": oracleUsd.toFixed(2), "30-minute mean (USD)": mean.toFixed(2), readings: String(kept.length), since: utc(since) },
    });
    return out;
  },
};

const median = (xs: bigint[]): bigint | undefined => {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor(s.length / 2)];
};

/** pool.liquidity: the TAO/WETH pool's TAO, or its in-range liquidity, below liquidityDropPct of its 7-day
 * median (hour rows; at least a day of them). */
export const poolLiquidity: Rule = {
  name: "pool.liquidity",
  run(ctx) {
    const pool = ctx.snap.base?.state.taoWethPool;
    if (!pool) return [];
    const week = ctx.hours.filter((r) => r.hour >= ctx.nowS - 7 * 86400);
    if (week.length < 24) return [];
    const pct = BigInt(ctx.t.liquidityDropPct);
    const low = (now: bigint | undefined, m: bigint | undefined) => now !== undefined && m !== undefined && m > 0n && now * 100n < m * pct;
    const taoMedian = median(week.flatMap((r) => (r.poolTaoLast === undefined ? [] : [r.poolTaoLast])));
    const liqMedian = median(week.flatMap((r) => (r.liquidityLast === undefined ? [] : [r.liquidityLast])));
    const lowTao = low(pool.tao, taoMedian);
    const lowLiq = low(pool.liquidity, liqMedian);
    if (!lowTao && !lowLiq) return [];
    return [
      {
        rule: "pool.liquidity",
        key: "pool.liquidity",
        subject: `The TAO/WETH pool's ${lowTao ? "TAO" : "liquidity"} is below ${ctx.t.liquidityDropPct}% of its 7-day median`,
        facts: { "pool TAO": pool.tao === undefined ? "unknown" : tao(pool.tao), "7-day median TAO": taoMedian === undefined ? "unknown" : tao(taoMedian), liquidity: String(pool.liquidity), "7-day median liquidity": String(liqMedian) },
      },
    ];
  },
};

/** fmtao.mint_surge (proposed, switchable in rules.off): FM-TAO's supply on Base rose by more than
 * mintSurgeWei since the end of the last hour beyond the payouts that landed for Cascade in the last hour. */
export const fmtaoMintSurge: Rule = {
  name: "fmtao.mint_surge",
  run(ctx) {
    const supply = ctx.snap.base?.state.fmTaoSupply;
    if (supply === undefined) return [];
    const hourAgo = Math.floor((ctx.nowS - 3600) / 3600) * 3600;
    const baseline = ctx.hours.find((r) => r.hour === hourAgo)?.supplyLast;
    if (baseline === undefined) return [];
    const landed = ctx.logs
      .range("base", "frontDoor", "PayoutsDelivered")
      .filter((l) => (ctx.blockTime("base", l.block) ?? ctx.nowS) >= ctx.nowS - 3600)
      .reduce((s, l) => s + BigInt(String(l.args.amount)), 0n);
    const rise = supply - baseline;
    if (rise - landed <= ctx.t.mintSurgeWei) return [];
    return [
      {
        rule: "fmtao.mint_surge",
        key: `fmtao.mint_surge:${hourAgo}`,
        subject: `FM-TAO on Base rose ${tao(rise - landed)} in an hour beyond Cascade's payouts`,
        facts: { rise: tao(rise), "Cascade payouts": tao(landed), supply: tao(supply) },
      },
    ];
  },
};

export const MARKET_RULES: Rule[] = [fmtaoUnbacked, fmtaoDepeg, referenceUnavailable, twapDivergence, poolLiquidity, fmtaoMintSurge];
