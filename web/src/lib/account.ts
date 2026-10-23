"use client";

import { useSyncExternalStore } from "react";
import { useConnection, useDisconnect } from "wagmi";
import { useHydrated } from "./client-state";

/** Fixed account id used by "Try the demo". It only ever hits the mock adapter. */
export const DEMO_ACCOUNT = "demo";

const DEMO_FLAG_KEY = "cascade.demoMode";
let demoInMemory = false;
const listeners = new Set<() => void>();

function readDemoFlag(): boolean {
  try {
    const stored = window.localStorage.getItem(DEMO_FLAG_KEY);
    return stored === null ? demoInMemory : stored === "1";
  } catch {
    return demoInMemory;
  }
}

function writeDemoFlag(on: boolean): void {
  demoInMemory = on;
  try {
    if (on) window.localStorage.setItem(DEMO_FLAG_KEY, "1");
    else window.localStorage.removeItem(DEMO_FLAG_KEY);
  } catch {
    // Storage blocked: the in-memory flag still works for this tab.
  }
  listeners.forEach((notify) => notify());
}

function subscribeDemoFlag(notify: () => void): () => void {
  listeners.add(notify);
  window.addEventListener("storage", notify);
  return () => {
    listeners.delete(notify);
    window.removeEventListener("storage", notify);
  };
}

export type AccountState =
  | { status: "loading" }
  | { status: "none" }
  | { status: "wallet"; account: string }
  | { status: "demo"; account: string };

/** Who is using the app: a connected wallet, the demo account, or nobody yet. */
export function useCascadeAccount() {
  const hydrated = useHydrated();
  const demo = useSyncExternalStore(subscribeDemoFlag, readDemoFlag, () => false);
  const { address, status } = useConnection();
  const { mutate: disconnect } = useDisconnect();

  let state: AccountState;
  if (!hydrated) state = { status: "loading" };
  else if (status === "connected" && address) state = { status: "wallet", account: address };
  else if (demo) state = { status: "demo", account: DEMO_ACCOUNT };
  else if (status === "reconnecting") state = { status: "loading" };
  else state = { status: "none" };

  return {
    state,
    startDemo: () => writeDemoFlag(true),
    signOut: () => {
      if (state.status === "wallet") disconnect();
      writeDemoFlag(false);
    },
  };
}
