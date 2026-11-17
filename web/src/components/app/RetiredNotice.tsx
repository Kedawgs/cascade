"use client";

import { RETIRED } from "@/lib/cascade/flows";
import { useRetired } from "@/lib/cascade/hooks";
import styles from "./App.module.css";

/** A retired deployment (deployments.json stage "retired"; Task 60): the plan's sentence, at the top of the app's pages
 * and in place of the stake form. Nothing on any other deployment. */
export function RetiredNotice() {
  const retired = useRetired();
  if (!retired) return null;
  return (
    <p role="status" className={styles.retired}>
      {RETIRED}
    </p>
  );
}
