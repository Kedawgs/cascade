"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { parseUnits } from "viem";
import { useBalances, useDepositQuote, useLimits } from "@/lib/cascade/hooks";
import { useFlows } from "@/lib/cascade/use-flows";
import { formatTao, formatUsd, formatUsdShort, parseAmount } from "@/lib/format";
import { maxStakeInput, stakeButtonLabel, validateStakeAmount } from "@/lib/stake-form";
import { ConnectWallet } from "../ConnectWallet";
import { AmountField } from "./AmountField";
import styles from "./StakeForm.module.css";

/** Less than this much ETH on Base can't pay for the swap and deposit. */
const LOW_ETH_WEI = 5n * 10n ** 13n;

function usdcUnits(raw: string): bigint | null {
  try {
    return parseUnits(raw, 6);
  } catch {
    return null;
  }
}

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
  /** Pre-filled amount, as typed text. */
  initialAmount?: string;
  /** The wallet's USDC balance for the MAX button, when known. */
  maxUsdc?: number | null;
}) {
  const router = useRouter();
  const limits = useLimits();
  const balances = useBalances(account);
  const flows = useFlows(account);
  const [raw, setRaw] = useState(initialAmount);
  const [opId, setOpId] = useState<string | null>(null);
  const inputId = useId();
  const noteId = useId();

  const amount = parseAmount(raw);
  const lim = limits.data;
  const error = lim ? validateStakeAmount(amount, lim, account ? maxUsdc : null) : null;
  const units = lim && amount !== null && amount > 0 && error === null ? usdcUnits(raw) : null;
  const quoteQuery = useDepositQuote(units);
  // ignore the previous amount's quote while the new one loads
  const quote = units !== null && quoteQuery.data?.usdcIn === units ? quoteQuery.data : undefined;
  const pending = flows.busy === "stake";
  const lowEth = account !== null && balances.data !== undefined && balances.data.eth < LOW_ETH_WEI;
  const label = stakeButtonLabel({ account, amount, error, pending });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!account || !quote || pending) return;
    setOpId(null);
    flows.stake(quote, setOpId).then(
      (id) => router.push(`/activity?deposit=${id}`),
      () => undefined, // the message is in flows.error
    );
  }

  const note = error ?? (lim ? `From ${formatUsdShort(lim.minUsd)} to ${formatUsdShort(lim.maxUsd)}` : limits.isError ? "Limits unavailable right now" : "Checking the limits…");

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <label htmlFor={inputId} className={styles.lbl}>
        Amount
      </label>
      <AmountField
        id={inputId}
        value={raw}
        onChange={setRaw}
        unit="USDC"
        decimals={2}
        onMax={account ? () => setRaw(maxUsdc === null ? "" : maxStakeInput(maxUsdc)) : undefined}
        maxDisabled={maxUsdc === null}
        invalid={error !== null}
        describedBy={noteId}
      />
      <p id={noteId} className={error ? styles.error : styles.note}>
        {note}
      </p>

      {account ? (
        <button type="submit" className={`pill pill-block ${styles.submit}`} disabled={!quote || pending || lowEth}>
          {label}
        </button>
      ) : (
        <div className={styles.submit}>
          <ConnectWallet variant="pill-block" />
        </div>
      )}
      {lowEth && (
        <p className={styles.error}>
          Network fees on Base are paid in ETH, and this wallet has almost none. Add a little ETH on Base (about $1 covers
          many transactions), then come back.
        </p>
      )}
      {flows.error && (
        <p role="alert" className={styles.error}>
          {flows.error}
          {opId && (
            <>
              {" "}
              <Link href={`/activity?deposit=${opId}`}>See this deposit</Link>.
            </>
          )}
        </p>
      )}

      <dl className={styles.details} aria-live="polite">
        <div>
          <dt>You will stake</dt>
          <dd>{quote ? `${formatTao(quote.estTao, 4)} TAO` : "–"}</dd>
        </div>
        <div>
          <dt>Price per TAO (incl. swap fees)</dt>
          <dd>{quote ? formatUsd(quote.taoPriceUsd) : "–"}</dd>
        </div>
        <div>
          <dt>Swap fees</dt>
          <dd>{quote ? `${formatUsd(quote.feesUsd)} + Base network fee` : "–"}</dd>
        </div>
        <div>
          <dt>Staked in</dt>
          <dd>{quote ? `about ${quote.etaMinutes} minutes` : "–"}</dd>
        </div>
      </dl>
      <p className={styles.foot}>
        Your wallet asks you to confirm each step, or just once with a smart account. No Bittensor wallet needed.
      </p>
    </form>
  );
}
