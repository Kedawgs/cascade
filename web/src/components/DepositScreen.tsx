"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { chainInfo } from "@/lib/cascade/chains";
import { useCascadeData } from "@/lib/cascade/context";
import { useDepositQuote, useStartDeposit } from "@/lib/cascade/hooks";
import type { SourceChain } from "@/lib/cascade/types";
import { formatTao, formatUsd, formatUsdShort, parseAmount, sanitizeAmountInput } from "@/lib/format";
import { ChainPicker } from "./ChainPicker";
import { RequireAccount } from "./RequireAccount";
import { BackTopBar } from "./TopBar";
import styles from "./Form.module.css";

export function DepositScreen() {
  return (
    <>
      <BackTopBar title="Deposit" />
      <RequireAccount>{(account) => <DepositForm account={account} />}</RequireAccount>
    </>
  );
}

function DepositForm({ account }: { account: string }) {
  const router = useRouter();
  const { limits } = useCascadeData();
  const [raw, setRaw] = useState("");
  const [chain, setChain] = useState<SourceChain>("base");
  const inputId = useId();
  const errorId = useId();

  const amount = parseAmount(raw);
  let error: string | null = null;
  if (amount !== null && amount < limits.minUsd) {
    error = `The smallest deposit is ${formatUsdShort(limits.minUsd)}.`;
  } else if (amount !== null && amount > limits.maxUsd) {
    error = `The most you can deposit right now is ${formatUsdShort(limits.maxUsd)}.`;
  }
  const valid = amount !== null && error === null;

  const quoteQuery = useDepositQuote(valid ? amount : null, chain);
  const quote = valid ? quoteQuery.data : undefined;
  const start = useStartDeposit(account);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!valid || start.isPending) return;
    start.mutate(
      { amountUsd: amount, chain },
      { onSuccess: (deposit) => router.push(`/deposits/${deposit.id}`) },
    );
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <label htmlFor={inputId} className="small">
        Amount in USDC
      </label>
      <div className={styles.amountField} data-invalid={error ? "true" : undefined}>
        <span aria-hidden="true">$</span>
        <input
          id={inputId}
          className={styles.amountInput}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          value={raw}
          onChange={(e) => setRaw(sanitizeAmountInput(e.target.value, 2))}
          aria-invalid={error ? true : undefined}
          aria-describedby={errorId}
        />
      </div>
      <p id={errorId} className={`${styles.under} ${error ? styles.error : "small"}`}>
        {error ?? `From ${formatUsdShort(limits.minUsd)} to ${formatUsdShort(limits.maxUsd)}`}
      </p>

      <ChainPicker value={chain} onChange={setChain} />
      {chain !== "base" && (
        <p className={styles.note}>
          Your USDC moves from {chainInfo(chain).label} to Base first. That happens automatically,
          and the extra fee and time are included below.
        </p>
      )}

      <dl className={styles.summary} aria-live="polite">
        <div>
          <dt>You&apos;ll get about</dt>
          <dd>{quote ? <b>{formatTao(quote.estTao)} TAO staked</b> : "–"}</dd>
        </div>
        <div>
          <dt>Fees</dt>
          <dd>{quote ? formatUsd(quote.feesUsd) : "–"}</dd>
        </div>
        <div>
          <dt>Ready in</dt>
          <dd>{quote ? `about ${quote.etaMinutes} minutes` : "–"}</dd>
        </div>
      </dl>

      <button
        type="submit"
        className={`btn btn-primary btn-block ${styles.submit}`}
        disabled={!valid || start.isPending}
      >
        {start.isPending
          ? "Starting your deposit…"
          : valid
            ? `Deposit ${formatUsdShort(amount)}`
            : "Deposit"}
      </button>
      {start.error && (
        <p className={`${styles.error} ${styles.after}`} role="alert">
          {start.error.message}
        </p>
      )}
      <p className={`small ${styles.after}`}>This is a demo. Your wallet won&apos;t be asked to sign anything.</p>
    </form>
  );
}
