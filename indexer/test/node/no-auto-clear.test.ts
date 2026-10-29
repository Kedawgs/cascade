import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { filesUnder, pkg } from "./files.ts";

/** Only the owner's scripts (with Cloudflare account access) clear a hold or approve a check; the Worker
 * never does. A comparison such as `batch_checks.status = 'ok_by_owner'` (keeping an approval) is not a set. */
const FORBIDDEN: [string, RegExp][] = [
  ["an UPDATE of holds", /UPDATE\s+holds/i],
  ["a DELETE from holds", /DELETE\s+FROM\s+holds/i],
  ["a write to cleared_at", /(?:SET|,)\s*cleared_at\s*=|cleared_at\s*=\s*excluded/i],
  ["an insert that sets cleared_at", /INSERT\s+INTO\s+holds\s*\([^)]*cleared_at/i],
  ["a check set to ok_by_owner", /(?<![.\w])status\s*=\s*'ok_by_owner'/],
  ["a bound ok_by_owner", /\.bind\([^)]*["'`]ok_by_owner["'`]/],
  ["a write to approved_at", /(?:SET|,)\s*approved_at\s*=|approved_at\s*=\s*excluded|INSERT\s+INTO\s+batch_checks\s*\([^)]*approved_at/i],
  ["a write to approved_note", /(?:SET|,)\s*approved_note\s*=/i],
];

describe("the Worker never clears a hold or approves a check", () => {
  const src = filesUnder(pkg("src")).map((f) => ({ f, text: readFileSync(f, "utf8") }));

  for (const [what, re] of FORBIDDEN) {
    it(`has no ${what} in src/`, () => {
      expect(src.filter((x) => re.test(x.text)).map((x) => x.f)).toEqual([]);
    });
  }

  it("the scripts do both, and only they", () => {
    const sql = readFileSync(pkg("scripts/sql.ts"), "utf8");
    expect(sql).toMatch(FORBIDDEN[0][1]);
    expect(sql).toMatch(FORBIDDEN[4][1]);
    expect(sql).toMatch(FORBIDDEN[6][1]);
  });
});
