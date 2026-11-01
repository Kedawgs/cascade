"use client";

import { useEffect, useRef, useState } from "react";
import { useNow } from "@/lib/client-state";
import { useFlow } from "@/lib/cascade/hooks";
import { DEPLOYMENT } from "@/lib/cascade/config";
import { contractsOf } from "@/lib/security-content";
import { flowView, heroNumbers, type HeroStat, type PageView, type StepId, type StepView } from "@/lib/security-view";
import { SITE_LINKS } from "@/lib/site";
import landing from "../landing/Landing.module.css";
import { SiteFooter } from "../landing/SiteFooter";
import { SiteNav } from "../landing/SiteNav";
import styles from "./Security.module.css";
import { ContractsSection, ProtectedSection, ReportSection, RisksSection } from "./SecuritySections";

type Dir = "in" | "out";

/** The step the detail panel shows: the given one when it belongs to this direction, else the first. */
export function selectStep(view: PageView, dir: Dir, id: StepId | null): StepView {
  const steps = dir === "in" ? view.stepsIn : view.stepsOut;
  return steps.find((s) => s.id === id) ?? steps[0]!;
}

/** The tab an arrow key (or Home/End) on the tab `from` moves to; null for any other key. With two tabs,
 * either arrow goes to the other one. */
export function tabAfterKey(from: Dir, key: string): Dir | null {
  if (key === "ArrowRight" || key === "ArrowLeft") return from === "in" ? "out" : "in";
  if (key === "Home") return "in";
  if (key === "End") return "out";
  return null;
}

const TONE_CLASS = { ok: styles.toneOk, amber: styles.toneAmber, stale: styles.toneStale } as const;
const FIGURE_TONE = { ok: styles.figOk, amber: styles.figAmber, stale: styles.figStale } as const;

/** The top of /security: what the page is, the two figures it leads with, and a row of the live ones. */
function Hero({ view }: { view: PageView }) {
  const { lead, row } = heroNumbers(view);
  const contracts = contractsOf(DEPLOYMENT).length;
  const facts: HeroStat[] = [
    ...row,
    { value: "7 days", label: "Public notice before any contract change" },
    ...(contracts > 0 ? [{ value: String(contracts), label: "Contracts, all open source" }] : []),
  ];
  return (
    <header className={`${landing.hero} ${styles.heroBand}`}>
      <div className={`wrap ${styles.heroGrid}`}>
        <h1 className={`${landing.h1} ${styles.heroTitle}`}>
          Live on-chain
          <strong>Security</strong>
        </h1>
        <div>
          <p className={styles.heroLede}>Every number on this page is read from the chain every minute, with a link to check it yourself.</p>
          <dl className={styles.leadStats}>
            {lead.map((s) => (
              <div key={s.label} className={styles.leadStat}>
                <dt className={styles.leadK}>{s.label}</dt>
                <dd className={`${styles.leadV} ${s.tone ? FIGURE_TONE[s.tone] : ""}`}>{s.value}</dd>
              </div>
            ))}
          </dl>
          <div className={styles.heroActions}>
            <a className="pill" href="#flow">
              See where your money goes ↓
            </a>
            <a className="pill pill-ghost" href={SITE_LINKS.security} target="_blank" rel="noopener noreferrer">
              Report a vulnerability
            </a>
          </div>
        </div>
        <dl className={styles.statRow}>
          {facts.map((s) => (
            <div key={s.label} className={styles.rowStat}>
              <dt className={styles.rowK}>{s.label}</dt>
              <dd className={styles.rowV}>{s.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </header>
  );
}
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
  // the step a "Watch the …" link last jumped to: it is brought into view, focused and briefly highlighted
  const [jumped, setJumped] = useState<StepId | null>(null);
  const tabs = useRef<Record<Dir, HTMLButtonElement | null>>({ in: null, out: null });
  const mapRef = useRef<HTMLOListElement | null>(null);
  const chooseDir = (d: Dir) => {
    setDir(d);
    setPicked(null);
  };
  const watch = (d: Dir, id: StepId) => {
    setDir(d);
    setPicked(id);
    setJumped(id);
  };
  useEffect(() => {
    if (!jumped) return;
    const node = mapRef.current?.querySelector<HTMLButtonElement>(`[data-step="${jumped}"]`);
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    node?.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
    node?.focus({ preventScroll: true });
    const t = setTimeout(() => setJumped(null), 1600);
    return () => clearTimeout(t);
  }, [jumped]);

  const checking = flow.isPending && flow.fetchStatus === "fetching";
  const view = flowView(flow.data ?? null, now);
  const status = checking ? { kind: "waiting" as const, text: "Checking the chain…", detail: null } : view.status;
  const steps = dir === "in" ? view.stepsIn : view.stepsOut;
  const selected = selectStep(view, dir, picked);

  return (
    <div className={landing.page}>
      <SiteNav />
      <Hero view={view} />
      <main className={`wrap ${styles.pageEnd}`}>
        <header id="flow" className={styles.flowHead}>
          <h2 className={styles.h2}>Where your money goes</h2>
          <p className={styles.sectionLede}>Follow a deposit from your wallet to the validator, and back. Pick any step to see its live numbers.</p>
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
                tabIndex={dir === d ? 0 : -1}
                ref={(el) => {
                  tabs.current[d] = el;
                }}
                className={dir === d ? styles.on : undefined}
                onClick={() => chooseDir(d)}
                onKeyDown={(e) => {
                  const to = tabAfterKey(d, e.key);
                  if (!to) return;
                  e.preventDefault();
                  chooseDir(to);
                  tabs.current[to]?.focus();
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

        <ol id="security-map" ref={mapRef} className={styles.map} role="tabpanel" aria-labelledby={`security-tab-${dir}`}>
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
                  <button
                    type="button"
                    data-step={s.id}
                    className={`${styles.node} ${open ? styles.sel : ""} ${jumped === s.id ? styles.jumped : ""}`}
                    aria-pressed={open}
                    onClick={() => setPicked(s.id)}
                  >
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

        <ProtectedSection />
        <ContractsSection />
        <RisksSection onWatch={watch} />
        <ReportSection />
      </main>
      <SiteFooter />
    </div>
  );
}
