import Link from "next/link";
import { SITE_LINKS } from "@/lib/site";
import { Logo } from "../Logo";
import styles from "./Landing.module.css";

/** On narrow screens the links take their own row under the logo and the Stake & Earn button, which
 * stands in for the Stake link there. */
export function SiteNav() {
  return (
    <div className="wrap">
      <nav className={styles.nav} aria-label="Site">
        <Link href="/" className={styles.brand} aria-label="Cascade home">
          <Logo size="lg" />
        </Link>
        <div className={styles.links}>
          <Link href="/stake" className={styles.linkStake}>
            Stake
          </Link>
          <Link href="/#how">How it works</Link>
          <Link href="/faq/">FAQ</Link>
          <Link href="/#secure">Security</Link>
          <a href={SITE_LINKS.docs} target="_blank" rel="noopener noreferrer">
            Docs
          </a>
        </div>
        <div className={styles.navRight}>
          <Link href="/stake" className={`pill ${styles.navCta}`}>
            Stake &amp; Earn
          </Link>
        </div>
      </nav>
    </div>
  );
}
