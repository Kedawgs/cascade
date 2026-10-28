"use client";

import { useCascadeAccount } from "@/lib/account";
import { Loading } from "../Loading";
import app from "./App.module.css";
import { AppShell } from "./AppShell";
import { RewardsCard } from "./RewardsCard";

/** `/rewards`: what the staked TAO has earned. */
export function RewardsScreen() {
  const { state } = useCascadeAccount();
  const account = state.status === "wallet" ? state.account : null;

  return (
    <AppShell active="rewards">
      <h1 className={app.title}>Rewards</h1>
      <p className={app.sub}>What your staked TAO has earned</p>
      {state.status === "loading" ? (
        <Loading />
      ) : (
        <RewardsCard account={account} />
      )}
    </AppShell>
  );
}
