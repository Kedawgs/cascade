import { afterEach, describe, expect, it, vi } from "vitest";
import { targets } from "../src/config.ts";
import { createRpc, nonceOf } from "../src/rpc.ts";

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
