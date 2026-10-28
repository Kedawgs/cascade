import { describe, expect, it } from "vitest";
import { APY_KEEP_MS, formatApy, shownFigure, statRows, totalStakedUsd } from "./stats";

const LABELS = ["Annual percentage yield, in TAO*", "Total staked through Cascade", "TAO price"];

describe("statRows", () => {
  it("formats the three rows in order", () => {
    expect(statRows({ totalStakedTao: 12480, taoPriceUsd: 286 }, 11.4)).toEqual([
      { key: "apy", label: LABELS[0], value: "11.4%", accent: true },
      { key: "staked", label: LABELS[1], value: "12,480 TAO" },
      { key: "price", label: LABELS[2], value: "$286.00" },
    ]);
  });

  it("keeps every row while loading, with no value to show", () => {
    expect(statRows(undefined)).toEqual([
      { key: "apy", label: LABELS[0], value: undefined, accent: true },
      { key: "staked", label: LABELS[1], value: undefined },
      { key: "price", label: LABELS[2], value: undefined },
    ]);
  });

  it("keeps a row whose value is missing, with no value to show", () => {
    expect(statRows({}, 9.06).map((r) => [r.label, r.value])).toEqual([
      [LABELS[0], "9.1%"],
      [LABELS[1], undefined],
      [LABELS[2], undefined],
    ]);
    expect(statRows({ totalStakedTao: 0.5 }).map((r) => r.value)).toEqual([undefined, "0.5000 TAO", undefined]);
  });

  it("formats APY with one decimal", () => {
    expect(formatApy(11.4)).toBe("11.4%");
    expect(formatApy(5.3649)).toBe("5.4%");
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
