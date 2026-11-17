import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// pnpm ops reexec <messageId> … is registered in ops/src/cli.ts (Task 52w): its arguments refused by name with its usage,
// and a deployment that isn't v3.2 refused before anything is read; run as the founder runs it, offline (no record named
// by OPS_DEPLOYMENT exists, so nothing is ever read or sent).

const OPS = join(import.meta.dirname, "..", "..", "..", "ops");
const ID = `0x${"ab".repeat(32)}`;

function reexec(...args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, OPS_DEPLOYMENT: `no-such-deployment-${process.pid}` };
  for (const k of Object.keys(env)) if (/^OPS_(KEEPER|V32_KEEPER|HOLD|REEXEC)/.test(k)) delete env[k];
  return spawnSync(process.execPath, ["src/cli.ts", "reexec", ...args], { cwd: OPS, env, encoding: "utf8", timeout: 60_000 });
}

describe("pnpm ops reexec", () => {
  it("its arguments are refused by name, with its usage (exit 2)", () => {
    for (const [args, why] of [
      [[], /pnpm ops reexec: it needs a bridge message id\./],
      [[ID, "--force"], /pnpm ops reexec: --force is not one of its flags\./],
      [[ID, "--from-tx", ID, "--proof", "p.json"], /takes the committee's results from --from-tx or --proof, not both/],
      [[ID, "--without-lease"], /--without-lease needs a reason/],
    ] as [string[], RegExp][]) {
      const r = reexec(...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stdout + r.stderr).toMatch(why);
      expect(r.stdout + r.stderr).toContain('pnpm ops reexec <messageId> [--from-tx <hash> | --proof <file | 0x…> | --empty-proof] [--gas <limit>] [--live] [--send] [--without-lease "<reason>"]');
    }
  });

  it("a deployment that is not v3.2 is refused before anything is read (exit 1)", () => {
    for (const args of [[ID], [ID, "--live", "--send"]]) {
      const r = reexec(...args);
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stdout + r.stderr).toMatch(/pnpm ops reexec is for a v3\.2 deployment: OPS_DEPLOYMENT names no v3\.2 (live|rehearsal) record here; nothing read or sent/);
    }
  });

  it("it takes --ignore-monitor-outage --until <time> as the other one-shots do (Task 52w fix M3): past the parser, refused only for the missing v3.2 record", () => {
    const r = reexec(ID, "--live", "--send", "--ignore-monitor-outage", "--until", "2027-01-18T14:05Z");
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/pnpm ops reexec is for a v3\.2 deployment/);
    const half = reexec(ID, "--ignore-monitor-outage");
    expect(half.status, half.stdout + half.stderr).toBe(2);
    expect(half.stdout + half.stderr).toMatch(/--ignore-monitor-outage needs --until/);
  });

  it("a proof file that can't be read is refused by name (exit 1), before the record is read", () => {
    const r = reexec(ID, "--proof", join(OPS, "no-such-proof.json"));
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/the proof file .*no-such-proof\.json can't be read/);
  });
});
