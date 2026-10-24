"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { usePosition, useStartWithdrawal, useWithdrawalQuote } from "@/lib/cascade/hooks";
import { formatTao, formatUsd, formatUsdc, parseAmount } from "@/lib/format";
import { unstakeButtonLabel, validateUnstakeAmount } from "@/lib/stake-form";
import { ConnectWallet } from "../ConnectWallet";
import { LoadError } from "../LoadError";
import { Loading } from "../Loading";
import { AmountField } from "./AmountField";
import styles from "./StakeForm.module.css";

/** The unstake form. Mirrors the stake form: TAO in, USDC estimate out. */
export function UnstakeForm({ account }: { account: string | null }) {
  if (!account) return <UnstakeFormBody account={null} balance={null} />;
  return <UnstakeWithBalance account={account} />;
}

function UnstakeWithBalance({ account }: { account: string }) {
  const position = usePosition(account);
  if (position.isError) {
    return <LoadError what="your balance" onRetry={() => void position.refetch()} />;
  }
  if (!position.data) return <Loading />;
  if (position.data.taoBalance <= 0) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyTitle}>Nothing staked yet.</p>
        <p className={styles.note}>Stake some USDC first and it will show up here.</p>
        <Link href="/stake" className={`pill pill-block ${styles.submit}`}>
          Go to Stake
        </Link>
      </div>
    );
  }
  return <UnstakeFormBody account={account} balance={position.data.taoBalance} />;
}

function UnstakeFormBody({ account, balance }: { account: string | null; balance: number | null }) {
  const router = useRouter();
  const [raw, setRaw] = useState("");
  const inputId = useId();
  const noteId = useId();

  const amount = parseAmount(raw);
  const error = balance === null ? null : validateUnstakeAmount(amount, balance);
  const valid = amount !== null && amount > 0 && error === null;
  const quoteQuery = useWithdrawalQuote(valid ? amount : null);
  const quote = valid ? quoteQuery.data : undefined;
  const start = useStartWithdrawal(account ?? "");
  const label = unstakeButtonLabel({ account, amount, error, pending: start.isPending });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!account || !valid || start.isPending) return;
    start.mutate(amount, {
      onSuccess: (withdrawal) => router.push(`/activity?withdrawal=${withdrawal.id}`),
    });
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <label htmlFor={inputId} className={styles.lbl}>
        Amount
      </label>
      <AmountField
        id={inputId}
        value={raw}
        onChange={setRaw}
        unit="TAO"
        decimals={4}
        onMax={account && balance !== null ? () => setRaw(balance.toFixed(4)) : undefined}
        invalid={error !== null}
        describedBy={noteId}
      />
      <p id={noteId} className={error ? styles.error : styles.note}>
        {error ??
          (balance !== null
            ? `You have ${formatTao(balance, 2)} TAO staked.`
            : "Connect a wallet to see what you can unstake.")}
      </p>

      {account ? (
        <button type="submit" className={`pill pill-block ${styles.submit}`} disabled={!valid || start.isPending}>
          {label}
        </button>
      ) : (
        <div className={styles.submit}>
          <ConnectWallet variant="pill-block" />
        </div>
      )}
      {start.error && (
        <p role="alert" className={styles.error}>
          {start.error.message}
        </p>
      )}

      <dl className={styles.details} aria-live="polite">
        <div>
          <dt>You will receive</dt>
          <dd>{quote ? `about ${formatUsdc(quote.usdcAmount)} USDC` : "–"}</dd>
        </div>
        <div>
          <dt>TAO price</dt>
          <dd>{quote ? formatUsd(quote.taoPriceUsd) : "–"}</dd>
        </div>
        <div>
          <dt>Fees</dt>
          <dd>{quote ? formatUsd(quote.feesUsd) : "–"}</dd>
        </div>
        <div>
          <dt>Paid out in</dt>
          <dd>{quote ? `about ${Math.round(quote.etaMinutes / 60)} hours` : "–"}</dd>
        </div>
      </dl>
      <p className={styles.foot}>USDC arrives in the same wallet on Base.</p>
    </form>
  );
}
