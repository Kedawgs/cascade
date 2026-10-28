import { describe, expect, it } from "vitest";
import { BASKET_TWR_PREFIX, basketTwrKey, decodeTwr, netApyPercent } from "./apy";

const ONE = 2n ** 64n;
const DAY = 86_400;
/** U64F64 bits as the chain stores them: a u128, little-endian. */
const le = (bits: bigint) => `0x${Array.from({ length: 16 }, (_, k) => ((bits >> BigInt(8 * k)) & 0xffn).toString(16).padStart(2, "0")).join("")}` as const;

describe("BasketTwr storage", () => {
  it("keys a hotkey with Blake2_128Concat under SubtensorModule.BasketTwr (tao.bot, checked against the chain)", () => {
    const taoBot = "0x56a9aee6291bd03ab6d36d4d13e2bebae7cd403518066c72fba1b417d6ddd748";
    expect(basketTwrKey(taoBot)).toBe(`${BASKET_TWR_PREFIX}6c1664b37fae67165907bd92805ee938${taoBot.slice(2)}`);
  });

  it("decodes U64F64 little-endian bits, and an empty answer as no series", () => {
    expect(decodeTwr(le(ONE))).toBe(ONE);
    expect(decodeTwr(le(3n * 2n ** 63n))).toBe(3n * 2n ** 63n);
    expect(decodeTwr("0x")).toBeNull();
    expect(decodeTwr(undefined)).toBeNull();
  });

  it("refuses an answer that isn't exactly 16 bytes", () => {
    expect(decodeTwr("0x0102")).toBeNull();
    expect(decodeTwr(`${le(ONE)}00`)).toBeNull();
  });
});

describe("netApyPercent", () => {
  it("annualizes the window's return, takes Cascade's cut, and compounds monthly", () => {
    // +0.4% over 30 days: APR 4.8667%, 4.38% after a 10% cut, (1 + 0.0438/12)^12 - 1 = 4.4690%
    const apy = netApyPercent({ twrNow: (ONE * 1004n) / 1000n, twrThen: ONE, seconds: 30 * DAY, rewardCutBps: 1000 });
    expect(apy).toBeCloseTo(4.469, 3);
  });

  it("matches the on-chain prototype for tao.bot on 2026-10-28 (5.36%)", () => {
    const at = (x: number) => BigInt(Math.round(x * 1e12)) * (ONE / 10n ** 12n);
    const apy = netApyPercent({
      twrNow: at(1.009854518057),
      twrThen: at(1.005053043487),
      seconds: 30 * DAY + 17 * 60 + 12,
      rewardCutBps: 1000,
    });
    expect(apy?.toFixed(2)).toBe("5.36");
  });

  it("shows nothing it can't stand behind: no series, a loss, no time, or over 20%", () => {
    const base = { twrNow: (ONE * 1004n) / 1000n, twrThen: ONE, seconds: 30 * DAY, rewardCutBps: 1000 };
    expect(netApyPercent({ ...base, twrThen: null })).toBeUndefined();
    expect(netApyPercent({ ...base, twrNow: null })).toBeUndefined();
    expect(netApyPercent({ ...base, twrThen: 0n })).toBeUndefined();
    expect(netApyPercent({ ...base, twrNow: (ONE * 999n) / 1000n })).toBeUndefined();
    expect(netApyPercent({ ...base, seconds: 0 })).toBeUndefined();
    expect(netApyPercent({ ...base, twrNow: (ONE * 1020n) / 1000n })).toBeUndefined();
  });

  it("is labelled a 30-day figure, so a window far from 30 days isn't shown", () => {
    const base = { twrNow: (ONE * 1004n) / 1000n, twrThen: ONE, rewardCutBps: 1000 };
    expect(netApyPercent({ ...base, seconds: 26 * DAY })).toBeUndefined();
    expect(netApyPercent({ ...base, seconds: 34 * DAY })).toBeUndefined();
    expect(netApyPercent({ ...base, seconds: 27 * DAY })).toBeDefined();
    expect(netApyPercent({ ...base, seconds: 33 * DAY })).toBeDefined();
  });
});
