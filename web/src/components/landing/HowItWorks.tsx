import styles from "./Landing.module.css";

const STEPS = [
  {
    title: "Deposit USDC",
    body: "Straight from MetaMask, Coinbase Wallet, Rabby or any wallet on Base.",
  },
  {
    title: "We swap and stake",
    body: "Your USDC becomes TAO, crosses to Bittensor over Chainlink CCIP and is staked. Usually within the hour.",
  },
  {
    title: "Earn, and leave any time",
    body: "Staking rewards grow your balance as they are claimed. Unstake back to USDC whenever you like.",
  },
];

export function HowItWorks() {
  return (
    <section id="how" className={`wrap ${styles.section}`} aria-labelledby="how-heading">
      <h2 id="how-heading" className={styles.h2}>
        You confirm in your wallet. <b>We handle the rest.</b>
      </h2>
      <p className={styles.lede}>
        No Bittensor wallet, no seed phrase to write down, nothing new to learn. You can follow every
        step with a receipt anyone can look up.
      </p>
      <ol className={styles.cascade}>
        {STEPS.map((step, i) => (
          <li key={step.title} className={styles.step}>
            <span className={styles.ledge} aria-hidden="true" />
            <p className={styles.stepN}>Step {i + 1}</p>
            <h3 className={styles.stepTitle}>{step.title}</h3>
            <p className={styles.stepBody}>{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
