"use client";

import { useEffect, useId, useRef } from "react";
import { pauseWhenHidden } from "@/lib/pause-when-hidden";
import styles from "./HeroMark.module.css";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Bar thickness and length: the logo's 10 × 3.2 bars at 17× (see Logo.tsx). */
const H = 54.4;
const W = 170;

/**
 * Each bar's place in the mark and in the τ it starts as: the top bar is τ's crossbar,
 * the middle bar its stem, the bottom bar the foot that curls right.
 */
const BARS = [
  { tone: "ink", from: "#3B5869", to: "#10212B", mark: { x: 0, y: 0, w: W, h: H }, tau: { x: 18, y: 30, w: 270, h: H } },
  { tone: "water", from: "#79CAD8", to: "#206F80", mark: { x: 68, y: 108.8, w: W, h: H }, tau: { x: 125.8, y: 30, w: H, h: 200 } },
  { tone: "proof", from: "#7DD9A9", to: "#1E8A5A", mark: { x: 136, y: 217.6, w: W, h: H }, tau: { x: 125.8, y: 175.6, w: 120, h: H } },
] as const;

/** One word on each step of the mark, read top to bottom. */
const WORDS = ["Crypto", "Made", "Simple"] as const;

/** One loop: τ rests, becomes the mark, the mark rests, folds back into τ. */
const LOOP_S = 12;
const KEY_TIMES = "0;0.1167;0.2083;0.85;0.9333;1";
const HOLD = "0 0 1 1";
const EASE = "0.65 0 0.35 1";
const KEY_SPLINES = [HOLD, EASE, HOLD, EASE, HOLD].join(";");
const loop = (tau: string | number, mark: string | number) => [tau, tau, mark, mark, tau, tau].join(";");
/** The words show only while the mark rests: in just after it forms, out just before it folds back. */
const WORDS_KEY_TIMES = "0;0.2083;0.25;0.81;0.85;1";
/** The light runs down each step once the mark has formed, 0.35 s apart. */
const SHINE_AT_S = 3;
const SHINE_FOR_S = 0.9;

const ATTRS = [
  ["x", "x"],
  ["y", "y"],
  ["width", "w"],
  ["height", "h"],
] as const;

function Gradients({ id }: { id: string }) {
  return (
    <>
      {BARS.map((b) => (
        <linearGradient key={b.tone} id={`${id}-${b.tone}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={b.from} />
          <stop offset="1" stopColor={b.to} />
        </linearGradient>
      ))}
      <linearGradient id={`${id}-gloss`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#fff" stopOpacity="0.4" />
        <stop offset="0.55" stopColor="#fff" stopOpacity="0" />
      </linearGradient>
    </>
  );
}

/** Each step's word, centred on the step where the mark rests. */
function Words({ moving }: { moving: boolean }) {
  return (
    <g className={styles.words} opacity={moving ? 0 : 1}>
      {moving && (
        <animate
          attributeName="opacity"
          values="0;0;1;1;0;0"
          keyTimes={WORDS_KEY_TIMES}
          keySplines={[HOLD, EASE, HOLD, EASE, HOLD].join(";")}
          calcMode="spline"
          dur={`${LOOP_S}s`}
          repeatCount="indefinite"
        />
      )}
      {BARS.map(({ tone, mark: m }, i) => (
        <text key={tone} x={m.x + m.w / 2} y={m.y + m.h / 2} textAnchor="middle" dominantBaseline="central">
          {WORDS[i]}
        </text>
      ))}
    </g>
  );
}

/** The finished mark, still: for reduced motion. */
function StillMark({ id }: { id: string }) {
  return (
    <svg className={`${styles.mark} ${styles.still}`} viewBox="0 0 306 272" fill="none" aria-hidden="true" focusable="false">
      <defs>
        <Gradients id={id} />
      </defs>
      {BARS.map(({ tone, mark: m }) => (
        <g key={tone}>
          <rect x={m.x} y={m.y} width={m.w} height={m.h} rx={H / 2} fill={`url(#${id}-${tone})`} />
          <rect x={m.x} y={m.y} width={m.w} height={m.h} rx={H / 2} fill={`url(#${id}-gloss)`} />
        </g>
      ))}
      <Words moving={false} />
    </svg>
  );
}

function morph(tau: Box, mark: Box) {
  return ATTRS.map(([attr, k]) => (
    <animate
      key={attr}
      attributeName={attr}
      values={loop(tau[k], mark[k])}
      keyTimes={KEY_TIMES}
      keySplines={KEY_SPLINES}
      calcMode="spline"
      dur={`${LOOP_S}s`}
      repeatCount="indefinite"
    />
  ));
}

/** τ becoming the cascade mark, on a loop. It pauses while off screen or in a hidden tab. */
function MorphingMark({ id }: { id: string }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    return pauseWhenHidden(svg, { document, IntersectionObserver: window.IntersectionObserver });
  }, []);
  return (
    <svg ref={ref} className={`${styles.mark} ${styles.moving}`} viewBox="0 0 306 272" fill="none" aria-hidden="true" focusable="false">
      <defs>
        <Gradients id={id} />
        {BARS.map(({ tone, tau, mark }, i) => {
          const start = (SHINE_AT_S + i * 0.35) / LOOP_S;
          const end = start + SHINE_FOR_S / LOOP_S;
          return (
            <g key={tone}>
              {/* the bar's shape, drawn below by each layer */}
              <rect id={`${id}-bar-${tone}`} x={mark.x} y={mark.y} width={mark.w} height={mark.h} rx={H / 2}>
                {morph(tau, mark)}
              </rect>
              <linearGradient id={`${id}-shine-${tone}`} x1="0" y1="0" x2="1" y2="0" gradientTransform="translate(-1 0)">
                <stop offset="0.3" stopColor="#fff" stopOpacity="0" />
                <stop offset="0.5" stopColor="#fff" stopOpacity="0.55" />
                <stop offset="0.7" stopColor="#fff" stopOpacity="0" />
                <animateTransform
                  attributeName="gradientTransform"
                  type="translate"
                  values="-1 0;-1 0;1 0;1 0"
                  keyTimes={`0;${start.toFixed(4)};${end.toFixed(4)};1`}
                  keySplines={[HOLD, "0.45 0 0.25 1", HOLD].join(";")}
                  calcMode="spline"
                  dur={`${LOOP_S}s`}
                  repeatCount="indefinite"
                />
              </linearGradient>
            </g>
          );
        })}
      </defs>
      {BARS.map(({ tone }) => (
        <g key={tone}>
          <use href={`#${id}-bar-${tone}`} fill={`url(#${id}-${tone})`} />
          <use href={`#${id}-bar-${tone}`} fill={`url(#${id}-gloss)`} />
        </g>
      ))}
      {/* τ is one plain shape over all three colours, which come through as the mark forms */}
      <g fill="#10212B" opacity="0">
        <animate
          attributeName="opacity"
          values={loop(1, 0)}
          keyTimes={KEY_TIMES}
          keySplines={KEY_SPLINES}
          calcMode="spline"
          dur={`${LOOP_S}s`}
          repeatCount="indefinite"
        />
        {BARS.map(({ tone }) => (
          <use key={tone} href={`#${id}-bar-${tone}`} />
        ))}
      </g>
      {BARS.map(({ tone }) => (
        <use key={tone} href={`#${id}-bar-${tone}`} fill={`url(#${id}-shine-${tone})`} />
      ))}
      <Words moving />
    </svg>
  );
}

/** The hero's picture: TAO's τ turning into the cascade mark. */
export function HeroMark() {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <>
      <MorphingMark id={`${id}m`} />
      <StillMark id={`${id}s`} />
    </>
  );
}
