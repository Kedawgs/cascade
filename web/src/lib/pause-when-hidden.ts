/** What an SVG root offers for its SMIL animations. */
export interface Pausable {
  pauseAnimations(): void;
  unpauseAnimations(): void;
}

interface Watchers {
  document: {
    readonly hidden: boolean;
    addEventListener(type: "visibilitychange", listener: () => void): void;
    removeEventListener(type: "visibilitychange", listener: () => void): void;
  };
  /** Absent in old browsers: the animation then pauses only while the tab is hidden. */
  IntersectionObserver?: new (callback: (entries: { isIntersecting: boolean }[]) => void) => {
    observe(target: never): void;
    disconnect(): void;
  };
}

/**
 * Runs an SVG's animations only while it is on screen and its tab is visible: a looping SMIL animation
 * otherwise costs a layout every frame, even where nobody can see it. Returns a cleanup that stops
 * watching and leaves the animations running, so a remount starts from a clean state.
 */
export function pauseWhenHidden(svg: Pausable, w: Watchers): () => void {
  let onScreen = true;
  let paused = false;
  let stopped = false;
  const apply = () => {
    if (stopped) return;
    const run = onScreen && !w.document.hidden;
    if (run === !paused) return;
    paused = !run;
    if (paused) svg.pauseAnimations();
    else svg.unpauseAnimations();
  };
  const observer = w.IntersectionObserver
    ? new w.IntersectionObserver((entries) => {
        const last = entries[entries.length - 1];
        if (last) onScreen = last.isIntersecting;
        apply();
      })
    : null;
  observer?.observe(svg as never);
  w.document.addEventListener("visibilitychange", apply);
  apply();
  return () => {
    if (stopped) return;
    stopped = true;
    observer?.disconnect();
    w.document.removeEventListener("visibilitychange", apply);
    if (paused) svg.unpauseAnimations();
    paused = false;
  };
}
