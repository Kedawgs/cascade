import { describe, expect, it } from "vitest";
import { fromJson, toJson } from "../../../ops/src/keeper/core/memory.ts";
import { ownCoordinator as coordinator, sleep } from "./harness.ts";

// The lease (design-keeper-worker.md §3): acquire, renew, expiry and --break, all fenced by the token.

const row = (hash: string) =>
  toJson({ chain: "base", from: "0x0000000000000000000000000000000000000001", nonce: 3, hashes: [hash], request: { chain: "base", nonce: 3, label: "x", to: "0x0000000000000000000000000000000000000002", abi: [], functionName: "f", args: [] }, raw: "0x01", status: "signed", at: 1 });
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

describe("the lease", () => {
  it("a fresh object reads as stopped: a cron acquire is refused, a hand acquire is not", async () => {
    const c = coordinator();
    const cron = await c.acquire({ holder: "cron:a", kind: "cron", ttlMs: 60_000 });
    expect(cron).toMatchObject({ granted: false, why: "stopped" });
    const hand = await c.acquire({ holder: "hand:pc", kind: "hand", ttlMs: 60_000 });
    expect(hand).toMatchObject({ granted: true, token: 1, renewed: false });
    expect((await c.release({ holder: "hand:pc", token: 1 })).ok).toBe(true);
  });

  it("acquire: free, then refused to another holder naming it; the same holder renews with the same token; the token goes up by one each change of hands", async () => {
    const c = coordinator();
    await c.start({ by: "test" });
    const a = await c.acquire({ holder: "cron:a", kind: "cron", ttlMs: 60_000 });
    expect(a.granted).toBe(true);
    const t = a.granted ? a.token : -1;
    const b = await c.acquire({ holder: "cron:b", kind: "cron", ttlMs: 60_000 });
    expect(b).toMatchObject({ granted: false, why: "held", holder: "cron:a", kind: "cron" });
    const again = await c.acquire({ holder: "cron:a", kind: "cron", ttlMs: 60_000 });
    expect(again).toMatchObject({ granted: true, token: t, renewed: true });
    expect((await c.release({ holder: "cron:a", token: t })).ok).toBe(true);
    const next = await c.acquire({ holder: "cron:b", kind: "cron", ttlMs: 60_000 });
    expect(next).toMatchObject({ granted: true, token: t + 1 });
    await c.release({ holder: "cron:b", token: t + 1 });
  });

  it("renew only while the holder holds that token and the lease has not run out; expiry frees it, and the old holder can no longer write", async () => {
    const c = coordinator();
    await c.start({ by: "test" });
    const a = await c.acquire({ holder: "cron:old", kind: "cron", ttlMs: 30 });
    const t = a.granted ? a.token : -1;
    expect((await c.renew({ holder: "cron:old", token: t + 7, ttlMs: 30 })).ok).toBe(false);
    expect((await c.renew({ holder: "cron:other", token: t, ttlMs: 30 })).ok).toBe(false);
    await sleep(60);
    expect(await c.renew({ holder: "cron:old", token: t, ttlMs: 30 })).toMatchObject({ ok: false, why: expect.stringMatching(/ran out/) });
    expect((await c.writeAhead({ holder: "cron:old", token: t, row: row(h(1)) })).ok).toBe(false);
    const b = await c.acquire({ holder: "cron:new", kind: "cron", ttlMs: 60_000 });
    expect(b).toMatchObject({ granted: true, token: t + 1 });
    // the old holder's commit and write-ahead fail on the token
    expect(await c.commit({ holder: "cron:old", token: t, memory: '{"v":1}', release: true })).toMatchObject({ ok: false, why: expect.stringMatching(/no longer this run's/) });
    expect((await c.writeAhead({ holder: "cron:old", token: t, row: row(h(2)) })).ok).toBe(false);
    expect((await c.writeAhead({ holder: "cron:new", token: t + 1, row: row(h(3)) })).ok).toBe(true);
    expect((await c.commit({ holder: "cron:new", token: t + 1, release: true })).ok).toBe(true);
  });

  it("--break frees it at once and logs who did it; the old holder's renew and commit then fail", async () => {
    const c = coordinator();
    await c.start({ by: "test" });
    const a = await c.acquire({ holder: "hand:stuck", kind: "hand", ttlMs: 600_000 });
    const t = a.granted ? a.token : -1;
    const broken = await c.breakLease({ by: "hand:pc (founder)" });
    expect(broken.was).toMatchObject({ holder: "hand:stuck", token: t });
    expect((await c.renew({ holder: "hand:stuck", token: t, ttlMs: 600_000 })).ok).toBe(false);
    expect((await c.commit({ holder: "hand:stuck", token: t })).ok).toBe(false);
    const b = await c.acquire({ holder: "cron:x", kind: "cron", ttlMs: 60_000 });
    expect(b.granted && b.token).toBeGreaterThan(t);
    if (b.granted) await c.release({ holder: "cron:x", token: b.token });
    const s = JSON.parse(await c.status({ runs: 50 })) as { runs: { line: string }[] };
    expect(s.runs.map((r) => r.line)).toContain(`LEASE BROKEN by hand:pc (founder): it was hand:stuck's (hand, token ${t}, until ${new Date((a.granted && a.until) || 0).toISOString()})`);
  });

  it("a hand lease blocks the cron, and a cron lease blocks a hand run, which then waits ahead of the next cron", async () => {
    const c = coordinator();
    await c.start({ by: "test" });
    const hand = await c.acquire({ holder: "hand:pc", kind: "hand", ttlMs: 600_000 });
    expect(hand.granted).toBe(true);
    expect(await c.acquire({ holder: "cron:1", kind: "cron", ttlMs: 60_000 })).toMatchObject({ granted: false, why: "held", kind: "hand", holder: "hand:pc" });
    if (hand.granted) await c.release({ holder: "hand:pc", token: hand.token });
    const cron = await c.acquire({ holder: "cron:2", kind: "cron", ttlMs: 60_000 });
    expect(cron.granted).toBe(true);
    expect(await c.acquire({ holder: "hand:pc", kind: "hand", ttlMs: 600_000 })).toMatchObject({ granted: false, why: "held", kind: "cron", holder: "cron:2" });
    if (cron.granted) await c.release({ holder: "cron:2", token: cron.token });
    // the hand run asked first: the next cron leaves the lease to it
    expect(await c.acquire({ holder: "cron:3", kind: "cron", ttlMs: 60_000 })).toMatchObject({ granted: false, why: "wanted", holder: "hand:pc" });
    const got = await c.acquire({ holder: "hand:pc", kind: "hand", ttlMs: 600_000 });
    expect(got.granted).toBe(true);
    if (got.granted) await c.release({ holder: "hand:pc", token: got.token });
    expect((await c.acquire({ holder: "cron:4", kind: "cron", ttlMs: 60_000 })).granted).toBe(true);
  });

  it("the kill switch: a cron acquire and a cron renew are refused once it is on, a cron write-ahead too; a hand run's are not", async () => {
    const c = coordinator();
    await c.start({ by: "test" });
    const a = await c.acquire({ holder: "cron:k", kind: "cron", ttlMs: 60_000 });
    const t = a.granted ? a.token : -1;
    await c.stop({ reason: "testing the switch", by: "founder" });
    expect(await c.renew({ holder: "cron:k", token: t, ttlMs: 60_000 })).toMatchObject({ ok: false, why: "the keeper is stopped (testing the switch)" });
    expect((await c.writeAhead({ holder: "cron:k", token: t, row: row(h(9)) })).ok).toBe(false);
    // its commit still saves (a stop ends sends, never the saving of what happened)
    expect((await c.commit({ holder: "cron:k", token: t, release: true })).ok).toBe(true);
    expect(await c.acquire({ holder: "cron:k2", kind: "cron", ttlMs: 60_000 })).toMatchObject({ granted: false, why: "stopped" });
    const hand = await c.acquire({ holder: "hand:pc", kind: "hand", ttlMs: 60_000 });
    expect(hand.granted).toBe(true);
    if (hand.granted) expect((await c.renew({ holder: "hand:pc", token: hand.token, ttlMs: 60_000 })).ok).toBe(true);
    if (hand.granted) await c.release({ holder: "hand:pc", token: hand.token });
  });

  it("a row's status only moves forward: never sent only from signed, a receipt final and over anything else", async () => {
    const c = coordinator();
    const a = await c.acquire({ holder: "hand:j", kind: "hand", ttlMs: 60_000 });
    const t = a.granted ? a.token : -1;
    const status = async (hash: string) => fromJson<{ hashes: string[]; status: string }[]>(await c.since({ sinceMs: 0 })).find((r) => r.hashes[0] === hash)?.status;
    const set = (hash: string, s: string) => c.update({ holder: "hand:j", token: t, patch: toJson([{ hash, patch: { status: s } }]) });
    await c.writeAhead({ holder: "hand:j", token: t, row: row(h(21)) });
    await set(h(21), "sent");
    await set(h(21), "never-sent");
    expect(await status(h(21))).toBe("sent");
    await set(h(21), "landed");
    await set(h(21), "dropped");
    await set(h(21), "never-sent");
    expect(await status(h(21))).toBe("landed");
    await c.writeAhead({ holder: "hand:j", token: t, row: row(h(22)) });
    await set(h(22), "never-sent");
    expect(await status(h(22))).toBe("never-sent");
    // its receipt found after all: landed
    await set(h(22), "landed");
    expect(await status(h(22))).toBe("landed");
  });

  it("clients send durations, never times: a lease lasts at most twice its kind's length", async () => {
    const c = coordinator();
    await c.start({ by: "test" });
    const a = await c.acquire({ holder: "cron:long", kind: "cron", ttlMs: 10 * 86_400_000 });
    expect(a.granted && a.until - a.now).toBe(240_000);
  });
});
