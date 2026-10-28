"use client";

import Link from "next/link";
import { SOURCE_CHAINS, availabilityText } from "@/lib/cascade/chains";
import { useApy, useProtocolStats } from "@/lib/cascade/hooks";
import { formatUsdShort } from "@/lib/format";
import { APY_FOOTNOTE, formatApy } from "@/lib/stats";
import { Mark } from "../Logo";
import { HeroMark } from "./HeroMark";
import styles from "./Landing.module.css";

export function Hero() {
  const stats = useProtocolStats();
  const apy = useApy();
  // the APY's place is kept while it loads, so the Stake button doesn't jump when it arrives
  const showApy = apy.isPending || apy.data !== undefined;

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
            {showApy && (
              <>
                <div>
                  <p className={`${styles.statV} ${styles.statAccent}`}>{apy.data !== undefined ? formatApy(apy.data) : "–"}</p>
                  <p className={styles.statK}>APY in TAO*</p>
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
          {apy.data !== undefined && <p className={styles.fine}>{APY_FOOTNOTE}</p>}
        </div>
      </div>
    </header>
  );
}
