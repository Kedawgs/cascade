import { env } from "cloudflare:workers";
import { type Hex, keccak256, pad, toBytes } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import type { StoredLog } from "../../src/logs.ts";
import {
  guardStatement,
  insertHold,
  insertReading,
  insertTxs,
  leaseHolder,
  loadTickState,
  markRemoved,
  pruneHours,
  pruneReadings,
  releaseLease,
  setCursor,
  setMeta,
  storedUids,
  takeLease,
  upsertBatchCheck,
  upsertBlocks,
  upsertChunkCheck,
  upsertHour,
  upsertLogs,
} from "../../src/store.ts";
import { countingDb, rowCounts, TABLES, wipe } from "./d1-count.ts";

const db = env.DB;
const h = (s: string) => keccak256(toBytes(s)) as Hex;
const USER = "0x00000000000000000000000000000000000a11ce" as Hex;
const OTHER = "0x00000000000000000000000000000000000b0b00" as Hex;

function log(o: Partial<StoredLog> & { uid: Hex }): StoredLog {
  return {
    chain: "bittensor",
    contract: "vault",
    address: "0x44ceace0b097d9d5ef01e08b12029ad2762cbdc6",
    block: 100n,
    logIndex: 0,
    txHash: h("tx"),
    event: "Staked",
    data: "0x",
    args: {},
    ...o,
  };
}

const allLogs = async () =>
  (await db.prepare("SELECT uid, block, log_index, removed FROM logs ORDER BY uid").all<{ uid: string; block: number; log_index: number; removed: number }>()).results;

beforeEach(async () => {
  await wipe(db);
});

describe("the migration", () => {
  it("makes every table", async () => {
    const names = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map((r) => r.name);
    for (const t of TABLES) expect(names).toContain(t);
    const indexes = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all<{ name: string }>()).results.map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining(["logs_by_event", "logs_by_topic2", "logs_by_tx", "logs_by_block", "alerts_open", "batch_checks_by_key"]));
  });
});

describe("the lease", () => {
  it("is taken once, refused while held, and taken again after it runs out", async () => {
    expect(await takeLease(db, "a", 180, 1000)).toBe(true);
    expect(await takeLease(db, "b", 180, 1100)).toBe(false);
    expect(await takeLease(db, "b", 180, 1180)).toBe(false);
    expect(await takeLease(db, "b", 180, 1181)).toBe(true);
    expect(await leaseHolder(db)).toEqual({ holder: "b", until: 1361 });
  });

  it("fails a commit whole once another tick has taken the lease, and lets that tick commit", async () => {
    expect(await takeLease(db, "A", 180, 0)).toBe(true);
    const before = await rowCounts(db);
    // A runs out of time; B takes the lease; A's commit, guarded, must change nothing
    expect(await takeLease(db, "B", 180, 200)).toBe(true);
    const commitA = [guardStatement(db, "A"), setMeta(db, "last_complete_tick", "200"), ...upsertLogs(db, [log({ uid: h("a") })])];
    await expect(db.batch(commitA)).rejects.toThrow();
    expect(await rowCounts(db)).toEqual(before);
    await db.batch([guardStatement(db, "B"), setMeta(db, "last_complete_tick", "201"), ...upsertLogs(db, [log({ uid: h("b") })])]);
    expect((await allLogs()).map((l) => l.uid)).toEqual([h("b")]);
    expect((await leaseHolder(db))?.holder).toBe("B");
  });

  it("lets a slow tick whose lease ran out, but wasn't taken, still commit", async () => {
    expect(await takeLease(db, "A", 180, 0)).toBe(true);
    // A is still working at 400 s, its lease over at 180 but nobody took it
    await db.batch([guardStatement(db, "A"), setMeta(db, "last_complete_tick", "400")]);
    const s = await loadTickState(db, 400);
    expect(s.meta.last_complete_tick).toBe("400");
  });

  it("is released by its holder only", async () => {
    await takeLease(db, "A", 180, 0);
    await releaseLease(db, "B").run();
    expect(await takeLease(db, "C", 180, 10)).toBe(false);
    await releaseLease(db, "A").run();
    expect(await takeLease(db, "C", 180, 10)).toBe(true);
  });
});

describe("logs", () => {
  it("stores a log once however often it is upserted", async () => {
    await db.batch(upsertLogs(db, [log({ uid: h("x") })]));
    await db.batch(upsertLogs(db, [log({ uid: h("x") })]));
    expect(await allLogs()).toHaveLength(1);
  });

  it("brings back a log marked removed when it is re-mined at a new block", async () => {
    await db.batch(upsertLogs(db, [log({ uid: h("x"), block: 100n, logIndex: 3 })]));
    await db.batch(markRemoved(db, [h("x")]));
    expect((await allLogs())[0].removed).toBe(1);
    await db.batch(upsertLogs(db, [log({ uid: h("x"), block: 101n, logIndex: 0 })]));
    expect(await allLogs()).toEqual([{ uid: h("x"), block: 101, log_index: 0, removed: 0 }]);
  });

  it("stores topics, data and arguments as given", async () => {
    await db.batch(upsertLogs(db, [log({ uid: h("y"), topic1: h("k"), topic2: pad(USER), data: "0x01", args: { assets: "5", chunk: 2 } })]));
    const row = await db.prepare("SELECT * FROM logs").first<Record<string, unknown>>();
    expect(row).toMatchObject({ chain: "bittensor", contract: "vault", event: "Staked", topic1: h("k"), topic2: pad(USER), topic3: null, data: "0x01", args: '{"assets":"5","chunk":2}' });
  });

  it("loads the stored uids of each chain's re-read range in one query, reading only that range", async () => {
    const many = Array.from({ length: 300 }, (_, i) => log({ uid: h(`old${i}`), block: BigInt(i) }));
    await db.batch(upsertLogs(db, [...many, log({ uid: h("in"), block: 3101n }), log({ uid: h("base"), chain: "base", contract: "frontDoor", block: 90n }), log({ uid: h("gone"), block: 3200n })]));
    await db.batch(markRemoved(db, [h("gone")]));
    const c = countingDb(db);
    const got = await storedUids(c.db, [
      { chain: "bittensor", from: 3101n, to: 3500n },
      { chain: "base", from: 50n, to: 120n },
    ]);
    expect(c.stats.queries).toBe(1);
    // D1 reports rows read (not 0), and the index keeps them to the range
    expect(c.stats.rowsRead).toBeGreaterThan(0);
    expect(c.stats.rowsRead).toBeLessThan(20);
    expect([...(got.get("bittensor") ?? [])]).toEqual([[h("in"), 3101n]]);
    expect([...(got.get("base") ?? [])]).toEqual([[h("base"), 90n]]);
    expect((await storedUids(db, [])).size).toBe(0);
  });
});

describe("cursors", () => {
  it("never moves settled_to, scanned_to or head_time back", async () => {
    await setCursor(db, { chain: "bittensor", fromBlock: 1000n, scannedTo: 3500n, settledTo: 3490n, settledTime: 50, headTime: 60, nowS: 70 }).run();
    await setCursor(db, { chain: "bittensor", fromBlock: 1000n, scannedTo: 3000n, settledTo: 3000n, settledTime: 40, headTime: 55, nowS: 80 }).run();
    const s = await loadTickState(db, 80);
    expect(s.cursors.bittensor).toEqual({ chain: "bittensor", fromBlock: 1000n, scannedTo: 3500n, settledTo: 3490n, settledTime: 50, headTime: 60, updatedAt: 80 });
    await setCursor(db, { chain: "bittensor", fromBlock: 1000n, scannedTo: 4000n, settledTo: 3990n, settledTime: 90, headTime: 95, nowS: 100 }).run();
    expect((await loadTickState(db, 100)).cursors.bittensor).toMatchObject({ scannedTo: 4000n, settledTo: 3990n, settledTime: 90, headTime: 95 });
  });

  it("starts with nothing scanned, and moves head_time even when nothing else moves", async () => {
    await setCursor(db, { chain: "base", fromBlock: 500n, scannedTo: null, settledTo: 499n, settledTime: null, headTime: 10, nowS: 10 }).run();
    expect((await loadTickState(db, 10)).cursors.base).toEqual({ chain: "base", fromBlock: 500n, scannedTo: null, settledTo: 499n, settledTime: null, headTime: 10, updatedAt: 10 });
    await setCursor(db, { chain: "base", fromBlock: 500n, scannedTo: null, settledTo: 499n, settledTime: null, headTime: 70, nowS: 70 }).run();
    expect((await loadTickState(db, 70)).cursors.base).toMatchObject({ scannedTo: null, headTime: 70 });
  });
});

describe("checks and holds", () => {
  const delivery = (key: string) => ({ batchId: 42n, deliveredKey: h(key), deliveredUid: h(`uid-${key}`), deliveredTx: h(`tx-${key}`), status: "waiting" as const });

  it("keeps two deliveries of one batch id with different keys as two rows", async () => {
    await db.batch([upsertBatchCheck(db, delivery("honest")), upsertBatchCheck(db, { ...delivery("forged"), status: "mismatch", detail: "no matching close" })]);
    const rows = (await db.prepare("SELECT batch_id, delivered_key, status FROM batch_checks ORDER BY status").all()).results;
    expect(rows).toEqual([
      { batch_id: 42, delivered_key: h("forged"), status: "mismatch" },
      { batch_id: 42, delivered_key: h("honest"), status: "waiting" },
    ]);
    await upsertBatchCheck(db, { ...delivery("honest"), status: "ok", queuedBlock: 6_900_500n }).run();
    expect(await db.prepare("SELECT status, queued_block FROM batch_checks WHERE delivered_key = ?").bind(h("honest")).first()).toEqual({ status: "ok", queued_block: 6_900_500 });
  });

  it("never lets a check overwrite an owner's approval", async () => {
    await upsertBatchCheck(db, delivery("k")).run();
    await db.prepare("UPDATE batch_checks SET status = 'ok_by_owner'").run();
    await upsertBatchCheck(db, { ...delivery("k"), status: "mismatch" }).run();
    expect(await db.prepare("SELECT status FROM batch_checks").first("status")).toBe("ok_by_owner");
  });

  it("keeps two landings of one (key, chunk) as two rows", async () => {
    const landing = (n: string, status: "ok" | "mismatch") => ({ landedUid: h(`landed-${n}`), batchKey: h("key"), chunk: 0, landedTx: h(`ltx-${n}`), landedBlock: 37_000_100n, status });
    await db.batch([upsertChunkCheck(db, landing("honest", "ok")), upsertChunkCheck(db, landing("forged", "mismatch"))]);
    expect((await db.prepare("SELECT status FROM chunk_checks WHERE batch_key = ? AND chunk = 0 ORDER BY status").bind(h("key")).all()).results).toEqual([{ status: "mismatch" }, { status: "ok" }]);
  });

  it("gives a hold an opaque public id, and never raises one id twice", async () => {
    await insertHold(db, { id: "bridge.batch:42", rule: "bridge.batch_mismatch", summary: "batch 42 failed the cross-check", raisedAt: 100 }).run();
    await insertHold(db, { id: "bridge.batch:42", rule: "bridge.batch_mismatch", summary: "again", raisedAt: 200 }).run();
    const rows = (await db.prepare("SELECT id, public_id, raised_at FROM holds").all<{ id: string; public_id: string; raised_at: number }>()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0].public_id).toMatch(/^h_[0-9a-f]{8}$/);
    expect(rows[0].raised_at).toBe(100);
  });
});

describe("loadTickState", () => {
  it("is one query, reading at most 2 readings per chain and 25 hour rows", async () => {
    const readings = Array.from({ length: 200 }, (_, i) => insertReading(db, { at: 1000 + i * 60, baseBlock: BigInt(37_000_000 + i * 30), bitBlock: i % 2 ? BigInt(6_900_000 + i * 5) : null, json: "{}" }));
    const hours = Array.from({ length: 100 }, (_, i) => upsertHour(db, 3600 * i, `{"i":${i}}`));
    await db.batch([...readings, ...hours]);
    const c = countingDb(db);
    const s = await loadTickState(c.db, 20_000);
    expect(c.stats.queries).toBe(1);
    // two rows per chain, newest first (a row read for one chain can carry the other's block too)
    expect(s.lastReadings.length).toBeLessThanOrEqual(4);
    expect(s.lastReadings.filter((r) => r.baseBlock !== null).slice(0, 2).map((r) => r.at)).toEqual([1000 + 199 * 60, 1000 + 198 * 60]);
    expect(s.lastReadings.filter((r) => r.bitBlock !== null).map((r) => r.at)).toEqual([1000 + 199 * 60, 1000 + 197 * 60]);
    expect(s.hours).toHaveLength(25);
    expect(s.hours[0].hour).toBe(3600 * 99);
    expect(c.stats.rowsRead).toBeGreaterThan(25);
    expect(c.stats.rowsRead).toBeLessThan(60);
  });

  it("loads open alerts, holds, nonces, pending messages, awaiting reads, pending payout keys and meta", async () => {
    await db.batch([
      db.prepare("INSERT INTO alerts (alert_key, rule, tier, kind, subject, body, runbook, opened_at, last_seen_at) VALUES ('k1','r','critical','event','s','b','rb',1,1)"),
      db.prepare("INSERT INTO alerts (alert_key, rule, tier, kind, subject, body, runbook, opened_at, last_seen_at, resolved_at) VALUES ('k2','r','warning','condition','s','b','rb',1,1,2)"),
      insertHold(db, { id: "price.drop:9", rule: "price.drop", summary: "s", raisedAt: 1 }),
      insertHold(db, { id: "old", rule: "price.drop", summary: "s", raisedAt: 1 }),
      db.prepare("UPDATE holds SET cleared_at = 5 WHERE id = 'old'"),
      db.prepare(`INSERT INTO nonces VALUES ('base', '${USER}', '["owner"]', 3, 4, 9)`),
      db.prepare("INSERT INTO messages (message_id, direction, sender, recipient, amount, src_tx, src_block, src_time) VALUES ('0x01','base>bittensor','0xa','0xb','1','0xt',1,1)"),
      db.prepare("INSERT INTO messages (message_id, direction, sender, recipient, amount, src_tx, src_block, src_time, dst_tx) VALUES ('0x02','base>bittensor','0xa','0xb','1','0xt',1,1,'0xd')"),
      upsertChunkCheck(db, { landedUid: h("l1"), batchKey: h("key"), chunk: 0, landedTx: h("t"), landedBlock: 5n, status: "awaiting_read" }),
      upsertChunkCheck(db, { landedUid: h("l2"), batchKey: h("key"), chunk: 1, landedTx: h("t"), landedBlock: 5n, status: "ok" }),
      upsertBatchCheck(db, { batchId: 1n, deliveredKey: h("q"), deliveredUid: h("u"), deliveredTx: h("t"), status: "ok", queuedBlock: 77n }),
      upsertBatchCheck(db, { batchId: 2n, deliveredKey: h("done"), deliveredUid: h("u2"), deliveredTx: h("t"), status: "ok", queuedBlock: 70n }),
      db.prepare("UPDATE batch_checks SET payout_done_block = 80 WHERE batch_id = 2"),
      setMeta(db, "digest_date", "2026-10-29"),
    ]);
    const s = await loadTickState(db, 100);
    expect(s.openAlerts.map((a) => a.alertKey)).toEqual(["k1"]);
    expect(s.activeHolds.map((x) => x.id)).toEqual(["price.drop:9"]);
    expect(s.holdIds.sort()).toEqual(["old", "price.drop:9"]);
    expect(s.nonces).toEqual([{ chain: "base", address: USER, roles: ["owner"], baseline: 3, nonce: 4, changedAt: 9 }]);
    expect(s.pendingMessages.map((m) => m.messageId)).toEqual(["0x01"]);
    expect(s.awaitingReads.map((c) => c.landedUid)).toEqual([h("l1")]);
    expect(s.pendingPayoutKeys).toEqual([{ key: h("q"), queuedBlock: 77n }]);
    expect(s.meta.digest_date).toBe("2026-10-29");
  });

  it("lists recent payout users not since claimed or delivered, at most 50", async () => {
    const fd = (uid: string, event: string, block: bigint, user: Hex, topic: "topic1" | "topic2") =>
      log({ uid: h(uid), chain: "base", contract: "frontDoor", event, block, [topic]: pad(user) });
    await db.batch([
      ...upsertLogs(db, [
        fd("p1", "PayoutReceived", 100n, USER, "topic2"),
        fd("p2", "PayoutReceived", 100n, OTHER, "topic2"),
        fd("c2", "Claimed", 101n, OTHER, "topic1"),
        fd("old", "PayoutReceived", 10n, "0x00000000000000000000000000000000000000cc", "topic2"),
      ]),
      ...upsertBlocks(db, [
        { chain: "base", number: 100n, time: 1_000_000 },
        { chain: "base", number: 101n, time: 1_000_002 },
        { chain: "base", number: 10n, time: 1_000_000 - 8 * 86400 },
      ]),
    ]);
    const s = await loadTickState(db, 1_000_100);
    expect(s.payoutUsers).toEqual([USER]);
  });
});

describe("pruning and the rest", () => {
  it("keeps the newest 120 readings", async () => {
    await db.batch(Array.from({ length: 130 }, (_, i) => insertReading(db, { at: i, baseBlock: BigInt(i), bitBlock: BigInt(i), json: "{}" })));
    await pruneReadings(db).run();
    const left = (await db.prepare("SELECT MIN(at) AS lo, COUNT(*) AS n FROM readings").first()) as { lo: number; n: number };
    expect(left).toEqual({ lo: 10, n: 120 });
  });

  it("drops hour rows older than 35 days", async () => {
    const now = 100 * 86400;
    await db.batch([upsertHour(db, now - 36 * 86400, "{}"), upsertHour(db, now - 34 * 86400, "{}")]);
    await pruneHours(db, now).run();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM hours").first("n")).toBe(1);
  });

  it("upserts block times and keeps a fetched transaction over one known from arguments", async () => {
    await db.batch(upsertBlocks(db, [{ chain: "base", number: 5n, time: 50 }]));
    await db.batch(upsertBlocks(db, [{ chain: "base", number: 5n, time: 52 }]));
    expect(await db.prepare("SELECT time FROM blocks").first("time")).toBe(52);
    await db.batch(insertTxs(db, [{ chain: "base", hash: h("t"), from: USER, to: OTHER, selector: "0x12345678", nonce: 7 }]));
    await db.batch(insertTxs(db, [{ chain: "base", hash: h("t"), from: USER }]));
    expect(await db.prepare("SELECT from_addr, to_addr, selector, nonce FROM txs").first()).toEqual({ from_addr: USER, to_addr: OTHER, selector: "0x12345678", nonce: 7 });
  });
});
