import { describe, expect, it } from "vitest";
import { formatUsd } from "./format";
import { APY_KEEP_MS, formatApy, formatStakedTao, heroTotal, type LiveFigure, liveOnly, rowText, shownFigure, statRows, STATS_KEEP_MS, totalStakedUsd, withRemembered } from "./stats";

const LABELS = ["Annual percentage yield, in TAO*", "Total staked through Cascade", "TAO price"];

describe("statRows", () => {
  it("formats the three rows in order, each with the form a count to a new value keeps", () => {
    const rows = statRows({ totalStakedTao: 12480, taoPriceUsd: 286 }, 11.4);
    expect(rows).toEqual([
      { key: "apy", label: LABELS[0], amount: 11.4, format: formatApy, accent: true },
      { key: "staked", label: LABELS[1], amount: 12480, format: formatStakedTao },
      { key: "price", label: LABELS[2], amount: 286, format: formatUsd },
    ]);
    expect(rows.map(rowText)).toEqual(["11.4%", "12,480 TAO", "$286.00"]);
  });

  it("keeps every row while loading, with no value to show", () => {
    expect(statRows(undefined).map((r) => [r.key, r.label, r.amount, rowText(r)])).toEqual([
      ["apy", LABELS[0], undefined, undefined],
      ["staked", LABELS[1], undefined, undefined],
      ["price", LABELS[2], undefined, undefined],
    ]);
  });

  it("keeps a row whose value is missing, with no value to show", () => {
    expect(statRows({}, 9.06).map((r) => [r.label, rowText(r)])).toEqual([
      [LABELS[0], "9.1%"],
      [LABELS[1], undefined],
      [LABELS[2], undefined],
    ]);
    expect(statRows({ totalStakedTao: 0.5 }).map(rowText)).toEqual([undefined, "0.5000 TAO", undefined]);
  });

  it("formats APY with one decimal", () => {
    expect(formatApy(11.4)).toBe("11.4%");
    expect(formatApy(5.3649)).toBe("5.4%");
  });

  it("formats the total staked to four places under 10 TAO, whole above", () => {
    expect(formatStakedTao(0.156)).toBe("0.1560 TAO");
    expect(formatStakedTao(9.99996)).toBe("10.0000 TAO");
    expect(formatStakedTao(10)).toBe("10 TAO");
    expect(formatStakedTao(12480.4)).toBe("12,480 TAO");
  });
});

describe("totalStakedUsd", () => {
  it("is the TAO staked at the TAO price, when both are known", () => {
    expect(totalStakedUsd({ totalStakedTao: 10, taoPriceUsd: 255 })).toBe(2550);
    expect(totalStakedUsd({ totalStakedTao: 0, taoPriceUsd: 255 })).toBe(0);
    expect(totalStakedUsd({ totalStakedTao: 10 })).toBeUndefined();
    expect(totalStakedUsd(undefined)).toBeUndefined();
  });
});

describe("shownFigure", () => {
  const DAY = 86_400_000;
  const read = 1_800_000_000_000;
  const clock = (at: number) => () => at;
  const noClock = () => {
    throw new Error("the clock was read");
  };

  it("shows the value it has, without reading the clock, while the reads succeed", () => {
    expect(shownFigure({ data: 5.4, isError: false, dataUpdatedAt: read }, APY_KEEP_MS, noClock)).toBe(5.4);
    // however old (a snapshot from the build): the clock isn't read while hydrating
    expect(shownFigure({ data: 5.4, isError: false, dataUpdatedAt: 1 }, APY_KEEP_MS, noClock)).toBe(5.4);
  });

  it("has nothing to show before the first value", () => {
    expect(shownFigure({ data: undefined, isError: false, dataUpdatedAt: 0 }, APY_KEEP_MS, noClock)).toBeUndefined();
    expect(shownFigure({ data: undefined, isError: true, dataUpdatedAt: 0 }, APY_KEEP_MS, noClock)).toBeUndefined();
  });

  it("keeps the last value through a failed read for up to 14 days", () => {
    const failed = { data: 5.4, isError: true, dataUpdatedAt: read };
    expect(APY_KEEP_MS).toBe(14 * DAY);
    expect(shownFigure(failed, APY_KEEP_MS, clock(read + DAY))).toBe(5.4);
    expect(shownFigure(failed, APY_KEEP_MS, clock(read + 14 * DAY))).toBe(5.4);
  });

  it("drops a value older than that once a read fails", () => {
    const failed = { data: 5.4, isError: true, dataUpdatedAt: read };
    expect(shownFigure(failed, APY_KEEP_MS, clock(read + 14 * DAY + 1))).toBeUndefined();
  });

  it("keeps zero, which is a value", () => {
    expect(shownFigure({ data: 0, isError: true, dataUpdatedAt: read }, APY_KEEP_MS, clock(read))).toBe(0);
  });
});

describe("withRemembered: a figure with what this browser remembers of it", () => {
  const HOUR = 60 * 60_000;
  const now = 1_800_000_000_000;
  /** When the first HTML's snapshot was read: five days before. */
  const BUILD = now - 5 * 86_400_000;
  const q = (over: Partial<LiveFigure<number>> = {}): LiveFigure<number> => ({ data: undefined, isError: false, dataUpdatedAt: 0, ...over });
  const noClock = () => {
    throw new Error("the clock was read");
  };

  it("is the query's own figure when nothing is remembered", () => {
    const own = q({ data: 5.4, dataUpdatedAt: now });
    expect(withRemembered(own, undefined, BUILD)).toBe(own);
    expect(withRemembered(q(), undefined, BUILD).data).toBeUndefined();
  });

  it("shows the remembered reading at once while this visit's own is still being read", () => {
    const f = withRemembered(q(), { value: 3.4, at: now - HOUR }, BUILD);
    expect(f).toEqual({ data: 3.4, isError: false, dataUpdatedAt: now - HOUR });
    expect(shownFigure(f, APY_KEEP_MS, noClock)).toBe(3.4);
  });

  it("is replaced by this visit's own reading as soon as it arrives", () => {
    const own = q({ data: 3.5, dataUpdatedAt: now });
    expect(withRemembered(own, { value: 3.4, at: now - HOUR }, BUILD)).toBe(own);
    // what this visit itself remembered a moment before the query was dated: the same reading, the query's stands
    expect(withRemembered(own, { value: 3.5, at: now - 2 }, BUILD)).toBe(own);
  });

  it("this visit's own reading always stands, also against one remembered after it: a read that answered late, once the query had moved on to a newer one", () => {
    // the query was read again before its first read (A) answered; the second (B) answered first and is its data;
    // A answered a second later, and was remembered then
    const b = q({ data: 3.5, dataUpdatedAt: now });
    const lateA = { value: 3.4, at: now + 1_000 };
    expect(withRemembered(b, lateA, BUILD)).toBe(b);
    expect(shownFigure(withRemembered(b, lateA, BUILD), APY_KEEP_MS, noClock)).toBe(3.5);
    // with no snapshot at all, and through a failed read after it, too
    expect(withRemembered(b, lateA, 0)).toBe(b);
    const failed = q({ data: 3.5, isError: true, dataUpdatedAt: now });
    expect(shownFigure(withRemembered(failed, lateA, BUILD), APY_KEEP_MS, () => now + 2_000)).toBe(3.5);
    // a reading of this visit's dated before the build (this browser's clock is behind the build machine's) is its own
    const behind = q({ data: 3.5, dataUpdatedAt: BUILD - 5 * 60_000 });
    expect(withRemembered(behind, { value: 3.4, at: BUILD - 60_000 }, BUILD)).toBe(behind);
  });

  it("takes the newer of the first HTML's snapshot and the remembered reading", () => {
    const snapshot = q({ data: 3.2, dataUpdatedAt: BUILD });
    // seen since the build: the remembered one
    expect(withRemembered(snapshot, { value: 3.4, at: now - HOUR }, BUILD).data).toBe(3.4);
    // the site was built again since the last visit: the snapshot
    expect(withRemembered(snapshot, { value: 3.0, at: BUILD - HOUR }, BUILD)).toBe(snapshot);
  });

  it("after a failed read, keeps the remembered reading for its window and no longer: never an old value as if it were live", () => {
    const failed = withRemembered(q({ isError: true }), { value: 254.49, at: now - 30 * 60_000 }, BUILD);
    expect(shownFigure(failed, STATS_KEEP_MS, () => now)).toBe(254.49);
    expect(shownFigure(failed, STATS_KEEP_MS, () => now + 30 * 60_000 + 1)).toBeUndefined();
    // a snapshot too old to keep, a remembered reading still within its window: the remembered one shows
    const old = withRemembered(q({ data: 250, isError: true, dataUpdatedAt: BUILD }), { value: 254.49, at: now - 30 * 60_000 }, BUILD);
    expect(shownFigure(old, STATS_KEEP_MS, () => now)).toBe(254.49);
  });
});

describe("liveOnly: a figure only as this visit read it", () => {
  const SEEDED = 1_800_000_000_000;

  it("has nothing while the query still holds the server's snapshot", () => {
    expect(liveOnly({ data: 255, isError: false, dataUpdatedAt: SEEDED }, SEEDED)).toEqual({ data: undefined, isError: false, dataUpdatedAt: 0 });
    // and says so when its own read failed
    expect(liveOnly({ data: 255, isError: true, dataUpdatedAt: SEEDED }, SEEDED).isError).toBe(true);
  });

  it("has this visit's reading, also when this browser's clock is behind the build machine's, and with no snapshot at all", () => {
    for (const at of [SEEDED + 20_000, SEEDED - 5 * 60_000]) {
      const own = { data: 255, isError: false, dataUpdatedAt: at };
      expect(liveOnly(own, SEEDED)).toBe(own);
    }
    const own = { data: 255, isError: false, dataUpdatedAt: 0 };
    expect(liveOnly(own, 0)).toBe(own);
  });

  it("with the remembered price, shows that one in the snapshot's place, never the snapshot's own; and this visit's own price over any remembered", () => {
    const snapshot = { data: 240, isError: false, dataUpdatedAt: SEEDED };
    // what is left of the query once the snapshot's is taken out is this visit's own or nothing (no snapshot: 0)
    const f = withRemembered(liveOnly(snapshot, SEEDED), { value: 254.49, at: SEEDED - 86_400_000 }, 0);
    expect(f.data).toBe(254.49);
    expect(withRemembered(liveOnly(snapshot, SEEDED), undefined, 0).data).toBeUndefined();
    const own = { data: 255, isError: false, dataUpdatedAt: SEEDED + 30_000 };
    expect(withRemembered(liveOnly(own, SEEDED), { value: 254.49, at: SEEDED + 31_000 }, 0)).toBe(own);
  });
});

describe("heroTotal: the home page's total staked, in dollars", () => {
  const now = 1_800_000_000_000;
  const at = (data: number | undefined, over: Partial<LiveFigure<number>> = {}): LiveFigure<number> => ({ data, isError: false, dataUpdatedAt: data === undefined ? 0 : now, ...over });
  const clock = () => now;

  it("is the TAO staked at the TAO price, from a dollar up", () => {
    expect(heroTotal(at(10), at(255), clock)).toEqual({ place: true, usd: 2550, loading: true });
    expect(heroTotal(at(0.004), at(255), clock)).toMatchObject({ place: true, usd: 0.004 * 255 });
  });

  it("has no place when the figures say there is under a dollar staked", () => {
    expect(heroTotal(at(0.003), at(255), clock).place).toBe(false);
    expect(heroTotal(at(0), at(255), clock).place).toBe(false);
    // nothing staked is nothing at any price
    expect(heroTotal(at(0), at(undefined), clock).place).toBe(false);
  });

  it("keeps its place, with nothing to show yet, while a figure isn't known: the Stake button beside it never moves when it arrives", () => {
    expect(heroTotal(at(undefined), at(undefined), clock)).toEqual({ place: true, usd: undefined, loading: true });
    expect(heroTotal(at(10), at(undefined), clock)).toEqual({ place: true, usd: undefined, loading: true });
    expect(heroTotal(at(undefined), at(255), clock)).toEqual({ place: true, usd: undefined, loading: true });
  });

  it("keeps each part through a failed read for an hour, then leaves a dash in its place and says it isn't available", () => {
    const failed = (ageMs: number) => at(10, { isError: true, dataUpdatedAt: now - ageMs });
    expect(heroTotal(failed(30 * 60_000), at(255), clock)).toEqual({ place: true, usd: 2550, loading: false });
    expect(heroTotal(failed(2 * 60 * 60_000), at(255), clock)).toEqual({ place: true, usd: undefined, loading: false });
    expect(heroTotal(at(10), at(255, { isError: true, dataUpdatedAt: now - 2 * 60 * 60_000 }), clock)).toEqual({ place: true, usd: undefined, loading: false });
  });
});
