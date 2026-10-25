import { DEPLOYMENT } from "@/lib/cascade/config";
import styles from "./NotConnected.module.css";

/** Shown on every page when the site has no deployment to read: no figure appears until it does. */
export function NotConnectedBanner() {
  if (DEPLOYMENT) return null;
  return (
    <p className={styles.banner} role="status">
      Cascade isn&apos;t connected to a deployment yet. Run <code>pnpm ops web-config --live</code> and restart the site.
    </p>
  );
}
