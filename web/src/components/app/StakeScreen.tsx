"use client";

import { useCascadeAccount } from "@/lib/account";
import { Loading } from "../Loading";
import app from "./App.module.css";
import { AppShell } from "./AppShell";
import { Faq } from "./Faq";
import { NextBatchLine } from "./NextBatchLine";
import { StakeCard } from "./StakeCard";
import { StatsCardForAccount } from "./StatsCard";
import { WhereIsMyMoney } from "./WhereIsMyMoney";

/** `/stake`: never redirects; without an account the form shows its connect state. */
export function StakeScreen() {
  const { state } = useCascadeAccount();
  const account = state.status === "wallet" ? state.account : null;

  return (
    <AppShell active="stake">
      <h1 className={app.title}>Stake with USDC</h1>
      <p className={app.sub}>We swap your USDC to TAO and stake it for you. Rewards are paid in TAO.</p>
      {state.status === "loading" ? (
        <Loading />
      ) : (
        <>
          <StakeCard account={account} />
          <NextBatchLine />
          {account && <WhereIsMyMoney account={account} />}
          <StatsCardForAccount />
          <Faq />
        </>
      )}
    </AppShell>
  );
}
