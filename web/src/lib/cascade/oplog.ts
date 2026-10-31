import type { Address, Hex } from "viem";

/** Where an operation stands on the user's side: still sending, waiting for the user, all sent, or failed. */
export type OpState = "running" | "needs-you" | "sent" | "failed";

/** v2 stakes swap and deposit in separate calls; a v3 stake is one `stake` call to CascadeStaker
 * (after `approveUsdc` when it isn't paid by a permit). */
export type DepositCall = "approveUsdc" | "swap" | "approveTao" | "deposit" | "stake";
export type ClaimCall = "claim" | "approveTao" | "swap";

interface OpBase {
  id: string;
  account: Address;
  /** ms since the epoch */
  createdAt: number;
  mode?: "batch" | "sequential";
  state: OpState;
  error?: string;
}

export interface DepositOp extends OpBase {
  kind: "deposit";
  /** A stake through CascadeStaker (v3): swap and deposit happen in its one `stake` transaction. */
  v?: 3;
  usdcIn: bigint;
  targetTao: bigint;
  /** v3: the least TAO the stake may deposit, as quoted; carrying the stake on later keeps this floor. */
  minTaoOut?: bigint;
  /** The TAO price it was made at, in dollars. None for a deposit of wallet TAO whose price couldn't be
   * read at the click; read it through `entryPriceUsd`. */
  priceUsd?: number;
  feesUsd?: number;
  hashes: Partial<Record<DepositCall, Hex>>;
  /** EIP-5792 batch id when the wallet sent everything at once. */
  callsId?: string;
  batchId?: bigint;
  /** Taken back out of the open batch. */
  cancelled?: { hash: Hex; at: number };
}

export interface WithdrawalOp extends OpBase {
  kind: "withdrawal";
  shares: bigint;
  taoEstimate: bigint;
  usdcEstimate: bigint;
  fee: bigint;
  /** v3: the USDC delivery preference sent with the request. */
  delivery?: { minUsdcPerTao: bigint; deadline: number };
  hash?: Hex;
  /** ms since the epoch when `hash` was recorded (a sped-up request's when its replacement was). */
  sentAt?: number;
  /** The account's pending nonce on Base, read just before the request was sent: the request's own
   * nonce is at least this. A request Base doesn't know is taken for dropped only once the account's
   * mined nonce is past it (facts.ts, requestBatch). None for a contract account, whose own nonce
   * doesn't move with what it sends (flows.ts, planUnstake), nor on records made before it was kept. */
  nonce?: number;
  /** The last Base block read so far in the search for what took this request's place, when its hash
   * can't be mined: the next search reads on from there (facts.ts, requestReplacement). */
  searchedTo?: bigint;
  /** ms since the epoch when it was taken for dropped (live.ts): its own hash is still looked at for a
   * day after, in case Base mines it late. */
  droppedAt?: number;
  batchId?: bigint;
  cancelled?: { hash: Hex; at: number };
}

export interface ClaimOp extends OpBase {
  kind: "claim";
  amount: bigint;
  keepTao: boolean;
  minUsdc: bigint;
  hashes: Partial<Record<ClaimCall, Hex>>;
  callsId?: string;
  /** The unstakes this claim pays out (everything that was back on Base when it was made). */
  withdrawalIds?: string[];
}

/** "Send it now": closeBatch on the open batch `batchId`, paying its bridge fee (`value` is what was
 * sent; the front door refunds what the fee doesn't take). Recorded before the wallet is asked, so a
 * reload while it is on its way shows it as sending rather than offering it again. */
export interface CloseOp extends OpBase {
  kind: "close";
  batchId: bigint;
  value: bigint;
  hashes: Partial<Record<"close", Hex>>;
  callsId?: string;
}

export type Operation = DepositOp | WithdrawalOp | ClaimOp | CloseOp;

/** The TAO price a deposit was made at, when it has one. Deposits of wallet TAO were once recorded at $0
 * when no price was at hand: that is none too, never a price to show or average in. */
export function entryPriceUsd(op: Pick<DepositOp, "priceUsd">): number | undefined {
  return op.priceUsd !== undefined && op.priceUsd > 0 ? op.priceUsd : undefined;
}

/** Where the browser keeps text by key: localStorage, or memory where storage is blocked. Listing and
 * removing keys is needed only to make room (see createOpLog). */
export type StringStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
  key?(index: number): string | null;
  readonly length?: number;
};

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? { $bigint: v.toString() } : v);

// ---- What is read back from storage is checked, field by field, before it is believed ----
// Anyone with the browser's storage (an extension, another script on a shared origin in development, a
// sync that went wrong) can write under the log's keys. A record is read only if every field has the
// type, range and meaning the log writes (as scan-store.ts checks a saved scan); one that doesn't is
// dropped whole, with a warning, and never reaches a screen or a flow. Amounts stay exact bigints within
// what their token can be, dates are sane, and kinds, states and step names are the known ones.

/** A field that isn't as the log writes it: the record is dropped. */
class Bad extends Error {}
const need = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Bad();
  return v;
};
/** An optional field: absent is fine, present means it must check out. */
const maybe = <T>(x: unknown, f: (x: unknown) => T | undefined): T | undefined => (x === undefined ? undefined : need(f(x)));
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^(0|[1-9]\d{0,77})$/;
/** Ids come from newOpId (base 36) and go into URLs and React keys: nothing else is one. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** No record is older than this (Cascade's first transaction was in 2026)… */
const EPOCH_FLOOR = Date.UTC(2025, 0, 1);
/** …nor dated further ahead than a device's clock plausibly runs fast. */
const CLOCK_AHEAD_MS = 60 * 60_000;

const hash = (x: unknown): Hex | undefined => (typeof x === "string" && HASH.test(x) ? (x as Hex) : undefined);
const text = (max: number) => (x: unknown): string | undefined => (typeof x === "string" && x.length > 0 && x.length <= max ? x : undefined);
const oneOf = <T extends string>(choices: readonly T[]) => (x: unknown): T | undefined => (typeof x === "string" && (choices as readonly string[]).includes(x) ? (x as T) : undefined);
const bool = (x: unknown): boolean | undefined => (typeof x === "boolean" ? x : undefined);
/** A bigint as the log writes it ({ $bigint: decimal }), from 0 up to `bits` bits. */
const big = (bits: number) => (x: unknown): bigint | undefined => {
  if (!isRecord(x) || !DECIMAL.test(String(x.$bigint))) return undefined;
  const v = BigInt(x.$bigint as string);
  return v < 1n << BigInt(bits) ? v : undefined;
};
/** USDC units (6 decimals): 96 bits is far past its supply. */
const usdc = big(96);
/** TAO wei, csTAO share units, ETH wei: 128 bits. */
const wei = big(128);
const uint64 = big(64);
/** A whole non-negative number up to 32 bits (a nonce, a deadline in seconds). */
const uint32 = (x: unknown): number | undefined => (typeof x === "number" && Number.isInteger(x) && x >= 0 && x < 2 ** 32 ? x : undefined);
/** Dollars for display: a finite non-negative number. */
const usd = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : undefined);
const time = (now: number) => (x: unknown): number | undefined =>
  typeof x === "number" && Number.isInteger(x) && x >= EPOCH_FLOOR && x <= now + CLOCK_AHEAD_MS ? x : undefined;
/** The step hashes a record keeps: only the named steps, each a transaction hash. */
const hashesOf = <K extends string>(keys: readonly K[]) => (x: unknown): Partial<Record<K, Hex>> | undefined => {
  if (!isRecord(x)) return undefined;
  const out: Partial<Record<K, Hex>> = {};
  for (const [k, v] of Object.entries(x)) {
    if (!(keys as readonly string[]).includes(k)) return undefined;
    const h = hash(v);
    if (h === undefined) return undefined;
    out[k as K] = h;
  }
  return out;
};
const cancelledOf = (now: number) => (x: unknown): { hash: Hex; at: number } | undefined =>
  isRecord(x) ? { hash: need(hash(x.hash)), at: need(time(now)(x.at)) } : undefined;
const deliveryOf = (x: unknown): { minUsdcPerTao: bigint; deadline: number } | undefined =>
  isRecord(x) ? { minUsdcPerTao: need(usdc(x.minUsdcPerTao)), deadline: need(uint32(x.deadline)) } : undefined;
const idList = (x: unknown): string[] | undefined => (Array.isArray(x) && x.length <= 1_000 ? x.map((id) => need(text(64)(id))) : undefined);

const STATES = ["running", "needs-you", "sent", "failed"] as const satisfies OpState[];
const MODES = ["batch", "sequential"] as const;
const DEPOSIT_CALLS = ["approveUsdc", "swap", "approveTao", "deposit", "stake"] as const satisfies DepositCall[];
const CLAIM_CALLS = ["claim", "approveTao", "swap"] as const satisfies ClaimCall[];

/** A record from every field it may have (so a forgotten one fails to compile), keeping only those with
 * a value: a decoded record carries no field the log doesn't write. */
const defined = <T extends object>(o: { [K in keyof Required<T>]: Required<T>[K] | undefined }): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** `x` as a record of `account`'s, every field checked; null for anything else. */
export function decodeOperation(x: unknown, account: Address, now: number): Operation | null {
  try {
    if (!isRecord(x)) throw new Bad();
    const at = time(now);
    const own = typeof x.account === "string" && ADDRESS.test(x.account) && x.account.toLowerCase() === account.toLowerCase() ? (x.account as Address) : undefined;
    const base = {
      id: need(typeof x.id === "string" && ID.test(x.id) ? x.id : undefined),
      account: need(own),
      createdAt: need(at(x.createdAt)),
      mode: maybe(x.mode, oneOf(MODES)),
      state: need(oneOf(STATES)(x.state)),
      error: maybe(x.error, text(1_000)),
    };
    if (x.kind === "deposit") {
      return defined<DepositOp>({
        ...base,
        kind: "deposit",
        v: maybe(x.v, (v) => (v === 3 ? (3 as const) : undefined)),
        usdcIn: need(usdc(x.usdcIn)),
        targetTao: need(wei(x.targetTao)),
        minTaoOut: maybe(x.minTaoOut, wei),
        priceUsd: maybe(x.priceUsd, usd),
        feesUsd: maybe(x.feesUsd, usd),
        hashes: need(hashesOf(DEPOSIT_CALLS)(x.hashes)),
        callsId: maybe(x.callsId, text(256)),
        batchId: maybe(x.batchId, uint64),
        cancelled: maybe(x.cancelled, cancelledOf(now)),
      });
    }
    if (x.kind === "withdrawal") {
      return defined<WithdrawalOp>({
        ...base,
        kind: "withdrawal",
        shares: need(wei(x.shares)),
        taoEstimate: need(wei(x.taoEstimate)),
        usdcEstimate: need(usdc(x.usdcEstimate)),
        fee: need(wei(x.fee)),
        delivery: maybe(x.delivery, deliveryOf),
        hash: maybe(x.hash, hash),
        sentAt: maybe(x.sentAt, at),
        nonce: maybe(x.nonce, uint32),
        searchedTo: maybe(x.searchedTo, uint64),
        droppedAt: maybe(x.droppedAt, at),
        batchId: maybe(x.batchId, uint64),
        cancelled: maybe(x.cancelled, cancelledOf(now)),
      });
    }
    if (x.kind === "claim") {
      return defined<ClaimOp>({
        ...base,
        kind: "claim",
        amount: need(wei(x.amount)),
        keepTao: need(bool(x.keepTao)),
        minUsdc: need(usdc(x.minUsdc)),
        hashes: need(hashesOf(CLAIM_CALLS)(x.hashes)),
        callsId: maybe(x.callsId, text(256)),
        withdrawalIds: maybe(x.withdrawalIds, idList),
      });
    }
    if (x.kind === "close") {
      return defined<CloseOp>({
        ...base,
        kind: "close",
        batchId: need(uint64(x.batchId)),
        value: need(wei(x.value)),
        hashes: need(hashesOf(["close"] as const)(x.hashes)),
        callsId: maybe(x.callsId, text(256)),
      });
    }
    throw new Bad();
  } catch (e) {
    if (e instanceof Bad) return null;
    throw e;
  }
}

/** A stored list as its records, `account`'s and sound (decodeOperation), with how many were dropped;
 * null when `raw` isn't a JSON list at all. */
export function decodeOperations(raw: string, account: Address, now: number): { ops: Operation[]; dropped: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const ops: Operation[] = [];
  for (const x of parsed) {
    const op = decodeOperation(x, account, now);
    if (op) ops.push(op);
  }
  return { ops, dropped: parsed.length - ops.length };
}

/** The transactions this site sent, per account and deployment, kept in the browser. There is no
 * indexer: the activity trails start from these and read the rest from the chain. What is read back is
 * checked first (decodeOperations): a record that isn't as the log writes it is dropped with a warning.
 * When storage is full, `makeRoom` may free some (saved history, which can be read again) before a
 * write is kept in memory only: these records can't be read back from anywhere else. */
export function createOpLog(storage: StringStorage, frontDoor: Address, makeRoom?: () => boolean, now: () => number = Date.now) {
  const memory = new Map<string, Operation[]>();
  /** Lists whose last write storage refused (full, or blocked): this tab's memory is newer than what is stored. */
  const unsaved = new Set<string>();
  const key = (account: Address) => `cascade.ops.${frontDoor.toLowerCase()}.${account.toLowerCase()}`;
  /** What was last warned about under each key: the same stored text isn't warned about on every read. */
  const warned = new Map<string, string>();

  function warnOnce(k: string, raw: string, what: string): void {
    if (warned.get(k) === raw) return;
    warned.set(k, raw);
    console.warn(`Cascade: ${what} in this browser's storage; it is left out.`);
  }

  function read(account: Address): Operation[] {
    const k = key(account);
    if (unsaved.has(k)) return memory.get(k) ?? [];
    let raw: string | null;
    try {
      raw = storage.getItem(k);
    } catch {
      // storage blocked: fall back to this tab's memory
      return memory.get(k) ?? [];
    }
    if (raw === null) return memory.get(k) ?? [];
    const decoded = decodeOperations(raw, account, now());
    if (decoded === null) {
      warnOnce(k, raw, "the activity records aren't a readable list");
      return memory.get(k) ?? [];
    }
    if (decoded.dropped > 0) warnOnce(k, raw, `${decoded.dropped} activity record${decoded.dropped === 1 ? "" : "s"} couldn't be read`);
    return decoded.ops;
  }

  function write(account: Address, ops: Operation[]) {
    const k = key(account);
    memory.set(k, ops);
    const json = JSON.stringify(ops, replacer);
    const store = () => {
      try {
        storage.setItem(k, json);
        return true;
      } catch {
        return false;
      }
    };
    // kept in memory for this tab, which reads it from there until a write gets through again
    if (store() || (makeRoom?.() && store())) unsaved.delete(k);
    else unsaved.add(k);
  }

  /** Flows running in this tab right now: a "running" record not in here was left by a reload. */
  const active = new Set<string>();

  return {
    markActive: (id: string) => void active.add(id),
    markInactive: (id: string) => void active.delete(id),
    isActive: (id: string) => active.has(id),
    list: (account: Address) => [...read(account)].sort((a, b) => b.createdAt - a.createdAt),
    get: (account: Address, id: string) => read(account).find((o) => o.id === id) ?? null,
    put(op: Operation) {
      write(op.account, [...read(op.account).filter((o) => o.id !== op.id), op]);
    },
    remove(account: Address, id: string) {
      write(account, read(account).filter((o) => o.id !== id));
    },
    /** Removes an entry only if it never sent anything (no hash, no wallet batch) and isn't running in
     * this tab, re-checked against what is stored now. */
    removeUnsent(account: Address, id: string): boolean {
      const o = read(account).find((x) => x.id === id);
      if (!o || active.has(id)) return false;
      const sent = o.kind === "withdrawal" ? !!o.hash : !!o.callsId || Object.values(o.hashes).some(Boolean);
      if (sent) return false;
      write(account, read(account).filter((x) => x.id !== id));
      return true;
    },
    update(account: Address, id: string, patch: Partial<Operation>) {
      write(
        account,
        read(account).map((o) => (o.id === id ? ({ ...o, ...patch } as Operation) : o)),
      );
    },
  };
}

export type OpLog = ReturnType<typeof createOpLog>;

/** A record still marked "running" whose flow is not running in this tab was interrupted (a reload,
 * a closed tab): the user can continue it. */
export const effectiveState = (op: Operation, log: Pick<OpLog, "isActive">): OpState =>
  op.state === "running" && !log.isActive(op.id) ? "needs-you" : op.state;

/** A short random id for a new operation. */
export const newOpId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
