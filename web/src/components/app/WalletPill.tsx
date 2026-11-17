"use client";

import { useId } from "react";
import { useAccount } from "wagmi";
import { useCascadeAccount } from "@/lib/account";
import { shortAddress } from "@/lib/format";
import { useUsdcBalance } from "@/lib/use-usdc-balance";
import { availableToStake } from "@/lib/usdc-balance";
import type { WalletPeer } from "@/lib/walletconnect";
import { connectorPeer } from "@/lib/walletconnect-connector";
import { ConnectWallet, ConnectWalletGhost, walletIcon, walletName } from "../ConnectWallet";
import styles from "./AppShell.module.css";

/** The icon the pill shows for the connected wallet: the one its connector announced, else the one its WalletConnect
 * session named, and either only as an inlined image (walletIcon). A session's icon is nearly always a web address:
 * that is never loaded, and the plain avatar stands in. */
export function pillIcon(connector: { icon?: unknown } | undefined, peer?: WalletPeer): string | undefined {
  return walletIcon(connector?.icon) ?? walletIcon(peer?.icon);
}

/** The pill and its menu for a connected wallet: the balance, the short address, the wallet's icon (or the avatar),
 * and a menu that names the wallet and disconnects. `wallet` is the wallet's name as the site may show it. */
export function WalletPillView({
  name,
  balance,
  wallet,
  icon,
  onDisconnect,
}: {
  name: string;
  balance: string;
  wallet?: string | undefined;
  icon?: string | undefined;
  onDisconnect: () => void;
}) {
  const menuId = useId();
  // only an inlined image ever reaches the <img>, whatever a caller passes
  const src = walletIcon(icon);
  return (
    <>
      <button
        type="button"
        className={styles.wallet}
        popoverTarget={menuId}
        aria-label={wallet ? `Account menu: ${name}, connected with ${wallet}` : `Account menu: ${name}`}
      >
        <span className={styles.walletBalance}>{balance}</span>
        <span className={styles.walletAddr}>
          {name}
          {src ? (
            // the wallet's own mark, so the pill says how you are connected; decorative: the menu names it
            // eslint-disable-next-line @next/next/no-img-element
            <img className={styles.avatarIcon} src={src} alt="" width={30} height={30} />
          ) : (
            <span className={styles.avatar} aria-hidden="true" />
          )}
        </span>
      </button>
      <div id={menuId} popover="auto" className={styles.menu}>
        <p className={styles.menuLabel}>{wallet ? `Connected with ${wallet}` : "Connected wallet"}</p>
        <p className={styles.menuName}>{name}</p>
        <button type="button" className="pill pill-ghost pill-block" onClick={onDisconnect}>
          Disconnect
        </button>
      </div>
    </>
  );
}

/** Balance plus short address, with the connected wallet's own icon (when it announced one) and a small menu that
 * names the wallet and disconnects. Through WalletConnect the name is the wallet's own, from its session. */
export function WalletPill() {
  const { state, signOut } = useCascadeAccount();
  const { connector } = useAccount();
  const balance = useUsdcBalance();

  // the connect button's place, until it is known whether a wallet is connected
  if (state.status === "loading") return <ConnectWalletGhost />;
  if (state.status === "none") return <ConnectWallet variant="pill" />;

  const peer = connectorPeer(connector);
  return (
    <WalletPillView
      name={shortAddress(state.account)}
      balance={availableToStake(balance).text}
      wallet={connector ? walletName(connector, peer) : undefined}
      icon={pillIcon(connector, peer)}
      onDisconnect={signOut}
    />
  );
}
