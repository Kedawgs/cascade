import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { filesUnder, pkg } from "./files.ts";

/** Only the owner's scripts (with Cloudflare account access) clear a hold or approve a check; the Worker
 * never does. A comparison such as `batch_checks.status = 'ok_by_owner'` (keeping an approval) is not a set. */
describe("the Worker never clears a hold or approves a check", () => {
  const src = filesUnder(pkg("src")).map((f) => ({ f, text: readFileSync(f, "utf8") }));

  it("has no UPDATE of holds in src/", () => {
    expect(src.filter((x) => /UPDATE\s+holds/i.test(x.text)).map((x) => x.f)).toEqual([]);
  });

  it("never sets a check to ok_by_owner in src/", () => {
    expect(src.filter((x) => /(?<![.\w])status\s*=\s*'ok_by_owner'/.test(x.text)).map((x) => x.f)).toEqual([]);
  });

  it("the scripts do both, and only they", () => {
    expect(readFileSync(pkg("scripts/sql.ts"), "utf8")).toMatch(/UPDATE holds/);
    expect(readFileSync(pkg("scripts/sql.ts"), "utf8")).toMatch(/status = 'ok_by_owner'/);
  });
});
