"use client";

import { useProof, useProtocolStats } from "@/lib/cascade/hooks";
import { statRows } from "@/lib/stats";
import { ReceiptLink } from "../ReceiptLink";
import styles from "./App.module.css";

export const APR_FOOTNOTE =
  "*APR is an estimate based on recent rewards. It is not guaranteed and changes with network conditions.";

/** Protocol-wide figures, read from the chains. Rows with no value are left out. */
export function StatsCard({ explorerUrl }: { explorerUrl?: string }) {
  const stats = useProtocolStats();
  const rows = stats.data ? statRows(stats.data) : [];
  if (stats.data && rows.length === 0) return null;

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
        {stats.isError ? (
          <div>
            <span>Statistics are unavailable right now.</span>
            <span>–</span>
          </div>
        ) : !stats.data ? (
          <div>
            <span>Loading statistics</span>
            <span>–</span>
          </div>
        ) : (
          rows.map((row) => (
            <div key={row.label}>
              <span>{row.label}</span>
              <span className={row.accent ? styles.accent : undefined}>
                {row.value}
              </span>
            </div>
          ))
        )}
      </div>
      {stats.data?.aprPercent !== undefined && <p className={styles.footnote}>{APR_FOOTNOTE}</p>}
    </section>
  );
}

/** The statistics card with the "View on Bittensor" link to the vault's stake. */
export function StatsCardForAccount() {
  const proof = useProof();
  return <StatsCard explorerUrl={proof.data?.explorerUrl} />;
}
