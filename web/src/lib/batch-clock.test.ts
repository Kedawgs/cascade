import { describe, expect, it } from "vitest";
import { chainNow, countdown, isStale, nextBatchLine, STALE_MS } from "./batch-clock";
import type { NextBatch } from "./cascade/types";

/** 8:00 AM UTC (the tests read times in UTC). */
const START = 1_800_000_000;
const DAY_S = 86_400;
/** When the read landed, by this device's clock (ms): a clock with no relation to Base's. */
const READ = 1_000_000_000_000;

describe("the countdown", () => {
  it("gives hours and minutes, rounded up so a wait is never understated", () => {
    expect(countdown(3 * 3_600 + 12 * 60)).toBe("3 h 12 min");
    expect(countdown(3 * 3_600 + 11 * 60 + 1)).toBe("3 h 12 min");
    expect(countdown(2 * 3_600)).toBe("2 h");
    expect(countdown(23 * 3_600 + 59 * 60 + 30)).toBe("24 h");
    // 59 min 59 s is an hour, not "60 min"
    expect(countdown(3_599)).toBe("1 h");
  });

  it("gives minutes under an hour", () => {
    expect(countdown(18 * 60)).toBe("18 min");
    expect(countdown(61)).toBe("2 min");
    expect(countdown(60)).toBe("1 min");
  });

  it("says under a minute for the last minute", () => {
    expect(countdown(59)).toBe("under a minute");
    expect(countdown(0.5)).toBe("under a minute");
  });

  it("says any moment now once it's due", () => {
    expect(countdown(0)).toBe("any moment now");
    expect(countdown(-120)).toBe("any moment now");
  });
});

describe("Base's clock", () => {
  it("runs from the block time the read came with, the device's clock measuring only the time since", () => {
    expect(chainNow(START, READ, READ)).toBe(START);
    expect(chainNow(START, READ, READ + 90_000)).toBe(START + 90);
  });

  it("never runs back before the read: the page's clock may have ticked last just before it landed", () => {
    expect(chainNow(START, READ, READ - 20_000)).toBe(START);
  });

  it("counts a read stale once it's older than a few missed reads, and no read as stale", () => {
    expect(isStale(READ, READ + STALE_MS)).toBe(false);
    expect(isStale(READ, READ + STALE_MS + 1)).toBe(true);
    expect(isStale(0, READ)).toBe(true);
  });
});

describe("the public Next batch line", () => {
  const batch = (over: Partial<NextBatch> = {}): NextBatch => ({
    id: 7n,
    start: START,
    interval: 3_600,
    canClose: false,
    paused: false,
    deposits: 1,
    redeems: 0,
    // read ten minutes into the batch
    chainTime: START + 600,
    ...over,
  });
  const line = (over: Partial<NextBatch> = {}, x: { after?: number; maxWaitS?: number } = {}) =>
    nextBatchLine(batch(over), { readAt: READ, now: READ + (x.after ?? 0), maxWaitS: "maxWaitS" in x ? x.maxWaitS : DAY_S });

  it("says when the next batch leaves at the latest, and what waits in it", () => {
    expect(line()).toBe("Next batch leaves within 23 h 50 min · 1 deposit waiting");
    expect(line({ deposits: 2, redeems: 1 })).toBe("Next batch leaves within 23 h 50 min · 2 deposits and 1 unstake waiting");
    expect(line({ deposits: 0, redeems: 3 })).toBe("Next batch leaves within 23 h 50 min · 3 unstakes waiting");
  });

  it("counts down on Base's clock between reads", () => {
    expect(line({}, { after: 120_000 })).toBe("Next batch leaves within 23 h 48 min · 1 deposit waiting");
    // and by the next read, from its block's time
    expect(line({ chainTime: START + 3_600 + 600 })).toBe("Next batch leaves within 22 h 50 min · 1 deposit waiting");
  });

  it("says it waits for the first deposit when the batch is empty", () => {
    expect(line({ deposits: 0, redeems: 0 })).toBe("Next batch: waiting for the first deposit");
    expect(line({ deposits: 0, redeems: 0, canClose: true, chainTime: START + 2 * DAY_S })).toBe("Next batch: waiting for the first deposit");
  });

  it("says any moment now once it's due but not yet closed, and within a minute just before", () => {
    expect(line({ canClose: true, chainTime: START + DAY_S + 30 })).toBe("Next batch leaves any moment now · 1 deposit waiting");
    expect(line({ canClose: true, chainTime: START + DAY_S - 30 })).toBe("Next batch leaves within a minute · 1 deposit waiting");
  });

  it("says any moment now for a full batch, which can close before its interval and is sent at once", () => {
    expect(line({ canClose: true, chainTime: START + 600, deposits: 50 })).toBe("Next batch leaves any moment now · 50 deposits waiting");
  });

  it("goes by the batch interval alone without a max wait (the keeper then sends each batch once it can close)", () => {
    expect(line({}, { maxWaitS: undefined })).toBe("Next batch leaves within 50 min · 1 deposit waiting");
  });

  it("shows a dash, never a time, when the read failed, hasn't come, or is stale", () => {
    expect(nextBatchLine(undefined, { readAt: 0, now: READ })).toBe("Next batch: –");
    expect(line({}, { after: STALE_MS + 1_000 })).toBe("Next batch: –");
    expect(nextBatchLine(batch(), { readAt: 0, now: READ, maxWaitS: DAY_S })).toBe("Next batch: –");
  });

  it("names no time while Cascade is paused: nothing leaves until it's lifted", () => {
    expect(line({ paused: true })).toBe("Next batch: on hold while Cascade is paused");
  });
});
