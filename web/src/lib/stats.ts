import type { ProtocolStats } from "./cascade/types";
import { formatTao, formatUsd } from "./format";

export interface StatRow {
  /** Which figure it is: the APY comes from its own read, the others from the protocol figures. */
  key: "apy" | "staked" | "price";
  label: string;
  /** Undefined while it loads, or when it can't be shown: the row stays, with "–". */
  value?: string;
  /** Yield figures are shown in the water colour. */
  accent?: boolean;
}

const DAY_MS = 86_400_000;

/** How long the APY stays on screen once its live reads fail: a 30-day figure is still fair at two weeks. */
export const APY_KEEP_MS = 14 * DAY_MS;
/** How long the protocol figures (the TAO price above all) stay on screen once their live reads fail. */
export const STATS_KEEP_MS = 60 * 60_000;

/** What the APY figure is, wherever it's shown. */
export const APY_FOOTNOTE =
  "*Yield in TAO from root staking with Cascade's validator over the last 30 days, after the validator's take and Cascade's cut, assuming rewards are collected and restaked monthly (they may be collected less often). Before deposit and withdrawal costs; its dollar value moves with TAO's price, and it isn't guaranteed.";

/** The home page's short version: the rest (monthly collection, deposit and withdrawal costs, the
 * dollar value) is in the FAQ's answer it links to, and under the figure on the stake page. */
export const APY_NOTE_SHORT = "*Last 30 days' yield in TAO, after staking fees. Not guaranteed.";

/** 5.3649 -> "5.4%" */
export function formatApy(apyPercent: number): string {
  return `${apyPercent.toFixed(1)}%`;
}

/** The parts of a live query a figure on screen depends on. */
export interface LiveFigure<T> {
  data: T | undefined;
  isError: boolean;
  dataUpdatedAt: number;
}

/** What a live figure shows: the value it has, kept through a failed read unless it is older than
 * `keepMs` (then nothing, and its place shows "–"). The clock is read only once a read has failed,
 * never during the first render, so the server's markup and the hydrating browser's match. */
export function shownFigure<T>(q: LiveFigure<T>, keepMs: number, now: () => number = Date.now): T | undefined {
  if (q.data === undefined || !q.isError) return q.data;
  return now() - q.dataUpdatedAt > keepMs ? undefined : q.data;
}

/** The TAO staked through Cascade, in dollars at the TAO price, when both are known. */
export function totalStakedUsd(stats: ProtocolStats | undefined): number | undefined {
  return stats?.totalStakedTao !== undefined && stats.taoPriceUsd !== undefined ? stats.totalStakedTao * stats.taoPriceUsd : undefined;
}

/** Rows for the statistics card, in display order. Every row is always there, so the card keeps its
 * size from the first render; a value not known (yet) is left undefined. */
export function statRows(stats: ProtocolStats | undefined, apyPercent?: number): StatRow[] {
  const staked = stats?.totalStakedTao;
  const price = stats?.taoPriceUsd;
  return [
    { key: "apy", label: "Annual percentage yield, in TAO*", value: apyPercent !== undefined ? formatApy(apyPercent) : undefined, accent: true },
    { key: "staked", label: "Total staked through Cascade", value: staked !== undefined ? `${formatTao(staked, staked < 10 ? 4 : 0)} TAO` : undefined },
    { key: "price", label: "TAO price", value: price !== undefined ? formatUsd(price) : undefined },
  ];
}
