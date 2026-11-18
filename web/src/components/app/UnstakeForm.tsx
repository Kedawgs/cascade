"use client";

import Link from "next/link";
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { formatEther } from "viem";
import { useNow } from "@/lib/client-state";
import { liveChains } from "@/lib/cascade/chains";
import { shownExitHold, unstakeHoldLines } from "@/lib/cascade/exit-hold";
import { NOTHING_STAKED_HERE } from "@/lib/cascade/flows";
import {
  useAvailable,
  useBalances,
  useDeliveryLimit,
  useDeliveryPreference,
  useExitHold,
  useIsV3,
  useIsV32,
  useMinUnstakeWei,
  usePosition,
  useRetired,
  useUsdcDelivery,
  useWithdrawalQuote,
} from "@/lib/cascade/hooks";
import { impactRowText } from "@/lib/cascade/impact";
import type { Available, Position } from "@/lib/cascade/types";
import { checkUnstake, priceDropNote, toDisplay } from "@/lib/cascade/units";
import { useFlows } from "@/lib/cascade/use-flows";
import { formatTao, formatUsd } from "@/lib/format";
import { receiveTaoNotice, type SentNotice, unstakeNotice } from "@/lib/sent";
import {
  deliveryFloorUsd,
  deliveryLaterText,
  deliveryNote,
  maxUnstakeInputIn,
  requestHold,
  switchUnstakeUnit,
  unstakeButtonLabel,
  unstakeEtaText,
  unstakeEquivalent,
  unstakeErrorText,
  unstakeFormError,
  unstakeLabelUsd,
  unstakeMaxWei,
  unstakeFormRequest,
  unstakeNote,
  unstakeReceiveText,
  UNSTAKE_FORM_CLEARED,
  UNSTAKE_MORE_LABEL,
  UNSTAKE_WINDOW_NOTE,
  type UnstakeUnit,
  RECEIVE_ENDS_DELIVERY,
  RECEIVE_TAO_LABEL,
  RECEIVE_TAO_LATER,
  RECEIVE_TAO_NOTE_OFF,
  shownUnstakeUnit,
  unstakeActions,
} from "@/lib/stake-form";
import { ConnectWallet } from "../ConnectWallet";
import { LoadError } from "../LoadError";
import { Loading } from "../Loading";
import { AmountField } from "./AmountField";
import { SentDialog } from "./SentDialog";
import styles from "./StakeForm.module.css";

const GAS_WEI = 3n * 10n ** 13n;

/** The unstake form: the amount typed in TAO or as its USDC value, a USDC estimate out. An unstake that
 * goes through is confirmed in a panel, held here so the refresh after it (which may change what the form
 * shows) can't take the panel away. */
export function UnstakeForm({ account }: { account: string | null }) {
  const [sent, setSent] = useState<SentNotice | null>(null);
  // the amount input: where focus goes when the panel closes
  const amountRef = useRef<HTMLInputElement>(null);
  const sending: Sending = { onSent: setSent, amountRef };
  return (
    <>
      {account ? <UnstakeWithBalance account={account} {...sending} /> : <UnstakeFormBody account={null} position={null} {...sending} />}
      <SentDialog notice={sent} onClose={() => setSent(null)} returnFocus={amountRef} />
    </>
  );
}

/** What the form needs from UnstakeForm: where an unstake that went through is confirmed, and its amount input. */
interface Sending {
  onSent: (n: SentNotice) => void;
  amountRef: RefObject<HTMLInputElement | null>;
}

function UnstakeWithBalance({ account, ...sending }: { account: string } & Sending) {
  const position = usePosition(account);
  const available = useAvailable(account);
  // a retired deployment invites no stake where nothing is staked (Task 60 review, Minor 1)
  const retired = useRetired();
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
    if (retired) {
      return (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{NOTHING_STAKED_HERE}</p>
        </div>
      );
    }
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
  // whether one of this browser's unstakes arrived is still being checked against the chain: no figure, no form on it
  if (available.data.checking) return <p className="small">Checking your history against the chain before showing what you can unstake…</p>;
  return <UnstakeFormBody account={account} position={{ ...position.data, ...available.data }} {...sending} />;
}

function UnstakeFormBody({
  account,
  position,
  onSent,
  amountRef,
}: {
  account: string | null;
  position: (Position & Available) | null;
} & Sending) {
  const v3 = useIsV3();
  const v32 = useIsV32();
  // v3.2's switch (Task 60, spec §5): with USDC delivery off no USDC unstake is offered, and Receive TAO is the one way
  // out, as the form's own button (it is never off on any other deployment: config.usdcDeliveryOn)
  const usdcDelivery = useUsdcDelivery();
  const taoOnly = v32 && !usdcDelivery;
  // the deployment's own minimum: v3.2's 0.033 TAO, v3-launch's 0.011 TAO
  const minWei = useMinUnstakeWei();
  const flows = useFlows(account);
  const balances = useBalances(account);
  const [raw, setRaw] = useState("");
  const [all, setAll] = useState(false);
  // people come with USDC and want USDC back, so amounts start in USDC; the token chip switches to TAO. On v3.2 while
  // TAO's price can't be read, in TAO (Receive TAO needs no price: Task 59a review, M6), and with USDC delivery off
  const [chosenUnit, setUnit] = useState<UnstakeUnit>("USDC");
  const unit = shownUnstakeUnit(chosenUnit, { v32, priceMissing: position?.priceMissing === true, usdcDelivery });
  // the exact TAO carried over by a unit switch, until the user edits the amount
  const [pinned, setPinned] = useState<bigint | null>(null);
  const [opId, setOpId] = useState<string | null>(null);
  // v3.2: the unstake running is Receive TAO's (its button says to confirm, not the USDC one's)
  const [receiving, setReceiving] = useState(false);
  // v3.2: the live USDC delivery limit, what else of the account's a USDC unstake sells, and whether the chain holds a
  // delivery preference a Receive TAO would clear; with USDC delivery off, only that preference, read on its own
  const limit = useDeliveryLimit(account, v32 && usdcDelivery);
  const preference = useDeliveryPreference(account, taoOnly);
  // v3.2 (R4): what holds a Base unstake now: the bridge unable to send payouts, shares less than a day old, today's limit
  const exitHold = useExitHold(v32 ? account : null);
  const now = useNow(60_000);
  const inputId = useId();
  const noteId = useId();

  const available = position?.availableTaoWei ?? 0n;
  // v3: the most one unstake can carry (the vault's maxEntryValue); MAX and the check keep to it
  const most = position?.mostTaoWei;
  const price = position?.taoPriceUsd ?? 0;
  // what MAX fills; null when no amount can go (nothing to unstake, or this batch's request is full)
  const maxWei = unstakeMaxWei(available, most, minWei);
  const request = unstakeFormRequest({ raw, all, pinned }, unit, available, price);
  const check = position && request !== null ? checkUnstake(request, available, most, minWei) : null;
  // v3.2: all is forced on a stake under twice the minimum, and by delivery a price drop can take it under the
  // vault's (it then waits, to be requested again)
  const dropNote = v32 ? priceDropNote(check, available, minWei) : null;
  const shares =
    position && check?.ok
      ? check.all
        ? position.availableShares
        : (position.availableShares * (request as bigint)) / (available === 0n ? 1n : available)
      : null;
  const quoteQuery = useWithdrawalQuote(account, shares);
  const quote = shares !== null && quoteQuery.data?.shares === shares ? quoteQuery.data : undefined;
  const pending = flows.busy === "unstake";
  // the amount check's refusal, else a failed quote; with USDC delivery off the check's alone: the quote is the USDC
  // sale's, which Receive TAO doesn't need (stake-form.ts unstakeFormError)
  const error = unstakeFormError({
    checkError: check && !check.ok ? unstakeErrorText(check, available, unit, price, most, minWei) : null,
    quoteFailed: quoteQuery.isError && shares !== null,
    taoOnly,
  });
  const lowEth = quote !== undefined && balances.data !== undefined && balances.data.eth < quote.fee + GAS_WEI;
  // v3.2: what holds a request now, in plain words: shares that withdraw elsewhere (the vault would skip the request
  // and its fee would be spent for nothing: Review Focus 4), or stake missing; the button stays off while it holds
  const hold = v32 ? requestHold(position) : null;
  // v3.2: notices only, never a refusal: a request is judged when its batch arrives, and the hold or a pause may be over
  // the last reads, kept through a failed read for two minutes at most (never shown as live past that)
  const holds = unstakeHoldLines(v32 ? shownExitHold(exitHold, now) : undefined, check?.ok ? request : null, now);
  // v3.2: USDC within the live delivery limit and the price-impact cap; Receive TAO open beside it (stake-form.ts).
  // Every other deployment: the USDC button by the quote, as before
  const actions = unstakeActions({
    v32,
    account,
    shares,
    quote,
    limit: { data: limit.data, isError: limit.isError },
    pending,
    lowEth,
    hold,
    blocked: flows.blocked,
    usdcDelivery,
    preference: { data: preference.data, isError: preference.isError },
  });
  const usd = unstakeLabelUsd({ unit, raw, fixed: all || pinned !== null, requestWei: request, priceUsd: price });
  const label = unstakeButtonLabel({
    account,
    amount: request === null ? null : toDisplay(request, 18),
    ...(usd !== undefined ? { usd } : {}),
    error,
    // with USDC delivery off the one button is Receive TAO's
    pending: pending && (taoOnly ? receiving : !receiving),
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

  /** Cleared before what can be unstaked is read again, which counts the request just made (UNSTAKE_FORM_CLEARED). */
  function cleared() {
    setRaw(UNSTAKE_FORM_CLEARED.raw);
    setAll(UNSTAKE_FORM_CLEARED.all);
    setPinned(UNSTAKE_FORM_CLEARED.pinned);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    // USDC delivery off: the form's one button asks for TAO, nothing sold
    if (taoOnly) return onReceiveTao();
    if (!account || !quote || !actions.usdc) return;
    setOpId(null);
    flows.unstake(quote, setOpId).then(
      (id) => {
        cleared();
        onSent(unstakeNotice(id, quote));
      },
      () => undefined,
    );
  }

  /** v3.2: the same shares as TAO on Base, claimed by hand: nothing is sold, so no price check holds it. */
  function onReceiveTao() {
    if (!account || shares === null || request === null || !actions.tao.enabled) return;
    const taoWei = request;
    setOpId(null);
    setReceiving(true);
    flows
      .receiveTao({ shares, taoWei }, setOpId)
      .then(
        (id) => {
          cleared();
          onSent(receiveTaoNotice(id, taoWei, quote?.batchIntervalS));
        },
        () => undefined,
      )
      .finally(() => setReceiving(false));
  }

  /** Why nothing went (a refusal, or the contracts' mismatch), with the unstake's receipt when one was recorded. */
  const alert = (flows.error ?? flows.blocked) && (
    <p role="alert" className={styles.error}>
      {flows.error ?? flows.blocked}
      {flows.error && opId && (
        <>
          {" "}
          <Link href={`/activity?withdrawal=${opId}`}>See this unstake</Link>.
        </>
      )}
    </p>
  );

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <label htmlFor={inputId} className={styles.lbl}>
        Amount
      </label>
      <AmountField
        id={inputId}
        inputRef={amountRef}
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
        // USDC delivery off: TAO only, nothing in dollars
        onToggleUnit={!taoOnly && position && (unit === "USDC" || price > 0) ? switchUnit : undefined}
        toggleLabel={unit === "TAO" ? "Type a USDC amount instead" : "Type a TAO amount instead"}
      />
      <p id={noteId} className={error ? styles.error : styles.note}>
        {error ??
          (position
            ? `${!taoOnly && request !== null && price > 0 ? `${unstakeEquivalent(request, unit, price)}. ` : ""}${unstakeNote(available, unit, price, most, minWei)}`
            : "Connect a wallet to see what you can unstake.")}
      </p>
      {check && !check.ok && check.offerAll && (
        <button type="button" className="pill pill-ghost pill-block" onClick={fillAll}>
          Unstake all {formatTao(toDisplay(available, 18), 4)} TAO instead
        </button>
      )}
      {dropNote && <p className={styles.note}>{dropNote}</p>}
      {hold && (
        <p role="status" className={styles.error}>
          {hold}
        </p>
      )}
      {holds.onHold && (
        <p role="status" className={styles.error}>
          {holds.onHold}
        </p>
      )}
      {holds.warning && (
        <p role="status" className={styles.error}>
          {holds.warning}
        </p>
      )}
      {holds.fresh && !holds.warning && <p className={styles.note}>{holds.fresh}</p>}

      {/* v3.2: what else of the account's a USDC unstake sells (the latest request decides for all its waiting TAO) */}
      {actions.warning && (
        <p role="status" className={styles.note}>
          {actions.warning}
        </p>
      )}
      {account ? (
        // with USDC delivery off, the one button is Receive TAO's (onSubmit), held only by what holds any request
        <button type="submit" className={`pill pill-block ${styles.submit}`} disabled={taoOnly ? !actions.tao.enabled : !actions.usdc}>
          {label}
        </button>
      ) : (
        <div className={styles.submit}>
          <ConnectWallet variant="pill-block" />
        </div>
      )}
      {taoOnly && account && (
        <p className={styles.under}>
          {RECEIVE_TAO_NOTE_OFF}
          {actions.tao.endsDelivery ? ` ${RECEIVE_ENDS_DELIVERY}` : ""}
        </p>
      )}
      {/* v3.2: the USDC unstake's price impact and the live delivery limit, each a note or why it is refused, and how its
          sale goes; then any refusal at the click, and Receive TAO right there, open whatever held the USDC one */}
      {actions.notes.map((n) => (
        <p key={n.text} role={n.refused ? "status" : undefined} className={n.refused ? styles.error : styles.note}>
          {n.text}
        </p>
      ))}
      {v32 && !taoOnly && <p className={styles.under}>{deliveryNote(quote ? deliveryFloorUsd(quote) : null)}</p>}
      {v32 && alert}
      {actions.tao.offered && !taoOnly && (
        <>
          <button type="button" className="pill pill-ghost pill-block" disabled={!actions.tao.enabled} onClick={onReceiveTao}>
            {pending && receiving ? "Confirm in your wallet…" : RECEIVE_TAO_LABEL}
          </button>
          <p className={styles.under}>
            {RECEIVE_TAO_NOTE_OFF}
            {actions.tao.endsDelivery ? ` ${RECEIVE_ENDS_DELIVERY}` : ""}
          </p>
        </>
      )}
      {v3 && !v32 && <p className={styles.under}>{deliveryNote(quote ? deliveryFloorUsd(quote) : null)}</p>}
      {/* v3.2: the explanations nobody needs to press a button, folded away (closed until asked for): how the USDC
          sale goes, what a later USDC unstake does to TAO received now, the daily limit */}
      {v32 && (
        <details className={styles.more}>
          <summary>{UNSTAKE_MORE_LABEL}</summary>
          <ul>
            {!taoOnly && <li>{deliveryLaterText(quote?.etaMinutes)}</li>}
            {!taoOnly && <li>{RECEIVE_TAO_LATER}</li>}
            <li>{UNSTAKE_WINDOW_NOTE}</li>
          </ul>
        </details>
      )}
      {lowEth && quote && (
        <p className={styles.error}>
          This unstake needs about {formatEther(quote.fee + GAS_WEI)} ETH on Base for the request fee and network fees, and this
          wallet has less. Add a little ETH on Base, then come back.
        </p>
      )}
      {!v32 && alert}

      {taoOnly ? (
        // USDC delivery off: what comes back is TAO, claimed by hand; no USDC figure, price or impact (Task 60)
        <dl className={styles.details} aria-live="polite">
          <div>
            <dt>You will receive</dt>
            <dd>TAO on Base, to claim</dd>
          </div>
          <div>
            <dt>Paid out in</dt>
            <dd>{quote ? unstakeEtaText(quote.etaMinutes) : "–"}</dd>
          </div>
          <div>
            <dt>{"Left of today's limit"}</dt>
            <dd>{holds.leftToday}</dd>
          </div>
        </dl>
      ) : (
        <dl className={styles.details} aria-live="polite">
          <div>
            <dt>You will receive</dt>
            <dd>{quote ? unstakeReceiveText(quote.usdcAmount, v32) : "–"}</dd>
          </div>
          <div>
            <dt>TAO price</dt>
            <dd>{quote ? formatUsd(quote.taoPriceUsd) : "–"}</dd>
          </div>
          {v32 && (
            <div>
              <dt>Price impact</dt>
              <dd>{quote?.impact ? impactRowText(quote.impact) : "–"}</dd>
            </div>
          )}
          {v32 && (
            // the web copy audit's M2: a guide, not a reservation (others may get there first)
            <div>
              <dt>{"Left of today's limit"}</dt>
              <dd>{holds.leftToday}</dd>
            </div>
          )}
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
      )}
      {!v3 && <p className={styles.foot}>Your TAO comes back to Base, then you claim it as USDC in the same wallet.</p>}
    </form>
  );
}
