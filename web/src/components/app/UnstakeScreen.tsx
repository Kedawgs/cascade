"use client";

import Link from "next/link";
import { useCascadeAccount } from "@/lib/account";
import { OTHER_WAYS_OUT } from "@/lib/cascade/direct-exit";
import { useAvailable, useIsV32, usePosition, useUnstakeReads, useUsdcDelivery } from "@/lib/cascade/hooks";
import { toDisplay } from "@/lib/cascade/units";
import { formatTao, formatUsd } from "@/lib/format";
import { unstakeHeading } from "@/lib/stake-form";
import { Dash } from "../Dash";
import { Loading } from "../Loading";
import app from "./App.module.css";
import { AppShell } from "./AppShell";
import { Faq } from "./Faq";
import { RetiredNotice } from "./RetiredNotice";
import { ClaimReady } from "./StakeCard";
import card from "./StakeCard.module.css";
import { StatsCardForAccount } from "./StatsCard";
import { UnstakeForm } from "./UnstakeForm";

/** The balance and what can be unstaked. The balance is a contract read; what can be unstaked may wait
 * for the vault's history, so it keeps a skeleton in its place meanwhile (Dash: "–" only once a read has failed). Both
 * are read from the chain on every visit: nothing here is ever a remembered value. */
export function UnstakeSummary({ account }: { account: string }) {
  const position = usePosition(account);
  const available = useAvailable(account);
  const p = position.data;
  // while whether an unstake arrived is still being checked against the chain, no figure at all
  const free = p && available.data && !available.data.checking ? available.data.availableTaoWei : undefined;
  const checking = available.data?.checking === true;
  return (
    <>
      <div>
        <p className={card.k}>Your stake</p>
        <p className={card.v}>
          {p ? (
            <>
              {formatTao(p.taoBalance, 4)} TAO
              {/* v3.2: TAO's price unread, so no dollars (live.ts getPosition) */}
              {!p.priceMissing && <small>{formatUsd(p.usdValue)}</small>}
            </>
          ) : (
            <Dash loading={!position.isError} />
          )}
        </p>
      </div>
      <div>
        <p className={card.k}>Available to unstake</p>
        <p className={card.v}>
          {p && free !== undefined && p.priceMissing ? (
            `${formatTao(toDisplay(free, 18), 4)} TAO`
          ) : p && free !== undefined ? (
            <>
              {formatUsd(Math.floor(toDisplay(free, 18) * p.taoPriceUsd * 100) / 100)}
              <small>{formatTao(toDisplay(free, 18), 4)} TAO</small>
            </>
          ) : checking ? (
            <>
              –<small>checking…</small>
            </>
          ) : (
            <Dash loading={!position.isError && !available.isError} />
          )}
        </p>
      </div>
    </>
  );
}

/** v3.2: the way out that needs neither Base nor ForeverMoney, the emergency page on Bittensor (Task 59b). Nothing on
 * any other deployment. */
export function OtherWaysOut() {
  const v32 = useIsV32();
  if (!v32) return null;
  return (
    <section aria-labelledby="other-ways-heading" className={app.section}>
      <div className={app.secHead}>
        <h2 id="other-ways-heading">Other ways out</h2>
      </div>
      <p className="small">
        <Link href="/unstake/bittensor/" className="link">
          Withdraw on Bittensor
        </Link>
        : {OTHER_WAYS_OUT}
      </p>
    </section>
  );
}

/** `/unstake`: the staked TAO back to the same wallet: on v3-launch as USDC; on v3.2 as USDC or TAO, and as TAO alone
 * while USDC delivery is off (Task 60), with what waits on Base to claim (the prompt to claim, for an account with a
 * delivery preference). On a retired deployment it says so first. */
export function UnstakeScreen() {
  const { state } = useCascadeAccount();
  const account = state.status === "wallet" ? state.account : null;
  const v32 = useIsV32();
  const usdcDelivery = useUsdcDelivery();
  const heading = unstakeHeading({ v32, usdcDelivery });
  // the form's own reads start now, beside the balance, not once the balance has loaded and the form mounts
  useUnstakeReads(account);

  return (
    <AppShell active="unstake">
      <h1 className={app.title}>{heading.title}</h1>
      <p className={app.sub}>{heading.sub}</p>
      <RetiredNotice />
      {state.status === "loading" ? (
        <Loading />
      ) : (
        <>
          <div className={app.card}>
            <div className={card.summary}>
              {account ? (
                <>
                  <UnstakeSummary account={account} />
                  {/* USDC delivery off: what waits on Base, claimed as TAO, with the prompt (StakeCard.tsx ClaimReady) */}
                  {!usdcDelivery && <ClaimReady account={account} />}
                </>
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
          <OtherWaysOut />
          <StatsCardForAccount />
          <Faq />
        </>
      )}
    </AppShell>
  );
}
