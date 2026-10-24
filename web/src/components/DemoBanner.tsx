"use client";

import { useCascadeData } from "@/lib/cascade/context";
import styles from "./DemoBanner.module.css";

/** Shown on every page while the numbers come from the mock adapter. */
export function DemoBanner() {
  const { source } = useCascadeData();
  if (source !== "mock") return null;
  return (
    <p className={styles.banner} role="note">
      Demo with made-up numbers. No real money moves.
    </p>
  );
}
