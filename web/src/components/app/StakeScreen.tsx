"use client";

import { useCascadeAccount } from "@/lib/account";
import { useProof } from "@/lib/cascade/hooks";
import { Loading } from "../RequireAccount";
import app from "./App.module.css";
import { AppShell } from "./AppShell";
import { Faq } from "./Faq";
import { StakeCard } from "./StakeCard";
import { StatsCard } from "./StatsCard";
import { WhereIsMyMoney } from "./WhereIsMyMoney";

function StatsWithProof({ account }: { account: string }) {
  const proof = useProof(account);
  return <StatsCard explorerUrl={proof.data?.explorerUrl} />;
}

/** `/stake`: never redirects; without an account the form shows its connect state. */
export function StakeScreen() {
  const { state } = useCascadeAccount();
  const account = state.status === "wallet" || state.status === "demo" ? state.account : null;

  return (
    <AppShell active="stake">
      <h1 className={app.title}>Stake TAO</h1>
      <p className={app.sub}>Deposit USDC and earn TAO staking rewards</p>
      {state.status === "loading" ? (
        <Loading />
      ) : (
        <>
          <StakeCard account={account} />
          {account && <WhereIsMyMoney account={account} />}
          {account ? <StatsWithProof account={account} /> : <StatsCard />}
          <Faq />
        </>
      )}
    </AppShell>
  );
}
