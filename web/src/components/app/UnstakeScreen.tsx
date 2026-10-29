"use client";

import { useCascadeAccount } from "@/lib/account";
import { useAvailable, usePosition } from "@/lib/cascade/hooks";
import { toDisplay } from "@/lib/cascade/units";
import { formatTao, formatUsd } from "@/lib/format";
import { Dash } from "../Dash";
import { Loading } from "../Loading";
import app from "./App.module.css";
import { AppShell } from "./AppShell";
import { Faq } from "./Faq";
import card from "./StakeCard.module.css";
import { StatsCardForAccount } from "./StatsCard";
import { UnstakeForm } from "./UnstakeForm";

/** The balance and what can be unstaked. The balance is a contract read; what can be unstaked may wait
 * for the vault's history, so it keeps "–" in its place meanwhile. */
export function UnstakeSummary({ account }: { account: string }) {
  const position = usePosition(account);
  const available = useAvailable(account);
  const p = position.data;
  const free = p && available.data ? available.data.availableTaoWei : undefined;
  return (
    <>
      <div>
        <p className={card.k}>Your stake</p>
        <p className={card.v}>
          {p ? (
            <>
              {formatTao(p.taoBalance, 4)} TAO
              <small>{formatUsd(p.usdValue)}</small>
            </>
          ) : (
            <Dash loading={!position.isError} />
          )}
        </p>
      </div>
      <div>
        <p className={card.k}>Available to unstake</p>
        <p className={card.v}>
          {p && free !== undefined ? (
            <>
              {formatUsd(Math.floor(toDisplay(free, 18) * p.taoPriceUsd * 100) / 100)}
              <small>{formatTao(toDisplay(free, 18), 4)} TAO</small>
            </>
          ) : (
            <Dash loading={!position.isError && !available.isError} />
          )}
        </p>
      </div>
    </>
  );
}

/** `/unstake`: TAO back to USDC in the same wallet. */
export function UnstakeScreen() {
  const { state } = useCascadeAccount();
  const account = state.status === "wallet" ? state.account : null;

  return (
    <AppShell active="unstake">
      <h1 className={app.title}>Unstake to USDC</h1>
      <p className={app.sub}>We sell your staked TAO and send the USDC back to the same wallet.</p>
      {state.status === "loading" ? (
        <Loading />
      ) : (
        <>
          <div className={app.card}>
            <div className={card.summary}>
              {account ? (
                <UnstakeSummary account={account} />
              ) : (
                <>
                  <div>
                    <p className={card.k}>Your stake</p>
                    <p className={card.v}>–</p>
                  </div>
                  <div>
                    <p className={card.k}>Available to unstake</p>
                    <p className={card.v}>–</p>
                  </div>
                </>
              )}
            </div>
            <div className={card.form}>
              <UnstakeForm account={account} />
            </div>
          </div>
          <StatsCardForAccount />
          <Faq />
        </>
      )}
    </AppShell>
  );
}
