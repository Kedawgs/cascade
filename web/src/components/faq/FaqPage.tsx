import { FAQ_SECTIONS, FAQ_UPDATED } from "@/lib/faq";
import landing from "../landing/Landing.module.css";
import { SiteFooter } from "../landing/SiteFooter";
import { SiteNav } from "../landing/SiteNav";
import { FaqBody } from "./FaqBody";
import styles from "./Faq.module.css";

/** `/faq`: every question, grouped, with a jump list at the top. */
export function FaqPage() {
  return (
    <div className={landing.page}>
      <SiteNav />
      <main className={`wrap ${styles.pageEnd}`}>
        <header className={styles.head}>
          <h1 className={styles.h1}>Questions and answers</h1>
          <p className={styles.lede}>
            How TAO staking works, what Cascade charges, and when rewards are collected. We update this
            page when something changes.
          </p>
          <nav aria-label="Topics">
            <ul className={styles.jump}>
              {FAQ_SECTIONS.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`}>{s.title}</a>
                </li>
              ))}
            </ul>
          </nav>
        </header>
        <FaqBody />
        <p className={styles.updated}>Last updated {FAQ_UPDATED}.</p>
      </main>
      <SiteFooter />
    </div>
  );
}
