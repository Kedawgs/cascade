import type { Address, Hex } from "viem";
import type { FlowStore } from "./flows";
import type { CancelMark, OpLog, Operation } from "./oplog";

/** A flow's progress kept in its operation log entry. A withdrawal has one call ("request"), whose
 * hash is dated when recorded (`now`). The store keeps its own copy of the entry (`last`) and never
 * loses it: if the entry disappears while the flow runs (removed from another tab), it is put back
 * before anything is read or written, so a transaction signed after that is still recorded; and if a
 * write leaves the entry unreadable (a field the log won't read back: oplog.ts), the flow goes on from
 * the copy, which is put back on the next read, and the loss is said loudly rather than letting a flow
 * stop between a send and its receipt. */
export function opStore(log: OpLog, account: Address, id: string, now: () => number = Date.now): FlowStore {
  const found = log.get(account, id);
  if (!found) throw new Error(`There is no record ${id} to keep this flow's progress in`);
  let last: Operation = found;
  const op = (): Operation => {
    const o = log.get(account, id);
    if (o) return (last = o);
    log.put(last);
    return last;
  };
  const update = (patch: Partial<Operation>) => {
    const before = op();
    log.update(account, id, patch);
    const after = log.get(account, id);
    if (after) {
      last = after;
      return;
    }
    last = { ...before, ...patch } as Operation;
    console.error(
      `Cascade: the record of this transaction (${id}) couldn't be read back after it was updated (${Object.keys(patch).join(", ")}); the flow goes on from memory, and the record may be missing from Activity.`,
    );
  };
  return {
    hashes: () => {
      const o = op();
      return o.kind === "withdrawal" ? { request: o.hash } : { ...o.hashes };
    },
    setHash: (k, h) => {
      const o = op();
      update(o.kind === "withdrawal" ? { hash: h, sentAt: now() } : ({ hashes: { ...o.hashes, [k]: h } } as Partial<Operation>));
    },
    setState: (state, error) => update({ state, error }),
    callsId: () => {
      const o = op();
      return o.kind === "withdrawal" ? undefined : o.callsId;
    },
    setCallsId: (callsId) => update({ callsId } as Partial<Operation>),
    mode: () => op().mode,
    setMode: (mode) => update({ mode }),
  };
}

/** A flow's progress kept only while it runs, for a flow with no record of its own (a swap of wallet TAO). */
export function scratchStore(): FlowStore {
  const hashes: Record<string, Hex | undefined> = {};
  let mode: "batch" | "sequential" | undefined;
  let callsId: string | undefined;
  return {
    hashes: () => hashes,
    setHash: (k, h) => void (hashes[k] = h),
    setState: () => undefined,
    callsId: () => callsId,
    setCallsId: (id) => void (callsId = id),
    mode: () => mode,
    setMode: (m) => void (mode = m),
  };
}

/** A cancel's store: a flow's, and the way to take its cancel back off the record once the cancel's own receipt has shown
 * it didn't take the record out (`takeBack`, for the cancel `hash` that receipt was read for). */
export interface CancelStore extends FlowStore {
  takeBack(hash: Hex): void;
}

const sameHash = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase();

/** A cancel, kept on the record it takes back out of the open batch. Its hash is written to the record
 * (`cancelled`) as soon as the wallet sends it, before its receipt is waited for, so a cancel whose
 * receipt never came back (a dropped connection, a timeout) still counts once Base shows it. A cancel
 * Base reverted isn't one: the record gets back the cancel it had before, if any. Everything else about
 * the run stays in memory, and the record's own state is never touched. `takeBack` is that same restore, for a
 * cancel the wallet saw through whose own receipt then showed it didn't take the record out (settleCancel): only while
 * the record's cancel is still the one named (another tab's cancel, recorded since, is left alone). */
export function cancelStore(log: OpLog, account: Address, id: string, now: () => number = Date.now): CancelStore {
  const run = scratchStore();
  let sent = false;
  let before: CancelMark | undefined;
  return {
    ...run,
    setHash(k, h) {
      run.setHash(k, h);
      const o = log.get(account, id);
      if (!o || o.kind === "claim" || o.kind === "close") return;
      if (!sent) before = o.cancelled;
      sent = true;
      log.update(account, id, { cancelled: { hash: h, at: now() } } as Partial<Operation>);
    },
    setState(state, error) {
      run.setState(state, error);
      if (state === "failed" && sent) log.update(account, id, { cancelled: before } as Partial<Operation>);
    },
    takeBack(hash) {
      const o = log.get(account, id);
      if (!sent || !o || o.kind === "claim" || o.kind === "close" || !o.cancelled || !sameHash(o.cancelled.hash, hash)) return;
      log.update(account, id, { cancelled: before } as Partial<Operation>);
    },
  };
}

/** Marks the record's cancel as confirmed, once its flow has seen it through and the cancel's own receipt said it took
 * the record out of its batch (use-flows.ts cancel; flows.ts cancelConfirmed). `hash` is the cancel that receipt was read
 * for: only that cancel is confirmed, so nothing is written unless the record's cancel is still that one (another tab's
 * cancel, recorded while the receipt was being read, is never confirmed on this one's word). This browser's own word
 * that the record is cancelled, kept across a reload: its receipt page shows it so at once, and doesn't offer the cancel
 * again while the reads of the chain are behind (cancel-sent.ts). Nothing for a record with no cancel sent, or for none. */
export function confirmCancel(log: OpLog, account: Address, id: string, hash: Hex): void {
  const o = log.get(account, id);
  if (!o || o.kind === "claim" || o.kind === "close" || !o.cancelled || o.cancelled.confirmed || !sameHash(o.cancelled.hash, hash)) return;
  log.update(account, id, { cancelled: { ...o.cancelled, confirmed: true } } as Partial<Operation>);
}

/** Writes to a record what its cancel's own receipt said of it, once its flow has seen the cancel through (flows.ts
 * cancelConfirmed), for the cancel `hash` that receipt was read for:
 * - it took the record out of its batch (true): marked confirmed (confirmCancel);
 * - it didn't (false: no cancel of the account's from the front door in it, or one out of another batch): its mark is
 *   taken back (the store's takeBack, as on a cancel Base reverted), so the receipt page offers the cancel again at once
 *   rather than showing it on its way;
 * - not readable yet (undefined), or nothing was read: left as it is, on its way, until a read of the chain says. */
export function settleCancel(store: Pick<CancelStore, "takeBack">, log: OpLog, account: Address, id: string, hash: Hex | undefined, outcome: boolean | undefined): void {
  if (hash === undefined || outcome === undefined) return;
  if (outcome) confirmCancel(log, account, id, hash);
  else store.takeBack(hash);
}
