import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { CACHE_TTL_S, handlePrice } from "../../src/api.ts";
import type { Config } from "../../src/config.ts";
import worker from "../../src/index.ts";
import { deploymentStatement, setMeta } from "../../src/store.ts";
import { countingDb, wipe } from "./d1-count.ts";
import { testConfig, testConfigV32, testVars } from "./fixtures.ts";

// GET /v1/price: the outside reference price the tick stored, for the site's outside-price check (a veto only).

const cfg = testConfig();
const db = env.DB;
const NOW = 1_800_000_000;
const CACHED = `public, max-age=${CACHE_TTL_S}`;
const ORIGIN = cfg.site.origin;
const URL_ = "https://api.test/v1/price";
const FLOW = "https://api.test/v1/flow";

const store = (v: unknown) => setMeta(db, "reference", typeof v === "string" ? v : JSON.stringify(v)).run();
const direct = (init?: RequestInit, o: { url?: string; db?: D1Database; cfg?: Config } = {}) => handlePrice(new Request(o.url ?? URL_, init), { DB: o.db ?? db }, o.cfg ?? cfg);

async function viaWorker(init?: RequestInit, o: { db?: D1Database; url?: string; vars?: Record<string, unknown> } = {}) {
  const c = countingDb(o.db ?? db);
  const vars = { ...testVars(), ...o.vars, DB: c.db, SCAN_LIMITER: env.SCAN_LIMITER } as unknown as Env;
  const ctx = createExecutionContext();
  const r = await worker.fetch(new Request(o.url ?? URL_, init), vars, ctx);
  await waitOnExecutionContext(ctx);
  return { r, queries: c.stats.queries };
}

/** A database whose every read fails. */
const fail = async () => Promise.reject(new Error("D1 down"));
const failing = { first: fail, all: fail, run: fail, raw: fail };
const broken = { prepare: () => ({ ...failing, bind: () => failing }), batch: fail } as unknown as D1Database;

beforeEach(async () => {
  await wipe(db);
  await caches.default.delete(new Request(URL_));
  await caches.default.delete(new Request(FLOW));
});

describe("GET /v1/price: what it serves", () => {
  it("serves the newest stored reading as JSON v1, with when its sources were asked", async () => {
    await store({ usd: 402.5, sources: 2, at: NOW - 120 });
    const r = await direct();
    expect([r.status, r.headers.get("Content-Type"), r.headers.get("Cache-Control"), r.headers.get("Access-Control-Allow-Origin")]).toEqual([200, "application/json", CACHED, ORIGIN]);
    // exactly these fields: no verdict, no "fresh", no limit or quote to trade at
    expect(await r.json()).toEqual({ v: 1, usd: 402.5, sources: 2, at: NOW - 120 });
  });

  it("serves one source's price with sources 1, so the site can see it was not cross-checked", async () => {
    await store({ usd: 404, sources: 1, at: NOW - 60 });
    expect(await (await direct()).json()).toEqual({ v: 1, usd: 404, sources: 1, at: NOW - 60 });
  });

  it("serves a stored unavailable reading as it is: the reason and its time, and no price", async () => {
    for (const why of ["the price sources disagree by more than 2%", "no price source answered"]) {
      await store({ unavailable: why, at: NOW - 60 });
      const r = await direct();
      expect([r.status, r.headers.get("Cache-Control"), r.headers.get("Access-Control-Allow-Origin")]).toEqual([200, CACHED, ORIGIN]);
      expect(await r.json()).toEqual({ v: 1, unavailable: why, at: NOW - 60 });
    }
  });

  it("serves an old reading with its own time: the indexer never calls it fresh, the site judges its age", async () => {
    await store({ usd: 402.5, sources: 2, at: NOW - 7200 });
    expect(await (await direct()).json()).toEqual({ v: 1, usd: 402.5, sources: 2, at: NOW - 7200 });
  });

  it("is unavailable on a cold store (no reading yet), never a 0 or a guess, with at null", async () => {
    const r = await direct();
    expect([r.status, r.headers.get("Cache-Control"), r.headers.get("Access-Control-Allow-Origin")]).toEqual([200, CACHED, ORIGIN]);
    expect(await r.json()).toEqual({ v: 1, unavailable: "no reference price has been read yet", at: null });
  });

  it("is unavailable with no price source configured, whatever is stored", async () => {
    await store({ usd: 402.5, sources: 2, at: NOW - 60 });
    const none = testConfig({ PRICE_SOURCES: "[]" });
    expect(await (await direct(undefined, { cfg: none })).json()).toEqual({ v: 1, unavailable: "no price source is configured", at: null });
  });

  it("answers 503, never cached, when the stored reading can't be read: never a 0, a NaN or a missing time", async () => {
    const bad: unknown[] = [
      "not json",
      "null",
      "[]",
      '{"usd":1e999,"sources":2,"at":1799999940}',
      { usd: 0, sources: 2, at: NOW - 60 },
      { usd: -1, sources: 2, at: NOW - 60 },
      { usd: null, sources: 2, at: NOW - 60 },
      { usd: "402.5", sources: 2, at: NOW - 60 },
      { usd: 402.5, sources: 0, at: NOW - 60 },
      { usd: 402.5, sources: 1.5, at: NOW - 60 },
      { usd: 402.5, at: NOW - 60 },
      { usd: 402.5, sources: 2 },
      { usd: 402.5, sources: 2, at: "1799999940" },
      { usd: 402.5, sources: 2, at: 0 },
      { usd: 402.5, sources: 2, at: NOW - 60, unavailable: "both" },
      { unavailable: "", at: NOW - 60 },
      { unavailable: 1, at: NOW - 60 },
      { unavailable: "no price source answered" },
      { at: NOW - 60 },
    ];
    for (const v of bad) {
      await store(v);
      const r = await direct();
      expect([r.status, r.headers.get("Cache-Control"), r.headers.get("Access-Control-Allow-Origin")], JSON.stringify(v)).toEqual([503, "no-store", ORIGIN]);
      await r.text();
    }
  });

  it("is the same for a v3-launch and a v3.2 deployment, and whatever deployment the database holds: it reads no contract", async () => {
    await store({ usd: 402.5, sources: 2, at: NOW - 60 });
    const want = { v: 1, usd: 402.5, sources: 2, at: NOW - 60 };
    expect(await (await direct()).json()).toEqual(want);
    expect(await (await direct(undefined, { cfg: testConfigV32() })).json()).toEqual(want);
    await deploymentStatement(db, { id: "another" }).run();
    expect(await (await direct()).json()).toEqual(want);
  });
});

describe("GET /v1/price: served as /v1/flow is", () => {
  it("sends the same CORS and caching headers as /v1/flow, on the answer and on the preflight", async () => {
    await store({ usd: 402.5, sources: 2, at: NOW - 60 });
    await deploymentStatement(db, cfg.deployment).run();
    const headers = (r: Response) => ["Access-Control-Allow-Origin", "Cache-Control", "Content-Type"].map((k) => r.headers.get(k));
    const price = (await viaWorker()).r;
    const flow = (await viaWorker(undefined, { url: FLOW })).r;
    expect([price.status, flow.status]).toEqual([200, 200]);
    expect(headers(price)).toEqual(headers(flow));
    expect(headers(price)).toEqual([ORIGIN, CACHED, "application/json"]);
    await Promise.all([price.text(), flow.text()]);
    const pre = (url: string) => viaWorker({ method: "OPTIONS", headers: { Origin: ORIGIN } }, { url }).then((x) => x.r);
    const [p, f] = [await pre(URL_), await pre(FLOW)];
    expect([p.status, Object.fromEntries(p.headers)]).toEqual([f.status, Object.fromEntries(f.headers)]);
    expect(Object.fromEntries(p.headers)).toMatchObject({ "access-control-allow-origin": ORIGIN, "access-control-allow-methods": "GET", "access-control-max-age": "86400" });
    expect(p.status).toBe(204);
  });

  it("refuses a POST (405) and a query string (400), with CORS for the site", async () => {
    const post = await direct({ method: "POST", body: "{}" });
    expect([post.status, post.headers.get("Allow"), post.headers.get("Access-Control-Allow-Origin")]).toEqual([405, "GET, OPTIONS", ORIGIN]);
    const q = await direct(undefined, { url: `${URL_}?x=1` });
    expect([q.status, q.headers.get("Access-Control-Allow-Origin")]).toEqual([400, ORIGIN]);
    expect((await direct(undefined, { url: `${URL_}?` })).status).toBe(400);
  });

  it("counts against the client's rate limit under its own key, and answers 429 past it", async () => {
    await store({ usd: 402.5, sources: 2, at: NOW - 60 });
    const keys: string[] = [];
    const limiter = (success: boolean) =>
      ({
        limit: async (o: { key: string }) => {
          keys.push(o.key);
          return { success };
        },
      }) as unknown as RateLimit;
    const ip = { headers: { "cf-connecting-ip": "203.0.113.5" } };
    const over = await handlePrice(new Request(URL_, ip), { DB: db, SCAN_LIMITER: limiter(false) }, cfg);
    expect([over.status, over.headers.get("Retry-After"), over.headers.get("Access-Control-Allow-Origin"), over.headers.get("Cache-Control")]).toEqual([429, "60", ORIGIN, "no-store"]);
    const under = await handlePrice(new Request(URL_, ip), { DB: db, SCAN_LIMITER: limiter(true) }, cfg);
    expect(under.status).toBe(200);
    await under.text();
    expect(keys).toEqual(["price:203.0.113.5", "price:203.0.113.5"]);
  });

  it("answers 503, never cached, when D1 fails: the next request reaches a recovered database", async () => {
    const r = await direct(undefined, { db: broken });
    expect([r.status, r.headers.get("Cache-Control"), r.headers.get("Access-Control-Allow-Origin")]).toEqual([503, "no-store", ORIGIN]);
    await r.text();
    const failed = await viaWorker(undefined, { db: broken });
    expect(failed.r.status).toBe(503);
    await failed.r.text();
    await store({ usd: 402.5, sources: 2, at: NOW - 60 });
    const ok = await viaWorker();
    expect([ok.r.status, ok.queries]).toEqual([200, 1]);
    expect(await ok.r.json()).toEqual({ v: 1, usd: 402.5, sources: 2, at: NOW - 60 });
  });

  it("is cached for CACHE_TTL_S through the Worker: a burst reaches D1 once, and a hit still carries the CORS origin", async () => {
    await store({ usd: 402.5, sources: 2, at: NOW - 60 });
    const first = await viaWorker();
    expect([first.r.status, first.queries, first.r.headers.get("Cache-Control")]).toEqual([200, 1, CACHED]);
    const body = await first.r.text();
    await store({ usd: 999, sources: 2, at: NOW });
    const hit = await viaWorker();
    expect([hit.r.status, hit.queries, hit.r.headers.get("Access-Control-Allow-Origin")]).toEqual([200, 0, ORIGIN]);
    expect(await hit.r.text()).toBe(body);
  });

  it("answers a HEAD as its GET, without the body", async () => {
    const r = await exports.default.fetch(new Request(URL_, { method: "HEAD" }));
    expect([r.status, await r.text(), r.headers.get("Cache-Control"), r.headers.get("Access-Control-Allow-Origin")]).toEqual([200, "", CACHED, ORIGIN]);
  });

  it("answers 503 with CORS for the site, never cached, when the Worker isn't configured", async () => {
    const { r } = await viaWorker(undefined, { vars: { DEPLOYMENT: "not configured" } });
    expect([r.status, r.headers.get("Access-Control-Allow-Origin"), r.headers.get("Cache-Control")]).toEqual([503, ORIGIN, "no-store"]);
    await r.text();
  });

  it("leaves every other path 404", async () => {
    for (const path of ["/v1/prices", "/v1/price/x", "/v1/pric", "/v1/price/"]) {
      const r = await exports.default.fetch(new Request(`https://api.test${path}`));
      expect(r.status, path).toBe(404);
      await r.text();
    }
  });
});
