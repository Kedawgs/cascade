import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { explorer } from "@/lib/cascade/config";
import { cascadeKeys } from "@/lib/cascade/hooks";
import { notConfiguredData } from "@/lib/cascade/live";
import { APY_FOOTNOTE } from "@/lib/stats";
import { type Cached, launchData, plainText, renderWithCache, shownText, spokenText } from "../test-render";
import { StatsCard, StatsCardForAccount } from "./StatsCard";

const DAY = 86_400_000;
const html = (cached: Cached[] = [], seededAt?: number) => renderWithCache(createElement(StatsCard), cached, { seededAt });
/** The card as a screen reader gives it: each figure once, a skeleton as "Loading", a dash as "Not available". */
const card = (cached: Cached[] = [], seededAt?: number) => spokenText(html(cached, seededAt));
/** The total staked (Bittensor's read) and the TAO price (Base's own read). */
const STAKED: Cached = { key: cascadeKeys.stats(), data: { totalStakedTao: 0 } };
const PRICE: Cached = { key: cascadeKeys.taoPrice(), data: 255.4384 };

describe("StatsCard", () => {
  it("has the snapshot's APY and total in the first HTML, but not its TAO price", () => {
    const seeded = Date.now() - 60_000;
    const text = card([{ key: cascadeKeys.apy(), data: 5.362, at: seeded }, { ...STAKED, at: seeded }, { ...PRICE, at: seeded }], seeded);
    expect(text).toContain("Annual percentage yield, in TAO*5.4%Total staked through Cascade0.0000 TAOTAO priceLoading");
    expect(text).toContain(APY_FOOTNOTE);
  });

  it("shows each figure once on screen and reads it out once", () => {
    const h = html([{ key: cascadeKeys.apy(), data: 5.362 }, STAKED, PRICE]);
    const rows = "Annual percentage yield, in TAO*5.4%Total staked through Cascade0.0000 TAOTAO price$255.44";
    expect(shownText(h)).toContain(rows);
    expect(spokenText(h)).toContain(rows);
    expect(h.match(/data-figure="value"/g)).toHaveLength(3);
  });

  it("shows the TAO price once a live read has replaced the snapshot's", () => {
    const seeded = Date.now() - 60_000;
    const text = card([{ key: cascadeKeys.apy(), data: 5.362, at: seeded }, { ...STAKED, at: seeded }, { ...PRICE, at: seeded + 20_000 }], seeded);
    expect(text).toContain("Total staked through Cascade0.0000 TAOTAO price$255.44");
  });

  it("shows the TAO price without the total staked: the price is Base's own read, which neither waits for Bittensor nor fails with it", () => {
    expect(card([PRICE])).toContain("Total staked through CascadeLoadingTAO price$255.44");
    expect(card([{ ...STAKED, data: undefined, failed: true }, PRICE])).toContain("TAO price$255.44");
    // and the total without the price
    expect(card([STAKED, { ...PRICE, at: Date.now() - 2 * 60 * 60_000, failed: true }])).toContain("Total staked through Cascade0.0000 TAOTAO priceNot available");
  });

  it("keeps the snapshot's total but not its price when the live reads fail", () => {
    const seeded = Date.now() - 60_000;
    const h = html([{ ...STAKED, at: seeded, failed: true }, { ...PRICE, at: seeded, failed: true }], seeded);
    expect(spokenText(h)).toContain("Total staked through Cascade0.0000 TAOTAO priceNot available");
    // a dash on screen, where the read finished without a value
    expect(shownText(h)).toContain("Total staked through Cascade0.0000 TAOTAO price–");
  });

  it("has the same rows, each with a skeleton in its figure's place, while it loads: no dash, no number", () => {
    const h = html();
    expect(spokenText(h)).toContain("Annual percentage yield, in TAO*LoadingTotal staked through CascadeLoadingTAO priceLoading");
    expect(shownText(h)).toContain("Annual percentage yield, in TAO*Total staked through CascadeTAO price");
    expect(h.match(/data-figure="loading"/g)).toHaveLength(3);
    expect(h).not.toContain('data-figure="none"');
    expect(plainText(h)).toContain(APY_FOOTNOTE);
  });

  it("has the same rows, each with a dash, when the reads fail with nothing to keep", () => {
    const h = html([
      { key: cascadeKeys.apy(), data: 5.4, at: Date.now() - 15 * DAY, failed: true },
      { ...STAKED, at: Date.now() - 2 * 60 * 60_000, failed: true },
      { ...PRICE, at: Date.now() - 2 * 60 * 60_000, failed: true },
    ]);
    expect(plainText(h)).toContain("Annual percentage yield, in TAO*–Not availableTotal staked through Cascade–Not availableTAO price–Not available");
    expect(h.match(/data-figure="none"/g)).toHaveLength(3);
    expect(h).not.toContain('data-figure="loading"');
    expect(plainText(h)).toContain(APY_FOOTNOTE);
  });

  it("keeps recent live figures through a failed read", () => {
    const text = card([
      { key: cascadeKeys.apy(), data: 5.4, at: Date.now() - DAY, failed: true },
      { ...STAKED, at: Date.now() - 60_000, failed: true },
      { ...PRICE, at: Date.now() - 60_000, failed: true },
    ]);
    expect(text).toContain("Annual percentage yield, in TAO*5.4%Total staked through Cascade0.0000 TAOTAO price$255.44");
  });

  it("keeps room for each row's figure from the first render, so its label never moves when the figure arrives", () => {
    const loading = html();
    const loaded = html([{ key: cascadeKeys.apy(), data: 5.362 }, STAKED, PRICE]);
    const rooms = (h: string) => [...h.matchAll(/<span class="([^"]*fig(?:Apy|Staked|Price)[^"]*)">/g)].map((m) => m[1].replace(/\s*\S*accent\S*/, ""));
    expect(rooms(loading)).toHaveLength(3);
    expect(rooms(loaded)).toEqual(rooms(loading));
  });
});

describe("the statistics card's View on Bittensor link", () => {
  it("is in the first HTML, from the deployment's own vault address: it waits on no read", () => {
    const data = launchData();
    const h = renderWithCache(createElement(StatsCardForAccount), [], { data });
    expect(h).toContain(`href="${explorer.account(data.deployment.vaultSs58)}"`);
    expect(plainText(h)).toContain("View on Bittensor");
  });

  it("is left out when the site has no deployment", () => {
    expect(plainText(renderWithCache(createElement(StatsCardForAccount), [], { data: notConfiguredData() }))).not.toContain("View on Bittensor");
  });
});
