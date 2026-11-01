"use client";

import { useState } from "react";
import { useNow } from "@/lib/client-state";
import { useFlow } from "@/lib/cascade/hooks";
import { flowView, type PageView, type StepId, type StepView } from "@/lib/security-view";
import landing from "../landing/Landing.module.css";
import { SiteFooter } from "../landing/SiteFooter";
import { SiteNav } from "../landing/SiteNav";
import styles from "./Security.module.css";

type Dir = "in" | "out";

/** The step the detail panel shows: the given one when it belongs to this direction, else the first. */
export function selectStep(view: PageView, dir: Dir, id: StepId | null): StepView {
  const steps = dir === "in" ? view.stepsIn : view.stepsOut;
  return steps.find((s) => s.id === id) ?? steps[0]!;
}

const TONE_CLASS = { ok: styles.toneOk, amber: styles.toneAmber, stale: styles.toneStale } as const;
const STATUS_CLASS = { passing: styles.passing, notOptimal: styles.notOptimal, cantCheck: styles.quiet, waiting: styles.quiet } as const;

function Details({ step, className }: { step: StepView; className: string }) {
  return (
    <div className={className} aria-live="polite">
      <div className={styles.detailTop}>
        <h2 className={styles.detailName}>
          {step.name} <span className={styles.chain}>{step.chain}</span>
        </h2>
        {step.link && (
          <a className={styles.src} href={step.link.href} target="_blank" rel="noopener noreferrer">
            {step.link.label} ↗
          </a>
        )}
      </div>
      <p className={styles.say}>{step.say}</p>
      {step.figures.length > 0 && (
        <dl className={styles.figs}>
          {step.figures.map((f) => (
            <div key={f.label}>
              <dt className={styles.k}>{f.label}</dt>
              <dd className={styles.v}>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** `/security`: where the money goes, step by step, with live numbers from the monitor. */
export function SecurityPage() {
  const flow = useFlow();
  const now = useNow(30_000);
  const [dir, setDir] = useState<Dir>("in");
  const [picked, setPicked] = useState<StepId | null>(null);

  const checking = flow.isPending && flow.fetchStatus === "fetching";
  const view = flowView(flow.data ?? null, now);
  const status = checking ? { kind: "waiting" as const, text: "Checking the chain…", detail: null } : view.status;
  const steps = dir === "in" ? view.stepsIn : view.stepsOut;
  const selected = selectStep(view, dir, picked);

  return (
    <div className={landing.page}>
      <SiteNav />
      <main className={`wrap ${styles.pageEnd}`}>
        <header className={styles.head}>
          <h1 className={styles.h1}>Where your money goes</h1>
          <p className={styles.lede}>Every number is read straight from the chain, checked every minute, and links to where you can check it yourself.</p>
        </header>

        <div className={styles.bar}>
          <p className={`${styles.status} ${STATUS_CLASS[status.kind]}`}>
            <span className={styles.dot} aria-hidden="true" />
            {status.text}
          </p>
          <div className={styles.seg} role="tablist" aria-label="Direction">
            {(["in", "out"] as const).map((d) => (
              <button
                key={d}
                type="button"
                role="tab"
                id={`security-tab-${d}`}
                aria-selected={dir === d}
                aria-controls="security-map"
                className={dir === d ? styles.on : undefined}
                onClick={() => {
                  setDir(d);
                  setPicked(null);
                }}
              >
                {d === "in" ? "Money in" : "Money out"}
              </button>
            ))}
          </div>
        </div>
        {status.detail && <p className={styles.statusDetail}>{status.detail}</p>}

        {view.notices.length > 0 && !checking && (
          <ul className={styles.notices}>
            {view.notices.map((n, i) => (
              <li key={i} className={styles.notice}>
                <span className={styles.noticeDot} aria-hidden="true" />
                <div>
                  <b>{n.title}</b>
                  {n.body}{" "}
                  {n.href && (
                    <a href={n.href} target="_blank" rel="noopener noreferrer">
                      See it on the chain ↗
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        <ol id="security-map" className={styles.map} role="tabpanel" aria-labelledby={`security-tab-${dir}`}>
          {steps.map((s, i) => {
            const open = s.id === selected.id;
            return (
              <li key={s.id} className={styles.cell}>
                {i > 0 && (
                  <span className={styles.arrow} aria-hidden="true">
                    →
                  </span>
                )}
                <div className={styles.nodeWrap}>
                  <button type="button" className={`${styles.node} ${open ? styles.sel : ""}`} aria-pressed={open} onClick={() => setPicked(s.id)}>
                    <span className={styles.where}>{s.chain}</span>
                    <span className={styles.name}>
                      <span className={`${styles.dot} ${TONE_CLASS[s.tone]}`} aria-hidden="true" />
                      {s.name}
                    </span>
                    <span className={styles.headline}>{s.headline}</span>
                  </button>
                  {open && <Details step={s} className={styles.inline} />}
                </div>
              </li>
            );
          })}
        </ol>

        <Details step={selected} className={styles.detail} />
      </main>
      <SiteFooter />
    </div>
  );
}
