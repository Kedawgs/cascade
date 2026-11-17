"use client";

import { type ReactNode, useState } from "react";
import type { Address } from "viem";
import { useCascadeData } from "@/lib/cascade/context";
import { useBatchMaxWait, useOpenBatch, useRetired } from "@/lib/cascade/hooks";
import type { Operation } from "@/lib/cascade/oplog";
import { useFlows } from "@/lib/cascade/use-flows";
import { useNow } from "@/lib/client-state";
import { closeSentFromHere, sendNowHeldByDeposit, sendNowOffered, type SendNowView, sendNowView } from "@/lib/send-now";
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
 * of the batch is read, or shown, unless `waiting`. The panel after a send stays here, so it outlives the
 * record leaving its batch. `href` is where its "Follow it live" goes. The button sends the batch as shown:
 * its id, and the account's deposit in it (on v3.2 the close names both, flows.ts, sendNowCall).
 *
 * A receipt's own button for the same entry (its cancel) goes in `action`, and sits beside Send it now in
 * one row of two equal pills; its small print in `actionNote`, under the row. Both show whenever they are
 * given, whatever this block itself has to show: while the batch isn't read, while the contracts don't
 * match, on a retired deployment, before Send it now is offered. A way out never waits on this block. */
export function SendItNow({
  account,
  what,
  waiting,
  href,
  action,
  actionNote,
}: {
  account: string;
  what: "deposit" | "unstake";
  waiting: boolean;
  href: string;
  action?: ReactNode;
  actionNote?: ReactNode;
}) {
  const data = useCascadeData();
  const batch = useOpenBatch(account, waiting);
  const maxWaitS = useBatchMaxWait();
  const flows = useFlows(account);
  const retired = useRetired();
  // a countdown in minutes: a re-render of this small box every half minute is plenty
  const now = useNow(30_000);
  const [sent, setSent] = useState<PanelNotice | null>(null);

  const b = batch.data;
  const sending = b ? closeSentFromHere(opsOf(data, account), b.id, now) : undefined;
  // nothing to offer while the contracts don't match (flows.blocked): the ways out stay on the receipt; and on a retired
  // deployment nothing for a batch with the account's deposit in it (Task 60). For its unstake there, when the batch
  // leaves, and in place of sending it, why not and the way to it (its review, Minor 5)
  const held = b ? sendNowHeldByDeposit({ retired, what, depositWei: b.mine.depositWei }) : null;
  const shown =
    waiting && b && !flows.blocked && (held !== null || sendNowOffered({ retired, what, depositWei: b.mine.depositWei }))
      ? sendNowView({ batch: b, maxWaitS, readAt: batch.dataUpdatedAt, now, what, ...(sending ? { sending } : {}) })
      : null;
  // held: only when it leaves, and the line only where it could otherwise be sent (not while Bittensor holds every batch)
  const view: SendNowView | null = shown && held !== null ? { leaves: shown.leaves } : shown;
  const heldLine = shown && held !== null && (shown.yourself !== undefined || shown.button !== undefined) ? held : null;
  const button = view?.button && b ? { ...view.button, batchId: b.id, depositWei: b.mine.depositWei } : null;
  const extra = action != null && action !== false;
  const extraNote = actionNote != null && actionNote !== false;

  return (
    <>
      {(view || extra || extraNote) && (
        <div className={styles.box}>
          {view && <p className={styles.leaves}>{view.leaves}</p>}
          {heldLine && <p className={styles.line}>{heldLine}</p>}
          {view?.yourself && <p className={styles.line}>{view.yourself}</p>}
          {view?.sending && (
            <p className={styles.line}>
              {view.sending.text}{" "}
              <ReceiptLink href={view.sending.txUrl} className={styles.link}>
                View the transaction
              </ReceiptLink>
            </p>
          )}
          {(button || extra) && (
            // one row: Send it now and the receipt's own button, equal in width; either alone fills it
            <div className={styles.row}>
              {button && (
                <button
                  type="button"
                  className="pill pill-ghost"
                  disabled={button.disabled || flows.locked}
                  onClick={() => void flows.sendNow(button.batchId, button.depositWei).then((r) => setSent(batchNotice(href, r)), () => undefined)}
                >
                  {flows.busy === "send" ? "Confirm in your wallet…" : button.label}
                </button>
              )}
              {extra && action}
            </div>
          )}
          {button && <p className={styles.note}>{button.note}</p>}
          {button?.warning && <p className={styles.warning}>{button.warning}</p>}
          {view && flows.error && (
            <p role="alert" className={styles.error}>
              {flows.error}
            </p>
          )}
          {extraNote && <div className={styles.notes}>{actionNote}</div>}
        </div>
      )}
      <SentDialog notice={sent} onClose={() => setSent(null)} />
    </>
  );
}

/** In the block's place on a receipt, when its entry is no longer waiting to leave or to be cancelled: what became of
 * it, in the block's own bold, a plain line under it when there is more to say, and its transaction. Told to a screen
 * reader as it appears. */
export function BlockNotice({ lead, text, txUrl }: { lead: string; text?: string; txUrl: string }) {
  return (
    <div className={styles.box} role="status">
      <p className={styles.leaves}>{lead}</p>
      <p className={styles.line}>
        {text && <>{text} </>}
        <ReceiptLink href={txUrl} className={styles.link}>
          View the transaction
        </ReceiptLink>
      </p>
    </div>
  );
}
