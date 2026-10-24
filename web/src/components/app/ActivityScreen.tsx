"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useCascadeAccount } from "@/lib/account";
import { useDeposit, useDeposits, usePosition, useWithdrawal, useWithdrawals } from "@/lib/cascade/hooks";
import { parseActivityParams } from "@/lib/activity-params";
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

function DepositDetail({ account, id }: { account: string; id: string }) {
  const { data: deposit, isPending, isError, refetch } = useDeposit(account, id);
  const { data: position } = usePosition(account);
  if (isError) return <LoadError what="this deposit" onRetry={() => void refetch()} />;
  if (isPending) return <Loading />;
  if (!deposit) return <NotFound what="deposit" />;

  const inProgress = deposit.status === "in_progress";
  const amount = formatUsdShort(deposit.amountUsd);
  return (
    <>
      <BackLink />
      <div className={`${app.card} ${styles.panel}`}>
        <p className={styles.kicker}>{formatDay(deposit.createdAt)} deposit</p>
        <h2 className={styles.panelTitle}>
          {inProgress ? `Where your ${amount} is going` : `Where your ${amount} went`}
        </h2>
        <Trail steps={deposit.steps} label="Deposit steps" />
        <dl className={styles.rows}>
          {inProgress ? (
            <div>
              <dt>You will receive</dt>
              <dd>about {formatTao(deposit.taoAmount, 2)} TAO</dd>
            </div>
          ) : (
            <div>
              <dt>Worth now</dt>
              <dd>
                {position
                  ? formatUsd((deposit.taoAmount + deposit.rewardsTao) * position.taoPriceUsd)
                  : "–"}
              </dd>
            </div>
          )}
        </dl>
      </div>
    </>
  );
}

function WithdrawalDetail({ account, id }: { account: string; id: string }) {
  const { data: withdrawal, isPending, isError, refetch } = useWithdrawal(account, id);
  if (isError) return <LoadError what="this unstake" onRetry={() => void refetch()} />;
  if (isPending) return <Loading />;
  if (!withdrawal) return <NotFound what="unstake" />;

  const paid = withdrawal.status === "paid";
  const tao = formatTao(withdrawal.taoAmount, 2);
  return (
    <>
      <BackLink />
      <div className={`${app.card} ${styles.panel}`}>
        <p className={styles.kicker}>{formatDay(withdrawal.createdAt)} unstake</p>
        <h2 className={styles.panelTitle}>
          {paid ? `Where your ${tao} TAO went` : `Where your ${tao} TAO is going`}
        </h2>
        <Trail steps={withdrawal.steps} label="Unstake steps" />
        <dl className={styles.rows}>
          <div>
            <dt>{paid ? "You received" : "You will receive"}</dt>
            <dd>
              {paid ? "" : "about "}
              {formatUsdc(withdrawal.usdcAmount)} USDC on Base
            </dd>
          </div>
        </dl>
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
  const account = state.status === "wallet" || state.status === "demo" ? state.account : null;

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
