import { describe, expect, it } from "vitest";
import { pkg, readJsonc } from "./files.ts";

interface Wrangler {
  env?: Record<string, { vars?: Record<string, unknown> }>;
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
});
