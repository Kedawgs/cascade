import { formatTao, formatUsd } from "./format";

/** The protocol figures a card or the home page shows together: the total staked (read on Bittensor) and the TAO price
 * (read on Base), each from its own read, either of them missing while it isn't known. */
export interface ShownStats {
  totalStakedTao?: number;
  taoPriceUsd?: number;
}

export interface StatRow {
  /** Which figure it is: the APY, the total staked and the TAO price each come from their own read. */
  key: "apy" | "staked" | "price";
  label: string;
  /** Undefined while it loads, or when it can't be shown: the row stays, with a skeleton or "–" in the figure's place. */
  amount?: number;
  /** The figure as text ("5.4%", "12,480 TAO", "$286.00"): the same function on every render, so a figure that changes
   * can count to its new value in the same form (components/Figure.tsx). */
  format: (n: number) => string;
  /** Yield figures are shown in the water colour. */
  accent?: boolean;
}

const DAY_MS = 86_400_000;

/** How long the APY stays on screen once its live reads fail: a 30-day figure is still fair at two weeks. Also how long
 * a browser shows the one it remembers from an earlier visit while this visit's is read (remembered.ts). */
export const APY_KEEP_MS = 14 * DAY_MS;
/** How long the protocol figures (the TAO price above all) stay on screen once their live reads fail, and how long a
 * browser shows the ones it remembers from an earlier visit. */
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

/** 12480 -> "12,480 TAO"; under 10 TAO to four places: 0.5 -> "0.5000 TAO" */
export function formatStakedTao(tao: number): string {
  return `${formatTao(tao, tao < 10 ? 4 : 0)} TAO`;
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

/** A figure with what this browser remembers of it (remembered.ts), as a live figure for shownFigure to judge.
 * - What the query holds as this visit's own reading always stands: nothing remembered ever takes its place, whatever
 *   its date (a reading that answered late, after the query had moved on to a newer read, may be dated after it).
 * - While the query holds only the first HTML's snapshot (dated exactly `snapshotAt`, when the snapshot was read; 0 with
 *   none), the newer of the two shows: the remembered reading when it was read after the build, else the snapshot's.
 * - While the query holds nothing, the remembered reading shows.
 * So a returning visitor sees the last real reading at once, and this visit's own replaces it when it arrives. A
 * remembered reading is given only while it is within its window (the store drops an older one), and after a failed
 * read shownFigure holds it to the same window again. */
export function withRemembered<T>(q: LiveFigure<T>, remembered: { value: T; at: number } | undefined, snapshotAt: number): LiveFigure<T> {
  if (remembered === undefined) return q;
  if (q.data !== undefined) {
    const own = snapshotAt === 0 || q.dataUpdatedAt !== snapshotAt;
    if (own || q.dataUpdatedAt >= remembered.at) return q;
  }
  return { data: remembered.value, isError: q.isError, dataUpdatedAt: remembered.at };
}

/** A figure only as this visit read it: nothing while the query still holds the server's snapshot (dated exactly when
 * the snapshot was read, `snapshotAt`; 0 with none). "No later than" would also catch the browser's own reads when its
 * clock is behind the build machine's. */
export function liveOnly<T>(q: LiveFigure<T>, snapshotAt: number): LiveFigure<T> {
  return snapshotAt !== 0 && q.dataUpdatedAt === snapshotAt ? { data: undefined, isError: q.isError, dataUpdatedAt: 0 } : q;
}

/** The TAO staked through Cascade, in dollars at the TAO price, when both are known. */
export function totalStakedUsd(stats: ShownStats | undefined): number | undefined {
  return stats?.totalStakedTao !== undefined && stats.taoPriceUsd !== undefined ? stats.totalStakedTao * stats.taoPriceUsd : undefined;
}

/** The home page's "Total staked", in dollars: the TAO staked at the TAO price, each the newest reading there is (the
 * first HTML's snapshot, one remembered from an earlier visit, or this visit's own).
 * - `place`: whether the figure has its place on the page. It has one from a dollar up, decided by the figures there
 *   are, whatever their age; and while they aren't known yet, so the Stake button beside it never moves when they
 *   arrive. Only figures that say there is under a dollar staked take the place away.
 * - `usd`: the value to show in it, each part kept through a failed read for STATS_KEEP_MS and no longer; undefined
 *   leaves "–" in the place.
 * - `loading`: with nothing to show, whether a read may still bring it (neither has failed). */
export function heroTotal(
  staked: LiveFigure<number>,
  price: LiveFigure<number>,
  now: () => number = Date.now,
): { place: boolean; usd: number | undefined; loading: boolean } {
  const known = totalStakedUsd({ totalStakedTao: staked.data, taoPriceUsd: price.data });
  return {
    place: staked.data !== 0 && (known === undefined || known >= 1),
    usd: totalStakedUsd({ totalStakedTao: shownFigure(staked, STATS_KEEP_MS, now), taoPriceUsd: shownFigure(price, STATS_KEEP_MS, now) }),
    loading: !staked.isError && !price.isError,
  };
}

/** Rows for the statistics card, in display order. Every row is always there, so the card keeps its
 * size from the first render; a value not known (yet) is left undefined. */
export function statRows(stats: ShownStats | undefined, apyPercent?: number): StatRow[] {
  return [
    { key: "apy", label: "Annual percentage yield, in TAO*", amount: apyPercent, format: formatApy, accent: true },
    { key: "staked", label: "Total staked through Cascade", amount: stats?.totalStakedTao, format: formatStakedTao },
    { key: "price", label: "TAO price", amount: stats?.taoPriceUsd, format: formatUsd },
  ];
}

/** A row's value as text, or undefined where the row shows "–". */
export const rowText = (row: StatRow): string | undefined => (row.amount !== undefined ? row.format(row.amount) : undefined);
