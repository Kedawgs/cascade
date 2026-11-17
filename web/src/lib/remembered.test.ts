import { describe, expect, it } from "vitest";
import { createFigureStore, FIGURE_KEYS, type FigureKey, NO_FIGURES } from "./remembered";
import { APY_KEEP_MS, STATS_KEEP_MS } from "./stats";

const VAULT = "0x1694fcfcdb99cd1d64f54c787c47ada5684e5750";
const NOW = 1_800_000_000_000;
const KEY = (figure: string, scope = VAULT) => `cascade.figure.${scope}.${figure}`;

function memory(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  const read: string[] = [];
  return {
    m,
    read,
    getItem: (k: string) => (read.push(k), m.get(k) ?? null),
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

/** A visit: a store over the browser's storage, at a time. */
const visit = (storage: ReturnType<typeof memory>, at = NOW, scope = VAULT) => createFigureStore(storage, scope, () => at);
/** The stored text of a record. */
const record = (value: unknown, at: unknown = NOW - 60_000, v: unknown = 1) => JSON.stringify({ v, value, at });

describe("the figures a browser remembers between visits", () => {
  it("are the three public display figures, and nothing else: no balance, limit or quote has a place here", () => {
    expect([...FIGURE_KEYS]).toEqual(["apy", "staked", "price"]);
    const storage = memory();
    const store = visit(storage);
    for (const key of ["position", "balances", "limits", "available", "quote"]) {
      store.remember(key as FigureKey, 1);
      expect(store.recall(key as FigureKey)).toBeUndefined();
    }
    expect(storage.m.size).toBe(0);
    expect(storage.read).toEqual([]);
  });

  it("gives back on the next visit what a visit's own reading left, with when it was read", () => {
    const storage = memory();
    const first = visit(storage, NOW);
    first.remember("apy", 3.42);
    first.remember("staked", 0.156);
    first.remember("price", 254.49);
    // one small versioned record a figure, under the deployment's vault
    expect(storage.m.get(KEY("apy"))).toBe('{"v":1,"value":3.42,"at":1800000000000}');
    expect([...storage.m.keys()].sort()).toEqual([KEY("apy"), KEY("price"), KEY("staked")]);
    const next = visit(storage, NOW + 20 * 60_000);
    expect(next.recall("apy")).toEqual({ value: 3.42, at: NOW });
    expect(next.recall("staked")).toEqual({ value: 0.156, at: NOW });
    expect(next.recall("price")).toEqual({ value: 254.49, at: NOW });
  });

  it("keeps zero staked, which is a value", () => {
    const storage = memory();
    visit(storage).remember("staked", 0);
    expect(visit(storage, NOW + 1).recall("staked")).toEqual({ value: 0, at: NOW });
  });

  it("gives the same reading back each time it is asked (a render may ask twice)", () => {
    const storage = memory({ [KEY("apy")]: record(3.4) });
    const store = visit(storage);
    expect(store.recall("apy")).toBe(store.recall("apy"));
    // and reads the browser's storage once a page load
    expect(storage.read).toEqual([KEY("apy")]);
  });

  it("has this visit's own reading from then on, whatever was stored before", () => {
    const storage = memory({ [KEY("price")]: record(250) });
    const store = visit(storage);
    expect(store.recall("price")?.value).toBe(250);
    store.remember("price", 255.5);
    expect(store.recall("price")).toEqual({ value: 255.5, at: NOW });
  });

  it("keeps each deployment's figures apart", () => {
    const storage = memory();
    visit(storage).remember("staked", 12.5);
    expect(visit(storage, NOW + 1, "0x00000000000000000000000000000000000000aa").recall("staked")).toBeUndefined();
  });

  describe("drops what it can't stand behind, and shows nothing in its place", () => {
    const recalled = (key: FigureKey, text: string, at = NOW) => visit(memory({ [KEY(key)]: text }), at).recall(key);

    it("text that isn't a record", () => {
      for (const text of ["", "not json", "null", "3.4", '"3.4"', "[]", "[3.4,1]", "{}", "true"]) expect(recalled("apy", text)).toBeUndefined();
    });

    it("another version's record", () => {
      expect(recalled("apy", record(3.4, NOW - 1, 2))).toBeUndefined();
      expect(recalled("apy", record(3.4, NOW - 1, "1"))).toBeUndefined();
      expect(recalled("apy", JSON.stringify({ value: 3.4, at: NOW - 1 }))).toBeUndefined();
    });

    it("a value that isn't a finite number", () => {
      for (const value of ["3.4", null, true, [3.4], { n: 3.4 }]) expect(recalled("apy", record(value))).toBeUndefined();
      // JSON has no NaN or Infinity, but a number too large to hold reads as Infinity
      expect(recalled("staked", `{"v":1,"value":1e999,"at":${NOW - 1}}`)).toBeUndefined();
      expect(recalled("apy", JSON.stringify({ v: 1, at: NOW - 1 }))).toBeUndefined();
    });

    it("a value outside what the figure can be", () => {
      // the yield: 0 to 20 percent (apy.ts hides anything above)
      expect(recalled("apy", record(-0.1))).toBeUndefined();
      expect(recalled("apy", record(20.01))).toBeUndefined();
      expect(recalled("apy", record(20))?.value).toBe(20);
      expect(recalled("apy", record(0))?.value).toBe(0);
      // TAO staked: none below zero, nor more than there will ever be
      expect(recalled("staked", record(-1))).toBeUndefined();
      expect(recalled("staked", record(21_000_001))).toBeUndefined();
      // a price: above zero
      expect(recalled("price", record(0))).toBeUndefined();
      expect(recalled("price", record(-255))).toBeUndefined();
      expect(recalled("price", record(1_000_001))).toBeUndefined();
    });

    it("a date that isn't one, or is in the future", () => {
      for (const at of ["yesterday", null, -1, 0, 1.5e300]) expect(recalled("apy", record(3.4, at))).toBeUndefined();
      expect(recalled("apy", JSON.stringify({ v: 1, value: 3.4 }))).toBeUndefined();
      expect(recalled("apy", record(3.4, NOW + 1))).toBeUndefined();
      expect(recalled("apy", record(3.4, NOW))?.value).toBe(3.4);
    });

    it("a reading older than the figure is kept on screen for: 14 days for the yield, an hour for the total and the price", () => {
      expect(recalled("apy", record(3.4, NOW - APY_KEEP_MS))?.value).toBe(3.4);
      expect(recalled("apy", record(3.4, NOW - APY_KEEP_MS - 1))).toBeUndefined();
      for (const key of ["staked", "price"] as const) {
        expect(recalled(key, record(12.5, NOW - STATS_KEEP_MS))?.value).toBe(12.5);
        expect(recalled(key, record(12.5, NOW - STATS_KEEP_MS - 1))).toBeUndefined();
      }
    });
  });

  it("stops showing a reading once it is older than its window, on a page left open too", () => {
    let clock = NOW;
    const store = createFigureStore(memory({ [KEY("price")]: record(254.49, NOW - 50 * 60_000) }), VAULT, () => clock);
    expect(store.recall("price")?.value).toBe(254.49);
    clock = NOW + 10 * 60_000;
    expect(store.recall("price")?.value).toBe(254.49);
    clock += 1;
    expect(store.recall("price")).toBeUndefined();
    // this visit's own, too
    store.remember("price", 260);
    expect(store.recall("price")?.value).toBe(260);
    clock += STATS_KEEP_MS + 1;
    expect(store.recall("price")).toBeUndefined();
  });

  it("never remembers a figure that is no reading: not a number, or outside what it can be", () => {
    const storage = memory({ [KEY("apy")]: record(3.4) });
    const store = visit(storage);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 20.5]) store.remember("apy", bad);
    store.remember("price", 0);
    expect(store.recall("apy")?.value).toBe(3.4);
    expect(storage.m.get(KEY("apy"))).toBe(record(3.4));
    expect(storage.m.has(KEY("price"))).toBe(false);
  });

  describe("with the browser's storage blocked or full", () => {
    it("recalls nothing, and doesn't throw, when storage can't be read", () => {
      const blocked = {
        getItem: () => {
          throw new Error("SecurityError");
        },
        setItem: () => {
          throw new Error("SecurityError");
        },
      };
      const store = createFigureStore(blocked, VAULT, () => NOW);
      expect(store.recall("apy")).toBeUndefined();
      expect(() => store.remember("apy", 3.4)).not.toThrow();
      // this page load still has its own reading
      expect(store.recall("apy")).toEqual({ value: 3.4, at: NOW });
    });

    it("carries on when a write is refused (storage full)", () => {
      const full = {
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      };
      const store = createFigureStore(full, VAULT, () => NOW);
      expect(() => store.remember("staked", 12.5)).not.toThrow();
      expect(store.recall("staked")?.value).toBe(12.5);
    });
  });

  it("where there is no deployment, remembers and recalls nothing", () => {
    NO_FIGURES.remember("apy", 3.4);
    expect(NO_FIGURES.recall("apy")).toBeUndefined();
  });
});
