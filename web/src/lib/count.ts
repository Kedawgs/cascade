// A figure counting from the value it showed to a new one (components/Figure.tsx): the arithmetic and the frames, apart
// from the browser, so both can be run by hand.

/** How long a figure takes to reach its new value. */
export const COUNT_MS = 600;

/** The number on screen `elapsedMs` into a count from `from` to `to`: quick at first and settling (ease-out), and
 * exactly `to` from `durationMs` on, with no arithmetic between it and the real value. */
export function countAt(from: number, to: number, elapsedMs: number, durationMs: number = COUNT_MS): number {
  if (elapsedMs >= durationMs) return to;
  if (elapsedMs <= 0) return from;
  const left = 1 - elapsedMs / durationMs;
  return from + (to - from) * (1 - left ** 3);
}

/** The browser's clock and frames (performance.now, requestAnimationFrame), or a test's. */
export interface CountClock {
  now(): number;
  request(step: (t: number) => void): number;
  cancel(id: number): void;
}

/** Counts the figure on screen from `from` (what it shows now; undefined before the first value) to `to`, painting each
 * frame formatted as the figure is. Returns how to stop it, or null when nothing is animated: the first value painted,
 * a value that reads the same on screen, or a visitor who asked for reduced motion; the caller then shows `to` as it is.
 * A count paints its first frame (the old value) at once, so the new one is never seen before the count to it, and its
 * last frame is `format(to)` itself. */
export function startCount(o: {
  from: number | undefined;
  to: number;
  format: (n: number) => string;
  paint: (text: string, value: number) => void;
  reducedMotion: boolean;
  clock: CountClock;
  durationMs?: number;
}): (() => void) | null {
  const { from, to, format, paint, clock, durationMs = COUNT_MS } = o;
  if (from === undefined || o.reducedMotion || format(from) === format(to)) return null;
  const started = clock.now();
  paint(format(from), from);
  let id = clock.request(function step() {
    const elapsed = clock.now() - started;
    const value = countAt(from, to, elapsed, durationMs);
    paint(format(value), value);
    if (elapsed < durationMs) id = clock.request(step);
  });
  return () => clock.cancel(id);
}
