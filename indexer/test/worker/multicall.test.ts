import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { ERC20, ORACLE, UNISWAP_POOL } from "../../src/abi.ts";
import { MULTICALL3_ADDRESS, multicall, newerThan } from "../../src/multicall.ts";
import { Budget, createRpc } from "../../src/rpc.ts";
import { ethCall, fakeChains, raw, REVERT, TEST_URLS } from "./fake-rpc.ts";

const TOKEN = "0xf3081494b87e8d5fb7960f066e931d1d0e6e3d67" as Hex;
const POOL = "0x82dd34c6631c286cdd1db16f2c232f60e402dd5a" as Hex;
const ORACLE_AT = "0x9788d195aece108638d519bfa3a09004b3005e4d" as Hex;
const HOLDER = "0x00000000000000000000000000000000000a11ce" as Hex;

function setup(o: { head?: bigint; lagBy?: bigint; oracle?: () => unknown } = {}) {
  const net = fakeChains({
    base: {
      head: o.head ?? 1000n,
      lagBy: o.lagBy,
      calls: {
        eth_call: ethCall(
          {
            [TOKEN]: { abi: ERC20, fns: { totalSupply: () => 21n * 10n ** 24n, balanceOf: ([a]) => (String(a).toLowerCase() === HOLDER ? 5n : 0n) } },
            [POOL]: { abi: UNISWAP_POOL, fns: { slot0: () => [79228162514264337593543950336n, 0, 1, 2, 3, 0, true], liquidity: () => 123456789n } },
            [ORACLE_AT]: { abi: ORACLE, fns: { usdcValue: o.oracle ?? (() => 400_000_000n) } },
          },
          { time: (at) => 1_750_000_000 + Number(at) * 2, balance: (a) => (a.toLowerCase() === HOLDER ? 7n * 10n ** 15n : 0n) },
        ),
      },
    },
  });
  const budget = new Budget(45);
  const rpc = createRpc({ urls: TEST_URLS, fetch: net.fetch, budget, sleep: async () => {}, spacingMs: { base: 0, bittensor: 0 } });
  return { net, budget, rpc };
}

describe("multicall", () => {
  it("decodes several reads in order, with the block and time they were read at, in one eth_call", async () => {
    const { net, budget, rpc } = setup();
    const r = await multicall(rpc, "base", [
      { address: TOKEN, abi: ERC20, functionName: "totalSupply" },
      { address: POOL, abi: UNISWAP_POOL, functionName: "liquidity" },
      { address: TOKEN, abi: ERC20, functionName: "balanceOf", args: [HOLDER] },
    ]);
    expect(r.block).toBe(1000n);
    expect(r.time).toBe(1_750_002_000);
    expect(r.results).toEqual([
      { ok: true, value: 21n * 10n ** 24n },
      { ok: true, value: 123456789n },
      { ok: true, value: 5n },
    ]);
    expect(net.fetches).toHaveLength(1);
    expect(net.fetches[0].methods).toEqual(["eth_call"]);
    expect(budget.left).toBe(44);
  });

  it("decodes a view with several outputs", async () => {
    const { rpc } = setup();
    const r = await multicall(rpc, "base", [{ address: POOL, abi: UNISWAP_POOL, functionName: "slot0" }]);
    expect(r.results[0]).toEqual({ ok: true, value: [79228162514264337593543950336n, 0, 1, 2, 3, 0, true] });
  });

  it("marks a reverted sub-call not ok, and still decodes the others", async () => {
    const { rpc } = setup({ oracle: () => REVERT });
    const r = await multicall(rpc, "base", [
      { address: TOKEN, abi: ERC20, functionName: "totalSupply" },
      { address: ORACLE_AT, abi: ORACLE, functionName: "usdcValue", args: [10n ** 18n] },
      { address: POOL, abi: UNISWAP_POOL, functionName: "liquidity" },
    ]);
    expect(r.results).toEqual([{ ok: true, value: 21n * 10n ** 24n }, { ok: false }, { ok: true, value: 123456789n }]);
  });

  it("marks a sub-call whose answer doesn't decode not ok (an empty answer from an address with no code too)", async () => {
    const { rpc } = setup({ oracle: () => raw("0x1234") });
    const r = await multicall(rpc, "base", [
      { address: ORACLE_AT, abi: ORACLE, functionName: "usdcValue", args: [10n ** 18n] },
      { address: "0x000000000000000000000000000000000000dead", abi: ERC20, functionName: "totalSupply" },
    ]);
    expect(r.results).toEqual([{ ok: false }, { ok: false }]);
  });

  it("reads an ETH balance as a bigint", async () => {
    const { rpc } = setup();
    const r = await multicall(rpc, "base", [{ ethBalance: HOLDER }, { ethBalance: TOKEN }]);
    expect(r.results).toEqual([
      { ok: true, value: 7n * 10n ** 15n },
      { ok: true, value: 0n },
    ]);
  });

  it("reports the older block a lagging node answered from, for the caller to drop", async () => {
    const { rpc } = setup({ head: 1000n, lagBy: 3n });
    const r = await multicall(rpc, "base", [{ address: TOKEN, abi: ERC20, functionName: "totalSupply" }]);
    expect(r.block).toBe(997n);
    expect(newerThan(1000n, r)).toBe(false);
  });

  it("uses Multicall3's address on both chains", () => {
    expect(MULTICALL3_ADDRESS).toBe("0xca11bde05977b3631167028862be2a173976ca11");
  });
});

describe("newerThan", () => {
  it("keeps only a reading from a later block", () => {
    expect(newerThan(100n, { block: 100n })).toBe(false);
    expect(newerThan(100n, { block: 99n })).toBe(false);
    expect(newerThan(100n, { block: 101n })).toBe(true);
    expect(newerThan(undefined, { block: 1n })).toBe(true);
  });
});
