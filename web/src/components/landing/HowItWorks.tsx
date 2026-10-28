import { DEPLOYMENT } from "@/lib/cascade/config";
import { howItWorksSteps } from "@/lib/landing";
import styles from "./Landing.module.css";

/** Worded from the deployment's batch max wait: a launch deployment stakes within a day, not the hour. */
const STEPS = howItWorksSteps(DEPLOYMENT);

export function HowItWorks() {
  return (
    <section id="how" className={`wrap ${styles.section}`} aria-labelledby="how-heading">
      <h2 id="how-heading" className={styles.h2}>
        Deposit USDC. <b>We handle the rest.</b>
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
