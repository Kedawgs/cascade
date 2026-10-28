import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { cascadeKeys } from "@/lib/cascade/hooks";
import { type Cached, plainText, renderWithCache } from "../test-render";
import { PriceStrip } from "./StakeForm";

const SEEDED = Date.now() - 60_000;
const strip = (cached: Cached[], seededAt?: number) => plainText(renderWithCache(createElement(PriceStrip), cached, { seededAt }));
const stats = (over: Partial<Cached>): Cached => ({ key: cascadeKeys.stats(), data: { totalStakedTao: 1, taoPriceUsd: 254.49 }, ...over });

describe("PriceStrip", () => {
  it("doesn't show the snapshot's TAO price as today's", () => {
    expect(strip([stats({ at: SEEDED })], SEEDED)).toContain("TAO –Loading");
  });

  it("shows the price from a live read", () => {
    expect(strip([stats({ at: SEEDED + 20_000 })], SEEDED)).toContain("TAO $254.49");
  });

  it("says the price isn't available when the live read fails with only the snapshot's", () => {
    expect(strip([stats({ at: SEEDED, failed: true })], SEEDED)).toContain("TAO –Not available");
  });
});
