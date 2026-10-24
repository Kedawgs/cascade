import Link from "next/link";
import { chainInfo } from "@/lib/cascade/chains";
import type { DepositRecord, WithdrawalRecord } from "@/lib/cascade/types";
import { formatDateTime, formatDay, formatSignedTao, formatTao, formatUsd, formatUsdc, formatUsdShort } from "@/lib/format";
import { TRANSIT_PHRASE } from "@/lib/lane";
import styles from "./ActivityList.module.css";

function Bars({ done }: { done: number }) {
  return (
    <span className={styles.bars} aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <i key={i} className={i < done ? styles.on : undefined} />
      ))}
    </span>
  );
}

function when(d: Date, now = Date.now()): string {
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? `Today, ${formatDateTime(d).split(", ")[1] ?? ""}`.trim() : formatDay(d);
}

export function DepositList({ deposits }: { deposits: DepositRecord[] }) {
  if (deposits.length === 0) {
    return <p className={styles.empty}>No deposits yet. Stake some USDC and it will show up here.</p>;
  }
  return (
    <ul className={styles.list}>
      {deposits.map((d) => {
        const moving = d.status === "in_progress";
        const done = d.steps.filter((s) => s.status === "done").length;
        const active = d.steps.find((s) => s.status === "active");
        return (
          <li key={d.id}>
            <Link href={`/activity?deposit=${d.id}`} className={styles.row}>
              <span>
                <span className={styles.t}>
                  {formatUsdShort(d.amountUsd)} from {chainInfo(d.sourceChain).label}
                </span>
                <span className={styles.d}>{when(d.createdAt)}</span>
              </span>
              <span className={styles.c}>
                {moving ? "about " : ""}
                {formatTao(d.taoAmount, 2)} TAO
                <small>at {formatUsd(d.taoPriceUsd)}</small>
              </span>
              <span>
                {moving ? (
                  <>
                    <span className={`${styles.chip} ${styles.busy}`}>On its way</span>
                    <Bars done={done} />
                    <span className={styles.sub}>{active ? TRANSIT_PHRASE[active.key] : "starting"}</span>
                  </>
                ) : (
                  <>
                    <span className={`${styles.chip} ${styles.ok}`}>Staked</span>
                    <span className={styles.sub}>
                      {d.rewardsTao > 0 ? `${formatSignedTao(d.rewardsTao)} TAO earned so far` : "earning"}
                    </span>
                  </>
                )}
              </span>
              <span className={styles.chev} aria-hidden="true">
                ›
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function WithdrawalList({ withdrawals }: { withdrawals: WithdrawalRecord[] }) {
  if (withdrawals.length === 0) return null;
  return (
    <ul className={styles.list}>
      {withdrawals.map((w) => {
        const moving = w.status === "in_progress";
        const done = w.steps.filter((s) => s.status === "done").length;
        return (
          <li key={w.id}>
            <Link href={`/activity?withdrawal=${w.id}`} className={styles.row}>
              <span>
                <span className={styles.t}>{formatTao(w.taoAmount, 2)} TAO to USDC</span>
                <span className={styles.d}>{when(w.createdAt)}</span>
              </span>
              <span className={styles.c}>
                {moving ? "about " : ""}
                {formatUsdc(w.usdcAmount)} USDC
                <small>on Base</small>
              </span>
              <span>
                {moving ? (
                  <>
                    <span className={`${styles.chip} ${styles.busy}`}>On its way</span>
                    <Bars done={done} />
                  </>
                ) : (
                  <span className={`${styles.chip} ${styles.ok}`}>Paid</span>
                )}
              </span>
              <span className={styles.chev} aria-hidden="true">
                ›
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
