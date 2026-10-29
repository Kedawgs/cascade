import { getAddress } from "viem";
import { base } from "viem/chains";
import { describe, expect, it } from "vitest";
import { createConfig, createConnector, http } from "wagmi";
import { connect } from "wagmi/actions";
import { wagmiPort } from "./use-flows";

const ME = getAddress("0x000000000000000000000000000000000000a11c");

/** A wallet sitting on `startChain`, which switches when asked (and records that it was). */
function walletOn(startChain: number) {
  let chainId = startChain;
  const switched: number[] = [];
  const connector = createConnector((config) => ({
    id: "test",
    name: "Test wallet",
    type: "test",
    async connect() {
      return { accounts: [ME], chainId } as never;
    },
    async disconnect() {},
    async getAccounts() {
      return [ME];
    },
    async getChainId() {
      return chainId;
    },
    async getProvider() {
      return { request: async () => null };
    },
    async isAuthorized() {
      return true;
    },
    async switchChain({ chainId: to }) {
      switched.push(to);
      chainId = to;
      config.emitter.emit("change", { chainId: to });
      return base;
    },
    onAccountsChanged() {},
    onChainChanged() {},
    onDisconnect() {},
  }));
  const config = createConfig({ chains: [base], connectors: [connector], transports: { [base.id]: http() }, multiInjectedProviderDiscovery: false });
  return { config, switched };
}

describe("the wallet port", () => {
  it("asks a wallet on a chain the site doesn't know to switch to Base (wagmi itself still says Base)", async () => {
    const w = walletOn(1);
    await connect(w.config, { connector: w.config.connectors[0] } as never);
    await wagmiPort(w.config, ME, {} as never).switchToBase();
    expect(w.switched).toEqual([base.id]);
  });

  it("leaves a wallet already on Base where it is", async () => {
    const w = walletOn(base.id);
    await connect(w.config, { connector: w.config.connectors[0] } as never);
    await wagmiPort(w.config, ME, {} as never).switchToBase();
    expect(w.switched).toEqual([]);
  });
});
