"use client";

import { useProof, useProtocolStats } from "@/lib/cascade/hooks";
import { statRows } from "@/lib/stats";
import { ReceiptLink } from "../ReceiptLink";
import { SampleTag } from "../SampleTag";
import styles from "./App.module.css";

export const APR_FOOTNOTE =
  "*APR is an estimate based on recent rewards. It is not guaranteed and changes with network conditions.";

/** Protocol-wide figures. Rows with no value are left out; sample figures are tagged. */
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
                <SampleTag />
              </span>
            </div>
          ))
        )}
      </div>
      <p className={styles.footnote}>{APR_FOOTNOTE}</p>
    </section>
  );
}

function StatsWithProof({ account }: { account: string }) {
  const proof = useProof(account);
  return <StatsCard explorerUrl={proof.data?.explorerUrl} />;
}

/** The statistics card with the "View on Bittensor" link when an account has a proof. */
export function StatsCardForAccount({ account }: { account: string | null }) {
  return account ? <StatsWithProof account={account} /> : <StatsCard />;
}
