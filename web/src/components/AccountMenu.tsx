"use client";

import { useId } from "react";
import { useCascadeAccount } from "@/lib/account";
import { shortAddress } from "@/lib/format";
import styles from "./TopBar.module.css";

/** The round avatar from the mockup. Opens a small menu to disconnect or leave the demo. */
export function AccountMenu() {
  const { state, signOut } = useCascadeAccount();
  const menuId = useId();

  if (state.status !== "wallet" && state.status !== "demo") {
    return <span className={styles.avatar} aria-hidden="true" />;
  }

  const isDemo = state.status === "demo";
  const name = isDemo ? "Demo account" : shortAddress(state.account);

  return (
    <>
      <button
        type="button"
        className={styles.avatar}
        popoverTarget={menuId}
        aria-label={`Account: ${name}`}
      />
      <div id={menuId} popover="auto" className={styles.menu}>
        <p className="small">{isDemo ? "You're using" : "Connected wallet"}</p>
        <p className={`strong ${styles.menuName}`}>{name}</p>
        <button type="button" className="btn btn-ghost btn-block" onClick={signOut}>
          {isDemo ? "Leave the demo" : "Disconnect"}
        </button>
      </div>
    </>
  );
}
