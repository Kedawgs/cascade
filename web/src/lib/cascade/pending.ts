import type { SentNotice } from "../sent";
import { explorer } from "./config";
import type { Operation } from "./oplog";
import { toDisplay } from "./units";

/** How long after it was sent a deposit or unstake of this browser's shows in Activity's list before
 * the list has been read from the chain (the longest a batch waits on the launch cadence). */
export const PENDING_SHOWN_MS = 24 * 60 * 60_000;

/** A deposit or unstake this browser sent, shown before Activity has read it from the chain: only what
 * its own record says (the amounts it was sent with, estimates but for wallet TAO's), and never as more
 * than that: the screens call it unconfirmed. */
export interface PendingEntry {
  notice: SentNotice;
  createdAt: Date;
  /** Its transaction on Base (the stake, the deposit, or the unstake request). */
  txUrl?: string;
}

/** Its pending entry, for a deposit or unstake whose transactions all went through as the wallet saw
 * them (state "sent") and that no cancel took back out; null for anything else (still running, waiting
 * for the user, failed, a claim). */
export function pendingEntry(op: Operation): PendingEntry | null {
  if (op.state !== "sent" || op.kind === "claim" || op.cancelled) return null;
  const createdAt = new Date(op.createdAt);
  if (op.kind === "withdrawal") {
    return {
      notice: { kind: "unstake", id: op.id, tao: toDisplay(op.taoEstimate, 18), usdc: toDisplay(op.usdcEstimate, 6) },
      createdAt,
      ...(op.hash ? { txUrl: explorer.baseTx(op.hash) } : {}),
    };
  }
  // v3: one stake transaction; v2 and wallet TAO: the deposit call, after the swap
  const hash = op.v === 3 ? op.hashes.stake : (op.hashes.deposit ?? op.hashes.swap);
  return {
    notice: { kind: "deposit", id: op.id, ...(op.usdcIn > 0n ? { usdc: toDisplay(op.usdcIn, 6) } : {}), tao: toDisplay(op.targetTao, 18) },
    createdAt,
    ...(hash ? { txUrl: explorer.baseTx(hash) } : {}),
  };
}

/** This browser's pending entries of one kind sent in the last PENDING_SHOWN_MS, newest first, less those
 * `listed` holds (the records read from the chain, once read): matched by id, so an entry and its record
 * never show together, and one a list read before it was sent doesn't hold still shows. */
export function pendingEntries(ops: readonly Operation[], kind: "deposit" | "withdrawal", listed: readonly { id: string }[] | undefined, now: number): PendingEntry[] {
  const known = new Set((listed ?? []).map((r) => r.id));
  return ops
    .filter((o) => o.kind === kind && !known.has(o.id) && now - o.createdAt < PENDING_SHOWN_MS)
    .map(pendingEntry)
    .filter((e): e is PendingEntry => e !== null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** What a receipt page shows: its record once read; before that this browser's own entry for it
 * (unconfirmed), or loading; not found once a fresh read doesn't hold it. A failed read is said as it was
 * before, with the entry above it when the record isn't there. */
export function receiptShows(s: {
  record: { id: string } | null | undefined;
  entry: PendingEntry | null;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
}): "record" | "pending" | "pending-error" | "loading" | "error" | "not-found" {
  if (s.isError) return s.entry && !s.record ? "pending-error" : "error";
  if (s.record) return "record";
  if (s.entry) return "pending";
  return s.isPending || s.isFetching ? "loading" : "not-found";
}
