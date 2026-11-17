"use client";

import { useCascadeData } from "@/lib/cascade/context";
import type { Deployment } from "@/lib/cascade/config";
import { useRewardVesting } from "@/lib/cascade/hooks";
import { faqSections } from "@/lib/faq";
import { FaqItems } from "./FaqItems";
import styles from "./Faq.module.css";

/** The FAQ page's sections, worded for the deployment the site talks to. On v3.2 the reward vesting period is the
 * owner's, so it is read from the vault lens and said once read (no figure before: the static page has none); every
 * other deployment's is its vault's constant (Task 60; Task 58 concern 5). */
export function FaqBody() {
  const data = useCascadeData();
  const vesting = useRewardVesting();
  let d: Deployment | null;
  try {
    d = data.deployment;
  } catch {
    d = null;
  }
  const sections = faqSections(
    d,
    vesting.data !== undefined
      ? { vestingS: vesting.data.rewardVestingS, vestingPeriodS: vesting.data.vestingPeriodS, adoptVestingPeriodS: vesting.data.adoptVestingPeriodS }
      : {},
  );
  return sections.map((s) => (
    <section key={s.id} id={s.id} className={styles.group} aria-labelledby={`${s.id}-title`}>
      <h2 id={`${s.id}-title`} className={styles.groupTitle}>
        {s.title}
      </h2>
      <FaqItems items={s.items} />
    </section>
  ));
}
