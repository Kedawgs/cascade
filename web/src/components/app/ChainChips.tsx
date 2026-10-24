"use client";

import { SOURCE_CHAINS } from "@/lib/cascade/chains";
import type { SourceChain } from "@/lib/cascade/types";
import styles from "./StakeForm.module.css";

/**
 * The "Deposit from" row. Live chains are pressable; "Soon" chains are shown but
 * cannot be picked. `readOnly` renders plain chips for the landing page.
 */
export function ChainChips({
  value,
  onChange,
  readOnly = false,
}: {
  value: SourceChain;
  onChange?: (chain: SourceChain) => void;
  readOnly?: boolean;
}) {
  return (
    <div className={styles.chips} role={readOnly ? undefined : "group"} aria-label="Deposit from">
      {SOURCE_CHAINS.map((c) => {
        const soon = c.status === "soon";
        const selected = !readOnly && c.id === value;
        const className = `${styles.chip} ${soon ? styles.soon : ""} ${selected ? styles.on : ""}`;
        const inner = (
          <>
            <span className={styles.dot} style={{ background: c.color }} aria-hidden="true">
              {c.label[0]}
            </span>
            {c.label}
            {soon && <span className={styles.soonTag}>Soon</span>}
          </>
        );
        if (readOnly) {
          return (
            <span key={c.id} className={className}>
              {inner}
            </span>
          );
        }
        return (
          <button
            key={c.id}
            type="button"
            className={className}
            aria-pressed={soon ? undefined : selected}
            disabled={soon}
            title={soon ? `${c.label} is coming soon` : undefined}
            onClick={() => onChange?.(c.id)}
          >
            {inner}
          </button>
        );
      })}
    </div>
  );
}
