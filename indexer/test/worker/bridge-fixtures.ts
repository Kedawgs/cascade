import { type Hex, keccak256, numberToHex, pad, toBytes } from "viem";
import { batchKey, type Entry, encodeBatchMessage } from "../../src/crosscheck/replay.ts";
import type { StoredLog } from "../../src/logs.ts";
import { testConfig } from "./fixtures.ts";
import { slog } from "./rule-ctx.ts";

/** The test deployment (lowercase addresses). */
export const D = testConfig().deployment;
export const h = (s: string) => keccak256(toBytes(s)) as Hex;
export const RAO = 10n ** 9n;
const word = (n: bigint) => pad(numberToHex(n));

export interface BatchFixture {
  id: bigint;
  deposits: Entry[];
  redeems: Entry[];
  key: Hex;
  messageId: Hex;
  closeTx: Hex;
  deliveryTx: Hex;
  /** the front door's requests, then the close's transaction (the adapter's Sent, then BatchClosed) */
  base: StoredLog[];
  /** the delivery's transaction: BatchDelivered, outcomes, PayoutBatchQueued (if any redeem), Delivered */
  bit: StoredLog[];
  delivery: StoredLog;
}

/** An honest batch: what the front door logs as it fills and closes, and what the vault logs as it is
 * delivered (every deposit minted, every redeem burned in full at 1 share = 2 TAO-wei). The positions
 * can be shared with another batch to put two in one transaction. */
export function honestBatch(o: {
  id: bigint;
  deposits: Entry[];
  redeems?: Entry[];
  requestBlock?: bigint;
  closeBlock?: bigint;
  closeTx?: Hex;
  closeAt?: number;
  deliveryBlock?: bigint;
  deliveryTx?: Hex;
  deliveryAt?: number;
  messageId?: Hex;
}): BatchFixture {
  const redeems = o.redeems ?? [];
  const total = o.deposits.reduce((s, e) => s + e.amount, 0n);
  const key = batchKey(8453n, D.frontDoor, encodeBatchMessage(o.id, o.deposits, redeems));
  const messageId = o.messageId ?? h(`message ${o.id}`);
  const closeTx = o.closeTx ?? h(`close ${o.id}`);
  const deliveryTx = o.deliveryTx ?? h(`delivery ${o.id}`);
  const closeBlock = o.closeBlock ?? 37_000_500n + o.id;
  const deliveryBlock = o.deliveryBlock ?? 6_900_500n + o.id;
  let ci = o.closeAt ?? 0;
  let di = o.deliveryAt ?? 0;
  const fd = (event: string, args: StoredLog["args"], extra: Partial<StoredLog> = {}) =>
    slog({ contract: "frontDoor", chain: "base", address: D.frontDoor, event, args, block: o.requestBlock ?? 37_000_400n + o.id, ...extra });
  const base: StoredLog[] = [
    ...o.deposits.map((e, i) => fd("DepositRequested", { batchId: String(o.id), user: e.user, amount: String(e.amount), payer: e.user }, { logIndex: i, topic1: word(o.id) })),
    ...redeems.map((e, i) => fd("RedeemRequested", { batchId: String(o.id), user: e.user, shares: String(e.amount) }, { logIndex: 100 + i, topic1: word(o.id) })),
    slog({
      contract: "baseAdapter",
      chain: "base",
      address: D.baseAdapter,
      event: "Sent",
      block: closeBlock,
      txHash: closeTx,
      logIndex: ci++,
      topic1: messageId,
      args: { messageId, destChain: "964", sender: D.frontDoor, recipient: D.vault, amount: String(total), fee: "1", gasLimit: "1" },
    }),
    fd(
      "BatchClosed",
      { id: String(o.id), totalDeposits: String(total), nDeposits: String(o.deposits.length), nRedeems: String(redeems.length), fee: "1", potUsed: "1" },
      { block: closeBlock, txHash: closeTx, logIndex: ci++, topic1: word(o.id) },
    ),
  ];
  const vault = (event: string, args: StoredLog["args"]) =>
    slog({ contract: "vault", chain: "bittensor", address: D.vault, event, args, block: deliveryBlock, txHash: deliveryTx, logIndex: di++, topic1: typeof args.key === "string" ? (args.key as Hex) : undefined });
  const delivery = vault("BatchDelivered", { key, sourceChain: "8453", frontDoor: D.frontDoor, batchId: String(o.id), amount: String(total) });
  const bit: StoredLog[] = [delivery];
  for (const e of o.deposits) {
    bit.push(vault("Transfer", { from: "0x0000000000000000000000000000000000000000", to: e.user, value: "1" }));
    bit.push(vault("Deposited", { key, user: e.user, assets: String(e.amount - (e.amount % RAO)), shares: "1" }));
  }
  for (const e of redeems) {
    bit.push(vault("Transfer", { from: e.user, to: "0x0000000000000000000000000000000000000000", value: String(e.amount) }));
    bit.push(vault("Redeemed", { key, user: e.user, shares: String(e.amount), assets: String(2n * e.amount) }));
  }
  if (redeems.length) bit.push(vault("PayoutBatchQueued", { key, sourceChain: "8453", batchId: String(o.id), count: redeems.length, total: "1", price: "1" }));
  bit.push(
    slog({
      contract: "bitAdapter",
      chain: "bittensor",
      address: D.bitAdapter,
      event: "Delivered",
      block: deliveryBlock,
      txHash: deliveryTx,
      logIndex: di++,
      topic1: messageId,
      args: { messageId, sourceChain: "8453", sender: D.frontDoor, recipient: D.vault, amount: String(total) },
    }),
  );
  return { id: o.id, deposits: o.deposits, redeems, key, messageId, closeTx, deliveryTx, base, bit, delivery };
}

/** A copy of a log with some args changed. */
export const withArgs = (l: StoredLog, args: StoredLog["args"]): StoredLog => ({ ...l, args: { ...l.args, ...args } });
