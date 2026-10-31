"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useCascadeAccount } from "@/lib/account";
import { stakeAmountParam } from "@/lib/stake-form";
import { Loading } from "../Loading";
import app from "./App.module.css";
import { AppShell } from "./AppShell";
import { Faq } from "./Faq";
import { NextBatchLine } from "./NextBatchLine";
import { StakeCard } from "./StakeCard";
import { StatsCardForAccount } from "./StatsCard";
import { WhereIsMyMoney } from "./WhereIsMyMoney";

/** The card with the amount a link typed into it (`/stake?amount=…`, from "Stake again at today's
 * price" on a receipt), read from the URL once the page runs in the browser; the prerendered page and
 * a link without one show the plain card (the Suspense fallback below). */
function StakeCardFromUrl({ account }: { account: string | null }) {
  const params = useSearchParams();
  return <StakeCard account={account} initialAmount={stakeAmountParam(params.get("amount"))} />;
}

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
          <Suspense fallback={<StakeCard account={account} />}>
            <StakeCardFromUrl account={account} />
          </Suspense>
          <NextBatchLine />
          {account && <WhereIsMyMoney account={account} />}
          <StatsCardForAccount />
          <Faq />
        </>
      )}
    </AppShell>
  );
}
