import {
  concat,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeFunctionData,
  getAddress,
  type Hex,
  HttpRequestError,
  maxUint256,
  recoverTypedDataAddress,
  serializeSignature,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import type { Deployment } from "./config";
import { STAKER } from "./abi";
import { PATH_TAO_TO_USDC, TOKENS, UNISWAP } from "./config";
import {
  assertWired,
  cancelCall,
  needsWiring,
  claimCalls,
  claimRetryPatch,
  createFlowGuard,
  createSharedFlowGuard,
  depositTaoCalls,
  type FlowCall,
  isRevert,
  permitTypedData,
  planResumeStakeV3,
  planStakeV3,
  resumeStakeV3Calls,
  revertReason,
  type Simulation,
  splitSignature,
  stakeDeadline,
  stakeV3Calls,
  FlowBusyError,
  FlowError,
  retryPatch,
  runFlow,
  sellTaoCalls,
  stakeCalls,
  stillToSend,
  unstakeCall,
  unstakeV3Call,
  userMessage,
  walletTaoDepositOp,
  type WalletPort,
  WIRING_MISMATCH,
  WIRING_UNCHECKED,
  wiringNotice,
} from "./flows";
import type { Balances, DepositQuote, WithdrawalQuote } from "./types";

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
const none: Balances = {
  usdc: 20_000_000n,
  tao: 0n,
  eth: 10n ** 15n,
  usdcRouterAllowance: 0n,
  usdcStakerAllowance: 0n,
  taoRouterAllowance: 0n,
  taoFrontDoorAllowance: 0n,
  claimable: 0n,
};

describe("call builders", () => {
  it("stakes with approve USDC, exact-output swap, approve TAO, deposit", () => {
    const calls = stakeCalls(quote, none, D, ME);
    expect(calls.map((c) => c.key)).toEqual(["approveUsdc", "swap", "approveTao", "deposit"]);
    // exactly the most the swap may spend, never an open approval
    expect(calls[0]).toMatchObject({ to: TOKENS.usdc, functionName: "approve", args: [UNISWAP.router, quote.usdcIn] });
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

  it("v3 unstake sets the USDC delivery preference in the same call, fee only on the first request", () => {
    const q = { minUsdcPerTao: 123_456n, deliveryDeadline: 1_800_000_000 } as WithdrawalQuote;
    const first = unstakeV3Call(10n ** 22n, 0n, 10n ** 14n, q, D);
    expect(first).toMatchObject({
      to: D.frontDoor,
      functionName: "requestRedeemWithDelivery",
      args: [10n ** 22n, 123_456n, 1_800_000_000n, 6],
      value: 10n ** 14n,
    });
    expect(unstakeV3Call(10n ** 22n, 5n, 10n ** 14n, q, D).value).toBe(0n);
  });

  it("approves only ever exactly what the next call spends, from that call's own arguments, and never an open amount", () => {
    /** What a call takes from the account under the approval before it. */
    const spends = (c: FlowCall): bigint => {
      if (c.functionName === "exactOutput") return (c.args[0] as { amountInMaximum: bigint }).amountInMaximum;
      if (c.functionName === "exactInput") return (c.args[0] as { amountIn: bigint }).amountIn;
      if (c.functionName === "deposit") return c.args[0] as bigint;
      if (c.functionName === "stake") return c.args[1] as bigint;
      throw new Error(`${c.functionName} spends nothing under an approval`);
    };
    const flows: [string, FlowCall[]][] = [
      ["v2 stake", stakeCalls(quote, none, D, ME)],
      ["v2 stake, odd amount", stakeCalls({ usdcIn: 20_000_001n, targetTao: 78_000_000_123_456_789n }, none, D, ME)],
      ["v3 stake by approval", stakeV3Calls({ usdcIn: 20_000_000n, minTaoOut: 1n }, none, { ...D, staker: D.baseAdapter, oracle: D.vault }, ME, undefined, 1n)],
      ["wallet TAO deposit", depositTaoCalls(12_345_678_912_345_678n, none, D)],
      ["wallet TAO sale", sellTaoCalls(10n ** 16n, 2_400_000n, none, ME)],
      ["claim as USDC", claimCalls(10n ** 16n, 2_400_000n, none, D, ME, false)],
    ];
    for (const [name, calls] of flows) {
      const approvals = calls.flatMap((c, i) => (c.functionName === "approve" ? [i] : []));
      expect(approvals.length, name).toBeGreaterThan(0);
      for (const i of approvals) {
        const [spender, amount] = calls[i].args as [string, bigint];
        const next = calls[i + 1];
        expect(amount, name).not.toBe(maxUint256);
        expect(next?.to, name).toBe(spender);
        expect(amount, name).toBe(spends(next));
      }
    }
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
    hasCode: vi.fn(async () => false),
    signPermit: vi.fn<WalletPort["signPermit"]>(async () => ({ v: 28, r: H(201), s: H(202) })),
    simulate: vi.fn<(c: FlowCall) => Promise<Simulation>>(async () => ({ ok: true })),
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

describe("a step the wallet puts another transaction in place of", () => {
  it("follows one sped up: the replacement's hash is recorded, and its receipt decides", async () => {
    const p = port({
      wait: vi.fn(async (h: Hex, onReplaced?: (r: { hash: Hex; reason: "repriced" | "cancelled" | "replaced" }) => void) => {
        if (h === H(1)) onReplaced?.({ hash: H(77), reason: "repriced" });
        return { status: "success" as const };
      }),
    });
    const t = tracker();
    await runFlow(p, t.store as never, calls);
    expect(t.hashes.approveUsdc).toBe(H(77));
    expect(p.send).toHaveBeenCalledTimes(4);
    expect(t.states.at(-1)).toBe("sent");
  });

  it("stops at one cancelled or replaced by a different transaction: that step never happened, and nothing after it is sent", async () => {
    for (const reason of ["cancelled", "replaced"] as const) {
      const p = port({
        wait: vi.fn(async (_h: Hex, onReplaced?: (r: { hash: Hex; reason: "repriced" | "cancelled" | "replaced" }) => void) => {
          onReplaced?.({ hash: H(78), reason });
          return { status: "success" as const };
        }),
      });
      const t = tracker();
      await expect(runFlow(p, t.store as never, calls)).rejects.toThrow(/replaced in your wallet/);
      expect(p.send, reason).toHaveBeenCalledTimes(1);
      expect(t.hashes.approveUsdc, reason).toBe(H(1));
      expect(t.states.at(-1), reason).toBe("failed");
    }
  });
});

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
    expect(p.wait).toHaveBeenCalledWith(H(50), expect.any(Function));
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

  it("records the deposit at what selling TAO pays at the click", async () => {
    const op = await walletTaoDepositOp({ id: "w1", account: ME, taoWei: 12_345_678_912_345_678n, now: 1_000, price: async () => 254.49 });
    expect(op).toEqual({
      id: "w1",
      kind: "deposit",
      account: ME,
      createdAt: 1_000,
      usdcIn: 0n,
      targetTao: 12_345_678_000_000_000n,
      priceUsd: 254.49,
      hashes: {},
      state: "running",
    });
  });

  it("records it with no price, rather than holding it up or saying $0, when the price can't be read", async () => {
    const at = (price: () => Promise<number>) => walletTaoDepositOp({ id: "w1", account: ME, taoWei: 10n ** 16n, now: 1_000, price });
    const failed = await at(() => Promise.reject(new Error("Base RPC down")));
    expect(failed).not.toHaveProperty("priceUsd");
    expect(failed).toMatchObject({ kind: "deposit", usdcIn: 0n, targetTao: 10n ** 16n, state: "running" });
    expect(
      await at(() => {
        throw new Error("sync");
      }),
    ).not.toHaveProperty("priceUsd");
    expect(await at(async () => 0)).not.toHaveProperty("priceUsd");
  });

  it("doesn't keep the wallet waiting on a slow price read: past the wait, it goes unpriced", async () => {
    const op = await walletTaoDepositOp({ id: "w1", account: ME, taoWei: 10n ** 16n, now: 1_000, price: () => new Promise<number>(() => {}), priceWaitMs: 20 });
    expect(op).not.toHaveProperty("priceUsd");
    expect(op).toMatchObject({ kind: "deposit", targetTao: 10n ** 16n, state: "running" });
  });

  it("swaps it back to USDC with a minimum", () => {
    const c = sellTaoCalls(10n ** 16n, 2_400_000n, none, ME);
    expect(c.map((x) => x.key)).toEqual(["approveTao", "swap"]);
    expect(c[1]).toMatchObject({ functionName: "exactInput", args: [{ amountIn: 10n ** 16n, amountOutMinimum: 2_400_000n, recipient: ME }] });
  });

  it("lets Uniswap's router spend exactly the TAO it sells, and asks only when the allowance falls short", () => {
    const c = sellTaoCalls(10n ** 16n, 2_400_000n, { ...none, taoRouterAllowance: 10n ** 15n }, ME);
    expect(c[0]).toMatchObject({ key: "approveTao", to: TOKENS.tao, functionName: "approve", args: [UNISWAP.router, 10n ** 16n] });
    expect(sellTaoCalls(10n ** 16n, 2_400_000n, { ...none, taoRouterAllowance: 10n ** 16n }, ME).map((x) => x.key)).toEqual(["swap"]);
  });
});

describe("the wiring gate before any flow", () => {
  it("lets a flow go on only once the contracts check out", async () => {
    await expect(assertWired(async () => "ok")).resolves.toBeUndefined();
  });

  it("stops it, with one plain message, when they don't match", async () => {
    const err = await assertWired(async () => "mismatch").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).message).toBe(WIRING_MISMATCH);
    expect((err as FlowError).state).toBe("failed");
    expect(userMessage(err)).toBe(WIRING_MISMATCH);
  });

  it("stops it too when they can't be checked right now: never fails open", async () => {
    const err = await assertWired(async () => Promise.reject(new Error("archive node down"))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).message).toBe(WIRING_UNCHECKED);
    expect((err as FlowError).state).toBe("needs-you");
  });

  it("says before anyone clicks only that the contracts don't match: a check that couldn't be read says so only on a click", () => {
    expect(wiringNotice({ data: "mismatch", isError: false })).toBe(WIRING_MISMATCH);
    // a failed re-check after a mismatch still says mismatch
    expect(wiringNotice({ data: "mismatch", isError: true })).toBe(WIRING_MISMATCH);
    // can't check right now: nothing appears on its own (it would move the page); a click checks again,
    // and assertWired says why nothing was sent, in response to it
    expect(wiringNotice({ data: undefined, isError: true })).toBeNull();
    expect(wiringNotice({ data: "ok", isError: true })).toBeNull();
    expect(wiringNotice({ data: "ok", isError: false })).toBeNull();
    // still checking: nothing to say yet (a click waits for the check)
    expect(wiringNotice({ data: undefined, isError: false })).toBeNull();
  });

  it("words both plainly, in the site's voice", () => {
    expect(WIRING_MISMATCH).toBe(
      "This site doesn't match Cascade's contracts, so staking and unstaking are off. You can still claim, cancel, or swap your TAO to USDC.",
    );
    expect(WIRING_UNCHECKED).toBe("We can't check Cascade's contracts right now, so nothing was sent. Try again in a moment.");
  });

  it("holds only what puts money in or asks for it back: a stake (new, continued, or wallet TAO) and an unstake", () => {
    expect(needsWiring("stake")).toBe(true);
    expect(needsWiring("unstake")).toBe(true);
    // the ways out stay open: they only return the account's own funds
    for (const label of ["claim", "cancel", "swap"]) expect(needsWiring(label), label).toBe(false);
  });

  it("leaves open only ways out that touch the listed front door and the fixed router, send no ETH, and approve only the router", () => {
    const fixed = new Set([D.frontDoor, TOKENS.tao, UNISWAP.router].map((a) => a.toLowerCase()));
    const exits: [string, FlowCall[]][] = [
      ["cancel a deposit", [cancelCall("deposit", 10n ** 16n, D)]],
      ["cancel an unstake", [cancelCall("withdrawal", 10n ** 21n, D)]],
      ["claim as USDC", claimCalls(10n ** 16n, 2_400_000n, none, D, ME, false)],
      ["claim as TAO", claimCalls(10n ** 16n, 0n, none, D, ME, true)],
      ["swap wallet TAO to USDC", sellTaoCalls(10n ** 16n, 2_400_000n, none, ME)],
    ];
    for (const [name, calls] of exits) {
      for (const c of calls) {
        expect(fixed.has(c.to.toLowerCase()), `${name}: ${c.functionName} to ${c.to}`).toBe(true);
        expect(c.value ?? 0n, `${name}: ${c.functionName} value`).toBe(0n);
        if (c.functionName === "approve") expect((c.args[0] as string).toLowerCase(), name).toBe(UNISWAP.router.toLowerCase());
        if (c.functionName === "exactInput") expect((c.args[0] as { recipient: string }).recipient, name).toBe(ME);
      }
    }
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

describe("claimRetryPatch", () => {
  // a batching wallet sent [claim, approveTao, swap] as one batch, the swap reverted, and the batch failed whole
  const failedBatch = { hashes: { claim: H(90), approveTao: H(90), swap: H(90) }, callsId: "0xabc", mode: "batch" as const, state: "failed" as const };

  it("forgets a claim batch that failed whole, so carrying on sends the steps again one at a time", async () => {
    const patch = claimRetryPatch(failedBatch, false);
    expect(patch).toEqual({ hashes: {}, callsId: undefined, mode: "sequential", state: "running", error: undefined });
    // carried on: nothing waits on the old batch, and every step is sent anew
    const p = port({ canBatch: vi.fn(async () => true) });
    const t = tracker(patch.hashes as Record<string, Hex>, { mode: patch.mode, callsId: patch.callsId });
    await runFlow(p, t.store as never, claimCalls(10n ** 16n, 2_400_000n, none, D, ME, false));
    expect(p.waitBatch).not.toHaveBeenCalled();
    expect(vi.mocked(p.send).mock.calls.map((c) => c[0].key)).toEqual(["claim", "approveTao", "swap"]);
    expect(t.states.at(-1)).toBe("sent");
  });

  it("never forgets a claim Base can't find yet: it asks to try again, so a second claim is never sent", () => {
    const recorded = { hashes: { claim: H(1) }, mode: "sequential" as const, state: "failed" as const };
    expect(() => claimRetryPatch(recorded, undefined)).toThrow(FlowError);
    try {
      claimRetryPatch(recorded, undefined);
    } catch (e) {
      expect((e as FlowError).state).toBe("needs-you");
      expect((e as FlowError).message).toMatch(/try again/i);
    }
    // with no claim sent there is nothing to find
    expect(claimRetryPatch({ hashes: {} }, undefined)).toMatchObject({ hashes: {}, mode: "sequential" });
  });

  it("keeps a claim that went through, so only what follows it is sent again", () => {
    const sequential = { hashes: { claim: H(1), approveTao: H(2), swap: H(3) }, mode: "sequential" as const, state: "failed" as const };
    expect(claimRetryPatch(sequential, true)).toEqual({ hashes: { claim: H(1) }, callsId: undefined, mode: "sequential", state: "running", error: undefined });
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


// ---- v3: one-signature stake through CascadeStaker ----

const STAKER_AT = getAddress("0x00000000000000000000000000000000005a4e12");
const D3: Deployment = { ...D, staker: STAKER_AT, oracle: getAddress("0x000000000000000000000000000000000000041e") };
const q3 = { usdcIn: 20_000_000n, minTaoOut: 77_611_000_000_000_000n } as DepositQuote;
const NOW = 1_800_000_000_000; // ms
const DEADLINE = 1_800_001_800n; // NOW + 30 minutes, in seconds
const declined = () => Object.assign(new Error("User rejected the request."), { name: "UserRejectedRequestError", code: 4001 });

describe("v3 stake calls", () => {
  it("pays by permit in one stakeWithPermit call, for the connected account, at the quote's floor on route 0", () => {
    const permit = { deadline: DEADLINE, v: 27, r: H(1), s: H(2) };
    const c = stakeV3Calls(q3, none, D3, ME, permit);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({
      key: "stake",
      to: STAKER_AT,
      functionName: "stakeWithPermit",
      args: [ME, q3.usdcIn, q3.minTaoOut, 0, DEADLINE, DEADLINE, 27, H(1), H(2)],
    });
    expect(c[0].value).toBeUndefined();
    // the arguments encode against the staker's real signature
    expect(encodeFunctionData({ abi: STAKER, functionName: "stakeWithPermit", args: c[0].args as never }).slice(0, 10)).toBe("0x85d45b3a");
  });

  it("without a permit approves exactly usdcIn to the staker, then stakes", () => {
    const c = stakeV3Calls(q3, { ...none, usdcRouterAllowance: maxUint256 }, D3, ME, undefined, DEADLINE);
    expect(c.map((x) => x.key)).toEqual(["approveUsdc", "stake"]);
    expect(c[0]).toMatchObject({ to: TOKENS.usdc, functionName: "approve", args: [STAKER_AT, q3.usdcIn] });
    expect(c[1]).toMatchObject({ to: STAKER_AT, functionName: "stake", args: [ME, q3.usdcIn, q3.minTaoOut, 0, DEADLINE] });
  });

  it("drops the approval when the staker's allowance already covers the stake", () => {
    expect(stakeV3Calls(q3, { ...none, usdcStakerAllowance: q3.usdcIn }, D3, ME, undefined, DEADLINE).map((x) => x.key)).toEqual(["stake"]);
    expect(stakeV3Calls(q3, { ...none, usdcStakerAllowance: q3.usdcIn - 1n }, D3, ME, undefined, DEADLINE).map((x) => x.key)).toEqual([
      "approveUsdc",
      "stake",
    ]);
  });

  it("refuses to build a v3 stake for a deployment without a staker", () => {
    expect(() => stakeV3Calls(q3, none, D, ME)).toThrow(/staker/i);
  });

  it("gives the stake 30 minutes", () => {
    expect(stakeDeadline(NOW)).toBe(DEADLINE);
  });
});

describe("the USDC permit", () => {
  it("is EIP-2612 in USDC's Base domain, for exactly usdcIn to the staker", () => {
    const t = permitTypedData(ME, D3, q3.usdcIn, 7n, DEADLINE);
    expect(t.domain).toEqual({ name: "USD Coin", version: "2", chainId: 8453, verifyingContract: TOKENS.usdc });
    expect(t.primaryType).toBe("Permit");
    expect(t.types.Permit.map((f) => `${f.type} ${f.name}`)).toEqual(["address owner", "address spender", "uint256 value", "uint256 nonce", "uint256 deadline"]);
    expect(t.message).toEqual({ owner: ME, spender: STAKER_AT, value: q3.usdcIn, nonce: 7n, deadline: DEADLINE });
  });

  it("is never made for a deployment without a staker", () => {
    expect(() => permitTypedData(ME, D, q3.usdcIn, 7n, DEADLINE)).toThrow(/staker/i);
  });

  it("splits a wallet's signature into the v, r, s USDC checks, whichever way the wallet writes v", async () => {
    const key = privateKeyToAccount(`0x${"42".repeat(32)}`);
    const t = permitTypedData(key.address, D3, q3.usdcIn, 7n, DEADLINE);
    const sig = await key.signTypedData(t);
    const split = splitSignature(sig);
    expect([27, 28]).toContain(split.v);
    const back = serializeSignature({ r: split.r, s: split.s, v: BigInt(split.v) });
    expect(await recoverTypedDataAddress({ ...t, signature: back })).toBe(key.address);
    // some wallets (hardware ones) end the signature with 0/1 instead of 27/28
    const lowV = `${sig.slice(0, 130)}0${split.v - 27}` as Hex;
    expect(splitSignature(lowV)).toEqual(split);
  });

  it("refuses a signature that isn't a plain 65-byte one (a smart wallet's wrapped signature)", () => {
    expect(() => splitSignature(`0x${"11".repeat(64)}`)).toThrow();
    expect(() => splitSignature(`0x${"11".repeat(200)}`)).toThrow();
  });

  it("tells a revert from Base being unreachable", () => {
    const revert = new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({ abi: STAKER, functionName: "stake", message: "execution reverted: Too little received" }),
      { abi: STAKER, functionName: "stake", args: [] },
    );
    expect(isRevert(revert)).toBe(true);
    expect(isRevert(new HttpRequestError({ url: "https://mainnet.base.org", status: 429 }))).toBe(false);
  });
});

describe("planStakeV3", () => {
  const plan = (p: ReturnType<typeof port>, w: Balances = none, nonce = 7n) =>
    planStakeV3(p, { q: q3, w, d: D3, account: ME, nonce: async () => nonce, now: NOW });

  it("an account without code signs one permit, on Base, for exactly usdcIn to the staker, then sends one stakeWithPermit", async () => {
    const p = port();
    const calls = await plan(p);
    expect(p.hasCode).toHaveBeenCalledWith(ME);
    expect(p.signPermit).toHaveBeenCalledOnce();
    const typed = vi.mocked(p.signPermit).mock.calls[0][0];
    expect(typed.domain.chainId).toBe(8453);
    expect(typed.message).toEqual({ owner: ME, spender: STAKER_AT, value: q3.usdcIn, nonce: 7n, deadline: DEADLINE });
    expect(vi.mocked(p.switchToBase).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(p.signPermit).mock.invocationCallOrder[0]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ functionName: "stakeWithPermit", args: [ME, q3.usdcIn, q3.minTaoOut, 0, DEADLINE, DEADLINE, 28, H(201), H(202)] });
    expect(p.simulate).toHaveBeenCalledWith(calls[0]);
  });

  it("a declined signature stops at 'needs you' with nothing sent and no second prompt", async () => {
    const p = port({ signPermit: vi.fn(async () => Promise.reject(declined())) });
    const err = await plan(p).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).state).toBe("needs-you");
    expect((err as FlowError).message).toMatch(/declined/i);
    expect(p.signPermit).toHaveBeenCalledOnce();
    expect(p.simulate).not.toHaveBeenCalled();
    expect(p.send).not.toHaveBeenCalled();
    expect(p.sendBatch).not.toHaveBeenCalled();
  });

  it("an account with code (an EIP-7702 smart account) approves exactly usdcIn and stakes, with no signature", async () => {
    const p = port({ hasCode: vi.fn(async () => true) });
    const calls = await plan(p);
    expect(p.signPermit).not.toHaveBeenCalled();
    expect(calls.map((c) => c.key)).toEqual(["approveUsdc", "stake"]);
    expect(calls[0].args).toEqual([STAKER_AT, q3.usdcIn]);
    expect(calls[1]).toMatchObject({ functionName: "stake", args: [ME, q3.usdcIn, q3.minTaoOut, 0, DEADLINE] });
  });

  it("the approve path goes as one batch when the wallet can", async () => {
    const p = port({ hasCode: vi.fn(async () => true), canBatch: vi.fn(async () => true) });
    const t = tracker();
    await runFlow(p, t.store as never, await plan(p));
    expect(p.sendBatch).toHaveBeenCalledOnce();
    expect(vi.mocked(p.sendBatch).mock.calls[0][0].map((c: FlowCall) => c.functionName)).toEqual(["approve", "stake"]);
    expect(p.send).not.toHaveBeenCalled();
  });

  it("USDC refusing the permit (the stake and the permit both fail to simulate) falls back to approve and stake", async () => {
    const p = port({ simulate: vi.fn(async () => ({ ok: false })) });
    const calls = await plan(p);
    expect(p.signPermit).toHaveBeenCalledOnce();
    expect(vi.mocked(p.simulate).mock.calls.map(([c]) => c.functionName)).toEqual(["stakeWithPermit", "permit"]);
    const permitCheck = vi.mocked(p.simulate).mock.calls[1][0];
    expect(permitCheck).toMatchObject({ to: TOKENS.usdc, args: [ME, STAKER_AT, q3.usdcIn, DEADLINE, 28, H(201), H(202)] });
    expect(calls.map((c) => c.key)).toEqual(["approveUsdc", "stake"]);
    expect(calls[0].args).toEqual([STAKER_AT, q3.usdcIn]);
  });

  it("a stake that would revert for its own reasons (the price moved) stops before anything is sent", async () => {
    const p = port({ simulate: vi.fn(async (c: FlowCall) => ({ ok: c.functionName === "permit" })) });
    const err = await plan(p).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).state).toBe("failed");
    expect((err as FlowError).message).toMatch(/price moved.*nothing was sent/i);
    expect(p.send).not.toHaveBeenCalled();
  });

  describe("says why a stake wouldn't go through, from the error the staker or the front door gives", () => {
    /** The stake reverts with `revert` in the pre-send check; USDC takes the permit. */
    const refusing = (revert: string) =>
      port({ simulate: vi.fn(async (c: FlowCall) => (c.functionName === "permit" ? { ok: true as const } : { ok: false as const, revert })) });
    const why = async (revert: string, minUsd?: () => Promise<number>) => {
      const p = refusing(revert);
      const err = await planStakeV3(p, { q: q3, w: none, d: D3, account: ME, nonce: async () => 7n, now: NOW, minUsd }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FlowError);
      expect((err as FlowError).state).toBe("failed");
      expect(p.send).not.toHaveBeenCalled();
      expect(p.sendBatch).not.toHaveBeenCalled();
      return (err as FlowError).message;
    };

    it("below the front door's minimum (BelowMinDeposit), or not even the flat fee (AmountTooSmall): the minimum in dollars", async () => {
      expect(await why("BelowMinDeposit", async () => 2.64)).toBe("That's below the minimum stake of about $2.64, so nothing was sent.");
      expect(await why("AmountTooSmall", async () => 3)).toBe("That's below the minimum stake of about $3, so nothing was sent.");
      // the minimum can't be read just now: said without a figure
      expect(await why("BelowMinDeposit", async () => Promise.reject(new Error("down")))).toBe("That's below the minimum stake, so nothing was sent.");
      expect(await why("BelowMinDeposit")).toBe("That's below the minimum stake, so nothing was sent.");
    });

    it("over the cap: Cascade is full for now", async () => {
      expect(await why("CapExceeded")).toBe("Cascade is full for now, so nothing was sent. Try a smaller amount, or try again later.");
    });

    it("the open batch full by value: a smaller amount may still fit, or the next batch opens soon", async () => {
      expect(await why("BatchValueFull")).toBe("The current batch filled up, so nothing was sent. Try a smaller amount, or try again soon.");
    });

    it("the open batch's list of stakes full: no amount fits, so it says only to wait for the next batch", async () => {
      const said = await why("BatchFull");
      expect(said).toBe("The current batch has as many stakes as it can take, so nothing was sent. A new one opens once it leaves, so try again soon.");
      expect(said).not.toMatch(/smaller amount/);
    });

    it("the front door paused (EnforcedPause) or the staker's route turned off: staking is paused", async () => {
      for (const revert of ["EnforcedPause", "RouteInactive"]) {
        expect(await why(revert)).toBe("Staking is paused right now, so nothing was sent. Try again later.");
      }
    });

    it("the swap would pay under the floor (the staker's InsufficientOutput, or the router's own check): the price moved", async () => {
      for (const revert of ["InsufficientOutput", "Too little received", "execution reverted: Too little received"]) {
        expect(await why(revert)).toBe("The price moved since your quote, so this stake wouldn't go through and nothing was sent. Stake again at today's price.");
      }
    });

    it("anything else keeps the general wording", async () => {
      expect(await why("Panic")).toMatch(/^This stake wouldn't go through on Base right now \(usually because the price moved/);
    });

    it("only reads the minimum when it is the reason", async () => {
      const minUsd = vi.fn(async () => 2.64);
      await why("CapExceeded", minUsd);
      expect(minUsd).not.toHaveBeenCalled();
    });
  });

  it("reads the error's name from Base's answer, the front door's errors included, or a revert string", () => {
    const reverted = (data: Hex) =>
      new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: STAKER, functionName: "stakeWithPermit", data }), {
        abi: STAKER,
        functionName: "stakeWithPermit",
        args: [],
      });
    for (const errorName of ["BelowMinDeposit", "CapExceeded", "BatchValueFull", "BatchFull", "EnforcedPause", "InsufficientOutput", "AmountTooSmall", "RouteInactive"] as const) {
      expect(revertReason(reverted(encodeErrorResult({ abi: STAKER, errorName })))).toBe(errorName);
    }
    const tooLittle = concat(["0x08c379a0", encodeAbiParameters([{ type: "string" }], ["Too little received"])]);
    expect(revertReason(reverted(tooLittle))).toBe("Too little received");
    expect(revertReason(new HttpRequestError({ url: "https://mainnet.base.org", status: 429 }))).toBeUndefined();
  });

  it("a wallet that can't sign a permit at all (not a refusal) uses approve and stake", async () => {
    const p = port({ signPermit: vi.fn(async () => Promise.reject(new Error("eth_signTypedData_v4 is not supported"))) });
    expect((await plan(p)).map((c) => c.key)).toEqual(["approveUsdc", "stake"]);
  });

  it("an allowance that already covers the stake needs no signature", async () => {
    const p = port();
    const calls = await plan(p, { ...none, usdcStakerAllowance: q3.usdcIn });
    expect(p.signPermit).not.toHaveBeenCalled();
    expect(calls.map((c) => c.functionName)).toEqual(["stake"]);
  });

  it("Base not answering the simulation stops and asks the user to continue, rather than guessing a path", async () => {
    const p = port({ simulate: vi.fn(async () => Promise.reject(new HttpRequestError({ url: "https://mainnet.base.org", status: 503 }))) });
    const err = await plan(p).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).state).toBe("needs-you");
    expect((err as FlowError).message).not.toMatch(/mainnet\.base\.org/);
  });

  it("a wallet that won't switch to Base is asked to, before any signature", async () => {
    const p = port({ switchToBase: vi.fn(async () => Promise.reject(declined())) });
    const err = await plan(p).catch((e: unknown) => e);
    expect((err as FlowError).state).toBe("needs-you");
    expect(p.signPermit).not.toHaveBeenCalled();
  });

  it("a stake that reverts on Base fails with 'stake again at today's price'", async () => {
    const p = port({ wait: vi.fn(async () => ({ status: "reverted" as const })) });
    const t = tracker();
    await expect(runFlow(p, t.store as never, await plan(p))).rejects.toThrow(/price moved.*today's price/i);
    expect(t.states.at(-1)).toBe("failed");
    expect(t.hashes.stake).toBeDefined();
  });
});

describe("resumeStakeV3Calls", () => {
  const op = { usdcIn: q3.usdcIn, minTaoOut: q3.minTaoOut, hashes: {} as Partial<Record<string, Hex>>, callsId: undefined as string | undefined };

  it("carries on by approval at the floor the user agreed to, with a fresh deadline, never asking for a signature again", () => {
    const calls = resumeStakeV3Calls(op, none, D3, ME, NOW);
    expect(calls.map((c) => c.functionName)).toEqual(["approve", "stake"]);
    expect(calls[0].args).toEqual([STAKER_AT, q3.usdcIn]);
    expect(calls[1].args).toEqual([ME, q3.usdcIn, q3.minTaoOut, 0, DEADLINE]);
  });

  it("only waits for a stake already sent, never approving again in front of it", () => {
    const calls = resumeStakeV3Calls({ ...op, hashes: { stake: H(5) } }, none, D3, ME, NOW);
    expect(calls.map((c) => c.key)).toEqual(["stake"]);
  });

  it("rebuilds a wallet batch still being checked exactly as it was sent, so its receipts line up", () => {
    const calls = resumeStakeV3Calls({ ...op, callsId: "batch-1" }, { ...none, usdcStakerAllowance: q3.usdcIn }, D3, ME, NOW);
    expect(calls.map((c) => c.key)).toEqual(["approveUsdc", "stake"]);
  });

  it("needs the floor recorded on the stake", () => {
    expect(() => resumeStakeV3Calls({ ...op, minTaoOut: undefined }, none, D3, ME, NOW)).toThrow(/no recorded minimum/);
  });
});

describe("carrying on a v3 stake the chain may already show", () => {
  const op = { usdcIn: q3.usdcIn, minTaoOut: q3.minTaoOut, hashes: {} as Partial<Record<string, Hex>>, callsId: undefined as string | undefined };
  const resume = (over: Partial<Parameters<typeof planResumeStakeV3>[0]>) =>
    planResumeStakeV3({ op, w: none, d: D3, account: ME, now: NOW, findStake: async () => null, adopt: vi.fn(), ...over });

  it("adopts a stake that already went through as this one's, and sends nothing", async () => {
    const t = tracker();
    const calls = await resume({ findStake: async () => H(61), adopt: (h) => t.store.setHash("stake", h) });
    expect(t.hashes.stake).toBe(H(61));
    expect(calls.map((c) => c.key)).toEqual(["stake"]);
    const p = port({ canBatch: vi.fn(async () => true) });
    await runFlow(p, t.store as never, calls);
    expect(p.send).not.toHaveBeenCalled();
    expect(p.sendBatch).not.toHaveBeenCalled();
    expect(p.wait).toHaveBeenCalledWith(H(61), expect.any(Function));
    expect(t.states.at(-1)).toBe("sent");
  });

  it("sends nothing when it can't check, and says so", async () => {
    const adopt = vi.fn();
    const err = await resume({ findStake: async () => Promise.reject(new Error("HTTP request failed. URL: https://base-rpc.publicnode.com")), adopt }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).state).toBe("needs-you");
    expect((err as FlowError).message).toBe("We couldn't check whether your stake already went through. Try again in a moment.");
    expect(adopt).not.toHaveBeenCalled();
  });

  it("carries on by approval, as before, when the chain shows no such stake", async () => {
    const adopt = vi.fn();
    const calls = await resume({ findStake: async () => null, adopt });
    expect(calls.map((c) => c.functionName)).toEqual(["approve", "stake"]);
    expect(calls[1].args).toEqual([ME, q3.usdcIn, q3.minTaoOut, 0, DEADLINE]);
    expect(adopt).not.toHaveBeenCalled();
  });

  it("doesn't search when the stake's hash or its wallet batch is recorded (those are only waited for)", async () => {
    const findStake = vi.fn(async () => H(61));
    expect((await resume({ op: { ...op, hashes: { stake: H(5) } }, findStake })).map((c) => c.key)).toEqual(["stake"]);
    expect((await resume({ op: { ...op, callsId: "batch-1" }, findStake })).map((c) => c.key)).toEqual(["approveUsdc", "stake"]);
    expect(findStake).not.toHaveBeenCalled();
  });
});
