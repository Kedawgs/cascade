import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { processAlive, RunLockHeld, runLockPath, takeRunLock } from "../src/keeper/runlock.ts";

const dir = () => mkdtempSync(join(tmpdir(), "ops-runlock-"));

describe("pnpm ops run holds a lock for its deployment, so two keepers never run at once", () => {
  it("sits beside the record", () => {
    expect(runLockPath(join("deployments", "v3-launch.json"))).toBe(join("deployments", "v3-launch.run.lock"));
  });

  it("is taken when free, names its process, and is released only by its holder", () => {
    const path = join(dir(), "v3-launch.run.lock");
    const release = takeRunLock(path, { pid: 4242, alive: () => true });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ pid: 4242 });
    // another process's lock now sits there: this holder's release leaves it alone
    writeFileSync(path, JSON.stringify({ pid: 777 }));
    release();
    expect(existsSync(path)).toBe(true);
    writeFileSync(path, JSON.stringify({ pid: 4242 }));
    release();
    expect(existsSync(path)).toBe(false);
  });

  it("refuses while the process that holds it is alive", () => {
    const path = join(dir(), "v3-launch.run.lock");
    takeRunLock(path, { pid: 4242, alive: () => true });
    expect(() => takeRunLock(path, { pid: 5151, alive: (pid) => pid === 4242 })).toThrow(RunLockHeld);
    expect(() => takeRunLock(path, { pid: 5151, alive: (pid) => pid === 4242 })).toThrow(/another keeper \(PID 4242\) is already running.*never run two keepers at once/);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ pid: 4242 });
  });

  it("takes over a lock whose process is gone, and says so", () => {
    const path = join(dir(), "v3-launch.run.lock");
    writeFileSync(path, JSON.stringify({ pid: 4242, startedAt: "2026-10-30T00:00:00.000Z" }));
    const said: string[] = [];
    takeRunLock(path, { pid: 5151, alive: () => false, log: (l) => void said.push(l) });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ pid: 5151 });
    expect(said).toEqual([`took over a stale lock: ${path} named PID 4242, which is gone`]);
  });

  it("after taking over a stale lock, checks the file is still its own: a racer's lock is refused, and left alone", () => {
    const path = join(dir(), "v3-launch.run.lock");
    writeFileSync(path, JSON.stringify({ pid: 4242 }));
    // another keeper saw the same stale lock, removed this one's fresh lock and wrote its own meanwhile
    const racer = () => writeFileSync(path, JSON.stringify({ pid: 6161, startedAt: "2026-10-30T00:00:01.000Z" }));
    expect(() => takeRunLock(path, { pid: 5151, alive: () => false, settle: racer })).toThrow(RunLockHeld);
    expect(() => {
      writeFileSync(path, JSON.stringify({ pid: 4242 }));
      takeRunLock(path, { pid: 5151, alive: () => false, settle: racer });
    }).toThrow(/another keeper \(PID 6161\) took the lock first.*nothing started/);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ pid: 6161 });
    // with no racer, the takeover holds
    writeFileSync(path, JSON.stringify({ pid: 4242 }));
    takeRunLock(path, { pid: 5151, alive: () => false, settle: () => undefined });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ pid: 5151 });
  });

  it("refuses a lock it can't read, saying how to clear it", () => {
    const path = join(dir(), "v3-launch.run.lock");
    writeFileSync(path, "{not json");
    expect(() => takeRunLock(path, { pid: 5151, alive: () => false })).toThrow(/can't be read.*delete it/);
  });

  it("tells a live process from one that isn't", () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2 ** 31 - 2)).toBe(false);
  });
});
