import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { base } from "viem/chains";
import { describe, expect, it } from "vitest";
import { createConfig, http, WagmiProvider } from "wagmi";
import { type AttemptsView, CONNECT_FAILED } from "@/lib/connect-attempts";
import { walletConnectors } from "@/lib/wagmi";
import { WALLETCONNECT_PROJECT_ID } from "@/lib/walletconnect";
import { ConnectWallet, ConnectWalletView, pickConnectors, WalletList } from "./ConnectWallet";
import { plainText } from "./test-render";

// The list of wallets behind "Connect wallet": WalletConnect as an option (the founder, 2026-11-16), a connection the
// person ended themselves said nowhere, any other failure said inside the list's panel so the button never moves, and
// no wallet's silence ever locking the list.

const BASE = { id: "baseAccount", name: "Base Account SDK", type: "baseAccount", uid: "u-base" };
const METAMASK = { id: "io.metamask", name: "MetaMask", type: "injected", uid: "u-mm" };
const RABBY = { id: "io.rabby", name: "Rabby Wallet", type: "injected", uid: "u-rabby" };
const GENERIC = { id: "injected", name: "Injected", type: "injected", uid: "u-inj" };
const WALLETCONNECT = { id: "walletConnect", name: "WalletConnect", type: "walletConnect", uid: "u-wc" };
const AT_REST: AttemptsView = { pending: null, error: null };
const nothing = () => undefined;

const list = (options: (typeof BASE)[], view: AttemptsView = AT_REST) => renderToString(createElement(WalletList, { options, view, onChoose: nothing, onCancel: nothing }));
/** The button with its list open on a state, as the app bar (`pill`) or a card (`pill-block`) shows it. */
const opened = (variant: "pill" | "pill-block", view: AttemptsView, dialog = false) =>
  renderToString(
    createElement(
      ConnectWalletView,
      { variant, open: true, onToggle: nothing, ...(dialog ? { dialog: createElement("dialog", null) } : {}) },
      createElement(WalletList, { options: [BASE, METAMASK, WALLETCONNECT], view, onChoose: nothing, onCancel: nothing }),
    ),
  );

/** Every button of a page: its attributes and its text. */
const buttons = (html: string) => [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/g)].map((m) => ({ attrs: m[1], text: plainText(m[2]) }));
/** The tags of an element's own children, in order, from its markup (well-formed, as React writes it). */
function childTags(html: string): string[] {
  const tags: string[] = [];
  let depth = 0;
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)\b[^>]*?(\/?)>/g)) {
    const [, closing, tag, selfClosing] = m;
    if (closing) depth--;
    else {
      if (depth === 1) tags.push(tag);
      if (!selfClosing && !["input", "img", "br", "path", "rect"].includes(tag)) depth++;
    }
  }
  return tags;
}
/** The panel's own markup: the element the button controls. */
function panelOf(html: string): string {
  const id = /aria-controls="([^"]+)"/.exec(html)?.[1];
  expect(id).toBeDefined();
  const m = new RegExp(`<div id="${id}"[^>]*>((?:(?!</?div).)*)</div>`, "s").exec(html);
  expect(m, "the panel holds no other box").not.toBeNull();
  return m![1];
}

describe("which wallets are offered", () => {
  it("puts Base Account first, then the wallets the browser announced, then WalletConnect", () => {
    expect(pickConnectors([GENERIC, WALLETCONNECT, RABBY, BASE, METAMASK], true).map((c) => c.id)).toEqual(["baseAccount", "io.rabby", "io.metamask", "walletConnect"]);
    // the generic browser wallet only when nothing announced itself
    expect(pickConnectors([BASE, GENERIC, WALLETCONNECT], true).map((c) => c.id)).toEqual(["baseAccount", "injected", "walletConnect"]);
    // a browser with no wallet still has two ways in
    expect(pickConnectors([BASE, GENERIC, WALLETCONNECT], false).map((c) => c.id)).toEqual(["baseAccount", "walletConnect"]);
  });

  /** The site's own connectors for a build with (or without) a project id. */
  const built = (project: string | null) => createConfig({ chains: [base], connectors: walletConnectors(project), transports: { [base.id]: http() }, multiInjectedProviderDiscovery: false, ssr: true });

  it("shows WalletConnect when the build offers it", () => {
    const config = built(WALLETCONNECT_PROJECT_ID);
    const options = pickConnectors(config.connectors, false);
    expect(options.map((c) => c.id)).toEqual(["baseAccount", "walletConnect"]);
    const html = list(options);
    expect(buttons(html).map((b) => b.text)).toEqual(["Base Account", "WalletConnectPhone and hardware wallets: scan a QR code"]);
  });

  it("hides it when the build has it off: no option, and no dialog for it on the page", () => {
    const config = built(null);
    const options = pickConnectors(config.connectors, false);
    expect(options.map((c) => c.id)).toEqual(["baseAccount"]);
    expect(list(options)).not.toMatch(/WalletConnect|QR code/);
    const page = (c: typeof config) => renderToString(createElement(WagmiProvider, { config: c as never, reconnectOnMount: false }, createElement(ConnectWallet)));
    expect(page(config)).not.toMatch(/<dialog|WalletConnect/);
    // and on: its dialog is there, closed and empty, until the option is picked
    expect(page(built(WALLETCONNECT_PROJECT_ID))).toMatch(/<dialog[^>]*><\/dialog><\/div>$/);
  });
});

describe("WalletConnect's option", () => {
  const html = list([BASE, WALLETCONNECT]);

  it('reads "WalletConnect", with a second line saying who it is for', () => {
    expect(html).toMatch(/<button type="button" class="[^"]*"><span>WalletConnect<\/span><span class="[^"]*">Phone and hardware wallets: scan a QR code<\/span><\/button>/);
  });

  it("is a button like the others: nothing is fetched to show it (no image, no address)", () => {
    expect(html).not.toMatch(/<img|src=|https?:|url\(/);
  });
});

describe("a wallet being connected to", () => {
  const html = list([BASE, METAMASK, WALLETCONNECT], { pending: BASE.uid, error: null });
  const all = buttons(html);

  it("says so on its row and offers Cancel there", () => {
    expect(all.map((b) => b.text)).toEqual(["Connecting to Base Account…", "Cancel", "MetaMask", "WalletConnectPhone and hardware wallets: scan a QR code"]);
    // Cancel is in the pending wallet's own row, right after it
    expect(html).toMatch(/<li class="[^"]*"><button[^>]*>Connecting to Base Account…<\/button><button type="button" class="[^"]*">Cancel<\/button><\/li>/);
    // the pending wallet's button stays where it was (focus stays on it) and reads as unavailable
    expect(all[0].attrs).toContain('aria-disabled="true"');
  });

  it("locks nothing: every other wallet stays there to pick, and Cancel to press", () => {
    for (const b of all) expect(b.attrs, b.text).not.toMatch(/\sdisabled(=|\s|$)/);
    for (const b of all.slice(1)) expect(b.attrs, b.text).not.toContain("aria-disabled");
    expect(html).not.toMatch(/<fieldset|inert|aria-busy/);
  });

  it("offers no Cancel when nothing is being connected to", () => {
    expect(buttons(list([BASE, METAMASK])).map((b) => b.text)).toEqual(["Base Account", "MetaMask"]);
  });
});

describe("what is said when a connection doesn't happen", () => {
  it("is nothing at all when the person ended it themselves: no alert, no error element, the list as it was", () => {
    // (connect-attempts.ts leaves the list at rest for a rejected, denied or closed connection)
    for (const variant of ["pill", "pill-block"] as const) {
      const html = opened(variant, AT_REST);
      expect(html).not.toMatch(/role="alert"|_error_|couldn/i);
      expect(html).not.toContain("The wallet closed before connecting");
      expect(buttons(html).map((b) => b.text)).toEqual(["Connect wallet", "Base Account", "MetaMask", "WalletConnectPhone and hardware wallets: scan a QR code"]);
    }
  });

  it("is one sentence for any other failure, inside the list's panel, under the options", () => {
    for (const variant of ["pill", "pill-block"] as const) {
      const panel = panelOf(opened(variant, { pending: null, error: CONNECT_FAILED }));
      expect(panel).toMatch(/^<ul [^>]*aria-label="Choose a wallet">.*<\/ul><p class="[^"]*" role="alert">We couldn&#x27;t connect to that wallet\. Try again or pick another one\.<\/p>$/s);
      expect(panel.match(/role="alert"/g)).toHaveLength(1);
    }
  });

  it("adds nothing beside the button in either case: the button's wrapper holds the button and its panel (and WalletConnect's dialog, which is out of the flow), nothing else", () => {
    for (const variant of ["pill", "pill-block"] as const) {
      for (const view of [AT_REST, { pending: null, error: CONNECT_FAILED }, { pending: METAMASK.uid, error: null }]) {
        expect(childTags(opened(variant, view)), `${variant} ${JSON.stringify(view)}`).toEqual(["button", "div"]);
        expect(childTags(opened(variant, view, true))).toEqual(["button", "div", "dialog"]);
      }
    }
    // closed, the panel is there, hidden and empty
    const closed = renderToString(
      createElement(ConnectWalletView, { open: false, onToggle: nothing }, createElement(WalletList, { options: [BASE], view: { pending: null, error: CONNECT_FAILED }, onChoose: nothing, onCancel: nothing })),
    );
    expect(childTags(closed)).toEqual(["button", "div"]);
    expect(closed).toMatch(/<div id="[^"]+" hidden="" class="[^"]*"><\/div><\/div>$/);
    expect(closed).not.toMatch(/role="alert"/);
  });

  it("can't move the app bar: there the panel hangs under the button, out of the flow (the stylesheet)", () => {
    const css = readFileSync(fileURLToPath(new URL("./ConnectWallet.module.css", import.meta.url)), "utf8");
    const rule = (selector: string) => new RegExp(`(?:^|})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*{([^}]*)}`, "m").exec(css)?.[1] ?? "";
    expect(rule(".inline .panel")).toMatch(/position:\s*absolute;/);
    expect(rule(".inline")).toMatch(/position:\s*relative;/);
    // the sentence has no positioning of its own: it is in the panel's flow, and only there
    expect(rule(".error")).not.toMatch(/position|float|inset|(?:^|\s)(?:top|bottom|left|right):/);
  });
});
