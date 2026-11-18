import { formatTao, formatUsdc } from "../format";
import type { SentNotice } from "../sent";
import { explorer } from "./config";
import type { Operation } from "./oplog";
import type { TrailStep } from "./records";
import { CROSSING_AHEAD, RECEIVE_TAO_STEP, SAFETY_WAIT_AHEAD, safetyWaitAhead, TAO_AHEAD, USDC_AHEAD } from "./trail";
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
  if (op.state !== "sent" || op.kind === "claim" || op.kind === "close" || op.cancelled) return null;
  const createdAt = new Date(op.createdAt);
  if (op.kind === "withdrawal") {
    return {
      // v3.2: one asked as TAO has no USDC estimate to show
      notice: op.keepTao
        ? { kind: "unstake", id: op.id, tao: toDisplay(op.taoEstimate, 18), keepTao: true }
        : { kind: "unstake", id: op.id, tao: toDisplay(op.taoEstimate, 18), usdc: toDisplay(op.usdcEstimate, 6) },
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

/** A step this browser sent and the chain's history hasn't shown yet. */
export const CONFIRMING = "Sent from this browser. Confirming on Base…";

/** The steps of a deposit or unstake this browser sent, before its record is read from the chain: the trail its
 * receipt will have, the step it sent confirming and the rest ahead, so a receipt is one layout from the moment it is
 * sent (the founder, 2026-11-18: "it should only show this layout no matter where it is in the process"). Nothing
 * here is read from the chain, and nothing claims to be: the one step that is not ahead says it is confirming.
 * `payoutDelayS` is the deployment's safety wait, when the site knows it. */
export function pendingTrail(entry: PendingEntry, x: { payoutDelayS?: number } = {}): TrailStep[] {
  const n = entry.notice;
  const sent = { status: "active" as const, detail: CONFIRMING, summary: "confirming…", ...(entry.txUrl ? { txUrl: entry.txUrl } : {}) };
  if (n.kind === "unstake") {
    const wait = x.payoutDelayS === undefined ? SAFETY_WAIT_AHEAD : safetyWaitAhead(x.payoutDelayS);
    return [
      { key: "request", title: "Request your unstake", ...sent },
      { key: "unstake", title: "Unstake on Bittensor", status: "pending", detail: CROSSING_AHEAD },
      { key: "return", title: "Return to Base", status: "pending", ...(wait ? { detail: wait } : {}) },
      { key: "claim", title: n.keepTao ? RECEIVE_TAO_STEP : "USDC to your wallet", status: "pending", detail: n.keepTao ? TAO_AHEAD : USDC_AHEAD },
    ];
  }
  // a deposit of TAO already in the wallet has no swap to wait for: the transaction it sent is the deposit
  const swapped = n.usdc !== undefined;
  return [
    swapped ? { key: "swap", title: "Swap USDC for TAO", ...sent } : { key: "swap", title: "Swap USDC for TAO", status: "done" },
    swapped ? { key: "deposit", title: "Deposit into Cascade", status: "pending" } : { key: "deposit", title: "Deposit into Cascade", ...sent },
    { key: "bridge", title: "Cross to Bittensor", status: "pending", detail: CROSSING_AHEAD },
    { key: "stake", title: "Stake on Bittensor", status: "pending" },
  ];
}

/** The figures under that trail, in the confirmed receipt's own rows and words: estimates are "about". */
export function pendingRows(n: SentNotice): [string, string][] {
  if (n.kind === "unstake") return [["You will receive", n.keepTao ? "TAO on Base, to claim" : `about ${formatUsdc(n.usdc)} USDC on Base`]];
  return [["TAO in this deposit", n.usdc !== undefined ? `about ${formatTao(n.tao, 4)} TAO` : `${formatTao(n.tao, 4)} TAO`]];
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
