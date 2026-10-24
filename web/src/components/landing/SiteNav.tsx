"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { SITE_LINKS } from "@/lib/site";
import { Logo } from "../Logo";
import styles from "./Landing.module.css";

export function SiteNav() {
  const [open, setOpen] = useState(false);
  const menuId = useId();

  return (
    <div className="wrap">
      <nav className={styles.nav} aria-label="Site">
        <Link href="/" className={styles.brand} aria-label="Cascade home">
          <Logo size="lg" />
        </Link>
        <div id={menuId} className={`${styles.links} ${open ? styles.linksOpen : ""}`}>
          <Link href="/stake">Stake</Link>
          <Link href="#how">How it works</Link>
          <Link href="#secure">Security</Link>
          <a href={SITE_LINKS.docs} target="_blank" rel="noopener noreferrer">
            Docs
          </a>
        </div>
        <div className={styles.navRight}>
          <Link href="/stake" className={`pill ${styles.navCta}`}>
            Stake TAO
          </Link>
          <button
            type="button"
            className={styles.menuBtn}
            aria-expanded={open}
            aria-controls={menuId}
            onClick={() => setOpen((v) => !v)}
          >
            Menu
          </button>
        </div>
      </nav>
    </div>
  );
}
