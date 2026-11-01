import { DEPLOYMENT, deploymentStage, type Stage } from "@/lib/cascade/config";
import styles from "./Landing.module.css";
import { PROTECTION_LEDE, ProtectionGrid } from "./ProtectionGrid";

/** `stage`: the deployment's (deployments.json), which words the audit card. */
export function SecureByDesign({ stage = deploymentStage(DEPLOYMENT) }: { stage?: Stage }) {
  return (
    <div className={styles.secureBand}>
      <section id="secure" className={`wrap ${styles.section} ${styles.secureInner}`} aria-labelledby="secure-heading">
        <h2 id="secure-heading" className={styles.h2}>
          Secure <b>by design</b>
        </h2>
        <p className={styles.lede}>{PROTECTION_LEDE}</p>
        <ProtectionGrid stage={stage} />
      </section>
    </div>
  );
}
