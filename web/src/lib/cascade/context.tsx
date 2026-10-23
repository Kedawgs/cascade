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
