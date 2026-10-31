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
const reviver = (_k: string, v: unknown) =>
  v && typeof v === "object" && "$bigint" in v ? BigInt((v as { $bigint: string }).$bigint) : v;

/** The transactions this site sent, per account and deployment, kept in the browser. There is no
 * indexer: the activity trails start from these and read the rest from the chain. When storage is full,
 * `makeRoom` may free some (saved history, which can be read again) before a write is kept in memory
 * only: these records can't be read back from anywhere else. */
export function createOpLog(storage: StringStorage, frontDoor: Address, makeRoom?: () => boolean) {
  const memory = new Map<string, Operation[]>();
  /** Lists whose last write storage refused (full, or blocked): this tab's memory is newer than what is stored. */
  const unsaved = new Set<string>();
  const key = (account: Address) => `cascade.ops.${frontDoor.toLowerCase()}.${account.toLowerCase()}`;

  function read(account: Address): Operation[] {
    const k = key(account);
    if (unsaved.has(k)) return memory.get(k) ?? [];
    try {
      const raw = storage.getItem(k);
      if (raw !== null) return JSON.parse(raw, reviver) as Operation[];
    } catch {
      // storage blocked or unreadable: fall back to this tab's memory
    }
    return memory.get(k) ?? [];
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
