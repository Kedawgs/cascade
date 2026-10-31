import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runDaily } from "../../src/daily.ts";
import { runHourly, watchdog } from "../../src/hourly.ts";
import { insertReading, setMeta, upsertHour } from "../../src/store.ts";
import { wipe } from "./d1-count.ts";
import { failingBatches, rows, type SentEmail, T0, tickWorld } from "./tick-world.ts";

const db = env.DB;

beforeEach(async () => {
  await wipe(db);
});

/** A world whose emails are sent (to a recording binding), with one complete tick at T0 + 30. */
async function ticked() {
  const w = tickWorld({ over: { ALERT_MODE: "send", ALERT_TO: "owner@example.com" } });
  await w.tick();
  const lastTick = w.nowS();
  const email = { send: async (m: SentEmail) => void w.sent.push(m) } as unknown as SendEmail;
  const deps = (nowS: number, o: { db?: D1Database } = {}) => ({ env: { DB: o.db ?? db, EMAIL: email }, cfg: w.cfg, nowS, fetch: w.net.fetch });
  return { w, lastTick, deps };
}

const open = async () => (await rows<{ alert_key: string; notify_count: number }>("SELECT alert_key, notify_count FROM alerts WHERE resolved_at IS NULL")).map((r) => [r.alert_key, r.notify_count]);

describe("the watchdog", () => {
  it("raises monitor.stalled when the last complete tick is 16 minutes old, not at 14, and emails it itself", async () => {
    const { w, lastTick, deps } = await ticked();
    expect((await runHourly(deps(lastTick + 14 * 60))).watchdog).toEqual({ stalled: false, recorded: false, emailed: false });
    expect(w.sent).toEqual([]);
    expect((await runHourly(deps(lastTick + 16 * 60))).watchdog).toEqual({ stalled: true, recorded: true, emailed: true });
    expect(w.sent.map((m) => m.subject)).toEqual(["[CASCADE CRITICAL] No tick of the monitor has completed for 16 minutes"]);
    expect(await open()).toEqual([["monitor.stalled", 1]]);
  });

  it("sends it again an hour later while unacknowledged, and the next complete tick resolves it", async () => {
    const { w, lastTick, deps } = await ticked();
    await runHourly(deps(lastTick + 16 * 60));
    await runHourly(deps(lastTick + 16 * 60 + 1800));
    expect(w.sent).toHaveLength(1);
    await runDaily(deps(lastTick + 16 * 60 + 3600));
    expect(w.sent.filter((m) => m.subject.startsWith("[CASCADE CRITICAL]"))).toHaveLength(2);
    expect(await open()).toEqual([["monitor.stalled", 2]]);
    w.clock.ms = (lastTick + 16 * 60 + 3700) * 1000;
    await w.tick();
    expect(await open()).toEqual([]);
    expect(w.sent.at(-1)?.subject).toMatch(/^\[Cascade resolved\] No tick of the monitor has completed/);
  });

  it("emails it straight from memory when the record can't be written", async () => {
    const { w, lastTick, deps } = await ticked();
    const readOnly = failingBatches(db, (sql) => !sql.startsWith("SELECT"));
    expect(await watchdog(deps(lastTick + 20 * 60, { db: readOnly }))).toEqual({ stalled: true, recorded: false, emailed: true });
    expect(w.sent.map((m) => m.subject)).toEqual(["[CASCADE CRITICAL] No tick of the monitor has completed for 20 minutes"]);
    expect(await rows("SELECT alert_key FROM alerts")).toEqual([]);
    // the next run, the database still unwritable, emails again (the job's own cadence is the limit)
    await watchdog(deps(lastTick + 80 * 60, { db: readOnly }));
    expect(w.sent).toHaveLength(2);
  });

  it("emails from memory when the database can't even be read", async () => {
    const { w, lastTick, deps } = await ticked();
    const down = failingBatches(db, () => true);
    expect(await watchdog(deps(lastTick + 60, { db: down }))).toEqual({ stalled: true, recorded: false, emailed: true });
    expect(w.sent.map((m) => m.subject)).toEqual(["[CASCADE CRITICAL] The monitor's watchdog can't read its database"]);
    expect(w.sent[0].text).toContain("D1_ERROR");
  });

  it("gives a database no tick ever completed in its 15 minutes from when it first looked", async () => {
    const w = tickWorld({ over: { ALERT_MODE: "send", ALERT_TO: "owner@example.com" } });
    const email = { send: async (m: SentEmail) => void w.sent.push(m) } as unknown as SendEmail;
    const deps = (nowS: number) => ({ env: { DB: db, EMAIL: email }, cfg: w.cfg, nowS, fetch: w.net.fetch });
    expect((await watchdog(deps(T0))).stalled).toBe(false);
    expect((await watchdog(deps(T0 + 600))).stalled).toBe(false);
    expect(await watchdog(deps(T0 + 3600))).toEqual({ stalled: true, recorded: true, emailed: true });
    expect(w.sent[0].subject).toBe("[CASCADE CRITICAL] No tick of the monitor has completed yet");
  });
});

describe("the hourly job", () => {
  it("prunes readings to the newest 120 and hour rows to 35 days", async () => {
    const now = T0;
    await db.batch([
      ...Array.from({ length: 130 }, (_, i) => insertReading(db, { at: now - i * 60, baseBlock: 1n, bitBlock: 1n, json: "{}" })),
      upsertHour(db, now - 36 * 86400, "{}"),
      upsertHour(db, now - 34 * 86400, "{}"),
      setMeta(db, "last_complete_tick", String(now)),
    ]);
    const w = tickWorld();
    expect((await runHourly({ env: { DB: db }, cfg: w.cfg, nowS: now, fetch: w.net.fetch })).pruned).toBe(true);
    expect(await rows("SELECT COUNT(*) AS n FROM readings")).toEqual([{ n: 120 }]);
    expect(await rows("SELECT COUNT(*) AS n FROM hours")).toEqual([{ n: 1 }]);
  });
});

describe("the daily job", () => {
  it("sends the digest once per UTC day, after the watchdog", async () => {
    const { w, lastTick, deps } = await ticked();
    const first = await runDaily(deps(lastTick + 60));
    expect(first).toMatchObject({ digest: "sent", watchdog: { stalled: false } });
    expect(w.sent.map((m) => m.subject)).toEqual([expect.stringMatching(/^\[Cascade daily\] 2027-01-15: OK$/)]);
    expect(w.sent[0].text).toContain("total staked: 50 TAO");
    expect((await runDaily(deps(lastTick + 120))).digest).toBe("already");
    expect(w.sent).toHaveLength(1);
    expect((await runDaily(deps(lastTick + 86400))).digest).toBe("sent");
  });
});
