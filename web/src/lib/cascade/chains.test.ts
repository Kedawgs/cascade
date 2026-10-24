import { describe, expect, it } from "vitest";
import { SOURCE_CHAINS, chainInfo, isSourceChain, liveChains } from "./chains";

describe("source chains", () => {
  it("lists five chains in the approved order", () => {
    expect(SOURCE_CHAINS.map((c) => c.id)).toEqual(["base", "ethereum", "arbitrum", "polygon", "bnb"]);
  });

  it("has Base as the only live chain", () => {
    expect(liveChains().map((c) => c.id)).toEqual(["base"]);
    expect(chainInfo("arbitrum")).toMatchObject({ status: "soon", chainId: 42161, label: "Arbitrum" });
  });

  it("recognises arbitrum", () => {
    expect(isSourceChain("arbitrum")).toBe(true);
    expect(isSourceChain("solana")).toBe(false);
  });
});
