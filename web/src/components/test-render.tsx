// For component tests only: renders on the server, as `next build` does, so a test sees the first
// HTML (which the browser's first render must match).
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import type { Address } from "viem";
import { base } from "viem/chains";
import { createConfig, http, WagmiProvider } from "wagmi";
import { CascadeDataProvider, SnapshotAtProvider } from "@/lib/cascade/context";
import type { Clients } from "@/lib/cascade/chain";
import { type Deployment, EXPECTED_DEPLOYMENTS } from "@/lib/cascade/config";
import { createLiveCascadeData, type LiveDeps, notConfiguredData } from "@/lib/cascade/live";
import type { OpLog } from "@/lib/cascade/oplog";
import type { CascadeData } from "@/lib/cascade/types";

/** A cached query: a value (dated `at`), and whether its last read failed. */
export interface Cached {
  key: QueryKey;
  data?: unknown;
  at?: number;
  failed?: boolean;
}

/** A wallet config with no wallets, for components that send (useFlows needs one; a server render
 * connects nothing). */
const testWagmi = createConfig({ chains: [base], transports: { [base.id]: http() }, multiInjectedProviderDiscovery: false, ssr: true });

/** `seededAt`: when the server's snapshot was read, as `Providers` passes it on (none by default).
 * `data`: the data source (its deployment, its op log); no deployment by default.
 * `client`: the query cache to render with, for a test that looks at what the render set up in it (a new one by default). */
export function renderWithCache(
  element: ReactElement,
  cached: Cached[] = [],
  { seededAt = 0, data = notConfiguredData(), client = new QueryClient() }: { seededAt?: number; data?: CascadeData; client?: QueryClient } = {},
): string {
  for (const c of cached) {
    const query = client.getQueryCache().build(client, { queryKey: c.key });
    if (c.data !== undefined) client.setQueryData(c.key, c.data, { updatedAt: c.at ?? Date.now() });
    if (c.failed) query.setState({ status: "error", error: new Error("read failed"), errorUpdatedAt: Date.now() });
  }
  return renderToString(
    <WagmiProvider config={testWagmi as never}>
      <QueryClientProvider client={client}>
        <SnapshotAtProvider at={seededAt}>
          <CascadeDataProvider value={data}>{element}</CascadeDataProvider>
        </SnapshotAtProvider>
      </QueryClientProvider>
    </WagmiProvider>,
  );
}

const LAUNCH = EXPECTED_DEPLOYMENTS["v3-launch"];

/** A data source for the launch deployment as the site is built for it, with its own op log (in memory
 * unless given), and anything `over` changes (an indexer named, say), and `given` gives it (the committed deployments
 * its switches are read from, say). It reads nothing: a server render asks no query for data. */
export function launchData(opLog?: OpLog, over: Partial<Deployment> = {}, given: Partial<LiveDeps> = {}): CascadeData {
  const d: Deployment = {
    frontDoor: LAUNCH.frontDoor as Address,
    baseAdapter: LAUNCH.baseAdapter as Address,
    vault: LAUNCH.vault as Address,
    bitAdapter: LAUNCH.bitAdapter as Address,
    bitBlock: BigInt(LAUNCH.bitBlock),
    vaultSs58: LAUNCH.vaultSs58,
    hotkeySs58: LAUNCH.hotkeySs58,
    staker: LAUNCH.staker as Address,
    oracle: LAUNCH.oracle as Address,
    batchMaxWaitS: LAUNCH.batchMaxWaitS,
    payoutDelayS: LAUNCH.payoutDelayS,
    ...over,
  };
  return createLiveCascadeData(d, { clients: {} as Clients, ...(opLog ? { opLog } : {}), ...given });
}

/** The text a page shows, without its markup: "5.4%APY in TAO*" for adjacent elements. */
export const plainText = (html: string): string =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");

/** What a screen reader is given of a page: its text without what is hidden from it (a figure's node on screen, whose
 * twin it reads instead; a dash; a skeleton): "5.4%APY in TAO*", "LoadingAPY in TAO*", "Not availableAPY in TAO*". */
export const spokenText = (html: string): string => plainText(html.replace(/<span[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g, ""));

/** What is on screen: a page's text without the screen readers' own: "5.4%APY in TAO*", "APY in TAO*" (a skeleton has
 * no text), "–APY in TAO*". */
export const shownText = (html: string): string => plainText(html.replace(/<span class="sr-only[^"]*">[^<]*<\/span>/g, ""));
