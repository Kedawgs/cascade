"use client";

import Link from "next/link";
import { useDepositQuote, useProtocolStats } from "@/lib/cascade/hooks";
import { formatUsdShort } from "@/lib/format";
import { formatApr } from "@/lib/stats";
import { ChainChips } from "../app/ChainChips";
import { MoneyFlow } from "./MoneyFlow";
import styles from "./Landing.module.css";

/** The amount the illustration is drawn for, quoted live (20 USDC, 6 decimals). */
const EXAMPLE_USDC = 20_000_000n;

export function Hero() {
  const stats = useProtocolStats();
  const quote = useDepositQuote(EXAMPLE_USDC);

  const s = stats.data;
  const totalUsd =
    s?.totalStakedTao !== undefined && s.taoPriceUsd !== undefined
      ? s.totalStakedTao * s.taoPriceUsd
      : undefined;

  return (
    <header className={styles.hero}>
      <div className={`wrap ${styles.heroGrid}`}>
        <MoneyFlow quote={quote.data} aprPercent={s?.aprPercent} />
        <div className={styles.copy}>
          <h1 className={styles.h1}>
            Get exposure to <strong>TAO staking</strong>
          </h1>
          <p className={styles.lead}>
            Simple and easy, from the wallet you already have. Deposit USDC, we swap it to TAO and
            stake it on Bittensor for you.
          </p>
          <div className={styles.stats}>
            {s?.aprPercent !== undefined && (
              <>
                <div className={styles.stat}>
                  <p className={`${styles.statV} ${styles.statAccent}`}>{formatApr(s.aprPercent)}</p>
                  <p className={styles.statK}>APR, paid in TAO*</p>
                </div>
                <span className={styles.vr} aria-hidden="true" />
              </>
            )}
            <div className={styles.stat}>
              <p className={styles.statV}>{totalUsd !== undefined ? formatUsdShort(totalUsd) : "–"}</p>
              <p className={styles.statK}>staked through Cascade</p>
            </div>
            <Link href="/stake" className={`pill ${styles.heroCta}`}>
              Stake
            </Link>
          </div>
          <div className={styles.chainsRow}>
            <span className={styles.chainsLabel}>Deposit from</span>
            <ChainChips value="base" readOnly />
          </div>
          {s?.aprPercent !== undefined && (
            <p className={styles.fine}>*Average over the last 7 days. Changes with the network and is not guaranteed.</p>
          )}
        </div>
      </div>
    </header>
  );
}
