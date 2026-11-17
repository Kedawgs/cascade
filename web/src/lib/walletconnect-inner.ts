// Loaded only when WalletConnect is used (walletconnect-connector.ts imports it dynamically): wagmi's connector, and
// through it WalletConnect's provider, sign client and relay client, are in chunks no other page load fetches.
import { base } from "viem/chains";
import { http } from "wagmi";
import { walletConnect } from "wagmi/connectors/walletConnect";
import { bittensor } from "./cascade/chain";
import { RPC } from "./cascade/config";
import { WALLETCONNECT_METADATA } from "./walletconnect";
import type { ConnectorConfig, WalletConnectInner } from "./walletconnect-connector";

/** What wagmi's connector is made with.
 * - showQrModal: false: the site draws its own dialog (WalletConnectDialog.tsx). The provider reaches for Reown AppKit
 *   only when this is true; AppKit isn't installed, and its one import resolves to a module that throws
 *   (walletconnect-no-appkit.ts).
 * - telemetryEnabled: false: nothing is sent to pulse.walletconnect.org (the core's EventClient stores and submits
 *   events only when it is on). */
export function walletConnectParameters(projectId: string) {
  return { projectId, metadata: WALLETCONNECT_METADATA, showQrModal: false, telemetryEnabled: false } as const;
}

/** The chains a session is asked for, and where the provider reads each: Base, which the site requires (held after the
 * wallet answers, walletconnect.ts baseAccounts), and Bittensor EVM, so the emergency page can send there when the wallet
 * approves it (/unstake/bittensor; a wallet that doesn't is told so by that page's own handling). Both are optional on
 * the wire: WalletConnect has no required chains any more. The provider's own reads go to the site's RPCs (the policy
 * already allows them), never to rpc.walletconnect.org. The site's wagmi config stays Base only: these are this
 * connector's alone. */
export function innerConfig(config: ConnectorConfig): ConnectorConfig {
  return {
    ...config,
    chains: [base, bittensor],
    transports: { ...config.transports, [base.id]: config.transports?.[base.id] ?? http(RPC.base), [bittensor.id]: http(RPC.bittensor) },
  };
}

/** Turns off WalletConnect's Verify frame on this provider's client. Before each proposal and each request, the core
 * loads a hidden iframe from verify.walletconnect.org to fetch an attestation of the page's origin (it lets a wallet show
 * "verified domain") and waits up to five seconds for it. The provider has no option for it, and the site's policy
 * allows no frame at all (frame-src 'none'), so left alone every wallet prompt would wait out those five seconds for a
 * frame the browser refuses. With `register` answering nothing, as it does outside a browser, no frame is made and no
 * host is needed; wallets show the site as not verified by Reown, as they would for any site that hasn't registered its
 * domain there. Throws when the client isn't shaped as expected, rather than run with the frame half on. */
export function withoutVerifyFrame(provider: unknown): void {
  const verify = (provider as { signer?: { client?: { core?: { verify?: { register?: unknown } } } } } | undefined)?.signer?.client?.core?.verify;
  if (!verify || typeof verify.register !== "function") throw new Error("WalletConnect's Verify frame can't be turned off: its client has changed shape");
  verify.register = async () => undefined;
}

/** wagmi's WalletConnect connector for the site, its provider made and its Verify frame off before anything is asked
 * of it. Its `setup` is left uncalled: all it adds is passing the provider's own "connect" on to wagmi before a
 * connection is asked for, and a session here only ever starts from our connector's `connect`, which checks it for Base
 * first (the wallet ending a session is heard without it: `connect` listens for that itself). */
export async function innerConnector(projectId: string, config: ConnectorConfig): Promise<WalletConnectInner> {
  const inner = walletConnect(walletConnectParameters(projectId))(innerConfig(config) as never);
  withoutVerifyFrame(await inner.getProvider());
  return inner as unknown as WalletConnectInner;
}
