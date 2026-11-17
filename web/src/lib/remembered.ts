import { APY_MAX_PERCENT } from "./cascade/apy";
import type { StringStorage } from "./cascade/oplog";
import { APY_KEEP_MS, STATS_KEEP_MS } from "./stats";

// The public display figures a browser remembers between visits, so a page shows the last real reading at once while
// this visit's own is read: the yield, the total staked, and the TAO price where it is shown as information. Each is a
// value the chain gave this browser on an earlier visit, never one made up; it is replaced as soon as this visit's own
// reading arrives, and dropped once it is older than the figure is kept on screen for (stats.ts). Nothing else is ever
// kept here: not a balance, a limit, a quote, nor anything a transaction or a button's state is decided from. Those are
// read from the chain on every visit.

/** The figures remembered, and no others. */
export const FIGURE_KEYS = ["apy", "staked", "price"] as const;
export type FigureKey = (typeof FIGURE_KEYS)[number];

/** A figure as the chain gave it, and when it was read (ms since the epoch, by this device's clock). */
export interface Reading {
  value: number;
  at: number;
}

export interface FigureStore {
  /** The figure as last read, on an earlier visit or this one, while it may still be shown: undefined once it is older
   * than its window, and for anything stored that isn't a reading to stand behind. The same object each time it is
   * asked, until a newer reading replaces it. */
  recall(key: FigureKey): Reading | undefined;
  /** Keeps this visit's own reading for the next. Never throws: a browser that won't store it still shows it. */
  remember(key: FigureKey, value: number): void;
}

/** The record's layout: a change of it leaves the older records unread. */
const VERSION = 1;

/** How long each figure may be shown after it was read (the windows a failed live read keeps it for), and what a real
 * one lies between. */
const RULES: Record<FigureKey, { keepMs: number; min: number; max: number }> = {
  // the yield, in percent: anything above the most that is shown is hidden when read, too (apy.ts)
  apy: { keepMs: APY_KEEP_MS, min: 0, max: APY_MAX_PERCENT },
  // TAO staked through Cascade: of the 21 million there will ever be
  staked: { keepMs: STATS_KEEP_MS, min: 0, max: 21_000_000 },
  // dollars for one TAO: more than nothing
  price: { keepMs: STATS_KEEP_MS, min: 0.01, max: 1_000_000 },
};

const isFigure = (key: string): key is FigureKey => (FIGURE_KEYS as readonly string[]).includes(key);
const inRange = (key: FigureKey, value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= RULES[key].min && value <= RULES[key].max;

/** A store over the browser's storage for one deployment (`scope`: its vault's address). Each figure is read from
 * storage once a page load, and judged again each time it is asked for, so a page left open stops showing a reading
 * that has grown old. */
export function createFigureStore(storage: StringStorage, scope: string, now: () => number = Date.now): FigureStore {
  const storageKey = (key: FigureKey) => `cascade.figure.${scope}.${key}`;
  /** What each figure's record held when first asked (null: nothing usable), then this visit's own reading. */
  const held = new Map<FigureKey, Reading | null>();

  function load(key: FigureKey): Reading | null {
    try {
      const raw = storage.getItem(storageKey(key));
      if (raw === null) return null;
      const r: unknown = JSON.parse(raw);
      if (typeof r !== "object" || r === null || Array.isArray(r)) return null;
      const { v, value, at } = r as { v?: unknown; value?: unknown; at?: unknown };
      if (v !== VERSION || !inRange(key, value)) return null;
      // dated by this device's clock when it was read: never before the epoch, never after now
      if (typeof at !== "number" || !Number.isFinite(at) || at <= 0 || at > now()) return null;
      return { value, at };
    } catch {
      // storage blocked, or text that isn't a record: as if nothing was remembered
      return null;
    }
  }

  return {
    recall(key) {
      if (!isFigure(key)) return undefined;
      let r = held.get(key);
      if (r === undefined) {
        r = load(key);
        held.set(key, r);
      }
      if (r === null) return undefined;
      const age = now() - r.at;
      return age >= 0 && age <= RULES[key].keepMs ? r : undefined;
    },
    remember(key, value) {
      if (!isFigure(key) || !inRange(key, value)) return;
      const r: Reading = { value, at: now() };
      held.set(key, r);
      try {
        storage.setItem(storageKey(key), JSON.stringify({ v: VERSION, value: r.value, at: r.at }));
      } catch {
        // storage blocked or full: this page load keeps its own reading in memory, the next visit starts without one
      }
    },
  };
}

/** The store where the site has no deployment: nothing to remember. */
export const NO_FIGURES: FigureStore = { recall: () => undefined, remember: () => undefined };
