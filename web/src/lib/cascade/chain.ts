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
  /** The second Base RPC for the checks made right before a send (the oracle's price against a quote,
   * the bridge fee again: reads.ts), on its own connection with a short timeout and one retry, so a
   * server that hangs can't hold a wallet prompt for long; reads.ts falls back to `base` where it can. */
  baseCheck: PublicClient;
  bittensor: PublicClient;
  /** Bittensor reads of old state in the background (the check of an account's seeded history: live.ts) on their own
   * connection, so a slow archive answer never holds up the reads the screens need: its own batches, a 10 s timeout,
   * two quick retries (the archive node turns bursts away). The yield's 30-day lookback has its own two below. */
  bittensorHistory: PublicClient;
  /** The vault's log scan (and its receipt checks) on their own connection: each window's log query and
   * server head go together to one server, never in a batch with the balance reads nor holding them up. */
  bittensorScan: PublicClient;
  /** The yield's reads of today's state (reads.ts readApyPercent: the stake hotkey, the reward cut, the head, the block
   * time, today's value of the return series), in their own batches on a connection that waits YIELD_TIMEOUT_MS for an
   * answer and asks once more at most: the public archive node can take 18 s over a read of today's state, which the
   * other connections' 10 s gives up on. */
  bittensorYield: PublicClient;
  /** The yield's reads of the block 30 days back, the slow ones (10 to 40 s on the public archive node): the same
   * wait and the one retry, and no batching at all, so each travels alone and nothing waits on it but the yield. */
  bittensorDeep: PublicClient;
}

/** How long the yield's connections wait for one answer from Bittensor's archive node before asking again. */
export const YIELD_TIMEOUT_MS = 90_000;
/** How many times the yield's connections ask again after a failed or unanswered request: once. */
export const YIELD_RETRIES = 1;

/** Public RPCs, JSON-RPC batching and Multicall3 on both chains, gentle retries (Base rate-limits bursts).
 * `timeoutMs`: how long the screens' connections (`base`, `baseLogs`, `bittensor`) wait for one answer before asking
 * again; viem's 10 s unless given (the build's snapshot gives more: snapshot.ts). */
export function createClients(o: { timeoutMs?: number } = {}): Clients {
  const transport = (url: string) => http(url, { batch: { wait: 50 }, retryCount: 4, retryDelay: 1_500, ...(o.timeoutMs !== undefined ? { timeout: o.timeoutMs } : {}) });
  return {
    base: createPublicClient({ chain: base, transport: transport(RPC.base), batch: { multicall: { wait: 50 } } }) as PublicClient,
    baseLogs: createPublicClient({ chain: base, transport: transport(RPC.baseLogs) }) as PublicClient,
    baseCheck: createPublicClient({ chain: base, transport: http(RPC.baseLogs, { timeout: 3_000, retryCount: 1, retryDelay: 500 }) }) as PublicClient,
    bittensor: createPublicClient({
      chain: bittensor,
      transport: transport(RPC.bittensor),
      batch: { multicall: { wait: 50 } },
    }) as PublicClient,
    bittensorHistory: createPublicClient({
      chain: bittensor,
      transport: http(RPC.bittensor, { batch: true, timeout: 10_000, retryCount: 2, retryDelay: 1_000 }),
    }) as PublicClient,
    bittensorScan: createPublicClient({
      chain: bittensor,
      transport: http(RPC.bittensor, { batch: true, retryCount: 4, retryDelay: 1_500 }),
    }) as PublicClient,
    bittensorYield: createPublicClient({
      chain: bittensor,
      transport: http(RPC.bittensor, { batch: true, timeout: YIELD_TIMEOUT_MS, retryCount: YIELD_RETRIES, retryDelay: 2_000 }),
    }) as PublicClient,
    bittensorDeep: createPublicClient({
      chain: bittensor,
      transport: http(RPC.bittensor, { timeout: YIELD_TIMEOUT_MS, retryCount: YIELD_RETRIES, retryDelay: 2_000 }),
    }) as PublicClient,
  };
}
