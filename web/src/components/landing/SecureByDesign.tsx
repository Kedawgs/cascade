import { DEPLOYMENT, sourcePublished, type Stage, wordingStage } from "@/lib/cascade/config";
import styles from "./Landing.module.css";
import { protectionLede, ProtectionGrid } from "./ProtectionGrid";

/** `stage`: the deployment's (deployments.json), which words the audit card. `published`: whether its contract source
 * is published (deployments.json `sourcePublished`), which words the lede and the code card. */
export function SecureByDesign({ stage = wordingStage(DEPLOYMENT), published = sourcePublished(DEPLOYMENT) }: { stage?: Stage; published?: boolean }) {
  return (
    <div className={styles.secureBand}>
      <section id="secure" className={`wrap ${styles.section} ${styles.secureInner}`} aria-labelledby="secure-heading">
        <h2 id="secure-heading" className={styles.h2}>
          Secure <b>by design</b>
        </h2>
        <p className={styles.lede}>{protectionLede(published)}</p>
        <ProtectionGrid stage={stage} published={published} />
      </section>
    </div>
  );
}
