"use client";

import { type ReactNode, useEffect, useId, useState } from "react";
import { type Config, type Connector, useConfig, useConnectors } from "wagmi";
import { connect } from "wagmi/actions";
import { restConnecting } from "@/lib/account";
import { type AttemptsView, createConnectAttempts } from "@/lib/connect-attempts";
import { WALLETCONNECT_ID, WALLETCONNECT_OPTION, walletConnectLabel, type WalletPeer } from "@/lib/walletconnect";
import { createPairing, type PairingView } from "@/lib/walletconnect-pairing";
import styles from "./ConnectWallet.module.css";
import { WalletConnectDialog } from "./WalletConnectDialog";

/** What a wallet is called on the site: its own name, as it announced it (EIP-6963), or ours for the two built in. */
export function connectorLabel(c: Pick<Connector, "id" | "name">): string {
  if (c.id === "baseAccount") return "Base Account";
  if (c.id === "injected") return "Browser wallet";
  return c.name;
}

/** What the pill calls the connected wallet: as the list does, and through WalletConnect the wallet's own name as its
 * session gave it (`peer`: untrusted, already cut to plain text, walletconnect.ts walletPeer). */
export function walletName(c: Pick<Connector, "id" | "name">, peer?: WalletPeer): string {
  return c.id === WALLETCONNECT_ID ? walletConnectLabel(peer) : connectorLabel(c);
}

/** A wallet's own icon, only when it is an image inlined as a data: URI (what EIP-6963 wallets announce, and all the
 * site's Content-Security-Policy lets an <img> load besides its own files): never a remote address. */
export function walletIcon(icon: unknown): string | undefined {
  return typeof icon === "string" && /^data:image\/(png|svg\+xml|webp|jpeg|gif);/i.test(icon) && icon.length <= 200_000 ? icon : undefined;
}

/**
 * Base Account first, then any wallets the browser announced (EIP-6963), then WalletConnect when the build offers it.
 * The generic injected connector only shows when nothing was announced but
 * `window.ethereum` exists (`hasInjected`: the browser's own answer unless a test gives one).
 */
export function pickConnectors<C extends Pick<Connector, "id" | "type">>(all: readonly C[], hasInjected?: boolean): C[] {
  const baseAccount = all.filter((c) => c.id === "baseAccount");
  const announced = all.filter((c) => c.type === "injected" && c.id !== "injected");
  const injected = hasInjected ?? (typeof window !== "undefined" && "ethereum" in window);
  const generic = injected ? all.filter((c) => c.id === "injected") : [];
  const walletConnect = all.filter((c) => c.id === WALLETCONNECT_ID);
  return [...baseAccount, ...(announced.length > 0 ? announced : generic), ...walletConnect];
}

type Option = Pick<Connector, "id" | "name" | "type" | "uid">;

/** The list of wallets to pick from, inside the panel: its markup for a state. The wallet being connected to says so
 * and offers Cancel on its row; every other wallet stays there to pick (a wallet's answer may never come, so nothing
 * here waits on one). A failure that wasn't the person's own doing is one sentence under the options, inside the
 * panel, where it moves nothing outside it. */
export function WalletList({
  options,
  view,
  onChoose,
  onCancel,
}: {
  options: readonly Option[];
  view: AttemptsView;
  onChoose: (uid: string) => void;
  onCancel: () => void;
}) {
  return (
    <>
      <ul className={styles.options} aria-label="Choose a wallet">
        {options.map((c) => {
          const pending = view.pending === c.uid;
          return (
            <li key={c.uid} className={styles.row}>
              {/* the same button while it connects, so focus stays where it was; pressing it again does nothing */}
              <button
                type="button"
                className={`pill pill-ghost pill-block ${c.id === WALLETCONNECT_ID ? styles.twoLine : ""} ${pending ? styles.pending : ""}`}
                aria-disabled={pending || undefined}
                onClick={() => {
                  if (!pending) onChoose(c.uid);
                }}
              >
                {pending ? (
                  `Connecting to ${connectorLabel(c)}…`
                ) : c.id === WALLETCONNECT_ID ? (
                  <>
                    <span>{WALLETCONNECT_OPTION.name}</span>
                    <span className={styles.optionNote}>{WALLETCONNECT_OPTION.note}</span>
                  </>
                ) : (
                  connectorLabel(c)
                )}
              </button>
              {pending && (
                <button type="button" className={`pill pill-ghost pill-sm ${styles.cancel}`} onClick={onCancel}>
                  Cancel
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {!options.some((c) => c.type === "injected") && <p className={styles.hint}>No browser wallet found. Base Account works in any browser.</p>}
      {view.error && (
        <p className={styles.error} role="alert">
          {view.error}
        </p>
      )}
    </>
  );
}

/** The Connect button with what belongs to it: the panel its list opens in, and WalletConnect's dialog when the build
 * offers it. Nothing else is ever a child of the button's wrapper: in the app bar the wrapper is in the bar's flow, so
 * anything added there would move the button. The panel hangs under the button there (the stylesheet), and a dialog is
 * out of the flow closed or open; a failure's sentence is inside the panel (WalletList). */
export function ConnectWalletView({
  variant = "pill",
  label = "Connect wallet",
  open,
  onToggle,
  children,
  dialog,
}: {
  variant?: "pill" | "pill-block";
  label?: string;
  open: boolean;
  onToggle: () => void;
  /** The list, shown while open. */
  children?: ReactNode;
  dialog?: ReactNode;
}) {
  const listId = useId();
  const block = variant === "pill-block";
  return (
    <div className={block ? styles.block : styles.inline}>
      <button type="button" className={`pill ${block ? "pill-block" : ""} ${styles.button}`} aria-expanded={open} aria-controls={listId} onClick={onToggle}>
        {label}
      </button>
      <div id={listId} hidden={!open} className={styles.panel}>
        {open && children}
      </div>
      {dialog}
    </div>
  );
}

const AT_REST: AttemptsView = { pending: null, error: null };
const timers = { setTimer: (fn: () => void, ms: number) => window.setTimeout(fn, ms), clearTimer: (handle: unknown) => window.clearTimeout(handle as number) };
const connectorOf = (config: Config, uid: string) => config.connectors.find((c) => c.uid === uid);

/** A "Connect wallet" button that opens the list of wallets to pick from. */
export function ConnectWallet({
  variant = "pill",
  label = "Connect wallet",
}: {
  variant?: "pill" | "pill-block";
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const config = useConfig();
  const connectors = useConnectors();
  const options = open ? pickConnectors(connectors) : [];
  const walletConnect = connectors.find((c) => c.id === WALLETCONNECT_ID);

  // the list's attempts (connect-attempts.ts): what it shows never waits on a wallet's promise
  const [view, setView] = useState<AttemptsView>(AT_REST);
  const [attempts] = useState(() =>
    createConnectAttempts(
      {
        connect: (uid) => {
          const connector = connectorOf(config, uid);
          return connector ? connect(config, { connector }) : Promise.reject(new Error("That wallet is no longer in the list"));
        },
        released: () => restConnecting(config),
        ...timers,
      },
      setView,
    ),
  );
  // WalletConnect's dialog (walletconnect-pairing.ts): its pairing happens on another device, so it says what came of it
  const [pairingView, setPairingView] = useState<PairingView>({ phase: "closed" });
  const [pairing] = useState(() =>
    createPairing(
      {
        connect: () => {
          const connector = config.connectors.find((c) => c.id === WALLETCONNECT_ID);
          return connector ? connect(config, { connector }) : Promise.reject(new Error("WalletConnect is off in this build"));
        },
        onUri(listener) {
          const connector = config.connectors.find((c) => c.id === WALLETCONNECT_ID);
          const heard = (message: { type: string; data?: unknown }) => {
            if (message.type === "display_uri") listener(message.data);
          };
          connector?.emitter.on("message", heard);
          return () => connector?.emitter.off("message", heard);
        },
        released: () => restConnecting(config),
        ...timers,
      },
      setPairingView,
    ),
  );

  useEffect(() => {
    // a wallet's popup or window was in front and this one is back: an attempt still unanswered a moment later is let go
    const back = () => {
      if (document.visibilityState === "visible") attempts.windowBack();
    };
    const away = () => attempts.windowAway();
    const seen = () => (document.visibilityState === "visible" ? attempts.windowBack() : attempts.windowAway());
    window.addEventListener("focus", back);
    window.addEventListener("blur", away);
    document.addEventListener("visibilitychange", seen);
    return () => {
      window.removeEventListener("focus", back);
      window.removeEventListener("blur", away);
      document.removeEventListener("visibilitychange", seen);
      attempts.dispose();
      pairing.dispose();
    };
  }, [attempts, pairing]);

  return (
    <ConnectWalletView
      variant={variant}
      label={label}
      open={open}
      onToggle={() => {
        // closing the list lets go of an attempt and clears its sentence
        if (open) attempts.closed();
        setOpen((v) => !v);
      }}
      dialog={walletConnect && <WalletConnectDialog view={pairingView} onRetry={pairing.start} onClose={pairing.close} />}
    >
      <WalletList
        options={options}
        view={view}
        onChoose={(uid) => {
          if (connectorOf(config, uid)?.id === WALLETCONNECT_ID) {
            // WalletConnect has its own dialog: the list goes back to rest behind it
            attempts.closed();
            pairing.start();
          } else attempts.choose(uid);
        }}
        onCancel={attempts.cancel}
      />
    </ConnectWalletView>
  );
}

/** The inline button's exact box, greyed and inert: it holds the button's place until the page knows
 * whether a wallet is connected, so the button arriving moves nothing. */
export function ConnectWalletGhost() {
  return (
    <div className={styles.inline} aria-hidden="true">
      <span className={`pill ${styles.button} ${styles.ghost}`}>Connect wallet</span>
    </div>
  );
}
