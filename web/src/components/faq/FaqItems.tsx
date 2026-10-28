"use client";

import Link from "next/link";
import { useEffect } from "react";
import type { FaqItem } from "@/lib/faq";
import { faqHashTarget } from "@/lib/faq-hash";
import { parseInlineLinks } from "@/lib/inline-links";
import styles from "./Faq.module.css";

function Inline({ text }: { text: string }) {
  return parseInlineLinks(text).map((p, i) => {
    if (!p.href) return p.text;
    if (p.href.startsWith("/")) {
      // A link to a question (/faq/#who-controls) stays a plain link: the router changes the hash
      // without a hashchange event, so on the FAQ page itself the answer wouldn't open.
      if (p.href.includes("#")) {
        return (
          <a key={i} href={p.href}>
            {p.text}
          </a>
        );
      }
      return (
        <Link key={i} href={p.href}>
          {p.text}
        </Link>
      );
    }
    return (
      <a key={i} href={p.href} target="_blank" rel="noopener noreferrer">
        {p.text}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  });
}

/** Questions that open in place. A link to `#<id>` opens its answer. `compact` suits the app's narrower column. */
export function FaqItems({ items, compact = false }: { items: readonly FaqItem[]; compact?: boolean }) {
  useEffect(() => {
    const ids = items.map((i) => i.id);
    const open = () => {
      try {
        const id = faqHashTarget(window.location.hash, ids);
        const el = id ? document.getElementById(id) : null;
        if (el instanceof HTMLDetailsElement) el.open = true;
      } catch {
        // a hash that can't be read leaves the answers closed; it never takes the page down
      }
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, [items]);

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
