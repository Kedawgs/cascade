import { describe, expect, it } from "vitest";
import { pauseWhenHidden } from "./pause-when-hidden";

function setup({ observer = true } = {}) {
  const calls: string[] = [];
  const svg = { pauseAnimations: () => calls.push("pause"), unpauseAnimations: () => calls.push("unpause") };
  const listeners = new Set<() => void>();
  const doc = {
    hidden: false,
    addEventListener: (type: string, f: () => void) => type === "visibilitychange" && listeners.add(f),
    removeEventListener: (type: string, f: () => void) => type === "visibilitychange" && listeners.delete(f),
  };
  let report: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
  let observed: unknown = null;
  let disconnected = false;
  class FakeObserver {
    constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
      report = cb;
    }
    observe(el: unknown) {
      observed = el;
    }
    disconnect() {
      disconnected = true;
    }
  }
  const stop = pauseWhenHidden(svg, { document: doc, IntersectionObserver: observer ? FakeObserver : undefined });
  return {
    calls,
    svg,
    stop,
    onScreen: (v: boolean) => report?.([{ isIntersecting: v }]),
    tab: (hidden: boolean) => {
      doc.hidden = hidden;
      for (const f of listeners) f();
    },
    listeners,
    observed: () => observed,
    disconnected: () => disconnected,
  };
}

describe("pauseWhenHidden", () => {
  it("leaves a visible mark running", () => {
    const s = setup();
    s.onScreen(true);
    expect(s.observed()).toBe(s.svg);
    expect(s.calls).toEqual([]);
  });

  it("pauses while the mark is scrolled off screen and resumes when it is back", () => {
    const s = setup();
    s.onScreen(false);
    expect(s.calls).toEqual(["pause"]);
    s.onScreen(false);
    expect(s.calls).toEqual(["pause"]);
    s.onScreen(true);
    expect(s.calls).toEqual(["pause", "unpause"]);
  });

  it("pauses while the tab is hidden and resumes when it is shown", () => {
    const s = setup();
    s.tab(true);
    expect(s.calls).toEqual(["pause"]);
    s.tab(false);
    expect(s.calls).toEqual(["pause", "unpause"]);
  });

  it("stays paused until the mark is both on screen and in a visible tab", () => {
    const s = setup();
    s.onScreen(false);
    s.tab(true);
    s.tab(false);
    expect(s.calls).toEqual(["pause"]);
    s.onScreen(true);
    expect(s.calls).toEqual(["pause", "unpause"]);
  });

  it("starts paused in a tab that opens hidden", () => {
    const calls: string[] = [];
    const svg = { pauseAnimations: () => calls.push("pause"), unpauseAnimations: () => calls.push("unpause") };
    const doc = { hidden: true, addEventListener: () => {}, removeEventListener: () => {} };
    pauseWhenHidden(svg, { document: doc });
    expect(calls).toEqual(["pause"]);
  });

  it("still follows the tab where IntersectionObserver is missing", () => {
    const s = setup({ observer: false });
    s.tab(true);
    s.tab(false);
    expect(s.calls).toEqual(["pause", "unpause"]);
  });

  it("stops watching on cleanup and leaves the animation running, so a remount starts clean", () => {
    const s = setup();
    s.onScreen(false);
    s.stop();
    expect(s.disconnected()).toBe(true);
    expect(s.listeners.size).toBe(0);
    expect(s.calls).toEqual(["pause", "unpause"]);
    s.stop();
    expect(s.calls).toEqual(["pause", "unpause"]);
  });
});
