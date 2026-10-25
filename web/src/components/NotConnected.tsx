import { DEPLOYMENT } from "@/lib/cascade/config";
import styles from "./NotConnected.module.css";

/** Shown on every page when the site has no deployment to read: no figure appears until it does. */
export function NotConnectedBanner() {
  if (DEPLOYMENT) return null;
  return (
    <p className={styles.banner} role="status">
      Cascade is getting ready. Staking opens here soon.
      {process.env.NODE_ENV === "development" && (
        <>
          {" "}
          (Developers: run <code>pnpm ops web-config --live</code> and restart the site.)
        </>
      )}
    </p>
  );
}
