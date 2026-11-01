import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REREAD } from "../../src/scan.ts";
import { DEFAULTS } from "../../src/thresholds.ts";
import { pkg } from "./files.ts";

// The README's keys.* entry (under "When an email arrives") says how a transaction count read from an older head
// than the logs is tolerated, with the threshold's real value, and the trade-offs left: an owner reading it knows why
// a lagging node doesn't page, and what still can (or can't).

describe("the README's keys.* entry", () => {
  const readme = readFileSync(pkg("README.md"), "utf8");
  const start = readme.indexOf("## When an email arrives");
  const section = readme.slice(start, readme.indexOf("\n## ", start + 1));
  // one paragraph, its line wrapping undone
  const entry = (section.split("\n\n").find((p) => p.includes("`keys.keeper_unexplained_tx`")) ?? "").replace(/\s+/g, " ");

  it("explains the race tolerance: only a provably stale count, held nonceBehindTicks − 1 readings, the count taken on the next", () => {
    const n = DEFAULTS.nonceBehindTicks;
    expect(start).toBeGreaterThanOrEqual(0);
    expect(entry).toContain("`keys.unexplained_tx`");
    expect(entry).toMatch(/older head/);
    expect(entry).toMatch(/provably stale/);
    expect(entry).toContain(`for up to \`nonceBehindTicks\` − 1 (${n - 1}) count readings in a row`);
    expect(entry).toContain(`the \`nonceBehindTicks\`-th (the ${n}th) takes the count`);
    expect(entry).toContain("`nonce_behind:<chain>:<address>`");
    expect(entry).toContain("`unexplainedTxGraceS`");
    expect(entry).toMatch(/counted twice/);
    expect(entry).toMatch(/only `execTransaction`/);
    expect(entry).not.toMatch(/short blind spot|minutes in a row|is refused/);
  });

  it("says a THRESHOLDS or THRESHOLDS_SECRET that would hold past the grace is clamped, with a warning", () => {
    expect(entry).toContain("`THRESHOLDS`");
    expect(entry).toContain("`THRESHOLDS_SECRET`");
    expect(entry).toMatch(/clamped/);
  });

  it("names the trade-offs left, and where a deep reorg is seen: the re-read window, then the hourly logs check", () => {
    expect(entry).toMatch(/event's arguments/);
    expect(entry).toMatch(/reorg past the settle depth/);
    expect(entry).toContain("`indexer.reorg`");
    expect(entry).toContain(`re-read window (${REREAD.base} blocks on Base, ${REREAD.bittensor} on Bittensor)`);
    expect(entry).toMatch(/hourly logs check/);
  });
});
