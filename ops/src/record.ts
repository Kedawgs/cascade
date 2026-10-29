import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Address, Hex } from "viem";
import type { ChainName } from "./config.ts";
import type { Plan, PlanV3 } from "./plan.ts";
import type { StepReport } from "./roundtrip.ts";
import type { Sent } from "./send.ts";
import type { StepId } from "./types.ts";

export interface VerifyResult {
  ok: boolean;
  failures: string[];
  checkedAt: string;
}

/** A step found already done on-chain whose transaction was never recorded. A create on Bittensor keeps
 * the block it was created in (found from its code), since the keeper's log scans start there. */
export type DoneStep = Sent | { recovered: true; block?: number };

export interface DeploymentRecord {
  target: "live" | "rehearsal";
  wallet: Address;
  createdAt: string;
  /** A v2 plan (no `version`) or a v3 plan. */
  plan: Plan | PlanV3;
  done: Partial<Record<StepId, DoneStep>>;
  /** A sent transaction with no receipt yet; nothing more is sent until it resolves. */
  pending?: { step: StepId; chain: ChainName; nonce: number; hash?: Hex };
  verify?: VerifyResult;
  rehearsalClose?: { gasUsed: bigint; fee: bigint };
  /** The v3 rehearsal's round trip on the forks, step by step (the budget reads the delivery's gas). */
  roundTrip?: StepReport[];
  /** Bridge messages the keeper sent, so status and track need no Base log scans. */
  messages?: { id: Hex; direction: "Base → Bittensor" | "Bittensor → Base"; hash: Hex; at: string }[];
}

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? { $bigint: v.toString() } : v);
const reviver = (_k: string, v: unknown) =>
  v && typeof v === "object" && "$bigint" in v ? BigInt((v as { $bigint: string }).$bigint) : v;

export function loadRecord(path: string): DeploymentRecord | null {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8"), reviver) : null;
}

/** The record at `path` for a --live run (`live`) or a rehearsal run on the local forks, or null when
 * there is none yet. A record of the other kind is refused, so a --live action never works from a
 * rehearsal record, nor a rehearsal action from a live one. */
export function loadRecordFor(path: string, live: boolean): DeploymentRecord | null {
  const rec = loadRecord(path);
  const want = live ? "live" : "rehearsal";
  if (rec && rec.target !== want) {
    throw new Error(`${path} is a ${rec.target} record, but this is a ${live ? "--live" : "rehearsal (local forks)"} run; nothing done`);
  }
  return rec;
}

/** As loadRecordFor, for actions that need the deployment to exist. */
export function needRecord(path: string, live: boolean): DeploymentRecord {
  const rec = loadRecordFor(path, live);
  if (!rec) throw new Error(`no ${live ? "live" : "rehearsal"} deployment record yet: run deploy${live ? " --live" : ""} first`);
  return rec;
}

/** Whether two records are of one deployment: the same kind of run and the same contract addresses. A
 * command that saves into a record it loaded earlier checks this first, since the file may since have
 * been planned anew (deploy --new-plan) or replaced. */
export function sameDeployment(x: DeploymentRecord, y: DeploymentRecord): boolean {
  const a = x.plan.addresses as Record<string, string | undefined>;
  const b = y.plan.addresses as Record<string, string | undefined>;
  return x.target === y.target && [...new Set([...Object.keys(a), ...Object.keys(b)])].every((k) => a[k]?.toLowerCase() === b[k]?.toLowerCase());
}

/** Writes a temp file and renames it over the record, so a crash never leaves half a record. */
export function saveRecord(path: string, rec: DeploymentRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, replacer, 2));
  renameSync(tmp, path);
}

export function archiveRecord(path: string): string {
  const to = path.replace(/\.json$/, `.abandoned-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  renameSync(path, to);
  return to;
}
