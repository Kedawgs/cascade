"use client";

import Link from "next/link";
import { SOURCE_CHAINS, availabilityText } from "@/lib/cascade/chains";
import { useApy, useProtocolStats, useRetired } from "@/lib/cascade/hooks";
import { formatUsdCompact } from "@/lib/format";
import { APY_KEEP_MS, APY_NOTE_SHORT, formatApy, shownFigure, STATS_KEEP_MS, totalStakedUsd } from "@/lib/stats";
import { RetiredNotice } from "../app/RetiredNotice";
import { Dash } from "../Dash";
import { Mark } from "../Logo";
import { HeroMark } from "./HeroMark";
import styles from "./Landing.module.css";

export function Hero() {
  const retired = useRetired();
  const stats = useProtocolStats();
  const apy = useApy();
  const apyShown = shownFigure(apy, APY_KEEP_MS);
  // the total has a place from a dollar up, decided by the first figures there are (the snapshot's, so
  // at first paint) and kept through failed reads; its value is the one there is to show
  const total = totalStakedUsd(stats.data);
  const totalShown = totalStakedUsd(shownFigure(stats, STATS_KEEP_MS));

  return (
    <header className={styles.hero}>
      {/* narrow screens only, where the animation is hidden: the mark's three steps behind the copy */}
      <div className={styles.heroSteps} aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
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
            {/* every figure keeps its place (a dash until it is known), so the Stake button never moves */}
            <div>
              <p className={`${styles.statV} ${styles.statAccent} ${styles.statApy}`}>
                {apyShown !== undefined ? formatApy(apyShown) : <Dash loading={apy.isPending} />}
              </p>
              <p className={styles.statK}>APY in TAO*</p>
            </div>
            <span className={styles.vr} aria-hidden="true" />
            {total !== undefined && total >= 1 && (
              <div>
                <p className={`${styles.statV} ${styles.statTotal}`}>
                  {totalShown !== undefined ? formatUsdCompact(totalShown) : <Dash loading={false} />}
                </p>
                <p className={styles.statK}>Total staked</p>
              </div>
            )}
            {/* a retired deployment has no stake to lead to (Task 60 follow-up): the plan's sentence below instead */}
            {!retired && (
              <Link href="/stake" className={`pill ${styles.heroCta}`}>
                <span className={styles.ctaIcon} aria-hidden="true">
                  <Mark size={18} />
                </span>
                Stake
              </Link>
            )}
          </div>
          <RetiredNotice />
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
          <p className={styles.fine}>
            {APY_NOTE_SHORT} <Link href="/faq/#apy">How it&apos;s worked out</Link>
          </p>
        </div>
      </div>
    </header>
  );
}
