import { describe, expect, it, vi } from "vitest";
import { notConfiguredData } from "./live";
import { createSnapshotLoader, type Snapshot, type SnapshotDeps } from "./snapshot";
import type { CascadeData, ProtocolStats } from "./types";

const STATS: ProtocolStats = { totalStakedTao: 12.5, taoPriceUsd: 255 };

/** A data source with only the two reads the snapshot takes. */
function source(apy: () => Promise<number>, stats: () => Promise<ProtocolStats>): CascadeData {
  return { getApy: apy, getProtocolStats: stats } as Partial<CascadeData> as CascadeData;
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
  it("reads the APY and the protocol figures", async () => {
    const { load } = loader();
    expect(await load()).toEqual({ at: 1_000, apyPercent: 5.4, stats: STATS });
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

  it("keeps each figure that was read when the other fails", async () => {
    const noApy = loader({ createData: () => source(() => Promise.reject(new Error("archive down")), async () => STATS) });
    expect(await noApy.load()).toEqual({ at: 1_000, stats: STATS });
    const noStats = loader({ createData: () => source(async () => 5.4, () => Promise.reject(new Error("rate limited"))) });
    expect(await noStats.load()).toEqual({ at: 1_000, apyPercent: 5.4 });
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
    expect(await load()).toEqual({ at: 1_000, stats: STATS });
  });

  it("gives up on a read that is still running when the time is up, and keeps the other", async () => {
    const { load } = loader({ createData: () => source(never, async () => STATS), timeoutMs: 30 });
    const started = Date.now();
    expect(await load()).toEqual({ at: 1_000, stats: STATS });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("gives up on both under one deadline, not one each", async () => {
    vi.useFakeTimers();
    try {
      // the APY arrives just before the deadline, the protocol figures never do
      const late = () => new Promise<number>((resolve) => setTimeout(resolve, 160, 5.4));
      const { load } = loader({ createData: () => source(late, never), timeoutMs: 200 });
      let done: Snapshot | undefined;
      void load().then((s) => (done = s));
      await vi.advanceTimersByTimeAsync(199);
      expect(done).toBeUndefined();
      // done at 200 ms: a deadline each, one read after the other, would take 160 + 200 ms
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toEqual({ at: 1_000, apyPercent: 5.4 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads once per process, then again once the snapshot is ten minutes old", async () => {
    const l = loader();
    const first = l.load();
    expect(l.load()).toBe(first);
    await first;
    l.tick(9 * 60_000);
    expect(l.load()).toBe(first);
    expect(l.made()).toBe(1);
    l.tick(60_000);
    const second = l.load();
    expect(second).not.toBe(first);
    expect((await second).at).toBe(1_000 + 10 * 60_000);
    expect(l.made()).toBe(2);
  });
});
