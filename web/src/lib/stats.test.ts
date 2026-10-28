import { describe, expect, it } from "vitest";
import { formatApy, statRows } from "./stats";

describe("statRows", () => {
  it("formats the four rows in order", () => {
    expect(
      statRows({ totalStakedTao: 12480, stakers: 1204, taoPriceUsd: 286 }, 11.4),
    ).toEqual([
      { label: "Annual percentage yield, in TAO*", value: "11.4%", accent: true },
      { label: "Total staked through Cascade", value: "12,480 TAO" },
      { label: "Stakers", value: "1,204" },
      { label: "TAO price", value: "$286.00" },
    ]);
  });

  it("omits rows whose value is missing", () => {
    expect(statRows({}, 9.05).map((r) => r.label)).toEqual(["Annual percentage yield, in TAO*"]);
    expect(statRows({})).toEqual([]);
  });

  it("formats APY with one decimal", () => {
    expect(formatApy(11.4)).toBe("11.4%");
    expect(formatApy(5.3649)).toBe("5.4%");
  });
});
