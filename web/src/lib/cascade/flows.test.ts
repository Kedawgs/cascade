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
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import type { Deployment } from "./config";
import { FRONT_DOOR, STAKER } from "./abi";
import { PATH_TAO_TO_USDC, PRICE_CHECK_BPS, RESUME_WINDOW_MS, TOKENS, UNISWAP } from "./config";
import { STAKE_LAPSED } from "./trail";
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
  freshStakeTerms,
  planResumeStakeV3,
  planStakeV3,
  planSendNow,
  planUnstake,
  PRICE_DISAGREES,
  PRICE_UNCHECKED,
  pricesAgree,
  QuoteMovedError,
  quoteMoved,
  RESUME_UNQUOTED,
  spotUsdcPerTao,
  SEND_BLOCKED,
  SEND_COVERED,
  SEND_FEE_ROSE,
  SEND_FREE,
  SEND_GONE,
  SEND_FEE_UNCONFIRMED,
  SEND_NO_FEE,
  SEND_NOT_NOW,
  SEND_NOT_YET,
  SEND_NO_REFUND,
  SEND_NOT_YOURS,
  SEND_PAUSED,
  SEND_UNCHECKED,
  SEND_UNREAD,
  sendNowCall,
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
import type { Balances, DepositQuote, OpenBatch, WithdrawalQuote } from "./types";

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

  it("approves only ever exactly the most the next call may spend, from that call's own arguments, and never an unlimited amount", () => {
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

  it("records an unstake's fee and the account's pending nonce on Base, read last, just before the request is sent", async () => {
    const q = { shares: 10n ** 22n, minUsdcPerTao: 123_456n, deliveryDeadline: 1_800_000_000 } as WithdrawalQuote;
    const order: string[] = [];
    const recorded: unknown[] = [];
    const calls = await planUnstake({
      q,
      d: D,
      v3: true,
      frontDoor: async () => (order.push("frontDoor"), { redeemOf: 0n, redeemRequestFee: 10n ** 14n }),
      // a plain key account: no code
      accountCode: async () => (order.push("code"), undefined),
      pendingNonce: async () => (order.push("nonce"), 41),
      record: (patch) => void recorded.push(patch),
    });
    expect(calls).toEqual([unstakeV3Call(q.shares, 0n, 10n ** 14n, q, D)]);
    expect(order).toEqual(["frontDoor", "code", "nonce"]);
    expect(recorded).toEqual([{ fee: 10n ** 14n, nonce: 41 }]);
  });

  describe("the nonce an unstake's record keeps, by what is at the account", () => {
    const planWith = async (accountCode: () => Promise<Hex | undefined>) => {
      const recorded: unknown[] = [];
      const pendingNonce = vi.fn(async () => 41);
      await planUnstake({
        q: { shares: 10n ** 22n } as WithdrawalQuote,
        d: D,
        v3: false,
        frontDoor: async () => ({ redeemOf: 5n, redeemRequestFee: 10n ** 14n }),
        accountCode,
        pendingNonce,
        record: (patch) => void recorded.push(patch),
      });
      return { recorded, pendingNonce };
    };

    it("keeps it for a plain key account, and for an EIP-7702 account (its own key's nonce, delegated code)", async () => {
      expect((await planWith(async () => undefined)).recorded).toEqual([{ fee: 0n, nonce: 41 }]);
      expect((await planWith(async () => "0x")).recorded).toEqual([{ fee: 0n, nonce: 41 }]);
      expect((await planWith(async () => `0xef0100${"ab".repeat(20)}`)).recorded).toEqual([{ fee: 0n, nonce: 41 }]);
    });

    it("keeps none for a contract account, like a Base Account, whose nonce doesn't move with its own operations", async () => {
      const contract = await planWith(async () => "0x363d3d373d3d3d363d73bebebebebebebebebebebebebebebebebebebebe5af43d82803e903d91602b57fd5bf3");
      expect(contract.recorded).toEqual([{ fee: 0n }]);
      expect(contract.pendingNonce).not.toHaveBeenCalled();
      // code that only starts like a delegation isn't one
      expect((await planWith(async () => `0xef0100${"ab".repeat(21)}`)).recorded).toEqual([{ fee: 0n }]);
    });

    it("keeps none when the account's code can't be read", async () => {
      const unread = await planWith(async () => {
        throw new HttpRequestError({ url: "https://mainnet.base.org", status: 503 });
      });
      expect(unread.recorded).toEqual([{ fee: 0n }]);
    });
  });

  it("still sends an unstake when Base can't give the nonce, recording none", async () => {
    const recorded: unknown[] = [];
    const calls = await planUnstake({
      q: { shares: 10n ** 22n } as WithdrawalQuote,
      d: D,
      v3: false,
      frontDoor: async () => ({ redeemOf: 5n, redeemRequestFee: 10n ** 14n }),
      accountCode: async () => undefined,
      pendingNonce: async () => {
        throw new HttpRequestError({ url: "https://mainnet.base.org", status: 503 });
      },
      record: (patch) => void recorded.push(patch),
    });
    expect(calls).toEqual([unstakeCall(10n ** 22n, 5n, 10n ** 14n, D)]);
    expect(recorded).toEqual([{ fee: 0n }]);
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

  it("holds any other flow, including one added later: only the ways out are named to skip the check", () => {
    for (const label of ["bridge", "restake", "", "Claim", "swap "]) expect(needsWiring(label), JSON.stringify(label)).toBe(true);
  });

  it("leaves open exactly the ways out, by the labels the app's flows run under", () => {
    const src = readFileSync(new URL("./use-flows.ts", import.meta.url), "utf8");
    const labels = [...new Set([...src.matchAll(/\bflow\("([^"]+)"/g)].map((m) => m[1]))];
    expect(labels).toEqual(expect.arrayContaining(["stake", "unstake", "claim", "cancel", "swap", "send"]));
    // Send it now pays ETH into the front door: it waits for the contracts to check out
    expect(needsWiring("send")).toBe(true);
    expect(labels.filter((l) => !needsWiring(l)).sort()).toEqual(["cancel", "claim", "swap"]);
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

describe("Send it now", () => {
  /** The launch's cadence: batches wait up to 24 hours. */
  const DL: Deployment = { ...D, batchMaxWaitS: 86_400 };
  const START = 1_800_000_000;
  /** The open batch as read again at the click, two hours in: batch 7, which can close, which Bittensor
   * can take, and which the keeper is holding, with the account's deposit in it. */
  const open = (over: Partial<OpenBatch> = {}): OpenBatch => ({
    id: 7n,
    start: START,
    interval: 3_600,
    canClose: true,
    paused: false,
    chainTime: START + 7_200,
    mine: { depositWei: 10n ** 17n, redeemShares: 0n },
    potWei: 0n,
    feeWei: 744_898_037_875_672n,
    ethWei: 10n ** 16n,
    gasWei: 10n ** 13n,
    ethPriceUsd: 2_330,
    bittensor: "open",
    ...over,
  });
  const ok = () => vi.fn<(c: FlowCall) => Promise<Simulation>>(async () => ({ ok: true }));
  const plan = (batch: OpenBatch | (() => Promise<OpenBatch>), simulate = ok()) =>
    planSendNow({ d: DL, batchId: 7n, read: typeof batch === "function" ? batch : async () => batch, simulate });
  const refused = async (p: Promise<unknown>) => {
    const e = await p.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FlowError);
    return (e as FlowError).message;
  };

  it("sends closeBatch to the listed front door, with the fee to pay plus 30%, checked from the account first", async () => {
    const simulate = ok();
    const { call } = await plan(open(), simulate);
    expect(call).toEqual({ key: "close", to: D.frontDoor, abi: FRONT_DOOR, functionName: "closeBatch", args: [], value: 969_000_000_000_000n });
    expect(call).toEqual(sendNowCall(969_000_000_000_000n, D));
    expect(simulate).toHaveBeenCalledExactlyOnceWith(call);
  });

  it("takes the batch's pot off what is sent, and sends nothing extra once the pot covers the fee and the margin", async () => {
    expect((await plan(open({ feeWei: 10n ** 15n, potWei: 4n * 10n ** 14n }))).call.value).toBe(9n * 10n ** 14n);
    expect((await plan(open({ feeWei: 10n ** 15n, potWei: 2n * 10n ** 15n }))).call.value).toBe(0n);
  });

  it("reads the batch again right before sending, and sends nothing once its id has moved on: it's already on its way", async () => {
    const read = vi.fn(async () => open({ id: 8n }));
    const simulate = ok();
    expect(await refused(plan(read, simulate))).toBe(SEND_GONE);
    expect(SEND_GONE).toBe("It's already on its way, so nothing was sent.");
    expect(read).toHaveBeenCalledOnce();
    expect(simulate).not.toHaveBeenCalled();
  });

  it("never sends while Cascade is paused", async () => {
    const simulate = ok();
    expect(await refused(plan(open({ paused: true }), simulate))).toBe(SEND_PAUSED);
    expect(simulate).not.toHaveBeenCalled();
  });

  it("never pays for what the keeper sends for free: a full batch, or one past its max wait", async () => {
    const simulate = ok();
    expect(await refused(plan(open({ chainTime: START + 600 }), simulate))).toBe(SEND_FREE);
    expect(await refused(plan(open({ chainTime: START + 86_400 }), simulate))).toBe(SEND_FREE);
    expect(await refused(plan(open({ chainTime: START + 86_400 + 299 }), simulate))).toBe(SEND_FREE);
    expect(SEND_FREE).toBe("It leaves on its own any moment now, at no cost to you, so nothing was sent.");
    expect(simulate).not.toHaveBeenCalled();
  });

  it("sends it once the keeper is overdue: still open five minutes past its max wait", async () => {
    const { call } = await plan(open({ chainTime: START + 86_400 + 300 }));
    expect(call).toEqual(sendNowCall(969_000_000_000_000n, D));
  });

  it("sends nothing while its fees cover the bridge fee (the keeper sends it at its interval), nor before five minutes past it", async () => {
    const covered = { feesUsdc: 1_380_000n, bridgeFeeUsdc: 1_380_000n };
    expect(await refused(plan(open({ chainTime: START + 3_700, economics: covered })))).toBe(SEND_COVERED);
    expect(await refused(plan(open({ chainTime: START + 3_700 })))).toBe(SEND_NOT_YET);
    expect(await refused(plan(open({ canClose: false, chainTime: START + 600, bittensor: undefined })))).toBe(SEND_NOT_YET);
  });

  it("sends nothing when Bittensor's side can't take the batch, or couldn't be checked, and says which", async () => {
    const simulate = ok();
    expect(await refused(plan(open({ bittensor: "paused" }), simulate))).toBe(SEND_BLOCKED);
    expect(await refused(plan(open({ bittensor: "unchecked" }), simulate))).toBe(SEND_UNCHECKED);
    expect(await refused(plan(open({ bittensor: undefined }), simulate))).toBe(SEND_UNCHECKED);
    expect(SEND_BLOCKED).toBe("Bittensor's side isn't accepting batches right now, so nothing was sent.");
    expect(SEND_UNCHECKED).toBe("We couldn't check Bittensor's side just now, so nothing was sent. Try again in a minute.");
    expect(simulate).not.toHaveBeenCalled();
  });

  it("sends nothing when nothing of the account's is in the batch any more: it would pay for others' alone", async () => {
    expect(await refused(plan(open({ mine: { depositWei: 0n, redeemShares: 0n } })))).toBe(SEND_NOT_YOURS);
    // an unstake request waiting in it counts as the account's
    await expect(plan(open({ mine: { depositWei: 0n, redeemShares: 10n ** 21n } }))).resolves.toBeDefined();
  });

  it("sends nothing when the fee can't be read, nor when the batch can't be", async () => {
    expect(await refused(plan(open({ feeWei: undefined })))).toBe(SEND_NO_FEE);
    expect(await refused(plan(async () => Promise.reject(new Error("HTTP request failed. URL: https://mainnet.base.org"))))).toBe(SEND_UNREAD);
  });

  it("sends nothing when the two Base RPCs disagree about the fee (reads.ts leaves it out as unconfirmed), and says so", async () => {
    const simulate = ok();
    expect(await refused(plan(open({ feeWei: undefined, feeUnconfirmed: true }), simulate))).toBe(SEND_FEE_UNCONFIRMED);
    expect(SEND_FEE_UNCONFIRMED).toBe("The bridge fee couldn't be confirmed just now (our two sources for it disagree), so nothing was sent. Try again in a moment.");
    expect(simulate).not.toHaveBeenCalled();
  });

  it("sends nothing when the wallet can't cover the value and the network fee, and says how much it needs", async () => {
    const simulate = ok();
    // 0.000969 sent + 0.00001 for gas, at $2,330, to the cent above
    expect(await refused(plan(open({ ethWei: 5n * 10n ** 14n }), simulate))).toBe("You need about $2.29 of ETH on Base for this.");
    expect(simulate).not.toHaveBeenCalled();
  });

  it("says why when Base says it wouldn't go through", async () => {
    const reverting = (revert?: string) => vi.fn(async () => ({ ok: false, ...(revert ? { revert } : {}) }));
    expect(await refused(plan(open(), reverting("InsufficientFee")))).toBe(SEND_FEE_ROSE);
    expect(await refused(plan(open(), reverting("EnforcedPause")))).toBe(SEND_PAUSED);
    expect(await refused(plan(open(), reverting("BatchNotReady")))).toBe(SEND_NOT_NOW);
    expect(await refused(plan(open(), reverting()))).toBe(SEND_NOT_NOW);
    // the refund of what the fee doesn't take couldn't be paid to this account
    expect(await refused(plan(open(), reverting("TransferFailed")))).toBe(SEND_NO_REFUND);
    expect(SEND_NO_REFUND).toBe("Your wallet couldn't receive the refund of what the fee doesn't take, so nothing was sent.");
  });

  it("sends nothing when Base can't be asked, and names missing ETH when that's why", async () => {
    expect(await refused(plan(open(), vi.fn(async () => Promise.reject(new Error("HTTP request failed")))))).toMatch(/couldn't reach Base/);
    const broke = vi.fn(async () => Promise.reject(new Error("insufficient funds for gas * price + value")));
    expect(await refused(plan(open({ ethWei: undefined }), broke))).toBe("You need about $2.29 of ETH on Base for this.");
  });

  it("explains a send Base reverted: usually the batch had just left", async () => {
    const p = port({ wait: vi.fn(async () => ({ status: "reverted" as const })) });
    const t = tracker();
    await expect(runFlow(p, t.store as never, [sendNowCall(10n ** 15n, D)])).rejects.toThrow(
      "Sending the batch didn't go through, usually because it had just left. Only Base's network fee was spent.",
    );
  });

  it("asks no one to Continue a send: declined says nothing was sent, and one not confirmed yet is checked again later", async () => {
    const reject = Object.assign(new Error("User rejected the request."), { name: "UserRejectedRequestError" });
    await expect(runFlow(port({ send: vi.fn(async () => Promise.reject(reject)) }), tracker().store as never, [sendNowCall(10n ** 15n, D)])).rejects.toThrow(
      "You declined in your wallet, so nothing was sent.",
    );
    await expect(runFlow(port({ wait: vi.fn(async () => Promise.reject(new Error("timed out"))) }), tracker().store as never, [sendNowCall(10n ** 15n, D)])).rejects.toThrow(
      "We couldn't confirm it yet. Check its status in a few minutes.",
    );
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
/** $20 at about $255 a TAO after Cascade's $0.05 and 0.15%: 0.078 TAO expected, 0.0776 the floor. */
const q3 = {
  usdcIn: 20_000_000n,
  expectedTao: 78_000_000_000_000_000n,
  targetTao: 78_000_000_000_000_000n,
  minTaoOut: 77_611_000_000_000_000n,
  depositFeeUsdc: 50_000n,
  swapFeeUsdc: 29_925n,
  taoPriceUsd: 256.41,
  feesUsd: 0.15,
} as DepositQuote;
/** The oracle's 30-minute TWAP: $255 a TAO, within the 5% the quote is held to. */
const ORACLE = async () => 255_000_000n;
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

describe("the price check before any stake (the quote against the oracle)", () => {
  it("prices the quote as what the USDC after Cascade's fees pays per TAO: the swap's own price, pool fees and impact included", () => {
    // (20 - 0.05 - 0.029925) USDC for 0.078 TAO: $255.39 a TAO
    expect(spotUsdcPerTao(q3)).toBe(255_385_576n);
    expect(spotUsdcPerTao({ ...q3, expectedTao: 0n })).toBe(0n);
  });

  it("agrees within 5% of the oracle's price either way, and never with a price of nothing", () => {
    const oracle = 255_000_000n;
    expect(pricesAgree(255_385_576n, oracle)).toBe(true);
    expect(pricesAgree((oracle * 10_500n) / 10_000n, oracle)).toBe(true);
    expect(pricesAgree((oracle * 9_500n) / 10_000n, oracle)).toBe(true);
    expect(pricesAgree((oracle * 10_500n) / 10_000n + 1n, oracle)).toBe(false);
    expect(pricesAgree((oracle * 9_500n) / 10_000n - 1n, oracle)).toBe(false);
    expect(pricesAgree(0n, oracle)).toBe(false);
    expect(pricesAgree(oracle, 0n)).toBe(false);
    expect(PRICE_CHECK_BPS).toBe(500n);
  });

  it("stops a stake whose quote is off the oracle before the wallet is asked anything, and says why", async () => {
    const p = port();
    // the quote pays $255 a TAO; the oracle says $200: the RPC that quoted is lying, or the pool is being pushed
    const err = await planStakeV3(p, { q: q3, w: none, d: D3, account: ME, nonce: async () => 7n, now: NOW, oracle: async () => 200_000_000n }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).state).toBe("needs-you");
    expect((err as FlowError).message).toBe(PRICE_DISAGREES);
    expect(PRICE_DISAGREES).toBe("The price we were quoted doesn't match Cascade's price oracle, so nothing was sent. Try again in a few minutes.");
    expect(p.signPermit).not.toHaveBeenCalled();
    expect(p.hasCode).not.toHaveBeenCalled();
    expect(p.simulate).not.toHaveBeenCalled();
  });

  it("stops a stake when the oracle can't be read: never sent on one source's word", async () => {
    const p = port();
    const err = await planStakeV3(p, { q: q3, w: none, d: D3, account: ME, nonce: async () => 7n, now: NOW, oracle: async () => Promise.reject(new HttpRequestError({ url: "https://base-rpc.publicnode.com", status: 429 })) }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).state).toBe("needs-you");
    expect((err as FlowError).message).toBe(PRICE_UNCHECKED);
    expect((err as FlowError).message).not.toMatch(/publicnode/);
    expect(p.signPermit).not.toHaveBeenCalled();
  });

  it("asks the oracle once per stake, before anything else", async () => {
    const p = port();
    const oracle = vi.fn(ORACLE);
    await planStakeV3(p, { q: q3, w: none, d: D3, account: ME, nonce: async () => 7n, now: NOW, oracle });
    expect(oracle).toHaveBeenCalledOnce();
    expect(oracle.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(p.hasCode).mock.invocationCallOrder[0]);
  });
});

describe("planStakeV3", () => {
  const plan = (p: ReturnType<typeof port>, w: Balances = none, nonce = 7n) =>
    planStakeV3(p, { q: q3, w, d: D3, account: ME, nonce: async () => nonce, now: NOW, oracle: ORACLE });

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
      const err = await planStakeV3(p, { q: q3, w: none, d: D3, account: ME, nonce: async () => 7n, now: NOW, minUsd, oracle: ORACLE }).catch((e: unknown) => e);
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
  /** Today's quote, a touch under the one recorded. */
  const fresh = { minTaoOut: 77_200_000_000_000_000n };

  it("carries on by approval at the fresh quote's floor, with a fresh deadline, never asking for a signature again", () => {
    const calls = resumeStakeV3Calls(op, none, D3, ME, NOW, fresh);
    expect(calls.map((c) => c.functionName)).toEqual(["approve", "stake"]);
    expect(calls[0].args).toEqual([STAKER_AT, q3.usdcIn]);
    expect(calls[1].args).toEqual([ME, q3.usdcIn, fresh.minTaoOut, 0, DEADLINE]);
  });

  it("never builds a stake not yet sent from the record alone: the recorded floor is not one to send", () => {
    expect(() => resumeStakeV3Calls(op, none, D3, ME, NOW)).toThrow(/fresh quote/);
    expect(() => resumeStakeV3Calls({ ...op, minTaoOut: undefined }, none, D3, ME, NOW)).toThrow(/fresh quote/);
  });

  it("only waits for a stake already sent, never approving again in front of it, and needs no quote for that", () => {
    const calls = resumeStakeV3Calls({ ...op, hashes: { stake: H(5) } }, none, D3, ME, NOW);
    expect(calls.map((c) => c.key)).toEqual(["stake"]);
  });

  it("rebuilds a wallet batch still being checked exactly as it was sent, at the floor it was sent with, so its receipts line up", () => {
    const calls = resumeStakeV3Calls({ ...op, callsId: "batch-1" }, { ...none, usdcStakerAllowance: q3.usdcIn }, D3, ME, NOW);
    expect(calls.map((c) => c.key)).toEqual(["approveUsdc", "stake"]);
    expect(calls[1].args[2]).toBe(q3.minTaoOut);
  });
});

describe("a stopped stake's terms, quoted again (freshStakeTerms)", () => {
  const op = { usdcIn: q3.usdcIn, targetTao: q3.targetTao, createdAt: NOW - 60_000 };
  const terms = (over: Partial<Parameters<typeof freshStakeTerms>[0]> = {}, quote: Partial<DepositQuote> = {}) =>
    freshStakeTerms({ op, now: NOW, quote: async () => ({ ...q3, ...quote }), record: vi.fn(), ...over });

  it("tells a quote that moved from one that didn't by the 0.5% the user accepted, either way", () => {
    const was = 78_000_000_000_000_000n;
    expect(quoteMoved(was, was)).toBe(false);
    expect(quoteMoved((was * 10_050n) / 10_000n, was)).toBe(false);
    expect(quoteMoved((was * 9_950n) / 10_000n, was)).toBe(false);
    expect(quoteMoved((was * 10_050n) / 10_000n + 1n, was)).toBe(true);
    expect(quoteMoved((was * 9_950n) / 10_000n - 1n, was)).toBe(true);
    expect(quoteMoved(was, 0n)).toBe(true);
  });

  it("gives today's quote, recorded on the stake (its TAO, floor, price and fees), when it is close to the one the user saw", async () => {
    const record = vi.fn();
    const q = await terms({ record }, { targetTao: 77_800_000_000_000_000n, minTaoOut: 77_411_000_000_000_000n, taoPriceUsd: 257.07, feesUsd: 0.151 });
    expect(q.minTaoOut).toBe(77_411_000_000_000_000n);
    expect(record).toHaveBeenCalledExactlyOnceWith({ targetTao: 77_800_000_000_000_000n, minTaoOut: 77_411_000_000_000_000n, priceUsd: 257.07, feesUsd: 0.151 });
  });

  it("asks the user again when it moved materially, naming both figures, recording nothing", async () => {
    const record = vi.fn();
    const err = await terms({ record }, { targetTao: 70_000_000_000_000_000n, minTaoOut: 69_650_000_000_000_000n, taoPriceUsd: 285.71 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuoteMovedError);
    expect(err).toBeInstanceOf(FlowError);
    expect((err as QuoteMovedError).state).toBe("needs-you");
    expect((err as QuoteMovedError).move).toEqual({ nowTao: 70_000_000_000_000_000n, wasTao: 78_000_000_000_000_000n, priceUsd: 285.71 });
    expect((err as QuoteMovedError).message).toBe("The price moved since you started: you'd now get about 0.0700 TAO (was 0.0780 TAO). Continue at today's price if that's fine.");
    expect(record).not.toHaveBeenCalled();
    // more TAO is a move too: the figures the user saw no longer hold
    const up = await terms({}, { targetTao: 90_000_000_000_000_000n }).catch((e: unknown) => e);
    expect((up as QuoteMovedError).message).toMatch(/you'd now get about 0.0900 TAO \(was 0.0780 TAO\)/);
  });

  it("goes ahead once the user accepts the figure they were shown, and asks again only if it moved again from that one", async () => {
    const accepted = 70_000_000_000_000_000n;
    const q = await terms({ accepted }, { targetTao: 70_100_000_000_000_000n, minTaoOut: 69_749_500_000_000_000n });
    expect(q.targetTao).toBe(70_100_000_000_000_000n);
    const again = await terms({ accepted }, { targetTao: 65_000_000_000_000_000n }).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(QuoteMovedError);
    expect((again as QuoteMovedError).move.wasTao).toBe(accepted);
  });

  it("refuses a stake stopped a day ago or more: start again at today's price, and reads no quote for it", async () => {
    const quote = vi.fn(async () => q3);
    const record = vi.fn();
    const err = await freshStakeTerms({ op: { ...op, createdAt: NOW - RESUME_WINDOW_MS }, now: NOW, quote, record }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).state).toBe("failed");
    expect((err as FlowError).message).toBe(STAKE_LAPSED);
    expect(quote).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(RESUME_WINDOW_MS).toBe(24 * 60 * 60_000);
    // a minute short of a day: carried on
    await expect(freshStakeTerms({ op: { ...op, createdAt: NOW - RESUME_WINDOW_MS + 60_000 }, now: NOW, quote, record })).resolves.toBeDefined();
  });

  it("sends nothing when today's price can't be read, or the quote isn't one for this stake", async () => {
    const record = vi.fn();
    const down = await terms({ record, quote: async () => Promise.reject(new Error("HTTP request failed. URL: https://mainnet.base.org")) }).catch((e: unknown) => e);
    expect(down).toBeInstanceOf(FlowError);
    expect((down as FlowError).state).toBe("needs-you");
    expect((down as FlowError).message).toBe(RESUME_UNQUOTED);
    expect((down as FlowError).message).not.toMatch(/mainnet/);
    for (const quote of [{ targetTao: 0n }, { minTaoOut: 0n }, { usdcIn: q3.usdcIn + 1n }]) {
      expect(((await terms({ record }, quote).catch((e: unknown) => e)) as FlowError).message, JSON.stringify(quote, (_k, v) => String(v))).toBe(RESUME_UNQUOTED);
    }
    expect(record).not.toHaveBeenCalled();
  });

  it("runs the check it is given (the oracle's) on today's quote before recording anything", async () => {
    const record = vi.fn();
    const check = vi.fn(async () => Promise.reject(new FlowError(PRICE_DISAGREES, "needs-you")));
    await expect(terms({ record, check })).rejects.toThrow(PRICE_DISAGREES);
    expect(check).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ usdcIn: q3.usdcIn }));
    expect(record).not.toHaveBeenCalled();
  });
});

describe("carrying on a v3 stake (planResumeStakeV3)", () => {
  /** As recorded when it stopped: quoted at 0.078 TAO with a floor of 0.0776. */
  const op = { usdcIn: q3.usdcIn, targetTao: q3.targetTao, minTaoOut: q3.minTaoOut, hashes: {} as Partial<Record<string, Hex>>, callsId: undefined as string | undefined, createdAt: NOW - 60_000 };
  /** Today's quote: a touch less TAO, within the 0.5%. */
  const today = { ...q3, targetTao: 77_800_000_000_000_000n, minTaoOut: 77_411_000_000_000_000n, taoPriceUsd: 257.07 } as DepositQuote;
  const resume = (over: Partial<Parameters<typeof planResumeStakeV3>[0]> = {}) =>
    planResumeStakeV3({ op, w: none, d: D3, account: ME, now: NOW, findStake: async () => null, adopt: vi.fn(), quote: async () => today, oracle: ORACLE, record: vi.fn(), ...over });

  it("quotes again before carrying on, and sends today's floor, never the recorded one", async () => {
    const record = vi.fn();
    const calls = await resume({ record });
    expect(calls.map((c) => c.functionName)).toEqual(["approve", "stake"]);
    expect(calls[1].args).toEqual([ME, q3.usdcIn, today.minTaoOut, 0, DEADLINE]);
    expect(calls[1].args[2]).not.toBe(op.minTaoOut);
    expect(record).toHaveBeenCalledExactlyOnceWith({ targetTao: today.targetTao, minTaoOut: today.minTaoOut, priceUsd: 257.07, feesUsd: q3.feesUsd });
  });

  it("the pen test's case: a week-old floor quoted at $300 while TAO is at $250 is never sent; today's floor is, after the user agrees to today's figure", async () => {
    const usdcIn = 10_000_000n;
    const taoAt300 = (usdcIn * 10n ** 18n) / 300_000_000n;
    const stale = { ...op, usdcIn, targetTao: taoAt300, minTaoOut: (taoAt300 * 9_950n) / 10_000n };
    const taoAt250 = (usdcIn * 10n ** 18n) / 250_000_000n;
    const now = { ...q3, usdcIn, expectedTao: taoAt250, targetTao: taoAt250, minTaoOut: (taoAt250 * 9_950n) / 10_000n, depositFeeUsdc: 0n, swapFeeUsdc: 0n, taoPriceUsd: 250 } as DepositQuote;
    const oracle = async () => 250_000_000n;
    // a week old: not carried on at all
    const lapsed = await resume({ op: { ...stale, createdAt: NOW - 7 * 24 * 60 * 60_000 }, quote: async () => now, oracle }).catch((e: unknown) => e);
    expect((lapsed as FlowError).message).toBe(STAKE_LAPSED);
    // an hour old: the price moved 20%, so the user is asked, with nothing sent
    const moved = await resume({ op: { ...stale, createdAt: NOW - 60 * 60_000 }, quote: async () => now, oracle }).catch((e: unknown) => e);
    expect(moved).toBeInstanceOf(QuoteMovedError);
    expect((moved as QuoteMovedError).move).toEqual({ nowTao: taoAt250, wasTao: taoAt300, priceUsd: 250 });
    // the user agrees to today's figure: today's floor goes, 0.5% under today's market
    const calls = await resume({ op: { ...stale, createdAt: NOW - 60 * 60_000 }, quote: async () => now, oracle, accepted: taoAt250 });
    expect(calls[1].args[2]).toBe((taoAt250 * 9_950n) / 10_000n);
    expect(calls[1].args[2]).not.toBe(stale.minTaoOut);
  });

  it("checks today's quote against the oracle, and sends nothing when they disagree or it can't be read", async () => {
    const record = vi.fn();
    expect(((await resume({ record, oracle: async () => 200_000_000n }).catch((e: unknown) => e)) as FlowError).message).toBe(PRICE_DISAGREES);
    expect(((await resume({ record, oracle: async () => Promise.reject(new Error("down")) }).catch((e: unknown) => e)) as FlowError).message).toBe(PRICE_UNCHECKED);
    expect(record).not.toHaveBeenCalled();
  });

  it("adopts a stake that already went through as this one's, and sends nothing, without quoting", async () => {
    const t = tracker();
    const quote = vi.fn(async () => today);
    const calls = await resume({ findStake: async () => H(61), adopt: (h) => t.store.setHash("stake", h), quote });
    expect(t.hashes.stake).toBe(H(61));
    expect(calls.map((c) => c.key)).toEqual(["stake"]);
    expect(quote).not.toHaveBeenCalled();
    const p = port({ canBatch: vi.fn(async () => true) });
    await runFlow(p, t.store as never, calls);
    expect(p.send).not.toHaveBeenCalled();
    expect(p.sendBatch).not.toHaveBeenCalled();
    expect(p.wait).toHaveBeenCalledWith(H(61), expect.any(Function));
    expect(t.states.at(-1)).toBe("sent");
  });

  it("sends nothing when it can't check whether the stake went through, and says so", async () => {
    const adopt = vi.fn();
    const quote = vi.fn(async () => today);
    const err = await resume({ findStake: async () => Promise.reject(new Error("HTTP request failed. URL: https://base-rpc.publicnode.com")), adopt, quote }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).state).toBe("needs-you");
    expect((err as FlowError).message).toBe("We couldn't check whether your stake already went through. Try again in a moment.");
    expect(adopt).not.toHaveBeenCalled();
    expect(quote).not.toHaveBeenCalled();
  });

  it("neither searches nor quotes when the stake's hash or its wallet batch is recorded (those are only waited for)", async () => {
    const findStake = vi.fn(async () => H(61));
    const quote = vi.fn(async () => today);
    const oracle = vi.fn(ORACLE);
    expect((await resume({ op: { ...op, hashes: { stake: H(5) } }, findStake, quote, oracle })).map((c) => c.key)).toEqual(["stake"]);
    const batch = await resume({ op: { ...op, callsId: "batch-1" }, findStake, quote, oracle });
    expect(batch.map((c) => c.key)).toEqual(["approveUsdc", "stake"]);
    expect(batch[1].args[2]).toBe(op.minTaoOut);
    expect(findStake).not.toHaveBeenCalled();
    expect(quote).not.toHaveBeenCalled();
    expect(oracle).not.toHaveBeenCalled();
  });
});
