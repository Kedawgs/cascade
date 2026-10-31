import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { type Hex, keccak256, toBytes } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { CACHE_TTL_S, handleHealth, handleStatus } from "../../src/api.ts";
import worker from "../../src/index.ts";
import { deploymentStatement, insertHold, setCursor, setMeta, upsertBatchCheck } from "../../src/store.ts";
import { DEFAULTS } from "../../src/thresholds.ts";
import { countingDb, rowCounts, wipe } from "./d1-count.ts";
import { testConfig, testVars } from "./fixtures.ts";

const cfg = testConfig();
const db = env.DB;
const h = (s: string) => keccak256(toBytes(s)) as Hex;
const NOW = 1_800_000_000;
/** The short cache both routes carry: a burst is served by the Workers Cache, not D1. */
const CACHED = `public, max-age=${CACHE_TTL_S}`;

/** The Workers Cache keeps an answer for 15 s, across tests: each test starts without one. */
const purge = async () => {
  for (const path of ["/v1/status", "/v1/health"]) await caches.default.delete(new Request(`https://api.test${path}`));
};

async function seed() {
  await wipe(db);
  await purge();
  await db.batch([
    deploymentStatement(db, cfg.deployment),
    setCursor(db, { chain: "bittensor", fromBlock: 6_900_000n, scannedTo: 6_905_010n, settledTo: 6_905_000n, settledTime: NOW - 130, headTime: NOW - 10, nowS: NOW }),
    setCursor(db, { chain: "base", fromBlock: 37_000_000n, scannedTo: 37_100_030n, settledTo: 37_100_000n, settledTime: NOW - 64, headTime: NOW, nowS: NOW }),
    setMeta(db, "last_complete_tick", String(NOW - 20)),
  ]);
}

const status = async (nowS = NOW, url = "https://api.test/v1/status") => {
  const r = await handleStatus(new Request(url), { DB: db }, cfg, nowS);
  return { r, body: (await r.json()) as Record<string, any> };
};
const check = (key: string, batchId: bigint, o: { status?: "waiting" | "ok" | "mismatch"; queuedBlock?: bigint } = {}) =>
  upsertBatchCheck(db, { batchId, deliveredKey: h(key), deliveredUid: h(`uid ${key}`), deliveredTx: h(`tx ${key}`), status: o.status ?? "ok", queuedBlock: o.queuedBlock });

beforeEach(seed);

describe("GET /v1/status", () => {
  it("says there is no hold when none is raised", async () => {
    const { r, body } = await status();
    expect(r.status).toBe(200);
    expect(body.v).toBe(1);
    expect(body.hold).toEqual({ active: false, ids: [] });
    expect(body.deployment).toEqual({ frontDoor: cfg.deployment.frontDoor, vault: cfg.deployment.vault, baseChainId: 8453, bittensorChainId: 964 });
  });

  it("lists the uncleared holds by their opaque ids only, never a reason", async () => {
    await db.batch([
      insertHold(db, { id: "bridge.batch:42:0x07531aa4", rule: "bridge.batch_mismatch", summary: "batch 42 failed step 5", raisedAt: NOW - 100 }),
      insertHold(db, { id: "price.drop:6905000", rule: "price.drop", summary: "the price fell 12 bps", raisedAt: NOW - 50 }),
      insertHold(db, { id: "stake.unexplained_drop:6904000", rule: "stake.unexplained_drop", summary: "old", raisedAt: NOW - 500 }),
      db.prepare("UPDATE holds SET cleared_at = ? WHERE id = 'stake.unexplained_drop:6904000'").bind(NOW - 10),
      db.prepare("INSERT INTO alerts (alert_key, rule, tier, kind, subject, body, runbook, opened_at, last_seen_at) VALUES ('bridge.batch:42', 'bridge.batch_mismatch', 'critical', 'event', 'Batch 42 failed the cross-check', 'b', 'rb', 1, 1)"),
    ]);
    const { body } = await status();
    expect(body.hold.active).toBe(true);
    expect(body.hold.ids).toHaveLength(2);
    for (const id of body.hold.ids) expect(id).toMatch(/^h_[0-9a-f]{8}$/);
    const text = JSON.stringify(body);
    for (const secret of ["bridge.batch", "price.drop", "failed step", "fell 12", "Batch 42", "alerts", "rule"]) expect(text).not.toContain(secret);
  });

  it("lists the keys whose check is ok, or approved by the owner, with payouts queued and not yet done", async () => {
    await db.batch([
      check("ok", 1n, { queuedBlock: 6_900_100n }),
      check("approved", 2n, { status: "waiting", queuedBlock: 6_900_200n }),
      db.prepare("UPDATE batch_checks SET status = 'ok_by_owner' WHERE delivered_key = ?").bind(h("approved")),
      check("waiting", 3n, { status: "waiting", queuedBlock: 6_900_300n }),
      check("mismatch", 4n, { status: "mismatch", queuedBlock: 6_900_400n }),
      check("done", 5n, { queuedBlock: 6_900_500n }),
      db.prepare("UPDATE batch_checks SET payout_done_block = 6900600 WHERE delivered_key = ?").bind(h("done")),
      check("nothing queued", 6n),
    ]);
    const { body } = await status();
    expect(body.payouts.okKeys.sort()).toEqual([h("ok"), h("approved")].sort());
  });

  it("lists only the honest key when a forged delivery reused its batch id", async () => {
    await db.batch([check("forged", 43n, { status: "mismatch", queuedBlock: 6_900_700n }), check("honest", 43n, { queuedBlock: 6_900_800n })]);
    expect((await status()).body.payouts.okKeys).toEqual([h("honest")]);
  });

  it("gives each chain's settled block and time and its lag, head_time − settled_time", async () => {
    const { body } = await status();
    expect(body.indexer).toEqual({
      base: { settledTo: 37_100_000, settledTime: new Date((NOW - 64) * 1000).toISOString(), lagS: 64 },
      bittensor: { settledTo: 6_905_000, settledTime: new Date((NOW - 130) * 1000).toISOString(), lagS: 120 },
    });
    expect(body.monitor).toEqual({ lastCompleteTickAt: new Date((NOW - 20) * 1000).toISOString() });
    expect(body.generatedAt).toBe(new Date(NOW * 1000).toISOString());
  });

  it("is cacheable for 15 s (the keeper polls far less often), refuses a query string, and other methods", async () => {
    const { r } = await status();
    expect(r.headers.get("Cache-Control")).toBe(CACHED);
    for (const bad of [new Request("https://api.test/v1/status?x=1"), new Request("https://api.test/v1/status?")]) {
      const b = await handleStatus(bad, { DB: db }, cfg, NOW);
      expect([b.status, b.headers.get("Cache-Control")]).toEqual([400, "no-store"]);
    }
    const m = await handleStatus(new Request("https://api.test/v1/status", { method: "POST" }), { DB: db }, cfg, NOW);
    expect([m.status, m.headers.get("Cache-Control")]).toEqual([405, "no-store"]);
  });

  it("answers 503 when the database holds another deployment (cached like any computed answer), or D1 fails (never cached): the keeper then holds", async () => {
    await db.prepare("UPDATE meta SET v = 'another' WHERE k = 'deployment'").run();
    const r = await handleStatus(new Request("https://api.test/v1/status"), { DB: db }, cfg, NOW);
    expect([r.status, r.headers.get("Cache-Control")]).toEqual([503, CACHED]);
    const broken = { batch: async () => Promise.reject(new Error("D1 down")), prepare: db.prepare.bind(db) } as unknown as D1Database;
    const f = await handleStatus(new Request("https://api.test/v1/status"), { DB: broken }, cfg, NOW);
    expect([f.status, f.headers.get("Cache-Control")]).toEqual([503, "no-store"]);
  });

  it("is served by the Worker at /v1/status", async () => {
    const r = await exports.default.fetch("https://api.test/v1/status");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { v: number }).v).toBe(1);
  });
});

describe("the Workers Cache in front of /v1/status and /v1/health", () => {
  /** The Worker with a counting D1, and a fresh execution context per request (its cache write is awaited). */
  async function fetchCounted(path: string, o: { db?: D1Database; limiter?: RateLimit; init?: RequestInit } = {}) {
    const c = countingDb(o.db ?? db);
    const vars = { ...testVars(), DB: c.db, SCAN_LIMITER: o.limiter ?? env.SCAN_LIMITER } as unknown as Env;
    const ctx = createExecutionContext();
    const r = await worker.fetch(new Request(`https://api.test${path}`, o.init), vars, ctx);
    await waitOnExecutionContext(ctx);
    return { r, queries: c.stats.queries };
  }

  for (const path of ["/v1/status", "/v1/health"]) {
    it(`${path}: the second request within the TTL is served from the cache, and D1 isn't asked again`, async () => {
      const first = await fetchCounted(path);
      expect([first.r.status, first.queries, first.r.headers.get("Cache-Control")]).toEqual([200, 1, CACHED]);
      const body = await first.r.text();
      // the database changes, but the cached answer is what a burst gets for the rest of the TTL
      await db.batch([insertHold(db, { id: "x", rule: "price.drop", summary: "s", raisedAt: NOW }), setMeta(db, "last_complete_tick", String(NOW - 100_000))]);
      const second = await fetchCounted(path);
      expect([second.r.status, second.queries]).toEqual([200, 0]);
      expect(await second.r.text()).toBe(body);
      // another path is its own entry
      const other = await fetchCounted(path === "/v1/status" ? "/v1/health" : "/v1/status");
      expect(other.queries).toBe(1);
      await other.r.text();
    });

    it(`${path}: a D1 failure isn't cached, so the next request reaches a recovered database`, async () => {
      const broken = { batch: async () => Promise.reject(new Error("D1 down")), prepare: db.prepare.bind(db) } as unknown as D1Database;
      const failed = await fetchCounted(path, { db: broken });
      expect([failed.r.status, failed.r.headers.get("Cache-Control")]).toEqual([503, "no-store"]);
      await failed.r.text();
      const ok = await fetchCounted(path);
      expect([ok.r.status, ok.queries]).toEqual([200, 1]);
      await ok.r.text();
    });

    it(`${path}: a query string or another method is refused before the cache and D1`, async () => {
      const q = await fetchCounted(`${path}?x=1`);
      expect([q.r.status, q.queries]).toEqual([400, 0]);
      await q.r.text();
      const p = await fetchCounted(path, { init: { method: "POST", body: "{}" } });
      expect([p.r.status, p.queries]).toEqual([405, 0]);
      await p.r.text();
    });
  }

  it("answers a HEAD as the GET without a body, for an uptime checker that defaults to HEAD, and it is cached and counted like the GET", async () => {
    for (const path of ["/v1/health", "/v1/status"]) {
      const r = await exports.default.fetch(new Request(`https://api.test${path}`, { method: "HEAD" }));
      expect([r.status, await r.text(), r.headers.get("Cache-Control")], path).toEqual([200, "", CACHED]);
    }
    await purge();
    const keys: string[] = [];
    const limiter = { limit: async ({ key }: { key: string }) => ({ success: keys.push(key) <= 1 }) } as RateLimit;
    const IP = { "cf-connecting-ip": "203.0.113.9" };
    const a = await fetchCounted("/v1/health", { limiter, init: { method: "HEAD", headers: IP } });
    expect([a.r.status, a.queries, await a.r.text()]).toEqual([200, 1, ""]);
    // the GET right after is the cached answer: the limiter isn't asked
    const b = await fetchCounted("/v1/health", { limiter, init: { headers: IP } });
    expect([b.r.status, b.queries, await b.r.text()]).toEqual([200, 0, "ok"]);
    expect(keys).toEqual(["health:203.0.113.9"]);
    // a 503 (no complete tick) is a 503 on HEAD too, with its reason in the status only
    await db.prepare("DELETE FROM meta WHERE k = 'last_complete_tick'").run();
    await purge();
    const c = await exports.default.fetch(new Request("https://api.test/v1/health", { method: "HEAD" }));
    expect([c.status, await c.text()]).toEqual([503, ""]);
  });

  it("a request past the client's rate limit is refused with 429 before D1, under the route's own key, and a cached answer never counts", async () => {
    const keys: string[] = [];
    const limiter = { limit: async ({ key }: { key: string }) => ({ success: keys.push(key) <= 1 }) } as RateLimit;
    const IP = { headers: { "cf-connecting-ip": "203.0.113.7" } };
    const a = await fetchCounted("/v1/status", { limiter, init: IP });
    expect([a.r.status, a.queries]).toEqual([200, 1]);
    await a.r.text();
    // served from the cache: the limiter isn't even asked
    const b = await fetchCounted("/v1/status", { limiter, init: IP });
    expect([b.r.status, b.queries]).toEqual([200, 0]);
    await b.r.text();
    expect(keys).toEqual(["status:203.0.113.7"]);
    // health has its own count under its own key; past it, 429 with Retry-After and no cache
    const c = await fetchCounted("/v1/health", { limiter, init: IP });
    expect([c.r.status, c.queries, c.r.headers.get("Retry-After"), c.r.headers.get("Cache-Control")]).toEqual([429, 0, "60", "no-store"]);
    await c.r.text();
    expect(keys).toEqual(["status:203.0.113.7", "health:203.0.113.7"]);
    // a request with no client IP (never one through Cloudflare's edge) isn't counted
    const d = await fetchCounted("/v1/health", { limiter });
    expect([d.r.status, d.queries]).toEqual([200, 1]);
    await d.r.text();
    expect(keys).toHaveLength(2);
  });

  it("is bound in the Worker for both routes: a burst from one IP is refused, another IP still served", async () => {
    // a query string: counted, then refused before the cache and D1, so every request reaches the limiter
    const burst = (path: string, ip: string) => exports.default.fetch(new Request(`https://api.test${path}?x`, { headers: { "cf-connecting-ip": ip } }));
    for (const path of ["/v1/status", "/v1/health"]) {
      const statuses: number[] = [];
      for (let i = 0; i < 130; i++) {
        const r = await burst(path, "198.51.100.3");
        statuses.push(r.status);
        await r.text();
      }
      const passed = statuses.filter((s) => s === 400).length;
      expect(passed, path).toBeGreaterThanOrEqual(60);
      expect(passed, path).toBeLessThanOrEqual(120);
      expect(statuses.filter((s) => s === 429), path).toHaveLength(130 - passed);
      const other = await burst(path, "198.51.100.4");
      expect(other.status, path).toBe(400);
      await other.text();
    }
  });
});

describe("GET /v1/health", () => {
  const req = () => new Request("https://api.test/v1/health");

  it("is ok while the last complete tick is under 5 minutes old; both answers are cacheable for 15 s", async () => {
    await setMeta(db, "last_complete_tick", String(NOW - 299)).run();
    let r = await handleHealth(req(), { DB: db }, NOW);
    expect([r.status, await r.text(), r.headers.get("Cache-Control")]).toEqual([200, "ok", CACHED]);
    await setMeta(db, "last_complete_tick", String(NOW - 301)).run();
    r = await handleHealth(req(), { DB: db }, NOW);
    expect([r.status, r.headers.get("Cache-Control")]).toEqual([503, CACHED]);
    await r.text();
  });

  it("is not ok before any tick completed, and a D1 failure is 503 and never cached", async () => {
    await db.prepare("DELETE FROM meta WHERE k = 'last_complete_tick'").run();
    const r = await handleHealth(req(), { DB: db }, NOW);
    expect(r.status).toBe(503);
    await r.text();
    const broken = { batch: async () => Promise.reject(new Error("D1 down")), prepare: db.prepare.bind(db) } as unknown as D1Database;
    const f = await handleHealth(req(), { DB: broken }, NOW);
    expect([f.status, f.headers.get("Cache-Control")]).toEqual([503, "no-store"]);
    await f.text();
  });

  const health = async (t?: Parameters<typeof handleHealth>[3]) => {
    const r = await handleHealth(req(), { DB: db }, NOW, t);
    return [r.status, await r.text(), r.headers.get("Cache-Control")];
  };
  const settledAt = (chain: "base" | "bittensor", s: number | null) => db.prepare("UPDATE cursors SET settled_time = ? WHERE chain = ?").bind(s, chain).run();
  const caughtUp = () => setMeta(db, "caught_up", String(NOW - 86_400)).run();

  it("is not ok while a chain's settled history lags past the lag limit, though ticks complete (a blind chain)", async () => {
    await caughtUp();
    // a 24-hour payout delay: the limit is 30 minutes (a quarter of it, at most 30 minutes), as the keeper's
    await setMeta(db, "payout_delay", "86400").run();
    await settledAt("base", NOW - 1800);
    expect(await health()).toEqual([200, "ok", CACHED]);
    await settledAt("base", NOW - 3700);
    expect(await health()).toEqual([503, "base is 61 minutes behind (limit 30 minutes)", CACHED]);
    await settledAt("bittensor", NOW - 10 - 2000);
    expect((await health())[1]).toBe("base is 61 minutes behind (limit 30 minutes); bittensor is 33 minutes behind (limit 30 minutes)");
  });

  it("takes the limit from the payout delay the tick last read (v3-test's hour before any) and the thresholds", async () => {
    await caughtUp();
    await settledAt("base", NOW - 1000);
    // no payout delay read yet: the tick's default hour, so a 15-minute limit
    expect((await health())[1]).toBe("base is 16 minutes behind (limit 15 minutes)");
    await setMeta(db, "payout_delay", "86400").run();
    expect(await health()).toEqual([200, "ok", CACHED]);
    expect((await health({ ...DEFAULTS, lagCapS: 600 }))[1]).toBe("base is 16 minutes behind (limit 10 minutes)");
  });

  it("counts no chain catching up in the first backfill (its lag alerts are quiet), but one stuck then", async () => {
    await settledAt("base", NOW - 7200);
    await setMeta(db, "catching_up", "base").run();
    expect(await health()).toEqual([200, "ok", CACHED]);
    // stuck: the tick no longer counts it as catching up
    await setMeta(db, "catching_up", "").run();
    expect((await health())[0]).toBe(503);
    // nor after the first catch-up, whatever catching_up says
    await setMeta(db, "catching_up", "base").run();
    await caughtUp();
    expect((await health())[0]).toBe(503);
    // a chain that never settled a block (its RPC refused it from the first tick) isn't catching up either
    await setMeta(db, "caught_up", "").run();
    await setMeta(db, "catching_up", "").run();
    await settledAt("base", null);
    expect(await health()).toEqual([503, "base has settled no block yet", CACHED]);
  });

  it("is served by the Worker at /v1/health with the configured thresholds, and reads only D1", async () => {
    await caughtUp();
    await settledAt("base", NOW - 7200);
    const r = await exports.default.fetch("https://api.test/v1/health");
    expect([r.status, await r.text()]).toEqual([503, "base is 120 minutes behind (limit 15 minutes)"]);
  });
});

describe("no route writes", () => {
  it("leaves every table's rows as they were, for every route and method", async () => {
    await db.batch([insertHold(db, { id: "x", rule: "price.drop", summary: "s", raisedAt: 1 }), check("ok", 1n, { queuedBlock: 1n })]);
    const before = await rowCounts(db);
    const v = cfg.deployment.vault;
    const paths = [`/v1/scan/${v}`, `/v1/scan/${v}/0x${"a".repeat(40)}`, "/v1/status", "/v1/health", "/nope", "/v1/hold/clear"];
    for (const path of paths) {
      for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"]) {
        const r = await exports.default.fetch(new Request(`https://api.test${path}`, { method, body: method === "GET" || method === "HEAD" ? undefined : '{"hold":false}' }));
        await r.text();
      }
    }
    expect(await rowCounts(db)).toEqual(before);
  });
});
