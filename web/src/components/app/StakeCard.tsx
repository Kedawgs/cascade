"use client";

import { useRouter } from "next/navigation";
import { useBalances, useIsV3, useLimits, usePosition, useTaoPrice, useWithdrawals } from "@/lib/cascade/hooks";
import { offersClaim } from "@/lib/cascade/trail";
import { toDisplay } from "@/lib/cascade/units";
import { useFlows } from "@/lib/cascade/use-flows";
import { formatTao, formatUsd } from "@/lib/format";
import { CLAIM_ENDS_DELIVERY, claimEndsDelivery, offerClaim, walletTaoNote } from "@/lib/stake-form";
import { useUsdcBalance } from "@/lib/use-usdc-balance";
import { availableToStake } from "@/lib/usdc-balance";
import { Dash } from "../Dash";
import app from "./App.module.css";
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
            <small>{formatUsd(position.data.usdValue)}</small>
          </>
        ) : (
          <Dash loading={!position.isError} />
        )}
      </p>
    </div>
  );
}

/** TAO sitting in the wallet on Base (after a cancel, a claim kept as TAO, or a step that stopped):
 * deposit it, or swap it back to USDC. Hidden when there is none. */
function WalletTao({ account }: { account: string }) {
  const router = useRouter();
  const balances = useBalances(account);
  const limits = useLimits();
  const flows = useFlows(account);
  const tao = balances.data?.tao ?? 0n;
  if (tao === 0n) return null;
  // why it can't be deposited as it is (null when it can); unknown until the limits load
  const note = limits.data ? walletTaoNote(tao, limits.data) : undefined;
  const canDeposit = note === null;
  return (
    <div className={styles.walletTao}>
      <p>
        You have <b>{formatTao(toDisplay(tao, 18), 6)} TAO</b> in your wallet on Base.
      </p>
      <div className={styles.walletTaoActions}>
        {canDeposit && (
          <button
            type="button"
            className="pill"
            disabled={flows.locked}
            onClick={() =>
              void flows.depositWalletTao(tao).then((id) => router.push(`/activity?deposit=${id}`), () => undefined)
            }
          >
            Deposit it
          </button>
        )}
        <button type="button" className="pill pill-ghost" disabled={flows.busy !== null} onClick={() => void flows.sellWalletTao(tao).catch(() => undefined)}>
          Swap to USDC
        </button>
      </div>
      {note && <p className={styles.walletTaoNote}>{note}</p>}
      {flows.error && <p className={styles.walletTaoError}>{flows.error}</p>}
    </div>
  );
}

/** Money waiting on Base to be claimed (an unstake's payout, or a deposit the vault sent back), with
 * one button that claims it all as USDC. Hidden when there is none, and on v3 while an unstake's USDC
 * is being delivered automatically and none offers the claim by hand (see offerClaim). */
function ClaimReady({ account }: { account: string }) {
  const v3 = useIsV3();
  const balances = useBalances(account);
  const price = useTaoPrice();
  const withdrawals = useWithdrawals(account);
  const flows = useFlows(account);
  const claimable = balances.data?.claimable ?? 0n;
  if (!offerClaim(claimable, v3, withdrawals.data, withdrawals.isError)) return null;
  const ready = (withdrawals.data ?? []).filter(offersClaim).map((w) => w.id);
  return (
    <div className={styles.walletTao}>
      <p>
        <b>{price !== undefined ? `About ${formatUsd(toDisplay(claimable, 18) * price)}` : `${formatTao(toDisplay(claimable, 18), 6)} TAO`}</b> is
        back on Base and ready to claim.
      </p>
      {claimEndsDelivery(v3, withdrawals.data) && <p className={styles.walletTaoNote}>{CLAIM_ENDS_DELIVERY}</p>}
      <div className={styles.walletTaoActions}>
        {/* the claim names the unstakes it pays, so it waits until they have loaded; if they can't be read
            it claims without naming them (the chain needs no names) */}
        <button
          type="button"
          className="pill"
          disabled={flows.busy !== null || (!withdrawals.data && !withdrawals.isError)}
          onClick={() => void flows.claim(ready, false).catch(() => undefined)}
        >
          {flows.busy === "claim" ? "Confirm in your wallet…" : "Claim as USDC"}
        </button>
      </div>
      {flows.error && <p className={styles.walletTaoError}>{flows.error}</p>}
    </div>
  );
}

/** The main card on the stake page: account summary on top, the stake form below. */
export function StakeCard({ account }: { account: string | null }) {
  const balance = useUsdcBalance();
  const avail = availableToStake(balance);

  return (
    <div className={app.card}>
      <div className={styles.summary}>
        <div>
          <p className={styles.k}>
            Your USDC
            {account && <span className={styles.liveDot} aria-hidden="true" />}
          </p>
          <p className={styles.v}>{account ? avail.text : "–"}</p>
        </div>
        {account ? (
          <StakedSummary account={account} />
        ) : (
          <div>
            <p className={styles.k}>Your stake</p>
            <p className={styles.v}>–</p>
          </div>
        )}
      </div>
      {account && <ClaimReady account={account} />}
      {account && <WalletTao account={account} />}
      <div className={styles.form}>
        <StakeForm account={account} maxUsdc={account ? avail.max : null} />
      </div>
    </div>
  );
}
