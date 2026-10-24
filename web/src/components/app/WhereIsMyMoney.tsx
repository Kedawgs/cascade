"use client";

import { useDeposits, useMockUsdcBalance, useProof } from "@/lib/cascade/hooks";
import { useNow } from "@/lib/client-state";
import { formatRelative } from "@/lib/format";
import { deriveLane } from "@/lib/lane";
import { ReceiptLink } from "../ReceiptLink";
import styles from "./WhereIsMyMoney.module.css";

/** The three-stop lane: wallet, in transit, staked. */
export function WhereIsMyMoney({ account }: { account: string }) {
  const deposits = useDeposits(account);
  const live = deposits.data?.some((d) => d.status === "in_progress") ?? false;
  const proof = useProof(account, live);
  const usdc = useMockUsdcBalance(account);
  const now = useNow();

  const lane = deriveLane({
    usdcBalance: usdc.data ?? null,
    deposits: deposits.data ?? [],
    proof: proof.data ?? null,
  });

  return (
    <section aria-labelledby="where-heading" className={styles.section}>
      <div className={styles.head}>
        <h2 id="where-heading">Where your money is right now</h2>
        {proof.data && (
          <span className={styles.checked}>
            Checked on-chain {formatRelative(proof.data.checkedAt, now)}
          </span>
        )}
      </div>
      <div className={styles.card}>
        <ol className={styles.lane} aria-label="Where your money is">
          {lane.map((node, i) => (
            <li key={i} className={`${styles.node} ${styles[node.state]}`}>
              <p className={styles.amount}>{node.amount}</p>
              <p className={styles.label}>
                {node.label}
                {node.href && (
                  <>
                    .{" "}
                    <ReceiptLink href={node.href} className={styles.link}>
                      See it
                    </ReceiptLink>
                  </>
                )}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
