import { getAddress, type Hex } from "viem";
import { base } from "viem/chains";
import { describe, expect, it, vi } from "vitest";
import { createConfig, createConnector, http } from "wagmi";
import { connect, waitForTransactionReceipt } from "wagmi/actions";
import { wagmiPort } from "./use-flows";

// the real actions, but a receipt wait the test controls
vi.mock("wagmi/actions", async (importOriginal) => ({ ...(await importOriginal<typeof import("wagmi/actions")>()), waitForTransactionReceipt: vi.fn() }));

const ME = getAddress("0x000000000000000000000000000000000000a11c");
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

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

  it("hears from Base when the wallet puts another transaction in place of the one it waits for", async () => {
    const w = walletOn(base.id);
    vi.mocked(waitForTransactionReceipt).mockImplementation((async (_config: unknown, p: { onReplaced?: (r: unknown) => void }) => {
      p.onReplaced?.({ reason: "repriced", transaction: { hash: H(2) }, replacedTransaction: { hash: H(1) }, transactionReceipt: {} });
      return { status: "success" };
    }) as never);
    const seen: unknown[] = [];
    expect(await wagmiPort(w.config, ME, {} as never).wait(H(1), (r) => seen.push(r))).toEqual({ status: "success" });
    expect(vi.mocked(waitForTransactionReceipt).mock.calls[0][1]).toMatchObject({ hash: H(1), chainId: base.id });
    expect(seen).toEqual([{ hash: H(2), reason: "repriced" }]);
  });

  it("leaves a wallet already on Base where it is", async () => {
    const w = walletOn(base.id);
    await connect(w.config, { connector: w.config.connectors[0] } as never);
    await wagmiPort(w.config, ME, {} as never).switchToBase();
    expect(w.switched).toEqual([]);
  });
});
