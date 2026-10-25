import { describe, expect, it } from "vitest";
import { WALLET } from "../src/config.ts";
import { ethSweepValue, sweepDestinations, taoSweepValue, windDownBlockers } from "../src/winddown.ts";

const KEY = `0x${"aa".repeat(32)}` as const;

describe("wind-down", () => {
  const idle = {
    frontDoor: { nDeposits: 0, nRedeems: 0 },
    batches: [] as { key: `0x${string}`; cursor: number; count: number }[],
    claimable: [{ user: WALLET, amount: 0n }],
  };

  it("lets a fully paid-out test wind down", () => {
    expect(windDownBlockers(idle)).toEqual([]);
  });

  it("refuses while a payout is queued, and lists what is outstanding", () => {
    const busy = { ...idle, batches: [{ key: KEY, cursor: 0, count: 1 }], claimable: [{ user: WALLET, amount: 5n * 10n ** 15n }] };
    const b = windDownBlockers(busy);
    expect(b).toHaveLength(2);
    expect(b[0]).toMatch(/payout batch 0xaaaaaaaa/);
    expect(b[1]).toMatch(/0\.005 TAO is still claimable/);
  });

  it("refuses while the open batch has entries", () => {
    expect(windDownBlockers({ ...idle, frontDoor: { nDeposits: 1, nRedeems: 0 } })[0]).toMatch(/open batch/);
  });
});

describe("sweep", () => {
  it("floors TAO to whole rao after gas and a 1e12-wei margin", () => {
    // 0.0123456789123 TAO − 30,000 × 5 gwei − 1e12 = 12,194,678,912,300,000 wei → floored to whole rao (1e9 wei)
    expect(taoSweepValue(12_345_678_912_300_000n, 30_000n, 5_000_000_000n)).toBe(12_194_678_000_000_000n);
    expect(taoSweepValue(10n ** 12n, 30_000n, 5_000_000_000n)).toBe(0n);
  });

  it("keeps three times the gas and an L1 allowance on Base", () => {
    expect(ethSweepValue(10n ** 15n, 26_250n, 6_000_000n)).toBe(10n ** 15n - 26_250n * 3n * 6_000_000n - 2n * 10n ** 13n);
    expect(ethSweepValue(10n ** 13n, 26_250n, 6_000_000n)).toBe(0n);
  });

  it("refuses a non-checksummed Base address or a bad SS58", () => {
    expect(() => sweepDestinations("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY", WALLET.toLowerCase())).toThrow(/checksummed/);
    expect(() => sweepDestinations("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQZ", WALLET)).toThrow(/checksum/);
    expect(sweepDestinations("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY", WALLET)).toEqual({
      taoKey: "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d",
      ethTo: WALLET,
    });
  });
});
