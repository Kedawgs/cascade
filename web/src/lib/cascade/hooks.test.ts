import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { cascadeKeys, seedSnapshot } from "./hooks";

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
