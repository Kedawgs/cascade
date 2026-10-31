"use client";

import { useState } from "react";
import type { Address } from "viem";
import { useCascadeData } from "@/lib/cascade/context";
import { useBatchMaxWait, useOpenBatch } from "@/lib/cascade/hooks";
import type { Operation } from "@/lib/cascade/oplog";
import { useFlows } from "@/lib/cascade/use-flows";
import { useNow } from "@/lib/client-state";
import { closeSentFromHere, sendNowView } from "@/lib/send-now";
import { batchNotice, type PanelNotice } from "@/lib/sent";
import { ReceiptLink } from "../ReceiptLink";
import { SentDialog } from "./SentDialog";
import styles from "./SendItNow.module.css";

/** This browser's records, or none where there is no deployment. */
function opsOf(data: ReturnType<typeof useCascadeData>, account: string): Operation[] {
  try {
    return data.opLog.list(account as Address);
  } catch {
    return [];
  }
}

/** The countdown to when the open batch leaves, for an account with a deposit or unstake (`what`) waiting
 * in it (`waiting`, from its records), and Send it now: until it's offered, when the user can send it;
 * then a button that sends it at once, the user paying its bridge fee (send-now.ts, sendGate). Nothing
 * is read, and nothing shows, unless `waiting`. The panel after a send stays here, so it outlives the
 * record leaving its batch. `href` is where its "Follow it live" goes. */
export function SendItNow({ account, what, waiting, href }: { account: string; what: "deposit" | "unstake"; waiting: boolean; href: string }) {
  const data = useCascadeData();
  const batch = useOpenBatch(account, waiting);
  const maxWaitS = useBatchMaxWait();
  const flows = useFlows(account);
  // a countdown in minutes: a re-render of this small box every half minute is plenty
  const now = useNow(30_000);
  const [sent, setSent] = useState<PanelNotice | null>(null);

  const b = batch.data;
  const sending = b ? closeSentFromHere(opsOf(data, account), b.id, now) : undefined;
  // nothing to offer while the contracts don't match (flows.blocked): the ways out stay on the receipt
  const view =
    waiting && b && !flows.blocked ? sendNowView({ batch: b, maxWaitS, readAt: batch.dataUpdatedAt, now, what, ...(sending ? { sending } : {}) }) : null;

  return (
    <>
      {view && (
        <div className={styles.box}>
          <p className={styles.leaves}>{view.leaves}</p>
          {view.yourself && <p className={styles.line}>{view.yourself}</p>}
          {view.sending && (
            <p className={styles.line}>
              {view.sending.text}{" "}
              <ReceiptLink href={view.sending.txUrl} className={styles.link}>
                View the transaction
              </ReceiptLink>
            </p>
          )}
          {view.button && b && (
            <>
              <button
                type="button"
                className={`pill pill-ghost ${styles.button}`}
                disabled={view.button.disabled || flows.locked}
                onClick={() => void flows.sendNow(b.id).then((r) => setSent(batchNotice(href, r)), () => undefined)}
              >
                {flows.busy === "send" ? "Confirm in your wallet…" : view.button.label}
              </button>
              <p className={styles.note}>{view.button.note}</p>
              {view.button.warning && <p className={styles.warning}>{view.button.warning}</p>}
            </>
          )}
          {flows.error && (
            <p role="alert" className={styles.error}>
              {flows.error}
            </p>
          )}
        </div>
      )}
      <SentDialog notice={sent} onClose={() => setSent(null)} />
    </>
  );
}
