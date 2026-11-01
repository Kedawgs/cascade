import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/thresholds.ts";
import { pkg } from "./files.ts";

// The README's keys.* entry (under "When an email arrives") says how a transaction count read from an older head
// than the logs is tolerated, with the threshold's real value, so an owner reading it knows why a lagging node
// doesn't page.

describe("the README's keys.* entry", () => {
  const readme = readFileSync(pkg("README.md"), "utf8");
  const start = readme.indexOf("## When an email arrives");
  const section = readme.slice(start, readme.indexOf("\n## ", start + 1));
  const entry = section.split("\n\n").find((p) => p.includes("`keys.keeper_unexplained_tx`")) ?? "";

  it("explains the race tolerance: a count behind the logs isn't comparable yet, for nonceBehindTicks ticks", () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(entry).toContain("`keys.unexplained_tx`");
    expect(entry).toMatch(/older head/);
    expect(entry).toContain(`\`nonceBehindTicks\` (${DEFAULTS.nonceBehindTicks})`);
    expect(entry).toContain("`nonce_behind:<chain>:<address>`");
    expect(entry).toContain("`unexplainedTxGraceS`");
  });
});
