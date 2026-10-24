import Link from "next/link";
import { SITE_LINKS } from "@/lib/site";
import { Logo } from "../Logo";
import styles from "./Landing.module.css";

export function SiteFooter() {
  return (
    <footer className={`wrap ${styles.footer}`}>
      <div className={styles.frow}>
        <div>
          <Link href="/" className={styles.brand} aria-label="Cascade home">
            <Logo />
          </Link>
          <p className={styles.fnote}>
            TAO staking exposure for people who would rather not run a Bittensor wallet. Yield varies
            with the network and is not guaranteed.
          </p>
        </div>
        <div className={styles.flinks}>
          <a href={SITE_LINKS.docs} target="_blank" rel="noopener noreferrer">
            Docs
          </a>
          <a href={SITE_LINKS.github} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <a href={SITE_LINKS.security} target="_blank" rel="noopener noreferrer">
            Security
          </a>
        </div>
      </div>
    </footer>
  );
}
