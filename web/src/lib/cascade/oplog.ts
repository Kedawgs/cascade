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
  priceUsd: number;
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
  hash?: Hex;
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

export type Operation = DepositOp | WithdrawalOp | ClaimOp;

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? { $bigint: v.toString() } : v);
const reviver = (_k: string, v: unknown) =>
  v && typeof v === "object" && "$bigint" in v ? BigInt((v as { $bigint: string }).$bigint) : v;

/** The transactions this site sent, per account and deployment, kept in the browser. There is no
 * indexer: the activity trails start from these and read the rest from the chain. */
export function createOpLog(storage: Storage, frontDoor: Address) {
  const memory = new Map<string, Operation[]>();
  const key = (account: Address) => `cascade.ops.${frontDoor.toLowerCase()}.${account.toLowerCase()}`;

  function read(account: Address): Operation[] {
    try {
      const raw = storage.getItem(key(account));
      if (raw !== null) return JSON.parse(raw, reviver) as Operation[];
    } catch {
      // storage blocked or unreadable: fall back to this tab's memory
    }
    return memory.get(key(account)) ?? [];
  }

  function write(account: Address, ops: Operation[]) {
    memory.set(key(account), ops);
    try {
      storage.setItem(key(account), JSON.stringify(ops, replacer));
    } catch {
      // kept in memory for this tab
    }
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
