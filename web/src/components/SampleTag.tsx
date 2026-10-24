"use client";

import { useCascadeData } from "@/lib/cascade/context";
import styles from "./SampleTag.module.css";

/** Marks a protocol-wide figure as made up while the data source is the mock. */
export function SampleTag() {
  const { source } = useCascadeData();
  if (source !== "mock") return null;
  return (
    <span className={styles.tag} title="Sample figure from the demo data">
      sample
    </span>
  );
}
