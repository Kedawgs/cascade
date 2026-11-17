import { describe, expect, it } from "vitest";
import { DB_BINDING } from "../../scripts/d1.ts";
import { pkg, readJsonc } from "./files.ts";

interface Wrangler {
  env?: Record<string, { vars?: Record<string, unknown>; ratelimits?: { name: string; namespace_id: string; simple: { limit: number; period: number } }[] }>;
}

const BUDGETS = ["SUBREQUEST_BUDGET", "DECODE_BUDGET", "SCAN_WALL_S", "LEASE_S", "SITE_FILES_PER_RUN", "SITE_MAX_BYTES"];

describe("the environments' vars in wrangler.jsonc", () => {
  const env = (readJsonc(pkg("wrangler.jsonc")) as Wrangler).env ?? {};

  it("name the same settings in test and production", () => {
    expect(Object.keys(env.production?.vars ?? {}).sort()).toEqual(Object.keys(env.test?.vars ?? {}).sort());
  });

  it("use the Workers Paid budget profile in both, as the comment's table says", () => {
    const paid = { SUBREQUEST_BUDGET: "200", DECODE_BUDGET: "5000", SCAN_WALL_S: "40", LEASE_S: "180", SITE_FILES_PER_RUN: "20", SITE_MAX_BYTES: "2000000" };
    for (const name of ["test", "production"]) {
      const vars = env[name]?.vars ?? {};
      expect(Object.fromEntries(BUDGETS.map((b) => [b, vars[b]])), name).toEqual(paid);
    }
  });

  it("name STANDBY_HOTKEY in both: blank for test (v3-test has no standby), the plan's standby validator (Yuma) for production's v3.2-launch", () => {
    expect(env.test?.vars?.STANDBY_HOTKEY).toBe("");
    expect(env.production?.vars?.STANDBY_HOTKEY).toBe("0x40c47b6a294686fe9612b5d78dd369f4c77fa3bbf96a4286ede97410ba2e3209");
  });

  it("production is the v3.2 deployment (Task 67, 2026-11-16: DEPLOYMENT.version v3.2, stage early, so v3.2's events and the lenses' readings); test stays on v3-test's contracts, with no version", () => {
    const deployment = (name: string) => env[name]?.vars?.DEPLOYMENT as Record<string, unknown> | undefined;
    expect(deployment("test")?.version).toBeUndefined();
    expect([deployment("production")?.version, deployment("production")?.stage]).toEqual(["v3.2", "early"]);
  });

  it("give the database the binding the owner's scripts name (DB) in both; production's is v3.2-launch's own database, never v3-launch's", () => {
    const dbs = (name: string) => (env[name] as { d1_databases?: { binding: string; database_name: string; database_id: string }[] } | undefined)?.d1_databases ?? [];
    for (const name of ["test", "production"]) expect(dbs(name).map((d) => d.binding), name).toEqual([DB_BINDING]);
    expect(DB_BINDING).toBe("DB");
    expect(dbs("production")[0]).toMatchObject({ database_name: "cascade-indexer-production-v32", database_id: "6c5a5b11-a36b-4352-beba-b61e7d2b142f" });
    // v3-launch's database: a tick refuses a DEPLOYMENT changed under it, so v3.2 is never pointed back at it
    expect(dbs("production")[0]?.database_id).not.toBe("1bfa3258-3d46-4beb-b0c4-6a9e26fa9fc7");
  });

  it("ship fmtao.backing_true without its hold in both (BACKING_HOLD false until a week of readings has set its tolerance)", () => {
    for (const name of ["test", "production"]) expect(env[name]?.vars?.BACKING_HOLD, name).toBe("false");
  });

  it("bind the /v1/scan rate limiter in both (a binding isn't inherited), 60 a minute, each in its own namespace", () => {
    const limits = ["test", "production"].map((name) => env[name]?.ratelimits ?? []);
    for (const l of limits) expect(l.map(({ name, simple }) => ({ name, simple }))).toEqual([{ name: "SCAN_LIMITER", simple: { limit: 60, period: 60 } }]);
    const ids = limits.map((l) => l[0]?.namespace_id);
    for (const id of ids) expect(id).toMatch(/^[1-9]\d{0,8}$/);
    expect(new Set(ids).size).toBe(2);
  });
});
