import { type PairingFailure, pairingFailure, pairingUri } from "./walletconnect";

/** How long the dialog waits for a pairing address before it says WalletConnect can't be reached: the code loads, the
 * relay answers and the address is there in well under a second on a good line; a relay that refuses this origin (a
 * preview address the Reown project doesn't list) or can't be reached never gives one, and the provider itself keeps
 * trying for most of a minute without saying so. */
export const PAIRING_PREPARE_MS = 30_000;

/** What the WalletConnect dialog shows. */
export type PairingView =
  | { phase: "closed" }
  /** The connector's code is loading, or the relay is being asked for a pairing. */
  | { phase: "preparing" }
  /** The pairing address, to scan, copy or open. */
  | { phase: "scan"; uri: string }
  /** It ended without a connection: why, with a way to try again. */
  | { phase: "failed"; failure: PairingFailure };

export interface PairingPort {
  /** Starts connecting through the WalletConnect connector: settles when the wallet answers or the proposal expires. */
  connect(): Promise<unknown>;
  /** Hears each pairing address the provider makes; returns how to stop hearing. */
  onUri(listener: (uri: unknown) => void): () => void;
  /** The dialog was closed on a pairing that hadn't settled (see connect-attempts.ts, released). */
  released(): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** One WalletConnect dialog's pairings. A pairing happens on another device, so unlike the wallet list's attempts
 * (connect-attempts.ts) a refusal or an expiry is said here, inside the dialog, with a way to try again; closing the
 * dialog is the person's own doing and says nothing. Only the current pairing's address and outcome are heeded: one that
 * was closed or replaced can still connect if its wallet approves after all (the wallet library does that itself). */
export function createPairing(port: PairingPort, onChange: (view: PairingView) => void) {
  let view: PairingView = { phase: "closed" };
  let attempt = 0;
  let stopUri: (() => void) | undefined;
  let timer: unknown;

  const set = (next: PairingView) => {
    view = next;
    onChange(view);
  };
  const stopTimer = () => {
    if (timer !== undefined) port.clearTimer(timer);
    timer = undefined;
  };
  const settle = () => {
    stopTimer();
    stopUri?.();
    stopUri = undefined;
  };

  function start() {
    settle();
    const mine = ++attempt;
    set({ phase: "preparing" });
    stopUri = port.onUri((raw) => {
      const uri = pairingUri(raw);
      if (mine !== attempt || !uri) return;
      stopTimer();
      set({ phase: "scan", uri });
    });
    timer = port.setTimer(() => {
      timer = undefined;
      if (mine !== attempt || view.phase !== "preparing") return;
      attempt++;
      settle();
      set({ phase: "failed", failure: "unreachable" });
      port.released();
    }, PAIRING_PREPARE_MS);
    port.connect().then(
      () => {
        if (mine !== attempt) return;
        settle();
        set({ phase: "closed" });
      },
      (e) => {
        if (mine !== attempt) return;
        settle();
        set({ phase: "failed", failure: pairingFailure(e) });
      },
    );
  }

  return {
    view: () => view,
    /** Opens the dialog on a new pairing. */
    start,
    /** The dialog was closed (its button, Esc, the backdrop): at rest, nothing said. */
    close() {
      const waiting = view.phase === "preparing" || view.phase === "scan";
      attempt++;
      settle();
      if (view.phase !== "closed") set({ phase: "closed" });
      if (waiting) port.released();
    },
    /** The dialog is gone from the page (a wallet connected, or the page changed): late answers change nothing here. */
    dispose() {
      attempt++;
      settle();
    },
  };
}

export type Pairing = ReturnType<typeof createPairing>;
