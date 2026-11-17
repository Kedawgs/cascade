import type { Address } from "viem";
import { base } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfig, createConnector, createStorage, http } from "wagmi";
import { connect, getConnection } from "wagmi/actions";
import { accountState, restConnecting } from "./account";
import { type AttemptsView, CONNECT_FAILED, createConnectAttempts, endedByUser, RELEASE_AFTER_MS } from "./connect-attempts";

// The wallet list never waits on a wallet (the founder, 2026-11-16: Base Account's popup closed before its page
// loaded left "Connecting to Base Account…" and every other wallet greyed out for good), and says nothing when the
// person ended the connection themselves.

/** A promise settled from outside: a wallet that answers when the test says, or never. */
function deferred<T = unknown>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets settled promises' callbacks run. */
const settled = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** The list's attempts over wallets that answer when told to: `wallet[uid]` settles the latest attempt on it. */
function list() {
  const wallet: Record<string, ReturnType<typeof deferred>> = {};
  const views: AttemptsView[] = [];
  const released = vi.fn();
  const started: string[] = [];
  const attempts = createConnectAttempts(
    {
      connect(uid) {
        started.push(uid);
        wallet[uid] = deferred();
        return wallet[uid].promise;
      },
      released,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    (v) => views.push(v),
  );
  return { attempts, wallet, views, released, started };
}

const REJECTED = Object.assign(new Error("User rejected the request."), { name: "UserRejectedRequestError", code: 4001 });
const BROKEN = new Error("Internal JSON-RPC error.");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a connection the person ended themselves", () => {
  it("is one they rejected, denied, or whose wallet window or popup they closed", () => {
    for (const e of [
      REJECTED,
      { code: 4001 },
      { code: 4001, message: "anything" },
      // viem wraps the wallet's own error
      Object.assign(new Error("An unknown RPC error occurred."), { cause: { code: 4001, message: "User denied account authorization" } }),
      Object.assign(new Error("wrapped twice"), { cause: new Error("again", { cause: REJECTED }) }),
      // Base Account, when its popup is closed after it loaded
      Object.assign(new Error("Request rejected"), { code: 4001 }),
      new Error("Request rejected"),
      new Error("User denied account authorization"),
      new Error("Permission denied by the user"),
      new Error("Popup window was closed"),
      new Error("The user closed the window"),
      { name: "UserRejectedRequestError" },
      { shortMessage: "User rejected the request." },
      { details: "MetaMask Tx Signature: User denied transaction signature." },
    ]) {
      expect(endedByUser(e), JSON.stringify(e) + String(e)).toBe(true);
    }
  });

  it("is not a wallet that failed, was already asked, or couldn't be reached", () => {
    for (const e of [
      BROKEN,
      new Error("Request of type 'wallet_requestPermissions' already pending"),
      Object.assign(new Error("Already processing eth_requestAccounts. Please wait."), { code: -32002 }),
      new Error("Provider not found"),
      new Error("Failed to fetch"),
      // failures that only SOUND like an end by the person: each is owed its sentence (review of 0cfc42d, finding 5)
      new Error("The message port closed before a response was received."),
      new Error("Failed to read the 'localStorage' property from 'Window': Access is denied for this document."),
      Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }),
      new Error("Request rejected due to rate limiting"),
      new Error("WebSocket connection closed abnormally"),
      new Error("Connection closed"),
      Object.assign(new Error("Transaction creation failed."), { name: "TransactionRejectedRpcError" }),
      { shortMessage: "The request was rejected." },
      { details: "socket closed" },
      { code: -32603, message: "Internal error" },
      { code: 4900 },
      undefined,
      null,
      "",
      "User rejected",
      7,
    ]) {
      expect(endedByUser(e), String(e)).toBe(false);
    }
    // an error that names itself as its own cause doesn't loop
    const loop: { message: string; cause?: unknown } = { message: "odd" };
    loop.cause = loop;
    expect(endedByUser(loop)).toBe(false);
  });
});

describe("the wallet list's attempts", () => {
  it("says which wallet is being connected to, and is at rest again once it connects", async () => {
    const { attempts, wallet, views, released } = list();
    expect(attempts.view()).toEqual({ pending: null, error: null });
    attempts.choose("base");
    expect(attempts.view()).toEqual({ pending: "base", error: null });
    wallet.base.resolve({});
    await settled();
    expect(attempts.view()).toEqual({ pending: null, error: null });
    expect(views).toEqual([
      { pending: "base", error: null },
      { pending: null, error: null },
    ]);
    // it settled by itself: nothing was let go
    expect(released).not.toHaveBeenCalled();
  });

  it("says nothing when the person ended it: the list is at rest, with no sentence", async () => {
    const { attempts, wallet, views } = list();
    attempts.choose("base");
    wallet.base.reject(REJECTED);
    await settled();
    expect(attempts.view()).toEqual({ pending: null, error: null });
    expect(views.some((v) => v.error !== null)).toBe(false);
  });

  it("says one sentence for any other failure, cleared when a new attempt starts or the list closes", async () => {
    const { attempts, wallet } = list();
    attempts.choose("metamask");
    wallet.metamask.reject(BROKEN);
    await settled();
    expect(attempts.view()).toEqual({ pending: null, error: CONNECT_FAILED });
    expect(CONNECT_FAILED).toBe("We couldn't connect to that wallet. Try again or pick another one.");
    attempts.choose("base");
    expect(attempts.view()).toEqual({ pending: "base", error: null });
    wallet.base.reject(BROKEN);
    await settled();
    expect(attempts.view().error).toBe(CONNECT_FAILED);
    attempts.closed();
    expect(attempts.view()).toEqual({ pending: null, error: null });
  });

  describe("an attempt whose wallet never answers", () => {
    it("holds nothing: another wallet can be picked, which lets the first go and starts the new one", async () => {
      const { attempts, wallet, started, released } = list();
      attempts.choose("base");
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      // still waiting on it, however long: no plain timeout
      expect(attempts.view()).toEqual({ pending: "base", error: null });
      attempts.choose("metamask");
      expect(attempts.view()).toEqual({ pending: "metamask", error: null });
      expect(started).toEqual(["base", "metamask"]);
      // the new attempt is live in the wallet library, so its state isn't put to rest
      expect(released).not.toHaveBeenCalled();
      wallet.metamask.resolve({});
      await settled();
      expect(attempts.view()).toEqual({ pending: null, error: null });
    });

    it("is let go by Cancel, with nothing said", () => {
      const { attempts, released } = list();
      attempts.choose("base");
      attempts.cancel();
      expect(attempts.view()).toEqual({ pending: null, error: null });
      expect(released).toHaveBeenCalledTimes(1);
      // Cancel with nothing pending does nothing
      attempts.cancel();
      expect(released).toHaveBeenCalledTimes(1);
    });

    it("is let go when the list closes", () => {
      const { attempts, released } = list();
      attempts.choose("base");
      attempts.closed();
      expect(attempts.view()).toEqual({ pending: null, error: null });
      expect(released).toHaveBeenCalledTimes(1);
    });

    it("is let go a moment after this window is back in front, and not before", async () => {
      const { attempts, released } = list();
      attempts.choose("base");
      attempts.windowBack();
      await vi.advanceTimersByTimeAsync(RELEASE_AFTER_MS - 1);
      expect(attempts.view()).toEqual({ pending: "base", error: null });
      expect(released).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts.view()).toEqual({ pending: null, error: null });
      expect(released).toHaveBeenCalledTimes(1);
      expect(RELEASE_AFTER_MS).toBe(1_500);
    });

    it("is not let go while the person is still in the wallet's window: without the window coming back nothing counts down, and going back to the wallet stops the count", async () => {
      const { attempts, released } = list();
      attempts.choose("base");
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(attempts.view().pending).toBe("base");
      // back for a second, then into the popup again
      attempts.windowBack();
      await vi.advanceTimersByTimeAsync(1_000);
      attempts.windowAway();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts.view().pending).toBe("base");
      expect(released).not.toHaveBeenCalled();
      // and back for good: the full moment again
      attempts.windowBack();
      await vi.advanceTimersByTimeAsync(RELEASE_AFTER_MS);
      expect(attempts.view().pending).toBeNull();
    });

    it("isn't let go by the window coming back if its wallet answered in the meantime", async () => {
      const { attempts, wallet, released } = list();
      attempts.choose("metamask");
      attempts.windowBack();
      await vi.advanceTimersByTimeAsync(400);
      wallet.metamask.resolve({});
      await settled();
      await vi.advanceTimersByTimeAsync(RELEASE_AFTER_MS);
      expect(attempts.view()).toEqual({ pending: null, error: null });
      expect(released).not.toHaveBeenCalled();
    });

    it("leaves the wait to the newer attempt when another wallet was picked during it", async () => {
      const { attempts } = list();
      attempts.choose("base");
      attempts.windowBack();
      await vi.advanceTimersByTimeAsync(1_000);
      attempts.choose("metamask");
      // the first attempt's moment is over: the new one isn't let go by it
      await vi.advanceTimersByTimeAsync(RELEASE_AFTER_MS);
      expect(attempts.view()).toEqual({ pending: "metamask", error: null });
    });
  });

  describe("a late answer from an attempt that was let go", () => {
    it("shows nothing when it is a failure, the person's own or not", async () => {
      for (const error of [REJECTED, BROKEN]) {
        const { attempts, wallet, views } = list();
        attempts.choose("base");
        attempts.cancel();
        wallet.base.reject(error);
        await settled();
        expect(attempts.view()).toEqual({ pending: null, error: null });
        expect(views.some((v) => v.error !== null)).toBe(false);
      }
    });

    it("doesn't disturb the attempt that replaced it", async () => {
      const { attempts, wallet } = list();
      attempts.choose("base");
      const first = wallet.base;
      attempts.choose("metamask");
      first.reject(BROKEN);
      await settled();
      expect(attempts.view()).toEqual({ pending: "metamask", error: null });
      first.resolve({});
      await settled();
      expect(attempts.view()).toEqual({ pending: "metamask", error: null });
    });

    it("changes nothing once the list is gone from the page", async () => {
      const { attempts, wallet, views } = list();
      attempts.choose("base");
      attempts.windowBack();
      attempts.dispose();
      const seen = views.length;
      wallet.base.reject(BROKEN);
      await settled();
      await vi.advanceTimersByTimeAsync(RELEASE_AFTER_MS * 2);
      expect(views).toHaveLength(seen);
    });
  });
});

describe("wagmi's own state around an attempt that never settles", () => {
  const ME: Address = "0x52908400098527886E0F7030069857D2E4169EE7";

  /** A wagmi config with one wallet that answers a connection when the test says. */
  function site() {
    const answer = deferred<{ accounts: readonly Address[]; chainId: number }>();
    const waits: (parameters?: { chainId?: number | undefined; isReconnecting?: boolean | undefined }) => Promise<never> = () => answer.promise as Promise<never>;
    const slow = createConnector(() => ({
      id: "slow",
      name: "Slow Wallet",
      type: "slow",
      connect: waits,
      disconnect: async () => undefined,
      getAccounts: async () => [ME],
      getChainId: async () => base.id,
      getProvider: async () => ({}),
      isAuthorized: async () => false,
      onAccountsChanged: () => undefined,
      onChainChanged: () => undefined,
      onDisconnect: () => undefined,
    }));
    const config = createConfig({
      chains: [base],
      connectors: [slow],
      transports: { [base.id]: http() },
      multiInjectedProviderDiscovery: false,
      storage: createStorage({ storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } }),
    });
    return { config, answer, connector: config.connectors[0] };
  }
  /** What every screen reads (useCascadeAccount), for wagmi's state as it stands, on a page that has its browser state. */
  const screen = (config: ReturnType<typeof site>["config"]) => accountState(true, getConnection(config));

  it('is "connecting" for as long as the wallet is silent, which the screens read as nobody connected: the Connect button, no skeleton, nothing disabled', async () => {
    const { config, connector } = site();
    void connect(config, { connector }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(getConnection(config).status).toBe("connecting");
    expect(screen(config)).toEqual({ status: "none" });
  });

  it("is put back to rest when the list lets the attempt go, by wagmi's own disconnect", async () => {
    const { config, connector } = site();
    void connect(config, { connector }).catch(() => undefined);
    await settled();
    restConnecting(config);
    expect(getConnection(config).status).toBe("disconnected");
    expect(screen(config)).toEqual({ status: "none" });
  });

  it("still connects if the wallet answers after all, and the screens then show the wallet", async () => {
    const { config, connector, answer } = site();
    const late = connect(config, { connector });
    await settled();
    restConnecting(config);
    answer.resolve({ accounts: [ME], chainId: base.id });
    await late;
    expect(getConnection(config).status).toBe("connected");
    expect(screen(config)).toEqual({ status: "wallet", account: ME });
  });

  it("is at rest after a late failure too", async () => {
    const { config, connector, answer } = site();
    const late = connect(config, { connector }).catch((e: unknown) => e);
    await settled();
    restConnecting(config);
    answer.reject(new Error("too late"));
    await late;
    expect(getConnection(config).status).toBe("disconnected");
    expect(screen(config)).toEqual({ status: "none" });
  });

  it("never touches a connected wallet", async () => {
    const { config, connector, answer } = site();
    const done = connect(config, { connector });
    answer.resolve({ accounts: [ME], chainId: base.id });
    await done;
    restConnecting(config);
    await settled();
    expect(getConnection(config).status).toBe("connected");
    expect(getConnection(config).address).toBe(ME);
  });
});

describe("who is using the app, from wagmi's connection", () => {
  it("is a wallet once connected, nobody otherwise, and unknown only before the page has its browser state or while a reload brings a wallet back", () => {
    expect(accountState(true, { status: "connected", address: "0xabc" })).toEqual({ status: "wallet", account: "0xabc" });
    expect(accountState(true, { status: "disconnected" })).toEqual({ status: "none" });
    expect(accountState(true, { status: "connecting" })).toEqual({ status: "none" });
    expect(accountState(true, { status: "reconnecting" })).toEqual({ status: "loading" });
    expect(accountState(true, { status: "connected" })).toEqual({ status: "none" });
    for (const status of ["connected", "connecting", "reconnecting", "disconnected"]) expect(accountState(false, { status, address: "0xabc" })).toEqual({ status: "loading" });
  });
});
