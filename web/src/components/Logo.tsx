import styles from "./Logo.module.css";

/** The three stepped bars. */
export function Mark({ size = 18 }: { size?: number }) {
  const height = Math.round((size * 16) / 18);
  return (
    <svg width={size} height={height} viewBox="0 0 18 16" aria-hidden="true" focusable="false">
      <rect x="0" y="0" width="10" height="3.2" rx="1.6" fill="#10212B" />
      <rect x="4" y="6.4" width="10" height="3.2" rx="1.6" fill="#2E8FA3" />
      <rect x="8" y="12.8" width="10" height="3.2" rx="1.6" fill="#1E8A5A" />
    </svg>
  );
}

export function Logo({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span className={`${styles.logo} ${size === "lg" ? styles.lg : ""}`}>
      <Mark size={size === "lg" ? 24 : 18} />
      cascade
    </span>
  );
}
