import { QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { type Cached, plainText, renderWithCache } from "@/components/test-render";
import { cascadeKeys, seedSnapshot, useTaoPrice } from "./hooks";

describe("seedSnapshot", () => {
  it("puts the snapshot's figures in the cache, dated when they were read", () => {
    const client = new QueryClient();
    seedSnapshot(client, { at: 1_700_000_000_000, apyPercent: 5.4, stats: { totalStakedTao: 0, taoPriceUsd: 255 } });
    expect(client.getQueryData(cascadeKeys.apy())).toBe(5.4);
    expect(client.getQueryState(cascadeKeys.apy())?.dataUpdatedAt).toBe(1_700_000_000_000);
    expect(client.getQueryData(cascadeKeys.stats())).toEqual({ totalStakedTao: 0, taoPriceUsd: 255 });
    expect(client.getQueryState(cascadeKeys.stats())?.dataUpdatedAt).toBe(1_700_000_000_000);
  });

  it("leaves out a figure the snapshot doesn't have, so its query loads as before", () => {
    const client = new QueryClient();
    seedSnapshot(client, { at: 1, stats: { taoPriceUsd: 255 } });
    expect(client.getQueryState(cascadeKeys.apy())).toBeUndefined();
    seedSnapshot(client, { at: 1 });
    expect(client.getQueryData(cascadeKeys.stats())).toEqual({ taoPriceUsd: 255 });
  });
});

describe("useTaoPrice", () => {
  // a minute ago, so the hour a failed read keeps a price for hasn't run out
  const SEEDED = Date.now() - 60_000;
  const stats = (over: Partial<Cached> = {}): Cached => ({ key: cascadeKeys.stats(), data: { totalStakedTao: 12.5, taoPriceUsd: 255.5 }, ...over });
  function Probe() {
    const price = useTaoPrice();
    return createElement("b", null, price === undefined ? "none" : String(price));
  }
  const price = (cached: Cached[], seededAt?: number) => plainText(renderWithCache(createElement(Probe), cached, { seededAt }));

  it("has no price while the figures are still the server's snapshot", () => {
    expect(price([stats({ at: SEEDED })], SEEDED)).toBe("none");
  });

  it("has the price once a live read has replaced the snapshot's", () => {
    expect(price([stats({ at: SEEDED + 20_000 })], SEEDED)).toBe("255.5");
  });

  it("counts a live read as live even when this browser's clock is behind the build machine's", () => {
    expect(price([stats({ at: SEEDED - 5 * 60_000 })], SEEDED)).toBe("255.5");
  });

  it("has no price when the live read failed with only the snapshot's to show", () => {
    expect(price([stats({ at: SEEDED, failed: true })], SEEDED)).toBe("none");
  });

  it("has the live price when there was no snapshot", () => {
    expect(price([stats()])).toBe("255.5");
    expect(price([])).toBe("none");
  });

  it("keeps a live price through a failed read for an hour, then drops it", () => {
    expect(price([stats({ at: Date.now() - 30 * 60_000, failed: true })], SEEDED)).toBe("255.5");
    expect(price([stats({ at: Date.now() - 2 * 60 * 60_000, failed: true })], SEEDED)).toBe("none");
  });
});
