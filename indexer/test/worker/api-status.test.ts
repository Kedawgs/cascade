import { env, exports } from "cloudflare:workers";
import { type Hex, keccak256, toBytes } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { handleHealth, handleStatus } from "../../src/api.ts";
import { deploymentStatement, insertHold, setCursor, setMeta, upsertBatchCheck } from "../../src/store.ts";
import { rowCounts, wipe } from "./d1-count.ts";
import { testConfig } from "./fixtures.ts";

const cfg = testConfig();
const db = env.DB;
const h = (s: string) => keccak256(toBytes(s)) as Hex;
const NOW = 1_800_000_000;

async function seed() {
  await wipe(db);
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

  it("is never cached, refuses a query string, and other methods", async () => {
    const { r } = await status();
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect((await handleStatus(new Request("https://api.test/v1/status?x=1"), { DB: db }, cfg, NOW)).status).toBe(400);
    expect((await handleStatus(new Request("https://api.test/v1/status?"), { DB: db }, cfg, NOW)).status).toBe(400);
    expect((await handleStatus(new Request("https://api.test/v1/status", { method: "POST" }), { DB: db }, cfg, NOW)).status).toBe(405);
  });

  it("answers 503 when the database holds another deployment, or D1 fails: the keeper then holds", async () => {
    await db.prepare("UPDATE meta SET v = 'another' WHERE k = 'deployment'").run();
    const r = await handleStatus(new Request("https://api.test/v1/status"), { DB: db }, cfg, NOW);
    expect([r.status, r.headers.get("Cache-Control")]).toEqual([503, "no-store"]);
    const broken = { batch: async () => Promise.reject(new Error("D1 down")), prepare: db.prepare.bind(db) } as unknown as D1Database;
    expect((await handleStatus(new Request("https://api.test/v1/status"), { DB: broken }, cfg, NOW)).status).toBe(503);
  });

  it("is served by the Worker at /v1/status", async () => {
    const r = await exports.default.fetch("https://api.test/v1/status");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { v: number }).v).toBe(1);
  });
});

describe("GET /v1/health", () => {
  it("is ok while the last complete tick is under 5 minutes old", async () => {
    await setMeta(db, "last_complete_tick", String(NOW - 299)).run();
    let r = await handleHealth({ DB: db }, NOW);
    expect([r.status, await r.text(), r.headers.get("Cache-Control")]).toEqual([200, "ok", "no-store"]);
    await setMeta(db, "last_complete_tick", String(NOW - 301)).run();
    r = await handleHealth({ DB: db }, NOW);
    expect([r.status, r.headers.get("Cache-Control")]).toEqual([503, "no-store"]);
    await r.text();
  });

  it("is not ok before any tick completed", async () => {
    await db.prepare("DELETE FROM meta WHERE k = 'last_complete_tick'").run();
    const r = await handleHealth({ DB: db }, NOW);
    expect(r.status).toBe(503);
    await r.text();
  });
});

describe("no route writes", () => {
  it("leaves every table's rows as they were, for every route and method", async () => {
    await db.batch([insertHold(db, { id: "x", rule: "price.drop", summary: "s", raisedAt: 1 }), check("ok", 1n, { queuedBlock: 1n })]);
    const before = await rowCounts(db);
    const v = cfg.deployment.vault;
    const paths = [`/v1/scan/${v}`, `/v1/scan/${v}/0x${"a".repeat(40)}`, "/v1/status", "/v1/health", "/nope", "/v1/hold/clear"];
    for (const path of paths) {
      for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
        const r = await exports.default.fetch(new Request(`https://api.test${path}`, { method, body: method === "GET" ? undefined : '{"hold":false}' }));
        await r.text();
      }
    }
    expect(await rowCounts(db)).toEqual(before);
  });
});
