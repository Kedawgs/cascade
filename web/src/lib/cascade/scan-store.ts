import type { Address, Hex } from "viem";
import type { Deployment } from "./config";
import { type AccountEvent, newScan, type PayoutChunk, SETTLE, type VaultScan } from "./facts";
import type { StringStorage } from "./oplog";

/** The saved form of a vault scan: how far it read and the events it found, bigints as decimal strings.
 * The same shape seeds a scan from the history indexer (seedHalves; indexer/src/seed.ts builds it): the
 * global events (deliveries from our front door, stakes, payout chunks) in one half and one account's
 * own Deposited and Redeemed in the other. Bump the version whenever the shape or meaning changes: an
 * entry of another version is discarded, never read. */
export const SCAN_VERSION = 1;

export interface ScanState {
  v: typeof SCAN_VERSION;
  /** The vault read (lowercase) and its deploy block: a state for another deployment is never used. */
  vault: string;
  from: string;
  /** Every event in [from, next) is here; `next` is the first block not read. */
  next: string;
  delivered: { batchId: string; key: Hex; txHash: Hex; block: string }[];
  staked: { block: string; txHash: Hex }[];
  payouts: { key: Hex; chunk: number; taken: number; txHash: Hex; block: string }[];
  deposited: { key: Hex; txHash: Hex; block: string; assets: string }[];
  redeemed: { key: Hex; txHash: Hex; block: string; assets: string }[];
  /** Saved halves only: the events below this block came from the indexer's seed, not this browser's own
   * read of the chain (in [from, next]). Absent on a half the browser read itself, and on older saves. A
   * contradiction found later on an event below it is the indexer's (facts.ts, HistoryMismatchError). */
  seededTo?: string;
}

/** A scan's settled events in their saved form: its progress is saved SETTLE blocks short of where it
 * stopped, without the events in those blocks (a later visit reads them again, and REREAD more). */
export function scanState(scan: VaultScan): ScanState {
  const next = scan.next - SETTLE > scan.from ? scan.next - SETTLE : scan.from;
  const settled = (e: { block: bigint }) => e.block < next;
  const account = (e: AccountEvent) => ({ key: e.key, txHash: e.txHash, block: String(e.block), assets: String(e.assets) });
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
    deposited: scan.deposited.filter(settled).map(account),
    redeemed: scan.redeemed.filter(settled).map(account),
  };
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isHash = (x: unknown): x is Hex => typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x);
const isDecimal = (x: unknown): x is string => typeof x === "string" && /^(0|[1-9]\d{0,77})$/.test(x);
const isUint32 = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 0xffff_ffff;

/** `x` as a valid state for the scan's vault and deploy block, decoded; null if anything about it is
 * off (another version or deployment, a malformed field, an event outside [from, next), a seeded mark
 * outside [from, next]), so a corrupt entry or seed is dropped whole rather than half-trusted. Every
 * event comes out `unconfirmed`: a delivery, stake or chunk is used only once its receipt shows it, an
 * amount only once its receipt confirms it (facts.ts). */
export function decodeScanState(x: unknown, scan: Pick<VaultScan, "vault" | "from">) {
  if (!isRecord(x) || x.v !== SCAN_VERSION || x.vault !== scan.vault.toLowerCase() || x.from !== String(scan.from) || !isDecimal(x.next)) return null;
  const next = BigInt(x.next);
  if (next < scan.from) return null;
  if (x.seededTo !== undefined && !(isDecimal(x.seededTo) && BigInt(x.seededTo) >= scan.from && BigInt(x.seededTo) <= next)) return null;
  const lists = ["delivered", "staked", "payouts", "deposited", "redeemed"] as const;
  if (!lists.every((k) => Array.isArray(x[k]) && (x[k] as unknown[]).every(isRecord))) return null;
  const list = (k: (typeof lists)[number]) => x[k] as Record<string, unknown>[];
  const inRange = (e: Record<string, unknown>) => isDecimal(e.block) && BigInt(e.block) >= scan.from && BigInt(e.block) < next && isHash(e.txHash);
  const ok =
    list("delivered").every((e) => inRange(e) && isDecimal(e.batchId) && isHash(e.key)) &&
    list("staked").every(inRange) &&
    list("payouts").every((e) => inRange(e) && isHash(e.key) && isUint32(e.chunk) && isUint32(e.taken)) &&
    [...list("deposited"), ...list("redeemed")].every((e) => inRange(e) && isHash(e.key) && isDecimal(e.assets));
  if (!ok) return null;
  const block = (e: Record<string, unknown>) => BigInt(e.block as string);
  const account = (e: Record<string, unknown>): AccountEvent => ({ key: e.key as Hex, txHash: e.txHash as Hex, block: block(e), assets: BigInt(e.assets as string), unconfirmed: true });
  return {
    next,
    ...(x.seededTo !== undefined ? { seededTo: BigInt(x.seededTo as string) } : {}),
    delivered: list("delivered").map((e) => ({ batchId: e.batchId as string, key: e.key as Hex, txHash: e.txHash as Hex, block: block(e), unconfirmed: true as const })),
    staked: list("staked").map((e) => ({ block: block(e), txHash: e.txHash as Hex, unconfirmed: true as const })),
    payouts: list("payouts").map((e) => ({ key: e.key as Hex, chunk: e.chunk as number, taken: e.taken as number, txHash: e.txHash as Hex, block: block(e), unconfirmed: true as const })),
    deposited: list("deposited").map(account),
    redeemed: list("redeemed").map(account),
  };
}

export type DecodedScanState = NonNullable<ReturnType<typeof decodeScanState>>;

const byBlock = <T extends { block: bigint }>(xs: T[]) => [...xs].sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** Carries `scan` forward with the two decoded halves of a saved or seeded state (the deployment's events
 * in `shared`, the account's in `own`), merged at the earlier of their two blocks: the events from where
 * the scan stopped up to there are added, and the scan resumes from there. A half marked as the indexer's
 * (`seededTo`) marks the scan so, as far as the merge reached. Halves that don't reach past the scan
 * change nothing. True when the scan moved forward. The one path for saved and seeded history alike. */
export function mergeHalves(scan: VaultScan, shared: DecodedScanState, own: DecodedScanState): boolean {
  const next = min(shared.next, own.next);
  const below = <T extends { block: bigint }>(xs: T[]) => xs.filter((e) => e.block < next);
  const moved = merge(scan, {
    next,
    delivered: below(shared.delivered),
    staked: below(shared.staked),
    payouts: below(shared.payouts),
    deposited: below(own.deposited),
    redeemed: below(own.redeemed),
  });
  if (moved) {
    if (shared.seededTo !== undefined) scan.sharedSeededTo = min(shared.seededTo, next);
    if (own.seededTo !== undefined) scan.accountSeededTo = min(own.seededTo, next);
  }
  return moved;
}

/** Seeds `scan` from the indexer's two halves (fetchSeed), through the same merge a load uses, with
 * every event unconfirmed and both halves marked as the indexer's up to where the merge reached. Halves
 * that aren't both valid for this scan's deployment, or don't reach past it, change nothing. True when
 * the scan moved forward. seed.ts verifies the halves against the chain before calling this. */
export function seedHalves(scan: VaultScan, shared: unknown, own: unknown): boolean {
  const [s, o] = [decodeScanState(shared, scan), decodeScanState(own, scan)];
  if (!s || !o) return false;
  return mergeHalves(scan, { ...s, seededTo: s.next }, { ...o, seededTo: o.next });
}

function merge(scan: VaultScan, s: Omit<DecodedScanState, "seededTo">): boolean {
  if (s.next <= scan.next) return false;
  // what the scan already read stays as it read it
  const unread = <T extends { block: bigint }>(xs: T[]) => byBlock(xs.filter((e) => e.block >= scan.next));
  for (const { batchId, ...e } of unread(s.delivered)) if (!scan.delivered.has(batchId)) scan.delivered.set(batchId, e);
  scan.staked.push(...unread(s.staked));
  for (const { key, ...p } of unread(s.payouts)) {
    const chunks: PayoutChunk[] = scan.payouts.get(key) ?? [];
    if (!chunks.some((c) => c.chunk === p.chunk)) scan.payouts.set(key, [...chunks, p]);
  }
  // the account's events once each, by transaction and batch: listed twice, an amount would count twice
  const once = (have: AccountEvent[], incoming: AccountEvent[]) => {
    const seen = new Set(have.map((e) => `${e.txHash}:${e.key}`.toLowerCase()));
    for (const e of incoming) {
      const id = `${e.txHash}:${e.key}`.toLowerCase();
      if (!seen.has(id)) have.push(e);
      seen.add(id);
    }
  };
  once(scan.deposited, unread(s.deposited));
  once(scan.redeemed, unread(s.redeemed));
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
 * each account's Deposited and Redeemed under that and the account; a scan resumes from the earlier of
 * the two. A half that is missing, can't be read or isn't valid starts the scan over. */
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
      // each half keeps its own mark, no further than the save reaches
      const seeded = (to: bigint | undefined) => (to !== undefined ? { seededTo: String(min(to, BigInt(state.next))) } : {});
      try {
        write(deployment, { ...state, deposited: [], redeemed: [], ...seeded(scan.sharedSeededTo) });
        write(key(account), { ...state, delivered: [], staked: [], payouts: [], ...seeded(scan.accountSeededTo) });
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
