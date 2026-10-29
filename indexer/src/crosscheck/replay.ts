import { encodeAbiParameters, type Hex, keccak256 } from "viem";
import type { StoredLog } from "../logs.ts";

// Rebuilding a closed batch's message from the front door's events, as CascadeFrontDoor.sol builds it
// (contracts/src, tagged v3.1): a deposit adds to the user's entry or appends one; a cancel reduces it,
// and a full cancel moves the last entry into the freed slot (_reduce, swap-and-pop) and frees the
// user's slot, so their next request appends. A request on a full redeem list closes the batch first
// (BatchClosed(id)) and lands in the next one (RedeemRequested(id + 1)), so the events of one batch id
// are the batch: no request of it can follow its close.

/** CascadeMessages.Entry */
export interface Entry {
  user: Hex;
  amount: bigint;
}

export interface Replayed {
  deposits: Entry[];
  redeems: Entry[];
  /** the batch's BatchClosed */
  closed: StoredLog;
}

const byPosition = (a: StoredLog, b: StoredLog) => (a.block !== b.block ? (a.block < b.block ? -1 : 1) : a.logIndex - b.logIndex);
const big = (x: unknown) => BigInt(String(x));
const lower = (x: unknown) => String(x).toLowerCase() as Hex;

function add(list: Entry[], user: Hex, amount: bigint): void {
  const e = list.find((x) => x.user === user);
  if (e) e.amount += amount;
  else list.push({ user, amount });
}

function reduce(list: Entry[], user: Hex, amount: bigint): string | undefined {
  const i = list.findIndex((x) => x.user === user);
  if (i < 0) return `a cancel of ${amount} by ${user}, which has no entry`;
  const have = list[i].amount;
  if (amount > have) return `a cancel of ${amount} by ${user}, more than its ${have}`;
  if (amount < have) {
    list[i].amount = have - amount;
    return undefined;
  }
  const last = list.length - 1;
  if (i !== last) list[i] = list[last];
  list.pop();
  return undefined;
}

/** The deposit and redeem lists batch `batchId` closed with, rebuilt from the front door's logs (in log
 * order; others are ignored), or why they can't be. */
export function replayBatch(frontDoorLogs: readonly StoredLog[], batchId: bigint): Replayed | { error: string } {
  const deposits: Entry[] = [];
  const redeems: Entry[] = [];
  let closed: StoredLog | undefined;
  for (const l of [...frontDoorLogs].sort(byPosition)) {
    if (l.contract !== "frontDoor") continue;
    const id = l.event === "BatchClosed" || l.event === "BatchRolled" ? l.args.id : l.args.batchId;
    if (id === undefined || big(id) !== batchId) continue;
    if (closed) return { error: `a ${l.event} of batch ${batchId} after its close (block ${l.block})` };
    let err: string | undefined;
    switch (l.event) {
      case "DepositRequested":
        add(deposits, lower(l.args.user), big(l.args.amount));
        break;
      case "DepositCancelled":
        err = reduce(deposits, lower(l.args.user), big(l.args.amount));
        break;
      case "RedeemRequested":
        add(redeems, lower(l.args.user), big(l.args.shares));
        break;
      case "RedeemCancelled":
        err = reduce(redeems, lower(l.args.user), big(l.args.shares));
        break;
      case "BatchRolled":
        // an empty batch restarts its timer and keeps its id
        if (deposits.length || redeems.length) err = `batch ${batchId} rolled with entries in it (block ${l.block})`;
        break;
      case "BatchClosed":
        closed = l;
        break;
    }
    if (err) return { error: err };
  }
  if (!closed) return { error: `batch ${batchId} is not closed in its front door logs` };
  const total = deposits.reduce((s, e) => s + e.amount, 0n);
  if (big(closed.args.totalDeposits) !== total) return { error: `totalDeposits ${closed.args.totalDeposits} in BatchClosed, ${total} replayed` };
  if (big(closed.args.nDeposits) !== BigInt(deposits.length)) return { error: `nDeposits ${closed.args.nDeposits} in BatchClosed, ${deposits.length} replayed` };
  if (big(closed.args.nRedeems) !== BigInt(redeems.length)) return { error: `nRedeems ${closed.args.nRedeems} in BatchClosed, ${redeems.length} replayed` };
  return { deposits, redeems, closed };
}

const ENTRIES = { type: "tuple[]", components: [{ name: "user", type: "address" }, { name: "amount", type: "uint256" }] } as const;

/** CascadeMessages.encodeBatch: abi.encode(uint8 1, uint64 batchId, Entry[] deposits, Entry[] redeems). */
export const encodeBatchMessage = (batchId: bigint, deposits: readonly Entry[], redeems: readonly Entry[]): Hex =>
  encodeAbiParameters([{ type: "uint8" }, { type: "uint64" }, ENTRIES, ENTRIES], [1, batchId, deposits, redeems]);

/** CascadeVault.batchKey: keccak256(abi.encode(uint64 sourceChain, address sender, keccak256(message))). */
export const batchKey = (sourceChain: bigint, sender: Hex, message: Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }, { type: "bytes32" }], [sourceChain, sender, keccak256(message)]));
