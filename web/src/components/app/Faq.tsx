import styles from "./App.module.css";

const ITEMS: { q: string; a: string }[] = [
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
    a: "Every fee is shown before you confirm. A deposit carries the swap and bridge cost. Unstaking carries a small request fee that covers the trip back to Base.",
  },
  {
    q: "How do I unstake?",
    a: "Open the Unstake tab, enter an amount of TAO, and your USDC arrives in the same wallet on Base, usually within a day.",
  },
  {
    q: "Is there a lock-up?",
    a: "No. Unstaking takes a little time because the TAO has to be unstaked on Bittensor and sent back across to Base, but you can start it whenever you like.",
  },
];

export function Faq() {
  return (
    <section aria-labelledby="faq-heading" className={styles.section}>
      <div className={styles.secHead}>
        <h2 id="faq-heading">FAQ</h2>
      </div>
      <div className={styles.faq}>
        {ITEMS.map((item, i) => (
          <details key={item.q} open={i === 0}>
            <summary>{item.q}</summary>
            <p>{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
