import { env, exports } from "cloudflare:workers";
import { type Hex, keccak256, pad, toBytes } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { handleScan } from "../../src/api.ts";
import type { StoredLog } from "../../src/logs.ts";
import { type ScanState, type SeedEvent, sharedHalf } from "../../src/seed.ts";
import { createExecutionContext } from "cloudflare:test";
import worker from "../../src/index.ts";
import { appendStatements, deploymentStatement, markRemoved, setCursor, setMeta, upsertLogs } from "../../src/store.ts";
import { countingDb, wipe } from "./d1-count.ts";
import { testConfig, testVars, tx } from "./fixtures.ts";
import { assertValidScanState } from "./scan-state-rules.ts";

const cfg = testConfig();
const VAULT = cfg.deployment.vault;
const FROM = cfg.deployment.bittensor.startBlock;
const SETTLED = FROM + 5000n;
const USER = "0x00000000000000000000000000000000000a11ce" as Hex;
const OTHER = "0x00000000000000000000000000000000000b0b00" as Hex;
const KEY = keccak256(toBytes("batch 1")) as Hex;
const ORIGIN = "https://cascadefi.xyz";

const SHARED_EVENTS: SeedEvent[] = [
  { kind: "delivered", batchId: "1", key: KEY, txHash: tx(1), block: String(FROM + 100n) },
  { kind: "staked", block: String(FROM + 110n), txHash: tx(2) },
  { kind: "payout", key: KEY, chunk: 0, taken: 1, txHash: tx(3), block: String(FROM + 300n) },
];

let n = 0;
const accountLog = (event: "Deposited" | "Redeemed", user: Hex, block: bigint, assets: string): StoredLog => ({
  uid: tx(5000 + ++n),
  chain: "bittensor",
  contract: "vault",
  address: VAULT,
  block,
  logIndex: 0,
  txHash: tx(700 + n),
  event,
  topic1: KEY,
  topic2: pad(user),
  data: "0x",
  args: event === "Deposited" ? { key: KEY, user, assets, shares: assets } : { key: KEY, user, shares: assets, assets },
});

const mine = {
  deposit: accountLog("Deposited", USER, FROM + 100n, "40000000000000000"),
  redeem: accountLog("Redeemed", USER, FROM + 900n, "39999999999999990"),
  unsettled: accountLog("Deposited", USER, SETTLED + 1n, "1"),
  removed: accountLog("Deposited", USER, FROM + 400n, "2"),
};
const theirs = accountLog("Deposited", OTHER, FROM + 100n, "7");

async function seed(o: { cursor?: boolean; scannedTo?: bigint | null; fromBlock?: bigint; deployment?: string | null } = {}) {
  const db = env.DB;
  await wipe(db);
  const statements = [
    ...upsertLogs(db, [mine.deposit, mine.redeem, mine.unsettled, mine.removed, theirs]),
    ...markRemoved(db, [mine.removed.uid]),
    ...appendStatements(db, null, SHARED_EVENTS),
  ];
  // the mark the tick's first commit writes: which deployment this database holds
  if (o.deployment === undefined) statements.push(deploymentStatement(db, cfg.deployment));
  else if (o.deployment !== null) statements.push(setMeta(db, "deployment", o.deployment));
  if (o.cursor !== false) {
    statements.push(
      setCursor(db, { chain: "bittensor", fromBlock: o.fromBlock ?? FROM, scannedTo: o.scannedTo === undefined ? SETTLED + 10n : o.scannedTo, settledTo: o.scannedTo === null ? FROM - 1n : SETTLED, settledTime: 1_800_000_000, headTime: 1_800_000_120, nowS: 1_800_000_130 }),
    );
  }
  await db.batch(statements);
}

const get = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`https://api.test${path}`, init));
const json = async (r: Response) => (await r.json()) as ScanState;

beforeEach(async () => {
  await seed();
});

describe("GET /v1/scan/{vault}", () => {
  it("serves the deployment-wide half the site's store saves", async () => {
    const r = await get(`/v1/scan/${VAULT}`);
    expect(r.status).toBe(200);
    const text = await r.text();
    // built from the pages' fragments, byte for byte what the store would save
    expect(text).toBe(JSON.stringify(sharedHalf({ vault: VAULT, from: FROM, next: SETTLED + 1n, events: SHARED_EVENTS })));
    const s = JSON.parse(text) as ScanState;
    assertValidScanState(s, VAULT, FROM);
    expect(s).toEqual(sharedHalf({ vault: VAULT, from: FROM, next: SETTLED + 1n, events: SHARED_EVENTS }));
    expect([s.vault, s.from, s.next, s.deposited, s.redeemed]).toEqual([VAULT, String(FROM), String(SETTLED + 1n), [], []]);
  });

  it("never serves a paged event at or past next", async () => {
    await env.DB.batch(appendStatements(env.DB, { page: 0, events: SHARED_EVENTS }, [{ kind: "staked", block: String(SETTLED + 1n), txHash: tx(9) }]));
    const s = await json(await get(`/v1/scan/${VAULT}`));
    assertValidScanState(s, VAULT, FROM);
    expect(s.staked).toHaveLength(1);
  });
});

describe("GET /v1/scan/{vault}/{account}", () => {
  it("serves only that account's settled, stored events, with the deployment lists empty", async () => {
    const r = await get(`/v1/scan/${VAULT}/${USER}`);
    expect(r.status).toBe(200);
    const s = await json(r);
    assertValidScanState(s, VAULT, FROM);
    expect([s.delivered, s.staked, s.payouts]).toEqual([[], [], []]);
    expect(s.deposited).toEqual([{ key: KEY, txHash: mine.deposit.txHash, block: String(mine.deposit.block), assets: "40000000000000000" }]);
    expect(s.redeemed).toEqual([{ key: KEY, txHash: mine.redeem.txHash, block: String(mine.redeem.block), assets: "39999999999999990" }]);
    // the other account's deposit, the unsettled one and the removed one are not served
    expect(JSON.stringify(s)).not.toContain(theirs.txHash);
  });

  it("shares next with the shared half from the same state", async () => {
    const a = await json(await get(`/v1/scan/${VAULT}`));
    const b = await json(await get(`/v1/scan/${VAULT}/${USER}`));
    expect(a.next).toBe(b.next);
  });

  it("reads only that account's rows", async () => {
    const rowsRead = async () => {
      const c = countingDb(env.DB);
      const r = await handleScan(new Request(`https://api.test/v1/scan/${VAULT}/${USER}`), { DB: c.db }, cfg);
      expect(r.status).toBe(200);
      expect(c.stats.queries).toBe(1);
      return c.stats.rowsRead;
    };
    const alone = await rowsRead();
    const others = Array.from({ length: 60 }, (_, i) => accountLog("Deposited", `0x${(i + 1).toString(16).padStart(40, "0")}` as Hex, FROM + BigInt(i), "1"));
    await env.DB.batch(upsertLogs(env.DB, others));
    // other accounts' events cost nothing; D1 counts an index entry and its row apiece, so this
    // account's 4 stored events (2 served, 1 unsettled, 1 removed) and the cursor come to about 11
    expect(await rowsRead()).toBe(alone);
    expect(alone).toBeGreaterThan(0);
    expect(alone).toBeLessThanOrEqual(2 * 4 + 4);
  });
});

describe("what is refused", () => {
  it("refuses variants before touching D1", async () => {
    const c = countingDb(env.DB);
    const ask = (path: string) => handleScan(new Request(`https://api.test${path}`), { DB: c.db }, cfg);
    const mixed = `0x${VAULT.slice(2, 10).toUpperCase()}${VAULT.slice(10)}`;
    expect((await ask(`/v1/scan/${mixed}`)).status).toBe(404);
    expect((await ask(`/v1/scan/${VAULT}/0x00000000000000000000000000000000000A11CE`)).status).toBe(400);
    expect((await ask(`/v1/scan/${VAULT}?x=1`)).status).toBe(400);
    expect((await ask(`/v1/scan/${VAULT}?`)).status).toBe(400);
    expect((await ask(`/v1/scan/${VAULT}/${USER}?`)).status).toBe(400);
    expect(c.stats.queries).toBe(0);
  });

  it("answers 404 for another vault or path, 400 for a bad account, 405 for other methods", async () => {
    expect((await get(`/v1/scan/0x${"1".repeat(40)}`)).status).toBe(404);
    expect((await get(`/v1/scan/${VAULT}/extra/${USER}`)).status).toBe(404);
    expect((await get(`/v1/scan`)).status).toBe(404);
    expect((await get(`/v1/scan/${VAULT}/0x123`)).status).toBe(400);
    expect((await get(`/v1/scan/${VAULT}/${USER}0`)).status).toBe(400);
    const post = await get(`/v1/scan/${VAULT}`, { method: "POST", body: "{}" });
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET, OPTIONS");
  });

  it("answers 503 before the first Bittensor window is stored", async () => {
    await seed({ cursor: false });
    let r = await get(`/v1/scan/${VAULT}`);
    expect([r.status, r.headers.get("Retry-After")]).toEqual([503, "60"]);
    await seed({ scannedTo: null });
    r = await get(`/v1/scan/${VAULT}/${USER}`);
    expect([r.status, r.headers.get("Retry-After")]).toEqual([503, "60"]);
  });

  it("answers 503 when the database belongs to another deployment, or doesn't say", async () => {
    const cases: Parameters<typeof seed>[0][] = [{ fromBlock: FROM + 1n }, { deployment: `0x${"1".repeat(40)}:0x${"2".repeat(40)}` }, { deployment: null }];
    for (const o of cases) {
      await seed(o);
      const r = await get(`/v1/scan/${VAULT}`);
      expect([r.status, r.headers.get("Retry-After"), r.headers.get("Access-Control-Allow-Origin")]).toEqual([503, "60", ORIGIN]);
      await r.text();
    }
  });

  it("answers 503, with CORS, when a stored row can't be read", async () => {
    await env.DB.prepare("UPDATE logs SET args = 'not json' WHERE uid = ?").bind(mine.deposit.uid).run();
    let r = await get(`/v1/scan/${VAULT}/${USER}`);
    expect([r.status, r.headers.get("Retry-After"), r.headers.get("Access-Control-Allow-Origin")]).toEqual([503, "60", ORIGIN]);
    await r.text();
    // a page across next's edge is parsed: a broken one answers the same
    await env.DB.prepare("UPDATE seed_pages SET staked = '{broken', last_block = ?").bind(Number(SETTLED + 5n)).run();
    r = await get(`/v1/scan/${VAULT}`);
    expect([r.status, r.headers.get("Retry-After"), r.headers.get("Access-Control-Allow-Origin")]).toEqual([503, "60", ORIGIN]);
    await r.text();
  });

  it("answers 503, with CORS for the site, when the Worker isn't configured", async () => {
    const vars = { ...testVars(), DEPLOYMENT: "not configured", DB: env.DB } as unknown as Env;
    const r = await worker.fetch(new Request(`https://api.test/v1/scan/${VAULT}`), vars, createExecutionContext());
    expect([r.status, r.headers.get("Retry-After"), r.headers.get("Access-Control-Allow-Origin"), r.headers.get("Cache-Control")]).toEqual([503, "60", ORIGIN, "no-store"]);
    await r.text();
  });

  it("answers 503 when the D1 read fails", async () => {
    const broken = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async () => {
        throw new Error("D1_ERROR: too many requests");
      },
    } as unknown as D1Database;
    const r = await handleScan(new Request(`https://api.test/v1/scan/${VAULT}`), { DB: broken }, cfg);
    expect([r.status, r.headers.get("Retry-After"), r.headers.get("Cache-Control")]).toEqual([503, "60", "no-store"]);
  });
});

describe("headers", () => {
  it("are cacheable for 30 s, with CORS for the site and the settled time exposed", async () => {
    for (const path of [`/v1/scan/${VAULT}`, `/v1/scan/${VAULT}/${USER}`]) {
      const r = await get(path);
      expect(Object.fromEntries(r.headers)).toMatchObject({
        "content-type": "application/json",
        "cache-control": "public, max-age=30",
        "access-control-allow-origin": ORIGIN,
        "access-control-expose-headers": "Cascade-Settled-Time",
        "cascade-settled-time": "1800000000",
      });
      expect(r.headers.get("Access-Control-Allow-Credentials")).toBeNull();
      await r.text();
    }
  });

  it("answer a preflight with GET only and no credentials", async () => {
    const r = await get(`/v1/scan/${VAULT}`, { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "GET" } });
    expect(r.status).toBe(204);
    expect(r.headers.get("Access-Control-Allow-Methods")).toBe("GET");
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(r.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });
});

describe("the rate limit (the SCAN_LIMITER binding)", () => {
  /** A limiter letting `allowed` calls through, recording the keys it was asked about. */
  const limiter = (allowed: number) => {
    const keys: string[] = [];
    const l = { limit: async ({ key }: { key: string }) => ({ success: keys.push(key) <= allowed }) } as RateLimit;
    return { l, keys };
  };
  const IP = { "cf-connecting-ip": "203.0.113.7" };
  const ask = (l: RateLimit, init: RequestInit = { headers: IP }) => handleScan(new Request(`https://api.test/v1/scan/${VAULT}`, init), { DB: env.DB, SCAN_LIMITER: l }, cfg);

  it("counts each client by its IP and answers 429, with CORS and Retry-After, past the limit", async () => {
    const { l, keys } = limiter(2);
    for (let i = 0; i < 2; i++) {
      const r = await ask(l);
      expect(r.status).toBe(200);
      await r.text();
    }
    const r = await ask(l);
    expect([r.status, await r.text()]).toEqual([429, "too many requests"]);
    expect(Object.fromEntries(r.headers)).toMatchObject({ "retry-after": "60", "access-control-allow-origin": ORIGIN, "cache-control": "no-store" });
    expect(keys).toEqual(["scan:203.0.113.7", "scan:203.0.113.7", "scan:203.0.113.7"]);
  });

  it("leaves a preflight, and a request with no client IP (never one through Cloudflare), uncounted; serves when the limiter fails", async () => {
    const { l, keys } = limiter(0);
    expect((await ask(l, { method: "OPTIONS", headers: IP })).status).toBe(204);
    const bare = await ask(l, {});
    expect(bare.status).toBe(200);
    await bare.text();
    expect(keys).toEqual([]);
    const broken = { limit: async () => Promise.reject(new Error("limiter down")) } as unknown as RateLimit;
    const r = await ask(broken);
    expect(r.status).toBe(200);
    await r.text();
  });

  it("is bound in the Worker (60 a minute per IP): a burst from one IP is refused, another IP still served", async () => {
    // a wrong vault: counted, then refused before D1. The window is one wall-clock minute: 130 requests straddle
    // at most one boundary, so 60 to 120 pass
    const burst = (ip: string) => get(`/v1/scan/0x${"0".repeat(40)}`, { headers: { "cf-connecting-ip": ip } });
    const statuses: number[] = [];
    for (let i = 0; i < 130; i++) {
      const r = await burst("198.51.100.1");
      statuses.push(r.status);
      await r.text();
    }
    const passed = statuses.filter((s) => s === 404).length;
    expect(passed).toBeGreaterThanOrEqual(60);
    expect(passed).toBeLessThanOrEqual(120);
    expect(statuses.filter((s) => s === 429)).toHaveLength(130 - passed);
    const other = await burst("198.51.100.2");
    expect(other.status).toBe(404);
    await other.text();
  });
});
