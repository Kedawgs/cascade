import type { PriceSource, Tokens } from "./config.ts";
import type { BaseState } from "./snapshot.ts";

// The TAO price the market rules compare against (spec 6.1 fmtao.depeg): a reference from public price APIs,
// read every fifth minute, and our own spot price from the two Uniswap pools on Base, read every tick. The
// reference's newest reading is also stored for the site's outside-price check, a veto only (below).

export const PRICE_URLS: Readonly<Record<PriceSource, string>> = {
  coingecko: "https://api.coingecko.com/api/v3/simple/price?ids=bittensor&vs_currencies=usd",
  coinbase: "https://api.coinbase.com/v2/prices/TAO-USD/spot",
};

/** The sources may differ by this much before the reference is called unavailable. */
const AGREE = 0.02;

const usdOf = (s: PriceSource, j: unknown): number | undefined => {
  const n =
    s === "coingecko"
      ? (j as { bittensor?: { usd?: unknown } } | null)?.bittensor?.usd
      : Number((j as { data?: { amount?: unknown } } | null)?.data?.amount);
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
};

/** A reference price, with how many sources agreed on it (one alone needs a longer confirmation). */
export type Reference = { usd: number; sources?: number } | { unavailable: string };
/** What referencePrice answers: a Reference that always says how many sources agreed. When the sources disagree,
 * `answers` holds their prices for the tick's log line only: the reason is stored and served, so it carries none. */
export type ReferenceRead = { usd: number; sources: number } | { unavailable: string; answers?: number[] };

/** The median of the configured sources that answer; unavailable when none is configured, none answers, or
 * they disagree by more than 2%. A source that fails is left out (it costs one subrequest). */
export async function referencePrice(o: { getJson: (url: string) => Promise<unknown>; sources: readonly PriceSource[] }): Promise<ReferenceRead> {
  if (o.sources.length === 0) return { unavailable: "no price source is configured" };
  const answers = await Promise.all(
    o.sources.map(async (s) => {
      try {
        return usdOf(s, await o.getJson(PRICE_URLS[s]));
      } catch {
        return undefined;
      }
    }),
  );
  const ok = answers.filter((x): x is number => x !== undefined).sort((a, b) => a - b);
  if (ok.length === 0) return { unavailable: "no price source answered" };
  if (ok[ok.length - 1] / ok[0] - 1 > AGREE) return { unavailable: "the price sources disagree by more than 2%", answers: ok };
  const mid = Math.floor(ok.length / 2);
  return { usd: ok.length % 2 ? ok[mid] : (ok[mid - 1] + ok[mid]) / 2, sources: ok.length };
}

// The stored reading, for the site's outside-price check (GET /v1/price, src/api.ts handlePrice). A VETO ONLY: the
// site may refuse a stake or a USDC delivery request when the Base pools' TAO price is too far from it, never
// approve or loosen a trade with it, and never trade at it. The contracts' floors stay the binding limits, so a
// wrong or forged figure here can only make a trade wait. Nothing is signed.

/** The meta key holding the newest reading: one row, overwritten by each tick that asks the sources. */
export const REFERENCE_KEY = "reference";

/** A reading as stored and served: the price and how many sources agreed on it, or why there is none, with `at`,
 * when the indexer asked the sources (unix s). Never a 0, and never a time other than the reading's own. */
export type ReferenceReading = { usd: number; sources: number; at: number } | { unavailable: string; at: number };

/** The reading the tick stores for an answer of referencePrice asked at `at` (never the sources' answers). */
export const referenceReading = (r: ReferenceRead, at: number): ReferenceReading =>
  "usd" in r ? { usd: r.usd, sources: r.sources, at } : { unavailable: r.unavailable, at };

const positiveInt = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;

/** A stored reading, checked field by field; undefined unless it is exactly one of the two shapes (a price that is
 * a positive finite number with a positive whole count of sources, or a reason that isn't empty, never both, and a
 * positive whole time), so a damaged row is never served as a price. */
export function parseReferenceReading(s: string): ReferenceReading | undefined {
  let j: unknown;
  try {
    j = JSON.parse(s);
  } catch {
    return undefined;
  }
  if (j === null || typeof j !== "object" || Array.isArray(j)) return undefined;
  const o = j as Record<string, unknown>;
  if (!positiveInt(o.at)) return undefined;
  if ("usd" in o) {
    if ("unavailable" in o || typeof o.usd !== "number" || !Number.isFinite(o.usd) || o.usd <= 0 || !positiveInt(o.sources)) return undefined;
    return { usd: o.usd, sources: o.sources, at: o.at };
  }
  return typeof o.unavailable === "string" && o.unavailable !== "" ? { unavailable: o.unavailable, at: o.at } : undefined;
}

const Q96 = 2 ** 96;
/** A pool's price of token1 in token0, in whole tokens. */
const price1Per0 = (sqrtPriceX96: bigint, dec0: number, dec1: number) => (Number(sqrtPriceX96) / Q96) ** 2 * 10 ** (dec0 - dec1);

/** TAO in USD from the TAO/WETH pool and the WETH/USDC pool (FM-TAO and WETH have 18 decimals, USDC 6);
 * undefined while either pool's reading is missing. */
export function poolPriceUsd(s: Pick<BaseState, "taoWethPool" | "wethUsdcPool">, tokens: Pick<Tokens, "base">): number | undefined {
  const a = s.taoWethPool;
  const b = s.wethUsdcPool;
  if (!a.sqrtPriceX96 || !a.token0 || !b.sqrtPriceX96 || !b.token0) return undefined;
  const taoFirst = a.token0.toLowerCase() === tokens.base.fmTao.toLowerCase();
  const p = price1Per0(a.sqrtPriceX96, 18, 18);
  const taoInWeth = taoFirst ? p : 1 / p;
  const wethFirst = b.token0.toLowerCase() === tokens.base.weth.toLowerCase();
  const q = wethFirst ? price1Per0(b.sqrtPriceX96, 18, 6) : 1 / price1Per0(b.sqrtPriceX96, 6, 18);
  const usd = taoInWeth * q;
  return Number.isFinite(usd) && usd > 0 ? usd : undefined;
}
