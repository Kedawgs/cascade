import styles from "./DemoBanner.module.css";

export function DemoBanner() {
  return (
    <p className={styles.banner} role="note">
      Demo with made-up numbers. No real money moves.
    </p>
  );
}
