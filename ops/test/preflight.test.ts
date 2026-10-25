import { describe, expect, it } from "vitest";
import { LIVE } from "../src/config.ts";
import { checkAlphaVault, checkOffRamps, simulationPassed } from "../src/preflight.ts";

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
});
