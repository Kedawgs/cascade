import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { chainInfo } from "@/lib/cascade/chains";
import { plainText, renderWithCache } from "../test-render";
import { AmountField } from "./AmountField";

const field = (unit: "USDC" | "TAO", withChain: boolean) =>
  plainText(
    renderWithCache(
      createElement(AmountField, { id: "amt", value: "", onChange: () => {}, unit, decimals: 2, ...(withChain ? { chain: chainInfo("base") } : {}) }),
    ),
  );

describe("AmountField", () => {
  it("says which chain the USDC is on, so phones (whose app bar drops the network pill) still show it", () => {
    expect(field("USDC", true)).toContain("USDCon Base");
  });

  it("names no chain for a TAO amount (a measure of the stake, not a token on that chain), or when none is given", () => {
    expect(field("TAO", true)).not.toContain("on Base");
    expect(field("USDC", false)).not.toContain("on Base");
  });
});
