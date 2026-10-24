"use client";

import styles from "./LoadError.module.css";

/** What a data-backed element shows when its query failed: what happened and a way to retry. */
export function LoadError({ what = "this", onRetry }: { what?: string; onRetry?: () => void }) {
  return (
    <div className={styles.box} role="alert">
      <p className={styles.text}>We couldn&apos;t load {what} just now.</p>
      {onRetry && (
        <button type="button" className="pill pill-ghost" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
