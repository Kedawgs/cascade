import type { Hex } from "viem";
import type { StoredLog } from "./logs.ts";

// v3.2's redeem origins (spec §3.4, Task 18): the chain a holder's shares may leave by. Only setRedeemOrigin logs an
// event of its own (RedeemOriginSet); the other two writes are fully determined by their own events and the state
// before them (CascadeEvents.sol): a door's Deposited of non-zero assets sets an origin of 0 to that door's chain,
// and DepositedDirect sets DIRECT_ORIGIN. A bounce, and an entry below a rao (Deposited of 0 assets), write none.

/** CascadeConstants.sol DIRECT_ORIGIN: a holder who deposited (or chose to redeem) directly on Bittensor. */
export const DIRECT_ORIGIN = 2n ** 64n - 1n;

const byPosition = (a: StoredLog, b: StoredLog) => (a.block !== b.block ? (a.block < b.block ? -1 : 1) : a.logIndex - b.logIndex);
const lower = (x: unknown) => String(x).toLowerCase() as Hex;

/** Each user's redeem origin after these vault logs (any order: they are put in log order), from the origins known
 * before them (`before`, 0 for anyone not in it). A Deposited takes its chain from its batch's BatchDelivered (the
 * same key), which the vault logs first, in the same transaction. Users whose origin stays 0 are left out. */
export function redeemOrigins(logs: readonly StoredLog[], before: ReadonlyMap<Hex, bigint> = new Map()): Map<Hex, bigint> {
  const out = new Map(before);
  const chainOf = new Map<string, bigint>();
  for (const l of [...logs].filter((x) => x.contract === "vault").sort(byPosition)) {
    if (l.event === "BatchDelivered") chainOf.set(lower(l.args.key), BigInt(String(l.args.sourceChain)));
    else if (l.event === "Deposited") {
      const chain = chainOf.get(lower(l.args.key));
      const user = lower(l.args.user);
      if (chain !== undefined && BigInt(String(l.args.assets)) > 0n && (out.get(user) ?? 0n) === 0n) out.set(user, chain);
    } else if (l.event === "DepositedDirect") out.set(lower(l.args.user), DIRECT_ORIGIN);
    else if (l.event === "RedeemOriginSet") out.set(lower(l.args.user), BigInt(String(l.args.chain)));
  }
  return out;
}
