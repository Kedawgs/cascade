import { describe, expect, it } from "vitest";
import { explorer } from "./config";

describe("explorer links for the security page", () => {
  it("point at the public explorers", () => {
    expect(explorer.baseAddress("0xabc")).toBe("https://basescan.org/address/0xabc");
    expect(explorer.bittensorAddress("0xabc")).toBe("https://evm.taostats.io/address/0xabc");
    expect(explorer.validator("5Abc")).toBe("https://taostats.io/validators/5Abc");
    expect(explorer.ccipLane("0xabc")).toBe("https://ccip.chain.link/address/0xabc");
  });
});
