import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { VAULT } from "../../src/abi.ts";
import { wipe } from "./d1-count.ts";
import { rawLog } from "./fixtures.ts";
import { h, roundTrip, rows, tickWorld } from "./tick-world.ts";

// A rewind of a chain's scanned_to (the owner's backfill, README "Backfilling missed logs"): the next ticks re-read
// from there. What the store already holds must be recognised, not replayed as new (no event alert fires twice, no
// log is hashed again); what was missing is stored and judged as any new log.

const db = env.DB;
const KEEPER2 = "0x00000000000000000000000000000000000000ee";

beforeEach(async () => {
  await wipe(db);
});

const alertKeys = async () => (await rows<{ alert_key: string }>("SELECT alert_key FROM alerts ORDER BY id")).map((r) => r.alert_key);
const logCount = async () => (await rows<{ n: number }>("SELECT COUNT(*) AS n FROM logs"))[0].n;

describe("a rewind of scanned_to", () => {
  it("replays no alert and hashes nothing for the logs already stored, on either chain", async () => {
    const w = tickWorld({ over: { ALERT_MODE: "send", ALERT_TO: "owner@example.com" } });
    const trip = roundTrip(w.cfg, { id: 1n });
    w.addLogs("base", trip.base);
    w.addLogs("bittensor", trip.bit);
    // an admin event after the baseline: a critical, emailed once
    w.addLogs("bittensor", [rawLog({ address: w.cfg.deployment.vault, abi: VAULT, eventName: "KeeperSet", args: { keeper: KEEPER2 }, block: 6_900_120n, logIndex: 0, txHash: h("keeper set") })]);
    for (let i = 0; i < 4; i++) {
      await w.tick();
      w.advance();
    }
    const before = { alerts: await alertKeys(), logs: await logCount(), sent: w.sent.length };
    expect(before.alerts.filter((k) => k.startsWith("admin.event:"))).toHaveLength(1);
    expect(w.sent.filter((m) => m.subject.includes("Admin event: vault KeeperSet"))).toHaveLength(1);
    const cursors = async () => Object.fromEntries((await rows<{ chain: string; scanned_to: number; settled_to: number }>("SELECT chain, scanned_to, settled_to FROM cursors")).map((r) => [r.chain, r]));
    const settledBefore = await cursors();

    // the backfill: both chains rewound to their start blocks
    await db.batch([
      db.prepare("UPDATE cursors SET scanned_to = ?1 WHERE chain = 'bittensor'").bind(Number(w.cfg.deployment.bittensor.startBlock)),
      db.prepare("UPDATE cursors SET scanned_to = ?1 WHERE chain = 'base'").bind(Number(w.cfg.deployment.base.startBlock)),
    ]);
    const first = await w.tick();
    expect(first.outcome).toBe("done");
    // every log the rewound scan read was recognised by place: nothing hashed or decoded, nothing found
    expect(first.decoded).toBe(0);
    expect(first.findings).toBe(0);
    for (let i = 0; i < 3; i++) {
      w.advance();
      await w.tick();
    }
    expect(await alertKeys()).toEqual(before.alerts);
    expect(await logCount()).toBe(before.logs);
    expect(w.sent.length).toBe(before.sent);
    // the cursors caught up again, the settled point never having moved back
    const after = await cursors();
    for (const c of ["base", "bittensor"] as const) {
      expect(after[c].settled_to).toBeGreaterThanOrEqual(settledBefore[c].settled_to);
      expect(after[c].scanned_to).toBeGreaterThan(settledBefore[c].scanned_to);
    }
  });

  it("stores a log the primary had omitted and runs the rules on it, once the rewind reaches it", async () => {
    const w = tickWorld({ over: { ALERT_MODE: "send", ALERT_TO: "owner@example.com" } });
    const trip = roundTrip(w.cfg, { id: 1n });
    w.addLogs("base", trip.base);
    w.addLogs("bittensor", trip.bit);
    for (let i = 0; i < 4; i++) {
      await w.tick();
      w.advance();
    }
    // the chain moves on past the tick's re-read depth (400 blocks) of the omitted log's block
    w.specs.bittensor.head += 500n;
    await w.tick();
    w.advance();
    await w.tick();
    const before = { alerts: await alertKeys(), logs: await logCount() };
    expect(before.alerts.filter((k) => k.startsWith("admin.event:"))).toEqual([]);
    // the primary never served this admin event; now it does (another node, or the owner's second opinion was
    // right): without a rewind the tick never re-reads that far back
    w.addLogs("bittensor", [rawLog({ address: w.cfg.deployment.vault, abi: VAULT, eventName: "KeeperSet", args: { keeper: KEEPER2 }, block: 6_900_125n, logIndex: 0, txHash: h("the omitted keeper set") })]);
    w.advance();
    await w.tick();
    expect(await alertKeys()).toEqual(before.alerts);
    expect(await logCount()).toBe(before.logs);
    // the backfill
    await db.prepare("UPDATE cursors SET scanned_to = 6900100 WHERE chain = 'bittensor'").run();
    for (let i = 0; i < 4; i++) {
      w.advance();
      await w.tick();
    }
    const keys = await alertKeys();
    expect(keys.filter((k) => k.startsWith("admin.event:"))).toHaveLength(1);
    expect(keys.length).toBe(before.alerts.length + 1);
    expect(await logCount()).toBe(before.logs + 1);
    expect(w.sent.filter((m) => m.subject.includes("Admin event: vault KeeperSet"))).toHaveLength(1);
  });
});
