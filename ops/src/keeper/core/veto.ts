// The keeper's outside-price veto before a delivery (rulings-index T58 (+T50), founder-approved 2026-11-06 "if done
// properly"; design-keeper-worker.md §6). A pool held off the market for the TWAP's whole 30-minute window drags the
// TWAP, and the delivery's floor cut from it, along with it (R3 C-L1): only a price from outside the pools catches that.
// So before each delivery the keeper prices 0.5 TAO along the delivery route (pool fees included, before the staker's
// own fee, as the web's probe) and compares it with the monitor's GET /v1/price (the median of CoinGecko and Coinbase
// the indexer reads every fifth minute; unavailable when none answers or they disagree by more than 2%).
//
// A VETO ONLY: it can make a delivery wait, never send one, and it never changes keeperMinOut. More than 3% under the
// reference, a reference older than 12 minutes (or dated ahead), none, or unavailable: the delivery is skipped and
// tried again next round, never a strike against the user's revert budget (as ThinPool). The pools above the reference
// is the user's gain and never refused. The same rule and constants as the web's (web/src/lib/cascade/price-veto.ts,
// Task 58b; test/keeper-veto.test.ts holds them equal).

/** How far under the outside reference the pools' price may sit before a delivery waits: 3% of the reference. */
export const OUTSIDE_PRICE_BPS = 300n;
/** The oldest reference the veto goes by: 12 minutes (the founder's "~10 min"; the indexer reads every fifth minute,
 * so this tolerates one missed read). */
export const REFERENCE_MAX_AGE_S = 12 * 60;
/** The pools' price for a sale: what 0.5 TAO sells for along the delivery route. A fixed small size, never the user's
 * own amount (whose impact the floors and the keeper's room already bound). */
export const SALE_PROBE_TAO = 5n * 10n ** 17n;

/** The indexer's reading as /v1/price serves it (v1): a TAO's price in USD and how many sources agreed on it, or why
 * there is none; `at` is when the sources were asked (unix s), null when nothing was ever read. */
export type Reference = { usd: number; sources: number; at: number } | { unavailable: string; at: number | null };

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const positiveInt = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;

/** `x` as a v1 reading when it is exactly one of the two shapes the indexer serves (the web's parseReference): a price
 * that is a positive finite number with a positive whole count of sources and a positive whole time, or a reason that
 * isn't empty (`at` null allowed), never both. Undefined for anything else. */
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

/** The reference's price of one TAO in USDC units when the veto can go by it at `nowMs` (the web's referenceUsdc): a
 * price (one source is enough: the founder's rule counts only none answering, or a disagreement, as unavailable), read
 * within REFERENCE_MAX_AGE_S of now either way. Undefined otherwise. */
export function referenceUsdc(r: Reference | null, nowMs: number): bigint | undefined {
  if (!r || !("usd" in r)) return undefined;
  const ageMs = nowMs - r.at * 1000;
  if (!(Math.abs(ageMs) <= REFERENCE_MAX_AGE_S * 1000)) return undefined;
  const units = Math.round(r.usd * 1e6);
  return Number.isSafeInteger(units) && units > 0 ? BigInt(units) : undefined;
}

/** The pools' price of one TAO in USDC units, from what SALE_PROBE_TAO sells for, rounded down (the way that vetoes
 * sooner). Undefined for a quote of nothing. */
export function saleUsdcPerTao(probeUsdc: bigint): bigint | undefined {
  const usdc = probeUsdc;
  return usdc > 0n ? (usdc * 10n ** 18n) / SALE_PROBE_TAO : undefined;
}

/** Whether the pools' price is more than `bps` of the reference under it (a sale's direction). Exactly `bps` is not
 * more; above the reference never is. */
export function saleOffMarket(pool: bigint, reference: bigint, bps: bigint = OUTSIDE_PRICE_BPS): boolean {
  const gap = reference - pool;
  return gap * 10_000n > reference * bps;
}

/** What the veto reads: the monitor's reading (null when it couldn't be read), what SALE_PROBE_TAO sells for along the
 * delivery route (undefined when it couldn't be quoted), and now by Base's clock (ms), as the web judges the age. */
export interface VetoRead {
  reference: Reference | null;
  probeUsdc?: bigint;
  nowMs: number;
}

const usd = (units: bigint) => `$${(Number(units) / 1e6).toFixed(2)}`;
const CLOSED = "it waits, tried again each round (the outside-price veto fails closed; never a strike)";

/** Why the veto makes the delivery wait, or undefined when it may go: the pools more than 3% under a reference the veto
 * can go by; or no such reference, or no quote (fail closed). */
export function vetoReason(i: VetoRead): string | undefined {
  const r = i.reference;
  const closed = (why: string) => `the outside price can't be checked right now (${why}): ${CLOSED}`;
  if (!r) return closed("the monitor gave no reference price");
  if (!("usd" in r)) return closed(`the reference is unavailable: ${r.unavailable}`);
  const reference = referenceUsdc(r, i.nowMs);
  if (reference === undefined) {
    const age = Math.round((i.nowMs / 1000 - r.at) / 60);
    return closed(age >= 0 ? `the reference is ${age} minutes old, older than ${REFERENCE_MAX_AGE_S / 60}` : `the reference is dated ${-age} minutes ahead of Base's clock`);
  }
  const pool = i.probeUsdc === undefined ? undefined : saleUsdcPerTao(i.probeUsdc);
  if (pool === undefined) return closed("the pools' price for 0.5 TAO could not be read");
  if (!saleOffMarket(pool, reference)) return undefined;
  return `the pools pay ${usd(pool)} a TAO (0.5 TAO along the delivery route), more than 3% under the outside price of ${usd(reference)} (${r.sources} source${r.sources === 1 ? "" : "s"}): it waits, tried again each round (the outside-price veto; never a strike)`;
}
