"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCascadeAccount } from "@/lib/account";
import { useDepositQuote, useProtocolStats } from "@/lib/cascade/hooks";
import { formatUsdShort } from "@/lib/format";
import { formatApr } from "@/lib/stats";
import { ChainChips } from "../app/ChainChips";
import { SampleTag } from "../SampleTag";
import { MoneyFlow } from "./MoneyFlow";
import styles from "./Landing.module.css";

/** The worked example shown in the hero and pre-filled in the stake section. */
export const SAMPLE_STAKE_USD = 500;

export function Hero() {
  const stats = useProtocolStats();
  const quote = useDepositQuote(SAMPLE_STAKE_USD, "base");
  const { startDemo } = useCascadeAccount();
  const router = useRouter();

  const s = stats.data;
  const totalUsd =
    s?.totalStakedTao !== undefined && s.taoPriceUsd !== undefined
      ? Math.round(s.totalStakedTao * s.taoPriceUsd)
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
            <div className={styles.stat}>
              <p className={`${styles.statV} ${styles.statAccent}`}>
                {s?.aprPercent !== undefined ? formatApr(s.aprPercent) : "–"}
              </p>
              <p className={styles.statK}>
                APR, paid in TAO*
                <SampleTag />
              </p>
            </div>
            <span className={styles.vr} aria-hidden="true" />
            <div className={styles.stat}>
              <p className={styles.statV}>{totalUsd !== undefined ? formatUsdShort(totalUsd) : "–"}</p>
              <p className={styles.statK}>
                staked through Cascade
                <SampleTag />
              </p>
            </div>
            <Link href="/stake" className={`pill ${styles.heroCta}`}>
              Stake
            </Link>
          </div>
          <div className={styles.chainsRow}>
            <span className={styles.chainsLabel}>Deposit from</span>
            <ChainChips value="base" readOnly />
          </div>
          <p className={styles.fine}>
            *Average over the last 7 days. Changes with the network and is not guaranteed.
          </p>
          <button
            type="button"
            className={styles.demoLink}
            onClick={() => {
              startDemo();
              router.push("/stake");
            }}
          >
            See the demo
          </button>
        </div>
      </div>
    </header>
  );
}
