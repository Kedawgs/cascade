import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/thresholds.ts";
import { pkg } from "./files.ts";

// The README's keys.* entry (under "When an email arrives") says how a transaction count read from an older head
// than the logs is tolerated, with the threshold's real value, and the trade-offs left: an owner reading it knows why
// a lagging node doesn't page, and what still can (or can't).

describe("the README's keys.* entry", () => {
  const readme = readFileSync(pkg("README.md"), "utf8");
  const start = readme.indexOf("## When an email arrives");
  const section = readme.slice(start, readme.indexOf("\n## ", start + 1));
  const entry = section.split("\n\n").find((p) => p.includes("`keys.keeper_unexplained_tx`")) ?? "";

  it("explains the race tolerance: only a provably stale count, for nonceBehindTicks readings in a row", () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(entry).toContain("`keys.unexplained_tx`");
    expect(entry).toMatch(/older head/);
    expect(entry).toMatch(/provably stale/);
    expect(entry).toContain(`\`nonceBehindTicks\` (${DEFAULTS.nonceBehindTicks}) count readings in a row`);
    expect(entry).toContain("`nonce_behind:<chain>:<address>`");
    expect(entry).toContain("`unexplainedTxGraceS`");
    expect(entry).toMatch(/counted twice/);
    expect(entry).not.toMatch(/short blind spot|minutes in a row/);
  });

  it("names the trade-offs left: an own transaction known only from an event's arguments, and a reorg past the settle depth", () => {
    expect(entry).toMatch(/event's arguments/);
    expect(entry).toMatch(/reorg past the settle depth/);
    expect(entry).toContain("`indexer.reorg`");
  });
});
