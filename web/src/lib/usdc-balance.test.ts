import { describe, expect, it } from "vitest";
import { availableToStake } from "./usdc-balance";

describe("availableToStake", () => {
  it("shows the balance and enables MAX", () => {
    expect(availableToStake({ status: "success", data: 2400 })).toEqual({
      text: "2,400 USDC",
      max: 2400,
    });
    expect(availableToStake({ status: "success", data: 12.5 })).toEqual({
      text: "12.50 USDC",
      max: 12.5,
    });
  });

  it("shows a dash and disables MAX while loading or on error", () => {
    expect(availableToStake({ status: "pending" })).toEqual({ text: "–", max: null });
    expect(availableToStake({ status: "error" })).toEqual({ text: "–", max: null });
  });
});
