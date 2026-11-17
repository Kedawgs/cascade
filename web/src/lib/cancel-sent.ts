import type { Hex } from "viem";
import { explorer } from "./cascade/config";
import type { DepositOp, Operation, WithdrawalOp } from "./cascade/oplog";
import type { CancelSent } from "./cascade/trail";

/**
 * A cancel this browser sent for one of its deposits or unstakes, while the receipt's record doesn't show it yet.
 *
 * A receipt is drawn from the list read from the chain (Base, Bittensor and the history scan), and that read is slow:
 * after a cancel goes through, the list still holds the record as it was read before, waiting in its batch, until the
 * next read ends. Shown as it is, the receipt would offer Cancel (and Send it now) again for a deposit already taken
 * back out. This browser's own record of the cancel (the op log: written as the wallet sends it, cancelStore; marked
 * confirmed once its flow has seen it through and its own receipt said it took the record out, confirmCancel; taken back
 * off a cancel that failed) is newer than that read, so the receipt goes by it until the read catches up (trail.ts
 * depositCancelSent lays it over the record).
 */

/** How long a cancel this browser sent shows as on its way when nothing has said what became of it: neither its flow
 * (the tab was closed, or its receipt never came back) nor a read of the chain. As long as a send's (send-now.ts), and as
 * the trail gives a cancel Base doesn't know (trail.ts). Past it the record's own word stands: its cancel is offered. */
export const CANCEL_SENDING_MS = 10 * 60_000;
/** How far ahead of this device's clock a mark's date may be and still be in that window (two tabs' clocks are one
 * clock; a minute allows for one just set back). One dated further ahead isn't in flight: its window would otherwise
 * last the clock's error and ten minutes more. */
export const CANCEL_AHEAD_MS = 60_000;

/** What is asked of a deposit's or an unstake's record (records.ts): whose it is, whether it still offers its cancel as
 * last read (cancellableWei, or cancellableShares), and the cancel that read had already seen fail, if any (cancelSeen). */
export interface CancelRecord {
  id: string;
  cancellableWei?: bigint;
  cancellableShares?: bigint;
  cancelSeen?: Hex;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The cancel this browser sent for `record` that the record, as last read, doesn't show yet; null when there is none, and
 * the receipt is then exactly what the record says.
 * - No cancel recorded on this browser's own entry for this very deposit or unstake (by its id and kind: another's
 *   cancel is never this one's), or a record that no longer offers its cancel (the read has caught up: cancelled,
 *   cancelling, or gone with its batch): null.
 * - Confirmed (its flow saw it through, and the cancel's own receipt named this record's batch): "done". A read that
 *   still shows the record in its batch is behind (a node that hasn't the cancel's block yet), even one that says it has
 *   seen this same cancel fail, while the cancel is in its window (CANCEL_SENDING_MS from when it was sent). Past the
 *   window a read that names this very cancel as one that didn't take the record out wins: null, and the cancel is
 *   offered again. The mark is this browser's word, never the chain's, and no word of this browser's holds a way out
 *   against the chain's for the batch's whole life.
 * - Not confirmed, and the read had seen this same cancel and found it didn't take the record out (reverted, dropped
 *   or replaced: cancelSeen): null, so the cancel is offered again, as it always was.
 * - Not confirmed, in its window, and newer than the read: "sending". Out of it (sent CANCEL_SENDING_MS ago or more, or
 *   dated more than CANCEL_AHEAD_MS ahead of this device's clock): null. */
export function cancelSentFromHere(ops: readonly Operation[], kind: "deposit" | "withdrawal", record: CancelRecord, now: number): CancelSent | null {
  if (record.cancellableWei === undefined && record.cancellableShares === undefined) return null;
  const mark = ops.find((o): o is DepositOp | WithdrawalOp => o.kind === kind && o.id === record.id)?.cancelled;
  if (!mark) return null;
  const age = now - mark.at;
  const inWindow = age < CANCEL_SENDING_MS && age >= -CANCEL_AHEAD_MS;
  // the read was made knowing of this very cancel, and found it didn't take the record out
  const refused = record.cancelSeen !== undefined && same(record.cancelSeen, mark.hash);
  if (mark.confirmed) return refused && !inWindow ? null : { state: "done", hash: mark.hash, at: mark.at };
  if (refused || !inWindow) return null;
  return { state: "sending", hash: mark.hash, at: mark.at };
}

/** What the receipt says in place of its Send it now and Cancel buttons: that the cancel is on its way, then what it came
 * to (a cancelled deposit comes back as TAO, never as USDC; a cancelled unstake keeps its shares, not its request fee),
 * with its transaction on Base. */
export function cancelSentCopy(what: "deposit" | "unstake", c: CancelSent): { lead: string; text?: string; txUrl: string } {
  const txUrl = explorer.baseTx(c.hash);
  if (c.state === "sending") return { lead: `Cancelling your ${what}…`, txUrl };
  return what === "deposit"
    ? { lead: "Deposit cancelled.", text: "Your TAO is back in your wallet as TAO, not USDC.", txUrl }
    : { lead: "Unstake cancelled.", text: "Your shares stay staked; the request fee isn't refunded.", txUrl };
}
