"use client";

import Link from "next/link";
import { useEffect, useId, useRef } from "react";
import { useCascadeData } from "@/lib/cascade/context";
import { useIsV3 } from "@/lib/cascade/hooks";
import { sentCopy, type SentNotice, sentTiming, type SentTiming } from "@/lib/sent";
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

/** Confirms a deposit or unstake that has just gone through, in place of a jump to Activity: what was
 * sent, what happens next, and its receipt trail to follow. A native modal dialog: the page behind it is
 * inert while it is open (focus stays inside), Esc closes it, and its title names it. Open while `notice`
 * is set; `onClose` hears it close (Done, Esc, the backdrop, or following it to Activity). */
export function SentDialog({ notice, onClose }: { notice: SentNotice | null; onClose: () => void }) {
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
      onClose={onClose}
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
          <dl className={styles.rows}>
            {copy.rows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
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
