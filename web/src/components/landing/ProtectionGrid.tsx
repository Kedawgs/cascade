import Link from "next/link";
import { DEPLOYMENT, sourcePublished, type Stage, wordingStage } from "@/lib/cascade/config";
import { auditCard } from "@/lib/landing";
import { AUDIT_STATUS, SITE_LINKS } from "@/lib/site";
import styles from "./Landing.module.css";

/** The promise both the home page and /security lead their protection points with. */
export const PROTECTION_LEDE = "Your TAO sits in an open-source contract anyone can read. Sending it anywhere new takes 7 days' public notice.";
/** The same promise while the deployment's contract source isn't published yet (deployments.json `sourcePublished`:
 * false): nothing is called open source before the code is there to read. */
export const PROTECTION_LEDE_UNPUBLISHED = "Your TAO sits in a contract with hard limits written into its code. Sending it anywhere new takes 7 days' public notice.";
/** The lede for the deployment the site is built for, by whether its source is published. */
export const protectionLede = (published: boolean = sourcePublished(DEPLOYMENT)): string => (published ? PROTECTION_LEDE : PROTECTION_LEDE_UNPUBLISHED);

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
 * (deployments.json), which words the audit card. `onSecurityPage`: on /security, where the bridge's live figures are
 * in the map above the grid; the home page points to that page instead. `published`: whether the deployment's contract
 * source is published (deployments.json `sourcePublished`); until it is, the code card says when it comes. */
export function ProtectionGrid({
  stage = wordingStage(DEPLOYMENT),
  onSecurityPage = false,
  published = sourcePublished(DEPLOYMENT),
}: {
  stage?: Stage;
  onSecurityPage?: boolean;
  published?: boolean;
}) {
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
        <h3>{published ? "Open source" : "Code published soon"}</h3>
        <p>
          {published
            ? "The contracts and this app are public, with a security policy for reporting issues."
            : "This version's contract code goes on GitHub once its launch checks are done. Earlier versions and the security policy are there now."}{" "}
          <a href={SITE_LINKS.github} target="_blank" rel="noopener noreferrer" className={styles.secLink}>
            {published ? "See the code" : "See the repository"}
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
        <p>
          Your TAO crosses chains over Chainlink&apos;s CCIP bridge. Its limits and anything in transit are shown{" "}
          {onSecurityPage ? (
            "above."
          ) : (
            <>
              on the{" "}
              <Link href="/security/" className={styles.secLink}>
                security page
              </Link>
              .
            </>
          )}
        </p>
      </div>
    </div>
  );
}
