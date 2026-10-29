import type { PriceSource, Tokens } from "./config.ts";
import type { BaseState } from "./snapshot.ts";

// The TAO price the market rules compare against (spec 6.1 fmtao.depeg): a reference from public price APIs,
// read every fifth minute, and our own spot price from the two Uniswap pools on Base, read every tick.

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

export type Reference = { usd: number } | { unavailable: string };

/** The median of the configured sources that answer; unavailable when none is configured, none answers, or
 * they disagree by more than 2%. A source that fails is left out (it costs one subrequest). */
export async function referencePrice(o: { getJson: (url: string) => Promise<unknown>; sources: readonly PriceSource[] }): Promise<Reference> {
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
  if (ok[ok.length - 1] / ok[0] - 1 > AGREE) return { unavailable: `the price sources disagree (${ok.map((x) => x.toFixed(2)).join(", ")} USD)` };
  const mid = Math.floor(ok.length / 2);
  return { usd: ok.length % 2 ? ok[mid] : (ok[mid - 1] + ok[mid]) / 2 };
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
