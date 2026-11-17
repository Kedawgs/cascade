import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spentOf, spentOn } from "../../../ops/src/keeper/core/journal.ts";
import { fromJson } from "../../../ops/src/keeper/core/memory.ts";
import type { World } from "../../../ops/test/keeper-v32-world.ts";
import type { KeeperEnv } from "../../src/config.ts";
import type { CoordinatorApi } from "../../src/run.ts";
import { chains, closeDue, coordinator, sleep, started, keeperRun, testEnv } from "./harness.ts";

// A run cut off mid-transaction (design-keeper-worker.md §5): before the broadcast, after it, or after the receipt
// but before the commit. The next runs settle each from the journal, and no second transaction ever goes out for it.

type Row = { status: string; nonce: number; hashes: string[]; request: { functionName: string }; receipt?: { costWei: bigint } };
const rows = async () => fromJson<Row[]>(await coordinator().since({ sinceMs: 0 }));
const quiet = { print: () => undefined };
/** The clock a later run sees: past the earlier run's lease and back-off */
let clock = Date.now();
const later = () => {
  clock += 120_000;
  const t = clock;
  return () => t;
};

/** A close that lands takes the open batch with it: the door opens batch 8, empty. */
const closing = (w: World) => (c: { fn: string }) => {
  if (c.fn === "closeBatch") {
    w.door.id = 8n;
    w.door.deposits = [];
    w.door.totalDeposits = 0n;
    w.door.start = BigInt(w.time.base);
  }
};

/** The stub, with the run's commit held forever: the run is cut off after everything else */
const commitNever = (e: KeeperEnv, n: string): CoordinatorApi => {
  const s = coordinator(n, e);
  return {
    acquire: (q) => s.acquire(q),
    renew: (q) => s.renew(q),
    release: (q) => s.release(q),
    commit: () => new Promise(() => undefined),
    writeAhead: (q) => s.writeAhead(q),
    replaced: (q) => s.replaced(q),
    update: (q) => s.update(q),
    since: (q) => s.since(q),
    stop: (q) => s.stop(q),
  };
};

/** Waits until `f` holds (the cut-off run reached its point), at most 2 s */
async function until(f: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await f()) return;
    await sleep(10);
  }
  throw new Error("the cut-off run never got there");
}

beforeEach(async () => {
  await reset();
  clock = Date.now();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a run cut off mid-transaction settles without a second transaction", () => {
  it("before the broadcast: the next run holds the chain's sends, the one after marks it never sent and decides afresh; the old one is never broadcast", async () => {
    const c = chains((w) => closeDue(w));
    await started();
    let cut = true;
    c.hold.when = (f) => cut && f.method === "eth_sendRawTransaction";
    void keeperRun(testEnv, { ...quiet, leaseMs: 1_000 });
    await until(async () => (await rows()).length === 1);
    const [ahead] = await rows();
    expect(ahead).toMatchObject({ status: "signed", nonce: 3, request: { functionName: "closeBatch" } });
    expect(c.w.sends).toEqual([]);
    cut = false;
    await sleep(1_100);

    const second = await keeperRun(testEnv, { ...quiet, now: later() });
    expect(second.outcome).toBe("ran");
    expect(second.lines.some((l) => l.startsWith("Settling: close batch 7") && l.includes("nothing is sent on Base this run"))).toBe(true);
    expect(c.w.sends).toEqual([]);
    expect((await rows())[0].status).toBe("signed");

    // meanwhile a deposit landed: the batch the keeper decides on afresh is not the one it signed for (R12c: at its max
    // wait its minValue is 0 whatever it holds, so the bigger message's bridge fee, and the float sent, tell it apart)
    c.w.door.deposits.push({ user: "0x000000000000000000000000000000000000de02", amount: 10n ** 18n });
    c.w.door.totalDeposits = 3n * 10n ** 18n;
    c.w.door.closeFee = 10n ** 15n;
    const third = await keeperRun(testEnv, { ...quiet, now: later() });
    expect(third.lines.some((l) => l.startsWith("NEVER SENT: close batch 7") && l.includes("no node has known it for two runs"))).toBe(true);
    // decided afresh: one close, at the same nonce, and the old signed transaction never went out
    expect(c.w.sends, third.lines.join(" | ")).toHaveLength(1);
    expect(c.w.sends[0].hash).not.toBe(ahead.hashes[0]);
    expect(c.w.sends[0].args).toEqual([7n, 0n]);
    expect(c.w.sends[0].value).toBe(3n * 10n ** 15n);
    const after = await rows();
    expect(after.map((r) => [r.status, r.nonce])).toEqual([
      ["never-sent", 3],
      ["landed", 3],
    ]);
  });

  it("before the broadcast, the same bytes signed again in the run that marks it never sent: one row, landed, and the spend cap counts it", async () => {
    const c = chains((w) => closeDue(w));
    await started();
    let cut = true;
    c.hold.when = (f) => cut && f.method === "eth_sendRawTransaction";
    void keeperRun(testEnv, { ...quiet, leaseMs: 1_000 });
    await until(async () => (await rows()).length === 1);
    const [ahead] = await rows();
    cut = false;
    await sleep(1_100);
    await keeperRun(testEnv, { ...quiet, now: later() });
    // nothing changed on chain: the run that marks it never sent decides the same close, at the same nonce and fees, so
    // signs the very same bytes, and that transaction lands
    const third = await keeperRun(testEnv, { ...quiet, now: later() });
    expect(third.lines.some((l) => l.startsWith("NEVER SENT: close batch 7"))).toBe(true);
    expect(c.w.sends.map((x) => x.hash)).toEqual([ahead.hashes[0]]);
    const after = await rows();
    expect(after.map((r) => [r.status, r.nonce, r.hashes])).toEqual([["landed", 3, ahead.hashes]]);
    expect(spentOn(after as never, "base", Date.now())).toBeGreaterThanOrEqual(after[0].receipt?.costWei ?? 1n);
    expect(spentOf(after[0] as never)).toBeGreaterThan(0n);
  });

  it("a row marked never sent is so in the object at once: a run cut off after marking it doesn't leave it signed", async () => {
    const c = chains((w) => closeDue(w));
    await started();
    let cut = true;
    c.hold.when = (f) => cut && f.method === "eth_sendRawTransaction";
    void keeperRun(testEnv, { ...quiet, leaseMs: 1_000 });
    await until(async () => (await rows()).length === 1);
    cut = false;
    await sleep(1_100);
    await keeperRun(testEnv, { ...quiet, now: later() });
    // the run that marks it never sent is cut off right after, at its next estimate (before anything is signed)
    let cutEstimate = true;
    c.hold.when = (f) => cutEstimate && f.method === "eth_estimateGas";
    void keeperRun(testEnv, { ...quiet, leaseMs: 1_000, now: later() });
    await until(async () => (await rows())[0]?.status !== "signed");
    expect((await rows())[0].status).toBe("never-sent");
    cutEstimate = false;
  });

  it("after the broadcast, before the receipt: the next run watches it from the journal, sends nothing while it is pending, and records it once it lands", async () => {
    const c = chains((w) => {
      closeDue(w);
      w.fate = () => "hold";
    });
    await started();
    let cut = true;
    c.hold.when = (f) => cut && f.method === "eth_getTransactionReceipt";
    void keeperRun(testEnv, { ...quiet, leaseMs: 1_000 });
    await until(async () => (await rows())[0]?.status === "sent");
    expect(c.w.sends).toHaveLength(1);
    const hash = c.w.sends[0].hash;
    cut = false;
    await sleep(1_100);

    // still pending: watched, and the nonce guard holds every send
    const second = await keeperRun(testEnv, { ...quiet, now: later() });
    expect(second.lines.some((l) => l.startsWith("Settling: close batch 7") && l.includes("it is watched from now"))).toBe(true);
    expect(c.w.sends).toHaveLength(1);
    const saved = fromJson<{ memory: { watching: { hashes: string[] }[] } }>(await coordinator().status());
    expect(saved.memory.watching.map((u) => u.hashes)).toEqual([[hash]]);

    // it lands (and the batch with it): the next run records it, and sends nothing more
    closing(c.w)(c.w.sends[0]);
    c.mine(hash);
    const third = await keeperRun(testEnv, { ...quiet, now: later() });
    expect(third.lines.some((l) => l.startsWith("Late receipt: close batch 7") && l.includes("went through"))).toBe(true);
    expect(c.w.sends).toHaveLength(1);
    expect((await rows()).map((r) => r.status)).toEqual(["landed"]);
  });

  it("after the broadcast, its transaction since dropped from every pool: still watched (today's rules), never marked never sent", async () => {
    const c = chains((w) => {
      closeDue(w);
      w.fate = () => "hold";
    });
    await started();
    let cut = true;
    c.hold.when = (f) => cut && f.method === "eth_getTransactionReceipt";
    void keeperRun(testEnv, { ...quiet, leaseMs: 1_000 });
    await until(async () => (await rows())[0]?.status === "sent");
    cut = false;
    c.drop(c.w.sends[0].hash);
    // the nonce is free again: the next run may close at it (a deposit since makes it another transaction: R12c, by its
    // bigger message's bridge fee, as minValue is 0 at the max wait), and it lands
    c.w.fate = () => "mine";
    c.w.door.deposits.push({ user: "0x000000000000000000000000000000000000de02", amount: 10n ** 18n });
    c.w.door.totalDeposits = 3n * 10n ** 18n;
    c.w.door.closeFee = 10n ** 15n;
    await sleep(1_100);
    const next = await keeperRun(testEnv, { ...quiet, now: later(), sleep: async () => undefined });
    expect(next.lines.some((l) => l.startsWith("Settling: close batch 7") && l.includes("it is watched from now"))).toBe(true);
    expect(next.lines.some((l) => l.startsWith("NEVER SENT"))).toBe(false);
    // the old one is watched still; the new close at its nonce landed (two transactions at one nonce never both land)
    expect((await rows()).map((r) => [r.status, r.nonce])).toEqual([
      ["sent", 3],
      ["landed", 3],
    ]);
  });

  it("after the receipt, before the commit: the next run reads the same receipt and applies it once; nothing is sent again", async () => {
    const c = chains((w) => {
      closeDue(w);
      const land = closing(w);
      w.fate = (x) => {
        land(x);
        return "mine";
      };
    });
    await started();
    void keeperRun(testEnv, { ...quiet, leaseMs: 1_000, coordinator: commitNever });
    await until(async () => (await rows())[0]?.status === "sent" && c.w.sends.length === 1 && Object.keys(c.w.receipts).length === 1);
    await sleep(1_100);
    // the run's memory was never saved, and its row still reads "sent"
    expect(fromJson<{ memory: unknown }>(await coordinator().status()).memory).toBeNull();
    expect((await rows())[0].status).toBe("sent");

    const next = await keeperRun(testEnv, { ...quiet, now: later() });
    expect(next.outcome).toBe("ran");
    expect(next.lines.filter((l) => l.startsWith("Late receipt: close batch 7"))).toHaveLength(1);
    expect(c.w.sends).toHaveLength(1);
    expect((await rows()).map((r) => r.status)).toEqual(["landed"]);
    // and once applied it is gone from the watch: a later run says nothing more of it
    const after = await keeperRun(testEnv, { ...quiet, now: later() });
    expect(after.lines.some((l) => l.includes("close batch 7"))).toBe(false);
    expect(c.w.sends).toHaveLength(1);
  });

  it("a run that lost its lease mid-round writes nothing over the new holder's state", async () => {
    chains((w) => closeDue(w));
    await started();
    const s = coordinator();
    // the run's commit finds the lease broken under it
    const r = await keeperRun(testEnv, {
      ...quiet,
      coordinator: (e, n) => {
        const x = coordinator(n, e);
        return {
          acquire: (q) => x.acquire(q),
          renew: (q) => x.renew(q),
          release: (q) => x.release(q),
          commit: async (q) => {
            await x.breakLease({ by: "the founder" });
            return x.commit(q);
          },
          writeAhead: (q) => x.writeAhead(q),
          replaced: (q) => x.replaced(q),
          update: (q) => x.update(q),
          since: (q) => x.since(q),
          stop: (q) => x.stop(q),
        };
      },
    });
    expect(r.outcome).toBe("lease-lost");
    expect(r.lines.some((l) => l.startsWith("LEASE LOST: this run's memory was not saved"))).toBe(true);
    expect(fromJson<{ memory: unknown }>(await s.status()).memory).toBeNull();
    // the row it wrote ahead is there for the next run, which settles it once
    expect((await rows()).map((x) => x.status)).toEqual(["sent"]);
  });
});
