import type { NextBatch } from "./cascade/types";

/**
 * When the open batch leaves, as a countdown on Base's clock. Every batch read carries the timestamp of
 * the block it read (`chainTime`); the device's clock only measures the time since that read, so a
 * device whose clock is minutes off still counts down to the right moment. A read too old to stand
 * behind shows "–", never a time.
 */

/** A batch read older than this shows "–" in place of a time: the reads come every 30 seconds, so this
 * is several missed in a row (a failing node, or a tab back from the background before its next read). */
export const STALE_MS = 150_000;

/** The keeper looks at the open batch every minute (ops `run`): five minutes past its interval, a batch
 * still open is one it is holding, not one it is about to send. Send it now is offered only from then. */
export const SEND_GRACE_S = 300;

/** No read yet (`readAt` 0), or one older than STALE_MS. */
export const isStale = (readAt: number, now: number): boolean => !(readAt > 0) || now - readAt > STALE_MS;

/** Now on Base's clock (unix seconds): the block time the read came with, plus the time since it landed
 * by this device's clock. Never before the read: the page's clock may last have ticked just before it. */
export const chainNow = (chainTime: number, readAt: number, now: number): number => chainTime + Math.max(0, now - readAt) / 1000;

/** The latest the batch leaves (unix seconds): its interval, or the deployment's max wait when that is
 * longer (the keeper holds a batch for it unless its fees cover the bridge fee sooner). */
export const leavesBy = (b: { start: number; interval: number }, maxWaitS?: number): number => b.start + Math.max(b.interval, maxWaitS ?? 0);

/** The front door let it close before its interval was up, as of the block read: it's full, and the
 * keeper sends a full batch at once. */
export const isFull = (b: { start: number; interval: number; canClose: boolean; chainTime: number }): boolean =>
  b.canClose && b.chainTime < b.start + b.interval;

/** A wait in words, rounded up to the minute so it's never understated: "3 h 12 min", "18 min", "under a
 * minute", and "any moment now" once it's due. */
export function countdown(seconds: number): string {
  if (seconds <= 0) return "any moment now";
  if (seconds < 60) return "under a minute";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "1 depositor", "2 depositors and 1 unstaker", "3 unstakers": the front door keeps one entry per account
 * per list (a second deposit adds to the first), so its counts are of accounts, not of deposits. */
function waiting(b: Pick<NextBatch, "deposits" | "redeems">): string {
  const parts = [...(b.deposits > 0 ? [count(b.deposits, "depositor")] : []), ...(b.redeems > 0 ? [count(b.redeems, "unstaker")] : [])];
  return parts.join(" and ");
}

/** The Stake page's public line: "Next batch leaves within 3 h 12 min · 1 depositor waiting". "Within", as
 * the time is the latest it leaves: the keeper sends it sooner once its fees cover the bridge fee. An
 * empty batch waits for its first deposit; a paused one names no time; a read that hasn't come, failed
 * or is stale shows "–". */
export function nextBatchLine(b: NextBatch | undefined, x: { readAt: number; now: number; maxWaitS?: number }): string {
  if (!b || isStale(x.readAt, x.now)) return "Next batch: –";
  if (b.paused) return "Next batch: on hold while Cascade is paused";
  if (b.deposits + b.redeems === 0) return "Next batch: waiting for the first deposit";
  const left = isFull(b) ? 0 : leavesBy(b, x.maxWaitS) - chainNow(b.chainTime, x.readAt, x.now);
  const when = left <= 0 ? "any moment now" : left < 60 ? "within a minute" : `within ${countdown(left)}`;
  return `Next batch leaves ${when} · ${waiting(b)} waiting`;
}
