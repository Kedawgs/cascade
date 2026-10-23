import Link from "next/link";
import { AccountMenu } from "./AccountMenu";
import { Logo } from "./Logo";
import styles from "./TopBar.module.css";

export function HomeTopBar() {
  return (
    <header className={styles.bar}>
      <Link href="/" className={styles.home} aria-label="Cascade home">
        <Logo />
      </Link>
      <AccountMenu />
    </header>
  );
}

export function BackTopBar({ title, backHref = "/" }: { title: string; backHref?: string }) {
  return (
    <header className={styles.bar}>
      <Link href={backHref} className={styles.back}>
        Back
      </Link>
      <span className={styles.title}>{title}</span>
    </header>
  );
}
