"use client";

import { useCascadeAccount } from "@/lib/account";
import { usePosition } from "@/lib/cascade/hooks";
import { toDisplay } from "@/lib/cascade/units";
import { formatTao, formatUsd } from "@/lib/format";
import { Loading } from "../Loading";
import app from "./App.module.css";
import { AppShell } from "./AppShell";
import { Faq } from "./Faq";
import card from "./StakeCard.module.css";
import { StatsCardForAccount } from "./StatsCard";
import { UnstakeForm } from "./UnstakeForm";

function UnstakeSummary({ account }: { account: string }) {
  const position = usePosition(account);
  const staked = position.data ? `${formatTao(position.data.taoBalance, 4)} TAO` : "–";
  return (
    <>
      <div>
        <p className={card.k}>Staked</p>
        <p className={card.v}>
          {staked}
          {position.data && <small>{formatUsd(position.data.usdValue)}</small>}
        </p>
      </div>
      <div>
        <p className={card.k}>Available to unstake</p>
        <p className={card.v}>{position.data ? `${formatTao(toDisplay(position.data.availableTaoWei, 18), 4)} TAO` : "–"}</p>
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
      <h1 className={app.title}>Unstake TAO</h1>
      <p className={app.sub}>Get USDC back in the same wallet on Base</p>
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
                    <p className={card.k}>Staked</p>
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
