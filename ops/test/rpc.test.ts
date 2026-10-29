import { numberToHex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { targets } from "../src/config.ts";
import { createRpc, firstBlockWithCode, nonceOf, type Rpc } from "../src/rpc.ts";

const live = targets({}).live;

function fakeFetch(statuses: number[], seen: { at: number; body: any }[] = []) {
  let i = 0;
  return vi.fn(async (_url: string, init: { body: string }) => {
    const status = statuses[Math.min(i++, statuses.length - 1)];
    seen.push({ at: Date.now(), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x7" }), { status });
  }) as unknown as typeof fetch;
}

afterEach(() => vi.useRealTimers());

describe("createRpc", () => {
  it("spaces Bittensor requests at least 600 ms apart", async () => {
    vi.useFakeTimers();
    const seen: { at: number; body: any }[] = [];
    const rpc = createRpc(live, { fetch: fakeFetch([200], seen) });
    const both = Promise.all([rpc.request("bittensor", "eth_chainId", []), rpc.request("bittensor", "eth_chainId", [])]);
    await vi.advanceTimersByTimeAsync(2_000);
    await both;
    expect(seen).toHaveLength(2);
    expect(seen[1].at - seen[0].at).toBeGreaterThanOrEqual(600);
  });

  it("retries an HTTP 429 after a backoff", async () => {
    const f = fakeFetch([429, 200]);
    const rpc = createRpc(live, { fetch: f, backoffMs: 1 });
    expect(await rpc.request("base", "eth_chainId", [])).toBe("0x7");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("gives up after six retries, naming the chain and method", async () => {
    const rpc = createRpc(live, { fetch: fakeFetch([429]), backoffMs: 1, minIntervalMs: { bittensor: 0 } });
    await expect(rpc.request("bittensor", "eth_getLogs", [])).rejects.toThrow(/bittensor.*eth_getLogs/);
  });

  it("reads the pending nonce", async () => {
    const seen: { at: number; body: any }[] = [];
    const rpc = createRpc(live, { fetch: fakeFetch([200], seen) });
    expect(await nonceOf(rpc, "base", "0x770932787DD3bcE64f14E31f4746bCe22E214fFF")).toBe(7);
    expect(seen[0].body.method).toBe("eth_getTransactionCount");
    expect(seen[0].body.params[1]).toBe("pending");
  });
});

describe("firstBlockWithCode", () => {
  const ADDR = "0x00000000000000000000000000000000000000c0";
  /** A chain whose head is `head` and where ADDR has code from block `created` on; records each block read. */
  function chain(head: bigint, created: bigint) {
    const read: bigint[] = [];
    const rpc: Rpc = {
      async request(_chain, method, params) {
        if (method === "eth_blockNumber") return numberToHex(head);
        if (method !== "eth_getCode") throw new Error(`unexpected ${method}`);
        expect(params[0]).toBe(ADDR);
        const at = BigInt(params[1] as string);
        read.push(at);
        return at >= created ? "0x6080" : "0x";
      },
    };
    return { rpc, read };
  }

  it("finds the block a contract was created in, asking only for blocks back to about twice its age", async () => {
    for (const [head, created] of [
      [6_000_000n, 5_999_990n],
      [6_000_000n, 4_123_457n],
      [6_000_000n, 6_000_000n],
      [6_000_000n, 1n],
      [6_000_000n, 0n],
    ]) {
      const c = chain(head, created);
      expect(await firstBlockWithCode(c.rpc, "bittensor", ADDR)).toBe(Number(created));
      const age = head - created;
      expect(c.read.every((b) => b >= 0n && head - b <= 2n * age + 1n)).toBe(true);
      expect(c.read.length).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(Number(age) + 2)) + 2);
    }
  });

  it("refuses an address with no code at the head", async () => {
    await expect(firstBlockWithCode(chain(1_000n, 2_000n).rpc, "bittensor", ADDR)).rejects.toThrow(/no code at 0x0+c0/);
  });
});
