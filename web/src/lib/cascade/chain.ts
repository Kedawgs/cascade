import { createPublicClient, defineChain, http, type PublicClient } from "viem";
import { base } from "viem/chains";
import { MULTICALL3, RPC } from "./config";

export const bittensor = defineChain({
  id: 964,
  name: "Bittensor EVM",
  nativeCurrency: { name: "TAO", symbol: "TAO", decimals: 18 },
  rpcUrls: { default: { http: [RPC.bittensor] } },
  contracts: { multicall3: { address: MULTICALL3 } },
});

export interface Clients {
  base: PublicClient;
  /** Base log reads only (RPC.baseLogs: mainnet.base.org refuses eth_getLogs), in windows of at most 2,000 blocks. */
  baseLogs: PublicClient;
  bittensor: PublicClient;
}

/** Public RPCs, JSON-RPC batching and Multicall3 on both chains, gentle retries (Base rate-limits bursts). */
export function createClients(): Clients {
  const transport = (url: string) => http(url, { batch: { wait: 50 }, retryCount: 4, retryDelay: 1_500 });
  return {
    base: createPublicClient({ chain: base, transport: transport(RPC.base), batch: { multicall: { wait: 50 } } }) as PublicClient,
    baseLogs: createPublicClient({ chain: base, transport: transport(RPC.baseLogs) }) as PublicClient,
    bittensor: createPublicClient({
      chain: bittensor,
      transport: transport(RPC.bittensor),
      batch: { multicall: { wait: 50 } },
    }) as PublicClient,
  };
}
