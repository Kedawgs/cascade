import type { ProtocolStats } from "./cascade/types";
import { formatTao, formatUsd } from "./format";

export interface StatRow {
  label: string;
  value: string;
  /** Yield figures are shown in the water colour. */
  accent?: boolean;
}

const count = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** What the APY figure is, wherever it's shown. */
export const APY_FOOTNOTE =
  "*Yield in TAO from root staking with Cascade's validator over the last 30 days, after the validator's take and Cascade's cut, assuming rewards are collected and restaked monthly (they may be collected less often). Before deposit and withdrawal costs; its dollar value moves with TAO's price, and it isn't guaranteed.";

/** 5.3649 -> "5.4%" */
export function formatApy(apyPercent: number): string {
  return `${apyPercent.toFixed(1)}%`;
}

/** Rows for the statistics card, in display order. A missing value drops its row. */
export function statRows(stats: ProtocolStats, apyPercent?: number): StatRow[] {
  const rows: StatRow[] = [];
  if (apyPercent !== undefined) {
    rows.push({ label: "Annual percentage yield, in TAO*", value: formatApy(apyPercent), accent: true });
  }
  if (stats.totalStakedTao !== undefined) {
    rows.push({ label: "Total staked through Cascade", value: `${formatTao(stats.totalStakedTao, stats.totalStakedTao < 10 ? 4 : 0)} TAO` });
  }
  if (stats.stakers !== undefined) {
    rows.push({ label: "Stakers", value: count.format(stats.stakers) });
  }
  if (stats.taoPriceUsd !== undefined) {
    rows.push({ label: "TAO price", value: formatUsd(stats.taoPriceUsd) });
  }
  return rows;
}
