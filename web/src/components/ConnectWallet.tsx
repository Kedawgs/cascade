"use client";

import { useId, useState } from "react";
import { useConnect, useConnectors, type Connector } from "wagmi";
import styles from "./Landing.module.css";

function connectorLabel(c: Connector): string {
  if (c.id === "baseAccount") return "Base Account";
  if (c.id === "injected") return "Browser wallet";
  return c.name;
}

/**
 * Base Account first, then any wallets the browser announced (EIP-6963).
 * The generic injected connector only shows when nothing was announced but
 * `window.ethereum` exists.
 */
function pickConnectors(all: readonly Connector[]): Connector[] {
  const baseAccount = all.filter((c) => c.id === "baseAccount");
  const announced = all.filter((c) => c.type === "injected" && c.id !== "injected");
  const hasInjected = typeof window !== "undefined" && "ethereum" in window;
  const generic = hasInjected ? all.filter((c) => c.id === "injected") : [];
  return [...baseAccount, ...(announced.length > 0 ? announced : generic)];
}

function friendlyError(error: Error): string {
  const text = `${error.name} ${error.message}`.toLowerCase();
  if (text.includes("reject") || text.includes("denied") || text.includes("closed")) {
    return "The wallet closed before connecting. Try again when you're ready.";
  }
  return "We couldn't connect to that wallet. Try again or pick another one.";
}

export function ConnectWallet() {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const connectors = useConnectors();
  const { mutate: connect, isPending, variables, error } = useConnect();
  const options = open ? pickConnectors(connectors) : [];
  const pendingUid =
    isPending && variables && "uid" in variables.connector ? variables.connector.uid : null;

  return (
    <div>
      <button
        type="button"
        className="btn btn-primary btn-block"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
      >
        Connect wallet
      </button>
      <div id={listId} hidden={!open}>
        {open && (
          <ul className={styles.options} aria-label="Choose a wallet">
            {options.map((c) => (
              <li key={c.uid}>
                <button
                  type="button"
                  className={`btn btn-ghost btn-block ${styles.option}`}
                  disabled={isPending}
                  onClick={() => connect({ connector: c })}
                >
                  {pendingUid === c.uid ? `Connecting to ${connectorLabel(c)}…` : connectorLabel(c)}
                </button>
              </li>
            ))}
          </ul>
        )}
        {open && !options.some((c) => c.type === "injected") && (
          <p className={`small ${styles.hint}`}>
            No browser wallet found. Base Account works in any browser.
          </p>
        )}
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {friendlyError(error)}
        </p>
      )}
    </div>
  );
}
