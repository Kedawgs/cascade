import { getAddress, type Hex, maxUint256 } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { Deployment } from "./config";
import { PATH_TAO_TO_USDC, TOKENS, UNISWAP } from "./config";
import { claimCalls, type FlowCall, runFlow, stakeCalls, unstakeCall, type WalletPort } from "./flows";
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
const none: Balances = { usdc: 20_000_000n, tao: 0n, eth: 10n ** 15n, usdcRouterAllowance: 0n, taoRouterAllowance: 0n, taoFrontDoorAllowance: 0n };

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
    send: vi.fn(async (_c: FlowCall) => H(++n)),
    wait: vi.fn(async () => ({ status: "success" as const })),
    ...over,
  };
}

function tracker(initial: Record<string, Hex> = {}) {
  const hashes: Record<string, Hex | undefined> = { ...initial };
  const states: string[] = [];
  let callsId: string | undefined;
  return {
    hashes,
    states,
    get callsId() {
      return callsId;
    },
    store: {
      hashes: () => hashes,
      setHash: (k: string, h: Hex) => void (hashes[k] = h),
      setState: (s: string) => void states.push(s),
      setCallsId: (id: string) => void (callsId = id),
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
