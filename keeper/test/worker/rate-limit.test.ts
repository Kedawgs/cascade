import { describe, expect, it } from "vitest";

import type { KeeperConfig } from "../../src/config.ts";
import { MULTICALL3 } from "../../src/config.ts";
import { freshLearned, runRpc } from "../../src/rpc.ts";

// A node that turns requests away (HTTP 429). The live keeper's Bittensor node (a free tier) turned away about one
// request in ten, all day (2026-11-19). With one retry a quiet round of a few requests got through, but the first
// mainnet payout's round, with many more requests, failed fourteen times in a row behind "still rate limited after 1
// retries". A request is now asked up to four times, 2 s apart, before the round gives it up.

const cfg = {
  spacingMs: { base: 0, bittensor: 0 },
  urls: { base: "http://base.test", baseLogs: "http://base-logs.test", bittensor: "http://bittensor.test" },
  subrequestBudget: 300,
  deployment: { chainIds: { base: 8453, bittensor: 964 } },
} as unknown as KeeperConfig;

/** A node that turns the first `away` requests away and answers the rest with a block number. */
function node(away: number) {
  let asked = 0;
  const fetchFake = (async () => {
    asked++;
    if (asked <= away) return new Response("", { status: 429 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: asked, result: "0x10" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const { rpc } = runRpc(cfg, { fetch: fetchFake, learned: freshLearned(), now: () => Date.now(), log: () => undefined, multicall3: MULTICALL3 });
  return { rpc, asked: () => asked };
}

describe("a node that turns requests away (429)", () => {
  it("a request turned away three times in a row is answered on its fourth asking", { timeout: 30_000 }, async () => {
    const n = node(3);
    await expect(n.rpc.request("bittensor", "eth_blockNumber", [])).resolves.toBe("0x10");
    expect(n.asked()).toBe(4);
  });

  it("turned away a fourth time, the request is given up, and the error says how often it was asked again", { timeout: 30_000 }, async () => {
    const n = node(1_000);
    await expect(n.rpc.request("bittensor", "eth_blockNumber", [])).rejects.toThrow(/bittensor eth_blockNumber: still rate limited after 3 retries/);
    expect(n.asked()).toBe(4);
  });

  it("the retries are spaced: three turnings away cost about 6 s, not an instant hammering of the node", { timeout: 30_000 }, async () => {
    const n = node(3);
    const t0 = Date.now();
    await n.rpc.request("bittensor", "eth_blockNumber", []);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(5_500);
  });
});
