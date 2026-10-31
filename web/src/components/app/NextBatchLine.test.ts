import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { cascadeKeys } from "@/lib/cascade/hooks";
import type { NextBatch } from "@/lib/cascade/types";
import { type Cached, launchData, plainText, renderWithCache } from "../test-render";
import { NextBatchLine } from "./NextBatchLine";

/** 8:00 AM UTC (the tests read times in UTC). */
const START = 1_800_000_000;

describe("the public Next batch line", () => {
  /** Batch 7 read just now, ten minutes in, on the launch deployment (24-hour max wait). */
  const next = (over: Partial<NextBatch> = {}): NextBatch => ({
    id: 7n,
    start: START,
    interval: 3_600,
    canClose: false,
    paused: false,
    deposits: 1,
    redeems: 0,
    chainTime: START + 600,
    ...over,
  });
  const line = (cached: Cached[]) => plainText(renderWithCache(createElement(NextBatchLine), cached, { data: launchData() }));

  it("says when the next batch leaves and what waits in it, with no wallet connected", () => {
    expect(line([{ key: cascadeKeys.nextBatch(), data: next(), at: Date.now() }])).toBe("Next batch leaves within 23 h 50 min · 1 deposit waiting");
  });

  it("waits for the first deposit when the batch is empty", () => {
    expect(line([{ key: cascadeKeys.nextBatch(), data: next({ deposits: 0 }), at: Date.now() }])).toBe("Next batch: waiting for the first deposit");
  });

  it("shows a dash before the read, after a failed one, and once it's stale", () => {
    expect(line([])).toBe("Next batch: –");
    expect(line([{ key: cascadeKeys.nextBatch(), failed: true }])).toBe("Next batch: –");
    expect(line([{ key: cascadeKeys.nextBatch(), data: next(), at: Date.now() - 200_000 }])).toBe("Next batch: –");
  });
});
