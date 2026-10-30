import { describe, expect, it } from "vitest";
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

  it("bind the /v1/scan rate limiter in both (a binding isn't inherited), 60 a minute, each in its own namespace", () => {
    const limits = ["test", "production"].map((name) => env[name]?.ratelimits ?? []);
    for (const l of limits) expect(l.map(({ name, simple }) => ({ name, simple }))).toEqual([{ name: "SCAN_LIMITER", simple: { limit: 60, period: 60 } }]);
    const ids = limits.map((l) => l[0]?.namespace_id);
    for (const id of ids) expect(id).toMatch(/^[1-9]\d{0,8}$/);
    expect(new Set(ids).size).toBe(2);
  });
});
