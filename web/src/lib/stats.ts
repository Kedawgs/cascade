import type { ProtocolStats } from "./cascade/types";
import { formatTao, formatUsd } from "./format";

export interface StatRow {
  label: string;
  value: string;
  /** Yield figures are shown in the water colour. */
  accent?: boolean;
}

const count = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** 11.4 -> "11.4%" */
export function formatApr(aprPercent: number): string {
  return `${aprPercent.toFixed(1)}%`;
}

/** Rows for the statistics card, in display order. A missing value drops its row. */
export function statRows(stats: ProtocolStats): StatRow[] {
  const rows: StatRow[] = [];
  if (stats.aprPercent !== undefined) {
    rows.push({ label: "Annual percentage rate*", value: formatApr(stats.aprPercent), accent: true });
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
