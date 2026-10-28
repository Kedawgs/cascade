"use client";

import Link from "next/link";
import { appFaq } from "@/lib/faq";
import { FaqItems } from "../faq/FaqItems";
import styles from "./App.module.css";

const ITEMS = appFaq();

/** The questions people ask while staking or unstaking, from the same answers as the FAQ page. */
export function Faq() {
  return (
    <section aria-labelledby="faq-heading" className={styles.section}>
      <div className={styles.secHead}>
        <h2 id="faq-heading">FAQ</h2>
        <Link href="/faq/" className={styles.secLink}>
          All questions
        </Link>
      </div>
      <FaqItems items={ITEMS} compact />
    </section>
  );
}
