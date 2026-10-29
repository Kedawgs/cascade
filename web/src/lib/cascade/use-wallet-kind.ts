"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { base } from "viem/chains";
import { useConfig } from "wagmi";
import { getCapabilities, getConnection } from "wagmi/actions";
import { atomicOf, type WalletKind } from "../stake-form";
import { useCascadeData } from "./context";
import { cascadeKeys } from "./hooks";

/** What the stake form needs to know of the connected wallet to tell a contract account how it can
 * leave (contractWalletNote): its code on Base, its connector, and whether it runs batches atomically
 * there. Read once it connects and again after each flow (a wallet may upgrade itself, or deploy its
 * account, while sending). Asking a wallet for its capabilities opens nothing: Base Account answers
 * from what it already holds, and a wallet that won't say is judged by its code alone. */
export function useWalletKind(account: string | null) {
  const data = useCascadeData();
  const config = useConfig();
  return useQuery({
    queryKey: cascadeKeys.code(account ?? ""),
    queryFn: async (): Promise<WalletKind> => {
      const a = account as Address;
      const { connector } = getConnection(config);
      const [code, caps] = await Promise.all([
        data.clients.base.getCode({ address: a }),
        getCapabilities(config, { account: a, chainId: base.id }).catch(() => undefined),
      ]);
      return { code: code ?? "0x", ...(connector ? { connectorId: connector.id } : {}), atomic: atomicOf(caps) };
    },
    enabled: account !== null,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
