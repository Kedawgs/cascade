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
  /** the last available read */
  at: number;
  off: boolean;
  /** off reads in a row, each within CONFIRM_MAX_GAP_S of the last */
  streak: number;
  /** when the streak began */
  first: number;
  /** a read in the streak came from a single source */
  single: boolean;
  confirmed: boolean;
  spot?: number;
  ref?: number;
}

/** Two off reads confirm a depeg when they are 4 to 30 minutes apart (unavailable reads in between don't
 * count, and don't reset anything): one bad answer can't page, and an unreliable source can't hide a depeg. */
const CONFIRM_MIN_S = 240;
const CONFIRM_MAX_GAP_S = 1800;

/** fmtao.depeg: the pool's TAO price differs from the reference by more than depegBps on two available price
 * reads 4 to 30 minutes apart, or three when a read came from a single source. An unavailable read leaves the
 * last verdict alone. The verdict is kept in meta, so it stands between price reads. */
export const fmtaoDepeg: Rule = {
  name: "fmtao.depeg",
  run(ctx) {
    if (ctx.cfg.priceSources.length === 0) return [];
    const last = json<DepegState>(ctx.meta.depeg);
    let state = last;
    const spot = ctx.snap.base ? poolPriceUsd(ctx.snap.base.state, ctx.cfg.tokens) : undefined;
    if (ctx.reference && "usd" in ctx.reference && spot !== undefined) {
      const ref = ctx.reference.usd;
      const single = ctx.reference.sources === 1;
      const off = Math.abs(spot / ref - 1) * 10_000 > ctx.t.depegBps;
      if (!off) {
        state = { at: ctx.nowS, off, streak: 0, first: ctx.nowS, single: false, confirmed: false, spot, ref };
      } else {
        const goesOn = last?.off === true && ctx.nowS - last.at <= CONFIRM_MAX_GAP_S;
        const streak = goesOn ? last.streak + 1 : 1;
        const first = goesOn ? last.first : ctx.nowS;
        const anySingle = (goesOn && last.single) || single;
        const confirmed = streak >= (anySingle ? 3 : 2) && ctx.nowS - first >= CONFIRM_MIN_S;
        state = { at: ctx.nowS, off, streak, first, single: anySingle, confirmed, spot, ref };
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

/** An hour of price reads before their share counts. */
const MIN_READS = 6;

/** price.reference_unavailable: no reference price for more than referenceUnavailableS, or fewer than
 * referenceMinAvailablePct of the last hour's reads available (an unreliable source that answers now and
 * then never makes a whole hour without a price, but can still keep fmtao.depeg from confirming). */
export const referenceUnavailable: Rule = {
  name: "price.reference_unavailable",
  run(ctx) {
    if (ctx.cfg.priceSources.length === 0) return [];
    let since = num(ctx.meta.reference_unavailable_since);
    let reads = (json<[number, number][]>(ctx.meta.reference_reads) ?? []).filter(([t]) => t > ctx.nowS - 3600 && t < ctx.nowS);
    if (ctx.reference) {
      const available = "usd" in ctx.reference;
      if (!available && since === undefined) {
        since = ctx.nowS;
        ctx.writes.meta.push({ k: "reference_unavailable_since", v: String(since) });
      } else if (available && since !== undefined) {
        ctx.writes.meta.push({ k: "reference_unavailable_since", v: "" });
        since = undefined;
      }
      reads = [...reads, [ctx.nowS, available ? 1 : 0]];
      ctx.writes.meta.push({ k: "reference_reads", v: JSON.stringify(reads) });
    }
    const ok = reads.filter(([, a]) => a === 1).length;
    const lowShare = reads.length >= MIN_READS && ok * 100 < reads.length * ctx.t.referenceMinAvailablePct;
    const longGap = since !== undefined && ctx.nowS - since > ctx.t.referenceUnavailableS;
    if (!lowShare && !longGap) return [];
    const facts: Record<string, string> = { "available reads (last hour)": `${ok} of ${reads.length}` };
    if (since !== undefined) facts.since = utc(since);
    if (ctx.reference && "unavailable" in ctx.reference) facts.why = ctx.reference.unavailable;
    return [{ rule: "price.reference_unavailable", key: "price.reference_unavailable", subject: "No reliable reference TAO price: the depeg rule can't confirm", facts }];
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
