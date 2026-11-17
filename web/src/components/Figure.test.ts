import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatUsd } from "@/lib/format";
import { formatApy } from "@/lib/stats";
import { Dash } from "./Dash";
import { Figure } from "./Figure";

const html = (props: { value: number | undefined; loading: boolean; format?: (n: number) => string }) =>
  renderToString(createElement(Figure, { format: formatApy, ...props }));
/** What a screen reader is given: the page without what is hidden from it. */
const spoken = (h: string) => h.replace(/<span[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g, "").replace(/<[^>]*>/g, "");
/** What is on screen: the page without the screen reader's own text. */
const seen = (h: string) => h.replace(/<span class="sr-only[^"]*">[^<]*<\/span>/g, "").replace(/<[^>]*>/g, "");
const states = (h: string) => [...h.matchAll(/data-figure="(\w+)"/g)].map((m) => m[1]);

describe("Figure: a figure read from the chain, in one of three states", () => {
  it("a value: the figure as it is formatted, on screen once and read out once", () => {
    const h = html({ value: 5.362, loading: false });
    expect(states(h)).toEqual(["value"]);
    expect(seen(h)).toBe("5.4%");
    expect(spoken(h)).toBe("5.4%");
    expect(seen(html({ value: 254.487, loading: false, format: formatUsd }))).toBe("$254.49");
  });

  it("loading with no value yet: a skeleton, read out once as Loading, and no number or dash anywhere", () => {
    const h = html({ value: undefined, loading: true });
    expect(states(h)).toEqual(["loading"]);
    expect(seen(h)).toBe("");
    expect(spoken(h)).toBe("Loading");
    // all the text there is, to anyone: no number, no dash
    expect(h.replace(/<[^>]*>/g, "")).toBe("Loading");
    // the bar itself is hidden from screen readers: they hear "Loading" once, never the bar
    expect(h).toMatch(/<span[^>]*data-figure="loading"[^>]*aria-hidden="true"[^>]*><\/span>/);
  });

  it("no value, and no read that may bring one: the dash, read out as Not available", () => {
    const h = html({ value: undefined, loading: false });
    expect(states(h)).toEqual(["none"]);
    expect(seen(h)).toBe("–");
    expect(spoken(h)).toBe("Not available");
  });

  it("is never two at once: a value shows no skeleton and no dash, whatever `loading` says (a newer reading is on its way)", () => {
    for (const loading of [true, false]) {
      const h = html({ value: 5.4, loading });
      expect(states(h)).toEqual(["value"]);
      expect(h).not.toContain("Loading");
      expect(h).not.toContain("–");
    }
    // zero is a value
    expect(seen(html({ value: 0, loading: true }))).toBe("0.0%");
  });

  it("while a value counts to a new one, screen readers get the real value, not a frame on the way: the counting node is hidden from them, its twin holds the value", () => {
    const h = html({ value: 5.4, loading: false });
    expect(h).toMatch(/<span[^>]*data-figure="value"[^>]*aria-hidden="true"[^>]*>5\.4%<\/span><span class="sr-only[^"]*">5\.4%<\/span>/);
    // the count writes only into the hidden node (count.test.ts runs it; here, that nothing else is touched)
    const source = readFileSync(fileURLToPath(new URL("./Figure.tsx", import.meta.url)), "utf8");
    expect(source.match(/\.textContent = /g)).toHaveLength(2);
    expect(source).toMatch(/<span ref=\{node\} data-figure="value" aria-hidden="true">/);
  });
});

describe("the skeleton's shimmer", () => {
  const css = readFileSync(fileURLToPath(new URL("./Figure.module.css", import.meta.url)), "utf8");

  it("moves, gently, while a figure loads", () => {
    expect(css).toMatch(/\.skeleton::after \{[^}]*animation: figure-shimmer 1\.6s ease-in-out infinite;/);
    expect(css).toContain("@keyframes figure-shimmer");
  });

  it("is removed for a visitor who asked for reduced motion: the bar stays, still", () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{\s*\.skeleton::after \{([^}]*)\}\s*\}/.exec(css);
    expect(reduced).not.toBeNull();
    expect(reduced![1]).toMatch(/animation: none;/);
    expect(reduced![1]).toMatch(/background-image: none;/);
    // the bar's own colour is outside that rule, so it is still there
    expect(css).toMatch(/\.skeleton::after \{[^}]*background-color: var\(--line\);/);
  });

  it("fills the room kept for the figure, and keeps a line of its text's height: nothing moves when the figure arrives", () => {
    expect(css).toMatch(/\.skeleton \{[^}]*width: var\(--figure-width, [\d.]+em\);/);
    expect(css).toMatch(/\.skeleton::before \{\s*content: "\\00a0";/);
    const room = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    // each place that keeps room for a figure gives its skeleton the same room
    expect(room("./landing/Landing.module.css")).toMatch(/\.statApy \{\s*min-width: 2\.9em;\s*--figure-width: 2\.9em;/);
    expect(room("./landing/Landing.module.css")).toMatch(/\.statTotal \{\s*min-width: 3\.2em;\s*--figure-width: 3\.2em;/);
    expect(room("./app/StakeForm.module.css")).toMatch(/\.price b \{[^}]*min-width: 4\.2em;\s*--figure-width: 4\.2em;/);
    for (const row of ["figApy", "figStaked", "figPrice"]) expect(room("./app/App.module.css")).toMatch(new RegExp(`\\.${row} \\{\\s*min-width: ([\\d.]+ch);\\s*--figure-width: \\1;`));
  });
});

describe("Dash: the place of a figure made of more than one number", () => {
  it("is the same skeleton while it loads, the same dash when there is none", () => {
    expect(renderToString(createElement(Dash, { loading: true }))).toBe(html({ value: undefined, loading: true }));
    expect(renderToString(createElement(Dash, { loading: false }))).toBe(html({ value: undefined, loading: false }));
  });
});
