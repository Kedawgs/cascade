import { describe, expect, it } from "vitest";
import { LIVE } from "../src/config.ts";
import { checkAlphaVault, checkOffRamps, logProbe, simulationPassed } from "../src/preflight.ts";

const src = LIVE.bittensor.SELECTOR;
const want = LIVE.base.OFFRAMP;

describe("preflight", () => {
  const v2 = (offRamp: string, sourceChainSelector: bigint = src) => ({ sourceChainSelector, offRamp: offRamp as `0x${string}`, version: "OffRamp 2.0.0" });

  it("accepts exactly one OffRamp 2.0.0 for the source at the expected address, beside other versions", () => {
    expect(checkOffRamps([v2(want), v2(want, 1n)], src, want)).toBeNull();
    expect(checkOffRamps([v2(want), { ...v2(LIVE.ALPHA_VAULT), version: "OffRamp 1.6.0" }], src, want)).toBeNull();
  });

  it("refuses two OffRamps 2.0.0 for one source, none, or a different address", () => {
    expect(checkOffRamps([v2(want), v2(LIVE.ALPHA_VAULT)], src, want)).toMatch(/2 OffRamps 2\.0\.0/);
    expect(checkOffRamps([{ ...v2(want), version: "OffRamp 1.6.0" }], src, want)).toMatch(/0 OffRamps 2\.0\.0/);
    expect(checkOffRamps([v2(LIVE.ALPHA_VAULT)], src, want)).toMatch(/expected/);
  });

  it("refuses a paused, migrating or migrated AlphaVault", () => {
    expect(checkAlphaVault({ isPaused: false, migrationReadyAt: 0n, migrationFinished: false })).toBeNull();
    expect(checkAlphaVault({ isPaused: true, migrationReadyAt: 0n, migrationFinished: false })).toMatch(/paused/);
    expect(checkAlphaVault({ isPaused: false, migrationReadyAt: 1n, migrationFinished: false })).toMatch(/migration/);
    expect(checkAlphaVault({ isPaused: false, migrationReadyAt: 0n, migrationFinished: true })).toMatch(/migrat/);
  });

  it("reads the simulation's verdict", () => {
    expect(simulationPassed("...\nSIMULATION OK: delivered 1 TAO\n")).toBe(true);
    expect(simulationPassed("SIMULATION FAILED: ConversionShort")).toBe(false);
  });

  it("probes log queries with the keeper's window on each chain", async () => {
    const asked: [string, bigint][] = [];
    const rpc = {
      async request(chain: string, method: string, params: unknown[]) {
        if (method === "eth_blockNumber") return "0x3e8";
        const q = params[0] as { fromBlock: string; toBlock: string };
        asked.push([chain, BigInt(q.toBlock) - BigInt(q.fromBlock) + 1n]);
        if (chain === "base" && BigInt(q.toBlock) - BigInt(q.fromBlock) + 1n > 200n) throw new Error("limited to a 200 range");
        return [];
      },
    };
    expect(await logProbe({ rpc } as never, "base")).toBeNull();
    expect(asked).toEqual([["base", 100n]]);
  });
});
