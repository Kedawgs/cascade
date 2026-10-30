"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useReducer, useState, type FormEvent } from "react";
import { parseUnits } from "viem";
import { liveChains } from "@/lib/cascade/chains";
import { ROOT_YIELD_PCT } from "@/lib/cascade/config";
import { useBalances, useDepositQuote, useIsV3, useLimits, useProtocolStats, useRoundTrip, useTaoPrice } from "@/lib/cascade/hooks";
import { useFlows } from "@/lib/cascade/use-flows";
import { useWalletKind } from "@/lib/cascade/use-wallet-kind";
import { formatUsd, parseAmount } from "@/lib/format";
import {
  breakEvenDays,
  breakEvenText,
  cascadeFeesText,
  contractWalletNote,
  etaText,
  stakeMaxInput,
  POOL_FEES_TEXT,
  stakeAmountText,
  stakeButtonLabel,
  stakeFootText,
  stakeFormNote,
  stakeFormReducer,
} from "@/lib/stake-form";
import { ConnectWallet } from "../ConnectWallet";
import { Dash } from "../Dash";
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
  const v3 = useIsV3();
  const limits = useLimits();
  const balances = useBalances(account);
  const flows = useFlows(account);
  const [{ raw }, dispatch] = useReducer(stakeFormReducer, { raw: initialAmount });
  const setRaw = (v: string) => dispatch({ type: "edit", raw: v });
  const [opId, setOpId] = useState<string | null>(null);
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

  const amount = parseAmount(raw);
  const lim = limits.data;
  const { error, note } = stakeFormNote(amount, limits, account ? maxUsdc : null);
  // MAX waits for the limits as well as the balance
  const maxInput = stakeMaxInput(maxUsdc, lim);
  const units = lim && amount !== null && amount > 0 && error === null ? usdcUnits(raw) : null;
  const quoteQuery = useDepositQuote(units);
  // ignore the previous amount's quote while the new one loads
  const quote = units !== null && quoteQuery.data?.usdcIn === units ? quoteQuery.data : undefined;
  const pending = flows.busy === "stake";
  const lowEth = account !== null && balances.data !== undefined && balances.data.eth < LOW_ETH_WEI;
  const label = stakeButtonLabel({ account, amount, error, pending, dollars: v3 });
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
    if (!account || !quote || pending) return;
    start();
    setOpId(null);
    flows.stake(quote, setOpId).then(
      (id) => {
        // cleared before the refreshed balance arrives, which counts this stake (stakeFormReducer)
        dispatch({ type: "sent" });
        router.push(`/activity?deposit=${id}`);
      },
      () => undefined, // the message is in flows.error
    );
  }

  return (
    // focus anywhere in the form (the amount, MAX, the button) is a first input too
    <form className={styles.form} onSubmit={onSubmit} onFocus={start} noValidate>
      {v3 && <PriceStrip />}
      <label htmlFor={inputId} className={styles.lbl}>
        Amount
      </label>
      <AmountField
        id={inputId}
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
        <button type="submit" className={`pill pill-block ${styles.submit}`} disabled={!quote || pending || lowEth || flows.blocked !== null}>
          {label}
        </button>
      ) : (
        <div className={styles.submit}>
          <ConnectWallet variant="pill-block" />
        </div>
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
}
