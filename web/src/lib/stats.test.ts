import { describe, expect, it } from "vitest";
import { formatApr, statRows } from "./stats";

describe("statRows", () => {
  it("formats the four rows in order", () => {
    expect(
      statRows({ aprPercent: 11.4, totalStakedTao: 12480, stakers: 1204, taoPriceUsd: 286 }),
    ).toEqual([
      { label: "Annual percentage rate*", value: "11.4%", accent: true },
      { label: "Total staked through Cascade", value: "12,480 TAO" },
      { label: "Stakers", value: "1,204" },
      { label: "TAO price", value: "$286.00" },
    ]);
  });

  it("omits rows whose value is missing", () => {
    expect(statRows({ aprPercent: 9.05 }).map((r) => r.label)).toEqual(["Annual percentage rate*"]);
    expect(statRows({})).toEqual([]);
  });

  it("formats APR with one decimal", () => {
    expect(formatApr(11.4)).toBe("11.4%");
    expect(formatApr(9)).toBe("9.0%");
  });
});
