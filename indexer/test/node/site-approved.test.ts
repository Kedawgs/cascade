import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approvedLists, cspFor, headerRules, main, readHeaders, readOut, renderApproved, scriptSrcHosts } from "../../scripts/site-approved.ts";
import { APPROVED_CSP } from "../../src/site-approved.ts";
import { pkg, readJsonc } from "./files.ts";

const A = "0x8A825738D0287D0959957A0f6ec18bA1276d209d";
const B = "0x44CeaCE0b097D9d5eF01e08b12029Ad2762cbDC6";
const POLICY = "default-src 'self'; script-src 'self' 'sha256-abc='; connect-src 'self' https://mainnet.base.org";

function fixtureOut(): string {
  const dir = mkdtempSync(join(tmpdir(), "cascade-out-"));
  mkdirSync(join(dir, "_next", "static", "chunks"), { recursive: true });
  mkdirSync(join(dir, "stake"));
  // a cross-origin script the page really loads, and a host only linked to
  writeFileSync(join(dir, "index.html"), `<script>a="${A}"</script><script src="https://cdn.example.com/a.js"></script><a href="https://basescan.org/x">x</a>`);
  writeFileSync(join(dir, "stake", "index.html"), `<script>b="${B}"</script>`);
  // a gateway host a dependency merely names (as viem's and the wallet SDK's chunks do): seen, never a script source
  writeFileSync(join(dir, "_next", "static", "chunks", "main.js"), `x="${A.toLowerCase()}";u="https://mainnet.base.org";g="https://arweave.net/";h="0x${"ab".repeat(32)}"`);
  writeFileSync(join(dir, "_next", "static", "chunks", "skip.css"), `u="https://not-scanned.example.com"`);
  writeFileSync(join(dir, "404.html"), "<p>not found</p>");
  writeFileSync(
    join(dir, "_headers"),
    `# a comment: https://not-a-rule.example.com\n/*\n  Content-Security-Policy: ${POLICY}\n  X-Frame-Options: DENY\n\n/stake/\n  Content-Security-Policy: ${STAKE}\n`,
  );
  return dir;
}
const STAKE = "default-src 'self'; script-src 'self' 'sha256-stake='";

const lists = (dir: string) => approvedLists(readOut(dir), readHeaders(dir));

describe("pnpm site:approved", () => {
  it("lists every address in the export's HTML and JavaScript, lowercased, deduplicated and sorted", () => {
    const l = lists(fixtureOut());
    expect(l.addresses).toEqual([B.toLowerCase(), A.toLowerCase()].sort());
    expect(l.largest.bytes).toBeGreaterThan(0);
  });

  it("approves as a script source only a host the pages load a script from; every host the text names is only seen", () => {
    const l = lists(fixtureOut());
    expect(l.scriptHosts).toEqual(["cdn.example.com"]);
    expect(l.bundleHosts).toEqual(["arweave.net", "basescan.org", "cdn.example.com", "mainnet.base.org"]);
  });

  it("approves as a script source a host in a script-src of out/_headers (default-src where there is none)", () => {
    expect(scriptSrcHosts("default-src 'self'; script-src 'self' 'sha256-x=' https://cdn.one.example/lib/ *.two.example:443 https: 'strict-dynamic'")).toEqual([
      "*.two.example",
      "cdn.one.example",
    ]);
    expect(scriptSrcHosts("default-src https://only.example; connect-src https://rpc.example")).toEqual(["only.example"]);
    expect(scriptSrcHosts(POLICY)).toEqual([]);
    const dir = fixtureOut();
    writeFileSync(join(dir, "_headers"), `/*\n  Content-Security-Policy: ${POLICY.replace("script-src 'self'", "script-src 'self' https://cdn.csp.example")}\n`);
    expect(lists(dir).scriptHosts).toEqual(["cdn.csp.example", "cdn.example.com"]);
  });

  it("records each page's Content-Security-Policy: every policy of every _headers rule matching its path, in order", () => {
    expect(lists(fixtureOut()).csp).toEqual({ "/": [POLICY], "/stake/": [POLICY, STAKE] });
    const rules = headerRules(
      [
        "/*",
        `  Content-Security-Policy: ${POLICY}`,
        "/faq/*",
        "  ! Content-Security-Policy",
        "/faq/:part/",
        `  content-security-policy:   ${STAKE};  `,
        "/x.html",
        "  Content-Security-Policy: default-src 'none'",
      ].join("\n"),
    );
    expect(cspFor(rules, "/")).toEqual([POLICY]);
    // a detached header drops what earlier rules set; a placeholder matches one segment
    expect(cspFor(rules, "/faq/")).toEqual([]);
    expect(cspFor(rules, "/faq/a/")).toEqual([STAKE]);
    expect(cspFor(rules, "/faq/a/b/")).toEqual([]);
    // a dot in a pattern is a dot
    expect(cspFor(rules, "/xahtml")).toEqual([POLICY]);
  });

  it("refuses an export without _headers, a page without a policy, or a rule for another host", async () => {
    const target = (dir: string) => join(dir, "site-approved.ts");
    const lines: string[] = [];
    const run = (dir: string) => main([dir], { target: target(dir), print: (l) => lines.push(l), today: () => "x" });
    const none = fixtureOut();
    rmSync(join(none, "_headers"));
    expect(await run(none)).toBe(2);
    expect(lines.pop()).toContain("no _headers");
    const bare = fixtureOut();
    writeFileSync(join(bare, "_headers"), `/stake/\n  Content-Security-Policy: ${STAKE}\n`);
    expect(await run(bare)).toBe(2);
    expect(lines.pop()).toContain("no Content-Security-Policy for /");
    const host = fixtureOut();
    writeFileSync(join(host, "_headers"), `/*\n  Content-Security-Policy: ${POLICY}\nhttps://other.example/*\n  X-Robots-Tag: noindex\n`);
    expect(await run(host)).toBe(2);
    expect(lines.pop()).toContain("https://other.example/*");
  });

  it("writes src/site-approved.ts with the lists and the build date", async () => {
    const dir = fixtureOut();
    const target = join(dir, "site-approved.ts");
    const lines: string[] = [];
    expect(await main([dir], { target, print: (l) => lines.push(l), today: () => "2027-01-15" })).toBe(0);
    const text = readFileSync(target, "utf8");
    expect(text).toContain("built 2027-01-15");
    expect(text).toContain(`"${A.toLowerCase()}"`);
    expect(text).toContain('APPROVED_SCRIPT_HOSTS: readonly string[] = [\n  "cdn.example.com",\n];');
    expect(text).toContain('SEEN_IN_BUNDLE_HOSTS: readonly string[] = [\n  "arweave.net",\n  "basescan.org",\n  "cdn.example.com",\n  "mainnet.base.org",\n];');
    expect(text).toContain(`APPROVED_CSP: Readonly<Record<string, readonly string[]>> = {\n  "/": [\n    ${JSON.stringify(POLICY)},\n  ],\n  "/stake/": [`);
    expect(text).toBe(renderApproved(lists(dir), "2027-01-15"));
    expect(lines.join("\n")).toContain("largest file");
    expect(await main([], { target, print: () => undefined, today: () => "x" })).toBe(2);
  });

  it("adds hosts approved by hand, a mention (--extra-hosts) or a script source (--extra-script-hosts), named in the file", async () => {
    const dir = fixtureOut();
    const target = join(dir, "site-approved.ts");
    const print = () => undefined;
    expect(
      await main([dir, "--extra-hosts", "Mentioned.Example.com,mainnet.base.org", "--extra-script-hosts", "static.cloudflareinsights.com"], { target, print, today: () => "2027-01-15" }),
    ).toBe(0);
    const text = readFileSync(target, "utf8");
    expect(text).toContain("// Added by hand (--extra-hosts): mentioned.example.com, mainnet.base.org");
    expect(text).toContain("// Added by hand (--extra-script-hosts): static.cloudflareinsights.com");
    expect(text).toContain('APPROVED_SCRIPT_HOSTS: readonly string[] = [\n  "cdn.example.com",\n  "static.cloudflareinsights.com",\n];');
    expect(text).toContain('SEEN_IN_BUNDLE_HOSTS: readonly string[] = [\n  "arweave.net",\n  "basescan.org",\n  "cdn.example.com",\n  "mainnet.base.org",\n  "mentioned.example.com",\n];');
    // a host must be a host: no scheme, path or wildcard
    for (const flag of ["--extra-hosts", "--extra-script-hosts"]) {
      expect(await main([dir, flag, "https://x.example/y"], { target, print, today: () => "x" })).toBe(2);
      expect(await main([dir, flag, "*.example.com"], { target, print, today: () => "x" })).toBe(2);
      expect(await main([dir, flag], { target, print, today: () => "x" })).toBe(2);
    }
  });
});

describe("src/site-approved.ts", () => {
  it("has an approved Content-Security-Policy for every page each environment checks (else every pass reports it)", () => {
    const env = (readJsonc(pkg("wrangler.jsonc")) as { env: Record<string, { vars: { SITE_PAGES: string[] } }> }).env;
    for (const name of ["production", "test"]) for (const page of env[name].vars.SITE_PAGES) expect(APPROVED_CSP[page]?.length, `${name} ${page}`).toBeGreaterThan(0);
  });
});
