import { describe, expect, it } from "vitest";
import { main as alertsAck } from "../../scripts/alerts-ack.ts";
import { main as checksApprove } from "../../scripts/checks-approve.ts";
import type { Deps } from "../../scripts/d1.ts";
import { main as holdClear } from "../../scripts/hold-clear.ts";

const KEY = `0x${"ab".repeat(32)}`;

/** A fake wrangler: answers a --json SELECT with `rows`, records every call, never touches a network. */
function fake(rows: Record<string, unknown>[] = []) {
  const calls: string[][] = [];
  const out: string[] = [];
  const deps: Deps = {
    wrangler: async (args) => {
      calls.push(args);
      return args.includes("--json") ? JSON.stringify([{ results: rows, success: true }]) : "ok";
    },
    print: (line) => out.push(line),
    now: () => 1_800_000_000,
  };
  return { deps, calls, out, text: () => out.join("\n") };
}
const sqlOf = (args: string[]) => args[args.indexOf("--command") + 1];

describe("hold:clear", () => {
  it("refuses without exactly one of --id and --all", async () => {
    const f = fake();
    expect(await holdClear(["--env", "test", "--note", "checked"], f.deps)).toBe(2);
    expect(await holdClear(["--env", "test", "--id", "x", "--all", "--note", "checked"], f.deps)).toBe(2);
    expect(f.calls).toEqual([]);
  });

  it("with --dry-run prints the active holds' SELECT, then the UPDATE for that id or public id only", async () => {
    for (const id of ["bridge.batch:42", "h_3f9a0c1e"]) {
      const f = fake();
      expect(await holdClear(["--env", "test", "--dry-run", "--id", id, "--note", "checked: honest batch"], f.deps)).toBe(0);
      expect(f.calls).toEqual([]);
      const t = f.text();
      expect(t.indexOf("SELECT id, public_id, rule, summary, raised_at FROM holds WHERE cleared_at IS NULL")).toBeGreaterThan(-1);
      expect(t).toContain(`UPDATE holds SET cleared_at = 1800000000, cleared_note = 'checked: honest batch' WHERE (id = '${id}' OR public_id = '${id}') AND cleared_at IS NULL`);
      expect(t.indexOf("SELECT")).toBeLessThan(t.indexOf("UPDATE"));
      expect(t).toContain("cascade-indexer-test --env test --remote");
    }
  });

  it("--all clears every active hold (and a `--` separator passed through by pnpm is ignored)", async () => {
    const f = fake();
    expect(await holdClear(["--", "--env", "production", "--dry-run", "--all", "--note", "all checked"], f.deps)).toBe(0);
    expect(f.text()).toContain("UPDATE holds SET cleared_at = 1800000000, cleared_note = 'all checked' WHERE cleared_at IS NULL");
  });

  it("refuses a note with a quote or a backtick, a bad id and an unknown environment", async () => {
    const f = fake();
    expect(await holdClear(["--env", "test", "--id", "x", "--note", "it's fine"], f.deps)).toBe(2);
    expect(await holdClear(["--env", "test", "--id", "x", "--note", "run `rm`"], f.deps)).toBe(2);
    expect(await holdClear(["--env", "test", "--id", "X'; DROP", "--note", "ok"], f.deps)).toBe(2);
    expect(await holdClear(["--env", "staging", "--id", "x", "--note", "ok"], f.deps)).toBe(2);
    expect(f.calls).toEqual([]);
  });

  it("without --dry-run runs the SELECT, prints the holds, then runs the UPDATE", async () => {
    const f = fake([{ id: "bridge.batch:42", public_id: "h_3f9a0c1e", rule: "bridge.batch_mismatch", summary: "s", raised_at: 1 }]);
    expect(await holdClear(["--env", "test", "--id", "h_3f9a0c1e", "--note", "checked"], f.deps)).toBe(0);
    expect(f.calls.map(sqlOf)).toEqual([expect.stringMatching(/^SELECT/), expect.stringMatching(/^UPDATE holds/)]);
    expect(f.text()).toContain("bridge.batch:42");
  });
});

describe("alerts:ack", () => {
  it("prints the UPDATE with --dry-run, and takes digits only", async () => {
    const f = fake();
    expect(await alertsAck(["--env", "test", "12", "--dry-run"], f.deps)).toBe(0);
    expect(f.text()).toContain("UPDATE alerts SET acknowledged_at = 1800000000 WHERE id = 12 AND acknowledged_at IS NULL");
    expect(await alertsAck(["--env", "test", "12 OR 1=1"], f.deps)).toBe(2);
    expect(f.calls).toEqual([]);
  });
});

describe("checks:approve", () => {
  const row = { batch_id: 43, delivered_key: KEY, expected_key: `0x${"cd".repeat(32)}`, status: "mismatch", detail: "5: the batch's key: delivered key …", delivered_tx: `0x${"01".repeat(32)}` };

  it("with --dry-run prints the row (the delivered key next to the expected one), then the UPDATE", async () => {
    const f = fake([row]);
    expect(await checksApprove(["--env", "test", "--key", KEY, "--batch", "43", "--note", "verified by hand", "--dry-run"], f.deps)).toBe(0);
    const t = f.text();
    expect(t).toContain(`delivered key ${KEY}`);
    expect(t).toContain(`expected key  ${row.expected_key}`);
    expect(t).toContain(`UPDATE batch_checks SET status = 'ok_by_owner', approved_note = 'verified by hand', approved_at = unixepoch() WHERE delivered_key = '${KEY}'`);
    expect(t.indexOf("delivered key")).toBeLessThan(t.indexOf("UPDATE"));
    // the SELECT was read; nothing was written
    expect(f.calls.map(sqlOf)).toEqual([expect.stringMatching(/^SELECT .* FROM batch_checks WHERE delivered_key = /)]);
  });

  it("refuses an unknown key, a malformed key, and a key already ok", async () => {
    expect(await checksApprove(["--env", "test", "--key", KEY, "--batch", "43", "--note", "ok", "--dry-run"], fake([]).deps)).toBe(1);
    const bad = fake([row]);
    expect(await checksApprove(["--env", "test", "--key", "0xABC", "--batch", "43", "--note", "ok"], bad.deps)).toBe(2);
    expect(bad.calls).toEqual([]);
    expect(await checksApprove(["--env", "test", "--key", KEY, "--batch", "43", "--note", "ok"], fake([{ ...row, status: "ok" }]).deps)).toBe(1);
  });

  it("makes the owner retype the batch id, and refuses one that isn't the check's", async () => {
    const f = fake([row]);
    expect(await checksApprove(["--env", "test", "--key", KEY, "--note", "ok", "--dry-run"], f.deps)).toBe(2);
    expect(await checksApprove(["--env", "test", "--key", KEY, "--batch", "44", "--note", "ok"], f.deps)).toBe(1);
    expect(f.text()).toContain("batch 43");
    expect(f.calls.map(sqlOf).filter((s) => s.startsWith("UPDATE"))).toEqual([]);
  });

  it("takes hold ids up to 200 characters (a payout landing's is about 150)", async () => {
    const id = `bridge.payout:0x${"ab".repeat(32)}:0:0x${"cd".repeat(32)}`;
    expect(id.length).toBeGreaterThan(120);
    expect(await holdClear(["--env", "test", "--dry-run", "--id", id, "--note", "ok"], fake().deps)).toBe(0);
    expect(await holdClear(["--env", "test", "--dry-run", "--id", "a".repeat(201), "--note", "ok"], fake().deps)).toBe(2);
  });

  it("without --dry-run runs the UPDATE after printing the row", async () => {
    const f = fake([row]);
    expect(await checksApprove(["--env", "test", "--key", KEY, "--batch", "43", "--note", "verified"], f.deps)).toBe(0);
    expect(f.calls.map(sqlOf)).toEqual([expect.stringMatching(/^SELECT/), expect.stringMatching(/^UPDATE batch_checks SET status = 'ok_by_owner'/)]);
  });
});
