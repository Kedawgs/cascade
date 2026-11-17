import { type EIP1193Provider, numberToHex } from "viem";
import { describe, expect, it } from "vitest";
import { VAULT_V32 } from "./abi";
import type { FlowCall } from "./flows";
import { walletOn } from "./use-direct-exit";
import { USER, V32 } from "./__fixtures__/v32-chains";

// The wallet on Bittensor EVM (use-direct-exit.ts walletOn; the review of d33c4b5, M4): what the page asks the wallet to
// send, read where it reaches the wallet (its EIP-1193 eth_sendTransaction), so the withdrawal's gas limit and fees, and
// the account it sends from, can't fall away between the page and the wallet.

/** A wallet's provider on chain 964: every request it gets, and a hash for a send. */
function provider() {
  const asked: { method: string; params?: unknown }[] = [];
  const p = {
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      asked.push({ method, params });
      if (method === "eth_chainId") return "0x3c4";
      if (method === "eth_sendTransaction") return `0x${"d1".repeat(32)}`;
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as EIP1193Provider;
  const sent = () => (asked.find((a) => a.method === "eth_sendTransaction")?.params as Record<string, string>[] | undefined)?.[0];
  return { p, asked, sent };
}

const REDEEM: FlowCall = { key: "redeemDirect", to: V32.vault, abi: VAULT_V32, functionName: "redeemDirect", args: [5n, false] };

describe("the wallet on Bittensor EVM (walletOn)", () => {
  it("sends the withdrawal from the account, with the gas limit and the fees the page names", async () => {
    const { p, sent } = provider();
    await walletOn(p, USER).send(REDEEM, { gas: 2_531_747n, maxFeePerGas: 6_000_000_000n, maxPriorityFeePerGas: 1_000_000n });
    const tx = sent()!;
    expect(tx.from.toLowerCase()).toBe(USER.toLowerCase());
    expect(tx.to.toLowerCase()).toBe(V32.vault.toLowerCase());
    expect([tx.gas, tx.maxFeePerGas, tx.maxPriorityFeePerGas]).toEqual([numberToHex(2_531_747n), numberToHex(6_000_000_000n), numberToHex(1_000_000n)]);
  });

  it("names no gas or fees for a call sent without them: the wallet sets its own", async () => {
    const { p, sent } = provider();
    await walletOn(p, USER).send({ key: "setRedeemOrigin", to: V32.vault, abi: VAULT_V32, functionName: "setRedeemOrigin", args: [8453n] });
    const tx = sent()!;
    expect(tx.from.toLowerCase()).toBe(USER.toLowerCase());
    expect([tx.gas, tx.maxFeePerGas, tx.maxPriorityFeePerGas]).toEqual([undefined, undefined, undefined]);
  });
});
