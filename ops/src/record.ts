import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Address, Hex } from "viem";
import type { ChainName } from "./config.ts";
import type { Plan } from "./plan.ts";
import type { Sent } from "./send.ts";
import type { StepId } from "./types.ts";

export interface VerifyResult {
  ok: boolean;
  failures: string[];
  checkedAt: string;
}

/** A step found already done on-chain whose transaction was never recorded. */
export type DoneStep = Sent | { recovered: true };

export interface DeploymentRecord {
  target: "live" | "rehearsal";
  wallet: Address;
  createdAt: string;
  plan: Plan;
  done: Partial<Record<StepId, DoneStep>>;
  /** A sent transaction with no receipt yet; nothing more is sent until it resolves. */
  pending?: { step: StepId; chain: ChainName; nonce: number; hash?: Hex };
  verify?: VerifyResult;
  rehearsalClose?: { gasUsed: bigint; fee: bigint };
  /** Bridge messages the keeper sent, so status and track need no Base log scans. */
  messages?: { id: Hex; direction: "Base → Bittensor" | "Bittensor → Base"; hash: Hex; at: string }[];
}

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? { $bigint: v.toString() } : v);
const reviver = (_k: string, v: unknown) =>
  v && typeof v === "object" && "$bigint" in v ? BigInt((v as { $bigint: string }).$bigint) : v;

export function loadRecord(path: string): DeploymentRecord | null {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8"), reviver) : null;
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
