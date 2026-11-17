import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { CACHE_TTL_S, FLOW_LOGS_SQL, handleFlow } from "../../src/api.ts";
import worker from "../../src/index.ts";
import { ITEMS_KEY } from "../../src/scheduler.ts";
import { deploymentStatement, setMeta } from "../../src/store.ts";
import { countingDb, wipe } from "./d1-count.ts";
import { testConfig, testConfigV32, testVars, tx } from "./fixtures.ts";

const cfg = testConfig();
const db = env.DB;
const NOW = 1_800_000_000;
const CACHED = `public, max-age=${CACHE_TTL_S}`;
const ORIGIN = cfg.site.origin;
const URL_ = "https://api.test/v1/flow";
const OTHER = "0x00000000000000000000000000000000000000aa";

const purge = () => caches.default.delete(new Request(URL_));
const big = (n: number) => ({ $bigint: String(n) });
const reading = (o: { base?: unknown; bittensor?: unknown }) => JSON.stringify({ at: NOW, nonces: {}, safeNonces: {}, messageStates: {}, deliveredReads: [], ...o });
const E18 = 10n ** 18n;
const bucket = { tokens: big(5), isEnabled: true, capacity: { $bigint: String(20n * E18) }, rate: { $bigint: String(E18 / 100n) } };
const baseHalf = { block: big(123), time: NOW - 10, state: { taoWethPool: {}, wethUsdcPool: {}, claimable: {}, deliveryOf: {}, paused: false, lane: { outbound: bucket } } };
const bitHalf = { block: big(456), time: NOW - 10, state: { stakes: {}, payoutBatches: {}, alpha: {}, paused: false, lane: { outbound: bucket } } };

const msg = (id: string, direction: string, dst: string | null, state: string) =>
  db
    .prepare("INSERT INTO messages (message_id, direction, sender, recipient, amount, src_tx, src_block, src_time, state, dst_tx) VALUES (?, ?, '0x', '0x', '1', '0x', 1, 1, ?, ?)")
    .bind(id, direction, state, dst);

async function seed() {
  await wipe(db);
  await purge();
  await db.batch([
    deploymentStatement(db, cfg.deployment),
    db.prepare("INSERT INTO readings (at, base_block, bit_block, json) VALUES (?, ?, ?, ?)").bind(NOW - 60, 100, 400, reading({ base: { ...baseHalf, block: big(100) }, bittensor: { ...bitHalf, block: big(400) } })),
    // a partial tick: only Base read
    db.prepare("INSERT INTO readings (at, base_block, bit_block, json) VALUES (?, ?, NULL, ?)").bind(NOW - 5, 123, reading({ base: baseHalf })),
    msg("m1", "base>bittensor", null, "UNTOUCHED"),
    msg("m2", "base>bittensor", "0xdead", "SUCCESS"),
    msg("m3", "bittensor>base", null, "SUCCESS"),
    msg("m4", "bittensor>base", null, "UNTOUCHED"),
    msg("m5", "bittensor>base", null, "UNTOUCHED"),
    db
      .prepare("INSERT INTO logs (uid, chain, contract, address, block, log_index, tx_hash, event, data, args, removed) VALUES (?, 'base', 'frontDoor', ?, 10, 0, ?, 'BridgeProposed', '0x', ?, 0)")
      .bind("u1", cfg.deployment.frontDoor, tx(9), JSON.stringify({ bridge: OTHER, readyAt: "1900000000" })),
  ]);
}

async function fetchCounted(init?: RequestInit, o: { db?: D1Database; limiter?: RateLimit; path?: string } = {}) {
  const c = countingDb(o.db ?? db);
  const vars = { ...testVars(), DB: c.db, SCAN_LIMITER: o.limiter ?? env.SCAN_LIMITER } as unknown as Env;
  const ctx = createExecutionContext();
  const r = await worker.fetch(new Request(`https://api.test${o.path ?? "/v1/flow"}`, init), vars, ctx);
  await waitOnExecutionContext(ctx);
  return { r, queries: c.stats.queries };
}
const direct = (init?: RequestInit, url = URL_, d: D1Database = db) => handleFlow(new Request(url, init), { DB: d }, cfg, NOW);

beforeEach(seed);

describe("GET /v1/flow", () => {
  it("servesTheDocument", async () => {
    const r = await direct();
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("application/json");
    expect(r.headers.get("Cache-Control")).toBe(CACHED);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    const body = (await r.json()) as any;
    expect(body.v).toBe(1);
    expect(body.deployment).toBe(cfg.deployment.id);
    expect(body.generatedAt).toBe(NOW);
    // each chain from its own newest reading: Base from the partial tick, Bittensor from the older one
    expect(body.chains.base.block).toBe("123");
    expect(body.chains.bittensor.block).toBe("400");
    expect(body.bridgeIn.inFlight).toBe(1);
    expect(body.bridgeOut.inFlight).toBe(2);
    expect(body.notices).toEqual([{ kind: "bridgeProposed", chain: "base", contract: cfg.deployment.frontDoor, target: OTHER, earliest: 1900000000, tx: tx(9) }]);
  });

  it("optionsPreflight", async () => {
    const r = await direct({ method: "OPTIONS", headers: { Origin: ORIGIN } });
    expect(r.status).toBe(204);
    expect(Object.fromEntries(r.headers)).toMatchObject({
      "access-control-allow-origin": ORIGIN,
      "access-control-allow-methods": "GET",
      "access-control-max-age": "86400",
    });
    expect(await r.text()).toBe("");
  });

  it("postIs405", async () => {
    const r = await direct({ method: "POST", body: "{}" });
    expect([r.status, r.headers.get("Allow"), r.headers.get("Access-Control-Allow-Origin")]).toEqual([405, "GET, OPTIONS", ORIGIN]);
  });

  it("queryIs400", async () => {
    const r = await direct(undefined, `${URL_}?x=1`);
    expect([r.status, r.headers.get("Access-Control-Allow-Origin")]).toEqual([400, ORIGIN]);
    expect((await direct(undefined, `${URL_}?`)).status).toBe(400);
  });

  it("rateLimitIs429", async () => {
    const limiter = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    const r = await handleFlow(new Request(URL_, { headers: { "cf-connecting-ip": "203.0.113.5" } }), { DB: db, SCAN_LIMITER: limiter }, cfg, NOW);
    expect([r.status, r.headers.get("Retry-After"), r.headers.get("Access-Control-Allow-Origin")]).toEqual([429, "60", ORIGIN]);
  });

  it("d1FailureIs503NoStore", async () => {
    const broken = { batch: async () => Promise.reject(new Error("D1 down")), prepare: db.prepare.bind(db) } as unknown as D1Database;
    const r = await direct(undefined, URL_, broken);
    expect([r.status, r.headers.get("Cache-Control"), r.headers.get("Access-Control-Allow-Origin")]).toEqual([503, "no-store", ORIGIN]);
    // not cached: the next request reaches a recovered database
    const failed = await fetchCounted(undefined, { db: broken });
    await failed.r.text();
    const ok = await fetchCounted();
    expect([ok.r.status, ok.queries]).toEqual([200, 1]);
    await ok.r.text();
  });

  it("flowOfThrowingIs503NoStore", async () => {
    // a Bittensor reading with no alpha state (not the shape the monitor writes) makes flowOf throw
    await db.prepare("INSERT INTO readings (at, base_block, bit_block, json) VALUES (?, NULL, ?, ?)").bind(NOW - 1, 500, reading({ bittensor: { block: big(500), time: NOW - 1, state: {} } })).run();
    const r = await direct();
    expect([r.status, r.headers.get("Cache-Control"), r.headers.get("Access-Control-Allow-Origin")]).toEqual([503, "no-store", ORIGIN]);
    await r.text();
    // and so does an unreadable reading
    await db.prepare("UPDATE readings SET json = 'not json' WHERE at = ?").bind(NOW - 1).run();
    expect((await direct()).status).toBe(503);
  });

  it("deploymentMismatchIs503", async () => {
    await db.prepare("UPDATE meta SET v = 'another' WHERE k = 'deployment'").run();
    const r = await direct();
    expect([r.status, r.headers.get("Cache-Control"), r.headers.get("Access-Control-Allow-Origin")]).toEqual([503, CACHED, ORIGIN]);
    await db.prepare("DELETE FROM meta WHERE k = 'deployment'").run();
    expect((await direct()).status).toBe(503);
  });

  it("noReadingsYetStillAnswers", async () => {
    await db.prepare("DELETE FROM readings").run();
    const body = (await (await direct()).json()) as any;
    expect([body.v, body.chains.base, body.chains.bittensor]).toEqual([1, null, null]);
  });

  it("headHasNoBody", async () => {
    const r = await exports.default.fetch(new Request(URL_, { method: "HEAD" }));
    expect([r.status, await r.text(), r.headers.get("Cache-Control"), r.headers.get("Access-Control-Allow-Origin")]).toEqual([200, "", CACHED, ORIGIN]);
  });

  it("unknownPathStill404", async () => {
    for (const path of ["/v1/flows", "/v1/flow/x", "/v1/flo"]) {
      const r = await exports.default.fetch(new Request(`https://api.test${path}`));
      expect(r.status, path).toBe(404);
      await r.text();
    }
  });

  it("cachedOnce", async () => {
    const first = await fetchCounted();
    expect([first.r.status, first.queries, first.r.headers.get("Cache-Control")]).toEqual([200, 1, CACHED]);
    const body = await first.r.text();
    await db.prepare("DELETE FROM readings").run();
    const second = await fetchCounted();
    expect([second.r.status, second.queries]).toEqual([200, 0]);
    expect(await second.r.text()).toBe(body);
  });

  it("aCacheHitStillCarriesTheCorsOrigin", async () => {
    await (await fetchCounted()).r.text();
    const hit = await fetchCounted();
    expect([hit.r.status, hit.queries, hit.r.headers.get("Access-Control-Allow-Origin")]).toEqual([200, 0, ORIGIN]);
    await hit.r.text();
  });

  it("theEventsAreReadThroughTheIndexNotAScan", async () => {
    const names = ["GuardianProposed", "BridgeProposed", "BridgeActivated", "BridgeProposalCancelled", "FrontDoorProposed", "FrontDoorActivated", "FrontDoorProposalCancelled", "OwnershipTransferStarted"];
    const plan = await db.prepare(`EXPLAIN QUERY PLAN ${FLOW_LOGS_SQL}`).bind(...names).all<{ detail: string }>();
    const text = plan.results.map((r) => r.detail).join(" | ");
    expect(text).toContain("logs_by_event");
    expect(text).not.toMatch(/SCAN logs/);
  });

  it("anOptionsOrPostThroughTheWorkerSkipsTheCache", async () => {
    const o = await fetchCounted({ method: "OPTIONS" });
    expect([o.r.status, o.queries]).toEqual([204, 0]);
    const p = await fetchCounted({ method: "POST", body: "{}" });
    expect([p.r.status, p.queries]).toEqual([405, 0]);
  });
});

describe("GET /v1/flow on a v3.2 deployment", () => {
  it("shows the pending items the admin rules keep (meta scheduled_items), judged by the newest reading's lens reads", async () => {
    const cfg32 = testConfigV32();
    const G = "0x00000000000000000000000000000000000000b2";
    const readyAt = NOW + 86_400;
    const item = (id: string, uid: number) => ({
      chain: "bittensor",
      role: "vault",
      id,
      kind: 1,
      selector: "0xa7016023",
      readyAt,
      data: "0xa7016023",
      setter: "setGuardian",
      args: { newGuardian: G },
      canonical: true,
      uid: tx(uid),
      block: "6900200",
      tx: tx(uid + 1),
    });
    const lens = (r: number) => ({ scheduledAt: readyAt - 8 * 86_400, readyAt: r, class: 2, kind: 1, selector: "0xa7016023", readyBlock: big(1) });
    const exits = { open: true, ownerHold: false, guardianHold: false, pausedBy: 0, primaryDisabledBy: 0, launchDoorRemovedBy: 0, lastOwnerClose: 0, lastGuardianClose: 0, pendingSince: 0 };
    const bit = { ...bitHalf, block: big(500), state: { ...bitHalf.state, exits, scheduled: { [tx(1)]: lens(readyAt), [tx(2)]: lens(0) } } };
    await wipe(db);
    await purge();
    await db.batch([
      deploymentStatement(db, cfg32.deployment),
      db.prepare("INSERT INTO readings (at, base_block, bit_block, json) VALUES (?, ?, ?, ?)").bind(NOW - 5, 123, 500, reading({ base: baseHalf, bittensor: bit })),
      setMeta(db, ITEMS_KEY, JSON.stringify([item(tx(1), 10), item(tx(2), 20)])),
    ]);
    const r = await handleFlow(new Request(URL_), { DB: db }, cfg32, NOW);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { notices: unknown[] };
    // the one the lens still holds; the other reads gone
    expect(body.notices).toEqual([
      { kind: "itemScheduled", chain: "bittensor", contract: cfg32.deployment.vault, target: G, earliest: readyAt, tx: tx(11), item: { id: tx(1), kind: "GuardianSwap", setter: "setGuardian", args: { newGuardian: G } } },
    ]);
  });

  it("carries the deposits parked on Bittensor from the stored park events (the front door's, still open, with TAO), with the oldest's refund date, and the exits part", async () => {
    const cfg32 = testConfigV32();
    const d32 = cfg32.deployment;
    const park = (uid: string, event: string, key: string, block: number, args: Record<string, string> = {}) =>
      db
        .prepare("INSERT INTO logs (uid, chain, contract, address, block, log_index, tx_hash, event, topic1, data, args, removed) VALUES (?, 'bittensor', 'bitAdapter', ?, ?, 0, ?, ?, ?, '0x', ?, 0)")
        .bind(uid, d32.bitAdapter, block, tx(block), event, key, JSON.stringify({ key, ...args }));
    const parked = (uid: string, key: string, block: number, sender = d32.frontDoor) =>
      park(uid, "BatchParked", key, block, { messageId: tx(7), recipient: d32.vault, sender, amount: String(2n * E18), converted: "false", reason: "0x00000000" });
    const exits = { open: true, ownerHold: false, guardianHold: false, pausedBy: 0, primaryDisabledBy: 0, launchDoorRemovedBy: 0, lastOwnerClose: 0, lastGuardianClose: 0, pendingSince: 0 };
    const bit = { ...bitHalf, block: big(500), state: { ...bitHalf.state, exits, payoutDelay: 86_400 } };
    await wipe(db);
    await purge();
    await db.batch([
      deploymentStatement(db, cfg32.deployment),
      db.prepare("INSERT INTO readings (at, base_block, bit_block, json) VALUES (?, ?, ?, ?)").bind(NOW - 5, 123, 500, reading({ base: baseHalf, bittensor: bit })),
      parked("p1", tx(31), 400),
      parked("p2", tx(32), 410),
      park("p3", "ParkedDelivered", tx(32), 420),
      parked("p4", tx(33), 430, OTHER),
      db.prepare("INSERT INTO blocks (chain, number, time) VALUES ('bittensor', 400, ?)").bind(NOW - 3_000),
    ]);
    const r = await handleFlow(new Request(URL_), { DB: db }, cfg32, NOW);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { notices: unknown[]; exits: Record<string, unknown> };
    expect(body.notices).toEqual([{ kind: "parked", chain: "bittensor", contract: d32.bitAdapter, earliest: NOW - 3_000 + 14 * 86_400 }]);
    expect(body.exits).toMatchObject({ payoutDelayS: 86_400, parked: String(2n * E18), parkedRefundFrom: NOW - 3_000 + 14 * 86_400 });
    // a park whose block's time isn't stored is told by its block, at Bittensor's block time as the tick last measured it:
    // 100 blocks before the reading's (block 500, 10 s old) at 6 s (block_s:bittensor): 600 s before it
    await db.batch([db.prepare("DELETE FROM blocks WHERE chain = 'bittensor' AND number = 400"), setMeta(db, "block_s:bittensor", "6")]);
    const told = (await (await handleFlow(new Request(URL_), { DB: db }, cfg32, NOW)).json()) as { exits: Record<string, unknown> };
    expect(told.exits).toMatchObject({ parkedRefundFrom: NOW - 10 - 100 * 6 + 14 * 86_400 });
    // v3-launch's document has no exits part and reads no park events
    const old = (await (await direct()).json()) as Record<string, unknown>;
    expect(old).not.toHaveProperty("exits");
  });
});
