import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { notConfiguredData } from "./live";
import { BUILD_APY_TIMEOUT_MS, BUILD_TIMEOUT_MS, createSnapshotLoader, type Snapshot, type SnapshotDeps } from "./snapshot";
import type { CascadeData, ProtocolStats } from "./types";

const STATS: ProtocolStats = { totalStakedTao: 12.5 };
const PRICE = 255;

/** A data source with only the three reads the snapshot takes. */
function source(apy: () => Promise<number>, stats: () => Promise<ProtocolStats>, price: () => Promise<number> = async () => PRICE): CascadeData {
  return { getApy: apy, getProtocolStats: stats, getTaoPrice: price } as Partial<CascadeData> as CascadeData;
}

const never = <T>() => new Promise<T>(() => {});

function loader(over: Partial<SnapshotDeps> = {}) {
  let clock = 1_000;
  let made = 0;
  const load = createSnapshotLoader({
    createData: () => {
      made++;
      return source(async () => 5.4, async () => STATS);
    },
    now: () => clock,
    timeoutMs: 50,
    apyTimeoutMs: 50,
    ...over,
  });
  return {
    load,
    made: () => made,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe("loadSnapshot", () => {
  it("reads the APY, the total staked and the TAO price", async () => {
    const { load } = loader();
    expect(await load()).toEqual({ at: 1_000, apyPercent: 5.4, stats: STATS, taoPriceUsd: PRICE });
  });

  it("is empty when no deployment is configured", async () => {
    const { load } = loader({ createData: notConfiguredData });
    expect(await load()).toEqual({ at: 1_000 });
  });

  it("is empty, and doesn't throw, when the data source can't be built", async () => {
    const { load } = loader({
      createData: () => {
        throw new Error("no network");
      },
    });
    expect(await load()).toEqual({ at: 1_000 });
  });

  it("keeps each figure that was read when another fails", async () => {
    const noApy = loader({ createData: () => source(() => Promise.reject(new Error("archive down")), async () => STATS) });
    expect(await noApy.load()).toEqual({ at: 1_000, stats: STATS, taoPriceUsd: PRICE });
    const noStats = loader({ createData: () => source(async () => 5.4, () => Promise.reject(new Error("rate limited"))) });
    expect(await noStats.load()).toEqual({ at: 1_000, apyPercent: 5.4, taoPriceUsd: PRICE });
    // the price is Base's own read: Bittensor failing doesn't take it away, nor the other way round
    const noPrice = loader({ createData: () => source(async () => 5.4, async () => STATS, () => Promise.reject(new Error("quoter reverted"))) });
    expect(await noPrice.load()).toEqual({ at: 1_000, apyPercent: 5.4, stats: STATS });
  });

  it("treats a read that throws before returning a promise as a failure", async () => {
    const { load } = loader({
      createData: () =>
        source(
          () => {
            throw new Error("sync");
          },
          async () => STATS,
        ),
    });
    expect(await load()).toEqual({ at: 1_000, stats: STATS, taoPriceUsd: PRICE });
  });

  it("gives up on a read that is still running when the time is up, and keeps the others", async () => {
    const { load } = loader({ createData: () => source(never, async () => STATS), timeoutMs: 30, apyTimeoutMs: 30 });
    const started = Date.now();
    expect(await load()).toEqual({ at: 1_000, stats: STATS, taoPriceUsd: PRICE });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("gives up on the quick reads (the total and the price) under one deadline, not one each", async () => {
    vi.useFakeTimers();
    try {
      // the price arrives just before the deadline, the total staked never does
      const late = () => new Promise<number>((resolve) => setTimeout(resolve, 160, PRICE));
      const { load } = loader({ createData: () => source(async () => 5.4, never, late), timeoutMs: 200, apyTimeoutMs: 200 });
      let done: Snapshot | undefined;
      void load().then((s) => (done = s));
      await vi.advanceTimersByTimeAsync(199);
      expect(done).toBeUndefined();
      // done at 200 ms: a deadline each, one read after the other, would take 160 + 200 ms
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toEqual({ at: 1_000, apyPercent: 5.4, taoPriceUsd: PRICE });
    } finally {
      vi.useRealTimers();
    }
  });

  describe("the yield's own deadline: its read of 30-day-old state takes most of a minute on Bittensor's public node", () => {
    it("waits for the yield past the quick reads' deadline, so the first HTML has it", async () => {
      vi.useFakeTimers();
      try {
        // the yield arrives after 40 s: four times the quick reads' 10 s
        const slow = () => new Promise<number>((resolve) => setTimeout(resolve, 40_000, 3.4));
        const { load } = loader({ createData: () => source(slow, async () => STATS), timeoutMs: 10_000, apyTimeoutMs: 90_000 });
        let done: Snapshot | undefined;
        void load().then((s) => (done = s));
        await vi.advanceTimersByTimeAsync(39_999);
        expect(done).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(done).toEqual({ at: 1_000, apyPercent: 3.4, stats: STATS, taoPriceUsd: PRICE });
      } finally {
        vi.useRealTimers();
      }
    });

    it("doesn't give the quick reads the yield's time: a total that never answers is still given up on at their deadline", async () => {
      vi.useFakeTimers();
      try {
        const slow = () => new Promise<number>((resolve) => setTimeout(resolve, 40_000, 3.4));
        // the total would arrive at 20 s, after its 10 s deadline though before the yield's
        const late = () => new Promise<ProtocolStats>((resolve) => setTimeout(resolve, 20_000, STATS));
        const { load } = loader({ createData: () => source(slow, late), timeoutMs: 10_000, apyTimeoutMs: 90_000 });
        let done: Snapshot | undefined;
        void load().then((s) => (done = s));
        await vi.advanceTimersByTimeAsync(40_000);
        expect(done).toEqual({ at: 1_000, apyPercent: 3.4, taoPriceUsd: PRICE });
      } finally {
        vi.useRealTimers();
      }
    });

    it("never fails the build when the node doesn't answer: at its deadline the yield is left out, as before", async () => {
      vi.useFakeTimers();
      try {
        const { load } = loader({ createData: () => source(never, async () => STATS), timeoutMs: 30_000, apyTimeoutMs: 90_000 });
        let done: Snapshot | undefined;
        void load().then((s) => (done = s));
        await vi.advanceTimersByTimeAsync(89_999);
        expect(done).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(done).toEqual({ at: 1_000, stats: STATS, taoPriceUsd: PRICE });
      } finally {
        vi.useRealTimers();
      }
    });

    it("never fails the build when nothing answers at all: an empty snapshot at the last deadline", async () => {
      vi.useFakeTimers();
      try {
        const { load } = loader({ createData: () => source(never, never, never), timeoutMs: 30_000, apyTimeoutMs: 90_000 });
        let done: Snapshot | undefined;
        void load().then((s) => (done = s));
        await vi.advanceTimersByTimeAsync(90_000);
        expect(done).toEqual({ at: 1_000 });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("at `next build`", () => {
    const file = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

    it("the yield gets 90 s and the total and the price 30 s: a read of today's state took Bittensor's node 18 s on a slow evening", () => {
      expect(BUILD_APY_TIMEOUT_MS).toBe(90_000);
      expect(BUILD_TIMEOUT_MS).toBe(30_000);
    });

    it("every page waits for the snapshot, so Next gives a static page 150 s (not its 60), a minute more than the longest read: a slow node never fails the build", () => {
      const limit = /^\s*staticPageGenerationTimeout: (\d+),$/m.exec(file("../../../next.config.ts"));
      expect(limit).not.toBeNull();
      const limitMs = Number(limit![1]) * 1_000;
      expect(limitMs).toBe(150_000);
      expect(limitMs - Math.max(BUILD_APY_TIMEOUT_MS, BUILD_TIMEOUT_MS)).toBeGreaterThanOrEqual(60_000);
    });

    it("reads on connections that wait for one answer as long as the quick reads' deadline: the browser's 10 s would give up on an 18 s answer whatever the deadline", () => {
      const snapshot = file("./snapshot.ts");
      expect(snapshot).toContain("const snapshotData = (): CascadeData => createCascadeData(createClients({ timeoutMs: TIMEOUT_MS }));");
      expect(snapshot).toMatch(/const deps: SnapshotDeps = \{ createData: snapshotData, /);
      expect(snapshot).toContain("const TIMEOUT_MS = AT_BUILD ? BUILD_TIMEOUT_MS : DEV_TIMEOUT_MS;");
    });
  });

  it("reads once per process: callers share the first read, and wait for it", async () => {
    const l = loader();
    const first = l.load();
    expect(l.load()).toBe(first);
    expect(await first).toEqual({ at: 1_000, apyPercent: 5.4, stats: STATS, taoPriceUsd: PRICE });
    l.tick(9 * 60_000);
    expect(l.load()).toBe(first);
    expect(l.made()).toBe(1);
  });

  it("once the snapshot is ten minutes old, reads again but serves the last one until the new one is in", async () => {
    let apy = 5.4;
    let reads = 0;
    const l = loader({ createData: () => (reads++, source(async () => apy, async () => STATS)) });
    const first = l.load();
    await first;
    apy = 6.1;
    l.tick(10 * 60_000);
    // no request waits on the chain: this one gets the last snapshot while the next is read
    expect(l.load()).toBe(first);
    expect(reads).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = l.load();
    expect(second).not.toBe(first);
    expect(await second).toEqual({ at: 1_000 + 10 * 60_000, apyPercent: 6.1, stats: STATS, taoPriceUsd: PRICE });
    expect(reads).toBe(2);
  });
});
