import { createConfig, http } from "wagmi";
import { base } from "wagmi/chains";
import { baseAccount } from "wagmi/connectors/baseAccount";
import { injected } from "wagmi/connectors/injected";
import { RPC } from "./cascade/config";

/** Base only: every transaction and signature the site asks for is on Base (Bittensor is only read,
 * through its own public clients). A wallet on any other chain is asked to switch before anything is
 * sent (use-flows.ts, switchToBase). */
export const wagmiConfig = createConfig({
  chains: [base],
  // Base Account, and the browser's own wallets (EIP-6963 announces each; `injected` is the fallback).
  // telemetry: false keeps the Base Account SDK from loading Coinbase analytics on every page.
  connectors: [baseAccount({ appName: "Cascade", preference: { telemetry: false } }), injected()],
  transports: {
    [base.id]: http(RPC.base),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
