"use client";

import { useIsV3, usePosition, useProtocolStats, useRewards, useTaoPrice } from "@/lib/cascade/hooks";
import { formatDay, formatSignedTao, formatTao, formatUsd } from "@/lib/format";
import { ConnectWallet } from "../ConnectWallet";
import { Dash } from "../Dash";
import { LoadError } from "../LoadError";
import { Loading } from "../Loading";
import app from "./App.module.css";
import card from "./StakeCard.module.css";
import styles from "./RewardsCard.module.css";

const EMPTY = "Your rewards show here once the first ones are collected. Cascade collects them for everyone and adds them to your balance.";
const SHOW_DAYS = 14;

/** The TAO price, live (a live read's only). */
function Price() {
  const stats = useProtocolStats();
  const price = useTaoPrice();
  return (
    <div>
      <p className={card.k}>TAO price</p>
      <p className={card.v}>{price !== undefined ? formatUsd(price) : <Dash loading={!stats.isError} />}</p>
    </div>
  );
}

function RewardsForAccount({ account }: { account: string }) {
  const v3 = useIsV3();
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
  const waiting = position.data.pendingRewardsTao;
  const recent = [...rewards.data].reverse().slice(0, SHOW_DAYS);

  return (
    <>
      <div className={card.summary}>
        <div>
          <p className={card.k}>Earned so far</p>
          <p className={card.v}>
            {earned !== undefined ? (
              <>
                {formatUsd(earned * position.data.taoPriceUsd)} <small>{formatTao(earned, 6)} TAO</small>
              </>
            ) : (
              "–"
            )}
          </p>
        </div>
        <Price />
      </div>
      {v3 && waiting !== undefined && (
        <p className={styles.waiting}>
          Earned, not yet collected: {formatTao(waiting, 6)} TAO ({formatUsd(waiting * position.data.taoPriceUsd)}). Cascade collects rewards for everyone when
          enough is waiting and adds them to your balance.
        </p>
      )}
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

/** One card: what has been earned, and the last two weeks of rewards. */
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
            <Price />
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
