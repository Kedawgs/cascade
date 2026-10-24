import { AUDIT_STATUS, SITE_LINKS } from "@/lib/site";
import styles from "./Landing.module.css";

const ICON = {
  shield: <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7zM9 12l2 2 4-4" />,
  code: <path d="M8 9l-4 3 4 3M16 9l4 3-4 3M14 5l-4 14" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  link: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M4 12h16M12 4v16" />
    </>
  ),
} as const;

function Icon({ name }: { name: keyof typeof ICON }) {
  return (
    <span className={styles.secIcon} aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2E8FA3" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {ICON[name]}
      </svg>
    </span>
  );
}

export function SecureByDesign() {
  return (
    <section id="secure" className={`wrap ${styles.section}`} aria-labelledby="secure-heading">
      <h2 id="secure-heading" className={styles.h2}>
        Secure <b>by design</b>
      </h2>
      <p className={styles.lede}>Your TAO sits in an open, auditable contract. Not in our hands.</p>
      <div className={styles.secure}>
        <div className={styles.sec}>
          <Icon name="shield" />
          <h3>Verifiable on-chain</h3>
          <p>Every balance comes with a live check of your stake on Bittensor that you can open yourself.</p>
        </div>
        <div className={styles.sec}>
          <Icon name="code" />
          <h3>Open source</h3>
          <p>
            The contracts and this app are public, with a security policy for reporting issues.{" "}
            <a href={SITE_LINKS.github} target="_blank" rel="noopener noreferrer" className={styles.secLink}>
              See the code
            </a>
          </p>
        </div>
        <div className={styles.sec}>
          <Icon name="clock" />
          <h3>
            Independent audit
            {AUDIT_STATUS === "scheduled" && <span className={styles.status}>Scheduled</span>}
          </h3>
          <p>A third-party review before launch. The report will be linked here.</p>
        </div>
        <div className={styles.sec}>
          <Icon name="link" />
          <h3>Built on Chainlink CCIP</h3>
          <p>Your TAO crosses chains over Chainlink&apos;s bridge, the same rails used by the largest DeFi protocols.</p>
        </div>
      </div>
    </section>
  );
}
