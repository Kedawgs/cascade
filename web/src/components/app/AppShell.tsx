"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "../Logo";
import { WalletPill } from "./WalletPill";
import styles from "./AppShell.module.css";

const ICON = {
  stake: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
    </svg>
  ),
  unstake: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14M5 12l7 7 7-7" />
    </svg>
  ),
  rewards: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 18l5-6 4 3 7-9" />
    </svg>
  ),
  activity: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 7h14M5 12h14M5 17h9" />
    </svg>
  ),
} as const;

export type AppTab = keyof typeof ICON;

const TABS: { key: AppTab; href: string; label: string }[] = [
  { key: "stake", href: "/stake", label: "Stake" },
  { key: "unstake", href: "/unstake", label: "Unstake" },
  { key: "rewards", href: "/rewards", label: "Rewards" },
  { key: "activity", href: "/activity", label: "Activity" },
];

/** The signed-in app frame: logo, four tabs, network and wallet pills, one centred column. The bar has
 * the home navbar's sizes, with the app's own content. */
export function AppShell({ active, children }: { active: AppTab; children: ReactNode }) {
  return (
    <div className={styles.app}>
      <header className={styles.bar}>
        <div className={styles.left}>
          <Link href="/" className={styles.home} aria-label="Cascade home">
            <Logo size="lg" />
          </Link>
          <nav className={styles.tabs} aria-label="App sections">
            {TABS.map((t) => (
              <Link
                key={t.key}
                href={t.href}
                className={`${styles.tab} ${t.key === active ? styles.on : ""}`}
                aria-current={t.key === active ? "page" : undefined}
              >
                {ICON[t.key]}
                {t.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className={styles.right}>
          <span className={styles.net}>
            <span className={styles.netDot} aria-hidden="true" />
            Base
          </span>
          <WalletPill />
        </div>
      </header>
      <div className={`col ${styles.col}`}>{children}</div>
    </div>
  );
}
