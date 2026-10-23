import type { SourceChain } from "./types";

export interface SourceChainInfo {
  id: SourceChain;
  label: string;
  /** Dot color used in the chain picker (from the approved mockup). */
  color: string;
  /** EVM chain id, matches the wagmi config. */
  chainId: number;
}

export const SOURCE_CHAINS: readonly SourceChainInfo[] = [
  { id: "base", label: "Base", color: "#2563EB", chainId: 8453 },
  { id: "ethereum", label: "Ethereum", color: "#6B7280", chainId: 1 },
  { id: "bnb", label: "BNB Chain", color: "#D4A017", chainId: 56 },
  { id: "polygon", label: "Polygon", color: "#7C3AED", chainId: 137 },
];

export function chainInfo(id: SourceChain): SourceChainInfo {
  const info = SOURCE_CHAINS.find((c) => c.id === id);
  if (!info) throw new Error(`Unknown chain: ${id}`);
  return info;
}

export function isSourceChain(value: unknown): value is SourceChain {
  return SOURCE_CHAINS.some((c) => c.id === value);
}
