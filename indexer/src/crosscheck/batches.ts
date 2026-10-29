import type { Hex } from "viem";
import type { Deployment } from "../config.ts";
import type { StoredLog } from "../logs.ts";
import { type DeliveryGroup, pairSent } from "./pairing.ts";
import { batchKey, encodeBatchMessage, replayBatch } from "./replay.ts";

// The batch cross-check (spec 6.2, steps 2–6; step 1, the source, is ccip.unexpected_source): one
// delivery of a batch on Bittensor against the batch the front door closed on Base.

export const DEPOSIT_OUTCOMES: readonly string[] = ["Deposited", "DepositBounced", "DepositSkipped"];
export const REDEEM_OUTCOMES: readonly string[] = ["Redeemed", "RedeemDeferred", "RedeemSkipped"];

export const STEPS = {
  close: "2: the batch the front door closed",
  counts: "3: the outcome counts",
  message: "4: the bridge message",
  key: "5: the batch's key",
  entries: "6: the outcomes, entry by entry",
} as const;

export interface BatchVerdict {
  status: "ok" | "mismatch";
  step?: string;
  detail?: string;
  /** the replay itself failed: "can't rebuild this batch" */
  cantRebuild?: boolean;
  closedTx?: Hex;
  messageId?: Hex;
  expectedKey?: Hex;
}

const RAO = 10n ** 9n;
const big = (x: unknown) => BigInt(String(x ?? "0"));
const same = (a: unknown, b: Hex) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/** Checks one delivery (its BatchDelivered, and the group of its transaction it opens) against the front
 * door's logs of its batch id. Call it once Base is settled past the delivery's time. */
export function checkBatch(i: {
  d: Pick<Deployment, "frontDoor" | "vault">;
  delivery: StoredLog;
  group: DeliveryGroup | undefined;
  /** the front door's logs (requests, cancels, closes) of the batch id, at least; others are ignored */
  frontDoorLogs: readonly StoredLog[];
  /** a Base transaction's logs */
  baseTx: (hash: Hex) => StoredLog[];
}): BatchVerdict {
  const { d, delivery, group } = i;
  const id = big(delivery.args.batchId);
  const key = String(delivery.args.key).toLowerCase() as Hex;
  const amount = big(delivery.args.amount);
  const fail = (step: string, detail: string, extra: Partial<BatchVerdict> = {}): BatchVerdict => ({ status: "mismatch", step, detail, ...extra });

  // 2. exactly one BatchClosed(id), whose totalDeposits is the delivered amount
  const closes = i.frontDoorLogs.filter((l) => l.contract === "frontDoor" && l.event === "BatchClosed" && big(l.args.id) === id);
  if (closes.length === 0) return fail(STEPS.close, `no BatchClosed(${id}) from the front door`);
  if (closes.length > 1) return fail(STEPS.close, `${closes.length} BatchClosed(${id}) from the front door`);
  const close = closes[0];
  const closedTx = close.txHash;
  const total = big(close.args.totalDeposits);
  if (total !== amount) return fail(STEPS.close, `delivered amount ${amount}, the close's totalDeposits ${total}`, { closedTx });

  // 3. the group holds nDeposits deposit outcomes and nRedeems redeem outcomes with this key
  if (!group) return fail(STEPS.counts, "the delivery's events weren't found in its transaction", { closedTx });
  const outcomes = (names: readonly string[]) => group.events.filter((e) => names.includes(e.event) && same(e.args.key, key));
  const dOut = outcomes(DEPOSIT_OUTCOMES);
  const rOut = outcomes(REDEEM_OUTCOMES);
  if (BigInt(dOut.length) !== big(close.args.nDeposits)) return fail(STEPS.counts, `${dOut.length} deposit outcomes, nDeposits ${close.args.nDeposits}`, { closedTx });
  if (BigInt(rOut.length) !== big(close.args.nRedeems)) return fail(STEPS.counts, `${rOut.length} redeem outcomes, nRedeems ${close.args.nRedeems}`, { closedTx });

  // 4. the Delivered closing the group carries the message id of the Sent paired with the close, both
  // naming front door → vault with the batch's amount
  const sent = pairSent(i.baseTx(close.txHash), { closer: "frontDoor:BatchClosed", adapter: "baseAdapter", sender: d.frontDoor }).get(close.uid);
  if (!sent) return fail(STEPS.message, "no Base adapter Sent from the front door paired with the close", { closedTx });
  const messageId = String(sent.args.messageId).toLowerCase() as Hex;
  const dl = group.delivered;
  if (!dl) return fail(STEPS.message, "no Bittensor adapter Delivered to the vault closes the delivery", { closedTx, messageId });
  if (!same(dl.args.messageId, messageId)) return fail(STEPS.message, `message id ${dl.args.messageId} delivered, ${messageId} sent`, { closedTx, messageId });
  const route = (l: StoredLog) => same(l.args.sender, d.frontDoor) && same(l.args.recipient, d.vault) && big(l.args.amount) === total;
  if (!route(sent) || !route(dl)) return fail(STEPS.message, "the Sent or the Delivered doesn't name front door → vault with the batch's amount", { closedTx, messageId });

  // 5. the delivered key is the key of the batch the front door built
  const r = replayBatch(i.frontDoorLogs, id);
  if ("error" in r) return fail(STEPS.key, `can't rebuild this batch: ${r.error}`, { cantRebuild: true, closedTx, messageId });
  const expectedKey = batchKey(8453n, d.frontDoor, encodeBatchMessage(id, r.deposits, r.redeems));
  if (expectedKey !== key) return fail(STEPS.key, `delivered key ${key}, the replayed batch's ${expectedKey}`, { closedTx, messageId, expectedKey });

  // 6. the outcomes match the lists entry by entry
  const ok = { closedTx, messageId, expectedKey };
  for (const [n, e] of r.deposits.entries()) {
    const o = dOut[n];
    const assets = e.amount - (e.amount % RAO);
    if (!same(o.args.user, e.user) || big(o.args.assets) !== assets) {
      return fail(STEPS.entries, `deposit ${n}: ${o.event} names ${o.args.user} with ${o.args.assets}, the batch ${e.user} with ${assets}`, ok);
    }
  }
  for (const [n, e] of r.redeems.entries()) {
    const o = rOut[n];
    if (!same(o.args.user, e.user)) return fail(STEPS.entries, `redeem ${n}: ${o.event} names ${o.args.user}, the batch ${e.user}`, ok);
    if (o.event === "Redeemed" ? big(o.args.shares) > e.amount : big(o.args.requested) !== e.amount) {
      return fail(STEPS.entries, `redeem ${n}: ${o.event} of ${o.event === "Redeemed" ? o.args.shares : o.args.requested} shares, the request ${e.amount}`, ok);
    }
  }
  return { status: "ok", ...ok };
}
