"use client";

import Link from "next/link";
import { SOURCE_CHAINS, availabilityText } from "@/lib/cascade/chains";
import { useProtocolStats } from "@/lib/cascade/hooks";
import { formatUsdShort } from "@/lib/format";
import { formatApr } from "@/lib/stats";
import { Mark } from "../Logo";
import { HeroMark } from "./HeroMark";
import styles from "./Landing.module.css";

export function Hero() {
  const stats = useProtocolStats();

  const s = stats.data;
  const totalUsd =
    s?.totalStakedTao !== undefined && s.taoPriceUsd !== undefined
      ? s.totalStakedTao * s.taoPriceUsd
      : undefined;

  return (
    <header className={styles.hero}>
      <div className={`wrap ${styles.heroGrid}`}>
        <div className={styles.art}>
          <HeroMark />
        </div>
        <div className={styles.copy}>
          <h1 className={styles.h1}>
            Get exposure to <strong>TAO staking</strong>
          </h1>
          <p className={styles.lead}>Deposit USDC from the wallet you already have.</p>
          <div className={styles.stats}>
            {s?.aprPercent !== undefined && (
              <>
                <div>
                  <p className={`${styles.statV} ${styles.statAccent}`}>{formatApr(s.aprPercent)}</p>
                  <p className={styles.statK}>APR*</p>
                </div>
                <span className={styles.vr} aria-hidden="true" />
              </>
            )}
            {totalUsd !== undefined && totalUsd >= 1 && (
              <div>
                <p className={styles.statV}>{formatUsdShort(totalUsd)}</p>
                <p className={styles.statK}>Total staked</p>
              </div>
            )}
            <Link href="/stake" className={`pill ${styles.heroCta}`}>
              <span className={styles.ctaIcon} aria-hidden="true">
                <Mark size={18} />
              </span>
              Stake
            </Link>
          </div>
          <p className={styles.chainsRow}>
            <span className={styles.chainStack} aria-hidden="true">
              {SOURCE_CHAINS.map((c) => (
                <span
                  key={c.id}
                  className={`${styles.chainDot} ${c.status === "soon" ? styles.chainSoon : ""}`}
                  style={{ background: c.color }}
                  title={c.status === "soon" ? `${c.label}, coming soon` : c.label}
                >
                  {c.label[0]}
                </span>
              ))}
            </span>
            {availabilityText()}
          </p>
          {s?.aprPercent !== undefined && (
            <p className={styles.fine}>*Average over the last 7 days. Changes with the network and is not guaranteed.</p>
          )}
        </div>
      </div>
    </header>
  );
}
