import Link from "next/link";
import { chainInfo } from "@/lib/cascade/chains";
import type { PendingEntry } from "@/lib/cascade/pending";
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

/** A deposit or unstake this browser sent that Activity hasn't read from the chain yet: what its own record
 * says (the amount sent, the estimate), said to be unconfirmed. Its record takes its place once read. */
function PendingRow({ entry }: { entry: PendingEntry }) {
  const n = entry.notice;
  return (
    <li>
      <Link href={n.kind === "deposit" ? `/activity?deposit=${n.id}` : `/activity?withdrawal=${n.id}`} className={styles.row}>
        <span>
          <span className={styles.t}>
            {n.kind === "unstake"
              ? "Unstake"
              : `${n.usdc !== undefined ? formatUsdShort(n.usdc) : `${formatTao(n.tao, 4)} TAO`} from ${chainInfo("base").label}`}
          </span>
          <span className={styles.d}>{when(entry.createdAt)}</span>
        </span>
        <span className={styles.c}>
          {n.kind === "unstake" ? (
            <>
              about {formatUsdc(n.usdc)} USDC
              <small>on Base</small>
            </>
          ) : (
            `${n.usdc !== undefined ? "about " : ""}${formatTao(n.tao, 4)} TAO`
          )}
        </span>
        <span>
          <span className={`${styles.chip} ${styles.busy}`}>Confirming</span>
          <span className={styles.sub}>sent, not confirmed yet</span>
        </span>
        <span className={styles.chev} aria-hidden="true">
          ›
        </span>
      </Link>
    </li>
  );
}

/** The deposits read from the chain, below any this browser sent that aren't among them yet (`pending`). */
export function DepositList({ deposits, pending = [] }: { deposits: DepositRecord[]; pending?: PendingEntry[] }) {
  if (deposits.length === 0 && pending.length === 0) {
    return <p className={styles.empty}>No deposits yet. Stake some USDC and it will show up here.</p>;
  }
  return (
    <ul className={styles.list}>
      {pending.map((e) => (
        <PendingRow key={e.notice.id} entry={e} />
      ))}
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
                    <span className={styles.sub}>{current ? (current.summary ?? TRANSIT_PHRASE[current.key]) : "starting"}</span>
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

/** The unstakes read from the chain, below any this browser sent that aren't among them yet (`pending`). */
export function WithdrawalList({ withdrawals, pending = [] }: { withdrawals: WithdrawalRecord[]; pending?: PendingEntry[] }) {
  if (withdrawals.length === 0 && pending.length === 0) {
    return (
      <p className={styles.empty}>
        No unstakes yet. When you <Link href="/unstake">unstake</Link>, it shows up here with a receipt for every step.
      </p>
    );
  }
  return (
    <ul className={styles.list}>
      {pending.map((e) => (
        <PendingRow key={e.notice.id} entry={e} />
      ))}
      {withdrawals.map((w) => {
        const done = w.steps.filter((s) => s.status === "done").length;
        return (
          <li key={w.id}>
            <Link href={`/activity?withdrawal=${w.id}`} className={styles.row}>
              <span>
                <span className={styles.t}>Unstake</span>
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
