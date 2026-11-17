import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { plainText, renderWithCache } from "../test-render";
import { RewardsScreen } from "./RewardsScreen";

const css = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
/** A rule's declarations, by its selector as written (the first rule with it). */
const rule = (sheet: string, selector: string) => {
  const at = sheet.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return sheet.slice(at + selector.length + 2, sheet.indexOf("}", at)).replace(/\s+/g, " ").trim();
};

describe("the app's header stays on screen as the page scrolls", () => {
  // any app page: each is the shell with its own column
  const html = renderWithCache(createElement(RewardsScreen));
  const shell = css("./AppShell.module.css");

  it("sits in the sticky wrapper, whole (the logo, the tabs and the wallet), with the page's column after the wrapper, not in it", () => {
    expect(html).toMatch(/^<div class="_app_[^"]*"><div class="_barWrap_[^"]*"><header class="_bar_[^"]*">/);
    const header = /<header[^>]*>([\s\S]*?)<\/header>/.exec(html)![1];
    for (const part of ["Cascade home", "App sections", "Stake", "Unstake", "Rewards", "Activity", "Base"]) expect(header).toContain(part);
    // the wrapper holds the header and nothing else; the page follows it
    expect(html).toMatch(/<\/header><\/div><div class="col [^"]*">/);
    expect(plainText(html.slice(html.indexOf("</header>")))).toContain("What your staked TAO has earned");
  });

  it("keeps the keyboard's order: home, the four tabs, then the wallet", () => {
    const header = /<header[^>]*>([\s\S]*?)<\/header>/.exec(html)![1];
    expect([...header.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1].replace(/\/$/, "") || "/")).toEqual(["/", "/stake", "/unstake", "/rewards", "/activity"]);
    expect(header.indexOf("App sections")).toBeLessThan(header.indexOf("Base"));
  });

  it("the wrapper sticks to the top, as wide as the window (out over the page's 20px sides), with the app's background, above the page", () => {
    expect(rule(shell, ".barWrap")).toBe("position: sticky; top: 0; z-index: 20; margin: 0 -20px; padding: 0 20px; background: var(--mist);");
    // the sides it reaches over are the page's own, and its background the page's
    expect(rule(shell, ".app")).toBe("min-height: 100dvh; background: var(--mist); padding: 0 20px 64px;");
    // the bar inside keeps its width, its height and its centring: nothing of its layout changed
    expect(rule(shell, ".bar")).toBe("display: flex; align-items: center; justify-content: space-between; gap: 16px; max-width: 1240px; min-height: 100px; margin: 0 auto; padding: 0 20px;");
    // nothing between the wrapper and the window clips or scrolls, which would stop it sticking
    expect(rule(shell, ".app")).not.toMatch(/overflow/);
  });

  it("draws the hairline under it once the page has moved, the way the home page's navbar does", () => {
    const home = css("../landing/Landing.module.css");
    const edge = (sheet: string, cls: string, frames: string) =>
      new RegExp(`@supports \\(animation-timeline: scroll\\(\\)\\) \\{\\s*\\.${cls} \\{\\s*animation: ${frames} linear both;\\s*animation-timeline: scroll\\(\\);\\s*animation-range: 0 64px;\\s*\\}\\s*\\}`).test(sheet);
    expect(edge(home, "navBar", "navEdge")).toBe(true);
    expect(edge(shell, "barWrap", "barEdge")).toBe(true);
    const frames = (sheet: string, name: string) => new RegExp(`@keyframes ${name} \\{\\s*from \\{\\s*box-shadow: 0 1px 0 transparent;\\s*\\}\\s*to \\{\\s*box-shadow: 0 1px 0 var\\(--line\\);\\s*\\}\\s*\\}`).test(sheet);
    expect(frames(home, "navEdge")).toBe(true);
    expect(frames(shell, "barEdge")).toBe(true);
    // the same stacking level as the home navbar's
    expect(rule(home, ".navBar")).toContain("z-index: 20;");
  });

  it("keeps what the page scrolls to below the bar: its one row on wide screens, its two under 1000px", () => {
    expect(rule(shell, "html:has(.barWrap)")).toBe("scroll-padding-top: 108px;");
    const narrow = shell.slice(shell.indexOf("@media (max-width: 999px)"));
    expect(rule(narrow, "html:has(.barWrap)")).toBe("scroll-padding-top: 142px;");
  });

  it("leaves the wallet menu's fallback place right while scrolled: fixed just under the bar's first row, which is now always at the top", () => {
    expect(rule(shell, ".menu")).toMatch(/^position: fixed; inset: auto; .*top: 108px;/);
    const narrow = shell.slice(shell.indexOf("@media (max-width: 999px)"));
    expect(rule(narrow, ".menu")).toBe("top: 64px;");
  });
});
