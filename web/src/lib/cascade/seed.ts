import { type Address, type Hex, parseEventLogs } from "viem";
import { VAULT } from "./abi";
import type { Clients } from "./chain";
import type { Deployment } from "./config";
import {
  type AccountEvent,
  chunkIn,
  deliveryIn,
  HistoryMismatchError,
  type RawLog,
  type Receipt,
  receiptAt,
  REREAD,
  stakedIn,
  type VaultScan,
  windowLogs,
  ZERO_KEY,
} from "./facts";
import type { SeedHalves } from "./indexer";
import { type DecodedScanState, decodeScanState } from "./scan-store";

// How the site checks the history indexer's seed against the chain before it uses any of it, and goes
// on checking after (spec section 5, and the owner's rule: no figure or step from the seed until the
// chain has confirmed it). Everything here reads the chain; the only writes are confirmations on the
// scan's entries once a window matched, and checkSeededHistory's throw, which the caller acts on.

/** A scan this far behind the chain's head asks the indexer first: below it, reading the windows itself
 * costs about what verifying a seed costs. */
export const SEED_MIN_BLOCKS = 7_200n;
/** A seed whose settled block is further behind the head than this (two hours of 12-second blocks) is
 * stale: the indexer isn't keeping up, and the scan reads the chain itself. */
export const SEED_MAX_LAG = 600n;
/** How many of a seed's events, chosen at random, are checked against their receipts before it is used:
 * a bug detector, never the proof (every event is still confirmed before it is used). */
export const SEED_SAMPLE = 8;
/** The most entries one batch message carries of each kind (CascadeMessages.MAX_ENTRIES; the front door
 * refuses a maxDeposits or maxRedeems above it). */
const MAX_ENTRIES = 100;
/** A batch's payout list holds its bounced deposits and its redeems, at most MAX_ENTRIES of each, and
 * every chunk takes at least one entry (CascadeVault._takeChunk): more chunks for one batch than this is
 * a shape no chain can have. */
export const MAX_SEED_CHUNKS_PER_KEY = 2 * MAX_ENTRIES;
/** The account's events that belong to no delivery of the seed's (direct deposits and redeems, reward
 * cuts: the indexer's first seed form carries none, a later one may), past which a seed isn't used: an
 * honest account can have more, so it is read from the chain instead, with no blame. A batch's events
 * have their own bound (each delivery carries at most one deposit and one redeem of the account's). */
export const MAX_SEED_ACCOUNT_EVENTS_EXTRA = 50;
/** The most events both halves may hold together and still be checked here: under the 2 MB a half may
 * weigh (indexer.ts) at the keeper's fastest cadence (a batch an hour: a delivery, a stake and a chunk,
 * about 450 bytes) that is roughly six months of a deployment, years at the launch's. An honest history
 * past it is read from the chain instead, with no blame. */
export const MAX_SEED_EVENTS = 50_000;

const WINDOW = 1_000n;
const BASE_CHAIN_ID = 8453n;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const asBig = (x: unknown): bigint => (typeof x === "bigint" ? x : BigInt(x as string));

/** What a window of the vault's logs holds, as the scan keeps it: our front door's deliveries from Base,
 * every stake and payout chunk, and the account's own events: Deposited and Redeemed (and the direct
 * ones, `kind: "direct"`), and the adjustments that move its shares otherwise (a reversed redeem, a
 * reward cut minted to it). */
export interface WindowEvents {
  delivered: { batchId: string; key: Hex; txHash: Hex; block: bigint }[];
  staked: { block: bigint; txHash: Hex }[];
  payouts: { key: Hex; chunk: number; taken: number; txHash: Hex; block: bigint }[];
  deposited: AccountEvent[];
  redeemed: AccountEvent[];
  adjustments: AccountEvent[];
  /** The account's entries in deliveries that moved no shares (a bounced, skipped or deferred entry), by
   * batch key: each one's delivery must be in the scan. */
  entries: { key: Hex; block: bigint; txHash: Hex }[];
}

/** The events in `raw` the scan would keep (the same rules as scanVault), from a node's raw logs (hex
 * numbers) or viem's formatted ones alike. */
export function vaultEvents(raw: RawLog[], d: Deployment, account: Address): WindowEvents {
  const out: WindowEvents = { delivered: [], staked: [], payouts: [], deposited: [], redeemed: [], adjustments: [], entries: [] };
  for (const l of parseEventLogs({ abi: VAULT, logs: raw as never, strict: false })) {
    if (!same(l.address, d.vault)) continue;
    const block = asBig(l.blockNumber);
    const txHash = l.transactionHash as Hex;
    const mine = (user: unknown) => typeof user === "string" && same(user, account);
    const a = l.args as Record<string, unknown>;
    switch (l.eventName) {
      case "BatchDelivered":
        if (a.sourceChain === BASE_CHAIN_ID && mine(a.frontDoor) === false && typeof a.frontDoor === "string" && same(a.frontDoor, d.frontDoor)) {
          out.delivered.push({ batchId: String(a.batchId), key: a.key as Hex, txHash, block });
        }
        break;
      case "Staked":
        out.staked.push({ block, txHash });
        break;
      case "PayoutChunkSent":
        out.payouts.push({ key: a.key as Hex, chunk: Number(a.chunk), taken: Number(a.taken), txHash, block });
        break;
      case "Deposited":
        if (mine(a.user)) out.deposited.push({ key: a.key as Hex, txHash, block, assets: a.assets as bigint, shares: a.shares as bigint });
        break;
      case "Redeemed":
        if (mine(a.user)) out.redeemed.push({ key: a.key as Hex, txHash, block, assets: a.assets as bigint, shares: a.shares as bigint });
        break;
      case "DepositedDirect":
        if (mine(a.user)) out.deposited.push({ key: ZERO_KEY, txHash, block, assets: a.assets as bigint, shares: a.shares as bigint, kind: "direct" });
        break;
      case "RedeemedDirect":
        if (mine(a.user)) out.redeemed.push({ key: ZERO_KEY, txHash, block, assets: a.assets as bigint, shares: a.shares as bigint, kind: "direct" });
        break;
      case "RedeemReversed":
        if (mine(a.user)) out.adjustments.push({ key: a.key as Hex, txHash, block, assets: a.assets as bigint, shares: a.shares as bigint, kind: "reversed" });
        break;
      case "RewardCutMinted":
        if (mine(a.treasury)) out.adjustments.push({ key: ZERO_KEY, txHash, block, assets: a.assets as bigint, shares: a.shares as bigint, kind: "cut" });
        break;
      case "DepositBounced":
      case "DepositSkipped":
      case "RedeemSkipped":
      case "RedeemDeferred":
        if (mine(a.user)) out.entries.push({ key: a.key as Hex, block, txHash });
        break;
    }
  }
  return out;
}

type Kind = "delivered" | "staked" | "payouts" | "deposited" | "redeemed" | "adjustments";
const SHARED_KINDS: Kind[] = ["delivered", "staked", "payouts"];
const ACCOUNT_KINDS: Kind[] = ["deposited", "redeemed", "adjustments"];
type Ev = WindowEvents[Kind][number];

/** An event's identity, as the comparison sees it: everything the seed states about it. */
function idOf(kind: Kind, e: Ev): string {
  switch (kind) {
    case "delivered": {
      const x = e as WindowEvents["delivered"][number];
      return `delivered:${x.batchId}:${x.key}:${x.txHash}:${x.block}`.toLowerCase();
    }
    case "staked": {
      const x = e as WindowEvents["staked"][number];
      return `staked:${x.txHash}:${x.block}`.toLowerCase();
    }
    case "payouts": {
      const x = e as WindowEvents["payouts"][number];
      return `payout:${x.key}:${x.chunk}:${x.taken}:${x.txHash}:${x.block}`.toLowerCase();
    }
    default: {
      const x = e as AccountEvent;
      return `${kind}:${x.kind ?? "batch"}:${x.key}:${x.txHash}:${x.block}:${x.assets}`.toLowerCase();
    }
  }
}

type Tagged = { kind: Kind; e: Ev; id: string };
const tagged = (w: Omit<WindowEvents, "entries">, kinds: Kind[] = [...SHARED_KINDS, ...ACCOUNT_KINDS]): Tagged[] =>
  kinds.flatMap((kind) => (w[kind] as Ev[]).map((e) => ({ kind, e, id: idOf(kind, e) })));
const within = (from: bigint, to: bigint) => (t: Tagged) => t.e.block >= from && t.e.block <= to;

/** Whether `r` is a receipt showing `t` (the vault's event, as the seed states it, at its block). */
function shows(r: Receipt | null, d: Deployment, account: Address, t: Tagged): boolean {
  if (r?.status !== "success") return false;
  if (r.blockNumber !== undefined && r.blockNumber !== t.e.block) return false;
  switch (t.kind) {
    case "delivered": {
      const x = t.e as WindowEvents["delivered"][number];
      return deliveryIn(r, d, x.batchId, x.key);
    }
    case "staked":
      return stakedIn(r, d);
    case "payouts": {
      const x = t.e as WindowEvents["payouts"][number];
      return chunkIn(r, d, x.key, x.chunk, x.taken);
    }
    default: {
      const x = t.e as AccountEvent;
      return vaultEvents(r.logs, d, account)[t.kind].some((e) => same(e.key, x.key) && same(e.txHash, x.txHash) && (e.kind ?? "batch") === (x.kind ?? "batch"));
    }
  }
}

const halvesOf = (s: DecodedScanState, o: DecodedScanState): Omit<WindowEvents, "entries"> => ({
  delivered: s.delivered,
  staked: s.staked,
  payouts: s.payouts,
  deposited: o.deposited,
  redeemed: o.redeemed,
  adjustments: o.adjustments,
});

export type SeedVerdict =
  /** The halves may seed the scan (seedHalves), which then resumes from `next`. */
  | { ok: true; next: bigint }
  /** The scan reads the chain itself. `distrust`: the seed was shown to contradict the chain (the
   * indexer is left alone for a day); otherwise it couldn't be judged, or wasn't worth using. */
  | { ok: false; reason: string; distrust: boolean };

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** A random index below `n`, from the platform's randomness (a seed can't arrange to be sampled where
 * it is honest). */
function randomBelow(n: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % n;
}

/** `k` distinct picks from `xs`, at random. */
function sample<T>(xs: T[], k: number, random: (n: number) => number): T[] {
  const pool = [...xs];
  const out: T[] = [];
  while (out.length < k && pool.length > 0) {
    const i = random(pool.length) % pool.length;
    out.push(pool[i]);
    pool.splice(i, 1);
  }
  return out;
}

/** Judges the indexer's two halves against the chain before any of them is used, from a server at
 * `head`: both must be valid states for this deployment, within size (a padded half is refused before
 * it costs a receipt), reach past the scan, not stale and not ahead of the chain; the seed's last REREAD
 * blocks must hold exactly what the chain's logs hold there (an event the chain shows that the seed
 * lacks is a definite omission; one the seed has that the window lacks is checked by its receipt, since
 * a node's logs can lag its head); and a random sample of its events must each be in their receipt, at
 * their block. The sample is a bug detector: every seeded event is still confirmed before anything shows
 * it. Only a definite contradiction distrusts; a chain that can't be read well enough to tell is "no
 * seed", nothing more; an account whose events the seed's form can't describe (a direct deposit) is read
 * by the browser itself, with no blame. Receipts read here are kept on the scan. Never throws. */
export async function verifySeed(
  c: Pick<Clients, "bittensor">,
  d: Deployment,
  scan: VaultScan,
  account: Address,
  halves: SeedHalves,
  head: bigint,
  o: { random?: (n: number) => number } = {},
): Promise<SeedVerdict> {
  const no = (reason: string, distrust = false): SeedVerdict => ({ ok: false, reason, distrust });
  for (const half of [halves.shared, halves.own]) {
    if (isRecord(half) && typeof half.vault === "string" && typeof half.from === "string" && (half.vault !== d.vault.toLowerCase() || half.from !== String(d.bitBlock))) {
      return no("it is another deployment's", true);
    }
  }
  const s = decodeScanState(halves.shared, scan);
  const o2 = decodeScanState(halves.own, scan);
  if (!s || !o2) return no("a half isn't a valid scan state");
  // shapes no chain can have distrust; an honest history merely too big to check here is read instead
  const batchEvents = [...o2.deposited, ...o2.redeemed].filter((e) => e.kind === undefined);
  if (batchEvents.length > 2 * s.delivered.length) return no("its account half holds more events than its deliveries allow", true);
  for (const list of [o2.deposited, o2.redeemed]) {
    const txOf = new Map<string, string>();
    for (const e of list) {
      if (e.kind !== undefined) continue;
      const seen = txOf.get(e.key.toLowerCase());
      if (seen !== undefined && seen !== e.txHash.toLowerCase()) return no("its account half has two of one batch's entries for one account", true);
      txOf.set(e.key.toLowerCase(), e.txHash.toLowerCase());
    }
  }
  const perKey = new Map<string, number>();
  for (const p of s.payouts) perKey.set(p.key.toLowerCase(), (perKey.get(p.key.toLowerCase()) ?? 0) + 1);
  if ([...perKey.values()].some((n) => n > MAX_SEED_CHUNKS_PER_KEY)) return no("it holds more payout chunks for one batch than a batch can have", true);
  const shared = s.delivered.length + s.staked.length + s.payouts.length;
  const own = o2.deposited.length + o2.redeemed.length + o2.adjustments.length;
  if (own - batchEvents.length > MAX_SEED_ACCOUNT_EVENTS_EXTRA) return no("the account has more events of its own than are checked here");
  if (shared + own > MAX_SEED_EVENTS) return no("it is bigger than the history checked here");
  const next = min(s.next, o2.next);
  if (next <= scan.next) return no("it reaches no further than the saved scan");
  if (next > head + 1n) return no("it is ahead of the chain");
  if (head - next > SEED_MAX_LAG) return no(`it is ${head - next} blocks behind the chain`);
  const seed = tagged(halvesOf(s, o2));

  // the seed's last blocks against the chain's logs there
  const from = max(scan.from, next - REREAD);
  const to = next - 1n;
  let raw: RawLog[];
  try {
    raw = await windowLogs(c, d, from, to);
  } catch {
    return no("the chain couldn't be read to check it");
  }
  const chainEvents = vaultEvents(raw, d, account);
  // events of the account's the seed's form doesn't carry: the browser reads this account itself, no blame
  if (chainEvents.adjustments.length > 0 || [...chainEvents.deposited, ...chainEvents.redeemed].some((e) => e.kind === "direct")) {
    return no("the account has events the seed can't describe");
  }
  const chain = tagged(chainEvents);
  const recent = seed.filter(within(from, to));
  const seedIds = new Set(recent.map((t) => t.id));
  const chainIds = new Set(chain.map((t) => t.id));
  const missing = chain.filter((t) => !seedIds.has(t.id));
  if (missing.length > 0) return no(`it left out ${missing.length} event(s) the chain shows in its last ${REREAD} blocks`, true);
  const extra = recent.filter((t) => !chainIds.has(t.id));
  try {
    for (const t of extra) {
      const r = await receiptAt(c, scan, t.e.txHash, t.e.block);
      if (!shows(r, d, account, t)) return no(`it holds an event that isn't on the chain (${t.kind} at block ${t.e.block})`, true);
    }
  } catch {
    return no("the chain couldn't be read to check it");
  }

  // a random sample of the rest, each in its receipt at its block (one receipt per transaction)
  const older = seed.filter((t) => t.e.block < from);
  const picks = sample(older, SEED_SAMPLE, o.random ?? randomBelow);
  try {
    const hashes = [...new Set(picks.map((t) => t.e.txHash))];
    const receipts = new Map(await Promise.all(hashes.map(async (hash) => [hash, await receiptAt(c, scan, hash, picks.find((t) => t.e.txHash === hash)!.e.block)] as const)));
    for (const t of picks) {
      if (!shows(receipts.get(t.e.txHash) ?? null, d, account, t)) return no(`it holds an event that isn't on the chain (${t.kind} at block ${t.e.block})`, true);
    }
  } catch {
    return no("the chain couldn't be read to check it");
  }
  return { ok: true, next };
}

/** The blocks of the scan the indexer seeded: the deployment's half and the account's, as ranges. */
export function seededRanges(scan: VaultScan): { lo: bigint; hi: bigint } | undefined {
  const tos = [scan.sharedSeededTo, scan.accountSeededTo].filter((x): x is bigint => x !== undefined);
  if (tos.length === 0) return undefined;
  const froms = [scan.sharedSeededFrom ?? scan.from, scan.accountSeededFrom ?? scan.from];
  return { lo: froms.reduce((a, b) => min(a, b)), hi: tos.reduce((a, b) => max(a, b)) };
}

/** A half's seeded blocks not yet read by the browser's own check: [start, to), or none. */
function unchecked(from: bigint | undefined, to: bigint | undefined, checked: bigint | undefined, scanFrom: bigint): { start: bigint; to: bigint } | undefined {
  if (to === undefined) return undefined;
  const lo = from ?? scanFrom;
  const start = checked !== undefined && checked > lo ? checked : lo;
  return start < to ? { start, to } : undefined;
}

/** The deployment half's events, tagged as the check compares them and sorted by block: built once and
 * kept while the scan holds the same events there (`CheckMemo`), so each window costs a search of it,
 * never a pass over the whole history. */
type SharedIndex = { stamp: string; events: Tagged[]; keys: Set<string> };

/** What the caller keeps between steps of the check of one scan (live.ts keeps one per run). */
export type CheckMemo = { shared?: SharedIndex };

/** What would change the deployment half's events as the check compares them: a start over, their
 * numbers and the half's mark (a confirmation keeps an event's identity; a read that adds or drops one
 * changes a count). */
function sharedStamp(scan: VaultScan): string {
  let chunks = 0;
  for (const c of scan.payouts.values()) chunks += c.length;
  return [scan.restarts, scan.delivered.size, scan.staked.length, chunks, scan.sharedSeededFrom, scan.sharedSeededTo].join(":");
}

function sharedIndex(scan: VaultScan, memo: CheckMemo): SharedIndex {
  const stamp = sharedStamp(scan);
  if (memo.shared?.stamp === stamp) return memo.shared;
  const events = tagged(
    {
      delivered: [...scan.delivered].map(([batchId, e]) => ({ batchId, key: e.key, txHash: e.txHash, block: e.block })),
      staked: scan.staked,
      payouts: [...scan.payouts].flatMap(([key, chunks]) => chunks.map((p) => ({ key, chunk: p.chunk, taken: p.taken, txHash: p.txHash, block: p.block }))),
      deposited: [],
      redeemed: [],
      adjustments: [],
    },
    SHARED_KINDS,
  ).sort((a, b) => (a.e.block < b.e.block ? -1 : a.e.block > b.e.block ? 1 : 0));
  memo.shared = { stamp, events, keys: new Set([...scan.delivered.values()].map((e) => e.key.toLowerCase())) };
  return memo.shared;
}

/** The first index in `xs` (sorted by block) at or after `block`. */
function firstAt(xs: Tagged[], block: bigint): number {
  let [lo, hi] = [0, xs.length];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid].e.block < block) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Marks the deployment half's entries in [from, to] as confirmed: the chain's logs for those blocks were
 * compared with exactly them (the caller passes only blocks it judged), and a stake there is also known
 * to be the only one the chain has from `from` up to it. Nothing outside the range is touched. */
function confirmWindow(scan: VaultScan, from: bigint, to: bigint): void {
  const inside = (e: { block: bigint }) => e.block >= from && e.block <= to;
  for (const [id, e] of scan.delivered) if (inside(e) && e.unconfirmed) scan.delivered.set(id, { key: e.key, txHash: e.txHash, block: e.block });
  for (let i = 0; i < scan.staked.length; i++) {
    const s = scan.staked[i];
    if (inside(s)) scan.staked[i] = { block: s.block, txHash: s.txHash, clearBefore: s.clearBefore !== undefined && s.clearBefore < from ? s.clearBefore : from };
  }
  for (const [key, chunks] of scan.payouts) {
    if (chunks.some((p) => inside(p) && p.unconfirmed)) scan.payouts.set(key, chunks.map((p) => (inside(p) && p.unconfirmed ? { txHash: p.txHash, block: p.block, chunk: p.chunk, taken: p.taken } : p)));
  }
}

/** One step of the browser's own read of the blocks the indexer seeded, every vault log of each window
 * (`windows` of 1,000 blocks a step), each half from where its own check got (`sharedCheckedTo`,
 * `accountCheckedTo` on the scan, kept with the half's events and nowhere else: never another tab's or
 * account's progress), moved after each window so a later step, or visit, goes on from there. Each
 * window's chain events must be exactly the scan's, kind by kind, over the blocks of it that each half
 * still has unchecked: an event the chain shows that the scan lacks is a definite omission
 * (HistoryMismatchError naming the indexer, or, for an event the seed's form can't carry, naming no one:
 * the browser then reads this account itself); one the scan has that the window lacks is judged by its
 * receipt (a node's logs can lag). An entry of the account's in a delivery that moved no shares must have
 * its delivery in the scan. A window that matched confirms the deployment half's entries in the blocks it
 * judged. A half read to its end is the browser's own from then on: its marks clear. "done" once neither
 * half has a mark, "more" while there is further to read, "stopped" when the marks changed under the read
 * (it started over). A window that can't be read throws, keeping the progress made. Runs outside the
 * account's lock: it only reads the scan, and confirms. `memo`: kept by the caller between steps, so the
 * scan's events are indexed once (CheckMemo). */
export async function checkSeededHistory(c: Pick<Clients, "bittensor">, d: Deployment, scan: VaultScan, account: Address, windows = 1, memo: CheckMemo = {}): Promise<"more" | "done" | "stopped"> {
  const marks = () => [scan.restarts, scan.sharedSeededFrom, scan.sharedSeededTo, scan.accountSeededFrom, scan.accountSeededTo].join(":");
  for (let i = 0; i < windows; i++) {
    const shared = unchecked(scan.sharedSeededFrom, scan.sharedSeededTo, scan.sharedCheckedTo, scan.from);
    const own = unchecked(scan.accountSeededFrom, scan.accountSeededTo, scan.accountCheckedTo, scan.from);
    clearDone(scan, shared, own);
    if (!shared && !own) return "done";
    const was = marks();
    const from = max(scan.from, min(shared?.start ?? own!.start, own?.start ?? shared!.start));
    const end = min(from + WINDOW - 1n, max(shared?.to ?? 0n, own?.to ?? 0n) - 1n);
    const raw = await windowLogs(c, d, from, end);
    if (marks() !== was) return "stopped";
    const found = vaultEvents(raw, d, account);
    // the blocks of this window each half judges: its unchecked ones
    const span = (h: { start: bigint; to: bigint } | undefined) => (h && h.start <= end && h.to > from ? { lo: max(h.start, from), hi: min(h.to - 1n, end) } : undefined);
    const sharedSpan = span(shared);
    const ownSpan = span(own);
    const judged = (t: Tagged) => {
      const sp = SHARED_KINDS.includes(t.kind) ? sharedSpan : ownSpan;
      return sp !== undefined && t.e.block >= sp.lo && t.e.block <= sp.hi;
    };
    const chain = tagged(found).filter(judged);
    const index = sharedSpan ? sharedIndex(scan, memo) : undefined;
    const have = [
      ...(index && sharedSpan ? index.events.slice(firstAt(index.events, sharedSpan.lo), firstAt(index.events, sharedSpan.hi + 1n)) : []),
      ...(ownSpan ? tagged({ delivered: [], staked: [], payouts: [], deposited: scan.deposited, redeemed: scan.redeemed, adjustments: scan.adjustments }, ACCOUNT_KINDS).filter(judged) : []),
    ];
    const haveIds = new Set(have.map((t) => t.id));
    const chainIds = new Set(chain.map((t) => t.id));
    for (const t of chain) {
      if (haveIds.has(t.id)) continue;
      // a kind the indexer's seed form doesn't carry can't be its omission: the browser reads this account itself
      const beyondTheSeed = t.kind === "adjustments" || (t.e as AccountEvent).kind === "direct";
      throw new HistoryMismatchError(!beyondTheSeed);
    }
    for (const t of have) {
      if (chainIds.has(t.id)) continue;
      const r = await receiptAt(c, scan, t.e.txHash, t.e.block);
      if (!shows(r, d, account, t)) throw new HistoryMismatchError(true);
    }
    // the receipts above were awaited: a scan that started over meanwhile keeps nothing of this window
    if (marks() !== was) return "stopped";
    if (index && sharedSpan) {
      for (const e of found.entries) if (e.block >= sharedSpan.lo && e.block <= sharedSpan.hi && !index.keys.has(e.key.toLowerCase())) throw new HistoryMismatchError(true);
      confirmWindow(scan, sharedSpan.lo, sharedSpan.hi);
    }
    // each half's progress, as far as this window read its unchecked blocks
    if (sharedSpan) scan.sharedCheckedTo = sharedSpan.hi + 1n;
    if (ownSpan) scan.accountCheckedTo = ownSpan.hi + 1n;
  }
  const left = [
    unchecked(scan.sharedSeededFrom, scan.sharedSeededTo, scan.sharedCheckedTo, scan.from),
    unchecked(scan.accountSeededFrom, scan.accountSeededTo, scan.accountCheckedTo, scan.from),
  ] as const;
  clearDone(scan, ...left);
  return left[0] || left[1] ? "more" : "done";
}

/** A half whose seeded blocks the browser has read to the end is its own reading from then on: its
 * mark and its check's progress go. */
function clearDone(scan: VaultScan, shared: { start: bigint } | undefined, own: { start: bigint } | undefined): void {
  if (!shared && scan.sharedSeededTo !== undefined) {
    delete scan.sharedSeededFrom;
    delete scan.sharedSeededTo;
    delete scan.sharedCheckedTo;
  }
  if (!own && scan.accountSeededTo !== undefined) {
    delete scan.accountSeededFrom;
    delete scan.accountSeededTo;
    delete scan.accountCheckedTo;
  }
}
