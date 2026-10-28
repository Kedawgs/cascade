// For component tests only: renders on the server, as `next build` does, so a test sees the first
// HTML (which the browser's first render must match).
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { CascadeDataProvider, SnapshotAtProvider } from "@/lib/cascade/context";
import { notConfiguredData } from "@/lib/cascade/live";

/** A cached query: a value (dated `at`), and whether its last read failed. */
export interface Cached {
  key: QueryKey;
  data?: unknown;
  at?: number;
  failed?: boolean;
}

/** `seededAt`: when the server's snapshot was read, as `Providers` passes it on (none by default). */
export function renderWithCache(element: ReactElement, cached: Cached[] = [], { seededAt = 0 }: { seededAt?: number } = {}): string {
  const client = new QueryClient();
  for (const c of cached) {
    const query = client.getQueryCache().build(client, { queryKey: c.key });
    if (c.data !== undefined) client.setQueryData(c.key, c.data, { updatedAt: c.at ?? Date.now() });
    if (c.failed) query.setState({ status: "error", error: new Error("read failed"), errorUpdatedAt: Date.now() });
  }
  return renderToString(
    <QueryClientProvider client={client}>
      <SnapshotAtProvider at={seededAt}>
        <CascadeDataProvider value={notConfiguredData()}>{element}</CascadeDataProvider>
      </SnapshotAtProvider>
    </QueryClientProvider>,
  );
}

/** The text a page shows, without its markup: "5.4%APY in TAO*" for adjacent elements. */
export const plainText = (html: string): string =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
