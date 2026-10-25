import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIVE, paths, SETTINGS, targets } from "../src/config.ts";

const forkBase = readFileSync(new URL("../../contracts/test/fork/ForkBase.sol", import.meta.url), "utf8");
const constant = (name: string) => forkBase.match(new RegExp(`${name} = (\\w+);`))?.[1];

describe("config", () => {
  it("copies the live constants from ForkBase.sol", () => {
    expect(LIVE.base.SELECTOR).toBe(15971525489660198786n);
    expect(LIVE.bittensor.SELECTOR).toBe(2135107236357186872n);
    expect(LIVE.bittensor.ROUTER).toBe(constant("BIT_ROUTER"));
    expect(LIVE.base.ROUTER).toBe(constant("BASE_ROUTER"));
    expect(LIVE.base.TOKEN).toBe(constant("BASE_TAO"));
    expect(LIVE.bittensor.TOKEN).toBe(constant("BIT_TAO"));
    expect(LIVE.base.OFFRAMP).toBe(constant("BASE_OFFRAMP"));
    expect(LIVE.bittensor.OFFRAMP).toBe(constant("BIT_OFFRAMP"));
    expect(LIVE.base.POOL).toBe(constant("BASE_POOL"));
    expect(LIVE.ALPHA_VAULT).toBe(constant("ALPHA_VAULT"));
  });

  it("holds the spec's test settings", () => {
    expect(SETTINGS.depositCap).toBe(150000000000000000n);
    expect(SETTINGS.payoutDelay).toBe(3600);
    expect(SETTINGS.batchInterval).toBe(600);
    expect(SETTINGS.baseGas).toEqual({ base: 540_000n, perEntry: 26_450n });
    expect(SETTINGS.bitGas).toEqual({ base: 120_000n, perEntry: 29_900n });
    expect(SETTINGS.vaultReserve).toBe(1_500_000_000_000n);
  });

  it("points the rehearsal at local forks with their own chain ids", () => {
    const t = targets({});
    expect(t.rehearsal.bittensor.chainId).toBe(31338);
    expect(t.rehearsal.base.chainId).toBe(31337);
    expect(t.live.base.chainId).toBe(8453);
    expect(t.live.bittensor.legacy).toBe(true);
    expect(t.live.base.legacy).toBe(false);
    expect(targets({ OPS_BASE_RPC: "https://x" }).live.base.rpcUrl).toBe("https://x");
  });

  it("finds the key material by path only, never the other keystore", () => {
    expect(paths({ OPS_PASSWORD_FILE: "x" }).passwordFile).toBe("x");
    expect(JSON.stringify(paths({}))).not.toContain("sf-mainnet");
    expect(paths({}).keystore).toMatch(/9ffde5b1-4193-4175-9eb3-a26f9d027214$/);
  });
});
