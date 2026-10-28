import Link from "next/link";
import { SITE_LINKS } from "@/lib/site";
import { Logo } from "../Logo";
import styles from "./Landing.module.css";

function PageLinks() {
  return (
    <>
      <Link href="/#how">How it works</Link>
      <Link href="/faq/">FAQ</Link>
      <Link href="/#secure">Security</Link>
      <a href={SITE_LINKS.docs} target="_blank" rel="noopener noreferrer">
        Docs
      </a>
    </>
  );
}

/** The bar stays on screen as the page scrolls, so Stake & Earn is always in reach. On narrow screens
 * only the logo and that button stay: the links take their own row underneath, which scrolls away
 * (the button stands in for the Stake link there). Only one of the two link lists shows at a time. */
export function SiteNav() {
  return (
    <>
      <div className={styles.navBar}>
        <div className="wrap">
          <nav className={styles.nav} aria-label="Site">
            <Link href="/" className={styles.brand} aria-label="Cascade home">
              <Logo size="lg" />
            </Link>
            <div className={`${styles.links} ${styles.barLinks}`}>
              <Link href="/stake">Stake</Link>
              <PageLinks />
            </div>
            <div className={styles.navRight}>
              <Link href="/stake" className={`pill ${styles.navCta}`}>
                Stake &amp; Earn
              </Link>
            </div>
          </nav>
        </div>
      </div>
      <nav className={`wrap ${styles.links} ${styles.rowLinks}`} aria-label="Site sections">
        <PageLinks />
      </nav>
    </>
  );
}
