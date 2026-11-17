"use client";

import { useRef, useState } from "react";
import { SEE_YOUR_TAO } from "@/lib/add-to-wallet";
import { useBalances, useDeliveryPreference, useIsV3, useLimits, usePosition, useRetired, useTaoPrice, useUsdcDelivery, useWithdrawals } from "@/lib/cascade/hooks";
import { isDelivering, offersClaim } from "@/lib/cascade/trail";
import { toDisplay } from "@/lib/cascade/units";
import { useFlows } from "@/lib/cascade/use-flows";
import { formatTao, formatUsd } from "@/lib/format";
import {
  CLAIM_CHECKING,
  CLAIM_ENDS_DELIVERY,
  claimButtonLabel,
  claimChecking,
  claimChoices,
  claimEndsDelivery,
  DELIVERY_IS_OFF,
  deliveryOffClaim,
  offerClaim,
  TURN_OFF_DELIVERY,
  turnOffDeliveryOffered,
  walletTaoNote,
} from "@/lib/stake-form";
import { type SentNotice, walletTaoNotice } from "@/lib/sent";
import { useUsdcBalance } from "@/lib/use-usdc-balance";
import { availableToStake } from "@/lib/usdc-balance";
import { AddToWallet } from "../AddToWallet";
import { Dash } from "../Dash";
import app from "./App.module.css";
import { SentDialog } from "./SentDialog";
import { StakeForm } from "./StakeForm";
import styles from "./StakeCard.module.css";

/** The balance: a contract read, never held up by the vault's history. */
export function StakedSummary({ account }: { account: string }) {
  const position = usePosition(account);
  return (
    <div>
      <p className={styles.k}>Your stake</p>
      <p
        className={styles.v}
        title={position.isError ? "We couldn't load your balance just now." : undefined}
      >
        {position.data && !position.isError ? (
          <>
            {formatTao(position.data.taoBalance, 2)} TAO{" "}
            {/* v3.2: TAO's price unread, so no dollars (live.ts getPosition) */}
            {!position.data.priceMissing && <small>{formatUsd(position.data.usdValue)}</small>}
          </>
        ) : (
          <Dash loading={!position.isError} />
        )}
      </p>
    </div>
  );
}

/** TAO sitting in the wallet on Base (after a cancel, a claim kept as TAO, or a step that stopped): a
 * line of the summary, with staking it or swapping it back to USDC beside it. Hidden when there is none
 * (so a stake of it is confirmed by the card, through `onSent`: once the refresh shows the wallet empty,
 * this is gone). */
function WalletTao({ account, onSent }: { account: string; onSent: (n: SentNotice) => void }) {
  const balances = useBalances(account);
  const limits = useLimits();
  const price = useTaoPrice();
  const flows = useFlows(account);
  // a retired deployment takes no stake, and with USDC delivery off no swap to USDC is offered (Task 60)
  const retired = useRetired();
  const usdcDelivery = useUsdcDelivery();
  const tao = balances.data?.tao ?? 0n;
  if (tao === 0n) return null;
  // why it can't be staked as it is (null when it can); unknown until the limits load; never on a retired deployment
  const note = retired ? null : limits.data ? walletTaoNote(tao, limits.data) : undefined;
  const canDeposit = !retired && note === null;
  const amount = toDisplay(tao, 18);
  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <div>
          <p className={styles.k}>TAO in your wallet</p>
          <p className={styles.rowV} title={`${formatTao(amount, 6)} TAO`}>
            {formatTao(amount, 4)} TAO {price !== undefined && <small>{formatUsd(amount * price)}</small>}
          </p>
        </div>
        <div className={styles.rowActions}>
          {canDeposit && (
            <button
              type="button"
              className="pill pill-sm"
              disabled={flows.locked}
              onClick={() => void flows.depositWalletTao(tao).then((id) => onSent(walletTaoNotice(id, tao)), () => undefined)}
            >
              Stake it
            </button>
          )}
          {usdcDelivery && (
            <button type="button" className="pill pill-ghost pill-sm" disabled={flows.busy !== null} onClick={() => void flows.sellWalletTao(tao).catch(() => undefined)}>
              Swap to USDC
            </button>
          )}
        </div>
      </div>
      {note && <p className={styles.rowNote}>{note}</p>}
      {flows.error && <p className={styles.rowError}>{flows.error}</p>}
    </div>
  );
}

/** Money waiting on Base to be claimed (an unstake's payout, or a deposit the vault sent back), with
 * one button that claims it all as USDC. Hidden when there is none, and on v3 while an unstake's USDC
 * is being delivered automatically and none offers the claim by hand (see offerClaim). While an unstake
 * that may be delivering it is still being checked against the chain, no claim is suggested: the amount
 * shows, with why, and only "Claim as TAO" (claimChecking). */
export function ClaimReady({ account }: { account: string }) {
  const v3 = useIsV3();
  const balances = useBalances(account);
  const price = useTaoPrice();
  const withdrawals = useWithdrawals(account);
  const flows = useFlows(account);
  // v3.2 with USDC delivery off (Task 60, spec §5): whether the chain holds a delivery preference, for the prompt
  const usdcDelivery = useUsdcDelivery();
  const preference = useDeliveryPreference(account, !usdcDelivery);
  // the claim button pressed (its keepTao), while its claim runs: only it says to confirm in the wallet
  const [pressed, setPressed] = useState<boolean | null>(null);
  const claimable = balances.data?.claimable ?? 0n;
  const amount = <b>{price !== undefined ? `About ${formatUsd(toDisplay(claimable, 18) * price)}` : `${formatTao(toDisplay(claimable, 18), 6)} TAO`}</b>;
  const ready = (withdrawals.data ?? []).filter(offersClaim).map((w) => w.id);
  if (!usdcDelivery) {
    // whatever waits on Base, delivering or not: claimed as TAO alone, which clears the preference; prompted while the
    // chain holds one (stake-form.ts deliveryOffClaim)
    const pref = { data: preference.data, isError: preference.isError };
    const off = deliveryOffClaim(claimable, pref);
    // beside it, or alone while nothing is claimable yet: the preference turned off at once (follow-up)
    const turnOff = turnOffDeliveryOffered(usdcDelivery, pref);
    if (!off && !turnOff) return null;
    // the claim pays every payout back on Base: those offering it, and those being delivered
    const paid = (withdrawals.data ?? []).filter((w) => offersClaim(w) || isDelivering(w)).map((w) => w.id);
    return (
      <div className={styles.row}>
        <div className={styles.rowMain}>
          <p className={styles.rowText}>{off ? <>{amount} is back on Base and ready to claim.</> : DELIVERY_IS_OFF}</p>
          <div className={styles.rowActions}>
            {off && (
              <button type="button" className="pill pill-sm" disabled={flows.busy !== null} onClick={() => void flows.claim(paid, true).catch(() => undefined)}>
                {flows.busy === "claim" ? "Confirm in your wallet…" : "Claim as TAO"}
              </button>
            )}
            {turnOff && (
              <button type="button" className="pill pill-ghost pill-sm" disabled={flows.busy !== null} onClick={() => void flows.turnOffDelivery().catch(() => undefined)}>
                {flows.busy === "delivery" ? "Confirm in your wallet…" : TURN_OFF_DELIVERY}
              </button>
            )}
          </div>
        </div>
        {off?.prompt && (
          <p role="status" className={styles.rowNote}>
            {off.prompt}
          </p>
        )}
        {flows.error && <p className={styles.rowError}>{flows.error}</p>}
      </div>
    );
  }
  const checking = claimChecking(claimable, v3, withdrawals.data);
  if (!checking && !offerClaim(claimable, v3, withdrawals.data, withdrawals.isError)) return null;
  // v3.2: an unstake asked as TAO (Receive TAO) is claimed as TAO, so that claim leads
  const askedTao = (withdrawals.data ?? []).some((w) => offersClaim(w) && w.keepsTao === true);
  if (checking) {
    return (
      <div className={styles.row}>
        <div className={styles.rowMain}>
          <p className={styles.rowText}>{amount} is back on Base.</p>
          <div className={styles.rowActions}>
            <button type="button" className="pill pill-ghost pill-sm" disabled={flows.busy !== null} onClick={() => void flows.claim(ready, true).catch(() => undefined)}>
              {flows.busy === "claim" ? "Confirm in your wallet…" : "Claim as TAO"}
            </button>
          </div>
        </div>
        <p className={styles.rowNote}>{CLAIM_CHECKING}</p>
        {claimEndsDelivery(v3, withdrawals.data) && <p className={styles.rowNote}>{CLAIM_ENDS_DELIVERY}</p>}
        {flows.error && <p className={styles.rowError}>{flows.error}</p>}
      </div>
    );
  }
  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <p className={styles.rowText}>{amount} is back on Base and ready to claim.</p>
        <div className={styles.rowActions}>
          {/* Claim as USDC first, and after a sale held by the price check (flows.error says why) the TAO itself, which
              is always there to claim; v3.2's Receive TAO asked for it as TAO, so that leads (stake-form.ts). The first
              names the unstakes it pays, so it waits until they have loaded; if they can't be read it claims without
              naming them (the chain needs no names) */}
          {claimChoices({ keepsTao: askedTao, saleHeld: flows.saleHeld }).map((choice, i) => (
            <button
              key={choice.label}
              type="button"
              className={i === 0 ? "pill pill-sm" : "pill pill-ghost pill-sm"}
              disabled={flows.busy !== null || (i === 0 && !withdrawals.data && !withdrawals.isError)}
              onClick={() => {
                setPressed(choice.keepTao);
                void flows
                  .claim(ready, choice.keepTao)
                  .catch(() => undefined)
                  .finally(() => setPressed(null));
              }}
            >
              {claimButtonLabel(choice, { busy: flows.busy, pressed })}
            </button>
          ))}
        </div>
      </div>
      {claimEndsDelivery(v3, withdrawals.data) && <p className={styles.rowNote}>{CLAIM_ENDS_DELIVERY}</p>}
      {flows.error && <p className={styles.rowError}>{flows.error}</p>}
    </div>
  );
}

/** "See your TAO in your wallet" (the founder's request; Task 59b): while the claim banner offers TAO waiting on Base
 * (ClaimReady's own rule: not while its USDC is being delivered automatically), or TAO sits in the wallet, Add to
 * wallet, so the wallet shows ForeverMoney's TAO (AddToWallet.tsx). One line under the claim and the wallet's TAO, on
 * v3-launch and v3.2 alike; hidden otherwise. */
export function SeeTaoInWallet({ account }: { account: string }) {
  const v3 = useIsV3();
  const usdcDelivery = useUsdcDelivery();
  const balances = useBalances(account);
  const withdrawals = useWithdrawals(account);
  const claimable = balances.data?.claimable ?? 0n;
  const tao = balances.data?.tao ?? 0n;
  // with USDC delivery off the claim banner offers whatever waits (Task 60)
  const claimShown = !usdcDelivery
    ? claimable > 0n
    : claimChecking(claimable, v3, withdrawals.data) || offerClaim(claimable, v3, withdrawals.data, withdrawals.isError);
  if (!claimShown && tao === 0n) return null;
  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <p className={styles.rowText}>{SEE_YOUR_TAO}</p>
        <AddToWallet noteClassName={`${styles.rowNote} ${styles.rowFull}`} />
      </div>
    </div>
  );
}

/** The main card on the stake page: account summary on top, the stake form below. `initialAmount` is
 * what a link typed into the form (`/stake?amount=…`, "Stake again at today's price"), as typed text. */
export function StakeCard({ account, initialAmount = "" }: { account: string | null; initialAmount?: string }) {
  // a retired deployment: the card keeps what waits to be claimed and the wallet's TAO, and no stake form (the page
  // says it is retired above it: StakeScreen)
  const retired = useRetired();
  const balance = useUsdcBalance();
  const avail = availableToStake(balance);
  const [sent, setSent] = useState<SentNotice | null>(null);
  // the stake form's amount: where focus goes when the wallet TAO's panel closes (its button is gone by then)
  const amountRef = useRef<HTMLInputElement>(null);

  return (
    <div className={app.card}>
      <div className={styles.summary}>
        <div>
          <p className={styles.k}>
            Your USDC
            {account && <span className={styles.liveDot} aria-hidden="true" />}
          </p>
          {/* a skeleton while the wallet's balance is read, a dash when it can't be; never a remembered balance */}
          <p className={styles.v}>{!account ? "–" : balance.status === "success" ? avail.text : <Dash loading={balance.status === "pending"} />}</p>
        </div>
        {account ? (
          <StakedSummary account={account} />
        ) : (
          <div>
            <p className={styles.k}>Your stake</p>
            <p className={styles.v}>–</p>
          </div>
        )}
        {account && <ClaimReady account={account} />}
        {account && <WalletTao account={account} onSent={setSent} />}
        {account && <SeeTaoInWallet account={account} />}
      </div>
      {!retired && (
        <div className={styles.form}>
          <StakeForm account={account} initialAmount={initialAmount} maxUsdc={account ? avail.max : null} amountRef={amountRef} />
        </div>
      )}
      <SentDialog notice={sent} onClose={() => setSent(null)} returnFocus={amountRef} />
    </div>
  );
}
