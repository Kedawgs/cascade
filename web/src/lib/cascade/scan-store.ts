import type { Address, Hex } from "viem";
import type { Deployment } from "./config";
import { type AccountEvent, newScan, type PayoutChunk, SETTLE, type Stake, type VaultScan } from "./facts";
import type { StringStorage } from "./oplog";

/** The saved form of a vault scan: how far it read and the events it found, bigints as decimal strings.
 * The same shape seeds a scan from the history indexer (seedHalves; indexer/src/seed.ts builds it): the
 * global events (deliveries from our front door, stakes, payout chunks) in one half and one account's
 * own events in the other. Version 1 is a half this browser read itself (or the indexer's seed as it
 * arrives); version 2 is a saved half that carries the indexer's mark (`seededFrom`, `seededTo`), which
 * an older build refuses whole rather than load the indexer's stakes and chunks as its own reading. Bump
 * the version whenever the shape or meaning changes: an entry of another version is discarded, never read. */
export const SCAN_VERSION = 1;
export const SEEDED_SCAN_VERSION = 2;

export interface ScanState {
  v: typeof SCAN_VERSION | typeof SEEDED_SCAN_VERSION;
  /** The vault read (lowercase) and its deploy block: a state for another deployment is never used. */
  vault: string;
  from: string;
  /** Every event in [from, next) is here; `next` is the first block not read. */
  next: string;
  delivered: { batchId: string; key: Hex; txHash: Hex; block: string }[];
  staked: { block: string; txHash: Hex }[];
  payouts: { key: Hex; chunk: number; taken: number; txHash: Hex; block: string }[];
  deposited: { key: Hex; txHash: Hex; block: string; assets: string; kind?: "direct" }[];
  redeemed: { key: Hex; txHash: Hex; block: string; assets: string; kind?: "direct" }[];
  /** The account's reversed redeems and reward cuts (absent in the indexer's seed and in older saves). */
  adjustments?: { key: Hex; txHash: Hex; block: string; assets: string; kind: "reversed" | "cut" }[];
  /** Version 2 only: the events in [seededFrom, seededTo) came from the indexer's seed, not this browser's
   * own read of the chain. A contradiction found later on one of them is the indexer's (facts.ts,
   * HistoryMismatchError), and nothing from them shows until the chain confirms it. */
  seededFrom?: string;
  seededTo?: string;
}

/** A scan's settled events in their saved form: its progress is saved SETTLE blocks short of where it
 * stopped, without the events in those blocks (a later visit reads them again, and REREAD more). */
export function scanState(scan: VaultScan): ScanState {
  const next = scan.next - SETTLE > scan.from ? scan.next - SETTLE : scan.from;
  const settled = (e: { block: bigint }) => e.block < next;
  const account = (e: AccountEvent) => ({ key: e.key, txHash: e.txHash, block: String(e.block), assets: String(e.assets), ...(e.kind ? { kind: e.kind } : {}) });
  return {
    v: SCAN_VERSION,
    vault: scan.vault.toLowerCase(),
    from: String(scan.from),
    next: String(next),
    delivered: [...scan.delivered].filter(([, e]) => settled(e)).map(([batchId, e]) => ({ batchId, key: e.key, txHash: e.txHash, block: String(e.block) })),
    staked: scan.staked.filter(settled).map((e) => ({ block: String(e.block), txHash: e.txHash })),
    payouts: [...scan.payouts].flatMap(([key, chunks]) =>
      chunks.filter(settled).map((p) => ({ key, chunk: p.chunk, taken: p.taken, txHash: p.txHash, block: String(p.block) })),
    ),
    deposited: scan.deposited.filter(settled).map(account) as ScanState["deposited"],
    redeemed: scan.redeemed.filter(settled).map(account) as ScanState["redeemed"],
    ...(scan.adjustments.length > 0 ? { adjustments: scan.adjustments.filter(settled).map(account) as ScanState["adjustments"] } : {}),
  };
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isHash = (x: unknown): x is Hex => typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x);
const isDecimal = (x: unknown): x is string => typeof x === "string" && /^(0|[1-9]\d{0,77})$/.test(x);
const isUint32 = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 0xffff_ffff;

/** `x` as a valid state for the scan's vault and deploy block, decoded; null if anything about it is
 * off (another version or deployment, a malformed field, an event outside [from, next), a version 2 half
 * without a sound mark or a version 1 half with one), so a corrupt entry or seed is dropped whole rather
 * than half-trusted. Deliveries and the account's events come out `unconfirmed` (a delivery is used
 * only once its receipt shows it, an amount only once its receipt confirms it: facts.ts); stakes and
 * chunks only within the half's seeded mark, where they are the indexer's word and not this browser's. */
export function decodeScanState(x: unknown, scan: Pick<VaultScan, "vault" | "from">) {
  if (!isRecord(x) || (x.v !== SCAN_VERSION && x.v !== SEEDED_SCAN_VERSION) || x.vault !== scan.vault.toLowerCase() || x.from !== String(scan.from) || !isDecimal(x.next)) return null;
  const next = BigInt(x.next);
  if (next < scan.from) return null;
  const seeded = x.v === SEEDED_SCAN_VERSION;
  if (!seeded && (x.seededFrom !== undefined || x.seededTo !== undefined)) return null;
  if (seeded && !(isDecimal(x.seededFrom) && isDecimal(x.seededTo) && BigInt(x.seededFrom) >= scan.from && BigInt(x.seededFrom) <= BigInt(x.seededTo) && BigInt(x.seededTo) <= next)) return null;
  const seededFrom = seeded ? BigInt(x.seededFrom as string) : undefined;
  const seededTo = seeded ? BigInt(x.seededTo as string) : undefined;
  const lists = ["delivered", "staked", "payouts", "deposited", "redeemed"] as const;
  if (!lists.every((k) => Array.isArray(x[k]) && (x[k] as unknown[]).every(isRecord))) return null;
  if (x.adjustments !== undefined && !(Array.isArray(x.adjustments) && x.adjustments.every(isRecord))) return null;
  const list = (k: (typeof lists)[number] | "adjustments") => (x[k] ?? []) as Record<string, unknown>[];
  const inRange = (e: Record<string, unknown>) => isDecimal(e.block) && BigInt(e.block) >= scan.from && BigInt(e.block) < next && isHash(e.txHash);
  const kindOk = (e: Record<string, unknown>, allowed: readonly string[]) => e.kind === undefined || (typeof e.kind === "string" && allowed.includes(e.kind));
  const ok =
    list("delivered").every((e) => inRange(e) && isDecimal(e.batchId) && isHash(e.key)) &&
    list("staked").every(inRange) &&
    list("payouts").every((e) => inRange(e) && isHash(e.key) && isUint32(e.chunk) && isUint32(e.taken)) &&
    [...list("deposited"), ...list("redeemed")].every((e) => inRange(e) && isHash(e.key) && isDecimal(e.assets) && kindOk(e, ["direct"])) &&
    list("adjustments").every((e) => inRange(e) && isHash(e.key) && isDecimal(e.assets) && typeof e.kind === "string" && ["reversed", "cut"].includes(e.kind));
  if (!ok) return null;
  const block = (e: Record<string, unknown>) => BigInt(e.block as string);
  const inSeed = (b: bigint) => seededFrom !== undefined && seededTo !== undefined && b >= seededFrom && b < seededTo;
  const account = (e: Record<string, unknown>): AccountEvent => ({
    key: e.key as Hex,
    txHash: e.txHash as Hex,
    block: block(e),
    assets: BigInt(e.assets as string),
    unconfirmed: true,
    ...(e.kind !== undefined ? { kind: e.kind as AccountEvent["kind"] } : {}),
  });
  return {
    next,
    ...(seeded ? { seededFrom, seededTo } : {}),
    delivered: list("delivered").map((e) => ({ batchId: e.batchId as string, key: e.key as Hex, txHash: e.txHash as Hex, block: block(e), unconfirmed: true as const })),
    staked: list("staked").map((e): Stake => ({ block: block(e), txHash: e.txHash as Hex, ...(inSeed(block(e)) ? { unconfirmed: true as const } : {}) })),
    payouts: list("payouts").map((e) => ({ key: e.key as Hex, chunk: e.chunk as number, taken: e.taken as number, txHash: e.txHash as Hex, block: block(e), ...(inSeed(block(e)) ? { unconfirmed: true as const } : {}) })),
    deposited: list("deposited").map(account),
    redeemed: list("redeemed").map(account),
    adjustments: list("adjustments").map(account),
  };
}

export type DecodedScanState = NonNullable<ReturnType<typeof decodeScanState>>;

const byBlock = <T extends { block: bigint }>(xs: T[]) => [...xs].sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

/** Carries `scan` forward with the two decoded halves of a saved or seeded state (the deployment's events
 * in `shared`, the account's in `own`), merged at the earlier of their two blocks: the events from where
 * the scan stopped up to there are added, and the scan resumes from there. A half marked as the indexer's
 * marks the scan so, over the blocks the merge took from it. Halves that don't reach past the scan
 * change nothing. True when the scan moved forward. The one path for saved and seeded history alike. */
export function mergeHalves(scan: VaultScan, shared: DecodedScanState, own: DecodedScanState): boolean {
  const next = min(shared.next, own.next);
  const was = scan.next;
  const below = <T extends { block: bigint }>(xs: T[]) => xs.filter((e) => e.block < next);
  const moved = merge(scan, {
    next,
    delivered: below(shared.delivered),
    staked: below(shared.staked),
    payouts: below(shared.payouts),
    deposited: below(own.deposited),
    redeemed: below(own.redeemed),
    adjustments: below(own.adjustments),
  });
  if (moved) {
    // the indexer's blocks among what was taken: from the later of its mark's start and where the scan was
    if (shared.seededTo !== undefined && shared.seededFrom !== undefined) {
      const lo = max(shared.seededFrom, was);
      const hi = min(shared.seededTo, next);
      if (lo < hi) {
        scan.sharedSeededFrom = lo;
        scan.sharedSeededTo = hi;
      }
    }
    if (own.seededTo !== undefined && own.seededFrom !== undefined) {
      const lo = max(own.seededFrom, was);
      const hi = min(own.seededTo, next);
      if (lo < hi) {
        scan.accountSeededFrom = lo;
        scan.accountSeededTo = hi;
      }
    }
  }
  return moved;
}

/** Seeds `scan` from the indexer's two halves (fetchSeed), through the same merge a load uses, with
 * every event unconfirmed and both halves marked as the indexer's over the blocks the merge took from
 * them. Halves that aren't both valid for this scan's deployment, or don't reach past it, change nothing.
 * True when the scan moved forward. seed.ts verifies the halves against the chain before calling this. */
export function seedHalves(scan: VaultScan, shared: unknown, own: unknown): boolean {
  const [s, o] = [decodeScanState(shared, scan), decodeScanState(own, scan)];
  if (!s || !o || s.seededTo !== undefined || o.seededTo !== undefined) return false;
  const mark = (x: DecodedScanState): DecodedScanState => ({
    ...x,
    seededFrom: scan.from,
    seededTo: x.next,
    staked: x.staked.map((e) => ({ ...e, unconfirmed: true as const })),
    payouts: x.payouts.map((e) => ({ ...e, unconfirmed: true as const })),
  });
  return mergeHalves(scan, mark(s), mark(o));
}

function merge(scan: VaultScan, s: Omit<DecodedScanState, "seededFrom" | "seededTo">): boolean {
  if (s.next <= scan.next) return false;
  // what the scan already read stays as it read it
  const unread = <T extends { block: bigint }>(xs: T[]) => byBlock(xs.filter((e) => e.block >= scan.next));
  for (const { batchId, ...e } of unread(s.delivered)) if (!scan.delivered.has(batchId)) scan.delivered.set(batchId, e);
  scan.staked.push(...unread(s.staked));
  for (const { key, ...p } of unread(s.payouts)) {
    const chunks: PayoutChunk[] = scan.payouts.get(key) ?? [];
    if (!chunks.some((c) => c.chunk === p.chunk)) scan.payouts.set(key, [...chunks, p]);
  }
  // the account's events once each, by transaction, batch and kind: listed twice, an amount would count twice
  const once = (have: AccountEvent[], incoming: AccountEvent[]) => {
    const id = (e: AccountEvent) => `${e.txHash}:${e.key}:${e.kind ?? ""}`.toLowerCase();
    const seen = new Set(have.map(id));
    for (const e of incoming) {
      if (!seen.has(id(e))) have.push(e);
      seen.add(id(e));
    }
  };
  once(scan.deposited, unread(s.deposited));
  once(scan.redeemed, unread(s.redeemed));
  once(scan.adjustments, unread(s.adjustments));
  scan.next = s.next;
  return true;
}

/** The most one saved scan may take of the browser's storage, in characters (about a fifth of a typical
 * 5 MB quota, years of deliveries). The op log shares that storage and matters more: a scan grown past
 * this stays in memory, and the one saved earlier is resumed from instead. */
const MAX_SAVED_CHARS = 1_000_000;

const PREFIX = "cascade.scan.";
/** Storage whose saved scans were dropped this visit to make room for the op log: no scan is saved
 * there again until the next visit, so storage doesn't fill straight back up and crowd it out again. */
const crowded = new WeakSet<object>();

/** Each account's scan of one deployment, saved in the browser (the op log's storage) so a later visit
 * resumes it rather than reading the vault's history from the deploy block again. The deployment's own
 * events (deliveries, stakes, payout chunks) are saved once, under its front door and deploy block, and
 * each account's events under that and the account; a scan resumes from the earlier of the two. A half
 * that is missing, can't be read or isn't valid starts the scan over. */
export function createScanStore(storage: StringStorage, d: Deployment) {
  const deployment = `${PREFIX}${d.frontDoor.toLowerCase()}.${d.bitBlock}`;
  const key = (account: Address) => `${deployment}.${account.toLowerCase()}`;
  const read = (k: string): unknown => {
    const raw = storage.getItem(k);
    return raw === null ? null : JSON.parse(raw);
  };
  const write = (k: string, state: ScanState) => {
    const json = JSON.stringify(state);
    if (json.length <= MAX_SAVED_CHARS) storage.setItem(k, json);
  };
  return {
    /** The saved scan for `account`, or a new one from the deploy block. */
    load(account: Address): VaultScan {
      const scan = newScan(d);
      try {
        const [shared, own] = [decodeScanState(read(deployment), scan), decodeScanState(read(key(account)), scan)];
        if (shared && own) mergeHalves(scan, shared, own);
      } catch {
        // storage blocked, or not JSON: start from the deploy block
      }
      return scan;
    },
    save(account: Address, scan: VaultScan): void {
      if (crowded.has(storage)) return;
      const state = scanState(scan);
      // each half keeps its own mark, no further than the save reaches; a half with none is the first version
      const seeded = (from: bigint | undefined, to: bigint | undefined): Partial<ScanState> => {
        if (to === undefined) return {};
        const hi = min(to, BigInt(state.next));
        const lo = from ?? scan.from;
        return lo < hi ? { v: SEEDED_SCAN_VERSION, seededFrom: String(lo), seededTo: String(hi) } : {};
      };
      try {
        write(deployment, { ...state, deposited: [], redeemed: [], adjustments: undefined, ...seeded(scan.sharedSeededFrom, scan.sharedSeededTo) });
        write(key(account), { ...state, delivered: [], staked: [], payouts: [], ...seeded(scan.accountSeededFrom, scan.accountSeededTo) });
      } catch {
        // storage full or blocked: this visit keeps its scan in memory
      }
    },
  };
}

/** Removes every saved scan, of any deployment or account: the op log needs the room more, and a scan
 * can always be read again. None is saved there again this visit. True if there was one to remove. */
export function dropSavedScans(storage: StringStorage): boolean {
  crowded.add(storage);
  try {
    if (!storage.removeItem || !storage.key || storage.length === undefined) return false;
    const saved: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k?.startsWith(PREFIX)) saved.push(k);
    }
    for (const k of saved) storage.removeItem(k);
    return saved.length > 0;
  } catch {
    return false;
  }
}

export type ScanStore = ReturnType<typeof createScanStore>;
