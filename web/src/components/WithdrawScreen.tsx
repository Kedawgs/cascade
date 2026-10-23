"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { usePosition, useStartWithdrawal, useWithdrawalQuote } from "@/lib/cascade/hooks";
import type { Position } from "@/lib/cascade/types";
import { formatTao, formatUsd, formatUsdc, parseAmount, sanitizeAmountInput } from "@/lib/format";
import { Loading, RequireAccount } from "./RequireAccount";
import { BackTopBar } from "./TopBar";
import styles from "./Form.module.css";

export function WithdrawScreen() {
  return (
    <>
      <BackTopBar title="Withdraw" />
      <RequireAccount>{(account) => <WithdrawLoader account={account} />}</RequireAccount>
    </>
  );
}

function WithdrawLoader({ account }: { account: string }) {
  const position = usePosition(account);
  if (!position.data) return <Loading />;
  if (position.data.taoBalance <= 0) {
    return (
      <>
        <p className="strong">You don&apos;t have any staked TAO to withdraw yet.</p>
        <p className="small">Once a deposit is staked, you can withdraw it here.</p>
        <Link href="/deposit" className={`btn btn-primary btn-block ${styles.submit}`}>
          Make a deposit
        </Link>
      </>
    );
  }
  return <WithdrawForm account={account} position={position.data} />;
}

function WithdrawForm({ account, position }: { account: string; position: Position }) {
  const router = useRouter();
  const [raw, setRaw] = useState("");
  const inputId = useId();
  const errorId = useId();
  const balance = position.taoBalance;

  const amount = parseAmount(raw);
  const error =
    amount !== null && amount > balance ? `You have ${formatTao(balance)} TAO to withdraw.` : null;
  const valid = amount !== null && amount > 0 && error === null;

  const quoteQuery = useWithdrawalQuote(valid ? amount : null);
  const quote = valid ? quoteQuery.data : undefined;
  const start = useStartWithdrawal(account);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!valid || start.isPending) return;
    start.mutate(amount, {
      onSuccess: (withdrawal) => router.push(`/withdrawals/${withdrawal.id}`),
    });
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <label htmlFor={inputId} className="small">
        Amount in TAO
      </label>
      <div className={styles.amountField} data-invalid={error ? "true" : undefined}>
        <input
          id={inputId}
          className={styles.amountInput}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          value={raw}
          onChange={(e) => setRaw(sanitizeAmountInput(e.target.value, 4))}
          aria-invalid={error ? true : undefined}
          aria-describedby={errorId}
        />
        <span className={styles.unit} aria-hidden="true">
          TAO
        </span>
        <button type="button" className={styles.max} onClick={() => setRaw(balance.toFixed(4))}>
          Max
        </button>
      </div>
      <p id={errorId} className={`${styles.under} ${error ? styles.error : "small"}`}>
        {error ??
          (valid
            ? `About ${formatUsd(amount * position.taoPriceUsd)}. You have ${formatTao(balance)} TAO.`
            : `You have ${formatTao(balance)} TAO staked.`)}
      </p>

      <p className={styles.note}>
        Withdrawals go out once a day. In the next daily batch your TAO is unstaked, moved back to
        Base and sent to this wallet as USDC. In this demo it takes a few seconds.
      </p>

      <dl className={styles.summary} aria-live="polite">
        <div>
          <dt>You&apos;ll get about</dt>
          <dd>{quote ? <b>{formatUsdc(quote.usdcAmount)} USDC on Base</b> : "–"}</dd>
        </div>
        <div>
          <dt>Fees</dt>
          <dd>{quote ? formatUsd(quote.feesUsd) : "–"}</dd>
        </div>
        <div>
          <dt>Arrives</dt>
          <dd>after the next daily batch</dd>
        </div>
      </dl>

      <button
        type="submit"
        className={`btn btn-primary btn-block ${styles.submit}`}
        disabled={!valid || start.isPending}
      >
        {start.isPending ? "Starting your withdrawal…" : "Withdraw"}
      </button>
      {start.error && (
        <p className={`${styles.error} ${styles.after}`} role="alert">
          {start.error.message}
        </p>
      )}
    </form>
  );
}
