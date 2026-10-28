import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { cascadeKeys } from "@/lib/cascade/hooks";
import { APY_FOOTNOTE } from "@/lib/stats";
import { type Cached, plainText, renderWithCache } from "../test-render";
import { StatsCard } from "./StatsCard";

const DAY = 86_400_000;
const card = (cached: Cached[] = [], seededAt?: number) => plainText(renderWithCache(createElement(StatsCard), cached, { seededAt }));
const STATS: Cached = { key: cascadeKeys.stats(), data: { totalStakedTao: 0, taoPriceUsd: 255.4384 } };

describe("StatsCard", () => {
  it("has the snapshot's APY and total in the first HTML, but not its TAO price", () => {
    const seeded = Date.now() - 60_000;
    const text = card([{ key: cascadeKeys.apy(), data: 5.362, at: seeded }, { ...STATS, at: seeded }], seeded);
    expect(text).toContain("Annual percentage yield, in TAO*5.4%Total staked through Cascade0.0000 TAOTAO price–Loading");
    expect(text).toContain(APY_FOOTNOTE);
  });

  it("shows the TAO price once a live read has replaced the snapshot's", () => {
    const seeded = Date.now() - 60_000;
    const text = card([{ key: cascadeKeys.apy(), data: 5.362, at: seeded }, { ...STATS, at: seeded + 20_000 }], seeded);
    expect(text).toContain("Total staked through Cascade0.0000 TAOTAO price$255.44");
  });

  it("keeps the snapshot's total but not its price when the live read fails", () => {
    const seeded = Date.now() - 60_000;
    const text = card([{ ...STATS, at: seeded, failed: true }], seeded);
    expect(text).toContain("Total staked through Cascade0.0000 TAOTAO price–Not available");
  });

  it("has the same rows, with dashes, while it loads", () => {
    const text = card();
    expect(text).toContain("Annual percentage yield, in TAO*–LoadingTotal staked through Cascade–LoadingTAO price–Loading");
    expect(text).toContain(APY_FOOTNOTE);
  });

  it("has the same rows when the reads fail with nothing to keep", () => {
    const text = card([
      { key: cascadeKeys.apy(), data: 5.4, at: Date.now() - 15 * DAY, failed: true },
      { ...STATS, at: Date.now() - 2 * 60 * 60_000, failed: true },
    ]);
    expect(text).toContain(
      "Annual percentage yield, in TAO*–Not availableTotal staked through Cascade–Not availableTAO price–Not available",
    );
    expect(text).toContain(APY_FOOTNOTE);
  });

  it("keeps recent live figures through a failed read", () => {
    const text = card([
      { key: cascadeKeys.apy(), data: 5.4, at: Date.now() - DAY, failed: true },
      { ...STATS, at: Date.now() - 60_000, failed: true },
    ]);
    expect(text).toContain("Annual percentage yield, in TAO*5.4%Total staked through Cascade0.0000 TAOTAO price$255.44");
  });
});
