import type { Hex } from "viem";
import type { Action } from "./due.ts";
import { RevertedOnChain } from "./errors.ts";
import type { CallRequest, ChainName } from "./types.ts";

// What the keeper remembers from one round to the next (design-keeper-worker.md §1): one plain object, JSON with
// bigints tagged, carrying a version. On the PC it lives in the `run` process; in the Worker it is saved after every
// round and loaded before the next. Every Map and counter today's run loop kept is here, so a run split across
// invocations behaves as one loop.

/** The memory's version: a saved memory of an older version starts afresh (as a PC restart does), a newer one is
 * refused (a rollback must not write over it). */
export const MEMORY_VERSION = 1;

/** A revert the round could not explain because the chains could not be read again: what the next round needs to
 * explain it, or to stop on it with the same message. */
export interface SavedRevert {
  chain: ChainName;
  hash: Hex;
  reason?: string;
  message: string;
}

/** A transaction sent with no receipt yet: its hash, and each replacement's, looked up each round until one of them
 * has a receipt (any of them landing ends the watch), or something else is mined at its nonce; replaced at that nonce
 * once it has been pending REPLACE_AFTER_MS (when the deps can, and the call it carries is known). */
export interface Unreceipted {
  /** The original's hash, then each replacement's, in order */
  hashes: Hex[];
  chain: ChainName;
  what: string;
  /** Where its bridge message, if it sent one, is read from */
  message?: { adapter: Hex; direction: "Base → Bittensor" | "Bittensor → Base" };
  /** The call it carries, for a replacement; unset for one the keeper can't rebuild */
  request?: CallRequest;
  /** When the keeper stopped waiting for its receipt (by the clock), how many replacements have been
   * sent, and when it is next replaced */
  since: number;
  replacements: number;
  replaceAt: number;
  /** Rounds in a row the wallet's mined nonce has been past the call's with none of the hashes mined */
  passed: number;
}

/** A close, roll, payout or stake (an action another caller can beat). */
export type Racing = Exclude<Action, { kind: "deliver" }>;

export interface KeeperMemory {
  v: number;
  /** The last round's number (0 before the first) */
  tick: number;
  /** When the next round is due, by the clock (ms): the back-off after a failed round; 0 = now */
  nextAt: number;
  /** The last wait logged for each user, so each reason is logged once */
  waiting: Record<string, string>;
  /** Deliveries held after a refused estimate or a revert: why, the facts they were held on (unset: a timed hold
   * that no change in the facts ends), and when the hold ends */
  held: Record<string, { reason: string; facts?: string; until: number }>;
  /** Each user's reverted deliveries (when, by the clock) within REVERT_WINDOW_MS, the holds their budget has cost
   * in a row, and when the last of those ends (unset: none yet) */
  reverts: Record<string, { at: number[]; strikes: number; holdEnd?: number }>;
  /** How many rounds in a row each kind of skip has happened */
  skipRuns: Record<string, number>;
  /** The circuit breaker: each close, stake or payout's refusals in a row (by actionKey), the back-off its last skip
   * cost, and when it is tried again */
  refusals: Record<string, { n: number; backoffMs: number; until: number }>;
  /** A revert whose re-read failed: the next round's read decides */
  unread?: { action: Racing; before: unknown; revert: SavedRevert };
  unreceipted: Unreceipted[];
  /** v3.2 (Task 52w fix): the delivery candidates read since the turn began (lowercase), so each round reads the oldest not
   * read yet (KeeperActions.deliveriesPerRound); and the last "DELIVERIES READ IN PART" line, said once a change */
  deliveriesRead?: string[];
  deliveriesUnreadSaid?: string;
  claimDue?: boolean;
  /** Failed rounds in a row, those failed on something unexpected, and whether every one of them was a refusal of a
   * close, stake or payout short of tripping the breaker (and of which) */
  failing: number;
  unexpected: number;
  streak: { refusalsOnly: boolean; keys: string[] };
  /** The payout whose list the last round set to be rebuilt from a second scan of the vault's events */
  rescannedPayout?: string;
  /** Actions refused for good (a final refusal, v3.2: by actionKey, with why): never tried again by this run */
  final: Record<string, string>;
  /** v3.2 (R12d, M-1): the actions (by actionKey) and chains (`chain:<name>`) the spend cap refused in the last round, each
   * said once while it lasts (SPEND CAP ROOM, SPEND CAP), again once it has gone a round without */
  noRoom?: string[];
  /** What a deployment's reads keep between rounds (v3.2: its log cursors, core/v32/reads.ts), by name */
  reads: Record<string, unknown>;
}

export function freshMemory(): KeeperMemory {
  return {
    v: MEMORY_VERSION,
    tick: 0,
    nextAt: 0,
    waiting: {},
    held: {},
    reverts: {},
    skipRuns: {},
    refusals: {},
    unreceipted: [],
    failing: 0,
    unexpected: 0,
    streak: { refusalsOnly: true, keys: [] },
    final: {},
    reads: {},
  };
}

/** A revert as the memory keeps it. */
export const saveRevert = (e: RevertedOnChain): SavedRevert => ({ chain: e.chain, hash: e.hash, reason: e.reason, message: e.message });

/** The saved revert as the error it was: the same class, chain, hash, reason and message. */
export function revertOf(r: SavedRevert): RevertedOnChain {
  const e = new RevertedOnChain(r.chain, "", r.hash, r.reason);
  e.message = r.message;
  return e;
}

/** The value as JSON: bigints as {"$bigint": "…"}; a Map, a Set, a function or a number JSON can't hold (Infinity,
 * NaN) is refused, so nothing is lost on the way. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (k, v) => {
    if (typeof v === "bigint") return { $bigint: v.toString() };
    if (v instanceof Map || v instanceof Set) throw new Error(`the keeper's memory holds a ${v instanceof Map ? "Map" : "Set"} at "${k}", which JSON can't keep`);
    if (typeof v === "function") throw new Error(`the keeper's memory holds a function at "${k}", which JSON can't keep`);
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`the keeper's memory holds ${v} at "${k}", which JSON can't keep`);
    return v;
  });
}

/** toJson's text read back, bigints included. */
export const fromJson = <T>(text: string): T =>
  JSON.parse(text, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.$bigint === "string" ? BigInt(v.$bigint) : v)) as T;

export const encodeMemory = (m: KeeperMemory): string => toJson(m);

/** A saved memory is newer than this code (a rollback): refused rather than written over. */
export class MemoryTooNew extends Error {}

/** A saved memory read back: none (a first run) or an older version gives a fresh one (`reset` says why); a newer
 * one is refused (MemoryTooNew). */
export function loadMemory(text: string | undefined | null): { memory: KeeperMemory; reset?: "none" | "older" } {
  if (!text) return { memory: freshMemory(), reset: "none" };
  const m = fromJson<KeeperMemory>(text);
  if (typeof m.v !== "number" || m.v < MEMORY_VERSION) return { memory: freshMemory(), reset: "older" };
  if (m.v > MEMORY_VERSION) {
    throw new MemoryTooNew(`the keeper's saved memory is version ${m.v}, newer than this code's ${MEMORY_VERSION} (a rollback): nothing is written over it; deploy the newer code or clear the memory by hand`);
  }
  return { memory: m };
}

/** A Map's face over one of the memory's records, so the round reads as it always has: get, set, has, delete and
 * iteration in insertion order (a record's string keys keep it, through JSON too). */
export function recordMap<T>(o: Record<string, T>) {
  return {
    get: (k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined),
    set: (k: string, v: T) => {
      o[k] = v;
    },
    has: (k: string) => Object.hasOwn(o, k),
    delete: (k: string) => {
      delete o[k];
    },
    keys: () => Object.keys(o),
    entries: (): [string, T][] => Object.entries(o),
  };
}
