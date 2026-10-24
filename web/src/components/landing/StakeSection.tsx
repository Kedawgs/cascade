"use client";

import { useCascadeAccount } from "@/lib/account";
import { useUsdcBalance } from "@/lib/use-usdc-balance";
import { availableToStake } from "@/lib/usdc-balance";
import { StakeForm } from "../app/StakeForm";
import { SAMPLE_STAKE_USD } from "./Hero";
import styles from "./Landing.module.css";

const POINTS = [
  { lead: "One balance.", body: "Your TAO and your rewards, in dollars and in TAO." },
  {
    lead: "Always visible.",
    body: "See exactly where your money is at every step, with a live on-chain check once it is staked.",
  },
  { lead: "Unstake any time.", body: "Back to USDC in the same wallet, usually within a day." },
];

function Tick() {
  return (
    <span className={styles.pointTick} aria-hidden="true">
      <svg width="10" height="10" viewBox="0 0 13 13">
        <path d="M2.5 6.8l2.6 2.6 5.4-6" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

export function StakeSection() {
  const { state } = useCascadeAccount();
  const account = state.status === "wallet" || state.status === "demo" ? state.account : null;
  const balance = useUsdcBalance();

  return (
    <section id="stake" className={styles.stakeWrap} aria-labelledby="stake-heading">
      <div className={`wrap ${styles.stakeGrid}`}>
        <div>
          <h2 id="stake-heading" className={styles.h2}>
            Stake in <b>under a minute</b>
          </h2>
          <p className={styles.lede}>
            Pick the chain your USDC is on, type an amount, approve once. Base is live today and more
            chains are on the way.
          </p>
          <ul className={styles.points}>
            {POINTS.map((p) => (
              <li key={p.lead}>
                <Tick />
                <span>
                  <b>{p.lead}</b> {p.body}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className={styles.widget}>
          <StakeForm
            account={account}
            initialAmount={String(SAMPLE_STAKE_USD)}
            maxUsdc={account ? availableToStake(balance).max : null}
          />
        </div>
      </div>
    </section>
  );
}
