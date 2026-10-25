"use client";

import { useRouter } from "next/navigation";
import { useBalances, useLimits, usePosition, useProtocolStats } from "@/lib/cascade/hooks";
import { toDisplay } from "@/lib/cascade/units";
import { useFlows } from "@/lib/cascade/use-flows";
import { formatTao, formatUsd } from "@/lib/format";
import { useUsdcBalance } from "@/lib/use-usdc-balance";
import { availableToStake } from "@/lib/usdc-balance";
import app from "./App.module.css";
import { StakeForm } from "./StakeForm";
import styles from "./StakeCard.module.css";

function StakedSummary({ account }: { account: string }) {
  const position = usePosition(account);
  return (
    <div>
      <p className={styles.k}>Staked</p>
      <p
        className={styles.v}
        title={position.isError ? "We couldn't load your balance just now." : undefined}
      >
        {position.data && !position.isError ? (
          <>
            {formatTao(position.data.taoBalance, 2)} TAO{" "}
            <small>{formatUsd(position.data.usdValue)}</small>
          </>
        ) : (
          "–"
        )}
      </p>
    </div>
  );
}

/** TAO sitting in the wallet on Base (after a cancel, a claim kept as TAO, or a step that stopped):
 * deposit it, or swap it back to USDC. Hidden when there is none. */
function WalletTao({ account }: { account: string }) {
  const router = useRouter();
  const balances = useBalances(account);
  const limits = useLimits();
  const stats = useProtocolStats();
  const flows = useFlows(account);
  const tao = balances.data?.tao ?? 0n;
  if (tao === 0n) return null;
  const canDeposit = limits.data !== undefined && tao >= limits.data.minTao && tao <= limits.data.maxTao;
  return (
    <div className={styles.walletTao}>
      <p>
        You have <b>{formatTao(toDisplay(tao, 18), 6)} TAO</b> in your wallet on Base.
      </p>
      <div className={styles.walletTaoActions}>
        {canDeposit && (
          <button
            type="button"
            className="pill"
            disabled={flows.busy !== null}
            onClick={() =>
              void flows.depositWalletTao(tao, stats.data?.taoPriceUsd ?? 0).then((id) => router.push(`/activity?deposit=${id}`), () => undefined)
            }
          >
            Deposit it
          </button>
        )}
        <button type="button" className="pill pill-ghost" disabled={flows.busy !== null} onClick={() => void flows.sellWalletTao(tao).catch(() => undefined)}>
          Swap to USDC
        </button>
      </div>
      {flows.error && <p className={styles.walletTaoError}>{flows.error}</p>}
    </div>
  );
}

/** The main card on the stake page: account summary on top, the stake form below. */
export function StakeCard({ account }: { account: string | null }) {
  const stats = useProtocolStats();
  const balance = useUsdcBalance();
  const avail = availableToStake(balance);

  return (
    <div className={app.card}>
      <div className={styles.summary}>
        <div>
          <p className={styles.k}>
            Available to stake
            {account && <span className={styles.liveDot} aria-hidden="true" />}
          </p>
          <p className={styles.v}>{account ? avail.text : "–"}</p>
        </div>
        <div>
          <p className={styles.k}>Network</p>
          <p className={styles.v}>
            <span className={styles.base} aria-hidden="true" />
            Base
          </p>
        </div>
        {account ? (
          <StakedSummary account={account} />
        ) : (
          <div>
            <p className={styles.k}>Staked</p>
            <p className={styles.v}>–</p>
          </div>
        )}
        <div>
          <p className={styles.k}>TAO price</p>
          <p className={styles.v}>{stats.data?.taoPriceUsd !== undefined ? formatUsd(stats.data.taoPriceUsd) : "–"}</p>
        </div>
      </div>
      {account && <WalletTao account={account} />}
      <div className={styles.form}>
        <StakeForm account={account} maxUsdc={account ? avail.max : null} />
      </div>
    </div>
  );
}
