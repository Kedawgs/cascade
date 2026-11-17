import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { walletPeer } from "@/lib/walletconnect";
import { pillIcon, WalletPillView } from "./app/WalletPill";
import { connectorLabel, walletIcon, walletName } from "./ConnectWallet";

// The navbar's wallet pill says how you are connected: the wallet's own name in its menu, and its own icon in the
// avatar's place when it announced one (the founder, 2026-11-16).

describe("what the pill shows of the connected wallet", () => {
  it("names a wallet as it announced itself, and the two built-in connectors in the site's words", () => {
    expect(connectorLabel({ id: "io.metamask", name: "MetaMask" })).toBe("MetaMask");
    expect(connectorLabel({ id: "io.rabby", name: "Rabby Wallet" })).toBe("Rabby Wallet");
    expect(connectorLabel({ id: "baseAccount", name: "Base Account SDK" })).toBe("Base Account");
    expect(connectorLabel({ id: "injected", name: "Injected" })).toBe("Browser wallet");
    expect(connectorLabel({ id: "walletConnect", name: "WalletConnect" })).toBe("WalletConnect");
  });

  it("shows a wallet's icon only when it is an inlined image: never a remote address, a script, or something huge", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const svg = "data:image/svg+xml;base64,PHN2Zy8+";
    expect(walletIcon(png)).toBe(png);
    expect(walletIcon(svg)).toBe(svg);
    for (const bad of [undefined, null, 7, "", "https://example.com/icon.png", "//example.com/i.png", "javascript:alert(1)", "data:text/html;base64,PGI+", "data:application/javascript;base64,YQ==", `data:image/png;base64,${"A".repeat(200_001)}`]) {
      expect(walletIcon(bad), String(bad).slice(0, 40)).toBeUndefined();
    }
  });
});

describe("a wallet connected through WalletConnect", () => {
  const WC = { id: "walletConnect", name: "WalletConnect" };
  const PNG = "data:image/png;base64,iVBORw0KGgo=";
  const REMOTE = ["https://wallet.example/icon.png", "http://wallet.example/icon.png", "//wallet.example/icon.png", "ipfs://bafy/icon.png", "javascript:alert(1)", "data:text/html,<script>1</script>", "blob:https://cascadefi.xyz/1"];

  it("is named by the wallet's own name from its session, with how it is connected", () => {
    expect(walletName(WC, walletPeer({ name: "Tangem" }))).toBe("Tangem (WalletConnect)");
    expect(walletName(WC, walletPeer({ name: "Trust Wallet", icons: ["https://trust.example/i.png"] }))).toBe("Trust Wallet (WalletConnect)");
    // no name given, or no session read: the connector's
    expect(walletName(WC, walletPeer({}))).toBe("WalletConnect");
    expect(walletName(WC)).toBe("WalletConnect");
  });

  it("gets its name as plain, short text whatever the wallet sent", () => {
    expect(walletName(WC, walletPeer({ name: "Evil‮\u0000\nWallet" }))).toBe("Evil Wallet (WalletConnect)");
    expect(walletName(WC, walletPeer({ name: "x".repeat(5_000) }))).toBe(`${"x".repeat(40)} (WalletConnect)`);
  });

  it("is the only connector a session's name speaks for", () => {
    expect(walletName({ id: "io.metamask", name: "MetaMask" }, { name: "Tangem" })).toBe("MetaMask");
    expect(walletName({ id: "baseAccount", name: "Base Account SDK" }, { name: "Tangem" })).toBe("Base Account");
  });

  it("never has its session's icon loaded from an address: only an inlined image is an icon, anything else is the avatar", () => {
    for (const icon of REMOTE) expect(pillIcon({}, walletPeer({ name: "A", icons: [icon] })), icon).toBeUndefined();
    expect(pillIcon({}, walletPeer({ name: "A", icons: [PNG] }))).toBe(PNG);
    // a connector's own announced icon comes first
    expect(pillIcon({ icon: PNG }, walletPeer({ icons: ["https://wallet.example/icon.png"] }))).toBe(PNG);
    expect(pillIcon(undefined, undefined)).toBeUndefined();
  });

  /** The pill and its menu as rendered for a wallet. */
  const pill = (wallet: string | undefined, icon: string | undefined) => renderToString(createElement(WalletPillView, { name: "0x5290…9EE7", balance: "12.50 USDC", wallet, icon, onDisconnect: () => undefined }));

  it("renders the name in the menu and in the pill's label, as text", () => {
    const h = pill(walletName(WC, walletPeer({ name: "Tangem" })), undefined);
    expect(h).toContain("Connected with Tangem (WalletConnect)");
    expect(h).toContain('aria-label="Account menu: 0x5290…9EE7, connected with Tangem (WalletConnect)"');
    expect(h).toMatch(/<button type="button" class="[^"]*">Disconnect<\/button>/);
    // markup in a name is written out as text, never as markup
    const odd = pill(walletName(WC, walletPeer({ name: '<img src=x onerror="alert(1)">' })), undefined);
    expect(odd).not.toMatch(/<img/);
    expect(odd).toContain("&lt;img src=x onerror=");
  });

  it("renders no <img> at all for a remote icon, whoever passes it: the avatar stands in", () => {
    for (const icon of REMOTE) {
      // as the pill gets it from a session, and even handed straight to the view
      for (const given of [pillIcon({}, walletPeer({ name: "A", icons: [icon] })), icon]) {
        const h = pill("A (WalletConnect)", given);
        expect(h, icon).not.toMatch(/<img|src=/);
        expect(h).not.toContain("wallet.example");
        expect(h).toMatch(/<span class="[^"]*_avatar_[^"]*" aria-hidden="true"><\/span>/);
      }
    }
  });

  it("renders an inlined icon in the avatar's place", () => {
    const h = pill("A (WalletConnect)", PNG);
    expect(h).toMatch(new RegExp(`<img class="[^"]*" src="${PNG.replace(/[+]/g, "\\+")}" alt="" width="30" height="30"/>`));
    expect(h).not.toMatch(/_avatar_[0-9a-f]+" aria-hidden/);
  });
});
