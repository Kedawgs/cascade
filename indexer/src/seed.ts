import type { Hex } from "viem";
import type { Deployment } from "./config.ts";
import type { StoredLog } from "./logs.ts";

// The site's vault-scan seed (spec sections 3.4 and 4). Pure: the API, the tick and the fixture writer
// all build the halves with these functions. No Workers types here, so Node scripts can import it.

/** The site's saved and seedable scan (web/src/lib/cascade/scan-store.ts, ScanState v1): numbers as
 * decimal strings, the vault lowercase, every event in [from, next). */
export interface ScanState {
  v: 1;
  vault: string;
  from: string;
  next: string;
  delivered: { batchId: string; key: Hex; txHash: Hex; block: string }[];
  staked: { block: string; txHash: Hex }[];
  payouts: { key: Hex; chunk: number; taken: number; txHash: Hex; block: string }[];
  deposited: AccountEvent[];
  redeemed: AccountEvent[];
}

export interface AccountEvent {
  key: Hex;
  txHash: Hex;
  block: string;
  assets: string;
}

/** One event of the deployment-wide half, as kept in the seed pages. */
export type SeedEvent =
  | { kind: "delivered"; batchId: string; key: Hex; txHash: Hex; block: string }
  | { kind: "staked"; block: string; txHash: Hex }
  | { kind: "payout"; key: Hex; chunk: number; taken: number; txHash: Hex; block: string };

/** A row of `seed_pages`. */
export interface SeedPage {
  page: number;
  firstBlock: bigint;
  lastBlock: bigint;
  count: number;
  json: string;
}

export const PAGE_SIZE = 500;

const byPosition = (a: StoredLog, b: StoredLog) => (a.block !== b.block ? (a.block < b.block ? -1 : 1) : a.logIndex - b.logIndex);
const BASE_CHAIN_ID = "8453";

/** The deployment-wide seed events among `logs`, in log order: the vault's BatchDelivered from our front
 * door on Base (as the site's scan keeps them), every vault Staked and every PayoutChunkSent. Removed
 * logs never. */
export function seedEventsOf(logs: readonly StoredLog[], d: Pick<Deployment, "frontDoor">): SeedEvent[] {
  const out: SeedEvent[] = [];
  for (const l of [...logs].sort(byPosition)) {
    if (l.removed || l.chain !== "bittensor" || l.contract !== "vault") continue;
    const block = String(l.block);
    if (l.event === "BatchDelivered") {
      if (l.args.sourceChain !== BASE_CHAIN_ID || l.args.frontDoor !== d.frontDoor.toLowerCase()) continue;
      out.push({ kind: "delivered", batchId: String(l.args.batchId), key: l.args.key as Hex, txHash: l.txHash, block });
    } else if (l.event === "Staked") {
      out.push({ kind: "staked", block, txHash: l.txHash });
    } else if (l.event === "PayoutChunkSent") {
      out.push({ kind: "payout", key: l.args.key as Hex, chunk: Number(l.args.chunk), taken: Number(l.args.taken), txHash: l.txHash, block });
    }
  }
  return out;
}

function pagesFrom(first: number, events: readonly SeedEvent[], pageSize: number): SeedPage[] {
  const out: SeedPage[] = [];
  for (let i = 0; i < events.length; i += pageSize) {
    const part = events.slice(i, i + pageSize);
    out.push({ page: first + out.length, firstBlock: BigInt(part[0].block), lastBlock: BigInt(part[part.length - 1].block), count: part.length, json: JSON.stringify(part) });
  }
  return out;
}

/** The page rows to write when `events` (newly settled, after everything paged so far) are added: the
 * last page filled up to `pageSize`, then new pages. */
export function appendPages(lastPage: { page: number; events: SeedEvent[] } | null, events: readonly SeedEvent[], pageSize = PAGE_SIZE): SeedPage[] {
  if (events.length === 0) return [];
  if (!lastPage || lastPage.events.length >= pageSize) return pagesFrom(lastPage ? lastPage.page + 1 : 0, events, pageSize);
  const room = pageSize - lastPage.events.length;
  return [...pagesFrom(lastPage.page, [...lastPage.events, ...events.slice(0, room)], pageSize), ...pagesFrom(lastPage.page + 1, events.slice(room), pageSize)];
}

/** Every page, from all the seed events (after a log was removed or re-mined). */
export const rebuildPages = (events: readonly SeedEvent[], pageSize = PAGE_SIZE): SeedPage[] => pagesFrom(0, events, pageSize);

const inRange = (from: bigint, next: bigint) => (e: { block: string }) => BigInt(e.block) >= from && BigInt(e.block) < next;

/** The deployment-wide half: what the site's store saves under the front door and deploy block, with the
 * account lists empty. Only events in [from, next). */
export function sharedHalf(o: { vault: Hex; from: bigint; next: bigint; events: readonly SeedEvent[] }): ScanState {
  const events = o.events.filter(inRange(o.from, o.next));
  return {
    v: 1,
    vault: o.vault.toLowerCase(),
    from: String(o.from),
    next: String(o.next),
    delivered: events.flatMap((e) => (e.kind === "delivered" ? [{ batchId: e.batchId, key: e.key, txHash: e.txHash, block: e.block }] : [])),
    staked: events.flatMap((e) => (e.kind === "staked" ? [{ block: e.block, txHash: e.txHash }] : [])),
    payouts: events.flatMap((e) => (e.kind === "payout" ? [{ key: e.key, chunk: e.chunk, taken: e.taken, txHash: e.txHash, block: e.block }] : [])),
    deposited: [],
    redeemed: [],
  };
}

/** One account's half: its Deposited and Redeemed, with the deployment lists empty. Only events in
 * [from, next). */
export function accountHalf(o: { vault: Hex; from: bigint; next: bigint; deposited: readonly AccountEvent[]; redeemed: readonly AccountEvent[] }): ScanState {
  const keep = inRange(o.from, o.next);
  const plain = (e: AccountEvent): AccountEvent => ({ key: e.key, txHash: e.txHash, block: e.block, assets: e.assets });
  return {
    v: 1,
    vault: o.vault.toLowerCase(),
    from: String(o.from),
    next: String(o.next),
    delivered: [],
    staked: [],
    payouts: [],
    deposited: o.deposited.filter(keep).map(plain),
    redeemed: o.redeemed.filter(keep).map(plain),
  };
}
