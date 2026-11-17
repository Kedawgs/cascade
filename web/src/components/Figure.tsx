"use client";

import { useLayoutEffect, useRef } from "react";
import { type CountClock, startCount } from "@/lib/count";
import styles from "./Figure.module.css";

const browserClock: CountClock = {
  now: () => performance.now(),
  request: (step) => window.requestAnimationFrame(step),
  cancel: (id) => window.cancelAnimationFrame(id),
};

const reducedMotion = (): boolean => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** A figure's words for screen readers alone: off screen (globals.css sr-only), and left out of a copy of the page's
 * text, so a figure copied from the page is the figure once. */
const SPOKEN = `sr-only ${styles.spoken}`;

/** A figure's place while it is being read and there is none to show yet: a soft bar the size of the figure (a slow
 * shimmer on it; still for a visitor who asked for reduced motion: Figure.module.css), read out once as "Loading",
 * never as a number. */
export function FigureSkeleton() {
  return (
    <>
      <span className={styles.skeleton} data-figure="loading" aria-hidden="true" />
      <span className={SPOKEN}>Loading</span>
    </>
  );
}

/** A figure's place when its read finished and there is no value (the read failed, or the chain can't give one): "–",
 * read out as what it means. */
export function FigureNone() {
  return (
    <>
      <span data-figure="none" aria-hidden="true">
        –
      </span>
      <span className={SPOKEN}>Not available</span>
    </>
  );
}

/** A figure's place with no value in it: the skeleton while a read may still bring one, the dash once it can't. */
export function FigurePlace({ loading }: { loading: boolean }) {
  return loading ? <FigureSkeleton /> : <FigureNone />;
}

/** A figure read from the chain, in one of three states, never two at once:
 * - a value to show (`value`: this visit's reading, one this browser remembers, or the first HTML's): its text
 *   (`format`, a function that stays the same between renders). When a newer reading replaces the one on screen with a
 *   different one it counts to it (count.ts: about 600 ms, each frame formatted as the figure is, ending on the real
 *   value itself); the first value painted, a value that reads the same, and a visitor who asked for reduced motion get
 *   no animation. The count is for the eye only: the node it runs in is hidden from screen readers, which read the real
 *   value from the twin beside it, never a frame on the way;
 * - no value yet, and its read still running (`loading`): the skeleton;
 * - no value, and no read that may bring one: the dash.
 * Nothing here makes a number up: with no value, no number is on screen. */
export function Figure({ value, format, loading }: { value: number | undefined; format: (n: number) => string; loading: boolean }) {
  return value === undefined ? <FigurePlace loading={loading} /> : <FigureValue value={value} format={format} />;
}

function FigureValue({ value, format }: { value: number; format: (n: number) => string }) {
  const text = format(value);
  const node = useRef<HTMLSpanElement>(null);
  /** The number on screen now, a count's last frame included; none before the first value is painted. */
  const shown = useRef<number | undefined>(undefined);

  // before the browser paints the new value: a count starts from the old one in the same frame
  useLayoutEffect(() => {
    const el = node.current;
    const from = shown.current;
    shown.current = value;
    if (!el) return;
    const stop = startCount({
      from,
      to: value,
      format,
      reducedMotion: reducedMotion(),
      clock: browserClock,
      paint: (frame, n) => {
        el.textContent = frame;
        shown.current = n;
      },
    });
    // no count: the real value, also where a count cut short left a frame of its own
    if (!stop && el.textContent !== text) el.textContent = text;
    return () => stop?.();
  }, [value, format, text]);

  return (
    <>
      <span ref={node} data-figure="value" aria-hidden="true">
        {text}
      </span>
      <span className={SPOKEN}>{text}</span>
    </>
  );
}
