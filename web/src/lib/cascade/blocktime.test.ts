import { describe, expect, it } from "vitest";
import { BLOCK_SPAN, blockMsOf, blocksIn } from "./blocktime";

/** A client whose block n is at 1,000 + n × `s` seconds, whole seconds as a header gives them (head `head`), and `extra`
 * seconds added to the blocks after `after` (a halt or an outage). */
function client(s: number, head = 100_000n, o: { after?: bigint; extra?: number } = {}) {
  const asked: (bigint | "latest")[] = [];
  return {
    asked,
    getBlock: async (q?: { blockTag?: string; blockNumber?: bigint }) => {
      const n = q?.blockNumber ?? head;
      asked.push(q?.blockNumber ?? "latest");
      return { number: n, timestamp: BigInt(1_000 + Math.floor(Number(n) * s) + (o.after !== undefined && n > o.after ? (o.extra ?? 0) : 0)) };
    },
  };
}

describe("a chain's block time, from two spans of its headers", () => {
  it("reads Base's 200 ms (its old 2 s) and Bittensor's 12 s from the tip and two spans back, once a client", async () => {
    expect(BLOCK_SPAN).toEqual({ base: 1_000n, bittensor: 300n });
    const base = client(0.2);
    expect(await blockMsOf(base as never, BLOCK_SPAN.base)).toBe(200);
    expect(await blockMsOf(base as never, BLOCK_SPAN.base)).toBe(200);
    expect(base.asked).toEqual(["latest", 99_000n, 98_000n]);
    expect(await blockMsOf(client(2) as never, BLOCK_SPAN.base)).toBe(2_000);
    expect(await blockMsOf(client(12) as never, BLOCK_SPAN.bittensor)).toBe(12_000);
  });

  it("takes the faster span: an outage in the newest never reads it slow", async () => {
    expect(await blockMsOf(client(0.2, 100_000n, { after: 99_500n, extra: 600 }) as never, BLOCK_SPAN.base)).toBe(200);
  });

  it("refuses blocks not apart in time, keeping nothing", async () => {
    const flat = { getBlock: async (q?: { blockNumber?: bigint }) => ({ number: q?.blockNumber ?? 5_000n, timestamp: 7n }) };
    await expect(blockMsOf(flat as never, BLOCK_SPAN.base)).rejects.toThrow(/can't be read/);
    expect(blocksIn(300_000, 200)).toBe(1_500n);
  });
});
