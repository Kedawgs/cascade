import { type Abi, type Address, type Hex, maxUint256 } from "viem";
import { ERC20, FRONT_DOOR, ROUTER } from "./abi";
import { type Deployment, PATH_TAO_TO_USDC, TOKENS, UNISWAP } from "./config";
import type { OpState } from "./oplog";
import type { Balances, DepositQuote } from "./types";

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
  if (w.taoFrontDoorAllowance < q.targetTao) out.push(call("approveTao", TOKENS.tao, ERC20, "approve", [d.frontDoor, q.targetTao]));
  out.push(call("deposit", d.frontDoor, FRONT_DOOR, "deposit", [q.targetTao]));
  return out;
}

/** The redeem request fee is due once per open batch: a second request in it must send 0. */
export function unstakeCall(shares: bigint, redeemOf: bigint, redeemRequestFee: bigint, d: Deployment): FlowCall {
  return call("request", d.frontDoor, FRONT_DOOR, "requestRedeem", [shares], redeemOf === 0n ? redeemRequestFee : 0n);
}

export function claimCalls(claimable: bigint, minUsdc: bigint, w: Balances, d: Deployment, account: Address, keepTao: boolean): FlowCall[] {
  const out = [call("claim", d.frontDoor, FRONT_DOOR, "claim", [])];
  if (keepTao) return out;
  if (w.taoRouterAllowance < claimable) out.push(call("approveTao", TOKENS.tao, ERC20, "approve", [UNISWAP.router, maxUint256]));
  out.push(
    call("swap", UNISWAP.router, ROUTER, "exactInput", [
      { path: PATH_TAO_TO_USDC, recipient: account, amountIn: claimable, amountOutMinimum: minUsdc },
    ]),
  );
  return out;
}

export function cancelCall(kind: "deposit" | "withdrawal", amount: bigint, d: Deployment): FlowCall {
  return kind === "deposit"
    ? call("cancel", d.frontDoor, FRONT_DOOR, "cancelDeposit", [amount])
    : call("cancel", d.frontDoor, FRONT_DOOR, "cancelRedeem", [amount]);
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
  setCallsId(id: string): void;
}

export class FlowError extends Error {
  readonly state: OpState;

  constructor(message: string, state: OpState) {
    super(message);
    this.state = state;
  }
}

const rejected = (e: unknown): boolean => {
  const err = e as { name?: string; code?: number; message?: string; cause?: unknown };
  return (
    err?.name === "UserRejectedRequestError" ||
    err?.code === 4001 ||
    /user (rejected|denied)|rejected the request/i.test(err?.message ?? "") ||
    (err?.cause !== undefined && rejected(err.cause))
  );
};

function revertMessage(key: string): string {
  if (key === "swap") return "The price moved before the swap went through, so nothing was deposited. Try again.";
  return "A transaction failed on Base. Nothing after it was sent.";
}

function fail(store: FlowStore, message: string, state: OpState): never {
  store.setState(state, message);
  throw new FlowError(message, state);
}

/** Sends `calls`: as one batch when the wallet can, else one at a time. A call whose hash is already
 * recorded is not sent again (only waited for), so a stopped flow resumes where it stopped. */
export async function runFlow(port: WalletPort, store: FlowStore, calls: FlowCall[]): Promise<void> {
  store.setState("running");
  try {
    await port.switchToBase();
  } catch (e) {
    fail(store, rejected(e) ? "Switch your wallet to Base to continue." : "Your wallet could not switch to Base.", "needs-you");
  }

  const todo = calls.filter((c) => !store.hashes()[c.key]);
  if (todo.length === calls.length && todo.length > 1 && (await port.canBatch().catch(() => false))) {
    let id: string;
    try {
      ({ id } = await port.sendBatch(calls));
    } catch (e) {
      fail(store, rejected(e) ? "You cancelled in your wallet. Continue when you're ready." : "Your wallet could not send the batch.", rejected(e) ? "needs-you" : "failed");
    }
    store.setCallsId(id);
    const r = await port.waitBatch(id);
    // a smart account usually runs the whole batch in one transaction
    calls.forEach((c, i) => {
      const h = r.hashes.length === calls.length ? r.hashes[i] : r.hashes[0];
      if (h) store.setHash(c.key, h);
    });
    if (r.status !== "success") fail(store, "The batch failed on Base, so nothing was deposited. Try again.", "failed");
    store.setState("sent");
    return;
  }

  for (const c of calls) {
    let hash = store.hashes()[c.key];
    if (!hash) {
      try {
        hash = await port.send(c);
      } catch (e) {
        if (rejected(e)) fail(store, "You cancelled in your wallet. Continue when you're ready.", "needs-you");
        fail(store, `Your wallet could not send the transaction (${(e as Error).message.split("\n")[0]}).`, "failed");
      }
      store.setHash(c.key, hash);
    }
    const r = await port.wait(hash);
    if (r.status !== "success") fail(store, revertMessage(c.key), "failed");
  }
  store.setState("sent");
}
