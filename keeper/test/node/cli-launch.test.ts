import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// v3-launch's supervised `pnpm ops run` is unchanged by Task 50b (the founder's rule; the review's Critical 1): a
// record it can't read at start still stops it with the banner and exit code 3, which the supervisor never restarts,
// whether the record is of the other kind, isn't JSON, or can't be read at all. Run as the supervisor runs it, offline:
// a rehearsal record in ops/deployments/ (git-ignored), named for this test and removed after.

const OPS = join(import.meta.dirname, "..", "..", "..", "ops");
const NAME = `v3-cli-launch-${process.pid}`;
const PATH = join(OPS, "deployments", `rehearsal-${NAME}.json`);

afterEach(() => {
  rmSync(PATH, { recursive: true, force: true });
});

function run() {
  const env: Record<string, string | undefined> = { ...process.env, OPS_DEPLOYMENT: NAME };
  for (const k of Object.keys(env)) if (/^OPS_(KEEPER|V32_KEEPER|HOLD)/.test(k)) delete env[k];
  return spawnSync(process.execPath, ["src/cli.ts", "run"], { cwd: OPS, env, encoding: "utf8", timeout: 60_000 });
}

describe("v3-launch's run, its record unreadable at start", () => {
  const cases: [string, () => void, RegExp][] = [
    ["a record of the other kind", () => writeFileSync(PATH, JSON.stringify({ target: "live", plan: { addresses: {} } })), /is a live record, but this is a rehearsal \(local forks\) run; nothing done/],
    ["a record that isn't JSON", () => writeFileSync(PATH, "{ not json"), /JSON/],
    ["a record that can't be read", () => mkdirSync(PATH, { recursive: true }), /EISDIR|illegal operation on a directory/],
  ];
  for (const [what, make, why] of cases) {
    it(`${what}: "Stopped: …", the banner, exit code 3 (as before Task 50b)`, () => {
      mkdirSync(join(OPS, "deployments"), { recursive: true });
      make();
      const r = run();
      expect(r.status, r.stdout + r.stderr).toBe(3);
      const lines = r.stdout.trim().split(/\r?\n/);
      expect(lines[0]).toMatch(/^Stopped: /);
      expect(lines[0]).toMatch(why);
      expect(lines[1]).toMatch(/^THE KEEPER STOPPED ITSELF: .* \(exit code 3: the supervisor won't restart it\)\. Fix that, then start it again\.$/);
    });
  }

  it('a v3.2 record its own check refuses says its own reason, never "does not read v3.2 yet"; run stops with the banner and exit code 3 all the same (the re-review\'s N7)', () => {
    mkdirSync(join(OPS, "deployments"), { recursive: true });
    // a v3.2 plan with no frozen build: loadRecordV32For's own refusal
    writeFileSync(PATH, JSON.stringify({ target: "rehearsal", plan: { version: 32, addresses: {} } }));
    const r = run();
    expect(r.status, r.stdout + r.stderr).toBe(3);
    const lines = r.stdout.trim().split(/\r?\n/);
    expect(lines[0]).toMatch(/^Stopped: .*names no frozen build, which a v3\.2 record holds from its start; nothing read or sent$/);
    expect(r.stdout + r.stderr).not.toContain("does not read v3.2 yet");
    expect(lines[1]).toMatch(/^THE KEEPER STOPPED ITSELF: .* \(exit code 3: the supervisor won't restart it\)\. Fix that, then start it again\.$/);
  });
});
