import { describe, expect, it } from "vitest";
import { base } from "viem/chains";
import { RPC } from "./cascade/config";
import { wagmiConfig } from "./wagmi";

describe("the wallet config", () => {
  it("knows Base only: every flow sends on Base (the emergency page on Bittensor asks the wallet itself, use-direct-exit.ts)", () => {
    expect(wagmiConfig.chains.map((c) => c.id)).toEqual([base.id]);
    expect(Object.keys(wagmiConfig._internal.transports).map(Number)).toEqual([base.id]);
  });

  it("reads Base from the same public RPC as the rest of the site", () => {
    const transport = wagmiConfig._internal.transports[base.id]({ chain: base, retryCount: 0 });
    expect(transport.value?.url).toBe(RPC.base);
  });

  it("offers Base Account, the browser's own wallets and WalletConnect (the build's default: its tracked project id), nothing else", () => {
    expect(wagmiConfig.connectors.map((c) => c.id)).toEqual(["baseAccount", "injected", "walletConnect"]);
  });

  it("stays Base only with WalletConnect in it: the session's second chain, Bittensor EVM, is the connector's own (walletconnect-inner.ts)", () => {
    expect(wagmiConfig.chains.map((c) => c.id)).toEqual([base.id]);
  });
});
