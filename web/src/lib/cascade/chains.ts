import type { SourceChain } from "./types";

export interface SourceChainInfo {
  id: SourceChain;
  label: string;
  /** Brand colour for the chip dot. */
  color: string;
  /** EVM chain id, matches the wagmi config. */
  chainId: number;
  /** Only live chains can be picked; the rest show as "Soon". */
  status: "live" | "soon";
}

/** In display order. Base is the only live chain at launch. */
export const SOURCE_CHAINS: readonly SourceChainInfo[] = [
  { id: "base", label: "Base", color: "#0052FF", chainId: 8453, status: "live" },
  { id: "ethereum", label: "Ethereum", color: "#627EEA", chainId: 1, status: "soon" },
  { id: "arbitrum", label: "Arbitrum", color: "#213147", chainId: 42161, status: "soon" },
  { id: "polygon", label: "Polygon", color: "#8247E5", chainId: 137, status: "soon" },
  { id: "bnb", label: "BNB Chain", color: "#F0B90B", chainId: 56, status: "soon" },
];

export function liveChains(): SourceChainInfo[] {
  return SOURCE_CHAINS.filter((c) => c.status === "live");
}

export function chainInfo(id: SourceChain): SourceChainInfo {
  const info = SOURCE_CHAINS.find((c) => c.id === id);
  if (!info) throw new Error(`Unknown chain: ${id}`);
  return info;
}

export function isSourceChain(value: unknown): value is SourceChain {
  return SOURCE_CHAINS.some((c) => c.id === value);
}
