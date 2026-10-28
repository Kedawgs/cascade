"use client";

import { useCascadeAccount } from "@/lib/account";
import { useProtocolStats } from "@/lib/cascade/hooks";
import { Loading } from "../Loading";
import app from "./App.module.css";
import { AppShell } from "./AppShell";
import { RewardsCard } from "./RewardsCard";
import { APY_FOOTNOTE } from "./StatsCard";

/** `/rewards`: what the staked TAO has earned. */
export function RewardsScreen() {
  const { state } = useCascadeAccount();
  const account = state.status === "wallet" ? state.account : null;
  // the APR footnote explains an APR figure, so it shows only with one
  const stats = useProtocolStats();

  return (
    <AppShell active="rewards">
      <h1 className={app.title}>Rewards</h1>
      <p className={app.sub}>What your staked TAO has earned</p>
      {state.status === "loading" ? (
        <Loading />
      ) : (
        <>
          <RewardsCard account={account} />
          {stats.data?.apyPercent !== undefined && <p className={app.footnote}>{APY_FOOTNOTE}</p>}
        </>
      )}
    </AppShell>
  );
}
