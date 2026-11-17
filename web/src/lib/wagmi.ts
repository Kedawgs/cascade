import { createConfig, http } from "wagmi";
import { base } from "wagmi/chains";
import { baseAccount } from "wagmi/connectors/baseAccount";
import { injected } from "wagmi/connectors/injected";
import { RPC } from "./cascade/config";
import { walletConnectId } from "./walletconnect";
import { cascadeWalletConnect } from "./walletconnect-connector";

/** The ways to connect: Base Account, the browser's own wallets (EIP-6963 announces each; `injected` is the
 * fallback), and WalletConnect when the build has a project id (walletconnect.ts: off makes no connector at all).
 * telemetry: false keeps the Base Account SDK from loading Coinbase analytics on every page. WalletConnect's code is
 * loaded only when it is used (walletconnect-connector.ts). */
export function walletConnectors(walletConnectProject: string | null) {
  return [
    baseAccount({ appName: "Cascade", preference: { telemetry: false } }),
    injected(),
    ...(walletConnectProject ? [cascadeWalletConnect(walletConnectProject)] : []),
  ];
}

/** Base only: every transaction and signature the site's flows ask for is on Base (Bittensor is read through
 * its own public clients). A wallet on any other chain is asked to switch before anything is sent (use-flows.ts,
 * switchToBase). The one exception, v3.2's emergency page, sends on Bittensor through the wallet's own provider,
 * checking its chain first (use-direct-exit.ts), so this config stays Base only. (A WalletConnect session is also asked
 * for Bittensor EVM, as a chain the wallet may approve, for that page: walletconnect-inner.ts.) */
export const wagmiConfig = createConfig({
  chains: [base],
  connectors: walletConnectors(walletConnectId),
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
