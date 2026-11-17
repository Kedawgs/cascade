import { describe, expect, it } from "vitest";
import { COUNT_MS, type CountClock, countAt, startCount } from "./count";
import { formatUsdCompact } from "./format";
import { formatApy } from "./stats";

/** A browser's frames, run by hand: `frame(ms)` moves the clock on and runs the frame that was asked for. */
function frames() {
  let now = 1_000;
  let next: ((t: number) => void) | null = null;
  let asked = 0;
  let cancelled = 0;
  const clock: CountClock = {
    now: () => now,
    request: (step) => {
      next = step;
      return ++asked;
    },
    cancel: () => {
      cancelled++;
      next = null;
    },
  };
  return {
    clock,
    waiting: () => next !== null,
    asked: () => asked,
    cancelled: () => cancelled,
    frame(ms: number) {
      now += ms;
      const step = next;
      next = null;
      step?.(now);
    },
  };
}

/** A count on those frames, with every text it put on screen. */
function count(from: number | undefined, to: number, over: { reducedMotion?: boolean; format?: (n: number) => string } = {}) {
  const f = frames();
  const painted: string[] = [];
  const cancel = startCount({
    from,
    to,
    format: over.format ?? formatApy,
    reducedMotion: over.reducedMotion ?? false,
    clock: f.clock,
    paint: (text) => painted.push(text),
  });
  return { ...f, painted, cancel };
}

describe("a figure counting to its new value", () => {
  it("takes about 600 ms", () => {
    expect(COUNT_MS).toBe(600);
  });

  it("starts on the value that was on screen, and ends exactly on the real one", () => {
    const c = count(3.4, 5.4);
    // at once, before the browser paints the frame the new value was rendered in: the old value stays
    expect(c.painted).toEqual(["3.4%"]);
    c.frame(16);
    c.frame(284);
    c.frame(299);
    expect(c.waiting()).toBe(true);
    c.frame(1);
    expect(c.painted.at(-1)).toBe("5.4%");
    // and asks for no frame after its last
    expect(c.waiting()).toBe(false);
    c.frame(100);
    expect(c.painted.at(-1)).toBe("5.4%");
    expect(c.painted).toHaveLength(5);
  });

  it("eases out: most of the way in the first half, never past the value, never back", () => {
    expect(countAt(0, 100, 0)).toBe(0);
    expect(countAt(0, 100, COUNT_MS / 2)).toBeCloseTo(87.5, 6);
    expect(countAt(0, 100, COUNT_MS)).toBe(100);
    expect(countAt(0, 100, COUNT_MS + 5_000)).toBe(100);
    // a frame dated before the count began (a browser's frame time can be) shows where it starts
    expect(countAt(3.4, 5.4, -4)).toBe(3.4);
    let last = 0;
    for (let ms = 0; ms <= COUNT_MS; ms += 10) {
      const v = countAt(0, 100, ms);
      expect(v).toBeGreaterThanOrEqual(last);
      expect(v).toBeLessThanOrEqual(100);
      last = v;
    }
    // down as well as up
    expect(countAt(100, 40, COUNT_MS / 2)).toBeCloseTo(47.5, 6);
    expect(countAt(100, 40, COUNT_MS)).toBe(40);
  });

  it("formats every frame as the figure is formatted", () => {
    const c = count(900, 2_600, { format: formatUsdCompact });
    for (let i = 0; i < 40; i++) c.frame(16);
    expect(c.painted[0]).toBe("$900");
    expect(c.painted.at(-1)).toBe("$2.6K");
    for (const text of c.painted) expect(text).toMatch(/^\$(\d{3}|\d(\.\d)?K)$/);
    // on its way through the thousand it changes its form as the figure itself would
    expect(c.painted.some((t) => t.endsWith("K") && t !== "$2.6K")).toBe(true);
  });

  it("doesn't animate the first value painted", () => {
    const c = count(undefined, 5.4);
    expect(c.cancel).toBeNull();
    expect(c.painted).toEqual([]);
    expect(c.asked()).toBe(0);
  });

  it("doesn't animate a value that is unchanged, or reads the same on screen", () => {
    expect(count(5.4, 5.4).cancel).toBeNull();
    // 5.41 and 5.44 are both "5.4%": nothing on screen would move
    const same = count(5.41, 5.44);
    expect(same.cancel).toBeNull();
    expect(same.painted).toEqual([]);
    expect(same.asked()).toBe(0);
  });

  it("doesn't animate at all when the visitor asked for reduced motion", () => {
    const c = count(3.4, 5.4, { reducedMotion: true });
    expect(c.cancel).toBeNull();
    expect(c.painted).toEqual([]);
    expect(c.asked()).toBe(0);
  });

  it("stops where it is when it is cancelled (a newer value came, or the figure left the page)", () => {
    const c = count(3.4, 5.4);
    c.frame(100);
    const before = c.painted.length;
    c.cancel?.();
    expect(c.cancelled()).toBe(1);
    c.frame(100);
    expect(c.painted).toHaveLength(before);
  });
});
