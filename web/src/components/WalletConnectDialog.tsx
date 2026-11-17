"use client";

import { type RefObject, useEffect, useId, useRef, useState } from "react";
import type { QrPath } from "@/lib/qr-path";
import {
  PAIRING_COPIED,
  PAIRING_COPY,
  PAIRING_COPY_FAILED,
  PAIRING_LINK_NOTE,
  PAIRING_OPEN,
  PAIRING_PREPARING,
  PAIRING_QR_LABEL,
  PAIRING_SCAN,
  PAIRING_SCAN_PHONE,
  PAIRING_TITLE,
  pairingFailureCopy,
} from "@/lib/walletconnect";
import type { PairingView } from "@/lib/walletconnect-pairing";
import styles from "./WalletConnectDialog.module.css";

/** What came of Copy link: nothing yet, copied, or the browser refused (the link is then shown to copy by hand). */
export type CopyState = "idle" | "copied" | "failed";

/** The dialog's markup for a pairing's state: the QR code, drawn here from the link (`qr`, or null while its drawing
 * code loads), Copy link, and on a phone "Open in wallet"; or why it failed, with a way to try again. */
export function WalletConnectDialogView({
  view,
  qr,
  copy = "idle",
  onCopy,
  onRetry,
  onClose,
  dialogRef,
}: {
  view: PairingView;
  qr: QrPath | null;
  copy?: CopyState;
  onCopy: () => void;
  onRetry: () => void;
  onClose: () => void;
  dialogRef?: RefObject<HTMLDialogElement | null>;
}) {
  const titleId = useId();
  const statusId = useId();
  const failedId = useId();
  const failed = view.phase === "failed" ? pairingFailureCopy(view.failure) : null;
  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={failed ? failedId : statusId}
      onClose={onClose}
      // a click on the backdrop lands on the dialog itself (its body fills it): that closes it too
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {view.phase !== "closed" && (
        <div className={styles.body}>
          <div className={styles.head}>
            <h2 id={titleId} className={styles.title}>
              {PAIRING_TITLE}
            </h2>
            <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
              <span aria-hidden="true">×</span>
            </button>
          </div>
          {/* always there, so a screen reader hears each change: getting the code, then what to do with it. A phone
              can't scan its own screen, so where a finger points it reads the other sentence (the stylesheet). */}
          <p id={statusId} role="status" className={styles.note}>
            {view.phase === "preparing" && PAIRING_PREPARING}
            {view.phase === "scan" && (
              <>
                <span className={styles.byScan}>{PAIRING_SCAN}</span>
                <span className={styles.byLink}>{PAIRING_SCAN_PHONE}</span>
              </>
            )}
          </p>
          {view.phase === "scan" && (
            <>
              <div className={styles.qr}>
                {qr ? (
                  <svg className={styles.code} role="img" aria-label={PAIRING_QR_LABEL} viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges">
                    <rect width={qr.size} height={qr.size} fill="#fff" />
                    <path d={qr.d} fill="#10212b" />
                  </svg>
                ) : (
                  <span className={styles.drawing} aria-hidden="true" />
                )}
              </div>
              <div className={styles.actions}>
                {/* the link opens the wallet's app on a phone; hidden where a mouse points (the stylesheet) */}
                <a className={`pill pill-block ${styles.open}`} href={view.uri}>
                  {PAIRING_OPEN}
                </a>
                <button type="button" className="pill pill-ghost pill-block" onClick={onCopy}>
                  {PAIRING_COPY}
                </button>
              </div>
              <p role="status" className={styles.copied}>
                {copy === "copied" ? PAIRING_COPIED : copy === "failed" ? PAIRING_COPY_FAILED : ""}
              </p>
              {copy === "failed" && <input className={styles.link} readOnly aria-label="Connection link" value={view.uri} onFocus={(e) => e.currentTarget.select()} />}
              <p className={styles.fine}>{PAIRING_LINK_NOTE}</p>
            </>
          )}
          {failed && (
            <>
              <p id={failedId} role="alert" className={styles.failed}>
                {failed.message}
              </p>
              <div className={styles.actions}>
                <button type="button" className="pill pill-block" onClick={onRetry}>
                  {failed.retry}
                </button>
                <button type="button" className="pill pill-ghost pill-block" onClick={onClose}>
                  Close
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </dialog>
  );
}

/** WalletConnect's dialog, the site's own: a native modal dialog (the page behind it is inert while it is open, focus
 * stays inside, Esc closes it, and focus goes back to the option that opened it). Open while `view` isn't closed;
 * `onClose` hears it close. The QR code's drawing code is loaded when the first link arrives. */
export function WalletConnectDialog({ view, onRetry, onClose }: { view: PairingView; onRetry: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const uri = view.phase === "scan" ? view.uri : null;
  // each is kept with the link it belongs to, so a new link never shows the last one's code or its "copied"
  const [drawn, setDrawn] = useState<{ uri: string; qr: QrPath } | null>(null);
  const [copied, setCopied] = useState<{ uri: string; state: CopyState } | null>(null);
  const open = view.phase !== "closed";

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!uri) return;
    let current = true;
    void import("@/lib/qr-path").then(
      (m) => {
        if (current) setDrawn({ uri, qr: m.qrPath(uri) });
      },
      // the drawing code didn't load: the link is shown to copy by hand
      () => {
        if (current) setCopied({ uri, state: "failed" });
      },
    );
    return () => {
      current = false;
    };
  }, [uri]);

  const copyLink = () => {
    if (!uri) return;
    const done = (state: CopyState) => () => setCopied({ uri, state });
    try {
      void navigator.clipboard.writeText(uri).then(done("copied"), done("failed"));
    } catch {
      done("failed")();
    }
  };

  return (
    <WalletConnectDialogView
      view={view}
      qr={drawn && drawn.uri === uri ? drawn.qr : null}
      copy={copied && copied.uri === uri ? copied.state : "idle"}
      onCopy={copyLink}
      onRetry={onRetry}
      onClose={onClose}
      dialogRef={ref}
    />
  );
}
