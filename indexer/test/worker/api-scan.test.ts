import { env, exports } from "cloudflare:workers";
import { type Hex, keccak256, pad, toBytes } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { handleScan } from "../../src/api.ts";
import type { StoredLog } from "../../src/logs.ts";
import { type ScanState, type SeedEvent, sharedHalf } from "../../src/seed.ts";
import { appendStatements, markRemoved, setCursor, upsertLogs } from "../../src/store.ts";
import { countingDb, wipe } from "./d1-count.ts";
import { testConfig, tx } from "./fixtures.ts";
import { assertValidScanState } from "./scan-state-rules.ts";

const cfg = testConfig();
const VAULT = cfg.deployment.vault;
const FROM = cfg.deployment.bittensor.startBlock;
const SETTLED = FROM + 5000n;
const USER = "0x00000000000000000000000000000000000a11ce" as Hex;
const OTHER = "0x00000000000000000000000000000000000b0b00" as Hex;
const KEY = keccak256(toBytes("batch 1")) as Hex;
const ORIGIN = "https://cascade.fi";

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

async function seed(o: { cursor?: boolean; scannedTo?: bigint | null } = {}) {
  const db = env.DB;
  await wipe(db);
  const statements = [
    ...upsertLogs(db, [mine.deposit, mine.redeem, mine.unsettled, mine.removed, theirs]),
    ...markRemoved(db, [mine.removed.uid]),
    ...appendStatements(db, null, SHARED_EVENTS),
  ];
  if (o.cursor !== false) {
    statements.push(
      setCursor(db, { chain: "bittensor", fromBlock: FROM, scannedTo: o.scannedTo === undefined ? SETTLED + 10n : o.scannedTo, settledTo: o.scannedTo === null ? FROM - 1n : SETTLED, settledTime: 1_800_000_000, headTime: 1_800_000_120, nowS: 1_800_000_130 }),
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
    const s = await json(r);
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
