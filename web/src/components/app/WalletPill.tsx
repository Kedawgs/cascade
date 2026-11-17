"use client";

import { useId } from "react";
import { useAccount } from "wagmi";
import { useCascadeAccount } from "@/lib/account";
import { shortAddress } from "@/lib/format";
import { useUsdcBalance } from "@/lib/use-usdc-balance";
import { availableToStake } from "@/lib/usdc-balance";
import { ConnectWallet, ConnectWalletGhost, connectorLabel, walletIcon } from "../ConnectWallet";
import styles from "./AppShell.module.css";

/** Balance plus short address, with the connected wallet's own icon (when it announced one) and a small menu that
 * names the wallet and disconnects. */
export function WalletPill() {
  const { state, signOut } = useCascadeAccount();
  const { connector } = useAccount();
  const balance = useUsdcBalance();
  const menuId = useId();

  // the connect button's place, until it is known whether a wallet is connected
  if (state.status === "loading") return <ConnectWalletGhost />;
  if (state.status === "none") return <ConnectWallet variant="pill" />;

  const name = shortAddress(state.account);
  const wallet = connector ? connectorLabel(connector) : undefined;
  const icon = walletIcon(connector?.icon);

  return (
    <>
      <button
        type="button"
        className={styles.wallet}
        popoverTarget={menuId}
        aria-label={wallet ? `Account menu: ${name}, connected with ${wallet}` : `Account menu: ${name}`}
      >
        <span className={styles.walletBalance}>{availableToStake(balance).text}</span>
        <span className={styles.walletAddr}>
          {name}
          {icon ? (
            // the wallet's own mark, so the pill says how you are connected; decorative: the menu names it
            // eslint-disable-next-line @next/next/no-img-element
            <img className={styles.avatarIcon} src={icon} alt="" width={30} height={30} />
          ) : (
            <span className={styles.avatar} aria-hidden="true" />
          )}
        </span>
      </button>
      <div id={menuId} popover="auto" className={styles.menu}>
        <p className={styles.menuLabel}>{wallet ? `Connected with ${wallet}` : "Connected wallet"}</p>
        <p className={styles.menuName}>{name}</p>
        <button type="button" className="pill pill-ghost pill-block" onClick={signOut}>
          Disconnect
        </button>
      </div>
    </>
  );
}
