"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { useCascadeAccount } from "@/lib/account";
import { useDeposit, useDeposits, usePosition, useWithdrawal, useWithdrawals } from "@/lib/cascade/hooks";
import { parseActivityParams } from "@/lib/activity-params";
import { toDisplay } from "@/lib/cascade/units";
import { useFlows } from "@/lib/cascade/use-flows";
import { formatDay, formatTao, formatUsd, formatUsdc, formatUsdShort } from "@/lib/format";
import { DepositList, WithdrawalList } from "../ActivityList";
import { ConnectWallet } from "../ConnectWallet";
import { LoadError } from "../LoadError";
import { Loading } from "../Loading";
import { Trail } from "../Trail";
import app from "./App.module.css";
import { AppShell } from "./AppShell";
import styles from "./ActivityScreen.module.css";

function BackLink() {
  return (
    <Link href="/activity" className={styles.back}>
      Back to activity
    </Link>
  );
}

function NotFound({ what }: { what: "deposit" | "unstake" }) {
  return (
    <div className={`${app.card} ${styles.panel}`}>
      <p className={styles.panelTitle}>We couldn&apos;t find this {what}.</p>
      <p className={styles.panelText}>It may belong to a different wallet.</p>
      <BackLink />
    </div>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className={styles.actions}>{children}</div>;
}

function DepositDetail({ account, id }: { account: string; id: string }) {
  const { data: deposit, isPending, isError, refetch } = useDeposit(account, id);
  const { data: position } = usePosition(account);
  const flows = useFlows(account);
  if (isError) return <LoadError what="this deposit" onRetry={() => void refetch()} />;
  if (isPending) return <Loading />;
  if (!deposit) return <NotFound what="deposit" />;

  const staked = deposit.status === "staked";
  const amount = deposit.amountUsd !== undefined ? formatUsdShort(deposit.amountUsd) : `${formatTao(deposit.taoAmount, 4)} TAO`;
  return (
    <>
      <BackLink />
      <div className={`${app.card} ${styles.panel}`}>
        <p className={styles.kicker}>{formatDay(deposit.createdAt)} deposit</p>
        <h2 className={styles.panelTitle}>{staked ? `Where your ${amount} went` : `Where your ${amount} is going`}</h2>
        <Trail steps={deposit.steps} label="Deposit steps" />
        <dl className={styles.rows}>
          <div>
            <dt>{staked ? "Worth now" : "TAO in this deposit"}</dt>
            <dd>
              {staked
                ? position
                  ? formatUsd(deposit.taoAmount * position.taoPriceUsd)
                  : "–"
                : `${formatTao(deposit.taoAmount, 4)} TAO`}
            </dd>
          </div>
          {deposit.feesUsd !== undefined && (
            <div>
              <dt>Swap fees</dt>
              <dd>{formatUsd(deposit.feesUsd)}</dd>
            </div>
          )}
        </dl>
        {(deposit.status === "needs_you" || deposit.cancellableWei !== undefined) && (
          <Actions>
            {deposit.status === "needs_you" && (
              <button type="button" className="pill pill-block" disabled={flows.busy !== null} onClick={() => void flows.resumeStake(id).catch(() => undefined)}>
                {flows.busy === "stake" ? "Confirm in your wallet…" : "Continue this deposit"}
              </button>
            )}
            {deposit.cancellableWei !== undefined && (
              <button
                type="button"
                className="pill pill-ghost pill-block"
                disabled={flows.busy !== null}
                onClick={() => void flows.cancel("deposit", deposit.cancellableWei as bigint).catch(() => undefined)}
              >
                Take it back before the batch closes
              </button>
            )}
          </Actions>
        )}
        {flows.error && (
          <p role="alert" className={styles.alert}>
            {flows.error}
          </p>
        )}
      </div>
    </>
  );
}

function WithdrawalDetail({ account, id }: { account: string; id: string }) {
  const { data: withdrawal, isPending, isError, refetch } = useWithdrawal(account, id);
  const flows = useFlows(account);
  if (isError) return <LoadError what="this unstake" onRetry={() => void refetch()} />;
  if (isPending) return <Loading />;
  if (!withdrawal) return <NotFound what="unstake" />;

  const paid = withdrawal.status === "paid";
  const tao = formatTao(withdrawal.taoAmount, 4);
  return (
    <>
      <BackLink />
      <div className={`${app.card} ${styles.panel}`}>
        <p className={styles.kicker}>{formatDay(withdrawal.createdAt)} unstake</p>
        <h2 className={styles.panelTitle}>{paid ? `Where your ${tao} TAO went` : `Where your ${tao} TAO is going`}</h2>
        <Trail steps={withdrawal.steps} label="Unstake steps" />
        <dl className={styles.rows}>
          {withdrawal.usdcAmount !== undefined && (
            <div>
              <dt>{paid ? "You received" : "You will receive"}</dt>
              <dd>
                {paid ? "" : "about "}
                {formatUsdc(withdrawal.usdcAmount)} USDC on Base
              </dd>
            </div>
          )}
          {withdrawal.claimable > 0n && (
            <div>
              <dt>Waiting for you on Base</dt>
              <dd>{formatTao(toDisplay(withdrawal.claimable, 18), 4)} TAO</dd>
            </div>
          )}
        </dl>
        {(withdrawal.status === "ready" || withdrawal.cancellableShares !== undefined) && (
          <Actions>
            {withdrawal.status === "ready" && (
              <>
                <button type="button" className="pill pill-block" disabled={flows.busy !== null} onClick={() => void flows.claim(false).catch(() => undefined)}>
                  {flows.busy === "claim" ? "Confirm in your wallet…" : "Claim as USDC"}
                </button>
                <button type="button" className="pill pill-ghost pill-block" disabled={flows.busy !== null} onClick={() => void flows.claim(true).catch(() => undefined)}>
                  Keep it as TAO
                </button>
              </>
            )}
            {withdrawal.cancellableShares !== undefined && (
              <button
                type="button"
                className="pill pill-ghost pill-block"
                disabled={flows.busy !== null}
                onClick={() => void flows.cancel("withdrawal", withdrawal.cancellableShares as bigint).catch(() => undefined)}
              >
                Cancel before the batch closes
              </button>
            )}
          </Actions>
        )}
        {flows.error && (
          <p role="alert" className={styles.alert}>
            {flows.error}
          </p>
        )}
      </div>
    </>
  );
}

function Lists({ account }: { account: string }) {
  const deposits = useDeposits(account);
  const withdrawals = useWithdrawals(account);
  if (deposits.isError || withdrawals.isError) {
    return (
      <LoadError
        what="your activity"
        onRetry={() => {
          void deposits.refetch();
          void withdrawals.refetch();
        }}
      />
    );
  }
  if (!deposits.data || !withdrawals.data) return <Loading />;
  return (
    <>
      <section className={styles.section} aria-labelledby="deposits-heading">
        <h2 id="deposits-heading" className={styles.heading}>
          Your deposits
        </h2>
        <DepositList deposits={deposits.data} />
      </section>
      {withdrawals.data.length > 0 && (
        <section className={styles.section} aria-labelledby="unstakes-heading">
          <h2 id="unstakes-heading" className={styles.heading}>
            Your unstakes
          </h2>
          <WithdrawalList withdrawals={withdrawals.data} />
        </section>
      )}
    </>
  );
}

function ActivityBody({ account }: { account: string }) {
  const params = useSearchParams();
  const view = parseActivityParams(params);
  if (view.kind === "deposit") return <DepositDetail account={account} id={view.id} />;
  if (view.kind === "withdrawal") return <WithdrawalDetail account={account} id={view.id} />;
  return <Lists account={account} />;
}

/** `/activity`: the lists, or one receipt trail when the query string names a deposit or unstake. */
export function ActivityScreen() {
  const { state } = useCascadeAccount();
  const account = state.status === "wallet" ? state.account : null;

  return (
    <AppShell active="activity">
      <h1 className={app.title}>Activity</h1>
      <p className={app.sub}>Every deposit and unstake, with receipts</p>
      {state.status === "loading" ? (
        <Loading />
      ) : account ? (
        <Suspense fallback={<Loading />}>
          <ActivityBody account={account} />
        </Suspense>
      ) : (
        <div className={`${app.card} ${styles.panel}`}>
          <p className={styles.panelTitle}>Connect a wallet to see your activity.</p>
          <p className={styles.panelText}>Your deposits and unstakes show up here with a receipt for every step.</p>
          <ConnectWallet variant="pill-block" />
        </div>
      )}
    </AppShell>
  );
}
