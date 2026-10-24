"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { useCascadeData } from "@/lib/cascade/context";
import { useDepositQuote, useProtocolStats, useStartDeposit } from "@/lib/cascade/hooks";
import type { SourceChain } from "@/lib/cascade/types";
import { formatTao, formatUsd, formatUsdShort, parseAmount } from "@/lib/format";
import { stakeButtonLabel, validateStakeAmount } from "@/lib/stake-form";
import { formatApr } from "@/lib/stats";
import { ConnectWallet } from "../ConnectWallet";
import { SampleTag } from "../SampleTag";
import { AmountField } from "./AmountField";
import { ChainChips } from "./ChainChips";
import styles from "./StakeForm.module.css";

/**
 * The stake form used on the stake page and the landing page. With no account it
 * still quotes, but the button becomes the wallet chooser.
 */
export function StakeForm({
  account,
  initialAmount = "",
  maxUsdc = null,
}: {
  account: string | null;
  /** Pre-filled amount, as typed text (the landing page shows a worked example). */
  initialAmount?: string;
  /** The wallet's USDC balance for the MAX button, when known. */
  maxUsdc?: number | null;
}) {
  const router = useRouter();
  const { limits } = useCascadeData();
  const [raw, setRaw] = useState(initialAmount);
  const [chain, setChain] = useState<SourceChain>("base");
  const inputId = useId();
  const noteId = useId();

  const amount = parseAmount(raw);
  const error = validateStakeAmount(amount, limits);
  const valid = amount !== null && amount > 0 && error === null;
  const quoteQuery = useDepositQuote(valid ? amount : null, chain);
  const quote = valid ? quoteQuery.data : undefined;
  const stats = useProtocolStats();
  const start = useStartDeposit(account ?? "");
  const label = stakeButtonLabel({ account, amount, error, pending: start.isPending });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!account || !valid || start.isPending) return;
    start.mutate(
      { amountUsd: amount, chain },
      { onSuccess: (deposit) => router.push(`/activity?deposit=${deposit.id}`) },
    );
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <p className={styles.lbl}>Deposit from</p>
      <ChainChips value={chain} onChange={setChain} />

      <label htmlFor={inputId} className={styles.lbl}>
        Amount
      </label>
      <AmountField
        id={inputId}
        value={raw}
        onChange={setRaw}
        unit="USDC"
        decimals={2}
        onMax={account ? () => setRaw(maxUsdc === null ? "" : maxUsdc.toFixed(2)) : undefined}
        maxDisabled={maxUsdc === null}
        invalid={error !== null}
        describedBy={noteId}
      />
      <p id={noteId} className={error ? styles.error : styles.note}>
        {error ?? `From ${formatUsdShort(limits.minUsd)} to ${formatUsdShort(limits.maxUsd)}`}
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
          <dd>{quote ? `about ${formatTao(quote.estTao, 2)} TAO` : "–"}</dd>
        </div>
        <div>
          <dt>TAO price</dt>
          <dd>{quote ? formatUsd(quote.taoPriceUsd) : "–"}</dd>
        </div>
        <div>
          <dt>Staking yield</dt>
          <dd className={styles.yield}>
            {stats.data?.aprPercent !== undefined ? (
              <>
                {formatApr(stats.data.aprPercent)} APR
                <SampleTag />
              </>
            ) : (
              "–"
            )}
          </dd>
        </div>
        <div>
          <dt>Fees</dt>
          <dd>{quote ? formatUsd(quote.feesUsd) : "–"}</dd>
        </div>
        <div>
          <dt>Staked in</dt>
          <dd>{quote ? `about ${quote.etaMinutes} minutes` : "–"}</dd>
        </div>
      </dl>
      <p className={styles.foot}>One transaction from your wallet. No Bittensor wallet needed.</p>
    </form>
  );
}
