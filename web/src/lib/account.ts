"use client";

import { type Config, useConnection, useDisconnect } from "wagmi";
import { disconnect as disconnectAction, getConnection } from "wagmi/actions";
import { useHydrated } from "./client-state";

export type AccountState = { status: "loading" } | { status: "none" } | { status: "wallet"; account: string };

/** Who is using the app, from wagmi's connection: a connected wallet, nobody, or not known yet (before the page has
 * its browser state, and while a reload brings a wallet back). A connection being made ("connecting") is nobody yet:
 * the Connect button stays, nothing waits on it, so an attempt that never settles (a popup closed before its wallet
 * could answer) holds nothing on the page. */
export function accountState(hydrated: boolean, connection: { status: string; address?: string | undefined }): AccountState {
  if (!hydrated) return { status: "loading" };
  if (connection.status === "connected" && connection.address) return { status: "wallet", account: connection.address };
  if (connection.status === "reconnecting") return { status: "loading" };
  return { status: "none" };
}

/** Who is using the app: a connected wallet, or nobody yet. */
export function useCascadeAccount() {
  const hydrated = useHydrated();
  const { address, status } = useConnection();
  const { mutate: disconnect } = useDisconnect();
  const state = accountState(hydrated, { status, address });

  return {
    state,
    signOut: () => {
      if (state.status === "wallet") disconnect();
    },
  };
}

/** The connected account, or null. */
export const accountOf = (state: AccountState): string | null => (state.status === "wallet" ? state.account : null);

/** Puts wagmi's own state back to rest after a connection attempt the wallet list let go of (connect-attempts.ts).
 * wagmi's connect sets its status to "connecting" and puts it back only when the wallet's promise settles, which a
 * popup closed too early never does; left there, wagmi also ignores a wallet that then connects from its own side. Its
 * disconnect, with no wallet connected, does exactly this reset and nothing else, so it is used only then: a connected
 * wallet is never touched. If the attempt let go of connects after all, wagmi sets "connected" itself. */
export function restConnecting(config: Config): void {
  const { status, address } = getConnection(config);
  if (status === "connecting" && !address && config.state.current === null) void disconnectAction(config).catch(() => undefined);
}
