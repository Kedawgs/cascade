import { type Hex, keccak256 } from "viem";
import type { Deployment } from "../config.ts";
import type { StoredLog } from "../logs.ts";
import { type Park, parkKeyOf, REFUND_CHUNK } from "../parks.ts";
import { type DeliveryGroup, pairSent } from "./pairing.ts";
import { encodePayoutsMessage, type PayoutVerdict } from "./payouts.ts";
import { encodeBatchMessage, replayBatch } from "./replay.ts";

// v3.2's refund cross-check (spec §3.2, I-9; T27 c4): a park refunded after PARK_TIMEOUT lands on Base as one PAYOUTS
// message with the park's key as its batch key and chunk REFUND_CHUNK, the parked batch's deposits as its entries,
// sent by the Bittensor adapter with the park's recipient (the vault) as the payload's sender. There is no vault
// PayoutChunkSent for it, so it is checked against the park and the batch the front door closed, never as a chunk.

export const REFUND_STEPS = {
  bridge: "1: the bridge",
  park: "2: the park the adapter refunded",
  message: "3: the bridge message",
  entries: "4: the entries (the parked batch's deposits)",
  delivered: "5: the front door's delivered record",
} as const;

const big = (x: unknown) => BigInt(String(x ?? "0"));
const lower = (x: unknown) => String(x).toLowerCase() as Hex;
const same = (a: unknown, b: Hex) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/** Checks one refund landing (its PayoutsDelivered with chunk REFUND_CHUNK, and the group of its transaction it opens)
 * through step 4; passing, it awaits step 5, the front door's delivered() read of the message rebuilt from the parked
 * batch. Call it once Bittensor is settled past the landing's time.
 * 1. through one of our Base bridges;
 * 2. exactly one park of its key that a Bittensor bridge refunded (ParkedRefunded), a batch from the front door to the
 *    vault (a stranger's refund goes back to its own sender, never to the front door), of the landed amount;
 * 3. the refund's Sent (in the ParkedRefunded's transaction, by its message id) names vault → front door with that
 *    amount, and the group's Delivered carries that message id, vault → front door;
 * 4. the parked batch, found by its message id (the Base adapter's Sent paired with its BatchClosed), replays to the
 *    park's key, and the PayoutReceived list is its deposits, entry by entry (each depositor's exact deposit). */
export function checkRefund(i: {
  d: Pick<Deployment, "frontDoor" | "vault">;
  /** the Base bridges a payout may arrive through (BRIDGES.base) */
  bridges: readonly Hex[];
  /** the Bittensor bridges a park is held by (BRIDGES.bittensor) */
  bitBridges: readonly Hex[];
  landing: StoredLog;
  group: DeliveryGroup | undefined;
  parks: readonly Park[];
  /** a Bittensor transaction's logs */
  bitTx: (hash: Hex) => StoredLog[];
  /** a Base transaction's logs */
  baseTx: (hash: Hex) => StoredLog[];
  /** the Base adapters' Sent logs loaded (the parked batch's close is found by its message id) */
  baseSent: readonly StoredLog[];
  /** the front door's logs (requests, cancels, closes) of the parked batch, at least */
  frontDoorLogs: readonly StoredLog[];
}): PayoutVerdict {
  const { d, landing, group } = i;
  const key = lower(landing.args.batchKey);
  const amount = big(landing.args.amount);
  const fail = (step: string, detail: string, extra: Partial<PayoutVerdict> = {}): PayoutVerdict => ({ status: "mismatch", step, detail, ...extra });

  // 1. through one of our Base bridges
  if (!i.bridges.some((b) => same(landing.args.bridge, b))) return fail(REFUND_STEPS.bridge, `bridge ${landing.args.bridge} isn't in BRIDGES`);

  // 2. the one park of this key a Bittensor bridge refunded
  const refunded = i.parks.filter((p) => p.key === key && p.ended?.event === "ParkedRefunded" && i.bitBridges.some((b) => same(p.adapter, b)));
  if (refunded.length !== 1) return fail(REFUND_STEPS.park, `${refunded.length} parks of ${key} refunded (ParkedRefunded)`);
  const park = refunded[0];
  const ended = park.ended as StoredLog;
  const sentTx = ended.txHash;
  if (!park.door) return fail(REFUND_STEPS.park, `the refunded park isn't a batch from the front door to the vault (sender ${park.sender}, recipient ${park.recipient})`, { sentTx });
  if (park.amount !== amount) return fail(REFUND_STEPS.park, `landed amount ${amount}, the park's ${park.amount}`, { sentTx });

  // 3. the refund's message: the adapter's Sent in the refund's transaction, and the Delivered closing the landing
  const messageId = lower(ended.args.messageId);
  const sent = i.bitTx(sentTx).find((l) => l.contract === "bitAdapter" && l.event === "Sent" && same(l.address, park.adapter) && same(l.args.messageId, messageId));
  if (!sent) return fail(REFUND_STEPS.message, `no Bittensor adapter Sent of message ${messageId} in the refund's transaction`, { sentTx, messageId });
  const dl = group?.delivered;
  if (!group || !dl) return fail(REFUND_STEPS.message, "no Base adapter Delivered to the front door closes the landing", { sentTx, messageId });
  if (!same(dl.args.messageId, messageId)) return fail(REFUND_STEPS.message, `message id ${dl.args.messageId} delivered, ${messageId} refunded`, { sentTx, messageId });
  const route = (l: StoredLog) => same(l.args.sender, d.vault) && same(l.args.recipient, d.frontDoor);
  if (!route(sent) || !route(dl) || big(sent.args.amount) !== amount) return fail(REFUND_STEPS.message, "the Sent or the Delivered doesn't name vault → front door with the park's amount", { sentTx, messageId });

  // 4. the parked batch, rebuilt from the front door's logs, is the park's, and its deposits are the entries
  const closeSent = i.baseSent.find((l) => same(l.args.messageId, park.messageId) && same(l.args.sender, d.frontDoor));
  const closer = closeSent && [...pairSent(i.baseTx(closeSent.txHash), { closer: "frontDoor:BatchClosed", adapter: "baseAdapter", sender: d.frontDoor })].find(([, s]) => s?.uid === closeSent.uid);
  const close = closer && i.baseTx(closeSent.txHash).find((l) => l.uid === closer[0]);
  if (!close) return fail(REFUND_STEPS.entries, `can't rebuild the parked batch: no BatchClosed paired with the Base adapter's Sent of message ${park.messageId}`, { sentTx, messageId });
  const id = big(close.args.id);
  const r = replayBatch(i.frontDoorLogs, id);
  if ("error" in r) return fail(REFUND_STEPS.entries, `can't rebuild the parked batch ${id}: ${r.error}`, { sentTx, messageId });
  const parkKey = parkKeyOf(8453n, d.frontDoor, d.vault, encodeBatchMessage(id, r.deposits, r.redeems));
  if (parkKey !== key) return fail(REFUND_STEPS.entries, `the refund's key ${key}, batch ${id}'s park key ${parkKey}`, { sentTx, messageId });
  const received = group.events.filter((e) => e.event === "PayoutReceived" && same(e.args.batchKey, key) && Number(e.args.chunk) === REFUND_CHUNK);
  if (received.length !== r.deposits.length) return fail(REFUND_STEPS.entries, `${received.length} PayoutReceived, ${r.deposits.length} deposits in batch ${id}`, { sentTx, messageId });
  for (const [n, e] of r.deposits.entries()) {
    const x = received[n];
    if (!same(x.args.user, e.user) || big(x.args.amount) !== e.amount) {
      return fail(REFUND_STEPS.entries, `entry ${n}: ${x.args.user} paid ${x.args.amount}, batch ${id}'s deposit ${e.user} of ${e.amount}`, { sentTx, messageId });
    }
  }
  return { status: "awaiting_read", sentTx, messageId, expectedHash: keccak256(encodePayoutsMessage(key, REFUND_CHUNK, r.deposits)) };
}
