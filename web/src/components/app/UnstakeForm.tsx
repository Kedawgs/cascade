"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { formatEther } from "viem";
import { liveChains } from "@/lib/cascade/chains";
import { useAvailable, useBalances, useIsV3, usePosition, useWithdrawalQuote } from "@/lib/cascade/hooks";
import type { Available, Position } from "@/lib/cascade/types";
import { checkUnstake, toDisplay } from "@/lib/cascade/units";
import { useFlows } from "@/lib/cascade/use-flows";
import { formatTao, formatUsd, formatUsdcCents } from "@/lib/format";
import {
  deliveryFloorUsd,
  deliveryNote,
  maxUnstakeInputIn,
  switchUnstakeUnit,
  unstakeButtonLabel,
  unstakeEtaText,
  unstakeEquivalent,
  unstakeErrorText,
  unstakeLabelUsd,
  unstakeMaxWei,
  unstakeNote,
  unstakeRequestWei,
  type UnstakeUnit,
} from "@/lib/stake-form";
import { ConnectWallet } from "../ConnectWallet";
import { LoadError } from "../LoadError";
import { Loading } from "../Loading";
import { AmountField } from "./AmountField";
import styles from "./StakeForm.module.css";

const GAS_WEI = 3n * 10n ** 13n;

/** The unstake form: the amount typed in TAO or as its USDC value, a USDC estimate out. */
export function UnstakeForm({ account }: { account: string | null }) {
  if (!account) return <UnstakeFormBody account={null} position={null} />;
  return <UnstakeWithBalance account={account} />;
}

function UnstakeWithBalance({ account }: { account: string }) {
  const position = usePosition(account);
  const available = useAvailable(account);
  if (position.isError || available.isError) {
    return (
      <LoadError
        what={position.isError ? "your balance" : "what you can unstake"}
        onRetry={() => {
          void position.refetch();
          void available.refetch();
        }}
      />
    );
  }
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
  if (!available.data) return <Loading />;
  return <UnstakeFormBody account={account} position={{ ...position.data, ...available.data }} />;
}

function UnstakeFormBody({ account, position }: { account: string | null; position: (Position & Available) | null }) {
  const router = useRouter();
  const v3 = useIsV3();
  const flows = useFlows(account);
  const balances = useBalances(account);
  const [raw, setRaw] = useState("");
  const [all, setAll] = useState(false);
  // people come with USDC and want USDC back, so amounts start in USDC; the token chip switches to TAO
  const [unit, setUnit] = useState<UnstakeUnit>("USDC");
  // the exact TAO carried over by a unit switch, until the user edits the amount
  const [pinned, setPinned] = useState<bigint | null>(null);
  const [opId, setOpId] = useState<string | null>(null);
  const inputId = useId();
  const noteId = useId();

  const available = position?.availableTaoWei ?? 0n;
  // v3: the most one unstake can carry (the vault's maxEntryValue); MAX and the check keep to it
  const most = position?.mostTaoWei;
  const price = position?.taoPriceUsd ?? 0;
  // what MAX fills; null when no amount can go (nothing to unstake, or this batch's request is full)
  const maxWei = unstakeMaxWei(available, most);
  const request = all ? available : (pinned ?? unstakeRequestWei(raw, unit, price));
  const check = position && request !== null ? checkUnstake(request, available, most) : null;
  const shares =
    position && check?.ok
      ? check.all
        ? position.availableShares
        : (position.availableShares * (request as bigint)) / (available === 0n ? 1n : available)
      : null;
  const quoteQuery = useWithdrawalQuote(account, shares);
  const quote = shares !== null && quoteQuery.data?.shares === shares ? quoteQuery.data : undefined;
  const pending = flows.busy === "unstake";
  const error =
    check && !check.ok
      ? unstakeErrorText(check, available, unit, price, most)
      : quoteQuery.isError && shares !== null
        ? "This amount can't be sent back right now"
        : null;
  const lowEth = quote !== undefined && balances.data !== undefined && balances.data.eth < quote.fee + GAS_WEI;
  const usd = unstakeLabelUsd({ unit, raw, fixed: all || pinned !== null, requestWei: request, priceUsd: price });
  const label = unstakeButtonLabel({
    account,
    amount: request === null ? null : toDisplay(request, 18),
    ...(usd !== undefined ? { usd } : {}),
    error,
    pending,
  });

  /** MAX: the whole stake, or as much as one unstake can carry (pinned exactly, so a unit switch or the
   * price can't move it past the limit). */
  function fillAll() {
    const max = maxWei;
    if (max === null) return;
    setRaw(maxUnstakeInputIn(max, unit, price));
    if (max === available) {
      setPinned(null);
      setAll(true);
    } else {
      setPinned(max);
      setAll(false);
    }
  }

  /** Switches the unit, showing the same amount in the other unit (MAX stays MAX). */
  function switchUnit() {
    const next = switchUnstakeUnit(request, unit, price);
    setUnit(next.unit);
    setRaw(next.raw);
    setPinned(all ? null : next.pinned);
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
          setPinned(null);
        }}
        unit={unit}
        chain={liveChains()[0]}
        decimals={unit === "TAO" ? 6 : 2}
        onMax={account && position && maxWei !== null ? fillAll : undefined}
        invalid={error !== null}
        describedBy={noteId}
        onToggleUnit={position && (unit === "USDC" || price > 0) ? switchUnit : undefined}
        toggleLabel={unit === "TAO" ? "Type a USDC amount instead" : "Type a TAO amount instead"}
      />
      <p id={noteId} className={error ? styles.error : styles.note}>
        {error ??
          (position
            ? `${request !== null && price > 0 ? `${unstakeEquivalent(request, unit, price)}. ` : ""}${unstakeNote(available, unit, price, most)}`
            : "Connect a wallet to see what you can unstake.")}
      </p>
      {check && !check.ok && check.offerAll && (
        <button type="button" className="pill pill-ghost pill-block" onClick={fillAll}>
          Unstake all {formatTao(toDisplay(available, 18), 4)} TAO instead
        </button>
      )}

      {account ? (
        <button type="submit" className={`pill pill-block ${styles.submit}`} disabled={!quote || pending || lowEth || flows.blocked !== null}>
          {label}
        </button>
      ) : (
        <div className={styles.submit}>
          <ConnectWallet variant="pill-block" />
        </div>
      )}
      {v3 && <p className={styles.under}>{deliveryNote(quote ? deliveryFloorUsd(quote) : null)}</p>}
      {lowEth && quote && (
        <p className={styles.error}>
          This unstake needs about {formatEther(quote.fee + GAS_WEI)} ETH on Base for the request fee and network fees, and this
          wallet has less. Add a little ETH on Base, then come back.
        </p>
      )}
      {(flows.error ?? flows.blocked) && (
        <p role="alert" className={styles.error}>
          {flows.error ?? flows.blocked}
          {flows.error && opId && (
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
          <dd>{quote ? `about ${formatUsdcCents(quote.usdcAmount)} USDC` : "–"}</dd>
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
          <dd>{quote ? unstakeEtaText(quote.etaMinutes) : "–"}</dd>
        </div>
      </dl>
      {!v3 && <p className={styles.foot}>Your TAO comes back to Base, then you claim it as USDC in the same wallet.</p>}
    </form>
  );
}
