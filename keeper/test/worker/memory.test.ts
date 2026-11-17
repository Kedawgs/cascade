import { evictDurableObject, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromJson, MEMORY_VERSION, toJson } from "../../../ops/src/keeper/core/memory.ts";

import { chains, closeDue, coordinator, started, keeperRun, testEnv } from "./harness.ts";

// The memory across a redeploy and a version bump (design-keeper-worker.md §4): the Durable Object's storage belongs to
// no Worker version, so a deploy keeps it; the same version resumes, an older one starts afresh (the journal kept), a
// newer one (a rollback) is refused and never written over. (test/node/redeploy.test.ts runs the bundle twice on one
// persisted Miniflare for the same.)

type Status = { memory: { v: number; tick: number; nextAt: number } | null };
const status = async () => fromJson<Status>(await coordinator().status());
const quiet = { print: () => undefined };

/** Writes `text` as the saved memory, under a hand lease of its own */
async function saveMemory(text: string) {
  const c = coordinator();
  const a = await c.acquire({ holder: "hand:test", kind: "hand", ttlMs: 60_000 });
  if (!a.granted) throw new Error("no lease");
  expect((await c.commit({ holder: "hand:test", token: a.token, memory: text, release: true })).ok).toBe(true);
}

beforeEach(async () => {
  await reset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the memory", () => {
  it("survives the object's eviction (a redeploy tears every instance down): the next run resumes it, journal and all", async () => {
    const c = chains((w) => {
      closeDue(w);
      // the close takes the batch with it
      w.fate = (x) => {
        if (x.fn === "closeBatch") {
          w.door.deposits = [];
          w.door.totalDeposits = 0n;
          w.door.id = 8n;
          w.door.start = BigInt(w.time.base);
        }
        return "mine";
      };
    });
    await started();
    const t = Date.now();
    await keeperRun(testEnv, { ...quiet, now: () => t });
    expect((await status()).memory?.tick).toBe(1);
    await evictDurableObject(coordinator());
    const again = await keeperRun(testEnv, { ...quiet, now: () => t + 61_000 });
    expect(again.outcome).toBe("ran");
    const s = await status();
    expect(s.memory?.tick).toBe(2);
    expect(fromJson<unknown[]>(await coordinator().since({ sinceMs: 0 }))).toHaveLength(1);
    // the close it made before the redeploy is in the journal, so nothing was sent twice
    expect(c.w.sends.map((x) => x.fn)).toEqual(["closeBatch"]);
  });

  it("an older version starts afresh, and says so; the journal is kept", async () => {
    chains();
    await started();
    await saveMemory(toJson({ v: MEMORY_VERSION - 1, tick: 41, nextAt: 0 }));
    const r = await keeperRun(testEnv, quiet);
    expect(r.lines).toContain("The saved memory is an older version: this run starts with a fresh one (holds and revert budgets reset, as a restart does); the journal is kept");
    expect((await status()).memory).toMatchObject({ v: MEMORY_VERSION, tick: 1 });
  });

  it("a newer version (after a rollback) is refused, never written over, and nothing is read or sent", async () => {
    const c = chains((w) => closeDue(w));
    await started();
    const newer = toJson({ v: MEMORY_VERSION + 1, tick: 99, nextAt: 0, future: true });
    await saveMemory(newer);
    for (let i = 0; i < 2; i++) {
      const r = await keeperRun(testEnv, quiet);
      expect(r.outcome).toBe("memory-too-new");
      expect(r.lines[0]).toMatch(/^NOT RUNNING: the keeper's saved memory is version 2, newer than this code's 1 \(a rollback\)/);
    }
    expect(c.fetched).toEqual([]);
    expect(c.w.sends).toEqual([]);
    expect((await status()).memory).toMatchObject({ v: MEMORY_VERSION + 1, tick: 99 });
    // and the lease is free again for a hand run or a later deploy
    expect(fromJson<{ lease: { holder: string | null } }>(await coordinator().status()).lease.holder).toBeNull();
  });

  it("a final refusal is shown in the status and can be tried again (T50 M4)", async () => {
    chains();
    await started();
    await saveMemory(toJson({ v: MEMORY_VERSION, tick: 3, nextAt: 0, waiting: {}, held: {}, reverts: {}, skipRuns: {}, refusals: {}, unreceipted: [], failing: 0, unexpected: 0, streak: { refusalsOnly: true, keys: [] }, final: { "payouts:0xab": "REPORT: payout batch 0xab…: NotScheduled" }, reads: {} }));
    const before = fromJson<{ memory: { final: Record<string, string> } }>(await coordinator().status());
    expect(before.memory.final).toEqual({ "payouts:0xab": "REPORT: payout batch 0xab…: NotScheduled" });
    expect(await coordinator().retry({ key: "payouts:0xab", by: "founder" })).toEqual({ ok: true });
    expect(fromJson<{ memory: { final: Record<string, string> } }>(await coordinator().status()).memory.final).toEqual({});
    expect(await coordinator().retry({ key: "payouts:0xab", by: "founder" })).toEqual({ ok: false, why: "nothing final is saved for payouts:0xab" });
  });

  it("a retry takes the lease from a run whose lease ran out, so that run can't commit its memory over it", async () => {
    chains();
    await started();
    await saveMemory(toJson({ v: MEMORY_VERSION, tick: 3, nextAt: 0, waiting: {}, held: {}, reverts: {}, skipRuns: {}, refusals: {}, unreceipted: [], failing: 0, unexpected: 0, streak: { refusalsOnly: true, keys: [] }, final: { "payouts:0xab": "REPORT" }, reads: {} }));
    const c = coordinator();
    const slow = await c.acquire({ holder: "cron:slow", kind: "cron", ttlMs: 5 });
    if (!slow.granted) throw new Error("no lease");
    await new Promise((r) => setTimeout(r, 30));
    expect(await c.retry({ key: "payouts:0xab", by: "founder" })).toEqual({ ok: true });
    expect(await c.commit({ holder: "cron:slow", token: slow.token, memory: toJson({ v: MEMORY_VERSION, final: { "payouts:0xab": "REPORT" } }), release: true })).toMatchObject({ ok: false });
    expect(fromJson<{ memory: { final: Record<string, string> } }>(await c.status()).memory.final).toEqual({});
  });
});
