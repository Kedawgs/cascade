import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ruleCtx } from "./rule-ctx.ts";
import { siteIntegrity, siteNoApprovedLists, siteUnreachable } from "../../src/rules/site.ts";
import { ADDRESS_RE, readCapped, scanScript } from "../../src/site.ts";
import { MAX_FILES, runSiteJob, type SiteJobOptions, siteRunMaxS } from "../../src/site-job.ts";
import { RUNBOOK } from "../../src/runbook.ts";
import { loadTickState } from "../../src/store.ts";
import { rowCounts, wipe } from "./d1-count.ts";
import { testConfig } from "./fixtures.ts";

const db = env.DB;
const NOW = 1_800_000_000;
// the fixture site's two pages (wrangler.jsonc lists all 8 of the real site's: see the last tests)
const cfg = testConfig({ SITE_FILES_PER_RUN: "2", SITE_PAGES: ["/", "/stake/"] });
const d = cfg.deployment;
const OURS = [d.frontDoor, d.staker, d.vault, d.baseAdapter, d.bitAdapter, d.oracle];
// a gateway host merely named in the bundle (as a dependency's chunks name arweave.net) is seen, not a script source
const APPROVED = { addresses: [...new Set(OURS)].sort(), scriptHosts: [] as string[], bundleHosts: ["arweave.net", "mainnet.base.org", "rpc.example.org"] };
const HASH = `0x${"ab".repeat(32)}`;
const chunk = (name: string) => `/_next/static/chunks/${name}.js`;

/** The fixture site: two pages, six scripts (one named only inside another), every Cascade address and
 * the approved hosts. */
function site(over: Record<string, string> = {}): Record<string, string> {
  return {
    "/": `<html><script>self.fd="${d.frontDoor}"</script><script src="${chunk("main")}"></script><script src="${chunk("app")}"></script></html>`,
    "/stake/": `<html><script src="${chunk("main")}"></script><script src="${chunk("stake")}"></script></html>`,
    [chunk("main")]: `const v="${d.vault}",s="${d.staker}",u="https://mainnet.base.org";import("${chunk("lazy")}")`,
    [chunk("app")]: `const a="${d.baseAdapter}",b="${d.bitAdapter}"`,
    [chunk("stake")]: `const o="${d.oracle}",hash="${HASH}";load("${chunk("vendor")}")`,
    [chunk("lazy")]: `fetch("https://rpc.example.org");load("${chunk("lazy2")}")`,
    [chunk("vendor")]: "const x=1",
    [chunk("lazy2")]: "const y=2",
    ...over,
  };
}

/** A fetch serving the site; a `{ bytes }` entry is a stream of that many bytes, counting what is read. */
function server(files: Record<string, string | { bytes: number }>) {
  const read = { bytes: 0 };
  const calls: string[] = [];
  const f = async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    const body = files[path];
    if (body === undefined) return new Response("not found", { status: 404 });
    if (typeof body === "string") return new Response(body);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= body.bytes) return c.close();
        const n = Math.min(65_536, body.bytes - sent);
        sent += n;
        read.bytes += n;
        c.enqueue(new Uint8Array(n).fill(0x61));
      },
    });
    return new Response(stream);
  };
  return { fetch: f as typeof fetch, read, calls };
}

const job = (s: ReturnType<typeof server>, nowS: number, o: Partial<SiteJobOptions> = {}) => runSiteJob({ db, cfg, fetch: s.fetch, nowS, approved: APPROVED, ...o });
const findings = async (nowS: number) => {
  const st = await loadTickState(db, nowS);
  return [siteIntegrity, siteUnreachable, siteNoApprovedLists].flatMap((r) => r.run(ruleCtx({ meta: st.meta, nowS })));
};
async function fullPass(s: ReturnType<typeof server>, from = NOW) {
  for (let i = 0; i < 3; i++) await job(s, from + i * 120);
}

beforeEach(async () => {
  await wipe(db);
});

describe("the address and host scan", () => {
  it("matches 40-hex addresses with hex boundaries, never inside a 64-hex hash", () => {
    expect(`a ${d.vault} ${HASH} 0x${"1".repeat(41)}`.match(ADDRESS_RE)).toEqual([d.vault]);
    const s = scanScript(`x="${d.vault.toUpperCase().replace("0X", "0x")}";u="https://Mainnet.Base.org/x";import("/_next/static/chunks/abc-123.js")`);
    expect(s).toEqual({ addresses: [d.vault], hosts: ["mainnet.base.org"], chunks: ["/_next/static/chunks/abc-123.js"] });
  });

  it("finds hosts behind http://, wss:// and protocol-relative //host, but not in a // comment", () => {
    const text = `a="http://plain.example/x";b="wss://sock.example";c="//relative.example/y.js";d=url(//css.example/f.woff)// a comment//not.a.host`;
    expect(scanScript(text).hosts).toEqual(["css.example", "plain.example", "relative.example", "sock.example"]);
  });

  it("reads a body as a stream and stops at the cap, never buffering more", async () => {
    const s = server({ "/big.js": { bytes: 3_000_000 } });
    const r = await readCapped(await s.fetch("https://cascadefi.xyz/big.js"), 2_000_000);
    expect(r).toEqual({ tooLarge: true });
    expect(s.read.bytes).toBeLessThanOrEqual(2_000_000 + 65_536);
    expect(await readCapped(new Response("small"), 10)).toEqual({ text: "small" });
  });
});

describe("the site job", () => {
  it("finds nothing on a site holding exactly the approved addresses and hosts, after a pass of 6 files at 2 a run", async () => {
    const s = server(site());
    await job(s, NOW);
    await job(s, NOW + 120);
    expect((await loadTickState(db, NOW)).meta.site_result).toBeUndefined();
    await job(s, NOW + 240);
    const result = JSON.parse((await loadTickState(db, NOW)).meta.site_result);
    expect(result.complete).toBe(true);
    expect(result.files).toHaveLength(6);
    // the lazy chunks named only inside other chunks were fetched
    expect(result.files).toEqual(expect.arrayContaining([chunk("lazy"), chunk("lazy2"), chunk("vendor")]));
    expect(await findings(NOW + 300)).toEqual([]);
    // it never touched the lease (nor could it send email: it has no binding)
    expect((await rowCounts(db)).lease).toBe(0);
  });

  it("raises site.integrity for an extra address, naming it and its file; a new host; a Cascade address missing", async () => {
    const extra = "0x00000000000000000000000000000000000000e6";
    await fullPass(server(site({ [chunk("app")]: `const a="${d.baseAdapter}",b="${d.bitAdapter}",e="${extra}"` })));
    const f1 = await findings(NOW + 300);
    expect(f1.map((f) => f.key)).toEqual([`site.integrity:address:${extra}`]);
    expect(f1[0].facts.file).toBe(chunk("app"));
    await wipe(db);
    await fullPass(server(site({ [chunk("lazy")]: `fetch("https://evil-rpc.example.com");load("${chunk("lazy2")}")` })));
    expect((await findings(NOW + 300)).map((f) => f.key)).toEqual(["site.integrity:host:evil-rpc.example.com"]);
    await wipe(db);
    await fullPass(server(site({ "/": `<html><script src="${chunk("main")}"></script><script src="${chunk("app")}"></script></html>` })));
    expect((await findings(NOW + 300)).map((f) => f.key)).toEqual([`site.integrity:missing:${d.frontDoor}`]);
  });

  it("reports a file over the byte cap without scanning it", async () => {
    const s = server({ ...site(), [chunk("vendor")]: { bytes: 3_000_000 } });
    await fullPass(s);
    const f = await findings(NOW + 300);
    expect(f.map((x) => x.key)).toEqual([`site.integrity:file:${chunk("vendor")}`]);
    expect(f[0].facts.why).toContain("byte cap");
    expect(s.read.bytes).toBeLessThanOrEqual(2_000_000 + 65_536);
  });

  it("skips a file whose scan stopped an invocation, reports it, and completes the pass", async () => {
    const s = server(site());
    const boom: SiteJobOptions["scanText"] = (text) => {
      if (text.includes("const x=1")) throw new Error("killed");
      return scanScript(text);
    };
    await job(s, NOW);
    await job(s, NOW + 120);
    // the third run dies on vendor.js after marking it
    await expect(job(s, NOW + 240, { scanText: boom })).rejects.toThrow("killed");
    expect(JSON.parse((await loadTickState(db, NOW)).meta.site_trying).file).toBe(chunk("vendor"));
    // a run two minutes later may be meeting a sibling that is still working: it does nothing
    expect(await job(s, NOW + 360)).toEqual({ skipped: "another run is working" });
    // past the time a run can take, the mark is a dead run's: the file is skipped and reported
    await job(s, NOW + 600);
    await job(s, NOW + 720);
    const result = JSON.parse((await loadTickState(db, NOW)).meta.site_result);
    expect(result.files).not.toContain(chunk("vendor"));
    const f = await findings(NOW + 800);
    expect(f.map((x) => x.key)).toEqual([`site.integrity:file:${chunk("vendor")}`]);
    expect(f[0].facts.why).toContain("stopped");
  });

  it("reports a site with more script files than a pass may take as a critical, and the pass incomplete", async () => {
    // the real build has 32 scripts; MAX_FILES is far above that, so a padded site stands out
    expect(MAX_FILES).toBeGreaterThanOrEqual(10 * 32);
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [chunk(`c${i}`), "const z=0"]));
    const index = `<html><script>a="${OURS.join('","')}"</script>${Object.keys(many).map((p) => `<script src="${p}"></script>`).join("")}</html>`;
    const s = server({ "/": index, "/stake/": "<html></html>", ...many });
    const big = { ...cfg, budgets: { ...cfg.budgets, siteFilesPerRun: 80 } };
    await runSiteJob({ db, cfg: big, fetch: s.fetch, nowS: NOW, approved: APPROVED, maxFiles: 10 });
    const result = JSON.parse((await loadTickState(db, NOW)).meta.site_result);
    expect(result.files).toHaveLength(10);
    expect(result.capped).toBe(true);
    expect(result.complete).toBe(false);
    const f = await findings(NOW + 60);
    expect(f.map((x) => [x.rule, x.key])).toEqual([["site.integrity", "site.integrity:capped"]]);
  });

  it("scans the whole page: addresses and hosts in attributes, any same-origin script, and a cross-origin script's host", async () => {
    const extra = "0x00000000000000000000000000000000000000e6";
    const page = site()["/"].replace(
      "</html>",
      `<a href="https://basescan.org/address/${extra}">x</a><script src="/cdn-cgi/evil.js"></script><script src="https://cdn.evil.example/x.js"></script><link rel="modulepreload" href="//preload.evil.example/m.js"><link rel="preload" as="script" href="https://preload2.evil.example/p.js"></html>`,
    );
    const s = server(site({ "/": page, "/cdn-cgi/evil.js": `const e="${d.vault}";fetch("wss://sock.evil.example/x")` }));
    for (let i = 0; i < 4; i++) await job(s, NOW + i * 120);
    expect(s.calls).toContain("/cdn-cgi/evil.js");
    // never fetched from elsewhere: only reported
    expect(s.calls.some((c) => c === "/x.js" || c === "/m.js")).toBe(false);
    const f = await findings(NOW + 600);
    // a host a page loads a script from is reported once, as a script host (not again as a host it names)
    expect(f.map((x) => x.key).sort()).toEqual(
      [
        `site.integrity:address:${extra}`,
        "site.integrity:host:basescan.org",
        "site.integrity:script_host:cdn.evil.example",
        "site.integrity:script_host:preload.evil.example",
        "site.integrity:script_host:preload2.evil.example",
        "site.integrity:host:sock.evil.example",
      ].sort(),
    );
    const cdn = f.find((x) => x.key === "site.integrity:script_host:cdn.evil.example");
    expect([cdn?.subject, cdn?.facts["script host"], cdn?.facts.file]).toEqual(["The live site loads a script from a host the build doesn't", "cdn.evil.example", "/"]);
  });

  it("never approves a script source by a mere mention: a page loading a script from a host the bundle only names is a critical", async () => {
    // arweave.net is seen in the bundle (a dependency names it): naming it is fine, loading a script from it is not
    const named = site({ [chunk("vendor")]: 'const x=1,gw="https://arweave.net/"' });
    await fullPass(server(named));
    expect(await findings(NOW + 300)).toEqual([]);
    await wipe(db);
    const page = named["/"].replace("</html>", '<script src="https://arweave.net/tx/evil.js"></script></html>');
    await fullPass(server({ ...named, "/": page }));
    expect((await findings(NOW + 300)).map((x) => x.key)).toEqual(["site.integrity:script_host:arweave.net"]);
    // approved as a script source (the build loads one from it, or its script-src names it): nothing to report,
    // a wildcard from a script-src included
    for (const [scriptHosts, p] of [
      [["arweave.net"], page],
      [["*.arweave.net"], page.replace("https://arweave.net/", "https://gw.arweave.net/")],
    ] as const) {
      await wipe(db);
      for (let i = 0; i < 3; i++) await job(server({ ...named, "/": p }), NOW + i * 120, { approved: { ...APPROVED, scriptHosts } });
      expect(await findings(NOW + 300), scriptHosts[0]).toEqual([]);
    }
  });

  it('follows any same-origin "/….js" a script names: a dynamic import(), new Worker, serviceWorker.register', async () => {
    expect(scanScript(`import("/assets/a.js");new Worker('/w/worker.mjs');navigator.serviceWorker.register(\`/sw.js\`);x="//cdn.example/no.js";y="/not-a-script.json"`).chunks).toEqual([
      "/assets/a.js",
      "/sw.js",
      "/w/worker.mjs",
    ]);
    const evil = "0x00000000000000000000000000000000000000e6";
    const s = server(site({ [chunk("lazy2")]: 'const y=2;navigator.serviceWorker.register("/sw.js")', "/sw.js": `const e="${evil}"` }));
    for (let i = 0; i < 4; i++) await job(s, NOW + i * 120);
    expect(s.calls).toContain("/sw.js");
    expect((await findings(NOW + 600)).map((f) => f.key)).toEqual([`site.integrity:address:${evil}`]);
  });

  it("labels a script whose source is a data: or blob: URL as such", async () => {
    const page = site()["/"].replace("</html>", '<script src="data:text/javascript,alert(1)"></script><script src="blob:null/1234"></script></html>');
    await fullPass(server(site({ "/": page })));
    const f = await findings(NOW + 300);
    expect(f.map((x) => x.key).sort()).toEqual(["site.integrity:script:blob: URL", "site.integrity:script:data: URL"]);
    expect(f[0].subject).toBe("The live site loads a script from a data: or blob: URL");
  });

  it("says in its runbook line what it can't see, and what a killed run points to", () => {
    const line = RUNBOOK["site.integrity"]({});
    expect(line).toContain("string concatenation");
    expect(line).toContain("clean copy");
    expect(line).toContain("--extra-hosts");
    expect(line).toMatch(/stopped a run.*CPU.*not the byte cap/);
  });

  it("follows turbopack's chunk names (static/chunks/… without /_next/)", async () => {
    const s = server(site({ [chunk("lazy2")]: 'const y=2;load("static/chunks/turbo-1.js")', [chunk("turbo-1")]: "const t=3" }));
    for (let i = 0; i < 4; i++) await job(s, NOW + i * 120);
    expect(s.calls).toContain(chunk("turbo-1"));
  });

  it("with no approved lists judges nothing on them, and says so once", async () => {
    await fullPass(server(site()));
    const st = await loadTickState(db, NOW + 300);
    const ctx = ruleCtx({ meta: st.meta, nowS: NOW + 300 });
    expect(siteIntegrity.run(ctx)).toHaveLength(0);
    await wipe(db);
    for (let i = 0; i < 3; i++) await job(server(site()), NOW + i * 120, { approved: { addresses: [], scriptHosts: [], bundleHosts: [] } });
    expect((await findings(NOW + 300)).map((f) => [f.rule, f.key])).toEqual([["site.no_approved_lists", "site.no_approved_lists"]]);
  });

  it("warns when a pass completes with files it couldn't read", async () => {
    const files = site();
    delete files[chunk("vendor")];
    await fullPass(server(files));
    expect((await findings(NOW + 300)).map((f) => [f.rule, f.key])).toEqual([["site.unreachable", "site.unreachable:files"]]);
  });

  it("times a run from the files it may take: a sibling with more files per run is waited for longer", () => {
    expect(siteRunMaxS({ ...cfg.site, pages: ["/", "/stake/"] }, 2)).toBe((2 + 2) * 15 + 120);
    expect(siteRunMaxS(cfg.site, 20)).toBeGreaterThan(siteRunMaxS(cfg.site, 2));
  });

  it("starts a new pass only an hour after the last finished", async () => {
    const s = server(site());
    await fullPass(s);
    const calls = s.calls.length;
    await job(s, NOW + 600);
    expect(s.calls.length).toBe(calls);
    await job(s, NOW + 240 + 3600);
    expect(s.calls.length).toBeGreaterThan(calls);
  });

  it("goes on past a page it can't read: the other pages are still judged, and that page is named", async () => {
    const extra = "0x00000000000000000000000000000000000000e6";
    const files = site({ "/": site()["/"].replace("</html>", `<script>e="${extra}"</script></html>`) });
    delete files["/stake/"];
    await fullPass(server(files));
    const f = await findings(NOW + 300);
    expect(f.map((x) => [x.rule, x.key]).sort()).toEqual([
      ["site.integrity", `site.integrity:address:${extra}`],
      ["site.unreachable", "site.unreachable:files"],
    ]);
    expect(f.find((x) => x.rule === "site.unreachable")?.facts.files).toBe("/stake/ (HTTP 404)");
  });

  it("reads every page in a pass's first run, and checks a build the real site's size (8 pages, 32 scripts) in one pass of two runs", async () => {
    // wrangler.jsonc's own settings: every page of the site, 20 files a run
    const real = testConfig();
    expect([real.site.pages.length, real.budgets.siteFilesPerRun]).toEqual([8, 20]);
    const scripts = Array.from({ length: 32 }, (_, i) => chunk(`c${i}`));
    const pages = Object.fromEntries(
      real.site.pages.map((p, i) => [p, `<html><script>a="${OURS.join('","')}"</script>${scripts.slice(i * 4, i * 4 + 4).map((x) => `<script src="${x}"></script>`).join("")}</html>`]),
    );
    const s = server({ ...pages, ...Object.fromEntries(scripts.map((x) => [x, "const z=0"])) });
    const run = (nowS: number) => runSiteJob({ db, cfg: real, fetch: s.fetch, nowS, approved: APPROVED });
    expect(await run(NOW)).toEqual({ checked: 20, finished: false });
    expect(s.calls.slice(0, 8)).toEqual(real.site.pages);
    expect(await run(NOW + 120)).toEqual({ checked: 12, finished: true });
    const result = JSON.parse((await loadTickState(db, NOW)).meta.site_result);
    expect([result.complete, result.files.length]).toEqual([true, 32]);
    expect(await findings(NOW + 180)).toEqual([]);
  });

  it("says site.unreachable after 30 minutes without a successful fetch", async () => {
    const down = server({});
    await job(down, NOW);
    expect(await findings(NOW + 29 * 60)).toEqual([]);
    expect((await findings(NOW + 31 * 60)).map((f) => f.rule)).toEqual(["site.unreachable"]);
    await fullPass(server(site()), NOW + 32 * 60);
    expect((await findings(NOW + 40 * 60)).map((f) => f.rule)).toEqual([]);
  });
});
