import { describe, expect, it } from "vitest";
import { freshTip, StaleChainError } from "./fresh";

const NOW_MS = 1_800_000_000_000;

/** A load-balanced endpoint: each call is answered by the next server in the list. */
function servers(...tips: { number: bigint; ageSeconds: number }[]) {
  let i = 0;
  return {
    calls: () => i,
    bittensor: {
      async getBlock() {
        const t = tips[Math.min(i++, tips.length - 1)];
        return { number: t.number, timestamp: BigInt(NOW_MS / 1000 - t.ageSeconds) };
      },
    },
  };
}

describe("freshTip", () => {
  it("takes the newest block when it is recent", async () => {
    const s = servers({ number: 9_400_000n, ageSeconds: 12 });
    expect(await freshTip(s as never, NOW_MS)).toBe(9_400_000n);
  });

  it("asks again when a server is hours behind, and takes the up-to-date answer", async () => {
    const s = servers({ number: 9_358_543n, ageSeconds: 3 * 3600 }, { number: 9_359_600n, ageSeconds: 6 });
    expect(await freshTip(s as never, NOW_MS)).toBe(9_359_600n);
    expect(s.calls()).toBe(2);
  });

  it("says Bittensor is behind when every answer is old, rather than showing an old picture", async () => {
    const s = servers({ number: 9_358_543n, ageSeconds: 3 * 3600 });
    await expect(freshTip(s as never, NOW_MS)).rejects.toBeInstanceOf(StaleChainError);
    await expect(freshTip(s as never, NOW_MS)).rejects.toThrow(/behind/);
  });

  it("judges freshness by Base's clock, so a device clock an hour fast doesn't make a healthy node look stale", async () => {
    const chainNow = Math.floor(Date.now() / 1000) - 3600; // the chains run an hour behind this device's clock
    const c = {
      bittensor: { getBlock: async () => ({ number: 9_400_000n, timestamp: BigInt(chainNow - 10) }) },
      base: { getBlock: async () => ({ number: 40_000_000n, timestamp: BigInt(chainNow) }) },
    };
    expect(await freshTip(c as never)).toBe(9_400_000n);
  });
});

