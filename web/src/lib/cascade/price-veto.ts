import type { Clients } from "./chain";
import { type Deployment, isV32 } from "./config";
import { FlowError } from "./flows";
import { bodyWithin } from "./indexer";
import { quoteBuy, quoteSell } from "./reads";

// v3.2's outside-price veto (rulings-index T58, founder-approved 2026-11-06 "if done properly"). A pool held off the
// market for the TWAP's whole 30-minute window drags the TWAP, and every floor cut from it, along with it (R3 C-L1):
// only a price from outside the pools catches that. So before a stake (USDC -> TAO, the staker's swap) or an unstake
// asking for USDC (TAO -> USDC: the keeper's later deliver, whose minimum is cut from today's sale quote), the Base
// pools' TAO price is compared with the indexer's outside reference: GET /v1/price, the median of CoinGecko and
// Coinbase it reads every fifth minute, unavailable when none answers or they disagree by more than 2%
// (indexer/src/prices.ts, api.ts handlePrice). The reference comes from there only: no other host, so no new CSP entry.
//
// A VETO ONLY. It can refuse a trade, never approve, loosen or change one: it gives nothing back, so the amounts,
// minimums and floors sent are exactly what they would be without it. The contracts' floors (the staker's 95% of the
// TWAP, the delivery's TWAP less 1.5%, the user's own minimum) stay the binding limits, so a wrong or forged reference
// can only make a trade wait. A reference that can't be read or gone by fails closed: nothing is sent.
//
// v3.2 only (outsidePriceVeto): every other deployment's flows, v3-launch's above all, are exactly as they were. A
// v3.2 build needs the indexer for it (config.ts readDeployment), so no v3.2 site refuses every stake by accident.
// The keeper's own veto before a delivery is Task 50's.

/** How far the pools' TAO price may sit from the outside reference, in the trade's direction, before the trade is
 * refused, in basis points: 3%, of the reference. Above it for a stake (TAO dear on Base: the stake would overpay),
 * below it for a USDC unstake (TAO cheap on Base: the sale its minimum is cut from would underpay). The other way is
 * the user's gain, and never refused. The pools' price includes their own fees (0.05% and 0.3% each way), so mid to
 * mid the band is a little under 3%: stricter, never looser. */
export const OUTSIDE_PRICE_BPS = 300n;

/** The oldest reference the check goes by: 12 minutes (the founder's "~10 min"). The indexer asks the sources every
 * fifth minute, so a reading is normally at most about 6 minutes old, and up to about 11 after one missed read; 12
 * tolerates exactly one miss. Older, the indexer has stopped reading, and its last price is no longer the market's. */
export const REFERENCE_MAX_AGE_S = 12 * 60;

/** The pools' price for a stake: what $100 of USDC buys along the stake's route (USDC -> WETH -> TAO). A fixed small
 * size, never the user's own amount (their own price impact is Task 59a's): small enough that its impact is a sliver
 * of the 3% band (buying $20 to $1,000 measured within about 1% of the oracle, fees and impact included:
 * config.ts PRICE_CHECK_BPS), large enough that USDC's 6 decimals don't blur it, and the size of a small stake. */
export const STAKE_PROBE_USDC = 100_000_000n;
/** The pools' price for a USDC unstake: what 0.5 TAO sells for along the delivery's route (TAO -> WETH -> USDC).
 * About the stake's $100 (about $115 at TAO's $230 of late October 2026), for the same reasons; a fixed amount of TAO,
 * so neither the reference nor the user's amount sets it. Were TAO to rise far, the larger sale's impact would only
 * make the check stricter. */
export const SALE_PROBE_TAO = 5n * 10n ** 17n;

/** How long the indexer may take before the check gives up (and nothing is sent). */
export const PRICE_TIMEOUT_MS = 5_000;
/** How long each Base RPC's latest block may take to be read for the clock; one that takes longer doesn't count. */
export const CLOCK_READ_TIMEOUT_MS = 5_000;
/** The most the whole check may take before it gives up, refusing (PRICE_UNCHECKABLE): 15 s. In time, the reference
 * (at most PRICE_TIMEOUT_MS) and then the clock (at most CLOCK_READ_TIMEOUT_MS) take 10 s at worst; the pools' quote
 * runs beside them, on the second RPC (3 s and one retry) and then the first, whose retries could take a minute and a
 * half, so the deadline is what bounds a check while the wallet waits. */
export const CHECK_DEADLINE_MS = 15_000;
/** The most the answer may weigh: a reading is under 100 bytes. */
export const MAX_PRICE_BYTES = 4_096;

/** The controller's words (Task 58b), mirroring the staker's BelowOracleFloor sentence. */
export const PRICE_OFF_MARKET =
  "The price on Base is more than 3% away from the wider market right now, so this was not sent. Nothing was spent; try again in a few minutes.";
/** The founder's rule (3): the reference can't be read or gone by, so the check fails closed. */
export const PRICE_UNCHECKABLE = "Can't check the price right now. Try again shortly.";

/** The indexer's reading as /v1/price serves it (v1): the price of a TAO in USD and how many sources agreed on it, or
 * why there is none; `at` is when the sources were asked (unix s), null when nothing was ever read. */
export type Reference = { usd: number; sources: number; at: number } | { unavailable: string; at: number | null };

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const positiveInt = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;

/** `x` as a v1 reading when it is exactly one of the two shapes the indexer serves (its parseReferenceReading's rule,
 * with `at` null allowed for a reason only): a price that is a positive finite number with a positive whole count of
 * sources and a positive whole time, or a reason that isn't empty, never both. Undefined for anything else. */
export function parseReference(x: unknown): Reference | undefined {
  if (!isObject(x) || x.v !== 1) return undefined;
  if ("usd" in x) {
    if ("unavailable" in x || typeof x.usd !== "number" || !Number.isFinite(x.usd) || x.usd <= 0) return undefined;
    return positiveInt(x.sources) && positiveInt(x.at) ? { usd: x.usd, sources: x.sources, at: x.at } : undefined;
  }
  if (typeof x.unavailable !== "string" || x.unavailable === "") return undefined;
  if (x.at === null) return { unavailable: x.unavailable, at: null };
  return positiveInt(x.at) ? { unavailable: x.unavailable, at: x.at } : undefined;
}

/** The indexer's reading, asked with a timeout, CORS and no credentials; null when the deployment names no indexer, or
 * the request fails in any way (a timeout, a network error, any status but 200, a body over MAX_PRICE_BYTES, one that
 * isn't JSON, or isn't exactly a v1 reading). Never throws. Its age is the caller's to judge (referenceUsdc). */
export async function fetchReference(
  d: Pick<Deployment, "indexerUrl">,
  o: { fetch?: typeof globalThis.fetch; timeoutMs?: number; maxBytes?: number } = {},
): Promise<Reference | null> {
  if (!d.indexerUrl) return null;
  const f = o.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? PRICE_TIMEOUT_MS);
  try {
    const res = await f(`${d.indexerUrl}/v1/price`, { method: "GET", mode: "cors", credentials: "omit", signal: controller.signal });
    if (res.status !== 200) return null;
    return parseReference(JSON.parse(await bodyWithin(res, o.maxBytes ?? MAX_PRICE_BYTES))) ?? null;
  } catch {
    controller.abort();
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The reference's price of one TAO in USDC units, when the check can go by it at `nowMs`: a price (one source is
 * enough: the founder's rule counts only none answering, or a disagreement, as unavailable, and the indexer's 2%
 * agreement rule has already judged two), read within REFERENCE_MAX_AGE_S of now either way (a reading dated further
 * ahead means a clock or a record has gone wrong). Undefined for no reading, a reason instead of a price (`at` null
 * on a cold store included), one too old or too far ahead, or a price USDC units can't hold exactly. */
export function referenceUsdc(r: Reference | null, nowMs: number): bigint | undefined {
  if (!r || !("usd" in r)) return undefined;
  const ageMs = nowMs - r.at * 1000;
  // written so that a time that isn't a number never passes
  if (!(Math.abs(ageMs) <= REFERENCE_MAX_AGE_S * 1000)) return undefined;
  const units = Math.round(r.usd * 1e6);
  return Number.isSafeInteger(units) && units > 0 ? BigInt(units) : undefined;
}

/** A stake (USDC -> TAO) or an unstake asking for USDC (TAO -> USDC). */
export type Side = "stake" | "unstake";

/** What the check reads, given by the caller (liveVetoDeps in the app, fakes in tests). */
export interface VetoDeps {
  /** The indexer's reading, or null when it couldn't be read (fetchReference). */
  reference: () => Promise<Reference | null>;
  /** TAO wei bought for `usdcUnits` along the stake's route, pool fees included (reads.ts quoteBuy). */
  quoteBuy: (usdcUnits: bigint) => Promise<bigint>;
  /** USDC units paid for `taoWei` along the delivery's route, pool fees included (reads.ts quoteSell). */
  quoteSell: (taoWei: bigint) => Promise<bigint>;
  /** Now, in ms, as the reading's age is judged: the later of the two Base RPCs' latest blocks (baseNowMs), never the
   * device's clock. Throws when it can't be read, and the check then refuses. */
  nowMs: () => Promise<number>;
}

/** The pools' price of one TAO in USDC units in `side`'s direction, from a fixed small quote along the trade's route:
 * what STAKE_PROBE_USDC buys, rounded up, for a stake; what SALE_PROBE_TAO sells for, rounded down, for an unstake.
 * Each rounding leans the way that refuses sooner. Undefined for a quote of nothing. */
export async function poolUsdcPerTao(side: Side, q: Pick<VetoDeps, "quoteBuy" | "quoteSell">): Promise<bigint | undefined> {
  if (side === "stake") {
    const tao = await q.quoteBuy(STAKE_PROBE_USDC);
    return tao > 0n ? (STAKE_PROBE_USDC * 10n ** 18n + tao - 1n) / tao : undefined;
  }
  const usdc = await q.quoteSell(SALE_PROBE_TAO);
  return usdc > 0n ? (usdc * 10n ** 18n) / SALE_PROBE_TAO : undefined;
}

/** Whether the pools' price is more than `bps` of the reference off it in `side`'s direction: above it for a stake,
 * below it for an unstake. Exactly `bps` off is not more. */
export function offMarket(side: Side, pool: bigint, reference: bigint, bps: bigint = OUTSIDE_PRICE_BPS): boolean {
  const gap = side === "stake" ? pool - reference : reference - pool;
  return gap * 10_000n > reference * bps;
}

/** The check before a trade of `side` is sent: it resolves, giving nothing, when the pools' price sits within the
 * band of a reference it can go by; else it throws a "needs you" FlowError saying why nothing was sent:
 * PRICE_UNCHECKABLE when the reference, the clock or the pools' quote can't be read or gone by, or the whole check
 * isn't done within `deadlineMs` (CHECK_DEADLINE_MS); PRICE_OFF_MARKET when the pools are too far off it. The
 * reference and the pools are read together; the reading's age by Base's clock (`deps.nowMs`) once it is in. */
export async function checkOutsidePrice(side: Side, deps: VetoDeps, deadlineMs: number = CHECK_DEADLINE_MS): Promise<void> {
  const judged = async (): Promise<bigint | undefined> => {
    try {
      const r = await deps.reference();
      return referenceUsdc(r, await deps.nowMs());
    } catch {
      return undefined;
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(resolve, deadlineMs, "late");
  });
  let read: [bigint | undefined, bigint | undefined] | "late";
  try {
    read = await Promise.race([Promise.all([judged(), poolUsdcPerTao(side, deps).catch(() => undefined)]), late]);
  } finally {
    clearTimeout(timer);
  }
  if (read === "late") throw new FlowError(PRICE_UNCHECKABLE, "needs-you");
  const [reference, pool] = read;
  if (reference === undefined || pool === undefined) throw new FlowError(PRICE_UNCHECKABLE, "needs-you");
  if (offMarket(side, pool, reference)) throw new FlowError(PRICE_OFF_MARKET, "needs-you");
}

/** The veto a flow of `d` makes before it sends a trade, one per side: v3.2's alone. Undefined for every other
 * deployment, so their flows ask nothing new. */
export function outsidePriceVeto(d: Deployment, deps: VetoDeps): { stake: () => Promise<void>; unstake: () => Promise<void> } | undefined {
  if (!isV32(d)) return undefined;
  return { stake: () => checkOutsidePrice("stake", deps), unstake: () => checkOutsidePrice("unstake", deps) };
}

/** Now by Base, in ms: the later of the two Base RPCs' latest block timestamps (`base` and `baseCheck`, asked
 * together), so a server lagging behind the chain can't make a reading look younger than it is. A read that fails, or
 * doesn't answer within `timeoutMs`, doesn't count; one answering is enough. Throws when neither answers. Never the
 * device's clock, which can be minutes off (fresh.ts chainNowMs falls back to it; the veto must not). */
export async function baseNowMs(c: Pick<Clients, "base" | "baseCheck">, timeoutMs: number = CLOCK_READ_TIMEOUT_MS): Promise<number> {
  const blockMs = async (client: Pick<Clients["base"], "getBlock">): Promise<number> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const b = await Promise.race([
        client.getBlock({ blockTag: "latest" }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Base's latest block took too long")), timeoutMs);
        }),
      ]);
      return Number(b.timestamp) * 1000;
    } finally {
      clearTimeout(timer);
    }
  };
  const times = (await Promise.allSettled([blockMs(c.base), blockMs(c.baseCheck)]))
    .flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
    .filter((t) => Number.isFinite(t) && t > 0);
  if (times.length === 0) throw new Error("Neither Base RPC gave its latest block");
  return Math.max(...times);
}

/** What the check reads in the app: the indexer's reading of `d`; the pools' quotes on the second Base RPC first (the
 * one the pre-send checks use, on a connection that gives up in seconds: chain.ts baseCheck), so they don't come from
 * the server the user's own quote came from, and on the first when that one can't answer; the age by the later of
 * the two RPCs' latest blocks (baseNowMs), never the device's clock. `clockTimeoutMs`: baseNowMs's bound per read. */
export function liveVetoDeps(d: Deployment, c: Pick<Clients, "base" | "baseCheck">, o: { clockTimeoutMs?: number } = {}): VetoDeps {
  const probe = (read: (client: Pick<Clients, "base">) => Promise<bigint>) => read({ base: c.baseCheck }).catch(() => read(c));
  return {
    reference: () => fetchReference(d),
    quoteBuy: (usdcUnits) => probe((client) => quoteBuy(client, usdcUnits)),
    quoteSell: (taoWei) => probe((client) => quoteSell(client, taoWei)),
    nowMs: () => baseNowMs(c, o.clockTimeoutMs),
  };
}
