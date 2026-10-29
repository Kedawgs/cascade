import { describe, expect, it } from "vitest";
import { base } from "viem/chains";
import { RPC } from "./cascade/config";
import { wagmiConfig } from "./wagmi";

describe("the wallet config", () => {
  it("knows Base only: nothing the site sends goes to any other chain", () => {
    expect(wagmiConfig.chains.map((c) => c.id)).toEqual([base.id]);
    expect(Object.keys(wagmiConfig._internal.transports).map(Number)).toEqual([base.id]);
  });

  it("reads Base from the same public RPC as the rest of the site", () => {
    const transport = wagmiConfig._internal.transports[base.id]({ chain: base, retryCount: 0 });
    expect(transport.value?.url).toBe(RPC.base);
  });

  it("offers Base Account and the browser's own wallets, nothing else", () => {
    expect(wagmiConfig.connectors.map((c) => c.id)).toEqual(["baseAccount", "injected"]);
  });
});
