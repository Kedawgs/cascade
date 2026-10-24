"use client";

import { usePosition, useProtocolStats, useRewards } from "@/lib/cascade/hooks";
import { formatDay, formatSignedTao, formatTao, formatUsd } from "@/lib/format";
import { formatApr } from "@/lib/stats";
import { ConnectWallet } from "../ConnectWallet";
import { LoadError } from "../LoadError";
import { Loading } from "../Loading";
import { SampleTag } from "../SampleTag";
import app from "./App.module.css";
import card from "./StakeCard.module.css";
import styles from "./RewardsCard.module.css";

const EMPTY = "Rewards start the day after your first deposit is staked.";
const SHOW_DAYS = 14;

function Apr() {
  const stats = useProtocolStats();
  return (
    <div>
      <p className={card.k}>Current APR*</p>
      <p className={`${card.v} ${card.apr}`}>
        {stats.data?.aprPercent !== undefined ? (
          <>
            {formatApr(stats.data.aprPercent)}
            <SampleTag />
          </>
        ) : (
          "–"
        )}
      </p>
    </div>
  );
}

function RewardsForAccount({ account }: { account: string }) {
  const position = usePosition(account);
  const rewards = useRewards(account);
  if (position.isError || rewards.isError) {
    return (
      <LoadError
        what="your rewards"
        onRetry={() => {
          void position.refetch();
          void rewards.refetch();
        }}
      />
    );
  }
  if (!position.data || !rewards.data) return <Loading />;

  const earned = position.data.rewardsEarnedTao;
  const recent = [...rewards.data].reverse().slice(0, SHOW_DAYS);

  return (
    <>
      <div className={card.summary}>
        <div>
          <p className={card.k}>Earned so far</p>
          <p className={card.v}>
            {formatTao(earned, 4)} TAO <small>{formatUsd(earned * position.data.taoPriceUsd)}</small>
          </p>
        </div>
        <Apr />
      </div>
      {recent.length === 0 ? (
        <p className={styles.empty}>{EMPTY}</p>
      ) : (
        <ol className={styles.list} aria-label="Recent rewards">
          {recent.map((r) => (
            <li key={r.date.toISOString()} className={styles.row}>
              <span className={styles.day}>{formatDay(r.date)}</span>
              <span className={styles.amount}>
                {formatSignedTao(r.taoAccrued)} TAO
                <small>{formatTao(r.runningTotalTao, 4)} TAO so far</small>
              </span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

/** One card: what has been earned, the current APR, and the last two weeks of rewards. */
export function RewardsCard({ account }: { account: string | null }) {
  return (
    <div className={app.card}>
      {account ? (
        <RewardsForAccount account={account} />
      ) : (
        <>
          <div className={card.summary}>
            <div>
              <p className={card.k}>Earned so far</p>
              <p className={card.v}>–</p>
            </div>
            <Apr />
          </div>
          <div className={styles.connect}>
            <p className={styles.empty}>{EMPTY}</p>
            <ConnectWallet variant="pill-block" />
          </div>
        </>
      )}
    </div>
  );
}
