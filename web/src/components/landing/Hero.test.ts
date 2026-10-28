import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { cascadeKeys } from "@/lib/cascade/hooks";
import { APY_FOOTNOTE } from "@/lib/stats";
import { type Cached, plainText, renderWithCache } from "../test-render";
import { Hero } from "./Hero";

const DAY = 86_400_000;
const hero = (cached: Cached[] = []) => plainText(renderWithCache(createElement(Hero), cached));
const apy = (data?: number, over: Partial<Cached> = {}): Cached => ({ key: cascadeKeys.apy(), data, ...over });
const stats = (totalStakedTao: number, over: Partial<Cached> = {}): Cached => ({
  key: cascadeKeys.stats(),
  data: { totalStakedTao, taoPriceUsd: 255 },
  ...over,
});

describe("Hero", () => {
  it("has the snapshot's APY and its footnote in the first HTML", () => {
    const text = hero([apy(5.362), stats(0)]);
    expect(text).toContain("5.4%APY in TAO*");
    expect(text).toContain(APY_FOOTNOTE);
  });

  it("keeps the APY's place and the footnote while the APY loads", () => {
    const text = hero();
    expect(text).toContain("–LoadingAPY in TAO*");
    expect(text).toContain(APY_FOOTNOTE);
  });

  it("keeps showing the APY through a failed read, for up to 14 days", () => {
    expect(hero([apy(5.4, { at: Date.now() - 13 * DAY, failed: true })])).toContain("5.4%APY in TAO*");
  });

  it("shows a dash in the APY's place once a failed read leaves only an older value", () => {
    const text = hero([apy(5.4, { at: Date.now() - 15 * DAY, failed: true })]);
    expect(text).toContain("–Not availableAPY in TAO*");
    expect(text).toContain(APY_FOOTNOTE);
  });

  it("shows the total staked from a dollar up", () => {
    expect(hero([apy(5.4), stats(0)])).not.toContain("Total staked");
    expect(hero([apy(5.4), stats(0.003)])).not.toContain("Total staked");
    expect(hero([apy(5.4), stats(10)])).toContain("$2.6KTotal staked");
  });

  it("keeps the total's place, with a dash, once a failed read leaves only an old value", () => {
    expect(hero([apy(5.4), stats(10, { at: Date.now() - 2 * 60 * 60_000, failed: true })])).toContain("–Not availableTotal staked");
  });
});
