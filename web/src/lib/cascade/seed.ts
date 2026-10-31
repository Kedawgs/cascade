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
/** The account half may hold at most two events per delivery (a deposit and a redeem in one batch) plus
 * this many more (the account's direct deposits and redeems, which the indexer's first seed form doesn't
 * carry; room for a later one that does). More is padding. */
export const MAX_SEED_ACCOUNT_EVENTS_EXTRA = 50;
/** A payout batch has at most a few dozen entries, each chunk takes at least one. */
export const MAX_SEED_CHUNKS_PER_KEY = 64;
/** The most events both halves may hold together: years of a deployment, well short of a receipt storm. */
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
  const shared = s.delivered.length + s.staked.length + s.payouts.length;
  const own = o2.deposited.length + o2.redeemed.length + o2.adjustments.length;
  if (shared + own > MAX_SEED_EVENTS) return no("it is bigger than any history could be", true);
  if (own > 2 * s.delivered.length + MAX_SEED_ACCOUNT_EVENTS_EXTRA) return no("its account half holds more events than its deliveries allow", true);
  const perKey = new Map<string, number>();
  for (const p of s.payouts) perKey.set(p.key.toLowerCase(), (perKey.get(p.key.toLowerCase()) ?? 0) + 1);
  if ([...perKey.values()].some((n) => n > MAX_SEED_CHUNKS_PER_KEY)) return no("it holds more payout chunks for one batch than a batch can have", true);
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

/** Marks the scan's entries in [from, to] as confirmed: the chain's logs for those blocks held exactly
 * them (a stake there is also known to be the first after any block from `from`). */
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
 * (`windows` of 1,000 blocks a step), from `progress.next` (or the seeded ranges' start), moved after
 * each window so a later step, or visit, goes on from there; `scan.checkedTo` follows it. Each window's
 * chain events must be exactly the scan's for those blocks, kind by kind, within the half's seeded range:
 * an event the chain shows that the scan lacks is a definite omission (HistoryMismatchError naming the
 * indexer, or, for an event the seed's form can't carry, naming no one: the browser then reads this
 * account itself); one the scan has that the window lacks is judged by its receipt (a node's logs can
 * lag). An entry of the account's in a delivery that moved no shares must have its delivery in the scan.
 * A window that matched confirms the scan's entries in it. "done" once the ranges are read (the caller
 * clears the marks), "more" while there is further to read, "stopped" when the marks changed under the
 * read (it started over, or was seeded again). A window that can't be read throws, keeping the progress
 * made. Runs outside the account's lock: it only reads the scan, and confirms. */
export async function checkSeededHistory(c: Pick<Clients, "bittensor">, d: Deployment, scan: VaultScan, account: Address, progress: { next?: bigint }, windows = 1): Promise<"more" | "done" | "stopped"> {
  const ranges = seededRanges(scan);
  if (!ranges) return "done";
  const marks = [scan.sharedSeededFrom, scan.sharedSeededTo, scan.accountSeededFrom, scan.accountSeededTo].join(":");
  const inShared = (b: bigint) => scan.sharedSeededTo !== undefined && b >= (scan.sharedSeededFrom ?? scan.from) && b < scan.sharedSeededTo;
  const inAccount = (b: bigint) => scan.accountSeededTo !== undefined && b >= (scan.accountSeededFrom ?? scan.from) && b < scan.accountSeededTo;
  let from = max(scan.from, progress.next ?? ranges.lo);
  for (let i = 0; i < windows && from < ranges.hi; i++) {
    const end = min(from + WINDOW - 1n, ranges.hi - 1n);
    const raw = await windowLogs(c, d, from, end);
    if ([scan.sharedSeededFrom, scan.sharedSeededTo, scan.accountSeededFrom, scan.accountSeededTo].join(":") !== marks) return "stopped";
    const found = vaultEvents(raw, d, account);
    const scanEvents: Omit<WindowEvents, "entries"> = {
      delivered: [...scan.delivered].map(([batchId, e]) => ({ batchId, key: e.key, txHash: e.txHash, block: e.block })),
      staked: scan.staked,
      payouts: [...scan.payouts].flatMap(([key, chunks]) => chunks.map((p) => ({ key, chunk: p.chunk, taken: p.taken, txHash: p.txHash, block: p.block }))),
      deposited: scan.deposited,
      redeemed: scan.redeemed,
      adjustments: scan.adjustments,
    };
    const judged = (t: Tagged) => (SHARED_KINDS.includes(t.kind) ? inShared(t.e.block) : inAccount(t.e.block)) && t.e.block >= from && t.e.block <= end;
    const chain = tagged(found).filter(judged);
    const have = tagged(scanEvents).filter(judged);
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
    if (scan.sharedSeededTo !== undefined) {
      const keys = new Set([...scan.delivered.values()].map((e) => e.key.toLowerCase()));
      for (const e of found.entries) if (inShared(e.block) && !keys.has(e.key.toLowerCase())) throw new HistoryMismatchError(true);
    }
    confirmWindow(scan, from, end);
    from = end + 1n;
    progress.next = from;
    scan.checkedTo = from;
  }
  return from >= ranges.hi ? "done" : "more";
}
