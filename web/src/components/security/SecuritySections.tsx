"use client";

import { useEffect, useState } from "react";
import { DEPLOYMENT, type Deployment } from "@/lib/cascade/config";
import { shortAddress } from "@/lib/format";
import { contractsOf, type ContractRow, risksFor } from "@/lib/security-content";
import type { StepId } from "@/lib/security-view";
import { SITE_LINKS } from "@/lib/site";
import { Mark } from "../Logo";
import { PROTECTION_LEDE, ProtectionGrid } from "../landing/ProtectionGrid";
import styles from "./Security.module.css";

export function ProtectedSection() {
  return (
    <section className={styles.section} aria-labelledby="protected-heading">
      <h2 id="protected-heading" className={styles.h2}>
        How your money is protected
      </h2>
      <p className={styles.sectionLede}>{PROTECTION_LEDE}</p>
      <ProtectionGrid />
    </section>
  );
}

/** Copies an address, saying so for a moment; a browser that refuses the clipboard says that instead. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 1600);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <button
      type="button"
      className={`${styles.copy} ${state === "copied" ? styles.copied : ""}`}
      aria-label={state === "idle" ? `Copy the ${label} address` : undefined}
      onClick={() => {
        if (!navigator.clipboard) {
          setState("failed");
          return;
        }
        navigator.clipboard.writeText(value).then(
          () => setState("copied"),
          () => setState("failed"),
        );
      }}
    >
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}</span>
    </button>
  );
}

function ContractList({ chain, rows }: { chain: ContractRow["chain"]; rows: ContractRow[] }) {
  return (
    <div className={styles.chainCol}>
      <h3 className={styles.chainHead}>
        <span className={`${styles.chainMark} ${chain === "Base" ? styles.onBase : styles.onBittensor}`} aria-hidden="true" />
        {chain}
      </h3>
      <ul className={styles.contracts}>
        {rows.map((r) => (
          <li key={`${r.chain}:${r.name}`} className={styles.contract}>
            <div className={styles.contractTop}>
              <span className={styles.contractName}>{r.name}</span>
              <span className={styles.addr} title={r.address}>
                {shortAddress(r.address)}
              </span>
            </div>
            <p className={styles.contractDoes}>{r.does}</p>
            <div className={styles.contractActions}>
              <CopyButton value={r.address} label={`${r.chain} ${r.name}`} />
              <a className={styles.src} href={r.href} target="_blank" rel="noopener noreferrer">
                Read it on the explorer ↗
              </a>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** `deployment`: the site's (config), whose addresses are listed; nothing shows without one. */
export function ContractsSection({ deployment = DEPLOYMENT }: { deployment?: Deployment | null }) {
  const rows = contractsOf(deployment);
  if (rows.length === 0) return null;
  return (
    <section className={styles.section} aria-labelledby="contracts-heading">
      <h2 id="contracts-heading" className={styles.h2}>
        The contracts
      </h2>
      <p className={styles.sectionLede}>Every contract your money passes through, and where to read it yourself.</p>
      <div className={styles.chains}>
        <ContractList chain="Base" rows={rows.filter((r) => r.chain === "Base")} />
        <ContractList chain="Bittensor" rows={rows.filter((r) => r.chain === "Bittensor")} />
      </div>
    </section>
  );
}

export function RisksSection({ onWatch }: { onWatch: (dir: "in" | "out", id: StepId) => void }) {
  const risks = risksFor(SITE_LINKS.github);
  return (
    <section className={styles.section} aria-labelledby="risks-heading">
      <h2 id="risks-heading" className={styles.h2}>
        Risks to know
      </h2>
      <p className={styles.sectionLede}>What could go wrong, and where to watch each one live.</p>
      <dl className={styles.risks}>
        {risks.map(({ title, body, watch: w }) => (
          <div key={title} className={styles.risk}>
            <dt className={styles.riskTitle}>{title}</dt>
            <dd className={styles.riskBody}>
              <p>{body}</p>
              {w.kind === "step" ? (
                <button type="button" className={styles.watch} onClick={() => onWatch(w.dir, w.id)}>
                  {w.label} ↑
                </button>
              ) : (
                <a className={styles.watch} href={w.href} target="_blank" rel="noopener noreferrer">
                  {w.label} ↗
                </a>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ReportSection() {
  return (
    <section className={styles.report} aria-labelledby="report-heading">
      <span className={styles.reportMark} aria-hidden="true">
        <Mark size={36} />
      </span>
      <div className={styles.reportText}>
        <h2 id="report-heading" className={styles.reportHead}>
          Found a problem?
        </h2>
        <p>Report it privately so it can be fixed before anyone can use it. Please don&apos;t post it publicly first.</p>
      </div>
      <a className="pill" href={SITE_LINKS.security} target="_blank" rel="noopener noreferrer">
        Report a vulnerability
      </a>
    </section>
  );
}
