"use client";

import { useCascadeAccount } from "@/lib/account";
import { Loading } from "../RequireAccount";
import app from "./App.module.css";
import { AppShell } from "./AppShell";
import { RewardsCard } from "./RewardsCard";
import { APR_FOOTNOTE } from "./StatsCard";

/** `/rewards`: what the staked TAO has earned. */
export function RewardsScreen() {
  const { state } = useCascadeAccount();
  const account = state.status === "wallet" || state.status === "demo" ? state.account : null;

  return (
    <AppShell active="rewards">
      <h1 className={app.title}>Rewards</h1>
      <p className={app.sub}>What your staked TAO has earned</p>
      {state.status === "loading" ? (
        <Loading />
      ) : (
        <>
          <RewardsCard account={account} />
          <p className={app.footnote}>{APR_FOOTNOTE}</p>
        </>
      )}
    </AppShell>
  );
}
