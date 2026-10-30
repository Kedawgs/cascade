"use client";

import type { Ref } from "react";
import type { SourceChainInfo } from "@/lib/cascade/chains";
import { sanitizeAmountInput } from "@/lib/format";
import styles from "./StakeForm.module.css";

/** Token on the left, the number in the middle, MAX on the right (when there is a max). With
 * `onToggleUnit` the token is a button that switches the unit. With `chain`, a USDC amount says which
 * chain it's on (a badge on the coin and "on Base" under the name). */
export function AmountField({
  id,
  value,
  onChange,
  unit,
  decimals,
  onMax,
  maxDisabled = false,
  invalid = false,
  describedBy,
  onToggleUnit,
  toggleLabel,
  chain,
  inputRef,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  unit: "USDC" | "TAO";
  decimals: number;
  onMax?: () => void;
  maxDisabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  onToggleUnit?: () => void;
  toggleLabel?: string;
  chain?: SourceChainInfo;
  /** The input itself, for focus to come back to (after the panel that confirms a send). */
  inputRef?: Ref<HTMLInputElement>;
}) {
  const on = unit === "USDC" ? chain : undefined;
  const token = (
    <>
      <span className={`${styles.coin} ${unit === "USDC" ? styles.usdc : styles.tao}`} aria-hidden="true">
        {unit === "USDC" ? "$" : "τ"}
        {on && <span className={styles.chainBadge} style={{ background: on.color }} />}
      </span>
      {on ? (
        <span className={styles.tokName}>
          {unit}
          <small>on {on.label}</small>
        </span>
      ) : (
        unit
      )}
    </>
  );
  return (
    <div className={styles.amount} data-invalid={invalid ? "true" : undefined}>
      {onToggleUnit ? (
        <button type="button" className={`${styles.tok} ${styles.tokSwitch}`} onClick={onToggleUnit} aria-label={toggleLabel ? `${unit}: ${toggleLabel}` : undefined} title={toggleLabel}>
          {token}
          <span className={styles.swap} aria-hidden="true">
            ⇅
          </span>
        </button>
      ) : (
        <span className={styles.tok}>{token}</span>
      )}
      <input
        ref={inputRef}
        id={id}
        className={styles.input}
        inputMode="decimal"
        autoComplete="off"
        placeholder={`${unit} amount`}
        value={value}
        onChange={(e) => onChange(sanitizeAmountInput(e.target.value, decimals))}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      />
      {onMax && (
        <button type="button" className={styles.max} onClick={onMax} disabled={maxDisabled}>
          MAX
        </button>
      )}
    </div>
  );
}
