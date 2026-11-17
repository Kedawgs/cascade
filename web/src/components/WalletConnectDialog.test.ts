import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import decodeQR from "qr/decode.js";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { qrPath } from "@/lib/qr-path";
import type { PairingView } from "@/lib/walletconnect-pairing";
import { plainText } from "./test-render";
import { type CopyState, WalletConnectDialogView } from "./WalletConnectDialog";

// WalletConnect's dialog, the site's own (no Reown window): the pairing link as a QR code drawn here, Copy link, and
// on a phone "Open in wallet".

const URI = `wc:${"ab".repeat(32)}@2?expiryTimestamp=1794885130&relay-protocol=irn&symKey=${"cd".repeat(32)}`;
const nothing = () => undefined;
const html = (view: PairingView, o: { qr?: boolean; copy?: CopyState } = {}) =>
  renderToString(createElement(WalletConnectDialogView, { view, qr: o.qr === false || view.phase !== "scan" ? null : qrPath(view.uri), copy: o.copy ?? "idle", onCopy: nothing, onRetry: nothing, onClose: nothing }));
const unescaped = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
/** An attribute's value on the first element matching `tag`. */
const attr = (h: string, tag: RegExp, name: string) => {
  const el = tag.exec(h)?.[0] ?? "";
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(el);
  return m ? unescaped(m[1]) : undefined;
};
/** The element an id names: its text. */
const textOf = (h: string, id: string | undefined) => plainText(new RegExp(`<([a-z0-9]+)[^>]*id="${id}"[^>]*>(.*?)</\\1>`, "s").exec(h)?.[2] ?? "");

/** What a phone's camera would read from the code as drawn: the SVG's bars painted onto pixels, then decoded. */
function scanned(h: string): string {
  const size = Number(/viewBox="0 0 (\d+) \d+"/.exec(h)?.[1]);
  const d = attr(h, /<path\b[^>]*>/, "d") ?? "";
  const scale = 4;
  const side = size * scale;
  const data = new Uint8Array(side * side * 4).fill(255);
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [x, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let py = y * scale; py < (y + 1) * scale; py++) {
      for (let px = x * scale; px < (x + w) * scale; px++) data.fill(0, (py * side + px) * 4, (py * side + px) * 4 + 3);
    }
  }
  return decodeQR({ width: side, height: side, data });
}

describe("the dialog", () => {
  it("is a dialog named by its title, with a Close button, and empty while closed", () => {
    const h = html({ phase: "preparing" });
    expect(h).toMatch(/^<dialog/);
    expect(textOf(h, attr(h, /<dialog\b[^>]*>/, "aria-labelledby"))).toBe("Connect with WalletConnect");
    expect(h).toMatch(/<button type="button" class="[^"]*" aria-label="Close">/);
    expect(html({ phase: "closed" })).toMatch(/^<dialog[^>]*><\/dialog>$/);
  });

  it("says it is getting a code, in a line a screen reader hears change", () => {
    const h = html({ phase: "preparing" });
    const status = attr(h, /<dialog\b[^>]*>/, "aria-describedby");
    expect(textOf(h, status)).toBe("Getting a QR code…");
    expect(h).toMatch(new RegExp(`<p id="${status}" role="status"`));
    expect(h).not.toMatch(/<svg|<a\b|Copy link/);
  });
});

describe("the pairing link on screen", () => {
  const h = html({ phase: "scan", uri: URI });

  it("is a QR code drawn in the page, which reads back as exactly the link", () => {
    expect(scanned(h)).toBe(URI);
  });

  it("has a text alternative, and says what to do with it: scan it, or on a phone open the wallet from the link", () => {
    expect(attr(h, /<svg\b[^>]*>/, "role")).toBe("img");
    expect(attr(h, /<svg\b[^>]*>/, "aria-label")).toBe("QR code holding the connection link. If you can't scan it, use Copy link and paste it into your wallet.");
    const text = textOf(h, attr(h, /<dialog\b[^>]*>/, "aria-describedby"));
    expect(text).toContain("Scan this code with your wallet's app, then approve the connection there. Choose Base if it asks for a network.");
    expect(text).toContain("Open your wallet's app from here, or scan this code from another device, then approve the connection there. Choose Base if it asks for a network.");
  });

  it("is drawn with nothing fetched and nothing the policy would have to allow: an inline SVG path, no image address, no inline style, no remote address", () => {
    expect(h).toMatch(/<svg class="[^"]*" role="img"[^>]*><rect width="\d+" height="\d+" fill="#fff"><\/rect><path d="M[^"]+" fill="#10212b"><\/path><\/svg>/);
    expect(h).not.toMatch(/<img|<image|<use|<foreignObject|\ssrc=|\sstyle=|xlink|https?:|url\(|data:/i);
    // the only address in it is the link itself, in "Open in wallet"
    expect(h.match(/href="/g)).toHaveLength(1);
  });

  it('has "Open in wallet", a link to the wc: address itself, and "Copy link"', () => {
    expect(attr(h, /<a\b[^>]*>/, "href")).toBe(URI);
    expect(h).toMatch(/<a class="pill pill-block [^"]*" href="wc:[^"]*">Open in wallet<\/a>/);
    expect(h).toMatch(/<button type="button" class="pill pill-ghost pill-block">Copy link<\/button>/);
    // the link isn't on screen as text until copying fails
    expect(plainText(h)).not.toContain(URI);
    expect(h).not.toMatch(/<input/);
  });

  it('shows "Open in wallet" where a finger points and not where a mouse does, and there reads the phone\'s sentence (the stylesheet)', () => {
    const css = readFileSync(fileURLToPath(new URL("./WalletConnectDialog.module.css", import.meta.url)), "utf8");
    const [wide, touch] = css.split("@media (hover: none) and (pointer: coarse)");
    expect(touch).toBeDefined();
    expect(wide).toMatch(/\.open\s*{\s*display:\s*none;\s*}/);
    expect(wide).toMatch(/\.byLink\s*{\s*display:\s*none;\s*}/);
    expect(touch).toMatch(/\.open\s*{\s*display:\s*flex;\s*}/);
    expect(touch).toMatch(/\.byScan\s*{\s*display:\s*none;\s*}/);
    expect(touch).toMatch(/\.byLink\s*{\s*display:\s*inline;\s*}/);
    // nothing in the dialog's styles is fetched either
    expect(css).not.toMatch(/url\(|@import|https?:/);
  });

  it("says when the link was copied, in a line that is there before it speaks", () => {
    const status = /<p role="status" class="[^"]*">([^<]*)<\/p>/;
    expect(status.exec(h)?.[1]).toBe("");
    expect(status.exec(html({ phase: "scan", uri: URI }, { copy: "copied" }))?.[1]).toBe("Link copied");
  });

  it("shows the link to copy by hand when the browser won't copy it", () => {
    const failed = html({ phase: "scan", uri: URI }, { copy: "failed" });
    expect(unescaped(failed)).toContain("Couldn't copy it. Select the link below and copy it by hand.");
    expect(attr(failed, /<input\b[^>]*>/, "value")).toBe(URI);
    expect(failed).toMatch(/<input class="[^"]*" readOnly="" aria-label="Connection link"/);
  });

  it("warns that the link is for the person's own wallet only", () => {
    expect(plainText(h)).toContain("Paste the link only into your own wallet: anyone who has it can connect a wallet to this page until it is used or expires.");
  });

  it("holds the code's square while its drawing code loads, so nothing moves when it arrives", () => {
    const waiting = html({ phase: "scan", uri: URI }, { qr: false });
    expect(waiting).not.toMatch(/<svg/);
    expect(waiting).toMatch(/<div class="[^"]*_qr_[^"]*"><span class="[^"]*" aria-hidden="true"><\/span><\/div>/);
    expect(attr(waiting, /<a\b[^>]*>/, "href")).toBe(URI);
  });
});

describe("a pairing that failed", () => {
  it("says why in plain words, as an alert, with a way to try again and a way out", () => {
    for (const [failure, message, retry] of [
      ["declined", "The wallet declined the connection. Nothing was connected.", "Try again"],
      ["expired", "This QR code expired before a wallet connected.", "Get a new code"],
      ["no-base", "That wallet connected without Base, so it was disconnected. In the wallet, add or choose the Base network, then try again.", "Try again"],
      ["unreachable", "We couldn't reach WalletConnect just now. Check your connection and try again.", "Try again"],
    ] as const) {
      const h = html({ phase: "failed", failure });
      const described = attr(h, /<dialog\b[^>]*>/, "aria-describedby");
      expect(textOf(h, described), failure).toBe(message);
      expect(h).toMatch(new RegExp(`<p id="${described}" role="alert"`));
      expect([...h.matchAll(/<button type="button" class="pill[^"]*">([^<]*)<\/button>/g)].map((m) => m[1])).toEqual([retry, "Close"]);
      // the old code is gone with it
      expect(h).not.toMatch(/<svg|<a\b|Copy link/);
    }
  });
});

describe("the QR code's drawing", () => {
  it("is a square of unit-high bars with the standard's light margin of four modules on every side", () => {
    const { size, d } = qrPath(URI);
    const bars = [...d.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), back: Number(m[4]) }));
    expect(bars.length).toBeGreaterThan(100);
    expect(d.replace(/M\d+ \d+h\d+v1h-\d+z/g, "")).toBe("");
    for (const b of bars) {
      expect(b.back).toBe(b.w);
      expect(b.x).toBeGreaterThanOrEqual(4);
      expect(b.y).toBeGreaterThanOrEqual(4);
      expect(b.x + b.w).toBeLessThanOrEqual(size - 4);
      expect(b.y).toBeLessThan(size - 4);
    }
  });

  it("holds any link the provider may write, at its longest", () => {
    const long = `wc:${"ab".repeat(32)}@2?${"a".repeat(1_000)}`;
    const { size, d } = qrPath(long);
    expect(size).toBeGreaterThan(60);
    expect(d.length).toBeGreaterThan(1_000);
  });
});
