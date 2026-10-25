import Link from "next/link";
import { chainInfo } from "@/lib/cascade/chains";
import type { DepositRecord, WithdrawalRecord } from "@/lib/cascade/types";
import { formatDateTime, formatDay, formatTao, formatUsd, formatUsdc, formatUsdShort } from "@/lib/format";
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

function Chip({ status }: { status: DepositRecord["status"] | WithdrawalRecord["status"] }) {
  if (status === "staked") return <span className={`${styles.chip} ${styles.ok}`}>Staked</span>;
  if (status === "paid") return <span className={`${styles.chip} ${styles.ok}`}>Paid</span>;
  if (status === "ready") return <span className={`${styles.chip} ${styles.warn}`}>Ready to claim</span>;
  if (status === "needs_you") return <span className={`${styles.chip} ${styles.warn}`}>Needs you</span>;
  if (status === "failed") return <span className={`${styles.chip} ${styles.bad}`}>Problem</span>;
  if (status === "cancelled") return <span className={`${styles.chip} ${styles.warn}`}>Cancelled</span>;
  return <span className={`${styles.chip} ${styles.busy}`}>On its way</span>;
}

export function DepositList({ deposits }: { deposits: DepositRecord[] }) {
  if (deposits.length === 0) {
    return <p className={styles.empty}>No deposits yet. Stake some USDC and it will show up here.</p>;
  }
  return (
    <ul className={styles.list}>
      {deposits.map((d) => {
        const done = d.steps.filter((s) => s.status === "done").length;
        const current = d.steps.find((s) => s.status === "active" || s.status === "action" || s.status === "failed");
        return (
          <li key={d.id}>
            <Link href={`/activity?deposit=${d.id}`} className={styles.row}>
              <span>
                <span className={styles.t}>
                  {d.amountUsd !== undefined ? formatUsdShort(d.amountUsd) : `${formatTao(d.taoAmount, 4)} TAO`} from{" "}
                  {chainInfo(d.sourceChain).label}
                </span>
                <span className={styles.d}>{when(d.createdAt)}</span>
              </span>
              <span className={styles.c}>
                {formatTao(d.taoAmount, 4)} TAO
                {d.taoPriceUsd !== undefined && <small>at {formatUsd(d.taoPriceUsd)}</small>}
              </span>
              <span>
                <Chip status={d.status} />
                {d.status !== "staked" && d.status !== "cancelled" && (
                  <>
                    <Bars done={done} />
                    <span className={styles.sub}>{current ? TRANSIT_PHRASE[current.key] : "starting"}</span>
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
        const done = w.steps.filter((s) => s.status === "done").length;
        return (
          <li key={w.id}>
            <Link href={`/activity?withdrawal=${w.id}`} className={styles.row}>
              <span>
                <span className={styles.t}>{formatTao(w.taoAmount, 4)} TAO to USDC</span>
                <span className={styles.d}>{when(w.createdAt)}</span>
              </span>
              <span className={styles.c}>
                {w.usdcAmount !== undefined ? (
                  <>
                    {w.status === "paid" ? "" : "about "}
                    {formatUsdc(w.usdcAmount)} USDC
                    <small>on Base</small>
                  </>
                ) : (
                  "–"
                )}
              </span>
              <span>
                <Chip status={w.status} />
                {w.status !== "paid" && w.status !== "cancelled" && <Bars done={done} />}
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
