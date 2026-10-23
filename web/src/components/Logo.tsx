import styles from "./TopBar.module.css";

/** The three stepped bars from the mockups. */
export function Mark() {
  return (
    <svg width="18" height="16" viewBox="0 0 18 16" aria-hidden="true" focusable="false">
      <rect x="0" y="0" width="10" height="3.2" rx="1.6" fill="#10212B" />
      <rect x="4" y="6.4" width="10" height="3.2" rx="1.6" fill="#2E8FA3" />
      <rect x="8" y="12.8" width="10" height="3.2" rx="1.6" fill="#1E8A5A" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className={styles.logo}>
      <Mark />
      cascade
    </span>
  );
}
