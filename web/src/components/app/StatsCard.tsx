"use client";

import { useApy, useProof, useProtocolStats, useTaoPrice } from "@/lib/cascade/hooks";
import { APY_FOOTNOTE, APY_KEEP_MS, shownFigure, type StatRow, statRows, STATS_KEEP_MS } from "@/lib/stats";
import { Dash } from "../Dash";
import { ReceiptLink } from "../ReceiptLink";
import styles from "./App.module.css";

/** Protocol-wide figures, read from the chains. The same rows from the first render on (loading,
 * loaded or failed), with "–" for a value there is none of, so the page below never moves. */
export function StatsCard({ explorerUrl }: { explorerUrl?: string }) {
  const stats = useProtocolStats();
  const apy = useApy();
  const shown = shownFigure(stats, STATS_KEEP_MS);
  // the total may still be the server's snapshot; the TAO price only ever a live read's (see useTaoPrice)
  const price = useTaoPrice();
  const rows = statRows(shown && { ...shown, taoPriceUsd: price }, shownFigure(apy, APY_KEEP_MS));
  const loading = (key: StatRow["key"]) => (key === "apy" ? apy.isPending : key === "price" ? !stats.isError : stats.isPending);

  return (
    <section aria-labelledby="stats-heading" className={styles.section}>
      <div className={styles.secHead}>
        <h2 id="stats-heading">Cascade statistics</h2>
        {explorerUrl && (
          <ReceiptLink href={explorerUrl} className={styles.secLink}>
            View on Bittensor
          </ReceiptLink>
        )}
      </div>
      <div className={`${styles.card} ${styles.cardRows}`}>
        {rows.map((row) => (
          <div key={row.key}>
            <span>{row.label}</span>
            <span className={row.accent ? styles.accent : undefined}>
              {row.value ?? <Dash loading={loading(row.key)} />}
            </span>
          </div>
        ))}
      </div>
      <p className={styles.footnote}>{APY_FOOTNOTE}</p>
    </section>
  );
}

/** The statistics card with the "View on Bittensor" link to the vault's stake. */
export function StatsCardForAccount() {
  const proof = useProof();
  return <StatsCard explorerUrl={proof.data?.explorerUrl} />;
}
