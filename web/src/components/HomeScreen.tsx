"use client";

import Link from "next/link";
import { useCascadeAccount } from "@/lib/account";
import { useDeposits, usePosition, useProof, useWithdrawals } from "@/lib/cascade/hooks";
import type { Position } from "@/lib/cascade/types";
import { formatPercent, formatSignedTao, formatTao, formatUsd } from "@/lib/format";
import { DepositList, WithdrawalList } from "./ActivityList";
import { Landing } from "./Landing";
import { ProofBox } from "./ProofBox";
import { Loading } from "./RequireAccount";
import { HomeTopBar } from "./TopBar";
import styles from "./HomeScreen.module.css";

/** `/`: the landing page for visitors, home screen A once there's an account. */
export function HomeGate() {
  const { state, startDemo } = useCascadeAccount();
  if (state.status === "loading") return <Loading />;
  if (state.status === "none") return <Landing onTryDemo={startDemo} />;
  return <HomeScreen account={state.account} />;
}

/** Price change, kept on its own line so it's never mixed up with staking rewards. */
function priceLine(p: Position): string | null {
  if (p.avgEntryPriceUsd === null || p.taoBalance <= 0) return null;
  const change = (p.taoPriceUsd - p.avgEntryPriceUsd) / p.avgEntryPriceUsd;
  const price = `TAO price ${formatUsd(p.taoPriceUsd)}`;
  if (Math.abs(change) < 0.0005) return `${price}, about the same as when you deposited`;
  return `${price}, ${change > 0 ? "up" : "down"} ${formatPercent(Math.abs(change))} since you deposited`;
}

function Balance({ position }: { position: Position }) {
  const price = priceLine(position);
  return (
    <section aria-labelledby="balance-label">
      <h1 id="balance-label" className="small">
        Your staked TAO
      </h1>
      <p className={styles.balance}>{formatUsd(position.usdValue)}</p>
      <p className={styles.sub}>
        {formatTao(position.taoBalance)} TAO{" "}
        {position.rewardsEarnedTao > 0 && (
          <span className={styles.gain}>
            {formatSignedTao(position.rewardsEarnedTao)} TAO earned
          </span>
        )}
      </p>
      {price && <p className={`small ${styles.extra}`}>{price}</p>}
      {position.pendingTao > 0 && (
        <p className={`small ${styles.extra}`}>{formatTao(position.pendingTao)} TAO on its way</p>
      )}
    </section>
  );
}

function HomeScreen({ account }: { account: string }) {
  const deposits = useDeposits(account);
  const withdrawals = useWithdrawals(account);
  const live = [...(deposits.data ?? []), ...(withdrawals.data ?? [])].some(
    (r) => r.status === "in_progress",
  );
  const position = usePosition(account, live);
  const proof = useProof(account, live);

  const failed = [deposits, withdrawals, position, proof].find((q) => q.isError);
  if (failed) {
    return (
      <>
        <HomeTopBar />
        <p role="alert">We couldn&apos;t load your balance just now.</p>
        <button type="button" className={`btn btn-ghost ${styles.retry}`} onClick={() => failed.refetch()}>
          Try again
        </button>
      </>
    );
  }

  if (!position.data || !proof.data || !deposits.data || !withdrawals.data) {
    return (
      <>
        <HomeTopBar />
        <Loading />
      </>
    );
  }

  return (
    <>
      <HomeTopBar />
      <Balance position={position.data} />
      <ProofBox proof={proof.data} pendingTao={position.data.pendingTao} />
      <div className={styles.actions}>
        <Link href="/deposit" className="btn btn-primary">
          Deposit
        </Link>
        <Link href="/withdraw" className="btn btn-ghost">
          Withdraw
        </Link>
      </div>

      <h2 className="section-title">Your deposits</h2>
      <DepositList deposits={deposits.data} />

      {withdrawals.data.length > 0 && (
        <>
          <h2 className="section-title">Your withdrawals</h2>
          <WithdrawalList withdrawals={withdrawals.data} />
        </>
      )}
    </>
  );
}
