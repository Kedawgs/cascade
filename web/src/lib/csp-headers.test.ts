import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fallbackPolicy, inlineScriptHashes, routeOf, withPageRules } from "../../scripts/csp-headers.mjs";
import { RPC } from "./cascade/config";

const HEADERS = readFileSync(fileURLToPath(new URL("../../public/_headers", import.meta.url)), "utf8");
const sha = (s: string) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;
const directives = (policy: string) => new Map(policy.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));

describe("the committed headers", () => {
  const policy = directives(fallbackPolicy(HEADERS));

  it("keep the page out of frames, plugins and other bases and form targets", () => {
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'self'"]);
    expect(policy.get("form-action")).toEqual(["'self'"]);
    expect(policy.get("default-src")).toEqual(["'self'"]);
  });

  it("let the page connect only to itself, the site's RPCs and Base Account's call-status endpoint", () => {
    const rpcs = [...new Set(Object.values(RPC).map((u) => new URL(u).origin))];
    expect(new Set(policy.get("connect-src"))).toEqual(new Set(["'self'", ...rpcs, "https://rpc.wallet.coinbase.com"]));
  });

  it("set HSTS, nosniff, a referrer policy, a minimal permissions policy and no framing on every path", () => {
    expect(HEADERS).toMatch(/^\/\*$/m);
    for (const h of [
      "Strict-Transport-Security: max-age=31536000; includeSubDomains",
      "X-Content-Type-Options: nosniff",
      "X-Frame-Options: DENY",
      "Referrer-Policy: strict-origin-when-cross-origin",
      "Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    ]) {
      expect(HEADERS).toContain(`  ${h}\n`);
    }
  });
});

describe("each page's own policy", () => {
  it("hashes exactly the page's inline scripts that run, not ones with a src or that are data", () => {
    const html = [
      `<script src="/_next/static/chunks/a.js" async=""></script>`,
      `<script id="_R_">(globalThis.TURBOPACK||[]).push(1)</script>`,
      `<script>self.__next_f.push([1,"é \\u003c"])</script>`,
      `<script type="module">import("/x.js")</script>`,
      `<script type="application/json">{"a":1}</script>`,
      `<script>self.__next_f.push([1,"é \\u003c"])</script>`,
    ].join("");
    expect(inlineScriptHashes(html)).toEqual([
      sha(`(globalThis.TURBOPACK||[]).push(1)`),
      sha(`self.__next_f.push([1,"é \\u003c"])`),
      sha(`import("/x.js")`),
    ]);
  });

  it("puts each page under the path Cloudflare serves it at, and leaves the 404 page to the fallback", () => {
    expect(routeOf("index.html")).toBe("/");
    expect(routeOf("stake/index.html")).toBe("/stake/");
    expect(routeOf("activity/index.html")).toBe("/activity/");
    for (const f of ["404.html", "404/index.html", "_not-found/index.html", "index.txt"]) expect(routeOf(f)).toBeNull();
  });

  it("is the fallback with script-src narrowed to 'self' and the page's hashes", () => {
    const html = `<script>a()</script><script>b()</script>`;
    const out = withPageRules(HEADERS, [{ route: "/stake/", html }]);
    const rule = out.slice(out.lastIndexOf("/stake/\n"));
    const own = rule.split("\n")[1].replace(/^ {2}Content-Security-Policy: /, "");
    const fallback = fallbackPolicy(HEADERS);
    expect(own).toBe(fallback.replace("script-src 'self' 'unsafe-inline'", `script-src 'self' ${sha("a()")} ${sha("b()")}`));
    expect(directives(own).get("script-src")).not.toContain("'unsafe-inline'");
    // the committed headers come first, unchanged
    expect(out.startsWith(HEADERS.trimEnd())).toBe(true);
  });

  it("replaces the pages' rules when run again, never adding them twice", () => {
    const once = withPageRules(HEADERS, [{ route: "/", html: "<script>a()</script>" }]);
    const twice = withPageRules(once, [{ route: "/", html: "<script>b()</script>" }]);
    expect(twice.match(/^\/$/gm)).toHaveLength(1);
    expect(twice).toContain(sha("b()"));
    expect(twice).not.toContain(sha("a()"));
  });

  it("fails the build rather than write a line or a rule count Cloudflare would refuse", () => {
    const many = Array.from({ length: 40 }, (_, i) => `<script>f(${i})</script>`).join("");
    expect(() => withPageRules(HEADERS, [{ route: "/", html: many }])).toThrow(/2,000/);
    const pages = Array.from({ length: 100 }, (_, i) => ({ route: `/p${i}/`, html: "<script>a()</script>" }));
    expect(() => withPageRules(HEADERS, pages)).toThrow(/100/);
  });

  it("fails the build when the fallback policy has no inline script-src to narrow", () => {
    expect(() => withPageRules(HEADERS.replace("script-src 'self' 'unsafe-inline'", "script-src 'self'"), [{ route: "/", html: "" }])).toThrow(
      /script-src/,
    );
    expect(() => fallbackPolicy("/*\n  X-Frame-Options: DENY\n")).toThrow(/Content-Security-Policy/);
  });
});
