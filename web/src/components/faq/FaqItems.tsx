"use client";

import Link from "next/link";
import { useEffect } from "react";
import type { FaqItem } from "@/lib/faq";
import { parseInlineLinks } from "@/lib/inline-links";
import styles from "./Faq.module.css";

function Inline({ text }: { text: string }) {
  return parseInlineLinks(text).map((p, i) => {
    if (!p.href) return p.text;
    if (p.href.startsWith("/")) {
      return (
        <Link key={i} href={p.href}>
          {p.text}
        </Link>
      );
    }
    return (
      <a key={i} href={p.href} target="_blank" rel="noopener noreferrer">
        {p.text}
      </a>
    );
  });
}

/** Questions that open in place. A link to `#<id>` opens its answer. `compact` suits the app's narrower column. */
export function FaqItems({ items, compact = false }: { items: readonly FaqItem[]; compact?: boolean }) {
  useEffect(() => {
    const open = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      const el = id ? document.getElementById(id) : null;
      if (el instanceof HTMLDetailsElement) el.open = true;
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);

  return (
    <div className={`${styles.list} ${compact ? styles.compact : ""}`}>
      {items.map((item) => (
        <details key={item.id} id={item.id} className={styles.item}>
          <summary className={styles.q}>
            {item.q}
            <span className={styles.sign} aria-hidden="true" />
          </summary>
          <div className={styles.a}>
            {item.a.map((para, i) => (
              <p key={i}>
                <Inline text={para} />
              </p>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
