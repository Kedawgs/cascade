"use client";

import { usePosition, useProtocolStats } from "@/lib/cascade/hooks";
import { formatTao, formatUsd } from "@/lib/format";
import { formatApr } from "@/lib/stats";
import { useUsdcBalance } from "@/lib/use-usdc-balance";
import { availableToStake } from "@/lib/usdc-balance";
import { SampleTag } from "../SampleTag";
import app from "./App.module.css";
import { StakeForm } from "./StakeForm";
import styles from "./StakeCard.module.css";

function StakedSummary({ account }: { account: string }) {
  const position = usePosition(account);
  return (
    <div>
      <p className={styles.k}>Staked</p>
      <p className={styles.v}>
        {position.data ? (
          <>
            {formatTao(position.data.taoBalance, 2)} TAO{" "}
            <small>{formatUsd(position.data.usdValue)}</small>
          </>
        ) : (
          "–"
        )}
      </p>
    </div>
  );
}

/** The main card on the stake page: account summary on top, the stake form below. */
export function StakeCard({ account }: { account: string | null }) {
  const stats = useProtocolStats();
  const balance = useUsdcBalance();
  const avail = availableToStake(balance);

  return (
    <div className={app.card}>
      <div className={styles.summary}>
        <div>
          <p className={styles.k}>
            Available to stake
            {account && <span className={styles.liveDot} aria-hidden="true" />}
          </p>
          <p className={styles.v}>{account ? avail.text : "–"}</p>
        </div>
        <div>
          <p className={styles.k}>Network</p>
          <p className={styles.v}>
            <span className={styles.base} aria-hidden="true" />
            Base
          </p>
        </div>
        {account ? (
          <StakedSummary account={account} />
        ) : (
          <div>
            <p className={styles.k}>Staked</p>
            <p className={styles.v}>–</p>
          </div>
        )}
        <div>
          <p className={styles.k}>Cascade APR*</p>
          <p className={`${styles.v} ${styles.apr}`}>
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
      </div>
      <div className={styles.form}>
        <StakeForm account={account} maxUsdc={account ? avail.max : null} />
      </div>
    </div>
  );
}
