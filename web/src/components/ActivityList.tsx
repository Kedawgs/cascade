import Link from "next/link";
import { chainInfo } from "@/lib/cascade/chains";
import type { DepositRecord, WithdrawalRecord } from "@/lib/cascade/types";
import { formatDay, formatTao, formatUsdShort } from "@/lib/format";
import styles from "./ActivityList.module.css";

function Row({
  href,
  date,
  label,
  done,
  doneLabel,
}: {
  href: string;
  date: Date;
  label: string;
  done: boolean;
  doneLabel: string;
}) {
  return (
    <li>
      <Link href={href} className={styles.row}>
        <span>
          <span className={styles.date}>{formatDay(date)}</span> {label}
        </span>
        <span className={done ? styles.done : styles.moving}>{done ? doneLabel : "In progress"}</span>
      </Link>
    </li>
  );
}

export function DepositList({ deposits }: { deposits: DepositRecord[] }) {
  if (deposits.length === 0) return <p className="small">No deposits yet.</p>;
  return (
    <ul className={styles.list}>
      {deposits.map((d) => (
        <Row
          key={d.id}
          href={`/deposits/${d.id}`}
          date={d.createdAt}
          label={`${formatUsdShort(d.amountUsd)} from ${chainInfo(d.sourceChain).label}`}
          done={d.status === "staked"}
          doneLabel="Staked"
        />
      ))}
    </ul>
  );
}

export function WithdrawalList({ withdrawals }: { withdrawals: WithdrawalRecord[] }) {
  return (
    <ul className={styles.list}>
      {withdrawals.map((w) => (
        <Row
          key={w.id}
          href={`/withdrawals/${w.id}`}
          date={w.createdAt}
          label={`${formatTao(w.taoAmount)} TAO to USDC`}
          done={w.status === "paid"}
          doneLabel="Paid"
        />
      ))}
    </ul>
  );
}
