import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletConnectNoBaseError } from "./walletconnect";
import { createPairing, PAIRING_PREPARE_MS, type PairingView } from "./walletconnect-pairing";

// WalletConnect's dialog: a pairing happens on another device, so what came of it is said in the dialog, with a way to
// try again; closing the dialog is the person's own doing and says nothing.

const uriOf = (seed: string) => `wc:${seed.repeat(32)}@2?expiryTimestamp=1794885130&relay-protocol=irn&symKey=${"cd".repeat(32)}`;
const URI = uriOf("ab");
const SECOND = uriOf("ef");

const settled = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** A dialog's pairings over a connector that gives an address and answers when the test says. */
function dialog() {
  const attempts: { resolve: (v?: unknown) => void; reject: (e: unknown) => void }[] = [];
  const listeners = new Set<(uri: unknown) => void>();
  const views: PairingView[] = [];
  const released = vi.fn();
  const pairing = createPairing(
    {
      connect: () => new Promise((resolve, reject) => attempts.push({ resolve, reject })),
      onUri(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      released,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    (v) => views.push(v),
  );
  /** The provider announces a pairing address to whoever listens. */
  const announce = (uri: unknown) => [...listeners].forEach((l) => l(uri));
  return { pairing, attempts, announce, views, released, listening: () => listeners.size };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("WalletConnect's dialog", () => {
  it("opens getting a code, shows the link once the provider has one, and closes when the wallet connects", async () => {
    const { pairing, attempts, announce, views, released, listening } = dialog();
    expect(pairing.view()).toEqual({ phase: "closed" });
    pairing.start();
    expect(pairing.view()).toEqual({ phase: "preparing" });
    announce(URI);
    expect(pairing.view()).toEqual({ phase: "scan", uri: URI });
    attempts[0].resolve();
    await settled();
    expect(pairing.view()).toEqual({ phase: "closed" });
    expect(views.map((v) => v.phase)).toEqual(["preparing", "scan", "closed"]);
    // it connected: nothing was let go, and nothing is listened for any more
    expect(released).not.toHaveBeenCalled();
    expect(listening()).toBe(0);
  });

  it("shows only a real pairing link: anything else the connector says is ignored", () => {
    const { pairing, announce } = dialog();
    pairing.start();
    for (const bad of [undefined, "", "javascript:alert(1)", "https://example.com", { uri: URI }, `${URI} `]) announce(bad);
    expect(pairing.view()).toEqual({ phase: "preparing" });
  });

  it("says in the dialog that the wallet declined, the code expired, or the wallet left Base out, each with a way to try again", async () => {
    for (const [error, failure] of [
      [Object.assign(new Error("User rejected the request."), { name: "UserRejectedRequestError" }), "declined"],
      [new Error("Proposal expired"), "expired"],
      [new WalletConnectNoBaseError(), "no-base"],
      [new Error("socket hang up"), "unreachable"],
    ] as const) {
      const { pairing, attempts, announce, released } = dialog();
      pairing.start();
      announce(URI);
      attempts[0].reject(error);
      await settled();
      expect(pairing.view(), failure).toEqual({ phase: "failed", failure });
      // the attempt settled by itself
      expect(released).not.toHaveBeenCalled();
      // trying again is a new pairing with a new link
      pairing.start();
      expect(pairing.view()).toEqual({ phase: "preparing" });
      announce(SECOND);
      expect(pairing.view()).toEqual({ phase: "scan", uri: SECOND });
      expect(attempts).toHaveLength(2);
    }
  });

  it("says WalletConnect can't be reached when no link comes within half a minute, and not before", async () => {
    const { pairing, announce, attempts, released } = dialog();
    pairing.start();
    await vi.advanceTimersByTimeAsync(PAIRING_PREPARE_MS - 1);
    expect(pairing.view()).toEqual({ phase: "preparing" });
    await vi.advanceTimersByTimeAsync(1);
    expect(pairing.view()).toEqual({ phase: "failed", failure: "unreachable" });
    expect(PAIRING_PREPARE_MS).toBe(30_000);
    // that attempt was let go: wagmi's state goes back to rest, and whatever it says later changes nothing here
    expect(released).toHaveBeenCalledTimes(1);
    announce(URI);
    attempts[0].reject(new Error("Proposal expired"));
    await settled();
    expect(pairing.view()).toEqual({ phase: "failed", failure: "unreachable" });
  });

  it("doesn't count that half minute once the link is on screen: a code waits its own five minutes to be scanned", async () => {
    const { pairing, announce } = dialog();
    pairing.start();
    announce(URI);
    await vi.advanceTimersByTimeAsync(PAIRING_PREPARE_MS * 5);
    expect(pairing.view()).toEqual({ phase: "scan", uri: URI });
  });

  it("closes with nothing said, and a late refusal or expiry of that pairing shows nothing", async () => {
    for (const late of [new Error("User rejected."), new Error("Proposal expired")]) {
      const { pairing, attempts, announce, views, released } = dialog();
      pairing.start();
      announce(URI);
      pairing.close();
      expect(pairing.view()).toEqual({ phase: "closed" });
      expect(released).toHaveBeenCalledTimes(1);
      attempts[0].reject(late);
      await settled();
      expect(pairing.view()).toEqual({ phase: "closed" });
      expect(views.some((v) => v.phase === "failed")).toBe(false);
    }
  });

  it("closes once however often it is told to, and closing a failed dialog lets nothing go (its attempt had settled)", async () => {
    const { pairing, attempts, views, released } = dialog();
    pairing.start();
    pairing.close();
    pairing.close();
    pairing.close();
    expect(views.map((v) => v.phase)).toEqual(["preparing", "closed"]);
    expect(released).toHaveBeenCalledTimes(1);
    pairing.start();
    attempts[1].reject(new Error("User rejected."));
    await settled();
    pairing.close();
    expect(pairing.view()).toEqual({ phase: "closed" });
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("heeds only the current pairing: a closed one's link or connection doesn't reopen or change the dialog", async () => {
    const { pairing, attempts, announce } = dialog();
    pairing.start();
    pairing.close();
    announce(URI);
    expect(pairing.view()).toEqual({ phase: "closed" });
    pairing.start();
    announce(SECOND);
    // the first pairing's wallet approves after all: wagmi connects by itself; here the second stays as it is
    attempts[0].resolve();
    await settled();
    expect(pairing.view()).toEqual({ phase: "scan", uri: SECOND });
  });

  it("changes nothing once it is gone from the page", async () => {
    const { pairing, attempts, announce, views, listening } = dialog();
    pairing.start();
    pairing.dispose();
    const seen = views.length;
    announce(URI);
    attempts[0].reject(new Error("Proposal expired"));
    await settled();
    await vi.advanceTimersByTimeAsync(PAIRING_PREPARE_MS * 2);
    expect(views).toHaveLength(seen);
    expect(listening()).toBe(0);
  });
});
