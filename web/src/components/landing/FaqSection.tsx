import Link from "next/link";
import { featuredFaq } from "@/lib/faq";
import { FaqItems } from "../faq/FaqItems";
import styles from "./Landing.module.css";

const FEATURED = featuredFaq();

/** The questions people ask first, with the rest one click away. */
export function FaqSection() {
  if (FEATURED.length === 0) return null;
  return (
    <section id="faq" className={`wrap ${styles.section}`} aria-labelledby="faq-heading">
      <h2 id="faq-heading" className={styles.h2}>
        Questions, <b>answered</b>
      </h2>
      <p className={styles.lede}>The short version. Fees, rewards and timing are all covered in full on the FAQ page.</p>
      <FaqItems items={FEATURED} />
      <p className={styles.faqMore}>
        <Link href="/faq/" className="pill pill-ghost">
          All questions
        </Link>
      </p>
    </section>
  );
}
