"use client";

import { nextBatchLine } from "@/lib/batch-clock";
import { useBatchMaxWait, useNextBatch } from "@/lib/cascade/hooks";
import { useNow } from "@/lib/client-state";
import styles from "./App.module.css";

/** The Stake page's public line, wallet or not: when the open batch leaves at the latest and what waits
 * in it, "Next batch leaves within 3 h 12 min · 1 depositor waiting", counting down on Base's clock. One
 * multicall on Base every 30 s; "–" until it is read, and whenever the read fails or goes stale. */
export function NextBatchLine() {
  const batch = useNextBatch();
  const maxWaitS = useBatchMaxWait();
  // minutes are all it shows: a re-render of this one line every half minute
  const now = useNow(30_000);
  return <p className={styles.nextBatch}>{nextBatchLine(batch.data, { readAt: batch.dataUpdatedAt, now, maxWaitS })}</p>;
}
