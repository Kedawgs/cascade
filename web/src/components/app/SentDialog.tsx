"use client";

import Link from "next/link";
import { type RefObject, useEffect, useId, useRef } from "react";
import { useCascadeData } from "@/lib/cascade/context";
import { useIsV3 } from "@/lib/cascade/hooks";
import { type PanelNotice, sentCopy, sentTiming, type SentTiming } from "@/lib/sent";
import styles from "./SentDialog.module.css";

/** The deployment's timing, or none when the site isn't connected to one. */
function useSentTiming(): SentTiming {
  const data = useCascadeData();
  const v3 = useIsV3();
  try {
    return sentTiming(data.deployment, v3);
  } catch {
    return sentTiming(null, v3);
  }
}

/** What closing the panel does: tells its owner, then puts focus in `field` (the form's amount). The
 * browser would put it back on the button that opened the panel, but that is disabled by then (the form
 * was cleared), so focus would fall to the page. */
export function closedThenFocus(onClose: () => void, field: RefObject<HTMLElement | null> | undefined): () => void {
  return () => {
    onClose();
    field?.current?.focus();
  };
}

/** Confirms a deposit or unstake that has just gone through, in place of a jump to Activity: what was
 * sent, what happens next, and its receipt trail to follow. A native modal dialog: the page behind it is
 * inert while it is open (focus stays inside), Esc closes it, and its title names it. Open while `notice`
 * is set; `onClose` hears it close (Done, Esc, the backdrop, or following it to Activity), after which
 * focus goes to `returnFocus`, the form's amount field. */
export function SentDialog({
  notice,
  onClose,
  returnFocus,
}: {
  notice: PanelNotice | null;
  onClose: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const nextId = useId();
  const timing = useSentTiming();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (notice && !dialog.open) dialog.showModal();
    else if (!notice && dialog.open) dialog.close();
  }, [notice]);

  const copy = notice ? sentCopy(notice, timing) : null;
  const close = () => ref.current?.close();
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={nextId}
      onClose={closedThenFocus(onClose, returnFocus)}
      // a click on the backdrop lands on the dialog itself (its body fills it): that closes it too
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      {copy && (
        <div className={styles.body}>
          <span className={styles.mark} aria-hidden="true">
            ✓
          </span>
          <h2 id={titleId} className={styles.title}>
            {copy.title}
          </h2>
          {copy.rows.length > 0 && (
            <dl className={styles.rows}>
              {copy.rows.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
          <p id={nextId} className={styles.next}>
            {copy.next}
          </p>
          <div className={styles.actions}>
            <Link href={copy.href} className="pill pill-block" onClick={close}>
              Follow it live
            </Link>
            <button type="button" className="pill pill-ghost pill-block" onClick={close}>
              Done
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
