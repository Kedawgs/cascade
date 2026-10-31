import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { build, fallbackPolicy, indexerOrigin, inlineScriptHashes, routeOf, withPageRules } from "../../scripts/csp-headers.mjs";
import { indexerOrigin as siteIndexerOrigin, RPC } from "./cascade/config";

const HEADERS = readFileSync(fileURLToPath(new URL("../../public/_headers", import.meta.url)), "utf8");
const sha = (s: string) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;
const directives = (policy: string) => new Map(policy.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));

describe("the committed headers", () => {
  const policy = directives(fallbackPolicy(HEADERS));

  it("allow no inline script until the build adds their hashes: without that step the site breaks loudly, never runs open", () => {
    expect(policy.get("script-src")).toEqual(["'self'"]);
  });

  it("keep the page out of frames, plugins and other bases and form targets", () => {
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'self'"]);
    expect(policy.get("form-action")).toEqual(["'self'"]);
    expect(policy.get("default-src")).toEqual(["'self'"]);
  });

  it("let the page connect only to itself, the site's RPCs and Base Account's wallet hosts", () => {
    const rpcs = [...new Set(Object.values(RPC).map((u) => new URL(u).origin))];
    // Base Account asks rpc.wallet.coinbase.com before it connects, and after it the RPC its popup
    // names (chain-proxy.wallet.coinbase.com), for a batch's status among others
    expect(new Set(policy.get("connect-src"))).toEqual(new Set(["'self'", ...rpcs, "https://*.wallet.coinbase.com"]));
  });

  it("set HSTS, nosniff, a referrer policy, a minimal permissions policy and no framing on every path", () => {
    expect(HEADERS).toMatch(/^\/\*$/m);
    for (const h of [
      "Strict-Transport-Security: max-age=31536000",
      "X-Content-Type-Options: nosniff",
      "X-Frame-Options: DENY",
      "Referrer-Policy: strict-origin-when-cross-origin",
      "Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    ]) {
      expect(HEADERS).toContain(`  ${h}\n`);
    }
  });

  it("hold HSTS to this host for now: other subdomains are the owner's to add once all of them serve HTTPS", () => {
    expect(HEADERS).not.toMatch(/includeSubDomains|preload/i);
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

  /** The policy a rule of `headers` gives `route`. */
  const policyOf = (headers: string, route: string) => {
    const at = headers.split("\n").findIndex((l) => l === route);
    return headers.split("\n")[at + 1].replace(/^ {2}Content-Security-Policy: /, "");
  };

  it("is the committed fallback with script-src 'self' and the page's own hashes", () => {
    const html = `<script>a()</script><script>b()</script>`;
    const out = withPageRules(HEADERS, [{ route: "/stake/", html }]);
    const fallback = fallbackPolicy(HEADERS);
    expect(policyOf(out, "/stake/")).toBe(fallback.replace("script-src 'self';", `script-src 'self' ${sha("a()")} ${sha("b()")};`));
    expect(directives(policyOf(out, "/stake/")).get("script-src")).not.toContain("'unsafe-inline'");
  });

  it("gives the fallback every page's hashes, the 404 page's too, so it allows each page's and the 404 page's inline scripts", () => {
    const pages = [
      { route: "/", html: "<script>common()</script><script>home()</script>" },
      { route: "/stake/", html: "<script>common()</script><script>stake()</script>" },
    ];
    const out = withPageRules(HEADERS, pages, ["<script>common()</script><script>notFound()</script>"]);
    expect(directives(fallbackPolicy(out)).get("script-src")).toEqual(["'self'", sha("common()"), sha("home()"), sha("stake()"), sha("notFound()")]);
    // everything else in it is the committed fallback's
    expect(fallbackPolicy(out).replace(/script-src [^;]*;/, "")).toBe(fallbackPolicy(HEADERS).replace(/script-src [^;]*;/, ""));
    // and each page's own policy narrows it to the page's
    expect(directives(policyOf(out, "/")).get("script-src")).toEqual(["'self'", sha("common()"), sha("home()")]);
  });

  it("replaces the fallback's hashes and the pages' rules when run again, never adding them twice", () => {
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

  it("lets the page connect to the indexer's origin when the build names one, exactly that origin and nothing else, on the fallback and every page", () => {
    const pages = [
      { route: "/", html: "<script>home()</script>" },
      { route: "/activity/", html: "<script>activity()</script>" },
    ];
    const indexer = "https://api.cascadefi.xyz";
    const out = withPageRules(HEADERS, pages, ["<script>notFound()</script>"], [indexer]);
    const committed = directives(fallbackPolicy(HEADERS)).get("connect-src")!;
    expect(directives(fallbackPolicy(out)).get("connect-src")).toEqual([...committed, indexer]);
    for (const { route } of pages) expect(directives(policyOf(out, route)).get("connect-src")).toEqual([...committed, indexer]);
    // nothing else about the policies changes
    const without = withPageRules(HEADERS, pages, ["<script>notFound()</script>"]);
    expect(out.replaceAll(` ${indexer}`, "")).toBe(without);
    // no wildcard, and no second copy when the step runs again on its own output
    expect(out).not.toMatch(/https:\/\/\*\.cascadefi/);
    const again = withPageRules(out, pages, ["<script>notFound()</script>"], [indexer]);
    expect(again.split(indexer)).toHaveLength(out.split(indexer).length);
    expect(again).toBe(out);
  });

  it("names no indexer when the build doesn't: the committed connect-src stands as it is", () => {
    const pages = [{ route: "/", html: "<script>home()</script>" }];
    const committed = directives(fallbackPolicy(HEADERS)).get("connect-src");
    for (const out of [withPageRules(HEADERS, pages), withPageRules(HEADERS, pages, [], [])]) {
      expect(directives(fallbackPolicy(out)).get("connect-src")).toEqual(committed);
      expect(directives(policyOf(out, "/")).get("connect-src")).toEqual(committed);
    }
  });

  it("reads the indexer's origin by the site's own rule, so the policy names exactly where the code connects", () => {
    for (const v of [
      "https://api.cascadefi.xyz",
      "https://cascade-indexer-production.dev-truthpoll.workers.dev",
      "https://localhost:8787",
      "https://api.cascadefi.xyz/",
      "https://api.cascadefi.xyz/v1",
      "http://api.cascadefi.xyz",
      "https://*.cascadefi.xyz",
      "https://API.cascadefi.xyz",
      "api.cascadefi.xyz",
      "",
      undefined,
    ]) {
      expect(indexerOrigin(v), String(v)).toBe(siteIndexerOrigin(v));
    }
  });

  /** A fake export: the committed headers, three pages and a script chunk that inlined `inlined` as
   * NEXT_PUBLIC_CASCADE_INDEXER_URL (the way next build writes config.ts's object), in a fresh folder. */
  const exported = (inlined?: string) => {
    const out = mkdtempSync(join(tmpdir(), "cascade-csp-"));
    writeFileSync(join(out, "_headers"), HEADERS);
    writeFileSync(join(out, "index.html"), "<html><script>home()</script></html>");
    mkdirSync(join(out, "activity"));
    writeFileSync(join(out, "activity", "index.html"), "<html><script>activity()</script></html>");
    writeFileSync(join(out, "404.html"), "<html><script>notFound()</script></html>");
    mkdirSync(join(out, "_next", "static", "chunks"), { recursive: true });
    const literal = inlined === undefined ? "void 0" : JSON.stringify(inlined);
    writeFileSync(join(out, "_next", "static", "chunks", "app.js"), `let e={NEXT_PUBLIC_CASCADE_VAULT:"0x1",NEXT_PUBLIC_CASCADE_INDEXER_URL:${literal}};`);
    return out;
  };

  it("builds out/_headers with exactly the indexer's origin in every connect-src when the env names one, and none when it doesn't", () => {
    const committed = directives(fallbackPolicy(HEADERS)).get("connect-src")!;
    const named = exported("https://api.cascadefi.xyz");
    build(named, { NEXT_PUBLIC_CASCADE_INDEXER_URL: "https://api.cascadefi.xyz" });
    const withIt = readFileSync(join(named, "_headers"), "utf8");
    expect(directives(fallbackPolicy(withIt)).get("connect-src")).toEqual([...committed, "https://api.cascadefi.xyz"]);
    expect(directives(policyOf(withIt, "/")).get("connect-src")).toEqual([...committed, "https://api.cascadefi.xyz"]);
    expect(directives(policyOf(withIt, "/activity/")).get("connect-src")).toEqual([...committed, "https://api.cascadefi.xyz"]);
    expect(withIt.match(/https:\/\/api\.cascadefi\.xyz/g)).toHaveLength(3);
    // the page hashes are there as before
    expect(directives(policyOf(withIt, "/activity/")).get("script-src")).toEqual(["'self'", sha("activity()")]);
    expect(directives(fallbackPolicy(withIt)).get("script-src")).toEqual(["'self'", sha("home()"), sha("activity()"), sha("notFound()")]);
    for (const [env, inlined] of [
      [{}, undefined],
      [{ NEXT_PUBLIC_CASCADE_INDEXER_URL: "" }, undefined],
      [{ NEXT_PUBLIC_CASCADE_INDEXER_URL: "https://api.cascadefi.xyz/v1" }, "https://api.cascadefi.xyz/v1"],
    ] as const) {
      const unnamed = exported(inlined);
      build(unnamed, env);
      const without = readFileSync(join(unnamed, "_headers"), "utf8");
      expect(without, JSON.stringify(env)).not.toContain("cascadefi.xyz");
      expect(directives(fallbackPolicy(without)).get("connect-src")).toEqual(committed);
      expect(directives(policyOf(without, "/")).get("connect-src")).toEqual(committed);
    }
  });

  it("reads the value next build inlined from web/.env.local the way next build does, so a value set only there still reaches the policy", () => {
    const committed = directives(fallbackPolicy(HEADERS)).get("connect-src")!;
    const dir = mkdtempSync(join(tmpdir(), "cascade-web-"));
    writeFileSync(join(dir, ".env.local"), "NEXT_PUBLIC_CASCADE_INDEXER_URL=https://api.cascadefi.xyz\n");
    const env = process.env as Record<string, string | undefined>;
    const had = env.NEXT_PUBLIC_CASCADE_INDEXER_URL;
    const nodeEnv = env.NODE_ENV;
    delete env.NEXT_PUBLIC_CASCADE_INDEXER_URL;
    // as under `next build`: Next reads .env.local for a production build (and never under NODE_ENV=test)
    env.NODE_ENV = "production";
    try {
      const out = exported("https://api.cascadefi.xyz");
      expect(build(out, undefined, dir).indexer).toBe("https://api.cascadefi.xyz");
      expect(directives(policyOf(readFileSync(join(out, "_headers"), "utf8"), "/activity/")).get("connect-src")).toEqual([...committed, "https://api.cascadefi.xyz"]);
      // (a value the process starts with wins over the file, as it does for next build: @next/env keeps
      // the environment it first saw, which a test in one process can't change)
    } finally {
      env.NODE_ENV = nodeEnv;
      delete env.NEXT_PUBLIC_CASCADE_INDEXER_URL;
      if (had !== undefined) env.NEXT_PUBLIC_CASCADE_INDEXER_URL = had;
    }
  });

  it("fails the build when the exported scripts inlined another indexer URL than the policy would allow, or none", () => {
    expect(() => build(exported("https://other.example"), { NEXT_PUBLIC_CASCADE_INDEXER_URL: "https://api.cascadefi.xyz" })).toThrow(/inlined/);
    expect(() => build(exported(), { NEXT_PUBLIC_CASCADE_INDEXER_URL: "https://api.cascadefi.xyz" })).toThrow(/inlined/);
    expect(() => build(exported("https://api.cascadefi.xyz"), {})).toThrow(/inlined/);
    expect(indexerOrigin("https://other.example")).toBe("https://other.example");
  });

  it("fails the build when the committed fallback's script-src is anything but 'self'", () => {
    expect(() => withPageRules(HEADERS.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';"), [{ route: "/", html: "" }])).toThrow(/script-src/);
    expect(() => withPageRules(HEADERS.replace("script-src 'self';", ""), [{ route: "/", html: "" }])).toThrow(/script-src/);
    expect(() => fallbackPolicy("/*\n  X-Frame-Options: DENY\n")).toThrow(/Content-Security-Policy/);
  });
});
