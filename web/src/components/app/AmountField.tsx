"use client";

import { sanitizeAmountInput } from "@/lib/format";
import styles from "./StakeForm.module.css";

/** Token on the left, the number in the middle, MAX on the right (when there is a max). */
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
}) {
  return (
    <div className={styles.amount} data-invalid={invalid ? "true" : undefined}>
      <span className={styles.tok}>
        <span
          className={`${styles.coin} ${unit === "USDC" ? styles.usdc : styles.tao}`}
          aria-hidden="true"
        >
          {unit === "USDC" ? "$" : "τ"}
        </span>
        {unit}
      </span>
      <input
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
