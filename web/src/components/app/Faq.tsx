"use client";

import { useIsV3 } from "@/lib/cascade/hooks";
import styles from "./App.module.css";

type Item = { q: string; a: string };

const ITEMS: Item[] = [
  {
    q: "What is Cascade?",
    a: "Cascade stakes TAO on Bittensor for you. You deposit USDC from a normal wallet on Base. Cascade swaps it to TAO, moves it to Bittensor and stakes it. Your balance shows your TAO and the rewards it earns.",
  },
  {
    q: "Do I need a Bittensor wallet?",
    a: "No. Everything happens from the wallet you already use on Base, such as MetaMask, Coinbase Wallet or Rabby.",
  },
  {
    q: "Where is my TAO staked?",
    a: "On Bittensor's root network with a vetted validator. Your balance comes with a live on-chain check you can open at any time.",
  },
  {
    q: "What are the fees?",
    a: "Every fee is shown before you confirm. A deposit pays Uniswap's swap fees and Base network fees. Unstaking pays a small request fee in ETH, the bridge fee for the trip back (taken from the TAO) and the swap fees back to USDC.",
  },
  {
    q: "How do I unstake?",
    a: "Open the Unstake tab and enter how much USDC you want back. Your TAO comes back to Base after a short safety wait, and you claim it as USDC in the same wallet. The form shows how long it takes.",
  },
  {
    q: "Is there a lock-up?",
    a: "No. Unstaking takes a little time because the TAO has to be unstaked on Bittensor and sent back across to Base, but you can start it whenever you like.",
  },
];

/** v3 answers where the flow differs: Cascade's own fees, and USDC delivered without a claim. */
const V3_ANSWERS: Record<string, string> = {
  "What are the fees?":
    "Every fee is shown before you confirm. A deposit pays Cascade's fee ($0.05 + 0.15%), the pools' fees for the swap (about 0.35%) and Base network fees. Cascade also keeps 10% of the staking rewards. Unstaking pays a small request fee in ETH, the bridge fee for the trip back (taken from the TAO), and Cascade's 0.15% and the pools' fees on the way back to USDC.",
  "How do I unstake?":
    "Open the Unstake tab and enter how much USDC you want back. Your TAO comes back to Base after a short safety wait and arrives in your wallet as USDC automatically. The form shows how long it takes.",
};

export function Faq() {
  const v3 = useIsV3();
  const items = v3 ? ITEMS.map((item) => ({ ...item, a: V3_ANSWERS[item.q] ?? item.a })) : ITEMS;
  return (
    <section aria-labelledby="faq-heading" className={styles.section}>
      <div className={styles.secHead}>
        <h2 id="faq-heading">FAQ</h2>
      </div>
      <div className={styles.faq}>
        {items.map((item, i) => (
          <details key={item.q} open={i === 0}>
            <summary>{item.q}</summary>
            <p>{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
