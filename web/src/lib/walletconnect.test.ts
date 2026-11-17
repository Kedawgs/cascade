import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { WALLETCONNECT_RELAY as POLICY_RELAY, walletConnectOn } from "../../scripts/csp-headers.mjs";
import {
  baseAccounts,
  pairingFailure,
  pairingFailureCopy,
  pairingUri,
  WALLETCONNECT_METADATA,
  WALLETCONNECT_OPTION,
  WALLETCONNECT_PROJECT_ID,
  WALLETCONNECT_RELAY,
  walletConnectId,
  walletConnectLabel,
  WalletConnectNoBaseError,
  walletConnectProjectId,
  walletPeer,
} from "./walletconnect";

// WalletConnect as a way to connect (the founder, 2026-11-16): phone and hardware wallets, by QR code or link.

/** An id nobody has: for the override's tests. */
const MADE_UP = "0123456789abcdef0123456789abcdef";
const ME = "0x52908400098527886E0F7030069857D2E4169EE7";

describe("the project id a build pairs with", () => {
  it("is the founder's Reown project, tracked in the source", () => {
    expect(WALLETCONNECT_PROJECT_ID).toBe("b09a19083568478e654f0378e2f4997f");
    expect(walletConnectProjectId({})).toBe(WALLETCONNECT_PROJECT_ID);
    expect(walletConnectProjectId({ NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: undefined })).toBe(WALLETCONNECT_PROJECT_ID);
    // the tests' own build has no override
    expect(walletConnectId).toBe(WALLETCONNECT_PROJECT_ID);
  });

  it("is another id when the build's variable names one", () => {
    expect(walletConnectProjectId({ NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: MADE_UP })).toBe(MADE_UP);
  });

  it("is none, WalletConnect off, when the variable is empty or isn't shaped like an id: never the tracked one behind a typo", () => {
    for (const v of ["", " ", "off", "false", "0", MADE_UP.toUpperCase(), MADE_UP.slice(1), `${MADE_UP}0`, ` ${MADE_UP}`, `${MADE_UP}\n`, `0x${MADE_UP.slice(2)}`, "g".repeat(32)]) {
      expect(walletConnectProjectId({ NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: v }), JSON.stringify(v)).toBeNull();
    }
    // a tracked id that isn't one is off too
    expect(walletConnectProjectId({}, "not an id")).toBeNull();
  });

  it("is read by the policy's script by the same rule, so the relay is allowed exactly when the option is there", () => {
    for (const v of [undefined, "", " ", "off", MADE_UP, MADE_UP.toUpperCase(), MADE_UP.slice(1), `${MADE_UP}0`, `${MADE_UP}\n`, WALLETCONNECT_PROJECT_ID]) {
      expect(walletConnectOn(v), JSON.stringify(v)).toBe(walletConnectProjectId({ NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: v }) !== null);
    }
  });
});

describe("what the option and the wallet say", () => {
  it('reads "WalletConnect", and under it who it is for', () => {
    expect(WALLETCONNECT_OPTION).toEqual({ name: "WalletConnect", note: "Phone and hardware wallets: scan a QR code" });
  });

  it("tells the wallet the site's name, address and icon, all the site's own", () => {
    expect(WALLETCONNECT_METADATA.name).toBe("Cascade");
    expect(WALLETCONNECT_METADATA.url).toBe("https://cascadefi.xyz");
    for (const icon of WALLETCONNECT_METADATA.icons) expect(new URL(icon).origin).toBe("https://cascadefi.xyz");
  });
});

describe("the wallet's own word about itself (a session's peer metadata: untrusted)", () => {
  it("keeps a plain name", () => {
    expect(walletPeer({ name: "Tangem", icons: [] })).toEqual({ name: "Tangem" });
    expect(walletPeer({ name: "  Trust   Wallet  " })).toEqual({ name: "Trust Wallet" });
    expect(walletPeer({ name: "Wällét №1 (beta)" })).toEqual({ name: "Wällét №1 (beta)" });
  });

  it("drops control and formatting characters, which could make one name read as another", () => {
    // a right-to-left override, zero-width characters, a line break, a tab, a NUL
    expect(walletPeer({ name: "Meta‮ksaM​‍﻿" })?.name).toBe("Meta ksaM");
    expect(walletPeer({ name: "Safe\nConnected with MetaMask\t\u0000" })?.name).toBe("Safe Connected with MetaMask");
    expect(walletPeer({ name: "   " })).toEqual({});
  });

  it("cuts a long name to 40 characters, whole ones", () => {
    const long = walletPeer({ name: "W".repeat(500) })?.name;
    expect(long).toBe("W".repeat(40));
    // 39 letters then a character of two code units: the cut never leaves half of it
    const astral = walletPeer({ name: `${"a".repeat(39)}😀😀` })?.name ?? "";
    expect(Array.from(astral)).toHaveLength(40);
    expect(astral.endsWith("😀")).toBe(true);
    expect(astral.isWellFormed()).toBe(true);
  });

  it("is markup to nobody: a name is text, and the site writes it as text", () => {
    expect(walletPeer({ name: '<img src=x onerror="alert(1)">' })?.name).toBe('<img src=x onerror="alert(1)">');
  });

  it("keeps the first icon only as a string for walletIcon to judge, and nothing that isn't one", () => {
    expect(walletPeer({ name: "A", icons: ["https://wallet.example/icon.png", "data:image/png;base64,AA=="] })).toEqual({ name: "A", icon: "https://wallet.example/icon.png" });
    expect(walletPeer({ name: "A", icons: [7, null, { src: "x" }] })).toEqual({ name: "A" });
    expect(walletPeer({ name: "A", icons: "https://wallet.example/icon.png" })).toEqual({ name: "A" });
  });

  it("is nothing for anything that isn't an object, and empty for one that says nothing usable", () => {
    for (const bad of [undefined, null, "Tangem", 7, true]) expect(walletPeer(bad)).toBeUndefined();
    expect(walletPeer({})).toEqual({});
    expect(walletPeer({ name: 7, icons: null })).toEqual({});
    expect(walletPeer([])).toEqual({});
  });

  it("names the wallet with how it is connected, or WalletConnect alone when the wallet gave no name", () => {
    expect(walletConnectLabel({ name: "Tangem" })).toBe("Tangem (WalletConnect)");
    expect(walletConnectLabel({})).toBe("WalletConnect");
    expect(walletConnectLabel(undefined)).toBe("WalletConnect");
    expect(walletConnectLabel({ name: "WalletConnect" })).toBe("WalletConnect");
  });
});

describe("a pairing link, as the site will show, copy and link to it", () => {
  const TOPIC = "ab".repeat(32);
  const real = `wc:${TOPIC}@2?expiryTimestamp=1794885130&relay-protocol=irn&symKey=${"cd".repeat(32)}`;

  it("is a WalletConnect v2 link as the provider writes one", () => {
    expect(pairingUri(real)).toBe(real);
  });

  it("is nothing for anything else: another scheme, a script, a space, version 1, too long, not a string", () => {
    for (const bad of [
      undefined,
      null,
      7,
      "",
      "wc:",
      `javascript:alert(1)//wc:${TOPIC}@2?a=b`,
      `https://example.com/wc:${TOPIC}@2?a=b`,
      ` ${real}`,
      `${real} `,
      `${real}\n`,
      real.replace("@2?", "@1?"),
      real.replace(TOPIC, TOPIC.slice(2)),
      real.replace(TOPIC, TOPIC.toUpperCase()),
      `wc:${TOPIC}@2?a=b c`,
      `wc:${TOPIC}@2?a="><script>`.replace(">", "\u0000"),
      `wc:${TOPIC}@2?${"a".repeat(1_001)}`,
      { toString: () => real },
    ]) {
      expect(pairingUri(bad), String(bad).slice(0, 50)).toBeUndefined();
    }
  });
});

describe("Base is required: the accounts a session approved there", () => {
  it("reads them from the session, checksummed, each once", () => {
    const session = { namespaces: { eip155: { accounts: [`eip155:1:${ME}`, `eip155:8453:${ME.toLowerCase()}`, `eip155:8453:${ME}`, `eip155:964:${ME}`] } } };
    expect(baseAccounts(session)).toEqual([ME]);
    // a wallet may key a namespace by its chain
    expect(baseAccounts({ namespaces: { "eip155:8453": { accounts: [`eip155:8453:${ME}`] } } })).toEqual([ME]);
  });

  it("is none when the wallet left Base out, however many other chains it approved, and for anything malformed", () => {
    expect(baseAccounts({ namespaces: { eip155: { accounts: [`eip155:1:${ME}`, `eip155:964:${ME}`, `eip155:84530:${ME}`] } } })).toEqual([]);
    expect(baseAccounts({ namespaces: { solana: { accounts: [`eip155:8453:${ME}`] } } })).toEqual([]);
    expect(baseAccounts({ namespaces: { eip155: { accounts: ["eip155:8453:not-an-address", "eip155:8453:", `eip155:8453:${ME}0`] } } })).toEqual([]);
    for (const empty of [undefined, {}, { namespaces: {} }, { namespaces: { eip155: undefined } }, { namespaces: { eip155: {} } }]) expect(baseAccounts(empty)).toEqual([]);
  });
});

describe("a pairing that ended without a connection", () => {
  it("is sorted into declined, expired, no Base, or WalletConnect not reached", () => {
    // wagmi's connector names a refusal; wallets answer 5000 to 5002, or in words
    expect(pairingFailure(Object.assign(new Error("User rejected the request."), { name: "UserRejectedRequestError" }))).toBe("declined");
    expect(pairingFailure(new Error("User rejected."))).toBe("declined");
    expect(pairingFailure({ code: 5000, message: "nope" })).toBe("declined");
    expect(pairingFailure({ code: 5002, message: "methods" })).toBe("declined");
    expect(pairingFailure(new Error("wrapped", { cause: { code: 4001 } }))).toBe("declined");
    // the provider's own word when the five minutes run out
    expect(pairingFailure(new Error("Proposal expired"))).toBe("expired");
    expect(pairingFailure(new WalletConnectNoBaseError())).toBe("no-base");
    for (const other of [new Error("WebSocket connection closed abnormally with code: 3000 (Unauthorized: origin not allowed)"), new Error("Loading chunk failed"), undefined, null, "x", { code: 5100 }]) {
      expect(pairingFailure(other), String(other)).toBe("unreachable");
    }
  });

  it("is said in plain words with a way to try again, never the library's", () => {
    expect(pairingFailureCopy("declined")).toEqual({ message: "The wallet declined the connection. Nothing was connected.", retry: "Try again" });
    expect(pairingFailureCopy("expired")).toEqual({ message: "This QR code expired before a wallet connected.", retry: "Get a new code" });
    expect(pairingFailureCopy("no-base").message).toBe("That wallet connected without Base, so it was disconnected. In the wallet, add or choose the Base network, then try again.");
    expect(pairingFailureCopy("unreachable").message).toBe("We couldn't reach WalletConnect just now. Check your connection and try again.");
  });
});

describe("the hosts WalletConnect's installed packages name (read from their files, so a bump that adds one is seen)", () => {
  const require = createRequire(import.meta.url);
  /** A WalletConnect package's folder, found from the package that depends on it (pnpm keeps each beside its dependant). */
  const folderOf = (name: string, from: string) => {
    let dir = dirname(require.resolve(name, { paths: [from] }));
    while (!existsSync(join(dir, "package.json"))) dir = dirname(dir);
    return dir;
  };
  const provider = folderOf("@walletconnect/ethereum-provider", import.meta.dirname);
  const universal = folderOf("@walletconnect/universal-provider", provider);
  const sign = folderOf("@walletconnect/sign-client", universal);
  const core = folderOf("@walletconnect/core", sign);
  const utils = folderOf("@walletconnect/utils", sign);
  const folders = [provider, universal, sign, core, utils, folderOf("@walletconnect/jsonrpc-ws-connection", core), folderOf("@walletconnect/jsonrpc-http-connection", universal), folderOf("@walletconnect/keyvaluestorage", core), folderOf("@walletconnect/relay-auth", core)];
  /** Every browser build among a package's files (not its source maps, type files or React Native builds). */
  const scripts = (folder: string) =>
    readdirSync(join(folder, "dist"))
      .filter((f) => /\.(js|cjs|mjs)$/.test(f) && !f.includes("native") && !f.includes("umd"))
      .map((f) => readFileSync(join(folder, "dist", f), "utf8"));
  const urls = [...new Set(folders.flatMap(scripts).flatMap((text) => text.match(/\b(?:wss?|https?):\/\/[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []))].sort();

  it("are these and no others", () => {
    expect(urls).toEqual([
      // push notifications' registry: a wallet's, never called by a site
      "https://echo.walletconnect.com",
      // telemetry: off (telemetryEnabled: false)
      "https://pulse.walletconnect.org",
      // the provider's default RPC and bundler lookups: the site gives it its own RPCs for Base and Bittensor
      "https://rpc.walletconnect.org",
      // a deep link into Telegram's in-app wallet
      "https://t.me",
      // the Verify frame and its keys: off (walletconnect-inner.ts withoutVerifyFrame)
      "https://verify.walletconnect.com",
      "https://verify.walletconnect.org",
      // AppKit's defaults for a site that names no metadata: the site names its own, and has no AppKit
      "https://walletconnect.org",
      // the relay: the one the policy allows
      "wss://relay.walletconnect.org",
    ]);
  });

  it("have one relay, a WebSocket, which is exactly what the policy allows when the option is on", () => {
    expect(urls.filter((u) => u.startsWith("ws"))).toEqual([WALLETCONNECT_RELAY]);
    expect(POLICY_RELAY).toBe(WALLETCONNECT_RELAY);
    expect(WALLETCONNECT_RELAY).toBe("wss://relay.walletconnect.org");
  });
});
