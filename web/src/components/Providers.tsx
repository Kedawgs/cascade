"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { CascadeDataProvider } from "@/lib/cascade/context";
import { seedSnapshot } from "@/lib/cascade/hooks";
import type { Snapshot } from "@/lib/cascade/snapshot";
import { wagmiConfig } from "@/lib/wagmi";

export function Providers({ children, snapshot }: { children: ReactNode; snapshot?: Snapshot }) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000 } } });
    if (snapshot) seedSnapshot(client, snapshot);
    return client;
  });
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <CascadeDataProvider>{children}</CascadeDataProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
