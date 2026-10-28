"use client";

import { FaqSection } from "./FaqSection";
import { Hero } from "./Hero";
import { HowItWorks } from "./HowItWorks";
import { SecureByDesign } from "./SecureByDesign";
import { SiteFooter } from "./SiteFooter";
import { SiteNav } from "./SiteNav";
import { StakeSection } from "./StakeSection";
import styles from "./Landing.module.css";

/** `/`: the marketing page, for everyone, signed in or not. */
export function LandingPage() {
  return (
    <div className={styles.page}>
      <SiteNav />
      <Hero />
      <HowItWorks />
      <StakeSection />
      <SecureByDesign />
      <FaqSection />
      <SiteFooter />
    </div>
  );
}
