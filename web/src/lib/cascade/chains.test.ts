import { describe, expect, it } from "vitest";
import { SOURCE_CHAINS, availabilityText, chainInfo, isSourceChain, liveChains } from "./chains";

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

  it("says where you can deposit today, and that more chains are coming", () => {
    expect(availabilityText()).toBe("Available on Base. More chains soon.");
  });

  it("names every live chain, and drops the teaser once nothing is coming", () => {
    const live = (id: "base" | "arbitrum" | "ethereum") => ({ ...chainInfo(id), status: "live" as const });
    expect(availabilityText([live("base"), live("arbitrum")])).toBe("Available on Base and Arbitrum.");
    expect(availabilityText([live("base"), live("arbitrum"), live("ethereum")])).toBe(
      "Available on Base, Arbitrum and Ethereum.",
    );
    expect(availabilityText([live("base"), chainInfo("polygon")])).toBe("Available on Base. More chains soon.");
    expect(availabilityText([chainInfo("polygon")])).toBe("More chains soon.");
  });
});
