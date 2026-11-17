import { describe, expect, it } from "vitest";
import { connectorLabel, walletIcon } from "./ConnectWallet";

// The navbar's wallet pill says how you are connected: the wallet's own name in its menu, and its own icon in the
// avatar's place when it announced one (the founder, 2026-11-16).

describe("what the pill shows of the connected wallet", () => {
  it("names a wallet as it announced itself, and the two built-in connectors in the site's words", () => {
    expect(connectorLabel({ id: "io.metamask", name: "MetaMask" })).toBe("MetaMask");
    expect(connectorLabel({ id: "io.rabby", name: "Rabby Wallet" })).toBe("Rabby Wallet");
    expect(connectorLabel({ id: "baseAccount", name: "Base Account SDK" })).toBe("Base Account");
    expect(connectorLabel({ id: "injected", name: "Injected" })).toBe("Browser wallet");
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
