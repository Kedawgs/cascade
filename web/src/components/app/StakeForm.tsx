"use client";

import Link from "next/link";
import { type FormEvent, type RefObject, useId, useReducer, useRef, useState } from "react";
import { parseUnits } from "viem";
import { liveChains } from "@/lib/cascade/chains";
import { ROOT_YIELD_PCT } from "@/lib/cascade/config";
import { useBalances, useDepositQuote, useIsV3, useIsV32, useLimits, useOpenBatch, usePosition, useProof, useProtocolStats, useRetired, useRoundTrip, useTaoPrice } from "@/lib/cascade/hooks";
import { impactNote, impactRowText } from "@/lib/cascade/impact";
import { CLOSABLE_GAP_MS } from "@/lib/cascade/live";
import { useFlows } from "@/lib/cascade/use-flows";
import { useWalletKind } from "@/lib/cascade/use-wallet-kind";
import { useNow } from "@/lib/client-state";
import { formatUsd, parseAmount } from "@/lib/format";
import { CLOSE_FIRST_RECHECKING, closeFirstView } from "@/lib/send-now";
import { depositNotice } from "@/lib/sent";
import {
  breakEvenDays,
  breakEvenText,
  cascadeFeesText,
  closeFirstNeeded,
  contractWalletNote,
  etaText,
  originDepositNote,
  stakeMaxInput,
  POOL_FEES_TEXT,
  stakeAmountText,
  stakeButtonLabel,
  stakeFootText,
  stakeFormNote,
  stakeFormReducer,
  stakeHold,
} from "@/lib/stake-form";
import { ConnectWallet } from "../ConnectWallet";
import { Dash } from "../Dash";
import { AmountField } from "./AmountField";
import { RetiredNotice } from "./RetiredNotice";
import { SentDialog } from "./SentDialog";
import styles from "./StakeForm.module.css";

/** Less than this much ETH on Base can't pay for the swap and deposit. */
const LOW_ETH_WEI = 5n * 10n ** 13n;

/** R10 (M-1): whether the limits' reading can time the paid close (send-now.ts closeFirstView): React Query goes on
 * showing the last reading through a failed refresh ("unread") and a hidden tab's stopped ones ("old": older than
 * CLOSABLE_GAP_MS, two refreshes), so neither counts until a fresh one comes. */
const limitsFreshness = (l: { isError: boolean; dataUpdatedAt: number }, now: number): "fresh" | "old" | "unread" =>
  l.isError ? "unread" : now - l.dataUpdatedAt > CLOSABLE_GAP_MS ? "old" : "fresh";

function usdcUnits(raw: string): bigint | null {
  try {
    return parseUnits(raw, 6);
  } catch {
    return null;
  }
}

/** v3: the TAO price (a live read's only), and what it means for a balance held in TAO. */
export function PriceStrip() {
  const stats = useProtocolStats();
  const price = useTaoPrice();
  return (
    <div className={styles.priceStrip}>
      <p className={styles.price}>
        TAO <b>{price !== undefined ? formatUsd(price) : <Dash loading={!stats.isError} />}</b>
      </p>
      <p className={styles.priceNote}>Your balance is TAO: its dollar value moves with TAO&apos;s price.</p>
    </div>
  );
}

interface StakeFormProps {
  account: string | null;
  /** Pre-filled amount, as typed text. */
  initialAmount?: string;
  /** The wallet's USDC balance for the MAX button, when known. */
  maxUsdc?: number | null;
  /** The amount input, when the owner wants focus there too (after its own panel closes). */
  amountRef?: RefObject<HTMLInputElement | null>;
}

/**
 * The stake form used on the stake page and the landing page. With no account it
 * still quotes, but the button becomes the wallet chooser. On a retired deployment (Task 60) there is no stake: the
 * plan's sentence takes its place, on both pages.
 */
export function StakeForm(props: StakeFormProps) {
  const retired = useRetired();
  return retired ? <RetiredNotice /> : <StakeFormBody {...props} />;
}

function StakeFormBody({ account, initialAmount = "", maxUsdc = null, amountRef }: StakeFormProps) {
  const ownRef = useRef<HTMLInputElement>(null);
  const amountInput = amountRef ?? ownRef;
  const v3 = useIsV3();
  const v32 = useIsV32();
  // v3.2: while the vault lens reads stake missing, a stake would only park: held, with the reason (stake-form.ts)
  const proof = useProof(false, v32);
  const hold = v32 ? stakeHold(proof.data) : null;
  const limits = useLimits();
  const balances = useBalances(account);
  const flows = useFlows(account);
  const [{ raw, sent }, dispatch] = useReducer(stakeFormReducer, { raw: initialAmount, sent: null });
  const setRaw = (v: string) => dispatch({ type: "edit", raw: v });
  const [opId, setOpId] = useState<string | null>(null);
  // R12d: a click on an aged reading is reading the limits again (onSubmit), and says so
  const [rechecking, setRechecking] = useState(false);
  const inputId = useId();
  const noteId = useId();
  // a contract account (not a plain or EIP-7702 one) is told how it can leave once it starts to stake:
  // the note comes with the first input in the form that brings it (focus, typing, MAX or the click,
  // so a pre-filled amount gets it too), never on its own after the page has loaded, so it moves
  // nothing by itself; a wallet not known yet waits for the next input
  const kind = useWalletKind(account);
  const [started, setStarted] = useState(false);
  const start = () => {
    if (kind.data !== undefined) setStarted(true);
  };
  const walletNote = started && kind.data ? contractWalletNote(kind.data) : null;
  // v3.2 (R6, claim B): a stake into an address that already withdraws on Bittensor could leave only there, so the form
  // warns before it, with the first input (as the note above) or once an amount is typed
  const position = usePosition(account ?? "", false, v32 && account !== null);
  const originNote = v32 && account && (started || raw !== "") ? originDepositNote(position.data) : null;

  const amount = parseAmount(raw);
  const lim = limits.data;
  const formNote = stakeFormNote(amount, limits, account ? maxUsdc : null);
  // v3.2 (R8): the full open batch is all that stops this stake, and it can be sent first: the form offers to send it,
  // then stake (flows.closeThenStake), saying what the close costs (send-now.ts closeFirstView, from the open batch read).
  // R9 (M-2): only once reads a refresh apart still find the same batch closable (the keeper's free close comes first),
  // and as due, not full, when it can close by time alone; R9 (L-1): the click closes only the batch the note priced;
  // R10 (M-1): held while the limits' reading isn't fresh (the click reads them again and holds the clock to that read)
  const after = lim?.afterClose;
  const closeFirst = v32 && account !== null && after !== undefined && closeFirstNeeded(amount, lim, maxUsdc);
  const openBatch = useOpenBatch(account ?? "", closeFirst);
  const now = useNow(15_000);
  const closeView = closeFirst && after ? closeFirstView({ batch: openBatch.data, unread: openBatch.isError, after, limits: limitsFreshness(limits, now) }) : null;
  const error = closeFirst ? null : formNote.error;
  const note = closeView ? closeView.note : formNote.note;
  // MAX waits for the limits as well as the balance
  const maxInput = stakeMaxInput(maxUsdc, lim);
  const units = lim && amount !== null && amount > 0 && error === null ? usdcUnits(raw) : null;
  const quoteQuery = useDepositQuote(units);
  // ignore the previous amount's quote while the new one loads
  const quote = units !== null && quoteQuery.data?.usdcIn === units ? quoteQuery.data : undefined;
  const pending = flows.busy === "stake";
  // v3.2: the swap's own price impact, warned from 1% and refused above 3% (impact.ts); none on other deployments
  const impact = v32 ? impactNote(quote) : null;
  const lowEth = account !== null && balances.data !== undefined && balances.data.eth < LOW_ETH_WEI;
  const label = stakeButtonLabel({ account, amount, error, pending, dollars: v3, closeFirst });
  // v3: what leaving costs, read apart from the quote so it never holds up the button; to the 0.001
  // TAO, so the quote's refreshes don't each ask Bittensor again (the bridge fee barely moves with size)
  const roundTrip = useRoundTrip(v3 && quote ? (quote.targetTao / 10n ** 15n) * 10n ** 15n : null);
  // the root yield is before Cascade's cut, which breakEvenDays takes off.
  // TODO: a vault rate measured from reward claims can replace ROOT_YIELD_PCT here only as the rate
  // before the cut: one measured from the share price is already net of it, so gross it back up (or
  // pass a zero cut) rather than taking the cut twice.
  const breakEven = v3 && quote && roundTrip.data ? breakEvenDays(quote, roundTrip.data, ROOT_YIELD_PCT) : null;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!account || !quote || pending || hold !== null || impact?.refused || closeView?.disabled) return;
    const priced = closeView?.batchId;
    if (closeView && priced === undefined) return;
    // R10 (M-1): the view may be from a render before the reading aged (a tab just shown again): read the limits again;
    // R12d: saying so while it does, never a click that seems to do nothing
    if (closeView && limitsFreshness(limits, Date.now()) !== "fresh") {
      setRechecking(true);
      void limits.refetch().finally(() => setRechecking(false));
      return;
    }
    start();
    setOpId(null);
    (closeView && priced !== undefined ? flows.closeThenStake(quote, priced, setOpId) : flows.stake(quote, setOpId)).then(
      // cleared before the refreshed balance arrives, which counts this stake, and confirmed in a panel
      // (stakeFormReducer)
      (id) => dispatch({ type: "sent", notice: depositNotice(id, quote) }),
      () => undefined, // the message is in flows.error
    );
  }

  const form = (
    // focus anywhere in the form (the amount, MAX, the button) is a first input too
    <form className={styles.form} onSubmit={onSubmit} onFocus={start} noValidate>
      {v3 && <PriceStrip />}
      <label htmlFor={inputId} className={styles.lbl}>
        Amount
      </label>
      <AmountField
        id={inputId}
        inputRef={amountInput}
        value={raw}
        onChange={(v) => {
          setRaw(v);
          start();
        }}
        unit="USDC"
        chain={liveChains()[0]}
        decimals={2}
        onMax={
          account
            ? () => {
                if (maxInput === null) return;
                setRaw(maxInput);
                start();
              }
            : undefined
        }
        maxDisabled={maxInput === null}
        invalid={error !== null}
        describedBy={noteId}
      />
      <p id={noteId} className={error ? styles.error : styles.note}>
        {note}
      </p>

      {account ? (
        <button
          type="submit"
          className={`pill pill-block ${styles.submit}`}
          disabled={!quote || pending || lowEth || hold !== null || flows.blocked !== null || impact?.refused === true || closeView?.disabled === true}
        >
          {label}
        </button>
      ) : (
        <div className={styles.submit}>
          <ConnectWallet variant="pill-block" />
        </div>
      )}
      {rechecking && (
        <p role="status" className={styles.note}>
          {CLOSE_FIRST_RECHECKING}
        </p>
      )}
      {closeView?.warning && (
        <p role="status" className={styles.error}>
          {closeView.warning}
        </p>
      )}
      {hold && (
        <p role="status" className={styles.error}>
          {hold}
        </p>
      )}
      {impact && (
        <p role={impact.refused ? "status" : undefined} className={impact.refused ? styles.error : styles.note}>
          {impact.text}
        </p>
      )}
      {originNote && (
        <p role="status" className={styles.error}>
          {originNote}
        </p>
      )}
      {account && walletNote && <p className={styles.under}>{walletNote}</p>}
      {lowEth && (
        <p className={styles.error}>
          Network fees on Base are paid in ETH, and this wallet has almost none. Add a little ETH on Base (about $1 covers
          many transactions), then come back.
        </p>
      )}
      {(flows.error ?? flows.blocked) && (
        <p role="alert" className={styles.error}>
          {flows.error ?? flows.blocked}
          {flows.error && opId && (
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
          <dd>{quote ? stakeAmountText(quote, v3) : "–"}</dd>
        </div>
        {v3 ? (
          <>
            <div>
              <dt>Cascade fees</dt>
              <dd>{quote ? cascadeFeesText(quote) : "–"}</dd>
            </div>
            <div>
              <dt>Pool fees</dt>
              <dd>{quote ? POOL_FEES_TEXT : "–"}</dd>
            </div>
            {v32 && (
              <div>
                <dt>Price impact</dt>
                <dd>{quote?.impact ? impactRowText(quote.impact) : "–"}</dd>
              </div>
            )}
          </>
        ) : (
          <>
            <div>
              <dt>Price per TAO (incl. swap fees)</dt>
              <dd>{quote ? formatUsd(quote.taoPriceUsd) : "–"}</dd>
            </div>
            <div>
              <dt>Swap fees</dt>
              <dd>{quote ? `${formatUsd(quote.feesUsd)} + Base network fee` : "–"}</dd>
            </div>
          </>
        )}
        <div>
          <dt>Staked in</dt>
          <dd>{quote ? etaText(quote.etaMinutes) : "–"}</dd>
        </div>
      </dl>
      {breakEven !== null && <p className={styles.breakEven}>{breakEvenText(breakEven)}</p>}
      <p className={styles.foot}>{stakeFootText(v3)}</p>
    </form>
  );

  return (
    <>
      {form}
      <SentDialog notice={sent} onClose={() => dispatch({ type: "dismiss" })} returnFocus={amountInput} />
    </>
  );
}
