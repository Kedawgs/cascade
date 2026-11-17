"use client";

import Link from "next/link";
import { useIsV3, useIsV32, usePendingRewards, usePosition, usePositionHistory, useRewards, useRewardVesting, useShownTaoPrice } from "@/lib/cascade/hooks";
import { FAQ_FACTS, waitText } from "@/lib/faq";
import { formatDay, formatSignedTao, formatTao, formatUsd } from "@/lib/format";
import { ConnectWallet } from "../ConnectWallet";
import { Dash } from "../Dash";
import { Figure } from "../Figure";
import { LoadError } from "../LoadError";
import { Loading } from "../Loading";
import app from "./App.module.css";
import card from "./StakeCard.module.css";
import styles from "./RewardsCard.module.css";

const SHOW_DAYS = 14;

/** How rewards reach a balance, in one sentence: how often they are collected, and how long they take to be added
 * (the founder, 2026-11-16: "should explain the 30 day claim and drip and also not as wordy"). The FAQ has the rest.
 * - v3.2: the keeper collects at least every FAQ_FACTS.v32.claimRoundDays days; the owner's vesting period is read from
 *   the vault's lens (`vestingS`), and until it is read the sentence says its limit (30 days at most).
 * - every other deployment: collected when enough is waiting, added over its vault's constant. */
export function rewardsSchedule(o: { v32: boolean; vestingS?: number }): string {
  if (!o.v32) return `Cascade collects rewards for everyone when enough is waiting, then adds them to balances gradually over ${FAQ_FACTS.vestingDays} days.`;
  const known = o.vestingS !== undefined && Number.isFinite(o.vestingS) && o.vestingS > 0;
  const over = known ? `over ${waitText(o.vestingS as number)}` : "over up to 30 days";
  return `Cascade collects rewards for everyone at least every ${FAQ_FACTS.v32.claimRoundDays} days, then adds them to balances gradually ${over}.`;
}

/** The schedule's sentence, with where an account's rewards will show while it has none yet, and the FAQ's answer. */
function Schedule({ none }: { none: boolean }) {
  const v32 = useIsV32();
  const vesting = useRewardVesting();
  return (
    <p className={styles.note}>
      {rewardsSchedule({ v32, vestingS: vesting.data?.rewardVestingS })}
      {none ? " Yours show here as they are added." : ""} <Link href="/faq/#how-rewards-arrive">How rewards work</Link>
    </p>
  );
}

/** The TAO price as information (hooks.ts useShownTaoPrice: never the server's snapshot's). */
function Price() {
  const price = useShownTaoPrice();
  return (
    <div>
      <p className={card.k}>TAO price</p>
      <p className={card.v}>
        <Figure value={price.value} format={formatUsd} loading={price.loading} />
      </p>
    </div>
  );
}

function RewardsForAccount({ account }: { account: string }) {
  const v3 = useIsV3();
  const position = usePosition(account);
  // what has been earned needs the vault's history: it follows the balance, with a skeleton in its place meanwhile
  const history = usePositionHistory(account);
  const rewards = useRewards(account);
  // v3: what is earned and not collected yet, its own read beside the balance's: the line shows once it is known
  const pending = usePendingRewards(account);
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

  const earned = history.data?.rewardsEarnedTao;
  const waiting = pending.data ?? undefined;
  const recent = [...rewards.data].reverse().slice(0, SHOW_DAYS);

  return (
    <>
      <div className={card.summary}>
        <div>
          <p className={card.k}>Earned so far</p>
          <p className={card.v}>
            {!history.data ? (
              <Dash loading={!history.isError} />
            ) : history.data.provisional ? (
              // the history came from the indexer and the chain hasn't confirmed all of it: no figure yet
              <>
                –<small>checking…</small>
              </>
            ) : earned !== undefined ? (
              <>
                {position.data.priceMissing ? `${formatTao(earned, 6)} TAO` : formatUsd(earned * position.data.taoPriceUsd)}{" "}
                {!position.data.priceMissing && <small>{formatTao(earned, 6)} TAO</small>}
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
          <span>Earned, not yet collected</span>
          <span className={styles.waitingValue}>
            {formatTao(waiting, 6)} TAO
            {!position.data.priceMissing && <small>{formatUsd(waiting * position.data.taoPriceUsd)}</small>}
          </span>
        </p>
      )}
      <Schedule none={recent.length === 0} />
      {recent.length > 0 && (
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
          <Schedule none />
          <div className={styles.connect}>
            <ConnectWallet variant="pill-block" />
          </div>
        </>
      )}
    </div>
  );
}
