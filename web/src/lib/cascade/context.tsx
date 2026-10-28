"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { createCascadeData } from "./index";
import type { CascadeData } from "./types";

const CascadeDataContext = createContext<CascadeData | null>(null);

export function CascadeDataProvider({
  children,
  value,
}: {
  children: ReactNode;
  /** Override for tests or previews. Defaults to `createCascadeData()`. */
  value?: CascadeData;
}) {
  const [data] = useState(() => value ?? createCascadeData());
  return <CascadeDataContext.Provider value={data}>{children}</CascadeDataContext.Provider>;
}

export function useCascadeData(): CascadeData {
  const data = useContext(CascadeDataContext);
  if (!data) throw new Error("useCascadeData must be used inside <CascadeDataProvider>");
  return data;
}

/** When the server's snapshot was read (snapshot.ts), or 0 with none. A cached figure dated exactly
 * then is still the snapshot's: no live read has replaced it yet. */
const SnapshotAtContext = createContext(0);

export function SnapshotAtProvider({ at, children }: { at: number; children: ReactNode }) {
  return <SnapshotAtContext.Provider value={at}>{children}</SnapshotAtContext.Provider>;
}

export function useSnapshotAt(): number {
  return useContext(SnapshotAtContext);
}
