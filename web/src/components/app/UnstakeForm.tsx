"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { formatEther, parseUnits } from "viem";
import { useBalances, usePosition, useWithdrawalQuote } from "@/lib/cascade/hooks";
import type { Position } from "@/lib/cascade/types";
import { checkUnstake, toDisplay } from "@/lib/cascade/units";
import { useFlows } from "@/lib/cascade/use-flows";
import { formatTao, formatUsd, formatUsdc, parseAmount } from "@/lib/format";
import { maxUnstakeInput, unstakeButtonLabel } from "@/lib/stake-form";
import { ConnectWallet } from "../ConnectWallet";
import { LoadError } from "../LoadError";
import { Loading } from "../Loading";
import { AmountField } from "./AmountField";
import styles from "./StakeForm.module.css";

const GAS_WEI = 3n * 10n ** 13n;

function taoWei(raw: string): bigint | null {
  try {
    return parseUnits(raw, 18);
  } catch {
    return null;
  }
}

/** The unstake form. Mirrors the stake form: TAO in, USDC estimate out. */
export function UnstakeForm({ account }: { account: string | null }) {
  if (!account) return <UnstakeFormBody account={null} position={null} />;
  return <UnstakeWithBalance account={account} />;
}

function UnstakeWithBalance({ account }: { account: string }) {
  const position = usePosition(account);
  if (position.isError) return <LoadError what="your balance" onRetry={() => void position.refetch()} />;
  if (!position.data) return <Loading />;
  if (position.data.shares === 0n) {
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
  return <UnstakeFormBody account={account} position={position.data} />;
}

function UnstakeFormBody({ account, position }: { account: string | null; position: Position | null }) {
  const router = useRouter();
  const flows = useFlows(account);
  const balances = useBalances(account);
  const [raw, setRaw] = useState("");
  const [all, setAll] = useState(false);
  const [opId, setOpId] = useState<string | null>(null);
  const inputId = useId();
  const noteId = useId();

  const available = position?.availableTaoWei ?? 0n;
  const amount = parseAmount(raw);
  const request = all ? available : amount !== null && amount > 0 ? taoWei(raw) : null;
  const check = position && request !== null ? checkUnstake(request, available) : null;
  const shares =
    position && check?.ok
      ? check.all
        ? position.availableShares
        : (position.availableShares * (request as bigint)) / (available === 0n ? 1n : available)
      : null;
  const quoteQuery = useWithdrawalQuote(account, shares);
  const quote = shares !== null && quoteQuery.data?.shares === shares ? quoteQuery.data : undefined;
  const pending = flows.busy === "unstake";
  const error = check && !check.ok ? check.reason : quoteQuery.isError && shares !== null ? "This amount can't be sent back right now" : null;
  const lowEth = quote !== undefined && balances.data !== undefined && balances.data.eth < quote.fee + GAS_WEI;
  const label = unstakeButtonLabel({ account, amount: request === null ? null : toDisplay(request, 18), error, pending });

  function fillAll() {
    setRaw(maxUnstakeInput(available));
    setAll(true);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!account || !quote || pending) return;
    setOpId(null);
    flows.unstake(quote, setOpId).then(
      (id) => router.push(`/activity?withdrawal=${id}`),
      () => undefined,
    );
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <label htmlFor={inputId} className={styles.lbl}>
        Amount
      </label>
      <AmountField
        id={inputId}
        value={raw}
        onChange={(v) => {
          setRaw(v);
          setAll(false);
        }}
        unit="TAO"
        decimals={6}
        onMax={account && position ? fillAll : undefined}
        invalid={error !== null}
        describedBy={noteId}
      />
      <p id={noteId} className={error ? styles.error : styles.note}>
        {error ??
          (position
            ? `You can unstake ${formatTao(toDisplay(available, 18), 4)} TAO. Unstakes start at 0.005 TAO.`
            : "Connect a wallet to see what you can unstake.")}
      </p>
      {check && !check.ok && check.offerAll && (
        <button type="button" className="pill pill-ghost pill-block" onClick={fillAll}>
          Unstake all {formatTao(toDisplay(available, 18), 4)} TAO instead
        </button>
      )}

      {account ? (
        <button type="submit" className={`pill pill-block ${styles.submit}`} disabled={!quote || pending}>
          {label}
        </button>
      ) : (
        <div className={styles.submit}>
          <ConnectWallet variant="pill-block" />
        </div>
      )}
      {lowEth && <p className={styles.error}>You need a little ETH on Base for the request fee and network fees.</p>}
      {flows.error && (
        <p role="alert" className={styles.error}>
          {flows.error}
          {opId && (
            <>
              {" "}
              <Link href={`/activity?withdrawal=${opId}`}>See this unstake</Link>.
            </>
          )}
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
          <dd>
            {quote
              ? `${formatUsd(quote.feesUsd)}${quote.fee > 0n ? `, including the ${formatEther(quote.fee)} ETH request fee` : ""}`
              : "–"}
          </dd>
        </div>
        <div>
          <dt>Paid out in</dt>
          <dd>{quote ? `about ${Math.max(1, Math.round(quote.etaMinutes / 60))} hours` : "–"}</dd>
        </div>
      </dl>
      <p className={styles.foot}>Your TAO comes back to Base, then you claim it as USDC in the same wallet.</p>
    </form>
  );
}
