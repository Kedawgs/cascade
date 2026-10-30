import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

/** `run` refuses to start: another keeper holds the deployment's lock, or the lock can't be read. */
export class RunLockHeld extends Error {}

/** Where `run` for the record at `recordPath` holds its lock: beside the record (deployments/ is
 * git-ignored), one per deployment and kind of run, e.g. deployments/v3-launch.run.lock. */
export const runLockPath = (recordPath: string) => `${recordPath.replace(/\.json$/, "")}.run.lock`;

/** Whether a process with this id is running (signal 0 only asks; EPERM means it runs as someone else). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The PID a lock file names, or undefined when it can't be read as a lock. */
function holder(path: string): number | undefined {
  try {
    const pid = (JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Blocks for `ms` (a takeover's settle time; `run` has nothing else to do yet). */
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Takes `run`'s lock for one deployment: created only when absent, naming this process. A lock whose
 * process is gone (a keeper that was killed) is stale and taken over; one whose process is alive, or that
 * can't be read, is refused (RunLockHeld). So a keeper started by hand can't run beside the supervised
 * one, nor two by hand. A process id Windows has since given to another process reads as alive: the
 * refusal says how to clear it.
 *
 * Two keepers can find the same stale lock at once: each removes it, and the slower one's removal can
 * take the faster one's fresh lock with it. So after a takeover it waits a moment (`settle`, 200 ms) and
 * reads the file again: holding another process's id, it refuses, leaving that lock alone. Returns the
 * release, which removes the lock only while it is still this process's. */
export function takeRunLock(
  path: string,
  o: { pid?: number; alive?: (pid: number) => boolean; log?: (line: string) => void; now?: () => Date; settle?: () => void } = {},
): () => void {
  const pid = o.pid ?? process.pid;
  const alive = o.alive ?? processAlive;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify({ pid, startedAt: (o.now?.() ?? new Date()).toISOString() }), { flag: "wx" });
      if (attempt > 0) {
        // a takeover: another keeper that saw the same stale lock may have replaced this one meanwhile
        (o.settle ?? (() => pause(200)))();
        const now = holder(path);
        if (now !== pid) {
          throw new RunLockHeld(
            `another keeper (PID ${now ?? "unknown"}) took the lock first: ${path} no longer names this process after the stale one was taken over; never run two keepers at once; nothing started`,
          );
        }
      }
      return () => {
        try {
          if (holder(path) === pid) unlinkSync(path);
        } catch {
          // gone already
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const held = holder(path);
    if (held === undefined) {
      throw new RunLockHeld(`${path} exists but can't be read: if no keeper is running for this deployment, delete it; nothing started`);
    }
    if (alive(held)) {
      throw new RunLockHeld(
        `another keeper (PID ${held}) is already running for this deployment: it holds ${path}; never run two keepers at once. If no keeper is running (Windows reused that PID), delete ${path}; nothing started`,
      );
    }
    try {
      unlinkSync(path);
    } catch (e) {
      // another keeper removed it first: the next create, and its check, decide
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    o.log?.(`took over a stale lock: ${path} named PID ${held}, which is gone`);
  }
  throw new RunLockHeld(`could not take ${path}: another keeper took it first; nothing started`);
}
