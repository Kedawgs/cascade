import type { EIP1193Provider } from "viem";
import { describe, expect, it } from "vitest";
import { VAULT_V32 } from "./abi";
import { CANT_SWITCH, DirectExitStop, ensureBittensor, SWITCH_DECLINED } from "./direct-exit";
import { walletOn } from "./use-direct-exit";
import { USER, V32 } from "./__fixtures__/v32-chains";

// The emergency page (/unstake/bittensor) with a wallet connected through WalletConnect: the page's own handling of a
// wallet that can or can't go to Bittensor EVM (direct-exit.ts ensureBittensor), over a provider that answers as
// WalletConnect's does. A session is asked for chain 964 as one the wallet may approve (walletconnect-inner.ts); what
// the provider then does with a switch is its own rule (@walletconnect/universal-provider, providers/eip155.ts,
// handleSwitchChain), copied here.

/** WalletConnect's provider for a session: the chains and methods the wallet approved, and what the wallet's user
 * answers when a request reaches the wallet. */
function walletConnect(o: { approved: number[]; methods?: string[]; wallet?: (method: string) => unknown }) {
  const methods = o.methods ?? ["eth_sendTransaction", "personal_sign"];
  let chain = o.approved[0];
  const asked: string[] = [];
  const toWallet: string[] = [];
  const reach = async (method: string) => {
    toWallet.push(method);
    const answer = o.wallet?.(method);
    if (answer instanceof Error || (typeof answer === "object" && answer !== null && "code" in answer)) throw answer;
    return answer ?? null;
  };
  const p = {
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      asked.push(method);
      // the provider answers this itself, with a number
      if (method === "eth_chainId") return chain;
      if (method === "wallet_switchEthereumChain") {
        const id = parseInt((params as [{ chainId: string }])[0].chainId, 16);
        // an approved chain: it switches by itself, and the wallet is asked nothing
        if (o.approved.includes(id)) chain = id;
        else if (methods.includes(method)) {
          await reach(method);
          chain = id;
        } else throw new Error(`Failed to switch to chain 'eip155:${id}'. The chain is not approved or the wallet does not support 'wallet_switchEthereumChain' method.`);
        return null;
      }
      if (methods.includes(method)) {
        // the sign client refuses a request for a chain the session doesn't hold, before anything reaches the wallet
        if (!o.approved.includes(chain)) throw new Error(`Missing or invalid. request() chainId: eip155:${chain}`);
        return reach(method);
      }
      // anything the wallet didn't approve goes to the chain's RPC, which doesn't know a wallet's methods
      throw Object.assign(new Error(`the method ${method} does not exist/is not available`), { code: -32601 });
    },
  } as unknown as EIP1193Provider;
  return { p, asked, toWallet, chain: () => chain };
}

const stop = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(DirectExitStop);
  return (e as DirectExitStop).message;
};
const HASH = `0x${"d1".repeat(32)}`;

describe("the emergency page with a WalletConnect wallet", () => {
  it("goes to Bittensor EVM with no prompt when the wallet approved chain 964 for the session, and sends there", async () => {
    const wc = walletConnect({ approved: [8453, 964], wallet: (m) => (m === "eth_sendTransaction" ? HASH : null) });
    const wallet = walletOn(wc.p, USER);
    await ensureBittensor(wallet);
    expect(wc.chain()).toBe(964);
    // the provider switched by itself: nothing reached the wallet
    expect(wc.toWallet).toEqual([]);
    expect(await wallet.send({ key: "setRedeemOrigin", to: V32.vault, abi: VAULT_V32, functionName: "setRedeemOrigin", args: [964n] })).toBe(HASH);
    expect(wc.toWallet).toEqual(["eth_sendTransaction"]);
  });

  it("says in plain words how to add the network by hand when the wallet didn't approve 964 and can't be asked to switch", async () => {
    const wc = walletConnect({ approved: [8453] });
    expect(await stop(ensureBittensor(walletOn(wc.p, USER)))).toBe(CANT_SWITCH);
    expect(CANT_SWITCH).toBe("Your wallet couldn't switch to Bittensor EVM. Add it by hand: network Bittensor EVM, RPC https://archive.chain.opentensor.ai, chain ID 964, symbol TAO. Then try again.");
    // nothing reached the wallet, and nothing was sent
    expect(wc.toWallet).toEqual([]);
    expect(wc.chain()).toBe(8453);
  });

  it("says to switch when the wallet was asked and its user said no", async () => {
    for (const refusal of [{ code: 5000, message: "User rejected." }, { code: 4001, message: "User rejected the request." }, new Error("User rejected methods.")]) {
      const wc = walletConnect({ approved: [8453], methods: ["eth_sendTransaction", "wallet_switchEthereumChain"], wallet: () => refusal });
      expect(await stop(ensureBittensor(walletOn(wc.p, USER)))).toBe(SWITCH_DECLINED);
      expect(wc.toWallet).toEqual(["wallet_switchEthereumChain"]);
    }
    expect(SWITCH_DECLINED).toBe("Switch your wallet to Bittensor EVM to continue.");
  });

  it("says how to add it by hand when the wallet answers that it doesn't know the chain, whichever way it says so", async () => {
    for (const answer of [
      { code: 5100, message: "Unsupported chains." },
      new Error("Unrecognized chain ID 0x3c4"),
      // EIP-3326's 4902: the page then asks to add the chain, which this wallet's session doesn't take either
      { code: 4902, message: "Unrecognized chain ID" },
    ]) {
      const wc = walletConnect({ approved: [8453], methods: ["eth_sendTransaction", "wallet_switchEthereumChain"], wallet: () => answer });
      expect(await stop(ensureBittensor(walletOn(wc.p, USER))), JSON.stringify(answer)).toBe(CANT_SWITCH);
    }
  });

  it("adds chain 964 through the wallet when the wallet takes that request, then switches", async () => {
    let added = false;
    const wc = walletConnect({
      approved: [8453],
      methods: ["eth_sendTransaction", "wallet_switchEthereumChain", "wallet_addEthereumChain"],
      wallet: (m) => {
        if (m === "wallet_addEthereumChain") added = true;
        return m === "wallet_switchEthereumChain" && !added ? { code: 4902, message: "Unrecognized chain ID" } : null;
      },
    });
    // (the provider is on Base for the add, which the session holds)
    await ensureBittensor(walletOn(wc.p, USER));
    expect(wc.toWallet).toEqual(["wallet_switchEthereumChain", "wallet_addEthereumChain", "wallet_switchEthereumChain"]);
    expect(wc.chain()).toBe(964);
  });
});
