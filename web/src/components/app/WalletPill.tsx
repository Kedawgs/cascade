"use client";

import { useId } from "react";
import { useCascadeAccount } from "@/lib/account";
import { shortAddress } from "@/lib/format";
import { useUsdcBalance } from "@/lib/use-usdc-balance";
import { availableToStake } from "@/lib/usdc-balance";
import { ConnectWallet } from "../ConnectWallet";
import styles from "./AppShell.module.css";

/** Balance plus short address, with a small menu to disconnect. */
export function WalletPill() {
  const { state, signOut } = useCascadeAccount();
  const balance = useUsdcBalance();
  const menuId = useId();

  if (state.status === "loading") return <span className={styles.walletGhost} aria-hidden="true" />;
  if (state.status === "none") return <ConnectWallet variant="pill" />;

  const name = shortAddress(state.account);

  return (
    <>
      <button
        type="button"
        className={styles.wallet}
        popoverTarget={menuId}
        aria-label={`Account menu: ${name}`}
      >
        <span className={styles.walletBalance}>{availableToStake(balance).text}</span>
        <span className={styles.walletAddr}>
          {name}
          <span className={styles.avatar} aria-hidden="true" />
        </span>
      </button>
      <div id={menuId} popover="auto" className={styles.menu}>
        <p className={styles.menuLabel}>Connected wallet</p>
        <p className={styles.menuName}>{name}</p>
        <button type="button" className="pill pill-ghost pill-block" onClick={signOut}>
          Disconnect
        </button>
      </div>
    </>
  );
}
