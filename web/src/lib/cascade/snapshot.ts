import { createCascadeData } from "./index";
import type { CascadeData, ProtocolStats } from "./types";

/** The figures the first HTML carries: read on the server (once at `next build`; under `next dev`, at
 * most every ten minutes) so the APY and the protocol figures are on screen before the browser has
 * read anything, and the page doesn't move when they arrive. The browser's live reads then replace
 * them. A figure that couldn't be read is left out.
 *
 * `next build` gives every page the same snapshot only because it renders them all in one worker: Next
 * starts another static-generation worker for each 25 pages (`staticGenerationMinPagesPerWorker`), so
 * past 25 routes each worker reads its own, and pages may carry slightly different figures. */
export interface Snapshot {
  /** When the reads finished, in ms since the epoch: the figures' age. */
  at: number;
  apyPercent?: number;
  stats?: ProtocolStats;
}

export interface SnapshotDeps {
  /** The same data source the browser uses (it reads nothing when no deployment is configured). */
  createData(): CascadeData;
  now(): number;
  /** One deadline for both reads: a slow chain never holds up the build for long. */
  timeoutMs: number;
  /** How old a snapshot may get before the next request reads again. */
  refreshMs: number;
}

const TIMEOUT_MS = 10_000;
const REFRESH_MS = 10 * 60_000;

/** A read, or undefined once it fails or the deadline passes. */
const settle = <T>(read: () => Promise<T>, deadline: Promise<undefined>): Promise<T | undefined> =>
  Promise.race([
    Promise.resolve()
      .then(read)
      .catch(() => undefined),
    deadline,
  ]);

async function readSnapshot(deps: SnapshotDeps): Promise<Snapshot> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const data = deps.createData();
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(resolve, deps.timeoutMs, undefined);
    });
    const [apyPercent, stats] = await Promise.all([settle(() => data.getApy(), deadline), settle(() => data.getProtocolStats(), deadline)]);
    return { at: deps.now(), ...(apyPercent !== undefined ? { apyPercent } : {}), ...(stats !== undefined ? { stats } : {}) };
  } catch {
    // never fails the page (or the build): the browser reads the figures itself
    return { at: deps.now() };
  } finally {
    clearTimeout(timer);
  }
}

/** One snapshot per process, read again once it is `refreshMs` old. Only the very first call waits for
 * its read; after that a call is served the last snapshot that finished while the next one is read, so
 * no request under `next dev` waits on the chain. Never rejects. */
export function createSnapshotLoader(given: Partial<SnapshotDeps> = {}): () => Promise<Snapshot> {
  const deps: SnapshotDeps = { createData: createCascadeData, now: Date.now, timeoutMs: TIMEOUT_MS, refreshMs: REFRESH_MS, ...given };
  let reading: { startedAt: number; snapshot: Promise<Snapshot> } | null = null;
  let finished: Promise<Snapshot> | null = null;
  return () => {
    const now = deps.now();
    if (!reading || now - reading.startedAt >= deps.refreshMs) {
      const snapshot = readSnapshot(deps);
      reading = { startedAt: now, snapshot };
      void snapshot.then(() => {
        finished = snapshot;
      });
    }
    return finished ?? reading.snapshot;
  };
}

export const loadSnapshot = createSnapshotLoader();
