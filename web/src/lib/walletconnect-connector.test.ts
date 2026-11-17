import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";
import { base } from "viem/chains";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createConfig, createStorage, http } from "wagmi";
import { connect, disconnect, getConnection, getConnectorClient, reconnect, signMessage } from "wagmi/actions";
import { restConnecting } from "./account";
import { walletConnect } from "wagmi/connectors/walletConnect";
import nextConfig from "../../next.config";
import { RPC } from "./cascade/config";
import { walletConnectors } from "./wagmi";
import { WALLETCONNECT_ID, WALLETCONNECT_METADATA, WALLETCONNECT_PROJECT_ID, WALLETCONNECT_RELAY, WalletConnectNoBaseError, type WalletConnectSession } from "./walletconnect";
import { cascadeWalletConnect, type ConnectorConfig, connectorPeer, SESSION_KEY, type WalletConnectInner, type WalletConnectProvider } from "./walletconnect-connector";
import { innerConfig, innerConnector, walletConnectParameters, withoutVerifyFrame } from "./walletconnect-inner";
import { createAppKit, NO_APPKIT } from "./walletconnect-no-appkit";

// The site's WalletConnect connector: wagmi's own, loaded only when used, with Base required.

const ME: Address = "0x52908400098527886E0F7030069857D2E4169EE7";
/** A session as a wallet approves one: Ethereum first, as many wallets list it, then Base and Bittensor EVM. */
const SESSION: WalletConnectSession = {
  namespaces: { eip155: { accounts: [`eip155:1:${ME}`, `eip155:8453:${ME}`, `eip155:964:${ME}`] } },
  peer: { metadata: { name: "Tangem", description: "x", url: "https://tangem.example", icons: ["https://tangem.example/icon.png"] } },
};
const WITHOUT_BASE: WalletConnectSession = { namespaces: { eip155: { accounts: [`eip155:1:${ME}`] } }, peer: { metadata: { name: "Old Wallet" } } };

/** The browser's storage, in memory: what a reload keeps. */
function memory() {
  const items = new Map<string, string>();
  return { items, storage: createStorage({ storage: { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => void items.set(k, v), removeItem: (k) => void items.delete(k) } }) };
}

/** A site with the connector over a stand-in for wagmi's own (no WalletConnect code runs): `session` is what the wallet
 * approves, `startsOn` the chain the provider is on after it does; `approval`, when given, is when the wallet answers,
 * and `announces` has the stand-in pass the provider's own "connect" on to wagmi, as wagmi's connector does once it has
 * disconnected a session before. */
function site(
  o: {
    session?: WalletConnectSession;
    startsOn?: number;
    store?: ReturnType<typeof memory>;
    connectFails?: unknown;
    switchFails?: unknown;
    loadFails?: number;
    approval?: Promise<void>;
    announces?: boolean;
  } = {},
) {
  const store = o.store ?? memory();
  const made: { projectId: string; config: ConnectorConfig }[] = [];
  let failures = o.loadFails ?? 0;
  const provider: WalletConnectProvider & { request: ReturnType<typeof vi.fn> } = {
    chainId: o.startsOn ?? 1,
    session: undefined,
    request: vi.fn(async ({ method, params }: { method: string; params?: unknown }) => {
      if (method === "wallet_switchEthereumChain") {
        if (o.switchFails) throw o.switchFails;
        provider.chainId = Number((params as [{ chainId: string }])[0].chainId);
        return null;
      }
      if (method === "personal_sign") return `0x${"11".repeat(65)}`;
      throw new Error(`unexpected ${method}`);
    }),
  };
  const inner = {
    connect: vi.fn(async () => {
      if (o.connectFails) throw o.connectFails;
      await o.approval;
      provider.session = o.session ?? SESSION;
      if (o.announces) made.at(-1)?.config.emitter.emit("connect", { accounts: [ME], chainId: provider.chainId });
      // as wagmi's connector does: the chains it asked for, kept while a session is alive
      await store.storage.setItem(SESSION_KEY as never, [8453, 964] as never);
    }),
    disconnect: vi.fn(async () => {
      provider.session = undefined;
      await store.storage.setItem(SESSION_KEY as never, [] as never);
    }),
    getAccounts: vi.fn(async () => [ME] as const),
    getChainId: vi.fn(async () => provider.chainId),
    getProvider: vi.fn(async () => provider),
    isAuthorized: vi.fn(async () => provider.session !== undefined),
    switchChain: vi.fn(async ({ chainId }: { chainId: number }) => {
      provider.chainId = chainId;
      return base;
    }),
    onAccountsChanged: vi.fn(),
    onChainChanged: vi.fn(),
    onDisconnect: vi.fn(),
  } satisfies WalletConnectInner;
  const load = vi.fn(async () => {
    if (failures-- > 0) throw new Error("Loading chunk failed");
    return async (projectId: string, config: ConnectorConfig) => {
      made.push({ projectId, config });
      return inner as WalletConnectInner;
    };
  });
  const config = createConfig({
    chains: [base],
    connectors: [cascadeWalletConnect(WALLETCONNECT_PROJECT_ID, load)],
    transports: { [base.id]: http(RPC.base) },
    multiInjectedProviderDiscovery: false,
    storage: store.storage,
  });
  return { config, connector: config.connectors[0], inner, provider, load, made, store };
}

describe("the option, on and off", () => {
  const ids = (project: string | null) =>
    createConfig({ chains: [base], connectors: walletConnectors(project), transports: { [base.id]: http() }, multiInjectedProviderDiscovery: false, ssr: true }).connectors.map((c) => c.id);

  it("is a connector of its own when the build has a project id", () => {
    expect(ids(WALLETCONNECT_PROJECT_ID)).toEqual(["baseAccount", "injected", "walletConnect"]);
  });

  it("is no connector at all when the build has none: nothing to show, nothing to load", () => {
    expect(ids(null)).toEqual(["baseAccount", "injected"]);
  });
});

describe("the connector before anyone uses it", () => {
  it("loads none of WalletConnect's code: not when the site starts, not when wagmi looks for a wallet to bring back", async () => {
    const { config, connector, load } = site();
    expect(connector.id).toBe(WALLETCONNECT_ID);
    expect(connector.name).toBe("WalletConnect");
    await reconnect(config);
    expect(await connector.getProvider()).toBeUndefined();
    expect(await connector.isAuthorized()).toBe(false);
    await connector.disconnect();
    expect(load).not.toHaveBeenCalled();
    expect(getConnection(config).status).toBe("disconnected");
    expect(connectorPeer(connector)).toBeUndefined();
  });

  it("puts no listener of its own on the connector's emitter: wagmi counts the listeners there to decide whether to add its own, so one of ours would leave a session the wallet started, or ended, unheard", () => {
    const { connector } = site();
    expect(connector.emitter.listenerCount("disconnect")).toBe(0);
    expect(connector.emitter.listenerCount("change")).toBe(0);
    // wagmi's own, from when it made the connector
    expect(connector.emitter.listenerCount("connect")).toBe(1);
  });
});

describe("connecting", () => {
  it("loads wagmi's connector with the tracked project id, and connects the account the wallet approved on Base", async () => {
    const { config, connector, load, made, inner } = site();
    const got = await connect(config, { connector });
    expect(load).toHaveBeenCalledTimes(1);
    expect(made).toHaveLength(1);
    expect(made[0].projectId).toBe("b09a19083568478e654f0378e2f4997f");
    expect(got.accounts).toEqual([ME]);
    expect(getConnection(config)).toMatchObject({ status: "connected", address: ME, chainId: base.id });
    // wagmi's connector is asked to connect with no chain named: every chain is optional to WalletConnect
    expect(inner.connect).toHaveBeenCalledWith({});
  });

  it("starts on Base whatever chain the wallet listed first: the provider switches by itself, since Base is approved", async () => {
    const { config, connector, provider } = site({ startsOn: 1 });
    const got = await connect(config, { connector, chainId: base.id });
    expect(got.chainId).toBe(8453);
    expect(provider.request).toHaveBeenCalledTimes(1);
    expect(provider.request).toHaveBeenCalledWith({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] });
    // a wallet already on Base is asked nothing
    const onBase = site({ startsOn: 8453 });
    await connect(onBase.config, { connector: onBase.connector });
    expect(onBase.provider.request).not.toHaveBeenCalled();
  });

  it("requires Base: a session without an account there is ended at once, and nothing is connected", async () => {
    const { config, connector, inner, store } = site({ session: WITHOUT_BASE });
    await expect(connect(config, { connector })).rejects.toBeInstanceOf(WalletConnectNoBaseError);
    expect(inner.disconnect).toHaveBeenCalledTimes(1);
    expect(getConnection(config).status).toBe("disconnected");
    expect(connectorPeer(connector)).toBeUndefined();
    expect(JSON.parse(store.items.get(`wagmi.${SESSION_KEY}`) ?? "null")).toEqual([]);
  });

  it("takes back a session wagmi already held as connected: one approved after its dialog was closed, which turns out to lack Base", async () => {
    let approve!: () => void;
    const approval = new Promise<void>((resolve) => (approve = resolve));
    const { config, connector, inner } = site({ session: WITHOUT_BASE, approval, announces: true });
    const late = connect(config, { connector }).catch((e: unknown) => e);
    // the dialog is closed on the pairing: wagmi's state goes back to rest, where it takes a provider's "connect" at its word
    await Promise.resolve();
    restConnecting(config);
    expect(getConnection(config).status).toBe("disconnected");
    approve();
    expect(await late).toBeInstanceOf(WalletConnectNoBaseError);
    expect(inner.disconnect).toHaveBeenCalledTimes(1);
    expect(getConnection(config)).toMatchObject({ status: "disconnected", address: undefined });
    expect(config.state.connections.size).toBe(0);
    expect(config.state.current).toBeNull();
  });

  it("connects on Base when a session approved after its dialog was closed does include it", async () => {
    let approve!: () => void;
    const approval = new Promise<void>((resolve) => (approve = resolve));
    const { config, connector, provider } = site({ approval, announces: true, startsOn: 1 });
    const late = connect(config, { connector });
    await Promise.resolve();
    restConnecting(config);
    approve();
    await late;
    expect(getConnection(config)).toMatchObject({ status: "connected", address: ME, chainId: base.id });
    expect(provider.chainId).toBe(base.id);
  });

  it("ends the session too if the provider can't be put on Base", async () => {
    const { config, connector, inner } = site({ switchFails: new Error("no") });
    await expect(connect(config, { connector })).rejects.toThrow("no");
    expect(inner.disconnect).toHaveBeenCalledTimes(1);
    expect(getConnection(config).status).toBe("disconnected");
  });

  it("passes on the wallet's refusal as wagmi's connector gives it", async () => {
    const refusal = Object.assign(new Error("User rejected the request."), { name: "UserRejectedRequestError" });
    const { config, connector } = site({ connectFails: refusal });
    await expect(connect(config, { connector })).rejects.toBe(refusal);
    expect(getConnection(config).status).toBe("disconnected");
  });

  it("tries the load again after one that failed (a chunk that didn't arrive)", async () => {
    const { config, connector, load } = site({ loadFails: 1 });
    await expect(connect(config, { connector })).rejects.toThrow("Loading chunk failed");
    await connect(config, { connector });
    expect(load).toHaveBeenCalledTimes(2);
    expect(getConnection(config).status).toBe("connected");
  });
});

describe("connected", () => {
  it("knows the wallet by its own name, cut to plain text, until it disconnects", async () => {
    const { config, connector } = site();
    await connect(config, { connector });
    expect(connectorPeer(connector)).toEqual({ name: "Tangem", icon: "https://tangem.example/icon.png" });
    await disconnect(config);
    expect(connectorPeer(connector)).toBeUndefined();
    // only our connector has a peer
    expect(connectorPeer({ id: "injected", peer: () => ({ name: "x" }) })).toBeUndefined();
    expect(connectorPeer(undefined)).toBeUndefined();
  });

  it("forgets the name when the wallet ends the session itself", async () => {
    const { config, connector, provider } = site();
    await connect(config, { connector });
    // as the provider does it: the session is gone, and wagmi's connector says so
    provider.session = undefined;
    connector.emitter.emit("disconnect");
    expect(connectorPeer(connector)).toBeUndefined();
    expect(getConnection(config).status).toBe("disconnected");
  });

  it("signs through wagmi's wallet client on this connector's provider, as every wallet does", async () => {
    const { config, connector, inner, provider } = site({ startsOn: 8453 });
    await connect(config, { connector });
    const client = await getConnectorClient(config, { account: ME, chainId: base.id });
    expect(client.account.address).toBe(ME);
    expect(inner.getProvider).toHaveBeenLastCalledWith({ chainId: base.id });
    await signMessage(config, { account: ME, message: "hello" });
    expect(provider.request.mock.calls.at(-1)?.[0]).toMatchObject({ method: "personal_sign" });
  });

  it("disconnect ends the session through wagmi's connector", async () => {
    const { config, connector, inner, store } = site();
    await connect(config, { connector });
    await disconnect(config);
    expect(inner.disconnect).toHaveBeenCalledTimes(1);
    expect(getConnection(config).status).toBe("disconnected");
    expect(JSON.parse(store.items.get(`wagmi.${SESSION_KEY}`) ?? "null")).toEqual([]);
  });
});

describe("a reload", () => {
  it("brings the session back: the code is loaded because a session may be alive, and the wallet is asked nothing", async () => {
    const first = site({ startsOn: 964 });
    await connect(first.config, { connector: first.connector });
    // the same browser storage, a new page: the provider remembers its session and the chain it was on
    const again = site({ store: first.store, startsOn: 964 });
    again.provider.session = SESSION;
    await reconnect(again.config);
    expect(again.load).toHaveBeenCalledTimes(1);
    expect(again.inner.connect).toHaveBeenCalledWith({ isReconnecting: true });
    expect(getConnection(again.config)).toMatchObject({ status: "connected", address: ME });
    // it stays on the chain it was on (a flow switches to Base before it sends): no request at all
    expect(again.provider.request).not.toHaveBeenCalled();
    expect(connectorPeer(again.connector)?.name).toBe("Tangem");
  });

  it("stays disconnected after a disconnect: nothing is loaded again", async () => {
    const first = site();
    await connect(first.config, { connector: first.connector });
    await disconnect(first.config);
    const again = site({ store: first.store });
    await reconnect(again.config);
    expect(again.load).not.toHaveBeenCalled();
    expect(getConnection(again.config).status).toBe("disconnected");
  });

  it("stays disconnected when the session is gone (the wallet ended it while the page was closed)", async () => {
    const first = site();
    await connect(first.config, { connector: first.connector });
    const again = site({ store: first.store });
    await reconnect(again.config);
    expect(again.load).toHaveBeenCalledTimes(1);
    expect(getConnection(again.config).status).toBe("disconnected");
  });
});

describe("what wagmi's own connector is made with", () => {
  /** What wagmi hands a connector for the site's config: Base only. */
  const given = (): ConnectorConfig => ({ chains: [base], emitter: { on: () => undefined, off: () => undefined, once: () => undefined, emit: () => undefined, listenerCount: () => 0 } as never, providers: [], storage: null, transports: { [base.id]: http(RPC.base) } });

  it("has the site's dialog, not Reown's, and no telemetry", () => {
    expect(walletConnectParameters(WALLETCONNECT_PROJECT_ID)).toEqual({ projectId: WALLETCONNECT_PROJECT_ID, metadata: WALLETCONNECT_METADATA, showQrModal: false, telemetryEnabled: false });
  });

  it("asks a session for Base and Bittensor EVM, and reads each through the site's own RPC", () => {
    const c = innerConfig(given());
    expect(c.chains.map((x) => x.id)).toEqual([8453, 964]);
    const url = (id: number) => c.transports?.[id]?.({ chain: c.chains.find((x) => x.id === id)!, retryCount: 0 }).value?.url;
    expect(url(8453)).toBe(RPC.base);
    expect(url(964)).toBe(RPC.bittensor);
  });

  it("keeps its session's chains where our connector looks for a session that may be alive", () => {
    const real = walletConnect(walletConnectParameters(WALLETCONNECT_PROJECT_ID))(innerConfig(given()) as never);
    expect(real.requestedChainsStorageKey).toBe(SESSION_KEY);
    expect(real.id).toBe(WALLETCONNECT_ID);
  });
});

describe("WalletConnect's own provider, made as the site makes it (no network: a relay socket opens only for a pairing)", () => {
  const stop: (() => void)[] = [];
  afterAll(() => stop.forEach((s) => s()));

  it("carries the tracked project id, the relay the policy allows, the site's RPCs, no telemetry, no Reown window, and no Verify frame", async () => {
    const store = memory();
    const config = createConfig({ chains: [base], connectors: [], transports: { [base.id]: http(RPC.base) }, multiInjectedProviderDiscovery: false, storage: store.storage });
    const handed: ConnectorConfig = { chains: config.chains, emitter: { on: () => undefined, off: () => undefined, once: () => undefined, emit: () => undefined, listenerCount: () => 0 } as never, providers: [], storage: store.storage as never, transports: { [base.id]: http(RPC.base) } };
    const inner = await innerConnector(WALLETCONNECT_PROJECT_ID, handed);
    type Core = {
      projectId: string;
      relayUrl: string;
      relayer: { connected: boolean };
      eventClient: { telemetryEnabled: boolean };
      verify: { register(p: { id: string; decryptedId: string }): Promise<string | undefined> };
      heartbeat: { stop(): void };
    };
    const provider = (await inner.getProvider()) as unknown as { modal?: unknown; rpc: { showQrModal: boolean; rpcMap: Record<string, string>; optionalChains: string[]; chains: string[] }; signer: { client: { core: Core; metadata: unknown } } };
    const core = provider.signer.client.core;
    stop.push(() => core.heartbeat.stop());

    expect(core.projectId).toBe("b09a19083568478e654f0378e2f4997f");
    expect(core.relayUrl).toBe(WALLETCONNECT_RELAY);
    // nothing has been connected to
    expect(core.relayer.connected).toBe(false);
    expect(core.eventClient.telemetryEnabled).toBe(false);
    expect(provider.signer.client.metadata).toEqual(WALLETCONNECT_METADATA);
    // the site's own dialog: the provider never made Reown's
    expect(provider.rpc.showQrModal).toBe(false);
    expect(provider.modal).toBeUndefined();
    // no chain is required on the wire (the site holds Base to be required after the wallet answers)
    expect(provider.rpc.chains).toEqual([]);
    expect(provider.rpc.optionalChains).toEqual(["eip155:8453", "eip155:964"]);
    expect(provider.rpc.rpcMap).toEqual({ 8453: RPC.base, 964: RPC.bittensor });

    // the Verify frame: in a browser the core would make an iframe here and wait for it; ours answers at once, and
    // touches no document
    const g = globalThis as { window?: unknown; document?: unknown };
    const had = { window: g.window, document: g.document };
    const createElement = vi.fn(() => {
      throw new Error("an iframe was made");
    });
    g.window = { location: { origin: "https://cascadefi.xyz" }, addEventListener: () => undefined, removeEventListener: () => undefined };
    g.document = { createElement, body: { appendChild: () => undefined, removeChild: () => undefined } };
    try {
      expect(await core.verify.register({ id: "a", decryptedId: "b" })).toBeUndefined();
      expect(createElement).not.toHaveBeenCalled();
    } finally {
      g.window = had.window;
      g.document = had.document;
      if (had.window === undefined) delete g.window;
      if (had.document === undefined) delete g.document;
    }
  });

  it("refuses to run with the Verify frame half on: a client that changed shape is an error, not a silent five-second wait", () => {
    for (const odd of [undefined, {}, { signer: {} }, { signer: { client: { core: {} } } }, { signer: { client: { core: { verify: { register: "x" } } } } }]) {
      expect(() => withoutVerifyFrame(odd)).toThrow(/Verify frame/);
    }
    const verify = { register: async (): Promise<string | undefined> => "attestation" };
    withoutVerifyFrame({ signer: { client: { core: { verify } } } });
    return expect(verify.register()).resolves.toBeUndefined();
  });
});

describe("Reown AppKit (the provider's own QR window, with its wallet SDKs, fonts and remote wallet list)", () => {
  const require = createRequire(import.meta.url);
  const web = fileURLToPath(new URL("../..", import.meta.url));
  const entry = require.resolve("@walletconnect/ethereum-provider");
  let folder = dirname(entry);
  while (!existsSync(join(folder, "package.json"))) folder = dirname(folder);

  it("is not installed: the override removes it from the provider's dependencies, and the lockfile has none of it", () => {
    expect(readFileSync(join(web, "pnpm-workspace.yaml"), "utf8")).toMatch(/^overrides:\n {2}"@walletconnect\/ethereum-provider>@reown\/appkit": "-"$/m);
    expect(() => require.resolve("@reown/appkit/core", { paths: [folder] })).toThrow();
    expect(() => require.resolve("@reown/appkit", { paths: [folder] })).toThrow();
    const lock = readFileSync(join(web, "pnpm-lock.yaml"), "utf8");
    // the override's own line is the only mention
    expect(lock.match(/@reown\//g)).toHaveLength(1);
    expect(lock).not.toMatch(/web3modal|@walletconnect\/modal/i);
  });

  it("has one import in the provider, which the site's bundle points at a file of its own that throws", () => {
    for (const file of ["index.js", "index.cjs"]) {
      const text = readFileSync(join(folder, "dist", file), "utf8");
      const named = [...text.matchAll(/["'](@reown\/[^"']+)["']/g)].map((m) => m[1]);
      expect([...new Set(named)], file).toEqual(["@reown/appkit/core"]);
    }
    const alias = (nextConfig.turbopack?.resolveAlias ?? {}) as Record<string, string>;
    expect(alias["@reown/appkit/core"]).toBe("./src/lib/walletconnect-no-appkit.ts");
    expect(existsSync(join(web, alias["@reown/appkit/core"]))).toBe(true);
    expect(createAppKit).toThrow(NO_APPKIT);
    expect(NO_APPKIT).not.toMatch(/https?:/);
  });

  it("leaves the week's wait on new releases, and the blocked install scripts, as they were", () => {
    const workspace = readFileSync(join(web, "pnpm-workspace.yaml"), "utf8");
    expect(workspace).toMatch(/^minimumReleaseAge: 10080$/m);
    expect(workspace).toMatch(/^allowBuilds:\n {2}sharp: false\n {2}unrs-resolver: false$/m);
    expect(workspace).not.toMatch(/minimumReleaseAgeExclude/);
  });
});
