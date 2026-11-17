import { type Hex, keccak256, numberToHex, pad, toBytes } from "viem";
import { batchKey, type Entry, encodeBatchMessage } from "../../src/crosscheck/replay.ts";
import type { StoredLog } from "../../src/logs.ts";
import { parkKeyOf } from "../../src/parks.ts";
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

export interface PayoutEntry {
  user: Hex;
  shares: bigint;
  assets: bigint;
}

export interface LandedChunk {
  chunk: number;
  net: bigint;
  entries: Entry[];
  messageId: Hex;
  chunkTx: Hex;
  landTx: Hex;
  /** the front door's PayoutsDelivered (absent when net = 0: nothing was sent) */
  landing?: StoredLog;
}

export interface PayoutFixture {
  key: Hex;
  /** the delivery's outcomes and queue, and each chunk's transaction (the adapter's Sent, PayoutChunkSent) */
  bit: StoredLog[];
  /** each landing's transaction: PayoutsDelivered, its PayoutReceived, the adapter's Delivered */
  base: StoredLog[];
  chunks: LandedChunk[];
}

/** A payout batch for `key` (bounced entries have 0 shares, then redeemed ones), sent in chunks of
 * `taken` entries, each paid assets − ceil(assets × fee / gross), floored to rao, zeros dropped, and
 * landed on Base through `bridge` (the Base adapter by default). A chunk with `charged` is v3.2's: its entries
 * bear charged + unstakeCost (the fee the bridge was paid may be more, the caller's top-up), and its
 * PayoutChunkSent has eight fields. Positions can be shared with another fixture to put two chunks, or two
 * landings, in one transaction. */
export function payoutBatch(o: {
  key: Hex;
  list: PayoutEntry[];
  chunks: { taken: number; fee: bigint; charged?: bigint; unstakeCost?: bigint }[];
  deliveryBlock?: bigint;
  chunkBlock?: bigint;
  chunkTx?: Hex;
  chunkAt?: number;
  landBlock?: bigint;
  landTx?: Hex;
  landAt?: number;
  bridge?: Hex;
  /** v3.2: the owner's cancel after chunk `after`, carrying the last `bouncesCarried` bounced entries forward as
   * the batch's new list (the cursor back to 0, the chunk number going on) */
  cancel?: { after: number; bouncesCarried: number };
}): PayoutFixture {
  const bridge = o.bridge ?? D.baseAdapter;
  const deliveryTx = h(`payout delivery ${o.key}`);
  const deliveryBlock = o.deliveryBlock ?? 6_900_300n;
  let di = 0;
  const vault = (event: string, args: StoredLog["args"], at: { block: bigint; txHash: Hex; logIndex: number }) =>
    slog({ contract: "vault", chain: "bittensor", address: D.vault, event, args, topic1: o.key, ...at });
  const bit: StoredLog[] = [vault("BatchDelivered", { key: o.key, sourceChain: "8453", frontDoor: D.frontDoor, batchId: "1", amount: "0" }, { block: deliveryBlock, txHash: deliveryTx, logIndex: di++ })];
  for (const p of o.list.filter((x) => x.shares === 0n)) bit.push(vault("DepositBounced", { key: o.key, user: p.user, assets: String(p.assets) }, { block: deliveryBlock, txHash: deliveryTx, logIndex: di++ }));
  for (const p of o.list.filter((x) => x.shares !== 0n)) bit.push(vault("Redeemed", { key: o.key, user: p.user, shares: String(p.shares), assets: String(p.assets) }, { block: deliveryBlock, txHash: deliveryTx, logIndex: di++ }));
  bit.push(vault("PayoutBatchQueued", { key: o.key, sourceChain: "8453", batchId: "1", count: o.list.length, total: "1", price: "1" }, { block: deliveryBlock, txHash: deliveryTx, logIndex: di++ }));

  const base: StoredLog[] = [];
  const chunks: LandedChunk[] = [];
  let cursor = 0;
  let ci = o.chunkAt ?? 0;
  let li = o.landAt ?? 0;
  let current = o.list;
  o.chunks.forEach(({ taken, fee, charged, unstakeCost }, n) => {
    if (o.cancel && n === o.cancel.after + 1) {
      const bounces = o.list.filter((x) => x.shares === 0n);
      current = bounces.slice(bounces.length - o.cancel.bouncesCarried);
      cursor = 0;
      const block = (o.chunkBlock ?? 6_900_400n) + BigInt(n);
      bit.push(vault("PayoutBatchCancelled", { key: o.key, reminted: "1", bouncesCarried: o.cancel.bouncesCarried }, { block, txHash: h(`cancel tx ${o.key}`), logIndex: ci++ }));
    }
    const part = current.slice(cursor, cursor + taken);
    cursor += taken;
    const gross = part.reduce((s, p) => s + p.assets, 0n);
    const borne = charged === undefined ? fee : charged + (unstakeCost ?? 0n);
    const entries: Entry[] = [];
    for (const p of part) {
      let a = p.assets - (p.assets * borne + gross - 1n) / gross;
      a -= a % RAO;
      if (a > 0n) entries.push({ user: p.user, amount: a });
    }
    const net = entries.reduce((s, e) => s + e.amount, 0n);
    const messageId = h(`payout message ${o.key} ${n}`);
    const chunkTx = o.chunkTx ?? h(`chunk tx ${o.key} ${n}`);
    const chunkBlock = (o.chunkBlock ?? 6_900_400n) + (o.chunkTx ? 0n : BigInt(n));
    const landTx = o.landTx ?? h(`land tx ${o.key} ${n}`);
    const landBlock = (o.landBlock ?? 37_000_700n) + (o.landTx ? 0n : BigInt(n));
    if (net > 0n) {
      bit.push(
        slog({
          contract: "bitAdapter",
          chain: "bittensor",
          address: D.bitAdapter,
          event: "Sent",
          block: chunkBlock,
          txHash: chunkTx,
          logIndex: ci++,
          topic1: messageId,
          args: { messageId, destChain: "8453", sender: D.vault, recipient: D.frontDoor, amount: String(net), fee: String(fee), gasLimit: "1" },
        }),
      );
    }
    const v32: StoredLog["args"] = charged === undefined ? {} : { charged: String(net === 0n ? 0n : charged), unstakeCost: String(unstakeCost ?? 0n) };
    bit.push(vault("PayoutChunkSent", { key: o.key, chunk: n, taken, gross: String(gross), net: String(net), fee: String(net === 0n ? 0n : fee), ...v32 }, { block: chunkBlock, txHash: chunkTx, logIndex: ci++ }));
    const c: LandedChunk = { chunk: n, net, entries, messageId, chunkTx, landTx };
    if (net > 0n) {
      const fd = (event: string, args: StoredLog["args"]) =>
        slog({ contract: "frontDoor", chain: "base", address: D.frontDoor, event, args, block: landBlock, txHash: landTx, logIndex: li++, topic1: o.key });
      c.landing = fd("PayoutsDelivered", { batchKey: o.key, chunk: n, amount: String(net), bridge });
      base.push(c.landing);
      for (const e of entries) base.push(fd("PayoutReceived", { batchKey: o.key, chunk: n, user: e.user, amount: String(e.amount) }));
      base.push(
        slog({
          contract: "baseAdapter",
          chain: "base",
          address: bridge,
          event: "Delivered",
          block: landBlock,
          txHash: landTx,
          logIndex: li++,
          topic1: messageId,
          args: { messageId, sourceChain: "964", sender: D.vault, recipient: D.frontDoor, amount: String(net) },
        }),
      );
    }
    chunks.push(c);
  });
  return { key: o.key, bit, base, chunks };
}

/** A copy of a log with some args changed. */
export const withArgs = (l: StoredLog, args: StoredLog["args"]): StoredLog => ({ ...l, args: { ...l.args, ...args } });

// v3.2's parks (CcipBittensorAdapter): BatchParked, ParkedConverted, ParkedDelivered, ParkedRefunded, ParkedDropped

/** StakeMissing()'s selector, the reason a vault refusal while stake is missing logs */
export const STAKE_MISSING = keccak256(toBytes("StakeMissing()")).slice(0, 10) as Hex;

/** A Bittensor adapter park event (topic1 the key; BatchParked's and ParkedRefunded's topic2 the message id). */
export function parkLog(
  event: "BatchParked" | "ParkedConverted" | "ParkedDelivered" | "ParkedRefunded" | "ParkedDropped",
  o: { key: Hex; block: bigint; txHash?: Hex; logIndex?: number; adapter?: Hex; messageId?: Hex; amount?: bigint; sender?: Hex; recipient?: Hex; converted?: boolean; reason?: Hex },
): StoredLog {
  const args: StoredLog["args"] =
    event === "BatchParked"
      ? {
          key: o.key,
          messageId: o.messageId ?? h(`park message ${o.key}`),
          recipient: o.recipient ?? D.vault,
          sender: o.sender ?? D.frontDoor,
          amount: String(o.amount ?? 0n),
          converted: o.converted ?? true,
          reason: o.reason ?? STAKE_MISSING,
        }
      : event === "ParkedRefunded"
        ? { key: o.key, messageId: o.messageId ?? h(`refund message ${o.key}`) }
        : { key: o.key };
  return slog({
    contract: "bitAdapter",
    chain: "bittensor",
    address: o.adapter ?? D.bitAdapter,
    event,
    block: o.block,
    txHash: o.txHash ?? h(`${event} tx ${o.key} ${o.block}`),
    logIndex: o.logIndex ?? 0,
    topic1: o.key,
    ...(args.messageId ? { topic2: args.messageId as Hex } : {}),
    args,
  });
}

/** An honest batch that parked (the vault refused it: its ccipReceive logged BatchParked, then Delivered) and was
 * delivered later with deliverParked: that transaction holds the vault's BatchDelivered and outcomes, then the
 * adapter's ParkedDelivered in the place of a Delivered. `parkKey` is the adapter's key for it. */
export function parkedBatch(o: Parameters<typeof honestBatch>[0] & { parkBlock?: bigint }): BatchFixture & { parkKey: Hex; park: StoredLog[] } {
  const b = honestBatch(o);
  const parkKey = parkKeyOf(8453n, D.frontDoor, D.vault, encodeBatchMessage(b.id, b.deposits, b.redeems));
  const total = b.deposits.reduce((s, e) => s + e.amount, 0n);
  const parkBlock = o.parkBlock ?? b.delivery.block - 100n;
  const parkTx = h(`park tx ${b.id}`);
  const park = [
    parkLog("BatchParked", { key: parkKey, block: parkBlock, txHash: parkTx, logIndex: 0, messageId: b.messageId, amount: total }),
    slog({
      contract: "bitAdapter",
      chain: "bittensor",
      address: D.bitAdapter,
      event: "Delivered",
      block: parkBlock,
      txHash: parkTx,
      logIndex: 1,
      topic1: b.messageId,
      args: { messageId: b.messageId, sourceChain: "8453", sender: D.frontDoor, recipient: D.vault, amount: String(total) },
    }),
  ];
  const last = b.bit[b.bit.length - 1];
  const bit = [...b.bit.slice(0, -1), parkLog("ParkedDelivered", { key: parkKey, block: last.block, txHash: last.txHash, logIndex: last.logIndex })];
  return { ...b, bit, parkKey, park };
}
