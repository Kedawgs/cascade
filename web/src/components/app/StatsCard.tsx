"use client";

import { useShownApy, useShownStaked, useShownTaoPrice, useVaultExplorerUrl } from "@/lib/cascade/hooks";
import { APY_FOOTNOTE, type StatRow, statRows } from "@/lib/stats";
import { Figure } from "../Figure";
import { ReceiptLink } from "../ReceiptLink";
import styles from "./App.module.css";

/** The room kept for each row's figure, so its label never moves when the figure arrives (App.module.css). */
const ROOM: Record<StatRow["key"], string> = { apy: styles.figApy, staked: styles.figStaked, price: styles.figPrice };

/** Protocol-wide figures, read from the chains. The same rows from the first render on (loading,
 * loaded or failed), with a skeleton for a value still being read and "–" for one there is none of, so the page below
 * never moves. Each figure is the newest real reading there is: the first HTML's snapshot or the one this browser
 * remembers from an earlier visit, then this visit's own, which it counts to when it differs (Figure.tsx). */
export function StatsCard({ explorerUrl }: { explorerUrl?: string }) {
  const apy = useShownApy();
  const staked = useShownStaked();
  // the total may still be the server's snapshot; the TAO price never is (see useShownTaoPrice)
  const price = useShownTaoPrice();
  const rows = statRows({ totalStakedTao: staked.value, taoPriceUsd: price.value }, apy.value);
  const loading: Record<StatRow["key"], boolean> = { apy: apy.loading, staked: staked.loading, price: price.loading };

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
            <span className={row.accent ? `${ROOM[row.key]} ${styles.accent}` : ROOM[row.key]}>
              <Figure value={row.amount} format={row.format} loading={loading[row.key]} />
            </span>
          </div>
        ))}
      </div>
      <p className={styles.footnote}>{APY_FOOTNOTE}</p>
    </section>
  );
}

/** The statistics card with the "View on Bittensor" link to the vault's stake: the link is the deployment's own
 * address, in the first HTML, waiting on no read. */
export function StatsCardForAccount() {
  return <StatsCard explorerUrl={useVaultExplorerUrl()} />;
}
