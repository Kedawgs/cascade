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

/** A row of `seed_pages`: its events pre-split into the shared half's three lists, each a JSON fragment
 * (the list's elements joined by commas, without the brackets), so serving the half joins strings
 * rather than parsing every page. */
export interface SeedPage {
  page: number;
  firstBlock: bigint;
  lastBlock: bigint;
  count: number;
  delivered: string;
  staked: string;
  payouts: string;
}

type Lists = Pick<ScanState, "delivered" | "staked" | "payouts">;

/** The shared half's list elements, key order as the site's store writes them. */
const deliveredOf = (e: Extract<SeedEvent, { kind: "delivered" }>): ScanState["delivered"][number] => ({ batchId: e.batchId, key: e.key, txHash: e.txHash, block: e.block });
const stakedOf = (e: Extract<SeedEvent, { kind: "staked" }>): ScanState["staked"][number] => ({ block: e.block, txHash: e.txHash });
const payoutOf = (e: Extract<SeedEvent, { kind: "payout" }>): ScanState["payouts"][number] => ({ key: e.key, chunk: e.chunk, taken: e.taken, txHash: e.txHash, block: e.block });

function listsOf(events: readonly SeedEvent[]): Lists {
  return {
    delivered: events.flatMap((e) => (e.kind === "delivered" ? [deliveredOf(e)] : [])),
    staked: events.flatMap((e) => (e.kind === "staked" ? [stakedOf(e)] : [])),
    payouts: events.flatMap((e) => (e.kind === "payout" ? [payoutOf(e)] : [])),
  };
}

/** A list's JSON without its brackets. */
const fragment = (xs: readonly unknown[]) => xs.map((x) => JSON.stringify(x)).join(",");
const parseFragment = <T>(f: string): T[] => (f === "" ? [] : (JSON.parse(`[${f}]`) as T[]));

/** A page's events again (for appending to it), in block order, grouped by kind within a block. */
export function pageEvents(p: Pick<SeedPage, "delivered" | "staked" | "payouts">): SeedEvent[] {
  const events: SeedEvent[] = [
    ...parseFragment<ScanState["delivered"][number]>(p.delivered).map((e): SeedEvent => ({ kind: "delivered", ...e })),
    ...parseFragment<ScanState["staked"][number]>(p.staked).map((e): SeedEvent => ({ kind: "staked", ...e })),
    ...parseFragment<ScanState["payouts"][number]>(p.payouts).map((e): SeedEvent => ({ kind: "payout", ...e })),
  ];
  // a stable sort keeps each kind's own order
  return events.sort((a, b) => (BigInt(a.block) < BigInt(b.block) ? -1 : BigInt(a.block) > BigInt(b.block) ? 1 : 0));
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
    const lists = listsOf(part);
    out.push({
      page: first + out.length,
      firstBlock: BigInt(part[0].block),
      lastBlock: BigInt(part[part.length - 1].block),
      count: part.length,
      delivered: fragment(lists.delivered),
      staked: fragment(lists.staked),
      payouts: fragment(lists.payouts),
    });
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
  return {
    v: 1,
    vault: o.vault.toLowerCase(),
    from: String(o.from),
    next: String(o.next),
    ...listsOf(o.events.filter(inRange(o.from, o.next))),
    deposited: [],
    redeemed: [],
  };
}

/** The shared half as JSON, byte for byte JSON.stringify(sharedHalf(...)) of the pages' events, built from
 * the pages' fragments: a page wholly inside [from, next) is joined as it is (never parsed, so serving a
 * long history costs little CPU); only a page across an edge is parsed and filtered. */
export function sharedHalfJson(o: { vault: Hex; from: bigint; next: bigint; pages: readonly SeedPage[] }): string {
  const parts: Record<keyof Lists, string[]> = { delivered: [], staked: [], payouts: [] };
  const keep = inRange(o.from, o.next);
  for (const p of o.pages) {
    if (p.count === 0 || p.lastBlock < o.from || p.firstBlock >= o.next) continue;
    const whole = p.firstBlock >= o.from && p.lastBlock < o.next;
    for (const k of ["delivered", "staked", "payouts"] as const) {
      const f = whole ? p[k] : fragment(parseFragment<{ block: string }>(p[k]).filter(keep));
      if (f !== "") parts[k].push(f);
    }
  }
  const head = JSON.stringify({ v: 1, vault: o.vault.toLowerCase(), from: String(o.from), next: String(o.next) }).slice(0, -1);
  return `${head},"delivered":[${parts.delivered.join(",")}],"staked":[${parts.staked.join(",")}],"payouts":[${parts.payouts.join(",")}],"deposited":[],"redeemed":[]}`;
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
