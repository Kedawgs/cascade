import { reset } from "cloudflare:test";
import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeDeployment } from "../../../ops/src/keeper/core/deployment.ts";
import { type JournalRow, spentOn } from "../../../ops/src/keeper/core/journal.ts";
import { fromJson } from "../../../ops/src/keeper/core/memory.ts";
import { ADDR, deploymentFor, parkInWorld, T, TAO, type World } from "../../../ops/test/keeper-v32-world.ts";
import { chains, closeDue, coordinator, keeperRun, ME, sleep, started, testEnv } from "./harness.ts";

// Task 50a's closed rails through the Worker, end to end in workerd (fix round 1, phase 2): a hold stops a round; the
// founder's exception lets a token park's conversion through a hold during ForeverMoney's migration notice, through the
// Worker's own send path (the lease renewed, the row written ahead); and the spend cap counts a landed send and lets go
// of one whose nonce passed, as the run's start settles the journal.

const quiet = { print: () => undefined };
const MESSAGE: Hex = "0x0102";
const rows = async () => fromJson<JournalRow[]>(await coordinator().since({ sinceMs: 0 }));
let clock = Date.now();
const later = () => {
  clock += 120_000;
  const t = clock;
  return () => t;
};

beforeEach(async () => {
  await reset();
  clock = Date.now();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the Worker on the closed rails", () => {
  it("a hold stops the round: nothing sent, said once", async () => {
    const c = chains((w) => {
      closeDue(w);
      w.monitor.hold = ["vault.share_price_drop"];
    });
    await started();
    const r = await keeperRun(testEnv, quiet);
    const again = await keeperRun(testEnv, { ...quiet, now: later() });
    expect(c.w.sends).toEqual([]);
    expect([...r.lines, ...again.lines].filter((l) => l.startsWith("HOLD: "))).toHaveLength(1);
  });

  it("a token park's conversion during ForeverMoney's migration notice goes under a hold, through the Worker's send path: the real park job, no seam (T50b concern 2)", async () => {
    let park: ReturnType<typeof parkInWorld> | undefined;
    const c = chains((w: World) => {
      closeDue(w);
      w.vault.balance = 10n * TAO;
      w.monitor.hold = ["h-1"];
      w.alpha.migrationReadyAt = BigInt(T + 7 * 86_400);
      // a token park of the front door's to the vault, its message sent on Base and parked on Bittensor
      park = parkInWorld(w, { recipient: ADDR.vault, sender: ADDR.frontDoor, message: MESSAGE });
    });
    await started();
    let renews = 0;
    const r = await keeperRun(testEnv, {
      ...quiet,
      coordinator: (e, n) => {
        const x = coordinator(n, e);
        return { acquire: (q) => x.acquire(q), renew: (q) => (renews++, x.renew(q)), release: (q) => x.release(q), commit: (q) => x.commit(q), writeAhead: (q) => x.writeAhead(q), replaced: (q) => x.replaced(q), update: (q) => x.update(q), since: (q) => x.since(q), stop: (q) => x.stop(q) };
      },
    });
    // the conversion, and nothing else: the close and the stake that are due wait under the hold
    expect(c.w.sends.map((s) => [s.fn, s.to.toLowerCase()]), r.lines.join(" | ")).toEqual([["deliverParked", ADDR.bitAdapter.toLowerCase()]]);
    expect(c.w.sends[0].args).toEqual([ADDR.vault, ADDR.frontDoor, MESSAGE]);
    expect(c.w.parks[(park?.key ?? "0x").toLowerCase()]).toBeUndefined();
    expect(r.lines.some((l) => l.startsWith("MIGRATION NOTICE: ForeverMoney's migration is announced"))).toBe(true);
    expect(renews).toBeGreaterThanOrEqual(2);
    expect((await rows()).map((x) => [x.request.functionName, x.request.rail, x.status])).toEqual([["deliverParked", "migration-conversion", "landed"]]);
    // another token park, without the notice: the same hold sends nothing
    parkInWorld(c.w, { recipient: ADDR.vault, sender: ADDR.frontDoor, message: "0x0304" });
    c.w.alpha.migrationReadyAt = 0n;
    await keeperRun(testEnv, { ...quiet, now: later() });
    expect(c.w.sends).toHaveLength(1);
  });

  it("the spend cap counts a landed send: at the cap, nothing more is sent on that chain", async () => {
    const c = chains((w) => {
      closeDue(w);
      w.fate = (x) => {
        if (x.fn === "closeBatch") {
          // the close takes its batch; the next one is due at once
          w.door.id += 1n;
          w.door.start = BigInt(w.time.base - 90_000);
        }
        return "mine";
      };
    });
    await started();
    // a Base cap a close's float and gas reach
    const env = { ...testEnv, DEPLOYMENT: encodeDeployment(deploymentFor({ keeper: ME, spendCap: { base: 10n ** 15n, bittensor: 100n * TAO } })) };
    await keeperRun(env, quiet);
    expect(c.w.sends.map((x) => x.fn)).toEqual(["closeBatch"]);
    const landed = await rows();
    expect(landed.map((x) => x.status)).toEqual(["landed"]);
    expect(spentOn(landed, "base", Date.now())).toBeGreaterThanOrEqual(10n ** 15n);
    const next = await keeperRun(env, { ...quiet, now: later() });
    expect(c.w.sends).toHaveLength(1);
    expect(next.lines.some((l) => l.startsWith("SPEND CAP: Base: the keeper has sent "))).toBe(true);
    // R12d (M-1): a SPEND CAP line is loud, kept in the runs table pnpm ops keeper status shows (said once a change)
    const runs = fromJson<{ runs: { line: string }[] }>(await coordinator().status({ runs: 50 })).runs.map((x) => x.line);
    expect(runs.some((l) => l.startsWith("SPEND CAP: Base: the keeper has sent "))).toBe(true);
  });

  /** A close broadcast by a run cut off before its receipt (its row "sent", counted at its worst case), then gone from
   * every pool with no receipt, nonce 3 taken by another transaction; and a Base cap under its worst case */
  async function staleClose() {
    const c = chains((w) => {
      closeDue(w);
      w.fate = () => "hold";
    });
    await started();
    let cut = true;
    c.hold.when = (f) => cut && f.method === "eth_getTransactionReceipt";
    void keeperRun(testEnv, { ...quiet, leaseMs: 1_000 });
    for (let i = 0; i < 200 && (await rows())[0]?.status !== "sent"; i++) await sleep(10);
    cut = false;
    c.drop(c.w.sends[0].hash);
    c.w.nonce.base.latest = 4;
    c.w.nonce.base.pending = 4;
    c.w.fate = () => "mine";
    await sleep(1_100);
    return { c, env: { ...testEnv, DEPLOYMENT: encodeDeployment(deploymentFor({ keeper: ME, spendCap: { base: 2n * 10n ** 15n, bittensor: 100n * TAO } })) } };
  }
  const stored = async () => (await rows())[0] as JournalRow;

  it("the spend cap lets go of a send whose nonce passed with no receipt, at two readings a block apart (T51: the first run marks it, the mark kept in the object): then the close goes", async () => {
    const { c, env } = await staleClose();
    // the first reading only marks it, with the head it was read at; still counted, so Base waits at its cap
    const first = await keeperRun(env, { ...quiet, now: later() });
    expect(first.lines.some((l) => l.startsWith("DROPPED"))).toBe(false);
    expect(first.lines.some((l) => l.startsWith("SPEND CAP: Base"))).toBe(true);
    expect([(await stored()).status, (await stored()).passedAt]).toEqual(["sent", Number(c.w.head.base)]);
    // a block later, the next run reads the mark back: the second reading drops it, it no longer counts, the close goes
    c.w.head.base += 1n;
    const r = await keeperRun(env, { ...quiet, now: later() });
    expect(r.lines.some((l) => l.startsWith("DROPPED: transaction") && l.includes("it no longer counts toward the spend cap"))).toBe(true);
    expect(r.lines.some((l) => l.startsWith("SPEND CAP: Base: the keeper"))).toBe(false);
    const after = await rows();
    expect(after.map((x) => [x.status, x.nonce])).toEqual([
      ["dropped", 3],
      ["landed", 4],
    ]);
  });

  it("the settling's mark is stored and read back, its reset to 0 included: seen past, then not (a node behind), then past again, the row drops only at two readings in a row", async () => {
    const { c, env } = await staleClose();
    const head = c.w.head.base;
    await keeperRun(env, { ...quiet, now: later() });
    expect((await stored()).passedAt).toBe(Number(head));
    // a node a block behind answers the nonce not past: the mark is reset, and the object keeps the 0
    c.w.head.base = head + 1n;
    c.w.nonce.base.latest = 3;
    await keeperRun(env, { ...quiet, now: later() });
    expect((await stored()).passedAt).toBe(0);
    expect((await stored()).status).toBe("sent");
    // past again: read back as 0, this is a first reading again (a lost 0 would drop it here, on the old mark)
    c.w.head.base = head + 2n;
    c.w.nonce.base.latest = 4;
    const again = await keeperRun(env, { ...quiet, now: later() });
    expect(again.lines.some((l) => l.startsWith("DROPPED"))).toBe(false);
    expect([(await stored()).status, (await stored()).passedAt]).toEqual(["sent", Number(head + 2n)]);
    c.w.head.base = head + 3n;
    const last = await keeperRun(env, { ...quiet, now: later() });
    expect(last.lines.some((l) => l.startsWith("DROPPED: transaction"))).toBe(true);
    expect((await stored()).status).toBe("dropped");
  });
});
