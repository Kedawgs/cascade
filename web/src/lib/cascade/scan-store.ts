import type { Address, Hex } from "viem";
import type { Deployment } from "./config";
import { type AccountEvent, newScan, type PayoutChunk, SETTLE, type VaultScan } from "./facts";
import type { StringStorage } from "./oplog";

/** The saved form of a vault scan: how far it read and the events it found, bigints as decimal strings.
 * The same shape can seed a scan from a starting point published elsewhere (seedScan): the global
 * events (deliveries from our front door, stakes, payout chunks) and one account's own Deposited and
 * Redeemed. Bump the version whenever the shape or meaning changes: an entry of another version is
 * discarded, never read. */
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
 * off (another version or deployment, a malformed field, an event outside [from, next)), so a corrupt
 * entry or seed is dropped whole rather than half-trusted. */
function decode(x: unknown, scan: Pick<VaultScan, "vault" | "from">) {
  if (!isRecord(x) || x.v !== SCAN_VERSION || x.vault !== scan.vault.toLowerCase() || x.from !== String(scan.from) || !isDecimal(x.next)) return null;
  const next = BigInt(x.next);
  if (next < scan.from) return null;
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
    delivered: list("delivered").map((e) => ({ batchId: e.batchId as string, key: e.key as Hex, txHash: e.txHash as Hex, block: block(e) })),
    staked: list("staked").map((e) => ({ block: block(e), txHash: e.txHash as Hex })),
    payouts: list("payouts").map((e) => ({ key: e.key as Hex, chunk: e.chunk as number, taken: e.taken as number, txHash: e.txHash as Hex, block: block(e) })),
    deposited: list("deposited").map(account),
    redeemed: list("redeemed").map(account),
  };
}

type Decoded = NonNullable<ReturnType<typeof decode>>;

const byBlock = <T extends { block: bigint }>(xs: T[]) => [...xs].sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));

/** Carries `scan` forward with a saved or published state that reaches further than it has read: the
 * state's events from where the scan stopped up to the state's `next` are added, and the scan resumes
 * from there. The account's Deposited and Redeemed come in unconfirmed (their amounts wait for their
 * receipts). A state that isn't valid for this scan's deployment, or doesn't reach past it, changes
 * nothing. True when the scan moved forward. */
export function seedScan(scan: VaultScan, seed: unknown): boolean {
  const s = decode(seed, scan);
  return s !== null && merge(scan, s);
}

function merge(scan: VaultScan, s: Decoded): boolean {
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
        const [shared, own] = [decode(read(deployment), scan), decode(read(key(account)), scan)];
        if (!shared || !own) return scan;
        const next = shared.next < own.next ? shared.next : own.next;
        const below = <T extends { block: bigint }>(xs: T[]) => xs.filter((e) => e.block < next);
        merge(scan, {
          next,
          delivered: below(shared.delivered),
          staked: below(shared.staked),
          payouts: below(shared.payouts),
          deposited: below(own.deposited),
          redeemed: below(own.redeemed),
        });
      } catch {
        // storage blocked, or not JSON: start from the deploy block
      }
      return scan;
    },
    save(account: Address, scan: VaultScan): void {
      const state = scanState(scan);
      try {
        write(deployment, { ...state, deposited: [], redeemed: [] });
        write(key(account), { ...state, delivered: [], staked: [], payouts: [] });
      } catch {
        // storage full or blocked: this visit keeps its scan in memory
      }
    },
  };
}

/** Removes every saved scan, of any deployment or account: the op log needs the room more, and a scan
 * can always be read again. True if there was one to remove. */
export function dropSavedScans(storage: StringStorage): boolean {
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
