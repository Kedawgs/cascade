"use client";

import { useConnection, useDisconnect } from "wagmi";
import { useHydrated } from "./client-state";

export type AccountState = { status: "loading" } | { status: "none" } | { status: "wallet"; account: string };

/** Who is using the app: a connected wallet, or nobody yet. */
export function useCascadeAccount() {
  const hydrated = useHydrated();
  const { address, status } = useConnection();
  const { mutate: disconnect } = useDisconnect();

  let state: AccountState;
  if (!hydrated) state = { status: "loading" };
  else if (status === "connected" && address) state = { status: "wallet", account: address };
  else if (status === "reconnecting") state = { status: "loading" };
  else state = { status: "none" };

  return {
    state,
    signOut: () => {
      if (state.status === "wallet") disconnect();
    },
  };
}

/** The connected account, or null. */
export const accountOf = (state: AccountState): string | null => (state.status === "wallet" ? state.account : null);
