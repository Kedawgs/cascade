import { getAddress, type Hex, maxUint256 } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { Deployment } from "./config";
import { PATH_TAO_TO_USDC, TOKENS, UNISWAP } from "./config";
import {
  claimCalls,
  createFlowGuard,
  createSharedFlowGuard,
  depositTaoCalls,
  type FlowCall,
  FlowBusyError,
  FlowError,
  retryPatch,
  runFlow,
  sellTaoCalls,
  stakeCalls,
  stillToSend,
  unstakeCall,
  userMessage,
  type WalletPort,
} from "./flows";
import type { Balances, DepositQuote } from "./types";

const D: Deployment = {
  frontDoor: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
  baseAdapter: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  vault: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
  bitAdapter: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  bitBlock: 1n,
  vaultSs58: "x",
  hotkeySs58: "y",
};
const ME = getAddress("0x000000000000000000000000000000000000a11c");
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

const quote = { usdcIn: 20_000_000n, targetTao: 78_000_000_000_000_000n } as DepositQuote;
const none: Balances = { usdc: 20_000_000n, tao: 0n, eth: 10n ** 15n, usdcRouterAllowance: 0n, taoRouterAllowance: 0n, taoFrontDoorAllowance: 0n, claimable: 0n };

describe("call builders", () => {
  it("stakes with approve USDC, exact-output swap, approve TAO, deposit", () => {
    const calls = stakeCalls(quote, none, D, ME);
    expect(calls.map((c) => c.key)).toEqual(["approveUsdc", "swap", "approveTao", "deposit"]);
    expect(calls[0]).toMatchObject({ to: TOKENS.usdc, functionName: "approve", args: [UNISWAP.router, maxUint256] });
    expect(calls[1]).toMatchObject({
      to: UNISWAP.router,
      functionName: "exactOutput",
      args: [{ path: PATH_TAO_TO_USDC, recipient: ME, amountOut: quote.targetTao, amountInMaximum: quote.usdcIn }],
    });
    expect(calls[2]).toMatchObject({ to: TOKENS.tao, functionName: "approve", args: [D.frontDoor, quote.targetTao] });
    expect(calls[3]).toMatchObject({ to: D.frontDoor, functionName: "deposit", args: [quote.targetTao] });
  });

  it("leaves out approvals that are already enough", () => {
    const calls = stakeCalls(quote, { ...none, usdcRouterAllowance: maxUint256, taoFrontDoorAllowance: quote.targetTao }, D, ME);
    expect(calls.map((c) => c.key)).toEqual(["swap", "deposit"]);
  });

  it("sends the redeem fee only with the first request in the open batch", () => {
    expect(unstakeCall(10n ** 22n, 0n, 10n ** 14n, D).value).toBe(10n ** 14n);
    expect(unstakeCall(10n ** 22n, 5n, 10n ** 14n, D).value).toBe(0n);
  });

  it("claims, then swaps back to USDC unless asked to keep TAO", () => {
    expect(claimCalls(10n ** 16n, 2_400_000n, none, D, ME, true).map((c) => c.key)).toEqual(["claim"]);
    const calls = claimCalls(10n ** 16n, 2_400_000n, none, D, ME, false);
    expect(calls.map((c) => c.key)).toEqual(["claim", "approveTao", "swap"]);
    expect(calls[2]).toMatchObject({
      functionName: "exactInput",
      args: [{ path: PATH_TAO_TO_USDC, recipient: ME, amountIn: 10n ** 16n, amountOutMinimum: 2_400_000n }],
    });
  });
});

function port(over: Partial<WalletPort> = {}) {
  let n = 0;
  return {
    switchToBase: vi.fn(async () => undefined),
    canBatch: vi.fn(async () => false),
    sendBatch: vi.fn(async () => ({ id: "batch-1" })),
    waitBatch: vi.fn(async () => ({ status: "success" as const, hashes: [H(90)] })),
    send: vi.fn<(c: FlowCall) => Promise<Hex>>(async () => H(++n)),
    wait: vi.fn(async () => ({ status: "success" as const })),
    ...over,
  };
}

function tracker(initial: Record<string, Hex> = {}, start: { mode?: "batch" | "sequential"; callsId?: string } = {}) {
  const hashes: Record<string, Hex | undefined> = { ...initial };
  const states: string[] = [];
  let callsId: string | undefined = start.callsId;
  let mode = start.mode;
  return {
    hashes,
    states,
    get callsId() {
      return callsId;
    },
    get mode() {
      return mode;
    },
    store: {
      hashes: () => hashes,
      setHash: (k: string, h: Hex) => void (hashes[k] = h),
      setState: (s: string) => void states.push(s),
      setCallsId: (id: string) => void (callsId = id),
      callsId: () => callsId,
      mode: () => mode,
      setMode: (m: "batch" | "sequential") => void (mode = m),
    },
  };
}

const calls = stakeCalls(quote, none, D, ME);

describe("runFlow", () => {
  it("sends each call in turn, recording each hash before waiting", async () => {
    const p = port();
    const t = tracker();
    await runFlow(p, t.store as never, calls);
    expect(p.send).toHaveBeenCalledTimes(4);
    expect(Object.keys(t.hashes)).toEqual(["approveUsdc", "swap", "approveTao", "deposit"]);
    expect(t.states.at(-1)).toBe("sent");
    expect(p.switchToBase).toHaveBeenCalled();
  });

  it("resumes without repeating a confirmed call", async () => {
    const p = port();
    const t = tracker({ approveUsdc: H(50), swap: H(51) });
    await runFlow(p, t.store as never, calls);
    expect(vi.mocked(p.send).mock.calls.map((c) => c[0].key)).toEqual(["approveTao", "deposit"]);
  });

  it("stops when the user rejects, keeping what was sent, and asks them to continue", async () => {
    const reject = Object.assign(new Error("User rejected the request."), { name: "UserRejectedRequestError" });
    let i = 0;
    const p = port({ send: vi.fn(async () => (++i === 2 ? Promise.reject(reject) : H(i))) });
    const t = tracker();
    await expect(runFlow(p, t.store as never, calls)).rejects.toThrow(/cancelled in your wallet/i);
    expect(t.hashes.approveUsdc).toBe(H(1));
    expect(t.hashes.swap).toBeUndefined();
    expect(t.states.at(-1)).toBe("needs-you");
  });

  it("explains a swap that reverts because the price moved", async () => {
    // the approval already went through; the swap (the next call sent, H(1)) reverts
    const p = port({ wait: vi.fn(async (h: Hex) => ({ status: h === H(1) ? ("reverted" as const) : ("success" as const) })) });
    const t = tracker({ approveUsdc: H(50) });
    await expect(runFlow(p, t.store as never, calls)).rejects.toThrow(/price moved.*nothing was deposited/i);
    expect(t.states.at(-1)).toBe("failed");
  });

  it("sends everything as one batch when the wallet can", async () => {
    const p = port({ canBatch: vi.fn(async () => true) });
    const t = tracker();
    await runFlow(p, t.store as never, calls);
    expect(p.sendBatch).toHaveBeenCalledOnce();
    expect(p.send).not.toHaveBeenCalled();
    expect(t.callsId).toBe("batch-1");
    expect(t.hashes.deposit).toBe(H(90));
    expect(t.states.at(-1)).toBe("sent");
  });
});

describe("flow control", () => {
  it("refuses a second flow while one is running, before anything is read or sent", async () => {
    const guard = createFlowGuard(() => undefined);
    let release: () => void = () => undefined;
    const first = guard.run("stake", () => new Promise<void>((r) => (release = r)));
    const second = vi.fn(async () => undefined);
    await expect(guard.run("stake", second)).rejects.toBeInstanceOf(FlowBusyError);
    expect(second).not.toHaveBeenCalled();
    release();
    await first;
    await expect(guard.run("stake", async () => "again")).resolves.toBe("again");
  });

  it("a receipt it cannot read marks the step as waiting for the user, keeping the hash", async () => {
    const p = port({ wait: vi.fn(async () => Promise.reject(new Error("request limit reached"))) });
    const t = tracker();
    await expect(runFlow(p, t.store as never, calls)).rejects.toThrow(/continue to check/i);
    expect(t.states.at(-1)).toBe("needs-you");
    expect(t.hashes.approveUsdc).toBeDefined();
  });

  it("resuming after a lost receipt waits on the same hash and sends nothing twice", async () => {
    const p = port();
    const t = tracker({ approveUsdc: H(50) });
    await runFlow(p, t.store as never, calls);
    expect(p.wait).toHaveBeenCalledWith(H(50));
    expect(vi.mocked(p.send).mock.calls.map((c) => c[0].key)).toEqual(["swap", "approveTao", "deposit"]);
  });

  it("a wallet that turns down the batch (no smart account) falls back to one step at a time", async () => {
    const declined = Object.assign(new Error("the user rejected the upgrade"), { code: 5750 });
    const p = port({ canBatch: vi.fn(async () => true), sendBatch: vi.fn(async () => Promise.reject(declined)) });
    const t = tracker();
    await expect(runFlow(p, t.store as never, calls)).rejects.toThrow(/one at a time/i);
    expect(t.mode).toBe("sequential");
    expect(t.states.at(-1)).toBe("needs-you");
    const again = port({ canBatch: vi.fn(async () => true) });
    await runFlow(again, t.store as never, calls);
    expect(again.sendBatch).not.toHaveBeenCalled();
    expect(again.send).toHaveBeenCalledTimes(4);
  });

  it("a batch whose status could not be read is checked again, not sent again", async () => {
    const p = port({ canBatch: vi.fn(async () => true), waitBatch: vi.fn(async () => Promise.reject(new Error("timeout"))) });
    const t = tracker();
    await expect(runFlow(p, t.store as never, calls)).rejects.toThrow(/continue to check/i);
    expect(t.callsId).toBe("batch-1");
    const again = port({ canBatch: vi.fn(async () => true) });
    await runFlow(again, t.store as never, calls);
    expect(again.sendBatch).not.toHaveBeenCalled();
    expect(again.waitBatch).toHaveBeenCalledWith("batch-1");
    expect(t.states.at(-1)).toBe("sent");
  });

  it("does not resend a swap or deposit the chain shows already happened", () => {
    const op = { hashes: {}, targetTao: quote.targetTao };
    expect(stillToSend(calls, op, { walletTao: 0n, depositOf: quote.targetTao })).toEqual([]);
    expect(stillToSend(calls, op, { walletTao: quote.targetTao, depositOf: 0n }).map((c) => c.key)).toEqual(["approveTao", "deposit"]);
    expect(stillToSend(calls, op, { walletTao: 0n, depositOf: 0n })).toHaveLength(4);
  });
});

describe("TAO already in the wallet", () => {
  it("deposits it with an exact approval, in whole rao", () => {
    const c = depositTaoCalls(12_345_678_912_345_678n, none, D);
    expect(c.map((x) => x.key)).toEqual(["approveTao", "deposit"]);
    expect(c[1].args).toEqual([12_345_678_000_000_000n]);
    expect(c[0].args).toEqual([D.frontDoor, 12_345_678_000_000_000n]);
  });

  it("swaps it back to USDC with a minimum", () => {
    const c = sellTaoCalls(10n ** 16n, 2_400_000n, none, ME);
    expect(c.map((x) => x.key)).toEqual(["approveTao", "swap"]);
    expect(c[1]).toMatchObject({ functionName: "exactInput", args: [{ amountIn: 10n ** 16n, amountOutMinimum: 2_400_000n, recipient: ME }] });
  });
});

describe("userMessage", () => {
  it("passes our own flow messages through", () => {
    expect(userMessage(new FlowError("You cancelled in your wallet.", "needs-you"))).toBe("You cancelled in your wallet.");
    expect(userMessage(new FlowBusyError())).toMatch(/already busy/);
  });

  it("turns a wallet refusal into plain words", () => {
    const reject = Object.assign(new Error("User rejected the request."), { name: "UserRejectedRequestError" });
    expect(userMessage(reject)).toBe("You declined in your wallet. Nothing was sent.");
  });

  it("explains missing ETH for network fees instead of viem's gas arithmetic", () => {
    const e = new Error("The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.");
    expect(userMessage(e)).toMatch(/paid in ETH/);
    expect(userMessage(new Error("insufficient funds for gas * price + value"))).toMatch(/paid in ETH/);
  });

  it("never shows raw RPC errors (they can carry URLs)", () => {
    const e = new Error("HTTP request failed. URL: https://lb.example/abc?dkey=SECRET Status: 429");
    expect(userMessage(e)).toBe("We couldn't reach Base just now. Nothing was sent. Try again.");
  });
});

describe("a sequential send the wallet can't make", () => {
  it("says so in plain words, never quoting the raw error", async () => {
    const broke = new Error("The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account. URL: https://x");
    const p = port({ send: vi.fn(async () => Promise.reject(broke)) });
    const t = tracker();
    await expect(runFlow(p, t.store as never, calls)).rejects.toThrow(/paid in ETH/);
    expect(t.states.at(-1)).toBe("failed");
  });
});

describe("retryPatch", () => {
  it("forgets a failed deposit attempt but keeps the swap that worked, so a retry sends the deposit again", () => {
    const op = { state: "failed" as const, hashes: { approveUsdc: H(1), swap: H(2), approveTao: H(3), deposit: H(4) }, callsId: "0xabc", mode: "batch" as const };
    expect(retryPatch(op)).toEqual({ hashes: { approveUsdc: H(1), swap: H(2) }, callsId: undefined, mode: "sequential", state: "running", error: undefined });
  });

  it("leaves anything that isn't a failure alone", () => {
    expect(retryPatch({ state: "needs-you" as const, hashes: { swap: H(2) } })).toEqual({});
  });
});

describe("createSharedFlowGuard", () => {
  it("allows one money-moving flow across the whole app and tells every screen which one runs", async () => {
    const guard = createSharedFlowGuard();
    const stakeForm: (string | null)[] = [];
    const claimBox: (string | null)[] = [];
    guard.subscribe((l) => stakeForm.push(l));
    const stop = guard.subscribe((l) => claimBox.push(l));
    let release!: () => void;
    const staking = guard.run("stake", () => new Promise<void>((r) => (release = r)));
    await expect(guard.run("claim", async () => undefined)).rejects.toBeInstanceOf(FlowBusyError);
    expect(guard.active).toBe("stake");
    release();
    await staking;
    expect(stakeForm).toEqual(["stake", null]);
    expect(claimBox).toEqual(["stake", null]);
    stop();
    await guard.run("claim", async () => undefined);
    expect(claimBox).toEqual(["stake", null]);
    expect(stakeForm).toEqual(["stake", null, "claim", null]);
  });
});

