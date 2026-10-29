import { encodeAbiParameters, type Hex, keccak256 } from "viem";
import type { Deployment } from "../config.ts";
import type { StoredLog } from "../logs.ts";
import type { SnapshotInputs } from "../snapshot.ts";
import type { ChunkCheckRow } from "../store.ts";
import { type DeliveryGroup, pairSent } from "./pairing.ts";
import type { Entry } from "./replay.ts";

// The payout cross-check (spec 6.2, "Payouts, Bittensor → Base"): one landing of a payout chunk on Base
// against the chunk the vault sent, rebuilt from the vault's events (CascadeVault.sol v3.1:
// processPayouts, _takeChunk, _deductFee).

/** One entry of a payout batch as the vault queued it (CascadeMessages.Payout). */
export interface Payout {
  user: Hex;
  shares: bigint;
  assets: bigint;
}

export const PAYOUT_STEPS = {
  bridge: "1: the bridge",
  chunk: "2: the chunk the vault sent",
  message: "3: the bridge message",
  entries: "4: the entries",
  delivered: "5: the front door's delivered record",
} as const;

const RAO = 10n ** 9n;
const big = (x: unknown) => BigInt(String(x ?? "0"));
const lower = (x: unknown) => String(x).toLowerCase() as Hex;
const same = (a: unknown, b: Hex) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const byPosition = (a: StoredLog, b: StoredLog) => (a.block !== b.block ? (a.block < b.block ? -1 : 1) : a.logIndex - b.logIndex);

/** A payout batch's list: its DepositBounced entries (0 shares) first, then its Redeemed entries, each in
 * log order, as ops/src/keeper/payouts.ts rebuildPayouts builds it. */
export function payoutList(vaultLogs: readonly StoredLog[], key: Hex): Payout[] {
  const mine = vaultLogs.filter((l) => l.contract === "vault" && same(l.args.key, key)).sort(byPosition);
  return [
    ...mine.filter((l) => l.event === "DepositBounced").map((l) => ({ user: lower(l.args.user), shares: 0n, assets: big(l.args.assets) })),
    ...mine.filter((l) => l.event === "Redeemed").map((l) => ({ user: lower(l.args.user), shares: big(l.args.shares), assets: big(l.args.assets) })),
  ];
}

/** A chunk's entries as _deductFee sends them: the list's [cursor, cursor + taken), each paid
 * assets − ceil(assets × fee / gross) (at least 0), floored to rao, zeros dropped. */
export function chunkEntries(list: readonly Payout[], cursor: number, taken: number, gross: bigint, fee: bigint): Entry[] {
  return list.slice(cursor, cursor + taken).flatMap((p) => {
    const cut = gross === 0n ? 0n : (p.assets * fee + gross - 1n) / gross;
    let a = p.assets > cut ? p.assets - cut : 0n;
    a -= a % RAO;
    return a > 0n ? [{ user: p.user, amount: a }] : [];
  });
}

const ENTRIES = { type: "tuple[]", components: [{ name: "user", type: "address" }, { name: "amount", type: "uint256" }] } as const;

/** CascadeMessages.encodePayouts: abi.encode(uint8 2, bytes32 key, uint32 chunk, Entry[] entries). */
export const encodePayoutsMessage = (key: Hex, chunk: number, entries: readonly Entry[]): Hex =>
  encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }, { type: "uint32" }, ENTRIES], [2, key, chunk, entries]);

/** The front door's delivered(bridge, hash) reads the next reading makes: one per landing awaiting it. */
export function deliveredChecks(rows: readonly ChunkCheckRow[]): SnapshotInputs["deliveredChecks"] {
  return rows.flatMap((r) =>
    r.status === "awaiting_read" && r.expectedHash && r.bridge ? [{ landedUid: r.landedUid, key: r.batchKey, chunk: r.chunk, bridge: r.bridge, hash: r.expectedHash }] : [],
  );
}

export interface PayoutVerdict {
  status: "awaiting_read" | "mismatch";
  step?: string;
  detail?: string;
  sentTx?: Hex;
  messageId?: Hex;
  expectedHash?: Hex;
}

/** Checks one landing (its PayoutsDelivered, and the group of its transaction it opens) through step 4;
 * passing, it awaits step 5, the front door's delivered() read. Call it once Bittensor is settled past
 * the landing's time. */
export function checkPayout(i: {
  d: Pick<Deployment, "frontDoor" | "vault">;
  /** the Base bridges a payout may arrive through (BRIDGES.base) */
  bridges: readonly Hex[];
  landing: StoredLog;
  group: DeliveryGroup | undefined;
  /** the vault's logs of the key (its outcomes and chunks), at least */
  vaultLogs: readonly StoredLog[];
  /** a Bittensor transaction's logs */
  bitTx: (hash: Hex) => StoredLog[];
}): PayoutVerdict {
  const { d, landing, group } = i;
  const key = lower(landing.args.batchKey);
  const chunk = Number(landing.args.chunk);
  const amount = big(landing.args.amount);
  const fail = (step: string, detail: string, extra: Partial<PayoutVerdict> = {}): PayoutVerdict => ({ status: "mismatch", step, detail, ...extra });

  // 1. through one of our Base bridges
  if (!i.bridges.some((b) => same(landing.args.bridge, b))) return fail(PAYOUT_STEPS.bridge, `bridge ${landing.args.bridge} isn't in BRIDGES`);

  // 2. exactly one PayoutChunkSent(key, chunk), whose net is the landed amount and above 0
  const sends = i.vaultLogs.filter((l) => l.event === "PayoutChunkSent" && same(l.args.key, key));
  const mine = sends.filter((l) => Number(l.args.chunk) === chunk);
  if (mine.length !== 1) return fail(PAYOUT_STEPS.chunk, `${mine.length} PayoutChunkSent for chunk ${chunk} of ${key}`);
  const sent = mine[0];
  const sentTx = sent.txHash;
  const net = big(sent.args.net);
  if (net === 0n) return fail(PAYOUT_STEPS.chunk, `chunk ${chunk} sent nothing (net 0)`, { sentTx });
  if (net !== amount) return fail(PAYOUT_STEPS.chunk, `landed amount ${amount}, the chunk's net ${net}`, { sentTx });

  // 3. the group's Delivered has the message id of the Sent paired with the chunk, both vault → front door
  const adapterSent = pairSent(i.bitTx(sent.txHash), { closer: "vault:PayoutChunkSent", adapter: "bitAdapter", sender: d.vault }).get(sent.uid);
  if (!adapterSent) return fail(PAYOUT_STEPS.message, "no Bittensor adapter Sent from the vault paired with the chunk", { sentTx });
  const messageId = lower(adapterSent.args.messageId);
  const dl = group?.delivered;
  if (!group || !dl) return fail(PAYOUT_STEPS.message, "no Base adapter Delivered to the front door closes the landing", { sentTx, messageId });
  if (!same(dl.args.messageId, messageId)) return fail(PAYOUT_STEPS.message, `message id ${dl.args.messageId} delivered, ${messageId} sent`, { sentTx, messageId });
  const route = (l: StoredLog) => same(l.args.sender, d.vault) && same(l.args.recipient, d.frontDoor);
  if (!route(adapterSent) || !route(dl)) return fail(PAYOUT_STEPS.message, "the Sent or the Delivered doesn't name vault → front door", { sentTx, messageId });

  // 4. the PayoutReceived list (this key and chunk) is the chunk rebuilt from the vault
  let cursor = 0;
  for (let n = 0; n < chunk; n++) {
    const earlier = sends.filter((l) => Number(l.args.chunk) === n);
    if (earlier.length !== 1) return fail(PAYOUT_STEPS.entries, `${earlier.length} PayoutChunkSent for earlier chunk ${n}: can't place chunk ${chunk}`, { sentTx, messageId });
    cursor += Number(earlier[0].args.taken);
  }
  const list = payoutList(i.vaultLogs, key);
  const taken = Number(sent.args.taken);
  if (cursor + taken > list.length) return fail(PAYOUT_STEPS.entries, `entries ${cursor}–${cursor + taken - 1} of a list of ${list.length}`, { sentTx, messageId });
  const entries = chunkEntries(list, cursor, taken, big(sent.args.gross), big(sent.args.fee));
  const sum = entries.reduce((s, e) => s + e.amount, 0n);
  if (sum !== net) return fail(PAYOUT_STEPS.entries, `the rebuilt entries pay ${sum}, the chunk's net ${net}`, { sentTx, messageId });
  const received = group.events.filter((e) => e.event === "PayoutReceived" && same(e.args.batchKey, key) && Number(e.args.chunk) === chunk);
  if (received.length !== entries.length) return fail(PAYOUT_STEPS.entries, `${received.length} PayoutReceived, ${entries.length} entries rebuilt`, { sentTx, messageId });
  for (const [n, e] of entries.entries()) {
    const r = received[n];
    if (!same(r.args.user, e.user) || big(r.args.amount) !== e.amount) {
      return fail(PAYOUT_STEPS.entries, `entry ${n}: ${r.args.user} paid ${r.args.amount}, rebuilt ${e.user} with ${e.amount}`, { sentTx, messageId });
    }
  }
  return { status: "awaiting_read", sentTx, messageId, expectedHash: keccak256(encodePayoutsMessage(key, chunk, entries)) };
}
