import { type Hex, hexToNumber, numberToHex } from "viem";
import { ADMIN_EVENTS } from "./abi.ts";
import type { ChainName, Role } from "./config.ts";
import type { StoredLog } from "./logs.ts";
import type { Rpc } from "./rpc.ts";
import type { TxRow } from "./store.ts";

/** At most this many block headers, and this many transactions, are read per chain per tick; the rest
 * wait for the next. */
export const PER_TICK = 20;

/** Events only a few addresses can cause, and every admin event: their transactions are fetched (spec
 * 3.3), so a watched key's transactions can be counted. */
export const ATTRIBUTABLE: ReadonlySet<`${Role}:${string}`> = new Set([
  "frontDoor:BatchClosed",
  "frontDoor:BatchRolled",
  "frontDoor:Delivered",
  "vault:PayoutChunkSent",
  "vault:Staked",
  "vault:RewardsClaimed",
  "vault:HotkeyAdded",
  ...ADMIN_EVENTS,
]);

/** Events that name their caller (msg.sender) in their arguments: the transaction's sender for an
 * account, or the contract in between (not watched) otherwise. */
const SENDER_ARG: Readonly<Record<string, string>> = {
  "frontDoor:DepositRequested": "payer",
  "frontDoor:FeeCredited": "payer",
  "frontDoor:RedeemRequested": "user",
  "frontDoor:RedeemCancelled": "user",
  "frontDoor:DepositCancelled": "user",
  "frontDoor:Claimed": "user",
  "frontDoor:DeliverySet": "user",
  "staker:Staked": "payer",
  "bitAdapter:ReserveFunded": "from",
};

/** The caller an event names in its arguments, if it names one. */
export function senderFromArgs(log: Pick<StoredLog, "contract" | "event" | "args">): Hex | undefined {
  const arg = SENDER_ARG[`${log.contract}:${log.event}`];
  const v = arg === undefined ? undefined : log.args[arg];
  return typeof v === "string" && /^0x[0-9a-f]{40}$/.test(v) ? (v as Hex) : undefined;
}

/** Transaction rows known from events' arguments, without a fetch (the sender only). */
export function argSenders(logs: readonly StoredLog[]): TxRow[] {
  return logs.flatMap((l) => {
    const from = senderFromArgs(l);
    return from ? [{ chain: l.chain, hash: l.txHash, from }] : [];
  });
}

/** The transactions behind attributable events, each once, in log order. */
export function txsToFetch(logs: readonly StoredLog[]): { chain: ChainName; hash: Hex }[] {
  const seen = new Set<string>();
  const out: { chain: ChainName; hash: Hex }[] = [];
  for (const l of logs) {
    if (!ATTRIBUTABLE.has(`${l.contract}:${l.event}`)) continue;
    const id = `${l.chain}:${l.txHash}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ chain: l.chain, hash: l.txHash });
  }
  return out;
}

/** The times of up to PER_TICK blocks (the oldest first), in one batched request. A block the node
 * doesn't have yet is left out, to be asked again. */
export async function blockTimes(rpc: Rpc, chain: ChainName, numbers: readonly bigint[]): Promise<Map<bigint, number>> {
  const wanted = [...new Set(numbers)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, PER_TICK);
  const out = new Map<bigint, number>();
  if (wanted.length === 0) return out;
  const blocks = await rpc.batch(
    chain,
    wanted.map((n) => ({ method: "eth_getBlockByNumber", params: [numberToHex(n), false] })),
  );
  blocks.forEach((b, i) => {
    const t = (b as { timestamp?: Hex } | null)?.timestamp;
    if (t) out.set(wanted[i], hexToNumber(t));
  });
  return out;
}

/** Up to PER_TICK transactions' senders, in one batched request: from, to, the input's 4-byte selector
 * and the nonce, lowercase. One the node doesn't return is left out. */
export async function fetchTxs(rpc: Rpc, chain: ChainName, hashes: readonly Hex[]): Promise<TxRow[]> {
  const wanted = [...new Set(hashes.map((h) => h.toLowerCase() as Hex))].slice(0, PER_TICK);
  if (wanted.length === 0) return [];
  const txs = await rpc.batch(
    chain,
    wanted.map((h) => ({ method: "eth_getTransactionByHash", params: [h] })),
  );
  return txs.flatMap((t, i) => {
    const x = t as { from?: Hex; to?: Hex | null; input?: Hex; nonce?: Hex } | null;
    if (!x?.from) return [];
    const row: TxRow = { chain, hash: wanted[i], from: x.from.toLowerCase() as Hex };
    if (x.to) row.to = x.to.toLowerCase() as Hex;
    if (x.input && x.input.length >= 10) row.selector = x.input.slice(0, 10).toLowerCase() as Hex;
    if (x.nonce) row.nonce = hexToNumber(x.nonce);
    return [row];
  });
}
