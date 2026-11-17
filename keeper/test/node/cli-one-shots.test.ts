import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Task 53's one-shots registered in ops/src/cli.ts (claim, adopt, add-hotkey, remove-hotkey, set-stake-hotkey, park), run
// as the founder runs them, offline: no record named by OPS_DEPLOYMENT exists, so nothing is ever read or sent. Their
// arguments are ops' parser's (exit 2 with the usage); a deployment that isn't v3.2 is refused before anything is read
// (exit 1); v3-launch's claim is left as it was.

const OPS = join(import.meta.dirname, "..", "..", "..", "ops");
const HK = `0x${"5e".repeat(32)}`;

function ops(...args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, OPS_DEPLOYMENT: `no-such-deployment-${process.pid}` };
  for (const k of Object.keys(env)) if (/^OPS_(KEEPER|V32_KEEPER|HOLD|REEXEC)/.test(k)) delete env[k];
  return spawnSync(process.execPath, ["src/cli.ts", ...args], { cwd: OPS, env, encoding: "utf8", timeout: 60_000 });
}

describe("Task 53's one-shots in pnpm ops", () => {
  it("a v3.2 one-shot on a deployment that isn't v3.2: refused before anything is read (exit 1), --without-lease and --ignore-monitor-outage taken as the other one-shots take them", () => {
    for (const args of [
      ["adopt", "--live", "--send"],
      ["add-hotkey", HK, "--live", "--send", "--without-lease", "Cloudflare is down"],
      ["remove-hotkey", HK, "--live"],
      ["park", "--live", "--ignore-monitor-outage", "--until", "2027-01-18T14:05Z"],
    ]) {
      const r = ops(...args);
      expect(r.status, `${args.join(" ")}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stdout + r.stderr).toMatch(new RegExp(`pnpm ops ${args[0]} is for a v3\.2 deployment: OPS_DEPLOYMENT names no v3\.2 live record here; nothing read or sent`));
    }
    // v3-launch's claim takes no hotkey and no --send
    const c = ops("claim", HK, "--live", "--send");
    expect(c.status, c.stdout + c.stderr).toBe(1);
    expect(c.stdout + c.stderr).toContain("a hotkey and --send are for a v3.2 deployment's claim");
  });

  it("their arguments are ops' parser's: refused by name with the usage (exit 2)", () => {
    for (const [args, why] of [
      [["add-hotkey", "--live"], /add-hotkey needs the hotkey/],
      [["remove-hotkey", HK, "--frobnicate"], /unexpected argument --frobnicate/],
      [["park", "--send"], /park --send needs the park's key/],
      [["set-stake-hotkey", HK, "--live"], /set-stake-hotkey writes the owner's call for the sign page and sends nothing: add --for-wallet/],
      [["run", "--without-lease", "x"], /--without-lease is for one-shot commands/],
    ] as [string[], RegExp][]) {
      const r = ops(...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stdout + r.stderr).toMatch(why);
      expect(r.stdout + r.stderr).toContain("usage: pnpm ops <command> [--live]");
    }
  });
});
