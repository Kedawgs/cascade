import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromJson } from "../../../ops/src/keeper/core/memory.ts";
import { cronRun } from "../../src/run.ts";

import { chains, closeDue, coordinator, ME, started, keeperRun, testEnv } from "./harness.ts";

// One cron run end to end (design-keeper-worker.md §5): the lease, the memory and the journal through the Durable
// Object, the core's round over the fake chains.

const status = async () => fromJson<{ control: { stopped: boolean; reason: string | null; by: string | null }; memory: { tick: number; final: Record<string, string> } | null; runs: { line: string }[]; lease: { holder: string | null } }>(await coordinator().status({ runs: 200 }));
const journalRows = async () => fromJson<{ status: string; request: { functionName: string; args: unknown[] }; receipt?: { gasUsed: bigint } }[]>(await coordinator().since({ sinceMs: 0 }));

beforeEach(async () => {
  await reset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a cron run", () => {
  it("a first deploy sends nothing: the fresh object reads as stopped, and the run asks no RPC", async () => {
    const c = chains((w) => closeDue(w));
    const r = await keeperRun(testEnv, { print: () => undefined });
    expect(r.outcome).toBe("stopped");
    expect(r.lines).toEqual(["Not run: the keeper is stopped (a new keeper starts stopped: check pnpm ops keeper status, then pnpm ops keeper start)"]);
    expect(c.fetched).toEqual([]);
    expect(c.w.sends).toEqual([]);
    expect(r.calls).toBe(1);
  });

  it("closes a due batch by its id and value, journals it with its receipt, saves the memory and releases the lease", async () => {
    const c = chains((w) => closeDue(w));
    await started();
    const r = await keeperRun(testEnv, { print: () => undefined });
    expect(r.outcome).toBe("ran");
    // R12c: at its max wait (closeDue) the close names minValue 0, so a 1-rao cancel can't hold it past it
    expect(c.w.sends.map((s) => [s.chain, s.fn, s.args])).toEqual([["base", "closeBatch", [7n, 0n]]]);
    const rows = await journalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "landed", request: { functionName: "closeBatch" } });
    expect(rows[0].receipt?.gasUsed).toBe(200_000n);
    const s = await status();
    expect(s.memory?.tick).toBe(1);
    expect(s.lease.holder).toBeNull();
    expect(s.runs.at(-1)?.line).toMatch(/^Round 1 \(lease token \d+\): Done: /);
  });

  it("R12g: a round's quiet skip keeps its reason in the runs table (Skipped this round …), not only in Workers Logs", async () => {
    const c = chains((w) => closeDue(w));
    await started();
    let n = 0;
    const skipped = "Skipped this round (closing the batch): the open batch is not ready to close yet";
    const r = await keeperRun(testEnv, {
      print: () => undefined,
      wrapDeps: (deps) => {
        const read = deps.readState.bind(deps);
        (deps as { readState: typeof deps.readState }).readState = async (o) => {
          // the close's own read, the round's second: the batch is no longer ready (a cancel under every line that held)
          if (++n === 2) c.w.door.canClose = false;
          return read(o);
        };
      },
    });
    expect(r.outcome).toBe("ran");
    expect(c.w.sends).toEqual([]);
    expect(r.lines).toContain(skipped);
    const runs = (await status()).runs.map((x) => x.line);
    expect(runs).toContain(skipped);
    // the summary, the round's last line, names the wait but not why
    expect(runs.find((l) => l.startsWith("Round 1 "))).toMatch(/^Round 1 \(lease token \d+\): nothing due: closing the batch waits: refused by its own read of the chain this round/);
  });

  it("the next run reads on from the saved memory; a round not yet due by the back-off is skipped", async () => {
    chains((w) => closeDue(w));
    await started();
    await keeperRun(testEnv, { print: () => undefined });
    const t = Date.now();
    // the round's back-off says the next round is a minute after the last
    const early = await keeperRun(testEnv, { print: () => undefined, now: () => t + 1_000 });
    expect(early.outcome).toBe("not-due");
    const late = await keeperRun(testEnv, { print: () => undefined, now: () => t + 61_000 });
    expect(late.outcome).toBe("ran");
    expect((await status()).memory?.tick).toBe(2);
  });

  it("two overlapping crons: the second does nothing (one coordinator call, no RPC) while the first holds the lease", async () => {
    const c = chains((w) => closeDue(w));
    await started();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // the first run waits inside its first RPC request until the second has been and gone
    let first = true;
    c.hold.wait = async () => {
      if (first) {
        first = false;
        await gate;
      }
    };
    const one = keeperRun(testEnv, { print: () => undefined });
    await new Promise((r) => setTimeout(r, 50));
    const before = c.fetched.length;
    const two = await keeperRun(testEnv, { print: () => undefined });
    expect(two.outcome).toBe("held");
    expect(two.calls).toBe(1);
    expect(two.lines[0]).toMatch(/^Not run: another cron run \(cron:.+\) holds the lease until /);
    expect(c.fetched.length).toBe(before);
    release();
    const done = await one;
    expect(done.outcome).toBe("ran");
    expect(c.w.sends, done.lines.join(" | ")).toHaveLength(1);
  });

  it("a hold stops everything: nothing is sent while the monitor holds", async () => {
    const c = chains((w) => {
      closeDue(w);
      w.monitor.hold = ["vault.share_price_drop"];
    });
    await started();
    const r = await keeperRun(testEnv, { print: () => undefined });
    expect(c.w.sends).toEqual([]);
    expect(r.lines.some((l) => l.startsWith("HOLD: ") && l.endsWith("until it clears"))).toBe(true);
  });

  it("a hand lease blocks the cron", async () => {
    const c = chains((w) => closeDue(w));
    await started();
    const hand = await coordinator().acquire({ holder: "hand:pc", kind: "hand", ttlMs: 600_000 });
    expect(hand.granted).toBe(true);
    const r = await keeperRun(testEnv, { print: () => undefined });
    expect(r).toMatchObject({ outcome: "held", lines: [expect.stringMatching(/^Not run: a hand run \(hand:pc\) holds the lease until /)] });
    expect(c.fetched).toEqual([]);
  });

  it("a stop takes effect before the next send: stopped after the run's reads, its send is refused before anything is signed", async () => {
    const c = chains((w) => closeDue(w));
    await started();
    // the founder's stop lands after the run has read the chains and decided to close, just before its send's renew
    let renews = 0;
    const r = await keeperRun(testEnv, {
      print: () => undefined,
      coordinator: (e, n) => {
        const s = coordinator(n, e);
        return {
          acquire: (q) => s.acquire(q),
          // the stop lands at the renew just before the send (the first renew is the round's own, before its reads)
          renew: async (q) => {
            if (++renews === 2) await s.stop({ reason: "founder's test", by: "founder" });
            return s.renew(q);
          },
          release: (q) => s.release(q),
          commit: (q) => s.commit(q),
          writeAhead: (q) => s.writeAhead(q),
          replaced: (q) => s.replaced(q),
          update: (q) => s.update(q),
          since: (q) => s.since(q),
          stop: (q) => s.stop(q),
        };
      },
    });
    expect(c.w.sends).toEqual([]);
    expect(r.lines.some((l) => /not sent: the keeper is stopped \(founder's test\)/.test(l))).toBe(true);
    // and later crons don't run
    const next = await keeperRun(testEnv, { print: () => undefined });
    expect(next.outcome).toBe("stopped");
    expect(c.w.sends).toEqual([]);
  });

  it("a self-stop is saved and holds through later crons, until start", async () => {
    // the key's address isn't keeper() on the vault: the core stops itself (KeeperNotReady)
    const c = chains((w) => {
      closeDue(w);
      w.vault.keeper = "0x000000000000000000000000000000000000dEaD";
    });
    await started();
    const r = await keeperRun(testEnv, { print: () => undefined });
    expect(r.stoppedItself, r.lines.join(" | ")).toMatch(/^THE KEEPER STOPPED ITSELF: .*the vault's keeper\(\) is 0x000000000000000000000000000000000000dEaD, not the keeper's key/);
    expect(c.w.sends).toEqual([]);
    const s = await status();
    expect(s.control).toMatchObject({ stopped: true, by: "the keeper itself" });
    for (let i = 0; i < 3; i++) {
      const again = await keeperRun(testEnv, { print: () => undefined, now: () => Date.now() + (i + 1) * 120_000 });
      expect(again.outcome).toBe("stopped");
    }
    expect(c.w.sends).toEqual([]);
    // fixed on chain, and started: it runs again
    c.w.vault.keeper = ME;
    await started();
    const after = await keeperRun(testEnv, { print: () => undefined, now: () => Date.now() + 600_000 });
    expect(after.outcome).toBe("ran");
    expect(c.w.sends.map((x) => x.fn)).toEqual(["closeBatch"]);
  });

  it("a self-stop is saved even when its commit is refused (the lease broken under it)", async () => {
    chains((w) => {
      closeDue(w);
      w.door.keeper = "0x000000000000000000000000000000000000dEaD";
    });
    await started();
    const r = await keeperRun(testEnv, {
      print: () => undefined,
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
    expect(r.stoppedItself).toMatch(/^THE KEEPER STOPPED ITSELF: /);
    expect((await status()).control).toMatchObject({ stopped: true, by: "the keeper itself" });
  });

  it("never throws: a failed acquire, or a memory that doesn't parse, is a failed run, its lease released", async () => {
    chains((w) => closeDue(w));
    await started();
    const broken = await keeperRun(testEnv, {
      print: () => undefined,
      coordinator: () => ({ acquire: async () => Promise.reject(new Error("the object is unreachable")) }) as never,
    });
    expect(broken).toMatchObject({ outcome: "failed", lines: ["Failed this run: the object is unreachable; nothing is saved, and the next run decides"] });
    // a memory that isn't JSON
    await runInDurableObject(coordinator(), (_o, st) => {
      st.storage.sql.exec("INSERT OR REPLACE INTO memory (id, text, v, token, at) VALUES (1, ?, NULL, 0, 0)", "{ not json");
    });
    const r = await keeperRun(testEnv, { print: () => undefined });
    expect(r.outcome).toBe("failed");
    expect(r.lines[0]).toMatch(/^Failed this run: .*JSON/);
    expect((await status()).lease.holder).toBeNull();
  });

  it("the deliveries switch off reads as usdcDelivery off", async () => {
    chains((w) => closeDue(w));
    await started();
    await coordinator().deliveries({ on: false, by: "founder" });
    const r = await keeperRun(testEnv, { print: () => undefined });
    expect(r.lines).toContain("USDC DELIVERY OFF: the keeper's deliveries switch is off: no delivery is sent; credits stay claimable");
  });

  it("the monitor read through the MONITOR binding: one that can't be read stops everything (nothing sent), said once", async () => {
    // the tests' binding answers 503 (vitest.config.ts)
    const c = chains((w) => closeDue(w));
    await started();
    const r = await cronRun(testEnv, { print: () => undefined });
    expect(c.w.sends).toEqual([]);
    expect(r.lines.filter((l) => l.startsWith("THE MONITOR CAN'T SEE: "))).toHaveLength(1);
    expect(r.lines.find((l) => l.startsWith("THE MONITOR CAN'T SEE: "))).toMatch(/HTTP 503.*: nothing is sent until it can$/);
    expect(r.meter?.byMethod.monitor).toBeGreaterThanOrEqual(1);
  });
});
