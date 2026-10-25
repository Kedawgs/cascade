import type { Address, Hex } from "viem";

/** Where an operation stands on the user's side: still sending, waiting for the user, all sent, or failed. */
export type OpState = "running" | "needs-you" | "sent" | "failed";

export type DepositCall = "approveUsdc" | "swap" | "approveTao" | "deposit";
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
  usdcIn: bigint;
  targetTao: bigint;
  priceUsd: number;
  feesUsd?: number;
  hashes: Partial<Record<DepositCall, Hex>>;
  /** EIP-5792 batch id when the wallet sent everything at once. */
  callsId?: string;
  batchId?: bigint;
}

export interface WithdrawalOp extends OpBase {
  kind: "withdrawal";
  shares: bigint;
  taoEstimate: bigint;
  usdcEstimate: bigint;
  fee: bigint;
  hash?: Hex;
  batchId?: bigint;
}

export interface ClaimOp extends OpBase {
  kind: "claim";
  amount: bigint;
  keepTao: boolean;
  minUsdc: bigint;
  hashes: Partial<Record<ClaimCall, Hex>>;
  callsId?: string;
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

  return {
    list: (account: Address) => [...read(account)].sort((a, b) => b.createdAt - a.createdAt),
    get: (account: Address, id: string) => read(account).find((o) => o.id === id) ?? null,
    put(op: Operation) {
      write(op.account, [...read(op.account).filter((o) => o.id !== op.id), op]);
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

/** A short random id for a new operation. */
export const newOpId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
