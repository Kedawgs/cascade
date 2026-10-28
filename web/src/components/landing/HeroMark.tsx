"use client";

import { useId } from "react";
import styles from "./HeroMark.module.css";

/** The logo's three stepped bars at 17× (see Logo.tsx: 10 × 3.2, stepped 4 across and 6.4 down). */
const BARS = [
  { x: 0, y: 0, tone: "ink", from: "#3B5869", to: "#10212B" },
  { x: 68, y: 108.8, tone: "water", from: "#79CAD8", to: "#206F80" },
  { x: 136, y: 217.6, tone: "proof", from: "#7DD9A9", to: "#1E8A5A" },
] as const;
const W = 170;
const H = 54.4;

/** The hero's picture: the cascade mark, drawn large, with light running down its steps. */
export function HeroMark() {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  return (
    <svg className={styles.mark} viewBox="0 0 306 272" fill="none" aria-hidden="true" focusable="false">
      <defs>
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
        <linearGradient id={`${id}-shine`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        {BARS.map((b) => (
          <clipPath key={b.tone} id={`${id}-clip-${b.tone}`}>
            <rect x={b.x} y={b.y} width={W} height={H} rx={H / 2} />
          </clipPath>
        ))}
      </defs>
      {BARS.map((b, i) => (
        <g key={b.tone}>
          <rect x={b.x} y={b.y} width={W} height={H} rx={H / 2} fill={`url(#${id}-${b.tone})`} />
          <rect x={b.x} y={b.y} width={W} height={H} rx={H / 2} fill={`url(#${id}-gloss)`} />
          <g clipPath={`url(#${id}-clip-${b.tone})`}>
            <rect
              className={styles.shine}
              style={{ animationDelay: `${i * 0.35}s` }}
              x={b.x - 90}
              y={b.y}
              width="70"
              height={H}
              fill={`url(#${id}-shine)`}
            />
          </g>
        </g>
      ))}
    </svg>
  );
}
