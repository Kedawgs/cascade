import { type Address, type Chain, numberToHex } from "viem";
import { base } from "viem/chains";
import { createConnector, type CreateConnectorFn } from "wagmi";
import { baseAccounts, WALLETCONNECT_ID, WalletConnectNoBaseError, type WalletConnectSession, type WalletPeer, walletPeer } from "./walletconnect";

/** What wagmi hands a connector when it makes one: the config's chains and transports, its storage, and the emitter
 * the connector's events go out on. */
export type ConnectorConfig = Parameters<CreateConnectorFn>[0];

/** WalletConnect's provider, as much of it as the site touches: the session, the chain it is on, and requests. The
 * emergency page takes it as the wallet's EIP-1193 provider, like any connector's (use-direct-exit.ts). */
export interface WalletConnectProvider {
  chainId: number;
  session?: WalletConnectSession;
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

/** wagmi's own WalletConnect connector, as much of it as ours drives (walletconnect-inner.ts makes it). */
export interface WalletConnectInner {
  connect(parameters?: { isReconnecting?: boolean }): Promise<unknown>;
  disconnect(): Promise<void>;
  getAccounts(): Promise<readonly Address[]>;
  getChainId(): Promise<number>;
  getProvider(parameters?: { chainId?: number }): Promise<WalletConnectProvider>;
  isAuthorized(): Promise<boolean>;
  switchChain(parameters: { addEthereumChainParameter?: object; chainId: number }): Promise<Chain>;
  onAccountsChanged(accounts: string[]): void;
  onChainChanged(chainId: string): void;
  onDisconnect(error?: Error): void;
}

/** Makes wagmi's connector for a project id and a connector config: the dynamic import of the WalletConnect code. */
export type InnerLoader = () => Promise<(projectId: string, config: ConnectorConfig) => Promise<WalletConnectInner>>;

/** Where wagmi's WalletConnect connector keeps the chains it asked a session for: set when it connects, emptied when it
 * disconnects or the wallet ends the session (a test holds the name to the connector's own). Read here as "a session
 * may be alive", so a visit that never used WalletConnect loads none of its code. */
export const SESSION_KEY = `${WALLETCONNECT_ID}.requestedChains`;

/** What ours adds to a connector: the connected wallet's own word about itself, for the pill. */
export interface WalletConnectExtras extends Record<string, unknown> {
  peer(): WalletPeer | undefined;
}

/**
 * The site's WalletConnect connector: wagmi's own (walletconnect-inner.ts), wrapped so that
 * - none of WalletConnect's code is loaded until someone picks it, or a session of theirs may be alive (a reload):
 *   wagmi asks every connector for its provider on each page load, and wagmi's connector builds its provider, storage
 *   and relay client to answer;
 * - Base is required: a session that doesn't include an account on Base is ended at once (WalletConnectNoBaseError),
 *   and a new session starts on Base whatever chain the wallet listed first;
 * - the wallet's name and icon, as its session gives them, can be read for the pill (walletPeer: untrusted, cut to plain text).
 * Every request a flow makes still goes through wagmi's wallet client to this connector's provider, as for any wallet.
 */
export function cascadeWalletConnect(projectId: string, load: InnerLoader = () => import("./walletconnect-inner").then((m) => m.innerConnector)) {
  return createConnector<WalletConnectProvider | undefined, WalletConnectExtras, Record<typeof SESSION_KEY, number[]>>((config) => {
    let inner: Promise<WalletConnectInner> | undefined;
    /** The provider of the session connected through here: its peer is read from it each time, so a session the
     * wallet ends takes its name with it. (Nothing here listens on the connector's emitter: wagmi counts the listeners
     * there to decide whether to add its own.) */
    let connected: WalletConnectProvider | undefined;

    /** wagmi's connector, loading it first if this is the first use; a load that failed is tried again next time. */
    const ready = () =>
      (inner ??= load()
        .then((make) => make(projectId, config))
        .catch((e) => {
          inner = undefined;
          throw e;
        }));
    const sessionMayLive = async () => ((await config.storage?.getItem(SESSION_KEY)) ?? []).length > 0;
    /** wagmi's connector if it is loaded or a session may be alive, else nothing: nothing is loaded to find out. */
    const live = async () => (inner || (await sessionMayLive()) ? ready() : undefined);

    return {
      id: WALLETCONNECT_ID,
      name: "WalletConnect",
      type: "walletConnect",
      async connect<withCapabilities extends boolean = false>(parameters: { chainId?: number; isReconnecting?: boolean; withCapabilities?: withCapabilities | boolean } = {}) {
        const c = await ready();
        // (no chain is passed on: every chain is optional to WalletConnect now, and Base is seen to below)
        await c.connect({ ...(parameters.isReconnecting ? { isReconnecting: true } : {}) });
        const provider = await c.getProvider();
        const accounts = baseAccounts(provider.session);
        try {
          if (accounts.length === 0) throw new WalletConnectNoBaseError();
          // a new session starts on Base; one brought back by a reload stays where it was (a flow switches before it sends)
          if (!parameters.isReconnecting && provider.chainId !== base.id) {
            // Base is approved, so the provider switches by itself: the wallet is asked nothing
            await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(base.id) }] });
          }
        } catch (e) {
          // wagmi may already hold this session as connected: it takes the provider's own "connect" at its word when
          // its status is at rest (the dialog was closed on this pairing, and the wallet approved it after all). Taken
          // back first, so the page never keeps a wallet it has just refused; a no-op when wagmi wasn't listening.
          config.emitter.emit("disconnect");
          await c.disconnect().catch(() => undefined);
          throw e;
        }
        connected = provider;
        return {
          accounts: (parameters.withCapabilities ? accounts.map((address) => ({ address, capabilities: {} })) : accounts) as never,
          chainId: provider.chainId,
        };
      },
      async disconnect() {
        connected = undefined;
        const c = await live().catch(() => undefined);
        await c?.disconnect();
      },
      async getAccounts() {
        const c = await ready();
        const accounts = baseAccounts((await c.getProvider()).session);
        return accounts.length > 0 ? accounts : c.getAccounts();
      },
      async getChainId() {
        return (await ready()).getChainId();
      },
      async getProvider(parameters) {
        return (await live())?.getProvider(parameters);
      },
      async isAuthorized() {
        try {
          const c = await live();
          return c ? await c.isAuthorized() : false;
        } catch {
          return false;
        }
      },
      async switchChain(parameters) {
        return (await ready()).switchChain(parameters);
      },
      // wagmi's connector hears its provider's events itself and sends them out on this connector's emitter; these are
      // here for the connector's shape, and pass on anything given to them
      onAccountsChanged(accounts) {
        void inner?.then((c) => c.onAccountsChanged(accounts), () => undefined);
      },
      onChainChanged(chainId) {
        void inner?.then((c) => c.onChainChanged(chainId), () => undefined);
      },
      onDisconnect(error) {
        void inner?.then((c) => c.onDisconnect(error), () => undefined);
      },
      peer: () => (connected?.session ? walletPeer(connected.session.peer?.metadata) : undefined),
    };
  });
}

/** The connected wallet's own word about itself, when the connector is ours and it has one. */
export function connectorPeer(connector: unknown): WalletPeer | undefined {
  const c = connector as { id?: unknown; peer?: unknown } | null | undefined;
  return c?.id === WALLETCONNECT_ID && typeof c.peer === "function" ? (c.peer as () => WalletPeer | undefined)() : undefined;
}
