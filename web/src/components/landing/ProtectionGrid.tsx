import { DEPLOYMENT, deploymentStage, type Stage } from "@/lib/cascade/config";
import { auditCard } from "@/lib/landing";
import { AUDIT_STATUS, SITE_LINKS } from "@/lib/site";
import styles from "./Landing.module.css";

/** The promise both the home page and /security lead their protection points with. */
export const PROTECTION_LEDE = "Your TAO sits in an open, auditable contract. We can't move your TAO without 7 days' public notice.";

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

/** Each point's colour says what it is, from the logo's palette: green for what you can check now, ink for
 * the code, amber for what is not done yet (the audit), water for the bridge the money crosses. */
const TONE = {
  proof: { tile: styles.tileProof, stroke: "#1E8A5A" },
  ink: { tile: styles.tileInk, stroke: "#10212B" },
  amber: { tile: styles.tileAmber, stroke: "#9A5B00" },
  water: { tile: styles.tileWater, stroke: "#206F80" },
} as const;

function Icon({ name, tone }: { name: keyof typeof ICON; tone: keyof typeof TONE }) {
  return (
    <span className={`${styles.secIcon} ${TONE[tone].tile}`} aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={TONE[tone].stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {ICON[name]}
      </svg>
    </span>
  );
}

/** The four protection points, one source for the home page and /security. `stage`: the deployment's
 * (deployments.json), which words the audit card. */
export function ProtectionGrid({ stage = deploymentStage(DEPLOYMENT) }: { stage?: Stage }) {
  const audit = auditCard(stage, AUDIT_STATUS);
  return (
    <div className={styles.secure}>
      <div className={styles.sec}>
        <Icon name="shield" tone="proof" />
        <h3>Verifiable on-chain</h3>
        <p>Every balance comes with a live check of your stake on Bittensor that you can open yourself.</p>
      </div>
      <div className={styles.sec}>
        <Icon name="code" tone="ink" />
        <h3>Open source</h3>
        <p>
          The contracts and this app are public, with a security policy for reporting issues.{" "}
          <a href={SITE_LINKS.github} target="_blank" rel="noopener noreferrer" className={styles.secLink}>
            See the code
          </a>
        </p>
      </div>
      <div className={styles.sec}>
        <Icon name="clock" tone={audit.badge === "Not yet" ? "amber" : "proof"} />
        <h3>
          Independent audit
          {audit.badge && <span className={styles.status}>{audit.badge}</span>}
        </h3>
        <p>{audit.body}</p>
      </div>
      <div className={styles.sec}>
        <Icon name="link" tone="water" />
        <h3>Built on Chainlink CCIP</h3>
        <p>Your TAO crosses chains over Chainlink&apos;s bridge, the same rails used by the largest DeFi protocols.</p>
      </div>
    </div>
  );
}
