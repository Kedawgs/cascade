import { type Abi, type Address, type Hex, maxUint256 } from "viem";
import { ERC20, FRONT_DOOR, ROUTER } from "./abi";
import { type Deployment, PATH_TAO_TO_USDC, TOKENS, UNISWAP } from "./config";
import type { DepositOp, OpState } from "./oplog";
import type { Balances, DepositQuote } from "./types";
import { floorRao } from "./units";

/** One contract call in a flow, named so a resumed flow knows what it already sent. */
export interface FlowCall {
  key: string;
  to: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}

const call = (key: string, to: Address, abi: Abi, functionName: string, args: readonly unknown[], value?: bigint): FlowCall => ({
  key,
  to,
  abi,
  functionName,
  args,
  ...(value !== undefined ? { value } : {}),
});

/** USDC → exactly `targetTao` TAO (unused USDC never leaves the wallet) → the front door. Uniswap's
 * router may hold an open USDC approval; the unaudited front door only ever gets the exact deposit. */
export function stakeCalls(q: Pick<DepositQuote, "usdcIn" | "targetTao">, w: Balances, d: Deployment, account: Address): FlowCall[] {
  const out: FlowCall[] = [];
  if (w.usdcRouterAllowance < q.usdcIn) out.push(call("approveUsdc", TOKENS.usdc, ERC20, "approve", [UNISWAP.router, maxUint256]));
  out.push(
    call("swap", UNISWAP.router, ROUTER, "exactOutput", [
      { path: PATH_TAO_TO_USDC, recipient: account, amountOut: q.targetTao, amountInMaximum: q.usdcIn },
    ]),
  );
  out.push(...depositTaoCalls(q.targetTao, w, d));
  return out;
}

/** TAO already in the wallet into the front door: an exact approval, then the deposit, in whole rao. */
export function depositTaoCalls(taoWei: bigint, w: Balances, d: Deployment): FlowCall[] {
  const amount = floorRao(taoWei);
  const out: FlowCall[] = [];
  if (w.taoFrontDoorAllowance < amount) out.push(call("approveTao", TOKENS.tao, ERC20, "approve", [d.frontDoor, amount]));
  out.push(call("deposit", d.frontDoor, FRONT_DOOR, "deposit", [amount]));
  return out;
}

/** TAO in the wallet back to USDC (TAO –0.3%→ WETH –0.05%→ USDC) with a minimum. */
export function sellTaoCalls(taoWei: bigint, minUsdc: bigint, w: Balances, account: Address): FlowCall[] {
  const out: FlowCall[] = [];
  if (w.taoRouterAllowance < taoWei) out.push(call("approveTao", TOKENS.tao, ERC20, "approve", [UNISWAP.router, maxUint256]));
  out.push(
    call("swap", UNISWAP.router, ROUTER, "exactInput", [
      { path: PATH_TAO_TO_USDC, recipient: account, amountIn: taoWei, amountOutMinimum: minUsdc },
    ]),
  );
  return out;
}

/** The redeem request fee is due once per open batch: a second request in it must send 0. */
export function unstakeCall(shares: bigint, redeemOf: bigint, redeemRequestFee: bigint, d: Deployment): FlowCall {
  return call("request", d.frontDoor, FRONT_DOOR, "requestRedeem", [shares], redeemOf === 0n ? redeemRequestFee : 0n);
}

export function claimCalls(claimable: bigint, minUsdc: bigint, w: Balances, d: Deployment, account: Address, keepTao: boolean): FlowCall[] {
  const out = [call("claim", d.frontDoor, FRONT_DOOR, "claim", [])];
  return keepTao ? out : [...out, ...sellTaoCalls(claimable, minUsdc, w, account)];
}

export function cancelCall(kind: "deposit" | "withdrawal", amount: bigint, d: Deployment): FlowCall {
  return kind === "deposit"
    ? call("cancel", d.frontDoor, FRONT_DOOR, "cancelDeposit", [amount])
    : call("cancel", d.frontDoor, FRONT_DOOR, "cancelRedeem", [amount]);
}

/** On resuming a stake whose hashes were lost (a reload while the wallet broadcast), drop what the
 * chain shows already happened: the deposit (in the open batch) or the swap (TAO in the wallet). */
export function stillToSend(
  calls: FlowCall[],
  op: { hashes: Partial<Record<string, Hex>>; targetTao: bigint },
  chain: { walletTao: bigint; depositOf: bigint },
): FlowCall[] {
  if (!op.hashes.deposit && chain.depositOf >= op.targetTao) return [];
  if (!op.hashes.swap && chain.walletTao >= op.targetTao) return calls.filter((c) => c.key !== "approveUsdc" && c.key !== "swap");
  return calls;
}

/** Retrying a deposit whose swap worked but whose deposit failed: forget the failed deposit (its hash
 * or wallet batch would only be read again) but keep the swap, and send one step at a time. */
export function retryPatch(op: Pick<DepositOp, "state" | "hashes" | "callsId" | "mode">): Partial<DepositOp> {
  if (op.state !== "failed") return {};
  const { approveUsdc, swap } = op.hashes;
  return {
    hashes: { ...(approveUsdc ? { approveUsdc } : {}), ...(swap ? { swap } : {}) },
    callsId: undefined,
    mode: "sequential",
    state: "running",
    error: undefined,
  };
}

export class FlowBusyError extends Error {
  constructor() {
    super("Your wallet is already busy with another step. Finish or cancel it first.");
    this.name = "FlowBusyError";
  }
}

/** One flow at a time, claimed synchronously before anything is read, so a double click can never
 * start a second stake. `onChange` mirrors the running label into React state. */
export function createFlowGuard(onChange: (label: string | null) => void) {
  let active: string | null = null;
  return {
    get active() {
      return active;
    },
    async run<T>(label: string, fn: () => Promise<T>): Promise<T> {
      if (active) throw new FlowBusyError();
      active = label;
      onChange(label);
      try {
        return await fn();
      } finally {
        active = null;
        onChange(null);
      }
    },
  };
}

/** One flow at a time across the whole app (the stake form, the claim box and the wallet-TAO box each
 * use the flows hook): every screen subscribes to see which flow runs, and a second is refused. */
export function createSharedFlowGuard() {
  const listeners = new Set<(label: string | null) => void>();
  const guard = createFlowGuard((label) => listeners.forEach((l) => l(label)));
  return {
    get active() {
      return guard.active;
    },
    run: guard.run,
    subscribe(listener: (label: string | null) => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** What a flow needs from the wallet; wagmi provides it in the app (use-flows.ts), fakes in tests. */
export interface WalletPort {
  switchToBase(): Promise<void>;
  /** The wallet can send several calls as one atomic batch on Base (EIP-5792). */
  canBatch(): Promise<boolean>;
  sendBatch(calls: FlowCall[]): Promise<{ id: string }>;
  waitBatch(id: string): Promise<{ status: "success" | "failure"; hashes: Hex[] }>;
  send(call: FlowCall): Promise<Hex>;
  wait(hash: Hex): Promise<{ status: "success" | "reverted" }>;
}

/** Where a flow keeps its progress: the operation log entry it belongs to. */
export interface FlowStore {
  hashes(): Record<string, Hex | undefined>;
  setHash(key: string, hash: Hex): void;
  setState(state: OpState, error?: string): void;
  callsId(): string | undefined;
  setCallsId(id: string): void;
  mode(): "batch" | "sequential" | undefined;
  setMode(mode: "batch" | "sequential"): void;
}

export class FlowError extends Error {
  readonly state: OpState;

  constructor(message: string, state: OpState) {
    super(message);
    this.state = state;
  }
}

/** The wallet can't pay the network fee (viem's and the node's wordings). */
const noGas = (e: unknown): boolean => {
  const err = e as { message?: string; cause?: unknown } | undefined;
  return /insufficient funds|exceeds the balance/i.test(err?.message ?? "") || (err?.cause !== undefined && noGas(err.cause));
};

const NO_ETH = "Network fees on Base are paid in ETH, and this wallet doesn't have enough. Add a little ETH on Base and try again.";

/** What a user sees for an error: our own messages as written, a refusal or missing ETH in plain words,
 * and never a raw RPC or library message (those can carry an RPC address). */
export function userMessage(e: unknown): string {
  if (e instanceof FlowError || e instanceof FlowBusyError) return e.message;
  if (rejected(e)) return "You declined in your wallet. Nothing was sent.";
  if (noGas(e)) return NO_ETH;
  return "We couldn't reach Base just now. Nothing was sent. Try again.";
}

const codeOf = (e: unknown): number | undefined => {
  const err = e as { code?: number; cause?: unknown };
  return err?.code ?? (err?.cause !== undefined ? codeOf(err.cause) : undefined);
};

const rejected = (e: unknown): boolean => {
  const err = e as { name?: string; code?: number; message?: string; cause?: unknown };
  return (
    err?.name === "UserRejectedRequestError" ||
    err?.code === 4001 ||
    /user (rejected|denied)|rejected the request/i.test(err?.message ?? "") ||
    (err?.cause !== undefined && rejected(err.cause))
  );
};

/** EIP-5792 / EIP-7702 answers that mean "not as a batch": declined upgrade (5750), atomicity not
 * supported (5760), unsupported chain (5710), unsupported method (4100, -32601). */
const NO_BATCH = new Set([5750, 5760, 5710, 5700, 4100, -32601]);

function revertMessage(key: string): string {
  if (key === "swap") return "The price moved before the swap went through, so nothing was deposited. Try again.";
  return "A transaction failed on Base. Nothing after it was sent.";
}

const LOST = "We couldn't confirm the transaction yet. Continue to check it again; nothing is sent twice.";

function fail(store: FlowStore, message: string, state: OpState): never {
  store.setState(state, message);
  throw new FlowError(message, state);
}

/** Sends `calls`: as one batch when the wallet can (and has not turned batching down), else one at a
 * time. A call whose hash is already recorded is never sent again, only waited for, so a stopped flow
 * resumes where it stopped. Anything that stops the flow leaves the record "needs-you" or "failed". */
export async function runFlow(port: WalletPort, store: FlowStore, calls: FlowCall[]): Promise<void> {
  store.setState("running");
  try {
    await port.switchToBase();
  } catch (e) {
    fail(store, rejected(e) ? "Switch your wallet to Base to continue." : "Your wallet could not switch to Base.", "needs-you");
  }

  const pendingBatch = store.callsId();
  const nothingSent = calls.every((c) => !store.hashes()[c.key]);
  const batchable =
    store.mode() !== "sequential" && (pendingBatch !== undefined || (nothingSent && calls.length > 1 && (await port.canBatch().catch(() => false))));
  if (batchable) {
    let id = pendingBatch;
    if (!id) {
      try {
        ({ id } = await port.sendBatch(calls));
      } catch (e) {
        const code = codeOf(e);
        if (code !== undefined && NO_BATCH.has(code)) {
          store.setMode("sequential");
          fail(store, "Your wallet didn't take the steps as one batch. Continue to confirm them one at a time.", "needs-you");
        }
        if (rejected(e)) {
          store.setMode("sequential");
          fail(store, "You cancelled in your wallet. Continue to confirm the steps one at a time.", "needs-you");
        }
        fail(store, "Your wallet could not send the batch.", "failed");
      }
      store.setCallsId(id);
      store.setMode("batch");
    }
    let r: { status: "success" | "failure"; hashes: Hex[] };
    try {
      r = await port.waitBatch(id);
    } catch {
      fail(store, LOST, "needs-you");
    }
    // a smart account usually runs the whole batch in one transaction
    calls.forEach((c, i) => {
      const h = r.hashes.length === calls.length ? r.hashes[i] : r.hashes[0];
      if (h) store.setHash(c.key, h);
    });
    if (r.status !== "success") fail(store, "The batch failed on Base, so nothing in it went through. Try again.", "failed");
    store.setState("sent");
    return;
  }

  store.setMode("sequential");
  for (const c of calls) {
    let hash = store.hashes()[c.key];
    if (!hash) {
      try {
        hash = await port.send(c);
      } catch (e) {
        if (rejected(e)) fail(store, "You cancelled in your wallet. Continue when you're ready.", "needs-you");
        fail(store, noGas(e) ? NO_ETH : "Your wallet couldn't send this step. Try again.", "failed");
      }
      store.setHash(c.key, hash);
    }
    let r: { status: "success" | "reverted" };
    try {
      r = await port.wait(hash);
    } catch {
      fail(store, LOST, "needs-you");
    }
    if (r.status !== "success") fail(store, revertMessage(c.key), "failed");
  }
  store.setState("sent");
}
