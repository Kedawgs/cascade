"use client";

import { useBalances, useDeposits, usePosition, useProof } from "@/lib/cascade/hooks";
import { toDisplay } from "@/lib/cascade/units";
import { useNow } from "@/lib/client-state";
import { formatRelative } from "@/lib/format";
import { deriveLane } from "@/lib/lane";
import { useUsdcBalance } from "@/lib/use-usdc-balance";
import { LoadError } from "../LoadError";
import { ReceiptLink } from "../ReceiptLink";
import styles from "./WhereIsMyMoney.module.css";

/** The three-stop lane: wallet, in transit, staked. */
export function WhereIsMyMoney({ account }: { account: string }) {
  const deposits = useDeposits(account);
  const live = deposits.data?.some((d) => d.status === "in_progress" || d.status === "needs_you") ?? false;
  const proof = useProof(live);
  const position = usePosition(account, live);
  const balance = useUsdcBalance();
  const wallet = useBalances(account);
  const now = useNow();

  const lane = deriveLane({
    usdcBalance: balance.status === "success" ? (balance.data ?? null) : null,
    deposits: deposits.data ?? [],
    position: position.data ?? null,
    positionError: position.isError,
    explorerUrl: proof.data?.explorerUrl,
    waitingForMinimum: proof.data?.waitingForMinimum,
    minimumTao: proof.data?.minimumTao,
    walletTao: wallet.data ? toDisplay(wallet.data.tao, 18) : undefined,
  });

  if (deposits.isError) {
    return (
      <section aria-labelledby="where-heading" className={styles.section}>
        <div className={styles.head}>
          <h2 id="where-heading">Where your money is right now</h2>
        </div>
        <div className={styles.card}>
          <LoadError what="where your money is" onRetry={() => void deposits.refetch()} />
        </div>
      </section>
    );
  }

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
