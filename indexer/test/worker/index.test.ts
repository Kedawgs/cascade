import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CRONS } from "../../src/crons.ts";
import worker from "../../src/index.ts";
import { setMeta } from "../../src/store.ts";
import { rowCounts, TABLES, wipe } from "./d1-count.ts";

const db = env.DB;

describe("the Worker's two handlers", () => {
  it("answers a path it doesn't serve with 404", async () => {
    const res = await exports.default.fetch("https://x/nope");
    expect(res.status).toBe(404);
    await res.text();
  });
});

describe("scheduled runs each cron's own job", () => {
  // no test reaches the network: every request the jobs make fails at once
  let asked: string[];
  beforeEach(async () => {
    await wipe(db);
    asked = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      asked.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      throw new TypeError("no network in tests");
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const run = async (cron: string, scheduledTime = Date.now()) => {
    const ctx = createExecutionContext();
    await expect(worker.scheduled(createScheduledController({ cron, scheduledTime }), env, ctx)).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx);
  };
  const meta = async () => Object.fromEntries((await db.prepare("SELECT k, v FROM meta").all<{ k: string; v: string }>()).results.map((r) => [r.k, r.v]));

  it("the tick: with every request failing it still commits, head_time from the clock", async () => {
    await run(CRONS.tick);
    const m = await meta();
    expect(Number(m.last_complete_tick)).toBeGreaterThan(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM cursors WHERE head_time IS NOT NULL").first("n")) as number).toBe(2);
    expect(asked.length).toBeGreaterThan(0);
  });

  it("the site check runs the site job, never the tick's work", async () => {
    await run(CRONS.site);
    const m = await meta();
    expect(m.site_fail_since).toBeDefined();
    expect(m.last_complete_tick).toBeUndefined();
    const n = await rowCounts(db);
    expect(n.cursors + n.lease + n.logs + n.readings).toBe(0);
  });

  it("the hourly job runs the watchdog, at the cron's scheduled time (its resends exactly an hour apart)", async () => {
    // a last tick an hour ahead of the wall clock: only the scheduled time, 16 minutes after it, says stalled
    const last = Math.floor(Date.now() / 1000) + 3600;
    await setMeta(db, "last_complete_tick", String(last)).run();
    await run(CRONS.hourly, (last + 16 * 60) * 1000);
    expect((await db.prepare("SELECT alert_key, notified_at FROM alerts").all()).results).toEqual([{ alert_key: "monitor.stalled", notified_at: last + 16 * 60 }]);
  });

  it("the daily job sends the digest once a UTC day, the day it was scheduled for", async () => {
    const at = Date.UTC(2030, 0, 1, 13, 0, 0);
    await setMeta(db, "last_complete_tick", String(at / 1000)).run();
    await run(CRONS.daily, at);
    expect((await meta()).digest_date).toBe("2030-01-01");
  });

  it("does nothing for a cron it doesn't run", async () => {
    await run("*/5 * * * *");
    const n = await rowCounts(db);
    expect(TABLES.every((t) => n[t] === 0)).toBe(true);
    expect(asked).toEqual([]);
  });
});
