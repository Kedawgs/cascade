import { createClients } from "./chain";
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
  /** What one TAO sold for then, in dollars: for the home page's total in dollars alone. It is as old as the build, so
   * it is never shown as the TAO price (hooks.ts useTaoPrice). */
  taoPriceUsd?: number;
}

export interface SnapshotDeps {
  /** The same data source the browser uses (it reads nothing when no deployment is configured). */
  createData(): CascadeData;
  now(): number;
  /** One deadline for the quick reads together (the total staked and the TAO price, each a read of today's state): a
   * slow chain never holds them up for long. */
  timeoutMs: number;
  /** The yield's own deadline: it reads 30-day-old state, which Bittensor's public archive node can take most of a
   * minute to answer (reads.ts readApyPercent), so under the quick reads' deadline the first HTML rarely had a yield. */
  apyTimeoutMs: number;
  /** How old a snapshot may get before the next request reads again. */
  refreshMs: number;
}

/** At `next build` (a build step waits, no visitor does): the total staked and the TAO price get 30 s, since a read of
 * today's state took Bittensor's public node 18 s on a slow evening; the yield gets 90 s, for its read of 30-day-old
 * state. Every page waits for the snapshot, so both stay well under what Next gives a static page before it starts the
 * page again and, after three tries, fails the build (`staticPageGenerationTimeout`: 150 s, next.config.ts). */
export const BUILD_TIMEOUT_MS = 30_000;
export const BUILD_APY_TIMEOUT_MS = 90_000;
/** Under `next dev` the first request waits for the snapshot, so no read gets longer than 10 s there. */
const DEV_TIMEOUT_MS = 10_000;
const AT_BUILD = process.env.NODE_ENV === "production";
const TIMEOUT_MS = AT_BUILD ? BUILD_TIMEOUT_MS : DEV_TIMEOUT_MS;
const APY_TIMEOUT_MS = AT_BUILD ? BUILD_APY_TIMEOUT_MS : DEV_TIMEOUT_MS;
const REFRESH_MS = 10 * 60_000;

/** The data source the snapshot reads with: the browser's own (index.ts), on connections that wait for one answer as
 * long as the quick reads' deadline. The browser's wait 10 s and then ask again, which a read the node takes 18 s over
 * never survives, however long the deadline. (The yield has its own connections, which wait 90 s: chain.ts.) */
const snapshotData = (): CascadeData => createCascadeData(createClients({ timeoutMs: TIMEOUT_MS }));

/** A read, or undefined once it fails or the deadline passes. */
const settle = <T>(read: () => Promise<T>, deadline: Promise<undefined>): Promise<T | undefined> =>
  Promise.race([
    Promise.resolve()
      .then(read)
      .catch(() => undefined),
    deadline,
  ]);

async function readSnapshot(deps: SnapshotDeps): Promise<Snapshot> {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const deadlineIn = (ms: number) =>
    new Promise<undefined>((resolve) => {
      timers.push(setTimeout(resolve, ms, undefined));
    });
  try {
    const data = deps.createData();
    const quick = deadlineIn(deps.timeoutMs);
    // a read that fails, or isn't answered in time, leaves its figure out: it never fails the others, or the build
    const [apyPercent, stats, taoPriceUsd] = await Promise.all([
      settle(() => data.getApy(), deadlineIn(deps.apyTimeoutMs)),
      settle(() => data.getProtocolStats(), quick),
      settle(() => data.getTaoPrice(), quick),
    ]);
    return {
      at: deps.now(),
      ...(apyPercent !== undefined ? { apyPercent } : {}),
      ...(stats !== undefined ? { stats } : {}),
      ...(taoPriceUsd !== undefined ? { taoPriceUsd } : {}),
    };
  } catch {
    // never fails the page (or the build): the browser reads the figures itself
    return { at: deps.now() };
  } finally {
    for (const t of timers) clearTimeout(t);
  }
}

/** One snapshot per process, read again once it is `refreshMs` old. Only the very first call waits for
 * its read; after that a call is served the last snapshot that finished while the next one is read, so
 * no request under `next dev` waits on the chain. Never rejects. */
export function createSnapshotLoader(given: Partial<SnapshotDeps> = {}): () => Promise<Snapshot> {
  const deps: SnapshotDeps = { createData: snapshotData, now: Date.now, timeoutMs: TIMEOUT_MS, apyTimeoutMs: APY_TIMEOUT_MS, refreshMs: REFRESH_MS, ...given };
  let reading: { startedAt: number; snapshot: Promise<Snapshot> } | null = null;
  let finished: Promise<Snapshot> | null = null;
  return () => {
    const now = deps.now();
    if (!reading || now - reading.startedAt >= deps.refreshMs) {
      const snapshot = readSnapshot(deps);
      reading = { startedAt: now, snapshot };
      void snapshot.then(
        () => {
          finished = snapshot;
        },
        () => undefined,
      );
    }
    return finished ?? reading.snapshot;
  };
}

export const loadSnapshot = createSnapshotLoader();
