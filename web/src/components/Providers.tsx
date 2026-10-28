"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { CascadeDataProvider, SnapshotAtProvider } from "@/lib/cascade/context";
import { seedSnapshot } from "@/lib/cascade/hooks";
import type { Snapshot } from "@/lib/cascade/snapshot";
import { wagmiConfig } from "@/lib/wagmi";

export function Providers({ children, snapshot }: { children: ReactNode; snapshot?: Snapshot }) {
  // the snapshot's date is kept with the cache it seeded (a later render's snapshot seeds nothing), so
  // a price still the snapshot's is never taken for a live read's
  const [{ queryClient, seededAt }] = useState(() => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000 } } });
    if (snapshot) seedSnapshot(client, snapshot);
    return { queryClient: client, seededAt: snapshot?.at ?? 0 };
  });
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <SnapshotAtProvider at={seededAt}>
          <CascadeDataProvider>{children}</CascadeDataProvider>
        </SnapshotAtProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
